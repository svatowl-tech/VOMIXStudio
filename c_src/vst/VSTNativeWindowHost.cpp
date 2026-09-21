#include "VSTNativeWindowHost.hpp"
#include <iostream>
#include <algorithm>

#if defined(_WIN32) || defined(__WIN32__) || defined(WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace vomix {
namespace vst {

// Синглтон нативного оконного хоста
VSTNativeWindowHost& VSTNativeWindowHost::getInstance() {
    static VSTNativeWindowHost s_instance;
    return s_instance;
}

VSTNativeWindowHost::VSTNativeWindowHost() {
#if defined(_WIN32) || defined(__WIN32__) || defined(WIN32)
    registerWindowClass();
#endif
}

VSTNativeWindowHost::~VSTNativeWindowHost() {
    closeAllWindows();
#if defined(_WIN32) || defined(__WIN32__) || defined(WIN32)
    unregisterWindowClass();
#endif
}

void VSTNativeWindowHost::setParameterChangedCallback(ParameterChangedCallback callback) {
    std::lock_guard<std::mutex> lock(m_hostMutex);
    m_paramCallback = std::move(callback);
}

void VSTNativeWindowHost::notifyParameterChangedFromGui(
    const std::string& instanceId,
    uint32_t paramId,
    float value
) {
    ParameterChangedCallback cbCopy;
    {
        std::lock_guard<std::mutex> lock(m_hostMutex);
        cbCopy = m_paramCallback;
    }
    if (cbCopy) {
        cbCopy(instanceId, paramId, value);
    }
}

bool VSTNativeWindowHost::isPluginGuiSupported(IVSTPluginInstance* plugin) const {
    if (!plugin) return false;
    return plugin->hasEditor();
}

bool VSTNativeWindowHost::isWindowOpen(const std::string& instanceId) const {
    std::lock_guard<std::mutex> lock(m_hostMutex);
    auto it = m_openWindows.find(instanceId);
    return (it != m_openWindows.end() && it->second && it->second->isAlive);
}

#if defined(_WIN32) || defined(__WIN32__) || defined(WIN32)

bool VSTNativeWindowHost::registerWindowClass() {
    if (m_windowClassRegistered) return true;

    HINSTANCE hInstance = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(WNDCLASSEXW);
    wc.style = CS_HREDRAW | CS_VREDRAW | CS_OWNDC;
    wc.lpfnWndProc = (WNDPROC)WindowProc;
    wc.cbClsExtra = 0;
    wc.cbWndExtra = 0;
    wc.hInstance = hInstance;
    wc.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    wc.lpszMenuName = nullptr;
    wc.lpszClassName = m_windowClassName.c_str();
    wc.hIconSm = LoadIconW(nullptr, IDI_APPLICATION);

    ATOM atom = RegisterClassExW(&wc);
    m_windowClassRegistered = (atom != 0);
    return m_windowClassRegistered;
}

void VSTNativeWindowHost::unregisterWindowClass() {
    if (m_windowClassRegistered) {
        HINSTANCE hInstance = GetModuleHandleW(nullptr);
        UnregisterClassW(m_windowClassName.c_str(), hInstance);
        m_windowClassRegistered = false;
    }
}

intptr_t __stdcall VSTNativeWindowHost::WindowProc(void* hwndVal, uint32_t msg, uintptr_t wParam, intptr_t lParam) {
    HWND hwnd = (HWND)hwndVal;
    NativeWindowContext* ctx = reinterpret_cast<NativeWindowContext*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));

    switch (msg) {
        case WM_CREATE: {
            CREATESTRUCTW* cs = reinterpret_cast<CREATESTRUCTW*>(lParam);
            if (cs && cs->lpCreateParams) {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
            }
            return 0;
        }

        case WM_CLOSE: {
            if (ctx) {
                std::string instId = ctx->instanceId;
                VSTNativeWindowHost::getInstance().closePluginWindow(instId);
            } else {
                DestroyWindow(hwnd);
            }
            return 0;
        }

        case WM_DESTROY: {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            return 0;
        }

        case WM_ERASEBKGND: {
            // Плагин полностью отрисовывает свою область, предотвращаем мерцание
            return 1;
        }

        case WM_PAINT: {
            PAINTSTRUCT ps;
            HDC hdc = BeginPaint(hwnd, &ps);
            EndPaint(hwnd, &ps);
            return 0;
        }

        default:
            return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
}

#endif

bool VSTNativeWindowHost::openPluginWindow(
    const std::string& instanceId,
    IVSTPluginInstance* plugin,
    const std::string& windowTitle
) {
    if (!plugin || !plugin->hasEditor()) {
        std::cerr << "[VSTNativeWindowHost] Ошибка: плагин " << instanceId << " не имеет редактора GUI.\n";
        return false;
    }

    std::lock_guard<std::mutex> lock(m_hostMutex);

    // Если окно для этого плагина уже открыто — выводим его на передний план
    auto it = m_openWindows.find(instanceId);
    if (it != m_openWindows.end() && it->second && it->second->isAlive) {
#if defined(_WIN32) || defined(__WIN32__) || defined(WIN32)
        HWND hwnd = (HWND)it->second->nativeWindowHandle;
        if (hwnd && IsWindow(hwnd)) {
            ShowWindow(hwnd, SW_SHOWNORMAL);
            SetForegroundWindow(hwnd);
            BringWindowToTop(hwnd);
            return true;
        }
#endif
    }

    // 1. Определение начального размера окна плагина
    int32_t width = 800;
    int32_t height = 550;
    if (plugin->getEditorSize(width, height)) {
        if (width < 200) width = 800;
        if (height < 150) height = 550;
    }

    auto context = std::make_shared<NativeWindowContext>();
    context->instanceId = instanceId;
    context->plugin = plugin;
    context->geometry.width = width;
    context->geometry.height = height;
    context->title = windowTitle.empty() ? plugin->getDescriptor().name : windowTitle;

#if defined(_WIN32) || defined(__WIN32__) || defined(WIN32)
    if (!registerWindowClass()) {
        std::cerr << "[VSTNativeWindowHost] Ошибка регистрации класса окна Win32.\n";
        return false;
    }

    HINSTANCE hInstance = GetModuleHandleW(nullptr);

    // Расчет внешнего размера окна с учетом рамок и строки заголовка
    DWORD dwStyle = WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
    DWORD dwExStyle = WS_EX_APPWINDOW | WS_EX_WINDOWEDGE;

    RECT rc = { 0, 0, width, height };
    AdjustWindowRectEx(&rc, dwStyle, FALSE, dwExStyle);
    int winWidth = rc.right - rc.left;
    int winHeight = rc.bottom - rc.top;

    // Центрирование окна плагина на экране
    int screenW = GetSystemMetrics(SM_CXSCREEN);
    int screenH = GetSystemMetrics(SM_CYSCREEN);
    int posX = std::max(50, (screenW - winWidth) / 2);
    int posY = std::max(50, (screenH - winHeight) / 2);

    std::wstring wTitle(context->title.begin(), context->title.end());

    HWND hwnd = CreateWindowExW(
        dwExStyle,
        m_windowClassName.c_str(),
        wTitle.c_str(),
        dwStyle,
        posX, posY,
        winWidth, winHeight,
        nullptr,
        nullptr,
        hInstance,
        context.get()
    );

    if (!hwnd) {
        std::cerr << "[VSTNativeWindowHost] Ошибка создания HWND окна редактора VST.\n";
        return false;
    }

    context->nativeWindowHandle = (void*)hwnd;

    // 2. Встраивание нативного GUI плагина (VST3 IPlugView::attach / VST2 effEditOpen)
    void* viewHandle = plugin->openEditor((void*)hwnd);
    if (!viewHandle) {
        std::cerr << "[VSTNativeWindowHost] Предупреждение: openEditor вернул null, но окно отображено.\n";
    }
    context->pluginViewHandle = viewHandle;
    context->isAlive = true;

    // 3. Повторная подгонка размера окна под фактический размер, запрошенный плагином после attach
    int32_t finalWidth = width;
    int32_t finalHeight = height;
    if (plugin->getEditorSize(finalWidth, finalHeight) && (finalWidth != width || finalHeight != height)) {
        RECT finalRc = { 0, 0, finalWidth, finalHeight };
        AdjustWindowRectEx(&finalRc, dwStyle, FALSE, dwExStyle);
        SetWindowPos(
            hwnd, nullptr,
            posX, posY,
            finalRc.right - finalRc.left,
            finalRc.bottom - finalRc.top,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE
        );
        context->geometry.width = finalWidth;
        context->geometry.height = finalHeight;
    }

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
    SetForegroundWindow(hwnd);

#else
    // Fallback для не-Windows окружений (macOS/Linux)
    void* viewHandle = plugin->openEditor(nullptr);
    context->pluginViewHandle = viewHandle;
    context->isAlive = true;
#endif

    m_openWindows[instanceId] = context;
    std::cout << "[VSTNativeWindowHost] Успешно открыт оригинальный GUI плагина: " << context->title << " (" << instanceId << ")\n";
    return true;
}

bool VSTNativeWindowHost::closePluginWindow(const std::string& instanceId) {
    std::shared_ptr<NativeWindowContext> contextToClose;
    {
        std::lock_guard<std::mutex> lock(m_hostMutex);
        auto it = m_openWindows.find(instanceId);
        if (it != m_openWindows.end()) {
            contextToClose = it->second;
            m_openWindows.erase(it);
        }
    }

    if (!contextToClose) {
        return false;
    }

    // 1. Корректное отсоединение интерфейса плагина (IPlugView::removed() / effEditClose)
    if (contextToClose->plugin) {
        contextToClose->plugin->closeEditor();
    }

    contextToClose->isAlive = false;

#if defined(_WIN32) || defined(__WIN32__) || defined(WIN32)
    HWND hwnd = (HWND)contextToClose->nativeWindowHandle;
    if (hwnd && IsWindow(hwnd)) {
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        DestroyWindow(hwnd);
    }
#endif

    std::cout << "[VSTNativeWindowHost] Закрыто нативное окно GUI плагина: " << instanceId << "\n";
    return true;
}

void VSTNativeWindowHost::closeAllWindows() {
    std::vector<std::string> openIds;
    {
        std::lock_guard<std::mutex> lock(m_hostMutex);
        for (const auto& kv : m_openWindows) {
            openIds.push_back(kv.first);
        }
    }

    for (const auto& id : openIds) {
        closePluginWindow(id);
    }
}

void VSTNativeWindowHost::processWindowEvents() {
#if defined(_WIN32) || defined(__WIN32__) || defined(WIN32)
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
#endif
}

} // namespace vst
} // namespace vomix
