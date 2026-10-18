const THEME_SWATCHES = [
  { id: 'blue', accent: '#a8c7fa' },
  { id: 'green', accent: '#7bd17a' },
  { id: 'lime', accent: '#d7db63' },
  { id: 'gold', accent: '#f0c531' },
  { id: 'orange', accent: '#f45c3d' },
  { id: 'pink', accent: '#d45aae' },
  { id: 'purple', accent: '#a95de6' }
];

function $(id) {
  return document.getElementById(id);
}

function setAccent(color) {
  document.documentElement.style.setProperty('--accent-color', color);
  document.documentElement.style.setProperty('--accent-soft', `${color}24`);
  document.documentElement.style.setProperty('--accent-soft-strong', `${color}44`);
  for (const button of document.querySelectorAll('.swatch')) {
    button.classList.toggle('active', button.dataset.color.toLowerCase() === color.toLowerCase());
  }
}

function setLayoutActive(mode) {
  for (const button of document.querySelectorAll('.segmented button')) {
    button.classList.toggle('active', button.dataset.mode === mode);
  }
}

const DEFAULT_SETTINGS = {
  autoStart: false,
  showMainTray: true,
  showGpuTempTray: false,
  showGpuLoadTray: false,
  showVramTray: false,
  showGpuPowerTray: false,
  opacity: 90,
  accentColor: '#a8c7fa',
  layoutMode: 'horizontal'
};

function collectSettings() {
  return {
    autoStart: $('autoStart').checked,
    showMainTray: $('showMainTray').checked,
    showGpuTempTray: $('showGpuTempTray').checked,
    showGpuLoadTray: $('showGpuLoadTray').checked,
    showVramTray: $('showVramTray').checked,
    showGpuPowerTray: $('showGpuPowerTray').checked,
    opacity: Number.parseInt($('opacity').value, 10),
    accentColor: $('accentColor').value,
    layoutMode: document.querySelector('.segmented button.active')?.dataset.mode || 'horizontal'
  };
}

function applySettingsToForm(settings) {
  settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  $('autoStart').checked = Boolean(settings.autoStart);
  $('showMainTray').checked = settings.showMainTray !== false;
  $('showGpuTempTray').checked = Boolean(settings.showGpuTempTray);
  $('showGpuLoadTray').checked = Boolean(settings.showGpuLoadTray);
  $('showVramTray').checked = Boolean(settings.showVramTray);
  $('showGpuPowerTray').checked = Boolean(settings.showGpuPowerTray);

  const opacity = settings.opacity ?? 90;
  $('opacity').value = opacity;
  $('opacityVal').innerText = `${opacity}%`;

  const accent = settings.accentColor || '#a8c7fa';
  $('accentColor').value = accent;
  setAccent(accent);
  setLayoutActive(settings.layoutMode === 'vertical' ? 'vertical' : 'horizontal');
}

function initSwatches() {
  const container = $('themeSwatches');
  if (!container || container.children.length > 0) return;
  for (const swatch of THEME_SWATCHES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.color = swatch.accent;
    button.title = swatch.id;
    button.setAttribute('aria-label', `${swatch.id} accent`);
    button.style.setProperty('--swatch-color', swatch.accent);
    button.addEventListener('click', () => {
      $('accentColor').value = swatch.accent;
      setAccent(swatch.accent);
      saveCurrentSettings('accent');
    });
    container.appendChild(button);
  }
}

function saveCurrentSettings(reason) {
  if (!window.electronAPI?.saveSettings) return;
  window.electronAPI
    .saveSettings(collectSettings())
    .catch((error) => console.error(`Failed to save ${reason}`, error));
}

function renderDiagnostics(payload) {
  const panel = $('diagnosticsPanel');
  if (!panel) return;
  panel.innerHTML = '';

  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  if (groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'diagnostics-empty';
    empty.textContent = 'Diagnostics unavailable';
    panel.appendChild(empty);
    return;
  }

  for (const group of groups) {
    const groupElement = document.createElement('div');
    groupElement.className = 'diagnostics-group';

    const title = document.createElement('div');
    title.className = 'diagnostics-title';
    title.textContent = group.title || 'Status';
    groupElement.appendChild(title);

    const items = Array.isArray(group.items) ? group.items : [];
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'diagnostics-row';

      const label = document.createElement('div');
      label.className = 'diagnostics-label';
      label.textContent = item.label || '';

      const value = document.createElement('div');
      value.className = 'diagnostics-value';
      value.textContent = item.value || '';
      value.title = item.value || '';

      const status = document.createElement('span');
      status.className = `diagnostics-status ${item.status || 'warn'}`;
      status.title = item.status || 'warn';

      row.append(label, value, status);
      groupElement.appendChild(row);
    }

    panel.appendChild(groupElement);
  }
}

function loadDiagnostics() {
  const panel = $('diagnosticsPanel');
  if (!panel) return;

  if (!window.electronAPI?.getDiagnostics) {
    panel.innerHTML = '<div class="diagnostics-empty">Diagnostics unavailable</div>';
    return;
  }

  panel.innerHTML = '<div class="diagnostics-empty">Loading...</div>';
  window.electronAPI
    .getDiagnostics()
    .then(renderDiagnostics)
    .catch((error) => {
      console.error('Failed to load diagnostics', error);
      panel.innerHTML = '<div class="diagnostics-empty">Diagnostics failed to load</div>';
    });
}

function initBackendSettings() {
  if (window.__settingsBackendInitialized || !window.electronAPI) return;
  window.__settingsBackendInitialized = true;

  if (window.electronAPI.getSettings) {
    window.electronAPI.getSettings()
      .then(applySettingsToForm)
      .catch((error) => console.error('Failed to load settings', error));
  }
  if (window.electronAPI.onSettingsUpdated) {
    window.electronAPI.onSettingsUpdated(applySettingsToForm);
  }
  loadDiagnostics();
}

function initSettings() {
  if (window.__settingsInitialized) return;
  window.__settingsInitialized = true;
  window.__settingsReady = true;
  document.documentElement.dataset.settingsReady = 'true';

  initSwatches();
  applySettingsToForm(DEFAULT_SETTINGS);

  const close = () => {
    if (window.electronAPI?.closeSettings) {
      window.electronAPI.closeSettings().catch(() => window.close());
    } else {
      window.close();
    }
  };

  $('close-btn').addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  initBackendSettings();

  for (const checkbox of document.querySelectorAll('input[type="checkbox"]')) {
    checkbox.addEventListener('change', () => saveCurrentSettings('toggle'));
  }

  $('accentColor').addEventListener('input', () => {
    setAccent($('accentColor').value);
    saveCurrentSettings('accent');
  });
  $('opacity').addEventListener('input', () => {
    $('opacityVal').innerText = `${$('opacity').value}%`;
    saveCurrentSettings('opacity');
  });
  $('refreshDiagnostics').addEventListener('click', loadDiagnostics);

  $('layout-vertical').dataset.mode = 'vertical';
  $('layout-horizontal').dataset.mode = 'horizontal';

  $('layout-vertical').addEventListener('click', () => {
    setLayoutActive('vertical');
    window.electronAPI?.snapLayout?.('vertical')
      .catch((error) => console.error('Failed to change layout', error));
  });
  $('layout-horizontal').addEventListener('click', () => {
    setLayoutActive('horizontal');
    window.electronAPI?.snapLayout?.('horizontal')
      .catch((error) => console.error('Failed to change layout', error));
  });
}

initSettings();
window.addEventListener('tauri-api-ready', initBackendSettings, { once: true });
