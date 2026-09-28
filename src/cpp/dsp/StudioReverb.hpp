#pragma once

/**
 * ============================================================================
 * StudioReverb.hpp - Алгоритмический ревербератор студийного качества (C++17)
 * ============================================================================
 * Студийный пространственный процессор для дорожек речи, дубляжа и вокала.
 *
 * Архитектура:
 * 1. Pre-delay линия задержки (до 250 мс) для разделения прямого звука и реверберации
 *    (сохраняет четкость дикции и артикуляцию).
 * 2. 8 параллельных гребенчатых фильтров с обратной связью (LBCF) на канал
 *    с взаимно простыми задержками (prime numbers) для исключения металлического флаттера.
 * 3. 4 последовательных фазовых (Allpass) фильтра на канал для создания высокой
 *    плотности диффузии хвоста (Diffusion).
 * 4. Стерео-декорреляция (Stereo Spread) для глубокой пространственной панорамы.
 * 5. Встроенный входной High-Pass фильтр (Low Cut) для устранения бубнения в басу.
 * 6. Полная RT-Safety (Zero Malloc в `processBlock`), защита от денормалов.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <vector>
#include <array>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Параметры ревербератора
 */
struct ReverbParams {
    float roomSize = 0.65f;       // Размер помещения / время реверберации RT60 (0.0 .. 1.0)
    float damping = 0.35f;        // Поглощение высоких частот стенами помещения (0.0 .. 1.0)
    float wetDryMix = 0.25f;      // Баланс сухого и обработанного сигнала (0.0 = Dry .. 1.0 = Wet)
    float preDelayMs = 25.0f;     // Задержка первых отражений (0.0 .. 250.0 мс) для чистоты речи
    float stereoWidth = 1.0f;     // Стереобаза реверберационного поля (0.0 = Моно .. 1.0 = Широкое стерео)
    float lowCutHz = 120.0f;      // Обрезной фильтр низких частот (20 .. 500 Гц)
    bool enabled = true;          // Активность эффекта
};

/**
 * Однополюсный гребенчатый фильтр с фильтрацией высоких частот в обратной связи (LBCF)
 */
class CombFilter {
public:
    CombFilter() noexcept = default;

    void init(size_t size) noexcept;
    void reset() noexcept;

    inline void setDamp(float damp) noexcept {
        damp1_ = damp;
        damp2_ = 1.0f - damp;
    }

    inline void setFeedback(float fb) noexcept {
        feedback_ = fb;
    }

    /**
     * Посемпльная обработка гребенчатого фильтра (RT-Safe)
     */
    inline float process(float input) noexcept {
        const float output = buffer_[bufferIndex_];

        // Фильтр затухания высоких частот в петле обратной связи
        filterStore_ = (output * damp2_) + (filterStore_ * damp1_);

        // Запись в кольцевой буфер с защитой от денормализованных чисел
        buffer_[bufferIndex_] = input + (filterStore_ * feedback_) + 1e-25f;

        if (++bufferIndex_ >= bufferSize_) {
            bufferIndex_ = 0;
        }

        return output;
    }

private:
    std::vector<float> buffer_;
    size_t bufferSize_{0};
    size_t bufferIndex_{0};
    float filterStore_{0.0f};
    float feedback_{0.8f};
    float damp1_{0.3f};
    float damp2_{0.7f};
};

/**
 * Фазовый рассеивающий фильтр (Allpass Filter)
 */
class AllpassFilter {
public:
    AllpassFilter() noexcept = default;

    void init(size_t size) noexcept;
    void reset() noexcept;

    inline void setFeedback(float fb) noexcept {
        feedback_ = fb;
    }

    /**
     * Посемпльная обработка Allpass (RT-Safe)
     */
    inline float process(float input) noexcept {
        const float bufOut = buffer_[bufferIndex_];
        const float output = -input + bufOut;

        buffer_[bufferIndex_] = input + (bufOut * feedback_) + 1e-25f;

        if (++bufferIndex_ >= bufferSize_) {
            bufferIndex_ = 0;
        }

        return output;
    }

private:
    std::vector<float> buffer_;
    size_t bufferSize_{0};
    size_t bufferIndex_{0};
    float feedback_{0.5f};
};

/**
 * Класс StudioReverb - Студийный алгоритмический ревербератор
 */
class StudioReverb {
public:
    static constexpr size_t NUM_COMBS = 8;
    static constexpr size_t NUM_ALLPASS = 4;
    static constexpr float MAX_PREDELAY_MS = 250.0f;

    StudioReverb() noexcept;
    explicit StudioReverb(float sampleRate) noexcept;
    ~StudioReverb() = default;

    /**
     * Настройка частоты дискретизации и предварительное выделение буферов
     */
    void setSampleRate(float sampleRate) noexcept;

    /**
     * Обновление параметров реверберации
     */
    void setParams(const ReverbParams& params) noexcept;
    const ReverbParams& getParams() const noexcept { return params_; }

    /**
     * Очистка линий задержки (сброс хвоста реверберации)
     */
    void reset() noexcept;

    /**
     * Раздельная стереообработка блоков (RT-Safe, Zero Malloc)
     *
     * @param inL       Входной левый канал
     * @param inR       Входной правый канал
     * @param outL      Выходной левый канал
     * @param outR      Выходной правый канал
     * @param numFrames Количество сэмплов на канал
     */
    void processBlock(
        const float* inL,
        const float* inR,
        float* outL,
        float* outR,
        size_t numFrames
    ) noexcept;

    /**
     * In-Place пакетная обработка чередующегося (Interleaved) буфера
     */
    void processBlock(float* interleavedInOut, size_t numFrames, int channels) noexcept;

private:
    /**
     * Пересчет внутренних коэффициентов и задержек
     */
    void updateInternalParameters() noexcept;

    ReverbParams params_;
    float sampleRate_{48000.0f};

    // Предварительная задержка (Pre-Delay Ring Buffer)
    std::vector<float> preDelayBufferL_;
    std::vector<float> preDelayBufferR_;
    size_t preDelayBufferSize_{0};
    size_t preDelayWriteIndex_{0};
    size_t preDelayFrames_{0};

    // 8 параллельных гребенчатых фильтров на канал
    std::array<CombFilter, NUM_COMBS> combFiltersL_;
    std::array<CombFilter, NUM_COMBS> combFiltersR_;

    // 4 последовательных фазовых рассеивателя на канал
    std::array<AllpassFilter, NUM_ALLPASS> allpassFiltersL_;
    std::array<AllpassFilter, NUM_ALLPASS> allpassFiltersR_;

    // Входной High-Pass фильтр (Low Cut 1-го порядка)
    float lowCutCoeff_{0.0f};
    float hpStoreL_{0.0f};
    float hpStoreR_{0.0f};

    // Матрица стереомикширования
    float wetGain1_{0.0f};
    float wetGain2_{0.0f};
    float dryGain_{1.0f};
};

} // namespace DAWCore
