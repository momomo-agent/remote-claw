#!/usr/bin/env node
// RemoteClaw Device Daemon

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");
const tunnel = require("./tunnel-frame");
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

  let connectedAt = 0;
  let lastPongAt = 0;
  ws.on("open", () => {
    connectedAt = Date.now();
    lastPongAt = Date.now();
    console.log(`Connected at ${new Date(connectedAt).toISOString()}`);
    reconnectDelay = 1000;
    // Keep-alive. CF idle timeout ~30s but half-open sockets can linger for minutes:
    // node's ws does NOT fire 'close' automatically on silent-dead peers. So we
    // actively terminate if no pong returns within 45s.
    const PING_MS = 15000;
    const PONG_TIMEOUT_MS = 45000;
    const sendPing = () => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    };
    sendPing();
    const pingInterval = setInterval(() => {
      if (ws.readyState !== ws.OPEN) { clearInterval(pingInterval); return; }
      const sincePong = Date.now() - lastPongAt;
      if (sincePong > PONG_TIMEOUT_MS) {
        console.log(`No pong for ${(sincePong/1000).toFixed(1)}s — forcing reconnect (ws.terminate)`);
        try { ws.terminate(); } catch {}
        clearInterval(pingInterval);
        return;
      }
      sendPing();
    }, PING_MS);
    ws.on("close", () => clearInterval(pingInterval));
  });

  ws.on("message", (data, isBinary) => {
    // Binary frame (new tunnel protocol)
    if (isBinary) {
      try {
        const frame = tunnel.decode(data);
        handleTunnelFrame(frame);
      } catch (e) {
        console.error("Bad binary frame:", e.message);
      }
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type !== "pong") console.log(`[ws] recv: ${msg.type}${msg.sessionId ? ' sid=' + msg.sessionId : ''}`);
      if (msg.type === "exec") execCommand(msg.taskId, msg.command);
      if (msg.type === "pong") { lastPongAt = Date.now(); }
      // File transfer via WS relay
      if (msg.type === "file-start") handleIncomingFileStart(msg);
      if (msg.type === "file-chunk") handleIncomingFileChunk(msg);
      if (msg.type === "file-end") handleIncomingFileEnd(msg);
      // Shell session messages
      if (msg.type === "shell-open") handleShellOpen(msg);
      if (msg.type === "shell-input") handleShellInput(msg);
      if (msg.type === "shell-resize") handleShellResize(msg);
      if (msg.type === "shell-close") handleShellClose(msg);
      // Screen capture + remote input
      if (msg.type === "screen-start") handleScreenStart(msg);
      if (msg.type === "screen-stop") handleScreenStop(msg);
      if (msg.type === "screen-input") handleScreenInput(msg);
      // HTTP proxy (code-server tunnel, legacy JSON)
      if (msg.type === "http-proxy-request") handleHttpProxyRequest(msg);
      if (msg.type === "ws-proxy-open") handleWsProxyOpen(msg);
      if (msg.type === "ws-proxy-data") handleWsProxyData(msg);
      if (msg.type === "ws-proxy-close") handleWsProxyClose(msg);
    } catch (e) {
      console.error("Bad message:", e.message);
    }
  });

  ws.on("close", (code, reason) => {
    const reasonStr = reason ? reason.toString() : '';
    const lifetime = connectedAt ? ((Date.now() - connectedAt) / 1000).toFixed(1) : '?';
    const sincePong = lastPongAt ? ((Date.now() - lastPongAt) / 1000).toFixed(1) : '?';
    console.log(`Disconnected (code=${code}${reasonStr ? ' reason=' + reasonStr : ''}) after ${lifetime}s, last pong ${sincePong}s ago. Reconnecting in ${reconnectDelay / 1000}s...`);
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
      PATH: `${os.homedir()}/.nvm/versions/node/current/bin:${os.homedir()}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}`,
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
    env: { ...process.env, HOME: os.homedir(), LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}` },
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
  // Defensive: cols/rows may be 0/undefined if client sent before xterm fit().
  // node-pty.resize(0, 0) throws, killing the surrounding try/catch but
  // leaving the pty in an undefined state (it still runs & buffers data).
  const cols = Number.isInteger(msg.cols) && msg.cols > 0 ? msg.cols : null;
  const rows = Number.isInteger(msg.rows) && msg.rows > 0 ? msg.rows : null;
  if (cols == null || rows == null) {
    console.log(`[shell] resize skipped: bad dims cols=${msg.cols} rows=${msg.rows} sid=${msg.sessionId}`);
    return;
  }
  try {
    session.pty.resize(cols, rows);
  } catch (e) {
    console.log(`[shell] resize error: ${e.message} sid=${msg.sessionId}`);
  }
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

// ── Screen Capture + Remote Input ──

const screenSessions = new Map(); // sessionId -> { interval, from, quality, fps }
const SCREEN_TMP = path.join(os.tmpdir(), "remoteclaw-screen.jpg");

function handleScreenStart(msg) {
  const sid = msg.sessionId || "default";
  if (screenSessions.has(sid)) handleScreenStop({ sessionId: sid });

  const fps = Math.min(msg.fps || 2, 10); // cap at 10fps
  const quality = msg.quality || 30;
  const intervalMs = Math.round(1000 / fps);

  console.log(`[screen] start: ${sid} ${fps}fps q${quality} for ${msg.from}`);

  // Capture immediately, then on interval
  captureAndSend(sid, msg.from, quality);
  const interval = setInterval(() => captureAndSend(sid, msg.from, quality), intervalMs);
  screenSessions.set(sid, { interval, from: msg.from, quality, fps });
}

function handleScreenStop(msg) {
  const sid = msg.sessionId || "default";
  const session = screenSessions.get(sid);
  if (!session) return;
  console.log(`[screen] stop: ${sid}`);
  clearInterval(session.interval);
  screenSessions.delete(sid);
}

let captureInFlight = false;

function captureAndSend(sessionId, to, quality) {
  if (captureInFlight) return; // skip frame if previous still in flight
  captureInFlight = true;

  const tmpFile = SCREEN_TMP + "." + sessionId;
  // screencapture: -x no sound, -t jpg
  const proc = spawn("screencapture", ["-x", "-t", "jpg", tmpFile], {
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
    timeout: 5000,
  });

  proc.on("close", (code) => {
    captureInFlight = false;
    if (code !== 0) return;
    try {
      // Resize to max 1280 width for bandwidth, using sips (built-in macOS)
      const { execSync } = require("child_process");
      const info = execSync(`sips -g pixelWidth "${tmpFile}" 2>/dev/null`, { encoding: "utf-8" });
      const wMatch = info.match(/pixelWidth:\s*(\d+)/);
      const origW = wMatch ? parseInt(wMatch[1]) : 1920;
      if (origW > 1280) {
        execSync(`sips --resampleWidth 1280 -s formatOptions ${quality} "${tmpFile}" --out "${tmpFile}" 2>/dev/null`);
      } else {
        execSync(`sips -s formatOptions ${quality} "${tmpFile}" --out "${tmpFile}" 2>/dev/null`);
      }

      const buf = fs.readFileSync(tmpFile);
      const b64 = buf.toString("base64");
      wsSend({
        type: "screen-frame",
        sessionId,
        data: b64,
        width: Math.min(origW, 1280),
        timestamp: Date.now(),
        to,
      });
      fs.unlinkSync(tmpFile);
    } catch (e) {
      // ignore read errors
    }
  });

  proc.on("error", () => { captureInFlight = false; });
}

function handleScreenInput(msg) {
  // msg: { action, x, y, button, key, text, modifiers }
  const cmds = [];
  const { action, x, y, key, text } = msg;

  switch (action) {
    case "click":
      cmds.push(`c:${Math.round(x)},${Math.round(y)}`);
      break;
    case "rightclick":
      cmds.push(`rc:${Math.round(x)},${Math.round(y)}`);
      break;
    case "doubleclick":
      cmds.push(`dc:${Math.round(x)},${Math.round(y)}`);
      break;
    case "mousedown":
      cmds.push(`dd:${Math.round(x)},${Math.round(y)}`);
      break;
    case "mousemove":
      cmds.push(`dm:${Math.round(x)},${Math.round(y)}`);
      break;
    case "mouseup":
      cmds.push(`du:${Math.round(x)},${Math.round(y)}`);
      break;
    case "scroll": {
      // Move mouse to position first, then simulate scroll via cliclick arrow keys
      const dy = msg.deltaY || 0;
      const scrollDir = dy > 0 ? "arrow-down" : "arrow-up";
      const steps = Math.max(1, Math.min(Math.abs(Math.round(dy / 40)), 10));
      if (x != null && y != null) cmds.push(`m:${Math.round(x)},${Math.round(y)}`);
      for (let i = 0; i < steps; i++) cmds.push(`kp:${scrollDir}`);
      break;
    }
    case "type":
      if (text) cmds.push(`t:'${text.replace(/'/g, "'")}'`);
      break;
    case "keydown":
      if (key) {
        const mapped = mapKey(key);
        if (mapped.mod) cmds.push(`kd:${mapped.mod}`);
        else cmds.push(`kp:${mapped.key}`);
      }
      break;
    case "keyup":
      if (key) {
        const mapped = mapKey(key);
        if (mapped.mod) cmds.push(`ku:${mapped.mod}`);
      }
      break;
    case "keypress":
      if (key) {
        const mapped = mapKey(key);
        if (mapped.mod) {
          cmds.push(`kd:${mapped.mod}`);
          cmds.push(`ku:${mapped.mod}`);
        } else {
          cmds.push(`kp:${mapped.key}`);
        }
      }
      break;
  }

  if (cmds.length > 0) {
    const cmd = cmds.join(" ");
    spawn("cliclick", cmd.split(" "), {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
      timeout: 5000,
    });
  }
}

function mapKey(jsKey) {
  // Map JS key names to cliclick key names
  const modMap = { Meta: "cmd", Control: "ctrl", Alt: "alt", Shift: "shift" };
  if (modMap[jsKey]) return { mod: modMap[jsKey] };

  const keyMap = {
    Enter: "return", Backspace: "delete", Delete: "fwd-delete",
    Tab: "tab", Escape: "esc", " ": "space", Space: "space",
    ArrowUp: "arrow-up", ArrowDown: "arrow-down",
    ArrowLeft: "arrow-left", ArrowRight: "arrow-right",
    Home: "home", End: "end", PageUp: "page-up", PageDown: "page-down",
    F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
    F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",
  };
  return { key: keyMap[jsKey] || jsKey.toLowerCase() };
}

// ── HTTP Proxy (code-server tunnel) ──

const http = require("http");
const proxyWsSessions = new Map(); // reqId -> WebSocket to local code-server

function handleHttpProxyRequest(msg) {
  const { reqId, method, url, headers, body, port, from } = msg;
  const targetPort = port || 8080;

  const reqOpts = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: url,
    method: method || "GET",
    headers: { ...headers },
  };
  // Remove hop-by-hop and proxy headers
  delete reqOpts.headers["host"];
  delete reqOpts.headers["connection"];
  delete reqOpts.headers["upgrade"];
  reqOpts.headers["host"] = `127.0.0.1:${targetPort}`;

  const proxyReq = http.request(reqOpts, (proxyRes) => {
    const chunks = [];
    proxyRes.on("data", (c) => chunks.push(c));
    proxyRes.on("end", () => {
      const respBody = Buffer.concat(chunks);
      const respHeaders = { ...proxyRes.headers };
      delete respHeaders["transfer-encoding"];
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "http-proxy-response",
          to: from,
          reqId,
          status: proxyRes.statusCode,
          headers: respHeaders,
          body: respBody.length > 0 ? respBody.toString("base64") : undefined,
        }));
      }
    });
  });

  proxyReq.on("error", (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "http-proxy-response",
        to: from,
        reqId,
        error: e.message,
      }));
    }
  });

  if (body) proxyReq.write(Buffer.from(body, "base64"));
  proxyReq.end();
}

function handleWsProxyOpen(msg) {
  const { reqId, url, headers, port, from } = msg;
  const targetPort = port || 8080;
  const wsUrl = `ws://127.0.0.1:${targetPort}${url}`;

  const proxyHeaders = {};
  // Forward relevant headers
  for (const [k, v] of Object.entries(headers || {})) {
    if (!["host", "upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"].includes(k.toLowerCase())) {
      proxyHeaders[k] = v;
    }
  }

  const localWs = new WebSocket(wsUrl, { headers: proxyHeaders });

  localWs.on("open", () => {
    proxyWsSessions.set(reqId, localWs);
  });

  localWs.on("message", (data, isBinary) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "ws-proxy-data",
        to: from,
        reqId,
        data: isBinary ? Buffer.from(data).toString("base64") : data.toString(),
        binary: isBinary,
      }));
    }
  });

  localWs.on("close", (code) => {
    proxyWsSessions.delete(reqId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ws-proxy-close", to: from, reqId, code }));
    }
  });

  localWs.on("error", (e) => {
    console.error(`[ws-proxy] ${reqId}: ${e.message}`);
    proxyWsSessions.delete(reqId);
  });
}

function handleWsProxyData(msg) {
  const localWs = proxyWsSessions.get(msg.reqId);
  if (localWs && localWs.readyState === WebSocket.OPEN) {
    if (msg.binary) {
      localWs.send(Buffer.from(msg.data, "base64"));
    } else {
      localWs.send(msg.data);
    }
  }
}

function handleWsProxyClose(msg) {
  const localWs = proxyWsSessions.get(msg.reqId);
  if (localWs) {
    localWs.close();
    proxyWsSessions.delete(msg.reqId);
  }
}

// ── Binary Tunnel Protocol ──
// Binary sessions keyed by reqId. Electron is the initiator; daemon is the
// responder. One reqId = one HTTP request, or one WS, or one TCP stream.

const tunnelWsSessions = new Map();  // reqId -> WebSocket to a local service
const tunnelTcpSessions = new Map(); // reqId -> net.Socket (for HTTPS CONNECT tunneling)

function sendFrame(opcode, reqId, peer, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const buf = tunnel.encode(opcode, reqId, peer, payload || Buffer.alloc(0));
  ws.send(buf, { binary: true });
}

function handleTunnelFrame(frame) {
  const { opcode, reqId, peer, payload } = frame;
  // `peer` here is the source (relay rewrote it). We will reply to this peer.
  switch (opcode) {
    case tunnel.OP.HTTP_REQ: return handleTunnelHttpReq(reqId, peer, payload);
    case tunnel.OP.TCP_OPEN: return handleTunnelTcpOpen(reqId, peer, payload);
    case tunnel.OP.TCP_DATA: return handleTunnelTcpData(reqId, peer, payload);
    case tunnel.OP.TCP_CLOSE: return handleTunnelTcpClose(reqId, peer, payload);
    case tunnel.OP.WS_OPEN: return handleTunnelWsOpen(reqId, peer, payload);
    case tunnel.OP.WS_DATA: return handleTunnelWsData(reqId, peer, payload);
    case tunnel.OP.WS_CLOSE: return handleTunnelWsClose(reqId, peer, payload);
    default:
      console.log(`[tunnel] unknown opcode 0x${opcode.toString(16)} reqId=${reqId}`);
  }
}

// ── Binary HTTP ──
// Two modes:
//   header.url absolute (http[s]://host[:port]/path) → universal proxy (Browser mode A)
//   header.url relative (/path) + header.port → local-port proxy (code-server)
function handleTunnelHttpReq(reqId, peer, payload) {
  let parsed;
  try { parsed = tunnel.splitJsonBody(payload); } catch (e) {
    return sendFrame(tunnel.OP.HTTP_ERR, reqId, peer, Buffer.from("bad header: " + e.message));
  }
  const { header, body } = parsed;
  const method = header.method || "GET";
  const reqHeaders = { ...(header.headers || {}) };

  let options, isHttps = false;
  if (/^https?:\/\//i.test(header.url)) {
    // Universal mode — absolute URL
    let u;
    try { u = new URL(header.url); } catch (e) {
      return sendFrame(tunnel.OP.HTTP_ERR, reqId, peer, Buffer.from("bad url: " + e.message));
    }
    isHttps = u.protocol === "https:";
    options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: reqHeaders,
    };
    // Rewrite Host header for target
    options.headers["host"] = u.host;
    delete options.headers["connection"];
  } else {
    // Local-port mode — code-server style
    const targetPort = header.port || 8080;
    options = {
      hostname: "127.0.0.1",
      port: targetPort,
      path: header.url || "/",
      method,
      headers: reqHeaders,
    };
    delete options.headers["host"];
    delete options.headers["connection"];
    delete options.headers["upgrade"];
    options.headers["host"] = `127.0.0.1:${targetPort}`;
  }

  const lib = isHttps ? require("https") : require("http");
  const req = lib.request(options, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const respBody = Buffer.concat(chunks);
      const respHeaders = { ...res.headers };
      delete respHeaders["transfer-encoding"];
      const out = tunnel.joinJsonBody({ status: res.statusCode, headers: respHeaders }, respBody);
      sendFrame(tunnel.OP.HTTP_RESP, reqId, peer, out);
    });
  });
  req.on("error", (e) => {
    sendFrame(tunnel.OP.HTTP_ERR, reqId, peer, Buffer.from(e.message));
  });
  if (body && body.length) req.write(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  req.end();
}

// ── Binary TCP (HTTPS CONNECT tunneling for Browser mode A) ──
function handleTunnelTcpOpen(reqId, peer, payload) {
  let hdr;
  try { hdr = JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf-8") || "{}"); }
  catch (e) { return sendFrame(tunnel.OP.TCP_CLOSE, reqId, peer, Buffer.from("bad open: " + e.message)); }
  const net = require("net");
  const socket = net.connect({ host: hdr.host, port: hdr.port }, () => {
    // Notify Electron that connect succeeded by sending empty TCP_DATA is ambiguous;
    // let's just wait for data. Browsers open their first byte after CONNECT 200,
    // which we emit from the Electron proxy side.
  });
  socket.setNoDelay(true);
  tunnelTcpSessions.set(reqId, socket);
  socket.on("data", (chunk) => sendFrame(tunnel.OP.TCP_DATA, reqId, peer, chunk));
  socket.on("close", () => {
    tunnelTcpSessions.delete(reqId);
    sendFrame(tunnel.OP.TCP_CLOSE, reqId, peer, Buffer.alloc(0));
  });
  socket.on("error", (e) => {
    // `close` will still fire afterwards
    sendFrame(tunnel.OP.TCP_CLOSE, reqId, peer, Buffer.from(e.message));
  });
}

function handleTunnelTcpData(reqId, peer, payload) {
  const socket = tunnelTcpSessions.get(reqId);
  if (socket && !socket.destroyed) {
    socket.write(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
  }
}

function handleTunnelTcpClose(reqId, peer, payload) {
  const socket = tunnelTcpSessions.get(reqId);
  if (socket) {
    try { socket.end(); } catch {}
    tunnelTcpSessions.delete(reqId);
  }
}

// ── Binary WebSocket (code-server internal WS) ──
function handleTunnelWsOpen(reqId, peer, payload) {
  let hdr;
  try { hdr = JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf-8") || "{}"); }
  catch (e) { return sendFrame(tunnel.OP.WS_CLOSE, reqId, peer, Buffer.from("bad open: " + e.message)); }
  const port = hdr.port || 8080;
  const wsUrl = `ws://127.0.0.1:${port}${hdr.url || "/"}`;
  const headers = {};
  for (const [k, v] of Object.entries(hdr.headers || {})) {
    const lk = k.toLowerCase();
    if (["host", "upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"].includes(lk)) continue;
    headers[k] = v;
  }
  const localWs = new WebSocket(wsUrl, { headers });
  tunnelWsSessions.set(reqId, localWs);
  localWs.on("message", (data, isBin) => {
    const flags = isBin ? 0x01 : 0x00;
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const out = Buffer.alloc(1 + dataBuf.length);
    out[0] = flags;
    dataBuf.copy(out, 1);
    sendFrame(tunnel.OP.WS_DATA, reqId, peer, out);
  });
  localWs.on("close", (code) => {
    tunnelWsSessions.delete(reqId);
    const codeBuf = Buffer.alloc(2);
    codeBuf.writeUInt16BE(code || 1000, 0);
    sendFrame(tunnel.OP.WS_CLOSE, reqId, peer, codeBuf);
  });
  localWs.on("error", (e) => {
    console.error(`[tunnel-ws] ${reqId}: ${e.message}`);
  });
}

function handleTunnelWsData(reqId, peer, payload) {
  const localWs = tunnelWsSessions.get(reqId);
  if (!localWs || localWs.readyState !== WebSocket.OPEN) return;
  const flags = payload[0] || 0;
  const dataBytes = Buffer.from(payload.buffer, payload.byteOffset + 1, payload.byteLength - 1);
  localWs.send(dataBytes, { binary: !!(flags & 0x01) });
}

function handleTunnelWsClose(reqId, peer, payload) {
  const localWs = tunnelWsSessions.get(reqId);
  if (localWs) {
    try { localWs.close(); } catch {}
    tunnelWsSessions.delete(reqId);
  }
}

// ── Keepalive ──

// ── File Transfer (WebSocket relay) ──

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk
const incomingTransfers = new Map(); // transferId -> { fd, path, received, total }

// Send a local file to another device via WS relay
async function sendFileViaWs(targetDevice, localPath, remotePath) {
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

    // Send chunks with backpressure
    const fd = fs.openSync(localPath, "r");
    const buf = Buffer.alloc(CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, i * CHUNK_SIZE);
      const msg = JSON.stringify({
        type: "file-chunk", to: targetDevice, transferId,
        index: i, data: buf.slice(0, bytesRead).toString("base64"),
      });
      // Wait for WS buffer to drain before sending next chunk
      if (ws.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise(r => setTimeout(r, 100));
      }
      ws.send(msg);
      if ((i + 1) % 10 === 0 || i === totalChunks - 1) {
        console.log(`[send] chunk ${i + 1}/${totalChunks}`);
      }
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
