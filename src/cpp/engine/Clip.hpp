#pragma once

/**
 * ============================================================================
 * Clip.hpp - Аудиосегмент (клип) на таймлайне дорожки (C++17)
 * ============================================================================
 * Описывает аудиоклип: позиция старта на таймлайне, длина, плавные фейды (Fade In/Out),
 * громкость, панорама, ссылка на PCM буфер в памяти.
 * Полностью RT-Safe: не содержит динамических аллокаций.
 * 
 * Стандартизация размерностей (Строго во ФРЕЙМАХ):
 * - offsetSamples — это ВСЕГДА смещение во ФРЕЙМАХ (1 сек = 48 000).
 * - lengthSamples — это ВСЕГДА длина во ФРЕЙМАХ (1 сек = 48 000).
 * - При обращении к float* buffer индекс: sampleIndex = frameOffset * channels.
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
    size_t bufferSizeSamples{0};       // Общий размер буфера клипа (во ФРЕЙМАХ)
    size_t offsetSamples{0};           // Позиция старта клипа на таймлайне проекта (во ФРЕЙМАХ)
    size_t lengthSamples{0};           // Длина воспроизводимой части клипа (во ФРЕЙМАХ)
    float gain{1.0f};                  // Громкость клипа (0.0 .. 2.0+)
    float pan{0.0f};                   // Панорама клипа (-1.0 .. +1.0)
    size_t fadeInSamples{0};           // Длина плавного нарастания во фреймах (Fade In)
    size_t fadeOutSamples{0};          // Длина плавного затухания во фреймах (Fade Out)
    bool isStereo{false};              // true = стерео interleaved, false = моно
    bool active{true};                 // Флаг активности

    Clip() noexcept = default;

    /**
     * Возвращает смещение клипа на таймлайне во ФРЕЙМАХ
     */
    inline size_t getOffsetFrames() const noexcept {
        return offsetSamples;
    }

    /**
     * Возвращает длину клипа во ФРЕЙМАХ
     */
    inline size_t getLengthFrames() const noexcept {
        return lengthSamples;
    }

    /**
     * Расчет коэффициента плавного фейда для заданного фрейма внутри клипа
     * @param frameIndexInClip Индекс фрейма от начала воспроизводимой части клипа
     */
    float getFadeGain(size_t frameIndexInClip) const noexcept;
};

} // namespace DAWCore
