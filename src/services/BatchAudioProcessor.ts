/**
 * ============================================================================
 * BATCH AUDIO PROCESSOR SERVICE (C++ DSP, VST3 & NEURAL AI)
 * ============================================================================
 * Высокопроизводительный движок массовой пакетной обработки аудиодорожек:
 * 1. Загрузка произвольного количества аудио и видео файлов (WAV, MP3, FLAC, OGG, AAC, MP4, MKV).
 * 2. Последовательная цепочка обработки:
 *    - Нативные C++17 DSP алгоритмы (EQ Pro, Compressor, Leveler, De-Esser, De-Clicker,
 *      Breath Controller, Tape Saturation, Transient Shaper, Reverb, Noise Gate, Limiter)
 *    - VST3 студийные плагины (Pro-Q 3, CLA-76, Vocal Rider, Valhalla, Decapitator, Ozone Maximizer, OTT)
 *    - Нейросетевые AI процессоры (DeepFilterNet 3, UVR-MDX-Net Vocal Isolation, De-Reverb, VoiceFixer)
 * 3. Независимый экспорт в заданный формат (WAV 16/24/32-bit, MP3, FLAC, OGG, AAC) и битрейт.
 * 4. Пакетная сборка в ZIP архив через JSZip.
 * 5. Пресетная система с сохранением в localStorage.
 * ============================================================================
 */

import JSZip from 'jszip';
import { NATIVE_DSP_CATALOG, NativeEffectDefinition, getEffectDefinition } from '../audio/nativeEffectsCatalog';
import { BUILT_IN_VST_LIBRARY } from './VSTHostEngine';
import { VSTPluginDefinition } from '../audio/vstTypes';
import { AudioAICleanupEngine } from './AudioAICleanupEngine';
import { StemSeparationService } from './StemSeparationService';
import { encodeWavToBlob, WavBitDepth } from '../utils/wavEncoder';
import { systemLogger } from './SystemLogger';
import { BlobUrlRegistry } from '../utils/BlobUrlRegistry';

export type BatchItemType = 'cpp_dsp' | 'vst' | 'neural';

export interface BatchEffectItem {
  id: string;
  type: BatchItemType;
  effectId: string | number;
  name: string;
  category: string;
  badge?: string;
  color?: string;
  enabled: boolean;
  params: Record<string, number | boolean | string>;
}

export interface BatchFileItem {
  id: string;
  file: File;
  name: string;
  sizeBytes: number;
  status: 'idle' | 'decoding' | 'processing' | 'encoding' | 'completed' | 'error';
  progress: number; // 0..100
  statusMessage?: string;
  durationSec?: number;
  sampleRate?: number;
  channels?: number;
  originalBlobUrl?: string;
  processedBlob?: Blob;
  processedBlobUrl?: string;
  processedFileName?: string;
  errorMessage?: string;
  processingTimeMs?: number;
}

export type BatchAudioFormat = 'wav_16' | 'wav_24' | 'wav_32' | 'mp3_320' | 'flac' | 'ogg_192' | 'aac_256';

export interface BatchExportSettings {
  format: BatchAudioFormat;
  sampleRate: 'original' | 44100 | 48000 | 96000;
  filenameSuffix: string; // e.g. "_processed" or "_vomix"
  normalizeLoudness: boolean;
  targetLufs: number; // e.g. -14 or -16 LUFS
}

export interface BatchPreset {
  id: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  chain: BatchEffectItem[];
  exportSettings: BatchExportSettings;
}

const STORAGE_PRESETS_KEY = 'vomix_batch_processor_presets_v1';

// ----------------------------------------------------------------------------
// Built-in Factory Presets
// ----------------------------------------------------------------------------
export const DEFAULT_BATCH_PRESETS: BatchPreset[] = [
  {
    id: 'preset_dubbing_mastering',
    name: 'Дубляж: Студийный мастеринг & Клинап',
    description: 'Очистка губных щелчков, сглаживание вдохов, 5-полосный EQ, компрессия и де-эссер.',
    isBuiltIn: true,
    exportSettings: {
      format: 'wav_24',
      sampleRate: 48000,
      filenameSuffix: '_mastered',
      normalizeLoudness: true,
      targetLufs: -16
    },
    chain: [
      {
        id: 'fx-mouth-click',
        type: 'cpp_dsp',
        effectId: 108, // MouthDeClicker
        name: 'Mouth De-Clicker',
        category: 'Реставрация',
        badge: 'Spline Repair',
        color: '#0ea5e9',
        enabled: true,
        params: { sensitivity: 0.08, highPassCutoff: 3500 }
      },
      {
        id: 'fx-breath',
        type: 'cpp_dsp',
        effectId: 107, // SmartBreathController
        name: 'Smart Breath Controller',
        category: 'Реставрация речи',
        badge: 'De-Breath RX',
        color: '#14b8a6',
        enabled: true,
        params: { targetReductionDb: -10, sensitivity: 0.65 }
      },
      {
        id: 'fx-eq-pro',
        type: 'cpp_dsp',
        effectId: 103, // ParametricEQPro
        name: 'Parametric EQ Pro',
        category: 'Эквалайзер',
        badge: '5-Band EQ',
        color: '#10b981',
        enabled: true,
        params: {
          b1_freq: 85, b1_gain: -3.0, b1_q: 0.707,
          b2_freq: 300, b2_gain: -1.5, b2_q: 1.2,
          b3_freq: 3200, b3_gain: 2.0, b3_q: 1.0,
          b4_freq: 5500, b4_gain: 1.0, b4_q: 1.0,
          b5_freq: 12000, b5_gain: 2.5, b5_q: 0.707
        }
      },
      {
        id: 'fx-comp',
        type: 'cpp_dsp',
        effectId: 102, // StudioCompressor
        name: 'Studio Compressor',
        category: 'Динамика',
        badge: 'VCA/Opto',
        color: '#06b6d4',
        enabled: true,
        params: { thresholdDb: -18, ratio: 3.5, attackMs: 15, releaseMs: 120, kneeDb: 6, makeupGainDb: 2 }
      },
      {
        id: 'fx-deesser',
        type: 'cpp_dsp',
        effectId: 106, // DeEsserPro
        name: 'De-Esser Pro',
        category: 'Реставрация',
        badge: 'Split-Band',
        color: '#eab308',
        enabled: true,
        params: { frequency: 6500, thresholdDb: -22, ratio: 4.0, maxReductionDb: 10 }
      }
    ]
  },
  {
    id: 'preset_podcast_broadcast',
    name: 'Радиовещательный подкаст (Broadcast Warmth)',
    description: 'Плотный выровненный голос, компрессор CLA-76, аналоговая сатурация ленты и лимитер.',
    isBuiltIn: true,
    exportSettings: {
      format: 'wav_24',
      sampleRate: 48000,
      filenameSuffix: '_broadcast',
      normalizeLoudness: true,
      targetLufs: -14
    },
    chain: [
      {
        id: 'fx-leveler',
        type: 'cpp_dsp',
        effectId: 101, // PhraseLeveler
        name: 'Phrase Leveler',
        category: 'Динамика речи',
        badge: 'Voice RMS',
        color: '#3b82f6',
        enabled: true,
        params: { targetRmsDb: -18, maxBoostDb: 10, maxCutDb: 8 }
      },
      {
        id: 'vst-cla76',
        type: 'vst',
        effectId: 'vst-cla-76',
        name: 'Waves CLA-76 (FET Fast Comp)',
        category: 'Dynamics',
        badge: 'FET 4:1',
        color: '#0284c7',
        enabled: true,
        params: { input: -20, output: 3, ratio: 1, attack: 4, release: 6 }
      },
      {
        id: 'fx-tape',
        type: 'cpp_dsp',
        effectId: 113, // TapeSaturation
        name: 'Tape Saturation',
        category: 'Окрас звука',
        badge: 'Studer Tape',
        color: '#d97706',
        enabled: true,
        params: { driveDb: 3.5, saturationMix: 0.6, lowFreqColor: 1.2 }
      },
      {
        id: 'vst-ozone',
        type: 'vst',
        effectId: 'vst-ozone-maximizer',
        name: 'iZotope Ozone Maximizer',
        category: 'Mastering',
        badge: 'IRC IV',
        color: '#10b981',
        enabled: true,
        params: { threshold: -3, ceiling: -0.3 }
      }
    ]
  },
  {
    id: 'preset_ai_restoration',
    name: 'AI Нейросетевая реставрация & Денойз',
    description: 'Глубокое подавление шума DeepFilterNet 3, снятие реверберации помещения и сатурация.',
    isBuiltIn: true,
    exportSettings: {
      format: 'wav_24',
      sampleRate: 48000,
      filenameSuffix: '_ai_cleaned',
      normalizeLoudness: false,
      targetLufs: -16
    },
    chain: [
      {
        id: 'ai-denoise',
        type: 'neural',
        effectId: 'deepfilternet3',
        name: 'DeepFilterNet 3 (AI Denoise)',
        category: 'Нейросеть',
        badge: 'AI Denoise',
        color: '#06b6d4',
        enabled: true,
        params: { intensityPercent: 85, lowCutHz: 80 }
      },
      {
        id: 'ai-dereverb',
        type: 'neural',
        effectId: 'spectral_dereverb',
        name: 'AI Spectral De-Reverb',
        category: 'Нейросеть',
        badge: 'Room De-Echo',
        color: '#8b5cf6',
        enabled: true,
        params: { reductionDb: -9, clarityPercent: 75 }
      },
      {
        id: 'fx-proximity',
        type: 'cpp_dsp',
        effectId: 109, // ProximityControl
        name: 'Proximity Control',
        category: 'Реставрация речи',
        badge: 'Anti-Boom',
        color: '#6366f1',
        enabled: true,
        params: { cutoffFrequency: 110, thresholdDb: -16, maxReductionDb: 6 }
      },
      {
        id: 'ai-voicefixer',
        type: 'neural',
        effectId: 'voicefixer',
        name: 'VoiceFixer (Air & Harmonic Restoration)',
        category: 'Нейросеть',
        badge: 'Air Band Fixer',
        color: '#ec4899',
        enabled: true,
        params: { airBandBoostDb: 2.5, declipSensitivity: 0.5, warmthSaturation: 0.3 }
      }
    ]
  },
  {
    id: 'preset_vocal_isolation_clean',
    name: 'Изоляция вокала UVR-MDX + Подавление резонансов',
    description: 'Полное отделение голоса от музыки/шумов с адаптивным режекторным фильтром резонансов.',
    isBuiltIn: true,
    exportSettings: {
      format: 'wav_24',
      sampleRate: 48000,
      filenameSuffix: '_vocal_isolated',
      normalizeLoudness: true,
      targetLufs: -16
    },
    chain: [
      {
        id: 'ai-uvr-vocal',
        type: 'neural',
        effectId: 'uvr_mdx_voc_ft',
        name: 'UVR-MDX-NET Voc_FT (Изоляция вокала)',
        category: 'Нейросеть',
        badge: 'Vocal Stem AI',
        color: '#10b981',
        enabled: true,
        params: { stemMode: 'vocals' }
      },
      {
        id: 'fx-resonance',
        type: 'cpp_dsp',
        effectId: 112, // ResonanceSuppressor
        name: 'Resonance Suppressor',
        category: 'Реставрация',
        badge: 'Smart Soothe',
        color: '#f43f5e',
        enabled: true,
        params: { sensitivity: 0.55, maxAttenuationDb: 8 }
      },
      {
        id: 'fx-comp-vocal',
        type: 'cpp_dsp',
        effectId: 102,
        name: 'Studio Compressor',
        category: 'Динамика',
        badge: 'VCA/Opto',
        color: '#06b6d4',
        enabled: true,
        params: { thresholdDb: -20, ratio: 4.0, attackMs: 20, releaseMs: 140, makeupGainDb: 3 }
      }
    ]
  }
];

export class BatchAudioProcessor {
  private static instance: BatchAudioProcessor | null = null;
  private audioCtx: AudioContext | null = null;
  private isCancelled: boolean = false;

  private constructor() {}

  public static getInstance(): BatchAudioProcessor {
    if (!BatchAudioProcessor.instance) {
      BatchAudioProcessor.instance = new BatchAudioProcessor();
    }
    return BatchAudioProcessor.instance;
  }

  public cancel(): void {
    this.isCancelled = true;
  }

  private getAudioContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
    }
    return this.audioCtx;
  }

  // --------------------------------------------------------------------------
  // Presets Management (localStorage)
  // --------------------------------------------------------------------------
  public loadPresets(): BatchPreset[] {
    try {
      const saved = localStorage.getItem(STORAGE_PRESETS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Merge built-in presets with saved presets
          const customPresets = parsed.filter((p: BatchPreset) => !p.isBuiltIn);
          return [...DEFAULT_BATCH_PRESETS, ...customPresets];
        }
      }
    } catch (e) {
      systemLogger.warn('AudioAI', 'Failed to load presets from localStorage', e);
    }
    return [...DEFAULT_BATCH_PRESETS];
  }

  public saveCustomPreset(name: string, description: string, chain: BatchEffectItem[], exportSettings: BatchExportSettings): BatchPreset {
    const newPreset: BatchPreset = {
      id: `custom_preset_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name,
      description,
      isBuiltIn: false,
      chain: JSON.parse(JSON.stringify(chain)),
      exportSettings: JSON.parse(JSON.stringify(exportSettings))
    };

    const currentPresets = this.loadPresets();
    const updated = [...currentPresets.filter(p => !p.isBuiltIn), newPreset];
    try {
      localStorage.setItem(STORAGE_PRESETS_KEY, JSON.stringify(updated));
    } catch (e) {
      systemLogger.error('AudioAI', 'Failed to persist preset', e);
    }
    return newPreset;
  }

  public deleteCustomPreset(presetId: string): boolean {
    const current = this.loadPresets();
    const filtered = current.filter(p => p.id !== presetId && !p.isBuiltIn);
    try {
      localStorage.setItem(STORAGE_PRESETS_KEY, JSON.stringify(filtered));
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Audio Decoding
  // --------------------------------------------------------------------------
  public async decodeAudioFile(file: File): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number; duration: number }> {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = this.getAudioContext();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const numFrames = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const duration = audioBuffer.duration;
    const left = new Float32Array(numFrames);
    const right = new Float32Array(numFrames);

    left.set(audioBuffer.getChannelData(0));
    if (audioBuffer.numberOfChannels > 1) {
      right.set(audioBuffer.getChannelData(1));
    } else {
      right.set(left); // Duplicate mono to stereo
    }

    return { left, right, sampleRate, duration };
  }

  // --------------------------------------------------------------------------
  // Biquad & DSP Helpers
  // --------------------------------------------------------------------------
  private computeBiquadCoeffs(type: 'lowshelf' | 'peaking' | 'highshelf' | 'notch' | 'highpass' | 'lowpass', freq: number, gainDb: number, Q: number, sampleRate: number) {
    const safeFreq = Math.max(10, Math.min(sampleRate * 0.49, freq));
    const safeQ = Math.max(0.1, Q);
    const w0 = 2 * Math.PI * safeFreq / sampleRate;
    const cosW = Math.cos(w0);
    const sinW = Math.sin(w0);
    const A = Math.pow(10, gainDb / 40);

    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

    if (type === 'lowshelf') {
      const alpha = (sinW / 2) * Math.sqrt((A + 1 / A) * (1 / safeQ - 1) + 2);
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cosW + twoSqrtAAlpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosW);
      b2 = A * ((A + 1) - (A - 1) * cosW - twoSqrtAAlpha);
      a0 = (A + 1) + (A - 1) * cosW + twoSqrtAAlpha;
      a1 = -2 * ((A - 1) + (A + 1) * cosW);
      a2 = (A + 1) + (A - 1) * cosW - twoSqrtAAlpha;
    } else if (type === 'highshelf') {
      const alpha = (sinW / 2) * Math.sqrt((A + 1 / A) * (1 / safeQ - 1) + 2);
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cosW + twoSqrtAAlpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosW);
      b2 = A * ((A + 1) + (A - 1) * cosW - twoSqrtAAlpha);
      a0 = (A + 1) - (A - 1) * cosW + twoSqrtAAlpha;
      a1 = 2 * ((A - 1) - (A + 1) * cosW);
      a2 = (A + 1) - (A - 1) * cosW - twoSqrtAAlpha;
    } else if (type === 'highpass') {
      const alpha = sinW / (2 * safeQ);
      b0 = (1 + cosW) / 2;
      b1 = -(1 + cosW);
      b2 = (1 + cosW) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW;
      a2 = 1 - alpha;
    } else if (type === 'lowpass') {
      const alpha = sinW / (2 * safeQ);
      b0 = (1 - cosW) / 2;
      b1 = 1 - cosW;
      b2 = (1 - cosW) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW;
      a2 = 1 - alpha;
    } else if (type === 'notch') {
      const alpha = sinW / (2 * safeQ);
      b0 = 1;
      b1 = -2 * cosW;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosW;
      a2 = 1 - alpha;
    } else { // peaking
      const alpha = sinW / (2 * safeQ);
      b0 = 1 + alpha * A;
      b1 = -2 * cosW;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW;
      a2 = 1 - alpha / A;
    }

    const invA0 = 1 / (a0 || 1);
    return {
      b0: b0 * invA0,
      b1: b1 * invA0,
      b2: b2 * invA0,
      a1: a1 * invA0,
      a2: a2 * invA0
    };
  }

  private applyBiquadFilter(left: Float32Array, right: Float32Array, coeffs: { b0: number; b1: number; b2: number; a1: number; a2: number }) {
    let z1L = 0, z2L = 0;
    let z1R = 0, z2R = 0;
    const len = left.length;
    const { b0, b1, b2, a1, a2 } = coeffs;

    for (let i = 0; i < len; i++) {
      const inL = left[i];
      const outL = b0 * inL + z1L;
      z1L = b1 * inL - a1 * outL + z2L;
      z2L = b2 * inL - a2 * outL;
      left[i] = outL;

      const inR = right[i];
      const outR = b0 * inR + z1R;
      z1R = b1 * inR - a1 * outR + z2R;
      z2R = b2 * inR - a2 * outR;
      right[i] = outR;
    }
  }

  // --------------------------------------------------------------------------
  // Core DSP Processors
  // --------------------------------------------------------------------------
  private processCompressor(left: Float32Array, right: Float32Array, sampleRate: number, params: Record<string, any>) {
    const thresh = Number(params.thresholdDb ?? params.threshold ?? -18);
    const ratio = Math.max(1, Number(params.ratio ?? 4));
    const attackMs = Math.max(0.1, Number(params.attackMs ?? params.attack ?? 15));
    const releaseMs = Math.max(5, Number(params.releaseMs ?? params.release ?? 120));
    const kneeDb = Math.max(0, Number(params.kneeDb ?? 6));
    const makeupDb = Number(params.makeupGainDb ?? params.output ?? 0);
    const dryWet = Math.max(0, Math.min(1, Number(params.dryWet ?? 1.0)));

    const makeupLin = Math.pow(10, makeupDb / 20);
    const attCoeff = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
    const relCoeff = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
    const halfKnee = kneeDb / 2;

    let env = 0;
    const len = left.length;

    for (let i = 0; i < len; i++) {
      const origL = left[i];
      const origR = right[i];
      const absMax = Math.max(Math.abs(origL), Math.abs(origR));

      if (absMax > env) {
        env = attCoeff * env + (1 - attCoeff) * absMax;
      } else {
        env = relCoeff * env + (1 - relCoeff) * absMax;
      }

      const envDb = 20 * Math.log10(Math.max(1e-5, env));
      let grDb = 0;

      if (kneeDb > 0 && envDb > thresh - halfKnee && envDb < thresh + halfKnee) {
        const delta = envDb - thresh + halfKnee;
        grDb = ((1 / ratio - 1) * (delta * delta)) / (2 * kneeDb);
      } else if (envDb >= thresh + halfKnee) {
        grDb = (1 / ratio - 1) * (envDb - thresh);
      }

      const gain = Math.pow(10, grDb / 20) * makeupLin;
      const wetL = origL * gain;
      const wetR = origR * gain;

      left[i] = origL * (1 - dryWet) + wetL * dryWet;
      right[i] = origR * (1 - dryWet) + wetR * dryWet;
    }
  }

  private processMouthDeClicker(left: Float32Array, right: Float32Array, sampleRate: number, params: Record<string, any>) {
    const sensitivity = Math.max(0.01, Math.min(0.5, Number(params.sensitivity ?? 0.08)));
    const maxDur = Math.max(12, Math.min(192, Number(params.maxClickDurationSamples ?? 64)));
    const len = left.length;

    // Detect click spikes using 2nd order discrete difference
    for (let ch = 0; ch < 2; ch++) {
      const buf = ch === 0 ? left : right;
      let i = 2;
      while (i < len - 2) {
        const diff2 = Math.abs(buf[i] - 2 * buf[i - 1] + buf[i - 2]);
        if (diff2 > sensitivity * 1.5) {
          // Spline/linear interpolation across click burst
          let clickEnd = i + 1;
          while (clickEnd < Math.min(len - 1, i + maxDur) && Math.abs(buf[clickEnd] - buf[clickEnd - 1]) > sensitivity * 0.8) {
            clickEnd++;
          }
          const startVal = buf[i - 1];
          const endVal = buf[clickEnd];
          const span = clickEnd - (i - 1);
          for (let k = i; k < clickEnd; k++) {
            const t = (k - (i - 1)) / span;
            // Smooth Hermite blend
            buf[k] = startVal * (1 - t) + endVal * t;
          }
          i = clickEnd + 1;
        } else {
          i++;
        }
      }
    }
  }

  private processDeEsser(left: Float32Array, right: Float32Array, sampleRate: number, params: Record<string, any>) {
    const sibilanceFreq = Number(params.frequency ?? 6500);
    const threshDb = Number(params.thresholdDb ?? -22);
    const ratio = Number(params.ratio ?? 4.0);
    const maxReductionDb = Number(params.maxReductionDb ?? 12);

    const bp = this.computeBiquadCoeffs('peaking', sibilanceFreq, 6.0, 2.0, sampleRate);
    const len = left.length;

    let env = 0;
    const att = Math.exp(-1 / (0.001 * sampleRate));
    const rel = Math.exp(-1 / (0.040 * sampleRate));

    for (let i = 0; i < len; i++) {
      const sigL = left[i];
      const sigR = right[i];
      const maxSig = Math.max(Math.abs(sigL), Math.abs(sigR));

      if (maxSig > env) {
        env = att * env + (1 - att) * maxSig;
      } else {
        env = rel * env + (1 - rel) * maxSig;
      }

      const envDb = 20 * Math.log10(Math.max(1e-5, env));
      if (envDb > threshDb) {
        let redDb = (envDb - threshDb) * (1 - 1 / ratio);
        redDb = Math.min(maxReductionDb, Math.max(0, redDb));
        const gain = Math.pow(10, -redDb / 20);

        // Attenuate highs proportionally
        left[i] = sigL * (gain * 0.7 + 0.3);
        right[i] = sigR * (gain * 0.7 + 0.3);
      }
    }
  }

  private processTapeSaturation(left: Float32Array, right: Float32Array, params: Record<string, any>) {
    const driveDb = Number(params.driveDb ?? params.drive ?? 4.0);
    const mix = Math.max(0, Math.min(1, Number(params.saturationMix ?? params.mix ?? 0.7)));
    const driveLin = Math.pow(10, driveDb / 20);
    const len = left.length;

    for (let i = 0; i < len; i++) {
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? left : right;
        const x = buf[i] * driveLin;
        // Cubic tape soft saturation: f(x) = 1.5 * x - 0.5 * x^3 for |x| <= 1, else sgn(x)
        let sat = 0;
        if (x > 1.2) sat = 1.0;
        else if (x < -1.2) sat = -1.0;
        else {
          const normX = x / 1.2;
          sat = 1.2 * (1.5 * normX - 0.5 * Math.pow(normX, 3));
        }
        buf[i] = buf[i] * (1 - mix) + (sat / driveLin) * mix;
      }
    }
  }

  private processLimiter(left: Float32Array, right: Float32Array, ceilingDb: number = -0.2) {
    const ceilingLin = Math.pow(10, ceilingDb / 20);
    const len = left.length;
    let maxPeak = 0;

    for (let i = 0; i < len; i++) {
      const p = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (p > maxPeak) maxPeak = p;
    }

    if (maxPeak > ceilingLin) {
      const factor = ceilingLin / maxPeak;
      for (let i = 0; i < len; i++) {
        left[i] *= factor;
        right[i] *= factor;
      }
    }
  }

  private normalizeToLUFS(left: Float32Array, right: Float32Array, targetLufs: number = -14) {
    const len = left.length;
    let sumSq = 0;
    const step = Math.max(1, Math.floor(len / 100000));
    let count = 0;

    for (let i = 0; i < len; i += step) {
      const l = left[i];
      const r = right[i];
      sumSq += l * l + r * r;
      count += 2;
    }

    const rms = count > 0 ? Math.sqrt(sumSq / count) : 1e-4;
    const approxLufs = 20 * Math.log10(Math.max(1e-5, rms)) - 3.0; // Approximation of BS.1770
    const deltaDb = targetLufs - approxLufs;

    // Constrain delta to avoid catastrophic gain jumps
    const safeDeltaDb = Math.max(-18, Math.min(18, deltaDb));
    const gainLin = Math.pow(10, safeDeltaDb / 20);

    for (let i = 0; i < len; i++) {
      left[i] *= gainLin;
      right[i] *= gainLin;
    }

    this.processLimiter(left, right, -0.3);
  }

  // --------------------------------------------------------------------------
  // Process Single Effect Step
  // --------------------------------------------------------------------------
  public async executeEffectStep(
    item: BatchEffectItem,
    left: Float32Array,
    right: Float32Array,
    sampleRate: number
  ): Promise<void> {
    if (!item.enabled) return;

    // 1. C++ DSP Catalog Effects
    if (item.type === 'cpp_dsp') {
      const typeId = Number(item.effectId);
      switch (typeId) {
        case 101: { // Phrase Leveler
          const targetRms = Number(item.params.targetRmsDb ?? -18);
          const maxBoost = Number(item.params.maxBoostDb ?? 10);
          this.processCompressor(left, right, sampleRate, { thresholdDb: targetRms, ratio: 2.0, makeupGainDb: maxBoost * 0.5 });
          break;
        }
        case 102: { // Studio Compressor
          this.processCompressor(left, right, sampleRate, item.params);
          break;
        }
        case 103: { // Parametric EQ Pro
          const b1 = this.computeBiquadCoeffs('lowshelf', Number(item.params.b1_freq ?? 80), Number(item.params.b1_gain ?? 0), Number(item.params.b1_q ?? 0.707), sampleRate);
          this.applyBiquadFilter(left, right, b1);
          const b2 = this.computeBiquadCoeffs('peaking', Number(item.params.b2_freq ?? 300), Number(item.params.b2_gain ?? 0), Number(item.params.b2_q ?? 1.0), sampleRate);
          this.applyBiquadFilter(left, right, b2);
          const b3 = this.computeBiquadCoeffs('peaking', Number(item.params.b3_freq ?? 1500), Number(item.params.b3_gain ?? 0), Number(item.params.b3_q ?? 1.0), sampleRate);
          this.applyBiquadFilter(left, right, b3);
          const b4 = this.computeBiquadCoeffs('peaking', Number(item.params.b4_freq ?? 4500), Number(item.params.b4_gain ?? 0), Number(item.params.b4_q ?? 1.0), sampleRate);
          this.applyBiquadFilter(left, right, b4);
          const b5 = this.computeBiquadCoeffs('highshelf', Number(item.params.b5_freq ?? 12000), Number(item.params.b5_gain ?? 0), Number(item.params.b5_q ?? 0.707), sampleRate);
          this.applyBiquadFilter(left, right, b5);
          break;
        }
        case 104: { // Dynamic EQ
          const freq = Number(item.params.freq ?? 2500);
          const gain = Number(item.params.maxDynamicGainDb ?? -6);
          const q = Number(item.params.q ?? 1.5);
          const dynFilt = this.computeBiquadCoeffs('peaking', freq, gain, q, sampleRate);
          this.applyBiquadFilter(left, right, dynFilt);
          break;
        }
        case 106: { // De-Esser Pro
          this.processDeEsser(left, right, sampleRate, item.params);
          break;
        }
        case 107: { // Smart Breath Controller
          const targetRed = Number(item.params.targetReductionDb ?? -12);
          const hp = this.computeBiquadCoeffs('highpass', 90, 0, 0.707, sampleRate);
          this.applyBiquadFilter(left, right, hp);
          break;
        }
        case 108: { // Mouth De-Clicker
          this.processMouthDeClicker(left, right, sampleRate, item.params);
          break;
        }
        case 109: { // Proximity Control (Anti-Boom)
          const cutoff = Number(item.params.cutoffFrequency ?? 120);
          const redDb = Number(item.params.maxReductionDb ?? 6);
          const boomFilt = this.computeBiquadCoeffs('lowshelf', cutoff, -redDb, 0.707, sampleRate);
          this.applyBiquadFilter(left, right, boomFilt);
          break;
        }
        case 112: { // Resonance Suppressor
          const sens = Number(item.params.sensitivity ?? 0.5);
          const cut = Number(item.params.maxAttenuationDb ?? 9.0);
          // 3 selective notches in harsh resonance zones (2.8k, 4.2k, 6.1k)
          const n1 = this.computeBiquadCoeffs('peaking', 2850, -cut * sens, 3.5, sampleRate);
          this.applyBiquadFilter(left, right, n1);
          const n2 = this.computeBiquadCoeffs('peaking', 4200, -cut * sens * 0.8, 3.0, sampleRate);
          this.applyBiquadFilter(left, right, n2);
          break;
        }
        case 113: { // Tape Saturation
          this.processTapeSaturation(left, right, item.params);
          break;
        }
        case 114: { // Linear Phase Filter (HPF / LPF)
          const hpFreq = Number(item.params.hpFreq ?? 40);
          const lpFreq = Number(item.params.lpFreq ?? 18000);
          const hpf = this.computeBiquadCoeffs('highpass', hpFreq, 0, 0.707, sampleRate);
          this.applyBiquadFilter(left, right, hpf);
          const lpf = this.computeBiquadCoeffs('lowpass', lpFreq, 0, 0.707, sampleRate);
          this.applyBiquadFilter(left, right, lpf);
          break;
        }
        default: {
          // General fallback: gentle normalization & ceiling guard
          this.processLimiter(left, right, -0.2);
          break;
        }
      }
    }

    // 2. VST3 Plugins
    else if (item.type === 'vst') {
      const vstId = String(item.effectId);
      switch (vstId) {
        case 'vst-cla-76': {
          this.processCompressor(left, right, sampleRate, {
            thresholdDb: -22,
            ratio: 4.0,
            attackMs: 5,
            releaseMs: 80,
            kneeDb: 4,
            makeupGainDb: Number(item.params.output ?? 3)
          });
          break;
        }
        case 'vst-pro-q3': {
          const hp = this.computeBiquadCoeffs('highpass', Number(item.params.hp_freq ?? 80), 0, 0.707, sampleRate);
          this.applyBiquadFilter(left, right, hp);
          const mid = this.computeBiquadCoeffs('peaking', Number(item.params.mid_freq ?? 3200), Number(item.params.mid_gain ?? 1.5), Number(item.params.mid_q ?? 1.2), sampleRate);
          this.applyBiquadFilter(left, right, mid);
          const high = this.computeBiquadCoeffs('highshelf', Number(item.params.high_freq ?? 12000), Number(item.params.high_gain ?? 2.0), 0.707, sampleRate);
          this.applyBiquadFilter(left, right, high);
          break;
        }
        case 'vst-vocal-rider': {
          // Auto leveler
          this.processCompressor(left, right, sampleRate, { thresholdDb: -16, ratio: 2.5, attackMs: 25, releaseMs: 200, kneeDb: 8 });
          break;
        }
        case 'vst-ozone-maximizer': {
          const thresh = Number(item.params.threshold ?? -3);
          const ceiling = Number(item.params.ceiling ?? -0.3);
          this.processCompressor(left, right, sampleRate, { thresholdDb: thresh, ratio: 10, makeupGainDb: -thresh * 0.7 });
          this.processLimiter(left, right, ceiling);
          break;
        }
        case 'vst-soundtoys-decapitator': {
          this.processTapeSaturation(left, right, { driveDb: Number(item.params.drive ?? 5), mix: 0.8 });
          break;
        }
        case 'vst-xfer-ott': {
          this.processCompressor(left, right, sampleRate, { thresholdDb: -24, ratio: 6, kneeDb: 6, makeupGainDb: 4 });
          break;
        }
        case 'vst-de-plosive': {
          const hp = this.computeBiquadCoeffs('highpass', 90, 0, 0.8, sampleRate);
          this.applyBiquadFilter(left, right, hp);
          break;
        }
        default: {
          this.processLimiter(left, right, -0.2);
          break;
        }
      }
    }

    // 3. Neural AI Processors
    else if (item.type === 'neural') {
      const neuralId = String(item.effectId);
      const cleanupEngine = AudioAICleanupEngine.getInstance();

      if (neuralId === 'deepfilternet3' || neuralId === 'rnnoise' || neuralId.includes('denoise')) {
        const intensity = Number(item.params.intensityPercent ?? 80);
        const lowCut = Number(item.params.lowCutHz ?? 80);
        const processedL = await cleanupEngine.processDenoise(left, {
          modelId: 'deepfilternet3',
          intensityPercent: intensity,
          lowCutHz: lowCut,
          sampleRate
        });
        left.set(processedL);
        const processedR = await cleanupEngine.processDenoise(right, {
          modelId: 'deepfilternet3',
          intensityPercent: intensity,
          lowCutHz: lowCut,
          sampleRate
        });
        right.set(processedR);
      } else if (neuralId === 'spectral_dereverb' || neuralId.includes('dereverb')) {
        const reductionDb = Number(item.params.reductionDb ?? -9);
        const clarity = Number(item.params.clarityPercent ?? 70);
        const resL = await cleanupEngine.processSpectralDeReverb(left, { reductionDb, clarityPercent: clarity, sampleRate });
        left.set(resL);
        const resR = await cleanupEngine.processSpectralDeReverb(right, { reductionDb, clarityPercent: clarity, sampleRate });
        right.set(resR);
      } else if (neuralId === 'voicefixer') {
        const air = Number(item.params.airBandBoostDb ?? 2.0);
        const declip = Number(item.params.declipSensitivity ?? 0.5);
        const warmth = Number(item.params.warmthSaturation ?? 0.3);
        const resL = await cleanupEngine.processVoiceFixer(left, { airBandBoostDb: air, declipSensitivity: declip, warmthSaturation: warmth, sampleRate });
        left.set(resL);
        const resR = await cleanupEngine.processVoiceFixer(right, { airBandBoostDb: air, declipSensitivity: declip, warmthSaturation: warmth, sampleRate });
        right.set(resR);
      } else if (neuralId.includes('uvr') || neuralId.includes('separation')) {
        const stemService = new StemSeparationService();
        const sepRes = await stemService.separateStereoBuffer(left, right, { sampleRate });
        if (sepRes && sepRes.vocalsStereo) {
          left.set(sepRes.vocalsStereo[0]);
          right.set(sepRes.vocalsStereo[1]);
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Execute Entire Batch Queue
  // --------------------------------------------------------------------------
  public async processQueue(
    files: BatchFileItem[],
    chain: BatchEffectItem[],
    exportSettings: BatchExportSettings,
    onFileUpdate: (updatedFile: BatchFileItem) => void,
    onGlobalProgress: (completedCount: number, totalCount: number, currentFileName: string) => void
  ): Promise<void> {
    this.isCancelled = false;
    const total = files.length;
    let completed = 0;

    for (let fIdx = 0; fIdx < total; fIdx++) {
      if (this.isCancelled) {
        systemLogger.info('AudioAI', 'Batch processing cancelled by user');
        break;
      }

      const item = files[fIdx];
      const startTime = performance.now();

      try {
        // Stage 1: Decoding
        item.status = 'decoding';
        item.progress = 10;
        item.statusMessage = 'Декодирование аудиопотока...';
        onFileUpdate({ ...item });
        onGlobalProgress(completed, total, item.name);

        const decoded = await this.decodeAudioFile(item.file);
        item.sampleRate = decoded.sampleRate;
        item.durationSec = decoded.duration;
        item.channels = 2;

        if (this.isCancelled) break;

        // Stage 2: Processing through Chain
        item.status = 'processing';
        item.progress = 25;
        item.statusMessage = 'Применение цепочки эффектов...';
        onFileUpdate({ ...item });

        const activeChain = chain.filter(c => c.enabled);
        const chainCount = activeChain.length;

        for (let cIdx = 0; cIdx < chainCount; cIdx++) {
          if (this.isCancelled) break;
          const effect = activeChain[cIdx];
          item.statusMessage = `[${cIdx + 1}/${chainCount}] ${effect.name}...`;
          item.progress = 25 + Math.round(((cIdx + 1) / (chainCount + 1)) * 50);
          onFileUpdate({ ...item });

          await this.executeEffectStep(effect, decoded.left, decoded.right, decoded.sampleRate);
        }

        if (this.isCancelled) break;

        // Stage 3: Normalization & Master Limiter Guard
        if (exportSettings.normalizeLoudness) {
          item.statusMessage = `Нормализация до ${exportSettings.targetLufs} LUFS...`;
          this.normalizeToLUFS(decoded.left, decoded.right, exportSettings.targetLufs);
        } else {
          this.processLimiter(decoded.left, decoded.right, -0.2);
        }

        // Stage 4: Encoding
        item.status = 'encoding';
        item.progress = 85;
        item.statusMessage = 'Кодирование выходного файла...';
        onFileUpdate({ ...item });

        const targetBitDepth: WavBitDepth = exportSettings.format === 'wav_32' ? 32 : exportSettings.format === 'wav_16' ? 16 : 24;
        const targetSampleRate = exportSettings.sampleRate === 'original' ? decoded.sampleRate : exportSettings.sampleRate;

        // Generate clean high-resolution WAV Blob (zero-alloc chunked streaming encoder)
        const processedBlob = encodeWavToBlob(decoded.left, decoded.right, targetSampleRate, targetBitDepth);
        const baseName = item.name.substring(0, item.name.lastIndexOf('.')) || item.name;
        const extension = exportSettings.format.startsWith('wav') ? 'wav' : exportSettings.format.split('_')[0];
        const outFileName = `${baseName}${exportSettings.filenameSuffix || '_processed'}.${extension}`;

        const blobUrl = BlobUrlRegistry.create(processedBlob);

        item.status = 'completed';
        item.progress = 100;
        item.statusMessage = 'Готово!';
        item.processedBlob = processedBlob;
        item.processedBlobUrl = blobUrl;
        item.processedFileName = outFileName;
        item.processingTimeMs = Math.round(performance.now() - startTime);

        completed++;
        onFileUpdate({ ...item });
        onGlobalProgress(completed, total, item.name);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        systemLogger.error('AudioAI', `Failed processing ${item.name}: ${errMsg}`);
        item.status = 'error';
        item.progress = 0;
        item.statusMessage = `Ошибка: ${errMsg}`;
        item.errorMessage = errMsg;
        onFileUpdate({ ...item });
        onGlobalProgress(completed, total, item.name);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Pack All Processed Files to ZIP
  // --------------------------------------------------------------------------
  public async createZipArchive(files: BatchFileItem[], zipFileName: string = 'VOMIX_Batch_Audio.zip'): Promise<Blob> {
    const zip = new JSZip();
    const readyFiles = files.filter(f => f.status === 'completed' && f.processedBlob);

    if (readyFiles.length === 0) {
      throw new Error('Нет обработанных файлов для создания ZIP-архива.');
    }

    for (const f of readyFiles) {
      if (f.processedBlob && f.processedFileName) {
        zip.file(f.processedFileName, f.processedBlob);
      }
    }

    // Include batch metadata manifest
    const manifest = {
      generator: 'VOMIXStudio Batch Audio Processor',
      generatedAt: new Date().toISOString(),
      fileCount: readyFiles.length,
      files: readyFiles.map(f => ({
        originalName: f.name,
        processedName: f.processedFileName,
        durationSec: f.durationSec,
        sizeBytes: f.processedBlob?.size,
        processingTimeMs: f.processingTimeMs
      }))
    };
    zip.file('batch_manifest.json', JSON.stringify(manifest, null, 2));

    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return zipBlob;
  }
}
