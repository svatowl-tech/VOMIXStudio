/**
 * ============================================================================
 * nativeEffectsCatalog.ts - Каталог 16 нативных C++ DSP модулей VOMIXStudio
 * ============================================================================
 * Полное типизированное описание параметров, диапазонов и единиц измерения
 * для всех нативных C++17 модулей обработки дорожек (TrackInsertChain).
 *
 * Архитектурное правило:
 * - Все вычисления выполняются в нативном C++ WebAssembly ядре (Zero Alloc).
 * - TypeScript хранит только дескрипторы и транслирует параметры через Bridge.
 * ============================================================================
 */

export interface EffectParamDescriptor {
  id: number;
  key: string;
  name: string;
  min: number;
  max: number;
  default: number;
  step: number;
  unit: string;
  isToggle?: boolean;
}

export interface NativeEffectDefinition {
  typeId: number;
  name: string;
  category: 'dynamics' | 'eq' | 'restoration' | 'spatial' | 'color' | 'filter' | 'utility';
  categoryLabel: string;
  description: string;
  badge?: string;
  color: string;
  params: EffectParamDescriptor[];
}

export interface TrackInsertEffect {
  id: string; // e.g. "fx-103-1727500000-1"
  typeId: number;
  name: string;
  category: string;
  bypassed: boolean;
  params: Record<number, number>;
}

export const NATIVE_DSP_CATALOG: NativeEffectDefinition[] = [
  // 1. PhraseLoudnessNormalizer (101)
  {
    typeId: 101,
    name: 'Phrase Leveler',
    category: 'dynamics',
    categoryLabel: 'Динамика речи',
    description: 'Интеллектуальное выравнивание громкости речевых фраз (Speech-Gated Leveler)',
    badge: 'Voice RMS',
    color: '#3b82f6',
    params: [
      { id: 0, key: 'targetRmsDb', name: 'Target RMS', min: -36, max: -6, default: -18, step: 0.5, unit: 'dB' },
      { id: 1, key: 'maxBoostDb', name: 'Max Boost', min: 0, max: 24, default: 12, step: 0.5, unit: 'dB' },
      { id: 2, key: 'maxCutDb', name: 'Max Cut', min: 0, max: 24, default: 12, step: 0.5, unit: 'dB' },
      { id: 3, key: 'gateThresholdDb', name: 'Gate Thresh', min: -80, max: -30, default: -48, step: 1, unit: 'dB' },
      { id: 4, key: 'attackMs', name: 'Attack', min: 5, max: 500, default: 50, step: 5, unit: 'ms' },
      { id: 5, key: 'releaseMs', name: 'Release', min: 50, max: 2000, default: 300, step: 10, unit: 'ms' },
      { id: 6, key: 'sensitivity', name: 'Sensitivity', min: 0.1, max: 1.0, default: 0.7, step: 0.05, unit: '' }
    ]
  },

  // 2. StudioCompressor (102)
  {
    typeId: 102,
    name: 'Studio Compressor',
    category: 'dynamics',
    categoryLabel: 'Динамика',
    description: 'Прецизионный VCA/Opto студийный компрессор с мягким коленом (Soft-Knee)',
    badge: 'VCA/Opto',
    color: '#06b6d4',
    params: [
      { id: 0, key: 'thresholdDb', name: 'Threshold', min: -60, max: 0, default: -18, step: 0.5, unit: 'dB' },
      { id: 1, key: 'ratio', name: 'Ratio', min: 1, max: 20, default: 4.0, step: 0.1, unit: ':1' },
      { id: 2, key: 'attackMs', name: 'Attack', min: 0.1, max: 200, default: 15, step: 0.5, unit: 'ms' },
      { id: 3, key: 'releaseMs', name: 'Release', min: 10, max: 2000, default: 150, step: 5, unit: 'ms' },
      { id: 4, key: 'kneeDb', name: 'Knee', min: 0, max: 24, default: 6.0, step: 0.5, unit: 'dB' },
      { id: 5, key: 'makeupGainDb', name: 'Makeup Gain', min: -12, max: 24, default: 0, step: 0.5, unit: 'dB' },
      { id: 6, key: 'dryWet', name: 'Dry / Wet', min: 0, max: 1.0, default: 1.0, step: 0.01, unit: '' }
    ]
  },

  // 3. ParametricEQPro (103)
  {
    typeId: 103,
    name: 'Parametric EQ Pro',
    category: 'eq',
    categoryLabel: 'Эквалайзер',
    description: '5-полосный параметрический эквалайзер аудиофильского класса (Biquad Pro)',
    badge: '5-Band EQ',
    color: '#10b981',
    params: [
      { id: 0, key: 'b1_freq', name: 'Low Freq', min: 20, max: 500, default: 80, step: 1, unit: 'Hz' },
      { id: 1, key: 'b1_gain', name: 'Low Gain', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB' },
      { id: 2, key: 'b1_q', name: 'Low Q', min: 0.1, max: 10, default: 0.707, step: 0.05, unit: '' },
      { id: 3, key: 'b2_freq', name: 'Low-Mid Freq', min: 80, max: 2000, default: 300, step: 5, unit: 'Hz' },
      { id: 4, key: 'b2_gain', name: 'Low-Mid Gain', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB' },
      { id: 5, key: 'b2_q', name: 'Low-Mid Q', min: 0.1, max: 10, default: 1.0, step: 0.05, unit: '' },
      { id: 6, key: 'b3_freq', name: 'Mid Freq', min: 200, max: 6000, default: 1500, step: 10, unit: 'Hz' },
      { id: 7, key: 'b3_gain', name: 'Mid Gain', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB' },
      { id: 8, key: 'b3_q', name: 'Mid Q', min: 0.1, max: 10, default: 1.0, step: 0.05, unit: '' },
      { id: 9, key: 'b4_freq', name: 'High-Mid Freq', min: 1000, max: 12000, default: 4500, step: 20, unit: 'Hz' },
      { id: 10, key: 'b4_gain', name: 'High-Mid Gain', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB' },
      { id: 11, key: 'b4_q', name: 'High-Mid Q', min: 0.1, max: 10, default: 1.0, step: 0.05, unit: '' },
      { id: 12, key: 'b5_freq', name: 'High Freq', min: 3000, max: 20000, default: 12000, step: 50, unit: 'Hz' },
      { id: 13, key: 'b5_gain', name: 'High Gain', min: -24, max: 24, default: 0, step: 0.5, unit: 'dB' },
      { id: 14, key: 'b5_q', name: 'High Q', min: 0.1, max: 10, default: 0.707, step: 0.05, unit: '' }
    ]
  },

  // 4. DynamicEQ (104)
  {
    typeId: 104,
    name: 'Dynamic EQ',
    category: 'eq',
    categoryLabel: 'Динамический EQ',
    description: 'Частотно-зависимый динамический эквалайзер для подавления проблемных резонансов',
    badge: 'Dynamic Band',
    color: '#84cc16',
    params: [
      { id: 0, key: 'freq', name: 'Frequency', min: 20, max: 20000, default: 2500, step: 10, unit: 'Hz' },
      { id: 1, key: 'q', name: 'Q Factor', min: 0.2, max: 10, default: 1.5, step: 0.1, unit: '' },
      { id: 2, key: 'thresholdDb', name: 'Threshold', min: -50, max: 0, default: -20, step: 0.5, unit: 'dB' },
      { id: 3, key: 'ratio', name: 'Ratio', min: 1, max: 10, default: 3.0, step: 0.1, unit: ':1' },
      { id: 4, key: 'maxDynamicGainDb', name: 'Max Dynamic Gain', min: -24, max: 12, default: -6.0, step: 0.5, unit: 'dB' },
      { id: 5, key: 'attackMs', name: 'Attack', min: 1, max: 100, default: 10, step: 1, unit: 'ms' },
      { id: 6, key: 'releaseMs', name: 'Release', min: 10, max: 500, default: 100, step: 5, unit: 'ms' }
    ]
  },

  // 5. GraphicEQ31 (105)
  {
    typeId: 105,
    name: 'Graphic EQ 31',
    category: 'eq',
    categoryLabel: 'Графический EQ',
    description: '31-полосный 1/3-октавный графический мастер-эквалайзер ISO',
    badge: '31-Band ISO',
    color: '#22c55e',
    params: [
      { id: 0, key: 'b_20', name: '20 Hz', min: -15, max: 15, default: 0, step: 0.5, unit: 'dB' },
      { id: 5, key: 'b_63', name: '63 Hz', min: -15, max: 15, default: 0, step: 0.5, unit: 'dB' },
      { id: 8, key: 'b_125', name: '125 Hz', min: -15, max: 15, default: 0, step: 0.5, unit: 'dB' },
      { id: 11, key: 'b_250', name: '250 Hz', min: -15, max: 15, default: 0, step: 0.5, unit: 'dB' },
      { id: 14, key: 'b_500', name: '500 Hz', min: -15, max: 15, default: 0, step: 0.5, unit: 'dB' },
      { id: 17, key: 'b_1k', name: '1 kHz', min: -15, max: 15, default: 0, step: 0.5, unit: 'dB' },
      { id: 20, key: 'b_2k', name: '2 kHz', min: -15, max: 15, default: 0, step: 0.5, unit: 'dB' },
      { id: 23, key: 'b_4k', name: '4 kHz', min: -15, max: 15, default: 0, step: 0.5, unit: 'dB' },
      { id: 26, key: 'b_8k', name: '8 kHz', min: -15, max: 15, default: 0, step: 0.5, unit: 'dB' },
      { id: 30, key: 'b_20k', name: '20 kHz', min: -15, max: 15, default: 0, step: 0.5, unit: 'dB' }
    ]
  },

  // 6. DeEsserPro (106)
  {
    typeId: 106,
    name: 'De-Esser Pro',
    category: 'restoration',
    categoryLabel: 'Реставрация',
    description: 'Профессиональный сплит-бэнд де-эссер для смягчения резких сибилянтов [С, З, Ц, Щ]',
    badge: 'Split-Band',
    color: '#eab308',
    params: [
      { id: 0, key: 'frequency', name: 'Sibilance Freq', min: 2000, max: 12000, default: 6500, step: 50, unit: 'Hz' },
      { id: 1, key: 'thresholdDb', name: 'Threshold', min: -40, max: 0, default: -22, step: 0.5, unit: 'dB' },
      { id: 2, key: 'ratio', name: 'Ratio', min: 1, max: 10, default: 4.0, step: 0.2, unit: ':1' },
      { id: 3, key: 'maxReductionDb', name: 'Max Reduction', min: 0, max: 24, default: 12, step: 0.5, unit: 'dB' },
      { id: 4, key: 'attackMs', name: 'Attack', min: 0.1, max: 20, default: 1.0, step: 0.1, unit: 'ms' },
      { id: 5, key: 'releaseMs', name: 'Release', min: 5, max: 200, default: 50, step: 1, unit: 'ms' },
      { id: 6, key: 'splitBand', name: 'Split-Band Mode', min: 0, max: 1, default: 1, step: 1, unit: '', isToggle: true }
    ]
  },

  // 7. SmartBreathController (107)
  {
    typeId: 107,
    name: 'Smart Breath Controller',
    category: 'restoration',
    categoryLabel: 'Реставрация речи',
    description: 'Автоматическое обнаружение и плавное ослабление вдохов актера без резких щелчков',
    badge: 'De-Breath RX',
    color: '#14b8a6',
    params: [
      { id: 0, key: 'targetReductionDb', name: 'Reduction', min: -30, max: 0, default: -12, step: 0.5, unit: 'dB' },
      { id: 1, key: 'sensitivity', name: 'Sensitivity', min: 0.1, max: 1.0, default: 0.65, step: 0.02, unit: '' },
      { id: 2, key: 'lookaheadMs', name: 'Lookahead', min: 1, max: 20, default: 5, step: 0.5, unit: 'ms' },
      { id: 3, key: 'attackMs', name: 'Fade In', min: 5, max: 80, default: 25, step: 1, unit: 'ms' },
      { id: 4, key: 'releaseMs', name: 'Fade Out', min: 20, max: 300, default: 80, step: 5, unit: 'ms' }
    ]
  },

  // 8. MouthDeClicker (108)
  {
    typeId: 108,
    name: 'Mouth De-Clicker',
    category: 'restoration',
    categoryLabel: 'Реставрация',
    description: 'Устранение влажных щелчков губ, слюны и языка сплайновой интерполяцией',
    badge: 'Spline Repair',
    color: '#0ea5e9',
    params: [
      { id: 0, key: 'sensitivity', name: 'Sensitivity', min: 0.01, max: 0.5, default: 0.08, step: 0.01, unit: '' },
      { id: 1, key: 'maxClickDurationSamples', name: 'Max Duration', min: 12, max: 192, default: 64, step: 4, unit: 'smp' },
      { id: 2, key: 'highPassCutoff', name: 'HPF Detect', min: 1000, max: 8000, default: 3500, step: 100, unit: 'Hz' },
      { id: 3, key: 'wideningMargin', name: 'Repair Margin', min: 1, max: 16, default: 4, step: 1, unit: 'smp' }
    ]
  },

  // 9. ProximityControl (109)
  {
    typeId: 109,
    name: 'Proximity Control',
    category: 'restoration',
    categoryLabel: 'Реставрация речи',
    description: 'Динамическое подавление избыточного суббаса и бубнения близкого микрофона',
    badge: 'Anti-Boom',
    color: '#6366f1',
    params: [
      { id: 0, key: 'cutoffFrequency', name: 'Low-Shelf Cutoff', min: 50, max: 250, default: 120, step: 2, unit: 'Hz' },
      { id: 1, key: 'thresholdDb', name: 'Threshold', min: -30, max: 0, default: -16, step: 0.5, unit: 'dB' },
      { id: 2, key: 'maxReductionDb', name: 'Max Reduction', min: 0, max: 18, default: 8, step: 0.5, unit: 'dB' },
      { id: 3, key: 'responseMs', name: 'Response Time', min: 5, max: 200, default: 30, step: 1, unit: 'ms' },
      { id: 4, key: 'releaseMs', name: 'Release Time', min: 20, max: 500, default: 120, step: 5, unit: 'ms' },
      { id: 5, key: 'sensitivity', name: 'Ratio Sensitivity', min: 0.1, max: 2.0, default: 1.0, step: 0.05, unit: '' }
    ]
  },

  // 10. AutoPhaseAligner (110)
  {
    typeId: 110,
    name: 'Auto Phase Aligner',
    category: 'utility',
    categoryLabel: 'Фазовая коррекция',
    description: 'Субмиллисекундная коррекция фазового сдвига дорожек и микрофонов дубляжа',
    badge: 'Cross-Correlation',
    color: '#a855f7',
    params: [
      { id: 0, key: 'maxShiftMs', name: 'Max Search Shift', min: 0.5, max: 25, default: 10, step: 0.5, unit: 'ms' },
      { id: 1, key: 'autoInvertPolarity', name: 'Auto Invert 180°', min: 0, max: 1, default: 1, step: 1, unit: '', isToggle: true }
    ]
  },

  // 11. TransientShaper (111)
  {
    typeId: 111,
    name: 'Transient Shaper',
    category: 'dynamics',
    categoryLabel: 'Динамика',
    description: 'Раздельное управление атакой (ударом согласных) и сустейном (хвостом звука)',
    badge: 'Attack/Sustain',
    color: '#ec4899',
    params: [
      { id: 0, key: 'attackGainDb', name: 'Attack Gain', min: -18, max: 18, default: 0, step: 0.5, unit: 'dB' },
      { id: 1, key: 'sustainGainDb', name: 'Sustain Gain', min: -18, max: 18, default: 0, step: 0.5, unit: 'dB' },
      { id: 2, key: 'outputGainDb', name: 'Output Gain', min: -12, max: 12, default: 0, step: 0.5, unit: 'dB' },
      { id: 3, key: 'softClip', name: 'Analog Soft Clip', min: 0, max: 1, default: 1, step: 1, unit: '', isToggle: true }
    ]
  },

  // 12. ResonanceSuppressor (112)
  {
    typeId: 112,
    name: 'Resonance Suppressor',
    category: 'restoration',
    categoryLabel: 'Реставрация',
    description: 'Динамическое авто-подавление узких резонансов комнаты и микрофона (аналог Soothe / DSEQ)',
    badge: 'Smart Soothe',
    color: '#f43f5e',
    params: [
      { id: 0, key: 'sensitivity', name: 'Sensitivity', min: 0.1, max: 1.0, default: 0.5, step: 0.02, unit: '' },
      { id: 1, key: 'maxAttenuationDb', name: 'Max Cut', min: 0, max: 24, default: 9.0, step: 0.5, unit: 'dB' },
      { id: 2, key: 'maxNotches', name: 'Notch Count', min: 1, max: 16, default: 6, step: 1, unit: '' },
      { id: 3, key: 'sharpness', name: 'Sharpness Q', min: 0.5, max: 4.0, default: 1.8, step: 0.1, unit: '' },
      { id: 4, key: 'attackMs', name: 'Attack', min: 1, max: 50, default: 8, step: 1, unit: 'ms' },
      { id: 5, key: 'releaseMs', name: 'Release', min: 10, max: 250, default: 60, step: 5, unit: 'ms' }
    ]
  },

  // 13. TapeSaturation (113)
  {
    typeId: 113,
    name: 'Tape Saturation',
    category: 'color',
    categoryLabel: 'Окрас звука',
    description: 'Аналоговая пленочная сатурация с физическим моделированием петли гистерезиса Studer A800',
    badge: 'Studer Tape',
    color: '#d97706',
    params: [
      { id: 0, key: 'driveDb', name: 'Tape Drive', min: 0, max: 24, default: 4.0, step: 0.5, unit: 'dB' },
      { id: 1, key: 'bias', name: 'Tape Bias', min: -1.0, max: 1.0, default: 0.0, step: 0.05, unit: '' },
      { id: 2, key: 'saturationMix', name: 'Tape Mix', min: 0.0, max: 1.0, default: 0.7, step: 0.02, unit: '' },
      { id: 3, key: 'lowFreqColor', name: 'Head Bump Bass', min: 0.0, max: 6.0, default: 1.5, step: 0.2, unit: 'dB' },
      { id: 4, key: 'highFreqRolloff', name: 'Gap Loss Highs', min: 8000, max: 22000, default: 16000, step: 200, unit: 'Hz' },
      { id: 5, key: 'autoGain', name: 'Auto Makeup', min: 0, max: 1, default: 1, step: 1, unit: '', isToggle: true }
    ]
  },

  // 14. LinearPhaseFilter (114)
  {
    typeId: 114,
    name: 'Linear Phase Filter',
    category: 'filter',
    categoryLabel: 'Фильтры',
    description: 'Линейно-фазовые срезы HPF и LPF без фазового размытия и фазовой каши',
    badge: 'Zero-Phase Distortion',
    color: '#059669',
    params: [
      { id: 0, key: 'hpFreq', name: 'High-Pass Cutoff', min: 10, max: 1000, default: 40, step: 5, unit: 'Hz' },
      { id: 1, key: 'lpFreq', name: 'Low-Pass Cutoff', min: 2000, max: 22000, default: 18000, step: 100, unit: 'Hz' },
      { id: 2, key: 'filterOrder', name: 'FIR Filter Taps', min: 128, max: 1024, default: 256, step: 64, unit: 'taps' }
    ]
  },

  // 15. StudioReverb (115)
  {
    typeId: 115,
    name: 'Studio Reverb',
    category: 'spatial',
    categoryLabel: 'Пространство',
    description: 'Алгоритмический ревербератор (Feedback Delay Network) для создания естественного объема комнаты',
    badge: 'FDN Plate/Room',
    color: '#8b5cf6',
    params: [
      { id: 0, key: 'roomSize', name: 'Room Size', min: 0.05, max: 0.98, default: 0.45, step: 0.01, unit: '' },
      { id: 1, key: 'damping', name: 'High Damping', min: 0.0, max: 0.95, default: 0.35, step: 0.01, unit: '' },
      { id: 2, key: 'wetDryMix', name: 'Wet / Dry Mix', min: 0.0, max: 1.0, default: 0.15, step: 0.01, unit: '' },
      { id: 3, key: 'preDelayMs', name: 'Pre-Delay', min: 0, max: 100, default: 20, step: 1, unit: 'ms' },
      { id: 4, key: 'stereoWidth', name: 'Stereo Width', min: 0.0, max: 2.0, default: 1.0, step: 0.05, unit: '' },
      { id: 5, key: 'lowCutHz', name: 'Low Cut', min: 20, max: 500, default: 100, step: 10, unit: 'Hz' }
    ]
  },

  // 16. FFTSpectralFilter (116)
  {
    typeId: 116,
    name: 'FFT Spectral Filter',
    category: 'filter',
    categoryLabel: 'Спектральный фильтр',
    description: 'Узкополосный спектральный фильтр на основе быстрого преобразования Фурье',
    badge: 'FFT Band',
    color: '#d946ef',
    params: [
      { id: 0, key: 'centerHz', name: 'Center Freq', min: 50, max: 16000, default: 1000, step: 10, unit: 'Hz' },
      { id: 1, key: 'bandwidthHz', name: 'Bandwidth', min: 50, max: 4000, default: 300, step: 10, unit: 'Hz' },
      { id: 2, key: 'gainLinear', name: 'Band Gain', min: 0.0, max: 4.0, default: 1.0, step: 0.05, unit: 'x' }
    ]
  }
];

export function getEffectDefinition(typeId: number): NativeEffectDefinition | undefined {
  return NATIVE_DSP_CATALOG.find((def) => def.typeId === typeId);
}

export function createDefaultInsertEffect(typeId: number): TrackInsertEffect {
  const def = getEffectDefinition(typeId);
  const params: Record<number, number> = {};
  if (def) {
    for (const p of def.params) {
      params[p.id] = p.default;
    }
  }
  return {
    id: `fx-${typeId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    typeId,
    name: def ? def.name : `Effect ${typeId}`,
    category: def ? def.category : 'effects',
    bypassed: false,
    params
  };
}

/**
 * Создание дефолтной цепочки для качественного дикторского голоса/вокала:
 * [MouthDeClicker (108) -> SmartBreathController (107) -> ParametricEQPro (103) -> StudioCompressor (102) -> DeEsserPro (106)]
 */
export function createDefaultVocalInsertChain(): TrackInsertEffect[] {
  return [
    createDefaultInsertEffect(108), // MouthDeClicker
    createDefaultInsertEffect(107), // SmartBreathController
    createDefaultInsertEffect(103), // ParametricEQPro
    createDefaultInsertEffect(102), // StudioCompressor
    createDefaultInsertEffect(106)  // DeEsserPro
  ];
}
