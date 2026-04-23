import { defineComponent, h } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state, formatTime } from '../state.js'
import { clearHistory } from '../api.js'

export default defineComponent({
  name: 'HistoryApp',
  setup() {
    return () => {
      if (!state.history.length) {
        return h('div', { class: 'empty' }, [
          h('div', { class: 'empty-icon' }, '📋'),
          h('div', { class: 'empty-text' }, 'No commands yet'),
          h('div', { class: 'empty-hint' }, 'Commands run via Shell, Files, or Claw will appear here'),
        ])
      }
      return h('div', {}, [
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '6px 10px' } }, [
          h('button', {
            class: 'files-btn',
            style: { fontSize: '10px', padding: '3px 10px' },
            onClick: clearHistory,
          }, 'Clear'),
        ]),
        h('div', { class: 'card' },
          state.history.map(item =>
            h('div', { class: 'card-row history-row' }, [
              h('div', { class: 'history-cmd' }, item.command),
              h('div', { class: 'history-meta' }, [
                h('span', null, item.device),
                h('span', { class: `history-badge badge-${item.status}` }, item.status),
                item.duration ? h('span', null, (item.duration / 1000).toFixed(1) + 's') : null,
                h('span', null, formatTime(item.createdAt)),
              ]),
            ])
          )
        ),
      ])
    }
  },
})
