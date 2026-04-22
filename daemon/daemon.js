#!/usr/bin/env node
// RemoteClaw Device Daemon

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");

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
  console.log(`[${taskId.slice(0, 8)}] exec: ${command}`);
  const proc = spawn("sh", ["-c", command], {
    env: { ...process.env, HOME: os.homedir() },
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

// ── Keepalive ──

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
