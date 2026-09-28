#pragma once

/**
 * ============================================================================
 * MouthDeClicker.hpp - Модуль реставрации щелчков губ и рта (C++17, RT-Safe)
 * ============================================================================
 * Студийный алгоритмический процессор для обнаружения и бесшовной реставрации
 * влажных щелчков губ, слюны и языка (Mouth Clicks / Saliva Smacks / Lip Clicks)
 * в дикторских и вокальных аудиозаписях.
 *
 * Архитектура:
 * 1. Многопорядковый дифференциальный анализ:
 *    - Вторая и третья дискретные производные формы волны (2nd & 3rd Derivatives)
 *      для изолирования ультракоротких разрывных дельта-импульсов слюны.
 * 2. Высокочастотный тракт обнаружения (> 4 кГц):
 *    - Оценка отношения всплеска локальной энергии к скользящей дисперсии фона.
 * 3. Локализация границ щелчка [n_start, n_end] с адаптивным расширением.
 * 4. Кубическая сплайновая интерполяция Эрмита (Cubic Hermite Spline) класса C^1:
 *    - Бесшовное замещение поврежденных импульсом сэмплов с точным сохранением
 *      значений и первых производных на обеих границах фонового контекста.
 * 5. Буфер упреждения Lookahead (до 256 сэмплов / ~5.3 мс).
 * 6. Полная RT-Safety: нулевые аллокации (Zero Malloc) и поддержка WASM SIMD128.
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
 * Параметры модуля устранения щелчков рта
 */
struct MouthDeClickerParams {
    float sensitivity = 0.65f;             // Чувствительность обнаружения (0.0 .. 1.0)
    size_t maxClickDurationSamples = 64;   // Максимальная длина щелчка (16 .. 144 сэмплов, ~0.5 - 3 мс)
    float highPassCutoff = 4000.0f;        // Частота среза детектора ВЧ (2500 .. 8000 Гц)
    size_t wideningMargin = 2;             // Запас охвата границ щелчка (сэмплов)
    bool enabled = true;                   // Активность обработки
};

/**
 * Биквадратный нормализованный фильтр TDF-II
 */
struct ClickBiquadCoeffs {
    float b0 = 1.0f;
    float b1 = 0.0f;
    float b2 = 0.0f;
    float a1 = 0.0f;
    float a2 = 0.0f;
};

struct ClickBiquadState {
    float s1 = 0.0f;
    float s2 = 0.0f;

    inline void reset() noexcept {
        s1 = 0.0f;
        s2 = 0.0f;
    }
};

/**
 * Класс MouthDeClicker - Реставратор щелчков слюны и губ
 */
class MouthDeClicker {
public:
    static constexpr size_t LOOKAHEAD_SAMPLES = 256; // ~5.3 мс при 48 кГц

    explicit MouthDeClicker(float sampleRate = 48000.0f) noexcept;
    ~MouthDeClicker() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(float sampleRate) noexcept;
    float getSampleRate() const noexcept { return sampleRate_; }

    /**
     * Установка параметров обработки
     */
    void setParams(const MouthDeClickerParams& params) noexcept;
    const MouthDeClickerParams& getParams() const noexcept { return params_; }

    /**
     * Задержка модуля (Lookahead)
     */
    size_t getLatencySamples() const noexcept { return LOOKAHEAD_SAMPLES; }

    /**
     * Сброс буферов и истории фильтров
     */
    void reset() noexcept;

    /**
     * Количество устраненных щелчков с момента последнего сброса (для UI)
     */
    uint64_t getTotalClicksRepaired() const noexcept { return totalClicksRepaired_; }

    /**
     * Потоковая In-Place обработка блока (RT-Safe, SIMD128, Zero Malloc)
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
     * Расчет ФВЧ Баттерворта 2-го порядка для выделения щелчков
     */
    void updateHPFFilter() noexcept;

    /**
     * Обработка одного аудиоканала в кольцевом буфере упреждения
     */
    void processChannelLookahead(
        const float* input,
        float* output,
        size_t numFrames,
        size_t ch
    ) noexcept;

    /**
     * Кубическая сплайновая интерполяция Эрмита (C1 Continuity)
     */
    static void repairRegionHermite(
        std::vector<float>& buf,
        size_t startIdx,
        size_t endIdx,
        size_t bufCap
    ) noexcept;

    MouthDeClickerParams params_;
    float sampleRate_{48000.0f};

    // ФВЧ детектор ВЧ щелчков (> 4 кГц)
    ClickBiquadCoeffs hpfCoeffs_{};
    std::array<ClickBiquadState, 2> hpfStates_{};

    // Буферы истории дифференцирования [ch][sample]
    std::array<std::array<float, 4>, 2> diffHistory_{};

    // Скользящая дисперсия фона для нормализации порога
    std::array<float, 2> movingVariance_{ 0.001f, 0.001f };
    float varCoeff_{0.998f};

    // Кольцевые буферы упреждения
    std::vector<float> ringBufL_;
    std::vector<float> ringBufR_;
    size_t ringWritePos_{0};

    // Метрики щелчков для каждого сохраненного сэмпла кольцевого буфера
    std::vector<float> anomalyScoresL_;
    std::vector<float> anomalyScoresR_;

    uint64_t totalClicksRepaired_{0};
};

} // namespace DAWCore
