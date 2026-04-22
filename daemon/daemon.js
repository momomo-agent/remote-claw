#!/usr/bin/env node
// RemoteClaw Device Daemon

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");
let pty;
try { pty = require("node-pty"); } catch { pty = null; }

// ── Config ──

const CONFIG_DIR = path.join(os.homedir(), ".remoteclaw");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function getDeviceName() {
  try {
    // macOS: use Model Name (e.g. "Mac mini", "MacBook Pro")
    const { execSync } = require("child_process");
    const info = execSync("system_profiler SPHardwareDataType 2>/dev/null", { encoding: "utf-8" });
    const match = info.match(/Model Name:\s*(.+)/);
    if (match) return match[1].trim().toLowerCase().replace(/\s+/g, "-");
  } catch {}
  // fallback: short hostname, strip common prefixes
  return os.hostname().replace(/\.local$/, "").replace(/^.*de/i, "").toLowerCase() || "unknown";
}

const DEFAULT_CONFIG = {
  server: "wss://remote.momomo.dev",
  token: "CHANGE_ME",
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log(`Config template created at ${CONFIG_PATH}`);
    console.log("Edit it with your server URL and token, then restart.");
    process.exit(0);
  }
  const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  return { ...DEFAULT_CONFIG, ...saved };
}

// ── Daemon ──

const config = loadConfig();
let ws = null;
let reconnectDelay = 1000;
const MAX_DELAY = 30000;

function connect() {
  const name = config.deviceName || getDeviceName();
  const url = `${config.server}/ws?device=${encodeURIComponent(name)}&token=${encodeURIComponent(config.token)}`;
  console.log(`Connecting to ${config.server} as "${name}"...`);

  ws = new WebSocket(url);

  ws.on("open", () => {
    console.log("Connected.");
    reconnectDelay = 1000;
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "exec") execCommand(msg.taskId, msg.command);
      if (msg.type === "pong") { /* keepalive ack */ }
      // File transfer via WS relay
      if (msg.type === "file-start") handleIncomingFileStart(msg);
      if (msg.type === "file-chunk") handleIncomingFileChunk(msg);
      if (msg.type === "file-end") handleIncomingFileEnd(msg);
      // Shell session messages
      if (msg.type === "shell-open") handleShellOpen(msg);
      if (msg.type === "shell-input") handleShellInput(msg);
      if (msg.type === "shell-resize") handleShellResize(msg);
      if (msg.type === "shell-close") handleShellClose(msg);
    } catch (e) {
      console.error("Bad message:", e.message);
    }
  });

  ws.on("close", () => {
    console.log(`Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
  });

  ws.on("error", (e) => {
    console.error("WS error:", e.message);
  });
}

// ── Command Execution ──

function execCommand(taskId, command) {
  // Intercept file send commands
  if (command.startsWith("__RCLAW_SEND__ ")) {
    const parts = command.split(" ");
    const targetDevice = parts[1];
    const localPath = parts[2];
    const remotePath = parts[3];
    sendFileViaWs(targetDevice, localPath, remotePath);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "result", taskId, stdout: `Sending ${localPath} to ${targetDevice}:${remotePath}\n`, stderr: "", exitCode: 0 }));
    }
    return;
  }

  console.log(`[${taskId.slice(0, 8)}] exec: ${command}`);
  const proc = spawn("sh", ["-c", command], {
    env: {
      ...process.env,
      HOME: os.homedir(),
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}`,
    },
    timeout: 60000,
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (exitCode) => {
    console.log(`[${taskId.slice(0, 8)}] exit: ${exitCode}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "result", taskId, stdout, stderr, exitCode }));
    }
  });

  proc.on("error", (e) => {
    console.error(`[${taskId.slice(0, 8)}] error: ${e.message}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "result", taskId, stdout: "", stderr: e.message, exitCode: 1 }));
    }
  });
}

// ── Shell Sessions (PTY) ──

const MAX_SHELL_SESSIONS = 5;
const SHELL_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 min
const shellSessions = new Map(); // sessionId -> { pty, from, idleTimer }

function handleShellOpen(msg) {
  if (!pty) {
    wsSend({ type: "shell-exit", sessionId: msg.sessionId, exitCode: -1, error: "node-pty not available", to: msg.from });
    return;
  }
  if (shellSessions.size >= MAX_SHELL_SESSIONS) {
    wsSend({ type: "shell-exit", sessionId: msg.sessionId, exitCode: -1, error: "max sessions reached", to: msg.from });
    return;
  }
  console.log(`[shell] open: ${msg.sessionId} for ${msg.from}`);
  const shell = process.env.SHELL || "/bin/zsh";
  const term = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: msg.cols || 80,
    rows: msg.rows || 24,
    cwd: os.homedir(),
    env: { ...process.env, HOME: os.homedir(), PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}` },
  });
  const session = { pty: term, from: msg.from, idleTimer: null };
  resetShellIdle(msg.sessionId, session);
  shellSessions.set(msg.sessionId, session);

  term.onData((data) => {
    wsSend({ type: "shell-data", sessionId: msg.sessionId, data: Buffer.from(data).toString("base64"), to: session.from });
  });
  term.onExit(({ exitCode }) => {
    console.log(`[shell] exit: ${msg.sessionId} code=${exitCode}`);
    wsSend({ type: "shell-exit", sessionId: msg.sessionId, exitCode, to: session.from });
    clearTimeout(session.idleTimer);
    shellSessions.delete(msg.sessionId);
  });
}

function handleShellInput(msg) {
  const session = shellSessions.get(msg.sessionId);
  if (!session) return;
  resetShellIdle(msg.sessionId, session);
  session.pty.write(Buffer.from(msg.data, "base64").toString());
}

function handleShellResize(msg) {
  const session = shellSessions.get(msg.sessionId);
  if (!session) return;
  session.pty.resize(msg.cols, msg.rows);
}

function handleShellClose(msg) {
  const session = shellSessions.get(msg.sessionId);
  if (!session) return;
  console.log(`[shell] close: ${msg.sessionId}`);
  clearTimeout(session.idleTimer);
  session.pty.kill();
  shellSessions.delete(msg.sessionId);
}

function resetShellIdle(sessionId, session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    console.log(`[shell] idle timeout: ${sessionId}`);
    session.pty.kill();
    wsSend({ type: "shell-exit", sessionId, exitCode: -1, error: "idle timeout", to: session.from });
    shellSessions.delete(sessionId);
  }, SHELL_IDLE_TIMEOUT);
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Keepalive ──

// ── File Transfer (WebSocket relay) ──

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk
const incomingTransfers = new Map(); // transferId -> { fd, path, received, total }

// Send a local file to another device via WS relay
function sendFileViaWs(targetDevice, localPath, remotePath) {
  const transferId = require("crypto").randomUUID();
  console.log(`[send] ${localPath} -> ${targetDevice}:${remotePath}`);
  try {
    const stat = fs.statSync(localPath);
    const totalSize = stat.size;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

    // Send start
    ws.send(JSON.stringify({
      type: "file-start", to: targetDevice, transferId,
      filename: path.basename(localPath), remotePath, totalSize, totalChunks,
    }));

    // Send chunks
    const fd = fs.openSync(localPath, "r");
    const buf = Buffer.alloc(CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, i * CHUNK_SIZE);
      ws.send(JSON.stringify({
        type: "file-chunk", to: targetDevice, transferId,
        index: i, data: buf.slice(0, bytesRead).toString("base64"),
      }));
      console.log(`[send] chunk ${i + 1}/${totalChunks}`);
    }
    fs.closeSync(fd);

    // Send end
    ws.send(JSON.stringify({ type: "file-end", to: targetDevice, transferId }));
    console.log(`[send] done: ${transferId}`);
  } catch (e) {
    console.error(`[send] error: ${e.message}`);
  }
}

// Receive file-start: prepare to receive
function handleIncomingFileStart(msg) {
  console.log(`[recv] start: ${msg.filename} (${msg.totalChunks} chunks, ${(msg.totalSize / 1024 / 1024).toFixed(1)}MB)`);
  const destPath = msg.remotePath.replace(/^~/, os.homedir());
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(destPath, "w");
  incomingTransfers.set(msg.transferId, {
    fd, path: destPath, received: 0, total: msg.totalChunks,
  });
}

// Receive file-chunk: write data
function handleIncomingFileChunk(msg) {
  const t = incomingTransfers.get(msg.transferId);
  if (!t) return;
  const buf = Buffer.from(msg.data, "base64");
  fs.writeSync(t.fd, buf, 0, buf.length);
  t.received++;
  if (t.received % 10 === 0 || t.received === t.total) {
    console.log(`[recv] chunk ${t.received}/${t.total}`);
  }
}

// Receive file-end: close file
function handleIncomingFileEnd(msg) {
  const t = incomingTransfers.get(msg.transferId);
  if (!t) return;
  fs.closeSync(t.fd);
  incomingTransfers.delete(msg.transferId);
  console.log(`[recv] done: ${t.path} (${t.received} chunks)`);
  // Notify sender
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "result", taskId: msg.transferId, stdout: `Received: ${t.path}\n`, stderr: "", exitCode: 0 }));
  }
}

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping" }));
  }
}, 30000);

// ── LaunchAgent helper ──

if (process.argv[2] === "--install-launchagent") {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.momomo.remoteclaw</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${__filename}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${CONFIG_DIR}/daemon.log</string>
  <key>StandardErrorPath</key><string>${CONFIG_DIR}/daemon.log</string>
</dict>
</plist>`;
  const agentPath = path.join(os.homedir(), "Library/LaunchAgents/dev.momomo.remoteclaw.plist");
  fs.writeFileSync(agentPath, plist);
  console.log(`LaunchAgent installed at ${agentPath}`);
  console.log("Run: launchctl load " + agentPath);
  process.exit(0);
}

// ── Start ──

connect();
