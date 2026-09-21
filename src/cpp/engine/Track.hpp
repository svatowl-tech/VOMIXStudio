#pragma once

/**
 * ============================================================================
 * Track.hpp - Аудиодорожка микшера DAW (C++17, RT-Safe)
 * ============================================================================
 * Управляет набором аудиоклипов, цепочкой вокальной обработки VocalRack,
 * слотами VST-плагинов (IVSTPluginInstance), постоянной мощностью панорамирования
 * (Constant Power Pan) и статической буферизацией без динамических аллокаций.
 * ============================================================================
 */

#include "Clip.hpp"
#include "../dsp/AudioMath.hpp"
#include "../dsp/BiquadFilter.hpp"
#include "../dsp/Dynamics.hpp"
#include "../vocal/VocalRack.hpp"
#include "../../../c_src/vst/IVSTPluginInstance.hpp"
#include <string>
#include <vector>
#include <array>
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
    bool isOriginalAudio{false}; // Флаг оригинальной дорожки аудио/видео
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

    DeClicker* getDeClicker() const { return const_cast<DeClicker*>(&deClicker); }
    DePlosive* getDePlosive() const { return const_cast<DePlosive*>(&dePlosive); }
    NoiseGate* getNoiseGate() const { return const_cast<NoiseGate*>(&noiseGate); }
    ParametricEQ3Band* getEQ() const { return const_cast<ParametricEQ3Band*>(&eq); }
    DeEsser* getDeEsser() const { return const_cast<DeEsser*>(&deEsser); }
    SoftKneeCompressor* getCompressor() const { return const_cast<SoftKneeCompressor*>(&compressor); }
    AutoDucker* getAutoDucker() const { return const_cast<AutoDucker*>(&autoDucker); }

    // 8 VST-слотов дорожки с умными указателями на IVSTPluginInstance
    std::array<std::unique_ptr<vomix::vst::IVSTPluginInstance>, 8> vstSlots;

    // Предварительно выделенный RT-буфер дорожки (стерео сэмплы) - Zero Malloc
    alignas(16) float trackBuffer[MAX_BUFFER_SIZE * 2]{};

    // Буферы раздельных каналов для вызова processBlock(float** in, float** out)
    alignas(16) float vstChanL[MAX_BUFFER_SIZE]{};
    alignas(16) float vstChanR[MAX_BUFFER_SIZE]{};
    alignas(16) float vstOutL[MAX_BUFFER_SIZE]{};
    alignas(16) float vstOutR[MAX_BUFFER_SIZE]{};

    // Текущие пиковые и RMS значения уровня дорожки (для визуализации и телеметрии)
    float peakL{0.0f};
    float peakR{0.0f};
    float rmsL{0.0f};
    float rmsR{0.0f};

    Track(uint32_t trackId = 0, std::string trackName = "Track", float sr = 48000.0f);

    void setSampleRate(float sr) noexcept;
    void addClip(const Clip& clip);
    void clearClips() noexcept;
    bool removeClip(uint32_t clipId) noexcept;
    Clip* getClip(uint32_t clipId) noexcept;

    // --- Управление VST-слотами дорожки ---
    void loadPlugin(int slotIdx, int pluginTypeId);
    void setPluginParam(int slotIdx, int paramId, float normalizedValue);
    void setPluginBypass(int slotIdx, bool bypass);
    void setPluginWetDry(int slotIdx, float wetDry);

    // --- Пиковые и RMS уровни ---
    float getPeakL() const noexcept { return peakL; }
    float getPeakR() const noexcept { return peakR; }
    float getRMSL() const noexcept { return rmsL; }
    float getRMSR() const noexcept { return rmsR; }

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
     * Последовательная обработка буфера через активные VST-плагины слотов
     */
    void processVSTSlots(size_t numFrames) noexcept;

    /**
     * Применение фейдера громкости и панорамы постоянной мощности к trackBuffer
     */
    void applyFaderAndPan(size_t numFrames) noexcept;

    /**
     * Замер пиковых и RMS значений уровня сигнала по указанному стереобуферу
     */
    void calculateBlockMeters(const float* buffer, int numFrames) noexcept;

    /**
     * Замер пиковых и RMS значений уровня сигнала после обработки (из trackBuffer)
     */
    void calculateBlockMeters(size_t numFrames) noexcept;
    void calculatePeaks(size_t numFrames) noexcept;
};

} // namespace DAWCore
