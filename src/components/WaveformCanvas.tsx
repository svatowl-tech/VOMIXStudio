import React, { useRef, useEffect, memo } from 'react';
import { extractPeaks } from '../utils/waveformUtils';

interface WaveformCanvasProps {
  buffer: Float32Array;
  width: number;
  height: number;
  color: string;
  gain?: number;
  fadeInSamples?: number;
  fadeOutSamples?: number;
  lengthSamples?: number;
}

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    if (!buffer || buffer.length === 0) {
      // Отрисовка заглушки пустой волны
      ctx.strokeStyle = `${color}40`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      return;
    }

    const totalSamples = lengthSamples !== undefined ? Math.min(lengthSamples, buffer.length) : buffer.length;
    const targetPx = Math.max(10, Math.floor(width));

    // Быстрое извлечение пиков (O(pixels))
    const { minPeaks, maxPeaks } = extractPeaks(buffer, targetPx, 0, totalSamples);
    const numBuckets = minPeaks.length;
    const midY = height / 2;
    const ampScale = (height * 0.44) * Math.min(gain, 3.0);

    // Градиент заливки звуковой волны
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.5, `${color}bb`);
    gradient.addColorStop(1, color);

    ctx.fillStyle = gradient;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    const barWidth = Math.max(1, width / numBuckets);

    // Отрисовка вертикальных пиков вейвформа
    for (let i = 0; i < numBuckets; i++) {
      const x = (i / numBuckets) * width;
      const minVal = minPeaks[i];
      const maxVal = maxPeaks[i];

      // Учет Fade In / Fade Out на графике
      let fadeMultiplier = 1.0;
      const sampleAtPx = (i / numBuckets) * totalSamples;
      if (fadeInSamples > 0 && sampleAtPx < fadeInSamples) {
        fadeMultiplier *= sampleAtPx / fadeInSamples;
      }
      if (fadeOutSamples > 0 && sampleAtPx >= totalSamples - fadeOutSamples) {
        const remaining = totalSamples - sampleAtPx;
        fadeMultiplier *= remaining / fadeOutSamples;
      }

      const topY = midY - maxVal * ampScale * fadeMultiplier;
      const botY = midY - minVal * ampScale * fadeMultiplier;
      const barH = Math.max(1.5, botY - topY);

      ctx.fillRect(x, topY, barWidth - 0.2, barH);
    }

    // Центральная ось тишины (Zero crossing line)
    ctx.strokeStyle = `${color}30`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // Отрисовка затененных областей фейдов
    if (fadeInSamples > 0 && totalSamples > 0) {
      const fadeInPx = (fadeInSamples / totalSamples) * width;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(fadeInPx, 0);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fill();

      // Линия огибающей фейда
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(fadeInPx, 0);
      ctx.stroke();
    }

    if (fadeOutSamples > 0 && totalSamples > 0) {
      const fadeOutPx = (fadeOutSamples / totalSamples) * width;
      const startX = width - fadeOutPx;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(width, 0);
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();

      // Линия огибающей фейда
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(width, height);
      ctx.stroke();
    }
  }, [buffer, width, height, color, gain, fadeInSamples, fadeOutSamples, lengthSamples]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: `${width}px`, height: `${height}px` }}
      className="block pointer-events-none select-none"
    />
  );
});

WaveformCanvas.displayName = 'WaveformCanvas';
