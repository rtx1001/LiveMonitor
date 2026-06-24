const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onHardwareData: (callback) => ipcRenderer.on('hardware-data', (_event, data) => callback(data)),
  onSettingsUpdated: (callback) => ipcRenderer.on('settings-updated', (_event, settings) => callback(settings)),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  updateTrayIcon: (id, dataUrl, tooltip) => ipcRenderer.send('update-tray-icon', id, dataUrl, tooltip),
  openSettings: () => ipcRenderer.send('open-settings'),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  moveWindowTo: (x, y) => ipcRenderer.send('move-window-to', x, y),
  snapLayout: (mode) => ipcRenderer.send('snap-layout', mode)
});
