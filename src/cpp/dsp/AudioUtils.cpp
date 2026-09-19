/**
 * ============================================================================
 * AudioUtils.cpp - Реализация вспомогательных DSP утилит (C++17)
 * ============================================================================
 */

#include "AudioUtils.hpp"
#include <cmath>
#include <algorithm>
#include <cstring>

namespace DAWCore {

// ============================================================================
// 1. LoudnessAnalyzer
// ============================================================================

LoudnessStats LoudnessAnalyzer::calculateLoudnessStats(
    const float* buffer,
    size_t numSamples,
    int channels,
    float targetRmsDb,
    float maxPeakDb
) noexcept {
    LoudnessStats stats;
    if (!buffer || numSamples == 0 || channels <= 0) {
        return stats;
    }

    stats.numSamples = numSamples;
    float sumSquares = 0.0f;
    float maxPeak = 0.0f;

    size_t totalValues = numSamples * static_cast<size_t>(channels);
    size_t i = 0;

#if USE_WASM_SIMD
    // Векторизованная обработка под WASM SIMD128 (4 значения float за итерацию)
    v128_t vSum = wasm_f32x4_splat(0.0f);
    v128_t vMax = wasm_f32x4_splat(0.0f);

    for (; i + 4 <= totalValues; i += 4) {
        v128_t vSamples = wasm_v128_load(&buffer[i]);
        v128_t vAbs = wasm_f32x4_abs(vSamples);
        vMax = wasm_f32x4_max(vMax, vAbs);
        vSum = wasm_f32x4_add(vSum, wasm_f32x4_mul(vSamples, vSamples));
    }

    alignas(16) float sumArr[4];
    alignas(16) float maxArr[4];
    wasm_v128_store(sumArr, vSum);
    wasm_v128_store(maxArr, vMax);

    sumSquares = sumArr[0] + sumArr[1] + sumArr[2] + sumArr[3];
    maxPeak = std::max({maxArr[0], maxArr[1], maxArr[2], maxArr[3]});
#endif

    // Скалярная обработка остатка сэмплов
    for (; i < totalValues; ++i) {
        float s = buffer[i];
        float absS = std::abs(s);
        if (absS > maxPeak) maxPeak = absS;
        sumSquares += s * s;
    }

    stats.peakLinear = maxPeak;
    stats.peakDb = gainToDb(maxPeak);

    if (totalValues > 0) {
        stats.rmsLinear = std::sqrt(sumSquares / static_cast<float>(totalValues));
        stats.rmsDb = gainToDb(stats.rmsLinear);
    }

    stats.isClipping = (maxPeak >= 0.9999f || stats.peakDb >= -0.01f);

    // Расчет дельты усиления для приведения к целевому уровню RMS
    float requiredGainDb = targetRmsDb - stats.rmsDb;
    float projectedPeak = stats.peakDb + requiredGainDb;

    // Защита от пикового перегруза (Peak Guard)
    if (projectedPeak > maxPeakDb) {
        requiredGainDb = maxPeakDb - stats.peakDb;
    }

    stats.gainDeltaToTargetDb = clampFloat(requiredGainDb, -36.0f, 18.0f);
    return stats;
}

// ============================================================================
// 2. AudioResampler
// ============================================================================

size_t AudioResampler::resampleTo48k(
    const float* input,
    size_t inFrames,
    int inRate,
    float* output,
    size_t outCapacityFrames,
    int channels
) noexcept {
    if (!input || !output || inFrames == 0 || inRate <= 0 || outCapacityFrames == 0 || channels <= 0) {
        return 0;
    }

    double ratio = TARGET_SAMPLE_RATE / static_cast<double>(inRate);
    size_t expectedOutFrames = static_cast<size_t>(std::ceil(inFrames * ratio));
    size_t outFrames = std::min(expectedOutFrames, outCapacityFrames);
    double step = static_cast<double>(inRate) / TARGET_SAMPLE_RATE;

    for (size_t ch = 0; ch < static_cast<size_t>(channels); ++ch) {
        for (size_t outIdx = 0; outIdx < outFrames; ++outIdx) {
            double srcPos = outIdx * step;
            int64_t idx1 = static_cast<int64_t>(std::floor(srcPos));
            float t = static_cast<float>(srcPos - idx1);

            int64_t idx0 = std::max<int64_t>(0, idx1 - 1);
            int64_t idx2 = std::min<int64_t>(static_cast<int64_t>(inFrames) - 1, idx1 + 1);
            int64_t idx3 = std::min<int64_t>(static_cast<int64_t>(inFrames) - 1, idx1 + 2);
            idx1 = std::min<int64_t>(static_cast<int64_t>(inFrames) - 1, idx1);

            float p0 = input[idx0 * channels + ch];
            float p1 = input[idx1 * channels + ch];
            float p2 = input[idx2 * channels + ch];
            float p3 = input[idx3 * channels + ch];

            output[outIdx * channels + ch] = catmullRom(p0, p1, p2, p3, t);
        }
    }

    return outFrames;
}

// ============================================================================
// 3. NativeWavPacker
// ============================================================================

size_t NativeWavPacker::packWav(
    const float* interleavedBuffer,
    size_t numFrames,
    int bitDepth,
    uint8_t* outWavBuffer,
    size_t maxOutputBytes,
    int sampleRate,
    int numChannels
) noexcept {
    if (!interleavedBuffer || !outWavBuffer || numFrames == 0 || numChannels <= 0) {
        return 0;
    }

    uint16_t bytesPerSample = static_cast<uint16_t>(bitDepth / 8);
    uint32_t dataBytes = static_cast<uint32_t>(numFrames * numChannels * bytesPerSample);
    uint32_t totalFileSize = 44 + dataBytes;

    if (totalFileSize > maxOutputBytes) {
        return 0; // Недостаточный размер выходного буфера
    }

    uint16_t audioFormat = (bitDepth == 32) ? 3 : 1; // 3 = IEEE Float, 1 = PCM Integer
    uint32_t byteRate = sampleRate * numChannels * bytesPerSample;
    uint16_t blockAlign = numChannels * bytesPerSample;

    // RIFF Chunk Descriptor
    std::memcpy(outWavBuffer, "RIFF", 4);
    uint32_t chunkSize = 36 + dataBytes;
    std::memcpy(outWavBuffer + 4, &chunkSize, 4);
    std::memcpy(outWavBuffer + 8, "WAVE", 4);

    // "fmt " Sub-chunk
    std::memcpy(outWavBuffer + 12, "fmt ", 4);
    uint32_t subchunk1Size = 16;
    std::memcpy(outWavBuffer + 16, &subchunk1Size, 4);
    std::memcpy(outWavBuffer + 20, &audioFormat, 2);
    uint16_t nCh = static_cast<uint16_t>(numChannels);
    std::memcpy(outWavBuffer + 22, &nCh, 2);
    uint32_t sRate = static_cast<uint32_t>(sampleRate);
    std::memcpy(outWavBuffer + 24, &sRate, 4);
    std::memcpy(outWavBuffer + 28, &byteRate, 4);
    std::memcpy(outWavBuffer + 32, &blockAlign, 2);
    uint16_t bitsPerSample = static_cast<uint16_t>(bitDepth);
    std::memcpy(outWavBuffer + 34, &bitsPerSample, 2);

    // "data" Sub-chunk
    std::memcpy(outWavBuffer + 36, "data", 4);
    std::memcpy(outWavBuffer + 40, &dataBytes, 4);

    uint8_t* dataPtr = outWavBuffer + 44;
    size_t totalSamples = numFrames * numChannels;

    if (bitDepth == 16) {
        int16_t* pcm16 = reinterpret_cast<int16_t*>(dataPtr);
        for (size_t i = 0; i < totalSamples; ++i) {
            float s = clampFloat(interleavedBuffer[i], -1.0f, 1.0f);
            pcm16[i] = static_cast<int16_t>(s * 32767.0f);
        }
    } else if (bitDepth == 24) {
        size_t byteIdx = 0;
        for (size_t i = 0; i < totalSamples; ++i) {
            float s = clampFloat(interleavedBuffer[i], -1.0f, 1.0f);
            int32_t val24 = static_cast<int32_t>(s * 8388607.0f);
            dataPtr[byteIdx++] = static_cast<uint8_t>(val24 & 0xFF);
            dataPtr[byteIdx++] = static_cast<uint8_t>((val24 >> 8) & 0xFF);
            dataPtr[byteIdx++] = static_cast<uint8_t>((val24 >> 16) & 0xFF);
        }
    } else if (bitDepth == 32) {
        std::memcpy(dataPtr, interleavedBuffer, dataBytes);
    }

    return totalFileSize;
}

} // namespace DAWCore
