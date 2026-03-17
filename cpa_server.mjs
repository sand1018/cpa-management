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
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
  writeFile(PRIORITY_FILE, JSON.stringify(data, null, 2), "utf-8").catch(
    () => {},
  );
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
  writeFile(LOG_FILE, JSON.stringify(trimmed), "utf-8").catch(() => {});
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
  writeFile(
    DASHBOARD_CONFIG_FILE,
    JSON.stringify(merged, null, 2),
    "utf-8",
  ).catch(() => {});
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
// 日志缓冲：slug → entries[]，支持多上游独立写入
const _logBuffers = new Map();
let _serverLogFlushTimer = null;

function addLog(text, type = "info", slug) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const entry = { text: `[${ts}] ${text}`, cls: `log-line ${type}` };
  // 无 slug 时写到当前 session 的日志
  const key = slug || "_current";
  if (!_logBuffers.has(key)) _logBuffers.set(key, []);
  _logBuffers.get(key).push(entry);
  if (!_serverLogFlushTimer) {
    _serverLogFlushTimer = setTimeout(flushServerLogs, 200);
  }
}

function flushServerLogs() {
  _serverLogFlushTimer = null;
  for (const [key, batch] of _logBuffers) {
    if (batch.length === 0) continue;
    // 确定写入哪个日志文件
    const logFile =
      key === "_current" ? LOG_FILE : join(DATA_DIR, `cpa_logs_${key}.json`);
    let logs = [];
    try {
      if (existsSync(logFile)) {
        logs = JSON.parse(readFileSync(logFile, "utf-8"));
      }
    } catch {}
    logs.push(...batch);
    const trimmed = logs.slice(-MAX_LOGS);
    writeFile(logFile, JSON.stringify(trimmed), "utf-8").catch(() => {});
  }
  _logBuffers.clear();
}

// ============================================================
// 巡检管理器（每个上游一个实例，独立定时器）
// ============================================================

const MIN_PATROL_INTERVAL = 30;
const _patrols = new Map(); // slug → PatrolManager

function getOrCreatePatrol(slug) {
  if (!_patrols.has(slug)) {
    _patrols.set(slug, new PatrolManager(slug));
  }
  return _patrols.get(slug);
}

class PatrolManager {
  constructor(slug) {
    this.slug = slug;
    this.base = "";
    this.key = "";
    this.active = false;
    this.interval = 180;
    this.lastRunAt = 0;
    this.nextRunAt = 0;
    this.timerId = null;
    this.running = false;
  }

  // 日志（自动路由到对应上游的日志文件）
  log(text, type = "info") {
    addLog(text, type, this.slug);
  }

  // 上游 API 请求（使用实例自带的凭据）
  async request(method, endpoint, body) {
    const url =
      this.base.replace(/\/+$/, "") + MANAGEMENT_API_PREFIX + endpoint;
    const options = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.key}`,
      },
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const resp = await fetch(url, options);
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    // 非 2xx 状态码视为失败，抛出异常以便调用方 catch 捕获
    if (resp.status < 200 || resp.status >= 300) {
      const errMsg =
        (typeof data === "object" && (data?.error || data?.message)) ||
        `HTTP ${resp.status}`;
      throw new Error(errMsg);
    }
    return { status: resp.status, data };
  }

  // 读取本实例对应的面板配置
  loadConfig() {
    const file = join(DATA_DIR, `cpa_dashboard_config_${this.slug}.json`);
    try {
      if (existsSync(file)) {
        return {
          ...DEFAULT_DASHBOARD_CONFIG,
          ...JSON.parse(readFileSync(file, "utf-8")),
        };
      }
    } catch {}
    return { ...DEFAULT_DASHBOARD_CONFIG };
  }

  // 持久化巡检状态
  persist() {
    const file = join(DATA_DIR, `cpa_dashboard_config_${this.slug}.json`);
    let existing = {};
    try {
      if (existsSync(file)) existing = JSON.parse(readFileSync(file, "utf-8"));
    } catch {}
    const merged = {
      ...DEFAULT_DASHBOARD_CONFIG,
      ...existing,
      patrolActive: this.active,
      patrolInterval: this.interval,
      patrolLastRun: this.lastRunAt,
    };
    writeFile(file, JSON.stringify(merged, null, 2), "utf-8").catch(() => {});
  }

  // 调度下次巡检
  schedule(delaySec) {
    if (this.timerId) clearTimeout(this.timerId);
    this.nextRunAt = Date.now() + delaySec * 1000;
    this.timerId = setTimeout(async () => {
      if (!this.active) return;
      this.lastRunAt = Date.now();
      this.log("--- 定时巡检触发 ---");
      try {
        await this.execute();
      } catch (err) {
        this.log(`巡检执行失败: ${err.message}`, "error");
      }
      if (this.active) this.schedule(this.interval);
      this.persist();
    }, delaySec * 1000);
  }

  // 启动巡检
  start(base, key, interval) {
    if (this.timerId) clearTimeout(this.timerId);
    this.base = base;
    this.key = key;
    this.active = true;
    this.interval = Math.max(interval, MIN_PATROL_INTERVAL);
    this.schedule(this.interval);
    this.persist();
    this.log(`🔄 定时巡检已开启，间隔 ${this.interval}s`);
    console.log(`🔄 巡检已开启，间隔 ${this.interval}s [${this.slug}]`);
    return { ok: true };
  }

  // 停止巡检
  stop() {
    if (this.timerId) clearTimeout(this.timerId);
    this.timerId = null;
    this.active = false;
    this.nextRunAt = 0;
    this.persist();
    this.log("⏹️ 定时巡检已停止");
    console.log(`⏹️ 巡检已停止 [${this.slug}]`);
    return { ok: true };
  }

  // 获取状态
  status() {
    const remaining =
      this.active && this.nextRunAt > 0
        ? Math.max(0, Math.floor((this.nextRunAt - Date.now()) / 1000))
        : 0;
    return {
      active: this.active,
      running: this.running,
      interval: this.interval,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt,
      remaining,
    };
  }

  // 登录后恢复巡检
  restore(base, key) {
    this.base = base;
    this.key = key;
    const cfg = this.loadConfig();
    if (!cfg.patrolActive) return;

    const interval = Math.max(cfg.patrolInterval || 180, MIN_PATROL_INTERVAL);
    const lastRun = cfg.patrolLastRun || 0;
    const elapsed = Math.floor((Date.now() - lastRun) / 1000);
    const remaining = Math.max(interval - elapsed, 0);

    if (this.timerId) clearTimeout(this.timerId);
    this.active = true;
    this.interval = interval;
    this.lastRunAt = lastRun;

    if (remaining <= 0) {
      this.log(`🔄 恢复巡检，已超时 ${elapsed - interval}s，立即执行`);
      this.schedule(1);
    } else {
      this.log(`🔄 恢复巡检，${remaining}s 后执行下次`);
      this.schedule(remaining);
    }
    console.log(
      `🔄 巡检已恢复 [${this.slug}]，${remaining > 0 ? remaining + "s 后执行" : "即将执行"}`,
    );
  }

  // 自动管理核心执行
  async execute() {
    if (this.running) {
      this.log("⚠️ 自动管理正在执行中，跳过本次调用", "warn");
      return;
    }
    this.running = true;
    const target = this.loadConfig().target || 5;

    this.log("===== 开始自动管理 =====");
    try {
      // 1. 获取最新数据
      const r1 = await this.request("GET", "/auth-files");
      let allFiles = r1.data?.files ?? [];
      const enabled = allFiles.filter(
        (f) => !f.disabled && f.status !== "disabled",
      );

      // 2. 并发禁用 TOS_VIOLATION
      const tosTargets = enabled.filter((f) => {
        const parsed = parseStatusError(f.status_message);
        return shouldDisableAccount(f, parsed);
      });
      if (tosTargets.length > 0) {
        const tosResults = await Promise.allSettled(
          tosTargets.map((f) =>
            this.request("PATCH", "/auth-files/status", {
              name: f.name,
              disabled: true,
            }).then(() => f),
          ),
        );
        let tosOk = 0,
          tosFail = 0;
        for (const r of tosResults) {
          if (r.status === "fulfilled") {
            tosOk++;
            this.log(`🚫 已禁用(TOS): ${r.value.account}`, "warn");
          } else {
            tosFail++;
            this.log(`❌ 禁用失败: ${r.reason?.message || r.reason}`, "error");
          }
        }
        this.log(
          `TOS 禁用汇总: ${tosOk} 成功, ${tosFail} 失败`,
          tosFail > 0 ? "error" : "success",
        );
      }

      // 2.5 获取使用统计
      let usageMap = new Map();
      try {
        const ur = await this.request("GET", "/usage");
        usageMap = aggregateUsageByAccount(ur.data);
        this.log(`📊 已加载使用统计 (${usageMap.size} 个账号有记录)`);
      } catch {
        this.log("⚠️ 获取使用统计失败，将仅按 last_refresh 排序", "warn");
      }

      // 3. 重新获取最新数据
      const r2 = await this.request("GET", "/auth-files");
      allFiles = r2.data?.files ?? [];
      const currentEnabled = allFiles.filter(
        (f) => !f.disabled && f.status !== "disabled",
      );
      const cleanPool = sortCleanPool(
        allFiles.filter(isCleanDisabled),
        usageMap,
      );

      // 4. 维持目标数
      if (currentEnabled.length < target && cleanPool.length > 0) {
        const needed = Math.min(
          target - currentEnabled.length,
          cleanPool.length,
        );
        this.log(
          `🔄 启用 ${needed} 个候补账号 (当前 ${currentEnabled.length} → 目标 ${target})`,
        );
        const enTargets = cleanPool.slice(0, needed);
        const enResults = await Promise.allSettled(
          enTargets.map((f) =>
            this.request("PATCH", "/auth-files/status", {
              name: f.name,
              disabled: false,
            }).then(() => f),
          ),
        );
        let enOk = 0,
          enFail = 0;
        for (const r of enResults) {
          if (r.status === "fulfilled") {
            enOk++;
            this.log(`✅ 已启用: ${r.value.account}`, "success");
          } else {
            enFail++;
            this.log(`❌ 启用失败: ${r.reason?.message || r.reason}`, "error");
          }
        }
        this.log(
          `启用候补汇总: ${enOk} 成功, ${enFail} 失败`,
          enFail > 0 ? "error" : "success",
        );
      } else if (currentEnabled.length > target) {
        const excess = currentEnabled.length - target;
        const errors = currentEnabled.filter((f) => f.status === "error");
        const toDeactivate = errors.slice(0, excess);
        if (toDeactivate.length > 0) {
          this.log(
            `⏸️ 禁用 ${toDeactivate.length} 个错误账号 (当前 ${currentEnabled.length} → 目标 ${target})`,
          );
          const deResults = await Promise.allSettled(
            toDeactivate.map((f) =>
              this.request("PATCH", "/auth-files/status", {
                name: f.name,
                disabled: true,
              }).then(() => f),
            ),
          );
          let deOk = 0,
            deFail = 0;
          for (const r of deResults) {
            if (r.status === "fulfilled") {
              deOk++;
              this.log(`⏸️ 已禁用: ${r.value.account}`, "warn");
            } else {
              deFail++;
              this.log(
                `❌ 禁用失败: ${r.reason?.message || r.reason}`,
                "error",
              );
            }
          }
          this.log(
            `超额禁用汇总: ${deOk} 成功, ${deFail} 失败`,
            deFail > 0 ? "error" : "success",
          );
        }
        if (toDeactivate.length < excess) {
          this.log(
            `⚠️ 仍超出目标 ${excess - toDeactivate.length} 个，但剩余均为健康账号，不自动禁用`,
            "warn",
          );
        }
      } else if (currentEnabled.length < target) {
        this.log(
          `⚠️ 当前启用 ${currentEnabled.length} 个，不足目标 ${target} 个，且无可用候补账号`,
          "warn",
        );
      } else {
        this.log(
          `✅ 当前启用 ${currentEnabled.length} 个，符合目标 ${target} 个`,
          "success",
        );
      }

      this.log("===== 自动管理完成 =====", "success");
    } catch (err) {
      this.log(`自动管理失败: ${err.message}`, "error");
    } finally {
      this.running = false;
      flushServerLogs();
    }
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
          const patrol = getOrCreatePatrol(upstreamSlug(base));
          patrol.restore(base, key);
          console.log(`✅ 登录成功，上游: ${base} [${patrol.slug}]`);
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
    const patrol = getOrCreatePatrol(upstreamSlug(sessionBase));
    if (path === "/local/patrol/status" && method === "GET") {
      return jsonResponse(res, patrol.status());
    }
    if (path === "/local/patrol/start" && method === "POST") {
      const body = await readBody(req);
      const interval =
        body?.interval || patrol.loadConfig().patrolInterval || 180;
      const result = patrol.start(sessionBase, sessionKey, interval);
      if (result.error) return errorResponse(res, result.error, 400);
      return jsonResponse(res, result);
    }
    if (path === "/local/patrol/stop" && method === "POST") {
      return jsonResponse(res, patrol.stop());
    }
    if (path === "/local/patrol/run" && method === "POST") {
      if (!sessionBase || !sessionKey) {
        return errorResponse(res, "未登录", 401);
      }
      patrol.base = sessionBase;
      patrol.key = sessionKey;
      try {
        await patrol.execute();
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

      // 对关键操作记录日志
      if (method === "PATCH" && endpoint === "/auth-files/status" && body) {
        const name = body.name || "未知";
        if (result.status >= 200 && result.status < 300) {
          addLog(
            body.disabled ? `⏸️ 手动禁用: ${name}` : `✅ 手动启用: ${name}`,
            body.disabled ? "warn" : "success",
          );
        } else {
          addLog(
            `❌ ${body.disabled ? "禁用" : "启用"}失败: ${name} (HTTP ${result.status})`,
            "error",
          );
        }
      } else if (method === "DELETE" && endpoint.startsWith("/auth-files")) {
        const delName = url.searchParams.get("name") || "未知";
        if (result.status >= 200 && result.status < 300) {
          addLog(`🗑️ 已删除凭证: ${delName}`, "warn");
        } else {
          addLog(`❌ 删除失败: ${delName} (HTTP ${result.status})`, "error");
        }
      }

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
