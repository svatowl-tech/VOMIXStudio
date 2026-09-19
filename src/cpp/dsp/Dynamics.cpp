/**
 * ============================================================================
 * Dynamics.cpp - Реализация модулей динамической обработки (RT-Safe, C++17)
 * ============================================================================
 */

#include "Dynamics.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

// ============================================================================
// 1. NoiseGate
// ============================================================================

NoiseGate::NoiseGate() noexcept {
    setup(48000.0f);
}

void NoiseGate::setup(float sr) noexcept {
    sampleRate = sr;
    updateConstants();
    reset();
}

void NoiseGate::reset() noexcept {
    state = GateState::Closed;
    holdSamplesCounter = 0;
    currentGain = dbToGain(floorDb);
    envelope = 0.0f;
}

void NoiseGate::updateConstants() noexcept {
    if (sampleRate <= 0.0f) return;
    float safeAttack = std::max(attackMs, 0.05f);
    float safeRelease = std::max(releaseMs, 1.0f);
    attackCoeff = std::exp(-1.0f / (safeAttack * 0.001f * sampleRate));
    releaseCoeff = std::exp(-1.0f / (safeRelease * 0.001f * sampleRate));
}

void NoiseGate::processBuffer(float* interleavedBuffer, size_t numFrames) noexcept {
    if (!enabled || numFrames == 0 || !interleavedBuffer) return;

    float openThreshLin = dbToGain(thresholdDb);
    float closeThreshLin = dbToGain(thresholdDb - 3.0f); // 3 dB гистерезис для исключения дребезга
    float floorGainLin = dbToGain(floorDb);
    size_t holdSamplesTotal = static_cast<size_t>(std::max(holdMs, 0.0f) * 0.001f * sampleRate);

    for (size_t i = 0; i < numFrames; ++i) {
        float inL = interleavedBuffer[i * 2];
        float inR = interleavedBuffer[i * 2 + 1];
        float level = std::max(std::abs(inL), std::abs(inR));

        // Быстрый детектор пиковой огибающей
        envelope = (level > envelope)
            ? 0.85f * envelope + 0.15f * level
            : 0.999f * envelope + 0.001f * level;

        // Конечный автомат (FSM) управления гейтом
        switch (state) {
            case GateState::Closed:
                if (envelope >= openThreshLin) {
                    state = GateState::Opening;
                }
                break;

            case GateState::Opening:
                currentGain = attackCoeff * currentGain + (1.0f - attackCoeff) * 1.0f;
                if (currentGain >= 0.99f) {
                    currentGain = 1.0f;
                    state = GateState::Open;
                }
                break;

            case GateState::Open:
                if (envelope < closeThreshLin) {
                    state = GateState::Holding;
                    holdSamplesCounter = holdSamplesTotal;
                }
                break;

            case GateState::Holding:
                if (envelope >= openThreshLin) {
                    state = GateState::Open;
                } else if (holdSamplesCounter > 0) {
                    holdSamplesCounter--;
                } else {
                    state = GateState::Closing;
                }
                break;

            case GateState::Closing:
                if (envelope >= openThreshLin) {
                    state = GateState::Opening;
                } else {
                    currentGain = releaseCoeff * currentGain + (1.0f - releaseCoeff) * floorGainLin;
                    if (currentGain <= floorGainLin * 1.02f) {
                        currentGain = floorGainLin;
                        state = GateState::Closed;
                    }
                }
                break;
        }

        interleavedBuffer[i * 2]     *= currentGain;
        interleavedBuffer[i * 2 + 1] *= currentGain;
    }
}

// ============================================================================
// 2. SoftKneeCompressor
// ============================================================================

SoftKneeCompressor::SoftKneeCompressor() noexcept {
    setup(48000.0f);
}

void SoftKneeCompressor::setup(float sr) noexcept {
    sampleRate = sr;
    updateTimeConstants();
    reset();
}

void SoftKneeCompressor::reset() noexcept {
    envelopeGain = 1.0f;
    currentGainReduction = 1.0f;
}

void SoftKneeCompressor::updateTimeConstants() noexcept {
    if (sampleRate <= 0.0f) return;
    float safeAttack = std::max(attackMs, 0.1f);
    float safeRelease = std::max(releaseMs, 1.0f);
    attackCoeff = std::exp(-1.0f / (safeAttack * 0.001f * sampleRate));
    releaseCoeff = std::exp(-1.0f / (safeRelease * 0.001f * sampleRate));
}

float SoftKneeCompressor::computeGainReductionDb(float inDb) const noexcept {
    float halfKnee = std::max(kneeDb, 0.0f) * 0.5f;
    float slope = 1.0f - 1.0f / std::max(ratio, 1.0f);

    if (inDb > thresholdDb + halfKnee) {
        // Линейная компрессия выше зоны колена
        return (inDb - thresholdDb) * slope;
    } else if (inDb > thresholdDb - halfKnee && kneeDb > 0.001f) {
        // Квадратичная полиномиальная интерполяция в зоне перегиба (Soft Knee)
        float x = inDb - thresholdDb + halfKnee;
        return (slope * x * x) / (2.0f * kneeDb);
    }
    return 0.0f; // Ниже порога сжатие отсутствует
}

void SoftKneeCompressor::processBuffer(float* interleavedBuffer, size_t numFrames) noexcept {
    if (!enabled || numFrames == 0 || !interleavedBuffer) return;

    float makeupLin = dbToGain(makeupGainDb);

    for (size_t i = 0; i < numFrames; ++i) {
        float inL = interleavedBuffer[i * 2];
        float inR = interleavedBuffer[i * 2 + 1];
        float inLevel = std::max(std::abs(inL), std::abs(inR));
        float inDb = gainToDb(inLevel);

        float gainReductionDb = computeGainReductionDb(inDb);
        float targetGain = dbToGain(-gainReductionDb);

        // Логарифмическая огибающая компрессии (Attack / Release)
        envelopeGain = (targetGain < envelopeGain)
            ? attackCoeff * envelopeGain + (1.0f - attackCoeff) * targetGain
            : releaseCoeff * envelopeGain + (1.0f - releaseCoeff) * targetGain;

        currentGainReduction = envelopeGain;
        float finalGain = envelopeGain * makeupLin;

        interleavedBuffer[i * 2]     *= finalGain;
        interleavedBuffer[i * 2 + 1] *= finalGain;
    }
}

// ============================================================================
// 3. AutoDucker
// ============================================================================

AutoDucker::AutoDucker() noexcept {
    setup(48000.0f);
}

void AutoDucker::setup(float sr) noexcept {
    sampleRate = sr;
    updateConstants();
    reset();
}

void AutoDucker::reset() noexcept {
    envelope = 1.0f;
    currentDuckingGain = 1.0f;
}

void AutoDucker::updateConstants() noexcept {
    if (sampleRate <= 0.0f) return;
    float safeAttack = std::max(attackMs, 0.5f);
    float safeRelease = std::max(releaseMs, 5.0f);
    attackCoeff = std::exp(-1.0f / (safeAttack * 0.001f * sampleRate));
    releaseCoeff = std::exp(-1.0f / (safeRelease * 0.001f * sampleRate));
}

void AutoDucker::processBufferWithSidechain(
    float* interleavedBuffer,
    const float* sidechainMono,
    size_t numFrames
) noexcept {
    if (!enabled || numFrames == 0 || !interleavedBuffer) return;

    float targetDuckLin = dbToGain(duckDepthDb);
    float absMaxDepth = std::abs(duckDepthDb);

    for (size_t i = 0; i < numFrames; ++i) {
        float scLevel = (sidechainMono != nullptr) ? std::abs(sidechainMono[i]) : 0.0f;
        float scDb = gainToDb(scLevel);

        float targetGain = 1.0f;
        if (scDb > thresholdDb) {
            float overDb = scDb - thresholdDb;
            float reductionDb = std::min(absMaxDepth, overDb * 0.85f);
            targetGain = dbToGain(-reductionDb);
        }

        // Плавная баллистика приглушения
        envelope = (targetGain < envelope)
            ? attackCoeff * envelope + (1.0f - attackCoeff) * targetGain
            : releaseCoeff * envelope + (1.0f - releaseCoeff) * targetGain;

        currentDuckingGain = envelope;

        interleavedBuffer[i * 2]     *= envelope;
        interleavedBuffer[i * 2 + 1] *= envelope;
    }
}

void AutoDucker::processBufferWithSidechainStereo(
    float* interleavedBuffer,
    const float* sidechainStereo,
    size_t numFrames
) noexcept {
    if (!enabled || numFrames == 0 || !interleavedBuffer) return;

    float targetDuckLin = dbToGain(duckDepthDb);
    float absMaxDepth = std::abs(duckDepthDb);

    for (size_t i = 0; i < numFrames; ++i) {
        float scLevel = 0.0f;
        if (sidechainStereo != nullptr) {
            scLevel = std::max(std::abs(sidechainStereo[i * 2]), std::abs(sidechainStereo[i * 2 + 1]));
        }
        float scDb = gainToDb(scLevel);

        float targetGain = 1.0f;
        if (scDb > thresholdDb) {
            float overDb = scDb - thresholdDb;
            float reductionDb = std::min(absMaxDepth, overDb * 0.85f);
            targetGain = dbToGain(-reductionDb);
        }

        envelope = (targetGain < envelope)
            ? attackCoeff * envelope + (1.0f - attackCoeff) * targetGain
            : releaseCoeff * envelope + (1.0f - releaseCoeff) * targetGain;

        currentDuckingGain = envelope;

        interleavedBuffer[i * 2]     *= envelope;
        interleavedBuffer[i * 2 + 1] *= envelope;
    }
}

// ============================================================================
// 4. SoftLimiter
// ============================================================================

void SoftLimiter::processBuffer(float* interleavedBuffer, size_t numFrames) noexcept {
    if (!enabled || numFrames == 0 || !interleavedBuffer) return;

    float ceilingLin = dbToGain(ceilingDb);
    float threshold = ceilingLin * 0.85f;
    float headRoom = std::max(ceilingLin - threshold, 1e-4f);
    size_t totalSamples = numFrames * 2;

    for (size_t i = 0; i < totalSamples; ++i) {
        float s = interleavedBuffer[i];
        float absS = std::abs(s);

        if (absS > threshold) {
            float sign = (s >= 0.0f) ? 1.0f : -1.0f;
            float over = absS - threshold;
            float comp = threshold + headRoom * std::tanh(over / headRoom);
            s = sign * comp;
        }

        interleavedBuffer[i] = clampFloat(s, -1.0f, 1.0f);
    }
}

} // namespace DAWCore
