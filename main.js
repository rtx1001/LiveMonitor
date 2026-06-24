const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const si = require('systeminformation');

let mainWindow;
let settingsWindow;
let mainTray = null;
let dynamicTrays = {};
let hardwareInterval = null;
let isQuitting = false;

const DEFAULT_SETTINGS = {
  autoStart: false,
  showMainTray: true,
  showGpuTempTray: false,
  showGpuLoadTray: false,
  showVramTray: false,
  showGpuPowerTray: false,
  opacity: 90,
  accentColor: '#a8c7fa',
  layoutMode: 'auto',
  windowBounds: null
};

const settingsPath = path.join(app.getPath('userData'), 'config.json');
let settings = { ...DEFAULT_SETTINGS };

function normalizeSettings(value = {}) {
  const next = { ...DEFAULT_SETTINGS, ...value };
  next.opacity = Math.min(100, Math.max(20, Number(next.opacity) || DEFAULT_SETTINGS.opacity));
  next.accentColor = /^#[0-9a-f]{6}$/i.test(next.accentColor) ? next.accentColor : DEFAULT_SETTINGS.accentColor;
  next.layoutMode = ['auto', 'vertical', 'horizontal'].includes(next.layoutMode) ? next.layoutMode : 'auto';
  return next;
}

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      settings = normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    }
  } catch (error) {
    console.error('Error loading settings:', error);
    settings = { ...DEFAULT_SETTINGS };
  }
}

function persistSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving settings:', error);
  }
}

function applyStartupSetting() {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.autoStart),
      path: app.getPath('exe')
    });
  } catch (error) {
    console.error('Error applying startup setting:', error);
  }
}

function broadcastSettings() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('settings-updated', settings);
  }
}

function saveSettings(newSettings) {
  settings = normalizeSettings({ ...settings, ...newSettings });
  persistSettings();
  applyStartupSetting();
  updateTraysVisibility();

  if (mainWindow) {
    mainWindow.setOpacity(settings.opacity / 100);
  }

  broadcastSettings();
}

function boundsForLayout(mode) {
  if (mode === 'vertical') return { width: 276, height: 450 };
  if (mode === 'horizontal') return { width: 860, height: 140 };
  return { width: 860, height: 140 };
}

function createWindow() {
  const fallbackBounds = boundsForLayout(settings.layoutMode);
  const bounds = { ...fallbackBounds, ...(settings.windowBounds || {}) };

  if (bounds.x === undefined || bounds.y === undefined) {
    const { workArea } = screen.getPrimaryDisplay();
    bounds.x = workArea.x + workArea.width - bounds.width - 16;
    bounds.y = workArea.y + workArea.height - bounds.height - 16;
  }

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 220,
    minHeight: 118,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setOpacity(settings.opacity / 100);
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  let boundsTimeout = null;
  const saveBounds = () => {
    clearTimeout(boundsTimeout);
    boundsTimeout = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        settings = normalizeSettings({ ...settings, windowBounds: mainWindow.getBounds() });
        persistSettings();
      }
    }, 700);
  };

  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 392,
    height: 560,
    minWidth: 360,
    minHeight: 500,
    autoHideMenuBar: true,
    backgroundColor: '#131314',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function snapLayout(mode) {
  if (!mainWindow) return;
  const size = boundsForLayout(mode);
  mainWindow.setSize(size.width, size.height);
  saveSettings({ layoutMode: mode, windowBounds: mainWindow.getBounds() });
}

function showOrCreateMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showOrCreateMainWindow();
  }
}

function createSolidIcon(label, fill = settings.accentColor, text = '#131314') {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="${fill}"/>
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="none" stroke="rgba(255,255,255,.25)"/>
      <text x="16" y="20.5" text-anchor="middle" font-family="Segoe UI, Arial" font-size="11" font-weight="800" fill="${text}">${label}</text>
    </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function getContextMenu() {
  const visible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  return Menu.buildFromTemplate([
    { label: 'Settings', click: openSettings },
    { type: 'separator' },
    {
      label: 'Layout',
      submenu: [
        { label: 'Auto Scale', type: 'radio', checked: settings.layoutMode === 'auto', click: () => saveSettings({ layoutMode: 'auto' }) },
        { label: 'Snap Vertical', type: 'radio', checked: settings.layoutMode === 'vertical', click: () => snapLayout('vertical') },
        { label: 'Snap Horizontal', type: 'radio', checked: settings.layoutMode === 'horizontal', click: () => snapLayout('horizontal') }
      ]
    },
    { type: 'separator' },
    { label: visible ? 'Hide Gadget' : 'Show Gadget', click: toggleMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
}

function applyContextMenuToTrays() {
  const menu = getContextMenu();
  if (mainTray) mainTray.setContextMenu(menu);
  Object.values(dynamicTrays).forEach((tray) => tray.setContextMenu(menu));
}

function updateTraysVisibility() {
  if (settings.showMainTray && !mainTray) {
    mainTray = new Tray(createSolidIcon('LM'));
    mainTray.setToolTip('Live Monitor');
    mainTray.on('click', toggleMainWindow);
    mainTray.on('double-click', openSettings);
  } else if (!settings.showMainTray && mainTray) {
    mainTray.destroy();
    mainTray = null;
  }

  const manageDynamicTray = (id, label, show) => {
    if (show && !dynamicTrays[id]) {
      dynamicTrays[id] = new Tray(createSolidIcon(label, '#1e1f20', '#e3e3e3'));
      dynamicTrays[id].setToolTip(label);
      dynamicTrays[id].on('click', toggleMainWindow);
      dynamicTrays[id].on('double-click', openSettings);
    } else if (!show && dynamicTrays[id]) {
      dynamicTrays[id].destroy();
      delete dynamicTrays[id];
    }
  };

  manageDynamicTray('gpuTemp', '43', settings.showGpuTempTray);
  manageDynamicTray('gpuLoad', '7', settings.showGpuLoadTray);
  manageDynamicTray('vram', '96', settings.showVramTray);
  manageDynamicTray('gpuPower', '29', settings.showGpuPowerTray);
  applyContextMenuToTrays();
}

ipcMain.handle('get-settings', () => settings);
ipcMain.on('save-settings', (_event, newSettings) => saveSettings(newSettings));
ipcMain.on('open-settings', openSettings);
ipcMain.on('snap-layout', (_event, mode) => snapLayout(mode));
ipcMain.on('show-context-menu', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  getContextMenu().popup({ window: win || undefined });
});
ipcMain.on('move-window-to', (event, x, y) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setPosition(Math.round(x), Math.round(y));
});
ipcMain.on('update-tray-icon', (_event, id, dataUrl, tooltip) => {
  const image = nativeImage.createFromDataURL(dataUrl);
  if (id === 'main' && mainTray) {
    mainTray.setImage(image);
    if (tooltip) mainTray.setToolTip(tooltip);
  } else if (dynamicTrays[id]) {
    dynamicTrays[id].setImage(image);
    if (tooltip) dynamicTrays[id].setToolTip(tooltip);
  }
});

let gpuData = { name: 'GPU', power: 0, temp: 0, load: 0, vramUsed: 0, vramTotal: 1, fan: 0 };
let nmiProcess = null;
let nmiBuffer = '';
let cpuName = 'CPU';

function cleanCpuName(data) {
  return `${data.manufacturer || ''} ${data.brand || ''}`
    .replace(/Intel\(R\)\s*Core\(TM\)\s*/i, 'Intel Core ')
    .replace(/\s+CPU\s+/i, ' ')
    .replace(/\s+@.+$/, '')
    .replace(/\s+/g, ' ')
    .trim() || 'CPU';
}

function parseNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function startNvidiaSmi() {
  if (nmiProcess) return;
  nmiProcess = spawn('nvidia-smi', [
    '--query-gpu=name,power.draw,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed',
    '--format=csv,noheader,nounits',
    '-l',
    '2'
  ], { windowsHide: true });

  nmiProcess.stdout.on('data', (data) => {
    nmiBuffer += data.toString();
    const lines = nmiBuffer.split(/\r?\n/);
    nmiBuffer = lines.pop() || '';
    for (const line of lines) {
      const parts = line.split(',').map((part) => part.trim());
      if (parts.length < 7) continue;
      gpuData = {
        name: parts[0].replace(/^NVIDIA\s+(GeForce\s+)?/i, '').trim() || 'GPU',
        power: parseNumber(parts[1]),
        temp: parseNumber(parts[2]),
        load: parseNumber(parts[3]),
        vramUsed: parseNumber(parts[4]),
        vramTotal: parseNumber(parts[5], 1),
        fan: parseNumber(parts[6])
      };
    }
  });

  nmiProcess.on('error', () => {
    nmiProcess = null;
    gpuData = { name: 'GPU unavailable', power: 0, temp: 0, load: 0, vramUsed: 0, vramTotal: 1, fan: 0 };
  });
  nmiProcess.on('close', () => {
    nmiProcess = null;
  });
}

async function primeHardwareNames() {
  try {
    cpuName = cleanCpuName(await si.cpu());
  } catch (error) {
    console.error('CPU detection error:', error);
  }
}

async function fetchHardwareData() {
  try {
    const [cpuLoad, cpuTemp, mem, netStats] = await Promise.all([
      si.currentLoad(),
      si.cpuTemperature(),
      si.mem(),
      si.networkStats()
    ]);

    const net = Array.isArray(netStats) ? netStats : [];
    const tx = net.reduce((sum, item) => sum + Math.max(0, item.tx_sec || 0), 0);
    const rx = net.reduce((sum, item) => sum + Math.max(0, item.rx_sec || 0), 0);

    const hardwareData = {
      cpu: {
        name: cpuName,
        load: Number(cpuLoad.currentLoad || 0).toFixed(1),
        temp: Number(cpuTemp.main || cpuTemp.max || 0)
      },
      ram: {
        used: (mem.active / (1024 ** 3)).toFixed(1),
        total: (mem.total / (1024 ** 3)).toFixed(1),
        percent: ((mem.active / mem.total) * 100).toFixed(1)
      },
      gpu: gpuData,
      network: {
        tx: (tx / 1024).toFixed(1),
        rx: (rx / 1024).toFixed(1)
      },
      settings
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hardware-data', hardwareData);
    }
  } catch (error) {
    console.error('Error fetching hardware data:', error);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showOrCreateMainWindow);

  app.whenReady().then(async () => {
    loadSettings();
    applyStartupSetting();
    createWindow();
    updateTraysVisibility();
    await primeHardwareNames();
    startNvidiaSmi();
    hardwareInterval = setInterval(fetchHardwareData, 2000);
    fetchHardwareData();

    app.on('activate', showOrCreateMainWindow);
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('will-quit', () => {
  if (hardwareInterval) clearInterval(hardwareInterval);
  if (nmiProcess) nmiProcess.kill();
});
