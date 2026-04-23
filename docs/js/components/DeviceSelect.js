import { defineComponent, h } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
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

      if (props.detached) {
        return h('select', {
          class: 'device-select',
          style: 'margin-left:72px',
          onChange,
        }, options)
      }

      return h('select', {
        class: 'device-select device-title',
        onChange,
      }, options)
    }
  },
})
