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
import { TrackState, ClipConfig, VocalBusState } from '../audio/dawEngine';
import { VSTPluginInstance, VSTPluginDescriptor } from '../audio/vstTypes';
import { systemLogger } from '../services/SystemLogger';
import { globalNativeDAWBridge } from '../services/NativeDAWBridge';
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

  syncTrackClips: (trackId: number, clips: ClipConfig[]) => void;
  syncAllTracks: (tracks: TrackState[]) => void;

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

export const useAudioEngine = (): UseAudioEngineReturn => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAudioWorkletActive, setIsAudioWorkletActive] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [trackMeters, setTrackMeters] = useState<Map<number, TrackMeterData>>(new Map());
  const [vocalBusMeter, setVocalBusMeter] = useState<VocalBusMeterData>({
    peakL: 0,
    peakR: 0,
    latencySamples: 0,
    pdcMs: 0
  });
  const [masterMeter, setMasterMeter] = useState<MasterMeterData>({
    peakL: 0,
    peakR: 0,
    clipped: false,
    latencySamples: 0,
    pdcMs: 0
  });

  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const isInitializedRef = useRef<boolean>(false);
  const pendingClipAcksRef = useRef<Map<number, () => void>>(new Map());

  // Согласование времени плейхеда без дрожания с помощью performance.now()
  const playheadStartPerfRef = useRef<number>(performance.now());
  const playheadStartTimeSecRef = useRef<number>(0);

  // Реестры ожидающих промисов для асинхронных VST операций
  // key: `${trackId}_${slotIdx}` -> resolve callback
  const pendingPluginLoadsRef = useRef<Map<string, () => void>>(new Map());
  // requestId -> resolve callback с Base64 строкой чанка
  const pendingChunkRequestsRef = useRef<Map<string, (chunk: string) => void>>(new Map());

  /**
   * Инициализация AudioContext, загрузка C++ WebAssembly ядра и запуск AudioWorklet
   */
  const initAudioEngine = useCallback(async () => {
    if (isInitializedRef.current && workletNodeRef.current) {
      return;
    }
    if (initPromiseRef.current) {
      return initPromiseRef.current;
    }

    const doInit = async () => {
      try {
        setError(null);
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
            setError(errMessage);
            systemLogger.error('AudioWorklet', errMessage);
            throw new Error(errMessage);
          }
        }

        // 2. Проверка поддержки Web Audio API
        const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtxClass) {
          throw new Error('Ваш браузер не поддерживает Web Audio API.');
        }

        if (!audioCtxRef.current) {
          audioCtxRef.current = new AudioCtxClass({ sampleRate: 48000 });
        }

        const ctx = audioCtxRef.current;

        // Снятие блокировки автоплея браузером
        if (ctx.state === 'suspended') {
          await ctx.resume();
          systemLogger.debug('AudioWorklet', 'AudioContext возобновлен (resume after suspend).');
        }

        // 3. Подключение AudioWorklet модуля
        if (!workletNodeRef.current) {
          try {
            await ctx.audioWorklet.addModule('/audio-engine-processor.js');
            const workletNode = new AudioWorkletNode(ctx, 'audio-engine-processor', {
              numberOfInputs: 0,
              numberOfOutputs: 1,
              outputChannelCount: [2]
            });

            // Слушаем сообщения телеметрии и статуса из AudioWorklet
            let lastUpdateTimestamp = 0;
            const THROTTLE_MS = 16.6; // Обновление ~60 FPS
            let lastTimeSec = 0;
            let lastTracksData: TrackMeterData[] | null = null;
            let lastVocalBusData: VocalBusMeterData | null = null;
            let lastMasterData: MasterMeterData | null = null;
            let frameId: number | null = null;

            const updateStateThrottled = () => {
              // Плавная интерполяция времени плейхеда без сетевого/IPC дрожания
              const now = performance.now();
              const elapsedSec = (now - playheadStartPerfRef.current) / 1000;
              const smoothTimeSec = playheadStartTimeSecRef.current + elapsedSec;

              // Если рассинхронизация с C++ ворклером превышает 80мс, плавно примагничиваем
              if (Math.abs(smoothTimeSec - lastTimeSec) > 0.08) {
                playheadStartTimeSecRef.current = lastTimeSec;
                playheadStartPerfRef.current = now;
                setCurrentTimeSec(Math.max(0, lastTimeSec));
              } else {
                setCurrentTimeSec(Math.max(0, smoothTimeSec));
              }

              // Жесткая проверка на массив перед вызовом итерации для предотвращения TypeError
              if (Array.isArray(lastTracksData) && lastTracksData.length > 0) {
                const tracksSnapshot = [...lastTracksData];
                lastTracksData = null;
                setTrackMeters((prevMap) => {
                  const safeMap = prevMap instanceof Map ? prevMap : new Map();
                  const newMap = new Map(safeMap);
                  const safeItems = toSafeArray<TrackMeterData>(tracksSnapshot);
                  for (let i = 0; i < safeItems.length; i++) {
                    const item = safeItems[i];
                    if (item && typeof item.trackId === 'number') {
                      newMap.set(item.trackId, item);
                    }
                  }
                  return newMap;
                });
              } else {
                lastTracksData = null;
              }
              if (lastVocalBusData) {
                const vocalBusSnapshot = { ...lastVocalBusData };
                lastVocalBusData = null;
                setVocalBusMeter(vocalBusSnapshot);
              }
              if (lastMasterData) {
                const masterSnapshot = { ...lastMasterData };
                lastMasterData = null;
                setMasterMeter(masterSnapshot);
              }
              frameId = null;
            };

            workletNode.port.onmessage = (e) => {
              const data = e.data;
              if (!data) return;

              if (data.type === 'METERS_TELEMETRY') {
                lastTimeSec = data.currentTimeSec || 0;
                if (data.tracks && Array.isArray(data.tracks)) {
                  lastTracksData = data.tracks.filter(Boolean);
                }
                if (data.vocalBus) {
                  lastVocalBusData = data.vocalBus;
                }
                if (data.master) {
                  lastMasterData = data.master;
                }

                const now = performance.now();
                if (now - lastUpdateTimestamp >= THROTTLE_MS) {
                  lastUpdateTimestamp = now;
                  if (frameId === null) {
                    frameId = requestAnimationFrame(updateStateThrottled);
                  }
                }
              } else if (data.type === 'VST_PLUGIN_LOADED') {
                const key = `${data.trackId}_${data.slotIdx}`;
                const cb = pendingPluginLoadsRef.current.get(key);
                if (cb) {
                  pendingPluginLoadsRef.current.delete(key);
                  cb();
                }
                systemLogger.debug('VSTHost', `VST плагин успешно смонтирован в слот ${data.slotIdx} дорожки ${data.trackId}. PDC задержка: ${data.latencySamples} сэмплов.`);
              } else if (data.type === 'VST_CHUNK_SAVED') {
                const cb = pendingChunkRequestsRef.current.get(data.requestId);
                if (cb) {
                  pendingChunkRequestsRef.current.delete(data.requestId);
                  cb(data.chunk || '');
                }
              } else if (data.type === 'CLIP_LOADED_SUCCESS') {
                const cb = pendingClipAcksRef.current.get(data.clipId);
                if (cb) {
                  pendingClipAcksRef.current.delete(data.clipId);
                  cb();
                }
              } else if (data.type === 'WASM_INIT_SUCCESS') {
                setIsAudioWorkletActive(true);
                systemLogger.info('C++ WASM', 'C++ DSP аудиомикшер успешно инициализирован в AudioWorklet (48000 Hz).');
              } else if (data.type === 'WORKLET_PROCESS_ERROR') {
                systemLogger.error('AudioWorklet', `Сбой реалтайм C++ Mixer processBlock в фоновом потоке: ${data.error}`);
              }
            };

            workletNode.connect(ctx.destination);
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

            setIsAudioWorkletActive(true);
            systemLogger.info('AudioWorklet', 'AudioWorklet-процессор успешно смонтирован и запущен.');
          } catch (workletErr) {
            const errMessage = 'Критическая ошибка: C++ ядро не скомпилировано! Скомпилируйте public/wasm/daw_core.wasm через build_wasm.sh.';
            setError(errMessage);
            setIsAudioWorkletActive(false);
            systemLogger.error('AudioWorklet', `Сбой загрузки AudioWorklet: ${errMessage}`, workletErr);
            throw workletErr;
          }
        }

        isInitializedRef.current = true;
        setIsInitialized(true);
        systemLogger.info('System', 'Аудиосистема C++ готова к воспроизведению и микшированию.');
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Критическая ошибка: C++ ядро не скомпилировано! Скомпилируйте public/wasm/daw_core.wasm через build_wasm.sh.';
        setError(errMsg);
        systemLogger.error('AudioWorklet', `Сбой инициализации аудиосистемы: ${errMsg}`, err, err instanceof Error ? err.stack : undefined);
      }
    };

    initPromiseRef.current = doInit().finally(() => {
      initPromiseRef.current = null;
    });

    return initPromiseRef.current;
  }, []);

  /**
   * Воспроизведение / Пауза
   */
  const play = useCallback(async () => {
    if (!isInitialized) {
      await initAudioEngine();
    }
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      await audioCtxRef.current.resume();
    }
    playheadStartPerfRef.current = performance.now();
    playheadStartTimeSecRef.current = currentTimeSec;
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'PLAY' });
    }
    setIsPlaying(true);
  }, [isInitialized, initAudioEngine, currentTimeSec]);

  const pause = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'PAUSE' });
    }
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(async () => {
    if (isPlaying) {
      pause();
    } else {
      await play();
    }
  }, [isPlaying, play, pause]);

  const seek = useCallback((timeSec: number) => {
    const safeTime = Math.max(0, timeSec);
    playheadStartPerfRef.current = performance.now();
    playheadStartTimeSecRef.current = safeTime;
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SEEK', timeSec: safeTime });
    }
    setCurrentTimeSec(safeTime);
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

          workletNodeRef.current.port.postMessage({
            type: 'LOAD_TRACK_CLIP',
            trackId,
            clipId,
            audioData: pcmFloat32,
            offsetSec,
            gain: 1.0,
            pan: 0.0,
            isStereo: true
          });
        });
      }

      return {
        durationSec,
        samplesCount: totalFrames,
        pcmData: pcmFloat32
      };
    },
    [isInitialized, initAudioEngine]
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
        const handleAck = (e: MessageEvent) => {
          if (e.data && e.data.type === 'CLIP_LOADED_SUCCESS' && e.data.clipId === clipId) {
            workletNodeRef.current?.port.removeEventListener('message', handleAck);
            systemLogger.debug('System', `ACK получен для сырого PCM клипа #${clipId}`);
          }
        };

        workletNodeRef.current.port.addEventListener('message', handleAck);
        workletNodeRef.current.port.start();

        workletNodeRef.current.port.postMessage({
          type: 'LOAD_TRACK_CLIP',
          trackId,
          clipId,
          audioData: pcmFloat32,
          offsetSec,
          gain,
          pan,
          isStereo
        });
      }
    },
    []
  );

  const syncTrackClips = useCallback((trackId: number, clips: ClipConfig[]) => {
    if (workletNodeRef.current) {
      try {
        const safeClips = toSafeArray<ClipConfig>(clips);
        workletNodeRef.current.port.postMessage({
          type: 'SET_TRACK_CLIPS',
          trackId,
          clips: safeClips.map((c) => ({
            id: c.id,
            name: c.name,
            offsetSamples: c.offsetSamples,
            lengthSamples: c.lengthSamples,
            gain: typeof c.gain === 'number' ? c.gain : 1.0,
            pan: typeof c.pan === 'number' ? c.pan : 0.0,
            fadeInSamples: c.fadeInSamples || 0,
            fadeOutSamples: c.fadeOutSamples || 0,
            isStereo: c.buffer ? c.buffer.length >= c.lengthSamples * 2 : true,
            buffer: c.buffer instanceof Float32Array && c.buffer.length > 0 ? c.buffer : undefined
          }))
        });
      } catch (err) {
        console.warn('[useAudioEngine] syncTrackClips postMessage ignored:', err);
      }
    }
  }, []);

  const syncAllTracks = useCallback((tracks: TrackState[]) => {
    if (workletNodeRef.current) {
      try {
        const safeTracks = toSafeArray<TrackState>(tracks);
        workletNodeRef.current.port.postMessage({
          type: 'SET_ALL_TRACKS',
          tracks: safeTracks.map((t) => ({
            id: t.id,
            name: t.name,
            volumeDb: t.volumeDb,
            pan: t.pan,
            solo: t.solo,
            mute: t.mute,
            isOriginalAudio: t.isOriginalAudio,
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
              offsetSamples: c.offsetSamples,
              lengthSamples: c.lengthSamples,
              gain: typeof c.gain === 'number' ? c.gain : 1.0,
              pan: typeof c.pan === 'number' ? c.pan : 0.0,
              fadeInSamples: c.fadeInSamples || 0,
              fadeOutSamples: c.fadeOutSamples || 0,
              isStereo: c.buffer ? c.buffer.length >= c.lengthSamples * 2 : true,
              buffer: c.buffer instanceof Float32Array && c.buffer.length > 0 ? c.buffer : undefined
            }))
          }))
        });
      } catch (err) {
        console.warn('[useAudioEngine] syncAllTracks postMessage ignored:', err);
      }
    }
  }, []);

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
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'SET_VOCAL_BUS',
        volumeDb: vocalBus.volumeDb,
        pan: vocalBus.pan,
        mute: vocalBus.mute,
        solo: vocalBus.solo,
        dsp: vocalBus.dsp
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
      if (workletNodeRef.current) {
        const normalizedValue = Math.max(0.0, Math.min(1.0, Number(value) || 0.0));
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
    syncTrackClips,
    syncAllTracks,

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
