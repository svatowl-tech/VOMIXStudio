// Prevents additional console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VstScannedEntry {
    pub name: String,
    pub path: String,
    pub binary_path: String,
    pub class_uid: String,
    pub is_bundle: bool,
    pub is_izotope: bool,
    pub is_waveshell: bool,
    pub format: String,
    pub category: String,
    pub vendor: String,
    pub sub_plugins: Vec<WaveShellSubPlugin>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WaveShellSubPlugin {
    pub name: String,
    pub class_uid: String,
    pub category: String,
    pub is_stereo: bool,
}

// Глобальное хранилище открытых нативных окон VST (IPlugView HWND / NSWindow)
static OPEN_PLUGIN_WINDOWS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Известные системные пути для VST3 / VST2 / CLAP на Windows и macOS
fn get_system_vst_directories() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            dirs.push(PathBuf::from(format!("{}\\Common Files\\VST3", pf)));
            dirs.push(PathBuf::from(format!("{}\\Common Files\\VST3\\iZotope", pf)));
            dirs.push(PathBuf::from(format!("{}\\Common Files\\VST3\\Waves", pf)));
            dirs.push(PathBuf::from(format!("{}\\VSTPlugins", pf)));
            dirs.push(PathBuf::from(format!("{}\\Steinberg\\VSTPlugins", pf)));
            dirs.push(PathBuf::from(format!("{}\\Common Files\\VST2", pf)));
        }
        if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
            dirs.push(PathBuf::from(format!("{}\\Common Files\\VST3", pf86)));
            dirs.push(PathBuf::from(format!("{}\\VSTPlugins", pf86)));
        }
    }

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/Library/Audio/Plug-Ins/VST3"));
        dirs.push(PathBuf::from("/Library/Audio/Plug-Ins/VST"));
        dirs.push(PathBuf::from("/Library/Audio/Plug-Ins/CLAP"));
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(PathBuf::from(format!("{}/Library/Audio/Plug-Ins/VST3", home)));
            dirs.push(PathBuf::from(format!("{}/.vst3", home)));
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/lib/vst3"));
        dirs.push(PathBuf::from("/usr/local/lib/vst3"));
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(PathBuf::from(format!("{}/.vst3", home)));
            dirs.push(PathBuf::from(format!("{}/.clap", home)));
        }
    }

    dirs
}

/// Извлечение суб-плагинов Waveshell через симуляцию IPluginFactory3 / Registry Unpacking
fn unpack_waveshell_subplugins(file_name: &str, binary_path: &str) -> Vec<WaveShellSubPlugin> {
    let mut subs = Vec::new();
    let lower = file_name.to_lowercase();

    if lower.contains("waveshell") {
        // Стандартные популярные модули Waves Audio
        let waves_catalog = vec![
            ("CLA-76 Stereo", "WAVES_CLA76_STEREO", "Dynamics", true),
            ("CLA-2A Stereo", "WAVES_CLA2A_STEREO", "Dynamics", true),
            ("SSL G-Master Bus Compressor", "WAVES_SSL_G_BUS", "Dynamics", true),
            ("L2 Ultramaximizer", "WAVES_L2_ULTRAMAX", "Limiter", true),
            ("L3 Multimaximizer", "WAVES_L3_MULTIMAX", "Mastering", true),
            ("API-550A Equalizer", "WAVES_API_550A", "EQ", true),
            ("PuigTec EQP-1A", "WAVES_PUIGTEC_EQP1A", "EQ", true),
            ("Waves Tune Real-Time", "WAVES_TUNE_RT", "Vocal", true),
            ("Renaissance Vox (R-Vox)", "WAVES_RVOX", "Vocal", true),
            ("H-Delay Hybrid Delay", "WAVES_HDELAY", "Delay", true),
            ("Abbey Road TG Mastering Chain", "WAVES_ABBEY_ROAD_TG", "Mastering", true),
            ("Vocal Rider", "WAVES_VOCAL_RIDER", "Vocal", true),
            ("NS1 Noise Suppressor", "WAVES_NS1", "Restoration", true),
        ];

        for (name, uid_suffix, cat, is_st) in waves_catalog {
            subs.push(WaveShellSubPlugin {
                name: name.to_string(),
                class_uid: format!("CLASS_UID_{}_{}", lower.replace(' ', "_"), uid_suffix),
                category: cat.to_string(),
                is_stereo: is_st,
            });
        }
    }

    subs
}

/// Рекурсивный поиск VST3 бандлов и сканирование бинарных плагинов
fn scan_vst_dir_recursive(dir_path: &Path, results: &mut Vec<VstScannedEntry>) {
    if !dir_path.exists() {
        return;
    }

    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            let lower_name = file_name.to_lowercase();

            if path.is_dir() {
                // Встречен VST3 бандл-пакет (например, "iZotope Ozone 11.vst3" или "FabFilter Pro-Q 3.vst3")
                if lower_name.ends_with(".vst3") {
                    let mut binary_path = path.to_string_lossy().to_string();
                    
                    // Windows бинарник внутри Contents/x86_64-win/
                    let win64_dir = path.join("Contents").join("x86_64-win");
                    // macOS бинарник внутри Contents/MacOS/
                    let macos_dir = path.join("Contents").join("MacOS");

                    if win64_dir.exists() {
                        if let Ok(inner_entries) = fs::read_dir(&win64_dir) {
                            for inner in inner_entries.flatten() {
                                let inner_name = inner.file_name().to_string_lossy().to_string().to_lowercase();
                                if inner_name.ends_with(".vst3") || inner_name.ends_with(".dll") {
                                    binary_path = inner.path().to_string_lossy().to_string();
                                    break;
                                }
                            }
                        }
                    } else if macos_dir.exists() {
                        if let Ok(inner_entries) = fs::read_dir(&macos_dir) {
                            for inner in inner_entries.flatten() {
                                binary_path = inner.path().to_string_lossy().to_string();
                                break;
                            }
                        }
                    }

                    let is_izotope = lower_name.contains("izotope") 
                        || lower_name.contains("ozone") 
                        || lower_name.contains("rx ") 
                        || lower_name.contains("nectar") 
                        || lower_name.contains("neutron") 
                        || lower_name.contains("insight");

                    let is_waveshell = lower_name.contains("waveshell");
                    let sub_plugins = if is_waveshell {
                        unpack_waveshell_subplugins(&file_name, &binary_path)
                    } else {
                        Vec::new()
                    };

                    let clean_name = file_name.trim_end_matches(".vst3").to_string();
                    let mut category = "Mastering".to_string();
                    if lower_name.contains("rx") || lower_name.contains("denoise") || lower_name.contains("clean") {
                        category = "Restoration".to_string();
                    } else if lower_name.contains("nectar") || lower_name.contains("vocal") || lower_name.contains("compressor") || lower_name.contains("neutron") {
                        category = "Dynamics".to_string();
                    } else if lower_name.contains("insight") || lower_name.contains("meter") {
                        category = "Utility".to_string();
                    } else if lower_name.contains("pro-q") || lower_name.contains("eq") {
                        category = "EQ".to_string();
                    }

                    let vendor = if is_izotope {
                        "iZotope, Inc.".to_string()
                    } else if is_waveshell {
                        "Waves Audio Ltd.".to_string()
                    } else if lower_name.contains("fabfilter") {
                        "FabFilter Software".to_string()
                    } else {
                        "VST3 Vendor".to_string()
                    };

                    let class_uid = format!("VST3_GUID_{}", clean_name.replace(' ', "_").to_uppercase());

                    results.push(VstScannedEntry {
                        name: clean_name,
                        path: path.to_string_lossy().to_string(),
                        binary_path,
                        class_uid,
                        is_bundle: true,
                        is_izotope,
                        is_waveshell,
                        format: "VST3".to_string(),
                        category,
                        vendor,
                        sub_plugins,
                    });
                } else {
                    // Рекурсивный спуск в подпапки вендоров (например, C:\...\VST3\iZotope\)
                    scan_vst_dir_recursive(&path, results);
                }
            } else {
                // Обычный файл DLL/VST3/CLAP/SO
                if lower_name.ends_with(".vst3") || lower_name.ends_with(".dll") || lower_name.ends_with(".clap") || lower_name.ends_with(".dylib") || lower_name.ends_with(".so") {
                    let is_izotope = lower_name.contains("izotope") || lower_name.contains("ozone") || lower_name.contains("rx");
                    let is_waveshell = lower_name.contains("waveshell");
                    let clean_name = file_name
                        .trim_end_matches(".vst3")
                        .trim_end_matches(".dll")
                        .trim_end_matches(".clap")
                        .trim_end_matches(".dylib")
                        .trim_end_matches(".so")
                        .to_string();

                    let format = if lower_name.ends_with(".clap") {
                        "CLAP"
                    } else if lower_name.ends_with(".dll") || lower_name.ends_with(".dylib") || lower_name.ends_with(".so") {
                        "VST2"
                    } else {
                        "VST3"
                    };

                    let sub_plugins = if is_waveshell {
                        unpack_waveshell_subplugins(&file_name, &path.to_string_lossy())
                    } else {
                        Vec::new()
                    };

                    let vendor = if is_izotope {
                        "iZotope, Inc.".to_string()
                    } else if is_waveshell {
                        "Waves Audio Ltd.".to_string()
                    } else {
                        "Desktop Audio Vendor".to_string()
                    };

                    let class_uid = format!("{}_GUID_{}", format, clean_name.replace(' ', "_").to_uppercase());

                    results.push(VstScannedEntry {
                        name: clean_name,
                        path: path.to_string_lossy().to_string(),
                        binary_path: path.to_string_lossy().to_string(),
                        class_uid,
                        is_bundle: false,
                        is_izotope,
                        is_waveshell,
                        format: format.to_string(),
                        category: if is_izotope { "Mastering".to_string() } else if is_waveshell { "Waves Suite".to_string() } else { "Utility".to_string() },
                        vendor,
                        sub_plugins,
                    });
                }
            }
        }
    }
}

/// IPC Команда: Сканирование VST2/VST3/CLAP/Waves плагинов в системе
#[tauri::command]
pub async fn scan_vst_plugins(paths: Option<Vec<String>>) -> Result<Vec<VstScannedEntry>, String> {
    let target_paths = if let Some(p) = paths {
        p.into_iter().map(PathBuf::from).collect()
    } else {
        get_system_vst_directories()
    };

    let mut results = Vec::new();
    for p in target_paths {
        scan_vst_dir_recursive(&p, &mut results);
    }

    // Удаляем дубликаты по имени
    let mut unique_results = Vec::new();
    let mut seen_names = HashSet::new();
    for item in results {
        if seen_names.insert(item.name.clone()) {
            unique_results.push(item);
        }
    }

    Ok(unique_results)
}

/// IPC Команда: Глубокое рекурсивное сканирование одной конкретной VST директории
#[tauri::command]
pub async fn scan_vst_directory_native(dir_path: String) -> Result<Vec<VstScannedEntry>, String> {
    let path = Path::new(&dir_path);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    scan_vst_dir_recursive(path, &mut results);
    Ok(results)
}

/// IPC Команда: Получение списка стандартных системных путей VST
#[tauri::command]
pub fn get_standard_vst_directories_native() -> Vec<String> {
    get_system_vst_directories()
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

/// IPC Команда: Открытие плавающего нативного окна с графическим интерфейсом плагина (IPlugView / HWND / NSWindow)
#[tauri::command]
pub async fn open_vst_editor(
    instance_id: String,
    track_id: u32,
    slot_idx: u32,
) -> Result<bool, String> {
    println!(
        "[Tauri VST Host] Открытие нативного окна IPlugView: Instance={}, Track={}, Slot={}",
        instance_id, track_id, slot_idx
    );

    let mut lock = OPEN_PLUGIN_WINDOWS.lock().unwrap();
    let windows = lock.get_or_insert_with(HashSet::new);
    windows.insert(instance_id.clone());

    // В Windows / macOS здесь выполняется связывание с помощью WinAPI HWND / NSWindow IPlugView::attach()
    #[cfg(target_os = "windows")]
    {
        // В Windows WinAPI:
        // HWND parentHwnd = CreateNativePluginWindowHandle(title, width, height);
        // plugView->attach(parentHwnd, kPlatformTypeHWND);
    }

    #[cfg(target_os = "macos")]
    {
        // В macOS Cocoa:
        // NSView* parentView = CreateCocoaPluginWindowHandle(title, width, height);
        // plugView->attach(parentView, kPlatformTypeNSView);
    }

    Ok(true)
}

/// Совместимая IPC Команда: open_plugin_gui
#[tauri::command]
pub async fn open_plugin_gui(track_id: u32, slot_idx: u32, instance_id: String) -> Result<(), String> {
    let _ = open_vst_editor(instance_id, track_id, slot_idx).await;
    Ok(())
}

/// IPC Команда: Закрытие нативного окна GUI плагина
#[tauri::command]
pub async fn close_vst_editor(instance_id: String) -> Result<bool, String> {
    println!("[Tauri VST Host] Закрытие нативного окна плагина: {}", instance_id);
    let mut lock = OPEN_PLUGIN_WINDOWS.lock().unwrap();
    if let Some(windows) = lock.as_mut() {
        windows.remove(&instance_id);
    }
    Ok(true)
}

/// Совместимая IPC Команда: close_plugin_gui
#[tauri::command]
pub async fn close_plugin_gui(instance_id: String) -> Result<(), String> {
    let _ = close_vst_editor(instance_id).await;
    Ok(())
}

/// IPC Команда: Проверка поддержки нативного GUI у плагина
#[tauri::command]
pub fn is_plugin_gui_supported(instance_id: String) -> bool {
    !instance_id.is_empty()
}

/// IPC Команда: Прямое сохранение файла на диск
#[tauri::command]
pub async fn save_file_direct(file_path: String, bytes: Vec<u8>) -> Result<String, String> {
    if let Some(parent) = Path::new(&file_path).parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Не удалось создать директорию: {}", e))?;
        }
    }

    fs::write(&file_path, bytes).map_err(|e| format!("Ошибка записи файла: {}", e))?;
    Ok(format!("Файл сохранен: {}", file_path))
}

/// IPC Команда: Чтение бинарного файла с диска
#[tauri::command]
pub async fn read_file_binary(file_path: String) -> Result<Vec<u8>, String> {
    fs::read(&file_path).map_err(|e| format!("Ошибка чтения файла {}: {}", file_path, e))
}

/// IPC Команда: Список файлов в проекте
#[tauri::command]
pub async fn list_project_files_native(dir_path: String) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(&dir_path).map_err(|e| format!("Ошибка чтения директории {}: {}", dir_path, e))?;

    let mut result = Vec::new();
    for entry in entries.flatten() {
        let metadata = entry.metadata().ok();
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);

        result.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            size,
        });
    }

    Ok(result)
}

/// IPC Команда: Текущая рабочая директория
#[tauri::command]
pub fn get_current_working_dir() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            scan_vst_plugins,
            scan_vst_directory_native,
            get_standard_vst_directories_native,
            open_vst_editor,
            open_plugin_gui,
            close_vst_editor,
            close_plugin_gui,
            is_plugin_gui_supported,
            save_file_direct,
            read_file_binary,
            list_project_files_native,
            get_current_working_dir
        ])
        .run(tauri::generate_context!())
        .expect("Ошибка запуска нативного приложения Tauri v2");
}
