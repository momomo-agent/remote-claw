import { state } from './state.js'

const electronAPI = window.electronAPI

let _httpBase = null
let _token = null

// Local history helpers
function loadLocalHistory() {
  try { return JSON.parse(localStorage.getItem('rc-history')) || [] }
  catch { return [] }
}

function saveLocalHistory() {
  const last50 = state.history.slice(0, 50)
  localStorage.setItem('rc-history', JSON.stringify(last50))
}

export function pushHistory(entry) {
  state.history.unshift(entry)
  if (state.history.length > 50) state.history.length = 50
  saveLocalHistory()
}

export function clearHistory() {
  state.history = []
  localStorage.removeItem('rc-history')
}

export async function ensureConfig() {
  if (!_httpBase) {
    const cfg = await electronAPI.getConfig()
    _httpBase = cfg.httpBase
    _token = cfg.raw?.token
    state.serverUrl = cfg.httpBase
    state.connected = cfg.connected
    state.configRaw = cfg.raw || null
  }
}

export async function apiFetch(path, opts = {}) {
  await ensureConfig()
  const start = Date.now()
  try {
    const res = await fetch(`${_httpBase}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${_token}`, 'Content-Type': 'application/json', ...opts.headers },
    })
    const data = await res.json()
    // Auto-record exec commands in history
    if (path === '/exec' && opts.body) {
      try {
        const body = JSON.parse(opts.body)
        if (body.command && body.oneshot) {
          pushHistory({
            command: body.command,
            device: body.device || state.selectedDevice,
            from: state.localDevice || 'local',
            status: data.exitCode === 0 ? 'done' : data.error ? 'error' : 'done',
            duration: Date.now() - start,
            createdAt: Date.now(),
          })
        }
      } catch {}
    }
    return data
  } catch { return opts.fallback ?? [] }
}

export async function refreshData() {
  await ensureConfig()
  const cfg = await electronAPI.getConfig()
  state.connected = cfg.connected
  state.configRaw = cfg.raw || null
  state.localDevice = cfg.localDevice || 'local'
  // Check daemon status
  try {
    const ds = await electronAPI.invoke('daemon-status')
    state.daemonRunning = ds?.running || false
    state.daemonInstalled = ds?.installed || false
  } catch { state.daemonRunning = false }
  // Use IPC instead of renderer fetch — renderer fetch hits Electron CSP/network issues
  const [devices, history] = await Promise.all([
    electronAPI.fetchDevices().catch(() => []),
    electronAPI.fetchHistory(50).catch(() => []),
  ])
  state.devices = Array.isArray(devices) ? devices.filter(d => !d.id?.startsWith('app-')) : []
  // Merge server history with local; prefer server if available
  const serverHistory = Array.isArray(history) ? history : []
  if (serverHistory.length) {
    state.history = serverHistory
    saveLocalHistory()
  } else if (!state.history.length) {
    state.history = loadLocalHistory()
  }
  if (state.devices.length && !state.selectedDevice) state.selectedDevice = state.devices[0].id
}

export function resetConfig() {
  _httpBase = null
  _token = null
}

// Re-export electronAPI for direct IPC calls
export const api = electronAPI
