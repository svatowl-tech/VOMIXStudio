#include "VST3BundleScanner.hpp"
#include <iostream>
#include <algorithm>
#include <sstream>
#include <cstring>

#if defined(_WIN32) || defined(_WIN64)
    #ifndef WIN32_LEAN_AND_MEAN
        #define WIN32_LEAN_AND_MEAN
    #endif
    #ifndef NOMINMAX
        #define NOMINMAX
    #endif
    #include <windows.h>
#else
    #include <dlfcn.h>
    #include <dirent.h>
    #include <sys/stat.h>
    #include <unistd.h>
#endif

namespace vomix {
namespace vst {

#if defined(_WIN32) || defined(_WIN64)
static std::wstring utf8ToWide(const std::string& str) {
    if (str.empty()) return std::wstring();
    int sizeNeeded = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), (int)str.size(), nullptr, 0);
    std::wstring wstr(sizeNeeded, 0);
    MultiByteToWideChar(CP_UTF8, 0, str.c_str(), (int)str.size(), &wstr[0], sizeNeeded);
    return wstr;
}

static std::string wideToUtf8(const std::wstring& wstr) {
    if (wstr.empty()) return std::string();
    int sizeNeeded = WideCharToMultiByte(CP_UTF8, 0, wstr.c_str(), (int)wstr.size(), nullptr, 0, nullptr, nullptr);
    std::string str(sizeNeeded, 0);
    WideCharToMultiByte(CP_UTF8, 0, wstr.c_str(), (int)wstr.size(), &str[0], sizeNeeded, nullptr, nullptr);
    return str;
}
#endif

static bool caseInsensitiveEndsWith(const std::string& str, const std::string& suffix) {
    if (str.length() < suffix.length()) return false;
    return std::equal(
        suffix.rbegin(), suffix.rend(), str.rbegin(),
        [](char a, char b) { return std::tolower((unsigned char)a) == std::tolower((unsigned char)b); }
    );
}

static bool caseInsensitiveContains(const std::string& haystack, const std::string& needle) {
    auto it = std::search(
        haystack.begin(), haystack.end(),
        needle.begin(), needle.end(),
        [](char a, char b) { return std::tolower((unsigned char)a) == std::tolower((unsigned char)b); }
    );
    return (it != haystack.end());
}

std::vector<std::string> VST3BundleScanner::getDefaultSearchPaths() {
    std::vector<std::string> paths;

#if defined(_WIN32) || defined(_WIN64)
    // 1. Приоритетные пути iZotope
    paths.push_back("C:\\Program Files\\Common Files\\VST3\\iZotope");
    paths.push_back("C:\\Program Files\\Steinberg\\VstPlugins\\iZotope");
    paths.push_back("C:\\Program Files\\VstPlugins\\iZotope");
    paths.push_back("C:\\Program Files\\Common Files\\iZotope");

    // 2. Стандартные системные пути VST3 / VST2
    paths.push_back("C:\\Program Files\\Common Files\\VST3");
    paths.push_back("C:\\Program Files\\VSTPlugins");
    paths.push_back("C:\\Program Files\\Steinberg\\VSTPlugins");
    paths.push_back("C:\\Program Files\\Common Files\\VST2");
    paths.push_back("C:\\Program Files (x86)\\Common Files\\VST3");
    paths.push_back("C:\\Program Files (x86)\\VSTPlugins");
#elif defined(__APPLE__)
    paths.push_back("/Library/Audio/Plug-Ins/VST3");
    paths.push_back("/Library/Audio/Plug-Ins/VST");
    paths.push_back("/Library/Audio/Plug-Ins/VST3/iZotope");
    paths.push_back("/Library/Application Support/iZotope");
    const char* home = getenv("HOME");
    if (home) {
        paths.push_back(std::string(home) + "/Library/Audio/Plug-Ins/VST3");
        paths.push_back(std::string(home) + "/Library/Audio/Plug-Ins/VST");
    }
#else
    paths.push_back("/usr/lib/vst3");
    paths.push_back("/usr/local/lib/vst3");
    paths.push_back("/usr/lib/vst");
    const char* home = getenv("HOME");
    if (home) {
        paths.push_back(std::string(home) + "/.vst3");
        paths.push_back(std::string(home) + "/.vst");
    }
#endif

    return paths;
}

bool VST3BundleScanner::isVst3BundleDirectory(const std::string& path) {
    if (!caseInsensitiveEndsWith(path, ".vst3")) {
        return false;
    }

#if defined(_WIN32) || defined(_WIN64)
    std::wstring wpath = utf8ToWide(path);
    DWORD attrs = GetFileAttributesW(wpath.c_str());
    return (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY));
#else
    struct stat st;
    if (stat(path.c_str(), &st) == 0) {
        return S_ISDIR(st.st_mode);
    }
    return false;
#endif
}

ResolvedPluginBinary VST3BundleScanner::resolvePluginBinary(const std::string& bundleOrFilePath) {
    ResolvedPluginBinary res;
    res.originalPath = bundleOrFilePath;
    res.binaryPath = bundleOrFilePath;
    res.format = PluginFormat::VST3;

    // Извлекаем базовое имя
    std::string clean = bundleOrFilePath;
    while (!clean.empty() && (clean.back() == '/' || clean.back() == '\\')) {
        clean.pop_back();
    }
    size_t lastSlash = clean.find_last_of("/\\");
    res.bundleName = (lastSlash != std::string::npos) ? clean.substr(lastSlash + 1) : clean;

    // Проверяем принадлежность к iZotope
    if (caseInsensitiveContains(clean, "izotope") ||
        caseInsensitiveContains(clean, "ozone") ||
        caseInsensitiveContains(clean, "rx ") ||
        caseInsensitiveContains(clean, "nectar") ||
        caseInsensitiveContains(clean, "neutron") ||
        caseInsensitiveContains(clean, "insight")) {
        res.isIzotope = true;
    }

    if (caseInsensitiveEndsWith(clean, ".clap")) {
        res.format = PluginFormat::CLAP;
    } else if (caseInsensitiveEndsWith(clean, ".dll")) {
        res.format = PluginFormat::VST2;
    }

    // Если это не бандл, а отдельный файл библиотеки
    if (!isVst3BundleDirectory(clean)) {
        res.isBundle = false;
        size_t dirSlash = clean.find_last_of("/\\");
        res.directoryPath = (dirSlash != std::string::npos) ? clean.substr(0, dirSlash) : ".";
        return res;
    }

    res.isBundle = true;

#if defined(_WIN32) || defined(_WIN64)
    // Windows: поиск исполняемого бинарника в Contents/x86_64-win/*.vst3 или *.dll
    std::string archDir = clean + "\\Contents\\x86_64-win";
    std::wstring searchPattern = utf8ToWide(archDir + "\\*.*");

    WIN32_FIND_DATAW ffd;
    HANDLE hFind = FindFirstFileW(searchPattern.c_str(), &ffd);
    bool found = false;

    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (!(ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
                std::string fname = wideToUtf8(ffd.cFileName);
                if (caseInsensitiveEndsWith(fname, ".vst3") || caseInsensitiveEndsWith(fname, ".dll")) {
                    res.binaryPath = archDir + "\\" + fname;
                    res.directoryPath = archDir;
                    found = true;
                    break;
                }
            }
        } while (FindNextFileW(hFind, &ffd));
        FindClose(hFind);
    }

    if (!found) {
        // Fallback: 32-bit x86-win
        std::string arch32Dir = clean + "\\Contents\\x86-win";
        std::wstring searchPattern32 = utf8ToWide(arch32Dir + "\\*.*");
        HANDLE hFind32 = FindFirstFileW(searchPattern32.c_str(), &ffd);
        if (hFind32 != INVALID_HANDLE_VALUE) {
            do {
                if (!(ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
                    std::string fname = wideToUtf8(ffd.cFileName);
                    if (caseInsensitiveEndsWith(fname, ".vst3") || caseInsensitiveEndsWith(fname, ".dll")) {
                        res.binaryPath = arch32Dir + "\\" + fname;
                        res.directoryPath = arch32Dir;
                        found = true;
                        break;
                    }
                }
            } while (FindNextFileW(hFind32, &ffd));
            FindClose(hFind32);
        }
    }

    if (!found) {
        res.binaryPath = clean;
        res.directoryPath = clean;
    }
#elif defined(__APPLE__)
    // macOS: Contents/MacOS/<name>
    std::string macDir = clean + "/Contents/MacOS";
    DIR* dir = opendir(macDir.c_str());
    if (dir) {
        struct dirent* ent;
        while ((ent = readdir(dir)) != nullptr) {
            if (ent->d_name[0] != '.') {
                res.binaryPath = macDir + "/" + ent->d_name;
                res.directoryPath = macDir;
                break;
            }
        }
        closedir(dir);
    }
#else
    // Linux: Contents/x86_64-linux/*.so
    std::string linDir = clean + "/Contents/x86_64-linux";
    DIR* dir = opendir(linDir.c_str());
    if (dir) {
        struct dirent* ent;
        while ((ent = readdir(dir)) != nullptr) {
            if (ent->d_name[0] != '.') {
                res.binaryPath = linDir + "/" + ent->d_name;
                res.directoryPath = linDir;
                break;
            }
        }
        closedir(dir);
    }
#endif

    return res;
}

std::vector<ResolvedPluginBinary> VST3BundleScanner::scanDirectory(
    const std::string& rootDir,
    bool recursive
) {
    std::vector<ResolvedPluginBinary> results;

#if defined(_WIN32) || defined(_WIN64)
    std::wstring searchPattern = utf8ToWide(rootDir + "\\*.*");
    WIN32_FIND_DATAW ffd;
    HANDLE hFind = FindFirstFileW(searchPattern.c_str(), &ffd);

    if (hFind == INVALID_HANDLE_VALUE) {
        return results;
    }

    do {
        std::string name = wideToUtf8(ffd.cFileName);
        if (name == "." || name == "..") continue;

        std::string fullPath = rootDir + "\\" + name;

        if (ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            // Если это VST3 бандл (папка .vst3)
            if (caseInsensitiveEndsWith(name, ".vst3")) {
                ResolvedPluginBinary resolved = resolvePluginBinary(fullPath);
                results.push_back(resolved);
            } else if (recursive) {
                // Обычная поддиректория (например, iZotope или FabFilter) -> рекурсивный обход
                std::vector<ResolvedPluginBinary> sub = scanDirectory(fullPath, recursive);
                results.insert(results.end(), sub.begin(), sub.end());
            }
        } else {
            // Одиночный файл (.vst3, .dll, .clap)
            if (caseInsensitiveEndsWith(name, ".vst3") ||
                caseInsensitiveEndsWith(name, ".dll") ||
                caseInsensitiveEndsWith(name, ".clap")) {
                ResolvedPluginBinary resolved = resolvePluginBinary(fullPath);
                results.push_back(resolved);
            }
        }
    } while (FindNextFileW(hFind, &ffd));

    FindClose(hFind);
#else
    DIR* dir = opendir(rootDir.c_str());
    if (!dir) return results;

    struct dirent* ent;
    while ((ent = readdir(dir)) != nullptr) {
        std::string name = ent->d_name;
        if (name == "." || name == "..") continue;

        std::string fullPath = rootDir + "/" + name;
        struct stat st;
        if (stat(fullPath.c_str(), &st) == 0) {
            if (S_ISDIR(st.st_mode)) {
                if (caseInsensitiveEndsWith(name, ".vst3")) {
                    results.push_back(resolvePluginBinary(fullPath));
                } else if (recursive) {
                    std::vector<ResolvedPluginBinary> sub = scanDirectory(fullPath, recursive);
                    results.insert(results.end(), sub.begin(), sub.end());
                }
            } else {
                if (caseInsensitiveEndsWith(name, ".vst3") ||
                    caseInsensitiveEndsWith(name, ".clap") ||
                    caseInsensitiveEndsWith(name, ".so") ||
                    caseInsensitiveEndsWith(name, ".dylib")) {
                    results.push_back(resolvePluginBinary(fullPath));
                }
            }
        }
    }
    closedir(dir);
#endif

    return results;
}

void* VST3BundleScanner::safeLoadLibrary(const ResolvedPluginBinary& binary) {
#if defined(_WIN32) || defined(_WIN64)
    std::wstring wBinaryPath = utf8ToWide(binary.binaryPath);
    std::wstring wDirPath = utf8ToWide(binary.directoryPath);

    // 1. Добавляем директорию с бинарником в очередь поиска DLL зависимостей (Qt5, iZotopeCore)
    if (!wDirPath.empty()) {
        SetDllDirectoryW(wDirPath.c_str());
    }

    // 2. Загрузка модуля с флагами безопасного поиска связанных зависимостей
    // LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS предотвращает ошибку 126
    DWORD loadFlags = 0x00000100 /* LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR */ |
                      0x00001000 /* LOAD_LIBRARY_SEARCH_DEFAULT_DIRS */;

    HMODULE hMod = LoadLibraryExW(wBinaryPath.c_str(), NULL, loadFlags);

    if (!hMod) {
        // Fallback: LOAD_WITH_ALTERED_SEARCH_PATH
        hMod = LoadLibraryExW(wBinaryPath.c_str(), NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    }

    if (!hMod) {
        // Fallback: обычный LoadLibraryW
        hMod = LoadLibraryW(wBinaryPath.c_str());
    }

    // 3. Восстанавливаем системный путь поиска DLL
    SetDllDirectoryW(NULL);

    if (!hMod) {
        DWORD err = GetLastError();
        std::cerr << "[VST3BundleScanner] Ошибка загрузки библиотеки " << binary.binaryPath 
                  << " (Win32 Код ошибки: " << err << ")\n";
    }

    return (void*)hMod;
#else
    void* handle = dlopen(binary.binaryPath.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        const char* err = dlerror();
        std::cerr << "[VST3BundleScanner] Ошибка dlopen для " << binary.binaryPath 
                  << ": " << (err ? err : "unknown") << "\n";
    }
    return handle;
#endif
}

void VST3BundleScanner::safeFreeLibrary(void* moduleHandle) {
    if (!moduleHandle) return;
#if defined(_WIN32) || defined(_WIN64)
    FreeLibrary((HMODULE)moduleHandle);
#else
    dlclose(moduleHandle);
#endif
}

std::vector<SubPluginDescriptor> VST3BundleScanner::inspectPluginFactory(
    void* moduleHandle,
    const ResolvedPluginBinary& binary
) {
    std::vector<SubPluginDescriptor> results;
    if (!moduleHandle) return results;

    typedef IPluginFactory* (*GetPluginFactoryProc)();

#if defined(_WIN32) || defined(_WIN64)
    auto getFactoryProc = (GetPluginFactoryProc)GetProcAddress((HMODULE)moduleHandle, "GetPluginFactory");
#else
    auto getFactoryProc = (GetPluginFactoryProc)dlsym(moduleHandle, "GetPluginFactory");
#endif

    if (!getFactoryProc) {
        return results;
    }

    IPluginFactory* factory = getFactoryProc();
    if (!factory) {
        return results;
    }

    IPluginFactory2* factory2 = nullptr;
    factory->queryInterface(IPluginFactory_iid, (void**)&factory2);

    int32 numClasses = factory->countClasses();

    for (int32 i = 0; i < numClasses; ++i) {
        PClassInfo classInfo;
        if (factory->getClassInfo(i, &classInfo) == kResultOk) {
            // Проверяем категорию класса VST3: Audio Module Class / Component
            if (std::strcmp(classInfo.category, "Audio Module Class") == 0 ||
                std::strcmp(classInfo.category, "Component") == 0) {
                
                SubPluginDescriptor desc;
                desc.uid = tuidToString(classInfo.cid);
                desc.classUid = desc.uid;
                desc.name = classInfo.name;
                desc.category = classInfo.category;
                desc.sdkVersion = "VST 3.7";
                desc.shellPath = binary.originalPath;
                desc.isShellSubPlugin = (numClasses > 1);

                if (factory2) {
                    PClassInfo2 classInfo2;
                    if (factory2->getClassInfo2(i, &classInfo2) == kResultOk) {
                        desc.vendor = classInfo2.vendor;
                        desc.version = classInfo2.version;
                        if (classInfo2.subCategories[0]) {
                            desc.category = classInfo2.subCategories;
                        }
                    }
                }

                // Автоматическое обогащение метаданных для семейства iZotope
                if (binary.isIzotope || caseInsensitiveContains(desc.name, "izotope") || caseInsensitiveContains(desc.vendor, "izotope")) {
                    if (desc.vendor.empty() || desc.vendor == "Unknown Vendor") {
                        desc.vendor = "iZotope, Inc.";
                    }

                    // Определение категории iZotope
                    std::string lowerName = desc.name;
                    std::transform(lowerName.begin(), lowerName.end(), lowerName.begin(), ::tolower);

                    if (lowerName.find("ozone") != std::string::npos || lowerName.find("maximizer") != std::string::npos) {
                        desc.category = "Mastering";
                    } else if (lowerName.find("rx") != std::string::npos || lowerName.find("denoise") != std::string::npos || lowerName.find("de-click") != std::string::npos || lowerName.find("restoration") != std::string::npos) {
                        desc.category = "Restoration";
                    } else if (lowerName.find("nectar") != std::string::npos || lowerName.find("vocal") != std::string::npos) {
                        desc.category = "Dynamics";
                    } else if (lowerName.find("neutron") != std::string::npos || lowerName.find("compressor") != std::string::npos) {
                        desc.category = "Dynamics";
                    } else if (lowerName.find("insight") != std::string::npos) {
                        desc.category = "Utility";
                    }
                }

                desc.numInputs = 2;
                desc.numOutputs = 2;
                results.push_back(desc);
            }
        }
    }

    if (factory2) {
        factory2->release();
    }

    return results;
}

} // namespace vst
} // namespace vomix
