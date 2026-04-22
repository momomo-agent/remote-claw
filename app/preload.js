const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronAPI", {
  // Generic IPC — cloud UI can call any channel without updating preload
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => ipcRenderer.on(channel, (_, data) => cb(data)),
  off: (channel, cb) => ipcRenderer.removeListener(channel, cb),
  onTrayMenuClick: (cb) => ipcRenderer.on("tray-menu-click", (_, data) => cb(data)),
  onNavigateTab: (cb) => ipcRenderer.on("navigate-tab", (_, tab) => cb(tab)),

  // Convenience shortcuts (keep for backward compat)
  getConfig: () => ipcRenderer.invoke("get-config"),
  fetchDevices: () => ipcRenderer.invoke("fetch-devices"),
  fetchHistory: (limit) => ipcRenderer.invoke("fetch-history", limit),
  execCommand: (data) => ipcRenderer.invoke("exec-command", data),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  toggleConnection: () => ipcRenderer.invoke("toggle-connection"),
  getPinned: () => ipcRenderer.invoke("get-pinned"),
  closeWindow: () => ipcRenderer.invoke("close-window"),
  onDaemonStatus: (cb) => ipcRenderer.on("daemon-status", (_, data) => cb(data)),
  onRefresh: (cb) => ipcRenderer.on("refresh", () => cb()),
  onPinnedChanged: (cb) => ipcRenderer.on("pinned-changed", (_, data) => cb(data)),
});
