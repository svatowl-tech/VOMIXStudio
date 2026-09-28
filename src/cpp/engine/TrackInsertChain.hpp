#pragma once

/**
 * ============================================================================
 * TrackInsertChain.hpp - Цепочка инсерт-эффектов дорожки (C++17, RT-Safe)
 * ============================================================================
 * Модульная архитектура сквозной обработки дорожек через нативные C++ DSP модули:
 * 1. Универсальный полиморфный интерфейс ITrackInsertEffect.
 * 2. Сглаживание параметров (Anti-Click Parameter Smoothing) при вращении ручек.
 * 3. 16 нативных студийных DSP-модулей (Реставрация, Динамика, EQ, Пространство, Окрас).
 * 4. Управление порядком слотов (Reorder), Bypass, удаление и добавление на лету.
 * 5. Строгий Zero Malloc в аудиопотоке.
 * ============================================================================
 */

#include <memory>
#include <vector>
#include <string>
#include <cstdint>
#include <cstddef>
#include "../dsp/AudioMath.hpp"

namespace DAWCore {

/**
 * Базовый интерфейс встраиваемого эффекта
 */
class ITrackInsertEffect {
public:
    virtual ~ITrackInsertEffect() = default;

    virtual int getTypeId() const noexcept = 0;
    virtual const char* getName() const noexcept = 0;
    virtual const char* getCategory() const noexcept = 0;

    virtual void setSampleRate(float sr) noexcept = 0;
    virtual void reset() noexcept = 0;

    virtual void setParam(int paramId, float value) noexcept = 0;
    virtual float getParam(int paramId) const noexcept = 0;

    virtual void setBypass(bool bypass) noexcept = 0;
    virtual bool isBypassed() const noexcept = 0;

    /**
     * In-place обработка блока аудио
     * @param buffer PCM Float32 (interleaved для стерео)
     * @param numFrames Количество сэмплов на канал
     * @param channels 1 = моно, 2 = стерео
     */
    virtual void processBlock(float* buffer, size_t numFrames, int channels) noexcept = 0;
};

/**
 * Фабричный метод создания нативных эффектов по typeId (101 .. 116)
 */
std::unique_ptr<ITrackInsertEffect> createTrackInsertEffect(int typeId, float sampleRate) noexcept;

/**
 * Класс TrackInsertChain - Управляющая цепочка эффектов дорожки
 */
class TrackInsertChain {
public:
    TrackInsertChain() noexcept = default;
    ~TrackInsertChain() = default;

    void setSampleRate(float sr) noexcept;
    void reset() noexcept;

    // --- Управление слотами ---
    int addEffect(int effectTypeId) noexcept;
    bool removeEffect(int slotIdx) noexcept;
    bool reorderEffects(int fromIdx, int toIdx) noexcept;
    void clear() noexcept;

    void setParam(int slotIdx, int paramId, float value) noexcept;
    float getParam(int slotIdx, int paramId) const noexcept;

    void setBypass(int slotIdx, bool bypass) noexcept;
    bool isBypassed(int slotIdx) const noexcept;

    int getEffectTypeId(int slotIdx) const noexcept;
    const char* getEffectName(int slotIdx) const noexcept;
    size_t getEffectCount() const noexcept { return slots_.size(); }

    /**
     * Потоковая последовательная обработка через всю активную цепочку слотов (RT-Safe)
     */
    void process(float* buffer, size_t numFrames, int channels) noexcept;

    /**
     * Загрузка дефолтной цепочки для качественного дикторского голоса/вокала:
     * [MouthDeClicker -> SmartBreathController -> ParametricEQPro -> StudioCompressor -> DeEsserPro]
     */
    void loadVocalDefaultChain() noexcept;

private:
    float sampleRate_{48000.0f};
    std::vector<std::unique_ptr<ITrackInsertEffect>> slots_;
};

} // namespace DAWCore
