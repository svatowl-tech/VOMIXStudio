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
#include "../dsp/AudioUtils.hpp"
#include "../vocal/VocalRack.hpp"
#include "../engine/Clip.hpp"
#include "../engine/Track.hpp"
#include "../engine/Mixer.hpp"
#include "../editing/WSOLATimeStretch.hpp"
#include "../editing/ClipEditor.hpp"
#include "../editing/SilenceStripper.hpp"
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
        .function("clearClips", &Track::clearClips);

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

} // extern "C"
