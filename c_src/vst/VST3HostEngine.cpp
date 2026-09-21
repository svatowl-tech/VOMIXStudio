#include "VST3HostEngine.hpp"

#include <iostream>
#include <cstring>
#include <algorithm>
#include <sstream>
#include <iomanip>
#include <atomic>
#include <cmath>

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

// =============================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ И СТРУКТУРЫ: КРОССПЛАТФОРМЕННЫЙ ЗАГРУЗЧИК
// =============================================================================

#if defined(_WIN32) || defined(_WIN64)
static std::wstring utf8ToWide(const std::string& str) {
    if (str.empty()) return std::wstring();
    int sizeNeeded = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), (int)str.size(), nullptr, 0);
    std::wstring wstr(sizeNeeded, 0);
    MultiByteToWideChar(CP_UTF8, 0, str.c_str(), (int)str.size(), &wstr[0], sizeNeeded);
    return wstr;
}
#endif

DynamicLibrary::DynamicLibrary() : m_handle(nullptr) {}

DynamicLibrary::~DynamicLibrary() {
    unload();
}

DynamicLibrary::DynamicLibrary(DynamicLibrary&& other) noexcept
    : m_handle(other.m_handle), m_path(std::move(other.m_path)) {
    other.m_handle = nullptr;
}

DynamicLibrary& DynamicLibrary::operator=(DynamicLibrary&& other) noexcept {
    if (this != &other) {
        unload();
        m_handle = other.m_handle;
        m_path = std::move(other.m_path);
        other.m_handle = nullptr;
    }
    return *this;
}

bool DynamicLibrary::load(const std::string& path) {
    unload();
    m_path = path;

#if defined(_WIN32) || defined(_WIN64)
    std::wstring wpath = utf8ToWide(path);
    m_handle = (void*)LoadLibraryW(wpath.c_str());
    if (!m_handle) {
        // Попытка загрузить с флагом поиска зависимостей в папке плагина
        m_handle = (void*)LoadLibraryExW(wpath.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    }
#else
    std::string actualPath = path;

    // Проверка, является ли путь macOS .vst3 бандлом (папкой)
    struct stat st;
    if (stat(path.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
        // Извлекаем имя бандла
        std::string bundleName;
        size_t lastSlash = path.find_last_of('/');
        if (lastSlash != std::string::npos) {
            bundleName = path.substr(lastSlash + 1);
        } else {
            bundleName = path;
        }
        if (bundleName.size() > 5 && bundleName.substr(bundleName.size() - 5) == ".vst3") {
            bundleName = bundleName.substr(0, bundleName.size() - 5);
        }

        std::string binaryCandidate = path + "/Contents/MacOS/" + bundleName;
        if (stat(binaryCandidate.c_str(), &st) == 0) {
            actualPath = binaryCandidate;
        } else {
            // Альтернативный поиск исполняемого файла в Contents/MacOS/
            std::string macOsDir = path + "/Contents/MacOS";
            DIR* dir = opendir(macOsDir.c_str());
            if (dir) {
                struct dirent* ent;
                while ((ent = readdir(dir)) != nullptr) {
                    if (ent->d_name[0] != '.') {
                        actualPath = macOsDir + "/" + ent->d_name;
                        break;
                    }
                }
                closedir(dir);
            }
        }
    }

    m_handle = dlopen(actualPath.c_str(), RTLD_NOW | RTLD_LOCAL);
#endif

    return m_handle != nullptr;
}

void DynamicLibrary::unload() {
    if (m_handle) {
#if defined(_WIN32) || defined(_WIN64)
        FreeLibrary((HMODULE)m_handle);
#else
        dlclose(m_handle);
#endif
        m_handle = nullptr;
    }
    m_path.clear();
}

bool DynamicLibrary::isLoaded() const {
    return m_handle != nullptr;
}

void* DynamicLibrary::getSymbol(const char* symbolName) const {
    if (!m_handle || !symbolName) return nullptr;
#if defined(_WIN32) || defined(_WIN64)
    return (void*)GetProcAddress((HMODULE)m_handle, symbolName);
#else
    return dlsym(m_handle, symbolName);
#endif
}

// =============================================================================
// VST 2.4 ABI ОПРЕДЕЛЕНИЯ И СТРУКТУРЫ
// =============================================================================

struct AEffect;

typedef intptr_t (*AudioMasterCallbackFunc)(
    AEffect* effect,
    int32_t opcode,
    int32_t index,
    intptr_t value,
    void* ptr,
    float opt
);

typedef intptr_t (*AEffectDispatcherFunc)(
    AEffect* effect,
    int32_t opcode,
    int32_t index,
    intptr_t value,
    void* ptr,
    float opt
);

typedef void (*AEffectProcessFunc)(AEffect* effect, float** inputs, float** outputs, int32_t sampleFrames);
typedef void (*AEffectSetParameterFunc)(AEffect* effect, int32_t index, float parameter);
typedef float (*AEffectGetParameterFunc)(AEffect* effect, int32_t index);

struct AEffect {
    int32_t magic;                    // 'VstP' (0x56737450)
    AEffectDispatcherFunc dispatcher; // Диспетчер команд плагина
    AEffectProcessFunc process;       // Устаревший процесс
    AEffectSetParameterFunc setParameter;
    AEffectGetParameterFunc getParameter;
    int32_t numPrograms;
    int32_t numParams;
    int32_t numInputs;
    int32_t numOutputs;
    int32_t flags;
    intptr_t resvd1;
    intptr_t resvd2;
    int32_t initialDelay;             // Plugin Delay Compensation (PDC) latency
    int32_t realQualities;
    int32_t offQualities;
    float ioRatio;
    void* object;
    void* user;
    int32_t uniqueID;
    int32_t version;
    AEffectProcessFunc processReplacing; // Основной метод обработки
    void* processDoubleReplacing;
    char future[56];
};

// VST2 Опкоды Диспетчера
constexpr int32_t effOpen               = 0;
constexpr int32_t effClose              = 1;
constexpr int32_t effSetProgram          = 2;
constexpr int32_t effGetProgram          = 3;
constexpr int32_t effSetProgramName      = 4;
constexpr int32_t effGetProgramName      = 5;
constexpr int32_t effGetParamLabel       = 6;
constexpr int32_t effGetParamDisplay     = 7;
constexpr int32_t effGetParamName        = 8;
constexpr int32_t effSetSampleRate       = 10;
constexpr int32_t effSetBlockSize        = 11;
constexpr int32_t effMainsChanged        = 12;
constexpr int32_t effEditGetRect         = 13;
constexpr int32_t effEditOpen            = 14;
constexpr int32_t effEditClose           = 15;
constexpr int32_t effGetChunk            = 23;
constexpr int32_t effSetChunk            = 24;
constexpr int32_t effCanBeAutomated      = 26;
constexpr int32_t effGetPlugCategory     = 35;
constexpr int32_t effGetEffectName       = 45;
constexpr int32_t effGetVendorString     = 47;
constexpr int32_t effGetProductString    = 48;
constexpr int32_t effGetVendorVersion   = 49;
constexpr int32_t effVendorSpecific      = 43;
constexpr int32_t effCanDo               = 51;
constexpr int32_t effGetTailSize         = 52;
constexpr int32_t effShellGetNextPlugin  = 0x7368656c; // 'shel'

// VST2 Флаги AEffect
constexpr int32_t effFlagsHasEditor      = 1 << 0;
constexpr int32_t effFlagsCanReplacing   = 1 << 4;
constexpr int32_t effFlagsProgramChunks  = 1 << 5;

// VST2 Опкоды AudioMaster
constexpr int32_t audioMasterVersion     = 1;
constexpr int32_t audioMasterCurrentId   = 2; // Передает активный sub-plugin UID для Shell-плагинов
constexpr int32_t audioMasterGetTime     = 7;
constexpr int32_t audioMasterGetSampleRate = 16;
constexpr int32_t audioMasterGetBlockSize  = 17;
constexpr int32_t audioMasterGetVendorString  = 32;
constexpr int32_t audioMasterGetProductString = 33;
constexpr int32_t audioMasterGetVendorVersion = 34;
constexpr int32_t audioMasterCanDo            = 37;

struct VstTimeInfo {
    double samplePos;
    double sampleRate;
    double nanoSeconds;
    double ppqPos;
    double tempo;
    double barStartPos;
    double cycleStartPos;
    double cycleEndPos;
    int32_t timeSigNumerator;
    int32_t timeSigDenominator;
    int32_t smpteOffset;
    int32_t smpteFrameRate;
    int32_t samplesToNextClock;
    int32_t flags;
};

struct ERect {
    int16_t top;
    int16_t left;
    int16_t bottom;
    int16_t right;
};

typedef AEffect* (*VstPluginMainFunc)(AudioMasterCallbackFunc audioMaster);

// =============================================================================
// VST 3.7 ABI ОПРЕДЕЛЕНИЯ И COM-ИНТЕРФЕЙСЫ
// =============================================================================

using int32 = int32_t;
using uint32 = uint32_t;
using int64 = int64_t;
using uint64 = uint64_t;
using tresult = int32_t;
using TBool = uint8_t;
using ParamID = uint32_t;
using ParamValue = double;
using FIDString = const char*;

constexpr tresult kResultOk = 0;
constexpr tresult kResultFalse = 1;
constexpr tresult kInvalidArgument = 2;
constexpr tresult kNotImplemented = 3;

typedef char TUID[16];

struct FUID {
    uint32_t data1;
    uint16_t data2;
    uint16_t data3;
    uint8_t  data4[8];
};

static std::string tuidToString(const TUID tuid) {
    std::stringstream ss;
    ss << std::hex << std::setfill('0');
    for (int i = 0; i < 16; ++i) {
        ss << std::setw(2) << (int)(uint8_t)tuid[i];
        if (i == 3 || i == 5 || i == 7 || i == 9) ss << "-";
    }
    return ss.str();
}

static void stringToTuid(const std::string& str, TUID outTuid) {
    std::string clean;
    for (char c : str) {
        if (isxdigit(c)) clean.push_back(c);
    }
    if (clean.size() < 32) {
        std::memset(outTuid, 0, 16);
        return;
    }
    for (int i = 0; i < 16; ++i) {
        std::string byteStr = clean.substr(i * 2, 2);
        outTuid[i] = (char)std::stoul(byteStr, nullptr, 16);
    }
}

// Steinberg VST3 IUnknown (FUnknown)
class FUnknown {
public:
    virtual tresult queryInterface(const TUID _iid, void** obj) = 0;
    virtual uint32 addRef() = 0;
    virtual uint32 release() = 0;
};

// IIDs
static const TUID IPluginFactory_iid = {
    (char)0x7A, (char)0x4D, (char)0x81, (char)0x6B,
    (char)0xEE, (char)0x2E, (char)0x47, (char)0x8E,
    (char)0xA0, (char)0x6F, (char)0x7A, (char)0xC1,
    (char)0x96, (char)0x6C, (char)0x13, (char)0xB0
};

static const TUID IComponent_iid = {
    (char)0xE8, (char)0x31, (char)0xFF, (char)0x31,
    (char)0xBA, (char)0x3F, (char)0x4C, (char)0x4B,
    (char)0x82, (char)0x99, (char)0xF6, (char)0x59,
    (char)0x58, (char)0x50, (char)0x66, (char)0x77
};

static const TUID IAudioProcessor_iid = {
    (char)0x42, (char)0x04, (char)0x3E, (char)0x38,
    (char)0x0D, (char)0x42, (char)0x42, (char)0xA2,
    (char)0x87, (char)0x5A, (char)0x63, (char)0x1E,
    (char)0x22, (char)0x88, (char)0x8F, (char)0x84
};

static const TUID IEditController_iid = {
    (char)0xDD, (char)0x4C, (char)0xF4, (char)0x10,
    (char)0xF9, (char)0xBB, (char)0x47, (char)0x44,
    (char)0xAB, (char)0x61, (char)0x6D, (char)0xEC,
    (char)0x40, (char)0xAB, (char)0x82, (char)0x01
};

struct PClassInfo {
    TUID cid;
    int32 cardinality;
    char category[32];
    char name[64];
};

struct PClassInfo2 {
    TUID cid;
    int32 cardinality;
    char category[32];
    char name[64];
    uint32 classFlags;
    char subCategories[128];
    char vendor[64];
    char version[64];
    char sdkVersion[64];
};

class IPluginFactory : public FUnknown {
public:
    virtual tresult getFactoryInfo(void* info) = 0;
    virtual int32 countClasses() = 0;
    virtual tresult getClassInfo(int32 index, PClassInfo* info) = 0;
    virtual tresult createInstance(FIDString cid, FIDString _iid, void** obj) = 0;
};

class IPluginFactory2 : public IPluginFactory {
public:
    virtual tresult getClassInfo2(int32 index, PClassInfo2* info) = 0;
};

class IBStream : public FUnknown {
public:
    virtual tresult read(void* buffer, int32 numBytes, int32* numBytesRead) = 0;
    virtual tresult write(void* buffer, int32 numBytes, int32* numBytesWritten) = 0;
    virtual tresult seek(int64 offset, int32 mode, int64* result) = 0;
    virtual tresult tell(int64* result) = 0;
};

struct ProcessSetup {
    int32 processMode;
    int32 symbolicSampleSize;
    int32 maxSamplesPerBlock;
    double sampleRate;
};

struct AudioBusBuffers {
    int32 numChannels;
    uint64 silenceFlags;
    union {
        float** channelBuffers32;
        double** channelBuffers64;
    };
};

class IParamValueQueue : public FUnknown {
public:
    virtual ParamID getParameterId() = 0;
    virtual int32 getPointCount() = 0;
    virtual tresult getPoint(int32 index, int32& sampleOffset, ParamValue& value) = 0;
    virtual tresult addPoint(int32 sampleOffset, ParamValue value, int32& index) = 0;
};

class IParameterChanges : public FUnknown {
public:
    virtual int32 getParameterCount() = 0;
    virtual IParamValueQueue* getParameterData(int32 index) = 0;
    virtual IParamValueQueue* addParameterData(const ParamID& id, int32& index) = 0;
};

struct ProcessContextVst3 {
    uint32 state;
    double sampleRate;
    int64 projectTimeSamples;
    int64 systemTime;
    double continuousTimeSamples;
    double projectTimeMusic;
    double barPositionMusic;
    double cycleStartMusic;
    double cycleEndMusic;
    double tempo;
    int32 timeSigNumerator;
    int32 timeSigDenominator;
    double chord;
    int32 smpteOffsetSubframes;
    int32 frameRate;
    int32 samplesToNextClock;
};

struct ProcessData {
    int32 processMode;
    int32 symbolicSampleSize;
    int32 numSamples;
    int32 numInputs;
    int32 numOutputs;
    AudioBusBuffers* inputs;
    AudioBusBuffers* outputs;
    IParameterChanges* inputParameterChanges;
    IParameterChanges* outputParameterChanges;
    void* inputEvents;
    void* outputEvents;
    ProcessContextVst3* processContext;
};

class IComponent : public FUnknown {
public:
    virtual tresult initialize(FUnknown* context) = 0;
    virtual tresult terminate() = 0;
    virtual tresult getControllerClassId(TUID classId) = 0;
    virtual tresult setIoMode(int32 mode) = 0;
    virtual int32 getRoutingInfo(void* inInfo, void* outInfo) = 0;
    virtual tresult activateBus(int32 type, int32 dir, int32 index, TBool state) = 0;
    virtual tresult setActive(TBool state) = 0;
    virtual tresult setState(IBStream* state) = 0;
    virtual tresult getState(IBStream* state) = 0;
};

class IAudioProcessor : public FUnknown {
public:
    virtual tresult setBusArrangements(uint64* inputs, int32 numIns, uint64* outputs, int32 numOuts) = 0;
    virtual tresult getBusArrangement(int32 dir, int32 index, uint64& arr) = 0;
    virtual tresult canProcessSampleSize(int32 symbolicSampleSize) = 0;
    virtual int32 getLatencySamples() = 0;
    virtual tresult setupProcessing(ProcessSetup& setup) = 0;
    virtual tresult setProcessing(TBool state) = 0;
    virtual tresult process(ProcessData& data) = 0;
    virtual uint32 getTailSamples() = 0;
};

struct ParameterInfoVst3 {
    ParamID id;
    char16_t title[128];
    char16_t shortTitle[128];
    char16_t units[128];
    int32 stepCount;
    ParamValue defaultNormalizedValue;
    int32 unitId;
    int32 flags;
};

class IEditController : public FUnknown {
public:
    virtual tresult initialize(FUnknown* context) = 0;
    virtual tresult terminate() = 0;
    virtual tresult setComponentState(IBStream* state) = 0;
    virtual tresult setState(IBStream* state) = 0;
    virtual tresult getState(IBStream* state) = 0;
    virtual int32 getParameterCount() = 0;
    virtual tresult getParameterInfo(int32 paramIndex, ParameterInfoVst3& info) = 0;
    virtual tresult getParamStringByValue(ParamID id, ParamValue valueNormalized, char16_t* string) = 0;
    virtual tresult getParamValueByString(ParamID id, char16_t* string, ParamValue& valueNormalized) = 0;
    virtual ParamValue normalizedParamToPlain(ParamID id, ParamValue valueNormalized) = 0;
    virtual ParamValue plainParamToNormalized(ParamID id, ParamValue plainValue) = 0;
    virtual ParamValue getParamNormalized(ParamID id) = 0;
    virtual tresult setParamNormalized(ParamID id, ParamValue value) = 0;
    virtual tresult setComponentHandler(void* handler) = 0;
    virtual void* createView(FIDString name) = 0;
};

// =============================================================================
// ВНУТРЕННИЙ БУФЕР СОСТОЯНИЯ IBStream ДЛЯ CHUNKS В VST3
// =============================================================================

class MemoryBStream : public IBStream {
public:
    MemoryBStream() : m_refCount(1), m_cursor(0) {}
    explicit MemoryBStream(const std::vector<uint8_t>& initialData)
        : m_refCount(1), m_buffer(initialData), m_cursor(0) {}

    tresult queryInterface(const TUID _iid, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = this;
        addRef();
        return kResultOk;
    }

    uint32 addRef() override { return ++m_refCount; }
    uint32 release() override {
        uint32 r = --m_refCount;
        if (r == 0) delete this;
        return r;
    }

    tresult read(void* buffer, int32 numBytes, int32* numBytesRead) override {
        if (!buffer || numBytes < 0) return kInvalidArgument;
        size_t available = (m_cursor < m_buffer.size()) ? (m_buffer.size() - m_cursor) : 0;
        size_t bytesToRead = std::min((size_t)numBytes, available);
        if (bytesToRead > 0) {
            std::memcpy(buffer, m_buffer.data() + m_cursor, bytesToRead);
            m_cursor += bytesToRead;
        }
        if (numBytesRead) *numBytesRead = (int32)bytesToRead;
        return (bytesToRead == (size_t)numBytes) ? kResultOk : kResultFalse;
    }

    tresult write(void* buffer, int32 numBytes, int32* numBytesWritten) override {
        if (!buffer || numBytes < 0) return kInvalidArgument;
        if (m_cursor + numBytes > m_buffer.size()) {
            m_buffer.resize(m_cursor + numBytes);
        }
        std::memcpy(m_buffer.data() + m_cursor, buffer, numBytes);
        m_cursor += numBytes;
        if (numBytesWritten) *numBytesWritten = numBytes;
        return kResultOk;
    }

    tresult seek(int64 offset, int32 mode, int64* result) override {
        int64 newPos = m_cursor;
        if (mode == 0) { // SeekBegin
            newPos = offset;
        } else if (mode == 1) { // SeekCurrent
            newPos += offset;
        } else if (mode == 2) { // SeekEnd
            newPos = (int64)m_buffer.size() + offset;
        }
        if (newPos < 0) newPos = 0;
        if ((size_t)newPos > m_buffer.size()) {
            m_buffer.resize((size_t)newPos, 0);
        }
        m_cursor = (size_t)newPos;
        if (result) *result = newPos;
        return kResultOk;
    }

    tresult tell(int64* result) override {
        if (!result) return kInvalidArgument;
        *result = (int64)m_cursor;
        return kResultOk;
    }

    const std::vector<uint8_t>& getBuffer() const { return m_buffer; }

private:
    std::atomic<uint32> m_refCount;
    std::vector<uint8_t> m_buffer;
    size_t m_cursor;
};

// =============================================================================
// ОЧЕРЕДЬ ПАРАМЕТРОВ ДЛЯ СЭМПЛ-ТОЧНОЙ АВТОМАТИЗАЦИИ VST3
// =============================================================================

class ParamValueQueueImpl : public IParamValueQueue {
public:
    explicit ParamValueQueueImpl(ParamID id) : m_refCount(1), m_paramId(id) {}

    tresult queryInterface(const TUID, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = this;
        addRef();
        return kResultOk;
    }
    uint32 addRef() override { return ++m_refCount; }
    uint32 release() override {
        uint32 r = --m_refCount;
        if (r == 0) delete this;
        return r;
    }

    ParamID getParameterId() override { return m_paramId; }
    int32 getPointCount() override { return (int32)m_points.size(); }

    tresult getPoint(int32 index, int32& sampleOffset, ParamValue& value) override {
        if (index < 0 || index >= (int32)m_points.size()) return kInvalidArgument;
        sampleOffset = m_points[index].first;
        value = m_points[index].second;
        return kResultOk;
    }

    tresult addPoint(int32 sampleOffset, ParamValue value, int32& index) override {
        m_points.push_back({ sampleOffset, value });
        index = (int32)m_points.size() - 1;
        return kResultOk;
    }

    void clear() { m_points.clear(); }

private:
    std::atomic<uint32> m_refCount;
    ParamID m_paramId;
    std::vector<std::pair<int32, ParamValue>> m_points;
};

class ParameterChangesImpl : public IParameterChanges {
public:
    ParameterChangesImpl() : m_refCount(1) {}
    ~ParameterChangesImpl() {
        for (auto* q : m_queues) {
            if (q) q->release();
        }
    }

    tresult queryInterface(const TUID, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = this;
        addRef();
        return kResultOk;
    }
    uint32 addRef() override { return ++m_refCount; }
    uint32 release() override {
        uint32 r = --m_refCount;
        if (r == 0) delete this;
        return r;
    }

    int32 getParameterCount() override { return (int32)m_queues.size(); }

    IParamValueQueue* getParameterData(int32 index) override {
        if (index < 0 || index >= (int32)m_queues.size()) return nullptr;
        return m_queues[index];
    }

    IParamValueQueue* addParameterData(const ParamID& id, int32& index) override {
        for (size_t i = 0; i < m_queues.size(); ++i) {
            if (m_queues[i]->getParameterId() == id) {
                index = (int32)i;
                return m_queues[i];
            }
        }
        auto* q = new ParamValueQueueImpl(id);
        m_queues.push_back(q);
        index = (int32)m_queues.size() - 1;
        return q;
    }

    void clear() {
        for (auto* q : m_queues) {
            if (q) q->clear();
        }
    }

private:
    std::atomic<uint32> m_refCount;
    std::vector<ParamValueQueueImpl*> m_queues;
};

// =============================================================================
// РЕАЛИЗАЦИЯ IVSTPluginInstance ДЛЯ VST 2.4 (С ПОДДЕРЖКОЙ SHELL ПЛАГИНОВ)
// =============================================================================

class VST2PluginInstance : public IVSTPluginInstance {
public:
    VST2PluginInstance(
        DynamicLibrary&& lib,
        AEffect* effect,
        const SubPluginDescriptor& desc,
        const std::string& libraryPath
    ) : m_library(std::move(lib)),
        m_effect(effect),
        m_descriptor(desc),
        m_libraryPath(libraryPath),
        m_sampleRate(48000.0),
        m_blockSize(512),
        m_isActivated(false)
    {
        registerInstance(this);
    }

    ~VST2PluginInstance() override {
        terminate();
        unregisterInstance(this);
    }

    const SubPluginDescriptor& getDescriptor() const override { return m_descriptor; }
    PluginFormat getFormat() const override { return PluginFormat::VST2; }
    const std::string& getLibraryPath() const override { return m_libraryPath; }

    bool initialize(double sampleRate, int32_t maxBlockSize) override {
        if (!m_effect || !m_effect->dispatcher) return false;
        m_sampleRate = sampleRate;
        m_blockSize = maxBlockSize;

        // Инициализация VST2 плагина
        m_effect->dispatcher(m_effect, effOpen, 0, 0, nullptr, 0.0f);
        m_effect->dispatcher(m_effect, effSetSampleRate, 0, 0, nullptr, (float)sampleRate);
        m_effect->dispatcher(m_effect, effSetBlockSize, 0, maxBlockSize, nullptr, 0.0f);

        // Обновляем задержку
        m_descriptor.numInputs = m_effect->numInputs;
        m_descriptor.numOutputs = m_effect->numOutputs;
        return true;
    }

    void terminate() override {
        if (m_isActivated) deactivate();
        if (m_effect && m_effect->dispatcher) {
            m_effect->dispatcher(m_effect, effClose, 0, 0, nullptr, 0.0f);
            m_effect = nullptr;
        }
        m_library.unload();
    }

    bool activate() override {
        if (!m_effect || !m_effect->dispatcher) return false;
        m_effect->dispatcher(m_effect, effMainsChanged, 0, 1, nullptr, 0.0f);
        m_isActivated = true;
        return true;
    }

    void deactivate() override {
        if (m_effect && m_effect->dispatcher && m_isActivated) {
            m_effect->dispatcher(m_effect, effMainsChanged, 0, 0, nullptr, 0.0f);
        }
        m_isActivated = false;
    }

    bool isActivated() const override { return m_isActivated; }

    void reset() override {
        if (m_effect && m_effect->dispatcher) {
            m_effect->dispatcher(m_effect, effMainsChanged, 0, 0, nullptr, 0.0f);
            m_effect->dispatcher(m_effect, effMainsChanged, 0, 1, nullptr, 0.0f);
        }
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!m_effect || !m_isActivated) return;

        if (m_effect->processReplacing) {
            m_effect->processReplacing(m_effect, inputs, outputs, numFrames);
        } else if (m_effect->process) {
            m_effect->process(m_effect, inputs, outputs, numFrames);
        }
    }

    void setProcessContext(const ProcessContext& ctx) override {
        m_processContext = ctx;
    }

    int32_t getLatencySamples() const override {
        if (!m_effect) return 0;
        return m_effect->initialDelay;
    }

    int32_t getTailSamples() const override {
        if (!m_effect || !m_effect->dispatcher) return 0;
        return (int32_t)m_effect->dispatcher(m_effect, effGetTailSize, 0, 0, nullptr, 0.0f);
    }

    uint32_t getParameterCount() const override {
        return m_effect ? (uint32_t)m_effect->numParams : 0;
    }

    bool getParameterInfo(uint32_t index, ParameterDescriptor& outInfo) const override {
        if (!m_effect || index >= (uint32_t)m_effect->numParams) return false;

        outInfo.id = index;
        char nameBuffer[256] = {0};
        char labelBuffer[256] = {0};
        char displayBuffer[256] = {0};

        m_effect->dispatcher(m_effect, effGetParamName, (int32_t)index, 0, nameBuffer, 0.0f);
        m_effect->dispatcher(m_effect, effGetParamLabel, (int32_t)index, 0, labelBuffer, 0.0f);
        m_effect->dispatcher(m_effect, effGetParamDisplay, (int32_t)index, 0, displayBuffer, 0.0f);

        outInfo.name = nameBuffer[0] ? nameBuffer : ("Param " + std::to_string(index));
        outInfo.label = labelBuffer;
        outInfo.units = labelBuffer;
        outInfo.defaultValue = getParameter(index);
        outInfo.minValue = 0.0f;
        outInfo.maxValue = 1.0f;
        outInfo.stepCount = 0;
        outInfo.isAutomatable = true;
        outInfo.isReadOnly = false;
        return true;
    }

    void setParameter(uint32_t paramId, float value) override {
        if (!m_effect || !m_effect->setParameter) return;
        float clamped = std::max(0.0f, std::min(1.0f, value));
        m_effect->setParameter(m_effect, (int32_t)paramId, clamped);
    }

    float getParameter(uint32_t paramId) const override {
        if (!m_effect || !m_effect->getParameter) return 0.0f;
        return m_effect->getParameter(m_effect, (int32_t)paramId);
    }

    bool getState(std::vector<uint8_t>& outState) override {
        if (!m_effect || !m_effect->dispatcher) return false;

        // Если плагин поддерживает бинарные чанки (Program Chunks)
        if (m_effect->flags & effFlagsProgramChunks) {
            void* chunkPtr = nullptr;
            intptr_t chunkSize = m_effect->dispatcher(m_effect, effGetChunk, 0 /* 0 = bank chunk */, 0, &chunkPtr, 0.0f);
            if (chunkSize > 0 && chunkPtr) {
                outState.resize((size_t)chunkSize + 8);
                // Заголовок VST2 чанка: 'V','S','T','2', размер (uint32)
                outState[0] = 'V'; outState[1] = 'S'; outState[2] = 'T'; outState[3] = '2';
                uint32_t rawSize = (uint32_t)chunkSize;
                std::memcpy(&outState[4], &rawSize, 4);
                std::memcpy(outState.data() + 8, chunkPtr, (size_t)chunkSize);
                return true;
            }
        }

        // Fallback: Сериализация значений всех параметров
        uint32_t count = getParameterCount();
        outState.resize(8 + count * sizeof(float));
        outState[0] = 'V'; outState[1] = '2'; outState[2] = 'P'; outState[3] = 'R';
        std::memcpy(&outState[4], &count, 4);
        float* fPtr = reinterpret_cast<float*>(outState.data() + 8);
        for (uint32_t i = 0; i < count; ++i) {
            fPtr[i] = getParameter(i);
        }
        return true;
    }

    bool setState(const uint8_t* data, size_t size) override {
        if (!m_effect || !m_effect->dispatcher || !data || size < 8) return false;

        // Чанк-состояние
        if (data[0] == 'V' && data[1] == 'S' && data[2] == 'T' && data[3] == '2') {
            uint32_t chunkSize = 0;
            std::memcpy(&chunkSize, &data[4], 4);
            if (size >= 8 + chunkSize) {
                m_effect->dispatcher(m_effect, effSetChunk, 0, (intptr_t)chunkSize, (void*)(data + 8), 0.0f);
                return true;
            }
        }

        // Параметрическое состояние
        if (data[0] == 'V' && data[1] == '2' && data[2] == 'P' && data[3] == 'R') {
            uint32_t count = 0;
            std::memcpy(&count, &data[4], 4);
            const float* fPtr = reinterpret_cast<const float*>(data + 8);
            size_t available = (size - 8) / sizeof(float);
            uint32_t toApply = std::min(count, (uint32_t)available);
            for (uint32_t i = 0; i < toApply; ++i) {
                setParameter(i, fPtr[i]);
            }
            return true;
        }

        return false;
    }

    bool hasEditor() const override {
        return m_effect && (m_effect->flags & effFlagsHasEditor);
    }

    void* openEditor(void* parentWindowHandle) override {
        if (!hasEditor() || !m_effect->dispatcher) return nullptr;
        m_effect->dispatcher(m_effect, effEditOpen, 0, 0, parentWindowHandle, 0.0f);
        return parentWindowHandle;
    }

    void closeEditor() override {
        if (hasEditor() && m_effect->dispatcher) {
            m_effect->dispatcher(m_effect, effEditClose, 0, 0, nullptr, 0.0f);
        }
    }

    bool getEditorSize(int32_t& width, int32_t& height) override {
        if (!hasEditor() || !m_effect->dispatcher) return false;
        ERect* rect = nullptr;
        m_effect->dispatcher(m_effect, effEditGetRect, 0, 0, &rect, 0.0f);
        if (rect) {
            width = rect->right - rect->left;
            height = rect->bottom - rect->top;
            return true;
        }
        return false;
    }

    AEffect* getAEffect() const { return m_effect; }
    uint32_t getShellUid() const { return m_descriptor.shellId; }
    const ProcessContext& getProcessContext() const { return m_processContext; }

    // Регистрация экземпляров для обратного вызова audioMasterCallback
    static void registerInstance(VST2PluginInstance* inst) {
        std::lock_guard<std::mutex> lock(s_mapMutex);
        s_instances[inst->getAEffect()] = inst;
    }

    static void unregisterInstance(VST2PluginInstance* inst) {
        std::lock_guard<std::mutex> lock(s_mapMutex);
        s_instances.erase(inst->getAEffect());
    }

    static VST2PluginInstance* findInstance(AEffect* effect) {
        std::lock_guard<std::mutex> lock(s_mapMutex);
        auto it = s_instances.find(effect);
        return (it != s_instances.end()) ? it->second : nullptr;
    }

    static intptr_t audioMasterCallback(
        AEffect* effect,
        int32_t opcode,
        int32_t index,
        intptr_t value,
        void* ptr,
        float opt
    ) {
        switch (opcode) {
            case audioMasterVersion:
                return 2400; // VST 2.4
            case audioMasterCurrentId: {
                // Поддержка Waves Shell плагинов: плагин запрашивает выбранный sub-plugin ID
                VST2PluginInstance* inst = findInstance(effect);
                if (inst) {
                    return (intptr_t)inst->getShellUid();
                }
                return 0;
            }
            case audioMasterGetSampleRate: {
                VST2PluginInstance* inst = findInstance(effect);
                return inst ? (intptr_t)inst->m_sampleRate : 48000;
            }
            case audioMasterGetBlockSize: {
                VST2PluginInstance* inst = findInstance(effect);
                return inst ? (intptr_t)inst->m_blockSize : 512;
            }
            case audioMasterGetTime: {
                VST2PluginInstance* inst = findInstance(effect);
                static VstTimeInfo timeInfo;
                std::memset(&timeInfo, 0, sizeof(timeInfo));
                if (inst) {
                    const auto& ctx = inst->getProcessContext();
                    timeInfo.sampleRate = ctx.sampleRate;
                    timeInfo.samplePos = (double)ctx.projectTimeSamples;
                    timeInfo.tempo = ctx.tempoBpm;
                    timeInfo.timeSigNumerator = (int32_t)ctx.timeSigNumerator;
                    timeInfo.timeSigDenominator = (int32_t)ctx.timeSigDenominator;
                    timeInfo.ppqPos = (ctx.projectTimeSeconds * (ctx.tempoBpm / 60.0));
                    timeInfo.flags = 1 /* kVstTransportPlaying */ | 2 /* kVstTempoValid */ | 8 /* kVstPpqPosValid */;
                }
                return (intptr_t)&timeInfo;
            }
            case audioMasterGetVendorString: {
                if (ptr) {
                    std::strncpy((char*)ptr, "VOMIXStudio", 64);
                    return 1;
                }
                break;
            }
            case audioMasterGetProductString: {
                if (ptr) {
                    std::strncpy((char*)ptr, "VOMIX Audio Core Native DAW", 64);
                    return 1;
                }
                break;
            }
            case audioMasterGetVendorVersion:
                return 1000;
            case audioMasterCanDo: {
                if (ptr) {
                    const char* canDoStr = (const char*)ptr;
                    if (std::strcmp(canDoStr, "sendVstEvents") == 0 ||
                        std::strcmp(canDoStr, "sendVstMidiEvent") == 0 ||
                        std::strcmp(canDoStr, "sizeWindow") == 0 ||
                        std::strcmp(canDoStr, "shellCategory") == 0) {
                        return 1;
                    }
                }
                return 0;
            }
            default:
                break;
        }
        return 0;
    }

private:
    DynamicLibrary m_library;
    AEffect* m_effect;
    SubPluginDescriptor m_descriptor;
    std::string m_libraryPath;
    double m_sampleRate;
    int32_t m_blockSize;
    bool m_isActivated;
    ProcessContext m_processContext;

    static std::mutex s_mapMutex;
    static std::unordered_map<AEffect*, VST2PluginInstance*> s_instances;
};

std::mutex VST2PluginInstance::s_mapMutex;
std::unordered_map<AEffect*, VST2PluginInstance*> VST2PluginInstance::s_instances;

// =============================================================================
// РЕАЛИЗАЦИЯ IVSTPluginInstance ДЛЯ VST 3.7 (С ПОДДЕРЖКОЙ SUB-PLUGINS/SHELL)
// =============================================================================

class VST3PluginInstance : public IVSTPluginInstance {
public:
    VST3PluginInstance(
        DynamicLibrary&& lib,
        IPluginFactory* factory,
        IComponent* component,
        IAudioProcessor* processor,
        IEditController* controller,
        const SubPluginDescriptor& desc,
        const std::string& libraryPath
    ) : m_library(std::move(lib)),
        m_factory(factory),
        m_component(component),
        m_processor(processor),
        m_controller(controller),
        m_descriptor(desc),
        m_libraryPath(libraryPath),
        m_sampleRate(48000.0),
        m_blockSize(512),
        m_isActivated(false)
    {
        if (m_factory) m_factory->addRef();
        if (m_component) m_component->addRef();
        if (m_processor) m_processor->addRef();
        if (m_controller) m_controller->addRef();
        m_paramChanges = new ParameterChangesImpl();
    }

    ~VST3PluginInstance() override {
        terminate();
        if (m_paramChanges) {
            m_paramChanges->release();
            m_paramChanges = nullptr;
        }
        if (m_controller) { m_controller->release(); m_controller = nullptr; }
        if (m_processor) { m_processor->release(); m_processor = nullptr; }
        if (m_component) { m_component->release(); m_component = nullptr; }
        if (m_factory) { m_factory->release(); m_factory = nullptr; }
    }

    const SubPluginDescriptor& getDescriptor() const override { return m_descriptor; }
    PluginFormat getFormat() const override { return PluginFormat::VST3; }
    const std::string& getLibraryPath() const override { return m_libraryPath; }

    bool initialize(double sampleRate, int32_t maxBlockSize) override {
        if (!m_component) return false;
        m_sampleRate = sampleRate;
        m_blockSize = maxBlockSize;

        // Инициализация IComponent
        m_component->initialize(nullptr);
        m_component->setIoMode(0 /* kSimple */);

        // Инициализация IEditController
        if (m_controller) {
            m_controller->initialize(nullptr);
            // Синхронизация состояния контроллера с компонентом
            MemoryBStream stream;
            if (m_component->getState(&stream) == kResultOk) {
                stream.seek(0, 0, nullptr);
                m_controller->setComponentState(&stream);
            }
        }

        // Настройка обработки IAudioProcessor
        if (m_processor) {
            ProcessSetup setup;
            setup.processMode = 0; // kRealtime
            setup.symbolicSampleSize = 0; // kSample32
            setup.maxSamplesPerBlock = maxBlockSize;
            setup.sampleRate = sampleRate;
            m_processor->setupProcessing(setup);
        }

        return true;
    }

    void terminate() override {
        if (m_isActivated) deactivate();
        if (m_controller) m_controller->terminate();
        if (m_component) m_component->terminate();
        m_library.unload();
    }

    bool activate() override {
        if (!m_component) return false;

        // Активируем стерео шины входов и выходов
        m_component->activateBus(0 /* kAudio */, 0 /* kInput */, 0, 1);
        m_component->activateBus(0 /* kAudio */, 1 /* kOutput */, 0, 1);

        m_component->setActive(true);
        if (m_processor) {
            m_processor->setProcessing(true);
        }
        m_isActivated = true;
        return true;
    }

    void deactivate() override {
        if (m_processor) {
            m_processor->setProcessing(false);
        }
        if (m_component) {
            m_component->setActive(false);
        }
        m_isActivated = false;
    }

    bool isActivated() const override { return m_isActivated; }

    void reset() override {
        if (m_processor) {
            m_processor->setProcessing(false);
            m_processor->setProcessing(true);
        }
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!m_processor || !m_isActivated) return;

        AudioBusBuffers inBus;
        inBus.numChannels = m_descriptor.numInputs;
        inBus.silenceFlags = 0;
        inBus.channelBuffers32 = inputs;

        AudioBusBuffers outBus;
        outBus.numChannels = m_descriptor.numOutputs;
        outBus.silenceFlags = 0;
        outBus.channelBuffers32 = outputs;

        ProcessContextVst3 ctx3;
        std::memset(&ctx3, 0, sizeof(ctx3));
        ctx3.sampleRate = m_sampleRate;
        ctx3.projectTimeSamples = m_processContext.projectTimeSamples;
        ctx3.tempo = m_processContext.tempoBpm;
        ctx3.timeSigNumerator = (int32)m_processContext.timeSigNumerator;
        ctx3.timeSigDenominator = (int32)m_processContext.timeSigDenominator;
        ctx3.state = m_processContext.isPlaying ? 1 : 0;

        ProcessData data;
        data.processMode = 0; // kRealtime
        data.symbolicSampleSize = 0; // kSample32
        data.numSamples = numFrames;
        data.numInputs = (inputs != nullptr) ? 1 : 0;
        data.numOutputs = 1;
        data.inputs = &inBus;
        data.outputs = &outBus;
        data.inputParameterChanges = m_paramChanges;
        data.outputParameterChanges = nullptr;
        data.inputEvents = nullptr;
        data.outputEvents = nullptr;
        data.processContext = &ctx3;

        m_processor->process(data);

        // Очищаем отработанную очередь автоматизации
        m_paramChanges->clear();
    }

    void setProcessContext(const ProcessContext& ctx) override {
        m_processContext = ctx;
    }

    int32_t getLatencySamples() const override {
        return m_processor ? m_processor->getLatencySamples() : 0;
    }

    int32_t getTailSamples() const override {
        return m_processor ? (int32_t)m_processor->getTailSamples() : 0;
    }

    uint32_t getParameterCount() const override {
        return m_controller ? (uint32_t)m_controller->getParameterCount() : 0;
    }

    bool getParameterInfo(uint32_t index, ParameterDescriptor& outInfo) const override {
        if (!m_controller) return false;
        ParameterInfoVst3 info;
        std::memset(&info, 0, sizeof(info));
        if (m_controller->getParameterInfo((int32)index, info) != kResultOk) return false;

        outInfo.id = info.id;

        // Преобразование char16_t в std::string
        auto u16ToUtf8 = [](const char16_t* s) -> std::string {
            std::string r;
            while (*s) {
                char16_t c = *s++;
                if (c < 0x80) r.push_back((char)c);
                else r.push_back('?');
            }
            return r;
        };

        outInfo.name = u16ToUtf8(info.title);
        outInfo.label = u16ToUtf8(info.shortTitle);
        outInfo.units = u16ToUtf8(info.units);
        outInfo.defaultValue = (float)info.defaultNormalizedValue;
        outInfo.minValue = 0.0f;
        outInfo.maxValue = 1.0f;
        outInfo.stepCount = info.stepCount;
        outInfo.isAutomatable = (info.flags & 1 /* kCanAutomate */) != 0;
        outInfo.isReadOnly = (info.flags & 2 /* kIsReadOnly */) != 0;
        return true;
    }

    void setParameter(uint32_t paramId, float value) override {
        float clamped = std::max(0.0f, std::min(1.0f, value));
        if (m_controller) {
            m_controller->setParamNormalized((ParamID)paramId, (ParamValue)clamped);
        }

        // Передача изменения в процессинговую очередь для сэмпл-точной автоматизации
        if (m_paramChanges) {
            int32 queueIndex = 0;
            IParamValueQueue* queue = m_paramChanges->addParameterData((ParamID)paramId, queueIndex);
            if (queue) {
                int32 ptIndex = 0;
                queue->addPoint(0, (ParamValue)clamped, ptIndex);
            }
        }
    }

    float getParameter(uint32_t paramId) const override {
        if (!m_controller) return 0.0f;
        return (float)m_controller->getParamNormalized((ParamID)paramId);
    }

    bool getState(std::vector<uint8_t>& outState) override {
        if (!m_component) return false;

        MemoryBStream compStream;
        if (m_component->getState(&compStream) != kResultOk) return false;

        MemoryBStream ctrlStream;
        if (m_controller) {
            m_controller->getState(&ctrlStream);
        }

        const auto& compData = compStream.getBuffer();
        const auto& ctrlData = ctrlStream.getBuffer();

        // Упаковка VST3 контейнера:
        // [4 байта: 'V','S','T','3']
        // [4 байта: размер состояния Component (uint32)]
        // [Данные Component]
        // [4 байта: размер состояния Controller (uint32)]
        // [Данные Controller]
        uint32_t compSize = (uint32_t)compData.size();
        uint32_t ctrlSize = (uint32_t)ctrlData.size();

        outState.resize(12 + compSize + ctrlSize);
        outState[0] = 'V'; outState[1] = 'S'; outState[2] = 'T'; outState[3] = '3';
        std::memcpy(&outState[4], &compSize, 4);
        if (compSize > 0) {
            std::memcpy(outState.data() + 8, compData.data(), compSize);
        }
        std::memcpy(outState.data() + 8 + compSize, &ctrlSize, 4);
        if (ctrlSize > 0) {
            std::memcpy(outState.data() + 12 + compSize, ctrlData.data(), ctrlSize);
        }

        return true;
    }

    bool setState(const uint8_t* data, size_t size) override {
        if (!m_component || !data || size < 12) return false;
        if (data[0] != 'V' || data[1] != 'S' || data[2] != 'T' || data[3] != '3') return false;

        uint32_t compSize = 0;
        std::memcpy(&compSize, &data[4], 4);
        if (size < 8 + compSize + 4) return false;

        if (compSize > 0) {
            std::vector<uint8_t> compBuf(data + 8, data + 8 + compSize);
            MemoryBStream compStream(compBuf);
            m_component->setState(&compStream);

            if (m_controller) {
                compStream.seek(0, 0, nullptr);
                m_controller->setComponentState(&compStream);
            }
        }

        uint32_t ctrlSize = 0;
        std::memcpy(&ctrlSize, &data[8 + compSize], 4);
        if (size >= 12 + compSize + ctrlSize && ctrlSize > 0 && m_controller) {
            std::vector<uint8_t> ctrlBuf(data + 12 + compSize, data + 12 + compSize + ctrlSize);
            MemoryBStream ctrlStream(ctrlBuf);
            m_controller->setState(&ctrlStream);
        }

        return true;
    }

    bool hasEditor() const override { return false; }
    void* openEditor(void*) override { return nullptr; }
    void closeEditor() override {}
    bool getEditorSize(int32_t&, int32_t&) override { return false; }

private:
    DynamicLibrary m_library;
    IPluginFactory* m_factory;
    IComponent* m_component;
    IAudioProcessor* m_processor;
    IEditController* m_controller;
    SubPluginDescriptor m_descriptor;
    std::string m_libraryPath;
    double m_sampleRate;
    int32_t m_blockSize;
    bool m_isActivated;
    ProcessContext m_processContext;
    ParameterChangesImpl* m_paramChanges;
};

// =============================================================================
// РЕАЛИЗАЦИЯ VST3HostEngine (ПОИСК, ОПРОС SHELL, СОЗДАНИЕ ИНСТАНСОВ)
// =============================================================================

VST3HostEngine& VST3HostEngine::getInstance() {
    static VST3HostEngine s_instance;
    return s_instance;
}

VST3HostEngine::VST3HostEngine() = default;
VST3HostEngine::~VST3HostEngine() = default;

PluginFormat VST3HostEngine::probeFormat(const std::string& libraryPath) {
    // 1. Проверка по расширению
    if (libraryPath.find(".vst3") != std::string::npos) {
        return PluginFormat::VST3;
    }

    // 2. Проверка по экспортируемым символам динамической библиотеки
    DynamicLibrary lib;
    if (!lib.load(libraryPath)) {
        return PluginFormat::Unknown;
    }

    if (lib.getSymbol("GetPluginFactory")) {
        return PluginFormat::VST3;
    }
    if (lib.getSymbol("VSTPluginMain") || lib.getSymbol("main")) {
        return PluginFormat::VST2;
    }

    return PluginFormat::Unknown;
}

std::vector<SubPluginDescriptor> VST3HostEngine::enumerateSubPlugins(const std::string& libraryPath) {
    std::lock_guard<std::mutex> lock(m_engineMutex);
    std::vector<SubPluginDescriptor> results;

    DynamicLibrary lib;
    if (!lib.load(libraryPath)) {
        std::cerr << "[VST3HostEngine] Не удалось загрузить динамическую библиотеку: " << libraryPath << std::endl;
        return results;
    }

    // --- 1. Проверка на VST3 плагин / бандл ---
    auto getFactoryProc = (IPluginFactory* (*)())lib.getSymbol("GetPluginFactory");
    if (getFactoryProc) {
        IPluginFactory* factory = getFactoryProc();
        if (factory) {
            int32 numClasses = factory->countClasses();

            // Пробуем расширенный IPluginFactory2 для получения детальных категорий
            IPluginFactory2* factory2 = nullptr;
            factory->queryInterface(IPluginFactory_iid, (void**)&factory2);

            for (int32 i = 0; i < numClasses; ++i) {
                PClassInfo classInfo;
                if (factory->getClassInfo(i, &classInfo) == kResultOk) {
                    // Фильтруем только классы аудиопроцессоров ("Audio Module Class")
                    if (std::strcmp(classInfo.category, "Audio Module Class") == 0 ||
                        std::strcmp(classInfo.category, "Component") == 0) {
                        SubPluginDescriptor desc;
                        desc.uid = tuidToString(classInfo.cid);
                        desc.name = classInfo.name;
                        desc.category = classInfo.category;
                        desc.sdkVersion = "VST 3.7";
                        desc.isShellSubPlugin = (numClasses > 1);

                        if (factory2) {
                            PClassInfo2 classInfo2;
                            if (factory2->getClassInfo2(i, &classInfo2) == kResultOk) {
                                desc.vendor = classInfo2.vendor;
                                desc.version = classInfo2.version;
                                desc.category = classInfo2.subCategories;
                                desc.sdkVersion = classInfo2.sdkVersion;
                            }
                        }

                        results.push_back(desc);
                    }
                }
            }
            if (factory2) factory2->release();
            return results;
        }
    }

    // --- 2. Проверка на VST2 плагин (включая Shell плагины Waves/UAD) ---
    auto mainProc = (VstPluginMainFunc)lib.getSymbol("VSTPluginMain");
    if (!mainProc) {
        mainProc = (VstPluginMainFunc)lib.getSymbol("main");
    }

    if (mainProc) {
        AEffect* effect = mainProc(VST2PluginInstance::audioMasterCallback);
        if (effect && effect->magic == 0x56737450 /* 'VstP' */) {
            // Инициализируем плагин для опроса
            if (effect->dispatcher) {
                effect->dispatcher(effect, effOpen, 0, 0, nullptr, 0.0f);

                // Опрос VST2 Shell суб-плагинов через opcode effVendorSpecific (kVst/shel)
                char subPluginName[256] = {0};
                int32_t shellSubUid = 0;
                bool isShell = false;

                // Waves WaveShell VST2 протокол перечисления суб-плагинов:
                // Вызов effVendorSpecific с index = 0x53686c6c ('Shll') или 0x7368656c ('shel')
                while ((shellSubUid = (int32_t)effect->dispatcher(
                    effect,
                    effVendorSpecific,
                    0,
                    0x7368656c /* 'shel' */,
                    subPluginName,
                    0.0f
                )) > 0) {
                    isShell = true;
                    SubPluginDescriptor desc;
                    std::stringstream ss;
                    ss << std::hex << shellSubUid;
                    desc.uid = ss.str();
                    desc.shellId = (uint32_t)shellSubUid;
                    desc.name = subPluginName[0] ? subPluginName : ("SubPlugin " + ss.str());
                    desc.category = "Fx|Dynamics";
                    desc.vendor = "Waves / Shell Vendor";
                    desc.version = "2.4";
                    desc.sdkVersion = "VST 2.4";
                    desc.isShellSubPlugin = true;
                    desc.numInputs = effect->numInputs;
                    desc.numOutputs = effect->numOutputs;
                    results.push_back(desc);

                    std::memset(subPluginName, 0, sizeof(subPluginName));
                }

                // Если это стандартный одиночный VST2 плагин (не Shell)
                if (!isShell) {
                    SubPluginDescriptor desc;
                    char effectName[256] = {0};
                    char vendorName[256] = {0};
                    char productString[256] = {0};

                    effect->dispatcher(effect, effGetEffectName, 0, 0, effectName, 0.0f);
                    effect->dispatcher(effect, effGetVendorString, 0, 0, vendorName, 0.0f);
                    effect->dispatcher(effect, effGetProductString, 0, 0, productString, 0.0f);

                    std::stringstream ss;
                    ss << std::hex << effect->uniqueID;
                    desc.uid = ss.str();
                    desc.shellId = (uint32_t)effect->uniqueID;
                    desc.name = effectName[0] ? effectName : (productString[0] ? productString : "VST2 Plugin");
                    desc.vendor = vendorName[0] ? vendorName : "Unknown Vendor";
                    desc.version = std::to_string(effect->version);
                    desc.sdkVersion = "VST 2.4";
                    desc.category = "Fx";
                    desc.isShellSubPlugin = false;
                    desc.numInputs = effect->numInputs;
                    desc.numOutputs = effect->numOutputs;
                    results.push_back(desc);
                }

                effect->dispatcher(effect, effClose, 0, 0, nullptr, 0.0f);
            }
        }
    }

    return results;
}

std::unique_ptr<IVSTPluginInstance> VST3HostEngine::createInstance(
    const std::string& libraryPath,
    const std::string& subPluginUid
) {
    std::lock_guard<std::mutex> lock(m_engineMutex);

    DynamicLibrary lib;
    if (!lib.load(libraryPath)) {
        std::cerr << "[VST3HostEngine] Ошибка загрузки библиотеки для инстанцирования: " << libraryPath << std::endl;
        return nullptr;
    }

    // --- 1. Попытка инстанцирования VST3 плагина ---
    auto getFactoryProc = (IPluginFactory* (*)())lib.getSymbol("GetPluginFactory");
    if (getFactoryProc) {
        IPluginFactory* factory = getFactoryProc();
        if (factory) {
            int32 numClasses = factory->countClasses();
            TUID targetCid;
            bool foundTarget = false;
            SubPluginDescriptor matchedDesc;

            IPluginFactory2* factory2 = nullptr;
            factory->queryInterface(IPluginFactory_iid, (void**)&factory2);

            for (int32 i = 0; i < numClasses; ++i) {
                PClassInfo classInfo;
                if (factory->getClassInfo(i, &classInfo) == kResultOk) {
                    if (std::strcmp(classInfo.category, "Audio Module Class") == 0 ||
                        std::strcmp(classInfo.category, "Component") == 0) {
                        std::string classUidStr = tuidToString(classInfo.cid);

                        // Если конкретный UID не задан — берем первый подходящий класс
                        if (subPluginUid.empty() || subPluginUid == classUidStr) {
                            std::memcpy(targetCid, classInfo.cid, 16);
                            matchedDesc.uid = classUidStr;
                            matchedDesc.name = classInfo.name;
                            matchedDesc.category = classInfo.category;
                            matchedDesc.sdkVersion = "VST 3.7";
                            matchedDesc.isShellSubPlugin = (numClasses > 1);

                            if (factory2) {
                                PClassInfo2 classInfo2;
                                if (factory2->getClassInfo2(i, &classInfo2) == kResultOk) {
                                    matchedDesc.vendor = classInfo2.vendor;
                                    matchedDesc.version = classInfo2.version;
                                    matchedDesc.category = classInfo2.subCategories;
                                }
                            }
                            foundTarget = true;
                            break;
                        }
                    }
                }
            }

            if (factory2) factory2->release();

            if (foundTarget) {
                IComponent* component = nullptr;
                if (factory->createInstance(targetCid, IComponent_iid, (void**)&component) == kResultOk && component) {
                    IAudioProcessor* processor = nullptr;
                    component->queryInterface(IAudioProcessor_iid, (void**)&processor);

                    IEditController* controller = nullptr;
                    TUID controllerCid;
                    if (component->getControllerClassId(controllerCid) == kResultOk) {
                        factory->createInstance(controllerCid, IEditController_iid, (void**)&controller);
                    } else {
                        // Контроллер может реализовывать тот же интерфейс в одном классе
                        component->queryInterface(IEditController_iid, (void**)&controller);
                    }

                    return std::make_unique<VST3PluginInstance>(
                        std::move(lib),
                        factory,
                        component,
                        processor,
                        controller,
                        matchedDesc,
                        libraryPath
                    );
                }
            }
        }
    }

    // --- 2. Попытка инстанцирования VST2 плагина ---
    auto mainProc = (VstPluginMainFunc)lib.getSymbol("VSTPluginMain");
    if (!mainProc) {
        mainProc = (VstPluginMainFunc)lib.getSymbol("main");
    }

    if (mainProc) {
        AEffect* effect = mainProc(VST2PluginInstance::audioMasterCallback);
        if (effect && effect->magic == 0x56737450 /* 'VstP' */) {
            SubPluginDescriptor desc;
            desc.name = "VST2 Plugin";
            desc.sdkVersion = "VST 2.4";

            if (!subPluginUid.empty()) {
                uint32_t shellId = (uint32_t)std::stoul(subPluginUid, nullptr, 16);
                desc.shellId = shellId;
                desc.uid = subPluginUid;
                desc.isShellSubPlugin = true;
            } else {
                desc.shellId = (uint32_t)effect->uniqueID;
                std::stringstream ss;
                ss << std::hex << effect->uniqueID;
                desc.uid = ss.str();
            }

            return std::make_unique<VST2PluginInstance>(
                std::move(lib),
                effect,
                desc,
                libraryPath
            );
        }
    }

    return nullptr;
}

std::vector<std::string> VST3HostEngine::getDefaultPluginSearchPaths() const {
    std::vector<std::string> paths;

#if defined(_WIN32) || defined(_WIN64)
    // Windows 64-bit стандартные директории
    paths.push_back("C:\\Program Files\\Common Files\\VST3");
    paths.push_back("C:\\Program Files\\VSTPlugins");
    paths.push_back("C:\\Program Files\\Steinberg\\VSTPlugins");
    paths.push_back("C:\\Program Files\\Common Files\\VST2");
    paths.push_back("C:\\Program Files (x86)\\Common Files\\VST3");
#elif defined(__APPLE__)
    // macOS стандартные директории VST3 / VST2
    paths.push_back("/Library/Audio/Plug-Ins/VST3");
    paths.push_back("/Library/Audio/Plug-Ins/VST");
    const char* home = getenv("HOME");
    if (home) {
        paths.push_back(std::string(home) + "/Library/Audio/Plug-Ins/VST3");
        paths.push_back(std::string(home) + "/Library/Audio/Plug-Ins/VST");
    }
#else
    // Linux стандартные директории
    paths.push_back("/usr/lib/vst3");
    paths.push_back("/usr/local/lib/vst3");
    paths.push_back("/usr/lib/lxvst");
    paths.push_back("/usr/lib/vst");
    const char* home = getenv("HOME");
    if (home) {
        paths.push_back(std::string(home) + "/.vst3");
        paths.push_back(std::string(home) + "/.vst");
    }
#endif

    return paths;
}

} // namespace vst
} // namespace vomix
