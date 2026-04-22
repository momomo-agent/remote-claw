// RemoteClaw Renderer
const { ipcRenderer } = require("electron");

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
};

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m}m`;
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

  app.innerHTML = `
    <div class="header">
      <div class="status-dot ${state.connected ? "on" : "off"}"></div>
      <div class="header-url">${state.serverUrl || "..."}</div>
      <select class="device-picker" id="global-device">
        <option value="">no device</option>
        ${state.devices.map(d => `<option value="${d.id}" ${d.id === state.selectedDevice ? "selected" : ""}>${d.name}</option>`).join("")}
      </select>
    </div>
    <div class="tabs">
      <div class="tab ${state.tab === "terminal" ? "active" : ""}" data-tab="terminal">Terminal</div>
      <div class="tab ${state.tab === "devices" ? "active" : ""}" data-tab="devices">Devices</div>
      <div class="tab ${state.tab === "history" ? "active" : ""}" data-tab="history">History</div>
      <div class="tab ${state.tab === "settings" ? "active" : ""}" data-tab="settings">⚙</div>
    </div>
    <div class="content" id="content-area">
      ${content}
    </div>
  `;
  bindEvents();
}

function renderTerminal() {
  const lines = state.terminalLines.map(l => {
    if (l.type === "cmd") return `<div class="term-line term-cmd"><span class="term-prompt">${escHtml(state.selectedDevice || "?")}$</span> ${escHtml(l.text)}</div>`;
    if (l.type === "stdout") return `<div class="term-line term-stdout">${escHtml(l.text)}</div>`;
    if (l.type === "stderr") return `<div class="term-line term-stderr">${escHtml(l.text)}</div>`;
    if (l.type === "info") return `<div class="term-line term-info">${escHtml(l.text)}</div>`;
    if (l.type === "error") return `<div class="term-line term-error">${escHtml(l.text)}</div>`;
    return `<div class="term-line">${escHtml(l.text)}</div>`;
  }).join("");

  return `
    <div class="terminal" id="terminal">
      <div class="term-output" id="term-output">${lines}</div>
      <div class="term-input-row">
        <span class="term-prompt">${escHtml(state.selectedDevice || "?")}$</span>
        <input class="term-input" id="term-input" placeholder="${state.selectedDevice ? "type a command..." : "select a device first"}" 
          value="${escHtml(state.terminalInput)}" ${!state.selectedDevice || state.executing ? "disabled" : ""} />
      </div>
    </div>
  `;
}

function renderDevices() {
  if (!state.devices.length) return `<div class="empty">No devices online</div>`;
  return state.devices.map(d => `
    <div class="device-item" data-device="${escHtml(d.id)}">
      <div>
        <div class="device-name">${escHtml(d.name)}</div>
        <div class="device-caps">${(d.capabilities || []).map(c => `<span class="cap-tag">${escHtml(c)}</span>`).join("")}</div>
      </div>
      <div class="device-time">
        <div style="color:#00c853;font-size:10px">online</div>
        <div>${formatDuration(d.connectedFor || 0)}</div>
      </div>
    </div>
  `).join("");
}

function renderHistory() {
  if (!state.history.length) return `<div class="empty">No command history</div>`;
  return state.history.map(h => `
    <div class="history-item">
      <div class="history-cmd">${escHtml(h.command)}</div>
      <div class="history-meta">
        <span>${escHtml(h.device)}</span>
        <span class="history-status ${h.status}">${h.status}</span>
        <span>${h.duration ? (h.duration / 1000).toFixed(1) + "s" : ""}</span>
        <span>${formatTime(h.createdAt)}</span>
      </div>
    </div>
  `).join("");
}

function renderSettings() {
  return `
    <div class="settings">
      <div class="settings-group">
        <div class="settings-label">Server</div>
        <input class="settings-input" id="s-server" value="${escHtml(state.configRaw?.server || '')}" placeholder="wss://remote.momomo.dev" />
      </div>
      <div class="settings-group">
        <div class="settings-label">Token</div>
        <input class="settings-input" id="s-token" type="password" value="${escHtml(state.configRaw?.token || '')}" placeholder="rclaw-..." />
      </div>
      <div class="settings-group">
        <div class="settings-label">Device Name</div>
        <input class="settings-input" id="s-device" value="${escHtml(state.configRaw?.deviceName || '')}" placeholder="auto-detected" />
        <div class="settings-note">Leave empty for auto-detection</div>
      </div>
      <div class="settings-group">
        <div class="settings-label">Capabilities</div>
        <input class="settings-input" id="s-caps" value="${escHtml((state.configRaw?.capabilities || []).join(', '))}" placeholder="shell, xcodebuild, screenshot" />
        <div class="settings-note">Comma-separated. Informational only, doesn't limit execution</div>
      </div>
      <button class="settings-btn" id="s-save">Save & Reconnect</button>
      <div class="settings-saved" id="s-saved">Saved!</div>
    </div>
  `;
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
      capabilities: document.getElementById("s-caps").value.split(",").map(s => s.trim()).filter(Boolean),
    };
    const dn = document.getElementById("s-device").value.trim();
    if (dn) cfg.deviceName = dn;
    await ipcRenderer.invoke("save-config", cfg);
    const saved = document.getElementById("s-saved");
    if (saved) { saved.style.display = "block"; setTimeout(() => saved.style.display = "none", 2000); }
    await refreshData();
    render();
  });

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
    const result = await ipcRenderer.invoke("exec-command", { device: state.selectedDevice, command: cmd });
    if (result.error) {
      state.terminalLines.push({ type: "error", text: result.error });
    } else {
      if (result.stdout) state.terminalLines.push({ type: "stdout", text: result.stdout.replace(/\n$/, "") });
      if (result.stderr) state.terminalLines.push({ type: "stderr", text: result.stderr.replace(/\n$/, "") });
      const dur = result.completedAt && result.createdAt ? ((result.completedAt - result.createdAt) / 1000).toFixed(1) + "s" : "";
      state.terminalLines.push({ type: "info", text: `exit ${result.exitCode}${dur ? " · " + dur : ""}` });
    }
  } catch (e) {
    state.terminalLines.push({ type: "error", text: e.message });
  }

  state.executing = false;
  // Keep last 200 lines
  if (state.terminalLines.length > 200) state.terminalLines = state.terminalLines.slice(-200);
  await refreshData();
  render();
}

async function refreshData() {
  const [cfg, devices, history] = await Promise.all([
    ipcRenderer.invoke("get-config"),
    ipcRenderer.invoke("fetch-devices"),
    ipcRenderer.invoke("fetch-history", 50),
  ]);
  state.serverUrl = cfg.httpBase;
  state.connected = cfg.connected;
  state.configRaw = cfg.raw || null;
  state.devices = Array.isArray(devices) ? devices : [];
  state.history = Array.isArray(history) ? history : [];
  if (state.devices.length && !state.selectedDevice) state.selectedDevice = state.devices[0].id;
}

// ── Init ──

ipcRenderer.on("daemon-status", (_, data) => { state.connected = data.connected; render(); });
ipcRenderer.on("refresh", async () => { await refreshData(); render(); });

(async () => {
  await refreshData();
  render();
  setInterval(async () => { await refreshData(); render(); }, 5000);
})();
