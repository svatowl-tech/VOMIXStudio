#pragma once

/**
 * ============================================================================
 * WaveformAnalyzer.hpp - Высокопроизводительный нативный анализатор формы волны
 * ============================================================================
 * Разработан для вычисления Min/Max пиков (Decimation Peaks) и RMS профиля аудио
 * непосредственно в памяти WebAssembly кучи (HEAPF32).
 *
 * Особенности:
 * 1. ZERO DYNAMIC ALLOCATIONS: Все вычисления производятся в переданных буферах
 *    без единого вызова malloc/new во время отрисовки и децимации.
 * 2. WASM SIMD128 ACCELERATION: Векторизованный поиск экстремумов через SIMD128
 *    (обработка 4x float32 сэмплов параллельно за один такт процессора).
 * 3. MULTI-CHANNEL SUPPORT: Поддержка моно (stride = 1) и стерео interleaved (stride = 2).
 * 4. DETERMINISTIC INTERPOLATION: Субпиксельная интерполяция границ сэмплов без накопления погрешности.
 * ============================================================================
 */

#include <cstdint>
#include <cstddef>
#include <algorithm>
#include <cmath>

#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

namespace DAWCore {

/**
 * @brief Результат глобального анализа экстремумов и громкости аудиосигнала
 */
struct WaveformStats {
    float globalMin{0.0f};
    float globalMax{0.0f};
    float maxAbsolutePeak{0.0f};
    float rmsLevel{0.0f};
    size_t processedFrames{0};
};

/**
 * @brief Дескриптор выходных массивов пиков для визуализации
 */
struct WaveformPeaksView {
    const float* minPeaks{nullptr};
    const float* maxPeaks{nullptr};
    int numPixels{0};
    bool isStereo{false};
};

/**
 * @brief Высокопроизводительный процессор децимации и построения формы волны
 */
class WaveformAnalyzer {
public:
    /**
     * @brief Быстрое извлечение Min/Max пиков аудиоданных для отрисовки Waveform (O(pixels))
     *
     * @param buffer Указатель на сырой PCM Float32 массив (WASM Heap)
     * @param bufferLength Общая длина буфера в сэмплах (floats)
     * @param targetPixels Желаемое количество точек/пикселей по горизонтали
     * @param startFrame Начальный фрейм интервала сэмплирования
     * @param lengthFrames Длина анализируемого интервала во фреймах
     * @param isStereo Флаг стерео interleaved буфера (L, R, L, R...)
     * @param outMinPtr Выходной массив минимальных значений (емкость >= targetPixels)
     * @param outMaxPtr Выходной массив максимальных значений (емкость >= targetPixels)
     * @return int Реальное количество сгенерированных пикселей (0 в случае ошибки)
     */
    static int extractPeaksNative(
        const float* buffer,
        size_t bufferLength,
        int targetPixels,
        size_t startFrame,
        size_t lengthFrames,
        bool isStereo,
        float* outMinPtr,
        float* outMaxPtr
    ) noexcept;

    /**
     * @brief Извлечение RMS (Root Mean Square) профиля энергии сигнала
     *
     * @param buffer Указатель на сырой PCM Float32 массив
     * @param bufferLength Общая длина буфера в сэмплах
     * @param targetPixels Количество точек вывода
     * @param startFrame Начальный фрейм
     * @param lengthFrames Длина во фреймах
     * @param isStereo Флаг стерео interleaved
     * @param outRmsPtr Выходной массив среднеквадратичных значений
     * @return int Количество сгенерированных точек
     */
    static int extractRMSPeaksNative(
        const float* buffer,
        size_t bufferLength,
        int targetPixels,
        size_t startFrame,
        size_t lengthFrames,
        bool isStereo,
        float* outRmsPtr
    ) noexcept;

    /**
     * @brief Вычисление глобальных статистик аудиосигнала (Max Peak, RMS, Min, Max)
     *
     * @param buffer Входной PCM буфер
     * @param totalFrames Количество фреймов
     * @param isStereo Флаг стерео
     * @return WaveformStats Структура с глобальными метриками
     */
    static WaveformStats calculateGlobalStats(
        const float* buffer,
        size_t totalFrames,
        bool isStereo
    ) noexcept;

private:
    /**
     * @brief Внутренняя скалярная обработка блока для моно сигналов
     */
    static void processMonoBlockScalar(
        const float* src,
        size_t count,
        float& outMin,
        float& outMax
    ) noexcept;

    /**
     * @brief Внутренняя векторизованная SIMD128 обработка блока для моно сигналов
     */
    static void processMonoBlockSIMD(
        const float* src,
        size_t count,
        float& outMin,
        float& outMax
    ) noexcept;

    /**
     * @brief Внутренняя скалярная обработка блока для стерео interleaved сигналов
     */
    static void processStereoBlockScalar(
        const float* src,
        size_t frameCount,
        float& outMin,
        float& outMax
    ) noexcept;

    /**
     * @brief Внутренняя векторизованная SIMD128 обработка блока для стерео interleaved сигналов
     */
    static void processStereoBlockSIMD(
        const float* src,
        size_t frameCount,
        float& outMin,
        float& outMax
    ) noexcept;
};

} // namespace DAWCore
