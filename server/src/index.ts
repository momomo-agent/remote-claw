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

interface Transfer {
  id: string;
  filename: string;
  totalSize: number;
  chunks: number;
  createdAt: number;
  expiresAt: number;
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
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    };

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
    return await this._handle(req, env, corsHeaders);
    } catch (e: any) {
      console.error("Unhandled:", e.message, e.stack);
      return new Response(JSON.stringify({ error: "internal", detail: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },

  async _handle(req: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
    // Helper to add CORS to any response
    const withCors = (res: Response) => {
      const newRes = new Response(res.body, res);
      Object.entries(corsHeaders).forEach(([k, v]) => newRes.headers.set(k, v));
      return newRes;
    };

    const url = new URL(req.url);
    const path = url.pathname;

    // Serve app UI — redirect to GitHub Pages
    if (path === "/app") {
      return Response.redirect("https://momomo-agent.github.io/remote-claw/", 302);
    }

    // WebSocket endpoint — forward to DO (auth checked inside DO)
    if (path === "/ws") {
      return hubStub(env).fetch(req);
    }

    // All other endpoints require auth
    if (!auth(req, env)) return err("unauthorized", 401);

    // GET /devices
    if (path === "/devices" && req.method === "GET") {
      return withCors(await hubStub(env).fetch(req));
    }

    // POST /exec
    if (path === "/exec" && req.method === "POST") {
      return withCors(await hubStub(env).fetch(req));
    }

    // GET /task/:id
    const taskMatch = path.match(/^\/task\/(.+)$/);
    if (taskMatch && req.method === "GET") {
      return withCors(await hubStub(env).fetch(req));
    }

    // GET /history — route to DO (avoids KV list quota)
    if (path === "/history" && req.method === "GET") {
      return withCors(await hubStub(env).fetch(req));
    }

    // POST /transfer/upload — upload file in chunks, stored in DO SQLite
    if (path === "/transfer/upload" && req.method === "POST") {
      return withCors(await hubStub(env).fetch(req));
    }

    // GET /transfer/download/:id — download file chunks
    const dlMatch = path.match(/^\/transfer\/download\/(.+)$/);
    if (dlMatch && req.method === "GET") {
      return withCors(await hubStub(env).fetch(req));
    }

    // GET /transfer/info/:id — get transfer metadata
    const infoMatch = path.match(/^\/transfer\/info\/(.+)$/);
    if (infoMatch && req.method === "GET") {
      return withCors(await hubStub(env).fetch(req));
    }

    // POST /transfer/push — tell a device to upload a file
    if (path === "/transfer/push" && req.method === "POST") {
      return withCors(await hubStub(env).fetch(req));
    }

    return err("not found", 404);
  },
};

// ── DeviceHub Durable Object ──

interface DeviceConn {
  ws: WebSocket;
  name: string;

  connectedAt: number;
}

export class DeviceHub {
  private devices = new Map<string, DeviceConn>();
  private clients = new Map<string, DeviceConn>();
  private tasks = new Map<string, Task>();
  private taskResolvers = new Map<string, (t: Task) => void>();
  private env: Env;
  private sql: SqlStorage;

  constructor(private state: DurableObjectState, env: Env) {
    this.env = env;
    this.sql = state.storage.sql;
    // Create transfer tables
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY,
        filename TEXT,
        total_size INTEGER,
        chunks INTEGER DEFAULT 0,
        created_at INTEGER,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS transfer_chunks (
        transfer_id TEXT,
        chunk_index INTEGER,
        data TEXT,
        PRIMARY KEY (transfer_id, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        device TEXT,
        command TEXT,
        status TEXT,
        exit_code INTEGER,
        created_at INTEGER,
        completed_at INTEGER,
        duration INTEGER
      );
    `);
    // Cleanup expired transfers every 5 minutes
    state.storage.setAlarm(Date.now() + 300000);
  }

  async alarm() {
    const now = Date.now();
    this.sql.exec(`DELETE FROM transfer_chunks WHERE transfer_id IN (SELECT id FROM transfers WHERE expires_at < ?)`, now);
    this.sql.exec(`DELETE FROM transfers WHERE expires_at < ?`, now);
    this.state.storage.setAlarm(Date.now() + 300000);
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
      const role = url.searchParams.get("role") || "device"; // "device" or "client"
      if (!deviceName) return err("device param required");

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleWs(server, deviceName, role);
      return new Response(null, { status: 101, webSocket: client });
    }

    // GET /history — from SQLite
    if (path === "/history") {
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const rows = [...this.sql.exec(`SELECT id, device, command, status, exit_code, created_at, completed_at, duration FROM history ORDER BY created_at DESC LIMIT ?`, limit)];
      return json(rows.map((r: any) => ({
        id: r.id, device: r.device, command: r.command, status: r.status,
        exitCode: r.exit_code, createdAt: r.created_at, completedAt: r.completed_at, duration: r.duration,
      })));
    }

    // GET /devices
    if (path === "/devices") {
      const list = Array.from(this.devices.entries()).map(([id, d]) => ({
        id,
        name: d.name,

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

    // ── File Transfer ──

    // POST /transfer/upload — receive file as base64 chunks
    if (path === "/transfer/upload" && req.method === "POST") {
      const body = await req.json() as { filename: string; chunk: string; chunkIndex: number; totalChunks: number; totalSize: number; transferId?: string };
      let transferId = body.transferId;
      if (!transferId) {
        transferId = crypto.randomUUID();
        this.sql.exec(
          `INSERT INTO transfers (id, filename, total_size, chunks, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)`,
          transferId, body.filename, body.totalSize, Date.now(), Date.now() + 300000
        );
      }
      this.sql.exec(
        `INSERT OR REPLACE INTO transfer_chunks (transfer_id, chunk_index, data) VALUES (?, ?, ?)`,
        transferId, body.chunkIndex, body.chunk
      );
      this.sql.exec(`UPDATE transfers SET chunks = chunks + 1 WHERE id = ?`, transferId);
      const row = this.sql.exec(`SELECT chunks FROM transfers WHERE id = ?`, transferId).toArray()[0] as any;
      const done = row && row.chunks >= body.totalChunks;
      return json({ transferId, chunksReceived: row?.chunks || 0, done });
    }

    // GET /transfer/info/:id
    const infoMatch = path.match(/^\/transfer\/info\/(.+)$/);
    if (infoMatch) {
      const rows = this.sql.exec(`SELECT * FROM transfers WHERE id = ?`, infoMatch[1]).toArray();
      if (!rows.length) return err("transfer not found", 404);
      return json(rows[0]);
    }

    // GET /transfer/download/:id?chunk=N — download one chunk at a time
    const dlMatch = path.match(/^\/transfer\/download\/(.+)$/);
    if (dlMatch) {
      const chunkIdx = parseInt(url.searchParams.get("chunk") || "0");
      const rows = this.sql.exec(
        `SELECT data FROM transfer_chunks WHERE transfer_id = ? AND chunk_index = ?`,
        dlMatch[1], chunkIdx
      ).toArray();
      if (!rows.length) return err("chunk not found", 404);
      return json({ chunk: (rows[0] as any).data, chunkIndex: chunkIdx });
    }

    // POST /transfer/push — tell device to read file and upload it
    if (path === "/transfer/push" && req.method === "POST") {
      const body = await req.json() as { device: string; remotePath: string };
      const conn = this.devices.get(body.device);
      if (!conn) return err("device not connected", 404);
      const transferId = crypto.randomUUID();
      conn.ws.send(JSON.stringify({ type: "file-upload", transferId, path: body.remotePath }));
      return json({ transferId, status: "requested" });
    }

    return err("not found", 404);
  }

  private handleWs(ws: WebSocket, deviceName: string, role: string) {
    ws.accept();
    const deviceId = deviceName;
    const isClient = role === "client";

    // Only register as device if role=device (daemon)
    if (!isClient) {
      this.devices.set(deviceId, { ws, name: deviceName, connectedAt: Date.now() });
    }
    // Clients get tracked separately for message relay
    if (isClient) {
      if (!this.clients) this.clients = new Map();
      this.clients.set(deviceId, { ws, name: deviceName, connectedAt: Date.now() });
    }

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

        // File transfer relay — forward between devices/clients
        if (msg.type === "file-start" || msg.type === "file-chunk" || msg.type === "file-end") {
          const target = this.devices.get(msg.to) || this.clients?.get(msg.to);
          if (target) {
            target.ws.send(JSON.stringify({ ...msg, from: deviceId }));
          } else {
            ws.send(JSON.stringify({ type: "file-error", transferId: msg.transferId, error: `device ${msg.to} not connected` }));
          }
        }

        // Shell session relay — forward between devices/clients
        if (msg.type === "shell-open" || msg.type === "shell-input" || msg.type === "shell-resize" || msg.type === "shell-close" ||
            msg.type === "shell-data" || msg.type === "shell-exit") {
          const target = this.devices.get(msg.to) || this.clients?.get(msg.to);
          if (target) {
            target.ws.send(JSON.stringify({ ...msg, from: deviceId }));
          }
        }

        // Screen capture relay — forward between devices/clients
        if (msg.type === "screen-start" || msg.type === "screen-stop" || msg.type === "screen-input" ||
            msg.type === "screen-frame") {
          const target = this.devices.get(msg.to) || this.clients?.get(msg.to);
          if (target) {
            target.ws.send(JSON.stringify({ ...msg, from: deviceId }));
          }
        }

        // HTTP/WS proxy relay — forward between app and device
        if (msg.type === "http-proxy-request" || msg.type === "http-proxy-response" ||
            msg.type === "ws-proxy-open" || msg.type === "ws-proxy-data" || msg.type === "ws-proxy-close") {
          const target = this.devices.get(msg.to) || this.clients?.get(msg.to);
          if (target) {
            target.ws.send(JSON.stringify({ ...msg, from: deviceId }));
          }
        }
      } catch {}
    });

    ws.addEventListener("close", () => {
      this.devices.delete(deviceId);
      this.clients?.delete(deviceId);
    });

    ws.addEventListener("error", () => {
      this.devices.delete(deviceId);
      this.clients?.delete(deviceId);
    });
  }

  private async saveHistory(task: Task) {
    const duration = task.completedAt ? task.completedAt - task.createdAt : null;
    this.sql.exec(
      `INSERT OR REPLACE INTO history (id, device, command, status, exit_code, created_at, completed_at, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id, task.device, task.command, task.status, task.exitCode, task.createdAt, task.completedAt, duration
    );
    // Prune old entries (keep last 500)
    this.sql.exec(`DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY created_at DESC LIMIT 500)`);
  }
}
