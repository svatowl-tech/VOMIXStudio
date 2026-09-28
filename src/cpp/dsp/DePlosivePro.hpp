#pragma once

/**
 * ============================================================================
 * DePlosivePro.hpp - Профессиональный модуль подавления взрывных согласных (C++17)
 * ============================================================================
 * Высокопроизводительный алгоритм устранения задувов капсюля микрофона и низкочастотных
 * воздушных ударов («п», «б», «т», «к») в вокале и дубляже.
 *
 * Архитектура:
 * 1. 2-полосный кроссовер Linkwitz-Riley (LR2/LR4, частота раздела 60 .. 250 Гц, default 120 Гц)
 *    с идеально ровной суммарной АЧХ и ФЧХ.
 * 2. Детектор асимметрии импульса и взрывного нарастания энергии в суб-басе.
 * 3. Быстрый динамический VCA-аттенюатор суб-баса, активирующийся исключительно в момент удара.
 * 4. Абсолютный Zero-Allocation в real-time аудиопотоке и поддержка WebAssembly SIMD128.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <cmath>
#include <algorithm>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры модуля De-Plosive Pro
 */
struct DePlosiveProParams {
    float thresholdDb = -24.0f;          // Порог срабатывания детектора задува (-60.0 .. 0.0 dBFS)
    float frequencyLimit = 120.0f;       // Верхняя граница частоты суб-баса (60.0 .. 250.0 Гц)
    float suppressionDepthDb = -18.0f;   // Максимальная глубина подавления взрывного удара (-40.0 .. 0.0 дБ)
    float recoveryMs = 35.0f;            // Время восстановления VCA-аттенюатора (5.0 .. 200.0 мс)
    float wetDry = 1.0f;                 // Баланс Dry / Wet (0.0 .. 1.0)
    bool bypass = false;                 // Режим Bypass
};

/**
 * Структура Biquad фильтра 2-го порядка для кроссовера
 */
struct DePlosiveBiquad {
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
 * Класс DePlosivePro - C++17 DSP ядро устранения задувов капсюля
 */
class DePlosivePro {
public:
    explicit DePlosivePro(float sampleRate = 48000.0f) noexcept;
    ~DePlosivePro() = default;

    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    void setParams(const DePlosiveProParams& params) noexcept;
    const DePlosiveProParams& getParams() const noexcept { return params_; }

    void setThresholdDb(float db) noexcept;
    void setFrequencyLimit(float hz) noexcept;
    void setSuppressionDepthDb(float db) noexcept;
    void setRecoveryMs(float ms) noexcept;
    void setBypass(bool bypass) noexcept;
    void setWetDry(float mix) noexcept;

    void reset() noexcept;

    float getCurrentGainReductionDb() const noexcept { return currentGainReductionDb_; }
    bool isPlosiveDetected() const noexcept { return plosiveDetected_; }

    /**
     * Потоковая поканальная обработка Float32 стереобуфера (In-Place, Zero-Alloc)
     * @param buffer Указатель на стерео interleaved [L, R, L, R...]
     * @param numFrames Длина блока во фреймах
     * @param channels Количество каналов (1 = моно, 2 = стерео)
     */
    void processBlock(float* buffer, size_t numFrames, int channels = 2) noexcept;

    /**
     * Обработка раздельных стереоканалов (float** in, float** out)
     */
    void processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept;

private:
    void updateCrossoverCoefficients() noexcept;
    void updateTimeConstants() noexcept;

    DePlosiveProParams params_;
    float sampleRate_{48000.0f};

    // 2-полосный кроссовер Linkwitz-Riley (НЧ и ВЧ фильтры Butterworth 2-го порядка каскадно)
    DePlosiveBiquad lpFilter1_{};
    DePlosiveBiquad lpFilter2_{};
    DePlosiveBiquad hpFilter1_{};
    DePlosiveBiquad hpFilter2_{};

    // Детектор энергии и асимметрии импульса
    float envelopeLow_{0.0f};
    float envelopePos_{0.0f};
    float envelopeNeg_{0.0f};
    float attackCoeff_{0.0f};
    float releaseCoeff_{0.0f};
    float asymmetryCoeff_{0.0f};

    // Текущий VCA коэффициент аттенюации
    float currentAttenLinear_{1.0f};
    float currentGainReductionDb_{0.0f};
    bool plosiveDetected_{false};

    // Сглаживание Bypass и Wet/Dry
    float smoothedBypass_{1.0f};
    float smoothedWetDry_{1.0f};
};

} // namespace DAWCore
