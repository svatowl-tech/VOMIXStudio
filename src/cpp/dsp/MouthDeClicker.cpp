/**
 * ============================================================================
 * MouthDeClicker.cpp - Реализация реставратора щелчков рта и слюны (C++17)
 * ============================================================================
 * Дифференциальный анализ высших производных, детектор аномалий ВЧ и бесшовная
 * кубическая сплайновая интерполяция Эрмита (C1 Continuity).
 * ============================================================================
 */

#include "MouthDeClicker.hpp"
#include <algorithm>
#include <cmath>

namespace DAWCore {

MouthDeClicker::MouthDeClicker(float sampleRate) noexcept {
    constexpr size_t cap = LOOKAHEAD_SAMPLES * 2;
    ringBufL_.assign(cap, 0.0f);
    ringBufR_.assign(cap, 0.0f);
    anomalyScoresL_.assign(cap, 0.0f);
    anomalyScoresR_.assign(cap, 0.0f);

    setSampleRate(sampleRate);
}

void MouthDeClicker::setSampleRate(float sampleRate) noexcept {
    sampleRate_ = (sampleRate > 8000.0f) ? sampleRate : 48000.0f;
    updateHPFFilter();
    reset();
}

void MouthDeClicker::setParams(const MouthDeClickerParams& params) noexcept {
    params_ = params;
    updateHPFFilter();
}

void MouthDeClicker::reset() noexcept {
    hpfStates_[0].reset();
    hpfStates_[1].reset();

    for (auto& hist : diffHistory_) {
        hist.fill(0.0f);
    }

    movingVariance_ = { 0.001f, 0.001f };
    std::fill(ringBufL_.begin(), ringBufL_.end(), 0.0f);
    std::fill(ringBufR_.begin(), ringBufR_.end(), 0.0f);
    std::fill(anomalyScoresL_.begin(), anomalyScoresL_.end(), 0.0f);
    std::fill(anomalyScoresR_.begin(), anomalyScoresR_.end(), 0.0f);

    ringWritePos_ = 0;
    totalClicksRepaired_ = 0;
}

void MouthDeClicker::updateHPFFilter() noexcept {
    // 2-полюсный ФВЧ Баттерворта (Butterworth Highpass Filter 2nd Order)
    const double nyquist = 0.485 * static_cast<double>(sampleRate_);
    const double fc = std::max(1000.0, std::min(nyquist, static_cast<double>(params_.highPassCutoff)));
    constexpr double Q = 0.70710678;

    const double w0 = (TWO_PI_F * fc) / static_cast<double>(sampleRate_);
    const double cosW = std::cos(w0);
    const double sinW = std::sin(w0);
    const double alpha = sinW / (2.0 * Q);

    const double b0 = (1.0 + cosW) * 0.5;
    const double b1 = -(1.0 + cosW);
    const double b2 = (1.0 + cosW) * 0.5;
    const double a0 = 1.0 + alpha;
    const double a1 = -2.0 * cosW;
    const double a2 = 1.0 - alpha;

    const double invA0 = 1.0 / a0;
    hpfCoeffs_.b0 = static_cast<float>(b0 * invA0);
    hpfCoeffs_.b1 = static_cast<float>(b1 * invA0);
    hpfCoeffs_.b2 = static_cast<float>(b2 * invA0);
    hpfCoeffs_.a1 = static_cast<float>(a1 * invA0);
    hpfCoeffs_.a2 = static_cast<float>(a2 * invA0);

    // Коэффициент скользящей дисперсии (~20 мс)
    varCoeff_ = std::exp(-1.0f / (0.020f * sampleRate_));
}

void MouthDeClicker::repairRegionHermite(
    std::vector<float>& buf,
    size_t startIdx,
    size_t endIdx,
    size_t bufCap
) noexcept {
    // Длина поврежденной зоны
    const size_t len = (endIdx >= startIdx) ? (endIdx - startIdx + 1) : (endIdx + bufCap - startIdx + 1);
    if (len < 2 || len > 200) return;

    // Опорные точки до щелчка (n0 - 3, n0 - 2, n0 - 1)
    const size_t idxP0 = (startIdx + bufCap - 1) % bufCap;
    const size_t idxP0_prev = (startIdx + bufCap - 3) % bufCap;

    // Опорные точки после щелчка (n1 + 1, n1 + 2, n1 + 3)
    const size_t idxP1 = (endIdx + 1) % bufCap;
    const size_t idxP1_next = (endIdx + 3) % bufCap;

    const float p0 = buf[idxP0];
    const float p1 = buf[idxP1];

    // Оценка граничных производных (касательных наклона формы волны)
    const float m0 = (p0 - buf[idxP0_prev]) * 0.5f;
    const float m1 = (buf[idxP1_next] - p1) * 0.5f;

    // Масштабный коэффициент шага сетки
    const float span = static_cast<float>(len + 1);

    // Кубическая сплайновая интерполяция Эрмита (C1 непрерывность функции и производной)
    for (size_t i = 0; i < len; ++i) {
        const float t = static_cast<float>(i + 1) / span;
        const float t2 = t * t;
        const float t3 = t2 * t;

        // Базисные полиномы Эрмита
        const float h00 = 2.0f * t3 - 3.0f * t2 + 1.0f;
        const float h10 = t3 - 2.0f * t2 + t;
        const float h01 = -2.0f * t3 + 3.0f * t2;
        const float h11 = t3 - t2;

        const float repairedVal = h00 * p0 + h10 * (m0 * span) + h01 * p1 + h11 * (m1 * span);

        const size_t writeIdx = (startIdx + i) % bufCap;
        buf[writeIdx] = repairedVal;
    }
}

void MouthDeClicker::processChannelLookahead(
    const float* input,
    float* output,
    size_t numFrames,
    size_t ch
) noexcept {
    auto& ringBuf = (ch == 0) ? ringBufL_ : ringBufR_;
    auto& scores = (ch == 0) ? anomalyScoresL_ : anomalyScoresR_;
    auto& hpfState = hpfStates_[ch];
    auto& diffHist = diffHistory_[ch];
    float& movVar = movingVariance_[ch];

    const size_t bufCap = ringBuf.size();
    const size_t lookahead = LOOKAHEAD_SAMPLES;
    const size_t checkDelay = lookahead / 2; // Точка проверки в центре буфера упреждения

    // Порог аномальности в зависимости от чувствительности
    const float thresh = 22.0f - (params_.sensitivity * 16.0f); // 6.0 .. 22.0
    const size_t maxDur = std::min(static_cast<size_t>(144), params_.maxClickDurationSamples);
    const size_t margin = params_.wideningMargin;

    const float b0 = hpfCoeffs_.b0, b1 = hpfCoeffs_.b1, b2 = hpfCoeffs_.b2;
    const float a1 = hpfCoeffs_.a1, a2 = hpfCoeffs_.a2;

    for (size_t i = 0; i < numFrames; ++i) {
        const float x = input[i];

        // 1. Выделение ВЧ энергии щелчка через ФВЧ (TDF-II)
        const float yHpf = b0 * x + hpfState.s1;
        hpfState.s1 = b1 * x - a1 * yHpf + hpfState.s2;
        hpfState.s2 = b2 * x - a2 * yHpf;

        // 2. Расчет 2-й и 3-й дискретных производных формы волны
        const float x0 = yHpf;
        const float x1 = diffHist[0];
        const float x2 = diffHist[1];
        const float x3 = diffHist[2];

        diffHist[2] = x2;
        diffHist[1] = x1;
        diffHist[0] = x0;

        // d2 = x[n] - 2x[n-1] + x[n-2]
        const float d2 = x0 - 2.0f * x1 + x2;
        // d3 = x[n] - 3x[n-1] + 3x[n-2] - x[n-3]
        const float d3 = x0 - 3.0f * x1 + 3.0f * x2 - x3;

        // Комплексная метрика разрывного импульса щелчка слюны
        const float impulseMetric = 0.45f * std::fabs(d2) + 0.55f * std::fabs(d3);

        // Обновление скользящей дисперсии фонового контекста
        movVar = varCoeff_ * movVar + (1.0f - varCoeff_) * impulseMetric;

        // Отношение импульсной аномалии к фону
        const float anomaly = impulseMetric / (movVar + 1e-7f);

        // 3. Запись в кольцевой буфер упреждения
        const size_t writePos = ringWritePos_;
        ringBuf[writePos] = x;
        scores[writePos] = anomaly;

        // 4. Детекция и реконструкция в центре буфера Lookahead
        const size_t checkPos = (writePos + bufCap - checkDelay) % bufCap;
        const float centerScore = scores[checkPos];

        if (centerScore > thresh) {
            const size_t prevPos = (checkPos + bufCap - 1) % bufCap;
            const size_t nextPos = (checkPos + 1) % bufCap;

            // Локальный максимум аномалии
            if (centerScore >= scores[prevPos] && centerScore >= scores[nextPos]) {
                const float baselineThresh = thresh * 0.35f;

                // Поиск левой границы щелчка
                size_t startPos = checkPos;
                for (size_t b = 1; b <= maxDur / 2; ++b) {
                    const size_t p = (checkPos + bufCap - b) % bufCap;
                    if (scores[p] <= baselineThresh) {
                        startPos = p;
                        break;
                    }
                    startPos = p;
                }

                // Поиск правой границы щелчка
                size_t endPos = checkPos;
                for (size_t f = 1; f <= maxDur / 2; ++f) {
                    const size_t p = (checkPos + f) % bufCap;
                    if (scores[p] <= baselineThresh) {
                        endPos = p;
                        break;
                    }
                    endPos = p;
                }

                // Расширение охвата на wideningMargin
                startPos = (startPos + bufCap - margin) % bufCap;
                endPos = (endPos + margin) % bufCap;

                // Бесшовное замещение поврежденного участка кубическим сплайном Эрмита
                repairRegionHermite(ringBuf, startPos, endPos, bufCap);

                // Очистка оценок аномалий в отремонтированном окне
                const size_t repLen = (endPos >= startPos) ? (endPos - startPos + 1) : (endPos + bufCap - startPos + 1);
                for (size_t r = 0; r < repLen; ++r) {
                    scores[(startPos + r) % bufCap] = 0.0f;
                }

                totalClicksRepaired_++;
            }
        }

        // 5. Выгрузка чистого задержанного сэмпла
        const size_t readPos = (writePos + bufCap - lookahead) % bufCap;
        output[i] = ringBuf[readPos];
    }
}

void MouthDeClicker::processBlock(float* samples, size_t numFrames, int channels) noexcept {
    processBlock(samples, samples, numFrames, channels);
}

void MouthDeClicker::processBlock(
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

    if (channels == 1) {
        processChannelLookahead(input, output, numFrames, 0);
        ringWritePos_ = (ringWritePos_ + numFrames) % ringBufL_.size();
    } else {
        alignas(16) float tempInL[1024];
        alignas(16) float tempInR[1024];
        alignas(16) float tempOutL[1024];
        alignas(16) float tempOutR[1024];

        size_t processed = 0;
        const size_t initialWritePos = ringWritePos_;

        while (processed < numFrames) {
            const size_t chunk = std::min(static_cast<size_t>(1024), numFrames - processed);

            for (size_t i = 0; i < chunk; ++i) {
                const size_t idx = (processed + i) * 2;
                tempInL[i] = input[idx + 0];
                tempInR[i] = input[idx + 1];
            }

            // Обработка левого канала
            ringWritePos_ = initialWritePos;
            processChannelLookahead(tempInL, tempOutL, chunk, 0);

            // Обработка правого канала
            ringWritePos_ = initialWritePos;
            processChannelLookahead(tempInR, tempOutR, chunk, 1);

            ringWritePos_ = (initialWritePos + chunk) % ringBufL_.size();

            for (size_t i = 0; i < chunk; ++i) {
                const size_t idx = (processed + i) * 2;
                output[idx + 0] = tempOutL[i];
                output[idx + 1] = tempOutR[i];
            }

            processed += chunk;
        }
    }
}

} // namespace DAWCore
