#pragma once

/**
 * ============================================================================
 * PhraseLoudnessNormalizer.hpp
 * ============================================================================
 * Нативный C++17 DSP модуль покадрового анализа и интеллектуального
 * автоматического выравнивания громкости речевых фраз (от тишины до тишины)
 * на дорожках дубляжа и озвучивания.
 *
 * Архитектурные принципы:
 * 1. Стандарт: C++17.
 * 2. Аппаратное ускорение WebAssembly SIMD128 (v128_t, 4 float за такт).
 * 3. Отсутствие динамических выделений памяти (Zero Malloc) в расчетном цикле.
 * 4. Gain Ride со сглаживанием S-curve на границах фраз без усиления пауз/шума.
 * 5. True Peak Guard защита от клиппирования на пиках.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <vector>
#include "../dsp/AudioMath.hpp"

namespace DAWCore {

/**
 * Конфигурация нормализации речевых фраз
 */
struct PhraseNormalizerConfig {
    float targetLufs = -18.0f;            // Целевой уровень громкости речи (LUFS / dBFS)
    float maxGainDb = 12.0f;              // Максимальный допустимый буст (dB) для тихих фраз
    float minGainDb = -18.0f;             // Максимальное ослабление (dB) для слишком громких выкриков
    float minSilenceDurationMs = 350.0f;  // Минимальная длительность паузы (мс) для детекции границы фраз
    float thresholdDb = -40.0f;           // Порог тишины (dBFS) для отделения речи от паузы
    float fadeTimeMs = 30.0f;             // Время плавного перехода гейна (мс) на краях фразы (Crossfade)
    float prePaddingMs = 35.0f;           // Запас времени до начала фразы (мс) для сохранения взрывных согласных
    float postPaddingMs = 50.0f;          // Запас времени после фразы (мс) для естественного затухания окончания
    float maxPeakDb = -0.5f;              // Пиковый потолок (dBFS True Peak guard) для исключения клиппинга
};

/**
 * Данные об отдельной обнаруженной и нормализованной речевой фразе
 */
struct PhraseInfo {
    size_t startFrame = 0;      // Начальный кадр фразы
    size_t endFrame = 0;        // Конечный кадр фразы
    float durationSec = 0.0f;   // Длительность фразы в секундах
    float measuredLufs = 0.0f;  // Исходная измеренная громкость фразы (dBFS / LUFS)
    float targetLufs = 0.0f;    // Целевая громкость
    float appliedGainDb = 0.0f; // Примененный коэффициент усиления / ослабления (dB)
    float peakBeforeDb = 0.0f;  // Пиковый уровень до обработки (dBFS)
    float peakAfterDb = 0.0f;   // Пиковый уровень после обработки (dBFS)
};

/**
 * Итоговый результат нормализации всей дорожки
 */
struct PhraseNormalizerResult {
    size_t totalPhrases = 0;          // Общее количество нормализованных фраз
    float averageInputLufs = -120.0f; // Средняя громкость речи до нормализации
    float averageOutputLufs = -120.0f;// Средняя громкость речи после нормализации
    float maxBoostDb = 0.0f;          // Максимальный примененный буст среди всех фраз
    float maxAttenuationDb = 0.0f;    // Максимальное примененное ослабление
    std::vector<PhraseInfo> phrases;  // Подробная статистика по каждой фразе
};

/**
 * Класс OfflinePhraseNormalizer
 * Выполняет двухпроходный пакетный анализ и выравнивание фраз на дорожке
 */
class OfflinePhraseNormalizer {
public:
    /**
     * Основной метод обработки аудиодорожки с изменением сэмплов in-place
     *
     * @param buffer Указатель на непрерывный Float32 буфер аудио (Interleaved для стерео)
     * @param totalFrames Количество аудиокадров (сэмплов на канал)
     * @param channels Количество каналов (1 = моно, 2 = стерео)
     * @param sampleRate Частота дискретизации (например, 48000.0f)
     * @param config Настройки порога, целевого LUFS и лимитов гейна
     * @return true в случае успешного выполнения
     */
    static bool processTrackPhrases(
        float* buffer,
        size_t totalFrames,
        int channels,
        float sampleRate,
        const PhraseNormalizerConfig& config
    ) noexcept;

    /**
     * Расширенный метод обработки с возвратом детальной статистики по каждой фразе
     */
    static PhraseNormalizerResult processTrackPhrasesWithStats(
        float* buffer,
        size_t totalFrames,
        int channels,
        float sampleRate,
        const PhraseNormalizerConfig& config
    );

    /**
     * C-Style Embind метод для вызова из WebAssembly JavaScript окружения
     */
    static PhraseNormalizerResult processTrackPhrasesNative(
        uintptr_t bufferPtr,
        size_t totalFrames,
        int channels,
        float sampleRate,
        const PhraseNormalizerConfig& config
    );

private:
    /**
     * Высокоскоростной расчет суммы квадратов и пикового значения с SIMD128
     */
    static void calculateEnergySIMD(
        const float* samples,
        size_t numSamples,
        float& outSumSquares,
        float& outPeak
    ) noexcept;

    /**
     * Применение сглаженного гейна (Gain Ride) к участку сэмплов с SIMD128
     */
    static void applyGainSIMD(
        float* samples,
        size_t numSamples,
        float gainLinear
    ) noexcept;

    /**
     * Плавный кроссфейд (S-Curve) на входе и выходе фразы
     */
    static void applyFadeRamp(
        float* buffer,
        size_t startFrame,
        size_t numFrames,
        int channels,
        float startGain,
        float endGain
    ) noexcept;
};

} // namespace DAWCore
