// RemoteClaw Preview — Markdown viewer with sidebar navigation
const api = window.electronAPI;
const params = new URLSearchParams(window.location.search);
const device = params.get('device') || '';
const filePath = params.get('file') || '';
const dirPath = filePath ? filePath.replace(/\/[^/]+$/, '') : '';

let currentFile = filePath;
let entries = [];

async function init() {
  if (!device || !filePath) {
    document.getElementById('preview').innerHTML = '<div class="loading">No file specified</div>';
    return;
  }
  document.getElementById('sidebar-path').textContent = dirPath;
  await Promise.all([loadSidebar(), loadFile(filePath)]);
}

async function remoteExec(command) {
  const cfg = await api.getConfig();
  const httpBase = cfg.httpBase;
  const token = cfg.raw?.token;
  try {
    const res = await fetch(`${httpBase}/exec`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  renderSidebar();
}

function parseLsLine(line) {
  const m = line.match(/^([dlcbsp-])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/);
  if (!m) return null;
  let name = m[5];
  const isSymlink = m[1] === 'l';
  if (isSymlink && name.includes(' -> ')) name = name.split(' -> ')[0];
  return { name, isDir: m[1] === 'd', isSymlink, size: parseInt(m[3]) };
}

function fileIcon(name, isDir) {
  if (isDir) return '📁';
  const ext = name.split('.').pop()?.toLowerCase();
  const icons = {
    md: '📝', txt: '📝', json: '📋', js: '📄', ts: '📄', py: '🐍',
    sh: '⚙', yml: '⚙', yaml: '⚙', png: '🖼', jpg: '🖼', jpeg: '🖼',
    gif: '🖼', svg: '🖼', pdf: '📕', zip: '📦', gz: '📦',
  };
  return icons[ext] || '📄';
}

function renderSidebar() {
  const tree = document.getElementById('sidebar-tree');
  // Up button
  const parentDir = dirPath.replace(/\/[^/]+\/?$/, '') || '/';
  let html = `<div class="tree-item dir" data-action="navigate-up" data-path="${esc(parentDir)}">
    <span class="tree-icon">↑</span><span class="tree-name">..</span>
  </div>`;

  html += entries.map(f => {
    const fullPath = dirPath + '/' + f.name;
    const isActive = fullPath === currentFile;
    const cls = isActive ? 'tree-item active' : f.isDir ? 'tree-item dir' : 'tree-item';
    return `<div class="${cls}" data-path="${esc(fullPath)}" data-isdir="${f.isDir}">
      <span class="tree-icon">${fileIcon(f.name, f.isDir)}</span>
      <span class="tree-name">${esc(f.name)}</span>
    </div>`;
  }).join('');

  tree.innerHTML = html;

  // Bind clicks
  tree.querySelectorAll('.tree-item').forEach(el => {
    el.addEventListener('click', () => {
      const path = el.dataset.path;
      if (el.dataset.action === 'navigate-up' || el.dataset.isdir === 'true') {
        // Navigate to directory — reload sidebar
        navigateDir(path);
      } else {
        // Load file
        loadFile(path);
      }
    });
  });
}

async function navigateDir(newDir) {
  const result = await remoteExec(`ls -la "${newDir}" 2>&1 | head -200`);
  if (result.error || result.exitCode !== 0) return;

  const lines = (result.stdout || '').split('\n').filter(l => l.trim() && !l.startsWith('total'));
  entries = lines.map(parseLsLine).filter(Boolean)
    .filter(f => f.name !== '.' && f.name !== '..')
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  // Update state
  Object.defineProperty(window, '_dirPath', { value: newDir, writable: true });
  document.getElementById('sidebar-path').textContent = newDir;
  document.getElementById('sidebar-header').textContent = newDir.split('/').pop() || 'Files';
  renderSidebar();
}

async function loadFile(path) {
  currentFile = path;
  const preview = document.getElementById('preview');
  preview.className = 'preview';
  preview.innerHTML = '<div class="loading">Loading...</div>';

  const ext = path.split('.').pop()?.toLowerCase();
  const result = await remoteExec(`cat "${path}" 2>&1 | head -2000`);

  if (result.error || result.exitCode !== 0) {
    preview.innerHTML = `<div class="loading">Error: ${esc(result.stderr || result.error || 'Failed to read file')}</div>`;
    return;
  }

  const content = result.stdout || '';

  if (ext === 'md' || ext === 'markdown') {
    preview.innerHTML = `<div class="markdown-body">${marked.parse(content)}</div>`;
  } else if (['json', 'js', 'ts', 'py', 'sh', 'yml', 'yaml', 'swift', 'm', 'h', 'c', 'cpp', 'css', 'html', 'xml', 'toml', 'ini', 'conf', 'txt', 'log'].includes(ext)) {
    preview.innerHTML = `<pre style="background:var(--bg-secondary);padding:16px;border-radius:8px;overflow:auto;font-family:'SF Mono',Menlo,monospace;font-size:12px;line-height:1.5;color:var(--text)">${esc(content)}</pre>`;
  } else {
    preview.innerHTML = `<pre style="padding:16px;font-family:'SF Mono',Menlo,monospace;font-size:12px;color:var(--text-secondary)">${esc(content)}</pre>`;
  }

  // Update sidebar active state
  document.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('active', el.dataset.path === path);
    if (el.dataset.path === path) el.classList.remove('dir');
  });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

init();
