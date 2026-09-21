/**
 * ============================================================================
 * BiquadFilter.cpp - Реализация каскадов БИХ-фильтров (Audio EQ Cookbook)
 * ============================================================================
 */

#include "BiquadFilter.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

BiquadFilter::BiquadFilter() noexcept {
    resetState();
    updateCoefficients();
}

void BiquadFilter::resetState() noexcept {
    x1L = x2L = y1L = y2L = 0.0f;
    x1R = x2R = y1R = y2R = 0.0f;
}

void BiquadFilter::updateCoefficients() noexcept {
    if (sampleRate <= 0.0f) return;

    // Ограничение частоты ниже Найквиста
    float nyquist = sampleRate * 0.499f;
    float safeFreq = clampFloat(frequency, 10.0f, nyquist);
    float safeQ = std::max(Q, 0.001f);

    float A = std::pow(10.0f, gainDb / 40.0f);
    float omega = TWO_PI_F * safeFreq / sampleRate;
    float sn = std::sin(omega);
    float cs = std::cos(omega);
    float alpha = sn / (2.0f * safeQ);
    float beta = std::sqrt(A) / safeQ;

    float rawB0 = 1.0f, rawB1 = 0.0f, rawB2 = 0.0f;
    float a0 = 1.0f, rawA1 = 0.0f, rawA2 = 0.0f;

    switch (type) {
        case BiquadFilterType::LowShelf: {
            rawB0 = A * ((A + 1.0f) - (A - 1.0f) * cs + beta * sn);
            rawB1 = 2.0f * A * ((A - 1.0f) - (A + 1.0f) * cs);
            rawB2 = A * ((A + 1.0f) - (A - 1.0f) * cs - beta * sn);
            a0    = (A + 1.0f) + (A - 1.0f) * cs + beta * sn;
            rawA1 = -2.0f * ((A - 1.0f) + (A + 1.0f) * cs);
            rawA2 = (A + 1.0f) + (A - 1.0f) * cs - beta * sn;
            break;
        }

        case BiquadFilterType::Peaking: {
            rawB0 = 1.0f + alpha * A;
            rawB1 = -2.0f * cs;
            rawB2 = 1.0f - alpha * A;
            a0    = 1.0f + alpha / A;
            rawA1 = -2.0f * cs;
            rawA2 = 1.0f - alpha / A;
            break;
        }

        case BiquadFilterType::HighShelf: {
            rawB0 = A * ((A + 1.0f) + (A - 1.0f) * cs + beta * sn);
            rawB1 = -2.0f * A * ((A - 1.0f) + (A + 1.0f) * cs);
            rawB2 = A * ((A + 1.0f) + (A - 1.0f) * cs - beta * sn);
            a0    = (A + 1.0f) - (A - 1.0f) * cs + beta * sn;
            rawA1 = 2.0f * ((A - 1.0f) - (A + 1.0f) * cs);
            rawA2 = (A + 1.0f) - (A - 1.0f) * cs - beta * sn;
            break;
        }

        case BiquadFilterType::HighPass: {
            rawB0 = (1.0f + cs) * 0.5f;
            rawB1 = -(1.0f + cs);
            rawB2 = (1.0f + cs) * 0.5f;
            a0    = 1.0f + alpha;
            rawA1 = -2.0f * cs;
            rawA2 = 1.0f - alpha;
            break;
        }

        case BiquadFilterType::LowPass: {
            rawB0 = (1.0f - cs) * 0.5f;
            rawB1 = 1.0f - cs;
            rawB2 = (1.0f - cs) * 0.5f;
            a0    = 1.0f + alpha;
            rawA1 = -2.0f * cs;
            rawA2 = 1.0f - alpha;
            break;
        }

        case BiquadFilterType::BandPass: {
            rawB0 = alpha;
            rawB1 = 0.0f;
            rawB2 = -alpha;
            a0    = 1.0f + alpha;
            rawA1 = -2.0f * cs;
            rawA2 = 1.0f - alpha;
            break;
        }
    }

    // Нормализация коэффициентов
    if (std::abs(a0) > 1e-9f) {
        float invA0 = 1.0f / a0;
        b0 = rawB0 * invA0;
        b1 = rawB1 * invA0;
        b2 = rawB2 * invA0;
        a1 = rawA1 * invA0;
        a2 = rawA2 * invA0;
    }
}

void BiquadFilter::processBuffer(float* interleavedBuffer, size_t numFrames) noexcept {
    if (!enabled || numFrames == 0 || !interleavedBuffer) return;

    // Оптимизация: если фильтр нейтрален (gainDb ~ 0 для Peaking/Shelving), пропускаем
    if ((type == BiquadFilterType::Peaking ||
         type == BiquadFilterType::LowShelf ||
         type == BiquadFilterType::HighShelf) && std::abs(gainDb) < 0.01f) {
        return;
    }

#if USE_WASM_SIMD
    // Векторизованная обработка: параллельный расчет левого и правого каналов в одном 128-битном SIMD регистре
    v128_t vB0 = wasm_f32x4_make(b0, b0, 0.0f, 0.0f);
    v128_t vB1 = wasm_f32x4_make(b1, b1, 0.0f, 0.0f);
    v128_t vB2 = wasm_f32x4_make(b2, b2, 0.0f, 0.0f);
    v128_t vA1 = wasm_f32x4_make(a1, a1, 0.0f, 0.0f);
    v128_t vA2 = wasm_f32x4_make(a2, a2, 0.0f, 0.0f);

    v128_t vX1 = wasm_f32x4_make(x1L, x1R, 0.0f, 0.0f);
    v128_t vX2 = wasm_f32x4_make(x2L, x2R, 0.0f, 0.0f);
    v128_t vY1 = wasm_f32x4_make(y1L, y1R, 0.0f, 0.0f);
    v128_t vY2 = wasm_f32x4_make(y2L, y2R, 0.0f, 0.0f);

    for (size_t i = 0; i < numFrames; ++i) {
        float inL = interleavedBuffer[i * 2];
        float inR = interleavedBuffer[i * 2 + 1];
        v128_t vIn = wasm_f32x4_make(inL, inR, 0.0f, 0.0f);

        // y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
        v128_t vOut = wasm_f32x4_mul(vB0, vIn);
        vOut = wasm_f32x4_add(vOut, wasm_f32x4_mul(vB1, vX1));
        vOut = wasm_f32x4_add(vOut, wasm_f32x4_mul(vB2, vX2));
        vOut = wasm_f32x4_sub(vOut, wasm_f32x4_mul(vA1, vY1));
        vOut = wasm_f32x4_sub(vOut, wasm_f32x4_mul(vA2, vY2));

        // Обновление линий задержки
        vX2 = vX1;
        vX1 = vIn;
        vY2 = vY1;
        vY1 = vOut;

        alignas(16) float outArr[4];
        wasm_v128_store(outArr, vOut);

        interleavedBuffer[i * 2]     = outArr[0];
        interleavedBuffer[i * 2 + 1] = outArr[1];
    }

    alignas(16) float finalX1[4], finalX2[4], finalY1[4], finalY2[4];
    wasm_v128_store(finalX1, vX1);
    wasm_v128_store(finalX2, vX2);
    wasm_v128_store(finalY1, vY1);
    wasm_v128_store(finalY2, vY2);

    x1L = finalX1[0]; x1R = finalX1[1];
    x2L = finalX2[0]; x2R = finalX2[1];
    y1L = finalY1[0]; y1R = finalY1[1];
    y2L = finalY2[0]; y2R = finalY2[1];

#else
    // Скалярная высокоточная обработка стерео
    for (size_t i = 0; i < numFrames; ++i) {
        float inL = interleavedBuffer[i * 2];
        float inR = interleavedBuffer[i * 2 + 1];

        float outL = b0 * inL + b1 * x1L + b2 * x2L - a1 * y1L - a2 * y2L;
        x2L = x1L; x1L = inL; y2L = y1L; y1L = outL;

        float outR = b0 * inR + b1 * x1R + b2 * x2R - a1 * y1R - a2 * y2R;
        x2R = x1R; x1R = inR; y2R = y1R; y1R = outR;

        interleavedBuffer[i * 2]     = outL;
        interleavedBuffer[i * 2 + 1] = outR;
    }
#endif
}

// ============================================================================
// ParametricEQ3Band
// ============================================================================

ParametricEQ3Band::ParametricEQ3Band() noexcept {
    lowShelf.type = BiquadFilterType::LowShelf;
    lowShelf.frequency = 120.0f;
    lowShelf.gainDb = 0.0f;
    lowShelf.Q = 0.7071f;

    peaking.type = BiquadFilterType::Peaking;
    peaking.frequency = 2500.0f;
    peaking.gainDb = 0.0f;
    peaking.Q = 1.2f;

    highShelf.type = BiquadFilterType::HighShelf;
    highShelf.frequency = 8000.0f;
    highShelf.gainDb = 0.0f;
    highShelf.Q = 0.7071f;

    updateAll(48000.0f);
}

void ParametricEQ3Band::setup(float sr) noexcept {
    updateAll(sr);
}

void ParametricEQ3Band::updateAll(float sr) noexcept {
    lowShelf.sampleRate = sr;
    lowShelf.updateCoefficients();

    peaking.sampleRate = sr;
    peaking.updateCoefficients();

    highShelf.sampleRate = sr;
    highShelf.updateCoefficients();
}

void ParametricEQ3Band::reset() noexcept {
    lowShelf.resetState();
    peaking.resetState();
    highShelf.resetState();
}

void ParametricEQ3Band::processBuffer(float* interleavedBuffer, size_t numFrames) noexcept {
    if (!enabled || numFrames == 0 || !interleavedBuffer) return;

    lowShelf.processBuffer(interleavedBuffer, numFrames);
    peaking.processBuffer(interleavedBuffer, numFrames);
    highShelf.processBuffer(interleavedBuffer, numFrames);
}

} // namespace DAWCore
