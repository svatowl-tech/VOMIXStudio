/**
 * ============================================================================
 * VST / CLAP / DSP PLUGIN ARCHITECTURE & TYPINGS
 * ============================================================================
 * Индустриальный стандарт описания, параметров и состояния VST/VST3/CLAP/DSP плагинов
 * для интеграции в C++ WebAssembly & AudioWorklet аудиоконвейер.
 * ============================================================================
 */

export type VSTPluginCategory =
  | 'EQ'
  | 'Dynamics'
  | 'Reverb'
  | 'Restoration'
  | 'Mastering'
  | 'Limiter'
  | 'Delay'
  | 'Vocal'
  | 'Saturation'
  | 'Pitch'
  | 'Master'
  | 'Utility';

export type VSTPluginFormat = 'VST3' | 'VST2' | 'CLAP' | 'Native/WASM';

export interface VSTParameterDef {
  id: string;
  name: string;
  min: number;
  max: number;
  defaultValue: number;
  unit: string;
  step?: number;
  options?: string[]; // Для дискретных переключателей
  formatValue?: (val: number) => string;
}

export interface VSTPluginPreset {
  id: string;
  name: string;
  description?: string;
  parameters: Record<string, number>;
}

export interface VSTPluginDefinition {
  id: string;
  name: string;
  category: VSTPluginCategory;
  vendor: string;
  version: string;
  format: VSTPluginFormat;
  path: string;
  latencySamples: number;
  is64Bit: boolean;
  description: string;
  iconName?: string;
  color: string;
  parameters: VSTParameterDef[];
  presets: VSTPluginPreset[];
  isBuiltIn?: boolean;
  isCustomInstalled?: boolean;
  // Поля для поддержки Shell-контейнеров (WaveShell / VST3 Multi-Class Modules)
  classUid?: string;          // 16-байтный / 32-hex GUID конкретного VST3 класса в пакете
  subPluginId?: number | string; // Числовой или строковый идентификатор суб-плагина (VST2 Shell / Waves)
  isShell?: boolean;          // Флаг суб-плагина внутри Shell-пакета (WaveShell)
  shellPath?: string;         // Путь к родительскому файлу контейнера (.vst3 / .dll)
}

/**
 * Дескриптор VST-плагина по стандарту Universal VST Contract
 */
export type VSTPluginDescriptor = VSTPluginDefinition;

export interface VSTPluginInstance {
  instanceId: string;
  pluginId: string;
  name: string;
  category: VSTPluginCategory;
  vendor: string;
  format: VSTPluginFormat;
  enabled: boolean;
  wetDry: number; // 0.0 - 1.0 (0% - 100%)
  parameters: Record<string, number>;
  activePresetId?: string;
  stateChunkBase64?: string;
  gainReductionDb?: number;
  peakInL?: number;
  peakInR?: number;
  peakOutL?: number;
  peakOutR?: number;
  // Shell-метаданные инстанса
  classUid?: string;
  subPluginId?: number | string;
  isShell?: boolean;
  shellPath?: string;
}

export interface VSTScanDirectory {
  path: string;
  enabled: boolean;
  isSystemDefault: boolean;
  pluginCount: number;
  lastScannedAt?: string;
}

export interface VSTScanStats {
  totalPlugins: number;
  vst3Count: number;
  vst2Count: number;
  clapCount: number;
  wasmCount: number;
  lastScanTimestamp: number;
  isCached: boolean;
  scanDurationMs: number;
}

/**
 * Дескриптор встроенного плагина De-Plosive Pro (Native DSP Core)
 */
export const DE_PLOSIVE_PRO_DESCRIPTOR: VSTPluginDefinition = {
  id: 'vst-deplosive-pro',
  name: 'De-Plosive Pro',
  category: 'Restoration',
  vendor: 'VOMIX DSP Native Core',
  version: '1.0.0',
  format: 'Native/WASM',
  path: 'built-in://plugins/deplosive-pro',
  latencySamples: 0,
  is64Bit: true,
  isBuiltIn: true,
  description: 'Профессиональное подавление взрывных согласных «п»/«б» и задувов микрофона через LR4-кроссовер и динамический VCA-аттенюатор.',
  color: '#06b6d4',
  parameters: [
    {
      id: 'thresholdDb',
      name: 'Threshold',
      min: -60,
      max: 0,
      defaultValue: -24,
      unit: 'dB',
      step: 0.5,
      formatValue: (v: number) => `${v.toFixed(1)} dB`
    },
    {
      id: 'frequencyLimit',
      name: 'Frequency Limit',
      min: 40,
      max: 350,
      defaultValue: 120,
      unit: 'Hz',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)} Hz`
    },
    {
      id: 'suppressionDepthDb',
      name: 'Suppression Depth',
      min: -48,
      max: 0,
      defaultValue: -18,
      unit: 'dB',
      step: 0.5,
      formatValue: (v: number) => `${v.toFixed(1)} dB`
    },
    {
      id: 'recoveryMs',
      name: 'Recovery Time',
      min: 5,
      max: 300,
      defaultValue: 35,
      unit: 'ms',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)} ms`
    },
    {
      id: 'wetDry',
      name: 'Wet / Dry Mix',
      min: 0,
      max: 100,
      defaultValue: 100,
      unit: '%',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)}%`
    }
  ],
  presets: [
    {
      id: 'vocal-standard',
      name: 'Standard Dialogue Clean',
      description: 'Оптимально для дубляжа и подкастов со стандартной чувствительностью',
      parameters: { thresholdDb: -24, frequencyLimit: 120, suppressionDepthDb: -18, recoveryMs: 35, wetDry: 100 }
    },
    {
      id: 'heavy-wind-blast',
      name: 'Heavy Wind & Mic Pop Cut',
      description: 'Глубокое подавление сильных задувов без поп-фильтра',
      parameters: { thresholdDb: -30, frequencyLimit: 150, suppressionDepthDb: -28, recoveryMs: 25, wetDry: 100 }
    },
    {
      id: 'subtle-warmth-preserve',
      name: 'Transparent Vocal Warmth',
      description: 'Мягкая очистка с сохранением низкого тембра диктора',
      parameters: { thresholdDb: -20, frequencyLimit: 90, suppressionDepthDb: -12, recoveryMs: 45, wetDry: 85 }
    }
  ]
};

/**
 * Дескриптор встроенного плагина Vocal Thickener & Tape Sat (Native DSP Core)
 */
export const VOCAL_THICKENER_DESCRIPTOR: VSTPluginDefinition = {
  id: 'vst-vocal-thickener',
  name: 'Vocal Thickener & Tape Sat',
  category: 'Dynamics',
  vendor: 'VOMIX DSP Native Core',
  version: '1.0.0',
  format: 'Native/WASM',
  path: 'built-in://plugins/vocal-thickener',
  latencySamples: 0,
  is64Bit: true,
  isBuiltIn: true,
  description: 'Добавление фундаментного тела речи четными субгармониками Чебышёва (120-250 Гц), ВЧ эксайтером (3-6 кГц) и ленточной сатурацией с Auto-Gain Match.',
  color: '#f59e0b',
  parameters: [
    {
      id: 'bodyDrive',
      name: 'Body Drive',
      min: 0,
      max: 100,
      defaultValue: 50,
      unit: '%',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)}%`
    },
    {
      id: 'presenceClarity',
      name: 'Presence Clarity',
      min: 0,
      max: 100,
      defaultValue: 40,
      unit: '%',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)}%`
    },
    {
      id: 'tapeDensity',
      name: 'Tape Density',
      min: 0,
      max: 100,
      defaultValue: 45,
      unit: '%',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)}%`
    },
    {
      id: 'mix',
      name: 'Dry / Wet Mix',
      min: 0,
      max: 100,
      defaultValue: 100,
      unit: '%',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)}%`
    }
  ],
  presets: [
    {
      id: 'radio-broadcast-punch',
      name: 'Radio & Cinema Trailer Punch',
      description: 'Глубокое кинематографическое тело и плотная ленточная сатурация для дикторской подачи',
      parameters: { bodyDrive: 65, presenceClarity: 55, tapeDensity: 60, mix: 100 }
    },
    {
      id: 'warm-vintage-dialogue',
      name: 'Warm Vintage Tube & Tape',
      description: 'Мягкое аналоговое тепло с умеренным насыщением и бархатными гармониками',
      parameters: { bodyDrive: 45, presenceClarity: 30, tapeDensity: 50, mix: 100 }
    },
    {
      id: 'silk-air-presence',
      name: 'Silky Air & Presence Boost',
      description: 'Акцент на разборчивость согласных и шелковые верха без истончения фундамента',
      parameters: { bodyDrive: 35, presenceClarity: 70, tapeDensity: 30, mix: 90 }
    }
  ]
};

/**
 * Дескриптор встроенного плагина Spectral De-Reverb Lite (Native DSP Core)
 */
export const SPECTRAL_DEREVERB_DESCRIPTOR: VSTPluginDefinition = {
  id: 'vst-spectral-dereverb',
  name: 'Spectral De-Reverb Lite',
  category: 'Restoration',
  vendor: 'VOMIX DSP Native Core',
  version: '1.0.0',
  format: 'Native/WASM',
  path: 'built-in://plugins/spectral-dereverb',
  latencySamples: 0,
  is64Bit: true,
  isBuiltIn: true,
  description: '16-полосный алгоритмический подавитель комнатного эха с оценкой затухания диффузной энергии и сохранением согласных речи.',
  color: '#06b6d4',
  parameters: [
    {
      id: 'reductionDb',
      name: 'Reduction',
      min: -18,
      max: 0,
      defaultValue: -9,
      unit: 'dB',
      step: 0.5,
      formatValue: (v: number) => `${v.toFixed(1)} dB`
    },
    {
      id: 'decayTimeEstMs',
      name: 'Decay Est (RT60)',
      min: 100,
      max: 800,
      defaultValue: 350,
      unit: 'ms',
      step: 10,
      formatValue: (v: number) => `${Math.round(v)} ms`
    },
    {
      id: 'clarity',
      name: 'Clarity / Transient Guard',
      min: 0,
      max: 100,
      defaultValue: 70,
      unit: '%',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)}%`
    },
    {
      id: 'mix',
      name: 'Dry / Wet Mix',
      min: 0,
      max: 100,
      defaultValue: 100,
      unit: '%',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)}%`
    }
  ],
  presets: [
    {
      id: 'gentle-room-tighten',
      name: 'Dry Studio Booth (Gentle)',
      description: 'Легкое устранение комнатного призвука жилой комнаты',
      parameters: { reductionDb: -6, decayTimeEstMs: 250, clarity: 75, mix: 100 }
    },
    {
      id: 'heavy-hall-reverb-cut',
      name: 'Large Hall De-Echo (Heavy)',
      description: 'Глубокое подавление длинного реверберационного хвоста и эха',
      parameters: { reductionDb: -14, decayTimeEstMs: 550, clarity: 80, mix: 100 }
    },
    {
      id: 'podcast-speech-clarity',
      name: 'Podcast Speech Presence Guard',
      description: 'Максимальный упор на четкость согласных и атаку голоса',
      parameters: { reductionDb: -9, decayTimeEstMs: 320, clarity: 95, mix: 90 }
    }
  ]
};

/**
 * Дескриптор встроенного плагина Headroom Recovery & Gain (Native DSP Core)
 */
export const HEADROOM_RECOVERY_DESCRIPTOR: VSTPluginDefinition = {
  id: 'vst-headroom-recovery',
  name: 'Headroom Recovery & Gain',
  category: 'Dynamics',
  vendor: 'VOMIX DSP Native Core',
  version: '1.0.0',
  format: 'Native/WASM',
  path: 'built-in://plugins/headroom-recovery',
  latencySamples: 144, // 3 ms lookahead at 48k
  is64Bit: true,
  isBuiltIn: true,
  description: 'Интеллектуальный безопасный разгон тихих дикторских записей до -6 dBFS с ограничением буста до +36 dB и защитой True Peak Brickwall.',
  color: '#10b981',
  parameters: [
    {
      id: 'targetPeakDb',
      name: 'Target Peak',
      min: -24,
      max: 0,
      defaultValue: -6,
      unit: 'dBFS',
      step: 0.5,
      formatValue: (v: number) => `${v.toFixed(1)} dBFS`
    },
    {
      id: 'maxBoostDb',
      name: 'Max Boost',
      min: 6,
      max: 48,
      defaultValue: 36,
      unit: 'dB',
      step: 1,
      formatValue: (v: number) => `+${Math.round(v)} dB`
    },
    {
      id: 'manualGainDb',
      name: 'Manual Gain',
      min: -24,
      max: 48,
      defaultValue: 0,
      unit: 'dB',
      step: 0.5,
      formatValue: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`
    },
    {
      id: 'lookaheadMs',
      name: 'Lookahead Guard',
      min: 0,
      max: 10,
      defaultValue: 3,
      unit: 'ms',
      step: 0.5,
      formatValue: (v: number) => `${v.toFixed(1)} ms`
    },
    {
      id: 'mix',
      name: 'Dry / Wet Mix',
      min: 0,
      max: 100,
      defaultValue: 100,
      unit: '%',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)}%`
    }
  ],
  presets: [
    {
      id: 'safe-dialogue-recovery',
      name: 'Safe Dialogue Boost (-6 dBFS Peak, +36 dB Max)',
      description: 'Стандартный безопасный разгон тихого дубля с защитой от разгона пустого шума',
      parameters: { targetPeakDb: -6, maxBoostDb: 36, manualGainDb: 0, lookaheadMs: 3, mix: 100 }
    },
    {
      id: 'whisper-mic-rescue',
      name: 'Ultra-Quiet Recording Rescue (+42 dB Max)',
      description: 'Экстремальный подъем очень тихих реплик и шепота',
      parameters: { targetPeakDb: -4.5, maxBoostDb: 42, manualGainDb: 6, lookaheadMs: 4, mix: 100 }
    },
    {
      id: 'broadcast-headroom-target',
      name: 'Broadcast Preamp Leveler (-9 dBFS Peak)',
      description: 'Консервативный преамп для последующей цепочки мастеринга',
      parameters: { targetPeakDb: -9, maxBoostDb: 24, manualGainDb: 0, lookaheadMs: 2.5, mix: 100 }
    }
  ]
};

/**
 * Дескриптор встроенного плагина Speech Dynamic Leveler (Native DSP Core)
 */
export const SPEECH_LEVELER_DESCRIPTOR: VSTPluginDefinition = {
  id: 'vst-speech-leveler',
  name: 'Speech Dynamic Leveler',
  category: 'Dynamics',
  vendor: 'VOMIX DSP Native Core',
  version: '1.0.0',
  format: 'Native/WASM',
  path: 'built-in://plugins/speech-leveler',
  latencySamples: 0,
  is64Bit: true,
  isBuiltIn: true,
  description: 'Двухступенчатый авто-фейдер речи: медленный RMS левеллер (250-500 мс) с Gate Freeze в паузах и быстрый пиковый лимитер выкриков.',
  color: '#8b5cf6',
  parameters: [
    {
      id: 'targetLevelDb',
      name: 'Target Level',
      min: -36,
      max: 0,
      defaultValue: -18,
      unit: 'dBFS',
      step: 0.5,
      formatValue: (v: number) => `${v.toFixed(1)} dBFS`
    },
    {
      id: 'levelingSpeedMs',
      name: 'Reaction Speed',
      min: 20,
      max: 1000,
      defaultValue: 300,
      unit: 'ms',
      step: 10,
      formatValue: (v: number) => `${Math.round(v)} ms`
    },
    {
      id: 'maxBoostDb',
      name: 'Max Boost',
      min: 0,
      max: 24,
      defaultValue: 12,
      unit: 'dB',
      step: 0.5,
      formatValue: (v: number) => `+${v.toFixed(1)} dB`
    },
    {
      id: 'maxCutDb',
      name: 'Max Cut',
      min: -36,
      max: 0,
      defaultValue: -18,
      unit: 'dB',
      step: 0.5,
      formatValue: (v: number) => `${v.toFixed(1)} dB`
    },
    {
      id: 'silenceGateDb',
      name: 'Gate Freeze',
      min: -70,
      max: -20,
      defaultValue: -45,
      unit: 'dBFS',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)} dBFS`
    },
    {
      id: 'peakCeilingDb',
      name: 'Peak Tamer Ceiling',
      min: -12,
      max: 0,
      defaultValue: -2,
      unit: 'dBFS',
      step: 0.5,
      formatValue: (v: number) => `${v.toFixed(1)} dBFS`
    },
    {
      id: 'mix',
      name: 'Dry / Wet Mix',
      min: 0,
      max: 100,
      defaultValue: 100,
      unit: '%',
      step: 1,
      formatValue: (v: number) => `${Math.round(v)}%`
    }
  ],
  presets: [
    {
      id: 'broadcast-speech-balance',
      name: 'Broadcast Standard Voice (-18 dBFS Target, 300ms)',
      description: 'Идеальный баланс шепота и нормальной дикторской речи для радио и ТВ',
      parameters: { targetLevelDb: -18, levelingSpeedMs: 300, maxBoostDb: 12, maxCutDb: -18, silenceGateDb: -45, peakCeilingDb: -2, mix: 100 }
    },
    {
      id: 'dynamic-podcast-leveler',
      name: 'Podcast & Interview Auto-Fader (Smooth)',
      description: 'Мягкое медленное выравнивание нескольких участников диалога без пампинга пауз',
      parameters: { targetLevelDb: -16, levelingSpeedMs: 450, maxBoostDb: 14, maxCutDb: -16, silenceGateDb: -48, peakCeilingDb: -1.5, mix: 100 }
    },
    {
      id: 'extreme-whisper-shout-tame',
      name: 'Extreme Whisper-to-Scream Control',
      description: 'Агрессивное обуздание эмоциональных актерских перепадов (от шепота до воплей)',
      parameters: { targetLevelDb: -18, levelingSpeedMs: 180, maxBoostDb: 18, maxCutDb: -24, silenceGateDb: -42, peakCeilingDb: -3, mix: 100 }
    }
  ]
};

/**
 * Глобальный каталог всех встроенных нативных C++ DSP плагинов VOMIX Studio
 */
export const BUILTIN_DSP_PLUGINS: VSTPluginDefinition[] = [
  DE_PLOSIVE_PRO_DESCRIPTOR,
  VOCAL_THICKENER_DESCRIPTOR,
  SPECTRAL_DEREVERB_DESCRIPTOR,
  HEADROOM_RECOVERY_DESCRIPTOR,
  SPEECH_LEVELER_DESCRIPTOR
];




