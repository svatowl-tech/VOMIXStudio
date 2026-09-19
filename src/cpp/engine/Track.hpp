#pragma once

/**
 * ============================================================================
 * Track.hpp - Аудиодорожка микшера DAW (C++17, RT-Safe)
 * ============================================================================
 * Управляет набором аудиоклипов, цепочкой вокальной обработки VocalRack,
 * постоянной мощностью панорамирования (Constant Power Pan) и статической
 * буферизацией без динамических аллокаций в расчетном цикле.
 * ============================================================================
 */

#include "Clip.hpp"
#include "../dsp/AudioMath.hpp"
#include "../dsp/BiquadFilter.hpp"
#include "../dsp/Dynamics.hpp"
#include "../vocal/VocalRack.hpp"
#include <string>
#include <vector>
#include <memory>

namespace DAWCore {

/**
 * Класс Track - Дорожка микшера
 */
class Track {
public:
    uint32_t id{0};
    std::string name{"Track"};
    float volumeDb{0.0f};       // Уровень фейдера дорожки (-60 .. +12 dB)
    float pan{0.0f};            // Панорама (-1.0 .. +1.0)
    bool solo{false};           // Режим соло
    bool mute{false};           // Заглушение дорожки
    float sampleRate{48000.0f};

    // Набор клипов дорожки (резервируется заранее во избежание аллокаций)
    std::vector<Clip> clips;

    // Встроенная цепочка студийной обработки VocalRack
    VocalRack vocalRack;

    // Прямой доступ к компонентам для Embind и внешнего управления
    DeClicker& deClicker;
    DePlosive& dePlosive;
    NoiseGate& noiseGate;
    ParametricEQ3Band& eq;
    DeEsser& deEsser;
    SoftKneeCompressor& compressor;
    AutoDucker& autoDucker;

    // Предварительно выделенный RT-буфер дорожки (стерео сэмплы) - Zero Malloc
    alignas(16) float trackBuffer[MAX_BUFFER_SIZE * 2]{};

    Track(uint32_t trackId = 0, std::string trackName = "Track", float sr = 48000.0f);

    void setSampleRate(float sr) noexcept;
    void addClip(const Clip& clip);
    void clearClips() noexcept;
    bool removeClip(uint32_t clipId) noexcept;
    Clip* getClip(uint32_t clipId) noexcept;

    /**
     * Отрисовка клипов текущего временного среза в trackBuffer (RT-Safe)
     * @param timelinePosition Текущая позиция воспроизведения в сэмплах
     * @param numFrames Длина блока в кадрах
     */
    void renderClipsToBuffer(size_t timelinePosition, size_t numFrames) noexcept;

    /**
     * Обработка содержимого trackBuffer через встроенный вокальный процессор
     */
    void processVocalRack(const float* sidechainMono, size_t numFrames) noexcept;

    /**
     * Применение фейдера громкости и панорамы постоянной мощности к trackBuffer
     */
    void applyFaderAndPan(size_t numFrames) noexcept;
};

} // namespace DAWCore
