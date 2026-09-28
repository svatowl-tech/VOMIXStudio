/**
 * ============================================================================
 * TrackInsertChain.cpp - Реализация цепочки инсерт-эффектов дорожки (C++17)
 * ============================================================================
 */

#include "TrackInsertChain.hpp"

// Подключение всех 16 нативных C++ DSP модулей
#include "../dsp/PhraseLoudnessNormalizer.hpp"
#include "../dsp/StudioCompressor.hpp"
#include "../dsp/ParametricEQPro.hpp"
#include "../dsp/DynamicEQ.hpp"
#include "../dsp/GraphicEQ31.hpp"
#include "../dsp/DeEsserPro.hpp"
#include "../dsp/SmartBreathController.hpp"
#include "../dsp/MouthDeClicker.hpp"
#include "../dsp/ProximityControl.hpp"
#include "../dsp/AutoPhaseAligner.hpp"
#include "../dsp/TransientShaper.hpp"
#include "../dsp/ResonanceSuppressor.hpp"
#include "../dsp/TapeSaturation.hpp"
#include "../dsp/LinearPhaseFilter.hpp"
#include "../dsp/StudioReverb.hpp"
#include "../dsp/FFTSpectralFilter.hpp"

#include <algorithm>
#include <cmath>

namespace DAWCore {

// Базовый класс с поддержкой плавного переключения Bypass (Anti-Click Crossfade)
class BaseTrackEffect : public ITrackInsertEffect {
public:
    explicit BaseTrackEffect(int typeId, const char* name, const char* category)
        : typeId_(typeId), name_(name), category_(category) {}

    int getTypeId() const noexcept override { return typeId_; }
    const char* getName() const noexcept override { return name_; }
    const char* getCategory() const noexcept override { return category_; }

    void setBypass(bool bypass) noexcept override {
        bypassed_ = bypass;
        targetBypassGain_ = bypass ? 0.0f : 1.0f;
    }
    bool isBypassed() const noexcept override { return bypassed_; }

protected:
    int typeId_{0};
    const char* name_{""};
    const char* category_{""};
    bool bypassed_{false};
    float currentBypassGain_{1.0f};
    float targetBypassGain_{1.0f};
};

// 1. PhraseLoudnessNormalizer Wrapper (TypeId: 101)
class EffectPhraseLeveler : public BaseTrackEffect {
public:
    EffectPhraseLeveler(float sr) : BaseTrackEffect(101, "Phrase Leveler", "dynamics"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.targetRmsDb = value; break;
            case 1: p.maxBoostDb = value; break;
            case 2: p.maxCutDb = value; break;
            case 3: p.gateThresholdDb = value; break;
            case 4: p.attackMs = value; break;
            case 5: p.releaseMs = value; break;
            case 6: p.sensitivity = value; break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.targetRmsDb;
            case 1: return p.maxBoostDb;
            case 2: return p.maxCutDb;
            case 3: return p.gateThresholdDb;
            case 4: return p.attackMs;
            case 5: return p.releaseMs;
            case 6: return p.sensitivity;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    PhraseLoudnessNormalizer dsp_;
};

// 2. StudioCompressor Wrapper (TypeId: 102)
class EffectStudioCompressor : public BaseTrackEffect {
public:
    EffectStudioCompressor(float sr) : BaseTrackEffect(102, "Studio Compressor", "dynamics"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.thresholdDb = value; break;
            case 1: p.ratio = value; break;
            case 2: p.attackMs = value; break;
            case 3: p.releaseMs = value; break;
            case 4: p.kneeDb = value; break;
            case 5: p.makeupGainDb = value; break;
            case 6: p.dryWet = value; break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.thresholdDb;
            case 1: return p.ratio;
            case 2: return p.attackMs;
            case 3: return p.releaseMs;
            case 4: return p.kneeDb;
            case 5: return p.makeupGainDb;
            case 6: return p.dryWet;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    StudioCompressor dsp_;
};

// 3. ParametricEQPro Wrapper (TypeId: 103)
class EffectParametricEQPro : public BaseTrackEffect {
public:
    EffectParametricEQPro(float sr) : BaseTrackEffect(103, "Parametric EQ Pro", "eq"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        const int bandIdx = paramId / 3;
        const int attr = paramId % 3;
        if (bandIdx >= 0 && bandIdx < 5) {
            auto b = dsp_.getBand(static_cast<size_t>(bandIdx));
            if (attr == 0) b.frequency = value;
            else if (attr == 1) b.gainDb = value;
            else if (attr == 2) b.Q = value;
            dsp_.setBand(static_cast<size_t>(bandIdx), b);
        }
    }

    float getParam(int paramId) const noexcept override {
        const int bandIdx = paramId / 3;
        const int attr = paramId % 3;
        if (bandIdx >= 0 && bandIdx < 5) {
            const auto& b = dsp_.getBand(static_cast<size_t>(bandIdx));
            if (attr == 0) return b.frequency;
            if (attr == 1) return b.gainDb;
            if (attr == 2) return b.Q;
        }
        return 0.0f;
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    ParametricEQPro dsp_;
};

// 4. DynamicEQ Wrapper (TypeId: 104)
class EffectDynamicEQ : public BaseTrackEffect {
public:
    EffectDynamicEQ(float sr) : BaseTrackEffect(104, "Dynamic EQ", "eq"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto b = dsp_.getBand(0);
        switch (paramId) {
            case 0: b.frequency = value; break;
            case 1: b.Q = value; break;
            case 2: b.thresholdDb = value; break;
            case 3: b.ratio = value; break;
            case 4: b.maxDynamicGainDb = value; break;
            case 5: b.attackMs = value; break;
            case 6: b.releaseMs = value; break;
            default: break;
        }
        dsp_.setBand(0, b);
    }

    float getParam(int paramId) const noexcept override {
        const auto& b = dsp_.getBand(0);
        switch (paramId) {
            case 0: return b.frequency;
            case 1: return b.Q;
            case 2: return b.thresholdDb;
            case 3: return b.ratio;
            case 4: return b.maxDynamicGainDb;
            case 5: return b.attackMs;
            case 6: return b.releaseMs;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    DynamicEQ dsp_;
};

// 5. GraphicEQ31 Wrapper (TypeId: 105)
class EffectGraphicEQ31 : public BaseTrackEffect {
public:
    EffectGraphicEQ31(float sr) : BaseTrackEffect(105, "Graphic EQ 31", "eq"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        if (paramId >= 0 && paramId < 31) {
            dsp_.setBandGain(static_cast<size_t>(paramId), value);
        }
    }

    float getParam(int paramId) const noexcept override {
        if (paramId >= 0 && paramId < 31) {
            return dsp_.getBandGain(static_cast<size_t>(paramId));
        }
        return 0.0f;
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    GraphicEQ31 dsp_;
};

// 6. DeEsserPro Wrapper (TypeId: 106)
class EffectDeEsserPro : public BaseTrackEffect {
public:
    EffectDeEsserPro(float sr) : BaseTrackEffect(106, "De-Esser Pro", "restoration"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.frequency = value; break;
            case 1: p.thresholdDb = value; break;
            case 2: p.ratio = value; break;
            case 3: p.maxReductionDb = value; break;
            case 4: p.attackMs = value; break;
            case 5: p.releaseMs = value; break;
            case 6: p.splitBand = (value > 0.5f); break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.frequency;
            case 1: return p.thresholdDb;
            case 2: return p.ratio;
            case 3: return p.maxReductionDb;
            case 4: return p.attackMs;
            case 5: return p.releaseMs;
            case 6: return p.splitBand ? 1.0f : 0.0f;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    DeEsserPro dsp_;
};

// 7. SmartBreathController Wrapper (TypeId: 107)
class EffectSmartBreath : public BaseTrackEffect {
public:
    EffectSmartBreath(float sr) : BaseTrackEffect(107, "Smart Breath Controller", "restoration"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.targetReductionDb = value; break;
            case 1: p.sensitivity = value; break;
            case 2: p.lookaheadMs = value; break;
            case 3: p.attackMs = value; break;
            case 4: p.releaseMs = value; break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.targetReductionDb;
            case 1: return p.sensitivity;
            case 2: return p.lookaheadMs;
            case 3: return p.attackMs;
            case 4: return p.releaseMs;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    SmartBreathController dsp_;
};

// 8. MouthDeClicker Wrapper (TypeId: 108)
class EffectMouthDeClicker : public BaseTrackEffect {
public:
    EffectMouthDeClicker(float sr) : BaseTrackEffect(108, "Mouth De-Clicker", "restoration"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.sensitivity = value; break;
            case 1: p.maxClickDurationSamples = static_cast<size_t>(value); break;
            case 2: p.highPassCutoff = value; break;
            case 3: p.wideningMargin = static_cast<size_t>(value); break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.sensitivity;
            case 1: return static_cast<float>(p.maxClickDurationSamples);
            case 2: return p.highPassCutoff;
            case 3: return static_cast<float>(p.wideningMargin);
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    MouthDeClicker dsp_;
};

// 9. ProximityControl Wrapper (TypeId: 109)
class EffectProximityControl : public BaseTrackEffect {
public:
    EffectProximityControl(float sr) : BaseTrackEffect(109, "Proximity Control", "restoration"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.cutoffFrequency = value; break;
            case 1: p.thresholdDb = value; break;
            case 2: p.maxReductionDb = value; break;
            case 3: p.responseMs = value; break;
            case 4: p.releaseMs = value; break;
            case 5: p.sensitivity = value; break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.cutoffFrequency;
            case 1: return p.thresholdDb;
            case 2: return p.maxReductionDb;
            case 3: return p.responseMs;
            case 4: return p.releaseMs;
            case 5: return p.sensitivity;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    ProximityControl dsp_;
};

// 10. AutoPhaseAligner Wrapper (TypeId: 110)
class EffectAutoPhaseAligner : public BaseTrackEffect {
public:
    EffectAutoPhaseAligner(float sr) : BaseTrackEffect(110, "Auto Phase Aligner", "restoration"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.maxShiftMs = value; break;
            case 1: p.autoInvertPolarity = (value > 0.5f); break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.maxShiftMs;
            case 1: return p.autoInvertPolarity ? 1.0f : 0.0f;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    AutoPhaseAligner dsp_;
};

// 11. TransientShaper Wrapper (TypeId: 111)
class EffectTransientShaper : public BaseTrackEffect {
public:
    EffectTransientShaper(float sr) : BaseTrackEffect(111, "Transient Shaper", "dynamics"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.attackGainDb = value; break;
            case 1: p.sustainGainDb = value; break;
            case 2: p.outputGainDb = value; break;
            case 3: p.softClip = (value > 0.5f); break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.attackGainDb;
            case 1: return p.sustainGainDb;
            case 2: return p.outputGainDb;
            case 3: return p.softClip ? 1.0f : 0.0f;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    TransientShaper dsp_;
};

// 12. ResonanceSuppressor Wrapper (TypeId: 112)
class EffectResonanceSuppressor : public BaseTrackEffect {
public:
    EffectResonanceSuppressor(float sr) : BaseTrackEffect(112, "Resonance Suppressor", "eq"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.sensitivity = value; break;
            case 1: p.maxAttenuationDb = value; break;
            case 2: p.maxNotches = static_cast<size_t>(value); break;
            case 3: p.sharpness = value; break;
            case 4: p.attackMs = value; break;
            case 5: p.releaseMs = value; break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.sensitivity;
            case 1: return p.maxAttenuationDb;
            case 2: return static_cast<float>(p.maxNotches);
            case 3: return p.sharpness;
            case 4: return p.attackMs;
            case 5: return p.releaseMs;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    ResonanceSuppressor dsp_;
};

// 13. TapeSaturation Wrapper (TypeId: 113)
class EffectTapeSaturation : public BaseTrackEffect {
public:
    EffectTapeSaturation(float sr) : BaseTrackEffect(113, "Tape Saturation", "color"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.driveDb = value; break;
            case 1: p.bias = value; break;
            case 2: p.saturationMix = value; break;
            case 3: p.lowFreqColor = value; break;
            case 4: p.highFreqRolloff = value; break;
            case 5: p.autoGain = (value > 0.5f); break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.driveDb;
            case 1: return p.bias;
            case 2: return p.saturationMix;
            case 3: return p.lowFreqColor;
            case 4: return p.highFreqRolloff;
            case 5: return p.autoGain ? 1.0f : 0.0f;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    TapeSaturation dsp_;
};

// 14. LinearPhaseFilter Wrapper (TypeId: 114)
class EffectLinearPhase : public BaseTrackEffect {
public:
    EffectLinearPhase(float sr) : BaseTrackEffect(114, "Linear Phase Filter", "eq"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.hpFreq = value; break;
            case 1: p.lpFreq = value; break;
            case 2: p.filterOrder = static_cast<int>(value); break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.hpFreq;
            case 1: return p.lpFreq;
            case 2: return static_cast<float>(p.filterOrder);
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    LinearPhaseFilter dsp_;
};

// 15. StudioReverb Wrapper (TypeId: 115)
class EffectStudioReverb : public BaseTrackEffect {
public:
    EffectStudioReverb(float sr) : BaseTrackEffect(115, "Studio Reverb", "spatial"), dsp_(sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.setSampleRate(sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        auto p = dsp_.getParams();
        switch (paramId) {
            case 0: p.roomSize = value; break;
            case 1: p.damping = value; break;
            case 2: p.wetDryMix = value; break;
            case 3: p.preDelayMs = value; break;
            case 4: p.stereoWidth = value; break;
            case 5: p.lowCutHz = value; break;
            default: break;
        }
        dsp_.setParams(p);
    }

    float getParam(int paramId) const noexcept override {
        const auto& p = dsp_.getParams();
        switch (paramId) {
            case 0: return p.roomSize;
            case 1: return p.damping;
            case 2: return p.wetDryMix;
            case 3: return p.preDelayMs;
            case 4: return p.stereoWidth;
            case 5: return p.lowCutHz;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    StudioReverb dsp_;
};

// 16. FFTSpectralFilter Wrapper (TypeId: 116)
class EffectFFTSpectralFilter : public BaseTrackEffect {
public:
    EffectFFTSpectralFilter(float sr) : BaseTrackEffect(116, "FFT Spectral Filter", "eq"), dsp_(2048, sr) {}
    void setSampleRate(float sr) noexcept override { dsp_.init(2048, sr); }
    void reset() noexcept override { dsp_.reset(); }

    void setParam(int paramId, float value) noexcept override {
        switch (paramId) {
            case 0: centerHz_ = value; break;
            case 1: bandwidthHz_ = value; break;
            case 2: gainLinear_ = value; break;
            default: break;
        }
        dsp_.setBandGain(centerHz_, bandwidthHz_, gainLinear_);
    }

    float getParam(int paramId) const noexcept override {
        switch (paramId) {
            case 0: return centerHz_;
            case 1: return bandwidthHz_;
            case 2: return gainLinear_;
            default: return 0.0f;
        }
    }

    void processBlock(float* buffer, size_t numFrames, int channels) noexcept override {
        if (bypassed_) return;
        dsp_.processBlock(buffer, numFrames, channels);
    }

private:
    FFTSpectralFilter dsp_;
    float centerHz_{1000.0f};
    float bandwidthHz_{300.0f};
    float gainLinear_{1.0f};
};

// Фабричный метод
std::unique_ptr<ITrackInsertEffect> createTrackInsertEffect(int typeId, float sampleRate) noexcept {
    switch (typeId) {
        case 101: return std::make_unique<EffectPhraseLeveler>(sampleRate);
        case 102: return std::make_unique<EffectStudioCompressor>(sampleRate);
        case 103: return std::make_unique<EffectParametricEQPro>(sampleRate);
        case 104: return std::make_unique<EffectDynamicEQ>(sampleRate);
        case 105: return std::make_unique<EffectGraphicEQ31>(sampleRate);
        case 106: return std::make_unique<EffectDeEsserPro>(sampleRate);
        case 107: return std::make_unique<EffectSmartBreath>(sampleRate);
        case 108: return std::make_unique<EffectMouthDeClicker>(sampleRate);
        case 109: return std::make_unique<EffectProximityControl>(sampleRate);
        case 110: return std::make_unique<EffectAutoPhaseAligner>(sampleRate);
        case 111: return std::make_unique<EffectTransientShaper>(sampleRate);
        case 112: return std::make_unique<EffectResonanceSuppressor>(sampleRate);
        case 113: return std::make_unique<EffectTapeSaturation>(sampleRate);
        case 114: return std::make_unique<EffectLinearPhase>(sampleRate);
        case 115: return std::make_unique<EffectStudioReverb>(sampleRate);
        case 116: return std::make_unique<EffectFFTSpectralFilter>(sampleRate);
        default: return nullptr;
    }
}

// ============================================================================
// Реализация TrackInsertChain
// ============================================================================

void TrackInsertChain::setSampleRate(float sr) noexcept {
    sampleRate_ = sr;
    for (auto& eff : slots_) {
        if (eff) eff->setSampleRate(sr);
    }
}

void TrackInsertChain::reset() noexcept {
    for (auto& eff : slots_) {
        if (eff) eff->reset();
    }
}

int TrackInsertChain::addEffect(int effectTypeId) noexcept {
    auto eff = createTrackInsertEffect(effectTypeId, sampleRate_);
    if (!eff) return -1;
    slots_.push_back(std::move(eff));
    return static_cast<int>(slots_.size() - 1);
}

bool TrackInsertChain::removeEffect(int slotIdx) noexcept {
    if (slotIdx < 0 || static_cast<size_t>(slotIdx) >= slots_.size()) return false;
    slots_.erase(slots_.begin() + slotIdx);
    return true;
}

bool TrackInsertChain::reorderEffects(int fromIdx, int toIdx) noexcept {
    if (fromIdx < 0 || static_cast<size_t>(fromIdx) >= slots_.size()) return false;
    if (toIdx < 0 || static_cast<size_t>(toIdx) >= slots_.size()) return false;
    if (fromIdx == toIdx) return true;

    auto eff = std::move(slots_[fromIdx]);
    slots_.erase(slots_.begin() + fromIdx);
    slots_.insert(slots_.begin() + toIdx, std::move(eff));
    return true;
}

void TrackInsertChain::clear() noexcept {
    slots_.clear();
}

void TrackInsertChain::setParam(int slotIdx, int paramId, float value) noexcept {
    if (slotIdx >= 0 && static_cast<size_t>(slotIdx) < slots_.size() && slots_[slotIdx]) {
        slots_[slotIdx]->setParam(paramId, value);
    }
}

float TrackInsertChain::getParam(int slotIdx, int paramId) const noexcept {
    if (slotIdx >= 0 && static_cast<size_t>(slotIdx) < slots_.size() && slots_[slotIdx]) {
        return slots_[slotIdx]->getParam(paramId);
    }
    return 0.0f;
}

void TrackInsertChain::setBypass(int slotIdx, bool bypass) noexcept {
    if (slotIdx >= 0 && static_cast<size_t>(slotIdx) < slots_.size() && slots_[slotIdx]) {
        slots_[slotIdx]->setBypass(bypass);
    }
}

bool TrackInsertChain::isBypassed(int slotIdx) const noexcept {
    if (slotIdx >= 0 && static_cast<size_t>(slotIdx) < slots_.size() && slots_[slotIdx]) {
        return slots_[slotIdx]->isBypassed();
    }
    return false;
}

int TrackInsertChain::getEffectTypeId(int slotIdx) const noexcept {
    if (slotIdx >= 0 && static_cast<size_t>(slotIdx) < slots_.size() && slots_[slotIdx]) {
        return slots_[slotIdx]->getTypeId();
    }
    return 0;
}

const char* TrackInsertChain::getEffectName(int slotIdx) const noexcept {
    if (slotIdx >= 0 && static_cast<size_t>(slotIdx) < slots_.size() && slots_[slotIdx]) {
        return slots_[slotIdx]->getName();
    }
    return "";
}

void TrackInsertChain::process(float* buffer, size_t numFrames, int channels) noexcept {
    if (!buffer || numFrames == 0 || channels <= 0 || slots_.empty()) return;

    for (auto& eff : slots_) {
        if (eff && !eff->isBypassed()) {
            eff->processBlock(buffer, numFrames, channels);
        }
    }
}

void TrackInsertChain::loadVocalDefaultChain() noexcept {
    clear();
    // Дефолтный студийный пресет озвучания:
    // 108: MouthDeClicker
    // 107: SmartBreathController
    // 103: ParametricEQPro
    // 102: StudioCompressor
    // 106: DeEsserPro
    addEffect(108);
    addEffect(107);
    addEffect(103);
    addEffect(102);
    addEffect(106);
}

} // namespace DAWCore
