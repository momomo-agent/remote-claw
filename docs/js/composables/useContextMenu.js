import { ref } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js'

export function useContextMenu() {
  const visible = ref(false)
  const x = ref(0)
  const y = ref(0)
  const items = ref([])

  let closeHandler = null

  function show(cx, cy, menuItems) {
    x.value = cx
    y.value = cy
    items.value = menuItems
    visible.value = true

    if (closeHandler) document.removeEventListener('click', closeHandler)
    closeHandler = () => { hide() }
    setTimeout(() => document.addEventListener('click', closeHandler), 0)
  }

  function hide() {
    visible.value = false
    items.value = []
    if (closeHandler) {
      document.removeEventListener('click', closeHandler)
      closeHandler = null
    }
  }

  function adjust(el) {
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.right > window.innerWidth) x.value = x.value - rect.width
    if (rect.bottom > window.innerHeight) y.value = y.value - rect.height
  }

  return { visible, x, y, items, show, hide, adjust }
}
