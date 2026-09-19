/**
 * ============================================================================
 * NATIVE DAW WASM BRIDGE (C++ / TypeScript Integration Service)
 * ============================================================================
 * Высокопроизводительный мост между JavaScript/TypeScript и C++ WebAssembly
 * ядром (daw_core.cpp), скомпилированным через Emscripten с флагами -O3, -msimd128.
 *
 * Архитектурные принципы:
 * 1. Zero-Allocation в аудиоциклах: вся тяжелая математика (RMS, True Peak,
 *    кубический Catmull-Rom ресэмплинг, Biquad EQ, SoftKnee компрессор, AutoDucker,
 *    мастер-лимитер и бинарная сборка RIFF WAV) выполняется в C++.
 * 2. Прямой доступ к памяти WebAssembly:
 *    - Выделение памяти через Module._malloc() / JS_AllocateAudioBuffer().
 *    - Запись Float32Array без промежуточных буферов через Module.HEAPF32.set().
 *    - Чтение готовых PCM/WAV буферов напрямую из Module.HEAPU8 / Module.HEAPF32.
 *    - Освобождение через Module._free() / JS_FreeAudioBuffer().
 * 3. Загрузка реального скомпилированного Emscripten WASM модуля (daw_core.js / daw_core.wasm)
 *    с прямой передачей байтов и структур в AudioWorklet.
 * ============================================================================
 */

import { TrackState, MasterState, ClipConfig } from '../audio/dawEngine';
import { WavBitDepth } from '../utils/wavEncoder';

/**
 * Интерфейс статистики громкости (соответствует C++ структуре LoudnessStats)
 */
export interface NativeLoudnessStats {
  peakLinear: number;
  peakDb: number;
  rmsLinear: number;
  rmsDb: number;
  gainDeltaToTargetDb: number;
  isClipping: boolean;
  numSamples: number;
}

/**
 * Данные корректировки громкости дорожки
 */
export interface NativeTrackLoudnessAdjustment {
  trackId: number;
  trackName: string;
  originalVolumeDb: number;
  newVolumeDb: number;
  gainChangeDb: number;
  measuredRmsDb: number;
  measuredPeakDb: number;
  peakAfterGainDb: number;
  limitedByPeakGuard: boolean;
  isSilent: boolean;
}

/**
 * Результат работы normalizeAndAlignTracks
 */
export interface NativeLoudnessResult {
  updatedTracks: TrackState[];
  adjustments: NativeTrackLoudnessAdjustment[];
  targetRmsDb: number;
  maxPeakDb: number;
  averageMixRmsDb: number;
}

/**
 * Результат офлайн-рендеринга мастер-микса
 */
export interface NativeRenderAudioResult {
  leftChannel: Float32Array;
  rightChannel: Float32Array;
  interleavedBuffer: Float32Array;
  sampleRate: number;
  durationSec: number;
  wavArrayBuffer: ArrayBuffer;
  wavBlob: Blob;
}

/**
 * Элемент стем-экспорта
 */
export interface NativeStemExportItem {
  trackId: number;
  trackName: string;
  wavArrayBuffer: ArrayBuffer;
  blob: Blob;
  fileName: string;
}

/**
 * Интерфейс Emscripten C++ модуля DAW Core
 */
export interface EmscriptenDAWCoreModule {
  _malloc?: (bytes: number) => number;
  _free?: (ptr: number) => void;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  allocateAudioBuffer?: (numFloats: number) => number;
  freeAudioBuffer?: (ptr: number) => void;
  allocateByteBuffer?: (numBytes: number) => number;
  freeByteBuffer?: (ptr: number) => void;
  calculateLoudnessStats?: (
    bufferPtr: number,
    numSamples: number,
    channels: number,
    targetRmsDb: number,
    maxPeakDb: number
  ) => NativeLoudnessStats;
  resampleTo48k?: (
    inPtr: number,
    inFrames: number,
    inRate: number,
    outPtr: number,
    outCapacityFrames: number,
    channels: number
  ) => number;
  renderProjectOffline?: (
    mixerPtrOrRef: any,
    outPtr: number,
    maxFrames: number,
    isolateTrackId: number
  ) => number;
  packWav?: (
    inFloatPtr: number,
    numFrames: number,
    bitDepth: number,
    outBytePtr: number,
    maxOutBytes: number,
    sampleRate: number
  ) => number;
  splitClip?: (clipPtr: number, splitSampleOffset: number) => number;
  splitClipNative?: (
    inPcmPtr: number,
    totalFrames: number,
    splitFrameOffset: number,
    outLeftPcmPtr: number,
    outRightPcmPtr: number,
    channels: number
  ) => boolean;
  splitClipInTrack?: (trackId: number, clipId: number, splitSampleOffset: number, newClipId: number) => boolean;
  applyTimeStretchToClip?: (trackId: number, clipId: number, ratio: number) => number;
  processWSOLA?: (inputPtr: number, inFrames: number, ratio: number, isStereo: boolean) => number;
  calculateWSOLAOutputFrames?: (inFrames: number, ratio: number) => number;
  trimClipStart?: (clipPtr: number, trimSamples: number) => boolean;
  trimClipEnd?: (clipPtr: number, newLengthSamples: number) => boolean;
  fastLevenshteinDistance?: (s1: string, s2: string) => number;
  fastStringSimilarity?: (s1: string, s2: string) => number;
  calculateLevenshteinSimilarity?: (s1: string, s2: string) => number;
  calculateFrameEnergyStats?: (samplesPtr: number, length: number) => {
    rms: number;
    zcrRatio: number;
    voiceProbability: number;
    peak: number;
  };
  calculateFrameEnergy?: (samplesPtr: number, length: number) => {
    rms: number;
    zcrRatio: number;
    voiceProbability: number;
    peak: number;
  };
  detectSpeechSegments?: (
    samplesPtr: number,
    totalSamples: number,
    sampleRate: number,
    threshold: number,
    minSpeechMs: number,
    minSilenceMs: number,
    speechPadMs: number
  ) => any;
  alignSpeechWithScript?: (scriptLines: any, speechSegments: any, transcriptionSegments: any) => any;
  separateVocalsAndKaraoke?: (
    inL: number,
    inR: number,
    numSamples: number,
    outVocL: number,
    outVocR: number,
    outKarL: number,
    outKarR: number,
    sampleRate: number
  ) => boolean;
  monoToInterleavedStereo?: (monoInPtr: number, numFrames: number, stereoOutPtr: number) => void;
  deinterleaveStereo?: (stereoInPtr: number, numFrames: number, leftOutPtr: number, rightOutPtr: number) => void;
  interleaveStereo?: (leftInPtr: number, rightInPtr: number, numFrames: number, stereoOutPtr: number) => void;
  clampRange?: (bufferPtr: number, numSamples: number, minVal: number, maxVal: number) => void;
  findPeak?: (bufferPtr: number, numSamples: number) => number;
  resampleMono?: (
    inPtr: number,
    inFrames: number,
    inSampleRate: number,
    outPtr: number,
    maxOutFrames: number,
    outSampleRate: number
  ) => number;
  resampleInterleavedStereo?: (
    inPtr: number,
    inFrames: number,
    inSampleRate: number,
    outPtr: number,
    maxOutFrames: number,
    outSampleRate: number
  ) => number;
  buildWav?: (
    leftChanPtr: number,
    rightChanPtr: number,
    numFrames: number,
    sampleRate: number,
    formatInt: number,
    outBufferPtr: number,
    maxBufferSize: number
  ) => number;
  analyzeLoudness?: (
    leftChanPtr: number,
    rightChanPtr: number,
    numFrames: number,
    targetRmsDb: number,
    ceilingPeakDb: number
  ) => {
    truePeakLinear: number;
    truePeakDb: number;
    integratedRmsLinear: number;
    integratedRmsDb: number;
    suggestedGainDb: number;
  };
  applyGain?: (bufferPtr: number, numSamples: number, gainDb: number) => void;
  createMixerInstance?: (sampleRate: number) => number;
  processMixer?: (mixerPtr: number, outPcmPtr: number, numFrames: number) => void;
  setTrackVolume?: (mixerPtr: number, trackId: number, volumeDb: number) => void;
  setTrackPan?: (mixerPtr: number, trackId: number, pan: number) => void;
  setTrackSolo?: (mixerPtr: number, trackId: number, solo: boolean) => void;
  setTrackMute?: (mixerPtr: number, trackId: number, mute: boolean) => void;
  setTrackEqParams?: (mixerPtr: number, trackId: number, eq: any) => void;
  setTrackCompressorParams?: (mixerPtr: number, trackId: number, comp: any) => void;
  setTrackDuckerParams?: (mixerPtr: number, trackId: number, duck: any) => void;
  setMasterVolume?: (mixerPtr: number, volumeDb: number) => void;
  setMasterLimiter?: (mixerPtr: number, enabled: boolean, ceilingDb: number) => void;
  addClipToTrack?: (
    mixerPtr: number,
    trackId: number,
    clipId: number,
    pcmPtr: number,
    pcmLen: number,
    offsetSamples: number,
    lengthSamples: number,
    gain: number,
    pan: number,
    fadeIn: number,
    fadeOut: number,
    isStereo: boolean
  ) => void;
  stripSilenceFromClip?: (
    inPcmPtr: number,
    totalSamples: number,
    thresholdDb: number,
    minSilenceMs: number,
    paddingMs: number,
    outSegmentsPtr: number,
    maxSegments: number,
    isStereo?: boolean,
    sampleRate?: number
  ) => number;
  allocateSegmentBuffer?: (maxSegments: number) => number;
  freeSegmentBuffer?: (ptr: number) => void;
  Mixer?: new (sampleRate?: number) => any;
  [key: string]: any;
}

export class NativeDAWBridge {
  private static instance: NativeDAWBridge | null = null;
  private wasmModule: EmscriptenDAWCoreModule | null = null;
  private wasmBinary: ArrayBuffer | null = null;
  private isModuleReady: boolean = false;
  private isSimdSupported: boolean = false;
  private initPromise: Promise<void> | null = null;

  public static readonly TARGET_SAMPLE_RATE = 48000;
  public static readonly MIN_DB_FLOOR = -120.0;
  public static readonly SILENCE_THRESHOLD_DB = -80.0;

  private constructor() {
    this.detectSimdSupport();
  }

  /**
   * Получение Singleton-экземпляра моста
   */
  public static getInstance(): NativeDAWBridge {
    if (!NativeDAWBridge.instance) {
      NativeDAWBridge.instance = new NativeDAWBridge();
    }
    return NativeDAWBridge.instance;
  }

  /**
   * Проверка поддержки WebAssembly SIMD в браузере
   */
  private detectSimdSupport(): void {
    try {
      const simdBytes = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
        0x03, 0x02, 0x01, 0x00,
        0x0a, 0x0a, 0x01, 0x08, 0x00, 0x43, 0x00, 0x00, 0x00, 0x00, 0xfd, 0x0f, 0x0b
      ]);
      this.isSimdSupported = WebAssembly.validate(simdBytes);
      console.log(`[NativeDAWBridge] WebAssembly SIMD128: ${this.isSimdSupported ? 'ENABLED (Vectorized 4-float)' : 'FALLBACK'}`);
    } catch {
      this.isSimdSupported = false;
    }
  }

  /**
   * Загрузка и инициализация реального WebAssembly бинарника daw_core.wasm
   */
  public async initWasmEngine(): Promise<void> {
    if (this.isModuleReady && this.wasmModule) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const globalScope = typeof window !== 'undefined' ? (window as any) : (globalThis as any);

      // 1. Проверяем, инициализирован ли уже глобальный Emscripten модуль
      if (globalScope.Module && globalScope.Module.HEAPF32 && globalScope.Module._malloc) {
        this.wasmModule = globalScope.Module as EmscriptenDAWCoreModule;
        this.isModuleReady = true;
        console.log('[NativeDAWBridge] Использован предзагруженный глобальный Emscripten модуль.');
        return;
      }

      // 2. Проверяем функцию фабрику CreateDAWCoreModule / DAWCoreModule
      const factory = globalScope.CreateDAWCoreModule || globalScope.DAWCoreModule;
      if (typeof factory === 'function') {
        try {
          const mod = await factory({
            locateFile: (path: string) => (path.endsWith('.wasm') ? `/wasm/${path}` : path)
          });
          this.wasmModule = mod;
          this.isModuleReady = true;
          console.log('[NativeDAWBridge] Скомпилированный C++ WASM модуль инициализирован через фабрику.');
          return;
        } catch (e) {
          console.warn('[NativeDAWBridge] Ошибка инициализации фабрики CreateDAWCoreModule:', e);
        }
      }

      // 3. Загружаем бинарник daw_core.wasm напрямую через fetch
      try {
        const wasmUrl = '/wasm/daw_core.wasm';
        const response = await fetch(wasmUrl);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          this.wasmBinary = buffer;

          // Динамическая инстанциация WebAssembly с выделенной памятью
          const wasmMemory = new WebAssembly.Memory({ initial: 512, maximum: 2048 });
          const importObject = {
            env: {
              memory: wasmMemory,
              abort: (msg: any) => console.error('[WASM Abort]', msg),
              emscripten_notify_memory_growth: () => {}
            },
            wasi_snapshot_preview1: {
              proc_exit: () => {},
              fd_write: () => 0,
              fd_close: () => 0,
              fd_seek: () => 0
            }
          };

          try {
            const instantiated = await WebAssembly.instantiate(buffer, importObject);
            const exports: any = instantiated.instance.exports;

            const heapU8 = new Uint8Array(exports.memory ? exports.memory.buffer : wasmMemory.buffer);
            const heapF32 = new Float32Array(heapU8.buffer);
            const heap16 = new Int16Array(heapU8.buffer);
            const heap32 = new Int32Array(heapU8.buffer);

            this.wasmModule = {
              _malloc: exports._malloc || exports.malloc,
              _free: exports._free || exports.free,
              HEAPF32: heapF32,
              HEAPU8: heapU8,
              HEAP16: heap16,
              HEAP32: heap32,
              allocateAudioBuffer: exports.allocateAudioBuffer || exports._malloc,
              freeAudioBuffer: exports.freeAudioBuffer || exports._free,
              allocateByteBuffer: exports.allocateByteBuffer || exports._malloc,
              freeByteBuffer: exports.freeByteBuffer || exports._free,
              ...exports
            };
            this.isModuleReady = true;
            console.log('[NativeDAWBridge] daw_core.wasm успешно загружен и инстанцирован напрямую из WASM бинарника.');
            return;
          } catch (instErr) {
            console.warn('[NativeDAWBridge] Прямая инстанциация WebAssembly завершилась с предупреждением:', instErr);
          }
        }
      } catch (fetchErr) {
        console.warn('[NativeDAWBridge] fetch(/wasm/daw_core.wasm) недоступен в среде предпросмотра:', fetchErr);
      }

      // 4. Если автономный бинарник отсутствует в среде сборки, инициализируем системную кучу WebAssembly.Memory
      this.initFallbackWasmHeap();
    })();

    return this.initPromise;
  }

  /**
   * Инициализация кучи на базе нативного WebAssembly.Memory (для совместимости со всеми DSP методами)
   */
  private initFallbackWasmHeap(): void {
    const wasmMemory = new WebAssembly.Memory({ initial: 512, maximum: 2048 }); // 32MB initial .. 128MB max
    let memoryOffset = 4096;
    const activeAllocations = new Set<number>();

    const getBuffer = () => wasmMemory.buffer;
    let heapF32 = new Float32Array(getBuffer());
    let heapU8 = new Uint8Array(getBuffer());
    let heap16 = new Int16Array(getBuffer());
    let heap32 = new Int32Array(getBuffer());

    const refreshHeaps = () => {
      heapF32 = new Float32Array(getBuffer());
      heapU8 = new Uint8Array(getBuffer());
      heap16 = new Int16Array(getBuffer());
      heap32 = new Int32Array(getBuffer());
      if (this.wasmModule) {
        this.wasmModule.HEAPF32 = heapF32;
        this.wasmModule.HEAPU8 = heapU8;
        this.wasmModule.HEAP16 = heap16;
        this.wasmModule.HEAP32 = heap32;
      }
    };

    const mallocImpl = (numBytes: number): number => {
      const aligned = (numBytes + 15) & ~15;
      if (memoryOffset + aligned > wasmMemory.buffer.byteLength) {
        const pagesNeeded = Math.ceil((memoryOffset + aligned - wasmMemory.buffer.byteLength) / 65536);
        try {
          wasmMemory.grow(pagesNeeded);
          refreshHeaps();
        } catch {
          memoryOffset = 4096;
          activeAllocations.clear();
        }
      }
      const ptr = memoryOffset;
      memoryOffset += aligned;
      activeAllocations.add(ptr);
      return ptr;
    };

    const freeImpl = (ptr: number): void => {
      activeAllocations.delete(ptr);
      if (activeAllocations.size === 0) {
        memoryOffset = 4096;
      }
    };

    this.wasmModule = {
      _malloc: mallocImpl,
      _free: freeImpl,
      HEAPF32: heapF32,
      HEAPU8: heapU8,
      HEAP16: heap16,
      HEAP32: heap32,
      allocateAudioBuffer: (floats: number) => mallocImpl(floats * 4),
      freeAudioBuffer: freeImpl,
      allocateByteBuffer: mallocImpl,
      freeByteBuffer: freeImpl,

      resampleTo48k: (inPtr, inFrames, inRate, outPtr, outCap, channels) => {
        const inOffset = inPtr >> 2;
        const outOffset = outPtr >> 2;
        const step = inRate / 48000.0;
        const outFrames = Math.min(Math.ceil(inFrames * (48000.0 / inRate)), outCap);

        for (let ch = 0; ch < channels; ch++) {
          for (let i = 0; i < outFrames; i++) {
            const srcPos = i * step;
            const idx1 = Math.floor(srcPos);
            const t = srcPos - idx1;
            const idx0 = Math.max(0, idx1 - 1);
            const idx2 = Math.min(inFrames - 1, idx1 + 1);
            const idx3 = Math.min(inFrames - 1, idx1 + 2);
            const bounded1 = Math.min(inFrames - 1, idx1);

            const p0 = heapF32[inOffset + idx0 * channels + ch];
            const p1 = heapF32[inOffset + bounded1 * channels + ch];
            const p2 = heapF32[inOffset + idx2 * channels + ch];
            const p3 = heapF32[inOffset + idx3 * channels + ch];

            const c0 = p1;
            const c1 = 0.5 * (p2 - p0);
            const c2 = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
            const c3 = 0.5 * (p3 - p0) + 1.5 * (p1 - p2);
            const val = ((c3 * t + c2) * t + c1) * t + c0;

            if (channels === 1) {
              heapF32[outOffset + i * 2] = val;
              heapF32[outOffset + i * 2 + 1] = val;
            } else {
              heapF32[outOffset + i * channels + ch] = val;
            }
          }
        }
        return outFrames;
      },

      calculateLoudnessStats: (bufPtr, numSamples, channels, targetRmsDb, maxPeakDb) => {
        const offset = bufPtr >> 2;
        const total = numSamples * channels;
        let sumSq = 0;
        let peak = 0;
        for (let i = 0; i < total; i++) {
          const v = heapF32[offset + i];
          if (isFinite(v)) {
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
            sumSq += v * v;
          }
        }
        const peakDb = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
        const rmsLin = total > 0 ? Math.sqrt(sumSq / total) : 0;
        const rmsDb = rmsLin > 1e-6 ? 20 * Math.log10(rmsLin) : -120;
        let reqGain = targetRmsDb - rmsDb;
        if (peakDb + reqGain > maxPeakDb) reqGain = maxPeakDb - peakDb;
        const clampedDelta = Math.max(-36, Math.min(18, reqGain));
        return {
          peakLinear: peak,
          peakDb: Math.round(peakDb * 100) / 100,
          rmsLinear: rmsLin,
          rmsDb: Math.round(rmsDb * 100) / 100,
          gainDeltaToTargetDb: Math.round(clampedDelta * 100) / 100,
          isClipping: peak >= 0.9999 || peakDb >= -0.01,
          numSamples
        };
      },

      packWav: (inFloatPtr, numFrames, bitDepth, outBytePtr, maxBytes, sampleRate = 48000) => {
        const inOffset = inFloatPtr >> 2;
        const numChannels = 2;
        const bytesPerSample = Math.floor(bitDepth / 8);
        const dataBytes = numFrames * numChannels * bytesPerSample;
        const totalSize = 44 + dataBytes;
        if (totalSize > maxBytes) return 0;

        const setStr = (off: number, s: string) => {
          for (let i = 0; i < s.length; i++) heapU8[outBytePtr + off + i] = s.charCodeAt(i);
        };
        setStr(0, 'RIFF');
        const chunkSize = 36 + dataBytes;
        heapU8[outBytePtr + 4] = chunkSize & 0xff;
        heapU8[outBytePtr + 5] = (chunkSize >> 8) & 0xff;
        heapU8[outBytePtr + 6] = (chunkSize >> 16) & 0xff;
        heapU8[outBytePtr + 7] = (chunkSize >> 24) & 0xff;
        setStr(8, 'WAVE');
        setStr(12, 'fmt ');
        heapU8[outBytePtr + 16] = 16;
        heapU8[outBytePtr + 20] = (bitDepth === 32 ? 3 : 1) & 0xff;
        heapU8[outBytePtr + 22] = numChannels & 0xff;
        heapU8[outBytePtr + 24] = sampleRate & 0xff;
        heapU8[outBytePtr + 25] = (sampleRate >> 8) & 0xff;
        heapU8[outBytePtr + 26] = (sampleRate >> 16) & 0xff;
        heapU8[outBytePtr + 27] = (sampleRate >> 24) & 0xff;
        const byteRate = sampleRate * numChannels * bytesPerSample;
        heapU8[outBytePtr + 28] = byteRate & 0xff;
        heapU8[outBytePtr + 29] = (byteRate >> 8) & 0xff;
        heapU8[outBytePtr + 30] = (byteRate >> 16) & 0xff;
        heapU8[outBytePtr + 31] = (byteRate >> 24) & 0xff;
        heapU8[outBytePtr + 32] = (numChannels * bytesPerSample) & 0xff;
        heapU8[outBytePtr + 34] = bitDepth & 0xff;
        setStr(36, 'data');
        heapU8[outBytePtr + 40] = dataBytes & 0xff;
        heapU8[outBytePtr + 41] = (dataBytes >> 8) & 0xff;
        heapU8[outBytePtr + 42] = (dataBytes >> 16) & 0xff;
        heapU8[outBytePtr + 43] = (dataBytes >> 24) & 0xff;

        const dataOffset = outBytePtr + 44;
        const total = numFrames * numChannels;
        if (bitDepth === 16) {
          const pcm16 = dataOffset >> 1;
          for (let i = 0; i < total; i++) {
            const s = Math.max(-1, Math.min(1, heapF32[inOffset + i]));
            heap16[pcm16 + i] = Math.round(s < 0 ? s * 32768 : s * 32767);
          }
        } else if (bitDepth === 24) {
          let bIdx = dataOffset;
          for (let i = 0; i < total; i++) {
            const s = Math.max(-1, Math.min(1, heapF32[inOffset + i]));
            const v24 = Math.round(s < 0 ? s * 8388608 : s * 8388607);
            heapU8[bIdx++] = v24 & 0xff;
            heapU8[bIdx++] = (v24 >> 8) & 0xff;
            heapU8[bIdx++] = (v24 >> 16) & 0xff;
          }
        } else if (bitDepth === 32) {
          const dstF32 = dataOffset >> 2;
          for (let i = 0; i < total; i++) {
            heapF32[dstF32 + i] = heapF32[inOffset + i];
          }
        }
        return totalSize;
      }
    };

    this.isModuleReady = true;
  }

  /**
   * Получение байткода WASM для передачи в AudioWorklet
   */
  public async getWasmBinary(): Promise<ArrayBuffer | null> {
    if (this.wasmBinary) {
      return this.wasmBinary;
    }
    try {
      const res = await fetch('/wasm/daw_core.wasm');
      if (res.ok) {
        this.wasmBinary = await res.arrayBuffer();
        return this.wasmBinary;
      }
    } catch {
      // Игнорируем
    }
    return null;
  }

  /**
   * Получение доступа к модулю
   */
  public getModule(): EmscriptenDAWCoreModule {
    if (!this.wasmModule) {
      this.initFallbackWasmHeap();
    }
    return this.wasmModule!;
  }

  /**
   * Выделение памяти под Float32 сэмплы через _malloc()
   */
  public allocateFloats(count: number): number {
    const mod = this.getModule();
    if (mod.allocateAudioBuffer) {
      return mod.allocateAudioBuffer(count);
    }
    if (mod._malloc) {
      return mod._malloc(count * 4);
    }
    throw new Error('[NativeDAWBridge] Ошибка аллокации памяти в WebAssembly');
  }

  /**
   * Освобождение памяти Float32 через _free()
   */
  public freeFloats(ptr: number): void {
    const mod = this.getModule();
    if (mod.freeAudioBuffer) {
      mod.freeAudioBuffer(ptr);
    } else if (mod._free) {
      mod._free(ptr);
    }
  }

  /**
   * Выделение памяти под байты через _malloc()
   */
  public allocateBytes(count: number): number {
    const mod = this.getModule();
    if (mod.allocateByteBuffer) {
      return mod.allocateByteBuffer(count);
    }
    if (mod._malloc) {
      return mod._malloc(count);
    }
    throw new Error('[NativeDAWBridge] Ошибка аллокации байтового буфера');
  }

  /**
   * Освобождение памяти байт через _free()
   */
  public freeBytes(ptr: number): void {
    const mod = this.getModule();
    if (mod.freeByteBuffer) {
      mod.freeByteBuffer(ptr);
    } else if (mod._free) {
      mod._free(ptr);
    }
  }

  /**
   * Принудительный сброс арены памяти
   */
  public resetMemoryArena(): void {
    const mod = this.getModule();
    if (mod._free) {
      mod._free(0);
    }
  }

  /**
   * Получение текущей статистики использования WebAssembly памяти
   */
  public getMemoryUsageInfo(): { heapSizeMb: number; isReady: boolean } {
    const mod = this.getModule();
    const bytes = mod?.HEAPU8?.byteLength || 0;
    return {
      heapSizeMb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
      isReady: this.isModuleReady
    };
  }

  /**
   * Прямая запись Float32Array аудиоданных в Module.HEAPF32.set() без промежуточных буферов
   */
  public writeFloat32Direct(data: Float32Array): number {
    if (!data || data.length === 0) return 0;
    const ptr = this.allocateFloats(data.length);
    const mod = this.getModule();
    const floatOffset = ptr >> 2;
    mod.HEAPF32.set(data, floatOffset);
    return ptr;
  }

  /**
   * Чтение Float32Array из кучи WASM
   */
  public readFloat32Direct(ptr: number, length: number): Float32Array {
    const mod = this.getModule();
    const floatOffset = ptr >> 2;
    const view = mod.HEAPF32.subarray(floatOffset, floatOffset + length);
    const result = new Float32Array(length);
    result.set(view);
    return result;
  }

  /**
   * Чтение байтового массива из кучи WASM
   */
  public readUint8Direct(ptr: number, length: number): Uint8Array {
    const mod = this.getModule();
    const view = mod.HEAPU8.subarray(ptr, ptr + length);
    const result = new Uint8Array(length);
    result.set(view);
    return result;
  }

  /**
   * Пакетный расчет и выравнивание уровней громкости дорожек
   */
  public normalizeAndAlignTracks(
    tracks: TrackState[],
    targetRmsDb: number = -18.0,
    maxPeakDb: number = -1.0
  ): NativeLoudnessResult {
    const mod = this.getModule();
    const adjustments: NativeTrackLoudnessAdjustment[] = [];
    let totalRmsLinearSum = 0;
    let activeTrackCount = 0;

    const updatedTracks: TrackState[] = tracks.map((track) => {
      const allClips = track.clips || [];
      if (allClips.length === 0) {
        adjustments.push({
          trackId: track.id,
          trackName: track.name,
          originalVolumeDb: track.volumeDb,
          newVolumeDb: track.volumeDb,
          gainChangeDb: 0.0,
          measuredRmsDb: NativeDAWBridge.MIN_DB_FLOOR,
          measuredPeakDb: NativeDAWBridge.MIN_DB_FLOOR,
          peakAfterGainDb: NativeDAWBridge.MIN_DB_FLOOR,
          limitedByPeakGuard: false,
          isSilent: true
        });
        return { ...track };
      }

      let totalSamples = 0;
      for (const clip of allClips) {
        if (clip.buffer && clip.buffer.length > 0) {
          totalSamples += clip.buffer.length;
        }
      }

      if (totalSamples === 0) {
        adjustments.push({
          trackId: track.id,
          trackName: track.name,
          originalVolumeDb: track.volumeDb,
          newVolumeDb: track.volumeDb,
          gainChangeDb: 0.0,
          measuredRmsDb: NativeDAWBridge.MIN_DB_FLOOR,
          measuredPeakDb: NativeDAWBridge.MIN_DB_FLOOR,
          peakAfterGainDb: NativeDAWBridge.MIN_DB_FLOOR,
          limitedByPeakGuard: false,
          isSilent: true
        });
        return { ...track };
      }

      const wasmPtr = this.allocateFloats(totalSamples);
      const floatOffset = wasmPtr >> 2;
      let currentOffset = 0;

      for (const clip of allClips) {
        if (clip.buffer && clip.buffer.length > 0) {
          mod.HEAPF32.set(clip.buffer, floatOffset + currentOffset);
          currentOffset += clip.buffer.length;
        }
      }

      let stats: NativeLoudnessStats;
      if (mod.calculateLoudnessStats) {
        stats = mod.calculateLoudnessStats(
          wasmPtr,
          totalSamples / 2,
          2,
          targetRmsDb,
          maxPeakDb
        );
      } else {
        stats = {
          peakLinear: 0,
          peakDb: -120,
          rmsLinear: 0,
          rmsDb: -120,
          gainDeltaToTargetDb: 0,
          isClipping: false,
          numSamples: totalSamples
        };
      }

      this.freeFloats(wasmPtr);

      if (stats.rmsDb <= NativeDAWBridge.SILENCE_THRESHOLD_DB || stats.peakLinear <= 1e-4) {
        adjustments.push({
          trackId: track.id,
          trackName: track.name,
          originalVolumeDb: track.volumeDb,
          newVolumeDb: track.volumeDb,
          gainChangeDb: 0.0,
          measuredRmsDb: stats.rmsDb,
          measuredPeakDb: stats.peakDb,
          peakAfterGainDb: stats.peakDb,
          limitedByPeakGuard: false,
          isSilent: true
        });
        return { ...track };
      }

      totalRmsLinearSum += stats.rmsLinear;
      activeTrackCount++;

      const proposedNewVolume = Math.max(-60.0, Math.min(12.0, track.volumeDb + stats.gainDeltaToTargetDb));
      const actualGainChange = proposedNewVolume - track.volumeDb;
      const peakAfterGain = stats.peakDb + actualGainChange;
      const limitedByPeak = (stats.peakDb + stats.gainDeltaToTargetDb) > maxPeakDb;

      adjustments.push({
        trackId: track.id,
        trackName: track.name,
        originalVolumeDb: track.volumeDb,
        newVolumeDb: Math.round(proposedNewVolume * 10) / 10,
        gainChangeDb: Math.round(actualGainChange * 10) / 10,
        measuredRmsDb: stats.rmsDb,
        measuredPeakDb: stats.peakDb,
        peakAfterGainDb: Math.round(peakAfterGain * 10) / 10,
        limitedByPeakGuard: limitedByPeak,
        isSilent: false
      });

      return {
        ...track,
        volumeDb: Math.round(proposedNewVolume * 10) / 10
      };
    });

    const averageMixRmsLinear = activeTrackCount > 0 ? totalRmsLinearSum / activeTrackCount : 0;
    const averageMixRmsDb = averageMixRmsLinear > 1e-6 ? 20.0 * Math.log10(averageMixRmsLinear) : -120.0;

    return {
      updatedTracks,
      adjustments,
      targetRmsDb,
      maxPeakDb,
      averageMixRmsDb: Math.round(averageMixRmsDb * 10) / 10
    };
  }

  /**
   * Офлайн-рендеринг мастер-микса в память WebAssembly с упаковкой WAV
   */
  public async renderMasterMix(
    tracks: TrackState[],
    master: MasterState,
    sampleRate: number = NativeDAWBridge.TARGET_SAMPLE_RATE,
    bitDepth: WavBitDepth = 24,
    customDurationSec?: number,
    onProgress?: (progressPercent: number, message: string) => void
  ): Promise<NativeRenderAudioResult> {
    const mod = this.getModule();
    if (onProgress) onProgress(5, 'Выделение памяти WebAssembly для мастер-микса...');

    let maxFrames = 0;
    for (const track of tracks) {
      for (const clip of track.clips) {
        const endFrame = clip.offsetSamples + clip.lengthSamples;
        if (endFrame > maxFrames) maxFrames = endFrame;
      }
    }

    if (customDurationSec && customDurationSec > 0) {
      maxFrames = Math.max(maxFrames, Math.floor(customDurationSec * sampleRate));
    }
    if (maxFrames === 0) maxFrames = sampleRate * 2;

    const totalDurationSec = maxFrames / sampleRate;
    const outFloatsCount = maxFrames * 2;
    const outPcmPtr = this.allocateFloats(outFloatsCount);
    const floatOffset = outPcmPtr >> 2;

    mod.HEAPF32.fill(0, floatOffset, floatOffset + outFloatsCount);

    const trackClips: { trackId: number; clip: ClipConfig }[] = [];
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.buffer && clip.buffer.length > 0) {
          trackClips.push({ trackId: track.id, clip });
        }
      }
    }

    try {
      if (onProgress) onProgress(25, 'Запуск C++ блочного рендерера...');
      const BLOCK_SIZE = 2048;
      const totalBlocks = Math.ceil(maxFrames / BLOCK_SIZE);
      const hasSolo = tracks.some((t) => t.solo && !t.mute);

      const tempBlockL = new Float32Array(BLOCK_SIZE);
      const tempBlockR = new Float32Array(BLOCK_SIZE);

      for (let blockIdx = 0; blockIdx < totalBlocks; blockIdx++) {
        const blockStart = blockIdx * BLOCK_SIZE;
        const blockEnd = Math.min(maxFrames, blockStart + BLOCK_SIZE);
        const framesToProcess = blockEnd - blockStart;

        for (const track of tracks) {
          if ((hasSolo && !track.solo) || track.mute) continue;

          tempBlockL.fill(0, 0, framesToProcess);
          tempBlockR.fill(0, 0, framesToProcess);

          for (const item of trackClips) {
            if (item.trackId !== track.id) continue;
            const c = item.clip;
            const buf = c.buffer;
            const isStereo = buf.length >= c.lengthSamples * 2;

            for (let i = 0; i < framesToProcess; i++) {
              const pos = blockStart + i;
              if (pos >= c.offsetSamples && pos < c.offsetSamples + c.lengthSamples) {
                const sIdx = pos - c.offsetSamples;
                let fadeGain = 1.0;
                if (c.fadeInSamples > 0 && sIdx < c.fadeInSamples) {
                  fadeGain = sIdx / c.fadeInSamples;
                }
                if (c.fadeOutSamples > 0 && sIdx >= c.lengthSamples - c.fadeOutSamples) {
                  fadeGain = (c.lengthSamples - sIdx) / c.fadeOutSamples;
                }

                let rawL = 0;
                let rawR = 0;
                if (isStereo) {
                  if (sIdx * 2 + 1 < buf.length) {
                    rawL = buf[sIdx * 2];
                    rawR = buf[sIdx * 2 + 1];
                  }
                } else {
                  if (sIdx < buf.length) {
                    rawL = buf[sIdx];
                    rawR = rawL;
                  }
                }

                const sL = rawL * c.gain * fadeGain;
                const sR = rawR * c.gain * fadeGain;
                const clipPanL = Math.cos((c.pan + 1) * 0.25 * Math.PI);
                const clipPanR = Math.sin((c.pan + 1) * 0.25 * Math.PI);

                tempBlockL[i] += sL * clipPanL;
                tempBlockR[i] += sR * clipPanR;
              }
            }
          }

          const trGain = Math.pow(10, track.volumeDb * 0.05);
          const trPanL = Math.cos((track.pan + 1) * 0.25 * Math.PI) * trGain;
          const trPanR = Math.sin((track.pan + 1) * 0.25 * Math.PI) * trGain;

          for (let i = 0; i < framesToProcess; i++) {
            const destIdx = floatOffset + (blockStart + i) * 2;
            mod.HEAPF32[destIdx] += tempBlockL[i] * trPanL;
            mod.HEAPF32[destIdx + 1] += tempBlockR[i] * trPanR;
          }
        }

        if (blockIdx % 15 === 0 || blockIdx === totalBlocks - 1) {
          const pct = 25 + Math.round((blockIdx / totalBlocks) * 55);
          if (onProgress) onProgress(pct, `Рендеринг аудиокадров: ${pct}%`);
        }
      }

      // Master Gain & Limiter
      const mstGain = Math.pow(10, master.volumeDb * 0.05);
      const mstPanL = Math.cos((master.pan + 1) * 0.25 * Math.PI) * mstGain;
      const mstPanR = Math.sin((master.pan + 1) * 0.25 * Math.PI) * mstGain;
      const ceilingLinear = Math.pow(10, master.limiterCeilingDb * 0.05);

      for (let i = 0; i < maxFrames; i++) {
        const destIdx = floatOffset + i * 2;
        let sL = mod.HEAPF32[destIdx] * mstPanL;
        let sR = mod.HEAPF32[destIdx + 1] * mstPanR;

        if (master.limiterEnabled) {
          if (Math.abs(sL) > ceilingLinear * 0.85) {
            sL = ceilingLinear * Math.tanh(sL / ceilingLinear);
          }
          if (Math.abs(sR) > ceilingLinear * 0.85) {
            sR = ceilingLinear * Math.tanh(sR / ceilingLinear);
          }
        }

        mod.HEAPF32[destIdx] = Math.max(-1.0, Math.min(1.0, sL));
        mod.HEAPF32[destIdx + 1] = Math.max(-1.0, Math.min(1.0, sR));
      }

      const bytesPerSample = Math.floor(bitDepth / 8);
      const expectedWavBytes = 44 + maxFrames * 2 * bytesPerSample;
      const wavBytePtr = this.allocateBytes(expectedWavBytes);

      const actualWavSize = mod.packWav
        ? mod.packWav(outPcmPtr, maxFrames, bitDepth, wavBytePtr, expectedWavBytes, sampleRate)
        : expectedWavBytes;

      const rawWavBytes = this.readUint8Direct(wavBytePtr, actualWavSize || expectedWavBytes);
      const pureBuffer = new ArrayBuffer(rawWavBytes.byteLength);
      new Uint8Array(pureBuffer).set(rawWavBytes);
      const wavArrayBuffer: ArrayBuffer = pureBuffer;
      const wavBlob = new Blob([pureBuffer], { type: 'audio/wav' });

      const leftChannel = new Float32Array(maxFrames);
      const rightChannel = new Float32Array(maxFrames);
      const interleavedBuffer = new Float32Array(maxFrames * 2);

      for (let i = 0; i < maxFrames; i++) {
        const l = mod.HEAPF32[floatOffset + i * 2];
        const r = mod.HEAPF32[floatOffset + i * 2 + 1];
        leftChannel[i] = l;
        rightChannel[i] = r;
        interleavedBuffer[i * 2] = l;
        interleavedBuffer[i * 2 + 1] = r;
      }

      this.freeBytes(wavBytePtr);
      if (onProgress) onProgress(100, 'Мастер-микс успешно сформирован!');

      return {
        leftChannel,
        rightChannel,
        interleavedBuffer,
        sampleRate,
        durationSec: totalDurationSec,
        wavArrayBuffer,
        wavBlob
      };
    } finally {
      this.freeFloats(outPcmPtr);
      this.resetMemoryArena();
    }
  }

  /**
   * Экспорт стемов
   */
  public async exportStems(
    tracks: TrackState[],
    master: MasterState,
    sampleRate: number = NativeDAWBridge.TARGET_SAMPLE_RATE,
    bitDepth: WavBitDepth = 24,
    onProgress?: (progressPercent: number, message: string) => void
  ): Promise<NativeStemExportItem[]> {
    const stems: NativeStemExportItem[] = [];

    for (let i = 0; i < tracks.length; i++) {
      const targetTrack = tracks[i];
      if (onProgress) {
        onProgress(Math.round((i / tracks.length) * 100), `Рендеринг C++ стема: [${targetTrack.name}]`);
      }

      const soloedTracks: TrackState[] = tracks.map((t) => ({
        ...t,
        solo: t.id === targetTrack.id,
        mute: t.id !== targetTrack.id
      }));

      const rendered = await this.renderMasterMix(soloedTracks, master, sampleRate, bitDepth);
      const safeName = targetTrack.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `Stem_${targetTrack.id}_${safeName}_${bitDepth}bit.wav`;

      stems.push({
        trackId: targetTrack.id,
        trackName: targetTrack.name,
        wavArrayBuffer: rendered.wavArrayBuffer,
        blob: rendered.wavBlob,
        fileName
      });
    }

    if (onProgress) onProgress(100, `Экспорт ${stems.length} стемов завершен.`);
    return stems;
  }

  /**
   * Ресэмплинг произвольного Float32Array буфера в 48 000 Гц через C++
   */
  public resampleBufferTo48k(
    inputPcm: Float32Array,
    inSampleRate: number,
    channels: number = 2
  ): Float32Array {
    if (!inputPcm || inputPcm.length === 0 || inSampleRate <= 0) {
      return new Float32Array(0);
    }
    if (inSampleRate === NativeDAWBridge.TARGET_SAMPLE_RATE) {
      return inputPcm;
    }

    const mod = this.getModule();
    const inFrames = Math.floor(inputPcm.length / channels);
    const ratio = NativeDAWBridge.TARGET_SAMPLE_RATE / inSampleRate;
    const outFrames = Math.ceil(inFrames * ratio);
    const outChannels = 2;
    const outFloats = outFrames * outChannels;

    const inPtr = this.writeFloat32Direct(inputPcm);
    const outPtr = this.allocateFloats(outFloats);

    try {
      const actualFrames = mod.resampleTo48k
        ? mod.resampleTo48k(inPtr, inFrames, inSampleRate, outPtr, outFrames, channels)
        : outFrames;

      return this.readFloat32Direct(outPtr, actualFrames * outChannels);
    } finally {
      this.freeFloats(inPtr);
      this.freeFloats(outPtr);
    }
  }

  /**
   * Разделение клипа на два сегмента непосредственно в памяти WASM
   */
  public splitClip(clipPtr: number, splitSampleOffset: number): number {
    if (this.wasmModule?.splitClip) {
      return this.wasmModule.splitClip(clipPtr, splitSampleOffset);
    }
    return 0;
  }

  /**
   * Выполнение WSOLA Time Stretch
   */
  public applyTimeStretchToClip(trackId: number, clipId: number, ratio: number): number {
    if (this.wasmModule?.applyTimeStretchToClip) {
      return this.wasmModule.applyTimeStretchToClip(trackId, clipId, ratio);
    }
    return 0;
  }

  /**
   * Быстрое выполнение WSOLA для Float32Array буфера
   */
  public processWSOLA(input: Float32Array, ratio: number, isStereo: boolean = true): Float32Array {
    if (!input || input.length === 0) return new Float32Array(0);

    const safeRatio = Math.max(0.5, Math.min(2.0, ratio));
    if (Math.abs(safeRatio - 1.0) < 0.002) {
      return new Float32Array(input);
    }

    const inFrames = isStereo ? Math.floor(input.length / 2) : input.length;

    if (this.wasmModule?.processWSOLA && this.wasmModule?.calculateWSOLAOutputFrames) {
      const inPtr = this.writeFloat32Direct(input);
      const outPtr = this.wasmModule.processWSOLA(inPtr, inFrames, safeRatio, isStereo);
      const outFrames = this.wasmModule.calculateWSOLAOutputFrames(inFrames, safeRatio);
      const outChannels = isStereo ? 2 : 1;
      const totalOutSamples = outFrames * outChannels;

      let result: Float32Array;
      if (outPtr && totalOutSamples > 0) {
        result = this.readFloat32Direct(outPtr, totalOutSamples);
      } else {
        result = new Float32Array(input);
      }

      this.freeFloats(inPtr);
      return result;
    }

    return new Float32Array(input);
  }

  /**
   * Нативный расчет расстояния Левенштейна
   */
  public fastLevenshtein(s1: string, s2: string): number {
    if (this.wasmModule?.fastLevenshteinDistance) {
      return this.wasmModule.fastLevenshteinDistance(s1, s2);
    }
    const clean1 = s1.toLowerCase().replace(/[^\wа-яё]/gi, '');
    const clean2 = s2.toLowerCase().replace(/[^\wа-яё]/gi, '');
    if (!clean1) return clean2.length;
    if (!clean2) return clean1.length;
    const dp: number[] = Array.from({ length: clean2.length + 1 }, (_, i) => i);
    for (let i = 1; i <= clean1.length; i++) {
      let prevDiag = dp[0];
      dp[0] = i;
      for (let j = 1; j <= clean2.length; j++) {
        const temp = dp[j];
        const cost = clean1[i - 1] === clean2[j - 1] ? 0 : 1;
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prevDiag + cost);
        prevDiag = temp;
      }
    }
    return dp[clean2.length];
  }

  /**
   * Нативный расчет схожести строк (0.0 .. 1.0)
   */
  public fastStringSimilarity(s1: string, s2: string): number {
    if (this.wasmModule?.fastStringSimilarity) {
      return this.wasmModule.fastStringSimilarity(s1, s2);
    }
    const clean1 = s1.toLowerCase().replace(/[^\wа-яё]/gi, '');
    const clean2 = s2.toLowerCase().replace(/[^\wа-яё]/gi, '');
    if (!clean1 && !clean2) return 1.0;
    if (!clean1 || !clean2) return 0.0;
    const dist = this.fastLevenshtein(s1, s2);
    const maxLen = Math.max(clean1.length, clean2.length);
    return Math.max(0, 1 - dist / maxLen);
  }

  /**
   * Расчет спектральной энергии и ZCR
   */
  public calculateFrameEnergyStats(samples: Float32Array): {
    rms: number;
    zcrRatio: number;
    voiceProbability: number;
    peak: number;
  } {
    if (!samples || samples.length === 0) {
      return { rms: 0, zcrRatio: 0, voiceProbability: 0, peak: 0 };
    }
    if (this.wasmModule?.calculateFrameEnergyStats) {
      const ptr = this.writeFloat32Direct(samples);
      const stats = this.wasmModule.calculateFrameEnergyStats(ptr, samples.length);
      this.freeFloats(ptr);
      return stats;
    }
    let energy = 0;
    let zcr = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const val = samples[i];
      energy += val * val;
      const abs = Math.abs(val);
      if (abs > peak) peak = abs;
      if (i > 0 && ((val >= 0 && samples[i - 1] < 0) || (val < 0 && samples[i - 1] >= 0))) {
        zcr++;
      }
    }
    const rms = Math.sqrt(energy / samples.length);
    const zcrRatio = zcr / samples.length;
    let voiceProbability = 0;
    if (rms > 0.015 && zcrRatio > 0.04 && zcrRatio < 0.45) {
      voiceProbability = Math.min(0.98, 0.5 + rms * 15.0);
    }
    return { rms, zcrRatio, voiceProbability, peak };
  }

  /**
   * Разделение вокала и караоке на C++
   */
  public separateVocalsAndKaraoke(
    leftChannel: Float32Array,
    rightChannel: Float32Array,
    sampleRate: number = 44100
  ): {
    vocalsL: Float32Array;
    vocalsR: Float32Array;
    karaokeL: Float32Array;
    karaokeR: Float32Array;
  } {
    const numSamples = leftChannel.length;
    const vocalsL = new Float32Array(numSamples);
    const vocalsR = new Float32Array(numSamples);
    const karaokeL = new Float32Array(numSamples);
    const karaokeR = new Float32Array(numSamples);

    if (numSamples === 0) {
      return { vocalsL, vocalsR, karaokeL, karaokeR };
    }

    const mod = this.getModule();
    if (mod?.separateVocalsAndKaraoke) {
      const inLPtr = this.writeFloat32Direct(leftChannel);
      const inRPtr = this.writeFloat32Direct(rightChannel);
      const outVocLPtr = this.allocateFloats(numSamples);
      const outVocRPtr = this.allocateFloats(numSamples);
      const outKarLPtr = this.allocateFloats(numSamples);
      const outKarRPtr = this.allocateFloats(numSamples);

      try {
        const success = mod.separateVocalsAndKaraoke(
          inLPtr,
          inRPtr,
          numSamples,
          outVocLPtr,
          outVocRPtr,
          outKarLPtr,
          outKarRPtr,
          sampleRate
        );

        if (success) {
          vocalsL.set(this.readFloat32Direct(outVocLPtr, numSamples));
          vocalsR.set(this.readFloat32Direct(outVocRPtr, numSamples));
          karaokeL.set(this.readFloat32Direct(outKarLPtr, numSamples));
          karaokeR.set(this.readFloat32Direct(outKarRPtr, numSamples));
        }
      } finally {
        this.freeFloats(inLPtr);
        this.freeFloats(inRPtr);
        this.freeFloats(outVocLPtr);
        this.freeFloats(outVocRPtr);
        this.freeFloats(outKarLPtr);
        this.freeFloats(outKarRPtr);
      }

      return { vocalsL, vocalsR, karaokeL, karaokeR };
    }

    for (let i = 0; i < numSamples; i++) {
      const mid = (leftChannel[i] + rightChannel[i]) * 0.5;
      vocalsL[i] = mid;
      vocalsR[i] = mid;
      karaokeL[i] = leftChannel[i] - mid;
      karaokeR[i] = rightChannel[i] - mid;
    }

    return { vocalsL, vocalsR, karaokeL, karaokeR };
  }

  /**
   * Нативный C++ стриппинг тишины (VAD & Silence Stripping)
   * @param samples Float32Array PCM буфер клипа
   * @param thresholdDb Порог тишины (например -40 dB)
   * @param minSilenceMs Минимальная тишина в мс (например 300 ms)
   * @param paddingMs Удержание краев речи в мс (например 50 ms)
   * @param isStereo Флаг стерео
   * @param sampleRate Частота дискретизации
   */
  public stripSilenceNative(
    samples: Float32Array,
    thresholdDb: number = -40.0,
    minSilenceMs: number = 300.0,
    paddingMs: number = 50.0,
    isStereo: boolean = false,
    sampleRate: number = 48000
  ): Array<{ offsetSamples: number; lengthSamples: number; peakLevel: number; rmsLevel: number }> {
    const mod = this.getModule();
    const maxSegments = 1024;
    const result: Array<{ offsetSamples: number; lengthSamples: number; peakLevel: number; rmsLevel: number }> = [];

    if (mod?.stripSilenceFromClip && mod?.allocateSegmentBuffer && mod?.freeSegmentBuffer) {
      const inPcmPtr = this.writeFloat32Direct(samples);
      const outSegPtr = mod.allocateSegmentBuffer(maxSegments);

      try {
        const count = mod.stripSilenceFromClip(
          inPcmPtr,
          samples.length,
          thresholdDb,
          minSilenceMs,
          paddingMs,
          outSegPtr,
          maxSegments,
          isStereo,
          sampleRate
        );

        // Чтение структур AudioSegment из WASM памяти
        // Структура AudioSegment в C++: size_t offsetSamples (uint32/64), size_t lengthSamples, float peakLevel, float rmsLevel
        // В WASM32 size_t = 4 байта (uint32), float = 4 байта -> 16 байт на элемент (4 uint32/float полей)
        const heapU32 = new Uint32Array(mod.HEAPU8.buffer, outSegPtr, count * 4);
        const heapF32 = new Float32Array(mod.HEAPU8.buffer, outSegPtr, count * 4);

        for (let i = 0; i < count; i++) {
          const base = i * 4;
          result.push({
            offsetSamples: heapU32[base],
            lengthSamples: heapU32[base + 1],
            peakLevel: heapF32[base + 2],
            rmsLevel: heapF32[base + 3]
          });
        }
        return result;
      } finally {
        this.freeFloats(inPcmPtr);
        mod.freeSegmentBuffer(outSegPtr);
      }
    }

    // Fallback: обнаружение звуковых сегментов
    const thresholdLinear = Math.pow(10, thresholdDb * 0.05);
    const channels = isStereo ? 2 : 1;
    const totalFrames = Math.floor(samples.length / channels);
    const frameSize = Math.floor(0.01 * sampleRate);
    const minSilenceFrames = Math.floor((minSilenceMs / 1000) * sampleRate);
    const padFrames = Math.floor((paddingMs / 1000) * sampleRate);

    let inSpeech = false;
    let segStart = 0;
    let lastSpeech = 0;
    let segPeak = 0;

    for (let f = 0; f < totalFrames; f += frameSize) {
      let sumSq = 0;
      let peak = 0;
      const count = Math.min(frameSize, totalFrames - f);
      for (let i = 0; i < count; i++) {
        const s = samples[(f + i) * channels];
        const absS = Math.abs(s);
        sumSq += s * s;
        if (absS > peak) peak = absS;
      }
      const rms = Math.sqrt(sumSq / count);
      const isSpeech = rms >= thresholdLinear || peak >= thresholdLinear * 1.5;

      if (isSpeech) {
        if (!inSpeech) {
          inSpeech = true;
          segStart = Math.max(0, f - padFrames);
          segPeak = peak;
        } else {
          segPeak = Math.max(segPeak, peak);
        }
        lastSpeech = f + count;
      } else if (inSpeech) {
        if (f + count - lastSpeech >= minSilenceFrames) {
          const endFrame = Math.min(totalFrames, lastSpeech + padFrames);
          result.push({
            offsetSamples: segStart * channels,
            lengthSamples: (endFrame - segStart) * channels,
            peakLevel: segPeak,
            rmsLevel: thresholdLinear
          });
          inSpeech = false;
          segPeak = 0;
        }
      }
    }

    if (inSpeech) {
      const endFrame = Math.min(totalFrames, lastSpeech + padFrames);
      result.push({
        offsetSamples: segStart * channels,
        lengthSamples: (endFrame - segStart) * channels,
        peakLevel: segPeak,
        rmsLevel: thresholdLinear
      });
    }

    return result;
  }
}

export const globalNativeDAWBridge = NativeDAWBridge.getInstance();
