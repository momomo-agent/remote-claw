import { defineComponent, h, watch } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { state, fileIcon, formatSize } from '../state.js'
import { api } from '../api.js'
import { useFiles } from '../composables/useFiles.js'

// Singleton files instance
let filesInstance = null
export function getFilesInstance() {
  if (!filesInstance) filesInstance = useFiles()
  return filesInstance
}

export default defineComponent({
  name: 'FilesApp',
  setup() {
    const files = getFilesInstance()

    function openEditor() {
      api.invoke('open-editor', { dir: files.path.value, device: state.selectedDevice })
    }

    function openVscode() {
      api.invoke('open-code-server', { device: state.selectedDevice, folder: files.path.value })
    }

    function onFileClick(f) {
      if (f.isDir) {
        files.navigateTo(f.name)
      } else {
        const ext = f.name.split('.').pop()?.toLowerCase()
        const previewable = ['md','markdown','txt','json','js','ts','py','sh','yml','yaml','swift','m','h','c','cpp','css','html','xml','toml','ini','conf','log']
        if (previewable.includes(ext)) {
          const fullPath = files.path.value + '/' + f.name
          api.invoke('open-editor', { dir: files.path.value, file: fullPath, device: state.selectedDevice, title: f.name })
        }
      }
    }

    return () => {
      if (!state.selectedDevice) {
        return h('div', { class: 'empty' }, [
          h('div', { class: 'empty-icon' }, '\ud83d\udcc1'),
          h('div', { class: 'empty-text' }, 'Select a device to browse files'),
        ])
      }

      // Breadcrumb
      const pathParts = files.path.value.split('/').filter(Boolean)
      const breadcrumbs = pathParts.map((p, i) => {
        const full = '/' + pathParts.slice(0, i + 1).join('/')
        return h('span', {
          class: 'files-btn',
          onClick: (e) => { e.stopPropagation(); files.loadFiles(full) },
        }, p)
      })
      const breadcrumbNodes = []
      breadcrumbs.forEach((bc, i) => {
        if (i > 0) breadcrumbNodes.push(' / ')
        breadcrumbNodes.push(bc)
      })

      // Body
      let body
      if (files.loading.value) {
        body = h('div', { class: 'empty' }, [
          h('div', { class: 'spinner' }),
          h('div', { class: 'empty-text' }, 'Loading files...'),
        ])
      } else if (files.error.value) {
        body = h('div', { class: 'empty' }, [
          h('div', { class: 'empty-icon' }, '\u26a0\ufe0f'),
          h('div', { class: 'empty-text' }, files.error.value),
          h('button', {
            class: 'files-btn', style: { marginTop: '8px', padding: '6px 16px' },
            onClick: () => files.loadFiles(files.path.value),
          }, 'Retry'),
        ])
      } else if (!files.entries.value.length) {
        body = h('div', { class: 'empty' }, [
          h('div', { class: 'empty-icon' }, '\ud83d\udcc2'),
          h('div', { class: 'empty-text' }, 'Empty directory'),
          h('div', { class: 'empty-hint' }, files.path.value),
        ])
      } else {
        body = h('div', { class: 'card' },
          files.entries.value.map(f =>
            h('div', {
              class: 'card-row file-row',
              onClick: () => onFileClick(f),
            }, [
              h('div', { class: 'file-icon' },
                f.isDir ? '\ud83d\udcc1' : f.isSymlink ? '\ud83d\udd17' : fileIcon(f.name)
              ),
              h('div', { class: 'file-info' }, [
                h('div', { class: ['file-name', { dir: f.isDir }] }, f.name),
                f.mtime ? h('div', { class: 'file-meta' }, f.mtime) : null,
              ]),
              h('div', { class: 'file-size' }, f.isDir ? '' : formatSize(f.size)),
            ])
          )
        )
      }

      return h('div', null, [
        h('div', { class: 'files-toolbar' }, [
          h('button', { class: 'files-btn', title: 'Go up', onClick: () => files.goUp() }, '\u2191'),
          h('div', { class: 'files-path' },
            files.path.value === '~' ? '~' : (breadcrumbNodes.length ? breadcrumbNodes : '/')
          ),
          h('button', { class: 'files-btn', title: 'Refresh', onClick: () => files.loadFiles(files.path.value) }, '\u21bb'),
          h('button', { class: 'files-btn', title: 'Open in Editor', onClick: openEditor }, '\u270e Code'),
          h('button', {
            class: 'files-btn', title: 'Open in VS Code',
            style: { color: 'var(--accent)' }, onClick: openVscode,
          }, '\u2318 VS Code'),
        ]),
        body,
      ])
    }
  },
})
