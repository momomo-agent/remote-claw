// RemoteClaw Electron Menubar App

const { app, nativeImage, ipcMain } = require("electron");
const { menubar } = require("menubar");
const path = require("path");
const { spawn, execSync } = require("child_process");
const WebSocket = require("ws");
const fs = require("fs");
const os = require("os");

// ── Auto-install rclaw CLI ──

function installCLI() {
  const cliSrc = path.join(__dirname, "..", "cli", "rclaw.js");
  const cliDst = "/usr/local/bin/rclaw";
  try {
    try { fs.unlinkSync(cliDst); } catch {}
    fs.symlinkSync(cliSrc, cliDst);
    console.log("Installed rclaw CLI to", cliDst);
  } catch {
    try {
      const userBin = path.join(os.homedir(), ".local", "bin", "rclaw");
      fs.mkdirSync(path.dirname(userBin), { recursive: true });
      try { fs.unlinkSync(userBin); } catch {}
      fs.symlinkSync(cliSrc, userBin);
      console.log("Installed rclaw CLI to", userBin);
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

// ── Tray icon (template image for macOS dark/light) ──

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

// ── Embedded Daemon Connection ──

let daemonWs = null;
let daemonConnected = false;
let mb = null;

// ── Window pinning state ──
let isPinned = false;
let trayBounds = null;
let manualDisconnect = false;

function connectDaemon() {
  const url = `${config.server}/ws?device=${encodeURIComponent(config.deviceName)}&token=${encodeURIComponent(config.token)}&capabilities=${encodeURIComponent(config.capabilities.join(","))}`;
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
        const proc = spawn("sh", ["-c", msg.command], { env: { ...process.env, HOME: os.homedir() }, timeout: 60000 });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (exitCode) => {
          if (daemonWs?.readyState === WebSocket.OPEN) {
            daemonWs.send(JSON.stringify({ type: "result", taskId: msg.taskId, stdout, stderr, exitCode }));
          }
        });
      }
      // Forward shell messages from daemon to renderer
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

// ── IPC handlers ──

ipcMain.handle("get-config", () => ({ ...config, httpBase, connected: daemonConnected, raw: JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) }));

// Generic shell exec — lets cloud UI run arbitrary local commands
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

// Read/write local files — lets cloud UI access filesystem
ipcMain.handle("read-file", async (_, filePath) => {
  try { return { data: fs.readFileSync(filePath, "utf-8") }; }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle("write-file", async (_, { path: filePath, data }) => {
  try { fs.writeFileSync(filePath, data); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});

// App info
ipcMain.handle("app-info", () => ({
  version: require("./package.json").version,
  platform: process.platform,
  arch: process.arch,
  hostname: os.hostname(),
  homedir: os.homedir(),
}));

ipcMain.handle("fetch-devices", async () => {
  try {
    const res = await fetch(`${httpBase}/devices`, { headers: { Authorization: `Bearer ${config.token}` } });
    return await res.json();
  } catch { return []; }
});

ipcMain.handle("fetch-history", async (_, limit = 50) => {
  try {
    const res = await fetch(`${httpBase}/history?limit=${limit}`, { headers: { Authorization: `Bearer ${config.token}` } });
    return await res.json();
  } catch { return []; }
});

ipcMain.handle("exec-command", async (_, { device, command }) => {
  try {
    const res = await fetch(`${httpBase}/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device, command, oneshot: true, timeout: 30000 }),
    });
    return await res.json();
  } catch (e) { return { error: e.message }; }
});

// ── Shell session IPC (PTY over WS) ──

ipcMain.handle("shell-open", (_, { device, sessionId, cols, rows }) => {
  if (daemonWs?.readyState === WebSocket.OPEN) {
    daemonWs.send(JSON.stringify({ type: "shell-open", sessionId, to: device, cols, rows }));
    return { ok: true };
  }
  return { error: "not connected" };
});

ipcMain.handle("shell-input", (_, { sessionId, data, device }) => {
  if (daemonWs?.readyState === WebSocket.OPEN) {
    daemonWs.send(JSON.stringify({ type: "shell-input", sessionId, data, to: device }));
    return { ok: true };
  }
  return { error: "not connected" };
});

ipcMain.handle("shell-resize", (_, { sessionId, cols, rows, device }) => {
  if (daemonWs?.readyState === WebSocket.OPEN) {
    daemonWs.send(JSON.stringify({ type: "shell-resize", sessionId, cols, rows, to: device }));
    return { ok: true };
  }
  return { error: "not connected" };
});

ipcMain.handle("shell-close", (_, { sessionId, device }) => {
  if (daemonWs?.readyState === WebSocket.OPEN) {
    daemonWs.send(JSON.stringify({ type: "shell-close", sessionId, to: device }));
    return { ok: true };
  }
  return { error: "not connected" };
});

ipcMain.handle("save-config", async (_, newCfg) => {
  const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const merged = { ...existing, ...newCfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  Object.assign(config, loadConfig());
  if (daemonWs) { daemonWs.close(); }
  setTimeout(connectDaemon, 500);
  return true;
});

ipcMain.handle("get-pinned", () => ({ pinned: isPinned }));

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
  if (mb?.window) {
    isPinned = false;
    mb.window.hide();
    sendToRenderer("pinned-changed", { pinned: false });
  }
});

// ── Window control ──

ipcMain.handle("win-get-bounds", () => mb?.window?.getBounds());

ipcMain.handle("win-set-bounds", (_, bounds) => {
  if (mb?.window) mb.window.setBounds(bounds);
});

ipcMain.handle("win-set-size", (_, { width, height }) => {
  if (mb?.window) mb.window.setSize(width, height);
});

ipcMain.handle("win-set-position", (_, { x, y }) => {
  if (mb?.window) mb.window.setPosition(x, y);
});

ipcMain.handle("win-set-always-on-top", (_, { flag }) => {
  if (mb?.window) mb.window.setAlwaysOnTop(flag);
  return { alwaysOnTop: flag };
});

ipcMain.handle("win-is-always-on-top", () => mb?.window?.isAlwaysOnTop());

ipcMain.handle("win-minimize", () => { if (mb?.window) mb.window.minimize(); });

ipcMain.handle("win-maximize", () => {
  if (mb?.window) {
    if (mb.window.isMaximized()) mb.window.unmaximize();
    else mb.window.maximize();
  }
  return { maximized: mb?.window?.isMaximized() };
});

ipcMain.handle("win-set-title", (_, { title }) => {
  if (mb?.window) mb.window.setTitle(title);
});

ipcMain.handle("win-set-opacity", (_, { opacity }) => {
  if (mb?.window) mb.window.setOpacity(opacity);
});

ipcMain.handle("win-open-devtools", () => {
  if (mb?.window) mb.window.webContents.openDevTools({ mode: "detach" });
});

// ── Clipboard ──

ipcMain.handle("clipboard-read", () => {
  const { clipboard } = require("electron");
  return { text: clipboard.readText(), html: clipboard.readHTML(), hasImage: !clipboard.readImage().isEmpty() };
});

ipcMain.handle("clipboard-write", (_, { text, html }) => {
  const { clipboard } = require("electron");
  if (html) clipboard.writeHTML(html);
  else if (text) clipboard.writeText(text);
  return { ok: true };
});

ipcMain.handle("clipboard-read-image", () => {
  const { clipboard } = require("electron");
  const img = clipboard.readImage();
  if (img.isEmpty()) return { empty: true };
  return { dataUrl: img.toDataURL(), size: img.getSize() };
});

ipcMain.handle("clipboard-write-image", (_, { dataUrl }) => {
  const { clipboard, nativeImage } = require("electron");
  clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
  return { ok: true };
});

// ── Notifications ──

ipcMain.handle("notify", (_, { title, body, silent }) => {
  const { Notification } = require("electron");
  new Notification({ title, body, silent: silent ?? false }).show();
  return { ok: true };
});

// ── Dialogs ──

ipcMain.handle("dialog-open-file", async (_, opts = {}) => {
  const { dialog } = require("electron");
  const result = await dialog.showOpenDialog(mb?.window, {
    properties: opts.directory ? ["openDirectory"] : ["openFile"],
    filters: opts.filters,
    defaultPath: opts.defaultPath,
    title: opts.title,
    buttonLabel: opts.buttonLabel,
    multiSelections: opts.multi ? true : false,
  });
  return { canceled: result.canceled, paths: result.filePaths };
});

ipcMain.handle("dialog-save-file", async (_, opts = {}) => {
  const { dialog } = require("electron");
  const result = await dialog.showSaveDialog(mb?.window, {
    filters: opts.filters,
    defaultPath: opts.defaultPath,
    title: opts.title,
  });
  return { canceled: result.canceled, path: result.filePath };
});

ipcMain.handle("dialog-message", async (_, { type, title, message, buttons, detail }) => {
  const { dialog } = require("electron");
  const result = await dialog.showMessageBox(mb?.window, {
    type: type || "info", title, message, buttons: buttons || ["OK"], detail,
  });
  return { response: result.response };
});

// ── Shell / OS ──

ipcMain.handle("shell-open-external", (_, { url }) => {
  const { shell } = require("electron");
  return shell.openExternal(url);
});

ipcMain.handle("shell-open-path", (_, { path: p }) => {
  const { shell } = require("electron");
  return shell.openPath(p);
});

ipcMain.handle("shell-show-in-folder", (_, { path: p }) => {
  const { shell } = require("electron");
  shell.showItemInFolder(p);
  return { ok: true };
});

ipcMain.handle("shell-trash", async (_, { path: p }) => {
  const { shell } = require("electron");
  await shell.trashItem(p);
  return { ok: true };
});

// ── Screen info ──

ipcMain.handle("screen-info", () => {
  const { screen } = require("electron");
  return {
    primary: screen.getPrimaryDisplay().bounds,
    all: screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor })),
    cursor: screen.getCursorScreenPoint(),
  };
});

// ── Screenshot (local machine) ──

ipcMain.handle("screenshot", async (_, { fullscreen } = {}) => {
  const { desktopCapturer } = require("electron");
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 } });
    if (sources.length > 0) {
      return { dataUrl: sources[0].thumbnail.toDataURL() };
    }
    return { error: "no screen source" };
  } catch (e) { return { error: e.message }; }
});

// ── System info ──

ipcMain.handle("system-info", () => ({
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  hostname: os.hostname(),
  homedir: os.homedir(),
  tmpdir: os.tmpdir(),
  cpus: os.cpus().length,
  totalMemory: os.totalmem(),
  freeMemory: os.freemem(),
  uptime: os.uptime(),
  networkInterfaces: Object.fromEntries(
    Object.entries(os.networkInterfaces()).map(([k, v]) => [k, v.filter(i => !i.internal).map(i => ({ address: i.address, family: i.family }))])
  ),
}));

// ── Download file (from URL to local) ──

ipcMain.handle("download-file", async (_, { url, dest }) => {
  try {
    const https = url.startsWith("https") ? require("https") : require("http");
    const file = fs.createWriteStream(dest);
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve({ ok: true, path: dest }); });
      }).on("error", (e) => { fs.unlinkSync(dest); reject({ error: e.message }); });
    });
  } catch (e) { return { error: e.message }; }
});

// ── Read file as base64 (for binary files / images) ──

ipcMain.handle("read-file-base64", async (_, filePath) => {
  try { return { data: fs.readFileSync(filePath).toString("base64"), size: fs.statSync(filePath).size }; }
  catch (e) { return { error: e.message }; }
});

// ── Write file from base64 ──

ipcMain.handle("write-file-base64", async (_, { path: filePath, data }) => {
  try { fs.writeFileSync(filePath, Buffer.from(data, "base64")); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});

// ── List directory ──

ipcMain.handle("list-dir", async (_, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map(e => ({
      name: e.name,
      isDir: e.isDirectory(),
      isFile: e.isFile(),
      isSymlink: e.isSymbolicLink(),
    }));
  } catch (e) { return { error: e.message }; }
});

// ── File stat ──

ipcMain.handle("file-stat", async (_, filePath) => {
  try {
    const s = fs.statSync(filePath);
    return { size: s.size, isDir: s.isDirectory(), isFile: s.isFile(), mtime: s.mtime, ctime: s.ctime, mode: s.mode };
  } catch (e) { return { error: e.message }; }
});

// ── File operations ──

ipcMain.handle("mkdir", async (_, dirPath) => {
  try { fs.mkdirSync(dirPath, { recursive: true }); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle("rename", async (_, { from, to }) => {
  try { fs.renameSync(from, to); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle("delete-file", async (_, filePath) => {
  try {
    const s = fs.statSync(filePath);
    if (s.isDirectory()) fs.rmSync(filePath, { recursive: true });
    else fs.unlinkSync(filePath);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle("copy-file", async (_, { from, to }) => {
  try { fs.copyFileSync(from, to); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});

// ── Tray ──

ipcMain.handle("tray-set-tooltip", (_, { text }) => {
  if (mb?.tray) mb.tray.setToolTip(text);
  return { ok: true };
});

// ── Navigation (load different URL in window) ──

ipcMain.handle("navigate", (_, { url }) => {
  if (mb?.window) mb.window.loadURL(url);
  return { ok: true };
});

ipcMain.handle("get-url", () => mb?.window?.webContents?.getURL());

// ── Cookies / Storage ──

ipcMain.handle("get-cookies", async (_, { url }) => {
  if (!mb?.window) return [];
  return mb.window.webContents.session.cookies.get({ url });
});

ipcMain.handle("set-cookie", async (_, cookie) => {
  if (!mb?.window) return { error: "no window" };
  await mb.window.webContents.session.cookies.set(cookie);
  return { ok: true };
});

// ── Power monitor ──

ipcMain.handle("power-state", () => {
  const { powerMonitor } = require("electron");
  return {
    onBattery: powerMonitor.isOnBatteryPower?.() ?? null,
    idle: powerMonitor.getSystemIdleTime(),
  };
});

// ── App ──

// Generic eval — ultimate flexibility, cloud UI can run any code in main process
ipcMain.handle("eval", async (_, { code }) => {
  try {
    const { app: eApp, clipboard, dialog, shell, screen, desktopCapturer, Notification, powerMonitor, nativeImage } = require("electron");
    const fn = new Function(
      "require", "app", "mb", "os", "fs", "path", "spawn",
      "clipboard", "dialog", "shell", "screen", "desktopCapturer", "Notification", "powerMonitor", "nativeImage",
      "config", "daemonWs", "daemonConnected",
      `return (async () => { ${code} })();`
    );
    const result = await fn(
      require, eApp, mb, os, fs, path, spawn,
      clipboard, dialog, shell, screen, desktopCapturer, Notification, powerMonitor, nativeImage,
      config, daemonWs, daemonConnected
    );
    return { ok: true, result };
  } catch (e) { return { ok: false, error: e.message, stack: e.stack }; }
});

const CLOUD_URL = "https://momomo-agent.github.io/remote-claw/";
const LOCAL_URL = `file://${path.join(__dirname, "renderer", "index.html")}`;

app.on("ready", () => {
  installCLI();
  mb = menubar({
    index: CLOUD_URL,
    icon: createTrayIcon(false),
    preloadWindow: true,
    browserWindow: {
      width: 420,
      height: 560,
      minWidth: 320,
      minHeight: 400,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
      },
      resizable: true,
      skipTaskbar: true,
    },
    showDockIcon: false,
  });

  mb.on("ready", () => {
    connectDaemon();

    // Right-click context menu on tray
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
        } else {
          manualDisconnect = false;
          connectDaemon();
          item.checked = true;
        }
      }},
      { type: "separator" },
      { label: "Quit", click: () => { app.quit(); } },
    ]);
    mb.tray.on("right-click", () => {
      // Update connect checkbox state
      trayMenu.items[4].checked = daemonConnected;
      mb.tray.popUpContextMenu(trayMenu);
    });

    // IPC to update tray menu from cloud UI
    ipcMain.handle("tray-set-menu", (_, { items }) => {
      const template = items.map(item => {
        if (item.type === "separator") return { type: "separator" };
        return {
          label: item.label,
          type: item.type || "normal",
          checked: item.checked,
          enabled: item.enabled !== false,
          click: () => sendToRenderer("tray-menu-click", { id: item.id }),
        };
      });
      // Always append Quit
      template.push({ type: "separator" });
      template.push({ label: "Quit", click: () => app.quit() });
      trayMenu = Menu.buildFromTemplate(template);
      return { ok: true };
    });

    mb.on("show", () => {
      sendToRenderer("refresh", {});
      // Record tray position when shown normally
      if (!isPinned && mb.tray) {
        trayBounds = mb.tray.getBounds();
      }
    });
  });

  mb.on("after-create-window", () => {
    // Fallback to local HTML if cloud URL fails
    mb.window.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
      if (validatedURL === CLOUD_URL) {
        console.log("Cloud UI failed to load, falling back to local:", errorDescription);
        mb.window.loadURL(LOCAL_URL);
      }
    });

    // Track window movement for pinning
    mb.window.on("move", () => {
      if (isPinned || !trayBounds) return;
      const winBounds = mb.window.getBounds();
      const dx = Math.abs(winBounds.x - (trayBounds.x - winBounds.width / 2 + trayBounds.width / 2));
      const dy = Math.abs(winBounds.y - (trayBounds.y + trayBounds.height));
      if (dx > 50 || dy > 50) {
        isPinned = true;
        sendToRenderer("pinned-changed", { pinned: true });
      }
    });

    // When window is hidden (e.g. by menubar auto-hide or close button), reset pin
    mb.window.on("hide", () => {
      if (isPinned) {
        isPinned = false;
        sendToRenderer("pinned-changed", { pinned: false });
      }
    });
  });

  // Override menubar's show/hide behavior when pinned
  mb.on("show", () => {
    if (isPinned) return;
  });

  // Prevent hide when pinned
  mb.on("hide", () => {});
});

// Prevent menubar from hiding window when pinned (on tray click)
const origShowWindow = null;
app.on("ready", () => {
  const checkPinned = () => {
    if (!mb) return;
    const origHideWindow = mb.hideWindow.bind(mb);
    mb.hideWindow = () => {
      if (isPinned) return; // Don't hide when pinned
      origHideWindow();
    };
  };
  setTimeout(checkPinned, 100);
});

app.on("window-all-closed", (e) => e.preventDefault());
