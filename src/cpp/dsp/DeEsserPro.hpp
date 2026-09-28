#pragma once

/**
 * ============================================================================
 * DeEsserPro.hpp - Профессиональный частотно-динамический де-эссер (C++17, RT-Safe)
 * ============================================================================
 * Прецизионный студийный де-эссер для ослабления резких сибилянтов («с», «ц», «щ»)
 * в вокальных записях с возможностью выбора между широкополосным (Wideband)
 * и раздельно-полосным (Split-Band) подавлением.
 *
 * Архитектура:
 * 1. Сайдчейн-фильтр Biquad Band-Pass / High-Pass 2-го порядка (4.0 .. 10.0 кГц).
 * 2. Детектор огибающей с логарифмической компрессией и настраиваемым мягким коленом.
 * 3. Режим Listen Mode для прослушивания вырезаемых сибилянтов в наушниках.
 * 4. Защита от щелчков и артефактов (Zero Malloc, WASM SIMD128).
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <cmath>
#include "AudioMath.hpp"

namespace DAWCore {

struct DeEsserProParams {
    float frequency = 6200.0f;    // Центральная частота сибилянтов (3500 .. 11000 Гц)
    float thresholdDb = -20.0f;   // Порог срабатывания (-50.0 .. 0.0 дБ)
    float ratio = 5.0f;           // Степень сжатия сибилянтов (1.5 .. 20.0)
    float maxReductionDb = -14.0f;// Максимальная глубина подавления (-24.0 .. -2.0 дБ)
    float attackMs = 1.0f;        // Скорость атаки (0.2 .. 10.0 мс)
    float releaseMs = 35.0f;      // Скорость восстановления (10.0 .. 150.0 мс)
    bool splitBand = true;        // true = раздельно-полосный (Split), false = широкополосный (Wide)
    bool listenMode = false;      // Режим мониторинга вырезаемых сибилянтов
    bool enabled = true;          // Активность модуля
};

struct DeEsserBiquadCoeffs {
    float b0 = 1.0f;
    float b1 = 0.0f;
    float b2 = 0.0f;
    float a1 = 0.0f;
    float a2 = 0.0f;
};

struct DeEsserBiquadState {
    float s1L = 0.0f;
    float s2L = 0.0f;
    float s1R = 0.0f;
    float s2R = 0.0f;

    inline void reset() noexcept {
        s1L = 0.0f; s2L = 0.0f;
        s1R = 0.0f; s2R = 0.0f;
    }
};

class DeEsserPro {
public:
    explicit DeEsserPro(float sampleRate = 48000.0f) noexcept;
    ~DeEsserPro() = default;

    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    void setParams(const DeEsserProParams& params) noexcept;
    const DeEsserProParams& getParams() const noexcept { return params_; }

    void reset() noexcept;

    float getCurrentGainReductionDb() const noexcept { return currentGainReductionDb_; }

    /**
     * Потоковая In-Place обработка блока аудиосэмплов
     */
    void processBlock(float* buffer, size_t numFrames, int channels) noexcept;

private:
    void updateFilters() noexcept;

    DeEsserProParams params_;
    float sampleRate_{48000.0f};

    DeEsserBiquadCoeffs bpCoeffs_{};
    DeEsserBiquadState bpState_{};

    float attackCoeff_{0.0f};
    float releaseCoeff_{0.0f};
    float detectorEnvelope_{0.0f};

    float currentGainReductionLinear_{1.0f};
    float currentGainReductionDb_{0.0f};
};

} // namespace DAWCore
