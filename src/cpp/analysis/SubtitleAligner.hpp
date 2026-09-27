#pragma once

/**
 * ============================================================================
 * SubtitleAligner.hpp - Нативный модуль парсинга субтитров и сопоставления
 * ============================================================================
 * Стандарт: C++17.
 * 
 * Особенности:
 * 1. ZERO-COPY / MINIMAL-COPY: Использование std::string_view для потокового разбора
 *    субтитров форматов SRT, ASS/SSA, WebVTT.
 * 2. ТЕГООЧИСТКА: Удаление HTML-тегов (<i>, <b>, <font...>) и караоке-тегов SSA/ASS ({\...}).
 * 3. FAST LEVENSHTEIN UTF-8: Алгоритм вычисления сходства строк с поддержкой кириллицы
 *    (а-я, ё) и латиницы (a-z).
 * 4. ANCHOR-BASED ALIGNMENT: Якорное выравнивание речевых сегментов со сценарием с жестким
 *    допуском дрейфа (maxDriftSec), предотвращающее эффект домино при сдвиге таймингов.
 * ============================================================================
 */

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>
#include <cmath>
#include <algorithm>

#include "SpeechAligner.hpp"

namespace DAWCore {

/**
 * @brief Нативная структура реплики субтитров / сценария
 */
struct SubtitleCueNative {
    int index{0};             ///< Порядковый номер реплики (1-based)
    float startSec{0.0f};     ///< Время начала в секундах
    float endSec{0.0f};       ///< Время окончания в секундах
    std::string speaker;      ///< Имя персонажа / диктора (если указано)
    std::string text;         ///< Очищенный текст реплики
};

/**
 * @brief Парсер текстовых форматов субтитров (SRT, ASS, SSA, VTT)
 */
class SubtitleParser {
public:
    /**
     * @brief Универсальный быстрый парсер содержимого субтитров SRT, ASS/SSA, WebVTT
     * 
     * @param rawContent Строковый буфер с содержимым файла
     * @return std::vector<SubtitleCueNative> Список распарсенных реплик
     */
    static std::vector<SubtitleCueNative> parseSrtAss(std::string_view rawContent);

    /**
     * @brief Парсинг формата SubRip (.srt) и WebVTT (.vtt)
     */
    static std::vector<SubtitleCueNative> parseSrt(std::string_view content);

    /**
     * @brief Парсинг формата Advanced SubStation Alpha (.ass / .ssa)
     */
    static std::vector<SubtitleCueNative> parseAss(std::string_view content);

    /**
     * @brief Очистка строки от HTML-тегов, тегов стилей ASS/SSA ({\...}) и лишних пробелов
     */
    static std::string stripFormattingTags(std::string_view text);

    /**
     * @brief Парсинг таймкода формата "HH:MM:SS,mmm" (SRT) или "H:MM:SS.cc" (ASS) в секунды
     */
    static float parseTimestamp(std::string_view timeStr);
};

/**
 * @brief Модуль якорного сопоставления речевых сегментов и субтитров
 */
class SubtitleAligner {
public:
    /**
     * @brief Якорное сопоставление распознанной речи со сценарием
     * 
     * @param scriptLines Исходные реплики сценария / субтитров
     * @param speechSegments Обнаруженные сегменты речевой активности (VAD) или фразы ASR
     * @param maxDriftSec Максимально допустимый дрейф времени (например, ±0.5 с)
     * @return std::vector<AlignedPhrase> Результаты сопоставления
     */
    static std::vector<AlignedPhrase> alignWithAnchor(
        const std::vector<ScriptLine>& scriptLines,
        const std::vector<SpeechSegment>& speechSegments,
        float maxDriftSec = 0.5f
    );

    /**
     * @brief Сопоставление с субтитрами напрямую через SubtitleCueNative
     */
    static std::vector<AlignedPhrase> alignCuesWithAnchor(
        const std::vector<SubtitleCueNative>& cues,
        const std::vector<SpeechSegment>& speechSegments,
        float maxDriftSec = 0.5f
    );
};

} // namespace DAWCore
