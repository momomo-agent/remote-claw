// RemoteClaw Renderer
const api = window.electronAPI;

let state = {
  tab: "shell",
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
  shellSessionId: null,
  shellStatus: "closed", // closed | connecting | open
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
    : state.tab === "terminal" ? renderTerminal()
    : state.tab === "shell" ? renderShell()
    : renderTerminal();

  app.innerHTML = `
    ${state.pinned ? '<div class="pin-close-btn" id="pin-close">✕</div>' : ''}
    <div class="header">
      <div class="status-dot ${state.connected ? "on" : "off"}" id="conn-toggle" style="cursor:pointer" title="Click to ${state.connected ? 'disconnect' : 'connect'}"></div>
      <div class="header-url">${state.serverUrl || "..."}</div>
      <select class="device-picker" id="global-device">
        <option value="">no device</option>
        ${state.devices.map(d => `<option value="${d.id}" ${d.id === state.selectedDevice ? "selected" : ""}>${d.name}</option>`).join("")}
      </select>
    </div>
    <div class="tabs">
      <div class="tab ${state.tab === "shell" ? "active" : ""}" data-tab="shell">Shell</div>
      <div class="tab ${state.tab === "terminal" ? "active" : ""}" data-tab="terminal">Exec</div>
      <div class="tab ${state.tab === "devices" ? "active" : ""}" data-tab="devices">Devices</div>
      <div class="tab ${state.tab === "history" ? "active" : ""}" data-tab="history">History</div>
      <div class="tab ${state.tab === "settings" ? "active" : ""}" data-tab="settings">⚙</div>
    </div>
    <div class="content" id="content-area">
      ${content}
    </div>
  `;
  bindEvents();
  if (state.tab === "shell") initShellTab();
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
        <div class="device-caps"></div>
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
      <button class="settings-btn" id="s-save">Save & Reconnect</button>
      <div class="settings-saved" id="s-saved">Saved!</div>
    </div>
  `;
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Shell (PTY) ──

let xterm = null;
let xtermFit = null;
let shellResizeObserver = null;

function renderShell() {
  if (!state.selectedDevice) {
    return `<div class="empty">Select a device to open a shell</div>`;
  }
  const statusText = state.shellStatus === "open" ? "connected" : state.shellStatus === "connecting" ? "connecting..." : "disconnected";
  const statusColor = state.shellStatus === "open" ? "#00c853" : state.shellStatus === "connecting" ? "#ff9800" : "#666";
  return `
    <div class="shell-container">
      <div class="shell-toolbar">
        <button id="shell-connect">${state.shellStatus === "closed" ? "Connect" : "Reconnect"}</button>
        <button id="shell-disconnect" ${state.shellStatus === "closed" ? "disabled" : ""}>Disconnect</button>
        <span class="shell-status" style="color:${statusColor}">${statusText}</span>
      </div>
      <div id="xterm-container"></div>
    </div>
  `;
}

function initShellTab() {
  const container = document.getElementById("xterm-container");
  if (!container) return;

  // Reuse existing xterm if still valid
  if (xterm && state.shellStatus === "open") {
    container.appendChild(xterm.element);
    xtermFit.fit();
    xterm.focus();
    return;
  }

  // Create fresh xterm
  if (xterm) { xterm.dispose(); xterm = null; }
  if (shellResizeObserver) { shellResizeObserver.disconnect(); shellResizeObserver = null; }

  xterm = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
    theme: { background: "#0f0f1a", foreground: "#e0e0e0", cursor: "#7c8aff", selectionBackground: "#7c8aff44" },
    allowProposedApi: true,
  });
  xtermFit = new FitAddon.FitAddon();
  xterm.loadAddon(xtermFit);
  xterm.open(container);
  xtermFit.fit();

  // Auto-resize on container size change
  shellResizeObserver = new ResizeObserver(() => {
    if (xtermFit) {
      xtermFit.fit();
      if (state.shellSessionId && state.shellStatus === "open") {
        api.invoke("shell-resize", { sessionId: state.shellSessionId, cols: xterm.cols, rows: xterm.rows, device: state.selectedDevice });
      }
    }
  });
  shellResizeObserver.observe(container);

  // Forward user input to daemon
  xterm.onData((data) => {
    if (state.shellSessionId && state.shellStatus === "open") {
      const b64 = btoa(unescape(encodeURIComponent(data)));
      api.invoke("shell-input", { sessionId: state.shellSessionId, data: b64, device: state.selectedDevice });
    }
  });

  xterm.focus();

  // Auto-connect if no session
  if (state.shellStatus === "closed" && state.selectedDevice) {
    openShellSession();
  }

  // Bind toolbar buttons
  const connectBtn = document.getElementById("shell-connect");
  const disconnectBtn = document.getElementById("shell-disconnect");
  if (connectBtn) connectBtn.addEventListener("click", openShellSession);
  if (disconnectBtn) disconnectBtn.addEventListener("click", closeShellSession);
}

function openShellSession() {
  if (!state.selectedDevice || !xterm) return;
  // Close existing session
  if (state.shellSessionId) {
    api.invoke("shell-close", { sessionId: state.shellSessionId, device: state.selectedDevice });
  }
  state.shellSessionId = crypto.randomUUID();
  state.shellStatus = "connecting";
  xterm.clear();
  xterm.writeln("\x1b[90mConnecting to " + state.selectedDevice + "...\x1b[0m");
  api.invoke("shell-open", { device: state.selectedDevice, sessionId: state.shellSessionId, cols: xterm.cols, rows: xterm.rows });
  // Timeout — if no data received in 5s, show error
  shellConnectTimeout = setTimeout(() => {
    if (state.shellStatus === "connecting") {
      state.shellStatus = "error";
      xterm.writeln("\x1b[31mConnection timed out. Device may not support shell or is offline.\x1b[0m");
      xterm.writeln("\x1b[90mTry selecting a different device or click Reconnect.\x1b[0m");
      updateShellStatus();
    }
  }, 5000);
}
let shellConnectTimeout = null;

function closeShellSession() {
  if (state.shellSessionId) {
    api.invoke("shell-close", { sessionId: state.shellSessionId, device: state.selectedDevice });
  }
  state.shellSessionId = null;
  state.shellStatus = "closed";
  if (xterm) xterm.writeln("\r\n\x1b[90mDisconnected.\x1b[0m");
  updateShellStatus();
}

function updateShellStatus() {
  const el = document.querySelector(".shell-status");
  if (!el) return;
  const statusText = state.shellStatus === "open" ? "connected" : state.shellStatus === "connecting" ? "connecting..." : "disconnected";
  const statusColor = state.shellStatus === "open" ? "#00c853" : state.shellStatus === "connecting" ? "#ff9800" : "#666";
  el.textContent = statusText;
  el.style.color = statusColor;
  const disconnectBtn = document.getElementById("shell-disconnect");
  if (disconnectBtn) disconnectBtn.disabled = state.shellStatus === "closed";
}

// Command history (up/down arrow)
let cmdHistory = [];
let cmdHistoryIdx = -1;

function bindEvents() {
  document.querySelectorAll(".tab").forEach(el => {
    el.addEventListener("click", () => { state.tab = el.dataset.tab; render(); });
  });

  const gd = document.getElementById("global-device");
  if (gd) gd.addEventListener("change", (e) => {
    const newDevice = e.target.value;
    // Close shell session if device changed
    if (newDevice !== state.selectedDevice && state.shellSessionId) {
      closeShellSession();
    }
    state.selectedDevice = newDevice;
    render();
  });

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
      if (result.stdout) state.terminalLines.push({ type: "stdout", text: result.stdout.replace(/\n$/, "") });
      if (result.stderr) state.terminalLines.push({ type: "stderr", text: result.stderr.replace(/\n$/, "") });
      const dur = result.completedAt && result.createdAt ? ((result.completedAt - result.createdAt) / 1000).toFixed(1) + "s" : "";
      state.terminalLines.push({ type: "info", text: `exit ${result.exitCode}${dur ? " · " + dur : ""}` });
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

// Pin detection — runs in renderer (hot-updatable)
api.on("window-moved", (data) => {
  if (state.pinned || !data.trayBounds) return;
  const wb = data.bounds;
  const tb = data.trayBounds;
  const dx = Math.abs(wb.x - (tb.x - wb.width / 2 + tb.width / 2));
  const dy = Math.abs(wb.y - (tb.y + tb.height));
  if (dx > 50 || dy > 50) {
    api.invoke("set-pinned", { pinned: true });
  }
});

// Shell session events from daemon
api.on("shell-data", (msg) => {
  if (msg.sessionId !== state.shellSessionId) return;
  if (state.shellStatus === "connecting") {
    state.shellStatus = "open";
    clearTimeout(shellConnectTimeout);
    updateShellStatus();
  }
  if (xterm) {
    try {
      const decoded = decodeURIComponent(escape(atob(msg.data)));
      xterm.write(decoded);
    } catch {
      xterm.write(atob(msg.data));
    }
  }
});

api.on("shell-exit", (msg) => {
  if (msg.sessionId !== state.shellSessionId) return;
  state.shellStatus = "closed";
  state.shellSessionId = null;
  if (xterm) {
    const reason = msg.error ? ` (${msg.error})` : "";
    xterm.writeln(`\r\n\x1b[90mShell exited with code ${msg.exitCode}${reason}\x1b[0m`);
  }
  updateShellStatus();
});

(async () => {
  const pinnedState = await api.getPinned();
  state.pinned = pinnedState?.pinned || false;
  await refreshData();
  render();
  setInterval(async () => { await refreshData(); render(); }, 5000);
})();