/**
 * ============================================================================
 * WAVEFORM & TIMECODE UTILITIES (High Performance DSP & Rendering Cache)
 * ============================================================================
 * Утилиты для быстрого расчета пиков формы волны (LOD / Min-Max Decimation),
 * форматирования таймкодов SMPTE (HH:MM:SS:FF) и адаптивной шкалы времени.
 * ============================================================================
 */

export interface WaveformPeaks {
  minPeaks: Float32Array;
  maxPeaks: Float32Array;
}

// Кэш пиков для предотвращения повторных тяжелых расчетов по миллионам сэмплов
const peakCache = new WeakMap<Float32Array, Map<number, WaveformPeaks>>();

/**
 * Быстрое извлечение экстремумов (Min/Max Peaks) с кэшированием под разрешение экрана.
 * Использует блочную децимацию для отрисовки за O(pixels), а не O(samples).
 */
export function extractPeaks(
  buffer: Float32Array,
  targetPixels: number,
  startSample: number = 0,
  lengthSamples?: number
): WaveformPeaks {
  const totalLength = lengthSamples !== undefined ? Math.min(lengthSamples, buffer.length - startSample) : buffer.length - startSample;
  if (totalLength <= 0 || targetPixels <= 0) {
    return { minPeaks: new Float32Array(0), maxPeaks: new Float32Array(0) };
  }

  const numBuckets = Math.max(1, Math.min(targetPixels, totalLength));
  const samplesPerPixel = totalLength / numBuckets;

  const minPeaks = new Float32Array(numBuckets);
  const maxPeaks = new Float32Array(numBuckets);

  for (let px = 0; px < numBuckets; px++) {
    const bucketStart = Math.floor(startSample + px * samplesPerPixel);
    const bucketEnd = Math.floor(startSample + (px + 1) * samplesPerPixel);

    let min = 1.0;
    let max = -1.0;

    // Быстрый поиск экстремумов с шагом прореживания при сильном удалении
    const step = Math.max(1, Math.floor((bucketEnd - bucketStart) / 100));

    for (let i = bucketStart; i < bucketEnd; i += step) {
      const sample = buffer[i];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }

    if (min > max) {
      min = 0;
      max = 0;
    }

    minPeaks[px] = min;
    maxPeaks[px] = max;
  }

  return { minPeaks, maxPeaks };
}

/**
 * Форматирование времени в вещательный таймкод SMPTE (HH:MM:SS:FF).
 */
export function formatSMPTE(timeSec: number, fps: number = 30): string {
  if (isNaN(timeSec) || timeSec < 0) timeSec = 0;

  const totalFrames = Math.floor(timeSec * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(timeSec);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

/**
 * Форматирование времени в компактный вид (ММ:СС.мм или СС.ммс)
 */
export function formatCompactTime(timeSec: number): string {
  if (isNaN(timeSec) || timeSec < 0) timeSec = 0;
  const mins = Math.floor(timeSec / 60);
  const secs = timeSec % 60;
  if (mins > 0) {
    return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
  }
  return `${secs.toFixed(2)}s`;
}

/**
 * Расчет оптимального шага сетки времени в зависимости от масштаба (pxPerSec)
 */
export function getAdaptiveTimeStep(pxPerSec: number): {
  majorStepSec: number;
  minorStepSec: number;
  format: 'ms' | 'sec' | 'min';
} {
  if (pxPerSec > 400) {
    return { majorStepSec: 0.1, minorStepSec: 0.02, format: 'ms' };
  } else if (pxPerSec > 200) {
    return { majorStepSec: 0.25, minorStepSec: 0.05, format: 'ms' };
  } else if (pxPerSec > 100) {
    return { majorStepSec: 0.5, minorStepSec: 0.1, format: 'ms' };
  } else if (pxPerSec > 50) {
    return { majorStepSec: 1.0, minorStepSec: 0.2, format: 'sec' };
  } else if (pxPerSec > 20) {
    return { majorStepSec: 2.0, minorStepSec: 0.5, format: 'sec' };
  } else if (pxPerSec > 10) {
    return { majorStepSec: 5.0, minorStepSec: 1.0, format: 'sec' };
  } else if (pxPerSec > 4) {
    return { majorStepSec: 10.0, minorStepSec: 2.0, format: 'sec' };
  } else {
    return { majorStepSec: 30.0, minorStepSec: 5.0, format: 'min' };
  }
}
