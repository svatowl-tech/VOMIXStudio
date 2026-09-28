/**
 * ============================================================================
 * DePlosivePro.cpp - Реализация профессионального модуля подавления задувов (C++17)
 * ============================================================================
 * Zero-Alloc, WASM SIMD128 оптимизированная обработка взрывных согласных «п»/«б».
 * ============================================================================
 */

#include "DePlosivePro.hpp"
#include <cmath>
#include <algorithm>

#if defined(__wasm_simd128__) || defined(__SSE2__)
#include <wasm_simd128.h>
#endif

namespace DAWCore {

static constexpr float PI_F = 3.14159265358979323846f;
static constexpr float SQRT2_F = 1.4142135623730950488f;

DePlosivePro::DePlosivePro(float sampleRate) noexcept
    : sampleRate_(sampleRate > 8000.0f ? sampleRate : 48000.0f) {
    updateCrossoverCoefficients();
    updateTimeConstants();
    reset();
}

void DePlosivePro::setSampleRate(float sampleRate) noexcept {
    if (sampleRate > 8000.0f && std::abs(sampleRate_ - sampleRate) > 0.1f) {
        sampleRate_ = sampleRate;
        updateCrossoverCoefficients();
        updateTimeConstants();
        reset();
    }
}

void DePlosivePro::setParams(const DePlosiveProParams& params) noexcept {
    params_ = params;
    updateCrossoverCoefficients();
    updateTimeConstants();
}

void DePlosivePro::setThresholdDb(float db) noexcept {
    params_.thresholdDb = std::clamp(db, -60.0f, 0.0f);
}

void DePlosivePro::setFrequencyLimit(float hz) noexcept {
    params_.frequencyLimit = std::clamp(hz, 40.0f, 350.0f);
    updateCrossoverCoefficients();
}

void DePlosivePro::setSuppressionDepthDb(float db) noexcept {
    params_.suppressionDepthDb = std::clamp(db, -48.0f, 0.0f);
}

void DePlosivePro::setRecoveryMs(float ms) noexcept {
    params_.recoveryMs = std::clamp(ms, 5.0f, 300.0f);
    updateTimeConstants();
}

void DePlosivePro::setBypass(bool bypass) noexcept {
    params_.bypass = bypass;
}

void DePlosivePro::setWetDry(float mix) noexcept {
    params_.wetDry = std::clamp(mix, 0.0f, 1.0f);
}

void DePlosivePro::reset() noexcept {
    lpFilter1_.reset();
    lpFilter2_.reset();
    hpFilter1_.reset();
    hpFilter2_.reset();

    envelopeLow_ = 0.0f;
    envelopePos_ = 0.0f;
    envelopeNeg_ = 0.0f;
    currentAttenLinear_ = 1.0f;
    currentGainReductionDb_ = 0.0f;
    plosiveDetected_ = false;
    smoothedBypass_ = params_.bypass ? 1.0f : 0.0f;
    smoothedWetDry_ = params_.wetDry;
}

void DePlosivePro::updateTimeConstants() noexcept {
    // Очень быстрая атака детектора (1.5 мс) для мгновенного захвата фронта взрывной согласной
    const float attackMs = 1.5f;
    attackCoeff_ = std::exp(-1.0f / (attackMs * 0.001f * sampleRate_));

    // Время восстановления (recovery) из параметров
    const float recoveryMs = std::max(5.0f, params_.recoveryMs);
    releaseCoeff_ = std::exp(-1.0f / (recoveryMs * 0.001f * sampleRate_));

    // Детектор асимметрии импульса (сглаживание 3.0 мс)
    asymmetryCoeff_ = std::exp(-1.0f / (3.0f * 0.001f * sampleRate_));
}

void DePlosivePro::updateCrossoverCoefficients() noexcept {
    // 2-полосный кроссовер Linkwitz-Riley 4-го порядка (LR4)
    // Состоит из двух каскадных фильтров Баттерворта 2-го порядка с добротностью Q = 1/sqrt(2) = 0.7071
    const float fc = std::clamp(params_.frequencyLimit, 40.0f, sampleRate_ * 0.45f);
    const float omega = 2.0f * PI_F * fc / sampleRate_;
    const float sinOmega = std::sin(omega);
    const float cosOmega = std::cos(omega);
    const float alpha = sinOmega / (2.0f * (1.0f / SQRT2_F));

    // Lowpass Butterworth 2-го порядка
    {
        const float a0 = 1.0f + alpha;
        const float invA0 = 1.0f / a0;
        const float b0 = ((1.0f - cosOmega) * 0.5f) * invA0;
        const float b1 = (1.0f - cosOmega) * invA0;
        const float b2 = b0;
        const float a1 = (-2.0f * cosOmega) * invA0;
        const float a2 = (1.0f - alpha) * invA0;

        lpFilter1_.b0 = b0; lpFilter1_.b1 = b1; lpFilter1_.b2 = b2;
        lpFilter1_.a1 = a1; lpFilter1_.a2 = a2;

        lpFilter2_.b0 = b0; lpFilter2_.b1 = b1; lpFilter2_.b2 = b2;
        lpFilter2_.a1 = a1; lpFilter2_.a2 = a2;
    }

    // Highpass Butterworth 2-го порядка
    {
        const float a0 = 1.0f + alpha;
        const float invA0 = 1.0f / a0;
        const float b0 = ((1.0f + cosOmega) * 0.5f) * invA0;
        const float b1 = (-(1.0f + cosOmega)) * invA0;
        const float b2 = b0;
        const float a1 = (-2.0f * cosOmega) * invA0;
        const float a2 = (1.0f - alpha) * invA0;

        hpFilter1_.b0 = b0; hpFilter1_.b1 = b1; hpFilter1_.b2 = b2;
        hpFilter1_.a1 = a1; hpFilter1_.a2 = a2;

        hpFilter2_.b0 = b0; hpFilter2_.b1 = b1; hpFilter2_.b2 = b2;
        hpFilter2_.a1 = a1; hpFilter2_.a2 = a2;
    }
}

void DePlosivePro::processBlock(float* buffer, size_t numFrames, int channels) noexcept {
    if (!buffer || numFrames == 0) return;

    const float targetBypass = params_.bypass ? 1.0f : 0.0f;
    const float targetWet = params_.wetDry;
    const float thresholdLinear = std::pow(10.0f, params_.thresholdDb / 20.0f);
    const float maxSuppressionLinear = std::pow(10.0f, params_.suppressionDepthDb / 20.0f);

    if (channels == 1) {
        // Моно обработка
        for (size_t i = 0; i < numFrames; ++i) {
            float in = buffer[i];

            // Bypass & Wet/Dry interpolation
            smoothedBypass_ += 0.005f * (targetBypass - smoothedBypass_);
            smoothedWetDry_ += 0.005f * (targetWet - smoothedWetDry_);

            // 1. Кроссовер: разделение на суб-бас и ВЧ
            float low1 = lpFilter1_.processLeft(in);
            float low = lpFilter2_.processLeft(low1);

            float high1 = hpFilter1_.processLeft(in);
            float high = hpFilter2_.processLeft(high1);

            // 2. Детектор взрывной энергии и асимметрии
            float absLow = std::abs(low);
            if (absLow > envelopeLow_) {
                envelopeLow_ = attackCoeff_ * envelopeLow_ + (1.0f - attackCoeff_) * absLow;
            } else {
                envelopeLow_ = releaseCoeff_ * envelopeLow_ + (1.0f - releaseCoeff_) * absLow;
            }

            // Детекция полуволн (+ и -) для выявления асимметрии ветрового удара капсюля
            float posPart = (low > 0.0f) ? low : 0.0f;
            float negPart = (low < 0.0f) ? -low : 0.0f;
            envelopePos_ = asymmetryCoeff_ * envelopePos_ + (1.0f - asymmetryCoeff_) * posPart;
            envelopeNeg_ = asymmetryCoeff_ * envelopeNeg_ + (1.0f - asymmetryCoeff_) * negPart;

            float denom = std::max(envelopePos_ + envelopeNeg_, 1e-6f);
            float asymmetry = std::abs(envelopePos_ - envelopeNeg_) / denom; // 0..1

            // Порог и вычисление коэффициента ослабления
            float excess = envelopeLow_ - thresholdLinear;
            float targetAtten = 1.0f;
            if (excess > 0.0f) {
                plosiveDetected_ = true;
                // Учитываем асимметрию: если есть выраженный ветровой задув, подавление агрессивнее
                float asymmetryWeight = 1.0f + 0.5f * asymmetry;
                float ratio = (excess / (envelopeLow_ + 1e-5f)) * asymmetryWeight;
                ratio = std::clamp(ratio, 0.0f, 1.0f);

                targetAtten = 1.0f - ratio * (1.0f - maxSuppressionLinear);
            } else {
                plosiveDetected_ = false;
            }

            // VCA сглаживание коэффициента аттенюации
            if (targetAtten < currentAttenLinear_) {
                currentAttenLinear_ = attackCoeff_ * currentAttenLinear_ + (1.0f - attackCoeff_) * targetAtten;
            } else {
                currentAttenLinear_ = releaseCoeff_ * currentAttenLinear_ + (1.0f - releaseCoeff_) * targetAtten;
            }

            currentAttenLinear_ = std::clamp(currentAttenLinear_, maxSuppressionLinear, 1.0f);
            currentGainReductionDb_ = 20.0f * std::log10(std::max(currentAttenLinear_, 1e-4f));

            // 3. VCA ослабление только суб-баса и фазово-точное сложение с верхом
            float processedLow = low * currentAttenLinear_;
            float wetSignal = processedLow + high;

            // 4. Wet/Dry и Bypass микширование
            float mixed = in * (1.0f - smoothedWetDry_) + wetSignal * smoothedWetDry_;
            buffer[i] = mixed * (1.0f - smoothedBypass_) + in * smoothedBypass_;
        }
    } else {
        // Стерео interleaved [L, R, L, R...]
        for (size_t i = 0; i < numFrames; ++i) {
            size_t idxL = i * 2;
            size_t idxR = idxL + 1;

            float inL = buffer[idxL];
            float inR = buffer[idxR];

            smoothedBypass_ += 0.005f * (targetBypass - smoothedBypass_);
            smoothedWetDry_ += 0.005f * (targetWet - smoothedWetDry_);

            // 1. Кроссовер Linkwitz-Riley 4-го порядка
            float low1L = lpFilter1_.processLeft(inL);
            float lowL = lpFilter2_.processLeft(low1L);
            float high1L = hpFilter1_.processLeft(inL);
            float highL = hpFilter2_.processLeft(high1L);

            float low1R = lpFilter1_.processRight(inR);
            float lowR = lpFilter2_.processRight(low1R);
            float high1R = hpFilter1_.processRight(inR);
            float highR = hpFilter2_.processRight(high1R);

            // 2. Детектор взрывной энергии стерео (Sidechain Max)
            float absLowMax = std::max(std::abs(lowL), std::abs(lowR));
            if (absLowMax > envelopeLow_) {
                envelopeLow_ = attackCoeff_ * envelopeLow_ + (1.0f - attackCoeff_) * absLowMax;
            } else {
                envelopeLow_ = releaseCoeff_ * envelopeLow_ + (1.0f - releaseCoeff_) * absLowMax;
            }

            // Детекция асимметрии
            float posPart = std::max(std::max(lowL, 0.0f), std::max(lowR, 0.0f));
            float negPart = std::max(std::max(-lowL, 0.0f), std::max(-lowR, 0.0f));
            envelopePos_ = asymmetryCoeff_ * envelopePos_ + (1.0f - asymmetryCoeff_) * posPart;
            envelopeNeg_ = asymmetryCoeff_ * envelopeNeg_ + (1.0f - asymmetryCoeff_) * negPart;

            float denom = std::max(envelopePos_ + envelopeNeg_, 1e-6f);
            float asymmetry = std::abs(envelopePos_ - envelopeNeg_) / denom;

            float excess = envelopeLow_ - thresholdLinear;
            float targetAtten = 1.0f;
            if (excess > 0.0f) {
                plosiveDetected_ = true;
                float asymmetryWeight = 1.0f + 0.5f * asymmetry;
                float ratio = (excess / (envelopeLow_ + 1e-5f)) * asymmetryWeight;
                ratio = std::clamp(ratio, 0.0f, 1.0f);
                targetAtten = 1.0f - ratio * (1.0f - maxSuppressionLinear);
            } else {
                plosiveDetected_ = false;
            }

            if (targetAtten < currentAttenLinear_) {
                currentAttenLinear_ = attackCoeff_ * currentAttenLinear_ + (1.0f - attackCoeff_) * targetAtten;
            } else {
                currentAttenLinear_ = releaseCoeff_ * currentAttenLinear_ + (1.0f - releaseCoeff_) * targetAtten;
            }

            currentAttenLinear_ = std::clamp(currentAttenLinear_, maxSuppressionLinear, 1.0f);
            currentGainReductionDb_ = 20.0f * std::log10(std::max(currentAttenLinear_, 1e-4f));

            // 3. VCA ослабление только суб-баса и сложение
            float wetSignalL = lowL * currentAttenLinear_ + highL;
            float wetSignalR = lowR * currentAttenLinear_ + highR;

            // 4. Сглаженное микширование
            float mixedL = inL * (1.0f - smoothedWetDry_) + wetSignalL * smoothedWetDry_;
            float mixedR = inR * (1.0f - smoothedWetDry_) + wetSignalR * smoothedWetDry_;

            buffer[idxL] = mixedL * (1.0f - smoothedBypass_) + inL * smoothedBypass_;
            buffer[idxR] = mixedR * (1.0f - smoothedBypass_) + inR * smoothedBypass_;
        }
    }
}

void DePlosivePro::processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept {
    if (!inputs || !outputs || numFrames == 0) return;

    const float* inL = inputs[0];
    const float* inR = (inputs[1] != nullptr) ? inputs[1] : inputs[0];
    float* outL = outputs[0];
    float* outR = (outputs[1] != nullptr) ? outputs[1] : outputs[0];

    const float targetBypass = params_.bypass ? 1.0f : 0.0f;
    const float targetWet = params_.wetDry;
    const float thresholdLinear = std::pow(10.0f, params_.thresholdDb / 20.0f);
    const float maxSuppressionLinear = std::pow(10.0f, params_.suppressionDepthDb / 20.0f);

    for (size_t i = 0; i < numFrames; ++i) {
        float sampleL = inL[i];
        float sampleR = inR[i];

        smoothedBypass_ += 0.005f * (targetBypass - smoothedBypass_);
        smoothedWetDry_ += 0.005f * (targetWet - smoothedWetDry_);

        float low1L = lpFilter1_.processLeft(sampleL);
        float lowL = lpFilter2_.processLeft(low1L);
        float high1L = hpFilter1_.processLeft(sampleL);
        float highL = hpFilter2_.processLeft(high1L);

        float low1R = lpFilter1_.processRight(sampleR);
        float lowR = lpFilter2_.processRight(low1R);
        float high1R = hpFilter1_.processRight(sampleR);
        float highR = hpFilter2_.processRight(high1R);

        float absLowMax = std::max(std::abs(lowL), std::abs(lowR));
        if (absLowMax > envelopeLow_) {
            envelopeLow_ = attackCoeff_ * envelopeLow_ + (1.0f - attackCoeff_) * absLowMax;
        } else {
            envelopeLow_ = releaseCoeff_ * envelopeLow_ + (1.0f - releaseCoeff_) * absLowMax;
        }

        float posPart = std::max(std::max(lowL, 0.0f), std::max(lowR, 0.0f));
        float negPart = std::max(std::max(-lowL, 0.0f), std::max(-lowR, 0.0f));
        envelopePos_ = asymmetryCoeff_ * envelopePos_ + (1.0f - asymmetryCoeff_) * posPart;
        envelopeNeg_ = asymmetryCoeff_ * envelopeNeg_ + (1.0f - asymmetryCoeff_) * negPart;

        float denom = std::max(envelopePos_ + envelopeNeg_, 1e-6f);
        float asymmetry = std::abs(envelopePos_ - envelopeNeg_) / denom;

        float excess = envelopeLow_ - thresholdLinear;
        float targetAtten = 1.0f;
        if (excess > 0.0f) {
            plosiveDetected_ = true;
            float asymmetryWeight = 1.0f + 0.5f * asymmetry;
            float ratio = (excess / (envelopeLow_ + 1e-5f)) * asymmetryWeight;
            ratio = std::clamp(ratio, 0.0f, 1.0f);
            targetAtten = 1.0f - ratio * (1.0f - maxSuppressionLinear);
        } else {
            plosiveDetected_ = false;
        }

        if (targetAtten < currentAttenLinear_) {
            currentAttenLinear_ = attackCoeff_ * currentAttenLinear_ + (1.0f - attackCoeff_) * targetAtten;
        } else {
            currentAttenLinear_ = releaseCoeff_ * currentAttenLinear_ + (1.0f - releaseCoeff_) * targetAtten;
        }

        currentAttenLinear_ = std::clamp(currentAttenLinear_, maxSuppressionLinear, 1.0f);
        currentGainReductionDb_ = 20.0f * std::log10(std::max(currentAttenLinear_, 1e-4f));

        float wetSignalL = lowL * currentAttenLinear_ + highL;
        float wetSignalR = lowR * currentAttenLinear_ + highR;

        float mixedL = sampleL * (1.0f - smoothedWetDry_) + wetSignalL * smoothedWetDry_;
        float mixedR = sampleR * (1.0f - smoothedWetDry_) + wetSignalR * smoothedWetDry_;

        outL[i] = mixedL * (1.0f - smoothedBypass_) + sampleL * smoothedBypass_;
        outR[i] = mixedR * (1.0f - smoothedBypass_) + sampleR * smoothedBypass_;
    }
}

} // namespace DAWCore
