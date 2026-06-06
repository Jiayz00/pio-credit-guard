import express from "express";
import http from "node:http";
import morgan from "morgan";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { config } from "./config.js";
import {
  cleanupLogs,
  clearAutoHighRiskSamples,
  getAuthState,
  getAutoHighRiskState,
  getConfig,
  getWorkerState,
  initDb,
  listLogs,
  logEvent,
  updateAutoHighRiskState,
  updateConfig
} from "./db.js";
import { authContext, requireAdmin, requireProxySecret } from "./auth.js";
import { PioneerWorker } from "./worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

const ConfigSchema = z.object({
  enabled: z.coerce.number().int().min(0).max(1).optional(),
  mode: z.enum(["add", "restore"]).optional(),
  add_credits: z.coerce.number().positive().max(1_000_000).optional(),
  threshold: z.coerce.number().nonnegative().max(1_000_000).optional(),
  check_interval_seconds: z.coerce.number().int().min(30).max(86_400).optional(),
  high_risk_enabled: z.coerce.number().int().min(0).max(1).optional(),
  high_risk_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  high_risk_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  high_risk_interval_seconds: z.coerce.number().int().min(15).max(3_600).optional(),
  monitor_schedule_mode: z.enum(["all_day", "custom"]).optional(),
  monitor_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  monitor_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  auto_high_risk_enabled: z.coerce.number().int().min(0).max(1).optional(),
  auto_high_risk_apply_mode: z.enum(["suggest_only", "auto_apply"]).optional(),
  learning_interval_seconds: z.coerce.number().int().min(30).max(3_600).optional(),
  failure_pause_threshold: z.coerce.number().int().min(1).max(20).optional(),
  repair_confirmations: z.coerce.number().int().min(1).max(5).optional(),
  repair_cooldown_seconds: z.coerce.number().int().min(0).max(86_400).optional()
});

initDb();
cleanupLogs();
const worker = new PioneerWorker();
const streamTickets = new Map();

const app = express();
if (config.trustProxy) app.set("trust proxy", true);
app.use(morgan("combined"));
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/readyz", (_req, res) => {
  res.json({ ok: true, db: true, auth: getAuthState().status, worker: getWorkerState().status });
});

const router = express.Router();
router.use(requireProxySecret);

router.use("/api", requireAdmin);
router.get("/api/auth/context", authContext);
router.get("/api/config", (_req, res) => res.json(getConfig()));
router.put("/api/config", (req, res) => {
  const parsed = ConfigSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid config", details: parsed.error.flatten() });
  const saved = updateConfig(parsed.data);
  logEvent("info", "config_update", "Configuration updated", { config: saved });
  worker.reschedule();
  res.json(saved);
});

router.get("/api/status", (_req, res) => res.json(worker.snapshot()));
router.post("/api/auth/start", async (_req, res, next) => {
  try { res.json(await worker.startAuth()); } catch (error) { next(error); }
});
router.post("/api/auth/cancel", async (_req, res, next) => {
  try { res.json(await worker.cancelAuth()); } catch (error) { next(error); }
});
router.post("/api/auth/verify", async (_req, res, next) => {
  try { res.json(await worker.verifyAuth({ source: "manual" })); } catch (error) { next(error); }
});
router.post("/api/auth/browser/stream-ticket", (_req, res) => {
  const ticket = randomUUID();
  streamTickets.set(ticket, Date.now() + 60_000);
  res.json({ ticket, expires_in: 60, path: `${config.publicBasePath}/api/auth/browser/stream?ticket=${ticket}` });
});
router.get("/api/auth/browser/snapshot", async (_req, res, next) => {
  try { res.json(await worker.authBrowserSnapshot()); } catch (error) { next(error); }
});
router.post("/api/auth/browser/click", async (req, res, next) => {
  try {
    const parsed = z.object({ x: z.coerce.number().min(0), y: z.coerce.number().min(0) }).parse(req.body || {});
    res.json(await worker.authBrowserClick(parsed));
  } catch (error) { next(error); }
});
router.post("/api/auth/browser/type", async (req, res, next) => {
  try {
    const parsed = z.object({ text: z.string().min(1).max(2000) }).parse(req.body || {});
    res.json(await worker.authBrowserType(parsed));
  } catch (error) { next(error); }
});
router.post("/api/auth/browser/press", async (req, res, next) => {
  try {
    const parsed = z.object({ key: z.string().min(1).max(40) }).parse(req.body || {});
    res.json(await worker.authBrowserPress(parsed));
  } catch (error) { next(error); }
});
router.post("/api/auth/browser/reload", async (_req, res, next) => {
  try { res.json(await worker.authBrowserReload()); } catch (error) { next(error); }
});
router.post("/api/worker/start", async (_req, res, next) => {
  try { res.json(await worker.start()); } catch (error) { next(error); }
});
router.post("/api/worker/stop", async (_req, res, next) => {
  try { res.json(await worker.stop()); } catch (error) { next(error); }
});
router.post("/api/worker/check-now", async (_req, res, next) => {
  try { res.json(await worker.checkNow()); } catch (error) { next(error); }
});
router.post("/api/worker/repair-now", async (_req, res, next) => {
  try { res.json(await worker.repairNow()); } catch (error) { next(error); }
});
router.post("/api/auto-high-risk/apply", async (_req, res, next) => {
  try {
    const state = getAutoHighRiskState();
    if (!state?.detected_start || !state?.detected_end) {
      return res.status(400).json({ error: "No auto high-risk recommendation is available" });
    }
    const saved = updateConfig({
      monitor_schedule_mode: "custom",
      monitor_start: state.detected_start,
      monitor_end: state.detected_end
    });
    updateAutoHighRiskState({ applied: 1, last_applied_at: new Date().toISOString() });
    logEvent("info", "auto_high_risk_applied", "Auto high-risk recommendation applied", { state: getAutoHighRiskState(), config: saved });
    worker.reschedule();
    res.json(worker.snapshot());
  } catch (error) { next(error); }
});
router.post("/api/auto-high-risk/restart", async (_req, res, next) => {
  try {
    const now = new Date();
    const endsAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    clearAutoHighRiskSamples();
    updateAutoHighRiskState({
      learning_status: "learning",
      learning_started_at: now.toISOString(),
      learning_ends_at: endsAt.toISOString(),
      detected_start: null,
      detected_end: null,
      confidence: null,
      sample_count: 0,
      applied: 0,
      last_applied_at: null
    });
    updateConfig({ auto_high_risk_enabled: 1 });
    logEvent("info", "auto_high_risk_restart", "Auto high-risk learning restarted", { learning_ends_at: endsAt.toISOString() });
    worker.reschedule(0);
    res.json(worker.snapshot());
  } catch (error) { next(error); }
});
router.get("/api/logs", (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit || "100", 10) || 100, 500);
  const offset = Number.parseInt(req.query.offset || "0", 10) || 0;
  res.json({ items: listLogs({ limit, offset }) });
});

router.use(express.static(publicDir, { index: false, maxAge: 0 }));
router.get("/*", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.use(config.publicBasePath, router);
app.use((req, res, next) => {
  if (req.path === "/") return res.redirect(config.publicBasePath + "/");
  next();
});

app.use((error, _req, res, _next) => {
  console.error(error);
  logEvent("error", "http_error", error.message, { stack: error.stack });
  res.status(500).json({ error: error.message || "internal error" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

wss.on("connection", (ws) => {
  worker.attachAuthBrowserStream(ws).catch((error) => {
    try { ws.send(JSON.stringify({ type: "error", message: error.message })); } catch {}
    try { ws.close(1011, "stream error"); } catch {}
  });
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== `${config.publicBasePath}/api/auth/browser/stream`) {
      socket.destroy();
      return;
    }
    if (!isProxySecretValid(req)) {
      rejectUpgrade(socket, 404, "not found");
      return;
    }
    if (!consumeStreamTicket(url.searchParams.get("ticket") || "")) {
      rejectUpgrade(socket, 401, "unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch {
    socket.destroy();
  }
});

server.listen(config.port, config.host, () => {
  console.log(`pioneer-credit-guard listening on http://${config.host}:${config.port}${config.publicBasePath}`);
  restoreWorkerOnBoot();
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
async function shutdown() {
  try { wss.close(); } catch {}
  await worker.stop().catch(() => {});
  process.exit(0);
}

function restoreWorkerOnBoot() {
  const cfg = getConfig();
  const auth = getAuthState();
  if (Number(cfg.enabled) !== 1 || auth.status !== "authorized") return;
  worker.start().catch((error) => {
    console.error("Failed to restore worker on boot", error);
    logEvent("error", "worker_restore_failed", error.message, { stack: error.stack });
  });
}

function consumeStreamTicket(ticket) {
  const now = Date.now();
  for (const [key, expiresAt] of streamTickets) {
    if (expiresAt <= now) streamTickets.delete(key);
  }
  const expiresAt = streamTickets.get(ticket);
  streamTickets.delete(ticket);
  return Boolean(expiresAt && expiresAt > now);
}

function isProxySecretValid(req) {
  if (!config.authRequired) return true;
  return Boolean(config.internalProxySecret) && req.headers["x-internal-proxy-secret"] === config.internalProxySecret;
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: ${message.length}\r\n\r\n${message}`);
  socket.destroy();
}


