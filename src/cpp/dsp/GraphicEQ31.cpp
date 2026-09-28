/**
 * ============================================================================
 * GraphicEQ31.cpp - Реализация 31-полосного графического эквалайзера (C++17)
 * ============================================================================
 * Каскад прецизионных биквадратных фильтров по стандарту ISO 266 (1/3 октавы)
 * с топологией Direct Form II Transposed и защитой от щелчков (Anti-Click).
 * ============================================================================
 */

#include "GraphicEQ31.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

// Добротность 1/3-октавного фильтра по стандарту: Q = sqrt(2^(1/3)) / (2^(1/3) - 1) ≈ 4.3184
static constexpr float ISO_Q = 4.3184f;

GraphicEQ31::GraphicEQ31(double sampleRate) noexcept
    : sampleRate_((sampleRate > 8000.0) ? sampleRate : 48000.0) {
    resetAllBands();
}

void GraphicEQ31::setSampleRate(double sampleRate) noexcept {
    if (sampleRate > 8000.0 && std::fabs(sampleRate_ - sampleRate) > 1.0) {
        sampleRate_ = sampleRate;
        for (size_t b = 0; b < NUM_BANDS; ++b) {
            targetCoeffs_[b] = calculateBiquadCoeffs(ISO_FREQUENCIES[b], gainsDb_[b], sampleRate_);
            currentCoeffs_[b] = targetCoeffs_[b];
            needsRamping_[b] = false;
        }
        reset();
    }
}

void GraphicEQ31::setBandGain(int bandIndex, float gainDb) noexcept {
    if (bandIndex < 0 || bandIndex >= static_cast<int>(NUM_BANDS)) return;

    const float clampedGain = std::max(-15.0f, std::min(15.0f, gainDb));
    if (std::fabs(gainsDb_[bandIndex] - clampedGain) < 0.005f) return;

    gainsDb_[bandIndex] = clampedGain;
    targetCoeffs_[bandIndex] = calculateBiquadCoeffs(ISO_FREQUENCIES[bandIndex], clampedGain, sampleRate_);
    needsRamping_[bandIndex] = true;
}

float GraphicEQ31::getBandGain(int bandIndex) const noexcept {
    if (bandIndex < 0 || bandIndex >= static_cast<int>(NUM_BANDS)) return 0.0f;
    return gainsDb_[bandIndex];
}

float GraphicEQ31::getBandFrequency(int bandIndex) const noexcept {
    if (bandIndex < 0 || bandIndex >= static_cast<int>(NUM_BANDS)) return 1000.0f;
    return ISO_FREQUENCIES[bandIndex];
}

void GraphicEQ31::resetAllBands() noexcept {
    for (size_t b = 0; b < NUM_BANDS; ++b) {
        gainsDb_[b] = 0.0f;
        targetCoeffs_[b] = calculateBiquadCoeffs(ISO_FREQUENCIES[b], 0.0f, sampleRate_);
        currentCoeffs_[b] = targetCoeffs_[b];
        needsRamping_[b] = false;
        states_[b].reset();
    }
}

void GraphicEQ31::setMasterGainDb(float gainDb) noexcept {
    masterGainDb_ = std::max(-36.0f, std::min(18.0f, gainDb));
    masterGainLinear_ = dbToGain(masterGainDb_);
}

void GraphicEQ31::reset() noexcept {
    for (size_t b = 0; b < NUM_BANDS; ++b) {
        states_[b].reset();
    }
}

GraphicBiquadCoeffs GraphicEQ31::calculateBiquadCoeffs(
    float frequency,
    float gainDb,
    double sampleRate
) noexcept {
    // Если усиление равно 0 дБ — прозрачный сквозной проход
    if (std::fabs(gainDb) < 0.005f || sampleRate <= 8000.0) {
        return GraphicBiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };
    }

    // Защита от деформации частоты около Найквиста
    const double nyquist = 0.485 * sampleRate;
    const double f0 = std::max(10.0, std::min(nyquist, static_cast<double>(frequency)));
    const double A = std::pow(10.0, static_cast<double>(gainDb) / 40.0); // sqrt(10^(gainDb/20))
    const double w0 = (2.0 * PI_F * f0) / sampleRate;
    const double cosW = std::cos(w0);
    const double sinW = std::sin(w0);
    const double alpha = sinW / (2.0 * static_cast<double>(ISO_Q));

    const double b0 = 1.0 + alpha * A;
    const double b1 = -2.0 * cosW;
    const double b2 = 1.0 - alpha * A;
    const double a0 = 1.0 + alpha / A;
    const double a1 = -2.0 * cosW;
    const double a2 = 1.0 - alpha / A;

    if (std::fabs(a0) < 1e-12) {
        return GraphicBiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };
    }

    const double invA0 = 1.0 / a0;
    GraphicBiquadCoeffs out;
    out.b0 = static_cast<float>(b0 * invA0);
    out.b1 = static_cast<float>(b1 * invA0);
    out.b2 = static_cast<float>(b2 * invA0);
    out.a1 = static_cast<float>(a1 * invA0);
    out.a2 = static_cast<float>(a2 * invA0);

    // Проверка устойчивости полюсов фильтра (|a2| < 1.0)
    if (std::fabs(out.a2) >= 0.9999f) {
        out.a2 = (out.a2 > 0.0f) ? 0.9998f : -0.9998f;
    }

    return out;
}

void GraphicEQ31::processBlock(float* samples, size_t numFrames, int channels) noexcept {
    processBlock(samples, samples, numFrames, channels);
}

void GraphicEQ31::processBlock(
    const float* input,
    float* output,
    size_t numFrames,
    int channels
) noexcept {
    if (!input || !output || numFrames == 0 || channels <= 0) return;

    if (!enabled_) {
        if (input != output) {
            std::copy(input, input + (numFrames * static_cast<size_t>(channels)), output);
        }
        return;
    }

    if (input != output) {
        std::copy(input, input + (numFrames * static_cast<size_t>(channels)), output);
    }

    // Последовательная каскадная фильтрация через 31 полосу
    for (size_t b = 0; b < NUM_BANDS; ++b) {
        const bool isFlat = (std::fabs(gainsDb_[b]) < 0.005f);
        const bool isRamping = needsRamping_[b];

        // Оптимизация: пропуск неактивных плоских полос (Zero CPU Overhead)
        if (isFlat && !isRamping) continue;

        auto& st = states_[b];
        auto& curr = currentCoeffs_[b];
        const auto& target = targetCoeffs_[b];

        if (channels == 1) {
            // ================================================================
            // МОНО КАНАЛ
            // ================================================================
            if (!isRamping) {
                const float b0 = curr.b0, b1 = curr.b1, b2 = curr.b2;
                const float a1 = curr.a1, a2 = curr.a2;
                float s1 = st.s1L, s2 = st.s2L;

                for (size_t i = 0; i < numFrames; ++i) {
                    const float x = output[i];
                    const float y = b0 * x + s1;
                    s1 = b1 * x - a1 * y + s2;
                    s2 = b2 * x - a2 * y;
                    output[i] = y;
                }
                st.s1L = s1;
                st.s2L = s2;
            } else {
                // Плавное сглаживание коэффициентов (Anti-Zipper)
                const size_t rampFrames = std::min(numFrames, static_cast<size_t>(64));
                const float invRamp = 1.0f / static_cast<float>(rampFrames);

                const float db0 = (target.b0 - curr.b0) * invRamp;
                const float db1 = (target.b1 - curr.b1) * invRamp;
                const float db2 = (target.b2 - curr.b2) * invRamp;
                const float da1 = (target.a1 - curr.a1) * invRamp;
                const float da2 = (target.a2 - curr.a2) * invRamp;

                float s1 = st.s1L, s2 = st.s2L;

                for (size_t i = 0; i < rampFrames; ++i) {
                    curr.b0 += db0;
                    curr.b1 += db1;
                    curr.b2 += db2;
                    curr.a1 += da1;
                    curr.a2 += da2;

                    const float x = output[i];
                    const float y = curr.b0 * x + s1;
                    s1 = curr.b1 * x - curr.a1 * y + s2;
                    s2 = curr.b2 * x - curr.a2 * y;
                    output[i] = y;
                }

                curr = target;
                needsRamping_[b] = false;

                const float b0 = curr.b0, b1 = curr.b1, b2 = curr.b2;
                const float a1 = curr.a1, a2 = curr.a2;

                for (size_t i = rampFrames; i < numFrames; ++i) {
                    const float x = output[i];
                    const float y = b0 * x + s1;
                    s1 = b1 * x - a1 * y + s2;
                    s2 = b2 * x - a2 * y;
                    output[i] = y;
                }

                st.s1L = s1;
                st.s2L = s2;
            }
        } else {
            // ================================================================
            // СТЕРЕО КАНАЛ С ПОДДЕРЖКОЙ WASM SIMD128
            // ================================================================
            if (!isRamping) {
                const float b0 = curr.b0, b1 = curr.b1, b2 = curr.b2;
                const float a1 = curr.a1, a2 = curr.a2;

                float s1L = st.s1L, s2L = st.s2L;
                float s1R = st.s1R, s2R = st.s2R;

#if USE_WASM_SIMD
                v128_t vb0 = wasm_f32x4_splat(b0);
                v128_t vb1 = wasm_f32x4_splat(b1);
                v128_t vb2 = wasm_f32x4_splat(b2);
                v128_t va1 = wasm_f32x4_splat(a1);
                v128_t va2 = wasm_f32x4_splat(a2);

                v128_t vS1 = wasm_f32x4_make(s1L, s1R, 0.0f, 0.0f);
                v128_t vS2 = wasm_f32x4_make(s2L, s2R, 0.0f, 0.0f);

                for (size_t i = 0; i < numFrames; ++i) {
                    const size_t idx = i * 2;
                    v128_t vX = wasm_f32x4_make(output[idx + 0], output[idx + 1], 0.0f, 0.0f);

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
                for (size_t i = 0; i < numFrames; ++i) {
                    const size_t idx = i * 2;
                    const float xL = output[idx + 0];
                    const float xR = output[idx + 1];

                    const float yL = b0 * xL + s1L;
                    s1L = b1 * xL - a1 * yL + s2L;
                    s2L = b2 * xL - a2 * yL;

                    const float yR = b0 * xR + s1R;
                    s1R = b1 * xR - a1 * yR + s2R;
                    s2R = b2 * xR - a2 * yR;

                    output[idx + 0] = yL;
                    output[idx + 1] = yR;
                }

                st.s1L = s1L; st.s2L = s2L;
                st.s1R = s1R; st.s2R = s2R;
#endif
            } else {
                // Стерео обработка со сглаживанием коэффициентов
                const size_t rampFrames = std::min(numFrames, static_cast<size_t>(64));
                const float invRamp = 1.0f / static_cast<float>(rampFrames);

                const float db0 = (target.b0 - curr.b0) * invRamp;
                const float db1 = (target.b1 - curr.b1) * invRamp;
                const float db2 = (target.b2 - curr.b2) * invRamp;
                const float da1 = (target.a1 - curr.a1) * invRamp;
                const float da2 = (target.a2 - curr.a2) * invRamp;

                float s1L = st.s1L, s2L = st.s2L;
                float s1R = st.s1R, s2R = st.s2R;

                for (size_t i = 0; i < rampFrames; ++i) {
                    curr.b0 += db0;
                    curr.b1 += db1;
                    curr.b2 += db2;
                    curr.a1 += da1;
                    curr.a2 += da2;

                    const size_t idx = i * 2;
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

                curr = target;
                needsRamping_[b] = false;

                const float b0 = curr.b0, b1 = curr.b1, b2 = curr.b2;
                const float a1 = curr.a1, a2 = curr.a2;

                for (size_t i = rampFrames; i < numFrames; ++i) {
                    const size_t idx = i * 2;
                    const float xL = output[idx + 0];
                    const float xR = output[idx + 1];

                    const float yL = b0 * xL + s1L;
                    s1L = b1 * xL - a1 * yL + s2L;
                    s2L = b2 * xL - a2 * yL;

                    const float yR = b0 * xR + s1R;
                    s1R = b1 * xR - a1 * yR + s2R;
                    s2R = b2 * xR - a2 * yR;

                    output[idx + 0] = yL;
                    output[idx + 1] = yR;
                }

                st.s1L = s1L; st.s2L = s2L;
                st.s1R = s1R; st.s2R = s2R;
            }
        }
    }

    // Применение общего Master Output Gain с SIMD
    if (std::fabs(masterGainLinear_ - 1.0f) > 1e-5f) {
        const size_t totalSamples = numFrames * static_cast<size_t>(channels);
        size_t i = 0;

#if USE_WASM_SIMD
        v128_t vGain = wasm_f32x4_splat(masterGainLinear_);
        const size_t simdEnd = totalSamples - (totalSamples % 4);
        for (; i < simdEnd; i += 4) {
            v128_t vSample = wasm_v128_load(&output[i]);
            v128_t vRes = wasm_f32x4_mul(vSample, vGain);
            wasm_v128_store(&output[i], vRes);
        }
#endif

        for (; i < totalSamples; ++i) {
            output[i] *= masterGainLinear_;
        }
    }
}

} // namespace DAWCore
