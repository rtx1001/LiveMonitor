# Live Monitor

Live Monitor is a lightweight Windows desktop hardware monitor widget built with Tauri.

It shows CPU, RAM, GPU, VRAM, fan, power, and network information in a compact transparent widget with horizontal and vertical layouts.

## Features

- Compact transparent always-on-desktop widget
- Horizontal and vertical layouts with saved positions per layout
- Lock Position option in the tray right-click menu
- Always On Top on/off controls
- GPU tray icons for temperature, load, VRAM, and power
- Adaptive CPU/GPU names for different PCs
- Settings window with accent color, opacity, tray icon, and layout controls

## Requirements

- Windows 10 or Windows 11
- Microsoft WebView2 Runtime
- CPU temperature/fan readings require LibreHardwareMonitor or OpenHardwareMonitor sensor data
- NVIDIA GPU metrics use NVML or `nvidia-smi` when available
- Non-NVIDIA GPU names fall back to Windows `Win32_VideoController`

Most Windows 10/11 systems already include WebView2. If a target machine does not, install the Microsoft Edge WebView2 Runtime.

## Download / Test Build

The portable test build is generated at:

```text
dist/Live_Monitor_v1.0_Portable.exe
```

For GitHub, prefer uploading the `.exe` as a Release asset instead of committing it to the repository.

## Development

Install dependencies:

```powershell
npm install
```

Run in development:

```powershell
npm run dev
```

Build the portable release executable:

```powershell
npm run build:release
```

The release binary is produced at:

```text
src-tauri/target/release/app.exe
```

You can copy/rename it to:

```text
dist/Live_Monitor_v1.0_Portable.exe
```

## Version

Current version: `1.0.0`

The settings title bar displays `Settings - Live Monitor v1.0`.

## License

ISC
