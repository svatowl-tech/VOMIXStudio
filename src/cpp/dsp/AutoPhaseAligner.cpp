/**
 * ============================================================================
 * AutoPhaseAligner.cpp - Реализация фазового корректора (C++17)
 * ============================================================================
 * Нормализованная взаимная корреляция, субсэмпловая параболическая интерполяция
 * и дробная задержка Тирана (Thiran Allpass Interpolator) с WASM SIMD128.
 * ============================================================================
 */

#include "AutoPhaseAligner.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>

namespace DAWCore {

// ============================================================================
// Реализация FractionalDelayLine
// ============================================================================

FractionalDelayLine::FractionalDelayLine(size_t maxDelaySamples) noexcept {
    setMaxDelay(maxDelaySamples);
}

void FractionalDelayLine::setMaxDelay(size_t maxDelaySamples) noexcept {
    bufferCap_ = std::max(static_cast<size_t>(64), maxDelaySamples + 16);
    buffer_.assign(bufferCap_, 0.0f);
    reset();
}

void FractionalDelayLine::reset() noexcept {
    std::fill(buffer_.begin(), buffer_.end(), 0.0f);
    writePos_ = 0;
    allpassStateX_ = 0.0f;
    allpassStateY_ = 0.0f;
}

// ============================================================================
// Реализация AutoPhaseAligner
// ============================================================================

AutoPhaseAligner::AutoPhaseAligner(float sampleRate) noexcept {
    corrScores_.assign(8192, 0.0f);
    setSampleRate(sampleRate);
}

void AutoPhaseAligner::setSampleRate(float sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;

    const size_t maxDelay = static_cast<size_t>(
        (DEFAULT_MAX_SHIFT_MS * 0.001f * sampleRate_) * 2.0f + 128.0f
    );

    delayLineL_.setMaxDelay(maxDelay);
    delayLineR_.setMaxDelay(maxDelay);
    reset();
}

void AutoPhaseAligner::setParams(const AutoPhaseParams& params) noexcept {
    params_ = params;
}

void AutoPhaseAligner::reset() noexcept {
    delayLineL_.reset();
    delayLineR_.reset();
    lastResult_ = PhaseAlignResult{};
}

PhaseAlignResult AutoPhaseAligner::analyzePhase(
    const float* reference,
    const float* target,
    size_t numFrames,
    float maxShiftMs
) noexcept {
    PhaseAlignResult result{};
    if (!reference || !target || numFrames < 64) return result;

    const float shiftMs = (maxShiftMs > 0.1f) ? maxShiftMs : params_.maxShiftMs;
    const int maxShift = std::max(1, std::min(
        static_cast<int>(2048),
        static_cast<int>(shiftMs * 0.001f * sampleRate_)
    ));

    const size_t n = std::min(numFrames, MAX_ANALYSIS_FRAMES);
    if (static_cast<int>(n) <= maxShift * 2) return result;

    // 1. Вычисление средних значений DC для центрирования сигналов
    double sumRef = 0.0;
    double sumTgt = 0.0;
    for (size_t i = 0; i < n; ++i) {
        sumRef += reference[i];
        sumTgt += target[i];
    }
    const float meanRef = static_cast<float>(sumRef / static_cast<double>(n));
    const float meanTgt = static_cast<float>(sumTgt / static_cast<double>(n));

    // 2. Расчет автокорреляционных норм сигналов
    double energyRef = 0.0;
    double energyTgt = 0.0;
    for (size_t i = 0; i < n; ++i) {
        const float r = reference[i] - meanRef;
        const float t = target[i] - meanTgt;
        energyRef += r * r;
        energyTgt += t * t;
    }

    const double normDenom = std::sqrt(energyRef * energyTgt);
    if (normDenom < 1e-9) return result; // Сигналы содержат тишину

    const size_t totalLags = static_cast<size_t>(maxShift * 2 + 1);
    if (corrScores_.size() < totalLags) {
        corrScores_.resize(totalLags, 0.0f);
    }

    float bestCorrAbs = -1.0f;
    int bestLag = 0;
    float bestCorrRaw = 0.0f;

    // 3. Вычисление нормализованной взаимной корреляции (NCC) в окне сдвигов
    for (int lag = -maxShift; lag <= maxShift; ++lag) {
        const size_t startIdx = (lag < 0) ? static_cast<size_t>(-lag) : 0;
        const size_t endIdx = (lag > 0) ? (n - static_cast<size_t>(lag)) : n;
        const size_t count = endIdx - startIdx;

        if (count < 32) continue;

        double crossSum = 0.0;
        size_t i = startIdx;

#if USE_WASM_SIMD
        v128_t vCross = wasm_f32x4_splat(0.0f);
        v128_t vMeanRef = wasm_f32x4_splat(meanRef);
        v128_t vMeanTgt = wasm_f32x4_splat(meanTgt);

        const size_t simdEnd = startIdx + ((count / 4) * 4);
        for (; i < simdEnd; i += 4) {
            v128_t vR = wasm_f32x4_sub(wasm_v128_load(&reference[i]), vMeanRef);
            const size_t tIdx = static_cast<size_t>(static_cast<int>(i) + lag);
            v128_t vT = wasm_f32x4_sub(wasm_v128_load(&target[tIdx]), vMeanTgt);
            vCross = wasm_f32x4_add(vCross, wasm_f32x4_mul(vR, vT));
        }

        crossSum += wasm_f32x4_extract_lane(vCross, 0) +
                    wasm_f32x4_extract_lane(vCross, 1) +
                    wasm_f32x4_extract_lane(vCross, 2) +
                    wasm_f32x4_extract_lane(vCross, 3);
#endif

        for (; i < endIdx; ++i) {
            const size_t tIdx = static_cast<size_t>(static_cast<int>(i) + lag);
            crossSum += (reference[i] - meanRef) * (target[tIdx] - meanTgt);
        }

        const float corr = static_cast<float>(crossSum / normDenom);
        const size_t scoreIdx = static_cast<size_t>(lag + maxShift);
        corrScores_[scoreIdx] = corr;

        const float absCorr = std::fabs(corr);
        if (absCorr > bestCorrAbs) {
            bestCorrAbs = absCorr;
            bestLag = lag;
            bestCorrRaw = corr;
        }
    }

    // 4. Субсэмпловая квадратичная параболическая интерполяция вершины корреляции
    float fracLag = static_cast<float>(bestLag);
    const int bestIdx = bestLag + maxShift;

    if (bestIdx > 0 && bestIdx < static_cast<int>(totalLags - 1)) {
        const float alpha = std::fabs(corrScores_[bestIdx - 1]);
        const float beta = std::fabs(corrScores_[bestIdx]);
        const float gamma = std::fabs(corrScores_[bestIdx + 1]);

        const float denom = 2.0f * (2.0f * beta - alpha - gamma);
        if (std::fabs(denom) > 1e-7f) {
            const float delta = (alpha - gamma) / denom;
            if (std::fabs(delta) < 0.6f) {
                fracLag += delta;
            }
        }
    }

    // 5. Заполнение структуры результатов
    result.delaySamples = fracLag;
    result.delayMs = (fracLag / sampleRate_) * 1000.0f;
    result.correlation = bestCorrRaw;
    result.coherenceScore = std::min(1.0f, bestCorrAbs);

    // Определение инверсии фазы (если корреляция отрицательна — дорожка в противофазе)
    result.phaseInverted = (params_.autoInvertPolarity && bestCorrRaw < -0.15f);

    lastResult_ = result;
    return result;
}

void AutoPhaseAligner::applyAlignment(
    float* target,
    size_t numFrames,
    float delaySamples,
    bool invertPolarity
) noexcept {
    if (!target || numFrames == 0) return;

    // 1. Инверсия полярности на 180° при противофазе
    if (invertPolarity) {
        size_t i = 0;
#if USE_WASM_SIMD
        v128_t vNeg = wasm_f32x4_splat(-1.0f);
        const size_t simdEnd = numFrames - (numFrames % 4);
        for (; i < simdEnd; i += 4) {
            v128_t vX = wasm_v128_load(&target[i]);
            wasm_v128_store(&target[i], wasm_f32x4_mul(vX, vNeg));
        }
#endif
        for (; i < numFrames; ++i) {
            target[i] = -target[i];
        }
    }

    // 2. Смещение задержки через Thiran Allpass интерполятор
    if (std::fabs(delaySamples) < 0.005f) return;

    alignas(16) float tempBuf[4096];
    size_t processed = 0;

    if (delaySamples > 0.0f) {
        // Задержка target на delaySamples сэмплов назад
        delayLineL_.reset();
        while (processed < numFrames) {
            const size_t chunk = std::min(static_cast<size_t>(4096), numFrames - processed);
            for (size_t i = 0; i < chunk; ++i) {
                tempBuf[i] = delayLineL_.processSample(target[processed + i], delaySamples);
            }
            std::copy(tempBuf, tempBuf + chunk, &target[processed]);
            processed += chunk;
        }
    } else {
        // Опережение target (сдвиг влево на |delaySamples|)
        const float shift = -delaySamples;
        const size_t sInt = static_cast<size_t>(shift);
        const float sFrac = shift - static_cast<float>(sInt);

        if (sInt < numFrames) {
            std::memmove(target, target + sInt, (numFrames - sInt) * sizeof(float));
            std::fill(target + (numFrames - sInt), target + numFrames, 0.0f);
        } else {
            std::fill(target, target + numFrames, 0.0f);
        }

        // Дробная коррекция остатка
        if (sFrac > 0.005f) {
            delayLineL_.reset();
            const float compDelay = 1.0f - sFrac;
            while (processed < numFrames) {
                const size_t chunk = std::min(static_cast<size_t>(4096), numFrames - processed);
                for (size_t i = 0; i < chunk; ++i) {
                    tempBuf[i] = delayLineL_.processSample(target[processed + i], compDelay);
                }
                std::copy(tempBuf, tempBuf + chunk, &target[processed]);
                processed += chunk;
            }
        }
    }
}

PhaseAlignResult AutoPhaseAligner::alignSignals(
    const float* reference,
    float* target,
    size_t numFrames,
    float maxShiftMs
) noexcept {
    const PhaseAlignResult res = analyzePhase(reference, target, numFrames, maxShiftMs);

    if (params_.enabled && res.coherenceScore > 0.1f) {
        applyAlignment(target, numFrames, res.delaySamples, res.phaseInverted);
    }

    return res;
}

void AutoPhaseAligner::processBlock(float* target, size_t numFrames, int channels) noexcept {
    if (!target || numFrames == 0 || !params_.enabled) return;

    if (channels == 1) {
        applyAlignment(target, numFrames, lastResult_.delaySamples, lastResult_.phaseInverted);
    } else {
        alignas(16) float tempL[2048];
        alignas(16) float tempR[2048];

        size_t processed = 0;
        while (processed < numFrames) {
            const size_t chunk = std::min(static_cast<size_t>(2048), numFrames - processed);

            for (size_t i = 0; i < chunk; ++i) {
                const size_t idx = (processed + i) * 2;
                tempL[i] = target[idx + 0];
                tempR[i] = target[idx + 1];
            }

            applyAlignment(tempL, chunk, lastResult_.delaySamples, lastResult_.phaseInverted);
            applyAlignment(tempR, chunk, lastResult_.delaySamples, lastResult_.phaseInverted);

            for (size_t i = 0; i < chunk; ++i) {
                const size_t idx = (processed + i) * 2;
                target[idx + 0] = tempL[i];
                target[idx + 1] = tempR[i];
            }

            processed += chunk;
        }
    }
}

} // namespace DAWCore
