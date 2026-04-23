import { defineComponent, h } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state, formatDuration } from '../state.js'

export default defineComponent({
  name: 'DevicesApp',
  setup() {
    return () => {
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
  },
})
