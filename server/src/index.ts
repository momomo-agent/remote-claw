// RemoteClaw Server — Cloudflare Worker + Durable Objects

export interface Env {
  DEVICE_HUB: DurableObjectNamespace;
  HISTORY: KVNamespace;
  REMOTECLAW_TOKEN: string;
}

interface Task {
  id: string;
  device: string;
  command: string;
  status: "pending" | "running" | "done" | "error" | "timeout";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  createdAt: number;
  completedAt: number | null;
}

// ── Helpers ──

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function err(msg: string, status = 400) {
  return json({ error: msg }, status);
}

function auth(req: Request, env: Env): boolean {
  const h = req.headers.get("Authorization");
  if (h?.startsWith("Bearer ") && h.slice(7) === env.REMOTECLAW_TOKEN) return true;
  // also check query param for WebSocket upgrades
  const url = new URL(req.url);
  return url.searchParams.get("token") === env.REMOTECLAW_TOKEN;
}

function hubStub(env: Env): DurableObjectStub {
  const id = env.DEVICE_HUB.idFromName("global");
  return env.DEVICE_HUB.get(id);
}

// ── App HTML (served at /app for hot-update) ──

const APP_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>RemoteClaw</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: #1a1a2e; }
::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  background: #0f0f1a; color: #e0e0e0; font-size: 12px;
  overflow: hidden; user-select: none; -webkit-app-region: drag;
}
#app { display: flex; flex-direction: column; height: 100vh; }
.header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; background: #16162a;
  border-bottom: 1px solid #2a2a4a; -webkit-app-region: drag;
}
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot.on { background: #00c853; box-shadow: 0 0 6px #00c85388; }
.status-dot.off { background: #ff3d3d; box-shadow: 0 0 6px #ff3d3d88; }
.header-url { color: #888; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.device-picker {
  background: #1a1a30; border: 1px solid #2a2a4a; color: #ccc;
  padding: 3px 6px; border-radius: 4px; font-size: 10px; outline: none;
}
.tabs {
  display: flex; background: #16162a;
  border-bottom: 1px solid #2a2a4a; -webkit-app-region: no-drag;
}
.tab {
  flex: 1; padding: 7px 0; text-align: center; cursor: pointer;
  color: #666; font-size: 11px; font-weight: 500; transition: all 0.15s;
}
.tab:hover { color: #aaa; }
.tab.active { color: #7c8aff; border-bottom: 2px solid #7c8aff; }
.content { flex: 1; overflow-y: auto; -webkit-app-region: no-drag; }
.device-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid #1a1a30; transition: background 0.1s;
}
.device-item:hover { background: #1a1a30; }
.device-name { font-weight: 600; font-size: 12px; }
.device-meta { color: #666; font-size: 10px; margin-top: 2px; }
.device-caps { display: flex; gap: 4px; margin-top: 3px; }
.cap-tag { background: #2a2a4a; color: #8888cc; font-size: 9px; padding: 1px 6px; border-radius: 3px; }
.device-time { margin-left: auto; color: #555; font-size: 10px; text-align: right; }
.history-item { padding: 8px 14px; border-bottom: 1px solid #1a1a30; }
.history-cmd {
  font-family: "SF Mono", Menlo, monospace; font-size: 11px;
  color: #c8c8ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.history-meta { display: flex; gap: 8px; margin-top: 3px; color: #555; font-size: 10px; }
.history-status { font-weight: 600; }
.history-status.done { color: #00c853; }
.history-status.error { color: #ff3d3d; }
.history-status.timeout { color: #ff9800; }
.history-status.running { color: #7c8aff; }
.terminal { display: flex; flex-direction: column; height: 100%; }
.term-output {
  flex: 1; overflow-y: auto; padding: 8px 12px;
  font-family: "SF Mono", Menlo, monospace; font-size: 11px; line-height: 1.5;
}
.term-line { white-space: pre-wrap; word-break: break-all; }
.term-cmd { color: #e0e0e0; margin-top: 4px; }
.term-prompt { color: #7c8aff; margin-right: 6px; font-weight: 600; }
.term-stdout { color: #c8c8c8; }
.term-stderr { color: #ff6b6b; }
.term-info { color: #555; font-size: 10px; }
.term-error { color: #ff3d3d; }
.term-input-row {
  display: flex; align-items: center; padding: 8px 12px;
  background: #16162a; border-top: 1px solid #2a2a4a;
  -webkit-app-region: no-drag;
  font-family: "SF Mono", Menlo, monospace; font-size: 11px;
}
.term-input {
  flex: 1; background: transparent; border: none; color: #e0e0e0;
  font-family: "SF Mono", Menlo, monospace; font-size: 11px;
  outline: none; margin-left: 6px;
}
.term-input:disabled { opacity: 0.4; }
.term-input::placeholder { color: #444; }
.settings { padding: 14px; -webkit-app-region: no-drag; }
.settings-group { margin-bottom: 14px; }
.settings-label { color: #888; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.settings-input {
  width: 100%; background: #1a1a30; border: 1px solid #2a2a4a; color: #e0e0e0;
  padding: 7px 10px; border-radius: 6px; font-size: 11px; outline: none;
  font-family: "SF Mono", Menlo, monospace;
}
.settings-input:focus { border-color: #7c8aff; }
.settings-input::placeholder { color: #444; }
.settings-btn {
  background: #7c8aff; color: #fff; border: none;
  padding: 8px 20px; border-radius: 6px; font-size: 11px;
  cursor: pointer; font-weight: 600; width: 100%; margin-top: 10px;
}
.settings-btn:hover { background: #6a78ee; }
.settings-saved { color: #00c853; font-size: 10px; text-align: center; margin-top: 8px; display: none; }
.settings-note { color: #555; font-size: 10px; margin-top: 4px; }
.empty { text-align: center; padding: 40px 20px; color: #444; font-size: 12px; }
.pin-close-btn {
  position: fixed; top: 6px; right: 8px; z-index: 9999;
  width: 20px; height: 20px; border-radius: 50%;
  background: #2a2a4a; color: #aaa; border: none;
  font-size: 12px; line-height: 20px; text-align: center;
  cursor: pointer; -webkit-app-region: no-drag;
  transition: background 0.15s, color 0.15s;
}
.pin-close-btn:hover { background: #ff3d3d; color: #fff; }
</style>
</head>
<body>
<div id="app"></div>
<script>
INLINE_JS_PLACEHOLDER
</script>
</body>
</html>`;

// ── Worker fetch ──

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    // Serve app UI (no auth required — runs inside Electron with preload bridge)
    if (path === "/app") {
      return new Response(APP_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    // WebSocket endpoint — forward to DO (auth checked inside DO)
    if (path === "/ws") {
      return hubStub(env).fetch(req);
    }

    // All other endpoints require auth
    if (!auth(req, env)) return err("unauthorized", 401);

    // GET /devices
    if (path === "/devices" && req.method === "GET") {
      return hubStub(env).fetch(req);
    }

    // POST /exec
    if (path === "/exec" && req.method === "POST") {
      return hubStub(env).fetch(req);
    }

    // GET /task/:id
    const taskMatch = path.match(/^\/task\/(.+)$/);
    if (taskMatch && req.method === "GET") {
      return hubStub(env).fetch(req);
    }

    // GET /history
    if (path === "/history" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const listResult = await env.HISTORY.list({ limit, prefix: "cmd:" });
      const items = await Promise.all(
        listResult.keys.map(async (k) => {
          const val = await env.HISTORY.get(k.name);
          return val ? JSON.parse(val) : null;
        })
      );
      return json(items.filter(Boolean));
    }

    return err("not found", 404);
  },
};

// ── DeviceHub Durable Object ──

interface DeviceConn {
  ws: WebSocket;
  name: string;
  capabilities: string[];
  connectedAt: number;
}

export class DeviceHub {
  private devices = new Map<string, DeviceConn>();
  private tasks = new Map<string, Task>();
  private taskResolvers = new Map<string, (t: Task) => void>();
  private env: Env;

  constructor(private state: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (path === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return err("expected websocket", 426);
      const token = url.searchParams.get("token");
      if (token !== this.env.REMOTECLAW_TOKEN) return err("unauthorized", 401);
      const deviceName = url.searchParams.get("device");
      if (!deviceName) return err("device param required");

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleWs(server, deviceName, url.searchParams.get("capabilities") || "");
      return new Response(null, { status: 101, webSocket: client });
    }

    // GET /devices
    if (path === "/devices") {
      const list = Array.from(this.devices.entries()).map(([id, d]) => ({
        id,
        name: d.name,
        capabilities: d.capabilities,
        connectedAt: d.connectedAt,
        connectedFor: Math.round((Date.now() - d.connectedAt) / 1000),
      }));
      return json(list);
    }

    // POST /exec
    if (path === "/exec" && req.method === "POST") {
      const body = (await req.json()) as {
        device: string;
        command: string;
        timeout?: number;
        oneshot?: boolean;
      };
      if (!body.device || !body.command) return err("device and command required");

      const conn = this.devices.get(body.device);
      if (!conn) return err("device not connected", 404);

      const task: Task = {
        id: crypto.randomUUID(),
        device: body.device,
        command: body.command,
        status: "pending",
        stdout: "",
        stderr: "",
        exitCode: null,
        createdAt: Date.now(),
        completedAt: null,
      };
      this.tasks.set(task.id, task);

      // Send command to device
      conn.ws.send(JSON.stringify({ type: "exec", taskId: task.id, command: body.command }));
      task.status = "running";

      const timeout = body.timeout || 30000;

      if (body.oneshot) {
        // Synchronous mode — wait for result
        const result = await Promise.race([
          new Promise<Task>((resolve) => this.taskResolvers.set(task.id, resolve)),
          new Promise<Task>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
        ]).catch(() => {
          task.status = "timeout";
          task.completedAt = Date.now();
          return task;
        });
        this.taskResolvers.delete(task.id);
        await this.saveHistory(result as Task);
        return json(result);
      }

      // Async mode — set up timeout, return taskId
      setTimeout(() => {
        const t = this.tasks.get(task.id);
        if (t && t.status === "running") {
          t.status = "timeout";
          t.completedAt = Date.now();
          const resolver = this.taskResolvers.get(task.id);
          if (resolver) { resolver(t); this.taskResolvers.delete(task.id); }
          this.saveHistory(t);
        }
      }, timeout);

      return json({ taskId: task.id, status: "running" });
    }

    // GET /task/:id
    const taskMatch = path.match(/^\/task\/(.+)$/);
    if (taskMatch) {
      const task = this.tasks.get(taskMatch[1]);
      if (!task) return err("task not found", 404);
      return json(task);
    }

    return err("not found", 404);
  }

  private handleWs(ws: WebSocket, deviceName: string, capStr: string) {
    ws.accept();
    const capabilities = capStr ? capStr.split(",") : ["shell"];
    const deviceId = deviceName;

    this.devices.set(deviceId, { ws, name: deviceName, capabilities, connectedAt: Date.now() });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "result") {
          const task = this.tasks.get(msg.taskId);
          if (task) {
            task.stdout = msg.stdout || "";
            task.stderr = msg.stderr || "";
            task.exitCode = msg.exitCode ?? null;
            task.status = msg.exitCode === 0 ? "done" : "error";
            task.completedAt = Date.now();
            const resolver = this.taskResolvers.get(msg.taskId);
            if (resolver) { resolver(task); this.taskResolvers.delete(msg.taskId); }
            this.saveHistory(task);
          }
        }
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      } catch {}
    });

    ws.addEventListener("close", () => {
      this.devices.delete(deviceId);
    });

    ws.addEventListener("error", () => {
      this.devices.delete(deviceId);
    });
  }

  private async saveHistory(task: Task) {
    const key = `cmd:${String(9999999999999 - task.createdAt).padStart(13, "0")}:${task.id}`;
    await this.env.HISTORY.put(key, JSON.stringify({
      id: task.id,
      device: task.device,
      command: task.command,
      status: task.status,
      exitCode: task.exitCode,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      duration: task.completedAt ? task.completedAt - task.createdAt : null,
    }), { expirationTtl: 86400 * 30 });
  }
}
