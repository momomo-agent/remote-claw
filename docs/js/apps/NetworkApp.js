import { defineComponent, h, ref, onMounted } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'
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

let _clashConfig = null
async function getClashConfig() {
  if (_clashConfig) return _clashConfig
  const apiInfo = await execOnDevice(`defaults read com.west2online.ClashXPro apiPort 2>/dev/null && echo '---' && defaults read com.west2online.ClashXPro api-secret 2>/dev/null`, 5000)
  let port = 9090, secret = ''
  if (apiInfo) {
    const parts = apiInfo.split('---').map(s => s.trim())
    if (parts[0]) port = parseInt(parts[0]) || 9090
    if (parts[1]) secret = parts[1]
  }
  _clashConfig = { port, secret }
  return _clashConfig
}

async function clashGet(path) {
  const { port, secret } = await getClashConfig()
  const headers = secret ? `-H 'Authorization: Bearer ${secret}'` : ''
  const raw = await execOnDevice(`curl -s --noproxy '*' ${headers} http://127.0.0.1:${port}${path}`, 5000)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

async function clashPut(path, body) {
  const { port, secret } = await getClashConfig()
  const headers = secret ? `-H 'Authorization: Bearer ${secret}'` : ''
  const json = JSON.stringify(body).replace(/'/g, "'\\''")
  await execOnDevice(`curl -s --noproxy '*' -X PUT -H 'Content-Type: application/json' ${headers} -d '${json}' http://127.0.0.1:${port}${path}`, 5000)
}

export default defineComponent({
  name: 'NetworkApp',
  setup() {
    const publicIp = ref('')
    const localInfo = ref('')
    const pingResult = ref('')
    const loading = ref(false)
    const proxyGroups = ref([])
    const expandedGroup = ref(null)
    const testingGroup = ref(null)
    const traffic = ref(null)
    const connectivity = ref([])
    const clashAvailable = ref(false)

    async function refreshNetwork() {
      if (!state.selectedDevice) return
      loading.value = true

      const [ip, local, ping] = await Promise.all([
        execOnDevice('curl -s --max-time 5 ifconfig.me'),
        execOnDevice('networksetup -getinfo Wi-Fi 2>/dev/null || ip addr show 2>/dev/null | head -20'),
        execOnDevice('/sbin/ping -c 1 -W 2 8.8.8.8 2>&1 | tail -1'),
      ])
      publicIp.value = ip || 'N/A'
      localInfo.value = local || 'N/A'
      pingResult.value = ping || 'N/A'

      // Check Clash API
      const proxies = await clashGet('/proxies')
      if (proxies?.proxies) {
        clashAvailable.value = true
        const groups = []
        for (const [name, proxy] of Object.entries(proxies.proxies)) {
          if (proxy.type === 'Selector' || proxy.type === 'URLTest' || proxy.type === 'Fallback') {
            groups.push({
              name,
              type: proxy.type,
              now: proxy.now || '',
              all: (proxy.all || []).map(n => ({
                name: n,
                delay: proxies.proxies[n]?.history?.[0]?.delay || null,
              })),
            })
          }
        }
        proxyGroups.value = groups
      } else {
        clashAvailable.value = false
        proxyGroups.value = []
      }

      loading.value = false
    }

    async function testGroupLatency(groupName) {
      testingGroup.value = groupName
      await clashGet(`/group/${encodeURIComponent(groupName)}/delay?url=http://www.gstatic.com/generate_204&timeout=5000`)
      // Refresh to get updated delays
      const proxies = await clashGet('/proxies')
      if (proxies?.proxies) {
        const group = proxyGroups.value.find(g => g.name === groupName)
        if (group) {
          group.all = group.all.map(n => ({
            ...n,
            delay: proxies.proxies[n.name]?.history?.[0]?.delay || null,
          })).sort((a, b) => {
            if (!a.delay && !b.delay) return 0
            if (!a.delay) return 1
            if (!b.delay) return -1
            return a.delay - b.delay
          })
        }
      }
      testingGroup.value = null
    }

    async function switchNode(groupName, nodeName) {
      await clashPut(`/proxies/${encodeURIComponent(groupName)}`, { name: nodeName })
      const group = proxyGroups.value.find(g => g.name === groupName)
      if (group) group.now = nodeName
    }

    async function checkConnectivity() {
      const targets = ['google.com', 'github.com']
      connectivity.value = targets.map(t => ({ target: t, status: 'testing' }))
      for (let i = 0; i < targets.length; i++) {
        const result = await execOnDevice(`curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://${targets[i]}`, 8000)
        connectivity.value[i].status = result === '200' || result === '301' || result === '302' ? 'ok' : 'fail'
      }
    }

    onMounted(() => { refreshNetwork(); checkConnectivity() })

    function delayBadge(delay) {
      if (!delay) return h('span', { class: 'net-latency net-latency-none' }, 'N/A')
      const cls = delay < 200 ? 'net-latency-good' : delay < 500 ? 'net-latency-mid' : 'net-latency-bad'
      return h('span', { class: `net-latency ${cls}` }, delay + 'ms')
    }

    return () => {
      if (!state.selectedDevice) {
        return h('div', { class: 'empty' }, [
          h('div', { class: 'empty-icon' }, '\ud83d\udce1'),
          h('div', { class: 'empty-text' }, 'Select a device for network diagnostics'),
        ])
      }

      if (loading.value && !publicIp.value) {
        return h('div', { class: 'empty' }, [
          h('div', { class: 'spinner' }),
          h('div', { class: 'empty-text' }, 'Scanning network...'),
        ])
      }

      const sections = []

      // Network Status
      sections.push(
        h('div', { class: 'section-label' }, 'Network Status'),
        h('div', { class: 'card' }, [
          h('div', { class: 'card-row net-stat-row' }, [
            h('div', { class: 'net-stat-label' }, 'Public IP'),
            h('div', { class: 'net-stat-value' }, publicIp.value),
          ]),
          h('div', { class: 'card-row net-stat-row' }, [
            h('div', { class: 'net-stat-label' }, 'Ping 8.8.8.8'),
            h('div', { class: 'net-stat-value' }, pingResult.value),
          ]),
          h('div', { class: 'card-row net-stat-row' }, [
            h('div', { class: 'net-stat-label' }, 'Local'),
            h('div', { class: 'net-stat-value', style: { fontSize: '10px', whiteSpace: 'pre-wrap' } },
              localInfo.value.split('\n').slice(0, 4).join('\n')
            ),
          ]),
        ])
      )

      // Connectivity
      sections.push(
        h('div', { class: 'section-label' }, 'Connectivity'),
        h('div', { class: 'card' },
          connectivity.value.map(c =>
            h('div', { class: 'card-row net-stat-row' }, [
              h('div', { class: 'net-stat-label' }, c.target),
              h('div', { class: 'net-stat-value' },
                c.status === 'testing' ? '\u23f3'
                  : c.status === 'ok' ? h('span', { style: { color: 'var(--green)' } }, '\u2713 OK')
                  : h('span', { style: { color: 'var(--red)' } }, '\u2717 Fail')
              ),
            ])
          )
        )
      )

      // Proxy Groups (Clash)
      if (clashAvailable.value) {
        sections.push(h('div', { class: 'section-label' }, 'Proxy Groups'))
        proxyGroups.value.forEach(group => {
          const isExpanded = expandedGroup.value === group.name
          const isTesting = testingGroup.value === group.name
          sections.push(
            h('div', { class: 'card', style: { marginBottom: '8px' } }, [
              h('div', {
                class: 'card-row net-group-header',
                onClick: () => { expandedGroup.value = isExpanded ? null : group.name },
              }, [
                h('div', { style: { flex: '1' } }, [
                  h('div', { class: 'net-group-name' }, group.name),
                  h('div', { class: 'net-group-meta' }, `${group.type} \u00b7 ${group.now || 'none'}`),
                ]),
                h('button', {
                  class: 'files-btn',
                  style: { fontSize: '10px' },
                  onClick: (e) => { e.stopPropagation(); testGroupLatency(group.name) },
                  disabled: isTesting,
                }, isTesting ? 'Testing...' : 'Test All'),
                h('span', { style: { color: 'var(--text-tertiary)', marginLeft: '8px' } }, isExpanded ? '\u25b4' : '\u25be'),
              ]),
              ...(isExpanded ? group.all.map(node =>
                h('div', {
                  class: ['card-row', 'net-node', { 'net-node-active': node.name === group.now }],
                  onClick: () => switchNode(group.name, node.name),
                }, [
                  h('div', { style: { flex: '1', fontSize: '12px' } }, node.name),
                  delayBadge(node.delay),
                  node.name === group.now ? h('span', { style: { color: 'var(--green)', marginLeft: '6px', fontSize: '10px' } }, '\u2713') : null,
                ])
              ) : []),
            ])
          )
        })
      }

      // Refresh button
      sections.push(
        h('div', { style: { padding: '8px 12px' } },
          h('button', {
            class: 'files-btn',
            style: { width: '100%', textAlign: 'center', padding: '8px' },
            onClick: () => { refreshNetwork(); checkConnectivity() },
          }, loading.value ? 'Refreshing...' : 'Refresh')
        )
      )

      return h('div', { class: 'network-section' }, sections)
    }
  },
})
