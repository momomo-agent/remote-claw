// RemoteClaw Renderer — Apple-style UI
const api = window.electronAPI;

// Detect detached window mode from URL params
const urlParams = new URLSearchParams(window.location.search);
const isDetached = urlParams.get('detached') === '1';
const detachedTab = urlParams.get('tab');
const detachedDevice = urlParams.get('device');

let state = {
  tab: detachedTab || "shell",
  connected: false,
  serverUrl: "",
  devices: [],
  history: [],
  selectedDevice: detachedDevice || "",
  cmdText: "",
  executing: false,
  terminalLines: [],
  terminalInput: "",
  configRaw: null,
  pinned: false,
  shellSessionId: null,
  shellStatus: "closed",
  // Files
  filesPath: "~",
  filesEntries: [],
  filesLoading: false,
  filesError: null,
};

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Render ──

function render() {
  const app = document.getElementById("app");
  const content = state.tab === "devices" ? renderDevices()
    : state.tab === "history" ? renderHistory()
    : state.tab === "settings" ? renderSettings()
    : state.tab === "terminal" ? renderTerminal()
    : state.tab === "shell" ? renderShell()
    : state.tab === "files" ? renderFiles()
    : renderShell();

  if (isDetached) {
    app.innerHTML = `
      <div class="detached-titlebar">
        <select class="device-select" id="global-device" style="margin-left:72px;font-size:13px;font-weight:500;color:var(--text)">
          <option value="">No device</option>
          ${state.devices.map(d => `<option value="${esc(d.id)}" ${d.id === state.selectedDevice ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
        <span style="flex:1"></span>
      </div>
      <div class="content" id="content-area" style="height:calc(100vh - 40px)">${content}</div>
    `;
  } else {
    app.innerHTML = `
      <div class="titlebar">
        <div class="titlebar-left">
          <div class="status-indicator ${state.connected ? 'on' : 'off'}" id="conn-toggle" title="${state.connected ? 'Connected' : 'Disconnected'}"></div>
          <select class="device-select device-title" id="global-device">
            <option value="">RemoteClaw</option>
            ${state.devices.map(d => `<option value="${esc(d.id)}" ${d.id === state.selectedDevice ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
          </select>
        </div>
        <div class="titlebar-right">
          ${state.pinned ? '<button class="pin-close" id="pin-close" title="Close">✕</button>' : ''}
        </div>
      </div>
      <div class="tabbar">
        ${['shell','terminal','files','devices','history','settings'].map(t => {
          const label = t === 'terminal' ? 'Exec' : t === 'settings' ? '⚙' : t.charAt(0).toUpperCase() + t.slice(1);
          return `<div class="tabbar-item ${state.tab === t ? 'active' : ''}" data-tab="${t}">${label}</div>`;
        }).join('')}
      </div>
      <div class="content" id="content-area">${content}</div>
    `;
  }
  bindEvents();
  if (state.tab === 'shell') initShellTab();
}

// ── Devices ──

function renderDevices() {
  if (!state.devices.length) return `<div class="empty"><div class="empty-icon">📡</div><div class="empty-text">No devices online</div></div>`;
  return `<div class="card">${state.devices.map(d => `
    <div class="card-row device-row" data-device="${esc(d.id)}">
      <div class="device-icon">${d.name?.includes('Mac') || d.name?.includes('mac') ? '💻' : '🖥'}</div>
      <div class="device-info">
        <div class="device-name">${esc(d.name)}</div>
        <div class="device-detail">${(d.capabilities || []).join(' · ')}</div>
      </div>
      <div class="device-status">
        <div class="device-online">Online</div>
        <div class="device-uptime">${formatDuration(d.connectedFor || 0)}</div>
      </div>
    </div>
  `).join('')}</div>`;
}

// ── History ──

function renderHistory() {
  if (!state.history.length) return `<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">No command history</div></div>`;
  return `<div class="card">${state.history.map(h => `
    <div class="card-row history-row">
      <div class="history-cmd">${esc(h.command)}</div>
      <div class="history-meta">
        <span>${esc(h.device)}</span>
        <span class="history-badge badge-${h.status}">${h.status}</span>
        ${h.duration ? `<span>${(h.duration / 1000).toFixed(1)}s</span>` : ''}
        <span>${formatTime(h.createdAt)}</span>
      </div>
    </div>
  `).join('')}</div>`;
}

// ── Terminal (Exec) ──

function renderTerminal() {
  const lines = state.terminalLines.map(l => {
    if (l.type === 'cmd') return `<div class="term-line term-cmd"><span class="term-prompt">${esc(state.selectedDevice || '?')}$</span> ${esc(l.text)}</div>`;
    if (l.type === 'stdout') return `<div class="term-line term-stdout">${esc(l.text)}</div>`;
    if (l.type === 'stderr') return `<div class="term-line term-stderr">${esc(l.text)}</div>`;
    if (l.type === 'info') return `<div class="term-line term-info">${esc(l.text)}</div>`;
    if (l.type === 'error') return `<div class="term-line term-error">${esc(l.text)}</div>`;
    return `<div class="term-line">${esc(l.text)}</div>`;
  }).join('');
  return `
    <div class="terminal">
      <div class="term-output" id="term-output">${lines}</div>
      <div class="term-input-row">
        <span class="term-prompt">${esc(state.selectedDevice || '?')}$</span>
        <input class="term-input" id="term-input" placeholder="${state.selectedDevice ? 'Type a command...' : 'Select a device first'}"
          value="${esc(state.terminalInput)}" ${!state.selectedDevice || state.executing ? 'disabled' : ''} />
      </div>
    </div>
  `;
}

// ── Shell (PTY) ──

let xterm = null;
let xtermFit = null;
let shellResizeObserver = null;
let shellConnectTimeout = null;

function renderShell() {
  if (!state.selectedDevice) {
    return `<div class="empty"><div class="empty-icon">⌨️</div><div class="empty-text">Select a device to open a shell</div></div>`;
  }
  const statusText = state.shellStatus === 'open' ? 'Connected' : state.shellStatus === 'connecting' ? 'Connecting...' : 'Disconnected';
  const statusColor = state.shellStatus === 'open' ? 'var(--green)' : state.shellStatus === 'connecting' ? 'var(--orange)' : 'var(--text-tertiary)';
  return `
    <div class="shell-container">
      <div id="xterm-container"></div>
      ${state.shellStatus !== 'open' ? `
        <div class="shell-overlay">
          <div class="shell-overlay-content">
            <div class="shell-overlay-status" style="color:${statusColor}">${statusText}</div>
            ${state.shellStatus === 'closed' ? '<button class="shell-overlay-btn" id="shell-connect">Connect</button>' : ''}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function initShellTab() {
  const container = document.getElementById('xterm-container');
  if (!container) return;
  if (xterm && state.shellStatus === 'open') {
    container.appendChild(xterm.element);
    xtermFit.fit();
    xterm.focus();
    return;
  }
  if (xterm) { xterm.dispose(); xterm = null; }
  if (shellResizeObserver) { shellResizeObserver.disconnect(); shellResizeObserver = null; }

  xterm = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: '"Geist Mono", "SF Mono", Menlo, Monaco, monospace',
    theme: { background: '#161618', foreground: '#ececf0', cursor: '#3b82f6', selectionBackground: 'rgba(59,130,246,0.2)', black: '#161618', brightBlack: '#56565a' },
    allowProposedApi: true,
  });
  xtermFit = new FitAddon.FitAddon();
  xterm.loadAddon(xtermFit);
  xterm.open(container);
  xtermFit.fit();

  shellResizeObserver = new ResizeObserver(() => {
    if (xtermFit) {
      xtermFit.fit();
      if (state.shellSessionId && state.shellStatus === 'open') {
        api.invoke('shell-resize', { sessionId: state.shellSessionId, cols: xterm.cols, rows: xterm.rows, device: state.selectedDevice });
      }
    }
  });
  shellResizeObserver.observe(container);

  xterm.onData((data) => {
    if (state.shellSessionId && state.shellStatus === 'open') {
      api.invoke('shell-input', { sessionId: state.shellSessionId, data: btoa(unescape(encodeURIComponent(data))), device: state.selectedDevice });
    }
  });
  xterm.focus();

  if (state.shellStatus === 'closed' && state.selectedDevice) openShellSession();

  const connectBtn = document.getElementById('shell-connect');
  if (connectBtn) connectBtn.addEventListener('click', openShellSession);
}

function openShellSession() {
  if (!state.selectedDevice || !xterm) return;
  if (state.shellSessionId) api.invoke('shell-close', { sessionId: state.shellSessionId, device: state.selectedDevice });
  state.shellSessionId = crypto.randomUUID();
  state.shellStatus = 'connecting';
  xterm.clear();
  xterm.writeln('\x1b[90mConnecting to ' + state.selectedDevice + '...\x1b[0m');
  api.invoke('shell-open', { device: state.selectedDevice, sessionId: state.shellSessionId, cols: xterm.cols, rows: xterm.rows });
  clearTimeout(shellConnectTimeout);
  shellConnectTimeout = setTimeout(() => {
    if (state.shellStatus === 'connecting') {
      state.shellStatus = 'closed';
      xterm.writeln('\x1b[31mConnection timed out.\x1b[0m');
      updateShellStatus();
    }
  }, 5000);
}

function closeShellSession() {
  if (state.shellSessionId) api.invoke('shell-close', { sessionId: state.shellSessionId, device: state.selectedDevice });
  state.shellSessionId = null;
  state.shellStatus = 'closed';
  if (xterm) xterm.writeln('\r\n\x1b[90mDisconnected.\x1b[0m');
  updateShellStatus();
}

function updateShellStatus() {
  const el = document.querySelector('.shell-status');
  if (!el) return;
  const t = state.shellStatus === 'open' ? 'Connected' : state.shellStatus === 'connecting' ? 'Connecting...' : 'Disconnected';
  const c = state.shellStatus === 'open' ? 'var(--green)' : state.shellStatus === 'connecting' ? 'var(--orange)' : 'var(--text-tertiary)';
  el.textContent = t; el.style.color = c;
  const db = document.getElementById('shell-disconnect');
  if (db) db.disabled = state.shellStatus === 'closed';
}

// ── Files ──

function renderFiles() {
  if (!state.selectedDevice) {
    return `<div class="empty"><div class="empty-icon">📁</div><div class="empty-text">Select a device to browse files</div></div>`;
  }
  const pathParts = state.filesPath.split('/').filter(Boolean);
  const breadcrumb = pathParts.map((p, i) => {
    const full = '/' + pathParts.slice(0, i + 1).join('/');
    return `<span class="files-btn" data-nav="${esc(full)}">${esc(p)}</span>`;
  }).join(' / ');

  let body = '';
  if (state.filesLoading) {
    body = '<div class="loading">Loading...</div>';
  } else if (state.filesError) {
    body = `<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-text">${esc(state.filesError)}</div></div>`;
  } else if (!state.filesEntries.length) {
    body = '<div class="empty"><div class="empty-icon">📂</div><div class="empty-text">Empty directory</div></div>';
  } else {
    body = `<div class="card">${state.filesEntries.map(f => `
      <div class="card-row file-row" data-file="${esc(f.name)}" data-isdir="${f.isDir}">
        <div class="file-icon">${f.isDir ? '📁' : f.isSymlink ? '🔗' : fileIcon(f.name)}</div>
        <div class="file-info">
          <div class="file-name ${f.isDir ? 'dir' : ''}">${esc(f.name)}</div>
          ${f.mtime ? `<div class="file-meta">${new Date(f.mtime).toLocaleDateString()}</div>` : ''}
        </div>
        <div class="file-size">${f.isDir ? '' : formatSize(f.size)}</div>
      </div>
    `).join('')}</div>`;
  }

  return `
    <div class="files-toolbar">
      <button class="files-btn" id="files-up" title="Go up">↑</button>
      <div class="files-path">${state.filesPath === '~' ? '~' : breadcrumb || '/'}</div>
      <button class="files-btn" id="files-refresh" title="Refresh">↻</button>
      <button class="files-btn" id="files-editor" title="Open in Editor">✎ Code</button>
    </div>
    ${body}
  `;
}

function fileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  const icons = { js: '📄', ts: '📄', py: '🐍', json: '📋', md: '📝', txt: '📝', sh: '⚙', yml: '⚙', yaml: '⚙', png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', mp4: '🎬', mov: '🎬', zip: '📦', gz: '📦', tar: '📦', pdf: '📕' };
  return icons[ext] || '📄';
}

async function loadFiles(dirPath) {
  if (!state.selectedDevice) return;
  state.filesLoading = true;
  state.filesError = null;
  render();

  try {
    // Resolve ~ to home dir
    let resolvedPath = dirPath;
    if (dirPath === '~' || dirPath.startsWith('~/')) {
      const result = await apiFetch('/exec', {
        method: 'POST',
        body: JSON.stringify({ device: state.selectedDevice, command: 'echo $HOME', oneshot: true, timeout: 5000 }),
        fallback: { error: 'failed' },
      });
      const home = result.stdout?.trim();
      if (home) resolvedPath = dirPath === '~' ? home : home + dirPath.slice(1);
    }

    const result = await apiFetch('/exec', {
      method: 'POST',
      body: JSON.stringify({
        device: state.selectedDevice,
        command: `ls -la "${resolvedPath}" 2>&1 | head -100`,
        oneshot: true, timeout: 10000,
      }),
      fallback: { error: 'failed' },
    });

    if (result.error) { state.filesError = result.error; }
    else if (result.exitCode !== 0) { state.filesError = result.stderr || result.stdout || 'Failed to list directory'; }
    else {
      const lines = (result.stdout || '').split('\n').filter(l => l.trim() && !l.startsWith('total'));
      state.filesEntries = lines.map(parseLsLine).filter(Boolean)
        .filter(f => f.name !== '.' && f.name !== '..')
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      state.filesPath = resolvedPath;
    }
  } catch (e) { state.filesError = e.message; }

  state.filesLoading = false;
  render();
}

function parseLsLine(line) {
  // drwxr-xr-x  5 user  staff  160 Apr 22 10:30 dirname
  const m = line.match(/^([dlcbsp-])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/);
  if (!m) return null;
  const isDir = m[1] === 'd';
  const isSymlink = m[1] === 'l';
  let name = m[5];
  if (isSymlink && name.includes(' -> ')) name = name.split(' -> ')[0];
  return { name, isDir, isSymlink, isFile: m[1] === '-', size: parseInt(m[3]), mtime: m[4] };
}

// ── Settings ──

function renderSettings() {
  return `
    <div class="settings">
      <div class="settings-section">
        <div class="settings-label">Server</div>
        <input class="settings-input" id="s-server" value="${esc(state.configRaw?.server || '')}" placeholder="wss://remote.momomo.dev" />
        <div class="settings-label">Token</div>
        <input class="settings-input" id="s-token" type="password" value="${esc(state.configRaw?.token || '')}" placeholder="rclaw-..." />
        <div class="settings-label">Device Name</div>
        <input class="settings-input" id="s-device" value="${esc(state.configRaw?.deviceName || '')}" placeholder="Auto-detected" />
        <div class="settings-note">Leave empty for auto-detection</div>
      </div>
      <button class="settings-save" id="s-save">Save & Reconnect</button>
      <div class="settings-saved" id="s-saved">Saved!</div>
    </div>
  `;
}

// ── Events ──

let cmdHistory = [];
let cmdHistoryIdx = -1;

function bindEvents() {
  // Tab click + double-click to detach
  document.querySelectorAll('.tabbar-item').forEach(el => {
    el.addEventListener('click', () => {
      state.tab = el.dataset.tab;
      render();
      if (state.tab === 'files' && !state.filesEntries.length && !state.filesLoading) loadFiles(state.filesPath);
    });
    el.addEventListener('dblclick', () => {
      const tab = el.dataset.tab;
      if (['shell', 'terminal', 'files'].includes(tab)) {
        api.invoke('open-tab-window', { tab, device: state.selectedDevice, title: `RemoteClaw \u2014 ${tab.charAt(0).toUpperCase() + tab.slice(1)}` });
      }
    });
  });

  const gd = document.getElementById('global-device');
  if (gd) gd.addEventListener('change', (e) => {
    if (e.target.value !== state.selectedDevice && state.shellSessionId) closeShellSession();
    state.selectedDevice = e.target.value;
    state.filesEntries = []; state.filesPath = '~';
    render();
  });

  const ti = document.getElementById('term-input');
  if (ti) {
    ti.addEventListener('input', (e) => { state.terminalInput = e.target.value; });
    ti.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { runTerminalCmd(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (cmdHistoryIdx < cmdHistory.length - 1) { cmdHistoryIdx++; state.terminalInput = cmdHistory[cmdHistory.length - 1 - cmdHistoryIdx]; ti.value = state.terminalInput; } }
      if (e.key === 'ArrowDown') { e.preventDefault(); if (cmdHistoryIdx > 0) { cmdHistoryIdx--; state.terminalInput = cmdHistory[cmdHistory.length - 1 - cmdHistoryIdx]; ti.value = state.terminalInput; } else { cmdHistoryIdx = -1; state.terminalInput = ''; ti.value = ''; } }
      if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); state.terminalLines = []; render(); }
    });
    ti.focus();
  }

  document.querySelectorAll('.device-row[data-device]').forEach(el => {
    el.addEventListener('click', () => { state.selectedDevice = el.dataset.device; state.tab = 'shell'; render(); });
  });

  const saveBtn = document.getElementById('s-save');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const cfg = { server: document.getElementById('s-server').value.trim() || 'wss://remote.momomo.dev', token: document.getElementById('s-token').value.trim() };
    const dn = document.getElementById('s-device').value.trim();
    if (dn) cfg.deviceName = dn;
    await api.saveConfig(cfg);
    const saved = document.getElementById('s-saved');
    if (saved) { saved.style.display = 'block'; setTimeout(() => saved.style.display = 'none', 2000); }
    await refreshData(); render();
  });

  const ct = document.getElementById('conn-toggle');
  if (ct) ct.addEventListener('click', async () => { await api.toggleConnection(); });

  const pinClose = document.getElementById('pin-close');
  if (pinClose) pinClose.addEventListener('click', () => api.closeWindow());

  const to = document.getElementById('term-output');
  if (to) to.scrollTop = to.scrollHeight;

  // Files events
  const filesUp = document.getElementById('files-up');
  if (filesUp) filesUp.addEventListener('click', () => {
    const parent = state.filesPath.replace(/\/[^\/]+\/?$/, '') || '/';
    loadFiles(parent);
  });
  const filesRefresh = document.getElementById('files-refresh');
  if (filesRefresh) filesRefresh.addEventListener('click', () => loadFiles(state.filesPath));

  const filesEditor = document.getElementById('files-editor');
  if (filesEditor) filesEditor.addEventListener('click', () => {
    api.invoke('open-editor', { dir: state.filesPath, device: state.selectedDevice });
  });

  document.querySelectorAll('.file-row[data-isdir="true"]').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.file;
      const newPath = state.filesPath === '/' ? '/' + name : state.filesPath + '/' + name;
      loadFiles(newPath);
    });
  });

  // Click file to preview
  document.querySelectorAll('.file-row[data-isdir="false"]').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.file;
      const fullPath = state.filesPath + '/' + name;
      const ext = name.split('.').pop()?.toLowerCase();
      const previewable = ['md','markdown','txt','json','js','ts','py','sh','yml','yaml','swift','m','h','c','cpp','css','html','xml','toml','ini','conf','log'];
      if (previewable.includes(ext)) {
        api.invoke('open-editor', { dir: state.filesPath, file: fullPath, device: state.selectedDevice, title: name });
      }
    });
  });

  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); loadFiles(el.dataset.nav); });
  });
}

async function runTerminalCmd() {
  const cmd = state.terminalInput.trim();
  if (!cmd || !state.selectedDevice || state.executing) return;
  if (cmd === 'clear') { state.terminalLines = []; state.terminalInput = ''; render(); return; }

  cmdHistory.push(cmd); cmdHistoryIdx = -1;
  state.terminalLines.push({ type: 'cmd', text: cmd });
  state.terminalInput = ''; state.executing = true;
  render();

  try {
    const result = await apiFetch('/exec', {
      method: 'POST',
      body: JSON.stringify({ device: state.selectedDevice, command: cmd, oneshot: true, timeout: 30000 }),
      fallback: { error: 'request failed' },
    });
    if (result.error) { state.terminalLines.push({ type: 'error', text: result.error }); }
    else {
      if (result.stdout) state.terminalLines.push({ type: 'stdout', text: result.stdout.replace(/\n$/, '') });
      if (result.stderr) state.terminalLines.push({ type: 'stderr', text: result.stderr.replace(/\n$/, '') });
      const dur = result.completedAt && result.createdAt ? ((result.completedAt - result.createdAt) / 1000).toFixed(1) + 's' : '';
      state.terminalLines.push({ type: 'info', text: `exit ${result.exitCode}${dur ? ' · ' + dur : ''}` });
    }
  } catch (e) { state.terminalLines.push({ type: 'error', text: e.message }); }

  state.executing = false;
  if (state.terminalLines.length > 200) state.terminalLines = state.terminalLines.slice(-200);
  await refreshData(); render();
}

// ── API ──

let _httpBase = null;
let _token = null;

async function ensureConfig() {
  if (!_httpBase) {
    const cfg = await api.getConfig();
    _httpBase = cfg.httpBase; _token = cfg.raw?.token;
    state.serverUrl = cfg.httpBase; state.connected = cfg.connected;
    state.configRaw = cfg.raw || null;
  }
}

async function apiFetch(path, opts = {}) {
  await ensureConfig();
  try {
    const res = await fetch(`${_httpBase}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${_token}`, 'Content-Type': 'application/json', ...opts.headers },
    });
    return await res.json();
  } catch { return opts.fallback ?? []; }
}

async function refreshData() {
  await ensureConfig();
  const cfg = await api.getConfig();
  state.connected = cfg.connected; state.configRaw = cfg.raw || null;
  const [devices, history] = await Promise.all([
    apiFetch('/devices'), apiFetch('/history?limit=50'),
  ]);
  state.devices = Array.isArray(devices) ? devices : [];
  state.history = Array.isArray(history) ? history : [];
  if (state.devices.length && !state.selectedDevice) state.selectedDevice = state.devices[0].id;
}

// ── Events from main ──

api.onDaemonStatus((data) => { state.connected = data.connected; render(); });
api.onRefresh(async () => { await refreshData(); render(); });
api.onPinnedChanged((data) => { state.pinned = data.pinned; render(); });

api.on('window-moved', (data) => {
  if (state.pinned || !data.trayBounds) return;
  const wb = data.bounds, tb = data.trayBounds;
  const dx = Math.abs(wb.x - (tb.x - wb.width / 2 + tb.width / 2));
  const dy = Math.abs(wb.y - (tb.y + tb.height));
  if (dx > 50 || dy > 50) api.invoke('set-pinned', { pinned: true });
});

api.on('shell-data', (msg) => {
  if (msg.sessionId !== state.shellSessionId) return;
  if (state.shellStatus === 'connecting') {
    state.shellStatus = 'open';
    clearTimeout(shellConnectTimeout);
    updateShellStatus();
  }
  if (xterm) {
    try { xterm.write(decodeURIComponent(escape(atob(msg.data)))); }
    catch { xterm.write(atob(msg.data)); }
  }
});

api.on('shell-exit', (msg) => {
  if (msg.sessionId !== state.shellSessionId) return;
  state.shellStatus = 'closed'; state.shellSessionId = null;
  if (xterm) xterm.writeln(`\r\n\x1b[90mShell exited (code ${msg.exitCode})\x1b[0m`);
  updateShellStatus();
});

// ── Init ──

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Cmd+K: clear shell or terminal
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    if (state.tab === 'shell' && xterm) {
      xterm.clear();
    } else if (state.tab === 'terminal') {
      state.terminalLines = [];
      render();
    }
  }
});

(async () => {
  const pinnedState = await api.getPinned();
  state.pinned = pinnedState?.pinned || false;
  await refreshData();
  render();
  setInterval(async () => { await refreshData(); render(); }, 5000);
})();
