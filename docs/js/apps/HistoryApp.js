import { defineComponent, h, ref } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'
import { state, formatTime } from '../state.js'
import { clearHistory } from '../api.js'

export default defineComponent({
  name: 'HistoryApp',
  setup() {
    const expanded = ref(new Set())

    const toggleExpand = (itemId) => {
      if (expanded.value.has(itemId)) {
        expanded.value.delete(itemId)
      } else {
        expanded.value.add(itemId)
      }
      expanded.value = new Set(expanded.value) // trigger reactivity
    }

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
          state.history.map((item, idx) => {
            const itemId = `${item.createdAt}-${idx}`
            const isExpanded = expanded.value.has(itemId)
            const hasDetails = item.stdout || item.stderr || item.error || item.exitCode !== undefined

            return h('div', { class: 'history-item' }, [
              h('div', {
                class: 'card-row history-row',
                style: { cursor: hasDetails ? 'pointer' : 'default' },
                onClick: hasDetails ? () => toggleExpand(itemId) : undefined,
              }, [
                h('div', { class: 'history-cmd' }, [
                  hasDetails ? h('span', { class: 'history-expand-icon' }, isExpanded ? '▼' : '▶') : null,
                  h('span', null, item.command),
                ]),
                h('div', { class: 'history-meta' }, [
                  h('span', null, item.from ? `${item.from} → ${item.device}` : item.device),
                  h('span', { class: `history-badge badge-${item.status}` }, item.status),
                  item.duration ? h('span', null, (item.duration / 1000).toFixed(1) + 's') : null,
                  h('span', null, formatTime(item.createdAt)),
                ]),
              ]),
              isExpanded ? h('div', { class: 'history-details' }, [
                item.exitCode !== undefined ? h('div', { class: 'history-detail-line' }, [
                  h('strong', null, 'Exit Code: '),
                  h('span', null, String(item.exitCode)),
                ]) : null,
                item.stdout ? h('div', { class: 'history-detail-block' }, [
                  h('strong', null, 'stdout:'),
                  h('pre', null, item.stdout),
                ]) : null,
                item.stderr ? h('div', { class: 'history-detail-block' }, [
                  h('strong', null, 'stderr:'),
                  h('pre', { style: { color: '#ff6b6b' } }, item.stderr),
                ]) : null,
                item.error ? h('div', { class: 'history-detail-block' }, [
                  h('strong', null, 'Error:'),
                  h('pre', { style: { color: '#ff6b6b' } }, item.error),
                ]) : null,
              ]) : null,
            ])
          })
        ),
      ])
    }
  },
})
