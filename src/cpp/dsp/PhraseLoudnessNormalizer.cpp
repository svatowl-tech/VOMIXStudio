/**
 * ============================================================================
 * PhraseLoudnessNormalizer.cpp - Реализация выравнивателя громкости по фразам
 * ============================================================================
 */

#include "PhraseLoudnessNormalizer.hpp"
#include <algorithm>
#include <cmath>

namespace DAWCore {

PhraseLoudnessNormalizer::PhraseLoudnessNormalizer(float sampleRate) noexcept {
    setSampleRate(sampleRate);
}

void PhraseLoudnessNormalizer::setSampleRate(float sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;
    updateTimeConstants();
    reset();
}

void PhraseLoudnessNormalizer::setParams(const PhraseNormalizerParams& params) noexcept {
    params_ = params;
    updateTimeConstants();
}

void PhraseLoudnessNormalizer::reset() noexcept {
    envFast_ = 0.0f;
    envSlow_ = 0.0f;
    currentGainLinear_ = 1.0f;
    targetGainLinear_ = 1.0f;
    currentGainDb_ = 0.0f;
    currentInputLevelDb_ = -60.0f;
}

void PhraseLoudnessNormalizer::updateTimeConstants() noexcept {
    // Быстрый детектор атаки (~10 мс)
    fastAlpha_ = 1.0f - std::exp(-1.0f / (0.010f * sampleRate_));
    // Медленный интегратор огибающей (~40 мс)
    slowAlpha_ = 1.0f - std::exp(-1.0f / (0.040f * sampleRate_));

    const float attSec = std::max(0.005f, params_.attackMs * 0.001f);
    const float relSec = std::max(0.020f, params_.releaseMs * 0.001f);

    gainAttackAlpha_ = 1.0f - std::exp(-1.0f / (attSec * sampleRate_));
    gainReleaseAlpha_ = 1.0f - std::exp(-1.0f / (relSec * sampleRate_));
}

void PhraseLoudnessNormalizer::processBlock(float* buffer, size_t numFrames, int channels) noexcept {
    if (!buffer || numFrames == 0 || channels <= 0) return;

    if (!params_.enabled) return;

    const bool isStereo = (channels > 1);
    const float targetRms = params_.targetRmsDb;
    const float maxBoost = params_.maxBoostDb;
    const float maxCut = params_.maxCutDb;
    const float gateThresh = params_.gateThresholdDb;
    const float sens = params_.sensitivity;

    for (size_t i = 0; i < numFrames; ++i) {
        float monoSample = 0.0f;
        if (isStereo) {
            monoSample = (buffer[i * 2 + 0] + buffer[i * 2 + 1]) * 0.5f;
        } else {
            monoSample = buffer[i];
        }

        // Квадрат мгновенной амплитуды
        const float sq = monoSample * monoSample;

        // Двухкаскадный интегратор уровня речи
        envFast_ += (sq - envFast_) * fastAlpha_;
        envSlow_ += (envFast_ - envSlow_) * slowAlpha_;

        const float levelDb = 10.0f * std::log10(std::max(1e-10f, envSlow_));
        currentInputLevelDb_ = levelDb;

        // Если уровень выше шумового порога — вычисляем необходимую коррекцию
        if (levelDb > gateThresh) {
            const float diffDb = (targetRms - levelDb) * sens;
            // Ограничение диапазона
            const float clampedDiffDb = std::max(maxCut, std::min(maxBoost, diffDb));
            targetGainLinear_ = dbToGain(clampedDiffDb);
        } else {
            // В паузе мягко держим текущий уровень или плавно сходим к 0 дБ
            targetGainLinear_ = 1.0f;
        }

        // Баллистика сглаживания усиления
        if (targetGainLinear_ < currentGainLinear_) {
            currentGainLinear_ += (targetGainLinear_ - currentGainLinear_) * gainAttackAlpha_;
        } else {
            currentGainLinear_ += (targetGainLinear_ - currentGainLinear_) * gainReleaseAlpha_;
        }

        const float gain = currentGainLinear_;

        if (isStereo) {
            buffer[i * 2 + 0] *= gain;
            buffer[i * 2 + 1] *= gain;
        } else {
            buffer[i] *= gain;
        }
    }

    currentGainDb_ = gainToDb(std::max(1e-5f, currentGainLinear_));
}

} // namespace DAWCore
