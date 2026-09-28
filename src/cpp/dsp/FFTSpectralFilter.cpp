/**
 * ============================================================================
 * FFTSpectralFilter.cpp - Спектральная фильтрация на базе быстрого БПФ (C++17)
 * ============================================================================
 * Полная реализация алгоритма Cooley-Tukey Radix-2 БПФ и потокового WOLA
 * спектрального фильтра с нулевым фазовым сдвигом (Zero Phase).
 * ============================================================================
 */

#include "FFTSpectralFilter.hpp"
#include <cstring>
#include <algorithm>

namespace DAWCore {

// ============================================================================
// Реализация SpectralFFTEngine
// ============================================================================

SpectralFFTEngine::SpectralFFTEngine(size_t fftSize) {
    init(fftSize);
}

void SpectralFFTEngine::init(size_t fftSize) {
    // Ограничение размера БПФ степенью двойки (2048 или 4096)
    fftSize_ = (fftSize >= 4096) ? 4096 : 2048;
    halfSize_ = fftSize_ >> 1;

    levels_ = 0;
    size_t temp = fftSize_;
    while (temp > 1) {
        temp >>= 1;
        levels_++;
    }

    precomputeTables();
}

void SpectralFFTEngine::precomputeTables() {
    // 1. Таблица битовой инверсии (Bit-Reversal LUT)
    bitReverseTable_.resize(fftSize_);
    for (size_t i = 0; i < fftSize_; ++i) {
        uint32_t rev = 0;
        for (size_t j = 0; j < levels_; ++j) {
            rev = (rev << 1) | static_cast<uint32_t>((i >> j) & 1);
        }
        bitReverseTable_[i] = rev;
    }

    // 2. Таблицы тригонометрических поворотных множителей (Twiddle Factors)
    cosTable_.resize(halfSize_);
    sinTable_.resize(halfSize_);
    for (size_t i = 0; i < halfSize_; ++i) {
        const double angle = -TWO_PI_F * static_cast<double>(i) / static_cast<double>(fftSize_);
        cosTable_[i] = static_cast<float>(std::cos(angle));
        sinTable_[i] = static_cast<float>(std::sin(angle));
    }

    // 3. Предрасчет окна Square-Root Hann для идеального COLA перекрытия
    // w[n] = sin(pi * (n + 0.5) / N). При WOLA w[n]^2 дает классическое окно Ханна
    // с суммой перекрытия = 1.0 без пульсаций амплитуды.
    window_.resize(fftSize_);
    for (size_t i = 0; i < fftSize_; ++i) {
        const double angle = PI_F * (static_cast<double>(i) + 0.5) / static_cast<double>(fftSize_);
        window_[i] = static_cast<float>(std::sin(angle));
    }
}

void SpectralFFTEngine::forward(float* real, float* imag) const noexcept {
    const size_t n = fftSize_;

    // Шаг 1: Битовая перестановка (Bit-reversal permutation)
    for (size_t i = 0; i < n; ++i) {
        const size_t j = bitReverseTable_[i];
        if (j > i) {
            std::swap(real[i], real[j]);
            std::swap(imag[i], imag[j]);
        }
    }

    // Шаг 2: Вычисление бабочек Cooley-Tukey (Danielson-Lanczos)
    for (size_t size = 2; size <= n; size <<= 1) {
        const size_t halfSize = size >> 1;
        const size_t step = n / size;

        for (size_t i = 0; i < n; i += size) {
            size_t j = 0;

#if USE_WASM_SIMD
            // Векторизация 4 бабочек БПФ одновременно через SIMD128
            for (; j + 4 <= halfSize; j += 4) {
                const size_t k0 = (j + 0) * step;
                const size_t k1 = (j + 1) * step;
                const size_t k2 = (j + 2) * step;
                const size_t k3 = (j + 3) * step;

                v128_t vCos = wasm_f32x4_make(cosTable_[k0], cosTable_[k1], cosTable_[k2], cosTable_[k3]);
                v128_t vSin = wasm_f32x4_make(sinTable_[k0], sinTable_[k1], sinTable_[k2], sinTable_[k3]);

                const size_t idxB = i + j + halfSize;
                v128_t vRealB = wasm_v128_load(&real[idxB]);
                v128_t vImagB = wasm_v128_load(&imag[idxB]);

                // Комплексное умножение: (r + i*j) * (cos + i*sin)
                // t_real = r * cos - i * sin
                // t_imag = r * sin + i * cos
                v128_t vTReal = wasm_f32x4_sub(wasm_f32x4_mul(vRealB, vCos), wasm_f32x4_mul(vImagB, vSin));
                v128_t vTImag = wasm_f32x4_add(wasm_f32x4_mul(vRealB, vSin), wasm_f32x4_mul(vImagB, vCos));

                const size_t idxA = i + j;
                v128_t vRealA = wasm_v128_load(&real[idxA]);
                v128_t vImagA = wasm_v128_load(&imag[idxA]);

                // A_new = A + T, B_new = A - T
                wasm_v128_store(&real[idxA], wasm_f32x4_add(vRealA, vTReal));
                wasm_v128_store(&imag[idxA], wasm_f32x4_add(vImagA, vTImag));
                wasm_v128_store(&real[idxB], wasm_f32x4_sub(vRealA, vTReal));
                wasm_v128_store(&imag[idxB], wasm_f32x4_sub(vImagA, vTImag));
            }
#endif

            for (; j < halfSize; ++j) {
                const size_t k = j * step;
                const float c = cosTable_[k];
                const float s = sinTable_[k];

                const size_t idxA = i + j;
                const size_t idxB = idxA + halfSize;

                const float rB = real[idxB];
                const float iB = imag[idxB];

                const float tR = rB * c - iB * s;
                const float tI = rB * s + iB * c;

                const float rA = real[idxA];
                const float iA = imag[idxA];

                real[idxA] = rA + tR;
                imag[idxA] = iA + tI;
                real[idxB] = rA - tR;
                imag[idxB] = iA - tI;
            }
        }
    }
}

void SpectralFFTEngine::inverse(float* real, float* imag) const noexcept {
    const size_t n = fftSize_;

    // Шаг 1: Битовая перестановка
    for (size_t i = 0; i < n; ++i) {
        const size_t j = bitReverseTable_[i];
        if (j > i) {
            std::swap(real[i], real[j]);
            std::swap(imag[i], imag[j]);
        }
    }

    // Шаг 2: Обратные бабочки (знак sin положительный)
    for (size_t size = 2; size <= n; size <<= 1) {
        const size_t halfSize = size >> 1;
        const size_t step = n / size;

        for (size_t i = 0; i < n; i += size) {
            size_t j = 0;

#if USE_WASM_SIMD
            for (; j + 4 <= halfSize; j += 4) {
                const size_t k0 = (j + 0) * step;
                const size_t k1 = (j + 1) * step;
                const size_t k2 = (j + 2) * step;
                const size_t k3 = (j + 3) * step;

                v128_t vCos = wasm_f32x4_make(cosTable_[k0], cosTable_[k1], cosTable_[k2], cosTable_[k3]);
                // Для iFFT поворотный угол положителен: sin_inv = -sin_table
                v128_t vSin = wasm_f32x4_make(-sinTable_[k0], -sinTable_[k1], -sinTable_[k2], -sinTable_[k3]);

                const size_t idxB = i + j + halfSize;
                v128_t vRealB = wasm_v128_load(&real[idxB]);
                v128_t vImagB = wasm_v128_load(&imag[idxB]);

                v128_t vTReal = wasm_f32x4_sub(wasm_f32x4_mul(vRealB, vCos), wasm_f32x4_mul(vImagB, vSin));
                v128_t vTImag = wasm_f32x4_add(wasm_f32x4_mul(vRealB, vSin), wasm_f32x4_mul(vImagB, vCos));

                const size_t idxA = i + j;
                v128_t vRealA = wasm_v128_load(&real[idxA]);
                v128_t vImagA = wasm_v128_load(&imag[idxA]);

                wasm_v128_store(&real[idxA], wasm_f32x4_add(vRealA, vTReal));
                wasm_v128_store(&imag[idxA], wasm_f32x4_add(vImagA, vTImag));
                wasm_v128_store(&real[idxB], wasm_f32x4_sub(vRealA, vTReal));
                wasm_v128_store(&imag[idxB], wasm_f32x4_sub(vImagA, vTImag));
            }
#endif

            for (; j < halfSize; ++j) {
                const size_t k = j * step;
                const float c = cosTable_[k];
                const float s = -sinTable_[k]; // Обратный знак для iFFT

                const size_t idxA = i + j;
                const size_t idxB = idxA + halfSize;

                const float rB = real[idxB];
                const float iB = imag[idxB];

                const float tR = rB * c - iB * s;
                const float tI = rB * s + iB * c;

                const float rA = real[idxA];
                const float iA = imag[idxA];

                real[idxA] = rA + tR;
                imag[idxA] = iA + tI;
                real[idxB] = rA - tR;
                imag[idxB] = iA - tI;
            }
        }
    }

    // Шаг 3: Нормировка на 1 / N
    const float norm = 1.0f / static_cast<float>(n);
    size_t i = 0;

#if USE_WASM_SIMD
    v128_t vNorm = wasm_f32x4_splat(norm);
    const size_t simdEnd = n - (n % 4);
    for (; i < simdEnd; i += 4) {
        v128_t vR = wasm_v128_load(&real[i]);
        v128_t vI = wasm_v128_load(&imag[i]);
        wasm_v128_store(&real[i], wasm_f32x4_mul(vR, vNorm));
        wasm_v128_store(&imag[i], wasm_f32x4_mul(vI, vNorm));
    }
#endif

    for (; i < n; ++i) {
        real[i] *= norm;
        imag[i] *= norm;
    }
}

// ============================================================================
// Реализация FFTSpectralFilter
// ============================================================================

FFTSpectralFilter::FFTSpectralFilter(size_t fftSize, float sampleRate) {
    init(fftSize, sampleRate);
}

void FFTSpectralFilter::init(size_t fftSize, float sampleRate) {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;
    fftSize_ = (fftSize >= 4096) ? 4096 : 2048;
    hopSize_ = fftSize_ >> 1; // 50% перекрытие
    halfSize_ = fftSize_ >> 1;

    fftEngine_.init(fftSize_);

    // Инициализация единичной частотной маски
    frequencyMask_.assign(halfSize_ + 1, 1.0f);

    // Выделение рабочих буферов преобразования
    realBufferL_.assign(fftSize_, 0.0f);
    imagBufferL_.assign(fftSize_, 0.0f);
    realBufferR_.assign(fftSize_, 0.0f);
    imagBufferR_.assign(fftSize_, 0.0f);

    // Кольцевые FIFO буферы
    fifoCapacity_ = fftSize_ * 4;
    inFifoL_.assign(fifoCapacity_, 0.0f);
    inFifoR_.assign(fifoCapacity_, 0.0f);
    outFifoL_.assign(fifoCapacity_, 0.0f);
    outFifoR_.assign(fifoCapacity_, 0.0f);

    reset();
}

void FFTSpectralFilter::reset() noexcept {
    std::fill(realBufferL_.begin(), realBufferL_.end(), 0.0f);
    std::fill(imagBufferL_.begin(), imagBufferL_.end(), 0.0f);
    std::fill(realBufferR_.begin(), realBufferR_.end(), 0.0f);
    std::fill(imagBufferR_.begin(), imagBufferR_.end(), 0.0f);

    std::fill(inFifoL_.begin(), inFifoL_.end(), 0.0f);
    std::fill(inFifoR_.begin(), inFifoR_.end(), 0.0f);
    std::fill(outFifoL_.begin(), outFifoL_.end(), 0.0f);
    std::fill(outFifoR_.begin(), outFifoR_.end(), 0.0f);

    inFifoWritePos_ = 0;
    inFifoReadPos_ = 0;
    outFifoWritePos_ = 0;
    outFifoReadPos_ = 0;
    samplesInFifo_ = 0;
    samplesOutFifo_ = 0;
}

void FFTSpectralFilter::resetFrequencyMask() {
    std::fill(frequencyMask_.begin(), frequencyMask_.end(), 1.0f);
}

void FFTSpectralFilter::setFrequencyMask(const std::vector<float>& gainWeights) {
    if (gainWeights.empty()) return;

    const size_t numInputWeights = gainWeights.size();
    const size_t numBins = frequencyMask_.size();

    if (numInputWeights == numBins) {
        for (size_t i = 0; i < numBins; ++i) {
            frequencyMask_[i] = std::max(0.0f, std::min(10.0f, gainWeights[i]));
        }
        return;
    }

    // Линейная интерполяция входных весов по всей спектральной сетке бинов
    const float scale = static_cast<float>(numInputWeights - 1) / static_cast<float>(numBins - 1);
    for (size_t bin = 0; bin < numBins; ++bin) {
        const float pos = static_cast<float>(bin) * scale;
        const size_t idx0 = static_cast<size_t>(pos);
        const size_t idx1 = std::min(numInputWeights - 1, idx0 + 1);
        const float frac = pos - static_cast<float>(idx0);

        const float interpolated = (1.0f - frac) * gainWeights[idx0] + frac * gainWeights[idx1];
        frequencyMask_[bin] = std::max(0.0f, std::min(10.0f, interpolated));
    }
}

void FFTSpectralFilter::setBandGain(float centerHz, float bandwidthHz, float gainLinear) {
    const float binWidthHz = (sampleRate_ * 0.5f) / static_cast<float>(halfSize_);
    if (binWidthHz <= 0.0f) return;

    const float centerBin = centerHz / binWidthHz;
    const float halfWidthBins = (bandwidthHz * 0.5f) / binWidthHz;
    const float sigma = std::max(0.5f, halfWidthBins * 0.5f);
    const float invTwoSigmaSq = 1.0f / (2.0f * sigma * sigma);

    const float targetGain = std::max(0.0f, std::min(10.0f, gainLinear));

    for (size_t bin = 0; bin <= halfSize_; ++bin) {
        const float dist = static_cast<float>(bin) - centerBin;
        const float weight = std::exp(-dist * dist * invTwoSigmaSq);
        if (weight > 0.001f) {
            // Плавное применение коэффициента по кривой Гаусса
            frequencyMask_[bin] = (1.0f - weight) * frequencyMask_[bin] + weight * targetGain;
        }
    }
}

void FFTSpectralFilter::processSpectralFrame(
    const float* inputFrame,
    float* outputFrame,
    float* realBuffer,
    float* imagBuffer
) noexcept {
    const float* win = fftEngine_.getWindow();
    const size_t n = fftSize_;
    const size_t h = halfSize_;

    // 1. Оконное преобразование (Square-Root Hann Analysis Window)
    for (size_t i = 0; i < n; ++i) {
        realBuffer[i] = inputFrame[i] * win[i];
        imagBuffer[i] = 0.0f;
    }

    // 2. Прямое БПФ
    fftEngine_.forward(realBuffer, imagBuffer);

    // 3. Применение частотной маски (Zero-Phase Filtering)
    for (size_t k = 0; k <= h; ++k) {
        const float gain = frequencyMask_[k];
        realBuffer[k] *= gain;
        imagBuffer[k] *= gain;
    }

    // Обеспечение вещественности постоянной составляющей и частоты Найквиста
    imagBuffer[0] = 0.0f;
    imagBuffer[h] = 0.0f;

    // Восстановление отрицательных частот для строго эрмитовой симметрии
    for (size_t k = 1; k < h; ++k) {
        realBuffer[n - k] = realBuffer[k];
        imagBuffer[n - k] = -imagBuffer[k];
    }

    // 4. Обратное БПФ
    fftEngine_.inverse(realBuffer, imagBuffer);

    // 5. Оконное преобразование синтеза (Square-Root Hann Synthesis Window)
    for (size_t i = 0; i < n; ++i) {
        outputFrame[i] = realBuffer[i] * win[i];
    }
}

void FFTSpectralFilter::processBlock(float* buffer, size_t numFrames, int channels) noexcept {
    if (!buffer || numFrames == 0 || channels <= 0) return;

    if (channels == 1) {
        processBlock(buffer, nullptr, buffer, nullptr, numFrames);
    } else {
        // Разделение стереоканалов для покадровой WOLA фильтрации (Zero Alloc)
        constexpr size_t STACK_CHUNK = 256;
        float bufL[STACK_CHUNK];
        float bufR[STACK_CHUNK];

        size_t processed = 0;
        while (processed < numFrames) {
            const size_t chunk = std::min(STACK_CHUNK, numFrames - processed);
            const size_t offset = processed * 2;

            for (size_t i = 0; i < chunk; ++i) {
                bufL[i] = buffer[offset + (i * 2) + 0];
                bufR[i] = buffer[offset + (i * 2) + 1];
            }

            processBlock(bufL, bufR, bufL, bufR, chunk);

            for (size_t i = 0; i < chunk; ++i) {
                buffer[offset + (i * 2) + 0] = bufL[i];
                buffer[offset + (i * 2) + 1] = bufR[i];
            }

            processed += chunk;
        }
    }
}

void FFTSpectralFilter::processBlock(
    const float* inL,
    const float* inR,
    float* outL,
    float* outR,
    size_t numFrames
) noexcept {
    if (!inL || !outL || numFrames == 0) return;
    const bool isStereo = (inR != nullptr && outR != nullptr);

    // Локальные статические буферы кадра для выполнения STFT шага (Zero Malloc)
    alignas(16) float frameInL[MAX_FFT_SIZE];
    alignas(16) float frameInR[MAX_FFT_SIZE];
    alignas(16) float frameOutL[MAX_FFT_SIZE];
    alignas(16) float frameOutR[MAX_FFT_SIZE];

    size_t inOffset = 0;
    while (inOffset < numFrames) {
        // Добавляем доступные входные сэмплы в кольцевой FIFO буфер
        const size_t toWrite = std::min(numFrames - inOffset, fifoCapacity_ - samplesInFifo_);
        for (size_t i = 0; i < toWrite; ++i) {
            inFifoL_[inFifoWritePos_] = inL[inOffset + i];
            if (isStereo) {
                inFifoR_[inFifoWritePos_] = inR[inOffset + i];
            }
            if (++inFifoWritePos_ >= fifoCapacity_) inFifoWritePos_ = 0;
        }
        samplesInFifo_ += toWrite;
        inOffset += toWrite;

        // Пока в буфере накопилось хотя бы одно окно БПФ (fftSize) — выполняем спектральные шаги
        while (samplesInFifo_ >= fftSize_) {
            // Извлекаем fftSize сэмплов из inFifo
            for (size_t i = 0; i < fftSize_; ++i) {
                const size_t rIdx = (inFifoReadPos_ + i) % fifoCapacity_;
                frameInL[i] = inFifoL_[rIdx];
                if (isStereo) {
                    frameInR[i] = inFifoR_[rIdx];
                }
            }

            // Сдвигаем позицию чтения на hopSize (50% перекрытие)
            inFifoReadPos_ = (inFifoReadPos_ + hopSize_) % fifoCapacity_;
            samplesInFifo_ -= hopSize_;

            // Спектральная обработка кадра
            processSpectralFrame(frameInL, frameOutL, realBufferL_.data(), imagBufferL_.data());
            if (isStereo) {
                processSpectralFrame(frameInR, frameOutR, realBufferR_.data(), imagBufferR_.data());
            }

            // Overlap-Add накопление в выходной FIFO буфер
            for (size_t i = 0; i < fftSize_; ++i) {
                const size_t wIdx = (outFifoWritePos_ + i) % fifoCapacity_;
                outFifoL_[wIdx] += frameOutL[i];
                if (isStereo) {
                    outFifoR_[wIdx] += frameOutR[i];
                }
            }

            // Продвигаем позицию записи выхода на hopSize
            outFifoWritePos_ = (outFifoWritePos_ + hopSize_) % fifoCapacity_;
            samplesOutFifo_ += hopSize_;
        }
    }

    // Выгрузка обработанных сэмплов из outFifo в выходной массив
    for (size_t i = 0; i < numFrames; ++i) {
        if (samplesOutFifo_ > 0) {
            outL[i] = outFifoL_[outFifoReadPos_];
            outFifoL_[outFifoReadPos_] = 0.0f; // Очистка после чтения для следующего Overlap-Add

            if (isStereo) {
                outR[i] = outFifoR_[outFifoReadPos_];
                outFifoR_[outFifoReadPos_] = 0.0f;
            }

            if (++outFifoReadPos_ >= fifoCapacity_) outFifoReadPos_ = 0;
            samplesOutFifo_--;
        } else {
            outL[i] = 0.0f;
            if (isStereo) outR[i] = 0.0f;
        }
    }
}

} // namespace DAWCore
