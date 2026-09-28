#pragma once

/**
 * ============================================================================
 * ParametricEQPro.hpp - 5-полосный студийный параметрический эквалайзер
 * ============================================================================
 * Высокопроизводительный C++17 DSP модуль мастерингового эквалайзера.
 * 
 * Особенности:
 * 1. Формулы фильтров Роберта Бристоу-Джонсона (Robert Bristow-Johnson Audio EQ Cookbook).
 * 2. 5 настраиваемых полос:
 *    - Полоса 1: Low Shelf (с опцией High Pass / Low Cut)
 *    - Полоса 2: Low-Mid Peaking (Bell)
 *    - Полоса 3: Mid Peaking (Bell)
 *    - Полоса 4: High-Mid Peaking (Bell)
 *    - Полоса 5: High Shelf (с опцией Low Pass / High Cut)
 * 3. Топология Direct Form II Transposed (TDF-II) для максимальной численной
 *    стабильности и низкого уровня фазовых шумов.
 * 4. Защита от щелчков (Anti-Zipper/Anti-Click): динамическая интерполяция
 *    коэффициентов биквадратов при вращении регуляторов в UI.
 * 5. Аппаратное ускорение WebAssembly SIMD128 и полная RT-Safety (Zero Malloc).
 * ============================================================================
 */

#include <cstddef>
#include <cstdint>
#include <array>
#include "AudioMath.hpp"

namespace DAWCore {

/**
 * Тип фильтра полосы эквалайзера
 */
enum class EQFilterType : uint32_t {
    LowShelf = 0,
    Peaking = 1,
    HighShelf = 2,
    HighPass = 3,
    LowPass = 4,
    Notch = 5
};

/**
 * Параметры отдельной полосы эквалайзера
 */
struct EQBandParams {
    EQFilterType type = EQFilterType::Peaking;
    float frequency = 1000.0f; // Центральная частота или частота среза (20.0 .. 20000.0 Гц)
    float gainDb = 0.0f;       // Усиление / ослабление (-24.0 .. +24.0 дБ)
    float Q = 0.7071f;         // Добротность фильтра (0.1 .. 20.0)
    bool enabled = true;       // Активность полосы
};

/**
 * Нормализованные биквадратные коэффициенты (b0, b1, b2, a1, a2)
 */
struct BiquadCoeffs {
    float b0 = 1.0f;
    float b1 = 0.0f;
    float b2 = 0.0f;
    float a1 = 0.0f;
    float a2 = 0.0f;
};

/**
 * Регистры состояния фильтра (Direct Form II Transposed)
 */
struct BiquadStateTDF2 {
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
 * Класс ParametricEQPro - 5-полосный профессиональный параметрический эквалайзер
 */
class ParametricEQPro {
public:
    static constexpr size_t NUM_BANDS = 5;

    ParametricEQPro() noexcept;
    explicit ParametricEQPro(double sampleRate) noexcept;
    ~ParametricEQPro() = default;

    /**
     * Инициализация частоты дискретизации
     */
    void setSampleRate(double sampleRate) noexcept;

    /**
     * Получение текущей частоты дискретизации
     */
    double getSampleRate() const noexcept { return sampleRate_; }

    /**
     * Настройка параметров конкретной полосы (0 .. 4)
     */
    void setBandParams(size_t bandIndex, const EQBandParams& params) noexcept;

    /**
     * Получение параметров конкретной полосы
     */
    const EQBandParams& getBandParams(size_t bandIndex) const noexcept;

    /**
     * Установка общего коэффициента Master Output Gain (дБ)
     */
    void setOutputGainDb(float gainDb) noexcept;
    float getOutputGainDb() const noexcept { return outputGainDb_; }

    /**
     * Общий байпас эквалайзера
     */
    void setEnabled(bool enabled) noexcept { enabled_ = enabled; }
    bool isEnabled() const noexcept { return enabled_; }

    /**
     * Пересчет биквадратных коэффициентов для всех полос по Audio EQ Cookbook
     * Вызывается при обновлении параметров в UI.
     */
    void updateCoefficients(double sampleRate) noexcept;

    /**
     * Сброс внутренних линий задержки (очистка фазовых хвостов)
     */
    void reset() noexcept;

    /**
     * Потоковая In-Place обработка блока сэмплов (RT-Safe, SIMD128, Zero Malloc)
     *
     * @param samples    Указатель на PCM Float32 буфер (Interleaved для стерео)
     * @param numFrames  Число аудиокадров (сэмплов на канал)
     * @param channels   Число каналов (1 = моно, 2 = стерео)
     */
    void processBlock(float* samples, size_t numFrames, int channels) noexcept;

    /**
     * Out-of-Place обработка блока
     */
    void processBlock(const float* input, float* output, size_t numFrames, int channels) noexcept;

private:
    /**
     * Аналитический расчет коэффициентов одной полосы по формулам RBJ Cookbook
     */
    static BiquadCoeffs calculateRBJCoeffs(const EQBandParams& params, double sampleRate) noexcept;

    double sampleRate_{48000.0};
    bool enabled_{true};
    float outputGainDb_{0.0f};
    float outputGainLinear_{1.0f};

    // Настройки 5 полос
    std::array<EQBandParams, NUM_BANDS> bands_;

    // Целевые коэффициенты (вычисленные из параметров)
    std::array<BiquadCoeffs, NUM_BANDS> targetCoeffs_;

    // Текущие сглаженные коэффициенты (для анти-щелчковой интерполяции)
    std::array<BiquadCoeffs, NUM_BANDS> currentCoeffs_;

    // Регистры задержки TDF-II для каждого фильтра
    std::array<BiquadStateTDF2, NUM_BANDS> states_;

    // Флаг необходимости интерполяции коэффициентов
    std::array<bool, NUM_BANDS> needsRamping_{};
};

} // namespace DAWCore
