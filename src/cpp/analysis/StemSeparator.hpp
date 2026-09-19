#pragma once

/**
 * ============================================================================
 * StemSeparator.hpp - Высокопроизводительное спектральное разделение вокала (C++17 / WASM SIMD128)
 * ============================================================================
 * Модуль автономного выделения вокала (Center-Channel Vocal Extraction)
 * и синтеза инструментала (Backing Track / Karaoke) без использования JS-эмуляций.
 *
 * Архитектура:
 * 1. FastFourierTransform: Cooley-Tukey Radix-2 БПФ с предрасчетом битреверса и тригонометрии.
 * 2. Векторизация комплексной арифметики и поэлементных операций через wasm_simd128.
 * 3. Mid/Side спектральная декомпозиция и формантная маскировка частот речи (300 Гц - 4 кГц).
 * 4. iSTFT синтез с Overlap-Add (OLA) нормализацией весов окон.
 * 5. Фазовое вычитание инструментальной дорожки в памяти C++.
 * 6. Полное отсутствие динамических аллокаций памяти внутри аудиокадров.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <vector>
#include <cmath>
#include <memory>

#if defined(__wasm_simd128__) || defined(__wasm__)
#include <wasm_simd128.h>
#endif

namespace DAWCore {

/**
 * ============================================================================
 * Класс FastFourierTransform (Cooley-Tukey Radix-2 FFT/iFFT)
 * ============================================================================
 */
class FastFourierTransform {
public:
    explicit FastFourierTransform(size_t fftSize = 2048);
    ~FastFourierTransform() = default;

    // Прямое преобразование Фурье (In-place Forward FFT)
    void forward(float* real, float* imag) const;

    // Обратное преобразование Фурье (In-place Inverse FFT)
    void inverse(float* real, float* imag) const;

    // Получение предрассчитанного окна Ханна
    const float* getHanningWindow() const { return m_hanningWindow.data(); }
    size_t getSize() const { return m_fftSize; }
    size_t getHalfSize() const { return m_halfSize; }

private:
    void initTables();

    size_t m_fftSize;
    size_t m_halfSize;
    size_t m_levels;

    std::vector<uint32_t> m_bitReverse;
    std::vector<float> m_cosTable;
    std::vector<float> m_sinTable;
    std::vector<float> m_hanningWindow;
};

/**
 * ============================================================================
 * Класс StemSeparator - Выделение вокала и караоке на C++
 * ============================================================================
 */
class StemSeparator {
public:
    explicit StemSeparator(size_t fftSize = 2048, size_t hopSize = 1024);
    ~StemSeparator() = default;

    /**
     * Разделение стерео аудиопотока на вокал и инструментал
     * 
     * @param inLeft       Входной левый канал (Float32Array)
     * @param inRight      Входной правый канал (Float32Array)
     * @param totalSamples Количество сэмплов в канале
     * @param outVocalsL   Выходной левый канал вокала
     * @param outVocalsR   Выходной правый канал вокала
     * @param outKaraokeL  Выходной левый канал караоке/инструментала
     * @param outKaraokeR  Выходной правый канал караоке/инструментала
     * @param sampleRate   Частота дискретизации (по умолчанию 44100 Гц)
     */
    void separateVocalsAndKaraoke(
        const float* inLeft,
        const float* inRight,
        size_t totalSamples,
        float* outVocalsL,
        float* outVocalsR,
        float* outKaraokeL,
        float* outKaraokeR,
        int sampleRate = 44100
    );

private:
    size_t m_fftSize;
    size_t m_hopSize;
    FastFourierTransform m_fft;

    // Предвыделенные scratch-буферы (Zero Allocations in audio loops)
    std::vector<float> m_realL;
    std::vector<float> m_imagL;
    std::vector<float> m_realR;
    std::vector<float> m_imagR;
    std::vector<float> m_normWeights;
};

} // namespace DAWCore
