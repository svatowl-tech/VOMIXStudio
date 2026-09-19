#pragma once

/**
 * ============================================================================
 * MediaCore.hpp - Высокопроизводительное медиа-ядро студии (C++17 / WASM SIMD128)
 * ============================================================================
 * Модуль сквозной конвертации каналов, полифазного/кубического ресэмплинга,
 * нормализации громкости (EBU R128 / Integrated RMS / True Peak) и
 * бинарного формирования RIFF WAV (24-bit PCM / 32-bit Float) прямо в памяти WebAssembly.
 *
 * Архитектура:
 * 1. AudioChannelLayout: SIMD128 Interleave/De-interleave, Hard-Clip Protection.
 * 2. AdvancedResampler: Высокоточный Catmull-Rom Cubic Spline & Polyphase Resampler
 *    для конвертации 44.1/88.2/96 кГц -> 48 кГц без искажения фазы.
 * 3. NativeWavBuilder: Прямая бинарная сборка заголовков RIFF/WAVE (24-bit / 32-bit Float)
 *    для моментального сохранения в File System Access API и потоковой передачи.
 * 4. AutoGainStager: EBU R128 K-Weighting фильтрация, расчет Integrated LUFS,
 *    True Peak и автоматический Gain Staging.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <vector>
#include <cmath>
#include <algorithm>
#include <cstring>
#include <memory>

#if defined(__wasm_simd128__) || defined(__wasm__)
#include <wasm_simd128.h>
#endif

namespace DAWCore {

/**
 * ============================================================================
 * 1. AudioChannelLayout: Манипуляции с топологией каналов и защита от клиппинга
 * ============================================================================
 */
class AudioChannelLayout {
public:
    // Преобразование моно в чередующийся стереопоток: [M0, M0, M1, M1, ...]
    static void monoToInterleavedStereo(const float* monoIn, size_t numFrames, float* stereoOut);

    // Разделение стереопотока на раздельные каналы (De-interleave)
    static void deinterleaveStereo(const float* stereoIn, size_t numFrames, float* leftOut, float* rightOut);

    // Объединение раздельных L и R каналов в чередующийся стереопоток (Interleave)
    static void interleaveStereo(const float* leftIn, const float* rightIn, size_t numFrames, float* stereoOut);

    // Ограничение диапазона и защита от жесткого перегруза (-1.0f .. +1.0f)
    static void clampRange(float* buffer, size_t numSamples, float minVal = -1.0f, float maxVal = 1.0f);

    // Расчет абсолютного пикового значения (Peak)
    static float findPeak(const float* buffer, size_t numSamples);
};

/**
 * ============================================================================
 * 2. AdvancedResampler: Оптимизированный Catmull-Rom кубический ресэмплинг
 * ============================================================================
 */
class AdvancedResampler {
public:
    // Ресэмплинг одноканального (моно) аудиосигнала
    static size_t resampleMono(
        const float* input,
        size_t inFrames,
        int inSampleRate,
        float* output,
        size_t maxOutFrames,
        int outSampleRate = 48000
    );

    // Ресэмплинг чередующегося стереосигнала
    static size_t resampleInterleavedStereo(
        const float* inputStereo,
        size_t inFrames,
        int inSampleRate,
        float* outputStereo,
        size_t maxOutFrames,
        int outSampleRate = 48000
    );

    // Расчет количества выходных сэмплов при конвертации частоты
    static size_t calculateOutputFrames(size_t inFrames, int inSampleRate, int outSampleRate = 48000);
};

/**
 * ============================================================================
 * 3. NativeWavBuilder: Бинарный генератор RIFF WAV буферов в памяти WASM
 * ============================================================================
 */
class NativeWavBuilder {
public:
    enum class FormatType {
        PCM_16BIT,
        PCM_24BIT,
        FLOAT_32BIT
    };

    /**
     * Построение RIFF/WAV файла в предвыделенный буфер памяти
     * 
     * @param leftChannel   Указатель на сэмплы левого канала (-1.0f .. +1.0f)
     * @param rightChannel  Указатель на правый канал (nullptr для моно)
     * @param numFrames     Количество кадров (сэмплов на канал)
     * @param sampleRate    Частота дискретизации (например, 48000)
     * @param format        Формат (PCM 24-bit или IEEE Float 32-bit)
     * @param outBuffer     Выходной бинарный буфер (uint8_t)
     * @param maxBufferSize Максимальный размер выходного буфера в байтах
     * @return              Фактический размер сформированного WAV файла в байтах
     */
    static size_t buildWav(
        const float* leftChannel,
        const float* rightChannel,
        size_t numFrames,
        int sampleRate,
        FormatType format,
        uint8_t* outBuffer,
        size_t maxBufferSize
    );

    // Расчет точного размера итогового WAV файла в байтах
    static size_t calculateWavByteSize(size_t numFrames, int numChannels, FormatType format);
};

/**
 * ============================================================================
 * 4. AutoGainStager: EBU R128 / True Peak и нормализация громкости дорожек
 * ============================================================================
 */
class AutoGainStager {
public:
    struct AudioLoudnessStats {
        float truePeakLinear;
        float truePeakDb;
        float integratedRmsLinear;
        float integratedRmsDb;
        float suggestedGainDb; // Коэффициент подгонки к целевому уровню (Target LUFS)
    };

    /**
     * Расчет характеристик громкости (Peak, RMS, Target Gain) для стерео сигнала
     * 
     * @param leftChannel    Левый канал
     * @param rightChannel   Правый канал (или nullptr)
     * @param numFrames      Количество кадров
     * @param targetRmsDb    Целевой уровень громкости (по умолчанию -14.0 dB LUFS)
     * @param ceilingPeakDb  Максимальный потолок пиков (по умолчанию -1.0 dB True Peak)
     */
    static AudioLoudnessStats analyzeLoudness(
        const float* leftChannel,
        const float* rightChannel,
        size_t numFrames,
        float targetRmsDb = -14.0f,
        float ceilingPeakDb = -1.0f
    );

    /**
     * Пакетное применение коэффициента гейна (Gain Staging) на месте (In-Place)
     */
    static void applyGain(float* buffer, size_t numSamples, float gainDb);
};

} // namespace DAWCore
