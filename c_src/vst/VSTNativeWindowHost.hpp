#pragma once

#include "IVSTPluginInstance.hpp"
#include <string>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <functional>

namespace vomix {
namespace vst {

/**
 * @brief Колбэк-функция для уведомления хоста об изменении параметра в нативном GUI
 * @param pluginInstanceId Уникальный идентификатор экземпляра плагина
 * @param paramId Числовой идентификатор параметра VST
 * @param normalizedValue Нормализованное значение [0.0 ... 1.0]
 */
using ParameterChangedCallback = std::function<void(const std::string& instanceId, uint32_t paramId, float normalizedValue)>;

/**
 * @brief Дескриптор геометрии нативного окна редактора плагина
 */
struct WindowGeometry {
    int32_t x = 100;
    int32_t y = 100;
    int32_t width = 800;
    int32_t height = 600;
    bool isResizable = false;
};

/**
 * @brief Нативный оконный хост для плагинов VST2, VST3 и WaveShell.
 * Создает отдельное изолированное системное окно ОС (HWND на Windows / NSView на macOS)
 * и встраивает графический интерфейс (IPlugView / effEditOpen) с двусторонней синхронизацией.
 */
class VSTNativeWindowHost {
public:
    static VSTNativeWindowHost& getInstance();

    VSTNativeWindowHost();
    ~VSTNativeWindowHost();

    // Запрет копирования и присваивания
    VSTNativeWindowHost(const VSTNativeWindowHost&) = delete;
    VSTNativeWindowHost& operator=(const VSTNativeWindowHost&) = delete;

    /**
     * @brief Регистрация обработчика изменения параметров из GUI
     */
    void setParameterChangedCallback(ParameterChangedCallback callback);

    /**
     * @brief Открытие нативного плавающего окна с оригинальным интерфейсом плагина
     * @param instanceId Уникальный строковый идентификатор слота/инстанса
     * @param plugin Указатель на инициализированный экземпляр IVSTPluginInstance
     * @param windowTitle Заголовок окна (например, "Waves CLA-76 - Track 1")
     * @return true, если окно успешно создано и GUI плагина прикреплен
     */
    bool openPluginWindow(
        const std::string& instanceId,
        IVSTPluginInstance* plugin,
        const std::string& windowTitle = ""
    );

    /**
     * @brief Закрытие нативного окна редактора плагина и освобождение графических ресурсов
     * @param instanceId Идентификатор экземпляра плагина
     * @return true, если окно было найдено и успешно закрыто
     */
    bool closePluginWindow(const std::string& instanceId);

    /**
     * @brief Проверка, открыто ли в данный момент нативное окно плагина
     */
    bool isWindowOpen(const std::string& instanceId) const;

    /**
     * @brief Проверка, поддерживает ли данный экземпляр плагина нативный GUI
     */
    bool isPluginGuiSupported(IVSTPluginInstance* plugin) const;

    /**
     * @brief Закрытие всех открытых нативных окон плагинов (при выходе из проекта/приложения)
     */
    void closeAllWindows();

    /**
     * @brief Обработка цикла системных сообщений окна (для неблокирующего обновления Win32)
     */
    void processWindowEvents();

    /**
     * @brief Внутренняя структура контекста активного нативного окна
     */
    struct NativeWindowContext {
        std::string instanceId;
        IVSTPluginInstance* plugin = nullptr;
        void* nativeWindowHandle = nullptr;   // HWND на Windows / NSWindow* на macOS
        void* pluginViewHandle = nullptr;     // IPlugView* для VST3 / HWND дочернего окна VST2
        WindowGeometry geometry;
        bool isAlive = false;
        std::string title;
    };

    /**
     * @brief Внутренний вызов синхронизации изменения параметра из WinProc / ComponentHandler
     */
    void notifyParameterChangedFromGui(const std::string& instanceId, uint32_t paramId, float value);

private:
    mutable std::mutex m_hostMutex;
    std::unordered_map<std::string, std::shared_ptr<NativeWindowContext>> m_openWindows;
    ParameterChangedCallback m_paramCallback;

#if defined(_WIN32) || defined(__WIN32__) || defined(WIN32)
    bool registerWindowClass();
    void unregisterWindowClass();
    static intptr_t __stdcall WindowProc(void* hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam);
    bool m_windowClassRegistered = false;
    std::wstring m_windowClassName = L"VOMIXStudio_VST_Editor_Host";
#endif
};

} // namespace vst
} // namespace vomix
