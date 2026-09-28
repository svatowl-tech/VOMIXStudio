/**
 * ============================================================================
 * DeEsserPro.cpp - Реализация профессионального де-эссера
 * ============================================================================
 */

#include "DeEsserPro.hpp"
#include <algorithm>
#include <cmath>

namespace DAWCore {

DeEsserPro::DeEsserPro(float sampleRate) noexcept {
    setSampleRate(sampleRate);
}

void DeEsserPro::setSampleRate(float sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;
    updateFilters();
    reset();
}

void DeEsserPro::setParams(const DeEsserProParams& params) noexcept {
    params_ = params;
    updateFilters();
}

void DeEsserPro::reset() noexcept {
    bpState_.reset();
    detectorEnvelope_ = 0.0f;
    currentGainReductionLinear_ = 1.0f;
    currentGainReductionDb_ = 0.0f;
}

void DeEsserPro::updateFilters() noexcept {
    // 1. Полосовой фильтр (Band-Pass Biquad с Q=2.0)
    const double nyquist = 0.485 * static_cast<double>(sampleRate_);
    const double fc = std::max(2000.0, std::min(nyquist, static_cast<double>(params_.frequency)));
    constexpr double Q = 2.0;

    const double w0 = (TWO_PI_F * fc) / static_cast<double>(sampleRate_);
    const double cosW = std::cos(w0);
    const double sinW = std::sin(w0);
    const double alpha = sinW / (2.0 * Q);

    const double b0 = alpha;
    const double b1 = 0.0;
    const double b2 = -alpha;
    const double a0 = 1.0 + alpha;
    const double a1 = -2.0 * cosW;
    const double a2 = 1.0 - alpha;

    const double invA0 = 1.0 / a0;
    bpCoeffs_.b0 = static_cast<float>(b0 * invA0);
    bpCoeffs_.b1 = static_cast<float>(b1 * invA0);
    bpCoeffs_.b2 = static_cast<float>(b2 * invA0);
    bpCoeffs_.a1 = static_cast<float>(a1 * invA0);
    bpCoeffs_.a2 = static_cast<float>(a2 * invA0);

    // 2. Баллистика
    const float attSec = std::max(0.0002f, params_.attackMs * 0.001f);
    const float relSec = std::max(0.005f, params_.releaseMs * 0.001f);

    attackCoeff_ = 1.0f - std::exp(-1.0f / (attSec * sampleRate_));
    releaseCoeff_ = 1.0f - std::exp(-1.0f / (relSec * sampleRate_));
}

void DeEsserPro::processBlock(float* buffer, size_t numFrames, int channels) noexcept {
    if (!buffer || numFrames == 0 || channels <= 0) return;

    if (!params_.enabled) return;

    const bool isStereo = (channels > 1);
    const float threshDb = params_.thresholdDb;
    const float ratio = std::max(1.0f, params_.ratio);
    const float maxReduction = std::min(-1.0f, params_.maxReductionDb);
    const bool split = params_.splitBand;
    const bool listen = params_.listenMode;

    const float b0 = bpCoeffs_.b0, b1 = bpCoeffs_.b1, b2 = bpCoeffs_.b2;
    const float a1 = bpCoeffs_.a1, a2 = bpCoeffs_.a2;

    for (size_t i = 0; i < numFrames; ++i) {
        float xL = 0.0f;
        float xR = 0.0f;
        float monoX = 0.0f;

        if (isStereo) {
            const size_t idx = i * 2;
            xL = buffer[idx + 0];
            xR = buffer[idx + 1];
            monoX = (xL + xR) * 0.5f;
        } else {
            xL = buffer[i];
            monoX = xL;
        }

        // 1. Фильтрация сайдчейна сибилянтов через BPF (TDF-II)
        const float sibilantL = b0 * xL + bpState_.s1L;
        bpState_.s1L = b1 * xL - a1 * sibilantL + bpState_.s2L;
        bpState_.s2L = b2 * xL - a2 * sibilantL;

        float sibilantR = 0.0f;
        if (isStereo) {
            sibilantR = b0 * xR + bpState_.s1R;
            bpState_.s1R = b1 * xR - a1 * sibilantR + bpState_.s2R;
            bpState_.s2R = b2 * xR - a2 * sibilantR;
        }

        const float sibilantMono = isStereo ? (sibilantL + sibilantR) * 0.5f : sibilantL;

        // 2. Детектор огибающей мощности сибилянта
        const float absSib = std::fabs(sibilantMono);
        if (absSib > detectorEnvelope_) {
            detectorEnvelope_ += (absSib - detectorEnvelope_) * attackCoeff_;
        } else {
            detectorEnvelope_ += (absSib - detectorEnvelope_) * releaseCoeff_;
        }

        const float envDb = gainToDb(std::max(1e-6f, detectorEnvelope_));

        // 3. Расчет редукции усиления
        float targetGainLinear = 1.0f;
        if (envDb > threshDb) {
            const float excessDb = envDb - threshDb;
            const float grDb = -excessDb * (1.0f - (1.0f / ratio));
            const float clampedGrDb = std::max(maxReduction, grDb);
            targetGainLinear = dbToGain(clampedGrDb);
        }

        // Сглаживание гейна
        if (targetGainLinear < currentGainReductionLinear_) {
            currentGainReductionLinear_ += (targetGainLinear - currentGainReductionLinear_) * attackCoeff_;
        } else {
            currentGainReductionLinear_ += (targetGainLinear - currentGainReductionLinear_) * releaseCoeff_;
        }

        const float gr = currentGainReductionLinear_;

        // 4. Применение редукции
        if (listen) {
            // Режим прослушивания только вырезаемой полосы сибилянтов
            if (isStereo) {
                buffer[i * 2 + 0] = sibilantL * (1.0f - gr);
                buffer[i * 2 + 1] = sibilantR * (1.0f - gr);
            } else {
                buffer[i] = sibilantL * (1.0f - gr);
            }
        } else if (split) {
            // Раздельно-полосный режим: подавляем только полосу сибилянтов
            if (isStereo) {
                buffer[i * 2 + 0] = (xL - sibilantL) + sibilantL * gr;
                buffer[i * 2 + 1] = (xR - sibilantR) + sibilantR * gr;
            } else {
                buffer[i] = (xL - sibilantL) + sibilantL * gr;
            }
        } else {
            // Широкополосный режим: подавляем весь сигнал на момент сибилянта
            if (isStereo) {
                buffer[i * 2 + 0] = xL * gr;
                buffer[i * 2 + 1] = xR * gr;
            } else {
                buffer[i] = xL * gr;
            }
        }
    }

    currentGainReductionDb_ = gainToDb(std::max(1e-5f, currentGainReductionLinear_));
}

void DeEsserPro::processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept {
    if (!inputs || !outputs || numFrames == 0) return;

    const float* inL = inputs[0];
    const float* inR = inputs[1] ? inputs[1] : inputs[0];
    float* outL = outputs[0];
    float* outR = outputs[1] ? outputs[1] : outputs[0];

    if (!params_.enabled) {
        if (inL != outL) std::copy(inL, inL + numFrames, outL);
        if (inR != outR) std::copy(inR, inR + numFrames, outR);
        return;
    }

    const float threshDb = params_.thresholdDb;
    const float ratio = std::max(1.0f, params_.ratio);
    const float maxReduction = std::min(-1.0f, params_.maxReductionDb);
    const bool split = params_.splitBand;
    const bool listen = params_.listenMode;

    const float b0 = bpCoeffs_.b0, b1 = bpCoeffs_.b1, b2 = bpCoeffs_.b2;
    const float a1 = bpCoeffs_.a1, a2 = bpCoeffs_.a2;

    for (size_t i = 0; i < numFrames; ++i) {
        float xL = inL[i];
        float xR = inR[i];

        // 1. Полосовая фильтрация
        float sibilantL = b0 * xL + bpState_.s1L;
        bpState_.s1L = b1 * xL - a1 * sibilantL + bpState_.s2L;
        bpState_.s2L = b2 * xL - a2 * sibilantL;

        float sibilantR = b0 * xR + bpState_.s1R;
        bpState_.s1R = b1 * xR - a1 * sibilantR + bpState_.s2R;
        bpState_.s2R = b2 * xR - a2 * sibilantR;

        const float sibilantMono = (sibilantL + sibilantR) * 0.5f;

        // 2. Детектор огибающей мощности сибилянта
        const float absSib = std::fabs(sibilantMono);
        if (absSib > detectorEnvelope_) {
            detectorEnvelope_ += (absSib - detectorEnvelope_) * attackCoeff_;
        } else {
            detectorEnvelope_ += (absSib - detectorEnvelope_) * releaseCoeff_;
        }

        const float envDb = gainToDb(std::max(1e-6f, detectorEnvelope_));

        // 3. Расчет редукции
        float targetGainLinear = 1.0f;
        if (envDb > threshDb) {
            const float excessDb = envDb - threshDb;
            const float grDb = -excessDb * (1.0f - (1.0f / ratio));
            const float clampedGrDb = std::max(maxReduction, grDb);
            targetGainLinear = dbToGain(clampedGrDb);
        }

        if (targetGainLinear < currentGainReductionLinear_) {
            currentGainReductionLinear_ += (targetGainLinear - currentGainReductionLinear_) * attackCoeff_;
        } else {
            currentGainReductionLinear_ += (targetGainLinear - currentGainReductionLinear_) * releaseCoeff_;
        }

        const float gr = currentGainReductionLinear_;

        // 4. Применение редукции
        if (listen) {
            outL[i] = sibilantL * (1.0f - gr);
            outR[i] = sibilantR * (1.0f - gr);
        } else if (split) {
            outL[i] = (xL - sibilantL) + sibilantL * gr;
            outR[i] = (xR - sibilantR) + sibilantR * gr;
        } else {
            outL[i] = xL * gr;
            outR[i] = xR * gr;
        }
    }

    currentGainReductionDb_ = gainToDb(std::max(1e-5f, currentGainReductionLinear_));
}

} // namespace DAWCore
