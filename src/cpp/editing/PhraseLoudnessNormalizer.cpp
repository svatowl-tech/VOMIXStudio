/**
 * ============================================================================
 * PhraseLoudnessNormalizer.cpp
 * ============================================================================
 * Реализация нативного C++17 DSP модуля покадрового анализа и интеллектуального
 * автоматического выравнивания громкости речевых фраз (от тишины до тишины).
 *
 * Особенности реализации:
 * 1. WebAssembly SIMD128 аппаратная векторизация для суммирования квадратов и
 *    векторизованного скалирования Float32 аудиоданных (4 float за такт).
 * 2. Нулевые динамические аллокации (Zero Malloc) в расчетном цикле.
 * 3. Глассман-Ханнинг/Косинусное сглаживание S-curve на границах фраз
 *    для предотвращения щелчков и артефактов перехода.
 * 4. Защита пауз: межфразовые паузы не усиливаются, сохраняя чистый фон.
 * 5. True Peak Guard: предотвращает клиппинг при выравнивании тихих реплик.
 * ============================================================================
 */

#include "PhraseLoudnessNormalizer.hpp"
#include <cmath>
#include <algorithm>
#include <vector>

namespace DAWCore {

// Вспомогательная внутренняя структура для предварительной разметки границ
struct RawPhraseBoundary {
    size_t startFrame = 0;
    size_t endFrame = 0;
};

void OfflinePhraseNormalizer::calculateEnergySIMD(
    const float* samples,
    size_t numSamples,
    float& outSumSquares,
    float& outPeak
) noexcept {
    if (!samples || numSamples == 0) {
        outSumSquares = 0.0f;
        outPeak = 0.0f;
        return;
    }

    float sumSquares = 0.0f;
    float peak = 0.0f;
    size_t i = 0;

#if USE_WASM_SIMD
    // Векторизация по 4 Float32 значения за одну SIMD инструкцию
    v128_t vSum = wasm_f32x4_splat(0.0f);
    v128_t vPeak = wasm_f32x4_splat(0.0f);
    const v128_t vAbsMask = wasm_i32x4_splat(0x7FFFFFFF); // Маска для модуля float

    const size_t simdEnd = numSamples - (numSamples % 4);
    for (; i < simdEnd; i += 4) {
        v128_t vSample = wasm_v128_load(&samples[i]);
        v128_t vAbs = wasm_v128_and(vSample, vAbsMask);

        vSum = wasm_f32x4_add(vSum, wasm_f32x4_mul(vSample, vSample));
        vPeak = wasm_f32x4_max(vPeak, vAbs);
    }

    alignas(16) float sumArr[4];
    alignas(16) float peakArr[4];
    wasm_v128_store(sumArr, vSum);
    wasm_v128_store(peakArr, vPeak);

    sumSquares = sumArr[0] + sumArr[1] + sumArr[2] + sumArr[3];
    peak = std::max({ peakArr[0], peakArr[1], peakArr[2], peakArr[3] });
#endif

    // Скалярная обработка хвостовых сэмплов
    for (; i < numSamples; ++i) {
        const float s = samples[i];
        const float absS = std::fabs(s);
        sumSquares += s * s;
        if (absS > peak) {
            peak = absS;
        }
    }

    outSumSquares = sumSquares;
    outPeak = peak;
}

void OfflinePhraseNormalizer::applyGainSIMD(
    float* samples,
    size_t numSamples,
    float gainLinear
) noexcept {
    if (!samples || numSamples == 0) return;
    if (std::fabs(gainLinear - 1.0f) < 1e-6f) return; // Усиление 0 dB не требует изменений

    size_t i = 0;

#if USE_WASM_SIMD
    v128_t vGain = wasm_f32x4_splat(gainLinear);
    const size_t simdEnd = numSamples - (numSamples % 4);
    for (; i < simdEnd; i += 4) {
        v128_t vSample = wasm_v128_load(&samples[i]);
        v128_t vRes = wasm_f32x4_mul(vSample, vGain);
        wasm_v128_store(&samples[i], vRes);
    }
#endif

    for (; i < numSamples; ++i) {
        samples[i] *= gainLinear;
    }
}

void OfflinePhraseNormalizer::applyFadeRamp(
    float* buffer,
    size_t startFrame,
    size_t numFrames,
    int channels,
    float startGain,
    float endGain
) noexcept {
    if (!buffer || numFrames == 0 || channels <= 0) return;

    const float gainDiff = endGain - startGain;
    const float invFrames = 1.0f / static_cast<float>(numFrames);

    // Плавное S-кривое изменение коэффициента усиления: g(t) = start + diff * 0.5 * (1 - cos(pi * t))
    for (size_t f = 0; f < numFrames; ++f) {
        const float t = static_cast<float>(f) * invFrames;
        const float smoothT = 0.5f * (1.0f - std::cos(PI_F * t));
        const float currentGain = startGain + gainDiff * smoothT;

        const size_t sampleOffset = (startFrame + f) * static_cast<size_t>(channels);
        for (int ch = 0; ch < channels; ++ch) {
            buffer[sampleOffset + ch] *= currentGain;
        }
    }
}

bool OfflinePhraseNormalizer::processTrackPhrases(
    float* buffer,
    size_t totalFrames,
    int channels,
    float sampleRate,
    const PhraseNormalizerConfig& config
) noexcept {
    if (!buffer || totalFrames == 0 || channels <= 0 || sampleRate <= 8000.0f) {
        return false;
    }

    PhraseNormalizerResult result = processTrackPhrasesWithStats(buffer, totalFrames, channels, sampleRate, config);
    return (result.totalPhrases > 0);
}

PhraseNormalizerResult OfflinePhraseNormalizer::processTrackPhrasesWithStats(
    float* buffer,
    size_t totalFrames,
    int channels,
    float sampleRate,
    const PhraseNormalizerConfig& config
) {
    PhraseNormalizerResult result;
    if (!buffer || totalFrames == 0 || channels <= 0 || sampleRate <= 8000.0f) {
        return result;
    }

    // 1. Параметры покадрового анализа энергии
    const size_t hopFrames = static_cast<size_t>(sampleRate * 0.010f); // 10 мс шаг анализа
    if (hopFrames == 0) return result;

    const size_t totalAnalysisBlocks = totalFrames / hopFrames;
    if (totalAnalysisBlocks == 0) return result;

    const size_t minSilenceFrames = static_cast<size_t>((std::max(50.0f, config.minSilenceDurationMs) / 1000.0f) * sampleRate);
    const size_t prePaddingFrames = static_cast<size_t>((std::max(0.0f, config.prePaddingMs) / 1000.0f) * sampleRate);
    const size_t postPaddingFrames = static_cast<size_t>((std::max(0.0f, config.postPaddingMs) / 1000.0f) * sampleRate);
    const size_t fadeFrames = std::max<size_t>(8, static_cast<size_t>((std::max(5.0f, config.fadeTimeMs) / 1000.0f) * sampleRate));

    const float thresholdLinear = dbToGain(config.thresholdDb);
    const float thresholdEnergy = thresholdLinear * thresholdLinear;

    // Вектор границ фраз (резервируем память заранее для исключения реаллокаций в цикле)
    std::vector<RawPhraseBoundary> rawPhrases;
    rawPhrases.reserve(256);

    // 2. Первый проход: сканирование энергии кадрами по 10 мс и детекция речевых сегментов
    bool inSpeech = false;
    size_t phraseStartFrame = 0;
    size_t consecutiveSilenceFrames = 0;

    for (size_t blockIdx = 0; blockIdx < totalAnalysisBlocks; ++blockIdx) {
        const size_t currentFrameOffset = blockIdx * hopFrames;
        const size_t currentSamplesOffset = currentFrameOffset * static_cast<size_t>(channels);
        const size_t currentSamplesCount = hopFrames * static_cast<size_t>(channels);

        float blockSumSquares = 0.0f;
        float blockPeak = 0.0f;
        calculateEnergySIMD(&buffer[currentSamplesOffset], currentSamplesCount, blockSumSquares, blockPeak);

        const float meanSquare = blockSumSquares / static_cast<float>(currentSamplesCount);
        const bool isSpeechFrame = (meanSquare >= thresholdEnergy) || (blockPeak >= thresholdLinear);

        if (!inSpeech) {
            if (isSpeechFrame) {
                inSpeech = true;
                phraseStartFrame = (currentFrameOffset > prePaddingFrames) ? (currentFrameOffset - prePaddingFrames) : 0;
                consecutiveSilenceFrames = 0;
            }
        } else {
            if (!isSpeechFrame) {
                consecutiveSilenceFrames += hopFrames;
                if (consecutiveSilenceFrames >= minSilenceFrames) {
                    // Конец фразы с учетом пост-пэддинга
                    const size_t phraseEnd = std::min(totalFrames, currentFrameOffset + postPaddingFrames);
                    if (phraseEnd > phraseStartFrame + fadeFrames * 2) {
                        rawPhrases.push_back({ phraseStartFrame, phraseEnd });
                    }
                    inSpeech = false;
                    consecutiveSilenceFrames = 0;
                }
            } else {
                consecutiveSilenceFrames = 0;
            }
        }
    }

    // Завершение последней фразы, если дорожка закончилась на речи
    if (inSpeech) {
        const size_t phraseEnd = totalFrames;
        if (phraseEnd > phraseStartFrame + fadeFrames * 2) {
            rawPhrases.push_back({ phraseStartFrame, phraseEnd });
        }
    }

    if (rawPhrases.empty()) {
        return result;
    }

    // 3. Объединение пересекающихся фраз после применения пэддинга
    std::vector<RawPhraseBoundary> mergedPhrases;
    mergedPhrases.reserve(rawPhrases.size());
    mergedPhrases.push_back(rawPhrases[0]);

    for (size_t i = 1; i < rawPhrases.size(); ++i) {
        auto& prev = mergedPhrases.back();
        const auto& curr = rawPhrases[i];

        if (curr.startFrame <= prev.endFrame + fadeFrames) {
            // Фразы стыкуются или пересекаются — объединяем
            prev.endFrame = std::max(prev.endFrame, curr.endFrame);
        } else {
            mergedPhrases.push_back(curr);
        }
    }

    result.phrases.reserve(mergedPhrases.size());

    double totalInputWeightedEnergy = 0.0;
    double totalOutputWeightedEnergy = 0.0;
    size_t totalSpeechSamples = 0;

    const float maxCeilingLinear = dbToGain(config.maxPeakDb);

    // 4. Второй проход: покадровый расчет LUFS / RMS каждой фразы и расчет гейна
    for (const auto& phrase : mergedPhrases) {
        const size_t pStart = phrase.startFrame;
        const size_t pEnd = phrase.endFrame;
        const size_t pFrames = pEnd - pStart;
        const size_t pSamples = pFrames * static_cast<size_t>(channels);

        if (pSamples == 0) continue;

        const float* phraseData = &buffer[pStart * static_cast<size_t>(channels)];
        float phraseSumSquares = 0.0f;
        float phrasePeak = 0.0f;
        calculateEnergySIMD(phraseData, pSamples, phraseSumSquares, phrasePeak);

        const float phraseRms = std::sqrt(phraseSumSquares / static_cast<float>(pSamples));
        const float phraseLufs = gainToDb(phraseRms);
        const float phrasePeakDb = gainToDb(phrasePeak);

        // Расчет необходимого коэффициента усиления к целевому LUFS
        float neededGainDb = config.targetLufs - phraseLufs;

        // Ограничение диапазона гейна пределами [minGainDb .. maxGainDb]
        float appliedGainDb = std::max(config.minGainDb, std::min(config.maxGainDb, neededGainDb));

        // True Peak Guard: предотвращение клиппинга при бусте
        const float potentialPeakLinear = phrasePeak * dbToGain(appliedGainDb);
        if (potentialPeakLinear > maxCeilingLinear && phrasePeak > 1e-5f) {
            const float maxSafeGainDb = gainToDb(maxCeilingLinear / phrasePeak);
            appliedGainDb = std::min(appliedGainDb, maxSafeGainDb);
        }

        const float appliedGainLinear = dbToGain(appliedGainDb);
        const float phrasePeakAfterDb = gainToDb(phrasePeak * appliedGainLinear);

        // 5. Применение Gain Ride с гладкими переходами S-Curve на границах
        const size_t actualFadeFrames = std::min(fadeFrames, pFrames / 4);

        if (actualFadeFrames > 0) {
            // Входной фейд: от 1.0 (пауза) до appliedGainLinear
            applyFadeRamp(buffer, pStart, actualFadeFrames, channels, 1.0f, appliedGainLinear);

            // Основное тело фразы: постоянный гейн с SIMD
            const size_t bodyStartFrame = pStart + actualFadeFrames;
            const size_t bodyFrames = pFrames - actualFadeFrames * 2;
            if (bodyFrames > 0) {
                float* bodyData = &buffer[bodyStartFrame * static_cast<size_t>(channels)];
                applyGainSIMD(bodyData, bodyFrames * static_cast<size_t>(channels), appliedGainLinear);
            }

            // Выходной фейд: от appliedGainLinear назад к 1.0 (пауза)
            const size_t exitStartFrame = pEnd - actualFadeFrames;
            applyFadeRamp(buffer, exitStartFrame, actualFadeFrames, channels, appliedGainLinear, 1.0f);
        } else {
            // Если фраза слишком короткая для плавного фейда
            float* pData = &buffer[pStart * static_cast<size_t>(channels)];
            applyGainSIMD(pData, pSamples, appliedGainLinear);
        }

        // Сохранение статистики фразы
        PhraseInfo info;
        info.startFrame = pStart;
        info.endFrame = pEnd;
        info.durationSec = static_cast<float>(pFrames) / sampleRate;
        info.measuredLufs = phraseLufs;
        info.targetLufs = config.targetLufs;
        info.appliedGainDb = appliedGainDb;
        info.peakBeforeDb = phrasePeakDb;
        info.peakAfterDb = phrasePeakAfterDb;
        result.phrases.push_back(info);

        // Накопление глобальной статистики
        totalInputWeightedEnergy += static_cast<double>(phraseSumSquares);
        totalOutputWeightedEnergy += static_cast<double>(phraseSumSquares) * (appliedGainLinear * appliedGainLinear);
        totalSpeechSamples += pSamples;

        if (appliedGainDb > result.maxBoostDb) {
            result.maxBoostDb = appliedGainDb;
        }
        if (appliedGainDb < result.maxAttenuationDb) {
            result.maxAttenuationDb = appliedGainDb;
        }
    }

    result.totalPhrases = result.phrases.size();

    if (totalSpeechSamples > 0) {
        const double avgInRms = std::sqrt(totalInputWeightedEnergy / static_cast<double>(totalSpeechSamples));
        const double avgOutRms = std::sqrt(totalOutputWeightedEnergy / static_cast<double>(totalSpeechSamples));
        result.averageInputLufs = gainToDb(static_cast<float>(avgInRms));
        result.averageOutputLufs = gainToDb(static_cast<float>(avgOutRms));
    }

    return result;
}

PhraseNormalizerResult OfflinePhraseNormalizer::processTrackPhrasesNative(
    uintptr_t bufferPtr,
    size_t totalFrames,
    int channels,
    float sampleRate,
    const PhraseNormalizerConfig& config
) {
    if (bufferPtr == 0 || totalFrames == 0 || channels <= 0) {
        return PhraseNormalizerResult{};
    }

    float* rawBuffer = reinterpret_cast<float*>(bufferPtr);
    return processTrackPhrasesWithStats(rawBuffer, totalFrames, channels, sampleRate, config);
}

} // namespace DAWCore
