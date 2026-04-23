// RemoteClaw Bootstrap — never needs updating
// Fetches latest main-logic.js from GitHub, falls back to bundled version
// Update strategy: bundled always works, cached only used if validated

const { app, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const LOGIC_URLS = [
  "https://raw.githubusercontent.com/momomo-agent/remote-claw/main/app/main-logic.js",
  "https://cdn.jsdelivr.net/gh/momomo-agent/remote-claw@main/app/main-logic.js",
];
const LOCAL_LOGIC = path.join(__dirname, "main-logic.js");
const CACHE_DIR = path.join(require("os").homedir(), ".remoteclaw");
const CACHED_LOGIC = path.join(CACHE_DIR, "main-logic.js");
const CACHED_META = path.join(CACHE_DIR, "main-logic.meta.json");

function fetchText(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, timeout).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = "";
      res.on("data", (d) => { data += d; });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function isValidLogic(code) {
  // Must be JS, not HTML error page or truncated
  if (!code || code.length < 500) return false;
  if (code.startsWith("<") || code.startsWith("<!DOCTYPE")) return false;
  if (!code.includes("connectDaemon") || !code.includes("ipcMain")) return false;
  return true;
}

function sha256(str) { return crypto.createHash("sha256").update(str).digest("hex"); }

async function fetchLatest() {
  for (const url of LOGIC_URLS) {
    try {
      const code = await fetchText(url);
      if (isValidLogic(code)) return code;
      console.log(`[bootstrap] Invalid content from ${url}, trying next...`);
    } catch (e) {
      console.log(`[bootstrap] ${url} failed: ${e.message}`);
    }
  }
  return null;
}

async function loadLogic() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Try fetch latest from GitHub (non-blocking for startup)
  try {
    const code = await fetchLatest();
    if (code) {
      const hash = sha256(code);
      // Only write if different from cached
      let cachedHash = "";
      try { cachedHash = JSON.parse(fs.readFileSync(CACHED_META, "utf-8")).hash; } catch {}
      if (hash !== cachedHash) {
        fs.writeFileSync(CACHED_LOGIC, code);
        fs.writeFileSync(CACHED_META, JSON.stringify({ hash, updatedAt: new Date().toISOString(), size: code.length }));
        console.log(`[bootstrap] Updated main-logic.js (${code.length} bytes)`);
      } else {
        console.log("[bootstrap] main-logic.js is up to date");
      }
    }
  } catch (e) {
    console.log("[bootstrap] Update check failed:", e.message);
  }

  // Priority: validated cached > bundled
  let logicPath = LOCAL_LOGIC;
  if (fs.existsSync(CACHED_LOGIC)) {
    try {
      const cached = fs.readFileSync(CACHED_LOGIC, "utf-8");
      if (isValidLogic(cached)) {
        logicPath = CACHED_LOGIC;
      } else {
        console.log("[bootstrap] Cached logic invalid, removing");
        fs.unlinkSync(CACHED_LOGIC);
      }
    } catch {}
  }
  console.log("[bootstrap] Loading:", logicPath);

  // Ensure cached logic can find node_modules from app directory
  if (logicPath !== LOCAL_LOGIC) {
    const Module = require("module");
    const appNodeModules = path.join(__dirname, "node_modules");
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function(request, parent, ...args) {
      try { return origResolve.call(this, request, parent, ...args); }
      catch (e) {
        // Retry with app's node_modules
        const altPath = path.join(appNodeModules, request);
        if (fs.existsSync(altPath) || fs.existsSync(altPath + '.js') || fs.existsSync(path.join(altPath, 'index.js'))) {
          return origResolve.call(this, altPath, parent, ...args);
        }
        throw e;
      }
    };
  }

  require(logicPath);
}

// Restart handler — available before logic loads
ipcMain.handle("restart", () => {
  app.relaunch();
  app.exit(0);
});

// Self-update: fetch latest logic + restart
ipcMain.handle("self-update", async () => {
  try {
    const code = await fetchLatest();
    if (code) {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHED_LOGIC, code);
      fs.writeFileSync(CACHED_META, JSON.stringify({ hash: sha256(code), updatedAt: new Date().toISOString(), size: code.length }));
      app.relaunch();
      app.exit(0);
      return { ok: true };
    }
    return { error: "no valid source available" };
  } catch (e) {
    return { error: e.message };
  }
});

app.whenReady().then(loadLogic);
app.on("window-all-closed", (e) => e.preventDefault());
