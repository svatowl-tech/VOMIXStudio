#pragma once

/**
 * ============================================================================
 * VSTScanner.hpp - Высокопроизводительный нативный сканер системных VST3/VST2/CLAP плагинов
 * ============================================================================
 * Разработано для: Windows (WinAPI), macOS (CoreAudio/AppKit), Linux (POSIX), WebAssembly/Tauri.
 * 
 * Ключевые возможности:
 * 1. Многопоточный асинхронный обход системных директорий (std::async / std::thread pool).
 * 2. Чтение метаданных VST3 bundle (moduleinfo.json, Info.plist, PE/Mach-O/ELF экспорт таблиц)
 *    БЕЗ небезопасной динамической загрузки DLL/dylib в основной процесс (Zero Crash Probe).
 * 3. Автоматическое распаковывание подплагинов бандлов Waveshell (Waves Audio) и iZotope.
 * 4. Высокоскоростное кэширование результатов в JSON/Binary индекс с валидацией таймстемпов.
 * 5. Полная совместимость с C++17, Emscripten Embind и Tauri IPC.
 * ============================================================================
 */

#include <string>
#include <vector>
#include <memory>
#include <functional>
#include <future>
#include <mutex>
#include <atomic>
#include <chrono>
#include <unordered_map>
#include <unordered_set>
#include <cstdint>

namespace DAWCore {

/**
 * Формат аудио плагина
 */
enum class PluginFormat {
    VST3,
    VST2,
    CLAP,
    AU,
    NativeWasm,
    Unknown
};

/**
 * Категория плагина по стандарту Steinberg VST3 SubCategories
 */
enum class PluginCategory {
    Fx,
    Dynamics,
    EQ,
    Reverb,
    Delay,
    Spatial,
    Restoration,
    Mastering,
    Instrument,
    Modulation,
    PitchShift,
    Analysis,
    Other
};

/**
 * Структура метаданных подплагина Waveshell / Multi-module
 */
struct VSTSubPluginMetadata {
    std::string name;
    std::string classUid;
    std::string category;
    bool isStereo = true;
};

/**
 * Основная структура метаданных обнаруженного плагина (VSTPluginMetadata)
 */
struct VSTPluginMetadata {
    std::string id;                       // Уникальный идентификатор (UID/Хэш)
    std::string name;                     // Отображаемое имя ("FabFilter Pro-Q 3", "iZotope Ozone 11")
    std::string category;                 // Главная категория ("EQ", "Dynamics", "Reverb", "Fx")
    std::string vendor;                   // Разработчик ("FabFilter", "iZotope", "Waves Audio")
    std::string format;                   // Формат ("VST3", "VST2", "CLAP", "AU")
    std::string path;                     // Корневой путь к бандлу или файлу на диске
    std::string binaryPath;               // Прямой путь к исполняемому бинарнику (.dll, .dylib, .so)
    std::string classUid;                 // VST3 128-bit Class UID в hex формате (GUID)
    int32_t latencySamples = 0;           // Задержка обработки плагина (Latency / Delay Compensation)
    bool isInstrument = false;            // Флаг виртуального инструмента / генератора
    bool isFx = true;                     // Флаг процессора эффектов
    bool isStereo = true;                 // Поддержка 2-канальной стерео шины
    int32_t audioInputs = 2;              // Число входных аудиоканалов
    int32_t audioOutputs = 2;             // Число выходных аудиоканалов
    bool hasEditor = true;                // Наличие нативного графического интерфейса (IPlugView)
    bool is64Bit = true;                  // 64-битная архитектура
    std::string sdkVersion = "VST 3.7.8"; // Версия VST SDK
    std::string version = "1.0.0";        // Версия плагина
    std::vector<std::string> subCategories;// Подкатегории ["Fx", "Filter", "EQ"]
    uint64_t fileSize = 0;                // Размер бинарного файла в байтах
    uint64_t lastModified = 0;            // Время последнего изменения (POSIX epoch)
    bool isBundle = false;                // Является ли бандлом каталога .vst3
    bool isWaveshell = false;             // Является ли оболочкой Waves Audio
    bool isIzotope = false;               // Является ли модулем iZotope
    std::vector<VSTSubPluginMetadata> subPlugins; // Список вложенных подплагинов (для Waveshell)
    bool isValid = true;                  // Флаг успешной верификации
    std::string errorMessage;             // Описание ошибки, если модуль поврежден
};

/**
 * Результаты сканирования системных директорий
 */
struct VSTScanResult {
    std::vector<VSTPluginMetadata> plugins;
    size_t scannedFolders = 0;
    size_t scannedFiles = 0;
    size_t failedPlugins = 0;
    double scanDurationMs = 0.0;
    std::string scanTimestamp;
    bool fromCache = false;
};

/**
 * Callback прогресса сканирования:
 * currentPlugin - текущий проверяемый плагин или директория
 * progress - прогресс от 0.0 до 1.0
 * totalDiscovered - текущее число найденных валидных плагинов
 */
using VSTScanProgressCallback = std::function<void(const std::string& currentItem, float progress, size_t totalDiscovered)>;

/**
 * Класс высокоскоростного дискового сканера плагинов (VSTDiskScanner)
 */
class VSTDiskScanner {
public:
    VSTDiskScanner();
    ~VSTDiskScanner() = default;

    /**
     * Получить список стандартных системных путей VST3/VST2/CLAP для текущей ОС
     */
    static std::vector<std::string> getStandardSystemPaths();

    /**
     * Получить список всех стандартных путей для конкретной ОС
     */
    static std::vector<std::string> getWindowsStandardPaths();
    static std::vector<std::string> getMacOSStandardPaths();
    static std::vector<std::string> getLinuxStandardPaths();

    /**
     * Запустить полное сканирование системных и пользовательских директорий.
     * Использует многопоточность для ускорения обхода сотен плагинов.
     */
    VSTScanResult scanSystemDirectories(
        const std::vector<std::string>& customPaths = {},
        VSTScanProgressCallback progressCallback = nullptr,
        bool forceRefresh = false,
        const std::string& cacheFilePath = ""
    );

    /**
     * Асинхронный запуск сканирования через std::future
     */
    std::future<VSTScanResult> scanSystemDirectoriesAsync(
        const std::vector<std::string>& customPaths = {},
        VSTScanProgressCallback progressCallback = nullptr,
        bool forceRefresh = false,
        const std::string& cacheFilePath = ""
    );

    /**
     * Сканировать один конкретный файл или бандл .vst3
     */
    bool probePluginFile(const std::string& filePath, VSTPluginMetadata& outMetadata);

    /**
     * Сохранение результатов сканирования в JSON кэш
     */
    static bool saveCacheToJson(const std::string& cacheFilePath, const VSTScanResult& result);

    /**
     * Загрузка результатов сканирования из JSON кэша с валидацией изменений файлов
     */
    static bool loadCacheFromJson(const std::string& cacheFilePath, VSTScanResult& outResult, bool validateTimestamps = true);

    /**
     * Установка таймаута сканирования одного модуля (в миллисекундах)
     */
    void setProbeTimeoutMs(uint32_t timeoutMs) { probeTimeoutMs_ = timeoutMs; }

    /**
     * Отмена текущего процесса сканирования
     */
    void cancelScan() { isCancelled_.store(true); }

    /**
     * Проверка, активно ли сканирование
     */
    bool isScanning() const { return isScanningActive_.load(); }

private:
    /**
     * Внутренний метод сканирования одной папки с рекурсивным обходом
     */
    void scanDirectoryRecursive(
        const std::string& directoryPath,
        std::vector<std::string>& discoveredFiles,
        std::atomic<size_t>& folderCount,
        std::atomic<size_t>& fileCount
    );

    /**
     * Парсинг официального манифеста Steinberg moduleinfo.json внутри бандла VST3
     */
    bool parseModuleInfoJson(const std::string& jsonContent, VSTPluginMetadata& meta);

    /**
     * Парсинг macOS Info.plist внутри бандла .vst3
     */
    bool parseInfoPlist(const std::string& plistContent, VSTPluginMetadata& meta);

    /**
     * Быстрый бинарный поиск сигнатур и экспортных таблиц (GetPluginFactory, clap_entry)
     */
    bool probeBinaryDescriptors(const std::string& binaryPath, VSTPluginMetadata& meta);

    /**
     * Определение вендора и категории по имени файла и сигнатурам
     */
    void inferMetadataFromNames(VSTPluginMetadata& meta, const std::string& filename);

    /**
     * Распаковка суб-плагинов Waves Audio Waveshell
     */
    void unpackWaveshellPlugins(VSTPluginMetadata& parentMeta);

    /**
     * Распаковка модулей iZotope (Ozone, RX, Nectar, Neutron)
     */
    void unpackIzotopeModules(VSTPluginMetadata& parentMeta);

    /**
     * Поиск бинарного файла внутри структуры каталогов VST3 бандла
     */
    std::string findBinaryInBundle(const std::string& bundlePath);

    /**
     * Генерация детерминированного Class UID (GUID) на основе имени и пути
     */
    std::string generateClassUid(const std::string& vendor, const std::string& name, const std::string& path);

    /**
     * Форматирование категории
     */
    static std::string normalizeCategory(const std::string& rawCategory);

private:
    std::atomic<bool> isCancelled_{false};
    std::atomic<bool> isScanningActive_{false};
    uint32_t probeTimeoutMs_{2000};
    std::mutex resultMutex_;
};

} // namespace DAWCore
