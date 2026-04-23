import { defineComponent, h, ref, onMounted, onUnmounted } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'
import { state } from '../state.js'
import { api } from '../api.js'

export default defineComponent({
  name: 'ScreenApp',
  setup() {
    const streaming = ref(false)
    const sessionId = ref(null)
    const imgSrc = ref(null)
    const fps = ref(2)
    const quality = ref(60)
    const frameCount = ref(0)
    const lastFrameTime = ref(null)

    function onFrame(msg) {
      if (msg.sessionId !== sessionId.value) return
      imgSrc.value = 'data:image/jpeg;base64,' + msg.data
      frameCount.value++
      lastFrameTime.value = Date.now()
    }

    function start() {
      if (!state.selectedDevice) return
      const sid = 'screen-' + Math.random().toString(36).slice(2, 8)
      sessionId.value = sid
      frameCount.value = 0
      api.on('screen-frame', onFrame)
      api.invoke('screen-start', {
        sessionId: sid,
        device: state.selectedDevice,
        fps: fps.value,
        quality: quality.value,
      })
      streaming.value = true
    }

    function stop() {
      if (sessionId.value) {
        api.invoke('screen-stop', { sessionId: sessionId.value, device: state.selectedDevice })
      }
      api.off('screen-frame', onFrame)
      streaming.value = false
      sessionId.value = null
    }

    onUnmounted(() => { if (streaming.value) stop() })

    return () => {
      if (!state.selectedDevice) {
        return h('div', { class: 'empty' }, [
          h('div', { class: 'empty-icon' }, '🖥'),
          h('div', { class: 'empty-text' }, 'Select a device to view screen'),
        ])
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, [
        // Toolbar
        h('div', { class: 'files-toolbar' }, [
          h('button', {
            class: 'files-btn',
            style: streaming.value ? { background: 'var(--red)', color: '#fff' } : { background: 'var(--green)', color: '#fff' },
            onClick: () => streaming.value ? stop() : start(),
          }, streaming.value ? '■ Stop' : '▶ Start'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '8px' } }, [
            h('span', { style: { fontSize: '10px', color: 'var(--text-tertiary)' } }, 'FPS'),
            h('select', {
              class: 'files-btn',
              style: { fontSize: '10px', padding: '2px 4px' },
              value: fps.value,
              onChange: (e) => { fps.value = parseInt(e.target.value) },
              disabled: streaming.value,
            }, [1, 2, 3, 5].map(v => h('option', { value: v }, v))),
          ]),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '8px' } }, [
            h('span', { style: { fontSize: '10px', color: 'var(--text-tertiary)' } }, 'Quality'),
            h('select', {
              class: 'files-btn',
              style: { fontSize: '10px', padding: '2px 4px' },
              value: quality.value,
              onChange: (e) => { quality.value = parseInt(e.target.value) },
              disabled: streaming.value,
            }, [
              h('option', { value: 30 }, 'Low'),
              h('option', { value: 60 }, 'Medium'),
              h('option', { value: 85 }, 'High'),
            ]),
          ]),
          streaming.value ? h('span', {
            style: { marginLeft: 'auto', fontSize: '10px', color: 'var(--text-tertiary)' },
          }, `${frameCount.value} frames`) : null,
        ]),
        // Screen
        h('div', {
          style: {
            flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden', background: '#000', padding: '4px',
          },
        }, [
          imgSrc.value
            ? h('img', {
                src: imgSrc.value,
                style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '4px' },
              })
            : h('div', { class: 'empty', style: { color: '#555' } }, [
                h('div', { style: { fontSize: '48px', opacity: '0.3' } }, '🖥'),
                h('div', { style: { fontSize: '12px', marginTop: '8px' } },
                  streaming.value ? 'Waiting for first frame...' : 'Press Start to view remote screen'
                ),
              ]),
        ]),
      ])
    }
  },
})
