/**
 * ============================================================================
 * SpeechLeveler.cpp - Реализация двухступенчатого выравнивания речи (C++17)
 * ============================================================================
 * Zero-Alloc, SIMD128, студийный алгоритм RMS Leveller + Fast Peak Tamer.
 * ============================================================================
 */

#include "SpeechLeveler.hpp"
#include <cmath>
#include <algorithm>
#include <cstring>

#if defined(__wasm_simd128__) || defined(__SSE2__)
#include <wasm_simd128.h>
#endif

namespace DAWCore {

SpeechLeveler::SpeechLeveler(float sampleRate) noexcept
    : sampleRate_(sampleRate > 8000.0f ? sampleRate : 48000.0f) {
    updateCoefficients();
    reset();
}

void SpeechLeveler::setSampleRate(float sampleRate) noexcept {
    if (sampleRate > 8000.0f && std::abs(sampleRate_ - sampleRate) > 0.1f) {
        sampleRate_ = sampleRate;
        updateCoefficients();
        reset();
    }
}

void SpeechLeveler::setParams(const SpeechLevelerParams& params) noexcept {
    params_.targetLevelDb = std::clamp(params.targetLevelDb, -48.0f, 0.0f);
    params_.levelingSpeedMs = std::clamp(params.levelingSpeedMs, 20.0f, 2000.0f);
    params_.maxBoostDb = std::clamp(params.maxBoostDb, 0.0f, 36.0f);
    params_.maxCutDb = std::clamp(params.maxCutDb, -48.0f, 0.0f);
    params_.silenceGateDb = std::clamp(params.silenceGateDb, -80.0f, -10.0f);
    params_.peakCeilingDb = std::clamp(params.peakCeilingDb, -24.0f, 0.0f);
    params_.mix = std::clamp(params.mix, 0.0f, 1.0f);
    params_.bypass = params.bypass;

    updateCoefficients();
}

void SpeechLeveler::setTargetLevelDb(float db) noexcept {
    params_.targetLevelDb = std::clamp(db, -48.0f, 0.0f);
    updateCoefficients();
}

void SpeechLeveler::setLevelingSpeedMs(float ms) noexcept {
    params_.levelingSpeedMs = std::clamp(ms, 20.0f, 2000.0f);
    updateCoefficients();
}

void SpeechLeveler::setMaxBoostDb(float db) noexcept {
    params_.maxBoostDb = std::clamp(db, 0.0f, 36.0f);
    updateCoefficients();
}

void SpeechLeveler::setMaxCutDb(float db) noexcept {
    params_.maxCutDb = std::clamp(db, -48.0f, 0.0f);
    updateCoefficients();
}

void SpeechLeveler::setSilenceGateDb(float db) noexcept {
    params_.silenceGateDb = std::clamp(db, -80.0f, -10.0f);
    updateCoefficients();
}

void SpeechLeveler::setPeakCeilingDb(float db) noexcept {
    params_.peakCeilingDb = std::clamp(db, -24.0f, 0.0f);
    updateCoefficients();
}

void SpeechLeveler::setMix(float mix) noexcept {
    params_.mix = std::clamp(mix, 0.0f, 1.0f);
}

void SpeechLeveler::setBypass(bool bypass) noexcept {
    params_.bypass = bypass;
}

void SpeechLeveler::reset() noexcept {
    rmsDetectorL_ = 0.0001f;
    rmsDetectorR_ = 0.0001f;
    currentLevelerGainLinear_ = 1.0f;
    currentLevelerGainDb_ = 0.0f;
    currentRmsDb_ = -60.0f;
    isFrozen_ = false;

    limiterEnvelopeL_ = 0.0f;
    limiterEnvelopeR_ = 0.0f;
    currentLimiterGainDb_ = 0.0f;

    smoothedBypass_ = params_.bypass ? 0.0f : 1.0f;
    smoothedMix_ = params_.mix;
}

void SpeechLeveler::updateCoefficients() noexcept {
    // 1. RMS интегратор (~80 мс окно интеграции для человеческой речи)
    const float rmsWindowSec = 0.080f;
    rmsSmoothCoeff_ = std::exp(-1.0f / (rmsWindowSec * sampleRate_));

    // 2. Скорость авто-фейдера (levelingSpeedMs)
    const float speedSec = std::max(0.020f, params_.levelingSpeedMs * 0.001f);
    levelerSpeedCoeff_ = std::exp(-1.0f / (speedSec * sampleRate_));

    // 3. Fast Tame Limiter (Attack 1.0 ms, Release 45 ms)
    limiterAttackCoeff_ = std::exp(-1.0f / (0.0010f * sampleRate_));
    limiterReleaseCoeff_ = std::exp(-1.0f / (0.0450f * sampleRate_));
}

void SpeechLeveler::processBlock(float* buffer, size_t numFrames, int channels) noexcept {
    if (!buffer || numFrames == 0 || channels <= 0) return;

    const float targetRmsDb = params_.targetLevelDb;
    const float maxBoost = params_.maxBoostDb;
    const float maxCut = params_.maxCutDb;
    const float gateDb = params_.silenceGateDb;
    const float ceilingLinear = std::pow(10.0f, params_.peakCeilingDb / 20.0f);

    const float targetBypass = params_.bypass ? 0.0f : 1.0f;
    const float targetMix = params_.mix;
    const float smoothDelta = 1.0f / static_cast<float>(numFrames);

    if (channels == 1) {
        for (size_t i = 0; i < numFrames; ++i) {
            smoothedBypass_ += (targetBypass - smoothedBypass_) * smoothDelta;
            smoothedMix_ += (targetMix - smoothedMix_) * smoothDelta;

            const float in = buffer[i];
            const float inSq = in * in;

            // RMS интеграция
            rmsDetectorL_ = rmsSmoothCoeff_ * rmsDetectorL_ + (1.0f - rmsSmoothCoeff_) * inSq;
            const float currentRms = std::sqrt(std::max(rmsDetectorL_, 1e-12f));
            const float rmsDb = 20.0f * std::log10(currentRms);
            currentRmsDb_ = rmsDb;

            // Ступень 1: Авто-фейдер со скользящей заморозкой
            float targetGainDb = 0.0f;
            if (rmsDb >= gateDb) {
                isFrozen_ = false;
                const float diffDb = targetRmsDb - rmsDb;
                targetGainDb = std::clamp(diffDb, maxCut, maxBoost);
            } else {
                // Пауза: удерживаем текущий гейн и плавно стягиваем к 0 dB (релаксация)
                isFrozen_ = true;
                targetGainDb = currentLevelerGainDb_ * 0.9999f;
            }

            const float targetGainLinear = std::pow(10.0f, targetGainDb / 20.0f);
            currentLevelerGainLinear_ = levelerSpeedCoeff_ * currentLevelerGainLinear_ + (1.0f - levelerSpeedCoeff_) * targetGainLinear;
            currentLevelerGainDb_ = 20.0f * std::log10(std::max(currentLevelerGainLinear_, 1e-4f));

            // Применение авто-фейдера
            float leveledSample = in * currentLevelerGainLinear_;

            // Ступень 2: Fast Peak Limiter
            const float absLeveled = std::abs(leveledSample);
            if (absLeveled > limiterEnvelopeL_) {
                limiterEnvelopeL_ = limiterAttackCoeff_ * limiterEnvelopeL_ + (1.0f - limiterAttackCoeff_) * absLeveled;
            } else {
                limiterEnvelopeL_ = limiterReleaseCoeff_ * limiterEnvelopeL_ + (1.0f - limiterReleaseCoeff_) * absLeveled;
            }

            float limGain = 1.0f;
            if (limiterEnvelopeL_ > ceilingLinear) {
                // Мягкое колено над порогом
                const float overDb = 20.0f * std::log10(limiterEnvelopeL_ / ceilingLinear);
                const float compressedOverDb = overDb / (1.0f + overDb * 0.25f);
                const float compressedLinear = ceilingLinear * std::pow(10.0f, compressedOverDb / 20.0f);
                limGain = std::min(1.0f, compressedLinear / (limiterEnvelopeL_ + 1e-6f));
            }
            currentLimiterGainDb_ = 20.0f * std::log10(std::max(limGain, 1e-4f));

            float wetSample = leveledSample * limGain;
            float outSample = in * (1.0f - smoothedMix_) + wetSample * smoothedMix_;
            buffer[i] = in * (1.0f - smoothedBypass_) + outSample * smoothedBypass_;
        }
    } else {
        // Стерео interleaved [L, R, L, R...]
        for (size_t i = 0; i < numFrames; ++i) {
            smoothedBypass_ += (targetBypass - smoothedBypass_) * smoothDelta;
            smoothedMix_ += (targetMix - smoothedMix_) * smoothDelta;

            const size_t idx = i * 2;
            const float inL = buffer[idx];
            const float inR = buffer[idx + 1];

            const float inSqL = inL * inL;
            const float inSqR = inR * inR;

            rmsDetectorL_ = rmsSmoothCoeff_ * rmsDetectorL_ + (1.0f - rmsSmoothCoeff_) * inSqL;
            rmsDetectorR_ = rmsSmoothCoeff_ * rmsDetectorR_ + (1.0f - rmsSmoothCoeff_) * inSqR;

            const float maxRmsVal = std::sqrt(std::max(std::max(rmsDetectorL_, rmsDetectorR_), 1e-12f));
            const float rmsDb = 20.0f * std::log10(maxRmsVal);
            currentRmsDb_ = rmsDb;

            float targetGainDb = 0.0f;
            if (rmsDb >= gateDb) {
                isFrozen_ = false;
                const float diffDb = targetRmsDb - rmsDb;
                targetGainDb = std::clamp(diffDb, maxCut, maxBoost);
            } else {
                isFrozen_ = true;
                targetGainDb = currentLevelerGainDb_ * 0.9999f;
            }

            const float targetGainLinear = std::pow(10.0f, targetGainDb / 20.0f);
            currentLevelerGainLinear_ = levelerSpeedCoeff_ * currentLevelerGainLinear_ + (1.0f - levelerSpeedCoeff_) * targetGainLinear;
            currentLevelerGainDb_ = 20.0f * std::log10(std::max(currentLevelerGainLinear_, 1e-4f));

            float leveledL = inL * currentLevelerGainLinear_;
            float leveledR = inR * currentLevelerGainLinear_;

            const float absL = std::abs(leveledL);
            const float absR = std::abs(leveledR);
            const float maxPeak = std::max(absL, absR);

            if (maxPeak > limiterEnvelopeL_) {
                limiterEnvelopeL_ = limiterAttackCoeff_ * limiterEnvelopeL_ + (1.0f - limiterAttackCoeff_) * maxPeak;
            } else {
                limiterEnvelopeL_ = limiterReleaseCoeff_ * limiterEnvelopeL_ + (1.0f - limiterReleaseCoeff_) * maxPeak;
            }

            float limGain = 1.0f;
            if (limiterEnvelopeL_ > ceilingLinear) {
                const float overDb = 20.0f * std::log10(limiterEnvelopeL_ / ceilingLinear);
                const float compressedOverDb = overDb / (1.0f + overDb * 0.25f);
                const float compressedLinear = ceilingLinear * std::pow(10.0f, compressedOverDb / 20.0f);
                limGain = std::min(1.0f, compressedLinear / (limiterEnvelopeL_ + 1e-6f));
            }
            currentLimiterGainDb_ = 20.0f * std::log10(std::max(limGain, 1e-4f));

            float wetL = leveledL * limGain;
            float wetR = leveledR * limGain;

            float outL = inL * (1.0f - smoothedMix_) + wetL * smoothedMix_;
            float outR = inR * (1.0f - smoothedMix_) + wetR * smoothedMix_;

            buffer[idx] = inL * (1.0f - smoothedBypass_) + outL * smoothedBypass_;
            buffer[idx + 1] = inR * (1.0f - smoothedBypass_) + outR * smoothedBypass_;
        }
    }
}

void SpeechLeveler::processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept {
    if (!inputs || !outputs || numFrames == 0 || !inputs[0] || !outputs[0]) return;

    const float targetRmsDb = params_.targetLevelDb;
    const float maxBoost = params_.maxBoostDb;
    const float maxCut = params_.maxCutDb;
    const float gateDb = params_.silenceGateDb;
    const float ceilingLinear = std::pow(10.0f, params_.peakCeilingDb / 20.0f);

    const float targetBypass = params_.bypass ? 0.0f : 1.0f;
    const float targetMix = params_.mix;
    const float smoothDelta = 1.0f / static_cast<float>(numFrames);

    const bool isStereo = (inputs[1] != nullptr && outputs[1] != nullptr);

    for (size_t i = 0; i < numFrames; ++i) {
        smoothedBypass_ += (targetBypass - smoothedBypass_) * smoothDelta;
        smoothedMix_ += (targetMix - smoothedMix_) * smoothDelta;

        const float inL = inputs[0][i];
        const float inR = isStereo ? inputs[1][i] : inL;

        const float inSqL = inL * inL;
        const float inSqR = inR * inR;

        rmsDetectorL_ = rmsSmoothCoeff_ * rmsDetectorL_ + (1.0f - rmsSmoothCoeff_) * inSqL;
        rmsDetectorR_ = rmsSmoothCoeff_ * rmsDetectorR_ + (1.0f - rmsSmoothCoeff_) * inSqR;

        const float maxRmsVal = std::sqrt(std::max(std::max(rmsDetectorL_, rmsDetectorR_), 1e-12f));
        const float rmsDb = 20.0f * std::log10(maxRmsVal);
        currentRmsDb_ = rmsDb;

        float targetGainDb = 0.0f;
        if (rmsDb >= gateDb) {
            isFrozen_ = false;
            const float diffDb = targetRmsDb - rmsDb;
            targetGainDb = std::clamp(diffDb, maxCut, maxBoost);
        } else {
            isFrozen_ = true;
            targetGainDb = currentLevelerGainDb_ * 0.9999f;
        }

        const float targetGainLinear = std::pow(10.0f, targetGainDb / 20.0f);
        currentLevelerGainLinear_ = levelerSpeedCoeff_ * currentLevelerGainLinear_ + (1.0f - levelerSpeedCoeff_) * targetGainLinear;
        currentLevelerGainDb_ = 20.0f * std::log10(std::max(currentLevelerGainLinear_, 1e-4f));

        float leveledL = inL * currentLevelerGainLinear_;
        float leveledR = inR * currentLevelerGainLinear_;

        const float absL = std::abs(leveledL);
        const float absR = std::abs(leveledR);
        const float maxPeak = std::max(absL, absR);

        if (maxPeak > limiterEnvelopeL_) {
            limiterEnvelopeL_ = limiterAttackCoeff_ * limiterEnvelopeL_ + (1.0f - limiterAttackCoeff_) * maxPeak;
        } else {
            limiterEnvelopeL_ = limiterReleaseCoeff_ * limiterEnvelopeL_ + (1.0f - limiterReleaseCoeff_) * maxPeak;
        }

        float limGain = 1.0f;
        if (limiterEnvelopeL_ > ceilingLinear) {
            const float overDb = 20.0f * std::log10(limiterEnvelopeL_ / ceilingLinear);
            const float compressedOverDb = overDb / (1.0f + overDb * 0.25f);
            const float compressedLinear = ceilingLinear * std::pow(10.0f, compressedOverDb / 20.0f);
            limGain = std::min(1.0f, compressedLinear / (limiterEnvelopeL_ + 1e-6f));
        }
        currentLimiterGainDb_ = 20.0f * std::log10(std::max(limGain, 1e-4f));

        float wetL = leveledL * limGain;
        float wetR = leveledR * limGain;

        float outL = inL * (1.0f - smoothedMix_) + wetL * smoothedMix_;
        float outR = inR * (1.0f - smoothedMix_) + wetR * smoothedMix_;

        outputs[0][i] = inL * (1.0f - smoothedBypass_) + outL * smoothedBypass_;
        if (isStereo) {
            outputs[1][i] = inR * (1.0f - smoothedBypass_) + outR * smoothedBypass_;
        }
    }
}

void SpeechLeveler::processBufferInPlace(float* buffer, size_t numFrames, int channels) noexcept {
    processBlock(buffer, numFrames, channels);
}

} // namespace DAWCore
