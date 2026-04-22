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

// ── App ──

const CLOUD_URL = "https://remote.momomo.dev/app";
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
