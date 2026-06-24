if (window.__TAURI__ && !window.electronAPI) {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.electronAPI = {
    onHardwareData: (callback) => {
      listen('hardware-data', (event) => callback(event.payload));
    },
    onSettingsUpdated: (callback) => {
      listen('settings-updated', (event) => callback(event.payload));
    },
    updateTrayIcon: (id, dataUrl, tooltip) => invoke('update_tray_icon', { id, dataUrl, tooltip }),
    openSettings: () => invoke('open_settings'),
    showContextMenu: () => invoke('show_context_menu'),
    moveWindowTo: (x, y) => {
      const { LogicalPosition } = window.__TAURI__.dpi;
      const { getCurrentWindow } = window.__TAURI__.window;
      getCurrentWindow().setPosition(new LogicalPosition(x, y));
    },
    snapLayout: (mode) => invoke('snap_layout', { mode }),
    getSettings: () => invoke('get_settings'),
    saveSettings: (settings) => invoke('save_settings', { settings })
  };
}
