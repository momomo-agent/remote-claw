import { defineComponent, h, ref } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state } from '../state.js'
import { api, refreshData } from '../api.js'

export default defineComponent({
  name: 'SettingsApp',
  setup() {
    const server = ref(state.configRaw?.server || '')
    const token = ref(state.configRaw?.token || '')
    const deviceName = ref(state.configRaw?.deviceName || '')
    const saved = ref(false)

    async function save() {
      const cfg = {
        server: server.value.trim() || 'wss://remote.momomo.dev',
        token: token.value.trim(),
      }
      const dn = deviceName.value.trim()
      if (dn) cfg.deviceName = dn
      await api.saveConfig(cfg)
      saved.value = true
      setTimeout(() => { saved.value = false }, 2000)
      await refreshData()
    }

    return () => h('div', { class: 'settings' }, [
      h('div', { class: 'settings-section' }, [
        h('div', { class: 'settings-label' }, 'Server'),
        h('input', {
          class: 'settings-input',
          value: server.value,
          placeholder: 'wss://remote.momomo.dev',
          onInput: (e) => { server.value = e.target.value },
        }),
        h('div', { class: 'settings-label' }, 'Token'),
        h('input', {
          class: 'settings-input',
          type: 'password',
          value: token.value,
          placeholder: 'rclaw-...',
          onInput: (e) => { token.value = e.target.value },
        }),
        h('div', { class: 'settings-label' }, 'Device Name'),
        h('input', {
          class: 'settings-input',
          value: deviceName.value,
          placeholder: 'Auto-detected',
          onInput: (e) => { deviceName.value = e.target.value },
        }),
        h('div', { class: 'settings-note' }, 'Leave empty for auto-detection'),
      ]),
      h('button', { class: 'settings-save', onClick: save }, 'Save & Reconnect'),
      h('div', {
        class: 'settings-saved',
        style: { display: saved.value ? 'block' : 'none' },
      }, 'Saved!'),
    ])
  },
})
