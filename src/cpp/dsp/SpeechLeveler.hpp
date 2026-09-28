#pragma once

/**
 * ============================================================================
 * SpeechLeveler.hpp - Модуль автоматического выравнивания громкости речи (C++17)
 * ============================================================================
 * Двухступенчатый вещательный процессор динамики речи:
 * 
 * 1. Ступень 1 (Slow RMS Auto-Leveller):
 *    - Медленный авто-фейдер (время реакции 200..800 мс, по умолчанию 300 мс).
 *    - Расчет скользящего RMS окна и отклонения от целевого уровня (targetLevelDb = -18 dBFS).
 *    - Заморозка гейна в паузах (Gate Freeze ниже -45 dBFS) для предотвращения шума.
 *    - Симметричные/асимметричные лимиты: maxBoostDb (+12 dB), maxCutDb (-18 dB).
 * 
 * 2. Ступень 2 (Fast Tame Limiter):
 *    - Быстрый прозрачный лимитер пиков и выкриков (Soft Knee, атака 1 мс, релиз 50 мс).
 *    - Срезает внезапные транзиенты и крики без пампинга и искажения гласных.
 * 
 * 3. Zero-Alloc в RT-потоке, поддержка SIMD128, стерео/моно.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <cmath>
#include <algorithm>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры Speech Dynamic Leveler
 */
struct SpeechLevelerParams {
    float targetLevelDb = -18.0f;     // Целевой уровень RMS речи (-36.0 .. -6.0 dBFS)
    float levelingSpeedMs = 300.0f;   // Скорость реакции авто-фейдера (50.0 .. 1000.0 мс)
    float maxBoostDb = 12.0f;         // Максимальное усиление тихой речи (0.0 .. +24.0 dB)
    float maxCutDb = -18.0f;          // Максимальное ослабление громкой речи (-36.0 .. 0.0 dB)
    float silenceGateDb = -45.0f;     // Порог заморозки гейна в паузах (-70.0 .. -20.0 dBFS)
    float peakCeilingDb = -2.0f;      // Потолок быстрого лимитера пиков (-12.0 .. 0.0 dBFS)
    float mix = 1.0f;                 // Dry / Wet Mix (0.0 .. 1.0)
    bool bypass = false;              // Bypass
};

/**
 * Класс SpeechLeveler - C++17 DSP модуль выравнивания речи
 */
class SpeechLeveler {
public:
    explicit SpeechLeveler(float sampleRate = 48000.0f) noexcept;
    ~SpeechLeveler() = default;

    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    void setParams(const SpeechLevelerParams& params) noexcept;
    const SpeechLevelerParams& getParams() const noexcept { return params_; }

    void setTargetLevelDb(float db) noexcept;
    void setLevelingSpeedMs(float ms) noexcept;
    void setMaxBoostDb(float db) noexcept;
    void setMaxCutDb(float db) noexcept;
    void setSilenceGateDb(float db) noexcept;
    void setPeakCeilingDb(float db) noexcept;
    void setMix(float mix) noexcept;
    void setBypass(bool bypass) noexcept;

    void reset() noexcept;

    /**
     * Потоковая real-time обработка Float32 interleaved буфера [L, R, L, R...]
     */
    void processBlock(float* buffer, size_t numFrames, int channels = 2) noexcept;

    /**
     * Обработка раздельных каналов (float** in, float** out)
     */
    void processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept;

    /**
     * Офлайн-обработка моно/стерео буфера
     */
    void processBufferInPlace(float* buffer, size_t numFrames, int channels = 2) noexcept;

    // Метрики состояния
    float getCurrentLevelerGainDb() const noexcept { return currentLevelerGainDb_; }
    float getCurrentLimiterGainDb() const noexcept { return currentLimiterGainDb_; }
    float getCurrentRmsDb() const noexcept { return currentRmsDb_; }
    bool isGateFrozen() const noexcept { return isFrozen_; }

private:
    void updateCoefficients() noexcept;

    SpeechLevelerParams params_;
    float sampleRate_{48000.0f};

    // Ступень 1: RMS детектор и авто-фейдер
    float rmsDetectorL_{0.0001f};
    float rmsDetectorR_{0.0001f};
    float rmsSmoothCoeff_{0.0f};
    float levelerSpeedCoeff_{0.0f};

    float currentLevelerGainLinear_{1.0f};
    float currentLevelerGainDb_{0.0f};
    float currentRmsDb_{-60.0f};
    bool isFrozen_{false};

    // Ступень 2: Fast Tame Limiter
    float limiterEnvelopeL_{0.0f};
    float limiterEnvelopeR_{0.0f};
    float limiterAttackCoeff_{0.0f};
    float limiterReleaseCoeff_{0.0f};
    float currentLimiterGainDb_{0.0f};

    // Плавный Bypass & Mix
    float smoothedBypass_{1.0f};
    float smoothedMix_{1.0f};
};

} // namespace DAWCore
