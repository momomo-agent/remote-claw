// RemoteClaw Main Logic — hot-updatable via GitHub
// App is a pure UI client. Daemon handles all command execution.
const LOGIC_VERSION = "1.1.3";
const PKG_VERSION = "1.1.0"; // must match package.json — bump when deps change

const { app, nativeImage, ipcMain } = require("electron");
const { menubar } = require("menubar");
const path = require("path");
const { spawn, execSync } = require("child_process");
const WebSocket = require("ws");
const fs = require("fs");
const os = require("os");

// APP_DIR must point to the asar resources, not the OTA logic location
const APP_DIR = app.getAppPath();
const LOADING_HTML = path.join(APP_DIR, "loading.html");

// Use system proxy for Chromium network stack (fetch/XHR in renderer)
app.commandLine.appendSwitch('proxy-auto-detect');
function loadWithSplash(win, targetUrl) {
  win.loadFile(LOADING_HTML);
  win.webContents.on('did-finish-load', function onSplash() {
    win.webContents.removeListener('did-finish-load', onSplash);
    win.loadURL(targetUrl);
  });
}

// ── Config ──

const CONFIG_DIR = path.join(os.homedir(), ".remoteclaw");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaults = { server: "wss://remote.momomo.dev", token: "CHANGE_ME" };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

const config = loadConfig();
const httpBase = config.server.replace("wss://", "https://").replace("ws://", "http://");

// ── Daemon Management ──

const DAEMON_DIR = path.join(CONFIG_DIR, "daemon");
const DAEMON_ENTRY = path.join(DAEMON_DIR, "daemon", "daemon.js");
const DAEMON_PID_FILE = path.join(CONFIG_DIR, "daemon.pid");
const LAUNCHAGENT_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", "dev.momomo.remoteclaw.plist");

function isDaemonRunning() {
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim());
    if (!pid) return false;
    process.kill(pid, 0); // signal 0 = check if alive
    return true;
  } catch { return false; }
}

function installDaemon() {
  // Clone/update daemon from repo
  if (!fs.existsSync(path.join(DAEMON_DIR, ".git"))) {
    console.log("[daemon] Installing daemon...");
    try {
      execSync(`git clone --depth 1 https://github.com/momomo-agent/remote-claw.git "${DAEMON_DIR}"`, { timeout: 30000, stdio: "pipe" });
    } catch (e) {
      console.log("[daemon] Clone failed:", e.message);
      return false;
    }
  }
  // npm install (check for actual ws module, not just node_modules dir)
  const daemonPkgDir = path.join(DAEMON_DIR, "daemon");
  if (!fs.existsSync(path.join(daemonPkgDir, "node_modules", "ws"))) {
    try {
      console.log("[daemon] Running npm install...");
      execSync("npm install --production", { cwd: daemonPkgDir, timeout: 60000, stdio: "pipe" });
    } catch (e) {
      console.log("[daemon] npm install failed:", e.message);
      return false;
    }
  }
  return fs.existsSync(DAEMON_ENTRY);
}

function startDaemon() {
  if (isDaemonRunning()) { console.log("[daemon] Already running"); return; }
  if (!fs.existsSync(DAEMON_ENTRY) && !installDaemon()) return;

  // Always ensure deps are installed before starting
  const daemonPkgDir = path.join(DAEMON_DIR, "daemon");
  if (!fs.existsSync(path.join(daemonPkgDir, "node_modules", "ws"))) {
    console.log("[daemon] Dependencies missing, running npm install...");
    try {
      execSync("npm install --production", { cwd: daemonPkgDir, timeout: 60000, stdio: "pipe" });
      console.log("[daemon] Dependencies installed");
    } catch (e) {
      console.log("[daemon] npm install failed:", e.message);
      return;
    }
  }

  console.log("[daemon] Starting...");
  const nodeCmd = process.versions.electron ? "node" : process.execPath;
  const child = spawn(nodeCmd, [DAEMON_ENTRY], {
    detached: true,
    stdio: ["ignore", fs.openSync(path.join(CONFIG_DIR, "daemon.log"), "a"), fs.openSync(path.join(CONFIG_DIR, "daemon.log"), "a")],
    env: { ...process.env, HOME: os.homedir(), PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
  });
  child.unref();
  fs.writeFileSync(DAEMON_PID_FILE, String(child.pid));
  console.log(`[daemon] Started (pid ${child.pid})`);

  installLaunchAgent();
}

function installLaunchAgent() {
  const nodePath = "/opt/homebrew/bin/node";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.momomo.remoteclaw</string>
  <key>ProgramArguments</key><array>
    <string>${nodePath}</string>
    <string>${DAEMON_ENTRY}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${CONFIG_DIR}/daemon.log</string>
  <key>StandardErrorPath</key><string>${CONFIG_DIR}/daemon.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;
  try {
    const agentDir = path.dirname(LAUNCHAGENT_PLIST);
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(LAUNCHAGENT_PLIST, plist);
    execSync(`launchctl unload "${LAUNCHAGENT_PLIST}" 2>/dev/null; launchctl load "${LAUNCHAGENT_PLIST}"`, { stdio: "pipe" });
    console.log("[daemon] LaunchAgent installed");
  } catch (e) {
    console.log("[daemon] LaunchAgent install failed:", e.message);
  }
}

function updateDaemon() {
  if (!fs.existsSync(path.join(DAEMON_DIR, ".git"))) return;
  try {
    const result = execSync("git pull --quiet 2>&1", { cwd: DAEMON_DIR, timeout: 15000, encoding: "utf-8" });
    if (result.includes("Already up to date")) return;
    console.log("[daemon] Updated, restarting...");
    // Kill old daemon, LaunchAgent will restart it
    try {
      const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim());
      process.kill(pid, "SIGTERM");
    } catch {}
  } catch (e) {
    console.log("[daemon] Update check failed:", e.message);
  }
}

// ── Tray icon ──

function createTrayIcon(connected) {
  const trayPath = path.join(APP_DIR, 'trayTemplate.png');
  try {
    const img = nativeImage.createFromPath(trayPath);
    img.setTemplateImage(true);
    return img;
  } catch {
    const size = 22;
    const canvas = Buffer.alloc(size * size * 4, 0);
    const cx = 11, cy = 11, r = 7;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (dist <= r) {
          const i = (y * size + x) * 4;
          if (connected) { canvas[i] = 52; canvas[i + 1] = 199; canvas[i + 2] = 89; }
          else { canvas[i] = 120; canvas[i + 1] = 120; canvas[i + 2] = 128; }
          canvas[i + 3] = dist > r - 1 ? Math.round((r - dist) * 255) : 255;
        }
      }
    }
    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }
}

// ── State ──

let clientWs = null;
let connected = false;
let mb = null;
let isPinned = false;
let trayBounds = null;
let manualDisconnect = false;

// ── System Proxy Detection ──

function getSystemProxy() {
  try {
    // Read macOS system HTTP proxy
    const out = execSync('scutil --proxy', { encoding: 'utf-8', timeout: 3000 });
    // Check HTTPS first, then HTTP
    for (const proto of ['HTTPS', 'HTTP']) {
      const enabled = out.match(new RegExp(`${proto}Enable\\s*:\\s*(\\d)`));
      if (enabled && enabled[1] === '1') {
        const host = out.match(new RegExp(`${proto}Proxy\\s*:\\s*(\\S+)`));
        const port = out.match(new RegExp(`${proto}Port\\s*:\\s*(\\d+)`));
        if (host && port) {
          const url = `http://${host[1]}:${port[1]}`;
          console.log(`[proxy] System proxy detected: ${url}`);
          return url;
        }
      }
    }
    // Check SOCKS proxy
    const socksEnabled = out.match(/SOCKSEnable\s*:\s*(\d)/);
    if (socksEnabled && socksEnabled[1] === '1') {
      const host = out.match(/SOCKSProxy\s*:\s*(\S+)/);
      const port = out.match(/SOCKSPort\s*:\s*(\d+)/);
      if (host && port) {
        const url = `socks5://${host[1]}:${port[1]}`;
        console.log(`[proxy] System SOCKS proxy detected: ${url}`);
        return url;
      }
    }
  } catch {}
  return null;
}

function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (proxyUrl.startsWith('socks')) return undefined;
  try {
    // Try https-proxy-agent first (available in dev, not in packaged app)
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  } catch {
    // Fallback: build a CONNECT-tunnel agent using only Node builtins
    const http = require('http');
    const { URL } = require('url');
    const proxy = new URL(proxyUrl);
    return {
      __isBuiltinProxy: true,
      proxyHost: proxy.hostname,
      proxyPort: parseInt(proxy.port) || 7890,
    };
  }
}

// Connect WebSocket through HTTP CONNECT tunnel (no external deps)
function connectWsThroughProxy(wsUrl, proxyInfo) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const target = new URL(wsUrl);
    const connectReq = http.request({
      host: proxyInfo.proxyHost,
      port: proxyInfo.proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      }
      // Create TLS connection over the tunnel
      const tls = require('tls');
      const tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true });
      const ws = new WebSocket(wsUrl, { createConnection: () => tlsSocket });
      resolve(ws);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}


// ── Client WS (subscribe only, no command execution) ──

function connectClient() {
  const clientId = `app-${os.hostname()}`;
  const url = `${config.server}/ws?device=${encodeURIComponent(clientId)}&token=${encodeURIComponent(config.token)}&role=client`;
  const proxyUrl = getSystemProxy();
  const agent = createProxyAgent(proxyUrl);

  const setupWs = (ws) => {
    clientWs = ws;
    ws.on("open", () => {
      connected = true;
      console.log("[ws] Connected" + (proxyUrl ? ` via proxy ${proxyUrl}` : ""));
      if (mb?.tray) mb.tray.setImage(createTrayIcon(true));
      sendToRenderer("daemon-status", { connected: true });
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "shell-data" || msg.type === "shell-exit") {
          sendToRenderer(msg.type, msg);
        }
        if (msg.type === "screen-frame") {
          sendToRenderer("screen-frame", msg);
        }
      } catch {}
    });
    ws.on("close", () => {
      connected = false;
      if (mb?.tray) mb.tray.setImage(createTrayIcon(false));
      sendToRenderer("daemon-status", { connected: false });
      if (!manualDisconnect) setTimeout(connectClient, 3000);
    });
    ws.on("error", (e) => { console.log("[ws] Error:", e.message); });
  };

  if (agent && agent.__isBuiltinProxy) {
    // Use CONNECT tunnel with Node builtins (no external deps needed)
    connectWsThroughProxy(url, agent).then(setupWs).catch((e) => {
      console.log("[ws] Proxy tunnel failed:", e.message, "— trying direct");
      setupWs(new WebSocket(url));
    });
  } else {
    const wsOpts = agent ? { agent } : {};
    setupWs(new WebSocket(url, wsOpts));
  }
}

function sendToRenderer(channel, data) {
  if (mb?.window?.webContents) mb.window.webContents.send(channel, data);
  if (channel === 'shell-data' || channel === 'shell-exit') {
    for (const win of allIndependentWindows) {
      if (!win.isDestroyed() && win.webContents) win.webContents.send(channel, data);
    }
  }
}

// ── IPC: Config ──

ipcMain.handle("get-config", () => ({ ...config, httpBase, connected, version: LOGIC_VERSION, localDevice: os.hostname(), raw: JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) }));

ipcMain.handle("save-config", async (_, newCfg) => {
  const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const merged = { ...existing, ...newCfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  Object.assign(config, loadConfig());
  if (clientWs) clientWs.close();
  setTimeout(connectClient, 500);
  return true;
});

// ── IPC: Remote exec/devices/history (all via HTTP API to server) ──

ipcMain.handle("fetch-devices", async () => {
  try { return await (await fetch(`${httpBase}/devices`, { headers: { Authorization: `Bearer ${config.token}` } })).json(); }
  catch { return []; }
});

ipcMain.handle("fetch-history", async (_, limit = 50) => {
  try { return await (await fetch(`${httpBase}/history?limit=${limit}`, { headers: { Authorization: `Bearer ${config.token}` } })).json(); }
  catch { return []; }
});

ipcMain.handle("exec-command", async (_, { device, command }) => {
  try {
    return await (await fetch(`${httpBase}/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device, command, oneshot: true, timeout: 30000 }),
    })).json();
  } catch (e) { return { error: e.message }; }
});

// ── IPC: Shell PTY (relay via client WS to server → daemon) ──

function wsSend(msg) {
  if (clientWs?.readyState === WebSocket.OPEN) { clientWs.send(JSON.stringify(msg)); return { ok: true }; }
  return { error: "not connected" };
}

ipcMain.handle("shell-open", (_, p) => wsSend({ type: "shell-open", sessionId: p.sessionId, to: p.device, cols: p.cols, rows: p.rows }));
ipcMain.handle("shell-input", (_, p) => wsSend({ type: "shell-input", sessionId: p.sessionId, data: p.data, to: p.device }));
ipcMain.handle("shell-resize", (_, p) => wsSend({ type: "shell-resize", sessionId: p.sessionId, cols: p.cols, rows: p.rows, to: p.device }));
ipcMain.handle("shell-close", (_, p) => wsSend({ type: "shell-close", sessionId: p.sessionId, to: p.device }));
ipcMain.handle("screen-start", (_, p) => wsSend({ type: "screen-start", sessionId: p.sessionId, to: p.device, quality: p.quality || 60, fps: p.fps || 2 }));
ipcMain.handle("screen-stop", (_, p) => wsSend({ type: "screen-stop", sessionId: p.sessionId, to: p.device }));

// ── IPC: Window ──

ipcMain.handle("get-pinned", () => ({ pinned: isPinned }));
ipcMain.handle("set-pinned", (_, { pinned }) => {
  isPinned = pinned;
  mb._pinned = pinned;
  if (mb?.window) {
    mb.window.setAlwaysOnTop(pinned);
    mb.window.setVisibleOnAllWorkspaces(pinned);
    // Re-bindblur handler based on pin state
    mb.window.removeAllListeners("blur");
    if (!pinned) {
      mb.window.on("blur", () => { if (!isPinned) mb.hideWindow(); });
    }
  }
  sendToRenderer("pinned-changed", { pinned });
  return { ok: true };
});

ipcMain.handle("toggle-connection", () => {
  if (connected || clientWs) {
    manualDisconnect = true;
    if (clientWs) { clientWs.removeAllListeners("close"); clientWs.close(); clientWs = null; }
    connected = false;
    if (mb?.tray) mb.tray.setImage(createTrayIcon(false));
    sendToRenderer("daemon-status", { connected: false });
    return { connected: false };
  } else {
    manualDisconnect = false;
    connectClient();
    return { connected: true };
  }
});

ipcMain.handle("close-window", () => {
  if (mb?.window) {
    isPinned = false;
    mb._pinned = false;
    mb.window.setAlwaysOnTop(false);
    mb.window.setVisibleOnAllWorkspaces(false);
    // Restore blur handler
    mb.window.removeAllListeners("blur");
    mb.window.on("blur", () => { if (!isPinned) mb.hideWindow(); });
    sendToRenderer("pinned-changed", { pinned: false });
    mb.window.hide();
  }
});

ipcMain.handle("win-get-bounds", () => mb?.window?.getBounds());
ipcMain.handle("win-set-bounds", (_, b) => { if (mb?.window) mb.window.setBounds(b); });
ipcMain.handle("win-set-size", (_, { width, height }) => { if (mb?.window) mb.window.setSize(width, height); });
ipcMain.handle("win-set-position", (_, { x, y }) => { if (mb?.window) mb.window.setPosition(x, y); });
ipcMain.handle("win-set-always-on-top", (_, { flag }) => { if (mb?.window) mb.window.setAlwaysOnTop(flag); return { alwaysOnTop: flag }; });
ipcMain.handle("win-is-always-on-top", () => mb?.window?.isAlwaysOnTop());
ipcMain.handle("win-minimize", () => { if (mb?.window) mb.window.minimize(); });
ipcMain.handle("win-maximize", () => { if (mb?.window) { mb.window.isMaximized() ? mb.window.unmaximize() : mb.window.maximize(); } return { maximized: mb?.window?.isMaximized() }; });
ipcMain.handle("win-set-title", (_, { title }) => { if (mb?.window) mb.window.setTitle(title); });
ipcMain.handle("daemon-status", () => {
  const running = isDaemonRunning();
  const installed = fs.existsSync(DAEMON_ENTRY);
  const hasLaunchAgent = fs.existsSync(LAUNCHAGENT_PLIST);
  return { running, installed, hasLaunchAgent };
});
ipcMain.handle("daemon-restart", () => {
  // Kill existing
  try { const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim()); process.kill(pid, "SIGTERM"); } catch {}
  // Wait a bit then start
  setTimeout(() => startDaemon(), 500);
  return { ok: true };
});
ipcMain.handle("win-set-opacity", (_, { opacity }) => { if (mb?.window) mb.window.setOpacity(opacity); });
ipcMain.handle("win-open-devtools", () => { if (mb?.window) mb.window.webContents.openDevTools({ mode: "detach" }); });

// ── IPC: Detach tab into independent window ──

const detachedWindows = new Map();
const allIndependentWindows = new Set();

function trackIndependentWindow(win) {
  allIndependentWindows.add(win);
  if (allIndependentWindows.size === 1 && app.dock) app.dock.show();
  win.on("closed", () => {
    allIndependentWindows.delete(win);
    if (allIndependentWindows.size === 0 && app.dock) app.dock.hide();
  });
}

ipcMain.handle("open-tab-window", (_, { tab, device, title }) => {
  const { BrowserWindow } = require("electron");
  const existing = detachedWindows.get(tab);
  if (existing && !existing.isDestroyed()) { existing.focus(); return { ok: true, reused: true }; }

  const sizes = { shell: [720, 500], files: [680, 520], terminal: [720, 480] };
  const [w, h] = sizes[tab] || [680, 500];

  const win = new BrowserWindow({
    width: w, height: h, minWidth: 400, minHeight: 300,
    title: title || `RemoteClaw \u2014 ${tab}`,
    backgroundColor: '#161618',
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, preload: path.join(APP_DIR, "preload.js") },
  });

  loadWithSplash(win, getCachedUIUrl({ tab, device: device || "", detached: "1" }));

  detachedWindows.set(tab, win);
  trackIndependentWindow(win);
  win.on("closed", () => detachedWindows.delete(tab));
  return { ok: true };
});

ipcMain.handle("open-preview", (_, { file, device, title }) => {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({
    width: 900, height: 620, minWidth: 600, minHeight: 400,
    title: title || `Preview \u2014 ${file.split('/').pop()}`,
    backgroundColor: '#161618',
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, preload: path.join(APP_DIR, "preload.js") },
  });
  const cachedPreview = path.join(UI_CACHE_DIR, "preview.html");
  const previewBase = fs.existsSync(cachedPreview) ? `file://${cachedPreview}` : CLOUD_URL + "preview.html";
  const url = new URL(previewBase);
  url.searchParams.set("file", file);
  url.searchParams.set("device", device || "");
  loadWithSplash(win, url.toString());
  trackIndependentWindow(win);
  return { ok: true };
});

ipcMain.handle("open-editor", async (_, { dir, file, device, title }) => {
  const { BrowserWindow } = require("electron");
  const cachedEditor = path.join(UI_CACHE_DIR, "editor.html");
  const editorBase = fs.existsSync(cachedEditor) ? `file://${cachedEditor}` : CLOUD_URL + "editor.html";
  const win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 700, minHeight: 500,
    title: title || "RemoteClaw Editor",
    backgroundColor: '#161618',
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, preload: path.join(APP_DIR, "preload.js") },
  });
  const url = new URL(editorBase);
  if (dir) url.searchParams.set("dir", dir);
  if (file) url.searchParams.set("file", file);
  if (device) url.searchParams.set("device", device);
  loadWithSplash(win, url.toString());
  trackIndependentWindow(win);
  return { ok: true };
});

function getRelayConfig() {
  let server = "wss://remote.momomo.dev";
  let token = "";
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".remoteclaw", "config.json"), "utf-8"));
    server = cfg.server || server;
    token = cfg.token || "";
  } catch {}
  return { server, token };
}

// ── App-level Proxy Manager ──
// One proxy per (device, remotePort). Lives as long as the app. Shared across
// all windows (Browser, VS Code, future apps). Re-used on repeat requests.
const proxies = new Map(); // key="device|port" -> { proxy, device, remotePort, kind, createdAt, lastUsedAt, connected, everConnected }

function proxyKey(device, remotePort) { return `${device || ""}|${remotePort}`; }

function snapshotProxies() {
  const out = [];
  for (const [key, entry] of proxies) {
    out.push({
      key,
      device: entry.device,
      remotePort: entry.remotePort,
      localPort: entry.proxy?.port,
      url: entry.proxy?.url,
      kind: entry.kind,
      connected: !!entry.connected,
      everConnected: !!entry.everConnected,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt,
      age: Date.now() - entry.createdAt,
    });
  }
  return out;
}

function broadcastProxies() {
  sendToRenderer("proxies-changed", snapshotProxies());
}

async function ensureProxy({ device, remotePort, kind }) {
  const { startCodeServerProxy } = require(path.join(APP_DIR, "code-server-proxy"));
  const key = proxyKey(device, remotePort);
  const existing = proxies.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    if (kind && !existing.kind.includes(kind)) existing.kind += `+${kind}`;
    return existing;
  }

  const { server, token } = getRelayConfig();
  const entry = {
    device: device || "",
    remotePort,
    kind: kind || "generic",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    connected: false,
    everConnected: false,
    proxy: null,
  };
  entry.proxy = await startCodeServerProxy({
    server, token, device, remotePort,
    onStateChange: ({ connected, everConnected }) => {
      entry.connected = connected;
      entry.everConnected = everConnected;
      broadcastProxies();
    },
  });
  proxies.set(key, entry);
  broadcastProxies();
  return entry;
}

function closeProxy(key) {
  const entry = proxies.get(key);
  if (!entry) return false;
  try { entry.proxy?.close(); } catch {}
  proxies.delete(key);
  broadcastProxies();
  return true;
}

function closeAllProxies() {
  for (const [key, entry] of proxies) {
    try { entry.proxy?.close(); } catch {}
  }
  proxies.clear();
}

app.on("before-quit", closeAllProxies);

ipcMain.handle("proxy-list", () => snapshotProxies());
ipcMain.handle("proxy-close", (_, { key }) => ({ ok: closeProxy(key) }));
ipcMain.handle("proxy-ensure", async (_, { device, remotePort, kind }) => {
  try {
    const entry = await ensureProxy({ device, remotePort: parseInt(remotePort, 10), kind });
    return { ok: true, url: entry.proxy.url, localPort: entry.proxy.port, connected: entry.connected };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});
// Back-compat: older browser.html UI cache may still call this channel.
ipcMain.handle("browser-start-proxy", async (_, { device, port }) => {
  try {
    const entry = await ensureProxy({ device, remotePort: parseInt(port, 10) || 3000, kind: "browser" });
    return { ok: true, url: entry.proxy.url };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

ipcMain.handle("open-code-server", async (_, { device, folder, port }) => {
  const { BrowserWindow, Notification } = require("electron");
  const remotePort = port || 8080;

  try {
    // Start code-server on remote device if not already running
    if (device) {
      const execOpts = { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" } };
      const checkRes = await (await fetch(`${httpBase}/exec`, { ...execOpts, body: JSON.stringify({ device, command: `lsof -i :${remotePort} -t 2>/dev/null | head -1`, oneshot: true, timeout: 5000 }) })).json();
      if (!checkRes?.stdout?.trim()) {
        await fetch(`${httpBase}/exec`, { ...execOpts, body: JSON.stringify({ device, command: `nohup code-server --bind-addr 127.0.0.1:${remotePort} --auth none > /tmp/code-server.log 2>&1 &`, oneshot: true, timeout: 5000 }) });
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const entry = await ensureProxy({ device, remotePort, kind: "vscode" });
    const codeUrl = entry.proxy.url + (folder ? `/?folder=${encodeURIComponent(folder)}` : "");

    const win = new BrowserWindow({
      width: 1280, height: 800, minWidth: 800, minHeight: 600,
      title: "VS Code \u2014 " + (device || "local"),
      backgroundColor: '#161618',
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 12 },
      webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false },
    });
    win.loadURL(codeUrl);
    // NOTE: proxy is app-scoped now — do not close on window close
    trackIndependentWindow(win);
    return { ok: true };
  } catch (e) {
    new Notification({ title: "VS Code", body: `Failed: ${e.message}` }).show();
    return { error: e.message };
  }
});

ipcMain.handle("open-browser", async (_, { device, port, path: urlPath }) => {
  const { BrowserWindow } = require("electron");
  const remotePort = port || 3000;
  const initialPath = urlPath || "/";

  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 800, minHeight: 600,
    title: `Browser \u2014 ${device || "local"}`,
    backgroundColor: '#1a1a1a',
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      webviewTag: true,
      preload: path.join(APP_DIR, "preload.js"),
    },
  });

  const cachedBrowser = path.join(UI_CACHE_DIR, "browser.html");
  const browserBase = fs.existsSync(cachedBrowser) ? `file://${cachedBrowser}` : CLOUD_URL + "browser.html";
  const fileUrl = new URL(browserBase);
  if (device) fileUrl.searchParams.set("device", device);
  fileUrl.searchParams.set("port", String(remotePort));
  fileUrl.searchParams.set("path", initialPath);
  win.loadURL(fileUrl.toString());

  // Eagerly ensure proxy (so renderer sees connected state sooner)
  ensureProxy({ device, remotePort, kind: "browser" }).catch(() => {});

  // Proxy lives as long as the app, not the window.
  trackIndependentWindow(win);
  return { ok: true };
});

// ── IPC: Clipboard ──

ipcMain.handle("clipboard-read", () => { const { clipboard } = require("electron"); return { text: clipboard.readText(), html: clipboard.readHTML(), hasImage: !clipboard.readImage().isEmpty() }; });
ipcMain.handle("clipboard-write", (_, { text, html }) => { const { clipboard } = require("electron"); if (text) clipboard.writeText(text); if (html) clipboard.writeHTML(html); return { ok: true }; });
ipcMain.handle("clipboard-read-image", () => { const { clipboard } = require("electron"); const img = clipboard.readImage(); return img.isEmpty() ? { empty: true } : { dataUrl: img.toDataURL(), size: img.getSize() }; });

// ── IPC: Notifications ──

ipcMain.handle("notify", (_, { title, body }) => { const { Notification } = require("electron"); new Notification({ title, body }).show(); return { ok: true }; });

// ── IPC: Shell utilities (Electron shell, not PTY) ──

ipcMain.handle("shell-open-external", (_, { url }) => require("electron").shell.openExternal(url));
ipcMain.handle("open-external", (_, { url }) => require("electron").shell.openExternal(url));
ipcMain.handle("relaunch", () => { app.relaunch(); app.exit(0); });
ipcMain.handle("shell-open-path", (_, { path: p }) => require("electron").shell.openPath(p));
ipcMain.handle("shell-show-in-folder", (_, { path: p }) => { require("electron").shell.showItemInFolder(p); return { ok: true }; });
ipcMain.handle("shell-trash", async (_, { path: p }) => { await require("electron").shell.trashItem(p); return { ok: true }; });

// ── Hot Update ──

async function checkForUpdate() {
  try {
    const res = await fetch("https://raw.githubusercontent.com/momomo-agent/remote-claw/main/app/main-logic.js", { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return;
    const remote = await res.text();
    const stagingPath = path.join(CONFIG_DIR, "main-logic.staging.js");
    const cachedPath = path.join(CONFIG_DIR, "main-logic.js");
    const current = fs.existsSync(cachedPath) ? fs.readFileSync(cachedPath, "utf-8") : "";
    if (remote !== current) {
      fs.writeFileSync(stagingPath, remote);
      const vMatch = remote.match(/LOGIC_VERSION\s*=\s*["']([^"']+)["']/);
      const newVer = vMatch ? vMatch[1] : "new";
      const meta = { stagedAt: Date.now(), version: newVer, sha: require("crypto").createHash("sha256").update(remote).digest("hex").slice(0, 12) };
      fs.writeFileSync(path.join(CONFIG_DIR, "main-logic.meta.json"), JSON.stringify(meta));
      console.log(`[ota] Update staged: v${LOGIC_VERSION} → v${newVer}`);
      pendingUpdate = true;
      if (mb?.tray) {
        trayMenu.items[0].label = `RemoteClaw v${LOGIC_VERSION} → v${newVer}`;
      }
      // Check if new version needs a DMG update (PKG_VERSION changed = deps changed)
      const pkgMatch = remote.match(/PKG_VERSION\s*=\s*["']([^"']+)["']/);
      const remotePkg = pkgMatch ? pkgMatch[1] : null;
      const needsDmg = remotePkg && remotePkg !== PKG_VERSION;
      if (needsDmg) {
        if (Notification.isSupported()) {
          new Notification({ title: "RemoteClaw: DMG Update Required", body: `v${remotePkg} has new dependencies — please download the new DMG` }).show();
        }
      } else {
        if (Notification.isSupported()) {
          new Notification({ title: "RemoteClaw Updated", body: `v${newVer} ready — restart to apply` }).show();
        }
      }
      sendToRenderer("update-available", { current: LOGIC_VERSION, next: newVer, needsDmg });
    }
  } catch {}
}

setTimeout(checkForUpdate, 5000);
setTimeout(cacheCloudUI, 3000); // Cache UI files on startup

// Check daemon updates every 30 minutes
setInterval(updateDaemon, 30 * 60 * 1000);
setTimeout(updateDaemon, 60000); // First check after 1 min

// ── UI Cache ──
const UI_CACHE_DIR = path.join(CONFIG_DIR, "ui-cache");
const UI_FILES = [
  "index.html",
  "preview.html",
  "editor.html",
  "browser.html",
  "js/app.js",
  "js/state.js",
  "js/api.js",
  "js/components/TabBar.js",
  "js/components/DeviceSelect.js",
  "js/components/ContextMenu.js",
  "js/components/AppCard.js",
  "js/composables/useContextMenu.js",
  "js/composables/useShell.js",
  "js/composables/useFiles.js",
  "js/apps/ShellApp.js",
  "js/apps/FilesApp.js",
  "js/apps/NetworkApp.js",
  "js/apps/ClawApp.js",
  "js/apps/DevicesApp.js",
  "js/apps/HistoryApp.js",
  "js/apps/AppsGrid.js",
  "js/apps/SettingsApp.js",
  "js/apps/ScreenApp.js",
];

async function cacheCloudUI() {
  if (!fs.existsSync(UI_CACHE_DIR)) fs.mkdirSync(UI_CACHE_DIR, { recursive: true });
  const base = "https://raw.githubusercontent.com/momomo-agent/remote-claw/main/docs/";
  let updated = 0;
  for (const file of UI_FILES) {
    try {
      const res = await fetch(base + file, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      const localPath = path.join(UI_CACHE_DIR, file);
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const existing = fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf-8") : "";
      if (text !== existing) { fs.writeFileSync(localPath, text); updated++; }
    } catch {}
  }
  if (updated > 0) console.log(`[ui-cache] Updated ${updated} files`);
}

function getCachedUIUrl(params = {}) {
  const cached = path.join(UI_CACHE_DIR, "index.html");
  if (fs.existsSync(cached)) {
    const url = new URL(`file://${cached}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }
  const url = new URL(CLOUD_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// ── Menubar ──

const CLOUD_URL = "https://momomo-agent.github.io/remote-claw/";
const LOCAL_URL = `file://${path.join(APP_DIR, "renderer", "index.html")}`;
const LOADING_URL = `file://${LOADING_HTML}`;

app.dock?.hide();

mb = menubar({
  index: LOADING_URL,
  icon: createTrayIcon(false),
  preloadWindow: true,
  showDockIcon: false,
  browserWindow: {
    width: 380, height: 580,
    resizable: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, preload: path.join(APP_DIR, "preload.js") },
    backgroundColor: '#161618',
    skipTaskbar: true,
    frame: false,
    transparent: false,
    hasShadow: true,
    roundedCorners: true,
    vibrancy: null,
  },
});

mb.on("ready", () => {
  connectClient();
  startDaemon(); // Ensure daemon is running

  // Auto-install rclaw CLI
  try {
    const cliSrc = path.join(DAEMON_DIR, "cli", "rclaw.js");
    if (fs.existsSync(cliSrc)) {
      const cliDst = "/usr/local/bin/rclaw";
      try { fs.unlinkSync(cliDst); } catch {}
      try { fs.symlinkSync(cliSrc, cliDst); } catch {
        const userBin = path.join(os.homedir(), ".local", "bin", "rclaw");
        fs.mkdirSync(path.dirname(userBin), { recursive: true });
        try { fs.unlinkSync(userBin); } catch {}
        try { fs.symlinkSync(cliSrc, userBin); } catch {}
      }
    }
  } catch {}

  let pendingUpdate = false;
  const { Menu, Notification } = require("electron");
  let trayMenu = Menu.buildFromTemplate([
    { label: `RemoteClaw v${LOGIC_VERSION}`, enabled: false },
    { type: "separator" },
    { label: "Pin Window", type: "checkbox", checked: false, click: (item) => {
      isPinned = item.checked;
      mb._pinned = isPinned;
      if (isPinned && mb.window) { mb.window.setAlwaysOnTop(false); mb.window.setVisibleOnAllWorkspaces(false); }
      sendToRenderer("pinned-changed", { pinned: isPinned });
    }},
    { label: "Open Web UI", click: () => require("electron").shell.openExternal(CLOUD_URL) },
    { label: "Connected", type: "checkbox", checked: false, click: (item) => {
      if (connected) {
        manualDisconnect = true;
        if (clientWs) { clientWs.removeAllListeners("close"); clientWs.close(); clientWs = null; }
        connected = false;
        if (mb?.tray) mb.tray.setImage(createTrayIcon(false));
        sendToRenderer("daemon-status", { connected: false });
        item.checked = false;
      } else { manualDisconnect = false; connectClient(); item.checked = true; }
    }},
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  mb.tray.on("right-click", () => { trayMenu.items[4].checked = connected; mb.tray.popUpContextMenu(trayMenu); });

  ipcMain.handle("tray-set-menu", (_, { items }) => {
    const template = items.map(item => item.type === "separator" ? { type: "separator" } : {
      label: item.label, type: item.type || "normal", checked: item.checked, enabled: item.enabled !== false,
      click: () => sendToRenderer("tray-menu-click", { id: item.id }),
    });
    template.push({ type: "separator" }, { label: "Quit", click: () => app.quit() });
    trayMenu = Menu.buildFromTemplate(template);
    return { ok: true };
  });

  mb.on("show", () => {
    sendToRenderer("refresh", {});
    if (!isPinned && mb.tray) trayBounds = mb.tray.getBounds();
    // Check for updates on every tray show
    checkForUpdate();
  });
});

mb.on("after-create-window", () => {
  let uiLoaded = false;

  function loadCloudUI() {
    uiLoaded = false;
    // Try cached UI first (instant), fall back to cloud
    const cachedIndex = path.join(UI_CACHE_DIR, "index.html");
    if (fs.existsSync(cachedIndex)) {
      console.log("[ui] Loading cached UI");
      sendToRenderer("loading-progress", { pct: 80, msg: "Loading cached UI...", detail: "Local cache" });
      mb.window.loadURL(`file://${cachedIndex}`);
      // Background refresh cache for next time
      cacheCloudUI().catch(() => {});
      return;
    }

    console.log("[ui] Loading cloud UI:", CLOUD_URL);
    sendToRenderer("loading-progress", { pct: 30, msg: "Connecting to server...", detail: CLOUD_URL.replace('https://', '') });

    mb.window.webContents.once("did-start-navigation", (_, url) => {
      if (url.startsWith(CLOUD_URL)) {
        sendToRenderer("loading-progress", { pct: 40, msg: "Server responded", detail: "Downloading UI..." });
      }
    });
    mb.window.webContents.once("dom-ready", () => {
      if (!uiLoaded) {
        sendToRenderer("loading-progress", { pct: 80, msg: "Rendering UI...", detail: "DOM ready" });
      }
    });

    mb.window.loadURL(CLOUD_URL);
    // Timeout: 10s to load cloud, then fallback
    setTimeout(() => {
      if (!uiLoaded) {
        console.log("[ui] Cloud load timeout (10s), falling back to local");
        sendToRenderer("loading-progress", { pct: 90, msg: "Timeout \u2014 loading offline UI", detail: "Cloud took too long (10s)" });
        mb.window.loadURL(LOCAL_URL);
      }
    }, 10000);
  }

  // Loading screen signals readiness
  ipcMain.removeHandler("loading-status");
  ipcMain.handle("loading-status", (_, status) => {
    if (status === "online") {
      loadCloudUI();
    } else {
      console.log("[ui] Network check failed, using local UI");
      mb.window.loadURL(LOCAL_URL);
    }
  });

  mb.window.webContents.on("did-finish-load", () => {
    const url = mb.window.webContents.getURL();
    if (url.startsWith(CLOUD_URL) || (url.startsWith("file://") && !url.includes("loading.html"))) {
      uiLoaded = true;
      sendToRenderer("loading-progress", { pct: 100, msg: "Ready", done: true });
      console.log("[ui] Loaded:", url);
    }
  });

  mb.window.webContents.on("did-fail-load", (_, code, desc, url) => {
    if (url === CLOUD_URL || url.startsWith(CLOUD_URL)) {
      console.log(`[ui] Cloud load failed: ${desc} (${code})`);
      sendToRenderer("loading-progress", { error: `${desc} (code ${code})` });
      uiLoaded = true;
      mb.window.loadURL(LOCAL_URL);
    }
  });
  mb.window.on("move", () => sendToRenderer("window-moved", { bounds: mb.window.getBounds(), trayBounds }));
  mb.window.removeAllListeners("blur");
  mb.window.on("blur", () => { if (!isPinned) mb.hideWindow(); });
  mb.window.on("hide", () => sendToRenderer("window-hidden", {}));
  // Override both hide paths to respect pin
  const origHide = mb.hideWindow.bind(mb);
  mb.hideWindow = () => { if (!isPinned) origHide(); };
});

mb.on("show", () => { if (isPinned) return; });
mb.on("hide", () => {});
