import { useState, useEffect, useRef, useCallback } from 'react';
import { MediaNormalizer, LoudnessMatchingResult } from '../services/MediaNormalizer';
import { TrackState, ClipConfig } from '../audio/dawEngine';
import { systemLogger } from '../services/SystemLogger';
import { globalNativeDAWBridge } from '../services/NativeDAWBridge';
import { EMBEDDED_WASM_CORE_BASE64 } from '../data/embeddedWasmCore';

export interface TrackMeterData {
  trackId: number;
  peakL: number;
  peakR: number;
  rms: number;
}

export interface MasterMeterData {
  peakL: number;
  peakR: number;
  clipped: boolean;
}

export interface UseAudioEngineReturn {
  isInitialized: boolean;
  isPlaying: boolean;
  isAudioWorkletActive: boolean;
  currentTimeSec: number;
  error: string | null;
  trackMeters: Map<number, TrackMeterData>;
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

  setTrackEq: (trackId: number, eqParams: { lowGain?: number; midGain?: number; highGain?: number }) => void;
  setTrackCompressor: (
    trackId: number,
    compParams: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number }
  ) => void;
  setTrackAutoDucker: (
    trackId: number,
    duckParams: { enabled?: boolean; threshold?: number; depth?: number; sourceTrackId?: number }
  ) => void;

  setMasterVolume: (volumeDb: number) => void;
  setMasterLimiter: (enabled: boolean, ceilingDb: number) => void;

  performLoudnessMatching: (
    tracks: TrackState[],
    targetRmsDb?: number,
    maxPeakDb?: number
  ) => LoudnessMatchingResult;
}

export const useAudioEngine = (): UseAudioEngineReturn => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAudioWorkletActive, setIsAudioWorkletActive] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [trackMeters, setTrackMeters] = useState<Map<number, TrackMeterData>>(new Map());
  const [masterMeter, setMasterMeter] = useState<MasterMeterData>({
    peakL: 0,
    peakR: 0,
    clipped: false
  });

  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const isInitializedRef = useRef<boolean>(false);
  const pendingClipAcksRef = useRef<Map<number, () => void>>(new Map());

  /**
   * Инициализация AudioContext, загрузка C++ WebAssembly ядра (/wasm/daw_core.wasm) и запуск AudioWorklet
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
          if (!response.ok || response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
          }
          wasmBytes = await response.arrayBuffer();
          if (!wasmBytes || wasmBytes.byteLength === 0) {
            throw new Error('Пустой бинарник daw_core.wasm');
          }
          systemLogger.info('AudioWorklet', 'Высокопроизводительное C++ ядро успешно загружено с диска.');
        } catch (fetchErr) {
          systemLogger.warn('AudioWorklet', 'Локальный файл /wasm/daw_core.wasm не найден. Выполняется автономная загрузка встроенного ядра C++...', fetchErr);
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
            systemLogger.error('AudioWorklet', errMessage, base64Err);
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
            workletNode.port.onmessage = (e) => {
              const data = e.data;
              if (!data) return;

              if (data.type === 'METERS_TELEMETRY') {
                setCurrentTimeSec(data.currentTimeSec || 0);

                if (data.tracks && Array.isArray(data.tracks)) {
                  setTrackMeters((prevMap) => {
                    const newMap = new Map(prevMap);
                    data.tracks.forEach((item: TrackMeterData) => {
                      newMap.set(item.trackId, item);
                    });
                    return newMap;
                  });
                }

                if (data.master) {
                  setMasterMeter(data.master);
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
              } else if (data.type === 'WASM_CORE_MISSING') {
                const errMessage = 'Критическая ошибка: C++ ядро не скомпилировано! Скомпилируйте public/wasm/daw_core.wasm через build_wasm.sh.';
                setError(errMessage);
                setIsAudioWorkletActive(false);
                systemLogger.error('AudioWorklet', errMessage, data.error);
              }
            };

            workletNode.connect(ctx.destination);
            workletNodeRef.current = workletNode;

            // Инициализируем C++ мост в основном потоке
            await globalNativeDAWBridge.initWasmEngine().catch((bridgeErr) => {
              console.warn('[useAudioEngine] Предупреждение инициализации NativeDAWBridge:', bridgeErr);
            });

            // Передаем байты WASM модуля в AudioWorklet процессор (используем transfer для эффективности)
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
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'PLAY' });
    }
    setIsPlaying(true);
  }, [isInitialized, initAudioEngine]);

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
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SEEK', timeSec });
    }
    setCurrentTimeSec(timeSec);
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

      // Отправляем интерливированные Float32Array PCM аудиоданные в AudioWorklet
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
        // Добавляем ACK-контроль потока для предотвращения OOM при быстрой последовательной отправке
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
      workletNodeRef.current.port.postMessage({
        type: 'SET_TRACK_CLIPS',
        trackId,
        clips: clips.map((c) => ({
          id: c.id,
          name: c.name,
          offsetSamples: c.offsetSamples,
          lengthSamples: c.lengthSamples,
          gain: typeof c.gain === 'number' ? c.gain : 1.0,
          pan: typeof c.pan === 'number' ? c.pan : 0.0,
          fadeInSamples: c.fadeInSamples || 0,
          fadeOutSamples: c.fadeOutSamples || 0,
          // Опускаем buffer, так как он уже должен быть загружен в ворклер через LOAD_TRACK_CLIP
          isStereo: c.buffer ? c.buffer.length >= c.lengthSamples * 2 : true
        }))
      });
    }
  }, []);

  const syncAllTracks = useCallback((tracks: TrackState[]) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'SET_ALL_TRACKS',
        tracks: tracks.map((t) => ({
          id: t.id,
          name: t.name,
          volumeDb: t.volumeDb,
          pan: t.pan,
          solo: t.solo,
          mute: t.mute,
          clips: t.clips.map((c) => ({
            id: c.id,
            name: c.name,
            offsetSamples: c.offsetSamples,
            lengthSamples: c.lengthSamples,
            gain: typeof c.gain === 'number' ? c.gain : 1.0,
            pan: typeof c.pan === 'number' ? c.pan : 0.0,
            fadeInSamples: c.fadeInSamples || 0,
            fadeOutSamples: c.fadeOutSamples || 0,
            // Опускаем buffer, так как он уже должен быть загружен в ворклер через LOAD_TRACK_CLIP
            isStereo: c.buffer ? c.buffer.length >= c.lengthSamples * 2 : true
          }))
        }))
      });
    }
  }, []);

  /**
   * Пакетный расчет и отправка выровненных уровней громкости (Loudness Matching) в C++ аудиоядро
   */
  const performLoudnessMatching = useCallback(
    (
      tracks: TrackState[],
      targetRmsDb: number = -18.0,
      maxPeakDb: number = -1.0
    ): LoudnessMatchingResult => {
      const result = MediaNormalizer.autoMatchTrackVolumes(tracks, targetRmsDb, maxPeakDb);

      // Синхронизируем новые громкости фейдеров с AudioWorklet C++ ядром
      if (workletNodeRef.current) {
        result.adjustments.forEach((adj) => {
          if (!adj.isSilent) {
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

  /**
   * Команды управления параметрами C++ дорожек
   */
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

  const setTrackEq = useCallback((trackId: number, eqParams: { lowGain?: number; midGain?: number; highGain?: number }) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_EQ_PARAMS', trackId, eqParams });
    }
  }, []);

  const setTrackCompressor = useCallback(
    (
      trackId: number,
      compParams: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number }
    ) => {
      if (workletNodeRef.current) {
        workletNodeRef.current.port.postMessage({ type: 'SET_COMP_PARAMS', trackId, compParams });
      }
    },
    []
  );

  const setTrackAutoDucker = useCallback(
    (
      trackId: number,
      duckParams: { enabled?: boolean; threshold?: number; depth?: number; sourceTrackId?: number }
    ) => {
      if (workletNodeRef.current) {
        workletNodeRef.current.port.postMessage({ type: 'SET_DUCK_PARAMS', trackId, duckParams });
      }
    },
    []
  );

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

  return {
    isInitialized,
    isPlaying,
    isAudioWorkletActive,
    currentTimeSec,
    error,
    trackMeters,
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

    setTrackEq,
    setTrackCompressor,
    setTrackAutoDucker,

    setMasterVolume,
    setMasterLimiter,
    performLoudnessMatching
  };
};
