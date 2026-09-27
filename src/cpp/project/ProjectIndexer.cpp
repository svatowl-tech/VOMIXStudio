/**
 * ============================================================================
 * ProjectIndexer.cpp - Реализация нативного C++17 индексатора проекта
 * ============================================================================
 */

#include "ProjectIndexer.hpp"

#include <algorithm>
#include <sstream>
#include <fstream>
#include <iomanip>
#include <chrono>
#include <cctype>
#include <filesystem>

namespace DAWCore {

namespace fs = std::filesystem;

// ============================================================================
// Вспомогательные строковые утилиты
// ============================================================================

std::string ProjectIndexer::toLower(std::string_view str) {
    std::string result;
    result.reserve(str.size());
    for (char c : str) {
        result.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    }
    return result;
}

std::string ProjectIndexer::trim(std::string_view str) {
    size_t first = 0;
    while (first < str.size() && (std::isspace(static_cast<unsigned char>(str[first])) || str[first] == '"' || str[first] == '\'')) {
        first++;
    }
    size_t last = str.size();
    while (last > first && (std::isspace(static_cast<unsigned char>(str[last - 1])) || str[last - 1] == '"' || str[last - 1] == '\'')) {
        last--;
    }
    return std::string(str.substr(first, last - first));
}

std::string ProjectIndexer::normalizeSeparators(std::string_view path) {
    std::string res;
    res.reserve(path.size());
    for (char c : path) {
        if (c == '\\') {
            res.push_back('/');
        } else {
            res.push_back(c);
        }
    }
    return res;
}

std::string ProjectIndexer::extractFileExtension(std::string_view path) {
    size_t dotPos = path.rfind('.');
    size_t slashPos = path.find_last_of("/\\");
    if (dotPos == std::string_view::npos || (slashPos != std::string_view::npos && dotPos < slashPos)) {
        return "";
    }
    return toLower(path.substr(dotPos + 1));
}

std::string ProjectIndexer::extractFileName(std::string_view path) {
    size_t slashPos = path.find_last_of("/\\");
    if (slashPos == std::string_view::npos) {
        return std::string(path);
    }
    return std::string(path.substr(slashPos + 1));
}

std::string ProjectIndexer::extractParentDirectory(std::string_view path) {
    size_t slashPos = path.find_last_of("/\\");
    if (slashPos == std::string_view::npos) {
        return "";
    }
    return std::string(path.substr(0, slashPos));
}

bool ProjectIndexer::isIgnoredDirectory(std::string_view dirName) {
    std::string lower = toLower(dirName);
    return lower == ".git" || lower == "node_modules" || lower == ".cache" ||
           lower == ".vscode" || lower == ".idea" || lower == "target" ||
           lower == "build" || lower == "dist" || lower == ".tmp" ||
           lower == "$recycle.bin" || lower == "system volume information";
}

// ============================================================================
// Классификация типов медиафайлов
// ============================================================================

MediaFileType ProjectIndexer::detectFileType(std::string_view filename) {
    std::string ext = extractFileExtension(filename);
    if (ext.empty()) {
        return MediaFileType::Unknown;
    }

    // Видео
    if (ext == "mp4" || ext == "mkv" || ext == "mov" || ext == "webm" ||
        ext == "avi" || ext == "m4v" || ext == "flv" || ext == "wmv" ||
        ext == "ogv" || ext == "ts"  || ext == "m2ts" || ext == "3gp") {
        return MediaFileType::Video;
    }

    // Аудио
    if (ext == "wav" || ext == "mp3" || ext == "flac" || ext == "ogg" ||
        ext == "aac" || ext == "m4a" || ext == "aiff" || ext == "aif" ||
        ext == "wma" || ext == "opus" || ext == "alac" || ext == "caf" ||
        ext == "pcm" || ext == "mid" || ext == "midi") {
        return MediaFileType::Audio;
    }

    // Субтитры
    if (ext == "srt" || ext == "ass" || ext == "ssa" || ext == "vtt" ||
        ext == "sub" || ext == "sbv" || ext == "lrc") {
        return MediaFileType::Subtitle;
    }

    // Пресеты DSP/VST
    if (ext == "vstpreset" || ext == "fxp" || ext == "fxb" ||
        ext == "aupreset" || ext == "preset" || ext == "dawpreset") {
        return MediaFileType::Preset;
    }

    // Конфигурационные файлы
    if (ext == "json" || ext == "toml" || ext == "yaml" || ext == "yml" ||
        ext == "xml" || ext == "ini" || ext == "cfg") {
        return MediaFileType::Config;
    }

    // Текстовые сценарии
    if (ext == "txt" || ext == "csv" || ext == "tsv" || ext == "doc" ||
        ext == "docx" || ext == "pdf" || ext == "md") {
        return MediaFileType::Script;
    }

    return MediaFileType::Other;
}

std::string ProjectIndexer::fileTypeToString(MediaFileType type) {
    switch (type) {
        case MediaFileType::Video:    return "video";
        case MediaFileType::Audio:    return "audio";
        case MediaFileType::Subtitle: return "subtitle";
        case MediaFileType::Preset:   return "preset";
        case MediaFileType::Config:   return "config";
        case MediaFileType::Script:   return "script";
        case MediaFileType::Other:    return "other";
        case MediaFileType::Unknown:
        default:                      return "unknown";
    }
}

std::string ProjectIndexer::detectMimeType(std::string_view filename, MediaFileType type) {
    std::string ext = extractFileExtension(filename);
    if (type == MediaFileType::Video) {
        if (ext == "mp4" || ext == "m4v") return "video/mp4";
        if (ext == "webm") return "video/webm";
        if (ext == "mkv") return "video/x-matroska";
        if (ext == "mov") return "video/quicktime";
        if (ext == "avi") return "video/x-msvideo";
        return "video/*";
    }
    if (type == MediaFileType::Audio) {
        if (ext == "wav") return "audio/wav";
        if (ext == "mp3") return "audio/mpeg";
        if (ext == "ogg" || ext == "opus") return "audio/ogg";
        if (ext == "aac") return "audio/aac";
        if (ext == "flac") return "audio/flac";
        if (ext == "m4a") return "audio/mp4";
        if (ext == "aiff" || ext == "aif") return "audio/aiff";
        return "audio/*";
    }
    if (type == MediaFileType::Subtitle) {
        if (ext == "srt") return "text/srt";
        if (ext == "vtt") return "text/vtt";
        if (ext == "ass" || ext == "ssa") return "text/x-ssa";
        return "text/plain";
    }
    if (type == MediaFileType::Config) {
        if (ext == "json") return "application/json";
        if (ext == "xml") return "application/xml";
        return "text/plain";
    }
    if (type == MediaFileType::Script) {
        if (ext == "csv") return "text/csv";
        if (ext == "pdf") return "application/pdf";
        return "text/plain";
    }
    return "application/octet-stream";
}

// ============================================================================
// Индексация директории в нативном окружении C++17 (POSIX / WinAPI)
// ============================================================================

ProjectIndexResult ProjectIndexer::indexDirectory(
    std::string_view rootPathStr,
    bool recursive,
    size_t maxDepth
) {
    auto startTime = std::chrono::high_resolution_clock::now();
    ProjectIndexResult result;
    result.rootPath = normalizeSeparators(rootPathStr);

    std::error_code ec;
    fs::path root(result.rootPath);

    if (!fs::exists(root, ec) || !fs::is_directory(root, ec)) {
        result.success = false;
        result.errorMessage = "Каталог проекта не найден или не является директорией: " + result.rootPath;
        return result;
    }

    result.directoryName = root.filename().string();
    if (result.directoryName.empty()) {
        result.directoryName = root.string();
    }

    std::string projectJsonContent;
    std::string projectJsonFoundPath;

    auto processEntry = [&](const fs::directory_entry& entry) {
        std::error_code statusEc;
        auto status = entry.status(statusEc);
        if (statusEc) return;

        bool isDir = fs::is_directory(status);
        std::string filename = entry.path().filename().string();

        if (filename.empty() || filename[0] == '.') {
            if (filename != ".project.json" && filename != "project.json") {
                // Пропускаем скрытые системные файлы вроде .DS_Store
                if (filename == ".DS_Store" || filename == "Thumbs.db") return;
            }
        }

        if (isDir) {
            if (isIgnoredDirectory(filename)) return;
            result.stats.totalDirectories++;
            return;
        }

        IndexedFileEntry item;
        item.fileName = filename;
        item.absolutePath = normalizeSeparators(entry.path().string());
        
        // Относительный путь от корня проекта
        fs::path relPath = fs::relative(entry.path(), root, statusEc);
        item.relativePath = statusEc ? item.fileName : normalizeSeparators(relPath.string());
        item.extension = extractFileExtension(filename);
        item.parentDir = normalizeSeparators(entry.path().parent_path().string());
        item.isDirectory = false;
        item.isSymlink = fs::is_symlink(status);

        item.sizeBytes = fs::file_size(entry.path(), statusEc);
        if (statusEc) item.sizeBytes = 0;

        auto ftime = fs::last_write_time(entry.path(), statusEc);
        if (!statusEc) {
            auto sctp = std::chrono::time_point_cast<std::chrono::system_clock::duration>(
                ftime - fs::file_time_type::clock::now() + std::chrono::system_clock::now()
            );
            item.lastModifiedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                sctp.time_since_epoch()
            ).count();
        }

        item.type = detectFileType(item.fileName);
        item.typeString = fileTypeToString(item.type);
        item.mimeType = detectMimeType(item.fileName, item.type);

        // Обновление статистики
        result.stats.totalFiles++;
        result.stats.totalSizeBytes += item.sizeBytes;

        switch (item.type) {
            case MediaFileType::Video:
                result.stats.videoCount++;
                result.videoFiles.push_back(item.relativePath);
                break;
            case MediaFileType::Audio:
                result.stats.audioCount++;
                result.audioFiles.push_back(item.relativePath);
                break;
            case MediaFileType::Subtitle:
                result.stats.subtitleCount++;
                result.subtitleFiles.push_back(item.relativePath);
                break;
            case MediaFileType::Preset:
                result.stats.presetCount++;
                result.presetFiles.push_back(item.relativePath);
                break;
            case MediaFileType::Config:
                result.stats.configCount++;
                result.configFiles.push_back(item.relativePath);
                break;
            case MediaFileType::Script:
                result.stats.scriptCount++;
                break;
            case MediaFileType::Other:
            case MediaFileType::Unknown:
            default:
                result.stats.otherCount++;
                break;
        }

        // Проверка наличия project.json / project/project.json
        if (item.fileName == "project.json") {
            if (projectJsonContent.empty() || item.relativePath == "project/project.json" || item.relativePath == "project.json") {
                projectJsonFoundPath = item.absolutePath;
                std::ifstream stream(item.absolutePath, std::ios::in | std::ios::binary);
                if (stream.is_open()) {
                    std::ostringstream ss;
                    ss << stream.rdbuf();
                    projectJsonContent = ss.str();
                }
            }
        }

        result.files.push_back(std::move(item));
    };

    try {
        if (recursive) {
            fs::recursive_directory_iterator iter(root, fs::directory_options::skip_permission_denied, ec);
            fs::recursive_directory_iterator end;

            while (iter != end && !ec) {
                if (iter.depth() > static_cast<int>(maxDepth)) {
                    iter.pop();
                    continue;
                }
                const auto& entry = *iter;
                if (entry.is_directory(ec) && isIgnoredDirectory(entry.path().filename().string())) {
                    iter.disable_recursion_pending();
                } else {
                    processEntry(entry);
                }
                iter.increment(ec);
            }
        } else {
            fs::directory_iterator iter(root, fs::directory_options::skip_permission_denied, ec);
            fs::directory_iterator end;

            while (iter != end && !ec) {
                processEntry(*iter);
                iter.increment(ec);
            }
        }
    } catch (const std::exception& ex) {
        result.errorMessage = std::string("Ошибка во время сканирования: ") + ex.what();
    }

    // Валидация project.json
    if (!projectJsonContent.empty()) {
        result.validation = validateAndParseProjectJson(projectJsonContent, result.files);
        result.validation.hasProjectConfig = true;
        result.validation.configFilePath = projectJsonFoundPath;
    } else {
        result.validation.hasProjectConfig = false;
        result.validation.isValid = false;
        result.validation.warnings.push_back("Файл конфигурации project.json не обнаружен в рабочей директории.");
    }

    auto endTime = std::chrono::high_resolution_clock::now();
    result.stats.scanDurationMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();
    result.success = true;

    return result;
}

// ============================================================================
// Индексация виртуального набора файлов (WASM FileSystem Access API)
// ============================================================================

ProjectIndexResult ProjectIndexer::indexVirtualFiles(
    const std::vector<IndexedFileEntry>& rawFiles,
    std::string_view rawProjectJson
) {
    auto startTime = std::chrono::high_resolution_clock::now();
    ProjectIndexResult result;
    result.rootPath = "virtual://workspace";
    result.directoryName = "Virtual Project Workspace";
    result.success = true;

    for (const auto& item : rawFiles) {
        IndexedFileEntry entry = item;
        entry.extension = extractFileExtension(entry.fileName);
        entry.type = detectFileType(entry.fileName);
        entry.typeString = fileTypeToString(entry.type);
        entry.mimeType = detectMimeType(entry.fileName, entry.type);

        if (entry.isDirectory) {
            result.stats.totalDirectories++;
            continue;
        }

        result.stats.totalFiles++;
        result.stats.totalSizeBytes += entry.sizeBytes;

        switch (entry.type) {
            case MediaFileType::Video:
                result.stats.videoCount++;
                result.videoFiles.push_back(entry.relativePath.empty() ? entry.fileName : entry.relativePath);
                break;
            case MediaFileType::Audio:
                result.stats.audioCount++;
                result.audioFiles.push_back(entry.relativePath.empty() ? entry.fileName : entry.relativePath);
                break;
            case MediaFileType::Subtitle:
                result.stats.subtitleCount++;
                result.subtitleFiles.push_back(entry.relativePath.empty() ? entry.fileName : entry.relativePath);
                break;
            case MediaFileType::Preset:
                result.stats.presetCount++;
                result.presetFiles.push_back(entry.relativePath.empty() ? entry.fileName : entry.relativePath);
                break;
            case MediaFileType::Config:
                result.stats.configCount++;
                result.configFiles.push_back(entry.relativePath.empty() ? entry.fileName : entry.relativePath);
                break;
            case MediaFileType::Script:
                result.stats.scriptCount++;
                break;
            default:
                result.stats.otherCount++;
                break;
        }

        result.files.push_back(std::move(entry));
    }

    if (!rawProjectJson.empty()) {
        result.validation = validateAndParseProjectJson(rawProjectJson, result.files);
        result.validation.hasProjectConfig = true;
    } else {
        result.validation.hasProjectConfig = false;
        result.validation.isValid = false;
    }

    auto endTime = std::chrono::high_resolution_clock::now();
    result.stats.scanDurationMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

    return result;
}

// ============================================================================
// Парсинг и валидация схемы project.json (Zero-dependency C++17 JSON parser)
// ============================================================================

namespace {

// Простой быстрый экстрактор строкового значения по ключу из JSON
std::string extractJsonString(std::string_view json, std::string_view key) {
    std::string needle = "\"" + std::string(key) + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string_view::npos) return "";

    size_t colon = json.find(':', pos + needle.size());
    if (colon == std::string_view::npos) return "";

    size_t quoteStart = json.find('"', colon + 1);
    if (quoteStart == std::string_view::npos) return "";

    size_t quoteEnd = quoteStart + 1;
    while (quoteEnd < json.size()) {
        if (json[quoteEnd] == '"' && json[quoteEnd - 1] != '\\') {
            break;
        }
        quoteEnd++;
    }
    if (quoteEnd >= json.size()) return "";

    return std::string(json.substr(quoteStart + 1, quoteEnd - quoteStart - 1));
}

// Экстрактор числового значения по ключу
double extractJsonNumber(std::string_view json, std::string_view key, double defaultVal = 0.0) {
    std::string needle = "\"" + std::string(key) + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string_view::npos) return defaultVal;

    size_t colon = json.find(':', pos + needle.size());
    if (colon == std::string_view::npos) return defaultVal;

    size_t numStart = colon + 1;
    while (numStart < json.size() && std::isspace(static_cast<unsigned char>(json[numStart]))) {
        numStart++;
    }
    if (numStart >= json.size()) return defaultVal;

    size_t numEnd = numStart;
    while (numEnd < json.size() && (std::isdigit(static_cast<unsigned char>(json[numEnd])) ||
                                  json[numEnd] == '.' || json[numEnd] == '-' || json[numEnd] == '+' ||
                                  json[numEnd] == 'e' || json[numEnd] == 'E')) {
        numEnd++;
    }
    if (numStart == numEnd) return defaultVal;

    try {
        std::string s(json.substr(numStart, numEnd - numStart));
        return std::stod(s);
    } catch (...) {
        return defaultVal;
    }
}

// Поиск блока под-объекта (например, "videoFile": { ... })
std::string_view extractJsonObject(std::string_view json, std::string_view key) {
    std::string needle = "\"" + std::string(key) + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string_view::npos) return "";

    size_t braceStart = json.find('{', pos + needle.size());
    if (braceStart == std::string_view::npos) return "";

    int depth = 1;
    size_t braceEnd = braceStart + 1;
    bool inString = false;

    while (braceEnd < json.size() && depth > 0) {
        char c = json[braceEnd];
        if (c == '"' && json[braceEnd - 1] != '\\') {
            inString = !inString;
        } else if (!inString) {
            if (c == '{') depth++;
            else if (c == '}') depth--;
        }
        braceEnd++;
    }

    if (depth == 0) {
        return json.substr(braceStart, braceEnd - braceStart);
    }
    return "";
}

// Поиск блока массива (например, "tracks": [ ... ])
std::string_view extractJsonArray(std::string_view json, std::string_view key) {
    std::string needle = "\"" + std::string(key) + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string_view::npos) return "";

    size_t bracketStart = json.find('[', pos + needle.size());
    if (bracketStart == std::string_view::npos) return "";

    int depth = 1;
    size_t bracketEnd = bracketStart + 1;
    bool inString = false;

    while (bracketEnd < json.size() && depth > 0) {
        char c = json[bracketEnd];
        if (c == '"' && json[bracketEnd - 1] != '\\') {
            inString = !inString;
        } else if (!inString) {
            if (c == '[') depth++;
            else if (c == ']') depth--;
        }
        bracketEnd++;
    }

    if (depth == 0) {
        return json.substr(bracketStart, bracketEnd - bracketStart);
    }
    return "";
}

} // anonymous namespace

ProjectValidationResult ProjectIndexer::validateAndParseProjectJson(
    std::string_view jsonContent,
    const std::vector<IndexedFileEntry>& indexedFiles
) {
    ProjectValidationResult res;
    res.canonicalJson = std::string(jsonContent);

    if (jsonContent.empty()) {
        res.isValid = false;
        res.errors.push_back("Конфигурационный файл project.json пуст.");
        return res;
    }

    // Базовые метаданные проекта
    res.projectId = extractJsonString(jsonContent, "id");
    res.projectName = extractJsonString(jsonContent, "name");
    res.createdAt = extractJsonString(jsonContent, "createdAt");
    res.updatedAt = extractJsonString(jsonContent, "updatedAt");
    res.sampleRate = extractJsonNumber(jsonContent, "sampleRate", 48000.0);

    if (res.projectId.empty()) {
        res.warnings.push_back("В project.json отсутствует уникальный ID проекта.");
    }
    if (res.projectName.empty()) {
        res.warnings.push_back("В project.json не указано имя проекта (name).");
        res.projectName = "Без названия";
    }
    if (res.sampleRate < 8000.0 || res.sampleRate > 384000.0) {
        res.warnings.push_back("Некорректная частота дискретизации (" + std::to_string(res.sampleRate) + " Гц). Установлено 48000 Гц.");
        res.sampleRate = 48000.0;
    }

    // Видеофайл
    std::string_view videoObj = extractJsonObject(jsonContent, "videoFile");
    if (!videoObj.empty()) {
        res.videoFileName = extractJsonString(videoObj, "name");
        res.videoRelativePath = extractJsonString(videoObj, "relativePath");
        res.videoDurationSec = extractJsonNumber(videoObj, "durationSec", 0.0);
        res.videoFps = extractJsonNumber(videoObj, "fps", 30.0);
    }

    // Построение карты присутствующих на диске файлов для мгновенной проверки
    std::unordered_map<std::string, bool> availableFiles;
    for (const auto& file : indexedFiles) {
        availableFiles[toLower(file.fileName)] = true;
        availableFiles[toLower(file.relativePath)] = true;
        availableFiles[toLower(normalizeSeparators(file.relativePath))] = true;
    }

    // Проверка видеофайла
    if (!res.videoFileName.empty() && !indexedFiles.empty()) {
        std::string lowerName = toLower(res.videoFileName);
        std::string lowerPath = toLower(normalizeSeparators(res.videoRelativePath));
        if (availableFiles.find(lowerName) == availableFiles.end() &&
            availableFiles.find(lowerPath) == availableFiles.end()) {
            res.missingReferencedFiles.push_back(res.videoFileName);
            res.warnings.push_back("Исходное видео проекта '" + res.videoFileName + "' не найдено на диске.");
        }
    }

    // Парсинг списка дорожек
    std::string_view tracksArray = extractJsonArray(jsonContent, "tracks");
    if (!tracksArray.empty()) {
        size_t cursor = 0;
        while (cursor < tracksArray.size()) {
            size_t objStart = tracksArray.find('{', cursor);
            if (objStart == std::string_view::npos) break;

            int depth = 1;
            size_t objEnd = objStart + 1;
            bool inString = false;
            while (objEnd < tracksArray.size() && depth > 0) {
                char c = tracksArray[objEnd];
                if (c == '"' && tracksArray[objEnd - 1] != '\\') {
                    inString = !inString;
                } else if (!inString) {
                    if (c == '{') depth++;
                    else if (c == '}') depth--;
                }
                objEnd++;
            }

            if (depth == 0) {
                std::string_view trackObj = tracksArray.substr(objStart, objEnd - objStart);
                std::string fileName = extractJsonString(trackObj, "fileName");
                if (!fileName.empty()) {
                    res.trackFileNames.push_back(fileName);
                    res.trackCount++;

                    // Проверка физического наличия аудиофайла
                    if (!indexedFiles.empty()) {
                        std::string lowerTrackFile = toLower(fileName);
                        if (availableFiles.find(lowerTrackFile) == availableFiles.end()) {
                            res.missingReferencedFiles.push_back(fileName);
                            res.warnings.push_back("Аудиофайл дорожки '" + fileName + "' отсутствует в каталоге.");
                        }
                    }
                }
                cursor = objEnd;
            } else {
                break;
            }
        }
    }

    // Парсинг субтитров / реплик
    std::string_view subsArray = extractJsonArray(jsonContent, "subtitles");
    if (!subsArray.empty()) {
        size_t count = 0;
        size_t pos = 0;
        while ((pos = subsArray.find('{', pos)) != std::string_view::npos) {
            count++;
            pos++;
        }
        res.cueCount = static_cast<uint32_t>(count);
    }

    // Статус валидности
    res.isValid = res.errors.empty();

    return res;
}

// ============================================================================
// Сериализация результатов в JSON-манифест
// ============================================================================

std::string ProjectIndexer::exportToJson(const ProjectIndexResult& result) {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(3);

    ss << "{\n";
    ss << "  \"rootPath\": \"" << result.rootPath << "\",\n";
    ss << "  \"directoryName\": \"" << result.directoryName << "\",\n";
    ss << "  \"success\": " << (result.success ? "true" : "false") << ",\n";
    ss << "  \"errorMessage\": \"" << result.errorMessage << "\",\n";

    // Статистика
    ss << "  \"stats\": {\n";
    ss << "    \"totalFiles\": " << result.stats.totalFiles << ",\n";
    ss << "    \"totalDirectories\": " << result.stats.totalDirectories << ",\n";
    ss << "    \"totalSizeBytes\": " << result.stats.totalSizeBytes << ",\n";
    ss << "    \"videoCount\": " << result.stats.videoCount << ",\n";
    ss << "    \"audioCount\": " << result.stats.audioCount << ",\n";
    ss << "    \"subtitleCount\": " << result.stats.subtitleCount << ",\n";
    ss << "    \"presetCount\": " << result.stats.presetCount << ",\n";
    ss << "    \"configCount\": " << result.stats.configCount << ",\n";
    ss << "    \"scriptCount\": " << result.stats.scriptCount << ",\n";
    ss << "    \"otherCount\": " << result.stats.otherCount << ",\n";
    ss << "    \"scanDurationMs\": " << result.stats.scanDurationMs << "\n";
    ss << "  },\n";

    // Валидация
    ss << "  \"validation\": {\n";
    ss << "    \"isValid\": " << (result.validation.isValid ? "true" : "false") << ",\n";
    ss << "    \"hasProjectConfig\": " << (result.validation.hasProjectConfig ? "true" : "false") << ",\n";
    ss << "    \"projectId\": \"" << result.validation.projectId << "\",\n";
    ss << "    \"projectName\": \"" << result.validation.projectName << "\",\n";
    ss << "    \"sampleRate\": " << result.validation.sampleRate << ",\n";
    ss << "    \"videoFileName\": \"" << result.validation.videoFileName << "\",\n";
    ss << "    \"trackCount\": " << result.validation.trackCount << ",\n";
    ss << "    \"cueCount\": " << result.validation.cueCount << ",\n";

    // Пропущенные файлы
    ss << "    \"missingReferencedFiles\": [";
    for (size_t i = 0; i < result.validation.missingReferencedFiles.size(); i++) {
        ss << "\"" << result.validation.missingReferencedFiles[i] << "\"";
        if (i + 1 < result.validation.missingReferencedFiles.size()) ss << ", ";
    }
    ss << "],\n";

    // Предупреждения
    ss << "    \"warnings\": [";
    for (size_t i = 0; i < result.validation.warnings.size(); i++) {
        ss << "\"" << result.validation.warnings[i] << "\"";
        if (i + 1 < result.validation.warnings.size()) ss << ", ";
    }
    ss << "]\n";
    ss << "  },\n";

    // Список файлов
    ss << "  \"files\": [\n";
    for (size_t i = 0; i < result.files.size(); i++) {
        const auto& f = result.files[i];
        ss << "    {\n";
        ss << "      \"fileName\": \"" << f.fileName << "\",\n";
        ss << "      \"relativePath\": \"" << f.relativePath << "\",\n";
        ss << "      \"extension\": \"" << f.extension << "\",\n";
        ss << "      \"type\": \"" << f.typeString << "\",\n";
        ss << "      \"mimeType\": \"" << f.mimeType << "\",\n";
        ss << "      \"sizeBytes\": " << f.sizeBytes << ",\n";
        ss << "      \"lastModifiedMs\": " << f.lastModifiedMs << "\n";
        ss << "    }" << (i + 1 < result.files.size() ? "," : "") << "\n";
    }
    ss << "  ]\n";
    ss << "}\n";

    return ss.str();
}

// ============================================================================
// Генерация стандартного шаблона project.json
// ============================================================================

std::string ProjectIndexer::generateDefaultProjectJson(
    std::string_view projectName,
    const std::vector<IndexedFileEntry>& files,
    double sampleRate
) {
    std::ostringstream ss;
    auto now = std::chrono::system_clock::now();
    std::time_t nowTime = std::chrono::system_clock::to_time_t(now);
    
    char dateBuf[64];
    std::strftime(dateBuf, sizeof(dateBuf), "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&nowTime));

    std::string pName = projectName.empty() ? "DAW Studio Project" : std::string(projectName);

    // Поиск первого видео
    std::string videoName = "";
    std::string videoPath = "";
    for (const auto& f : files) {
        if (f.type == MediaFileType::Video) {
            videoName = f.fileName;
            videoPath = f.relativePath;
            break;
        }
    }

    ss << "{\n";
    ss << "  \"id\": \"proj_" << std::hex << nowTime << "\",\n";
    ss << "  \"name\": \"" << pName << "\",\n";
    ss << "  \"createdAt\": \"" << dateBuf << "\",\n";
    ss << "  \"updatedAt\": \"" << dateBuf << "\",\n";
    ss << "  \"sampleRate\": " << static_cast<int>(sampleRate) << ",\n";

    if (!videoName.empty()) {
        ss << "  \"videoFile\": {\n";
        ss << "    \"name\": \"" << videoName << "\",\n";
        ss << "    \"relativePath\": \"" << videoPath << "\",\n";
        ss << "    \"durationSec\": 0.0,\n";
        ss << "    \"fps\": 30.0\n";
        ss << "  },\n";
    } else {
        ss << "  \"videoFile\": null,\n";
    }

    // Генерация треков из найденных аудиофайлов
    ss << "  \"tracks\": [\n";
    int trackIdx = 1;
    bool first = true;
    for (const auto& f : files) {
        if (f.type == MediaFileType::Audio) {
            if (!first) ss << ",\n";
            first = false;
            ss << "    {\n";
            ss << "      \"id\": " << trackIdx << ",\n";
            ss << "      \"name\": \"" << f.fileName.substr(0, f.fileName.rfind('.')) << "\",\n";
            ss << "      \"fileName\": \"" << f.relativePath << "\",\n";
            ss << "      \"volumeDb\": 0.0,\n";
            ss << "      \"pan\": 0.0,\n";
            ss << "      \"solo\": false,\n";
            ss << "      \"mute\": false,\n";
            ss << "      \"offsetSec\": 0.0\n";
            ss << "    }";
            trackIdx++;
        }
    }
    ss << "\n  ],\n";

    ss << "  \"master\": {\n";
    ss << "    \"volumeDb\": 0.0,\n";
    ss << "    \"limiterEnabled\": true,\n";
    ss << "    \"limiterCeilingDb\": -0.1\n";
    ss << "  },\n";
    ss << "  \"subtitles\": []\n";
    ss << "}\n";

    return ss.str();
}

} // namespace DAWCore
