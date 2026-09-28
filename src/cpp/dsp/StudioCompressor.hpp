#pragma once

/**
 * ============================================================================
 * StudioCompressor.hpp - Профессиональный студийный компрессор (RT-Safe, C++17)
 * ============================================================================
 * Высокоточный компрессор динамического диапазона с квадратичным мягким коленом
 * (Soft Knee), логарифмической баллистикой огибающей, поддержкой пикового
 * и RMS детекторов, Stereo Link и точным измерителем подавления усиления (GR Meter).
 *
 * Архитектурные требования:
 * 1. Стандарт C++17.
 * 2. Аппаратное ускорение WebAssembly SIMD128.
 * 3. Полная RT-Safety (Zero Malloc в аудиопотоке `processBlock`).
 * 4. Глассман/Джанноулис математическая модель динамического диапазона.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Режим детектирования уровня сайдчейна / входного сигнала
 */
enum class CompressorDetectionMode : uint32_t {
    Peak = 0, // Мгновенный пиковый детектор (быстрая реакция на транзиенты)
    RMS = 1   // Среднеквадратичный детектор (музыкальная плотность и склеивание)
};

/**
 * Параметры студийного компрессора
 */
struct CompressorParams {
    float thresholdDb = -18.0f;       // Порог срабатывания (-60.0 .. 0.0 dB)
    float ratio = 4.0f;               // Степень компрессии (1.0 .. 30.0, 30+ = Limiting)
    float attackMs = 15.0f;           // Время атаки (0.05 .. 200.0 ms)
    float releaseMs = 120.0f;         // Время восстановления (5.0 .. 2000.0 ms)
    float kneeDb = 6.0f;              // Ширина зоны плавного перегиба (0.0 .. 24.0 dB)
    float makeupGainDb = 0.0f;        // Компенсация выходного усиления (0.0 .. 36.0 dB)
    bool stereoLink = true;           // Объединение каналов для сохранения стереопанорамы
    float dryWet = 1.0f;              // Баланс параллельной компрессии (0.0 = Dry, 1.0 = Wet)
    CompressorDetectionMode detectionMode = CompressorDetectionMode::Peak;
    bool enabled = true;              // Флаг активности компрессора
};

/**
 * Класс StudioCompressor - Студийный динамический компрессор
 */
class StudioCompressor {
public:
    StudioCompressor() noexcept;
    explicit StudioCompressor(float sampleRate) noexcept;
    ~StudioCompressor() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(float sampleRate) noexcept;

    /**
     * Обновление параметров компрессора
     */
    void setParams(const CompressorParams& params) noexcept;

    /**
     * Получение текущих параметров
     */
    const CompressorParams& getParams() const noexcept { return params_; }

    /**
     * Сброс внутреннего состояния (огибающие, фильтры, счетчики)
     */
    void reset() noexcept;

    /**
     * In-Place потоковая обработка блока аудиосэмплов (RT-Safe, Zero Malloc)
     *
     * @param inputOutput Указатель на непрерывный Float32 буфер (Interleaved для стерео)
     * @param numFrames   Количество кадров (сэмплов на канал)
     * @param channels    Число каналов (1 = моно, 2 = стерео)
     */
    void processBlock(float* inputOutput, size_t numFrames, int channels) noexcept;

    /**
     * Out-of-Place обработка блока (раздельные входной и выходной буферы)
     */
    void processBlock(const float* input, float* output, size_t numFrames, int channels) noexcept;

    /**
     * Текущее мгновенное значение подавления усиления (Gain Reduction) в положительных dB
     * Например, 4.5 dB означает сжатие сигнала на 4.5 dB. Используется для стрелочных VU-индикаторов.
     */
    float getGainReductionDb() const noexcept;

    /**
     * Пиковое удерживаемое значение Gain Reduction за последний интервал времени
     */
    float getPeakGainReductionDb() const noexcept;

    /**
     * Сброс пикового счетчика GR
     */
    void resetMetering() noexcept;

private:
    /**
     * Пересчет внутренних коэффициентов фильтров баллистики
     */
    void updateCoefficients() noexcept;

    /**
     * Расчет передаточной характеристики сглаженного мягкого колена (Soft Knee)
     * Возвращает требуемое подавление (отрицательное значение в dB, например, -6.0 dB)
     */
    float computeGainReductionDb(float inputDb) const noexcept;

    CompressorParams params_;
    float sampleRate_{48000.0f};

    // Коэффициенты баллистики огибающей
    float attackCoeff_{0.0f};
    float releaseCoeff_{0.0f};
    float rmsCoeff_{0.0f};
    float makeupGainLinear_{1.0f};

    // Состояния огибающих детекторов
    float envelopeL_{0.0f};      // Огибающая подавления левого канала (в dB)
    float envelopeR_{0.0f};      // Огибающая подавления правого канала (в dB)
    float rmsStateL_{0.0f};      // Состояние RMS усреднителя левого канала
    float rmsStateR_{0.0f};      // Состояние RMS усреднителя правого канала

    // Измеритель подавления усиления (GR Metering) с баллистикой стрелочного прибора
    float currentGainReductionDb_{0.0f};
    float peakGainReductionDb_{0.0f};
    float meterDecayCoeff_{0.0f};
};

} // namespace DAWCore
