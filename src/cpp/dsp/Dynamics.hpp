#pragma once

/**
 * ============================================================================
 * Dynamics.hpp - Динамическая обработка звука (RT-Safe, C++17)
 * ============================================================================
 * Включает:
 * 1. SoftKneeCompressor - Студийный компрессор с гладким перегибом (Soft Knee),
 *    логарифмическим детектором огибающей, контролем пиков и компенсацией усиления.
 * 2. NoiseGate - Студийный шумовой шлюз (Noise Gate) на конечном автомате (FSM)
 *    с 5 состояниями (Closed, Opening, Open, Holding, Closing) и гистерезисом.
 * 3. AutoDucker - Сайдчейн-дакер для автоматического приглушения фонограммы при речи.
 *    Поддерживает моно и стерео сайдчейн-входы.
 * 4. SoftLimiter - Мастер-лимитер с аналоговым насыщением tanh и защитой от перегрузки.
 * ============================================================================
 */

#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Состояния конечного автомата Noise Gate
 */
enum class GateState {
    Closed,  // Полностью закрыт (уровень подавления floorDb)
    Opening, // Фаза быстрой атаки (открытие шлюза)
    Open,    // Полностью открыт (прозрачный тракт 0 dB)
    Holding, // Фаза удержания (Hold) после падения сигнала ниже порога
    Closing  // Фаза плавного затухания (Release)
};

/**
 * Класс NoiseGate - Шумоподавитель на конечном автомате
 */
class NoiseGate {
public:
    float thresholdDb{-45.0f};  // Порог открывания гейта (-70 .. -20 dB)
    float attackMs{1.5f};       // Скорость открытия (0.1 .. 10 ms)
    float holdMs{50.0f};        // Время удержания открытого состояния (10 .. 300 ms)
    float releaseMs{80.0f};     // Время затухания (20 .. 500 ms)
    float floorDb{-70.0f};      // Уровень подавления в паузах (-96 .. -24 dB)
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentGain{1.0f};

    GateState state{GateState::Closed};
    size_t holdSamplesCounter{0};
    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float envelope{0.0f};

    NoiseGate() noexcept;

    void setup(float sr) noexcept;
    void reset() noexcept;
    void updateConstants() noexcept;
    inline void updateTimeConstants() noexcept { updateConstants(); }

    /**
     * Посемпльная обработка моно сигналов
     */
    float process(float sample) noexcept;

    /**
     * Пакетная обработка стереобуфера
     */
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

/**
 * Класс SoftKneeCompressor - Компрессор с квадратичным сглаживанием в зоне колена
 */
class SoftKneeCompressor {
public:
    float thresholdDb{-18.0f};    // Порог срабатывания (-50 .. 0 dB)
    float ratio{3.5f};            // Коэффициент сжатия (1.0 .. 20.0)
    float attackMs{10.0f};        // Время атаки (0.5 .. 100 ms)
    float releaseMs{100.0f};      // Время восстановления (10 .. 1000 ms)
    float makeupGainDb{2.0f};     // Компенсирующее усиление (0 .. 24 dB)
    float kneeDb{6.0f};           // Ширина мягкого колена (0 .. 24 dB)
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentGainReduction{1.0f}; // Текущий коэффициент сжатия (0.0 .. 1.0)
    float makeupGainLinear{1.0f};     // Линейный коэффициент компенсации усиления

    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float envelopeGain{1.0f};

    SoftKneeCompressor() noexcept;

    void setup(float sr) noexcept;
    void reset() noexcept;
    void updateTimeConstants() noexcept;

    /**
     * Поточечный расчет коэффициента сжатия для детектора пиков
     */
    inline float calculateGain(float inLevel) noexcept {
        if (!enabled) return 1.0f;
        float inDb = gainToDb(inLevel);
        float gainReductionDb = computeGainReductionDb(inDb);
        float targetGain = dbToGain(-gainReductionDb);
        envelopeGain = (targetGain < envelopeGain)
            ? attackCoeff * envelopeGain + (1.0f - attackCoeff) * targetGain
            : releaseCoeff * envelopeGain + (1.0f - releaseCoeff) * targetGain;
        currentGainReduction = envelopeGain;
        return envelopeGain;
    }

    /**
     * Посемпльная обработка моно сигналов
     */
    float process(float sample) noexcept;

    /**
     * Расчет передаточной характеристики с мягким коленом
     */
    float computeGainReductionDb(float inDb) const noexcept;

    /**
     * Пакетная обработка стереобуфера с интерполяцией огибающей
     */
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

/**
 * Класс AutoDucker - Сайдчейн-компрессор/дакер для автоматического приглушения
 */
class AutoDucker {
public:
    float thresholdDb{-30.0f};    // Порог чувствительности сайдчейна (-50 .. -10 dB)
    float duckDepthDb{-12.0f};    // Глубина приглушения (-30 .. 0 dB)
    float attackMs{15.0f};        // Время подавления при начале речи (5 .. 100 ms)
    float releaseMs{350.0f};      // Время плавного возврата музыки (100 .. 1500 ms)
    float sampleRate{48000.0f};
    bool enabled{false};
    uint32_t sourceTrackId{0};    // Идентификатор трека-источника сайдчейна
    float currentDuckingGain{1.0f};

    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float envelope{1.0f};

    AutoDucker() noexcept;

    void setup(float sr) noexcept;
    void reset() noexcept;
    void updateConstants() noexcept;

    /**
     * Обработка стереобуфера с использованием моно/стерео сайдчейн-сигнала
     */
    void processBufferWithSidechain(
        float* interleavedBuffer,
        const float* sidechainMono,
        size_t numFrames
    ) noexcept;

    void processBufferWithSidechainStereo(
        float* interleavedBuffer,
        const float* sidechainStereo,
        size_t numFrames
    ) noexcept;
};

/**
 * Класс SoftLimiter - Мастер-лимитер с мягким насыщением tanh (True Peak Guard)
 */
class SoftLimiter {
public:
    float ceilingDb{-0.1f}; // Потолок ограничения в дБFS (-3.0 .. 0.0)
    bool enabled{true};

    SoftLimiter() noexcept = default;

    /**
     * Пакетная обработка стереобуфера с предотвращением клиппинга
     */
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

} // namespace DAWCore
