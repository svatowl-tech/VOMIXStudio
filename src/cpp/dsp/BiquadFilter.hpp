#pragma once

/**
 * ============================================================================
 * BiquadFilter.hpp - Каскады БИХ-фильтров 2-го порядка (Audio EQ Cookbook)
 * ============================================================================
 * Поддерживаемые типы:
 * - LowShelf: низкочастотная полка
 * - Peaking: параметрический колокол
 * - HighShelf: высокочастотная полка
 * - HighPass: фильтр верхних частот 2-го порядка (12 dB/oct)
 * - LowPass: фильтр нижних частот 2-го порядка (12 dB/oct)
 * - BandPass: полосовой фильтр с постоянным пиковым усилением
 *
 * Архитектура:
 * - Прямая форма II транспонированная (Direct Form II Transposed) для минимизации
 *   числового шума округления в 32-bit float.
 * - Пакетная SIMD-векторизация стереосэмплов под WASM SIMD128.
 * - Нулевые динамические аллокации в методах process.
 * ============================================================================
 */

#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Типы биквадратных фильтров
 */
enum class BiquadFilterType {
    LowShelf,
    Peaking,
    HighShelf,
    HighPass,
    LowPass,
    BandPass
};

/**
 * Класс BiquadFilter - параметрический фильтр 2-го порядка для стереоканала
 */
class BiquadFilter {
public:
    BiquadFilterType type{BiquadFilterType::Peaking};
    float frequency{1000.0f}; // Частота в Гц
    float gainDb{0.0f};       // Усиление в дБ (для Peaking и Shelving)
    float Q{0.7071f};         // Добротность фильтра
    float sampleRate{48000.0f};
    bool enabled{true};

    // Нормализованные коэффициенты фильтра (деленные на a0)
    float b0{1.0f};
    float b1{0.0f};
    float b2{0.0f};
    float a1{0.0f};
    float a2{0.0f};

    // Линии задержки (регистры состояния) для левого и правого каналов
    float x1L{0.0f}, x2L{0.0f}, y1L{0.0f}, y2L{0.0f};
    float x1R{0.0f}, x2R{0.0f}, y1R{0.0f}, y2R{0.0f};

    BiquadFilter() noexcept;

    /**
     * Сброс регистров задержки (очистка хвостов фильтрации)
     */
    void resetState() noexcept;

    /**
     * Пересчет коэффициентов биквадратного фильтра по формулам Audio EQ Cookbook
     */
    void updateCoefficients() noexcept;

    inline void setHighPass(float sr, float freq, float q = 0.7071f) noexcept {
        type = BiquadFilterType::HighPass;
        sampleRate = sr;
        frequency = freq;
        Q = q;
        gainDb = 0.0f;
        updateCoefficients();
    }

    inline void setLowPass(float sr, float freq, float q = 0.7071f) noexcept {
        type = BiquadFilterType::LowPass;
        sampleRate = sr;
        frequency = freq;
        Q = q;
        gainDb = 0.0f;
        updateCoefficients();
    }

    inline void setLowShelf(float sr, float freq, float gain, float q = 0.7071f) noexcept {
        type = BiquadFilterType::LowShelf;
        sampleRate = sr;
        frequency = freq;
        gainDb = gain;
        Q = q;
        updateCoefficients();
    }

    inline void setHighShelf(float sr, float freq, float gain, float q = 0.7071f) noexcept {
        type = BiquadFilterType::HighShelf;
        sampleRate = sr;
        frequency = freq;
        gainDb = gain;
        Q = q;
        updateCoefficients();
    }

    inline void setPeaking(float sr, float freq, float gain, float q = 1.0f) noexcept {
        type = BiquadFilterType::Peaking;
        sampleRate = sr;
        frequency = freq;
        gainDb = gain;
        Q = q;
        updateCoefficients();
    }

    /**
     * Поточечная обработка одного моно-сэмпла (использует регистры L-канала)
     */
    inline float process(float in) noexcept {
        if (!enabled) return in;
        float out = b0 * in + b1 * x1L + b2 * x2L - a1 * y1L - a2 * y2L;
        x2L = x1L; x1L = in;
        y2L = y1L; y1L = out;
        return out;
    }

    /**
     * Поточечная обработка одного стереосэмпла
     */
    inline void processSample(float inL, float inR, float& outL, float& outR) noexcept {
        if (!enabled) {
            outL = inL;
            outR = inR;
            return;
        }

        // Direct Form I / II реализация
        outL = b0 * inL + b1 * x1L + b2 * x2L - a1 * y1L - a2 * y2L;
        x2L = x1L; x1L = inL; y2L = y1L; y1L = outL;

        outR = b0 * inR + b1 * x1R + b2 * x2R - a1 * y1R - a2 * y2R;
        x2R = x1R; x1R = inR; y2R = y1R; y1R = outR;
    }

    /**
     * Пакетная обработка чередующегося стереобуфера [L, R, L, R...] с SIMD-оптимизацией
     */
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

/**
 * Класс ParametricEQ3Band - 3-полосный студийный эквалайзер
 * (LowShelf + Peaking Bell + HighShelf)
 */
class ParametricEQ3Band {
public:
    BiquadFilter lowShelf;
    BiquadFilter peaking;
    BiquadFilter highShelf;
    bool enabled{true};

    ParametricEQ3Band() noexcept;

    /**
     * Обновление частоты дискретизации для всех 3 полос
     */
    void updateAll(float sr) noexcept;

    /**
     * Сброс внутренних линий задержки фильтров
     */
    void reset() noexcept;

    /**
     * Последовательная обработка стереобуфера через 3 каскада эквалайзера
     */
    void processBuffer(float* interleavedBuffer, size_t numFrames) noexcept;
};

} // namespace DAWCore
