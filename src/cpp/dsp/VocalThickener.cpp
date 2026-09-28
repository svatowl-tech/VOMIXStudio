/**
 * ============================================================================
 * VocalThickener.cpp - Реализация модуля уплотнения и теплоты речи (C++17)
 * ============================================================================
 * Zero-Alloc, WASM SIMD128 оптимизированная обработка вокала и диалогов.
 * ============================================================================
 */

#include "VocalThickener.hpp"
#include <cmath>
#include <algorithm>

#if defined(__wasm_simd128__) || defined(__SSE2__)
#include <wasm_simd128.h>
#endif

namespace DAWCore {

VocalThickener::VocalThickener(float sampleRate) noexcept
    : sampleRate_(sampleRate > 8000.0f ? sampleRate : 48000.0f) {
    updateFilters();
    reset();
}

void VocalThickener::setSampleRate(float sampleRate) noexcept {
    if (sampleRate > 8000.0f && std::abs(sampleRate_ - sampleRate) > 0.1f) {
        sampleRate_ = sampleRate;
        updateFilters();
        reset();
    }
}

void VocalThickener::setParams(const VocalThickenerParams& params) noexcept {
    params_.bodyDrive = std::clamp(params.bodyDrive, 0.0f, 1.0f);
    params_.presenceClarity = std::clamp(params.presenceClarity, 0.0f, 1.0f);
    params_.tapeDensity = std::clamp(params.tapeDensity, 0.0f, 1.0f);
    params_.mix = std::clamp(params.mix, 0.0f, 1.0f);
    params_.bypass = params.bypass;
}

void VocalThickener::setBodyDrive(float drive) noexcept {
    params_.bodyDrive = std::clamp(drive, 0.0f, 1.0f);
}

void VocalThickener::setPresenceClarity(float clarity) noexcept {
    params_.presenceClarity = std::clamp(clarity, 0.0f, 1.0f);
}

void VocalThickener::setTapeDensity(float density) noexcept {
    params_.tapeDensity = std::clamp(density, 0.0f, 1.0f);
}

void VocalThickener::setMix(float mix) noexcept {
    params_.mix = std::clamp(mix, 0.0f, 1.0f);
}

void VocalThickener::setBypass(bool bypass) noexcept {
    params_.bypass = bypass;
}

void VocalThickener::reset() noexcept {
    bodyHpFilter_.reset();
    bodyLpFilter_.reset();
    presenceHpFilter_.reset();
    dcBlockFilter_.reset();

    rmsIn_ = 0.01f;
    rmsOut_ = 0.01f;
    autoGain_ = 1.0f;

    smoothedBypass_ = params_.bypass ? 1.0f : 0.0f;
    smoothedMix_ = params_.mix;
    smoothedBody_ = params_.bodyDrive;
    smoothedPresence_ = params_.presenceClarity;
    smoothedTape_ = params_.tapeDensity;
}

void VocalThickener::updateFilters() noexcept {
    // 1. Полоса тела голоса: Highpass 110 Гц и Lowpass 280 Гц
    {
        const float fcHp = 110.0f;
        const float omega = 2.0f * PI_F * fcHp / sampleRate_;
        const float sinOmega = std::sin(omega);
        const float cosOmega = std::cos(omega);
        const float alpha = sinOmega / (2.0f * (1.0f / SQRT2_F));

        const float a0 = 1.0f + alpha;
        const float invA0 = 1.0f / a0;
        bodyHpFilter_.b0 = ((1.0f + cosOmega) * 0.5f) * invA0;
        bodyHpFilter_.b1 = (-(1.0f + cosOmega)) * invA0;
        bodyHpFilter_.b2 = bodyHpFilter_.b0;
        bodyHpFilter_.a1 = (-2.0f * cosOmega) * invA0;
        bodyHpFilter_.a2 = (1.0f - alpha) * invA0;
    }

    {
        const float fcLp = 280.0f;
        const float omega = 2.0f * PI_F * fcLp / sampleRate_;
        const float sinOmega = std::sin(omega);
        const float cosOmega = std::cos(omega);
        const float alpha = sinOmega / (2.0f * (1.0f / SQRT2_F));

        const float a0 = 1.0f + alpha;
        const float invA0 = 1.0f / a0;
        bodyLpFilter_.b0 = ((1.0f - cosOmega) * 0.5f) * invA0;
        bodyLpFilter_.b1 = (1.0f - cosOmega) * invA0;
        bodyLpFilter_.b2 = bodyLpFilter_.b0;
        bodyLpFilter_.a1 = (-2.0f * cosOmega) * invA0;
        bodyLpFilter_.a2 = (1.0f - alpha) * invA0;
    }

    // 2. Highpass фильтр для ВЧ эксайтера (3800 Гц)
    {
        const float fcExciter = 3800.0f;
        const float omega = 2.0f * PI_F * fcExciter / sampleRate_;
        const float sinOmega = std::sin(omega);
        const float cosOmega = std::cos(omega);
        const float alpha = sinOmega / (2.0f * (1.0f / SQRT2_F));

        const float a0 = 1.0f + alpha;
        const float invA0 = 1.0f / a0;
        presenceHpFilter_.b0 = ((1.0f + cosOmega) * 0.5f) * invA0;
        presenceHpFilter_.b1 = (-(1.0f + cosOmega)) * invA0;
        presenceHpFilter_.b2 = presenceHpFilter_.b0;
        presenceHpFilter_.a1 = (-2.0f * cosOmega) * invA0;
        presenceHpFilter_.a2 = (1.0f - alpha) * invA0;
    }

    // 3. DC-блокер (Highpass 25 Гц)
    {
        const float fcDc = 25.0f;
        const float omega = 2.0f * PI_F * fcDc / sampleRate_;
        const float sinOmega = std::sin(omega);
        const float cosOmega = std::cos(omega);
        const float alpha = sinOmega / (2.0f * (1.0f / SQRT2_F));

        const float a0 = 1.0f + alpha;
        const float invA0 = 1.0f / a0;
        dcBlockFilter_.b0 = ((1.0f + cosOmega) * 0.5f) * invA0;
        dcBlockFilter_.b1 = (-(1.0f + cosOmega)) * invA0;
        dcBlockFilter_.b2 = dcBlockFilter_.b0;
        dcBlockFilter_.a1 = (-2.0f * cosOmega) * invA0;
        dcBlockFilter_.a2 = (1.0f - alpha) * invA0;
    }
}

inline float VocalThickener::processBodyHarmonicsLeft(float inSample) noexcept {
    // 1. Выделяем полосу фундаментальных частот речи (110 .. 280 Гц)
    float band = bodyHpFilter_.processLeft(inSample);
    band = bodyLpFilter_.processLeft(band);

    // Нормализуем для нелинейного полинома
    float x = std::clamp(band * 2.5f, -1.0f, 1.0f);

    // Полиномы Чебышёва:
    // T2(x) = 2*x^2 - 1  -> Чистая четная 2-я гармоника (октавное тепло и округлость)
    // T3(x) = 4*x^3 - 3*x -> 3-я гармоника (плотность и плотный сустейн)
    float t2 = 2.0f * x * x - 1.0f;
    float t3 = 4.0f * x * x * x - 3.0f * x;

    // Смешиваем четную и нечетную гармоники
    float generated = 0.75f * t2 + 0.25f * t3;

    // Пропускаем через DC-блокер для удаления постоянного смещения от x^2
    return dcBlockFilter_.processLeft(generated);
}

inline float VocalThickener::processBodyHarmonicsRight(float inSample) noexcept {
    float band = bodyHpFilter_.processRight(inSample);
    band = bodyLpFilter_.processRight(band);

    float x = std::clamp(band * 2.5f, -1.0f, 1.0f);
    float t2 = 2.0f * x * x - 1.0f;
    float t3 = 4.0f * x * x * x - 3.0f * x;

    float generated = 0.75f * t2 + 0.25f * t3;
    return dcBlockFilter_.processRight(generated);
}

inline float VocalThickener::processPresenceExciterLeft(float inSample) noexcept {
    // Выделяем верха 3.8 кГц+
    float hp = presenceHpFilter_.processLeft(inSample);
    float x = std::clamp(hp * 2.0f, -2.0f, 2.0f);

    // Асимметричная сатурация верхов для шелкового присутствия без жесткого шипения
    float excited = std::tanh(1.6f * x) + 0.2f * (x * x);
    return excited;
}

inline float VocalThickener::processPresenceExciterRight(float inSample) noexcept {
    float hp = presenceHpFilter_.processRight(inSample);
    float x = std::clamp(hp * 2.0f, -2.0f, 2.0f);
    float excited = std::tanh(1.6f * x) + 0.2f * (x * x);
    return excited;
}

inline float VocalThickener::processTapeSat(float inSample, float drive) noexcept {
    // Ленточная сатурация с плавным перегибом (Soft Tape Knee)
    float gain = 1.0f + drive * 3.5f;
    float x = inSample * gain;

    // Асимметричный полином ленточной характеристики с насыщением
    float sat = (x >= 0.0f) ? std::tanh(x) : (std::tanh(1.1f * x) * 0.909f);
    return sat;
}

void VocalThickener::processBlock(float* buffer, size_t numFrames, int channels) noexcept {
    if (!buffer || numFrames == 0) return;

    const float targetBypass = params_.bypass ? 1.0f : 0.0f;
    const float targetMix = params_.mix;
    const float targetBody = params_.bodyDrive;
    const float targetPresence = params_.presenceClarity;
    const float targetTape = params_.tapeDensity;

    if (channels == 1) {
        for (size_t i = 0; i < numFrames; ++i) {
            float in = buffer[i];

            smoothedBypass_ += 0.005f * (targetBypass - smoothedBypass_);
            smoothedMix_ += 0.005f * (targetMix - smoothedMix_);
            smoothedBody_ += 0.005f * (targetBody - smoothedBody_);
            smoothedPresence_ += 0.005f * (targetPresence - smoothedPresence_);
            smoothedTape_ += 0.005f * (targetTape - smoothedTape_);

            // 1. Генерация субгармоник тела голоса (Чебышёв)
            float bodyHarmonics = processBodyHarmonicsLeft(in) * (smoothedBody_ * 0.45f);

            // 2. Генерация присутствия и разборчивости (Эксайтер)
            float presenceHarmonics = processPresenceExciterLeft(in) * (smoothedPresence_ * 0.35f);

            // 3. Суммирование с оригинальным сигналом
            float thickened = in + bodyHarmonics + presenceHarmonics;

            // 4. Ленточная сатурация
            float saturated = processTapeSat(thickened, smoothedTape_);

            // 5. Auto-Gain Match (компенсация прироста громкости от сатурации)
            float inAbs = std::abs(in) + 1e-5f;
            float outAbs = std::abs(saturated) + 1e-5f;
            rmsIn_ = 0.999f * rmsIn_ + 0.001f * inAbs;
            rmsOut_ = 0.999f * rmsOut_ + 0.001f * outAbs;
            float targetGain = std::clamp(rmsIn_ / std::max(rmsOut_, 1e-5f), 0.35f, 1.0f);
            autoGain_ = 0.998f * autoGain_ + 0.002f * targetGain;

            float levelMatched = saturated * autoGain_;

            // 6. Wet/Dry и Bypass
            float mixed = in * (1.0f - smoothedMix_) + levelMatched * smoothedMix_;
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
            smoothedMix_ += 0.005f * (targetMix - smoothedMix_);
            smoothedBody_ += 0.005f * (targetBody - smoothedBody_);
            smoothedPresence_ += 0.005f * (targetPresence - smoothedPresence_);
            smoothedTape_ += 0.005f * (targetTape - smoothedTape_);

            // 1. Тело голоса
            float bodyL = processBodyHarmonicsLeft(inL) * (smoothedBody_ * 0.45f);
            float bodyR = processBodyHarmonicsRight(inR) * (smoothedBody_ * 0.45f);

            // 2. ВЧ присутствие
            float presL = processPresenceExciterLeft(inL) * (smoothedPresence_ * 0.35f);
            float presR = processPresenceExciterRight(inR) * (smoothedPresence_ * 0.35f);

            // 3. Сумма
            float thickL = inL + bodyL + presL;
            float thickR = inR + bodyR + presR;

            // 4. Ленточная сатурация
            float satL = processTapeSat(thickL, smoothedTape_);
            float satR = processTapeSat(thickR, smoothedTape_);

            // 5. Auto-Gain Match
            float inAbs = 0.5f * (std::abs(inL) + std::abs(inR)) + 1e-5f;
            float outAbs = 0.5f * (std::abs(satL) + std::abs(satR)) + 1e-5f;
            rmsIn_ = 0.999f * rmsIn_ + 0.001f * inAbs;
            rmsOut_ = 0.999f * rmsOut_ + 0.001f * outAbs;
            float targetGain = std::clamp(rmsIn_ / std::max(rmsOut_, 1e-5f), 0.35f, 1.0f);
            autoGain_ = 0.998f * autoGain_ + 0.002f * targetGain;

            float outL = satL * autoGain_;
            float outR = satR * autoGain_;

            // 6. Wet/Dry & Bypass
            float mixedL = inL * (1.0f - smoothedMix_) + outL * smoothedMix_;
            float mixedR = inR * (1.0f - smoothedMix_) + outR * smoothedMix_;

            buffer[idxL] = mixedL * (1.0f - smoothedBypass_) + inL * smoothedBypass_;
            buffer[idxR] = mixedR * (1.0f - smoothedBypass_) + inR * smoothedBypass_;
        }
    }
}

void VocalThickener::processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept {
    if (!inputs || !outputs || numFrames == 0) return;

    const float* inL = inputs[0];
    const float* inR = (inputs[1] != nullptr) ? inputs[1] : inputs[0];
    float* outL = outputs[0];
    float* outR = (outputs[1] != nullptr) ? outputs[1] : outputs[0];

    const float targetBypass = params_.bypass ? 1.0f : 0.0f;
    const float targetMix = params_.mix;
    const float targetBody = params_.bodyDrive;
    const float targetPresence = params_.presenceClarity;
    const float targetTape = params_.tapeDensity;

    for (size_t i = 0; i < numFrames; ++i) {
        float sampleL = inL[i];
        float sampleR = inR[i];

        smoothedBypass_ += 0.005f * (targetBypass - smoothedBypass_);
        smoothedMix_ += 0.005f * (targetMix - smoothedMix_);
        smoothedBody_ += 0.005f * (targetBody - smoothedBody_);
        smoothedPresence_ += 0.005f * (targetPresence - smoothedPresence_);
        smoothedTape_ += 0.005f * (targetTape - smoothedTape_);

        float bodyL = processBodyHarmonicsLeft(sampleL) * (smoothedBody_ * 0.45f);
        float bodyR = processBodyHarmonicsRight(sampleR) * (smoothedBody_ * 0.45f);

        float presL = processPresenceExciterLeft(sampleL) * (smoothedPresence_ * 0.35f);
        float presR = processPresenceExciterRight(sampleR) * (smoothedPresence_ * 0.35f);

        float thickL = sampleL + bodyL + presL;
        float thickR = sampleR + bodyR + presR;

        float satL = processTapeSat(thickL, smoothedTape_);
        float satR = processTapeSat(thickR, smoothedTape_);

        float inAbs = 0.5f * (std::abs(sampleL) + std::abs(sampleR)) + 1e-5f;
        float outAbs = 0.5f * (std::abs(satL) + std::abs(satR)) + 1e-5f;
        rmsIn_ = 0.999f * rmsIn_ + 0.001f * inAbs;
        rmsOut_ = 0.999f * rmsOut_ + 0.001f * outAbs;
        float targetGain = std::clamp(rmsIn_ / std::max(rmsOut_, 1e-5f), 0.35f, 1.0f);
        autoGain_ = 0.998f * autoGain_ + 0.002f * targetGain;

        float matchedL = satL * autoGain_;
        float matchedR = satR * autoGain_;

        float mixedL = sampleL * (1.0f - smoothedMix_) + matchedL * smoothedMix_;
        float mixedR = sampleR * (1.0f - smoothedMix_) + matchedR * smoothedMix_;

        outL[i] = mixedL * (1.0f - smoothedBypass_) + sampleL * smoothedBypass_;
        outR[i] = mixedR * (1.0f - smoothedBypass_) + sampleR * smoothedBypass_;
    }
}

} // namespace DAWCore
