#!/usr/bin/env node

/**
 * CPA 管理中心后端服务
 *
 * 功能：
 *   1. 托管 dashboard.html 静态文件
 *   2. 代理上游 CPA 管理 API（dashboard 不再直连、不暴露 key）
 *   3. 本地优先级数据持久化（JSON 文件）
 *   4. 巡检日志持久化
 *
 * 启动：
 *   node cpa_server.mjs                  # 默认 3456 端口
 *   PORT=8080 node cpa_server.mjs        # 自定义端口
 *
 * 部署：
 *   pm2 start cpa_server.mjs --name cpa-server
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { MANAGEMENT_API_PREFIX } from "./cpa_config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT) || 3456;
const DATA_DIR = process.env.DATA_DIR || __dirname;
let PRIORITY_FILE = join(DATA_DIR, "cpa_priority.json");
let LOG_FILE = join(DATA_DIR, "cpa_logs.json");
let DASHBOARD_CONFIG_FILE = join(DATA_DIR, "cpa_dashboard_config.json");
const MAX_LOGS = 500;

// 确保数据目录存在
import { mkdirSync } from "node:fs";
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {}

// 会话状态（登录时由前端提交，内存持有）
let sessionBase = "";
let sessionKey = "";

// ============================================================
// 多上游配置隔离
// ============================================================

// 根据上游 URL 生成短哈希，用作文件名后缀
function upstreamSlug(baseUrl) {
  return createHash("md5").update(baseUrl).digest("hex").slice(0, 8);
}

// 登录成功后切换到对应上游的数据文件
function updateDataPaths(baseUrl) {
  const slug = upstreamSlug(baseUrl);
  PRIORITY_FILE = join(DATA_DIR, `cpa_priority_${slug}.json`);
  LOG_FILE = join(DATA_DIR, `cpa_logs_${slug}.json`);
  DASHBOARD_CONFIG_FILE = join(DATA_DIR, `cpa_dashboard_config_${slug}.json`);
  console.log(`📂 数据文件命名空间: ${slug} (${baseUrl})`);
}

// ============================================================
// MIME 类型
// ============================================================

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ============================================================
// 工具函数
// ============================================================

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function errorResponse(res, message, status = 500) {
  jsonResponse(res, { error: message }, status);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractToken(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  // 也支持 query 参数（方便简单场景）
  const url = new URL(req.url, `http://localhost:${PORT}`);
  return url.searchParams.get("token") || "";
}

// ============================================================
// 优先级数据
// ============================================================

function loadPriority() {
  try {
    if (existsSync(PRIORITY_FILE)) {
      return JSON.parse(readFileSync(PRIORITY_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function savePriority(data) {
  writeFileSync(PRIORITY_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ============================================================
// 日志数据
// ============================================================

function loadLogs() {
  try {
    if (existsSync(LOG_FILE)) {
      return JSON.parse(readFileSync(LOG_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveLogs(logs) {
  const trimmed = logs.slice(-MAX_LOGS);
  writeFileSync(LOG_FILE, JSON.stringify(trimmed), "utf-8");
}

function appendLog(entry) {
  const logs = loadLogs();

  logs.push(entry);
  saveLogs(logs);
}

// ============================================================
// 面板配置数据
// ============================================================

const DEFAULT_DASHBOARD_CONFIG = {
  target: 5,
  timeout: 30,
  patrolInterval: 180,
  patrolActive: false,
  patrolLastRun: 0,
};

function loadDashboardConfig() {
  try {
    if (existsSync(DASHBOARD_CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(DASHBOARD_CONFIG_FILE, "utf-8"));
      return { ...DEFAULT_DASHBOARD_CONFIG, ...data };
    }
  } catch {}
  return { ...DEFAULT_DASHBOARD_CONFIG };
}

function saveDashboardConfig(data) {
  const merged = { ...loadDashboardConfig(), ...data };
  writeFileSync(
    DASHBOARD_CONFIG_FILE,
    JSON.stringify(merged, null, 2),
    "utf-8",
  );
}

// ============================================================
// 自动管理逻辑（从前端迁移到后端）
// ============================================================

const TOS_VIOLATION_CODE = 403;
const TOS_VIOLATION_REASON = "TOS_VIOLATION";

function parseStatusError(msg) {
  if (!msg) return null;
  try {
    const obj = JSON.parse(msg);
    const err = obj?.error;
    if (!err) return null;
    const reasons = [];
    let validationUrl = "";
    if (Array.isArray(err.details)) {
      for (const d of err.details) {
        if (d.reason) reasons.push(d.reason);
        if (d.metadata?.validation_url)
          validationUrl = d.metadata.validation_url;
      }
    }
    return {
      code: err.code || 0,
      message: err.message || "",
      status: err.status || "",
      reasons,
      validationUrl,
    };
  } catch {
    return null;
  }
}

function shouldDisableAccount(file, parsed) {
  if (!parsed) return false;
  return (
    parsed.code === TOS_VIOLATION_CODE &&
    parsed.reasons.includes(TOS_VIOLATION_REASON)
  );
}

function isCleanDisabled(file) {
  if (!file.disabled && file.status !== "disabled") return false;
  const parsed = parseStatusError(file.status_message);
  if (shouldDisableAccount(file, parsed)) return false;
  return true;
}

function aggregateUsageByAccount(usageData) {
  const map = new Map();
  const apis = usageData?.usage?.apis;
  if (!apis) return map;
  for (const apiData of Object.values(apis)) {
    const models = apiData.models;
    if (!models) continue;
    for (const modelData of Object.values(models)) {
      if (!Array.isArray(modelData.details)) continue;
      for (const record of modelData.details) {
        const email = record.source;
        if (!email) continue;
        let entry = map.get(email);
        if (!entry) {
          entry = { success: 0, failed: 0, tokens: 0 };
          map.set(email, entry);
        }
        if (record.failed) entry.failed++;
        else entry.success++;
        entry.tokens += record.tokens?.total_tokens || 0;
      }
    }
  }
  return map;
}

function sortCleanPool(pool, usageMap = new Map()) {
  const prioMap = loadPriority();
  const filtered = pool.filter((f) => prioMap[f.account] !== "block");
  return filtered.sort((a, b) => {
    const aPrio = prioMap[a.account] === "prefer" ? 1 : 0;
    const bPrio = prioMap[b.account] === "prefer" ? 1 : 0;
    if (bPrio !== aPrio) return bPrio - aPrio;
    const aUsage = usageMap.get(a.account) || { success: 0 };
    const bUsage = usageMap.get(b.account) || { success: 0 };
    if (bUsage.success !== aUsage.success)
      return bUsage.success - aUsage.success;
    const aTime = a.last_refresh ? new Date(a.last_refresh).getTime() : 0;
    const bTime = b.last_refresh ? new Date(b.last_refresh).getTime() : 0;
    return bTime - aTime;
  });
}

// ============================================================
// 后端日志写入
// ============================================================

// 日志缓冲区，避免逐条读写文件
let _serverLogBuffer = [];
let _serverLogFlushTimer = null;

function addLog(text, type = "info") {
  const ts = new Date().toLocaleTimeString();
  _serverLogBuffer.push({ text: `[${ts}] ${text}`, cls: `log-line ${type}` });
  if (!_serverLogFlushTimer) {
    _serverLogFlushTimer = setTimeout(flushServerLogs, 200);
  }
}

function flushServerLogs() {
  _serverLogFlushTimer = null;
  if (_serverLogBuffer.length === 0) return;
  const batch = _serverLogBuffer;
  _serverLogBuffer = [];
  const logs = loadLogs();
  logs.push(...batch);
  saveLogs(logs);
}

// ============================================================
// 巡检定时器（后端驻留，setTimeout 链式调用，无漂移）
// ============================================================

const _patrol = {
  active: false,
  interval: 180,
  lastRunAt: 0,
  nextRunAt: 0,
  timerId: null,
  running: false, // 防止重入
};

function scheduleNextPatrol(delaySec) {
  if (_patrol.timerId) {
    clearTimeout(_patrol.timerId);
    _patrol.timerId = null;
  }
  _patrol.nextRunAt = Date.now() + delaySec * 1000;
  _patrol.timerId = setTimeout(async () => {
    if (!_patrol.active) return;
    _patrol.lastRunAt = Date.now();
    addLog("--- 定时巡检触发 ---", "info");
    try {
      await executeAutoManage();
    } catch (err) {
      addLog(`巡检执行失败: ${err.message}`, "error");
    }
    if (_patrol.active) {
      scheduleNextPatrol(_patrol.interval);
    }
    persistPatrolState();
  }, delaySec * 1000);
}

function persistPatrolState() {
  saveDashboardConfig({
    patrolActive: _patrol.active,
    patrolInterval: _patrol.interval,
    patrolLastRun: _patrol.lastRunAt,
  });
}

function serverStartPatrol(interval) {
  if (!sessionBase || !sessionKey) {
    return { error: "未登录，无法启动巡检" };
  }
  if (_patrol.timerId) {
    clearTimeout(_patrol.timerId);
    _patrol.timerId = null;
  }
  _patrol.active = true;
  _patrol.interval = interval;
  scheduleNextPatrol(interval);
  persistPatrolState();
  addLog(`🔄 定时巡检已开启，间隔 ${interval}s`, "info");
  console.log(`🔄 巡检已开启，间隔 ${interval}s`);
  return { ok: true };
}

function serverStopPatrol() {
  if (_patrol.timerId) {
    clearTimeout(_patrol.timerId);
    _patrol.timerId = null;
  }
  _patrol.active = false;
  _patrol.nextRunAt = 0;
  persistPatrolState();
  addLog("⏹️ 定时巡检已停止", "info");
  console.log("⏹️ 巡检已停止");
  return { ok: true };
}

function getPatrolStatus() {
  const remaining =
    _patrol.active && _patrol.nextRunAt > 0
      ? Math.max(0, Math.floor((_patrol.nextRunAt - Date.now()) / 1000))
      : 0;
  return {
    active: _patrol.active,
    running: _patrol.running,
    interval: _patrol.interval,
    lastRunAt: _patrol.lastRunAt,
    nextRunAt: _patrol.nextRunAt,
    remaining,
  };
}

// 登录成功后尝试恢复巡检
function tryRestorePatrol() {
  const cfg = loadDashboardConfig();
  if (!cfg.patrolActive) return;
  const interval = cfg.patrolInterval || 180;
  const lastRun = cfg.patrolLastRun || 0;
  const elapsed = Math.floor((Date.now() - lastRun) / 1000);
  const remaining = Math.max(interval - elapsed, 0);

  _patrol.active = true;
  _patrol.interval = interval;
  _patrol.lastRunAt = lastRun;

  if (remaining <= 0) {
    addLog(`🔄 恢复巡检，已超时 ${elapsed - interval}s，立即执行`, "info");
    scheduleNextPatrol(1); // 1 秒后执行，避免阻塞登录响应
  } else {
    addLog(`🔄 恢复巡检，${remaining}s 后执行下次`, "info");
    scheduleNextPatrol(remaining);
  }
  console.log(
    `🔄 巡检已恢复，${remaining > 0 ? remaining + "s 后执行" : "即将执行"}`,
  );
}

// 自动管理核心执行（含重入保护）
async function executeAutoManage() {
  if (_patrol.running) {
    addLog("⚠️ 自动管理正在执行中，跳过本次调用", "warn");
    return;
  }
  _patrol.running = true;

  const cfg = loadDashboardConfig();
  const target = cfg.target || 5;

  addLog("===== 开始自动管理 =====", "info");
  try {
    // 1. 获取最新数据
    const result1 = await proxyUpstream("GET", "/auth-files");
    if (result1.status !== 200)
      throw new Error(`获取凭证失败: HTTP ${result1.status}`);
    let allFiles = result1.data?.files ?? [];
    const enabled = allFiles.filter(
      (f) => !f.disabled && f.status !== "disabled",
    );

    // 2. 禁用 TOS_VIOLATION
    for (const f of enabled) {
      const parsed = parseStatusError(f.status_message);
      if (shouldDisableAccount(f, parsed)) {
        try {
          await proxyUpstream("PATCH", "/auth-files/status", {
            name: f.name,
            disabled: true,
          });
          addLog(`🚫 已禁用(TOS): ${f.account}`, "warn");
        } catch (err) {
          addLog(`❌ 禁用失败: ${f.account} - ${err.message}`, "error");
        }
      }
    }

    // 2.5 获取使用统计
    let usageMap = new Map();
    try {
      const usageResult = await proxyUpstream("GET", "/usage");
      if (usageResult.status === 200) {
        usageMap = aggregateUsageByAccount(usageResult.data);
        addLog(`📊 已加载使用统计 (${usageMap.size} 个账号有记录)`, "info");
      }
    } catch {
      addLog("⚠️ 获取使用统计失败，将仅按 last_refresh 排序", "warn");
    }

    // 3. 重新获取最新数据
    const result2 = await proxyUpstream("GET", "/auth-files");
    allFiles = result2.data?.files ?? [];
    const currentEnabled = allFiles.filter(
      (f) => !f.disabled && f.status !== "disabled",
    );
    const cleanPool = sortCleanPool(allFiles.filter(isCleanDisabled), usageMap);

    // 4. 维持目标数
    if (currentEnabled.length < target && cleanPool.length > 0) {
      const needed = Math.min(target - currentEnabled.length, cleanPool.length);
      addLog(
        `🔄 启用 ${needed} 个候补账号 (当前 ${currentEnabled.length} → 目标 ${target})`,
        "info",
      );
      for (let i = 0; i < needed; i++) {
        try {
          await proxyUpstream("PATCH", "/auth-files/status", {
            name: cleanPool[i].name,
            disabled: false,
          });
          addLog(`✅ 已启用: ${cleanPool[i].account}`, "success");
        } catch (err) {
          addLog(
            `❌ 启用失败: ${cleanPool[i].account} - ${err.message}`,
            "error",
          );
        }
      }
    } else if (currentEnabled.length > target) {
      const excess = currentEnabled.length - target;
      const errors = currentEnabled.filter((f) => f.status === "error");
      const healthy = currentEnabled.filter((f) => f.status !== "error");
      const toDeactivate = [...errors, ...healthy].slice(0, excess);
      addLog(
        `⏸️ 禁用 ${toDeactivate.length} 个多余账号 (当前 ${currentEnabled.length} → 目标 ${target})`,
        "info",
      );
      for (const f of toDeactivate) {
        try {
          await proxyUpstream("PATCH", "/auth-files/status", {
            name: f.name,
            disabled: true,
          });
          addLog(`⏸️ 已禁用: ${f.account}`, "warn");
        } catch (err) {
          addLog(`❌ 禁用失败: ${f.account} - ${err.message}`, "error");
        }
      }
    } else {
      addLog(
        `✅ 当前启用 ${currentEnabled.length} 个，符合目标 ${target} 个`,
        "success",
      );
    }

    addLog("===== 自动管理完成 =====", "success");
  } catch (err) {
    addLog(`自动管理失败: ${err.message}`, "error");
  } finally {
    _patrol.running = false;
    // 确保日志缓冲立即落盘
    flushServerLogs();
  }
}

// ============================================================
// 上游 API 代理
// ============================================================

async function proxyUpstream(method, endpoint, body) {
  if (!sessionBase || !sessionKey) {
    throw new Error("未登录，无法代理请求");
  }
  const url =
    sessionBase.replace(/\/+$/, "") + MANAGEMENT_API_PREFIX + endpoint;
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionKey}`,
    },
  };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: resp.status, data };
}

// ============================================================
// 路由处理
// ============================================================

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method?.toUpperCase();

  // CORS 预检
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // ---- 鉴权验证端点 ----
  if (path === "/auth/verify") {
    if (method === "POST") {
      const body = await readBody(req);
      const base = body?.base?.replace(/\/+$/, "");
      const key = body?.key;
      if (!base || !key) {
        return errorResponse(res, "请提供地址和密钥", 400);
      }
      try {
        // 实际连接上游验证凭据是否有效
        const testUrl = base + MANAGEMENT_API_PREFIX + "/config";
        const testResp = await fetch(testUrl, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
        });
        if (testResp.ok) {
          sessionBase = base;
          sessionKey = key;
          updateDataPaths(base);
          tryRestorePatrol();
          console.log(`✅ 登录成功，上游: ${base}`);
          return jsonResponse(res, { ok: true });
        }
        return errorResponse(res, "地址或密钥无效", 401);
      } catch (err) {
        return errorResponse(res, `连接失败: ${err.message}`, 502);
      }
    }
    return errorResponse(res, "Method not allowed", 405);
  }

  // ---- API / 本地接口需要鉴权 ----
  if (path.startsWith("/api/") || path.startsWith("/local/")) {
    const token = extractToken(req);
    if (!sessionKey || token !== sessionKey) {
      return errorResponse(res, "未授权，请先登录", 401);
    }
  }

  // ---- 本地 API：优先级 ----
  if (path === "/local/priority") {
    if (method === "GET") {
      return jsonResponse(res, loadPriority());
    }
    if (method === "PUT") {
      const body = await readBody(req);
      savePriority(body || {});
      return jsonResponse(res, { ok: true });
    }
    return errorResponse(res, "Method not allowed", 405);
  }

  // ---- 本地 API：日志 ----
  if (path === "/local/logs") {
    if (method === "GET") {
      return jsonResponse(res, loadLogs());
    }
    if (method === "POST") {
      const body = await readBody(req);
      if (body) {
        // 兼容批量数组和单条对象
        const entries = Array.isArray(body) ? body : [body];
        const logs = loadLogs();
        logs.push(...entries);
        saveLogs(logs);
      }
      return jsonResponse(res, { ok: true });
    }
    if (method === "DELETE") {
      saveLogs([]);
      return jsonResponse(res, { ok: true });
    }
    return errorResponse(res, "Method not allowed", 405);
  }

  // ---- 本地 API：面板配置 ----
  if (path === "/local/config") {
    if (method === "GET") {
      return jsonResponse(res, loadDashboardConfig());
    }
    if (method === "PUT") {
      const body = await readBody(req);
      saveDashboardConfig(body || {});
      return jsonResponse(res, { ok: true });
    }
    return errorResponse(res, "Method not allowed", 405);
  }

  // ---- 本地 API：巡检控制 ----
  if (path.startsWith("/local/patrol")) {
    if (path === "/local/patrol/status" && method === "GET") {
      return jsonResponse(res, getPatrolStatus());
    }
    if (path === "/local/patrol/start" && method === "POST") {
      const body = await readBody(req);
      const interval =
        body?.interval || loadDashboardConfig().patrolInterval || 180;
      const result = serverStartPatrol(interval);
      if (result.error) return errorResponse(res, result.error, 400);
      return jsonResponse(res, result);
    }
    if (path === "/local/patrol/stop" && method === "POST") {
      return jsonResponse(res, serverStopPatrol());
    }
    if (path === "/local/patrol/run" && method === "POST") {
      if (!sessionBase || !sessionKey) {
        return errorResponse(res, "未登录", 401);
      }
      try {
        await executeAutoManage();
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return errorResponse(res, err.message, 500);
      }
    }
    return errorResponse(res, "Method not allowed", 405);
  }

  // ---- 上游 API 代理 (/api/*) ----
  if (path.startsWith("/api/")) {
    const endpoint = path.slice(4); // '/api/auth-files' → '/auth-files'
    try {
      const body = ["POST", "PUT", "PATCH"].includes(method)
        ? await readBody(req)
        : undefined;
      const result = await proxyUpstream(method, endpoint, body);
      return jsonResponse(res, result.data, result.status);
    } catch (err) {
      return errorResponse(res, `代理请求失败: ${err.message}`, 502);
    }
  }

  // ---- 静态文件 ----
  let filePath = path === "/" ? "/dashboard.html" : path;
  const fullPath = join(__dirname, filePath);

  // 安全检查：防止目录穿越
  if (!fullPath.startsWith(__dirname)) {
    return errorResponse(res, "Forbidden", 403);
  }

  try {
    const content = readFileSync(fullPath);
    const ext = extname(fullPath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    errorResponse(res, "Not found", 404);
  }
}

// ============================================================
// 启动服务器
// ============================================================

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`🚀 CPA 管理中心后端已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   优先级文件: ${PRIORITY_FILE}`);
  console.log(`   日志文件: ${LOG_FILE}`);
  console.log("");
  console.log(`📌 在浏览器中打开 http://localhost:${PORT}`);
});
