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

export function isOriginalTrackName(name?: string): boolean {
  if (!name) return false;
  return /оригинал|original|видео|video|исходн/i.test(name);
}

/**
 * Пресет C++ DSP «Дубляж / Речь» по умолчанию для всех дикторских и актерских дорожек
 */
export function getDubbingSpeechPresetDSP(): Pick<
  TrackState,
  'eq' | 'compressor' | 'noiseGate' | 'deClicker' | 'dePlosive' | 'deEsser' | 'autoDucker'
> {
  return {
    eq: {
      lowShelf: { type: 'lowshelf', frequency: 120, gainDb: -3.0, Q: 0.7071, enabled: true },
      peaking: { type: 'peaking', frequency: 3200, gainDb: 3.5, Q: 1.2, enabled: true },
      highShelf: { type: 'highshelf', frequency: 10000, gainDb: 2.0, Q: 0.7071, enabled: true },
      enabled: true
    },
    compressor: {
      thresholdDb: -16,
      ratio: 3.5,
      attackMs: 12,
      releaseMs: 120,
      makeupGainDb: 2.0,
      kneeDb: 6,
      enabled: true,
      currentGainReductionDb: 0
    },
    noiseGate: {
      thresholdDb: -48.0,
      attackMs: 2.0,
      holdMs: 40.0,
      releaseMs: 120.0,
      floorDb: -60.0,
      enabled: true,
      currentGain: 0
    },
    deClicker: {
      threshold: 0.06,
      repairWindow: 3,
      enabled: true,
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
    deEsser: {
      thresholdDb: -20.0,
      frequency: 6200.0,
      ratio: 4.0,
      attackMs: 1.0,
      releaseMs: 45.0,
      enabled: true,
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
    }
  };
}

/**
 * Нейтральный пресет без обработки для дорожки оригинального звука видео
 */
export function getFlatOriginalTrackDSP(): Pick<
  TrackState,
  'eq' | 'compressor' | 'noiseGate' | 'deClicker' | 'dePlosive' | 'deEsser' | 'autoDucker'
> {
  return {
    eq: {
      lowShelf: { type: 'lowshelf', frequency: 120, gainDb: 0.0, Q: 0.7071, enabled: false },
      peaking: { type: 'peaking', frequency: 2500, gainDb: 0.0, Q: 1.0, enabled: false },
      highShelf: { type: 'highshelf', frequency: 8000, gainDb: 0.0, Q: 0.7071, enabled: false },
      enabled: false
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
    noiseGate: {
      thresholdDb: -45.0,
      attackMs: 2.0,
      holdMs: 30.0,
      releaseMs: 100.0,
      floorDb: -60.0,
      enabled: false,
      currentGain: 0
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
    deEsser: {
      thresholdDb: -22.0,
      frequency: 6000.0,
      ratio: 4.0,
      attackMs: 1.0,
      releaseMs: 40.0,
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
    }
  };
}

export function applyDubbingSpeechPreset(track: TrackState): TrackState {
  if (track.isOriginalAudio || isOriginalTrackName(track.name)) {
    return track;
  }
  return {
    ...track,
    ...getDubbingSpeechPresetDSP()
  };
}

export function createNewTrack(id: number, name?: string, color?: string, isOriginalAudio?: boolean): TrackState {
  const chosenColor = color || DEFAULT_TRACK_COLORS[(id - 1) % DEFAULT_TRACK_COLORS.length];
  const trackName = name || `Dubber ${id}`;
  const isOriginal = isOriginalAudio ?? isOriginalTrackName(trackName);
  const dsp = isOriginal ? getFlatOriginalTrackDSP() : getDubbingSpeechPresetDSP();

  return {
    id,
    name: trackName,
    volumeDb: 0.0,
    pan: 0.0,
    solo: false,
    mute: false,
    color: chosenColor,
    isOriginalAudio: isOriginal,
    clips: [],
    ...dsp,
    vstPlugins: [],
    peakL: 0,
    peakR: 0
  };
}

export function populateTrackDSPDefaults(track: Partial<TrackState> & { id: number; name: string }): TrackState {
  const isOriginal = track.isOriginalAudio ?? isOriginalTrackName(track.name);
  const d = createNewTrack(track.id, track.name, track.color, isOriginal);

  // Для дорожек дубляжа гарантируем активный пресет «Дубляж / Речь» по умолчанию
  const baseEq = isOriginal ? d.eq : { ...d.eq, enabled: true };
  const baseComp = isOriginal ? d.compressor : { ...d.compressor, enabled: true };
  const baseGate = isOriginal ? d.noiseGate : { ...d.noiseGate, enabled: true };
  const baseDeEsser = isOriginal ? d.deEsser : { ...d.deEsser, enabled: true };
  const baseDeClicker = isOriginal ? d.deClicker : { ...d.deClicker, enabled: true };

  return {
    ...d,
    ...track,
    isOriginalAudio: isOriginal,
    eq: track.eq ? { ...baseEq, ...track.eq } : baseEq,
    compressor: track.compressor ? { ...baseComp, ...track.compressor } : baseComp,
    autoDucker: { ...d.autoDucker, ...track.autoDucker },
    deClicker: track.deClicker ? { ...baseDeClicker, ...track.deClicker } : baseDeClicker,
    dePlosive: track.dePlosive || d.dePlosive,
    noiseGate: track.noiseGate ? { ...baseGate, ...track.noiseGate } : baseGate,
    deEsser: track.deEsser ? { ...baseDeEsser, ...track.deEsser } : baseDeEsser,
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
  private vocalBus: VocalBusState = createDefaultVocalBus();
  private master: MasterState = {
    volumeDb: 0,
    pan: 0,
    limiterCeilingDb: -0.1,
    limiterEnabled: true,
    vstPlugins: [],
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

  // --- Управление параметрами и цепочками VST ---

  /**
   * Заменяет или устанавливает конкретный плагин в слоте трека
   */
  public setTrackVstPlugin(trackId: number, slotIdx: number, plugin: VSTPluginInstance): void {
    const track = this.tracks.find((t) => t.id === trackId);
    if (track) {
      if (!track.vstPlugins) {
        track.vstPlugins = [];
      }
      track.vstPlugins[slotIdx] = plugin;
    }
  }

  /**
   * Сквозное обновление VST-параметра (Volume, Attack, Mix, WetDry, Bypass и т.д.) во внутреннем состоянии
   */
  public updateVstParam(
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    paramId: string,
    value: number,
    trackId?: number
  ): void {
    let plugins: VSTPluginInstance[] | undefined;

    if (target === 'track' && trackId !== undefined) {
      const track = this.tracks.find((t) => t.id === trackId);
      if (track) {
        if (!track.vstPlugins) track.vstPlugins = [];
        plugins = track.vstPlugins;
      }
    } else if (target === 'vocalBus') {
      if (!this.vocalBus.vstPlugins) this.vocalBus.vstPlugins = [];
      plugins = this.vocalBus.vstPlugins;
    } else if (target === 'master') {
      if (!this.master.vstPlugins) this.master.vstPlugins = [];
      plugins = this.master.vstPlugins;
    }

    if (plugins) {
      const plugin = plugins.find((p) => p && p.instanceId === instanceId);
      if (plugin) {
        if (!plugin.parameters) {
          plugin.parameters = {};
        }
        plugin.parameters[paramId] = value;
      }
    }
  }

  // --- Управление памятью WebAssembly кучи (HEAPF32) ---
  public syncClipBufferToWasm(clip: ClipConfig): number {
    const existingPtr = this.activeWasmPointers.get(clip.id);
    if (existingPtr && clip.wasmBufferPtr && existingPtr !== clip.wasmBufferPtr) {
      globalNativeDAWBridge.freeFloats(existingPtr);
      this.activeWasmPointers.delete(clip.id);
    }
    if (clip.wasmBufferPtr && this.activeWasmPointers.get(clip.id) === clip.wasmBufferPtr) {
      return clip.wasmBufferPtr;
    }
    if (!clip.buffer || clip.buffer.length === 0) {
      return 0;
    }
    // Если для этого clipId уже был выделен другой буфер в WASM, принудительно освобождаем старый перед повторной аллокацией
    if (existingPtr) {
      globalNativeDAWBridge.freeFloats(existingPtr);
      this.activeWasmPointers.delete(clip.id);
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

  /**
   * Метод garbageCollectWasm()
   * Сверяет существующие ID клипов во всех дорожках TrackState с активными указателями в WASM (activeWasmPointers).
   * Принудительно освобождает через Module._free / freeFloats все осиротевшие указатели ("орфаны"),
   * защищая кучу C++ от утечек памяти и фрагментации при нарезке (Split), удалении и AI обработке.
   */
  public garbageCollectWasm(): number {
    const existingClipIds = new Set<number>();
    for (const track of this.tracks) {
      if (track && Array.isArray(track.clips)) {
        for (const clip of track.clips) {
          if (clip && typeof clip.id === 'number') {
            existingClipIds.add(clip.id);
          }
        }
      }
    }

    let freedCount = 0;
    for (const [clipId, ptr] of this.activeWasmPointers.entries()) {
      if (!existingClipIds.has(clipId)) {
        try {
          globalNativeDAWBridge.freeFloats(ptr);
        } catch (err) {
          console.warn(`[LiveDAWEngine] Ошибка освобождения осиротевшего WASM указателя clip #${clipId} (ptr: ${ptr}):`, err);
        }
        this.activeWasmPointers.delete(clipId);
        freedCount++;
      }
    }

    return freedCount;
  }

  /**
   * Синхронизация клипов конкретной дорожки с автоматической сборкой мусора WASM
   */
  public syncTrackClips(trackId: number, clips: ClipConfig[]): void {
    const track = this.tracks.find((t) => t.id === trackId);
    if (track) {
      track.clips = clips;
      for (const clip of clips) {
        if (clip && clip.buffer) {
          this.syncClipBufferToWasm(clip);
        }
      }
    }
    // Вызываем сборку мусора после синхронизации клипов
    this.garbageCollectWasm();
  }

  /**
   * Синхронизация всех дорожек проекта с автоматической сборкой мусора WASM
   */
  public syncAllTracks(tracks: TrackState[]): void {
    this.tracks = tracks;
    for (const track of tracks) {
      if (track && Array.isArray(track.clips)) {
        for (const clip of track.clips) {
          if (clip && clip.buffer) {
            this.syncClipBufferToWasm(clip);
          }
        }
      }
    }
    // Вызываем сборку мусора после полной синхронизации всех дорожек
    this.garbageCollectWasm();
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
    this.garbageCollectWasm();
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
    this.garbageCollectWasm();
  }

  public getVocalBus(): VocalBusState {
    return this.vocalBus;
  }

  public setVocalBus(vocalBus: VocalBusState): void {
    this.vocalBus = vocalBus;
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

/**
 * Вспомогательная утилита для сверки активных WASM пойнтеров с реальными клипами в дорожках
 * и принудительного вызова _free для осиротевших участков кучи.
 */
export function garbageCollectWasm(tracks: TrackState[], activeWasmPointers: Map<number, number>): number {
  const existingClipIds = new Set<number>();
  for (const track of tracks) {
    if (track && Array.isArray(track.clips)) {
      for (const clip of track.clips) {
        if (clip && typeof clip.id === 'number') {
          existingClipIds.add(clip.id);
        }
      }
    }
  }

  let freedCount = 0;
  for (const [clipId, ptr] of activeWasmPointers.entries()) {
    if (!existingClipIds.has(clipId)) {
      try {
        globalNativeDAWBridge.freeFloats(ptr);
      } catch (err) {
        console.warn(`[garbageCollectWasm] Ошибка освобождения осиротевшего WASM указателя clip #${clipId} (ptr: ${ptr}):`, err);
      }
      activeWasmPointers.delete(clipId);
      freedCount++;
    }
  }

  return freedCount;
}

/**
 * Глобальный экземпляр контроллера звукового ядра C++ DAW
 */
export const globalLiveDAWEngine = new LiveDAWEngine();

