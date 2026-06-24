document.addEventListener('DOMContentLoaded', async () => {
  // Request settings from main process
  const settings = await window.electronAPI.getSettings();

  document.getElementById('autoStart').checked = settings.autoStart;
  document.getElementById('showMainTray').checked = settings.showMainTray;
  document.getElementById('showGpuTempTray').checked = settings.showGpuTempTray;
  document.getElementById('showGpuLoadTray').checked = settings.showGpuLoadTray;
  document.getElementById('showVramTray').checked = settings.showVramTray;
  document.getElementById('showGpuPowerTray').checked = settings.showGpuPowerTray;

  const opacitySlider = document.getElementById('opacity');
  const opacityVal = document.getElementById('opacityVal');
  const accentColorPicker = document.getElementById('accentColor');
  
  if (settings.opacity) {
    opacitySlider.value = settings.opacity;
    opacityVal.innerText = `${settings.opacity}%`;
  }
  if (settings.accentColor) {
    accentColorPicker.value = settings.accentColor;
    document.documentElement.style.setProperty('--accent-color', settings.accentColor);
  }

  accentColorPicker.addEventListener('input', () => {
    document.documentElement.style.setProperty('--accent-color', accentColorPicker.value);
  });

  opacitySlider.addEventListener('input', () => {
    opacityVal.innerText = `${opacitySlider.value}%`;
  });

  document.getElementById('apply-btn').addEventListener('click', () => {
    const newSettings = {
      autoStart: document.getElementById('autoStart').checked,
      showMainTray: document.getElementById('showMainTray').checked,
      showGpuTempTray: document.getElementById('showGpuTempTray').checked,
      showGpuLoadTray: document.getElementById('showGpuLoadTray').checked,
      showVramTray: document.getElementById('showVramTray').checked,
      showGpuPowerTray: document.getElementById('showGpuPowerTray').checked,
      opacity: parseInt(opacitySlider.value),
      accentColor: accentColorPicker.value
    };
    
    window.electronAPI.saveSettings(newSettings);
  });

  document.getElementById('close-btn').addEventListener('click', () => {
    window.close();
  });

  document.getElementById('snap-vertical').addEventListener('click', () => {
    window.electronAPI.snapLayout('vertical');
  });
  
  document.getElementById('snap-horizontal').addEventListener('click', () => {
    window.electronAPI.snapLayout('horizontal');
  });
});
