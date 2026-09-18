// Prevents additional console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Debug)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

/// IPC Команда: Сохранение бинарного файла прямо на диск Windows без диалоговых окон браузера
#[tauri::command]
async fn save_file_direct(file_path: String, bytes: Vec<u8>) -> Result<String, String> {
    if let Some(parent) = Path::new(&file_path).parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Не удалось создать директорию: {}", e))?;
        }
    }

    fs::write(&file_path, bytes).map_err(|e| format!("Ошибка записи файла: {}", e))?;
    Ok(format!("Файл сохранен: {}", file_path))
}

/// IPC Команда: Чтение бинарного файла с диска напрямую в память WASM/JS
#[tauri::command]
async fn read_file_binary(file_path: String) -> Result<Vec<u8>, String> {
    fs::read(&file_path).map_err(|e| format!("Ошибка чтения файла {}: {}", file_path, e))
}

/// IPC Команда: Сканирование локальной директории проекта Windows
#[tauri::command]
async fn list_project_files_native(dir_path: String) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(&dir_path).map_err(|e| format!("Ошибка чтения директории {}: {}", dir_path, e))?;

    let mut result = Vec::new();
    for entry in entries {
        if let Ok(entry) = entry {
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
    }

    Ok(result)
}

/// IPC Команда: Получение пути к текущей рабочей директории
#[tauri::command]
fn get_current_working_dir() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_file_direct,
            read_file_binary,
            list_project_files_native,
            get_current_working_dir
        ])
        .run(tauri::generate_context!())
        .expect(" Ошибка запуска нативного Windows приложения Tauri v2");
}
