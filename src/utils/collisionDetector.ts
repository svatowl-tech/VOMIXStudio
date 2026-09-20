/**
 * ============================================================================
 * COLLISION & OVERLAP DETECTOR FOR DUBBING TRACKS
 * ============================================================================
 * Модуль детекции коллизий, наездов и перекрытий фраз между дикторскими
 * дорожками и внутри одной дорожки на таймлайне.
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
}

export function detectTrackCollisions(tracks: TrackState[], sampleRate: number = 48000): ClipCollisionInfo[] {
  const collisions: ClipCollisionInfo[] = [];

  // Собираем все клипы со всех дорожек с вычислением временных интервалов
  interface FlatClipInfo {
    trackId: number;
    trackName: string;
    clip: ClipConfig;
    startSec: number;
    endSec: number;
  }

  const allClipsInfo: FlatClipInfo[] = [];

  tracks.forEach((track) => {
    // Пропускаем замутированные дорожки
    if (track.mute) return;

    (track.clips || []).forEach((clip) => {
      if (!clip || clip.lengthSamples <= 0) return;
      const startSec = clip.offsetSamples / sampleRate;
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

      // Вычисляем пересечение интервалов [startA, endA] и [startB, endB]
      const overlapStart = Math.max(itemA.startSec, itemB.startSec);
      const overlapEnd = Math.min(itemA.endSec, itemB.endSec);
      const overlapDuration = overlapEnd - overlapStart;

      // Порог наезда: более 0.05 сек (50 миллисекунд)
      if (overlapDuration > 0.05) {
        const isSameTrack = itemA.trackId === itemB.trackId;

        // Игнорируем наезды с фонограммой/музыкой если они на разных треках,
        // фокус только на дикторских дорожках и наложениях внутри дорожек
        const isMusicA = itemA.trackName.toLowerCase().includes('музыка') || itemA.trackName.toLowerCase().includes('m&e');
        const isMusicB = itemB.trackName.toLowerCase().includes('музыка') || itemB.trackName.toLowerCase().includes('m&e');

        if (!isSameTrack && (isMusicA || isMusicB)) {
          continue;
        }

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
          overlapStartSec: overlapStart,
          overlapEndSec: overlapEnd,
          overlapDurationSec: overlapDuration,
          type: isSameTrack ? 'same_track_overlap' : 'cross_track_overlap'
        });
      }
    }
  }

  return collisions;
}
