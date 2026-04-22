// RemoteClaw Main Logic — hot-updatable via GitHub
// This file is fetched from GitHub on each app launch

const { app, nativeImage, ipcMain } = require("electron");
const { menubar } = require("menubar");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const fs = require("fs");
const os = require("os");

// App directory — always the real app location, even when loaded from cache
const APP_DIR = path.dirname(require.main?.filename || __dirname);

// ── Auto-install rclaw CLI ──

function installCLI() {
  const cliSrc = path.join(APP_DIR, "..", "cli", "rclaw.js");
  const cliDst = "/usr/local/bin/rclaw";
  try {
    try { fs.unlinkSync(cliDst); } catch {}
    fs.symlinkSync(cliSrc, cliDst);
  } catch {
    try {
      const userBin = path.join(os.homedir(), ".local", "bin", "rclaw");
      fs.mkdirSync(path.dirname(userBin), { recursive: true });
      try { fs.unlinkSync(userBin); } catch {}
      fs.symlinkSync(cliSrc, userBin);
    } catch {}
  }
}

// ── Config ──

const CONFIG_DIR = path.join(os.homedir(), ".remoteclaw");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaults = {
      server: "wss://remote.momomo.dev",
      token: "CHANGE_ME",
      deviceName: os.hostname(),
      capabilities: ["shell"],
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

const config = loadConfig();
const httpBase = config.server.replace("wss://", "https://").replace("ws://", "http://");

// ── Tray icon ──

function createTrayIcon(connected) {
  const size = 22;
  const canvas = Buffer.alloc(size * size * 4, 0);
  const cx = 11, cy = 11, r = 7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r) {
        const idx = (y * size + x) * 4;
        if (connected) {
          canvas[idx] = 0; canvas[idx + 1] = 200; canvas[idx + 2] = 80; canvas[idx + 3] = 255;
        } else {
          canvas[idx] = 180; canvas[idx + 1] = 50; canvas[idx + 2] = 50; canvas[idx + 3] = 255;
        }
      }
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

// ── State ──

let daemonWs = null;
let daemonConnected = false;
let mb = null;
let isPinned = false;
let trayBounds = null;
let manualDisconnect = false;

// ── Daemon WS ──

function connectDaemon() {
  const appDeviceId = `app-${config.deviceName || os.hostname()}`;
  const url = `${config.server}/ws?device=${encodeURIComponent(appDeviceId)}&token=${encodeURIComponent(config.token)}&capabilities=`;
  daemonWs = new WebSocket(url);

  daemonWs.on("open", () => {
    daemonConnected = true;
    if (mb?.tray) mb.tray.setImage(createTrayIcon(true));
    sendToRenderer("daemon-status", { connected: true });
  });

  daemonWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "exec") {
        const proc = spawn("sh", ["-c", msg.command], { env: { ...process.env, HOME: os.homedir(), PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` }, timeout: 60000 });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (exitCode) => {
          if (daemonWs?.readyState === WebSocket.OPEN) {
            daemonWs.send(JSON.stringify({ type: "result", taskId: msg.taskId, stdout, stderr, exitCode }));
          }
        });
      }
      if (msg.type === "shell-data" || msg.type === "shell-exit") {
        sendToRenderer(msg.type, msg);
      }
    } catch {}
  });

  daemonWs.on("close", () => {
    daemonConnected = false;
    if (mb?.tray) mb.tray.setImage(createTrayIcon(false));
    sendToRenderer("daemon-status", { connected: false });
    if (!manualDisconnect) setTimeout(connectDaemon, 3000);
  });

  daemonWs.on("error", () => {});
}

function sendToRenderer(channel, data) {
  if (mb?.window?.webContents) {
    mb.window.webContents.send(channel, data);
  }
}

// ── IPC: Config ──

ipcMain.handle("get-config", () => ({ ...config, httpBase, connected: daemonConnected, raw: JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) }));

ipcMain.handle("save-config", async (_, newCfg) => {
  const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const merged = { ...existing, ...newCfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  Object.assign(config, loadConfig());
  if (daemonWs) { daemonWs.close(); }
  setTimeout(connectDaemon, 500);
  return true;
});

// ── IPC: Exec ──

ipcMain.handle("local-exec", async (_, { command, timeout = 30000 }) => {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", command], { env: { ...process.env, HOME: os.homedir(), PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` }, timeout });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
    proc.on("error", (e) => resolve({ stdout, stderr, exitCode: -1, error: e.message }));
  });
});

// ── IPC: Remote exec/devices/history (kept for backward compat, renderer can also fetch directly) ──

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

// ── IPC: Shell PTY ──

function wsSend(msg) {
  if (daemonWs?.readyState === WebSocket.OPEN) { daemonWs.send(JSON.stringify(msg)); return { ok: true }; }
  return { error: "not connected" };
}

ipcMain.handle("shell-open", (_, p) => wsSend({ type: "shell-open", sessionId: p.sessionId, to: p.device, cols: p.cols, rows: p.rows }));
ipcMain.handle("shell-input", (_, p) => wsSend({ type: "shell-input", sessionId: p.sessionId, data: p.data, to: p.device }));
ipcMain.handle("shell-resize", (_, p) => wsSend({ type: "shell-resize", sessionId: p.sessionId, cols: p.cols, rows: p.rows, to: p.device }));
ipcMain.handle("shell-close", (_, p) => wsSend({ type: "shell-close", sessionId: p.sessionId, to: p.device }));

// ── IPC: Window ──

ipcMain.handle("get-pinned", () => ({ pinned: isPinned }));
ipcMain.handle("set-pinned", (_, { pinned }) => {
  isPinned = pinned;
  mb._pinned = pinned;
  if (pinned && mb?.window) { mb.window.setAlwaysOnTop(false); mb.window.setVisibleOnAllWorkspaces(false); }
  sendToRenderer("pinned-changed", { pinned });
  return { ok: true };
});

ipcMain.handle("toggle-connection", () => {
  if (daemonConnected || daemonWs) {
    manualDisconnect = true;
    if (daemonWs) { daemonWs.removeAllListeners("close"); daemonWs.close(); daemonWs = null; }
    daemonConnected = false;
    if (mb?.tray) mb.tray.setImage(createTrayIcon(false));
    sendToRenderer("daemon-status", { connected: false });
    return { connected: false };
  } else {
    manualDisconnect = false;
    connectDaemon();
    return { connected: true };
  }
});

ipcMain.handle("close-window", () => {
  if (mb?.window) { isPinned = false; mb._pinned = false; mb.window.hide(); }
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
ipcMain.handle("win-set-opacity", (_, { opacity }) => { if (mb?.window) mb.window.setOpacity(opacity); });
ipcMain.handle("win-open-devtools", () => { if (mb?.window) mb.window.webContents.openDevTools({ mode: "detach" }); });

// ── IPC: Detach tab into independent window ──

const detachedWindows = new Map();
const allIndependentWindows = new Set();

function trackIndependentWindow(win) {
  allIndependentWindows.add(win);
  // Show dock when first independent window opens
  if (allIndependentWindows.size === 1 && app.dock) app.dock.show();
  win.on("closed", () => {
    allIndependentWindows.delete(win);
    // Hide dock when all independent windows closed
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
    title: title || `RemoteClaw — ${tab}`,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(APP_DIR, "preload.js") },
  });

  const CLOUD_URL = "https://momomo-agent.github.io/remote-claw/";
  const url = new URL(CLOUD_URL);
  url.searchParams.set("tab", tab);
  url.searchParams.set("device", device || "");
  url.searchParams.set("detached", "1");
  win.loadURL(url.toString());

  detachedWindows.set(tab, win);
  trackIndependentWindow(win);
  win.on("closed", () => detachedWindows.delete(tab));
  return { ok: true };
});

ipcMain.handle("open-preview", (_, { file, device, title }) => {
  const { BrowserWindow } = require("electron");
  const CLOUD_URL = "https://momomo-agent.github.io/remote-claw/";
  const win = new BrowserWindow({
    width: 900, height: 620, minWidth: 600, minHeight: 400,
    title: title || `Preview — ${file.split('/').pop()}`,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(APP_DIR, "preload.js") },
  });
  const url = new URL(CLOUD_URL + "preview.html");
  url.searchParams.set("file", file);
  url.searchParams.set("device", device || "");
  win.loadURL(url.toString());
  trackIndependentWindow(win);
  return { ok: true };
});

ipcMain.handle("open-editor", async (_, { dir, file, device, title }) => {
  const { BrowserWindow } = require("electron");
  const CLOUD_URL = "https://momomo-agent.github.io/remote-claw/";
  const win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 700, minHeight: 500,
    title: title || "RemoteClaw Editor",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(APP_DIR, "preload.js") },
  });
  const url = new URL(CLOUD_URL + "editor.html");
  if (dir) url.searchParams.set("dir", dir);
  if (file) url.searchParams.set("file", file);
  if (device) url.searchParams.set("device", device);
  try { await win.loadURL(url.toString()); } catch(e) { console.error("editor load failed:", e.message); }
  trackIndependentWindow(win);
  return { ok: true };
});

ipcMain.handle("open-code-server", async (_, { device, folder }) => {
  const { BrowserWindow } = require("electron");
  // Try to resolve device IP via exec
  let host = "127.0.0.1";
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".remoteclaw", "config.json"), "utf-8"));
    const httpBase = cfg.httpBase || cfg.server?.replace('wss://', 'https://').replace('ws://', 'http://');
    const token = cfg.token;
    if (device && httpBase) {
      const fetch = require("electron").net.fetch || globalThis.fetch;
      const res = await fetch(`${httpBase}/exec`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device, command: 'ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk "{print \\$1}"', oneshot: true, timeout: 5000 }),
      });
      const data = await res.json();
      const ip = (data.stdout || '').trim().split(/\s+/)[0];
      if (ip && /^[\d.]+$/.test(ip)) host = ip;
    }
  } catch (e) { /* fallback to localhost */ }
  const codeUrl = `http://${host}:8080` + (folder ? `/?folder=${encodeURIComponent(folder)}` : '');
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 600,
    title: "VS Code — " + (device || "local"),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false },
  });
  win.loadURL(codeUrl);
  trackIndependentWindow(win);
  return { ok: true };
});

ipcMain.handle("read-file", async (_, p) => { try { return { data: fs.readFileSync(p, "utf-8") }; } catch (e) { return { error: e.message }; } });
ipcMain.handle("write-file", async (_, { path: p, data }) => { try { fs.writeFileSync(p, data); return { ok: true }; } catch (e) { return { error: e.message }; } });
ipcMain.handle("read-file-base64", async (_, p) => { try { return { data: fs.readFileSync(p).toString("base64"), size: fs.statSync(p).size }; } catch (e) { return { error: e.message }; } });
ipcMain.handle("write-file-base64", async (_, { path: p, data }) => { try { fs.writeFileSync(p, Buffer.from(data, "base64")); return { ok: true }; } catch (e) { return { error: e.message }; } });
ipcMain.handle("list-dir", async (_, p) => { try { return fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile(), isSymlink: e.isSymbolicLink() })); } catch (e) { return { error: e.message }; } });
ipcMain.handle("file-stat", async (_, p) => { try { const s = fs.statSync(p); return { size: s.size, isDir: s.isDirectory(), isFile: s.isFile(), mtime: s.mtime, ctime: s.ctime, mode: s.mode }; } catch (e) { return { error: e.message }; } });
ipcMain.handle("mkdir", async (_, p) => { try { fs.mkdirSync(p, { recursive: true }); return { ok: true }; } catch (e) { return { error: e.message }; } });
ipcMain.handle("rename", async (_, { from, to }) => { try { fs.renameSync(from, to); return { ok: true }; } catch (e) { return { error: e.message }; } });
ipcMain.handle("delete-file", async (_, p) => { try { const s = fs.statSync(p); s.isDirectory() ? fs.rmSync(p, { recursive: true }) : fs.unlinkSync(p); return { ok: true }; } catch (e) { return { error: e.message }; } });
ipcMain.handle("copy-file", async (_, { from, to }) => { try { fs.copyFileSync(from, to); return { ok: true }; } catch (e) { return { error: e.message }; } });

// ── IPC: Electron native APIs ──

ipcMain.handle("app-info", () => ({ version: require("./package.json").version, platform: process.platform, arch: process.arch, hostname: os.hostname(), homedir: os.homedir() }));
ipcMain.handle("clipboard-read", () => { const { clipboard } = require("electron"); return { text: clipboard.readText(), html: clipboard.readHTML(), hasImage: !clipboard.readImage().isEmpty() }; });
ipcMain.handle("clipboard-write", (_, { text, html }) => { const { clipboard } = require("electron"); html ? clipboard.writeHTML(html) : clipboard.writeText(text); return { ok: true }; });
ipcMain.handle("clipboard-read-image", () => { const { clipboard } = require("electron"); const img = clipboard.readImage(); return img.isEmpty() ? { empty: true } : { dataUrl: img.toDataURL(), size: img.getSize() }; });
ipcMain.handle("clipboard-write-image", (_, { dataUrl }) => { const { clipboard, nativeImage } = require("electron"); clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)); return { ok: true }; });
ipcMain.handle("notify", (_, { title, body, silent }) => { new (require("electron").Notification)({ title, body, silent: silent ?? false }).show(); return { ok: true }; });
ipcMain.handle("dialog-open-file", async (_, opts = {}) => { const r = await require("electron").dialog.showOpenDialog(mb?.window, { properties: opts.directory ? ["openDirectory"] : ["openFile"], filters: opts.filters, defaultPath: opts.defaultPath, title: opts.title, buttonLabel: opts.buttonLabel }); return { canceled: r.canceled, paths: r.filePaths }; });
ipcMain.handle("dialog-save-file", async (_, opts = {}) => { const r = await require("electron").dialog.showSaveDialog(mb?.window, { filters: opts.filters, defaultPath: opts.defaultPath, title: opts.title }); return { canceled: r.canceled, path: r.filePath }; });
ipcMain.handle("dialog-message", async (_, { type, title, message, buttons, detail }) => { const r = await require("electron").dialog.showMessageBox(mb?.window, { type: type || "info", title, message, buttons: buttons || ["OK"], detail }); return { response: r.response }; });
ipcMain.handle("shell-open-external", (_, { url }) => require("electron").shell.openExternal(url));
ipcMain.handle("shell-open-path", (_, { path: p }) => require("electron").shell.openPath(p));
ipcMain.handle("shell-show-in-folder", (_, { path: p }) => { require("electron").shell.showItemInFolder(p); return { ok: true }; });
ipcMain.handle("shell-trash", async (_, { path: p }) => { await require("electron").shell.trashItem(p); return { ok: true }; });
ipcMain.handle("screen-info", () => { const { screen } = require("electron"); return { primary: screen.getPrimaryDisplay().bounds, all: screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor })), cursor: screen.getCursorScreenPoint() }; });
ipcMain.handle("screenshot", async () => { try { const s = await require("electron").desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 } }); return s.length ? { dataUrl: s[0].thumbnail.toDataURL() } : { error: "no screen" }; } catch (e) { return { error: e.message }; } });
ipcMain.handle("system-info", () => ({ platform: process.platform, arch: process.arch, nodeVersion: process.version, electronVersion: process.versions.electron, hostname: os.hostname(), homedir: os.homedir(), tmpdir: os.tmpdir(), cpus: os.cpus().length, totalMemory: os.totalmem(), freeMemory: os.freemem(), uptime: os.uptime() }));
ipcMain.handle("download-file", async (_, { url, dest }) => { try { const h = url.startsWith("https") ? require("https") : require("http"); const f = fs.createWriteStream(dest); return new Promise((res, rej) => { h.get(url, r => { r.pipe(f); f.on("finish", () => { f.close(); res({ ok: true, path: dest }); }); }).on("error", e => { fs.unlinkSync(dest); rej({ error: e.message }); }); }); } catch (e) { return { error: e.message }; } });
ipcMain.handle("power-state", () => { const { powerMonitor } = require("electron"); return { onBattery: powerMonitor.isOnBatteryPower?.() ?? null, idle: powerMonitor.getSystemIdleTime() }; });
ipcMain.handle("tray-set-tooltip", (_, { text }) => { if (mb?.tray) mb.tray.setToolTip(text); return { ok: true }; });
ipcMain.handle("navigate", (_, { url }) => { if (mb?.window) mb.window.loadURL(url); return { ok: true }; });
ipcMain.handle("get-url", () => mb?.window?.webContents?.getURL());
ipcMain.handle("get-cookies", async (_, { url }) => mb?.window ? mb.window.webContents.session.cookies.get({ url }) : []);
ipcMain.handle("set-cookie", async (_, cookie) => { if (!mb?.window) return { error: "no window" }; await mb.window.webContents.session.cookies.set(cookie); return { ok: true }; });

// ── IPC: Eval (ultimate flexibility) ──

ipcMain.handle("eval", async (_, { code }) => {
  try {
    const electron = require("electron");
    const fn = new Function("require", "app", "mb", "os", "fs", "path", "spawn", "electron", "config", "daemonWs", "daemonConnected",
      `return (async () => { ${code} })();`);
    const result = await fn(require, app, mb, os, fs, path, spawn, electron, config, daemonWs, daemonConnected);
    return { ok: true, result };
  } catch (e) { return { ok: false, error: e.message, stack: e.stack }; }
});

// ── Menubar setup ──

const CLOUD_URL = "https://momomo-agent.github.io/remote-claw/";
const LOCAL_URL = `file://${path.join(APP_DIR, "renderer", "index.html")}`;

installCLI();

mb = menubar({
  index: CLOUD_URL,
  icon: createTrayIcon(false),
  preloadWindow: true,
  browserWindow: {
    width: 420, height: 560, minWidth: 320, minHeight: 400,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(APP_DIR, "preload.js") },
    resizable: true, skipTaskbar: true,
  },
  showDockIcon: false,
});

mb.on("ready", () => {
  connectDaemon();

  const { Menu } = require("electron");
  let trayMenu = Menu.buildFromTemplate([
    { label: "Show", click: () => mb.showWindow() },
    { label: "Devices", click: () => { mb.showWindow(); sendToRenderer("navigate-tab", "devices"); } },
    { label: "Terminal", click: () => { mb.showWindow(); sendToRenderer("navigate-tab", "terminal"); } },
    { type: "separator" },
    { label: "Connect", type: "checkbox", checked: daemonConnected, click: (item) => {
      if (daemonConnected || daemonWs) {
        manualDisconnect = true;
        if (daemonWs) { daemonWs.removeAllListeners("close"); daemonWs.close(); daemonWs = null; }
        daemonConnected = false;
        if (mb?.tray) mb.tray.setImage(createTrayIcon(false));
        sendToRenderer("daemon-status", { connected: false });
        item.checked = false;
      } else { manualDisconnect = false; connectDaemon(); item.checked = true; }
    }},
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  mb.tray.on("right-click", () => { trayMenu.items[4].checked = daemonConnected; mb.tray.popUpContextMenu(trayMenu); });

  ipcMain.handle("tray-set-menu", (_, { items }) => {
    const template = items.map(item => item.type === "separator" ? { type: "separator" } : {
      label: item.label, type: item.type || "normal", checked: item.checked, enabled: item.enabled !== false,
      click: () => sendToRenderer("tray-menu-click", { id: item.id }),
    });
    template.push({ type: "separator" }, { label: "Quit", click: () => app.quit() });
    trayMenu = Menu.buildFromTemplate(template);
    return { ok: true };
  });

  mb.on("show", () => { sendToRenderer("refresh", {}); if (!isPinned && mb.tray) trayBounds = mb.tray.getBounds(); });
});

mb.on("after-create-window", () => {
  mb.window.webContents.on("did-fail-load", (_, __, desc, url) => { if (url === CLOUD_URL) mb.window.loadURL(LOCAL_URL); });
  mb.window.on("move", () => sendToRenderer("window-moved", { bounds: mb.window.getBounds(), trayBounds }));
  mb.window.removeAllListeners("blur");
  mb.window.on("blur", () => { if (!isPinned) mb.hideWindow(); });
  mb.window.on("hide", () => sendToRenderer("window-hidden", {}));
  const origHide = mb.window.hide.bind(mb.window);
  mb.window.hide = () => { if (!isPinned) origHide(); };
});

mb.on("show", () => { if (isPinned) return; });
mb.on("hide", () => {});

setTimeout(() => {
  if (mb) {
    const origHideWindow = mb.hideWindow.bind(mb);
    mb.hideWindow = () => { if (!isPinned) origHideWindow(); };
  }
}, 100);
