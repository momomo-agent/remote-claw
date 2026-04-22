const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  fetchDevices: () => ipcRenderer.invoke("fetch-devices"),
  fetchHistory: (limit) => ipcRenderer.invoke("fetch-history", limit),
  execCommand: (data) => ipcRenderer.invoke("exec-command", data),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  onDaemonStatus: (cb) => ipcRenderer.on("daemon-status", (_, data) => cb(data)),
  onRefresh: (cb) => ipcRenderer.on("refresh", () => cb()),
  getPinned: () => ipcRenderer.invoke("get-pinned"),
  toggleConnection: () => ipcRenderer.invoke("toggle-connection"),
  onPinnedChanged: (cb) => ipcRenderer.on("pinned-changed", (_, data) => cb(data)),
  closeWindow: () => ipcRenderer.invoke("close-window"),
});
