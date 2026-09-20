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

  private constructor() {}

  public static getInstance(): AIPipelineStore {
    if (!AIPipelineStore.instance) {
      AIPipelineStore.instance = new AIPipelineStore();
    }
    return AIPipelineStore.instance;
  }

  public getConfigs(): Record<number, TrackAIConfig> {
    return this.configs;
  }

  public setConfigs(configs: Record<number, TrackAIConfig>) {
    this.configs = { ...configs };
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
  }
}

export const globalAIPipelineStore = AIPipelineStore.getInstance();
