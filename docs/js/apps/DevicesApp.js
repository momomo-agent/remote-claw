import { defineComponent, h, ref, onMounted, onUnmounted } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'
import { state, formatDuration } from '../state.js'
import { api } from '../api.js'

export default defineComponent({
  name: 'DevicesApp',
  setup() {
    const proxies = ref([])
    let timer = null

    async function refresh() {
      try {
        const list = await api.invoke('proxy-list')
        proxies.value = Array.isArray(list) ? list : []
      } catch {}
    }

    function onChanged(list) {
      proxies.value = Array.isArray(list) ? list : []
    }

    onMounted(() => {
      refresh()
      api.on('proxies-changed', onChanged)
      // Lightweight polling so "Age" stays fresh; event updates drive state.
      timer = setInterval(refresh, 5000)
    })
    onUnmounted(() => {
      api.off('proxies-changed', onChanged)
      if (timer) clearInterval(timer)
    })

    function formatAge(ms) {
      const s = Math.floor(ms / 1000)
      return formatDuration(s)
    }

    function kindIcon(kind) {
      if (kind?.includes('vscode')) return '\ud83d\udcbb'
      if (kind?.includes('browser')) return '\ud83c\udf10'
      return '\ud83d\udd0c'
    }

    function renderDevices() {
      if (!state.devices.length) {
        return h('div', { class: 'empty' }, [
          h('div', { class: 'empty-icon' }, '\ud83d\udce1'),
          h('div', { class: 'empty-text' }, 'No devices online'),
          h('div', { class: 'empty-hint' }, 'Make sure the daemon is running on your remote machine'),
        ])
      }
      return h('div', { class: 'card' },
        state.devices.map(d =>
          h('div', {
            class: 'card-row device-row',
            onClick: () => {
              state.selectedDevice = d.id
              state.currentApp = 'shell'
            },
          }, [
            h('div', { class: 'device-icon' },
              (d.name?.includes('Mac') || d.name?.includes('mac')) ? '\ud83d\udcbb' : '\ud83d\udda5'
            ),
            h('div', { class: 'device-info' }, [
              h('div', { class: 'device-name' }, d.name),
              h('div', { class: 'device-detail' }, (d.capabilities || []).join(' \u00b7 ') || 'Ready'),
            ]),
            h('div', { class: 'device-status' }, [
              h('div', { class: 'device-online' }, 'Online'),
              h('div', { class: 'device-uptime' }, formatDuration(d.connectedFor || 0)),
            ]),
          ])
        )
      )
    }

    function renderProxies() {
      if (!proxies.value.length) return null
      return h('div', { style: { marginTop: '16px' } }, [
        h('div', { class: 'section-label' }, 'Active Proxies'),
        h('div', { class: 'card' },
          proxies.value.map(p =>
            h('div', {
              key: p.key,
              class: 'card-row',
              style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', fontSize: '12px' },
            }, [
              h('div', {
                style: {
                  width: '8px', height: '8px', borderRadius: '50%', flexShrink: '0',
                  background: p.connected ? 'var(--green)' : (p.everConnected ? 'var(--orange, #ff9500)' : 'var(--text-secondary)'),
                  boxShadow: p.connected ? '0 0 8px rgba(52,199,89,0.4)' : 'none',
                },
                title: p.connected ? 'Connected' : (p.everConnected ? 'Reconnecting' : 'Connecting'),
              }),
              h('div', { style: { fontSize: '14px' } }, kindIcon(p.kind)),
              h('div', { style: { flex: '1', minWidth: '0' } }, [
                h('div', { style: { fontWeight: '500' } },
                  `${p.device || 'local'} :${p.remotePort}`
                ),
                h('div', {
                  style: {
                    fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--mono)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  },
                }, `127.0.0.1:${p.localPort} \u00b7 ${p.kind} \u00b7 ${formatAge(p.age)}`),
              ]),
              h('button', {
                class: 'files-btn',
                style: { padding: '4px 10px', fontSize: '11px' },
                onClick: async (e) => {
                  e.stopPropagation()
                  await api.invoke('proxy-close', { key: p.key })
                  refresh()
                },
                title: 'Stop this proxy',
              }, 'Stop'),
            ])
          )
        ),
      ])
    }

    return () => h('div', { style: { display: 'flex', flexDirection: 'column' } }, [
      renderDevices(),
      renderProxies(),
    ])
  },
})
