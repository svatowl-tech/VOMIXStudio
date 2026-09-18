import React, { useEffect, useRef } from 'react';
import { BiquadParams } from '../audio/dawEngine';

interface EqCurveVisualizerProps {
  lowShelf: BiquadParams;
  peaking: BiquadParams;
  highShelf: BiquadParams;
  sampleRate?: number;
}

export const EqCurveVisualizer: React.FC<EqCurveVisualizerProps> = ({
  lowShelf,
  peaking,
  highShelf,
  sampleRate = 48000
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    // Grid lines (dB: -18 to +18, Freq: 20Hz to 20kHz log scale)
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;

    // dB grid
    const dBs = [-12, -6, 0, 6, 12];
    dBs.forEach((db) => {
      const y = height / 2 - (db / 18) * (height / 2);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      ctx.fillStyle = '#475569';
      ctx.font = '9px monospace';
      ctx.fillText(`${db > 0 ? '+' : ''}${db}dB`, 4, y - 2);
    });

    // Freq grid
    const freqs = [50, 100, 500, 1000, 5000, 10000];
    freqs.forEach((f) => {
      const logMin = Math.log10(20);
      const logMax = Math.log10(20000);
      const x = ((Math.log10(f) - logMin) / (logMax - logMin)) * width;

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      ctx.fillStyle = '#475569';
      ctx.font = '9px monospace';
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, height - 4);
    });

    // Calculate magnitude response for a filter at frequency w
    const getBiquadMag = (filter: BiquadParams, fHz: number) => {
      if (!filter.enabled || filter.gainDb === 0) return 1.0;

      const A = Math.pow(10, filter.gainDb / 40);
      const omega = (2 * Math.PI * filter.frequency) / sampleRate;
      const sn = Math.sin(omega);
      const cs = Math.cos(omega);
      const alpha = sn / (2 * Math.max(filter.Q, 0.001));
      const beta = Math.sqrt(A) / Math.max(filter.Q, 0.001);

      let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

      if (filter.type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * cs + beta * sn);
        b1 = 2 * A * ((A - 1) - (A + 1) * cs);
        b2 = A * ((A + 1) - (A - 1) * cs - beta * sn);
        a0 = (A + 1) + (A - 1) * cs + beta * sn;
        a1 = -2 * ((A - 1) + (A + 1) * cs);
        a2 = (A + 1) + (A - 1) * cs - beta * sn;
      } else if (filter.type === 'peaking') {
        b0 = 1 + alpha * A;
        b1 = -2 * cs;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cs;
        a2 = 1 - alpha / A;
      } else if (filter.type === 'highshelf') {
        b0 = A * ((A + 1) + (A - 1) * cs + beta * sn);
        b1 = -2 * A * ((A - 1) + (A + 1) * cs);
        b2 = A * ((A + 1) + (A - 1) * cs - beta * sn);
        a0 = (A + 1) - (A - 1) * cs + beta * sn;
        a1 = 2 * ((A - 1) - (A + 1) * cs);
        a2 = (A + 1) - (A - 1) * cs - beta * sn;
      }

      const invA0 = 1 / a0;
      b0 *= invA0; b1 *= invA0; b2 *= invA0;
      a1 *= invA0; a2 *= invA0;

      const phi = (2 * Math.PI * fHz) / sampleRate;
      const cos1 = Math.cos(phi);
      const cos2 = Math.cos(2 * phi);

      const num = b0 * b0 + b1 * b1 + b2 * b2 + 2 * (b0 * b1 + b1 * b2) * cos1 + 2 * b0 * b2 * cos2;
      const den = 1 + a1 * a1 + a2 * a2 + 2 * (a1 + a1 * a2) * cos1 + 2 * a2 * cos2;

      return Math.sqrt(Math.max(0, num / den));
    };

    // Plot total magnitude curve
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#10b981';

    const logMin = Math.log10(20);
    const logMax = Math.log10(20000);

    for (let x = 0; x < width; x++) {
      const logFreq = logMin + (x / width) * (logMax - logMin);
      const fHz = Math.pow(10, logFreq);

      const magLow = getBiquadMag(lowShelf, fHz);
      const magPeak = getBiquadMag(peaking, fHz);
      const magHigh = getBiquadMag(highShelf, fHz);

      const totalMag = magLow * magPeak * magHigh;
      const totalDb = 20 * Math.log10(Math.max(0.0001, totalMag));

      const y = height / 2 - (totalDb / 18) * (height / 2);

      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Fill curve gradient
    ctx.lineTo(width, height / 2);
    ctx.lineTo(0, height / 2);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
    ctx.fill();

  }, [lowShelf, peaking, highShelf, sampleRate]);

  return (
    <div className="relative border border-slate-800 rounded-lg overflow-hidden">
      <canvas ref={canvasRef} width={320} height={100} className="w-full h-24 bg-slate-950 block" />
      <div className="absolute top-1 right-2 text-[10px] font-mono text-emerald-400/80 bg-slate-950/80 px-1.5 py-0.5 rounded">
        EQ Response
      </div>
    </div>
  );
};
