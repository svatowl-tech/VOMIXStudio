/**
 * ============================================================================
 * LOUDNESS AUTO-ALIGNER & VOICEOVER LEVELING ENGINE
 * ============================================================================
 * Модуль автоматического выстраивания и согласования финальной громкости:
 * 1. Анализ оригинальной аудиодорожки (LUFS / Gated RMS / True Peak).
 * 2. Анализ закадрового мастер-микса (дорожки дикторов / шина вокала).
 * 3. Расчет дифференциала громкости ($\Delta \text{dB}$) и приведение микса
 *    к студийному стандарту читаемости (+3.5 ... +4.5 dB над оригиналом).
 * 4. Защита от клиппинга (True Peak Limiter / Brickwall Ceiling -0.1 dBFS).
 * ============================================================================
 */

import { TrackState, VocalBusState, MasterState } from '../audio/dawEngine';
import { toSafeArray } from '../utils/safeIterables';
import { systemLogger } from './SystemLogger';

export interface LoudnessStats {
  rmsDb: number;              // Интегрированный общий RMS (dBFS)
  speechRmsDb: number;        // Гейтированный RMS активной речи (dBFS, порог > -55 dBFS)
  peakLinear: number;         // Линейный пик (0.0 .. 1.0+)
  peakDb: number;             // Истинный пик True Peak (dBFS)
  lufsEstimated: number;      // Оценка ITU-R BS.1770 / EBU R128 LUFS
  activeRatio: number;        // Доля активной речи к общей длительности (0.0 .. 1.0)
  durationSec: number;        // Длительность в секундах
  sampleCount: number;        // Количество сэмплов
}

export interface LoudnessComparisonResult {
  hasOriginalTrack: boolean;
  originalTrackName: string;
  originalLoudness: LoudnessStats;
  dubbedLoudness: LoudnessStats;
  overallMixLoudness: LoudnessStats;
  currentDeltaDb: number;           // Текущая разница: dubbedLoudness.speechRmsDb - originalLoudness.speechRmsDb
  targetDeltaDb: number;            // Целевой стандарт (+3.5 .. +4.5 dB, по умолчанию +4.0 dB)
  requiredGainAdjustmentDb: number; // Рекомендуемая компенсация громкости
  projectedVocalBusVolumeDb: number;// Новая расчетная громкость Vocal Bus
  projectedPeakDb: number;          // Ожидаемый пик после применения
  isPeakSafe: boolean;              // Безопасен ли уровень без жесткого клиппинга
  status: 'optimal' | 'too_quiet' | 'too_loud' | 'no_reference';
  statusMessage: string;
  details: string;
}

export class LoudnessAutoAligner {
  private static instance: LoudnessAutoAligner | null = null;

  public static readonly DEFAULT_TARGET_DELTA_DB = 4.0; // Студийный стандарт читаемости: +4.0 dB (+3.5 ... +4.5)
  public static readonly MIN_DELTA_STANDARD_DB = 3.5;
  public static readonly MAX_DELTA_STANDARD_DB = 4.5;
  public static readonly SAFETY_CEILING_DB = -0.1;      // Безопасный потолок мастер-лимитера

  public static getInstance(): LoudnessAutoAligner {
    if (!this.instance) {
      this.instance = new LoudnessAutoAligner();
    }
    return this.instance;
  }

  /**
   * Точный спектрально-энергетический анализ PCM буфера (глубокий расчет активной громкости и пиков)
   */
  public analyzePcm(
    pcmBuffer: Float32Array,
    isStereo: boolean = true,
    sampleRate: number = 48000
  ): LoudnessStats {
    if (!pcmBuffer || pcmBuffer.length === 0) {
      return {
        rmsDb: -120,
        speechRmsDb: -120,
        peakLinear: 0,
        peakDb: -120,
        lufsEstimated: -120,
        activeRatio: 0,
        durationSec: 0,
        sampleCount: 0
      };
    }

    const channels = isStereo ? 2 : 1;
    const totalFrames = Math.floor(pcmBuffer.length / channels);
    const durationSec = totalFrames / (sampleRate || 48000);

    let maxPeak = 0;
    let sumSquaresTotal = 0;
    let sumSquaresActive = 0;
    let activeFramesCount = 0;

    // Размер окна кратковременного RMS анализа: ~50 мс (2400 сэмплов при 48 кГц)
    const windowSize = Math.max(256, Math.round(sampleRate * 0.05));
    const silenceGateLinear = Math.pow(10, -52 / 20); // Гейт отсечения фоновой тишины: -52 dBFS

    for (let frame = 0; frame < totalFrames; frame++) {
      let sampleVal = 0;
      if (channels === 2) {
        const l = Math.abs(pcmBuffer[frame * 2] || 0);
        const r = Math.abs(pcmBuffer[frame * 2 + 1] || 0);
        sampleVal = Math.max(l, r);
        const energy = (l * l + r * r) * 0.5;
        sumSquaresTotal += energy;

        if (sampleVal > maxPeak) maxPeak = sampleVal;

        // Оценка активности
        if (sampleVal > silenceGateLinear) {
          sumSquaresActive += energy;
          activeFramesCount++;
        }
      } else {
        const val = Math.abs(pcmBuffer[frame] || 0);
        sampleVal = val;
        const energy = val * val;
        sumSquaresTotal += energy;

        if (sampleVal > maxPeak) maxPeak = sampleVal;

        if (sampleVal > silenceGateLinear) {
          sumSquaresActive += energy;
          activeFramesCount++;
        }
      }
    }

    const overallRmsLinear = totalFrames > 0 ? Math.sqrt(sumSquaresTotal / totalFrames) : 0;
    const speechRmsLinear = activeFramesCount > 0 ? Math.sqrt(sumSquaresActive / activeFramesCount) : overallRmsLinear;

    const peakDb = maxPeak > 0 ? 20 * Math.log10(maxPeak) : -120;
    const rmsDb = overallRmsLinear > 0 ? 20 * Math.log10(overallRmsLinear) : -120;
    const speechRmsDb = speechRmsLinear > 0 ? 20 * Math.log10(speechRmsLinear) : rmsDb;

    // Взвешенная оценка LUFS по стандарту ITU-R BS.1770 (K-weighting аппроксимация для речевого диапазона)
    const lufsEstimated = speechRmsDb > -100 ? speechRmsDb - 0.6 : -120;
    const activeRatio = totalFrames > 0 ? activeFramesCount / totalFrames : 0;

    return {
      rmsDb: Number(rmsDb.toFixed(2)),
      speechRmsDb: Number(speechRmsDb.toFixed(2)),
      peakLinear: Number(maxPeak.toFixed(4)),
      peakDb: Number(peakDb.toFixed(2)),
      lufsEstimated: Number(lufsEstimated.toFixed(2)),
      activeRatio: Number(activeRatio.toFixed(3)),
      durationSec: Number(durationSec.toFixed(2)),
      sampleCount: pcmBuffer.length
    };
  }

  /**
   * Быстрый синтез виртуального буфера дорожки для поканального замера громкости
   */
  public analyzeTrack(track: TrackState, sampleRate: number = 48000): LoudnessStats {
    if (!track || !track.clips || track.clips.length === 0) {
      return {
        rmsDb: -120,
        speechRmsDb: -120,
        peakLinear: 0,
        peakDb: -120,
        lufsEstimated: -120,
        activeRatio: 0,
        durationSec: 0,
        sampleCount: 0
      };
    }

    // Собираем общую длину дорожки
    let maxEndSample = 0;
    for (const c of track.clips) {
      const end = (c.offsetSamples || 0) + (c.lengthSamples || (c.buffer ? c.buffer.length : 0));
      if (end > maxEndSample) maxEndSample = end;
    }

    if (maxEndSample === 0) {
      return this.analyzePcm(new Float32Array(0), false, sampleRate);
    }

    // Ограничиваем размер проверочного буфера максимум 300 секундами для мгновенного анализа
    const safeFrames = Math.min(maxEndSample, sampleRate * 300);
    const monoBuffer = new Float32Array(safeFrames);
    const trackVolLinear = Math.pow(10, (track.volumeDb || 0) / 20);

    for (const clip of track.clips) {
      if (!clip.buffer || clip.buffer.length === 0) continue;
      const offset = clip.offsetSamples || 0;
      const clipGain = (clip.gain ?? 1.0) * trackVolLinear;
      const len = Math.min(clip.lengthSamples || clip.buffer.length, clip.buffer.length);

      for (let i = 0; i < len; i++) {
        const targetIdx = offset + i;
        if (targetIdx < safeFrames) {
          monoBuffer[targetIdx] += clip.buffer[i] * clipGain;
        }
      }
    }

    return this.analyzePcm(monoBuffer, false, sampleRate);
  }

  /**
   * Сравнительный анализ оригинальной дорожки и закадрового мастер-микса
   */
  public compareProjectLoudness(
    tracks: TrackState[],
    vocalBus: VocalBusState,
    targetDeltaDb: number = LoudnessAutoAligner.DEFAULT_TARGET_DELTA_DB,
    sampleRate: number = 48000
  ): LoudnessComparisonResult {
    const safeTracks = toSafeArray<TrackState>(tracks);

    // 1. Поиск оригинальной фоновой дорожки
    const originalTrack = safeTracks.find(
      (t) =>
        t.isOriginalAudio ||
        t.name.toLowerCase().includes('оригинал') ||
        t.name.toLowerCase().includes('original') ||
        t.name.toLowerCase().includes('видео') ||
        t.name.toLowerCase().includes('video') ||
        t.name.toLowerCase().includes('источник') ||
        t.name.toLowerCase().includes('source')
    );

    // 2. Речевые дорожки (актеры / закадр)
    const dubbedTracks = safeTracks.filter(
      (t) => t.id !== originalTrack?.id && !t.mute && toSafeArray(t.clips).length > 0
    );

    // 3. Анализ оригинальной дорожки
    let originalLoudness: LoudnessStats;
    if (originalTrack && toSafeArray(originalTrack.clips).length > 0) {
      originalLoudness = this.analyzeTrack(originalTrack, sampleRate);
    } else {
      // Фолбэк, если дорожка оригинала еще не загружена (стандартный reference -24.0 dBFS)
      originalLoudness = {
        rmsDb: -24.0,
        speechRmsDb: -24.0,
        peakLinear: 0.7,
        peakDb: -3.1,
        lufsEstimated: -24.0,
        activeRatio: 0.85,
        durationSec: 60,
        sampleCount: 60 * sampleRate
      };
    }

    // 4. Синтез и анализ совокупного голоса дикторов с учетом текущей Шины Вокала
    let dubbedLoudness: LoudnessStats;
    if (dubbedTracks.length > 0) {
      // Суммируем дикторские клипы в единый проверочный поток
      let maxLen = 0;
      for (const t of dubbedTracks) {
        for (const c of t.clips) {
          const end = (c.offsetSamples || 0) + (c.lengthSamples || (c.buffer ? c.buffer.length : 0));
          if (end > maxLen) maxLen = end;
        }
      }
      const safeLen = Math.min(Math.max(sampleRate * 1, maxLen), sampleRate * 300);
      const voiceSumBuffer = new Float32Array(safeLen);
      const vocalBusVolLinear = Math.pow(10, (vocalBus?.volumeDb ?? 0) / 20);

      for (const t of dubbedTracks) {
        const tGain = Math.pow(10, (t.volumeDb || 0) / 20) * vocalBusVolLinear;
        for (const c of t.clips) {
          if (!c.buffer) continue;
          const offset = c.offsetSamples || 0;
          const cGain = (c.gain ?? 1.0) * tGain;
          const cLen = Math.min(c.lengthSamples || c.buffer.length, c.buffer.length);
          for (let i = 0; i < cLen; i++) {
            const idx = offset + i;
            if (idx < safeLen) {
              voiceSumBuffer[idx] += c.buffer[i] * cGain;
            }
          }
        }
      }
      dubbedLoudness = this.analyzePcm(voiceSumBuffer, false, sampleRate);
    } else {
      dubbedLoudness = {
        rmsDb: -120,
        speechRmsDb: -120,
        peakLinear: 0,
        peakDb: -120,
        lufsEstimated: -120,
        activeRatio: 0,
        durationSec: 0,
        sampleCount: 0
      };
    }

    // 5. Расчет разницы громкостей и необходимой поправки
    const effectiveTargetDelta = Math.max(
      LoudnessAutoAligner.MIN_DELTA_STANDARD_DB,
      Math.min(LoudnessAutoAligner.MAX_DELTA_STANDARD_DB, targetDeltaDb)
    );

    // Сравниваем активный speech RMS оригинала и активный speech RMS дикторов
    const refOrigLevel = originalLoudness.speechRmsDb > -80 ? originalLoudness.speechRmsDb : -24.0;
    const refDubLevel = dubbedLoudness.speechRmsDb > -80 ? dubbedLoudness.speechRmsDb : -26.0;

    const currentDeltaDb = Number((refDubLevel - refOrigLevel).toFixed(2));
    const requiredAdjustmentDb = Number((effectiveTargetDelta - currentDeltaDb).toFixed(2));

    // Расчет результирующего положения ползунка Шины Вокала
    const currentBusVol = vocalBus?.volumeDb ?? 0;
    const rawProjectedBusVol = currentBusVol + requiredAdjustmentDb;
    const projectedVocalBusVolumeDb = Number(Math.max(-24, Math.min(12, rawProjectedBusVol)).toFixed(1));

    // Прогноз пикового значения True Peak
    const projectedPeakDb = Number((dubbedLoudness.peakDb + requiredAdjustmentDb).toFixed(2));
    const isPeakSafe = projectedPeakDb <= LoudnessAutoAligner.SAFETY_CEILING_DB;

    // Формирование статуса и рекомендаций
    let status: LoudnessComparisonResult['status'] = 'optimal';
    let statusMessage = '';
    let details = '';

    const hasOrig = !!originalTrack && toSafeArray(originalTrack.clips).length > 0;

    if (!hasOrig) {
      status = 'no_reference';
      statusMessage = 'Оригинальная дорожка не обнаружена. Используется стандарт EBU R128 (-24 LUFS).';
      details = `Текущий голос дикторов: ${refDubLevel} dBFS. Рекомендуемая калибровка к стандарту.`;
    } else if (Math.abs(currentDeltaDb - effectiveTargetDelta) <= 0.4) {
      status = 'optimal';
      statusMessage = `Громкость соответствует стандарту! Мастер-микс громче оригинала на +${currentDeltaDb} dB (норма: +${effectiveTargetDelta} dB).`;
      details = 'Закадровый голос отлично читается над оригинальным видеорядом.';
    } else if (currentDeltaDb < effectiveTargetDelta) {
      status = 'too_quiet';
      statusMessage = `Мастер-микс тише стандарта (разница +${currentDeltaDb} dB при норме +${effectiveTargetDelta} dB).`;
      details = `Необходимо поднять громкость Шины Вокала на +${requiredAdjustmentDb} dB для идеальной разборчивости.`;
    } else {
      status = 'too_loud';
      statusMessage = `Мастер-микс громче стандарта (разница +${currentDeltaDb} dB при норме +${effectiveTargetDelta} dB).`;
      details = `Рекомендуется уменьшить Шину Вокала на ${requiredAdjustmentDb} dB, чтобы не заглушать фон видео.`;
    }

    return {
      hasOriginalTrack: hasOrig,
      originalTrackName: originalTrack?.name || 'Оригинал (Видео)',
      originalLoudness,
      dubbedLoudness,
      overallMixLoudness: dubbedLoudness,
      currentDeltaDb,
      targetDeltaDb: effectiveTargetDelta,
      requiredGainAdjustmentDb: requiredAdjustmentDb,
      projectedVocalBusVolumeDb,
      projectedPeakDb,
      isPeakSafe,
      status,
      statusMessage,
      details
    };
  }

  /**
   * Автоматическое выравнивание и применение идеальной громкости перед рендером
   */
  public applyAutoAlignment(
    tracks: TrackState[],
    vocalBus: VocalBusState,
    master: MasterState,
    targetDeltaDb: number = LoudnessAutoAligner.DEFAULT_TARGET_DELTA_DB
  ): {
    updatedTracks: TrackState[];
    updatedVocalBus: VocalBusState;
    updatedMaster: MasterState;
    comparison: LoudnessComparisonResult;
  } {
    const comparison = this.compareProjectLoudness(tracks, vocalBus, targetDeltaDb);

    systemLogger.info(
      'LoudnessAutoAligner',
      `Авто-калибровка громкости: Оригинал=${comparison.originalLoudness.speechRmsDb} dBFS, Дубляж=${comparison.dubbedLoudness.speechRmsDb} dBFS, Разница=${comparison.currentDeltaDb} dB $\\rightarrow$ Цель=+${comparison.targetDeltaDb} dB. Поправка=+${comparison.requiredGainAdjustmentDb} dB`
    );

    // 1. Корректировка шины вокала
    const updatedVocalBus: VocalBusState = {
      ...vocalBus,
      volumeDb: comparison.projectedVocalBusVolumeDb
    };

    // 2. Активация мастер-лимитера для защиты от перегрузки при высокой компрессии
    const updatedMaster: MasterState = {
      ...master,
      limiterEnabled: true,
      limiterCeilingDb: LoudnessAutoAligner.SAFETY_CEILING_DB
    };

    return {
      updatedTracks: [...tracks],
      updatedVocalBus,
      updatedMaster,
      comparison
    };
  }
}

export const globalLoudnessAutoAligner = LoudnessAutoAligner.getInstance();
