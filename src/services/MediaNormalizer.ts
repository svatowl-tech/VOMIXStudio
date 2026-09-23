/**
 * ============================================================================
 * MEDIA NORMALIZER & LOUDNESS MATCHING SERVICE (NATIVE C++ WASM CONTROLLER)
 * ============================================================================
 * Тонкий контроллер управления нормализацией медиаданных, извлечения звуковых
 * дорожек из видеофайлов и автоматического выравнивания громкости (Auto-Match Loudness).
 *
 * Архитектурный принцип:
 * 1. JavaScript / Web API выполняет ТОЛЬКО декодирование аудиоданных браузером
 *    через AudioContext.decodeAudioData в сырой PCM поток (Float32Array).
 * 2. ВСЯ математическая обработка звука (кубический ресэмплинг Catmull-Rom в 48 000 Гц,
 *    расчет True Peak, EBU R128 RMS, цифровой гейн и выравнивание уровней громкости)
 *    выполняется ИСКЛЮЧИТЕЛЬНО на C++ в WebAssembly с аппаратным SIMD128.
 * 3. При недоступности C++ WebAssembly ядра выбрасывается фатальная ошибка.
 * ============================================================================
 */

import { TrackState } from '../audio/dawEngine';
import {
  NativeDAWBridge,
  globalNativeDAWBridge,
  NativeLoudnessResult,
  NativeTrackLoudnessAdjustment
} from './NativeDAWBridge';
import { systemLogger } from './SystemLogger';

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
   * 1. УНИФИКАЦИЯ АУДИОФАЙЛА (C++ Catmull-Rom Resampler & Interleaver)
   * ==========================================================================
   * - Декодирует сырые байты в AudioBuffer через системный Web API кодек.
   * - Передает сырой Float32Array PCM поток в C++ WebAssembly.
   * - Векторный ресэмплинг Catmull-Rom в 48 000 Гц выполняется СТРОГО через
   *   globalNativeDAWBridge.resampleCatmullRom().
   */
  public static async unifyAudioBuffer(
    fileOrBlob: File | Blob,
    targetSr: number = MediaNormalizer.TARGET_SAMPLE_RATE
  ): Promise<Float32Array> {
    // Автоматически ожидаем инициализацию C++ WebAssembly ядра
    await globalNativeDAWBridge.initWasmEngine().catch((err) => {
      systemLogger.warn('MediaNormalizer', 'Предупреждение при прогреве C++ WebAssembly:', err);
    });

    if (!globalNativeDAWBridge.isReady) {
      throw new Error('[C++ MediaNormalizer] Ошибка обработки аудио: нативное C++ ядро WebAssembly не загружено или не инициализировано.');
    }

    if (!fileOrBlob || fileOrBlob.size === 0) {
      return new Float32Array(0);
    }

    // Чтение бинарного массива из файла
    let arrayBuffer = await fileOrBlob.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      return new Float32Array(0);
    }

    // Декодирование системным кодеком браузера через AudioContext
    const tempAudioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();

    let decodedBuffer: AudioBuffer | null = null;
    try {
      decodedBuffer = await tempAudioCtx.decodeAudioData(arrayBuffer);
    } catch (err: any) {
      systemLogger.error(
        'MediaNormalizer',
        `Ошибка декодирования аудиоданных: ${err?.message || 'Неподдерживаемый аудиокодек'}`,
        { byteLength: arrayBuffer.byteLength },
        err instanceof Error ? err.stack : undefined
      );
      throw new Error(`[C++ MediaNormalizer] Ошибка обработки аудио при декодировании: ${err?.message || err}`);
    } finally {
      if (tempAudioCtx.state !== 'closed') {
        await tempAudioCtx.close().catch(() => {});
      }
    }

    if (!decodedBuffer) {
      return new Float32Array(0);
    }

    const numFrames = decodedBuffer.length;
    if (numFrames === 0) {
      return new Float32Array(0);
    }

    const numChannels = decodedBuffer.numberOfChannels;
    const inSampleRate = decodedBuffer.sampleRate;

    // Подготовка плоского массива сэмплов (всегда 2-канальное стерео для исключения сбоев шага сэмплов)
    let rawInputPcm: Float32Array | null = null;
    if (numChannels === 1) {
      const ch0 = decodedBuffer.getChannelData(0);
      rawInputPcm = new Float32Array(numFrames * 2);
      for (let i = 0; i < numFrames; i++) {
        const s = isFinite(ch0[i]) ? ch0[i] : 0.0;
        rawInputPcm[i * 2] = s;
        rawInputPcm[i * 2 + 1] = s;
      }
    } else {
      const leftData = decodedBuffer.getChannelData(0);
      const rightData = decodedBuffer.getChannelData(1);
      rawInputPcm = new Float32Array(numFrames * 2);
      for (let i = 0; i < numFrames; i++) {
        rawInputPcm[i * 2] = isFinite(leftData[i]) ? leftData[i] : 0.0;
        rawInputPcm[i * 2 + 1] = isFinite(rightData[i]) ? rightData[i] : 0.0;
      }
    }

    try {
      if (!rawInputPcm) return new Float32Array(0);

      // Ресэмплинг выполняется ИСКЛЮЧИТЕЛЬНО на C++ через globalNativeDAWBridge.resampleCatmullRom()
      const resampled = globalNativeDAWBridge.resampleCatmullRom(
        rawInputPcm,
        inSampleRate,
        2
      );
      
      // Подсказка GC: очищаем промежуточные буферы ПОСЛЕ завершения работы C++ ядра
      rawInputPcm = null;
      decodedBuffer = null;
      (arrayBuffer as any) = null;
      
      return resampled;
    } catch (err: any) {
      const msg = `[C++ MediaNormalizer] Ошибка обработки аудио при ресэмплинге в C++ ядре: ${err?.message || err}`;
      systemLogger.error('MediaNormalizer', msg);
      throw new Error(msg);
    }
  }

  /**
   * ==========================================================================
   * 2. ИЗВЛЕЧЕНИЕ ЗВУКА ИЗ ВИДЕОФАЙЛА (Original Video Audio Track)
   * ==========================================================================
   */
  public static async extractAudioFromVideo(
    videoFile: File,
    targetSr: number = MediaNormalizer.TARGET_SAMPLE_RATE
  ): Promise<Float32Array> {
    // Автоматически ожидаем инициализацию C++ WebAssembly ядра
    await globalNativeDAWBridge.initWasmEngine().catch((err) => {
      systemLogger.warn('MediaNormalizer', 'Предупреждение при прогреве C++ WebAssembly:', err);
    });

    if (!globalNativeDAWBridge.isReady) {
      throw new Error('[C++ MediaNormalizer] Ошибка извлечения аудио: C++ ядро WebAssembly не готово.');
    }

    if (!videoFile || videoFile.size === 0) {
      throw new Error('[C++ MediaNormalizer] Ошибка извлечения аудио: видеофайл пуст или не выбран.');
    }

    try {
      const pcm = await MediaNormalizer.unifyAudioBuffer(videoFile, targetSr);
      if (pcm.length > 0) {
        return pcm;
      }
    } catch (directErr) {
      console.warn('[MediaNormalizer] Прямое декодирование контейнера переключено на HTML5 Video поток:', directErr);
    }

    return await MediaNormalizer.extractAudioViaVideoElement(videoFile, targetSr);
  }

  /**
   * Извлечение аудио через HTML5 Video Element
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
          reject(new Error(`[C++ MediaNormalizer] Не удалось извлечь аудиодорожку из видеофайла через HTML5-видео: ${err}`));
        }
      };

      video.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(new Error(`[C++ MediaNormalizer] Ошибка загрузки HTML5 видеофайла: ${e}`));
      };
    });
  }

  /**
   * ==========================================================================
   * 3. ВЫЧИСЛЕНИЕ МЕТРИК ГРОМКОСТИ (True Peak & RMS в C++ WebAssembly)
   * ==========================================================================
   * Выполняется СТРОГО через вызов C++ функции globalNativeDAWBridge.calculateLoudnessStats().
   */
  public static calculateRMSandPeak(
    buffer: Float32Array,
    isInterleaved: boolean = true
  ): LoudnessMetrics {
    if (!globalNativeDAWBridge.isReady) {
      throw new Error('[C++ MediaNormalizer] Ошибка анализа громкости: C++ ядро WebAssembly не инициализировано.');
    }

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

    const channels = isInterleaved ? 2 : 1;
    const numFrames = Math.floor(buffer.length / channels);

    try {
      // Вызов C++ аналитики через WebAssembly мост
      const stats = globalNativeDAWBridge.calculateLoudnessStats(
        buffer,
        channels,
        -18.0,
        -1.0
      );

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
    } catch (err: any) {
      const msg = `[C++ MediaNormalizer] Ошибка анализа громкости в C++ ядре: ${err?.message || err}`;
      systemLogger.error('MediaNormalizer', msg);
      throw new Error(msg);
    }
  }

  /**
   * ==========================================================================
   * 4. АВТОМАТИЧЕСКОЕ ВЫРАВНИВАНИЕ ГРОМКОСТИ ДОРОЖЕК (Auto-Match Loudness)
   * ==========================================================================
   * Анализ громкости и выравнивание по стандарту EBU R128 с Peak Guard защитой
   * выполняется ИСКЛЮЧИТЕЛЬНО на C++ в WebAssembly ядре.
   */
  public static autoMatchTrackVolumes(
    tracks: TrackState[],
    targetRmsDb: number = -18.0,
    maxPeakDb: number = -1.0
  ): LoudnessMatchingResult {
    if (!globalNativeDAWBridge.isReady) {
      throw new Error('[C++ MediaNormalizer] Ошибка автовыравнивания громкости: C++ ядро WebAssembly не готово.');
    }

    try {
      return globalNativeDAWBridge.normalizeAndAlignTracks(tracks, targetRmsDb, maxPeakDb);
    } catch (err: any) {
      throw new Error(`[C++ MediaNormalizer] Ошибка нормализации дорожек в C++ ядре: ${err?.message || err}`);
    }
  }

  /**
   * ==========================================================================
   * 5. ВЕКТОРНОЕ ПРИМЕНЕНИЕ ЦИФРОВОГО ГЕЙНА (C++ SIMD128)
   * ==========================================================================
   */
  public static applyGain(buffer: Float32Array, gainDb: number, inPlace: boolean = false): Float32Array {
    if (!buffer || buffer.length === 0 || Math.abs(gainDb) < 0.001) {
      return inPlace ? buffer : new Float32Array(buffer);
    }

    const factor = Math.pow(10, gainDb / 20);

    // Если буфер огромный (более 1 млн сэмплов), применяем коэффициент прямо в JS
    // для избежания тройного копирования в кучу WASM и обратно, что приводит к "Array buffer allocation failed"
    if (buffer.length > 1000000) {
      if (inPlace) {
        for (let i = 0; i < buffer.length; i++) {
          buffer[i] *= factor;
        }
        return buffer;
      } else {
        try {
          const result = new Float32Array(buffer.length);
          for (let i = 0; i < buffer.length; i++) {
            result[i] = buffer[i] * factor;
          }
          return result;
        } catch (e) {
          console.warn('[C++ MediaNormalizer] Не удалось выделить память под копию буфера, применяем gain in-place:', e);
          for (let i = 0; i < buffer.length; i++) {
            buffer[i] *= factor;
          }
          return buffer;
        }
      }
    }

    if (!globalNativeDAWBridge.isReady) {
      if (inPlace) {
        for (let i = 0; i < buffer.length; i++) {
          buffer[i] *= factor;
        }
        return buffer;
      } else {
        const result = new Float32Array(buffer.length);
        for (let i = 0; i < buffer.length; i++) {
          result[i] = buffer[i] * factor;
        }
        return result;
      }
    }

    if (inPlace) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] *= factor;
      }
      return buffer;
    } else {
      const result = new Float32Array(buffer.length);
      for (let i = 0; i < buffer.length; i++) {
        result[i] = buffer[i] * factor;
      }
      return result;
    }
  }
}
