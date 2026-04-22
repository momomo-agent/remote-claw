// RemoteClaw Preview — Markdown viewer with sidebar navigation
const api = window.electronAPI;
const params = new URLSearchParams(window.location.search);
const device = params.get('device') || '';
const filePath = params.get('file') || '';
let dirPath = filePath ? filePath.replace(/\/[^/]+$/, '') : '';

let currentFile = filePath;
let entries = [];

async function init() {
  if (!device || !filePath) {
    document.getElementById('preview').innerHTML = '<div class="loading">No file specified</div>';
    return;
  }
  document.getElementById('sidebar-path').textContent = dirPath;
  document.getElementById('sidebar-header').textContent = dirPath.split('/').pop() || 'Files';
  await Promise.all([loadSidebar(), loadFile(filePath)]);

  document.getElementById('btn-refresh').addEventListener('click', () => loadSidebar());
  document.getElementById('btn-up').addEventListener('click', () => {
    const parent = dirPath.replace(/\/[^/]+\/?$/, '') || '/';
    navigateDir(parent);
  });
}

async function remoteExec(command) {
  const cfg = await api.getConfig();
  try {
    const res = await fetch(`${cfg.httpBase}/exec`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.raw?.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device, command, oneshot: true, timeout: 10000 }),
    });
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

async function loadSidebar() {
  const result = await remoteExec(`ls -la "${dirPath}" 2>&1 | head -200`);
  if (result.error || result.exitCode !== 0) return;
  const lines = (result.stdout || '').split('\n').filter(l => l.trim() && !l.startsWith('total'));
  entries = lines.map(parseLsLine).filter(Boolean)
    .filter(f => f.name !== '.' && f.name !== '..')
    .sort((a, b) => { if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; return a.name.localeCompare(b.name); });
  renderSidebar();
}

function parseLsLine(line) {
  const m = line.match(/^([dlcbsp-])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/);
  if (!m) return null;
  let name = m[5];
  if (m[1] === 'l' && name.includes(' -> ')) name = name.split(' -> ')[0];
  return { name, isDir: m[1] === 'd', isSymlink: m[1] === 'l', size: parseInt(m[3]) };
}

function fileTypeLabel(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  const m = { js:'JS', ts:'TS', py:'PY', swift:'SW', json:'{}', md:'MD', sh:'$', yml:'YM', yaml:'YM', html:'<>', css:'#', c:'C', h:'H', m:'M', txt:'TX', log:'LG' };
  return m[ext] || '··';
}

function renderSidebar() {
  const tree = document.getElementById('sidebar-tree');
  const parentDir = dirPath.replace(/\/[^/]+\/?$/, '') || '/';

  let html = `<div class="tree-item dir" data-action="up" data-path="${esc(parentDir)}">
    <span class="tree-icon emoji">↑</span><span class="tree-name">..</span>
  </div>`;

  html += entries.map(f => {
    const fullPath = dirPath + '/' + f.name;
    const isActive = fullPath === currentFile;
    const cls = isActive ? 'tree-item active' : f.isDir ? 'tree-item dir' : 'tree-item';
    const icon = f.isDir
      ? '<span class="tree-icon emoji">📁</span>'
      : `<span class="tree-icon">${fileTypeLabel(f.name)}</span>`;
    return `<div class="${cls}" data-path="${esc(fullPath)}" data-isdir="${f.isDir}">${icon}<span class="tree-name">${esc(f.name)}</span></div>`;
  }).join('');

  tree.innerHTML = html;

  tree.querySelectorAll('.tree-item').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.action === 'up' || el.dataset.isdir === 'true') {
        navigateDir(el.dataset.path);
      } else {
        loadFile(el.dataset.path);
      }
    });
  });
}

async function navigateDir(newDir) {
  dirPath = newDir;
  document.getElementById('sidebar-path').textContent = newDir;
  document.getElementById('sidebar-header').textContent = newDir.split('/').pop() || '/';
  await loadSidebar();
}

async function loadFile(path) {
  currentFile = path;
  const preview = document.getElementById('preview');
  preview.className = 'preview';
  preview.innerHTML = '<div class="loading">Loading...</div>';

  const ext = path.split('.').pop()?.toLowerCase();
  const result = await remoteExec(`cat "${path}" 2>&1 | head -2000`);

  if (result.error || result.exitCode !== 0) {
    preview.innerHTML = `<div class="loading">${esc(result.stderr || result.error || 'Failed')}</div>`;
    return;
  }

  const content = result.stdout || '';

  if (ext === 'md' || ext === 'markdown') {
    preview.innerHTML = `<div class="markdown-body">${marked.parse(content)}</div>`;
  } else {
    preview.innerHTML = `<div class="code-preview">${esc(content)}</div>`;
  }

  // Update active state
  document.querySelectorAll('.tree-item').forEach(el => {
    const isActive = el.dataset.path === path;
    el.classList.toggle('active', isActive);
    if (isActive) el.classList.remove('dir');
  });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

init();
