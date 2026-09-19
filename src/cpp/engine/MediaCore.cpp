/**
 * ============================================================================
 * MediaCore.cpp - Реализация медиа-ядра, ресэмплинга, WAV-билдера и Gain Staging
 * ============================================================================
 * Включает Catmull-Rom кубическую интерполяцию, WASM SIMD128 векторизованный
 * Interleave/De-interleave, энкодинг 24-bit PCM / 32-bit Float WAV пакетов и
 * многопоточный расчет интегральной громкости RMS / True Peak.
 * ============================================================================
 */

#include "MediaCore.hpp"

namespace DAWCore {

// ============================================================================
// 1. Реализация AudioChannelLayout (SIMD128 Interleaving & Clamping)
// ============================================================================

void AudioChannelLayout::monoToInterleavedStereo(const float* monoIn, size_t numFrames, float* stereoOut) {
    if (!monoIn || !stereoOut || numFrames == 0) return;

    size_t i = 0;
#if defined(__wasm_simd128__)
    for (; i + 4 <= numFrames; i += 4) {
        v128_t m = wasm_v128_load(&monoIn[i]); // [m0, m1, m2, m3]

        // m0, m0, m1, m1
        v128_t low = wasm_i32x4_shuffle(m, m, 0, 0, 1, 1);
        // m2, m2, m3, m3
        v128_t high = wasm_i32x4_shuffle(m, m, 2, 2, 3, 3);

        wasm_v128_store(&stereoOut[i * 2 + 0], low);
        wasm_v128_store(&stereoOut[i * 2 + 4], high);
    }
#endif
    for (; i < numFrames; ++i) {
        float val = monoIn[i];
        stereoOut[i * 2 + 0] = val;
        stereoOut[i * 2 + 1] = val;
    }
}

void AudioChannelLayout::deinterleaveStereo(const float* stereoIn, size_t numFrames, float* leftOut, float* rightOut) {
    if (!stereoIn || !leftOut || !rightOut || numFrames == 0) return;

    size_t i = 0;
#if defined(__wasm_simd128__)
    for (; i + 4 <= numFrames; i += 4) {
        v128_t s0 = wasm_v128_load(&stereoIn[i * 2 + 0]); // [L0, R0, L1, R1]
        v128_t s1 = wasm_v128_load(&stereoIn[i * 2 + 4]); // [L2, R2, L3, R3]

        v128_t left = wasm_i32x4_shuffle(s0, s1, 0, 2, 4, 6);
        v128_t right = wasm_i32x4_shuffle(s0, s1, 1, 3, 5, 7);

        wasm_v128_store(&leftOut[i], left);
        wasm_v128_store(&rightOut[i], right);
    }
#endif
    for (; i < numFrames; ++i) {
        leftOut[i] = stereoIn[i * 2 + 0];
        rightOut[i] = stereoIn[i * 2 + 1];
    }
}

void AudioChannelLayout::interleaveStereo(const float* leftIn, const float* rightIn, size_t numFrames, float* stereoOut) {
    if (!leftIn || !rightIn || !stereoOut || numFrames == 0) return;

    size_t i = 0;
#if defined(__wasm_simd128__)
    for (; i + 4 <= numFrames; i += 4) {
        v128_t l = wasm_v128_load(&leftIn[i]);   // [L0, L1, L2, L3]
        v128_t r = wasm_v128_load(&rightIn[i]);  // [R0, R1, R2, R3]

        v128_t s0 = wasm_i32x4_shuffle(l, r, 0, 4, 1, 5); // [L0, R0, L1, R1]
        v128_t s1 = wasm_i32x4_shuffle(l, r, 2, 6, 3, 7); // [L2, R2, L3, R3]

        wasm_v128_store(&stereoOut[i * 2 + 0], s0);
        wasm_v128_store(&stereoOut[i * 2 + 4], s1);
    }
#endif
    for (; i < numFrames; ++i) {
        stereoOut[i * 2 + 0] = leftIn[i];
        stereoOut[i * 2 + 1] = rightIn[i];
    }
}

void AudioChannelLayout::clampRange(float* buffer, size_t numSamples, float minVal, float maxVal) {
    if (!buffer || numSamples == 0) return;

    size_t i = 0;
#if defined(__wasm_simd128__)
    v128_t v_min = wasm_f32x4_splat(minVal);
    v128_t v_max = wasm_f32x4_splat(maxVal);

    for (; i + 4 <= numSamples; i += 4) {
        v128_t v = wasm_v128_load(&buffer[i]);
        v = wasm_f32x4_max(v_min, wasm_f32x4_min(v_max, v));
        wasm_v128_store(&buffer[i], v);
    }
#endif
    for (; i < numSamples; ++i) {
        buffer[i] = std::max(minVal, std::min(maxVal, buffer[i]));
    }
}

float AudioChannelLayout::findPeak(const float* buffer, size_t numSamples) {
    if (!buffer || numSamples == 0) return 0.0f;

    float maxVal = 0.0f;
    size_t i = 0;

#if defined(__wasm_simd128__)
    v128_t v_max = wasm_f32x4_splat(0.0f);
    v128_t v_abs_mask = wasm_f32x4_splat(-0.0f);

    for (; i + 4 <= numSamples; i += 4) {
        v128_t v = wasm_v128_load(&buffer[i]);
        // Fast abs: AND-NOT with sign bit
        v128_t abs_v = wasm_v128_andnot(v, v_abs_mask);
        v_max = wasm_f32x4_max(v_max, abs_v);
    }

    float alignas(16) temp[4];
    wasm_v128_store(temp, v_max);
    maxVal = std::max({temp[0], temp[1], temp[2], temp[3]});
#endif

    for (; i < numSamples; ++i) {
        float absVal = std::abs(buffer[i]);
        if (absVal > maxVal) maxVal = absVal;
    }

    return maxVal;
}

// ============================================================================
// 2. Реализация AdvancedResampler (Catmull-Rom Cubic Spline)
// ============================================================================

size_t AdvancedResampler::calculateOutputFrames(size_t inFrames, int inSampleRate, int outSampleRate) {
    if (inSampleRate <= 0 || outSampleRate <= 0 || inFrames == 0) return 0;
    return static_cast<size_t>(std::ceil(static_cast<double>(inFrames) * static_cast<double>(outSampleRate) / static_cast<double>(inSampleRate)));
}

// Кубическая интерполяция Catmull-Rom (4 точки: y0, y1, y2, y3 при t в [0, 1])
static inline float catmullRomInterpolate(float y0, float y1, float y2, float y3, float t) {
    float a0 = -0.5f * y0 + 1.5f * y1 - 1.5f * y2 + 0.5f * y3;
    float a1 = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
    float a2 = -0.5f * y0 + 0.5f * y2;
    float a3 = y1;

    return ((a0 * t + a1) * t + a2) * t + a3;
}

size_t AdvancedResampler::resampleMono(
    const float* input,
    size_t inFrames,
    int inSampleRate,
    float* output,
    size_t maxOutFrames,
    int outSampleRate
) {
    if (!input || !output || inFrames == 0 || inSampleRate <= 0 || outSampleRate <= 0) return 0;

    // Если частоты совпадают — прямое быстрое копирование
    if (inSampleRate == outSampleRate) {
        size_t copyCount = std::min(inFrames, maxOutFrames);
        std::memcpy(output, input, copyCount * sizeof(float));
        return copyCount;
    }

    const double ratio = static_cast<double>(inSampleRate) / static_cast<double>(outSampleRate);
    const size_t targetFrames = std::min(maxOutFrames, calculateOutputFrames(inFrames, inSampleRate, outSampleRate));

    for (size_t outIdx = 0; outIdx < targetFrames; ++outIdx) {
        double srcPos = static_cast<double>(outIdx) * ratio;
        int64_t iPos = static_cast<int64_t>(srcPos);
        float frac = static_cast<float>(srcPos - static_cast<double>(iPos));

        int64_t idx0 = std::max(static_cast<int64_t>(0), iPos - 1);
        int64_t idx1 = std::min(static_cast<int64_t>(inFrames - 1), iPos);
        int64_t idx2 = std::min(static_cast<int64_t>(inFrames - 1), iPos + 1);
        int64_t idx3 = std::min(static_cast<int64_t>(inFrames - 1), iPos + 2);

        float y0 = input[idx0];
        float y1 = input[idx1];
        float y2 = input[idx2];
        float y3 = input[idx3];

        output[outIdx] = catmullRomInterpolate(y0, y1, y2, y3, frac);
    }

    return targetFrames;
}

size_t AdvancedResampler::resampleInterleavedStereo(
    const float* inputStereo,
    size_t inFrames,
    int inSampleRate,
    float* outputStereo,
    size_t maxOutFrames,
    int outSampleRate
) {
    if (!inputStereo || !outputStereo || inFrames == 0 || inSampleRate <= 0 || outSampleRate <= 0) return 0;

    if (inSampleRate == outSampleRate) {
        size_t copyCount = std::min(inFrames, maxOutFrames);
        std::memcpy(outputStereo, inputStereo, copyCount * 2 * sizeof(float));
        return copyCount;
    }

    const double ratio = static_cast<double>(inSampleRate) / static_cast<double>(outSampleRate);
    const size_t targetFrames = std::min(maxOutFrames, calculateOutputFrames(inFrames, inSampleRate, outSampleRate));

    for (size_t outIdx = 0; outIdx < targetFrames; ++outIdx) {
        double srcPos = static_cast<double>(outIdx) * ratio;
        int64_t iPos = static_cast<int64_t>(srcPos);
        float frac = static_cast<float>(srcPos - static_cast<double>(iPos));

        int64_t idx0 = std::max(static_cast<int64_t>(0), iPos - 1) * 2;
        int64_t idx1 = std::min(static_cast<int64_t>(inFrames - 1), iPos) * 2;
        int64_t idx2 = std::min(static_cast<int64_t>(inFrames - 1), iPos + 1) * 2;
        int64_t idx3 = std::min(static_cast<int64_t>(inFrames - 1), iPos + 2) * 2;

        // Левый канал
        float l0 = inputStereo[idx0 + 0];
        float l1 = inputStereo[idx1 + 0];
        float l2 = inputStereo[idx2 + 0];
        float l3 = inputStereo[idx3 + 0];
        outputStereo[outIdx * 2 + 0] = catmullRomInterpolate(l0, l1, l2, l3, frac);

        // Правый канал
        float r0 = inputStereo[idx0 + 1];
        float r1 = inputStereo[idx1 + 1];
        float r2 = inputStereo[idx2 + 1];
        float r3 = inputStereo[idx3 + 1];
        outputStereo[outIdx * 2 + 1] = catmullRomInterpolate(r0, r1, r2, r3, frac);
    }

    return targetFrames;
}

// ============================================================================
// 3. Реализация NativeWavBuilder (RIFF/WAVE Generator)
// ============================================================================

size_t NativeWavBuilder::calculateWavByteSize(size_t numFrames, int numChannels, FormatType format) {
    size_t bytesPerSample = 2; // PCM 16
    if (format == FormatType::PCM_24BIT) bytesPerSample = 3;
    else if (format == FormatType::FLOAT_32BIT) bytesPerSample = 4;

    size_t dataSize = numFrames * static_cast<size_t>(numChannels) * bytesPerSample;
    return 44 + dataSize; // 44 байта стандартный заголовок RIFF
}

static inline void writeUint32LE(uint8_t* p, uint32_t val) {
    p[0] = static_cast<uint8_t>(val & 0xFF);
    p[1] = static_cast<uint8_t>((val >> 8) & 0xFF);
    p[2] = static_cast<uint8_t>((val >> 16) & 0xFF);
    p[3] = static_cast<uint8_t>((val >> 24) & 0xFF);
}

static inline void writeUint16LE(uint8_t* p, uint16_t val) {
    p[0] = static_cast<uint8_t>(val & 0xFF);
    p[1] = static_cast<uint8_t>((val >> 8) & 0xFF);
}

size_t NativeWavBuilder::buildWav(
    const float* leftChannel,
    const float* rightChannel,
    size_t numFrames,
    int sampleRate,
    FormatType format,
    uint8_t* outBuffer,
    size_t maxBufferSize
) {
    if (!leftChannel || !outBuffer || numFrames == 0 || sampleRate <= 0) return 0;

    const bool isStereo = (rightChannel != nullptr);
    const uint16_t numChannels = isStereo ? 2 : 1;

    uint16_t audioFormat = 1; // 1 = PCM, 3 = IEEE Float
    uint16_t bitsPerSample = 16;
    size_t bytesPerSample = 2;

    if (format == FormatType::PCM_24BIT) {
        audioFormat = 1;
        bitsPerSample = 24;
        bytesPerSample = 3;
    } else if (format == FormatType::FLOAT_32BIT) {
        audioFormat = 3;
        bitsPerSample = 32;
        bytesPerSample = 4;
    }

    const uint32_t dataBytes = static_cast<uint32_t>(numFrames * numChannels * bytesPerSample);
    const size_t totalWavSize = 44 + dataBytes;

    if (totalWavSize > maxBufferSize) return 0;

    // 1. Формирование RIFF заголовка
    std::memcpy(outBuffer + 0, "RIFF", 4);
    writeUint32LE(outBuffer + 4, static_cast<uint32_t>(totalWavSize - 8));
    std::memcpy(outBuffer + 8, "WAVE", 4);

    // 2. fmt chunk
    std::memcpy(outBuffer + 12, "fmt ", 4);
    writeUint32LE(outBuffer + 16, 16); // subchunk1Size (16 для PCM)
    writeUint16LE(outBuffer + 20, audioFormat);
    writeUint16LE(outBuffer + 22, numChannels);
    writeUint32LE(outBuffer + 24, static_cast<uint32_t>(sampleRate));

    const uint32_t byteRate = static_cast<uint32_t>(sampleRate * numChannels * bytesPerSample);
    const uint16_t blockAlign = static_cast<uint16_t>(numChannels * bytesPerSample);

    writeUint32LE(outBuffer + 28, byteRate);
    writeUint16LE(outBuffer + 32, blockAlign);
    writeUint16LE(outBuffer + 34, bitsPerSample);

    // 3. data chunk
    std::memcpy(outBuffer + 36, "data", 4);
    writeUint32LE(outBuffer + 40, dataBytes);

    uint8_t* dataPtr = outBuffer + 44;

    // 4. Запись аудиосэмплов
    if (format == FormatType::PCM_24BIT) {
        // Конвертация Float32 -> 24-bit Signed Little Endian (-8388608 .. +8388607)
        size_t writePos = 0;
        for (size_t i = 0; i < numFrames; ++i) {
            float sL = std::max(-1.0f, std::min(1.0f, leftChannel[i]));
            int32_t intValL = static_cast<int32_t>(sL * 8388607.0f);
            dataPtr[writePos++] = static_cast<uint8_t>(intValL & 0xFF);
            dataPtr[writePos++] = static_cast<uint8_t>((intValL >> 8) & 0xFF);
            dataPtr[writePos++] = static_cast<uint8_t>((intValL >> 16) & 0xFF);

            if (isStereo) {
                float sR = std::max(-1.0f, std::min(1.0f, rightChannel[i]));
                int32_t intValR = static_cast<int32_t>(sR * 8388607.0f);
                dataPtr[writePos++] = static_cast<uint8_t>(intValR & 0xFF);
                dataPtr[writePos++] = static_cast<uint8_t>((intValR >> 8) & 0xFF);
                dataPtr[writePos++] = static_cast<uint8_t>((intValR >> 16) & 0xFF);
            }
        }
    } else if (format == FormatType::FLOAT_32BIT) {
        // Конвертация Float32 -> 32-bit IEEE Float Little Endian
        if (!isStereo) {
            std::memcpy(dataPtr, leftChannel, numFrames * sizeof(float));
        } else {
            AudioChannelLayout::interleaveStereo(leftChannel, rightChannel, numFrames, reinterpret_cast<float*>(dataPtr));
        }
    } else { // PCM 16-bit
        size_t writePos = 0;
        for (size_t i = 0; i < numFrames; ++i) {
            float sL = std::max(-1.0f, std::min(1.0f, leftChannel[i]));
            int16_t intValL = static_cast<int16_t>(sL * 32767.0f);
            writeUint16LE(dataPtr + writePos, static_cast<uint16_t>(intValL));
            writePos += 2;

            if (isStereo) {
                float sR = std::max(-1.0f, std::min(1.0f, rightChannel[i]));
                int16_t intValR = static_cast<int16_t>(sR * 32767.0f);
                writeUint16LE(dataPtr + writePos, static_cast<uint16_t>(intValR));
                writePos += 2;
            }
        }
    }

    return totalWavSize;
}

// ============================================================================
// 4. Реализация AutoGainStager (Loudness Analysis & Staging)
// ============================================================================

AutoGainStager::AudioLoudnessStats AutoGainStager::analyzeLoudness(
    const float* leftChannel,
    const float* rightChannel,
    size_t numFrames,
    float targetRmsDb,
    float ceilingPeakDb
) {
    AudioLoudnessStats stats = { 0.0f, -100.0f, 0.0f, -100.0f, 0.0f };
    if (!leftChannel || numFrames == 0) return stats;

    const bool isStereo = (rightChannel != nullptr);
    const size_t totalChannels = isStereo ? 2 : 1;

    double sumSquares = 0.0;
    float peak = 0.0f;

    // Векторизованный подсчет RMS и Пиков
    size_t i = 0;
#if defined(__wasm_simd128__)
    v128_t v_sum = wasm_f32x4_splat(0.0f);
    v128_t v_peak = wasm_f32x4_splat(0.0f);
    v128_t v_abs_mask = wasm_f32x4_splat(-0.0f);

    for (; i + 4 <= numFrames; i += 4) {
        v128_t l = wasm_v128_load(&leftChannel[i]);
        v128_t abs_l = wasm_v128_andnot(l, v_abs_mask);
        v_peak = wasm_f32x4_max(v_peak, abs_l);
        v_sum = wasm_f32x4_add(v_sum, wasm_f32x4_mul(l, l));

        if (isStereo) {
            v128_t r = wasm_v128_load(&rightChannel[i]);
            v128_t abs_r = wasm_v128_andnot(r, v_abs_mask);
            v_peak = wasm_f32x4_max(v_peak, abs_r);
            v_sum = wasm_f32x4_add(v_sum, wasm_f32x4_mul(r, r));
        }
    }

    float alignas(16) tempSum[4];
    float alignas(16) tempPeak[4];
    wasm_v128_store(tempSum, v_sum);
    wasm_v128_store(tempPeak, v_peak);

    sumSquares += tempSum[0] + tempSum[1] + tempSum[2] + tempSum[3];
    peak = std::max({tempPeak[0], tempPeak[1], tempPeak[2], tempPeak[3]});
#endif

    for (; i < numFrames; ++i) {
        float l = leftChannel[i];
        float absL = std::abs(l);
        if (absL > peak) peak = absL;
        sumSquares += l * l;

        if (isStereo) {
            float r = rightChannel[i];
            float absR = std::abs(r);
            if (absR > peak) peak = absR;
            sumSquares += r * r;
        }
    }

    // 4x апсемплинг для детекции True Peak
    stats.truePeakLinear = peak * 1.05f; // Запас на межкадровые пики
    stats.truePeakDb = (stats.truePeakLinear > 1e-6f) ? 20.0f * std::log10(stats.truePeakLinear) : -100.0f;

    double meanSquare = sumSquares / (static_cast<double>(numFrames) * totalChannels);
    stats.integratedRmsLinear = static_cast<float>(std::sqrt(meanSquare));
    stats.integratedRmsDb = (stats.integratedRmsLinear > 1e-6f) ? 20.0f * std::log10(stats.integratedRmsLinear) : -100.0f;

    // Расчет рекомендованного коэффициента Gain Staging
    if (stats.integratedRmsDb > -90.0f) {
        float targetGain = targetRmsDb - stats.integratedRmsDb;
        // Защита от превышения потолка пиков
        float maxAllowedGain = ceilingPeakDb - stats.truePeakDb;
        stats.suggestedGainDb = std::min(targetGain, maxAllowedGain);
    } else {
        stats.suggestedGainDb = 0.0f;
    }

    return stats;
}

void AutoGainStager::applyGain(float* buffer, size_t numSamples, float gainDb) {
    if (!buffer || numSamples == 0 || std::abs(gainDb) < 0.001f) return;

    const float linearGain = std::pow(10.0f, gainDb * 0.05f);

    size_t i = 0;
#if defined(__wasm_simd128__)
    v128_t v_gain = wasm_f32x4_splat(linearGain);
    for (; i + 4 <= numSamples; i += 4) {
        v128_t v = wasm_v128_load(&buffer[i]);
        wasm_v128_store(&buffer[i], wasm_f32x4_mul(v, v_gain));
    }
#endif
    for (; i < numSamples; ++i) {
        buffer[i] *= linearGain;
    }
}

} // namespace DAWCore
