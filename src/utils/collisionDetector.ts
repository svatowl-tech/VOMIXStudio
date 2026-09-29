/**
 * ============================================================================
 * COLLISION & OVERLAP DETECTOR FOR DUBBING TRACKS
 * ============================================================================
 * Модуль детекции коллизий, наездов и перекрытий фраз между дикторскими
 * дорожками и внутри одной дорожки на таймлайне.
 * 
 * Логика разделения коллизий:
 * 1. Массовые перекрытия (3 и более дорожек звучат одновременно):
 *    - Считаются сценарными/групповыми сценами (хор, толпа, гур-гур, совместный крик).
 *    - СОХРАНЯЮТСЯ БЕЗ ИЗМЕНЕНИЙ (не разводятся).
 * 2. Парные коллизии (ровно 2 фразы наезжают друг на друга):
 *    - Считаются случайным наездом двух даберов.
 *    - РАЗВОДЯТСЯ: фраза, начавшаяся позже, сдвигается за окончание первой + микропауза.
 * 3. Не затронутые дорожки (где нет коллизий) НЕ ТРОГАЮТСЯ и не подвергаются сдвигам или нарезке.
 * ============================================================================
 */

import { TrackState, ClipConfig } from '../audio/dawEngine';

export interface ClipCollisionInfo {
  id: string;
  trackAId: number;
  trackAName: string;
  clipAId: number;
  clipAName: string;
  trackBId: number;
  trackBName: string;
  clipBId: number;
  clipBName: string;
  overlapStartSec: number;
  overlapEndSec: number;
  overlapDurationSec: number;
  type: 'cross_track_overlap' | 'same_track_overlap';
  isMassiveOverlap: boolean;    // true если 3 и более дорожек звучат в этот момент
  involvedTrackCount: number;  // Общее количество дорожек в интервале
}

export function isNonSpeechOrOriginalTrack(track: TrackState | { name: string; isOriginalAudio?: boolean }): boolean {
  if (!track) return false;
  if (track.isOriginalAudio) return true;
  const name = (track.name || '').toLowerCase();
  return /оригинал|original|видео|video|исходн|музыка|music|фонограмм|m&e|sfx|soundtrack|звук видео/i.test(name);
}

interface FlatClipInfo {
  trackId: number;
  trackName: string;
  clip: ClipConfig;
  startSec: number;
  endSec: number;
}

/**
 * Поиск всех наездов фраз с классификацией (парные vs массовые 3+ дорожки)
 */
export function detectTrackCollisions(tracks: TrackState[], sampleRate: number = 48000): ClipCollisionInfo[] {
  const collisions: ClipCollisionInfo[] = [];
  const allClipsInfo: FlatClipInfo[] = [];

  // Собираем все клипы с активных дикторских дорожек
  (tracks || []).forEach((track) => {
    if (!track || track.mute) return;
    if (isNonSpeechOrOriginalTrack(track)) return;

    (track.clips || []).forEach((clip) => {
      if (!clip || clip.lengthSamples <= 0) return;
      const startSec = (clip.offsetSamples || 0) / sampleRate;
      const endSec = startSec + clip.lengthSamples / sampleRate;
      allClipsInfo.push({
        trackId: track.id,
        trackName: track.name,
        clip,
        startSec,
        endSec
      });
    });
  });

  // Проверяем все пары клипов
  for (let i = 0; i < allClipsInfo.length; i++) {
    for (let j = i + 1; j < allClipsInfo.length; j++) {
      const itemA = allClipsInfo[i];
      const itemB = allClipsInfo[j];

      const overlapStart = Math.max(itemA.startSec, itemB.startSec);
      const overlapEnd = Math.min(itemA.endSec, itemB.endSec);
      const overlapDuration = overlapEnd - overlapStart;

      // Порог наезда: более 0.06 сек (60 миллисекунд)
      if (overlapDuration > 0.06) {
        const isSameTrack = itemA.trackId === itemB.trackId;

        // Определяем, сколько различных дикторских дорожек активно в этом интервале
        const activeTracks = new Set<number>([itemA.trackId, itemB.trackId]);
        for (const other of allClipsInfo) {
          if (other.trackId !== itemA.trackId && other.trackId !== itemB.trackId) {
            const oStart = Math.max(other.startSec, overlapStart);
            const oEnd = Math.min(other.endSec, overlapEnd);
            if (oEnd - oStart > 0.06) {
              activeTracks.add(other.trackId);
            }
          }
        }

        const involvedTrackCount = activeTracks.size;
        const isMassiveOverlap = !isSameTrack && involvedTrackCount >= 3;

        collisions.push({
          id: `col_${itemA.clip.id}_${itemB.clip.id}_${Math.round(overlapStart * 100)}`,
          trackAId: itemA.trackId,
          trackAName: itemA.trackName,
          clipAId: itemA.clip.id,
          clipAName: itemA.clip.name || `Клип #${itemA.clip.id}`,
          trackBId: itemB.trackId,
          trackBName: itemB.trackName,
          clipBId: itemB.clip.id,
          clipBName: itemB.clip.name || `Клип #${itemB.clip.id}`,
          overlapStartSec: Number(overlapStart.toFixed(3)),
          overlapEndSec: Number(overlapEnd.toFixed(3)),
          overlapDurationSec: Number(overlapDuration.toFixed(3)),
          type: isSameTrack ? 'same_track_overlap' : 'cross_track_overlap',
          isMassiveOverlap,
          involvedTrackCount
        });
      }
    }
  }

  return collisions;
}

export interface CollisionResolutionResult {
  updatedTracks: TrackState[];
  resolvedPairwiseCount: number;
  preservedMassiveCount: number;
  affectedTrackIds: number[];
  logs: string[];
}

/**
 * Интеллектуальное разведение коллизий (для режима БЕЗ субтитров или прямой коррекции):
 * 1. Массовые коллизии (3+ дорожки) СОХРАНЯЮТСЯ (не разводятся).
 * 2. Парные коллизии (2 дорожки) РАЗВОДЯТСЯ:
 *    - Сдвигается исключительно клип, который начался позже.
 *    - Если на его дорожке есть последующие клипы, они сдвигаются ровно настолько,
 *      чтобы не допустить наезда внутри одной дорожки.
 * 3. Все остальные дорожки и неконфликтующие клипы остаются 100% нетронутыми!
 */
export function resolvePairwiseCollisions(
  tracks: TrackState[],
  sampleRate: number = 48000,
  minSeparationSec: number = 0.08,
  targetTrackId?: number
): CollisionResolutionResult {
  const logs: string[] = [];
  const affectedTrackIds = new Set<number>();
  let resolvedPairwiseCount = 0;
  let preservedMassiveCount = 0;
  const notedMassiveIntervals = new Set<string>();

  // Глубокое клонирование только клипов и дорожек
  let workingTracks: TrackState[] = (tracks || []).map((t) => ({
    ...t,
    clips: [...(t.clips || [])].map((c) => ({ ...c }))
  }));

  const MAX_PASSES = 12;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    interface TrackClipRef {
      trackId: number;
      trackName: string;
      clip: ClipConfig;
      startSec: number;
      endSec: number;
      durationSec: number;
    }

    const speechClips: TrackClipRef[] = [];
    workingTracks.forEach((t) => {
      if (!t || t.mute || isNonSpeechOrOriginalTrack(t)) return;
      (t.clips || []).forEach((c) => {
        if (!c || c.lengthSamples <= 0) return;
        const startSec = (c.offsetSamples || 0) / sampleRate;
        const durSec = (c.lengthSamples || 0) / sampleRate;
        speechClips.push({
          trackId: t.id,
          trackName: t.name,
          clip: c,
          startSec,
          endSec: startSec + durSec,
          durationSec: durSec
        });
      });
    });

    let changedInPass = false;
    speechClips.sort((a, b) => a.startSec - b.startSec);

    for (let i = 0; i < speechClips.length; i++) {
      for (let j = i + 1; j < speechClips.length; j++) {
        const itemA = speechClips[i];
        const itemB = speechClips[j];

        // Если itemB начинается строго позже окончания itemA с запасом, наездов между ними нет
        if (itemB.startSec >= itemA.endSec - 0.005) {
          if (itemA.trackId !== itemB.trackId) {
            break;
          }
        }

        const overlapStart = Math.max(itemA.startSec, itemB.startSec);
        const overlapEnd = Math.min(itemA.endSec, itemB.endSec);
        const overlapDur = overlapEnd - overlapStart;

        if (overlapDur > 0.06) {
          // Если на разных дорожках:
          if (itemA.trackId !== itemB.trackId) {
            // Подсчет активных дорожек в зоне наезда
            const activeTrackIds = new Set<number>([itemA.trackId, itemB.trackId]);
            for (const other of speechClips) {
              if (other.trackId !== itemA.trackId && other.trackId !== itemB.trackId) {
                const oStart = Math.max(other.startSec, overlapStart);
                const oEnd = Math.min(other.endSec, overlapEnd);
                if (oEnd - oStart > 0.06) {
                  activeTrackIds.add(other.trackId);
                }
              }
            }

            // МАССОВАЯ КОЛЛИЗИЯ (3 и более дорожек):
            // Пользовательское правило: оставлять массовые моменты без изменений!
            if (activeTrackIds.size >= 3) {
              const key = `${Math.round(overlapStart * 5)}_${Math.round(overlapEnd * 5)}`;
              if (!notedMassiveIntervals.has(key)) {
                notedMassiveIntervals.add(key);
                preservedMassiveCount++;
                logs.push(
                  `[Детектор коллизий] Массовая сцена (${activeTrackIds.size} дорожки на ${overlapStart.toFixed(2)}с): сохранена без изменений.`
                );
              }
              continue; // Не разводим!
            }

            // ПАРНАЯ КОЛЛИЗИЯ (ровно 2 дорожки):
            if (targetTrackId !== undefined && itemA.trackId !== targetTrackId && itemB.trackId !== targetTrackId) {
              continue;
            }

            // itemA началась раньше (так как список отсортирован по startSec).
            // Сдвигаем itemB за пределы itemA!
            const requiredStartSec = Number((itemA.endSec + minSeparationSec).toFixed(3));
            if (itemB.startSec < requiredStartSec) {
              const deltaSec = requiredStartSec - itemB.startSec;
              itemB.startSec = requiredStartSec;
              itemB.endSec = Number((itemB.startSec + itemB.durationSec).toFixed(3));
              itemB.clip.offsetSamples = Math.round(itemB.startSec * sampleRate);

              affectedTrackIds.add(itemB.trackId);
              resolvedPairwiseCount++;
              changedInPass = true;

              logs.push(
                `[Детектор коллизий] Разведен наезд: фраза «${itemB.clip.name || 'Клип'}» (Дорожка CH #${itemB.trackId}) сдвинута на +${deltaSec.toFixed(2)}с после CH #${itemA.trackId}.`
              );

              // Каскадный сдвиг последующих клипов только на дорожке itemB!
              const trackFollowerClips = speechClips
                .filter((c) => c.trackId === itemB.trackId)
                .sort((a, b) => a.startSec - b.startSec);

              for (let k = 0; k < trackFollowerClips.length - 1; k++) {
                const c1 = trackFollowerClips[k];
                const c2 = trackFollowerClips[k + 1];
                const minC2Start = Number((c1.endSec + minSeparationSec).toFixed(3));
                if (c2.startSec < minC2Start) {
                  c2.startSec = minC2Start;
                  c2.endSec = Number((c2.startSec + c2.durationSec).toFixed(3));
                  c2.clip.offsetSamples = Math.round(c2.startSec * sampleRate);
                  changedInPass = true;
                }
              }
            }
          } else {
            // Наезд клипов на одной и той же дорожке (same track overlap)
            const requiredStartSec = Number((itemA.endSec + minSeparationSec).toFixed(3));
            if (itemB.startSec < requiredStartSec) {
              const deltaSec = requiredStartSec - itemB.startSec;
              itemB.startSec = requiredStartSec;
              itemB.endSec = Number((itemB.startSec + itemB.durationSec).toFixed(3));
              itemB.clip.offsetSamples = Math.round(itemB.startSec * sampleRate);

              affectedTrackIds.add(itemB.trackId);
              resolvedPairwiseCount++;
              changedInPass = true;

              logs.push(
                `[Детектор коллизий] Устранен наезд внутри дорожки CH #${itemB.trackId}: клип сдвинут на +${deltaSec.toFixed(2)}с.`
              );
            }
          }
        }
      }
    }

    if (!changedInPass) break;
  }

  // Применяем изменения только к тем дорожкам, где были реальные коллизии!
  // Неконфликтующие дорожки возвращаются без изменений!
  const finalTracks = workingTracks.map((t) => {
    if (!affectedTrackIds.has(t.id)) {
      const orig = tracks.find((ot) => ot.id === t.id);
      return orig || t;
    }
    return t;
  });

  return {
    updatedTracks: finalTracks,
    resolvedPairwiseCount,
    preservedMassiveCount,
    affectedTrackIds: Array.from(affectedTrackIds),
    logs
  };
}
