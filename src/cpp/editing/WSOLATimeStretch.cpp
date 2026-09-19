#include "WSOLATimeStretch.hpp"
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

    // Двухэтапный поиск: быстрый проход с шагом 2 и локальное уточнение (refine)
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

    // Локальное уточнение окрестности bestDelta (d - 1 и d + 1)
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

    // Если коэффициент практически равен 1.0 (разница менее 0.2%), простое копирование
    if (std::abs(safeRatio - 1.0f) < 0.002f) {
        size_t copyLen = std::min(inFrames, maxOutFrames);
        std::memcpy(output, input, copyLen * sizeof(float));
        return copyLen;
    }

    size_t N = (windowSize < 256) ? DEFAULT_WINDOW_SIZE : windowSize;
    size_t Hs = N / 4;                                    // Шаг синтеза
    float Ha = static_cast<float>(Hs) / safeRatio;       // Шаг анализа
    int deltaMax = static_cast<int>(N / 2);

    size_t outFrames = calculateOutputFrames(inFrames, safeRatio);
    outFrames = std::min(outFrames, maxOutFrames);

    std::vector<float> win(N);
    generateHanningWindow(win.data(), N);

    std::vector<float> templateBuf(N, 0.0f);
    std::vector<float> windowWeight(outFrames, 0.0f);
    std::memset(output, 0, outFrames * sizeof(float));

    // Копирование начального сегмента
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

        // Формирование эталона продолжения из предыдущего фрейма
        for (size_t i = 0; i < N; ++i) {
            size_t srcIdx = static_cast<size_t>(prevAnPos) + Hs + i;
            templateBuf[i] = (srcIdx < inFrames) ? input[srcIdx] : 0.0f;
        }

        // Векторизованный поиск оптимальной точки склейки
        int bestDelta = findBestDeltaSIMD(input, templateBuf.data(), inFrames, targetAnPos, deltaMax, N);
        int actualAnPos = targetAnPos + bestDelta;

        // Наложение с весом окна Ханна (Overlap-Add)
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

    // Нормализация по сумме весов перекрывающихся окон
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

    // Если коэффициент практически равен 1.0, прямое копирование
    if (std::abs(safeRatio - 1.0f) < 0.002f) {
        size_t copyFrames = std::min(inFrames, maxOutFrames);
        std::memcpy(output, input, copyFrames * 2 * sizeof(float));
        return copyFrames;
    }

    // Моно-микс для быстрого фазового поиска без нарушения стереобазы
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

    // Копирование первого сегмента
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

        // Поиск общего оптимального сдвига для обоих каналов одновременно
        int bestDelta = findBestDeltaSIMD(monoMix.data(), templateBuf.data(), inFrames, targetAnPos, deltaMax, N);
        int actualAnPos = targetAnPos + bestDelta;

        // Синхронный Overlap-Add для L и R каналов
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

    // Нормализация стереопар
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
