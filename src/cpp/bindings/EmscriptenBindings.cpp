/**
 * ============================================================================
 * EmscriptenBindings.cpp - Экспорт интерфейсов WebAssembly Embind (C++17)
 * ============================================================================
 * Предоставляет высокопроизводительный мост между JavaScript Heap (TypedArrays)
 * и низкоуровневым C++ движком DAW без лишнего копирования памяти.
 * ============================================================================
 */

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include "../dsp/AudioMath.hpp"
#include "../dsp/BiquadFilter.hpp"
#include "../dsp/Dynamics.hpp"
#include "../dsp/StudioCompressor.hpp"
#include "../dsp/ParametricEQPro.hpp"
#include "../dsp/StudioReverb.hpp"
#include "../dsp/FFTSpectralFilter.hpp"
#include "../dsp/TransientShaper.hpp"
#include "../dsp/GraphicEQ31.hpp"
#include "../dsp/DynamicEQ.hpp"
#include "../dsp/LinearPhaseFilter.hpp"
#include "../dsp/ResonanceSuppressor.hpp"
#include "../dsp/TapeSaturation.hpp"
#include "../dsp/SmartBreathController.hpp"
#include "../dsp/MouthDeClicker.hpp"
#include "../dsp/ProximityControl.hpp"
#include "../dsp/AutoPhaseAligner.hpp"
#include "../dsp/AudioUtils.hpp"
#include "../dsp/DeEsserPro.hpp"
#include "../dsp/DePlosivePro.hpp"
#include "../dsp/VocalThickener.hpp"
#include "../dsp/SpectralDeReverb.hpp"
#include "../dsp/HeadroomRecovery.hpp"
#include "../dsp/SpeechLeveler.hpp"
#include "../vst/NativeDSPPlugins.hpp"
#include "../vocal/VocalRack.hpp"
#include "../engine/Clip.hpp"
#include "../engine/Track.hpp"
#include "../engine/TrackInsertChain.hpp"
#include "../engine/Mixer.hpp"
#include "../editing/WSOLATimeStretch.hpp"
#include "../editing/ClipEditor.hpp"
#include "../editing/SilenceStripper.hpp"
#include "../editing/PhraseLoudnessNormalizer.hpp"
#include "../analysis/SpeechAligner.hpp"
#include "../analysis/SubtitleAligner.hpp"
#include "../analysis/StemSeparator.hpp"
#include "../analysis/WaveformAnalyzer.hpp"
#include "../engine/MediaCore.hpp"
#include "../vst/VSTScanner.hpp"
#include "../project/ProjectIndexer.hpp"

using namespace emscripten;
using namespace DAWCore;

// ============================================================================
// Функции управления памятью прямого доступа из JavaScript Heap
// ============================================================================

static uintptr_t JS_AllocateAudioBuffer(size_t numFloats) {
    float* ptr = new float[numFloats]();
    return reinterpret_cast<uintptr_t>(ptr);
}

static void JS_FreeAudioBuffer(uintptr_t ptr) {
    float* fPtr = reinterpret_cast<float*>(ptr);
    delete[] fPtr;
}

static uintptr_t JS_AllocateByteBuffer(size_t numBytes) {
    uint8_t* ptr = new uint8_t[numBytes]();
    return reinterpret_cast<uintptr_t>(ptr);
}

static void JS_FreeByteBuffer(uintptr_t ptr) {
    uint8_t* bPtr = reinterpret_cast<uint8_t*>(ptr);
    delete[] bPtr;
}

// ============================================================================
// Вспомогательные функции обертки для JS
// ============================================================================

static bool JS_AddClipToTrack(
    Mixer& mixer,
    uint32_t trackId,
    uint32_t clipId,
    uintptr_t bufferPtr,
    size_t bufferSizeSamples,
    size_t offsetSamples,
    size_t lengthSamples,
    float gain,
    float pan,
    size_t fadeIn,
    size_t fadeOut,
    bool isStereo
) {
    Track* track = mixer.getTrack(trackId);
    if (!track) {
        auto newTrack = new Track(trackId, "Track " + std::to_string(trackId), mixer.sampleRate);
        mixer.addTrack(newTrack);
        track = newTrack;
    }
    if (!track) return false;

    Clip clip;
    clip.id = clipId;
    clip.sampleBuffer = reinterpret_cast<const float*>(bufferPtr);
    clip.bufferSizeSamples = bufferSizeSamples;
    clip.offsetSamples = offsetSamples;
    clip.lengthSamples = lengthSamples;
    clip.gain = gain;
    clip.pan = pan;
    clip.fadeInSamples = fadeIn;
    clip.fadeOutSamples = fadeOut;
    clip.isStereo = isStereo;
    clip.active = true;

    track->addClip(clip);
    return true;
}

static void JS_ProcessMixer(Mixer& mixer, uintptr_t outputPtr, int numSamples) {
    float* outBuf = reinterpret_cast<float*>(outputPtr);
    mixer.processBlock(outBuf, static_cast<size_t>(numSamples));
}

static size_t JS_RenderProjectOffline(Mixer& mixer, uintptr_t outPtr, int maxFrames, int isolateTrackId) {
    float* outBuf = reinterpret_cast<float*>(outPtr);
    return mixer.renderProjectOffline(outBuf, static_cast<size_t>(maxFrames), isolateTrackId);
}

static LoudnessStats JS_CalculateLoudnessStats(
    uintptr_t bufferPtr,
    int numSamples,
    int channels,
    float targetRmsDb,
    float maxPeakDb
) {
    const float* buf = reinterpret_cast<const float*>(bufferPtr);
    return LoudnessAnalyzer::calculateLoudnessStats(
        buf,
        static_cast<size_t>(numSamples),
        channels,
        targetRmsDb,
        maxPeakDb
    );
}

static size_t JS_ResampleTo48k(
    uintptr_t inPtr,
    int inFrames,
    int inRate,
    uintptr_t outPtr,
    int outCapacityFrames,
    int channels
) {
    const float* inBuf = reinterpret_cast<const float*>(inPtr);
    float* outBuf = reinterpret_cast<float*>(outPtr);
    return AudioResampler::resampleTo48k(
        inBuf,
        static_cast<size_t>(inFrames),
        inRate,
        outBuf,
        static_cast<size_t>(outCapacityFrames),
        channels
    );
}

static size_t JS_PackWav(
    uintptr_t inFloatPtr,
    int numFrames,
    int bitDepth,
    uintptr_t outBytePtr,
    int maxOutBytes,
    int sampleRate
) {
    const float* inBuf = reinterpret_cast<const float*>(inFloatPtr);
    uint8_t* outBuf = reinterpret_cast<uint8_t*>(outBytePtr);
    return NativeWavPacker::packWav(
        inBuf,
        static_cast<size_t>(numFrames),
        bitDepth,
        outBuf,
        static_cast<size_t>(maxOutBytes),
        sampleRate
    );
}

// Функции прямого вызова WSOLA и Split из JavaScript по указателям памяти
static uintptr_t JS_SplitClip(uintptr_t clipPtr, size_t splitSampleOffset) {
    return ClipSliceManager::splitClip(clipPtr, splitSampleOffset);
}

static bool JS_SplitClipNative(
    uintptr_t inPcmPtr,
    size_t totalFrames,
    size_t splitFrameOffset,
    uintptr_t outLeftPcmPtr,
    uintptr_t outRightPcmPtr,
    int channels
) {
    return ClipSliceManager::splitClipNative(inPcmPtr, totalFrames, splitFrameOffset, outLeftPcmPtr, outRightPcmPtr, channels);
}

static bool JS_SplitClipInTrack(
    uint32_t trackId,
    uint32_t clipId,
    size_t splitSampleOffset,
    uint32_t newClipId
) {
    return ClipSliceManager::splitClipInTrack(trackId, clipId, splitSampleOffset, newClipId);
}

static uintptr_t JS_ApplyTimeStretchToClip(
    uint32_t trackId,
    uint32_t clipId,
    float ratio
) {
    return ClipSliceManager::applyTimeStretchToClip(trackId, clipId, ratio);
}

static uintptr_t JS_ProcessWSOLA(
    uintptr_t inputPtr,
    size_t inFrames,
    float ratio,
    bool isStereo
) {
    const float* inBuf = reinterpret_cast<const float*>(inputPtr);
    std::vector<float> res = WSOLATimeStretch::processBuffer(inBuf, inFrames, ratio, isStereo);
    if (res.empty()) return 0;
    float* outBuf = new float[res.size()];
    std::memcpy(outBuf, res.data(), res.size() * sizeof(float));
    ClipSliceManager::s_allocatedBuffers.push_back(outBuf);
    return reinterpret_cast<uintptr_t>(outBuf);
}

static size_t JS_CalculateWSOLAOutputFrames(size_t inFrames, float ratio) {
    return WSOLATimeStretch::calculateOutputFrames(inFrames, ratio);
}

static bool JS_TrimClipStart(uintptr_t clipPtr, size_t trimSamples) {
    return ClipSliceManager::trimClipStart(clipPtr, trimSamples);
}

static bool JS_TrimClipEnd(uintptr_t clipPtr, size_t newLengthSamples) {
    return ClipSliceManager::trimClipEnd(clipPtr, newLengthSamples);
}

static void JS_SetActiveMixer(Mixer& mixer) {
    ClipSliceManager::setActiveMixer(&mixer);
}

// ============================================================================
// Обертки для модуля SilenceStripper (SIMD128 VAD & Pause Stripping)
// ============================================================================

static int JS_StripSilenceNative(
    uintptr_t inPcmPtr,
    size_t totalSamples,
    float thresholdDb,
    float minSilenceMs,
    float paddingMs,
    bool isStereo,
    int sampleRate,
    uintptr_t outSegmentsPtr,
    int maxSegments
) {
    const float* inBuffer = reinterpret_cast<const float*>(inPcmPtr);
    AudioSegment* outSegments = reinterpret_cast<AudioSegment*>(outSegmentsPtr);
    return SilenceStripper::stripSilence(
        inBuffer,
        totalSamples,
        thresholdDb,
        minSilenceMs,
        paddingMs,
        isStereo,
        sampleRate,
        outSegments,
        maxSegments
    );
}

static int JS_StripSilenceFromClip(
    uintptr_t inPcmPtr,
    size_t totalSamples,
    float thresholdDb,
    float minSilenceMs,
    float paddingMs,
    uintptr_t outSegmentsPtr,
    int maxSegments,
    bool isStereo,
    float sampleRate
) {
    return SilenceStripper::stripSilenceFromClip(
        inPcmPtr,
        totalSamples,
        thresholdDb,
        minSilenceMs,
        paddingMs,
        outSegmentsPtr,
        maxSegments,
        isStereo,
        sampleRate
    );
}

static uintptr_t JS_AllocateSegmentBuffer(size_t maxSegments) {
    return SilenceStripper::allocateSegmentBuffer(maxSegments);
}

static void JS_FreeSegmentBuffer(uintptr_t ptr) {
    SilenceStripper::freeSegmentBuffer(ptr);
}

// ============================================================================
// Обертки для модуля SpeechAligner (FastLevenshtein, VAD, SmartAligner)
// ============================================================================

static size_t JS_FastLevenshteinDistance(const std::string& s1, const std::string& s2) {
    return FastLevenshtein::distance(s1, s2);
}

static float JS_FastStringSimilarity(const std::string& s1, const std::string& s2) {
    return FastLevenshtein::similarity(s1, s2);
}

static FrameEnergyStats JS_CalculateFrameEnergyStats(uintptr_t samplesPtr, size_t length) {
    const float* samples = reinterpret_cast<const float*>(samplesPtr);
    return SpeechEnergyDetector::calculateFrameStats(samples, length);
}

static std::vector<SpeechSegment> JS_DetectSpeechSegments(
    uintptr_t samplesPtr,
    size_t totalSamples,
    float sampleRate,
    float threshold,
    float minSpeechDurationMs,
    float minSilenceDurationMs,
    float speechPadMs
) {
    const float* samples = reinterpret_cast<const float*>(samplesPtr);
    VADConfig config;
    config.sampleRate = sampleRate;
    config.threshold = threshold;
    config.minSpeechDurationMs = minSpeechDurationMs;
    config.minSilenceDurationMs = minSilenceDurationMs;
    config.speechPadMs = speechPadMs;
    return SpeechEnergyDetector::detectSegments(samples, totalSamples, sampleRate, config);
}

static std::vector<AlignedPhrase> JS_AlignSpeechWithScript(
    const std::vector<ScriptLine>& scriptLines,
    const std::vector<SpeechSegment>& speechSegments,
    const std::vector<TranscriptionSegment>& transcriptionSegments
) {
    return SmartAligner::align(scriptLines, speechSegments, transcriptionSegments);
}

static std::vector<SubtitleCueNative> JS_ParseSubtitleContent(const std::string& content) {
    return SubtitleParser::parseSrtAss(content);
}

static std::vector<AlignedPhrase> JS_AlignWithAnchor(
    const std::vector<ScriptLine>& scriptLines,
    const std::vector<SpeechSegment>& speechSegments,
    float maxDriftSec
) {
    return SubtitleAligner::alignWithAnchor(scriptLines, speechSegments, maxDriftSec);
}

static std::vector<AlignedPhrase> JS_AlignCuesWithAnchor(
    const std::vector<SubtitleCueNative>& cues,
    const std::vector<SpeechSegment>& speechSegments,
    float maxDriftSec
) {
    return SubtitleAligner::alignCuesWithAnchor(cues, speechSegments, maxDriftSec);
}

// ============================================================================
// Обертка для модуля StemSeparator
// ============================================================================

static bool JS_SeparateVocalsAndKaraoke(
    uintptr_t inL,
    uintptr_t inR,
    size_t numSamples,
    uintptr_t outVocL,
    uintptr_t outVocR,
    uintptr_t outKarL,
    uintptr_t outKarR,
    int sampleRate
) {
    const float* inLeft = reinterpret_cast<const float*>(inL);
    const float* inRight = reinterpret_cast<const float*>(inR);
    float* outVocalsL = reinterpret_cast<float*>(outVocL);
    float* outVocalsR = reinterpret_cast<float*>(outVocR);
    float* outKaraokeL = reinterpret_cast<float*>(outKarL);
    float* outKaraokeR = reinterpret_cast<float*>(outKarR);

    if (!inLeft || !inRight || !outVocalsL || !outVocalsR || !outKaraokeL || !outKaraokeR || numSamples == 0) {
        return false;
    }

    static StemSeparator s_separator(2048, 1024);
    s_separator.separateVocalsAndKaraoke(
        inLeft, inRight, numSamples,
        outVocalsL, outVocalsR,
        outKaraokeL, outKaraokeR,
        sampleRate
    );
    return true;
}

// ============================================================================
// Обертки для модуля MediaCore
// ============================================================================

static void JS_MonoToInterleavedStereo(uintptr_t monoInPtr, size_t numFrames, uintptr_t stereoOutPtr) {
    const float* monoIn = reinterpret_cast<const float*>(monoInPtr);
    float* stereoOut = reinterpret_cast<float*>(stereoOutPtr);
    AudioChannelLayout::monoToInterleavedStereo(monoIn, numFrames, stereoOut);
}

static void JS_DeinterleaveStereo(uintptr_t stereoInPtr, size_t numFrames, uintptr_t leftOutPtr, uintptr_t rightOutPtr) {
    const float* stereoIn = reinterpret_cast<const float*>(stereoInPtr);
    float* leftOut = reinterpret_cast<float*>(leftOutPtr);
    float* rightOut = reinterpret_cast<float*>(rightOutPtr);
    AudioChannelLayout::deinterleaveStereo(stereoIn, numFrames, leftOut, rightOut);
}

static void JS_InterleaveStereo(uintptr_t leftInPtr, uintptr_t rightInPtr, size_t numFrames, uintptr_t stereoOutPtr) {
    const float* leftIn = reinterpret_cast<const float*>(leftInPtr);
    const float* rightIn = reinterpret_cast<const float*>(rightInPtr);
    float* stereoOut = reinterpret_cast<float*>(stereoOutPtr);
    AudioChannelLayout::interleaveStereo(leftIn, rightIn, numFrames, stereoOut);
}

static void JS_ClampRange(uintptr_t bufferPtr, size_t numSamples, float minVal, float maxVal) {
    float* buffer = reinterpret_cast<float*>(bufferPtr);
    AudioChannelLayout::clampRange(buffer, numSamples, minVal, maxVal);
}

static float JS_FindPeak(uintptr_t bufferPtr, size_t numSamples) {
    const float* buffer = reinterpret_cast<const float*>(bufferPtr);
    return AudioChannelLayout::findPeak(buffer, numSamples);
}

static size_t JS_ResampleMono(
    uintptr_t inPtr,
    size_t inFrames,
    int inSampleRate,
    uintptr_t outPtr,
    size_t maxOutFrames,
    int outSampleRate
) {
    const float* in = reinterpret_cast<const float*>(inPtr);
    float* out = reinterpret_cast<float*>(outPtr);
    return AdvancedResampler::resampleMono(in, inFrames, inSampleRate, out, maxOutFrames, outSampleRate);
}

static size_t JS_ResampleInterleavedStereo(
    uintptr_t inPtr,
    size_t inFrames,
    int inSampleRate,
    uintptr_t outPtr,
    size_t maxOutFrames,
    int outSampleRate
) {
    const float* in = reinterpret_cast<const float*>(inPtr);
    float* out = reinterpret_cast<float*>(outPtr);
    return AdvancedResampler::resampleInterleavedStereo(in, inFrames, inSampleRate, out, maxOutFrames, outSampleRate);
}

static size_t JS_BuildWav(
    uintptr_t leftChanPtr,
    uintptr_t rightChanPtr,
    size_t numFrames,
    int sampleRate,
    int formatInt, // 0 = PCM16, 1 = PCM24, 2 = Float32
    uintptr_t outBufferPtr,
    size_t maxBufferSize
) {
    const float* left = reinterpret_cast<const float*>(leftChanPtr);
    const float* right = rightChanPtr ? reinterpret_cast<const float*>(rightChanPtr) : nullptr;
    uint8_t* outBuf = reinterpret_cast<uint8_t*>(outBufferPtr);

    NativeWavBuilder::FormatType fmt = NativeWavBuilder::FormatType::PCM_24BIT;
    if (formatInt == 0) fmt = NativeWavBuilder::FormatType::PCM_16BIT;
    else if (formatInt == 2) fmt = NativeWavBuilder::FormatType::FLOAT_32BIT;

    return NativeWavBuilder::buildWav(left, right, numFrames, sampleRate, fmt, outBuf, maxBufferSize);
}

static val JS_AnalyzeLoudness(
    uintptr_t leftChanPtr,
    uintptr_t rightChanPtr,
    size_t numFrames,
    float targetRmsDb,
    float ceilingPeakDb
) {
    const float* left = reinterpret_cast<const float*>(leftChanPtr);
    const float* right = rightChanPtr ? reinterpret_cast<const float*>(rightChanPtr) : nullptr;

    auto stats = AutoGainStager::analyzeLoudness(left, right, numFrames, targetRmsDb, ceilingPeakDb);

    val obj = val::object();
    obj.set("truePeakLinear", stats.truePeakLinear);
    obj.set("truePeakDb", stats.truePeakDb);
    obj.set("integratedRmsLinear", stats.integratedRmsLinear);
    obj.set("integratedRmsDb", stats.integratedRmsDb);
    obj.set("suggestedGainDb", stats.suggestedGainDb);
    return obj;
}

static void JS_ApplyGain(uintptr_t bufferPtr, size_t numSamples, float gainDb) {
    float* buffer = reinterpret_cast<float*>(bufferPtr);
    AutoGainStager::applyGain(buffer, numSamples, gainDb);
}

// ============================================================================
// Описание модулей Embind
// ============================================================================

EMSCRIPTEN_BINDINGS(daw_core_module) {
    enum_<BiquadFilterType>("BiquadFilterType")
        .value("LowShelf", BiquadFilterType::LowShelf)
        .value("Peaking", BiquadFilterType::Peaking)
        .value("HighShelf", BiquadFilterType::HighShelf)
        .value("HighPass", BiquadFilterType::HighPass)
        .value("LowPass", BiquadFilterType::LowPass)
        .value("BandPass", BiquadFilterType::BandPass);

    enum_<GateState>("GateState")
        .value("Closed", GateState::Closed)
        .value("Opening", GateState::Opening)
        .value("Open", GateState::Open)
        .value("Holding", GateState::Holding)
        .value("Closing", GateState::Closing);

    value_object<LoudnessStats>("LoudnessStats")
        .field("peakLinear", &LoudnessStats::peakLinear)
        .field("peakDb", &LoudnessStats::peakDb)
        .field("rmsLinear", &LoudnessStats::rmsLinear)
        .field("rmsDb", &LoudnessStats::rmsDb)
        .field("gainDeltaToTargetDb", &LoudnessStats::gainDeltaToTargetDb)
        .field("isClipping", &LoudnessStats::isClipping)
        .field("numSamples", &LoudnessStats::numSamples);

    class_<DeClicker>("DeClicker")
        .constructor<>()
        .property("threshold", &DeClicker::threshold)
        .property("repairWindow", &DeClicker::repairWindow)
        .property("enabled", &DeClicker::enabled)
        .property("clicksDetected", &DeClicker::clicksDetected)
        .function("reset", &DeClicker::reset);

    class_<DePlosive>("DePlosive")
        .constructor<>()
        .property("thresholdDb", &DePlosive::thresholdDb)
        .property("frequency", &DePlosive::frequency)
        .property("attackMs", &DePlosive::attackMs)
        .property("releaseMs", &DePlosive::releaseMs)
        .property("enabled", &DePlosive::enabled)
        .property("currentReduction", &DePlosive::currentReduction)
        .function("updateCoefficients", &DePlosive::updateCoefficients)
        .function("reset", &DePlosive::reset);

    class_<NoiseGate>("NoiseGate")
        .constructor<>()
        .property("thresholdDb", &NoiseGate::thresholdDb)
        .property("attackMs", &NoiseGate::attackMs)
        .property("holdMs", &NoiseGate::holdMs)
        .property("releaseMs", &NoiseGate::releaseMs)
        .property("floorDb", &NoiseGate::floorDb)
        .property("enabled", &NoiseGate::enabled)
        .property("currentGain", &NoiseGate::currentGain)
        .function("updateConstants", &NoiseGate::updateConstants)
        .function("reset", &NoiseGate::reset);

    class_<BiquadFilter>("BiquadFilter")
        .constructor<>()
        .property("type", &BiquadFilter::type)
        .property("frequency", &BiquadFilter::frequency)
        .property("gainDb", &BiquadFilter::gainDb)
        .property("Q", &BiquadFilter::Q)
        .property("enabled", &BiquadFilter::enabled)
        .function("updateCoefficients", &BiquadFilter::updateCoefficients)
        .function("resetState", &BiquadFilter::resetState);

    class_<ParametricEQ3Band>("ParametricEQ3Band")
        .constructor<>()
        .property("enabled", &ParametricEQ3Band::enabled)
        .property("lowShelf", &ParametricEQ3Band::lowShelf)
        .property("peaking", &ParametricEQ3Band::peaking)
        .property("highShelf", &ParametricEQ3Band::highShelf)
        .function("updateAll", &ParametricEQ3Band::updateAll)
        .function("reset", &ParametricEQ3Band::reset);

    class_<DeEsser>("DeEsser")
        .constructor<>()
        .property("thresholdDb", &DeEsser::thresholdDb)
        .property("frequency", &DeEsser::frequency)
        .property("ratio", &DeEsser::ratio)
        .property("attackMs", &DeEsser::attackMs)
        .property("releaseMs", &DeEsser::releaseMs)
        .property("enabled", &DeEsser::enabled)
        .property("currentGainReductionDb", &DeEsser::currentGainReductionDb)
        .function("updateCoefficients", &DeEsser::updateCoefficients)
        .function("reset", &DeEsser::reset);

    class_<SoftKneeCompressor>("SoftKneeCompressor")
        .constructor<>()
        .property("thresholdDb", &SoftKneeCompressor::thresholdDb)
        .property("ratio", &SoftKneeCompressor::ratio)
        .property("attackMs", &SoftKneeCompressor::attackMs)
        .property("releaseMs", &SoftKneeCompressor::releaseMs)
        .property("makeupGainDb", &SoftKneeCompressor::makeupGainDb)
        .property("kneeDb", &SoftKneeCompressor::kneeDb)
        .property("enabled", &SoftKneeCompressor::enabled)
        .property("currentGainReduction", &SoftKneeCompressor::currentGainReduction)
        .function("updateTimeConstants", &SoftKneeCompressor::updateTimeConstants)
        .function("reset", &SoftKneeCompressor::reset);

    class_<AutoDucker>("AutoDucker")
        .constructor<>()
        .property("thresholdDb", &AutoDucker::thresholdDb)
        .property("duckDepthDb", &AutoDucker::duckDepthDb)
        .property("attackMs", &AutoDucker::attackMs)
        .property("releaseMs", &AutoDucker::releaseMs)
        .property("enabled", &AutoDucker::enabled)
        .property("currentDuckingGain", &AutoDucker::currentDuckingGain)
        .function("updateConstants", &AutoDucker::updateConstants)
        .function("reset", &AutoDucker::reset);

    class_<SoftLimiter>("SoftLimiter")
        .constructor<>()
        .property("ceilingDb", &SoftLimiter::ceilingDb)
        .property("enabled", &SoftLimiter::enabled);

    value_object<Clip>("Clip")
        .field("id", &Clip::id)
        .field("bufferSizeSamples", &Clip::bufferSizeSamples)
        .field("offsetSamples", &Clip::offsetSamples)
        .field("lengthSamples", &Clip::lengthSamples)
        .field("gain", &Clip::gain)
        .field("pan", &Clip::pan)
        .field("fadeInSamples", &Clip::fadeInSamples)
        .field("fadeOutSamples", &Clip::fadeOutSamples)
        .field("isStereo", &Clip::isStereo)
        .field("active", &Clip::active);

    class_<Track>("Track")
        .constructor<uint32_t, std::string>()
        .property("id", &Track::id)
        .property("name", &Track::name)
        .property("volumeDb", &Track::volumeDb)
        .property("pan", &Track::pan)
        .property("solo", &Track::solo)
        .property("mute", &Track::mute)
        .property("deClicker", &Track::getDeClicker, allow_raw_pointers())
        .property("dePlosive", &Track::getDePlosive, allow_raw_pointers())
        .property("noiseGate", &Track::getNoiseGate, allow_raw_pointers())
        .property("eq", &Track::getEQ, allow_raw_pointers())
        .property("deEsser", &Track::getDeEsser, allow_raw_pointers())
        .property("compressor", &Track::getCompressor, allow_raw_pointers())
        .property("autoDucker", &Track::getAutoDucker, allow_raw_pointers())
        .function("clearClips", &Track::clearClips)
        .function("addEffect", &Track::addEffect)
        .function("removeEffect", &Track::removeEffect)
        .function("setEffectParam", &Track::setEffectParam)
        .function("getEffectParam", &Track::getEffectParam)
        .function("setEffectBypass", &Track::setEffectBypass)
        .function("isEffectBypassed", &Track::isEffectBypassed)
        .function("reorderEffects", &Track::reorderEffects)
        .function("getEffectCount", &Track::getEffectCount)
        .function("getEffectTypeId", &Track::getEffectTypeId)
        .function("getEffectName", &Track::getEffectName, allow_raw_pointers())
        .function("clearEffects", &Track::clearEffects)
        .function("loadVocalDefaultChain", &Track::loadVocalDefaultChain);

    class_<Mixer>("Mixer")
        .constructor<float>()
        .property("sampleRate", &Mixer::sampleRate)
        .property("masterVolumeDb", &Mixer::masterVolumeDb)
        .property("masterPan", &Mixer::masterPan)
        .property("currentTimelineSample", &Mixer::currentTimelineSample)
        .property("masterLimiter", &Mixer::masterLimiter)
        .function("setSampleRate", &Mixer::setSampleRate)
        .function("addTrack", &Mixer::addTrack, allow_raw_pointers())
        .function("getTrack", &Mixer::getTrack, allow_raw_pointers())
        .function("removeAllTracks", &Mixer::removeAllTracks)
        .function("addTrackEffect", &Mixer::addTrackEffect)
        .function("removeTrackEffect", &Mixer::removeTrackEffect)
        .function("setTrackEffectParam", &Mixer::setTrackEffectParam)
        .function("getTrackEffectParam", &Mixer::getTrackEffectParam)
        .function("setTrackEffectBypass", &Mixer::setTrackEffectBypass)
        .function("isTrackEffectBypassed", &Mixer::isTrackEffectBypassed)
        .function("reorderTrackEffects", &Mixer::reorderTrackEffects)
        .function("setTimelinePosition", &Mixer::setTimelinePosition)
        .function("processBlock", &Mixer::processBlock, allow_raw_pointers())
        .function("renderProjectOffline", &Mixer::renderProjectOffline, allow_raw_pointers())
        .function("autoMatchAllTracks", &Mixer::autoMatchAllTracks);

    function("allocateAudioBuffer", &JS_AllocateAudioBuffer);
    function("freeAudioBuffer", &JS_FreeAudioBuffer);
    function("allocateByteBuffer", &JS_AllocateByteBuffer);
    function("freeByteBuffer", &JS_FreeByteBuffer);
    function("addClipToTrack", &JS_AddClipToTrack);
    function("processMixer", &JS_ProcessMixer);
    function("renderProjectOffline", &JS_RenderProjectOffline);
    function("calculateLoudnessStats", &JS_CalculateLoudnessStats);
    function("resampleTo48k", &JS_ResampleTo48k);
    function("packWav", &JS_PackWav);

    // Прямой вызов WSOLA и операций нарезки клипов (Split/Trim)
    function("splitClip", &JS_SplitClip);
    function("splitClipNative", &JS_SplitClipNative);
    function("splitClipInTrack", &JS_SplitClipInTrack);
    function("applyTimeStretchToClip", &JS_ApplyTimeStretchToClip);
    function("processWSOLA", &JS_ProcessWSOLA);
    function("calculateWSOLAOutputFrames", &JS_CalculateWSOLAOutputFrames);
    function("trimClipStart", &JS_TrimClipStart);
    function("trimClipEnd", &JS_TrimClipEnd);
    function("setActiveMixerForEditor", &JS_SetActiveMixer);

    // ========================================================================
    // Модуль SilenceStripper (SIMD128 VAD & Silence Stripping)
    // ========================================================================
    value_object<AudioSegment>("AudioSegment")
        .field("offsetSamples", &AudioSegment::offsetSamples)
        .field("lengthSamples", &AudioSegment::lengthSamples)
        .field("peakLevel", &AudioSegment::peakLevel)
        .field("rmsLevel", &AudioSegment::rmsLevel);

    register_vector<AudioSegment>("VectorAudioSegment");

    function("stripSilenceNative", &JS_StripSilenceNative);
    function("stripSilenceFromClip", &JS_StripSilenceFromClip);
    function("allocateSegmentBuffer", &JS_AllocateSegmentBuffer);
    function("freeSegmentBuffer", &JS_FreeSegmentBuffer);

    // ========================================================================
    // Модуль Speech Aligner & VAD
    // ========================================================================
    value_object<FrameEnergyStats>("FrameEnergyStats")
        .field("rms", &FrameEnergyStats::rms)
        .field("zcrRatio", &FrameEnergyStats::zcrRatio)
        .field("voiceProbability", &FrameEnergyStats::voiceProbability)
        .field("peak", &FrameEnergyStats::peak);

    value_object<VADConfig>("VADConfig")
        .field("sampleRate", &VADConfig::sampleRate)
        .field("threshold", &VADConfig::threshold)
        .field("minSpeechDurationMs", &VADConfig::minSpeechDurationMs)
        .field("minSilenceDurationMs", &VADConfig::minSilenceDurationMs)
        .field("speechPadMs", &VADConfig::speechPadMs);

    value_object<SpeechSegment>("SpeechSegment")
        .field("id", &SpeechSegment::id)
        .field("startSample", &SpeechSegment::startSample)
        .field("endSample", &SpeechSegment::endSample)
        .field("startSec", &SpeechSegment::startSec)
        .field("endSec", &SpeechSegment::endSec)
        .field("durationSec", &SpeechSegment::durationSec)
        .field("confidence", &SpeechSegment::confidence);

    value_object<ScriptLine>("ScriptLine")
        .field("index", &ScriptLine::index)
        .field("startSec", &ScriptLine::startSec)
        .field("endSec", &ScriptLine::endSec)
        .field("text", &ScriptLine::text)
        .field("speaker", &ScriptLine::speaker);

    value_object<TranscriptionSegment>("TranscriptionSegment")
        .field("id", &TranscriptionSegment::id)
        .field("startSec", &TranscriptionSegment::startSec)
        .field("endSec", &TranscriptionSegment::endSec)
        .field("text", &TranscriptionSegment::text)
        .field("confidence", &TranscriptionSegment::confidence);

    value_object<AlignedPhrase>("AlignedPhrase")
        .field("lineIndex", &AlignedPhrase::lineIndex)
        .field("scriptText", &AlignedPhrase::scriptText)
        .field("recognizedText", &AlignedPhrase::recognizedText)
        .field("expectedStartSec", &AlignedPhrase::expectedStartSec)
        .field("expectedEndSec", &AlignedPhrase::expectedEndSec)
        .field("actualStartSec", &AlignedPhrase::actualStartSec)
        .field("actualEndSec", &AlignedPhrase::actualEndSec)
        .field("timeDriftSec", &AlignedPhrase::timeDriftSec)
        .field("similarityScore", &AlignedPhrase::similarityScore)
        .field("status", &AlignedPhrase::status);

    value_object<SubtitleCueNative>("SubtitleCueNative")
        .field("index", &SubtitleCueNative::index)
        .field("startSec", &SubtitleCueNative::startSec)
        .field("endSec", &SubtitleCueNative::endSec)
        .field("speaker", &SubtitleCueNative::speaker)
        .field("text", &SubtitleCueNative::text);

    register_vector<SpeechSegment>("VectorSpeechSegment");
    register_vector<ScriptLine>("VectorScriptLine");
    register_vector<TranscriptionSegment>("VectorTranscriptionSegment");
    register_vector<AlignedPhrase>("VectorAlignedPhrase");
    register_vector<SubtitleCueNative>("VectorSubtitleCueNative");

    function("fastLevenshteinDistance", &JS_FastLevenshteinDistance);
    function("fastStringSimilarity", &JS_FastStringSimilarity);
    function("calculateLevenshteinSimilarity", &JS_FastStringSimilarity);
    function("calculateFrameEnergyStats", &JS_CalculateFrameEnergyStats);
    function("calculateFrameEnergy", &JS_CalculateFrameEnergyStats);
    function("detectSpeechSegments", &JS_DetectSpeechSegments);
    function("alignSpeechWithScript", &JS_AlignSpeechWithScript);
    function("parseSubtitleContent", &JS_ParseSubtitleContent);
    function("parseSrtAss", &JS_ParseSubtitleContent);
    function("alignWithAnchor", &JS_AlignWithAnchor);
    function("alignCuesWithAnchor", &JS_AlignCuesWithAnchor);
    function("separateVocalsAndKaraoke", &JS_SeparateVocalsAndKaraoke);

    // MediaCore bindings
    function("monoToInterleavedStereo", &JS_MonoToInterleavedStereo);
    function("deinterleaveStereo", &JS_DeinterleaveStereo);
    function("interleaveStereo", &JS_InterleaveStereo);
    function("clampRange", &JS_ClampRange);
    function("findPeak", &JS_FindPeak);
    function("resampleMono", &JS_ResampleMono);
    function("resampleInterleavedStereo", &JS_ResampleInterleavedStereo);
    function("buildWav", &JS_BuildWav);
    function("analyzeLoudness", &JS_AnalyzeLoudness);
    function("applyGain", &JS_ApplyGain);

    // WaveformAnalyzer bindings (Zero GC / SIMD128 Decimation)
    function("extractWaveformPeaks", optional_override([](
        uintptr_t bufferPtr,
        size_t bufferLength,
        int targetPixels,
        size_t startFrame,
        size_t lengthFrames,
        bool isStereo,
        uintptr_t outMinPtr,
        uintptr_t outMaxPtr
    ) {
        const float* inBuf = reinterpret_cast<const float*>(bufferPtr);
        float* outMin = reinterpret_cast<float*>(outMinPtr);
        float* outMax = reinterpret_cast<float*>(outMaxPtr);
        return WaveformAnalyzer::extractPeaksNative(
            inBuf, bufferLength, targetPixels, startFrame, lengthFrames, isStereo, outMin, outMax
        );
    }));

    function("extractWaveformRMS", optional_override([](
        uintptr_t bufferPtr,
        size_t bufferLength,
        int targetPixels,
        size_t startFrame,
        size_t lengthFrames,
        bool isStereo,
        uintptr_t outRmsPtr
    ) {
        const float* inBuf = reinterpret_cast<const float*>(bufferPtr);
        float* outRms = reinterpret_cast<float*>(outRmsPtr);
        return WaveformAnalyzer::extractRMSPeaksNative(
            inBuf, bufferLength, targetPixels, startFrame, lengthFrames, isStereo, outRms
        );
    }));

    function("calculateWaveformStats", optional_override([](
        uintptr_t bufferPtr,
        size_t totalFrames,
        bool isStereo
    ) {
        const float* inBuf = reinterpret_cast<const float*>(bufferPtr);
        WaveformStats stats = WaveformAnalyzer::calculateGlobalStats(inBuf, totalFrames, isStereo);
        val obj = val::object();
        obj.set("globalMin", stats.globalMin);
        obj.set("globalMax", stats.globalMax);
        obj.set("maxAbsolutePeak", stats.maxAbsolutePeak);
        obj.set("rmsLevel", stats.rmsLevel);
        obj.set("processedFrames", static_cast<double>(stats.processedFrames));
        return obj;
    }));

    // VSTDiskScanner bindings
    value_object<VSTSubPluginMetadata>("VSTSubPluginMetadata")
        .field("name", &VSTSubPluginMetadata::name)
        .field("classUid", &VSTSubPluginMetadata::classUid)
        .field("category", &VSTSubPluginMetadata::category)
        .field("isStereo", &VSTSubPluginMetadata::isStereo);

    value_object<VSTPluginMetadata>("VSTPluginMetadata")
        .field("id", &VSTPluginMetadata::id)
        .field("name", &VSTPluginMetadata::name)
        .field("category", &VSTPluginMetadata::category)
        .field("vendor", &VSTPluginMetadata::vendor)
        .field("format", &VSTPluginMetadata::format)
        .field("path", &VSTPluginMetadata::path)
        .field("binaryPath", &VSTPluginMetadata::binaryPath)
        .field("classUid", &VSTPluginMetadata::classUid)
        .field("latencySamples", &VSTPluginMetadata::latencySamples)
        .field("isInstrument", &VSTPluginMetadata::isInstrument)
        .field("isFx", &VSTPluginMetadata::isFx)
        .field("isStereo", &VSTPluginMetadata::isStereo)
        .field("audioInputs", &VSTPluginMetadata::audioInputs)
        .field("audioOutputs", &VSTPluginMetadata::audioOutputs)
        .field("hasEditor", &VSTPluginMetadata::hasEditor)
        .field("is64Bit", &VSTPluginMetadata::is64Bit)
        .field("sdkVersion", &VSTPluginMetadata::sdkVersion)
        .field("version", &VSTPluginMetadata::version)
        .field("fileSize", &VSTPluginMetadata::fileSize)
        .field("lastModified", &VSTPluginMetadata::lastModified)
        .field("isBundle", &VSTPluginMetadata::isBundle)
        .field("isWaveshell", &VSTPluginMetadata::isWaveshell)
        .field("isIzotope", &VSTPluginMetadata::isIzotope)
        .field("isValid", &VSTPluginMetadata::isValid)
        .field("errorMessage", &VSTPluginMetadata::errorMessage);

    register_vector<VSTSubPluginMetadata>("VectorVSTSubPluginMetadata");
    register_vector<VSTPluginMetadata>("VectorVSTPluginMetadata");
    register_vector<std::string>("VectorString");

    function("getStandardVstDirectoriesNative", optional_override([]() {
        return VSTDiskScanner::getStandardSystemPaths();
    }));

    function("scanVstPluginsNative", optional_override([](const std::vector<std::string>& customPaths) {
        VSTDiskScanner scanner;
        VSTScanResult result = scanner.scanSystemDirectories(customPaths);
        return result.plugins;
    }));

    // ProjectIndexer bindings
    value_object<IndexedFileEntry>("IndexedFileEntry")
        .field("relativePath", &IndexedFileEntry::relativePath)
        .field("absolutePath", &IndexedFileEntry::absolutePath)
        .field("fileName", &IndexedFileEntry::fileName)
        .field("extension", &IndexedFileEntry::extension)
        .field("parentDir", &IndexedFileEntry::parentDir)
        .field("typeString", &IndexedFileEntry::typeString)
        .field("mimeType", &IndexedFileEntry::mimeType)
        .field("sizeBytes", &IndexedFileEntry::sizeBytes)
        .field("lastModifiedMs", &IndexedFileEntry::lastModifiedMs)
        .field("isDirectory", &IndexedFileEntry::isDirectory)
        .field("isSymlink", &IndexedFileEntry::isSymlink);

    register_vector<IndexedFileEntry>("VectorIndexedFileEntry");

    value_object<ProjectDirectoryStats>("ProjectDirectoryStats")
        .field("totalFiles", &ProjectDirectoryStats::totalFiles)
        .field("totalDirectories", &ProjectDirectoryStats::totalDirectories)
        .field("totalSizeBytes", &ProjectDirectoryStats::totalSizeBytes)
        .field("videoCount", &ProjectDirectoryStats::videoCount)
        .field("audioCount", &ProjectDirectoryStats::audioCount)
        .field("subtitleCount", &ProjectDirectoryStats::subtitleCount)
        .field("presetCount", &ProjectDirectoryStats::presetCount)
        .field("configCount", &ProjectDirectoryStats::configCount)
        .field("scriptCount", &ProjectDirectoryStats::scriptCount)
        .field("otherCount", &ProjectDirectoryStats::otherCount)
        .field("scanDurationMs", &ProjectDirectoryStats::scanDurationMs);

    value_object<ProjectValidationResult>("ProjectValidationResult")
        .field("isValid", &ProjectValidationResult::isValid)
        .field("hasProjectConfig", &ProjectValidationResult::hasProjectConfig)
        .field("configFilePath", &ProjectValidationResult::configFilePath)
        .field("projectId", &ProjectValidationResult::projectId)
        .field("projectName", &ProjectValidationResult::projectName)
        .field("sampleRate", &ProjectValidationResult::sampleRate)
        .field("createdAt", &ProjectValidationResult::createdAt)
        .field("updatedAt", &ProjectValidationResult::updatedAt)
        .field("videoFileName", &ProjectValidationResult::videoFileName)
        .field("videoRelativePath", &ProjectValidationResult::videoRelativePath)
        .field("videoDurationSec", &ProjectValidationResult::videoDurationSec)
        .field("videoFps", &ProjectValidationResult::videoFps)
        .field("trackCount", &ProjectValidationResult::trackCount)
        .field("cueCount", &ProjectValidationResult::cueCount)
        .field("trackFileNames", &ProjectValidationResult::trackFileNames)
        .field("missingReferencedFiles", &ProjectValidationResult::missingReferencedFiles)
        .field("warnings", &ProjectValidationResult::warnings)
        .field("errors", &ProjectValidationResult::errors)
        .field("canonicalJson", &ProjectValidationResult::canonicalJson);

    value_object<ProjectIndexResult>("ProjectIndexResult")
        .field("rootPath", &ProjectIndexResult::rootPath)
        .field("directoryName", &ProjectIndexResult::directoryName)
        .field("success", &ProjectIndexResult::success)
        .field("errorMessage", &ProjectIndexResult::errorMessage)
        .field("files", &ProjectIndexResult::files)
        .field("stats", &ProjectIndexResult::stats)
        .field("videoFiles", &ProjectIndexResult::videoFiles)
        .field("audioFiles", &ProjectIndexResult::audioFiles)
        .field("subtitleFiles", &ProjectIndexResult::subtitleFiles)
        .field("presetFiles", &ProjectIndexResult::presetFiles)
        .field("configFiles", &ProjectIndexResult::configFiles)
        .field("validation", &ProjectIndexResult::validation);

    function("indexVirtualFilesNative", optional_override([](
        const std::vector<IndexedFileEntry>& rawFiles,
        const std::string& rawProjectJson
    ) {
        return ProjectIndexer::indexVirtualFiles(rawFiles, rawProjectJson);
    }));

    function("validateProjectJsonNative", optional_override([](
        const std::string& rawProjectJson,
        const std::vector<IndexedFileEntry>& indexedFiles
    ) {
        return ProjectIndexer::validateAndParseProjectJson(rawProjectJson, indexedFiles);
    }));

    function("generateDefaultProjectJsonNative", optional_override([](
        const std::string& projectName,
        const std::vector<IndexedFileEntry>& files,
        double sampleRate
    ) {
        return ProjectIndexer::generateDefaultProjectJson(projectName, files, sampleRate);
    }));

    function("detectFileTypeNative", optional_override([](const std::string& fileName) {
        MediaFileType type = ProjectIndexer::detectFileType(fileName);
        return ProjectIndexer::fileTypeToString(type);
    }));

    function("detectMimeTypeNative", optional_override([](const std::string& fileName) {
        MediaFileType type = ProjectIndexer::detectFileType(fileName);
        return ProjectIndexer::detectMimeType(fileName, type);
    }));

    // PhraseLoudnessNormalizer bindings
    value_object<PhraseNormalizerConfig>("PhraseNormalizerConfig")
        .field("targetLufs", &PhraseNormalizerConfig::targetLufs)
        .field("maxGainDb", &PhraseNormalizerConfig::maxGainDb)
        .field("minGainDb", &PhraseNormalizerConfig::minGainDb)
        .field("minSilenceDurationMs", &PhraseNormalizerConfig::minSilenceDurationMs)
        .field("thresholdDb", &PhraseNormalizerConfig::thresholdDb)
        .field("fadeTimeMs", &PhraseNormalizerConfig::fadeTimeMs)
        .field("prePaddingMs", &PhraseNormalizerConfig::prePaddingMs)
        .field("postPaddingMs", &PhraseNormalizerConfig::postPaddingMs)
        .field("maxPeakDb", &PhraseNormalizerConfig::maxPeakDb);

    value_object<PhraseInfo>("PhraseInfo")
        .field("startFrame", &PhraseInfo::startFrame)
        .field("endFrame", &PhraseInfo::endFrame)
        .field("durationSec", &PhraseInfo::durationSec)
        .field("measuredLufs", &PhraseInfo::measuredLufs)
        .field("targetLufs", &PhraseInfo::targetLufs)
        .field("appliedGainDb", &PhraseInfo::appliedGainDb)
        .field("peakBeforeDb", &PhraseInfo::peakBeforeDb)
        .field("peakAfterDb", &PhraseInfo::peakAfterDb);

    register_vector<PhraseInfo>("VectorPhraseInfo");

    value_object<PhraseNormalizerResult>("PhraseNormalizerResult")
        .field("totalPhrases", &PhraseNormalizerResult::totalPhrases)
        .field("averageInputLufs", &PhraseNormalizerResult::averageInputLufs)
        .field("averageOutputLufs", &PhraseNormalizerResult::averageOutputLufs)
        .field("maxBoostDb", &PhraseNormalizerResult::maxBoostDb)
        .field("maxAttenuationDb", &PhraseNormalizerResult::maxAttenuationDb)
        .field("phrases", &PhraseNormalizerResult::phrases);

    function("normalizeTrackPhrasesNative", optional_override([](
        uintptr_t bufferPtr,
        size_t totalFrames,
        int channels,
        float sampleRate,
        const PhraseNormalizerConfig& config
    ) {
        return PhraseLoudnessNormalizer::processTrackPhrasesNative(
            bufferPtr, totalFrames, channels, sampleRate, config
        );
    }));

    // StudioCompressor bindings
    enum_<CompressorDetectionMode>("CompressorDetectionMode")
        .value("Peak", CompressorDetectionMode::Peak)
        .value("RMS", CompressorDetectionMode::RMS);

    value_object<CompressorParams>("CompressorParams")
        .field("thresholdDb", &CompressorParams::thresholdDb)
        .field("ratio", &CompressorParams::ratio)
        .field("attackMs", &CompressorParams::attackMs)
        .field("releaseMs", &CompressorParams::releaseMs)
        .field("kneeDb", &CompressorParams::kneeDb)
        .field("makeupGainDb", &CompressorParams::makeupGainDb)
        .field("stereoLink", &CompressorParams::stereoLink)
        .field("dryWet", &CompressorParams::dryWet)
        .field("enabled", &CompressorParams::enabled);

    class_<StudioCompressor>("StudioCompressor")
        .constructor<float>()
        .function("setSampleRate", &StudioCompressor::setSampleRate)
        .function("setParams", &StudioCompressor::setParams)
        .function("getParams", &StudioCompressor::getParams)
        .function("reset", &StudioCompressor::reset)
        .function("getGainReductionDb", &StudioCompressor::getGainReductionDb)
        .function("getPeakGainReductionDb", &StudioCompressor::getPeakGainReductionDb)
        .function("resetMetering", &StudioCompressor::resetMetering)
        .function("processBlockNative", optional_override([](
            StudioCompressor& comp,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            comp.processBlock(buf, numFrames, channels);
        }));

    // ParametricEQPro bindings
    enum_<EQFilterType>("EQFilterType")
        .value("LowShelf", EQFilterType::LowShelf)
        .value("Peaking", EQFilterType::Peaking)
        .value("HighShelf", EQFilterType::HighShelf)
        .value("HighPass", EQFilterType::HighPass)
        .value("LowPass", EQFilterType::LowPass)
        .value("Notch", EQFilterType::Notch);

    value_object<EQBandParams>("EQBandParams")
        .field("type", &EQBandParams::type)
        .field("frequency", &EQBandParams::frequency)
        .field("gainDb", &EQBandParams::gainDb)
        .field("Q", &EQBandParams::Q)
        .field("enabled", &EQBandParams::enabled);

    class_<ParametricEQPro>("ParametricEQPro")
        .constructor<double>()
        .function("setSampleRate", &ParametricEQPro::setSampleRate)
        .function("getSampleRate", &ParametricEQPro::getSampleRate)
        .function("setBandParams", &ParametricEQPro::setBandParams)
        .function("getBandParams", &ParametricEQPro::getBandParams)
        .function("setOutputGainDb", &ParametricEQPro::setOutputGainDb)
        .function("getOutputGainDb", &ParametricEQPro::getOutputGainDb)
        .function("setEnabled", &ParametricEQPro::setEnabled)
        .function("isEnabled", &ParametricEQPro::isEnabled)
        .function("updateCoefficients", &ParametricEQPro::updateCoefficients)
        .function("reset", &ParametricEQPro::reset)
        .function("processBlockNative", optional_override([](
            ParametricEQPro& eq,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            eq.processBlock(buf, numFrames, channels);
        }));

    // StudioReverb bindings
    value_object<ReverbParams>("ReverbParams")
        .field("roomSize", &ReverbParams::roomSize)
        .field("damping", &ReverbParams::damping)
        .field("wetDryMix", &ReverbParams::wetDryMix)
        .field("preDelayMs", &ReverbParams::preDelayMs)
        .field("stereoWidth", &ReverbParams::stereoWidth)
        .field("lowCutHz", &ReverbParams::lowCutHz)
        .field("enabled", &ReverbParams::enabled);

    class_<StudioReverb>("StudioReverb")
        .constructor<float>()
        .function("setSampleRate", &StudioReverb::setSampleRate)
        .function("setParams", &StudioReverb::setParams)
        .function("getParams", &StudioReverb::getParams)
        .function("reset", &StudioReverb::reset)
        .function("processBlockNative", optional_override([](
            StudioReverb& rev,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            rev.processBlock(buf, numFrames, channels);
        }));

    // FFTSpectralFilter bindings
    register_vector<float>("VectorFloat");

    class_<FFTSpectralFilter>("FFTSpectralFilter")
        .constructor<size_t, float>()
        .function("init", &FFTSpectralFilter::init)
        .function("reset", &FFTSpectralFilter::reset)
        .function("setFrequencyMask", &FFTSpectralFilter::setFrequencyMask)
        .function("setBandGain", &FFTSpectralFilter::setBandGain)
        .function("resetFrequencyMask", &FFTSpectralFilter::resetFrequencyMask)
        .function("getFftSize", &FFTSpectralFilter::getFftSize)
        .function("getHopSize", &FFTSpectralFilter::getHopSize)
        .function("getLatencyFrames", &FFTSpectralFilter::getLatencyFrames)
        .function("processBlockNative", optional_override([](
            FFTSpectralFilter& filter,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            filter.processBlock(buf, numFrames, channels);
        }));

    // TransientShaper bindings
    value_object<TransientShaperParams>("TransientShaperParams")
        .field("attackGainDb", &TransientShaperParams::attackGainDb)
        .field("sustainGainDb", &TransientShaperParams::sustainGainDb)
        .field("fastWindowMs", &TransientShaperParams::fastWindowMs)
        .field("slowWindowMs", &TransientShaperParams::slowWindowMs)
        .field("outputGainDb", &TransientShaperParams::outputGainDb)
        .field("softClip", &TransientShaperParams::softClip)
        .field("enabled", &TransientShaperParams::enabled);

    class_<TransientShaper>("TransientShaper")
        .constructor<float>()
        .function("setSampleRate", &TransientShaper::setSampleRate)
        .function("setParams", &TransientShaper::setParams)
        .function("getParams", &TransientShaper::getParams)
        .function("reset", &TransientShaper::reset)
        .function("getCurrentTransientLevel", &TransientShaper::getCurrentTransientLevel)
        .function("getCurrentSustainLevel", &TransientShaper::getCurrentSustainLevel)
        .function("processBlockNative", optional_override([](
            TransientShaper& shaper,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            shaper.processBlock(buf, numFrames, channels);
        }));

    // GraphicEQ31 bindings
    class_<GraphicEQ31>("GraphicEQ31")
        .constructor<double>()
        .function("setSampleRate", &GraphicEQ31::setSampleRate)
        .function("getSampleRate", &GraphicEQ31::getSampleRate)
        .function("setBandGain", &GraphicEQ31::setBandGain)
        .function("getBandGain", &GraphicEQ31::getBandGain)
        .function("getBandFrequency", &GraphicEQ31::getBandFrequency)
        .function("resetAllBands", &GraphicEQ31::resetAllBands)
        .function("setMasterGainDb", &GraphicEQ31::setMasterGainDb)
        .function("getMasterGainDb", &GraphicEQ31::getMasterGainDb)
        .function("setEnabled", &GraphicEQ31::setEnabled)
        .function("isEnabled", &GraphicEQ31::isEnabled)
        .function("reset", &GraphicEQ31::reset)
        .function("processBlockNative", optional_override([](
            GraphicEQ31& eq,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            eq.processBlock(buf, numFrames, channels);
        }));

    // DynamicEQ bindings
    value_object<DynamicEQBand>("DynamicEQBand")
        .field("frequency", &DynamicEQBand::frequency)
        .field("Q", &DynamicEQBand::Q)
        .field("baseGainDb", &DynamicEQBand::baseGainDb)
        .field("thresholdDb", &DynamicEQBand::thresholdDb)
        .field("ratio", &DynamicEQBand::ratio)
        .field("attackMs", &DynamicEQBand::attackMs)
        .field("releaseMs", &DynamicEQBand::releaseMs)
        .field("maxDynamicGainDb", &DynamicEQBand::maxDynamicGainDb)
        .field("isDownward", &DynamicEQBand::isDownward)
        .field("enabled", &DynamicEQBand::enabled);

    class_<DynamicEQ>("DynamicEQ")
        .constructor<double>()
        .function("setSampleRate", &DynamicEQ::setSampleRate)
        .function("getSampleRate", &DynamicEQ::getSampleRate)
        .function("setBandParams", &DynamicEQ::setBandParams)
        .function("getBandParams", &DynamicEQ::getBandParams)
        .function("getDynamicGainReductionDb", &DynamicEQ::getDynamicGainReductionDb)
        .function("setOutputGainDb", &DynamicEQ::setOutputGainDb)
        .function("getOutputGainDb", &DynamicEQ::getOutputGainDb)
        .function("setEnabled", &DynamicEQ::setEnabled)
        .function("isEnabled", &DynamicEQ::isEnabled)
        .function("reset", &DynamicEQ::reset)
        .function("processBlockNative", optional_override([](
            DynamicEQ& eq,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            eq.processBlock(buf, numFrames, channels);
        }));

    // LinearPhaseFilter bindings
    enum_<FIRWindowType>("FIRWindowType")
        .value("Hann", FIRWindowType::Hann)
        .value("Hamming", FIRWindowType::Hamming)
        .value("Blackman", FIRWindowType::Blackman)
        .value("BlackmanHarris", FIRWindowType::BlackmanHarris)
        .value("Rectangular", FIRWindowType::Rectangular);

    value_object<LinearPhaseParams>("LinearPhaseParams")
        .field("hpFreq", &LinearPhaseParams::hpFreq)
        .field("lpFreq", &LinearPhaseParams::lpFreq)
        .field("filterOrder", &LinearPhaseParams::filterOrder)
        .field("windowType", &LinearPhaseParams::windowType)
        .field("enabled", &LinearPhaseParams::enabled);

    class_<LinearPhaseFilter>("LinearPhaseFilter")
        .constructor<float>()
        .function("setSampleRate", &LinearPhaseFilter::setSampleRate)
        .function("getSampleRate", &LinearPhaseFilter::getSampleRate)
        .function("setParams", &LinearPhaseFilter::setParams)
        .function("getParams", &LinearPhaseFilter::getParams)
        .function("getGroupDelaySamples", &LinearPhaseFilter::getGroupDelaySamples)
        .function("reset", &LinearPhaseFilter::reset)
        .function("processBlockNative", optional_override([](
            LinearPhaseFilter& filter,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            filter.processBlock(buf, numFrames, channels);
        }));

    // ResonanceSuppressor bindings
    value_object<ResonanceSuppressorParams>("ResonanceSuppressorParams")
        .field("sensitivity", &ResonanceSuppressorParams::sensitivity)
        .field("maxAttenuationDb", &ResonanceSuppressorParams::maxAttenuationDb)
        .field("maxNotches", &ResonanceSuppressorParams::maxNotches)
        .field("minFreq", &ResonanceSuppressorParams::minFreq)
        .field("maxFreq", &ResonanceSuppressorParams::maxFreq)
        .field("sharpness", &ResonanceSuppressorParams::sharpness)
        .field("attackMs", &ResonanceSuppressorParams::attackMs)
        .field("releaseMs", &ResonanceSuppressorParams::releaseMs)
        .field("enabled", &ResonanceSuppressorParams::enabled);

    class_<ResonanceSuppressor>("ResonanceSuppressor")
        .constructor<float>()
        .function("setSampleRate", &ResonanceSuppressor::setSampleRate)
        .function("getSampleRate", &ResonanceSuppressor::getSampleRate)
        .function("setParams", &ResonanceSuppressor::setParams)
        .function("getParams", &ResonanceSuppressor::getParams)
        .function("reset", &ResonanceSuppressor::reset)
        .function("getActiveNotchCount", &ResonanceSuppressor::getActiveNotchCount)
        .function("getNotchFrequency", &ResonanceSuppressor::getNotchFrequency)
        .function("getNotchAttenuationDb", &ResonanceSuppressor::getNotchAttenuationDb)
        .function("processBlockNative", optional_override([](
            ResonanceSuppressor& suppressor,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            suppressor.processBlock(buf, numFrames, channels);
        }));

    // TapeSaturation bindings
    value_object<TapeParams>("TapeParams")
        .field("driveDb", &TapeParams::driveDb)
        .field("bias", &TapeParams::bias)
        .field("saturationMix", &TapeParams::saturationMix)
        .field("lowFreqColor", &TapeParams::lowFreqColor)
        .field("highFreqRolloff", &TapeParams::highFreqRolloff)
        .field("outputGainDb", &TapeParams::outputGainDb)
        .field("autoGain", &TapeParams::autoGain)
        .field("enabled", &TapeParams::enabled);

    class_<TapeSaturation>("TapeSaturation")
        .constructor<float>()
        .function("setSampleRate", &TapeSaturation::setSampleRate)
        .function("getSampleRate", &TapeSaturation::getSampleRate)
        .function("setParams", &TapeSaturation::setParams)
        .function("getParams", &TapeSaturation::getParams)
        .function("reset", &TapeSaturation::reset)
        .function("processBlockNative", optional_override([](
            TapeSaturation& tape,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            tape.processBlock(buf, numFrames, channels);
        }));

    // SmartBreathController bindings
    value_object<BreathControllerParams>("BreathControllerParams")
        .field("targetReductionDb", &BreathControllerParams::targetReductionDb)
        .field("sensitivity", &BreathControllerParams::sensitivity)
        .field("lookaheadMs", &BreathControllerParams::lookaheadMs)
        .field("attackMs", &BreathControllerParams::attackMs)
        .field("releaseMs", &BreathControllerParams::releaseMs)
        .field("minLevelDb", &BreathControllerParams::minLevelDb)
        .field("maxLevelDb", &BreathControllerParams::maxLevelDb)
        .field("enabled", &BreathControllerParams::enabled);

    class_<SmartBreathController>("SmartBreathController")
        .constructor<float>()
        .function("setSampleRate", &SmartBreathController::setSampleRate)
        .function("getSampleRate", &SmartBreathController::getSampleRate)
        .function("setParams", &SmartBreathController::setParams)
        .function("getParams", &SmartBreathController::getParams)
        .function("getLatencySamples", &SmartBreathController::getLatencySamples)
        .function("reset", &SmartBreathController::reset)
        .function("isBreathActive", &SmartBreathController::isBreathActive)
        .function("getCurrentAttenuationDb", &SmartBreathController::getCurrentAttenuationDb)
        .function("processBlockNative", optional_override([](
            SmartBreathController& controller,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            controller.processBlock(buf, numFrames, channels);
        }));

    // MouthDeClicker bindings
    value_object<MouthDeClickerParams>("MouthDeClickerParams")
        .field("sensitivity", &MouthDeClickerParams::sensitivity)
        .field("maxClickDurationSamples", &MouthDeClickerParams::maxClickDurationSamples)
        .field("highPassCutoff", &MouthDeClickerParams::highPassCutoff)
        .field("wideningMargin", &MouthDeClickerParams::wideningMargin)
        .field("enabled", &MouthDeClickerParams::enabled);

    class_<MouthDeClicker>("MouthDeClicker")
        .constructor<float>()
        .function("setSampleRate", &MouthDeClicker::setSampleRate)
        .function("getSampleRate", &MouthDeClicker::getSampleRate)
        .function("setParams", &MouthDeClicker::setParams)
        .function("getParams", &MouthDeClicker::getParams)
        .function("getLatencySamples", &MouthDeClicker::getLatencySamples)
        .function("reset", &MouthDeClicker::reset)
        .function("getTotalClicksRepaired", &MouthDeClicker::getTotalClicksRepaired)
        .function("processBlockNative", optional_override([](
            MouthDeClicker& declicker,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            declicker.processBlock(buf, numFrames, channels);
        }));

    // ProximityControl bindings
    value_object<ProximityParams>("ProximityParams")
        .field("cutoffFrequency", &ProximityParams::cutoffFrequency)
        .field("thresholdDb", &ProximityParams::thresholdDb)
        .field("maxReductionDb", &ProximityParams::maxReductionDb)
        .field("responseMs", &ProximityParams::responseMs)
        .field("releaseMs", &ProximityParams::releaseMs)
        .field("sensitivity", &ProximityParams::sensitivity)
        .field("enabled", &ProximityParams::enabled);

    class_<ProximityControl>("ProximityControl")
        .constructor<float>()
        .function("setSampleRate", &ProximityControl::setSampleRate)
        .function("getSampleRate", &ProximityControl::getSampleRate)
        .function("setParams", &ProximityControl::setParams)
        .function("getParams", &ProximityControl::getParams)
        .function("reset", &ProximityControl::reset)
        .function("getCurrentAttenuationDb", &ProximityControl::getCurrentAttenuationDb)
        .function("getProximityRatioDb", &ProximityControl::getProximityRatioDb)
        .function("processBlockNative", optional_override([](
            ProximityControl& proximity,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            proximity.processBlock(buf, numFrames, channels);
        }));

    // AutoPhaseAligner bindings
    value_object<PhaseAlignResult>("PhaseAlignResult")
        .field("delayMs", &PhaseAlignResult::delayMs)
        .field("delaySamples", &PhaseAlignResult::delaySamples)
        .field("correlation", &PhaseAlignResult::correlation)
        .field("phaseInverted", &PhaseAlignResult::phaseInverted)
        .field("coherenceScore", &PhaseAlignResult::coherenceScore);

    value_object<AutoPhaseParams>("AutoPhaseParams")
        .field("maxShiftMs", &AutoPhaseParams::maxShiftMs)
        .field("autoInvertPolarity", &AutoPhaseParams::autoInvertPolarity)
        .field("enabled", &AutoPhaseParams::enabled);

    class_<AutoPhaseAligner>("AutoPhaseAligner")
        .constructor<float>()
        .function("setSampleRate", &AutoPhaseAligner::setSampleRate)
        .function("getSampleRate", &AutoPhaseAligner::getSampleRate)
        .function("setParams", &AutoPhaseAligner::setParams)
        .function("getParams", &AutoPhaseAligner::getParams)
        .function("reset", &AutoPhaseAligner::reset)
        .function("analyzePhaseNative", optional_override([](
            AutoPhaseAligner& aligner,
            uintptr_t refPtr,
            uintptr_t tgtPtr,
            size_t numFrames,
            float maxShiftMs
        ) {
            const float* ref = reinterpret_cast<const float*>(refPtr);
            const float* tgt = reinterpret_cast<const float*>(tgtPtr);
            return aligner.analyzePhase(ref, tgt, numFrames, maxShiftMs);
        }))
        .function("alignSignalsNative", optional_override([](
            AutoPhaseAligner& aligner,
            uintptr_t refPtr,
            uintptr_t tgtPtr,
            size_t numFrames,
            float maxShiftMs
        ) {
            const float* ref = reinterpret_cast<const float*>(refPtr);
            float* tgt = reinterpret_cast<float*>(tgtPtr);
            return aligner.alignSignals(ref, tgt, numFrames, maxShiftMs);
        }))
        .function("processBlockNative", optional_override([](
            AutoPhaseAligner& aligner,
            uintptr_t bufferPtr,
            size_t numFrames,
            int channels
        ) {
            float* buf = reinterpret_cast<float*>(bufferPtr);
            aligner.processBlock(buf, numFrames, channels);
        }));
}

#endif // __EMSCRIPTEN__

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/heap.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

extern "C" {

EMSCRIPTEN_KEEPALIVE
size_t getAvailableWasmMemory() {
#ifdef __EMSCRIPTEN__
    return emscripten_get_heap_size();
#else
    return 2147483648ULL;
#endif
}

EMSCRIPTEN_KEEPALIVE
uintptr_t createMixerInstance(float sampleRate) {
    auto* mixer = new DAWCore::Mixer(sampleRate);
    return reinterpret_cast<uintptr_t>(mixer);
}

EMSCRIPTEN_KEEPALIVE
void freeMixerInstance(uintptr_t mixerPtr) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    delete mixer;
}

EMSCRIPTEN_KEEPALIVE
void processMixer(uintptr_t mixerPtr, uintptr_t outputPtr, int numSamples) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    float* outBuf = reinterpret_cast<float*>(outputPtr);
    if (mixer && outBuf) {
        mixer->processBlock(outBuf, static_cast<size_t>(numSamples));
    }
}

EMSCRIPTEN_KEEPALIVE
void pushTrackAudioChunk(void* mixerPtr, int trackId, float* chunkPtr, int numFrames, int64_t startTimelineSample) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer || !chunkPtr || numFrames <= 0) return;
    DAWCore::Track* track = mixer->getTrack(static_cast<uint32_t>(trackId));
    if (!track) return;
    track->pushAudioChunk(chunkPtr, numFrames, startTimelineSample);
}

EMSCRIPTEN_KEEPALIVE
void setTimelinePosition(uintptr_t mixerPtr, int64_t samplePosition) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (mixer) {
        mixer->setTimelinePosition(static_cast<size_t>(samplePosition));
    }
}

EMSCRIPTEN_KEEPALIVE
bool addTrack(uintptr_t mixerPtr, uint32_t trackId, const char* name, bool isOriginalAudio) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    DAWCore::Track* existing = mixer->getTrack(trackId);
    if (!existing) {
        std::string trackName = (name && strlen(name) > 0) ? name : ("Track " + std::to_string(trackId));
        auto newTrack = new DAWCore::Track(trackId, trackName, mixer->sampleRate);
        newTrack->isOriginalAudio = isOriginalAudio;
        mixer->addTrack(newTrack);
    } else {
        if (name && strlen(name) > 0) existing->name = name;
        existing->isOriginalAudio = isOriginalAudio;
    }
    return true;
}

EMSCRIPTEN_KEEPALIVE
uintptr_t getTrack(uintptr_t mixerPtr, uint32_t trackId) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return 0;
    return reinterpret_cast<uintptr_t>(mixer->getTrack(trackId));
}

EMSCRIPTEN_KEEPALIVE
bool setTrackIsOriginalAudio(uintptr_t mixerPtr, uint32_t trackId, bool isOriginalAudio) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    DAWCore::Track* track = mixer->getTrack(trackId);
    if (!track) return false;
    track->isOriginalAudio = isOriginalAudio;
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool addClipToTrack(
    uintptr_t mixerPtr,
    uint32_t trackId,
    uint32_t clipId,
    uintptr_t bufferPtr,
    size_t bufferSizeSamples,
    size_t offsetSamples,
    size_t lengthSamples,
    float gain,
    float pan,
    size_t fadeIn,
    size_t fadeOut,
    bool isStereo
) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    DAWCore::Track* track = mixer->getTrack(trackId);
    if (!track) {
        auto newTrack = new DAWCore::Track(trackId, "Track " + std::to_string(trackId), mixer->sampleRate);
        mixer->addTrack(newTrack);
        track = newTrack;
    }
    if (!track) return false;

    DAWCore::Clip clip;
    clip.id = clipId;
    clip.sampleBuffer = reinterpret_cast<const float*>(bufferPtr);
    clip.bufferSizeSamples = bufferSizeSamples;
    clip.offsetSamples = offsetSamples;
    clip.lengthSamples = lengthSamples;
    clip.gain = gain;
    clip.pan = pan;
    clip.fadeInSamples = fadeIn;
    clip.fadeOutSamples = fadeOut;
    clip.isStereo = isStereo;
    clip.active = true;

    track->addClip(clip);
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setTrackVolume(uintptr_t mixerPtr, uint32_t trackId, float volumeDb) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    DAWCore::Track* track = mixer->getTrack(trackId);
    if (!track) return false;
    track->volumeDb = volumeDb;
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setTrackPan(uintptr_t mixerPtr, uint32_t trackId, float pan) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    DAWCore::Track* track = mixer->getTrack(trackId);
    if (!track) return false;
    track->pan = pan;
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setTrackSolo(uintptr_t mixerPtr, uint32_t trackId, bool solo) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    DAWCore::Track* track = mixer->getTrack(trackId);
    if (!track) return false;
    track->solo = solo;
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setTrackMute(uintptr_t mixerPtr, uint32_t trackId, bool mute) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    DAWCore::Track* track = mixer->getTrack(trackId);
    if (!track) return false;
    track->mute = mute;
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool removeAllTracks(uintptr_t mixerPtr) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->removeAllTracks();
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setMasterVolume(uintptr_t mixerPtr, float volumeDb) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->masterVolumeDb = volumeDb;
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setMasterLimiter(uintptr_t mixerPtr, bool enabled, float ceilingDb) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->masterLimiter.enabled = enabled;
    mixer->masterLimiter.ceilingDb = ceilingDb;
    return true;
}

// ============================================================================
// Universal VST C-API: Управление слотами дорожек, шины вокалов и мастер-шины
// ============================================================================

EMSCRIPTEN_KEEPALIVE
bool setVocalBusVolume(uintptr_t mixerPtr, float volumeDb) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->vocalBusVolumeDb = volumeDb;
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setVocalBusAutoDucker(uintptr_t mixerPtr, bool enabled, float thresholdDb, float duckDepthDb, float attackMs, float releaseMs) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->vocalBusAutoDucker.enabled = enabled;
    mixer->vocalBusAutoDucker.thresholdDb = thresholdDb;
    mixer->vocalBusAutoDucker.duckDepthDb = duckDepthDb;
    mixer->vocalBusAutoDucker.attackMs = attackMs;
    mixer->vocalBusAutoDucker.releaseMs = releaseMs;
    mixer->vocalBusAutoDucker.updateConstants();
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool loadTrackPlugin(uintptr_t mixerPtr, uint32_t trackId, int slotIdx, int pluginTypeId) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    if (trackId == 999) {
        mixer->loadVocalBusPlugin(slotIdx, pluginTypeId);
        return true;
    }
    if (trackId == 1000) {
        mixer->loadMasterPlugin(slotIdx, pluginTypeId);
        return true;
    }
    DAWCore::Track* track = mixer->getTrack(trackId);
    if (!track) return false;
    track->loadPlugin(slotIdx, pluginTypeId);
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setTrackPluginParam(uintptr_t mixerPtr, uint32_t trackId, int slotIdx, int paramId, float normalizedValue) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    if (trackId == 999) {
        mixer->setVocalBusPluginParam(slotIdx, paramId, normalizedValue);
        return true;
    }
    if (trackId == 1000) {
        mixer->setMasterPluginParam(slotIdx, paramId, normalizedValue);
        return true;
    }
    DAWCore::Track* track = mixer->getTrack(trackId);
    if (!track) return false;
    track->setPluginParam(slotIdx, paramId, normalizedValue);
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setTrackPluginBypass(uintptr_t mixerPtr, uint32_t trackId, int slotIdx, int bypass) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    if (trackId == 999) {
        mixer->setVocalBusPluginBypass(slotIdx, bypass != 0);
        return true;
    }
    if (trackId == 1000) {
        mixer->setMasterPluginBypass(slotIdx, bypass != 0);
        return true;
    }
    DAWCore::Track* track = mixer->getTrack(trackId);
    if (!track) return false;
    track->setPluginBypass(slotIdx, bypass != 0);
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setTrackPluginWetDry(uintptr_t mixerPtr, uint32_t trackId, int slotIdx, float wetDry) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    if (trackId == 999) {
        mixer->setVocalBusPluginWetDry(slotIdx, wetDry);
        return true;
    }
    if (trackId == 1000) {
        mixer->setMasterPluginWetDry(slotIdx, wetDry);
        return true;
    }
    DAWCore::Track* track = mixer->getTrack(trackId);
    if (!track) return false;
    track->setPluginWetDry(slotIdx, wetDry);
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool loadMasterPlugin(uintptr_t mixerPtr, int slotIdx, int pluginTypeId) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->loadMasterPlugin(slotIdx, pluginTypeId);
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setMasterPluginParam(uintptr_t mixerPtr, int slotIdx, int paramId, float normalizedValue) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->setMasterPluginParam(slotIdx, paramId, normalizedValue);
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setMasterPluginBypass(uintptr_t mixerPtr, int slotIdx, int bypass) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->setMasterPluginBypass(slotIdx, bypass != 0);
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setMasterPluginWetDry(uintptr_t mixerPtr, int slotIdx, float wetDry) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->setMasterPluginWetDry(slotIdx, wetDry);
    return true;
}

EMSCRIPTEN_KEEPALIVE
float getTrackPeak(uintptr_t mixerPtr, int trackId, int channel) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return 0.0f;
    return mixer->getPeak(trackId, channel);
}

EMSCRIPTEN_KEEPALIVE
float getTrackRMS(uintptr_t mixerPtr, int trackId, int channel) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return 0.0f;
    return mixer->getRMS(trackId, channel);
}

EMSCRIPTEN_KEEPALIVE
int extractWaveformPeaks(
    uintptr_t bufferPtr,
    size_t bufferLength,
    int targetPixels,
    size_t startFrame,
    size_t lengthFrames,
    int isStereo,
    uintptr_t outMinPtr,
    uintptr_t outMaxPtr
) {
    const float* inBuf = reinterpret_cast<const float*>(bufferPtr);
    float* outMin = reinterpret_cast<float*>(outMinPtr);
    float* outMax = reinterpret_cast<float*>(outMaxPtr);
    return DAWCore::WaveformAnalyzer::extractPeaksNative(
        inBuf,
        bufferLength,
        targetPixels,
        startFrame,
        lengthFrames,
        isStereo != 0,
        outMin,
        outMax
    );
}

EMSCRIPTEN_KEEPALIVE
int extractWaveformRMS(
    uintptr_t bufferPtr,
    size_t bufferLength,
    int targetPixels,
    size_t startFrame,
    size_t lengthFrames,
    int isStereo,
    uintptr_t outRmsPtr
) {
    const float* inBuf = reinterpret_cast<const float*>(bufferPtr);
    float* outRms = reinterpret_cast<float*>(outRmsPtr);
    return DAWCore::WaveformAnalyzer::extractRMSPeaksNative(
        inBuf,
        bufferLength,
        targetPixels,
        startFrame,
        lengthFrames,
        isStereo != 0,
        outRms
    );
}

// ============================================================================
// Управление цепочкой инсерт-эффектов дорожки (TrackInsertChain)
// ============================================================================

EMSCRIPTEN_KEEPALIVE
int addTrackEffect(uintptr_t mixerPtr, int trackId, int effectTypeId) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return -1;
    return mixer->addTrackEffect(static_cast<uint32_t>(trackId), effectTypeId);
}

EMSCRIPTEN_KEEPALIVE
bool removeTrackEffect(uintptr_t mixerPtr, int trackId, int slotIdx) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    return mixer->removeTrackEffect(static_cast<uint32_t>(trackId), slotIdx);
}

EMSCRIPTEN_KEEPALIVE
bool setTrackEffectParam(uintptr_t mixerPtr, int trackId, int slotIdx, int paramId, float value) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->setTrackEffectParam(static_cast<uint32_t>(trackId), slotIdx, paramId, value);
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool setTrackEffectBypass(uintptr_t mixerPtr, int trackId, int slotIdx, int bypass) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    mixer->setTrackEffectBypass(static_cast<uint32_t>(trackId), slotIdx, bypass != 0);
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool reorderTrackEffects(uintptr_t mixerPtr, int trackId, int fromIdx, int toIdx) {
    auto* mixer = reinterpret_cast<DAWCore::Mixer*>(mixerPtr);
    if (!mixer) return false;
    return mixer->reorderTrackEffects(static_cast<uint32_t>(trackId), fromIdx, toIdx);
}

} // extern "C"
