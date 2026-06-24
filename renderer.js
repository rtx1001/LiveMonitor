let currentAccentColor = '#38bdf8';

window.electronAPI.onHardwareData((data) => {
  if (data.settings && data.settings.accentColor) {
    if (currentAccentColor !== data.settings.accentColor) {
      currentAccentColor = data.settings.accentColor;
      document.documentElement.style.setProperty('--accent-color', currentAccentColor);
      generateMainTrayIcon();
    }
  }

  // Update CPU
  if (data.cpu) {
    if (data.cpu.name) document.getElementById('cpu-name').innerText = data.cpu.name;
    document.getElementById('cpu-temp').innerText = `${data.cpu.temp}°C`;
    document.getElementById('cpu-load-val').innerText = `${data.cpu.load}%`;
    document.getElementById('cpu-load-bar').style.width = `${data.cpu.load}%`;
    

  }

  // Update RAM
  if (data.ram) {
    document.getElementById('ram-val').innerText = `${data.ram.used} / ${data.ram.total} GB`;
    document.getElementById('ram-load-bar').style.width = `${data.ram.percent}%`;
  }

  // Update GPU
  if (data.gpu) {
    if (data.gpu.name) document.getElementById('gpu-name').innerText = data.gpu.name;
    document.getElementById('gpu-power').innerText = `${data.gpu.power || 0} W`;
    document.getElementById('gpu-temp').innerText = `${data.gpu.temp || 0} °C`;
    
    const load = data.gpu.load || 0;
    document.getElementById('gpu-load-val').innerText = `${load}%`;
    document.getElementById('gpu-load-bar').style.width = `${load}%`;

    const vramUsed = data.gpu.vramUsed || 0;
    const vramTotal = data.gpu.vramTotal || 1;
    const vramPercent = ((vramUsed / vramTotal) * 100).toFixed(1);
    document.getElementById('gpu-vram-val').innerText = `${vramPercent}%`;
    document.getElementById('gpu-vram-bar').style.width = `${vramPercent}%`;

    const fan = data.gpu.fan || 0;
    document.getElementById('gpu-fan-val').innerText = `${fan}%`;
    document.getElementById('gpu-fan-bar').style.width = `${fan}%`;

    // Generate Dynamic Tray Icons
    if (data.settings) {
      if (data.settings.showGpuTempTray) {
        generateTrayIcon('gpuTemp', `${data.gpu.temp || 0}`, '#f43f5e', `GPU Temp: ${data.gpu.temp}°C`);
      }
      if (data.settings.showGpuLoadTray) {
        generateTrayIcon('gpuLoad', `${load}`, currentAccentColor, `GPU Load: ${load}%`);
      }
      if (data.settings.showVramTray) {
        generateTrayIcon('vram', `${Math.round(vramPercent)}`, '#a78bfa', `VRAM: ${vramPercent}%`);
      }
      if (data.settings.showGpuPowerTray) {
        generateTrayIcon('gpuPower', `${Math.round(data.gpu.power || 0)}`, '#f97316', `GPU Power: ${data.gpu.power || 0} W`);
      }
    }
  }

  // Update Network
  if (data.network) {
    document.getElementById('net-up').innerText = `${data.network.tx} KB/s`;
    document.getElementById('net-down').innerText = `${data.network.rx} KB/s`;
  }
});

function generateTrayIcon(id, text, color, tooltip) {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  
  // Cool Gradient Background
  const grad = ctx.createLinearGradient(0, 0, 16, 16);
  grad.addColorStop(0, '#1e293b');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(0, 0, 16, 16, 4);
  ctx.fill();
  
  // Neon Border
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Text with Glow
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = color;
  ctx.shadowBlur = 4;
  
  let fontSize = 9;
  let shortText = text.toString();
  
  // Clean up long texts (e.g. 100 or 350)
  if (shortText.length > 2) {
    fontSize = 7;
  }
  if (shortText.length > 3) {
    shortText = shortText.substring(0, 3);
  }
  
  ctx.font = `bold ${fontSize}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  ctx.fillText(shortText, 8, 8);
  
  const dataUrl = canvas.toDataURL('image/png');
  window.electronAPI.updateTrayIcon(id, dataUrl, tooltip);
}

// Generate Main App Icon on start
function generateMainTrayIcon() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  
  const grad = ctx.createLinearGradient(0, 0, 16, 16);
  grad.addColorStop(0, currentAccentColor);
  grad.addColorStop(1, currentAccentColor);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(1, 1, 14, 14, 3);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('LM', 8, 8);

  const dataUrl = canvas.toDataURL('image/png');
  window.electronAPI.updateTrayIcon('main', dataUrl, 'Live Monitor');
}
generateMainTrayIcon();

// Interactions
document.body.addEventListener('dblclick', () => {
  window.electronAPI.openSettings();
});

document.body.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.electronAPI.showContextMenu();
});

// Custom Dragging Logic to replace -webkit-app-region: drag
let isDragging = false;
let dragOffset = { x: 0, y: 0 };

document.addEventListener('mousedown', (e) => {
  // Only drag on left click and ignore inputs/buttons
  if (e.button === 0 && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
    isDragging = true;
    dragOffset = { x: e.clientX, y: e.clientY };
  }
});

document.addEventListener('mousemove', (e) => {
  if (isDragging) {
    window.electronAPI.moveWindowTo(e.screenX - dragOffset.x, e.screenY - dragOffset.y);
  }
});

document.addEventListener('mouseup', () => {
  isDragging = false;
});
