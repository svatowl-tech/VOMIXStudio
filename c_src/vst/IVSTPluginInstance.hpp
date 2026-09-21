#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>
#include <memory>

namespace vomix {
namespace vst {

/**
 * @brief Поддерживаемые форматы VST плагинов
 */
enum class PluginFormat {
    Unknown = 0,
    VST2,
    VST3
};

/**
 * @brief Метаданные суб-плагина (включая Shell-плагины, такие как Waveshell)
 */
struct SubPluginDescriptor {
    std::string uid;              // Уникальный идентификатор (GUID для VST3 или 4-char ID / Hex для VST2)
    uint32_t shellId = 0;         // Числовой 32-битный UID для VST2 Shell плагинов
    std::string name;             // Название плагина (например, "CLA-76 Compressor")
    std::string category;         // Категория ("Fx|Dynamics", "Fx|EQ", "Instrument" и т.д.)
    std::string vendor;           // Производитель ("Waves", "FabFilter", etc.)
    std::string version;          // Версия плагина
    std::string sdkVersion;       // Версия SDK ("VST 2.4", "VST 3.7", etc.)
    bool isShellSubPlugin = false;// Флаг, является ли плагин дочерним элементом Shell-библиотеки
    int32_t numInputs = 2;        // Количество входных аудиоканалов
    int32_t numOutputs = 2;       // Количество выходных аудиоканалов
};

/**
 * @brief Метаданные параметра плагина
 */
struct ParameterDescriptor {
    uint32_t id = 0;              // Идентификатор параметра
    std::string name;             // Отображаемое имя
    std::string label;            // Метка единиц измерения (dB, Hz, %, ms)
    std::string units;            // Единицы измерения
    float defaultValue = 0.0f;    // Нормализованное значение по умолчанию [0.0 ... 1.0]
    float minValue = 0.0f;        // Минимальное значение
    float maxValue = 1.0f;        // Максимальное значение
    int32_t stepCount = 0;        // Количество дискретных шагов (0 для непрерывных параметров)
    bool isAutomatable = true;    // Поддерживает ли автоматизацию
    bool isReadOnly = false;      // Только для чтения (индикаторы и т.д.)
};

/**
 * @brief Контекст воспроизведения аудио ядра для синхронизации темпа и позиции
 */
struct ProcessContext {
    double sampleRate = 48000.0;
    int32_t maxBlockSize = 512;
    int32_t numInputChannels = 2;
    int32_t numOutputChannels = 2;
    double tempoBpm = 120.0;
    double timeSigNumerator = 4.0;
    double timeSigDenominator = 4.0;
    int64_t projectTimeSamples = 0;
    double projectTimeSeconds = 0.0;
    bool isPlaying = false;
};

/**
 * @brief Чистый абстрактный интерфейс экземпляра VST2/VST3 плагина в Audio Core
 */
class IVSTPluginInstance {
public:
    virtual ~IVSTPluginInstance() = default;

    // --- Метаданные ---
    virtual const SubPluginDescriptor& getDescriptor() const = 0;
    virtual PluginFormat getFormat() const = 0;
    virtual const std::string& getLibraryPath() const = 0;

    // --- Жизненный цикл плагина ---
    virtual bool initialize(double sampleRate, int32_t maxBlockSize) = 0;
    virtual void terminate() = 0;
    virtual bool activate() = 0;
    virtual void deactivate() = 0;
    virtual bool isActivated() const = 0;
    virtual void reset() = 0;

    // --- Аудиопроцессинг ---
    /**
     * @brief Обработка блока аудиосэмплов
     * @param inputs Массив указателей на входные каналы [канал][сэмпл]
     * @param outputs Массив указателей на выходные каналы [канал][сэмпл]
     * @param numFrames Количество сэмплов в блоке
     */
    virtual void processBlock(float** inputs, float** outputs, int32_t numFrames) = 0;

    /**
     * @brief Обновление контекста таймлайна DAW (темп, позиция сэмплов)
     */
    virtual void setProcessContext(const ProcessContext& ctx) = 0;

    /**
     * @brief Задержка обработки плагина в сэмплах (для Plugin Delay Compensation)
     */
    virtual int32_t getLatencySamples() const = 0;

    /**
     * @brief Длина хвоста реверберации/дилея в сэмплах
     */
    virtual int32_t getTailSamples() const = 0;

    // --- Управление параметрами ---
    virtual uint32_t getParameterCount() const = 0;
    virtual bool getParameterInfo(uint32_t index, ParameterDescriptor& outInfo) const = 0;

    /**
     * @brief Установка нормализованного значения параметра в диапазоне [0.0 ... 1.0]
     */
    virtual void setParameter(uint32_t paramId, float value) = 0;

    /**
     * @brief Получение текущего нормализованного значения параметра [0.0 ... 1.0]
     */
    virtual float getParameter(uint32_t paramId) const = 0;

    // --- Управление бинарным состоянием (Chunks) ---
    /**
     * @brief Экспорт бинарного слепка пресета плагина для project.json
     * @param outState Выходной буфер байт
     * @return true в случае успешной выгрузки
     */
    virtual bool getState(std::vector<uint8_t>& outState) = 0;

    /**
     * @brief Импорт бинарного слепка пресета плагина из project.json
     * @param data Указатель на массив байт
     * @param size Размер буфера в байтах
     * @return true в случае успешного восстановления состояния
     */
    virtual bool setState(const uint8_t* data, size_t size) = 0;

    // --- Графический интерфейс (GUI) ---
    virtual bool hasEditor() const = 0;
    virtual void* openEditor(void* parentWindowHandle) = 0;
    virtual void closeEditor() = 0;
    virtual bool getEditorSize(int32_t& width, int32_t& height) = 0;
};

} // namespace vst
} // namespace vomix
