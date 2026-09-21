/**
 * ============================================================================
 * Track.cpp - Реализация методов аудиодорожки (C++17, RT-Safe)
 * ============================================================================
 */

#include "Track.hpp"
#include "../vst/NativeDSPPlugins.hpp"
#include <algorithm>
#include <cstring>
#include <cmath>

namespace DAWCore {

Track::Track(uint32_t trackId, std::string trackName, float sr)
    : id(trackId),
      name(std::move(trackName)),
      sampleRate(sr),
      deClicker(vocalRack.deClicker),
      dePlosive(vocalRack.dePlosive),
      noiseGate(vocalRack.noiseGate),
      eq(vocalRack.eq),
      deEsser(vocalRack.deEsser),
      compressor(vocalRack.compressor),
      autoDucker(vocalRack.autoDucker)
{
    clips.reserve(MAX_CLIPS_PER_TRACK);
    std::memset(trackBuffer, 0, sizeof(trackBuffer));
    std::memset(vstChanL, 0, sizeof(vstChanL));
    std::memset(vstChanR, 0, sizeof(vstChanR));
    std::memset(vstOutL, 0, sizeof(vstOutL));
    std::memset(vstOutR, 0, sizeof(vstOutR));
    vocalRack.setup(sr);
}

void Track::setSampleRate(float sr) noexcept {
    sampleRate = sr;
    vocalRack.setup(sr);
    for (auto& slot : vstSlots) {
        if (slot) {
            slot->initialize(static_cast<double>(sr), MAX_BUFFER_SIZE);
        }
    }
}

void Track::addClip(const Clip& clip) {
    clips.push_back(clip);
}

void Track::clearClips() noexcept {
    clips.clear();
}

bool Track::removeClip(uint32_t clipId) noexcept {
    auto it = std::remove_if(clips.begin(), clips.end(), [clipId](const Clip& c) {
        return c.id == clipId;
    });
    if (it != clips.end()) {
        clips.erase(it, clips.end());
        return true;
    }
    return false;
}

Clip* Track::getClip(uint32_t clipId) noexcept {
    for (auto& clip : clips) {
        if (clip.id == clipId) return &clip;
    }
    return nullptr;
}

void Track::loadPlugin(int slotIdx, int pluginTypeId) {
    if (slotIdx < 0 || slotIdx >= 8) return;
    vstSlots[slotIdx] = createNativePluginInstance(pluginTypeId, static_cast<double>(sampleRate));
}

void Track::setPluginParam(int slotIdx, int paramId, float normalizedValue) {
    if (slotIdx < 0 || slotIdx >= 8) return;
    if (vstSlots[slotIdx]) {
        vstSlots[slotIdx]->setParameter(static_cast<uint32_t>(paramId), normalizedValue);
    }
}

void Track::setPluginBypass(int slotIdx, bool bypass) {
    if (slotIdx < 0 || slotIdx >= 8) return;
    if (vstSlots[slotIdx]) {
        // Проверяем возможность приведения к NativePluginBase
        auto* nativePlugin = dynamic_cast<NativePluginBase*>(vstSlots[slotIdx].get());
        if (nativePlugin) {
            nativePlugin->setBypass(bypass);
        } else {
            // Резервный параметр 0 = bypass
            vstSlots[slotIdx]->setParameter(0, bypass ? 1.0f : 0.0f);
        }
    }
}

void Track::setPluginWetDry(int slotIdx, float wetDry) {
    if (slotIdx < 0 || slotIdx >= 8) return;
    if (vstSlots[slotIdx]) {
        auto* nativePlugin = dynamic_cast<NativePluginBase*>(vstSlots[slotIdx].get());
        if (nativePlugin) {
            nativePlugin->setWetDryMix(wetDry);
        }
    }
}

void Track::renderClipsToBuffer(size_t timelinePosition, size_t numFrames) noexcept {
    size_t safeFrames = std::min(numFrames, MAX_BUFFER_SIZE);
    std::memset(trackBuffer, 0, safeFrames * 2 * sizeof(float));

    if (clips.empty()) return;

    size_t windowStart = timelinePosition;
    size_t windowEnd = timelinePosition + safeFrames;

    for (const auto& clip : clips) {
        if (!clip.active || !clip.sampleBuffer || clip.lengthSamples == 0) continue;

        size_t clipStart = clip.offsetSamples;
        size_t clipEnd = clipStart + clip.lengthSamples;

        // Проверка пересечения временного окна блока с клипом
        if (clipEnd <= windowStart || clipStart >= windowEnd) continue;

        size_t overlapStart = std::max(windowStart, clipStart);
        size_t overlapEnd = std::min(windowEnd, clipEnd);
        size_t overlapFrames = overlapEnd - overlapStart;

        size_t destOffset = overlapStart - windowStart;
        size_t clipLocalSampleStart = overlapStart - clipStart;

        float clipPanL = 1.0f, clipPanR = 1.0f;
        calculateConstantPowerPan(clip.pan, clipPanL, clipPanR);

        for (size_t f = 0; f < overlapFrames; ++f) {
            size_t clipSampleIdx = clipLocalSampleStart + f;
            if (clipSampleIdx >= clip.bufferSizeSamples) break;

            float fade = clip.getFadeGain(clipSampleIdx);
            float totalGainL = clip.gain * fade * clipPanL;
            float totalGainR = clip.gain * fade * clipPanR;

            float smpL = 0.0f;
            float smpR = 0.0f;

            if (clip.isStereo) {
                smpL = clip.sampleBuffer[clipSampleIdx * 2];
                smpR = clip.sampleBuffer[clipSampleIdx * 2 + 1];
            } else {
                smpL = smpR = clip.sampleBuffer[clipSampleIdx];
            }

            trackBuffer[(destOffset + f) * 2]     += smpL * totalGainL;
            trackBuffer[(destOffset + f) * 2 + 1] += smpR * totalGainR;
        }
    }
}

void Track::processVocalRack(const float* sidechainMono, size_t numFrames) noexcept {
    size_t safeFrames = std::min(numFrames, MAX_BUFFER_SIZE);
    vocalRack.process(trackBuffer, sidechainMono, safeFrames);
}

void Track::processVSTSlots(size_t numFrames) noexcept {
    size_t safeFrames = std::min(numFrames, MAX_BUFFER_SIZE);
    if (safeFrames == 0) return;

    bool hasActivePlugin = false;
    for (const auto& slot : vstSlots) {
        if (slot && slot->isActivated()) {
            hasActivePlugin = true;
            break;
        }
    }
    if (!hasActivePlugin) return;

    // 1. Деинтерливинг стерео буфера в vstChanL и vstChanR
    for (size_t i = 0; i < safeFrames; ++i) {
        vstChanL[i] = trackBuffer[i * 2];
        vstChanR[i] = trackBuffer[i * 2 + 1];
    }

    float* inPtrs[2] = { vstChanL, vstChanR };
    float* outPtrs[2] = { vstOutL, vstOutR };

    // 2. Последовательный прогон через все 8 слотов
    for (auto& slot : vstSlots) {
        if (slot && slot->isActivated()) {
            slot->processBlock(inPtrs, outPtrs, static_cast<int32_t>(safeFrames));
            // Копируем результат как вход для следующего слота
            std::memcpy(vstChanL, vstOutL, safeFrames * sizeof(float));
            std::memcpy(vstChanR, vstOutR, safeFrames * sizeof(float));
        }
    }

    // 3. Интерливинг обратно в trackBuffer
    for (size_t i = 0; i < safeFrames; ++i) {
        trackBuffer[i * 2]     = vstChanL[i];
        trackBuffer[i * 2 + 1] = vstChanR[i];
    }
}

void Track::applyFaderAndPan(size_t numFrames) noexcept {
    size_t safeFrames = std::min(numFrames, MAX_BUFFER_SIZE);
    float volGain = dbToGain(volumeDb);
    float panL = 1.0f, panR = 1.0f;
    calculateConstantPowerPan(pan, panL, panR);

    float finalGainL = volGain * panL;
    float finalGainR = volGain * panR;

#if USE_WASM_SIMD
    v128_t vGains = wasm_f32x4_make(finalGainL, finalGainR, finalGainL, finalGainR);
    size_t totalSamples = safeFrames * 2;
    size_t i = 0;

    for (; i + 4 <= totalSamples; i += 4) {
        v128_t vSamples = wasm_v128_load(&trackBuffer[i]);
        vSamples = wasm_f32x4_mul(vSamples, vGains);
        wasm_v128_store(&trackBuffer[i], vSamples);
    }

    for (; i < totalSamples; i += 2) {
        trackBuffer[i]     *= finalGainL;
        trackBuffer[i + 1] *= finalGainR;
    }
#else
    for (size_t i = 0; i < safeFrames; ++i) {
        trackBuffer[i * 2]     *= finalGainL;
        trackBuffer[i * 2 + 1] *= finalGainR;
    }
#endif
}

void Track::calculatePeaks(size_t numFrames) noexcept {
    size_t safeFrames = std::min(numFrames, MAX_BUFFER_SIZE);
    float pL = 0.0f;
    float pR = 0.0f;

    for (size_t i = 0; i < safeFrames; ++i) {
        float absL = std::abs(trackBuffer[i * 2]);
        float absR = std::abs(trackBuffer[i * 2 + 1]);
        if (absL > pL) pL = absL;
        if (absR > pR) pR = absR;
    }

    // Плавный спад пиков (decay envelope)
    peakL = std::max(pL, peakL * 0.85f);
    peakR = std::max(pR, peakR * 0.85f);
}

} // namespace DAWCore
