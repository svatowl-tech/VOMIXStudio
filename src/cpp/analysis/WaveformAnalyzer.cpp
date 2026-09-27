#include "WaveformAnalyzer.hpp"

namespace DAWCore {

int WaveformAnalyzer::extractPeaksNative(
    const float* buffer,
    size_t bufferLength,
    int targetPixels,
    size_t startFrame,
    size_t lengthFrames,
    bool isStereo,
    float* outMinPtr,
    float* outMaxPtr
) noexcept {
    // 1. Валидация входных аргументов
    if (!buffer || !outMinPtr || !outMaxPtr || targetPixels <= 0 || lengthFrames == 0) {
        return 0;
    }

    const size_t channels = isStereo ? 2 : 1;
    const size_t totalBufferFrames = bufferLength / channels;

    if (startFrame >= totalBufferFrames) {
        // Начальный фрейм за пределами буфера — заполняем нулями
        for (int p = 0; p < targetPixels; ++p) {
            outMinPtr[p] = 0.0f;
            outMaxPtr[p] = 0.0f;
        }
        return targetPixels;
    }

    // Ограничиваем считываемый диапазон физической емкостью буфера
    const size_t effectiveFrames = std::min(lengthFrames, totalBufferFrames - startFrame);
    if (effectiveFrames == 0) {
        for (int p = 0; p < targetPixels; ++p) {
            outMinPtr[p] = 0.0f;
            outMaxPtr[p] = 0.0f;
        }
        return targetPixels;
    }

    // 2. Расчет шага и субпиксельной децимации
    const double framesPerPixel = static_cast<double>(effectiveFrames) / static_cast<double>(targetPixels);
    const size_t startSampleOffset = startFrame * channels;
    const float* pcmData = buffer + startSampleOffset;

    for (int p = 0; p < targetPixels; ++p) {
        const double frameStartD = p * framesPerPixel;
        const double frameEndD = (p + 1) * framesPerPixel;

        size_t binStartFrame = static_cast<size_t>(frameStartD);
        size_t binEndFrame = static_cast<size_t>(std::ceil(frameEndD));

        if (binStartFrame >= effectiveFrames) {
            binStartFrame = effectiveFrames > 0 ? effectiveFrames - 1 : 0;
        }
        if (binEndFrame > effectiveFrames) {
            binEndFrame = effectiveFrames;
        }
        if (binEndFrame <= binStartFrame) {
            binEndFrame = binStartFrame + 1;
        }

        const size_t numFramesInBin = binEndFrame - binStartFrame;
        const size_t binSampleOffset = binStartFrame * channels;
        const float* binSrc = pcmData + binSampleOffset;

        float minVal = 0.0f;
        float maxVal = 0.0f;

        if (isStereo) {
#if defined(__wasm_simd128__)
            if (numFramesInBin >= 8) {
                processStereoBlockSIMD(binSrc, numFramesInBin, minVal, maxVal);
            } else {
                processStereoBlockScalar(binSrc, numFramesInBin, minVal, maxVal);
            }
#else
            processStereoBlockScalar(binSrc, numFramesInBin, minVal, maxVal);
#endif
        } else {
#if defined(__wasm_simd128__)
            if (numFramesInBin >= 16) {
                processMonoBlockSIMD(binSrc, numFramesInBin, minVal, maxVal);
            } else {
                processMonoBlockScalar(binSrc, numFramesInBin, minVal, maxVal);
            }
#else
            processMonoBlockScalar(binSrc, numFramesInBin, minVal, maxVal);
#endif
        }

        // Защита от NaN / Inf и ограничение диапазона визуализации
        if (std::isnan(minVal) || std::isinf(minVal)) minVal = 0.0f;
        if (std::isnan(maxVal) || std::isinf(maxVal)) maxVal = 0.0f;

        outMinPtr[p] = std::max(-1.5f, std::min(1.5f, minVal));
        outMaxPtr[p] = std::max(-1.5f, std::min(1.5f, maxVal));
    }

    return targetPixels;
}

int WaveformAnalyzer::extractRMSPeaksNative(
    const float* buffer,
    size_t bufferLength,
    int targetPixels,
    size_t startFrame,
    size_t lengthFrames,
    bool isStereo,
    float* outRmsPtr
) noexcept {
    if (!buffer || !outRmsPtr || targetPixels <= 0 || lengthFrames == 0) {
        return 0;
    }

    const size_t channels = isStereo ? 2 : 1;
    const size_t totalBufferFrames = bufferLength / channels;

    if (startFrame >= totalBufferFrames) {
        for (int p = 0; p < targetPixels; ++p) {
            outRmsPtr[p] = 0.0f;
        }
        return targetPixels;
    }

    const size_t effectiveFrames = std::min(lengthFrames, totalBufferFrames - startFrame);
    const double framesPerPixel = static_cast<double>(effectiveFrames) / static_cast<double>(targetPixels);
    const size_t startSampleOffset = startFrame * channels;
    const float* pcmData = buffer + startSampleOffset;

    for (int p = 0; p < targetPixels; ++p) {
        const double frameStartD = p * framesPerPixel;
        const double frameEndD = (p + 1) * framesPerPixel;

        size_t binStartFrame = static_cast<size_t>(frameStartD);
        size_t binEndFrame = static_cast<size_t>(std::ceil(frameEndD));

        if (binStartFrame >= effectiveFrames) {
            binStartFrame = effectiveFrames > 0 ? effectiveFrames - 1 : 0;
        }
        if (binEndFrame > effectiveFrames) {
            binEndFrame = effectiveFrames;
        }
        if (binEndFrame <= binStartFrame) {
            binEndFrame = binStartFrame + 1;
        }

        const size_t numFramesInBin = binEndFrame - binStartFrame;
        const size_t numSamples = numFramesInBin * channels;
        const float* binSrc = pcmData + (binStartFrame * channels);

        double sumSquares = 0.0;

#if defined(__wasm_simd128__)
        size_t simdCount = numSamples & ~3UL;
        v128_t accVec = wasm_f32x4_splat(0.0f);

        for (size_t i = 0; i < simdCount; i += 4) {
            v128_t v = wasm_v128_load(binSrc + i);
            v128_t sq = wasm_f32x4_mul(v, v);
            accVec = wasm_f32x4_add(accVec, sq);
        }

        float accFloats[4];
        wasm_v128_store(accFloats, accVec);
        sumSquares += (accFloats[0] + accFloats[1] + accFloats[2] + accFloats[3]);

        for (size_t i = simdCount; i < numSamples; ++i) {
            const float s = binSrc[i];
            sumSquares += (s * s);
        }
#else
        for (size_t i = 0; i < numSamples; ++i) {
            const float s = binSrc[i];
            sumSquares += (s * s);
        }
#endif

        const double meanSquare = numSamples > 0 ? (sumSquares / static_cast<double>(numSamples)) : 0.0;
        const float rms = static_cast<float>(std::sqrt(meanSquare));

        outRmsPtr[p] = std::max(0.0f, std::min(1.5f, rms));
    }

    return targetPixels;
}

WaveformStats WaveformAnalyzer::calculateGlobalStats(
    const float* buffer,
    size_t totalFrames,
    bool isStereo
) noexcept {
    WaveformStats stats{};
    if (!buffer || totalFrames == 0) {
        return stats;
    }

    const size_t channels = isStereo ? 2 : 1;
    const size_t totalSamples = totalFrames * channels;

    float minVal = 0.0f;
    float maxVal = 0.0f;
    double sumSquares = 0.0;

    if (totalSamples > 0) {
        minVal = buffer[0];
        maxVal = buffer[0];
    }

#if defined(__wasm_simd128__)
    const size_t simdCount = totalSamples & ~3UL;
    v128_t minVec = wasm_f32x4_splat(minVal);
    v128_t maxVec = wasm_f32x4_splat(maxVal);
    v128_t accVec = wasm_f32x4_splat(0.0f);

    for (size_t i = 0; i < simdCount; i += 4) {
        v128_t v = wasm_v128_load(buffer + i);
        minVec = wasm_f32x4_min(minVec, v);
        maxVec = wasm_f32x4_max(maxVec, v);
        v128_t sq = wasm_f32x4_mul(v, v);
        accVec = wasm_f32x4_add(accVec, sq);
    }

    float minArr[4], maxArr[4], accArr[4];
    wasm_v128_store(minArr, minVec);
    wasm_v128_store(maxArr, maxVec);
    wasm_v128_store(accArr, accVec);

    minVal = std::min({minArr[0], minArr[1], minArr[2], minArr[3]});
    maxVal = std::max({maxArr[0], maxArr[1], maxArr[2], maxArr[3]});
    sumSquares = (accArr[0] + accArr[1] + accArr[2] + accArr[3]);

    for (size_t i = simdCount; i < totalSamples; ++i) {
        const float s = buffer[i];
        if (s < minVal) minVal = s;
        if (s > maxVal) maxVal = s;
        sumSquares += (s * s);
    }
#else
    for (size_t i = 0; i < totalSamples; ++i) {
        const float s = buffer[i];
        if (s < minVal) minVal = s;
        if (s > maxVal) maxVal = s;
        sumSquares += (s * s);
    }
#endif

    stats.globalMin = minVal;
    stats.globalMax = maxVal;
    stats.maxAbsolutePeak = std::max(std::abs(minVal), std::abs(maxVal));
    stats.rmsLevel = totalSamples > 0 ? static_cast<float>(std::sqrt(sumSquares / totalSamples)) : 0.0f;
    stats.processedFrames = totalFrames;

    return stats;
}

// ============================================================================
// Приватные методы векторизованной и скалярной обработки
// ============================================================================

void WaveformAnalyzer::processMonoBlockScalar(
    const float* src,
    size_t count,
    float& outMin,
    float& outMax
) noexcept {
    if (count == 0) {
        outMin = 0.0f;
        outMax = 0.0f;
        return;
    }

    float minV = src[0];
    float maxV = src[0];

    for (size_t i = 1; i < count; ++i) {
        const float s = src[i];
        if (s < minV) minV = s;
        if (s > maxV) maxV = s;
    }

    outMin = minV;
    outMax = maxV;
}

void WaveformAnalyzer::processMonoBlockSIMD(
    const float* src,
    size_t count,
    float& outMin,
    float& outMax
) noexcept {
#if defined(__wasm_simd128__)
    float minV = src[0];
    float maxV = src[0];

    const size_t simdCount = count & ~3UL;
    v128_t minVec = wasm_f32x4_splat(minV);
    v128_t maxVec = wasm_f32x4_splat(maxV);

    for (size_t i = 0; i < simdCount; i += 4) {
        v128_t v = wasm_v128_load(src + i);
        minVec = wasm_f32x4_min(minVec, v);
        maxVec = wasm_f32x4_max(maxVec, v);
    }

    float minArr[4], maxArr[4];
    wasm_v128_store(minArr, minVec);
    wasm_v128_store(maxArr, maxVec);

    minV = std::min({minArr[0], minArr[1], minArr[2], minArr[3]});
    maxV = std::max({maxArr[0], maxArr[1], maxArr[2], maxArr[3]});

    for (size_t i = simdCount; i < count; ++i) {
        const float s = src[i];
        if (s < minV) minV = s;
        if (s > maxV) maxV = s;
    }

    outMin = minV;
    outMax = maxV;
#else
    processMonoBlockScalar(src, count, outMin, outMax);
#endif
}

void WaveformAnalyzer::processStereoBlockScalar(
    const float* src,
    size_t frameCount,
    float& outMin,
    float& outMax
) noexcept {
    if (frameCount == 0) {
        outMin = 0.0f;
        outMax = 0.0f;
        return;
    }

    float minV = std::min(src[0], src[1]);
    float maxV = std::max(src[0], src[1]);

    const size_t totalSamples = frameCount * 2;
    for (size_t i = 2; i < totalSamples; i += 2) {
        const float left = src[i];
        const float right = src[i + 1];
        const float frameMin = std::min(left, right);
        const float frameMax = std::max(left, right);

        if (frameMin < minV) minV = frameMin;
        if (frameMax > maxV) maxV = frameMax;
    }

    outMin = minV;
    outMax = maxV;
}

void WaveformAnalyzer::processStereoBlockSIMD(
    const float* src,
    size_t frameCount,
    float& outMin,
    float& outMax
) noexcept {
#if defined(__wasm_simd128__)
    float minV = std::min(src[0], src[1]);
    float maxV = std::max(src[0], src[1]);

    const size_t totalSamples = frameCount * 2;
    const size_t simdSamples = totalSamples & ~3UL;

    v128_t minVec = wasm_f32x4_splat(minV);
    v128_t maxVec = wasm_f32x4_splat(maxV);

    for (size_t i = 0; i < simdSamples; i += 4) {
        v128_t v = wasm_v128_load(src + i);
        minVec = wasm_f32x4_min(minVec, v);
        maxVec = wasm_f32x4_max(maxVec, v);
    }

    float minArr[4], maxArr[4];
    wasm_v128_store(minArr, minVec);
    wasm_v128_store(maxArr, maxVec);

    minV = std::min({minArr[0], minArr[1], minArr[2], minArr[3]});
    maxV = std::max({maxArr[0], maxArr[1], maxArr[2], maxArr[3]});

    for (size_t i = simdSamples; i < totalSamples; ++i) {
        const float s = src[i];
        if (s < minV) minV = s;
        if (s > maxV) maxV = s;
    }

    outMin = minV;
    outMax = maxV;
#else
    processStereoBlockScalar(src, frameCount, outMin, outMax);
#endif
}

} // namespace DAWCore
