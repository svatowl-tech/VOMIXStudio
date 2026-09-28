#pragma once

/**
 * ============================================================================
 * VocalThickener.hpp - Профессиональный модуль уплотнения и теплоты речи (C++17)
 * ============================================================================
 * Формирует плотное, теплое и кинематографическое звучание диктора/вокалиста:
 * 1. Генератор четных субгармоник (120–250 Гц) через полиномы Чебышёва для тела голоса.
 * 2. Высокочастотный эксайтер (3–6 кГц) для шелковой четкости согласных.
 * 3. Нелинейная ленточная сатурация с компенсацией громкости (Auto-Gain Match).
 * 4. Полный Zero-Allocation в реалтайме и оптимизация WASM SIMD128.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <cmath>
#include <algorithm>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры модуля Vocal Thickener & Tape Sat
 */
struct VocalThickenerParams {
    float bodyDrive = 0.5f;         // Уровень фундаментального тела и субгармоник (0.0 .. 1.0)
    float presenceClarity = 0.4f;   // Уровень высокочастотного эксайтера 3-6 кГц (0.0 .. 1.0)
    float tapeDensity = 0.45f;      // Плотность ленточной аналоговой сатурации (0.0 .. 1.0)
    float mix = 1.0f;               // Баланс Dry / Wet (0.0 .. 1.0)
    bool bypass = false;            // Режим Bypass
};

/**
 * Biquad-фильтр 2-го порядка для фильтрации полос гармоник
 */
struct ThickenerBiquad {
    float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f;
    float a1 = 0.0f, a2 = 0.0f;
    float z1L = 0.0f, z2L = 0.0f;
    float z1R = 0.0f, z2R = 0.0f;

    inline void reset() noexcept {
        z1L = z2L = z1R = z2R = 0.0f;
    }

    inline float processLeft(float in) noexcept {
        float out = b0 * in + z1L;
        z1L = b1 * in - a1 * out + z2L;
        z2L = b2 * in - a2 * out;
        return out;
    }

    inline float processRight(float in) noexcept {
        float out = b0 * in + z1R;
        z1R = b1 * in - a1 * out + z2R;
        z2R = b2 * in - a2 * out;
        return out;
    }
};

/**
 * Класс VocalThickener - Нативное C++17 DSP ядро уплотнения речи
 */
class VocalThickener {
public:
    explicit VocalThickener(float sampleRate = 48000.0f) noexcept;
    ~VocalThickener() = default;

    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    void setParams(const VocalThickenerParams& params) noexcept;
    const VocalThickenerParams& getParams() const noexcept { return params_; }

    void setBodyDrive(float drive) noexcept;
    void setPresenceClarity(float clarity) noexcept;
    void setTapeDensity(float density) noexcept;
    void setMix(float mix) noexcept;
    void setBypass(bool bypass) noexcept;

    void reset() noexcept;

    /**
     * Потоковая поканальная обработка Float32 interleaved стереобуфера [L, R, L, R...]
     */
    void processBlock(float* buffer, size_t numFrames, int channels = 2) noexcept;

    /**
     * Обработка раздельных стереоканалов (float** in, float** out)
     */
    void processBlockSplit(const float* const* inputs, float* const* outputs, size_t numFrames) noexcept;

private:
    void updateFilters() noexcept;

    // Внутренний метод генерации гармоник для одного сэмпла (Чебышёв T2 / T3)
    inline float processBodyHarmonicsLeft(float inSample) noexcept;
    inline float processBodyHarmonicsRight(float inSample) noexcept;

    inline float processPresenceExciterLeft(float inSample) noexcept;
    inline float processPresenceExciterRight(float inSample) noexcept;

    inline float processTapeSat(float inSample, float drive) noexcept;

    VocalThickenerParams params_;
    float sampleRate_{48000.0f};

    // Фильтры для выделения полосы тела (Bandpass 120-280 Гц)
    ThickenerBiquad bodyHpFilter_{};
    ThickenerBiquad bodyLpFilter_{};

    // Фильтр для выделения полосы присутствия (Highpass 3.8 кГц)
    ThickenerBiquad presenceHpFilter_{};

    // DC-блокер после нелинейных генераторов четных гармоник
    ThickenerBiquad dcBlockFilter_{};

    // Auto-Gain Match сглаживатели
    float rmsIn_{0.01f};
    float rmsOut_{0.01f};
    float autoGain_{1.0f};

    // Сглаживание параметров для предотвращения щелчков
    float smoothedBypass_{1.0f};
    float smoothedMix_{1.0f};
    float smoothedBody_{0.5f};
    float smoothedPresence_{0.4f};
    float smoothedTape_{0.45f};
};

} // namespace DAWCore
