import { defineComponent, h, ref, onMounted, onUpdated } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'

export default defineComponent({
  name: 'ContextMenu',
  props: {
    visible: Boolean,
    x: Number,
    y: Number,
    items: Array,
  },
  setup(props, { emit }) {
    const menuRef = ref(null)

    function adjustPosition() {
      const el = menuRef.value
      if (!el || !props.visible) return
      const rect = el.getBoundingClientRect()
      if (rect.right > window.innerWidth) el.style.left = (props.x - rect.width) + 'px'
      if (rect.bottom > window.innerHeight) el.style.top = (props.y - rect.height) + 'px'
    }

    onUpdated(adjustPosition)

    return () => {
      if (!props.visible || !props.items?.length) return null
      return h('div', {
        class: 'ctx-menu',
        ref: menuRef,
        style: { left: props.x + 'px', top: props.y + 'px' },
        onClick: (e) => e.stopPropagation(),
      }, props.items.map((item, i) =>
        h('div', {
          class: 'ctx-item',
          onClick: () => {
            item.action?.()
            emit('close')
          },
        }, item.label)
      ))
    }
  },
})
