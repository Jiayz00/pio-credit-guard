import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { config, paths } from "./config.js";
import {
  clearAutoHighRiskSamples,
  getAutoHighRiskState,
  getAuthState,
  getConfig,
  getWorkerState,
  insertAutoHighRiskSample,
  listAutoHighRiskSamples,
  logEvent,
  updateAutoHighRiskState,
  updateAuthState,
  updateConfig,
  updateWorkerState
} from "./db.js";

const CREDITS_URL = "https://agent.pioneer.ai/credits";
const PIONEER_HOST = "agent.pioneer.ai";
const PIONEER_API_HOST = "api.pioneer.ai";

export class PioneerWorker {
  constructor() {
    this.context = null;
    this.page = null;
    this.cdp = null;
    this.timer = null;
    this.running = false;
    this.operation = Promise.resolve();
    this.authContext = null;
    this.authTimer = null;
    this.lastRepairAtMs = 0;
  }

  async start() {
    if (this.running) return this.snapshot();
    const auth = getAuthState();
    if (auth.status !== "authorized") {
      updateWorkerState({ status: "needs_auth", last_error: "Pioneer authorization is required" });
      return this.snapshot();
    }
    this.running = true;
    updateWorkerState({ status: "running", last_error: null });
    logEvent("info", "worker_start", "Worker started");
    this.schedule(0);
    return this.snapshot();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.closeWorkerBrowser();
    updateWorkerState({ status: "idle", last_error: null });
    logEvent("info", "worker_stop", "Worker stopped");
    return this.snapshot();
  }

  async startAuth() {
    return this.enqueue(async () => {
      if (this.authContext) {
        return this.snapshot();
      }
      await this.closeWorkerBrowser();
      updateAuthState({ status: "authenticating", last_error: null });
      updateWorkerState({ status: "authenticating" });
      logEvent("info", "auth_start", "Authorization browser started");

      this.authContext = await chromium.launchPersistentContext(paths.browserProfile, {
        headless: !config.headedAuth,
        viewport: { width: 1365, height: 900 },
        args: authBrowserArgs()
      });
      const page = this.authContext.pages()[0] || await this.authContext.newPage();
      await page.goto(CREDITS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});

      const finish = async (reason) => {
        const current = this.authContext;
        this.authContext = null;
        if (this.authTimer) clearTimeout(this.authTimer);
        this.authTimer = null;
        try { await current?.close(); } catch {}
        logEvent("info", "auth_window_closed", `Authorization window closed: ${reason}`);
        await this.verifyAuth({ source: `auth_${reason}` });
      };

      this.authContext.once("close", () => {
        if (this.authContext) {
          void finish("closed");
        }
      });

      this.authTimer = setTimeout(() => {
        if (this.authContext) {
          logEvent("warn", "auth_timeout", "Authorization timed out");
          void finish("timeout");
        }
      }, config.authTimeoutMs);

      void this.pollAuthSuccess(page, finish);
      return this.snapshot();
    });
  }

  async cancelAuth() {
    return this.enqueue(async () => {
      if (this.authTimer) clearTimeout(this.authTimer);
      this.authTimer = null;
      const context = this.authContext;
      this.authContext = null;
      try { await context?.close(); } catch {}
      updateAuthState({ status: "needs_auth", last_error: "Authorization cancelled" });
      updateWorkerState({ status: "idle", last_error: null });
      logEvent("info", "auth_cancel", "Authorization cancelled");
      return this.snapshot();
    });
  }

  async authBrowserSnapshot() {
    const page = this.currentAuthPage();
    if (!page) return { active: false, auth_in_progress: false };
    const viewport = page.viewportSize() || { width: 1365, height: 900 };
    const buffer = await page.screenshot({ type: "jpeg", quality: 72, fullPage: false, timeout: 10_000 });
    return {
      active: true,
      auth_in_progress: true,
      url: page.url(),
      title: await page.title().catch(() => ""),
      viewport,
      image: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      captured_at: new Date().toISOString()
    };
  }

  async authBrowserClick({ x, y }) {
    const page = this.requireAuthPage();
    await page.mouse.click(Number(x), Number(y));
    await sleep(300);
    return this.authBrowserSnapshot();
  }

  async authBrowserType({ text }) {
    const page = this.requireAuthPage();
    await page.keyboard.type(String(text), { delay: 20 });
    await sleep(200);
    return this.authBrowserSnapshot();
  }

  async authBrowserPress({ key }) {
    const page = this.requireAuthPage();
    await page.keyboard.press(String(key));
    await sleep(300);
    return this.authBrowserSnapshot();
  }

  async authBrowserReload() {
    const page = this.requireAuthPage();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    return this.authBrowserSnapshot();
  }

  async attachAuthBrowserStream(ws) {
    const page = this.currentAuthPage();
    if (!page) {
      sendWs(ws, { type: "inactive" });
      ws.close(1000, "auth browser inactive");
      return;
    }

    const cdp = await page.context().newCDPSession(page);
    let closed = false;
    const sendMeta = async () => {
      if (closed || ws.readyState !== 1) return;
      const viewport = page.viewportSize() || { width: 1365, height: 900 };
      sendWs(ws, {
        type: "meta",
        active: true,
        url: page.url(),
        title: await page.title().catch(() => ""),
        viewport
      });
    };
    const onFrame = async (frame) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      if (closed || ws.readyState !== 1) return;
      sendWs(ws, {
        type: "frame",
        data: frame.data,
        metadata: frame.metadata,
        captured_at: new Date().toISOString()
      });
    };
    const onMessage = (raw) => {
      void handleAuthStreamMessage(page, raw, sendMeta);
    };
    const stop = async () => {
      if (closed) return;
      closed = true;
      ws.off("message", onMessage);
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
    };

    cdp.on("Page.screencastFrame", onFrame);
    ws.on("message", onMessage);
    ws.once("close", () => void stop());
    ws.once("error", () => void stop());

    await cdp.send("Page.enable").catch(() => {});
    await sendMeta();
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 62,
      maxWidth: 1365,
      maxHeight: 900,
      everyNthFrame: 1
    });
  }

  currentAuthPage() {
    if (!this.authContext) return null;
    const pages = this.authContext.pages().filter((item) => !item.isClosed());
    return pages[pages.length - 1] || null;
  }

  currentWorkerPage() {
    return this.page && !this.page.isClosed() ? this.page : null;
  }

  requireAuthPage() {
    const page = this.currentAuthPage();
    if (!page) throw new Error("Authorization browser is not active");
    return page;
  }

  async verifyAuth({ source = "manual" } = {}) {
    return this.enqueue(async () => {
      updateWorkerState({ status: "checking" });
      let context;
      try {
        let page = this.currentAuthPage() || this.currentWorkerPage();
        if (!page) {
          context = await chromium.launchPersistentContext(paths.browserProfile, {
            headless: config.browserHeadless,
            viewport: { width: 1365, height: 900 },
            args: ["--disable-dev-shm-usage"]
          });
          page = context.pages()[0] || await context.newPage();
        }
        const result = await this.detectCurrentState(page, { verifyOnly: true });
        const isAuthed = ["ok", "missing", "mismatch"].includes(result.status);
        if (isAuthed) {
          updateAuthState({
            status: "authorized",
            authorized_at: new Date().toISOString(),
            last_verified_at: new Date().toISOString(),
            last_error: null
          });
          updateWorkerState({ status: this.running ? "running" : "authorized", last_error: null, last_result: JSON.stringify(result) });
          logEvent("info", "auth_verified", "Pioneer authorization verified", { source, result });
        } else if (result.status === "auth_required") {
          updateAuthState({
            status: "needs_auth",
            last_verified_at: new Date().toISOString(),
            last_error: result.reason || "Authorization required"
          });
          updateWorkerState({ status: "needs_auth", last_error: result.reason || "Authorization required", last_result: JSON.stringify(result) });
          logEvent("warn", "auth_required", "Pioneer authorization is required", { source, result });
        } else {
          const message = result.reason || `Authorization check was inconclusive: ${result.status}`;
          updateAuthState({ last_verified_at: new Date().toISOString(), last_error: message });
          updateWorkerState({ status: this.running ? "running" : "authorized", last_error: message, last_result: JSON.stringify(result) });
          logEvent("warn", "auth_verify_inconclusive", "Pioneer authorization check was inconclusive", { source, result });
        }
        return this.snapshot();
      } catch (error) {
        await this.recordFailure("auth_verify_error", error);
        updateAuthState({ status: "needs_auth", last_error: error.message, last_verified_at: new Date().toISOString() });
        updateWorkerState({ status: "needs_auth", last_error: error.message });
        return this.snapshot();
      } finally {
        try { await context?.close(); } catch {}
      }
    });
  }

  async checkNow() {
    return this.enqueue(async () => this.performCheck({ manual: true, repair: false }));
  }

  async repairNow() {
    return this.enqueue(async () => this.performCheck({ manual: true, repair: true, forceRepair: true }));
  }

  reschedule(delayMs = null) {
    if (!this.running) return;
    this.schedule(delayMs);
  }

  snapshot() {
    return {
      config: getConfig(),
      auth: getAuthState(),
      auto_high_risk: getAutoHighRiskState(),
      schedule: this.scheduleSnapshot(),
      worker: getWorkerState(),
      running: this.running,
      auth_in_progress: Boolean(this.authContext)
    };
  }

  scheduleSnapshot() {
    const cfg = normalizeConfig(getConfig());
    const learning = this.learningSnapshot(cfg);
    const monitor = learning.active ? { allowed: true, reason: "learning", nextStartAt: null } : monitorWindowState(cfg);
    return {
      in_monitor_window: monitor.allowed,
      reason: monitor.reason,
      next_wake_at: monitor.nextStartAt ? new Date(monitor.nextStartAt).toISOString() : null,
      learning_active: learning.active,
      current_interval_seconds: Math.round(this.currentIntervalMs(cfg) / 1000)
    };
  }

  schedule(delayMs = null) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const cfg = getConfig();
    const delay = delayMs ?? this.nextDelayMs(normalizeConfig(cfg));
    this.timer = setTimeout(() => {
      this.enqueue(async () => this.performCheck({ manual: false, repair: true }))
        .catch((error) => void this.recordFailure("scheduled_check_error", error))
        .finally(() => this.schedule());
    }, delay);
  }

  nextDelayMs(cfg) {
    const state = getAutoHighRiskState();
    if (cfg.auto_high_risk_enabled && state?.learning_status === "idle") return 0;
    if (cfg.auto_high_risk_enabled && state?.learning_status === "learning" && state.learning_ends_at && new Date(state.learning_ends_at).getTime() <= Date.now()) return 0;
    const learning = this.learningSnapshot(cfg);
    if (learning.active) return this.currentIntervalMs(cfg);
    const monitor = monitorWindowState(cfg);
    if (!monitor.allowed) return Math.max(1000, monitor.nextStartAt - Date.now());
    return this.currentIntervalMs(cfg);
  }

  currentIntervalMs(cfg) {
    const normal = Math.max(30, Number(cfg.check_interval_seconds || 180)) * 1000;
    const learning = this.learningSnapshot(normalizeConfig(cfg));
    if (learning.active) return Math.max(30, Number(cfg.learning_interval_seconds || 120)) * 1000;
    if (!cfg.high_risk_enabled) return normal;
    if (isNowInWindow(cfg.high_risk_start, cfg.high_risk_end)) {
      return Math.max(15, Number(cfg.high_risk_interval_seconds || 30)) * 1000;
    }
    return normal;
  }

  async performCheck({ manual, repair, forceRepair = false }) {
    const cfg = normalizeConfig(getConfig());
    if (!manual && !cfg.enabled) {
      updateWorkerState({ status: "paused" });
      return this.snapshot();
    }
    if (getAuthState().status !== "authorized") {
      updateWorkerState({ status: "needs_auth", last_error: "Pioneer authorization is required" });
      return this.snapshot();
    }
    const learning = this.ensureAutoHighRiskLearning(cfg);
    if (!manual && !learning.active) {
      const monitor = monitorWindowState(cfg);
      if (!monitor.allowed) {
        await this.closeWorkerBrowser();
        updateWorkerState({ status: "scheduled_sleep", last_error: null });
        logEvent("info", "schedule_sleep", "Outside monitoring window, worker is sleeping", {
          monitor_schedule_mode: cfg.monitor_schedule_mode,
          monitor_start: cfg.monitor_start,
          monitor_end: cfg.monitor_end,
          next_wake_at: new Date(monitor.nextStartAt).toISOString()
        });
        return this.snapshot();
      }
    }

    updateWorkerState({ status: learning.active && !manual ? "learning" : "checking", last_error: null });
    const page = await this.ensureWorkerPage();
    const first = await this.detectCurrentState(page, { expected: cfg });
    await this.handleCheckResult(first, cfg);
    this.recordAutoHighRiskSample(first, cfg, { manual, repaired: false });

    if (first.status === "auth_required") {
      updateAuthState({ status: "needs_auth", last_verified_at: new Date().toISOString(), last_error: first.reason || "Authorization required" });
      updateWorkerState({ status: "needs_auth", last_error: first.reason || "Authorization required" });
      this.finishAutoHighRiskLearningIfReady(cfg);
      return this.snapshot();
    }

    if (["unknown", "page_error", "stale_or_timeout"].includes(first.status)) {
      this.finishAutoHighRiskLearningIfReady(cfg);
      return this.snapshot();
    }

    const needsRepair = forceRepair || first.status === "missing" || first.status === "mismatch";
    if (!repair || !needsRepair) {
      updateWorkerState({ status: this.running ? "running" : "authorized" });
      this.finishAutoHighRiskLearningIfReady(cfg);
      return this.snapshot();
    }

    if (!forceRepair && Date.now() - this.lastRepairAtMs < cfg.repair_cooldown_seconds * 1000) {
      logEvent("info", "repair_cooldown", "Repair skipped because cooldown is active", { first });
      updateWorkerState({ status: this.running ? "running" : "authorized" });
      this.finishAutoHighRiskLearningIfReady(cfg);
      return this.snapshot();
    }

    const confirmations = Math.max(1, Number(cfg.repair_confirmations || 2));
    const confirmed = [first];
    for (let i = 1; i < confirmations; i += 1) {
      const result = await this.detectCurrentState(page, { expected: cfg });
      confirmed.push(result);
      if (!(result.status === "missing" || result.status === "mismatch")) {
        logEvent("warn", "repair_not_confirmed", "Repair skipped because refreshed confirmation did not match", { confirmed });
        updateWorkerState({ status: this.running ? "running" : "authorized", last_result: JSON.stringify(result) });
        this.finishAutoHighRiskLearningIfReady(cfg);
        return this.snapshot();
      }
    }

    updateWorkerState({ status: "repairing" });
    await this.applyRules(page, cfg);
    this.lastRepairAtMs = Date.now();
    const after = await this.detectCurrentState(page, { expected: cfg });
    await this.handleCheckResult(after, cfg, { afterRepair: true });
    this.recordAutoHighRiskSample(after, cfg, { manual, repaired: true });
    if (after.status !== "ok") {
      const message = `Repair did not converge, final status: ${after.status}`;
      await this.recordFailure("repair_failed", new Error(message), { after, confirmed });
      updateWorkerState({ status: "needs_attention", last_error: message, last_repair_at: new Date().toISOString() });
    } else {
      updateWorkerState({ status: this.running ? "running" : "authorized", last_error: null, last_repair_at: new Date().toISOString(), consecutive_failures: 0 });
      logEvent("info", "repair_success", "Credit rules repaired and verified", { after });
    }
    this.finishAutoHighRiskLearningIfReady(cfg);
    return this.snapshot();
  }

  ensureAutoHighRiskLearning(cfg) {
    const state = getAutoHighRiskState();
    if (!cfg.auto_high_risk_enabled) return { active: false, state };
    const now = Date.now();
    if (!state || state.learning_status === "idle") {
      const started = new Date(now);
      const ends = new Date(now + 48 * 60 * 60 * 1000);
      if (state?.learning_status !== "learning") {
        clearAutoHighRiskSamples();
        const next = updateAutoHighRiskState({
          learning_status: "learning",
          learning_started_at: started.toISOString(),
          learning_ends_at: ends.toISOString(),
          detected_start: null,
          detected_end: null,
          confidence: null,
          sample_count: 0,
          applied: 0,
          last_applied_at: null
        });
        logEvent("info", "auto_high_risk_learning_start", "Auto high-risk learning started", { learning_ends_at: next.learning_ends_at });
        return { active: true, state: next };
      }
    }
    const current = getAutoHighRiskState();
    if (current?.learning_status !== "learning") return { active: false, state: current };
    if (current.learning_ends_at && new Date(current.learning_ends_at).getTime() <= now) {
      this.finishAutoHighRiskLearningIfReady(cfg, { force: true });
      const updated = getAutoHighRiskState();
      return { active: updated?.learning_status === "learning", state: updated };
    }
    return { active: true, state: current };
  }

  learningSnapshot(cfg) {
    const state = getAutoHighRiskState();
    if (!cfg.auto_high_risk_enabled || state?.learning_status !== "learning") return { active: false, state };
    if (state.learning_ends_at && new Date(state.learning_ends_at).getTime() <= Date.now()) return { active: false, state };
    return { active: true, state };
  }

  recordAutoHighRiskSample(result, cfg, { manual, repaired }) {
    if (manual || !cfg.auto_high_risk_enabled) return;
    const state = getAutoHighRiskState();
    if (state?.learning_status !== "learning") return;
    insertAutoHighRiskSample({
      checked_at: result.finishedAt || new Date().toISOString(),
      status: result.status || "unknown",
      needs_repair: result.status === "missing" || result.status === "mismatch",
      repaired,
      result_summary: {
        status: result.status,
        source: result.source,
        reason: result.reason,
        current: result.current
      }
    });
  }

  finishAutoHighRiskLearningIfReady(cfg, { force = false } = {}) {
    if (!cfg.auto_high_risk_enabled) return;
    const state = getAutoHighRiskState();
    if (state?.learning_status !== "learning") return;
    if (!force && state.learning_ends_at && new Date(state.learning_ends_at).getTime() > Date.now()) return;

    const samples = listAutoHighRiskSamples({
      since: state.learning_started_at,
      until: state.learning_ends_at || new Date().toISOString(),
      riskOnly: true,
      limit: 1000
    });
    const recommendation = buildRiskRecommendation(samples);
    if (!recommendation) {
      updateAutoHighRiskState({
        learning_status: "insufficient_data",
        sample_count: samples.length,
        detected_start: null,
        detected_end: null,
        confidence: null,
        applied: 0
      });
      logEvent("warn", "auto_high_risk_insufficient_data", "Auto high-risk learning finished without enough samples", { sample_count: samples.length });
      return;
    }

    const applied = cfg.auto_high_risk_apply_mode === "auto_apply";
    updateAutoHighRiskState({
      learning_status: "completed",
      detected_start: recommendation.start,
      detected_end: recommendation.end,
      confidence: recommendation.confidence,
      sample_count: samples.length,
      applied: applied ? 1 : 0,
      last_applied_at: applied ? new Date().toISOString() : null
    });
    if (applied) {
      updateConfig({
        monitor_schedule_mode: "custom",
        monitor_start: recommendation.start,
        monitor_end: recommendation.end
      });
      logEvent("info", "auto_high_risk_applied", "Auto high-risk learning completed and applied", { recommendation });
    } else {
      logEvent("info", "auto_high_risk_completed", "Auto high-risk learning completed with recommendation", { recommendation });
    }
  }

  async handleCheckResult(result, cfg, extra = {}) {
    const level = result.status === "ok" ? "info" : result.status === "unknown" || result.status === "stale_or_timeout" ? "warn" : "warn";
    logEvent(level, "check_result", `Credit rules status: ${result.status}`, { result, ...extra });
    updateWorkerState({
      current_check_id: result.checkId,
      last_check_at: new Date().toISOString(),
      last_result: JSON.stringify(result),
      last_error: result.status === "ok" ? null : result.reason || null
    });

    if (["unknown", "page_error", "stale_or_timeout"].includes(result.status)) {
      const state = getWorkerState();
      const failures = Number(state.consecutive_failures || 0) + 1;
      const reachedThreshold = failures >= cfg.failure_pause_threshold;
      const nextStatus = reachedThreshold ? "needs_attention" : this.running ? "running" : "authorized";
      if (reachedThreshold) {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        logEvent("warn", "worker_paused", "Worker paused after repeated inconclusive checks", { failures, result });
      }
      updateWorkerState({ consecutive_failures: failures, status: nextStatus, last_error: result.reason || result.status });
    } else if (result.status === "ok") {
      updateWorkerState({ consecutive_failures: 0 });
    }
  }

  async ensureWorkerPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    await this.closeWorkerBrowser();
    this.context = await chromium.launchPersistentContext(paths.browserProfile, {
      headless: config.browserHeadless,
      viewport: { width: 1365, height: 900 },
      args: ["--disable-dev-shm-usage"]
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.cdp = await this.context.newCDPSession(this.page);
    await this.cdp.send("Network.enable");
    return this.page;
  }

  async closeWorkerBrowser() {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.cdp = null;
    try { await context?.close(); } catch {}
  }

  async pollAuthSuccess(_page, finish) {
    const deadline = Date.now() + config.authTimeoutMs;
    while (this.authContext && Date.now() < deadline) {
      await sleep(3000);
      if (!this.authContext) break;
      const pages = this.authContext.pages().filter((item) => !item.isClosed());
      for (const page of pages) {
        try {
          const state = await this.readDomState(page, normalizeConfig(getConfig()));
          if (page.url().startsWith(CREDITS_URL) && state.status !== "auth_required" && state.status !== "unknown") {
            await finish("success");
            return;
          }
        } catch {}
      }
    }
  }

  async detectCurrentState(page, { expected = normalizeConfig(getConfig()), verifyOnly = false } = {}) {
    const checkId = randomUUID();
    const startedAt = new Date().toISOString();
    const collector = await this.collectFreshNetwork(page, checkId);
    updateWorkerState({ current_check_id: checkId });

    try {
      await page.goto(CREDITS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(async () => {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      await sleep(800);
      const fresh = await collector.stop();
      const api = classifyFromResponses(fresh.responses, expected);
      const dom = await this.readDomState(page, expected);
      const selected = selectBestState(api, dom, verifyOnly);
      return {
        ...selected,
        checkId,
        startedAt,
        finishedAt: new Date().toISOString(),
        source: selected.source || (api.status !== "unknown" ? "api" : "dom"),
        freshness: {
          freshResponseCount: fresh.responses.length,
          usedCurrentCheckOnly: true,
          staleAccepted: false
        },
        api,
        dom
      };
    } catch (error) {
      const fresh = await collector.stop();
      await this.maybeScreenshot(page, checkId, "detect-error");
      return {
        status: fresh.responses.length > 0 ? "page_error" : "stale_or_timeout",
        reason: error.message,
        checkId,
        startedAt,
        finishedAt: new Date().toISOString(),
        source: "error",
        freshness: {
          freshResponseCount: fresh.responses.length,
          usedCurrentCheckOnly: true,
          staleAccepted: false
        }
      };
    }
  }

  async collectFreshNetwork(page, checkId) {
    const responses = [];
    const browserContext = page.context();
    const cdp = await browserContext.newCDPSession(page);
    await cdp.send("Network.enable").catch(() => {});

    const byRequestId = new Map();
    const pendingBodies = new Set();

    const trackBodyRead = (requestId) => {
      const item = byRequestId.get(requestId);
      if (!item || item.body !== null || item.body_error) return;
      const read = (async () => {
        try {
          const body = await cdp.send("Network.getResponseBody", { requestId });
          item.body = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
        } catch (error) {
          item.body_error = error.message;
        }
      })();
      pendingBodies.add(read);
      read.finally(() => pendingBodies.delete(read));
    };

    const onResponse = (event) => {
      const url = event.response?.url || "";
      if (!isPioneerUrl(url)) return;
      const mimeType = String(event.response?.mimeType || "").toLowerCase();
      if (!looksRelevantUrl(url) && !mimeType.includes("json")) return;
      if (mimeType.includes("text/html")) return;
      const item = {
        checkId,
        requestId: event.requestId,
        url,
        status: event.response?.status,
        mimeType: event.response?.mimeType,
        receivedAt: new Date().toISOString(),
        body: null,
        body_error: null
      };
      byRequestId.set(event.requestId, item);
      responses.push(item);
    };

    const onFinished = (event) => trackBodyRead(event.requestId);
    const onFailed = (event) => {
      const item = byRequestId.get(event.requestId);
      if (item) item.body_error = event.errorText || "loading failed";
    };

    cdp.on("Network.responseReceived", onResponse);
    cdp.on("Network.loadingFinished", onFinished);
    cdp.on("Network.loadingFailed", onFailed);

    let stopped = false;
    return {
      stop: async () => {
        if (stopped) return { responses };
        stopped = true;
        await sleep(500);
        for (const item of responses) trackBodyRead(item.requestId);
        await Promise.allSettled(Array.from(pendingBodies));
        cdp.off("Network.responseReceived", onResponse);
        cdp.off("Network.loadingFinished", onFinished);
        cdp.off("Network.loadingFailed", onFailed);
        await cdp.detach().catch(() => {});
        return { responses };
      }
    };
  }

  async readDomState(page, expected) {
    const dom = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const fields = [];
      for (const el of Array.from(document.querySelectorAll("input, textarea, select, [role='spinbutton'], [contenteditable='true']"))) {
        const rect = el.getBoundingClientRect();
        const label = el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("placeholder") || el.id || "";
        const value = "value" in el ? el.value : el.textContent;
        fields.push({ label, value, visible: rect.width > 0 && rect.height > 0 });
      }
      const buttons = Array.from(document.querySelectorAll("button, [role='button']")).map((el) => ({
        text: el.innerText || el.textContent || "",
        disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true"
      }));
      return { url: location.href, title: document.title, text, fields, buttons };
    });

    if (isLoginLike(dom)) return { status: "auth_required", source: "dom", reason: "Pioneer login page detected", domSummary: summarizeDom(dom) };
    if (!/credit|rule|charge|remaining|add|restore/i.test(dom.text)) {
      return { status: "unknown", source: "dom", reason: "Credit rules text was not found after refresh", domSummary: summarizeDom(dom) };
    }

    const current = extractRuleFromText(dom.text, dom.fields);
    if (!current.exists) return { status: "missing", source: "dom", reason: current.reason, current, domSummary: summarizeDom(dom) };
    if (!matchesExpected(current, expected)) return { status: "mismatch", source: "dom", reason: "Rule values do not match configured values", current, expected };
    return { status: "ok", source: "dom", current };
  }

  async applyRules(page, cfg) {
    logEvent("info", "repair_start", "Applying configured credit rules", { cfg });
    await page.goto(CREDITS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

    if (await this.applyRulesViaApi(page, cfg)) {
      await sleep(1000);
      return;
    }

    await clickByText(page, cfg.mode === "restore" ? [/restore/i] : [/add/i]);
    await fillNear(page, [/add\s*credits/i, /credits/i, /amount/i], String(cfg.add_credits));
    await fillNear(page, [/charge.*remaining.*below/i, /remaining.*below/i, /threshold/i], String(cfg.threshold));
    await clickByText(page, [/save/i, /apply/i, /update/i, /confirm/i, /保存/i, /应用/i, /确认/i]);
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await sleep(1000);
  }

  async applyRulesViaApi(page, cfg) {
    const result = await page.evaluate(async ({ addCredits, threshold }) => {
      const raw = localStorage.getItem("sb-db-auth-token");
      const session = raw ? JSON.parse(raw) : null;
      const token = session?.access_token;
      if (!token) return { ok: false, reason: "Pioneer API token was not found" };

      const headers = { accept: "application/json", authorization: `Bearer ${token}` };
      const teams = await fetch("https://api.pioneer.ai/teams", { headers }).then(async (response) => ({
        ok: response.ok,
        status: response.status,
        body: await response.json().catch(async () => ({ raw: await response.text() }))
      }));
      const teamId = teams.body?.teams?.[0]?.id;
      if (!teams.ok || !teamId) return { ok: false, reason: "Pioneer team id was not found", status: teams.status };

      const url = `https://api.pioneer.ai/billing/team/${teamId}/overage-settings`;
      const payload = {
        overage_enabled: true,
        topup_amount: Math.round(Number(addCredits) * 100),
        topup_mode: "by",
        charge_threshold: Math.round(Number(threshold) * 100),
        max_monthly_spend: null
      };
      const response = await fetch(url, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(async () => ({ raw: await response.text() }));
      return {
        ok: response.ok,
        status: response.status,
        current: {
          exists: Boolean(body?.overage_enabled),
          mode: "add",
          add_credits: Number(body?.topup_amount) / 100,
          threshold: Number(body?.charge_threshold) / 100
        }
      };
    }, { addCredits: cfg.add_credits, threshold: cfg.threshold });

    if (!result?.ok) {
      logEvent("warn", "repair_api_fallback", "Pioneer API repair was not available, falling back to page controls", { result });
      return false;
    }
    logEvent("info", "repair_api_success", "Credit rules repaired via Pioneer API", { current: result.current });
    return true;
  }

  async recordFailure(event, error, details = {}) {
    const state = getWorkerState();
    const failures = Number(state.consecutive_failures || 0) + 1;
    const reachedThreshold = failures >= Number(getConfig().failure_pause_threshold || 3);
    if (reachedThreshold) {
      this.running = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }
    updateWorkerState({
      consecutive_failures: failures,
      last_error: error.message,
      status: reachedThreshold ? "needs_attention" : "error"
    });
    logEvent("error", event, error.message, { ...details, stack: error.stack, paused: reachedThreshold });
    if (this.page && !this.page.isClosed()) {
      await this.maybeScreenshot(this.page, randomUUID(), event);
    }
  }

  async maybeScreenshot(page, checkId, label) {
    if (!config.screenshotOnFailure) return;
    try {
      fs.mkdirSync(paths.screenshots, { recursive: true });
      const file = path.join(paths.screenshots, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}-${checkId}.png`);
      await page.screenshot({ path: file, fullPage: true });
      pruneScreenshots();
      logEvent("info", "failure_screenshot", "Captured failure screenshot", { file });
    } catch {}
  }

  enqueue(fn) {
    const next = this.operation.then(fn, fn);
    this.operation = next.catch(() => {});
    return next;
  }
}

function authBrowserArgs() {
  const args = ["--disable-dev-shm-usage"];
  if (config.authRemoteDebuggingPort > 0) {
    args.push("--remote-debugging-address=127.0.0.1");
    args.push(`--remote-debugging-port=${config.authRemoteDebuggingPort}`);
  }
  return args;
}
function normalizeConfig(cfg) {
  return {
    ...cfg,
    enabled: Number(cfg.enabled) ? 1 : 0,
    high_risk_enabled: Number(cfg.high_risk_enabled) ? 1 : 0,
    monitor_schedule_mode: cfg.monitor_schedule_mode === "custom" ? "custom" : "all_day",
    monitor_start: cfg.monitor_start || "00:00",
    monitor_end: cfg.monitor_end || "23:59",
    auto_high_risk_enabled: Number(cfg.auto_high_risk_enabled) ? 1 : 0,
    auto_high_risk_apply_mode: cfg.auto_high_risk_apply_mode === "auto_apply" ? "auto_apply" : "suggest_only",
    add_credits: Number(cfg.add_credits),
    threshold: Number(cfg.threshold),
    check_interval_seconds: Number(cfg.check_interval_seconds),
    high_risk_interval_seconds: Number(cfg.high_risk_interval_seconds),
    learning_interval_seconds: Number(cfg.learning_interval_seconds || 120),
    failure_pause_threshold: Number(cfg.failure_pause_threshold),
    repair_confirmations: Number(cfg.repair_confirmations),
    repair_cooldown_seconds: Number(cfg.repair_cooldown_seconds)
  };
}

function monitorWindowState(cfg) {
  if (cfg.monitor_schedule_mode !== "custom") {
    return { allowed: true, reason: "all_day", nextStartAt: null };
  }
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = parseTime(cfg.monitor_start);
  const end = parseTime(cfg.monitor_end);
  const allowed = isMinuteInWindow(current, start, end);
  return {
    allowed,
    reason: allowed ? "custom_window" : "outside_custom_window",
    nextStartAt: allowed ? null : nextWindowStartMs(now, start)
  };
}

function isMinuteInWindow(current, start, end) {
  if (start === end) return true;
  if (start < end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function nextWindowStartMs(now, startMinute) {
  const next = new Date(now);
  next.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function buildRiskRecommendation(samples) {
  if (!samples.length) return null;
  const minutes = samples
    .map((sample) => minuteOfDay(new Date(sample.checked_at)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!minutes.length) return null;

  let clusterStart = minutes[0];
  let clusterEnd = minutes[0];
  if (minutes.length > 1) {
    let largestGap = -1;
    let largestGapIndex = 0;
    for (let i = 0; i < minutes.length; i += 1) {
      const current = minutes[i];
      const next = minutes[(i + 1) % minutes.length] + (i === minutes.length - 1 ? 1440 : 0);
      const gap = next - current;
      if (gap > largestGap) {
        largestGap = gap;
        largestGapIndex = i;
      }
    }
    clusterStart = minutes[(largestGapIndex + 1) % minutes.length];
    clusterEnd = minutes[largestGapIndex];
    if (clusterEnd < clusterStart) clusterEnd += 1440;
  }

  const bufferedStart = wrapMinute(clusterStart - 30);
  const bufferedEnd = wrapMinute(clusterEnd + 90);
  const span = Math.max(1, clusterEnd - clusterStart);
  const confidence = samples.length >= 4 && span <= 180 ? "high" : samples.length >= 2 && span <= 360 ? "medium" : "low";
  return {
    start: formatMinute(bufferedStart),
    end: formatMinute(bufferedEnd),
    confidence
  };
}

function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function wrapMinute(value) {
  return ((value % 1440) + 1440) % 1440;
}

function formatMinute(value) {
  const minute = wrapMinute(value);
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function classifyFromResponses(responses, expected) {
  const parsed = [];
  for (const response of responses) {
    if (!response.body) continue;
    if (String(response.mimeType || "").toLowerCase().includes("text/html")) continue;
    if (!isPioneerUrl(response.url)) continue;
    if (response.url.includes(PIONEER_API_HOST) && !response.url.includes("/overage-settings")) continue;
    const text = response.body.slice(0, 200_000);
    if (!/credit|rule|charge|remaining|restore|threshold/i.test(text)) continue;
    const json = tryJson(text);
    const current = json ? extractRuleFromApiJson(json) : extractRuleFromAny(text);
    if (current.exists || current.reason) {
      parsed.push({ url: response.url, status: response.status, current });
    }
  }
  const best = parsed.find((item) => item.current.exists) || parsed[0];
  if (!best) return { status: "unknown", source: "api", reason: "No fresh credit rules response matched" };
  if (!best.current.exists) return { status: "missing", source: "api", reason: best.current.reason || "No rule in fresh API response", current: best.current, responseUrl: best.url };
  if (!matchesExpected(best.current, expected)) return { status: "mismatch", source: "api", reason: "Fresh API response rule does not match configuration", current: best.current, expected, responseUrl: best.url };
  return { status: "ok", source: "api", current: best.current, responseUrl: best.url };
}

function selectBestState(api, dom, verifyOnly) {
  if (verifyOnly) {
    if (["ok", "missing", "mismatch"].includes(api.status)) {
      return { status: "ok", source: api.source || "api", current: api.current, ruleStatus: api.status, ruleResult: api };
    }
    if (dom.status === "auth_required") return dom;
    if (["ok", "missing", "mismatch"].includes(dom.status)) {
      return { status: "ok", source: dom.source || "dom", current: dom.current, ruleStatus: dom.status, ruleResult: dom };
    }
    if (api.status !== "unknown") return api;
    return dom;
  }
  if (["ok", "missing", "mismatch"].includes(api.status)) return api;
  if (dom.status === "auth_required") return dom;
  if (api.status !== "unknown") return api;
  return dom;
}

function looksRelevantUrl(url) {
  return /credit|rule|billing|usage|quota|account/i.test(url);
}

function isPioneerUrl(url) {
  return url.includes(PIONEER_HOST) || url.includes(PIONEER_API_HOST);
}

function isLoginLike(dom) {
  return /login|sign\s*in|oauth|authorize|continue with/i.test(`${dom.url}\n${dom.title}\n${dom.text}`) && !/credit rules/i.test(dom.text);
}

function summarizeDom(dom) {
  return {
    url: dom.url,
    title: dom.title,
    textSample: String(dom.text || "").slice(0, 500),
    fields: dom.fields?.slice(0, 20),
    buttons: dom.buttons?.slice(0, 20)
  };
}

function extractRuleFromText(text, fields = []) {
  const lower = text.toLowerCase();
  if (/no\s+credit\s+rules|not\s+set|disabled|cancelled|canceled|no\s+rules|create\s+rule|add\s+rule/i.test(text)) {
    return { exists: false, reason: "Page indicates no active rule" };
  }
  const mode = /restore/i.test(text) && !/add/i.test(text) ? "restore" : /restore/i.test(text) && /add/i.test(text) ? nearestMode(text) : "add";
  const nums = extractNumbers(text);
  const visibleValues = fields.filter((f) => f.visible !== false).map((f) => Number.parseFloat(String(f.value).replace(/,/g, ""))).filter(Number.isFinite);
  const values = visibleValues.length >= 2 ? visibleValues : nums;
  if (!/rule|charge|remaining|credit/i.test(lower) || values.length < 1) {
    return { exists: false, reason: "Could not find numeric rule values" };
  }
  return {
    exists: true,
    mode,
    add_credits: values[0],
    threshold: values.length > 1 ? values[1] : undefined,
    rawNumbers: nums.slice(0, 10)
  };
}

function extractRuleFromAny(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (/null|false|disabled|cancelled|canceled|missing/i.test(text) && /rule/i.test(text)) {
    return { exists: false, reason: "API indicates missing or disabled rule" };
  }
  return extractRuleFromText(text);
}

function extractRuleFromApiJson(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "overage_enabled")) {
    if (!value.overage_enabled) {
      return { exists: false, reason: "Pioneer overage rule is disabled", overage_enabled: false };
    }
    const addCredits = Number(value.topup_amount) / 100;
    const threshold = Number(value.charge_threshold) / 100;
    return {
      exists: true,
      mode: value.topup_mode === "restore" ? "restore" : "add",
      add_credits: addCredits,
      threshold,
      overage_enabled: true
    };
  }
  const flattened = flatten(value);
  return extractRuleFromAny(flattened);
}

function nearestMode(text) {
  const restore = text.search(/restore/i);
  const add = text.search(/add/i);
  if (restore >= 0 && (add < 0 || restore < add)) return "restore";
  return "add";
}

function extractNumbers(text) {
  return Array.from(String(text).matchAll(/\b\d+(?:\.\d+)?\b/g)).map((m) => Number.parseFloat(m[0])).filter(Number.isFinite);
}

function matchesExpected(current, expected) {
  if (!current.exists) return false;
  if (current.mode && expected.mode && current.mode !== expected.mode) return false;
  if (!Number.isFinite(current.add_credits)) return false;
  if (!Number.isFinite(current.threshold)) return false;
  if (Math.abs(Number(current.add_credits) - Number(expected.add_credits)) > 0.0001) return false;
  if (Math.abs(Number(current.threshold) - Number(expected.threshold)) > 0.0001) return false;
  return true;
}

async function clickByText(page, patterns) {
  const errors = [];
  for (const pattern of patterns) {
    const locator = page.getByRole("button", { name: pattern }).first();
    if (await locator.count().catch(() => 0)) {
      try {
        await locator.click({ timeout: 5000 });
        return;
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  for (const pattern of patterns) {
    const locator = page.locator("button, [role='button'], label").filter({ hasText: pattern }).first();
    if (await locator.count().catch(() => 0)) {
      try {
        await locator.click({ timeout: 5000 });
        return;
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  throw new Error(`Could not click control matching ${patterns.map(String).join(", ")}: ${errors.join("; ") || "not found"}`);
}

async function fillNear(page, labels, value) {
  for (const label of labels) {
    const input = page.getByLabel(label).first();
    if (await input.count().catch(() => 0)) {
      await input.fill(value, { timeout: 5000 });
      return;
    }
  }
  for (const label of labels) {
    const input = page.locator("input, textarea, [role='spinbutton']").filter({ has: page.locator(`xpath=preceding::*[contains(normalize-space(.), '${escapeXPathLabel(label)}')]`) }).first();
    if (await input.count().catch(() => 0)) {
      await input.fill(value, { timeout: 5000 });
      return;
    }
  }
  const all = page.locator("input, textarea, [role='spinbutton']");
  const count = await all.count();
  if (count > 0) {
    const index = labels.some((x) => /threshold|remaining|below/i.test(String(x))) ? Math.min(1, count - 1) : 0;
    await all.nth(index).fill(value, { timeout: 5000 });
    return;
  }
  throw new Error(`Could not find input for ${labels.map(String).join(", ")}`);
}

function escapeXPathLabel(label) {
  return String(label).replace(/^\//, "").replace(/[\\'\[\]\(\)\?\*\+\|]/g, "").slice(0, 30);
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function flatten(value) {
  const out = [];
  walk(value, "");
  return out.join("\n");

  function walk(node, prefix) {
    if (node == null) return;
    if (typeof node !== "object") {
      out.push(`${prefix}: ${String(node)}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${prefix}[${index}]`));
      return;
    }
    for (const [key, val] of Object.entries(node)) {
      walk(val, prefix ? `${prefix}.${key}` : key);
    }
  }
}

function isNowInWindow(start, end) {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const s = parseTime(start);
  const e = parseTime(end);
  if (s <= e) return current >= s && current <= e;
  return current >= s || current <= e;
}

function parseTime(value) {
  const [h, m] = String(value || "00:00").split(":").map((x) => Number.parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function pruneScreenshots() {
  try {
    const files = fs.readdirSync(paths.screenshots)
      .filter((file) => file.endsWith(".png"))
      .map((file) => ({ file, full: path.join(paths.screenshots, file), mtime: fs.statSync(path.join(paths.screenshots, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const item of files.slice(config.maxFailureScreenshots)) fs.unlinkSync(item.full);
  } catch {}
}

async function handleAuthStreamMessage(page, raw, sendMeta) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const message = tryJson(text);
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "click":
      await page.mouse.click(Number(message.x), Number(message.y));
      break;
    case "move":
      await page.mouse.move(Number(message.x), Number(message.y));
      break;
    case "wheel":
      await page.mouse.wheel(Number(message.deltaX || 0), Number(message.deltaY || 0));
      break;
    case "type":
      if (message.text) await page.keyboard.type(String(message.text), { delay: 5 });
      break;
    case "press":
      if (message.key) await page.keyboard.press(String(message.key));
      break;
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      break;
    case "meta":
      break;
    default:
      return;
  }
  await sendMeta().catch(() => {});
}

function sendWs(ws, data) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(data));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}








