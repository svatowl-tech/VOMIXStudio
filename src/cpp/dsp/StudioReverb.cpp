/**
 * ============================================================================
 * StudioReverb.cpp - Алгоритмический ревербератор студийного качества (C++17)
 * ============================================================================
 * Реализация параллельно-последовательной топологии реверберации Schroeder/Moorer
 * с 8 гребенчатыми фильтрами, 4 фазовыми диффузорами, Pre-Delay и Low Cut.
 * ============================================================================
 */

#include "StudioReverb.hpp"
#include <cmath>
#include <algorithm>

namespace DAWCore {

// Базовые длины линий задержки для 44.1 кГц (взаимно простые числа для устранения резонансов)
static constexpr int COMB_TUNINGS[StudioReverb::NUM_COMBS] = {
    1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617
};

static constexpr int ALLPASS_TUNINGS[StudioReverb::NUM_ALLPASS] = {
    556, 441, 341, 225
};

static constexpr int STEREO_SPREAD = 23; // Смещение задержки правого канала для псевдо-стерео

// ============================================================================
// Реализация CombFilter
// ============================================================================

void CombFilter::init(size_t size) noexcept {
    bufferSize_ = std::max<size_t>(16, size);
    buffer_.assign(bufferSize_, 0.0f);
    bufferIndex_ = 0;
    filterStore_ = 0.0f;
}

void CombFilter::reset() noexcept {
    std::fill(buffer_.begin(), buffer_.end(), 0.0f);
    bufferIndex_ = 0;
    filterStore_ = 0.0f;
}

// ============================================================================
// Реализация AllpassFilter
// ============================================================================

void AllpassFilter::init(size_t size) noexcept {
    bufferSize_ = std::max<size_t>(16, size);
    buffer_.assign(bufferSize_, 0.0f);
    bufferIndex_ = 0;
}

void AllpassFilter::reset() noexcept {
    std::fill(buffer_.begin(), buffer_.end(), 0.0f);
    bufferIndex_ = 0;
}

// ============================================================================
// Реализация StudioReverb
// ============================================================================

StudioReverb::StudioReverb() noexcept {
    setSampleRate(48000.0f);
}

StudioReverb::StudioReverb(float sampleRate) noexcept {
    setSampleRate(sampleRate);
}

void StudioReverb::setSampleRate(float sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;

    // Выделение памяти под Pre-Delay буфер (максимум 250 мс)
    preDelayBufferSize_ = static_cast<size_t>((MAX_PREDELAY_MS * 0.001f) * sampleRate_) + 64;
    preDelayBufferL_.assign(preDelayBufferSize_, 0.0f);
    preDelayBufferR_.assign(preDelayBufferSize_, 0.0f);
    preDelayWriteIndex_ = 0;

    const float rateScale = sampleRate_ / 44100.0f;

    // Инициализация 8 гребенчатых фильтров для каждого канала
    for (size_t i = 0; i < NUM_COMBS; ++i) {
        const size_t sizeL = static_cast<size_t>(COMB_TUNINGS[i] * rateScale);
        const size_t sizeR = static_cast<size_t>((COMB_TUNINGS[i] + STEREO_SPREAD) * rateScale);

        combFiltersL_[i].init(sizeL);
        combFiltersR_[i].init(sizeR);
    }

    // Инициализация 4 фазовых фильтров для каждого канала
    for (size_t i = 0; i < NUM_ALLPASS; ++i) {
        const size_t sizeL = static_cast<size_t>(ALLPASS_TUNINGS[i] * rateScale);
        const size_t sizeR = static_cast<size_t>((ALLPASS_TUNINGS[i] + STEREO_SPREAD) * rateScale);

        allpassFiltersL_[i].init(sizeL);
        allpassFiltersR_[i].init(sizeR);
        allpassFiltersL_[i].setFeedback(0.5f);
        allpassFiltersR_[i].setFeedback(0.5f);
    }

    reset();
    updateInternalParameters();
}

void StudioReverb::setParams(const ReverbParams& params) noexcept {
    params_ = params;
    updateInternalParameters();
}

void StudioReverb::reset() noexcept {
    std::fill(preDelayBufferL_.begin(), preDelayBufferL_.end(), 0.0f);
    std::fill(preDelayBufferR_.begin(), preDelayBufferR_.end(), 0.0f);
    preDelayWriteIndex_ = 0;

    for (size_t i = 0; i < NUM_COMBS; ++i) {
        combFiltersL_[i].reset();
        combFiltersR_[i].reset();
    }

    for (size_t i = 0; i < NUM_ALLPASS; ++i) {
        allpassFiltersL_[i].reset();
        allpassFiltersR_[i].reset();
    }

    hpStoreL_ = 0.0f;
    hpStoreR_ = 0.0f;
}

void StudioReverb::updateInternalParameters() noexcept {
    // 1. Расчет длины Pre-Delay
    const size_t targetPreDelay = static_cast<size_t>((std::max(0.0f, params_.preDelayMs) * 0.001f) * sampleRate_);
    preDelayFrames_ = std::min(preDelayBufferSize_ - 1, targetPreDelay);

    // 2. Обратная связь гребенок (масштабирование размера комнаты)
    // Диапазон feedback от 0.70 (сухая маленькая комната) до 0.97 (большой собор)
    const float roomSizeClamped = std::max(0.0f, std::min(1.0f, params_.roomSize));
    const float feedback = 0.70f + (roomSizeClamped * 0.27f);

    // 3. Затухание верхних частот (Damping)
    const float dampingClamped = std::max(0.0f, std::min(1.0f, params_.damping));
    const float dampValue = dampingClamped * 0.45f;

    for (size_t i = 0; i < NUM_COMBS; ++i) {
        combFiltersL_[i].setFeedback(feedback);
        combFiltersR_[i].setFeedback(feedback);
        combFiltersL_[i].setDamp(dampValue);
        combFiltersR_[i].setDamp(dampValue);
    }

    // 4. Стереоматрица и баланс Dry / Wet
    const float wetClamped = std::max(0.0f, std::min(1.0f, params_.wetDryMix));
    const float widthClamped = std::max(0.0f, std::min(1.0f, params_.stereoWidth));

    dryGain_ = 1.0f - wetClamped;
    wetGain1_ = wetClamped * (1.0f + widthClamped) * 0.5f;
    wetGain2_ = wetClamped * (1.0f - widthClamped) * 0.5f;

    // 5. Входной Low Cut фильтр 1-го порядка
    const float cutHz = std::max(20.0f, std::min(params_.lowCutHz, sampleRate_ * 0.4f));
    const float w = TWO_PI_F * cutHz / sampleRate_;
    lowCutCoeff_ = w / (w + 1.0f); // Коэффициент фильтра высоких частот
}

void StudioReverb::processBlock(
    const float* inL,
    const float* inR,
    float* outL,
    float* outR,
    size_t numFrames
) noexcept {
    if (!inL || !outL || numFrames == 0) return;

    // В случае отключения - прямой байпас
    if (!params_.enabled) {
        if (inL != outL) std::copy(inL, inL + numFrames, outL);
        if (inR && outR && inR != outR) std::copy(inR, inR + numFrames, outR);
        return;
    }

    const bool hasStereoInput = (inR != nullptr && outR != nullptr);

    for (size_t f = 0; f < numFrames; ++f) {
        const float sampleInL = inL[f];
        const float sampleInR = hasStereoInput ? inR[f] : sampleInL;

        // 1. Входной High-Pass фильтр (Low Cut) для очистки суббаса
        hpStoreL_ += lowCutCoeff_ * (sampleInL - hpStoreL_);
        const float filteredInL = sampleInL - hpStoreL_;

        hpStoreR_ += lowCutCoeff_ * (sampleInR - hpStoreR_);
        const float filteredInR = sampleInR - hpStoreR_;

        // 2. Pre-Delay (кольцевой буфер разделения прямого звука и реверберации)
        preDelayBufferL_[preDelayWriteIndex_] = filteredInL;
        preDelayBufferR_[preDelayWriteIndex_] = filteredInR;

        const size_t readIndex = (preDelayWriteIndex_ + preDelayBufferSize_ - preDelayFrames_) % preDelayBufferSize_;
        const float delayedInL = preDelayBufferL_[readIndex];
        const float delayedInR = preDelayBufferR_[readIndex];

        if (++preDelayWriteIndex_ >= preDelayBufferSize_) {
            preDelayWriteIndex_ = 0;
        }

        // Входной уровень в гребенчатые фильтры
        const float combInput = (delayedInL + delayedInR) * 0.015f;

        // 3. Параллельные гребенчатые фильтры (8 штук на канал)
        float combOutL = 0.0f;
        float combOutR = 0.0f;

        for (size_t c = 0; c < NUM_COMBS; ++c) {
            combOutL += combFiltersL_[c].process(combInput);
            combOutR += combFiltersR_[c].process(combInput);
        }

        // 4. Последовательные фазовые диффузоры (4 штуки на канал)
        float diffL = combOutL;
        float diffR = combOutR;

        for (size_t a = 0; a < NUM_ALLPASS; ++a) {
            diffL = allpassFiltersL_[a].process(diffL);
            diffR = allpassFiltersR_[a].process(diffR);
        }

        // 5. Пространственная матрица и подмешивание сухого сигнала (Dry/Wet)
        outL[f] = (sampleInL * dryGain_) + (diffL * wetGain1_) + (diffR * wetGain2_);
        if (hasStereoInput) {
            outR[f] = (sampleInR * dryGain_) + (diffR * wetGain1_) + (diffL * wetGain2_);
        }
    }
}

void StudioReverb::processBlock(float* interleavedInOut, size_t numFrames, int channels) noexcept {
    if (!interleavedInOut || numFrames == 0 || channels <= 0) return;

    if (!params_.enabled) return;

    if (channels == 1) {
        processBlock(interleavedInOut, nullptr, interleavedInOut, nullptr, numFrames);
    } else {
        // Выделение стекового блока сэмплов для раздельной обработки каналов (Zero Alloc)
        constexpr size_t STACK_CHUNK = 256;
        float splitL[STACK_CHUNK];
        float splitR[STACK_CHUNK];

        size_t processed = 0;
        while (processed < numFrames) {
            const size_t chunk = std::min(STACK_CHUNK, numFrames - processed);
            const size_t offset = processed * 2;

            for (size_t i = 0; i < chunk; ++i) {
                splitL[i] = interleavedInOut[offset + (i * 2) + 0];
                splitR[i] = interleavedInOut[offset + (i * 2) + 1];
            }

            processBlock(splitL, splitR, splitL, splitR, chunk);

            for (size_t i = 0; i < chunk; ++i) {
                interleavedInOut[offset + (i * 2) + 0] = splitL[i];
                interleavedInOut[offset + (i * 2) + 1] = splitR[i];
            }

            processed += chunk;
        }
    }
}

} // namespace DAWCore
