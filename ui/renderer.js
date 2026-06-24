let currentAccentColor = '#a8c7fa';
let currentSettings = { layoutMode: 'horizontal', accentColor: currentAccentColor };
let lastTrayFingerprint = '';

const $ = (id) => document.getElementById(id);
const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, Number(value) || 0));
const formatPercent = (value) => `${clamp(value).toFixed(Number(value) % 1 ? 1 : 0)}%`;
const formatTemp = (value) => `${Math.round(Number(value) || 0)} C`;
const formatFan = (value) => `${Math.round(Number(value) || 0)} RPM`;

function setText(id, value) {
  const element = $(id);
  if (element) element.innerText = value;
}

function setBar(id, value) {
  const element = $(id);
  if (element) element.style.width = `${clamp(value)}%`;
}

function setRowVisible(id, visible) {
  const element = $(id);
  const row = element?.closest('.data-row');
  if (row) row.classList.toggle('is-hidden', !visible);
}

function setSectionVisible(selector, visible) {
  const section = document.querySelector(selector);
  if (section) section.classList.toggle('is-hidden', !visible);
}

function hasMetric(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function applySettings(settings = {}) {
  currentSettings = { ...currentSettings, ...settings };
  currentAccentColor = currentSettings.accentColor || currentAccentColor;
  document.documentElement.style.setProperty('--accent-color', currentAccentColor);
  document.documentElement.style.setProperty('--accent-soft', `${currentAccentColor}24`);
  document.documentElement.style.setProperty('--accent-soft-strong', `${currentAccentColor}44`);
  document.documentElement.style.setProperty('--widget-bg-alpha', `${(currentSettings.opacity ?? 90) / 100}`);
  updateLayout();
  requestAnimationFrame(adjustWidgetHeightForContent);
  generateMainTrayIcon();
}

function updateLayout() {
  const mode = currentSettings.layoutMode === 'vertical' ? 'vertical' : 'horizontal';
  document.documentElement.dataset.layout = mode;
  document.documentElement.dataset.compact = 'false';
}

function adjustWidgetHeightForContent() {
  if (document.documentElement.dataset.layout !== 'horizontal' || !window.electronAPI.adjustWidgetHeight) {
    return;
  }
  const rowCounts = [...document.querySelectorAll('.hardware-section:not(.is-hidden)')]
    .map((section) => section.querySelectorAll('.data-row:not(.is-hidden)').length);
  const maxRows = Math.max(0, ...rowCounts);
  const desiredHeight = Math.max(140, 50 + maxRows * 22);
  window.electronAPI.adjustWidgetHeight(desiredHeight).catch(() => {});
}

function updateHardware(data) {
  if (data.settings) applySettings(data.settings);

  if (data.cpu) {
    setText('cpu-name', data.cpu.name || 'CPU');
    const hasCpuTemp = data.cpu.tempAvailable === true && hasMetric(data.cpu.temp) && Number(data.cpu.temp) > 0;
    const hasCpuFan = data.cpu.fanAvailable === true && hasMetric(data.cpu.fan) && Number(data.cpu.fan) > 0;
    setRowVisible('cpu-temp', hasCpuTemp);
    setRowVisible('cpu-fan', hasCpuFan);
    if (hasCpuTemp) setText('cpu-temp', formatTemp(data.cpu.temp));
    if (hasCpuFan) setText('cpu-fan', formatFan(data.cpu.fan));
    setText('cpu-load-val', formatPercent(data.cpu.load));
    setBar('cpu-load-bar', data.cpu.load);
  }

  if (data.ram) {
    setText('ram-val', formatPercent(data.ram.percent));
    setBar('ram-load-bar', data.ram.percent);
  }

  if (data.gpu) {
    setText('gpu-name', data.gpu.name || 'GPU');
    const hasGpuPower = data.gpu.powerAvailable === true && hasMetric(data.gpu.power);
    const hasGpuTemp = data.gpu.tempAvailable === true && hasMetric(data.gpu.temp) && Number(data.gpu.temp) > 0;
    const hasGpuLoad = data.gpu.loadAvailable === true && hasMetric(data.gpu.load);
    const hasVram = data.gpu.vramAvailable === true && hasMetric(data.gpu.vramUsed) && hasMetric(data.gpu.vramTotal);
    const hasFan = data.gpu.fanAvailable === true && hasMetric(data.gpu.fan);

    setRowVisible('gpu-power', hasGpuPower);
    setRowVisible('gpu-temp', hasGpuTemp);
    setRowVisible('gpu-load-val', hasGpuLoad);
    setRowVisible('gpu-vram-val', hasVram);
    setRowVisible('gpu-fan-val', hasFan);

    if (hasGpuPower) setText('gpu-power', `${Number(data.gpu.power).toFixed(2)} W`);
    if (hasGpuTemp) setText('gpu-temp', formatTemp(data.gpu.temp));
    if (hasGpuLoad) {
      setText('gpu-load-val', formatPercent(data.gpu.load));
      setBar('gpu-load-bar', data.gpu.load);
    }

    const vramUsed = Number(data.gpu.vramUsed || 0);
    const vramTotal = Number(data.gpu.vramTotal || 1);
    const vramPercent = clamp((vramUsed / Math.max(vramTotal, 1)) * 100);
    if (hasVram) {
      setText('gpu-vram-val', `${vramPercent.toFixed(1)}%`);
      setBar('gpu-vram-bar', vramPercent);
    }

    if (hasFan) {
      setText('gpu-fan-val', formatPercent(data.gpu.fan));
      setBar('gpu-fan-bar', data.gpu.fan);
    }
    setSectionVisible('.gpu-section', hasGpuPower || hasGpuTemp || hasGpuLoad || hasVram || hasFan);
    updateTrayIcons(data, vramPercent);
  }

  if (data.network) {
    setText('net-up', `${data.network.tx} KB/s`);
    setText('net-down', `${data.network.rx} KB/s`);
  }

  adjustWidgetHeightForContent();
}

function generateTrayIcon(id, text, color, tooltip) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 32, 32);
  grad.addColorStop(0, '#1e1f20');
  grad.addColorStop(1, '#101113');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(2, 2, 28, 28, 7);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.25;
  ctx.stroke();

  const label = String(text).slice(0, 3);
  ctx.fillStyle = '#f8fafd';
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  let fontSize = label.length > 2 ? 17 : 20;
  do {
    ctx.font = `800 ${fontSize}px Segoe UI, Arial, sans-serif`;
    fontSize -= 1;
  } while (ctx.measureText(label).width > 24 && fontSize > 10);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 16, 16.6);

  window.electronAPI.updateTrayIcon(id, canvas.toDataURL('image/png'), tooltip);
}

function generateMainTrayIcon() {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = currentAccentColor;
  ctx.beginPath();
  ctx.roundRect(2, 2, 28, 28, 7);
  ctx.fill();
  ctx.fillStyle = '#131314';
  ctx.font = '800 13px Segoe UI, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('LM', 16, 16.6);
  window.electronAPI.updateTrayIcon('main', canvas.toDataURL('image/png'), 'Live Monitor');
}

function updateTrayIcons(data, vramPercent) {
  const settings = data.settings || currentSettings;
  const gpu = data.gpu || {};
  const fingerprint = JSON.stringify({
    accent: currentAccentColor,
    temp: Math.round(gpu.temp || 0),
    load: Math.round(gpu.load || 0),
    vram: Math.round(vramPercent),
    power: Math.round(gpu.power || 0),
    settings
  });
  if (fingerprint === lastTrayFingerprint) return;
  lastTrayFingerprint = fingerprint;

  if (settings.showGpuTempTray && gpu.tempAvailable === true && hasMetric(gpu.temp)) {
    generateTrayIcon('gpuTemp', Math.round(gpu.temp || 0), '#f43f5e', `GPU Temp: ${Math.round(gpu.temp || 0)} C`);
  }
  if (settings.showGpuLoadTray && gpu.loadAvailable === true && hasMetric(gpu.load)) {
    generateTrayIcon('gpuLoad', Math.round(gpu.load || 0), currentAccentColor, `GPU Load: ${Math.round(gpu.load || 0)}%`);
  }
  if (settings.showVramTray && gpu.vramAvailable === true && hasMetric(gpu.vramUsed) && hasMetric(gpu.vramTotal)) {
    generateTrayIcon('vram', Math.round(vramPercent), '#a78bfa', `GPU VRAM: ${vramPercent.toFixed(1)}%`);
  }
  if (settings.showGpuPowerTray && gpu.powerAvailable === true && hasMetric(gpu.power)) {
    generateTrayIcon('gpuPower', Math.round(gpu.power || 0), '#f59e0b', `GPU Power: ${Number(gpu.power || 0).toFixed(2)} W`);
  }
}

function initRenderer() {
  window.electronAPI.getSettings().then(applySettings).catch(() => {});
  window.electronAPI.onSettingsUpdated(applySettings);
  window.electronAPI.onHardwareData(updateHardware);
  requestAnimationFrame(() => {
    window.electronAPI.notifyMainReady?.().catch((error) => console.error('Failed to show main window', error));
  });

  let isDragging = false;
  let didDrag = false;
  let suppressDragUntil = 0;
  let dragOffset = { x: 0, y: 0 };

  document.body.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    isDragging = false;
    didDrag = false;
    suppressDragUntil = Date.now() + 350;
    window.setTimeout(() => {
      const openFromWidget = window.electronAPI.requestOpenSettingsFromWidget || window.electronAPI.openSettings;
      openFromWidget().catch((error) => console.error('Failed to open settings', error));
    }, 80);
  });
  document.body.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    isDragging = false;
    window.electronAPI.showContextMenu();
  });

  document.addEventListener('mousedown', (event) => {
    if (
      event.button === 0 &&
      event.detail < 2 &&
      Date.now() > suppressDragUntil &&
      !currentSettings.lockPosition &&
      !event.target.closest('button,input,select,textarea')
    ) {
      isDragging = true;
      didDrag = false;
      dragOffset = { x: event.clientX, y: event.clientY };
    }
  });
  document.addEventListener('mousemove', (event) => {
    if (isDragging && !currentSettings.lockPosition) {
      didDrag = true;
      window.electronAPI.moveWindowTo(event.screenX - dragOffset.x, event.screenY - dragOffset.y);
    }
  });
  document.addEventListener('mouseup', () => {
    isDragging = false;
    if (didDrag) suppressDragUntil = Date.now() + 180;
  });
}

if (window.electronAPI) {
  initRenderer();
} else {
  window.addEventListener('tauri-api-ready', initRenderer, { once: true });
}
