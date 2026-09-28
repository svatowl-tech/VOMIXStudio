/**
 * ============================================================================
 * TransientShaper.cpp - Реализация формирователя переходных процессов (C++17)
 * ============================================================================
 * Математическая реализация дифференциального разделения огибающей на атаку
 * и сустейн с сохранением фазовой структуры исходного сигнала.
 * ============================================================================
 */

#include "TransientShaper.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

TransientShaper::TransientShaper() noexcept {
    updateCoefficients();
    reset();
}

TransientShaper::TransientShaper(float sampleRate) noexcept
    : sampleRate_((sampleRate > 8000.0f) ? sampleRate : 48000.0f) {
    updateCoefficients();
    reset();
}

void TransientShaper::setSampleRate(float sampleRate) noexcept {
    if (sampleRate > 8000.0f && std::fabs(sampleRate_ - sampleRate) > 1.0f) {
        sampleRate_ = sampleRate;
        updateCoefficients();
        reset();
    }
}

void TransientShaper::setParams(const TransientShaperParams& params) noexcept {
    params_ = params;
    updateCoefficients();
}

void TransientShaper::reset() noexcept {
    envFastL_ = 0.0f;
    envSlowL_ = 0.0f;
    envFastR_ = 0.0f;
    envSlowR_ = 0.0f;
    currentTransient_ = 0.0f;
    currentSustain_ = 0.0f;
}

void TransientShaper::updateCoefficients() noexcept {
    // Временные константы быстрого интегратора транзиентов (0.5 .. 15 мс)
    const float fastAttSec = std::max(0.0002f, params_.fastWindowMs * 0.001f);
    const float fastRelSec = fastAttSec * 3.0f;

    // Временные константы медленного интегратора сустейна (15 .. 150 мс)
    const float slowAttSec = std::max(0.005f, params_.slowWindowMs * 0.001f);
    const float slowRelSec = slowAttSec * 2.5f;

    // Расчет коэффициентов 1-полюсных фильтров слежения
    fastAttackCoeff_ = std::exp(-1.0f / (fastAttSec * sampleRate_));
    fastReleaseCoeff_ = std::exp(-1.0f / (fastRelSec * sampleRate_));

    slowAttackCoeff_ = std::exp(-1.0f / (slowAttSec * sampleRate_));
    slowReleaseCoeff_ = std::exp(-1.0f / (slowRelSec * sampleRate_));

    // Линейные коэффициенты усиления
    attackGainLinear_ = dbToGain(params_.attackGainDb);
    sustainGainLinear_ = dbToGain(params_.sustainGainDb);
    outputGainLinear_ = dbToGain(params_.outputGainDb);
}

void TransientShaper::processBlock(float* samples, size_t numFrames, int channels) noexcept {
    processBlock(samples, samples, numFrames, channels);
}

void TransientShaper::processBlock(
    const float* input,
    float* output,
    size_t numFrames,
    int channels
) noexcept {
    if (!input || !output || numFrames == 0 || channels <= 0) return;

    // Прозрачный байпас, если эффект выключен
    if (!params_.enabled) {
        if (input != output) {
            std::copy(input, input + (numFrames * static_cast<size_t>(channels)), output);
        }
        return;
    }

    const float attGain = attackGainLinear_;
    const float susGain = sustainGainLinear_;
    const float outGain = outputGainLinear_;
    const bool softClip = params_.softClip;

    float maxTransient = 0.0f;
    float maxSustain = 0.0f;

    if (channels == 1) {
        // ====================================================================
        // МОНО ОБРАБОТКА
        // ====================================================================
        for (size_t i = 0; i < numFrames; ++i) {
            const float x = input[i];
            const float absX = std::fabs(x);

            // 1. Быстрый детектор атаки (Fast Envelope)
            if (absX > envFastL_) {
                envFastL_ = fastAttackCoeff_ * envFastL_ + (1.0f - fastAttackCoeff_) * absX;
            } else {
                envFastL_ = fastReleaseCoeff_ * envFastL_ + (1.0f - fastReleaseCoeff_) * absX;
            }

            // 2. Медленный детектор сустейна (Slow Envelope)
            if (absX > envSlowL_) {
                envSlowL_ = slowAttackCoeff_ * envSlowL_ + (1.0f - slowAttackCoeff_) * absX;
            } else {
                envSlowL_ = slowReleaseCoeff_ * envSlowL_ + (1.0f - slowReleaseCoeff_) * absX;
            }

            // 3. Дифференциальное разделение огибающей
            const float transient = std::max(0.0f, envFastL_ - envSlowL_);
            const float sustain = envSlowL_;

            if (transient > maxTransient) maxTransient = transient;
            if (sustain > maxSustain) maxSustain = sustain;

            // 4. Формирование модулирующего коэффициента передачи (Zero Phase VCA)
            const float origEnvelope = envFastL_ + 1e-6f;
            const float modifiedEnvelope = (transient * attGain) + (sustain * susGain);
            const float totalGain = (modifiedEnvelope / origEnvelope) * outGain;

            float y = x * totalGain;

            // 5. Мягкое аналоговое насыщение при всплесках
            if (softClip && std::fabs(y) > 0.85f) {
                y = std::tanh(y);
            }

            output[i] = y;
        }
    } else {
        // ====================================================================
        // СТЕРЕО ОБРАБОТКА (INTERLEAVED L/R) СО СТЕРЕО-ЛИНКИНГОМ
        // ====================================================================
        // Стерео-линкинг детекторов предотвращает смещение стереопанорамы
        for (size_t i = 0; i < numFrames; ++i) {
            const size_t idx = i * 2;
            const float xL = input[idx + 0];
            const float xR = input[idx + 1];

            const float absL = std::fabs(xL);
            const float absR = std::fabs(xR);
            const float linkedAbs = std::max(absL, absR);

            // Быстрый детектор
            if (linkedAbs > envFastL_) {
                envFastL_ = fastAttackCoeff_ * envFastL_ + (1.0f - fastAttackCoeff_) * linkedAbs;
            } else {
                envFastL_ = fastReleaseCoeff_ * envFastL_ + (1.0f - fastReleaseCoeff_) * linkedAbs;
            }

            // Медленный детектор
            if (linkedAbs > envSlowL_) {
                envSlowL_ = slowAttackCoeff_ * envSlowL_ + (1.0f - slowAttackCoeff_) * linkedAbs;
            } else {
                envSlowL_ = slowReleaseCoeff_ * envSlowL_ + (1.0f - slowReleaseCoeff_) * linkedAbs;
            }

            const float transient = std::max(0.0f, envFastL_ - envSlowL_);
            const float sustain = envSlowL_;

            if (transient > maxTransient) maxTransient = transient;
            if (sustain > maxSustain) maxSustain = sustain;

            const float origEnvelope = envFastL_ + 1e-6f;
            const float modifiedEnvelope = (transient * attGain) + (sustain * susGain);
            const float totalGain = (modifiedEnvelope / origEnvelope) * outGain;

            float yL = xL * totalGain;
            float yR = xR * totalGain;

            if (softClip) {
                if (std::fabs(yL) > 0.85f) yL = std::tanh(yL);
                if (std::fabs(yR) > 0.85f) yR = std::tanh(yR);
            }

            output[idx + 0] = yL;
            output[idx + 1] = yR;
        }
    }

    currentTransient_ = maxTransient;
    currentSustain_ = maxSustain;
}

} // namespace DAWCore
