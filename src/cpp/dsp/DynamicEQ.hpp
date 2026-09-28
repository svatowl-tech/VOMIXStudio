#pragma once

/**
 * ============================================================================
 * DynamicEQ.hpp - Профессиональный динамический эквалайзер (C++17, RT-Safe)
 * ============================================================================
 * Студийный многополосный динамический эквалайзер с независимой детекцией
 * спектральной энергии в полосе и адаптивным управлением усилением/ослаблением
 * резонансов в реальном времени.
 *
 * Архитектура:
 * 1. Многополосная каскадная архитектура (4 независимые полосы по умолчанию).
 * 2. Сайдчейн-детекция: полосовой фильтр 2-го порядка (BPF) изолирует энергию
 *    только целевого частотного диапазона.
 * 3. Логарифмический детектор огибающей с независимыми временами Attack и Release.
 * 4. Режимы компрессии/экспансии:
 *    - Downward Compression: подавление резонансов при превышении порога (De-Essing,
 *      устранение коробочности, укрощение резких частот).
 *    - Upward Expansion: динамическое насыщение полосы при высокой активности.
 * 5. Плавная межкадровая интерполяция биквадратных коэффициентов TDF-II
 *    (Zero Zipper Noise / Anti-Click).
 * 6. Аппаратное ускорение WebAssembly SIMD128 и полная RT-Safety (Zero Malloc).
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <array>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры одной динамической полосы эквалайзера
 */
struct DynamicEQBand {
    float frequency = 1000.0f;       // Центральная частота полосы (20.0 .. 20000.0 Гц)
    float Q = 1.414f;                // Добротность фильтра (0.2 .. 20.0)
    float baseGainDb = 0.0f;         // Базовое статическое усиление (-18.0 .. +18.0 дБ)
    float thresholdDb = -20.0f;      // Порог срабатывания динамики (-60.0 .. 0.0 дБ)
    float ratio = 3.0f;              // Коэффициент компрессии/экспансии (1.0 .. 20.0)
    float attackMs = 10.0f;          // Время атаки детектора (0.5 .. 100.0 мс)
    float releaseMs = 80.0f;         // Время восстановления детектора (5.0 .. 1000.0 мс)
    float maxDynamicGainDb = 12.0f;  // Максимальный диапазон динамического гейна (дБ)
    bool isDownward = true;          // true = Downward Compression, false = Upward Expansion
    bool enabled = true;             // Активность полосы
};

/**
 * Биквадратные нормализованные коэффициенты
 */
struct DynBiquadCoeffs {
    float b0 = 1.0f;
    float b1 = 0.0f;
    float b2 = 0.0f;
    float a1 = 0.0f;
    float a2 = 0.0f;
};

/**
 * Регистры состояния фильтра TDF-II (стерео)
 */
struct DynBiquadState {
    float s1L = 0.0f;
    float s2L = 0.0f;
    float s1R = 0.0f;
    float s2R = 0.0f;

    inline void reset() noexcept {
        s1L = 0.0f;
        s2L = 0.0f;
        s1R = 0.0f;
        s2R = 0.0f;
    }
};

/**
 * Класс DynamicEQ - Профессиональный динамический эквалайзер
 */
class DynamicEQ {
public:
    static constexpr size_t NUM_BANDS = 4;

    DynamicEQ() noexcept;
    explicit DynamicEQ(double sampleRate) noexcept;
    ~DynamicEQ() = default;

    /**
     * Установка частоты дискретизации
     */
    void setSampleRate(double sampleRate) noexcept;
    double getSampleRate() const noexcept { return sampleRate_; }

    /**
     * Настройка параметров конкретной полосы (0 .. NUM_BANDS - 1)
     */
    void setBandParams(size_t bandIndex, const DynamicEQBand& params) noexcept;
    const DynamicEQBand& getBandParams(size_t bandIndex) const noexcept;

    /**
     * Получение текущей величины динамического подавления/усиления в дБ (для UI измерителей)
     */
    float getDynamicGainReductionDb(size_t bandIndex) const noexcept;

    /**
     * Установка общего коэффициента Master Output Gain (дБ)
     */
    void setOutputGainDb(float gainDb) noexcept;
    float getOutputGainDb() const noexcept { return outputGainDb_; }

    /**
     * Общий байпас эквалайзера
     */
    void setEnabled(bool enabled) noexcept { enabled_ = enabled; }
    bool isEnabled() const noexcept { return enabled_; }

    /**
     * Сброс всех детекторов огибающих и регистров задержек
     */
    void reset() noexcept;

    /**
     * Потоковая In-Place обработка блока сэмплов (RT-Safe, SIMD128, Zero Malloc)
     *
     * @param samples    Указатель на PCM Float32 буфер (Interleaved для стерео)
     * @param numFrames  Количество кадров (сэмплов на канал)
     * @param channels   Количество каналов (1 = моно, 2 = стерео)
     */
    void processBlock(float* samples, size_t numFrames, int channels) noexcept;

    /**
     * Out-of-Place обработка блока
     */
    void processBlock(
        const float* input,
        float* output,
        size_t numFrames,
        int channels
    ) noexcept;

private:
    /**
     * Аналитический расчет Peaking фильтра по формулам RBJ Audio EQ Cookbook
     */
    static DynBiquadCoeffs calculatePeakingCoeffs(
        float frequency,
        float Q,
        float gainDb,
        double sampleRate
    ) noexcept;

    /**
     * Расчет полосового фильтра для сайдчейн-детектора энергии (Band-Pass Filter)
     */
    static DynBiquadCoeffs calculateSidechainBPFCoeffs(
        float frequency,
        float Q,
        double sampleRate
    ) noexcept;

    /**
     * Пересчет баллистических коэффициентов детектора огибающей полосы
     */
    void updateBandBallistics(size_t bandIndex) noexcept;

    double sampleRate_{48000.0};
    bool enabled_{true};
    float outputGainDb_{0.0f};
    float outputGainLinear_{1.0f};

    // Настройки полос
    std::array<DynamicEQBand, NUM_BANDS> bands_;

    // Коэффициенты полосовых фильтров сайдчейна (BPF)
    std::array<DynBiquadCoeffs, NUM_BANDS> sidechainCoeffs_;
    std::array<DynBiquadState, NUM_BANDS> sidechainStates_;

    // Баллистика детекторов огибающей
    std::array<float, NUM_BANDS> attackCoeffs_{};
    std::array<float, NUM_BANDS> releaseCoeffs_{};
    std::array<float, NUM_BANDS> envelopeL_{};
    std::array<float, NUM_BANDS> envelopeR_{};

    // Текущие коэффициенты основного тракта фильтрации
    std::array<DynBiquadCoeffs, NUM_BANDS> currentCoeffs_;
    std::array<DynBiquadState, NUM_BANDS> audioStates_;

    // Метрики динамического отклонения (Gain Reduction в дБ для UI)
    std::array<float, NUM_BANDS> gainReductionDb_{};
};

} // namespace DAWCore
