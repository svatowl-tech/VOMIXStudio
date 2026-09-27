/**
 * ============================================================================
 * ProjectIndexer.hpp - Нативный C++17 модуль индексации проекта и валидации
 * ============================================================================
 * Высокопроизводительный обход каталогов, категоризация медиа-ассетов
 * (видео, аудио, субтитры, пресеты), парсинг и валидация project.json
 * без накладных расходов виртуальной машины JavaScript.
 * ============================================================================
 */

#pragma once

#include <string>
#include <string_view>
#include <vector>
#include <unordered_map>
#include <cstdint>
#include <chrono>

namespace DAWCore {

/**
 * Тип обнаруженного медиа-ресурса
 */
enum class MediaFileType {
    Video = 0,
    Audio = 1,
    Subtitle = 2,
    Preset = 3,
    Config = 4,
    Script = 5,
    Other = 6,
    Unknown = 7
};

/**
 * Метаданные обнаруженного файла в файловой системе
 */
struct IndexedFileEntry {
    std::string relativePath;
    std::string absolutePath;
    std::string fileName;
    std::string extension;
    std::string parentDir;
    MediaFileType type = MediaFileType::Unknown;
    std::string typeString;
    std::string mimeType;
    uint64_t sizeBytes = 0;
    int64_t lastModifiedMs = 0;
    bool isDirectory = false;
    bool isSymlink = false;
};

/**
 * Сводная статистика по проекту
 */
struct ProjectDirectoryStats {
    uint32_t totalFiles = 0;
    uint32_t totalDirectories = 0;
    uint64_t totalSizeBytes = 0;
    uint32_t videoCount = 0;
    uint32_t audioCount = 0;
    uint32_t subtitleCount = 0;
    uint32_t presetCount = 0;
    uint32_t configCount = 0;
    uint32_t scriptCount = 0;
    uint32_t otherCount = 0;
    double scanDurationMs = 0.0;
};

/**
 * Результаты валидации project.json
 */
struct ProjectValidationResult {
    bool isValid = false;
    bool hasProjectConfig = false;
    std::string configFilePath;
    std::string projectId;
    std::string projectName;
    double sampleRate = 48000.0;
    std::string createdAt;
    std::string updatedAt;
    
    // Структура проекта
    std::string videoFileName;
    std::string videoRelativePath;
    double videoDurationSec = 0.0;
    double videoFps = 30.0;
    
    uint32_t trackCount = 0;
    uint32_t cueCount = 0;
    
    std::vector<std::string> trackFileNames;
    std::vector<std::string> missingReferencedFiles;
    std::vector<std::string> warnings;
    std::vector<std::string> errors;
    std::string canonicalJson;
};

/**
 * Итоговый результат полного индексирования рабочей директории
 */
struct ProjectIndexResult {
    std::string rootPath;
    std::string directoryName;
    bool success = false;
    std::string errorMessage;
    
    std::vector<IndexedFileEntry> files;
    ProjectDirectoryStats stats;
    
    // Категоризированные списки путей
    std::vector<std::string> videoFiles;
    std::vector<std::string> audioFiles;
    std::vector<std::string> subtitleFiles;
    std::vector<std::string> presetFiles;
    std::vector<std::string> configFiles;
    
    // Результаты валидации состояния проекта
    ProjectValidationResult validation;
};

/**
 * Класс ProjectIndexer - высокоскоростной движок сканирования и валидации
 */
class ProjectIndexer {
public:
    ProjectIndexer() = default;
    ~ProjectIndexer() = default;

    /**
     * Сканирование директории по системному пути (нативный C++ / Tauri Host)
     * @param rootPath Путь к директории проекта
     * @param recursive Флаг рекурсивного обхода подкаталогов
     * @param maxDepth Максимальная глубина рекурсии (защита от циклических ссылок)
     */
    static ProjectIndexResult indexDirectory(
        std::string_view rootPath,
        bool recursive = true,
        size_t maxDepth = 8
    );

    /**
     * Индексация виртуального списка файлов (для браузерного WASM из FileSystemAccess API)
     * @param rawFiles Вектор файлов, полученных от JS/WASM моста
     * @param rawProjectJson Содержимое файла project.json (если прочитан)
     */
    static ProjectIndexResult indexVirtualFiles(
        const std::vector<IndexedFileEntry>& rawFiles,
        std::string_view rawProjectJson = ""
    );

    /**
     * Классификация типа медиафайла по расширению
     */
    static MediaFileType detectFileType(std::string_view filename);

    /**
     * Преобразование перечисления MediaFileType в строку
     */
    static std::string fileTypeToString(MediaFileType type);

    /**
     * Определение MIME-типа по расширению
     */
    static std::string detectMimeType(std::string_view filename, MediaFileType type);

    /**
     * Парсинг и валидация схемы project.json с верификацией целостности ссылок
     * @param jsonContent Текст файла project.json
     * @param indexedFiles Список файлов в проекте для проверки missing files
     */
    static ProjectValidationResult validateAndParseProjectJson(
        std::string_view jsonContent,
        const std::vector<IndexedFileEntry>& indexedFiles = {}
    );

    /**
     * Генерация чистого JSON-манифеста результатов сканирования
     */
    static std::string exportToJson(const ProjectIndexResult& result);

    /**
     * Создание дефолтного шаблона project.json на базе найденных файлов
     */
    static std::string generateDefaultProjectJson(
        std::string_view projectName,
        const std::vector<IndexedFileEntry>& files,
        double sampleRate = 48000.0
    );

private:
    static bool isIgnoredDirectory(std::string_view dirName);
    static std::string toLower(std::string_view str);
    static std::string trim(std::string_view str);
    static std::string extractFileExtension(std::string_view path);
    static std::string extractFileName(std::string_view path);
    static std::string extractParentDirectory(std::string_view path);
    static std::string normalizeSeparators(std::string_view path);
};

} // namespace DAWCore
