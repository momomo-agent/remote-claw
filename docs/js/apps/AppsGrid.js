import { defineComponent, h, ref } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state, ALL_APPS, savePinnedTabs } from '../state.js'
import { api } from '../api.js'
import AppCard from '../components/AppCard.js'

export default defineComponent({
  name: 'AppsGrid',
  components: { AppCard },
  emits: ['launch', 'contextmenu'],
  setup(props, { emit }) {
    const browserPort = ref('')
    const browserPath = ref('')

    function openBrowser(port, urlPath) {
      if (!state.selectedDevice || !port) return
      const path = urlPath || '/'
      api.invoke('open-browser', { device: state.selectedDevice, port: parseInt(port), path })
      // Save to recent
      let recent = JSON.parse(localStorage.getItem('rc-recent-ports') || '[]')
      recent = recent.filter(r => !(r.port === parseInt(port) && r.path === path))
      recent.unshift({ port: parseInt(port), path, label: `localhost:${port}${path}`, time: Date.now() })
      if (recent.length > 8) recent = recent.slice(0, 8)
      localStorage.setItem('rc-recent-ports', JSON.stringify(recent))
    }

    function onAppContext({ app, x, y }) {
      const isPinned = state.pinnedTabs.includes(app.id)
      const items = []
      if (isPinned) {
        items.push({
          label: 'Unpin from tab bar',
          action: () => {
            state.pinnedTabs = state.pinnedTabs.filter(t => t !== app.id)
            savePinnedTabs()
          },
        })
      } else {
        items.push({
          label: 'Pin to tab bar',
          action: () => {
            const idx = state.pinnedTabs.indexOf('settings')
            if (idx >= 0) state.pinnedTabs.splice(idx, 0, app.id)
            else state.pinnedTabs.push(app.id)
            savePinnedTabs()
          },
        })
      }
      if (app.canDetach === true) {
        items.push({
          label: 'Open in window',
          action: () => {
            api.invoke('open-tab-window', {
              tab: app.id, device: state.selectedDevice,
              title: `RemoteClaw \u2014 ${app.label}`,
            })
          },
        })
      }
      emit('contextmenu', { x, y, items })
    }

    return () => {
      const deviceApps = ALL_APPS.filter(a => a.needsDevice && a.id !== 'apps' && a.id !== 'settings')
      const systemApps = ALL_APPS.filter(a => !a.needsDevice && a.id !== 'apps' && a.id !== 'settings')
      const recentPorts = JSON.parse(localStorage.getItem('rc-recent-ports') || '[]')

      return h('div', null, [
        // Device apps
        h('div', { class: 'apps-grid-section' }, [
          h('div', { class: 'section-label' }, 'Device'),
          h('div', { class: 'apps-grid' },
            deviceApps.map(app =>
              h(AppCard, {
                app,
                key: app.id,
                onLaunch: (id) => emit('launch', id),
                onContext: onAppContext,
              })
            )
          ),
        ]),
        // System apps
        h('div', { class: 'apps-grid-section' }, [
          h('div', { class: 'section-label' }, 'System'),
          h('div', { class: 'apps-grid' },
            systemApps.map(app =>
              h(AppCard, {
                app,
                key: app.id,
                onLaunch: (id) => emit('launch', id),
                onContext: onAppContext,
              })
            )
          ),
        ]),
        // Open Port
        h('div', { class: 'section-label', style: { marginTop: '4px' } }, 'Open Port'),
        h('div', { class: 'card', style: { padding: '14px 16px' } },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
            h('input', {
              class: 'settings-input',
              type: 'number',
              placeholder: 'Port (e.g. 3000)',
              style: { flex: '1', margin: '0' },
              value: browserPort.value,
              onInput: (e) => { browserPort.value = e.target.value },
              onKeydown: (e) => {
                if (e.key === 'Enter' && browserPort.value) openBrowser(browserPort.value, browserPath.value || '/')
              },
            }),
            h('input', {
              class: 'settings-input',
              placeholder: 'Path (optional)',
              style: { flex: '1', margin: '0' },
              value: browserPath.value,
              onInput: (e) => { browserPath.value = e.target.value },
            }),
            h('button', {
              class: 'settings-save',
              style: { margin: '0', padding: '6px 16px', whiteSpace: 'nowrap' },
              onClick: () => { if (browserPort.value) openBrowser(browserPort.value, browserPath.value || '/') },
            }, 'Open'),
          ])
        ),
        // Recent ports
        ...(recentPorts.length ? [
          h('div', { class: 'section-label' }, 'Recent'),
          h('div', { class: 'card' },
            recentPorts.map(p =>
              h('div', {
                class: 'card-row device-row',
                onClick: () => openBrowser(p.port, p.path || '/'),
              }, [
                h('div', {
                  class: 'device-icon',
                  style: { fontSize: '14px', color: 'var(--text-secondary)' },
                }, String(p.port)),
                h('div', { class: 'device-info' }, [
                  h('div', { class: 'device-name' }, p.label || 'localhost:' + p.port),
                  h('div', { class: 'device-detail' }, p.path || '/'),
                ]),
                h('div', { style: { color: 'var(--text-tertiary)', fontSize: '18px' } }, '\u203a'),
              ])
            )
          ),
        ] : []),
      ])
    }
  },
})
