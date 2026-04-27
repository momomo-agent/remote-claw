#!/usr/bin/env node
// RemoteClaw Relay — VPS Node.js WebSocket relay
// Replaces Cloudflare Durable Objects (which suffer 2-6s hibernation stalls
// on binary message relay). Runs on a fixed VPS, no hibernation, no
// eviction — latency = actual network RTT.
//
// 1:1 compatible with the CF Worker protocol so daemon/app don't need changes
// other than swapping wss:// endpoint.
//
// Binary frame format:
//   [op:1][reqId:4][peerLen:1][peer:peerLen][payload...]
// Relay rewrites "peer" to the sender's deviceId on forward, so the other
// side sees who it's talking to (same as CF).
//
// JSON messages with `to` field are forwarded to that device by lookup in
// (devices ∪ clients). Relay adds `from: senderDeviceId` on forward.

"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const WebSocket = require("ws");
const Database = require("better-sqlite3");

// ── Config ──
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.REMOTECLAW_TOKEN || "rclaw-4847bbe08bda2c785f4e4e6bc05e4815";
const DB_PATH = process.env.DB_PATH || "/var/lib/remoteclaw/relay.db";
const TRANSFER_TTL_MS = 5 * 60 * 1000;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── DB ──
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,
    filename TEXT,
    total_size INTEGER,
    chunks INTEGER DEFAULT 0,
    created_at INTEGER,
    expires_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS transfer_chunks (
    transfer_id TEXT,
    chunk_index INTEGER,
    data TEXT,
    PRIMARY KEY (transfer_id, chunk_index)
  );
  CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    device TEXT,
    command TEXT,
    status TEXT,
    stdout TEXT,
    stderr TEXT,
    exit_code INTEGER,
    created_at INTEGER,
    completed_at INTEGER,
    duration INTEGER
  );
`);

const stmts = {
  insertTransfer: db.prepare(`INSERT INTO transfers (id, filename, total_size, chunks, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)`),
  upsertChunk:    db.prepare(`INSERT OR REPLACE INTO transfer_chunks (transfer_id, chunk_index, data) VALUES (?, ?, ?)`),
  bumpChunk:      db.prepare(`UPDATE transfers SET chunks = chunks + 1 WHERE id = ?`),
  getTransfer:    db.prepare(`SELECT * FROM transfers WHERE id = ?`),
  getChunk:       db.prepare(`SELECT data FROM transfer_chunks WHERE transfer_id = ? AND chunk_index = ?`),
  delExpiredTr:   db.prepare(`DELETE FROM transfers WHERE expires_at < ?`),
  delExpiredCh:   db.prepare(`DELETE FROM transfer_chunks WHERE transfer_id IN (SELECT id FROM transfers WHERE expires_at < ?)`),
  upsertHistory:  db.prepare(`INSERT OR REPLACE INTO history (id, device, command, status, stdout, stderr, exit_code, created_at, completed_at, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  listHistory:    db.prepare(`SELECT id, device, command, status, exit_code, created_at, completed_at, duration FROM history ORDER BY created_at DESC LIMIT ?`),
  pruneHistory:   db.prepare(`DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY created_at DESC LIMIT 500)`),
};

// Cleanup expired transfers every 5 min
setInterval(() => {
  const n = Date.now();
  stmts.delExpiredCh.run(n);
  stmts.delExpiredTr.run(n);
}, 5 * 60 * 1000).unref();

// ── State ──
/** Map<deviceId, ws>   role=device (daemon side). */
const devices = new Map();
/** Map<clientId, ws>   role=client (app side). */
const clients = new Set();
/** Per-ws meta. */
const meta = new WeakMap();
/** Map<taskId, Task>   in-memory running tasks, persisted to SQLite on done. */
const tasks = new Map();
/** Map<taskId, Function> resolvers for /exec oneshot mode. */
const taskResolvers = new Map();

function now() { return Date.now(); }
function uid() { return crypto.randomUUID(); }
function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }

function peerSocket(id) {
  return devices.get(id) || (function () {
    for (const c of clients) { const m = meta.get(c); if (m && m.id === id) return c; }
    return null;
  })();
}

function broadcastDevicesAll() {
  const payload = JSON.stringify({ type: "devices", devices: Array.from(devices.keys()) });
  for (const ws of clients) { if (ws.readyState === ws.OPEN) { try { ws.send(payload); } catch {} } }
  for (const ws of devices.values()) { if (ws.readyState === ws.OPEN) { try { ws.send(payload); } catch {} } }
}

// ── HTTP ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      devices: devices.size,
      clients: clients.size,
      tasks: tasks.size,
      uptime: Math.round(process.uptime()),
      mem: process.memoryUsage().rss,
    });
  }

  // Auth
  const bearer = (req.headers.authorization || "").startsWith("Bearer ")
    ? req.headers.authorization.slice(7) : null;
  const qtoken = url.searchParams.get("token");
  const authed = (bearer && bearer === TOKEN) || (qtoken && qtoken === TOKEN);
  if (!authed) { res.writeHead(401); return res.end("unauthorized"); }

  // GET /devices
  if (url.pathname === "/devices" && req.method === "GET") {
    const list = Array.from(devices.entries()).map(([id, ws]) => {
      const m = meta.get(ws) || {};
      return {
        id, name: m.name || id,
        connectedAt: m.connectedAt || now(),
        connectedFor: Math.round((now() - (m.connectedAt || now())) / 1000),
      };
    });
    return sendJson(res, 200, list);
  }

  // POST /exec
  if (url.pathname === "/exec" && req.method === "POST") {
    const body = await readJson(req);
    if (!body.device || !body.command) return sendJson(res, 400, { error: "device/command required" });
    const conn = devices.get(body.device);
    if (!conn) return sendJson(res, 404, { error: "device not connected" });

    const task = {
      id: uid(), device: body.device, command: body.command,
      status: "pending", stdout: "", stderr: "", exitCode: null,
      createdAt: now(), completedAt: null,
    };
    tasks.set(task.id, task);
    try { conn.send(JSON.stringify({ type: "exec", taskId: task.id, command: body.command })); } catch {}
    task.status = "running";

    const timeout = body.timeout || 30000;

    if (body.oneshot) {
      const result = await Promise.race([
        new Promise((resolve) => taskResolvers.set(task.id, resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
      ]).catch(() => {
        task.status = "timeout"; task.completedAt = now(); return task;
      });
      taskResolvers.delete(task.id);
      saveHistory(result);
      return sendJson(res, 200, result);
    }

    // Async mode
    setTimeout(() => {
      const t = tasks.get(task.id);
      if (t && t.status === "running") {
        t.status = "timeout"; t.completedAt = now();
        const r = taskResolvers.get(task.id);
        if (r) { r(t); taskResolvers.delete(task.id); }
        saveHistory(t);
      }
    }, timeout).unref();
    return sendJson(res, 200, { taskId: task.id, status: "running" });
  }

  // GET /task/:id
  const taskMatch = url.pathname.match(/^\/task\/(.+)$/);
  if (taskMatch && req.method === "GET") {
    const t = tasks.get(taskMatch[1]);
    if (!t) return sendJson(res, 404, { error: "task not found" });
    return sendJson(res, 200, t);
  }

  // GET /history
  if (url.pathname === "/history" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const rows = stmts.listHistory.all(limit);
    return sendJson(res, 200, rows.map(r => ({
      id: r.id, device: r.device, command: r.command, status: r.status,
      exitCode: r.exit_code, createdAt: r.created_at, completedAt: r.completed_at, duration: r.duration,
    })));
  }

  // POST /transfer/upload
  if (url.pathname === "/transfer/upload" && req.method === "POST") {
    const body = await readJson(req);
    let transferId = body.transferId;
    if (!transferId) {
      transferId = uid();
      stmts.insertTransfer.run(transferId, body.filename || "", body.totalSize || 0, now(), now() + TRANSFER_TTL_MS);
    }
    stmts.upsertChunk.run(transferId, body.chunkIndex, body.chunk);
    stmts.bumpChunk.run(transferId);
    const row = stmts.getTransfer.get(transferId);
    const done = row && row.chunks >= (body.totalChunks || 0);
    return sendJson(res, 200, { transferId, chunksReceived: row?.chunks || 0, done });
  }

  // GET /transfer/info/:id
  const infoMatch = url.pathname.match(/^\/transfer\/info\/(.+)$/);
  if (infoMatch && req.method === "GET") {
    const row = stmts.getTransfer.get(infoMatch[1]);
    if (!row) return sendJson(res, 404, { error: "transfer not found" });
    return sendJson(res, 200, row);
  }

  // GET /transfer/download/:id?chunk=N
  const dlMatch = url.pathname.match(/^\/transfer\/download\/(.+)$/);
  if (dlMatch && req.method === "GET") {
    const chunkIdx = parseInt(url.searchParams.get("chunk") || "0");
    const row = stmts.getChunk.get(dlMatch[1], chunkIdx);
    if (!row) return sendJson(res, 404, { error: "chunk not found" });
    return sendJson(res, 200, { chunk: row.data, chunkIndex: chunkIdx });
  }

  // POST /transfer/push — ask device to upload a file from its disk
  if (url.pathname === "/transfer/push" && req.method === "POST") {
    const body = await readJson(req);
    const conn = devices.get(body.device);
    if (!conn) return sendJson(res, 404, { error: "device not connected" });
    const transferId = uid();
    try { conn.send(JSON.stringify({ type: "file-upload", transferId, path: body.remotePath })); } catch {}
    return sendJson(res, 200, { transferId, status: "requested" });
  }

  res.writeHead(404); res.end("not found");
});

// ── WebSocket ──
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") { socket.destroy(); return; }
  const token = url.searchParams.get("token");
  if (token !== TOKEN) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
  const name = url.searchParams.get("device") || url.searchParams.get("client") || "";
  const role = url.searchParams.get("role") || (name ? "device" : "client");
  // Clients may pass client=XXX — generate one if none.
  const id = role === "client" ? (name || "c-" + crypto.randomBytes(4).toString("hex")) : name;
  if (!id) { socket.write("HTTP/1.1 400 Bad Request\r\n\r\nid required"); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => onWs(ws, id, role, name));
});

function onWs(ws, id, role, name) {
  const info = { id, role, name: name || id, connectedAt: now(), bytesIn: 0, bytesOut: 0, lastSeen: now() };
  meta.set(ws, info);

  if (role === "device") {
    const prev = devices.get(id);
    if (prev && prev !== ws) { try { prev.close(4000, "replaced"); } catch {} }
    devices.set(id, ws);
    log(`device CONNECT id=${id} total=${devices.size}`);
  } else {
    clients.add(ws);
    log(`client CONNECT id=${id} total=${clients.size}`);
  }
  broadcastDevicesAll();

  ws.on("message", (data, isBinary) => {
    info.lastSeen = now();
    info.bytesIn += data.length || data.byteLength || 0;
    if (isBinary) return handleBinary(ws, info, data);
    return handleJson(ws, info, data);
  });
  ws.on("close", (code) => {
    if (role === "device" && devices.get(id) === ws) {
      devices.delete(id);
      log(`device CLOSE  id=${id} code=${code} total=${devices.size}`);
      broadcastDevicesAll();
    } else if (role !== "device") {
      clients.delete(ws);
      log(`client CLOSE  id=${id} code=${code} total=${clients.size}`);
    }
    meta.delete(ws);
  });
  ws.on("error", (e) => log(`ws error id=${id}: ${e.message}`));
}

// ── Binary frame routing (CF-compatible) ──
// Rewrite peer→sender on forward. Byte layout:
//   [op:1][reqId:4][peerLen:1][peer:peerLen][payload...]
function handleBinary(srcWs, srcInfo, buf) {
  if (buf.length < 6) return;
  const peerLen = buf[5];
  if (buf.length < 6 + peerLen) return;
  const peer = buf.slice(6, 6 + peerLen).toString("utf-8");

  const target = peerSocket(peer);
  if (!target || target === srcWs || target.readyState !== target.OPEN) return;

  // Rewrite peer to srcInfo.id so the receiver knows who sent this.
  const fromBytes = Buffer.from(srcInfo.id, "utf-8");
  const out = Buffer.alloc(6 + fromBytes.length + (buf.length - 6 - peerLen));
  buf.copy(out, 0, 0, 5);               // op + reqId
  out[5] = fromBytes.length;
  fromBytes.copy(out, 6);
  buf.copy(out, 6 + fromBytes.length, 6 + peerLen);   // payload

  const tmeta = meta.get(target); if (tmeta) tmeta.bytesOut += out.length;
  try { target.send(out, { binary: true }); } catch {}
}

// ── JSON routing ──
const RELAY_JSON_TYPES = new Set([
  "file-start", "file-chunk", "file-end", "file-error", "file-upload",
  "shell-open", "shell-input", "shell-resize", "shell-close", "shell-data", "shell-exit",
  "screen-start", "screen-stop", "screen-input", "screen-frame",
  "http-proxy-request", "http-proxy-response",
  "ws-proxy-open", "ws-proxy-data", "ws-proxy-close",
  "exec", "stdin",
]);

function handleJson(srcWs, srcInfo, data) {
  let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
  const type = msg.type;

  // Hello: clients can set a friendly name
  if (type === "hello") {
    if (msg.name) srcInfo.name = String(msg.name);
    return;
  }

  if (type === "ping") { try { srcWs.send(JSON.stringify({ type: "pong" })); } catch {} return; }
  if (type === "pong") return;

  // Task results from device
  if (type === "result") {
    const t = tasks.get(msg.taskId);
    if (t) {
      t.stdout = msg.stdout || "";
      t.stderr = msg.stderr || "";
      t.exitCode = msg.exitCode ?? null;
      t.status = msg.exitCode === 0 ? "done" : "error";
      t.completedAt = now();
      const r = taskResolvers.get(msg.taskId);
      if (r) { r(t); taskResolvers.delete(msg.taskId); }
      saveHistory(t);
    }
    return;
  }

  // Generic relay by msg.to
  if (RELAY_JSON_TYPES.has(type) && msg.to) {
    const target = peerSocket(msg.to);
    if (target && target !== srcWs && target.readyState === target.OPEN) {
      try { target.send(JSON.stringify({ ...msg, from: srcInfo.id })); } catch {}
    } else if (type.startsWith("file-") && msg.transferId) {
      try { srcWs.send(JSON.stringify({ type: "file-error", transferId: msg.transferId, error: `device ${msg.to} not connected` })); } catch {}
    }
    return;
  }

  // Fallback: ignore unknown (don't fan-out to keep behaviour tight)
}

// ── Helpers ──
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise((resolve) => {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}
function saveHistory(t) {
  const duration = t.completedAt ? t.completedAt - t.createdAt : null;
  try {
    stmts.upsertHistory.run(
      t.id, t.device, t.command, t.status, t.stdout || "", t.stderr || "",
      t.exitCode, t.createdAt, t.completedAt, duration
    );
    stmts.pruneHistory.run();
  } catch (e) { log("saveHistory err:", e.message); }
}

// ── Start ──
server.listen(PORT, () => log(`RemoteClaw relay :${PORT} token=${TOKEN.slice(0,12)}...`));
process.on("SIGTERM", () => { log("SIGTERM"); server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { log("SIGINT");  server.close(() => process.exit(0)); });
