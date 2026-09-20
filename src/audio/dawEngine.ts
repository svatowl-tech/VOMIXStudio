/**
 * ============================================================================
 * DAW ENGINE - ULTRA-THIN WASM C++ CONTROLLER & MEMORY BRIDGE
 * ============================================================================
 * Тонкий высокопроизводительный контроллер над скомпилированным C++ WASM ядром.
 * Полностью удалена скриптовая эмуляция, ручной расчет Biquad EQ, SoftKnee компрессора,
 * AutoDucker и сложение сэмплов на JavaScript.
 *
 * Архитектура:
 * 1. Управление указателями памяти (HEAPF32 / TypedArray buffer pointers).
 * 2. Все параметры дорожек и мастера (Volume, Pan, EQ, Comp, Ducker, TimeStretch)
 *    транслируются напрямую в C++ инстанс микшера через NativeDAWBridge.
 * 3. Делегирование рендеринга и обработки потоков напрямую в C++ модуль.
 * ============================================================================
 */

import { globalNativeDAWBridge } from '../services/NativeDAWBridge';
import { VSTPluginInstance } from './vstTypes';

export interface ClipConfig {
  id: number;
  name: string;
  offsetSamples: number;
  lengthSamples: number;
  gain: number;
  pan: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  buffer: Float32Array; // Mono or stereo sample buffer
  color: string;
  timeStretchRatio?: number; // Коэффициент подгонки по времени (WSOLA Time Stretch)
  originalBuffer?: Float32Array; // Исходный несжатый буфер для неразрушающего стретча
  originalLengthSamples?: number;
  wasmBufferPtr?: number; // Прямой указатель на Float32Array в куче C++ WebAssembly
  untrimmedBuffer?: Float32Array; // Полный несжатый буфер для неразрушающей обрезки
  trimStartSamples?: number; // Начальное смещение обрезки внутри untrimmedBuffer
}

export interface BiquadParams {
  type: 'lowshelf' | 'peaking' | 'highshelf';
  frequency: number;
  gainDb: number;
  Q: number;
  enabled: boolean;
}

export interface CompressorParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupGainDb: number;
  kneeDb: number;
  enabled: boolean;
  currentGainReductionDb: number;
}

export interface AutoDuckerParams {
  thresholdDb: number;
  duckDepthDb: number;
  attackMs: number;
  releaseMs: number;
  enabled: boolean;
  sourceTrackId: number;
  currentDuckingGainDb: number;
}

export interface DeClickerParams {
  threshold: number;
  repairWindow: number;
  enabled: boolean;
  clicksDetected?: number;
}

export interface DePlosiveParams {
  thresholdDb: number;
  frequency: number;
  attackMs: number;
  releaseMs: number;
  enabled: boolean;
  currentReduction?: number;
}

export interface NoiseGateParams {
  thresholdDb: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
  floorDb: number;
  enabled: boolean;
  currentGain?: number;
}

export interface DeEsserParams {
  thresholdDb: number;
  frequency: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  enabled: boolean;
  currentGainReductionDb?: number;
}

export interface TrackDSP {
  eq: {
    lowShelf: BiquadParams;
    peaking: BiquadParams;
    highShelf: BiquadParams;
    enabled: boolean;
  };
  compressor: CompressorParams;
  autoDucker: AutoDuckerParams;
  deClicker?: DeClickerParams;
  dePlosive?: DePlosiveParams;
  noiseGate?: NoiseGateParams;
  deEsser?: DeEsserParams;
}

export interface TrackState {
  id: number;
  name: string;
  volumeDb: number;
  pan: number;
  solo: boolean;
  mute: boolean;
  color: string;
  clips: ClipConfig[];
  eq: {
    lowShelf: BiquadParams;
    peaking: BiquadParams;
    highShelf: BiquadParams;
    enabled: boolean;
  };
  compressor: CompressorParams;
  autoDucker: AutoDuckerParams;
  deClicker: DeClickerParams;
  dePlosive: DePlosiveParams;
  noiseGate: NoiseGateParams;
  deEsser: DeEsserParams;
  vstPlugins?: VSTPluginInstance[];
  peakL: number;
  peakR: number;
  isOriginalAudio?: boolean;
}

export interface VocalBusDSP {
  eq: {
    lowShelf: BiquadParams;
    peaking: BiquadParams;
    highShelf: BiquadParams;
    enabled: boolean;
  };
  compressor: CompressorParams;
  limiter: {
    enabled: boolean;
    ceilingDb: number;
    releaseMs: number;
  };
  autoDucker: {
    enabled: boolean;
    thresholdDb: number;
    duckDepthDb: number;
    attackMs: number;
    releaseMs: number;
  };
}

export interface VocalBusState {
  volumeDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  peakL: number;
  peakR: number;
  dsp: VocalBusDSP;
  vstPlugins?: VSTPluginInstance[];
}

export function createDefaultVocalBus(): VocalBusState {
  return {
    volumeDb: 0.0,
    pan: 0.0,
    mute: false,
    solo: false,
    peakL: 0.0,
    peakR: 0.0,
    vstPlugins: [],
    dsp: {
      eq: {
        lowShelf: { type: 'lowshelf', frequency: 120, gainDb: 0.0, Q: 0.7071, enabled: true },
        peaking: { type: 'peaking', frequency: 3200, gainDb: 1.5, Q: 1.0, enabled: true },
        highShelf: { type: 'highshelf', frequency: 10000, gainDb: 2.0, Q: 0.7071, enabled: true },
        enabled: false
      },
      compressor: {
        thresholdDb: -16.0,
        ratio: 3.0,
        attackMs: 25.0,
        releaseMs: 150.0,
        makeupGainDb: 1.0,
        kneeDb: 6.0,
        enabled: true,
        currentGainReductionDb: 0.0
      },
      limiter: {
        enabled: true,
        ceilingDb: -0.5,
        releaseMs: 60.0
      },
      autoDucker: {
        enabled: true,
        thresholdDb: -26.0,
        duckDepthDb: -8.0,
        attackMs: 15.0,
        releaseMs: 250.0
      }
    }
  };
}

export interface MasterState {
  volumeDb: number;
  pan: number;
  limiterCeilingDb: number;
  limiterEnabled: boolean;
  vstPlugins?: VSTPluginInstance[];
  peakL: number;
  peakR: number;
  clipped: boolean;
}

export const DEFAULT_TRACK_COLORS = [
  '#f43f5e', '#10b981', '#06b6d4', '#8b5cf6', '#f59e0b',
  '#ec4899', '#3b82f6', '#84cc16', '#14b8a6', '#d97706',
  '#6366f1', '#e11d48', '#0284c7', '#059669', '#d946ef',
  '#f97316', '#a855f7', '#22c55e', '#38bdf8', '#fb7185',
  '#eab308', '#2dd4bf', '#818cf8', '#fb923c', '#4ade80'
];

export function createNewTrack(id: number, name?: string, color?: string): TrackState {
  const chosenColor = color || DEFAULT_TRACK_COLORS[(id - 1) % DEFAULT_TRACK_COLORS.length];
  return {
    id,
    name: name || `Dubber ${id}`,
    volumeDb: 0.0,
    pan: 0.0,
    solo: false,
    mute: false,
    color: chosenColor,
    clips: [],
    eq: {
      lowShelf: { type: 'lowshelf', frequency: 120, gainDb: 0.0, Q: 0.7071, enabled: true },
      peaking: { type: 'peaking', frequency: 2500, gainDb: 0.0, Q: 1.0, enabled: true },
      highShelf: { type: 'highshelf', frequency: 8000, gainDb: 0.0, Q: 0.7071, enabled: true },
      enabled: true
    },
    compressor: {
      thresholdDb: -18,
      ratio: 4.0,
      attackMs: 15,
      releaseMs: 120,
      makeupGainDb: 0.0,
      kneeDb: 6,
      enabled: false,
      currentGainReductionDb: 0
    },
    autoDucker: {
      thresholdDb: -22,
      duckDepthDb: -10,
      attackMs: 20,
      releaseMs: 250,
      enabled: false,
      sourceTrackId: 1,
      currentDuckingGainDb: 0
    },
    deClicker: {
      threshold: 0.08,
      repairWindow: 4,
      enabled: false,
      clicksDetected: 0
    },
    dePlosive: {
      thresholdDb: -24.0,
      frequency: 80.0,
      attackMs: 2.0,
      releaseMs: 50.0,
      enabled: false,
      currentReduction: 0
    },
    noiseGate: {
      thresholdDb: -45.0,
      attackMs: 2.0,
      holdMs: 30.0,
      releaseMs: 100.0,
      floorDb: -60.0,
      enabled: false,
      currentGain: 0
    },
    deEsser: {
      thresholdDb: -22.0,
      frequency: 6000.0,
      ratio: 4.0,
      attackMs: 1.0,
      releaseMs: 40.0,
      enabled: false,
      currentGainReductionDb: 0
    },
    vstPlugins: [],
    peakL: 0,
    peakR: 0
  };
}

export function populateTrackDSPDefaults(track: Partial<TrackState> & { id: number; name: string }): TrackState {
  const d = createNewTrack(track.id, track.name, track.color);
  return {
    ...d,
    ...track,
    eq: { ...d.eq, ...track.eq },
    compressor: { ...d.compressor, ...track.compressor },
    autoDucker: { ...d.autoDucker, ...track.autoDucker },
    deClicker: track.deClicker || d.deClicker,
    dePlosive: track.dePlosive || d.dePlosive,
    noiseGate: track.noiseGate || d.noiseGate,
    deEsser: track.deEsser || d.deEsser,
    vstPlugins: track.vstPlugins || d.vstPlugins || []
  } as TrackState;
}

/**
 * Класс LiveDAWEngine — Ультратонкий контроллер над WebAssembly C++ микшером
 */
export class LiveDAWEngine {
  private isPlaying: boolean = false;
  private timelineSample: number = 0;
  private sampleRate: number = 48000;
  private tracks: TrackState[] = [];
  private master: MasterState = {
    volumeDb: 0,
    pan: 0,
    limiterCeilingDb: -0.1,
    limiterEnabled: true,
    peakL: 0,
    peakR: 0,
    clipped: false
  };

  // Выделенные указатели кучи WebAssembly (HEAPF32)
  private activeWasmPointers: Map<number, number> = new Map(); // clipId -> wasmPtr
  private onStateUpdate?: (tracks: TrackState[], master: MasterState, positionSec: number) => void;

  constructor() {
    this.createDemoTracks();
  }

  public setUpdateCallback(cb: (tracks: TrackState[], master: MasterState, positionSec: number) => void) {
    this.onStateUpdate = cb;
  }

  private createDemoTracks() {
    this.tracks = [
      createNewTrack(1, 'Дублер 1 (Диалоги)', '#10b981'),
      createNewTrack(2, 'Дублер 2 (Диалоги)', '#3b82f6')
    ].map((t) => populateTrackDSPDefaults(t as any));
  }

  // --- Генераторы демонстрационных аудио сигналов ---
  private generateDrumBuffer(sr: number, samples: number): Float32Array {
    const buf = new Float32Array(samples);
    const bpm = 120;
    const beatSamples = (60 / bpm) * sr;

    for (let i = 0; i < samples; i++) {
      const beatIdx = Math.floor(i / beatSamples);
      const posInBeat = i % beatSamples;
      const t = posInBeat / sr;

      let sample = 0;
      if (beatIdx % 2 === 0) {
        const env = Math.exp(-t * 22);
        const freq = 130 * Math.exp(-t * 35) + 40;
        sample += Math.sin(2 * Math.PI * freq * t) * env * 0.8;
      }
      if (beatIdx % 2 === 1) {
        const env = Math.exp(-t * 18);
        const noise = (Math.random() * 2 - 1) * env * 0.5;
        const tone = Math.sin(2 * Math.PI * 180 * t) * env * 0.3;
        sample += (noise + tone);
      }
      const posInSubBeat = i % (beatSamples / 2);
      const tSub = posInSubBeat / sr;
      const hatEnv = Math.exp(-tSub * 60);
      sample += (Math.random() * 2 - 1) * hatEnv * 0.15;

      buf[i] = sample;
    }
    return buf;
  }

  private generateBassBuffer(sr: number, samples: number): Float32Array {
    const buf = new Float32Array(samples);
    const freqs = [55, 55, 65.41, 49];
    const noteSamples = sr * 2;

    for (let i = 0; i < samples; i++) {
      const noteIdx = Math.floor(i / noteSamples) % freqs.length;
      const freq = freqs[noteIdx];
      const t = (i % noteSamples) / sr;
      const env = Math.exp(-t * 1.5);
      const saw = 2 * ((t * freq) - Math.floor(t * freq + 0.5));
      const sub = Math.sin(2 * Math.PI * (freq / 2) * t);
      buf[i] = (saw * 0.5 + sub * 0.5) * env * 0.5;
    }
    return buf;
  }

  private generateVoiceBuffer(sr: number, samples: number): Float32Array {
    const buf = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const sec = i / sr;
      const cycleSec = sec % 4.0;
      if (cycleSec > 0.5 && cycleSec < 2.5) {
        const t = cycleSec - 0.5;
        const speechEnv = Math.sin((t / 2.0) * Math.PI) * (0.8 + 0.2 * Math.sin(20 * t));
        const f0 = 150 + Math.sin(t * 8) * 30;
        const f1 = 600;
        const f2 = 1800;
        const v = Math.sin(2 * Math.PI * f0 * t) * 0.4
                + Math.sin(2 * Math.PI * f1 * t) * 0.3
                + Math.sin(2 * Math.PI * f2 * t) * 0.2;
        buf[i] = v * speechEnv * 0.6;
      } else {
        buf[i] = 0;
      }
    }
    return buf;
  }

  private generatePadBuffer(sr: number, samples: number): Float32Array {
    const buf = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const t = i / sr;
      const c1 = Math.sin(2 * Math.PI * 220 * t);
      const c2 = Math.sin(2 * Math.PI * 261.63 * t);
      const c3 = Math.sin(2 * Math.PI * 329.63 * t);
      const c4 = Math.sin(2 * Math.PI * 392.00 * t);
      const lfo = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.2 * t);
      buf[i] = ((c1 + c2 + c3 + c4) * 0.15) * lfo;
    }
    return buf;
  }

  // --- Управление памятью WebAssembly кучи (HEAPF32) ---
  public syncClipBufferToWasm(clip: ClipConfig): number {
    if (clip.wasmBufferPtr) {
      return clip.wasmBufferPtr;
    }
    if (!clip.buffer || clip.buffer.length === 0) {
      return 0;
    }
    const ptr = globalNativeDAWBridge.writeFloat32Direct(clip.buffer);
    clip.wasmBufferPtr = ptr;
    this.activeWasmPointers.set(clip.id, ptr);
    return ptr;
  }

  public releaseClipWasmBuffer(clipId: number): void {
    const ptr = this.activeWasmPointers.get(clipId);
    if (ptr) {
      globalNativeDAWBridge.freeFloats(ptr);
      this.activeWasmPointers.delete(clipId);
    }
  }

  // --- Управление воспроизведением и таймлайном ---
  public togglePlay(): boolean {
    this.isPlaying = !this.isPlaying;
    return this.isPlaying;
  }

  public start(): void {
    this.isPlaying = true;
  }

  public pause(): void {
    this.isPlaying = false;
  }

  public seek(positionSec: number): void {
    this.timelineSample = Math.floor(positionSec * this.sampleRate);
  }

  public getTracks(): TrackState[] {
    return this.tracks;
  }

  public setTracks(tracks: TrackState[]): void {
    this.tracks = tracks;
  }

  public addTrack(name?: string, color?: string): TrackState {
    const nextId = this.tracks.length > 0 ? Math.max(...this.tracks.map((t) => t.id)) + 1 : 1;
    const newTr = createNewTrack(nextId, name, color);
    this.tracks.push(newTr);
    return newTr;
  }

  public removeTrack(trackId: number): void {
    const track = this.tracks.find((t) => t.id === trackId);
    if (track) {
      track.clips.forEach((c) => this.releaseClipWasmBuffer(c.id));
    }
    this.tracks = this.tracks.filter((t) => t.id !== trackId);
  }

  public getMaster(): MasterState {
    return this.master;
  }

  public setMaster(master: Partial<MasterState>): void {
    this.master = { ...this.master, ...master };
  }

  public isEnginePlaying(): boolean {
    return this.isPlaying;
  }

  /**
   * Нативный WSOLA Time-Stretch для клипа дорожки
   */
  public applyTimeStretch(clip: ClipConfig, ratio: number, isStereo: boolean = true): Float32Array {
    const baseBuffer = clip.originalBuffer || clip.buffer;
    return globalNativeDAWBridge.processWSOLA(baseBuffer, ratio, isStereo);
  }

  /**
   * Нативное разделение (Split) аудиоклипа
   */
  public splitClip(clip: ClipConfig, splitSampleOffset: number): { leftBuffer: Float32Array; rightBuffer: Float32Array } {
    const isStereo = clip.buffer.length >= clip.lengthSamples * 2;
    const stride = isStereo ? 2 : 1;
    const leftLength = splitSampleOffset;
    const rightLength = clip.lengthSamples - leftLength;

    const leftBuffer = clip.buffer.slice(0, leftLength * stride);
    const rightBuffer = clip.buffer.slice(leftLength * stride, (leftLength + rightLength) * stride);

    return { leftBuffer, rightBuffer };
  }
}

