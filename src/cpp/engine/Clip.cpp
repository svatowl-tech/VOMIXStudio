/**
 * ============================================================================
 * Clip.cpp - Реализация методов аудиоклипа (C++17)
 * ============================================================================
 */

#include "Clip.hpp"
#include <cmath>

namespace DAWCore {

float Clip::getFadeGain(size_t sampleIndexInClip) const noexcept {
    float fadeGain = 1.0f;

    // Плавное нарастание (Fade In) - косинусное сглаживание
    if (fadeInSamples > 0 && sampleIndexInClip < fadeInSamples) {
        float t = static_cast<float>(sampleIndexInClip) / static_cast<float>(fadeInSamples);
        fadeGain *= 0.5f * (1.0f - std::cos(t * PI_F));
    }

    // Плавное затухание (Fade Out) - косинусное сглаживание
    if (fadeOutSamples > 0 && lengthSamples > fadeOutSamples) {
        size_t fadeOutStart = lengthSamples - fadeOutSamples;
        if (sampleIndexInClip >= fadeOutStart) {
            size_t fadePos = sampleIndexInClip - fadeOutStart;
            float t = static_cast<float>(fadePos) / static_cast<float>(fadeOutSamples);
            fadeGain *= 0.5f * (1.0f + std::cos(t * PI_F));
        }
    }

    return fadeGain;
}

} // namespace DAWCore
