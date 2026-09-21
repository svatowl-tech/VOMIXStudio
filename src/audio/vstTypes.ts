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
