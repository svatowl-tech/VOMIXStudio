/**
 * ============================================================================
 * VocalRack.cpp - Реализация вокального процессора и алгоритмов реставрации
 * ============================================================================
 */

#include "VocalRack.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

// ============================================================================
// 1. DeClicker
// ============================================================================

DeClicker::DeClicker() noexcept {
    reset();
}

void DeClicker::reset() noexcept {
    histL.fill(0.0f);
    histR.fill(0.0f);
    clicksDetected = 0;
}

void DeClicker::processBuffer(float* interleavedBuffer, size_t numFrames) noexcept {
    if (!enabled || numFrames == 0 || !interleavedBuffer) return;

    for (size_t i = 0; i < numFrames; ++i) {
        // --- Левый канал ---
        float curL = interleavedBuffer[i * 2];
        float prev1L = histL[0];
        float prev2L = histL[1];
        float prev3L = histL[2];

        // Вторая производная d^2x/dt^2
        float d2L = curL - 2.0f * prev1L + prev2L;
        float absD2L = std::abs(d2L);
        float localVarL = 0.5f * (std::abs(prev1L - prev2L) + std::abs(prev2L - prev3L)) + 0.001f;

        if (absD2L > (threshold + 3.5f * localVarL) && absD2L > 0.015f) {
            clicksDetected++;
            float nextL = (i + 1 < numFrames) ? interleavedBuffer[(i + 1) * 2] : prev1L;
            float m0L = prev1L - prev2L;
            float m1L = nextL - prev1L;
            curL = hermiteInterpolate(prev1L, m0L, nextL, m1L, 0.5f);
            interleavedBuffer[i * 2] = curL;
        }

        histL[3] = histL[2];
        histL[2] = histL[1];
        histL[1] = histL[0];
        histL[0] = curL;

        // --- Правый канал ---
        float curR = interleavedBuffer[i * 2 + 1];
        float prev1R = histR[0];
        float prev2R = histR[1];
        float prev3R = histR[2];

        float d2R = curR - 2.0f * prev1R + prev2R;
        float absD2R = std::abs(d2R);
        float localVarR = 0.5f * (std::abs(prev1R - prev2R) + std::abs(prev2R - prev3R)) + 0.001f;

        if (absD2R > (threshold + 3.5f * localVarR) && absD2R > 0.015f) {
            clicksDetected++;
            float nextR = (i + 1 < numFrames) ? interleavedBuffer[(i + 1) * 2 + 1] : prev1R;
            float m0R = prev1R - prev2R;
            float m1R = nextR - prev1R;
            curR = hermiteInterpolate(prev1R, m0R, nextR, m1R, 0.5f);
            interleavedBuffer[i * 2 + 1] = curR;
        }

        histR[3] = histR[2];
        histR[2] = histR[1];
        histR[1] = histR[0];
        histR[0] = curR;
    }
}

// ============================================================================
// 2. DePlosive
// ============================================================================

DePlosive::DePlosive() noexcept {
    setup(48000.0f);
}

void DePlosive::setup(float sr) noexcept {
    sampleRate = sr;
    updateCoefficients();
    reset();
}

void DePlosive::reset() noexcept {
    hpfX1L = hpfX2L = hpfY1L = hpfY2L = 0.0f;
    hpfX1R = hpfX2R = hpfY1R = hpfY2R = 0.0f;
    lpX1L = lpX2L = lpY1L = lpY2L = 0.0f;
    lpX1R = lpX2R = lpY1R = lpY2R = 0.0f;
    subEnvelope = 0.0f;
    currentReduction = 0.0f;
}

void DePlosive::updateCoefficients() noexcept {
    if (sampleRate <= 0.0f) return;
    float safeAttack = std::max(attackMs, 0.1f);
    float safeRelease = std::max(releaseMs, 5.0f);
    attackCoeff = std::exp(-1.0f / (safeAttack * 0.001f * sampleRate));
    releaseCoeff = std::exp(-1.0f / (safeRelease * 0.001f * sampleRate));

    // ФВЧ 2-го порядка Баттерворта (High-Pass Filter)
    float omegaHP = TWO_PI_F * clampFloat(frequency, 20.0f, 250.0f) / sampleRate;
    float snHP = std::sin(omegaHP);
    float csHP = std::cos(omegaHP);
    float alphaHP = snHP / (2.0f * 0.7071f);

    float a0HP = 1.0f + alphaHP;
    b0 = ((1.0f + csHP) * 0.5f) / a0HP;
    b1 = (-(1.0f + csHP)) / a0HP;
    b2 = ((1.0f + csHP) * 0.5f) / a0HP;
    a1 = (-2.0f * csHP) / a0HP;
    a2 = (1.0f - alphaHP) / a0HP;

    // ФНЧ детектора суббаса (< 90 Гц)
    float omegaLP = TWO_PI_F * 90.0f / sampleRate;
    float snLP = std::sin(omegaLP);
    float csLP = std::cos(omegaLP);
    float alphaLP = snLP / (2.0f * 0.7071f);

    float a0LP = 1.0f + alphaLP;
    lpB0 = ((1.0f - csLP) * 0.5f) / a0LP;
    lpB1 = (1.0f - csLP) / a0LP;
    lpB2 = ((1.0f - csLP) * 0.5f) / a0LP;
    lpA1 = (-2.0f * csLP) / a0LP;
    lpA2 = (1.0f - alphaLP) / a0LP;
}

void DePlosive::processBuffer(float* interleavedBuffer, size_t numFrames) noexcept {
    if (!enabled || numFrames == 0 || !interleavedBuffer) return;

    float threshLin = dbToGain(thresholdDb);

    for (size_t i = 0; i < numFrames; ++i) {
        float inL = interleavedBuffer[i * 2];
        float inR = interleavedBuffer[i * 2 + 1];

        // Сайдчейн-детекция суббаса через 90 Гц ФНЧ
        float detL = lpB0 * inL + lpB1 * lpX1L + lpB2 * lpX2L - lpA1 * lpY1L - lpA2 * lpY2L;
        lpX2L = lpX1L; lpX1L = inL; lpY2L = lpY1L; lpY1L = detL;

        float detR = lpB0 * inR + lpB1 * lpX1R + lpB2 * lpX2R - lpA1 * lpY1R - lpA2 * lpY2R;
        lpX2R = lpX1R; lpX1R = inR; lpY2R = lpY1R; lpY1R = detR;

        float subLevel = std::max(std::abs(detL), std::abs(detR));
        subEnvelope = (subLevel > subEnvelope)
            ? attackCoeff * subEnvelope + (1.0f - attackCoeff) * subLevel
            : releaseCoeff * subEnvelope + (1.0f - releaseCoeff) * subLevel;

        // Плавное включение фильтрации при выбросе энергии суббаса
        float targetBlend = 0.0f;
        if (subEnvelope > threshLin) {
            float overRatio = (subEnvelope - threshLin) / (threshLin + 1e-4f);
            targetBlend = clampFloat(overRatio, 0.0f, 1.0f);
        }
        currentReduction = targetBlend;

        // Применение адаптивного ФВЧ
        float hpfOutL = b0 * inL + b1 * hpfX1L + b2 * hpfX2L - a1 * hpfY1L - a2 * hpfY2L;
        hpfX2L = hpfX1L; hpfX1L = inL; hpfY2L = hpfY1L; hpfY1L = hpfOutL;

        float hpfOutR = b0 * inR + b1 * hpfX1R + b2 * hpfX2R - a1 * hpfY1R - a2 * hpfY2R;
        hpfX2R = hpfX1R; hpfX1R = inR; hpfY2R = hpfY1R; hpfY1R = hpfOutR;

        // Кроссфейд чистого и отфильтрованного сигнала
        interleavedBuffer[i * 2]     = inL * (1.0f - targetBlend) + hpfOutL * targetBlend;
        interleavedBuffer[i * 2 + 1] = inR * (1.0f - targetBlend) + hpfOutR * targetBlend;
    }
}

// ============================================================================
// 3. DeEsser
// ============================================================================

DeEsser::DeEsser() noexcept {
    setup(48000.0f);
}

void DeEsser::setup(float sr) noexcept {
    sampleRate = sr;
    updateCoefficients();
    reset();
}

void DeEsser::reset() noexcept {
    bpX1L = bpX2L = bpY1L = bpY2L = 0.0f;
    bpX1R = bpX2R = bpY1R = bpY2R = 0.0f;
    essEnvelope = 0.0f;
    currentGainReductionDb = 0.0f;
}

void DeEsser::updateCoefficients() noexcept {
    if (sampleRate <= 0.0f) return;
    float safeAttack = std::max(attackMs, 0.1f);
    float safeRelease = std::max(releaseMs, 5.0f);
    attackCoeff = std::exp(-1.0f / (safeAttack * 0.001f * sampleRate));
    releaseCoeff = std::exp(-1.0f / (safeRelease * 0.001f * sampleRate));

    // Полосовой фильтр 2-го порядка (Band-Pass Filter, Q=2.0)
    float safeFreq = clampFloat(frequency, 3000.0f, 12000.0f);
    float omega = TWO_PI_F * safeFreq / sampleRate;
    float sn = std::sin(omega);
    float cs = std::cos(omega);
    float alpha = sn / (2.0f * 2.0f);

    float a0 = 1.0f + alpha;
    b0 = alpha / a0;
    b1 = 0.0f;
    b2 = -alpha / a0;
    a1 = (-2.0f * cs) / a0;
    a2 = (1.0f - alpha) / a0;
}

void DeEsser::processBuffer(float* interleavedBuffer, size_t numFrames) noexcept {
    if (!enabled || numFrames == 0 || !interleavedBuffer) return;

    for (size_t i = 0; i < numFrames; ++i) {
        float inL = interleavedBuffer[i * 2];
        float inR = interleavedBuffer[i * 2 + 1];

        // Полосовая фильтрация сибилянтов
        float sibilantL = b0 * inL + b1 * bpX1L + b2 * bpX2L - a1 * bpY1L - a2 * bpY2L;
        bpX2L = bpX1L; bpX1L = inL; bpY2L = bpY1L; bpY1L = sibilantL;

        float sibilantR = b0 * inR + b1 * bpX1R + b2 * bpX2R - a1 * bpY1R - a2 * bpY2R;
        bpX2R = bpX1R; bpX1R = inR; bpY2R = bpY1R; bpY1R = sibilantR;

        float essLevel = std::max(std::abs(sibilantL), std::abs(sibilantR));
        essEnvelope = (essLevel > essEnvelope)
            ? attackCoeff * essEnvelope + (1.0f - attackCoeff) * essLevel
            : releaseCoeff * essEnvelope + (1.0f - releaseCoeff) * essLevel;

        float essDb = gainToDb(essEnvelope);
        float reductionDb = 0.0f;

        if (essDb > thresholdDb) {
            reductionDb = (essDb - thresholdDb) * (1.0f - 1.0f / std::max(ratio, 1.0f));
            reductionDb = std::min(18.0f, reductionDb); // Ограничение глубины подавления до 18 дБ
        }

        currentGainReductionDb = reductionDb;
        float gainFactor = dbToGain(-reductionDb);

        interleavedBuffer[i * 2]     *= gainFactor;
        interleavedBuffer[i * 2 + 1] *= gainFactor;
    }
}

// ============================================================================
// 4. VocalRack
// ============================================================================

void VocalRack::setup(float sampleRate) noexcept {
    dePlosive.setup(sampleRate);
    noiseGate.setup(sampleRate);
    eq.updateAll(sampleRate);
    deEsser.setup(sampleRate);
    compressor.setup(sampleRate);
    autoDucker.setup(sampleRate);
    reset();
}

void VocalRack::reset() noexcept {
    deClicker.reset();
    dePlosive.reset();
    noiseGate.reset();
    eq.reset();
    deEsser.reset();
    compressor.reset();
    autoDucker.reset();
}

void VocalRack::process(
    float* interleavedBuffer,
    const float* sidechainMono,
    size_t numFrames
) noexcept {
    if (numFrames == 0 || !interleavedBuffer) return;

    // 1. Де-кликер (устранение микро-щелчков)
    deClicker.processBuffer(interleavedBuffer, numFrames);

    // 2. Де-плозив (подавление задуваний микрофона)
    dePlosive.processBuffer(interleavedBuffer, numFrames);

    // 3. Шумоподавитель
    noiseGate.processBuffer(interleavedBuffer, numFrames);

    // 4. 3-полосный параметрический эквалайзер
    eq.processBuffer(interleavedBuffer, numFrames);

    // 5. Де-эссер (свистящие/шипящие звуки)
    deEsser.processBuffer(interleavedBuffer, numFrames);

    // 6. Студийный компрессор с мягким коленом
    compressor.processBuffer(interleavedBuffer, numFrames);

    // 7. Сайдчейн-дакер (приглушение музыки при речи)
    if (autoDucker.enabled) {
        autoDucker.processBufferWithSidechain(interleavedBuffer, sidechainMono, numFrames);
    }
}

} // namespace DAWCore
