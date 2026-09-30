/**
 * ============================================================================
 * VOICEOVER MIX PIPELINE WIZARD (ЗАКАДРОВЫЙ КОНВЕЙЕР СВЕДЕНИЯ)
 * ============================================================================
 * Пошаговый интерактивный мастер сведения закадрового озвучания:
 * 1. AI и DSP обработка, нормализация громкости EBU R128.
 * 2. Детекция коллизий и наездов фраз (Остановка конвейера для ручной правки на таймлайне).
 * 3. Калибровка баланса громкости через Шину Вокала и дорожки (Остановка для прослушивания с начала).
 * 4. Мастер-шина, рендеринг C++ микса и FFmpeg WASM вшивание в видео.
 * ============================================================================
 */

import React, { useState, useEffect, useMemo } from 'react';
import { TrackState, VocalBusState, MasterState, createDefaultVocalBus, ClipConfig } from '../audio/dawEngine';
import { detectTrackCollisions, ClipCollisionInfo } from '../utils/collisionDetector';
import { systemLogger } from '../services/SystemLogger';
import { toSafeArray } from '../utils/safeIterables';
import { globalLoudnessAutoAligner, LoudnessComparisonResult } from '../services/LoudnessAutoAligner';
import { SubtitleCue } from '../services/ProjectManager';
import { globalAutoTimingService, TrackAcousticProfile } from '../services/AutoTimingService';
import { formatCompactTime, formatSMPTE } from '../utils/waveformUtils';
import {
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Play,
  Pause,
  RotateCcw,
  Sliders,
  Volume2,
  VolumeX,
  FileAudio,
  Film,
  Download,
  ChevronRight,
  Maximize2,
  Minimize2,
  X,
  RefreshCw,
  Zap,
  Layers,
  Music,
  Mic,
  ShieldCheck,
  Info,
  Activity,
  Gauge,
  SlidersHorizontal,
  Check,
  SkipBack,
  SkipForward,
  FastForward,
  Rewind,
  Clock,
  Compass,
  Scissors,
  Headphones,
  Settings2,
  BarChart2,
  FileText,
  Filter,
  Eye,
  EyeOff
} from 'lucide-react';

export type WizardStage =
  | 'idle'
  | 'step1_ai_and_norm'
  | 'step2_collision_check'
  | 'step3_volume_balance'
  | 'step4_master_and_mux'
  | 'completed'
  | 'error';

export interface VoiceoverMixWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  tracks: TrackState[];
  setTracks: React.Dispatch<React.SetStateAction<TrackState[]>>;
  vocalBus: VocalBusState;
  setVocalBus: React.Dispatch<React.SetStateAction<VocalBusState>> | ((vocalBus: VocalBusState) => void);
  onVocalBusChange?: (updatedVocalBus: VocalBusState) => void;
  onTrackVolumeChange?: (trackId: number, volumeDb: number) => void;
  master: MasterState;
  videoFile: File | null;
  videoDuration: number;
  currentTimeSec: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeek: (sec: number) => void;
  onRunAIPipelineAndNorm: (onProgress?: (msg: string, percent: number) => void) => Promise<TrackState[]>;
  onRunFinalMasterAndMux: (
    updatedTracks: TrackState[],
    updatedVocalBus: VocalBusState
  ) => Promise<{ videoBlob: Blob | null; videoUrl: string | null; outputFileName: string }>;
  onCollisionsDetected: (collisions: ClipCollisionInfo[]) => void;
  subtitles?: SubtitleCue[];
  onRunAutoTiming?: (tracksToTime?: TrackState[]) => Promise<TrackState[]>;
  onUpdateAllTracks?: (tracks: TrackState[]) => Promise<void> | void;
}

export const VoiceoverMixWizardModal: React.FC<VoiceoverMixWizardModalProps> = ({
  isOpen,
  onClose,
  tracks,
  setTracks,
  vocalBus,
  setVocalBus,
  onVocalBusChange,
  onTrackVolumeChange,
  master,
  videoFile,
  videoDuration,
  currentTimeSec,
  isPlaying,
  onTogglePlay,
  onSeek,
  onRunAIPipelineAndNorm,
  onRunFinalMasterAndMux,
  onCollisionsDetected,
  subtitles = [],
  onRunAutoTiming,
  onUpdateAllTracks
}) => {
  const [stage, setStage] = useState<WizardStage>('idle');
  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [collisions, setCollisions] = useState<ClipCollisionInfo[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAutoTimingRunning, setIsAutoTimingRunning] = useState<boolean>(false);
  const [autoTimingSummary, setAutoTimingSummary] = useState<string | null>(null);
  const [acousticProfiles, setAcousticProfiles] = useState<TrackAcousticProfile[]>([]);
  const [totalStrippedPhrases, setTotalStrippedPhrases] = useState<number>(0);

  // Финальный результат
  const [resultVideoUrl, setResultVideoUrl] = useState<string | null>(null);
  const [resultFileName, setResultFileName] = useState<string>('');
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);

  // Настройки стандарта громкости (целевая разница 3.5 - 4.5 dB, по умолчанию 4.0 dB)
  const [targetDeltaDb, setTargetDeltaDb] = useState<number>(4.0);
  const [autoAlignBeforeRender, setAutoAlignBeforeRender] = useState<boolean>(true);

  // Локальное реактивное состояние Шины Вокала для плавной регулировки ползунка
  const [currentVocalBus, setCurrentVocalBus] = useState<VocalBusState>(() => vocalBus || createDefaultVocalBus());

  // Режим прослушивания фаз сведения:
  // 'mix' - полный микс (оригинал + дубляж + сайдчейн ducking)
  // 'original' - соло оригинального звука (видео)
  // 'dubbing' - соло закадрового озвучания через Шину Вокала
  // 'dry' - Этап 1: Исходный голос без DSP цепочек (байпас EQ/Comp/Gate/DeEsser)
  // 'surgical' - Этап 2: После AI очистки, денойза и VAD нарезки
  // 'tonal' - Этап 3: После параметрического EQ и De-Esser
  // 'ducked' - Этап 4: Компрессор + активный сайдчейн-дакер музыки
  // 'master' - Этап 5: Финальный EBU R128 мастер с лимитером
  const [auditionMode, setAuditionMode] = useState<
    'mix' | 'original' | 'dubbing' | 'dry' | 'surgical' | 'tonal' | 'ducked' | 'master'
  >('mix');
  const [previousAuditionMode, setPreviousAuditionMode] = useState<
    'mix' | 'original' | 'dubbing' | 'dry' | 'surgical' | 'tonal' | 'ducked' | 'master'
  >('dry');
  const [isLoopingCue, setIsLoopingCue] = useState<boolean>(false);
  const [showDspInspector, setShowDspInspector] = useState<boolean>(false);
  const [showLiveLogs, setShowLiveLogs] = useState<boolean>(false);
  const [activePreset, setActivePreset] = useState<string>('balanced');
  const [logCategoryFilter, setLogCategoryFilter] = useState<'all' | 'dsp' | 'phases' | 'audition' | 'errors'>('all');

  // Параметры отдельных DSP инструментов (для оперативного контроля)
  const [toolParams, setToolParams] = useState({
    eqEnabled: true,
    eqLowGain: 0,
    eqMidGain: 0,
    eqHighGain: 0,
    compEnabled: true,
    compThreshold: -18,
    compRatio: 3.0,
    compAttackMs: 15,
    compReleaseMs: 120,
    deEsserEnabled: true,
    deEsserThreshold: -20,
    deEsserFreq: 6500,
    duckerEnabled: true,
    duckerDepth: -8.0,
    limiterCeiling: -0.1
  });

  useEffect(() => {
    if (vocalBus) {
      setCurrentVocalBus(vocalBus);
    }
  }, [vocalBus]);

  // Переключение режима прослушивания с детальным контролем DSP и логированием
  const handleSetAuditionMode = async (
    mode: 'mix' | 'original' | 'dubbing' | 'dry' | 'surgical' | 'tonal' | 'ducked' | 'master'
  ) => {
    if (auditionMode !== mode) {
      setPreviousAuditionMode(auditionMode);
    }
    setAuditionMode(mode);
    const safeTracks = toSafeArray<TrackState>(tracks);

    if (mode === 'original') {
      systemLogger.logAuditionStage('original', 'Оригинал соло (Видео)', 1, {
        voicesMuted: true,
        bgSolo: true
      });
      addLog('🎧 Режим прослушивания: [Оригинал соло]');
      const updated = safeTracks.map((t) => {
        const isOrig =
          t.isOriginalAudio ||
          t.name.toLowerCase().includes('оригинал') ||
          t.name.toLowerCase().includes('original') ||
          t.name.toLowerCase().includes('video');
        return {
          ...t,
          solo: isOrig,
          mute: !isOrig
        };
      });
      setTracks(updated);
      if (onUpdateAllTracks) await onUpdateAllTracks(updated);
    } else if (mode === 'dubbing') {
      systemLogger.logAuditionStage('dubbing', 'Дубляж соло (Vocal Bus)', safeTracks.length - 1, {
        voicesSolo: true,
        bgMuted: true
      });
      addLog('🎧 Режим прослушивания: [Дубляж соло (Vocal Bus)]');
      const updated = safeTracks.map((t) => {
        const isOrig =
          t.isOriginalAudio ||
          t.name.toLowerCase().includes('оригинал') ||
          t.name.toLowerCase().includes('original') ||
          t.name.toLowerCase().includes('video');
        return {
          ...t,
          solo: !isOrig,
          mute: isOrig
        };
      });
      setTracks(updated);
      if (onUpdateAllTracks) await onUpdateAllTracks(updated);
    } else if (mode === 'dry') {
      systemLogger.logAuditionStage('dry', 'Этап 1: Dry (Исходный голос без эффектов)', safeTracks.length, {
        eq: false,
        compressor: false,
        noiseGate: false,
        deEsser: false,
        autoDucker: false
      });
      addLog('🎧 Режим прослушивания: [Этап 1: Dry (Байпас всех DSP)]');
      const updated = safeTracks.map((t) => ({
        ...t,
        solo: false,
        mute: false,
        dsp: {
          ...t.dsp,
          eq: t.dsp?.eq ? { ...t.dsp.eq, enabled: false } : undefined,
          compressor: t.dsp?.compressor ? { ...t.dsp.compressor, enabled: false } : undefined,
          noiseGate: t.dsp?.noiseGate ? { ...t.dsp.noiseGate, enabled: false } : undefined,
          deEsser: t.dsp?.deEsser ? { ...t.dsp.deEsser, enabled: false } : undefined
        }
      }));
      setTracks(updated);
      if (onUpdateAllTracks) await onUpdateAllTracks(updated);
    } else if (mode === 'surgical') {
      systemLogger.logAuditionStage('surgical', 'Этап 2: После AI-чистки и VAD', safeTracks.length, {
        noiseGate: true,
        eq: false,
        compressor: false,
        deEsser: false,
        autoDucker: false
      });
      addLog('🎧 Режим прослушивания: [Этап 2: Surgical (Только денойз и гейт, без тональной обработки)]');
      const updated = safeTracks.map((t) => ({
        ...t,
        solo: false,
        mute: false,
        dsp: {
          ...t.dsp,
          noiseGate: t.dsp?.noiseGate ? { ...t.dsp.noiseGate, enabled: true } : undefined,
          eq: t.dsp?.eq ? { ...t.dsp.eq, enabled: false } : undefined,
          compressor: t.dsp?.compressor ? { ...t.dsp.compressor, enabled: false } : undefined,
          deEsser: t.dsp?.deEsser ? { ...t.dsp.deEsser, enabled: false } : undefined
        }
      }));
      setTracks(updated);
      if (onUpdateAllTracks) await onUpdateAllTracks(updated);
    } else if (mode === 'tonal') {
      systemLogger.logAuditionStage('tonal', 'Этап 3: Тональный баланс (EQ + De-Esser)', safeTracks.length, {
        eq: true,
        deEsser: true,
        compressor: false,
        autoDucker: false
      });
      addLog('🎧 Режим прослушивания: [Этап 3: Tonal (EQ + De-Esser, без тяжелой компрессии)]');
      const updated = safeTracks.map((t) => ({
        ...t,
        solo: false,
        mute: false,
        dsp: {
          ...t.dsp,
          noiseGate: t.dsp?.noiseGate ? { ...t.dsp.noiseGate, enabled: true } : undefined,
          eq: t.dsp?.eq ? { ...t.dsp.eq, enabled: true } : undefined,
          deEsser: t.dsp?.deEsser ? { ...t.dsp.deEsser, enabled: true } : undefined,
          compressor: t.dsp?.compressor ? { ...t.dsp.compressor, enabled: false } : undefined
        }
      }));
      setTracks(updated);
      if (onUpdateAllTracks) await onUpdateAllTracks(updated);
    } else if (mode === 'ducked') {
      systemLogger.logAuditionStage('ducked', 'Этап 4: Компрессия и Сайдчейн-дакинг', safeTracks.length, {
        eq: true,
        deEsser: true,
        compressor: true,
        autoDucker: true
      });
      addLog('🎧 Режим прослушивания: [Этап 4: Ducked Mix (Компрессор + активный сайдчейн фонограммы)]');
      const updated = safeTracks.map((t) => ({
        ...t,
        solo: false,
        mute: false,
        dsp: {
          ...t.dsp,
          noiseGate: t.dsp?.noiseGate ? { ...t.dsp.noiseGate, enabled: true } : undefined,
          eq: t.dsp?.eq ? { ...t.dsp.eq, enabled: true } : undefined,
          deEsser: t.dsp?.deEsser ? { ...t.dsp.deEsser, enabled: true } : undefined,
          compressor: t.dsp?.compressor ? { ...t.dsp.compressor, enabled: true } : undefined
        }
      }));
      setTracks(updated);
      if (onUpdateAllTracks) await onUpdateAllTracks(updated);
    } else if (mode === 'master') {
      systemLogger.logAuditionStage('master', 'Этап 5: Финальный EBU R128 Мастер', safeTracks.length, {
        eq: true,
        deEsser: true,
        compressor: true,
        autoDucker: true,
        limiter: true
      });
      addLog('🎧 Режим прослушивания: [Этап 5: Master EBU R128 (Сведение 1-в-1 с мастер-лимитером)]');
      const updated = safeTracks.map((t) => ({
        ...t,
        solo: false,
        mute: false,
        dsp: {
          ...t.dsp,
          noiseGate: t.dsp?.noiseGate ? { ...t.dsp.noiseGate, enabled: true } : undefined,
          eq: t.dsp?.eq ? { ...t.dsp.eq, enabled: true } : undefined,
          deEsser: t.dsp?.deEsser ? { ...t.dsp.deEsser, enabled: true } : undefined,
          compressor: t.dsp?.compressor ? { ...t.dsp.compressor, enabled: true } : undefined
        }
      }));
      setTracks(updated);
      if (onUpdateAllTracks) await onUpdateAllTracks(updated);
    } else {
      systemLogger.logAuditionStage('mix', 'Полный сбалансированный микс', safeTracks.length, {
        allActive: true
      });
      addLog('🎧 Режим прослушивания: [Полный микс (Оригинал + Дубляж + Сайдчейн)]');
      const updated = safeTracks.map((t) => ({
        ...t,
        solo: false,
        mute: false,
        dsp: {
          ...t.dsp,
          noiseGate: t.dsp?.noiseGate ? { ...t.dsp.noiseGate, enabled: true } : undefined,
          eq: t.dsp?.eq ? { ...t.dsp.eq, enabled: true } : undefined,
          deEsser: t.dsp?.deEsser ? { ...t.dsp.deEsser, enabled: true } : undefined,
          compressor: t.dsp?.compressor ? { ...t.dsp.compressor, enabled: true } : undefined
        }
      }));
      setTracks(updated);
      if (onUpdateAllTracks) await onUpdateAllTracks(updated);
    }
  };

  // Мгновенное A/B переключение между текущим этапом и Dry / Оригиналом
  const handleToggleAB = () => {
    if (auditionMode === 'dry') {
      const returnTarget = previousAuditionMode === 'dry' ? 'mix' : previousAuditionMode;
      handleSetAuditionMode(returnTarget);
    } else {
      setPreviousAuditionMode(auditionMode);
      handleSetAuditionMode('dry');
    }
  };

  // Изменение параметров конкретного DSP инструмента
  const handleUpdateDSPParam = async (param: string, value: any) => {
    const updatedParams = { ...toolParams, [param]: value };
    setToolParams(updatedParams);

    const safeTracks = toSafeArray<TrackState>(tracks);
    const updatedTracks = safeTracks.map((t) => {
      const isOrig =
        t.isOriginalAudio ||
        t.name.toLowerCase().includes('оригинал') ||
        t.name.toLowerCase().includes('video');
      if (isOrig) return t;
      return {
        ...t,
        dsp: {
          ...t.dsp,
          eq: {
            enabled: updatedParams.eqEnabled,
            lowGainDb: updatedParams.eqLowGain,
            midGainDb: updatedParams.eqMidGain,
            highGainDb: updatedParams.eqHighGain,
            lowFreqHz: 100,
            midFreqHz: 2500,
            highFreqHz: 10000
          },
          compressor: {
            enabled: updatedParams.compEnabled,
            thresholdDb: updatedParams.compThreshold,
            ratio: updatedParams.compRatio,
            attackMs: updatedParams.compAttackMs,
            releaseMs: updatedParams.compReleaseMs
          },
          deEsser: {
            enabled: updatedParams.deEsserEnabled,
            frequencyHz: updatedParams.deEsserFreq,
            thresholdDb: updatedParams.deEsserThreshold
          }
        }
      };
    });

    setTracks(updatedTracks);
    if (onUpdateAllTracks) await onUpdateAllTracks(updatedTracks);

    if (param === 'duckerDepth' || param === 'duckerEnabled') {
      const updatedBus: VocalBusState = {
        ...currentVocalBus,
        autoDucker: {
          ...(currentVocalBus.autoDucker || { attackMs: 20, releaseMs: 250, thresholdDb: -30 }),
          enabled: updatedParams.duckerEnabled,
          duckDepthDb: updatedParams.duckerDepth
        }
      };
      setCurrentVocalBus(updatedBus);
      if (onVocalBusChange) onVocalBusChange(updatedBus);
    }

    const toolName = param.startsWith('eq')
      ? 'ParametricEQ'
      : param.startsWith('comp')
      ? 'StudioCompressor'
      : param.startsWith('deEsser')
      ? 'DeEsserPro'
      : 'AutoDucker';

    systemLogger.logDSPToolEvent(toolName, 'Шина Вокала / Дорожки', `Параметр ${param} установлен в ${value}`, {
      [param]: value
    });
    addLog(`🎛️ [DSP] ${toolName}.${param} = ${value}`);
  };

  // Применение звукового характера и пресета инструментов
  const handleApplyCharacterPreset = async (presetKey: string) => {
    setActivePreset(presetKey);
    const safeTracks = toSafeArray<TrackState>(tracks);
    let duckDepth = -8.0;
    let presetName = 'Сбалансированный';

    let eqParams = { lowGainDb: 0, midGainDb: 0, highGainDb: 0 };
    let compParams = { thresholdDb: -18, ratio: 3.0, attackMs: 15, releaseMs: 120 };
    let deEsserParams = { thresholdDb: -20, freqHz: 6500 };

    if (presetKey === 'cinema') {
      presetName = 'Кинотеатр / Теплый вокал';
      duckDepth = -10.0;
      eqParams = { lowGainDb: 1.5, midGainDb: -1.0, highGainDb: 1.0 };
      compParams = { thresholdDb: -19, ratio: 2.5, attackMs: 25, releaseMs: 160 };
      deEsserParams = { thresholdDb: -22, freqHz: 6000 };
    } else if (presetKey === 'anime') {
      presetName = 'Аниме / Яркий войсовер';
      duckDepth = -11.0;
      eqParams = { lowGainDb: -1.0, midGainDb: 2.0, highGainDb: 3.0 };
      compParams = { thresholdDb: -17, ratio: 3.5, attackMs: 10, releaseMs: 100 };
      deEsserParams = { thresholdDb: -19, freqHz: 7000 };
    } else if (presetKey === 'podcast') {
      presetName = 'Подкаст / Плотный компрессор';
      duckDepth = -13.0;
      eqParams = { lowGainDb: 0.5, midGainDb: 1.5, highGainDb: 2.0 };
      compParams = { thresholdDb: -16, ratio: 4.0, attackMs: 8, releaseMs: 80 };
      deEsserParams = { thresholdDb: -24, freqHz: 6200 };
    } else if (presetKey === 'hifi') {
      presetName = 'Чистая речь / Hi-Fi Broadcast';
      duckDepth = -7.0;
      eqParams = { lowGainDb: -0.5, midGainDb: 0.5, highGainDb: 1.5 };
      compParams = { thresholdDb: -20, ratio: 2.2, attackMs: 20, releaseMs: 180 };
      deEsserParams = { thresholdDb: -21, freqHz: 6800 };
    } else {
      presetName = 'Нейтральный / TV';
      duckDepth = -8.0;
      eqParams = { lowGainDb: 0, midGainDb: 0, highGainDb: 0 };
      compParams = { thresholdDb: -18, ratio: 3.0, attackMs: 15, releaseMs: 120 };
      deEsserParams = { thresholdDb: -20, freqHz: 6500 };
    }

    setToolParams({
      ...toolParams,
      eqLowGain: eqParams.lowGainDb,
      eqMidGain: eqParams.midGainDb,
      eqHighGain: eqParams.highGainDb,
      compThreshold: compParams.thresholdDb,
      compRatio: compParams.ratio,
      compAttackMs: compParams.attackMs,
      compReleaseMs: compParams.releaseMs,
      deEsserThreshold: deEsserParams.thresholdDb,
      deEsserFreq: deEsserParams.freqHz,
      duckerDepth: duckDepth
    });

    const updatedBus: VocalBusState = {
      ...currentVocalBus,
      autoDucker: {
        ...(currentVocalBus.autoDucker || { enabled: true, attackMs: 20, releaseMs: 250, thresholdDb: -30 }),
        duckDepthDb: duckDepth,
        enabled: true
      }
    };
    setCurrentVocalBus(updatedBus);
    if (onVocalBusChange) onVocalBusChange(updatedBus);

    const updatedTracks = safeTracks.map((t) => {
      const isOrig =
        t.isOriginalAudio ||
        t.name.toLowerCase().includes('оригинал') ||
        t.name.toLowerCase().includes('video');
      if (isOrig) return t;
      return {
        ...t,
        dsp: {
          ...t.dsp,
          eq: {
            enabled: true,
            lowGainDb: eqParams.lowGainDb,
            midGainDb: eqParams.midGainDb,
            highGainDb: eqParams.highGainDb,
            lowFreqHz: 100,
            midFreqHz: 2500,
            highFreqHz: 10000
          },
          compressor: {
            enabled: true,
            thresholdDb: compParams.thresholdDb,
            ratio: compParams.ratio,
            attackMs: compParams.attackMs,
            releaseMs: compParams.releaseMs
          },
          deEsser: {
            enabled: true,
            frequencyHz: deEsserParams.freqHz,
            thresholdDb: deEsserParams.thresholdDb
          }
        }
      };
    });

    setTracks(updatedTracks);
    if (onUpdateAllTracks) await onUpdateAllTracks(updatedTracks);

    systemLogger.logDSPToolEvent(
      'PresetManager',
      'Все дорожки',
      `Применен пресет сведения: [${presetName}]`,
      {
        presetKey,
        presetName,
        eqLow: eqParams.lowGainDb,
        eqMid: eqParams.midGainDb,
        eqHigh: eqParams.highGainDb,
        compThreshold: compParams.thresholdDb,
        compRatio: compParams.ratio,
        duckDepth
      }
    );
    addLog(
      `✨ Пресет [${presetName}]: Auto-Ducker ${duckDepth} dB, настроены EQ (${eqParams.lowGainDb}/${eqParams.midGainDb}/${eqParams.highGainDb} dB) и компрессор.`
    );
  };

  // Регулировка глубины приглушения фонограммы (Auto-Ducker)
  const handleUpdateDuckerDepth = async (depthDb: number) => {
    const updatedBus: VocalBusState = {
      ...currentVocalBus,
      autoDucker: {
        ...(currentVocalBus.autoDucker || { enabled: true, attackMs: 20, releaseMs: 250, thresholdDb: -30 }),
        duckDepthDb: depthDb,
        enabled: true
      }
    };
    setCurrentVocalBus(updatedBus);
    if (onVocalBusChange) onVocalBusChange(updatedBus);

    systemLogger.info('AutoDucker', `Изменена глубина сайдчейн-приглушения: ${depthDb} dB (Атака: ${updatedBus.autoDucker?.attackMs}мс, Спад: ${updatedBus.autoDucker?.releaseMs}мс)`);
  };

  // Полная длительность проекта для мини-таймлайна конвейера
  const wizardTotalDurationSec = useMemo(() => {
    let maxSec = Math.max(videoDuration || 0, 0);
    toSafeArray<TrackState>(tracks).forEach((t) => {
      toSafeArray<ClipConfig>(t.clips).forEach((c) => {
        const endSec = ((c.offsetSamples || 0) + (c.lengthSamples || 0)) / 48000;
        if (endSec > maxSec) maxSec = endSec;
      });
    });
    toSafeArray<SubtitleCue>(subtitles).forEach((s) => {
      if (s.endSec > maxSec) maxSec = s.endSec;
    });
    return Math.max(maxSec, 15);
  }, [tracks, videoDuration, subtitles]);

  // Активная реплика субтитров в текущий момент времени
  const activeCurrentCue = useMemo(() => {
    return toSafeArray<SubtitleCue>(subtitles).find(
      (c) => currentTimeSec >= c.startSec - 0.1 && currentTimeSec <= c.endSec + 0.1
    );
  }, [subtitles, currentTimeSec]);

  // Зацикливание активной тестовой фразы для прецизионного A/B сравнения этапов сведения
  useEffect(() => {
    if (isLoopingCue && isPlaying && activeCurrentCue) {
      if (currentTimeSec >= activeCurrentCue.endSec - 0.05) {
        onSeek(activeCurrentCue.startSec);
      }
    }
  }, [isLoopingCue, isPlaying, currentTimeSec, activeCurrentCue, onSeek]);

  const handleSeekRelative = (deltaSec: number) => {
    const target = Math.max(0, Math.min(wizardTotalDurationSec, currentTimeSec + deltaSec));
    onSeek(target);
  };

  const handleJumpToPercentage = (pct: number) => {
    const target = Math.max(0, Math.min(wizardTotalDurationSec, (wizardTotalDurationSec * pct) / 100));
    onSeek(target);
  };

  const handleJumpToCue = (direction: 'prev' | 'next') => {
    const sorted = [...toSafeArray<SubtitleCue>(subtitles)].sort((a, b) => a.startSec - b.startSec);
    if (sorted.length === 0) return;

    if (direction === 'next') {
      const next = sorted.find((c) => c.startSec > currentTimeSec + 0.3);
      if (next) onSeek(next.startSec);
      else onSeek(sorted[0].startSec);
    } else {
      const prev = [...sorted].reverse().find((c) => c.startSec < currentTimeSec - 0.5);
      if (prev) onSeek(prev.startSec);
      else onSeek(0);
    }
  };

  // Реактивный анализ громкостей (Оригинал vs Закадровый мастер-микс)
  const loudnessComparison: LoudnessComparisonResult = useMemo(() => {
    return globalLoudnessAutoAligner.compareProjectLoudness(
      toSafeArray<TrackState>(tracks),
      currentVocalBus,
      targetDeltaDb
    );
  }, [tracks, currentVocalBus, targetDeltaDb]);

  const handleApplyAutoLoudness = (customDelta?: number) => {
    const delta = customDelta !== undefined ? customDelta : targetDeltaDb;
    const aligned = globalLoudnessAutoAligner.applyAutoAlignment(
      toSafeArray<TrackState>(tracks),
      currentVocalBus,
      master,
      delta
    );

    setCurrentVocalBus(aligned.updatedVocalBus);
    if (onVocalBusChange) {
      onVocalBusChange(aligned.updatedVocalBus);
    }
    if (typeof setVocalBus === 'function') {
      try {
        (setVocalBus as any)(aligned.updatedVocalBus);
      } catch (_) {}
    }

    addLog(
      `⚡ Авто-выравнивание: Установлен баланс +${aligned.comparison.targetDeltaDb} dB (Шина вокала: ${aligned.updatedVocalBus.volumeDb > 0 ? '+' : ''}${aligned.updatedVocalBus.volumeDb.toFixed(1)} dB)`
    );
  };

  const handleVocalBusVolumeChange = (newVolumeDb: number) => {
    const updatedBus: VocalBusState = {
      ...(currentVocalBus || vocalBus || createDefaultVocalBus()),
      volumeDb: newVolumeDb
    };
    setCurrentVocalBus(updatedBus);

    if (onVocalBusChange) {
      onVocalBusChange(updatedBus);
    }

    if (typeof setVocalBus === 'function') {
      try {
        (setVocalBus as any)(updatedBus);
      } catch (_) {}
    }
  };

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${time}] ${msg}`]);
  };

  // Автозапуск первого шага при открытии
  useEffect(() => {
    if (isOpen && stage === 'idle') {
      startPipeline();
    }
  }, [isOpen]);

  const startPipeline = async () => {
    setErrorMessage(null);
    setLogs([]);
    setStage('step1_ai_and_norm');
    setProgressPercent(10);
    setStatusMessage('Шаг 1/4: AI-обработка, очистка шумов и EBU R128 нормализация громкости (-18 dBFS)...');
    addLog('Запуск конвейера сведения заказадрового озвучания...');
    systemLogger.logMixingPhase(1, 'AI & EBU R128 Нормализация', 'started', { targetLufsDb: -18.0 });

    try {
      // 1. Применение AI и нормализация
      const processedTracks = await onRunAIPipelineAndNorm((msg, pct) => {
        setStatusMessage(`Шаг 1/4: ${msg}`);
        setProgressPercent(Math.round(10 + pct * 0.25)); // Scale progress to 10% - 35%
        addLog(msg);
      });
      addLog('AI обработка и EBU R128 нормализация всех дорожек успешно завершена.');
      systemLogger.logMixingPhase(1, 'AI & EBU R128 Нормализация', 'completed', { tracksCount: processedTracks.length });
      setProgressPercent(35);

      // 1.5. Акустический анализ (фоновый шум, тихая речь) и адаптивное удаление тишины для каждой дорожки даббера ДО детекции коллизий
      setStatusMessage('Шаг 1.5/4: Акустический анализ (шум/речь) и адаптивное удаление тишины для каждой дорожки...');
      addLog('✂️ Запуск индивидуального акустического анализа и нарезки на фразы для всех дорожек дабберов...');

      const { updatedTracks: silenceStrippedTracks, profiles, totalPhrases } =
        globalAutoTimingService.stripSilenceAdaptiveAllTracks(processedTracks, 48000);

      setAcousticProfiles(profiles);
      setTotalStrippedPhrases(totalPhrases);
      setTracks(silenceStrippedTracks);
      if (onUpdateAllTracks) {
        await onUpdateAllTracks(silenceStrippedTracks);
      }

      profiles.forEach((p) => {
        addLog(
          `🎙️ [${p.trackName}] Шум: ${p.noiseFloorDb} dBFS | Тихая речь: ${p.quietestSpeechRmsDb} dBFS ➔ Порог VAD: ${p.optimalThresholdDb} dBFS (мин. пауза: ${p.optimalMinSilenceMs}мс)`
        );
      });
      addLog(`✅ Удаление тишины завершено: выделено ${totalPhrases} отдельных голосовых реплик без фонового шума.`);
      setProgressPercent(45);

      // 2. Детекция коллизий НА ДОРОЖКАХ С УДАЛЁННОЙ ТИШИНОЙ
      setStatusMessage('Шаг 2/4: Детекция коллизий и наездов между репликами...');
      const detectedCollisions = detectTrackCollisions(silenceStrippedTracks);
      setCollisions(detectedCollisions);
      onCollisionsDetected(detectedCollisions);

      setStage('step2_collision_check');
      setProgressPercent(50);

      if (detectedCollisions.length > 0) {
        addLog(`⚠️ ВНИМАНИЕ: Обнаружено ${detectedCollisions.length} реальных коллизий / наездов фраз! Конвейер приостановлен.`);
        setStatusMessage(`Обнаружено коллизий: ${detectedCollisions.length} шт. Конвейер приостановлен для проверки.`);
        systemLogger.logMixingPhase(2, 'Детекция коллизий и VAD нарезка', 'auditioning', {
          collisionsCount: detectedCollisions.length,
          totalPhrases
        });
      } else {
        addLog('✅ Коллизий и наездов фраз не обнаружено.');
        setStatusMessage('Коллизий не обнаружено. Переходим к калибровке громкости.');
        systemLogger.logMixingPhase(2, 'Детекция коллизий и VAD нарезка', 'completed', {
          collisionsCount: 0,
          totalPhrases
        });
      }
    } catch (err: any) {
      addLog(`❌ Ошибка на Шаге 1: ${err?.message || err}`);
      setErrorMessage(err?.message || 'Ошибка обработки аудио');
      systemLogger.error('MVPPipeline', `Ошибка на Шаге 1 (AI / Нормализация): ${err?.message || err}`);
      setStage('error');
    }
  };

  // Принудительное удаление тишины и нарезка на фразы прямо из мастера
  const handleStripSilenceInWizard = async () => {
    setStatusMessage('Запуск C++ адаптивного Strip Silence: анализ шума/речи и нарезка на фразы...');
    addLog('✂️ Запуск VAD удаления тишины и разделения на отдельные голосовые фразы...');
    try {
      const { updatedTracks: silenceStrippedTracks, profiles, totalPhrases } =
        globalAutoTimingService.stripSilenceAdaptiveAllTracks(tracks, 48000);
      setAcousticProfiles(profiles);
      setTotalStrippedPhrases(totalPhrases);
      setTracks(silenceStrippedTracks);
      if (onUpdateAllTracks) {
        await onUpdateAllTracks(silenceStrippedTracks);
      }
      const rechecked = detectTrackCollisions(silenceStrippedTracks);
      setCollisions(rechecked);
      onCollisionsDetected(rechecked);
      addLog(`✅ Удаление тишины завершено: выделено ${totalPhrases} отдельных голосовых реплик, коллизий: ${rechecked.length}.`);
      setStatusMessage(`Удаление тишины выполнено: нарезано ${totalPhrases} реплик.`);
    } catch (e: any) {
      addLog(`❌ Ошибка удаления тишины: ${e?.message || e}`);
    }
  };

  // Перепроверка коллизий
  const handleRecheckCollisions = () => {
    const rechecked = detectTrackCollisions(tracks);
    setCollisions(rechecked);
    onCollisionsDetected(rechecked);
    if (rechecked.length === 0) {
      addLog('✅ Все коллизии успешно устранены!');
      setStatusMessage('Коллизии устранены. Можно продолжать конвейер.');
      systemLogger.info('MVPPipeline', 'Коллизии успешно устранены пользователем на таймлайне.');
    } else {
      addLog(`Осталось коллизий: ${rechecked.length} шт.`);
      systemLogger.warn('MVPPipeline', `Повторная проверка: осталось ${rechecked.length} коллизий.`);
    }
  };

  // Автоматический тайминг и разведение коллизий по субтитрам
  const handleAutoTimingInWizard = async () => {
    setIsAutoTimingRunning(true);
    setStatusMessage('Запуск автоматического тайминга: сопоставление актёров и разведение коллизий...');
    addLog('⚡ Запуск C++ алгоритма сценарного тайминга и устранения наездов...');
    try {
      let updated: TrackState[];
      if (onRunAutoTiming) {
        updated = await onRunAutoTiming(tracks);
      } else {
        const res = globalAutoTimingService.runAutoTimingPipeline(tracks, subtitles);
        updated = res.updatedTracks;
        setTracks(updated);
        setAutoTimingSummary(
          `Синхронизировано ${res.totalPhrasesAligned} фраз, устранено ${res.resolvedCollisionsCount} наездов, сохранено ${res.preservedScriptOverlapsCount} сценарных перекрытий.`
        );
      }
      if (onUpdateAllTracks) {
        await onUpdateAllTracks(updated);
      }
      const rechecked = detectTrackCollisions(updated);
      setCollisions(rechecked);
      onCollisionsDetected(rechecked);
      addLog(`⚡ Авто-тайминг выполнен: устранено коллизий, осталось: ${rechecked.length}.`);
      setStatusMessage(`Авто-тайминг завершён: коллизий осталось: ${rechecked.length}.`);
    } catch (e: any) {
      addLog(`❌ Ошибка авто-тайминга: ${e?.message || e}`);
    } finally {
      setIsAutoTimingRunning(false);
    }
  };

  // Переход к Шагу 3 (Калибровка громкости и Шина Вокала)
  const handleProceedToVolumeBalance = () => {
    setStage('step3_volume_balance');
    setProgressPercent(70);
    setStatusMessage('Шаг 3/4: Калибровка общего баланса громкости с начала проекта и Шина Вокала.');
    addLog('Приостановка конвейера: Ожидание калибровки громкости пользователем.');
    systemLogger.logMixingPhase(3, 'Калибровка баланса громкости и шина вокала', 'started', {
      targetDeltaDb,
      vocalBusVolumeDb: currentVocalBus.volumeDb
    });

    // Если плейхед в самом конце ролика или в нуле, прыгаем к первой фразе для быстрого прослушивания
    const firstCueTime = subtitles && subtitles.length > 0 ? Math.max(0, subtitles[0].startSec - 0.2) : 0;
    if (currentTimeSec >= wizardTotalDurationSec - 0.5 || currentTimeSec <= 0.05) {
      onSeek(firstCueTime);
    }

    // Синхронизируем все дорожки и проверяем, чтобы звук был включен
    if (onUpdateAllTracks) {
      onUpdateAllTracks(tracks);
    }
  };

  // Завершение и запуск мастеринга + FFmpeg муксинга
  const handleProceedToFinalMasterAndMux = async () => {
    setStage('step4_master_and_mux');
    setProgressPercent(85);
    setStatusMessage('Шаг 4/4: Анализ громкостей, C++ мастеринг и вшивание аудио в видео...');
    addLog('Старт финального C++ мастеринга и FFmpeg видео-муксинга...');
    systemLogger.logMixingPhase(4, 'Финальный C++ мастеринг и муксинг', 'started', {
      tracksCount: tracks.length,
      vocalBusVolumeDb: currentVocalBus.volumeDb,
      masterVolumeDb: master.volumeDb
    });

    try {
      const targetVocalBus = currentVocalBus || vocalBus;
      const targetTracks = [...toSafeArray<TrackState>(tracks)];

      // СТРОГО 1-В-1: Запрещены скрытые поправки перед рендером
      // Все коэффициенты громкости и эффектов строго зафиксированы из предпрослушивания
      addLog(
        `[Mixer 1-в-1] Фиксация параметров: Шина вокала ${(targetVocalBus.volumeDb || 0).toFixed(1)} dB, Мастер ${(master.volumeDb || 0).toFixed(1)} dB, треков: ${targetTracks.length}`
      );
      systemLogger.info(
        'MVPPipeline',
        `Шаг 4/4: Фиксация параметров 1-в-1 с превью: Шина вокала ${(targetVocalBus.volumeDb || 0).toFixed(1)} dB, треков: ${targetTracks.length}`
      );

      const res = await onRunFinalMasterAndMux(targetTracks, targetVocalBus);
      setResultVideoUrl(res.videoUrl);
      setResultFileName(res.outputFileName);
      setResultBlob(res.videoBlob);

      setProgressPercent(100);
      setStage('completed');
      const isAudioOnly = res.outputFileName.endsWith('.wav');
      if (isAudioOnly) {
        setStatusMessage(`Мастер-микс аудио успешно готов и сохранен: ${res.outputFileName}`);
        addLog(`🎉 Мастеринг завершен! Аудиофайл ${res.outputFileName} сохранен в project/.`);
      } else {
        setStatusMessage(`Готово! Видео успешно сведено и зашито: ${res.outputFileName}`);
        addLog(`🎉 Сквозной конвейер успешно завершен! Файл ${res.outputFileName} сохранен в project/.`);
      }
      systemLogger.logMixingPhase(4, 'Финальный C++ мастеринг и муксинг', 'completed', {
        outputFileName: res.outputFileName
      });
    } catch (err: any) {
      const isMemErr =
        err?.message?.includes('лимит памяти') ||
        err?.message?.includes('WebAssembly') ||
        err?.message?.includes('allocation failed') ||
        err?.name === 'RangeError';

      if (isMemErr) {
        addLog(`⚠️ ${err?.message || err}`);
        setStatusMessage('Мастер-микс аудио (WAV) успешно скомпонован! Видеомуксинг пропущен из-за превышения памяти WASM.');
        setErrorMessage(err?.message || 'Ограничение памяти WebAssembly');
        setStage('completed');
      } else {
        addLog(`❌ Ошибка мастеринга/муксинга: ${err?.message || err}`);
        setErrorMessage(err?.message || 'Ошибка финального рендеринга');
        systemLogger.error('MVPPipeline', `Ошибка на Шаге 4 (Мастеринг / FFmpeg муксинг): ${err?.message || err}`);
        setStage('error');
      }
    }
  };

  if (!isOpen) return null;

  // Минимизированный режим (плавающая панель во время правки на таймлайне)
  if (isMinimized) {
    return (
      <div className="fixed bottom-6 right-6 z-50 bg-[#0f172a] border border-amber-500/50 rounded-2xl shadow-2xl p-4 w-96 text-slate-100 space-y-3 animate-fadeIn">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-amber-500/20 border border-amber-500/30 rounded-lg text-amber-400">
              <AlertTriangle size={16} />
            </div>
            <div>
              <h4 className="text-xs font-bold">Конвейер на паузе</h4>
              <p className="text-[10px] text-slate-400">Правка коллизий на таймлайне</p>
            </div>
          </div>
          <button
            onClick={() => setIsMinimized(false)}
            className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-all cursor-pointer"
            title="Развернуть окно конвейера"
          >
            <Maximize2 size={16} />
          </button>
        </div>

        {collisions.length > 0 && (
          <div className="text-[11px] bg-rose-950/40 border border-rose-500/30 p-2 rounded-lg text-rose-300">
            Обнаружено {collisions.length} наездов фраз. Клипы подсвечены красным на таймлайне!
          </div>
        )}

        <div className="grid grid-cols-2 gap-1.5 pt-1">
          <button
            onClick={handleStripSilenceInWizard}
            className="py-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-400 text-[11px] font-semibold rounded-lg transition-all flex items-center justify-center gap-1 cursor-pointer border border-emerald-900/50"
            title="Нарезать все дорожки на фразы без тишины"
          >
            <Scissors size={12} />
            Нарезать тишину
          </button>
          <button
            onClick={handleAutoTimingInWizard}
            disabled={isAutoTimingRunning}
            className="py-1.5 bg-cyan-950 hover:bg-cyan-900 text-cyan-300 text-[11px] font-semibold rounded-lg transition-all flex items-center justify-center gap-1 cursor-pointer border border-cyan-800/60"
            title="Автоматически развести наезжающие клипы"
          >
            <Zap size={12} />
            Авто-разведение
          </button>
        </div>

        <div className="flex gap-2 pt-0.5">
          <button
            onClick={handleRecheckCollisions}
            className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1 cursor-pointer"
          >
            <RefreshCw size={12} />
            Проверить
          </button>
          <button
            onClick={() => {
              setIsMinimized(false);
              handleProceedToVolumeBalance();
            }}
            className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1 cursor-pointer shadow-lg shadow-emerald-950/50"
          >
            Продолжить <ChevronRight size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-[#0b0f19] border border-slate-800 rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Шапка модального окна */}
        <div className="p-5 border-b border-slate-800 bg-[#0f172a]/60 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-purple-500/20 to-cyan-500/20 border border-purple-500/30 rounded-2xl text-purple-400">
              <Sparkles size={20} className="text-amber-300" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                Конвейер Закадрового Сведения
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  Interactive Wizard
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Полный цикл: AI очистка $\rightarrow$ Детекция наездов $\rightarrow$ Шина вокала $\rightarrow$ Мастеринг в видео
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-xl transition-all cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Шкала шагов конвейера */}
        <div className="px-6 pt-4 pb-2 border-b border-slate-800/80 bg-[#090d16]">
          <div className="flex items-center justify-between text-xs font-medium mb-2">
            <span className={`flex items-center gap-1 ${stage === 'step1_ai_and_norm' ? 'text-purple-400 font-bold' : 'text-slate-500'}`}>
              1. AI & Norm
            </span>
            <span className={`flex items-center gap-1 ${stage === 'step2_collision_check' ? 'text-amber-400 font-bold' : 'text-slate-500'}`}>
              2. Коллизии
            </span>
            <span className={`flex items-center gap-1 ${stage === 'step3_volume_balance' ? 'text-cyan-400 font-bold' : 'text-slate-500'}`}>
              3. Громкость
            </span>
            <span className={`flex items-center gap-1 ${stage === 'step4_master_and_mux' || stage === 'completed' ? 'text-emerald-400 font-bold' : 'text-slate-500'}`}>
              4. Мастеринг
            </span>
          </div>

          <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
            <div
              className="h-full bg-gradient-to-r from-purple-500 via-cyan-500 to-emerald-500 transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Основной интерактивный контент шага */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {/* ПУЛЬТ ПРОСЛУШИВАНИЯ НА ЭТАПАХ СВЕДЕНИЯ & ИНСТРУМЕНТЫ ЭФФЕКТОВ */}
          <div className="p-4 bg-[#0a0f1d] border border-cyan-500/40 rounded-2xl space-y-3.5 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-gradient-to-br from-cyan-500/20 to-purple-500/20 border border-cyan-500/30 rounded-lg text-cyan-400">
                  <Headphones size={16} />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-100 flex items-center gap-2">
                    Воспроизведение на Этапах Сведения & A/B Контроль
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-mono">
                      Текущий этап: {auditionMode.toUpperCase()}
                    </span>
                  </h4>
                  <p className="text-[11px] text-slate-400">
                    Слушайте звук в любой фазе обработки для непрерывного контроля качества микса
                  </p>
                </div>
              </div>

              {/* Управление воспроизведением и таймкод */}
              <div className="flex items-center gap-2">
                <div className="bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800 font-mono text-xs text-cyan-300 font-bold flex items-center gap-1.5">
                  <Clock size={12} className="text-cyan-400" />
                  <span>{formatCompactTime(currentTimeSec)}</span>
                </div>

                <button
                  type="button"
                  onClick={onTogglePlay}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow-md ${
                    isPlaying
                      ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-950/40'
                      : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/40'
                  }`}
                  title="Воспроизвести / Пауза"
                >
                  {isPlaying ? <Pause size={13} /> : <Play size={13} />}
                  <span>{isPlaying ? 'Пауза' : 'Плей'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleAB}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
                    auditionMode === 'dry'
                      ? 'bg-amber-600 hover:bg-amber-500 text-white border-amber-400 shadow-md shadow-amber-950/40 animate-pulse'
                      : 'bg-slate-800 hover:bg-slate-700 text-amber-300 border-amber-500/40'
                  }`}
                  title="Мгновенное A/B переключение между исходным звуком (Dry) и текущим этапом"
                >
                  <Zap size={12} className="text-amber-300" />
                  <span>A/B: {auditionMode === 'dry' ? 'Возврат к миксу' : 'Сравнить с Dry'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsLoopingCue((prev) => !prev)}
                  className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer border ${
                    isLoopingCue
                      ? 'bg-purple-600 text-white border-purple-400'
                      : 'bg-slate-800 hover:bg-slate-700 text-purple-300 border-purple-500/30'
                  }`}
                  title="Зацикливать звучание текущей реплики для детальной подстройки тембра"
                >
                  <RotateCcw size={12} className={isLoopingCue ? 'animate-spin' : ''} />
                  <span>Петля фразы</span>
                </button>
              </div>
            </div>

            {/* Сетка кнопок этапов сведения */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-1.5 pt-1 text-[11px] font-medium">
              {/* 1. Dry */}
              <button
                type="button"
                onClick={() => handleSetAuditionMode('dry')}
                className={`py-2 px-2 rounded-xl border flex flex-col items-center justify-center transition-all cursor-pointer ${
                  auditionMode === 'dry'
                    ? 'bg-amber-500 text-slate-950 font-bold border-amber-400 shadow-lg shadow-amber-950/50'
                    : 'bg-slate-900/90 text-slate-300 hover:text-white hover:bg-slate-800 border-slate-800'
                }`}
                title="Этап 1: Исходный 'сырой' голос без DSP цепочек (байпас EQ/компрессора)"
              >
                <span className="text-[10px] uppercase font-bold opacity-80">Этап 1</span>
                <span>Dry (Исходный)</span>
              </button>

              {/* 2. Surgical Clean */}
              <button
                type="button"
                onClick={() => handleSetAuditionMode('surgical')}
                className={`py-2 px-2 rounded-xl border flex flex-col items-center justify-center transition-all cursor-pointer ${
                  auditionMode === 'surgical'
                    ? 'bg-teal-500 text-slate-950 font-bold border-teal-400 shadow-lg shadow-teal-950/50'
                    : 'bg-slate-900/90 text-slate-300 hover:text-white hover:bg-slate-800 border-slate-800'
                }`}
                title="Этап 2: Голос после AI-денойза, дереверба и удаления пауз/тишины"
              >
                <span className="text-[10px] uppercase font-bold opacity-80">Этап 2</span>
                <span>Чистка (AI+VAD)</span>
              </button>

              {/* 3. Tonal Shaped */}
              <button
                type="button"
                onClick={() => handleSetAuditionMode('tonal')}
                className={`py-2 px-2 rounded-xl border flex flex-col items-center justify-center transition-all cursor-pointer ${
                  auditionMode === 'tonal'
                    ? 'bg-blue-500 text-slate-950 font-bold border-blue-400 shadow-lg shadow-blue-950/50'
                    : 'bg-slate-900/90 text-slate-300 hover:text-white hover:bg-slate-800 border-slate-800'
                }`}
                title="Этап 3: Голос с тональным эквалайзером и подавлением сибилянтов De-Esser"
              >
                <span className="text-[10px] uppercase font-bold opacity-80">Этап 3</span>
                <span>Tonal (EQ+DeEss)</span>
              </button>

              {/* 4. Ducked Mix */}
              <button
                type="button"
                onClick={() => handleSetAuditionMode('ducked')}
                className={`py-2 px-2 rounded-xl border flex flex-col items-center justify-center transition-all cursor-pointer ${
                  auditionMode === 'ducked'
                    ? 'bg-purple-500 text-white font-bold border-purple-400 shadow-lg shadow-purple-950/50'
                    : 'bg-slate-900/90 text-slate-300 hover:text-white hover:bg-slate-800 border-slate-800'
                }`}
                title="Этап 4: Компрессия речи + сайдчейн-приглушение оригинальной музыки (Auto-Ducker)"
              >
                <span className="text-[10px] uppercase font-bold opacity-80">Этап 4</span>
                <span>Сайдчейн + Comp</span>
              </button>

              {/* 5. Master Output */}
              <button
                type="button"
                onClick={() => handleSetAuditionMode('master')}
                className={`py-2 px-2 rounded-xl border flex flex-col items-center justify-center transition-all cursor-pointer ${
                  auditionMode === 'master'
                    ? 'bg-emerald-500 text-slate-950 font-bold border-emerald-400 shadow-lg shadow-emerald-950/50'
                    : 'bg-slate-900/90 text-slate-300 hover:text-white hover:bg-slate-800 border-slate-800'
                }`}
                title="Этап 5: Финальный EBU R128 микс с калибровкой громкости и мастер-лимитером -0.1 dBFS"
              >
                <span className="text-[10px] uppercase font-bold opacity-80">Этап 5</span>
                <span>Мастер EBU R128</span>
              </button>

              {/* 6. Original Solo */}
              <button
                type="button"
                onClick={() => handleSetAuditionMode('original')}
                className={`py-2 px-2 rounded-xl border flex flex-col items-center justify-center transition-all cursor-pointer ${
                  auditionMode === 'original'
                    ? 'bg-sky-500 text-slate-950 font-bold border-sky-400 shadow-lg shadow-sky-950/50'
                    : 'bg-slate-900/90 text-slate-300 hover:text-white hover:bg-slate-800 border-slate-800'
                }`}
                title="Только оригинальное видео/фонограмма (дубляж заглушен)"
              >
                <span className="text-[10px] uppercase font-bold opacity-80">Видео</span>
                <span>Оригинал соло</span>
              </button>

              {/* 7. Mix Full */}
              <button
                type="button"
                onClick={() => handleSetAuditionMode('mix')}
                className={`py-2 px-2 rounded-xl border flex flex-col items-center justify-center transition-all cursor-pointer ${
                  auditionMode === 'mix'
                    ? 'bg-cyan-500 text-slate-950 font-bold border-cyan-400 shadow-lg shadow-cyan-950/50'
                    : 'bg-slate-900/90 text-slate-300 hover:text-white hover:bg-slate-800 border-slate-800'
                }`}
                title="Полный сбалансированный микс со всеми эффектами"
              >
                <span className="text-[10px] uppercase font-bold opacity-80">Итог</span>
                <span>Полный микс</span>
              </button>
            </div>

            {/* Дополнительные переключатели инструментов и панели телеметрии */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowDspInspector((prev) => !prev)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer border ${
                    showDspInspector
                      ? 'bg-cyan-950/80 text-cyan-300 border-cyan-600'
                      : 'bg-slate-900 text-slate-300 hover:text-white border-slate-800'
                  }`}
                >
                  <SlidersHorizontal size={13} className="text-cyan-400" />
                  <span>Инструменты эффектов & DSP пульт</span>
                  {showDspInspector ? <ChevronRight size={13} className="rotate-90" /> : <ChevronRight size={13} />}
                </button>

                <button
                  type="button"
                  onClick={() => setShowLiveLogs((prev) => !prev)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer border ${
                    showLiveLogs
                      ? 'bg-purple-950/80 text-purple-300 border-purple-600'
                      : 'bg-slate-900 text-slate-300 hover:text-white border-slate-800'
                  }`}
                >
                  <FileText size={13} className="text-purple-400" />
                  <span>Логи и телеметрия конвейера ({logs.length})</span>
                </button>
              </div>

              {/* Отображение параметров текущего пресета */}
              <div className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400">
                <span className="text-slate-500">Пресет:</span>
                <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-cyan-300 font-bold">
                  {activePreset === 'cinema'
                    ? '🎬 Кинотеатр'
                    : activePreset === 'anime'
                    ? '⚡ Аниме'
                    : activePreset === 'podcast'
                    ? '🎙️ Подкаст'
                    : activePreset === 'hifi'
                    ? '💎 Hi-Fi'
                    : '📺 Сбалансированный'}
                </span>
              </div>
            </div>

            {/* РАСКРЫВАЮЩАЯСЯ ПАНЕЛЬ ИНСТРУМЕНТОВ ЭФФЕКТОВ (DSP MATRIX) */}
            {showDspInspector && (
              <div className="pt-3 border-t border-slate-800/80 space-y-3.5 animate-fadeIn">
                {/* Выбор пресетов */}
                <div className="flex flex-wrap items-center justify-between gap-2 bg-[#060a14] p-2.5 rounded-xl border border-slate-800/80">
                  <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <Sparkles size={14} className="text-amber-300" />
                    Быстрые студийные пресеты сведения:
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[
                      { key: 'balanced', label: '📺 Сбалансированный' },
                      { key: 'cinema', label: '🎬 Кинотеатр / Теплый' },
                      { key: 'anime', label: '⚡ Аниме / Яркий' },
                      { key: 'podcast', label: '🎙️ Подкаст / Плотный' },
                      { key: 'hifi', label: '💎 Hi-Fi Broadcast' }
                    ].map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => handleApplyCharacterPreset(p.key)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                          activePreset === p.key
                            ? 'bg-gradient-to-r from-cyan-600 to-purple-600 text-white shadow-md'
                            : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Сетка регулировок отдельных инструментов */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  {/* Инструмент 1: 4-Полосный Эквалайзер (Parametric EQ) */}
                  <div className="p-3 bg-slate-950/80 border border-slate-800/90 rounded-xl space-y-2">
                    <div className="flex items-center justify-between font-bold text-slate-200">
                      <span className="flex items-center gap-1.5 text-blue-400">
                        <Activity size={13} /> 4-Band EQ Pro
                      </span>
                      <label className="flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={toolParams.eqEnabled}
                          onChange={(e) => handleUpdateDSPParam('eqEnabled', e.target.checked)}
                          className="accent-blue-500 rounded"
                        />
                        <span>{toolParams.eqEnabled ? 'Активен' : 'Байпас'}</span>
                      </label>
                    </div>

                    <div className="space-y-1.5 font-mono text-[10px]">
                      <div>
                        <div className="flex justify-between text-slate-400">
                          <span>Низ (100Hz):</span>
                          <span className="text-blue-300 font-bold">{toolParams.eqLowGain > 0 ? `+${toolParams.eqLowGain}` : toolParams.eqLowGain} dB</span>
                        </div>
                        <input
                          type="range"
                          min="-10"
                          max="10"
                          step="0.5"
                          value={toolParams.eqLowGain}
                          onChange={(e) => handleUpdateDSPParam('eqLowGain', parseFloat(e.target.value))}
                          className="w-full accent-blue-500 cursor-pointer"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between text-slate-400">
                          <span>Середина (2.5kHz):</span>
                          <span className="text-blue-300 font-bold">{toolParams.eqMidGain > 0 ? `+${toolParams.eqMidGain}` : toolParams.eqMidGain} dB</span>
                        </div>
                        <input
                          type="range"
                          min="-10"
                          max="10"
                          step="0.5"
                          value={toolParams.eqMidGain}
                          onChange={(e) => handleUpdateDSPParam('eqMidGain', parseFloat(e.target.value))}
                          className="w-full accent-blue-500 cursor-pointer"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between text-slate-400">
                          <span>Воздух (10kHz):</span>
                          <span className="text-blue-300 font-bold">{toolParams.eqHighGain > 0 ? `+${toolParams.eqHighGain}` : toolParams.eqHighGain} dB</span>
                        </div>
                        <input
                          type="range"
                          min="-10"
                          max="10"
                          step="0.5"
                          value={toolParams.eqHighGain}
                          onChange={(e) => handleUpdateDSPParam('eqHighGain', parseFloat(e.target.value))}
                          className="w-full accent-blue-500 cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Инструмент 2: Студийный компрессор (Studio Compressor) */}
                  <div className="p-3 bg-slate-950/80 border border-slate-800/90 rounded-xl space-y-2">
                    <div className="flex items-center justify-between font-bold text-slate-200">
                      <span className="flex items-center gap-1.5 text-purple-400">
                        <Gauge size={13} /> Studio Compressor
                      </span>
                      <label className="flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={toolParams.compEnabled}
                          onChange={(e) => handleUpdateDSPParam('compEnabled', e.target.checked)}
                          className="accent-purple-500 rounded"
                        />
                        <span>{toolParams.compEnabled ? 'Активен' : 'Байпас'}</span>
                      </label>
                    </div>

                    <div className="space-y-1.5 font-mono text-[10px]">
                      <div>
                        <div className="flex justify-between text-slate-400">
                          <span>Порог (Threshold):</span>
                          <span className="text-purple-300 font-bold">{toolParams.compThreshold} dB</span>
                        </div>
                        <input
                          type="range"
                          min="-36"
                          max="-6"
                          step="1"
                          value={toolParams.compThreshold}
                          onChange={(e) => handleUpdateDSPParam('compThreshold', parseFloat(e.target.value))}
                          className="w-full accent-purple-500 cursor-pointer"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between text-slate-400">
                          <span>Ratio:</span>
                          <span className="text-purple-300 font-bold">{toolParams.compRatio}:1</span>
                        </div>
                        <input
                          type="range"
                          min="1.5"
                          max="6.0"
                          step="0.1"
                          value={toolParams.compRatio}
                          onChange={(e) => handleUpdateDSPParam('compRatio', parseFloat(e.target.value))}
                          className="w-full accent-purple-500 cursor-pointer"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between text-slate-400">
                          <span>Атака / Спад:</span>
                          <span className="text-purple-300 font-bold">{toolParams.compAttackMs}ms / {toolParams.compReleaseMs}ms</span>
                        </div>
                        <div className="h-2 rounded bg-slate-900 border border-slate-800 overflow-hidden mt-1">
                          <div
                            className="h-full bg-purple-500 transition-all duration-100"
                            style={{ width: `${Math.min(100, Math.max(10, Math.abs(toolParams.compThreshold) * 2.5))}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Инструмент 3: Деэссер и Сайдчейн Auto-Ducker */}
                  <div className="p-3 bg-slate-950/80 border border-slate-800/90 rounded-xl space-y-2">
                    <div className="flex items-center justify-between font-bold text-slate-200">
                      <span className="flex items-center gap-1.5 text-cyan-400">
                        <Zap size={13} /> De-Esser & Auto-Ducker
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 font-mono">
                        Sidechain: {toolParams.duckerDepth} dB
                      </span>
                    </div>

                    <div className="space-y-1.5 font-mono text-[10px]">
                      <div>
                        <div className="flex justify-between text-slate-400">
                          <span>Деэссер (Частота свистящих):</span>
                          <span className="text-cyan-300 font-bold">{toolParams.deEsserFreq} Hz</span>
                        </div>
                        <input
                          type="range"
                          min="4500"
                          max="8500"
                          step="100"
                          value={toolParams.deEsserFreq}
                          onChange={(e) => handleUpdateDSPParam('deEsserFreq', parseFloat(e.target.value))}
                          className="w-full accent-cyan-500 cursor-pointer"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between text-slate-400">
                          <span>Глубина приглушения музыки:</span>
                          <span className="text-rose-400 font-bold">{toolParams.duckerDepth} dB</span>
                        </div>
                        <input
                          type="range"
                          min="-18"
                          max="-3"
                          step="0.5"
                          value={toolParams.duckerDepth}
                          onChange={(e) => handleUpdateDSPParam('duckerDepth', parseFloat(e.target.value))}
                          className="w-full accent-rose-500 cursor-pointer"
                        />
                      </div>
                      <div className="pt-1 flex items-center justify-between text-slate-400 text-[10px]">
                        <span>Защита от клиппинга:</span>
                        <span className="text-emerald-400 font-bold flex items-center gap-1">
                          <ShieldCheck size={11} /> True Peak -0.1 dBFS
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* РАСКРЫВАЮЩАЯСЯ ПАНЕЛЬ ДЕТАЛЬНОГО ЛОГИРОВАНИЯ И ТЕЛЕМЕТРИИ */}
            {showLiveLogs && (
              <div className="pt-3 border-t border-slate-800/80 space-y-2.5 animate-fadeIn">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1 text-[11px] font-mono">
                    <span className="text-slate-400 mr-1">Фильтр логов:</span>
                    {(['all', 'dsp', 'phases', 'audition', 'errors'] as const).map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setLogCategoryFilter(cat)}
                        className={`px-2 py-0.5 rounded text-[10px] transition-all cursor-pointer ${
                          logCategoryFilter === cat
                            ? 'bg-purple-600 text-white font-bold'
                            : 'bg-slate-900 hover:bg-slate-800 text-slate-400'
                        }`}
                      >
                        {cat === 'all'
                          ? 'Все'
                          : cat === 'dsp'
                          ? '🎛️ DSP'
                          : cat === 'phases'
                          ? '🚀 Фазы'
                          : cat === 'audition'
                          ? '🎧 Этапы'
                          : '❌ Ошибки'}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(logs.join('\n'));
                      alert('Логи конвейера скопированы в буфер обмена!');
                    }}
                    className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg text-[10px] font-mono flex items-center gap-1 cursor-pointer"
                  >
                    <Download size={11} /> Скопировать логи
                  </button>
                </div>

                <div className="p-3 bg-[#040711] border border-slate-800/90 rounded-xl font-mono text-[10px] text-slate-300 space-y-1.5 max-h-48 overflow-y-auto select-text">
                  {logs.length === 0 ? (
                    <div className="text-slate-500 py-4 text-center">Логи конвейера формируются...</div>
                  ) : (
                    logs
                      .filter((l) => {
                        if (logCategoryFilter === 'dsp') return l.includes('DSP') || l.includes('EQ') || l.includes('компрессор') || l.includes('Auto-Ducker');
                        if (logCategoryFilter === 'phases') return l.includes('Шаг') || l.includes('Фаза') || l.includes('конвейер') || l.includes('Мастеринг');
                        if (logCategoryFilter === 'audition') return l.includes('Этап') || l.includes('прослушивания') || l.includes('A/B');
                        if (logCategoryFilter === 'errors') return l.includes('❌') || l.includes('⚠️') || l.includes('Ошибка') || l.includes('коллизий');
                        return true;
                      })
                      .map((logStr, i) => (
                        <div
                          key={`wiz-log-${i}`}
                          className={`p-1 rounded ${
                            logStr.includes('❌')
                              ? 'bg-rose-950/40 text-rose-300'
                              : logStr.includes('⚠️')
                              ? 'bg-amber-950/40 text-amber-300'
                              : logStr.includes('🎧')
                              ? 'bg-cyan-950/30 text-cyan-300'
                              : logStr.includes('🎛️')
                              ? 'bg-purple-950/30 text-purple-300'
                              : 'text-slate-300'
                          }`}
                        >
                          {logStr}
                        </div>
                      ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Статус-сообщение */}
          <div className="p-3.5 bg-slate-900/80 border border-slate-800 rounded-2xl flex items-center gap-3">
            {stage === 'step1_ai_and_norm' || stage === 'step4_master_and_mux' ? (
              <RefreshCw size={18} className="animate-spin text-purple-400 shrink-0" />
            ) : stage === 'step2_collision_check' && collisions.length > 0 ? (
              <AlertTriangle size={18} className="text-rose-400 shrink-0 animate-bounce" />
            ) : stage === 'completed' ? (
              <CheckCircle2 size={18} className="text-emerald-400 shrink-0" />
            ) : (
              <Info size={18} className="text-cyan-400 shrink-0" />
            )}
            <span className="text-xs font-medium text-slate-200">{statusMessage}</span>
          </div>

          {/* ШАГ 1: AI обработка в процессе */}
          {stage === 'step1_ai_and_norm' && (
            <div className="space-y-4 py-6 text-center animate-fadeIn">
              <div className="inline-flex p-4 bg-purple-500/10 border border-purple-500/20 rounded-full text-purple-400 animate-pulse">
                <Zap size={32} />
              </div>
              <div>
                <h4 className="text-sm font-bold text-slate-100">Выполняется авто-очистка и нормализация</h4>
                <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                  Последовательное применение денойза, дереверберации, реставрации спектра и выравнивания целевой громкости до -18 dBFS (EBU R128).
                </p>
              </div>
            </div>
          )}

          {/* ШАГ 2: Детекция коллизий и наездов фраз */}
          {stage === 'step2_collision_check' && (
            <div className="space-y-4 animate-fadeIn">
              {/* Акустические профили дорожек (Анализ шума, тихой речи и авто-порога) */}
              {acousticProfiles.length > 0 && (
                <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-2xl space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                      <SlidersHorizontal size={14} className="text-teal-400" />
                      Акустические параметры дорожек и удаление тишины:
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-300 border border-teal-500/30 font-mono">
                      Нарезано: {totalStrippedPhrases} реплик
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                    {acousticProfiles.map((prof) => (
                      <div
                        key={prof.trackId}
                        className="p-2.5 bg-slate-950/70 border border-slate-800/80 rounded-xl space-y-1"
                      >
                        <div className="font-semibold text-slate-200 truncate flex items-center justify-between">
                          <span className="truncate">{prof.trackName}</span>
                          <span className="text-teal-400 font-mono text-[10px] ml-1">
                            {prof.optimalThresholdDb} dB
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-slate-400">
                          <span>Шум: <b className="text-slate-300">{prof.noiseFloorDb} dB</b></span>
                          <span>Тихая речь: <b className="text-slate-300">{prof.quietestSpeechRmsDb} dB</b></span>
                          <span>SNR: <b className="text-emerald-400">+{prof.snrDb} dB</b></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {collisions.length > 0 ? (
                <div className="space-y-3">
                  <div className="p-4 bg-rose-950/40 border border-rose-500/40 rounded-2xl space-y-2">
                    <div className="flex items-center gap-2 text-rose-300 font-bold text-sm">
                      <AlertTriangle size={18} className="text-rose-400" />
                      <span>Обнаружены коллизии и наезды фраз ({collisions.length} шт.)</span>
                    </div>
                    <p className="text-xs text-rose-200/80">
                      Конвейер автоматически остановлен. Вы можете скорректировать наезжающие клипы вручную на таймлайне или продолжить сведение.
                    </p>
                  </div>

                  {/* Список коллизий */}
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {toSafeArray<ClipCollisionInfo>(collisions).map((col, idx) => (
                      <div
                        key={col.id}
                        className="p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs flex items-center justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                            <span>Конфликт #{idx + 1}: {col.trackAName} $\leftrightarrow$ {col.trackBName}</span>
                          </div>
                          <p className="text-[11px] text-slate-400">
                            Клип &quot;{col.clipAName}&quot; перекрывает &quot;{col.clipBName}&quot; на {col.overlapDurationSec.toFixed(2)} сек (с {col.overlapStartSec.toFixed(1)}s по {col.overlapEndSec.toFixed(1)}s).
                          </p>
                        </div>
                        <button
                          onClick={() => onSeek(col.overlapStartSec)}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded-lg text-[11px] font-medium transition-all shrink-0 cursor-pointer"
                        >
                          Перейти
                        </button>
                      </div>
                    ))}
                  </div>

                  {autoTimingSummary && (
                    <div className="p-3 bg-cyan-950/40 border border-cyan-500/40 rounded-xl text-xs text-cyan-200 flex items-center gap-2 animate-fadeIn">
                      <Zap size={15} className="text-cyan-400 shrink-0" />
                      <span>{autoTimingSummary}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <button
                      onClick={handleStripSilenceInWizard}
                      className="px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-emerald-900/60 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
                      title="Выполнить адаптивное VAD удаление тишины и нарезку всех дорожек на отдельные фразы"
                    >
                      <Scissors size={14} />
                      ✂️ Удалить тишину
                    </button>
                    <button
                      onClick={handleAutoTimingInWizard}
                      disabled={isAutoTimingRunning}
                      className="px-4 py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-lg shadow-cyan-950/40"
                      title="Автоматически сопоставить актёров, совместить фразы по субтитрам и устранить нежелательные наезды"
                    >
                      {isAutoTimingRunning ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />}
                      {isAutoTimingRunning ? 'Авто-разведение...' : '⚡ Авто-тайминг и разведение'}
                    </button>
                    <button
                      onClick={async () => {
                        if (onUpdateAllTracks) {
                          await onUpdateAllTracks(tracks);
                        }
                        if (collisions.length > 0 && onSeek) {
                          onSeek(collisions[0].overlapStartSec);
                        }
                        setIsMinimized(true);
                      }}
                      className="px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
                      title="Свернуть окно и перейти к точке первой коллизии на таймлайне"
                    >
                      <Minimize2 size={14} />
                      Посмотреть на таймлайне
                    </button>
                    <button
                      onClick={handleRecheckCollisions}
                      className="px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <RefreshCw size={14} />
                      Перепроверить
                    </button>
                    <button
                      onClick={handleProceedToVolumeBalance}
                      className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-lg shadow-emerald-950/50"
                    >
                      Продолжить конвейер <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4 py-4 text-center">
                  <div className="inline-flex p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-emerald-400">
                    <CheckCircle2 size={28} />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-100">Наездов фраз не обнаружено!</h4>
                    <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                      Все дикторские дорожки расположена корректно без взаимных перекрытий.
                    </p>
                  </div>
                  <button
                    onClick={handleProceedToVolumeBalance}
                    className="w-full py-3 bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 text-white font-bold rounded-xl text-xs transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xl shadow-purple-950/50"
                  >
                    Перейти к калибровке громкости и Шине Вокала <ChevronRight size={16} />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ШАГ 3: Интерактивная калибровка громкости и Шина Вокала */}
          {stage === 'step3_volume_balance' && (
            <div className="space-y-5 animate-fadeIn">
              <div className="p-4 bg-cyan-950/30 border border-cyan-500/30 rounded-2xl space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Sliders size={14} />
                    Калибровка Баланса Громкости и Шина Вокала
                  </h4>
                  <button
                    onClick={onTogglePlay}
                    className="px-3 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
                  >
                    {isPlaying ? <Pause size={13} /> : <Play size={13} />}
                    {isPlaying ? 'Пауза' : 'Прослушать сведение'}
                  </button>
                </div>
                <p className="text-xs text-slate-300">
                  Проверьте общий баланс в любой части ролика. С помощью Шины Вокала подстройте уровень всех дикторов одновременно, а регуляторами дорожек подкорректируйте отдельный акцент.
                </p>
              </div>

              {/* ИНТЕРАКТИВНЫЙ МИНИ-ТАЙМЛАЙН КОНВЕЙЕРА ДЛЯ БЫСТРОЙ ОЦЕНКИ И НАВИГАЦИИ */}
              <div className="p-4 bg-[#080d1a] border border-cyan-500/50 rounded-2xl space-y-3 shadow-2xl">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 bg-cyan-500/20 text-cyan-400 rounded-lg">
                      <Compass size={14} />
                    </span>
                    <div>
                      <h4 className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                        Навигация по таймлайну и прослушивание
                      </h4>
                      <p className="text-[10px] text-slate-400">
                        Быстрый переход в любое место ролика для проверки баланса громкости
                      </p>
                    </div>
                  </div>

                  {/* Таймкод и кнопка Play */}
                  <div className="flex items-center gap-2">
                    <div className="bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800 font-mono text-xs text-cyan-300 font-bold flex items-center gap-1.5">
                      <Clock size={12} className="text-cyan-400" />
                      <span>{formatCompactTime(currentTimeSec)}</span>
                      <span className="text-slate-600">/</span>
                      <span className="text-slate-400">{formatCompactTime(wizardTotalDurationSec)}</span>
                    </div>

                    <button
                      onClick={onTogglePlay}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow-md ${
                        isPlaying
                          ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-950/40'
                          : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/40'
                      }`}
                    >
                      {isPlaying ? <Pause size={13} /> : <Play size={13} />}
                      <span>{isPlaying ? 'Пауза' : 'Плей'}</span>
                    </button>
                  </div>
                </div>

                {/* Интерактивная полоса скраббера таймлайна */}
                <div className="space-y-1">
                  <div
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                      onSeek(ratio * wizardTotalDurationSec);
                    }}
                    className="relative h-6 bg-[#040711] rounded-xl border border-slate-700/80 overflow-hidden cursor-pointer group shadow-inner flex items-center"
                  >
                    {/* Реплики субтитров на мини-таймлайне */}
                    <div className="absolute inset-0 pointer-events-none flex items-center">
                      {toSafeArray<SubtitleCue>(subtitles).map((cue) => {
                        const leftPct = (cue.startSec / wizardTotalDurationSec) * 100;
                        const widthPct = Math.max(0.5, ((cue.endSec - cue.startSec) / wizardTotalDurationSec) * 100);
                        return (
                          <div
                            key={`wiz-cue-${cue.index}`}
                            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                            className="absolute h-2.5 rounded bg-purple-500/60 group-hover:bg-purple-500/80 transition-colors shadow-xs"
                            title={`#${cue.index} [${cue.speaker || 'Диктор'}]: ${cue.text}`}
                          />
                        );
                      })}
                    </div>

                    {/* Заполненная полоса прогресса */}
                    <div
                      style={{
                        width: `${Math.max(0, Math.min(100, (currentTimeSec / wizardTotalDurationSec) * 100))}%`
                      }}
                      className="absolute left-0 top-0 bottom-0 bg-cyan-500/20 border-r-2 border-cyan-400 pointer-events-none"
                    />

                    {/* Плейхед иголка */}
                    <div
                      style={{
                        left: `${Math.max(0, Math.min(100, (currentTimeSec / wizardTotalDurationSec) * 100))}%`
                      }}
                      className="absolute top-0 bottom-0 w-1 bg-amber-400 z-10 -ml-0.5 shadow-md shadow-amber-400 pointer-events-none flex flex-col items-center justify-between"
                    >
                      <div className="w-2.5 h-2.5 bg-amber-400 rotate-45 rounded-xs" />
                      <div className="w-2.5 h-2.5 bg-amber-400 rotate-45 rounded-xs" />
                    </div>
                  </div>
                </div>

                {/* Кнопки быстрой навигации и прыжков */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] pt-1">
                  <div className="flex items-center gap-1 font-mono">
                    <button
                      onClick={() => handleJumpToPercentage(0)}
                      className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg border border-slate-800 hover:border-slate-700 transition-all cursor-pointer font-semibold"
                      title="Перейти в самое начало (00:00)"
                    >
                      ⏮ Старт 0:00
                    </button>
                    <button
                      onClick={() => handleJumpToPercentage(25)}
                      className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg border border-slate-800 hover:border-slate-700 transition-all cursor-pointer"
                    >
                      25%
                    </button>
                    <button
                      onClick={() => handleJumpToPercentage(50)}
                      className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-cyan-300 rounded-lg border border-cyan-800/60 hover:border-cyan-600 transition-all cursor-pointer font-semibold"
                      title="Перейти в середину ролика"
                    >
                      50% (Середина)
                    </button>
                    <button
                      onClick={() => handleJumpToPercentage(75)}
                      className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg border border-slate-800 hover:border-slate-700 transition-all cursor-pointer"
                    >
                      75%
                    </button>
                    <button
                      onClick={() => onSeek(Math.max(0, wizardTotalDurationSec - 10))}
                      className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg border border-slate-800 hover:border-slate-700 transition-all cursor-pointer"
                      title="Перейти к финалу (-10 сек)"
                    >
                      Финал ⏭
                    </button>
                  </div>

                  {/* Прыжки по фразам и +-5 сек */}
                  <div className="flex items-center gap-1 font-mono">
                    <button
                      onClick={() => handleSeekRelative(-5)}
                      className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg border border-slate-800 hover:border-slate-700 transition-all cursor-pointer"
                      title="Назад на 5 секунд"
                    >
                      -5с
                    </button>
                    <button
                      onClick={() => handleSeekRelative(5)}
                      className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg border border-slate-800 hover:border-slate-700 transition-all cursor-pointer"
                      title="Вперед на 5 секунд"
                    >
                      +5с
                    </button>
                    <button
                      onClick={() => handleJumpToCue('prev')}
                      disabled={toSafeArray(subtitles).length === 0}
                      className="px-2 py-1 bg-purple-950/80 hover:bg-purple-900 text-purple-200 rounded-lg border border-purple-800/80 transition-all cursor-pointer disabled:opacity-40"
                      title="Прыгнуть к предыдущей реплике субтитров"
                    >
                      <SkipBack size={11} className="inline mr-1" />
                      Пред. фраза
                    </button>
                    <button
                      onClick={() => handleJumpToCue('next')}
                      disabled={toSafeArray(subtitles).length === 0}
                      className="px-2 py-1 bg-purple-950/80 hover:bg-purple-900 text-purple-200 rounded-lg border border-purple-800/80 transition-all cursor-pointer disabled:opacity-40"
                      title="Прыгнуть к следующей реплике субтитров"
                    >
                      След. фраза
                      <SkipForward size={11} className="inline ml-1" />
                    </button>
                  </div>
                </div>

                {/* Плашка активной реплики в текущем месте */}
                {activeCurrentCue && (
                  <div className="bg-purple-950/40 border border-purple-500/30 px-3 py-1.5 rounded-xl text-xs flex items-center justify-between gap-2 text-purple-200 animate-fadeIn">
                    <div className="flex items-center gap-2 truncate">
                      <span className="font-bold text-amber-300 shrink-0">
                        #{activeCurrentCue.index} [{activeCurrentCue.speaker || 'Диктор'}]:
                      </span>
                      <span className="text-slate-200 truncate italic">"{activeCurrentCue.text}"</span>
                    </div>
                    <span className="text-[10px] font-mono text-purple-400 shrink-0">
                      {formatCompactTime(activeCurrentCue.startSec)} - {formatCompactTime(activeCurrentCue.endSec)}
                    </span>
                  </div>
                )}
              </div>

              {/* БЛОК АВТОМАТИЧЕСКОГО ВЫРАВНИВАНИЯ ГРОМКОСТИ (СТАНДАРТ ЧИТАЕМОСТИ ЗАКАДРА +3.5..+4.5 dB) */}
              <div className="p-4 bg-[#0d1527] border border-cyan-500/40 rounded-2xl space-y-4 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-cyan-500/20 border border-cyan-500/30 rounded-lg text-cyan-400">
                      <Activity size={16} />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-slate-100 flex items-center gap-2">
                        Анализ и авто-выравнивание громкости
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-mono">
                          Стандарт: +{targetDeltaDb.toFixed(1)} dB
                        </span>
                      </h4>
                      <p className="text-[11px] text-slate-400">
                        Сравнение оригинальной дорожки и мастер-микса для кристальной читаемости речи
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => handleApplyAutoLoudness(targetDeltaDb)}
                    className="px-3 py-1.5 bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-500 hover:to-emerald-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all cursor-pointer shadow-lg shadow-cyan-950/50"
                  >
                    <Zap size={14} className="text-amber-300" />
                    Выровнять (+{targetDeltaDb.toFixed(1)} dB)
                  </button>
                </div>

                {/* Сетка замеров громкости: Оригинал vs Закадр vs Дельта */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono text-xs">
                  {/* Карточка 1: Оригинальная дорожка */}
                  <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1.5">
                    <div className="text-[10px] text-slate-400 uppercase font-sans font-bold flex items-center justify-between">
                      <span>Оригинал (Видео)</span>
                      <Film size={12} className="text-slate-500" />
                    </div>
                    <div className="text-sm font-bold text-slate-200">
                      {loudnessComparison.originalLoudness.speechRmsDb > -80
                        ? `${loudnessComparison.originalLoudness.speechRmsDb} dBFS`
                        : '—'}
                    </div>
                    <div className="text-[10px] text-slate-400 flex items-center justify-between">
                      <span>True Peak:</span>
                      <span className="text-slate-300">
                        {loudnessComparison.originalLoudness.peakDb > -80
                          ? `${loudnessComparison.originalLoudness.peakDb} dB`
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Карточка 2: Закадровый микс */}
                  <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1.5">
                    <div className="text-[10px] text-purple-400 uppercase font-sans font-bold flex items-center justify-between">
                      <span>Мастер-голос (Закадр)</span>
                      <Mic size={12} className="text-purple-400" />
                    </div>
                    <div className="text-sm font-bold text-purple-300">
                      {loudnessComparison.dubbedLoudness.speechRmsDb > -80
                        ? `${loudnessComparison.dubbedLoudness.speechRmsDb} dBFS`
                        : '—'}
                    </div>
                    <div className="text-[10px] text-slate-400 flex items-center justify-between">
                      <span>True Peak:</span>
                      <span
                        className={
                          loudnessComparison.isPeakSafe ? 'text-emerald-400' : 'text-amber-400'
                        }
                      >
                        {loudnessComparison.dubbedLoudness.peakDb > -80
                          ? `${loudnessComparison.dubbedLoudness.peakDb} dB`
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Карточка 3: Разница громкости */}
                  <div
                    className={`p-3 rounded-xl border space-y-1.5 ${
                      loudnessComparison.status === 'optimal'
                        ? 'bg-emerald-950/20 border-emerald-500/40 text-emerald-300'
                        : loudnessComparison.status === 'too_quiet'
                        ? 'bg-amber-950/20 border-amber-500/40 text-amber-300'
                        : 'bg-cyan-950/20 border-cyan-500/40 text-cyan-300'
                    }`}
                  >
                    <div className="text-[10px] uppercase font-sans font-bold flex items-center justify-between">
                      <span>Разница ($\Delta$)</span>
                      <Gauge size={12} />
                    </div>
                    <div className="text-sm font-bold">
                      {loudnessComparison.currentDeltaDb > 0 ? '+' : ''}
                      {loudnessComparison.currentDeltaDb} dB
                    </div>
                    <div className="text-[10px] flex items-center justify-between">
                      <span>Статус:</span>
                      <span className="font-sans font-medium text-[10px]">
                        {loudnessComparison.status === 'optimal'
                          ? 'Идеально'
                          : loudnessComparison.status === 'too_quiet'
                          ? 'Тише нормы'
                          : 'Громче нормы'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Подстройка целевого стандарта и опция авто-рендера */}
                <div className="space-y-2 pt-1 border-t border-slate-800/80">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 flex items-center gap-1.5 font-medium">
                      <SlidersHorizontal size={13} className="text-cyan-400" />
                      Целевое превышение над оригиналом:
                    </span>
                    <span className="font-mono font-bold text-cyan-400">+{targetDeltaDb.toFixed(1)} dB</span>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-mono text-slate-500">3.5 dB</span>
                    <input
                      type="range"
                      min="3.5"
                      max="4.5"
                      step="0.1"
                      value={targetDeltaDb}
                      onChange={(e) => setTargetDeltaDb(parseFloat(e.target.value))}
                      className="flex-1 accent-cyan-400 cursor-pointer"
                    />
                    <span className="text-[10px] font-mono text-slate-500">4.5 dB</span>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={() => handleApplyAutoLoudness()}
                      className="px-3 py-1.5 bg-cyan-900/40 hover:bg-cyan-800/60 border border-cyan-500/40 rounded-lg text-xs text-cyan-200 transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm active:scale-95"
                    >
                      <Zap size={13} className="text-cyan-400" />
                      <span>Применить авто-баланс к плееру (+{targetDeltaDb.toFixed(1)} dB)</span>
                    </button>
                    <span className="text-[10px] text-emerald-400 font-mono flex items-center gap-1">
                      <ShieldCheck size={12} /> Limiter -0.1 dB
                    </span>
                  </div>
                </div>
              </div>

              {/* Управление Шиной Вокала */}
              <div className="p-4 bg-[#111827] border border-slate-800 rounded-2xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-purple-300 flex items-center gap-1.5">
                    <Mic size={14} />
                    Шина вокала (Vocal Bus Master)
                  </span>
                  <span className="text-xs font-mono font-bold text-purple-400">
                    {(currentVocalBus?.volumeDb ?? 0) > 0
                      ? `+${(currentVocalBus?.volumeDb ?? 0).toFixed(1)}`
                      : (currentVocalBus?.volumeDb ?? 0).toFixed(1)}{' '}
                    dB
                  </span>
                </div>
                <input
                  type="range"
                  min="-24"
                  max="12"
                  step="0.5"
                  value={currentVocalBus?.volumeDb ?? 0}
                  onInput={(e) => {
                    const val = parseFloat((e.target as HTMLInputElement).value);
                    handleVocalBusVolumeChange(val);
                  }}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    handleVocalBusVolumeChange(val);
                  }}
                  className="w-full accent-purple-500 cursor-pointer"
                />
              </div>

              {/* Громкости отдельных дорожек */}
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Громкость и баланс индивидуальных дорожек:
                  </span>
                  {toSafeArray<TrackState>(tracks).some((t) => t.mute || t.solo) && (
                    <button
                      type="button"
                      onClick={() => {
                        const unmuted = toSafeArray<TrackState>(tracks).map((t) => ({ ...t, mute: false, solo: false }));
                        setTracks(unmuted);
                        if (onUpdateAllTracks) onUpdateAllTracks(unmuted);
                      }}
                      className="text-[10px] text-amber-300 hover:text-amber-200 underline cursor-pointer"
                    >
                      Сбросить Solo/Mute (Включить всё)
                    </button>
                  )}
                </div>

                {toSafeArray<TrackState>(tracks).map((track) => (
                  <div
                    key={track.id}
                    className={`p-3 bg-slate-900 border rounded-xl flex items-center justify-between gap-3 text-xs transition-colors ${
                      track.mute
                        ? 'opacity-60 border-slate-800'
                        : track.solo
                        ? 'border-amber-500/60 bg-amber-950/20'
                        : 'border-slate-800'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 w-36 shrink-0">
                      {/* Кнопка Mute */}
                      <button
                        type="button"
                        onClick={() => {
                          const updated = toSafeArray<TrackState>(tracks).map((t) =>
                            t.id === track.id ? { ...t, mute: !t.mute } : t
                          );
                          setTracks(updated);
                          if (onUpdateAllTracks) onUpdateAllTracks(updated);
                        }}
                        className={`w-5 h-5 rounded flex items-center justify-center font-bold text-[10px] transition-colors cursor-pointer ${
                          track.mute
                            ? 'bg-rose-600 text-white font-bold'
                            : 'bg-slate-800 text-slate-400 hover:text-white'
                        }`}
                        title={track.mute ? 'Включить звук дорожки (Unmute)' : 'Заглушить дорожку (Mute)'}
                      >
                        M
                      </button>

                      {/* Кнопка Solo */}
                      <button
                        type="button"
                        onClick={() => {
                          const updated = toSafeArray<TrackState>(tracks).map((t) =>
                            t.id === track.id ? { ...t, solo: !t.solo } : t
                          );
                          setTracks(updated);
                          if (onUpdateAllTracks) onUpdateAllTracks(updated);
                        }}
                        className={`w-5 h-5 rounded flex items-center justify-center font-bold text-[10px] transition-colors cursor-pointer ${
                          track.solo
                            ? 'bg-amber-500 text-slate-950 font-bold'
                            : 'bg-slate-800 text-slate-400 hover:text-white'
                        }`}
                        title={track.solo ? 'Выключить Solo' : 'Соло дорожки (Solo)'}
                      >
                        S
                      </button>

                      <span className="font-medium text-slate-200 truncate" title={track.name}>
                        {track.name}
                      </span>
                    </div>

                    <input
                      type="range"
                      min="-30"
                      max="12"
                      step="0.5"
                      value={track.volumeDb}
                      onInput={(e) => {
                        const val = parseFloat((e.target as HTMLInputElement).value);
                        setTracks((prev) =>
                          toSafeArray<TrackState>(prev).map((t) => (t.id === track.id ? { ...t, volumeDb: val } : t))
                        );
                        if (onTrackVolumeChange) onTrackVolumeChange(track.id, val);
                      }}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        setTracks((prev) =>
                          toSafeArray<TrackState>(prev).map((t) => (t.id === track.id ? { ...t, volumeDb: val } : t))
                        );
                        if (onTrackVolumeChange) onTrackVolumeChange(track.id, val);
                      }}
                      className="flex-1 accent-cyan-500 cursor-pointer"
                    />
                    <span className="font-mono text-[11px] text-slate-400 w-14 text-right">
                      {track.volumeDb > 0 ? `+${track.volumeDb.toFixed(1)}` : track.volumeDb.toFixed(1)} dB
                    </span>
                  </div>
                ))}
              </div>

              <button
                onClick={handleProceedToFinalMasterAndMux}
                className="w-full py-3 bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-500 hover:to-emerald-500 text-white font-bold rounded-xl text-xs transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xl shadow-cyan-950/50"
              >
                <Sparkles size={16} className="text-amber-300" />
                Завершить сведение и зашить в видео
              </button>
            </div>
          )}

          {/* ШАГ 4: Финальный мастеринг и муксинг */}
          {stage === 'step4_master_and_mux' && (
            <div className="space-y-4 py-8 text-center animate-fadeIn">
              <div className="inline-flex p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-emerald-400 animate-spin">
                <RefreshCw size={32} />
              </div>
              <div>
                <h4 className="text-sm font-bold text-slate-100">Выполняется C++ рендеринг и вшивание в видео</h4>
                <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                  Применение лимитера мастер-шины (-0.1 dBFS), генерация RIFF WAV 48 кГц / 24-bit и подмена аудиопотока в видеофайле через FFmpeg WASM.
                </p>
              </div>
            </div>
          )}

          {/* ФИНАЛ: Завершено */}
          {stage === 'completed' && (
            <div className="space-y-5 animate-fadeIn text-center py-2">
              <div className="inline-flex p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-full text-emerald-400">
                <CheckCircle2 size={36} />
              </div>
              <div>
                <h4 className="text-base font-bold text-slate-100">Сведение закадрового видео успешно завершено!</h4>
                <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                  Готовый MP4 файл автоматически сохранен в подпапку <code className="text-emerald-300 font-mono">project/</code> вашего проекта.
                </p>
              </div>

              {resultVideoUrl && (
                <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl space-y-3 max-w-lg mx-auto">
                  <video src={resultVideoUrl} controls className="w-full rounded-xl bg-black max-h-48" />
                  <div className="flex items-center justify-between text-xs text-slate-300 pt-1">
                    <span className="truncate max-w-[200px] font-mono">{resultFileName}</span>
                    {resultBlob && (
                      <span className="text-slate-400">{(resultBlob.size / (1024 * 1024)).toFixed(2)} МБ</span>
                    )}
                  </div>
                  <a
                    href={resultVideoUrl}
                    download={resultFileName}
                    className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-emerald-950/50"
                  >
                    <Download size={15} />
                    Скачать готовое видео MP4
                  </a>
                </div>
              )}

              <button
                onClick={onClose}
                className="px-6 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition-all cursor-pointer"
              >
                Закрыть окно
              </button>
            </div>
          )}

          {/* ОШИБКА */}
          {stage === 'error' && (
            <div className="space-y-4 py-4 text-center">
              <div className="inline-flex p-3 bg-rose-500/10 border border-rose-500/20 rounded-full text-rose-400">
                <AlertTriangle size={28} />
              </div>
              <div>
                <h4 className="text-sm font-bold text-rose-300">Сбой выполнения конвейера</h4>
                <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">{errorMessage}</p>
              </div>
              <button
                onClick={startPipeline}
                className="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition-all inline-flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw size={14} />
                Повторить запуск
              </button>
            </div>
          )}

          {/* Логи конвейера */}
          {logs.length > 0 && (
            <div className="mt-4 pt-3 border-t border-slate-800/80 space-y-1">
              <span className="text-[10px] font-mono font-bold text-slate-500 uppercase">Лог операций:</span>
              <div className="p-2.5 bg-[#050811] border border-slate-800 rounded-xl font-mono text-[10px] text-slate-400 space-y-1 max-h-28 overflow-y-auto">
                {toSafeArray<string>(logs).map((log, i) => (
                  <div key={i}>{log}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
