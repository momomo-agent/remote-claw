import { ref } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state } from '../state.js'
import { apiFetch } from '../api.js'

export function useTerminal() {
  const lines = ref([])
  const input = ref('')
  const executing = ref(false)
  const cmdHistory = []
  let cmdHistoryIdx = -1

  async function runCommand() {
    const cmd = input.value.trim()
    if (!cmd || !state.selectedDevice || executing.value) return

    if (cmd === 'clear') {
      lines.value = []
      input.value = ''
      return
    }

    cmdHistory.push(cmd)
    cmdHistoryIdx = -1
    lines.value.push({ type: 'cmd', text: cmd })
    input.value = ''
    executing.value = true

    try {
      const result = await apiFetch('/exec', {
        method: 'POST',
        body: JSON.stringify({ device: state.selectedDevice, command: cmd, oneshot: true, timeout: 30000 }),
        fallback: { error: 'request failed' },
      })
      if (result.error) {
        lines.value.push({ type: 'error', text: result.error })
      } else {
        if (result.stdout) lines.value.push({ type: 'stdout', text: result.stdout.replace(/\n$/, '') })
        if (result.stderr) lines.value.push({ type: 'stderr', text: result.stderr.replace(/\n$/, '') })
        const dur = result.completedAt && result.createdAt ? ((result.completedAt - result.createdAt) / 1000).toFixed(1) + 's' : ''
        lines.value.push({ type: 'info', text: `exit ${result.exitCode}${dur ? ' \u00b7 ' + dur : ''}` })
      }
    } catch (e) {
      lines.value.push({ type: 'error', text: e.message })
    }

    executing.value = false
    if (lines.value.length > 200) lines.value = lines.value.slice(-200)
  }

  function historyUp() {
    if (cmdHistoryIdx < cmdHistory.length - 1) {
      cmdHistoryIdx++
      input.value = cmdHistory[cmdHistory.length - 1 - cmdHistoryIdx]
    }
  }

  function historyDown() {
    if (cmdHistoryIdx > 0) {
      cmdHistoryIdx--
      input.value = cmdHistory[cmdHistory.length - 1 - cmdHistoryIdx]
    } else {
      cmdHistoryIdx = -1
      input.value = ''
    }
  }

  function clearLines() {
    lines.value = []
  }

  return { lines, input, executing, runCommand, historyUp, historyDown, clearLines }
}
