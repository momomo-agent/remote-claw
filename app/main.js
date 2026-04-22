// RemoteClaw Bootstrap — never needs updating
// Fetches latest main-logic.js from GitHub, falls back to bundled version

const { app, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");

const LOGIC_URL = "https://raw.githubusercontent.com/momomo-agent/remote-claw/main/app/main-logic.js";
const LOCAL_LOGIC = path.join(__dirname, "main-logic.js");
const CACHE_DIR = path.join(require("os").homedir(), ".remoteclaw");
const CACHED_LOGIC = path.join(CACHE_DIR, "main-logic.js");

function fetchText(url, timeout = 5000) {
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

async function loadLogic() {
  // Try fetch latest from GitHub
  try {
    const code = await fetchText(LOGIC_URL);
    if (code && code.length > 100) {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHED_LOGIC, code);
      console.log("[bootstrap] Updated main-logic.js from GitHub");
    }
  } catch (e) {
    console.log("[bootstrap] GitHub fetch failed, using cached/bundled:", e.message);
  }

  // Priority: cached (latest from GitHub) > bundled
  const logicPath = fs.existsSync(CACHED_LOGIC) ? CACHED_LOGIC : LOCAL_LOGIC;
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
    const code = await fetchText(LOGIC_URL);
    if (code && code.length > 100) {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHED_LOGIC, code);
      app.relaunch();
      app.exit(0);
      return { ok: true };
    }
    return { error: "empty response" };
  } catch (e) {
    return { error: e.message };
  }
});

app.whenReady().then(loadLogic);
app.on("window-all-closed", (e) => e.preventDefault());
