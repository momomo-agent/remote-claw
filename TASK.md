# Task: Persistent Shell Session (PTY over WebSocket)

## Goal
Add real terminal sessions to RemoteClaw — persistent shell with state (cd, env vars), real-time streaming output, and interactive program support (vim, top, htop).

## Architecture

### Daemon (daemon/daemon.js)
1. Add `node-pty` dependency (`npm install node-pty` in daemon dir, or in app/)
2. On receiving `{ type: "shell-open", sessionId, to: "<requester-device>" }`:
   - Spawn a pty: `pty.spawn("/bin/zsh", [], { name: "xterm-256color", cols: 80, rows: 24, env: { ...process.env, HOME, PATH: "/opt/homebrew/bin:/usr/local/bin:..." } })`
   - Store in `shellSessions` map by sessionId
   - On pty data output: send `{ type: "shell-data", sessionId, data: <base64> }` via WS (to requester)
   - On pty exit: send `{ type: "shell-exit", sessionId, exitCode }` via WS
3. On receiving `{ type: "shell-input", sessionId, data: <base64> }`:
   - Write to the pty's stdin
4. On receiving `{ type: "shell-resize", sessionId, cols, rows }`:
   - Call `pty.resize(cols, rows)`
5. On receiving `{ type: "shell-close", sessionId }`:
   - Kill the pty, remove from map

### Worker DO (server/src/index.ts)
1. Add relay for shell messages: `shell-open`, `shell-input`, `shell-data`, `shell-resize`, `shell-close`, `shell-exit`
2. Same pattern as file transfer relay — look up target device by `msg.to`, forward with `from` field added
3. That's it — Worker is just a relay

### Cloud UI (docs/app.js + docs/index.html)
1. Add xterm.js via CDN: `<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js">` and CSS
2. Add xterm-addon-fit for auto-resize
3. New "Shell" tab (replace current terminal tab):
   - On tab open: send `shell-open` message via electronAPI
   - Render xterm Terminal instance
   - On xterm data (user typing): send `shell-input` to daemon
   - On receiving `shell-data`: write to xterm
   - On receiving `shell-exit`: show message, allow reconnect
   - On window resize: send `shell-resize`
4. The current oneshot terminal can stay as a fallback or be removed

### Electron main.js
1. Add IPC handlers for shell session management:
   - `shell-open`: send WS message to daemon via the existing daemonWs connection
   - `shell-input`: forward to daemonWs  
   - `shell-resize`: forward to daemonWs
   - `shell-close`: forward to daemonWs
2. On receiving `shell-data` from daemonWs: forward to renderer
3. On receiving `shell-exit` from daemonWs: forward to renderer

### CLI (cli/rclaw.js) — optional enhancement
- `rclaw shell` could use blessed or raw stdin mode for a real terminal experience
- Lower priority, the Electron UI is the main interface

## Key Constraints
- node-pty needs to be installed where the daemon runs (both Mac mini and inside Electron app)
- Electron app bundles daemon code, so node-pty needs to be in app/package.json
- WS messages should use base64 for binary terminal data
- Keep existing oneshot exec working (don't break rclaw exec)
- Shell sessions should auto-close after 30 min idle
- Max 5 concurrent shell sessions per device

## Files to Modify
- `daemon/daemon.js` — add pty spawn + shell message handlers
- `server/src/index.ts` — add shell message relay in handleWs
- `app/main.js` — add shell IPC handlers + WS forwarding
- `app/package.json` — add node-pty dependency
- `docs/index.html` — add xterm.js CDN links
- `docs/app.js` — add Shell tab with xterm integration

## Testing
1. `rclaw devices` should still work
2. `rclaw exec` should still work  
3. Open RemoteClaw app → Shell tab → should get a real terminal
4. `cd /tmp && ls` should work (state persists)
5. `vim` or `htop` should render correctly
6. Window resize should update terminal size
