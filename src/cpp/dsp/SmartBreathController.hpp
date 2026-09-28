#pragma once

/**
 * ============================================================================
 * SmartBreathController.hpp - Интеллектуальный контроллер дыхания (C++17, RT-Safe)
 * ============================================================================
 * Студийный процессор для автоматического распознавания и естественного
 * ослабления звуков вдоха и дыхания диктора/вокалиста без грубого гейтирования
 * и вырезания естественной динамики речи.
 *
 * Архитектура:
 * 1. Многофакторный акустический классификатор BreathDetector:
 *    - Спектральный баланс: отношение энергии шума вдоха (1.5 .. 4.5 кГц)
 *      к энергии основного голосового тона (< 400 Гц).
 *    - Плотность пересечения нуля (Zero Crossing Rate, ZCR) для детекции невокализованного шума.
 *    - Ограничение динамического коридора (вдохи не бывают громче речи и тише фонового шума).
 * 2. Lookahead кольцевой буфер с упреждением (5 .. 20 мс):
 *    - Заблаговременный вход в аттенюацию до появления резкого фронта вдоха.
 * 3. Плавная S-образная интерполяция усиления (Smooth S-Curve Envelope):
 *    - Отсутствие щелчков, артефактов и фазовых скачков.
 * 4. Аппаратная векторизация WebAssembly SIMD128 и строгий Zero-Alloc в processBlock.
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
 * Параметры интеллектуального контроллера дыхания
 */
struct BreathControllerParams {
    float targetReductionDb = -12.0f; // Величина ослабления вдоха (-36.0 .. 0.0 дБ)
    float sensitivity = 0.70f;        // Чувствительность распознавания (0.0 .. 1.0)
    float lookaheadMs = 8.0f;         // Время упреждения в буфере (2.0 .. 25.0 мс)
    float attackMs = 15.0f;           // Время плавного входа в аттенюацию (5.0 .. 50.0 мс)
    float releaseMs = 35.0f;          // Время возврата к прозрачности (10.0 .. 120.0 мс)
    float minLevelDb = -50.0f;        // Нижний порог детекции (дБ)
    float maxLevelDb = -15.0f;        // Верхний порог детекции (дБ, выше - уже громкая речь)
    bool enabled = true;              // Активность контроллера
};

/**
 * Регистры состояния 2-полюсного фильтра TDF-II
 */
struct BreathBiquadState {
    float s1L = 0.0f;
    float s2L = 0.0f;
    float s1R = 0.0f;
    float s2R = 0.0f;

    inline void reset() noexcept {
        s1L = 0.0f; s2L = 0.0f;
        s1R = 0.0f; s2R = 0.0f;
    }
};

/**
 * Коэффициенты нормализованного биквадратного фильтра
 */
struct BreathBiquadCoeffs {
    float b0 = 1.0f;
    float b1 = 0.0f;
    float b2 = 0.0f;
    float a1 = 0.0f;
    float a2 = 0.0f;
};

/**
 * Класс SmartBreathController - Контроллер дыхания и вдохов
 */
class SmartBreathController {
public:
    static constexpr size_t MAX_LOOKAHEAD_SAMPLES = 2048; // До ~42 мс при 48 кГц

    explicit SmartBreathController(float sampleRate = 48000.0f) noexcept;
    ~SmartBreathController() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    /**
     * Установка параметров обработки
     */
    void setParams(const BreathControllerParams& params) noexcept;
    const BreathControllerParams& getParams() const noexcept { return params_; }

    /**
     * Задержка модуля в сэмплах (Lookahead)
     */
    size_t getLatencySamples() const noexcept { return lookaheadSamples_; }

    /**
     * Сброс истории и детекторов
     */
    void reset() noexcept;

    /**
     * Метрики для интерфейса: детектирован ли вдох в данный момент и текущее подавление
     */
    bool isBreathActive() const noexcept { return breathDetected_; }
    float getCurrentAttenuationDb() const noexcept { return currentGainDb_; }

    /**
     * Потоковая In-Place обработка блока аудиосэмплов (RT-Safe, SIMD128, Zero Malloc)
     *
     * @param samples    Указатель на PCM Float32 буфер (Interleaved для стерео)
     * @param numFrames  Число кадров (сэмплов на канал)
     * @param channels   Число каналов (1 = моно, 2 = стерео)
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
     * Пересчет коэффициентов детекторных фильтров
     */
    void updateDetectorFilters() noexcept;

    /**
     * Оценка спектрального соотношения и ZCR для текущего сэмпла
     */
    void updateAnalysis(float monoSample) noexcept;

    BreathControllerParams params_;
    float sampleRate_{48000.0f};

    size_t lookaheadSamples_{384}; // ~8 мс при 48 кГц

    // Фильтр выделения основного тона речи (ФНЧ 400 Гц)
    BreathBiquadCoeffs voiceLpCoeffs_{};
    BreathBiquadState voiceLpState_{};

    // Фильтр выделения шума вдоха (Полосовой ПФ 1.8 - 4.2 кГц)
    BreathBiquadCoeffs breathBpCoeffs_{};
    BreathBiquadState breathBpState_{};

    // Огибающие энергии
    float voiceEnergy_{0.0f};
    float breathEnergy_{0.0f};
    float totalRmsEnergy_{0.0f};
    float envCoeff_{0.992f};

    // Детектор пересечений нуля (ZCR)
    float lastMonoSample_{0.0f};
    float zcrSmooth_{0.0f};
    float zcrCoeff_{0.995f};

    // Состояние детектора вдоха
    bool breathDetected_{false};
    uint32_t breathHoldCounter_{0};
    uint32_t breathOnsetCounter_{0};

    // S-curve интерполяция коэффициента усиления
    float currentGainLinear_{1.0f};
    float targetGainLinear_{1.0f};
    float currentGainDb_{0.0f};

    float attackAlpha_{0.005f};
    float releaseAlpha_{0.001f};

    // Кольцевой буфер упреждения (Lookahead Ring Buffer)
    std::vector<float> lookaheadBufL_;
    std::vector<float> lookaheadBufR_;
    size_t lookaheadWritePos_{0};
};

} // namespace DAWCore
