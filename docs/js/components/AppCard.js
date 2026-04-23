import { defineComponent, h } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'
import { state } from '../state.js'

export default defineComponent({
  name: 'AppCard',
  props: {
    app: Object,
  },
  setup(props, { emit }) {
    const isPinned = () => state.pinnedTabs.includes(props.app.id)
    const disabled = () => props.app.needsDevice && !state.selectedDevice

    return () => h('div', {
      class: ['app-card', { disabled: disabled() }],
      onClick: () => emit('launch', props.app.id),
      onContextmenu: (e) => {
        e.preventDefault()
        emit('context', { app: props.app, x: e.clientX, y: e.clientY })
      },
    }, [
      h('div', { class: 'app-icon' }, props.app.icon),
      h('div', { class: 'app-label' }, props.app.label),
      isPinned() ? h('div', { class: 'app-pinned' }, '\u2022') : null,
    ])
  },
})
