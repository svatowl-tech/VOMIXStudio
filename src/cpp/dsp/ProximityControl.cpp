/**
 * ============================================================================
 * ProximityControl.cpp - Реализация компенсатора эффекта близости (C++17)
 * ============================================================================
 * Двухполосный сайдчейн-анализ спектрального баланса НЧ/СЧ и адаптивная
 * динамическая шельфовая фильтрация с аппаратным ускорением WASM SIMD128.
 * ============================================================================
 */

#include "ProximityControl.hpp"
#include <algorithm>
#include <cmath>

namespace DAWCore {

ProximityControl::ProximityControl(float sampleRate) noexcept {
    setSampleRate(sampleRate);
}

void ProximityControl::setSampleRate(float sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;
    updateSidechainFilters();
    reset();
}

void ProximityControl::setParams(const ProximityParams& params) noexcept {
    params_ = params;
    updateSidechainFilters();
}

void ProximityControl::reset() noexcept {
    lowBandState_.reset();
    midBandState_.reset();
    audioShelfState_.reset();

    lowEnergy_ = 0.0f;
    midEnergy_ = 0.0f;
    totalEnergy_ = 0.0f;

    currentShelfGainDb_ = 0.0f;
    targetShelfGainDb_ = 0.0f;
    currentRatioDb_ = -12.0f;

    currentShelfCoeffs_ = ProxBiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };
}

void ProximityControl::updateSidechainFilters() noexcept {
    // 1. Полосовой фильтр 50-180 Гц (центр 95 Гц, Q=0.75) для детекции бубнения
    {
        constexpr double f0 = 95.0;
        constexpr double Q = 0.75;
        const double w0 = (TWO_PI_F * f0) / static_cast<double>(sampleRate_);
        const double cosW = std::cos(w0);
        const double sinW = std::sin(w0);
        const double alpha = sinW / (2.0 * Q);

        const double b0 = alpha;
        const double b1 = 0.0;
        const double b2 = -alpha;
        const double a0 = 1.0 + alpha;
        const double a1 = -2.0 * cosW;
        const double a2 = 1.0 - alpha;

        const double invA0 = 1.0 / a0;
        lowBandCoeffs_.b0 = static_cast<float>(b0 * invA0);
        lowBandCoeffs_.b1 = static_cast<float>(b1 * invA0);
        lowBandCoeffs_.b2 = static_cast<float>(b2 * invA0);
        lowBandCoeffs_.a1 = static_cast<float>(a1 * invA0);
        lowBandCoeffs_.a2 = static_cast<float>(a2 * invA0);
    }

    // 2. Полосовой фильтр 300-3000 Гц (центр 950 Гц, Q=0.35) для речевого диапазона
    {
        constexpr double f0 = 950.0;
        constexpr double Q = 0.35;
        const double w0 = (TWO_PI_F * f0) / static_cast<double>(sampleRate_);
        const double cosW = std::cos(w0);
        const double sinW = std::sin(w0);
        const double alpha = sinW / (2.0 * Q);

        const double b0 = alpha;
        const double b1 = 0.0;
        const double b2 = -alpha;
        const double a0 = 1.0 + alpha;
        const double a1 = -2.0 * cosW;
        const double a2 = 1.0 - alpha;

        const double invA0 = 1.0 / a0;
        midBandCoeffs_.b0 = static_cast<float>(b0 * invA0);
        midBandCoeffs_.b1 = static_cast<float>(b1 * invA0);
        midBandCoeffs_.b2 = static_cast<float>(b2 * invA0);
        midBandCoeffs_.a1 = static_cast<float>(a1 * invA0);
        midBandCoeffs_.a2 = static_cast<float>(a2 * invA0);
    }

    // 3. Интеграторы энергии (~15 мс)
    energySmoothCoeff_ = std::exp(-1.0f / (0.015f * sampleRate_));

    // 4. Баллистические константы
    const float attSec = std::max(0.005f, params_.responseMs * 0.001f);
    const float relSec = std::max(0.020f, params_.releaseMs * 0.001f);

    attackCoeff_ = 1.0f - std::exp(-1.0f / (attSec * (sampleRate_ / 32.0f)));
    releaseCoeff_ = 1.0f - std::exp(-1.0f / (relSec * (sampleRate_ / 32.0f)));
}

ProxBiquadCoeffs ProximityControl::calculateLowShelfCoeffs(
    float freq,
    float gainDb,
    float sampleRate
) noexcept {
    if (std::fabs(gainDb) < 0.05f || sampleRate <= 8000.0f) {
        return ProxBiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };
    }

    const double nyquist = 0.485 * sampleRate;
    const double f0 = std::max(20.0, std::min(nyquist, static_cast<double>(freq)));
    const double A = std::pow(10.0, static_cast<double>(gainDb) / 40.0);
    const double w0 = (TWO_PI_F * f0) / static_cast<double>(sampleRate);
    const double cosW = std::cos(w0);
    const double sinW = std::sin(w0);

    // Q = 0.7071 для максимально плоской полосы пропускания (Butterworth Low-Shelf)
    const double alpha = sinW / (2.0 * 0.70710678);
    const double twoSqrtA_alpha = 2.0 * std::sqrt(A) * alpha;

    const double b0 = A * ((A + 1.0) - (A - 1.0) * cosW + twoSqrtA_alpha);
    const double b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cosW);
    const double b2 = A * ((A + 1.0) - (A - 1.0) * cosW - twoSqrtA_alpha);
    const double a0 = (A + 1.0) + (A - 1.0) * cosW + twoSqrtA_alpha;
    const double a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cosW);
    const double a2 = (A + 1.0) + (A - 1.0) * cosW - twoSqrtA_alpha;

    if (std::fabs(a0) < 1e-12) return ProxBiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };

    const double invA0 = 1.0 / a0;
    ProxBiquadCoeffs out;
    out.b0 = static_cast<float>(b0 * invA0);
    out.b1 = static_cast<float>(b1 * invA0);
    out.b2 = static_cast<float>(b2 * invA0);
    out.a1 = static_cast<float>(a1 * invA0);
    out.a2 = static_cast<float>(a2 * invA0);

    if (std::fabs(out.a2) >= 0.9999f) {
        out.a2 = (out.a2 > 0.0f) ? 0.9998f : -0.9998f;
    }
    return out;
}

void ProximityControl::processBlock(float* samples, size_t numFrames, int channels) noexcept {
    processBlock(samples, samples, numFrames, channels);
}

void ProximityControl::processBlock(
    const float* input,
    float* output,
    size_t numFrames,
    int channels
) noexcept {
    if (!input || !output || numFrames == 0 || channels <= 0) return;

    if (!params_.enabled) {
        if (input != output) {
            std::copy(input, input + (numFrames * static_cast<size_t>(channels)), output);
        }
        return;
    }

    if (input != output) {
        std::copy(input, input + (numFrames * static_cast<size_t>(channels)), output);
    }

    constexpr size_t SUB_CHUNK = 32;
    const bool isStereo = (channels > 1);

    const float low_b0 = lowBandCoeffs_.b0, low_b1 = lowBandCoeffs_.b1, low_b2 = lowBandCoeffs_.b2;
    const float low_a1 = lowBandCoeffs_.a1, low_a2 = lowBandCoeffs_.a2;

    const float mid_b0 = midBandCoeffs_.b0, mid_b1 = midBandCoeffs_.b1, mid_b2 = midBandCoeffs_.b2;
    const float mid_a1 = midBandCoeffs_.a1, mid_a2 = midBandCoeffs_.a2;

    const float beta = energySmoothCoeff_;
    const float maxReduction = std::min(-2.0f, params_.maxReductionDb);
    const float threshold = params_.thresholdDb;
    const float sens = std::max(0.1f, params_.sensitivity);

    size_t processed = 0;
    while (processed < numFrames) {
        const size_t chunk = std::min(SUB_CHUNK, numFrames - processed);

        // 1. Сайдчейн-анализ энергии в полосах за текущий подблок
        for (size_t i = 0; i < chunk; ++i) {
            const size_t fIdx = processed + i;
            float monoX = 0.0f;

            if (isStereo) {
                monoX = (output[fIdx * 2 + 0] + output[fIdx * 2 + 1]) * 0.5f;
            } else {
                monoX = output[fIdx];
            }

            // Фильтрация полосы бубнения (50-180 Гц)
            const float yLow = low_b0 * monoX + lowBandState_.s1L;
            lowBandState_.s1L = low_b1 * monoX - low_a1 * yLow + lowBandState_.s2L;
            lowBandState_.s2L = low_b2 * monoX - low_a2 * yLow;

            // Фильтрация опорной полосы речи (300-3000 Гц)
            const float yMid = mid_b0 * monoX + midBandState_.s1L;
            midBandState_.s1L = mid_b1 * monoX - mid_a1 * yMid + midBandState_.s2L;
            midBandState_.s2L = mid_b2 * monoX - mid_a2 * yMid;

            // Интегрирование энергий
            lowEnergy_ = beta * lowEnergy_ + (1.0f - beta) * (yLow * yLow);
            midEnergy_ = beta * midEnergy_ + (1.0f - beta) * (yMid * yMid);
            totalEnergy_ = beta * totalEnergy_ + (1.0f - beta) * (monoX * monoX);
        }

        // 2. Расчет спектрального перекоса (Proximity Ratio)
        // Проверяем, что в дорожке присутствует активный сигнал речи (> -65 дБ)
        if (totalEnergy_ > 1e-7f && midEnergy_ > 1e-8f) {
            const float ratio = lowEnergy_ / (midEnergy_ + 1e-9f);
            currentRatioDb_ = 10.0f * std::log10(std::max(1e-4f, ratio));

            if (currentRatioDb_ > threshold) {
                // Превышение порога бубнения: чем ближе акцент, тем сильнее ослабление
                const float excessDb = currentRatioDb_ - threshold;
                targetShelfGainDb_ = std::max(maxReduction, -excessDb * sens);
            } else {
                targetShelfGainDb_ = 0.0f;
            }
        } else {
            // В тишине или паузах возвращаем шельф в нейтральное положение (0 дБ)
            targetShelfGainDb_ = 0.0f;
        }

        // Баллистическое сглаживание коэффициента усиления шельфа
        if (targetShelfGainDb_ < currentShelfGainDb_) {
            currentShelfGainDb_ += (targetShelfGainDb_ - currentShelfGainDb_) * attackCoeff_;
        } else {
            currentShelfGainDb_ += (targetShelfGainDb_ - currentShelfGainDb_) * releaseCoeff_;
        }

        // 3. Вычисление целевых коэффициентов Low-Shelf фильтра
        const ProxBiquadCoeffs targetCoeffs = calculateLowShelfCoeffs(
            params_.cutoffFrequency,
            currentShelfGainDb_,
            sampleRate_
        );

        // 4. Посемпльная интерполяция коэффициентов (Anti-Click) и фильтрация TDF-II
        const float invChunk = 1.0f / static_cast<float>(chunk);
        const float db0 = (targetCoeffs.b0 - currentShelfCoeffs_.b0) * invChunk;
        const float db1 = (targetCoeffs.b1 - currentShelfCoeffs_.b1) * invChunk;
        const float db2 = (targetCoeffs.b2 - currentShelfCoeffs_.b2) * invChunk;
        const float da1 = (targetCoeffs.a1 - currentShelfCoeffs_.a1) * invChunk;
        const float da2 = (targetCoeffs.a2 - currentShelfCoeffs_.a2) * invChunk;

        auto& curr = currentShelfCoeffs_;
        auto& st = audioShelfState_;

        if (!isStereo) {
            float s1 = st.s1L;
            float s2 = st.s2L;

            for (size_t i = 0; i < chunk; ++i) {
                curr.b0 += db0; curr.b1 += db1; curr.b2 += db2;
                curr.a1 += da1; curr.a2 += da2;

                const size_t idx = processed + i;
                const float x = output[idx];
                const float y = curr.b0 * x + s1;
                s1 = curr.b1 * x - curr.a1 * y + s2;
                s2 = curr.b2 * x - curr.a2 * y;
                output[idx] = y;
            }
            st.s1L = s1;
            st.s2L = s2;
        } else {
            float s1L = st.s1L, s2L = st.s2L;
            float s1R = st.s1R, s2R = st.s2R;

#if USE_WASM_SIMD
            v128_t vS1 = wasm_f32x4_make(s1L, s1R, 0.0f, 0.0f);
            v128_t vS2 = wasm_f32x4_make(s2L, s2R, 0.0f, 0.0f);

            for (size_t i = 0; i < chunk; ++i) {
                curr.b0 += db0; curr.b1 += db1; curr.b2 += db2;
                curr.a1 += da1; curr.a2 += da2;

                const size_t idx = (processed + i) * 2;
                v128_t vX = wasm_f32x4_make(output[idx + 0], output[idx + 1], 0.0f, 0.0f);

                v128_t vb0 = wasm_f32x4_splat(curr.b0);
                v128_t vb1 = wasm_f32x4_splat(curr.b1);
                v128_t vb2 = wasm_f32x4_splat(curr.b2);
                v128_t va1 = wasm_f32x4_splat(curr.a1);
                v128_t va2 = wasm_f32x4_splat(curr.a2);

                // y = b0 * x + s1
                v128_t vY = wasm_f32x4_add(wasm_f32x4_mul(vb0, vX), vS1);

                // s1 = b1 * x - a1 * y + s2
                v128_t vB1X = wasm_f32x4_mul(vb1, vX);
                v128_t vA1Y = wasm_f32x4_mul(va1, vY);
                vS1 = wasm_f32x4_add(wasm_f32x4_sub(vB1X, vA1Y), vS2);

                // s2 = b2 * x - a2 * y
                v128_t vB2X = wasm_f32x4_mul(vb2, vX);
                v128_t vA2Y = wasm_f32x4_mul(va2, vY);
                vS2 = wasm_f32x4_sub(vB2X, vA2Y);

                output[idx + 0] = wasm_f32x4_extract_lane(vY, 0);
                output[idx + 1] = wasm_f32x4_extract_lane(vY, 1);
            }

            st.s1L = wasm_f32x4_extract_lane(vS1, 0);
            st.s1R = wasm_f32x4_extract_lane(vS1, 1);
            st.s2L = wasm_f32x4_extract_lane(vS2, 0);
            st.s2R = wasm_f32x4_extract_lane(vS2, 1);
#else
            for (size_t i = 0; i < chunk; ++i) {
                curr.b0 += db0; curr.b1 += db1; curr.b2 += db2;
                curr.a1 += da1; curr.a2 += da2;

                const size_t idx = (processed + i) * 2;
                const float xL = output[idx + 0];
                const float xR = output[idx + 1];

                const float yL = curr.b0 * xL + s1L;
                s1L = curr.b1 * xL - curr.a1 * yL + s2L;
                s2L = curr.b2 * xL - curr.a2 * yL;

                const float yR = curr.b0 * xR + s1R;
                s1R = curr.b1 * xR - curr.a1 * yR + s2R;
                s2R = curr.b2 * xR - curr.a2 * yR;

                output[idx + 0] = yL;
                output[idx + 1] = yR;
            }
            st.s1L = s1L; st.s2L = s2L;
            st.s1R = s1R; st.s2R = s2R;
#endif
        }

        curr = targetCoeffs;
        processed += chunk;
    }
}

} // namespace DAWCore
