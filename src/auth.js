import { config } from "./config.js";

export function requireProxySecret(req, res, next) {
  if (!config.authRequired) return next();
  if (!config.internalProxySecret) {
    return res.status(500).json({ error: "INTERNAL_PROXY_SECRET is required" });
  }
  const actual = req.get("x-internal-proxy-secret") || "";
  if (actual !== config.internalProxySecret) {
    return res.status(404).send("not found");
  }
  next();
}

export async function requireAdmin(req, res, next) {
  if (!config.authRequired) return next();
  const token = extractBearer(req);
  const cookie = req.get("cookie") || "";
  if (!token && !cookie) return reject(req, res);

  try {
    const url = `${config.subBaseUrl}${config.subAdminVerifyPath}`;
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(url, { headers });
    if (!response.ok) return reject(req, res);
    const body = await safeJson(response);
    if (!isAdminBody(body)) return reject(req, res);
    req.adminUser = body;
    next();
  } catch (error) {
    next(error);
  }
}

export function authContext(req, res) {
  res.json({ ok: true, admin: req.adminUser || null, basePath: config.publicBasePath });
}

function extractBearer(req) {
  const header = req.get("authorization") || req.get("x-sub-auth-token") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return header.trim();
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function isAdminBody(body) {
  if (!body || typeof body !== "object") return false;
  const candidates = [body, body.data, body.user, body.data?.user].filter(Boolean);
  return candidates.some((item) => item.is_admin === true || item.isAdmin === true || item.role === "admin" || item.role === "super_admin");
}

function reject(req, res) {
  const wantsJson = req.originalUrl.includes(`${config.publicBasePath}/api`) || req.get("accept")?.includes("application/json");
  if (wantsJson) return res.status(401).json({ error: "admin authentication required" });
  const redirect = encodeURIComponent(req.originalUrl || config.publicBasePath);
  return res.redirect(`/login?redirect=${redirect}`);
}

