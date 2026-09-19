#pragma once

/**
 * ============================================================================
 * Clip.hpp - Аудиосегмент (клип) на таймлайне дорожки (C++17)
 * ============================================================================
 * Описывает аудиоклип: позиция старта на таймлайне, длина, плавные фейды (Fade In/Out),
 * громкость, панорама, ссылка на PCM буфер в памяти.
 * Полностью RT-Safe: не содержит динамических аллокаций.
 * ============================================================================
 */

#include "../dsp/AudioMath.hpp"
#include <cstdint>
#include <cstddef>

namespace DAWCore {

/**
 * Структура Clip - Аудиоклип на дорожке
 */
struct Clip {
    uint32_t id{0};
    const float* sampleBuffer{nullptr}; // Указатель на 32-bit float буфер сэмплов
    size_t bufferSizeSamples{0};       // Общий размер буфера клипа (в сэмплах на канал)
    size_t offsetSamples{0};           // Позиция старта клипа на таймлайне проекта (в сэмплах)
    size_t lengthSamples{0};           // Длина воспроизводимой части клипа (в сэмплах)
    float gain{1.0f};                  // Громкость клипа (0.0 .. 2.0+)
    float pan{0.0f};                   // Панорама клипа (-1.0 .. +1.0)
    size_t fadeInSamples{0};           // Длина плавного нарастания (Fade In)
    size_t fadeOutSamples{0};          // Длина плавного затухания (Fade Out)
    bool isStereo{false};              // true = стерео interleaved, false = моно
    bool active{true};                 // Флаг активности

    Clip() noexcept = default;

    /**
     * Расчет коэффициента плавного фейда для заданного сэмпла внутри клипа
     * @param sampleIndexInClip Индекс сэмпла от начала воспроизводимой части клипа
     */
    float getFadeGain(size_t sampleIndexInClip) const noexcept;
};

} // namespace DAWCore
