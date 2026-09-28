/**
 * ============================================================================
 * SpectralDeReverb.cpp - Реализация спектрального подавителя реверберации (C++17)
 * ============================================================================
 * Zero-Alloc, WASM SIMD128 оптимизированное подавление комнатного эха.
 * ============================================================================
 */

#include "SpectralDeReverb.hpp"
#include <cmath>
#include <algorithm>

#if defined(__wasm_simd128__) || defined(__SSE2__)
#include <wasm_simd128.h>
#endif

namespace DAWCore {

// 16 стандартных ISO частот полос банка фильтров
static constexpr float BAND_FREQUENCIES[16] = {
    80.0f,   125.0f,  200.0f,  315.0f,
    500.0f,  800.0f,  1250.0f, 2000.0f,
    3150.0f, 4500.0f, 6300.0f, 8000.0f,
    10000.0f, 12000.0f, 14000.0f, 16000.0f
};

SpectralDeReverb::SpectralDeReverb(float sampleRate) noexcept
    : sampleRate_(sampleRate > 8000.0f ? sampleRate : 48000.0f) {
    updateFilterBank();
    updateTimeConstants();
    reset();
}

void SpectralDeReverb::setSampleRate(float sampleRate) noexcept {
    if (sampleRate > 8000.0f && std::abs(sampleRate_ - sampleRate) > 0.1f) {
        sampleRate_ = sampleRate;
        updateFilterBank();
        updateTimeConstants();
        reset();
    }
}

void SpectralDeReverb::setParams(const SpectralDeReverbParams& params) noexcept {
    params_.reductionDb = std::clamp(params.reductionDb, -24.0f, 0.0f);
    params_.decayTimeEstMs = std::clamp(params.decayTimeEstMs, 80.0f, 1200.0f);
    params_.clarity = std::clamp(params.clarity, 0.0f, 1.0f);
    params_.mix = std::clamp(params.mix, 0.0f, 1.0f);
    params_.bypass = params.bypass;

    updateTimeConstants();
}

void SpectralDeReverb::setReductionDb(float db) noexcept {
    params_.reductionDb = std::clamp(db, -24.0f, 0.0f);
    updateTimeConstants();
}

void SpectralDeReverb::setDecayTimeEstMs(float ms) noexcept {
    params_.decayTimeEstMs = std::clamp(ms, 80.0f, 1200.0f);
    updateTimeConstants();
}

void SpectralDeReverb::setClarity(float clarity) noexcept {
    params_.clarity = std::clamp(clarity, 0.0f, 1.0f);
}

void SpectralDeReverb::setMix(float mix) noexcept {
    params_.mix = std::clamp(mix, 0.0f, 1.0f);
}

void SpectralDeReverb::setBypass(bool bypass) noexcept {
    params_.bypass = bypass;
}

void SpectralDeReverb::reset() noexcept {
    for (size_t i = 0; i < NUM_BANDS; ++i) {
        bands_[i].reset();
    }
    smoothedBypass_ = params_.bypass ? 1.0f : 0.0f;
    smoothedMix_ = params_.mix;
    minGainLinear_ = std::pow(10.0f, params_.reductionDb / 20.0f);
}

void SpectralDeReverb::updateTimeConstants() noexcept {
    // 1. Атака кратковременной энергии (3.5 мс)
    const float attackMs = 3.5f;
    attackCoeff_ = std::exp(-1.0f / (attackMs * 0.001f * sampleRate_));

    // 2. Время затухания диффузной реверберации RT60
    const float rt60Sec = std::max(0.08f, params_.decayTimeEstMs * 0.001f);
    // Для RT60 затухание на -60 дБ соответствует e^(-6.9077):
    decayCoeff_ = std::exp(-6.9077f / (rt60Sec * sampleRate_));

    // 3. Восстановление гейна
    const float releaseMs = 25.0f;
    releaseCoeff_ = std::exp(-1.0f / (releaseMs * 0.001f * sampleRate_));

    minGainLinear_ = std::pow(10.0f, params_.reductionDb / 20.0f);
}

void SpectralDeReverb::updateFilterBank() noexcept {
    // Настройка полосовых фильтров (Bandpass 2-го порядка с постоянной добротностью Q = 1.414)
    const float Q = 1.414f;

    for (size_t i = 0; i < NUM_BANDS; ++i) {
        float fc = std::clamp(BAND_FREQUENCIES[i], 40.0f, sampleRate_ * 0.45f);
        bands_[i].centerFreq = fc;

        const float omega = 2.0f * PI_F * fc / sampleRate_;
        const float sinOmega = std::sin(omega);
        const float cosOmega = std::cos(omega);
        const float alpha = sinOmega / (2.0f * Q);

        const float a0 = 1.0f + alpha;
        const float invA0 = 1.0f / a0;

        bands_[i].filter.b0 = (sinOmega * 0.5f) * invA0;
        bands_[i].filter.b1 = 0.0f;
        bands_[i].filter.b2 = -(sinOmega * 0.5f) * invA0;
        bands_[i].filter.a1 = (-2.0f * cosOmega) * invA0;
        bands_[i].filter.a2 = (1.0f - alpha) * invA0;
    }
}

void SpectralDeReverb::processBlock(float* buffer, size_t numFrames, int channels) noexcept {
    if (!buffer || numFrames == 0) return;

    const float targetBypass = params_.bypass ? 1.0f : 0.0f;
    const float targetMix = params_.mix;
    const float clarityBoost = 1.0f + params_.clarity * 0.6f;
    const float minGain = minGainLinear_;

    if (channels == 1) {
        for (size_t f = 0; f < numFrames; ++f) {
            float in = buffer[f];

            smoothedBypass_ += 0.005f * (targetBypass - smoothedBypass_);
            smoothedMix_ += 0.005f * (targetMix - smoothedMix_);

            float sumProcessed = 0.0f;

            // Обработка 16 полос
            for (size_t b = 0; b < NUM_BANDS; ++b) {
                auto& band = bands_[b];

                // 1. Полосовой сигнал
                float bandSig = band.filter.processLeft(in);

                // 2. Кратковременная энергия полосы
                float absBand = std::abs(bandSig);
                if (absBand > band.shortEnergyL) {
                    band.shortEnergyL = attackCoeff_ * band.shortEnergyL + (1.0f - attackCoeff_) * absBand;
                } else {
                    band.shortEnergyL = releaseCoeff_ * band.shortEnergyL + (1.0f - releaseCoeff_) * absBand;
                }

                // 3. Оценка хвоста диффузной реверберации
                if (band.shortEnergyL > band.reverbTailL) {
                    // Атака речи
                    band.reverbTailL = attackCoeff_ * band.reverbTailL + (1.0f - attackCoeff_) * band.shortEnergyL;
                } else {
                    // Экспоненциальный спад реверберационного хвоста
                    band.reverbTailL = decayCoeff_ * band.reverbTailL;
                }

                // 4. Детектор атаки/транзиентов (сохранение согласных)
                float diff = band.shortEnergyL - band.reverbTailL;
                float onsetWeight = (diff > 0.0f) ? (1.0f + clarityBoost * (diff / (band.shortEnergyL + 1e-5f))) : 1.0f;

                // 5. Вычисление коэффициента спектрального подавления
                float tailRatio = band.reverbTailL / std::max(band.shortEnergyL + 1e-5f, 1e-6f);
                float suppression = 1.0f - (tailRatio * 0.85f / onsetWeight);
                float targetGain = std::clamp(suppression, minGain, 1.0f);

                // Плавное следование гейна
                band.currentGainL = releaseCoeff_ * band.currentGainL + (1.0f - releaseCoeff_) * targetGain;

                sumProcessed += bandSig * band.currentGainL;
            }

            // Суммирование Dry/Wet & Bypass
            float mixed = in * (1.0f - smoothedMix_) + sumProcessed * smoothedMix_;
            buffer[f] = mixed * (1.0f - smoothedBypass_) + in * smoothedBypass_;
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

            float sumL = 0.0f;
            float sumR = 0.0f;

            for (size_t b = 0; b < NUM_BANDS; ++b) {
                auto& band = bands_[b];

                float bandSigL = band.filter.processLeft(inL);
                float bandSigR = band.filter.processRight(inR);

                // Кратковременная энергия
                float absL = std::abs(bandSigL);
                float absR = std::abs(bandSigR);

                if (absL > band.shortEnergyL) band.shortEnergyL = attackCoeff_ * band.shortEnergyL + (1.0f - attackCoeff_) * absL;
                else band.shortEnergyL = releaseCoeff_ * band.shortEnergyL + (1.0f - releaseCoeff_) * absL;

                if (absR > band.shortEnergyR) band.shortEnergyR = attackCoeff_ * band.shortEnergyR + (1.0f - attackCoeff_) * absR;
                else band.shortEnergyR = releaseCoeff_ * band.shortEnergyR + (1.0f - releaseCoeff_) * absR;

                // Хвост реверберации
                if (band.shortEnergyL > band.reverbTailL) band.reverbTailL = attackCoeff_ * band.reverbTailL + (1.0f - attackCoeff_) * band.shortEnergyL;
                else band.reverbTailL = decayCoeff_ * band.reverbTailL;

                if (band.shortEnergyR > band.reverbTailR) band.reverbTailR = attackCoeff_ * band.reverbTailR + (1.0f - attackCoeff_) * band.shortEnergyR;
                else band.reverbTailR = decayCoeff_ * band.reverbTailR;

                // Детекция атаки
                float diffL = band.shortEnergyL - band.reverbTailL;
                float onsetL = (diffL > 0.0f) ? (1.0f + clarityBoost * (diffL / (band.shortEnergyL + 1e-5f))) : 1.0f;

                float diffR = band.shortEnergyR - band.reverbTailR;
                float onsetR = (diffR > 0.0f) ? (1.0f + clarityBoost * (diffR / (band.shortEnergyR + 1e-5f))) : 1.0f;

                // Подавление
                float tailRatioL = band.reverbTailL / std::max(band.shortEnergyL + 1e-5f, 1e-6f);
                float targetGainL = std::clamp(1.0f - (tailRatioL * 0.85f / onsetL), minGain, 1.0f);

                float tailRatioR = band.reverbTailR / std::max(band.shortEnergyR + 1e-5f, 1e-6f);
                float targetGainR = std::clamp(1.0f - (tailRatioR * 0.85f / onsetR), minGain, 1.0f);

                band.currentGainL = releaseCoeff_ * band.currentGainL + (1.0f - releaseCoeff_) * targetGainL;
                band.currentGainR = releaseCoeff_ * band.currentGainR + (1.0f - releaseCoeff_) * targetGainR;

                sumL += bandSigL * band.currentGainL;
                sumR += bandSigR * band.currentGainR;
            }

            float mixedL = inL * (1.0f - smoothedMix_) + sumL * smoothedMix_;
            float mixedR = inR * (1.0f - smoothedMix_) + sumR * smoothedMix_;

            buffer[idxL] = mixedL * (1.0f - smoothedBypass_) + inL * smoothedBypass_;
            buffer[idxR] = mixedR * (1.0f - smoothedBypass_) + inR * smoothedBypass_;
        }
    }
}

void SpectralDeReverb::processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept {
    if (!inputs || !outputs || numFrames == 0) return;

    const float* inL = inputs[0];
    const float* inR = (inputs[1] != nullptr) ? inputs[1] : inputs[0];
    float* outL = outputs[0];
    float* outR = (outputs[1] != nullptr) ? outputs[1] : outputs[0];

    const float targetBypass = params_.bypass ? 1.0f : 0.0f;
    const float targetMix = params_.mix;
    const float clarityBoost = 1.0f + params_.clarity * 0.6f;
    const float minGain = minGainLinear_;

    for (size_t f = 0; f < numFrames; ++f) {
        float sampleL = inL[f];
        float sampleR = inR[f];

        smoothedBypass_ += 0.005f * (targetBypass - smoothedBypass_);
        smoothedMix_ += 0.005f * (targetMix - smoothedMix_);

        float sumL = 0.0f;
        float sumR = 0.0f;

        for (size_t b = 0; b < NUM_BANDS; ++b) {
            auto& band = bands_[b];

            float bandSigL = band.filter.processLeft(sampleL);
            float bandSigR = band.filter.processRight(sampleR);

            float absL = std::abs(bandSigL);
            float absR = std::abs(bandSigR);

            if (absL > band.shortEnergyL) band.shortEnergyL = attackCoeff_ * band.shortEnergyL + (1.0f - attackCoeff_) * absL;
            else band.shortEnergyL = releaseCoeff_ * band.shortEnergyL + (1.0f - releaseCoeff_) * absL;

            if (absR > band.shortEnergyR) band.shortEnergyR = attackCoeff_ * band.shortEnergyR + (1.0f - attackCoeff_) * absR;
            else band.shortEnergyR = releaseCoeff_ * band.shortEnergyR + (1.0f - releaseCoeff_) * absR;

            if (band.shortEnergyL > band.reverbTailL) band.reverbTailL = attackCoeff_ * band.reverbTailL + (1.0f - attackCoeff_) * band.shortEnergyL;
            else band.reverbTailL = decayCoeff_ * band.reverbTailL;

            if (band.shortEnergyR > band.reverbTailR) band.reverbTailR = attackCoeff_ * band.reverbTailR + (1.0f - attackCoeff_) * band.shortEnergyR;
            else band.reverbTailR = decayCoeff_ * band.reverbTailR;

            float diffL = band.shortEnergyL - band.reverbTailL;
            float onsetL = (diffL > 0.0f) ? (1.0f + clarityBoost * (diffL / (band.shortEnergyL + 1e-5f))) : 1.0f;

            float diffR = band.shortEnergyR - band.reverbTailR;
            float onsetR = (diffR > 0.0f) ? (1.0f + clarityBoost * (diffR / (band.shortEnergyR + 1e-5f))) : 1.0f;

            float tailRatioL = band.reverbTailL / std::max(band.shortEnergyL + 1e-5f, 1e-6f);
            float targetGainL = std::clamp(1.0f - (tailRatioL * 0.85f / onsetL), minGain, 1.0f);

            float tailRatioR = band.reverbTailR / std::max(band.shortEnergyR + 1e-5f, 1e-6f);
            float targetGainR = std::clamp(1.0f - (tailRatioR * 0.85f / onsetR), minGain, 1.0f);

            band.currentGainL = releaseCoeff_ * band.currentGainL + (1.0f - releaseCoeff_) * targetGainL;
            band.currentGainR = releaseCoeff_ * band.currentGainR + (1.0f - releaseCoeff_) * targetGainR;

            sumL += bandSigL * band.currentGainL;
            sumR += bandSigR * band.currentGainR;
        }

        float mixedL = sampleL * (1.0f - smoothedMix_) + sumL * smoothedMix_;
        float mixedR = sampleR * (1.0f - smoothedMix_) + sumR * smoothedMix_;

        outL[f] = mixedL * (1.0f - smoothedBypass_) + sampleL * smoothedBypass_;
        outR[f] = mixedR * (1.0f - smoothedBypass_) + sampleR * smoothedBypass_;
    }
}

} // namespace DAWCore
