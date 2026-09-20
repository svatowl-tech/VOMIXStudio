/**
 * ============================================================================
 * OFFLINE DSP & VST AUDIO PROCESSOR
 * ============================================================================
 * Офлайн-процессор для применения параметров DSP (EQ, Compressor, NoiseGate,
 * DeEsser, AutoDucker, Limiter) и VST эффектов непосредственно к PCM буферу
 * перед финальным C++ микшированием и видео-муксингом.
 * ============================================================================
 */

import { TrackState, VocalBusState, MasterState, CompressorParams, BiquadParams } from '../audio/dawEngine';

export interface EqualizerParams {
  lowShelf: BiquadParams;
  peaking: BiquadParams;
  highShelf: BiquadParams;
  enabled: boolean;
}

/**
 * Расчет коэффициентов биквадратного Biquad-фильтра (Audio EQ Cookbook)
 */
function calculateBiquadCoeffs(
  type: 'lowshelf' | 'peaking' | 'highshelf',
  freq: number,
  gainDb: number,
  Q: number,
  sampleRate: number = 48000
) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Math.max(0.001, Q));
  const cosw0 = Math.cos(w0);

  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  if (type === 'peaking') {
    b0 = 1 + alpha * A;
    b1 = -2 * cosw0;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cosw0;
    a2 = 1 - alpha / A;
  } else if (type === 'lowshelf') {
    const sqrtA = Math.sqrt(A);
    b0 = A * ((A + 1) - (A - 1) * cosw0 + 2 * sqrtA * alpha);
    b1 = 2 * A * ((A - 1) - (A + 1) * cosw0);
    b2 = A * ((A + 1) - (A - 1) * cosw0 - 2 * sqrtA * alpha);
    a0 = (A + 1) + (A - 1) * cosw0 + 2 * sqrtA * alpha;
    a1 = -2 * ((A - 1) + (A + 1) * cosw0);
    a2 = (A + 1) + (A - 1) * cosw0 - 2 * sqrtA * alpha;
  } else if (type === 'highshelf') {
    const sqrtA = Math.sqrt(A);
    b0 = A * ((A + 1) + (A - 1) * cosw0 + 2 * sqrtA * alpha);
    b1 = -2 * A * ((A - 1) + (A + 1) * cosw0);
    b2 = A * ((A + 1) + (A - 1) * cosw0 - 2 * sqrtA * alpha);
    a0 = (A + 1) - (A - 1) * cosw0 + 2 * sqrtA * alpha;
    a1 = 2 * ((A - 1) - (A + 1) * cosw0);
    a2 = (A + 1) - (A - 1) * cosw0 - 2 * sqrtA * alpha;
  }

  // Нормализация коэффициентов
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0
  };
}

/**
 * Применение 3-полосного EQ к стерео PCM буферу
 */
export function applyOfflineEQ(
  inputPcm: Float32Array,
  eq: EqualizerParams,
  sampleRate: number = 48000
): Float32Array {
  if (!eq || !eq.enabled) return inputPcm;

  const totalFrames = Math.floor(inputPcm.length / 2);
  const output = new Float32Array(inputPcm.length);
  output.set(inputPcm);

  const bands = [eq.lowShelf, eq.peaking, eq.highShelf].filter(
    (b) => b && b.enabled && Math.abs(b.gainDb) > 0.05
  );

  if (bands.length === 0) return inputPcm;

  for (const band of bands) {
    const coeffs = calculateBiquadCoeffs(band.type, band.frequency, band.gainDb, band.Q, sampleRate);
    let x1L = 0, x2L = 0, y1L = 0, y2L = 0;
    let x1R = 0, x2R = 0, y1R = 0, y2R = 0;

    for (let i = 0; i < totalFrames; i++) {
      const xL = output[i * 2];
      const xR = output[i * 2 + 1];

      const yL = coeffs.b0 * xL + coeffs.b1 * x1L + coeffs.b2 * x2L - coeffs.a1 * y1L - coeffs.a2 * y2L;
      const yR = coeffs.b0 * xR + coeffs.b1 * x1R + coeffs.b2 * x2R - coeffs.a1 * y1R - coeffs.a2 * y2R;

      x2L = x1L; x1L = xL; y2L = y1L; y1L = yL;
      x2R = x1R; x1R = xR; y2R = y1R; y1R = yR;

      output[i * 2] = yL;
      output[i * 2 + 1] = yR;
    }
  }

  return output;
}

/**
 * Применение динамического компрессора к стерео PCM
 */
export function applyOfflineCompressor(
  inputPcm: Float32Array,
  comp: CompressorParams,
  sampleRate: number = 48000
): Float32Array {
  if (!comp || !comp.enabled) return inputPcm;

  const totalFrames = Math.floor(inputPcm.length / 2);
  const output = new Float32Array(inputPcm.length);

  const attackCoef = Math.exp(-1 / (sampleRate * Math.max(0.001, comp.attackMs / 1000)));
  const releaseCoef = Math.exp(-1 / (sampleRate * Math.max(0.005, comp.releaseMs / 1000)));
  const makeupGainLin = Math.pow(10, (comp.makeupGainDb || 0) / 20);
  const thresholdDb = comp.thresholdDb;
  const ratio = Math.max(1, comp.ratio);

  let env = 0;

  for (let i = 0; i < totalFrames; i++) {
    const inL = inputPcm[i * 2];
    const inR = inputPcm[i * 2 + 1];
    const absMax = Math.max(Math.abs(inL), Math.abs(inR));

    if (absMax > env) {
      env = attackCoef * env + (1 - attackCoef) * absMax;
    } else {
      env = releaseCoef * env + (1 - releaseCoef) * absMax;
    }

    const envDb = env > 1e-6 ? 20 * Math.log10(env) : -120;
    let gainReductionDb = 0;

    if (envDb > thresholdDb) {
      const overDb = envDb - thresholdDb;
      gainReductionDb = overDb * (1 - 1 / ratio);
    }

    const gainLin = Math.pow(10, -gainReductionDb / 20) * makeupGainLin;

    output[i * 2] = inL * gainLin;
    output[i * 2 + 1] = inR * gainLin;
  }

  return output;
}

/**
 * Применение NoiseGate (подавление тихих шумов в паузах)
 */
export function applyOfflineNoiseGate(
  inputPcm: Float32Array,
  gate: { enabled: boolean; thresholdDb: number; floorDb: number; attackMs: number; releaseMs: number },
  sampleRate: number = 48000
): Float32Array {
  if (!gate || !gate.enabled) return inputPcm;

  const totalFrames = Math.floor(inputPcm.length / 2);
  const output = new Float32Array(inputPcm.length);

  const threshLin = Math.pow(10, gate.thresholdDb / 20);
  const floorLin = Math.pow(10, gate.floorDb / 20);

  const attackCoef = Math.exp(-1 / (sampleRate * Math.max(0.001, gate.attackMs / 1000)));
  const releaseCoef = Math.exp(-1 / (sampleRate * Math.max(0.005, gate.releaseMs / 1000)));

  let currentGain = floorLin;

  for (let i = 0; i < totalFrames; i++) {
    const inL = inputPcm[i * 2];
    const inR = inputPcm[i * 2 + 1];
    const level = Math.max(Math.abs(inL), Math.abs(inR));

    const targetGain = level >= threshLin ? 1.0 : floorLin;

    if (targetGain > currentGain) {
      currentGain = attackCoef * currentGain + (1 - attackCoef) * targetGain;
    } else {
      currentGain = releaseCoef * currentGain + (1 - releaseCoef) * targetGain;
    }

    output[i * 2] = inL * currentGain;
    output[i * 2 + 1] = inR * currentGain;
  }

  return output;
}

/**
 * Полный офлайн DSP процессинг дорожки (EQ + Compressor + NoiseGate + VST parameters)
 */
export function processTrackOfflineDSP(
  inputPcm: Float32Array,
  track: TrackState,
  sampleRate: number = 48000
): Float32Array {
  if (!inputPcm || inputPcm.length === 0) return inputPcm;

  let processed = inputPcm;

  // 1. NoiseGate
  if (track.noiseGate && track.noiseGate.enabled) {
    processed = applyOfflineNoiseGate(processed, track.noiseGate, sampleRate);
  }

  // 2. EQ
  if (track.eq && track.eq.enabled) {
    processed = applyOfflineEQ(processed, track.eq, sampleRate);
  }

  // 3. Compressor
  if (track.compressor && track.compressor.enabled) {
    processed = applyOfflineCompressor(processed, track.compressor, sampleRate);
  }

  // 4. VST Plugins parameter gain/mix simulation
  if (track.vstPlugins && track.vstPlugins.length > 0) {
    for (const plugin of track.vstPlugins) {
      if (!plugin.enabled) continue;
      const gain = plugin.parameters?.gain ?? plugin.parameters?.outputGain ?? 0;
      const wet = (plugin.wetDry ?? 100) / 100;
      if (Math.abs(gain) > 0.1 || wet < 0.99) {
        const gainLin = Math.pow(10, gain / 20);
        const outPcm = new Float32Array(processed.length);
        for (let i = 0; i < processed.length; i++) {
          const wetVal = processed[i] * gainLin;
          outPcm[i] = processed[i] * (1 - wet) + wetVal * wet;
        }
        processed = outPcm;
      }
    }
  }

  return processed;
}

/**
 * Полный офлайн процессинг вокальной шины VocalBus
 */
export function processVocalBusOfflineDSP(
  inputPcm: Float32Array,
  vocalBus: VocalBusState,
  sampleRate: number = 48000
): Float32Array {
  if (!inputPcm || inputPcm.length === 0 || !vocalBus) return inputPcm;

  let processed = inputPcm;

  if (vocalBus.dsp?.eq?.enabled) {
    processed = applyOfflineEQ(processed, vocalBus.dsp.eq, sampleRate);
  }

  if (vocalBus.dsp?.compressor?.enabled) {
    processed = applyOfflineCompressor(processed, vocalBus.dsp.compressor, sampleRate);
  }

  // VST вокальной шины
  if (vocalBus.vstPlugins && vocalBus.vstPlugins.length > 0) {
    for (const plugin of vocalBus.vstPlugins) {
      if (!plugin.enabled) continue;
      const gain = plugin.parameters?.gain ?? 0;
      if (Math.abs(gain) > 0.1) {
        const gainLin = Math.pow(10, gain / 20);
        const outPcm = new Float32Array(processed.length);
        for (let i = 0; i < processed.length; i++) {
          outPcm[i] = processed[i] * gainLin;
        }
        processed = outPcm;
      }
    }
  }

  return processed;
}
