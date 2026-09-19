#pragma once

/**
 * ============================================================================
 * ClipEditor.hpp - Модуль нарезки и редактирования аудиоклипов в WASM (C++17)
 * ============================================================================
 * Обеспечивает выполнение ресурсоемких операций редактирования непосредственно
 * в памяти C++ / WebAssembly:
 * 1. Split (разделение клипа) с расчетом антикликовых микро-фейдов без копирования сэмплов через JS.
 * 2. Trim (подрезка границ In/Out).
 * 3. WSOLA Time Stretch прямо в памяти буфера клипа с обновлением его длины.
 * ============================================================================
 */

#include "WSOLATimeStretch.hpp"
#include "../engine/Clip.hpp"
#include "../engine/Track.hpp"
#include "../engine/Mixer.hpp"
#include <cstdint>
#include <cstddef>
#include <vector>

namespace DAWCore {

/**
 * Класс ClipSliceManager - Менеджер нарезки, тримминга и растяжения клипов
 */
class ClipSliceManager {
public:
    static Mixer* s_activeMixer;
    static std::vector<float*> s_allocatedBuffers;

    static void setActiveMixer(Mixer* mixer) noexcept;
    static Mixer* getActiveMixer() noexcept;

    /**
     * Мгновенное разделение аудиоклипа на два сегмента внутри кучи WASM
     * с расчетом микро-фейдов (Zero-Copy через JS).
     * @param clipPtr Указатель на структуру Clip в памяти C++
     * @param splitSampleOffset Смещение точки разделения относительно начала клипа
     * @return Указатель на созданный второй сегмент Clip (uintptr_t)
     */
    static uintptr_t splitClip(uintptr_t clipPtr, size_t splitSampleOffset);

    /**
     * Разделение клипа на дорожке по trackId и clipId с автоматическим добавлением
     * правого клипа в коллекцию track->clips
     * @param trackId Идентификатор дорожки
     * @param clipId Идентификатор разделяемого клипа
     * @param splitSampleOffset Смещение точки разреза в сэмплах
     * @param newClipId Идентификатор для нового правого клипа (если 0, генерируется автоматически)
     * @return true в случае успешного разделения
     */
    static bool splitClipInTrack(
        uint32_t trackId,
        uint32_t clipId,
        size_t splitSampleOffset,
        uint32_t newClipId = 0
    );

    /**
     * Выполнение алгоритма WSOLA прямо в буфере клипа с обновлением его длины
     * @param trackId Идентификатор дорожки
     * @param clipId Идентификатор клипа
     * @param ratio Коэффициент растяжения (0.5 .. 2.0)
     * @return Указатель на новый буфер сэмплов в памяти WASM (uintptr_t)
     */
    static uintptr_t applyTimeStretchToClip(
        uint32_t trackId,
        uint32_t clipId,
        float ratio
    );

    /**
     * Выполнение WSOLA по прямому указателю на Clip
     * @param clip Указатель на Clip
     * @param ratio Коэффициент растяжения (0.5 .. 2.0)
     * @return Указатель на новый буфер сэмплов (uintptr_t)
     */
    static uintptr_t applyTimeStretchToClipPtr(Clip* clip, float ratio);

    /**
     * Тримминг начала клипа (Trim In-point) со смещением указателя на PCM буфер
     */
    static bool trimClipStart(uintptr_t clipPtr, size_t trimSamples);

    /**
     * Тримминг конца клипа (Trim Out-point)
     */
    static bool trimClipEnd(uintptr_t clipPtr, size_t newLengthSamples);

    /**
     * Прямая нарезка аудиосегмента в памяти кучи WASM с микро-фейдами (1-2 мс) для исключения щелчков
     * @param inPcmPtr Указатель на исходный массив PCM сэмплов (Float32)
     * @param totalFrames Общая длина входного буфера в кадрах (frames)
     * @param splitFrameOffset Смещение точки разделения в кадрах
     * @param outLeftPcmPtr Указатель на буфер для левой половины (размер: splitFrameOffset * channels)
     * @param outRightPcmPtr Указатель на буфер для правой половины (размер: (totalFrames - splitFrameOffset) * channels)
     * @param channels Количество каналов (1 = моно, 2 = стерео interleaved)
     * @return true в случае успешного разделения
     */
    static bool splitClipNative(
        uintptr_t inPcmPtr,
        size_t totalFrames,
        size_t splitFrameOffset,
        uintptr_t outLeftPcmPtr,
        uintptr_t outRightPcmPtr,
        int channels = 2
    );

    /**
     * Очистка всех буферов, динамически выделенных для time stretch
     */
    static void freeAllocatedBuffers() noexcept;
};

} // namespace DAWCore
