#pragma once

/**
 * ============================================================================
 * FFTSpectralFilter.hpp - Спектральная фильтрация на базе быстрого БПФ (C++17)
 * ============================================================================
 * Модуль прецизионной частотной обработки в частотной области (Frequency Domain).
 *
 * Архитектура:
 * 1. Оптимизированный алгоритм Cooley-Tukey Radix-2 БПФ/ОБПФ с предрасчетом
 *    таблиц битовой инверсии (Bit-Reversal) и поворотных множителей (Twiddle Factors).
 * 2. Аппаратная векторизация бабочек БПФ через WebAssembly SIMD128.
 * 3. Размер окна: 2048 / 4096 сэмплов с 50% перекрытием (Hop Size = N / 2).
 * 4. Оконная функция Square-Root Hann (WOLA - Weighted Overlap-Add) для
 *    математически точной идеальной реконструкции (Perfect COLA Reconstruction,
 *    без амплитудных пульсаций и фазовых искажений).
 * 5. Нулевой сдвиг фазы (Zero-Phase Filtering): фильтрация спектральных магнитуд
 *    с сохранением фазовой структуры исходного сигнала.
 * 6. Полная RT-Safety: нулевые аллокации (Zero Malloc) в расчетном цикле processBlock.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <vector>
#include <cmath>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Внутренний оптимизированный движок БПФ (Cooley-Tukey Radix-2)
 */
class SpectralFFTEngine {
public:
    explicit SpectralFFTEngine(size_t fftSize = 2048);
    ~SpectralFFTEngine() = default;

    void init(size_t fftSize);

    // Прямое преобразование Фурье (In-place Forward FFT)
    void forward(float* real, float* imag) const noexcept;

    // Обратное преобразование Фурье с масштабированием 1/N (In-place Inverse FFT)
    void inverse(float* real, float* imag) const noexcept;

    size_t getSize() const noexcept { return fftSize_; }
    size_t getHalfSize() const noexcept { return halfSize_; }
    const float* getWindow() const noexcept { return window_.data(); }

private:
    void precomputeTables();

    size_t fftSize_{2048};
    size_t halfSize_{1024};
    size_t levels_{11};

    std::vector<uint32_t> bitReverseTable_;
    std::vector<float> cosTable_;
    std::vector<float> sinTable_;
    std::vector<float> window_; // Корень из окна Ханна (Square-Root Hann)
};

/**
 * Класс FFTSpectralFilter - Студийный спектральный процессор
 */
class FFTSpectralFilter {
public:
    static constexpr size_t DEFAULT_FFT_SIZE = 2048;
    static constexpr size_t MAX_FFT_SIZE = 4096;

    explicit FFTSpectralFilter(size_t fftSize = DEFAULT_FFT_SIZE, float sampleRate = 48000.0f);
    ~FFTSpectralFilter() = default;

    /**
     * Инициализация размера БПФ и предвыделение всех рабочих буферов
     * @param fftSize Размер окна (2048 или 4096)
     * @param sampleRate Частота дискретизации (например, 48000.0f)
     */
    void init(size_t fftSize, float sampleRate);

    /**
     * Сброс всех кольцевых буферов и истории накопления
     */
    void reset() noexcept;

    /**
     * Задание частотной маски коэффициентов передачи (Gain Weights)
     * Принимает вектор коэффициентов усиления/подавления. Значения автоматически
     * интерполируются по всей сетке частотных бинов от 0 Гц до частоты Найквиста.
     *
     * @param gainWeights Значения линейных коэффициентов (1.0 = 0 дБ, 0.0 = глухое подавление)
     */
    void setFrequencyMask(const std::vector<float>& gainWeights);

    /**
     * Задание параметров конкретной частотной полосы подавления/усиления (Notch / Bell)
     *
     * @param centerHz Центральная частота (Гц)
     * @param bandwidthHz Ширина полосы (Гц)
     * @param gainLinear Линейный коэффициент передачи (например, 0.0f для полного вырезания)
     */
    void setBandGain(float centerHz, float bandwidthHz, float gainLinear);

    /**
     * Сброс частотной маски в единичное состояние (полная прозрачность, Flat 0 dB)
     */
    void resetFrequencyMask();

    /**
     * Потоковая In-Place обработка блока аудиосэмплов произвольной длины
     * (RT-Safe, Zero Malloc, поддержка SIMD128)
     *
     * @param buffer    Указатель на PCM Float32 буфер (Interleaved для стерео)
     * @param numFrames Число кадров в блоке
     * @param channels  Число каналов (1 = моно, 2 = стерео)
     */
    void processBlock(float* buffer, size_t numFrames, int channels) noexcept;

    /**
     * Раздельная обработка стереоканалов
     */
    void processBlock(
        const float* inL,
        const float* inR,
        float* outL,
        float* outR,
        size_t numFrames
    ) noexcept;

    size_t getFftSize() const noexcept { return fftSize_; }
    size_t getHopSize() const noexcept { return hopSize_; }
    size_t getLatencyFrames() const noexcept { return fftSize_; }
    float getSampleRate() const noexcept { return sampleRate_; }

private:
    /**
     * Выполнение одного спектрального шага STFT/iSTFT для одного канала
     */
    void processSpectralFrame(
        const float* inputFrame,
        float* outputFrame,
        float* realBuffer,
        float* imagBuffer
    ) noexcept;

    size_t fftSize_{2048};
    size_t hopSize_{1024};
    size_t halfSize_{1024};
    float sampleRate_{48000.0f};

    SpectralFFTEngine fftEngine_;

    // Вектор коэффициентов частотной маски для каждого спектрального бина (0 .. halfSize)
    std::vector<float> frequencyMask_;

    // Рабочие буферы одного кадра (Zero Malloc)
    std::vector<float> realBufferL_;
    std::vector<float> imagBufferL_;
    std::vector<float> realBufferR_;
    std::vector<float> imagBufferR_;

    // Кольцевые FIFO буферы ввода/вывода для непрерывной потоковой обработки
    std::vector<float> inFifoL_;
    std::vector<float> inFifoR_;
    std::vector<float> outFifoL_;
    std::vector<float> outFifoR_;

    size_t inFifoWritePos_{0};
    size_t inFifoReadPos_{0};
    size_t outFifoWritePos_{0};
    size_t outFifoReadPos_{0};
    size_t samplesInFifo_{0};
    size_t samplesOutFifo_{0};
    size_t fifoCapacity_{0};
};

} // namespace DAWCore
