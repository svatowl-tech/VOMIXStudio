/**
 * ============================================================================
 * ParametricEQPro.cpp - Реализация 5-полосного параметрического эквалайзера
 * ============================================================================
 * Математическая реализация каскада БИХ-фильтров по Audio EQ Cookbook (RBJ)
 * с топологией Direct Form II Transposed (TDF-II) и защитой от щелчков
 * через межкадровую интерполяцию коэффициентов.
 * ============================================================================
 */

#include "ParametricEQPro.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

ParametricEQPro::ParametricEQPro() noexcept {
    // 1. Полоса 1: Low Shelf (80 Гц)
    bands_[0] = { EQFilterType::LowShelf, 80.0f, 0.0f, 0.7071f, true };
    // 2. Полоса 2: Low-Mid Peaking (250 Гц)
    bands_[1] = { EQFilterType::Peaking, 250.0f, 0.0f, 1.0f, true };
    // 3. Полоса 3: Mid Peaking (1000 Гц)
    bands_[2] = { EQFilterType::Peaking, 1000.0f, 0.0f, 1.0f, true };
    // 4. Полоса 4: High-Mid Peaking (4000 Гц)
    bands_[3] = { EQFilterType::Peaking, 4000.0f, 0.0f, 1.0f, true };
    // 5. Полоса 5: High Shelf (12000 Гц)
    bands_[4] = { EQFilterType::HighShelf, 12000.0f, 0.0f, 0.7071f, true };

    updateCoefficients(sampleRate_);
    for (size_t b = 0; b < NUM_BANDS; ++b) {
        currentCoeffs_[b] = targetCoeffs_[b];
        needsRamping_[b] = false;
        states_[b].reset();
    }
}

ParametricEQPro::ParametricEQPro(double sampleRate) noexcept
    : sampleRate_((sampleRate > 8000.0) ? sampleRate : 48000.0) {
    bands_[0] = { EQFilterType::LowShelf, 80.0f, 0.0f, 0.7071f, true };
    bands_[1] = { EQFilterType::Peaking, 250.0f, 0.0f, 1.0f, true };
    bands_[2] = { EQFilterType::Peaking, 1000.0f, 0.0f, 1.0f, true };
    bands_[3] = { EQFilterType::Peaking, 4000.0f, 0.0f, 1.0f, true };
    bands_[4] = { EQFilterType::HighShelf, 12000.0f, 0.0f, 0.7071f, true };

    updateCoefficients(sampleRate_);
    for (size_t b = 0; b < NUM_BANDS; ++b) {
        currentCoeffs_[b] = targetCoeffs_[b];
        needsRamping_[b] = false;
        states_[b].reset();
    }
}

void ParametricEQPro::setSampleRate(double sampleRate) noexcept {
    if (sampleRate > 8000.0 && std::fabs(sampleRate_ - sampleRate) > 1.0) {
        sampleRate_ = sampleRate;
        updateCoefficients(sampleRate_);
        for (size_t b = 0; b < NUM_BANDS; ++b) {
            currentCoeffs_[b] = targetCoeffs_[b];
            needsRamping_[b] = false;
        }
        reset();
    }
}

void ParametricEQPro::setBandParams(size_t bandIndex, const EQBandParams& params) noexcept {
    if (bandIndex >= NUM_BANDS) return;
    bands_[bandIndex] = params;

    const auto newCoeffs = calculateRBJCoeffs(params, sampleRate_);
    targetCoeffs_[bandIndex] = newCoeffs;
    needsRamping_[bandIndex] = true;
}

const EQBandParams& ParametricEQPro::getBandParams(size_t bandIndex) const noexcept {
    static const EQBandParams dummy{};
    if (bandIndex >= NUM_BANDS) return dummy;
    return bands_[bandIndex];
}

void ParametricEQPro::setOutputGainDb(float gainDb) noexcept {
    outputGainDb_ = gainDb;
    outputGainLinear_ = dbToGain(gainDb);
}

void ParametricEQPro::updateCoefficients(double sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0) ? sampleRate : sampleRate_;
    for (size_t b = 0; b < NUM_BANDS; ++b) {
        targetCoeffs_[b] = calculateRBJCoeffs(bands_[b], sampleRate_);
        needsRamping_[b] = true;
    }
}

void ParametricEQPro::reset() noexcept {
    for (size_t b = 0; b < NUM_BANDS; ++b) {
        states_[b].reset();
    }
}

BiquadCoeffs ParametricEQPro::calculateRBJCoeffs(const EQBandParams& params, double sampleRate) noexcept {
    if (!params.enabled || sampleRate <= 8000.0) {
        // Прозрачный байпас полосы: y[n] = x[n]
        return BiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };
    }

    // Защита от выхода за пределы частоты Найквиста
    const double nyquist = 0.499 * sampleRate;
    const double f0 = std::max(10.0, std::min(nyquist, static_cast<double>(params.frequency)));
    const double Q = std::max(0.05, static_cast<double>(params.Q));
    const double gainDb = static_cast<double>(params.gainDb);

    const double w0 = (2.0 * PI_F * f0) / sampleRate;
    const double cosW = std::cos(w0);
    const double sinW = std::sin(w0);
    const double A = std::pow(10.0, gainDb / 40.0); // sqrt(10^(gainDb/20))
    const double alpha = sinW / (2.0 * Q);

    double b0 = 1.0, b1 = 0.0, b2 = 0.0;
    double a0 = 1.0, a1 = 0.0, a2 = 0.0;

    switch (params.type) {
        case EQFilterType::Peaking: {
            b0 = 1.0 + alpha * A;
            b1 = -2.0 * cosW;
            b2 = 1.0 - alpha * A;
            a0 = 1.0 + alpha / A;
            a1 = -2.0 * cosW;
            a2 = 1.0 - alpha / A;
            break;
        }

        case EQFilterType::LowShelf: {
            const double sqrtA = std::sqrt(std::max(0.0001, A));
            const double twoSqrtAAlpha = 2.0 * sqrtA * alpha;

            b0 = A * ((A + 1.0) - (A - 1.0) * cosW + twoSqrtAAlpha);
            b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cosW);
            b2 = A * ((A + 1.0) - (A - 1.0) * cosW - twoSqrtAAlpha);
            a0 = (A + 1.0) + (A - 1.0) * cosW + twoSqrtAAlpha;
            a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cosW);
            a2 = (A + 1.0) + (A - 1.0) * cosW - twoSqrtAAlpha;
            break;
        }

        case EQFilterType::HighShelf: {
            const double sqrtA = std::sqrt(std::max(0.0001, A));
            const double twoSqrtAAlpha = 2.0 * sqrtA * alpha;

            b0 = A * ((A + 1.0) + (A - 1.0) * cosW + twoSqrtAAlpha);
            b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cosW);
            b2 = A * ((A + 1.0) + (A - 1.0) * cosW - twoSqrtAAlpha);
            a0 = (A + 1.0) - (A - 1.0) * cosW + twoSqrtAAlpha;
            a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cosW);
            a2 = (A + 1.0) - (A - 1.0) * cosW - twoSqrtAAlpha;
            break;
        }

        case EQFilterType::HighPass: {
            b0 = (1.0 + cosW) * 0.5;
            b1 = -(1.0 + cosW);
            b2 = (1.0 + cosW) * 0.5;
            a0 = 1.0 + alpha;
            a1 = -2.0 * cosW;
            a2 = 1.0 - alpha;
            break;
        }

        case EQFilterType::LowPass: {
            b0 = (1.0 - cosW) * 0.5;
            b1 = 1.0 - cosW;
            b2 = (1.0 - cosW) * 0.5;
            a0 = 1.0 + alpha;
            a1 = -2.0 * cosW;
            a2 = 1.0 - alpha;
            break;
        }

        case EQFilterType::Notch: {
            b0 = 1.0;
            b1 = -2.0 * cosW;
            b2 = 1.0;
            a0 = 1.0 + alpha;
            a1 = -2.0 * cosW;
            a2 = 1.0 - alpha;
            break;
        }
    }

    if (std::fabs(a0) < 1e-12) {
        return BiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };
    }

    const double invA0 = 1.0 / a0;
    BiquadCoeffs out;
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

void ParametricEQPro::processBlock(float* samples, size_t numFrames, int channels) noexcept {
    processBlock(samples, samples, numFrames, channels);
}

void ParametricEQPro::processBlock(
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

    // Если вход и выход разные буферы - копируем в output
    if (input != output) {
        std::copy(input, input + (numFrames * static_cast<size_t>(channels)), output);
    }

    // Последовательная фильтрация через 5 каскадов полос (Bands 0..4)
    for (size_t b = 0; b < NUM_BANDS; ++b) {
        if (!bands_[b].enabled) continue;

        auto& st = states_[b];
        auto& curr = currentCoeffs_[b];
        const auto& target = targetCoeffs_[b];
        const bool isRamping = needsRamping_[b];

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
                    // Direct Form II Transposed
                    const float y = b0 * x + s1;
                    s1 = b1 * x - a1 * y + s2;
                    s2 = b2 * x - a2 * y;
                    output[i] = y;
                }
                st.s1L = s1;
                st.s2L = s2;
            } else {
                // Плавная интерполяция коэффициентов для устранения щелчков (Anti-Click)
                const size_t rampFrames = std::min(numFrames, static_cast<size_t>(128));
                const float invRamp = 1.0f / static_cast<float>(rampFrames);

                const float db0 = (target.b0 - curr.b0) * invRamp;
                const float db1 = (target.b1 - curr.b1) * invRamp;
                const float db2 = (target.b2 - curr.b2) * invRamp;
                const float da1 = (target.a1 - curr.a1) * invRamp;
                const float da2 = (target.a2 - curr.a2) * invRamp;

                float s1 = st.s1L, s2 = st.s2L;

                // Участок интерполяции
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

                // Завершение рампы
                curr = target;
                needsRamping_[b] = false;

                // Хвост блока со стационарными коэффициентами
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
            // СТЕРЕО КАНАЛ (INTERLEAVED L/R) С ПОДДЕРЖКОЙ WASM SIMD128
            // ================================================================
            if (!isRamping) {
                const float b0 = curr.b0, b1 = curr.b1, b2 = curr.b2;
                const float a1 = curr.a1, a2 = curr.a2;

                float s1L = st.s1L, s2L = st.s2L;
                float s1R = st.s1R, s2R = st.s2R;

#if USE_WASM_SIMD
                // Векторная обработка пар каналов L/R через регистры v128_t
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
                // Стерео обработка с плавной интерполяцией коэффициентов
                const size_t rampFrames = std::min(numFrames, static_cast<size_t>(128));
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
    if (std::fabs(outputGainLinear_ - 1.0f) > 1e-5f) {
        const size_t totalSamples = numFrames * static_cast<size_t>(channels);
        size_t i = 0;

#if USE_WASM_SIMD
        v128_t vGain = wasm_f32x4_splat(outputGainLinear_);
        const size_t simdEnd = totalSamples - (totalSamples % 4);
        for (; i < simdEnd; i += 4) {
            v128_t vSample = wasm_v128_load(&output[i]);
            v128_t vRes = wasm_f32x4_mul(vSample, vGain);
            wasm_v128_store(&output[i], vRes);
        }
#endif

        for (; i < totalSamples; ++i) {
            output[i] *= outputGainLinear_;
        }
    }
}

} // namespace DAWCore
