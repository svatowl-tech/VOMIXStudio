#pragma once

/**
 * ============================================================================
 * Mixer.hpp - Главный микшер и звуковой движок DAW (C++17, RT-Safe)
 * ============================================================================
 * Выполняет:
 * 1. Управление коллекцией дорожек Track.
 * 2. Многопоточный / пакетный сумматор аудиопотоков с поддержкой Solo/Mute.
 * 3. Сайдчейн-маршрутизацию между дорожками без аллокаций памяти.
 * 4. Мастер-секцию (Master Fader, Constant Power Pan, SoftLimiter).
 * 5. Офлайн-рендеринг всего проекта и отдельных изолированных стемов (Stems).
 * 6. Автоматическое поканальное выравнивание громкости (Auto Loudness Match).
 * ============================================================================
 */

#include "Track.hpp"
#include "../dsp/AudioMath.hpp"
#include "../dsp/AudioUtils.hpp"
#include "../dsp/Dynamics.hpp"
#include <vector>
#include <memory>

namespace DAWCore {

/**
 * Класс Mixer - Главный микшерный пульт DAW
 */
class Mixer {
public:
    float sampleRate{48000.0f};
    float masterVolumeDb{0.0f};          // Мастер-громкость (-60 .. +12 dB)
    float masterPan{0.0f};               // Мастер-панорама (-1.0 .. +1.0)
    size_t currentTimelineSample{0};     // Текущая позиция курсора на таймлайне (в сэмплах)
    SoftLimiter masterLimiter;           // Мастер-лимитер True Peak Guard

    // Вектор дорожек (управляется микшером)
    std::vector<std::unique_ptr<Track>> tracks;

    // Внутренние предварительно выделенные статические буферы (Zero Malloc в аудиопотоке)
    alignas(16) float sidechainMonoBuffer[MAX_BUFFER_SIZE]{};
    alignas(16) float masterMixBuffer[MAX_BUFFER_SIZE * 2]{};

    explicit Mixer(float sr = 48000.0f);

    void setSampleRate(float sr) noexcept;
    void setTimelinePosition(size_t pos) noexcept;

    void addTrack(Track* track);
    Track* getTrack(uint32_t trackId) noexcept;
    void removeAllTracks() noexcept;

    /**
     * Потоковая обработка одного блока аудиоданных в реальном времени (RT-Safe)
     * @param outputBuffer Указатель на стереобуфер вывода [L, R, L, R...]
     * @param numFrames Количество стереокадров
     */
    void processBlock(float* outputBuffer, size_t numFrames) noexcept;

    /**
     * Офлайн-рендеринг проекта или изолированного стема
     * @param outputBuffer Выходной стереобуфер для записи готового микса
     * @param maxFrames Максимальная вместимость буфера в сэмплах
     * @param isolateTrackId 0 = полный микс, >0 = рендер только указанной дорожки (стем)
     * @return Фактическое количество сгенерированных стереокадров
     */
    size_t renderProjectOffline(float* outputBuffer, size_t maxFrames, int isolateTrackId = 0) noexcept;

    /**
     * Автоматическое выравнивание громкости дорожек (EBU R128 Loudness Matching)
     */
    void autoMatchAllTracks(float targetRmsDb = -18.0f, float maxPeakDb = -1.0f) noexcept;

private:
    /**
     * Вычисление максимальной длины проекта по всем дорожкам и клипам
     */
    size_t calculateProjectLengthSamples(int isolateTrackId = 0) const noexcept;
};

} // namespace DAWCore
