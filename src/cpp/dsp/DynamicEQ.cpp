/**
 * ============================================================================
 * DynamicEQ.cpp - Реализация профессионального динамического эквалайзера (C++17)
 * ============================================================================
 * Адаптивное управление АЧХ в реальном времени с сайдчейн-детекцией энергии
 * и интерполяцией биквадратов TDF-II.
 * ============================================================================
 */

#include "DynamicEQ.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

DynamicEQ::DynamicEQ() noexcept {
    // Настройка 4 полос по умолчанию (Low, Low-Mid, High-Mid, High)
    bands_[0] = { 100.0f,  1.2f, 0.0f, -20.0f, 2.5f, 15.0f, 100.0f, 12.0f, true, true };
    bands_[1] = { 350.0f,  1.8f, 0.0f, -20.0f, 3.0f, 12.0f,  80.0f, 12.0f, true, true };
    bands_[2] = { 2500.0f, 2.0f, 0.0f, -18.0f, 3.5f,  8.0f,  60.0f, 12.0f, true, true };
    bands_[3] = { 7000.0f, 2.5f, 0.0f, -16.0f, 4.0f,  4.0f,  40.0f, 12.0f, true, true };

    setSampleRate(48000.0);
}

DynamicEQ::DynamicEQ(double sampleRate) noexcept {
    bands_[0] = { 100.0f,  1.2f, 0.0f, -20.0f, 2.5f, 15.0f, 100.0f, 12.0f, true, true };
    bands_[1] = { 350.0f,  1.8f, 0.0f, -20.0f, 3.0f, 12.0f,  80.0f, 12.0f, true, true };
    bands_[2] = { 2500.0f, 2.0f, 0.0f, -18.0f, 3.5f,  8.0f,  60.0f, 12.0f, true, true };
    bands_[3] = { 7000.0f, 2.5f, 0.0f, -16.0f, 4.0f,  4.0f,  40.0f, 12.0f, true, true };

    setSampleRate(sampleRate);
}

void DynamicEQ::setSampleRate(double sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0) ? sampleRate : 48000.0;

    for (size_t b = 0; b < NUM_BANDS; ++b) {
        updateBandBallistics(b);
        sidechainCoeffs_[b] = calculateSidechainBPFCoeffs(bands_[b].frequency, bands_[b].Q, sampleRate_);
        currentCoeffs_[b] = calculatePeakingCoeffs(bands_[b].frequency, bands_[b].Q, bands_[b].baseGainDb, sampleRate_);
    }

    reset();
}

void DynamicEQ::setBandParams(size_t bandIndex, const DynamicEQBand& params) noexcept {
    if (bandIndex >= NUM_BANDS) return;

    bands_[bandIndex] = params;
    updateBandBallistics(bandIndex);
    sidechainCoeffs_[bandIndex] = calculateSidechainBPFCoeffs(params.frequency, params.Q, sampleRate_);
    currentCoeffs_[bandIndex] = calculatePeakingCoeffs(params.frequency, params.Q, params.baseGainDb, sampleRate_);
}

const DynamicEQBand& DynamicEQ::getBandParams(size_t bandIndex) const noexcept {
    static const DynamicEQBand dummy{};
    if (bandIndex >= NUM_BANDS) return dummy;
    return bands_[bandIndex];
}

float DynamicEQ::getDynamicGainReductionDb(size_t bandIndex) const noexcept {
    if (bandIndex >= NUM_BANDS) return 0.0f;
    return gainReductionDb_[bandIndex];
}

void DynamicEQ::setOutputGainDb(float gainDb) noexcept {
    outputGainDb_ = std::max(-36.0f, std::min(18.0f, gainDb));
    outputGainLinear_ = dbToGain(outputGainDb_);
}

void DynamicEQ::reset() noexcept {
    for (size_t b = 0; b < NUM_BANDS; ++b) {
        sidechainStates_[b].reset();
        audioStates_[b].reset();
        envelopeL_[b] = 0.0f;
        envelopeR_[b] = 0.0f;
        gainReductionDb_[b] = 0.0f;
    }
}

void DynamicEQ::updateBandBallistics(size_t bandIndex) noexcept {
    if (bandIndex >= NUM_BANDS) return;

    const float attSec = std::max(0.0005f, bands_[bandIndex].attackMs * 0.001f);
    const float relSec = std::max(0.005f, bands_[bandIndex].releaseMs * 0.001f);

    attackCoeffs_[bandIndex] = std::exp(-1.0f / (attSec * static_cast<float>(sampleRate_)));
    releaseCoeffs_[bandIndex] = std::exp(-1.0f / (relSec * static_cast<float>(sampleRate_)));
}

DynBiquadCoeffs DynamicEQ::calculateSidechainBPFCoeffs(
    float frequency,
    float Q,
    double sampleRate
) noexcept {
    if (sampleRate <= 8000.0) return DynBiquadCoeffs{};

    const double nyquist = 0.485 * sampleRate;
    const double f0 = std::max(10.0, std::min(nyquist, static_cast<double>(frequency)));
    const double qVal = std::max(0.1, static_cast<double>(Q));

    const double w0 = (2.0 * PI_F * f0) / sampleRate;
    const double cosW = std::cos(w0);
    const double sinW = std::sin(w0);
    const double alpha = sinW / (2.0 * qVal);

    // Bandpass Filter с пиковым усилением 0 дБ в центре полосы (Audio EQ Cookbook)
    const double b0 = alpha;
    const double b1 = 0.0;
    const double b2 = -alpha;
    const double a0 = 1.0 + alpha;
    const double a1 = -2.0 * cosW;
    const double a2 = 1.0 - alpha;

    if (std::fabs(a0) < 1e-12) return DynBiquadCoeffs{};

    const double invA0 = 1.0 / a0;
    DynBiquadCoeffs out;
    out.b0 = static_cast<float>(b0 * invA0);
    out.b1 = static_cast<float>(b1 * invA0);
    out.b2 = static_cast<float>(b2 * invA0);
    out.a1 = static_cast<float>(a1 * invA0);
    out.a2 = static_cast<float>(a2 * invA0);
    return out;
}

DynBiquadCoeffs DynamicEQ::calculatePeakingCoeffs(
    float frequency,
    float Q,
    float gainDb,
    double sampleRate
) noexcept {
    if (std::fabs(gainDb) < 0.005f || sampleRate <= 8000.0) {
        return DynBiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };
    }

    const double nyquist = 0.485 * sampleRate;
    const double f0 = std::max(10.0, std::min(nyquist, static_cast<double>(frequency)));
    const double qVal = std::max(0.1, static_cast<double>(Q));
    const double A = std::pow(10.0, static_cast<double>(gainDb) / 40.0);

    const double w0 = (2.0 * PI_F * f0) / sampleRate;
    const double cosW = std::cos(w0);
    const double sinW = std::sin(w0);
    const double alpha = sinW / (2.0 * qVal);

    const double b0 = 1.0 + alpha * A;
    const double b1 = -2.0 * cosW;
    const double b2 = 1.0 - alpha * A;
    const double a0 = 1.0 + alpha / A;
    const double a1 = -2.0 * cosW;
    const double a2 = 1.0 - alpha / A;

    if (std::fabs(a0) < 1e-12) return DynBiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };

    const double invA0 = 1.0 / a0;
    DynBiquadCoeffs out;
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

void DynamicEQ::processBlock(float* samples, size_t numFrames, int channels) noexcept {
    processBlock(samples, samples, numFrames, channels);
}

void DynamicEQ::processBlock(
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

    // Подблочная обработка (Control-Rate Chunks) по 32 сэмпла для гладкой адаптации
    constexpr size_t CHUNK_SIZE = 32;

    for (size_t b = 0; b < NUM_BANDS; ++b) {
        const auto& band = bands_[b];
        if (!band.enabled) continue;

        const auto& scCoeff = sidechainCoeffs_[b];
        auto& scState = sidechainStates_[b];
        auto& audState = audioStates_[b];
        auto& currCoeff = currentCoeffs_[b];

        const float attCoeff = attackCoeffs_[b];
        const float relCoeff = releaseCoeffs_[b];
        const float threshDb = band.thresholdDb;
        const float ratioVal = std::max(1.0f, band.ratio);
        const float maxDyn = band.maxDynamicGainDb;
        const bool isDown = band.isDownward;

        size_t processedFrames = 0;
        while (processedFrames < numFrames) {
            const size_t chunkSize = std::min(CHUNK_SIZE, numFrames - processedFrames);

            // 1. Сайдчейн-детекция энергии в полосе (Band-Pass Filter)
            float maxBandEnergy = 0.0f;

            if (channels == 1) {
                for (size_t i = 0; i < chunkSize; ++i) {
                    const size_t frameIdx = processedFrames + i;
                    const float x = output[frameIdx];

                    // TDF-II BPF фильтрация
                    const float ySc = scCoeff.b0 * x + scState.s1L;
                    scState.s1L = scCoeff.b1 * x - scCoeff.a1 * ySc + scState.s2L;
                    scState.s2L = scCoeff.b2 * x - scCoeff.a2 * ySc;

                    const float absSc = std::fabs(ySc);
                    if (absSc > envelopeL_[b]) {
                        envelopeL_[b] = attCoeff * envelopeL_[b] + (1.0f - attCoeff) * absSc;
                    } else {
                        envelopeL_[b] = relCoeff * envelopeL_[b] + (1.0f - relCoeff) * absSc;
                    }

                    if (envelopeL_[b] > maxBandEnergy) maxBandEnergy = envelopeL_[b];
                }
            } else {
                for (size_t i = 0; i < chunkSize; ++i) {
                    const size_t frameIdx = processedFrames + i;
                    const size_t sampleIdx = frameIdx * 2;
                    const float xL = output[sampleIdx + 0];
                    const float xR = output[sampleIdx + 1];

                    // Фильтрация сайдчейна L/R
                    const float yScL = scCoeff.b0 * xL + scState.s1L;
                    scState.s1L = scCoeff.b1 * xL - scCoeff.a1 * yScL + scState.s2L;
                    scState.s2L = scCoeff.b2 * xL - scCoeff.a2 * yScL;

                    const float yScR = scCoeff.b0 * xR + scState.s1R;
                    scState.s1R = scCoeff.b1 * xR - scCoeff.a1 * yScR + scState.s2R;
                    scState.s2R = scCoeff.b2 * xR - scCoeff.a2 * yScR;

                    const float maxLinked = std::max(std::fabs(yScL), std::fabs(yScR));
                    if (maxLinked > envelopeL_[b]) {
                        envelopeL_[b] = attCoeff * envelopeL_[b] + (1.0f - attCoeff) * maxLinked;
                    } else {
                        envelopeL_[b] = relCoeff * envelopeL_[b] + (1.0f - relCoeff) * maxLinked;
                    }

                    if (envelopeL_[b] > maxBandEnergy) maxBandEnergy = envelopeL_[b];
                }
            }

            // 2. Расчет динамического смещения усиления (Dynamic Gain Calculation)
            const float envDb = gainToDb(std::max(1e-5f, maxBandEnergy));
            float dynDeltaDb = 0.0f;

            if (envDb > threshDb) {
                const float overDb = envDb - threshDb;
                const float compressionFactor = 1.0f - (1.0f / ratioVal);
                dynDeltaDb = std::min(maxDyn, overDb * compressionFactor);
            }

            float effectiveGainDb = band.baseGainDb;
            if (isDown) {
                effectiveGainDb -= dynDeltaDb; // Downward Compression (подавление резонанса)
                gainReductionDb_[b] = -dynDeltaDb;
            } else {
                effectiveGainDb += dynDeltaDb; // Upward Expansion (акцентирование)
                gainReductionDb_[b] = +dynDeltaDb;
            }

            // 3. Вычисление целевых коэффициентов Peaking фильтра
            const DynBiquadCoeffs targetCoeff = calculatePeakingCoeffs(
                band.frequency,
                band.Q,
                effectiveGainDb,
                sampleRate_
            );

            // 4. Посемпльная фильтрация подблока с линейной интерполяцией коэффициентов
            const float invChunk = 1.0f / static_cast<float>(chunkSize);
            const float db0 = (targetCoeff.b0 - currCoeff.b0) * invChunk;
            const float db1 = (targetCoeff.b1 - currCoeff.b1) * invChunk;
            const float db2 = (targetCoeff.b2 - currCoeff.b2) * invChunk;
            const float da1 = (targetCoeff.a1 - currCoeff.a1) * invChunk;
            const float da2 = (targetCoeff.a2 - currCoeff.a2) * invChunk;

            if (channels == 1) {
                float s1 = audState.s1L;
                float s2 = audState.s2L;

                for (size_t i = 0; i < chunkSize; ++i) {
                    currCoeff.b0 += db0;
                    currCoeff.b1 += db1;
                    currCoeff.b2 += db2;
                    currCoeff.a1 += da1;
                    currCoeff.a2 += da2;

                    const size_t idx = processedFrames + i;
                    const float x = output[idx];
                    const float y = currCoeff.b0 * x + s1;
                    s1 = currCoeff.b1 * x - currCoeff.a1 * y + s2;
                    s2 = currCoeff.b2 * x - currCoeff.a2 * y;
                    output[idx] = y;
                }
                audState.s1L = s1;
                audState.s2L = s2;
            } else {
                float s1L = audState.s1L, s2L = audState.s2L;
                float s1R = audState.s1R, s2R = audState.s2R;

#if USE_WASM_SIMD
                v128_t vS1 = wasm_f32x4_make(s1L, s1R, 0.0f, 0.0f);
                v128_t vS2 = wasm_f32x4_make(s2L, s2R, 0.0f, 0.0f);

                for (size_t i = 0; i < chunkSize; ++i) {
                    currCoeff.b0 += db0;
                    currCoeff.b1 += db1;
                    currCoeff.b2 += db2;
                    currCoeff.a1 += da1;
                    currCoeff.a2 += da2;

                    const size_t idx = (processedFrames + i) * 2;
                    v128_t vX = wasm_f32x4_make(output[idx + 0], output[idx + 1], 0.0f, 0.0f);

                    v128_t vb0 = wasm_f32x4_splat(currCoeff.b0);
                    v128_t vb1 = wasm_f32x4_splat(currCoeff.b1);
                    v128_t vb2 = wasm_f32x4_splat(currCoeff.b2);
                    v128_t va1 = wasm_f32x4_splat(currCoeff.a1);
                    v128_t va2 = wasm_f32x4_splat(currCoeff.a2);

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

                audState.s1L = wasm_f32x4_extract_lane(vS1, 0);
                audState.s1R = wasm_f32x4_extract_lane(vS1, 1);
                audState.s2L = wasm_f32x4_extract_lane(vS2, 0);
                audState.s2R = wasm_f32x4_extract_lane(vS2, 1);
#else
                for (size_t i = 0; i < chunkSize; ++i) {
                    currCoeff.b0 += db0;
                    currCoeff.b1 += db1;
                    currCoeff.b2 += db2;
                    currCoeff.a1 += da1;
                    currCoeff.a2 += da2;

                    const size_t idx = (processedFrames + i) * 2;
                    const float xL = output[idx + 0];
                    const float xR = output[idx + 1];

                    const float yL = currCoeff.b0 * xL + s1L;
                    s1L = currCoeff.b1 * xL - currCoeff.a1 * yL + s2L;
                    s2L = currCoeff.b2 * xL - currCoeff.a2 * yL;

                    const float yR = currCoeff.b0 * xR + s1R;
                    s1R = currCoeff.b1 * xR - currCoeff.a1 * yR + s2R;
                    s2R = currCoeff.b2 * xR - currCoeff.a2 * yR;

                    output[idx + 0] = yL;
                    output[idx + 1] = yR;
                }
                audState.s1L = s1L; audState.s2L = s2L;
                audState.s1R = s1R; audState.s2R = s2R;
#endif
            }

            currCoeff = targetCoeff;
            processedFrames += chunkSize;
        }
    }

    // Применение общего Master Output Gain
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
