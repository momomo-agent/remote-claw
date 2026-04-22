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

const api = window.electronAPI;

let state = {
  tab: "terminal",
  connected: false,
  serverUrl: "",
  devices: [],
  history: [],
  selectedDevice: "",
  cmdText: "",
  executing: false,
  terminalLines: [],
  terminalInput: "",
  configRaw: null,
  pinned: false,
};

function formatDuration(seconds) {
  if (seconds < 60) return \`\${seconds}s\`;
  if (seconds < 3600) return \`\${Math.floor(seconds / 60)}m\`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return \`\${h}h\${m}m\`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function render() {
  const app = document.getElementById("app");
  const content = state.tab === "devices" ? renderDevices()
    : state.tab === "history" ? renderHistory()
    : state.tab === "settings" ? renderSettings()
    : renderTerminal();

  app.innerHTML = \`
    \${state.pinned ? '<div class="pin-close-btn" id="pin-close">✕</div>' : ''}
    <div class="header">
      <div class="status-dot \${state.connected ? "on" : "off"}" id="conn-toggle" style="cursor:pointer" title="Click to \${state.connected ? 'disconnect' : 'connect'}"></div>
      <div class="header-url">\${state.serverUrl || "..."}</div>
      <select class="device-picker" id="global-device">
        <option value="">no device</option>
        \${state.devices.map(d => \`<option value="\${d.id}" \${d.id === state.selectedDevice ? "selected" : ""}>\${d.name}</option>\`).join("")}
      </select>
    </div>
    <div class="tabs">
      <div class="tab \${state.tab === "terminal" ? "active" : ""}" data-tab="terminal">Terminal</div>
      <div class="tab \${state.tab === "devices" ? "active" : ""}" data-tab="devices">Devices</div>
      <div class="tab \${state.tab === "history" ? "active" : ""}" data-tab="history">History</div>
      <div class="tab \${state.tab === "settings" ? "active" : ""}" data-tab="settings">⚙</div>
    </div>
    <div class="content" id="content-area">
      \${content}
    </div>
  \`;
  bindEvents();
}

function renderTerminal() {
  const lines = state.terminalLines.map(l => {
    if (l.type === "cmd") return \`<div class="term-line term-cmd"><span class="term-prompt">\${escHtml(state.selectedDevice || "?")}$</span> \${escHtml(l.text)}</div>\`;
    if (l.type === "stdout") return \`<div class="term-line term-stdout">\${escHtml(l.text)}</div>\`;
    if (l.type === "stderr") return \`<div class="term-line term-stderr">\${escHtml(l.text)}</div>\`;
    if (l.type === "info") return \`<div class="term-line term-info">\${escHtml(l.text)}</div>\`;
    if (l.type === "error") return \`<div class="term-line term-error">\${escHtml(l.text)}</div>\`;
    return \`<div class="term-line">\${escHtml(l.text)}</div>\`;
  }).join("");

  return \`
    <div class="terminal" id="terminal">
      <div class="term-output" id="term-output">\${lines}</div>
      <div class="term-input-row">
        <span class="term-prompt">\${escHtml(state.selectedDevice || "?")}$</span>
        <input class="term-input" id="term-input" placeholder="\${state.selectedDevice ? "type a command..." : "select a device first"}"
          value="\${escHtml(state.terminalInput)}" \${!state.selectedDevice || state.executing ? "disabled" : ""} />
      </div>
    </div>
  \`;
}

function renderDevices() {
  if (!state.devices.length) return \`<div class="empty">No devices online</div>\`;
  return state.devices.map(d => \`
    <div class="device-item" data-device="\${escHtml(d.id)}">
      <div>
        <div class="device-name">\${escHtml(d.name)}</div>
        <div class="device-caps"></div>
      </div>
      <div class="device-time">
        <div style="color:#00c853;font-size:10px">online</div>
        <div>\${formatDuration(d.connectedFor || 0)}</div>
      </div>
    </div>
  \`).join("");
}

function renderHistory() {
  if (!state.history.length) return \`<div class="empty">No command history</div>\`;
  return state.history.map(h => \`
    <div class="history-item">
      <div class="history-cmd">\${escHtml(h.command)}</div>
      <div class="history-meta">
        <span>\${escHtml(h.device)}</span>
        <span class="history-status \${h.status}">\${h.status}</span>
        <span>\${h.duration ? (h.duration / 1000).toFixed(1) + "s" : ""}</span>
        <span>\${formatTime(h.createdAt)}</span>
      </div>
    </div>
  \`).join("");
}

function renderSettings() {
  return \`
    <div class="settings">
      <div class="settings-group">
        <div class="settings-label">Server</div>
        <input class="settings-input" id="s-server" value="\${escHtml(state.configRaw?.server || '')}" placeholder="wss://remote.momomo.dev" />
      </div>
      <div class="settings-group">
        <div class="settings-label">Token</div>
        <input class="settings-input" id="s-token" type="password" value="\${escHtml(state.configRaw?.token || '')}" placeholder="rclaw-..." />
      </div>
      <div class="settings-group">
        <div class="settings-label">Device Name</div>
        <input class="settings-input" id="s-device" value="\${escHtml(state.configRaw?.deviceName || '')}" placeholder="auto-detected" />
        <div class="settings-note">Leave empty for auto-detection</div>
      </div>
      <button class="settings-btn" id="s-save">Save & Reconnect</button>
      <div class="settings-saved" id="s-saved">Saved!</div>
    </div>
  \`;
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Command history (up/down arrow)
let cmdHistory = [];
let cmdHistoryIdx = -1;

function bindEvents() {
  document.querySelectorAll(".tab").forEach(el => {
    el.addEventListener("click", () => { state.tab = el.dataset.tab; render(); });
  });

  const gd = document.getElementById("global-device");
  if (gd) gd.addEventListener("change", (e) => { state.selectedDevice = e.target.value; render(); });

  // Terminal input
  const ti = document.getElementById("term-input");
  if (ti) {
    ti.addEventListener("input", (e) => { state.terminalInput = e.target.value; });
    ti.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { runTerminalCmd(); return; }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (cmdHistoryIdx < cmdHistory.length - 1) {
          cmdHistoryIdx++;
          state.terminalInput = cmdHistory[cmdHistory.length - 1 - cmdHistoryIdx];
          ti.value = state.terminalInput;
        }
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (cmdHistoryIdx > 0) {
          cmdHistoryIdx--;
          state.terminalInput = cmdHistory[cmdHistory.length - 1 - cmdHistoryIdx];
          ti.value = state.terminalInput;
        } else {
          cmdHistoryIdx = -1;
          state.terminalInput = "";
          ti.value = "";
        }
      }
      if (e.key === "l" && e.ctrlKey) {
        e.preventDefault();
        state.terminalLines = [];
        render();
      }
    });
    ti.focus();
  }

  // Click device to select
  document.querySelectorAll(".device-item").forEach(el => {
    el.addEventListener("click", () => {
      state.selectedDevice = el.dataset.device;
      state.tab = "terminal";
      render();
    });
  });

  // Settings save
  const saveBtn = document.getElementById("s-save");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    const cfg = {
      server: document.getElementById("s-server").value.trim() || "wss://remote.momomo.dev",
      token: document.getElementById("s-token").value.trim(),
    };
    const dn = document.getElementById("s-device").value.trim();
    if (dn) cfg.deviceName = dn;
    await api.saveConfig(cfg);
    const saved = document.getElementById("s-saved");
    if (saved) { saved.style.display = "block"; setTimeout(() => saved.style.display = "none", 2000); }
    await refreshData();
    render();
  });

  // Connection toggle
  const ct = document.getElementById("conn-toggle");
  if (ct) ct.addEventListener("click", async () => { await api.toggleConnection(); });

  // Pin close button
  const pinClose = document.getElementById("pin-close");
  if (pinClose) pinClose.addEventListener("click", () => api.closeWindow());

  // Scroll terminal to bottom
  const to = document.getElementById("term-output");
  if (to) to.scrollTop = to.scrollHeight;
}

async function runTerminalCmd() {
  const cmd = state.terminalInput.trim();
  if (!cmd || !state.selectedDevice || state.executing) return;

  // Special commands
  if (cmd === "clear") { state.terminalLines = []; state.terminalInput = ""; render(); return; }
  if (cmd === "devices") { state.tab = "devices"; state.terminalInput = ""; render(); return; }

  cmdHistory.push(cmd);
  cmdHistoryIdx = -1;
  state.terminalLines.push({ type: "cmd", text: cmd });
  state.terminalInput = "";
  state.executing = true;
  render();

  try {
    const result = await api.execCommand({ device: state.selectedDevice, command: cmd });
    if (result.error) {
      state.terminalLines.push({ type: "error", text: result.error });
    } else {
      if (result.stdout) state.terminalLines.push({ type: "stdout", text: result.stdout.replace(/\\n$/, "") });
      if (result.stderr) state.terminalLines.push({ type: "stderr", text: result.stderr.replace(/\\n$/, "") });
      const dur = result.completedAt && result.createdAt ? ((result.completedAt - result.createdAt) / 1000).toFixed(1) + "s" : "";
      state.terminalLines.push({ type: "info", text: \`exit \${result.exitCode}\${dur ? " · " + dur : ""}\` });
    }
  } catch (e) {
    state.terminalLines.push({ type: "error", text: e.message });
  }

  state.executing = false;
  if (state.terminalLines.length > 200) state.terminalLines = state.terminalLines.slice(-200);
  await refreshData();
  render();
}

async function refreshData() {
  const [cfg, devices, history] = await Promise.all([
    api.getConfig(),
    api.fetchDevices(),
    api.fetchHistory(50),
  ]);
  state.serverUrl = cfg.httpBase;
  state.connected = cfg.connected;
  state.configRaw = cfg.raw || null;
  state.devices = Array.isArray(devices) ? devices : [];
  state.history = Array.isArray(history) ? history : [];
  if (state.devices.length && !state.selectedDevice) state.selectedDevice = state.devices[0].id;
}

// ── Init ──

api.onDaemonStatus((data) => { state.connected = data.connected; render(); });
api.onRefresh(async () => { await refreshData(); render(); });
api.onPinnedChanged((data) => { state.pinned = data.pinned; render(); });

(async () => {
  const pinnedState = await api.getPinned();
  state.pinned = pinnedState?.pinned || false;
  await refreshData();
  render();
  setInterval(async () => { await refreshData(); render(); }, 5000);
})();
</script>
</body>
</html>
`;

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
