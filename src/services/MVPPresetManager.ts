/**
 * ============================================================================
 * MVP GLOBAL PIPELINE PRESET SYSTEM (Industrial Studio Pipeline Presets)
 * ============================================================================
 * Глобальные пресеты для MVP конвейера с 4 основными типами:
 * 1. Закадр (Voiceover / Overdub)
 * 2. Рекаст (Recast)
 * 3. Ридап (Readup)
 * 4. Дубляж (Dubbing)
 *
 * Сохраняют и восстанавливают полное состояние всего пайплайна:
 * - Все VST-плагины, их цепочки, позиции, байпас, wet/dry и параметры на дорожках
 * - Настройки C++ DSP рэка (EQ, Compressor, Noise Gate, DeEsser, AutoDucker, DeClicker)
 * - Настройки и VST-цепочку Master Voiceover Bus
 * - Настройки и VST-цепочку общего Master Output канала
 * ============================================================================
 */

import { TrackDSP, VocalBusState, MasterState, TrackState } from '../audio/dawEngine';
import { VSTPluginInstance } from '../audio/vstTypes';
import { globalVSTHostEngine } from './VSTHostEngine';
import { systemLogger } from './SystemLogger';

export type MVPPresetCategory = 'Закадр' | 'Рекаст' | 'Редаб' | 'Ридап' | 'Дубляж' | 'Custom';

export interface MVPPresetRequirements {
  emotions: string;
  syncTiming: string;
  physics: string;
  effectsMix: string;
}

export interface MVPPreset {
  id: string;
  name: string;
  category: MVPPresetCategory;
  description: string;
  author: string;
  targetLufsDb: number;
  icon: string;
  color: string;
  isBuiltIn?: boolean;
  createdAt: string;
  requirements?: MVPPresetRequirements;

  // Шаблон DSP рэка для речевых дорожек
  trackDspTemplate: TrackDSP;

  // Шаблон VST плагинов для речевых дорожек (позиции, плагины, байпас, wet/dry, параметры)
  trackVstChain: VSTPluginInstance[];

  // Настройки и VST плагины для Master Voiceover Bus
  vocalBusSettings: {
    volumeDb: number;
    pan: number;
    dsp: VocalBusState['dsp'];
    vstChain: VSTPluginInstance[];
  };

  // Настройки и VST плагины для общего Master
  masterSettings: {
    volumeDb: number;
    pan: number;
    limiterEnabled: boolean;
    limiterCeilingDb: number;
    vstChain: VSTPluginInstance[];
  };

  // Опциональные индивидуальные настройки для каждой дорожки проекта (если заданы)
  customTrackChains?: {
    trackIndex: number;
    trackName?: string;
    vstPlugins: VSTPluginInstance[];
    dsp?: TrackDSP;
  }[];
}

const STORAGE_USER_PRESETS_KEY = 'vomix_mvp_pipeline_presets_v2';

/**
 * 4 Базовых студийных пресета MVP пайплайна:
 * 1. Закадр
 * 2. Рекаст
 * 3. Редаб
 * 4. Дубляж
 */
export const BUILT_IN_MVP_PRESETS: MVPPreset[] = [
  // 1. ЗАКАДР (Voiceover)
  {
    id: 'preset-zakadr',
    name: 'Закадр',
    category: 'Закадр',
    description: 'Запись (быстрая), не требующая особых эмоциональных вложений, сводится без эффектов.',
    author: 'VOMIX Core Lab',
    targetLufsDb: -16.0,
    icon: 'Mic2',
    color: '#10b981',
    isBuiltIn: true,
    createdAt: '2026-01-01',
    requirements: {
      emotions: 'Не требует особых эмоциональных вложений',
      syncTiming: 'Свободная / поверх оригинального звука',
      physics: 'Не озвучивается',
      effectsMix: 'Сводится без эффектов (чистый голос)'
    },
    trackDspTemplate: {
      eq: {
        lowShelf: { type: 'lowshelf', frequency: 100, gainDb: -3.0, Q: 0.7071, enabled: true },
        peaking: { type: 'peaking', frequency: 2800, gainDb: 3.0, Q: 1.1, enabled: true },
        highShelf: { type: 'highshelf', frequency: 10000, gainDb: 2.0, Q: 0.7071, enabled: true },
        enabled: true
      },
      compressor: {
        thresholdDb: -18,
        ratio: 4.0,
        attackMs: 10,
        releaseMs: 120,
        makeupGainDb: 2.0,
        kneeDb: 6,
        enabled: true,
        currentGainReductionDb: 0
      },
      noiseGate: {
        thresholdDb: -44,
        attackMs: 2,
        holdMs: 40,
        releaseMs: 100,
        floorDb: -60,
        enabled: true
      },
      deEsser: {
        thresholdDb: -22,
        frequency: 6000,
        ratio: 5.0,
        attackMs: 1.0,
        releaseMs: 30,
        enabled: true
      },
      autoDucker: {
        thresholdDb: -22,
        duckDepthDb: -12,
        attackMs: 12,
        releaseMs: 220,
        enabled: true,
        sourceTrackId: 1,
        currentDuckingGainDb: 0
      }
    },
    trackVstChain: [],
    vocalBusSettings: {
      volumeDb: 1.5,
      pan: 0.0,
      dsp: {
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 120, gainDb: 0, Q: 0.7071, enabled: false },
          peaking: { type: 'peaking', frequency: 3200, gainDb: 1.2, Q: 1.0, enabled: true },
          highShelf: { type: 'highshelf', frequency: 11000, gainDb: 1.8, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -16,
          ratio: 2.8,
          attackMs: 20,
          releaseMs: 140,
          makeupGainDb: 1.0,
          kneeDb: 6,
          enabled: true,
          currentGainReductionDb: 0
        },
        limiter: { enabled: true, ceilingDb: -0.3, releaseMs: 40 },
        autoDucker: { enabled: true, thresholdDb: -22, duckDepthDb: -12, attackMs: 12, releaseMs: 220 }
      },
      vstChain: []
    },
    masterSettings: {
      volumeDb: 0.0,
      pan: 0.0,
      limiterEnabled: true,
      limiterCeilingDb: -0.5,
      vstChain: []
    }
  },

  // 2. РЕКАСТ (Recast)
  {
    id: 'preset-recast',
    name: 'Рекаст',
    category: 'Рекаст',
    description: 'Технология, представляющая собой улучшенный вариант закадрового озвучивания. Длина переведенных реплик в рекасте соответствует длине реплик в оригинале, озвученные фразы совпадают с оригинальными по началу и концу. Допускаются небольшие отклонения в синхронизации внутри длинных фраз. В рекасте озвучивается физика прилегающая к фразам (вдохи, охи и тп).',
    author: 'VOMIX Core Lab',
    targetLufsDb: -15.0,
    icon: 'Zap',
    color: '#8b5cf6',
    isBuiltIn: true,
    createdAt: '2026-01-01',
    requirements: {
      emotions: 'Умеренная выразительность в характере сцены',
      syncTiming: 'Совпадение по началу и концу фраз (допуск внутри)',
      physics: 'Озвучивается физика прилегающая к фразам (вдохи, охи)',
      effectsMix: 'Динамика + точный дакинг оригинального звука'
    },
    trackDspTemplate: {
      eq: {
        lowShelf: { type: 'lowshelf', frequency: 110, gainDb: -2.0, Q: 0.7071, enabled: true },
        peaking: { type: 'peaking', frequency: 3500, gainDb: 3.5, Q: 1.0, enabled: true },
        highShelf: { type: 'highshelf', frequency: 9000, gainDb: 2.0, Q: 0.7071, enabled: true },
        enabled: true
      },
      compressor: {
        thresholdDb: -15,
        ratio: 5.0,
        attackMs: 8,
        releaseMs: 90,
        makeupGainDb: 2.0,
        kneeDb: 8,
        enabled: true,
        currentGainReductionDb: 0
      },
      noiseGate: {
        thresholdDb: -46,
        attackMs: 1.5,
        holdMs: 50,
        releaseMs: 120,
        floorDb: -60,
        enabled: true
      },
      deEsser: {
        thresholdDb: -20,
        frequency: 6400,
        ratio: 5.5,
        attackMs: 0.6,
        releaseMs: 25,
        enabled: true
      },
      autoDucker: {
        thresholdDb: -20,
        duckDepthDb: -14,
        attackMs: 10,
        releaseMs: 300,
        enabled: true,
        sourceTrackId: 1,
        currentDuckingGainDb: 0
      }
    },
    trackVstChain: [],
    vocalBusSettings: {
      volumeDb: 1.8,
      pan: 0.0,
      dsp: {
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 120, gainDb: -1.0, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 3000, gainDb: 2.0, Q: 1.0, enabled: true },
          highShelf: { type: 'highshelf', frequency: 10000, gainDb: 2.5, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -14,
          ratio: 3.5,
          attackMs: 15,
          releaseMs: 110,
          makeupGainDb: 1.5,
          kneeDb: 6,
          enabled: true,
          currentGainReductionDb: 0
        },
        limiter: { enabled: true, ceilingDb: -0.2, releaseMs: 40 },
        autoDucker: { enabled: true, thresholdDb: -20, duckDepthDb: -14, attackMs: 10, releaseMs: 300 }
      },
      vstChain: []
    },
    masterSettings: {
      volumeDb: 0.5,
      pan: 0.0,
      limiterEnabled: true,
      limiterCeilingDb: -0.3,
      vstChain: []
    }
  },

  // 3. РЕДАБ (Redub / «Под дубляж»)
  {
    id: 'preset-redub',
    name: 'Редаб',
    category: 'Редаб',
    description: 'Озвучивание под дубляж: липсинг по губам (с допущением небольших отклонений), эмоции, озвученные фразы совпадают с оригинальными по началу и концу, озвучивается лёгкая физика.',
    author: 'VOMIX Core Lab',
    targetLufsDb: -17.0,
    icon: 'BookOpen',
    color: '#06b6d4',
    isBuiltIn: true,
    createdAt: '2026-01-01',
    requirements: {
      emotions: 'Полноценные эмоции в характере персонажа',
      syncTiming: 'Липсинг по губам (с допущением небольших отклонений)',
      physics: 'Озвучивается лёгкая физика',
      effectsMix: 'Сведение под дубляж (пространство + динамика)'
    },
    trackDspTemplate: {
      eq: {
        lowShelf: { type: 'lowshelf', frequency: 90, gainDb: -3.0, Q: 0.7071, enabled: true },
        peaking: { type: 'peaking', frequency: 2600, gainDb: 2.2, Q: 1.2, enabled: true },
        highShelf: { type: 'highshelf', frequency: 9500, gainDb: 1.8, Q: 0.7071, enabled: true },
        enabled: true
      },
      compressor: {
        thresholdDb: -18,
        ratio: 3.2,
        attackMs: 20,
        releaseMs: 140,
        makeupGainDb: 1.5,
        kneeDb: 8,
        enabled: true,
        currentGainReductionDb: 0
      },
      noiseGate: {
        thresholdDb: -48,
        attackMs: 2.0,
        holdMs: 45,
        releaseMs: 120,
        floorDb: -65,
        enabled: true
      },
      deEsser: {
        thresholdDb: -23,
        frequency: 6000,
        ratio: 4.5,
        attackMs: 1.0,
        releaseMs: 30,
        enabled: true
      },
      autoDucker: {
        thresholdDb: -24,
        duckDepthDb: -10,
        attackMs: 15,
        releaseMs: 300,
        enabled: true,
        sourceTrackId: 1,
        currentDuckingGainDb: 0
      }
    },
    trackVstChain: [],
    vocalBusSettings: {
      volumeDb: 0.5,
      pan: 0.0,
      dsp: {
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 120, gainDb: -0.5, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 2800, gainDb: 1.2, Q: 1.0, enabled: true },
          highShelf: { type: 'highshelf', frequency: 9500, gainDb: 1.2, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -16,
          ratio: 2.6,
          attackMs: 25,
          releaseMs: 160,
          makeupGainDb: 0.8,
          kneeDb: 8,
          enabled: true,
          currentGainReductionDb: 0
        },
        limiter: { enabled: true, ceilingDb: -0.4, releaseMs: 50 },
        autoDucker: { enabled: true, thresholdDb: -24, duckDepthDb: -10, attackMs: 15, releaseMs: 300 }
      },
      vstChain: []
    },
    masterSettings: {
      volumeDb: 0.0,
      pan: 0.0,
      limiterEnabled: true,
      limiterCeilingDb: -0.5,
      vstChain: []
    }
  },

  // 4. ДУБЛЯЖ (Full Dubbing)
  {
    id: 'preset-dublyazh',
    name: 'Дубляж',
    category: 'Дубляж',
    description: 'Полное сведение эффектов, полное повторение эмоций и озвученного, полный повтор липсинга за губами персонажа.',
    author: 'VOMIX Core Lab',
    targetLufsDb: -18.0,
    icon: 'Film',
    color: '#f59e0b',
    isBuiltIn: true,
    createdAt: '2026-01-01',
    requirements: {
      emotions: 'Полное повторение эмоций и характера персонажа',
      syncTiming: 'Полный повтор липсинга за губами персонажа',
      physics: 'Полное повторение всей физики (дыхание, смех, плач, крики)',
      effectsMix: 'Полное сведение эффектов (акустика кадра, фильтрация, ревер)'
    },
    trackDspTemplate: {
      eq: {
        lowShelf: { type: 'lowshelf', frequency: 100, gainDb: -2.0, Q: 0.7071, enabled: true },
        peaking: { type: 'peaking', frequency: 3200, gainDb: 2.5, Q: 1.1, enabled: true },
        highShelf: { type: 'highshelf', frequency: 10000, gainDb: 1.5, Q: 0.7071, enabled: true },
        enabled: true
      },
      compressor: {
        thresholdDb: -16,
        ratio: 3.5,
        attackMs: 12,
        releaseMs: 140,
        makeupGainDb: 1.5,
        kneeDb: 6,
        enabled: true,
        currentGainReductionDb: 0
      },
      noiseGate: {
        thresholdDb: -48,
        attackMs: 2,
        holdMs: 35,
        releaseMs: 120,
        floorDb: -60,
        enabled: true
      },
      deEsser: {
        thresholdDb: -22,
        frequency: 6200,
        ratio: 4.5,
        attackMs: 1.0,
        releaseMs: 35,
        enabled: true
      },
      autoDucker: {
        thresholdDb: -24,
        duckDepthDb: -10,
        attackMs: 15,
        releaseMs: 250,
        enabled: true,
        sourceTrackId: 1,
        currentDuckingGainDb: 0
      }
    },
    trackVstChain: [],
    vocalBusSettings: {
      volumeDb: 1.0,
      pan: 0.0,
      dsp: {
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 120, gainDb: 0, Q: 0.7071, enabled: false },
          peaking: { type: 'peaking', frequency: 3000, gainDb: 1.2, Q: 1.0, enabled: true },
          highShelf: { type: 'highshelf', frequency: 12000, gainDb: 1.8, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -15,
          ratio: 2.5,
          attackMs: 25,
          releaseMs: 150,
          makeupGainDb: 1.0,
          kneeDb: 8,
          enabled: true,
          currentGainReductionDb: 0
        },
        limiter: { enabled: true, ceilingDb: -0.5, releaseMs: 50 },
        autoDucker: { enabled: true, thresholdDb: -24, duckDepthDb: -9, attackMs: 15, releaseMs: 250 }
      },
      vstChain: []
    },
    masterSettings: {
      volumeDb: 0.0,
      pan: 0.0,
      limiterEnabled: true,
      limiterCeilingDb: -1.0,
      vstChain: []
    }
  }
];

export class MVPPresetManager {
  private static instance: MVPPresetManager | null = null;
  private userPresets: MVPPreset[] = [];
  private activePresetId: string = 'preset-zakadr';
  private listeners: Set<() => void> = new Set();

  private constructor() {
    this.loadUserPresets();
  }

  public static getInstance(): MVPPresetManager {
    if (!MVPPresetManager.instance) {
      MVPPresetManager.instance = new MVPPresetManager();
    }
    return MVPPresetManager.instance;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  private loadUserPresets(): void {
    try {
      const raw = localStorage.getItem(STORAGE_USER_PRESETS_KEY);
      if (raw) {
        this.userPresets = JSON.parse(raw);
      }
    } catch (e) {
      console.error(e);
      this.userPresets = [];
    }
  }

  private saveUserPresets(): void {
    try {
      localStorage.setItem(STORAGE_USER_PRESETS_KEY, JSON.stringify(this.userPresets));
    } catch (e) {
      console.error(e);
    }
  }

  public getCorePresets(): MVPPreset[] {
    return BUILT_IN_MVP_PRESETS;
  }

  public getAllPresets(): MVPPreset[] {
    return [...BUILT_IN_MVP_PRESETS, ...this.userPresets];
  }

  public getActivePresetId(): string {
    return this.activePresetId;
  }

  public setActivePresetId(id: string): void {
    this.activePresetId = id;
    this.notify();
  }

  public getPresetById(id: string): MVPPreset | undefined {
    return this.getAllPresets().find((p) => p.id === id);
  }

  /**
   * Снимок текущего состояния всего пайплайна (дорожки, VST плагины, параметры, Vocal Bus, Master)
   */
  public captureCurrentStateAsPreset(
    name: string,
    category: MVPPresetCategory,
    description: string,
    tracks: TrackState[],
    vocalBus: VocalBusState,
    master: MasterState,
    referenceTrackId?: number
  ): MVPPreset {
    const refTrack = tracks.find((t) => t.id === referenceTrackId) || tracks[0];

    const newPreset: MVPPreset = {
      id: `user_preset_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: name.trim(),
      category,
      description: description.trim() || 'Пользовательский пресет MVP пайплайна',
      author: 'Пользователь',
      targetLufsDb: -18.0,
      icon: category === 'Закадр' ? 'Mic2' : category === 'Рекаст' ? 'Zap' : (category === 'Редаб' || category === 'Ридап') ? 'BookOpen' : 'Film',
      color: category === 'Закадр' ? '#10b981' : category === 'Рекаст' ? '#8b5cf6' : (category === 'Редаб' || category === 'Ридап') ? '#06b6d4' : '#f59e0b',
      isBuiltIn: false,
      createdAt: new Date().toISOString().split('T')[0],
      trackDspTemplate: {
        eq: JSON.parse(JSON.stringify(refTrack.eq)),
        compressor: JSON.parse(JSON.stringify(refTrack.compressor)),
        noiseGate: JSON.parse(JSON.stringify(refTrack.noiseGate)),
        deEsser: JSON.parse(JSON.stringify(refTrack.deEsser)),
        deClicker: refTrack.deClicker ? JSON.parse(JSON.stringify(refTrack.deClicker)) : undefined,
        dePlosive: refTrack.dePlosive ? JSON.parse(JSON.stringify(refTrack.dePlosive)) : undefined,
        autoDucker: JSON.parse(JSON.stringify(refTrack.autoDucker))
      },
      trackVstChain: refTrack.vstPlugins ? JSON.parse(JSON.stringify(refTrack.vstPlugins)) : [],
      vocalBusSettings: {
        volumeDb: vocalBus.volumeDb,
        pan: vocalBus.pan,
        dsp: JSON.parse(JSON.stringify(vocalBus.dsp)),
        vstChain: vocalBus.vstPlugins ? JSON.parse(JSON.stringify(vocalBus.vstPlugins)) : []
      },
      masterSettings: {
        volumeDb: master.volumeDb,
        pan: master.pan,
        limiterEnabled: master.limiterEnabled,
        limiterCeilingDb: master.limiterCeilingDb,
        vstChain: master.vstPlugins ? JSON.parse(JSON.stringify(master.vstPlugins)) : []
      },
      customTrackChains: tracks.map((t, idx) => ({
        trackIndex: idx,
        trackName: t.name,
        vstPlugins: JSON.parse(JSON.stringify(t.vstPlugins || [])),
        dsp: {
          eq: JSON.parse(JSON.stringify(t.eq)),
          compressor: JSON.parse(JSON.stringify(t.compressor)),
          noiseGate: JSON.parse(JSON.stringify(t.noiseGate)),
          deEsser: JSON.parse(JSON.stringify(t.deEsser)),
          deClicker: t.deClicker ? JSON.parse(JSON.stringify(t.deClicker)) : undefined,
          dePlosive: t.dePlosive ? JSON.parse(JSON.stringify(t.dePlosive)) : undefined,
          autoDucker: JSON.parse(JSON.stringify(t.autoDucker))
        }
      }))
    };

    this.userPresets.push(newPreset);
    this.saveUserPresets();
    this.activePresetId = newPreset.id;
    this.notify();
    systemLogger.info('MVPPreset', `Сохранен снимок пайплайна как пресет: "${newPreset.name}" (${newPreset.category})`);
    return newPreset;
  }

  public saveAsUserPreset(preset: Omit<MVPPreset, 'id' | 'isBuiltIn' | 'createdAt'>): MVPPreset {
    const newPreset: MVPPreset = {
      ...preset,
      id: `user_mvp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      isBuiltIn: false,
      createdAt: new Date().toISOString().split('T')[0]
    };
    this.userPresets.push(newPreset);
    this.saveUserPresets();
    this.activePresetId = newPreset.id;
    this.notify();
    systemLogger.info('MVPPreset', `Сохранен пользовательский пресет: "${newPreset.name}"`);
    return newPreset;
  }

  public deleteUserPreset(presetId: string): boolean {
    const idx = this.userPresets.findIndex((p) => p.id === presetId);
    if (idx >= 0) {
      this.userPresets.splice(idx, 1);
      this.saveUserPresets();
      this.notify();
      return true;
    }
    return false;
  }

  /**
   * Экспорт пресета в JSON файл (.vomixpreset)
   */
  public exportPresetToFile(preset: MVPPreset): void {
    const jsonStr = JSON.stringify(preset, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${preset.name.replace(/[^a-zA-Z0-9а-яА-Я_-]/g, '_')}.vomixpreset`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    systemLogger.info('MVPPreset', `Пресет "${preset.name}" экспортирован в файл.`);
  }

  /**
   * Импорт пресета из JSON (.vomixpreset)
   */
  public async importPresetFromFile(file: File): Promise<MVPPreset> {
    const text = await file.text();
    const parsed = JSON.parse(text) as MVPPreset;
    if (!parsed.name || !parsed.trackDspTemplate) {
      throw new Error('Файл не содержит корректную структуру пресета VOMIX MVP.');
    }
    parsed.id = `imported_mvp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    parsed.isBuiltIn = false;
    this.userPresets.push(parsed);
    this.saveUserPresets();
    this.activePresetId = parsed.id;
    this.notify();
    systemLogger.info('MVPPreset', `Пресет "${parsed.name}" успешно импортирован.`);
    return parsed;
  }
}

export const globalMVPPresetManager = MVPPresetManager.getInstance();
