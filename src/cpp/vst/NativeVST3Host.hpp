#pragma once

/**
 * ============================================================================
 * NativeVST3Host.hpp - Профессиональный VST3 C++ GUI & Lifecycle Host
 * ============================================================================
 * Обеспечивает прямую привязку IPlugView к нативным дескрипторам окон ОС:
 * - Windows: Win32 HWND (через kPlatformTypeHWND)
 * - macOS: Cocoa NSView* (через kPlatformTypeNSView)
 * - Linux: X11 Window ID (через kPlatformTypeX11EmbedWindowID)
 *
 * Поддерживает:
 * 1. Создание плавающего графического интерфейса: IEditController::createView("editor")
 * 2. Монтирование окна: IPlugView::attached(parentHwnd, platformType)
 * 3. Изменение размеров: IPlugView::onSize(newSize)
 * 4. Безопасное отмонтирование при закрытии: IPlugView::removed() (Zero Crash)
 * 5. Двусторонний IComponentHandler::performEdit для синхронизации крутилок
 * 6. Загрузка бинарных пресетов .vstpreset / .fxp через IBStream (setState)
 * ============================================================================
 */

#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>
#include <memory>
#include <functional>
#include <mutex>

namespace DAWCore {

// Базовые типы Steinberg VST3
using ParamID = uint32_t;
using ParamValue = double;
using tresult = int32_t;
using TBool = uint8_t;

constexpr tresult kResultOk = 0;
constexpr tresult kResultFalse = 1;
constexpr tresult kInvalidArgument = -1;
constexpr tresult kNotImplemented = -2;

// Платформенные константы
#if defined(_WIN32)
  constexpr const char* kCurrentPlatformType = "HWND";
#elif defined(__APPLE__)
  constexpr const char* kCurrentPlatformType = "NSView";
#else
  constexpr const char* kCurrentPlatformType = "X11EmbedWindowID";
#endif

// Структура габаритов плагина ViewRect
struct ViewRect {
    int32_t left{0};
    int32_t top{0};
    int32_t right{800};
    int32_t bottom{550};

    int32_t getWidth() const noexcept { return right - left; }
    int32_t getHeight() const noexcept { return bottom - top; }
};

// Интерфейс потока данных пресета IBStream (Steinberg VST3)
class IVST3Stream {
public:
    virtual ~IVST3Stream() = default;
    virtual tresult read(void* buffer, int32_t numBytes, int32_t* numBytesRead) = 0;
    virtual tresult write(const void* buffer, int32_t numBytes, int32_t* numBytesWritten) = 0;
    virtual tresult seek(int64_t pos, int32_t mode, int64_t* result) = 0;
    virtual tresult tell(int64_t* result) = 0;
};

// Реализация IBStream в памяти для загрузки .vstpreset / .fxp
class MemoryStream : public IVST3Stream {
public:
    MemoryStream() = default;
    explicit MemoryStream(const std::vector<uint8_t>& initialData);
    MemoryStream(const uint8_t* data, size_t size);

    tresult read(void* buffer, int32_t numBytes, int32_t* numBytesRead) override;
    tresult write(const void* buffer, int32_t numBytes, int32_t* numBytesWritten) override;
    tresult seek(int64_t pos, int32_t mode, int64_t* result) override;
    tresult tell(int64_t* result) override;

    const std::vector<uint8_t>& getData() const noexcept { return data_; }
    void clear() noexcept;

private:
    std::vector<uint8_t> data_;
    int64_t cursor_{0};
};

// Callback для передачи изменений параметров из GUI плагина в хост (IComponentHandler)
using VST3ParamEditCallback = std::function<void(uint32_t paramId, double normalizedValue)>;

/**
 * Класс NativeVST3PluginViewHost
 * Управляет жизненным циклом и окном конкретного плагина
 */
class NativeVST3PluginViewHost {
public:
    NativeVST3PluginViewHost(std::string instanceId, std::string pluginPath, std::string classUid = "");
    ~NativeVST3PluginViewHost();

    // Загрузка бинарного плагина (.vst3 / .dll)
    bool initializePlugin();

    // Привязка нативного GUI к родительскому окну ОС (HWND / NSView*)
    bool attachToParentWindow(void* parentWindowHandle, int32_t& outWidth, int32_t& outHeight);

    // Изменение размера окна хоста
    void onWindowResized(int32_t width, int32_t height);

    // Безопасное отмонтирование GUI (IPlugView::removed) при закрытии окна
    void detachFromParentWindow() noexcept;

    // Загрузка бинарного пресета .vstpreset / .fxp
    bool loadPresetBinary(const uint8_t* data, size_t size);

    // Установка параметра (0.0 .. 1.0) из хоста
    bool setParameterNormalized(uint32_t paramId, double value);

    // Регистрация слушателя событий performEdit от плагина
    void setParamEditCallback(VST3ParamEditCallback callback);

    // Вызов из IComponentHandler при повороте ручки пользователем внутри GUI
    void onPluginPerformEdit(uint32_t paramId, double value);

    // Текущий статус
    bool isAttached() const noexcept { return isAttached_; }
    bool isLoaded() const noexcept { return isLoaded_; }
    const std::string& getInstanceId() const noexcept { return instanceId_; }
    const std::string& getPluginPath() const noexcept { return pluginPath_; }
    ViewRect getCurrentSize() const noexcept { return viewRect_; }

private:
    std::string instanceId_;
    std::string pluginPath_;
    std::string classUid_;

    void* moduleHandle_{nullptr};       // HMODULE (Windows) или void* dlopen (macOS/Linux)
    void* parentHwnd_{nullptr};         // Нативный дескриптор окна ОС
    void* plugView_{nullptr};           // Указатель на IPlugView
    void* editController_{nullptr};     // Указатель на IEditController
    void* component_{nullptr};          // Указатель на IComponent

    ViewRect viewRect_{0, 0, 800, 550};
    bool isLoaded_{false};
    bool isAttached_{false};

    VST3ParamEditCallback editCallback_{nullptr};
    std::mutex hostMutex_;
};

/**
 * Синглтон-менеджер нативных хостов плагинов
 */
class NativeVST3HostManager {
public:
    static NativeVST3HostManager& getInstance();

    std::shared_ptr<NativeVST3PluginViewHost> getOrCreateInstance(
        const std::string& instanceId,
        const std::string& pluginPath,
        const std::string& classUid = ""
    );

    std::shared_ptr<NativeVST3PluginViewHost> getInstanceById(const std::string& instanceId);
    bool removeInstance(const std::string& instanceId);
    void closeAllViews();

private:
    NativeVST3HostManager() = default;
    std::mutex mapMutex_;
    std::vector<std::shared_ptr<NativeVST3PluginViewHost>> activeHosts_;
};

} // namespace DAWCore

// ============================================================================
// C-ABI Экспорт для интеграции с Rust (src-tauri FFI)
// ============================================================================
extern "C" {

struct NativeVST3CInstance;

NativeVST3CInstance* vst3_host_create_instance(
    const char* instance_id,
    const char* plugin_path,
    const char* class_uid
);

bool vst3_host_attach_gui(
    NativeVST3CInstance* inst,
    void* parent_window_handle,
    int32_t* out_width,
    int32_t* out_height
);

void vst3_host_resize_gui(
    NativeVST3CInstance* inst,
    int32_t width,
    int32_t height
);

void vst3_host_detach_gui(NativeVST3CInstance* inst);

bool vst3_host_load_preset(
    NativeVST3CInstance* inst,
    const uint8_t* data,
    size_t data_size
);

bool vst3_host_set_parameter(
    NativeVST3CInstance* inst,
    uint32_t param_id,
    double value
);

void vst3_host_set_edit_callback(
    NativeVST3CInstance* inst,
    void (*callback)(void* user_data, uint32_t param_id, double value),
    void* user_data
);

void vst3_host_destroy_instance(NativeVST3CInstance* inst);

}
