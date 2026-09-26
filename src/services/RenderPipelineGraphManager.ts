import { systemLogger } from './SystemLogger';
import { toSafeArray } from '../utils/safeIterables';

export type PipelineNodeType =
  // 1. Входы
  | 'input_video'
  | 'input_tracks'
  | 'input_subtitles'
  // 2. Подготовка и тайминг
  | 'strip_silence'
  | 'auto_timing'
  | 'loudness_norm'
  | 'phase_aligner'
  // 3. Нейросети (AI)
  | 'neural_matrix'
  | 'spectral_denoise_ai'
  | 'stem_sep_uvr'
  | 'voicefixer_harmonics'
  | 'de_reverb_dsp'
  // 4. C++ DSP & Эффекты
  | 'track_dsp'
  | 'auto_ducking'
  | 'track_vst'
  | 'vocal_bus'
  | 'loudness_align'
  | 'transient_shaper'
  | 'master_limiter'
  // 5. Маршрутизация, отшивание, сплиттеры, микшеры
  | 'node_branch_split'
  | 'node_mixer_merge'
  | 'track_isolator_mute'
  | 'sidechain_ducker_router'
  | 'lufs_target_gate'
  // 6. Нодовые петли и кэш
  | 'feedback_loop'
  | 'step_cache'
  // 7. Сохранение на диск / Экспорт
  | 'disk_save_wav'
  | 'disk_save_mp3'
  | 'stems_splitter_disk'
  | 'master_render'
  | 'stem_export'
  | 'ffmpeg_mux'
  | 'ffmpeg_dual_mux'
  | 'ffmpeg_single_mux'
  | 'subtitles_burner'
  | 'output_video';

export type NodeCategory = 'input' | 'prep' | 'ai' | 'dsp' | 'routing' | 'loop' | 'disk' | 'output';

export interface NodePort {
  id: string;
  label: string;
  type: 'audio' | 'video' | 'sidechain' | 'sync' | 'loop';
  color?: string;
}

export interface PipelineNode {
  id: string;
  type: PipelineNodeType;
  title: string;
  description: string;
  category: NodeCategory;
  enabled: boolean;
  x: number;
  y: number;
  inputs: NodePort[];
  outputs: NodePort[];
  parameters: Record<string, any>;
  iconName?: string;
  color?: string;
}

export interface PipelineConnection {
  id: string;
  fromNodeId: string;
  fromPortId: string;
  toNodeId: string;
  toPortId: string;
  isLoop?: boolean;
}

export type VideoExportQualityPreset =
  | 'lossless_original' // Без потери качества (Как в оригинале / Direct Stream Copy)
  | 'uhd_4k_hq'         // Ultra HD 4K (2160p, 28 Mbps, 2-Pass VBR)
  | 'fhd_1080p_hq'      // Full HD 1080p HQ (1080p, 12 Mbps, 2-Pass / CRF 18)
  | 'fhd_1080p_fast'    // Full HD 1080p Fast (1080p, 6 Mbps, 1-Pass)
  | 'hd_720p_light'     // HD 720p Легкий (720p, 2.5 Mbps, 1-Pass CRF 22)
  | 'custom';           // Пользовательская настройка

export interface VideoExportParameters {
  preset: VideoExportQualityPreset;
  // Видеокодек и параметры сжатия
  videoCodec: 'copy' | 'libx264' | 'libx265' | 'libvpx-vp9';
  resolution: 'original' | '3840x2160' | '2560x1440' | '1920x1080' | '1280x720' | '854x480' | 'custom';
  customResolutionWidth?: number;
  customResolutionHeight?: number;
  encodingPasses: 1 | 2; // Однопроходный (1-Pass) vs Двухпроходный (2-Pass)
  rateControl: 'copy' | 'crf' | 'vbr' | 'cbr';
  videoBitrateKbps: number; // Например, 12000 для 12 Mbps
  maxBitrateKbps?: number;
  crf: number; // 0..51 (18 = visually lossless, 23 = default)
  fps: 'original' | '60' | '59.94' | '30' | '29.97' | '25' | '24' | '23.976';
  encoderSpeedPreset: 'ultrafast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower';
  encoderProfile: 'high' | 'main' | 'baseline' | 'auto';
  // Аудиопотоки
  audioCodec: 'aac' | 'ac3' | 'opus' | 'copy';
  audioBitrate: '320k' | '256k' | '192k' | '128k' | 'lossless';
  audioSampleRate: 48000 | 44100;
  audioTrackMode: 'dual_tracks' | 'single_master' | 'voiceover_background';
  track1Title: string;
  track2Title: string;
  // Контейнер и метаданные
  container: 'mp4' | 'mkv' | 'mov' | 'webm';
  fastStart: boolean;
  autoDownload: boolean;
  fileNamePattern: string;
}

export const DEFAULT_VIDEO_EXPORT_PARAMS: VideoExportParameters = {
  preset: 'lossless_original',
  videoCodec: 'copy',
  resolution: 'original',
  encodingPasses: 1,
  rateControl: 'copy',
  videoBitrateKbps: 12000,
  maxBitrateKbps: 18000,
  crf: 18,
  fps: 'original',
  encoderSpeedPreset: 'medium',
  encoderProfile: 'high',
  audioCodec: 'aac',
  audioBitrate: '320k',
  audioSampleRate: 48000,
  audioTrackMode: 'dual_tracks',
  track1Title: 'Дубляж / Dubbed Mix',
  track2Title: 'Оригинал / Original Audio',
  container: 'mp4',
  fastStart: true,
  autoDownload: true,
  fileNamePattern: 'final_dubbed_video.mp4'
};

export function getExportParamsForPreset(
  preset: VideoExportQualityPreset,
  baseParams?: Partial<VideoExportParameters>
): VideoExportParameters {
  const current = { ...DEFAULT_VIDEO_EXPORT_PARAMS, ...(baseParams || {}) };
  switch (preset) {
    case 'lossless_original':
      return {
        ...current,
        preset: 'lossless_original',
        videoCodec: 'copy',
        resolution: 'original',
        rateControl: 'copy',
        encodingPasses: 1,
        fps: 'original',
        audioBitrate: '320k',
        container: 'mp4'
      };
    case 'uhd_4k_hq':
      return {
        ...current,
        preset: 'uhd_4k_hq',
        videoCodec: 'libx264',
        resolution: '3840x2160',
        rateControl: 'vbr',
        videoBitrateKbps: 28000,
        maxBitrateKbps: 35000,
        encodingPasses: 2,
        crf: 16,
        fps: 'original',
        encoderSpeedPreset: 'slow',
        audioBitrate: '320k',
        container: 'mp4'
      };
    case 'fhd_1080p_hq':
      return {
        ...current,
        preset: 'fhd_1080p_hq',
        videoCodec: 'libx264',
        resolution: '1920x1080',
        rateControl: 'vbr',
        videoBitrateKbps: 12000,
        maxBitrateKbps: 16000,
        encodingPasses: 2,
        crf: 18,
        fps: 'original',
        encoderSpeedPreset: 'medium',
        audioBitrate: '320k',
        container: 'mp4'
      };
    case 'fhd_1080p_fast':
      return {
        ...current,
        preset: 'fhd_1080p_fast',
        videoCodec: 'libx264',
        resolution: '1920x1080',
        rateControl: 'crf',
        videoBitrateKbps: 6000,
        maxBitrateKbps: 8000,
        encodingPasses: 1,
        crf: 21,
        fps: 'original',
        encoderSpeedPreset: 'veryfast',
        audioBitrate: '256k',
        container: 'mp4'
      };
    case 'hd_720p_light':
      return {
        ...current,
        preset: 'hd_720p_light',
        videoCodec: 'libx264',
        resolution: '1280x720',
        rateControl: 'crf',
        videoBitrateKbps: 2500,
        maxBitrateKbps: 3500,
        encodingPasses: 1,
        crf: 23,
        fps: 'original',
        encoderSpeedPreset: 'faster',
        audioBitrate: '192k',
        container: 'mp4'
      };
    case 'custom':
    default:
      return {
        ...current,
        preset: 'custom'
      };
  }
}

export interface RenderPipelineGraph {
  version: number;
  name: string;
  category: string;
  executionMode: 'sequential' | 'parallel_stems' | 'iterative_loop';
  nodes: PipelineNode[];
  connections: PipelineConnection[];
}

export const NODE_DEFINITIONS: Record<
  PipelineNodeType,
  {
    title: string;
    description: string;
    category: NodeCategory;
    iconName: string;
    color: string;
    defaultInputs: NodePort[];
    defaultOutputs: NodePort[];
    defaultParams: Record<string, any>;
  }
> = {
  // 1. Входы
  input_video: {
    title: 'Вход: Видео + Оригинал',
    description: 'Чтение видеопотока и оригинальной звуковой дорожки',
    category: 'input',
    iconName: 'Film',
    color: '#06b6d4',
    defaultInputs: [],
    defaultOutputs: [
      { id: 'video_out', label: 'Видеопоток', type: 'video', color: '#06b6d4' },
      { id: 'audio_orig_out', label: 'Оригинал Аудио', type: 'audio', color: '#10b981' }
    ],
    defaultParams: { extractAudio: true, keepOriginalTrackInMux: true }
  },
  input_tracks: {
    title: 'Вход: Дорожки дабберов',
    description: 'Загрузка вокальных дорожек и клипов проекта',
    category: 'input',
    iconName: 'Mic',
    color: '#10b981',
    defaultInputs: [],
    defaultOutputs: [
      { id: 'tracks_main_out', label: 'Все Дорожки', type: 'audio', color: '#10b981' },
      { id: 'tracks_aux_out', label: 'Aux / Submix', type: 'audio', color: '#8b5cf6' }
    ],
    defaultParams: { trackCount: 'auto', sampleRate: 48000 }
  },
  input_subtitles: {
    title: 'Вход: Субтитры & Таймкоды',
    description: 'Сценарные реплики, паузы и таймкоды для синхронизации',
    category: 'input',
    iconName: 'FileText',
    color: '#8b5cf6',
    defaultInputs: [],
    defaultOutputs: [
      { id: 'sub_timing_out', label: 'Таймкоды', type: 'sync', color: '#8b5cf6' },
      { id: 'sub_text_out', label: 'Текст реплик', type: 'sync', color: '#ec4899' }
    ],
    defaultParams: { parseSubtitles: true }
  },

  // 2. Подготовка и тайминг
  strip_silence: {
    title: 'C++ Strip Silence & Clean',
    description: 'Удаление тишины, отсечение шума и дыханий в паузах',
    category: 'prep',
    iconName: 'Scissors',
    color: '#ec4899',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио Вход', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_cleaned', label: 'Очищенный Звук', type: 'audio', color: '#ec4899' },
      { id: 'out_silence_map', label: 'Карта Пауз', type: 'sync', color: '#8b5cf6' }
    ],
    defaultParams: { thresholdDb: -42, minSilenceMs: 250, paddingMs: 50 }
  },
  auto_timing: {
    title: 'AI / WSOLA Time-Stretch',
    description: 'Авто-подгонка длительности фраз и тайминга под видео',
    category: 'prep',
    iconName: 'Clock',
    color: '#f59e0b',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио Вход', type: 'audio', color: '#10b981' },
      { id: 'in_sync_ref', label: 'Референс Таймкодов', type: 'sync', color: '#8b5cf6' }
    ],
    defaultOutputs: [
      { id: 'out_stretched', label: 'Синхронизированный Звук', type: 'audio', color: '#f59e0b' }
    ],
    defaultParams: { algorithm: 'WSOLA', maxStretchFactor: 1.25, alignToOriginal: true }
  },
  loudness_norm: {
    title: 'EBU R128 Нормализация',
    description: 'Выравнивание исходной громкости дорожек перед обработкой',
    category: 'prep',
    iconName: 'Gauge',
    color: '#3b82f6',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио Вход', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_normalized', label: 'Нормализованный (-18 dBFS)', type: 'audio', color: '#3b82f6' }
    ],
    defaultParams: { targetRmsDb: -18.0, truePeakMaxDb: -1.0 }
  },
  phase_aligner: {
    title: 'C++ Phase & Mono Check',
    description: 'Фазовое выравнивание стерео и моно-совместимость',
    category: 'prep',
    iconName: 'Activity',
    color: '#06b6d4',
    defaultInputs: [
      { id: 'in_left_right', label: 'Стерео Вход', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_aligned', label: 'Сфазированный Микс', type: 'audio', color: '#06b6d4' },
      { id: 'out_mono_check', label: 'Моно Контроль', type: 'audio', color: '#94a3b8' }
    ],
    defaultParams: { autoPhaseInvert: true, monoCheck: true }
  },

  // 3. Нейросети (AI)
  neural_matrix: {
    title: 'Матрица нейросетей (AI)',
    description: 'Каскадный запуск моделей очистки, реставрации и сепарации',
    category: 'ai',
    iconName: 'Sparkles',
    color: '#a855f7',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио Вход', type: 'audio', color: '#10b981' },
      { id: 'in_ref_spectral', label: 'Референс Тембра', type: 'sidechain', color: '#f59e0b' }
    ],
    defaultOutputs: [
      { id: 'out_ai_processed', label: 'AI Обработанный', type: 'audio', color: '#a855f7' },
      { id: 'out_isolated_vocals', label: 'Изолированный Голос', type: 'audio', color: '#10b981' },
      { id: 'out_isolated_me', label: 'Изолированный M&E', type: 'audio', color: '#06b6d4' }
    ],
    defaultParams: { runStemSeparation: false, runDenoise: true, runSpectralMatch: true }
  },
  spectral_denoise_ai: {
    title: 'DeepFilterNet3 Нейро-Денойзер',
    description: 'SOTA глубокое подавление шума нейросетью без артефактов',
    category: 'ai',
    iconName: 'Sparkles',
    color: '#a855f7',
    defaultInputs: [
      { id: 'in_noisy', label: 'Зашумленный Звук', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_denoised', label: 'Чистый Голос', type: 'audio', color: '#a855f7' },
      { id: 'out_noise_residue', label: 'Остаточный Шум', type: 'audio', color: '#64748b' }
    ],
    defaultParams: { intensityPercent: 80, lowCutHz: 80 }
  },
  stem_sep_uvr: {
    title: 'UVR / Demucs Сепаратор Стемов',
    description: 'Разделение на вокал, музыку, эффекты и фон',
    category: 'ai',
    iconName: 'Layers',
    color: '#8b5cf6',
    defaultInputs: [
      { id: 'in_mix', label: 'Полный Микс Вход', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_vocals', label: 'Vocals Стем', type: 'audio', color: '#10b981' },
      { id: 'out_instruments', label: 'Music & BG Стем', type: 'audio', color: '#06b6d4' },
      { id: 'out_sfx', label: 'SFX Стем', type: 'audio', color: '#f59e0b' }
    ],
    defaultParams: { model: 'uvr_mdx_voc_ft', outputFormat: 'stereo' }
  },
  voicefixer_harmonics: {
    title: 'VoiceFixer Нейро-Гармонайзер',
    description: 'Восстановление утерянных высоких частот (Air-Band) и деклиппинг',
    category: 'ai',
    iconName: 'Zap',
    color: '#ec4899',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио Вход', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_restored', label: 'Восстановленный Голос', type: 'audio', color: '#ec4899' }
    ],
    defaultParams: { airBandBoostDb: 2.0, warmthSat: 20, declip: true }
  },
  de_reverb_dsp: {
    title: 'FoxJoy De-Reverb & Echo Killer',
    description: 'Устранение комнатного эха и реверберации помещения',
    category: 'ai',
    iconName: 'Activity',
    color: '#3b82f6',
    defaultInputs: [
      { id: 'in_echo', label: 'Аудио с Эхом', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_dry', label: 'Сухой Сигнал', type: 'audio', color: '#3b82f6' }
    ],
    defaultParams: { reductionPercent: 60 }
  },

  // 4. C++ DSP & Эффекты
  track_dsp: {
    title: 'C++ DSP Рек дорожек',
    description: 'EQ, компрессор, Noise Gate, De-Esser, De-Clicker, De-Plosive',
    category: 'dsp',
    iconName: 'Sliders',
    color: '#10b981',
    defaultInputs: [
      { id: 'in_raw', label: 'Аудио Вход', type: 'audio', color: '#10b981' },
      { id: 'in_sidechain', label: 'Sidechain Trigger', type: 'sidechain', color: '#f59e0b' }
    ],
    defaultOutputs: [
      { id: 'out_dsp', label: 'Обработанный Рек', type: 'audio', color: '#10b981' },
      { id: 'out_direct_dry', label: 'Dry Direct Pass', type: 'audio', color: '#64748b' }
    ],
    defaultParams: { eq: true, compressor: true, deEsser: true, noiseGate: true }
  },
  auto_ducking: {
    title: 'Авто-дакинг фона видео',
    description: 'Приглушение оригинального звука видео при появлении голоса',
    category: 'dsp',
    iconName: 'Volume2',
    color: '#14b8a6',
    defaultInputs: [
      { id: 'in_bg_video', label: 'Фон / Оригинал Видео', type: 'audio', color: '#06b6d4' },
      { id: 'in_voice_trigger', label: 'Голос-Триггер (Key In)', type: 'sidechain', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_ducked_bg', label: 'Приглушенный Фон', type: 'audio', color: '#14b8a6' },
      { id: 'out_voice_pass', label: 'Голос Thru', type: 'audio', color: '#10b981' }
    ],
    defaultParams: { duckingDepthDb: -14.0, attackMs: 20, releaseMs: 300, holdMs: 80 }
  },
  track_vst: {
    title: 'VST-плагины на дорожках',
    description: 'Каскадная обработка VST хостом с точным Wet/Dry миксом',
    category: 'dsp',
    iconName: 'Layers',
    color: '#6366f1',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио Вход', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_vst_wet', label: 'VST Wet Out', type: 'audio', color: '#6366f1' },
      { id: 'out_vst_dry', label: 'Dry Pass', type: 'audio', color: '#64748b' }
    ],
    defaultParams: { bypassAll: false, renderWetDry: 100 }
  },
  vocal_bus: {
    title: 'Master Voiceover Bus',
    description: 'Суммирование голосов, шинный компрессор, сатурация и VST',
    category: 'dsp',
    iconName: 'Volume2',
    color: '#8b5cf6',
    defaultInputs: [
      { id: 'in_voices_sum', label: 'Сумма Голосов', type: 'audio', color: '#10b981' },
      { id: 'in_sidechain_key', label: 'Шинный Sidechain', type: 'sidechain', color: '#f59e0b' }
    ],
    defaultOutputs: [
      { id: 'out_bus_mix', label: 'Мастер-Голос Шина', type: 'audio', color: '#8b5cf6' }
    ],
    defaultParams: { busGainDb: 0.0, busDspEnabled: true }
  },
  loudness_align: {
    title: 'Loudness Auto-Aligner',
    description: 'Дельта-калибровка читаемости (+3.5..+4.5 dB над фоном)',
    category: 'dsp',
    iconName: 'Activity',
    color: '#f97316',
    defaultInputs: [
      { id: 'in_voices', label: 'Мастер Голос', type: 'audio', color: '#8b5cf6' },
      { id: 'in_original_bg', label: 'Фон Оригинала', type: 'audio', color: '#06b6d4' }
    ],
    defaultOutputs: [
      { id: 'out_balanced_mix', label: 'Сбалансированный Микс', type: 'audio', color: '#f97316' },
      { id: 'out_delta_metric', label: 'Дельта Метрика', type: 'sync', color: '#f59e0b' }
    ],
    defaultParams: { targetDeltaDb: 4.0, toleranceDb: 0.5 }
  },
  transient_shaper: {
    title: 'Транзиент-Шейпер согласных',
    description: 'Усиление атаки согласных букв и читаемости дикции',
    category: 'dsp',
    iconName: 'Zap',
    color: '#eab308',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио Вход', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_shaped', label: 'Сформированный Сигнал', type: 'audio', color: '#eab308' }
    ],
    defaultParams: { attackGainDb: 3.0, sustainGainDb: -1.0 }
  },
  master_limiter: {
    title: 'True-Peak Лимитер',
    description: 'Финальный пиковый лимитер и защита от клиппинга (-0.5 dBFS)',
    category: 'dsp',
    iconName: 'ShieldCheck',
    color: '#06b6d4',
    defaultInputs: [
      { id: 'in_audio', label: 'Мастер Вход', type: 'audio', color: '#f97316' }
    ],
    defaultOutputs: [
      { id: 'out_limited', label: 'Лимитированный Мастер', type: 'audio', color: '#06b6d4' }
    ],
    defaultParams: { ceilingDb: -0.5, releaseMs: 100, lookaheadMs: 5 }
  },

  // 5. Маршрутизация, отшивание, сплиттеры, микшеры
  node_branch_split: {
    title: 'Сплиттер / Разветвитель',
    description: 'Разветвление 1 входа на 2 или 3 параллельные ветки обработки',
    category: 'routing',
    iconName: 'GitFork',
    color: '#38bdf8',
    defaultInputs: [
      { id: 'in_main', label: 'Основной Вход', type: 'audio', color: '#38bdf8' }
    ],
    defaultOutputs: [
      { id: 'out_branch_a', label: 'Ветка A (Direct)', type: 'audio', color: '#10b981' },
      { id: 'out_branch_b', label: 'Ветка B (FX/AI)', type: 'audio', color: '#a855f7' },
      { id: 'out_branch_c', label: 'Ветка C (Sidechain)', type: 'sidechain', color: '#f59e0b' }
    ],
    defaultParams: { branchesCount: 3 }
  },
  node_mixer_merge: {
    title: 'Сумматор / Подгрупповой Микшер',
    description: 'Сведение 2-3 веток обработки в единый стерео-поток с балансом',
    category: 'routing',
    iconName: 'Layers',
    color: '#10b981',
    defaultInputs: [
      { id: 'in_sub_a', label: 'Вход A', type: 'audio', color: '#10b981' },
      { id: 'in_sub_b', label: 'Вход B', type: 'audio', color: '#a855f7' },
      { id: 'in_sub_c', label: 'Вход C (Фон)', type: 'audio', color: '#06b6d4' }
    ],
    defaultOutputs: [
      { id: 'out_merged_mix', label: 'Сведенный Микс', type: 'audio', color: '#10b981' }
    ],
    defaultParams: { gainA: 0.0, gainB: 0.0, gainC: 0.0 }
  },
  track_isolator_mute: {
    title: 'Отшивание / Изолятор веток',
    description: 'Отсечение или изоляция дорожки (Mute/Isolator/Bypass) из цепи',
    category: 'routing',
    iconName: 'Scissors',
    color: '#f43f5e',
    defaultInputs: [
      { id: 'in_signal', label: 'Сигнал Вход', type: 'audio', color: '#10b981' },
      { id: 'in_mute_control', label: 'Mute Триггер', type: 'sidechain', color: '#f43f5e' }
    ],
    defaultOutputs: [
      { id: 'out_passed', label: 'Пропущенный Сигнал', type: 'audio', color: '#10b981' },
      { id: 'out_muted_bin', label: 'Отсеченный Сигнал', type: 'audio', color: '#64748b' }
    ],
    defaultParams: { mode: 'mute_when_active', invert: false }
  },
  sidechain_ducker_router: {
    title: 'Сайдчейн-Маршрутизатор',
    description: 'Направление управляющего сигнала на целевые компрессоры',
    category: 'routing',
    iconName: 'Activity',
    color: '#eab308',
    defaultInputs: [
      { id: 'in_carrier', label: 'Основной Поток (Carrier)', type: 'audio', color: '#10b981' },
      { id: 'in_modulator', label: 'Модулятор (Trigger)', type: 'sidechain', color: '#eab308' }
    ],
    defaultOutputs: [
      { id: 'out_routed_carrier', label: 'Управляемый Выход', type: 'audio', color: '#10b981' },
      { id: 'out_sidechain_bus', label: 'Sidechain Bus', type: 'sidechain', color: '#eab308' }
    ],
    defaultParams: { routingTarget: 'vocal_bus' }
  },
  lufs_target_gate: {
    title: 'EBU R128 Шлюз контроля',
    description: 'Пропуск сигнала только при соблюдении стандарта (-18 LUFS)',
    category: 'routing',
    iconName: 'Gauge',
    color: '#22c55e',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио Вход', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_passed_compliant', label: 'Соответствует EBU R128', type: 'audio', color: '#22c55e' },
      { id: 'out_retry_loop', label: 'Отклонено -> В петлю', type: 'loop', color: '#ef4444' }
    ],
    defaultParams: { targetLufs: -18.0, toleranceLufs: 1.0 }
  },

  // 6. Нодовые петли и кэш
  feedback_loop: {
    title: 'Нодовая петля / Re-Pass Loop',
    description: 'Итеративный повторный прогон через фильтрацию до цели LUFS',
    category: 'loop',
    iconName: 'RotateCcw',
    color: '#ef4444',
    defaultInputs: [
      { id: 'in_main_pass', label: 'Вход Прогона', type: 'audio', color: '#10b981' },
      { id: 'in_loopback', label: 'Loopback Возврат', type: 'loop', color: '#ef4444' }
    ],
    defaultOutputs: [
      { id: 'out_loop_repeat', label: 'В петлю (Pass 1..N)', type: 'loop', color: '#ef4444' },
      { id: 'out_loop_done', label: 'Готово (Выход из петли)', type: 'audio', color: '#10b981' }
    ],
    defaultParams: { iterations: 2, condition: 'target_lufs_reached', maxLoops: 3 }
  },
  step_cache: {
    title: 'Кэш / Сохранение этапа',
    description: 'Промежуточное сохранение состояния в буфер / память',
    category: 'loop',
    iconName: 'Save',
    color: '#eab308',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио Вход', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_thru', label: 'Thru Сигнал', type: 'audio', color: '#eab308' },
      { id: 'out_cached_snap', label: 'Snapshot Кэш', type: 'sync', color: '#64748b' }
    ],
    defaultParams: { autoSaveWav: false, memoryCache: true }
  },

  // 7. Сохранение на диск / Экспорт
  disk_save_wav: {
    title: '💾 Сохранить результат в WAV',
    description: 'Автоматический сброс текущего аудио на жесткий диск (WAV 24-bit)',
    category: 'disk',
    iconName: 'Save',
    color: '#10b981',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио для записи', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_thru_pass', label: 'Thru Pass Дальше', type: 'audio', color: '#10b981' },
      { id: 'out_disk_saved', label: 'WAV на диске', type: 'sync', color: '#22c55e' }
    ],
    defaultParams: { fileNamePattern: '{category}_{timestamp}_step_mix.wav', bitDepth: 24, autoDownload: true }
  },
  disk_save_mp3: {
    title: '💾 Экспорт MP3 / AAC превью',
    description: 'Сохранение легкого MP3 файла на диск для быстрой отправки',
    category: 'disk',
    iconName: 'FileAudio',
    color: '#f59e0b',
    defaultInputs: [
      { id: 'in_audio', label: 'Аудио Вход', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_thru_pass', label: 'Thru Pass', type: 'audio', color: '#10b981' },
      { id: 'out_mp3_file', label: 'MP3 Файл', type: 'sync', color: '#f59e0b' }
    ],
    defaultParams: { bitrate: '320k', format: 'mp3' }
  },
  stems_splitter_disk: {
    title: '💾 Сброс стем-дорожек на диск',
    description: 'Экспорт мультитрек стемов (Vocals, Music, SFX) в папку/архив',
    category: 'disk',
    iconName: 'Layers',
    color: '#0284c7',
    defaultInputs: [
      { id: 'in_vocals', label: 'Голос Стем', type: 'audio', color: '#10b981' },
      { id: 'in_music', label: 'Музыка Стем', type: 'audio', color: '#06b6d4' },
      { id: 'in_sfx', label: 'SFX Стем', type: 'audio', color: '#f59e0b' }
    ],
    defaultOutputs: [
      { id: 'out_stems_thru', label: 'Сведенный Thru', type: 'audio', color: '#0284c7' },
      { id: 'out_disk_stems', label: 'Пакет Стемов', type: 'sync', color: '#22c55e' }
    ],
    defaultParams: { saveAsZip: true, bitDepth: 24 }
  },
  master_render: {
    title: 'C++ Офлайн Рендерер',
    description: 'Высокоскоростной рендеринг 24-bit 48kHz WAV мастер-файла',
    category: 'output',
    iconName: 'FileAudio',
    color: '#22c55e',
    defaultInputs: [
      { id: 'in_master_audio', label: 'Мастер Аудио', type: 'audio', color: '#06b6d4' }
    ],
    defaultOutputs: [
      { id: 'out_wav_blob', label: 'Master WAV 24-bit', type: 'audio', color: '#22c55e' }
    ],
    defaultParams: { sampleRate: 48000, bitDepth: 24 }
  },
  stem_export: {
    title: 'Экспорт мультитрека стемов',
    description: 'Раздельные WAV файлы: Dialogues, M&E, SFX, Original',
    category: 'output',
    iconName: 'Layers',
    color: '#0284c7',
    defaultInputs: [
      { id: 'in_tracks', label: 'Все Дорожки', type: 'audio', color: '#10b981' }
    ],
    defaultOutputs: [
      { id: 'out_stems_pack', label: 'Стем-файлы', type: 'audio', color: '#0284c7' }
    ],
    defaultParams: { exportDialogues: true, exportME: true, exportOriginal: true }
  },
  ffmpeg_mux: {
    title: 'FFmpeg WASM Видео-Муксер',
    description: 'Вшивание аудиопотока AAC 320k в MP4 без пересжатия видео',
    category: 'output',
    iconName: 'Film',
    color: '#8b5cf6',
    defaultInputs: [
      { id: 'in_video_stream', label: 'Видеопоток', type: 'video', color: '#06b6d4' },
      { id: 'in_master_audio', label: 'Сведенное Аудио', type: 'audio', color: '#22c55e' },
      { id: 'in_subtitles', label: 'Субтитры (Опц.)', type: 'sync', color: '#8b5cf6' }
    ],
    defaultOutputs: [
      { id: 'out_mp4_file', label: 'Готовое Видео MP4', type: 'video', color: '#8b5cf6' }
    ],
    defaultParams: { audioBitrate: '320k', muxMode: 'dual_audio', container: 'mp4' }
  },
  ffmpeg_dual_mux: {
    title: 'FFmpeg Двухдорожечный Мукс',
    description: 'Вшивание 2 независимых дорожек: Дорожка 1 (Дубляж), Дорожка 2 (Оригинал)',
    category: 'output',
    iconName: 'Film',
    color: '#a855f7',
    defaultInputs: [
      { id: 'in_video_stream', label: 'Видеопоток', type: 'video', color: '#06b6d4' },
      { id: 'in_dubbed_audio', label: 'Дорожка 1: Дубляж', type: 'audio', color: '#22c55e' },
      { id: 'in_original_audio', label: 'Дорожка 2: Оригинал', type: 'audio', color: '#06b6d4' }
    ],
    defaultOutputs: [
      { id: 'out_dual_mp4', label: 'MP4 с 2 дорожками', type: 'video', color: '#a855f7' }
    ],
    defaultParams: { track1Title: 'Дубляж / Dubbed Mix', track2Title: 'Оригинал / Original Audio' }
  },
  ffmpeg_single_mux: {
    title: 'FFmpeg Однодорожечный Мукс',
    description: 'Полная замена аудиодорожки в видео на один сведенный мастер-трек',
    category: 'output',
    iconName: 'Film',
    color: '#06b6d4',
    defaultInputs: [
      { id: 'in_video_stream', label: 'Видеопоток', type: 'video', color: '#06b6d4' },
      { id: 'in_master_audio', label: 'Мастер Аудио', type: 'audio', color: '#22c55e' }
    ],
    defaultOutputs: [
      { id: 'out_single_mp4', label: 'MP4 Однодорожечный', type: 'video', color: '#06b6d4' }
    ],
    defaultParams: { audioBitrate: '320k' }
  },
  subtitles_burner: {
    title: 'Вшивание Hardcode Субтитров',
    description: 'Наложение стилизованных субтитров прямо на видеоряд (Burn-in)',
    category: 'output',
    iconName: 'FileText',
    color: '#ec4899',
    defaultInputs: [
      { id: 'in_video', label: 'Видеопоток', type: 'video', color: '#06b6d4' },
      { id: 'in_subtitles', label: 'Субтитры SRT/ASS', type: 'sync', color: '#ec4899' }
    ],
    defaultOutputs: [
      { id: 'out_subbed_video', label: 'Видео с Субтитрами', type: 'video', color: '#ec4899' }
    ],
    defaultParams: { fontSize: 24, fontColor: '#ffffff', outlineColor: '#000000' }
  },
  output_video: {
    title: 'Готовое Видео (MP4 / MKV)',
    description: 'Финальный медиа-файл со сведенным дубляжом, настройками качества и метаданными',
    category: 'output',
    iconName: 'CheckCircle2',
    color: '#10b981',
    defaultInputs: [
      { id: 'in_final_video', label: 'Финальный Видеопоток', type: 'video', color: '#8b5cf6' }
    ],
    defaultOutputs: [
      { id: 'out_completed', label: 'Скачать / Сохранить', type: 'video', color: '#10b981' }
    ],
    defaultParams: { ...DEFAULT_VIDEO_EXPORT_PARAMS }
  }
};

/**
 * Создание ноды с гарантированными портами
 */
export function createPipelineNode(
  type: PipelineNodeType,
  id?: string,
  x: number = 100,
  y: number = 100,
  customParams?: Record<string, any>
): PipelineNode {
  const def = NODE_DEFINITIONS[type] || NODE_DEFINITIONS.input_video;
  return {
    id: id || `node-${type}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 5)}`,
    type,
    title: def.title,
    description: def.description,
    category: def.category,
    enabled: true,
    x,
    y,
    inputs: JSON.parse(JSON.stringify(def.defaultInputs || [])),
    outputs: JSON.parse(JSON.stringify(def.defaultOutputs || [])),
    parameters: { ...def.defaultParams, ...(customParams || {}) },
    iconName: def.iconName,
    color: def.color
  };
}

/**
 * Стандартный граф по умолчанию для категории «Закадр» с мульти-портами и нодой сохранения на диск
 */
export const DEFAULT_ZAKADR_GRAPH: RenderPipelineGraph = {
  version: 2,
  name: 'Закадровый стандартный граф',
  category: 'Закадр',
  executionMode: 'iterative_loop',
  nodes: [
    createPipelineNode('input_video', 'node-v-in', 50, 80),
    createPipelineNode('input_tracks', 'node-t-in', 50, 260),
    createPipelineNode('loudness_norm', 'node-norm', 320, 260),
    createPipelineNode('neural_matrix', 'node-ai', 580, 260),
    createPipelineNode('track_dsp', 'node-dsp', 840, 260),
    createPipelineNode('auto_ducking', 'node-duck', 580, 80),
    createPipelineNode('vocal_bus', 'node-bus', 1100, 260),
    createPipelineNode('loudness_align', 'node-align', 1360, 180),
    createPipelineNode('feedback_loop', 'node-loop', 1360, 370),
    createPipelineNode('disk_save_wav', 'node-disk-wav', 1620, 180, { fileNamePattern: 'zakadr_premaster.wav' }),
    createPipelineNode('master_limiter', 'node-limiter', 1880, 180),
    createPipelineNode('master_render', 'node-render', 2140, 180),
    createPipelineNode('ffmpeg_dual_mux', 'node-mux', 2400, 120),
    createPipelineNode('output_video', 'node-out', 2660, 120)
  ],
  connections: [
    { id: 'c-1', fromNodeId: 'node-t-in', fromPortId: 'tracks_main_out', toNodeId: 'node-norm', toPortId: 'in_audio' },
    { id: 'c-2', fromNodeId: 'node-norm', fromPortId: 'out_normalized', toNodeId: 'node-ai', toPortId: 'in_audio' },
    { id: 'c-3', fromNodeId: 'node-ai', fromPortId: 'out_ai_processed', toNodeId: 'node-dsp', toPortId: 'in_raw' },
    { id: 'c-4', fromNodeId: 'node-dsp', fromPortId: 'out_dsp', toNodeId: 'node-bus', toPortId: 'in_voices_sum' },
    { id: 'c-5', fromNodeId: 'node-v-in', fromPortId: 'audio_orig_out', toNodeId: 'node-duck', toPortId: 'in_bg_video' },
    { id: 'c-6', fromNodeId: 'node-dsp', fromPortId: 'out_dsp', toNodeId: 'node-duck', toPortId: 'in_voice_trigger' },
    { id: 'c-7', fromNodeId: 'node-duck', fromPortId: 'out_ducked_bg', toNodeId: 'node-align', toPortId: 'in_original_bg' },
    { id: 'c-8', fromNodeId: 'node-bus', fromPortId: 'out_bus_mix', toNodeId: 'node-align', toPortId: 'in_voices' },
    { id: 'c-9', fromNodeId: 'node-align', fromPortId: 'out_balanced_mix', toNodeId: 'node-loop', toPortId: 'in_main_pass', isLoop: true },
    { id: 'c-10', fromNodeId: 'node-loop', fromPortId: 'out_loop_repeat', toNodeId: 'node-bus', toPortId: 'in_voices_sum', isLoop: true },
    { id: 'c-11', fromNodeId: 'node-align', fromPortId: 'out_balanced_mix', toNodeId: 'node-disk-wav', toPortId: 'in_audio' },
    { id: 'c-12', fromNodeId: 'node-disk-wav', fromPortId: 'out_thru_pass', toNodeId: 'node-limiter', toPortId: 'in_audio' },
    { id: 'c-13', fromNodeId: 'node-limiter', fromPortId: 'out_limited', toNodeId: 'node-render', toPortId: 'in_master_audio' },
    { id: 'c-14', fromNodeId: 'node-v-in', fromPortId: 'video_out', toNodeId: 'node-mux', toPortId: 'in_video_stream' },
    { id: 'c-15', fromNodeId: 'node-render', fromPortId: 'out_wav_blob', toNodeId: 'node-mux', toPortId: 'in_dubbed_audio' },
    { id: 'c-16', fromNodeId: 'node-v-in', fromPortId: 'audio_orig_out', toNodeId: 'node-mux', toPortId: 'in_original_audio' },
    { id: 'c-17', fromNodeId: 'node-mux', fromPortId: 'out_dual_mp4', toNodeId: 'node-out', toPortId: 'in_final_video' }
  ]
};

/**
 * Граф для «Рекаст» (с WSOLA таймингом и отшиванием)
 */
export const DEFAULT_RECAST_GRAPH: RenderPipelineGraph = {
  version: 2,
  name: 'Рекаст тайминг-граф',
  category: 'Рекаст',
  executionMode: 'iterative_loop',
  nodes: [
    createPipelineNode('input_video', 'node-v-in', 50, 80),
    createPipelineNode('input_tracks', 'node-t-in', 50, 260),
    createPipelineNode('input_subtitles', 'node-sub', 50, 420),
    createPipelineNode('auto_timing', 'node-wsola', 320, 340),
    createPipelineNode('loudness_norm', 'node-norm', 580, 260),
    createPipelineNode('neural_matrix', 'node-ai', 840, 260),
    createPipelineNode('track_dsp', 'node-dsp', 1100, 260),
    createPipelineNode('auto_ducking', 'node-duck', 840, 80),
    createPipelineNode('vocal_bus', 'node-bus', 1360, 260),
    createPipelineNode('loudness_align', 'node-align', 1620, 180),
    createPipelineNode('disk_save_wav', 'node-disk-wav', 1880, 180),
    createPipelineNode('master_limiter', 'node-limiter', 2140, 180),
    createPipelineNode('master_render', 'node-render', 2400, 180),
    createPipelineNode('ffmpeg_dual_mux', 'node-mux', 2660, 120),
    createPipelineNode('output_video', 'node-out', 2920, 120)
  ],
  connections: [
    { id: 'c-rc-1', fromNodeId: 'node-t-in', fromPortId: 'tracks_main_out', toNodeId: 'node-wsola', toPortId: 'in_audio' },
    { id: 'c-rc-2', fromNodeId: 'node-sub', fromPortId: 'sub_timing_out', toNodeId: 'node-wsola', toPortId: 'in_sync_ref' },
    { id: 'c-rc-3', fromNodeId: 'node-wsola', fromPortId: 'out_stretched', toNodeId: 'node-norm', toPortId: 'in_audio' },
    { id: 'c-rc-4', fromNodeId: 'node-norm', fromPortId: 'out_normalized', toNodeId: 'node-ai', toPortId: 'in_audio' },
    { id: 'c-rc-5', fromNodeId: 'node-ai', fromPortId: 'out_ai_processed', toNodeId: 'node-dsp', toPortId: 'in_raw' },
    { id: 'c-rc-6', fromNodeId: 'node-dsp', fromPortId: 'out_dsp', toNodeId: 'node-bus', toPortId: 'in_voices_sum' },
    { id: 'c-rc-7', fromNodeId: 'node-v-in', fromPortId: 'audio_orig_out', toNodeId: 'node-duck', toPortId: 'in_bg_video' },
    { id: 'c-rc-8', fromNodeId: 'node-dsp', fromPortId: 'out_dsp', toNodeId: 'node-duck', toPortId: 'in_voice_trigger' },
    { id: 'c-rc-9', fromNodeId: 'node-duck', fromPortId: 'out_ducked_bg', toNodeId: 'node-align', toPortId: 'in_original_bg' },
    { id: 'c-rc-10', fromNodeId: 'node-bus', fromPortId: 'out_bus_mix', toNodeId: 'node-align', toPortId: 'in_voices' },
    { id: 'c-rc-11', fromNodeId: 'node-align', fromPortId: 'out_balanced_mix', toNodeId: 'node-disk-wav', toPortId: 'in_audio' },
    { id: 'c-rc-12', fromNodeId: 'node-disk-wav', fromPortId: 'out_thru_pass', toNodeId: 'node-limiter', toPortId: 'in_audio' },
    { id: 'c-rc-13', fromNodeId: 'node-limiter', fromPortId: 'out_limited', toNodeId: 'node-render', toPortId: 'in_master_audio' },
    { id: 'c-rc-14', fromNodeId: 'node-v-in', fromPortId: 'video_out', toNodeId: 'node-mux', toPortId: 'in_video_stream' },
    { id: 'c-rc-15', fromNodeId: 'node-render', fromPortId: 'out_wav_blob', toNodeId: 'node-mux', toPortId: 'in_dubbed_audio' },
    { id: 'c-rc-16', fromNodeId: 'node-v-in', fromPortId: 'audio_orig_out', toNodeId: 'node-mux', toPortId: 'in_original_audio' },
    { id: 'c-rc-17', fromNodeId: 'node-mux', fromPortId: 'out_dual_mp4', toNodeId: 'node-out', toPortId: 'in_final_video' }
  ]
};

/**
 * Граф для «Редаб / Дубляж» (с изоляцией стемов, VoiceFixer и сбросом стемов на диск)
 */
export const DEFAULT_REDUB_GRAPH: RenderPipelineGraph = {
  version: 2,
  name: 'Редаб / Дубляж M&E граф',
  category: 'Редаб',
  executionMode: 'parallel_stems',
  nodes: [
    createPipelineNode('input_video', 'node-v-in', 50, 80),
    createPipelineNode('input_tracks', 'node-t-in', 50, 260),
    createPipelineNode('stem_sep_uvr', 'node-uvr', 320, 80),
    createPipelineNode('spectral_denoise_ai', 'node-denoise', 320, 260),
    createPipelineNode('voicefixer_harmonics', 'node-fixer', 580, 260),
    createPipelineNode('track_dsp', 'node-dsp', 840, 260),
    createPipelineNode('vocal_bus', 'node-bus', 1100, 260),
    createPipelineNode('stems_splitter_disk', 'node-stems-disk', 1360, 80),
    createPipelineNode('loudness_align', 'node-align', 1360, 260),
    createPipelineNode('disk_save_wav', 'node-disk-wav', 1620, 260),
    createPipelineNode('master_limiter', 'node-limiter', 1880, 260),
    createPipelineNode('master_render', 'node-render', 2140, 260),
    createPipelineNode('ffmpeg_dual_mux', 'node-mux', 2400, 180),
    createPipelineNode('output_video', 'node-out', 2660, 180)
  ],
  connections: [
    { id: 'c-rd-1', fromNodeId: 'node-v-in', fromPortId: 'audio_orig_out', toNodeId: 'node-uvr', toPortId: 'in_mix' },
    { id: 'c-rd-2', fromNodeId: 'node-t-in', fromPortId: 'tracks_main_out', toNodeId: 'node-denoise', toPortId: 'in_noisy' },
    { id: 'c-rd-3', fromNodeId: 'node-denoise', fromPortId: 'out_denoised', toNodeId: 'node-fixer', toPortId: 'in_audio' },
    { id: 'c-rd-4', fromNodeId: 'node-fixer', fromPortId: 'out_restored', toNodeId: 'node-dsp', toPortId: 'in_raw' },
    { id: 'c-rd-5', fromNodeId: 'node-dsp', fromPortId: 'out_dsp', toNodeId: 'node-bus', toPortId: 'in_voices_sum' },
    { id: 'c-rd-6', fromNodeId: 'node-uvr', fromPortId: 'out_instruments', toNodeId: 'node-stems-disk', toPortId: 'in_music' },
    { id: 'c-rd-7', fromNodeId: 'node-bus', fromPortId: 'out_bus_mix', toNodeId: 'node-stems-disk', toPortId: 'in_vocals' },
    { id: 'c-rd-8', fromNodeId: 'node-uvr', fromPortId: 'out_instruments', toNodeId: 'node-align', toPortId: 'in_original_bg' },
    { id: 'c-rd-9', fromNodeId: 'node-bus', fromPortId: 'out_bus_mix', toNodeId: 'node-align', toPortId: 'in_voices' },
    { id: 'c-rd-10', fromNodeId: 'node-align', fromPortId: 'out_balanced_mix', toNodeId: 'node-disk-wav', toPortId: 'in_audio' },
    { id: 'c-rd-11', fromNodeId: 'node-disk-wav', fromPortId: 'out_thru_pass', toNodeId: 'node-limiter', toPortId: 'in_audio' },
    { id: 'c-rd-12', fromNodeId: 'node-limiter', fromPortId: 'out_limited', toNodeId: 'node-render', toPortId: 'in_master_audio' },
    { id: 'c-rd-13', fromNodeId: 'node-v-in', fromPortId: 'video_out', toNodeId: 'node-mux', toPortId: 'in_video_stream' },
    { id: 'c-rd-14', fromNodeId: 'node-render', fromPortId: 'out_wav_blob', toNodeId: 'node-mux', toPortId: 'in_dubbed_audio' },
    { id: 'c-rd-15', fromNodeId: 'node-uvr', fromPortId: 'out_instruments', toNodeId: 'node-mux', toPortId: 'in_original_audio' },
    { id: 'c-rd-16', fromNodeId: 'node-mux', fromPortId: 'out_dual_mp4', toNodeId: 'node-out', toPortId: 'in_final_video' }
  ]
};

/**
 * Синглтон-менеджер нодового графа роутинга рендера
 */
export class RenderPipelineGraphManager {
  private static instance: RenderPipelineGraphManager;
  private currentGraph: RenderPipelineGraph;
  private listeners: Set<() => void> = new Set();

  private constructor() {
    this.currentGraph = JSON.parse(JSON.stringify(DEFAULT_ZAKADR_GRAPH));
  }

  public static getInstance(): RenderPipelineGraphManager {
    if (!RenderPipelineGraphManager.instance) {
      RenderPipelineGraphManager.instance = new RenderPipelineGraphManager();
    }
    return RenderPipelineGraphManager.instance;
  }

  public subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify() {
    this.listeners.forEach((cb) => {
      try {
        cb();
      } catch (e) {
        console.error('[RenderPipelineGraphManager] Listener error:', e);
      }
    });
  }

  public getGraph(): RenderPipelineGraph {
    return this.currentGraph;
  }

  public setGraph(graph: RenderPipelineGraph, silent: boolean = false) {
    // Гарантируем наличие портов у всех нод
    const sanitizedNodes = toSafeArray<PipelineNode>(graph.nodes).map((node) => {
      const def = NODE_DEFINITIONS[node.type];
      return {
        ...node,
        inputs: node.inputs && node.inputs.length > 0 ? node.inputs : (def ? def.defaultInputs : []),
        outputs: node.outputs && node.outputs.length > 0 ? node.outputs : (def ? def.defaultOutputs : [])
      };
    });

    this.currentGraph = {
      ...graph,
      nodes: sanitizedNodes,
      connections: toSafeArray(graph.connections)
    };

    if (!silent) {
      this.notify();
    }
    systemLogger.info('RenderManager', `Граф роутинга обновлен: "${graph.name}" (${sanitizedNodes.length} нод)`);
  }

  public getSerializableGraph(): RenderPipelineGraph {
    return JSON.parse(JSON.stringify(this.currentGraph));
  }

  public loadDefaultGraphForCategory(category: string): RenderPipelineGraph {
    let base = DEFAULT_ZAKADR_GRAPH;
    if (category === 'Рекаст') {
      base = DEFAULT_RECAST_GRAPH;
    } else if (category === 'Редаб' || category === 'Ридап' || category === 'Дубляж') {
      base = DEFAULT_REDUB_GRAPH;
    }
    const cloned = JSON.parse(JSON.stringify(base));
    cloned.category = category;
    this.setGraph(cloned);
    return cloned;
  }

  public updateNode(nodeId: string, patch: Partial<PipelineNode>) {
    const nodeIndex = this.currentGraph.nodes.findIndex((n) => n.id === nodeId);
    if (nodeIndex !== -1) {
      this.currentGraph.nodes[nodeIndex] = {
        ...this.currentGraph.nodes[nodeIndex],
        ...patch,
        parameters: {
          ...this.currentGraph.nodes[nodeIndex].parameters,
          ...(patch.parameters || {})
        }
      };
      this.notify();
    }
  }

  public addNode(type: PipelineNodeType, x: number = 400, y: number = 200): PipelineNode {
    const newNode = createPipelineNode(type, undefined, x, y);
    this.currentGraph.nodes.push(newNode);
    this.notify();
    return newNode;
  }

  public deleteNode(nodeId: string) {
    this.currentGraph.nodes = this.currentGraph.nodes.filter((n) => n.id !== nodeId);
    this.currentGraph.connections = this.currentGraph.connections.filter(
      (c) => c.fromNodeId !== nodeId && c.toNodeId !== nodeId
    );
    this.notify();
  }

  public toggleNodeEnabled(nodeId: string): boolean {
    const node = this.currentGraph.nodes.find((n) => n.id === nodeId);
    if (node) {
      node.enabled = !node.enabled;
      this.notify();
      return node.enabled;
    }
    return false;
  }

  /**
   * Добавление связи между портами
   */
  public addPortConnection(
    fromNodeId: string,
    fromPortId: string,
    toNodeId: string,
    toPortId: string,
    isLoop: boolean = false
  ): PipelineConnection {
    // Предотвращение дублирования
    const existing = this.currentGraph.connections.find(
      (c) =>
        c.fromNodeId === fromNodeId &&
        c.fromPortId === fromPortId &&
        c.toNodeId === toNodeId &&
        c.toPortId === toPortId
    );
    if (existing) return existing;

    const newConn: PipelineConnection = {
      id: `conn-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
      fromNodeId,
      fromPortId,
      toNodeId,
      toPortId,
      isLoop
    };
    this.currentGraph.connections.push(newConn);
    this.notify();
    return newConn;
  }

  public deleteConnection(connId: string) {
    this.currentGraph.connections = this.currentGraph.connections.filter((c) => c.id !== connId);
    this.notify();
  }

  public deleteConnectionsForPort(nodeId: string, portId: string, isInput: boolean) {
    this.currentGraph.connections = this.currentGraph.connections.filter((c) => {
      if (isInput) {
        return !(c.toNodeId === nodeId && c.toPortId === portId);
      } else {
        return !(c.fromNodeId === nodeId && c.fromPortId === portId);
      }
    });
    this.notify();
  }

  public reorderNodes(fromIndex: number, toIndex: number) {
    const nodes = [...this.currentGraph.nodes];
    const [moved] = nodes.splice(fromIndex, 1);
    nodes.splice(toIndex, 0, moved);
    this.currentGraph.nodes = nodes;
    this.notify();
  }
}

export const globalRenderPipelineGraphManager = RenderPipelineGraphManager.getInstance();
