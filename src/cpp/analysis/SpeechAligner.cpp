/**
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

// ============================================================================
// 1. FastLevenshtein - Реализация
// ============================================================================

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
            // 1-байтовый ASCII (0x00 .. 0x7F)
            cp = byte0;
            i += 1;
        } else if ((byte0 & 0xE0) == 0xC0) {
            // 2-байтовая последовательность UTF-8 (Кириллица, расширенная латиница)
            if (i + 1 < len) {
                uint8_t byte1 = ptr[i + 1];
                cp = ((byte0 & 0x1F) << 6) | (byte1 & 0x3F);
                i += 2;
            } else {
                i += 1;
                continue;
            }
        } else if ((byte0 & 0xF0) == 0xE0) {
            // 3-байтовая последовательность UTF-8
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
            // 4-байтовая последовательность UTF-8 (Emoji и доп. символы)
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
            // Невалидный байт UTF-8 - пропускаем
            i += 1;
            continue;
        }

        // Приведение регистра к нижнему (LowerCase) и фильтрация символов
        // Латиница A-Z -> a-z
        if (cp >= 0x41 && cp <= 0x5A) {
            result.push_back(cp + 0x20);
        }
        // Латиница a-z, цифры 0-9, символ подчеркивания
        else if ((cp >= 0x61 && cp <= 0x7A) || (cp >= 0x30 && cp <= 0x39) || cp == 0x5F) {
            result.push_back(cp);
        }
        // Кириллица: Заглавные А-Я (0x0410 .. 0x042F) -> Строчные а-я (0x0430 .. 0x044F)
        else if (cp >= 0x0410 && cp <= 0x042F) {
            result.push_back(cp + 0x20);
        }
        // Кириллица: Заглавная 'Ё' (0x0401) -> 'ё' (0x0451)
        else if (cp == 0x0401) {
            result.push_back(0x0451);
        }
        // Кириллица: Строчные а-я (0x0430 .. 0x044F) и 'ё' (0x0451)
        else if ((cp >= 0x0430 && cp <= 0x044F) || cp == 0x0451) {
            result.push_back(cp);
        }
        // Все остальные знаки препинания, пробелы, спецсимволы отбрасываются
    }

    return result;
}

size_t FastLevenshtein::distanceCodepoints(const std::vector<uint32_t>& v1, const std::vector<uint32_t>& v2) {
    const size_t len1 = v1.size();
    const size_t len2 = v2.size();

    if (len1 == 0) return len2;
    if (len2 == 0) return len1;

    // Гарантируем, что len2 <= len1 для минимального размера вектора dp
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
                dp[j] + 1,            // удаление
                dp[j - 1] + 1,        // вставка
                prevDiagonal + cost   // замена
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

// ============================================================================
// 2. SpeechEnergyDetector - Реализация
// ============================================================================

FrameEnergyStats SpeechEnergyDetector::calculateFrameStats(const float* samples, size_t length) noexcept {
    FrameEnergyStats stats;
    if (!samples || length == 0) return stats;

    float sumSquares = 0.0f;
    float peakVal = 0.0f;
    size_t zcrCount = 0;

#if USE_WASM_SIMD
    // Векторизованный подсчет суммы квадратов и поиск пика через SIMD128
    v128_t sumVec = wasm_f32x4_splat(0.0f);
    v128_t maxVec = wasm_f32x4_splat(0.0f);

    size_t simdLimit = (length / 4) * 4;
    for (size_t i = 0; i < simdLimit; i += 4) {
        v128_t inVec = wasm_v128_load(&samples[i]);
        sumVec = wasm_f32x4_add(sumVec, wasm_f32x4_mul(inVec, inVec));
        v128_t absVec = wasm_f32x4_abs(inVec);
        maxVec = wasm_f32x4_max(maxVec, absVec);
    }

    alignas(16) float sumArr[4];
    alignas(16) float maxArr[4];
    wasm_v128_store(sumArr, sumVec);
    wasm_v128_store(maxArr, maxVec);

    sumSquares = sumArr[0] + sumArr[1] + sumArr[2] + sumArr[3];
    peakVal = std::max({maxArr[0], maxArr[1], maxArr[2], maxArr[3]});

    // Обработка остаточных сэмплов
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

    // Подсчет Zero-Crossing Rate (ZCR) - пересечений нулевой оси
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

    // Речевые характеристики: RMS выше шумового порога и ZCR в речевом диапазоне (4%..45%)
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
    // Окно анализа ~32 мс (512 сэмплов при 16 кГц, 1536 при 48 кГц)
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

                // Закрытие сегмента при превышении порога паузы
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

    // Проверка последнего незакрытого сегмента
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

// ============================================================================
// 3. SmartAligner - Реализация
// ============================================================================

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

    // Если нет ни речевых сегментов, ни транскрипции - все строки маркируются как 'missing'
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

    // Выравнивание строк сценария по времени и тексту
    for (const auto& scriptLine : scriptLines) {
        const float targetMidTime = (scriptLine.startSec + scriptLine.endSec) * 0.5f;

        // 1. Поиск лучшего совпадения среди распознанных фраз ASR (по тексту и времени)
        const TranscriptionSegment* bestAsr = nullptr;
        float bestTextScore = -1.0f;
        float minAsrTimeDiff = 1e9f;

        for (const auto& asr : transcriptionSegments) {
            const float asrMidTime = (asr.startSec + asr.endSec) * 0.5f;
            const float timeDiff = std::abs(asrMidTime - targetMidTime);

            if (timeDiff < 8.0f) {
                float sim = FastLevenshtein::similarity(scriptLine.text, asr.text);
                // Комбинированный скор: текст (70%) + временная близость (30%)
                float combinedScore = sim * 0.7f + std::max(0.0f, (8.0f - timeDiff) / 8.0f) * 0.3f;

                if (combinedScore > bestTextScore) {
                    bestTextScore = combinedScore;
                    bestAsr = &asr;
                    minAsrTimeDiff = timeDiff;
                }
            }
        }

        // 2. Поиск ближайшего VAD сегмента речи (по временной оси)
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

        // 3. Формирование сопоставленной реплики
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
