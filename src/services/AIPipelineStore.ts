export type AIPurposeType =
  | 'stem_separation'
  | 'denoise'
  | 'dereverb'
  | 'spectral_match'
  | 'voicefixer'
  | 'whisper_vad'
  | 'vocal_chain';

export interface AIStepNode {
  id: string;
  enabled: boolean;
  purpose: AIPurposeType;
  modelId: string;
  intensity: number; // 0..100
  dereverbAmount: number; // 0..100
  enableLowCut: boolean;
  warmthSat: number; // 0..100
  airBandBoost: number; // 0..6 dB
}

export interface TrackAIConfig {
  trackId: number;
  enabled: boolean;
  outputMode: 'replace' | 'new_track' | 'stems';
  steps: AIStepNode[];
  status: 'idle' | 'processing' | 'done' | 'error';
  progressPercent: number;
  statusMessage?: string;
  lastProcessedPcm?: Float32Array;
  lastProcessedName?: string;
  abOriginalUrl?: string;
  abProcessedUrl?: string;

  // Convenience fields for step 0
  purpose?: AIPurposeType;
  modelId?: string;
  intensity?: number;
  dereverbAmount?: number;
  enableLowCut?: boolean;
  warmthSat?: number;
  airBandBoost?: number;
}

export class AIPipelineStore {
  private static instance: AIPipelineStore;
  private configs: Record<number, TrackAIConfig> = {};
  private listeners: Set<() => void> = new Set();

  private constructor() {}

  public static getInstance(): AIPipelineStore {
    if (!AIPipelineStore.instance) {
      AIPipelineStore.instance = new AIPipelineStore();
    }
    return AIPipelineStore.instance;
  }

  public subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notify() {
    this.listeners.forEach((cb) => {
      try {
        cb();
      } catch (e) {
        console.error('[AIPipelineStore] Listener error:', e);
      }
    });
  }

  public getConfigs(): Record<number, TrackAIConfig> {
    return this.configs;
  }

  /**
   * Чистая сериализация матрицы маршрутизации для сохранения в пресет (без временных блоб-ссылок и Float32Array)
   */
  public getSerializableConfigs(): Record<number, TrackAIConfig> {
    const clean: Record<number, TrackAIConfig> = {};
    for (const [trackIdStr, cfg] of Object.entries(this.configs)) {
      const trackId = Number(trackIdStr);
      if (!cfg) continue;

      clean[trackId] = {
        trackId: cfg.trackId || trackId,
        enabled: cfg.enabled ?? true,
        outputMode: cfg.outputMode || 'replace',
        status: 'idle',
        progressPercent: 0,
        steps: Array.isArray(cfg.steps)
          ? cfg.steps.map((s) => ({
              id: s.id || `step-${Date.now()}-${Math.random()}`,
              enabled: s.enabled ?? true,
              purpose: s.purpose || 'denoise',
              modelId: s.modelId || 'deepfilternet3',
              intensity: s.intensity ?? 75,
              dereverbAmount: s.dereverbAmount ?? 50,
              enableLowCut: s.enableLowCut ?? true,
              warmthSat: s.warmthSat ?? 0,
              airBandBoost: s.airBandBoost ?? 0
            }))
          : [],
        purpose: cfg.purpose,
        modelId: cfg.modelId,
        intensity: cfg.intensity,
        dereverbAmount: cfg.dereverbAmount,
        enableLowCut: cfg.enableLowCut,
        warmthSat: cfg.warmthSat,
        airBandBoost: cfg.airBandBoost
      };
    }
    return clean;
  }

  public setConfigs(configs: Record<number, TrackAIConfig>, silent: boolean = false) {
    this.configs = { ...configs };
    if (!silent) {
      this.notify();
    }
  }

  public updateConfig(trackId: number, patch: Partial<TrackAIConfig>) {
    if (!this.configs[trackId]) {
      this.configs[trackId] = {
        trackId,
        enabled: true,
        outputMode: 'replace',
        steps: [],
        status: 'idle',
        progressPercent: 0,
        ...patch
      } as TrackAIConfig;
    } else {
      this.configs[trackId] = {
        ...this.configs[trackId],
        ...patch
      };
    }
    this.notify();
  }
}

export const globalAIPipelineStore = AIPipelineStore.getInstance();
