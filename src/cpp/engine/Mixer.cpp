/**
 * ============================================================================
 * Mixer.cpp - Реализация главного микшера и звукового движка (C++17, RT-Safe)
 * ============================================================================
 */

#include "Mixer.hpp"
#include "../vst/NativeDSPPlugins.hpp"
#include <cmath>
#include <algorithm>
#include <cstring>

namespace DAWCore {

Mixer::Mixer(float sr)
    : sampleRate(sr)
{
    std::memset(sidechainMonoBuffer, 0, sizeof(sidechainMonoBuffer));
    std::memset(masterMixBuffer, 0, sizeof(masterMixBuffer));
    std::memset(masterChanL, 0, sizeof(masterChanL));
    std::memset(masterChanR, 0, sizeof(masterChanR));
    std::memset(masterOutL, 0, sizeof(masterOutL));
    std::memset(masterOutR, 0, sizeof(masterOutR));
}

void Mixer::setSampleRate(float sr) noexcept {
    sampleRate = sr;
    for (auto& track : tracks) {
        if (track) {
            track->setSampleRate(sr);
        }
    }
    for (auto& slot : masterVstSlots) {
        if (slot) {
            slot->initialize(static_cast<double>(sr), MAX_BUFFER_SIZE);
        }
    }
}

void Mixer::setTimelinePosition(size_t pos) noexcept {
    currentTimelineSample = pos;
}

void Mixer::addTrack(Track* track) {
    if (track) {
        track->setSampleRate(sampleRate);
        tracks.emplace_back(track);
    }
}

Track* Mixer::getTrack(uint32_t trackId) noexcept {
    for (auto& t : tracks) {
        if (t && t->id == trackId) {
            return t.get();
        }
    }
    return nullptr;
}

void Mixer::removeAllTracks() noexcept {
    tracks.clear();
}

void Mixer::loadMasterPlugin(int slotIdx, int pluginTypeId) {
    if (slotIdx < 0 || slotIdx >= 8) return;
    masterVstSlots[slotIdx] = createNativePluginInstance(pluginTypeId, static_cast<double>(sampleRate));
}

void Mixer::setMasterPluginParam(int slotIdx, int paramId, float normalizedValue) {
    if (slotIdx < 0 || slotIdx >= 8) return;
    if (masterVstSlots[slotIdx]) {
        masterVstSlots[slotIdx]->setParameter(static_cast<uint32_t>(paramId), normalizedValue);
    }
}

void Mixer::setMasterPluginBypass(int slotIdx, bool bypass) {
    if (slotIdx < 0 || slotIdx >= 8) return;
    if (masterVstSlots[slotIdx]) {
        auto* nativePlugin = dynamic_cast<NativePluginBase*>(masterVstSlots[slotIdx].get());
        if (nativePlugin) {
            nativePlugin->setBypass(bypass);
        } else {
            masterVstSlots[slotIdx]->setParameter(0, bypass ? 1.0f : 0.0f);
        }
    }
}

void Mixer::setMasterPluginWetDry(int slotIdx, float wetDry) {
    if (slotIdx < 0 || slotIdx >= 8) return;
    if (masterVstSlots[slotIdx]) {
        auto* nativePlugin = dynamic_cast<NativePluginBase*>(masterVstSlots[slotIdx].get());
        if (nativePlugin) {
            nativePlugin->setWetDryMix(wetDry);
        }
    }
}

float Mixer::getPeak(int trackId, int channel) const noexcept {
    if (trackId == 1000) {
        return (channel == 0) ? masterPeakL : masterPeakR;
    }
    if (trackId == 999) {
        return (channel == 0) ? vocalBusPeakL : vocalBusPeakR;
    }
    for (const auto& t : tracks) {
        if (t && static_cast<int>(t->id) == trackId) {
            return (channel == 0) ? t->getPeakL() : t->getPeakR();
        }
    }
    return 0.0f;
}

size_t Mixer::calculateProjectLengthSamples(int isolateTrackId) const noexcept {
    size_t maxLength = 0;
    for (const auto& track : tracks) {
        if (!track) continue;
        if (isolateTrackId > 0 && static_cast<int>(track->id) != isolateTrackId) {
            continue;
        }

        for (const auto& clip : track->clips) {
            if (clip.active) {
                size_t endPos = clip.offsetSamples + clip.lengthSamples;
                if (endPos > maxLength) {
                    maxLength = endPos;
                }
            }
        }
    }
    return maxLength;
}

void Mixer::processBlock(float* outputBuffer, size_t numFrames) noexcept {
    if (!outputBuffer || numFrames == 0) return;

    size_t safeFrames = std::min(numFrames, MAX_BUFFER_SIZE);
    std::memset(masterMixBuffer, 0, safeFrames * 2 * sizeof(float));

    // Проверка режима Solo
    bool anySolo = false;
    for (const auto& t : tracks) {
        if (t && t->solo) {
            anySolo = true;
            break;
        }
    }

    float currentVocalL = 0.0f;
    float currentVocalR = 0.0f;

    // Рендеринг и DSP обработка каждой дорожки
    for (auto& track : tracks) {
        if (!track) continue;
        if (track->mute) continue;
        if (anySolo && !track->solo) continue;

        // 1. Отрисовка сэмплов клипов в локальный буфер дорожки (Zero Malloc)
        track->renderClipsToBuffer(currentTimelineSample, safeFrames);

        // 2. Проверка сайдчейн-источника для AutoDucker
        const float* scPtr = nullptr;
        if (track->autoDucker.enabled && track->autoDucker.sourceTrackId > 0) {
            Track* scTrack = getTrack(track->autoDucker.sourceTrackId);
            if (scTrack && scTrack != track.get()) {
                // Извлечение моно сайдчейн-сигнала из буфера источника
                for (size_t f = 0; f < safeFrames; ++f) {
                    sidechainMonoBuffer[f] = 0.5f * (scTrack->trackBuffer[f * 2] + scTrack->trackBuffer[f * 2 + 1]);
                }
                scPtr = sidechainMonoBuffer;
            }
        }

        // 3. Вокальный процессор (VocalRack)
        track->processVocalRack(scPtr, safeFrames);

        // 4. Последовательный прогон дорожки через активные плагины слотов VST
        track->processVSTSlots(safeFrames);

        // 5. Применение громкости фейдера и панорамы
        track->applyFaderAndPan(safeFrames);

        // 6. Замер пиковых уровней дорожки для телеметрии
        track->calculatePeaks(safeFrames);

        // Сбор пиков для вокал-шины (если имя содержит vocal/вокал)
        std::string lowerName = track->name;
        std::transform(lowerName.begin(), lowerName.end(), lowerName.begin(), ::tolower);
        if (lowerName.find("vocal") != std::string::npos || lowerName.find("вокал") != std::string::npos) {
            currentVocalL = std::max(currentVocalL, track->getPeakL());
            currentVocalR = std::max(currentVocalR, track->getPeakR());
        }

        // 7. Суммирование дорожки в мастер-шину с SIMD-ускорением
#if USE_WASM_SIMD
        size_t totalSamples = safeFrames * 2;
        size_t i = 0;
        for (; i + 4 <= totalSamples; i += 4) {
            v128_t vMaster = wasm_v128_load(&masterMixBuffer[i]);
            v128_t vTrack  = wasm_v128_load(&track->trackBuffer[i]);
            vMaster = wasm_f32x4_add(vMaster, vTrack);
            wasm_v128_store(&masterMixBuffer[i], vMaster);
        }
        for (; i < totalSamples; ++i) {
            masterMixBuffer[i] += track->trackBuffer[i];
        }
#else
        for (size_t i = 0; i < safeFrames * 2; ++i) {
            masterMixBuffer[i] += track->trackBuffer[i];
        }
#endif
    }

    vocalBusPeakL = currentVocalL;
    vocalBusPeakR = currentVocalR;

    // Мастер-секция: Master Volume & Constant Power Pan
    float masterGain = dbToGain(masterVolumeDb);
    float panL = 1.0f, panR = 1.0f;
    calculateConstantPowerPan(masterPan, panL, panR);

    float finalMasterL = masterGain * panL;
    float finalMasterR = masterGain * panR;

    for (size_t i = 0; i < safeFrames; ++i) {
        masterMixBuffer[i * 2]     *= finalMasterL;
        masterMixBuffer[i * 2 + 1] *= finalMasterR;
    }

    // 8. Мастер-слоты VST (мастеринг-цепочка перед Soft Limiter)
    bool hasActiveMasterPlugin = false;
    for (const auto& slot : masterVstSlots) {
        if (slot && slot->isActivated()) {
            hasActiveMasterPlugin = true;
            break;
        }
    }

    if (hasActiveMasterPlugin) {
        for (size_t i = 0; i < safeFrames; ++i) {
            masterChanL[i] = masterMixBuffer[i * 2];
            masterChanR[i] = masterMixBuffer[i * 2 + 1];
        }

        float* inPtrs[2] = { masterChanL, masterChanR };
        float* outPtrs[2] = { masterOutL, masterOutR };

        for (auto& slot : masterVstSlots) {
            if (slot && slot->isActivated()) {
                slot->processBlock(inPtrs, outPtrs, static_cast<int32_t>(safeFrames));
                std::memcpy(masterChanL, masterOutL, safeFrames * sizeof(float));
                std::memcpy(masterChanR, masterOutR, safeFrames * sizeof(float));
            }
        }

        for (size_t i = 0; i < safeFrames; ++i) {
            masterMixBuffer[i * 2]     = masterChanL[i];
            masterMixBuffer[i * 2 + 1] = masterChanR[i];
        }
    }

    // 9. Мастер-лимитер с защитой от пикового клиппинга (True Peak Guard)
    masterLimiter.processBuffer(masterMixBuffer, safeFrames);

    // 10. Замер пиковых уровней мастера
    float mL = 0.0f;
    float mR = 0.0f;
    for (size_t i = 0; i < safeFrames; ++i) {
        float absL = std::abs(masterMixBuffer[i * 2]);
        float absR = std::abs(masterMixBuffer[i * 2 + 1]);
        if (absL > mL) mL = absL;
        if (absR > mR) mR = absR;
    }
    masterPeakL = std::max(mL, masterPeakL * 0.85f);
    masterPeakR = std::max(mR, masterPeakR * 0.85f);

    // Копирование в выходной буфер
    std::memcpy(outputBuffer, masterMixBuffer, safeFrames * 2 * sizeof(float));

    // Сдвиг курсора таймлайна
    currentTimelineSample += safeFrames;
}

size_t Mixer::renderProjectOffline(float* outputBuffer, size_t maxFrames, int isolateTrackId) noexcept {
    if (!outputBuffer || maxFrames == 0) return 0;

    size_t projectLength = calculateProjectLengthSamples(isolateTrackId);
    size_t framesToRender = std::min(projectLength, maxFrames);
    if (framesToRender == 0) return 0;

    size_t savedTimelinePos = currentTimelineSample;
    currentTimelineSample = 0;

    // Сохранение исходных состояний mute/solo для изолированного рендера
    std::vector<bool> origMutes;
    std::vector<bool> origSolos;
    if (isolateTrackId > 0) {
        origMutes.reserve(tracks.size());
        origSolos.reserve(tracks.size());
        for (const auto& t : tracks) {
            if (t) {
                origMutes.push_back(t->mute);
                origSolos.push_back(t->solo);
                t->solo = (static_cast<int>(t->id) == isolateTrackId);
                t->mute = false;
            }
        }
    }

    size_t renderedFrames = 0;
    constexpr size_t BLOCK_SIZE = 1024;

    while (renderedFrames < framesToRender) {
        size_t currentChunk = std::min(BLOCK_SIZE, framesToRender - renderedFrames);
        float* destChunk = outputBuffer + (renderedFrames * 2);

        processBlock(destChunk, currentChunk);
        renderedFrames += currentChunk;
    }

    // Восстановление состояний mute/solo
    if (isolateTrackId > 0) {
        size_t idx = 0;
        for (auto& t : tracks) {
            if (t && idx < origMutes.size()) {
                t->mute = origMutes[idx];
                t->solo = origSolos[idx];
                idx++;
            }
        }
    }

    currentTimelineSample = savedTimelinePos;
    return renderedFrames;
}

void Mixer::autoMatchAllTracks(float targetRmsDb, float maxPeakDb) noexcept {
    for (auto& track : tracks) {
        if (!track || track->clips.empty()) continue;

        // Поиск наиболее длинного активного аудиоклипа дорожки для замера громкости
        const Clip* mainClip = nullptr;
        size_t maxLen = 0;
        for (const auto& clip : track->clips) {
            if (clip.active && clip.sampleBuffer && clip.lengthSamples > maxLen) {
                maxLen = clip.lengthSamples;
                mainClip = &clip;
            }
        }

        if (mainClip && mainClip->sampleBuffer && mainClip->lengthSamples > 0) {
            LoudnessStats stats = LoudnessAnalyzer::calculateLoudnessStats(
                mainClip->sampleBuffer,
                mainClip->lengthSamples,
                mainClip->isStereo ? 2 : 1,
                targetRmsDb,
                maxPeakDb
            );

            // Коррекция фейдера дорожки
            track->volumeDb = clampFloat(track->volumeDb + stats.gainDeltaToTargetDb, -36.0f, 12.0f);
        }
    }
}

} // namespace DAWCore
