#pragma once

/**
 * ============================================================================
 * SilenceStripper.hpp - Модуль детекции пауз и стриппинга тишины в C++ / WASM
 * ============================================================================
 * Высокопроизводительный C++ модуль для мгновенного анализа энергии сэмплов,
 * детекции пауз и стриппинга участков тишины с сохранением голосовых сегментов.
 * 
 * Архитектурные требования:
 * - Выполняется в WebAssembly с аппаратной векторизацией SIMD128.
 * - Без динамических аллокаций памяти в циклах анализа.
 * - Потоковая обработка PCM Float32 буферов.
 * ============================================================================
 */

#include <cstdint>
#include <cstddef>
#include <vector>
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
 * Конфигурация детекции тишины
 */
struct SilenceStripperConfig {
    float sampleRate = 48000.0f;
    float thresholdDb = -40.0f;       // Порог тишины в dB (например, -40 dB)
    float minSilenceMs = 300.0f;      // Минимальная длительность тишины для разреза (мс)
    float paddingMs = 50.0f;          // Удержание краев речи до и после сегмента (мс)
    float frameSizeMs = 10.0f;        // Размер блока анализа энергии (10-20 мс)
    bool isStereo = false;            // Флаг interleaved стерео (true) или моно (false)
};

/**
 * Статистика блока энергии
 */
struct EnergyFrame {
    float rms;
    float peak;
};

/**
 * Класс SilenceStripper - C++ DSP алгоритм стриппинга тишины
 */
class SilenceStripper {
public:
    /**
     * Вычисление энергии одного кадра с SIMD128 векторизацией
     * @param samples Указатель на PCM Float32 данные
     * @param numSamples Количество сэмплов в кадре
     * @return EnergyFrame { rms, peak }
     */
    static EnergyFrame calculateFrameEnergySIMD(const float* samples, size_t numSamples) noexcept;

    /**
     * Анализ PCM буфера и расчет границ звуковых сегментов (без участков тишины)
     * @param inPcm Входной буфер PCM Float32
     * @param totalSamples Общее количество сэмплов в буфере
     * @param config Параметры детекции тишины
     * @param outSegments Предварительно выделенный буфер для сегментов
     * @param maxSegments Максимальная вместимость outSegments
     * @return Фактическое количество найденных сегментов
     */
    static size_t detectSegments(
        const float* inPcm,
        size_t totalSamples,
        const SilenceStripperConfig& config,
        AudioSegment* outSegments,
        size_t maxSegments
    ) noexcept;

    /**
     * C-Style Embind метод для вызова из JavaScript / WebAssembly
     * @param inPcmPtr Указатель на Float32Array буфер клипа в куче WASM
     * @param totalSamples Длина буфера в сэмплах
     * @param thresholdDb Порог тишины (например, -40.0f)
     * @param minSilenceMs Минимальная тишина (например, 300.0f мс)
     * @param paddingMs Запас краев речи (например, 50.0f мс)
     * @param outSegmentsPtr Указатель на буфер AudioSegment структур
     * @param maxSegments Максимальное количество сегментов
     * @param isStereo Флаг стерео (true/false)
     * @param sampleRate Частота дискретизации (по умолчанию 48000.0f)
     * @return Количество найденных сегментов
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
     * Вспомогательный метод для прямого выделения буфера AudioSegment в WASM памяти
     */
    static uintptr_t allocateSegmentBuffer(size_t maxSegments) noexcept;

    /**
     * Освобождение выделенного буфера AudioSegment
     */
    static void freeSegmentBuffer(uintptr_t ptr) noexcept;
};

} // namespace DAWCore
