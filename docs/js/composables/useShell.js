import { ref, onUnmounted } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state } from '../state.js'
import { api } from '../api.js'

export function useShell() {
  const sessionId = ref(null)
  const status = ref('closed') // 'closed' | 'connecting' | 'open'

  let xterm = null
  let xtermFit = null
  let resizeObserver = null
  let connectTimeout = null

  function initTerminal(container) {
    if (!container) return
    if (xterm && status.value === 'open') {
      container.appendChild(xterm.element)
      xtermFit.fit()
      xterm.focus()
      return
    }
    if (xterm) { xterm.dispose(); xterm = null }
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null }

    xterm = new window.Terminal({
      cursorBlink: true, fontSize: 13,
      fontFamily: '"Geist Mono", "SF Mono", Menlo, Monaco, monospace',
      theme: {
        background: '#161618', foreground: '#ececf0', cursor: '#3b82f6',
        selectionBackground: 'rgba(59,130,246,0.2)', black: '#161618', brightBlack: '#56565a',
      },
      allowProposedApi: true,
      unicodeVersion: '11',
    })
    xtermFit = new window.FitAddon.FitAddon()
    xterm.loadAddon(xtermFit)
    // Enable proper CJK wide character support
    if (window.Unicode11Addon) {
      const unicode11 = new window.Unicode11Addon.Unicode11Addon()
      xterm.loadAddon(unicode11)
      xterm.unicode.activeVersion = '11'
    }
    xterm.open(container)
    xtermFit.fit()

    resizeObserver = new ResizeObserver(() => {
      if (xtermFit) {
        xtermFit.fit()
        if (sessionId.value && status.value === 'open') {
          api.invoke('shell-resize', {
            sessionId: sessionId.value, cols: xterm.cols, rows: xterm.rows,
            device: state.selectedDevice,
          })
        }
      }
    })
    resizeObserver.observe(container)

    xterm.onData((data) => {
      if (sessionId.value && status.value === 'open') {
        api.invoke('shell-input', {
          sessionId: sessionId.value,
          data: btoa(unescape(encodeURIComponent(data))),
          device: state.selectedDevice,
        })
      }
    })
    xterm.focus()
  }

  function openSession() {
    if (!state.selectedDevice || !xterm) return
    if (sessionId.value) api.invoke('shell-close', { sessionId: sessionId.value, device: state.selectedDevice })
    sessionId.value = crypto.randomUUID()
    status.value = 'connecting'
    xterm.clear()
    xterm.writeln('\x1b[90mConnecting to ' + state.selectedDevice + '...\x1b[0m')
    api.invoke('shell-open', {
      device: state.selectedDevice, sessionId: sessionId.value,
      cols: xterm.cols, rows: xterm.rows,
    })
    clearTimeout(connectTimeout)
    connectTimeout = setTimeout(() => {
      if (status.value === 'connecting') {
        status.value = 'closed'
        xterm.writeln('\x1b[31mConnection timed out.\x1b[0m')
      }
    }, 5000)
  }

  function closeSession() {
    if (sessionId.value) api.invoke('shell-close', { sessionId: sessionId.value, device: state.selectedDevice })
    sessionId.value = null
    status.value = 'closed'
    if (xterm) xterm.writeln('\r\n\x1b[90mDisconnected.\x1b[0m')
  }

  function onShellData(msg) {
    if (msg.sessionId !== sessionId.value) return
    if (status.value === 'connecting') {
      status.value = 'open'
      clearTimeout(connectTimeout)
    }
    if (xterm) {
      const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0))
      xterm.write(bytes)
    }
  }

  function onShellExit(msg) {
    if (msg.sessionId !== sessionId.value) return
    status.value = 'closed'
    sessionId.value = null
    if (xterm) xterm.writeln(`\r\n\x1b[90mShell exited (code ${msg.exitCode})\x1b[0m`)
  }

  function clearTerminal() {
    if (xterm) xterm.clear()
  }

  function dispose() {
    clearTimeout(connectTimeout)
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null }
    if (xterm) { xterm.dispose(); xterm = null; xtermFit = null }
  }

  function getXterm() { return xterm }

  return {
    sessionId, status,
    initTerminal, openSession, closeSession,
    onShellData, onShellExit, clearTerminal, dispose, getXterm,
  }
}
