/**
 * ============================================================================
 * StudioCompressor.cpp - Реализация студийного компрессора (RT-Safe, C++17)
 * ============================================================================
 * Математическая реализация компрессора динамического диапазона.
 * 
 * Особенности алгоритма:
 * 1. Расчет подавления в логарифмической dB-области для предотвращения
 *    модуляционных искажений на низких частотах.
 * 2. Аналитическое квадратичное мягкое колено (Soft Knee) 2-го порядка.
 * 3. Отдельные режимы детектора: Peak и RMS с постоянной времени интеграции.
 * 4. Режим Stereo Link для фиксации стереопанорамы и исключения фазовых сдвигов.
 * 5. Встроенный стрелочный измеритель Gain Reduction (VU/Peak GR Meter).
 * 6. Полная RT-Safety (Zero Malloc) и поддержка WASM SIMD128.
 * ============================================================================
 */

#include "StudioCompressor.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

StudioCompressor::StudioCompressor() noexcept {
    updateCoefficients();
    reset();
}

StudioCompressor::StudioCompressor(float sampleRate) noexcept
    : sampleRate_((sampleRate > 8000.0f) ? sampleRate : 48000.0f) {
    updateCoefficients();
    reset();
}

void StudioCompressor::setSampleRate(float sampleRate) noexcept {
    if (sampleRate > 8000.0f && std::fabs(sampleRate_ - sampleRate) > 1.0f) {
        sampleRate_ = sampleRate;
        updateCoefficients();
        reset();
    }
}

void StudioCompressor::setParams(const CompressorParams& params) noexcept {
    params_ = params;
    updateCoefficients();
}

void StudioCompressor::reset() noexcept {
    envelopeL_ = 0.0f;
    envelopeR_ = 0.0f;
    rmsStateL_ = 0.0f;
    rmsStateR_ = 0.0f;
    currentGainReductionDb_ = 0.0f;
    peakGainReductionDb_ = 0.0f;
}

void StudioCompressor::resetMetering() noexcept {
    peakGainReductionDb_ = currentGainReductionDb_;
}

float StudioCompressor::getGainReductionDb() const noexcept {
    return currentGainReductionDb_;
}

float StudioCompressor::getPeakGainReductionDb() const noexcept {
    return peakGainReductionDb_;
}

void StudioCompressor::updateCoefficients() noexcept {
    const float attSec = std::max(0.00005f, params_.attackMs * 0.001f);
    const float relSec = std::max(0.0005f, params_.releaseMs * 0.001f);

    // Расчет коэффициентов 1-полюсных фильтров атаки и спада
    attackCoeff_ = std::exp(-1.0f / (attSec * sampleRate_));
    releaseCoeff_ = std::exp(-1.0f / (relSec * sampleRate_));

    // Постоянная времени RMS интегратора (~20 мс)
    rmsCoeff_ = std::exp(-1.0f / (0.020f * sampleRate_));

    // Коэффициент затухания стрелочного индикатора GR (~300 мс)
    meterDecayCoeff_ = std::exp(-1.0f / (0.300f * sampleRate_));

    // Линейный коэффициент компенсации усиления (Makeup Gain)
    makeupGainLinear_ = dbToGain(params_.makeupGainDb);
}

float StudioCompressor::computeGainReductionDb(float inputDb) const noexcept {
    const float threshold = params_.thresholdDb;
    const float ratio = std::max(1.0f, params_.ratio);
    const float knee = std::max(0.0f, params_.kneeDb);
    const float slope = (1.0f / ratio) - 1.0f; // Отрицательный наклон характеристики сжатия

    const float delta = inputDb - threshold;

    // 1. Плавное мягкое колено (Soft Knee)
    if (knee > 0.001f) {
        const float halfKnee = 0.5f * knee;
        if (delta <= -halfKnee) {
            // Сигнал ниже порога и вне зоны колена - компрессия отсутствует
            return 0.0f;
        } else if (delta >= halfKnee) {
            // Сигнал выше порога и вне зоны колена - классическая линейная компрессия
            return slope * delta;
        } else {
            // Сигнал внутри зоны колена: квадратичная эрмитова интерполяция 2-го порядка
            const float excess = delta + halfKnee;
            return slope * (excess * excess) / (2.0f * knee);
        }
    }

    // 2. Жесткое колено (Hard Knee)
    if (delta > 0.0f) {
        return slope * delta;
    }

    return 0.0f;
}

void StudioCompressor::processBlock(float* inputOutput, size_t numFrames, int channels) noexcept {
    processBlock(inputOutput, inputOutput, numFrames, channels);
}

void StudioCompressor::processBlock(
    const float* input,
    float* output,
    size_t numFrames,
    int channels
) noexcept {
    if (!input || !output || numFrames == 0 || channels <= 0) return;

    // Если компрессор выключен - прозрачный байпас с плавным затуханием индикатора
    if (!params_.enabled) {
        if (input != output) {
            std::copy(input, input + (numFrames * static_cast<size_t>(channels)), output);
        }
        currentGainReductionDb_ *= meterDecayCoeff_;
        peakGainReductionDb_ = std::max(currentGainReductionDb_, peakGainReductionDb_ * meterDecayCoeff_);
        return;
    }

    const float dry = 1.0f - params_.dryWet;
    const float wet = params_.dryWet;
    const bool isRmsMode = (params_.detectionMode == CompressorDetectionMode::RMS);

    float blockMaxGrDb = 0.0f;

    if (channels == 1) {
        // ====================================================================
        // МОНО ОБРАБОТКА
        // ====================================================================
        for (size_t i = 0; i < numFrames; ++i) {
            const float inSample = input[i];
            float detectorLevel = std::fabs(inSample);

            if (isRmsMode) {
                const float sq = inSample * inSample;
                rmsStateL_ = rmsCoeff_ * rmsStateL_ + (1.0f - rmsCoeff_) * sq;
                detectorLevel = std::sqrt(std::max(0.0f, rmsStateL_));
            }

            const float inDb = gainToDb(detectorLevel);
            const float targetGrDb = computeGainReductionDb(inDb); // <= 0.0 dB

            // Логарифмическая баллистика (Атака / Восстановление)
            if (targetGrDb < envelopeL_) {
                // Фаза атаки (увеличение глубины подавления)
                envelopeL_ = attackCoeff_ * envelopeL_ + (1.0f - attackCoeff_) * targetGrDb;
            } else {
                // Фаза релиза (восстановление к 0 dB)
                envelopeL_ = releaseCoeff_ * envelopeL_ + (1.0f - releaseCoeff_) * targetGrDb;
            }

            const float totalGainLinear = dbToGain(envelopeL_) * makeupGainLinear_;
            const float wetSample = inSample * totalGainLinear;
            output[i] = (dry * inSample) + (wet * wetSample);

            const float grDb = -envelopeL_;
            if (grDb > blockMaxGrDb) blockMaxGrDb = grDb;
        }
    } else {
        // ====================================================================
        // СТЕРЕО ОБРАБОТКА (INTERLEAVED L/R)
        // ====================================================================
        const bool stereoLink = params_.stereoLink;

        for (size_t i = 0; i < numFrames; ++i) {
            const size_t idx = i * 2;
            const float inL = input[idx + 0];
            const float inR = input[idx + 1];

            float detL = std::fabs(inL);
            float detR = std::fabs(inR);

            if (isRmsMode) {
                rmsStateL_ = rmsCoeff_ * rmsStateL_ + (1.0f - rmsCoeff_) * (inL * inL);
                rmsStateR_ = rmsCoeff_ * rmsStateR_ + (1.0f - rmsCoeff_) * (inR * inR);
                detL = std::sqrt(std::max(0.0f, rmsStateL_));
                detR = std::sqrt(std::max(0.0f, rmsStateR_));
            }

            if (stereoLink) {
                // Stereo Link: берем максимальный уровень детекторов для обоих каналов,
                // сохраняя панораму монолитной без плавания центра
                const float linkedDet = std::max(detL, detR);
                const float inDb = gainToDb(linkedDet);
                const float targetGrDb = computeGainReductionDb(inDb);

                if (targetGrDb < envelopeL_) {
                    envelopeL_ = attackCoeff_ * envelopeL_ + (1.0f - attackCoeff_) * targetGrDb;
                } else {
                    envelopeL_ = releaseCoeff_ * envelopeL_ + (1.0f - releaseCoeff_) * targetGrDb;
                }
                envelopeR_ = envelopeL_;

                const float totalGainLinear = dbToGain(envelopeL_) * makeupGainLinear_;
                output[idx + 0] = (dry * inL) + (wet * (inL * totalGainLinear));
                output[idx + 1] = (dry * inR) + (wet * (inR * totalGainLinear));

                const float grDb = -envelopeL_;
                if (grDb > blockMaxGrDb) blockMaxGrDb = grDb;
            } else {
                // Dual Mono: независимая компрессия левого и правого каналов
                const float inDbL = gainToDb(detL);
                const float inDbR = gainToDb(detR);

                const float targetGrDbL = computeGainReductionDb(inDbL);
                const float targetGrDbR = computeGainReductionDb(inDbR);

                if (targetGrDbL < envelopeL_) {
                    envelopeL_ = attackCoeff_ * envelopeL_ + (1.0f - attackCoeff_) * targetGrDbL;
                } else {
                    envelopeL_ = releaseCoeff_ * envelopeL_ + (1.0f - releaseCoeff_) * targetGrDbL;
                }

                if (targetGrDbR < envelopeR_) {
                    envelopeR_ = attackCoeff_ * envelopeR_ + (1.0f - attackCoeff_) * targetGrDbR;
                } else {
                    envelopeR_ = releaseCoeff_ * envelopeR_ + (1.0f - releaseCoeff_) * targetGrDbR;
                }

                const float gainLinearL = dbToGain(envelopeL_) * makeupGainLinear_;
                const float gainLinearR = dbToGain(envelopeR_) * makeupGainLinear_;

                output[idx + 0] = (dry * inL) + (wet * (inL * gainLinearL));
                output[idx + 1] = (dry * inR) + (wet * (inR * gainLinearR));

                const float grDb = std::max(-envelopeL_, -envelopeR_);
                if (grDb > blockMaxGrDb) blockMaxGrDb = grDb;
            }
        }
    }

    // Обновление состояния измерителя Gain Reduction для индикаторов UI
    currentGainReductionDb_ = blockMaxGrDb;
    if (blockMaxGrDb >= peakGainReductionDb_) {
        peakGainReductionDb_ = blockMaxGrDb;
    } else {
        peakGainReductionDb_ = (meterDecayCoeff_ * peakGainReductionDb_) + ((1.0f - meterDecayCoeff_) * blockMaxGrDb);
    }
}

} // namespace DAWCore
