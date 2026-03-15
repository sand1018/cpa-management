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
import { MANAGEMENT_API_PREFIX } from "./cpa_config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT) || 3456;
const PRIORITY_FILE = join(__dirname, "cpa_priority.json");
const LOG_FILE = join(__dirname, "cpa_logs.json");
const DASHBOARD_CONFIG_FILE = join(__dirname, "cpa_dashboard_config.json");
const MAX_LOGS = 500;

// 会话状态（登录时由前端提交，内存持有）
let sessionBase = "";
let sessionKey = "";

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
      const entry = await readBody(req);
      if (entry) appendLog(entry);
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
