#pragma once

#include "IVSTPluginInstance.hpp"
#include <string>
#include <vector>
#include <memory>

namespace vomix {
namespace vst {

/**
 * @brief Результат обнаружения и резолвинга VST3 бандла / плагина
 */
struct ResolvedPluginBinary {
    std::string originalPath;      ///< Исходный путь (папка .vst3 или файл)
    std::string binaryPath;        ///< Полный абсолютный путь к исполняемой библиотеке (.vst3 / .dll / .dylib / .so)
    std::string directoryPath;     ///< Директория для добавления в очередь поиска DLL зависимостей (Qt, iZotope Core)
    bool isBundle = false;         ///< Является ли плагин VST3 бандлом (пакет Contents/x86_64-win/...)
    bool isIzotope = false;        ///< Принадлежит ли плагин экосистеме iZotope (Ozone, RX, Nectar, Neutron, Insight)
    std::string bundleName;        ///< Название бандла (например, "iZotope Ozone 11")
    PluginFormat format = PluginFormat::VST3;
};

/**
 * @brief Нативный C++ сканер и загрузчик бандлов VST3 и библиотек плагинов
 * Обеспечивает безопасную загрузку зависимостей iZotope / Qt через WinAPI SetDllDirectoryW
 */
class VST3BundleScanner {
public:
    /**
     * @brief Получить список системных и вендорных директорий VST по умолчанию
     * Включает стандартные пути iZotope, Steinberg, Waves и Common Files
     */
    static std::vector<std::string> getDefaultSearchPaths();

    /**
     * @brief Проверка: является ли путь VST3 бандлом (папкой с расширением .vst3)
     */
    static bool isVst3BundleDirectory(const std::string& path);

    /**
     * @brief Автоматический поиск и резолвинг исполняемого бинарника внутри VST3 бандла
     * Для Windows: Contents/x86_64-win/*.vst3 или *.dll
     * Для macOS: Contents/MacOS/*
     * Для Linux: Contents/x86_64-linux/*.so
     * @param bundleOrFilePath Путь к бандлу или файлу
     * @return Структура с разрешенным путем к бинарнику и его рабочей папкой DLL
     */
    static ResolvedPluginBinary resolvePluginBinary(const std::string& bundleOrFilePath);

    /**
     * @brief Рекурсивный поиск всех VST2/VST3/CLAP плагинов и бандлов в заданной директории
     * @param rootDir Корневая директория для сканирования
     * @param recursive Флаг глубокого рекурсивного обхода подпапок
     * @return Список обнаруженных и разрешенных бинарников
     */
    static std::vector<ResolvedPluginBinary> scanDirectory(
        const std::string& rootDir,
        bool recursive = true
    );

    /**
     * @brief Безопасная загрузка DLL / VST3 с установкой SetDllDirectoryW
     * Предотвращает ошибки ERROR_MOD_NOT_FOUND (126) при загрузке зависимостей Qt5/iZotope Core
     * @param binary Инфо о разрешенном бинарнике
     * @return Дескриптор загруженного модуля (HMODULE / void*)
     */
    static void* safeLoadLibrary(const ResolvedPluginBinary& binary);

    /**
     * @brief Освобождение модуля библиотеки
     */
    static void safeFreeLibrary(void* moduleHandle);

    /**
     * @brief Извлечение метаданных плагина через опрос GetPluginFactory() / IPluginFactory
     * Распознает категории iZotope: "Mastering", "Restoration", "Dynamics", "EQ", "Fx"
     */
    static std::vector<SubPluginDescriptor> inspectPluginFactory(
        void* moduleHandle,
        const ResolvedPluginBinary& binary
    );
};

} // namespace vst
} // namespace vomix
