/**
 * ============================================================================
 * TapeSaturation.cpp - Реализация аналоговой пленочной сатурации (C++17)
 * ============================================================================
 * Математическое моделирование гистерезиса намагничивания ленты,
 * резонанса воспроизводящей головки (Head Bump) и затухания ВЧ (Gap Loss).
 * ============================================================================
 */

#include "TapeSaturation.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

TapeSaturation::TapeSaturation(float sampleRate) noexcept {
    setSampleRate(sampleRate);
}

void TapeSaturation::setSampleRate(float sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;

    // DC Blocker на частоту среза ~ 5 Гц
    dcBlockCoeff_ = 1.0f - (TWO_PI_F * 5.0f / sampleRate_);
    if (dcBlockCoeff_ < 0.99f) dcBlockCoeff_ = 0.99f;
    if (dcBlockCoeff_ > 0.9999f) dcBlockCoeff_ = 0.9999f;

    updateFilters();
    reset();
}

void TapeSaturation::setParams(const TapeParams& params) noexcept {
    params_ = params;
    updateFilters();
}

void TapeSaturation::reset() noexcept {
    headBumpState_.reset();
    gapLossStateL_ = 0.0f;
    gapLossStateR_ = 0.0f;

    dcBlockerX_L_ = 0.0f;
    dcBlockerY_L_ = 0.0f;
    dcBlockerX_R_ = 0.0f;
    dcBlockerY_R_ = 0.0f;
}

void TapeSaturation::updateFilters() noexcept {
    inputDriveLinear_ = dbToGain(params_.driveDb);
    outputGainLinear_ = dbToGain(params_.outputGainDb);

    // Автоматическая компенсация громкости драйва:
    // Позволяет крутить перегруз без резкого скачка воспринимаемой громкости
    if (params_.autoGain) {
        autoMakeupLinear_ = 1.0f / std::sqrt(1.0f + 0.45f * inputDriveLinear_);
    } else {
        autoMakeupLinear_ = 1.0f;
    }

    // 1. Расчет биквадрата Head Bump (контурный басовый горб магнитофона на ~ 65 Гц)
    const float headBumpGainDb = params_.lowFreqColor * 4.5f; // 0.0 .. +4.5 дБ
    if (std::fabs(headBumpGainDb) < 0.05f) {
        headBumpCoeffs_ = TapeBiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };
    } else {
        constexpr double f0 = 65.0;
        constexpr double Q = 1.2;
        const double A = std::pow(10.0, static_cast<double>(headBumpGainDb) / 40.0);
        const double w0 = (2.0 * PI_F * f0) / static_cast<double>(sampleRate_);
        const double cosW = std::cos(w0);
        const double sinW = std::sin(w0);
        const double alpha = sinW / (2.0 * Q);

        const double b0 = 1.0 + alpha * A;
        const double b1 = -2.0 * cosW;
        const double b2 = 1.0 - alpha * A;
        const double a0 = 1.0 + alpha / A;
        const double a1 = -2.0 * cosW;
        const double a2 = 1.0 - alpha / A;

        const double invA0 = 1.0 / a0;
        headBumpCoeffs_.b0 = static_cast<float>(b0 * invA0);
        headBumpCoeffs_.b1 = static_cast<float>(b1 * invA0);
        headBumpCoeffs_.b2 = static_cast<float>(b2 * invA0);
        headBumpCoeffs_.a1 = static_cast<float>(a1 * invA0);
        headBumpCoeffs_.a2 = static_cast<float>(a2 * invA0);
    }

    // 2. 1-полюсный сглаживающий фильтр Gap Loss (потери на зазор магнитной головки)
    // Варьирует срез от 22 кГц до 13.5 кГц
    const float cutoffHz = 22000.0f - (params_.highFreqRolloff * 8500.0f);
    const float w = TWO_PI_F * std::min(sampleRate_ * 0.48f, cutoffHz) / sampleRate_;
    gapLossCoeff_ = 1.0f - std::exp(-w);
}

void TapeSaturation::processBlock(float* samples, size_t numFrames, int channels) noexcept {
    processBlock(samples, samples, numFrames, channels);
}

void TapeSaturation::processBlock(
    const float* input,
    float* output,
    size_t numFrames,
    int channels
) noexcept {
    if (!input || !output || numFrames == 0 || channels <= 0) return;

    if (!params_.enabled) {
        if (input != output) {
            std::copy(input, input + (numFrames * static_cast<size_t>(channels)), output);
        }
        return;
    }

    const float drive = inputDriveLinear_;
    const float bias = params_.bias;
    const float wet = params_.saturationMix;
    const float dry = 1.0f - wet;
    const float outGain = outputGainLinear_ * autoMakeupLinear_;

    const float hb_b0 = headBumpCoeffs_.b0;
    const float hb_b1 = headBumpCoeffs_.b1;
    const float hb_b2 = headBumpCoeffs_.b2;
    const float hb_a1 = headBumpCoeffs_.a1;
    const float hb_a2 = headBumpCoeffs_.a2;

    const float gapAlpha = gapLossCoeff_;
    const float dcAlpha = dcBlockCoeff_;

    if (channels == 1) {
        // ====================================================================
        // МОНО КАНАЛ
        // ====================================================================
        float hb_s1 = headBumpState_.s1L;
        float hb_s2 = headBumpState_.s2L;
        float gapState = gapLossStateL_;
        float dcX = dcBlockerX_L_;
        float dcY = dcBlockerY_L_;

        for (size_t i = 0; i < numFrames; ++i) {
            const float x = input[i];

            // 1. Контурный бас (Head Bump Biquad)
            const float xBumped = hb_b0 * x + hb_s1;
            hb_s1 = hb_b1 * x - hb_a1 * xBumped + hb_s2;
            hb_s2 = hb_b2 * x - hb_a2 * xBumped;

            // 2. Входное перегружение драйвом
            const float xDriven = xBumped * drive;

            // 3. Нелинейная пленочная сатурация с асимметричным подмагничиванием
            const float sat = saturateTape(xDriven, bias);

            // 4. Потери на зазор головки (Gap Loss 1-Pole Lowpass)
            gapState += gapAlpha * (sat - gapState);

            // 5. DC-Blocker для устранения постоянной составляющей
            const float dcOut = gapState - dcX + dcAlpha * dcY;
            dcX = gapState;
            dcY = dcOut;

            // 6. Выходное масштабирование и Dry/Wet микс
            const float wetSignal = dcOut * outGain;
            output[i] = dry * x + wet * wetSignal;
        }

        headBumpState_.s1L = hb_s1;
        headBumpState_.s2L = hb_s2;
        gapLossStateL_ = gapState;
        dcBlockerX_L_ = dcX;
        dcBlockerY_L_ = dcY;
    } else {
        // ====================================================================
        // СТЕРЕО КАНАЛ (INTERLEAVED)
        // ====================================================================
        float hb_s1L = headBumpState_.s1L;
        float hb_s2L = headBumpState_.s2L;
        float hb_s1R = headBumpState_.s1R;
        float hb_s2R = headBumpState_.s2R;

        float gapL = gapLossStateL_;
        float gapR = gapLossStateR_;

        float dcXL = dcBlockerX_L_;
        float dcYL = dcBlockerY_L_;
        float dcXR = dcBlockerX_R_;
        float dcYR = dcBlockerY_R_;

        for (size_t i = 0; i < numFrames; ++i) {
            const size_t idx = i * 2;
            const float xL = input[idx + 0];
            const float xR = input[idx + 1];

            // 1. Head Bump L/R
            const float xBumpL = hb_b0 * xL + hb_s1L;
            hb_s1L = hb_b1 * xL - hb_a1 * xBumpL + hb_s2L;
            hb_s2L = hb_b2 * xL - hb_a2 * xBumpL;

            const float xBumpR = hb_b0 * xR + hb_s1R;
            hb_s1R = hb_b1 * xR - hb_a1 * xBumpR + hb_s2R;
            hb_s2R = hb_b2 * xR - hb_a2 * xBumpR;

            // 2. Драйв
            const float xDrivenL = xBumpL * drive;
            const float xDrivenR = xBumpR * drive;

            // 3. Сатурация
            const float satL = saturateTape(xDrivenL, bias);
            const float satR = saturateTape(xDrivenR, bias);

            // 4. Gap Loss
            gapL += gapAlpha * (satL - gapL);
            gapR += gapAlpha * (satR - gapR);

            // 5. DC-Blocker
            const float dcOutL = gapL - dcXL + dcAlpha * dcYL;
            dcXL = gapL;
            dcYL = dcOutL;

            const float dcOutR = gapR - dcXR + dcAlpha * dcYR;
            dcXR = gapR;
            dcYR = dcOutR;

            // 6. Выходной микс
            output[idx + 0] = dry * xL + wet * (dcOutL * outGain);
            output[idx + 1] = dry * xR + wet * (dcOutR * outGain);
        }

        headBumpState_.s1L = hb_s1L;
        headBumpState_.s2L = hb_s2L;
        headBumpState_.s1R = hb_s1R;
        headBumpState_.s2R = hb_s2R;

        gapLossStateL_ = gapL;
        gapLossStateR_ = gapR;

        dcBlockerX_L_ = dcXL;
        dcBlockerY_L_ = dcYL;
        dcBlockerX_R_ = dcXR;
        dcBlockerY_R_ = dcYR;
    }
}

} // namespace DAWCore
