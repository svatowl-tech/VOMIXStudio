/**
 * ============================================================================
 * HeadroomRecovery.cpp - Реализация безопасного преампа и разгона хедрума (C++17)
 * ============================================================================
 * Zero-Alloc, WASM SIMD128 векторизованное сканирование и обработка.
 * ============================================================================
 */

#include "HeadroomRecovery.hpp"
#include <cmath>
#include <algorithm>
#include <cstring>

#if defined(__wasm_simd128__) || defined(__SSE2__)
#include <wasm_simd128.h>
#endif

namespace DAWCore {

HeadroomRecovery::HeadroomRecovery(float sampleRate) noexcept
    : sampleRate_(sampleRate > 8000.0f ? sampleRate : 48000.0f) {
    updateParameters();
    reset();
}

void HeadroomRecovery::setSampleRate(float sampleRate) noexcept {
    if (sampleRate > 8000.0f && std::abs(sampleRate_ - sampleRate) > 0.1f) {
        sampleRate_ = sampleRate;
        updateParameters();
        reset();
    }
}

void HeadroomRecovery::setParams(const HeadroomRecoveryParams& params) noexcept {
    params_.targetPeakDb = std::clamp(params.targetPeakDb, -36.0f, 0.0f);
    params_.maxBoostDb = std::clamp(params.maxBoostDb, 0.0f, 48.0f);
    params_.manualGainDb = std::clamp(params.manualGainDb, -24.0f, 48.0f);
    params_.lookaheadMs = std::clamp(params.lookaheadMs, 0.0f, 10.0f);
    params_.autoHeadroom = params.autoHeadroom;
    params_.mix = std::clamp(params.mix, 0.0f, 1.0f);
    params_.bypass = params.bypass;

    updateParameters();
}

void HeadroomRecovery::setTargetPeakDb(float db) noexcept {
    params_.targetPeakDb = std::clamp(db, -36.0f, 0.0f);
    updateParameters();
}

void HeadroomRecovery::setMaxBoostDb(float db) noexcept {
    params_.maxBoostDb = std::clamp(db, 0.0f, 48.0f);
    updateParameters();
}

void HeadroomRecovery::setManualGainDb(float db) noexcept {
    params_.manualGainDb = std::clamp(db, -24.0f, 48.0f);
    updateParameters();
}

void HeadroomRecovery::setAutoHeadroom(bool enable) noexcept {
    params_.autoHeadroom = enable;
}

void HeadroomRecovery::setLookaheadMs(float ms) noexcept {
    params_.lookaheadMs = std::clamp(ms, 0.0f, 10.0f);
    updateParameters();
}

void HeadroomRecovery::setMix(float mix) noexcept {
    params_.mix = std::clamp(mix, 0.0f, 1.0f);
}

void HeadroomRecovery::setBypass(bool bypass) noexcept {
    params_.bypass = bypass;
}

void HeadroomRecovery::reset() noexcept {
    std::memset(lookaheadRingBufferL_, 0, sizeof(lookaheadRingBufferL_));
    std::memset(lookaheadRingBufferR_, 0, sizeof(lookaheadRingBufferR_));
    ringWritePos_ = 0;

    currentPeakEnvelope_ = 0.001f;
    currentGainLinear_ = 1.0f;
    currentGainDb_ = 0.0f;
    currentPeakDb_ = -60.0f;
    limiterGain_ = 1.0f;

    smoothedBypass_ = params_.bypass ? 1.0f : 0.0f;
    smoothedMix_ = params_.mix;
}

void HeadroomRecovery::updateParameters() noexcept {
    lookaheadSamples_ = std::min(
        static_cast<size_t>(params_.lookaheadMs * 0.001f * sampleRate_),
        MAX_LOOKAHEAD_SAMPLES - 1
    );

    // Временные константы лимитера (Атака 0.5 мс, спад 50 мс)
    const float attackMs = 0.5f;
    const float releaseMs = 50.0f;
    attackCoeff_ = std::exp(-1.0f / (attackMs * 0.001f * sampleRate_));
    releaseCoeff_ = std::exp(-1.0f / (releaseMs * 0.001f * sampleRate_));
}

AudioScanStats HeadroomRecovery::scanBufferSIMD(
    const float* buffer,
    size_t numFrames,
    int channels,
    float targetPeakDb,
    float maxBoostDb
) noexcept {
    AudioScanStats stats;
    if (!buffer || numFrames == 0 || channels <= 0) return stats;

    const size_t totalSamples = numFrames * static_cast<size_t>(channels);
    float maxPeak = 0.0f;
    double sumSquares = 0.0;

    size_t i = 0;

#if defined(__wasm_simd128__)
    v128_t maxVec = wasm_f32x4_splat(0.0f);
    v128_t sumSqVec = wasm_f32x4_splat(0.0f);

    for (; i + 4 <= totalSamples; i += 4) {
        v128_t v = wasm_v128_load(&buffer[i]);
        v128_t absV = wasm_f32x4_abs(v);
        maxVec = wasm_f32x4_max(maxVec, absV);
        sumSqVec = wasm_f32x4_add(sumSqVec, wasm_f32x4_mul(v, v));
    }

    float alignas(16) maxArr[4];
    float alignas(16) sumArr[4];
    wasm_v128_store(maxArr, maxVec);
    wasm_v128_store(sumArr, sumSqVec);

    for (int k = 0; k < 4; ++k) {
        maxPeak = std::max(maxPeak, maxArr[k]);
        sumSquares += sumArr[k];
    }
#endif

    for (; i < totalSamples; ++i) {
        float absVal = std::abs(buffer[i]);
        maxPeak = std::max(maxPeak, absVal);
        sumSquares += static_cast<double>(buffer[i]) * static_cast<double>(buffer[i]);
    }

    stats.peakLinear = maxPeak;
    stats.peakDb = (maxPeak > 1e-6f) ? (20.0f * std::log10(maxPeak)) : -120.0f;

    float rmsLinear = static_cast<float>(std::sqrt(sumSquares / std::max(static_cast<double>(totalSamples), 1.0)));
    stats.rmsLinear = rmsLinear;
    stats.rmsDb = (rmsLinear > 1e-6f) ? (20.0f * std::log10(rmsLinear)) : -120.0f;

    // Расчет безопасного буста:
    // Если запись не является полным нулем (peakDb > -65 dB)
    if (stats.peakDb > -65.0f) {
        float neededBoostDb = targetPeakDb - stats.peakDb;
        float safeBoostDb = std::clamp(neededBoostDb, 0.0f, maxBoostDb);
        stats.calculatedGainDb = safeBoostDb;
        stats.calculatedGainLinear = std::pow(10.0f, safeBoostDb / 20.0f);
    } else {
        // Практически полная тишина/шум — не разгоняем
        stats.calculatedGainDb = 0.0f;
        stats.calculatedGainLinear = 1.0f;
    }

    return stats;
}

AudioScanStats HeadroomRecovery::normalizeBufferInPlace(
    float* buffer,
    size_t numFrames,
    int channels,
    float targetPeakDb,
    float maxBoostDb
) noexcept {
    auto stats = scanBufferSIMD(buffer, numFrames, channels, targetPeakDb, maxBoostDb);
    if (!buffer || numFrames == 0 || stats.calculatedGainLinear <= 1.0001f) {
        return stats;
    }

    const size_t totalSamples = numFrames * static_cast<size_t>(channels);
    const float gain = stats.calculatedGainLinear;
    size_t i = 0;

#if defined(__wasm_simd128__)
    v128_t gainVec = wasm_f32x4_splat(gain);
    for (; i + 4 <= totalSamples; i += 4) {
        v128_t v = wasm_v128_load(&buffer[i]);
        v = wasm_f32x4_mul(v, gainVec);
        wasm_v128_store(&buffer[i], v);
    }
#endif

    for (; i < totalSamples; ++i) {
        buffer[i] *= gain;
    }

    return stats;
}

void HeadroomRecovery::processBlock(float* buffer, size_t numFrames, int channels) noexcept {
    if (!buffer || numFrames == 0) return;

    const float targetBypass = params_.bypass ? 1.0f : 0.0f;
    const float targetMix = params_.mix;
    const float targetPeakLinear = std::pow(10.0f, params_.targetPeakDb / 20.0f);
    const float maxBoostLinear = std::pow(10.0f, params_.maxBoostDb / 20.0f);
    const float manualGainLinear = std::pow(10.0f, params_.manualGainDb / 20.0f);

    const size_t lookahead = lookaheadSamples_;

    if (channels == 1) {
        for (size_t f = 0; f < numFrames; ++f) {
            float in = buffer[f];

            smoothedBypass_ += 0.005f * (targetBypass - smoothedBypass_);
            smoothedMix_ += 0.005f * (targetMix - smoothedMix_);

            // Запись в кольцевой буфер
            lookaheadRingBufferL_[ringWritePos_] = in;
            size_t readPos = (ringWritePos_ + MAX_LOOKAHEAD_SAMPLES - lookahead) % MAX_LOOKAHEAD_SAMPLES;
            float delayedIn = lookaheadRingBufferL_[readPos];
            ringWritePos_ = (ringWritePos_ + 1) % MAX_LOOKAHEAD_SAMPLES;

            // 1. Детекция пика в опережающем окне
            float absIn = std::abs(in);
            if (absIn > currentPeakEnvelope_) {
                currentPeakEnvelope_ = attackCoeff_ * currentPeakEnvelope_ + (1.0f - attackCoeff_) * absIn;
            } else {
                currentPeakEnvelope_ = releaseCoeff_ * currentPeakEnvelope_ + (1.0f - releaseCoeff_) * absIn;
            }

            // 2. Расчет целевого линейного усиления
            float targetGain = manualGainLinear;
            if (params_.autoHeadroom) {
                if (currentPeakEnvelope_ > 1e-4f) {
                    float autoGain = targetPeakLinear / currentPeakEnvelope_;
                    targetGain = std::clamp(autoGain, 1.0f, maxBoostLinear);
                } else {
                    targetGain = 1.0f;
                }
            }

            currentGainLinear_ = 0.999f * currentGainLinear_ + 0.001f * targetGain;
            currentGainDb_ = 20.0f * std::log10(std::max(currentGainLinear_, 1e-4f));
            currentPeakDb_ = 20.0f * std::log10(std::max(currentPeakEnvelope_, 1e-5f));

            // 3. Усиление задержанного сэмпла
            float amplified = delayedIn * currentGainLinear_;

            // 4. True Peak Brickwall Guard
            float absAmp = std::abs(amplified);
            float ceiling = 0.99f;
            if (absAmp > ceiling) {
                float neededAtten = ceiling / absAmp;
                limiterGain_ = std::min(limiterGain_, neededAtten);
            } else {
                limiterGain_ = releaseCoeff_ * limiterGain_ + (1.0f - releaseCoeff_) * 1.0f;
            }
            float limited = amplified * limiterGain_;

            // 5. Dry/Wet & Bypass
            float mixed = delayedIn * (1.0f - smoothedMix_) + limited * smoothedMix_;
            buffer[f] = mixed * (1.0f - smoothedBypass_) + delayedIn * smoothedBypass_;
        }
    } else {
        // Стерео interleaved [L, R, L, R...]
        for (size_t f = 0; f < numFrames; ++f) {
            size_t idxL = f * 2;
            size_t idxR = idxL + 1;

            float inL = buffer[idxL];
            float inR = buffer[idxR];

            smoothedBypass_ += 0.005f * (targetBypass - smoothedBypass_);
            smoothedMix_ += 0.005f * (targetMix - smoothedMix_);

            lookaheadRingBufferL_[ringWritePos_] = inL;
            lookaheadRingBufferR_[ringWritePos_] = inR;
            size_t readPos = (ringWritePos_ + MAX_LOOKAHEAD_SAMPLES - lookahead) % MAX_LOOKAHEAD_SAMPLES;
            float delayedL = lookaheadRingBufferL_[readPos];
            float delayedR = lookaheadRingBufferR_[readPos];
            ringWritePos_ = (ringWritePos_ + 1) % MAX_LOOKAHEAD_SAMPLES;

            float maxAbs = std::max(std::abs(inL), std::abs(inR));
            if (maxAbs > currentPeakEnvelope_) {
                currentPeakEnvelope_ = attackCoeff_ * currentPeakEnvelope_ + (1.0f - attackCoeff_) * maxAbs;
            } else {
                currentPeakEnvelope_ = releaseCoeff_ * currentPeakEnvelope_ + (1.0f - releaseCoeff_) * maxAbs;
            }

            float targetGain = manualGainLinear;
            if (params_.autoHeadroom) {
                if (currentPeakEnvelope_ > 1e-4f) {
                    float autoGain = targetPeakLinear / currentPeakEnvelope_;
                    targetGain = std::clamp(autoGain, 1.0f, maxBoostLinear);
                } else {
                    targetGain = 1.0f;
                }
            }

            currentGainLinear_ = 0.999f * currentGainLinear_ + 0.001f * targetGain;
            currentGainDb_ = 20.0f * std::log10(std::max(currentGainLinear_, 1e-4f));
            currentPeakDb_ = 20.0f * std::log10(std::max(currentPeakEnvelope_, 1e-5f));

            float ampL = delayedL * currentGainLinear_;
            float ampR = delayedR * currentGainLinear_;

            float peakAmp = std::max(std::abs(ampL), std::abs(ampR));
            float ceiling = 0.99f;
            if (peakAmp > ceiling) {
                float neededAtten = ceiling / peakAmp;
                limiterGain_ = std::min(limiterGain_, neededAtten);
            } else {
                limiterGain_ = releaseCoeff_ * limiterGain_ + (1.0f - releaseCoeff_) * 1.0f;
            }

            float limL = ampL * limiterGain_;
            float limR = ampR * limiterGain_;

            float mixedL = delayedL * (1.0f - smoothedMix_) + limL * smoothedMix_;
            float mixedR = delayedR * (1.0f - smoothedMix_) + limR * smoothedMix_;

            buffer[idxL] = mixedL * (1.0f - smoothedBypass_) + delayedL * smoothedBypass_;
            buffer[idxR] = mixedR * (1.0f - smoothedBypass_) + delayedR * smoothedBypass_;
        }
    }
}

void HeadroomRecovery::processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept {
    if (!inputs || !outputs || numFrames == 0) return;

    const float* inL = inputs[0];
    const float* inR = (inputs[1] != nullptr) ? inputs[1] : inputs[0];
    float* outL = outputs[0];
    float* outR = (outputs[1] != nullptr) ? outputs[1] : outputs[0];

    const float targetBypass = params_.bypass ? 1.0f : 0.0f;
    const float targetMix = params_.mix;
    const float targetPeakLinear = std::pow(10.0f, params_.targetPeakDb / 20.0f);
    const float maxBoostLinear = std::pow(10.0f, params_.maxBoostDb / 20.0f);
    const float manualGainLinear = std::pow(10.0f, params_.manualGainDb / 20.0f);

    const size_t lookahead = lookaheadSamples_;

    for (size_t f = 0; f < numFrames; ++f) {
        float sampleL = inL[f];
        float sampleR = inR[f];

        smoothedBypass_ += 0.005f * (targetBypass - smoothedBypass_);
        smoothedMix_ += 0.005f * (targetMix - smoothedMix_);

        lookaheadRingBufferL_[ringWritePos_] = sampleL;
        lookaheadRingBufferR_[ringWritePos_] = sampleR;
        size_t readPos = (ringWritePos_ + MAX_LOOKAHEAD_SAMPLES - lookahead) % MAX_LOOKAHEAD_SAMPLES;
        float delayedL = lookaheadRingBufferL_[readPos];
        float delayedR = lookaheadRingBufferR_[readPos];
        ringWritePos_ = (ringWritePos_ + 1) % MAX_LOOKAHEAD_SAMPLES;

        float maxAbs = std::max(std::abs(sampleL), std::abs(sampleR));
        if (maxAbs > currentPeakEnvelope_) {
            currentPeakEnvelope_ = attackCoeff_ * currentPeakEnvelope_ + (1.0f - attackCoeff_) * maxAbs;
        } else {
            currentPeakEnvelope_ = releaseCoeff_ * currentPeakEnvelope_ + (1.0f - releaseCoeff_) * maxAbs;
        }

        float targetGain = manualGainLinear;
        if (params_.autoHeadroom) {
            if (currentPeakEnvelope_ > 1e-4f) {
                float autoGain = targetPeakLinear / currentPeakEnvelope_;
                targetGain = std::clamp(autoGain, 1.0f, maxBoostLinear);
            } else {
                targetGain = 1.0f;
            }
        }

        currentGainLinear_ = 0.999f * currentGainLinear_ + 0.001f * targetGain;
        currentGainDb_ = 20.0f * std::log10(std::max(currentGainLinear_, 1e-4f));
        currentPeakDb_ = 20.0f * std::log10(std::max(currentPeakEnvelope_, 1e-5f));

        float ampL = delayedL * currentGainLinear_;
        float ampR = delayedR * currentGainLinear_;

        float peakAmp = std::max(std::abs(ampL), std::abs(ampR));
        float ceiling = 0.99f;
        if (peakAmp > ceiling) {
            float neededAtten = ceiling / peakAmp;
            limiterGain_ = std::min(limiterGain_, neededAtten);
        } else {
            limiterGain_ = releaseCoeff_ * limiterGain_ + (1.0f - releaseCoeff_) * 1.0f;
        }

        float limL = ampL * limiterGain_;
        float limR = ampR * limiterGain_;

        float mixedL = delayedL * (1.0f - smoothedMix_) + limL * smoothedMix_;
        float mixedR = delayedR * (1.0f - smoothedMix_) + limR * smoothedMix_;

        outL[f] = mixedL * (1.0f - smoothedBypass_) + delayedL * smoothedBypass_;
        outR[f] = mixedR * (1.0f - smoothedBypass_) + delayedR * smoothedBypass_;
    }
}

} // namespace DAWCore
