import { createApp, defineComponent, h, onMounted, onUnmounted, watch } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'
import { state, ALL_APPS, isDetached, detachedTab, savePinnedTabs, showToast } from './state.js'
import { api, refreshData, ensureConfig } from './api.js'
import { useContextMenu } from './composables/useContextMenu.js'
import TabBar from './components/TabBar.js'
import DeviceSelect from './components/DeviceSelect.js'
import ContextMenu from './components/ContextMenu.js'
import ShellApp, { getShellInstance } from './apps/ShellApp.js'
import { getFilesInstance } from './apps/FilesApp.js'
import FilesApp from './apps/FilesApp.js'
import AppsGrid from './apps/AppsGrid.js'
import DevicesApp from './apps/DevicesApp.js'
import HistoryApp from './apps/HistoryApp.js'
import SettingsApp from './apps/SettingsApp.js'
import NetworkApp from './apps/NetworkApp.js'
import ClawApp from './apps/ClawApp.js'
import ScreenApp from './apps/ScreenApp.js'

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
        api.invoke('open-code-server', { device: state.selectedDevice, port: 8080 })
        return
      }
      if (appId === 'browser') {
        api.invoke('open-browser', { device: state.selectedDevice, url: 'https://www.google.com/' })
        return
      }
      // System Chrome via proxy tunnel. Fresh Chrome instance (separate profile
      // so --proxy-server actually takes).
      if (appId === 'chrome') {
        api.invoke('open-system-chrome', { device: state.selectedDevice, url: 'https://www.google.com/' })
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
    function onUpdateAvailable(data) { state.updateAvailable = data }

    onMounted(async () => {
      document.addEventListener('keydown', onKeydown)

      // Register IPC listeners
      api.onDaemonStatus(onDaemonStatus)
      api.onRefresh(onRefresh)
      api.onPinnedChanged(onPinnedChanged)
      api.on('window-moved', onWindowMoved)
      api.on('shell-data', onShellData)
      api.on('shell-exit', onShellExit)
      api.on('update-available', onUpdateAvailable)

      // Init
      const pinnedState = await api.getPinned()
      state.pinned = pinnedState?.pinned || false
      await refreshData()

      // First run: if token not configured, go to settings
      if (!state.configRaw?.token || state.configRaw.token === 'CHANGE_ME') {
        state.currentApp = 'settings'
      }

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
        apps: AppsGrid,
        devices: DevicesApp,
        history: HistoryApp,
        settings: SettingsApp,
        network: NetworkApp,
        claw: ClawApp,
        screen: ScreenApp,
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
            h(DeviceSelect, { detached: false, onChange: handleDeviceChange }),
            h('div', {
              class: ['daemon-badge', state.daemonRunning ? 'running' : 'stopped'],
              title: state.daemonRunning ? 'Daemon running (click to restart)' : state.daemonInstalled ? 'Daemon stopped (click to start)' : 'Daemon not installed (click to install)',
              onClick: async () => {
                await api.invoke('daemon-restart')
                setTimeout(async () => { await refreshData() }, 2000)
              },
            }, state.daemonRunning ? '● Daemon' : '○ Daemon'),
          ]),
          h('div', { class: 'titlebar-right' },
            state.pinned
              ? [h('button', { class: 'pin-close', title: 'Close', onClick: () => api.closeWindow() }, '\u2715')]
              : []
          ),
        ]),
        // Update banner
        state.updateAvailable ? h('div', {
          class: 'update-banner',
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '4px 12px', fontSize: '12px',
            background: state.updateAvailable.needsDmg ? '#7c2d12' : '#1e3a5f',
            color: '#e2e8f0', borderBottom: '1px solid rgba(255,255,255,0.06)',
          },
        }, [
          h('span', {}, state.updateAvailable.needsDmg
            ? `v${state.updateAvailable.next} requires new DMG`
            : `v${state.updateAvailable.next} available`),
          h('button', {
            style: {
              background: 'rgba(255,255,255,0.15)', border: 'none', color: '#e2e8f0',
              padding: '2px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px',
            },
            onClick: () => {
              if (state.updateAvailable.needsDmg) {
                api.invoke('open-external', { url: 'https://github.com/momomo-agent/remote-claw/releases/latest' })
              } else {
                api.invoke('relaunch')
              }
            },
          }, state.updateAvailable.needsDmg ? 'Download' : 'Restart'),
        ]) : null,
        // Tab bar
        h(TabBar, {
          onSelect: handleTabSelect,
          onContextmenu: handleContextMenu,
        }),
        // Content
        h('div', { class: 'content' }, [content]),
        // Context menu
        ctxMenuNode,
        // Prompt modal
        state.promptModal ? h('div', {
          style: {
            position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '9999',
          },
          onClick: (e) => { if (e.target === e.currentTarget) { state.promptModal = null } },
        }, [
          h('div', {
            style: {
              background: '#1e1e20', borderRadius: '8px', padding: '16px',
              width: '280px', border: '1px solid rgba(255,255,255,0.1)',
            },
          }, [
            h('div', { style: { fontSize: '13px', color: '#e2e8f0', marginBottom: '10px' } }, state.promptModal.title),
            h('input', {
              type: 'text',
              value: state.promptModal.defaultValue || '',
              placeholder: state.promptModal.placeholder || '',
              style: {
                width: '100%', padding: '6px 10px', fontSize: '13px', boxSizing: 'border-box',
                background: '#0a0a0b', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '4px',
                color: '#e2e8f0', outline: 'none',
              },
              onVnodeMounted: (vnode) => { vnode.el.focus(); vnode.el.select() },
              onKeydown: (e) => {
                if (e.key === 'Enter') state.promptModal.onSubmit(e.target.value)
                if (e.key === 'Escape') { state.promptModal = null }
              },
            }),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end' } }, [
              h('button', {
                style: { padding: '4px 14px', fontSize: '12px', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '4px', color: '#a0a0a0', cursor: 'pointer' },
                onClick: () => { state.promptModal = null },
              }, 'Cancel'),
              h('button', {
                style: { padding: '4px 14px', fontSize: '12px', background: '#3b82f6', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer' },
                onClick: (e) => {
                  const input = e.target.closest('div').parentElement.querySelector('input')
                  state.promptModal.onSubmit(input.value)
                },
              }, 'Open'),
            ]),
          ]),
        ]) : null,
        // Toasts
        state.toasts.length ? h('div', { class: 'toast-container' },
          state.toasts.map(t =>
            h('div', { class: `toast toast-${t.type}`, key: t.id }, t.msg)
          )
        ) : null,
      ])
    }
  },
})

createApp(App).mount('#app')
