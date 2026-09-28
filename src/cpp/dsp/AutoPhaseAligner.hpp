#pragma once

/**
 * ============================================================================
 * AutoPhaseAligner.hpp - Взаимная коррекция фазы и микрозадержек (C++17, RT-Safe)
 * ============================================================================
 * Студийный прецизионный фазовый корректор (аналог Sound Radix Auto-Align /
 * InPhase / Melda MAutoAlign) для синхронизации дублей вокала, параллельных
 * микрофонов и устранения гребенчатой фильтрации (Comb Filtering).
 *
 * Архитектура:
 * 1. Нормализованная взаимная корреляция (Normalized Cross-Correlation, NCC):
 *    - Поиск максимальной фазовой когерентности в окне поиска [-maxShiftMs, +maxShiftMs].
 * 2. Субсэмпловая параболическая квадратичная интерполяция:
 *    - Достижение субмикросекундной точности (< 0.01 сэмпла).
 * 3. Автоматическое определение полярности (Polarity Check):
 *    - Инверсия фазы на 180° при отрицательном коэффициенте корреляции (rho < 0).
 * 4. Дробная линия задержки (Fractional Delay Line):
 *    - Всепропускающий фильтр Тирана 1-го/2-го порядка (Thiran Allpass Interpolator)
 *      со строго равномерной АЧХ (Flat Unity Magnitude) без завала ВЧ.
 * 5. Аппаратная векторизация WASM SIMD128 и строгий Zero Malloc.
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <vector>
#include <cmath>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Результат анализа взаимной фазы
 */
struct PhaseAlignResult {
    float delayMs = 0.0f;            // Вычисленное смещение задержки в миллисекундах
    float delaySamples = 0.0f;       // Задержка в сэмплах (дробное значение)
    float correlation = 0.0f;        // Коэффициент взаимной корреляции (-1.0 .. +1.0)
    bool phaseInverted = false;      // Требуется ли инверсия фазы на 180°
    float coherenceScore = 0.0f;     // Оценка фазовой когерентности (0.0 .. 1.0)
};

/**
 * Параметры модуля фазового выравнивания
 */
struct AutoPhaseParams {
    float maxShiftMs = 20.0f;        // Максимальный диапазон поиска задержки (1.0 .. 50.0 мс)
    bool autoInvertPolarity = true;  // Автоматический переворот фазы при противофазе
    bool enabled = true;             // Активность модуля
};

/**
 * Линия задержки с дробной интерполяцией Тирана (Thiran Fractional Delay)
 */
class FractionalDelayLine {
public:
    explicit FractionalDelayLine(size_t maxDelaySamples = 4096) noexcept;
    ~FractionalDelayLine() = default;

    void setMaxDelay(size_t maxDelaySamples) noexcept;
    void reset() noexcept;

    /**
     * Запись сэмпла и чтение задержанного с дробной задержкой
     */
    inline float processSample(float input, float delaySamples) noexcept {
        const float dClamped = std::max(0.0f, std::min(static_cast<float>(bufferCap_ - 4), delaySamples));
        const size_t dInt = static_cast<size_t>(dClamped);
        const float dFrac = dClamped - static_cast<float>(dInt);

        // Запись во входной кольцевой буфер
        buffer_[writePos_] = input;

        // Целочисленный сдвиг
        const size_t readPos0 = (writePos_ + bufferCap_ - dInt) % bufferCap_;
        const size_t readPos1 = (readPos0 + bufferCap_ - 1) % bufferCap_;

        const float x0 = buffer_[readPos0];
        const float x1 = buffer_[readPos1];

        // 1-полюсный всепропускающий фильтр Тирана:
        // H(z) = (a + z^-1) / (1 + a * z^-1), где a = (1 - dFrac) / (1 + dFrac)
        // Строго плоская АЧХ (|H(w)| = 1.0) на всех частотах вплоть до Найквиста!
        const float eta = dFrac;
        const float a = (1.0f - eta) / (1.0f + eta + 1e-9f);

        const float y = a * x0 + allpassStateX_ - a * allpassStateY_;
        allpassStateX_ = x0;
        allpassStateY_ = y;

        if (++writePos_ >= bufferCap_) writePos_ = 0;
        return y;
    }

private:
    std::vector<float> buffer_;
    size_t bufferCap_{4096};
    size_t writePos_{0};
    float allpassStateX_{0.0f};
    float allpassStateY_{0.0f};
};

/**
 * Класс AutoPhaseAligner - Автоматический фазовый корректор
 */
class AutoPhaseAligner {
public:
    static constexpr size_t MAX_ANALYSIS_FRAMES = 8192;
    static constexpr float DEFAULT_MAX_SHIFT_MS = 20.0f;

    explicit AutoPhaseAligner(float sampleRate = 48000.0f) noexcept;
    ~AutoPhaseAligner() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    /**
     * Установка параметров анализа
     */
    void setParams(const AutoPhaseParams& params) noexcept;
    const AutoPhaseParams& getParams() const noexcept { return params_; }

    /**
     * Сброс внутреннего состояния
     */
    void reset() noexcept;

    /**
     * Вычисление взаимного сдвига фазы и корреляции без изменения сигнала
     *
     * @param reference   Указатель на референсный сигнал (оригинал, ведущий микрофон)
     * @param target      Указатель на целевой сигнал (дубль, ведомый микрофон)
     * @param numFrames   Количество сэмплов для анализа
     * @param maxShiftMs  Максимальный диапазон поиска задержки (мс)
     * @return            Структура PhaseAlignResult с точным значением смещения и полярности
     */
    PhaseAlignResult analyzePhase(
        const float* reference,
        const float* target,
        size_t numFrames,
        float maxShiftMs = 20.0f
    ) noexcept;

    /**
     * Полное автоматическое выравнивание фазы и задержки дорожки target относительно reference
     *
     * @param reference   Референсный сигнал
     * @param target      Целевой сигнал (модифицируется in-place с субсэмпловой точностью)
     * @param numFrames   Количество сэмплов
     * @param maxShiftMs  Максимальный диапазон поиска сдвига (мс)
     * @return            Результаты выравнивания
     */
    PhaseAlignResult alignSignals(
        const float* reference,
        float* target,
        size_t numFrames,
        float maxShiftMs = 20.0f
    ) noexcept;

    /**
     * Применение заданного сдвига и инверсии фазы к блоку target
     */
    void applyAlignment(
        float* target,
        size_t numFrames,
        float delaySamples,
        bool invertPolarity
    ) noexcept;

    /**
     * Потоковая In-Place обработка блока со статически зафиксированным сдвигом
     */
    void processBlock(float* target, size_t numFrames, int channels) noexcept;

private:
    AutoPhaseParams params_;
    float sampleRate_{48000.0f};

    PhaseAlignResult lastResult_{};
    FractionalDelayLine delayLineL_{8192};
    FractionalDelayLine delayLineR_{8192};

    // Рабочие векторы взаимной корреляции (Zero Alloc)
    std::vector<float> corrScores_;
};

} // namespace DAWCore
