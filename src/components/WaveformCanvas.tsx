import React, { useRef, useEffect, memo, useMemo } from 'react';
import { extractPeaks } from '../utils/waveformUtils';

interface WaveformCanvasProps {
  buffer?: Float32Array;
  width: number;
  height: number;
  color: string;
  gain?: number;
  fadeInSamples?: number;
  fadeOutSamples?: number;
  lengthSamples?: number;
}

const MAX_TILE_WIDTH = 1800; // Безопасная ширина текстуры canvas для GPU (никогда не превышает лимиты GPU 16384px)

interface WaveformTileProps {
  buffer: Float32Array;
  tileLeftPx: number;
  tileWidthPx: number;
  totalWidthPx: number;
  height: number;
  color: string;
  gain: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  totalSamples: number;
}

const WaveformTile: React.FC<WaveformTileProps> = memo(({
  buffer,
  tileLeftPx,
  tileWidthPx,
  totalWidthPx,
  height,
  color,
  gain,
  fadeInSamples,
  fadeOutSamples,
  totalSamples
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || tileWidthPx <= 0 || height <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(tileWidthPx * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, tileWidthPx, height);

    if (!buffer || buffer.length === 0 || totalSamples <= 0) {
      // Центральная ось при отсутствии данных
      ctx.strokeStyle = `${color}40`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(tileWidthPx, height / 2);
      ctx.stroke();
      return;
    }

    // Расчет диапазона сэмплов для данного тайла
    const startSample = Math.floor((tileLeftPx / totalWidthPx) * totalSamples);
    const tileSampleCount = Math.floor((tileWidthPx / totalWidthPx) * totalSamples);
    const targetBuckets = Math.max(10, Math.min(Math.floor(tileWidthPx), 1200));

    const { minPeaks, maxPeaks } = extractPeaks(buffer, targetBuckets, startSample, tileSampleCount, true);
    const numBuckets = minPeaks.length;
    if (numBuckets === 0) return;

    const midY = height / 2;
    const ampScale = (height * 0.44) * Math.min(gain, 3.0);

    // Градиент заливки формы волны
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.5, `${color}cc`);
    gradient.addColorStop(1, color);

    ctx.fillStyle = gradient;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    const barWidth = Math.max(1, tileWidthPx / numBuckets);

    for (let i = 0; i < numBuckets; i++) {
      const x = (i / numBuckets) * tileWidthPx;
      const minVal = minPeaks[i];
      const maxVal = maxPeaks[i];

      // Расчет Fade In / Fade Out по глобальному сэмплу
      let fadeMultiplier = 1.0;
      const globalSample = startSample + (i / numBuckets) * tileSampleCount;
      if (fadeInSamples > 0 && globalSample < fadeInSamples) {
        fadeMultiplier *= Math.max(0, globalSample / fadeInSamples);
      }
      if (fadeOutSamples > 0 && globalSample >= totalSamples - fadeOutSamples) {
        const remaining = totalSamples - globalSample;
        fadeMultiplier *= Math.max(0, remaining / fadeOutSamples);
      }

      const topY = midY - maxVal * ampScale * fadeMultiplier;
      const botY = midY - minVal * ampScale * fadeMultiplier;
      const barH = Math.max(1.5, botY - topY);

      ctx.fillRect(x, topY, Math.max(1, barWidth - 0.2), barH);
    }

    // Центральная ось нуля
    ctx.strokeStyle = `${color}35`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(tileWidthPx, midY);
    ctx.stroke();

    // Отрисовка затемнения Fade In, если тайл пересекается с зоной Fade In
    const fadeInGlobalPx = totalSamples > 0 ? (fadeInSamples / totalSamples) * totalWidthPx : 0;
    if (fadeInSamples > 0 && fadeInGlobalPx > tileLeftPx) {
      const tileFadeInEndPx = Math.min(tileWidthPx, fadeInGlobalPx - tileLeftPx);
      const tileFadeInStartRatio = Math.max(0, tileLeftPx / fadeInGlobalPx);
      const tileFadeInEndRatio = Math.min(1.0, (tileLeftPx + tileFadeInEndPx) / fadeInGlobalPx);

      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(tileFadeInEndPx, 0);
      ctx.lineTo(tileFadeInEndPx, height * (1 - tileFadeInEndRatio));
      ctx.lineTo(0, height * (1 - tileFadeInStartRatio));
      ctx.closePath();
      ctx.fill();

      // Линия огибающей
      ctx.strokeStyle = '#ffffff88';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, height * (1 - tileFadeInStartRatio));
      ctx.lineTo(tileFadeInEndPx, height * (1 - tileFadeInEndRatio));
      ctx.stroke();
      ctx.restore();
    }

    // Отрисовка затемнения Fade Out, если тайл пересекается с зоной Fade Out
    const fadeOutStartGlobalPx = totalSamples > 0 ? totalWidthPx - (fadeOutSamples / totalSamples) * totalWidthPx : totalWidthPx;
    if (fadeOutSamples > 0 && fadeOutStartGlobalPx < tileLeftPx + tileWidthPx) {
      const tileFadeOutStartPx = Math.max(0, fadeOutStartGlobalPx - tileLeftPx);
      const tileFadeOutWidthPx = tileWidthPx - tileFadeOutStartPx;

      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.moveTo(tileFadeOutStartPx, 0);
      ctx.lineTo(tileWidthPx, 0);
      ctx.lineTo(tileWidthPx, height);
      ctx.closePath();
      ctx.fill();

      // Линия огибающей
      ctx.strokeStyle = '#ffffff88';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tileFadeOutStartPx, 0);
      ctx.lineTo(tileWidthPx, height);
      ctx.stroke();
      ctx.restore();
    }
  }, [
    buffer,
    tileLeftPx,
    tileWidthPx,
    totalWidthPx,
    height,
    color,
    gain,
    fadeInSamples,
    fadeOutSamples,
    totalSamples
  ]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: `${tileWidthPx}px`, height: `${height}px` }}
      className="block flex-shrink-0 pointer-events-none select-none"
    />
  );
});

WaveformTile.displayName = 'WaveformTile';

export const WaveformCanvas: React.FC<WaveformCanvasProps> = memo(({
  buffer,
  width,
  height,
  color,
  gain = 1.0,
  fadeInSamples = 0,
  fadeOutSamples = 0,
  lengthSamples
}) => {
  // Защита от белого или некорректного цвета
  const safeColor = useMemo(() => {
    if (!color || color.toLowerCase() === '#ffffff' || color.toLowerCase() === '#fff' || color.toLowerCase() === 'white') {
      return '#06b6d4'; // Насыщенный циан по умолчанию
    }
    return color;
  }, [color]);

  const safeWidth = Math.max(20, Math.floor(width));
  const safeHeight = Math.max(10, Math.floor(height));

  const totalFrames = useMemo(() => {
    if (!buffer || buffer.length === 0) return 0;
    const maxAvailable = Math.floor(buffer.length / 2); // Стерео
    return lengthSamples !== undefined ? Math.min(lengthSamples, maxAvailable) : maxAvailable;
  }, [buffer, lengthSamples]);

  // Разбиваем длинную дорожку на безопасные тайлы для предотвращения сбоев Chromium Skia GPU
  const tiles = useMemo(() => {
    const tileList: Array<{ index: number; left: number; width: number }> = [];
    let currentLeft = 0;
    let idx = 0;

    while (currentLeft < safeWidth) {
      const tileW = Math.min(MAX_TILE_WIDTH, safeWidth - currentLeft);
      tileList.push({
        index: idx++,
        left: currentLeft,
        width: tileW
      });
      currentLeft += tileW;
    }

    return tileList;
  }, [safeWidth]);

  return (
    <div
      style={{ width: `${safeWidth}px`, height: `${safeHeight}px` }}
      className="relative flex flex-row overflow-hidden pointer-events-none select-none"
    >
      {tiles.map((tile) => (
        <WaveformTile
          key={tile.index}
          buffer={buffer || new Float32Array(0)}
          tileLeftPx={tile.left}
          tileWidthPx={tile.width}
          totalWidthPx={safeWidth}
          height={safeHeight}
          color={safeColor}
          gain={gain}
          fadeInSamples={fadeInSamples}
          fadeOutSamples={fadeOutSamples}
          totalSamples={totalFrames}
        />
      ))}
    </div>
  );
});

WaveformCanvas.displayName = 'WaveformCanvas';
