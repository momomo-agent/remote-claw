// RemoteClaw Bootstrap — never needs updating
// Update strategy: start with known-good, stage updates, promote on successful boot
//
// Files in ~/.remoteclaw/:
//   main-logic.js        — last known-good (promoted from staging after successful boot)
//   main-logic.staging.js — freshly downloaded, not yet verified
//   main-logic.meta.json — { hash, version, updatedAt, bootedOk }
//   boot.lock            — crash detection marker

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
const STAGING_LOGIC = path.join(CACHE_DIR, "main-logic.staging.js");
const META_PATH = path.join(CACHE_DIR, "main-logic.meta.json");
const BOOT_LOCK = path.join(CACHE_DIR, "boot.lock");

// ── Helpers ──

function sha256(str) { return crypto.createHash("sha256").update(str).digest("hex"); }

function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_PATH, "utf-8")); } catch { return {}; }
}

function writeMeta(obj) {
  const meta = { ...readMeta(), ...obj };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

function isValidLogic(code) {
  if (!code || code.length < 500) return false;
  if (code.startsWith("<") || code.startsWith("<!DOCTYPE")) return false;
  if (!code.includes("connectDaemon") || !code.includes("ipcMain")) return false;
  return true;
}

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

async function fetchLatest() {
  for (const url of LOGIC_URLS) {
    try {
      const code = await fetchText(url);
      if (isValidLogic(code)) return code;
      console.log(`[bootstrap] Invalid content from ${url}, skipping`);
    } catch (e) {
      console.log(`[bootstrap] ${url}: ${e.message}`);
    }
  }
  return null;
}

// ── Boot Logic ──

async function loadLogic() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Step 1: Crash detection — did last boot fail?
  const lastBootCrashed = fs.existsSync(BOOT_LOCK);
  if (lastBootCrashed) {
    console.log("[bootstrap] Last boot crashed — rolling back to bundled");
    // Remove staging and cached to force bundled
    try { fs.unlinkSync(STAGING_LOGIC); } catch {}
    try { fs.unlinkSync(CACHED_LOGIC); } catch {}
    writeMeta({ lastCrash: new Date().toISOString(), bootedOk: false });
  }

  // Step 2: Try promote staging → cached (if staging exists and cached is different)
  if (fs.existsSync(STAGING_LOGIC) && !lastBootCrashed) {
    try {
      const staging = fs.readFileSync(STAGING_LOGIC, "utf-8");
      if (isValidLogic(staging)) {
        const stagingHash = sha256(staging);
        const meta = readMeta();
        if (stagingHash !== meta.cachedHash) {
          fs.writeFileSync(CACHED_LOGIC, staging);
          writeMeta({ cachedHash: stagingHash, promotedAt: new Date().toISOString() });
          console.log("[bootstrap] Promoted staging → cached");
        }
      } else {
        console.log("[bootstrap] Staging invalid, discarding");
      }
      fs.unlinkSync(STAGING_LOGIC);
    } catch (e) {
      console.log("[bootstrap] Staging promote failed:", e.message);
    }
  }

  // Step 3: Pick which logic to load — cached (validated) > bundled
  let logicPath = LOCAL_LOGIC;
  if (fs.existsSync(CACHED_LOGIC)) {
    try {
      const cached = fs.readFileSync(CACHED_LOGIC, "utf-8");
      if (isValidLogic(cached)) {
        logicPath = CACHED_LOGIC;
      } else {
        console.log("[bootstrap] Cached invalid, falling back to bundled");
        fs.unlinkSync(CACHED_LOGIC);
      }
    } catch {}
  }

  // Step 4: Write boot lock (cleared after successful init)
  fs.writeFileSync(BOOT_LOCK, String(Date.now()));

  console.log("[bootstrap] Loading:", logicPath);

  // Module resolution for cached logic
  if (logicPath !== LOCAL_LOGIC) {
    const Module = require("module");
    const appNodeModules = path.join(__dirname, "node_modules");
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function(request, parent, ...args) {
      try { return origResolve.call(this, request, parent, ...args); }
      catch (e) {
        const altPath = path.join(appNodeModules, request);
        if (fs.existsSync(altPath) || fs.existsSync(altPath + '.js') || fs.existsSync(path.join(altPath, 'index.js'))) {
          return origResolve.call(this, altPath, parent, ...args);
        }
        throw e;
      }
    };
  }

  // Load logic
  require(logicPath);

  // Step 5: Boot succeeded — clear lock, mark ok
  setTimeout(() => {
    try { fs.unlinkSync(BOOT_LOCK); } catch {}
    writeMeta({ bootedOk: true, lastBoot: new Date().toISOString(), loadedFrom: logicPath });
    console.log("[bootstrap] Boot OK, lock cleared");

    // Step 6: Background fetch — stage for next restart
    fetchLatest().then(code => {
      if (!code) return;
      const hash = sha256(code);
      const meta = readMeta();
      if (hash !== meta.cachedHash) {
        fs.writeFileSync(STAGING_LOGIC, code);
        writeMeta({ stagedHash: hash, stagedAt: new Date().toISOString(), stagedSize: code.length });
        console.log(`[bootstrap] Staged update (${code.length} bytes) — will apply on next restart`);
      }
    }).catch(() => {});
  }, 5000); // 5s grace period — if it crashes within 5s, lock stays
}

// ── IPC ──

ipcMain.handle("restart", () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle("self-update", async () => {
  try {
    const code = await fetchLatest();
    if (!code) return { error: "no valid source available" };
    // Write to staging, then promote immediately (user-initiated = trusted)
    fs.writeFileSync(STAGING_LOGIC, code);
    writeMeta({ stagedHash: sha256(code), stagedAt: new Date().toISOString() });
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("update-info", () => {
  const meta = readMeta();
  return {
    bootedOk: meta.bootedOk,
    loadedFrom: meta.loadedFrom || LOCAL_LOGIC,
    cachedHash: meta.cachedHash,
    stagedHash: meta.stagedHash,
    lastBoot: meta.lastBoot,
    lastCrash: meta.lastCrash,
    hasPendingUpdate: fs.existsSync(STAGING_LOGIC),
  };
});

app.whenReady().then(loadLogic);
app.on("window-all-closed", (e) => e.preventDefault());
