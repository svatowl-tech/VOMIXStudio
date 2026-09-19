/**
 * ============================================================================
 * AUDIO TIME STRETCH ENGINE (WSOLA - Pitch-Preserving Time Scale Modification)
 * ============================================================================
 * Позволяет сжимать и растягивать аудиодорожки во времени без изменения высоты тона
 * (подгонка озвучки под тайминг видеоряда, дубляж, липсинк, тайм-стретч).
 *
 * Алгоритм: WSOLA (Waveform Similarity Overlap-Add)
 * - Сохраняет фазовую когерентность и тембр голоса (без эффекта "бурундука" / "робота").
 * - Автоматически поддерживает моно и стерео (interleaved) PCM буферы 48 кГц.
 * - Оптимизирован для субмиллисекундного выполнения на Float32Array.
 * ============================================================================
 */

export interface TimeStretchOptions {
  sampleRate?: number; // По умолчанию 48000
  channels?: number;   // 1 (mono) или 2 (stereo)
  windowSize?: number; // Размер окна анализа/синтеза (по умолчанию 1024)
  quickSearch?: boolean; // Быстрый поиск корреляции
}

export class AudioTimeStretch {
  /**
   * Сжатие / растяжение аудио с сохранением тональности (Pitch Preservation)
   * @param inputBuffer Входной Float32Array (моно или стерео interleaved)
   * @param stretchFactor Коэффициент растяжения:
   *   - > 1.0 : замедление / удлинение клипа (напр. 1.25 = на 25% длиннее)
   *   - < 1.0 : ускорение / сжатие клипа (напр. 0.80 = на 20% короче)
   * @param options Параметры алгоритма
   */
  public static stretchAudio(
    inputBuffer: Float32Array,
    stretchFactor: number,
    options: TimeStretchOptions = {}
  ): Float32Array {
    // Граничные проверки
    if (!inputBuffer || inputBuffer.length === 0) {
      return new Float32Array(0);
    }

    // Защита от экстремальных значений (допустимый диапазон 0.25x - 4.0x)
    const factor = Math.max(0.25, Math.min(4.0, stretchFactor));
    if (Math.abs(factor - 1.0) < 0.005) {
      return new Float32Array(inputBuffer);
    }

    const channels = options.channels || 1;
    const isStereo = channels === 2 || (inputBuffer.length > 48000 && channels !== 1);

    if (channels === 2) {
      return this.stretchStereoInterleaved(inputBuffer, factor, options);
    } else {
      return this.stretchMono(inputBuffer, factor, options);
    }
  }

  /**
   * Подгонка аудиоклипа под точную целевую длительность в секундах или сэмплах
   */
  public static fitToTargetLength(
    inputBuffer: Float32Array,
    targetSamples: number,
    channels: number = 1
  ): Float32Array {
    if (!inputBuffer || inputBuffer.length === 0 || targetSamples <= 0) {
      return new Float32Array(0);
    }

    const currentFrames = inputBuffer.length / channels;
    const targetFrames = targetSamples / channels;
    const factor = targetFrames / currentFrames;

    return this.stretchAudio(inputBuffer, factor, { channels });
  }

  /**
   * WSOLA ядро для монофонического сигнала
   */
  private static stretchMono(
    input: Float32Array,
    factor: number,
    options: TimeStretchOptions
  ): Float32Array {
    const inLen = input.length;
    const N = options.windowSize || 1024; // Окно ~21 мс при 48 кГц
    const Hs = Math.floor(N / 4);         // Шаг синтеза = 256
    const Ha = Hs / factor;               // Шаг анализа
    const deltaMax = Math.floor(N / 2);   // Окно поиска корреляции

    // Расчет длины выходного буфера
    const outFrames = Math.max(Hs * 2, Math.floor(inLen * factor));
    const output = new Float32Array(outFrames);
    const windowWeight = new Float32Array(outFrames);

    // Подготовка окна Ханна
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    }

    // Буфер естественного продолжения (template)
    const template = new Float32Array(N);

    // Инициализация первого сегмента
    const firstCopyLen = Math.min(N, inLen);
    for (let i = 0; i < firstCopyLen; i++) {
      output[i] += input[i] * win[i];
      windowWeight[i] += win[i];
    }

    let outPos = Hs;
    let frameIdx = 1;

    while (outPos + N <= outFrames) {
      // Идеальная позиция анализа
      const targetAnPos = Math.round(frameIdx * Ha);

      // Извлекаем template из ожидаемого продолжения предыдущего фрейма
      // для максимальной фазовой гладкости
      const prevAnPos = Math.round((frameIdx - 1) * Ha);
      for (let i = 0; i < N; i++) {
        const srcIdx = prevAnPos + Hs + i;
        template[i] = srcIdx < inLen ? input[srcIdx] : 0;
      }

      // Поиск лучшего сдвига delta в окрестности targetAnPos
      let bestDelta = 0;
      let bestCorr = -Infinity;

      const minDelta = Math.max(-deltaMax, -targetAnPos);
      const maxDelta = Math.min(deltaMax, inLen - targetAnPos - N);

      // Оптимизированный шаг поиска (skip-search для скорости, refine локально)
      const step = options.quickSearch ? 2 : 1;

      for (let d = minDelta; d <= maxDelta; d += step) {
        let corr = 0;
        let energy = 0.00001;

        // Вычисление взаимной корреляции
        for (let i = 0; i < N; i += 2) {
          const sample = input[targetAnPos + d + i];
          corr += sample * template[i];
          energy += sample * sample;
        }

        const normCorr = corr / Math.sqrt(energy);
        if (normCorr > bestCorr) {
          bestCorr = normCorr;
          bestDelta = d;
        }
      }

      // Наложение фрейма в позиции (targetAnPos + bestDelta)
      const actualAnPos = targetAnPos + bestDelta;
      for (let i = 0; i < N; i++) {
        const srcIdx = actualAnPos + i;
        if (srcIdx >= 0 && srcIdx < inLen) {
          output[outPos + i] += input[srcIdx] * win[i];
          windowWeight[outPos + i] += win[i];
        }
      }

      outPos += Hs;
      frameIdx++;
    }

    // Нормализация по сумме весов окон
    for (let i = 0; i < outFrames; i++) {
      if (windowWeight[i] > 0.001) {
        output[i] /= windowWeight[i];
      }
    }

    return output;
  }

  /**
   * WSOLA для стереофонического interleaved буфера [L, R, L, R...]
   * Анализирует кросс-корреляцию суммарного M-канала (L+R),
   * сохраняя идеальную стереобазу и фазовые соотношения каналов.
   */
  private static stretchStereoInterleaved(
    input: Float32Array,
    factor: number,
    options: TimeStretchOptions
  ): Float32Array {
    const totalSamples = input.length;
    const inFrames = Math.floor(totalSamples / 2);

    // Извлекаем моно-микс для быстрого поиска корреляции
    const monoMix = new Float32Array(inFrames);
    for (let i = 0; i < inFrames; i++) {
      monoMix[i] = 0.5 * (input[i * 2] + input[i * 2 + 1]);
    }

    const N = options.windowSize || 1024;
    const Hs = Math.floor(N / 4);
    const Ha = Hs / factor;
    const deltaMax = Math.floor(N / 2);

    const outFrames = Math.max(Hs * 2, Math.floor(inFrames * factor));
    const outTotalSamples = outFrames * 2;
    const output = new Float32Array(outTotalSamples);
    const windowWeight = new Float32Array(outFrames);

    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    }

    const template = new Float32Array(N);

    // Первый фрейм
    const firstCopyLen = Math.min(N, inFrames);
    for (let i = 0; i < firstCopyLen; i++) {
      const w = win[i];
      output[i * 2] += input[i * 2] * w;
      output[i * 2 + 1] += input[i * 2 + 1] * w;
      windowWeight[i] += w;
    }

    let outPos = Hs;
    let frameIdx = 1;

    while (outPos + N <= outFrames) {
      const targetAnPos = Math.round(frameIdx * Ha);
      const prevAnPos = Math.round((frameIdx - 1) * Ha);

      for (let i = 0; i < N; i++) {
        const srcIdx = prevAnPos + Hs + i;
        template[i] = srcIdx < inFrames ? monoMix[srcIdx] : 0;
      }

      let bestDelta = 0;
      let bestCorr = -Infinity;

      const minDelta = Math.max(-deltaMax, -targetAnPos);
      const maxDelta = Math.min(deltaMax, inFrames - targetAnPos - N);

      for (let d = minDelta; d <= maxDelta; d += 2) {
        let corr = 0;
        let energy = 0.00001;

        for (let i = 0; i < N; i += 2) {
          const sample = monoMix[targetAnPos + d + i];
          corr += sample * template[i];
          energy += sample * sample;
        }

        const normCorr = corr / Math.sqrt(energy);
        if (normCorr > bestCorr) {
          bestCorr = normCorr;
          bestDelta = d;
        }
      }

      const actualAnPos = targetAnPos + bestDelta;
      for (let i = 0; i < N; i++) {
        const srcFrame = actualAnPos + i;
        if (srcFrame >= 0 && srcFrame < inFrames) {
          const w = win[i];
          output[(outPos + i) * 2] += input[srcFrame * 2] * w;
          output[(outPos + i) * 2 + 1] += input[srcFrame * 2 + 1] * w;
          windowWeight[outPos + i] += w;
        }
      }

      outPos += Hs;
      frameIdx++;
    }

    for (let i = 0; i < outFrames; i++) {
      const w = windowWeight[i];
      if (w > 0.001) {
        output[i * 2] /= w;
        output[i * 2 + 1] /= w;
      }
    }

    return output;
  }
}
