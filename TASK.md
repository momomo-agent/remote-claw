# RemoteClaw Electron App - 三个改进

## 项目路径
/Users/kenefe/LOCAL/momo-agent/projects/remote-claw/app/

## 当前架构
- Electron menubar app (menubar npm package)
- main.js: Electron main process, embedded daemon (WebSocket to remote.momomo.dev), IPC handlers
- renderer/index.html + renderer/app.js: UI (terminal, devices, history, settings tabs)
- 服务端: Cloudflare Worker at remote.momomo.dev

## 任务 1: 热更新 - UI 从云端加载

把 renderer UI 改为从 `https://remote.momomo.dev/app` 加载，而不是本地 `file://...index.html`。

### 要求：
1. main.js 中 menubar 的 index 改为 `https://remote.momomo.dev/app`
2. 在 Cloudflare Worker (server/src/index.ts) 中添加 `/app` 路由，返回完整的 HTML（包含内联的 CSS 和 JS）
3. 由于云端页面无法用 `require("electron")`，需要改通信方式：
   - main.js 用 preload script 暴露 IPC 方法到 window.electronAPI
   - renderer JS 通过 window.electronAPI 调用（而不是直接 require ipcRenderer）
4. 保留本地 HTML 作为 fallback（云端加载失败时用本地版本）
5. Worker 返回的 HTML 要包含当前 renderer/index.html 的所有样式和 renderer/app.js 的所有逻辑

### preload.js 示例：
```javascript
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  fetchDevices: () => ipcRenderer.invoke("fetch-devices"),
  fetchHistory: (limit) => ipcRenderer.invoke("fetch-history", limit),
  execCommand: (data) => ipcRenderer.invoke("exec-command", data),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  onDaemonStatus: (cb) => ipcRenderer.on("daemon-status", (_, data) => cb(data)),
  onRefresh: (cb) => ipcRenderer.on("refresh", () => cb()),
});
```

### main.js 改动：
```javascript
browserWindow: {
  webPreferences: {
    nodeIntegration: false,  // 改为 false
    contextIsolation: true,  // 改为 true
    preload: path.join(__dirname, "preload.js"),
  },
}
```

## 任务 2: 窗口拖出固定

当用户把窗口从 menubar 位置拖走时，窗口变为固定模式（不会自动隐藏）。

### 要求：
1. 监听窗口 `move` 事件，检测窗口是否被拖离 tray 位置
2. 如果拖离了：
   - 窗口变为固定模式（不再跟随 tray 点击自动隐藏）
   - 右上角显示关闭按钮（X）
   - 窗口标题栏可拖动
3. 点击 X 关闭窗口后：
   - 窗口隐藏（不是退出 app）
   - 下次点击 tray 图标，窗口重新出现在 tray 位置（回到临时模式）
4. 实现方式：
   - 在 main.js 中跟踪 `isPinned` 状态
   - pinned 时禁用 menubar 的 auto-hide
   - 在 renderer HTML 中加一个 close 按钮（仅 pinned 时显示）
   - 通过 IPC 通知 renderer 当前是否 pinned

## 任务 3: 支持调整大小

### 要求：
1. `resizable: true`（当前是 false）
2. 设置合理的 minWidth/minHeight（比如 320x400）
3. terminal 区域要能自适应高度

## 任务 4: 连接开关

### 要求：
1. 在 header 区域加一个连接开关（toggle），点击可以断开/重连 daemon WebSocket
2. 断开时：状态灯变红，不再自动重连，设备列表清空
3. 连接时：重新建立 WebSocket 连接
4. 开关状态持久化到 config.json（`enabled: true/false`）
5. app 启动时根据 config 决定是否自动连接
6. 断开状态下 terminal 输入禁用，显示 "disconnected" 提示

## 注意事项
- 不要改 daemon/daemon.js 和 cli/rclaw.js
- Worker 代码在 server/src/index.ts
- 部署 Worker 用 `cd server && npx wrangler deploy`
- 测试时可以先本地跑 `cd app && npx electron .`
- renderer/app.js 中所有 `ipcRenderer.invoke(...)` 和 `ipcRenderer.on(...)` 都要改成 `window.electronAPI.xxx()`
- Worker 需要走代理部署：在 server/ 目录下 `npx wrangler deploy` 会自动用环境变量的代理
