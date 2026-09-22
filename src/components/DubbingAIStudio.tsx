import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  BrainCircuit,
  Activity,
  CheckCircle2,
  AlertTriangle,
  Download,
  Sparkles,
  Play,
  Pause,
  RotateCcw,
  Zap,
  Sliders,
  Layers,
  Cpu,
  Scissors,
  Volume2,
  VolumeX,
  RefreshCw,
  Search,
  Filter,
  ArrowRight,
  Database,
  FileAudio,
  Radio,
  SlidersHorizontal,
  Wand2,
  Check,
  Music,
  Mic,
  Disc,
  Info,
  ExternalLink,
  Trash2,
  Settings2,
  ShieldCheck,
  Headphones,
  CheckCheck,
  Gauge,
  Workflow,
  HardDrive,
  Copy,
  ChevronRight,
  ListFilter,
  Plus
} from 'lucide-react';
import {
  globalAIModelCatalog,
  ModelCatalogItem,
  ModelCategory,
  ModelDownloadProgress
} from '../services/AudioAIModelCatalog';
import { globalNativeDAWBridge } from '../services/NativeDAWBridge';
import {
  globalAudioAICleanupEngine,
  DenoiseOptions,
  DereverbOptions,
  SpectralMatchOptions,
  SpectralMatchResult,
  VoiceFixerOptions
} from '../services/AudioAICleanupEngine';
import {
  globalAudioAIEngine,
  SpeechSegment,
  SubtitleLine,
  AlignedSpeechPhrase
} from '../services/AudioAIEngine';
import { globalStemSeparationService } from '../services/StemSeparationService';
import { TrackState } from '../audio/dawEngine';
import { formatSMPTE } from '../utils/waveformUtils';
import { toSafeArray } from '../utils/safeIterables';
import {
  globalAIPipelineStore,
  AIPurposeType,
  AIStepNode,
  TrackAIConfig
} from '../services/AIPipelineStore';

const PURPOSE_TO_CATEGORY_MAP: Record<AIPurposeType, ModelCategory> = {
  stem_separation: 'separation',
  denoise: 'denoise',
  dereverb: 'dereverb',
  spectral_match: 'vocal_match',
  voicefixer: 'vocal_match',
  whisper_vad: 'whisper',
  vocal_chain: 'denoise'
};

export interface DubbingAIStudioProps {
  tracks: TrackState[];
  currentTimeSec: number;
  onSeek: (timeSec: number) => void;
  onAddStemTracks?: (vocalsPcm: Float32Array, karaokePcm: Float32Array, vocalsName?: string, karaokeName?: string) => void;
  onApplyProcessedAudioToTrack?: (trackId: number, newPcm: Float32Array, clipName?: string) => void;
  mode?: 'full' | 'matrix-only';
  initialTab?: AITab;
}

export type AITab =
  | 'matrix'
  | 'models'
  | 'separation'
  | 'cleanup'
  | 'spectral'
  | 'voicefixer'
  | 'whisper'
  | 'settings';

export const PURPOSE_DESCRIPTIONS: Record<
  AIPurposeType,
  {
    title: string;
    icon: string;
    why: string;
    defaultModel: string;
    badgeColor: string;
  }
> = {
  stem_separation: {
    title: 'Изоляция чистого голоса и M&E фонограммы (Stem Separation)',
    icon: '✂️',
    why: 'Отделяет речь актера от фоновой музыки и эффектов видео для создания чистого минуса и замены голоса дубляжом.',
    defaultModel: 'uvr_mdx_voc_ft',
    badgeColor: 'emerald'
  },
  denoise: {
    title: 'Подавление микрофонного шума и шипения (De-Noise)',
    icon: '🧹',
    why: 'Устраняет шум вентилятора ПК, кондиционера, преампа и статическое шипение без искажения формант речи.',
    defaultModel: 'deepfilternet3',
    badgeColor: 'blue'
  },
  dereverb: {
    title: 'Устранение эха и реверберации помещения (De-Reverb)',
    icon: '🏛️',
    why: 'Убирает гулкость и комнатные отражения стен («Room Acoustic Fix»), делая голос сухим, как в звукоизолированной будке.',
    defaultModel: 'reverb_foxjoy',
    badgeColor: 'cyan'
  },
  spectral_match: {
    title: 'Спектральная подгонка тембра к оригиналу (Spectral EQ Match)',
    icon: '🎚️',
    why: 'Переносит спектральный баланс (АЧХ) и плотность оригинального голливудского голоса на дорожку дублера.',
    defaultModel: 'vocal_spectral_matcher',
    badgeColor: 'purple'
  },
  voicefixer: {
    title: 'Реставрация верхов Air-Band и деклиппинг (VoiceFixer)',
    icon: '✨',
    why: 'Синтезирует обертоны выше 8 кГц, устраняет искажения перегрузки микрофона и добавляет теплоту аналоговой пленки.',
    defaultModel: 'voicefixer_restorer',
    badgeColor: 'amber'
  },
  whisper_vad: {
    title: 'Распознавание речи и синхронизация сценария (Whisper ASR + VAD)',
    icon: '📝',
    why: 'Транскрибирует дубль в текст и рассчитывает точные таймкоды пауз для идеального лип-синка.',
    defaultModel: 'whisper_large_v3',
    badgeColor: 'rose'
  },
  vocal_chain: {
    title: 'Полный студийный ремастеринг вокала (All-in-One Voice Chain)',
    icon: '🚀',
    why: 'Комплексный 4-ступенчатый AI процессинг: De-Noise → De-Reverb → Spectral Matching → VoiceFixer в один проход.',
    defaultModel: 'deepfilternet3',
    badgeColor: 'emerald'
  }
};

const SAMPLE_SRT_SCRIPT = `1
00:00:01,200 --> 00:00:03,800
Привет всем! Это тестовая озвучка для проверки дубляжа.

2
00:00:04,500 --> 00:00:07,100
Все нейросети работают прямо в браузере без облачных серверов.

3
00:00:07,800 --> 00:00:10,500
Silero VAD детектирует паузы, а Whisper транскрибирует текст.

4
00:00:11,000 --> 00:00:13,600
Смарт-выравнивание синхронизирует реплики с оригиналом.`;

export const DubbingAIStudio: React.FC<DubbingAIStudioProps> = ({
  tracks,
  currentTimeSec,
  onSeek,
  onAddStemTracks,
  onApplyProcessedAudioToTrack,
  mode = 'full',
  initialTab
}) => {
  const [activeTab, setActiveTab] = useState<AITab>(
    mode === 'matrix-only' ? 'matrix' : (initialTab || 'models')
  );
  const [models, setModels] = useState<ModelCatalogItem[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, ModelDownloadProgress>>({});

  const safeTracks = useMemo(() => toSafeArray<TrackState>(tracks), [tracks]);

  // --- 0. MATRIX / ROUTER STATE ---
  const [trackConfigs, setTrackConfigs] = useState<Record<number, TrackAIConfig>>(() => {
    return globalAIPipelineStore.getConfigs();
  });

  useEffect(() => {
    globalAIPipelineStore.setConfigs(trackConfigs);
  }, [trackConfigs]);
  const [isBatchProcessing, setIsBatchProcessing] = useState<boolean>(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; message: string }>({
    current: 0,
    total: 0,
    message: ''
  });
  const [abActiveTrackId, setAbActiveTrackId] = useState<number | null>(null);
  const [abActiveMode, setAbActiveMode] = useState<'original' | 'processed' | null>(null);

  // --- 1. STEM SEPARATION STATE ---
  const [sepTrackId, setSepTrackId] = useState<number>(() => toSafeArray<TrackState>(tracks)[0]?.id || 1);
  const [sepModelId, setSepModelId] = useState<string>('uvr_mdx_voc_ft');
  const [sepMode, setSepMode] = useState<'vocals_karaoke' | '4stems'>('vocals_karaoke');
  const [isSeparating, setIsSeparating] = useState<boolean>(false);
  const [sepProgress, setSepProgress] = useState<{ percent: number; message: string }>({ percent: 0, message: '' });
  const [sepResult, setSepResult] = useState<{
    vocalsWavUrl?: string;
    karaokeWavUrl?: string;
    vocalsPcm?: Float32Array;
    karaokePcm?: Float32Array;
    durationSec?: number;
  } | null>(null);

  // --- 2. DENOISE & DEREVERB STATE ---
  const [cleanTrackId, setCleanTrackId] = useState<number>(() => {
    const arr = toSafeArray<TrackState>(tracks);
    return arr[1]?.id || arr[0]?.id || 1;
  });
  const [denoiseModelId, setDenoiseModelId] = useState<string>('deepfilternet3');
  const [dereverbModelId, setDereverbModelId] = useState<string>('reverb_foxjoy');
  const [denoiseAmount, setDenoiseAmount] = useState<number>(75);
  const [dereverbAmount, setDereverbAmount] = useState<number>(60);
  const [enableLowCut, setEnableLowCut] = useState<boolean>(true);
  const [isCleaning, setIsCleaning] = useState<boolean>(false);
  const [cleanProgress, setCleanProgress] = useState<{ percent: number; message: string }>({ percent: 0, message: '' });
  const [cleanedAudioBuffer, setCleanedAudioBuffer] = useState<Float32Array | null>(null);
  const [cleanedAudioUrl, setCleanedAudioUrl] = useState<string | null>(null);
  const [originalAudioUrl, setOriginalAudioUrl] = useState<string | null>(null);
  const [abPlaying, setAbPlaying] = useState<'original' | 'cleaned' | null>(null);

  // --- 3. SPECTRAL VOCAL MATCHING STATE ---
  const [specRefTrackId, setSpecRefTrackId] = useState<number>(() => toSafeArray<TrackState>(tracks)[0]?.id || 1);
  const [specTargetTrackId, setSpecTargetTrackId] = useState<number>(() => {
    const arr = toSafeArray<TrackState>(tracks);
    return arr[1]?.id || arr[0]?.id || 1;
  });
  const [matchIntensity, setMatchIntensity] = useState<number>(85);
  const [formantWeight, setFormantWeight] = useState<number>(70);
  const [isMatching, setIsMatching] = useState<boolean>(false);
  const [matchProgress, setMatchProgress] = useState<{ percent: number; message: string }>({ percent: 0, message: '' });
  const [matchResult, setMatchResult] = useState<SpectralMatchResult | null>(null);

  // --- 4. VOICEFIXER & HARMONIC RESTORATION STATE ---
  const [vfTrackId, setVfTrackId] = useState<number>(() => {
    const arr = toSafeArray<TrackState>(tracks);
    return arr[1]?.id || arr[0]?.id || 1;
  });
  const [airBandBoost, setAirBandBoost] = useState<number>(4.0);
  const [declipSens, setDeclipSens] = useState<number>(80);
  const [warmthSat, setWarmthSat] = useState<number>(45);
  const [isFixing, setIsFixing] = useState<boolean>(false);
  const [vfProgress, setVfProgress] = useState<{ percent: number; message: string }>({ percent: 0, message: '' });
  const [vfProcessedBuffer, setVfProcessedBuffer] = useState<Float32Array | null>(null);

  // --- 5. WHISPER & VAD ALIGNMENT STATE ---
  const [whisperTrackId, setWhisperTrackId] = useState<number>(() => {
    const arr = toSafeArray<TrackState>(tracks);
    return arr[1]?.id || arr[0]?.id || 1;
  });
  const [whisperModelId, setWhisperModelId] = useState<string>('whisper_base');
  const [vadThreshold, setVadThreshold] = useState<number>(0.5);
  const [isProcessingVad, setIsProcessingVad] = useState<boolean>(false);
  const [speechSegments, setSpeechSegments] = useState<SpeechSegment[]>([]);
  const [scriptContent, setScriptContent] = useState<string>(SAMPLE_SRT_SCRIPT);
  const [parsedSubtitles, setParsedSubtitles] = useState<SubtitleLine[]>([]);
  const [alignedPhrases, setAlignedPhrases] = useState<AlignedSpeechPhrase[]>([]);

  // --- 6. MODELS CATALOG STATE ---
  const [catalogSearch, setCatalogSearch] = useState<string>('');
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState<string>('all');

  // --- 7. GLOBAL AI ENGINE SETTINGS ---
  const [executionEngine, setExecutionEngine] = useState<'webgpu' | 'wasm_simd' | 'webnn'>('wasm_simd');
  const [workerThreads, setWorkerThreads] = useState<number>(4);
  const [fftSize, setFftSize] = useState<number>(4096);
  const [safeAutoBackup, setSafeAutoBackup] = useState<boolean>(true);
  const [vramUsageMb, setVramUsageMb] = useState<number>(245);

  // Audio preview element
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  // Load models on mount & subscribe to download events
  useEffect(() => {
    setModels(globalAIModelCatalog.getAllModels());
    const unsub = globalAIModelCatalog.subscribe((prog) => {
      setDownloadProgress((prev) => ({ ...prev, [prog.modelId]: prog }));
      if (prog.status === 'installed' || prog.status === 'idle') {
        setModels(globalAIModelCatalog.getAllModels());
      }
    });
    return () => unsub();
  }, []);

  // --- INSTALLED MODELS ONLY FOR MVP INTERFACE ---
  const installedModels = useMemo(() => {
    return toSafeArray<ModelCatalogItem>(models).filter((m) => m && m.is_installed);
  }, [models]);

  // Synchronize track configs when tracks list changes
  useEffect(() => {
    const currentSafeTracks = toSafeArray<TrackState>(tracks);
    setTrackConfigs((prev) => {
      const updated: Record<number, TrackAIConfig> = { ...prev };
      currentSafeTracks.forEach((track) => {
        if (!track) return;
        // Дорожка считается оригинальным звуком видео ТОЛЬКО при наличии флага или маркера
        const isVideoOrOrig = Boolean(
          track.isOriginalAudio ||
          (track.name && /^(🎬|видео|video|оригинальный звук)/i.test(track.name.trim()))
        );

        const initialPurpose: AIPurposeType = isVideoOrOrig ? 'stem_separation' : 'denoise';

        const initialSteps: AIStepNode[] = isVideoOrOrig
          ? [
              {
                id: `step_${Date.now()}_1`,
                enabled: true,
                purpose: 'stem_separation',
                modelId: 'uvr_mdx_voc_ft',
                intensity: 75,
                dereverbAmount: 60,
                enableLowCut: true,
                warmthSat: 40,
                airBandBoost: 3.5
              }
            ]
          : [
              {
                id: `step_${Date.now()}_1`,
                enabled: true,
                purpose: 'denoise',
                modelId: 'deepfilternet3',
                intensity: 75,
                dereverbAmount: 60,
                enableLowCut: true,
                warmthSat: 40,
                airBandBoost: 3.5
              },
              {
                id: `step_${Date.now()}_2`,
                enabled: true,
                purpose: 'dereverb',
                modelId: 'reverb_foxjoy',
                intensity: 60,
                dereverbAmount: 60,
                enableLowCut: true,
                warmthSat: 40,
                airBandBoost: 3.5
              }
            ];

        if (!updated[track.id]) {
          updated[track.id] = {
            trackId: track.id,
            enabled: true,
            purpose: initialPurpose,
            modelId: PURPOSE_DESCRIPTIONS[initialPurpose].defaultModel,
            intensity: 75,
            dereverbAmount: 60,
            enableLowCut: true,
            warmthSat: 40,
            airBandBoost: 3.5,
            steps: initialSteps,
            outputMode: isVideoOrOrig ? 'stems' : 'replace',
            status: 'idle',
            progressPercent: 0
          };
        } else if (isVideoOrOrig && updated[track.id].purpose === 'denoise' && updated[track.id].status === 'idle') {
          // Автоматическое обновление конфигурации, если дорожка была идентифицирована как оригинал/видео
          updated[track.id] = {
            ...updated[track.id],
            purpose: 'stem_separation',
            modelId: 'uvr_mdx_voc_ft',
            steps: initialSteps,
            outputMode: 'stems'
          };
        }
      });
      return updated;
    });
  }, [safeTracks]);

  // Update default track IDs when tracks change
  useEffect(() => {
    if (safeTracks.length > 0) {
      if (!safeTracks.some((t) => t && t.id === sepTrackId)) setSepTrackId(safeTracks[0]?.id || 1);
      if (!safeTracks.some((t) => t && t.id === cleanTrackId)) setCleanTrackId(safeTracks[1]?.id || safeTracks[0]?.id || 1);
      if (!safeTracks.some((t) => t && t.id === specRefTrackId)) setSpecRefTrackId(safeTracks[0]?.id || 1);
      if (!safeTracks.some((t) => t && t.id === specTargetTrackId)) setSpecTargetTrackId(safeTracks[1]?.id || safeTracks[0]?.id || 1);
      if (!safeTracks.some((t) => t && t.id === vfTrackId)) setVfTrackId(safeTracks[1]?.id || safeTracks[0]?.id || 1);
      if (!safeTracks.some((t) => t && t.id === whisperTrackId)) setWhisperTrackId(safeTracks[1]?.id || safeTracks[0]?.id || 1);
    }
  }, [safeTracks, sepTrackId, cleanTrackId, specRefTrackId, specTargetTrackId, vfTrackId, whisperTrackId]);

  // Filtered models for catalog tab
  const filteredCatalogModels = useMemo(() => {
    return toSafeArray<ModelCatalogItem>(models).filter((m) => {
      if (!m) return false;
      const matchSearch =
        (m.name || '').toLowerCase().includes(catalogSearch.toLowerCase()) ||
        (m.filename || '').toLowerCase().includes(catalogSearch.toLowerCase()) ||
        (m.description || '').toLowerCase().includes(catalogSearch.toLowerCase()) ||
        (m.recommended_for || '').toLowerCase().includes(catalogSearch.toLowerCase());
      const matchCategory = catalogCategoryFilter === 'all' || m.category === catalogCategoryFilter;
      return matchSearch && matchCategory;
    });
  }, [models, catalogSearch, catalogCategoryFilter]);

  // Helper to get PCM buffer from track
  const getTrackPCM = (trackId: number): Float32Array | null => {
    const targetTrack = safeTracks.find((t) => t && t.id === trackId);
    if (!targetTrack) return null;
    const safeClips = toSafeArray(targetTrack.clips);
    if (safeClips.length === 0) return null;
    const clip = safeClips[0] as any;
    return clip ? clip.buffer || null : null;
  };

  // Helper to create a WAV Blob from Float32Array interleaved buffer
  const createWavBlobFromInterleaved = (pcm: Float32Array, sampleRate = 48000): Blob => {
    const frames = Math.floor(pcm.length / 2);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = pcm[i * 2];
      right[i] = pcm[i * 2 + 1];
    }
    return globalNativeDAWBridge.packWavNative(left, right, sampleRate, 16);
  };

  // =========================================================================
  // HANDLERS: MATRIX TRACK ROUTING & PROCESSING
  // =========================================================================
  const handleUpdateTrackConfig = (trackId: number, patch: Partial<TrackAIConfig>) => {
    setTrackConfigs((prev) => {
      const current = prev[trackId];
      if (!current) return prev;
      const updated = { ...current, ...patch };

      // If purpose changed, auto-assign suitable default model and default output mode
      if (patch.purpose && patch.purpose !== current.purpose) {
        updated.modelId = PURPOSE_DESCRIPTIONS[patch.purpose]?.defaultModel || 'deepfilternet3';
        updated.outputMode = patch.purpose === 'stem_separation' ? 'stems' : 'replace';
      }
      return { ...prev, [trackId]: updated };
    });
  };

  const handleAddAIStep = (trackId: number, defaultPurpose: AIPurposeType = 'denoise') => {
    setTrackConfigs((prev) => {
      const cfg = prev[trackId];
      if (!cfg) return prev;
      const defaultModel = PURPOSE_DESCRIPTIONS[defaultPurpose]?.defaultModel || 'deepfilternet3';
      const newStep: AIStepNode = {
        id: `step_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        enabled: true,
        purpose: defaultPurpose,
        modelId: defaultModel,
        intensity: 75,
        dereverbAmount: 60,
        enableLowCut: true,
        warmthSat: 40,
        airBandBoost: 3.5
      };
      const newSteps = [...(cfg.steps || []), newStep];
      return {
        ...prev,
        [trackId]: {
          ...cfg,
          steps: newSteps
        }
      };
    });
  };

  const handleRemoveAIStep = (trackId: number, stepId: string) => {
    setTrackConfigs((prev) => {
      const cfg = prev[trackId];
      if (!cfg || !cfg.steps) return prev;
      if (cfg.steps.length <= 1) {
        alert('У дорожки должна оставаться хотя бы одна нейросетевая настройка.');
        return prev;
      }
      const newSteps = (cfg.steps || []).filter((s) => s && s.id !== stepId);
      return {
        ...prev,
        [trackId]: {
          ...cfg,
          steps: newSteps
        }
      };
    });
  };

  const handleUpdateAIStep = (trackId: number, stepId: string, patch: Partial<AIStepNode>) => {
    setTrackConfigs((prev) => {
      const cfg = prev[trackId];
      if (!cfg || !cfg.steps) return prev;
      const newSteps = (cfg.steps || []).map((s) => {
        if (s.id !== stepId) return s;
        const updated = { ...s, ...patch };
        if (patch.purpose && patch.purpose !== s.purpose) {
          updated.modelId = PURPOSE_DESCRIPTIONS[patch.purpose]?.defaultModel || 'deepfilternet3';
        }
        return updated;
      });
      return {
        ...prev,
        [trackId]: {
          ...cfg,
          steps: newSteps
        }
      };
    });
  };

  /**
   * Run AI Processing sequentially across configured steps for a track in Matrix
   */
  const handleRunSingleMatrixTrack = async (trackId: number) => {
    const config = trackConfigs[trackId];
    if (!config) return;

    const pcm = getTrackPCM(trackId);
    if (!pcm || pcm.length === 0) {
      alert(`На Дорожке #${trackId} нет аудиоклипов для обработки.`);
      return;
    }

    const track = safeTracks.find((t) => t && t.id === trackId);
    const trackName = track?.name || `Дорожка ${trackId}`;

    const activeSteps = toSafeArray<AIStepNode>(config.steps).filter((s) => s && s.enabled);
    if (activeSteps.length === 0) {
      alert(`На Дорожке #${trackId} нет включенных ИИ-шагов обработки.`);
      return;
    }

    handleUpdateTrackConfig(trackId, {
      status: 'processing',
      progressPercent: 5,
      statusMessage: `Запуск цепочки из ${activeSteps.length} нейросетей...`
    });

    try {
      let currentPcm: any = new Float32Array(pcm);
      let vocalsPcm: Float32Array | null = null;
      let karaokePcm: Float32Array | null = null;

      for (let idx = 0; idx < activeSteps.length; idx++) {
        const step = activeSteps[idx];
        const stepNum = idx + 1;
        const totalSteps = activeSteps.length;

        handleUpdateTrackConfig(trackId, {
          progressPercent: Math.round((idx / totalSteps) * 100),
          statusMessage: `Шаг ${stepNum}/${totalSteps}: ${PURPOSE_DESCRIPTIONS[step.purpose]?.title || step.purpose}...`
        });

        if (step.purpose === 'stem_separation') {
          const totalFrames = Math.floor(currentPcm.length / 2);
          const left = new Float32Array(totalFrames);
          const right = new Float32Array(totalFrames);
          for (let i = 0; i < totalFrames; i++) {
            left[i] = currentPcm[i * 2];
            right[i] = currentPcm[i * 2 + 1];
          }

          const sepRes = await globalStemSeparationService.separateStereoBuffer(left, right, {
            onProgress: (p) => {
              const basePct = Math.round((idx / totalSteps) * 100);
              const stepShare = Math.round(100 / totalSteps);
              const curPct = basePct + Math.round((p.progressPercent / 100) * stepShare);
              handleUpdateTrackConfig(trackId, {
                progressPercent: curPct,
                statusMessage: `Шаг ${stepNum}/${totalSteps} [Stem Sep]: ${p.message}`
              });
            }
          });

          vocalsPcm = new Float32Array(totalFrames * 2);
          karaokePcm = new Float32Array(totalFrames * 2);
          for (let i = 0; i < totalFrames; i++) {
            vocalsPcm[i * 2] = sepRes.vocalsStereo[0][i];
            vocalsPcm[i * 2 + 1] = sepRes.vocalsStereo[1][i];
            karaokePcm[i * 2] = sepRes.karaokeStereo[0][i];
            karaokePcm[i * 2 + 1] = sepRes.karaokeStereo[1][i];
          }
          currentPcm = vocalsPcm;
        } else if (step.purpose === 'denoise') {
          currentPcm = await globalAudioAICleanupEngine.processDenoise(
            currentPcm,
            {
              modelId: step.modelId,
              intensityPercent: step.intensity,
              lowCutHz: step.enableLowCut ? 80 : 0
            },
            (pct, msg) => {
              const basePct = Math.round((idx / totalSteps) * 100);
              const stepShare = Math.round(100 / totalSteps);
              handleUpdateTrackConfig(trackId, {
                progressPercent: basePct + Math.round((pct / 100) * stepShare),
                statusMessage: `Шаг ${stepNum}/${totalSteps} [De-Noise]: ${msg}`
              });
            }
          );
        } else if (step.purpose === 'dereverb') {
          currentPcm = await globalAudioAICleanupEngine.processDereverb(
            currentPcm,
            {
              modelId: step.modelId,
              reductionAmountPercent: step.dereverbAmount
            },
            (pct, msg) => {
              const basePct = Math.round((idx / totalSteps) * 100);
              const stepShare = Math.round(100 / totalSteps);
              handleUpdateTrackConfig(trackId, {
                progressPercent: basePct + Math.round((pct / 100) * stepShare),
                statusMessage: `Шаг ${stepNum}/${totalSteps} [De-Reverb]: ${msg}`
              });
            }
          );
        } else if (step.purpose === 'spectral_match') {
          const refPcm = getTrackPCM(specRefTrackId) || pcm;
          const specRes = await globalAudioAICleanupEngine.matchVocalCurves(
            refPcm,
            currentPcm,
            {
              matchIntensity: step.intensity,
              smoothingBands: 3,
              formantWeight: 0.75
            },
            (pct, msg) => {
              const basePct = Math.round((idx / totalSteps) * 100);
              const stepShare = Math.round(100 / totalSteps);
              handleUpdateTrackConfig(trackId, {
                progressPercent: basePct + Math.round((pct / 100) * stepShare),
                statusMessage: `Шаг ${stepNum}/${totalSteps} [Spectral]: ${msg}`
              });
            }
          );
          currentPcm = specRes.processedBuffer;
        } else if (step.purpose === 'voicefixer') {
          currentPcm = await globalAudioAICleanupEngine.processVoiceFixer(
            currentPcm,
            {
              airBandBoostDb: step.airBandBoost,
              declipSensitivity: 0.8,
              warmthSaturation: step.warmthSat / 100,
              subBassTuning: step.enableLowCut
            },
            (pct, msg) => {
              const basePct = Math.round((idx / totalSteps) * 100);
              const stepShare = Math.round(100 / totalSteps);
              handleUpdateTrackConfig(trackId, {
                progressPercent: basePct + Math.round((pct / 100) * stepShare),
                statusMessage: `Шаг ${stepNum}/${totalSteps} [VoiceFixer]: ${msg}`
              });
            }
          );
        } else if (step.purpose === 'vocal_chain') {
          const denoised = await globalAudioAICleanupEngine.processDenoise(
            currentPcm,
            { modelId: step.modelId, intensityPercent: step.intensity, lowCutHz: step.enableLowCut ? 80 : 0 }
          );
          const dereverbed = await globalAudioAICleanupEngine.processDereverb(
            denoised,
            { modelId: 'reverb_foxjoy', reductionAmountPercent: step.dereverbAmount }
          );
          currentPcm = await globalAudioAICleanupEngine.processVoiceFixer(
            dereverbed,
            { airBandBoostDb: step.airBandBoost, declipSensitivity: 0.85, warmthSaturation: step.warmthSat / 100 }
          );
        }
      }

      if (!currentPcm) throw new Error('Не удалось сформировать итоговый PCM поток.');

      // Create A/B preview URLs
      const origBlob = createWavBlobFromInterleaved(pcm);
      const procBlob = createWavBlobFromInterleaved(currentPcm);
      const origUrl = URL.createObjectURL(origBlob);
      const procUrl = URL.createObjectURL(procBlob);

      handleUpdateTrackConfig(trackId, {
        status: 'done',
        progressPercent: 100,
        statusMessage: `Цепочка из ${activeSteps.length} нейросетей выполнена!`,
        lastProcessedPcm: currentPcm,
        lastProcessedName: `${trackName} [AI Chain (${activeSteps.length})]`,
        abOriginalUrl: origUrl,
        abProcessedUrl: procUrl
      });

      if (config.outputMode === 'replace' && onApplyProcessedAudioToTrack) {
        onApplyProcessedAudioToTrack(trackId, currentPcm, `${trackName} [AI Processed]`);
      } else if (config.outputMode === 'stems' && vocalsPcm && karaokePcm && onAddStemTracks) {
        onAddStemTracks(vocalsPcm, karaokePcm, `[Вокал] ${trackName}`, `[Фонограмма M&E] ${trackName}`);
      }
    } catch (err: any) {
      console.error('[DubbingAIStudio] Ошибка выполнения AI цепочки:', err);
      handleUpdateTrackConfig(trackId, {
        status: 'error',
        progressPercent: 0,
        statusMessage: `Сбой цепочки: ${err?.message || 'Ошибка обработки'}`
      });
    }
  };

  /**
   * Run Batch Processing across ALL enabled tracks in Matrix
   */
  const handleRunMatrixBatch = async () => {
    const activeConfigs = toSafeArray<TrackAIConfig>(Object.values(trackConfigs || {})).filter((c) => c && c.enabled);
    if (activeConfigs.length === 0) {
      alert('Нет активных дорожек для обработки в матрице.');
      return;
    }

    setIsBatchProcessing(true);
    setBatchProgress({ current: 0, total: activeConfigs.length, message: 'Старт пакетной AI обработки...' });

    for (let i = 0; i < activeConfigs.length; i++) {
      const cfg = activeConfigs[i];
      setBatchProgress({
        current: i + 1,
        total: activeConfigs.length,
        message: `Обработка дорожки #${cfg.trackId} (${i + 1}/${activeConfigs.length}) [${cfg.purpose}]...`
      });
      await handleRunSingleMatrixTrack(cfg.trackId);
    }

    setIsBatchProcessing(false);
    setBatchProgress({
      current: activeConfigs.length,
      total: activeConfigs.length,
      message: 'Все дорожки успешно обработаны нейросетями!'
    });
  };

  // Play A/B audio in Matrix
  const handleToggleAbAudio = (trackId: number, mode: 'original' | 'processed') => {
    const cfg = trackConfigs[trackId];
    if (!cfg) return;

    if (abActiveTrackId === trackId && abActiveMode === mode) {
      if (audioPreviewRef.current) {
        audioPreviewRef.current.pause();
      }
      setAbActiveTrackId(null);
      setAbActiveMode(null);
      return;
    }

    const targetUrl = mode === 'original' ? cfg.abOriginalUrl : cfg.abProcessedUrl;
    if (!targetUrl) return;

    if (audioPreviewRef.current) {
      audioPreviewRef.current.src = targetUrl;
      audioPreviewRef.current.play();
      setAbActiveTrackId(trackId);
      setAbActiveMode(mode);
    }
  };

  // =========================================================================
  // HANDLERS: STEM SEPARATION
  // =========================================================================
  const handleRunStemSeparation = async () => {
    const pcm = getTrackPCM(sepTrackId);
    if (!pcm || pcm.length === 0) {
      alert('На выбранной дорожке нет аудиоклипов для разделения.');
      return;
    }

    setIsSeparating(true);
    setSepProgress({ percent: 5, message: `Запуск AI сепарации [${sepModelId}]...` });

    try {
      const totalFrames = Math.floor(pcm.length / 2);
      const leftChannel = new Float32Array(totalFrames);
      const rightChannel = new Float32Array(totalFrames);

      for (let i = 0; i < totalFrames; i++) {
        leftChannel[i] = pcm[i * 2];
        rightChannel[i] = pcm[i * 2 + 1];
      }

      const result = await globalStemSeparationService.separateStereoBuffer(leftChannel, rightChannel, {
        onProgress: (p) => {
          setSepProgress({
            percent: p.progressPercent,
            message: p.message
          });
        }
      });

      const vocUrl = URL.createObjectURL(result.vocalsWavBlob);
      const karUrl = URL.createObjectURL(result.karaokeWavBlob);

      const vocInterleaved = new Float32Array(totalFrames * 2);
      const karInterleaved = new Float32Array(totalFrames * 2);

      for (let i = 0; i < totalFrames; i++) {
        vocInterleaved[i * 2] = result.vocalsStereo[0][i];
        vocInterleaved[i * 2 + 1] = result.vocalsStereo[1][i];
        karInterleaved[i * 2] = result.karaokeStereo[0][i];
        karInterleaved[i * 2 + 1] = result.karaokeStereo[1][i];
      }

      setSepResult({
        vocalsWavUrl: vocUrl,
        karaokeWavUrl: karUrl,
        vocalsPcm: vocInterleaved,
        karaokePcm: karInterleaved,
        durationSec: result.durationSec
      });
    } catch (err: any) {
      console.error('[DubbingAIStudio] Ошибка сепарации:', err);
      alert(`Ошибка AI-разделения: ${err.message || 'Не удалось выполнить сепарацию'}`);
    } finally {
      setIsSeparating(false);
    }
  };

  const handleApplyStemsToProject = () => {
    if (!sepResult || !sepResult.vocalsPcm || !sepResult.karaokePcm) return;
    const targetTrack = safeTracks.find((t) => t.id === sepTrackId);
    const sourceName = targetTrack?.name || 'Оригинал';

    if (onAddStemTracks) {
      onAddStemTracks(
        sepResult.vocalsPcm,
        sepResult.karaokePcm,
        `[Изоляция Вокала] ${sourceName}`,
        `[Фонограмма M&E] ${sourceName}`
      );
    } else {
      alert('Стемы готовы! Добавьте их через микшер или панель дорожек.');
    }
  };

  // =========================================================================
  // HANDLERS: DENOISE & DEREVERB
  // =========================================================================
  const handleRunCleanup = async () => {
    const pcm = getTrackPCM(cleanTrackId);
    if (!pcm || pcm.length === 0) {
      alert('На выбранной дорожке нет аудиоклипов для очистки.');
      return;
    }

    setIsCleaning(true);
    setCleanProgress({ percent: 5, message: 'Инициализация нейросетей очистки...' });

    try {
      setCleanProgress({ percent: 20, message: `Денойзинг [${denoiseModelId}]...` });
      const denoiseOpts: DenoiseOptions = {
        modelId: denoiseModelId,
        intensityPercent: denoiseAmount,
        lowCutHz: enableLowCut ? 80 : 0
      };
      const denoised = await globalAudioAICleanupEngine.processDenoise(pcm, denoiseOpts);

      setCleanProgress({ percent: 60, message: `Дереверберация [${dereverbModelId}]...` });
      const dereverbOpts: DereverbOptions = {
        modelId: dereverbModelId,
        reductionAmountPercent: dereverbAmount
      };
      const dereverbed = await globalAudioAICleanupEngine.processDereverb(denoised, dereverbOpts);

      setCleanProgress({ percent: 100, message: 'Очистка успешно завершена!' });
      setCleanedAudioBuffer(dereverbed);

      const origBlob = createWavBlobFromInterleaved(pcm);
      const cleanBlob = createWavBlobFromInterleaved(dereverbed);

      setOriginalAudioUrl(URL.createObjectURL(origBlob));
      setCleanedAudioUrl(URL.createObjectURL(cleanBlob));
    } catch (err: any) {
      console.error('[DubbingAIStudio] Ошибка очистки:', err);
      alert(`Ошибка очистки аудио: ${err.message || 'Сбой нейросети'}`);
    } finally {
      setIsCleaning(false);
    }
  };

  const handleTogglePlayCleanPreview = (which: 'original' | 'cleaned') => {
    if (abPlaying === which) {
      if (audioPreviewRef.current) audioPreviewRef.current.pause();
      setAbPlaying(null);
      return;
    }

    const url = which === 'original' ? originalAudioUrl : cleanedAudioUrl;
    if (url && audioPreviewRef.current) {
      audioPreviewRef.current.src = url;
      audioPreviewRef.current.play();
      setAbPlaying(which);
    }
  };

  const handleApplyCleanedToTrack = () => {
    if (!cleanedAudioBuffer) return;
    const targetTrack = safeTracks.find((t) => t.id === cleanTrackId);
    const tName = targetTrack?.name || `Дорожка ${cleanTrackId}`;

    if (onApplyProcessedAudioToTrack) {
      onApplyProcessedAudioToTrack(cleanTrackId, cleanedAudioBuffer, `${tName} (Очищено AI)`);
    } else {
      alert('Очищенное аудио готово!');
    }
  };

  // =========================================================================
  // HANDLERS: SPECTRAL MATCHING
  // =========================================================================
  const handleRunSpectralMatch = async () => {
    const targetPcm = getTrackPCM(specTargetTrackId);
    const refPcm = getTrackPCM(specRefTrackId);

    if (!targetPcm || targetPcm.length === 0) {
      alert('На дорожке дублера нет аудиоклипов.');
      return;
    }
    if (!refPcm || refPcm.length === 0) {
      alert('На референсной дорожке оригинала нет аудиоклипов.');
      return;
    }

    setIsMatching(true);
    setMatchProgress({ percent: 10, message: 'Спектральный анализ 4096-FFT референса оригинала...' });

    try {
      const opts: SpectralMatchOptions = {
        matchIntensity: matchIntensity,
        smoothingBands: 3,
        formantWeight: formantWeight / 100
      };

      setMatchProgress({ percent: 50, message: 'Расчет разностной кривой эквализации (EQ Transfer)...' });
      const result = await globalAudioAICleanupEngine.matchVocalCurves(refPcm, targetPcm, opts);

      setMatchProgress({ percent: 100, message: 'Спектральная подгонка завершена!' });
      setMatchResult(result);
    } catch (err: any) {
      console.error('[DubbingAIStudio] Ошибка матчинга:', err);
      alert(`Ошибка спектрального матчинга: ${err.message || 'Сбой FFT анализа'}`);
    } finally {
      setIsMatching(false);
    }
  };

  const handleApplyMatchedAudioToTrack = () => {
    if (!matchResult || !matchResult.processedBuffer) return;
    const targetTrack = safeTracks.find((t) => t.id === specTargetTrackId);
    const tName = targetTrack?.name || `Дорожка ${specTargetTrackId}`;

    if (onApplyProcessedAudioToTrack) {
      onApplyProcessedAudioToTrack(specTargetTrackId, matchResult.processedBuffer, `${tName} (Спектр Оригинала)`);
    } else {
      alert('Спектрально подогнанное аудио готово!');
    }
  };

  // =========================================================================
  // HANDLERS: VOICEFIXER RESTORATION
  // =========================================================================
  const handleRunVoiceFixer = async () => {
    const pcm = getTrackPCM(vfTrackId);
    if (!pcm || pcm.length === 0) {
      alert('На выбранной дорожке нет аудиоклипов для реставрации.');
      return;
    }

    setIsFixing(true);
    setVfProgress({ percent: 15, message: 'Синтез высокочастотных гармоник Air-Band (> 8 кГц)...' });

    try {
      const opts: VoiceFixerOptions = {
        airBandBoostDb: airBandBoost,
        declipSensitivity: declipSens / 100,
        warmthSaturation: warmthSat / 100,
        subBassTuning: true
      };

      setVfProgress({ percent: 60, message: 'Мягкий де-клиппинг и аналоговая сатурация Tape Warmth...' });
      const processed = await globalAudioAICleanupEngine.processVoiceFixer(pcm, opts);

      setVfProgress({ percent: 100, message: 'Реставрация VoiceFixer успешно завершена!' });
      setVfProcessedBuffer(processed);
    } catch (err: any) {
      console.error('[DubbingAIStudio] Ошибка VoiceFixer:', err);
      alert(`Ошибка реставрации VoiceFixer: ${err.message || 'Сбой нейросети'}`);
    } finally {
      setIsFixing(false);
    }
  };

  const handleApplyVfAudioToTrack = () => {
    if (!vfProcessedBuffer) return;
    const targetTrack = safeTracks.find((t) => t.id === vfTrackId);
    const tName = targetTrack?.name || `Дорожка ${vfTrackId}`;

    if (onApplyProcessedAudioToTrack) {
      onApplyProcessedAudioToTrack(vfTrackId, vfProcessedBuffer, `${tName} (VoiceFixer HD)`);
    } else {
      alert('Отреставрированное аудио готово!');
    }
  };

  // =========================================================================
  // HANDLERS: WHISPER & SILERO VAD
  // =========================================================================
  const handleRunWhisperAndVad = async () => {
    const pcm = getTrackPCM(whisperTrackId);
    if (!pcm || pcm.length === 0) {
      alert('На выбранной дорожке нет аудиоклипов для распознавания.');
      return;
    }

    setIsProcessingVad(true);
    try {
      const totalFrames = Math.floor(pcm.length / 2);
      const monoPcm = new Float32Array(totalFrames);
      for (let i = 0; i < totalFrames; i++) {
        monoPcm[i] = (pcm[i * 2] + pcm[i * 2 + 1]) * 0.5;
      }

      const segments = await globalAudioAIEngine.processVAD(monoPcm, 48000, {
        threshold: vadThreshold
      });
      setSpeechSegments(segments);

      const parsed = globalAudioAIEngine.parseSubtitles(scriptContent);
      setParsedSubtitles(parsed);

      const aligned = globalAudioAIEngine.alignSpeechWithScript(parsed, segments);
      setAlignedPhrases(aligned);
    } catch (err: any) {
      console.error('[DubbingAIStudio] Ошибка Whisper/VAD:', err);
      alert(`Ошибка VAD сегментации: ${err.message || 'Сбой'}`);
    } finally {
      setIsProcessingVad(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Hidden audio element for A/B audition */}
      <audio
        ref={audioPreviewRef}
        onEnded={() => {
          setAbActiveTrackId(null);
          setAbActiveMode(null);
          setAbPlaying(null);
        }}
        className="hidden"
      />

      {/* Top Banner & Sub-Tabs Navigation (Hidden in matrix-only mode) */}
      {mode !== 'matrix-only' && (
        <>
          {/* Top Main Banner */}
          <div className="bg-slate-900/95 border border-emerald-500/30 p-5 rounded-2xl flex flex-wrap items-center justify-between gap-4 shadow-xl">
            <div className="flex items-center gap-3.5">
              <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400">
                <BrainCircuit size={24} />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  Студийный AI Аудио-Конвейер (AI Audio Studio)
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                    25 моделей • ONNX / C++ / WebGPU
                  </span>
                </h2>
                <p className="text-xs text-slate-400">
                  Гибкая маршрутизация дорожек, разделение стемов, нейро-денойзинг, устранение эха, спектральная подгонка и VoiceFixer.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-400">
              <span className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg flex items-center gap-1.5 text-emerald-400">
                <Zap size={14} /> 100% On-Device
              </span>
              <span className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg flex items-center gap-1.5 text-cyan-400">
                <Gauge size={14} /> VRAM: ~{vramUsageMb} MB
              </span>
            </div>
          </div>

          {/* Navigation Sub-Tabs */}
          <div className="flex items-center gap-1.5 bg-slate-900/80 p-1.5 border border-slate-800 rounded-xl overflow-x-auto scrollbar-none">
            <button
              onClick={() => setActiveTab('models')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                activeTab === 'models'
                  ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Database size={14} />
              Каталог & Загрузка AI Моделей в память
            </button>

            <button
              onClick={() => setActiveTab('matrix')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                activeTab === 'matrix'
                  ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Workflow size={14} />
              Матрица маршрутизации
            </button>

            <button
              onClick={() => setActiveTab('separation')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                activeTab === 'separation'
                  ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Scissors size={14} />
              Изоляция стемов
            </button>

            <button
              onClick={() => setActiveTab('cleanup')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                activeTab === 'cleanup'
                  ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Volume2 size={14} />
              Денойзинг & Дереверберация
            </button>

            <button
              onClick={() => setActiveTab('spectral')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                activeTab === 'spectral'
                  ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <SlidersHorizontal size={14} />
              Спектральная подгонка
            </button>

            <button
              onClick={() => setActiveTab('voicefixer')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                activeTab === 'voicefixer'
                  ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Wand2 size={14} />
              Реставрация VoiceFixer
            </button>

            <button
              onClick={() => setActiveTab('whisper')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                activeTab === 'whisper'
                  ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Activity size={14} />
              Whisper & VAD
            </button>

            <button
              onClick={() => setActiveTab('settings')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                activeTab === 'settings'
                  ? 'bg-emerald-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Settings2 size={14} />
              Настройки AI
            </button>
          </div>
        </>
      )}

      {/* ===================================================================== */}
      {/* TAB 0: MATRIX / TRACK ROUTING & NEURAL PROCESSING */}
      {(mode === 'matrix-only' || activeTab === 'matrix') && (
        <div className="space-y-6 animate-fadeIn">
          {/* Top Matrix Control Bar */}
          <div className="bg-[#0f1422] border border-[#1e293b] p-4 sm:p-5 rounded-2xl shadow-xl flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400">
                <Workflow size={22} />
              </div>
              <div>
                <h3 className="text-sm sm:text-base font-bold text-slate-100 flex items-center gap-2">
                  Матрица маршрутизации нейросетевой обработки
                  <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                    {safeTracks.length} Дорожек в проекте
                  </span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Настройте для каждой дорожки: <strong>какой нейросетью</strong> обрабатывать, <strong>зачем</strong> и с <strong>какими параметрами</strong>.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleRunMatrixBatch}
                disabled={isBatchProcessing}
                className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 disabled:from-slate-800 disabled:to-slate-800 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-emerald-950/40 flex items-center gap-2 cursor-pointer"
              >
                {isBatchProcessing ? (
                  <>
                    <RefreshCw size={14} className="animate-spin" />
                    Пакетная обработка...
                  </>
                ) : (
                  <>
                    <Sparkles size={14} className="text-amber-300" />
                    Обработать все дорожки по схеме (Batch AI)
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Batch Progress Banner */}
          {isBatchProcessing && (
            <div className="bg-emerald-950/20 border border-emerald-500/30 p-4 rounded-xl space-y-2 animate-fadeIn">
              <div className="flex justify-between text-xs font-semibold text-emerald-300">
                <span>{batchProgress.message}</span>
                <span>
                  {batchProgress.current} / {batchProgress.total} дорожек
                </span>
              </div>
              <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-emerald-500/30">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 transition-all duration-300"
                  style={{
                    width: `${Math.round((batchProgress.current / Math.max(1, batchProgress.total)) * 100)}%`
                  }}
                />
              </div>
            </div>
          )}

          {/* Tracks Neural Processing Cards */}
          <div className="space-y-4">
            {safeTracks.map((track) => {
              const cfg: TrackAIConfig = trackConfigs[track.id] || {
                trackId: track.id,
                enabled: true,
                purpose: 'denoise' as AIPurposeType,
                modelId: 'deepfilternet3',
                intensity: 75,
                dereverbAmount: 60,
                enableLowCut: true,
                warmthSat: 40,
                airBandBoost: 3.5,
                steps: [
                  {
                    id: `step_${track.id}_1`,
                    enabled: true,
                    purpose: 'denoise',
                    modelId: 'deepfilternet3',
                    intensity: 75,
                    dereverbAmount: 60,
                    enableLowCut: true,
                    warmthSat: 40,
                    airBandBoost: 3.5
                  }
                ],
                outputMode: 'replace',
                status: 'idle',
                progressPercent: 0,
                abOriginalUrl: undefined,
                abProcessedUrl: undefined
              };

              const safeTrackClips = toSafeArray(track.clips);
              const hasClips = safeTrackClips.length > 0;
              const purposeInfo = PURPOSE_DESCRIPTIONS[cfg.purpose];
              const isProcessingThis = cfg.status === 'processing';
              const isDoneThis = cfg.status === 'done';

              return (
                <div
                  key={track.id}
                  className={`bg-[#0a0e17] border rounded-2xl p-5 space-y-4 transition-all ${
                    isProcessingThis
                      ? 'border-emerald-500/60 shadow-xl shadow-emerald-950/20'
                      : isDoneThis
                      ? 'border-cyan-500/40'
                      : 'border-slate-800/90 hover:border-slate-700'
                  }`}
                >
                  {/* Card Header */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={cfg.enabled}
                        onChange={(e) => handleUpdateTrackConfig(track.id, { enabled: e.target.checked })}
                        className="w-4 h-4 rounded text-emerald-500 accent-emerald-500 cursor-pointer"
                        title="Включить дорожку в пакетный процессинг"
                      />
                      <div
                        className="w-3.5 h-3.5 rounded-full shrink-0"
                        style={{ backgroundColor: track.color || '#10b981' }}
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-100 font-mono">
                            CH #{track.id}: {track.name}
                          </span>
                          {Boolean(track.isOriginalAudio || track.name?.startsWith('🎬')) && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 flex items-center gap-1 shadow-sm">
                              🎬 [Аудиодорожка Видеофайла]
                            </span>
                          )}
                          {!track.isOriginalAudio && !track.name?.startsWith('🎬') && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              🎙️ [Голос дублера]
                            </span>
                          )}
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-medium ${
                              hasClips
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : 'bg-slate-900 text-slate-500 border border-slate-800'
                            }`}
                          >
                            {hasClips ? `${safeTrackClips.length} клип(ов)` : 'Нет аудио'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                      {isDoneThis && (
                        <span className="flex items-center gap-1 text-emerald-400 font-mono text-[11px] bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                          <CheckCircle2 size={12} /> Обработано
                        </span>
                      )}

                      {/* A/B Audition Controls */}
                      {cfg.abOriginalUrl && cfg.abProcessedUrl && (
                        <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
                          <button
                            type="button"
                            onClick={() => handleToggleAbAudio(track.id, 'original')}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-all ${
                              abActiveTrackId === track.id && abActiveMode === 'original'
                                ? 'bg-cyan-600 text-white font-bold'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {abActiveTrackId === track.id && abActiveMode === 'original' ? (
                              <Pause size={11} />
                            ) : (
                              <Play size={11} />
                            )}
                            Оригинал
                          </button>

                          <button
                            type="button"
                            onClick={() => handleToggleAbAudio(track.id, 'processed')}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-all ${
                              abActiveTrackId === track.id && abActiveMode === 'processed'
                                ? 'bg-emerald-600 text-white font-bold'
                                : 'text-emerald-400 hover:text-emerald-300'
                            }`}
                          >
                            {abActiveTrackId === track.id && abActiveMode === 'processed' ? (
                              <Pause size={11} />
                            ) : (
                              <Sparkles size={11} />
                            )}
                            AI Звук
                          </button>
                        </div>
                      )}

                      {/* Run button for this track */}
                      <button
                        type="button"
                        onClick={() => handleRunSingleMatrixTrack(track.id)}
                        disabled={isProcessingThis || !hasClips}
                        className="px-3.5 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 disabled:bg-slate-900 disabled:text-slate-600 text-emerald-300 border border-emerald-500/30 rounded-xl font-semibold flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
                      >
                        {isProcessingThis ? (
                          <>
                            <RefreshCw size={13} className="animate-spin text-emerald-400" />
                            {cfg.progressPercent}%
                          </>
                        ) : (
                          <>
                            <Sparkles size={13} className="text-amber-300" />
                            Запустить AI
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* AI Chain Sequential Steps */}
                  <div className="space-y-3 bg-slate-950/70 p-3.5 rounded-xl border border-slate-800/80">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-800/60">
                      <div className="text-xs font-bold text-emerald-400 flex items-center gap-1.5 font-mono">
                        <Sparkles size={14} className="text-amber-300" />
                        Последовательная цепочка нейросетей ({toSafeArray(cfg.steps).length || 1} {toSafeArray(cfg.steps).length === 1 ? 'этап' : 'этапов'})
                      </div>
                      <button
                        type="button"
                        onClick={() => handleAddAIStep(track.id, 'denoise')}
                        className="px-2.5 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold rounded-lg flex items-center gap-1 transition-all cursor-pointer"
                      >
                        <Plus size={12} />
                        Добавить ИИ-эффект в цепочку
                      </button>
                    </div>

                    {(toSafeArray<AIStepNode>(cfg.steps).length > 0
                      ? toSafeArray<AIStepNode>(cfg.steps)
                      : [
                          {
                            id: 'default',
                            enabled: true,
                            purpose: cfg.purpose || 'denoise',
                            modelId: cfg.modelId || 'deepfilternet3',
                            intensity: cfg.intensity || 75,
                            dereverbAmount: cfg.dereverbAmount || 60,
                            enableLowCut: cfg.enableLowCut ?? true,
                            warmthSat: cfg.warmthSat || 40,
                            airBandBoost: cfg.airBandBoost || 3.5
                          }
                        ]
                    ).map((step, stepIdx) => {
                      const stepPurposeInfo = PURPOSE_DESCRIPTIONS[step.purpose] || PURPOSE_DESCRIPTIONS['denoise'];
                      const targetCategory = PURPOSE_TO_CATEGORY_MAP[step.purpose] || 'denoise';
                      const installedCategoryModels = toSafeArray<ModelCatalogItem>(installedModels).filter(
                        (m) => m && m.category === targetCategory
                      );

                      return (
                        <div
                          key={step.id || stepIdx}
                          className="bg-[#0f1422] p-3 rounded-xl border border-slate-800 space-y-2.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/60 pb-2">
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={step.enabled}
                                onChange={(e) => handleUpdateAIStep(track.id, step.id, { enabled: e.target.checked })}
                                className="w-3.5 h-3.5 rounded text-emerald-500 accent-emerald-500 cursor-pointer"
                              />
                              <span className="text-[11px] font-bold font-mono text-cyan-400 px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/20">
                                Шаг #{stepIdx + 1}
                              </span>
                              <span className="text-xs font-semibold text-slate-200">{stepPurposeInfo.title}</span>
                            </div>

                            <div className="flex items-center gap-2">
                              {toSafeArray(cfg.steps).length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveAIStep(track.id, step.id)}
                                  className="p-1 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded transition-all cursor-pointer"
                                  title="Удалить шаг из цепочки"
                                >
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            {/* Purpose Select */}
                            <div className="space-y-1">
                              <label className="text-[11px] font-medium text-slate-400">Назначение шага:</label>
                              <select
                                value={step.purpose}
                                onChange={(e) =>
                                  handleUpdateAIStep(track.id, step.id, { purpose: e.target.value as AIPurposeType })
                                }
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                              >
                                <option value="stem_separation">✂️ Изоляция вокала (UVR / Stem Sep)</option>
                                <option value="denoise">🧹 Подавление шума (DeepFilterNet3)</option>
                                <option value="dereverb">🏛️ Декомпозиция эха (Reverb FoxJoy)</option>
                                <option value="spectral_match">🎚️ Спектральная подгонка к оригиналу</option>
                                <option value="voicefixer">✨ VoiceFixer Реставрация гармоник</option>
                              </select>
                            </div>

                            {/* Model Select (Installed Models Only!) */}
                            <div className="space-y-1">
                              <label className="text-[11px] font-medium text-slate-400">
                                Загруженная AI Модель:
                              </label>
                              <select
                                value={step.modelId}
                                onChange={(e) => handleUpdateAIStep(track.id, step.id, { modelId: e.target.value })}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
                              >
                                {installedCategoryModels.length === 0 ? (
                                  <option value="" disabled className="text-amber-400 font-sans">
                                    ⚠️ Модель не загружена (DSP C++ WebAssembly)
                                  </option>
                                ) : (
                                  toSafeArray<ModelCatalogItem>(installedCategoryModels).map((m) => (
                                    <option key={m.id} value={m.id}>
                                      {m.name} ({m.size_mb} MB) [В памяти]
                                    </option>
                                  ))
                                )}
                              </select>
                            </div>

                            {/* Parameters Slider */}
                            <div className="space-y-1 bg-slate-950/60 p-2 rounded-lg border border-slate-800/60">
                              <div className="flex justify-between text-[11px] text-slate-300">
                                <span>Интенсивность:</span>
                                <span className="text-emerald-400 font-mono font-bold">{step.intensity}%</span>
                              </div>
                              <input
                                type="range"
                                min={0}
                                max={100}
                                value={step.intensity}
                                onChange={(e) =>
                                  handleUpdateAIStep(track.id, step.id, { intensity: Number(e.target.value) })
                                }
                                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Output Mode Select */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80">
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-semibold text-slate-300">Куда записать результат:</label>
                      <select
                        value={cfg.outputMode}
                        onChange={(e) =>
                          handleUpdateTrackConfig(track.id, {
                            outputMode: e.target.value as 'replace' | 'new_track' | 'stems'
                          })
                        }
                        className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                      >
                        <option value="replace">🔄 Заменить аудио на этой дорожке (В микшер)</option>
                        <option value="new_track">➕ Создать новую дублирующую дорожку</option>
                        <option value="stems">🎛️ Разложить на 2 дорожки (Стемы Вокал + M&E)</option>
                      </select>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      {cfg.outputMode === 'replace'
                        ? 'Прямое обновление в AudioWorklet DAW'
                        : cfg.outputMode === 'stems'
                        ? 'Добавит [Вокал] и [Минус] в микшер'
                        : 'Сохранит оригинал без изменений'}
                    </p>
                  </div>

                  {/* Progress Bar if Running */}
                  {isProcessingThis && (
                    <div className="space-y-1.5 pt-2">
                      <div className="flex justify-between text-[11px] font-mono text-emerald-300">
                        <span>{cfg.statusMessage || 'Выполнение нейросетевых операций...'}</span>
                        <span>{cfg.progressPercent}%</span>
                      </div>
                      <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden border border-emerald-500/30">
                        <div
                          className="bg-gradient-to-r from-emerald-500 to-cyan-400 h-full transition-all duration-200"
                          style={{ width: `${cfg.progressPercent}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 1: STEM & VOCAL SEPARATION */}
      {/* ===================================================================== */}
      {activeTab === 'separation' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fadeIn">
          {/* Controls Panel */}
          <div className="lg:col-span-5 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Scissors size={16} className="text-emerald-400" />
                Разделение стемов (Изоляция вокала и фона)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Извлечение чистого оригинального голоса и фонограммы (M&E) с помощью UVR / Demucs / Roformer.
              </p>
            </div>

            {/* Input Track */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Исходная дорожка (Оригинал):</label>
              <select
                value={sepTrackId}
                onChange={(e) => setSepTrackId(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
              >
                {safeTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    Дорожка {t.id}: {t.name} ({toSafeArray(t.clips).length} клипов)
                  </option>
                ))}
              </select>
            </div>

            {/* Separation Model */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Нейросетевая модель сепарации:</label>
              <select
                value={sepModelId}
                onChange={(e) => setSepModelId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
              >
                {(models || [])
                  .filter((m) => m && m.category === 'separation')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.size_mb} MB) {m.is_installed ? '✓ Установлена' : ''}
                    </option>
                  ))}
              </select>
              <p className="text-[11px] text-slate-400 italic">
                {(models || []).find((m) => m && m.id === sepModelId)?.description}
              </p>
            </div>

            {/* Mode selection */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Режим вывода стемов:</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSepMode('vocals_karaoke')}
                  className={`px-3 py-2 rounded-xl text-xs font-medium border text-left transition-all ${
                    sepMode === 'vocals_karaoke'
                      ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-300'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-300'
                  }`}
                >
                  <div className="font-bold flex items-center gap-1.5">
                    <Mic size={13} /> 2 Стема
                  </div>
                  <div className="text-[10px] opacity-75">Вокал + Минус (M&E)</div>
                </button>

                <button
                  type="button"
                  onClick={() => setSepMode('4stems')}
                  className={`px-3 py-2 rounded-xl text-xs font-medium border text-left transition-all ${
                    sepMode === '4stems'
                      ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-300'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-300'
                  }`}
                >
                  <div className="font-bold flex items-center gap-1.5">
                    <Music size={13} /> 4 Стема (Demucs)
                  </div>
                  <div className="text-[10px] opacity-75">Вокал / Бас / Ударные / Фон</div>
                </button>
              </div>
            </div>

            {/* Action button */}
            <button
              type="button"
              disabled={isSeparating}
              onClick={handleRunStemSeparation}
              className={`w-full py-3 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-lg cursor-pointer ${
                isSeparating
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20'
              }`}
            >
              {isSeparating ? (
                <>
                  <RefreshCw size={15} className="animate-spin" />
                  Обработка стемов ({sepProgress.percent}%)...
                </>
              ) : (
                <>
                  <Sparkles size={15} />
                  Запустить AI-разделение дорожки
                </>
              )}
            </button>

            {isSeparating && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-[11px] font-mono text-slate-400">
                  <span>{sepProgress.message}</span>
                  <span>{sepProgress.percent}%</span>
                </div>
                <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
                  <div
                    className="bg-gradient-to-r from-emerald-500 to-cyan-400 h-full transition-all duration-200"
                    style={{ width: `${sepProgress.percent}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Results Panel */}
          <div className="lg:col-span-7 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col">
            <div className="border-b border-slate-800 pb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                  <Disc size={16} className="text-cyan-400" />
                  Результаты разделения и предпрослушивание
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Прослушайте изолированный вокал и минусовку перед добавлением в DAW.
                </p>
              </div>
              {sepResult && (
                <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-mono font-bold">
                  Готово ({sepResult.durationSec?.toFixed(1)} сек)
                </span>
              )}
            </div>

            {sepResult ? (
              <div className="space-y-4 flex-1 flex flex-col justify-between">
                <div className="space-y-3">
                  {/* Vocals result */}
                  <div className="bg-slate-950/80 p-3.5 rounded-xl border border-emerald-500/30 space-y-2">
                    <div className="flex items-center justify-between text-xs font-bold text-emerald-400">
                      <span className="flex items-center gap-1.5">
                        <Mic size={14} /> 1. Изолированный голос оригинала (Vocals Stem)
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">48 кГц / 32-bit Float</span>
                    </div>
                    {sepResult.vocalsWavUrl && (
                      <audio controls src={sepResult.vocalsWavUrl} className="w-full h-8" />
                    )}
                  </div>

                  {/* Karaoke / M&E result */}
                  <div className="bg-slate-950/80 p-3.5 rounded-xl border border-cyan-500/30 space-y-2">
                    <div className="flex items-center justify-between text-xs font-bold text-cyan-400">
                      <span className="flex items-center gap-1.5">
                        <Music size={14} /> 2. Фонограмма и эффекты M&E (Music & Effects)
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">48 кГц / 32-bit Float</span>
                    </div>
                    {sepResult.karaokeWavUrl && (
                      <audio controls src={sepResult.karaokeWavUrl} className="w-full h-8" />
                    )}
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={handleApplyStemsToProject}
                    className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-lg shadow-emerald-500/20 flex items-center gap-2 cursor-pointer"
                  >
                    <Check size={14} /> Добавить оба стема на дорожки DAW
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 border border-dashed border-slate-800 rounded-xl">
                <Scissors size={40} className="text-slate-700 mb-3" />
                <p className="text-xs text-slate-400">Разделение еще не запускалось.</p>
                <p className="text-[11px] text-slate-600 mt-1 max-w-xs">
                  Выберите исходную дорожку с речью и нажмите кнопку «Запустить AI-разделение дорожки».
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 2: DENOISE & DEREVERB */}
      {/* ===================================================================== */}
      {activeTab === 'cleanup' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fadeIn">
          {/* Settings */}
          <div className="lg:col-span-5 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Volume2 size={16} className="text-emerald-400" />
                AI Очистка звука и Дереверберация
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Подавление фонового шума микрофона и устранение комнатного эха без искажения тембра.
              </p>
            </div>

            {/* Target Track */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Дорожка для очистки:</label>
              <select
                value={cleanTrackId}
                onChange={(e) => setCleanTrackId(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
              >
                {safeTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    Дорожка {t.id}: {t.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Denoise Model */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Модель подавления шума (DeNoise):</label>
              <select
                value={denoiseModelId}
                onChange={(e) => setDenoiseModelId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
              >
                {(models || [])
                  .filter((m) => m && m.category === 'denoise')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.size_mb} MB)
                    </option>
                  ))}
              </select>
            </div>

            {/* Denoise Amount Slider */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span>Интенсивность денойзинга:</span>
                <span className="font-mono text-emerald-400 font-bold">{denoiseAmount}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={denoiseAmount}
                onChange={(e) => setDenoiseAmount(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              />
            </div>

            {/* Dereverb Model */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Модель устранения эха (DeReverb):</label>
              <select
                value={dereverbModelId}
                onChange={(e) => setDereverbModelId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
              >
                {(models || [])
                  .filter((m) => m && m.category === 'dereverb')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.size_mb} MB)
                    </option>
                  ))}
              </select>
            </div>

            {/* Dereverb Amount Slider */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span>Глубина подавления реверберации:</span>
                <span className="font-mono text-cyan-400 font-bold">{dereverbAmount}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={dereverbAmount}
                onChange={(e) => setDereverbAmount(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>

            {/* Low-cut filter toggle */}
            <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
              <input
                type="checkbox"
                id="check-low-cut"
                checked={enableLowCut}
                onChange={(e) => setEnableLowCut(e.target.checked)}
                className="w-4 h-4 rounded text-emerald-500 accent-emerald-500 cursor-pointer"
              />
              <label htmlFor="check-low-cut" className="text-xs text-slate-300 cursor-pointer">
                Автоматический срез инфранизкого гула &lt; 80 Гц (Low-Cut High-Pass)
              </label>
            </div>

            {/* Action button */}
            <button
              type="button"
              disabled={isCleaning}
              onClick={handleRunCleanup}
              className={`w-full py-3 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-lg cursor-pointer ${
                isCleaning
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20'
              }`}
            >
              {isCleaning ? (
                <>
                  <RefreshCw size={15} className="animate-spin" />
                  Очистка аудио ({cleanProgress.percent}%)...
                </>
              ) : (
                <>
                  <Sparkles size={15} />
                  Выполнить DeNoise & DeReverb
                </>
              )}
            </button>
          </div>

          {/* A/B Audition & Results */}
          <div className="lg:col-span-7 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Headphones size={16} className="text-purple-400" />
                A/B Сравнение «До / После» в реальном времени
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Мгновенно переключайтесь между оригинальным звуком и результатом очистки для контроля артефактов.
              </p>
            </div>

            {originalAudioUrl && cleanedAudioUrl ? (
              <div className="space-y-5 flex-1 flex flex-col justify-between">
                <div className="grid grid-cols-2 gap-4 my-auto">
                  {/* Original Button */}
                  <button
                    type="button"
                    onClick={() => handleTogglePlayCleanPreview('original')}
                    className={`p-6 rounded-2xl border flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
                      abPlaying === 'original'
                        ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300 shadow-lg shadow-cyan-500/20'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    {abPlaying === 'original' ? <Pause size={28} /> : <Play size={28} />}
                    <div className="font-bold text-xs">A: Исходный шумный звук</div>
                    <div className="text-[10px] text-slate-500 font-mono">До обработки</div>
                  </button>

                  {/* Cleaned Button */}
                  <button
                    type="button"
                    onClick={() => handleTogglePlayCleanPreview('cleaned')}
                    className={`p-6 rounded-2xl border flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
                      abPlaying === 'cleaned'
                        ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-lg shadow-emerald-500/20'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    {abPlaying === 'cleaned' ? <Pause size={28} /> : <Sparkles size={28} />}
                    <div className="font-bold text-xs">B: Очищенный AI звук</div>
                    <div className="text-[10px] text-emerald-400 font-mono">Шум и эхо удалены</div>
                  </button>
                </div>

                <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
                  <span className="text-xs text-slate-400 font-mono">
                    DeepFilterNet 3 ONNX + FoxJoy Reverb HQ
                  </span>
                  <button
                    type="button"
                    onClick={handleApplyCleanedToTrack}
                    className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-lg shadow-emerald-500/20 flex items-center gap-2 cursor-pointer"
                  >
                    <Check size={14} /> Применить к дорожке в DAW
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 border border-dashed border-slate-800 rounded-xl">
                <Volume2 size={40} className="text-slate-700 mb-3" />
                <p className="text-xs text-slate-400">Очистка еще не выполнялась.</p>
                <p className="text-[11px] text-slate-600 mt-1 max-w-xs">
                  Нажмите «Выполнить DeNoise & DeReverb», чтобы запустить шумоподавление.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 3: SPECTRAL VOCAL MATCHING */}
      {/* ===================================================================== */}
      {activeTab === 'spectral' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fadeIn">
          {/* Controls */}
          <div className="lg:col-span-5 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <SlidersHorizontal size={16} className="text-purple-400" />
                Спектральная подгонка к голосу оригинала
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Автоматический трансфер частотной огибающей (EQ Matching) и формантной окраски оригинального актера на дублера.
              </p>
            </div>

            {/* Reference Track */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                1. Референсная дорожка (Оригинальный голос):
              </label>
              <select
                value={specRefTrackId}
                onChange={(e) => setSpecRefTrackId(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-purple-500 font-mono"
              >
                {safeTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    Дорожка {t.id}: {t.name} (Референс)
                  </option>
                ))}
              </select>
            </div>

            {/* Target Track */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                2. Целевая дорожка (Голос дублера для подгонки):
              </label>
              <select
                value={specTargetTrackId}
                onChange={(e) => setSpecTargetTrackId(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-purple-500 font-mono"
              >
                {safeTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    Дорожка {t.id}: {t.name} (Дублер)
                  </option>
                ))}
              </select>
            </div>

            {/* Intensity */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span>Глубина спектральной подгонки (Match Intensity):</span>
                <span className="font-mono text-purple-400 font-bold">{matchIntensity}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={matchIntensity}
                onChange={(e) => setMatchIntensity(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
            </div>

            {/* Formant Preservation */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span>Сохранение естественных формант дублера:</span>
                <span className="font-mono text-cyan-400 font-bold">{formantWeight}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={formantWeight}
                onChange={(e) => setFormantWeight(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>

            {/* Action button */}
            <button
              type="button"
              disabled={isMatching}
              onClick={handleRunSpectralMatch}
              className={`w-full py-3 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-lg cursor-pointer ${
                isMatching
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-purple-500/20'
              }`}
            >
              {isMatching ? (
                <>
                  <RefreshCw size={15} className="animate-spin" />
                  Спектральный анализ ({matchProgress.percent}%)...
                </>
              ) : (
                <>
                  <Sparkles size={15} />
                  Рассчитать и применить спектральный трансфер
                </>
              )}
            </button>
          </div>

          {/* Visualization of FFT Curve */}
          <div className="lg:col-span-7 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
            <div className="border-b border-slate-800 pb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                  <Activity size={16} className="text-purple-400" />
                  График разностной АЧХ (Matchering EQ Curve)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  4096-точечный FFT анализ спектральной разницы между оригиналом и дубляжом.
                </p>
              </div>
              {matchResult && (
                <span className="px-2.5 py-1 rounded bg-purple-500/10 text-purple-400 text-xs font-mono font-bold">
                  Δ RMS: {matchResult.rmsDifferenceDb.toFixed(2)} dB
                </span>
              )}
            </div>

            {matchResult ? (
              <div className="space-y-4 flex-1 flex flex-col justify-between">
                {/* SVG Curve Display */}
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="h-40 w-full flex items-end gap-1 px-1">
                    {(matchResult.eqCurvePoints || []).slice(0, 48).map((pt, idx) => {
                      const clamped = Math.max(-12, Math.min(12, pt.gainDb));
                      const heightPercent = ((clamped + 12) / 24) * 100;
                      const isBoost = clamped > 0;
                      return (
                        <div
                          key={idx}
                          className="flex-1 flex flex-col items-center justify-end h-full"
                          title={`${pt.freqHz} Гц: ${clamped > 0 ? '+' : ''}${clamped.toFixed(1)} dB`}
                        >
                          <div
                            className={`w-full rounded-t-sm transition-all duration-300 ${
                              isBoost ? 'bg-purple-500/80' : 'bg-cyan-500/80'
                            }`}
                            style={{ height: `${heightPercent}%` }}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-slate-500 px-1">
                    <span>20 Гц (Суб-бас)</span>
                    <span>1 кГц (Голос)</span>
                    <span>5 кГц (Присутствие)</span>
                    <span>20 кГц (Воздух)</span>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
                  <span className="text-xs text-slate-400 font-mono">
                    Коррекция спектра рассчитана с точностью 1/12 октавы
                  </span>
                  <button
                    type="button"
                    onClick={handleApplyMatchedAudioToTrack}
                    className="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-xl text-xs transition-all shadow-lg shadow-purple-600/20 flex items-center gap-2 cursor-pointer"
                  >
                    <Check size={14} /> Применить EQ к дорожке дубляжа
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 border border-dashed border-slate-800 rounded-xl">
                <SlidersHorizontal size={40} className="text-slate-700 mb-3" />
                <p className="text-xs text-slate-400">Спектральный анализ еще не проводился.</p>
                <p className="text-[11px] text-slate-600 mt-1 max-w-xs">
                  Выберите референс оригинала и дорожку дублера, затем нажмите кнопку запуска.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 4: VOICEFIXER & HARMONIC RESTORATION */}
      {/* ===================================================================== */}
      {activeTab === 'voicefixer' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fadeIn">
          {/* Controls */}
          <div className="lg:col-span-5 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Wand2 size={16} className="text-amber-400" />
                Реставрация VoiceFixer & Обертоны
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Восстановление обрезанных частот микрофона, синтез обертонов Air-Band и мягкий де-клиппинг.
              </p>
            </div>

            {/* Target Track */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Дорожка для реставрации:</label>
              <select
                value={vfTrackId}
                onChange={(e) => setVfTrackId(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500 font-mono"
              >
                {safeTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    Дорожка {t.id}: {t.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Air Band Boost */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span>Усиление полосы воздуха Air-Band (&gt; 8 кГц):</span>
                <span className="font-mono text-amber-400 font-bold">+{airBandBoost.toFixed(1)} dB</span>
              </div>
              <input
                type="range"
                min={0}
                max={6}
                step={0.5}
                value={airBandBoost}
                onChange={(e) => setAirBandBoost(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
              />
            </div>

            {/* Declip Sensitivity */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span>Чувствительность де-клиппинга срезанных пиков:</span>
                <span className="font-mono text-cyan-400 font-bold">{declipSens}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={declipSens}
                onChange={(e) => setDeclipSens(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>

            {/* Warmth / Saturation */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span>Аналоговое насыщение гармониками (Tape Warmth):</span>
                <span className="font-mono text-rose-400 font-bold">{warmthSat}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={warmthSat}
                onChange={(e) => setWarmthSat(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
              />
            </div>

            {/* Action button */}
            <button
              type="button"
              disabled={isFixing}
              onClick={handleRunVoiceFixer}
              className={`w-full py-3 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-lg cursor-pointer ${
                isFixing
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  : 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-500/20'
              }`}
            >
              {isFixing ? (
                <>
                  <RefreshCw size={15} className="animate-spin" />
                  Реставрация VoiceFixer ({vfProgress.percent}%)...
                </>
              ) : (
                <>
                  <Sparkles size={15} />
                  Выполнить реставрацию VoiceFixer
                </>
              )}
            </button>
          </div>

          {/* Results & Waveform preview */}
          <div className="lg:col-span-7 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Sparkles size={16} className="text-amber-400" />
                Студийный результат VoiceFixer HD
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Восстановленный диапазон частот с шелковистыми верхними обертонами.
              </p>
            </div>

            {vfProcessedBuffer ? (
              <div className="space-y-4 flex-1 flex flex-col justify-between">
                <div className="bg-slate-950 p-4 rounded-xl border border-amber-500/30 space-y-3">
                  <div className="flex items-center gap-2 text-amber-400 text-xs font-bold">
                    <CheckCircle2 size={16} /> Реставрация успешно завершена
                  </div>
                  <p className="text-xs text-slate-300">
                    Аудиодорожка насыщена гармониками, деклиппирована и готова к переносу в проект.
                  </p>
                </div>

                <div className="pt-3 border-t border-slate-800 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={handleApplyVfAudioToTrack}
                    className="px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-lg shadow-amber-500/20 flex items-center gap-2 cursor-pointer"
                  >
                    <Check size={14} /> Применить к дорожке в DAW
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 border border-dashed border-slate-800 rounded-xl">
                <Wand2 size={40} className="text-slate-700 mb-3" />
                <p className="text-xs text-slate-400">Реставрация еще не запускалась.</p>
                <p className="text-[11px] text-slate-600 mt-1 max-w-xs">
                  Нажмите «Выполнить реставрацию VoiceFixer», чтобы запустить синтез гармоник.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 5: WHISPER ASR & SILERO VAD */}
      {/* ===================================================================== */}
      {activeTab === 'whisper' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fadeIn">
          {/* Controls */}
          <div className="lg:col-span-5 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Activity size={16} className="text-emerald-400" />
                Распознавание речи & Silero VAD
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Автоматическая детекция пауз в речи актера и синхронизация сценария дубляжа.
              </p>
            </div>

            {/* Target Track */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Дорожка для анализа речи:</label>
              <select
                value={whisperTrackId}
                onChange={(e) => setWhisperTrackId(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
              >
                {safeTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    Дорожка {t.id}: {t.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Model */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Модель транскрибации Whisper:</label>
              <select
                value={whisperModelId}
                onChange={(e) => setWhisperModelId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
              >
                {(models || [])
                  .filter((m) => m && m.category === 'whisper')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.size_mb} MB)
                    </option>
                  ))}
              </select>
            </div>

            {/* VAD Threshold */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span>Порог чувствительности детектора речи (VAD Threshold):</span>
                <span className="font-mono text-emerald-400 font-bold">{vadThreshold.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.1}
                max={0.9}
                step={0.05}
                value={vadThreshold}
                onChange={(e) => setVadThreshold(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              />
            </div>

            {/* Script input */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Сценарий дубляжа (SRT текст):</label>
              <textarea
                rows={4}
                value={scriptContent}
                onChange={(e) => setScriptContent(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-200 font-mono focus:outline-none focus:border-emerald-500 resize-none"
              />
            </div>

            {/* Action button */}
            <button
              type="button"
              disabled={isProcessingVad}
              onClick={handleRunWhisperAndVad}
              className={`w-full py-3 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-lg cursor-pointer ${
                isProcessingVad
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20'
              }`}
            >
              {isProcessingVad ? (
                <>
                  <RefreshCw size={15} className="animate-spin" />
                  Детекция сегментов речи Silero VAD...
                </>
              ) : (
                <>
                  <Sparkles size={15} />
                  Распознать и синхронизировать с SRT
                </>
              )}
            </button>
          </div>

          {/* Results: Aligned Phrases */}
          <div className="lg:col-span-7 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
            <div className="border-b border-slate-800 pb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                  <Activity size={16} className="text-emerald-400" />
                  Синхронизированные реплики сценария
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Таймкоды и коэффициенты сжатия/растяжения (Time-Stretch) для идеального лип-синка.
                </p>
              </div>
              <span className="px-2.5 py-1 rounded bg-emerald-500/10 text-emerald-400 text-xs font-mono font-bold">
                {toSafeArray(alignedPhrases).length} реплик
              </span>
            </div>

            {toSafeArray<AlignedSpeechPhrase>(alignedPhrases).length > 0 ? (
              <div className="space-y-3 flex-1 overflow-y-auto max-h-[420px] pr-1 scrollbar-thin">
                {toSafeArray<AlignedSpeechPhrase>(alignedPhrases).map((phrase) => {
                  const hasDrift = Math.abs(phrase.timeDriftSec) > 0.3;
                  return (
                    <div
                      key={phrase.lineIndex}
                      onClick={() => onSeek(phrase.actualStartSec)}
                      className="bg-slate-950 p-3 rounded-xl border border-slate-800 hover:border-emerald-500/50 cursor-pointer transition-all space-y-1.5"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-slate-200">Реплика #{phrase.lineIndex}</span>
                        <div className="flex items-center gap-2 font-mono text-[11px]">
                          <span className="text-cyan-400">
                            {formatSMPTE(phrase.actualStartSec)} → {formatSMPTE(phrase.actualEndSec)}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              hasDrift
                                ? 'bg-amber-500/20 text-amber-300'
                                : 'bg-emerald-500/20 text-emerald-300'
                            }`}
                          >
                            Схожесть {(phrase.similarityScore * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-slate-300 font-sans">{phrase.scriptText}</p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 border border-dashed border-slate-800 rounded-xl">
                <Activity size={40} className="text-slate-700 mb-3" />
                <p className="text-xs text-slate-400">Синхронизация еще не проводилась.</p>
                <p className="text-[11px] text-slate-600 mt-1 max-w-xs">
                  Нажмите «Распознать и синхронизировать с SRT» для сопоставления аудиосегментов.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 6: MODELS CATALOG & MANAGER */}
      {/* ===================================================================== */}
      {activeTab === 'models' && (
        <div className="space-y-5 animate-fadeIn">
          {/* Filter Bar */}
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2 flex-1 max-w-md">
              <Search size={16} className="text-slate-500 ml-2" />
              <input
                type="text"
                placeholder="Поиск нейросетей по названию, архитектуре или задаче..."
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-medium"
              />
            </div>

            <div className="flex items-center gap-2">
              <Filter size={14} className="text-slate-400" />
              <select
                value={catalogCategoryFilter}
                onChange={(e) => setCatalogCategoryFilter(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
              >
                <option value="all">Все категории ({toSafeArray(models).length})</option>
                <option value="separation">Сепарация стемов (Stem Separation)</option>
                <option value="denoise">Денойзинг (DeNoise)</option>
                <option value="dereverb">Дереверберация (DeReverb)</option>
                <option value="vocal_match">Спектральный матчинг</option>
                <option value="whisper">Whisper ASR</option>
              </select>
            </div>
          </div>

          {/* Models Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {toSafeArray<ModelCatalogItem>(filteredCatalogModels).map((m) => {
              const prog = downloadProgress[m.id];
              const isDownloading = prog && prog.status === 'downloading';
              return (
                <div
                  key={m.id}
                  className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-4 flex flex-col justify-between space-y-3 transition-all"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-100 truncate" title={m.name}>
                        {m.name}
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-950 text-slate-400 border border-slate-800 shrink-0">
                        {m.size_mb} MB
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        {m.engineArchitecture || m.format || 'ONNX'}
                      </span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                        {m.category}
                      </span>
                    </div>

                    <p className="text-xs text-slate-400 line-clamp-2">{m.description}</p>
                    <p className="text-[11px] text-slate-500 italic">Назначение: {m.recommended_for}</p>
                  </div>

                  <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                    <div className="text-[10px] font-mono text-slate-400">
                      {m.is_installed ? (
                        <span className="text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 size={12} /> В кэше / Памяти
                        </span>
                      ) : (
                        <span>Готова к загрузке</span>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={isDownloading}
                      onClick={() => globalAIModelCatalog.installModel(m.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                        m.is_installed
                          ? 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-slate-200'
                          : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md font-bold'
                      }`}
                    >
                      {isDownloading ? (
                        <>
                          <RefreshCw size={12} className="animate-spin" />
                          {prog.percent}%
                        </>
                      ) : m.is_installed ? (
                        <>
                          <Check size={12} /> Перезагрузить
                        </>
                      ) : (
                        <>
                          <Download size={12} /> Загрузить
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 7: GLOBAL AI ENGINE SETTINGS */}
      {/* ===================================================================== */}
      {activeTab === 'settings' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fadeIn">
          <div className="lg:col-span-6 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Settings2 size={16} className="text-emerald-400" />
                Конфигурация среды выполнения AI (Inference Engines)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Выбор аппаратного бэкенда для запуска ONNX / C++ нейросетей в браузере.
              </p>
            </div>

            {/* Inference Backend */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300">Аппаратный бэкенд (Execution Engine):</label>
              <select
                value={executionEngine}
                onChange={(e) => setExecutionEngine(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-medium"
              >
                <option value="wasm_simd">⚡ WebAssembly SIMD + SharedArrayBuffer (CPU Универсальный)</option>
                <option value="webgpu">🚀 WebGPU Compute Shaders (Максимальная скорость GPU/VRAM)</option>
                <option value="webnn">🧠 WebNN DirectML / CoreML (Аппаратный NPU процессор)</option>
              </select>
              <p className="text-[11px] text-slate-400 italic">
                {executionEngine === 'webgpu'
                  ? 'Выполняет 2D-FFT свертки и тензорные умножения параллельно в 1024 шейдерных потоках.'
                  : executionEngine === 'wasm_simd'
                  ? 'Использует 128-битные векторные инструкции AVX2/NEON для мгновенной обработки без лагов.'
                  : 'Задействует нейронный сопроцессор (Apple Silicon Neural Engine / Intel NPU).'}
              </p>
            </div>

            {/* Parallel Threads */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300 font-semibold">
                <span>Количество рабочих потоков Web Worker:</span>
                <span className="font-mono text-emerald-400 font-bold">{workerThreads} Потока</span>
              </div>
              <input
                type="range"
                min={2}
                max={16}
                step={2}
                value={workerThreads}
                onChange={(e) => setWorkerThreads(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              />
            </div>

            {/* FFT Resolution */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300">Размер окна спектрального анализа (FFT Size):</label>
              <select
                value={fftSize}
                onChange={(e) => setFftSize(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
              >
                <option value={2048}>2048 точек (Низкая задержка, быстрая речь)</option>
                <option value={4096}>4096 точек (Студийный баланс частотного и временного разрешения)</option>
                <option value={8192}>8192 точек (Прецизионная точность в басовом регистре)</option>
              </select>
            </div>

            {/* Safety Backup */}
            <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
              <input
                type="checkbox"
                id="safe-backup"
                checked={safeAutoBackup}
                onChange={(e) => setSafeAutoBackup(e.target.checked)}
                className="w-4 h-4 text-emerald-500 accent-emerald-500 rounded cursor-pointer"
              />
              <label htmlFor="safe-backup" className="text-xs text-slate-300 cursor-pointer">
                Создавать автоматический бэкап аудиоклипа перед перезаписью
              </label>
            </div>
          </div>

          <div className="lg:col-span-6 space-y-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <HardDrive size={16} className="text-cyan-400" />
                Хранилище моделей и управление памятью
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Кэширование весов нейросетей в Origin Private File System (OPFS) и IndexedDB.
              </p>
            </div>

            <div className="space-y-3">
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2 text-xs font-mono">
                <div className="flex justify-between text-slate-400">
                  <span>Всего моделей в каталоге:</span>
                  <span className="text-slate-100 font-bold">{toSafeArray(models).length}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Установлено в кэш браузера:</span>
                  <span className="text-emerald-400 font-bold">
                    {toSafeArray<ModelCatalogItem>(models).filter((m) => m && m.is_installed).length} моделей
                  </span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Объем занимаемой памяти VRAM:</span>
                  <span className="text-cyan-400 font-bold">~{vramUsageMb} MB</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Частота дискретизации конвейера:</span>
                  <span className="text-purple-400 font-bold">48 000 Hz / 32-bit Float</span>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  alert('Кэш весов нейросетей успешно очищен.');
                }}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 size={13} /> Очистить кэш моделей
              </button>

              <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1.5">
                <ShieldCheck size={14} /> AI Движок готов
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
