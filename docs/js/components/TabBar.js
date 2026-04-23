import { defineComponent, h } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state, ALL_APPS, savePinnedTabs } from '../state.js'
import { api } from '../api.js'

export default defineComponent({
  name: 'TabBar',
  emits: ['select', 'contextmenu'],
  setup(props, { emit }) {
    function onTabClick(id) {
      const app = ALL_APPS.find(a => a.id === id)
      if (app?.canDetach === 'only') {
        emit('select', { id, detachOnly: true })
        return
      }
      emit('select', { id })
    }

    function onTabDblClick(id) {
      const app = ALL_APPS.find(a => a.id === id)
      if (app?.canDetach === true) {
        api.invoke('open-tab-window', {
          tab: id, device: state.selectedDevice,
          title: `RemoteClaw \u2014 ${app.label}`,
        })
      }
    }

    function onTabContext(e, id) {
      e.preventDefault()
      if (id === 'apps' || id === 'settings') return
      const app = ALL_APPS.find(a => a.id === id)
      const items = [
        {
          label: 'Unpin from tab bar',
          action: () => {
            state.pinnedTabs = state.pinnedTabs.filter(t => t !== id)
            savePinnedTabs()
            if (state.currentApp === id) state.currentApp = state.pinnedTabs[0] || 'apps'
          },
        },
      ]
      if (app?.canDetach) {
        items.push({
          label: 'Open in window',
          action: () => {
            api.invoke('open-tab-window', {
              tab: id, device: state.selectedDevice,
              title: `RemoteClaw \u2014 ${app.label}`,
            })
          },
        })
      }
      emit('contextmenu', { x: e.clientX, y: e.clientY, items })
    }

    return () => h('div', { class: 'tabbar' },
      state.pinnedTabs.map(id => {
        const app = ALL_APPS.find(a => a.id === id)
        if (!app) return null
        return h('div', {
          class: ['tabbar-item', { active: state.currentApp === id }],
          onClick: () => onTabClick(id),
          onDblclick: () => onTabDblClick(id),
          onContextmenu: (e) => onTabContext(e, id),
        }, app.label)
      })
    )
  },
})
