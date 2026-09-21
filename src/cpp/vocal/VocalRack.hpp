#pragma once

/**
 * ============================================================================
 * VocalRack.hpp - Вокальный процессорный рэк студийного качества (C++17)
 * ============================================================================
 * Включает специализированные DSP алгоритмы реставрации и обработки голоса:
 * 1. DeClicker:
 *    - Детектор щелчков и цифрового треска по 2-й производной (d^2 x / dt^2).
 *    - Локальная дисперсионная нормализация порога.
 *    - Реконструкция поврежденного участка кубическим сплайном Hermite.
 *    - Полное отсутствие динамических аллокаций памяти (статическая кольцевая история).
 * 2. DePlosive:
 *    - Динамический подавитель взрывных согласных (п, б, задувания микрофона < 80 Гц).
 *    - Двухкаскадный сайдчейн-детектор суббасовой энергии (< 90 Гц).
 *    - Адаптивный ФВЧ 2-го порядка Баттерворта с динамическим плавным подмешиванием.
 * 3. DeEsser:
 *    - Селективный подавитель сибилянтов (свистящих и шипящих согласных в полосе 4.5 .. 9 кГц).
 *    - Полосовой фильтр (BPF, Q = 2.0) в сайдчейне детектора.
 *    - VCA-редукция усиления (до 18 дБ) с малым временем восстановления.
 * 4. Полный тракт VocalRack:
 *    DeClicker -> DePlosive -> NoiseGate -> 3-Band EQ -> DeEsser -> Compressor -> AutoDucker
 * ============================================================================
 */

#include "../dsp/AudioMath.hpp"
#include "../dsp/BiquadFilter.hpp"
#include "../dsp/Dynamics.hpp"
#include <array>

namespace DAWCore {

/**
 * Класс DeClicker - Устранение импульсных щелчков и артефактов
 */
class DeClicker {
public:
    float threshold{0.08f};     // Порог чувствительности производной (0.01 .. 0.5)
    size_t repairWindow{4};     // Окно интерполяции
    bool enabled{true};
    uint32_t clicksDetected{0}; // Счетчик обнаруженных щелчков

    // Статическая история сэмплов для непрерывности между блоками (Zero-Alloc)
    static constexpr size_t HIST_SIZE = 8;
    std::array<float, HIST_SIZE> histL{};
    std::array<float, HIST_SIZE> histR{};

    DeClicker() noexcept;

    void reset() noexcept;

    /**
     * Кубическая сплайновая интерполяция Эрмита (Hermite Cubic Spline)
     */
    static inline float hermiteInterpolate(float p0, float m0, float p1, float m1, float t) noexcept {
        float t2 = t * t;
        float t3 = t2 * t;
        float h00 = 2.0f * t3 - 3.0f * t2 + 1.0f;
        float h10 = t3 - 2.0f * t2 + t;
        float h01 = -2.0f * t3 + 3.0f * t2;
        float h11 = t3 - t2;
        return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }

    /**
     * Потоковая обработка стереобуфера
     */
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

/**
 * Класс DePlosive - Динамический подавитель задуваний микрофона и взрывных звуков
 */
class DePlosive {
public:
    float thresholdDb{-24.0f};  // Порог срабатывания (-40 .. -6 dB)
    float frequency{80.0f};     // Частота среза HPF (40 .. 150 Hz)
    float attackMs{2.0f};       // Быстрая атака (0.5 .. 10 ms)
    float releaseMs{50.0f};     // Спад (20 .. 200 ms)
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentReduction{0.0f}; // Текущий уровень подавления (0.0 .. 1.0)

    // Коэффициенты Biquad HPF 2-го порядка (Butterworth)
    float b0{1.0f}, b1{0.0f}, b2{0.0f}, a1{0.0f}, a2{0.0f};
    float hpfX1L{0.0f}, hpfX2L{0.0f}, hpfY1L{0.0f}, hpfY2L{0.0f};
    float hpfX1R{0.0f}, hpfX2R{0.0f}, hpfY1R{0.0f}, hpfY2R{0.0f};

    // Детектор суббасовой энергии (Biquad Low-Pass 90 Hz в цепи детектора)
    float lpB0{0.0f}, lpB1{0.0f}, lpB2{0.0f}, lpA1{0.0f}, lpA2{0.0f};
    float lpX1L{0.0f}, lpX2L{0.0f}, lpY1L{0.0f}, lpY2L{0.0f};
    float lpX1R{0.0f}, lpX2R{0.0f}, lpY1R{0.0f}, lpY2R{0.0f};

    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float subEnvelope{0.0f};

    DePlosive() noexcept;

    void setup(float sr) noexcept;
    void reset() noexcept;
    void updateCoefficients() noexcept;

    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

/**
 * Класс DeEsser - Полосовой подавитель сибилянтов
 */
class DeEsser {
public:
    float thresholdDb{-22.0f};  // Порог срабатывания (-40 .. -10 dB)
    float frequency{6000.0f};   // Центральная частота сибилянтов (4500 .. 9000 Hz)
    float ratio{4.0f};          // Степень сжатия сибилянтов
    float attackMs{1.0f};       // Сверхбыстрая атака (0.5 .. 5 ms)
    float releaseMs{40.0f};     // Быстрый спад (15 .. 100 ms)
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentGainReductionDb{0.0f};

    // BPF Сайдчейн-фильтр полосы сибилянтов (Band-Pass, Q=2.0)
    float b0{0.0f}, b1{0.0f}, b2{0.0f}, a1{0.0f}, a2{0.0f};
    float bpX1L{0.0f}, bpX2L{0.0f}, bpY1L{0.0f}, bpY2L{0.0f};
    float bpX1R{0.0f}, bpX2R{0.0f}, bpY1R{0.0f}, bpY2R{0.0f};

    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float essEnvelope{0.0f};

    DeEsser() noexcept;

    void setup(float sr) noexcept;
    void reset() noexcept;
    void updateCoefficients() noexcept;

    /**
     * Посемпльная обработка моно сигналов
     */
    float process(float sample) noexcept;

    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

/**
 * Класс VocalRack - Полный законченный тракт вокальной студийной обработки
 * Тракт: DeClicker -> DePlosive -> NoiseGate -> 3-Band EQ -> DeEsser -> Compressor -> AutoDucker
 */
class VocalRack {
public:
    DeClicker deClicker;
    DePlosive dePlosive;
    NoiseGate noiseGate;
    ParametricEQ3Band eq;
    DeEsser deEsser;
    SoftKneeCompressor compressor;
    AutoDucker autoDucker;

    VocalRack() noexcept = default;

    void setup(float sampleRate) noexcept;
    void reset() noexcept;

    /**
     * Выполнение полного каскада обработки стереобуфера
     * @param interleavedBuffer Указатель на стерео сэмплы [L, R, L, R...]
     * @param sidechainMono Указатель на сайдчейн-сигнал (для AutoDucker), может быть nullptr
     * @param numFrames Количество стереокадров
     */
    void process(
        float* interleavedBuffer,
        const float* sidechainMono,
        size_t numFrames
    ) noexcept;
};

} // namespace DAWCore
