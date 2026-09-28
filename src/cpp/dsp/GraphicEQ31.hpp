#pragma once

/**
 * ============================================================================
 * GraphicEQ31.hpp - 31-полосный графический эквалайзер студийного класса (C++17)
 * ============================================================================
 * Высокопроизводительный каскад из 31 прецизионного биквадратного фильтра
 * с фиксированными стандартизованными ISO 266 1/3-октавными частотами
 * от 20 Гц до 20 кГц.
 *
 * Архитектура:
 * 1. Стандартные 1/3-октавные частоты ISO 266 (31 полоса, Q ≈ 4.318).
 * 2. Топология Direct Form II Transposed (TDF-II) для максимальной численной
 *    стабильности, низкого фазового джиттера и устойчивости к шумам округления.
 * 3. Динамическая интерполяция коэффициентов (Anti-Zipper / Anti-Click)
 *    при плавном перемещении слайдеров в реальном времени.
 * 4. Умный байпас нулевых полос (Zero-Cost Pass-through при Gain = 0 dB).
 * 5. Аппаратное ускорение WebAssembly SIMD128 для стереоканалов L/R.
 * 6. Полная RT-Safety: нулевые аллокации (Zero Malloc) в аудиопотоке.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <array>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Коэффициенты нормализованного биквадратного фильтра 2-го порядка
 */
struct GraphicBiquadCoeffs {
    float b0 = 1.0f;
    float b1 = 0.0f;
    float b2 = 0.0f;
    float a1 = 0.0f;
    float a2 = 0.0f;
};

/**
 * Регистры состояния фильтра TDF-II
 */
struct GraphicBiquadState {
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
 * Класс GraphicEQ31 - 31-полосный профессиональный графический эквалайзер
 */
class GraphicEQ31 {
public:
    static constexpr size_t NUM_BANDS = 31;

    // 31 стандартная 1/3-октавная частота по стандарту ISO 266
    static constexpr std::array<float, NUM_BANDS> ISO_FREQUENCIES = {
        20.0f,    25.0f,    31.5f,    40.0f,    50.0f,    63.0f,    80.0f,    100.0f,
        125.0f,   160.0f,   200.0f,   250.0f,   315.0f,   400.0f,   500.0f,   630.0f,
        800.0f,   1000.0f,  1250.0f,  1600.0f,  2000.0f,  2500.0f,  3150.0f,  4000.0f,
        5000.0f,  6300.0f,  8000.0f,  10000.0f, 12500.0f, 16000.0f, 20000.0f
    };

    explicit GraphicEQ31(double sampleRate = 48000.0) noexcept;
    ~GraphicEQ31() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(double sampleRate) noexcept;
    double getSampleRate() const noexcept { return sampleRate_; }

    /**
     * Установка усиления для конкретной полосы (0 .. 30)
     * @param bandIndex Индекс полосы от 0 до 30
     * @param gainDb    Усиление/ослабление в дБ (-15.0 .. +15.0 дБ)
     */
    void setBandGain(int bandIndex, float gainDb) noexcept;

    /**
     * Получение текущего усиления полосы в дБ
     */
    float getBandGain(int bandIndex) const noexcept;

    /**
     * Получение частоты полосы в Гц
     */
    float getBandFrequency(int bandIndex) const noexcept;

    /**
     * Сброс всех полос в 0 дБ (Flat EQ)
     */
    void resetAllBands() noexcept;

    /**
     * Установка общего коэффициента Master Output Gain (дБ)
     */
    void setMasterGainDb(float gainDb) noexcept;
    float getMasterGainDb() const noexcept { return masterGainDb_; }

    /**
     * Общий байпас эквалайзера
     */
    void setEnabled(bool enabled) noexcept { enabled_ = enabled; }
    bool isEnabled() const noexcept { return enabled_; }

    /**
     * Сброс внутренних фазовых регистров (очистка задержек)
     */
    void reset() noexcept;

    /**
     * Потоковая In-Place обработка блока аудиосэмплов (RT-Safe, SIMD128, Zero Malloc)
     *
     * @param samples    Указатель на непрерывный Float32 буфер (Interleaved для стерео)
     * @param numFrames  Число кадров (сэмплов на канал)
     * @param channels   Число каналов (1 = моно, 2 = стерео)
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
     * Аналитический расчет коэффициентов Peaking-фильтра по Audio EQ Cookbook
     */
    static GraphicBiquadCoeffs calculateBiquadCoeffs(float frequency, float gainDb, double sampleRate) noexcept;

    double sampleRate_{48000.0};
    bool enabled_{true};
    float masterGainDb_{0.0f};
    float masterGainLinear_{1.0f};

    // Усиления полос в дБ (-15.0 .. +15.0 дБ)
    std::array<float, NUM_BANDS> gainsDb_{};

    // Целевые коэффициенты для каждой полосы
    std::array<GraphicBiquadCoeffs, NUM_BANDS> targetCoeffs_{};

    // Текущие сглаживаемые коэффициенты
    std::array<GraphicBiquadCoeffs, NUM_BANDS> currentCoeffs_{};

    // Регистры задержки TDF-II
    std::array<GraphicBiquadState, NUM_BANDS> states_{};

    // Флаги необходимости интерполяции
    std::array<bool, NUM_BANDS> needsRamping_{};
};

} // namespace DAWCore
