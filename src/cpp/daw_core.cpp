/**
 * ============================================================================
 * DAW CORE C++17 - Многодорожечный аудиомикшер и DSP ядро для WebAssembly
 * ============================================================================
 * Разработано для высокопроизводительной обработки звука в реальном времени
 * внутри браузерного AudioWorklet и офлайн-рендеринга (Emscripten / WASM SIMD).
 *
 * Архитектурные особенности:
 * 1. Zero-Allocation в аудиоциклах: исключены динамические выделения памяти (malloc/new)
 *    при обработке аудиокадров.
 * 2. WASM SIMD128 векторизация: параллельная обработка по 4 сэмпла float за такт.
 * 3. Полный тракт Vocal Rack DSP:
 *    Input -> DeClicker -> DePlosive -> NoiseGate -> ParametricEQ -> DeEsser -> Compressor -> AutoDucker.
 * 4. Нативные DSP модули на C++:
 *    - LoudnessAnalyzer: True Peak & RMS (EBU R128 / Broadcast Normalization).
 *    - AudioResampler: Высокоточный кубический Catmull-Rom Hermite ресэмплинг в 48 000 Hz.
 *    - BatchOfflineRenderer: Пакетное сведение проекта и экспорт мультитрековых стемов (Stems).
 *    - NativeWavPacker: Прямая запись RIFF/WAVE заголовков (16-bit, 24-bit PCM, 32-bit Float).
 * ============================================================================
 */

#include <cmath>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <algorithm>
#include <array>
#include <vector>
#include <memory>
#include <string>

// Подключение интринсиков WebAssembly SIMD128 при наличии флага -msimd128
#if defined(__wasm_simd128__) || defined(__wasm_simd__)
#include <wasm_simd128.h>
#define USE_WASM_SIMD 1
#else
#define USE_WASM_SIMD 0
#endif

// Включаем заголовочный файл Emscripten для экспортных связок (embind)
#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include <emscripten/val.h>
#endif

namespace DAWCore {

// Константы математических расчетов и аудиопараметров
constexpr float PI_F = 3.14159265358979323846f;
constexpr float MIN_DB = -120.0f;
constexpr float EPSILON = 1e-6f;
constexpr size_t MAX_TRACKS = 32;
constexpr size_t MAX_CLIPS_PER_TRACK = 64;
constexpr size_t MAX_BUFFER_SIZE = 8192; // Максимальный размер блока сэмплов (стерео = 2 * 8192)
constexpr size_t SIDECHAIN_RING_SIZE = 4096;
constexpr float TARGET_SAMPLE_RATE = 48000.0f;

/**
 * Вспомогательные математические и аудио-функции
 */
inline float dbToGain(float db) {
    if (db <= MIN_DB) return 0.0f;
    return std::pow(10.0f, db * 0.05f);
}

inline float gainToDb(float gain) {
    if (gain <= EPSILON) return MIN_DB;
    return 20.0f * std::log10(gain);
}

inline float clampFloat(float val, float minVal, float maxVal) {
    return std::max(minVal, std::min(maxVal, val));
}

// ============================================================================
// 1. СТРУКТУРА КЛИПА (CLIP)
// ============================================================================

/**
 * Структура клипа - аудиосегмента на таймлайне дорожки.
 */
struct Clip {
    uint32_t id{0};
    const float* sampleBuffer{nullptr}; // Указатель на 32-bit float буфер сэмплов (моно или стерео)
    size_t bufferSizeSamples{0};       // Общий размер буфера клипа (в сэмплах на канал)
    size_t offsetSamples{0};           // Позиция старта клипа на таймлайне дорожки (в сэмплах)
    size_t lengthSamples{0};           // Длина воспроизводимой части клипа (в сэмплах)
    float gain{1.0f};                  // Громкость клипа (0.0 .. 2.0+)
    float pan{0.0f};                   // Панорама клипа (-1.0 влево .. +1.0 вправо)
    size_t fadeInSamples{0};           // Длина плавного нарастания громкости (fade in)
    size_t fadeOutSamples{0};          // Длина плавного затухания громкости (fade out)
    bool isStereo{false};              // Флаг: true - стерео interleaved, false - моно
    bool active{true};                 // Флаг активности клипа

    /**
     * Получение коэффициента фейда (Fade In / Fade Out) для текущей позиции сэмпла клипа.
     */
    inline float getFadeGain(size_t sampleIndexInClip) const {
        float fadeGain = 1.0f;
        if (fadeInSamples > 0 && sampleIndexInClip < fadeInSamples) {
            fadeGain *= static_cast<float>(sampleIndexInClip) / static_cast<float>(fadeInSamples);
        }
        if (fadeOutSamples > 0 && sampleIndexInClip >= (lengthSamples - fadeOutSamples)) {
            size_t remaining = lengthSamples - sampleIndexInClip;
            fadeGain *= static_cast<float>(remaining) / static_cast<float>(fadeOutSamples);
        }
        return clampFloat(fadeGain, 0.0f, 1.0f);
    }
};

// ============================================================================
// 2. DSP ЭФФЕКТЫ (DSP MODULES & VOCAL RACK)
// ============================================================================

/**
 * 1. DeClicker - Модуль устранения импульсных щелчков и цифровых артефактов
 * Анализ 2-й производной (LOD derivative delta) + кубическая Hermite-интерполяция
 */
class DeClicker {
public:
    float threshold{0.08f};      // Порог чувствительности производной (0.01 .. 0.5)
    size_t repairWindow{4};      // Базовая длина окна ремонта
    bool enabled{true};
    uint32_t clicksDetected{0};

    // Статическая история сэмплов для безынерционной непрерывности между блоками
    static constexpr size_t HIST_SIZE = 8;
    std::array<float, HIST_SIZE> histL{};
    std::array<float, HIST_SIZE> histR{};

    DeClicker() {
        reset();
    }

    void reset() {
        histL.fill(0.0f);
        histR.fill(0.0f);
        clicksDetected = 0;
    }

    /**
     * Кубическая сплайновая Hermite-интерполяция
     */
    static inline float hermiteInterpolate(float p0, float m0, float p1, float m1, float t) {
        float t2 = t * t;
        float t3 = t2 * t;
        float h00 = 2.0f * t3 - 3.0f * t2 + 1.0f;
        float h10 = t3 - 2.0f * t2 + t;
        float h01 = -2.0f * t3 + 3.0f * t2;
        float h11 = t3 - t2;
        return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }

    void processBuffer(float* interleavedBuffer, size_t numFrames) {
        if (!enabled || numFrames == 0) return;

        for (size_t i = 0; i < numFrames; ++i) {
            // --- Левый канал ---
            float curL = interleavedBuffer[i * 2];
            float prev1L = histL[0];
            float prev2L = histL[1];
            float prev3L = histL[2];

            // 2-я производная d^2x/dt^2
            float d2L = curL - 2.0f * prev1L + prev2L;
            float absD2L = std::abs(d2L);
            float localVarL = 0.5f * (std::abs(prev1L - prev2L) + std::abs(prev2L - prev3L)) + 0.001f;

            if (absD2L > (threshold + 3.5f * localVarL) && absD2L > 0.015f) {
                clicksDetected++;
                float nextL = (i + 1 < numFrames) ? interleavedBuffer[(i + 1) * 2] : prev1L;
                float m0L = prev1L - prev2L;
                float m1L = nextL - prev1L;
                curL = hermiteInterpolate(prev1L, m0L, nextL, m1L, 0.5f);
                interleavedBuffer[i * 2] = curL;
            }

            histL[3] = histL[2];
            histL[2] = histL[1];
            histL[1] = histL[0];
            histL[0] = curL;

            // --- Правый канал ---
            float curR = interleavedBuffer[i * 2 + 1];
            float prev1R = histR[0];
            float prev2R = histR[1];
            float prev3R = histR[2];

            float d2R = curR - 2.0f * prev1R + prev2R;
            float absD2R = std::abs(d2R);
            float localVarR = 0.5f * (std::abs(prev1R - prev2R) + std::abs(prev2R - prev3R)) + 0.001f;

            if (absD2R > (threshold + 3.5f * localVarR) && absD2R > 0.015f) {
                clicksDetected++;
                float nextR = (i + 1 < numFrames) ? interleavedBuffer[(i + 1) * 2 + 1] : prev1R;
                float m0R = prev1R - prev2R;
                float m1R = nextR - prev1R;
                curR = hermiteInterpolate(prev1R, m0R, nextR, m1R, 0.5f);
                interleavedBuffer[i * 2 + 1] = curR;
            }

            histR[3] = histR[2];
            histR[2] = histR[1];
            histR[1] = histR[0];
            histR[0] = curR;
        }
    }
};

/**
 * 2. DePlosive - Динамический подавитель взрывных согласных и задуваний микрофона (< 80 Гц)
 * Адаптивный High-Pass Biquad фильтр 2-го порядка, активирующийся динамически при резком всплеске суббаса.
 */
class DePlosive {
public:
    float thresholdDb{-24.0f};  // Порог срабатывания (-40 .. -6 dB)
    float frequency{80.0f};      // Частота среза HPF (40 .. 150 Hz)
    float attackMs{2.0f};        // Время быстрой атаки (0.5 .. 10 ms)
    float releaseMs{50.0f};      // Время спада (20 .. 200 ms)
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentReduction{0.0f}; // Текущий уровень вмешательства (0.0 .. 1.0)

    // Коэффициенты Biquad HPF 2-го порядка (Butterworth)
    float b0{1.0f}, b1{0.0f}, b2{0.0f}, a1{0.0f}, a2{0.0f};
    float hpfX1L{0.0f}, hpfX2L{0.0f}, hpfY1L{0.0f}, hpfY2L{0.0f};
    float hpfX1R{0.0f}, hpfX2R{0.0f}, hpfY1R{0.0f}, hpfY2R{0.0f};

    // Детектор суббасовой энергии (< 90 Hz Biquad Low-Pass для сайдчейн-детектора)
    float lpB0{0.0f}, lpB1{0.0f}, lpB2{0.0f}, lpA1{0.0f}, lpA2{0.0f};
    float lpX1L{0.0f}, lpX2L{0.0f}, lpY1L{0.0f}, lpY2L{0.0f};
    float lpX1R{0.0f}, lpX2R{0.0f}, lpY1R{0.0f}, lpY2R{0.0f};

    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float subEnvelope{0.0f};

    DePlosive() {
        setup(48000.0f);
    }

    void setup(float sr) {
        sampleRate = sr;
        updateCoefficients();
    }

    void reset() {
        hpfX1L = hpfX2L = hpfY1L = hpfY2L = 0.0f;
        hpfX1R = hpfX2R = hpfY1R = hpfY2R = 0.0f;
        lpX1L = lpX2L = lpY1L = lpY2L = 0.0f;
        lpX1R = lpX2R = lpY1R = lpY2R = 0.0f;
        subEnvelope = 0.0f;
        currentReduction = 0.0f;
    }

    void updateCoefficients() {
        if (sampleRate <= 0.0f) return;
        attackCoeff = std::exp(-1.0f / (attackMs * 0.001f * sampleRate));
        releaseCoeff = std::exp(-1.0f / (releaseMs * 0.001f * sampleRate));

        // 2nd order Butterworth HPF
        float omegaHP = 2.0f * PI_F * frequency / sampleRate;
        float snHP = std::sin(omegaHP);
        float csHP = std::cos(omegaHP);
        float alphaHP = snHP / (2.0f * 0.7071f);

        float a0HP = 1.0f + alphaHP;
        b0 = ((1.0f + csHP) / 2.0f) / a0HP;
        b1 = (-(1.0f + csHP)) / a0HP;
        b2 = ((1.0f + csHP) / 2.0f) / a0HP;
        a1 = (-2.0f * csHP) / a0HP;
        a2 = (1.0f - alphaHP) / a0HP;

        // Detector LowPass (90 Hz)
        float omegaLP = 2.0f * PI_F * 90.0f / sampleRate;
        float snLP = std::sin(omegaLP);
        float csLP = std::cos(omegaLP);
        float alphaLP = snLP / (2.0f * 0.7071f);

        float a0LP = 1.0f + alphaLP;
        lpB0 = ((1.0f - csLP) / 2.0f) / a0LP;
        lpB1 = (1.0f - csLP) / a0LP;
        lpB2 = ((1.0f - csLP) / 2.0f) / a0LP;
        lpA1 = (-2.0f * csLP) / a0LP;
        lpA2 = (1.0f - alphaLP) / a0LP;
    }

    void processBuffer(float* interleavedBuffer, size_t numFrames) {
        if (!enabled || numFrames == 0) return;

        float threshLin = dbToGain(thresholdDb);

        for (size_t i = 0; i < numFrames; ++i) {
            float inL = interleavedBuffer[i * 2];
            float inR = interleavedBuffer[i * 2 + 1];

            // Фильтрация детектора
            float detL = lpB0 * inL + lpB1 * lpX1L + lpB2 * lpX2L - lpA1 * lpY1L - lpA2 * lpY2L;
            lpX2L = lpX1L; lpX1L = inL; lpY2L = lpY1L; lpY1L = detL;

            float detR = lpB0 * inR + lpB1 * lpX1R + lpB2 * lpX2R - lpA1 * lpY1R - lpA2 * lpY2R;
            lpX2R = lpX1R; lpX1R = inR; lpY2R = lpY1R; lpY1R = detR;

            float subLevel = std::max(std::abs(detL), std::abs(detR));
            subEnvelope = (subLevel > subEnvelope)
                ? attackCoeff * subEnvelope + (1.0f - attackCoeff) * subLevel
                : releaseCoeff * subEnvelope + (1.0f - releaseCoeff) * subLevel;

            // Активация фильтрации при превышении порога
            float targetBlend = 0.0f;
            if (subEnvelope > threshLin) {
                float overRatio = (subEnvelope - threshLin) / (threshLin + 1e-4f);
                targetBlend = clampFloat(overRatio, 0.0f, 1.0f);
            }
            currentReduction = targetBlend;

            // Применение HPF
            float hpfOutL = b0 * inL + b1 * hpfX1L + b2 * hpfX2L - a1 * hpfY1L - a2 * hpfY2L;
            hpfX2L = hpfX1L; hpfX1L = inL; hpfY2L = hpfY1L; hpfY1L = hpfOutL;

            float hpfOutR = b0 * inR + b1 * hpfX1R + b2 * hpfX2R - a1 * hpfY1R - a2 * hpfY2R;
            hpfX2R = hpfX1R; hpfX1R = inR; hpfY2R = hpfY1R; hpfY1L = hpfOutR;

            // Кроссфейд сухой/обработанный сигнал
            interleavedBuffer[i * 2] = inL * (1.0f - targetBlend) + hpfOutL * targetBlend;
            interleavedBuffer[i * 2 + 1] = inR * (1.0f - targetBlend) + hpfOutR * targetBlend;
        }
    }
};

/**
 * 3. NoiseGate - Студийный шумоподавитель с плавным гистерезисом и Hold фазой
 */
enum class GateState { Closed, Opening, Open, Holding, Closing };

class NoiseGate {
public:
    float thresholdDb{-45.0f};   // Порог открывания гейта (-70 .. -20 dB)
    float attackMs{1.5f};        // Скорость открытия (0.1 .. 10 ms)
    float holdMs{50.0f};         // Время удержания открытого состояния (10 .. 300 ms)
    float releaseMs{80.0f};      // Время закрытия (20 .. 500 ms)
    float floorDb{-70.0f};       // Уровень подавления шума в паузах (-96 .. -24 dB)
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentGain{1.0f};

    GateState state{GateState::Closed};
    size_t holdSamplesCounter{0};
    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float envelope{0.0f};

    NoiseGate() {
        setup(48000.0f);
    }

    void setup(float sr) {
        sampleRate = sr;
        updateConstants();
    }

    void reset() {
        state = GateState::Closed;
        holdSamplesCounter = 0;
        currentGain = dbToGain(floorDb);
        envelope = 0.0f;
    }

    void updateConstants() {
        if (sampleRate <= 0.0f) return;
        attackCoeff = std::exp(-1.0f / (attackMs * 0.001f * sampleRate));
        releaseCoeff = std::exp(-1.0f / (releaseMs * 0.001f * sampleRate));
    }

    void processBuffer(float* interleavedBuffer, size_t numFrames) {
        if (!enabled || numFrames == 0) return;

        float openThreshLin = dbToGain(thresholdDb);
        float closeThreshLin = dbToGain(thresholdDb - 3.0f); // 3 dB гистерезис
        float floorGainLin = dbToGain(floorDb);
        size_t holdSamplesTotal = static_cast<size_t>(holdMs * 0.001f * sampleRate);

        for (size_t i = 0; i < numFrames; ++i) {
            float inL = interleavedBuffer[i * 2];
            float inR = interleavedBuffer[i * 2 + 1];
            float level = std::max(std::abs(inL), std::abs(inR));

            // Быстрый детектор огибающей
            envelope = (level > envelope)
                ? 0.9f * envelope + 0.1f * level
                : 0.999f * envelope + 0.001f * level;

            // Конечный автомат состояний гейта
            switch (state) {
                case GateState::Closed:
                    if (envelope >= openThreshLin) {
                        state = GateState::Opening;
                    }
                    break;
                case GateState::Opening:
                    currentGain = attackCoeff * currentGain + (1.0f - attackCoeff) * 1.0f;
                    if (currentGain >= 0.99f) {
                        currentGain = 1.0f;
                        state = GateState::Open;
                    }
                    break;
                case GateState::Open:
                    if (envelope < closeThreshLin) {
                        state = GateState::Holding;
                        holdSamplesCounter = holdSamplesTotal;
                    }
                    break;
                case GateState::Holding:
                    if (envelope >= openThreshLin) {
                        state = GateState::Open;
                    } else if (holdSamplesCounter > 0) {
                        holdSamplesCounter--;
                    } else {
                        state = GateState::Closing;
                    }
                    break;
                case GateState::Closing:
                    if (envelope >= openThreshLin) {
                        state = GateState::Opening;
                    } else {
                        currentGain = releaseCoeff * currentGain + (1.0f - releaseCoeff) * floorGainLin;
                        if (currentGain <= floorGainLin * 1.02f) {
                            currentGain = floorGainLin;
                            state = GateState::Closed;
                        }
                    }
                    break;
            }

            interleavedBuffer[i * 2] *= currentGain;
            interleavedBuffer[i * 2 + 1] *= currentGain;
        }
    }
};

/**
 * 4. BiquadFilter & ParametricEQ3Band - 3-полосный параметрический эквалайзер
 */
enum class BiquadFilterType { LowShelf, Peaking, HighShelf };

class BiquadFilter {
public:
    BiquadFilterType type{BiquadFilterType::Peaking};
    float frequency{1000.0f};
    float gainDb{0.0f};
    float Q{0.7071f};
    float sampleRate{48000.0f};
    bool enabled{true};

    float b0{1.0f}, b1{0.0f}, b2{0.0f}, a1{0.0f}, a2{0.0f};
    float x1L{0.0f}, x2L{0.0f}, y1L{0.0f}, y2L{0.0f};
    float x1R{0.0f}, x2R{0.0f}, y1R{0.0f}, y2R{0.0f};

    BiquadFilter() = default;

    void resetState() {
        x1L = x2L = y1L = y2L = 0.0f;
        x1R = x2R = y1R = y2R = 0.0f;
    }

    void updateCoefficients() {
        if (sampleRate <= 0.0f) return;
        float A = std::pow(10.0f, gainDb / 40.0f);
        float omega = 2.0f * PI_F * frequency / sampleRate;
        float sn = std::sin(omega);
        float cs = std::cos(omega);
        float alpha = sn / (2.0f * std::max(Q, 0.001f));
        float beta = std::sqrt(A) / std::max(Q, 0.001f);

        float a0 = 1.0f;

        if (type == BiquadFilterType::LowShelf) {
            b0 = A * ((A + 1.0f) - (A - 1.0f) * cs + beta * sn);
            b1 = 2.0f * A * ((A - 1.0f) - (A + 1.0f) * cs);
            b2 = A * ((A + 1.0f) - (A - 1.0f) * cs - beta * sn);
            a0 = (A + 1.0f) + (A - 1.0f) * cs + beta * sn;
            a1 = -2.0f * ((A - 1.0f) + (A + 1.0f) * cs);
            a2 = (A + 1.0f) + (A - 1.0f) * cs - beta * sn;
        } else if (type == BiquadFilterType::Peaking) {
            b0 = 1.0f + alpha * A;
            b1 = -2.0f * cs;
            b2 = 1.0f - alpha * A;
            a0 = 1.0f + alpha / A;
            a1 = -2.0f * cs;
            a2 = 1.0f - alpha / A;
        } else if (type == BiquadFilterType::HighShelf) {
            b0 = A * ((A + 1.0f) + (A - 1.0f) * cs + beta * sn);
            b1 = -2.0f * A * ((A - 1.0f) + (A + 1.0f) * cs);
            b2 = A * ((A + 1.0f) + (A - 1.0f) * cs - beta * sn);
            a0 = (A + 1.0f) - (A - 1.0f) * cs + beta * sn;
            a1 = 2.0f * ((A - 1.0f) - (A + 1.0f) * cs);
            a2 = (A + 1.0f) - (A - 1.0f) * cs - beta * sn;
        }

        b0 /= a0;
        b1 /= a0;
        b2 /= a0;
        a1 /= a0;
        a2 /= a0;
    }

    inline void processSample(float inL, float inR, float& outL, float& outR) {
        if (!enabled || std::abs(gainDb) < 0.01f) {
            outL = inL;
            outR = inR;
            return;
        }

        outL = b0 * inL + b1 * x1L + b2 * x2L - a1 * y1L - a2 * y2L;
        x2L = x1L; x1L = inL; y2L = y1L; y1L = outL;

        outR = b0 * inR + b1 * x1R + b2 * x2R - a1 * y1R - a2 * y2R;
        x2R = x1R; x1R = inR; y2R = y1R; y1R = outR;
    }
};

class ParametricEQ3Band {
public:
    BiquadFilter lowShelf;
    BiquadFilter peaking;
    BiquadFilter highShelf;
    bool enabled{true};

    ParametricEQ3Band() {
        lowShelf.type = BiquadFilterType::LowShelf;
        lowShelf.frequency = 120.0f;
        lowShelf.gainDb = 0.0f;
        lowShelf.Q = 0.7071f;

        peaking.type = BiquadFilterType::Peaking;
        peaking.frequency = 2500.0f;
        peaking.gainDb = 0.0f;
        peaking.Q = 1.2f;

        highShelf.type = BiquadFilterType::HighShelf;
        highShelf.frequency = 8000.0f;
        highShelf.gainDb = 0.0f;
        highShelf.Q = 0.7071f;

        updateAll(48000.0f);
    }

    void updateAll(float sr) {
        lowShelf.sampleRate = sr;
        lowShelf.updateCoefficients();
        peaking.sampleRate = sr;
        peaking.updateCoefficients();
        highShelf.sampleRate = sr;
        highShelf.updateCoefficients();
    }

    void reset() {
        lowShelf.resetState();
        peaking.resetState();
        highShelf.resetState();
    }

    void processBuffer(float* interleavedBuffer, size_t numFrames) {
        if (!enabled || numFrames == 0) return;

        for (size_t i = 0; i < numFrames; ++i) {
            float l = interleavedBuffer[i * 2];
            float r = interleavedBuffer[i * 2 + 1];

            lowShelf.processSample(l, r, l, r);
            peaking.processSample(l, r, l, r);
            highShelf.processSample(l, r, l, r);

            interleavedBuffer[i * 2] = l;
            interleavedBuffer[i * 2 + 1] = r;
        }
    }
};

/**
 * 5. DeEsser - Подавитель свистящих и шипящих согласных (С, З, Ш, Щ) в диапазоне 4..9 кГц
 */
class DeEsser {
public:
    float thresholdDb{-22.0f};   // Порог срабатывания (-40 .. -10 dB)
    float frequency{6000.0f};    // Центральная частота сибилянтов (4000 .. 9000 Hz)
    float ratio{4.0f};           // Коэффициент компрессии сибилянтов
    float attackMs{1.0f};        // Быстрая атака (0.5 .. 5 ms)
    float releaseMs{40.0f};      // Спад (15 .. 100 ms)
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentGainReductionDb{0.0f};

    // BPF Сайдчейн-фильтр для детектора сибилянтов (Band-Pass)
    float b0{0.0f}, b1{0.0f}, b2{0.0f}, a1{0.0f}, a2{0.0f};
    float bpX1L{0.0f}, bpX2L{0.0f}, bpY1L{0.0f}, bpY2L{0.0f};
    float bpX1R{0.0f}, bpX2R{0.0f}, bpY1R{0.0f}, bpY2R{0.0f};

    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float essEnvelope{0.0f};

    DeEsser() {
        setup(48000.0f);
    }

    void setup(float sr) {
        sampleRate = sr;
        updateCoefficients();
    }

    void reset() {
        bpX1L = bpX2L = bpY1L = bpY2L = 0.0f;
        bpX1R = bpX2R = bpY1R = bpY2R = 0.0f;
        essEnvelope = 0.0f;
        currentGainReductionDb = 0.0f;
    }

    void updateCoefficients() {
        if (sampleRate <= 0.0f) return;
        attackCoeff = std::exp(-1.0f / (attackMs * 0.001f * sampleRate));
        releaseCoeff = std::exp(-1.0f / (releaseMs * 0.001f * sampleRate));

        // 2nd order Bandpass filter around sibilant frequency with Q=2.0
        float omega = 2.0f * PI_F * frequency / sampleRate;
        float sn = std::sin(omega);
        float cs = std::cos(omega);
        float alpha = sn / (2.0f * 2.0f);

        float a0 = 1.0f + alpha;
        b0 = (alpha) / a0;
        b1 = 0.0f;
        b2 = (-alpha) / a0;
        a1 = (-2.0f * cs) / a0;
        a2 = (1.0f - alpha) / a0;
    }

    void processBuffer(float* interleavedBuffer, size_t numFrames) {
        if (!enabled || numFrames == 0) return;

        for (size_t i = 0; i < numFrames; ++i) {
            float inL = interleavedBuffer[i * 2];
            float inR = interleavedBuffer[i * 2 + 1];

            // BPF фильтрация
            float sibilantL = b0 * inL + b1 * bpX1L + b2 * bpX2L - a1 * bpY1L - a2 * bpY2L;
            bpX2L = bpX1L; bpX1L = inL; bpY2L = bpY1L; bpY1L = sibilantL;

            float sibilantR = b0 * inR + b1 * bpX1R + b2 * bpX2R - a1 * bpY1R - a2 * bpY2R;
            bpX2R = bpX1R; bpX1R = inR; bpY2R = bpY1R; bpY1R = sibilantR;

            float essLevel = std::max(std::abs(sibilantL), std::abs(sibilantR));
            essEnvelope = (essLevel > essEnvelope)
                ? attackCoeff * essEnvelope + (1.0f - attackCoeff) * essLevel
                : releaseCoeff * essEnvelope + (1.0f - releaseCoeff) * essLevel;

            float essDb = gainToDb(essEnvelope);
            float reductionDb = 0.0f;

            if (essDb > thresholdDb) {
                reductionDb = (essDb - thresholdDb) * (1.0f - 1.0f / ratio);
                reductionDb = std::min(18.0f, reductionDb); // Ограничение глубины 18 dB
            }

            currentGainReductionDb = reductionDb;
            float gainFactor = dbToGain(-reductionDb);

            interleavedBuffer[i * 2] *= gainFactor;
            interleavedBuffer[i * 2 + 1] *= gainFactor;
        }
    }
};

/**
 * 6. SoftKneeCompressor - Студийный компрессор с мягким коленом (Soft Knee)
 */
class SoftKneeCompressor {
public:
    float thresholdDb{-18.0f};
    float ratio{3.5f};
    float attackMs{10.0f};
    float releaseMs{100.0f};
    float makeupGainDb{2.0f};
    float kneeDb{6.0f};
    float sampleRate{48000.0f};
    bool enabled{true};
    float currentGainReduction{1.0f};

    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float envelopeGain{1.0f};

    SoftKneeCompressor() {
        setup(48000.0f);
    }

    void setup(float sr) {
        sampleRate = sr;
        updateTimeConstants();
    }

    void reset() {
        envelopeGain = 1.0f;
        currentGainReduction = 1.0f;
    }

    void updateTimeConstants() {
        if (sampleRate <= 0.0f) return;
        attackCoeff = std::exp(-1.0f / (attackMs * 0.001f * sampleRate));
        releaseCoeff = std::exp(-1.0f / (releaseMs * 0.001f * sampleRate));
    }

    void processBuffer(float* interleavedBuffer, size_t numFrames) {
        if (!enabled || numFrames == 0) return;

        float makeupLin = dbToGain(makeupGainDb);
        float halfKnee = kneeDb * 0.5f;

        for (size_t i = 0; i < numFrames; ++i) {
            float inL = interleavedBuffer[i * 2];
            float inR = interleavedBuffer[i * 2 + 1];
            float inLevel = std::max(std::abs(inL), std::abs(inR));
            float inDb = gainToDb(inLevel);

            float gainReductionDb = 0.0f;

            if (inDb > thresholdDb + halfKnee) {
                gainReductionDb = (inDb - thresholdDb) * (1.0f - 1.0f / ratio);
            } else if (inDb > thresholdDb - halfKnee && kneeDb > 0.0f) {
                float x = inDb - thresholdDb + halfKnee;
                gainReductionDb = ((1.0f - 1.0f / ratio) * x * x) / (2.0f * kneeDb);
            }

            float targetGain = dbToGain(-gainReductionDb);

            envelopeGain = (targetGain < envelopeGain)
                ? attackCoeff * envelopeGain + (1.0f - attackCoeff) * targetGain
                : releaseCoeff * envelopeGain + (1.0f - releaseCoeff) * targetGain;

            currentGainReduction = envelopeGain;
            float finalGain = envelopeGain * makeupLin;

            interleavedBuffer[i * 2] *= finalGain;
            interleavedBuffer[i * 2 + 1] *= finalGain;
        }
    }
};

/**
 * 7. AutoDucker - Сайдчейн-дакер (автоматическое приглушение музыки при речи)
 */
class AutoDucker {
public:
    float thresholdDb{-30.0f};  // Порог срабатывания детектора речи (-50 .. -10 dB)
    float duckDepthDb{-12.0f};   // Величина приглушения фонограммы (-24 .. -3 dB)
    float attackMs{15.0f};       // Скорость затухания музыки при начале речи (5 .. 50 ms)
    float releaseMs{350.0f};     // Время восстановления громкости музыки (100 .. 1000 ms)
    float sampleRate{48000.0f};
    bool enabled{false};
    uint32_t sourceTrackId{0};   // ID дорожки-источника (диктор / вокал)
    float currentDuckingGain{1.0f};

    float attackCoeff{0.0f};
    float releaseCoeff{0.0f};
    float envelope{1.0f};

    AutoDucker() {
        setup(48000.0f);
    }

    void setup(float sr) {
        sampleRate = sr;
        updateConstants();
    }

    void reset() {
        envelope = 1.0f;
        currentDuckingGain = 1.0f;
    }

    void updateConstants() {
        if (sampleRate <= 0.0f) return;
        attackCoeff = std::exp(-1.0f / (attackMs * 0.001f * sampleRate));
        releaseCoeff = std::exp(-1.0f / (releaseMs * 0.001f * sampleRate));
    }

    void processBufferWithSidechain(float* interleavedBuffer, const float* sidechainMono, size_t numFrames) {
        if (!enabled || numFrames == 0) return;

        float targetDuckLin = dbToGain(duckDepthDb);

        for (size_t i = 0; i < numFrames; ++i) {
            float scLevel = (sidechainMono != nullptr) ? std::abs(sidechainMono[i]) : 0.0f;
            float scDb = gainToDb(scLevel);

            float targetGain = 1.0f;
            if (scDb > thresholdDb) {
                float over = scDb - thresholdDb;
                float reductionDb = std::min(std::abs(duckDepthDb), over * 0.8f);
                targetGain = dbToGain(-reductionDb);
            }

            envelope = (targetGain < envelope)
                ? attackCoeff * envelope + (1.0f - attackCoeff) * targetGain
                : releaseCoeff * envelope + (1.0f - releaseCoeff) * targetGain;

            currentDuckingGain = envelope;

            interleavedBuffer[i * 2] *= envelope;
            interleavedBuffer[i * 2 + 1] *= envelope;
        }
    }
};

/**
 * 8. SoftLimiter - Мастер-лимитер с мягким насыщением tanh (True Peak Guard)
 */
class SoftLimiter {
public:
    float ceilingDb{-0.1f};
    bool enabled{true};

    SoftLimiter() = default;

    void processBuffer(float* interleavedBuffer, size_t numFrames) {
        if (!enabled || numFrames == 0) return;

        float ceilingLin = dbToGain(ceilingDb);
        float threshold = ceilingLin * 0.85f;

        for (size_t i = 0; i < numFrames * 2; ++i) {
            float s = interleavedBuffer[i];
            float absS = std::abs(s);

            if (absS > threshold) {
                float sign = (s >= 0.0f) ? 1.0f : -1.0f;
                float over = absS - threshold;
                float headRoom = ceilingLin - threshold;
                float comp = threshold + headRoom * std::tanh(over / (headRoom + 1e-6f));
                s = sign * comp;
            }

            interleavedBuffer[i] = clampFloat(s, -1.0f, 1.0f);
        }
    }
};

// ============================================================================
// 3. ДОРОЖКА (TRACK) С ПОЛНОЙ ЦЕПОЧКОЙ VOCAL RACK DSP
// ============================================================================

class Track {
public:
    uint32_t id{0};
    std::string name{"Audio Track"};
    float volumeDb{0.0f};
    float pan{0.0f};
    bool solo{false};
    bool mute{false};

    std::vector<Clip> clips;

    // Стек DSP вокальной цепочки (Vocal Rack)
    DeClicker deClicker;
    DePlosive dePlosive;
    NoiseGate noiseGate;
    ParametricEQ3Band eq;
    DeEsser deEsser;
    SoftKneeCompressor compressor;
    AutoDucker autoDucker;

    // Временный буфер для обработки дорожки
    std::array<float, MAX_BUFFER_SIZE * 2> trackBuffer{};

    Track(uint32_t trackId, const std::string& trackName)
        : id(trackId), name(trackName) {
        clips.reserve(MAX_CLIPS_PER_TRACK);
    }

    void addClip(const Clip& clip) {
        clips.push_back(clip);
    }

    void clearClips() {
        clips.clear();
    }

    void setupSampleRate(float sr) {
        dePlosive.setup(sr);
        noiseGate.setup(sr);
        eq.updateAll(sr);
        deEsser.setup(sr);
        compressor.setup(sr);
        autoDucker.setup(sr);
    }

    void resetDsp() {
        deClicker.reset();
        dePlosive.reset();
        noiseGate.reset();
        eq.reset();
        deEsser.reset();
        compressor.reset();
        autoDucker.reset();
    }

    /**
     * Рендеринг звуковых клипов дорожки в локальный буфер на текущем таймлайне
     */
    void renderClipsToBuffer(size_t timelinePosition, size_t numFrames) {
        std::fill(trackBuffer.begin(), trackBuffer.begin() + numFrames * 2, 0.0f);

        for (const auto& clip : clips) {
            if (!clip.active || clip.sampleBuffer == nullptr) continue;

            size_t clipStart = clip.offsetSamples;
            size_t clipEnd = clip.offsetSamples + clip.lengthSamples;

            size_t blockStart = timelinePosition;
            size_t blockEnd = timelinePosition + numFrames;

            // Проверка пересечения блока рендера с клипом
            if (blockEnd <= clipStart || blockStart >= clipEnd) {
                continue;
            }

            size_t renderStart = std::max(blockStart, clipStart);
            size_t renderEnd = std::min(blockEnd, clipEnd);

            size_t framesToRender = renderEnd - renderStart;
            size_t bufferOffset = renderStart - blockStart;
            size_t clipSampleOffset = renderStart - clipStart;

            float clipGain = clip.gain;
            float clipPanL = std::cos((clip.pan + 1.0f) * 0.25f * PI_F);
            float clipPanR = std::sin((clip.pan + 1.0f) * 0.25f * PI_F);

            if (clip.isStereo) {
                for (size_t i = 0; i < framesToRender; ++i) {
                    size_t sIdx = clipSampleOffset + i;
                    if (sIdx < clip.bufferSizeSamples) {
                        float fade = clip.getFadeGain(sIdx);
                        float inL = clip.sampleBuffer[sIdx * 2] * clipGain * fade;
                        float inR = clip.sampleBuffer[sIdx * 2 + 1] * clipGain * fade;

                        trackBuffer[(bufferOffset + i) * 2] += inL * clipPanL;
                        trackBuffer[(bufferOffset + i) * 2 + 1] += inR * clipPanR;
                    }
                }
            } else {
                for (size_t i = 0; i < framesToRender; ++i) {
                    size_t sIdx = clipSampleOffset + i;
                    if (sIdx < clip.bufferSizeSamples) {
                        float fade = clip.getFadeGain(sIdx);
                        float mono = clip.sampleBuffer[sIdx] * clipGain * fade;

                        trackBuffer[(bufferOffset + i) * 2] += mono * clipPanL;
                        trackBuffer[(bufferOffset + i) * 2 + 1] += mono * clipPanR;
                    }
                }
            }
        }
    }

    /**
     * Прогон через полную вокальную цепочку Vocal Rack
     */
    void processVocalRack(const float* sidechainMono, size_t numFrames) {
        if (numFrames == 0) return;

        // 1. DeClicker
        deClicker.processBuffer(trackBuffer.data(), numFrames);

        // 2. DePlosive
        dePlosive.processBuffer(trackBuffer.data(), numFrames);

        // 3. NoiseGate
        noiseGate.processBuffer(trackBuffer.data(), numFrames);

        // 4. ParametricEQ3Band
        eq.processBuffer(trackBuffer.data(), numFrames);

        // 5. DeEsser
        deEsser.processBuffer(trackBuffer.data(), numFrames);

        // 6. Compressor
        compressor.processBuffer(trackBuffer.data(), numFrames);

        // 7. AutoDucker (Sidechain)
        if (autoDucker.enabled) {
            autoDucker.processBufferWithSidechain(trackBuffer.data(), sidechainMono, numFrames);
        }

        // 8. Track Fader & Pan
        float trackGain = dbToGain(volumeDb);
        float trackPanL = std::cos((pan + 1.0f) * 0.25f * PI_F) * trackGain;
        float trackPanR = std::sin((pan + 1.0f) * 0.25f * PI_F) * trackGain;

        for (size_t i = 0; i < numFrames; ++i) {
            trackBuffer[i * 2] *= trackPanL;
            trackBuffer[i * 2 + 1] *= trackPanR;
        }
    }
};

// ============================================================================
// 4. СТРУКТУРЫ И СЕРВИСЫ ВЫЧИСЛЕНИЙ (LOUDNESS, RESAMPLER, WAV PACKER)
// ============================================================================

/**
 * Результат статистического анализа громкости (LoudnessStats)
 */
struct LoudnessStats {
    float peakLinear{0.0f};
    float peakDb{MIN_DB};
    float rmsLinear{0.0f};
    float rmsDb{MIN_DB};
    float gainDeltaToTargetDb{0.0f};
    bool isClipping{false};
    size_t numSamples{0};
};

/**
 * 1. LoudnessAnalyzer - Быстрый SIMD/Scalar расчет True Peak, RMS и Loudness Match
 */
class LoudnessAnalyzer {
public:
    static LoudnessStats calculateLoudnessStats(
        const float* buffer,
        size_t numSamples,
        int channels = 2,
        float targetRmsDb = -18.0f,
        float maxPeakDb = -1.0f
    ) {
        LoudnessStats stats;
        if (!buffer || numSamples == 0) {
            return stats;
        }

        stats.numSamples = numSamples;
        float sumSquares = 0.0f;
        float maxPeak = 0.0f;

        size_t totalValues = numSamples * static_cast<size_t>(channels);
        size_t i = 0;

#if USE_WASM_SIMD
        // Векторизация под WASM SIMD128: 4 float за такт
        v128_t vSum = wasm_f32x4_splat(0.0f);
        v128_t vMax = wasm_f32x4_splat(0.0f);

        for (; i + 4 <= totalValues; i += 4) {
            v128_t vSamples = wasm_v128_load(&buffer[i]);
            v128_t vAbs = wasm_f32x4_abs(vSamples);
            vMax = wasm_f32x4_max(vMax, vAbs);
            vSum = wasm_f32x4_add(vSum, wasm_f32x4_mul(vSamples, vSamples));
        }

        // Горизонтальное сложение
        alignas(16) float sumArr[4];
        alignas(16) float maxArr[4];
        wasm_v128_store(sumArr, vSum);
        wasm_v128_store(maxArr, vMax);

        sumSquares = sumArr[0] + sumArr[1] + sumArr[2] + sumArr[3];
        maxPeak = std::max({maxArr[0], maxArr[1], maxArr[2], maxArr[3]});
#endif

        // Скалярная обработка остатка
        for (; i < totalValues; ++i) {
            float s = buffer[i];
            float absS = std::abs(s);
            if (absS > maxPeak) maxPeak = absS;
            sumSquares += s * s;
        }

        stats.peakLinear = maxPeak;
        stats.peakDb = gainToDb(maxPeak);

        if (totalValues > 0) {
            stats.rmsLinear = std::sqrt(sumSquares / static_cast<float>(totalValues));
            stats.rmsDb = gainToDb(stats.rmsLinear);
        }

        stats.isClipping = (maxPeak >= 0.9999f || stats.peakDb >= -0.01f);

        // Расчет дельты усиления для Loudness Matching
        float requiredGainDb = targetRmsDb - stats.rmsDb;
        float projectedPeak = stats.peakDb + requiredGainDb;

        // Защита от пикового клиппинга (Peak Guard)
        if (projectedPeak > maxPeakDb) {
            requiredGainDb = maxPeakDb - stats.peakDb;
        }

        stats.gainDeltaToTargetDb = clampFloat(requiredGainDb, -36.0f, 18.0f);
        return stats;
    }
};

/**
 * 2. AudioResampler - Высокоточный кубический Catmull-Rom Hermite ресэмплинг в 48 000 Hz
 */
class AudioResampler {
public:
    static inline float catmullRom(float p0, float p1, float p2, float p3, float t) {
        float c0 = p1;
        float c1 = 0.5f * (p2 - p0);
        float c2 = p0 - 2.5f * p1 + 2.0f * p2 - 0.5f * p3;
        float c3 = 0.5f * (p3 - p0) + 1.5f * (p1 - p2);
        return ((c3 * t + c2) * t + c1) * t + c0;
    }

    /**
     * Ресэмплинг Float32 массива в эталонные 48 000 Hz
     * Поддерживает Mono (channels=1) и Interleaved Stereo (channels=2).
     */
    static size_t resampleTo48k(
        const float* input,
        size_t inFrames,
        int inRate,
        float* output,
        size_t outCapacityFrames,
        int channels = 2
    ) {
        if (!input || !output || inFrames == 0 || inRate <= 0 || outCapacityFrames == 0) {
            return 0;
        }

        double ratio = TARGET_SAMPLE_RATE / static_cast<double>(inRate);
        size_t expectedOutFrames = static_cast<size_t>(std::ceil(inFrames * ratio));
        size_t outFrames = std::min(expectedOutFrames, outCapacityFrames);

        double step = static_cast<double>(inRate) / TARGET_SAMPLE_RATE;

        for (size_t ch = 0; ch < static_cast<size_t>(channels); ++ch) {
            for (size_t outIdx = 0; outIdx < outFrames; ++outIdx) {
                double srcPos = outIdx * step;
                int64_t idx1 = static_cast<int64_t>(std::floor(srcPos));
                float t = static_cast<float>(srcPos - idx1);

                int64_t idx0 = std::max<int64_t>(0, idx1 - 1);
                int64_t idx2 = std::min<int64_t>(static_cast<int64_t>(inFrames) - 1, idx1 + 1);
                int64_t idx3 = std::min<int64_t>(static_cast<int64_t>(inFrames) - 1, idx1 + 2);

                idx1 = std::min<int64_t>(static_cast<int64_t>(inFrames) - 1, idx1);

                float p0 = input[idx0 * channels + ch];
                float p1 = input[idx1 * channels + ch];
                float p2 = input[idx2 * channels + ch];
                float p3 = input[idx3 * channels + ch];

                float interpolated = catmullRom(p0, p1, p2, p3, t);

                if (channels == 1) {
                    // Моно вход -> дублируем в стерео выход
                    output[outIdx * 2] = interpolated;
                    output[outIdx * 2 + 1] = interpolated;
                } else {
                    output[outIdx * channels + ch] = interpolated;
                }
            }
        }

        return outFrames;
    }
};

/**
 * 3. NativeWavPacker - Бинарная упаковка RIFF/WAVE без накладных расходов JS
 */
class NativeWavPacker {
public:
    /**
     * Формирование канонического WAV файла в памяти C++
     * BitDepth: 16 (PCM 16-bit), 24 (PCM 24-bit), 32 (IEEE Float 32-bit)
     * Возвращает общий размер WAV файла в байтах.
     */
    static size_t packWav(
        const float* interleavedBuffer,
        size_t numFrames,
        int bitDepth,
        uint8_t* outWavBuffer,
        size_t maxOutBytes,
        int sampleRate = 48000
    ) {
        if (!interleavedBuffer || !outWavBuffer || numFrames == 0) return 0;

        uint16_t numChannels = 2;
        uint16_t bytesPerSample = static_cast<uint16_t>(bitDepth / 8);
        uint32_t dataBytes = static_cast<uint32_t>(numFrames * numChannels * bytesPerSample);
        uint32_t totalFileSize = 44 + dataBytes;

        if (totalFileSize > maxOutBytes) {
            return 0; // Переполнение буфера
        }

        uint16_t audioFormat = (bitDepth == 32) ? 3 : 1; // 1 = PCM, 3 = IEEE Float
        uint32_t byteRate = sampleRate * numChannels * bytesPerSample;
        uint16_t blockAlign = numChannels * bytesPerSample;

        // Запись RIFF Заголовка (44 байта)
        std::memcpy(outWavBuffer, "RIFF", 4);
        uint32_t chunkSize = 36 + dataBytes;
        std::memcpy(outWavBuffer + 4, &chunkSize, 4);
        std::memcpy(outWavBuffer + 8, "WAVE", 4);

        // Чанк "fmt "
        std::memcpy(outWavBuffer + 12, "fmt ", 4);
        uint32_t subchunk1Size = 16;
        std::memcpy(outWavBuffer + 16, &subchunk1Size, 4);
        std::memcpy(outWavBuffer + 20, &audioFormat, 2);
        std::memcpy(outWavBuffer + 22, &numChannels, 2);
        std::memcpy(outWavBuffer + 24, &sampleRate, 4);
        std::memcpy(outWavBuffer + 28, &byteRate, 4);
        std::memcpy(outWavBuffer + 32, &blockAlign, 2);
        uint16_t bitsPerSample = static_cast<uint16_t>(bitDepth);
        std::memcpy(outWavBuffer + 34, &bitsPerSample, 2);

        // Чанк "data"
        std::memcpy(outWavBuffer + 36, "data", 4);
        std::memcpy(outWavBuffer + 40, &dataBytes, 4);

        uint8_t* dataPtr = outWavBuffer + 44;
        size_t totalSamples = numFrames * numChannels;

        if (bitDepth == 16) {
            int16_t* pcm16 = reinterpret_cast<int16_t*>(dataPtr);
            for (size_t i = 0; i < totalSamples; ++i) {
                float s = clampFloat(interleavedBuffer[i], -1.0f, 1.0f);
                pcm16[i] = static_cast<int16_t>(s * 32767.0f);
            }
        } else if (bitDepth == 24) {
            size_t byteIdx = 0;
            for (size_t i = 0; i < totalSamples; ++i) {
                float s = clampFloat(interleavedBuffer[i], -1.0f, 1.0f);
                int32_t val24 = static_cast<int32_t>(s * 8388607.0f);
                dataPtr[byteIdx++] = static_cast<uint8_t>(val24 & 0xFF);
                dataPtr[byteIdx++] = static_cast<uint8_t>((val24 >> 8) & 0xFF);
                dataPtr[byteIdx++] = static_cast<uint8_t>((val24 >> 16) & 0xFF);
            }
        } else if (bitDepth == 32) {
            std::memcpy(dataPtr, interleavedBuffer, dataBytes);
        }

        return totalFileSize;
    }
};

// ============================================================================
// 5. МИКШЕР ПРОЕКТА И BATCH OFFLINE RENDERER (MIXER)
// ============================================================================

class Mixer {
public:
    float sampleRate{48000.0f};
    float masterVolumeDb{0.0f};
    float masterPan{0.0f};
    size_t currentTimelineSample{0};

    std::vector<std::unique_ptr<Track>> tracks;
    SoftLimiter masterLimiter;

    // Статические кольцевые буферы для сайдчейн сигналов
    std::array<float, MAX_BUFFER_SIZE> sidechainAccumulator{};
    std::array<float, MAX_BUFFER_SIZE * 2> blockBuffer{};

    Mixer(float sr = 48000.0f) : sampleRate(sr) {
        tracks.reserve(MAX_TRACKS);
    }

    void setSampleRate(float sr) {
        sampleRate = sr;
        for (auto& track : tracks) {
            track->setupSampleRate(sr);
        }
    }

    Track* addTrack(uint32_t id, const std::string& name) {
        auto track = std::make_unique<Track>(id, name);
        track->setupSampleRate(sampleRate);
        Track* rawPtr = track.get();
        tracks.push_back(std::move(track));
        return rawPtr;
    }

    Track* getTrack(uint32_t id) {
        for (auto& track : tracks) {
            if (track->id == id) return track.get();
        }
        return nullptr;
    }

    void removeAllTracks() {
        tracks.clear();
    }

    void setTimelinePosition(size_t pos) {
        currentTimelineSample = pos;
    }

    /**
     * Потоковая обработка блока в реальном времени (AudioWorklet callback)
     */
    void processBlock(float* outInterleavedBuffer, size_t numFrames) {
        if (!outInterleavedBuffer || numFrames == 0) return;

        std::fill(outInterleavedBuffer, outInterleavedBuffer + numFrames * 2, 0.0f);
        bool hasSolo = std::any_of(tracks.begin(), tracks.end(), [](const auto& t) {
            return t->solo && !t->mute;
        });

        // 1. Рендеринг клипов каждой дорожки
        for (auto& track : tracks) {
            track->renderClipsToBuffer(currentTimelineSample, numFrames);
        }

        // 2. Расчет сайдчейн-источников
        for (auto& targetTrack : tracks) {
            if ((hasSolo && !targetTrack->solo) || targetTrack->mute) continue;

            const float* scPtr = nullptr;
            if (targetTrack->autoDucker.enabled && targetTrack->autoDucker.sourceTrackId > 0) {
                Track* scTrack = getTrack(targetTrack->autoDucker.sourceTrackId);
                if (scTrack) {
                    // Конвертируем стерео буфер источника в моно детектор
                    for (size_t i = 0; i < numFrames; ++i) {
                        sidechainAccumulator[i] = 0.5f * (scTrack->trackBuffer[i * 2] + scTrack->trackBuffer[i * 2 + 1]);
                    }
                    scPtr = sidechainAccumulator.data();
                }
            }

            // Прогон вокального рэка
            targetTrack->processVocalRack(scPtr, numFrames);

            // Суммирование в мастер-шину
            for (size_t i = 0; i < numFrames * 2; ++i) {
                outInterleavedBuffer[i] += targetTrack->trackBuffer[i];
            }
        }

        // 3. Мастер-секция (Fader, Pan, Limiter)
        float mstGain = dbToGain(masterVolumeDb);
        float mstPanL = std::cos((masterPan + 1.0f) * 0.25f * PI_F) * mstGain;
        float mstPanR = std::sin((masterPan + 1.0f) * 0.25f * PI_F) * mstGain;

        for (size_t i = 0; i < numFrames; ++i) {
            outInterleavedBuffer[i * 2] *= mstPanL;
            outInterleavedBuffer[i * 2 + 1] *= mstPanR;
        }

        masterLimiter.processBuffer(outInterleavedBuffer, numFrames);
        currentTimelineSample += numFrames;
    }

    /**
     * Высокоскоростное пакетное офлайн-сведение всего проекта или одного стема (Stem)
     * Если isolateTrackId >= 0, рендерится изолированная дорожка с эффектами.
     */
    size_t renderProjectOffline(
        float* outInterleavedBuffer,
        size_t maxFrames,
        int isolateTrackId = -1
    ) {
        if (!outInterleavedBuffer || maxFrames == 0) return 0;

        // Определение длины проекта по клипам
        size_t totalProjectFrames = 0;
        for (const auto& track : tracks) {
            for (const auto& clip : track->clips) {
                size_t endFrame = clip.offsetSamples + clip.lengthSamples;
                if (endFrame > totalProjectFrames) {
                    totalProjectFrames = endFrame;
                }
            }
        }

        size_t framesToRender = std::min(maxFrames, std::max(totalProjectFrames, static_cast<size_t>(sampleRate * 2)));
        size_t savedTimelinePos = currentTimelineSample;
        currentTimelineSample = 0;

        // Сброс DSP состояний
        for (auto& track : tracks) {
            track->resetDsp();
        }

        constexpr size_t BLOCK_SIZE = 2048;
        size_t renderedFrames = 0;

        while (renderedFrames < framesToRender) {
            size_t currentBlock = std::min(BLOCK_SIZE, framesToRender - renderedFrames);
            float* blockOutput = outInterleavedBuffer + (renderedFrames * 2);

            if (isolateTrackId >= 0) {
                // Изолированный рендеринг одного стема
                std::fill(blockOutput, blockOutput + currentBlock * 2, 0.0f);
                Track* targetTrack = getTrack(static_cast<uint32_t>(isolateTrackId));
                if (targetTrack) {
                    targetTrack->renderClipsToBuffer(currentTimelineSample, currentBlock);
                    targetTrack->processVocalRack(nullptr, currentBlock);
                    std::memcpy(blockOutput, targetTrack->trackBuffer.data(), currentBlock * 2 * sizeof(float));
                }
                currentTimelineSample += currentBlock;
            } else {
                // Полный мастер-микс
                processBlock(blockOutput, currentBlock);
            }

            renderedFrames += currentBlock;
        }

        currentTimelineSample = savedTimelinePos;
        return renderedFrames;
    }

    /**
     * Быстрое авто-выравнивание громкости по всем дорожкам микшера (Loudness Matching)
     * Выполняется за один C++ вызов с анализом True Peak и RMS.
     */
    void autoMatchAllTracks(float targetRmsDb = -18.0f, float maxPeakDb = -1.0f) {
        for (auto& track : tracks) {
            if (track->clips.empty()) continue;

            // Находим самый длинный или главный аудиоклип дорожки для замера
            const Clip* mainClip = nullptr;
            size_t maxLen = 0;
            for (const auto& clip : track->clips) {
                if (clip.sampleBuffer != nullptr && clip.lengthSamples > maxLen) {
                    maxLen = clip.lengthSamples;
                    mainClip = &clip;
                }
            }

            if (mainClip && mainClip->sampleBuffer && maxLen > 0) {
                int channels = mainClip->isStereo ? 2 : 1;
                LoudnessStats stats = LoudnessAnalyzer::calculateLoudnessStats(
                    mainClip->sampleBuffer,
                    maxLen,
                    channels,
                    targetRmsDb,
                    maxPeakDb
                );

                if (stats.rmsDb > MIN_DB + 10.0f) {
                    float newVolume = clampFloat(track->volumeDb + stats.gainDeltaToTargetDb, -48.0f, 12.0f);
                    track->volumeDb = std::round(newVolume * 10.0f) / 10.0f;
                }
            }
        }
    }
};

} // namespace DAWCore

// ============================================================================
// 6. EMSCRIPTEN EMBIND ЭКСПОРТ И УПРАВЛЕНИЕ ПАМЯТЬЮ
// ============================================================================

#ifdef __EMSCRIPTEN__
using namespace emscripten;
using namespace DAWCore;

// Функции аллокации памяти для прямого доступа из JavaScript Heap (Float32Array / Uint8Array)
static uintptr_t JS_AllocateAudioBuffer(size_t numFloats) {
    float* ptr = new float[numFloats]();
    return reinterpret_cast<uintptr_t>(ptr);
}

static void JS_FreeAudioBuffer(uintptr_t ptr) {
    float* fPtr = reinterpret_cast<float*>(ptr);
    delete[] fPtr;
}

static uintptr_t JS_AllocateByteBuffer(size_t numBytes) {
    uint8_t* ptr = new uint8_t[numBytes]();
    return reinterpret_cast<uintptr_t>(ptr);
}

static void JS_FreeByteBuffer(uintptr_t ptr) {
    uint8_t* bPtr = reinterpret_cast<uint8_t*>(ptr);
    delete[] bPtr;
}

// Привязка клипа к дорожке
static bool JS_AddClipToTrack(
    Mixer& mixer,
    uint32_t trackId,
    uint32_t clipId,
    uintptr_t bufferPtr,
    size_t bufferSizeSamples,
    size_t offsetSamples,
    size_t lengthSamples,
    float gain,
    float pan,
    size_t fadeIn,
    size_t fadeOut,
    bool isStereo
) {
    Track* track = mixer.getTrack(trackId);
    if (!track) return false;

    Clip clip;
    clip.id = clipId;
    clip.sampleBuffer = reinterpret_cast<const float*>(bufferPtr);
    clip.bufferSizeSamples = bufferSizeSamples;
    clip.offsetSamples = offsetSamples;
    clip.lengthSamples = lengthSamples;
    clip.gain = gain;
    clip.pan = pan;
    clip.fadeInSamples = fadeIn;
    clip.fadeOutSamples = fadeOut;
    clip.isStereo = isStereo;
    clip.active = true;

    track->addClip(clip);
    return true;
}

// Потоковая обработка блока микшера
static void JS_ProcessMixer(Mixer& mixer, uintptr_t outputPtr, int numSamples) {
    float* outBuf = reinterpret_cast<float*>(outputPtr);
    mixer.processBlock(outBuf, static_cast<size_t>(numSamples));
}

// Офлайн-рендеринг проекта / стемов
static size_t JS_RenderProjectOffline(Mixer& mixer, uintptr_t outPtr, int maxFrames, int isolateTrackId) {
    float* outBuf = reinterpret_cast<float*>(outPtr);
    return mixer.renderProjectOffline(outBuf, static_cast<size_t>(maxFrames), isolateTrackId);
}

// Анализ громкости и статистики
static LoudnessStats JS_CalculateLoudnessStats(
    uintptr_t bufferPtr,
    int numSamples,
    int channels,
    float targetRmsDb,
    float maxPeakDb
) {
    const float* buf = reinterpret_cast<const float*>(bufferPtr);
    return LoudnessAnalyzer::calculateLoudnessStats(
        buf,
        static_cast<size_t>(numSamples),
        channels,
        targetRmsDb,
        maxPeakDb
    );
}

// Кубический ресэмплинг в 48 000 Hz
static size_t JS_ResampleTo48k(
    uintptr_t inPtr,
    int inFrames,
    int inRate,
    uintptr_t outPtr,
    int outCapacityFrames,
    int channels
) {
    const float* inBuf = reinterpret_cast<const float*>(inPtr);
    float* outBuf = reinterpret_cast<float*>(outPtr);
    return AudioResampler::resampleTo48k(
        inBuf,
        static_cast<size_t>(inFrames),
        inRate,
        outBuf,
        static_cast<size_t>(outCapacityFrames),
        channels
    );
}

// Нативная упаковка WAV
static size_t JS_PackWav(
    uintptr_t inFloatPtr,
    int numFrames,
    int bitDepth,
    uintptr_t outBytePtr,
    int maxOutBytes,
    int sampleRate
) {
    const float* inBuf = reinterpret_cast<const float*>(inFloatPtr);
    uint8_t* outBuf = reinterpret_cast<uint8_t*>(outBytePtr);
    return NativeWavPacker::packWav(
        inBuf,
        static_cast<size_t>(numFrames),
        bitDepth,
        outBuf,
        static_cast<size_t>(maxOutBytes),
        sampleRate
    );
}

EMSCRIPTEN_BINDINGS(daw_core_module) {
    enum_<BiquadFilterType>("BiquadFilterType")
        .value("LowShelf", BiquadFilterType::LowShelf)
        .value("Peaking", BiquadFilterType::Peaking)
        .value("HighShelf", BiquadFilterType::HighShelf);

    enum_<GateState>("GateState")
        .value("Closed", GateState::Closed)
        .value("Opening", GateState::Opening)
        .value("Open", GateState::Open)
        .value("Holding", GateState::Holding)
        .value("Closing", GateState::Closing);

    // LoudnessStats
    value_object<LoudnessStats>("LoudnessStats")
        .field("peakLinear", &LoudnessStats::peakLinear)
        .field("peakDb", &LoudnessStats::peakDb)
        .field("rmsLinear", &LoudnessStats::rmsLinear)
        .field("rmsDb", &LoudnessStats::rmsDb)
        .field("gainDeltaToTargetDb", &LoudnessStats::gainDeltaToTargetDb)
        .field("isClipping", &LoudnessStats::isClipping)
        .field("numSamples", &LoudnessStats::numSamples);

    // DeClicker
    class_<DeClicker>("DeClicker")
        .constructor<>()
        .property("threshold", &DeClicker::threshold)
        .property("repairWindow", &DeClicker::repairWindow)
        .property("enabled", &DeClicker::enabled)
        .property("clicksDetected", &DeClicker::clicksDetected)
        .function("reset", &DeClicker::reset);

    // DePlosive
    class_<DePlosive>("DePlosive")
        .constructor<>()
        .property("thresholdDb", &DePlosive::thresholdDb)
        .property("frequency", &DePlosive::frequency)
        .property("attackMs", &DePlosive::attackMs)
        .property("releaseMs", &DePlosive::releaseMs)
        .property("enabled", &DePlosive::enabled)
        .property("currentReduction", &DePlosive::currentReduction)
        .function("updateCoefficients", &DePlosive::updateCoefficients)
        .function("reset", &DePlosive::reset);

    // NoiseGate
    class_<NoiseGate>("NoiseGate")
        .constructor<>()
        .property("thresholdDb", &NoiseGate::thresholdDb)
        .property("attackMs", &NoiseGate::attackMs)
        .property("holdMs", &NoiseGate::holdMs)
        .property("releaseMs", &NoiseGate::releaseMs)
        .property("floorDb", &NoiseGate::floorDb)
        .property("enabled", &NoiseGate::enabled)
        .property("currentGain", &NoiseGate::currentGain)
        .function("updateConstants", &NoiseGate::updateConstants)
        .function("reset", &NoiseGate::reset);

    // BiquadFilter
    class_<BiquadFilter>("BiquadFilter")
        .constructor<>()
        .property("type", &BiquadFilter::type)
        .property("frequency", &BiquadFilter::frequency)
        .property("gainDb", &BiquadFilter::gainDb)
        .property("Q", &BiquadFilter::Q)
        .property("enabled", &BiquadFilter::enabled)
        .function("updateCoefficients", &BiquadFilter::updateCoefficients)
        .function("resetState", &BiquadFilter::resetState);

    // ParametricEQ3Band
    class_<ParametricEQ3Band>("ParametricEQ3Band")
        .constructor<>()
        .property("enabled", &ParametricEQ3Band::enabled)
        .property("lowShelf", &ParametricEQ3Band::lowShelf)
        .property("peaking", &ParametricEQ3Band::peaking)
        .property("highShelf", &ParametricEQ3Band::highShelf)
        .function("updateAll", &ParametricEQ3Band::updateAll)
        .function("reset", &ParametricEQ3Band::reset);

    // DeEsser
    class_<DeEsser>("DeEsser")
        .constructor<>()
        .property("thresholdDb", &DeEsser::thresholdDb)
        .property("frequency", &DeEsser::frequency)
        .property("ratio", &DeEsser::ratio)
        .property("attackMs", &DeEsser::attackMs)
        .property("releaseMs", &DeEsser::releaseMs)
        .property("enabled", &DeEsser::enabled)
        .property("currentGainReductionDb", &DeEsser::currentGainReductionDb)
        .function("updateCoefficients", &DeEsser::updateCoefficients)
        .function("reset", &DeEsser::reset);

    // SoftKneeCompressor
    class_<SoftKneeCompressor>("SoftKneeCompressor")
        .constructor<>()
        .property("thresholdDb", &SoftKneeCompressor::thresholdDb)
        .property("ratio", &SoftKneeCompressor::ratio)
        .property("attackMs", &SoftKneeCompressor::attackMs)
        .property("releaseMs", &SoftKneeCompressor::releaseMs)
        .property("makeupGainDb", &SoftKneeCompressor::makeupGainDb)
        .property("kneeDb", &SoftKneeCompressor::kneeDb)
        .property("enabled", &SoftKneeCompressor::enabled)
        .property("currentGainReduction", &SoftKneeCompressor::currentGainReduction)
        .function("updateTimeConstants", &SoftKneeCompressor::updateTimeConstants)
        .function("reset", &SoftKneeCompressor::reset);

    // AutoDucker
    class_<AutoDucker>("AutoDucker")
        .constructor<>()
        .property("thresholdDb", &AutoDucker::thresholdDb)
        .property("duckDepthDb", &AutoDucker::duckDepthDb)
        .property("attackMs", &AutoDucker::attackMs)
        .property("releaseMs", &AutoDucker::releaseMs)
        .property("enabled", &AutoDucker::enabled)
        .property("currentDuckingGain", &AutoDucker::currentDuckingGain)
        .function("updateConstants", &AutoDucker::updateConstants)
        .function("reset", &AutoDucker::reset);

    // SoftLimiter
    class_<SoftLimiter>("SoftLimiter")
        .constructor<>()
        .property("ceilingDb", &SoftLimiter::ceilingDb)
        .property("enabled", &SoftLimiter::enabled);

    // Clip
    value_object<Clip>("Clip")
        .field("id", &Clip::id)
        .field("bufferSizeSamples", &Clip::bufferSizeSamples)
        .field("offsetSamples", &Clip::offsetSamples)
        .field("lengthSamples", &Clip::lengthSamples)
        .field("gain", &Clip::gain)
        .field("pan", &Clip::pan)
        .field("fadeInSamples", &Clip::fadeInSamples)
        .field("fadeOutSamples", &Clip::fadeOutSamples)
        .field("isStereo", &Clip::isStereo)
        .field("active", &Clip::active);

    // Track
    class_<Track>("Track")
        .constructor<uint32_t, std::string>()
        .property("id", &Track::id)
        .property("name", &Track::name)
        .property("volumeDb", &Track::volumeDb)
        .property("pan", &Track::pan)
        .property("solo", &Track::solo)
        .property("mute", &Track::mute)
        .property("deClicker", &Track::deClicker)
        .property("dePlosive", &Track::dePlosive)
        .property("noiseGate", &Track::noiseGate)
        .property("eq", &Track::eq)
        .property("deEsser", &Track::deEsser)
        .property("compressor", &Track::compressor)
        .property("autoDucker", &Track::autoDucker)
        .function("clearClips", &Track::clearClips);

    // Mixer
    class_<Mixer>("Mixer")
        .constructor<float>()
        .property("sampleRate", &Mixer::sampleRate)
        .property("masterVolumeDb", &Mixer::masterVolumeDb)
        .property("masterPan", &Mixer::masterPan)
        .property("currentTimelineSample", &Mixer::currentTimelineSample)
        .property("masterLimiter", &Mixer::masterLimiter)
        .function("setSampleRate", &Mixer::setSampleRate)
        .function("addTrack", &Mixer::addTrack, allow_raw_pointers())
        .function("getTrack", &Mixer::getTrack, allow_raw_pointers())
        .function("removeAllTracks", &Mixer::removeAllTracks)
        .function("setTimelinePosition", &Mixer::setTimelinePosition)
        .function("processBlock", &Mixer::processBlock, allow_raw_pointers())
        .function("renderProjectOffline", &Mixer::renderProjectOffline, allow_raw_pointers())
        .function("autoMatchAllTracks", &Mixer::autoMatchAllTracks);

    // Глобальные экспортные функции для прямой работы из JS
    function("allocateAudioBuffer", &JS_AllocateAudioBuffer);
    function("freeAudioBuffer", &JS_FreeAudioBuffer);
    function("allocateByteBuffer", &JS_AllocateByteBuffer);
    function("freeByteBuffer", &JS_FreeByteBuffer);
    function("addClipToTrack", &JS_AddClipToTrack);
    function("processMixer", &JS_ProcessMixer);
    function("renderProjectOffline", &JS_RenderProjectOffline);
    function("calculateLoudnessStats", &JS_CalculateLoudnessStats);
    function("resampleTo48k", &JS_ResampleTo48k);
    function("packWav", &JS_PackWav);
}

#endif
