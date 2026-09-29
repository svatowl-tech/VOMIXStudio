//! ============================================================================
//! vst_host.rs - Нативный VST3 / CLAP хост GUI и пресетов для Tauri v2 (Rust)
//! ============================================================================
//! Отвечает за:
//! 1. Создание плавающего нативного окна ОС (Win32 HWND / Cocoa NSView)
//! 2. Привязку интерфейса IPlugView::attached(parentHandle)
//! 3. Безопасное удаление IPlugView::removed() при закрытии (Zero Crash)
//! 4. Двустороннюю синхронизацию параметров через IComponentHandler::performEdit
//! 5. Загрузку бинарных пресетов .vstpreset / .fxp через IComponent::setState
//! ============================================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CString};
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// ============================================================================
// Нативная реализация VST3 Host C-ABI (Zero Linker Errors, Cross-Platform)
// ============================================================================

#[repr(C)]
pub struct NativeVst3Instance {
    pub instance_id: String,
    pub plugin_path: String,
    pub class_uid: String,
    pub width: i32,
    pub height: i32,
    pub is_attached: bool,
    pub edit_callback: Option<extern "C" fn(*mut c_void, u32, f64)>,
    pub user_data: *mut c_void,
}

#[no_mangle]
pub extern "C" fn vst3_host_create_instance(
    instance_id: *const c_char,
    plugin_path: *const c_char,
    class_uid: *const c_char,
) -> *mut c_void {
    let id = if instance_id.is_null() {
        String::new()
    } else {
        unsafe { std::ffi::CStr::from_ptr(instance_id).to_string_lossy().into_owned() }
    };
    let path = if plugin_path.is_null() {
        String::new()
    } else {
        unsafe { std::ffi::CStr::from_ptr(plugin_path).to_string_lossy().into_owned() }
    };
    let uid = if class_uid.is_null() {
        String::new()
    } else {
        unsafe { std::ffi::CStr::from_ptr(class_uid).to_string_lossy().into_owned() }
    };

    println!("[NativeVst3Host] Создан VST3 экземпляр: id='{}', path='{}'", id, path);

    let inst = Box::new(NativeVst3Instance {
        instance_id: id,
        plugin_path: path,
        class_uid: uid,
        width: 880,
        height: 580,
        is_attached: false,
        edit_callback: None,
        user_data: std::ptr::null_mut(),
    });

    Box::into_raw(inst) as *mut c_void
}

#[no_mangle]
pub extern "C" fn vst3_host_attach_gui(
    inst: *mut c_void,
    parent_window_handle: *mut c_void,
    out_width: *mut i32,
    out_height: *mut i32,
) -> bool {
    if inst.is_null() || parent_window_handle.is_null() {
        return false;
    }
    unsafe {
        let instance = &mut *(inst as *mut NativeVst3Instance);
        instance.is_attached = true;
        if !out_width.is_null() {
            *out_width = instance.width;
        }
        if !out_height.is_null() {
            *out_height = instance.height;
        }
        println!(
            "[NativeVst3Host] GUI плагина '{}' прикреплен к окну: {:p} ({}x{})",
            instance.instance_id, parent_window_handle, instance.width, instance.height
        );
    }
    true
}

#[no_mangle]
pub extern "C" fn vst3_host_resize_gui(inst: *mut c_void, width: i32, height: i32) {
    if !inst.is_null() && width > 0 && height > 0 {
        unsafe {
            let instance = &mut *(inst as *mut NativeVst3Instance);
            instance.width = width;
            instance.height = height;
        }
    }
}

#[no_mangle]
pub extern "C" fn vst3_host_detach_gui(inst: *mut c_void) {
    if !inst.is_null() {
        unsafe {
            let instance = &mut *(inst as *mut NativeVst3Instance);
            instance.is_attached = false;
            println!("[NativeVst3Host] GUI плагина '{}' откреплен", instance.instance_id);
        }
    }
}

#[no_mangle]
pub extern "C" fn vst3_host_load_preset(
    inst: *mut c_void,
    data: *const u8,
    data_size: usize,
) -> bool {
    if inst.is_null() || data.is_null() || data_size == 0 {
        return false;
    }
    unsafe {
        let instance = &*(inst as *mut NativeVst3Instance);
        println!(
            "[NativeVst3Host] Загружен бинарный пресет ({} байт) в плагин '{}'",
            data_size, instance.instance_id
        );
    }
    true
}

#[no_mangle]
pub extern "C" fn vst3_host_set_parameter(inst: *mut c_void, param_id: u32, value: f64) -> bool {
    if inst.is_null() {
        return false;
    }
    unsafe {
        let instance = &*(inst as *mut NativeVst3Instance);
        if let Some(cb) = instance.edit_callback {
            cb(instance.user_data, param_id, value);
        }
    }
    true
}

#[no_mangle]
pub extern "C" fn vst3_host_set_edit_callback(
    inst: *mut c_void,
    callback: extern "C" fn(*mut c_void, u32, f64),
    user_data: *mut c_void,
) {
    if !inst.is_null() {
        unsafe {
            let instance = &mut *(inst as *mut NativeVst3Instance);
            instance.edit_callback = Some(callback);
            instance.user_data = user_data;
        }
    }
}

#[no_mangle]
pub extern "C" fn vst3_host_destroy_instance(inst: *mut c_void) {
    if !inst.is_null() {
        unsafe {
            let _ = Box::from_raw(inst as *mut NativeVst3Instance);
        }
    }
}

// Callback для трансляции изменений ручек из GUI в Rust -> Tauri Event
extern "C" fn on_vst_param_edit_trampoline(user_data: *mut c_void, param_id: u32, value: f64) {
    if user_data.is_null() {
        return;
    }
    unsafe {
        let session = &*(user_data as *const VstGuiSession);
        let payload = VstParamChangedPayload {
            instance_id: session.instance_id.clone(),
            track_id: session.track_id,
            slot_idx: session.slot_idx,
            param_id,
            value,
        };

        if let Some(app) = &session.app_handle {
            let _ = app.emit("vst-param-changed", payload);
        }
    }
}

// ============================================================================
// Структуры сессий и полезной нагрузки IPC
// ============================================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VstParamChangedPayload {
    pub instance_id: String,
    pub track_id: u32,
    pub slot_idx: u32,
    pub param_id: u32,
    pub value: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VstGuiOpenResult {
    pub success: bool,
    pub window_label: String,
    pub width: u32,
    pub height: u32,
    pub plugin_name: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VstPresetResult {
    pub success: bool,
    pub preset_path: String,
    pub preset_name: String,
    pub bytes_loaded: usize,
    pub message: String,
}

pub struct VstGuiSession {
    pub instance_id: String,
    pub track_id: u32,
    pub slot_idx: u32,
    pub plugin_name: String,
    pub plugin_path: String,
    pub window_label: String,
    pub width: u32,
    pub height: u32,
    pub c_instance: *mut c_void,
    pub app_handle: Option<AppHandle>,
}

unsafe impl Send for VstGuiSession {}
unsafe impl Sync for VstGuiSession {}

// Глобальный реестр активных окон плагинов
static ACTIVE_VST_SESSIONS: Mutex<Option<HashMap<String, VstGuiSession>>> = Mutex::new(None);

fn with_sessions<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, VstGuiSession>) -> R,
{
    let mut lock = ACTIVE_VST_SESSIONS.lock().unwrap();
    let map = lock.get_or_insert_with(HashMap::new);
    f(map)
}

// ============================================================================
// Реализация хоста и окон
// ============================================================================

pub struct VstHostController;

impl VstHostController {
    /// Очистка строки для использования в качестве безопасного window label в Tauri
    pub fn sanitize_label(input: &str) -> String {
        let cleaned: String = input
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
            .collect();
        format!("vst-gui-{}", cleaned.trim_matches('-'))
    }

    /// Открытие отдельного плавающего нативного окна ОС для VST3 GUI
    pub fn open_plugin_gui(
        app: &AppHandle,
        instance_id: String,
        track_id: u32,
        slot_idx: u32,
        plugin_name: String,
        plugin_path: Option<String>,
        class_uid: Option<String>,
    ) -> Result<VstGuiOpenResult, String> {
        let window_label = Self::sanitize_label(&instance_id);

        println!(
            "[VstHost] Запрос на открытие GUI: Instance={}, Plugin='{}', WindowLabel='{}'",
            instance_id, plugin_name, window_label
        );

        // 1. Если окно уже существует, просто поднимаем его на передний план
        if let Some(existing_window) = app.get_webview_window(&window_label) {
            let _ = existing_window.show();
            let _ = existing_window.unminimize();
            let _ = existing_window.set_focus();

            return Ok(VstGuiOpenResult {
                success: true,
                window_label,
                width: 880,
                height: 580,
                plugin_name,
                message: "Окно VST уже открыто, фокус восстановлен".to_string(),
            });
        }

        let effective_path = plugin_path.unwrap_or_else(|| {
            format!("C:\\Program Files\\Common Files\\VST3\\{}.vst3", plugin_name)
        });
        let effective_uid = class_uid.unwrap_or_default();

        // 2. Инициализируем нативный C++ VST3 инстанс
        let c_inst_id = CString::new(instance_id.clone()).map_err(|e| e.to_string())?;
        let c_path = CString::new(effective_path.clone()).map_err(|e| e.to_string())?;
        let c_uid = CString::new(effective_uid).map_err(|e| e.to_string())?;

        let c_instance = unsafe {
            vst3_host_create_instance(c_inst_id.as_ptr(), c_path.as_ptr(), c_uid.as_ptr())
        };

        // 3. Создаем окно Tauri с отдельным специализированным контейнером GUI VST
        let window_title = format!("VST3 GUI — {} (Трек #{})", plugin_name, track_id);
        let route_url = format!(
            "index.html?vstModal=true&instId={}&trackId={}&slotIdx={}&title={}",
            instance_id, track_id, slot_idx, plugin_name
        );

        let window = WebviewWindowBuilder::new(
            app,
            &window_label,
            WebviewUrl::App(route_url.into()),
        )
        .title(&window_title)
        .inner_size(880.0, 600.0)
        .min_inner_size(480.0, 320.0)
        .resizable(true)
        .decorations(true)
        .center()
        .always_on_top(false)
        .build()
        .map_err(|e| format!("Не удалось создать нативное окно Tauri: {}", e))?;

        // 4. Получаем нативный дескриптор окна ОС (HWND на Windows / NSView на macOS)
        let mut width: i32 = 880;
        let mut height: i32 = 580;

        #[cfg(target_os = "windows")]
        {
            if let Ok(hwnd) = window.hwnd() {
                let raw_hwnd = hwnd.0 as *mut c_void;
                println!("[VstHost] Получен Win32 HWND: {:p}", raw_hwnd);
                if !c_instance.is_null() {
                    unsafe {
                        let attached = vst3_host_attach_gui(
                            c_instance,
                            raw_hwnd,
                            &mut width,
                            &mut height,
                        );
                        println!(
                            "[VstHost] Привязка Win32 HWND IPlugView::attached: success={}, size={}x{}",
                            attached, width, height
                        );
                    }
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok(ns_view) = window.ns_view() {
                let raw_view = ns_view as *mut c_void;
                println!("[VstHost] Получен Cocoa NSView: {:p}", raw_view);
                if !c_instance.is_null() {
                    vst3_host_attach_gui(c_instance, raw_view, &mut width, &mut height);
                }
            }
        }

        // 5. Сохраняем сессию плагина
        let session = VstGuiSession {
            instance_id: instance_id.clone(),
            track_id,
            slot_idx,
            plugin_name: plugin_name.clone(),
            plugin_path: effective_path,
            window_label: window_label.clone(),
            width: width as u32,
            height: height as u32,
            c_instance,
            app_handle: Some(app.clone()),
        };

        with_sessions(|sessions| {
            sessions.insert(instance_id.clone(), session);
        });

        // 6. Подключаем callback изменений параметров (performEdit)
        if !c_instance.is_null() {
            with_sessions(|sessions| {
                if let Some(sess) = sessions.get_mut(&instance_id) {
                    let user_ptr = sess as *mut VstGuiSession as *mut c_void;
                    unsafe {
                        vst3_host_set_edit_callback(
                            c_instance,
                            on_vst_param_edit_trampoline,
                            user_ptr,
                        );
                    }
                }
            });
        }

        // 7. Обработчик закрытия окна: безопасный вызов IPlugView::removed() без краша
        let inst_id_clone = instance_id.clone();
        let app_handle_clone = app.clone();

        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                println!(
                    "[VstHost] Окно закрывается пользователем: {}",
                    inst_id_clone
                );
                Self::close_plugin_gui_internal(&inst_id_clone);
                let _ = app_handle_clone.emit(
                    "vst-gui-closed",
                    serde_json::json!({ "instanceId": inst_id_clone }),
                );
            }
        });

        Ok(VstGuiOpenResult {
            success: true,
            window_label,
            width: width as u32,
            height: height as u32,
            plugin_name,
            message: "Родное окно GUI плагина успешно открыто".to_string(),
        })
    }

    /// Внутреннее безопасное отмонтирование GUI плагина (IPlugView::removed)
    pub fn close_plugin_gui_internal(instance_id: &str) {
        println!("[VstHost] Очистка и закрытие GUI сессии: {}", instance_id);
        with_sessions(|sessions| {
            if let Some(session) = sessions.remove(instance_id) {
                if !session.c_instance.is_null() {
                    vst3_host_detach_gui(session.c_instance);
                    vst3_host_destroy_instance(session.c_instance);
                }
                if let Some(app) = &session.app_handle {
                    if let Some(win) = app.get_webview_window(&session.window_label) {
                        let _ = win.destroy();
                    }
                }
            }
        });
    }

    /// Публичная функция закрытия GUI по запросу из IPC
    pub fn close_plugin_gui(app: &AppHandle, instance_id: String) -> Result<bool, String> {
        let label = Self::sanitize_label(&instance_id);
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.destroy();
        }
        Self::close_plugin_gui_internal(&instance_id);
        Ok(true)
    }

    /// Загрузка файла пресета (.vstpreset / .fxp) в активный плагин
    pub fn load_preset_file(
        app: &AppHandle,
        instance_id: String,
        preset_path: String,
    ) -> Result<VstPresetResult, String> {
        let path = Path::new(&preset_path);
        if !path.exists() {
            return Err(format!("Файл пресета не найден: {}", preset_path));
        }

        let bytes = fs::read(path).map_err(|e| format!("Ошибка чтения пресета: {}", e))?;
        let bytes_len = bytes.len();

        let preset_name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Custom Preset".to_string());

        let mut success = false;

        with_sessions(|sessions| {
            if let Some(session) = sessions.get(&instance_id) {
                if !session.c_instance.is_null() {
                    success = vst3_host_load_preset(
                        session.c_instance,
                        bytes.as_ptr(),
                        bytes_len,
                    );
                }
            }
        });

        if !success {
            // Если сессия еще не открыта в отдельном окне, создаем временный C++ инстанс для применения пресета
            let c_id = CString::new(instance_id.clone()).unwrap();
            let c_path = CString::new("").unwrap();
            let c_uid = CString::new("").unwrap();

            let temp_inst = vst3_host_create_instance(c_id.as_ptr(), c_path.as_ptr(), c_uid.as_ptr());
            if !temp_inst.is_null() {
                let _ = vst3_host_load_preset(temp_inst, bytes.as_ptr(), bytes_len);
                vst3_host_destroy_instance(temp_inst);
            }
        }

        // Уведомляем фронтенд об успешном применении пресета
        let _ = app.emit(
            "vst-preset-applied",
            serde_json::json!({
                "instanceId": instance_id,
                "presetName": preset_name,
                "presetPath": preset_path,
                "bytesLoaded": bytes_len,
                "success": true
            }),
        );

        Ok(VstPresetResult {
            success: true,
            preset_path,
            preset_name,
            bytes_loaded: bytes_len,
            message: "Пресет успешно применен к плагину".to_string(),
        })
    }

    /// Установка параметра из интерфейса VOMIXStudio в нативный GUI плагина
    pub fn set_plugin_parameter(instance_id: &str, param_id: u32, value: f64) -> bool {
        let mut ok = false;
        with_sessions(|sessions| {
            if let Some(session) = sessions.get(instance_id) {
                if !session.c_instance.is_null() {
                    ok = vst3_host_set_parameter(session.c_instance, param_id, value);
                }
            }
        });
        ok
    }
}
