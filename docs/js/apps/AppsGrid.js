import { defineComponent, h } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state, ALL_APPS, savePinnedTabs } from '../state.js'
import AppCard from '../components/AppCard.js'

export default defineComponent({
  name: 'AppsGrid',
  components: { AppCard },
  emits: ['launch', 'contextmenu'],
  setup(props, { emit }) {
    function onAppContext({ app, x, y }) {
      const isPinned = state.pinnedTabs.includes(app.id)
      const items = []
      if (isPinned) {
        items.push({
          label: 'Unpin from tab bar',
          action: () => {
            state.pinnedTabs = state.pinnedTabs.filter(t => t !== app.id)
            savePinnedTabs()
          },
        })
      } else {
        items.push({
          label: 'Pin to tab bar',
          action: () => {
            const idx = state.pinnedTabs.indexOf('settings')
            if (idx >= 0) state.pinnedTabs.splice(idx, 0, app.id)
            else state.pinnedTabs.push(app.id)
            savePinnedTabs()
          },
        })
      }
      if (app.canDetach === true) {
        items.push({
          label: 'Open in window',
          action: () => {
            api.invoke('open-tab-window', {
              tab: app.id, device: state.selectedDevice,
              title: `RemoteClaw \u2014 ${app.label}`,
            })
          },
        })
      }
      emit('contextmenu', { x, y, items })
    }

    return () => {
      const deviceApps = ALL_APPS.filter(a => a.needsDevice && a.id !== 'apps' && a.id !== 'settings')
      const systemApps = ALL_APPS.filter(a => !a.needsDevice && a.id !== 'apps' && a.id !== 'settings')

      return h('div', null, [
        // Device apps
        h('div', { class: 'apps-grid-section' }, [
          h('div', { class: 'section-label' }, 'Device'),
          h('div', { class: 'apps-grid' },
            deviceApps.map(app =>
              h(AppCard, {
                app,
                key: app.id,
                onLaunch: (id) => emit('launch', id),
                onContext: onAppContext,
              })
            )
          ),
        ]),
        // System apps
        h('div', { class: 'apps-grid-section' }, [
          h('div', { class: 'section-label' }, 'System'),
          h('div', { class: 'apps-grid' },
            systemApps.map(app =>
              h(AppCard, {
                app,
                key: app.id,
                onLaunch: (id) => emit('launch', id),
                onContext: onAppContext,
              })
            )
          ),
        ]),
      ])
    }
  },
})
