import { createApp, defineComponent, h, onMounted, onUnmounted, watch } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state, ALL_APPS, isDetached, detachedTab, savePinnedTabs } from './state.js'
import { api, refreshData, ensureConfig } from './api.js'
import { useContextMenu } from './composables/useContextMenu.js'
import TabBar from './components/TabBar.js'
import DeviceSelect from './components/DeviceSelect.js'
import ContextMenu from './components/ContextMenu.js'
import ShellApp, { getShellInstance } from './apps/ShellApp.js'
import { getFilesInstance } from './apps/FilesApp.js'
import FilesApp from './apps/FilesApp.js'
import TerminalApp from './apps/TerminalApp.js'
import AppsGrid from './apps/AppsGrid.js'
import DevicesApp from './apps/DevicesApp.js'
import HistoryApp from './apps/HistoryApp.js'
import SettingsApp from './apps/SettingsApp.js'
import NetworkApp from './apps/NetworkApp.js'
import ClawApp from './apps/ClawApp.js'

const App = defineComponent({
  name: 'App',
  setup() {
    const ctxMenu = useContextMenu()
    let refreshInterval = null

    function handleAppLaunch(appId) {
      const app = ALL_APPS.find(a => a.id === appId)
      if (!app) return
      if (app.needsDevice && !state.selectedDevice) return

      // Special handlers
      if (appId === 'vscode') {
        api.invoke('open-code-server', { device: state.selectedDevice })
        return
      }
      if (appId === 'browser') {
        const port = prompt('Enter port number:', '3000')
        if (port) api.invoke('open-browser', { device: state.selectedDevice, port: parseInt(port), path: '/' })
        return
      }
      if (appId === 'screen') {
        api.invoke('notify', { title: 'Screen', body: 'Screen sharing coming soon' })
        return
      }

      // Everything else opens in a new window
      api.invoke('open-tab-window', {
        tab: appId, device: state.selectedDevice,
        title: `RemoteClaw — ${app.label}`,
      })
    }

    function handleTabSelect({ id, detachOnly }) {
      if (detachOnly) {
        handleAppLaunch(id)
        return
      }
      state.currentApp = id
      if (id === 'files') {
        const files = getFilesInstance()
        if (!files.entries.value.length && !files.loading.value) files.loadFiles(files.path.value)
      }
    }

    function handleDeviceChange(deviceId) {
      const shell = getShellInstance()
      if (deviceId !== state.selectedDevice && shell.sessionId.value) shell.closeSession()
      state.selectedDevice = deviceId
      const files = getFilesInstance()
      files.reset()
    }

    function handleContextMenu({ x, y, items }) {
      ctxMenu.show(x, y, items)
    }

    function onKeydown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (state.currentApp === 'shell') {
          getShellInstance().clearTerminal()
        }
      }
    }

    // IPC event handlers
    function onDaemonStatus(data) { state.connected = data.connected }
    async function onRefresh() { await refreshData() }
    function onPinnedChanged(data) { state.pinned = data.pinned }
    function onWindowMoved(data) {
      if (state.pinned || !data.trayBounds) return
      const wb = data.bounds, tb = data.trayBounds
      const dx = Math.abs(wb.x - (tb.x - wb.width / 2 + tb.width / 2))
      const dy = Math.abs(wb.y - (tb.y + tb.height))
      if (dx > 50 || dy > 50) api.invoke('set-pinned', { pinned: true })
    }
    function onShellData(msg) { getShellInstance().onShellData(msg) }
    function onShellExit(msg) { getShellInstance().onShellExit(msg) }

    onMounted(async () => {
      document.addEventListener('keydown', onKeydown)

      // Register IPC listeners
      api.onDaemonStatus(onDaemonStatus)
      api.onRefresh(onRefresh)
      api.onPinnedChanged(onPinnedChanged)
      api.on('window-moved', onWindowMoved)
      api.on('shell-data', onShellData)
      api.on('shell-exit', onShellExit)

      // Init
      const pinnedState = await api.getPinned()
      state.pinned = pinnedState?.pinned || false
      await refreshData()

      // Periodic refresh
      refreshInterval = setInterval(async () => {
        await refreshData()
      }, 5000)
    })

    onUnmounted(() => {
      document.removeEventListener('keydown', onKeydown)
      if (refreshInterval) clearInterval(refreshInterval)
    })

    function renderCurrentApp() {
      const appMap = {
        shell: ShellApp,
        files: FilesApp,
        terminal: TerminalApp,
        apps: AppsGrid,
        devices: DevicesApp,
        history: HistoryApp,
        settings: SettingsApp,
        network: NetworkApp,
        claw: ClawApp,
      }
      const Comp = appMap[state.currentApp] || ShellApp
      if (Comp === AppsGrid) {
        return h(Comp, { onLaunch: handleAppLaunch, onContextmenu: handleContextMenu })
      }
      return h(Comp)
    }
    // Render
    return () => {
      const content = renderCurrentApp()
      const ctxMenuNode = h(ContextMenu, {
        visible: ctxMenu.visible.value,
        x: ctxMenu.x.value,
        y: ctxMenu.y.value,
        items: ctxMenu.items.value,
        onClose: () => ctxMenu.hide(),
      })

      if (isDetached) {
        return h('div', { id: 'app' }, [
          h('div', { class: 'detached-titlebar' }, [
            h(DeviceSelect, { detached: true, onChange: handleDeviceChange }),
            h('span', { style: { flex: '1' } }),
          ]),
          h('div', { class: 'content', style: { height: 'calc(100vh - 40px)' } }, [content]),
          ctxMenuNode,
        ])
      }

      return h('div', { id: 'app' }, [
        // Titlebar
        h('div', { class: 'titlebar' }, [
          h('div', { class: 'titlebar-left' }, [
            h('div', {
              class: ['status-indicator', state.connected ? 'on' : 'off'],
              title: state.connected ? 'Connected' : 'Disconnected',
              onClick: () => api.toggleConnection(),
            }),
            h(DeviceSelect, { detached: false, onChange: handleDeviceChange }),
            h('div', {
              class: ['daemon-badge', state.daemonRunning ? 'running' : 'stopped'],
              title: state.daemonRunning ? 'Daemon running' : 'Daemon stopped',
            }, state.daemonRunning ? '● Daemon' : '○ Daemon'),
          ]),
          h('div', { class: 'titlebar-right' },
            state.pinned
              ? [h('button', { class: 'pin-close', title: 'Close', onClick: () => api.closeWindow() }, '\u2715')]
              : []
          ),
        ]),
        // Tab bar
        h(TabBar, {
          onSelect: handleTabSelect,
          onContextmenu: handleContextMenu,
        }),
        // Content
        h('div', { class: 'content' }, [content]),
        // Context menu
        ctxMenuNode,
      ])
    }
  },
})

createApp(App).mount('#app')
