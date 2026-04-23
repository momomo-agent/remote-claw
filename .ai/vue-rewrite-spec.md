# RemoteClaw Frontend — Vue 3 Rewrite Spec

## Context

RemoteClaw is a menubar Electron app for managing remote devices (shell, files, screen, etc.).
The frontend is served from GitHub Pages (`docs/`) and loaded by Electron BrowserWindows.
The Electron main process (`app/main-logic.js`) handles IPC, daemon WebSocket, and window management.

Current state: `docs/app.js` is 800+ lines of manual DOM manipulation with string templates.
Goal: Rewrite to Vue 3 + Composition API for maintainability, keeping zero-build CDN approach.

## Architecture

### Stack
- **Vue 3** via CDN (ES module build): `https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js`
- **No build step** — ES modules with `<script type="module">`, loaded directly by Electron
- **xterm.js** for shell (keep CDN)
- **Geist font** (keep CDN)

### Directory Structure
```
docs/
  index.html              — mount point + global CSS + CDN imports
  js/
    app.js                — createApp, component registration, router logic
    state.js              — reactive global state (replaces `let state = {...}`)
    api.js                — API helpers (apiFetch, ensureConfig, refreshData)
    composables/
      useShell.js         — shell session lifecycle, xterm integration
      useFiles.js         — file listing, navigation, breadcrumbs
      useTerminal.js      — one-shot command execution, history
      useContextMenu.js   — context menu show/hide/position
    components/
      TabBar.js           — pinnable tab bar with right-click context menu
      DeviceSelect.js     — device dropdown (titlebar + detached)
      ContextMenu.js      — teleported context menu overlay
      AppCard.js          — single app card in the grid
    apps/
      ShellApp.js         — interactive shell (xterm)
      FilesApp.js         — file browser
      TerminalApp.js      — one-shot terminal
      AppsGrid.js         — all apps grid with pin/unpin
      DevicesApp.js       — device list
      HistoryApp.js       — command history
      SettingsApp.js      — server config
      NetworkApp.js       — network diagnostics + Clash proxy management
      ClawApp.js          — OpenClaw monitor (status, sessions, gateway, config)
  editor.html             — keep as-is (standalone)
  editor.js               — keep as-is
  preview.html            — keep as-is (standalone)
  preview.js              — keep as-is
  screen.html             — keep as-is (standalone)
  screen.js               — keep as-is
```

### Key Files NOT Changing
- `app/main-logic.js` — Electron main process (IPC handlers, window management, daemon WS)
- `app/preload.js` — IPC bridge (already generic with `invoke`/`on`/`off`)
- `app/loading.html` — splash screen
- `app/code-server-proxy.js` — WS relay proxy
- `docs/editor.html`, `docs/preview.html`, `docs/screen.html` — standalone pages
- `server/` — Cloudflare Worker relay server
- `daemon/` — device-side daemon

## State Management (`state.js`)

```js
import { reactive, computed } from 'vue'

// App registry
export const ALL_APPS = [
  { id: 'shell',    label: 'Shell',    icon: '⌨',  canDetach: true,  needsDevice: true },
  { id: 'files',    label: 'Files',    icon: '📁', canDetach: true,  needsDevice: true },
  { id: 'terminal', label: 'Terminal', icon: '▶',  canDetach: true,  needsDevice: true },
  { id: 'vscode',   label: 'VS Code',  icon: '💻', canDetach: 'only', needsDevice: true },
  { id: 'browser',  label: 'Browser',  icon: '🌐', canDetach: 'only', needsDevice: true },
  { id: 'screen',   label: 'Screen',   icon: '🖥', canDetach: 'only', needsDevice: true },
  { id: 'network',  label: 'Network',  icon: '📡', canDetach: true,  needsDevice: true },
  { id: 'claw',     label: 'Claw',     icon: '🦞', canDetach: true,  needsDevice: true },
  { id: 'devices',  label: 'Devices',  icon: '📡', canDetach: false, needsDevice: false },
  { id: 'history',  label: 'History',  icon: '📋', canDetach: false, needsDevice: false },
  { id: 'apps',     label: 'Apps',     icon: '⊞',  canDetach: false, needsDevice: false },
  { id: 'settings', label: '⚙',       icon: '⚙',  canDetach: false, needsDevice: false },
]

const DEFAULT_PINNED = ['shell', 'files', 'apps', 'devices', 'settings']

function loadPinned() {
  try { return JSON.parse(localStorage.getItem('rc-pinned-tabs')) || DEFAULT_PINNED }
  catch { return DEFAULT_PINNED }
}

export const state = reactive({
  currentApp: 'shell',  // which app is showing
  connected: false,
  serverUrl: '',
  devices: [],
  history: [],
  selectedDevice: '',
  configRaw: null,
  pinned: false,        // window pinned (not hidden on blur)
  pinnedTabs: loadPinned(),
})

export function savePinnedTabs() {
  localStorage.setItem('rc-pinned-tabs', JSON.stringify(state.pinnedTabs))
}
```

## Component Patterns

All components use Vue 3 `defineComponent` with `setup()` returning a render function (no SFC, no build step).
Template strings via tagged template or inline `h()` calls.

Example pattern:
```js
import { defineComponent, h, ref } from 'vue'

export default defineComponent({
  name: 'AppCard',
  props: { app: Object },
  setup(props, { emit }) {
    return () => h('div', {
      class: ['app-card', { disabled: props.app.needsDevice && !state.selectedDevice }],
      onClick: () => emit('launch', props.app.id),
      onContextmenu: (e) => { e.preventDefault(); emit('context', { app: props.app, x: e.clientX, y: e.clientY }) },
    }, [
      h('div', { class: 'app-icon' }, props.app.icon),
      h('div', { class: 'app-label' }, props.app.label),
    ])
  }
})
```

## NetworkApp Spec

### Data Sources (via remote device exec)
1. **Network info**: `curl -s ifconfig.me` (public IP), `networksetup -getinfo Wi-Fi` (local), `ping -c 1 8.8.8.8`
2. **Clash API** (default `http://127.0.0.1:9090`):
   - `GET /proxies` — list all proxy groups and nodes
   - `GET /proxies/:name/delay` — test latency for a node
   - `PUT /proxies/:group` — switch active node in a group
   - `GET /connections` — active connections
   - `GET /traffic` — real-time traffic stats

### UI Sections
1. **Network Status** — public IP, local IP, DNS, ping to common targets
2. **Proxy Groups** — expandable groups, each showing nodes with latency badges
3. **Speed Test** — batch test all nodes in a group, sort by latency
4. **Traffic** — real-time upload/download speed (if Clash API available)
5. **Connectivity** — quick check Google/GitHub/custom URLs

### Clash API Access
The Clash API runs on the remote device at `127.0.0.1:9090`. Access it through:
- Option A: RemoteClaw exec channel (`curl` commands via daemon)
- Option B: Browser proxy (open-browser IPC to proxy port 9090)
- **Recommended: Option A** for data fetching (exec is already available), Option B for full Clash dashboard fallback

## Migration Strategy

1. Create `docs/js/` directory structure
2. Port state to `state.js`
3. Port API helpers to `api.js`
4. Port each render function to its own app component
5. Port shell/xterm logic to `useShell.js` composable
6. Port files logic to `useFiles.js` composable
7. Build TabBar with pin/unpin context menu
8. Build AppsGrid with app cards
9. Build NetworkApp (new)
10. Build ClawApp (new — OpenClaw monitor)
11. Wire everything in `app.js` with createApp
11. Update `index.html` to use `<script type="module">`
12. Test in Electron (preload.js IPC still works via `window.electronAPI`)
13. Test detached window mode (URL params)
14. Remove old `docs/app.js`

## CSS

Keep all CSS in `index.html` `<style>` block (same as now). The design system (colors, spacing, typography) stays identical.
Add new CSS for:
- `.apps-grid` — 4-column grid for app cards
- `.ctx-menu` — context menu overlay
- `.network-*` — network app specific styles

## Constraints

- **Zero build step** — must work with direct file:// or HTTP serving
- **Electron compatible** — `window.electronAPI` must be accessible
- **Detached window mode** — URL params `?detached=1&tab=shell&device=xxx` must still work
- **GitHub Pages** — `docs/` is deployed as static site
- **Loading splash** — `app/loading.html` loads first, then navigates to `docs/index.html`
- **Standalone pages** — editor.html, preview.html, screen.html are NOT part of Vue app

## Design

Keep the exact same visual design. Dark theme, Geist font, Apple-style cards and spacing.
The refactor is purely architectural — users should see zero visual difference (except the new Network and Claw apps).

## ClawApp Spec (OpenClaw Monitor)

### Data Sources (via remote device exec)
All data fetched by running commands on the remote device through the exec channel.

1. **Status**: `openclaw status` — connection state, model, uptime, version
2. **Gateway**: `openclaw gateway status` — gateway running/stopped, port, PID
3. **Sessions**: `openclaw sessions list --json` (if available) or parse status output
4. **Config**: `cat ~/.openclaw/openclaw.json` — show providers, models, plugins (mask tokens)
5. **Logs**: `openclaw gateway logs --tail 50` or `journalctl -u openclaw --no-pager -n 50`

### UI Sections
1. **Status Card** — green/red indicator, version, uptime, current model, connected channels
2. **Gateway** — running state, port, PID, restart button
3. **Active Sessions** — list of current sessions with age and last activity
4. **Recent Logs** — scrollable log viewer (last 50 lines), auto-refresh
5. **Config Viewer** — read-only display of openclaw.json (tokens masked as `***`)

### Actions
- `openclaw gateway restart` — restart gateway
- `openclaw gateway stop` / `openclaw gateway start`
- Refresh all data
