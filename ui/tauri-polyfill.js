(function () {
  function waitForTauri(callback) {
    if (window.__TAURI__) {
      callback();
      return;
    }
    setTimeout(() => waitForTauri(callback), 40);
  }

  waitForTauri(() => {
    const { invoke } = window.__TAURI__.core;
    const { listen, emit } = window.__TAURI__.event;

    window.electronAPI = {
      onHardwareData: (callback) => {
        listen('hardware-data', (event) => callback(event.payload));
      },
      onSettingsUpdated: (callback) => {
        listen('settings-updated', (event) => callback(event.payload));
      },
      getSettings: () => invoke('get_settings'),
      saveSettings: (settings) => invoke('save_settings', { settings }),
      updateTrayIcon: (id, dataUrl, tooltip) => invoke('update_tray_icon', { id, dataUrl, tooltip }),
      notifyMainReady: () => emit('main-window-ready'),
      openSettings: () => invoke('open_settings'),
      requestOpenSettingsFromWidget: () => emit('open-settings-from-widget'),
      closeSettings: () => invoke('close_settings'),
      showContextMenu: () => invoke('show_context_menu'),
      adjustWidgetHeight: (height) => invoke('adjust_widget_height', { height }),
      moveWindowTo: (x, y) => {
        const { getCurrentWindow } = window.__TAURI__.window;
        const { LogicalPosition } = window.__TAURI__.dpi;
        return getCurrentWindow().setPosition(new LogicalPosition(x, y));
      },
      snapLayout: (mode) => invoke('snap_layout', { mode })
    };

    window.dispatchEvent(new Event('tauri-api-ready'));
  });
})();
