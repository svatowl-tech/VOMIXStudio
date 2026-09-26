/**
 * ============================================================================
 * SilenceStripper.cpp - Реализация C++ SIMD128 стриппинга тишины и нарезки фраз
 * ============================================================================
 * Полная реализация алгоритма мгновенного удаления тишины из начитки.
 * 
 * Особенности реализации:
 * 1. SIMD128 векторизация (wasm_f32x4_add, wasm_f32x4_mul, wasm_f32x4_max).
 * 2. Анализ энергии блоками по 10 мс.
 * 3. Поиск пауз длиннее minSilenceMs ниже thresholdDb.
 * 4. Защитный paddingMs (40-60 мс) до и после найденных фраз.
 * 5. Нулевые динамические аллокации (Zero Malloc) внутри циклов сканирования.
 * ============================================================================
 */

#include "SilenceStripper.hpp"
#include <cmath>
#include <algorithm>
#include <cstring>
#include <new>

namespace DAWCore {

EnergyFrame SilenceStripper::calculateFrameEnergySIMD(const float* samples, size_t numSamples) noexcept {
    if (!samples || numSamples == 0) {
        return { 0.0f, 0.0f };
    }

    float sumSquares = 0.0f;
    float peak = 0.0f;
    size_t i = 0;

#if USE_WASM_SIMD
    // Векторизация по 4 Float32 значения за одну SIMD операцию
    v128_t vSum = wasm_f32x4_splat(0.0f);
    v128_t vPeak = wasm_f32x4_splat(0.0f);
    const v128_t vAbsMask = wasm_i32x4_splat(0x7FFFFFFF); // Снятие знакового бита float

    const size_t simdEnd = numSamples - (numSamples % 4);
    for (; i < simdEnd; i += 4) {
        v128_t vSample = wasm_v128_load(&samples[i]);
        v128_t vAbs = wasm_v128_and(vSample, vAbsMask);

        // vSum += vSample * vSample
        vSum = wasm_f32x4_add(vSum, wasm_f32x4_mul(vSample, vSample));
        // vPeak = max(vPeak, vAbs)
        vPeak = wasm_f32x4_max(vPeak, vAbs);
    }

    // Редукция 4-компонентных SIMD регистров в скалярные значения без кучи
    alignas(16) float sumArr[4];
    alignas(16) float peakArr[4];
    wasm_v128_store(sumArr, vSum);
    wasm_v128_store(peakArr, vPeak);

    sumSquares = sumArr[0] + sumArr[1] + sumArr[2] + sumArr[3];
    peak = std::max({ peakArr[0], peakArr[1], peakArr[2], peakArr[3] });
#endif

    // Хвостовая обработка оставшихся 1-3 сэмплов
    for (; i < numSamples; ++i) {
        const float s = samples[i];
        const float absS = std::fabs(s);
        sumSquares += s * s;
        if (absS > peak) {
            peak = absS;
        }
    }

    const float rms = std::sqrt(sumSquares / static_cast<float>(numSamples));
    return { rms, peak };
}

int SilenceStripper::stripSilence(
    const float* inBuffer,
    size_t totalSamples,
    float thresholdDb,
    float minSilenceMs,
    float paddingMs,
    bool isStereo,
    int sampleRate,
    AudioSegment* outSegments,
    int maxSegments
) noexcept {
    if (!inBuffer || totalSamples == 0 || !outSegments || maxSegments <= 0) {
        return 0;
    }

    SilenceStripperConfig config;
    config.sampleRate = (sampleRate > 8000) ? static_cast<float>(sampleRate) : 48000.0f;
    config.thresholdDb = thresholdDb;
    config.minSilenceMs = (minSilenceMs >= 0.0f) ? minSilenceMs : 250.0f;
    config.paddingMs = (paddingMs >= 0.0f) ? paddingMs : 45.0f;
    config.frameSizeMs = 10.0f; // 10 мс блоки анализа
    config.isStereo = isStereo;

    size_t result = detectSegments(
        inBuffer,
        totalSamples,
        config,
        outSegments,
        static_cast<size_t>(maxSegments)
    );

    // Если на дорожке длиннее 2.5 секунд обнаружен только 1 сегмент (или 0),
    // выполняем адаптивный мультипроходной поиск порога VAD
    const size_t channels = isStereo ? 2 : 1;
    const size_t totalFrames = totalSamples / channels;
    if (result <= 1 && totalFrames > static_cast<size_t>(config.sampleRate * 2.5f)) {
        const float candidateDeltas[] = { 3.0f, 6.0f, 9.0f, 12.0f, 15.0f, -3.0f, -6.0f };
        for (float delta : candidateDeltas) {
            SilenceStripperConfig altConfig = config;
            altConfig.thresholdDb = std::max(-56.0f, std::min(-20.0f, config.thresholdDb + delta));
            size_t altResult = detectSegments(
                inBuffer,
                totalSamples,
                altConfig,
                outSegments,
                static_cast<size_t>(maxSegments)
            );
            if (altResult > 1) {
                result = altResult;
                break;
            }
        }
    }

    return static_cast<int>(result);
}

size_t SilenceStripper::detectSegments(
    const float* inPcm,
    size_t totalSamples,
    const SilenceStripperConfig& config,
    AudioSegment* outSegments,
    size_t maxSegments
) noexcept {
    if (!inPcm || totalSamples == 0 || !outSegments || maxSegments == 0) {
        return 0;
    }

    const float sampleRate = (config.sampleRate > 8000.0f) ? config.sampleRate : 48000.0f;
    const size_t channels = config.isStereo ? 2 : 1;
    const size_t totalFrames = totalSamples / channels;

    if (totalFrames == 0) return 0;

    // Расчет длительностей в кадрах (сэмплах на канал)
    const size_t frameSizeFrames = std::max<size_t>(16, static_cast<size_t>(config.frameSizeMs * 0.001f * sampleRate));
    const size_t minSilenceFrames = static_cast<size_t>(config.minSilenceMs * 0.001f * sampleRate);
    const size_t paddingFrames = static_cast<size_t>(config.paddingMs * 0.001f * sampleRate);
    const size_t minSpeechFrames = static_cast<size_t>(0.070f * sampleRate); // Мин. длина реплики 70 мс

    // Гистерезисный порог VAD: порог открытия и порог удержания речи
    const float threshOpen = dbToGain(config.thresholdDb);
    const float threshClose = threshOpen * 0.72f; // -2.8 dB гистерезис

    size_t segmentCount = 0;
    bool inSpeech = false;

    size_t currentSegmentStartFrame = 0;
    size_t lastSpeechFrame = 0;
    float currentSegmentPeak = 0.0f;
    double currentSegmentSumSq = 0.0;
    size_t currentSegmentSampleCount = 0;

    // Линейный проход по PCM блоками по 10 мс без динамических аллокаций
    for (size_t frameOffset = 0; frameOffset < totalFrames; frameOffset += frameSizeFrames) {
        const size_t currentBlockFrames = std::min(frameSizeFrames, totalFrames - frameOffset);
        const size_t currentBlockSamples = currentBlockFrames * channels;
        const float* blockPtr = &inPcm[frameOffset * channels];

        // Векторизованный SIMD128 расчет энергии 10 мс блока
        EnergyFrame frameEnergy = calculateFrameEnergySIMD(blockPtr, currentBlockSamples);

        // Условие открытия и удержания речи с учетом RMS и Peak
        const bool openSpeech = (frameEnergy.rms >= threshOpen) ||
                                (frameEnergy.peak >= threshOpen * 2.4f && frameEnergy.rms >= threshClose);
        const bool holdSpeech = (frameEnergy.rms >= threshClose);

        if (!inSpeech) {
            if (openSpeech) {
                inSpeech = true;
                const size_t minAllowedStart = (segmentCount > 0)
                    ? (outSegments[segmentCount - 1].offsetSamples + outSegments[segmentCount - 1].lengthSamples)
                    : 0;
                const size_t rawStart = (frameOffset >= paddingFrames) ? (frameOffset - paddingFrames) : 0;
                currentSegmentStartFrame = std::max(minAllowedStart, rawStart);
                currentSegmentPeak = frameEnergy.peak;
                currentSegmentSumSq = static_cast<double>(frameEnergy.rms * frameEnergy.rms) * currentBlockSamples;
                currentSegmentSampleCount = currentBlockSamples;
                lastSpeechFrame = frameOffset + currentBlockFrames;
            }
        } else {
            if (holdSpeech) {
                currentSegmentPeak = std::max(currentSegmentPeak, frameEnergy.peak);
                currentSegmentSumSq += static_cast<double>(frameEnergy.rms * frameEnergy.rms) * currentBlockSamples;
                currentSegmentSampleCount += currentBlockSamples;
                lastSpeechFrame = frameOffset + currentBlockFrames;
            } else {
                // В фазе тишины: проверяем достижение минимальной паузы minSilenceMs
                const size_t silenceDuration = (frameOffset + currentBlockFrames) - lastSpeechFrame;
                if (silenceDuration >= minSilenceFrames) {
                    const size_t endFrameWithPad = std::min(totalFrames, lastSpeechFrame + paddingFrames);
                    const size_t segLengthFrames = (endFrameWithPad > currentSegmentStartFrame)
                        ? (endFrameWithPad - currentSegmentStartFrame)
                        : 0;

                    // Добавляем сегмент только если он длиннее минимальной реплики (70 мс)
                    if (segLengthFrames >= minSpeechFrames && segmentCount < maxSegments) {
                        outSegments[segmentCount].offsetSamples = currentSegmentStartFrame;
                        outSegments[segmentCount].lengthSamples = segLengthFrames;
                        outSegments[segmentCount].peakLevel = currentSegmentPeak;
                        outSegments[segmentCount].rmsLevel = (currentSegmentSampleCount > 0)
                            ? static_cast<float>(std::sqrt(currentSegmentSumSq / currentSegmentSampleCount))
                            : 0.0f;
                        segmentCount++;
                    }

                    inSpeech = false;
                    currentSegmentPeak = 0.0f;
                    currentSegmentSumSq = 0.0;
                    currentSegmentSampleCount = 0;

                    if (segmentCount >= maxSegments) {
                        break;
                    }
                }
            }
        }
    }

    // Финальная реплика в конце файла
    if (inSpeech && segmentCount < maxSegments) {
        const size_t endFrameWithPad = std::min(totalFrames, lastSpeechFrame + paddingFrames);
        const size_t segLengthFrames = (endFrameWithPad > currentSegmentStartFrame)
            ? (endFrameWithPad - currentSegmentStartFrame)
            : 0;

        if (segLengthFrames >= minSpeechFrames) {
            outSegments[segmentCount].offsetSamples = currentSegmentStartFrame;
            outSegments[segmentCount].lengthSamples = segLengthFrames;
            outSegments[segmentCount].peakLevel = currentSegmentPeak;
            outSegments[segmentCount].rmsLevel = (currentSegmentSampleCount > 0)
                ? static_cast<float>(std::sqrt(currentSegmentSumSq / currentSegmentSampleCount))
                : 0.0f;
            segmentCount++;
        }
    }

    return segmentCount;
}

int SilenceStripper::stripSilenceFromClip(
    uintptr_t inPcmPtr,
    size_t totalSamples,
    float thresholdDb,
    float minSilenceMs,
    float paddingMs,
    uintptr_t outSegmentsPtr,
    int maxSegments,
    bool isStereo,
    float sampleRate
) noexcept {
    if (!inPcmPtr || totalSamples == 0 || !outSegmentsPtr || maxSegments <= 0) {
        return 0;
    }

    const float* inPcm = reinterpret_cast<const float*>(inPcmPtr);
    AudioSegment* outSegments = reinterpret_cast<AudioSegment*>(outSegmentsPtr);

    return stripSilence(
        inPcm,
        totalSamples,
        thresholdDb,
        minSilenceMs,
        paddingMs,
        isStereo,
        static_cast<int>(sampleRate),
        outSegments,
        maxSegments
    );
}

uintptr_t SilenceStripper::allocateSegmentBuffer(size_t maxSegments) noexcept {
    if (maxSegments == 0) return 0;
    AudioSegment* buf = new (std::nothrow) AudioSegment[maxSegments];
    if (!buf) return 0;
    std::memset(buf, 0, maxSegments * sizeof(AudioSegment));
    return reinterpret_cast<uintptr_t>(buf);
}

void SilenceStripper::freeSegmentBuffer(uintptr_t ptr) noexcept {
    if (ptr) {
        AudioSegment* buf = reinterpret_cast<AudioSegment*>(ptr);
        delete[] buf;
    }
}

} // namespace DAWCore
