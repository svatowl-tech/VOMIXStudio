#pragma once

/**
 * ============================================================================
 * TapeSaturation.hpp - Моделирование аналоговой пленочной сатурации (C++17, RT-Safe)
 * ============================================================================
 * Студийный эмулятор магнитного магнитофона (Studer A800 / Ampex ATR-102):
 * - Нелинейная кривая намагничивания оксида железа (B-H Hysteresis Curve)
 * - Асимметричное подмагничивание (Tape Bias) для генерации 2-й и 3-й гармоник
 * - Контурный резонанс воспроизводящей головки (Low-Frequency Head Bump)
 * - Высокочастотные потери на зазор магнитной головки (Gap Loss Filter)
 * - Мягкое компрессирование и аналоговое округление пиков (Soft Knee Peak Taming)
 * - Полная RT-Safety: нулевые аллокации (Zero Malloc) и аппаратный WASM SIMD128.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <cmath>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры пленочной сатурации
 */
struct TapeParams {
    float driveDb = 6.0f;           // Уровень перегрузки входа (0.0 .. +24.0 дБ)
    float bias = 0.15f;             // Асимметрия подмагничивания (-0.5 .. +0.5)
    float saturationMix = 1.0f;     // Баланс Dry / Wet (0.0 .. 1.0)
    float lowFreqColor = 0.5f;      // Эмуляция низкочастотного резонанса головки Head Bump (0.0 .. 1.0)
    float highFreqRolloff = 0.35f;  // Потери на зазор головки Gap Loss (0.0 .. 1.0)
    float outputGainDb = 0.0f;      // Выходная компенсация громкости (-18.0 .. +18.0 дБ)
    bool autoGain = true;           // Автоматическая компенсация громкости драйва
    bool enabled = true;            // Активность модуля
};

/**
 * Биквадратный фильтр 2-го порядка для Head Bump
 */
struct TapeBiquadCoeffs {
    float b0 = 1.0f;
    float b1 = 0.0f;
    float b2 = 0.0f;
    float a1 = 0.0f;
    float a2 = 0.0f;
};

struct TapeBiquadState {
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
 * Класс TapeSaturation - Эмулятор аналоговой ленты
 */
class TapeSaturation {
public:
    explicit TapeSaturation(float sampleRate = 48000.0f) noexcept;
    ~TapeSaturation() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    /**
     * Установка параметров эмуляции
     */
    void setParams(const TapeParams& params) noexcept;
    const TapeParams& getParams() const noexcept { return params_; }

    /**
     * Сброс внутренних фильтров и истории
     */
    void reset() noexcept;

    /**
     * Потоковая In-Place обработка блока (RT-Safe, SIMD128, Zero Malloc)
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
     * Обновление коэффициентов эквализации (Head Bump и Gap Loss)
     */
    void updateFilters() noexcept;

    /**
     * Функция нелинейной намагниченности ленты с асимметрией (Odd + Even Harmonics)
     */
    static inline float saturateTape(float x, float bias) noexcept {
        // Добавление смещения bias для генерации мягких четных гармоник (лампово-пленочная теплота)
        const float v = x + bias;
        // Pade аппроксимация / быстрая tanh сатурация кривой насыщения сердечника:
        // tanh(v) = v * (27 + v^2) / (27 + 9*v^2)
        const float v2 = v * v;
        const float tanhV = (std::fabs(v) < 3.0f) 
            ? (v * (27.0f + v2) / (27.0f + 9.0f * v2))
            : (v > 0.0f ? 1.0f : -1.0f);

        // Компенсация постоянного смещения DC
        const float bias2 = bias * bias;
        const float biasDC = (std::fabs(bias) < 3.0f)
            ? (bias * (27.0f + bias2) / (27.0f + 9.0f * bias2))
            : (bias > 0.0f ? 1.0f : -1.0f);

        return tanhV - biasDC;
    }

    TapeParams params_;
    float sampleRate_{48000.0f};

    float inputDriveLinear_{1.0f};
    float outputGainLinear_{1.0f};
    float autoMakeupLinear_{1.0f};

    // Фильтр контурного басового резонанса (Head Bump ~ 60-80 Гц)
    TapeBiquadCoeffs headBumpCoeffs_{};
    TapeBiquadState headBumpState_{};

    // 1-полюсный сглаживающий фильтр потерь на зазор головки (Gap Loss HF Rolloff)
    float gapLossCoeff_{0.0f};
    float gapLossStateL_{0.0f};
    float gapLossStateR_{0.0f};

    // DC-blocking фильтр для устранения дрейфа нуля
    float dcBlockerX_L_{0.0f};
    float dcBlockerY_L_{0.0f};
    float dcBlockerX_R_{0.0f};
    float dcBlockerY_R_{0.0f};
    float dcBlockCoeff_{0.9992f};
};

} // namespace DAWCore
