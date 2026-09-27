/**
 * ============================================================================
 * SubtitleAligner.cpp - Реализация потокового парсера субтитров и якорного выравнивания
 * ============================================================================
 * Стандарт: C++17.
 * ============================================================================
 */

#include "SubtitleAligner.hpp"
#include <sstream>
#include <cctype>

namespace DAWCore {

// Вспомогательные утилиты для работы с std::string_view
static std::string_view trimView(std::string_view sv) {
    while (!sv.empty() && (sv.front() == ' ' || sv.front() == '\t' || sv.front() == '\r' || sv.front() == '\n')) {
        sv.remove_prefix(1);
    }
    while (!sv.empty() && (sv.back() == ' ' || sv.back() == '\t' || sv.back() == '\r' || sv.back() == '\n')) {
        sv.remove_suffix(1);
    }
    return sv;
}

static bool startsWithCaseInsensitive(std::string_view str, std::string_view prefix) {
    if (str.size() < prefix.size()) return false;
    for (size_t i = 0; i < prefix.size(); ++i) {
        if (std::tolower(static_cast<unsigned char>(str[i])) != std::tolower(static_cast<unsigned char>(prefix[i]))) {
            return false;
        }
    }
    return true;
}

std::string SubtitleParser::stripFormattingTags(std::string_view text) {
    std::string result;
    result.reserve(text.size());

    bool inHtmlTag = false;
    bool inAssTag = false;

    for (size_t i = 0; i < text.size(); ++i) {
        char ch = text[i];

        if (ch == '<') {
            inHtmlTag = true;
            continue;
        } else if (ch == '>') {
            inHtmlTag = false;
            continue;
        }

        if (ch == '{') {
            inAssTag = true;
            continue;
        } else if (ch == '}') {
            inAssTag = false;
            continue;
        }

        if (!inHtmlTag && !inAssTag) {
            // Замена переносов ASS (\N, \n, \h)
            if (ch == '\\' && i + 1 < text.size()) {
                char nextCh = text[i + 1];
                if (nextCh == 'N' || nextCh == 'n') {
                    result.push_back(' ');
                    i++;
                    continue;
                } else if (nextCh == 'h') {
                    result.push_back(' ');
                    i++;
                    continue;
                }
            }

            if (ch == '\r' || ch == '\n') {
                if (!result.empty() && result.back() != ' ') {
                    result.push_back(' ');
                }
            } else {
                result.push_back(ch);
            }
        }
    }

    // Удаление повторяющихся пробелов
    std::string clean;
    clean.reserve(result.size());
    bool prevSpace = true;
    for (char c : result) {
        if (c == ' ' || c == '\t') {
            if (!prevSpace) {
                clean.push_back(' ');
                prevSpace = true;
            }
        } else {
            clean.push_back(c);
            prevSpace = false;
        }
    }
    while (!clean.empty() && clean.back() == ' ') {
        clean.pop_back();
    }

    return clean;
}

float SubtitleParser::parseTimestamp(std::string_view timeStr) {
    timeStr = trimView(timeStr);
    if (timeStr.empty()) return 0.0f;

    // Поддержка форматов:
    // 00:01:23,456 (SRT)
    // 00:01:23.456 (VTT)
    // 0:01:23.45 (ASS)
    // 01:23.456 (Короткий VTT)

    float hours = 0.0f;
    float minutes = 0.0f;
    float seconds = 0.0f;
    float fraction = 0.0f;

    size_t firstColon = timeStr.find(':');
    if (firstColon == std::string_view::npos) return 0.0f;

    size_t secondColon = timeStr.find(':', firstColon + 1);

    if (secondColon != std::string_view::npos) {
        // HH:MM:SS.mmm
        std::string_view hStr = timeStr.substr(0, firstColon);
        std::string_view mStr = timeStr.substr(firstColon + 1, secondColon - firstColon - 1);
        std::string_view rest = timeStr.substr(secondColon + 1);

        hours = static_cast<float>(std::atof(std::string(hStr).c_str()));
        minutes = static_cast<float>(std::atof(std::string(mStr).c_str()));

        // Разделяем секунды и доли (точка или запятая)
        size_t fracSep = rest.find_first_of(".,");
        if (fracSep != std::string_view::npos) {
            std::string_view sStr = rest.substr(0, fracSep);
            std::string_view fStr = rest.substr(fracSep + 1);
            seconds = static_cast<float>(std::atof(std::string(sStr).c_str()));
            float divisor = std::pow(10.0f, static_cast<float>(fStr.size()));
            fraction = static_cast<float>(std::atof(std::string(fStr).c_str())) / (divisor > 0.0f ? divisor : 1000.0f);
        } else {
            seconds = static_cast<float>(std::atof(std::string(rest).c_str()));
        }
    } else {
        // MM:SS.mmm
        std::string_view mStr = timeStr.substr(0, firstColon);
        std::string_view rest = timeStr.substr(firstColon + 1);

        minutes = static_cast<float>(std::atof(std::string(mStr).c_str()));
        size_t fracSep = rest.find_first_of(".,");
        if (fracSep != std::string_view::npos) {
            std::string_view sStr = rest.substr(0, fracSep);
            std::string_view fStr = rest.substr(fracSep + 1);
            seconds = static_cast<float>(std::atof(std::string(sStr).c_str()));
            float divisor = std::pow(10.0f, static_cast<float>(fStr.size()));
            fraction = static_cast<float>(std::atof(std::string(fStr).c_str())) / (divisor > 0.0f ? divisor : 1000.0f);
        } else {
            seconds = static_cast<float>(std::atof(std::string(rest).c_str()));
        }
    }

    return (hours * 3600.0f) + (minutes * 60.0f) + seconds + fraction;
}

std::vector<SubtitleCueNative> SubtitleParser::parseSrt(std::string_view content) {
    std::vector<SubtitleCueNative> cues;
    cues.reserve(128);

    size_t pos = 0;
    const size_t len = content.size();
    int cueIndex = 1;

    while (pos < len) {
        // Поиск конца текущей строки
        size_t lineEnd = content.find('\n', pos);
        if (lineEnd == std::string_view::npos) lineEnd = len;

        std::string_view line = content.substr(pos, lineEnd - pos);
        line = trimView(line);
        pos = lineEnd + 1;

        if (line.empty() || line == "WEBVTT") {
            continue;
        }

        // Проверка таймкод-стрелки "-->"
        size_t arrowPos = line.find("-->");
        if (arrowPos != std::string_view::npos) {
            std::string_view startStr = trimView(line.substr(0, arrowPos));
            std::string_view endStr = trimView(line.substr(arrowPos + 3));

            // Отсекаем параметры форматирования WebVTT после endStr (например, align:start position:0%)
            size_t extraSpace = endStr.find_first_of(" \t");
            if (extraSpace != std::string_view::npos) {
                endStr = endStr.substr(0, extraSpace);
            }

            float startSec = parseTimestamp(startStr);
            float endSec = parseTimestamp(endStr);

            // Считываем текст субтитра до пустой строки
            std::string textAccum;
            while (pos < len) {
                size_t nextEnd = content.find('\n', pos);
                if (nextEnd == std::string_view::npos) nextEnd = len;
                std::string_view textLine = trimView(content.substr(pos, nextEnd - pos));
                pos = nextEnd + 1;

                if (textLine.empty()) {
                    break;
                }
                if (!textAccum.empty()) {
                    textAccum.push_back(' ');
                }
                textAccum.append(textLine.data(), textLine.size());
            }

            std::string speaker;
            std::string cleanText = stripFormattingTags(textAccum);

            // Извлечение спикера из формата "Иван: Текст" или "<v Иван>Текст"
            size_t colonPos = cleanText.find(':');
            if (colonPos != std::string_view::npos && colonPos < 30) {
                speaker = cleanText.substr(0, colonPos);
                cleanText = cleanText.substr(colonPos + 1);
                cleanText = std::string(trimView(cleanText));
            }

            if (!cleanText.empty()) {
                SubtitleCueNative cue;
                cue.index = cueIndex++;
                cue.startSec = startSec;
                cue.endSec = endSec;
                cue.speaker = speaker;
                cue.text = cleanText;
                cues.push_back(std::move(cue));
            }
        }
    }

    return cues;
}

std::vector<SubtitleCueNative> SubtitleParser::parseAss(std::string_view content) {
    std::vector<SubtitleCueNative> cues;
    cues.reserve(128);

    size_t pos = 0;
    const size_t len = content.size();
    int cueIndex = 1;

    bool inEvents = false;
    std::vector<std::string> formatFields;

    while (pos < len) {
        size_t lineEnd = content.find('\n', pos);
        if (lineEnd == std::string_view::npos) lineEnd = len;

        std::string_view line = trimView(content.substr(pos, lineEnd - pos));
        pos = lineEnd + 1;

        if (line.empty() || line.front() == ';') {
            continue;
        }

        if (startsWithCaseInsensitive(line, "[Events]")) {
            inEvents = true;
            continue;
        } else if (line.front() == '[' && line.back() == ']') {
            inEvents = false;
            continue;
        }

        if (inEvents) {
            if (startsWithCaseInsensitive(line, "Format:")) {
                formatFields.clear();
                std::string_view fieldsStr = trimView(line.substr(7));
                size_t fPos = 0;
                while (fPos < fieldsStr.size()) {
                    size_t comma = fieldsStr.find(',', fPos);
                    if (comma == std::string_view::npos) comma = fieldsStr.size();
                    formatFields.push_back(std::string(trimView(fieldsStr.substr(fPos, comma - fPos))));
                    fPos = comma + 1;
                }
            } else if (startsWithCaseInsensitive(line, "Dialogue:")) {
                std::string_view dialogueStr = trimView(line.substr(9));

                // Разделяем по полям формата
                size_t fPos = 0;
                std::vector<std::string_view> values;
                const size_t maxFields = formatFields.empty() ? 9 : formatFields.size() - 1;

                for (size_t f = 0; f < maxFields && fPos < dialogueStr.size(); ++f) {
                    size_t comma = dialogueStr.find(',', fPos);
                    if (comma == std::string_view::npos) break;
                    values.push_back(trimView(dialogueStr.substr(fPos, comma - fPos)));
                    fPos = comma + 1;
                }
                if (fPos <= dialogueStr.size()) {
                    values.push_back(dialogueStr.substr(fPos)); // Оставшийся текст
                }

                // Поиск индексов Start, End, Name/Actor, Text
                int startIdx = 1, endIdx = 2, nameIdx = 4, textIdx = 9;
                if (!formatFields.empty()) {
                    for (size_t i = 0; i < formatFields.size(); ++i) {
                        if (startsWithCaseInsensitive(formatFields[i], "Start")) startIdx = static_cast<int>(i);
                        else if (startsWithCaseInsensitive(formatFields[i], "End")) endIdx = static_cast<int>(i);
                        else if (startsWithCaseInsensitive(formatFields[i], "Name") || startsWithCaseInsensitive(formatFields[i], "Actor")) nameIdx = static_cast<int>(i);
                        else if (startsWithCaseInsensitive(formatFields[i], "Text")) textIdx = static_cast<int>(i);
                    }
                }

                if (static_cast<int>(values.size()) > std::max(startIdx, endIdx)) {
                    float startSec = parseTimestamp(values[startIdx]);
                    float endSec = parseTimestamp(values[endIdx]);
                    std::string speaker;
                    if (nameIdx >= 0 && nameIdx < static_cast<int>(values.size())) {
                        speaker = std::string(values[nameIdx]);
                    }
                    std::string_view rawText = (textIdx >= 0 && textIdx < static_cast<int>(values.size())) ? values[textIdx] : "";
                    std::string cleanText = stripFormattingTags(rawText);

                    if (!cleanText.empty()) {
                        SubtitleCueNative cue;
                        cue.index = cueIndex++;
                        cue.startSec = startSec;
                        cue.endSec = endSec;
                        cue.speaker = speaker;
                        cue.text = cleanText;
                        cues.push_back(std::move(cue));
                    }
                }
            }
        }
    }

    return cues;
}

std::vector<SubtitleCueNative> SubtitleParser::parseSrtAss(std::string_view rawContent) {
    if (rawContent.find("[Script Info]") != std::string_view::npos ||
        rawContent.find("[Events]") != std::string_view::npos ||
        rawContent.find("Dialogue:") != std::string_view::npos) {
        return parseAss(rawContent);
    }
    return parseSrt(rawContent);
}

// ============================================================================
// SubtitleAligner - Якорное сопоставление (Anchor-based)
// ============================================================================

std::vector<AlignedPhrase> SubtitleAligner::alignWithAnchor(
    const std::vector<ScriptLine>& scriptLines,
    const std::vector<SpeechSegment>& speechSegments,
    float maxDriftSec
) {
    std::vector<AlignedPhrase> aligned;
    aligned.reserve(scriptLines.size());

    if (scriptLines.empty()) {
        return aligned;
    }

    const float tolerance = (maxDriftSec > 0.0f) ? maxDriftSec : 0.5f;

    for (const auto& script : scriptLines) {
        AlignedPhrase phrase;
        phrase.lineIndex = script.index;
        phrase.scriptText = script.text;
        phrase.expectedStartSec = script.startSec;
        phrase.expectedEndSec = script.endSec;

        const float targetMid = (script.startSec + script.endSec) * 0.5f;
        const SpeechSegment* bestSeg = nullptr;
        float minTimeDiff = 1e9f;

        for (const auto& seg : speechSegments) {
            const float segMid = (seg.startSec + seg.endSec) * 0.5f;
            const float diff = std::abs(segMid - targetMid);

            if (diff < minTimeDiff) {
                minTimeDiff = diff;
                bestSeg = &seg;
            }
        }

        if (bestSeg && minTimeDiff < 5.0f) {
            float rawDrift = bestSeg->startSec - script.startSec;

            if (std::abs(rawDrift) > tolerance) {
                // Превышение допустимого порога: жесткая якорная фиксация без эффекта домино
                phrase.actualStartSec = script.startSec;
                phrase.actualEndSec = script.endSec;
                phrase.timeDriftSec = 0.0f;
                phrase.status = "matched";
            } else {
                phrase.actualStartSec = bestSeg->startSec;
                phrase.actualEndSec = bestSeg->endSec;
                phrase.timeDriftSec = rawDrift;
                phrase.status = (std::abs(rawDrift) > (tolerance * 0.6f)) ? "drifted" : "matched";
            }

            std::ostringstream ss;
            ss << "[Речь " << std::fixed << std::setprecision(1) << bestSeg->durationSec << "с]";
            phrase.recognizedText = ss.str();
            phrase.similarityScore = 0.90f;
        } else {
            phrase.actualStartSec = 0.0f;
            phrase.actualEndSec = 0.0f;
            phrase.timeDriftSec = 0.0f;
            phrase.recognizedText = "";
            phrase.similarityScore = 0.0f;
            phrase.status = "missing";
        }

        aligned.push_back(phrase);
    }

    return aligned;
}

std::vector<AlignedPhrase> SubtitleAligner::alignCuesWithAnchor(
    const std::vector<SubtitleCueNative>& cues,
    const std::vector<SpeechSegment>& speechSegments,
    float maxDriftSec
) {
    std::vector<ScriptLine> lines;
    lines.reserve(cues.size());
    for (const auto& cue : cues) {
        ScriptLine line;
        line.index = cue.index;
        line.startSec = cue.startSec;
        line.endSec = cue.endSec;
        line.text = cue.text;
        line.speaker = cue.speaker;
        lines.push_back(line);
    }
    return alignWithAnchor(lines, speechSegments, maxDriftSec);
}

} // namespace DAWCore
