import { defineComponent, h } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'
import { state } from '../state.js'

export default defineComponent({
  name: 'DeviceSelect',
  props: {
    detached: Boolean,
  },
  emits: ['change'],
  setup(props, { emit }) {
    function onChange(e) {
      emit('change', e.target.value)
    }

    return () => {
      const options = [
        h('option', { value: '' }, props.detached ? 'No device' : 'RemoteClaw'),
        ...state.devices.map(d =>
          h('option', {
            value: d.id,
            selected: d.id === state.selectedDevice,
          }, d.name)
        ),
      ]

      const select = h('select', {
        class: 'device-select device-title',
        onChange,
      }, options)

      const deviceOnline = state.selectedDevice && state.devices.some(d => d.id === state.selectedDevice)

      // Both tray and detached windows get the same layout: dot + name
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '10px', marginLeft: props.detached ? '72px' : '0' },
      }, [
        h('div', {
          class: ['status-indicator', deviceOnline ? 'on' : 'off'],
          title: deviceOnline ? 'Device online' : 'Device offline',
        }),
        select,
      ])
    }
  },
})
