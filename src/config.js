import "dotenv/config";
import path from "node:path";
import process from "node:process";

const cwd = process.cwd();

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePath(value) {
  if (path.isAbsolute(value)) return value;
  return path.resolve(cwd, value);
}

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: intEnv("PORT", 18994),
  publicBasePath: (process.env.PUBLIC_BASE_PATH || "/admin/pioneer-credit").replace(/\/$/, ""),
  dataDir: resolvePath(process.env.DATA_DIR || "./data"),
  subBaseUrl: (process.env.SUB_BASE_URL || "http://127.0.0.1:18080").replace(/\/$/, ""),
  subAdminVerifyPath: process.env.SUB_ADMIN_VERIFY_PATH || "/api/v1/auth/me",
  internalProxySecret: process.env.INTERNAL_PROXY_SECRET || "",
  authRequired: boolEnv("AUTH_REQUIRED", true),
  trustProxy: boolEnv("TRUST_PROXY", true),
  authTimeoutMs: intEnv("AUTH_TIMEOUT_MS", 10 * 60 * 1000),
  browserHeadless: boolEnv("BROWSER_HEADLESS", true),
  headedAuth: boolEnv("HEADED_AUTH", true),
  authRemoteDebuggingPort: intEnv("AUTH_REMOTE_DEBUGGING_PORT", 0),
  screenshotOnFailure: boolEnv("SCREENSHOT_ON_FAILURE", true),
  maxFailureScreenshots: intEnv("MAX_FAILURE_SCREENSHOTS", 50),
  logRetentionDays: intEnv("LOG_RETENTION_DAYS", 30)
};

export const paths = {
  db: path.join(config.dataDir, "app.db"),
  browserProfile: path.join(config.dataDir, "browser-profile"),
  logs: path.join(config.dataDir, "logs"),
  screenshots: path.join(config.dataDir, "screenshots")
};



