import { reactive } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'

// Detect detached window mode from URL params
const urlParams = new URLSearchParams(window.location.search)
export const isDetached = urlParams.get('detached') === '1'
export const detachedTab = urlParams.get('tab')
export const detachedDevice = urlParams.get('device')

// App registry
export const ALL_APPS = [
  { id: 'shell',    label: 'Shell',    icon: '⌨',  canDetach: true,  needsDevice: true },
  { id: 'files',    label: 'Files',    icon: '📁', canDetach: true,  needsDevice: true },
  { id: 'vscode',   label: 'VS Code',  icon: '💻', canDetach: 'only', needsDevice: true },
  { id: 'browser',  label: 'Browser',  icon: '🌐', canDetach: 'only', needsDevice: true },
  { id: 'screen',   label: 'Screen',   icon: '🖥', canDetach: 'only', needsDevice: true },
  { id: 'network',  label: 'Network',  icon: '📡', canDetach: true,  needsDevice: true },
  { id: 'claw',     label: 'Claw',     icon: '🦞', canDetach: true,  needsDevice: true },
  { id: 'devices',  label: 'Devices',  icon: '📡', canDetach: false, needsDevice: false },
  { id: 'history',  label: 'History',  icon: '📋', canDetach: false, needsDevice: false },
  { id: 'apps',     label: 'Apps',     icon: '⊞',  canDetach: false, needsDevice: false },
  { id: 'settings', label: 'Settings', icon: '⚙',  canDetach: false, needsDevice: false },
]

const DEFAULT_PINNED = ['devices', 'shell', 'files', 'apps']

function loadPinned() {
  try { return JSON.parse(localStorage.getItem('rc-pinned-tabs')) || DEFAULT_PINNED }
  catch { return DEFAULT_PINNED }
}

export const state = reactive({
  currentApp: detachedTab || 'devices',
  connected: false,
  serverUrl: '',
  devices: [],
  history: [],
  selectedDevice: detachedDevice || '',
  configRaw: null,
  pinned: false,
  pinnedTabs: loadPinned(),
  daemonRunning: false,
  daemonInstalled: false,
  updateAvailable: null, // { current, next, needsDmg }
  promptModal: null, // { title, placeholder, defaultValue, onSubmit }
})

export function savePinnedTabs() {
  localStorage.setItem('rc-pinned-tabs', JSON.stringify(state.pinnedTabs))
}

// Utility functions
export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

export function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(1)} GB`
}

export function fileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase()
  const icons = { js: '📄', ts: '📄', py: '🐍', json: '📋', md: '📝', txt: '📝', sh: '⚙', yml: '⚙', yaml: '⚙', png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', mp4: '🎬', mov: '🎬', zip: '📦', gz: '📦', tar: '📦', pdf: '📕' }
  return icons[ext] || '📄'
}
