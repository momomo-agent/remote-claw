// code-server-proxy.js — Local HTTP proxy that tunnels code-server through WS relay
// Electron side: starts a local HTTP server, forwards requests via WS to daemon
// Daemon side: receives requests, fetches from local code-server, returns responses

const http = require("http");
const crypto = require("crypto");

/**
 * Start a local HTTP proxy for code-server on a remote device.
 * Returns { port, close } — BrowserWindow loads http://localhost:<port>
 *
 * @param {object} opts
 * @param {string} opts.server - WS relay server URL (wss://remote.momomo.dev)
 * @param {string} opts.token - Auth token
 * @param {string} opts.device - Target device name
 * @param {number} [opts.remotePort=8080] - code-server port on remote device
 */
function startCodeServerProxy({ server, token, device, remotePort = 8080 }) {
  const WebSocket = require("ws");
  const pendingRequests = new Map(); // reqId -> { res, isWs }
  let ws = null;
  let wsReady = false;
  const wsQueue = []; // messages queued before WS ready

  // Connect to relay as a "client" device (app-<random>)
  const clientName = `app-${crypto.randomBytes(3).toString("hex")}`;
  const wsUrl = `${server}/ws?device=${encodeURIComponent(clientName)}&token=${encodeURIComponent(token)}&cap=proxy`;

  function connectWs() {
    ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      wsReady = true;
      while (wsQueue.length) ws.send(wsQueue.shift());
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "http-proxy-response") handleProxyResponse(msg);
        if (msg.type === "ws-proxy-data") handleWsProxyData(msg);
        if (msg.type === "ws-proxy-close") handleWsProxyClose(msg);
        if (msg.type === "pong") { /* keepalive */ }
      } catch {}
    });
    ws.on("close", () => {
      wsReady = false;
      setTimeout(connectWs, 2000);
    });
    ws.on("error", () => {});
  }

  function wsSend(msg) {
    const s = JSON.stringify(msg);
    if (wsReady && ws?.readyState === 1) ws.send(s);
    else wsQueue.push(s);
  }

  // Handle HTTP proxy response from daemon
  function handleProxyResponse(msg) {
    const pending = pendingRequests.get(msg.reqId);
    if (!pending) return;
    pendingRequests.delete(msg.reqId);

    const { res } = pending;
    if (msg.error) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy error: ${msg.error}`);
      return;
    }

    // Parse headers, write response
    const headers = msg.headers || {};
    // Remove hop-by-hop headers
    delete headers["transfer-encoding"];
    delete headers["connection"];

    res.writeHead(msg.status || 200, headers);
    if (msg.body) {
      res.end(Buffer.from(msg.body, "base64"));
    } else {
      res.end();
    }
  }

  // Handle WebSocket proxy data from daemon (for code-server's internal WS)
  const wsUpgrades = new Map(); // reqId -> client WebSocket

  function handleWsProxyData(msg) {
    const clientWs = wsUpgrades.get(msg.reqId);
    if (clientWs && clientWs.readyState === 1) {
      if (msg.binary) {
        clientWs.send(Buffer.from(msg.data, "base64"));
      } else {
        clientWs.send(msg.data);
      }
    }
  }

  function handleWsProxyClose(msg) {
    const clientWs = wsUpgrades.get(msg.reqId);
    if (clientWs) {
      clientWs.close(msg.code || 1000);
      wsUpgrades.delete(msg.reqId);
    }
  }

  // Create local HTTP server
  const httpServer = http.createServer((req, res) => {
    const reqId = crypto.randomUUID();
    pendingRequests.set(reqId, { res });

    // Collect request body
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      wsSend({
        type: "http-proxy-request",
        to: device,
        reqId,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body.length > 0 ? body.toString("base64") : undefined,
        port: remotePort,
      });
    });

    // Timeout
    setTimeout(() => {
      if (pendingRequests.has(reqId)) {
        pendingRequests.delete(reqId);
        if (!res.headersSent) {
          res.writeHead(504, { "Content-Type": "text/plain" });
          res.end("Proxy timeout");
        }
      }
    }, 30000);
  });

  // Handle WebSocket upgrades (code-server uses WS for terminal, LSP, etc.)
  const WebSocketServer = require("ws").Server;
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const reqId = crypto.randomUUID();
      wsUpgrades.set(reqId, clientWs);

      // Tell daemon to open WS connection to code-server
      wsSend({
        type: "ws-proxy-open",
        to: device,
        reqId,
        url: req.url,
        headers: req.headers,
        port: remotePort,
      });

      clientWs.on("message", (data, isBinary) => {
        wsSend({
          type: "ws-proxy-data",
          to: device,
          reqId,
          data: isBinary ? Buffer.from(data).toString("base64") : data.toString(),
          binary: isBinary,
        });
      });

      clientWs.on("close", () => {
        wsSend({ type: "ws-proxy-close", to: device, reqId });
        wsUpgrades.delete(reqId);
      });
    });
  });

  // Start on random port
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const port = httpServer.address().port;
      connectWs();

      // Keepalive
      const keepalive = setInterval(() => {
        if (wsReady) wsSend({ type: "ping" });
      }, 25000);

      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => {
          clearInterval(keepalive);
          httpServer.close();
          if (ws) ws.close();
          for (const [, clientWs] of wsUpgrades) clientWs.close();
          wsUpgrades.clear();
          pendingRequests.clear();
        },
      });
    });
  });
}

module.exports = { startCodeServerProxy };
