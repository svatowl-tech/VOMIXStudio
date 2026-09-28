#pragma once

/**
 * ============================================================================
 * LinearPhaseFilter.hpp - Линейно-фазовые КИХ (FIR) фильтры ФВЧ/ФНЧ (C++17)
 * ============================================================================
 * Прецизионная линейно-фазовая фильтрация аудиосигнала без фазовых искажений
 * (Zero Phase Distortion, строго постоянная групповая задержка).
 *
 * Архитектура:
 * 1. Симметричная импульсная характеристика КИХ-фильтра (FIR Type I, нечетная длина M = Order + 1).
 *    Строго постоянная групповая задержка: tau_g = Order / 2 сэмплов для всех частот.
 * 2. Аналитический синтез Windowed-Sinc ядра с поддержкой окон:
 *    - Hann, Hamming, Blackman, Blackman-Harris, Rectangular.
 * 3. Быстрая сегментная свертка Overlap-Save (OLS) на базе алгоритма FFT:
 *    - Сложность O(N log N) вместо O(N^2) прямой временной свертки.
 *    - Отсутствие задержек и просадок FPS даже при длинных импульсах (до 2048 тапов).
 * 4. Входные/выходные FIFO буферы для потоковой обработки блоков произвольного размера.
 * 5. Аппаратная векторизация комплексного умножения спектров через WASM SIMD128.
 * 6. Полная RT-Safety: нулевые аллокации (Zero Malloc) в аудиопотоке processBlock.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <vector>
#include <array>
#include <cmath>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Тип весового окна КИХ-фильтра
 */
enum class FIRWindowType : uint32_t {
    Hann = 0,
    Hamming = 1,
    Blackman = 2,
    BlackmanHarris = 3,
    Rectangular = 4
};

/**
 * Параметры линейно-фазового фильтра
 */
struct LinearPhaseParams {
    float hpFreq = 20.0f;       // Частота среза ФВЧ (0.0 .. 20.0 Гц = отключен)
    float lpFreq = 20000.0f;    // Частота среза ФНЧ (>= 20000.0 Гц = отключен)
    int filterOrder = 512;      // Порядок фильтра (четное: 128, 256, 512, 1024)
    FIRWindowType windowType = FIRWindowType::Blackman;
    bool enabled = true;        // Активность фильтра
};

/**
 * Внутренний БПФ движок для быстрой свертки
 */
class FIRFastFourierTransform {
public:
    explicit FIRFastFourierTransform(size_t fftSize = 2048);
    ~FIRFastFourierTransform() = default;

    void init(size_t fftSize);
    void forward(float* real, float* imag) const noexcept;
    void inverse(float* real, float* imag) const noexcept;

    size_t getSize() const noexcept { return fftSize_; }

private:
    void precompute();

    size_t fftSize_{2048};
    size_t halfSize_{1024};
    size_t levels_{11};

    std::vector<uint32_t> bitReverse_;
    std::vector<float> cosTable_;
    std::vector<float> sinTable_;
};

/**
 * Класс LinearPhaseFilter - Линейно-фазовый КИХ-фильтр
 */
class LinearPhaseFilter {
public:
    static constexpr size_t MAX_ORDER = 1024;
    static constexpr size_t MAX_TAPS = MAX_ORDER + 1;
    static constexpr size_t FFT_SIZE = 2048; // Размер БПФ для быстрой свертки

    explicit LinearPhaseFilter(float sampleRate = 48000.0f) noexcept;
    ~LinearPhaseFilter() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    /**
     * Настройка параметров фильтра
     */
    void setParams(const LinearPhaseParams& params) noexcept;
    const LinearPhaseParams& getParams() const noexcept { return params_; }

    /**
     * Задержка фильтра (в сэмплах) = Order / 2
     */
    size_t getGroupDelaySamples() const noexcept;

    /**
     * Сброс истории свертки и очистка буферов
     */
    void reset() noexcept;

    /**
     * Потоковая In-Place обработка блока произвольной длины (RT-Safe, SIMD128, Zero Malloc)
     *
     * @param samples    Указатель на PCM Float32 буфер (Interleaved для стерео)
     * @param numFrames  Количество кадров (сэмплов на канал)
     * @param channels   Количество каналов (1 = моно, 2 = стерео)
     */
    void processBlock(float* samples, size_t numFrames, int channels) noexcept;

    /**
     * Out-of-Place обработка блока
     */
    void processBlock(
        const float* input,
        float* output,
        size_t numFrames,
        int channels
    ) noexcept;

private:
    /**
     * Синтез импульсной характеристики КИХ (Windowed-Sinc) и расчет частотного отклика в БПФ
     */
    void designFilter() noexcept;

    /**
     * Расчет оконного коэффициента
     */
    static float calculateWindow(FIRWindowType type, size_t n, size_t totalM) noexcept;

    /**
     * Выполнение одного шага быстрой свертки Overlap-Save для одного канала
     */
    void processOverlapSaveBlock(
        const float* newSamples,
        float* outputValid,
        float* history,
        float* realBuf,
        float* imagBuf
    ) noexcept;

    LinearPhaseParams params_;
    float sampleRate_{48000.0f};

    size_t numTaps_{513};       // M = Order + 1
    size_t stepSize_{0};        // L - M + 1 (размер блока новых данных Overlap-Save)

    FIRFastFourierTransform fftEngine_;

    // Спектр ядра фильтра H(w) = FFT(h)
    std::vector<float> kernelReal_;
    std::vector<float> kernelImag_;

    // Временная история предыдущих M - 1 сэмплов для Overlap-Save
    std::vector<float> historyL_;
    std::vector<float> historyR_;

    // Рабочие спектральные буферы кадра (Zero Malloc)
    std::vector<float> realBufL_;
    std::vector<float> imagBufL_;
    std::vector<float> realBufR_;
    std::vector<float> imagBufR_;

    // FIFO буферы ввода/вывода для непрерывной потоковой обработки блоков любой длины
    std::vector<float> inFifoL_;
    std::vector<float> inFifoR_;
    std::vector<float> outFifoL_;
    std::vector<float> outFifoR_;

    size_t fifoCapacity_{0};
    size_t inWritePos_{0};
    size_t inReadPos_{0};
    size_t outWritePos_{0};
    size_t outReadPos_{0};
    size_t samplesInFifo_{0};
    size_t samplesOutFifo_{0};
};

} // namespace DAWCore
