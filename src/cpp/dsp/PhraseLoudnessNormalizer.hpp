#pragma once

/**
 * ============================================================================
 * PhraseLoudnessNormalizer.hpp - Выравниватель громкости по фразам (C++17, RT-Safe)
 * ============================================================================
 * Профессиональный вокальный левелер (Gain Rider / Automatic Vocal Leveler).
 * Автоматически отслеживает огибающую речи и плавно подстраивает усиление
 * в реальном времени под целевой уровень (Target LUFS / RMS), исключая ручную
 * поканальную автоматизацию громкости фейдеров.
 *
 * Особенности:
 * 1. Шумовой порог (Gate Threshold) для остановки усиления в паузах между фразами.
 * 2. Раздельные времена нарастания (Attack) и спада (Release) для естественного дыхания.
 * 3. Ограничение максимального подъема (Max Boost) и ослабления (Max Cut).
 * 4. Плавная баллистика огибающей с защитой от щелчков (Zero-Alloc, SIMD128).
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <cmath>
#include "AudioMath.hpp"

namespace DAWCore {

struct PhraseNormalizerParams {
    float targetRmsDb = -18.0f;     // Целевой среднеквадратичный уровень (-30.0 .. -6.0 дБ)
    float maxBoostDb = 8.0f;        // Максимальный подъем громкости тихих фраз (0.0 .. 18.0 дБ)
    float maxCutDb = -8.0f;         // Максимальное ослабление громких фраз (-18.0 .. 0.0 дБ)
    float gateThresholdDb = -42.0f; // Порог активности речи для заморозки гейна (-60.0 .. -20.0 дБ)
    float attackMs = 25.0f;         // Скорость реагирования на фразы (5.0 .. 150.0 мс)
    float releaseMs = 250.0f;       // Скорость спада усиления (50.0 .. 800.0 мс)
    float sensitivity = 1.0f;       // Чувствительность регулирования (0.2 .. 2.0)
    bool enabled = true;            // Активность модуля
};

class PhraseLoudnessNormalizer {
public:
    explicit PhraseLoudnessNormalizer(float sampleRate = 48000.0f) noexcept;
    ~PhraseLoudnessNormalizer() = default;

    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    void setParams(const PhraseNormalizerParams& params) noexcept;
    const PhraseNormalizerParams& getParams() const noexcept { return params_; }

    void reset() noexcept;

    float getCurrentGainDb() const noexcept { return currentGainDb_; }
    float getCurrentInputLevelDb() const noexcept { return currentInputLevelDb_; }

    /**
     * Потоковая In-Place обработка блока аудио
     */
    void processBlock(float* buffer, size_t numFrames, int channels) noexcept;

private:
    void updateTimeConstants() noexcept;

    PhraseNormalizerParams params_;
    float sampleRate_{48000.0f};

    float envFast_{0.0f};
    float envSlow_{0.0f};
    float fastAlpha_{0.05f};
    float slowAlpha_{0.005f};

    float currentGainLinear_{1.0f};
    float targetGainLinear_{1.0f};
    float currentGainDb_{0.0f};
    float currentInputLevelDb_{-60.0f};

    float gainAttackAlpha_{0.01f};
    float gainReleaseAlpha_{0.001f};
};

} // namespace DAWCore
