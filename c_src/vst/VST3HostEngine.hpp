#pragma once

#include "IVSTPluginInstance.hpp"
#include <string>
#include <vector>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace vomix {
namespace vst {

/**
 * @brief Кроссплатформенный загрузчик динамических библиотек (.dll, .vst3, .dylib, .so)
 */
class DynamicLibrary {
public:
    DynamicLibrary();
    ~DynamicLibrary();

    // Запрет копирования
    DynamicLibrary(const DynamicLibrary&) = delete;
    DynamicLibrary& operator=(const DynamicLibrary&) = delete;

    // Разрешение перемещения
    DynamicLibrary(DynamicLibrary&& other) noexcept;
    DynamicLibrary& operator=(DynamicLibrary&& other) noexcept;

    bool load(const std::string& path);
    void unload();
    bool isLoaded() const;
    void* getSymbol(const char* symbolName) const;
    const std::string& getPath() const { return m_path; }

private:
    void* m_handle = nullptr;
    std::string m_path;
};

/**
 * @brief Модульный VST2/VST3/Shell хост-контроллер для Audio Core
 */
class VST3HostEngine {
public:
    static VST3HostEngine& getInstance();

    VST3HostEngine();
    ~VST3HostEngine();

    /**
     * @brief Определение формата плагина по расширению файла и экспортным символам
     */
    PluginFormat probeFormat(const std::string& libraryPath);

    /**
     * @brief Полный опрос библиотеки на наличие суб-плагинов (для Shell-плагинов вроде Waveshell)
     * @param libraryPath Путь к динамической библиотеке плагина
     * @return Список обнаруженных суб-плагинов с их уникальными UID и метаданными
     */
    std::vector<SubPluginDescriptor> enumerateSubPlugins(const std::string& libraryPath);

    /**
     * @brief Создание экземпляра плагина (или конкретного суб-плагина из Shell)
     * @param libraryPath Путь к динамической библиотеке
     * @param subPluginUid UID суб-плагина (опционально, для Shell-библиотек)
     * @return Умный указатель на экземпляр IVSTPluginInstance
     */
    std::unique_ptr<IVSTPluginInstance> createInstance(
        const std::string& libraryPath,
        const std::string& subPluginUid = ""
    );

    /**
     * @brief Возвращает список стандартных системных директорий плагинов для текущей ОС
     */
    std::vector<std::string> getDefaultPluginSearchPaths() const;

private:
    std::mutex m_engineMutex;
};

} // namespace vst
} // namespace vomix
