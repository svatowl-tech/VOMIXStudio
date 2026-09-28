#pragma once

/**
 * ============================================================================
 * SpectralDeReverb.hpp - Алгоритмический модуль подавления комнатного эха (C++17)
 * ============================================================================
 * Высокоскоростной DSP де-ревербератор нулевой задержки (Zero Latency)
 * на базе 16-полосного банка фильтров и оценки затухания диффузной энергии (EDR).
 *
 * Архитектура:
 * 1. 16-полосный банк фильтров (80 Гц .. 14 кГц) с постоянной добротностью (Constant Q).
 * 2. Energy Decay Estimator (оценка диффузного хвоста реверберации в каждой полосе).
 * 3. Transient/Onset Detector для сохранения резких согласных и атаки диктора.
 * 4. Спектрально-динамическое вычитание хвоста переотражений в реальном времени.
 * 5. Абсолютный Zero-Allocation в real-time потоке и SIMD128 совместимость.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <cmath>
#include <algorithm>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры модуля Spectral De-Reverb
 */
struct SpectralDeReverbParams {
    float reductionDb = -9.0f;       // Глубина подавления реверберации (-18.0 .. 0.0 дБ)
    float decayTimeEstMs = 350.0f;   // Оценка времени реверберации помещения RT60 (100.0 .. 800.0 мс)
    float clarity = 0.70f;           // Сохранение фронта согласных и разборчивости (0.0 .. 1.0)
    float mix = 1.0f;                // Баланс Dry / Wet (0.0 .. 1.0)
    bool bypass = false;             // Режим Bypass
};

/**
 * Biquad-фильтр 2-го порядка для полос банка
 */
struct DeReverbBandFilter {
    float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f;
    float a1 = 0.0f, a2 = 0.0f;
    float z1L = 0.0f, z2L = 0.0f;
    float z1R = 0.0f, z2R = 0.0f;

    inline void reset() noexcept {
        z1L = z2L = z1R = z2R = 0.0f;
    }

    inline float processLeft(float in) noexcept {
        float out = b0 * in + z1L;
        z1L = b1 * in - a1 * out + z2L;
        z2L = b2 * in - a2 * out;
        return out;
    }

    inline float processRight(float in) noexcept {
        float out = b0 * in + z1R;
        z1R = b1 * in - a1 * out + z2R;
        z2R = b2 * in - a2 * out;
        return out;
    }
};

/**
 * Структура полосы банка фильтров с трекером энергии и хвоста реверберации
 */
struct DeReverbBandState {
    DeReverbBandFilter filter;
    float centerFreq = 1000.0f;

    // Детектор энергии
    float shortEnergyL = 0.0f;
    float shortEnergyR = 0.0f;
    float reverbTailL = 0.0f;
    float reverbTailR = 0.0f;

    // Сглаженный коэффициент подавления
    float currentGainL = 1.0f;
    float currentGainR = 1.0f;

    inline void reset() noexcept {
        filter.reset();
        shortEnergyL = shortEnergyR = 0.0f;
        reverbTailL = reverbTailR = 0.0f;
        currentGainL = currentGainR = 1.0f;
    }
};

/**
 * Класс SpectralDeReverb - C++17 DSP ядро устранения эха и комнатного резонанса
 */
class SpectralDeReverb {
public:
    static constexpr size_t NUM_BANDS = 16;

    explicit SpectralDeReverb(float sampleRate = 48000.0f) noexcept;
    ~SpectralDeReverb() = default;

    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    void setParams(const SpectralDeReverbParams& params) noexcept;
    const SpectralDeReverbParams& getParams() const noexcept { return params_; }

    void setReductionDb(float db) noexcept;
    void setDecayTimeEstMs(float ms) noexcept;
    void setClarity(float clarity) noexcept;
    void setMix(float mix) noexcept;
    void setBypass(bool bypass) noexcept;

    void reset() noexcept;

    /**
     * Потоковая поканальная обработка Float32 стереобуфера [L, R, L, R...]
     */
    void processBlock(float* buffer, size_t numFrames, int channels = 2) noexcept;

    /**
     * Обработка раздельных стереоканалов (float** in, float** out)
     */
    void processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept;

private:
    void updateFilterBank() noexcept;
    void updateTimeConstants() noexcept;

    SpectralDeReverbParams params_;
    float sampleRate_{48000.0f};

    DeReverbBandState bands_[NUM_BANDS];

    // Коэффициенты времени
    float attackCoeff_{0.0f};
    float decayCoeff_{0.0f};
    float releaseCoeff_{0.0f};
    float minGainLinear_{0.25f};

    // Сглаживание Bypass & Wet/Dry
    float smoothedBypass_{1.0f};
    float smoothedMix_{1.0f};
    float smoothedReduction_{0.5f};
};

} // namespace DAWCore
