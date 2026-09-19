#pragma once

/**
 * ============================================================================
 * AudioUtils.hpp - Вспомогательные DSP утилиты аудиоядра (C++17)
 * ============================================================================
 * 1. LoudnessAnalyzer:
 *    - Расчет True Peak и среднеквадратичного значения (RMS) с векторизацией SIMD128.
 *    - Вычисление компенсационного усиления (Loudness Matching) под стандарты EBU R128.
 *    - Peak Guard защита от клиппинга (с ограничением до заданного пикового уровня).
 * 2. AudioResampler:
 *    - Высокоточный кубический ресэмплинг Catmull-Rom Hermite в эталонные 48 000 Гц.
 *    - Поддержка Mono и Interleaved Stereo каналов.
 * 3. NativeWavPacker:
 *    - Прямое формирование бинарного заголовка RIFF/WAVE и упаковка сэмплов
 *      (16-bit PCM, 24-bit PCM, 32-bit IEEE Float).
 * ============================================================================
 */

#include "AudioMath.hpp"
#include <cstdint>
#include <cstddef>
#include <cstring>

namespace DAWCore {

/**
 * Статистика громкости аудиосигнала
 */
struct LoudnessStats {
    float peakLinear{0.0f};          // Максимальный линейный пик [0.0 .. 1.0+]
    float peakDb{MIN_DB};            // Пиковый уровень в dBFS
    float rmsLinear{0.0f};           // Линейное RMS значение
    float rmsDb{MIN_DB};             // RMS уровень в dBFS
    float gainDeltaToTargetDb{0.0f}; // Необходимое изменение усиления для целевого уровня
    bool isClipping{false};          // Флаг превышения 0 dBFS
    size_t numSamples{0};            // Количество обработанных сэмплов
};

/**
 * Анализатор громкости с SIMD128 оптимизацией
 */
class LoudnessAnalyzer {
public:
    static LoudnessStats calculateLoudnessStats(
        const float* buffer,
        size_t numSamples,
        int channels = 2,
        float targetRmsDb = -18.0f,
        float maxPeakDb = -1.0f
    ) noexcept;
};

/**
 * Кубический ресэмплер Catmull-Rom
 */
class AudioResampler {
public:
    static inline float catmullRom(float p0, float p1, float p2, float p3, float t) noexcept {
        float c0 = p1;
        float c1 = 0.5f * (p2 - p0);
        float c2 = p0 - 2.5f * p1 + 2.0f * p2 - 0.5f * p3;
        float c3 = 0.5f * (p3 - p0) + 1.5f * (p1 - p2);
        return ((c3 * t + c2) * t + c1) * t + c0;
    }

    /**
     * Ресэмплинг Float32 массива в 48 000 Гц
     * @return Количество сгенерированных выходных кадров
     */
    static size_t resampleTo48k(
        const float* input,
        size_t inFrames,
        int inRate,
        float* output,
        size_t outCapacityFrames,
        int channels = 2
    ) noexcept;
};

/**
 * Нативный упаковщик WAV файлов
 */
class NativeWavPacker {
public:
    /**
     * Запись RIFF/WAVE заголовка и кодирование PCM/Float данных
     * @return Полный размер сгенерированного файла в байтах
     */
    static size_t packWav(
        const float* interleavedBuffer,
        size_t numFrames,
        int bitDepth,
        uint8_t* outWavBuffer,
        size_t maxOutputBytes,
        int sampleRate = 48000,
        int numChannels = 2
    ) noexcept;
};

} // namespace DAWCore
