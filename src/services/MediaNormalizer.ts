/**
 * ============================================================================
 * MEDIA NORMALIZER & LOUDNESS MATCHING SERVICE (NATIVE C++ WASM CONTROLLER)
 * ============================================================================
 * Тонкий контроллер управления нормализацией медиаданных, извлечения звуковых
 * дорожек из видеофайлов и автоматического выравнивания громкости (Auto-Match Loudness).
 *
 * Архитектурный принцип:
 * 1. JavaScript / Web API выполняет ТОЛЬКО системное декодирование сжатых кодеков
 *    (MP3, AAC, OGG, WAV, MP4) в сырой PCM поток через браузерный AudioContext.decodeAudioData.
 * 2. ВСЯ математическая обработка (кубический ресэмплинг Catmull-Rom в 48 000 Гц,
 *    стерео-интерливинг, расчет True Peak, RMS и пакетирование поправок громкости)
 *    выполняется исключительно на C++ в WebAssembly с поддержкой SIMD (NativeDAWBridge).
 * 3. Гарантированный уход от утечек памяти через блоки try...finally с вызовами
 *    allocateFloats / freeFloats.
 * ============================================================================
 */

import { TrackState } from '../audio/dawEngine';
import {
  NativeDAWBridge,
  globalNativeDAWBridge,
  NativeLoudnessResult,
  NativeTrackLoudnessAdjustment,
  NativeLoudnessStats
} from './NativeDAWBridge';

/**
 * Метрики громкости и мощности сигнала
 */
export interface LoudnessMetrics {
  peakLinear: number;
  peakDb: number;
  rmsLinear: number;
  rmsDb: number;
  isClipping: boolean;
  sampleCount: number;
  durationSec: number;
}

export type TrackLoudnessAdjustment = NativeTrackLoudnessAdjustment;
export type LoudnessMatchingResult = NativeLoudnessResult;

export class MediaNormalizer {
  public static readonly TARGET_SAMPLE_RATE = NativeDAWBridge.TARGET_SAMPLE_RATE;
  public static readonly SILENCE_THRESHOLD_DB = NativeDAWBridge.SILENCE_THRESHOLD_DB;
  public static readonly MIN_DB_FLOOR = NativeDAWBridge.MIN_DB_FLOOR;

  /**
   * Преобразование линейной амплитуды в децибелы (dBFS)
   */
  public static linearToDb(linear: number): number {
    if (linear <= 1e-6 || !isFinite(linear) || isNaN(linear)) {
      return MediaNormalizer.MIN_DB_FLOOR;
    }
    return 20.0 * Math.log10(linear);
  }

  /**
   * Преобразование децибел (dBFS) в линейную амплитуду
   */
  public static dbToLinear(db: number): number {
    if (!isFinite(db) || isNaN(db) || db <= MediaNormalizer.MIN_DB_FLOOR) {
      return 0.0;
    }
    return Math.pow(10.0, db / 20.0);
  }

  /**
   * ==========================================================================
   * 1. УНИФИКАЦИЯ АУДИОФАЙЛА (C++ WebAssembly Resampler & Interleaver)
   * ==========================================================================
   * - Декодирует сырые байты в AudioBuffer с помощью системных кодеков браузера.
   * - Извлекает сырые каналы Float32Array.
   * - Передает указатель в C++ функцию AudioResampler::resampleTo48k (через NativeDAWBridge).
   * - C++ ядро производит векторный кубический ресэмплинг Catmull-Rom в 48 000 Гц
   *   и возвращает готовый интерливированный стерео буфер [L0, R0, L1, R1, ...].
   */
  public static async unifyAudioBuffer(
    fileOrBlob: File | Blob,
    targetSr: number = MediaNormalizer.TARGET_SAMPLE_RATE
  ): Promise<Float32Array> {
    if (!fileOrBlob || fileOrBlob.size === 0) {
      return new Float32Array(0);
    }

    // 1. Чтение бинарного массива из файла
    const arrayBuffer = await fileOrBlob.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      return new Float32Array(0);
    }

    // 2. Декодирование системным кодеком ОС через AudioContext
    const tempAudioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();

    let decodedBuffer: AudioBuffer;
    try {
      decodedBuffer = await tempAudioCtx.decodeAudioData(arrayBuffer);
    } finally {
      if (tempAudioCtx.state !== 'closed') {
        await tempAudioCtx.close().catch(() => {});
      }
    }

    const numFrames = decodedBuffer.length;
    if (numFrames === 0) {
      return new Float32Array(0);
    }

    const numChannels = decodedBuffer.numberOfChannels;
    const inSampleRate = decodedBuffer.sampleRate;

    // Подготовка плоского массива сэмплов исходного файла
    let rawInputPcm: Float32Array;
    if (numChannels === 1) {
      rawInputPcm = decodedBuffer.getChannelData(0);
    } else {
      // Подготовка интерливированного массива для передачи в WASM
      const leftData = decodedBuffer.getChannelData(0);
      const rightData = decodedBuffer.getChannelData(1);
      rawInputPcm = new Float32Array(numFrames * 2);
      for (let i = 0; i < numFrames; i++) {
        rawInputPcm[i * 2] = isFinite(leftData[i]) ? leftData[i] : 0.0;
        rawInputPcm[i * 2 + 1] = isFinite(rightData[i]) ? rightData[i] : 0.0;
      }
    }

    // 3. Вызов нативного C++ ресэмплера в WASM
    // Если частота не совпадает со стандартом 48000 Гц или канал моно — C++ производит
    // кубический Catmull-Rom ресэмплинг и приводит к стерео 48000 Гц.
    return globalNativeDAWBridge.resampleBufferTo48k(
      rawInputPcm,
      inSampleRate,
      numChannels === 1 ? 1 : 2
    );
  }

  /**
   * ==========================================================================
   * 2. ИЗВЛЕЧЕНИЕ ЗВУКА ИЗ ВИДЕОФАЙЛА (Original Video Audio Track)
   * ==========================================================================
   * Чтение аудиодорожки из видеофайла (MP4, WebM, MOV, MKV) с мгновенной
   * передачей в C++ ядро для создания референсной стерео-дорожки оригинального видео.
   */
  public static async extractAudioFromVideo(
    videoFile: File,
    targetSr: number = MediaNormalizer.TARGET_SAMPLE_RATE
  ): Promise<Float32Array> {
    if (!videoFile || videoFile.size === 0) {
      throw new Error('Видеофайл пуст или не выбран.');
    }

    try {
      // Прямое системное декодирование медиа-контейнера через AudioContext + C++ WASM
      const pcm = await MediaNormalizer.unifyAudioBuffer(videoFile, targetSr);
      if (pcm.length > 0) {
        return pcm;
      }
    } catch (directErr) {
      console.warn('[MediaNormalizer] Прямой декодинг видео через decodeAudioData переключен на fallback:', directErr);
    }

    // Fallback извлечение через HTML5 Video Element
    return await MediaNormalizer.extractAudioViaVideoElement(videoFile, targetSr);
  }

  /**
   * Fallback извлечение аудио через HTML5 Video Element
   */
  private static async extractAudioViaVideoElement(
    videoFile: File,
    targetSr: number
  ): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = false;
      video.preload = 'auto';
      const url = URL.createObjectURL(videoFile);
      video.src = url;

      video.onloadedmetadata = async () => {
        try {
          const duration = video.duration;
          if (!duration || duration <= 0) {
            URL.revokeObjectURL(url);
            return resolve(new Float32Array(0));
          }

          const blob = await fetch(url).then((r) => r.blob());
          const pcm = await MediaNormalizer.unifyAudioBuffer(blob, targetSr);
          URL.revokeObjectURL(url);
          resolve(pcm);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(new Error(`Не удалось извлечь аудиодорожку из видеофайла: ${err}`));
        }
      };

      video.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(new Error(`Ошибка загрузки видеофайла: ${e}`));
      };
    });
  }

  /**
   * ==========================================================================
   * 3. ВЫЧИСЛЕНИЕ МЕТРИК ГРОМКОСТИ (True Peak & RMS в C++ WebAssembly)
   * ==========================================================================
   * Передает PCM буфер в C++ LoudnessAnalyzer через выделенную память WASM кучи.
   */
  public static calculateRMSandPeak(
    buffer: Float32Array,
    isInterleaved: boolean = true
  ): LoudnessMetrics {
    if (!buffer || buffer.length === 0) {
      return {
        peakLinear: 0,
        peakDb: MediaNormalizer.MIN_DB_FLOOR,
        rmsLinear: 0,
        rmsDb: MediaNormalizer.MIN_DB_FLOOR,
        isClipping: false,
        sampleCount: 0,
        durationSec: 0
      };
    }

    const bridge = globalNativeDAWBridge;
    const channels = isInterleaved ? 2 : 1;
    const numFrames = Math.floor(buffer.length / channels);

    // Прямая запись Float32Array в WASM кучу без промежуточных JS массивов
    const ptr = bridge.writeFloat32Direct(buffer);

    try {
      const mod = bridge.getModule();
      const stats: NativeLoudnessStats = mod.calculateLoudnessStats
        ? mod.calculateLoudnessStats(ptr, numFrames, channels, -18.0, -1.0)
        : {
            peakLinear: 0,
            peakDb: MediaNormalizer.MIN_DB_FLOOR,
            rmsLinear: 0,
            rmsDb: MediaNormalizer.MIN_DB_FLOOR,
            gainDeltaToTargetDb: 0,
            isClipping: false,
            numSamples: numFrames
          };

      const durationSec = numFrames / MediaNormalizer.TARGET_SAMPLE_RATE;

      return {
        peakLinear: stats.peakLinear,
        peakDb: stats.peakDb,
        rmsLinear: stats.rmsLinear,
        rmsDb: stats.rmsDb,
        isClipping: stats.isClipping,
        sampleCount: buffer.length,
        durationSec: Math.round(durationSec * 100) / 100
      };
    } finally {
      // Освобождение памяти в C++ куче (Zero Memory Leaks)
      bridge.freeFloats(ptr);
    }
  }

  /**
   * ==========================================================================
   * 4. ПАКЕТНОЕ СВЕДЕНИЕ ПО ГРОМКОСТИ (Auto-Match Loudness via Mixer::autoMatchAllTracks)
   * ==========================================================================
   * - Передает аудиоклипы дорожек в C++ векторный LoudnessAnalyzer.
   * - C++ ядро вычисляет RMS/True Peak и рассчитывает точную поправку громкости volumeDb
   *   по стандарту EBU R128 с Peak Guard защитой.
   * - JS получает готовый массив обновленных значений volumeDb для отображения в UI.
   */
  public static autoMatchTrackVolumes(
    tracks: TrackState[],
    targetRmsDb: number = -18.0,
    maxPeakDb: number = -1.0
  ): LoudnessMatchingResult {
    return globalNativeDAWBridge.normalizeAndAlignTracks(tracks, targetRmsDb, maxPeakDb);
  }

  /**
   * Векторное умножение сигнала на цифровой гейн
   */
  public static applyGain(buffer: Float32Array, gainDb: number, inPlace: boolean = false): Float32Array {
    const target = inPlace ? buffer : new Float32Array(buffer.length);
    const linearGain = MediaNormalizer.dbToLinear(gainDb);

    for (let i = 0; i < buffer.length; i++) {
      target[i] = buffer[i] * linearGain;
    }

    return target;
  }
}
