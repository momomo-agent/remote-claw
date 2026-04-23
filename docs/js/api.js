import { state } from './state.js'

const electronAPI = window.electronAPI

let _httpBase = null
let _token = null

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
  try {
    const res = await fetch(`${_httpBase}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${_token}`, 'Content-Type': 'application/json', ...opts.headers },
    })
    return await res.json()
  } catch { return opts.fallback ?? [] }
}

export async function refreshData() {
  await ensureConfig()
  const cfg = await electronAPI.getConfig()
  state.connected = cfg.connected
  state.configRaw = cfg.raw || null
  const [devices, history] = await Promise.all([
    apiFetch('/devices'),
    apiFetch('/history?limit=50'),
  ])
  state.devices = Array.isArray(devices) ? devices : []
  state.history = Array.isArray(history) ? history : []
  if (state.devices.length && !state.selectedDevice) state.selectedDevice = state.devices[0].id
}

export function resetConfig() {
  _httpBase = null
  _token = null
}

// Re-export electronAPI for direct IPC calls
export const api = electronAPI
