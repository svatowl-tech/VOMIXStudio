/**
 * ============================================================================
 * AUTO TIMING & COLLISION RESOLUTION SERVICE
 * ============================================================================
 * Интеллектуальный сервис автоматического тайминга, распознавания актёров
 * и сценарного разведения аудиодорожек закадрового дубляжа.
 * 
 * Архитектурные задачи:
 * 1. Сопоставление актёров из субтитров с названиями дорожек даберов (Fuzzy Nick Matching / Translit).
 * 2. Автоматическая сегментация дорожек на фразы (C++ Energy VAD / Strip Silence).
 * 3. Привязка начала каждой фразы к таймкоду начала соответствующего субтитра.
 * 4. Анализ сценарных перекрытий в субтитрах:
 *    - Если в сценарии реплики перекрываются — перекрытие сохраняется в дубляже.
 *    - Если в сценарии реплики идут раздельно — нежелательные наезды автоматически
 *      устраняются и дорожки разводятся с естественной микропаузой.
 * 5. Проектный каскадный ресолвер коллизий без искажения дикторской артикуляции.
 * ============================================================================
 */

import { TrackState, ClipConfig, createNewTrack } from '../audio/dawEngine';
import { SubtitleCue } from './ProjectManager';
import { globalNativeDAWBridge } from './NativeDAWBridge';
import { systemLogger } from './SystemLogger';
import { toSafeArray } from '../utils/safeIterables';

export interface ActorTrackMapping {
  speaker: string;
  trackId: number;
  trackName: string;
  confidence: number;
  phraseCount: number;
  status: 'matched' | 'created' | 'unmatched';
}

export interface TrackAcousticProfile {
  trackId: number;
  trackName: string;
  noiseFloorDb: number;        // Уровень фонового шума в dBFS
  quietestSpeechRmsDb: number; // Уровень самой тихой реплики в dBFS
  loudestSpeechRmsDb: number;  // Уровень громкой речи в dBFS
  peakDb: number;              // Пиковый уровень
  snrDb: number;               // Отношение сигнал / шум
  optimalThresholdDb: number;  // Расчетный оптимальный порог отсечки тишины
  optimalMinSilenceMs: number; // Оптимальная длительность паузы между репликами
  optimalPaddingMs: number;    // Защитные буферы по краям для согласных звуков
}

export interface PhraseAlignmentDetail {
  cueIndex: number;
  speaker: string;
  trackId: number;
  clipId: number;
  originalSubtitleStartSec: number;
  originalSubtitleEndSec: number;
  initialAudioStartSec: number;
  finalAudioStartSec: number;
  finalAudioEndSec: number;
  durationSec: number;
  shiftDeltaSec: number;
  collisionResolvedWith?: string;
  isIntentionalScriptOverlap: boolean;
}

export interface AutoTimingResult {
  updatedTracks: TrackState[];
  actorMappings: ActorTrackMapping[];
  totalPhrasesAligned: number;
  resolvedCollisionsCount: number;
  preservedScriptOverlapsCount: number;
  alignmentDetails: PhraseAlignmentDetail[];
  logs: string[];
}

export class AutoTimingService {
  private static instance: AutoTimingService | null = null;

  public static getInstance(): AutoTimingService {
    if (!AutoTimingService.instance) {
      AutoTimingService.instance = new AutoTimingService();
    }
    return AutoTimingService.instance;
  }

  // ==========================================================================
  // 1. ИНТЕЛЛЕКТУАЛЬНЫЙ НОРМАЛИЗАТОР И СОПОСТАВИТЕЛЬ ИМЁН / НИКОВ АКТЁРОВ
  // ==========================================================================

  /**
   * Нормализация строки для нечёткого сравнения имён
   */
  public normalizeName(name: string): string {
    if (!name) return '';
    return name
      .toLowerCase()
      .replace(/\.[^/.]+$/, '') // убираем расширение файла (.wav, .mp3)
      .replace(/^ch\s*#?\d+[:\s\-_]*/i, '') // убираем "CH #1", "CH 2"
      .replace(/^track\s*#?\d+[:\s\-_]*/i, '') // убираем "Track 1"
      .replace(/^дорожка\s*#?\d+[:\s\-_]*/i, '') // убираем "Дорожка 1"
      .replace(/[\(\)\[\]\{\}_—–\-]/g, ' ') // скобки и дефисы в пробелы
      .replace(/\b(дублер|диктор|озвучка|голос|актер|voice|dubber|actor|audio)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Транслитерация базовых букв для сопоставления Latin <-> Cyrillic
   */
  public transliterate(str: string): string {
    const ruToEn: Record<string, string> = {
      а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
      и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
      с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
      ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
    };

    return str
      .toLowerCase()
      .split('')
      .map((char) => ruToEn[char] || char)
      .join('');
  }

  /**
   * Расчет схожести строк (0.0 .. 1.0) с учетом транслитерации и подстрок
   */
  public calculateSimilarity(strA: string, strB: string): number {
    const normA = this.normalizeName(strA);
    const normB = this.normalizeName(strB);

    if (!normA || !normB) return 0.0;
    if (normA === normB) return 1.0;

    // Проверка прямого вхождения подстроки
    if (normA.includes(normB) || normB.includes(normA)) {
      const minLen = Math.min(normA.length, normB.length);
      const maxLen = Math.max(normA.length, normB.length);
      return Math.max(0.85, minLen / maxLen);
    }

    // Проверка через транслитерацию
    const transA = this.transliterate(normA);
    const transB = this.transliterate(normB);

    if (transA === transB) return 0.95;
    if (transA.includes(transB) || transB.includes(transA)) return 0.88;

    // Вычисление расстояния Левенштейна
    const dist = this.levenshteinDistance(transA, transB);
    const maxLen = Math.max(transA.length, transB.length);
    if (maxLen === 0) return 1.0;

    return Math.max(0, 1.0 - dist / maxLen);
  }

  private levenshteinDistance(s1: string, s2: string): number {
    const m = s1.length;
    const n = s2.length;
    const dp: number[][] = [];

    for (let i = 0; i <= m; i++) {
      dp[i] = [i];
    }
    for (let j = 0; j <= n; j++) {
      dp[0][j] = j;
    }

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  /**
   * Извлечение уникальных спикеров из массива субтитров
   */
  public extractUniqueSpeakers(subtitles: SubtitleCue[]): string[] {
    const speakerSet = new Set<string>();
    const safeCues = toSafeArray<SubtitleCue>(subtitles);

    safeCues.forEach((cue) => {
      let speaker = (cue.speaker || '').trim();

      // Если спикер не указан в поле speaker, ищем паттерны вида "[Имя]:" или "(Имя):" в тексте
      if (!speaker && cue.text) {
        const match = cue.text.match(/^[\(\[]\s*([^:\]\)]+)\s*[\)\]]:?/);
        if (match && match[1]) {
          speaker = match[1].trim();
        }
      }

      if (speaker && !this.isGenericNoiseTag(speaker)) {
        speakerSet.add(speaker);
      }
    });

    return Array.from(speakerSet);
  }

  private isGenericNoiseTag(tag: string): boolean {
    const lower = tag.toLowerCase().trim();
    return (
      lower === 'музыка' ||
      lower === 'music' ||
      lower === 'шум' ||
      lower === 'noise' ||
      lower === 'смех' ||
      lower === 'аплодисменты' ||
      lower === 'тишина'
    );
  }

  /**
   * Автоматическое сопоставление спикеров из субтитров с дорожками микшера
   */
  public matchActorsToTracks(
    subtitles: SubtitleCue[],
    tracks: TrackState[]
  ): ActorTrackMapping[] {
    const speakers = this.extractUniqueSpeakers(subtitles);
    const safeTracks = toSafeArray<TrackState>(tracks).filter(
      (t) => !t.isOriginalAudio && !/оригинал|original|видео|video/i.test(t.name)
    );

    const mappings: ActorTrackMapping[] = [];
    const usedTrackIds = new Set<number>();

    // Считаем количество реплик на каждого спикера в субтитрах
    const speakerCueCount: Record<string, number> = {};
    toSafeArray<SubtitleCue>(subtitles).forEach((cue) => {
      const sp = (cue.speaker || '').trim();
      if (sp) {
        speakerCueCount[sp] = (speakerCueCount[sp] || 0) + 1;
      }
    });

    // 1. Первый проход: поиск наилучшего совпадения
    speakers.forEach((speaker) => {
      let bestTrack: TrackState | null = null;
      let highestSimilarity = 0;

      safeTracks.forEach((track) => {
        if (usedTrackIds.has(track.id)) return;
        const sim = this.calculateSimilarity(speaker, track.name);
        if (sim > highestSimilarity && sim >= 0.55) {
          highestSimilarity = sim;
          bestTrack = track;
        }
      });

      if (bestTrack && highestSimilarity >= 0.55) {
        usedTrackIds.add((bestTrack as TrackState).id);
        mappings.push({
          speaker,
          trackId: (bestTrack as TrackState).id,
          trackName: (bestTrack as TrackState).name,
          confidence: highestSimilarity,
          phraseCount: speakerCueCount[speaker] || 0,
          status: 'matched'
        });
      }
    });

    // 2. Второй проход: для оставшихся неназначенных спикеров подбираем свободные дорожки
    speakers.forEach((speaker) => {
      const alreadyMapped = mappings.some((m) => m.speaker === speaker);
      if (alreadyMapped) return;

      const availableTrack = safeTracks.find((t) => !usedTrackIds.has(t.id));
      if (availableTrack) {
        usedTrackIds.add(availableTrack.id);
        mappings.push({
          speaker,
          trackId: availableTrack.id,
          trackName: availableTrack.name,
          confidence: 0.5,
          phraseCount: speakerCueCount[speaker] || 0,
          status: 'matched'
        });
      } else {
        mappings.push({
          speaker,
          trackId: -1,
          trackName: `Не назначено (Будет создана дорожка)`,
          confidence: 0,
          phraseCount: speakerCueCount[speaker] || 0,
          status: 'unmatched'
        });
      }
    });

    return mappings;
  }

  // ==========================================================================
  // 2. ДЕТЕКЦИЯ СЦЕНАРНЫХ ПЕРЕКРЫТИЙ В СУБТИТРАХ (SCRIPT OVERLAPS MATRIX)
  // ==========================================================================

  /**
   * Проверка: перекрываются ли две реплики в исходном сценарии (субтитрах)
   */
  public isScriptOverlap(cueA: SubtitleCue, cueB: SubtitleCue, toleranceSec: number = 0.05): boolean {
    if (!cueA || !cueB) return false;
    const overlapStart = Math.max(cueA.startSec, cueB.startSec);
    const overlapEnd = Math.min(cueA.endSec, cueB.endSec);
    return overlapEnd - overlapStart > toleranceSec;
  }

  // ==========================================================================
  // 3. АКУСТИЧЕСКИЙ АНАЛИЗ И АДАПТИВНАЯ СЕГМЕНТАЦИЯ НА ФРАЗЫ (PER-TRACK VAD)
  // ==========================================================================

  /**
   * Акустический анализ дорожки: получение индивидуальных параметров (фоновый шум, тихая/громкая речь, SNR и адаптивный порог)
   */
  public analyzeTrackAcousticProfile(
    track: TrackState,
    sampleRate: number = 48000
  ): TrackAcousticProfile {
    const safeClips = toSafeArray<ClipConfig>(track.clips);
    const defaultProfile: TrackAcousticProfile = {
      trackId: track.id,
      trackName: track.name,
      noiseFloorDb: -58.0,
      quietestSpeechRmsDb: -28.0,
      loudestSpeechRmsDb: -14.0,
      peakDb: -6.0,
      snrDb: 30.0,
      optimalThresholdDb: -40.0,
      optimalMinSilenceMs: 280,
      optimalPaddingMs: 60
    };

    if (safeClips.length === 0) return defaultProfile;
    const firstClip = safeClips[0];
    const buffer = firstClip.untrimmedBuffer || firstClip.buffer;
    if (!buffer || buffer.length === 0) return defaultProfile;

    const totalFrames = firstClip.lengthSamples || Math.floor(buffer.length / 2);
    const isStereo = buffer.length >= totalFrames * 1.5;
    const channels = isStereo ? 2 : 1;
    const framesCount = Math.floor(buffer.length / channels);

    // Окна 15 мс для детального RMS анализа
    const windowSize = Math.max(64, Math.floor(sampleRate * 0.015));
    const numWindows = Math.ceil(framesCount / windowSize);
    if (numWindows <= 0) return defaultProfile;

    const windowRmsList: number[] = [];
    let maxAbsPeak = 0;

    for (let w = 0; w < numWindows; w++) {
      const startF = w * windowSize;
      const endF = Math.min(framesCount, startF + windowSize);
      let sumSq = 0;
      let count = 0;

      for (let f = startF; f < endF; f++) {
        const idx = f * channels;
        const sL = Math.abs(buffer[idx] || 0);
        const sR = isStereo ? Math.abs(buffer[idx + 1] || 0) : sL;
        sumSq += sL * sL + sR * sR;
        if (sL > maxAbsPeak) maxAbsPeak = sL;
        if (sR > maxAbsPeak) maxAbsPeak = sR;
        count += channels;
      }

      if (count > 0) {
        const rms = Math.sqrt(sumSq / count);
        if (rms > 1e-6) {
          windowRmsList.push(rms);
        }
      }
    }

    if (windowRmsList.length === 0) return defaultProfile;

    windowRmsList.sort((a, b) => a - b);
    const N = windowRmsList.length;

    // 1. Уровень фонового шума (10-й процентиль)
    const noiseRms = windowRmsList[Math.floor(N * 0.1)] || 1e-4;
    const noiseFloorDb = Math.max(-80.0, Math.min(-20.0, 20 * Math.log10(noiseRms)));

    // 2. Отфильтровываем активные голосовые окна (выше шума на +5 dB)
    const voiceThresholdRms = noiseRms * Math.pow(10, 5 / 20);
    const voiceWindows = windowRmsList.filter((rms) => rms >= voiceThresholdRms);

    const quietSpeechRms = voiceWindows.length > 0 ? voiceWindows[Math.floor(voiceWindows.length * 0.15)] : noiseRms * 3.0;
    const loudSpeechRms = voiceWindows.length > 0 ? voiceWindows[Math.floor(voiceWindows.length * 0.85)] : noiseRms * 10.0;

    const quietestSpeechRmsDb = Math.max(-65.0, Math.min(-10.0, 20 * Math.log10(Math.max(1e-5, quietSpeechRms))));
    const loudestSpeechRmsDb = Math.max(-50.0, Math.min(-3.0, 20 * Math.log10(Math.max(1e-4, loudSpeechRms))));
    const peakDb = Math.max(-60.0, Math.min(0.0, 20 * Math.log10(Math.max(1e-5, maxAbsPeak))));
    const snrDb = Math.max(0, loudestSpeechRmsDb - noiseFloorDb);

    // 3. Вычисление оптимального порога отсечки тишины
    let optimalThresholdDb = -40.0;
    if (quietestSpeechRmsDb > noiseFloorDb + 4.0) {
      const dynamicThresh = noiseFloorDb + (quietestSpeechRmsDb - noiseFloorDb) * 0.35;
      optimalThresholdDb = Math.min(quietestSpeechRmsDb - 2.5, Math.max(noiseFloorDb + 2.0, dynamicThresh));
    } else {
      optimalThresholdDb = noiseFloorDb + 3.0;
    }
    optimalThresholdDb = Math.max(-56.0, Math.min(-24.0, optimalThresholdDb));

    // 4. Оптимальная пауза и буферизация
    const optimalMinSilenceMs = snrDb > 25 ? 260 : snrDb > 15 ? 280 : 320;
    const optimalPaddingMs = snrDb > 20 ? 55 : 70;

    return {
      trackId: track.id,
      trackName: track.name,
      noiseFloorDb: Math.round(noiseFloorDb * 10) / 10,
      quietestSpeechRmsDb: Math.round(quietestSpeechRmsDb * 10) / 10,
      loudestSpeechRmsDb: Math.round(loudestSpeechRmsDb * 10) / 10,
      peakDb: Math.round(peakDb * 10) / 10,
      snrDb: Math.round(snrDb * 10) / 10,
      optimalThresholdDb: Math.round(optimalThresholdDb * 10) / 10,
      optimalMinSilenceMs,
      optimalPaddingMs
    };
  }

  /**
   * Адаптивное удаление тишины и нарезка на фразы для конкретной дорожки на основе её акустического профиля
   */
  public stripSilenceAdaptiveFromTrack(
    track: TrackState,
    sampleRate: number = 48000
  ): { updatedTrack: TrackState; profile: TrackAcousticProfile; phraseCount: number } {
    const profile = this.analyzeTrackAcousticProfile(track, sampleRate);
    const updatedTrack = this.stripSilenceFromTrack(
      track,
      profile.optimalThresholdDb,
      profile.optimalMinSilenceMs,
      profile.optimalPaddingMs,
      sampleRate
    );
    const phraseCount = toSafeArray(updatedTrack.clips).length;
    return { updatedTrack, profile, phraseCount };
  }

  /**
   * Адаптивное удаление тишины для всех дорожек проекта (с индивидуальной авто-настройкой параметров)
   */
  public stripSilenceAdaptiveAllTracks(
    tracks: TrackState[],
    sampleRate: number = 48000
  ): { updatedTracks: TrackState[]; profiles: TrackAcousticProfile[]; totalPhrases: number } {
    const safeTracks = toSafeArray<TrackState>(tracks);
    const profiles: TrackAcousticProfile[] = [];
    let totalPhrases = 0;

    const updatedTracks = safeTracks.map((t) => {
      if (t.isOriginalAudio || /оригинал|original|видео|video/i.test(t.name)) {
        return t;
      }
      const res = this.stripSilenceAdaptiveFromTrack(t, sampleRate);
      profiles.push(res.profile);
      totalPhrases += res.phraseCount;
      return res.updatedTrack;
    });

    return { updatedTracks, profiles, totalPhrases };
  }

  /**
   * Нарезка длинного аудиофайла дорожки на отдельные голосовые фразы с адаптивным удалением тишины
   */
  public sliceTrackIntoPhrases(
    track: TrackState,
    sampleRate: number = 48000,
    forceReslice: boolean = false
  ): ClipConfig[] {
    const safeClips = toSafeArray<ClipConfig>(track.clips);
    if (safeClips.length === 0) return [];

    // Если на дорожке уже несколько нарезанных клипов и не запрошен принудительный перерасчет — возвращаем их
    if (safeClips.length > 1 && !forceReslice) {
      return [...safeClips].sort((a, b) => a.offsetSamples - b.offsetSamples);
    }

    const firstClip = safeClips[0];
    const buffer = firstClip.untrimmedBuffer || firstClip.buffer;
    if (!buffer || buffer.length === 0) return safeClips;

    // Определение количества каналов (стерео или моно)
    const totalFrames = firstClip.lengthSamples || Math.floor(buffer.length / 2);
    const isStereo = buffer.length >= totalFrames * 1.5;
    const channels = isStereo ? 2 : 1;
    const durationSec = buffer.length / (channels * sampleRate);

    // Получаем индивидуальный профиль дорожки (уровень шума, тихой речи и оптимальный порог)
    const profile = this.analyzeTrackAcousticProfile(track, sampleRate);

    // Детекция пауз и голосовых сегментов через C++ WASM ядро с адаптивным порогом
    try {
      let segments = globalNativeDAWBridge.stripSilenceNative(
        buffer,
        profile.optimalThresholdDb,
        profile.optimalMinSilenceMs,
        profile.optimalPaddingMs,
        isStereo,
        sampleRate
      );

      // Если на аудио длиннее 4 секунд не удалось найти несколько сегментов, пробуем адаптивные вариации
      if ((!segments || segments.length <= 1) && durationSec > 3.5) {
        const candidateOffsets = [-4.0, +4.0, -8.0, +8.0, -12.0, +12.0];
        for (const offset of candidateOffsets) {
          const testThresh = Math.max(-56.0, Math.min(-24.0, profile.optimalThresholdDb + offset));
          const testSegs = globalNativeDAWBridge.stripSilenceNative(
            buffer,
            testThresh,
            240,
            50,
            isStereo,
            sampleRate
          );
          if (testSegs && testSegs.length > 1) {
            segments = testSegs;
            break;
          }
        }
      }

      // Если все еще 1 сегмент, вызываем прямой адаптивный VAD fallback
      if ((!segments || segments.length <= 1) && durationSec > 3.5) {
        const fallbackSegs = globalNativeDAWBridge.stripSilenceFallback(
          buffer,
          profile.optimalThresholdDb,
          profile.optimalMinSilenceMs,
          profile.optimalPaddingMs,
          isStereo,
          sampleRate
        );
        if (fallbackSegs && fallbackSegs.length > 1) {
          segments = fallbackSegs;
        }
      }

      if (segments && segments.length > 0) {
        systemLogger.info(
          'LoudnessAutoAligner',
          `[AutoTiming] Дорожка "${track.name}" успешно сегментирована на ${segments.length} реплик (Шум: ${profile.noiseFloorDb} dB, Тихая речь: ${profile.quietestSpeechRmsDb} dB, Порог: ${profile.optimalThresholdDb} dB).`
        );

        const baseOffsetSamples = firstClip.offsetSamples || 0;

        return segments.map((seg, idx) => {
          const startFrame = seg.offsetSamples;
          const frameLen = seg.lengthSamples;
          const startSample = Math.max(0, Math.min(buffer.length, startFrame * channels));
          const endSample = Math.max(startSample, Math.min(buffer.length, (startFrame + frameLen) * channels));

          // Извлекаем срез PCM буфера для отдельного клипа
          const slicedBuf = buffer.subarray(startSample, endSample);

          return {
            id: Date.now() + idx + Math.floor(Math.random() * 1000),
            name: `${track.name} [Фраза #${idx + 1}]`,
            offsetSamples: baseOffsetSamples + startFrame,
            lengthSamples: frameLen,
            gain: 1.0,
            pan: 0,
            fadeInSamples: Math.min(240, Math.floor(sampleRate * 0.005)),
            fadeOutSamples: Math.min(240, Math.floor(sampleRate * 0.005)),
            buffer: new Float32Array(slicedBuf),
            untrimmedBuffer: buffer,
            trimStartSamples: startFrame,
            color: track.color
          };
        });
      }
    } catch (e) {
      console.warn(`[AutoTiming] Фоллбек сегментации для ${track.name}:`, e);
    }

    return safeClips;
  }

  /**
   * Удаление тишины и нарезка на фразы для конкретной дорожки с обновлением клипов
   */
  public stripSilenceFromTrack(
    track: TrackState,
    thresholdDb: number = -40.0,
    minSilenceMs: number = 280.0,
    paddingMs: number = 60.0,
    sampleRate: number = 48000
  ): TrackState {
    const safeClips = toSafeArray<ClipConfig>(track.clips);
    if (safeClips.length === 0) return track;

    const sourceClip = safeClips[0];
    const buffer = sourceClip.untrimmedBuffer || sourceClip.buffer;
    if (!buffer || buffer.length === 0) return track;

    const totalFrames = sourceClip.lengthSamples || Math.floor(buffer.length / 2);
    const isStereo = buffer.length >= totalFrames * 1.5;
    const channels = isStereo ? 2 : 1;
    const baseOffsetSamples = sourceClip.offsetSamples || 0;

    let segments = globalNativeDAWBridge.stripSilenceNative(
      buffer,
      thresholdDb,
      minSilenceMs,
      paddingMs,
      isStereo,
      sampleRate
    );

    const durationSec = totalFrames / sampleRate;

    // Если C++ вернул 0 или 1 цельный кусок на аудио длиннее 2.5 сек,
    // используем адаптивный fallback VAD
    if ((!segments || segments.length <= 1) && durationSec > 2.5) {
      segments = globalNativeDAWBridge.stripSilenceFallback(
        buffer,
        thresholdDb,
        minSilenceMs,
        paddingMs,
        isStereo,
        sampleRate
      );
    }

    if (!segments || segments.length === 0) return track;

    const newClips: ClipConfig[] = segments.map((seg, idx) => {
      const startFrame = seg.offsetSamples;
      const frameLen = seg.lengthSamples;
      const startSample = Math.max(0, Math.min(buffer.length, startFrame * channels));
      const endSample = Math.max(startSample, Math.min(buffer.length, (startFrame + frameLen) * channels));
      const slicedBuf = buffer.subarray(startSample, endSample);

      return {
        id: Date.now() + idx + Math.floor(Math.random() * 1000),
        name: `${track.name} [Фраза #${idx + 1}]`,
        offsetSamples: baseOffsetSamples + startFrame,
        lengthSamples: frameLen,
        gain: 1.0,
        pan: 0,
        fadeInSamples: Math.min(240, Math.floor(sampleRate * 0.005)),
        fadeOutSamples: Math.min(240, Math.floor(sampleRate * 0.005)),
        buffer: new Float32Array(slicedBuf),
        untrimmedBuffer: buffer,
        trimStartSamples: startFrame,
        color: track.color
      };
    });

    return {
      ...track,
      clips: newClips
    };
  }

  // ==========================================================================
  // 4. СКВОЗНОЙ КОНВЕЙЕР АВТО-ТАЙМИНГА И РАЗВЕДЕНИЯ КОЛЛИЗИЙ
  // ==========================================================================

  /**
   * Запуск полного пайплайна:
   * 1. Сопоставление актёров и дорожек.
   * 2. Выстраивание начала каждой фразы по началу субтитра.
   * 3. Проверка и устранение коллизий (с сохранением сценарных перекрытий).
   * 4. Если субтитры отсутствуют — выполняет адаптивную нарезку тишины и каскадное
   *    разведение перекрытий между дорожками дублеров!
   */
  public runAutoTimingPipeline(
    tracks: TrackState[],
    subtitles: SubtitleCue[],
    sampleRate: number = 48000,
    minSeparationSec: number = 0.08 // 80 миллисекунд естественной паузы между фразами
  ): AutoTimingResult {
    const logs: string[] = [];
    const alignmentDetails: PhraseAlignmentDetail[] = [];
    const safeSubtitles = toSafeArray<SubtitleCue>(subtitles).sort((a, b) => a.startSec - b.startSec);
    let workingTracks = toSafeArray<TrackState>(tracks).map((t) => ({
      ...t,
      clips: [...toSafeArray<ClipConfig>(t.clips)]
    }));

    // ЕСЛИ СУБТИТРЫ НЕ ЗАГРУЖЕНЫ:
    // Автоматически нарезаем все дорожки на фразы (VAD Strip Silence)
    // и каскадно разводим наезды между дорожками дикторов!
    if (safeSubtitles.length === 0) {
      logs.push('[AutoTiming] Субтитры не загружены: запуск адаптивного разделения фраз и разведения коллизий между дорожками...');
      
      let totalSlicedPhrases = 0;
      workingTracks = workingTracks.map((t) => {
        if (t.isOriginalAudio || /оригинал|original|видео|video/i.test(t.name)) {
          return t;
        }
        const res = this.stripSilenceAdaptiveFromTrack(t, sampleRate);
        totalSlicedPhrases += res.phraseCount;
        return res.updatedTrack;
      });

      // Каскадный ресолвер коллизий между всеми фразами всех дорожек дубляжа
      interface DubberPhrase {
        trackId: number;
        clip: ClipConfig;
        startSec: number;
        endSec: number;
        durationSec: number;
      }

      const allPhrases: DubberPhrase[] = [];
      workingTracks.forEach((t) => {
        if (t.isOriginalAudio || /оригинал|original|видео|video/i.test(t.name)) return;
        toSafeArray(t.clips).forEach((c) => {
          const startSec = (c.offsetSamples || 0) / sampleRate;
          const durSec = (c.lengthSamples || 0) / sampleRate;
          allPhrases.push({
            trackId: t.id,
            clip: c,
            startSec,
            endSec: startSec + durSec,
            durationSec: durSec
          });
        });
      });

      allPhrases.sort((a, b) => a.startSec - b.startSec);
      let resolvedCount = 0;

      for (let pass = 0; pass < 10; pass++) {
        let changed = false;
        for (let i = 0; i < allPhrases.length; i++) {
          for (let j = i + 1; j < allPhrases.length; j++) {
            const pA = allPhrases[i];
            const pB = allPhrases[j];

            if (pB.startSec >= pA.endSec + minSeparationSec) {
              break;
            }

            // Наезд между репликами: сдвигаем pB вперед
            const requiredStart = pA.endSec + minSeparationSec;
            if (pB.startSec < requiredStart) {
              pB.startSec = Number(requiredStart.toFixed(3));
              pB.endSec = Number((pB.startSec + pB.durationSec).toFixed(3));
              pB.clip.offsetSamples = Math.round(pB.startSec * sampleRate);
              resolvedCount++;
              changed = true;
            }
          }
        }
        if (!changed) break;
        allPhrases.sort((a, b) => a.startSec - b.startSec);
      }

      // Применяем смещения клипов обратно к дорожкам
      workingTracks = workingTracks.map((t) => {
        const trackClips = allPhrases.filter((p) => p.trackId === t.id).map((p) => p.clip);
        if (trackClips.length > 0) {
          return { ...t, clips: trackClips };
        }
        return t;
      });

      logs.push(`[AutoTiming] Успешно нарезано ${totalSlicedPhrases} фраз, устранено ${resolvedCount} наездов между репликами.`);

      return {
        updatedTracks: workingTracks,
        actorMappings: [],
        totalPhrasesAligned: totalSlicedPhrases,
        resolvedCollisionsCount: resolvedCount,
        preservedScriptOverlapsCount: 0,
        alignmentDetails: [],
        logs
      };
    }

    logs.push(`[AutoTiming] Запуск анализа тайминга: ${safeSubtitles.length} реплик субтитров.`);

    // 1. Сопоставление актёров
    const mappings = this.matchActorsToTracks(safeSubtitles, workingTracks);
    mappings.forEach((m) => {
      logs.push(
        `[AutoTiming] Актёр "${m.speaker}" $\\rightarrow$ Дорожка "${m.trackName}" (CH ${m.trackId}, Уверенность: ${(m.confidence * 100).toFixed(0)}%)`
      );
    });

    // Создаем недостающие дорожки для неназначенных спикеров
    const trackIds = workingTracks.map((t) => t.id);
    let nextTrackId = trackIds.length > 0 ? Math.max(...trackIds) + 1 : 1;

    mappings.forEach((m) => {
      if (m.status === 'unmatched') {
        const newTrack = createNewTrack(nextTrackId, `CH #${nextTrackId}: ${m.speaker} (Дубляж)`);
        workingTracks.push(newTrack);
        m.trackId = nextTrackId;
        m.trackName = newTrack.name;
        m.status = 'created';
        nextTrackId++;
        logs.push(`[AutoTiming] Создана новая дорожка CH ${m.trackId} для актёра "${m.speaker}".`);
      }
    });

    // 2. Сегментация дорожек и первоначальная привязка к субтитрам
    interface PositionedPhrase {
      speaker: string;
      cue: SubtitleCue;
      trackId: number;
      clip: ClipConfig;
      scheduledStartSec: number;
      durationSec: number;
      scheduledEndSec: number;
    }

    const allPositionedPhrases: PositionedPhrase[] = [];

    mappings.forEach((mapping) => {
      const actorCues = safeSubtitles.filter((c) => {
        const sp = (c.speaker || '').trim();
        if (sp) return sp.toLowerCase() === mapping.speaker.toLowerCase();
        return c.text && c.text.toLowerCase().includes(mapping.speaker.toLowerCase());
      });

      if (actorCues.length === 0) return;

      const trackIndex = workingTracks.findIndex((t) => t.id === mapping.trackId);
      if (trackIndex === -1) return;

      const track = workingTracks[trackIndex];
      const phrases = this.sliceTrackIntoPhrases(track, sampleRate);

      actorCues.forEach((cue, cueIdx) => {
        let phraseClip: ClipConfig | null = null;

        if (cueIdx < phrases.length) {
          phraseClip = phrases[cueIdx];
        } else if (phrases.length > 0) {
          // Если фраз меньше чем сабов, клонируем структуру клипа
          const baseClip = phrases[phrases.length - 1];
          phraseClip = {
            ...baseClip,
            id: Date.now() + cue.index + Math.floor(Math.random() * 1000)
          };
        }

        if (phraseClip) {
          const durationSec = phraseClip.lengthSamples / sampleRate;
          const targetStartSec = Math.max(0, cue.startSec);
          const targetOffsetSamples = Math.round(targetStartSec * sampleRate);

          const updatedClip: ClipConfig = {
            ...phraseClip,
            name: `[${mapping.speaker} #${cue.index}] ${cue.text.substring(0, 24)}...`,
            offsetSamples: targetOffsetSamples
          };

          allPositionedPhrases.push({
            speaker: mapping.speaker,
            cue,
            trackId: mapping.trackId,
            clip: updatedClip,
            scheduledStartSec: targetStartSec,
            durationSec,
            scheduledEndSec: targetStartSec + durationSec
          });
        }
      });
    });

    logs.push(`[AutoTiming] Выровнено ${allPositionedPhrases.length} фраз по таймкодам начала субтитров.`);

    // 3. Проектный анализ и устранение нежелательных коллизий
    let resolvedCollisionsCount = 0;
    let preservedScriptOverlapsCount = 0;

    // Сортируем все фразы проекта хронологически по времени старта
    allPositionedPhrases.sort((a, b) => a.scheduledStartSec - b.scheduledStartSec);

    // Многопроходный каскадный ресолвер коллизий (до 10 проходов для полного устранения каскадных наездов)
    const MAX_PASSES = 10;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let changedInPass = false;

      for (let i = 0; i < allPositionedPhrases.length; i++) {
        for (let j = i + 1; j < allPositionedPhrases.length; j++) {
          const phraseA = allPositionedPhrases[i];
          const phraseB = allPositionedPhrases[j];

          // Если фраза B начинается значительно позже окончания A — дальше в этом цикле наездов нет
          if (phraseB.scheduledStartSec >= phraseA.scheduledEndSec + minSeparationSec) {
            break;
          }

          const isSameTrack = phraseA.trackId === phraseB.trackId;
          const isIntentionalOverlap = !isSameTrack && this.isScriptOverlap(phraseA.cue, phraseB.cue);

          if (isIntentionalOverlap) {
            // Разрешённое сценарное перекрытие: оба актёра говорят одновременно в сценарии
            if (pass === 0) {
              preservedScriptOverlapsCount++;
            }
            continue;
          }

          // Нежелательная коллизия: в субтитрах фраза B должна звучать отдельно от A, но накладывается!
          const requiredStartSec = phraseA.scheduledEndSec + minSeparationSec;
          if (phraseB.scheduledStartSec < requiredStartSec) {
            const shiftDelta = requiredStartSec - phraseB.scheduledStartSec;
            phraseB.scheduledStartSec = Number(requiredStartSec.toFixed(3));
            phraseB.scheduledEndSec = Number((phraseB.scheduledStartSec + phraseB.durationSec).toFixed(3));
            phraseB.clip.offsetSamples = Math.round(phraseB.scheduledStartSec * sampleRate);

            resolvedCollisionsCount++;
            changedInPass = true;

            alignmentDetails.push({
              cueIndex: phraseB.cue.index,
              speaker: phraseB.speaker,
              trackId: phraseB.trackId,
              clipId: phraseB.clip.id,
              originalSubtitleStartSec: phraseB.cue.startSec,
              originalSubtitleEndSec: phraseB.cue.endSec,
              initialAudioStartSec: phraseB.cue.startSec,
              finalAudioStartSec: phraseB.scheduledStartSec,
              finalAudioEndSec: phraseB.scheduledEndSec,
              durationSec: phraseB.durationSec,
              shiftDeltaSec: Number(shiftDelta.toFixed(3)),
              collisionResolvedWith: `Фраза #${phraseA.cue.index} [${phraseA.speaker}]`,
              isIntentionalScriptOverlap: false
            });
          }
        }
      }

      if (!changedInPass) break;
      // Пересортировываем после сдвигов
      allPositionedPhrases.sort((a, b) => a.scheduledStartSec - b.scheduledStartSec);
    }

    // 4. Сборка обновленных клипов по дорожкам проекта
    workingTracks = workingTracks.map((track) => {
      const trackPhrases = allPositionedPhrases
        .filter((p) => p.trackId === track.id)
        .map((p) => p.clip);

      return {
        ...track,
        clips: trackPhrases.length > 0 ? trackPhrases : track.clips
      };
    });

    logs.push(
      `[AutoTiming] Проект успешно собран: ${allPositionedPhrases.length} фраз синхронизировано, ${resolvedCollisionsCount} нежелательных наездов разведено, ${preservedScriptOverlapsCount} сценарных одновременных реплик сохранено.`
    );

    systemLogger.info(
      'MVPPipeline',
      `Авто-тайминг завершён: Синхронизировано фраз=${allPositionedPhrases.length}, Разведено коллизий=${resolvedCollisionsCount}, Сохранено сценарных перекрытий=${preservedScriptOverlapsCount}`
    );

    return {
      updatedTracks: workingTracks,
      actorMappings: mappings,
      totalPhrasesAligned: allPositionedPhrases.length,
      resolvedCollisionsCount,
      preservedScriptOverlapsCount,
      alignmentDetails,
      logs
    };
  }
}

export const globalAutoTimingService = AutoTimingService.getInstance();
