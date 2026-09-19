#pragma once

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

// ============================================================================
// Структуры данных
// ============================================================================

/**
 * Статистика спектральной энергии и частоты пересечения нуля для аудиофрейма
 */
struct FrameEnergyStats {
    float rms{0.0f};
    float zcrRatio{0.0f};
    float voiceProbability{0.0f};
    float peak{0.0f};
};

/**
 * Конфигурация детектора голосовой активности (VAD)
 */
struct VADConfig {
    float sampleRate{16000.0f};
    float threshold{0.5f};             // Порог вероятности речи (0.0 .. 1.0)
    float minSpeechDurationMs{200.0f};  // Минимальная длительность фразы в мс
    float minSilenceDurationMs{300.0f}; // Минимальная пауза между фразами в мс
    float speechPadMs{100.0f};          // Буфер расширения границ (padding) в мс
};

/**
 * Сегмент обнаруженной речевой активности
 */
struct SpeechSegment {
    uint32_t id{0};
    size_t startSample{0};
    size_t endSample{0};
    float startSec{0.0f};
    float endSec{0.0f};
    float durationSec{0.0f};
    float confidence{0.0f};
};

/**
 * Строка сценария (субтитров)
 */
struct ScriptLine {
    int index{0};
    float startSec{0.0f};
    float endSec{0.0f};
    std::string text;
    std::string speaker;
};

/**
 * Сегмент распознанной речи (ASR)
 */
struct TranscriptionSegment {
    int id{0};
    float startSec{0.0f};
    float endSec{0.0f};
    std::string text;
    float confidence{1.0f};
};

/**
 * Результат смарт-выравнивания сценария и голоса
 */
struct AlignedPhrase {
    int lineIndex{0};
    std::string scriptText;
    std::string recognizedText;
    float expectedStartSec{0.0f};
    float expectedEndSec{0.0f};
    float actualStartSec{0.0f};
    float actualEndSec{0.0f};
    float timeDriftSec{0.0f};
    float similarityScore{0.0f}; // 0.0 .. 1.0
    std::string status;          // "matched" | "drifted" | "missing" | "unexpected"
};

// ============================================================================
// 1. FastLevenshtein - UTF-8 нормализация и расчет схожести строк
// ============================================================================

class FastLevenshtein {
public:
    /**
     * Преобразование UTF-8 строки в нормализованный вектор Unicode-кодовых точек:
     * - Приведение латиницы (A-Z -> a-z) и кириллицы (А-Я -> а-я, Ё -> ё) к нижнему регистру
     * - Фильтрация знаков препинания, пробелов и спецсимволов (аналог /[^\wа-яё]/gi)
     */
    static std::vector<uint32_t> normalizeUtf8(const std::string& str);

    /**
     * Вычисление расстояния Левенштейна между двумя UTF-8 строками.
     * Память оптимизирована до O(min(N, M)) с переиспользованием динамических векторов.
     */
    static size_t distance(const std::string& s1, const std::string& s2);

    /**
     * Вычисление коэффициента схожести (0.0 .. 1.0):
     * 1.0 - строки идентичны
     * 0.0 - полное несовпадение
     */
    static float similarity(const std::string& s1, const std::string& s2);

    /**
     * Расчет расстояния напрямую по предварительно декодированным Unicode-векторам
     */
    static size_t distanceCodepoints(const std::vector<uint32_t>& v1, const std::vector<uint32_t>& v2);
};

// ============================================================================
// 2. SpeechEnergyDetector - SIMD128 RMS, ZCR и Voice Activity Detection
// ============================================================================

class SpeechEnergyDetector {
public:
    /**
     * Расчет спектральной энергии, RMS, пика и Zero-Crossing Rate для фрейма.
     * При сборке с -msimd128 использует аппаратные инструкции WebAssembly SIMD128.
     */
    static FrameEnergyStats calculateFrameStats(const float* samples, size_t length) noexcept;

    /**
     * Оценка вероятности присутствия голоса во фрейме на основе RMS и ZCR
     */
    static float calculateVoiceProbability(const float* samples, size_t length) noexcept;

    /**
     * Полный цикл Voice Activity Detection по всему аудиомассиву.
     * Выполняет быструю разметку на сегменты речи и паузы.
     * @param audio Указатель на массив моно Float32 PCM сэмплов
     * @param totalSamples Количество сэмплов
     * @param sampleRate Частота дискретизации (например, 16000 или 48000)
     * @param config Параметры гистерезиса и порогов
     */
    static std::vector<SpeechSegment> detectSegments(
        const float* audio,
        size_t totalSamples,
        float sampleRate,
        const VADConfig& config = VADConfig{}
    );
};

// ============================================================================
// 3. SmartAligner - Смарт-выравнивание сценария с распознанной речью
// ============================================================================

class SmartAligner {
public:
    /**
     * Выравнивание реплик сценария с сегментами аудио и транскрипцией.
     * Вычисляет Time Drift, оценивает совпадение по Левенштейну и проставляет статусы.
     */
    static std::vector<AlignedPhrase> align(
        const std::vector<ScriptLine>& scriptLines,
        const std::vector<SpeechSegment>& speechSegments,
        const std::vector<TranscriptionSegment>& transcriptionSegments = {}
    );
};

} // namespace DAWCore
