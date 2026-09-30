/**
 * ============================================================================
 * useAudioEngine.ts - Промышленный хук управления звуковым ядром DAW
 * ============================================================================
 * Реализует стандарт Universal VST Contract:
 * 1. loadPluginToTrack(trackId, slotIdx, descriptor): Загрузка VST-плагина в слот дорожки.
 * 2. setPluginParameter(target, instanceId, paramId, value, trackId): Атомарная передача
 *    числового ID параметра и нормализованного float-значения (0.0 .. 1.0) в C++ структуру.
 * 3. savePluginChunk(instanceId): Экспорт полного бинарного/Base64 состояния параметров.
 * 4. Непрерывный мониторинг Plugin Delay Compensation (PDC) и телеметрии уровней.
 * ============================================================================
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { MediaNormalizer, LoudnessMatchingResult, TrackLoudnessAdjustment } from '../services/MediaNormalizer';
import { TrackState, ClipConfig, VocalBusState, globalLiveDAWEngine } from '../audio/dawEngine';
import { VSTPluginInstance, VSTPluginDescriptor } from '../audio/vstTypes';
import { systemLogger } from '../services/SystemLogger';
import { globalNativeDAWBridge } from '../services/NativeDAWBridge';
import { TauriNativeBridge } from '../services/TauriNativeBridge';
import { EMBEDDED_WASM_CORE_BASE64 } from '../data/embeddedWasmCore';
import { toSafeArray, toSafeMap } from '../utils/safeIterables';

export interface TrackMeterData {
  trackId: number;
  peakL: number;
  peakR: number;
  rms: number;
  clipped?: boolean;
  latencySamples?: number;
  pdcMs?: number;
}

export interface MasterMeterData {
  peakL: number;
  peakR: number;
  clipped: boolean;
  latencySamples?: number;
  pdcMs?: number;
}

export interface VocalBusMeterData {
  peakL: number;
  peakR: number;
  latencySamples?: number;
  pdcMs?: number;
}

export interface UseAudioEngineReturn {
  isInitialized: boolean;
  isPlaying: boolean;
  isAudioWorkletActive: boolean;
  currentTimeSec: number;
  error: string | null;
  trackMeters: Map<number, TrackMeterData>;
  vocalBusMeter: VocalBusMeterData;
  masterMeter: MasterMeterData;

  initAudioEngine: () => Promise<void>;
  togglePlay: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  seek: (timeSec: number) => void;

  uploadAudioFileToTrack: (
    file: File | Blob,
    trackId: number,
    clipId: number,
    offsetSec?: number
  ) => Promise<{ durationSec: number; samplesCount: number; pcmData: Float32Array }>;

  uploadRawPCMToTrack: (
    pcmFloat32: Float32Array,
    trackId: number,
    clipId: number,
    offsetSec?: number,
    gain?: number,
    pan?: number,
    isStereo?: boolean
  ) => void;

  uploadClipsBatchToTrack: (
    trackId: number,
    clips: ClipConfig[]
  ) => Promise<void>;

  syncTrackClips: (trackId: number, clips: ClipConfig[]) => void;
  syncAllTracks: (tracks: TrackState[]) => void;
  handleUpdateTrack: (updatedTrack: TrackState) => void;
  garbageCollectWasm: (currentTracks?: TrackState[]) => void;

  setTrackVolume: (trackId: number, volumeDb: number) => void;
  setTrackPan: (trackId: number, pan: number) => void;
  setTrackSolo: (trackId: number, solo: boolean) => void;
  setTrackMute: (trackId: number, mute: boolean) => void;

  setTrackDsp: (trackId: number, dsp: any) => void;
  setTrackEq: (trackId: number, eqParams: any) => void;
  setTrackCompressor: (trackId: number, compParams: any) => void;
  setTrackAutoDucker: (trackId: number, duckParams: any) => void;
  setTrackNoiseGate: (trackId: number, noiseGate: any) => void;
  setTrackDeEsser: (trackId: number, deEsser: any) => void;

  setVocalBus: (vocalBus: VocalBusState) => void;
  setVocalBusVolume: (volumeDb: number) => void;

  setMasterVolume: (volumeDb: number) => void;
  setMasterLimiter: (enabled: boolean, ceilingDb: number) => void;

  // ==========================================================================
  // Стандарт Universal VST Contract: Управление цепочками VST-плагинов
  // ==========================================================================
  loadPluginToTrack: (
    trackId: number,
    slotIdx: number,
    descriptor: VSTPluginDescriptor
  ) => Promise<void>;

  setPluginParameter: (
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    paramId: number,
    value: number,
    trackId?: number
  ) => void;

  savePluginChunk: (instanceId: string) => Promise<string>;

  // Совместимые вспомогательные методы
  setTrackVstChain: (trackId: number, vstPlugins: VSTPluginInstance[]) => void;
  setVocalBusVstChain: (vstPlugins: VSTPluginInstance[]) => void;
  setMasterVstChain: (vstPlugins: VSTPluginInstance[]) => void;
  updateVstParameter: (
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    paramId: string | number,
    value: number,
    trackId?: number
  ) => void;
  setVstBypass: (
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    enabled: boolean,
    trackId?: number
  ) => void;
  setVstWetDry: (
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    wetDry: number,
    trackId?: number
  ) => void;

  performLoudnessMatching: (
    tracks: TrackState[],
    targetRmsDb?: number,
    maxPeakDb?: number
  ) => LoudnessMatchingResult;
}

/**
 * Вспомогательный статический маппинг строковых параметров в числовые ID для C++ ядра
 */
const getParamIdAsNumber = (paramName: string | number): number => {
  if (typeof paramName === 'number') return paramName;
  const parsed = parseInt(paramName, 10);
  if (!isNaN(parsed)) return parsed;

  switch (paramName) {
    // FabFilter Pro-Q3 (1..8)
    case 'hp_freq': return 1;
    case 'low_freq': return 2;
    case 'low_gain': return 3;
    case 'mid_freq': return 4;
    case 'mid_gain': return 5;
    case 'mid_q': return 6;
    case 'high_freq': return 7;
    case 'high_gain': return 8;

    // Waves Vocal Rider (1..4)
    case 'target':
    case 'target_db': return 1;
    case 'sensitivity':
    case 'range':
    case 'range_db': return 2;
    case 'speed':
    case 'attack_ms': return 3;

    // Waves CLA-76 Compressor (1..5)
    case 'input': return 1;
    case 'output': return 2;
    case 'ratio': return 3;
    case 'attack': return 4;
    case 'release': return 5;

    // FabFilter Pro-R Reverb (1..5)
    case 'decay': return 1;
    case 'mix': return 2;
    case 'predelay': return 3;
    case 'size': return 4;
    case 'brightness': return 5;

    // Xfer OTT (1..4)
    case 'depth': return 1;
    case 'time': return 2;
    case 'inGain': return 3;
    case 'outGain': return 4;

    // Saturation (1..2)
    case 'drive': return 1;

    default:
      return 0;
  }
};

// ============================================================================
// GLOBAL AUDIO ENGINE SINGLETON & MULTI-COMPONENT BROADCASTER
// ============================================================================
// Предотвращает дублирование AudioContext, утечки 2GB WASM-памяти и лаги от двух параллельных ядер
let globalAudioCtx: AudioContext | null = null;
let globalWorkletNode: AudioWorkletNode | null = null;
let globalInitPromise: Promise<void> | null = null;
let globalIsInitialized = false;
let globalIsPlaying = false;
let globalIsAudioWorkletActive = false;
let globalCurrentTimeSec = 0;
let globalError: string | null = null;

const globalTrackMeters = new Map<number, TrackMeterData>();
let globalVocalBusMeter: VocalBusMeterData = { peakL: 0, peakR: 0, latencySamples: 0, pdcMs: 0 };
let globalMasterMeter: MasterMeterData = { peakL: 0, peakR: 0, clipped: false, latencySamples: 0, pdcMs: 0 };

const globalSyncedClipIds = new Set<number>();
const globalClipWasmPtrs = new Map<number, number>();
const globalPendingPluginLoads = new Map<string, () => void>();
const globalPendingChunkRequests = new Map<string, (chunk: string) => void>();
const globalPendingClipAcks = new Map<number, () => void>();

type StateSubscriber = {
  setIsInitialized: (val: boolean) => void;
  setIsPlaying: (val: boolean) => void;
  setIsAudioWorkletActive: (val: boolean) => void;
  setCurrentTimeSec: (val: number) => void;
  setError: (val: string | null) => void;
  setTrackMeters: React.Dispatch<React.SetStateAction<Map<number, TrackMeterData>>>;
  setVocalBusMeter: React.Dispatch<React.SetStateAction<VocalBusMeterData>>;
  setMasterMeter: React.Dispatch<React.SetStateAction<MasterMeterData>>;
};
const globalSubscribers = new Set<StateSubscriber>();

function broadcastState(updater: (sub: StateSubscriber) => void) {
  for (const sub of globalSubscribers) {
    try {
      updater(sub);
    } catch (e) {
      console.warn('[useAudioEngine] Ошибка уведомления подписчика состояния:', e);
    }
  }
}

export const useAudioEngine = (): UseAudioEngineReturn => {
  const [isInitialized, setIsInitialized] = useState(globalIsInitialized);
  const [isPlaying, setIsPlaying] = useState(globalIsPlaying);
  const [isAudioWorkletActive, setIsAudioWorkletActive] = useState(globalIsAudioWorkletActive);
  const [currentTimeSec, setCurrentTimeSec] = useState(globalCurrentTimeSec);
  const [error, setError] = useState<string | null>(globalError);

  const [trackMeters, setTrackMeters] = useState<Map<number, TrackMeterData>>(() => new Map(globalTrackMeters));
  const [vocalBusMeter, setVocalBusMeter] = useState<VocalBusMeterData>(globalVocalBusMeter);
  const [masterMeter, setMasterMeter] = useState<MasterMeterData>(globalMasterMeter);

  // Подписка на глобальные события единственного аудиоядра
  useEffect(() => {
    const subscriber: StateSubscriber = {
      setIsInitialized,
      setIsPlaying,
      setIsAudioWorkletActive,
      setCurrentTimeSec,
      setError,
      setTrackMeters,
      setVocalBusMeter,
      setMasterMeter
    };
    globalSubscribers.add(subscriber);
    return () => {
      globalSubscribers.delete(subscriber);
    };
  }, []);

  const audioCtxRef = useRef<AudioContext | null>(globalAudioCtx);
  audioCtxRef.current = globalAudioCtx;
  const workletNodeRef = useRef<AudioWorkletNode | null>(globalWorkletNode);
  workletNodeRef.current = globalWorkletNode;
  const isInitializedRef = useRef<boolean>(globalIsInitialized);
  isInitializedRef.current = globalIsInitialized;

  // Согласование времени плейхеда без дрожания с помощью performance.now()
  const playheadStartPerfRef = useRef<number>(performance.now());
  const playheadStartTimeSecRef = useRef<number>(globalCurrentTimeSec);
  const lastReportedTimeSecRef = useRef<number>(globalCurrentTimeSec);
  const currentTimeSecRef = useRef<number>(globalCurrentTimeSec);
  const currentWorkletTimeSecRef = useRef<number>(globalCurrentTimeSec);

  // Реестры ожидающих промисов для асинхронных VST операций
  const pendingPluginLoadsRef = useRef<Map<string, () => void>>(globalPendingPluginLoads);
  const pendingChunkRequestsRef = useRef<Map<string, (chunk: string) => void>>(globalPendingChunkRequests);
  const syncedClipIdsRef = useRef<Set<number>>(globalSyncedClipIds);
  const clipWasmPtrs = useRef<Map<number, number>>(globalClipWasmPtrs);
  const pendingClipAcksRef = useRef<Map<number, () => void>>(globalPendingClipAcks);

  /**
   * Принудительное освобождение памяти WASM буфера клипа (HEAPF32 _free)
   */
  const freeClipWasmPointer = useCallback((clipId: number) => {
    const ptr = clipWasmPtrs.current.get(clipId);
    if (ptr) {
      try {
        globalNativeDAWBridge.freeFloats(ptr);
      } catch (e) {
        console.warn(`[useAudioEngine] Ошибка освобождения WASM пойнтера clip #${clipId}:`, e);
      }
      clipWasmPtrs.current.delete(clipId);
    }
    syncedClipIdsRef.current.delete(clipId);
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'FREE_CLIP_BUFFER',
        clipId
      });
    }
  }, []);

  /**
   * Сборщик мусора WebAssembly (garbageCollectWasm)
   * Сверяет существующие ID клипов в TrackState с активными пойнтерами в WASM и освобождает орфанов.
   */
  const garbageCollectWasm = useCallback((currentTracks?: TrackState[]) => {
    if (currentTracks) {
      globalLiveDAWEngine.setTracks(currentTracks);
    } else {
      globalLiveDAWEngine.garbageCollectWasm();
    }

    if (currentTracks && Array.isArray(currentTracks)) {
      const activeIds = new Set<number>();
      for (const track of currentTracks) {
        if (track && Array.isArray(track.clips)) {
          for (const clip of track.clips) {
            if (clip && typeof clip.id === 'number') {
              activeIds.add(clip.id);
            }
          }
        }
      }
      for (const [clipId, ptr] of clipWasmPtrs.current.entries()) {
        if (!activeIds.has(clipId)) {
          try {
            globalNativeDAWBridge.freeFloats(ptr);
          } catch (e) {
            console.warn(`[useAudioEngine] Ошибка GC WASM пойнтера clip #${clipId}:`, e);
          }
          clipWasmPtrs.current.delete(clipId);
          syncedClipIdsRef.current.delete(clipId);
        }
      }
    }

    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'GARBAGE_COLLECT_WASM'
      });
    }
  }, []);

  /**
   * Инициализация AudioContext, загрузка C++ WebAssembly ядра и запуск AudioWorklet
   */
  const initAudioEngine = useCallback(async () => {
    if (globalIsInitialized && globalWorkletNode) {
      setIsInitialized(true);
      setIsAudioWorkletActive(true);
      return;
    }
    if (globalInitPromise) {
      return globalInitPromise;
    }

    const doInit = async () => {
      try {
        setError(null);
        globalError = null;
        broadcastState((sub) => sub.setError(null));
        systemLogger.info('AudioWorklet', 'Инициализация Web AudioContext и загрузка C++ WASM ядра...');

        // 1. Загрузка бинарника /wasm/daw_core.wasm с резервным запуском из Base64 константы
        let wasmBytes: ArrayBuffer;
        try {
          const response = await fetch('/wasm/daw_core.wasm');
          if (response.status === 200) {
            wasmBytes = await response.arrayBuffer();
            if (wasmBytes && wasmBytes.byteLength > 0) {
              systemLogger.info('AudioWorklet', 'Высокопроизводительное C++ ядро успешно загружено с диска.');
            } else {
              throw new Error('Пустой бинарник');
            }
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        } catch (fetchErr) {
          systemLogger.info('AudioWorklet', 'Файл /wasm/daw_core.wasm не найден на сервере. Запускаем встроенное C++ Base64 WASM-ядро...');
          try {
            const binaryString = window.atob(EMBEDDED_WASM_CORE_BASE64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            wasmBytes = bytes.buffer;
          } catch (base64Err) {
            const errMessage = 'Фатальная ошибка: Не удалось декодировать встроенное Base64 C++ ядро.';
            globalError = errMessage;
            broadcastState((sub) => sub.setError(errMessage));
            systemLogger.error('AudioWorklet', errMessage);
            throw new Error(errMessage);
          }
        }

        // 2. Проверка поддержки Web Audio API
        const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtxClass) {
          throw new Error('Ваш браузер не поддерживает Web Audio API.');
        }

        if (!globalAudioCtx) {
          globalAudioCtx = new AudioCtxClass({ sampleRate: 48000 });
        }
        audioCtxRef.current = globalAudioCtx;
        const ctx = globalAudioCtx;

        // Снятие блокировки автоплея браузером
        if (ctx.state === 'suspended') {
          await ctx.resume();
          systemLogger.debug('AudioWorklet', 'AudioContext возобновлен (resume after suspend).');
        }

        // 3. Подключение AudioWorklet модуля
        if (!globalWorkletNode) {
          try {
            await ctx.audioWorklet.addModule('/audio-engine-processor.js');
            const workletNode = new AudioWorkletNode(ctx, 'audio-engine-processor', {
              numberOfInputs: 0,
              numberOfOutputs: 1,
              outputChannelCount: [2]
            });

            // Слушаем сообщения телеметрии и статуса из AudioWorklet
            let lastMetersUpdateTimestamp = 0;
            const METERS_THROTTLE_MS = 50; // Оптимальный throttle ~20 FPS с балластным подавлением шума
            let lastTracksData: TrackMeterData[] | null = null;
            let lastVocalBusData: VocalBusMeterData | null = null;
            let lastMasterData: MasterMeterData[] | null = null;
            let lastMasterSingleData: MasterMeterData | null = null;
            let metersFrameId: number | null = null;
            let metersTimerId: number | null = null;
            let wasMetersSilent = false;

            const updateMetersThrottled = () => {
              metersFrameId = null;

              let hasAnyAudioActivity = false;

              if (Array.isArray(lastTracksData) && lastTracksData.length > 0) {
                const tracksSnapshot = lastTracksData;
                lastTracksData = null;

                for (let i = 0; i < tracksSnapshot.length; i++) {
                  if (tracksSnapshot[i] && (tracksSnapshot[i].peakL > 0.001 || tracksSnapshot[i].peakR > 0.001)) {
                    hasAnyAudioActivity = true;
                    break;
                  }
                }

                if (hasAnyAudioActivity || !wasMetersSilent) {
                  broadcastState((sub) => {
                    sub.setTrackMeters((prevMap) => {
                      const safeMap = prevMap instanceof Map ? prevMap : new Map();
                      const safeItems = toSafeArray<TrackMeterData>(tracksSnapshot);
                      let changed = false;

                      for (let i = 0; i < safeItems.length; i++) {
                        const item = safeItems[i];
                        if (!item || typeof item.trackId !== 'number') continue;
                        const prev = safeMap.get(item.trackId);
                        if (!prev ||
                            Math.abs(prev.peakL - item.peakL) > 0.005 ||
                            Math.abs(prev.peakR - item.peakR) > 0.005 ||
                            prev.clipped !== item.clipped) {
                          changed = true;
                          break;
                        }
                      }

                      if (!changed && safeMap.size === safeItems.length) {
                        return prevMap; // React Bailout: нулевой ре-рендер
                      }

                      const newMap = new Map(safeMap);
                      for (let i = 0; i < safeItems.length; i++) {
                        const item = safeItems[i];
                        if (item && typeof item.trackId === 'number') {
                          newMap.set(item.trackId, item);
                        }
                      }
                      globalTrackMeters.clear();
                      newMap.forEach((v, k) => globalTrackMeters.set(k, v));
                      return newMap;
                    });
                  });
                }
              } else {
                lastTracksData = null;
              }

              if (lastVocalBusData) {
                const vocalBusSnapshot = { ...lastVocalBusData };
                lastVocalBusData = null;
                if (vocalBusSnapshot.peakL > 0.001 || vocalBusSnapshot.peakR > 0.001) {
                  hasAnyAudioActivity = true;
                }
                if (hasAnyAudioActivity || !wasMetersSilent) {
                  globalVocalBusMeter = vocalBusSnapshot;
                  broadcastState((sub) => {
                    sub.setVocalBusMeter((prev) => {
                      if (Math.abs(prev.peakL - vocalBusSnapshot.peakL) < 0.005 &&
                          Math.abs(prev.peakR - vocalBusSnapshot.peakR) < 0.005) {
                        return prev; // React Bailout
                      }
                      return vocalBusSnapshot;
                    });
                  });
                }
              }

              if (lastMasterSingleData) {
                const masterSnapshot = { ...lastMasterSingleData };
                lastMasterSingleData = null;
                if (masterSnapshot.peakL > 0.001 || masterSnapshot.peakR > 0.001) {
                  hasAnyAudioActivity = true;
                }
                if (hasAnyAudioActivity || !wasMetersSilent) {
                  globalMasterMeter = masterSnapshot;
                  broadcastState((sub) => {
                    sub.setMasterMeter((prev) => {
                      if (Math.abs(prev.peakL - masterSnapshot.peakL) < 0.005 &&
                          Math.abs(prev.peakR - masterSnapshot.peakR) < 0.005 &&
                          prev.clipped === masterSnapshot.clipped) {
                        return prev; // React Bailout
                      }
                      return masterSnapshot;
                    });
                  });
                }
              }

              wasMetersSilent = !hasAnyAudioActivity;
            };

            const handleHostMessage = (e: MessageEvent) => {
              const data = e.data;
              if (!data) return;

              if (data.type === 'METERS_TELEMETRY') {
                const workletTime = typeof data.currentTimeSec === 'number' ? data.currentTimeSec : 0;
                currentWorkletTimeSecRef.current = workletTime;
                globalCurrentTimeSec = workletTime;

                // 1. Прием METERS_TELEMETRY не должен спамить setCurrentTimeSec каждые 100 мс.
                // Курсор таймлайна интерполируется на 60 FPS через performance.now() и requestAnimationFrame напрямую.
                // React стейт обновляется плавно раз в 250 мс для отображения таймкода без лагов.
                const timeDiff = Math.abs(workletTime - lastReportedTimeSecRef.current);
                if (timeDiff >= 0.25) {
                  lastReportedTimeSecRef.current = workletTime;
                  playheadStartTimeSecRef.current = workletTime;
                  playheadStartPerfRef.current = performance.now();
                  currentTimeSecRef.current = workletTime;
                  broadcastState((sub) => sub.setCurrentTimeSec(Math.max(0, workletTime)));
                }

                // 2. Буферизация данных телеметрии уровней (TrackMeters, VocalBus, Master)
                if (data.tracks && Array.isArray(data.tracks)) {
                  lastTracksData = data.tracks;
                }
                if (data.vocalBus) {
                  lastVocalBusData = data.vocalBus;
                }
                if (data.master) {
                  lastMasterSingleData = data.master;
                }

                // 3. Жесткий throttle индикаторов громкости не чаще 1 раза в 50 мс (~20 FPS)
                const now = performance.now();
                if (now - lastMetersUpdateTimestamp >= METERS_THROTTLE_MS) {
                  lastMetersUpdateTimestamp = now;
                  if (metersFrameId === null) {
                    metersFrameId = requestAnimationFrame(updateMetersThrottled);
                  }
                } else if (metersTimerId === null) {
                  const delay = Math.max(1, METERS_THROTTLE_MS - (now - lastMetersUpdateTimestamp));
                  metersTimerId = window.setTimeout(() => {
                    metersTimerId = null;
                    lastMetersUpdateTimestamp = performance.now();
                    updateMetersThrottled();
                  }, delay);
                }
              } else if (data.type === 'VST_PLUGIN_LOADED') {
                const key = `${data.trackId}_${data.slotIdx}`;
                const cb = globalPendingPluginLoads.get(key);
                if (cb) {
                  globalPendingPluginLoads.delete(key);
                  cb();
                }
                systemLogger.debug('VSTHost', `VST плагин успешно смонтирован в слот ${data.slotIdx} дорожки ${data.trackId}. PDC задержка: ${data.latencySamples} сэмплов.`);
              } else if (data.type === 'VST_CHUNK_SAVED') {
                const cb = globalPendingChunkRequests.get(data.requestId);
                if (cb) {
                  globalPendingChunkRequests.delete(data.requestId);
                  cb(data.chunk || '');
                }
              } else if (data.type === 'CLIP_LOADED_SUCCESS') {
                if (typeof data.clipId === 'number' && typeof data.wasmPtr === 'number' && data.wasmPtr > 0) {
                  globalClipWasmPtrs.set(data.clipId, data.wasmPtr);
                }
                const cb = globalPendingClipAcks.get(data.clipId);
                if (cb) {
                  globalPendingClipAcks.delete(data.clipId);
                  cb();
                }
              } else if (data.type === 'FREE_CLIP_BUFFER') {
                if (typeof data.clipId === 'number') {
                  freeClipWasmPointer(data.clipId);
                }
              } else if (data.type === 'WASM_INIT_SUCCESS') {
                globalIsAudioWorkletActive = true;
                broadcastState((sub) => sub.setIsAudioWorkletActive(true));
                systemLogger.info('C++ WASM', 'C++ DSP аудиомикшер успешно инициализирован в AudioWorklet (48000 Hz).');
              } else if (data.type === 'WORKLET_PROCESS_ERROR') {
                systemLogger.error('AudioWorklet', `Сбой реалтайм C++ Mixer processBlock в фоновом потоке: ${data.error}`);
              }
            };

            workletNode.port.onmessage = handleHostMessage;
            workletNode.connect(ctx.destination);
            globalWorkletNode = workletNode;
            workletNodeRef.current = workletNode;

            // Инициализируем C++ мост в основном потоке
            await globalNativeDAWBridge.initWasmEngine().catch((bridgeErr) => {
              console.warn('[useAudioEngine] Предупреждение инициализации NativeDAWBridge:', bridgeErr);
            });

            // Передаем байты WASM модуля в AudioWorklet процессор
            workletNode.port.postMessage({
              type: 'INIT_WASM',
              wasmBytes,
              sampleRate: ctx.sampleRate || 48000
            }, [wasmBytes]);

            globalIsAudioWorkletActive = true;
            broadcastState((sub) => sub.setIsAudioWorkletActive(true));
            systemLogger.info('AudioWorklet', 'AudioWorklet-процессор успешно смонтирован и запущен.');
          } catch (workletErr) {
            const errMessage = 'Критическая ошибка: C++ ядро не скомпилировано! Скомпилируйте public/wasm/daw_core.wasm через build_wasm.sh.';
            globalError = errMessage;
            globalIsAudioWorkletActive = false;
            broadcastState((sub) => {
              sub.setError(errMessage);
              sub.setIsAudioWorkletActive(false);
            });
            systemLogger.error('AudioWorklet', `Сбой загрузки AudioWorklet: ${errMessage}`, workletErr);
            throw workletErr;
          }
        }

        globalIsInitialized = true;
        isInitializedRef.current = true;
        broadcastState((sub) => sub.setIsInitialized(true));
        systemLogger.info('System', 'Аудиосистема C++ готова к воспроизведению и микшированию.');
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Критическая ошибка: C++ ядро не скомпилировано! Скомпилируйте public/wasm/daw_core.wasm через build_wasm.sh.';
        globalError = errMsg;
        broadcastState((sub) => sub.setError(errMsg));
        systemLogger.error('AudioWorklet', `Сбой инициализации аудиосистемы: ${errMsg}`, err, err instanceof Error ? err.stack : undefined);
      }
    };

    globalInitPromise = doInit().finally(() => {
      globalInitPromise = null;
    });

    return globalInitPromise;
  }, [freeClipWasmPointer]);

  /**
   * Воспроизведение / Пауза
   */
  const play = useCallback(async () => {
    if (!globalIsInitialized) {
      await initAudioEngine();
    }
    if (globalAudioCtx && globalAudioCtx.state === 'suspended') {
      await globalAudioCtx.resume();
    }
    playheadStartPerfRef.current = performance.now();
    playheadStartTimeSecRef.current = currentTimeSec;
    lastReportedTimeSecRef.current = currentTimeSec;
    currentTimeSecRef.current = currentTimeSec;
    if (globalWorkletNode) {
      globalWorkletNode.port.postMessage({ type: 'SEEK', timeSec: currentTimeSec });
      globalWorkletNode.port.postMessage({ type: 'PLAY' });
    }
    globalIsPlaying = true;
    broadcastState((sub) => sub.setIsPlaying(true));
  }, [initAudioEngine, currentTimeSec]);

  const pause = useCallback(() => {
    if (globalWorkletNode) {
      globalWorkletNode.port.postMessage({ type: 'PAUSE' });
    }
    const finalTime = currentWorkletTimeSecRef.current || currentTimeSecRef.current;
    lastReportedTimeSecRef.current = finalTime;
    currentTimeSecRef.current = finalTime;
    globalCurrentTimeSec = finalTime;
    globalIsPlaying = false;
    broadcastState((sub) => {
      sub.setIsPlaying(false);
      sub.setCurrentTimeSec(finalTime);
    });
  }, []);

  const togglePlay = useCallback(async () => {
    if (globalIsPlaying) {
      pause();
    } else {
      await play();
    }
  }, [play, pause]);

  const seek = useCallback((timeSec: number) => {
    const safeTime = Math.max(0, timeSec);
    playheadStartPerfRef.current = performance.now();
    playheadStartTimeSecRef.current = safeTime;
    lastReportedTimeSecRef.current = safeTime;
    currentTimeSecRef.current = safeTime;
    currentWorkletTimeSecRef.current = safeTime;
    globalCurrentTimeSec = safeTime;
    if (globalWorkletNode) {
      globalWorkletNode.port.postMessage({ type: 'SEEK', timeSec: safeTime });
    }
    broadcastState((sub) => sub.setCurrentTimeSec(safeTime));
  }, []);

  /**
   * Декодирование аудиофайла с ресемплингом в C++ до 48 000 Гц и передача в AudioWorklet
   */
  const uploadAudioFileToTrack = useCallback(
    async (
      file: File | Blob,
      trackId: number,
      clipId: number,
      offsetSec: number = 0
    ): Promise<{ durationSec: number; samplesCount: number; pcmData: Float32Array }> => {
      if (!isInitialized) {
        await initAudioEngine();
      }

      systemLogger.info('MediaNormalizer', `Декодирование и C++ ресэмплинг файла для дорожки #${trackId}...`, {
        trackId,
        clipId,
        sizeBytes: file.size
      });
      const pcmFloat32 = await MediaNormalizer.unifyAudioBuffer(file, 48000);
      const totalFrames = pcmFloat32.length / 2;
      const durationSec = totalFrames / 48000;

      if (pcmFloat32.length === 0) {
        systemLogger.error('MediaNormalizer', `ВНИМАНИЕ: Декодированный PCM буфер для клипа #${clipId} ПУСТОЙ!`);
      }

      systemLogger.info(
        'AudioWorklet',
        `Клип #${clipId} успешно декодирован и загружен в дорожку #${trackId}: ${durationSec.toFixed(2)} сек (${totalFrames} фреймов 48 кГц стерео). Размер буфера: ${pcmFloat32.length} сэмплов.`,
        { trackId, clipId, durationSec, totalFrames, bufferLength: pcmFloat32.length }
      );

      if (workletNodeRef.current) {
        return new Promise((resolve) => {
          if (!workletNodeRef.current) {
            resolve({
              durationSec,
              samplesCount: totalFrames,
              pcmData: pcmFloat32
            });
            return;
          }

          const timeout = setTimeout(() => {
            pendingClipAcksRef.current.delete(clipId);
            resolve({
              durationSec,
              samplesCount: totalFrames,
              pcmData: pcmFloat32
            });
          }, 3000);

          pendingClipAcksRef.current.set(clipId, () => {
            clearTimeout(timeout);
            resolve({
              durationSec,
              samplesCount: totalFrames,
              pcmData: pcmFloat32
            });
          });

          // Перед отправкой нового pcmBuffer в WASM жестко проверяем мапу clipWasmPtrs
          // и вызываем принудительное освобождение _free для перезаписываемого ID клипа
          if (clipWasmPtrs.current.has(clipId)) {
            freeClipWasmPointer(clipId);
          }

          syncedClipIdsRef.current.add(clipId);
          const offsetSamples = typeof offsetSec === 'number' ? Math.round(offsetSec * 48000) : 0;
          const lengthSamples = Math.floor(pcmFloat32.length / 2);

          try {
            workletNodeRef.current.port.postMessage({
              type: 'LOAD_TRACK_CLIP',
              trackId,
              clipId,
              audioData: pcmFloat32,
              offsetSec,
              offsetSamples,
              lengthSamples,
              gain: 1.0,
              pan: 0.0,
              isStereo: true
            });
          } catch (cloneErr) {
            console.warn('[useAudioEngine] postMessage fallback to Transferable buffer:', cloneErr);
            workletNodeRef.current.port.postMessage(
              {
                type: 'LOAD_TRACK_CLIP',
                trackId,
                clipId,
                audioData: pcmFloat32,
                offsetSec,
                offsetSamples,
                lengthSamples,
                gain: 1.0,
                pan: 0.0,
                isStereo: true
              },
              [pcmFloat32.buffer]
            );
          }
        });
      }

      return {
        durationSec,
        samplesCount: totalFrames,
        pcmData: pcmFloat32
      };
    },
    [isInitialized, initAudioEngine, freeClipWasmPointer]
  );

  const uploadRawPCMToTrack = useCallback(
    (
      pcmFloat32: Float32Array,
      trackId: number,
      clipId: number,
      offsetSec: number = 0,
      gain: number = 1.0,
      pan: number = 0.0,
      isStereo: boolean = true
    ) => {
      if (workletNodeRef.current) {
        // Перед отправкой нового pcmBuffer в WASM жестко проверяем мапу clipWasmPtrs
        // и вызываем принудительное освобождение _free для перезаписываемого ID клипа
        if (clipWasmPtrs.current.has(clipId)) {
          freeClipWasmPointer(clipId);
        }

        syncedClipIdsRef.current.add(clipId);

        const handleAck = (e: MessageEvent) => {
          if (e.data && e.data.type === 'CLIP_LOADED_SUCCESS' && e.data.clipId === clipId) {
            workletNodeRef.current?.port.removeEventListener('message', handleAck);
          }
        };

        workletNodeRef.current.port.addEventListener('message', handleAck);
        workletNodeRef.current.port.start();

        const offsetSamples = typeof offsetSec === 'number' ? Math.round(offsetSec * 48000) : 0;
        const lengthSamples = isStereo ? Math.floor(pcmFloat32.length / 2) : pcmFloat32.length;

        try {
          workletNodeRef.current.port.postMessage({
            type: 'LOAD_TRACK_CLIP',
            trackId,
            clipId,
            audioData: pcmFloat32,
            offsetSec,
            offsetSamples,
            lengthSamples,
            gain,
            pan,
            isStereo
          });
        } catch (cloneErr) {
          console.warn('[useAudioEngine] Raw PCM postMessage fallback to Transferable:', cloneErr);
          workletNodeRef.current.port.postMessage(
            {
              type: 'LOAD_TRACK_CLIP',
              trackId,
              clipId,
              audioData: pcmFloat32,
              offsetSec,
              offsetSamples,
              lengthSamples,
              gain,
              pan,
              isStereo
            },
            [pcmFloat32.buffer]
          );
        }
      }
    },
    [freeClipWasmPointer]
  );

  /**
   * Пакетная загрузка нарезанных клипов (Batch Clip Insertion)
   * Передает метаданные всех клипов за один вызов postMessage
   * Предотвращает лавину вызовов postMessage и DataCloneError
   */
  const uploadClipsBatchToTrack = useCallback(
    async (trackId: number, clips: ClipConfig[]): Promise<void> => {
      if (!workletNodeRef.current) return;
      const safeClips = toSafeArray<ClipConfig>(clips);
      if (safeClips.length === 0) return;

      for (const c of safeClips) {
        if (c && typeof c.id === 'number') {
          if (clipWasmPtrs.current.has(c.id)) {
            freeClipWasmPointer(c.id);
          }
          syncedClipIdsRef.current.add(c.id);
        }
      }

      const count = safeClips.length;

      const handleBatchAck = (e: MessageEvent) => {
        if (e.data && e.data.type === 'CLIPS_BATCH_LOADED_SUCCESS' && e.data.trackId === trackId) {
          workletNodeRef.current?.port.removeEventListener('message', handleBatchAck);
          systemLogger.info('System', `Успешно загружен пакет из ${e.data.count || count} клипов для дорожки #${trackId}`);
        }
      };

      workletNodeRef.current.port.addEventListener('message', handleBatchAck);
      workletNodeRef.current.port.start();

      const batchPayload = safeClips.map((c) => {
        const isStereo = c.buffer ? c.buffer.length >= (c.lengthSamples || 0) * 2 : true;
        return {
          clipId: c.id,
          id: c.id,
          name: c.name,
          offsetSamples: c.offsetSamples || 0,
          lengthSamples: c.lengthSamples || 0,
          gain: typeof c.gain === 'number' ? c.gain : 1.0,
          pan: typeof c.pan === 'number' ? c.pan : 0.0,
          fadeInSamples: c.fadeInSamples || 0,
          fadeOutSamples: c.fadeOutSamples || 0,
          isStereo,
          parentClipId: c.parentClipId || (c as any).originalClipId || (c as any).sourceClipId,
          bufferOffsetSamples: c.bufferOffsetSamples || (c as any).segOffsetInClip || 0
        };
      });

      try {
        workletNodeRef.current.port.postMessage({
          type: 'LOAD_CLIPS_BATCH',
          trackId,
          clips: batchPayload
        });
      } catch (err) {
        console.warn('[useAudioEngine] uploadClipsBatchToTrack postMessage error:', err);
      }

      globalLiveDAWEngine.syncTrackClips(trackId, safeClips);
      garbageCollectWasm();
    },
    [freeClipWasmPointer, garbageCollectWasm]
  );

  const syncTrackClips = useCallback((trackId: number, clips: ClipConfig[]) => {
    if (workletNodeRef.current) {
      try {
        const safeClips = toSafeArray<ClipConfig>(clips);

        // Передаем СТРОГО метаданные клипов без единого байта Float32Array аудиоданных во избежание DataCloneError
        workletNodeRef.current.port.postMessage({
          type: 'SET_TRACK_CLIPS',
          trackId,
          clips: safeClips.map((c) => ({
            id: c.id,
            name: c.name,
            offsetSamples: c.offsetSamples || 0,
            lengthSamples: c.lengthSamples || 0,
            gain: typeof c.gain === 'number' ? c.gain : 1.0,
            pan: typeof c.pan === 'number' ? c.pan : 0.0,
            fadeInSamples: c.fadeInSamples || 0,
            fadeOutSamples: c.fadeOutSamples || 0,
            isStereo: c.buffer ? c.buffer.length >= (c.lengthSamples || 0) * 2 : true,
            parentClipId: c.parentClipId || (c as any).originalClipId || (c as any).sourceClipId,
            bufferOffsetSamples: c.bufferOffsetSamples || (c as any).segOffsetInClip || 0
          }))
        });

        // Синхронизируем состояние в LiveDAWEngine
        globalLiveDAWEngine.syncTrackClips(trackId, safeClips);

        // Сборка мусора осиротевших указателей WASM после syncTrackClips
        garbageCollectWasm();
      } catch (err) {
        console.warn('[useAudioEngine] syncTrackClips postMessage ignored:', err);
      }
    }
  }, [garbageCollectWasm]);

  const syncAllTracks = useCallback((tracks: TrackState[]) => {
    if (workletNodeRef.current) {
      try {
        const safeTracks = toSafeArray<TrackState>(tracks);

        // Передаем СТРОГО метаданные дорожек и параметров микшера.
        // Буферы PCM хранятся в кэше AudioWorklet и КАТЕГОРИЧЕСКИ не передаются повторно в SET_ALL_TRACKS.
        workletNodeRef.current.port.postMessage({
          type: 'SET_ALL_TRACKS',
          tracks: safeTracks.map((t) => ({
            id: t.id,
            name: t.name,
            volumeDb: typeof t.volumeDb === 'number' ? t.volumeDb : 0.0,
            pan: typeof t.pan === 'number' ? t.pan : 0.0,
            solo: !!t.solo,
            mute: !!t.mute,
            isOriginalAudio: !!t.isOriginalAudio,
            vstPlugins: toSafeArray<VSTPluginInstance>(t.vstPlugins),
            dsp: {
              eq: t.eq,
              compressor: t.compressor,
              noiseGate: t.noiseGate,
              deEsser: t.deEsser,
              deClicker: t.deClicker,
              autoDucker: t.autoDucker
            },
            clips: toSafeArray<ClipConfig>(t.clips).map((c) => ({
              id: c.id,
              name: c.name,
              offsetSamples: c.offsetSamples || 0,
              lengthSamples: c.lengthSamples || 0,
              gain: typeof c.gain === 'number' ? c.gain : 1.0,
              pan: typeof c.pan === 'number' ? c.pan : 0.0,
              fadeInSamples: c.fadeInSamples || 0,
              fadeOutSamples: c.fadeOutSamples || 0,
              buffer: c.buffer instanceof Float32Array && c.buffer.length > 0 ? c.buffer : undefined,
              isStereo: c.buffer ? c.buffer.length >= (c.lengthSamples || 0) * 2 : true,
              parentClipId: c.parentClipId || (c as any).originalClipId || (c as any).sourceClipId,
              bufferOffsetSamples: c.bufferOffsetSamples || (c as any).segOffsetInClip || 0
            }))
          }))
        });

        // Синхронизируем состояние в LiveDAWEngine
        globalLiveDAWEngine.syncAllTracks(safeTracks);

        // Сборка мусора осиротевших указателей WASM после syncAllTracks
        garbageCollectWasm(safeTracks);
      } catch (err) {
        console.warn('[useAudioEngine] syncAllTracks postMessage ignored:', err);
      }
    }
  }, [garbageCollectWasm]);

  /**
   * Обновление состояния дорожки с контролем памяти WASM и принудительным освобождением _free
   */
  const handleUpdateTrack = useCallback(
    (updatedTrack: TrackState) => {
      if (!updatedTrack) return;

      const safeClips = toSafeArray<ClipConfig>(updatedTrack.clips);

      // Перед отправкой новых pcmBuffer в WASM жестко проверяем мапу clipWasmPtrs
      // и вызываем принудительное освобождение _free для перезаписываемых ID клипов
      for (const c of safeClips) {
        if (!c || typeof c.id !== 'number') continue;
        const isBufferChanged = c.buffer instanceof Float32Array && c.buffer.length > 0 && !syncedClipIdsRef.current.has(c.id);
        if (isBufferChanged) {
          if (clipWasmPtrs.current.has(c.id)) {
            freeClipWasmPointer(c.id);
          }
        }
      }

      // Синхронизируем клипы дорожки
      syncTrackClips(updatedTrack.id, safeClips);

      // Передаем параметры дорожки в AudioWorklet
      if (workletNodeRef.current) {
        workletNodeRef.current.port.postMessage({
          type: 'UPDATE_TRACK',
          track: {
            id: updatedTrack.id,
            volumeDb: updatedTrack.volumeDb ?? 0,
            pan: updatedTrack.pan ?? 0,
            solo: Boolean(updatedTrack.solo),
            mute: Boolean(updatedTrack.mute),
            clips: safeClips.map((c) => ({
              id: c.id,
              name: c.name,
              offsetSamples: c.offsetSamples,
              lengthSamples: c.lengthSamples,
              gain: typeof c.gain === 'number' ? c.gain : 1.0,
              pan: typeof c.pan === 'number' ? c.pan : 0.0,
              fadeInSamples: c.fadeInSamples || 0,
              fadeOutSamples: c.fadeOutSamples || 0,
              isStereo: c.buffer ? c.buffer.length >= (c.lengthSamples || 0) * 2 : true
            }))
          }
        });
      }
    },
    [syncTrackClips, freeClipWasmPointer]
  );

  const performLoudnessMatching = useCallback(
    (
      tracks: TrackState[],
      targetRmsDb: number = -18.0,
      maxPeakDb: number = -1.0
    ): LoudnessMatchingResult => {
      const safeTracks = toSafeArray<TrackState>(tracks);
      const result = MediaNormalizer.autoMatchTrackVolumes(safeTracks, targetRmsDb, maxPeakDb);

      if (workletNodeRef.current && result && result.adjustments) {
        toSafeArray<TrackLoudnessAdjustment>(result.adjustments).forEach((adj) => {
          if (adj && !adj.isSilent) {
            workletNodeRef.current?.port.postMessage({
              type: 'SET_TRACK_VOLUME',
              trackId: adj.trackId,
              volumeDb: adj.newVolumeDb
            });
          }
        });
      }

      return result;
    },
    []
  );

  const setTrackVolume = useCallback((trackId: number, volumeDb: number) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_TRACK_VOLUME', trackId, volumeDb });
    }
  }, []);

  const setTrackPan = useCallback((trackId: number, pan: number) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_TRACK_PAN', trackId, pan });
    }
  }, []);

  const setTrackSolo = useCallback((trackId: number, solo: boolean) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_TRACK_SOLO', trackId, solo });
    }
  }, []);

  const setTrackMute = useCallback((trackId: number, mute: boolean) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_TRACK_MUTE', trackId, mute });
    }
  }, []);

  const setTrackDsp = useCallback((trackId: number, dsp: any) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_TRACK_DSP', trackId, dsp });
    }
  }, []);

  const setTrackEq = useCallback((trackId: number, eqParams: any) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'SET_TRACK_EQ',
        trackId,
        eq: eqParams.lowShelf ? eqParams : undefined,
        eqParams: !eqParams.lowShelf ? eqParams : undefined
      });
    }
  }, []);

  const setTrackCompressor = useCallback((trackId: number, compParams: any) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'SET_TRACK_COMPRESSOR',
        trackId,
        compressor: compParams.thresholdDb !== undefined ? compParams : undefined,
        compParams: compParams.thresholdDb === undefined ? compParams : undefined
      });
    }
  }, []);

  const setTrackNoiseGate = useCallback((trackId: number, noiseGate: any) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_TRACK_NOISE_GATE', trackId, noiseGate });
    }
  }, []);

  const setTrackDeEsser = useCallback((trackId: number, deEsser: any) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_TRACK_DEESSER', trackId, deEsser });
    }
  }, []);

  const setTrackAutoDucker = useCallback((trackId: number, duckParams: any) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'SET_TRACK_AUTODUCKER',
        trackId,
        autoDucker: duckParams.thresholdDb !== undefined ? duckParams : undefined,
        duckParams: duckParams.thresholdDb === undefined ? duckParams : undefined
      });
    }
  }, []);

  const setVocalBus = useCallback((vocalBus: VocalBusState) => {
    if (!vocalBus || typeof vocalBus === 'function') return;
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'SET_VOCAL_BUS',
        vocalBus,
        volumeDb: vocalBus.volumeDb,
        pan: vocalBus.pan,
        mute: vocalBus.mute,
        solo: vocalBus.solo,
        dsp: vocalBus.dsp
      });
    }
  }, []);

  const setVocalBusVolume = useCallback((volumeDb: number) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'SET_VOCAL_BUS',
        volumeDb
      });
    }
  }, []);

  const setMasterVolume = useCallback((volumeDb: number) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_MASTER_VOLUME', volumeDb });
    }
  }, []);

  const setMasterLimiter = useCallback((enabled: boolean, ceilingDb: number) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_MASTER_LIMITER', enabled, ceilingDb });
    }
  }, []);

  // ==========================================================================
  // Реализация методов Universal VST Contract
  // ==========================================================================

  /**
   * 1. loadPluginToTrack: Создание инстанса плагина в C++ слоте дорожки через указатель микшера
   */
  const loadPluginToTrack = useCallback(
    async (
      trackId: number,
      slotIdx: number,
      descriptor: VSTPluginDescriptor
    ): Promise<void> => {
      if (!isInitialized) {
        await initAudioEngine();
      }

      const instanceId = `${descriptor.id}-${trackId}-${slotIdx}-${Date.now()}`;
      const requestKey = `${trackId}_${slotIdx}`;

      systemLogger.info(
        'VSTHost',
        `Загрузка VST плагина "${descriptor.name}" (${descriptor.format}) в слот [${slotIdx}] дорожки #${trackId}...`
      );

      // Если запущено в нативной среде Tauri Desktop — параллельно инициализируем нативный C++ VST3 хост
      if (TauriNativeBridge.isTauriEnvironment() && descriptor.path) {
        try {
          const sampleRate = audioCtxRef.current?.sampleRate || 48000;
          await TauriNativeBridge.loadPluginNative(
            trackId,
            slotIdx,
            descriptor.path,
            sampleRate,
            512,
            descriptor.classUid
          );
        } catch (nativeErr) {
          systemLogger.warn('VSTHost', `Нативная загрузка VST в Tauri вернула предупреждение: ${nativeErr}`);
        }
      }

      if (workletNodeRef.current) {
        return new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            pendingPluginLoadsRef.current.delete(requestKey);
            systemLogger.warn('VSTHost', `Таймаут подтверждения монтирования плагина "${descriptor.name}".`);
            resolve();
          }, 2500);

          pendingPluginLoadsRef.current.set(requestKey, () => {
            clearTimeout(timeout);
            resolve();
          });

          workletNodeRef.current?.port.postMessage({
            type: 'LOAD_VST_PLUGIN',
            trackId,
            slotIdx,
            descriptor,
            instanceId,
            pluginId: descriptor.id
          });
        });
      }
    },
    [isInitialized, initAudioEngine]
  );

  /**
   * 2. setPluginParameter: Атомарная передача числового ID параметра и нормализованного float-значения (0.0 .. 1.0)
   */
  const setPluginParameter = useCallback(
    (
      target: 'track' | 'vocalBus' | 'master',
      instanceId: string,
      paramId: number,
      value: number,
      trackId?: number
    ) => {
      const normalizedValue = Math.max(0.0, Math.min(1.0, Number(value) || 0.0));

      if (TauriNativeBridge.isTauriEnvironment()) {
        TauriNativeBridge.setPluginParameterNative(instanceId, paramId, normalizedValue).catch(() => {});
      }

      if (workletNodeRef.current) {
        workletNodeRef.current.port.postMessage({
          type: 'UPDATE_VST_PARAM',
          target,
          trackId,
          instanceId,
          paramId,
          numericParamId: paramId,
          value: normalizedValue
        });
      }
    },
    []
  );

  /**
   * 3. savePluginChunk: Сериализация и получение Base64-чанка состояния плагина
   */
  const savePluginChunk = useCallback(
    async (instanceId: string): Promise<string> => {
      // В нативном окружении Desktop сперва опрашиваем VST3 IComponent::getState()
      if (TauriNativeBridge.isTauriEnvironment()) {
        try {
          const nativeChunk = await TauriNativeBridge.savePluginChunkNative(instanceId);
          if (nativeChunk && nativeChunk.length > 0) {
            return nativeChunk;
          }
        } catch (_) {}
      }

      if (!workletNodeRef.current) return '';

      const requestId = `chunk_${instanceId}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;

      return new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
          pendingChunkRequestsRef.current.delete(requestId);
          resolve('');
        }, 3000);

        pendingChunkRequestsRef.current.set(requestId, (chunk: string) => {
          clearTimeout(timeout);
          resolve(chunk);
        });

        workletNodeRef.current?.port.postMessage({
          type: 'SAVE_VST_CHUNK',
          instanceId,
          requestId
        });
      });
    },
    []
  );

  /**
   * Установка полной цепочки VST-плагинов
   */
  const setTrackVstChain = useCallback((trackId: number, vstPlugins: VSTPluginInstance[]) => {
    if (workletNodeRef.current) {
      const safePlugins = toSafeArray<VSTPluginInstance>(vstPlugins);
      workletNodeRef.current.port.postMessage({ type: 'SET_TRACK_VST_CHAIN', trackId, vstPlugins: safePlugins });
    }
  }, []);

  const setVocalBusVstChain = useCallback((vstPlugins: VSTPluginInstance[]) => {
    if (workletNodeRef.current) {
      const safePlugins = toSafeArray<VSTPluginInstance>(vstPlugins);
      workletNodeRef.current.port.postMessage({ type: 'SET_VOCAL_BUS_VST_CHAIN', vstPlugins: safePlugins });
    }
  }, []);

  const setMasterVstChain = useCallback((vstPlugins: VSTPluginInstance[]) => {
    if (workletNodeRef.current) {
      const safePlugins = toSafeArray<VSTPluginInstance>(vstPlugins);
      workletNodeRef.current.port.postMessage({ type: 'SET_MASTER_VST_CHAIN', vstPlugins: safePlugins });
    }
  }, []);

  /**
   * Обновление параметра (строковый или числовой ID)
   */
  const updateVstParameter = useCallback((
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    paramId: string | number,
    value: number,
    trackId?: number
  ) => {
    if (workletNodeRef.current) {
      const numericParamId = getParamIdAsNumber(paramId);
      const normalizedValue = Math.max(0.0, Math.min(1.0, Number(value) || 0.0));
      workletNodeRef.current.port.postMessage({
        type: 'UPDATE_VST_PARAM',
        target,
        trackId,
        instanceId,
        paramId,
        numericParamId,
        value: normalizedValue
      });
    }
  }, []);

  /**
   * Сквозное управление байпасом с плавным сглаживанием гейна
   */
  const setVstBypass = useCallback((
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    enabled: boolean,
    trackId?: number
  ) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'SET_VST_BYPASS',
        target,
        trackId,
        instanceId,
        bypass: !enabled,
        enabled
      });
    }
  }, []);

  /**
   * Сквозное управление Wet/Dry балансом
   */
  const setVstWetDry = useCallback((
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    wetDry: number,
    trackId?: number
  ) => {
    if (workletNodeRef.current) {
      const normWetDry = Math.max(0.0, Math.min(1.0, Number(wetDry) || 0.0));
      workletNodeRef.current.port.postMessage({
        type: 'SET_VST_WET_DRY',
        target,
        trackId,
        instanceId,
        wetDry: normWetDry
      });
    }
  }, []);

  return {
    isInitialized,
    isPlaying,
    isAudioWorkletActive,
    currentTimeSec,
    error,
    trackMeters,
    vocalBusMeter,
    masterMeter,

    initAudioEngine,
    togglePlay,
    play,
    pause,
    seek,

    uploadAudioFileToTrack,
    uploadRawPCMToTrack,
    uploadClipsBatchToTrack,
    syncTrackClips,
    syncAllTracks,
    handleUpdateTrack,
    garbageCollectWasm,

    setTrackVolume,
    setTrackPan,
    setTrackSolo,
    setTrackMute,

    setTrackDsp,
    setTrackEq,
    setTrackCompressor,
    setTrackNoiseGate,
    setTrackDeEsser,
    setTrackAutoDucker,

    setVocalBus,
    setVocalBusVolume,

    setMasterVolume,
    setMasterLimiter,

    // Методы Universal VST Contract
    loadPluginToTrack,
    setPluginParameter,
    savePluginChunk,

    setTrackVstChain,
    setVocalBusVstChain,
    setMasterVstChain,
    updateVstParameter,
    setVstBypass,
    setVstWetDry,

    performLoudnessMatching
  };
};
