/**
 * ============================================================================
 * SmartBreathController.cpp - Реализация контроллера дыхания (C++17)
 * ============================================================================
 * Детекция невокализованных шумов вдоха по спектральному балансу и ZCR
 * с упреждающей Lookahead-аттенюацией и гладкой S-образной огибающей.
 * ============================================================================
 */

#include "SmartBreathController.hpp"
#include <algorithm>

namespace DAWCore {

SmartBreathController::SmartBreathController(float sampleRate) noexcept {
    lookaheadBufL_.assign(MAX_LOOKAHEAD_SAMPLES, 0.0f);
    lookaheadBufR_.assign(MAX_LOOKAHEAD_SAMPLES, 0.0f);
    setSampleRate(sampleRate);
}

void SmartBreathController::setSampleRate(float sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;
    updateDetectorFilters();
    reset();
}

void SmartBreathController::setParams(const BreathControllerParams& params) noexcept {
    params_ = params;
    updateDetectorFilters();
}

void SmartBreathController::reset() noexcept {
    voiceLpState_.reset();
    breathBpState_.reset();

    voiceEnergy_ = 0.0f;
    breathEnergy_ = 0.0f;
    totalRmsEnergy_ = 0.0f;

    lastMonoSample_ = 0.0f;
    zcrSmooth_ = 0.0f;

    breathDetected_ = false;
    breathHoldCounter_ = 0;
    breathOnsetCounter_ = 0;

    currentGainLinear_ = 1.0f;
    targetGainLinear_ = 1.0f;
    currentGainDb_ = 0.0f;

    std::fill(lookaheadBufL_.begin(), lookaheadBufL_.end(), 0.0f);
    std::fill(lookaheadBufR_.begin(), lookaheadBufR_.end(), 0.0f);
    lookaheadWritePos_ = 0;
}

void SmartBreathController::updateDetectorFilters() noexcept {
    // 1. Расчет задержки упреждения Lookahead
    const size_t targetSamples = static_cast<size_t>(
        std::max(0.002f, params_.lookaheadMs * 0.001f) * sampleRate_
    );
    lookaheadSamples_ = std::min(MAX_LOOKAHEAD_SAMPLES - 1, targetSamples);

    // 2. Коэффициенты огибающей и S-curve баллистики
    const float attSec = std::max(0.002f, params_.attackMs * 0.001f);
    const float relSec = std::max(0.005f, params_.releaseMs * 0.001f);

    attackAlpha_ = 1.0f - std::exp(-1.0f / (attSec * sampleRate_));
    releaseAlpha_ = 1.0f - std::exp(-1.0f / (relSec * sampleRate_));

    // Быстрый детектор энергии (окно ~ 6 мс)
    envCoeff_ = std::exp(-1.0f / (0.006f * sampleRate_));
    // Сглаживание ZCR (окно ~ 10 мс)
    zcrCoeff_ = std::exp(-1.0f / (0.010f * sampleRate_));

    // 3. ФНЧ 400 Гц для основного тона голоса (Butterworth 2nd order LPF)
    {
        constexpr double f0 = 400.0;
        const double w0 = (TWO_PI_F * f0) / static_cast<double>(sampleRate_);
        const double cosW = std::cos(w0);
        const double sinW = std::sin(w0);
        const double alpha = sinW / (2.0 * 0.7071);

        const double b0 = (1.0 - cosW) * 0.5;
        const double b1 = 1.0 - cosW;
        const double b2 = (1.0 - cosW) * 0.5;
        const double a0 = 1.0 + alpha;
        const double a1 = -2.0 * cosW;
        const double a2 = 1.0 - alpha;

        const double invA0 = 1.0 / a0;
        voiceLpCoeffs_.b0 = static_cast<float>(b0 * invA0);
        voiceLpCoeffs_.b1 = static_cast<float>(b1 * invA0);
        voiceLpCoeffs_.b2 = static_cast<float>(b2 * invA0);
        voiceLpCoeffs_.a1 = static_cast<float>(a1 * invA0);
        voiceLpCoeffs_.a2 = static_cast<float>(a2 * invA0);
    }

    // 4. Полосовой фильтр шума вдоха 2.8 кГц (BPF с Q=1.0, захватывает 1.8 - 4.2 кГц)
    {
        constexpr double f0 = 2800.0;
        constexpr double Q = 1.0;
        const double w0 = (TWO_PI_F * f0) / static_cast<double>(sampleRate_);
        const double cosW = std::cos(w0);
        const double sinW = std::sin(w0);
        const double alpha = sinW / (2.0 * Q);

        const double b0 = alpha;
        const double b1 = 0.0;
        const double b2 = -alpha;
        const double a0 = 1.0 + alpha;
        const double a1 = -2.0 * cosW;
        const double a2 = 1.0 - alpha;

        const double invA0 = 1.0 / a0;
        breathBpCoeffs_.b0 = static_cast<float>(b0 * invA0);
        breathBpCoeffs_.b1 = static_cast<float>(b1 * invA0);
        breathBpCoeffs_.b2 = static_cast<float>(b2 * invA0);
        breathBpCoeffs_.a1 = static_cast<float>(a1 * invA0);
        breathBpCoeffs_.a2 = static_cast<float>(a2 * invA0);
    }
}

void SmartBreathController::updateAnalysis(float monoSample) noexcept {
    // 1. Фильтрация TDF-II для голосовой полосы (< 400 Гц)
    const float yVoice = voiceLpCoeffs_.b0 * monoSample + voiceLpState_.s1L;
    voiceLpState_.s1L = voiceLpCoeffs_.b1 * monoSample - voiceLpCoeffs_.a1 * yVoice + voiceLpState_.s2L;
    voiceLpState_.s2L = voiceLpCoeffs_.b2 * monoSample - voiceLpCoeffs_.a2 * yVoice;

    // 2. Фильтрация TDF-II для дыхательной полосы (1.8 - 4.2 кГц)
    const float yBreath = breathBpCoeffs_.b0 * monoSample + breathBpState_.s1L;
    breathBpState_.s1L = breathBpCoeffs_.b1 * monoSample - breathBpCoeffs_.a1 * yBreath + breathBpState_.s2L;
    breathBpState_.s2L = breathBpCoeffs_.b2 * monoSample - breathBpCoeffs_.a2 * yBreath;

    // 3. Интеграторы энергии
    const float eSample = monoSample * monoSample;
    const float eVoice = yVoice * yVoice;
    const float eBreath = yBreath * yBreath;

    voiceEnergy_ = envCoeff_ * voiceEnergy_ + (1.0f - envCoeff_) * eVoice;
    breathEnergy_ = envCoeff_ * breathEnergy_ + (1.0f - envCoeff_) * eBreath;
    totalRmsEnergy_ = envCoeff_ * totalRmsEnergy_ + (1.0f - envCoeff_) * eSample;

    // 4. Детектор частоты пересечения нуля (Zero Crossing Rate)
    const bool zeroCross = (monoSample > 0.0f) != (lastMonoSample_ > 0.0f);
    lastMonoSample_ = monoSample;
    zcrSmooth_ = zcrCoeff_ * zcrSmooth_ + (1.0f - zcrCoeff_) * (zeroCross ? 1.0f : 0.0f);

    // 5. Оценка акустических критериев
    const float levelDb = 10.0f * std::log10(std::max(1e-10f, totalRmsEnergy_));
    const float spectralRatio = breathEnergy_ / (voiceEnergy_ + 1e-9f);

    // Порог спектрального отношения зависит от sensitivity (чем выше чувствительность, тем ниже порог)
    const float ratioThreshold = 1.7f - (params_.sensitivity * 1.05f); // 0.65 .. 1.7

    // Вдох должен находиться в коридоре уровней, иметь повышенную энергию в ВЧ-полосе и высокий ZCR
    const bool isWithinLevel = (levelDb >= params_.minLevelDb && levelDb <= params_.maxLevelDb);
    const bool isBreathSpectrum = (spectralRatio >= ratioThreshold);
    const bool isUnvoicedNoise = (zcrSmooth_ >= 0.11f);

    const bool instantaneousBreath = (isWithinLevel && isBreathSpectrum && isUnvoicedNoise);

    // Порог минимальной длительности вдоха (~35 мс) отсекает взрывные согласные ("т", "к", "п")
    const uint32_t onsetSamplesThreshold = static_cast<uint32_t>(0.035f * sampleRate_);
    const uint32_t holdSamplesCount = static_cast<uint32_t>(0.080f * sampleRate_); // 80 мс удержание

    if (instantaneousBreath) {
        if (breathOnsetCounter_ < onsetSamplesThreshold) {
            breathOnsetCounter_++;
        } else {
            breathDetected_ = true;
            breathHoldCounter_ = holdSamplesCount;
        }
    } else {
        breathOnsetCounter_ = 0;
        if (breathHoldCounter_ > 0) {
            breathHoldCounter_--;
        } else {
            breathDetected_ = false;
        }
    }

    // 6. Определение целевого усиления
    if (breathDetected_) {
        targetGainLinear_ = dbToGain(params_.targetReductionDb);
    } else {
        targetGainLinear_ = 1.0f;
    }

    // 7. Плавная S-образная интерполяция
    if (targetGainLinear_ < currentGainLinear_) {
        currentGainLinear_ += (targetGainLinear_ - currentGainLinear_) * attackAlpha_;
    } else {
        currentGainLinear_ += (targetGainLinear_ - currentGainLinear_) * releaseAlpha_;
    }

    currentGainDb_ = gainToDb(std::max(1e-5f, currentGainLinear_));
}

void SmartBreathController::processBlock(float* samples, size_t numFrames, int channels) noexcept {
    processBlock(samples, samples, numFrames, channels);
}

void SmartBreathController::processBlock(
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

    const size_t bufCap = MAX_LOOKAHEAD_SAMPLES;
    const size_t lookahead = lookaheadSamples_;
    const bool isStereo = (channels > 1);

    for (size_t i = 0; i < numFrames; ++i) {
        float xL = 0.0f;
        float xR = 0.0f;
        float monoSample = 0.0f;

        if (isStereo) {
            const size_t idx = i * 2;
            xL = input[idx + 0];
            xR = input[idx + 1];
            monoSample = (xL + xR) * 0.5f;
        } else {
            xL = input[i];
            monoSample = xL;
        }

        // 1. Обновление спектрально-статистического анализатора
        updateAnalysis(monoSample);

        // 2. Запись в кольцевой буфер упреждения (Lookahead Ring Buffer)
        lookaheadBufL_[lookaheadWritePos_] = xL;
        if (isStereo) lookaheadBufR_[lookaheadWritePos_] = xR;

        // 3. Чтение задержанного сигнала
        const size_t readPos = (lookaheadWritePos_ + bufCap - lookahead) % bufCap;
        const float delayedL = lookaheadBufL_[readPos];
        const float delayedR = isStereo ? lookaheadBufR_[readPos] : 0.0f;

        if (++lookaheadWritePos_ >= bufCap) lookaheadWritePos_ = 0;

        // 4. Применение плавной аттенюации к задержанному сигналу
        const float gain = currentGainLinear_;

        if (isStereo) {
            const size_t idx = i * 2;
            output[idx + 0] = delayedL * gain;
            output[idx + 1] = delayedR * gain;
        } else {
            output[i] = delayedL * gain;
        }
    }
}

} // namespace DAWCore
