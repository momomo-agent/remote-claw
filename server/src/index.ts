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
