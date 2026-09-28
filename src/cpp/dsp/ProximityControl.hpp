#pragma once

/**
 * ============================================================================
 * ProximityControl.hpp - Автоматический контроль эффекта близости (C++17, RT-Safe)
 * ============================================================================
 * Студийный интеллектуальный процессор для устранения избыточного бубнения,
 * гула и грязи в суббасе, возникающих из-за акустического эффекта близости
 * (Proximity Effect) градиентных направленных микрофонов (кардиоида, восьмерка).
 *
 * Архитектура:
 * 1. Акустическое моделирование эффекта близости:
 *    - В направленных микрофонах чувствительность на НЧ возрастает пропорционально
 *      1 / (omega * r). При приближении диктора к капсюлю полоса 50-180 Гц
 *      неестественно задирается на 6-14 дБ.
 * 2. Двухполосный спектральный сайдчейн-анализатор:
 *    - Интегратор бубнящей энергии в диапазоне 50-180 Гц (Proximity Band).
 *    - Интегратор речевой разборчивости в диапазоне 300-3000 Гц (Speech Body Band).
 * 3. Динамический расчет спектрального перекоса (Spectral Tilt Ratio):
 *    - Отношение энергии бубнения к опорному речевому диапазону.
 * 4. Адаптивный динамический Low-Shelf фильтр 2-го порядка (TDF-II):
 *    - Плавное, адаптивное ослабление низа пропорционально степени приближения
 *      диктора к микрофону.
 * 5. Плавная межкадровая интерполяция коэффициентов (Anti-Click).
 * 6. Полная RT-Safety: нулевые аллокации (Zero Malloc) и аппаратный WASM SIMD128.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <array>
#include <cmath>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры компенсатора эффекта близости микрофона
 */
struct ProximityParams {
    float cutoffFrequency = 120.0f;   // Частота среза шельфа (60.0 .. 250.0 Гц)
    float thresholdDb = -6.0f;        // Порог относительного избытка баса (-18.0 .. 0.0 дБ)
    float maxReductionDb = -10.0f;    // Максимальное ослабление бубнения (-18.0 .. -2.0 дБ)
    float responseMs = 25.0f;         // Время реакции на приближение (5.0 .. 150.0 мс)
    float releaseMs = 120.0f;         // Время восстановления баланса (20.0 .. 500.0 мс)
    float sensitivity = 1.0f;         // Коэффициент чувствительности (0.2 .. 2.5)
    bool enabled = true;              // Активность обработки
};

/**
 * Нормализованные биквадратные коэффициенты фильтра
 */
struct ProxBiquadCoeffs {
    float b0 = 1.0f;
    float b1 = 0.0f;
    float b2 = 0.0f;
    float a1 = 0.0f;
    float a2 = 0.0f;
};

/**
 * Регистры состояния фильтра TDF-II
 */
struct ProxBiquadState {
    float s1L = 0.0f;
    float s2L = 0.0f;
    float s1R = 0.0f;
    float s2R = 0.0f;

    inline void reset() noexcept {
        s1L = 0.0f; s2L = 0.0f;
        s1R = 0.0f; s2R = 0.0f;
    }
};

/**
 * Класс ProximityControl - Контроллер эффекта близости
 */
class ProximityControl {
public:
    explicit ProximityControl(float sampleRate = 48000.0f) noexcept;
    ~ProximityControl() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    /**
     * Установка параметров работы
     */
    void setParams(const ProximityParams& params) noexcept;
    const ProximityParams& getParams() const noexcept { return params_; }

    /**
     * Сброс внутренних интеграторов и фильтров
     */
    void reset() noexcept;

    /**
     * Текущая величина ослабления в дБ (для UI измерителя)
     */
    float getCurrentAttenuationDb() const noexcept { return currentShelfGainDb_; }

    /**
     * Текущее отношение энергии баса к середине в дБ
     */
    float getProximityRatioDb() const noexcept { return currentRatioDb_; }

    /**
     * Потоковая In-Place обработка блока аудиосэмплов (RT-Safe, SIMD128, Zero Malloc)
     *
     * @param samples    Указатель на PCM Float32 буфер (Interleaved для стерео)
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
     * Расчет коэффициентов сайдчейн фильтров (полоса 50-180 Гц и 300-3000 Гц)
     */
    void updateSidechainFilters() noexcept;

    /**
     * Расчет низкочастотного шельфового фильтра Low-Shelf 2-го порядка
     */
    static ProxBiquadCoeffs calculateLowShelfCoeffs(float freq, float gainDb, float sampleRate) noexcept;

    ProximityParams params_;
    float sampleRate_{48000.0f};

    // Сайдчейн фильтр 50-180 Гц (бубнение / proximity)
    ProxBiquadCoeffs lowBandCoeffs_{};
    ProxBiquadState lowBandState_{};

    // Сайдчейн фильтр 300-3000 Гц (речевая формантная основа)
    ProxBiquadCoeffs midBandCoeffs_{};
    ProxBiquadState midBandState_{};

    // Интеграторы энергии
    float lowEnergy_{0.0f};
    float midEnergy_{0.0f};
    float totalEnergy_{0.0f};
    float energySmoothCoeff_{0.995f};

    // Баллистика динамического шельфа
    float attackCoeff_{0.01f};
    float releaseCoeff_{0.002f};
    float currentShelfGainDb_{0.0f};
    float targetShelfGainDb_{0.0f};
    float currentRatioDb_{0.0f};

    // Текущие коэффициенты основного Low-Shelf фильтра аудиоканала
    ProxBiquadCoeffs currentShelfCoeffs_{};
    ProxBiquadState audioShelfState_{};
};

} // namespace DAWCore
