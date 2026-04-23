import { defineComponent, h, ref, onMounted, onUpdated, watch } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'
import { state } from '../state.js'
import { useShell } from '../composables/useShell.js'

// Singleton shell instance shared across mounts
let shellInstance = null

export function getShellInstance() {
  if (!shellInstance) shellInstance = useShell()
  return shellInstance
}

export default defineComponent({
  name: 'ShellApp',
  setup() {
    const shell = getShellInstance()
    const containerRef = ref(null)

    onMounted(() => {
      if (containerRef.value && state.selectedDevice) {
        shell.initTerminal(containerRef.value)
        // Auto-connect when entering shell tab
        if (shell.status.value === 'closed') {
          shell.openSession()
        }
      }
    })

    onUpdated(() => {
      if (containerRef.value && state.selectedDevice && shell.status.value === 'open') {
        const xt = shell.getXterm()
        if (xt && !containerRef.value.querySelector('.xterm')) {
          containerRef.value.appendChild(xt.element)
        }
      }
    })

    return () => {
      if (!state.selectedDevice) {
        return h('div', { class: 'empty' }, [
          h('div', { class: 'empty-icon' }, '\u2328\ufe0f'),
          h('div', { class: 'empty-text' }, 'Select a device to open a shell'),
        ])
      }

      const statusText = shell.status.value === 'open' ? 'Connected'
        : shell.status.value === 'connecting' ? 'Connecting...' : 'Disconnected'
      const statusColor = shell.status.value === 'open' ? 'var(--green)'
        : shell.status.value === 'connecting' ? 'var(--orange)' : 'var(--text-tertiary)'

      const children = [
        h('div', { id: 'xterm-container', ref: containerRef }),
      ]

      if (shell.status.value !== 'open') {
        const overlayChildren = [
          h('div', { class: 'shell-overlay-status', style: { color: statusColor } }, statusText),
        ]
        if (shell.status.value === 'closed') {
          overlayChildren.push(
            h('button', {
              class: 'shell-overlay-btn',
              onClick: () => {
                shell.openSession()
                // Re-init terminal if needed
                if (containerRef.value) shell.initTerminal(containerRef.value)
              },
            }, 'Connect')
          )
        }
        children.push(
          h('div', { class: 'shell-overlay' },
            h('div', { class: 'shell-overlay-content' }, overlayChildren)
          )
        )
      }

      return h('div', { class: 'shell-container' }, children)
    }
  },
})
