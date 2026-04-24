import { defineComponent, h, ref, reactive, onMounted } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'
import { state, showToast } from '../state.js'
import { apiFetch, api } from '../api.js'

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
    const rawConfig = ref(null)       // full parsed config (tokens masked for display)
    const providers = ref([])          // [{name, baseUrl, api, models: [{id, name, reasoning, contextWindow}]}]
    const currentModel = ref('')       // active model from openclaw status
    const defaultModel = ref('')       // from config
    const logs = ref('')
    const restarting = ref(false)
    const activeTab = ref('status')    // status | models | config | logs
    const testingProvider = ref(null)
    const testResults = reactive({})   // {providerName: {model, latency, ok, error}}
    const editingDefault = ref(false)
    const newDefault = ref('')

    async function refresh() {
      if (!state.selectedDevice) return
      loading.value = true

      const [s, g, c, l] = await Promise.all([
        execOnDevice('openclaw status 2>&1'),
        execOnDevice('openclaw gateway status 2>&1'),
        execOnDevice('cat ~/.openclaw/openclaw.json 2>/dev/null'),
        execOnDevice('openclaw gateway logs --tail 50 2>/dev/null || journalctl -u openclaw --no-pager -n 50 2>/dev/null || echo "No logs available"'),
      ])

      const notInstalled = s?.includes('command not found') || s?.includes('not found')
      statusRaw.value = notInstalled ? 'OpenClaw not installed on this device' : (s || 'Unable to reach device')
      gatewayRaw.value = notInstalled ? '' : (g || 'Unknown')
      logs.value = l || ''

      // Parse status for current model
      const modelMatch = s?.match(/model[:\s]+(\S+)/i)
      if (modelMatch) currentModel.value = modelMatch[1]

      if (c) {
        try {
          const parsed = JSON.parse(c)

          // Extract providers
          const provs = []
          if (parsed.models?.providers) {
            for (const [name, p] of Object.entries(parsed.models.providers)) {
              provs.push({
                name,
                baseUrl: p.baseUrl || '',
                api: p.api || 'unknown',
                models: (p.models || []).map(m => ({
                  id: m.id,
                  name: m.name || m.id,
                  reasoning: m.reasoning || false,
                  contextWindow: m.contextWindow,
                  maxTokens: m.maxTokens,
                })),
              })
            }
          }
          providers.value = provs
          defaultModel.value = parsed.default_model || parsed.defaultModel || ''
          currentModel.value = defaultModel.value || ''

          // Mask tokens for display
          const display = JSON.parse(c)
          if (display.models?.providers) {
            for (const p of Object.values(display.models.providers)) {
              if (p.apiKey) p.apiKey = p.apiKey.slice(0, 8) + '***'
            }
          }
          if (display.token) display.token = display.token.slice(0, 8) + '***'
          rawConfig.value = display
        } catch { rawConfig.value = null }
      }

      loading.value = false
    }

    async function gatewayAction(action) {
      restarting.value = true
      const cmd = action === 'install'
        ? 'npm install -g openclaw 2>&1'
        : `openclaw gateway ${action} 2>&1`
      await execOnDevice(cmd, action === 'install' ? 60000 : 15000)
      await new Promise(r => setTimeout(r, 2000))
      await refresh()
      restarting.value = false
    }

    async function testProvider(provName) {
      testingProvider.value = provName
      const start = Date.now()
      const result = await execOnDevice(
        `curl -s -o /dev/null -w '%{http_code}' --max-time 10 $(cat ~/.openclaw/openclaw.json | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); const p=c.models?.providers?.['${provName}']; console.log((p?.baseUrl||''))" 2>/dev/null)/v1/models 2>/dev/null`,
        12000
      )
      const latency = Date.now() - start
      testResults[provName] = {
        ok: result === '200' || result === '401' || result === '403',
        latency,
        status: result || 'timeout',
      }
      testingProvider.value = null
    }

    async function setDefaultModel(modelId) {
      // Use openclaw CLI or direct config edit
      const cmd = `cd ~ && node -e "
const fs=require('fs');
const p='$HOME/.openclaw/openclaw.json';
const c=JSON.parse(fs.readFileSync(p.replace('$HOME',require('os').homedir()),'utf8'));
c.default_model='${modelId}';
fs.writeFileSync(p.replace('$HOME',require('os').homedir()),JSON.stringify(c,null,2));
console.log('ok');
"`
      const result = await execOnDevice(cmd, 5000)
      if (result?.includes('ok')) {
        defaultModel.value = modelId
        editingDefault.value = false
      }
    }

    async function toggleProvider(provName, enable) {
      // Add/remove provider by renaming key with _ prefix (disabled convention)
      // For now, just show the info — full enable/disable needs more thought
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

    // ── Render helpers ──

    function renderTabs() {
      const tabs = [
        { id: 'status', label: 'Status' },
        { id: 'models', label: 'Models' },
        { id: 'config', label: 'Config' },
        { id: 'logs', label: 'Logs' },
      ]
      return h('div', { class: 'claw-tabs' }, tabs.map(t =>
        h('div', {
          class: ['claw-tab', { active: activeTab.value === t.id }],
          onClick: () => { activeTab.value = t.id },
        }, t.label)
      ))
    }

    function renderStatus() {
      const info = parseStatus(statusRaw.value)
      const gwInfo = parseStatus(gatewayRaw.value)
      const isRunning = gatewayRaw.value.toLowerCase().includes('running') || gwInfo['status']?.toLowerCase().includes('running')

      return h('div', {}, [
        // Status card
        h('div', { class: 'card' }, [
          h('div', { class: 'card-row', style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px' } }, [
            h('div', {
              style: {
                width: '8px', height: '8px', borderRadius: '50%', flexShrink: '0',
                background: isRunning ? 'var(--green)' : 'var(--red)',
                boxShadow: isRunning ? '0 0 8px rgba(52,199,89,0.4)' : '0 0 8px rgba(255,59,48,0.4)',
              },
            }),
            h('div', { style: { flex: '1' } }, [
              h('div', { style: { fontWeight: '600', fontSize: '13px' } }, isRunning ? 'Running' : 'Stopped'),
              h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' } },
                [info['version'], currentModel.value, info['uptime']].filter(Boolean).join(' · ') || statusRaw.value.split('\n')[0]
              ),
            ]),
          ]),
          ...Object.entries(info).slice(0, 10).map(([k, v]) =>
            h('div', { class: 'card-row', style: { display: 'flex', justifyContent: 'space-between', padding: '8px 14px', fontSize: '12px' } }, [
              h('span', { style: { color: 'var(--text-secondary)', textTransform: 'capitalize' } }, k),
              h('span', { style: { fontFamily: 'var(--mono)', fontSize: '11px', textAlign: 'right', maxWidth: '60%', wordBreak: 'break-all' } }, v),
            ])
          ),
        ]),

        // Gateway controls
        h('div', { class: 'section-label', style: { marginTop: '12px' } }, 'Gateway'),
        h('div', { class: 'card', style: { padding: '12px 14px' } }, [
          h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px', fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', maxHeight: '80px', overflow: 'auto' } },
            gatewayRaw.value || 'No info'
          ),
          h('div', { style: { display: 'flex', gap: '8px' } }, [
            h('button', {
              class: 'files-btn', style: { flex: '1', textAlign: 'center', padding: '7px' },
              onClick: () => gatewayAction('restart'),
              disabled: restarting.value,
            }, restarting.value ? 'Restarting...' : 'Restart'),
            h('button', {
              class: 'files-btn', style: { flex: '1', textAlign: 'center', padding: '7px' },
              onClick: () => gatewayAction(isRunning ? 'stop' : 'start'),
              disabled: restarting.value,
            }, isRunning ? 'Stop' : 'Start'),
            h('button', {
              class: 'files-btn', style: { flex: '1', textAlign: 'center', padding: '7px' },
              onClick: () => gatewayAction('install'),
              disabled: restarting.value,
            }, 'Install'),
          ]),
        ]),
      ])
    }

    function renderModels() {
      const allModels = []
      for (const prov of providers.value) {
        for (const m of prov.models) {
          allModels.push({ ...m, provider: prov.name })
        }
      }

      return h('div', {}, [
        // Current / Default model + Fallback order
        h('div', { class: 'card', style: { padding: '12px 14px', marginBottom: '8px' } }, [
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
            h('div', {}, [
              h('div', { style: { fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '4px' } }, 'Active Model'),
              h('div', { style: { fontSize: '13px', fontWeight: '600', fontFamily: 'var(--mono)' } }, currentModel.value || '—'),
            ]),
            h('button', {
              class: 'files-btn',
              style: { fontSize: '10px', padding: '4px 10px' },
              onClick: () => api.invoke('open-code-server', { device: state.selectedDevice, folder: '~/.openclaw' }),
            }, '✎ Edit Config'),
          ]),
          // Fallback order
          providers.value.length ? h('div', { style: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.06)' } }, [
            h('div', { style: { fontSize: '10px', color: 'var(--text-tertiary)', marginBottom: '4px' } }, 'Fallback Order'),
            h('div', { style: { fontSize: '11px', fontFamily: 'var(--mono)', color: 'var(--text-secondary)' } },
              providers.value.map(p => p.name).join(' → ')
            ),
          ]) : null,
        ]),

        // Providers
        h('div', { class: 'section-label' }, `Providers (${providers.value.length})`),
        ...providers.value.map(prov => {
          const tr = testResults[prov.name]
          const isTesting = testingProvider.value === prov.name

          return h('div', { class: 'card', style: { marginBottom: '6px' } }, [
            // Provider header
            h('div', {
              class: 'card-row',
              style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', cursor: 'pointer' },
            }, [
              h('div', { style: { flex: '1' } }, [
                h('div', { style: { fontSize: '13px', fontWeight: '500' } }, prov.name),
                h('div', { style: { fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--mono)', marginTop: '2px' } },
                  prov.baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
                ),
              ]),
              h('span', { style: { fontSize: '10px', color: 'var(--text-tertiary)', padding: '2px 6px', background: 'var(--bg-surface)', borderRadius: '4px' } }, prov.api),
              // Test button
              h('button', {
                class: 'files-btn',
                style: { fontSize: '10px', padding: '3px 8px' },
                onClick: (e) => { e.stopPropagation(); testProvider(prov.name) },
                disabled: isTesting,
              }, isTesting ? '...' : 'Test'),
              // Test result
              tr ? h('span', {
                style: {
                  fontSize: '10px', fontFamily: 'var(--mono)',
                  color: tr.ok ? 'var(--green)' : 'var(--red)',
                },
              }, tr.ok ? `${tr.latency}ms` : tr.status) : null,
            ]),

            // Models in this provider
            ...prov.models.map(m => {
              const isActive = currentModel.value && (
                currentModel.value === `${prov.name}/${m.id}` ||
                currentModel.value === m.id
              )
              return h('div', {
                class: 'card-row',
                style: {
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '7px 14px 7px 28px', fontSize: '12px',
                  background: isActive ? 'rgba(59,130,246,0.08)' : 'transparent',
                  cursor: 'pointer',
                },
                onClick: () => {
                  const fullId = `${prov.name}/${m.id}`
                  setDefaultModel(fullId)
                  showToast(`Default model set to ${fullId}`, 'success')
                },
                title: `Click to set as default\n${m.contextWindow ? 'Context: ' + (m.contextWindow / 1024) + 'K' : ''}${m.maxTokens ? ' · Max: ' + m.maxTokens : ''}`,
              }, [
                h('span', { style: { fontFamily: 'var(--mono)', flex: '1' } }, m.id),
                m.reasoning ? h('span', { style: { fontSize: '9px', color: 'var(--accent)', padding: '1px 5px', background: 'rgba(59,130,246,0.1)', borderRadius: '3px' } }, 'reasoning') : null,
                m.contextWindow ? h('span', { style: { fontSize: '10px', color: 'var(--text-tertiary)' } }, `${Math.round(m.contextWindow / 1024)}K`) : null,
                isActive ? h('span', { style: { color: 'var(--green)', fontSize: '11px' } }, '✓') : null,
              ])
            }),
          ])
        }),

        // All unique models summary
        h('div', { class: 'section-label', style: { marginTop: '12px' } }, 'All Models'),
        h('div', { class: 'card' },
          [...new Set(allModels.map(m => m.id))].sort().map(id => {
            const provs = allModels.filter(m => m.id === id).map(m => m.provider)
            return h('div', { class: 'card-row', style: { display: 'flex', justifyContent: 'space-between', padding: '6px 14px', fontSize: '12px' } }, [
              h('span', { style: { fontFamily: 'var(--mono)' } }, id),
              h('span', { style: { fontSize: '10px', color: 'var(--text-tertiary)' } }, provs.join(', ')),
            ])
          })
        ),
      ])
    }

    function renderConfig() {
      if (!rawConfig.value) return h('div', { class: 'empty' }, 'No config loaded')
      const configJson = JSON.stringify(rawConfig.value, null, 2)
      return h('div', {
        style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' },
      }, [
        h('div', {
          ref: (el) => {
            if (!el || el._monacoInit) return
            el._monacoInit = true
            // Load Monaco from CDN
            const script = document.createElement('script')
            script.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.min.js'
            script.onload = () => {
              window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } })
              window.require(['vs/editor/editor.main'], (monaco) => {
                monaco.editor.defineTheme('remoteclaw', {
                  base: 'vs-dark',
                  inherit: true,
                  rules: [],
                  colors: { 'editor.background': '#161618' },
                })
                const editor = monaco.editor.create(el, {
                  value: configJson,
                  language: 'json',
                  theme: 'remoteclaw',
                  readOnly: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  lineNumbers: 'off',
                  folding: true,
                  wordWrap: 'on',
                  automaticLayout: true,
                  padding: { top: 8, bottom: 8 },
                })
                el._editor = editor
              })
            }
            document.head.appendChild(script)
          },
          style: { flex: '1', minHeight: '300px', borderRadius: '6px', overflow: 'hidden' },
        }),
      ])
    }

    function renderLogs() {
      if (!logs.value) return h('div', { class: 'empty' }, 'No logs available')
      return h('div', { class: 'card', style: { padding: '12px 14px' } },
        h('pre', {
          style: {
            fontSize: '10px', fontFamily: 'var(--mono)', color: 'var(--text-tertiary)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '0', maxHeight: '500px', overflow: 'auto',
          },
        }, logs.value)
      )
    }

    // ── Main render ──

    return () => {
      if (!state.selectedDevice) {
        return h('div', { class: 'empty' }, [
          h('div', { class: 'empty-icon' }, '🦞'),
          h('div', { class: 'empty-text' }, 'Select a device to monitor OpenClaw'),
        ])
      }

      if (loading.value && !statusRaw.value) {
        return h('div', { class: 'empty' }, [
          h('div', { class: 'spinner' }),
          h('div', { class: 'empty-text' }, 'Loading OpenClaw status...'),
        ])
      }

      const tabContent = {
        status: renderStatus,
        models: renderModels,
        config: renderConfig,
        logs: renderLogs,
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, [
        renderTabs(),
        h('div', { style: { flex: '1', overflow: activeTab.value === 'config' ? 'hidden' : 'auto', padding: '4px 0', display: 'flex', flexDirection: 'column' } }, [
          (tabContent[activeTab.value] || renderStatus)(),
        ]),
        // Refresh bar
        h('div', { style: { padding: '6px 12px', borderTop: '1px solid var(--border)', flexShrink: '0' } },
          h('button', {
            class: 'files-btn',
            style: { width: '100%', textAlign: 'center', padding: '7px' },
            onClick: refresh,
          }, loading.value ? 'Refreshing...' : 'Refresh')
        ),
      ])
    }
  },
})
