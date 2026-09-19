#pragma once

/**
 * ============================================================================
 * SilenceStripper.hpp - Модуль детекции пауз и нарезки фраз в C++ / WebAssembly
 * ============================================================================
 * Высокопроизводительный C++ модуль для мгновенного анализа энергии сэмплов,
 * детекции пауз и вырезания тишины из голосовых дорожек и начиток.
 * 
 * Архитектурные принципы:
 * 1. Браузер — только GUI. Вся математика выполняется на нативном C++.
 * 2. Аппаратное ускорение WebAssembly SIMD128 (v128_t, 4 float за такт).
 * 3. Нулевые динамические аллокации (Zero Malloc) внутри циклов сканирования.
 * 4. Защитные буферы paddingMs (40-60 мс) для исключения срезания согласных звуков.
 * ============================================================================
 */

#include <cstdint>
#include <cstddef>
#include "../dsp/AudioMath.hpp"

namespace DAWCore {

/**
 * Структура найденного звукового сегмента речи / аудио
 */
struct AudioSegment {
    size_t offsetSamples;    // Смещение начала сегмента относительно исходного буфера (в сэмплах)
    size_t lengthSamples;    // Длина сегмента (в сэмплах)
    float peakLevel;         // Пиковый уровень сегмента (линейный, 0.0 .. 1.0+)
    float rmsLevel;          // RMS уровень сегмента (линейный)
};

/**
 * Конфигурация детекции тишины и пауз
 */
struct SilenceStripperConfig {
    float sampleRate = 48000.0f;
    float thresholdDb = -40.0f;       // Порог тишины в dBFS (например, -40 dBFS)
    float minSilenceMs = 300.0f;      // Минимальная длительность тишины для разреза (мс)
    float paddingMs = 50.0f;          // Защитный запас краев речи до и после сегмента (мс)
    float frameSizeMs = 10.0f;        // Размер блока анализа энергии (10 мс)
    bool isStereo = false;            // Флаг interleaved стерео (true) или моно (false)
};

/**
 * Статистика блока энергии кадра (10 мс)
 */
struct EnergyFrame {
    float rms;
    float peak;
};

/**
 * Класс SilenceStripper - C++ SIMD128 DSP алгоритм мгновенного стриппинга тишины
 */
class SilenceStripper {
public:
    /**
     * Высокоскоростной расчет RMS энергии и пика кадра с SIMD128 векторизацией
     * @param samples Указатель на PCM Float32 данные
     * @param numSamples Количество сэмплов в кадре
     * @return EnergyFrame { rms, peak }
     */
    static EnergyFrame calculateFrameEnergySIMD(const float* samples, size_t numSamples) noexcept;

    /**
     * Основной нативный метод удаления тишины и нарезки длинной начитки на отдельные фразы
     * @param inBuffer Входной непрерывный PCM Float32 буфер
     * @param totalSamples Общее количество сэмплов в буфере
     * @param thresholdDb Порог тишины в dBFS (например, -40.0f)
     * @param minSilenceMs Минимальная длительность паузы в мс для разделения фраз (например, 300.0f)
     * @param paddingMs Защитные буферы по краям в мс для сохранения согласных звуков (например, 50.0f)
     * @param isStereo Флаг стерео (true/false)
     * @param sampleRate Частота дискретизации (например, 48000)
     * @param outSegments Предварительно выделенный массив структур AudioSegment
     * @param maxSegments Максимальная вместимость массива outSegments
     * @return Фактическое количество найденных голосовых сегментов
     */
    static int stripSilence(
        const float* inBuffer,
        size_t totalSamples,
        float thresholdDb,
        float minSilenceMs,
        float paddingMs,
        bool isStereo,
        int sampleRate,
        AudioSegment* outSegments,
        int maxSegments
    ) noexcept;

    /**
     * Потоковый анализ с передачей структуры конфигурации
     */
    static size_t detectSegments(
        const float* inPcm,
        size_t totalSamples,
        const SilenceStripperConfig& config,
        AudioSegment* outSegments,
        size_t maxSegments
    ) noexcept;

    /**
     * C-Style Embind метод для вызова из JavaScript / WebAssembly по указателям кучи
     */
    static int stripSilenceFromClip(
        uintptr_t inPcmPtr,
        size_t totalSamples,
        float thresholdDb,
        float minSilenceMs,
        float paddingMs,
        uintptr_t outSegmentsPtr,
        int maxSegments,
        bool isStereo = false,
        float sampleRate = 48000.0f
    ) noexcept;

    /**
     * Выделение выровненного буфера AudioSegment в WASM памяти
     */
    static uintptr_t allocateSegmentBuffer(size_t maxSegments) noexcept;

    /**
     * Освобождение выделенного буфера AudioSegment
     */
    static void freeSegmentBuffer(uintptr_t ptr) noexcept;
};

} // namespace DAWCore
