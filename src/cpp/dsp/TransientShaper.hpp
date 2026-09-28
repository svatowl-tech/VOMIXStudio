#pragma once

/**
 * ============================================================================
 * TransientShaper.hpp - Формирователь переходных процессов (C++17, RT-Safe)
 * ============================================================================
 * Студийный DSP процессор для независимого управления атакой (Transients)
 * и телом/хвостом (Sustain) речевых, вокальных и перкуссионных дорожек.
 *
 * Архитектура:
 * 1. Двойной экспоненциальный детектор огибающей:
 *    - Быстрый детектор (Fast Envelope): отслеживает резкие фронты транзиентов.
 *    - Медленный детектор (Slow Envelope): отслеживает средний сустейн сигнала.
 * 2. Аналитическое дифференциальное разделение:
 *    - Transient Component: T = max(0, Fast - Slow)
 *    - Sustain Component: S = Slow
 * 3. Регулировка усиления атаки и сустейна в dB (-12 .. +12 дБ).
 * 4. Плавная модуляция коэффициента усиления без фазовых искажений.
 * 5. Встроенный мягкий аналоговый сатуратор (Soft Clip Tanh) для сглаживания пиков.
 * 6. Полная RT-Safety: нулевые аллокации (Zero Malloc) и поддержка WASM SIMD128.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры формирователя переходных процессов
 */
struct TransientShaperParams {
    float attackGainDb = 0.0f;     // Усиление / ослабление атаки (-12.0 .. +12.0 дБ)
    float sustainGainDb = 0.0f;    // Усиление / ослабление сустейна (-12.0 .. +12.0 дБ)
    float fastWindowMs = 2.5f;     // Временное окно быстрого детектора атаки (0.5 .. 15.0 мс)
    float slowWindowMs = 40.0f;    // Временное окно медленного детектора сустейна (15.0 .. 150.0 мс)
    float outputGainDb = 0.0f;     // Выходная компенсация громкости (-12.0 .. +12.0 дБ)
    bool softClip = true;          // Мягкое аналоговое ограничение выходных всплесков
    bool enabled = true;           // Активность эффекта
};

/**
 * Класс TransientShaper - Студийный шейпер транзиентов
 */
class TransientShaper {
public:
    TransientShaper() noexcept;
    explicit TransientShaper(float sampleRate) noexcept;
    ~TransientShaper() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(float sampleRate) noexcept;

    /**
     * Установка параметров обработки
     */
    void setParams(const TransientShaperParams& params) noexcept;
    const TransientShaperParams& getParams() const noexcept { return params_; }

    /**
     * Сброс огибающих детекторов
     */
    void reset() noexcept;

    /**
     * Потоковая In-Place обработка блока аудиосэмплов (RT-Safe, Zero Malloc)
     *
     * @param samples    Указатель на непрерывный Float32 буфер (Interleaved для стерео)
     * @param numFrames  Количество кадров (сэмплов на канал)
     * @param channels   Количество каналов (1 = моно, 2 = стерео)
     */
    void processBlock(float* samples, size_t numFrames, int channels) noexcept;

    /**
     * Out-of-Place обработка блока с раздельными буферами
     */
    void processBlock(
        const float* input,
        float* output,
        size_t numFrames,
        int channels
    ) noexcept;

    /**
     * Получение текущих значений энергии атаки и сустейна для визуализации в UI
     */
    float getCurrentTransientLevel() const noexcept { return currentTransient_; }
    float getCurrentSustainLevel() const noexcept { return currentSustain_; }

private:
    /**
     * Пересчет коэффициентов интеграторов
     */
    void updateCoefficients() noexcept;

    TransientShaperParams params_;
    float sampleRate_{48000.0f};

    // Линейные коэффициенты усиления
    float attackGainLinear_{1.0f};
    float sustainGainLinear_{1.0f};
    float outputGainLinear_{1.0f};

    // Коэффициенты 1-полюсных фильтров огибающих
    float fastAttackCoeff_{0.0f};
    float fastReleaseCoeff_{0.0f};
    float slowAttackCoeff_{0.0f};
    float slowReleaseCoeff_{0.0f};

    // Состояния огибающих (Левый канал)
    float envFastL_{0.0f};
    float envSlowL_{0.0f};

    // Состояния огибающих (Правый канал)
    float envFastR_{0.0f};
    float envSlowR_{0.0f};

    // Метрики для интерфейса
    float currentTransient_{0.0f};
    float currentSustain_{0.0f};
};

} // namespace DAWCore
