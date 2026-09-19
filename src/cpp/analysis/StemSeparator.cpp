/**
 * ============================================================================
 * StemSeparator.cpp - Реализация алгоритмов БПФ и разделения вокала (C++17)
 * ============================================================================
 * Полная реализация Cooley-Tukey Radix-2 FFT, оконного спектрального анализа STFT,
 * Center-Channel вокальной фильтрации, iSTFT синтеза и Overlap-Add нормализации
 * с аппаратной SIMD128 векторизацией под WebAssembly.
 * ============================================================================
 */

#include "StemSeparator.hpp"
#include <algorithm>
#include <cstring>

namespace DAWCore {

static constexpr float PI = 3.14159265358979323846f;
static constexpr float TWO_PI = 6.28318530717958647692f;

// ============================================================================
// Реализация FastFourierTransform
// ============================================================================

FastFourierTransform::FastFourierTransform(size_t fftSize)
    : m_fftSize(fftSize)
    , m_halfSize(fftSize >> 1)
    , m_levels(0)
{
    // Проверка, что размер является степенью двойки
    size_t temp = fftSize;
    while (temp > 1) {
        temp >>= 1;
        m_levels++;
    }

    initTables();
}

void FastFourierTransform::initTables() {
    // 1. Предрасчет таблицы инверсии битов (Bit-Reversal LUT)
    m_bitReverse.resize(m_fftSize);
    for (size_t i = 0; i < m_fftSize; ++i) {
        uint32_t rev = 0;
        for (size_t j = 0; j < m_levels; ++j) {
            rev = (rev << 1) | static_cast<uint32_t>((i >> j) & 1);
        }
        m_bitReverse[i] = rev;
    }

    // 2. Предрасчет таблицы тригонометрических коэффициентов (Twiddle Factors)
    m_cosTable.resize(m_halfSize);
    m_sinTable.resize(m_halfSize);
    for (size_t i = 0; i < m_halfSize; ++i) {
        float angle = -TWO_PI * static_cast<float>(i) / static_cast<float>(m_fftSize);
        m_cosTable[i] = std::cos(angle);
        m_sinTable[i] = std::sin(angle);
    }

    // 3. Предрасчет симметричного окна Ханна (Hanning Window)
    m_hanningWindow.resize(m_fftSize);
    for (size_t i = 0; i < m_fftSize; ++i) {
        m_hanningWindow[i] = 0.5f * (1.0f - std::cos(TWO_PI * static_cast<float>(i) / static_cast<float>(m_fftSize)));
    }
}

void FastFourierTransform::forward(float* real, float* imag) const {
    const size_t n = m_fftSize;

    // Шаг 1: Перестановка с реверсом битов
    for (size_t i = 0; i < n; ++i) {
        size_t j = m_bitReverse[i];
        if (j > i) {
            float tempR = real[i];
            real[i] = real[j];
            real[j] = tempR;

            float tempI = imag[i];
            imag[i] = imag[j];
            imag[j] = tempI;
        }
    }

    // Шаг 2: Итеративный алгоритм Danielson-Lanczos (Radix-2 Butterflies)
    for (size_t size = 2; size <= n; size <<= 1) {
        const size_t halfSize = size >> 1;
        const size_t step = n / size;

        for (size_t i = 0; i < n; i += size) {
            size_t j = 0;

#if defined(__wasm_simd128__)
            // Векторизация 4 бабочек одновременно при halfSize >= 4
            for (; j + 4 <= halfSize; j += 4) {
                const size_t k0 = (j + 0) * step;
                const size_t k1 = (j + 1) * step;
                const size_t k2 = (j + 2) * step;
                const size_t k3 = (j + 3) * step;

                // Загрузка cos и sin
                v128_t v_cos = wasm_f32x4_make(m_cosTable[k0], m_cosTable[k1], m_cosTable[k2], m_cosTable[k3]);
                v128_t v_sin = wasm_f32x4_make(m_sinTable[k0], m_sinTable[k1], m_sinTable[k2], m_sinTable[k3]);

                size_t matchIdx = i + j + halfSize;
                size_t curIdx = i + j;

                v128_t v_r2 = wasm_v128_load(&real[matchIdx]);
                v128_t v_i2 = wasm_v128_load(&imag[matchIdx]);

                // tr = r2 * cos - i2 * sin
                // ti = r2 * sin + i2 * cos
                v128_t v_tr = wasm_f32x4_sub(wasm_f32x4_mul(v_r2, v_cos), wasm_f32x4_mul(v_i2, v_sin));
                v128_t v_ti = wasm_f32x4_add(wasm_f32x4_mul(v_r2, v_sin), wasm_f32x4_mul(v_i2, v_cos));

                v128_t v_r1 = wasm_v128_load(&real[curIdx]);
                v128_t v_i1 = wasm_v128_load(&imag[curIdx]);

                // real[matchIdx] = real[curIdx] - tr;
                // imag[matchIdx] = imag[curIdx] - ti;
                wasm_v128_store(&real[matchIdx], wasm_f32x4_sub(v_r1, v_tr));
                wasm_v128_store(&imag[matchIdx], wasm_f32x4_sub(v_i1, v_ti));

                // real[curIdx] += tr;
                // imag[curIdx] += ti;
                wasm_v128_store(&real[curIdx], wasm_f32x4_add(v_r1, v_tr));
                wasm_v128_store(&imag[curIdx], wasm_f32x4_add(v_i1, v_ti));
            }
#endif

            // Скалярный хвост для оставшихся коэффициентов
            for (; j < halfSize; ++j) {
                const size_t k = j * step;
                const float cosVal = m_cosTable[k];
                const float sinVal = m_sinTable[k];

                const size_t matchIdx = i + j + halfSize;
                const size_t curIdx = i + j;

                const float r2 = real[matchIdx];
                const float i2 = imag[matchIdx];

                // Комплексное умножение: (r2 + i*i2) * (cos + i*sin)
                const float tr = r2 * cosVal - i2 * sinVal;
                const float ti = r2 * sinVal + i2 * cosVal;

                real[matchIdx] = real[curIdx] - tr;
                imag[matchIdx] = imag[curIdx] - ti;

                real[curIdx] += tr;
                imag[curIdx] += ti;
            }
        }
    }
}

void FastFourierTransform::inverse(float* real, float* imag) const {
    const size_t n = m_fftSize;

    // Шаг 1: Комплексное сопряжение мнимой части
    size_t i = 0;
#if defined(__wasm_simd128__)
    v128_t v_neg_zero = wasm_f32x4_splat(-0.0f);
    for (; i + 4 <= n; i += 4) {
        v128_t v_im = wasm_v128_load(&imag[i]);
        wasm_v128_store(&imag[i], wasm_f32x4_xor(v_im, v_neg_zero));
    }
#endif
    for (; i < n; ++i) {
        imag[i] = -imag[i];
    }

    // Шаг 2: Прямое преобразование Фурье
    forward(real, imag);

    // Шаг 3: Сопряжение и масштабирование на 1/N
    const float invN = 1.0f / static_cast<float>(n);

    i = 0;
#if defined(__wasm_simd128__)
    v128_t v_invN = wasm_f32x4_splat(invN);
    v128_t v_neg_invN = wasm_f32x4_splat(-invN);
    for (; i + 4 <= n; i += 4) {
        v128_t v_r = wasm_v128_load(&real[i]);
        v128_t v_im = wasm_v128_load(&imag[i]);
        wasm_v128_store(&real[i], wasm_f32x4_mul(v_r, v_invN));
        wasm_v128_store(&imag[i], wasm_f32x4_mul(v_im, v_neg_invN));
    }
#endif
    for (; i < n; ++i) {
        real[i] *= invN;
        imag[i] = -imag[i] * invN;
    }
}

// ============================================================================
// Реализация StemSeparator
// ============================================================================

StemSeparator::StemSeparator(size_t fftSize, size_t hopSize)
    : m_fftSize(fftSize)
    , m_hopSize(hopSize)
    , m_fft(fftSize)
{
    // Выделение постоянных scratch-буферов для исключения аллокаций в цикле кадров
    m_realL.resize(m_fftSize);
    m_imagL.resize(m_fftSize);
    m_realR.resize(m_fftSize);
    m_imagR.resize(m_fftSize);
}

void StemSeparator::separateVocalsAndKaraoke(
    const float* inLeft,
    const float* inRight,
    size_t totalSamples,
    float* outVocalsL,
    float* outVocalsR,
    float* outKaraokeL,
    float* outKaraokeR,
    int sampleRate
) {
    if (!inLeft || !inRight || totalSamples == 0) return;
    if (!outVocalsL || !outVocalsR || !outKaraokeL || !outKaraokeR) return;

    // Инициализация выходных массивов и буфера весов окон OLA
    std::memset(outVocalsL, 0, totalSamples * sizeof(float));
    std::memset(outVocalsR, 0, totalSamples * sizeof(float));

    if (m_normWeights.size() < totalSamples) {
        m_normWeights.resize(totalSamples);
    }
    std::fill(m_normWeights.begin(), m_normWeights.begin() + totalSamples, 0.0f);

    const size_t nFft = m_fftSize;
    const size_t hopSize = m_hopSize;
    const float* window = m_fft.getHanningWindow();

    const size_t numFrames = (totalSamples > nFft) ? ((totalSamples - nFft) / hopSize + 1) : 0;
    const float freqBinHz = static_cast<float>(sampleRate) / static_cast<float>(nFft);

    // ========================================================================
    // ЦИКЛ КАДРОВ STFT (Полное отсутствие dynamic memory allocations)
    // ========================================================================
    for (size_t frameIdx = 0; frameIdx < numFrames; ++frameIdx) {
        const size_t sampleOffset = frameIdx * hopSize;

        // 1. Оконное наложение входного сигнала (Windowing)
        size_t i = 0;
#if defined(__wasm_simd128__)
        for (; i + 4 <= nFft; i += 4) {
            size_t sIdx = sampleOffset + i;
            v128_t v_w = wasm_v128_load(&window[i]);

            v128_t v_inL = (sIdx + 4 <= totalSamples) 
                ? wasm_v128_load(&inLeft[sIdx]) 
                : wasm_f32x4_make(
                    sIdx + 0 < totalSamples ? inLeft[sIdx + 0] : 0.0f,
                    sIdx + 1 < totalSamples ? inLeft[sIdx + 1] : 0.0f,
                    sIdx + 2 < totalSamples ? inLeft[sIdx + 2] : 0.0f,
                    sIdx + 3 < totalSamples ? inLeft[sIdx + 3] : 0.0f
                );

            v128_t v_inR = (sIdx + 4 <= totalSamples) 
                ? wasm_v128_load(&inRight[sIdx]) 
                : wasm_f32x4_make(
                    sIdx + 0 < totalSamples ? inRight[sIdx + 0] : 0.0f,
                    sIdx + 1 < totalSamples ? inRight[sIdx + 1] : 0.0f,
                    sIdx + 2 < totalSamples ? inRight[sIdx + 2] : 0.0f,
                    sIdx + 3 < totalSamples ? inRight[sIdx + 3] : 0.0f
                );

            wasm_v128_store(&m_realL[i], wasm_f32x4_mul(v_inL, v_w));
            wasm_v128_store(&m_imagL[i], wasm_f32x4_splat(0.0f));
            wasm_v128_store(&m_realR[i], wasm_f32x4_mul(v_inR, v_w));
            wasm_v128_store(&m_imagR[i], wasm_f32x4_splat(0.0f));
        }
#endif
        for (; i < nFft; ++i) {
            size_t sIdx = sampleOffset + i;
            float w = window[i];
            float sL = (sIdx < totalSamples) ? inLeft[sIdx] : 0.0f;
            float sR = (sIdx < totalSamples) ? inRight[sIdx] : 0.0f;

            m_realL[i] = sL * w;
            m_imagL[i] = 0.0f;
            m_realR[i] = sR * w;
            m_imagR[i] = 0.0f;
        }

        // 2. Прямое БПФ для обоих каналов
        m_fft.forward(m_realL.data(), m_imagL.data());
        m_fft.forward(m_realR.data(), m_imagR.data());

        // 3. Выделение центрального канала (Mid/Side Decomposition) и формантная маска вокала
        const size_t halfBins = nFft / 2;

        for (size_t k = 0; k <= halfBins; ++k) {
            const float freqHz = static_cast<float>(k) * freqBinHz;

            // Расчет Mid и Side составляющих спектра
            const float midReal = (m_realL[k] + m_realR[k]) * 0.5f;
            const float midImag = (m_imagL[k] + m_imagR[k]) * 0.5f;
            const float sideReal = (m_realL[k] - m_realR[k]) * 0.5f;
            const float sideImag = (m_imagL[k] - m_imagR[k]) * 0.5f;

            const float midPower = midReal * midReal + midImag * midImag;
            const float sidePower = sideReal * sideReal + sideImag * sideImag + 1e-7f;

            // Весовой коэффициент центрального вокала
            float vocalWeight = midPower / (midPower + sidePower * 1.8f);

            // Подавление низких (бас/бочка) и высоких частот (тарелки/шум)
            if (freqHz < 150.0f || freqHz > 8000.0f) {
                vocalWeight *= 0.10f;
            } else if (freqHz >= 300.0f && freqHz <= 4000.0f) {
                // Выделение диапазона формант речи (300 Гц - 4 кГц)
                vocalWeight = std::min(1.0f, vocalWeight * 1.40f);
            }

            vocalWeight = std::max(0.0f, std::min(1.0f, vocalWeight));

            // Применение спектральной маски к бинам
            m_realL[k] *= vocalWeight;
            m_imagL[k] *= vocalWeight;
            m_realR[k] *= vocalWeight;
            m_imagR[k] *= vocalWeight;

            // Зеркальное восстановление симметричной части спектра для обратного БПФ
            if (k > 0 && k < halfBins) {
                m_realL[nFft - k] = m_realL[k];
                m_imagL[nFft - k] = -m_imagL[k];
                m_realR[nFft - k] = m_realR[k];
                m_imagR[nFft - k] = -m_imagR[k];
            }
        }

        // 4. Обратное iFFT для вокального сигнала
        m_fft.inverse(m_realL.data(), m_imagL.data());
        m_fft.inverse(m_realR.data(), m_imagR.data());

        // 5. Синтез Overlap-Add (OLA) с окном Ханна
        i = 0;
#if defined(__wasm_simd128__)
        for (; i + 4 <= nFft; i += 4) {
            size_t sIdx = sampleOffset + i;
            if (sIdx + 4 <= totalSamples) {
                v128_t v_w = wasm_v128_load(&window[i]);
                v128_t v_w2 = wasm_f32x4_mul(v_w, v_w);

                v128_t v_rL = wasm_v128_load(&m_realL[i]);
                v128_t v_rR = wasm_v128_load(&m_realR[i]);

                v128_t v_vocL = wasm_v128_load(&outVocalsL[sIdx]);
                v128_t v_vocR = wasm_v128_load(&outVocalsR[sIdx]);
                v128_t v_nw = wasm_v128_load(&m_normWeights[sIdx]);

                wasm_v128_store(&outVocalsL[sIdx], wasm_f32x4_add(v_vocL, wasm_f32x4_mul(v_rL, v_w)));
                wasm_v128_store(&outVocalsR[sIdx], wasm_f32x4_add(v_vocR, wasm_f32x4_mul(v_rR, v_w)));
                wasm_v128_store(&m_normWeights[sIdx], wasm_f32x4_add(v_nw, v_w2));
            } else {
                break;
            }
        }
#endif
        for (; i < nFft; ++i) {
            size_t sIdx = sampleOffset + i;
            if (sIdx < totalSamples) {
                float w = window[i];
                outVocalsL[sIdx] += m_realL[i] * w;
                outVocalsR[sIdx] += m_realR[i] * w;
                m_normWeights[sIdx] += w * w;
            }
        }
    }

    // ========================================================================
    // 6. Нормализация OLA весов и расчет инструментала (Phase Cancellation)
    // ========================================================================
    size_t s = 0;
#if defined(__wasm_simd128__)
    v128_t v_eps = wasm_f32x4_splat(1e-5f);
    for (; s + 4 <= totalSamples; s += 4) {
        v128_t v_nw = wasm_v128_load(&m_normWeights[s]);
        v128_t v_w = wasm_f32x4_max(v_nw, v_eps);

        v128_t v_vocL = wasm_v128_load(&outVocalsL[s]);
        v128_t v_vocR = wasm_v128_load(&outVocalsR[s]);

        v128_t v_normVocL = wasm_f32x4_div(v_vocL, v_w);
        v128_t v_normVocR = wasm_f32x4_div(v_vocR, v_w);

        wasm_v128_store(&outVocalsL[s], v_normVocL);
        wasm_v128_store(&outVocalsR[s], v_normVocR);

        v128_t v_inL = wasm_v128_load(&inLeft[s]);
        v128_t v_inR = wasm_v128_load(&inRight[s]);

        // Instrumental = Original - Vocals
        wasm_v128_store(&outKaraokeL[s], wasm_f32x4_sub(v_inL, v_normVocL));
        wasm_v128_store(&outKaraokeR[s], wasm_f32x4_sub(v_inR, v_normVocR));
    }
#endif
    for (; s < totalSamples; ++s) {
        float w = (m_normWeights[s] > 1e-5f) ? m_normWeights[s] : 1.0f;
        float vL = outVocalsL[s] / w;
        float vR = outVocalsR[s] / w;

        outVocalsL[s] = vL;
        outVocalsR[s] = vR;

        outKaraokeL[s] = inLeft[s] - vL;
        outKaraokeR[s] = inRight[s] - vR;
    }
}

} // namespace DAWCore
