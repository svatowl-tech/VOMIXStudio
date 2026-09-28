#pragma once

/**
 * ============================================================================
 * HeadroomRecovery.hpp - Модуль безопасного разгона тихих записей (C++17)
 * ============================================================================
 * Интеллектуальный преамп и компенсатор хедрума для тихих дублей дикторов:
 * 1. Векторизованное SIMD-сканирование True Peak и RMS за один проход.
 * 2. Расчет линейного коэффициента усиления до целевого пика (targetPeakDb = -6.0 dBFS).
 * 3. Ограничение максимального буста (maxBoostDb = +36 dB) для защиты от шума.
 * 4. Реалтайм-режим с Lookahead (3 мс) и защитой от межсэмпловых клипов (True Peak Guard).
 * 5. Zero-Allocation в RT-потоке, поддержка пакетного офлайн-режима.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <cmath>
#include <algorithm>
#include <vector>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры модуля Headroom Recovery & Gain
 */
struct HeadroomRecoveryParams {
    float targetPeakDb = -6.0f;       // Целевой уровень пика (-24.0 .. 0.0 dBFS)
    float maxBoostDb = 36.0f;         // Максимальное усиление (+6.0 .. +48.0 dB)
    float manualGainDb = 0.0f;        // Ручное усиление (-24.0 .. +48.0 dB)
    float lookaheadMs = 3.0f;         // Время упреждения Lookahead (0.0 .. 10.0 мс)
    bool autoHeadroom = true;         // Автоматический расчет гейна по анализу входа
    float mix = 1.0f;                 // Dry / Wet Mix (0.0 .. 1.0)
    bool bypass = false;              // Bypass
};

/**
 * Результаты сканирования аудиопотока
 */
struct AudioScanStats {
    float peakLinear = 0.0f;
    float peakDb = -120.0f;
    float rmsLinear = 0.0f;
    float rmsDb = -120.0f;
    float calculatedGainLinear = 1.0f;
    float calculatedGainDb = 0.0f;
};

/**
 * Класс HeadroomRecovery - C++17 DSP модуль восстановления запаса громкости
 */
class HeadroomRecovery {
public:
    static constexpr size_t MAX_LOOKAHEAD_SAMPLES = 1024;

    explicit HeadroomRecovery(float sampleRate = 48000.0f) noexcept;
    ~HeadroomRecovery() = default;

    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    void setParams(const HeadroomRecoveryParams& params) noexcept;
    const HeadroomRecoveryParams& getParams() const noexcept { return params_; }

    void setTargetPeakDb(float db) noexcept;
    void setMaxBoostDb(float db) noexcept;
    void setManualGainDb(float db) noexcept;
    void setAutoHeadroom(bool enable) noexcept;
    void setLookaheadMs(float ms) noexcept;
    void setMix(float mix) noexcept;
    void setBypass(bool bypass) noexcept;

    void reset() noexcept;

    /**
     * Статическое SIMD-сканирование буфера за один проход
     */
    static AudioScanStats scanBufferSIMD(
        const float* buffer,
        size_t numFrames,
        int channels,
        float targetPeakDb = -6.0f,
        float maxBoostDb = 36.0f
    ) noexcept;

    /**
     * Пакетная безопасная нормализация всего буфера с защитой от разгона пустого шума
     */
    static AudioScanStats normalizeBufferInPlace(
        float* buffer,
        size_t numFrames,
        int channels,
        float targetPeakDb = -6.0f,
        float maxBoostDb = 36.0f
    ) noexcept;

    /**
     * Потоковая real-time обработка Float32 interleaved стереобуфера [L, R, L, R...]
     */
    void processBlock(float* buffer, size_t numFrames, int channels = 2) noexcept;

    /**
     * Обработка раздельных стереоканалов (float** in, float** out)
     */
    void processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept;

    float getCurrentAppliedGainDb() const noexcept { return currentGainDb_; }
    float getCurrentPeakDb() const noexcept { return currentPeakDb_; }

private:
    void updateParameters() noexcept;

    HeadroomRecoveryParams params_;
    float sampleRate_{48000.0f};

    // Кольцевой буфер Lookahead
    float lookaheadRingBufferL_[MAX_LOOKAHEAD_SAMPLES]{0.0f};
    float lookaheadRingBufferR_[MAX_LOOKAHEAD_SAMPLES]{0.0f};
    size_t ringWritePos_{0};
    size_t lookaheadSamples_{144}; // ~3 ms при 48 кГц

    // Детектор пиков и плавающий расчет усиления
    float currentPeakEnvelope_{0.001f};
    float currentGainLinear_{1.0f};
    float currentGainDb_{0.0f};
    float currentPeakDb_{-60.0f};

    // True Peak Brickwall сглаживатель
    float limiterGain_{1.0f};
    float attackCoeff_{0.0f};
    float releaseCoeff_{0.0f};

    // Сглаживание Bypass & Wet/Dry
    float smoothedBypass_{1.0f};
    float smoothedMix_{1.0f};
};

} // namespace DAWCore
