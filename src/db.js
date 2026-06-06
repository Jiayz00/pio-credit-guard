import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config, paths } from "./config.js";

const DEFAULT_CONFIG = {
  account_id: "default",
  enabled: 0,
  mode: "add",
  add_credits: 10,
  threshold: 5,
  check_interval_seconds: 180,
  high_risk_enabled: 0,
  high_risk_start: "00:00",
  high_risk_end: "00:10",
  high_risk_interval_seconds: 30,
  monitor_schedule_mode: "all_day",
  monitor_start: "00:00",
  monitor_end: "23:59",
  auto_high_risk_enabled: 0,
  auto_high_risk_apply_mode: "suggest_only",
  learning_interval_seconds: 120,
  failure_pause_threshold: 3,
  repair_confirmations: 2,
  repair_cooldown_seconds: 300
};

let db;

export function initDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(paths.logs, { recursive: true });
  fs.mkdirSync(paths.screenshots, { recursive: true });
  fs.mkdirSync(paths.browserProfile, { recursive: true });

  db = new DatabaseSync(paths.db);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      account_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'add',
      add_credits REAL NOT NULL DEFAULT 10,
      threshold REAL NOT NULL DEFAULT 5,
      check_interval_seconds INTEGER NOT NULL DEFAULT 180,
      high_risk_enabled INTEGER NOT NULL DEFAULT 0,
      high_risk_start TEXT NOT NULL DEFAULT '00:00',
      high_risk_end TEXT NOT NULL DEFAULT '00:10',
      high_risk_interval_seconds INTEGER NOT NULL DEFAULT 30,
      monitor_schedule_mode TEXT NOT NULL DEFAULT 'all_day',
      monitor_start TEXT NOT NULL DEFAULT '00:00',
      monitor_end TEXT NOT NULL DEFAULT '23:59',
      auto_high_risk_enabled INTEGER NOT NULL DEFAULT 0,
      auto_high_risk_apply_mode TEXT NOT NULL DEFAULT 'suggest_only',
      learning_interval_seconds INTEGER NOT NULL DEFAULT 120,
      failure_pause_threshold INTEGER NOT NULL DEFAULT 3,
      repair_confirmations INTEGER NOT NULL DEFAULT 2,
      repair_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_state (
      account_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'needs_auth',
      profile_path TEXT NOT NULL,
      authorized_at TEXT,
      last_verified_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS worker_state (
      account_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      current_check_id TEXT,
      last_check_at TEXT,
      last_repair_at TEXT,
      last_result TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL DEFAULT 'default',
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auto_high_risk_state (
      account_id TEXT PRIMARY KEY,
      learning_status TEXT NOT NULL DEFAULT 'idle',
      learning_started_at TEXT,
      learning_ends_at TEXT,
      detected_start TEXT,
      detected_end TEXT,
      confidence TEXT,
      sample_count INTEGER NOT NULL DEFAULT 0,
      applied INTEGER NOT NULL DEFAULT 0,
      last_applied_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auto_high_risk_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL DEFAULT 'default',
      checked_at TEXT NOT NULL,
      status TEXT NOT NULL,
      needs_repair INTEGER NOT NULL DEFAULT 0,
      repaired INTEGER NOT NULL DEFAULT 0,
      result_summary TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_auto_high_risk_samples_account_checked
      ON auto_high_risk_samples(account_id, checked_at);
  `);

  migrateConfigColumns();

  const existing = db.prepare("SELECT account_id FROM app_config WHERE account_id = ?").get("default");
  if (!existing) {
    db.prepare(`
      INSERT INTO app_config (
        account_id, enabled, mode, add_credits, threshold, check_interval_seconds,
        high_risk_enabled, high_risk_start, high_risk_end, high_risk_interval_seconds,
        monitor_schedule_mode, monitor_start, monitor_end,
        auto_high_risk_enabled, auto_high_risk_apply_mode, learning_interval_seconds,
        failure_pause_threshold, repair_confirmations, repair_cooldown_seconds
      ) VALUES (
        @account_id, @enabled, @mode, @add_credits, @threshold, @check_interval_seconds,
        @high_risk_enabled, @high_risk_start, @high_risk_end, @high_risk_interval_seconds,
        @monitor_schedule_mode, @monitor_start, @monitor_end,
        @auto_high_risk_enabled, @auto_high_risk_apply_mode, @learning_interval_seconds,
        @failure_pause_threshold, @repair_confirmations, @repair_cooldown_seconds
      )
    `).run(DEFAULT_CONFIG);
  }

  db.prepare(`
    INSERT INTO auto_high_risk_state (account_id, learning_status)
    VALUES ('default', 'idle')
    ON CONFLICT(account_id) DO NOTHING
  `).run();

  db.prepare(`
    INSERT INTO auth_state (account_id, status, profile_path)
    VALUES ('default', 'needs_auth', ?)
    ON CONFLICT(account_id) DO NOTHING
  `).run(paths.browserProfile);

  db.prepare(`
    INSERT INTO worker_state (account_id, status)
    VALUES ('default', 'idle')
    ON CONFLICT(account_id) DO NOTHING
  `).run();

  return db;
}

export function getDb() {
  if (!db) return initDb();
  return db;
}

export function getConfig(accountId = "default") {
  return getDb().prepare("SELECT * FROM app_config WHERE account_id = ?").get(accountId);
}

export function updateConfig(input, accountId = "default") {
  const current = getConfig(accountId);
  const next = pickConfigParams({ ...current, ...input, account_id: accountId });
  getDb().prepare(`
    UPDATE app_config SET
      enabled = @enabled,
      mode = @mode,
      add_credits = @add_credits,
      threshold = @threshold,
      check_interval_seconds = @check_interval_seconds,
      high_risk_enabled = @high_risk_enabled,
      high_risk_start = @high_risk_start,
      high_risk_end = @high_risk_end,
      high_risk_interval_seconds = @high_risk_interval_seconds,
      monitor_schedule_mode = @monitor_schedule_mode,
      monitor_start = @monitor_start,
      monitor_end = @monitor_end,
      auto_high_risk_enabled = @auto_high_risk_enabled,
      auto_high_risk_apply_mode = @auto_high_risk_apply_mode,
      learning_interval_seconds = @learning_interval_seconds,
      failure_pause_threshold = @failure_pause_threshold,
      repair_confirmations = @repair_confirmations,
      repair_cooldown_seconds = @repair_cooldown_seconds,
      updated_at = CURRENT_TIMESTAMP
    WHERE account_id = @account_id
  `).run(next);
  return getConfig(accountId);
}

export function getAuthState(accountId = "default") {
  return getDb().prepare("SELECT * FROM auth_state WHERE account_id = ?").get(accountId);
}

export function updateAuthState(input, accountId = "default") {
  const current = getAuthState(accountId) || { account_id: accountId, profile_path: paths.browserProfile };
  const next = pickAuthParams({ ...current, ...input, account_id: accountId, profile_path: current.profile_path || paths.browserProfile });
  getDb().prepare(`
    INSERT INTO auth_state (account_id, status, profile_path, authorized_at, last_verified_at, last_error, updated_at)
    VALUES (@account_id, @status, @profile_path, @authorized_at, @last_verified_at, @last_error, CURRENT_TIMESTAMP)
    ON CONFLICT(account_id) DO UPDATE SET
      status = excluded.status,
      profile_path = excluded.profile_path,
      authorized_at = excluded.authorized_at,
      last_verified_at = excluded.last_verified_at,
      last_error = excluded.last_error,
      updated_at = CURRENT_TIMESTAMP
  `).run(next);
  return getAuthState(accountId);
}

export function getWorkerState(accountId = "default") {
  return getDb().prepare("SELECT * FROM worker_state WHERE account_id = ?").get(accountId);
}

export function updateWorkerState(input, accountId = "default") {
  const current = getWorkerState(accountId) || { account_id: accountId };
  const next = pickWorkerParams({ ...current, ...input, account_id: accountId });
  getDb().prepare(`
    INSERT INTO worker_state (
      account_id, status, current_check_id, last_check_at, last_repair_at,
      last_result, consecutive_failures, last_error, updated_at
    ) VALUES (
      @account_id, @status, @current_check_id, @last_check_at, @last_repair_at,
      @last_result, @consecutive_failures, @last_error, CURRENT_TIMESTAMP
    ) ON CONFLICT(account_id) DO UPDATE SET
      status = excluded.status,
      current_check_id = excluded.current_check_id,
      last_check_at = excluded.last_check_at,
      last_repair_at = excluded.last_repair_at,
      last_result = excluded.last_result,
      consecutive_failures = excluded.consecutive_failures,
      last_error = excluded.last_error,
      updated_at = CURRENT_TIMESTAMP
  `).run(next);
  return getWorkerState(accountId);
}

export function getAutoHighRiskState(accountId = "default") {
  return getDb().prepare("SELECT * FROM auto_high_risk_state WHERE account_id = ?").get(accountId);
}

export function updateAutoHighRiskState(input, accountId = "default") {
  const current = getAutoHighRiskState(accountId) || { account_id: accountId, learning_status: "idle" };
  const next = pickAutoHighRiskStateParams({ ...current, ...input, account_id: accountId });
  getDb().prepare(`
    INSERT INTO auto_high_risk_state (
      account_id, learning_status, learning_started_at, learning_ends_at,
      detected_start, detected_end, confidence, sample_count, applied,
      last_applied_at, updated_at
    ) VALUES (
      @account_id, @learning_status, @learning_started_at, @learning_ends_at,
      @detected_start, @detected_end, @confidence, @sample_count, @applied,
      @last_applied_at, CURRENT_TIMESTAMP
    ) ON CONFLICT(account_id) DO UPDATE SET
      learning_status = excluded.learning_status,
      learning_started_at = excluded.learning_started_at,
      learning_ends_at = excluded.learning_ends_at,
      detected_start = excluded.detected_start,
      detected_end = excluded.detected_end,
      confidence = excluded.confidence,
      sample_count = excluded.sample_count,
      applied = excluded.applied,
      last_applied_at = excluded.last_applied_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(next);
  return getAutoHighRiskState(accountId);
}

export function insertAutoHighRiskSample(input, accountId = "default") {
  const next = {
    account_id: accountId,
    checked_at: input.checked_at || new Date().toISOString(),
    status: input.status || "unknown",
    needs_repair: input.needs_repair ? 1 : 0,
    repaired: input.repaired ? 1 : 0,
    result_summary: input.result_summary ? JSON.stringify(redact(input.result_summary)).slice(0, 4000) : null
  };
  getDb().prepare(`
    INSERT INTO auto_high_risk_samples (
      account_id, checked_at, status, needs_repair, repaired, result_summary
    ) VALUES (
      @account_id, @checked_at, @status, @needs_repair, @repaired, @result_summary
    )
  `).run(next);
  pruneAutoHighRiskSamples(accountId);
}

export function listAutoHighRiskSamples({ accountId = "default", since = null, until = null, riskOnly = false, limit = 1000 } = {}) {
  const clauses = ["account_id = @accountId"];
  const params = { accountId, limit };
  if (since) {
    clauses.push("checked_at >= @since");
    params.since = since;
  }
  if (until) {
    clauses.push("checked_at <= @until");
    params.until = until;
  }
  if (riskOnly) clauses.push("status IN ('missing', 'mismatch')");
  return getDb().prepare(`
    SELECT * FROM auto_high_risk_samples
    WHERE ${clauses.join(" AND ")}
    ORDER BY checked_at ASC
    LIMIT @limit
  `).all(params);
}

export function clearAutoHighRiskSamples(accountId = "default") {
  getDb().prepare("DELETE FROM auto_high_risk_samples WHERE account_id = ?").run(accountId);
}

export function logEvent(level, event, message, details = null, accountId = "default") {
  getDb().prepare(`
    INSERT INTO event_log (account_id, level, event, message, details_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(accountId, level, event, message, details ? JSON.stringify(redact(details)) : null);
}

export function listLogs({ limit = 100, offset = 0 } = {}) {
  return getDb().prepare(`
    SELECT * FROM event_log
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

export function cleanupLogs() {
  getDb().prepare("DELETE FROM event_log WHERE created_at < datetime('now', ?)").run(`-${config.logRetentionDays} days`);
}

function pickConfigParams(value) {
  return {
    account_id: value.account_id,
    enabled: value.enabled,
    mode: value.mode,
    add_credits: value.add_credits,
    threshold: value.threshold,
    check_interval_seconds: value.check_interval_seconds,
    high_risk_enabled: value.high_risk_enabled,
    high_risk_start: value.high_risk_start,
    high_risk_end: value.high_risk_end,
    high_risk_interval_seconds: value.high_risk_interval_seconds,
    monitor_schedule_mode: value.monitor_schedule_mode,
    monitor_start: value.monitor_start,
    monitor_end: value.monitor_end,
    auto_high_risk_enabled: value.auto_high_risk_enabled,
    auto_high_risk_apply_mode: value.auto_high_risk_apply_mode,
    learning_interval_seconds: value.learning_interval_seconds,
    failure_pause_threshold: value.failure_pause_threshold,
    repair_confirmations: value.repair_confirmations,
    repair_cooldown_seconds: value.repair_cooldown_seconds
  };
}

function pickAuthParams(value) {
  return {
    account_id: value.account_id,
    status: value.status,
    profile_path: value.profile_path,
    authorized_at: value.authorized_at ?? null,
    last_verified_at: value.last_verified_at ?? null,
    last_error: value.last_error ?? null
  };
}

function pickWorkerParams(value) {
  return {
    account_id: value.account_id,
    status: value.status,
    current_check_id: value.current_check_id ?? null,
    last_check_at: value.last_check_at ?? null,
    last_repair_at: value.last_repair_at ?? null,
    last_result: value.last_result ?? null,
    consecutive_failures: value.consecutive_failures ?? 0,
    last_error: value.last_error ?? null
  };
}

function pickAutoHighRiskStateParams(value) {
  return {
    account_id: value.account_id,
    learning_status: value.learning_status || "idle",
    learning_started_at: value.learning_started_at ?? null,
    learning_ends_at: value.learning_ends_at ?? null,
    detected_start: value.detected_start ?? null,
    detected_end: value.detected_end ?? null,
    confidence: value.confidence ?? null,
    sample_count: value.sample_count ?? 0,
    applied: value.applied ? 1 : 0,
    last_applied_at: value.last_applied_at ?? null
  };
}

function migrateConfigColumns() {
  const columns = new Set(db.prepare("PRAGMA table_info(app_config)").all().map((item) => item.name));
  const additions = [
    ["monitor_schedule_mode", "TEXT NOT NULL DEFAULT 'all_day'"],
    ["monitor_start", "TEXT NOT NULL DEFAULT '00:00'"],
    ["monitor_end", "TEXT NOT NULL DEFAULT '23:59'"],
    ["auto_high_risk_enabled", "INTEGER NOT NULL DEFAULT 0"],
    ["auto_high_risk_apply_mode", "TEXT NOT NULL DEFAULT 'suggest_only'"],
    ["learning_interval_seconds", "INTEGER NOT NULL DEFAULT 120"]
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE app_config ADD COLUMN ${name} ${definition}`);
  }
}

function pruneAutoHighRiskSamples(accountId) {
  const database = getDb();
  database.prepare("DELETE FROM auto_high_risk_samples WHERE account_id = ? AND checked_at < datetime('now', '-7 days')").run(accountId);
  const rows = database.prepare(`
    SELECT id FROM auto_high_risk_samples
    WHERE account_id = ?
    ORDER BY checked_at DESC, id DESC
    LIMIT -1 OFFSET 1000
  `).all(accountId);
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  database.prepare(`DELETE FROM auto_high_risk_samples WHERE id IN (${placeholders})`).run(...ids);
}

function redact(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (/cookie|token|secret|authorization|password|localstorage|session/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redact(val);
    }
  }
  return out;
}


