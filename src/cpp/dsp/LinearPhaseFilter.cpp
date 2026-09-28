/**
 * ============================================================================
 * LinearPhaseFilter.cpp - Линейно-фазовые КИХ (FIR) фильтры ФВЧ/ФНЧ (C++17)
 * ============================================================================
 * Реализация Windowed-Sinc синтеза с быстрой сегментной сверткой Overlap-Save (OLS)
 * через алгоритм БПФ с аппаратным ускорением WASM SIMD128.
 * ============================================================================
 */

#include "LinearPhaseFilter.hpp"
#include <cstring>
#include <algorithm>

namespace DAWCore {

// ============================================================================
// Реализация FIRFastFourierTransform
// ============================================================================

FIRFastFourierTransform::FIRFastFourierTransform(size_t fftSize) {
    init(fftSize);
}

void FIRFastFourierTransform::init(size_t fftSize) {
    fftSize_ = (fftSize >= 4096) ? 4096 : 2048;
    halfSize_ = fftSize_ >> 1;

    levels_ = 0;
    size_t temp = fftSize_;
    while (temp > 1) {
        temp >>= 1;
        levels_++;
    }

    precompute();
}

void FIRFastFourierTransform::precompute() {
    bitReverse_.resize(fftSize_);
    for (size_t i = 0; i < fftSize_; ++i) {
        uint32_t rev = 0;
        for (size_t j = 0; j < levels_; ++j) {
            rev = (rev << 1) | static_cast<uint32_t>((i >> j) & 1);
        }
        bitReverse_[i] = rev;
    }

    cosTable_.resize(halfSize_);
    sinTable_.resize(halfSize_);
    for (size_t i = 0; i < halfSize_; ++i) {
        const double angle = -TWO_PI_F * static_cast<double>(i) / static_cast<double>(fftSize_);
        cosTable_[i] = static_cast<float>(std::cos(angle));
        sinTable_[i] = static_cast<float>(std::sin(angle));
    }
}

void FIRFastFourierTransform::forward(float* real, float* imag) const noexcept {
    const size_t n = fftSize_;

    for (size_t i = 0; i < n; ++i) {
        const size_t j = bitReverse_[i];
        if (j > i) {
            std::swap(real[i], real[j]);
            std::swap(imag[i], imag[j]);
        }
    }

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
                v128_t vSin = wasm_f32x4_make(sinTable_[k0], sinTable_[k1], sinTable_[k2], sinTable_[k3]);

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

void FIRFastFourierTransform::inverse(float* real, float* imag) const noexcept {
    const size_t n = fftSize_;

    for (size_t i = 0; i < n; ++i) {
        const size_t j = bitReverse_[i];
        if (j > i) {
            std::swap(real[i], real[j]);
            std::swap(imag[i], imag[j]);
        }
    }

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
                const float s = -sinTable_[k];

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
// Реализация LinearPhaseFilter
// ============================================================================

LinearPhaseFilter::LinearPhaseFilter(float sampleRate) noexcept
    : fftEngine_(FFT_SIZE) {
    setSampleRate(sampleRate);
}

void LinearPhaseFilter::setSampleRate(float sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;

    kernelReal_.assign(FFT_SIZE, 0.0f);
    kernelImag_.assign(FFT_SIZE, 0.0f);

    realBufL_.assign(FFT_SIZE, 0.0f);
    imagBufL_.assign(FFT_SIZE, 0.0f);
    realBufR_.assign(FFT_SIZE, 0.0f);
    imagBufR_.assign(FFT_SIZE, 0.0f);

    historyL_.assign(MAX_ORDER, 0.0f);
    historyR_.assign(MAX_ORDER, 0.0f);

    fifoCapacity_ = FFT_SIZE * 4;
    inFifoL_.assign(fifoCapacity_, 0.0f);
    inFifoR_.assign(fifoCapacity_, 0.0f);
    outFifoL_.assign(fifoCapacity_, 0.0f);
    outFifoR_.assign(fifoCapacity_, 0.0f);

    designFilter();
    reset();
}

void LinearPhaseFilter::setParams(const LinearPhaseParams& params) noexcept {
    params_ = params;
    designFilter();
}

size_t LinearPhaseFilter::getGroupDelaySamples() const noexcept {
    return (numTaps_ - 1) / 2;
}

void LinearPhaseFilter::reset() noexcept {
    std::fill(historyL_.begin(), historyL_.end(), 0.0f);
    std::fill(historyR_.begin(), historyR_.end(), 0.0f);

    std::fill(inFifoL_.begin(), inFifoL_.end(), 0.0f);
    std::fill(inFifoR_.begin(), inFifoR_.end(), 0.0f);
    std::fill(outFifoL_.begin(), outFifoL_.end(), 0.0f);
    std::fill(outFifoR_.begin(), outFifoR_.end(), 0.0f);

    inWritePos_ = 0;
    inReadPos_ = 0;
    outWritePos_ = 0;
    outReadPos_ = 0;
    samplesInFifo_ = 0;
    samplesOutFifo_ = 0;
}

float LinearPhaseFilter::calculateWindow(FIRWindowType type, size_t n, size_t totalM) noexcept {
    if (totalM <= 1) return 1.0f;
    const double N = static_cast<double>(totalM - 1);
    const double pos = static_cast<double>(n) / N;

    switch (type) {
        case FIRWindowType::Hann:
            return static_cast<float>(0.5 - 0.5 * std::cos(TWO_PI_F * pos));

        case FIRWindowType::Hamming:
            return static_cast<float>(0.54 - 0.46 * std::cos(TWO_PI_F * pos));

        case FIRWindowType::Blackman:
            return static_cast<float>(0.42 - 0.5 * std::cos(TWO_PI_F * pos) + 0.08 * std::cos(4.0 * PI_F * pos));

        case FIRWindowType::BlackmanHarris:
            return static_cast<float>(
                0.35875 - 0.48829 * std::cos(TWO_PI_F * pos) +
                0.14128 * std::cos(4.0 * PI_F * pos) -
                0.01168 * std::cos(6.0 * PI_F * pos)
            );

        case FIRWindowType::Rectangular:
        default:
            return 1.0f;
    }
}

void LinearPhaseFilter::designFilter() noexcept {
    // 1. Определение порядка фильтра (четный) и числа коэффициентов M = Order + 1
    int order = std::max(64, std::min(static_cast<int>(MAX_ORDER), params_.filterOrder));
    if (order % 2 != 0) order++; // Обеспечение четности порядка (Type I FIR)

    numTaps_ = static_cast<size_t>(order + 1);
    stepSize_ = FFT_SIZE - numTaps_ + 1; // Размер блока в Overlap-Save

    const double n0 = static_cast<double>(order) * 0.5; // Симметричный центр импульса
    const double nyquist = sampleRate_ * 0.5;

    const bool hasHP = (params_.hpFreq > 20.0f);
    const bool hasLP = (params_.lpFreq < nyquist * 0.98);

    std::vector<float> h(numTaps_, 0.0f);

    if (!hasHP && !hasLP) {
        // Полный прозрачный проход: единичный импульс Кронекера в центре
        h[static_cast<size_t>(n0)] = 1.0f;
    } else {
        const double fHp = std::max(10.0, std::min(nyquist * 0.95, static_cast<double>(params_.hpFreq)));
        const double fLp = std::max(fHp + 10.0, std::min(nyquist * 0.98, static_cast<double>(params_.lpFreq)));

        const double wHp = TWO_PI_F * fHp / sampleRate_;
        const double wLp = TWO_PI_F * fLp / sampleRate_;

        for (size_t i = 0; i < numTaps_; ++i) {
            const double delta = static_cast<double>(i) - n0;

            double valLp = 0.0;
            double valHp = 0.0;

            if (std::fabs(delta) < 1e-7) {
                valLp = wLp / PI_F;
                valHp = wHp / PI_F;
            } else {
                valLp = std::sin(wLp * delta) / (PI_F * delta);
                valHp = std::sin(wHp * delta) / (PI_F * delta);
            }

            if (hasHP && hasLP) {
                // Полосовой фильтр (Band-Pass): h = h_lp - h_hp
                h[i] = static_cast<float>(valLp - valHp);
            } else if (hasLP) {
                // Фильтр нижних частот (Low-Pass)
                h[i] = static_cast<float>(valLp);
            } else {
                // Фильтр верхних частот (High-Pass): h = delta - h_lp
                const double dirac = (std::fabs(delta) < 1e-7) ? 1.0 : 0.0;
                h[i] = static_cast<float>(dirac - valHp);
            }

            // Оконное сглаживание боковых лепестков
            h[i] *= calculateWindow(params_.windowType, i, numTaps_);
        }

        // Нормировка коэффициента усиления в полосе пропускания к строго 1.0 (0 dB)
        double gainPass = 0.0;
        if (!hasHP && hasLP) {
            // Сумма отсчетов на DC (w = 0)
            for (float v : h) gainPass += v;
        } else if (hasHP && !hasLP) {
            // Отклик на частоте Найквиста (w = pi): сумма h[n]*(-1)^n
            for (size_t i = 0; i < numTaps_; ++i) {
                gainPass += (i % 2 == 0) ? h[i] : -h[i];
            }
        } else {
            // Центральная геометрическая частота полосы пропускания
            const double wMid = 0.5 * (wHp + wLp);
            for (size_t i = 0; i < numTaps_; ++i) {
                gainPass += h[i] * std::cos(wMid * (static_cast<double>(i) - n0));
            }
        }

        if (std::fabs(gainPass) > 1e-6) {
            const float normFactor = 1.0f / static_cast<float>(gainPass);
            for (float& v : h) v *= normFactor;
        }
    }

    // 2. Дополнение нулями до FFT_SIZE и расчет частотного спектра H(w) = FFT(h)
    std::fill(kernelReal_.begin(), kernelReal_.end(), 0.0f);
    std::fill(kernelImag_.begin(), kernelImag_.end(), 0.0f);
    std::copy(h.begin(), h.end(), kernelReal_.begin());

    fftEngine_.forward(kernelReal_.data(), kernelImag_.data());
}

void LinearPhaseFilter::processOverlapSaveBlock(
    const float* newSamples,
    float* outputValid,
    float* history,
    float* realBuf,
    float* imagBuf
) noexcept {
    const size_t mMinus1 = numTaps_ - 1;
    const size_t b = stepSize_;
    const size_t l = FFT_SIZE;

    // 1. Формирование входного массива Overlap-Save:
    // [предыдущие M - 1 сэмплов из истории, новые B сэмплов]
    std::copy(history, history + mMinus1, realBuf);
    std::copy(newSamples, newSamples + b, realBuf + mMinus1);
    std::fill(imagBuf, imagBuf + l, 0.0f);

    // Обновление истории: последние M - 1 сэмплов из текущего блока
    std::copy(newSamples + b - mMinus1, newSamples + b, history);

    // 2. Прямое БПФ: X = FFT(x)
    fftEngine_.forward(realBuf, imagBuf);

    // 3. Комплексное умножение спектров: Y = X * H
    size_t i = 0;

#if USE_WASM_SIMD
    for (; i + 4 <= l; i += 4) {
        v128_t vXr = wasm_v128_load(&realBuf[i]);
        v128_t vXi = wasm_v128_load(&imagBuf[i]);
        v128_t vHr = wasm_v128_load(&kernelReal_[i]);
        v128_t vHi = wasm_v128_load(&kernelImag_[i]);

        // Y_real = Xr * Hr - Xi * Hi
        // Y_imag = Xr * Hi + Xi * Hr
        v128_t vYr = wasm_f32x4_sub(wasm_f32x4_mul(vXr, vHr), wasm_f32x4_mul(vXi, vHi));
        v128_t vYi = wasm_f32x4_add(wasm_f32x4_mul(vXr, vHi), wasm_f32x4_mul(vXi, vHr));

        wasm_v128_store(&realBuf[i], vYr);
        wasm_v128_store(&imagBuf[i], vYi);
    }
#endif

    for (; i < l; ++i) {
        const float xr = realBuf[i];
        const float xi = imagBuf[i];
        const float hr = kernelReal_[i];
        const float hi = kernelImag_[i];

        realBuf[i] = xr * hr - xi * hi;
        imagBuf[i] = xr * hi + xi * hr;
    }

    // 4. Обратное БПФ: y = IFFT(Y)
    fftEngine_.inverse(realBuf, imagBuf);

    // 5. Отбрасывание первых M - 1 сэмплов (циклическая свертка)
    // и извлечение валидных B сэмплов линейной свертки
    std::copy(realBuf + mMinus1, realBuf + mMinus1 + b, outputValid);
}

void LinearPhaseFilter::processBlock(float* samples, size_t numFrames, int channels) noexcept {
    processBlock(samples, samples, numFrames, channels);
}

void LinearPhaseFilter::processBlock(
    const float* input,
    float* output,
    size_t numFrames,
    int channels
) noexcept {
    if (!input || !output || numFrames == 0 || channels <= 0) return;

    if (!params_.enabled) {
        if (input != output) {
            std::copy(input, input + (numFrames * static_cast<size_t>(channels)), output);
        }
        return;
    }

    const bool isStereo = (channels > 1);
    const size_t b = stepSize_;

    alignas(16) float blockInL[FFT_SIZE];
    alignas(16) float blockInR[FFT_SIZE];
    alignas(16) float blockOutL[FFT_SIZE];
    alignas(16) float blockOutR[FFT_SIZE];

    size_t inOffset = 0;
    while (inOffset < numFrames) {
        const size_t toWrite = std::min(numFrames - inOffset, fifoCapacity_ - samplesInFifo_);

        for (size_t i = 0; i < toWrite; ++i) {
            if (isStereo) {
                const size_t sIdx = (inOffset + i) * 2;
                inFifoL_[inWritePos_] = input[sIdx + 0];
                inFifoR_[inWritePos_] = input[sIdx + 1];
            } else {
                inFifoL_[inWritePos_] = input[inOffset + i];
            }
            if (++inWritePos_ >= fifoCapacity_) inWritePos_ = 0;
        }

        samplesInFifo_ += toWrite;
        inOffset += toWrite;

        // Пока накопился полный шаг Overlap-Save (B сэмплов) — выполняем быструю свертку
        while (samplesInFifo_ >= b) {
            for (size_t i = 0; i < b; ++i) {
                blockInL[i] = inFifoL_[inReadPos_];
                if (isStereo) blockInR[i] = inFifoR_[inReadPos_];
                if (++inReadPos_ >= fifoCapacity_) inReadPos_ = 0;
            }
            samplesInFifo_ -= b;

            processOverlapSaveBlock(blockInL, blockOutL, historyL_.data(), realBufL_.data(), imagBufL_.data());
            if (isStereo) {
                processOverlapSaveBlock(blockInR, blockOutR, historyR_.data(), realBufR_.data(), imagBufR_.data());
            }

            for (size_t i = 0; i < b; ++i) {
                outFifoL_[outWritePos_] = blockOutL[i];
                if (isStereo) outFifoR_[outWritePos_] = blockOutR[i];
                if (++outWritePos_ >= fifoCapacity_) outWritePos_ = 0;
            }
            samplesOutFifo_ += b;
        }
    }

    // Выгрузка обработанных сэмплов из FIFO
    for (size_t i = 0; i < numFrames; ++i) {
        if (samplesOutFifo_ > 0) {
            if (isStereo) {
                const size_t sIdx = i * 2;
                output[sIdx + 0] = outFifoL_[outReadPos_];
                output[sIdx + 1] = outFifoR_[outReadPos_];
            } else {
                output[i] = outFifoL_[outReadPos_];
            }
            if (++outReadPos_ >= fifoCapacity_) outReadPos_ = 0;
            samplesOutFifo_--;
        } else {
            if (isStereo) {
                output[i * 2 + 0] = 0.0f;
                output[i * 2 + 1] = 0.0f;
            } else {
                output[i] = 0.0f;
            }
        }
    }
}

} // namespace DAWCore
