import { defineComponent, h, ref, onMounted } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state } from '../state.js'
import { apiFetch } from '../api.js'

async function execOnDevice(command, timeout = 10000) {
  if (!state.selectedDevice) return null
  const result = await apiFetch('/exec', {
    method: 'POST',
    body: JSON.stringify({ device: state.selectedDevice, command, oneshot: true, timeout }),
    fallback: { error: 'failed' },
  })
  if (result.error) return null
  return result.stdout?.trim() || ''
}

export default defineComponent({
  name: 'ClawApp',
  setup() {
    const loading = ref(false)
    const statusRaw = ref('')
    const gatewayRaw = ref('')
    const configJson = ref(null)
    const logs = ref('')
    const restarting = ref(false)

    async function refresh() {
      if (!state.selectedDevice) return
      loading.value = true

      const [s, g, c, l] = await Promise.all([
        execOnDevice('openclaw status 2>&1'),
        execOnDevice('openclaw gateway status 2>&1'),
        execOnDevice('cat ~/.openclaw/openclaw.json 2>/dev/null'),
        execOnDevice('openclaw gateway logs --tail 50 2>/dev/null || journalctl -u openclaw --no-pager -n 50 2>/dev/null || echo "No logs available"'),
      ])

      statusRaw.value = s || 'Unable to reach openclaw'
      gatewayRaw.value = g || 'Unknown'
      logs.value = l || ''

      if (c) {
        try {
          const parsed = JSON.parse(c)
          // Mask tokens
          if (parsed.providers) {
            for (const p of parsed.providers) {
              if (p.apiKey) p.apiKey = p.apiKey.slice(0, 8) + '***'
            }
          }
          if (parsed.token) parsed.token = parsed.token.slice(0, 8) + '***'
          configJson.value = parsed
        } catch { configJson.value = null }
      }

      loading.value = false
    }

    async function gatewayAction(action) {
      restarting.value = true
      await execOnDevice(`openclaw gateway ${action} 2>&1`, 15000)
      // Wait a moment for gateway to settle
      await new Promise(r => setTimeout(r, 2000))
      await refresh()
      restarting.value = false
    }

    onMounted(() => { refresh() })

    function parseStatus(raw) {
      if (!raw) return {}
      const info = {}
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*(.+?):\s+(.+)$/)
        if (m) info[m[1].trim().toLowerCase()] = m[2].trim()
      }
      return info
    }

    return () => {
      if (!state.selectedDevice) {
        return h('div', { class: 'empty' }, [
          h('div', { class: 'empty-icon' }, '🦞'),
          h('div', { class: 'empty-text' }, 'Select a device to monitor OpenClaw'),
        ])
      }

      if (loading.value && !statusRaw.value) {
        return h('div', { class: 'loading' }, 'Loading...')
      }

      const sections = []
      const info = parseStatus(statusRaw.value)
      const gwInfo = parseStatus(gatewayRaw.value)

      // Status card
      const isRunning = gatewayRaw.value.toLowerCase().includes('running') || gwInfo['status']?.toLowerCase().includes('running')
      sections.push(
        h('div', { class: 'section-label' }, 'Status'),
        h('div', { class: 'card' }, [
          h('div', { class: 'card-row', style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px' } }, [
            h('div', {
              style: {
                width: '8px', height: '8px', borderRadius: '50%',
                background: isRunning ? 'var(--green)' : 'var(--red)',
                boxShadow: isRunning ? '0 0 8px rgba(52,199,89,0.4)' : '0 0 8px rgba(255,59,48,0.4)',
              },
            }),
            h('div', { style: { flex: '1' } }, [
              h('div', { style: { fontWeight: '600', fontSize: '13px' } }, isRunning ? 'Running' : 'Stopped'),
              h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' } },
                [info['version'], info['model'], info['uptime']].filter(Boolean).join(' · ') || statusRaw.value.split('\n')[0]
              ),
            ]),
          ]),
          // Show parsed status lines
          ...Object.entries(info).slice(0, 8).map(([k, v]) =>
            h('div', { class: 'card-row', style: { display: 'flex', justifyContent: 'space-between', padding: '8px 14px', fontSize: '12px' } }, [
              h('span', { style: { color: 'var(--text-secondary)', textTransform: 'capitalize' } }, k),
              h('span', { style: { fontFamily: 'var(--mono)', fontSize: '11px' } }, v),
            ])
          ),
        ])
      )

      // Gateway controls
      sections.push(
        h('div', { class: 'section-label' }, 'Gateway'),
        h('div', { class: 'card', style: { padding: '12px 14px' } }, [
          h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px', fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap' } },
            gatewayRaw.value || 'No info'
          ),
          h('div', { style: { display: 'flex', gap: '8px' } }, [
            h('button', {
              class: 'files-btn',
              style: { flex: '1', textAlign: 'center', padding: '7px' },
              onClick: () => gatewayAction('restart'),
              disabled: restarting.value,
            }, restarting.value ? 'Restarting...' : 'Restart'),
            h('button', {
              class: 'files-btn',
              style: { flex: '1', textAlign: 'center', padding: '7px' },
              onClick: () => gatewayAction(isRunning ? 'stop' : 'start'),
              disabled: restarting.value,
            }, isRunning ? 'Stop' : 'Start'),
          ]),
        ])
      )

      // Config
      if (configJson.value) {
        sections.push(
          h('div', { class: 'section-label' }, 'Config'),
          h('div', { class: 'card', style: { padding: '12px 14px' } },
            h('pre', {
              style: {
                fontSize: '11px', fontFamily: 'var(--mono)', color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '0', maxHeight: '200px', overflow: 'auto',
              },
            }, JSON.stringify(configJson.value, null, 2))
          )
        )
      }

      // Logs
      if (logs.value) {
        sections.push(
          h('div', { class: 'section-label' }, 'Logs'),
          h('div', { class: 'card', style: { padding: '12px 14px' } },
            h('pre', {
              style: {
                fontSize: '10px', fontFamily: 'var(--mono)', color: 'var(--text-tertiary)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '0', maxHeight: '300px', overflow: 'auto',
              },
            }, logs.value)
          )
        )
      }

      // Refresh
      sections.push(
        h('div', { style: { padding: '8px 12px' } },
          h('button', {
            class: 'files-btn',
            style: { width: '100%', textAlign: 'center', padding: '8px' },
            onClick: refresh,
          }, loading.value ? 'Refreshing...' : 'Refresh')
        )
      )

      return h('div', { style: { padding: '4px 0' } }, sections)
    }
  },
})
