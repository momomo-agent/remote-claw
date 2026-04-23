import { defineComponent, h, ref, onMounted, nextTick, watch } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state } from '../state.js'
import { refreshData } from '../api.js'
import { useTerminal } from '../composables/useTerminal.js'

export default defineComponent({
  name: 'TerminalApp',
  setup() {
    const { lines, input, executing, runCommand, historyUp, historyDown, clearLines } = useTerminal()
    const outputRef = ref(null)
    const inputRef = ref(null)

    function scrollToBottom() {
      nextTick(() => {
        if (outputRef.value) outputRef.value.scrollTop = outputRef.value.scrollHeight
      })
    }

    watch(lines, scrollToBottom, { deep: true })

    async function onEnter() {
      await runCommand()
      await refreshData()
      scrollToBottom()
    }

    function onKeydown(e) {
      if (e.key === 'Enter') { onEnter(); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); historyUp(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); historyDown(); return }
      if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); clearLines(); return }
    }

    onMounted(() => { if (inputRef.value) inputRef.value.focus() })

    return () => h('div', { class: 'terminal' }, [
      h('div', { class: 'term-output', ref: outputRef },
        lines.value.map(l => {
          if (l.type === 'cmd') {
            return h('div', { class: 'term-line term-cmd' }, [
              h('span', { class: 'term-prompt' }, (state.selectedDevice || '?') + '$'),
              ' ' + l.text,
            ])
          }
          const cls = { stdout: 'term-stdout', stderr: 'term-stderr', info: 'term-info', error: 'term-error' }
          return h('div', { class: `term-line ${cls[l.type] || ''}` }, l.text)
        })
      ),
      h('div', { class: 'term-input-row' }, [
        h('span', { class: 'term-prompt' }, (state.selectedDevice || '?') + '$'),
        h('input', {
          class: 'term-input',
          ref: inputRef,
          placeholder: state.selectedDevice ? 'Type a command...' : 'Select a device first',
          value: input.value,
          disabled: !state.selectedDevice || executing.value,
          onInput: (e) => { input.value = e.target.value },
          onKeydown,
        }),
      ]),
    ])
  },
})
