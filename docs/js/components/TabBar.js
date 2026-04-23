import { defineComponent, h, ref } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state, ALL_APPS, savePinnedTabs } from '../state.js'
import { api } from '../api.js'

export default defineComponent({
  name: 'TabBar',
  emits: ['select', 'contextmenu'],
  setup(props, { emit }) {
    const dragFrom = ref(null)
    const dragOver = ref(null)

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

    // Drag & drop reorder
    function onDragStart(e, id) {
      dragFrom.value = id
      e.dataTransfer.effectAllowed = 'move'
      e.target.style.opacity = '0.4'
    }

    function onDragEnd(e) {
      e.target.style.opacity = ''
      dragFrom.value = null
      dragOver.value = null
    }

    function onDragOverTab(e, id) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      dragOver.value = id
    }

    function onDragLeave(e, id) {
      if (dragOver.value === id) dragOver.value = null
    }

    function onDrop(e, toId) {
      e.preventDefault()
      const fromId = dragFrom.value
      if (!fromId || fromId === toId) return
      const tabs = [...state.pinnedTabs]
      const fromIdx = tabs.indexOf(fromId)
      const toIdx = tabs.indexOf(toId)
      if (fromIdx < 0 || toIdx < 0) return
      tabs.splice(fromIdx, 1)
      tabs.splice(toIdx, 0, fromId)
      state.pinnedTabs = tabs
      savePinnedTabs()
      dragFrom.value = null
      dragOver.value = null
    }

    return () => h('div', { class: 'tabbar' },
      state.pinnedTabs.map(id => {
        const app = ALL_APPS.find(a => a.id === id)
        if (!app) return null
        return h('div', {
          class: ['tabbar-item', {
            active: state.currentApp === id,
            'drag-over': dragOver.value === id && dragFrom.value !== id,
          }],
          draggable: true,
          onClick: () => onTabClick(id),
          onDblclick: () => onTabDblClick(id),
          onContextmenu: (e) => onTabContext(e, id),
          onDragstart: (e) => onDragStart(e, id),
          onDragend: onDragEnd,
          onDragover: (e) => onDragOverTab(e, id),
          onDragleave: (e) => onDragLeave(e, id),
          onDrop: (e) => onDrop(e, id),
        }, app.label)
      })
    )
  },
})
