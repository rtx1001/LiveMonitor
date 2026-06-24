#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    ffi::c_void,
    path::PathBuf,
    process::Command,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use base64::Engine;
use libloading::Library;
use serde::{Deserialize, Serialize};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, Networks, RefreshKind, System};
use tauri::{
    image::Image,
    menu::{ContextMenu, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

static HOST_SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();
static NVML_STATE: OnceLock<Mutex<Option<NvmlApi>>> = OnceLock::new();
static CPU_SENSOR_STATE: OnceLock<Mutex<Option<(Instant, CpuSensorMetrics)>>> = OnceLock::new();
static NVIDIA_SMI_FAN_STATE: OnceLock<Mutex<Option<(Instant, Option<f64>)>>> = OnceLock::new();

type NvmlReturn = u32;
type NvmlDevice = *mut c_void;

const NVML_SUCCESS: NvmlReturn = 0;
const NVML_TEMPERATURE_GPU: u32 = 0;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct NvmlMemory {
    total: u64,
    free: u64,
    used: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct NvmlUtilization {
    gpu: u32,
    memory: u32,
}

struct NvmlApi {
    _library: Library,
    device: NvmlDevice,
    device_get_memory_info: unsafe extern "C" fn(NvmlDevice, *mut NvmlMemory) -> NvmlReturn,
    device_get_temperature: unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> NvmlReturn,
    device_get_utilization_rates:
        Option<unsafe extern "C" fn(NvmlDevice, *mut NvmlUtilization) -> NvmlReturn>,
    device_get_fan_speed: Option<unsafe extern "C" fn(NvmlDevice, *mut u32) -> NvmlReturn>,
    device_get_fan_speed_v2:
        Option<unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> NvmlReturn>,
    device_get_power_usage: Option<unsafe extern "C" fn(NvmlDevice, *mut u32) -> NvmlReturn>,
}

unsafe impl Send for NvmlApi {}

#[derive(Clone, Copy, Default)]
struct GpuMemoryMetrics {
    available: bool,
    used_mb: u32,
    total_mb: u32,
    temperature_c: Option<u8>,
    power_w: Option<f64>,
    load_percent: Option<f64>,
    fan_percent: Option<f64>,
}

#[derive(Clone, Copy, Default)]
struct CpuSensorMetrics {
    temperature_c: Option<f64>,
    fan_rpm: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    auto_start: bool,
    #[serde(default)]
    always_on_top: bool,
    #[serde(default)]
    lock_position: bool,
    #[serde(default = "default_true")]
    show_main_tray: bool,
    #[serde(default)]
    show_gpu_temp_tray: bool,
    #[serde(default)]
    show_gpu_load_tray: bool,
    #[serde(default)]
    show_vram_tray: bool,
    #[serde(default)]
    show_gpu_power_tray: bool,
    #[serde(default = "default_opacity")]
    opacity: u8,
    #[serde(default = "default_accent")]
    accent_color: String,
    #[serde(default = "default_layout")]
    layout_mode: String,
    #[serde(default)]
    window_bounds: Option<WindowBounds>,
    #[serde(default)]
    horizontal_window_bounds: Option<WindowBounds>,
    #[serde(default)]
    vertical_window_bounds: Option<WindowBounds>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_start: false,
            always_on_top: false,
            lock_position: false,
            show_main_tray: true,
            show_gpu_temp_tray: false,
            show_gpu_load_tray: false,
            show_vram_tray: false,
            show_gpu_power_tray: false,
            opacity: 90,
            accent_color: default_accent(),
            layout_mode: default_layout(),
            window_bounds: None,
            horizontal_window_bounds: None,
            vertical_window_bounds: None,
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_opacity() -> u8 {
    90
}

fn default_accent() -> String {
    "#a8c7fa".to_string()
}

fn default_layout() -> String {
    "horizontal".to_string()
}

struct AppState {
    settings: Mutex<Settings>,
    config_path: PathBuf,
    identity: Mutex<HardwareIdentity>,
}

#[derive(Clone, Debug)]
struct HardwareIdentity {
    cpu_name: String,
    gpu_name: String,
    gpu_total_mb: u32,
}

fn normalize_settings(mut settings: Settings) -> Settings {
    settings.opacity = settings.opacity.clamp(20, 100);
    if !settings.accent_color.starts_with('#') || settings.accent_color.len() != 7 {
        settings.accent_color = default_accent();
    }
    if !matches!(settings.layout_mode.as_str(), "vertical" | "horizontal") {
        settings.layout_mode = default_layout();
    }
    settings
}

fn shorten_cpu_name(name: &str) -> String {
    let mut value = name
        .replace("(R)", "")
        .replace("(TM)", "")
        .replace("Intel Core ", "Core ")
        .replace("Intel ", "")
        .replace("AMD Ryzen ", "Ryzen ")
        .replace("AMD ", "")
        .replace(" CPU", "")
        .replace(" Processor", "");
    for suffix in [" @ ", " with ", ","] {
        if let Some((head, _)) = value.split_once(suffix) {
            value = head.to_string();
        }
    }
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl AppState {
    fn load(config_path: PathBuf) -> Self {
        let settings = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
            .map(normalize_settings)
            .unwrap_or_default();

        Self {
            settings: Mutex::new(settings),
            config_path,
            identity: Mutex::new(detect_hardware_identity()),
        }
    }

    fn save(&self) {
        if let Ok(settings) = self.settings.lock() {
            if let Ok(json) = serde_json::to_string_pretty(&*settings) {
                let _ = std::fs::write(&self.config_path, json);
            }
        }
    }
}

fn nvml_library_candidates() -> &'static [&'static str] {
    &[
        "nvml.dll",
        "C:\\Windows\\System32\\nvml.dll",
        "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvml.dll",
    ]
}

unsafe fn load_symbol<T>(library: &Library, names: &[&[u8]]) -> Result<T, String>
where
    T: Copy,
{
    for name in names {
        if let Ok(symbol) = library.get::<T>(name) {
            return Ok(*symbol);
        }
    }
    Err("Required NVML symbol is unavailable.".to_string())
}

fn load_nvml_api() -> Result<NvmlApi, String> {
    for candidate in nvml_library_candidates() {
        let library = match unsafe { Library::new(candidate) } {
            Ok(library) => library,
            Err(_) => continue,
        };

        let api = unsafe {
            let init: unsafe extern "C" fn() -> NvmlReturn =
                load_symbol(&library, &[b"nvmlInit_v2\0", b"nvmlInit\0"])?;
            if init() != NVML_SUCCESS {
                continue;
            }

            let device_get_handle_by_index: unsafe extern "C" fn(
                u32,
                *mut NvmlDevice,
            ) -> NvmlReturn = load_symbol(
                &library,
                &[
                    b"nvmlDeviceGetHandleByIndex_v2\0",
                    b"nvmlDeviceGetHandleByIndex\0",
                ],
            )?;
            let device_get_memory_info: unsafe extern "C" fn(
                NvmlDevice,
                *mut NvmlMemory,
            ) -> NvmlReturn = load_symbol(&library, &[b"nvmlDeviceGetMemoryInfo\0"])?;
            let device_get_temperature: unsafe extern "C" fn(
                NvmlDevice,
                u32,
                *mut u32,
            ) -> NvmlReturn = load_symbol(&library, &[b"nvmlDeviceGetTemperature\0"])?;
            let device_get_utilization_rates = load_symbol(
                &library,
                &[b"nvmlDeviceGetUtilizationRates\0"],
            )
            .ok();
            let device_get_fan_speed =
                load_symbol(&library, &[b"nvmlDeviceGetFanSpeed\0"]).ok();
            let device_get_fan_speed_v2 =
                load_symbol(&library, &[b"nvmlDeviceGetFanSpeed_v2\0"]).ok();
            let device_get_power_usage =
                load_symbol(&library, &[b"nvmlDeviceGetPowerUsage\0"]).ok();

            let mut device: NvmlDevice = std::ptr::null_mut();
            if device_get_handle_by_index(0, &mut device) != NVML_SUCCESS || device.is_null() {
                continue;
            }

            NvmlApi {
                _library: library,
                device,
                device_get_memory_info,
                device_get_temperature,
                device_get_utilization_rates,
                device_get_fan_speed,
                device_get_fan_speed_v2,
                device_get_power_usage,
            }
        };

        return Ok(api);
    }

    Err("NVML is unavailable.".to_string())
}

fn query_gpu_memory_metrics() -> GpuMemoryMetrics {
    let state = NVML_STATE.get_or_init(|| Mutex::new(load_nvml_api().ok()));
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(_) => return GpuMemoryMetrics::default(),
    };

    if guard.is_none() {
        *guard = load_nvml_api().ok();
    }

    let Some(api) = guard.as_ref() else {
        return GpuMemoryMetrics::default();
    };

    let mut memory = NvmlMemory::default();
    if unsafe { (api.device_get_memory_info)(api.device, &mut memory) } != NVML_SUCCESS
        || memory.total == 0
    {
        return GpuMemoryMetrics::default();
    }

    let mut temperature_raw = 0u32;
    let temperature_c = if unsafe {
        (api.device_get_temperature)(api.device, NVML_TEMPERATURE_GPU, &mut temperature_raw)
    } == NVML_SUCCESS
    {
        Some(temperature_raw.min(110) as u8)
    } else {
        None
    };

    let load_percent = api.device_get_utilization_rates.and_then(|query| {
        let mut utilization = NvmlUtilization::default();
        if unsafe { query(api.device, &mut utilization) } == NVML_SUCCESS {
            Some(utilization.gpu.min(100) as f64)
        } else {
            None
        }
    });
    let fan_percent = api
        .device_get_fan_speed_v2
        .and_then(|query| {
            let mut fan = 0u32;
            if unsafe { query(api.device, 0, &mut fan) } == NVML_SUCCESS {
                Some(fan.min(100) as f64)
            } else {
                None
            }
        })
        .or_else(|| {
            api.device_get_fan_speed.and_then(|query| {
                let mut fan = 0u32;
                if unsafe { query(api.device, &mut fan) } == NVML_SUCCESS {
                    Some(fan.min(100) as f64)
                } else {
                    None
                }
            })
        })
        .or_else(query_nvidia_smi_fan_percent);
    let power_w = api.device_get_power_usage.and_then(|query| {
        let mut milliwatts = 0u32;
        if unsafe { query(api.device, &mut milliwatts) } == NVML_SUCCESS {
            Some(milliwatts as f64 / 1000.0)
        } else {
            None
        }
    });

    GpuMemoryMetrics {
        available: true,
        used_mb: (memory.used / 1024 / 1024) as u32,
        total_mb: (memory.total / 1024 / 1024) as u32,
        temperature_c,
        power_w,
        load_percent,
        fan_percent,
    }
}

#[cfg(target_os = "windows")]
fn query_nvidia_smi_fan_percent() -> Option<f64> {
    let cache = NVIDIA_SMI_FAN_STATE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cache.lock() {
        if let Some((last_update, value)) = *guard {
            if last_update.elapsed() < Duration::from_secs(5) {
                return value;
            }
        }

        let output = hidden_command("nvidia-smi")
            .args([
                "--query-gpu=fan.speed",
                "--format=csv,noheader,nounits",
            ])
            .output();

        let value = output
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .and_then(|line| line.trim().parse::<f64>().ok())
            })
            .filter(|value| (0.0..=100.0).contains(value));

        *guard = Some((Instant::now(), value));
        return value;
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn query_nvidia_smi_fan_percent() -> Option<f64> {
    None
}

fn query_host_metrics(system: &mut System) -> (u64, u64, f32) {
    system.refresh_memory();
    system.refresh_cpu();
    (
        system.available_memory(),
        system.total_memory(),
        system.global_cpu_info().cpu_usage(),
    )
}

fn query_cpu_sensor_metrics() -> CpuSensorMetrics {
    let cache = CPU_SENSOR_STATE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cache.lock() {
        if let Some((last_update, metrics)) = *guard {
            if last_update.elapsed() < Duration::from_secs(5) {
                return metrics;
            }
        }
        let metrics = query_cpu_sensor_metrics_uncached();
        *guard = Some((Instant::now(), metrics));
        return metrics;
    }
    query_cpu_sensor_metrics_uncached()
}

#[cfg(target_os = "windows")]
fn query_cpu_sensor_metrics_uncached() -> CpuSensorMetrics {
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$temp = $null
$fan = $null
foreach ($ns in @('root\LibreHardwareMonitor','root\OpenHardwareMonitor')) {
  $sensors = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction SilentlyContinue
  if ($sensors) {
    $temp = $sensors |
      Where-Object { $_.SensorType -eq 'Temperature' -and (($_.Name -match 'CPU|Package|Core|Tctl|Tdie') -or ($_.HardwareType -match 'CPU')) } |
      Sort-Object @{ Expression = { if ($_.Name -match 'Package|Tctl|Tdie') { 0 } else { 1 } } } |
      Select-Object -First 1 -ExpandProperty Value
    $fan = $sensors |
      Where-Object { $_.SensorType -eq 'Fan' -and (($_.Name -match 'CPU|Processor') -or ($_.HardwareType -match 'CPU')) } |
      Select-Object -First 1 -ExpandProperty Value
    if ($temp -or $fan) { break }
  }
}
Write-Output "$temp|$fan"
"#;

    let output = hidden_command("powershell.exe")
        .args([
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output();

    let Ok(output) = output else {
        return CpuSensorMetrics::default();
    };
    if !output.status.success() {
        return CpuSensorMetrics::default();
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.trim().split('|');
    let temperature_c = parts
        .next()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| (1.0..=125.0).contains(value));
    let fan_rpm = parts
        .next()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| (50.0..=10000.0).contains(value));

    CpuSensorMetrics {
        temperature_c,
        fan_rpm,
    }
}

#[cfg(not(target_os = "windows"))]
fn query_cpu_sensor_metrics_uncached() -> CpuSensorMetrics {
    CpuSensorMetrics::default()
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn detect_hardware_identity() -> HardwareIdentity {
    let mut system = System::new_all();
    system.refresh_cpu();

    let cpu_name = system
        .cpus()
        .first()
        .map(|cpu| shorten_cpu_name(cpu.brand().trim()))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "CPU".to_string());

    let output = hidden_command("nvidia-smi")
        .arg("--query-gpu=name,memory.total")
        .arg("--format=csv,noheader,nounits")
        .output();

    if let Ok(out) = output {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let line = text.lines().next().unwrap_or_default();
            let mut parts = line.split(',').map(str::trim);
            let gpu_name = parts
                .next()
                .unwrap_or("GPU")
                .replace("NVIDIA GeForce ", "")
                .replace("NVIDIA ", "");
            let total = parts
                .next()
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(0);
            return HardwareIdentity {
                cpu_name,
                gpu_name: if gpu_name.is_empty() { "GPU".to_string() } else { gpu_name },
                gpu_total_mb: total,
            };
        }
    }

    let gpu_name = detect_generic_gpu_name().unwrap_or_else(|| "GPU unavailable".to_string());

    HardwareIdentity {
        cpu_name,
        gpu_name,
        gpu_total_mb: 0,
    }
}

fn detect_generic_gpu_name() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let output = hidden_command("powershell")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "(Get-CimInstance Win32_VideoController | Where-Object { $_.Name } | Select-Object -First 1 -ExpandProperty Name)",
            ])
            .output()
            .ok()?;
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let output = hidden_command("system_profiler")
            .arg("SPDisplaysDataType")
            .output()
            .ok()?;
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if let Some(value) = trimmed.strip_prefix("Chipset Model:") {
                    let name = value.trim();
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let output = hidden_command("sh")
            .args([
                "-c",
                "lspci 2>/dev/null | grep -Ei 'vga|3d|display' | head -n 1",
            ])
            .output()
            .ok()?;
        if output.status.success() {
            let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !line.is_empty() {
                return Some(line);
            }
        }
    }

    None
}

fn layout_size(mode: &str) -> (f64, f64) {
    match mode {
        "vertical" => (260.0, 410.0),
        "horizontal" => (877.0, 140.0),
        _ => (877.0, 140.0),
    }
}

fn infer_layout_from_size(width: f64, height: f64, fallback: &str) -> String {
    let (vertical_width, vertical_height) = layout_size("vertical");
    let (horizontal_width, horizontal_height) = layout_size("horizontal");
    let vertical_delta = (width - vertical_width).abs() + (height - vertical_height).abs();
    let horizontal_delta = (width - horizontal_width).abs() + (height - horizontal_height).abs();

    if vertical_delta + 24.0 < horizontal_delta {
        "vertical".to_string()
    } else if horizontal_delta + 24.0 < vertical_delta {
        "horizontal".to_string()
    } else {
        fallback.to_string()
    }
}

fn bounds_for_layout<'a>(settings: &'a Settings, mode: &str) -> Option<&'a WindowBounds> {
    match mode {
        "vertical" => settings
            .vertical_window_bounds
            .as_ref()
            .or(settings.window_bounds.as_ref()),
        "horizontal" => settings
            .horizontal_window_bounds
            .as_ref()
            .or(settings.window_bounds.as_ref()),
        _ => settings.window_bounds.as_ref(),
    }
}

fn set_bounds_for_layout(settings: &mut Settings, mode: &str, bounds: WindowBounds) {
    match mode {
        "vertical" => settings.vertical_window_bounds = Some(bounds),
        "horizontal" => settings.horizontal_window_bounds = Some(bounds),
        _ => settings.window_bounds = Some(bounds),
    }
}

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let (_, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "Invalid data URL.".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| error.to_string())
}

fn placeholder_icon_rgba(color: [u8; 4]) -> Image<'static> {
    let mut rgba = vec![0; 32 * 32 * 4];
    for y in 0..32 {
        for x in 0..32 {
            let inside = (2..30).contains(&x) && (2..30).contains(&y);
            let idx = ((y * 32 + x) * 4) as usize;
            if inside {
                rgba[idx..idx + 4].copy_from_slice(&color);
            }
        }
    }
    Image::new_owned(rgba, 32, 32)
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = MenuItemBuilder::with_id("settings", "Settings").build(app)?;
    let vertical = MenuItemBuilder::with_id("layout_vertical", "Vertical").build(app)?;
    let horizontal = MenuItemBuilder::with_id("layout_horizontal", "Horizontal").build(app)?;
    let layout = Submenu::with_items(app, "Layout", true, &[&vertical, &horizontal])?;
    let always_on_top_on = MenuItemBuilder::with_id("always_on_top_on", "On").build(app)?;
    let always_on_top_off = MenuItemBuilder::with_id("always_on_top_off", "Off").build(app)?;
    let always_on_top = Submenu::with_items(
        app,
        "Always On Top",
        true,
        &[&always_on_top_on, &always_on_top_off],
    )?;
    let lock_position_on = MenuItemBuilder::with_id("lock_position_on", "On").build(app)?;
    let lock_position_off = MenuItemBuilder::with_id("lock_position_off", "Off").build(app)?;
    let lock_position = Submenu::with_items(
        app,
        "Lock Position",
        true,
        &[&lock_position_on, &lock_position_off],
    )?;
    let toggle = MenuItemBuilder::with_id("toggle_gadget", "Show/Hide Gadget").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    Menu::with_items(
        app,
        &[
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &layout,
            &always_on_top,
            &lock_position,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

fn ensure_tray(app: &AppHandle, id: &str, tooltip: &str, show: bool) {
    if show {
        if app.tray_by_id(id).is_none() {
            if let Ok(menu) = build_tray_menu(app) {
                let _ = TrayIconBuilder::with_id(id)
                    .tooltip(tooltip)
                    .icon(placeholder_icon_rgba([30, 31, 32, 255]))
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| {
                        match event {
                            TrayIconEvent::Click {
                                button: MouseButton::Left,
                                ..
                            } => show_main_window(tray.app_handle()),
                            TrayIconEvent::DoubleClick {
                                button: MouseButton::Left,
                                ..
                            } => open_or_focus_settings(tray.app_handle()),
                            _ => {}
                        }
                    })
                    .build(app);
            }
        }
    } else if app.tray_by_id(id).is_some() {
        let _ = app.remove_tray_by_id(id);
    }
}

fn update_trays_visibility(app: &AppHandle) {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    ensure_tray(app, "main", "Live Monitor", settings.show_main_tray);
    ensure_tray(app, "gpuTemp", "GPU Temp", settings.show_gpu_temp_tray);
    ensure_tray(app, "gpuLoad", "GPU Load", settings.show_gpu_load_tray);
    ensure_tray(app, "vram", "GPU VRAM", settings.show_vram_tray);
    ensure_tray(app, "gpuPower", "GPU Power", settings.show_gpu_power_tray);
}

fn apply_autostart(app: &AppHandle, enabled: bool) {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    if let Err(error) = result {
        eprintln!("Failed to apply autostart setting: {error}");
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn apply_always_on_top(app: &AppHandle, enabled: bool) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_always_on_top(enabled);
    }
}

fn open_or_focus_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.eval("if (!window.__settingsReady) { window.location.reload(); }");
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }

    if let Ok(win) = WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("settings.html".into()))
        .title("Settings - Live Monitor v1.0")
        .inner_size(410.0, 560.0)
        .min_inner_size(410.0, 560.0)
        .max_inner_size(410.0, 560.0)
        .resizable(false)
        .visible(true)
        .transparent(false)
        .decorations(true)
        .skip_taskbar(false)
        .center()
        .background_color(tauri::window::Color(19, 19, 20, 255))
        .build()
    {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn apply_window_bounds(window: &WebviewWindow, settings: &Settings) {
    let (width, height) = layout_size(&settings.layout_mode);
    if let Some(bounds) = bounds_for_layout(settings, &settings.layout_mode) {
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
            x: bounds.x as f64,
            y: bounds.y as f64,
        }));
    }
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
}

fn save_window_bounds(window: &WebviewWindow, state: &AppState) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    if let Ok(mut settings) = state.settings.lock() {
        let (width, height) = layout_size(&settings.layout_mode);
        let mode = settings.layout_mode.clone();
        let bounds = WindowBounds {
            x: position.x,
            y: position.y,
            width: width as u32,
            height: height as u32,
        };
        set_bounds_for_layout(&mut settings, &mode, bounds);
    }
    state.save();
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(settings: serde_json::Value, app: AppHandle, state: tauri::State<'_, AppState>) {
    {
        let mut current = state.settings.lock().unwrap();
        if let Some(value) = settings.get("autoStart").and_then(|v| v.as_bool()) {
            current.auto_start = value;
        }
        if let Some(value) = settings.get("alwaysOnTop").and_then(|v| v.as_bool()) {
            current.always_on_top = value;
        }
        if let Some(value) = settings.get("lockPosition").and_then(|v| v.as_bool()) {
            current.lock_position = value;
        }
        if let Some(value) = settings.get("showMainTray").and_then(|v| v.as_bool()) {
            current.show_main_tray = value;
        }
        if let Some(value) = settings.get("showGpuTempTray").and_then(|v| v.as_bool()) {
            current.show_gpu_temp_tray = value;
        }
        if let Some(value) = settings.get("showGpuLoadTray").and_then(|v| v.as_bool()) {
            current.show_gpu_load_tray = value;
        }
        if let Some(value) = settings.get("showVramTray").and_then(|v| v.as_bool()) {
            current.show_vram_tray = value;
        }
        if let Some(value) = settings.get("showGpuPowerTray").and_then(|v| v.as_bool()) {
            current.show_gpu_power_tray = value;
        }
        if let Some(value) = settings.get("opacity").and_then(|v| v.as_u64()) {
            current.opacity = (value as u8).clamp(20, 100);
        }
        if let Some(value) = settings.get("accentColor").and_then(|v| v.as_str()) {
            current.accent_color = value.to_string();
        }
        if let Some(value) = settings.get("layoutMode").and_then(|v| v.as_str()) {
            current.layout_mode = value.to_string();
        }
        *current = normalize_settings(current.clone());
    }
    state.save();
    apply_autostart(&app, state.settings.lock().unwrap().auto_start);
    apply_always_on_top(&app, state.settings.lock().unwrap().always_on_top);
    update_trays_visibility(&app);
    let settings_snapshot = state.settings.lock().unwrap().clone();
    let _ = app.emit("settings-updated", settings_snapshot);
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    open_or_focus_settings(&app);
}

#[tauri::command]
fn close_settings(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.close();
    }
}

#[tauri::command]
fn show_context_menu(app: AppHandle, window: WebviewWindow) {
    if let Ok(menu) = build_tray_menu(&app) {
        let _ = menu.popup(window.as_ref().window());
    }
}

#[tauri::command]
fn snap_layout(mode: String, app: AppHandle, state: tauri::State<'_, AppState>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (width, height) = layout_size(&mode);
    let current_position = window.outer_position().ok();
    let current_size = window.outer_size().ok();
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let target_position = {
        let mut settings = state.settings.lock().unwrap();
        if let Some(position) = current_position {
            let current_mode = current_size
                .as_ref()
                .map(|size| {
                    infer_layout_from_size(
                        size.width as f64 / scale_factor,
                        size.height as f64 / scale_factor,
                        &settings.layout_mode,
                    )
                })
                .unwrap_or_else(|| settings.layout_mode.clone());
            let (current_width, current_height) = layout_size(&current_mode);
            set_bounds_for_layout(
                &mut settings,
                &current_mode,
                WindowBounds {
                    x: position.x,
                    y: position.y,
                    width: current_width as u32,
                    height: current_height as u32,
                },
            );
        }
        bounds_for_layout(&settings, &mode)
            .map(|bounds| (bounds.x, bounds.y))
    };
    if let Some((x, y)) = target_position {
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
            x: x as f64,
            y: y as f64,
        }));
    }
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
    {
        let mut settings = state.settings.lock().unwrap();
        settings.layout_mode = mode;
        if let Ok(position) = window.outer_position() {
            let mode = settings.layout_mode.clone();
            set_bounds_for_layout(
                &mut settings,
                &mode,
                WindowBounds {
                x: position.x,
                y: position.y,
                width: width as u32,
                height: height as u32,
                },
            );
        }
    }
    state.save();
    let settings_snapshot = state.settings.lock().unwrap().clone();
    let _ = app.emit("settings-updated", settings_snapshot);
}

#[tauri::command]
fn adjust_widget_height(height: u32, app: AppHandle, state: tauri::State<'_, AppState>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let mode = state.settings.lock().unwrap().layout_mode.clone();
    if mode != "horizontal" {
        return;
    }
    let (width, base_height) = layout_size(&mode);
    let height = (height as f64).clamp(base_height, 260.0);
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
}

fn quit_app(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let state = app.state::<AppState>();
        save_window_bounds(&window, &state);
    }
    app.exit(0);
    std::process::exit(0);
}

#[tauri::command]
fn update_tray_icon(app: AppHandle, id: String, data_url: String, tooltip: String) -> Result<(), String> {
    let bytes = decode_data_url(&data_url)?;
    let image = Image::from_bytes(&bytes).map_err(|error| error.to_string())?;
    if let Some(tray) = app.tray_by_id(&id) {
        tray.set_icon(Some(image)).map_err(|error| error.to_string())?;
        if !tooltip.is_empty() {
            let _ = tray.set_tooltip(Some(&tooltip));
        }
    }
    Ok(())
}

fn start_hardware_monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let system = HOST_SYSTEM.get_or_init(|| {
            Mutex::new(System::new_with_specifics(
                RefreshKind::new()
                    .with_memory(MemoryRefreshKind::everything())
                    .with_cpu(CpuRefreshKind::everything()),
            ))
        });

        if let Ok(mut sys) = system.lock() {
            sys.refresh_cpu();
        }
        tokio::time::sleep(Duration::from_millis(500)).await;

        let mut networks = Networks::new_with_refreshed_list();

        loop {
            let metrics = match system.lock() {
                Ok(mut sys) => Some(query_host_metrics(&mut sys)),
                Err(_) => None,
            };
            let Some((available_memory, total_memory, cpu_percent)) = metrics else {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            };

            networks.refresh();
            let (net_tx, net_rx) = networks.iter().fold((0u64, 0u64), |(tx, rx), (_, data)| {
                (tx + data.transmitted(), rx + data.received())
            });

            let gpu_memory = query_gpu_memory_metrics();
            let cpu_sensors = query_cpu_sensor_metrics();
            let (identity, settings) = {
                let state = app.state::<AppState>();
                let identity = state.identity.lock().unwrap().clone();
                let settings = state.settings.lock().unwrap().clone();
                (identity, settings)
            };

            let used_memory = total_memory.saturating_sub(available_memory);
            let ram_percent = if total_memory == 0 {
                0.0
            } else {
                (used_memory as f64 / total_memory as f64) * 100.0
            };

            let total_vram = if gpu_memory.total_mb > 0 {
                gpu_memory.total_mb
            } else {
                identity.gpu_total_mb.max(1)
            };

            let payload = serde_json::json!({
                "cpu": {
                    "name": identity.cpu_name,
                    "load": format!("{:.1}", cpu_percent.clamp(0.0, 100.0)),
                    "temp": cpu_sensors.temperature_c,
                    "tempAvailable": cpu_sensors.temperature_c.is_some(),
                    "fan": cpu_sensors.fan_rpm,
                    "fanAvailable": cpu_sensors.fan_rpm.is_some()
                },
                "ram": {
                    "used": format!("{:.1}", used_memory as f64 / 1024.0 / 1024.0 / 1024.0),
                    "total": format!("{:.1}", total_memory as f64 / 1024.0 / 1024.0 / 1024.0),
                    "percent": format!("{:.1}", ram_percent.clamp(0.0, 100.0))
                },
                "gpu": {
                    "name": identity.gpu_name,
                    "power": gpu_memory.power_w,
                    "powerAvailable": gpu_memory.power_w.is_some(),
                    "temp": gpu_memory.temperature_c.unwrap_or(0),
                    "tempAvailable": gpu_memory.temperature_c.is_some(),
                    "load": gpu_memory.load_percent,
                    "loadAvailable": gpu_memory.load_percent.is_some(),
                    "vramUsed": gpu_memory.used_mb,
                    "vramTotal": total_vram,
                    "vramAvailable": gpu_memory.available && total_vram > 1,
                    "fan": gpu_memory.fan_percent,
                    "fanAvailable": gpu_memory.fan_percent.is_some(),
                    "available": gpu_memory.available
                },
                "network": {
                    "tx": format!("{:.1}", net_tx as f64 / 1024.0),
                    "rx": format!("{:.1}", net_rx as f64 / 1024.0)
                },
                "settings": settings
            });

            let _ = app.emit("hardware-data", payload);
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let config_dir = app.path().app_data_dir().expect("no app data dir");
            let _ = std::fs::create_dir_all(&config_dir);
            let state = AppState::load(config_dir.join("config.json"));

            if let Some(win) = app.get_webview_window("main") {
                apply_window_bounds(&win, &state.settings.lock().unwrap());
                let _ = win.set_skip_taskbar(true);
                let _ = win.set_shadow(false);
                apply_always_on_top(app.handle(), state.settings.lock().unwrap().always_on_top);
                let state_handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Moved(_) = event {
                        let state = state_handle.state::<AppState>();
                        if let Some(window) = state_handle.get_webview_window("main") {
                            save_window_bounds(&window, &state);
                        }
                    }
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(window) = state_handle.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                });
            }

            app.manage(state);
            let identity_refresh_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let detected_identity = detect_hardware_identity();
                let state = identity_refresh_handle.state::<AppState>();
                let update_result = state.identity.lock();
                if let Ok(mut identity) = update_result {
                    *identity = detected_identity;
                }
            });
            let main_ready_handle = app.handle().clone();
            app.listen_any("main-window-ready", move |_event| {
                let handle = main_ready_handle.clone();
                let open_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Some(win) = open_handle.get_webview_window("main") {
                        let _ = win.show();
                    }
                });
            });
            let settings_open_handle = app.handle().clone();
            app.listen_any("open-settings-from-widget", move |_event| {
                let handle = settings_open_handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(180)).await;
                    let open_handle = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        open_or_focus_settings(&open_handle);
                    });
                });
            });
            let autostart_enabled = app.state::<AppState>().settings.lock().unwrap().auto_start;
            apply_autostart(app.handle(), autostart_enabled);
            update_trays_visibility(app.handle());
            start_hardware_monitor(app.handle().clone());
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => open_or_focus_settings(app),

            "layout_vertical" => {
                snap_layout("vertical".to_string(), app.clone(), app.state::<AppState>());
            }
            "layout_horizontal" => {
                snap_layout("horizontal".to_string(), app.clone(), app.state::<AppState>());
            }
            "always_on_top_on" | "always_on_top_off" => {
                let enabled = event.id().as_ref() == "always_on_top_on";
                let state = app.state::<AppState>();
                {
                    let mut settings = state.settings.lock().unwrap();
                    settings.always_on_top = enabled;
                }
                state.save();
                apply_always_on_top(app, enabled);
                update_trays_visibility(app);
            }
            "lock_position_on" | "lock_position_off" => {
                let enabled = event.id().as_ref() == "lock_position_on";
                let state = app.state::<AppState>();
                {
                    let mut settings = state.settings.lock().unwrap();
                    settings.lock_position = enabled;
                }
                state.save();
                let settings_snapshot = state.settings.lock().unwrap().clone();
                let _ = app.emit("settings-updated", settings_snapshot);
            }
            "toggle_gadget" => toggle_main_window(app),
            "quit" => quit_app(app),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            open_settings,
            close_settings,
            show_context_menu,
            snap_layout,
            adjust_widget_height,
            update_tray_icon
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
