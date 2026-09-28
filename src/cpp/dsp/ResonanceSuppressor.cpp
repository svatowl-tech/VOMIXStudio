/**
 * ============================================================================
 * ResonanceSuppressor.cpp - Реализация подавителя резонансов (C++17)
 * ============================================================================
 * Автоматический спектральный трекинг узкополосных резонансов и адаптивная
 * динамическая режекция с аппаратным ускорением WASM SIMD128.
 * ============================================================================
 */

#include "ResonanceSuppressor.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

ResonanceSuppressor::ResonanceSuppressor(float sampleRate) noexcept {
    initTables();
    setSampleRate(sampleRate);
}

void ResonanceSuppressor::initTables() noexcept {
    // 1. Таблица битовой инверсии БПФ (1024 отсчета)
    bitReverse_.resize(FFT_SIZE);
    constexpr size_t levels = 10; // 2^10 = 1024
    for (size_t i = 0; i < FFT_SIZE; ++i) {
        uint32_t rev = 0;
        for (size_t j = 0; j < levels; ++j) {
            rev = (rev << 1) | static_cast<uint32_t>((i >> j) & 1);
        }
        bitReverse_[i] = rev;
    }

    // 2. Таблицы тригонометрических поворотных коэффициентов
    cosTable_.resize(HALF_SIZE);
    sinTable_.resize(HALF_SIZE);
    for (size_t i = 0; i < HALF_SIZE; ++i) {
        const double angle = -TWO_PI_F * static_cast<double>(i) / static_cast<double>(FFT_SIZE);
        cosTable_[i] = static_cast<float>(std::cos(angle));
        sinTable_[i] = static_cast<float>(std::sin(angle));
    }

    // 3. Окно Ханна для спектрального анализатора
    fftWindow_.resize(FFT_SIZE);
    for (size_t i = 0; i < FFT_SIZE; ++i) {
        const double angle = TWO_PI_F * static_cast<double>(i) / static_cast<double>(FFT_SIZE);
        fftWindow_[i] = static_cast<float>(0.5 * (1.0 - std::cos(angle)));
    }

    fftReal_.assign(FFT_SIZE, 0.0f);
    fftImag_.assign(FFT_SIZE, 0.0f);
    magnitudes_.assign(HALF_SIZE + 1, 0.0f);
    smoothedEnvelope_.assign(HALF_SIZE + 1, 0.0f);
    analysisRingBuf_.assign(FFT_SIZE * 2, 0.0f);
}

void ResonanceSuppressor::setSampleRate(float sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;

    // Расчет коэффициентов баллистики на один шаг HOP (256 сэмплов)
    const float hopRate = sampleRate_ / static_cast<float>(HOP_SIZE);
    const float attSec = std::max(0.0005f, params_.attackMs * 0.001f);
    const float relSec = std::max(0.005f, params_.releaseMs * 0.001f);

    attackCoeff_ = std::exp(-1.0f / (attSec * hopRate));
    releaseCoeff_ = std::exp(-1.0f / (relSec * hopRate));

    reset();
}

void ResonanceSuppressor::setParams(const ResonanceSuppressorParams& params) noexcept {
    params_ = params;

    const float hopRate = sampleRate_ / static_cast<float>(HOP_SIZE);
    const float attSec = std::max(0.0005f, params_.attackMs * 0.001f);
    const float relSec = std::max(0.005f, params_.releaseMs * 0.001f);

    attackCoeff_ = std::exp(-1.0f / (attSec * hopRate));
    releaseCoeff_ = std::exp(-1.0f / (relSec * hopRate));
}

void ResonanceSuppressor::reset() noexcept {
    for (size_t i = 0; i < MAX_NOTCHES; ++i) {
        notches_[i] = TrackedNotch{};
        currentCoeffs_[i] = NotchBiquadCoeffs{};
        targetCoeffs_[i] = NotchBiquadCoeffs{};
        states_[i].reset();
    }

    std::fill(analysisRingBuf_.begin(), analysisRingBuf_.end(), 0.0f);
    ringWritePos_ = 0;
    hopSampleCount_ = 0;
}

size_t ResonanceSuppressor::getActiveNotchCount() const noexcept {
    size_t count = 0;
    for (const auto& notch : notches_) {
        if (notch.active && notch.currentGainDb < -0.3f) count++;
    }
    return count;
}

float ResonanceSuppressor::getNotchFrequency(size_t index) const noexcept {
    if (index >= MAX_NOTCHES) return 1000.0f;
    return notches_[index].frequency;
}

float ResonanceSuppressor::getNotchAttenuationDb(size_t index) const noexcept {
    if (index >= MAX_NOTCHES) return 0.0f;
    return notches_[index].currentGainDb;
}

void ResonanceSuppressor::forwardFFT(float* real, float* imag) const noexcept {
    constexpr size_t n = FFT_SIZE;

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

NotchBiquadCoeffs ResonanceSuppressor::calculateNotchCoeffs(
    float freq,
    float Q,
    float gainDb,
    float sampleRate
) noexcept {
    if (std::fabs(gainDb) < 0.05f || sampleRate <= 8000.0f) {
        return NotchBiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };
    }

    const double nyquist = 0.485 * sampleRate;
    const double f0 = std::max(20.0, std::min(nyquist, static_cast<double>(freq)));
    const double qVal = std::max(0.5, static_cast<double>(Q));
    const double A = std::pow(10.0, static_cast<double>(gainDb) / 40.0);

    const double w0 = (2.0 * PI_F * f0) / sampleRate;
    const double cosW = std::cos(w0);
    const double sinW = std::sin(w0);
    const double alpha = sinW / (2.0 * qVal);

    const double b0 = 1.0 + alpha * A;
    const double b1 = -2.0 * cosW;
    const double b2 = 1.0 - alpha * A;
    const double a0 = 1.0 + alpha / A;
    const double a1 = -2.0 * cosW;
    const double a2 = 1.0 - alpha / A;

    if (std::fabs(a0) < 1e-12) return NotchBiquadCoeffs{ 1.0f, 0.0f, 0.0f, 0.0f, 0.0f };

    const double invA0 = 1.0 / a0;
    NotchBiquadCoeffs out;
    out.b0 = static_cast<float>(b0 * invA0);
    out.b1 = static_cast<float>(b1 * invA0);
    out.b2 = static_cast<float>(b2 * invA0);
    out.a1 = static_cast<float>(a1 * invA0);
    out.a2 = static_cast<float>(a2 * invA0);

    if (std::fabs(out.a2) >= 0.9999f) {
        out.a2 = (out.a2 > 0.0f) ? 0.9998f : -0.9998f;
    }
    return out;
}

void ResonanceSuppressor::analyzeSpectrumAndTrackResonances() noexcept {
    const size_t ringCap = analysisRingBuf_.size();

    // 1. Извлечение последних 1024 сэмплов с оконной функцией
    for (size_t i = 0; i < FFT_SIZE; ++i) {
        const size_t rIdx = (ringWritePos_ + ringCap - FFT_SIZE + i) % ringCap;
        fftReal_[i] = analysisRingBuf_[rIdx] * fftWindow_[i];
        fftImag_[i] = 0.0f;
    }

    // 2. Прямое БПФ
    forwardFFT(fftReal_.data(), fftImag_.data());

    // 3. Вычисление спектральных амплитуд
    for (size_t k = 0; k <= HALF_SIZE; ++k) {
        const float r = fftReal_[k];
        const float im = fftImag_[k];
        magnitudes_[k] = std::sqrt(r * r + im * im) + 1e-9f;
    }

    // 4. Расчет сглаженной огибающей фона (Moving Average Filter c окном 25 бинов)
    constexpr int RADIUS = 12;
    float runSum = 0.0f;
    int count = 0;

    for (int i = 0; i <= RADIUS && i <= static_cast<int>(HALF_SIZE); ++i) {
        runSum += magnitudes_[i];
        count++;
    }

    for (int k = 0; k <= static_cast<int>(HALF_SIZE); ++k) {
        const int addIdx = k + RADIUS;
        const int subIdx = k - RADIUS - 1;

        if (addIdx <= static_cast<int>(HALF_SIZE)) {
            runSum += magnitudes_[addIdx];
            count++;
        }
        if (subIdx >= 0) {
            runSum -= magnitudes_[subIdx];
            count--;
        }

        smoothedEnvelope_[k] = runSum / static_cast<float>(std::max(1, count));
    }

    // 5. Поиск локальных резонансных пиков (Prominence Detection)
    const float binHz = sampleRate_ / static_cast<float>(FFT_SIZE);
    const int minBin = std::max(2, static_cast<int>(params_.minFreq / binHz));
    const int maxBin = std::min(static_cast<int>(HALF_SIZE - 2), static_cast<int>(params_.maxFreq / binHz));

    // Порог в дБ: чем выше sensitivity, тем более чутко реагирует на малые пики
    const float threshDb = 15.0f - (params_.sensitivity * 10.5f); // 4.5 .. 15.0 дБ
    const float maxAtten = std::min(-3.0f, params_.maxAttenuationDb);

    struct PeakCandidate {
        float freq = 0.0f;
        float prominenceDb = 0.0f;
    };

    std::array<PeakCandidate, 16> candidates{};
    size_t candidateCount = 0;

    for (int k = minBin; k <= maxBin; ++k) {
        const float mag = magnitudes_[k];

        // Локальный максимум
        if (mag > magnitudes_[k - 1] && mag > magnitudes_[k + 1]) {
            const float env = smoothedEnvelope_[k];
            const float promRatio = mag / env;
            const float promDb = 20.0f * std::log10(promRatio);

            if (promDb > threshDb) {
                // Параболическая квадратичная интерполяция частоты пика
                const float alpha = magnitudes_[k - 1];
                const float beta = mag;
                const float gamma = magnitudes_[k + 1];
                const float denom = 2.0f * (2.0f * beta - alpha - gamma);
                const float delta = (std::fabs(denom) > 1e-9f) ? (alpha - gamma) / denom : 0.0f;

                const float peakFreq = (static_cast<float>(k) + delta) * binHz;

                if (candidateCount < candidates.size()) {
                    candidates[candidateCount++] = { peakFreq, promDb };
                }
            }
        }
    }

    // Сортировка кандидатов по убыванию выраженности пика
    std::sort(candidates.begin(), candidates.begin() + candidateCount, [](const PeakCandidate& a, const PeakCandidate& b) {
        return a.prominenceDb > b.prominenceDb;
    });

    const size_t maxActiveNotches = std::min(MAX_NOTCHES, params_.maxNotches);
    std::array<bool, MAX_NOTCHES> slotMatched{};
    slotMatched.fill(false);

    // 6. Сопоставление кандидатов с существующими фильтрами (Frequency Tracking)
    for (size_t c = 0; c < candidateCount && c < maxActiveNotches; ++c) {
        const auto& cand = candidates[c];
        float bestDist = 1e9f;
        int bestSlot = -1;

        // Поиск ближайшего активного фильтра в пределах ±12% частоты
        for (size_t s = 0; s < maxActiveNotches; ++s) {
            if (notches_[s].active && !slotMatched[s]) {
                const float dist = std::fabs(notches_[s].frequency - cand.freq) / notches_[s].frequency;
                if (dist < 0.12f && dist < bestDist) {
                    bestDist = dist;
                    bestSlot = static_cast<int>(s);
                }
            }
        }

        // Если подходящий активный слот не найден — ищем свободный
        if (bestSlot < 0) {
            for (size_t s = 0; s < maxActiveNotches; ++s) {
                if (!notches_[s].active && !slotMatched[s]) {
                    bestSlot = static_cast<int>(s);
                    notches_[s].frequency = cand.freq;
                    notches_[s].targetFreq = cand.freq;
                    notches_[s].currentGainDb = 0.0f;
                    notches_[s].Q = params_.sharpness;
                    notches_[s].active = true;
                    break;
                }
            }
        }

        if (bestSlot >= 0) {
            slotMatched[bestSlot] = true;
            auto& slot = notches_[bestSlot];
            slot.targetFreq = cand.freq;

            const float excess = cand.prominenceDb - threshDb;
            slot.targetGainDb = std::max(maxAtten, -excess * 1.3f);
            slot.Q = params_.sharpness;
            slot.holdCounter = 6; // 6 хопов удержания фильтра
        }
    }

    // 7. Обновление несовпавших слотов (спад и восстановление)
    for (size_t s = 0; s < maxActiveNotches; ++s) {
        auto& slot = notches_[s];
        if (!slotMatched[s] && slot.active) {
            if (slot.holdCounter > 0) {
                slot.holdCounter--;
            } else {
                slot.targetGainDb = 0.0f; // Плавный возврат в 0 дБ
            }
        }

        // Баллистическое сглаживание коэффициента усиления
        if (slot.targetGainDb < slot.currentGainDb) {
            slot.currentGainDb = attackCoeff_ * slot.currentGainDb + (1.0f - attackCoeff_) * slot.targetGainDb;
        } else {
            slot.currentGainDb = releaseCoeff_ * slot.currentGainDb + (1.0f - releaseCoeff_) * slot.targetGainDb;
        }

        // Сглаживание частоты
        slot.frequency += (slot.targetFreq - slot.frequency) * 0.25f;

        // Если фильтр вернулся к 0 дБ — деактивируем слот
        if (slot.currentGainDb > -0.2f && slot.targetGainDb >= 0.0f) {
            slot.active = false;
            slot.currentGainDb = 0.0f;
        }

        // Расчет целевых коэффициентов биквадрата
        targetCoeffs_[s] = calculateNotchCoeffs(slot.frequency, slot.Q, slot.currentGainDb, sampleRate_);
    }
}

void ResonanceSuppressor::processBlock(float* buffer, size_t numFrames, int channels) noexcept {
    processBlock(buffer, buffer, numFrames, channels);
}

void ResonanceSuppressor::processBlock(
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

    if (input != output) {
        std::copy(input, input + (numFrames * static_cast<size_t>(channels)), output);
    }

    constexpr size_t SUB_CHUNK = 32;
    const size_t ringCap = analysisRingBuf_.size();
    const size_t maxActiveNotches = std::min(MAX_NOTCHES, params_.maxNotches);

    size_t processed = 0;
    while (processed < numFrames) {
        const size_t chunk = std::min(SUB_CHUNK, numFrames - processed);

        // 1. Пополнение кольцевого буфера спектрального анализатора
        for (size_t i = 0; i < chunk; ++i) {
            const size_t fIdx = processed + i;
            float monoSample = 0.0f;

            if (channels == 1) {
                monoSample = output[fIdx];
            } else {
                monoSample = (output[fIdx * 2 + 0] + output[fIdx * 2 + 1]) * 0.5f;
            }

            analysisRingBuf_[ringWritePos_] = monoSample;
            if (++ringWritePos_ >= ringCap) ringWritePos_ = 0;

            if (++hopSampleCount_ >= HOP_SIZE) {
                hopSampleCount_ = 0;
                analyzeSpectrumAndTrackResonances();
            }
        }

        // 2. Каскадная фильтрация через активные адаптивные Notch-фильтры
        for (size_t s = 0; s < maxActiveNotches; ++s) {
            if (!notches_[s].active && std::fabs(notches_[s].currentGainDb) < 0.1f) continue;

            auto& curr = currentCoeffs_[s];
            const auto& target = targetCoeffs_[s];
            auto& st = states_[s];

            const float invChunk = 1.0f / static_cast<float>(chunk);
            const float db0 = (target.b0 - curr.b0) * invChunk;
            const float db1 = (target.b1 - curr.b1) * invChunk;
            const float db2 = (target.b2 - curr.b2) * invChunk;
            const float da1 = (target.a1 - curr.a1) * invChunk;
            const float da2 = (target.a2 - curr.a2) * invChunk;

            if (channels == 1) {
                float s1 = st.s1L;
                float s2 = st.s2L;

                for (size_t i = 0; i < chunk; ++i) {
                    curr.b0 += db0;
                    curr.b1 += db1;
                    curr.b2 += db2;
                    curr.a1 += da1;
                    curr.a2 += da2;

                    const size_t idx = processed + i;
                    const float x = output[idx];
                    const float y = curr.b0 * x + s1;
                    s1 = curr.b1 * x - curr.a1 * y + s2;
                    s2 = curr.b2 * x - curr.a2 * y;
                    output[idx] = y;
                }
                st.s1L = s1;
                st.s2L = s2;
            } else {
                float s1L = st.s1L, s2L = st.s2L;
                float s1R = st.s1R, s2R = st.s2R;

#if USE_WASM_SIMD
                v128_t vS1 = wasm_f32x4_make(s1L, s1R, 0.0f, 0.0f);
                v128_t vS2 = wasm_f32x4_make(s2L, s2R, 0.0f, 0.0f);

                for (size_t i = 0; i < chunk; ++i) {
                    curr.b0 += db0;
                    curr.b1 += db1;
                    curr.b2 += db2;
                    curr.a1 += da1;
                    curr.a2 += da2;

                    const size_t idx = (processed + i) * 2;
                    v128_t vX = wasm_f32x4_make(output[idx + 0], output[idx + 1], 0.0f, 0.0f);

                    v128_t vb0 = wasm_f32x4_splat(curr.b0);
                    v128_t vb1 = wasm_f32x4_splat(curr.b1);
                    v128_t vb2 = wasm_f32x4_splat(curr.b2);
                    v128_t va1 = wasm_f32x4_splat(curr.a1);
                    v128_t va2 = wasm_f32x4_splat(curr.a2);

                    // y = b0 * x + s1
                    v128_t vY = wasm_f32x4_add(wasm_f32x4_mul(vb0, vX), vS1);

                    // s1 = b1 * x - a1 * y + s2
                    v128_t vB1X = wasm_f32x4_mul(vb1, vX);
                    v128_t vA1Y = wasm_f32x4_mul(va1, vY);
                    vS1 = wasm_f32x4_add(wasm_f32x4_sub(vB1X, vA1Y), vS2);

                    // s2 = b2 * x - a2 * y
                    v128_t vB2X = wasm_f32x4_mul(vb2, vX);
                    v128_t vA2Y = wasm_f32x4_mul(va2, vY);
                    vS2 = wasm_f32x4_sub(vB2X, vA2Y);

                    output[idx + 0] = wasm_f32x4_extract_lane(vY, 0);
                    output[idx + 1] = wasm_f32x4_extract_lane(vY, 1);
                }

                st.s1L = wasm_f32x4_extract_lane(vS1, 0);
                st.s1R = wasm_f32x4_extract_lane(vS1, 1);
                st.s2L = wasm_f32x4_extract_lane(vS2, 0);
                st.s2R = wasm_f32x4_extract_lane(vS2, 1);
#else
                for (size_t i = 0; i < chunk; ++i) {
                    curr.b0 += db0;
                    curr.b1 += db1;
                    curr.b2 += db2;
                    curr.a1 += da1;
                    curr.a2 += da2;

                    const size_t idx = (processed + i) * 2;
                    const float xL = output[idx + 0];
                    const float xR = output[idx + 1];

                    const float yL = curr.b0 * xL + s1L;
                    s1L = curr.b1 * xL - curr.a1 * yL + s2L;
                    s2L = curr.b2 * xL - curr.a2 * yL;

                    const float yR = curr.b0 * xR + s1R;
                    s1R = curr.b1 * xR - curr.a1 * yR + s2R;
                    s2R = curr.b2 * xR - curr.a2 * yR;

                    output[idx + 0] = yL;
                    output[idx + 1] = yR;
                }
                st.s1L = s1L; st.s2L = s2L;
                st.s1R = s1R; st.s2R = s2R;
#endif
            }

            curr = target;
        }

        processed += chunk;
    }
}

} // namespace DAWCore
