import { defineComponent, h, ref, computed, watch } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state } from '../state.js'
import { api, refreshData, resetConfig } from '../api.js'

export default defineComponent({
  name: 'SettingsApp',
  setup() {
    const server = ref(state.configRaw?.server || '')
    const token = ref(state.configRaw?.token || '')
    const deviceName = ref(state.configRaw?.deviceName || '')
    const saved = ref(false)
    const saving = ref(false)

    // Watch for config changes (e.g. after refreshData)
    watch(() => state.configRaw, (cfg) => {
      if (cfg) {
        if (!server.value) server.value = cfg.server || ''
        if (!token.value) token.value = cfg.token || ''
        if (!deviceName.value) deviceName.value = cfg.deviceName || ''
      }
    })

    const isFirstRun = computed(() => !token.value || token.value === 'CHANGE_ME')

    async function save() {
      saving.value = true
      const cfg = {
        server: server.value.trim() || 'wss://remote.momomo.dev',
        token: token.value.trim(),
      }
      const dn = deviceName.value.trim()
      if (dn) cfg.deviceName = dn
      await api.saveConfig(cfg)
      resetConfig()
      await refreshData()
      saving.value = false
      saved.value = true
      setTimeout(() => { saved.value = false }, 2000)
    }

    return () => {
      const children = []

      // Connection status banner
      if (isFirstRun.value) {
        children.push(h('div', { class: 'settings-banner setup' }, [
          h('div', { class: 'settings-banner-icon' }, '🔧'),
          h('div', null, [
            h('div', { class: 'settings-banner-title' }, 'Welcome to RemoteClaw'),
            h('div', { class: 'settings-banner-text' }, 'Enter your server URL and token to get started.'),
          ]),
        ]))
      } else if (!state.connected) {
        children.push(h('div', { class: 'settings-banner error' }, [
          h('div', { class: 'settings-banner-icon' }, '⚠'),
          h('div', null, [
            h('div', { class: 'settings-banner-title' }, 'Not Connected'),
            h('div', { class: 'settings-banner-text' }, 'Check your server URL and token.'),
          ]),
        ]))
      } else {
        children.push(h('div', { class: 'settings-banner ok' }, [
          h('div', { class: 'settings-banner-icon' }, '✓'),
          h('div', null, [
            h('div', { class: 'settings-banner-title' }, 'Connected'),
            h('div', { class: 'settings-banner-text' }, `${state.devices.length} device${state.devices.length !== 1 ? 's' : ''} online`),
          ]),
        ]))
      }

      // Form
      children.push(h('div', { class: 'settings-section' }, [
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
      ]))

      children.push(h('button', {
        class: 'settings-save',
        onClick: save,
        disabled: saving.value,
      }, saving.value ? 'Connecting...' : 'Save & Reconnect'))

      if (saved.value) {
        children.push(h('div', { class: 'settings-saved' }, state.connected ? '✓ Connected!' : 'Saved — reconnecting...'))
      }

      return h('div', { class: 'settings' }, children)
    }
  },
})
