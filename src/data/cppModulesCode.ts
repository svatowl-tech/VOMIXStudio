/**
 * ============================================================================
 * cppModulesCode.ts - Полные исходные тексты модульной C++17 архитектуры
 * ============================================================================
 */

export const MODULAR_CPP_SOURCES: Record<string, string> = {
  'dsp/AudioMath.hpp': `#pragma once

/**
 * ============================================================================
 * AudioMath.hpp - Базовые математические константы, функции и SIMD-детекция
 * ============================================================================
 * Низкоуровневые вспомогательные функции для аудиоядра DAW.
 * Стандарт: C++17. Не содержит динамических аллокаций памяти.
 * ============================================================================
 */

#include <cmath>
#include <cstdint>
#include <cstddef>
#include <algorithm>

// Аппаратная векторизация WebAssembly SIMD128 (-msimd128)
#if defined(__wasm_simd128__) || defined(__wasm_simd__)
#include <wasm_simd128.h>
#define USE_WASM_SIMD 1
#else
#define USE_WASM_SIMD 0
#endif

namespace DAWCore {

constexpr float PI_F = 3.14159265358979323846f;
constexpr float TWO_PI_F = 6.28318530717958647692f;
constexpr float MIN_DB = -120.0f;
constexpr float EPSILON = 1e-6f;
constexpr size_t MAX_TRACKS = 32;
constexpr size_t MAX_CLIPS_PER_TRACK = 64;
constexpr size_t MAX_BUFFER_SIZE = 8192;
constexpr size_t SIDECHAIN_RING_SIZE = 4096;
constexpr float TARGET_SAMPLE_RATE = 48000.0f;

inline float dbToGain(float db) noexcept {
    if (db <= MIN_DB) return 0.0f;
    return std::pow(10.0f, db * 0.05f);
}

inline float gainToDb(float gain) noexcept {
    if (gain <= EPSILON) return MIN_DB;
    return 20.0f * std::log10(gain);
}

inline float clampFloat(float val, float minVal, float maxVal) noexcept {
    return std::max(minVal, std::min(maxVal, val));
}

inline void calculateConstantPowerPan(float pan, float& panL, float& panR) noexcept {
    float angle = (clampFloat(pan, -1.0f, 1.0f) + 1.0f) * 0.25f * PI_F;
    panL = std::cos(angle);
    panR = std::sin(angle);
}

} // namespace DAWCore
`,

  'dsp/BiquadFilter.hpp': `#pragma once

/**
 * ============================================================================
 * BiquadFilter.hpp - Каскады БИХ-фильтров 2-го порядка (Audio EQ Cookbook)
 * ============================================================================
 */

#include "AudioMath.hpp"

namespace DAWCore {

enum class BiquadFilterType {
    LowShelf,
    Peaking,
    HighShelf,
    HighPass,
    LowPass,
    BandPass
};

class BiquadFilter {
public:
    BiquadFilterType type{BiquadFilterType::Peaking};
    float frequency{1000.0f};
    float gainDb{0.0f};
    float Q{0.7071f};
    float sampleRate{48000.0f};
    bool enabled{true};

    float b0{1.0f}, b1{0.0f}, b2{0.0f}, a1{0.0f}, a2{0.0f};
    float x1L{0.0f}, x2L{0.0f}, y1L{0.0f}, y2L{0.0f};
    float x1R{0.0f}, x2R{0.0f}, y1R{0.0f}, y2R{0.0f};

    BiquadFilter() noexcept;
    void resetState() noexcept;
    void updateCoefficients() noexcept;
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

class ParametricEQ3Band {
public:
    BiquadFilter lowShelf;
    BiquadFilter peaking;
    BiquadFilter highShelf;
    bool enabled{true};

    ParametricEQ3Band() noexcept;
    void updateAll(float sr) noexcept;
    void reset() noexcept;
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

} // namespace DAWCore
`,

  'dsp/BiquadFilter.cpp': `#include "BiquadFilter.hpp"
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
            rawB2 = A * ((A + 1.0f) - (A - 1.0f) * cs - beta * sn);
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
    if ((type == BiquadFilterType::Peaking ||
         type == BiquadFilterType::LowShelf ||
         type == BiquadFilterType::HighShelf) && std::abs(gainDb) < 0.01f) {
        return;
    }

#if USE_WASM_SIMD
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

        v128_t vOut = wasm_f32x4_mul(vB0, vIn);
        vOut = wasm_f32x4_add(vOut, wasm_f32x4_mul(vB1, vX1));
        vOut = wasm_f32x4_add(vOut, wasm_f32x4_mul(vB2, vX2));
        vOut = wasm_f32x4_sub(vOut, wasm_f32x4_mul(vA1, vY1));
        vOut = wasm_f32x4_sub(vOut, wasm_f32x4_mul(vA2, vY2));

        vX2 = vX1; vX1 = vIn;
        vY2 = vY1; vY1 = vOut;

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
`,

  'dsp/Dynamics.hpp': `#pragma once

/**
 * ============================================================================
 * Dynamics.hpp - Динамическая обработка звука (RT-Safe, C++17)
 * ============================================================================
 */

#include "AudioMath.hpp"

namespace DAWCore {

enum class GateState {
    Closed, Opening, Open, Holding, Closing
};

class NoiseGate {
public:
    float thresholdDb{-45.0f};
    float attackMs{1.5f};
    float holdMs{50.0f};
    float releaseMs{80.0f};
    float floorDb{-70.0f};
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentGain{1.0f};

    GateState state{GateState::Closed};
    size_t holdSamplesCounter{0};
    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float envelope{0.0f};

    NoiseGate() noexcept;
    void setup(float sr) noexcept;
    void reset() noexcept;
    void updateConstants() noexcept;
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

class SoftKneeCompressor {
public:
    float thresholdDb{-18.0f};
    float ratio{3.5f};
    float attackMs{10.0f};
    float releaseMs{100.0f};
    float makeupGainDb{2.0f};
    float kneeDb{6.0f};
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentGainReduction{1.0f};

    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float envelopeGain{1.0f};

    SoftKneeCompressor() noexcept;
    void setup(float sr) noexcept;
    void reset() noexcept;
    void updateTimeConstants() noexcept;
    float computeGainReductionDb(float inDb) const noexcept;
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

class AutoDucker {
public:
    float thresholdDb{-30.0f};
    float duckDepthDb{-12.0f};
    float attackMs{15.0f};
    float releaseMs{350.0f};
    float sampleRate{48000.0f};
    bool enabled{false};
    uint32_t sourceTrackId{0};
    float currentDuckingGain{1.0f};

    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float envelope{1.0f};

    AutoDucker() noexcept;
    void setup(float sr) noexcept;
    void reset() noexcept;
    void updateConstants() noexcept;
    void processBufferWithSidechain(float* interleavedBuffer, const float* sidechainMono, size_t numFrames) noexcept;
    void processBufferWithSidechainStereo(float* interleavedBuffer, const float* sidechainStereo, size_t numFrames) noexcept;
};

class SoftLimiter {
public:
    float ceilingDb{-0.1f};
    bool enabled{true};
    SoftLimiter() noexcept = default;
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

} // namespace DAWCore
`,

  'vocal/VocalRack.hpp': `#pragma once

/**
 * ============================================================================
 * VocalRack.hpp - Вокальный процессорный рэк студийного качества (C++17)
 * ============================================================================
 */

#include "../dsp/AudioMath.hpp"
#include "../dsp/BiquadFilter.hpp"
#include "../dsp/Dynamics.hpp"
#include <array>

namespace DAWCore {

class DeClicker {
public:
    float threshold{0.08f};
    size_t repairWindow{4};
    bool enabled{true};
    uint32_t clicksDetected{0};

    static constexpr size_t HIST_SIZE = 8;
    std::array<float, HIST_SIZE> histL{};
    std::array<float, HIST_SIZE> histR{};

    DeClicker() noexcept;
    void reset() noexcept;
    static inline float hermiteInterpolate(float p0, float m0, float p1, float m1, float t) noexcept {
        float t2 = t * t, t3 = t2 * t;
        return (2.0f*t3 - 3.0f*t2 + 1.0f)*p0 + (t3 - 2.0f*t2 + t)*m0 + (-2.0f*t3 + 3.0f*t2)*p1 + (t3 - t2)*m1;
    }
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

class DePlosive {
public:
    float thresholdDb{-24.0f};
    float frequency{80.0f};
    float attackMs{2.0f};
    float releaseMs{50.0f};
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentReduction{0.0f};

    float b0{1.0f}, b1{0.0f}, b2{0.0f}, a1{0.0f}, a2{0.0f};
    float hpfX1L{0.0f}, hpfX2L{0.0f}, hpfY1L{0.0f}, hpfY2L{0.0f};
    float hpfX1R{0.0f}, hpfX2R{0.0f}, hpfY1R{0.0f}, hpfY2R{0.0f};

    float lpB0{0.0f}, lpB1{0.0f}, lpB2{0.0f}, lpA1{0.0f}, lpA2{0.0f};
    float lpX1L{0.0f}, lpX2L{0.0f}, lpY1L{0.0f}, lpY2L{0.0f};
    float lpX1R{0.0f}, lpX2R{0.0f}, lpY1R{0.0f}, lpY2R{0.0f};

    float attackCoeff{0.0f}, releaseCoeff{0.0f}, subEnvelope{0.0f};

    DePlosive() noexcept;
    void setup(float sr) noexcept;
    void reset() noexcept;
    void updateCoefficients() noexcept;
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

class DeEsser {
public:
    float thresholdDb{-22.0f};
    float frequency{6000.0f};
    float ratio{4.0f};
    float attackMs{1.0f};
    float releaseMs{40.0f};
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentGainReductionDb{0.0f};

    float b0{0.0f}, b1{0.0f}, b2{0.0f}, a1{0.0f}, a2{0.0f};
    float bpX1L{0.0f}, bpX2L{0.0f}, bpY1L{0.0f}, bpY2L{0.0f};
    float bpX1R{0.0f}, bpX2R{0.0f}, bpY1R{0.0f}, bpY2R{0.0f};
    float attackCoeff{0.0f}, releaseCoeff{0.0f}, essEnvelope{0.0f};

    DeEsser() noexcept;
    void setup(float sr) noexcept;
    void reset() noexcept;
    void updateCoefficients() noexcept;
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

class VocalRack {
public:
    DeClicker deClicker;
    DePlosive dePlosive;
    NoiseGate noiseGate;
    ParametricEQ3Band eq;
    DeEsser deEsser;
    SoftKneeCompressor compressor;
    AutoDucker autoDucker;

    VocalRack() noexcept = default;
    void setup(float sampleRate) noexcept;
    void reset() noexcept;
    void process(float* interleavedBuffer, const float* sidechainMono, size_t numFrames) noexcept;
};

} // namespace DAWCore
`,

  'engine/Track.hpp': `#pragma once

/**
 * ============================================================================
 * Track.hpp - Аудиодорожка микшера DAW (C++17, RT-Safe)
 * ============================================================================
 */

#include "Clip.hpp"
#include "../dsp/AudioMath.hpp"
#include "../dsp/BiquadFilter.hpp"
#include "../dsp/Dynamics.hpp"
#include "../vocal/VocalRack.hpp"
#include <string>
#include <vector>

namespace DAWCore {

class Track {
public:
    uint32_t id{0};
    std::string name{"Track"};
    float volumeDb{0.0f};
    float pan{0.0f};
    bool solo{false};
    bool mute{false};
    float sampleRate{48000.0f};

    std::vector<Clip> clips;
    VocalRack vocalRack;

    DeClicker& deClicker;
    DePlosive& dePlosive;
    NoiseGate& noiseGate;
    ParametricEQ3Band& eq;
    DeEsser& deEsser;
    SoftKneeCompressor& compressor;
    AutoDucker& autoDucker;

    alignas(16) float trackBuffer[MAX_BUFFER_SIZE * 2]{};

    Track(uint32_t trackId = 0, std::string trackName = "Track", float sr = 48000.0f);
    void setSampleRate(float sr) noexcept;
    void addClip(const Clip& clip);
    void clearClips() noexcept;
    bool removeClip(uint32_t clipId) noexcept;
    void renderClipsToBuffer(size_t timelinePosition, size_t numFrames) noexcept;
    void processVocalRack(const float* sidechainMono, size_t numFrames) noexcept;
    void applyFaderAndPan(size_t numFrames) noexcept;
};

} // namespace DAWCore
`,

  'engine/Mixer.hpp': `#pragma once

/**
 * ============================================================================
 * Mixer.hpp - Главный микшер и звуковой движок DAW (C++17, RT-Safe)
 * ============================================================================
 */

#include "Track.hpp"
#include "../dsp/AudioMath.hpp"
#include "../dsp/AudioUtils.hpp"
#include "../dsp/Dynamics.hpp"
#include <vector>
#include <memory>

namespace DAWCore {

class Mixer {
public:
    float sampleRate{48000.0f};
    float masterVolumeDb{0.0f};
    float masterPan{0.0f};
    size_t currentTimelineSample{0};
    SoftLimiter masterLimiter;

    std::vector<std::unique_ptr<Track>> tracks;
    alignas(16) float sidechainMonoBuffer[MAX_BUFFER_SIZE]{};
    alignas(16) float masterMixBuffer[MAX_BUFFER_SIZE * 2]{};

    explicit Mixer(float sr = 48000.0f);
    void setSampleRate(float sr) noexcept;
    void setTimelinePosition(size_t pos) noexcept;
    void addTrack(Track* track);
    Track* getTrack(uint32_t trackId) noexcept;
    void removeAllTracks() noexcept;
    void processBlock(float* outputBuffer, size_t numFrames) noexcept;
    size_t renderProjectOffline(float* outputBuffer, size_t maxFrames, int isolateTrackId = 0) noexcept;
    void autoMatchAllTracks(float targetRmsDb = -18.0f, float maxPeakDb = -1.0f) noexcept;
};

} // namespace DAWCore
`,

  'editing/WSOLATimeStretch.hpp': `#pragma once

/**
 * ============================================================================
 * WSOLATimeStretch.hpp - Алгоритм Waveform Similarity Overlap-Add (C++17, SIMD)
 * ============================================================================
 * Высокопроизводительное растяжение и сжатие звука во времени без изменения
 * высоты тона (Pitch-Preserving Time Scale Modification) для WebAssembly.
 *
 * Архитектурные особенности:
 * 1. Сохранение естественного тембра и формант (Pitch Preservation).
 * 2. Аппаратная векторизация взаимной корреляции через WASM SIMD128 (-msimd128).
 * 3. Поддержка моно и чередующихся (interleaved) стереобуферов.
 * 4. Фазосинхронный стереопроцессинг (Cross-Correlation по Mono-миксу,
 *    гарантирующий отсутствие фазовых искажений и гребенчатой фильтрации).
 * 5. Диапазон изменения скорости: от 0.5x (сжатие в 2 раза) до 2.0x (замедление).
 * ============================================================================
 */

#include "../dsp/AudioMath.hpp"
#include <cstdint>
#include <cstddef>
#include <vector>

namespace DAWCore {

class WSOLATimeStretch {
public:
    static constexpr size_t DEFAULT_WINDOW_SIZE = 1024; // ~21.3 мс при 48 кГц
    static constexpr float MIN_STRETCH_RATIO = 0.5f;     // Ускорение 2x
    static constexpr float MAX_STRETCH_RATIO = 2.0f;     // Замедление 2x

    static void generateHanningWindow(float* window, size_t size) noexcept;
    static size_t calculateOutputFrames(size_t inputFrames, float ratio) noexcept;

    static int findBestDeltaSIMD(
        const float* input,
        const float* templateBuf,
        size_t inFrames,
        int targetAnPos,
        int deltaMax,
        size_t windowSize
    ) noexcept;

    static size_t processMono(
        const float* input,
        size_t inFrames,
        float* output,
        size_t maxOutFrames,
        float ratio,
        size_t windowSize = DEFAULT_WINDOW_SIZE
    );

    static size_t processStereoInterleaved(
        const float* input,
        size_t inFrames,
        float* output,
        size_t maxOutFrames,
        float ratio,
        size_t windowSize = DEFAULT_WINDOW_SIZE
    );

    static std::vector<float> processBuffer(
        const float* input,
        size_t inFrames,
        float ratio,
        bool isStereo = true
    );
};

} // namespace DAWCore
`,

  'editing/WSOLATimeStretch.cpp': `#include "WSOLATimeStretch.hpp"
#include <cmath>
#include <cstring>
#include <algorithm>

namespace DAWCore {

void WSOLATimeStretch::generateHanningWindow(float* window, size_t size) noexcept {
    if (!window || size == 0) return;
    if (size == 1) {
        window[0] = 1.0f;
        return;
    }
    float invSizeMinus1 = 1.0f / static_cast<float>(size - 1);
    for (size_t i = 0; i < size; ++i) {
        window[i] = 0.5f * (1.0f - std::cos(TWO_PI_F * static_cast<float>(i) * invSizeMinus1));
    }
}

size_t WSOLATimeStretch::calculateOutputFrames(size_t inputFrames, float ratio) noexcept {
    if (inputFrames == 0) return 0;
    float safeRatio = clampFloat(ratio, MIN_STRETCH_RATIO, MAX_STRETCH_RATIO);
    return std::max(static_cast<size_t>(512), static_cast<size_t>(std::round(static_cast<float>(inputFrames) * safeRatio)));
}

int WSOLATimeStretch::findBestDeltaSIMD(
    const float* input,
    const float* templateBuf,
    size_t inFrames,
    int targetAnPos,
    int deltaMax,
    size_t windowSize
) noexcept {
    int minDelta = std::max(-deltaMax, -targetAnPos);
    int maxDelta = std::min(deltaMax, static_cast<int>(inFrames) - targetAnPos - static_cast<int>(windowSize));

    if (minDelta > maxDelta) return 0;

    int bestDelta = minDelta;
    float bestCorr = -1e9f;

    for (int d = minDelta; d <= maxDelta; d += 2) {
        const float* sPtr = input + targetAnPos + d;
        const float* tPtr = templateBuf;

#if USE_WASM_SIMD
        v128_t vCorr = wasm_f32x4_splat(0.0f);
        v128_t vEnergy = wasm_f32x4_splat(0.0f);

        size_t i = 0;
        for (; i + 4 <= windowSize; i += 4) {
            v128_t s = wasm_v128_load(sPtr + i);
            v128_t t = wasm_v128_load(tPtr + i);
            vCorr = wasm_f32x4_add(vCorr, wasm_f32x4_mul(s, t));
            vEnergy = wasm_f32x4_add(vEnergy, wasm_f32x4_mul(s, s));
        }

        alignas(16) float cArr[4], eArr[4];
        wasm_v128_store(cArr, vCorr);
        wasm_v128_store(eArr, vEnergy);

        float corr = cArr[0] + cArr[1] + cArr[2] + cArr[3];
        float energy = eArr[0] + eArr[1] + eArr[2] + eArr[3] + 1e-5f;

        for (; i < windowSize; ++i) {
            float s = sPtr[i];
            corr += s * tPtr[i];
            energy += s * s;
        }
#else
        float corr = 0.0f;
        float energy = 1e-5f;
        for (size_t i = 0; i < windowSize; ++i) {
            float s = sPtr[i];
            corr += s * tPtr[i];
            energy += s * s;
        }
#endif

        float normCorr = corr / std::sqrt(energy);
        if (normCorr > bestCorr) {
            bestCorr = normCorr;
            bestDelta = d;
        }
    }

    // Локальное уточнение окрестности bestDelta
    for (int dOffset : {-1, 1}) {
        int d = bestDelta + dOffset;
        if (d < minDelta || d > maxDelta) continue;

        const float* sPtr = input + targetAnPos + d;
        const float* tPtr = templateBuf;

        float corr = 0.0f;
        float energy = 1e-5f;
        for (size_t i = 0; i < windowSize; i += 2) {
            float s = sPtr[i];
            corr += s * tPtr[i];
            energy += s * s;
        }

        float normCorr = corr / std::sqrt(energy);
        if (normCorr > bestCorr) {
            bestCorr = normCorr;
            bestDelta = d;
        }
    }

    return bestDelta;
}

size_t WSOLATimeStretch::processMono(
    const float* input,
    size_t inFrames,
    float* output,
    size_t maxOutFrames,
    float ratio,
    size_t windowSize
) {
    if (!input || !output || inFrames == 0 || maxOutFrames == 0) return 0;

    float safeRatio = clampFloat(ratio, MIN_STRETCH_RATIO, MAX_STRETCH_RATIO);
    if (std::abs(safeRatio - 1.0f) < 0.002f) {
        size_t copyLen = std::min(inFrames, maxOutFrames);
        std::memcpy(output, input, copyLen * sizeof(float));
        return copyLen;
    }

    size_t N = (windowSize < 256) ? DEFAULT_WINDOW_SIZE : windowSize;
    size_t Hs = N / 4;
    float Ha = static_cast<float>(Hs) / safeRatio;
    int deltaMax = static_cast<int>(N / 2);

    size_t outFrames = calculateOutputFrames(inFrames, safeRatio);
    outFrames = std::min(outFrames, maxOutFrames);

    std::vector<float> win(N);
    generateHanningWindow(win.data(), N);

    std::vector<float> templateBuf(N, 0.0f);
    std::vector<float> windowWeight(outFrames, 0.0f);
    std::memset(output, 0, outFrames * sizeof(float));

    size_t firstCopyLen = std::min(N, inFrames);
    for (size_t i = 0; i < firstCopyLen && i < outFrames; ++i) {
        float w = win[i];
        output[i] += input[i] * w;
        windowWeight[i] += w;
    }

    size_t outPos = Hs;
    size_t frameIdx = 1;

    while (outPos + N <= outFrames) {
        int targetAnPos = static_cast<int>(std::round(static_cast<float>(frameIdx) * Ha));
        int prevAnPos = static_cast<int>(std::round(static_cast<float>(frameIdx - 1) * Ha));

        for (size_t i = 0; i < N; ++i) {
            size_t srcIdx = static_cast<size_t>(prevAnPos) + Hs + i;
            templateBuf[i] = (srcIdx < inFrames) ? input[srcIdx] : 0.0f;
        }

        int bestDelta = findBestDeltaSIMD(input, templateBuf.data(), inFrames, targetAnPos, deltaMax, N);
        int actualAnPos = targetAnPos + bestDelta;

        for (size_t i = 0; i < N; ++i) {
            int srcIdx = actualAnPos + static_cast<int>(i);
            if (srcIdx >= 0 && srcIdx < static_cast<int>(inFrames)) {
                float w = win[i];
                output[outPos + i] += input[srcIdx] * w;
                windowWeight[outPos + i] += w;
            }
        }

        outPos += Hs;
        frameIdx++;
    }

    for (size_t i = 0; i < outFrames; ++i) {
        float w = windowWeight[i];
        if (w > 1e-4f) {
            output[i] /= w;
        }
    }

    return outFrames;
}

size_t WSOLATimeStretch::processStereoInterleaved(
    const float* input,
    size_t inFrames,
    float* output,
    size_t maxOutFrames,
    float ratio,
    size_t windowSize
) {
    if (!input || !output || inFrames == 0 || maxOutFrames == 0) return 0;

    float safeRatio = clampFloat(ratio, MIN_STRETCH_RATIO, MAX_STRETCH_RATIO);
    if (std::abs(safeRatio - 1.0f) < 0.002f) {
        size_t copyFrames = std::min(inFrames, maxOutFrames);
        std::memcpy(output, input, copyFrames * 2 * sizeof(float));
        return copyFrames;
    }

    std::vector<float> monoMix(inFrames);
    for (size_t i = 0; i < inFrames; ++i) {
        monoMix[i] = 0.5f * (input[i * 2] + input[i * 2 + 1]);
    }

    size_t N = (windowSize < 256) ? DEFAULT_WINDOW_SIZE : windowSize;
    size_t Hs = N / 4;
    float Ha = static_cast<float>(Hs) / safeRatio;
    int deltaMax = static_cast<int>(N / 2);

    size_t outFrames = calculateOutputFrames(inFrames, safeRatio);
    outFrames = std::min(outFrames, maxOutFrames);

    std::vector<float> win(N);
    generateHanningWindow(win.data(), N);

    std::vector<float> templateBuf(N, 0.0f);
    std::vector<float> windowWeight(outFrames, 0.0f);
    std::memset(output, 0, outFrames * 2 * sizeof(float));

    size_t firstCopyLen = std::min(N, inFrames);
    for (size_t i = 0; i < firstCopyLen && i < outFrames; ++i) {
        float w = win[i];
        output[i * 2]     += input[i * 2] * w;
        output[i * 2 + 1] += input[i * 2 + 1] * w;
        windowWeight[i]   += w;
    }

    size_t outPos = Hs;
    size_t frameIdx = 1;

    while (outPos + N <= outFrames) {
        int targetAnPos = static_cast<int>(std::round(static_cast<float>(frameIdx) * Ha));
        int prevAnPos = static_cast<int>(std::round(static_cast<float>(frameIdx - 1) * Ha));

        for (size_t i = 0; i < N; ++i) {
            size_t srcIdx = static_cast<size_t>(prevAnPos) + Hs + i;
            templateBuf[i] = (srcIdx < inFrames) ? monoMix[srcIdx] : 0.0f;
        }

        int bestDelta = findBestDeltaSIMD(monoMix.data(), templateBuf.data(), inFrames, targetAnPos, deltaMax, N);
        int actualAnPos = targetAnPos + bestDelta;

        for (size_t i = 0; i < N; ++i) {
            int srcFrame = actualAnPos + static_cast<int>(i);
            if (srcFrame >= 0 && srcFrame < static_cast<int>(inFrames)) {
                float w = win[i];
                size_t outIdx = (outPos + i) * 2;
                size_t inIdx = static_cast<size_t>(srcFrame) * 2;

                output[outIdx]     += input[inIdx] * w;
                output[outIdx + 1] += input[inIdx + 1] * w;
                windowWeight[outPos + i] += w;
            }
        }

        outPos += Hs;
        frameIdx++;
    }

    for (size_t i = 0; i < outFrames; ++i) {
        float w = windowWeight[i];
        if (w > 1e-4f) {
            output[i * 2]     /= w;
            output[i * 2 + 1] /= w;
        }
    }

    return outFrames;
}

std::vector<float> WSOLATimeStretch::processBuffer(
    const float* input,
    size_t inFrames,
    float ratio,
    bool isStereo
) {
    if (!input || inFrames == 0) return {};

    size_t outFrames = calculateOutputFrames(inFrames, ratio);
    size_t channels = isStereo ? 2 : 1;
    std::vector<float> result(outFrames * channels);

    if (isStereo) {
        size_t actualFrames = processStereoInterleaved(input, inFrames, result.data(), outFrames, ratio);
        result.resize(actualFrames * 2);
    } else {
        size_t actualFrames = processMono(input, inFrames, result.data(), outFrames, ratio);
        result.resize(actualFrames);
    }

    return result;
}

} // namespace DAWCore
`,

  'editing/ClipEditor.hpp': `#pragma once

/**
 * ============================================================================
 * ClipEditor.hpp - Модуль нарезки и редактирования аудиоклипов в WASM (C++17)
 * ============================================================================
 * Обеспечивает выполнение ресурсоемких операций редактирования непосредственно
 * в памяти C++ / WebAssembly:
 * 1. Split (разделение клипа) с расчетом антикликовых микро-фейдов без копирования сэмплов через JS.
 * 2. Trim (подрезка границ In/Out).
 * 3. WSOLA Time Stretch прямо в памяти буфера клипа с обновлением его длины.
 * ============================================================================
 */

#include "WSOLATimeStretch.hpp"
#include "../engine/Clip.hpp"
#include "../engine/Track.hpp"
#include "../engine/Mixer.hpp"
#include <cstdint>
#include <cstddef>
#include <vector>

namespace DAWCore {

class ClipSliceManager {
public:
    static Mixer* s_activeMixer;
    static std::vector<float*> s_allocatedBuffers;

    static void setActiveMixer(Mixer* mixer) noexcept;
    static Mixer* getActiveMixer() noexcept;

    static uintptr_t splitClip(uintptr_t clipPtr, size_t splitSampleOffset);

    static bool splitClipInTrack(
        uint32_t trackId,
        uint32_t clipId,
        size_t splitSampleOffset,
        uint32_t newClipId = 0
    );

    static uintptr_t applyTimeStretchToClip(
        uint32_t trackId,
        uint32_t clipId,
        float ratio
    );

    static uintptr_t applyTimeStretchToClipPtr(Clip* clip, float ratio);
    static bool trimClipStart(uintptr_t clipPtr, size_t trimSamples);
    static bool trimClipEnd(uintptr_t clipPtr, size_t newLengthSamples);
    static void freeAllocatedBuffers() noexcept;
};

} // namespace DAWCore
`,

  'editing/ClipEditor.cpp': `#include "ClipEditor.hpp"
#include <algorithm>
#include <cstring>

namespace DAWCore {

Mixer* ClipSliceManager::s_activeMixer = nullptr;
std::vector<float*> ClipSliceManager::s_allocatedBuffers;

void ClipSliceManager::setActiveMixer(Mixer* mixer) noexcept {
    s_activeMixer = mixer;
}

Mixer* ClipSliceManager::getActiveMixer() noexcept {
    return s_activeMixer;
}

uintptr_t ClipSliceManager::splitClip(uintptr_t clipPtr, size_t splitSampleOffset) {
    if (clipPtr == 0) return 0;
    Clip* leftClip = reinterpret_cast<Clip*>(clipPtr);
    if (!leftClip || !leftClip->sampleBuffer) return 0;

    size_t origLen = leftClip->lengthSamples;
    if (splitSampleOffset == 0 || splitSampleOffset >= origLen) {
        return 0;
    }

    size_t chMultiplier = leftClip->isStereo ? 2 : 1;
    leftClip->lengthSamples = splitSampleOffset;

    size_t leftMicroFade = std::min(static_cast<size_t>(256), splitSampleOffset / 4);
    if (leftClip->fadeOutSamples == 0 || leftClip->fadeOutSamples > leftMicroFade) {
        leftClip->fadeOutSamples = leftMicroFade;
    }

    Clip* rightClip = new Clip();
    rightClip->id = leftClip->id + 10000;
    rightClip->sampleBuffer = leftClip->sampleBuffer + splitSampleOffset * chMultiplier;
    rightClip->bufferSizeSamples = (leftClip->bufferSizeSamples > splitSampleOffset)
        ? (leftClip->bufferSizeSamples - splitSampleOffset)
        : (origLen - splitSampleOffset);
    rightClip->offsetSamples = leftClip->offsetSamples + splitSampleOffset;
    rightClip->lengthSamples = origLen - splitSampleOffset;

    size_t rightMicroFade = std::min(static_cast<size_t>(256), rightClip->lengthSamples / 4);
    rightClip->fadeInSamples = rightMicroFade;
    rightClip->fadeOutSamples = leftClip->fadeOutSamples;

    rightClip->gain = leftClip->gain;
    rightClip->pan = leftClip->pan;
    rightClip->isStereo = leftClip->isStereo;
    rightClip->active = leftClip->active;

    return reinterpret_cast<uintptr_t>(rightClip);
}

bool ClipSliceManager::splitClipInTrack(
    uint32_t trackId,
    uint32_t clipId,
    size_t splitSampleOffset,
    uint32_t newClipId
) {
    if (!s_activeMixer) return false;
    Track* track = s_activeMixer->getTrack(trackId);
    if (!track) return false;

    Clip* leftClip = track->getClip(clipId);
    if (!leftClip || !leftClip->sampleBuffer) return false;

    size_t origLen = leftClip->lengthSamples;
    if (splitSampleOffset == 0 || splitSampleOffset >= origLen) {
        return false;
    }

    size_t chMultiplier = leftClip->isStereo ? 2 : 1;
    leftClip->lengthSamples = splitSampleOffset;
    size_t leftMicroFade = std::min(static_cast<size_t>(256), splitSampleOffset / 4);
    if (leftClip->fadeOutSamples == 0 || leftClip->fadeOutSamples > leftMicroFade) {
        leftClip->fadeOutSamples = leftMicroFade;
    }

    Clip rightClip;
    rightClip.id = (newClipId != 0) ? newClipId : (clipId + 1000);
    rightClip.sampleBuffer = leftClip->sampleBuffer + splitSampleOffset * chMultiplier;
    rightClip.bufferSizeSamples = (leftClip->bufferSizeSamples > splitSampleOffset)
        ? (leftClip->bufferSizeSamples - splitSampleOffset)
        : (origLen - splitSampleOffset);
    rightClip.offsetSamples = leftClip->offsetSamples + splitSampleOffset;
    rightClip.lengthSamples = origLen - splitSampleOffset;

    size_t rightMicroFade = std::min(static_cast<size_t>(256), rightClip.lengthSamples / 4);
    rightClip.fadeInSamples = rightMicroFade;
    rightClip.fadeOutSamples = leftClip->fadeOutSamples;
    rightClip.gain = leftClip->gain;
    rightClip.pan = leftClip->pan;
    rightClip.isStereo = leftClip->isStereo;
    rightClip.active = leftClip->active;

    track->addClip(rightClip);
    return true;
}

uintptr_t ClipSliceManager::applyTimeStretchToClip(
    uint32_t trackId,
    uint32_t clipId,
    float ratio
) {
    if (!s_activeMixer) return 0;
    Track* track = s_activeMixer->getTrack(trackId);
    if (!track) return 0;

    Clip* clip = track->getClip(clipId);
    if (!clip) return 0;

    return applyTimeStretchToClipPtr(clip, ratio);
}

uintptr_t ClipSliceManager::applyTimeStretchToClipPtr(Clip* clip, float ratio) {
    if (!clip || !clip->sampleBuffer || clip->lengthSamples == 0) return 0;

    float safeRatio = clampFloat(ratio, WSOLATimeStretch::MIN_STRETCH_RATIO, WSOLATimeStretch::MAX_STRETCH_RATIO);

    std::vector<float> stretched = WSOLATimeStretch::processBuffer(
        clip->sampleBuffer,
        clip->lengthSamples,
        safeRatio,
        clip->isStereo
    );

    if (stretched.empty()) return 0;

    float* newBuffer = new float[stretched.size()];
    std::memcpy(newBuffer, stretched.data(), stretched.size() * sizeof(float));

    s_allocatedBuffers.push_back(newBuffer);

    clip->sampleBuffer = newBuffer;
    size_t newFrames = clip->isStereo ? (stretched.size() / 2) : stretched.size();
    clip->lengthSamples = newFrames;
    clip->bufferSizeSamples = newFrames;

    return reinterpret_cast<uintptr_t>(newBuffer);
}

bool ClipSliceManager::trimClipStart(uintptr_t clipPtr, size_t trimSamples) {
    if (clipPtr == 0) return false;
    Clip* clip = reinterpret_cast<Clip*>(clipPtr);
    if (!clip || !clip->sampleBuffer || trimSamples >= clip->lengthSamples) return false;

    size_t chMultiplier = clip->isStereo ? 2 : 1;
    clip->sampleBuffer += trimSamples * chMultiplier;
    clip->offsetSamples += trimSamples;
    clip->lengthSamples -= trimSamples;
    if (clip->bufferSizeSamples > trimSamples) {
        clip->bufferSizeSamples -= trimSamples;
    }

    size_t microFade = std::min(static_cast<size_t>(256), clip->lengthSamples / 4);
    clip->fadeInSamples = microFade;
    return true;
}

bool ClipSliceManager::trimClipEnd(uintptr_t clipPtr, size_t newLengthSamples) {
    if (clipPtr == 0) return false;
    Clip* clip = reinterpret_cast<Clip*>(clipPtr);
    if (!clip || newLengthSamples == 0 || newLengthSamples > clip->lengthSamples) return false;

    clip->lengthSamples = newLengthSamples;
    size_t microFade = std::min(static_cast<size_t>(256), newLengthSamples / 4);
    if (clip->fadeOutSamples == 0 || clip->fadeOutSamples > microFade) {
        clip->fadeOutSamples = microFade;
    }
    return true;
}

void ClipSliceManager::freeAllocatedBuffers() noexcept {
    for (float* buf : s_allocatedBuffers) {
        delete[] buf;
    }
    s_allocatedBuffers.clear();
}

} // namespace DAWCore
`,

  'analysis/SpeechAligner.hpp': `#pragma once

/**
 * ============================================================================
 * SpeechAligner.hpp - Модуль смарт-анализа речи, VAD и выравнивания сценария
 * ============================================================================
 * Стандарт: C++17. Аппаратная векторизация WebAssembly SIMD128.
 * 
 * Компоненты:
 * 1. FastLevenshtein:
 *    - Полноценная поддержка UTF-8 (латиница и кириллица а-я, ё).
 *    - Нормализация регистра и удаление знаков препинания без сторонних библиотек.
 *    - Матричный расчет расстояния Левенштейна с оптимизацией памяти O(min(M, N)).
 *    - Расчет метрики схожести (similarity score) в диапазоне [0.0 .. 1.0].
 * 
 * 2. SpeechEnergyDetector:
 *    - Векторный расчет RMS энергии и Zero-Crossing Rate (ZCR) через SIMD128.
 *    - Оценка вероятности присутствия речевого сигнала (Voice Probability).
 *    - Автономный Voice Activity Detector (VAD) с настраиваемым гистерезисом.
 * 
 * 3. SmartAligner:
 *    - Сопоставление реплик сценария (SRT/ASS) с сегментами аудио и транскрипцией.
 *    - Расчет временного дрейфа (Time Drift) и классификация статусов.
 * ============================================================================
 */

#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>
#include <cmath>
#include <algorithm>

#include "../dsp/AudioMath.hpp"

namespace DAWCore {

struct FrameEnergyStats {
    float rms{0.0f};
    float zcrRatio{0.0f};
    float voiceProbability{0.0f};
    float peak{0.0f};
};

struct VADConfig {
    float sampleRate{16000.0f};
    float threshold{0.5f};
    float minSpeechDurationMs{200.0f};
    float minSilenceDurationMs{300.0f};
    float speechPadMs{100.0f};
};

struct SpeechSegment {
    uint32_t id{0};
    size_t startSample{0};
    size_t endSample{0};
    float startSec{0.0f};
    float endSec{0.0f};
    float durationSec{0.0f};
    float confidence{0.0f};
};

struct ScriptLine {
    int index{0};
    float startSec{0.0f};
    float endSec{0.0f};
    std::string text;
    std::string speaker;
};

struct TranscriptionSegment {
    int id{0};
    float startSec{0.0f};
    float endSec{0.0f};
    std::string text;
    float confidence{1.0f};
};

struct AlignedPhrase {
    int lineIndex{0};
    std::string scriptText;
    std::string recognizedText;
    float expectedStartSec{0.0f};
    float expectedEndSec{0.0f};
    float actualStartSec{0.0f};
    float actualEndSec{0.0f};
    float timeDriftSec{0.0f};
    float similarityScore{0.0f};
    std::string status;
};

class FastLevenshtein {
public:
    static std::vector<uint32_t> normalizeUtf8(const std::string& str);
    static size_t distance(const std::string& s1, const std::string& s2);
    static float similarity(const std::string& s1, const std::string& s2);
    static size_t distanceCodepoints(const std::vector<uint32_t>& v1, const std::vector<uint32_t>& v2);
};

class SpeechEnergyDetector {
public:
    static FrameEnergyStats calculateFrameStats(const float* samples, size_t length) noexcept;
    static float calculateVoiceProbability(const float* samples, size_t length) noexcept;
    static std::vector<SpeechSegment> detectSegments(
        const float* audio,
        size_t totalSamples,
        float sampleRate,
        const VADConfig& config = VADConfig{}
    );
};

class SmartAligner {
public:
    static std::vector<AlignedPhrase> align(
        const std::vector<ScriptLine>& scriptLines,
        const std::vector<SpeechSegment>& speechSegments,
        const std::vector<TranscriptionSegment>& transcriptionSegments = {}
    );
};

} // namespace DAWCore
`,

  'analysis/SpeechAligner.cpp': `/**
 * ============================================================================
 * SpeechAligner.cpp - Реализация алгоритмов Levenshtein, VAD и Smart Align
 * ============================================================================
 * Полный исходный код без внешних зависимостей.
 * Поддержка WebAssembly SIMD128 и компиляции C++17.
 * ============================================================================
 */

#include "SpeechAligner.hpp"
#include <iomanip>
#include <sstream>

namespace DAWCore {

std::vector<uint32_t> FastLevenshtein::normalizeUtf8(const std::string& str) {
    std::vector<uint32_t> result;
    result.reserve(str.size());

    const uint8_t* ptr = reinterpret_cast<const uint8_t*>(str.data());
    const size_t len = str.size();
    size_t i = 0;

    while (i < len) {
        uint32_t cp = 0;
        uint8_t byte0 = ptr[i];

        if (byte0 < 0x80) {
            cp = byte0;
            i += 1;
        } else if ((byte0 & 0xE0) == 0xC0) {
            if (i + 1 < len) {
                uint8_t byte1 = ptr[i + 1];
                cp = ((byte0 & 0x1F) << 6) | (byte1 & 0x3F);
                i += 2;
            } else {
                i += 1;
                continue;
            }
        } else if ((byte0 & 0xF0) == 0xE0) {
            if (i + 2 < len) {
                uint8_t byte1 = ptr[i + 1];
                uint8_t byte2 = ptr[i + 2];
                cp = ((byte0 & 0x0F) << 12) | ((byte1 & 0x3F) << 6) | (byte2 & 0x3F);
                i += 3;
            } else {
                i += 1;
                continue;
            }
        } else if ((byte0 & 0xF8) == 0xF0) {
            if (i + 3 < len) {
                uint8_t byte1 = ptr[i + 1];
                uint8_t byte2 = ptr[i + 2];
                uint8_t byte3 = ptr[i + 3];
                cp = ((byte0 & 0x07) << 18) | ((byte1 & 0x3F) << 12) | ((byte2 & 0x3F) << 6) | (byte3 & 0x3F);
                i += 4;
            } else {
                i += 1;
                continue;
            }
        } else {
            i += 1;
            continue;
        }

        if (cp >= 0x41 && cp <= 0x5A) {
            result.push_back(cp + 0x20);
        } else if ((cp >= 0x61 && cp <= 0x7A) || (cp >= 0x30 && cp <= 0x39) || cp == 0x5F) {
            result.push_back(cp);
        } else if (cp >= 0x0410 && cp <= 0x042F) {
            result.push_back(cp + 0x20);
        } else if (cp == 0x0401) {
            result.push_back(0x0451);
        } else if ((cp >= 0x0430 && cp <= 0x044F) || cp == 0x0451) {
            result.push_back(cp);
        }
    }

    return result;
}

size_t FastLevenshtein::distanceCodepoints(const std::vector<uint32_t>& v1, const std::vector<uint32_t>& v2) {
    const size_t len1 = v1.size();
    const size_t len2 = v2.size();

    if (len1 == 0) return len2;
    if (len2 == 0) return len1;

    const std::vector<uint32_t>& s1 = (len1 >= len2) ? v1 : v2;
    const std::vector<uint32_t>& s2 = (len1 >= len2) ? v2 : v1;
    const size_t m = s1.size();
    const size_t n = s2.size();

    std::vector<size_t> dp(n + 1);
    for (size_t j = 0; j <= n; ++j) {
        dp[j] = j;
    }

    for (size_t i = 1; i <= m; ++i) {
        size_t prevDiagonal = dp[0];
        dp[0] = i;

        for (size_t j = 1; j <= n; ++j) {
            size_t temp = dp[j];
            size_t cost = (s1[i - 1] == s2[j - 1]) ? 0 : 1;

            dp[j] = std::min({
                dp[j] + 1,
                dp[j - 1] + 1,
                prevDiagonal + cost
            });

            prevDiagonal = temp;
        }
    }

    return dp[n];
}

size_t FastLevenshtein::distance(const std::string& s1, const std::string& s2) {
    std::vector<uint32_t> norm1 = normalizeUtf8(s1);
    std::vector<uint32_t> norm2 = normalizeUtf8(s2);
    return distanceCodepoints(norm1, norm2);
}

float FastLevenshtein::similarity(const std::string& s1, const std::string& s2) {
    std::vector<uint32_t> norm1 = normalizeUtf8(s1);
    std::vector<uint32_t> norm2 = normalizeUtf8(s2);

    if (norm1.empty() && norm2.empty()) return 1.0f;
    if (norm1.empty() || norm2.empty()) return 0.0f;

    const size_t maxLen = std::max(norm1.size(), norm2.size());
    const size_t dist = distanceCodepoints(norm1, norm2);

    float sim = 1.0f - (static_cast<float>(dist) / static_cast<float>(maxLen));
    return clampFloat(sim, 0.0f, 1.0f);
}

FrameEnergyStats SpeechEnergyDetector::calculateFrameStats(const float* samples, size_t length) noexcept {
    FrameEnergyStats stats;
    if (!samples || length == 0) return stats;

    float sumSquares = 0.0f;
    float peakVal = 0.0f;
    size_t zcrCount = 0;

#if USE_WASM_SIMD
    v128_t sumVec = wasm_f32x4_splat(0.0f);
    v128_t maxVec = wasm_f32x4_splat(0.0f);

    size_t simdLimit = (length / 4) * 4;
    for (size_t i = 0; i < simdLimit; i += 4) {
        v128_t inVec = wasm_v128_load(&samples[i]);
        sumVec = wasm_f32x4_add(sumVec, wasm_f32x4_mul(inVec, inVec));
        v128_t absVec = wasm_f32x4_abs(inVec);
        maxVec = wasm_f32x4_max(maxVec, absVec);
    }

    float alignas(16) sumArr[4];
    float alignas(16) maxArr[4];
    wasm_v128_store(sumArr, sumVec);
    wasm_v128_store(maxArr, maxVec);

    sumSquares = sumArr[0] + sumArr[1] + sumArr[2] + sumArr[3];
    peakVal = std::max({maxArr[0], maxArr[1], maxArr[2], maxArr[3]});

    for (size_t i = simdLimit; i < length; ++i) {
        float val = samples[i];
        sumSquares += val * val;
        peakVal = std::max(peakVal, std::abs(val));
    }
#else
    for (size_t i = 0; i < length; ++i) {
        float val = samples[i];
        sumSquares += val * val;
        peakVal = std::max(peakVal, std::abs(val));
    }
#endif

    for (size_t i = 1; i < length; ++i) {
        float prev = samples[i - 1];
        float curr = samples[i];
        if ((curr >= 0.0f && prev < 0.0f) || (curr < 0.0f && prev >= 0.0f)) {
            zcrCount++;
        }
    }

    stats.rms = std::sqrt(sumSquares / static_cast<float>(length));
    stats.zcrRatio = static_cast<float>(zcrCount) / static_cast<float>(length);
    stats.peak = peakVal;

    if (stats.rms > 0.015f && stats.zcrRatio > 0.04f && stats.zcrRatio < 0.45f) {
        stats.voiceProbability = std::min(0.98f, 0.5f + stats.rms * 15.0f);
    } else {
        stats.voiceProbability = 0.0f;
    }

    return stats;
}

float SpeechEnergyDetector::calculateVoiceProbability(const float* samples, size_t length) noexcept {
    return calculateFrameStats(samples, length).voiceProbability;
}

std::vector<SpeechSegment> SpeechEnergyDetector::detectSegments(
    const float* audio,
    size_t totalSamples,
    float sampleRate,
    const VADConfig& config
) {
    std::vector<SpeechSegment> segments;
    if (!audio || totalSamples == 0) return segments;

    const float actualSr = (sampleRate > 1000.0f) ? sampleRate : 16000.0f;
    const size_t windowSize = std::max(static_cast<size_t>(64), static_cast<size_t>(actualSr * 0.032f));
    const size_t numChunks = totalSamples / windowSize;

    if (numChunks == 0) return segments;

    const size_t minSpeechSamples = static_cast<size_t>((config.minSpeechDurationMs / 1000.0f) * actualSr);
    const size_t minSilenceSamples = static_cast<size_t>((config.minSilenceDurationMs / 1000.0f) * actualSr);
    const size_t speechPadSamples = static_cast<size_t>((config.speechPadMs / 1000.0f) * actualSr);

    bool isSpeaking = false;
    size_t speechStartSample = 0;
    size_t silenceStartSample = 0;
    float segmentConfidenceSum = 0.0f;
    size_t segmentChunkCount = 0;

    for (size_t i = 0; i < numChunks; ++i) {
        const size_t chunkOffset = i * windowSize;
        const float* chunk = &audio[chunkOffset];

        FrameEnergyStats stats = calculateFrameStats(chunk, windowSize);
        float speechProb = stats.voiceProbability;

        if (speechProb >= config.threshold) {
            if (!isSpeaking) {
                isSpeaking = true;
                speechStartSample = (chunkOffset >= speechPadSamples) ? (chunkOffset - speechPadSamples) : 0;
                segmentConfidenceSum = 0.0f;
                segmentChunkCount = 0;
            }
            silenceStartSample = 0;
            segmentConfidenceSum += speechProb;
            segmentChunkCount++;
        } else {
            if (isSpeaking) {
                if (silenceStartSample == 0) {
                    silenceStartSample = chunkOffset;
                }

                if (chunkOffset - silenceStartSample >= minSilenceSamples) {
                    size_t speechEndSample = std::min(totalSamples, silenceStartSample + speechPadSamples);
                    size_t durationSamples = (speechEndSample > speechStartSample) ? (speechEndSample - speechStartSample) : 0;

                    if (durationSamples >= minSpeechSamples) {
                        float avgConf = (segmentChunkCount > 0) ? (segmentConfidenceSum / segmentChunkCount) : 0.85f;
                        float startSec = static_cast<float>(speechStartSample) / actualSr;
                        float endSec = static_cast<float>(speechEndSample) / actualSr;

                        SpeechSegment seg;
                        seg.id = static_cast<uint32_t>(segments.size() + 1);
                        seg.startSample = speechStartSample;
                        seg.endSample = speechEndSample;
                        seg.startSec = startSec;
                        seg.endSec = endSec;
                        seg.durationSec = endSec - startSec;
                        seg.confidence = clampFloat(avgConf, 0.0f, 1.0f);
                        segments.push_back(seg);
                    }

                    isSpeaking = false;
                    silenceStartSample = 0;
                    segmentConfidenceSum = 0.0f;
                    segmentChunkCount = 0;
                }
            }
        }
    }

    if (isSpeaking) {
        size_t speechEndSample = totalSamples;
        size_t durationSamples = (speechEndSample > speechStartSample) ? (speechEndSample - speechStartSample) : 0;

        if (durationSamples >= minSpeechSamples) {
            float avgConf = (segmentChunkCount > 0) ? (segmentConfidenceSum / segmentChunkCount) : 0.85f;
            float startSec = static_cast<float>(speechStartSample) / actualSr;
            float endSec = static_cast<float>(speechEndSample) / actualSr;

            SpeechSegment seg;
            seg.id = static_cast<uint32_t>(segments.size() + 1);
            seg.startSample = speechStartSample;
            seg.endSample = speechEndSample;
            seg.startSec = startSec;
            seg.endSec = endSec;
            seg.durationSec = endSec - startSec;
            seg.confidence = clampFloat(avgConf, 0.0f, 1.0f);
            segments.push_back(seg);
        }
    }

    return segments;
}

std::vector<AlignedPhrase> SmartAligner::align(
    const std::vector<ScriptLine>& scriptLines,
    const std::vector<SpeechSegment>& speechSegments,
    const std::vector<TranscriptionSegment>& transcriptionSegments
) {
    std::vector<AlignedPhrase> alignedResults;
    alignedResults.reserve(scriptLines.size());

    if (scriptLines.empty()) {
        return alignedResults;
    }

    if (speechSegments.empty() && transcriptionSegments.empty()) {
        for (const auto& line : scriptLines) {
            AlignedPhrase phrase;
            phrase.lineIndex = line.index;
            phrase.scriptText = line.text;
            phrase.recognizedText = "";
            phrase.expectedStartSec = line.startSec;
            phrase.expectedEndSec = line.endSec;
            phrase.actualStartSec = 0.0f;
            phrase.actualEndSec = 0.0f;
            phrase.timeDriftSec = 0.0f;
            phrase.similarityScore = 0.0f;
            phrase.status = "missing";
            alignedResults.push_back(phrase);
        }
        return alignedResults;
    }

    for (const auto& scriptLine : scriptLines) {
        const float targetMidTime = (scriptLine.startSec + scriptLine.endSec) * 0.5f;

        const TranscriptionSegment* bestAsr = nullptr;
        float bestTextScore = -1.0f;
        float minAsrTimeDiff = 1e9f;

        for (const auto& asr : transcriptionSegments) {
            const float asrMidTime = (asr.startSec + asr.endSec) * 0.5f;
            const float timeDiff = std::abs(asrMidTime - targetMidTime);

            if (timeDiff < 8.0f) {
                float sim = FastLevenshtein::similarity(scriptLine.text, asr.text);
                float combinedScore = sim * 0.7f + std::max(0.0f, (8.0f - timeDiff) / 8.0f) * 0.3f;

                if (combinedScore > bestTextScore) {
                    bestTextScore = combinedScore;
                    bestAsr = &asr;
                    minAsrTimeDiff = timeDiff;
                }
            }
        }

        const SpeechSegment* bestVad = nullptr;
        float minVadTimeDiff = 1e9f;

        for (const auto& seg : speechSegments) {
            const float segMidTime = (seg.startSec + seg.endSec) * 0.5f;
            const float timeDiff = std::abs(segMidTime - targetMidTime);

            if (timeDiff < minVadTimeDiff) {
                minVadTimeDiff = timeDiff;
                bestVad = &seg;
            }
        }

        AlignedPhrase result;
        result.lineIndex = scriptLine.index;
        result.scriptText = scriptLine.text;
        result.expectedStartSec = scriptLine.startSec;
        result.expectedEndSec = scriptLine.endSec;

        if (bestAsr && bestTextScore > 0.35f && minAsrTimeDiff < 6.0f) {
            result.recognizedText = bestAsr->text;
            result.actualStartSec = bestAsr->startSec;
            result.actualEndSec = bestAsr->endSec;
            result.timeDriftSec = bestAsr->startSec - scriptLine.startSec;
            result.similarityScore = FastLevenshtein::similarity(scriptLine.text, bestAsr->text);
            result.status = (std::abs(result.timeDriftSec) > 0.6f) ? "drifted" : "matched";
        } else if (bestVad && minVadTimeDiff < 5.0f) {
            std::ostringstream ss;
            ss << "[Голосовой сегмент " << std::fixed << std::setprecision(1) << bestVad->durationSec << "с]";
            result.recognizedText = ss.str();
            result.actualStartSec = bestVad->startSec;
            result.actualEndSec = bestVad->endSec;
            result.timeDriftSec = bestVad->startSec - scriptLine.startSec;
            result.similarityScore = 0.85f;
            result.status = (std::abs(result.timeDriftSec) > 0.6f) ? "drifted" : "matched";
        } else {
            result.recognizedText = "";
            result.actualStartSec = 0.0f;
            result.actualEndSec = 0.0f;
            result.timeDriftSec = 0.0f;
            result.similarityScore = 0.0f;
            result.status = "missing";
        }

        alignedResults.push_back(result);
    }

    return alignedResults;
}

} // namespace DAWCore
`,

  'CMakeLists.txt': `cmake_minimum_required(VERSION 3.15)
project(DAWCoreEngine VERSION 2.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(ALL_SOURCES
    dsp/BiquadFilter.cpp
    dsp/Dynamics.cpp
    dsp/AudioUtils.cpp
    vocal/VocalRack.cpp
    engine/Clip.cpp
    engine/Track.cpp
    engine/Mixer.cpp
    editing/WSOLATimeStretch.cpp
    editing/ClipEditor.cpp
    analysis/SpeechAligner.cpp
)

set(ALL_HEADERS
    dsp/AudioMath.hpp
    dsp/BiquadFilter.hpp
    dsp/Dynamics.hpp
    dsp/AudioUtils.hpp
    vocal/VocalRack.hpp
    engine/Clip.hpp
    engine/Track.hpp
    engine/Mixer.hpp
    editing/WSOLATimeStretch.hpp
    editing/ClipEditor.hpp
    analysis/SpeechAligner.hpp
)

add_library(daw_core_static STATIC \${ALL_SOURCES} \${ALL_HEADERS})
target_include_directories(daw_core_static PUBLIC \${CMAKE_CURRENT_SOURCE_DIR})

if(EMSCRIPTEN)
    set(WASM_SOURCES \${ALL_SOURCES} bindings/EmscriptenBindings.cpp)
    add_executable(daw_core \${WASM_SOURCES})
    target_include_directories(daw_core PUBLIC \${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_options(daw_core PRIVATE -O3 -msimd128 -flto -Wall -Wextra)
    set_target_properties(daw_core PROPERTIES
        OUTPUT_NAME "daw_core"
        SUFFIX ".js"
        LINK_FLAGS "-O3 -msimd128 -flto --bind -s WASM=1 -s INITIAL_MEMORY=67108864 -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=web,worker -s MODULARIZE=1 -s EXPORT_NAME='CreateDAWCoreModule' -s EXPORTED_FUNCTIONS='[\"_malloc\", \"_free\", \"_createMixerInstance\", \"_freeMixerInstance\", \"_processMixer\", \"_setTimelinePosition\", \"_addClipToTrack\", \"_setTrackVolume\", \"_setTrackPan\", \"_setTrackSolo\", \"_setTrackMute\", \"_removeAllTracks\", \"_setMasterVolume\", \"_setMasterLimiter\"]' -s EXPORTED_RUNTIME_METHODS='[\"cwrap\", \"setValue\", \"getValue\", \"HEAPF32\"]' -s SINGLE_FILE=0"
    )
endif()
`,

  'build_wasm.sh': `#!/bin/bash
# Скрипт модульной сборки C++ DAW Core в WebAssembly
emcc -O3 \\
    -std=c++17 \\
    -msimd128 \\
    -flto \\
    --bind \\
    -I. \\
    -s WASM=1 \\
    -s INITIAL_MEMORY=67108864 \\
    -s ALLOW_MEMORY_GROWTH=1 \\
    -s ENVIRONMENT=web,worker \\
    -s MODULARIZE=1 \\
    -s EXPORT_NAME="CreateDAWCoreModule" \\
    -s EXPORTED_FUNCTIONS='["_malloc", "_free", "_createMixerInstance", "_freeMixerInstance", "_processMixer", "_setTimelinePosition", "_addClipToTrack", "_setTrackVolume", "_setTrackPan", "_setTrackSolo", "_setTrackMute", "_removeAllTracks", "_setMasterVolume", "_setMasterLimiter"]' \\
    -s EXPORTED_RUNTIME_METHODS='["cwrap", "setValue", "getValue", "HEAPF32"]' \\
    -s SINGLE_FILE=0 \\
    dsp/BiquadFilter.cpp \\
    dsp/Dynamics.cpp \\
    dsp/AudioUtils.cpp \\
    vocal/VocalRack.cpp \\
    engine/Clip.cpp \\
    engine/Track.cpp \\
    engine/Mixer.cpp \\
    editing/WSOLATimeStretch.cpp \\
    editing/ClipEditor.cpp \\
    analysis/SpeechAligner.cpp \\
    bindings/EmscriptenBindings.cpp \\
    -o ../../public/wasm/daw_core.js
`
};
