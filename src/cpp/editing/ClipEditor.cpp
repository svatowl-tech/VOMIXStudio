#include "ClipEditor.hpp"
#include <algorithm>
#include <cstring>

namespace DAWCore {

Mixer* ClipSliceManager::s_activeMixer = nullptr;
std::vector<float*> ClipSliceManager::s_allocatedBuffers;

void ClipSliceManager::setActiveMixer(Mixer* mixer) noexcept {
    s_activeMixer = mixer;
}

Mixer* ClipSliceManager::getActiveMixer() noexcept {
    return s_activeMixer;
}

uintptr_t ClipSliceManager::splitClip(uintptr_t clipPtr, size_t splitSampleOffset) {
    if (clipPtr == 0) return 0;
    Clip* leftClip = reinterpret_cast<Clip*>(clipPtr);
    if (!leftClip || !leftClip->sampleBuffer) return 0;

    size_t origLen = leftClip->lengthSamples;
    if (splitSampleOffset == 0 || splitSampleOffset >= origLen) {
        return 0; // Точка разреза вне допустимого диапазона
    }

    size_t chMultiplier = leftClip->isStereo ? 2 : 1;

    // 1. Модификация левого сегмента
    leftClip->lengthSamples = splitSampleOffset;

    // Антикликовый микро-фейд на конце левого клипа (до 256 сэмплов ~ 5.3 мс)
    size_t leftMicroFade = std::min(static_cast<size_t>(256), splitSampleOffset / 4);
    if (leftClip->fadeOutSamples == 0 || leftClip->fadeOutSamples > leftMicroFade) {
        leftClip->fadeOutSamples = leftMicroFade;
    }

    // 2. Создание правого сегмента (Zero-Copy указатель со смещением)
    Clip* rightClip = new Clip();
    rightClip->id = leftClip->id + 10000;
    rightClip->sampleBuffer = leftClip->sampleBuffer + splitSampleOffset * chMultiplier;
    rightClip->bufferSizeSamples = (leftClip->bufferSizeSamples > splitSampleOffset)
        ? (leftClip->bufferSizeSamples - splitSampleOffset)
        : (origLen - splitSampleOffset);
    rightClip->offsetSamples = leftClip->offsetSamples + splitSampleOffset;
    rightClip->lengthSamples = origLen - splitSampleOffset;

    // Антикликовый микро-фейд на старте правого клипа
    size_t rightMicroFade = std::min(static_cast<size_t>(256), rightClip->lengthSamples / 4);
    rightClip->fadeInSamples = rightMicroFade;
    rightClip->fadeOutSamples = leftClip->fadeOutSamples;

    // Сохранение акустических параметров исходного клипа
    rightClip->gain = leftClip->gain;
    rightClip->pan = leftClip->pan;
    rightClip->isStereo = leftClip->isStereo;
    rightClip->active = leftClip->active;

    return reinterpret_cast<uintptr_t>(rightClip);
}

bool ClipSliceManager::splitClipInTrack(
    uint32_t trackId,
    uint32_t clipId,
    size_t splitSampleOffset,
    uint32_t newClipId
) {
    if (!s_activeMixer) return false;
    Track* track = s_activeMixer->getTrack(trackId);
    if (!track) return false;

    Clip* leftClip = track->getClip(clipId);
    if (!leftClip || !leftClip->sampleBuffer) return false;

    size_t origLen = leftClip->lengthSamples;
    if (splitSampleOffset == 0 || splitSampleOffset >= origLen) {
        return false;
    }

    size_t chMultiplier = leftClip->isStereo ? 2 : 1;

    // Обновляем левый сегмент клипа
    leftClip->lengthSamples = splitSampleOffset;
    size_t leftMicroFade = std::min(static_cast<size_t>(256), splitSampleOffset / 4);
    if (leftClip->fadeOutSamples == 0 || leftClip->fadeOutSamples > leftMicroFade) {
        leftClip->fadeOutSamples = leftMicroFade;
    }

    // Создаем правый сегмент и добавляем его прямо в вектор трека без аллокаций в JS
    Clip rightClip;
    rightClip.id = (newClipId != 0) ? newClipId : (clipId + 1000);
    rightClip.sampleBuffer = leftClip->sampleBuffer + splitSampleOffset * chMultiplier;
    rightClip.bufferSizeSamples = (leftClip->bufferSizeSamples > splitSampleOffset)
        ? (leftClip->bufferSizeSamples - splitSampleOffset)
        : (origLen - splitSampleOffset);
    rightClip.offsetSamples = leftClip->offsetSamples + splitSampleOffset;
    rightClip.lengthSamples = origLen - splitSampleOffset;

    size_t rightMicroFade = std::min(static_cast<size_t>(256), rightClip.lengthSamples / 4);
    rightClip.fadeInSamples = rightMicroFade;
    rightClip.fadeOutSamples = leftClip->fadeOutSamples;
    rightClip.gain = leftClip->gain;
    rightClip.pan = leftClip->pan;
    rightClip.isStereo = leftClip->isStereo;
    rightClip.active = leftClip->active;

    track->addClip(rightClip);
    return true;
}

uintptr_t ClipSliceManager::applyTimeStretchToClip(
    uint32_t trackId,
    uint32_t clipId,
    float ratio
) {
    if (!s_activeMixer) return 0;
    Track* track = s_activeMixer->getTrack(trackId);
    if (!track) return 0;

    Clip* clip = track->getClip(clipId);
    if (!clip) return 0;

    return applyTimeStretchToClipPtr(clip, ratio);
}

uintptr_t ClipSliceManager::applyTimeStretchToClipPtr(Clip* clip, float ratio) {
    if (!clip || !clip->sampleBuffer || clip->lengthSamples == 0) return 0;

    float safeRatio = clampFloat(ratio, WSOLATimeStretch::MIN_STRETCH_RATIO, WSOLATimeStretch::MAX_STRETCH_RATIO);

    // Запуск алгоритма WSOLA прямо в C++ ядре
    std::vector<float> stretched = WSOLATimeStretch::processBuffer(
        clip->sampleBuffer,
        clip->lengthSamples,
        safeRatio,
        clip->isStereo
    );

    if (stretched.empty()) return 0;

    // Выделение постоянного буфера в куче WASM
    float* newBuffer = new float[stretched.size()];
    std::memcpy(newBuffer, stretched.data(), stretched.size() * sizeof(float));

    s_allocatedBuffers.push_back(newBuffer);

    // Обновление указателей и размеров клипа
    clip->sampleBuffer = newBuffer;
    size_t newFrames = clip->isStereo ? (stretched.size() / 2) : stretched.size();
    clip->lengthSamples = newFrames;
    clip->bufferSizeSamples = newFrames;

    return reinterpret_cast<uintptr_t>(newBuffer);
}

bool ClipSliceManager::trimClipStart(uintptr_t clipPtr, size_t trimSamples) {
    if (clipPtr == 0) return false;
    Clip* clip = reinterpret_cast<Clip*>(clipPtr);
    if (!clip || !clip->sampleBuffer || trimSamples >= clip->lengthSamples) return false;

    size_t chMultiplier = clip->isStereo ? 2 : 1;
    clip->sampleBuffer += trimSamples * chMultiplier;
    clip->offsetSamples += trimSamples;
    clip->lengthSamples -= trimSamples;
    if (clip->bufferSizeSamples > trimSamples) {
        clip->bufferSizeSamples -= trimSamples;
    }

    size_t microFade = std::min(static_cast<size_t>(256), clip->lengthSamples / 4);
    clip->fadeInSamples = microFade;
    return true;
}

bool ClipSliceManager::trimClipEnd(uintptr_t clipPtr, size_t newLengthSamples) {
    if (clipPtr == 0) return false;
    Clip* clip = reinterpret_cast<Clip*>(clipPtr);
    if (!clip || newLengthSamples == 0 || newLengthSamples > clip->lengthSamples) return false;

    clip->lengthSamples = newLengthSamples;
    size_t microFade = std::min(static_cast<size_t>(256), newLengthSamples / 4);
    if (clip->fadeOutSamples == 0 || clip->fadeOutSamples > microFade) {
        clip->fadeOutSamples = microFade;
    }
    return true;
}

bool ClipSliceManager::splitClipNative(
    uintptr_t inPcmPtr,
    size_t totalFrames,
    size_t splitFrameOffset,
    uintptr_t outLeftPcmPtr,
    uintptr_t outRightPcmPtr,
    int channels
) {
    if (inPcmPtr == 0 || outLeftPcmPtr == 0 || outRightPcmPtr == 0) return false;
    if (splitFrameOffset == 0 || splitFrameOffset >= totalFrames) return false;
    if (channels < 1 || channels > 2) channels = 2;

    const float* inPcm = reinterpret_cast<const float*>(inPcmPtr);
    float* outLeft = reinterpret_cast<float*>(outLeftPcmPtr);
    float* outRight = reinterpret_cast<float*>(outRightPcmPtr);

    const size_t leftFrames = splitFrameOffset;
    const size_t rightFrames = totalFrames - splitFrameOffset;
    const size_t ch = static_cast<size_t>(channels);

    // 1. Копирование левой части
    std::memcpy(outLeft, inPcm, leftFrames * ch * sizeof(float));

    // 2. Копирование правой части
    std::memcpy(outRight, inPcm + (leftFrames * ch), rightFrames * ch * sizeof(float));

    // 3. Расчет и наложение микро-фейда для устранения кликов (1-2 мс ~ 48-96 сэмплов)
    const size_t microFadeFrames = std::min({static_cast<size_t>(96), leftFrames / 4, rightFrames / 4});

    if (microFadeFrames > 0) {
        // Fade-out в конце левой части
        const float invFade = 1.0f / static_cast<float>(microFadeFrames);
        for (size_t f = 0; f < microFadeFrames; ++f) {
            const size_t targetIdx = leftFrames - microFadeFrames + f;
            const float gain = 0.5f * (1.0f + std::cos(PI_F * static_cast<float>(f) * invFade)); // Cosine fade-out
            for (size_t c = 0; c < ch; ++c) {
                outLeft[targetIdx * ch + c] *= gain;
            }
        }

        // Fade-in в начале правой части
        for (size_t f = 0; f < microFadeFrames; ++f) {
            const float gain = 0.5f * (1.0f - std::cos(PI_F * static_cast<float>(f) * invFade)); // Cosine fade-in
            for (size_t c = 0; c < ch; ++c) {
                outRight[f * ch + c] *= gain;
            }
        }
    }

    return true;
}

void ClipSliceManager::freeAllocatedBuffers() noexcept {
    for (float* buf : s_allocatedBuffers) {
        delete[] buf;
    }
    s_allocatedBuffers.clear();
}

} // namespace DAWCore
