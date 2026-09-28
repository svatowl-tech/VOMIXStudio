#pragma once

/**
 * ============================================================================
 * ResonanceSuppressor.hpp - Автоматический подавитель резонансов (C++17, RT-Safe)
 * ============================================================================
 * Студийный интеллектуальный спектральный процессор (аналог Soothe / DSEQ)
 * для динамического устранения узкополосных резонансов, свистящих сибилянтов,
 * корпусных призвуков микрофона и комнатных стоячих волн в речевых дорожках.
 *
 * Архитектура:
 * 1. Скользящий спектральный БПФ-анализатор со сглаживанием огибающей фона.
 * 2. Детектор спектральной выраженности (Prominence Detector): определение
 *    узкополосных пиков, значительно превышающих окружающий частотный рельеф.
 * 3. Пул адаптивных динамических режекторных фильтров (до 8 Notch Biquad).
 * 4. Частотный трекинг и плавная баллистика Attack/Release для каждого фильтра.
 * 5. Топология Direct Form II Transposed с интерполяцией коэффициентов.
 * 6. Аппаратное ускорение WebAssembly SIMD128 и полная RT-Safety (Zero Malloc).
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <vector>
#include <array>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры автоматического подавителя резонансов
 */
struct ResonanceSuppressorParams {
    float sensitivity = 0.65f;        // Чувствительность обнаружения пиков (0.0 .. 1.0)
    float maxAttenuationDb = -12.0f;  // Максимальная глубина режекции (-24.0 .. -3.0 дБ)
    size_t maxNotches = 8;            // Максимум активных фильтров (1 .. 8)
    float minFreq = 150.0f;           // Нижняя граница поиска резонансов (Гц)
    float maxFreq = 14000.0f;         // Верхняя граница поиска резонансов (Гц)
    float sharpness = 8.0f;           // Добротность фильтра Q (2.0 .. 25.0)
    float attackMs = 6.0f;            // Скорость подавления резонанса (0.5 .. 50.0 мс)
    float releaseMs = 60.0f;          // Скорость восстановления прозрачности (10.0 .. 300.0 мс)
    bool enabled = true;              // Активность процессора
};

/**
 * Состояние одного адаптивного режекторного фильтра
 */
struct TrackedNotch {
    float frequency = 1000.0f;
    float targetFreq = 1000.0f;
    float currentGainDb = 0.0f;
    float targetGainDb = 0.0f;
    float Q = 8.0f;
    bool active = false;
    uint32_t holdCounter = 0;
};

/**
 * Биквадратные нормализованные коэффициенты
 */
struct NotchBiquadCoeffs {
    float b0 = 1.0f;
    float b1 = 0.0f;
    float b2 = 0.0f;
    float a1 = 0.0f;
    float a2 = 0.0f;
};

/**
 * Регистры состояния фильтра TDF-II
 */
struct NotchBiquadState {
    float s1L = 0.0f;
    float s2L = 0.0f;
    float s1R = 0.0f;
    float s2R = 0.0f;

    inline void reset() noexcept {
        s1L = 0.0f;
        s2L = 0.0f;
        s1R = 0.0f;
        s2R = 0.0f;
    }
};

/**
 * Класс ResonanceSuppressor - Автоматический подавитель резонансов
 */
class ResonanceSuppressor {
public:
    static constexpr size_t MAX_NOTCHES = 8;
    static constexpr size_t FFT_SIZE = 1024;
    static constexpr size_t HOP_SIZE = 256;
    static constexpr size_t HALF_SIZE = FFT_SIZE / 2;

    explicit ResonanceSuppressor(float sampleRate = 48000.0f) noexcept;
    ~ResonanceSuppressor() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    /**
     * Установка параметров работы
     */
    void setParams(const ResonanceSuppressorParams& params) noexcept;
    const ResonanceSuppressorParams& getParams() const noexcept { return params_; }

    /**
     * Сброс всех фильтров и спектральной истории
     */
    void reset() noexcept;

    /**
     * Получение информации об активных фильтрах (для визуализации спектральных меток в UI)
     */
    size_t getActiveNotchCount() const noexcept;
    float getNotchFrequency(size_t index) const noexcept;
    float getNotchAttenuationDb(size_t index) const noexcept;

    /**
     * Потоковая In-Place обработка блока (RT-Safe, SIMD128, Zero Malloc)
     *
     * @param buffer     Указатель на PCM Float32 буфер (Interleaved для стерео)
     * @param numFrames  Количество кадров (сэмплов на канал)
     * @param channels   Количество каналов (1 = моно, 2 = стерео)
     */
    void processBlock(float* buffer, size_t numFrames, int channels) noexcept;

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
     * Инициализация таблиц БПФ и оконных функций
     */
    void initTables() noexcept;

    /**
     * Быстрое прямое БПФ
     */
    void forwardFFT(float* real, float* imag) const noexcept;

    /**
     * Анализ спектра и обновление адаптивных режекторных фильтров
     */
    void analyzeSpectrumAndTrackResonances() noexcept;

    /**
     * Расчет коэффициентов режекторного (Bell/Notch) фильтра TDF-II
     */
    static NotchBiquadCoeffs calculateNotchCoeffs(float freq, float Q, float gainDb, float sampleRate) noexcept;

    ResonanceSuppressorParams params_;
    float sampleRate_{48000.0f};

    // Баллистика фильтров
    float attackCoeff_{0.0f};
    float releaseCoeff_{0.0f};

    // Адаптивные режекторные фильтры
    std::array<TrackedNotch, MAX_NOTCHES> notches_{};
    std::array<NotchBiquadCoeffs, MAX_NOTCHES> currentCoeffs_{};
    std::array<NotchBiquadCoeffs, MAX_NOTCHES> targetCoeffs_{};
    std::array<NotchBiquadState, MAX_NOTCHES> states_{};

    // БПФ спектральный анализатор
    std::vector<float> analysisRingBuf_;
    size_t ringWritePos_{0};
    size_t hopSampleCount_{0};

    std::vector<float> fftReal_;
    std::vector<float> fftImag_;
    std::vector<float> fftWindow_;
    std::vector<uint32_t> bitReverse_;
    std::vector<float> cosTable_;
    std::vector<float> sinTable_;

    // Векторы спектральной амплитуды и сглаженной огибающей фона
    std::vector<float> magnitudes_;
    std::vector<float> smoothedEnvelope_;
};

} // namespace DAWCore
