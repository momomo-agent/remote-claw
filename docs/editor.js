// RemoteClaw Editor — Monaco + file tree + integrated terminal
const api = window.electronAPI;
const params = new URLSearchParams(window.location.search);
const device = params.get('device') || '';
const initDir = params.get('dir') || '~';
const initFile = params.get('file') || '';

let currentDir = initDir;
let entries = [];
let openTabs = []; // { path, content, originalContent, model }
let activeTab = null;
let monacoEditor = null;
let termXterm = null;
let termFit = null;
let termSessionId = null;
let termCollapsed = false;

// ── Remote exec helper ──
async function remoteExec(command, timeout = 10000) {
  const cfg = await api.getConfig();
  try {
    const res = await fetch(`${cfg.httpBase}/exec`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.raw?.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device, command, oneshot: true, timeout }),
    });
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

// ── File tree ──
async function loadDir(dir) {
  // Resolve ~
  if (dir === '~' || dir.startsWith('~/')) {
    const r = await remoteExec('echo $HOME');
    const home = r.stdout?.trim();
    if (home) dir = dir === '~' ? home : home + dir.slice(1);
  }
  currentDir = dir;
  document.getElementById('sidebar-path').textContent = dir;
  document.getElementById('sidebar-title').textContent = dir.split('/').pop() || '/';

  const result = await remoteExec(`ls -la "${dir}" 2>&1 | head -200`);
  if (result.error || result.exitCode !== 0) return;

  const lines = (result.stdout || '').split('\n').filter(l => l.trim() && !l.startsWith('total'));
  entries = lines.map(parseLsLine).filter(Boolean)
    .filter(f => f.name !== '.' && f.name !== '..')
    .sort((a, b) => { if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; return a.name.localeCompare(b.name); });
  renderTree();
}

function parseLsLine(line) {
  const m = line.match(/^([dlcbsp-])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/);
  if (!m) return null;
  let name = m[5];
  if (m[1] === 'l' && name.includes(' -> ')) name = name.split(' -> ')[0];
  return { name, isDir: m[1] === 'd', isSymlink: m[1] === 'l', size: parseInt(m[3]) };
}

function fileIcon(name, isDir) {
  if (isDir) return '📁';
  const ext = name.split('.').pop()?.toLowerCase();
  const m = { js:'JS', ts:'TS', py:'PY', swift:'SW', json:'{}', md:'MD', sh:'$', yml:'YM', yaml:'YM', html:'<>', css:'#', c:'C', h:'H', m:'M', rs:'RS', go:'GO', rb:'RB', java:'JV', xml:'<>', toml:'TM', txt:'TX', log:'LG' };
  return m[ext] || '··';
}

function renderTree() {
  const tree = document.getElementById('sidebar-tree');
  let html = `<div class="tree-item dir" data-action="up"><span class="tree-icon">↑</span><span class="tree-name">..</span></div>`;
  html += entries.map(f => {
    const fullPath = currentDir + '/' + f.name;
    const isActive = activeTab === fullPath;
    const cls = isActive ? 'tree-item active' : f.isDir ? 'tree-item dir' : 'tree-item';
    const icon = f.isDir ? '📁' : `<span style="font-family:var(--mono);font-size:9px;color:var(--text-tertiary)">${fileIcon(f.name, false)}</span>`;
    return `<div class="${cls}" data-path="${esc(fullPath)}" data-isdir="${f.isDir}" data-name="${esc(f.name)}"><span class="tree-icon">${icon}</span><span class="tree-name">${esc(f.name)}</span></div>`;
  }).join('');
  tree.innerHTML = html;

  tree.querySelectorAll('.tree-item').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.action === 'up') { loadDir(currentDir.replace(/\/[^/]+\/?$/, '') || '/'); return; }
      if (el.dataset.isdir === 'true') { loadDir(el.dataset.path); return; }
      openFile(el.dataset.path);
    });
  });
}

// ── File tabs & editor ──
async function openFile(path) {
  // Check if already open
  let tab = openTabs.find(t => t.path === path);
  if (!tab) {
    const result = await remoteExec(`cat "${path}" 2>&1 | head -5000`);
    if (result.error || result.exitCode !== 0) return;
    const content = result.stdout || '';
    const lang = guessLanguage(path);
    const model = monaco.editor.createModel(content, lang, monaco.Uri.parse('file://' + path));
    tab = { path, content, originalContent: content, model };
    openTabs.push(tab);
  }
  activeTab = path;
  monacoEditor.setModel(tab.model);
  renderTabs();
  renderTree();
  updateStatus();
}

function guessLanguage(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  const map = { js:'javascript', ts:'typescript', py:'python', json:'json', md:'markdown', html:'html', css:'css', sh:'shell', yml:'yaml', yaml:'yaml', swift:'swift', m:'objective-c', h:'objective-c', c:'c', cpp:'cpp', rs:'rust', go:'go', rb:'ruby', java:'java', xml:'xml', toml:'toml', txt:'plaintext', log:'plaintext' };
  return map[ext] || 'plaintext';
}

function renderTabs() {
  const container = document.getElementById('editor-tabs');
  if (!openTabs.length) {
    container.innerHTML = '<div style="padding:0 14px;font-size:11px;color:var(--text-tertiary);-webkit-app-region:drag;flex:1;display:flex;align-items:center">Open a file from the sidebar</div>';
    return;
  }
  container.innerHTML = openTabs.map(t => {
    const name = t.path.split('/').pop();
    const modified = t.model.getValue() !== t.originalContent;
    const cls = t.path === activeTab ? 'editor-tab active' : 'editor-tab';
    return `<div class="${cls}${modified ? ' modified' : ''}" data-path="${esc(t.path)}"><span class="tab-name">${esc(name)}</span><span class="tab-close" data-close="${esc(t.path)}">✕</span></div>`;
  }).join('') + '<div style="flex:1;-webkit-app-region:drag"></div>';

  container.querySelectorAll('.editor-tab').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      activeTab = el.dataset.path;
      const tab = openTabs.find(t => t.path === activeTab);
      if (tab) monacoEditor.setModel(tab.model);
      renderTabs(); renderTree(); updateStatus();
    });
  });
  container.querySelectorAll('.tab-close').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(el.dataset.close);
    });
  });
}

function closeTab(path) {
  const idx = openTabs.findIndex(t => t.path === path);
  if (idx === -1) return;
  openTabs[idx].model.dispose();
  openTabs.splice(idx, 1);
  if (activeTab === path) {
    activeTab = openTabs.length ? openTabs[Math.min(idx, openTabs.length - 1)].path : null;
    if (activeTab) { const t = openTabs.find(t => t.path === activeTab); monacoEditor.setModel(t.model); }
    else { monacoEditor.setModel(null); }
  }
  renderTabs(); renderTree(); updateStatus();
}

function updateStatus() {
  const tab = openTabs.find(t => t.path === activeTab);
  document.getElementById('status-file').textContent = tab ? tab.path.split('/').pop() : 'No file';
  document.getElementById('status-lang').textContent = tab ? tab.model.getLanguageId() : 'Plain Text';
  if (monacoEditor && tab) {
    const pos = monacoEditor.getPosition();
    document.getElementById('status-pos').textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}` : '';
  }
}

// ── Save ──
async function saveFile() {
  const tab = openTabs.find(t => t.path === activeTab);
  if (!tab) return;
  const content = tab.model.getValue();
  // Write via exec (base64 to handle special chars)
  const b64 = btoa(unescape(encodeURIComponent(content)));
  const result = await remoteExec(`echo '${b64}' | base64 -d > "${tab.path}"`, 15000);
  if (!result.error && result.exitCode === 0) {
    tab.originalContent = content;
    renderTabs();
    const el = document.getElementById('status-file');
    el.textContent = tab.path.split('/').pop() + ' ✓';
    el.classList.add('status-saved');
    setTimeout(() => { el.classList.remove('status-saved'); updateStatus(); }, 1500);
  }
}

// ── Terminal ──
function initTerminal() {
  const container = document.getElementById('editor-xterm');
  termXterm = new Terminal({
    cursorBlink: true, fontSize: 12,
    fontFamily: '"Geist Mono", "SF Mono", Menlo, monospace',
    theme: { background: '#161618', foreground: '#ececf0', cursor: '#3b82f6', selectionBackground: 'rgba(59,130,246,0.2)' },
    allowProposedApi: true,
  });
  termFit = new FitAddon.FitAddon();
  termXterm.loadAddon(termFit);
  termXterm.open(container);
  termFit.fit();

  new ResizeObserver(() => { if (termFit && !termCollapsed) termFit.fit(); }).observe(container);

  termXterm.onData((data) => {
    if (termSessionId) {
      api.invoke('shell-input', { sessionId: termSessionId, data: btoa(unescape(encodeURIComponent(data))), device });
    }
  });

  // Connect shell
  termSessionId = crypto.randomUUID();
  api.invoke('shell-open', { device, sessionId: termSessionId, cols: termXterm.cols, rows: termXterm.rows });

  api.on('shell-data', (msg) => {
    if (msg.sessionId !== termSessionId) return;
    try { termXterm.write(decodeURIComponent(escape(atob(msg.data)))); }
    catch { termXterm.write(atob(msg.data)); }
  });

  api.on('shell-exit', (msg) => {
    if (msg.sessionId !== termSessionId) return;
    termXterm.writeln('\r\n\x1b[90mShell exited\x1b[0m');
    termSessionId = null;
  });

  document.getElementById('btn-toggle-term').addEventListener('click', () => {
    termCollapsed = !termCollapsed;
    document.getElementById('terminal-panel').classList.toggle('collapsed', termCollapsed);
    document.getElementById('btn-toggle-term').textContent = termCollapsed ? '▲' : '▼';
    if (!termCollapsed) setTimeout(() => termFit.fit(), 100);
    monacoEditor.layout();
  });
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Init ──
require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
require(['vs/editor/editor.main'], function () {
  monaco.editor.defineTheme('remoteclaw', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#161618',
      'editor.foreground': '#ececf0',
      'editorLineNumber.foreground': '#56565a',
      'editorLineNumber.activeForeground': '#8e8e93',
      'editor.selectionBackground': 'rgba(59,130,246,0.2)',
      'editor.lineHighlightBackground': '#1e1e21',
      'editorCursor.foreground': '#3b82f6',
      'editorWidget.background': '#1e1e21',
      'editorWidget.border': 'rgba(255,255,255,0.1)',
      'input.background': '#252528',
      'input.border': 'rgba(255,255,255,0.1)',
      'list.activeSelectionBackground': 'rgba(59,130,246,0.12)',
      'sideBar.background': '#1e1e21',
    },
  });

  monacoEditor = monaco.editor.create(document.getElementById('editor-container'), {
    theme: 'remoteclaw',
    fontFamily: '"Geist Mono", "SF Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    padding: { top: 8 },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    bracketPairColorization: { enabled: true },
    automaticLayout: true,
  });

  // Cmd+S to save
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile);

  // Track cursor position
  monacoEditor.onDidChangeCursorPosition(() => updateStatus());
  monacoEditor.onDidChangeModelContent(() => renderTabs());

  // Init terminal
  initTerminal();

  // Load initial directory
  loadDir(initDir);

  // Open initial file if specified
  if (initFile) setTimeout(() => openFile(initFile), 500);

  // Sidebar buttons
  document.getElementById('btn-refresh').addEventListener('click', () => loadDir(currentDir));
  document.getElementById('btn-up').addEventListener('click', () => loadDir(currentDir.replace(/\/[^/]+\/?$/, '') || '/'));

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'w') { e.preventDefault(); if (activeTab) closeTab(activeTab); }
    if ((e.metaKey || e.ctrlKey) && e.key === '`') { e.preventDefault(); termCollapsed = !termCollapsed; document.getElementById('terminal-panel').classList.toggle('collapsed', termCollapsed); document.getElementById('btn-toggle-term').textContent = termCollapsed ? '▲' : '▼'; if (!termCollapsed) setTimeout(() => termFit.fit(), 100); monacoEditor.layout(); }
  });
});
