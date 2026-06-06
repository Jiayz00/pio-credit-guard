const basePath = document.currentScript?.src ? new URL(".", document.currentScript.src).pathname.replace(/\/$/, "") : "/admin/pioneer-credit";
const token = () => localStorage.getItem("auth_token") || "";

const ids = {
  authStatus: byId("authStatus"),
  authMeta: byId("authMeta"),
  workerStatus: byId("workerStatus"),
  workerMeta: byId("workerMeta"),
  lastCheck: byId("lastCheck"),
  lastResult: byId("lastResult"),
  failures: byId("failures"),
  lastError: byId("lastError"),
  saveState: byId("saveState"),
  logs: byId("logs"),
  authBrowserPanel: byId("authBrowserPanel"),
  authBrowserImage: byId("authBrowserImage"),
  authBrowserMeta: byId("authBrowserMeta"),
  authBrowserText: byId("authBrowserText"),
  learningStatus: byId("learningStatus"),
  learningWindow: byId("learningWindow"),
  learningRecommendation: byId("learningRecommendation"),
  learningConfidence: byId("learningConfidence")
};

const fields = {
  enabled: byId("enabled"),
  mode: byId("mode"),
  add_credits: byId("addCredits"),
  threshold: byId("threshold"),
  check_interval_seconds: byId("checkInterval"),
  high_risk_enabled: byId("highRiskEnabled"),
  high_risk_start: byId("highRiskStart"),
  high_risk_end: byId("highRiskEnd"),
  high_risk_interval_seconds: byId("highRiskInterval"),
  monitor_schedule_mode: byId("monitorScheduleMode"),
  monitor_start: byId("monitorStart"),
  monitor_end: byId("monitorEnd"),
  auto_high_risk_enabled: byId("autoHighRiskEnabled"),
  auto_high_risk_apply_mode: byId("autoHighRiskApplyMode"),
  learning_interval_seconds: byId("learningInterval"),
  failure_pause_threshold: byId("failureThreshold"),
  repair_confirmations: byId("repairConfirmations"),
  repair_cooldown_seconds: byId("repairCooldown")
};

let loaded = false;
let busy = false;
let authBrowserActive = false;
let authBrowserBusy = false;
let authStream = null;
let authStreamConnecting = false;
let latestLearningState = {};

byId("refreshBtn").addEventListener("click", refreshAll);
byId("logsRefresh").addEventListener("click", loadLogs);
byId("configForm").addEventListener("submit", saveConfig);
byId("applyLearning").addEventListener("click", () => actionRequest("/api/auto-high-risk/apply"));
byId("restartLearning").addEventListener("click", () => actionRequest("/api/auto-high-risk/restart"));
fields.monitor_schedule_mode.addEventListener("change", updateMonitorScheduleControls);
byId("authBrowserRefresh").addEventListener("click", refreshAuthBrowser);
byId("authBrowserReload").addEventListener("click", () => streamOrCommand({ type: "reload" }, "/api/auth/browser/reload"));
byId("authBrowserEnter").addEventListener("click", () => streamOrCommand({ type: "press", key: "Enter" }, "/api/auth/browser/press", { key: "Enter" }));
byId("authBrowserTab").addEventListener("click", () => streamOrCommand({ type: "press", key: "Tab" }, "/api/auth/browser/press", { key: "Tab" }));
byId("authBrowserEsc").addEventListener("click", () => streamOrCommand({ type: "press", key: "Escape" }, "/api/auth/browser/press", { key: "Escape" }));
byId("authBrowserForm").addEventListener("submit", typeIntoAuthBrowser);
ids.authBrowserImage.addEventListener("click", clickAuthBrowser);
ids.authBrowserImage.addEventListener("keydown", keyAuthBrowser);
ids.authBrowserImage.addEventListener("wheel", wheelAuthBrowser, { passive: false });

bindAction("authStart", "/api/auth/start");
bindAction("authCancel", "/api/auth/cancel");
bindAction("authVerify", "/api/auth/verify");
bindAction("workerStart", "/api/worker/start");
bindAction("workerStop", "/api/worker/stop");
bindAction("checkNow", "/api/worker/check-now");
bindAction("repairNow", "/api/worker/repair-now", true);

await ensureAuthGate();
await refreshAll();
setInterval(refreshAll, 5000);
setInterval(() => {
  if (authBrowserActive && !authStream && !authStreamConnecting) void refreshAuthBrowser();
}, 2500);

async function ensureAuthGate() {
  try {
    await api("/api/auth/context");
    document.body.classList.remove("auth-pending");
  } catch (error) {
    if (error.status === 401) {
      location.href = `/login?redirect=${encodeURIComponent(currentRoute())}`;
      return new Promise(() => {});
    }
    document.body.classList.remove("auth-pending");
    throw error;
  }
}

async function refreshAll() {
  if (busy) return;
  try {
    const status = await api("/api/status");
    renderStatus(status);
    if (!loaded) {
      renderConfig(status.config);
      loaded = true;
    }
    if (status.auth_in_progress) {
      showAuthBrowserShell();
      connectAuthStream();
      if (!authStream && !authStreamConnecting) await refreshAuthBrowser();
    } else hideAuthBrowser();
    await loadLogs();
  } catch (error) {
    if (error.status === 401) {
      location.href = `/login?redirect=${encodeURIComponent(currentRoute())}`;
      return;
    }
    ids.lastError.textContent = error.message;
  }
}

async function loadLogs() {
  const data = await api("/api/logs?limit=120");
  ids.logs.innerHTML = "";
  for (const item of data.items || []) {
    const row = document.createElement("div");
    row.className = "log-row";
    row.innerHTML = `
      <span>${escapeHtml(localTime(item.created_at))}</span>
      <strong class="level-${escapeHtml(item.level)}">${escapeHtml(translateLevel(item.level))}</strong>
      <span class="log-message">${escapeHtml(translateEvent(item.event))} - ${escapeHtml(translateMessage(item.message))}</span>
    `;
    ids.logs.appendChild(row);
  }
}

async function saveConfig(event) {
  event.preventDefault();
  ids.saveState.textContent = "正在保存...";
  const payload = {
    enabled: fields.enabled.checked ? 1 : 0,
    mode: fields.mode.value,
    add_credits: Number(fields.add_credits.value),
    threshold: Number(fields.threshold.value),
    check_interval_seconds: Number(fields.check_interval_seconds.value),
    high_risk_enabled: fields.high_risk_enabled.checked ? 1 : 0,
    high_risk_start: fields.high_risk_start.value || "00:00",
    high_risk_end: fields.high_risk_end.value || "00:10",
    high_risk_interval_seconds: Number(fields.high_risk_interval_seconds.value),
    monitor_schedule_mode: fields.monitor_schedule_mode.value,
    monitor_start: fields.monitor_start.value || "00:00",
    monitor_end: fields.monitor_end.value || "23:59",
    auto_high_risk_enabled: fields.auto_high_risk_enabled.checked ? 1 : 0,
    auto_high_risk_apply_mode: fields.auto_high_risk_apply_mode.value,
    learning_interval_seconds: Number(fields.learning_interval_seconds.value),
    failure_pause_threshold: Number(fields.failure_pause_threshold.value),
    repair_confirmations: Number(fields.repair_confirmations.value),
    repair_cooldown_seconds: Number(fields.repair_cooldown_seconds.value)
  };
  try {
    const saved = await api("/api/config", { method: "PUT", body: JSON.stringify(payload) });
    renderConfig(saved);
    if (saved.auto_high_risk_enabled !== undefined) renderLearning(latestLearningState);
    ids.saveState.textContent = "已保存";
    setTimeout(() => ids.saveState.textContent = "", 1500);
  } catch (error) {
    ids.saveState.textContent = error.message;
  }
}

function bindAction(id, endpoint, confirmFirst = false) {
  byId(id).addEventListener("click", async () => {
    if (confirmFirst && !confirm("现在执行一次修复尝试？")) return;
    await actionRequest(endpoint);
  });
}

async function actionRequest(endpoint) {
  busy = true;
  setButtonsDisabled(true);
  try {
    const status = await api(endpoint, { method: "POST", body: "{}" });
    renderStatus(status);
    renderConfig(status.config || {});
    if (status.auth_in_progress) {
      showAuthBrowserShell();
      connectAuthStream();
      if (!authStream && !authStreamConnecting) await refreshAuthBrowser();
    }
    else hideAuthBrowser();
    await loadLogs();
  } catch (error) {
    alert(error.message);
  } finally {
    busy = false;
    setButtonsDisabled(false);
    renderLearning(latestLearningState);
  }
}

async function refreshAuthBrowser() {
  if (authStream) return;
  if (authBrowserBusy) return;
  authBrowserBusy = true;
  try {
    const snapshot = await api("/api/auth/browser/snapshot");
    renderAuthBrowser(snapshot);
  } catch (error) {
    if (error.status === 401) {
      location.href = `/login?redirect=${encodeURIComponent(currentRoute())}`;
      return;
    }
    ids.authBrowserMeta.textContent = error.message;
  } finally {
    authBrowserBusy = false;
  }
}

function renderAuthBrowser(snapshot) {
  authBrowserActive = Boolean(snapshot?.active);
  if (!authBrowserActive) {
    hideAuthBrowser();
    return;
  }
  ids.authBrowserPanel.classList.remove("hidden");
  ids.authBrowserImage.src = snapshot.image;
  ids.authBrowserImage.dataset.width = snapshot.viewport?.width || "1365";
  ids.authBrowserImage.dataset.height = snapshot.viewport?.height || "900";
  ids.authBrowserImage.tabIndex = 0;
  ids.authBrowserMeta.textContent = `${snapshot.title || "未命名页面"} - ${snapshot.url || ""}`;
}

function hideAuthBrowser() {
  authBrowserActive = false;
  closeAuthStream();
  ids.authBrowserPanel.classList.add("hidden");
  ids.authBrowserImage.removeAttribute("src");
  ids.authBrowserMeta.textContent = "当前没有授权浏览器";
}

function showAuthBrowserShell() {
  authBrowserActive = true;
  ids.authBrowserPanel.classList.remove("hidden");
  ids.authBrowserImage.tabIndex = 0;
  if (!ids.authBrowserImage.getAttribute("src")) {
    ids.authBrowserMeta.textContent = "正在连接实时授权画面...";
  }
}

async function connectAuthStream() {
  if (authStream || authStreamConnecting || !authBrowserActive) return;
  authStreamConnecting = true;
  try {
    const ticket = await api("/api/auth/browser/stream-ticket", { method: "POST", body: "{}" });
    const wsUrl = new URL(ticket.path, location.href);
    wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    authStream = new WebSocket(wsUrl.href);
    authStream.addEventListener("open", () => {
      authStreamConnecting = false;
      ids.authBrowserMeta.textContent = "实时授权画面已连接";
    });
    authStream.addEventListener("message", (event) => handleAuthStreamMessage(event.data));
    authStream.addEventListener("close", () => {
      authStream = null;
      authStreamConnecting = false;
      if (authBrowserActive) ids.authBrowserMeta.textContent = "实时连接已断开，已切回截图刷新";
    });
    authStream.addEventListener("error", () => {
      authStreamConnecting = false;
      ids.authBrowserMeta.textContent = "实时连接失败，已切回截图刷新";
    });
  } catch (error) {
    authStreamConnecting = false;
    ids.authBrowserMeta.textContent = error.message;
  }
}

function closeAuthStream() {
  const socket = authStream;
  authStream = null;
  authStreamConnecting = false;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
}

function handleAuthStreamMessage(raw) {
  const message = safeJson(raw);
  if (!message) return;
  if (message.type === "frame") {
    showAuthBrowserShell();
    ids.authBrowserImage.src = `data:image/jpeg;base64,${message.data}`;
    const width = message.metadata?.deviceWidth || message.metadata?.width || ids.authBrowserImage.dataset.width || 1365;
    const height = message.metadata?.deviceHeight || message.metadata?.height || ids.authBrowserImage.dataset.height || 900;
    ids.authBrowserImage.dataset.width = width;
    ids.authBrowserImage.dataset.height = height;
    return;
  }
  if (message.type === "meta") {
    authBrowserActive = Boolean(message.active);
    showAuthBrowserShell();
    ids.authBrowserImage.dataset.width = message.viewport?.width || ids.authBrowserImage.dataset.width || "1365";
    ids.authBrowserImage.dataset.height = message.viewport?.height || ids.authBrowserImage.dataset.height || "900";
    ids.authBrowserMeta.textContent = `${message.title || "未命名页面"} - ${message.url || ""}`;
    return;
  }
  if (message.type === "inactive") hideAuthBrowser();
  if (message.type === "error") ids.authBrowserMeta.textContent = message.message || "实时连接错误";
}

async function clickAuthBrowser(event) {
  if (!authBrowserActive) return;
  ids.authBrowserImage.focus();
  const point = authBrowserPoint(event);
  await streamOrCommand({ type: "click", ...point }, "/api/auth/browser/click", point);
}

async function typeIntoAuthBrowser(event) {
  event.preventDefault();
  const text = ids.authBrowserText.value;
  if (!text) return;
  await streamOrCommand({ type: "type", text }, "/api/auth/browser/type", { text });
  ids.authBrowserText.value = "";
}

function keyAuthBrowser(event) {
  if (!authBrowserActive || isTypingShortcut(event)) return;
  const key = event.key === " " ? "Space" : event.key;
  const allowed = key.length === 1 || ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key);
  if (!allowed) return;
  event.preventDefault();
  if (key.length === 1) sendAuthStream({ type: "type", text: key });
  else sendAuthStream({ type: "press", key });
}

function wheelAuthBrowser(event) {
  if (!authBrowserActive) return;
  event.preventDefault();
  sendAuthStream({ type: "wheel", deltaX: event.deltaX, deltaY: event.deltaY });
}

async function streamOrCommand(streamMessage, endpoint, payload = null) {
  if (sendAuthStream(streamMessage)) return;
  await authBrowserCommand(endpoint, payload);
}

function sendAuthStream(message) {
  if (!authStream || authStream.readyState !== WebSocket.OPEN) return false;
  authStream.send(JSON.stringify(message));
  return true;
}

function authBrowserPoint(event) {
  const rect = ids.authBrowserImage.getBoundingClientRect();
  const width = Number(ids.authBrowserImage.dataset.width || 1365);
  const height = Number(ids.authBrowserImage.dataset.height || 900);
  return {
    x: Math.max(0, Math.round(((event.clientX - rect.left) / rect.width) * width)),
    y: Math.max(0, Math.round(((event.clientY - rect.top) / rect.height) * height))
  };
}

function isTypingShortcut(event) {
  return event.ctrlKey || event.metaKey || event.altKey;
}

async function authBrowserCommand(endpoint, payload = null) {
  if (authBrowserBusy) return;
  authBrowserBusy = true;
  try {
    const snapshot = await api(endpoint, { method: "POST", body: payload ? JSON.stringify(payload) : "{}" });
    renderAuthBrowser(snapshot);
  } catch (error) {
    alert(error.message);
  } finally {
    authBrowserBusy = false;
  }
}

function renderStatus(data) {
  const auth = data.auth || {};
  const worker = data.worker || {};
  const schedule = data.schedule || {};
  ids.authStatus.textContent = translateStatus(auth.status || "unknown");
  ids.authMeta.textContent = auth.last_verified_at ? `已验证 ${localTime(auth.last_verified_at)}` : translateMessage(auth.last_error) || "未验证";
  ids.workerStatus.textContent = translateStatus(worker.status || "unknown");
  ids.workerMeta.textContent = data.running
    ? schedule.next_wake_at ? `下次唤醒 ${localTime(schedule.next_wake_at)}` : "调度器运行中"
    : "调度器已停止";
  ids.lastCheck.textContent = worker.last_check_at ? localTime(worker.last_check_at) : "从未检查";
  ids.lastResult.textContent = `${summarizeResult(worker.last_result)} / ${schedule.in_monitor_window ? "监控窗口内" : "监控窗口外"}`;
  ids.failures.textContent = worker.consecutive_failures ?? 0;
  ids.lastError.textContent = translateMessage(worker.last_error || auth.last_error) || "-";
  renderLearning(data.auto_high_risk || {});
}

function renderConfig(config) {
  fields.enabled.checked = Number(config.enabled) === 1;
  fields.mode.value = config.mode || "add";
  fields.add_credits.value = config.add_credits ?? 10;
  fields.threshold.value = config.threshold ?? 5;
  fields.check_interval_seconds.value = config.check_interval_seconds ?? 180;
  fields.high_risk_enabled.checked = Number(config.high_risk_enabled) === 1;
  fields.high_risk_start.value = config.high_risk_start || "00:00";
  fields.high_risk_end.value = config.high_risk_end || "00:10";
  fields.high_risk_interval_seconds.value = config.high_risk_interval_seconds ?? 30;
  fields.monitor_schedule_mode.value = config.monitor_schedule_mode || "all_day";
  fields.monitor_start.value = config.monitor_start || "00:00";
  fields.monitor_end.value = config.monitor_end || "23:59";
  fields.auto_high_risk_enabled.checked = Number(config.auto_high_risk_enabled) === 1;
  fields.auto_high_risk_apply_mode.value = config.auto_high_risk_apply_mode || "suggest_only";
  fields.learning_interval_seconds.value = config.learning_interval_seconds ?? 120;
  fields.failure_pause_threshold.value = config.failure_pause_threshold ?? 3;
  fields.repair_confirmations.value = config.repair_confirmations ?? 2;
  fields.repair_cooldown_seconds.value = config.repair_cooldown_seconds ?? 300;
  updateMonitorScheduleControls();
}

function renderLearning(state) {
  latestLearningState = state || {};
  ids.learningStatus.textContent = translateLearningStatus(state.learning_status || "idle");
  const start = state.learning_started_at ? localTime(state.learning_started_at) : "-";
  const end = state.learning_ends_at ? localTime(state.learning_ends_at) : "-";
  ids.learningWindow.textContent = `${start} 到 ${end}`;
  ids.learningRecommendation.textContent = state.detected_start && state.detected_end ? `${state.detected_start} - ${state.detected_end}` : "暂无建议";
  ids.learningConfidence.textContent = `样本 ${state.sample_count ?? 0} / ${translateConfidence(state.confidence)}`;
  byId("applyLearning").disabled = busy || !(state.detected_start && state.detected_end);
}

function updateMonitorScheduleControls() {
  const custom = fields.monitor_schedule_mode.value === "custom";
  document.querySelectorAll("[data-monitor-custom]").forEach((item) => {
    item.classList.toggle("hidden", !custom);
  });
  fields.monitor_start.disabled = !custom;
  fields.monitor_end.disabled = !custom;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  const auth = token();
  if (auth) headers.set("Authorization", `Bearer ${auth}`);
  const response = await fetch(`${basePath}${path}`, { ...options, headers, credentials: "include" });
  const text = await response.text();
  const body = text ? safeJson(text) : null;
  if (!response.ok) {
    const error = new Error(body?.error || body?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function summarizeResult(raw) {
  if (!raw) return "-";
  const data = safeJson(raw);
  if (!data) return String(raw).slice(0, 120);
  return `${translateStatus(data.status || "unknown")}${data.source ? ` / ${translateSource(data.source)}` : ""}`;
}

function translateStatus(value) {
  const map = {
    authorized: "已授权",
    authenticating: "授权中",
    needs_auth: "需要授权",
    idle: "空闲",
    running: "运行中",
    checking: "检查中",
    repairing: "修复中",
    paused: "已暂停",
    scheduled_sleep: "等待监控时间段",
    learning: "自动学习中",
    error: "错误",
    needs_attention: "需要处理",
    ok: "正常",
    missing: "缺失",
    mismatch: "不匹配",
    unknown: "未知",
    page_error: "页面错误",
    stale_or_timeout: "超时或非实时",
    auth_required: "需要登录"
  };
  return map[value] || value || "未知";
}

function translateSource(value) {
  const map = { api: "接口", dom: "页面", error: "错误", manual: "手动" };
  return map[value] || value || "未知来源";
}

function translateMessage(value) {
  if (!value) return "";
  return String(value)
    .replace("Pioneer authorization is required", "需要先完成 Pioneer 授权")
    .replace("Authorization cancelled", "授权已取消")
    .replace("Authorization browser started", "授权浏览器已启动")
    .replace("Authorization browser is not active", "授权浏览器未启动")
    .replace("Authorization window closed", "授权窗口已关闭")
    .replace("Authorization timed out", "授权超时")
    .replace("Pioneer authorization verified", "Pioneer 授权验证成功")
    .replace("Authorization required", "需要授权")
    .replace("Worker started", "任务已启动")
    .replace("Worker stopped", "任务已停止")
    .replace("Configuration updated", "配置已更新")
    .replace("Outside monitoring window, worker is sleeping", "当前不在监控时间段，任务休眠")
    .replace("Auto high-risk learning started", "自动高风险学习已开始")
    .replace("Auto high-risk learning completed with recommendation", "自动高风险学习已完成并生成建议")
    .replace("Auto high-risk learning completed and applied", "自动高风险学习已完成并自动应用")
    .replace("Auto high-risk learning finished without enough samples", "自动高风险学习样本不足")
    .replace("Auto high-risk recommendation applied", "自动高风险建议已应用")
    .replace("Auto high-risk learning restarted", "自动高风险学习已重新开始")
    .replace("Credit rules status", "Credit rules 状态")
    .replace("Applying configured credit rules", "正在应用配置的 credit rules")
    .replace("Credit rules repaired and verified", "Credit rules 已修复并验证")
    .replace("Repair skipped because cooldown is active", "修复冷却中，已跳过")
    .replace("Repair skipped because refreshed confirmation did not match", "刷新确认不一致，已跳过修复")
    .replace("Worker paused after repeated inconclusive checks", "多次检查无明确结果，任务已暂停")
    .replace("Captured failure screenshot", "已保存失败截图")
    .replace("Pioneer login page detected", "检测到 Pioneer 登录页")
    .replace("Credit rules text was not found after refresh", "刷新后未找到 credit rules 内容")
    .replace("Rule values do not match configured values", "当前规则值与配置不匹配")
    .replace("Page indicates no active rule", "页面显示没有有效规则")
    .replace("Could not find numeric rule values", "未找到规则数值")
    .replace("No fresh credit rules response matched", "没有匹配到本次刷新的 credit rules 响应");
}

function translateLevel(value) {
  const map = { info: "信息", warn: "警告", error: "错误" };
  return map[value] || value || "未知";
}

function translateEvent(value) {
  const map = {
    config_update: "配置更新",
    auth_start: "开始授权",
    auth_cancel: "取消授权",
    auth_window_closed: "授权窗口关闭",
    auth_timeout: "授权超时",
    auth_verified: "授权验证成功",
    auth_required: "需要授权",
    worker_start: "任务启动",
    worker_stop: "任务停止",
    schedule_sleep: "调度休眠",
    schedule_wake: "调度唤醒",
    schedule_skipped: "跳过调度",
    auto_high_risk_learning_start: "自动学习开始",
    auto_high_risk_completed: "自动学习完成",
    auto_high_risk_applied: "自动建议应用",
    auto_high_risk_insufficient_data: "自动学习样本不足",
    auto_high_risk_restart: "重新学习",
    check_result: "检查结果",
    repair_start: "开始修复",
    repair_success: "修复成功",
    repair_failed: "修复失败",
    repair_cooldown: "修复冷却中",
    repair_not_confirmed: "修复未确认",
    worker_paused: "任务已暂停",
    http_error: "接口错误",
    failure_screenshot: "失败截图"
  };
  return map[value] || value || "未知事件";
}

function translateLearningStatus(value) {
  const map = {
    idle: "未开始",
    learning: "学习中",
    completed: "已完成",
    insufficient_data: "样本不足"
  };
  return map[value] || value || "未知";
}

function translateConfidence(value) {
  const map = { low: "低置信度", medium: "中置信度", high: "高置信度" };
  return map[value] || "暂无置信度";
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function localTime(value) {
  if (!value) return "-";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function setButtonsDisabled(disabled) {
  document.querySelectorAll("button").forEach((button) => { button.disabled = disabled; });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}

function byId(id) {
  return document.getElementById(id);
}

function currentRoute() {
  return `${location.pathname}${location.search}${location.hash}`;
}
