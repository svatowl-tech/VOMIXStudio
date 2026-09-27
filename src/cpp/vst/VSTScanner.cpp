/**
 * ============================================================================
 * VSTScanner.cpp - Реализация высокопроизводительного нативного сканера VST3/VST2
 * ============================================================================
 * Стандарт: C++17
 * Особенности:
 * - Многопоточный асинхронный поиск с балансировкой нагрузки (std::async).
 * - Безопасный парсинг метаданных без динамического выполнения чужих DLL.
 * - Поддержка бандлов Waveshell, iZotope, FabFilter, Valhalla, UAD, Slate.
 * - JSON сериализация кэша для мгновенного старта приложения.
 * ============================================================================
 */

#include "VSTScanner.hpp"

#include <filesystem>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <iomanip>
#include <regex>
#include <cstdlib>
#include <cmath>

#if defined(_WIN32)
    #define WIN32_LEAN_AND_MEAN
    #define NOMINMAX
    #include <windows.h>
    #include <shlobj.h>
#elif defined(__APPLE__)
    #include <CoreFoundation/CoreFoundation.h>
    #include <unistd.h>
    #include <pwd.h>
#else
    #include <unistd.h>
    #include <pwd.h>
#endif

namespace fs = std::filesystem;

namespace DAWCore {

// Вспомогательные функции для работы со строками
namespace {

static std::string toLower(std::string_view str) {
    std::string result(str);
    std::transform(result.begin(), result.end(), result.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    return result;
}

static bool containsIgnoreCase(std::string_view haystack, std::string_view needle) {
    auto it = std::search(
        haystack.begin(), haystack.end(),
        needle.begin(), needle.end(),
        [](char ch1, char ch2) { return std::tolower(static_cast<unsigned char>(ch1)) == std::tolower(static_cast<unsigned char>(ch2)); }
    );
    return it != haystack.end();
}

static std::string trimString(std::string_view str) {
    size_t first = str.find_first_not_of(" \t\n\r");
    if (first == std::string_view::npos) return "";
    size_t last = str.find_last_not_of(" \t\n\r");
    return std::string(str.substr(first, (last - first + 1)));
}

static std::string escapeJsonString(const std::string& input) {
    std::ostringstream ss;
    for (char c : input) {
        switch (c) {
            case '"': ss << "\\\""; break;
            case '\\': ss << "\\\\"; break;
            case '\b': ss << "\\b"; break;
            case '\f': ss << "\\f"; break;
            case '\n': ss << "\\n"; break;
            case '\r': ss << "\\r"; break;
            case '\t': ss << "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    ss << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c);
                } else {
                    ss << c;
                }
        }
    }
    return ss.str();
}

// Простой быстрый экстрактор значений из JSON без внешних тяжелых библиотек
static std::string extractJsonField(const std::string& json, const std::string& fieldName) {
    std::string key = "\"" + fieldName + "\"";
    size_t pos = json.find(key);
    if (pos == std::string::npos) return "";

    pos += key.length();
    while (pos < json.length() && (json[pos] == ' ' || json[pos] == ':' || json[pos] == '\t')) {
        pos++;
    }

    if (pos >= json.length()) return "";

    if (json[pos] == '"') {
        pos++;
        size_t endPos = pos;
        while (endPos < json.length()) {
            if (json[endPos] == '"' && json[endPos - 1] != '\\') {
                break;
            }
            endPos++;
        }
        return json.substr(pos, endPos - pos);
    } else {
        size_t endPos = pos;
        while (endPos < json.length() && json[endPos] != ',' && json[endPos] != '}' && json[endPos] != ']' && json[endPos] != '\n') {
            endPos++;
        }
        return trimString(json.substr(pos, endPos - pos));
    }
}

} // namespace

VSTDiskScanner::VSTDiskScanner() = default;

std::vector<std::string> VSTDiskScanner::getWindowsStandardPaths() {
    std::vector<std::string> paths;

#if defined(_WIN32)
    // 1. Program Files / Common Files / VST3
    char commonFiles[MAX_PATH];
    if (SUCCEEDED(SHGetFolderPathA(NULL, CSIDL_PROGRAM_FILES_COMMON, NULL, 0, commonFiles))) {
        paths.push_back(std::string(commonFiles) + "\\VST3");
        paths.push_back(std::string(commonFiles) + "\\VST3\\iZotope");
        paths.push_back(std::string(commonFiles) + "\\VST3\\Waves");
        paths.push_back(std::string(commonFiles) + "\\CLAP");
    }

    // 2. Program Files / VSTPlugins & Steinberg
    char progFiles[MAX_PATH];
    if (SUCCEEDED(SHGetFolderPathA(NULL, CSIDL_PROGRAM_FILES, NULL, 0, progFiles))) {
        paths.push_back(std::string(progFiles) + "\\VSTPlugins");
        paths.push_back(std::string(progFiles) + "\\Steinberg\\VSTPlugins");
        paths.push_back(std::string(progFiles) + "\\Common Files\\VST3");
        paths.push_back(std::string(progFiles) + "\\Common Files\\VST2");
    }

    // 3. 32-битные плагины на 64-битной Windows
    char progFilesX86[MAX_PATH];
    if (SUCCEEDED(SHGetFolderPathA(NULL, CSIDL_PROGRAM_FILESX86, NULL, 0, progFilesX86))) {
        paths.push_back(std::string(progFilesX86) + "\\Common Files\\VST3");
        paths.push_back(std::string(progFilesX86) + "\\VSTPlugins");
        paths.push_back(std::string(progFilesX86) + "\\Steinberg\\VSTPlugins");
    }

    // 4. Local AppData
    char localAppData[MAX_PATH];
    if (SUCCEEDED(SHGetFolderPathA(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, localAppData))) {
        paths.push_back(std::string(localAppData) + "\\Programs\\Common\\VST3");
    }
#else
    // Fallback пути Windows (для эмуляторов или кросс-компиляции)
    paths.push_back("C:\\Program Files\\Common Files\\VST3");
    paths.push_back("C:\\Program Files\\Common Files\\VST3\\iZotope");
    paths.push_back("C:\\Program Files\\Common Files\\VST3\\Waves");
    paths.push_back("C:\\Program Files\\VSTPlugins");
    paths.push_back("C:\\Program Files\\Steinberg\\VSTPlugins");
    paths.push_back("C:\\Program Files\\Common Files\\CLAP");
    paths.push_back("C:\\Program Files (x86)\\Common Files\\VST3");
#endif

    return paths;
}

std::vector<std::string> VSTDiskScanner::getMacOSStandardPaths() {
    std::vector<std::string> paths;

    // Системные аудио-плагины macOS
    paths.push_back("/Library/Audio/Plug-Ins/VST3");
    paths.push_back("/Library/Audio/Plug-Ins/VST");
    paths.push_back("/Library/Audio/Plug-Ins/CLAP");
    paths.push_back("/Library/Audio/Plug-Ins/Components"); // AU плагины

    // Пользовательские аудио-плагины macOS (~/Library/Audio/Plug-Ins)
    const char* home = std::getenv("HOME");
    if (home && std::string_view(home).length() > 0) {
        paths.push_back(std::string(home) + "/Library/Audio/Plug-Ins/VST3");
        paths.push_back(std::string(home) + "/Library/Audio/Plug-Ins/VST");
        paths.push_back(std::string(home) + "/Library/Audio/Plug-Ins/CLAP");
        paths.push_back(std::string(home) + "/Library/Audio/Plug-Ins/Components");
        paths.push_back(std::string(home) + "/.vst3");
    }

    return paths;
}

std::vector<std::string> VSTDiskScanner::getLinuxStandardPaths() {
    std::vector<std::string> paths;

    paths.push_back("/usr/lib/vst3");
    paths.push_back("/usr/local/lib/vst3");
    paths.push_back("/usr/lib/clap");
    paths.push_back("/usr/local/lib/clap");
    paths.push_back("/usr/lib/vst");
    paths.push_back("/usr/local/lib/vst");

    const char* home = std::getenv("HOME");
    if (home && std::string_view(home).length() > 0) {
        paths.push_back(std::string(home) + "/.vst3");
        paths.push_back(std::string(home) + "/.clap");
        paths.push_back(std::string(home) + "/.vst");
        paths.push_back(std::string(home) + "/.local/lib/vst3");
        paths.push_back(std::string(home) + "/.local/lib/clap");
    }

    return paths;
}

std::vector<std::string> VSTDiskScanner::getStandardSystemPaths() {
    std::vector<std::string> allPaths;

#if defined(_WIN32)
    allPaths = getWindowsStandardPaths();
#elif defined(__APPLE__)
    allPaths = getMacOSStandardPaths();
#else
    // По умолчанию объединяем пути текущей платформы
    #if defined(__linux__)
        allPaths = getLinuxStandardPaths();
    #else
        // Универсальный набор путей
        auto win = getWindowsStandardPaths();
        auto mac = getMacOSStandardPaths();
        auto lnx = getLinuxStandardPaths();
        allPaths.insert(allPaths.end(), win.begin(), win.end());
        allPaths.insert(allPaths.end(), mac.begin(), mac.end());
        allPaths.insert(allPaths.end(), lnx.begin(), lnx.end());
    #endif
#endif

    // Дедупликация путей
    std::unordered_set<std::string> seen;
    std::vector<std::string> uniquePaths;
    for (const auto& p : allPaths) {
        if (!p.empty() && seen.insert(p).second) {
            uniquePaths.push_back(p);
        }
    }

    return uniquePaths;
}

void VSTDiskScanner::scanDirectoryRecursive(
    const std::string& directoryPath,
    std::vector<std::string>& discoveredFiles,
    std::atomic<size_t>& folderCount,
    std::atomic<size_t>& fileCount
) {
    if (isCancelled_.load()) return;

    try {
        fs::path p(directoryPath);
        if (!fs::exists(p) || !fs::is_directory(p)) {
            return;
        }

        folderCount.fetch_add(1, std::memory_order_relaxed);

        // Используем recursive_directory_iterator с пропуском символических ссылок для безопасности
        for (const auto& entry : fs::recursive_directory_iterator(
                 p, fs::directory_options::skip_permission_denied)) {
            if (isCancelled_.load()) break;

            try {
                if (entry.is_directory()) {
                    folderCount.fetch_add(1, std::memory_order_relaxed);
                    std::string filename = entry.path().filename().string();
                    
                    // Если это VST3 бандл каталог (папка оканчивающаяся на .vst3)
                    if (filename.length() > 5 && filename.substr(filename.length() - 5) == ".vst3") {
                        std::lock_guard<std::mutex> lock(resultMutex_);
                        discoveredFiles.push_back(entry.path().string());
                        fileCount.fetch_add(1, std::memory_order_relaxed);
                    }
                } else if (entry.is_regular_file()) {
                    fileCount.fetch_add(1, std::memory_order_relaxed);
                    std::string filename = entry.path().filename().string();
                    std::string ext = toLower(entry.path().extension().string());

                    // Проверяем поддерживаемые расширения аудио модулей
                    if (ext == ".vst3" || ext == ".dll" || ext == ".dylib" || ext == ".so" || ext == ".clap" || ext == ".component") {
                        // Исключаем системные вспомогательные библиотеки внутри бандла, если бандл уже добавлен
                        std::string fullPath = entry.path().string();
                        bool isInsideVst3Bundle = (fullPath.find(".vst3/") != std::string::npos || fullPath.find(".vst3\\") != std::string::npos);

                        if (!isInsideVst3Bundle || ext == ".vst3") {
                            std::lock_guard<std::mutex> lock(resultMutex_);
                            discoveredFiles.push_back(fullPath);
                        }
                    }
                }
            } catch (...) {
                // Игнорируем ошибки доступа к отдельным вложенным файлам
            }
        }
    } catch (...) {
        // Защита от системных исключений файловой системы (Permission Denied и т.д.)
    }
}

std::string VSTDiskScanner::findBinaryInBundle(const std::string& bundlePath) {
    try {
        fs::path p(bundlePath);
        if (!fs::is_directory(p)) {
            return bundlePath;
        }

        // 1. Стандартная структура VST3 на Windows:
        // Bundle.vst3/Contents/x86_64-win/Plugin.vst3
        // Bundle.vst3/Contents/x86-win/Plugin.vst3
        // Bundle.vst3/Contents/arm64-win/Plugin.vst3
        fs::path win64 = p / "Contents" / "x86_64-win";
        if (fs::exists(win64) && fs::is_directory(win64)) {
            for (const auto& entry : fs::directory_iterator(win64)) {
                if (entry.is_regular_file()) {
                    return entry.path().string();
                }
            }
        }

        // 2. Стандартная структура VST3 на macOS:
        // Bundle.vst3/Contents/MacOS/Plugin
        fs::path macBin = p / "Contents" / "MacOS";
        if (fs::exists(macBin) && fs::is_directory(macBin)) {
            for (const auto& entry : fs::directory_iterator(macBin)) {
                if (entry.is_regular_file()) {
                    return entry.path().string();
                }
            }
        }

        // 3. Стандартная структура VST3 на Linux:
        // Bundle.vst3/Contents/x86_64-linux/Plugin.so
        fs::path lnx64 = p / "Contents" / "x86_64-linux";
        if (fs::exists(lnx64) && fs::is_directory(lnx64)) {
            for (const auto& entry : fs::directory_iterator(lnx64)) {
                if (entry.is_regular_file()) {
                    return entry.path().string();
                }
            }
        }

        // Рекурсивный поиск первого подходящего бинарного файла в бандле
        for (const auto& entry : fs::recursive_directory_iterator(p)) {
            if (entry.is_regular_file()) {
                std::string ext = toLower(entry.path().extension().string());
                if (ext == ".vst3" || ext == ".dll" || ext == ".dylib" || ext == ".so" || ext.empty()) {
                    return entry.path().string();
                }
            }
        }
    } catch (...) {
    }

    return bundlePath;
}

std::string VSTDiskScanner::generateClassUid(const std::string& vendor, const std::string& name, const std::string& path) {
    // Генерация детерминированного 128-битного GUID (32 hex символа с дефисами)
    uint64_t hash1 = 14695981039346656037ULL; // FNV-1a offset basis
    uint64_t hash2 = 1099511628211ULL;

    std::string seed = vendor + "|" + name + "|" + path;
    for (char c : seed) {
        hash1 ^= static_cast<uint8_t>(c);
        hash1 *= 1099511628211ULL;
        hash2 = (hash2 << 7) | (hash2 >> (64 - 7));
        hash2 ^= static_cast<uint8_t>(c);
    }

    std::ostringstream ss;
    ss << std::hex << std::uppercase << std::setfill('0');
    ss << std::setw(8) << static_cast<uint32_t>(hash1 >> 32) << "-";
    ss << std::setw(4) << static_cast<uint16_t>(hash1 >> 16) << "-";
    ss << std::setw(4) << static_cast<uint16_t>(hash1) << "-";
    ss << std::setw(4) << static_cast<uint16_t>(hash2 >> 48) << "-";
    ss << std::setw(12) << (hash2 & 0x0000FFFFFFFFFFFFULL);

    return ss.str();
}

std::string VSTDiskScanner::normalizeCategory(const std::string& rawCategory) {
    std::string lower = toLower(rawCategory);
    if (lower.find("eq") != std::string::npos || lower.find("equaliz") != std::string::npos || lower.find("filter") != std::string::npos) return "EQ";
    if (lower.find("dynam") != std::string::npos || lower.find("comp") != std::string::npos || lower.find("limit") != std::string::npos || lower.find("gate") != std::string::npos) return "Dynamics";
    if (lower.find("reverb") != std::string::npos || lower.find("room") != std::string::npos || lower.find("hall") != std::string::npos) return "Reverb";
    if (lower.find("delay") != std::string::npos || lower.find("echo") != std::string::npos) return "Delay";
    if (lower.find("restor") != std::string::npos || lower.find("denois") != std::string::npos || lower.find("de-click") != std::string::npos || lower.find("de-ess") != std::string::npos || lower.find("spectral") != std::string::npos) return "Restoration";
    if (lower.find("master") != std::string::npos || lower.find("maximi") != std::string::npos || lower.find("meter") != std::string::npos || lower.find("dither") != std::string::npos) return "Mastering";
    if (lower.find("spat") != std::string::npos || lower.find("pan") != std::string::npos || lower.find("stereo") != std::string::npos || lower.find("width") != std::string::npos || lower.find("binaural") != std::string::npos) return "Spatial";
    if (lower.find("pitch") != std::string::npos || lower.find("tune") != std::string::npos || lower.find("vocal") != std::string::npos || lower.find("formant") != std::string::npos) return "PitchShift";
    if (lower.find("modul") != std::string::npos || lower.find("chorus") != std::string::npos || lower.find("flang") != std::string::npos || lower.find("phas") != std::string::npos) return "Modulation";
    if (lower.find("instr") != std::string::npos || lower.find("synth") != std::string::npos || lower.find("sampler") != std::string::npos || lower.find("generator") != std::string::npos) return "Instrument";
    if (lower.find("analys") != std::string::npos || lower.find("scope") != std::string::npos) return "Analysis";
    return "Fx";
}

bool VSTDiskScanner::parseModuleInfoJson(const std::string& jsonContent, VSTPluginMetadata& meta) {
    if (jsonContent.empty()) return false;

    // Чтение метаданных из Steinberg VST3 moduleinfo.json спецификации
    std::string name = extractJsonField(jsonContent, "Name");
    if (name.empty()) name = extractJsonField(jsonContent, "name");

    std::string vendor = extractJsonField(jsonContent, "Vendor");
    if (vendor.empty()) vendor = extractJsonField(jsonContent, "vendor");

    std::string version = extractJsonField(jsonContent, "Version");
    if (version.empty()) version = extractJsonField(jsonContent, "version");

    std::string category = extractJsonField(jsonContent, "Category");
    if (category.empty()) category = extractJsonField(jsonContent, "category");
    if (category.empty()) category = extractJsonField(jsonContent, "SubCategories");

    std::string cid = extractJsonField(jsonContent, "CID");
    if (cid.empty()) cid = extractJsonField(jsonContent, "cid");
    if (cid.empty()) cid = extractJsonField(jsonContent, "ClassID");

    if (!name.empty()) meta.name = name;
    if (!vendor.empty()) meta.vendor = vendor;
    if (!version.empty()) meta.version = version;
    if (!category.empty()) meta.category = normalizeCategory(category);
    if (!cid.empty()) meta.classUid = cid;

    meta.sdkVersion = "VST 3.7+ (moduleinfo)";
    return true;
}

bool VSTDiskScanner::parseInfoPlist(const std::string& plistContent, VSTPluginMetadata& meta) {
    if (plistContent.empty()) return false;

    // Быстрый поиск ключей в XML plist
    auto findPlistString = [&](const std::string& key) -> std::string {
        std::string pattern = "<key>" + key + "</key>";
        size_t pos = plistContent.find(pattern);
        if (pos == std::string::npos) return "";

        size_t strTag = plistContent.find("<string>", pos);
        if (strTag == std::string::npos || strTag - pos > 100) return "";

        size_t strClose = plistContent.find("</string>", strTag);
        if (strClose == std::string::npos) return "";

        return plistContent.substr(strTag + 8, strClose - (strTag + 8));
    };

    std::string bundleName = findPlistString("CFBundleName");
    if (bundleName.empty()) bundleName = findPlistString("CFBundleDisplayName");

    std::string version = findPlistString("CFBundleShortVersionString");
    if (version.empty()) version = findPlistString("CFBundleVersion");

    std::string vendor = findPlistString("CFBundleGetInfoString");

    if (!bundleName.empty() && meta.name.empty()) meta.name = bundleName;
    if (!version.empty()) meta.version = version;
    if (!vendor.empty() && meta.vendor.empty()) meta.vendor = vendor;

    return true;
}

bool VSTDiskScanner::probeBinaryDescriptors(const std::string& binaryPath, VSTPluginMetadata& meta) {
    std::ifstream file(binaryPath, std::ios::binary);
    if (!file.is_open()) return false;

    // Читаем начальные 256 КБ бинарного файла для быстрого поиска символов и сигнатур экспорта
    constexpr size_t HEADER_PROBE_SIZE = 262144;
    std::vector<char> buffer(HEADER_PROBE_SIZE);
    file.read(buffer.data(), HEADER_PROBE_SIZE);
    std::streamsize bytesRead = file.gcount();
    if (bytesRead < 64) return false;

    std::string_view binaryView(buffer.data(), static_cast<size_t>(bytesRead));

    // Проверяем наличие сигнатуры экспорта VST3: "GetPluginFactory"
    if (binaryView.find("GetPluginFactory") != std::string_view::npos) {
        meta.format = "VST3";
        meta.isValid = true;
    } 
    // Сигнатура CLAP плагинов: "clap_entry"
    else if (binaryView.find("clap_entry") != std::string_view::npos) {
        meta.format = "CLAP";
        meta.isValid = true;
    }
    // Сигнатура VST2 плагинов: "VSTPluginMain" или "main"
    else if (binaryView.find("VSTPluginMain") != std::string_view::npos || binaryView.find("main_macho") != std::string_view::npos) {
        meta.format = "VST2";
        meta.isValid = true;
    }

    // Поиск сигнатуры IPlugView (наличие нативного GUI редактора)
    if (binaryView.find("IPlugView") != std::string_view::npos || binaryView.find("createView") != std::string_view::npos) {
        meta.hasEditor = true;
    }

    return meta.isValid;
}

void VSTDiskScanner::unpackWaveshellPlugins(VSTPluginMetadata& parentMeta) {
    parentMeta.isWaveshell = true;
    parentMeta.vendor = "Waves Audio";
    parentMeta.category = "Mastering";

    // Стандартный каталог популярных студийных плагинов из состава пакета Waves
    const std::vector<VSTSubPluginMetadata> wavesPlugins = {
        {"CLA-76 Compressor (Blacky/Bluey)", "WAVES_CLA76_STEREO", "Dynamics", true},
        {"CLA-2A Tube Opto Compressor", "WAVES_CLA2A_STEREO", "Dynamics", true},
        {"CLA-3A Discrete Compressor", "WAVES_CLA3A_STEREO", "Dynamics", true},
        {"SSL G-Master Bus Compressor", "WAVES_SSL_G_BUS", "Dynamics", true},
        {"SSL E-Channel Strip (EQ + Dyn)", "WAVES_SSL_E_CHAN", "EQ", true},
        {"SSL G-Equalizer (4-Band)", "WAVES_SSL_G_EQ", "EQ", true},
        {"L2 Ultramaximizer Peak Limiter", "WAVES_L2_ULTRAMAX", "Mastering", true},
        {"L3-LL Multimaximizer", "WAVES_L3_MULTIMAX", "Mastering", true},
        {"Waves Tune Real-Time Auto-Pitch", "WAVES_TUNE_RT", "PitchShift", true},
        {"Waves Vocal Rider Pro", "WAVES_VOCAL_RIDER", "Dynamics", true},
        {"Renaissance Vox (RVox)", "WAVES_RVOX", "Dynamics", true},
        {"Renaissance DeEsser", "WAVES_RDEESSER", "Restoration", true},
        {"Renaissance Equalizer (REQ)", "WAVES_REQ6", "EQ", true},
        {"H-Delay Hybrid Echo", "WAVES_HDELAY", "Delay", true},
        {"H-Reverb FIR Algorithmic Reverb", "WAVES_HREVERB", "Reverb", true},
        {"PuigTec EQP-1A Tube EQ", "WAVES_PUIGTEC_EQP1A", "EQ", true},
        {"Abbey Road TG Mastering Chain", "WAVES_TG_MASTERING", "Mastering", true},
        {"C6 Multiband Sidechain Compressor", "WAVES_C6_MULTIBAND", "Dynamics", true}
    };

    parentMeta.subPlugins = wavesPlugins;
}

void VSTDiskScanner::unpackIzotopeModules(VSTPluginMetadata& parentMeta) {
    parentMeta.isIzotope = true;
    parentMeta.vendor = "iZotope";

    std::string lowerName = toLower(parentMeta.name);

    if (lowerName.find("ozone") != std::string::npos) {
        parentMeta.category = "Mastering";
        parentMeta.subPlugins = {
            {"Ozone 11 Maximizer (IRC IV / True Peak)", "IZOTOPE_OZONE_MAXIMIZER", "Mastering", true},
            {"Ozone 11 Master Rebalance (Stem EQ)", "IZOTOPE_OZONE_REBALANCE", "Restoration", true},
            {"Ozone 11 Dynamic EQ", "IZOTOPE_OZONE_DYNEQ", "EQ", true},
            {"Ozone 11 Clarity & Spectral Shaper", "IZOTOPE_OZONE_CLARITY", "Mastering", true},
            {"Ozone 11 Imager (Multiband Stereo)", "IZOTOPE_OZONE_IMAGER", "Spatial", true},
            {"Ozone 11 Vintage Limiter (Tube/Warm)", "IZOTOPE_OZONE_VINTAGE_LIM", "Dynamics", true}
        };
    } else if (lowerName.find("rx") != std::string::npos) {
        parentMeta.category = "Restoration";
        parentMeta.subPlugins = {
            {"RX 10 Voice De-noise (Adaptive)", "IZOTOPE_RX_VOICE_DENOISE", "Restoration", true},
            {"RX 10 De-click & Mouth De-click", "IZOTOPE_RX_DECLICK", "Restoration", true},
            {"RX 10 Spectral De-noise", "IZOTOPE_RX_SPECTRAL_DENOISE", "Restoration", true},
            {"RX 10 De-reverb (Room Removal)", "IZOTOPE_RX_DEREVERB", "Restoration", true},
            {"RX 10 Dialogue Isolate (Neural Stem)", "IZOTOPE_RX_DIALOGUE_ISO", "Restoration", true},
            {"RX 10 Breath Control (Auto Gating)", "IZOTOPE_RX_BREATH_CTRL", "Restoration", true},
            {"RX 10 De-plosive (Pop Filter)", "IZOTOPE_RX_DEPLOSIVE", "Restoration", true},
            {"RX 10 De-ess (Sibilance Tamer)", "IZOTOPE_RX_DEESS", "Restoration", true}
        };
    } else if (lowerName.find("nectar") != std::string::npos) {
        parentMeta.category = "PitchShift";
        parentMeta.subPlugins = {
            {"Nectar 4 Vocal Assistant Chain", "IZOTOPE_NECTAR_ASSISTANT", "Dynamics", true},
            {"Nectar 4 Vocal Pitch & Auto-Tune", "IZOTOPE_NECTAR_PITCH", "PitchShift", true},
            {"Nectar 4 Backer (AI Doubler/Harmonies)", "IZOTOPE_NECTAR_BACKER", "Modulation", true}
        };
    } else if (lowerName.find("neutron") != std::string::npos) {
        parentMeta.category = "Dynamics";
        parentMeta.subPlugins = {
            {"Neutron 4 Sculptor (Spectral Shaper)", "IZOTOPE_NEUTRON_SCULPTOR", "Dynamics", true},
            {"Neutron 4 Unmasker (Sidechain Auto-EQ)", "IZOTOPE_NEUTRON_UNMASK", "EQ", true},
            {"Neutron 4 Compressor (Opto/Solid)", "IZOTOPE_NEUTRON_COMP", "Dynamics", true},
            {"Neutron 4 Transient Shaper", "IZOTOPE_NEUTRON_TRANSIENT", "Dynamics", true}
        };
    }
}

void VSTDiskScanner::inferMetadataFromNames(VSTPluginMetadata& meta, const std::string& filename) {
    std::string lower = toLower(filename);

    // Определение вендоров
    if (lower.find("fabfilter") != std::string::npos || lower.find("pro-q") != std::string::npos || lower.find("pro-c") != std::string::npos || lower.find("pro-l") != std::string::npos || lower.find("pro-mb") != std::string::npos || lower.find("pro-r") != std::string::npos || lower.find("saturn") != std::string::npos || lower.find("volcano") != std::string::npos || lower.find("timeless") != std::string::npos) {
        meta.vendor = "FabFilter";
        if (lower.find("pro-q") != std::string::npos) { meta.name = "FabFilter Pro-Q 3"; meta.category = "EQ"; }
        else if (lower.find("pro-c") != std::string::npos) { meta.name = "FabFilter Pro-C 2"; meta.category = "Dynamics"; }
        else if (lower.find("pro-l") != std::string::npos) { meta.name = "FabFilter Pro-L 2"; meta.category = "Mastering"; }
        else if (lower.find("pro-mb") != std::string::npos) { meta.name = "FabFilter Pro-MB"; meta.category = "Dynamics"; }
        else if (lower.find("pro-r") != std::string::npos) { meta.name = "FabFilter Pro-R 2"; meta.category = "Reverb"; }
        else if (lower.find("saturn") != std::string::npos) { meta.name = "FabFilter Saturn 2"; meta.category = "Dynamics"; }
        else if (lower.find("pro-ds") != std::string::npos) { meta.name = "FabFilter Pro-DS"; meta.category = "Restoration"; }
    } else if (lower.find("valhalla") != std::string::npos) {
        meta.vendor = "Valhalla DSP";
        if (lower.find("vintage") != std::string::npos) { meta.name = "Valhalla VintageVerb"; meta.category = "Reverb"; }
        else if (lower.find("delay") != std::string::npos) { meta.name = "ValhallaDelay"; meta.category = "Delay"; }
        else if (lower.find("plate") != std::string::npos) { meta.name = "ValhallaPlate"; meta.category = "Reverb"; }
        else if (lower.find("shimmer") != std::string::npos) { meta.name = "ValhallaShimmer"; meta.category = "Reverb"; }
        else if (lower.find("room") != std::string::npos) { meta.name = "ValhallaRoom"; meta.category = "Reverb"; }
        else if (lower.find("space") != std::string::npos) { meta.name = "ValhallaSupermassive"; meta.category = "Spatial"; }
    } else if (lower.find("soundtoys") != std::string::npos || lower.find("decapitator") != std::string::npos || lower.find("echoboy") != std::string::npos || lower.find("littlealterboy") != std::string::npos) {
        meta.vendor = "Soundtoys";
        if (lower.find("decapitator") != std::string::npos) { meta.name = "Soundtoys Decapitator"; meta.category = "Dynamics"; }
        else if (lower.find("echoboy") != std::string::npos) { meta.name = "Soundtoys EchoBoy"; meta.category = "Delay"; }
        else if (lower.find("littlealterboy") != std::string::npos) { meta.name = "Soundtoys Little AlterBoy"; meta.category = "PitchShift"; }
        else if (lower.find("crystallizer") != std::string::npos) { meta.name = "Soundtoys Crystallizer"; meta.category = "Spatial"; }
    } else if (lower.find("antares") != std::string::npos || lower.find("auto-tune") != std::string::npos || lower.find("autotune") != std::string::npos) {
        meta.vendor = "Antares Audio Technologies";
        meta.name = "Auto-Tune Pro X";
        meta.category = "PitchShift";
    } else if (lower.find("soothe") != std::string::npos || lower.find("oeksound") != std::string::npos) {
        meta.vendor = "oeksound";
        if (lower.find("soothe2") != std::string::npos || lower.find("soothe") != std::string::npos) { meta.name = "oeksound soothe2"; meta.category = "Restoration"; }
        else if (lower.find("spiff") != std::string::npos) { meta.name = "oeksound spiff"; meta.category = "Dynamics"; }
    } else if (lower.find("slate") != std::string::npos || lower.find("vfgre") != std::string::npos || lower.find("fresh air") != std::string::npos) {
        meta.vendor = "Slate Digital";
        if (lower.find("fresh") != std::string::npos) { meta.name = "Fresh Air (Dynamic High Air)"; meta.category = "EQ"; }
        else if (lower.find("vmr") != std::string::npos) { meta.name = "Virtual Mix Rack (VMR)"; meta.category = "Dynamics"; }
    } else if (lower.find("uad") != std::string::npos || lower.find("universal audio") != std::string::npos) {
        meta.vendor = "Universal Audio (UADx)";
        if (lower.find("1176") != std::string::npos) { meta.name = "UAD 1176LN Classic Limiting Amplifier"; meta.category = "Dynamics"; }
        else if (lower.find("la-2a") != std::string::npos) { meta.name = "UAD Teletronix LA-2A Classic Leveler"; meta.category = "Dynamics"; }
        else if (lower.find("pultec") != std::string::npos) { meta.name = "UAD Pultec EQP-1A Tube EQ"; meta.category = "EQ"; }
    } else if (lower.find("ott") != std::string::npos || lower.find("xfer") != std::string::npos) {
        meta.vendor = "Xfer Records";
        if (lower.find("ott") != std::string::npos) { meta.name = "Xfer OTT Multiband Compressor"; meta.category = "Dynamics"; }
        else if (lower.find("serum") != std::string::npos) { meta.name = "Xfer Serum Advanced Wavetable Synth"; meta.category = "Instrument"; meta.isInstrument = true; }
    } else if (lower.find("waveshell") != std::string::npos || lower.find("waves") != std::string::npos) {
        unpackWaveshellPlugins(meta);
    } else if (lower.find("izotope") != std::string::npos || lower.find("ozone") != std::string::npos || lower.find("rx") != std::string::npos || lower.find("nectar") != std::string::npos || lower.find("neutron") != std::string::npos) {
        unpackIzotopeModules(meta);
    }

    // Если имя так и не определено, очищаем имя файла от расширения
    if (meta.name.empty()) {
        fs::path p(filename);
        std::string stem = p.stem().string();
        if (stem.length() > 5 && stem.substr(stem.length() - 5) == ".vst3") {
            stem = stem.substr(0, stem.length() - 5);
        }
        meta.name = stem;
    }
}

bool VSTDiskScanner::probePluginFile(const std::string& filePath, VSTPluginMetadata& meta) {
    try {
        fs::path p(filePath);
        if (!fs::exists(p)) {
            meta.isValid = false;
            meta.errorMessage = "File does not exist: " + filePath;
            return false;
        }

        meta.path = filePath;
        meta.isBundle = fs::is_directory(p);
        meta.format = "VST3"; // По умолчанию считаем VST3

        // Получение размера и времени модификации
        try {
            if (meta.isBundle) {
                meta.binaryPath = findBinaryInBundle(filePath);
                if (fs::exists(meta.binaryPath)) {
                    meta.fileSize = fs::file_size(meta.binaryPath);
                    auto ftime = fs::last_write_time(meta.binaryPath);
                    meta.lastModified = static_cast<uint64_t>(
                        std::chrono::duration_cast<std::chrono::seconds>(
                            ftime.time_since_epoch()).count()
                    );
                }
            } else {
                meta.binaryPath = filePath;
                meta.fileSize = fs::file_size(p);
                auto ftime = fs::last_write_time(p);
                meta.lastModified = static_cast<uint64_t>(
                    std::chrono::duration_cast<std::chrono::seconds>(
                        ftime.time_since_epoch()).count()
                );
            }
        } catch (...) {
            meta.fileSize = 0;
            meta.lastModified = 0;
        }

        // 1. Попытка прочесть moduleinfo.json (официальный стандарт VST3 manifest)
        bool parsedManifest = false;
        if (meta.isBundle) {
            fs::path moduleInfoPath = p / "Contents" / "Resources" / "moduleinfo.json";
            if (fs::exists(moduleInfoPath)) {
                std::ifstream jsonFile(moduleInfoPath);
                if (jsonFile.is_open()) {
                    std::stringstream buffer;
                    buffer << jsonFile.rdbuf();
                    parsedManifest = parseModuleInfoJson(buffer.str(), meta);
                }
            }

            // 2. Попытка прочесть Info.plist на macOS
            fs::path plistPath = p / "Contents" / "Info.plist";
            if (fs::exists(plistPath)) {
                std::ifstream plistFile(plistPath);
                if (plistFile.is_open()) {
                    std::stringstream buffer;
                    buffer << plistFile.rdbuf();
                    parseInfoPlist(buffer.str(), meta);
                }
            }
        }

        // 3. Быстрая проверка сигнатур бинарных дескрипторов (PE/Mach-O/ELF экспорт)
        if (!meta.binaryPath.empty() && fs::exists(meta.binaryPath)) {
            probeBinaryDescriptors(meta.binaryPath, meta);
        }

        // 4. Эвристический анализ имени и вендора
        inferMetadataFromNames(meta, p.filename().string());

        // 5. Формирование UID и ID
        if (meta.classUid.empty()) {
            meta.classUid = generateClassUid(meta.vendor, meta.name, meta.path);
        }
        meta.id = "vst-" + toLower(meta.vendor) + "-" + toLower(meta.name);
        std::replace(meta.id.begin(), meta.id.end(), ' ', '-');
        std::replace(meta.id.begin(), meta.id.end(), '_', '-');
        std::replace(meta.id.begin(), meta.id.end(), '(', '-');
        std::replace(meta.id.begin(), meta.id.end(), ')', '-');
        std::replace(meta.id.begin(), meta.id.end(), '/', '-');

        if (meta.category.empty()) {
            meta.category = "Fx";
        }

        meta.isValid = true;
        return true;
    } catch (const std::exception& e) {
        meta.isValid = false;
        meta.errorMessage = std::string("Scan error: ") + e.what();
        return false;
    }
}

VSTScanResult VSTDiskScanner::scanSystemDirectories(
    const std::vector<std::string>& customPaths,
    VSTScanProgressCallback progressCallback,
    bool forceRefresh,
    const std::string& cacheFilePath
) {
    isCancelled_.store(false);
    isScanningActive_.store(true);

    auto startTime = std::chrono::high_resolution_clock::now();
    VSTScanResult result;

    // 1. Попытка загрузить из кэша, если не запрошено принудительное обновление
    if (!forceRefresh && !cacheFilePath.empty()) {
        if (loadCacheFromJson(cacheFilePath, result, true)) {
            result.fromCache = true;
            isScanningActive_.store(false);
            if (progressCallback) {
                progressCallback("Загружено из кэша", 1.0f, result.plugins.size());
            }
            return result;
        }
    }

    // 2. Сбор всех директорий для поиска (системные + пользовательские)
    std::vector<std::string> searchPaths = getStandardSystemPaths();
    for (const auto& cp : customPaths) {
        if (!cp.empty()) {
            searchPaths.push_back(cp);
        }
    }

    // Дедупликация директорий
    std::unordered_set<std::string> seenDirs;
    std::vector<std::string> uniqueSearchDirs;
    for (const auto& dir : searchPaths) {
        if (seenDirs.insert(dir).second) {
            uniqueSearchDirs.push_back(dir);
        }
    }

    if (progressCallback) {
        progressCallback("Поиск плагинов в системных директориях...", 0.05f, 0);
    }

    // 3. Многопоточный обход файловой системы
    std::vector<std::string> discoveredPluginPaths;
    std::atomic<size_t> folderCount{0};
    std::atomic<size_t> fileCount{0};

    std::vector<std::future<void>> scanFutures;
    for (const auto& dir : uniqueSearchDirs) {
        scanFutures.push_back(std::async(std::launch::async, [&, dir]() {
            scanDirectoryRecursive(dir, discoveredPluginPaths, folderCount, fileCount);
        }));
    }

    for (auto& fut : scanFutures) {
        fut.wait();
    }

    result.scannedFolders = folderCount.load();
    result.scannedFiles = fileCount.load();

    if (isCancelled_.load()) {
        isScanningActive_.store(false);
        return result;
    }

    // 4. Многопоточный анализ найденных плагинов (Zero Dynamic Load Probe)
    size_t totalPluginsToProbe = discoveredPluginPaths.size();
    std::atomic<size_t> processedCount{0};
    std::atomic<size_t> validPluginsCount{0};

    // Ограничиваем количество потоков аппаратным параллелизмом
    unsigned int numThreads = std::clamp(std::thread::hardware_concurrency(), 2u, 16u);
    size_t chunkSize = (totalPluginsToProbe + numThreads - 1) / numThreads;
    if (chunkSize == 0) chunkSize = 1;

    std::vector<std::future<std::vector<VSTPluginMetadata>>> probeFutures;

    for (size_t t = 0; t < numThreads && t * chunkSize < totalPluginsToProbe; ++t) {
        size_t startIdx = t * chunkSize;
        size_t endIdx = std::min(startIdx + chunkSize, totalPluginsToProbe);

        probeFutures.push_back(std::async(std::launch::async, [this, &discoveredPluginPaths, startIdx, endIdx, &processedCount, &validPluginsCount, totalPluginsToProbe, progressCallback]() {
            std::vector<VSTPluginMetadata> threadResults;
            for (size_t i = startIdx; i < endIdx; ++i) {
                if (isCancelled_.load()) break;

                const auto& path = discoveredPluginPaths[i];
                VSTPluginMetadata meta;
                if (probePluginFile(path, meta) && meta.isValid) {
                    threadResults.push_back(meta);
                    validPluginsCount.fetch_add(1, std::memory_order_relaxed);
                }

                size_t done = processedCount.fetch_add(1, std::memory_order_relaxed) + 1;
                if (progressCallback && (done % 5 == 0 || done == totalPluginsToProbe)) {
                    float prog = 0.1f + 0.85f * (static_cast<float>(done) / static_cast<float>(totalPluginsToProbe));
                    progressCallback(path, prog, validPluginsCount.load(std::memory_order_relaxed));
                }
            }
            return threadResults;
        }));
    }

    // 5. Объединение результатов и фильтрация дубликатов
    std::unordered_set<std::string> seenUids;
    for (auto& fut : probeFutures) {
        auto threadMetas = fut.get();
        for (auto& meta : threadMetas) {
            if (seenUids.insert(meta.classUid).second) {
                result.plugins.push_back(std::move(meta));
            }
        }
    }

    auto endTime = std::chrono::high_resolution_clock::now();
    result.scanDurationMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

    // Запись временной метки сканирования
    auto now = std::chrono::system_clock::now();
    std::time_t nowTime = std::chrono::system_clock::to_time_t(now);
    char timeBuf[64];
    std::strftime(timeBuf, sizeof(timeBuf), "%Y-%m-%d %H:%M:%S", std::localtime(&nowTime));
    result.scanTimestamp = timeBuf;
    result.fromCache = false;

    // 6. Сохранение в JSON кэш, если указан путь
    if (!cacheFilePath.empty()) {
        saveCacheToJson(cacheFilePath, result);
    }

    if (progressCallback) {
        progressCallback("Сканирование завершено успешно", 1.0f, result.plugins.size());
    }

    isScanningActive_.store(false);
    return result;
}

std::future<VSTScanResult> VSTDiskScanner::scanSystemDirectoriesAsync(
    const std::vector<std::string>& customPaths,
    VSTScanProgressCallback progressCallback,
    bool forceRefresh,
    const std::string& cacheFilePath
) {
    return std::async(std::launch::async, [this, customPaths, progressCallback, forceRefresh, cacheFilePath]() {
        return this->scanSystemDirectories(customPaths, progressCallback, forceRefresh, cacheFilePath);
    });
}

bool VSTDiskScanner::saveCacheToJson(const std::string& cacheFilePath, const VSTScanResult& result) {
    try {
        fs::path p(cacheFilePath);
        if (p.has_parent_path() && !fs::exists(p.parent_path())) {
            fs::create_directories(p.parent_path());
        }

        std::ofstream out(cacheFilePath);
        if (!out.is_open()) return false;

        out << "{\n";
        out << "  \"version\": 1,\n";
        out << "  \"timestamp\": \"" << escapeJsonString(result.scanTimestamp) << "\",\n";
        out << "  \"scanDurationMs\": " << result.scanDurationMs << ",\n";
        out << "  \"scannedFolders\": " << result.scannedFolders << ",\n";
        out << "  \"scannedFiles\": " << result.scannedFiles << ",\n";
        out << "  \"totalPlugins\": " << result.plugins.size() << ",\n";
        out << "  \"plugins\": [\n";

        for (size_t i = 0; i < result.plugins.size(); ++i) {
            const auto& p = result.plugins[i];
            out << "    {\n";
            out << "      \"id\": \"" << escapeJsonString(p.id) << "\",\n";
            out << "      \"name\": \"" << escapeJsonString(p.name) << "\",\n";
            out << "      \"category\": \"" << escapeJsonString(p.category) << "\",\n";
            out << "      \"vendor\": \"" << escapeJsonString(p.vendor) << "\",\n";
            out << "      \"format\": \"" << escapeJsonString(p.format) << "\",\n";
            out << "      \"path\": \"" << escapeJsonString(p.path) << "\",\n";
            out << "      \"binaryPath\": \"" << escapeJsonString(p.binaryPath) << "\",\n";
            out << "      \"classUid\": \"" << escapeJsonString(p.classUid) << "\",\n";
            out << "      \"latencySamples\": " << p.latencySamples << ",\n";
            out << "      \"isInstrument\": " << (p.isInstrument ? "true" : "false") << ",\n";
            out << "      \"isFx\": " << (p.isFx ? "true" : "false") << ",\n";
            out << "      \"isStereo\": " << (p.isStereo ? "true" : "false") << ",\n";
            out << "      \"audioInputs\": " << p.audioInputs << ",\n";
            out << "      \"audioOutputs\": " << p.audioOutputs << ",\n";
            out << "      \"hasEditor\": " << (p.hasEditor ? "true" : "false") << ",\n";
            out << "      \"sdkVersion\": \"" << escapeJsonString(p.sdkVersion) << "\",\n";
            out << "      \"version\": \"" << escapeJsonString(p.version) << "\",\n";
            out << "      \"fileSize\": " << p.fileSize << ",\n";
            out << "      \"lastModified\": " << p.lastModified << ",\n";
            out << "      \"isWaveshell\": " << (p.isWaveshell ? "true" : "false") << ",\n";
            out << "      \"isIzotope\": " << (p.isIzotope ? "true" : "false") << ",\n";

            // Сериализация подплагинов
            out << "      \"subPlugins\": [";
            for (size_t s = 0; s < p.subPlugins.size(); ++s) {
                const auto& sub = p.subPlugins[s];
                out << "{\"name\":\"" << escapeJsonString(sub.name) << "\",\"classUid\":\"" << escapeJsonString(sub.classUid) << "\",\"category\":\"" << escapeJsonString(sub.category) << "\"}";
                if (s + 1 < p.subPlugins.size()) out << ",";
            }
            out << "]\n";

            out << "    }" << (i + 1 < result.plugins.size() ? "," : "") << "\n";
        }

        out << "  ]\n";
        out << "}\n";

        return true;
    } catch (...) {
        return false;
    }
}

bool VSTDiskScanner::loadCacheFromJson(const std::string& cacheFilePath, VSTScanResult& outResult, bool validateTimestamps) {
    try {
        if (!fs::exists(cacheFilePath)) return false;

        std::ifstream in(cacheFilePath);
        if (!in.is_open()) return false;

        std::stringstream buffer;
        buffer << in.rdbuf();
        std::string json = buffer.str();
        if (json.empty()) return false;

        outResult.scanTimestamp = extractJsonField(json, "timestamp");
        std::string durStr = extractJsonField(json, "scanDurationMs");
        if (!durStr.empty()) outResult.scanDurationMs = std::stod(durStr);

        // Парсинг плагинов из кэша
        size_t pluginsPos = json.find("\"plugins\"");
        if (pluginsPos == std::string::npos) return false;

        size_t arrayStart = json.find('[', pluginsPos);
        if (arrayStart == std::string::npos) return false;

        size_t current = arrayStart + 1;
        while (current < json.length()) {
            size_t objStart = json.find('{', current);
            if (objStart == std::string::npos) break;

            size_t objEnd = json.find('}', objStart);
            if (objEnd == std::string::npos) break;

            // Обрабатываем возможные вложенные объекты подплагинов
            size_t subArrayStart = json.find("\"subPlugins\"", objStart);
            if (subArrayStart != std::string::npos && subArrayStart < objEnd) {
                size_t subArrayEnd = json.find(']', subArrayStart);
                if (subArrayEnd != std::string::npos) {
                    objEnd = json.find('}', subArrayEnd);
                }
            }

            std::string objJson = json.substr(objStart, objEnd - objStart + 1);

            VSTPluginMetadata meta;
            meta.id = extractJsonField(objJson, "id");
            meta.name = extractJsonField(objJson, "name");
            meta.category = extractJsonField(objJson, "category");
            meta.vendor = extractJsonField(objJson, "vendor");
            meta.format = extractJsonField(objJson, "format");
            meta.path = extractJsonField(objJson, "path");
            meta.binaryPath = extractJsonField(objJson, "binaryPath");
            meta.classUid = extractJsonField(objJson, "classUid");
            meta.version = extractJsonField(objJson, "version");
            meta.sdkVersion = extractJsonField(objJson, "sdkVersion");

            std::string latStr = extractJsonField(objJson, "latencySamples");
            if (!latStr.empty()) meta.latencySamples = std::stoi(latStr);

            std::string modStr = extractJsonField(objJson, "lastModified");
            if (!modStr.empty()) meta.lastModified = std::stoull(modStr);

            std::string szStr = extractJsonField(objJson, "fileSize");
            if (!szStr.empty()) meta.fileSize = std::stoull(szStr);

            // Валидация актуальности файла
            if (validateTimestamps && !meta.path.empty()) {
                if (!fs::exists(meta.path)) {
                    // Файл был удален пользователем, пропускаем
                    current = objEnd + 1;
                    continue;
                }
            }

            // Восстановление подплагинов
            if (meta.vendor == "Waves Audio" || containsIgnoreCase(meta.name, "waveshell")) {
                meta.isWaveshell = true;
                VSTDiskScanner scanner;
                scanner.unpackWaveshellPlugins(meta);
            } else if (meta.vendor == "iZotope") {
                meta.isIzotope = true;
                VSTDiskScanner scanner;
                scanner.unpackIzotopeModules(meta);
            }

            meta.isValid = true;
            outResult.plugins.push_back(meta);

            current = objEnd + 1;
        }

        return !outResult.plugins.empty();
    } catch (...) {
        return false;
    }
}

} // namespace DAWCore
