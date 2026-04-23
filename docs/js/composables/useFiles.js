import { ref } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'
import { state, fileIcon } from '../state.js'
import { apiFetch, api } from '../api.js'

export function useFiles() {
  const path = ref('~')
  const entries = ref([])
  const loading = ref(false)
  const error = ref(null)

  function parseLsLine(line) {
    const m = line.match(/^([dlcbsp-])([rwxsStT-]{9})[+@.]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/)
    if (!m) return null
    const isDir = m[1] === 'd'
    const isSymlink = m[1] === 'l'
    let name = m[5]
    if (isSymlink && name.includes(' -> ')) name = name.split(' -> ')[0]
    return { name, isDir, isSymlink, isFile: m[1] === '-', size: parseInt(m[3]), mtime: m[4] }
  }

  async function loadFiles(dirPath) {
    if (!state.selectedDevice) return
    loading.value = true
    error.value = null

    try {
      let resolvedPath = dirPath
      if (dirPath === '~' || dirPath.startsWith('~/')) {
        const result = await apiFetch('/exec', {
          method: 'POST',
          body: JSON.stringify({ device: state.selectedDevice, command: 'echo $HOME', oneshot: true, timeout: 5000 }),
          fallback: { error: 'failed' },
        })
        const home = result.stdout?.trim()
        if (home) {
          resolvedPath = dirPath === '~' ? home : home + dirPath.slice(1)
        } else {
          // Fallback: try common home directories
          const fallbackResult = await apiFetch('/exec', {
            method: 'POST',
            body: JSON.stringify({ device: state.selectedDevice, command: 'ls /Users 2>/dev/null && echo USERS || (ls /home 2>/dev/null && echo HOME)', oneshot: true, timeout: 5000 }),
            fallback: { error: 'failed' },
          })
          const out = fallbackResult.stdout?.trim() || ''
          if (out.includes('USERS')) resolvedPath = '/Users'
          else if (out.includes('HOME')) resolvedPath = '/home'
          else resolvedPath = '/'
        }
      }

      const result = await apiFetch('/exec', {
        method: 'POST',
        body: JSON.stringify({
          device: state.selectedDevice,
          command: `ls -la "${resolvedPath}" 2>&1 | head -100`,
          oneshot: true, timeout: 10000,
        }),
        fallback: { error: 'failed' },
      })

      if (result.error) {
        error.value = result.error
      } else if (result.exitCode !== 0) {
        error.value = result.stderr || result.stdout || 'Failed to list directory'
      } else {
        const lines = (result.stdout || '').split('\n').filter(l => l.trim() && !l.startsWith('total'))
        entries.value = lines.map(parseLsLine).filter(Boolean)
          .filter(f => f.name !== '.' && f.name !== '..')
          .sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        path.value = resolvedPath
      }
    } catch (e) {
      error.value = e.message
    }

    loading.value = false
  }

  function goUp() {
    const parent = path.value.replace(/\/[^/]+\/?$/, '') || '/'
    loadFiles(parent)
  }

  function navigateTo(name) {
    const newPath = path.value === '/' ? '/' + name : path.value + '/' + name
    loadFiles(newPath)
  }

  function reset() {
    entries.value = []
    path.value = '~'
    error.value = null
  }

  return { path, entries, loading, error, loadFiles, goUp, navigateTo, reset }
}
