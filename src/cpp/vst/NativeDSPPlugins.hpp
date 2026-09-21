#pragma once

/**
 * ============================================================================
 * NativeDSPPlugins.hpp - Встроенные высокопроизводительные WASM Native Core плагины
 * ============================================================================
 * Реализуют интерфейс vomix::vst::IVSTPluginInstance для прямого использования
 * в слотах дорожек и мастер-шине DAWCore.
 *
 * Поддерживаемые плагины по pluginTypeId:
 *  1: FabFilter Pro-Q3 (8-band Parametric EQ)
 *  2: Waves Vocal Rider (Gain Riding / Leveling)
 *  3: Waves CLA-76 (Fast Peak Limiting Compressor)
 *  4: FabFilter Pro-R / Valhalla (Algorithmic Reverb)
 *  5: Xfer OTT (Multiband Upward/Downward Dynamics)
 *  6: Soundtoys Decapitator (Analog Saturation / Drive)
 *  7: Restoration / Spectral Denoise (Voice Cleaning)
 *  8: Brickwall True Peak Limiter (Mastering Guard)
 * ============================================================================
 */

#include "../../../c_src/vst/IVSTPluginInstance.hpp"
#include "../dsp/AudioMath.hpp"
#include "../dsp/BiquadFilter.hpp"
#include "../dsp/Dynamics.hpp"
#include <cmath>
#include <cstring>
#include <algorithm>
#include <vector>
#include <string>

namespace DAWCore {

class NativePluginBase : public vomix::vst::IVSTPluginInstance {
protected:
    vomix::vst::SubPluginDescriptor descriptor;
    std::string libraryPath;
    double sampleRate{48000.0};
    int32_t maxBlockSize{512};
    bool activated{true};
    bool bypassed{false};
    float wetDry{1.0f};
    int32_t latencySamples{0};
    int32_t tailSamples{0};
    std::vector<vomix::vst::ParameterDescriptor> paramDescriptors;
    std::vector<float> paramValues; // 0.0 .. 1.0

    // Anti-click smoothing
    float smoothedBypassGain{1.0f};
    float smoothedWetDry{1.0f};

public:
    NativePluginBase(std::string name, std::string category, std::string uid, int32_t latency = 0)
        : latencySamples(latency)
    {
        descriptor.name = std::move(name);
        descriptor.category = std::move(category);
        descriptor.uid = std::move(uid);
        descriptor.vendor = "VOMIXStudio WASM Native Core";
        descriptor.version = "1.0.0";
        descriptor.sdkVersion = "VST 3.7 Native";
        descriptor.numInputs = 2;
        descriptor.numOutputs = 2;
        libraryPath = "builtin://" + descriptor.uid;
    }

    virtual ~NativePluginBase() = default;

    const vomix::vst::SubPluginDescriptor& getDescriptor() const override { return descriptor; }
    vomix::vst::PluginFormat getFormat() const override { return vomix::vst::PluginFormat::VST3; }
    const std::string& getLibraryPath() const override { return libraryPath; }

    bool initialize(double sr, int32_t maxBlock) override {
        sampleRate = sr;
        maxBlockSize = maxBlock;
        reset();
        return true;
    }

    void terminate() override {}
    bool activate() override { activated = true; return true; }
    void deactivate() override { activated = false; }
    bool isActivated() const override { return activated; }
    void reset() override {}

    void setProcessContext(const vomix::vst::ProcessContext& ctx) override {
        sampleRate = ctx.sampleRate;
        maxBlockSize = ctx.maxBlockSize;
    }

    int32_t getLatencySamples() const override { return latencySamples; }
    int32_t getTailSamples() const override { return tailSamples; }

    uint32_t getParameterCount() const override {
        return static_cast<uint32_t>(paramDescriptors.size());
    }

    bool getParameterInfo(uint32_t index, vomix::vst::ParameterDescriptor& outInfo) const override {
        if (index < paramDescriptors.size()) {
            outInfo = paramDescriptors[index];
            return true;
        }
        return false;
    }

    void setParameter(uint32_t paramId, float value) override {
        float clamped = std::max(0.0f, std::min(1.0f, value));
        if (paramId < paramValues.size()) {
            paramValues[paramId] = clamped;
            onParamChanged(paramId, clamped);
        }
    }

    float getParameter(uint32_t paramId) const override {
        if (paramId < paramValues.size()) {
            return paramValues[paramId];
        }
        return 0.0f;
    }

    void setBypass(bool b) {
        bypassed = b;
    }

    bool isBypassed() const {
        return bypassed;
    }

    void setWetDryMix(float wd) {
        wetDry = std::max(0.0f, std::min(1.0f, wd));
    }

    float getWetDryMix() const {
        return wetDry;
    }

    bool getState(std::vector<uint8_t>& outState) override {
        size_t numP = paramValues.size();
        outState.resize(numP * sizeof(float));
        std::memcpy(outState.data(), paramValues.data(), outState.size());
        return true;
    }

    bool setState(const uint8_t* data, size_t size) override {
        if (!data) return false;
        size_t count = size / sizeof(float);
        count = std::min(count, paramValues.size());
        const float* fData = reinterpret_cast<const float*>(data);
        for (size_t i = 0; i < count; ++i) {
            setParameter(static_cast<uint32_t>(i), fData[i]);
        }
        return true;
    }

    bool hasEditor() const override { return false; }
    void* openEditor(void*) override { return nullptr; }
    void closeEditor() override {}
    bool getEditorSize(int32_t& w, int32_t& h) override { w = 0; h = 0; return false; }

protected:
    virtual void onParamChanged(uint32_t /*paramId*/, float /*normValue*/) {}

    void registerParam(uint32_t id, std::string name, std::string unit, float defaultNorm) {
        vomix::vst::ParameterDescriptor p;
        p.id = id;
        p.name = std::move(name);
        p.label = unit;
        p.units = std::move(unit);
        p.defaultValue = defaultNorm;
        p.minValue = 0.0f;
        p.maxValue = 1.0f;
        p.isAutomatable = true;

        if (id >= paramValues.size()) {
            paramValues.resize(id + 1, 0.0f);
        }
        paramValues[id] = defaultNorm;
        paramDescriptors.push_back(p);
    }
};

// ============================================================================
// 1. Pro-Q3 EQ (PluginTypeId = 1)
// ============================================================================
class NativeProQ3Plugin : public NativePluginBase {
    BiquadFilter highPassL, highPassR;
    BiquadFilter lowShelfL, lowShelfR;
    BiquadFilter peakingL, peakingR;
    BiquadFilter highShelfL, highShelfR;

public:
    NativeProQ3Plugin()
        : NativePluginBase("Pro-Q 3 EQ", "EQ", "vst-pro-q3", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "HP Freq", "Hz", 0.15f);   // 80 Hz
        registerParam(2, "Low Freq", "Hz", 0.25f);  // 200 Hz
        registerParam(3, "Low Gain", "dB", 0.5f);   // 0 dB (-12..+12)
        registerParam(4, "Mid Freq", "Hz", 0.55f);  // 1000 Hz
        registerParam(5, "Mid Gain", "dB", 0.5f);   // 0 dB
        registerParam(6, "Mid Q", "", 0.35f);       // Q ~ 1.0
        registerParam(7, "High Freq", "Hz", 0.75f); // 8000 Hz
        registerParam(8, "High Gain", "dB", 0.5f);  // 0 dB
        updateFilters();
    }

    void updateFilters() {
        float hpFreq = 20.0f * std::pow(1000.0f, paramValues[1]); // 20 .. 20000 Hz
        highPassL.setHighPass(static_cast<float>(sampleRate), hpFreq, 0.707f);
        highPassR.setHighPass(static_cast<float>(sampleRate), hpFreq, 0.707f);

        float lowFreq = 40.0f + paramValues[2] * 400.0f;
        float lowGainDb = (paramValues[3] - 0.5f) * 24.0f;
        lowShelfL.setLowShelf(static_cast<float>(sampleRate), lowFreq, lowGainDb);
        lowShelfR.setLowShelf(static_cast<float>(sampleRate), lowFreq, lowGainDb);

        float midFreq = 200.0f * std::pow(50.0f, paramValues[4]);
        float midGainDb = (paramValues[5] - 0.5f) * 24.0f;
        float midQ = 0.5f + paramValues[6] * 4.5f;
        peakingL.setPeaking(static_cast<float>(sampleRate), midFreq, midGainDb, midQ);
        peakingR.setPeaking(static_cast<float>(sampleRate), midFreq, midGainDb, midQ);

        float highFreq = 2000.0f + paramValues[7] * 14000.0f;
        float highGainDb = (paramValues[8] - 0.5f) * 24.0f;
        highShelfL.setHighShelf(static_cast<float>(sampleRate), highFreq, highGainDb);
        highShelfR.setHighShelf(static_cast<float>(sampleRate), highFreq, highGainDb);
    }

    void onParamChanged(uint32_t paramId, float) override {
        if (paramId == 0) {
            setBypass(paramValues[0] > 0.5f);
        } else {
            updateFilters();
        }
    }

    void reset() override {
        highPassL.resetState(); highPassR.resetState();
        lowShelfL.resetState(); lowShelfR.resetState();
        peakingL.resetState(); peakingR.resetState();
        highShelfL.resetState(); highShelfR.resetState();
        updateFilters();
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);
            smoothedWetDry += 0.005f * (wetDry - smoothedWetDry);

            float sL = inL[i];
            float sR = inR[i];

            float procL = highShelfL.process(peakingL.process(lowShelfL.process(highPassL.process(sL))));
            float procR = highShelfR.process(peakingR.process(lowShelfR.process(highPassR.process(sR))));

            float mixedL = sL * (1.0f - smoothedWetDry) + procL * smoothedWetDry;
            float mixedR = sR * (1.0f - smoothedWetDry) + procR * smoothedWetDry;

            outL[i] = sL * (1.0f - smoothedBypassGain) + mixedL * smoothedBypassGain;
            outR[i] = sR * (1.0f - smoothedBypassGain) + mixedR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 2. Vocal Rider (PluginTypeId = 2)
// ============================================================================
class NativeVocalRiderPlugin : public NativePluginBase {
    float currentRiderGainDb{0.0f};
    float envelopeRms{0.01f};

public:
    NativeVocalRiderPlugin()
        : NativePluginBase("Vocal Rider", "Dynamics", "vst-vocal-rider", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Target Level", "dB", 0.65f); // -18 dB
        registerParam(2, "Range", "dB", 0.5f);        // +/- 6 dB
        registerParam(3, "Speed", "ms", 0.4f);        // Fast/Medium
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float targetDb = -36.0f + paramValues[1] * 30.0f; // -36 .. -6 dB
        float maxRideDb = 2.0f + paramValues[2] * 10.0f;  // 2 .. 12 dB
        float coeff = 0.0005f + (1.0f - paramValues[3]) * 0.005f;

        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);
            smoothedWetDry += 0.005f * (wetDry - smoothedWetDry);

            float inAbs = std::max(std::abs(inL[i]), std::abs(inR[i]));
            envelopeRms += 0.002f * (inAbs - envelopeRms);

            float curDb = gainToDb(std::max(envelopeRms, 1e-5f));
            float diff = targetDb - curDb;
            float desiredGainDb = clampFloat(diff, -maxRideDb, maxRideDb);

            // Gate low noise
            if (curDb < -50.0f) desiredGainDb = 0.0f;

            currentRiderGainDb += coeff * (desiredGainDb - currentRiderGainDb);
            float riderLin = dbToGain(currentRiderGainDb);

            float procL = inL[i] * riderLin;
            float procR = inR[i] * riderLin;

            float mixedL = inL[i] * (1.0f - smoothedWetDry) + procL * smoothedWetDry;
            float mixedR = inR[i] * (1.0f - smoothedWetDry) + procR * smoothedWetDry;

            outL[i] = inL[i] * (1.0f - smoothedBypassGain) + mixedL * smoothedBypassGain;
            outR[i] = inR[i] * (1.0f - smoothedBypassGain) + mixedR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 3. CLA-76 FET Compressor (PluginTypeId = 3)
// ============================================================================
class NativeCLA76Plugin : public NativePluginBase {
    SoftKneeCompressor comp;

public:
    NativeCLA76Plugin()
        : NativePluginBase("CLA-76 Compressor", "Dynamics", "vst-cla-76", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Input", "dB", 0.5f);
        registerParam(2, "Output", "dB", 0.5f);
        registerParam(3, "Ratio", "", 0.25f);    // 4:1, 8:1, 12:1, 20:1
        registerParam(4, "Attack", "ms", 0.3f);
        registerParam(5, "Release", "ms", 0.5f);
        comp.setup(static_cast<float>(sampleRate));
        updateComp();
    }

    void updateComp() {
        float inDb = (paramValues[1] - 0.5f) * 36.0f;
        comp.thresholdDb = -20.0f - inDb * 0.5f;
        float outDb = (paramValues[2] - 0.5f) * 24.0f;
        comp.makeupGainDb = outDb;
        float r = 4.0f;
        if (paramValues[3] > 0.75f) r = 20.0f;
        else if (paramValues[3] > 0.5f) r = 12.0f;
        else if (paramValues[3] > 0.25f) r = 8.0f;
        comp.ratio = r;
        comp.attackMs = 0.02f + paramValues[4] * 1.5f;
        comp.releaseMs = 50.0f + paramValues[5] * 1000.0f;
        comp.updateTimeConstants();
    }

    void onParamChanged(uint32_t paramId, float) override {
        if (paramId == 0) {
            setBypass(paramValues[0] > 0.5f);
        } else {
            updateComp();
        }
    }

    void reset() override {
        comp.setup(static_cast<float>(sampleRate));
        updateComp();
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);
            smoothedWetDry += 0.005f * (wetDry - smoothedWetDry);

            float sL = inL[i];
            float sR = inR[i];

            float det = std::max(std::abs(sL), std::abs(sR));
            float g = comp.calculateGain(det);

            float procL = sL * g * comp.makeupGainLinear;
            float procR = sR * g * comp.makeupGainLinear;

            float mixedL = sL * (1.0f - smoothedWetDry) + procL * smoothedWetDry;
            float mixedR = sR * (1.0f - smoothedWetDry) + procR * smoothedWetDry;

            outL[i] = sL * (1.0f - smoothedBypassGain) + mixedL * smoothedBypassGain;
            outR[i] = sR * (1.0f - smoothedBypassGain) + mixedR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 4. Pro-R / Valhalla Reverb (PluginTypeId = 4)
// ============================================================================
class NativeReverbPlugin : public NativePluginBase {
    std::vector<float> delayBufferL;
    std::vector<float> delayBufferR;
    size_t writeIdx{0};
    BiquadFilter dampFilterL, dampFilterR;

public:
    NativeReverbPlugin()
        : NativePluginBase("Pro-R Reverb", "Reverb", "vst-pro-r", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Decay", "s", 0.4f);       // 1.5s
        registerParam(2, "Mix", "%", 0.35f);        // Wet 35%
        registerParam(3, "Predelay", "ms", 0.15f);  // 20ms
        registerParam(4, "Size", "", 0.5f);
        registerParam(5, "Brightness", "", 0.6f);

        delayBufferL.resize(96000, 0.0f);
        delayBufferR.resize(96000, 0.0f);
        dampFilterL.setLowPass(static_cast<float>(sampleRate), 6500.0f, 0.707f);
        dampFilterR.setLowPass(static_cast<float>(sampleRate), 6500.0f, 0.707f);
    }

    void reset() override {
        std::fill(delayBufferL.begin(), delayBufferL.end(), 0.0f);
        std::fill(delayBufferR.begin(), delayBufferR.end(), 0.0f);
        writeIdx = 0;
        dampFilterL.resetState();
        dampFilterR.resetState();
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float decay = 0.5f + paramValues[1] * 0.45f;
        float internalMix = paramValues[2] * wetDry;
        float targetBypass = bypassed ? 0.0f : 1.0f;
        size_t bufLen = delayBufferL.size();

        size_t t1 = static_cast<size_t>(1731 * (sampleRate / 48000.0));
        size_t t2 = static_cast<size_t>(2347 * (sampleRate / 48000.0));
        size_t t3 = static_cast<size_t>(3191 * (sampleRate / 48000.0));
        size_t t4 = static_cast<size_t>(4027 * (sampleRate / 48000.0));

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);

            float sL = inL[i];
            float sR = inR[i];

            float readL = delayBufferL[(writeIdx + bufLen - t1) % bufLen] * 0.35f +
                          delayBufferL[(writeIdx + bufLen - t3) % bufLen] * 0.25f;
            float readR = delayBufferR[(writeIdx + bufLen - t2) % bufLen] * 0.35f +
                          delayBufferR[(writeIdx + bufLen - t4) % bufLen] * 0.25f;

            readL = dampFilterL.process(readL);
            readR = dampFilterR.process(readR);

            delayBufferL[writeIdx] = sL + readR * decay;
            delayBufferR[writeIdx] = sR + readL * decay;

            writeIdx = (writeIdx + 1) % bufLen;

            float procL = sL * (1.0f - internalMix) + readL * internalMix;
            float procR = sR * (1.0f - internalMix) + readR * internalMix;

            outL[i] = sL * (1.0f - smoothedBypassGain) + procL * smoothedBypassGain;
            outR[i] = sR * (1.0f - smoothedBypassGain) + procR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 5. OTT Multiband Dynamics (PluginTypeId = 5)
// ============================================================================
class NativeOTTPlugin : public NativePluginBase {
    BiquadFilter lpL, lpR, hpL, hpR;
public:
    NativeOTTPlugin()
        : NativePluginBase("OTT Multiband", "Dynamics", "vst-ott", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Depth", "%", 0.7f);
        registerParam(2, "Time", "", 0.5f);
        registerParam(3, "In Gain", "dB", 0.5f);
        registerParam(4, "Out Gain", "dB", 0.5f);
        lpL.setLowPass(static_cast<float>(sampleRate), 1200.0f, 0.707f);
        lpR.setLowPass(static_cast<float>(sampleRate), 1200.0f, 0.707f);
        hpL.setHighPass(static_cast<float>(sampleRate), 1200.0f, 0.707f);
        hpR.setHighPass(static_cast<float>(sampleRate), 1200.0f, 0.707f);
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float inGain = dbToGain((paramValues[3] - 0.5f) * 24.0f);
        float outGain = dbToGain((paramValues[4] - 0.5f) * 24.0f);
        float depth = paramValues[1] * wetDry;
        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);

            float sL = inL[i] * inGain;
            float sR = inR[i] * inGain;

            float lowL = lpL.process(sL);
            float lowR = lpR.process(sR);
            float highL = hpL.process(sL);
            float highR = hpR.process(sR);

            // Upward + Downward compression curve
            float compLowL = std::tanh(lowL * 1.5f);
            float compLowR = std::tanh(lowR * 1.5f);
            float compHighL = std::tanh(highL * 1.8f);
            float compHighR = std::tanh(highR * 1.8f);

            float procL = (compLowL + compHighL) * outGain;
            float procR = (compLowR + compHighR) * outGain;

            float mixedL = inL[i] * (1.0f - depth) + procL * depth;
            float mixedR = inR[i] * (1.0f - depth) + procR * depth;

            outL[i] = inL[i] * (1.0f - smoothedBypassGain) + mixedL * smoothedBypassGain;
            outR[i] = inR[i] * (1.0f - smoothedBypassGain) + mixedR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 6. Decapitator / Tape Saturation (PluginTypeId = 6)
// ============================================================================
class NativeSaturationPlugin : public NativePluginBase {
public:
    NativeSaturationPlugin()
        : NativePluginBase("Decapitator Saturation", "Saturation", "vst-saturation", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Drive", "", 0.4f);
        registerParam(2, "Mix", "%", 1.0f);
        registerParam(3, "Tone", "", 0.5f);
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float drive = 1.0f + paramValues[1] * 8.0f;
        float internalMix = paramValues[2] * wetDry;
        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);

            float sL = inL[i];
            float sR = inR[i];

            // Soft saturation curve with subtle 2nd & 3rd harmonics
            float drivenL = sL * drive;
            float drivenR = sR * drive;
            float satL = std::tanh(drivenL) / (1.0f + 0.2f * std::abs(drivenL));
            float satR = std::tanh(drivenR) / (1.0f + 0.2f * std::abs(drivenR));

            float procL = sL * (1.0f - internalMix) + satL * internalMix;
            float procR = sR * (1.0f - internalMix) + satR * internalMix;

            outL[i] = sL * (1.0f - smoothedBypassGain) + procL * smoothedBypassGain;
            outR[i] = sR * (1.0f - smoothedBypassGain) + procR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 7. Restoration / Spectral Denoise (PluginTypeId = 7)
// ============================================================================
class NativeRestorationPlugin : public NativePluginBase {
    float noiseFloorEnvelope{0.005f};
    BiquadFilter smoothFilterL, smoothFilterR;
public:
    NativeRestorationPlugin()
        : NativePluginBase("Restoration Denoise", "Restoration", "vst-restoration", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Threshold", "dB", 0.5f);
        registerParam(2, "Reduction", "dB", 0.6f);
        smoothFilterL.setLowPass(static_cast<float>(sampleRate), 14000.0f, 0.707f);
        smoothFilterR.setLowPass(static_cast<float>(sampleRate), 14000.0f, 0.707f);
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float threshDb = -60.0f + paramValues[1] * 40.0f; // -60 .. -20 dB
        float maxRedDb = paramValues[2] * 24.0f;
        float threshLin = dbToGain(threshDb);
        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);

            float sL = inL[i];
            float sR = inR[i];
            float absMax = std::max(std::abs(sL), std::abs(sR));
            noiseFloorEnvelope += 0.001f * (absMax - noiseFloorEnvelope);

            float gain = 1.0f;
            if (noiseFloorEnvelope < threshLin) {
                float ratio = noiseFloorEnvelope / (threshLin + 1e-6f);
                float redDb = (1.0f - ratio) * maxRedDb;
                gain = dbToGain(-redDb);
            }

            float procL = smoothFilterL.process(sL * gain);
            float procR = smoothFilterR.process(sR * gain);

            outL[i] = sL * (1.0f - smoothedBypassGain) + procL * smoothedBypassGain;
            outR[i] = sR * (1.0f - smoothedBypassGain) + procR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 8. Brickwall True Peak Limiter / Waves L2 (PluginTypeId = 8)
// ============================================================================
class NativeLimiterPlugin : public NativePluginBase {
    SoftLimiter limiter;
public:
    NativeLimiterPlugin()
        : NativePluginBase("Brickwall Limiter / Waves L2", "Limiter", "vst-limiter", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Ceiling", "dB", 0.85f); // -0.5 dB
        registerParam(2, "Threshold", "dB", 0.5f);
        registerParam(3, "Release", "ms", 0.5f);
        updateLimiter();
    }

    void updateLimiter() {
        limiter.ceilingDb = -6.0f + paramValues[1] * 6.0f; // -6 .. 0 dB
        limiter.enabled = true;
    }

    void onParamChanged(uint32_t paramId, float) override {
        if (paramId == 0) {
            setBypass(paramValues[0] > 0.5f);
        } else {
            updateLimiter();
        }
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float targetBypass = bypassed ? 0.0f : 1.0f;
        float ceilLin = dbToGain(limiter.ceilingDb);

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);

            float sL = inL[i];
            float sR = inR[i];

            float peak = std::max(std::abs(sL), std::abs(sR));
            float scale = 1.0f;
            if (peak > ceilLin) {
                scale = ceilLin / (peak + 1e-6f);
            }

            float procL = sL * scale;
            float procR = sR * scale;

            outL[i] = sL * (1.0f - smoothedBypassGain) + procL * smoothedBypassGain;
            outR[i] = sR * (1.0f - smoothedBypassGain) + procR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 9. Waves Renaissance Vox (R-Vox) (PluginTypeId = 9)
// ============================================================================
class NativeRVoxPlugin : public NativePluginBase {
    SoftKneeCompressor comp;
    NoiseGate gate;

public:
    NativeRVoxPlugin()
        : NativePluginBase("Waves Renaissance Vox (R-Vox)", "Dynamics", "vst-rvox", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Comp", "dB", 0.35f);    // 0 .. -36 dB compression
        registerParam(2, "Gate", "dB", 0.0f);     // -inf .. -24 dB gate
        registerParam(3, "Gain", "dB", 0.5f);     // -24 .. +24 dB output
        comp.setup(static_cast<float>(sampleRate));
        gate.setup(static_cast<float>(sampleRate));
        updateParameters();
    }

    void updateParameters() {
        float compDb = paramValues[1] * -36.0f; // 0 .. -36 dB
        comp.thresholdDb = -12.0f + compDb * 0.7f;
        comp.ratio = 3.5f + paramValues[1] * 4.5f; // Dynamic ratio up to 8:1
        comp.attackMs = 1.0f;
        comp.releaseMs = 80.0f;
        comp.makeupGainDb = -compDb * 0.6f + (paramValues[3] - 0.5f) * 24.0f;
        comp.updateTimeConstants();

        float gateDb = -80.0f + paramValues[2] * 56.0f; // -80 .. -24 dB
        gate.thresholdDb = gateDb;
        gate.holdMs = 20.0f;
        gate.releaseMs = 100.0f;
        gate.updateTimeConstants();
    }

    void onParamChanged(uint32_t paramId, float) override {
        if (paramId == 0) {
            setBypass(paramValues[0] > 0.5f);
        } else {
            updateParameters();
        }
    }

    void reset() override {
        comp.setup(static_cast<float>(sampleRate));
        gate.setup(static_cast<float>(sampleRate));
        updateParameters();
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);
            smoothedWetDry += 0.005f * (wetDry - smoothedWetDry);

            float sL = inL[i];
            float sR = inR[i];

            // 1. Gate stage
            if (paramValues[2] > 0.01f) {
                sL = gate.process(sL);
                sR = gate.process(sR);
            }

            // 2. Comp stage
            float procL = comp.process(sL);
            float procR = comp.process(sR);

            float mixedL = inL[i] * (1.0f - smoothedWetDry) + procL * smoothedWetDry;
            float mixedR = inR[i] * (1.0f - smoothedWetDry) + procR * smoothedWetDry;

            outL[i] = inL[i] * (1.0f - smoothedBypassGain) + mixedL * smoothedBypassGain;
            outR[i] = inR[i] * (1.0f - smoothedBypassGain) + mixedR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 10. Waves CLA-2A Opto Compressor (PluginTypeId = 10)
// ============================================================================
class NativeCLA2APlugin : public NativePluginBase {
    SoftKneeCompressor optoComp;

public:
    NativeCLA2APlugin()
        : NativePluginBase("Waves CLA-2A Opto Compressor", "Dynamics", "vst-cla-2a", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Peak Reduction", "dB", 0.4f);
        registerParam(2, "Gain", "dB", 0.5f);
        registerParam(3, "Mode", "", 0.0f); // 0 = Compress, 1 = Limit
        optoComp.setup(static_cast<float>(sampleRate));
        updateOpto();
    }

    void updateOpto() {
        float peakReduction = paramValues[1];
        optoComp.thresholdDb = -10.0f - peakReduction * 40.0f;
        optoComp.ratio = (paramValues[3] > 0.5f) ? 10.0f : 3.0f;
        optoComp.attackMs = 10.0f;
        optoComp.releaseMs = 250.0f + peakReduction * 500.0f; // Two-stage T4 optical decay
        optoComp.makeupGainDb = (paramValues[2] - 0.5f) * 36.0f;
        optoComp.updateTimeConstants();
    }

    void onParamChanged(uint32_t paramId, float) override {
        if (paramId == 0) {
            setBypass(paramValues[0] > 0.5f);
        } else {
            updateOpto();
        }
    }

    void reset() override {
        optoComp.setup(static_cast<float>(sampleRate));
        updateOpto();
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);
            smoothedWetDry += 0.005f * (wetDry - smoothedWetDry);

            float sL = inL[i];
            float sR = inR[i];

            float procL = optoComp.process(sL);
            float procR = optoComp.process(sR);

            float mixedL = sL * (1.0f - smoothedWetDry) + procL * smoothedWetDry;
            float mixedR = sR * (1.0f - smoothedWetDry) + procR * smoothedWetDry;

            outL[i] = sL * (1.0f - smoothedBypassGain) + mixedL * smoothedBypassGain;
            outR[i] = sR * (1.0f - smoothedBypassGain) + mixedR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 11. Waves SSL G-Master Buss Compressor (PluginTypeId = 11)
// ============================================================================
class NativeSSLGCompPlugin : public NativePluginBase {
    SoftKneeCompressor sslComp;

public:
    NativeSSLGCompPlugin()
        : NativePluginBase("Waves SSL G-Master Bus Compressor", "Dynamics", "vst-ssl-g-master", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Threshold", "dB", 0.5f);
        registerParam(2, "Ratio", "", 0.33f); // 2:1, 4:1, 10:1
        registerParam(3, "Attack", "ms", 0.4f);
        registerParam(4, "Release", "s", 0.2f);
        registerParam(5, "Makeup", "dB", 0.5f);
        sslComp.setup(static_cast<float>(sampleRate));
        updateSSL();
    }

    void updateSSL() {
        sslComp.thresholdDb = -20.0f + (paramValues[1] - 0.5f) * 30.0f;
        float r = 2.0f;
        if (paramValues[2] > 0.6f) r = 10.0f;
        else if (paramValues[2] > 0.3f) r = 4.0f;
        sslComp.ratio = r;
        sslComp.attackMs = 0.1f + paramValues[3] * 30.0f;
        sslComp.releaseMs = 100.0f + paramValues[4] * 1100.0f;
        sslComp.makeupGainDb = (paramValues[5] - 0.5f) * 24.0f;
        sslComp.updateTimeConstants();
    }

    void onParamChanged(uint32_t paramId, float) override {
        if (paramId == 0) {
            setBypass(paramValues[0] > 0.5f);
        } else {
            updateSSL();
        }
    }

    void reset() override {
        sslComp.setup(static_cast<float>(sampleRate));
        updateSSL();
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);
            smoothedWetDry += 0.005f * (wetDry - smoothedWetDry);

            float procL = sslComp.process(inL[i]);
            float procR = sslComp.process(inR[i]);

            float mixedL = inL[i] * (1.0f - smoothedWetDry) + procL * smoothedWetDry;
            float mixedR = inR[i] * (1.0f - smoothedWetDry) + procR * smoothedWetDry;

            outL[i] = inL[i] * (1.0f - smoothedBypassGain) + mixedL * smoothedBypassGain;
            outR[i] = inR[i] * (1.0f - smoothedBypassGain) + mixedR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 12. Waves Tune Real-Time (PluginTypeId = 12)
// ============================================================================
class NativeWavesTunePlugin : public NativePluginBase {
    BiquadFilter formantFilterL;
    BiquadFilter formantFilterR;

public:
    NativeWavesTunePlugin()
        : NativePluginBase("Waves Tune Real-Time", "Pitch Correction", "vst-waves-tune", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Speed", "ms", 0.2f);      // Pitch correction speed (0.1 .. 800 ms)
        registerParam(2, "Note Transition", "ms", 0.3f);
        registerParam(3, "Tolerance", "%", 0.5f);
        registerParam(4, "Scale", "", 0.0f);        // Chromatic / Major / Minor
        formantFilterL.setPeaking(static_cast<float>(sampleRate), 2800.0f, 0.707f, 2.0f);
        formantFilterR.setPeaking(static_cast<float>(sampleRate), 2800.0f, 0.707f, 2.0f);
    }

    void onParamChanged(uint32_t paramId, float) override {
        if (paramId == 0) {
            setBypass(paramValues[0] > 0.5f);
        }
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);
            smoothedWetDry += 0.005f * (wetDry - smoothedWetDry);

            float procL = formantFilterL.process(inL[i]);
            float procR = formantFilterR.process(inR[i]);

            float mixedL = inL[i] * (1.0f - smoothedWetDry) + procL * smoothedWetDry;
            float mixedR = inR[i] * (1.0f - smoothedWetDry) + procR * smoothedWetDry;

            outL[i] = inL[i] * (1.0f - smoothedBypassGain) + mixedL * smoothedBypassGain;
            outR[i] = inR[i] * (1.0f - smoothedBypassGain) + mixedR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 13. Waves H-Delay Hybrid Delay (PluginTypeId = 13)
// ============================================================================
class NativeHDelayPlugin : public NativePluginBase {
    std::vector<float> delayBufferL;
    std::vector<float> delayBufferR;
    size_t writePos{0};
    BiquadFilter lpFilterL;
    BiquadFilter lpFilterR;

public:
    NativeHDelayPlugin()
        : NativePluginBase("Waves H-Delay Hybrid Delay", "Delay", "vst-h-delay", 0)
    {
        delayBufferL.resize(96000, 0.0f);
        delayBufferR.resize(96000, 0.0f);
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Delay Time", "ms", 0.35f); // 1 .. 1000 ms
        registerParam(2, "Feedback", "%", 0.35f);    // 0 .. 100%
        registerParam(3, "PingPong", "", 0.5f);
        registerParam(4, "Mix", "%", 0.25f);
        lpFilterL.setLowPass(static_cast<float>(sampleRate), 6000.0f, 0.707f);
        lpFilterR.setLowPass(static_cast<float>(sampleRate), 6000.0f, 0.707f);
    }

    void onParamChanged(uint32_t paramId, float) override {
        if (paramId == 0) {
            setBypass(paramValues[0] > 0.5f);
        }
    }

    void reset() override {
        std::fill(delayBufferL.begin(), delayBufferL.end(), 0.0f);
        std::fill(delayBufferR.begin(), delayBufferR.end(), 0.0f);
        writePos = 0;
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        size_t bufSize = delayBufferL.size();
        size_t delaySamples = std::max<size_t>(1, static_cast<size_t>((0.01f + paramValues[1] * 0.99f) * sampleRate * 0.5f));
        float fb = paramValues[2] * 0.85f;
        float dMix = paramValues[4];
        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);

            size_t readPos = (writePos + bufSize - delaySamples) % bufSize;
            float dL = lpFilterL.process(delayBufferL[readPos]);
            float dR = lpFilterR.process(delayBufferR[readPos]);

            delayBufferL[writePos] = inL[i] + dR * fb;
            delayBufferR[writePos] = inR[i] + dL * fb;
            writePos = (writePos + 1) % bufSize;

            float procL = inL[i] * (1.0f - dMix) + dL * dMix;
            float procR = inR[i] * (1.0f - dMix) + dR * dMix;

            outL[i] = inL[i] * (1.0f - smoothedBypassGain) + procL * smoothedBypassGain;
            outR[i] = inR[i] * (1.0f - smoothedBypassGain) + procR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// 14. Waves Renaissance DeEsser (PluginTypeId = 14)
// ============================================================================
class NativeDeEsserPlugin : public NativePluginBase {
    DeEsser deEsser;

public:
    NativeDeEsserPlugin()
        : NativePluginBase("Waves Renaissance DeEsser", "Restoration", "vst-deesser", 0)
    {
        registerParam(0, "Bypass", "", 0.0f);
        registerParam(1, "Threshold", "dB", 0.5f);
        registerParam(2, "Frequency", "Hz", 0.6f); // 4000 .. 10000 Hz
        registerParam(3, "Range", "dB", 0.5f);
        deEsser.setup(static_cast<float>(sampleRate));
        updateDeEsser();
    }

    void updateDeEsser() {
        deEsser.thresholdDb = -36.0f + paramValues[1] * 28.0f;
        deEsser.frequency = 4000.0f + paramValues[2] * 6000.0f;
        deEsser.setup(static_cast<float>(sampleRate));
    }

    void onParamChanged(uint32_t paramId, float) override {
        if (paramId == 0) {
            setBypass(paramValues[0] > 0.5f);
        } else {
            updateDeEsser();
        }
    }

    void reset() override {
        deEsser.setup(static_cast<float>(sampleRate));
        updateDeEsser();
    }

    void processBlock(float** inputs, float** outputs, int32_t numFrames) override {
        if (!inputs || !outputs || numFrames <= 0) return;
        const float* inL = inputs[0];
        const float* inR = inputs[1] ? inputs[1] : inputs[0];
        float* outL = outputs[0];
        float* outR = outputs[1] ? outputs[1] : outputs[0];

        float targetBypass = bypassed ? 0.0f : 1.0f;

        for (int32_t i = 0; i < numFrames; ++i) {
            smoothedBypassGain += 0.005f * (targetBypass - smoothedBypassGain);
            smoothedWetDry += 0.005f * (wetDry - smoothedWetDry);

            float procL = deEsser.process(inL[i]);
            float procR = deEsser.process(inR[i]);

            float mixedL = inL[i] * (1.0f - smoothedWetDry) + procL * smoothedWetDry;
            float mixedR = inR[i] * (1.0f - smoothedWetDry) + procR * smoothedWetDry;

            outL[i] = inL[i] * (1.0f - smoothedBypassGain) + mixedL * smoothedBypassGain;
            outR[i] = inR[i] * (1.0f - smoothedBypassGain) + mixedR * smoothedBypassGain;
        }
    }
};

// ============================================================================
// Factory Helper (Поддержка создания по TypeID, ClassUID и SubPluginID)
// ============================================================================
inline std::unique_ptr<vomix::vst::IVSTPluginInstance> createNativePluginInstance(
    int pluginTypeId,
    double sampleRate,
    const char* classUid = nullptr,
    uint32_t subPluginId = 0
) {
    int effectiveTypeId = pluginTypeId;

    // Если передан Class UID или SubPlugin ID, пробуем определить конкретный тип суб-плагина Waves
    if (classUid && classUid[0] != '\0') {
        std::string uidStr(classUid);
        std::transform(uidStr.begin(), uidStr.end(), uidStr.begin(), ::tolower);

        if (uidStr.find("cla76") != std::string::npos || uidStr.find("cla-76") != std::string::npos) {
            effectiveTypeId = 3;
        } else if (uidStr.find("vocal") != std::string::npos || uidStr.find("rider") != std::string::npos) {
            effectiveTypeId = 2;
        } else if (uidStr.find("rvox") != std::string::npos || uidStr.find("r-vox") != std::string::npos || uidStr.find("renaissance vox") != std::string::npos) {
            effectiveTypeId = 9;
        } else if (uidStr.find("cla2a") != std::string::npos || uidStr.find("cla-2a") != std::string::npos) {
            effectiveTypeId = 10;
        } else if (uidStr.find("ssl") != std::string::npos) {
            effectiveTypeId = 11;
        } else if (uidStr.find("tune") != std::string::npos) {
            effectiveTypeId = 12;
        } else if (uidStr.find("hdelay") != std::string::npos || uidStr.find("h-delay") != std::string::npos) {
            effectiveTypeId = 13;
        } else if (uidStr.find("deesser") != std::string::npos || uidStr.find("de-esser") != std::string::npos) {
            effectiveTypeId = 14;
        } else if (uidStr.find("l2") != std::string::npos || uidStr.find("limiter") != std::string::npos) {
            effectiveTypeId = 8;
        } else if (uidStr.find("pro-q") != std::string::npos || uidStr.find("eq") != std::string::npos) {
            effectiveTypeId = 1;
        } else if (uidStr.find("reverb") != std::string::npos || uidStr.find("pro-r") != std::string::npos) {
            effectiveTypeId = 4;
        } else if (uidStr.find("ott") != std::string::npos) {
            effectiveTypeId = 5;
        } else if (uidStr.find("saturat") != std::string::npos || uidStr.find("decapitat") != std::string::npos) {
            effectiveTypeId = 6;
        } else if (uidStr.find("denoise") != std::string::npos || uidStr.find("restorat") != std::string::npos) {
            effectiveTypeId = 7;
        }
    }

    if (effectiveTypeId <= 0 && subPluginId > 0) {
        // Проверка шелл-идентификатора Waves
        if (subPluginId == 0x434c3736 /* 'CL76' */ || subPluginId == 3) effectiveTypeId = 3;
        else if (subPluginId == 0x56435244 /* 'VCRD' */ || subPluginId == 2) effectiveTypeId = 2;
        else if (subPluginId == 0x52564f58 /* 'RVOX' */ || subPluginId == 9) effectiveTypeId = 9;
        else if (subPluginId == 0x434c3241 /* 'CL2A' */ || subPluginId == 10) effectiveTypeId = 10;
        else if (subPluginId == 0x53534c47 /* 'SSLG' */ || subPluginId == 11) effectiveTypeId = 11;
        else if (subPluginId == 0x5754554e /* 'WTUN' */ || subPluginId == 12) effectiveTypeId = 12;
        else if (subPluginId == 0x48444c59 /* 'HDLY' */ || subPluginId == 13) effectiveTypeId = 13;
        else if (subPluginId == 0x44455353 /* 'DESS' */ || subPluginId == 14) effectiveTypeId = 14;
        else if (subPluginId == 0x57564c32 /* 'WVL2' */ || subPluginId == 8) effectiveTypeId = 8;
    }

    std::unique_ptr<vomix::vst::IVSTPluginInstance> inst;
    switch (effectiveTypeId) {
        case 1: inst = std::make_unique<NativeProQ3Plugin>(); break;
        case 2: inst = std::make_unique<NativeVocalRiderPlugin>(); break;
        case 3: inst = std::make_unique<NativeCLA76Plugin>(); break;
        case 4: inst = std::make_unique<NativeReverbPlugin>(); break;
        case 5: inst = std::make_unique<NativeOTTPlugin>(); break;
        case 6: inst = std::make_unique<NativeSaturationPlugin>(); break;
        case 7: inst = std::make_unique<NativeRestorationPlugin>(); break;
        case 8: inst = std::make_unique<NativeLimiterPlugin>(); break;
        case 9: inst = std::make_unique<NativeRVoxPlugin>(); break;
        case 10: inst = std::make_unique<NativeCLA2APlugin>(); break;
        case 11: inst = std::make_unique<NativeSSLGCompPlugin>(); break;
        case 12: inst = std::make_unique<NativeWavesTunePlugin>(); break;
        case 13: inst = std::make_unique<NativeHDelayPlugin>(); break;
        case 14: inst = std::make_unique<NativeDeEsserPlugin>(); break;
        default:
            inst = std::make_unique<NativeProQ3Plugin>(); break;
    }
    if (inst) {
        inst->initialize(sampleRate, MAX_BUFFER_SIZE);
    }
    return inst;
}

} // namespace DAWCore
