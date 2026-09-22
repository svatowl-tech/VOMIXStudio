import React, { useState, useEffect } from 'react';
import { Header, NavigationTab } from './components/Header';
import { TrackStrip } from './components/TrackStrip';
import { MasterSection } from './components/MasterSection';
import { TimelineView } from './components/TimelineView';
import { CppSourceCodeViewer } from './components/CppSourceCodeViewer';
import { AudioUploader } from './components/AudioUploader';
import { DubbingAIStudio } from './components/DubbingAIStudio';
import { VideoMonitor } from './components/VideoMonitor';
import { ExportStudio } from './components/ExportStudio';
import { ProjectWorkspace } from './components/ProjectWorkspace';
import { MinimalStudio } from './components/MinimalStudio';
import { VSTPluginManager } from './components/VSTPluginManager';
import { LogConsole } from './components/LogConsole';
import { ConsoleStatusBar } from './components/ConsoleStatusBar';
import { MediaImportModal } from './components/MediaImportModal';
import { useAudioEngine } from './hooks/useAudioEngine';
import { TrackState, MasterState, LiveDAWEngine, createNewTrack, VocalBusState, createDefaultVocalBus } from './audio/dawEngine';
import { VSTPluginInstance } from './audio/vstTypes';
import { MVPPreset } from './services/MVPPresetManager';
import { SubtitleLine } from './services/AudioAIEngine';
import { SubtitleCue } from './services/ProjectManager';
import { MediaNormalizer } from './services/MediaNormalizer';
import { FULL_CPP_CODE, BUILD_WASM_SCRIPT } from './data/cppCode';
import { Sparkles } from 'lucide-react';
import { toSafeArray, toSafeMap } from './utils/safeIterables';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavigationTab>('minimal');
  const [showGlobalImportModal, setShowGlobalImportModal] = useState<boolean>(false);

  const {
    isInitialized,
    isPlaying,
    isAudioWorkletActive,
    currentTimeSec,
    error: audioEngineError,
    trackMeters,
    masterMeter,
    initAudioEngine,
    togglePlay,
    seek,
    uploadAudioFileToTrack,
    uploadRawPCMToTrack,
    syncAllTracks,
    syncTrackClips,
    setTrackVolume,
    setTrackPan,
    setTrackSolo,
    setTrackMute,
    setTrackEq,
    setTrackCompressor,
    setTrackAutoDucker,
    setMasterVolume,
    setMasterLimiter,
    setTrackVstChain,
    setVocalBusVstChain,
    setMasterVstChain,
    updateVstParameter,
    setVstBypass,
    setVstWetDry,
    performLoudnessMatching
  } = useAudioEngine();

  // Локальное UI-состояние параметров треков и мастера с фильтрацией валидности
  const [tracks, setTracks] = useState<TrackState[]>(() => {
    const defaultTracks = new LiveDAWEngine().getTracks();
    return toSafeArray<TrackState>(defaultTracks);
  });

  const [vocalBus, setVocalBusState] = useState<VocalBusState>(() => createDefaultVocalBus());

  const [master, setMaster] = useState<MasterState>({
    volumeDb: 0,
    pan: 0,
    limiterCeilingDb: -0.1,
    limiterEnabled: true,
    vstPlugins: [],
    peakL: 0,
    peakR: 0,
    clipped: false
  });

  // Общее состояние видеофайла и субтитров с гарантией итерируемости
  const [sourceVideoFile, setSourceVideoFile] = useState<File | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleLine[]>(() =>
    toSafeArray<SubtitleLine>([
      { index: 1, startSec: 0.5, endSec: 3.5, text: 'Добро пожаловать в автономную WebAssembly студию дубляжа.', speaker: 'Актёр 1' },
      { index: 2, startSec: 4.2, endSec: 7.8, text: 'Низкоуровневый C++ микшер суммирует дорожки без задержки.', speaker: 'Актёр 1' },
      { index: 3, startSec: 8.5, endSec: 12.0, text: 'Авто-дакинг автоматически приглушает фоновую музыку во время речи.', speaker: 'Диктор' },
      { index: 4, startSec: 12.5, endSec: 15.5, text: 'FFmpeg в браузере вшивает новый звук в видеоряд без потери качества.', speaker: 'Диктор' }
    ])
  );

  // Синхронизация реальных пиков телеметрии из AudioWorklet с полной защитой от null/undefined
  useEffect(() => {
    setTracks((prevTracks) => {
      const safePrev = toSafeArray<TrackState>(prevTracks);
      return safePrev.map((t) => {
        const m = trackMeters ? trackMeters.get(t.id) : null;
        if (m) {
          return { ...t, peakL: m.peakL ?? 0, peakR: m.peakR ?? 0 };
        }
        return t;
      });
    });
  }, [trackMeters]);

  useEffect(() => {
    if (!masterMeter) return;
    setMaster((prev) => ({
      ...prev,
      peakL: masterMeter.peakL ?? 0,
      peakR: masterMeter.peakR ?? 0,
      clipped: Boolean(masterMeter.clipped)
    }));
  }, [masterMeter]);

  const handleUpdateTrack = (updatedTrack: TrackState) => {
    if (!updatedTrack) return;
    setTracks((prev) =>
      toSafeArray<TrackState>(prev).map((t) => (t.id === updatedTrack.id ? updatedTrack : t))
    );

    // Передаем изменения в AudioWorklet
    setTrackVolume(updatedTrack.id, updatedTrack.volumeDb ?? 0);
    setTrackPan(updatedTrack.id, updatedTrack.pan ?? 0);
    setTrackSolo(updatedTrack.id, Boolean(updatedTrack.solo));
    setTrackMute(updatedTrack.id, Boolean(updatedTrack.mute));

    if (updatedTrack.eq) {
      setTrackEq(updatedTrack.id, {
        lowGain: updatedTrack.eq.lowShelf?.gainDb ?? 0,
        midGain: updatedTrack.eq.peaking?.gainDb ?? 0,
        highGain: updatedTrack.eq.highShelf?.gainDb ?? 0
      });
    }

    if (updatedTrack.compressor) {
      setTrackCompressor(updatedTrack.id, {
        threshold: updatedTrack.compressor.thresholdDb ?? -12,
        ratio: updatedTrack.compressor.ratio ?? 4,
        attack: updatedTrack.compressor.attackMs ?? 10,
        release: updatedTrack.compressor.releaseMs ?? 100,
        knee: updatedTrack.compressor.kneeDb ?? 6,
        makeup: updatedTrack.compressor.makeupGainDb ?? 0
      });
    }

    if (updatedTrack.autoDucker) {
      setTrackAutoDucker(updatedTrack.id, {
        enabled: Boolean(updatedTrack.autoDucker.enabled),
        threshold: updatedTrack.autoDucker.thresholdDb ?? -24,
        depth: updatedTrack.autoDucker.duckDepthDb ?? -12,
        sourceTrackId: updatedTrack.autoDucker.sourceTrackId ?? 1
      });
    }
  };

  const handleUpdateMaster = (updatedMaster: MasterState) => {
    if (!updatedMaster) return;
    setMaster(updatedMaster);
    setMasterVolume(updatedMaster.volumeDb ?? 0);
    setMasterLimiter(Boolean(updatedMaster.limiterEnabled), updatedMaster.limiterCeilingDb ?? -0.1);
  };

  const handleUpdateTrackVstChain = (trackId: number, vstPlugins: VSTPluginInstance[]) => {
    const safePlugins = toSafeArray<VSTPluginInstance>(vstPlugins);
    setTracks((prev) =>
      toSafeArray<TrackState>(prev).map((t) =>
        t.id === trackId ? { ...t, vstPlugins: safePlugins } : t
      )
    );
    setTrackVstChain(trackId, safePlugins);
  };

  const handleUpdateVocalBusVstChain = (vstPlugins: VSTPluginInstance[]) => {
    const safePlugins = toSafeArray<VSTPluginInstance>(vstPlugins);
    setVocalBusState((prev) => ({ ...prev, vstPlugins: safePlugins }));
    setVocalBusVstChain(safePlugins);
  };

  const handleUpdateMasterVstChain = (vstPlugins: VSTPluginInstance[]) => {
    const safePlugins = toSafeArray<VSTPluginInstance>(vstPlugins);
    setMaster((prev) => ({ ...prev, vstPlugins: safePlugins }));
    setMasterVstChain(safePlugins);
  };

  const handleUpdateVstParam = (
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    paramId: string,
    value: number,
    trackId?: number
  ) => {
    if (target === 'track' && trackId !== undefined) {
      setTracks((prev) =>
        toSafeArray<TrackState>(prev).map((t) => {
          if (t.id !== trackId) return t;
          const plugins = toSafeArray<VSTPluginInstance>(t.vstPlugins).map((p) =>
            p.instanceId === instanceId
              ? { ...p, parameters: { ...p.parameters, [paramId]: value } }
              : p
          );
          return { ...t, vstPlugins: plugins };
        })
      );
    } else if (target === 'vocalBus') {
      setVocalBusState((prev) => {
        const plugins = toSafeArray<VSTPluginInstance>(prev.vstPlugins).map((p) =>
          p.instanceId === instanceId
            ? { ...p, parameters: { ...p.parameters, [paramId]: value } }
            : p
        );
        return { ...prev, vstPlugins: plugins };
      });
    } else if (target === 'master') {
      setMaster((prev) => {
        const plugins = toSafeArray<VSTPluginInstance>(prev.vstPlugins).map((p) =>
          p.instanceId === instanceId
            ? { ...p, parameters: { ...p.parameters, [paramId]: value } }
            : p
        );
        return { ...prev, vstPlugins: plugins };
      });
    }
    updateVstParameter(target, instanceId, paramId, value, trackId);
  };

  const handleUpdateVstBypass = (
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    enabled: boolean,
    trackId?: number
  ) => {
    if (target === 'track' && trackId !== undefined) {
      setTracks((prev) =>
        toSafeArray<TrackState>(prev).map((t) => {
          if (t.id !== trackId) return t;
          const plugins = toSafeArray<VSTPluginInstance>(t.vstPlugins).map((p) =>
            p.instanceId === instanceId ? { ...p, enabled } : p
          );
          return { ...t, vstPlugins: plugins };
        })
      );
    } else if (target === 'vocalBus') {
      setVocalBusState((prev) => {
        const plugins = toSafeArray<VSTPluginInstance>(prev.vstPlugins).map((p) =>
          p.instanceId === instanceId ? { ...p, enabled } : p
        );
        return { ...prev, vstPlugins: plugins };
      });
    } else if (target === 'master') {
      setMaster((prev) => {
        const plugins = toSafeArray<VSTPluginInstance>(prev.vstPlugins).map((p) =>
          p.instanceId === instanceId ? { ...p, enabled } : p
        );
        return { ...prev, vstPlugins: plugins };
      });
    }
    setVstBypass(target, instanceId, enabled, trackId);
  };

  const handleUpdateVstWetDry = (
    target: 'track' | 'vocalBus' | 'master',
    instanceId: string,
    wetDry: number,
    trackId?: number
  ) => {
    if (target === 'track' && trackId !== undefined) {
      setTracks((prev) =>
        toSafeArray<TrackState>(prev).map((t) => {
          if (t.id !== trackId) return t;
          const plugins = toSafeArray<VSTPluginInstance>(t.vstPlugins).map((p) =>
            p.instanceId === instanceId ? { ...p, wetDry } : p
          );
          return { ...t, vstPlugins: plugins };
        })
      );
    } else if (target === 'vocalBus') {
      setVocalBusState((prev) => {
        const plugins = toSafeArray<VSTPluginInstance>(prev.vstPlugins).map((p) =>
          p.instanceId === instanceId ? { ...p, wetDry } : p
        );
        return { ...prev, vstPlugins: plugins };
      });
    } else if (target === 'master') {
      setMaster((prev) => {
        const plugins = toSafeArray<VSTPluginInstance>(prev.vstPlugins).map((p) =>
          p.instanceId === instanceId ? { ...p, wetDry } : p
        );
        return { ...prev, vstPlugins: plugins };
      });
    }
    setVstWetDry(target, instanceId, wetDry, trackId);
  };

  const handleApplyGlobalPreset = (preset: MVPPreset) => {
    if (!preset) return;
    if (preset.vocalBusSettings?.vstChain) {
      handleUpdateVocalBusVstChain(toSafeArray(preset.vocalBusSettings.vstChain));
    }
    if (preset.masterSettings?.vstChain) {
      handleUpdateMasterVstChain(toSafeArray(preset.masterSettings.vstChain));
    }
    const safeTracks = toSafeArray<TrackState>(tracks);
    const safeTrackVstChain = toSafeArray<VSTPluginInstance>(preset.trackVstChain);
    if (safeTrackVstChain.length > 0 && safeTracks.length > 0) {
      safeTracks.forEach((tr) => {
        if (tr) handleUpdateTrackVstChain(tr.id, safeTrackVstChain);
      });
    }
  };

  const handleLoadProjectState = (state: any) => {
    if (!state) return;
    if (state.master) {
      setMaster((prev) => ({
        ...prev,
        volumeDb: state.master.volumeDb ?? prev.volumeDb,
        limiterEnabled: state.master.limiterEnabled ?? prev.limiterEnabled,
        limiterCeilingDb: state.master.limiterCeilingDb ?? prev.limiterCeilingDb,
        vstPlugins: toSafeArray(state.master.vstPlugins ?? prev.vstPlugins)
      }));
    }
    const loadedTracks = toSafeArray<any>(state.tracks);
    if (loadedTracks.length > 0) {
      setTracks((prev) =>
        toSafeArray<TrackState>(prev).map((t) => {
          const matched = loadedTracks.find((st: any) => st && st.id === t.id);
          if (matched) {
            return {
              ...t,
              name: matched.name || t.name,
              volumeDb: matched.volumeDb ?? t.volumeDb,
              pan: matched.pan ?? t.pan,
              solo: Boolean(matched.solo ?? t.solo),
              mute: Boolean(matched.mute ?? t.mute),
              clips: toSafeArray(matched.clips ?? t.clips),
              vstPlugins: toSafeArray(matched.vstPlugins ?? t.vstPlugins)
            };
          }
          return t;
        })
      );
    }
    if (state.subtitles) {
      setSubtitles(toSafeArray<SubtitleLine>(state.subtitles));
    }
  };

  const handleImportMediaFiles = async (data: { videoFile?: File; audioFiles: { file: File; name: string }[] }) => {
    if (!data) return;
    if (data.videoFile) {
      setSourceVideoFile(data.videoFile);
    }
    const audioList = toSafeArray<{ file: File; name: string }>(data.audioFiles);
    const currentTracks = toSafeArray<TrackState>(tracks);
    for (let i = 0; i < audioList.length && i < currentTracks.length; i++) {
      const item = audioList[i];
      const targetTrack = currentTracks[i];
      if (item && item.file && targetTrack) {
        await handleFileUpload(item.file, targetTrack.id);
      }
    }
  };

  const [loudnessStatus, setLoudnessStatus] = useState<string | null>(null);

  const handleFileUpload = async (file: File, trackId: number) => {
    if (!file) return;
    const res = await uploadAudioFileToTrack(file, trackId, Date.now(), 0);
    setTracks((prev) => {
      const safePrev = toSafeArray<TrackState>(prev);
      return safePrev.map((t) => {
        if (t.id === trackId) {
          const currentClips = toSafeArray<any>(t.clips);
          return {
            ...t,
            clips: [
              ...currentClips,
              {
                id: Date.now(),
                name: file.name,
                offsetSamples: 0,
                lengthSamples: res.samplesCount,
                gain: 1.0,
                pan: 0,
                fadeInSamples: 0,
                fadeOutSamples: 0,
                buffer: res.pcmData,
                color: t.color
              }
            ]
          };
        }
        return t;
      });
    });
  };

  /**
   * Сброс дорожек при создании нового проекта
   */
  const handleResetProjectState = () => {
    const initialTr = createNewTrack(1, 'Дублер 1 (Диалоги)', '#10b981');
    initialTr.clips = [];
    setTracks([initialTr]);
    setSourceVideoFile(null);
    setSubtitles([]);
  };

  /**
   * Импорт видео через модальный хаб с гарантией целостности структуры
   */
  const handleModalImportVideo = async (videoFile: File, audioPcm?: Float32Array) => {
    if (!videoFile) return;
    setSourceVideoFile(videoFile);
    if (audioPcm && audioPcm.length > 0) {
      let actualTargetTrackId = 1;
      const totalFrames = Math.floor(audioPcm.length / 2);
      const clipId = Date.now();

      setTracks((prev) => {
        const safePrev = toSafeArray<TrackState>(prev);
        const videoClip = {
          id: clipId,
          name: `🎬 Оригинал_${videoFile.name}`,
          offsetSamples: 0,
          lengthSamples: totalFrames,
          gain: 1.0,
          pan: 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          buffer: audioPcm,
          color: '#06b6d4'
        };

        // 1. Ищем, есть ли уже отдельная видео-дорожка
        const existingVidTrack = safePrev.find(
          (t) =>
            t &&
            t.name &&
            (t.name.includes('Звук видео') ||
              t.name.includes('Видео-звук') ||
              t.name.includes('Оригинал') ||
              t.name.includes('🎬'))
        );

        if (existingVidTrack) {
          actualTargetTrackId = existingVidTrack.id;
          return safePrev.map((t) =>
            t.id === existingVidTrack.id
              ? {
                  ...t,
                  name: `🎬 Оригинальный звук [${videoFile.name}]`,
                  isOriginalAudio: true,
                  clips: [videoClip]
                }
              : t
          );
        }

        // 2. Проверяем, свободна ли Первая дорожка
        if (
          safePrev.length > 0 &&
          toSafeArray(safePrev[0].clips).length === 0 &&
          (safePrev[0].name.includes('Дорожка') || safePrev[0].name.includes('Track'))
        ) {
          actualTargetTrackId = safePrev[0].id;
          return safePrev.map((t, idx) =>
            idx === 0
              ? {
                  ...t,
                  name: `🎬 Оригинальный звук [${videoFile.name}]`,
                  color: '#06b6d4',
                  isOriginalAudio: true,
                  clips: [videoClip]
                }
              : t
          );
        }

        // 3. Иначе создаем новую отдельную дорожку
        const newTrackId = safePrev.length > 0 ? Math.max(...safePrev.map((t) => t.id)) + 1 : 1;
        actualTargetTrackId = newTrackId;
        const newTr = createNewTrack(newTrackId, `🎬 Оригинальный звук [${videoFile.name}]`, '#06b6d4');
        newTr.isOriginalAudio = true;
        newTr.clips = [videoClip];
        return [newTr, ...safePrev];
      });

      uploadRawPCMToTrack(audioPcm, actualTargetTrackId, clipId, 0, 1.0, 0.0, true);
    }
  };

  /**
   * Импорт аудиодорожки через модальный хаб
   */
  const handleModalImportAudioTrack = async (
    file: File,
    pcmBuffer: Float32Array,
    config: { name: string; trackId?: number; color?: string; replaceExisting?: boolean }
  ) => {
    if (!file || !pcmBuffer) return;
    const totalFrames = Math.floor(pcmBuffer.length / 2);
    const clipId = Date.now();
    let effectiveTrackId = config?.trackId;

    const isOriginal = /оригинал|original|видео|video|отригал|orig/i.test(config?.name || file.name);

    setTracks((prev) => {
      const safePrev = toSafeArray<TrackState>(prev);
      if (!effectiveTrackId || !config?.replaceExisting) {
        const nextId = effectiveTrackId || (safePrev.length > 0 ? Math.max(...safePrev.map((t) => t.id)) + 1 : 1);
        effectiveTrackId = nextId;
        const newTrack = createNewTrack(nextId, config?.name || file.name, config?.color);
        newTrack.isOriginalAudio = isOriginal;
        newTrack.clips = [
          {
            id: clipId,
            name: file.name,
            offsetSamples: 0,
            lengthSamples: totalFrames,
            gain: 1.0,
            pan: 0,
            fadeInSamples: 0,
            fadeOutSamples: 0,
            buffer: pcmBuffer,
            color: config?.color || newTrack.color
          }
        ];
        return [...safePrev, newTrack];
      } else {
        return safePrev.map((t) =>
          t.id === effectiveTrackId
            ? {
                ...t,
                name: config?.name || t.name,
                color: config?.color || t.color,
                isOriginalAudio: isOriginal || t.isOriginalAudio,
                clips: [
                  {
                    id: clipId,
                    name: file.name,
                    offsetSamples: 0,
                    lengthSamples: totalFrames,
                    gain: 1.0,
                    pan: 0,
                    fadeInSamples: 0,
                    fadeOutSamples: 0,
                    buffer: pcmBuffer,
                    color: config?.color || t.color
                  }
                ]
              }
            : t
        );
      }
    });

    if (effectiveTrackId) {
      uploadRawPCMToTrack(pcmBuffer, effectiveTrackId, clipId, 0, 1.0, 0.0, true);
    }
  };

  /**
   * Добавление стем-дорожек (вокал + минус) с гарантированным наличием клипов
   */
  const handleAddStemTracks = (
    vocalsPcm: Float32Array,
    karaokePcm: Float32Array,
    vocalsName = 'Изолированный вокал оригинала',
    karaokeName = 'Фонограмма M&E'
  ) => {
    if (!vocalsPcm || !karaokePcm) return;
    const vocLen = Math.floor(vocalsPcm.length / 2);
    const karLen = Math.floor(karaokePcm.length / 2);
    const vocClipId = Date.now();
    const karClipId = Date.now() + 1;

    let nextId1 = 1;
    let nextId2 = 2;

    setTracks((prev) => {
      const safePrev = toSafeArray<TrackState>(prev);
      nextId1 = safePrev.length > 0 ? Math.max(...safePrev.map((t) => t.id)) + 1 : 1;
      nextId2 = nextId1 + 1;

      const trackVoc = createNewTrack(nextId1, vocalsName, '#10b981');
      trackVoc.clips = [
        {
          id: vocClipId,
          name: `${vocalsName}.wav`,
          offsetSamples: 0,
          lengthSamples: vocLen,
          gain: 1.0,
          pan: 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          buffer: vocalsPcm,
          color: '#10b981'
        }
      ];

      const trackKar = createNewTrack(nextId2, karaokeName, '#06b6d4');
      trackKar.clips = [
        {
          id: karClipId,
          name: `${karaokeName}.wav`,
          offsetSamples: 0,
          lengthSamples: karLen,
          gain: 1.0,
          pan: 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          buffer: karaokePcm,
          color: '#06b6d4'
        }
      ];

      return [...safePrev, trackVoc, trackKar];
    });

    uploadRawPCMToTrack(vocalsPcm, nextId1, vocClipId, 0, 1.0, 0, true);
    uploadRawPCMToTrack(karaokePcm, nextId2, karClipId, 0, 1.0, 0, true);
  };

  /**
   * Замена / Наложение обработанного AI аудио на дорожку
   */
  const handleApplyProcessedAudioToTrack = (
    trackId: number,
    newPcm: Float32Array,
    clipName = 'Обработанное аудио'
  ) => {
    if (!newPcm) return;
    const totalFrames = Math.floor(newPcm.length / 2);
    const clipId = Date.now();

    setTracks((prev) => {
      const safePrev = toSafeArray<TrackState>(prev);
      return safePrev.map((t) =>
        t.id === trackId
          ? {
              ...t,
              clips: [
                {
                  id: clipId,
                  name: clipName,
                  offsetSamples: 0,
                  lengthSamples: totalFrames,
                  gain: 1.0,
                  pan: 0,
                  fadeInSamples: 0,
                  fadeOutSamples: 0,
                  buffer: newPcm,
                  color: t.color
                }
              ]
            }
          : t
      );
    });

    uploadRawPCMToTrack(newPcm, trackId, clipId, 0, 1.0, 0, true);
  };

  const handleAddTrack = () => {
    setTracks((prev) => {
      const safePrev = toSafeArray<TrackState>(prev);
      const newId = safePrev.length > 0 ? Math.max(...safePrev.map((t) => t.id)) + 1 : 1;
      const newTr = createNewTrack(newId, `CH #${newId}: Актер / Озвучка`, '#10b981');
      newTr.clips = [];
      return [...safePrev, newTr];
    });
  };

  const handleAutoMatchLoudness = () => {
    const safeTracks = toSafeArray<TrackState>(tracks);
    const res = performLoudnessMatching(safeTracks, -18.0, -1.0);
    const safeAdjustments = toSafeArray(res?.adjustments);
    setLoudnessStatus(
      `Выровнено ${safeAdjustments.length} дорожек по EBU R128 (-18 LUFS). Максимальный пик: ${(res?.maxPeakDb ?? -1.0).toFixed(1)} dBFS.`
    );
    setTimeout(() => setLoudnessStatus(null), 5000);
  };

  return (
    <div className="min-h-screen bg-[#070a10] text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-black">
      {/* Шапка приложения */}
      <Header
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenImportModal={() => setShowGlobalImportModal(true)}
      />

      {/* Ошибка инициализации C++ ядра */}
      {audioEngineError && (
        <div className="bg-rose-950/80 border-b border-rose-800 text-rose-200 px-4 py-2 text-xs flex items-center justify-between font-mono animate-fade-in">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
            <span>{audioEngineError}</span>
          </div>
          <button
            onClick={initAudioEngine}
            className="px-2 py-0.5 bg-rose-800 hover:bg-rose-700 text-white rounded text-[11px] transition-colors"
          >
            Перезапустить ядро
          </button>
        </div>
      )}

      {/* Статус автобаланса громкости */}
      {loudnessStatus && (
        <div className="bg-emerald-950/80 border-b border-emerald-800 text-emerald-200 px-4 py-1.5 text-xs flex items-center gap-2 font-mono">
          <Sparkles size={14} className="text-emerald-400" />
          <span>{loudnessStatus}</span>
        </div>
      )}

      {/* Основная рабочая область в зависимости от активной вкладки */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {activeTab === 'minimal' && <MinimalStudio />}

        {activeTab === 'studio' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <TimelineView
              tracks={tracks}
              currentTimeSec={currentTimeSec}
              totalTimeSec={30}
              isPlaying={isPlaying}
              onSeek={seek}
              onUpdateTrack={handleUpdateTrack}
              syncAllTracks={syncAllTracks}
              syncTrackClips={syncTrackClips}
              videoFile={sourceVideoFile}
              onTogglePlay={togglePlay}
            />
          </div>
        )}

        {activeTab === 'ai-dubbing' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-[#070a10]">
            <DubbingAIStudio
              tracks={tracks}
              currentTimeSec={currentTimeSec}
              onSeek={seek}
              onAddStemTracks={handleAddStemTracks}
              onApplyProcessedAudioToTrack={handleApplyProcessedAudioToTrack}
            />
          </div>
        )}

        {activeTab === 'vst' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-[#070a10]">
            <VSTPluginManager />
          </div>
        )}

        {activeTab === 'export' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-[#070a10]">
            <ExportStudio
              tracks={tracks}
              master={master}
              sourceVideoFile={sourceVideoFile}
            />
          </div>
        )}

        {activeTab === 'project' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-[#070a10]">
            <ProjectWorkspace
              tracks={tracks}
              master={master}
              sourceVideoFile={sourceVideoFile}
              onLoadProjectState={handleLoadProjectState}
              onImportMediaFiles={handleImportMediaFiles}
            />
          </div>
        )}

        {activeTab === 'cpp' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-[#070a10]">
            <CppSourceCodeViewer
              cppCode={FULL_CPP_CODE}
              buildScript={BUILD_WASM_SCRIPT}
            />
          </div>
        )}

        {activeTab === 'console' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-[#070a10]">
            <LogConsole />
          </div>
        )}
      </main>

      {/* Компактный и чистый футер приложения без громоздких текстов */}
      <footer className="bg-[#070a12] border-t border-slate-800/80 px-4 py-1 flex items-center justify-between text-[11px] font-mono text-slate-500 select-none shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-400">VOMIXStudio</span>
          <span className="text-slate-600">v1.0.0</span>
          <span className="text-slate-700">•</span>
          <span className="text-slate-500">© 2026 VOMIX DAW Labs</span>
        </div>
        <div className="flex items-center gap-2 text-slate-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span>Аппаратное ускорение: WebAssembly &amp; GPU</span>
        </div>
      </footer>

      {/* Компактная статусная строка управления */}
      <ConsoleStatusBar
        isWorkletActive={isAudioWorkletActive}
        isAudioInitialized={isInitialized}
      />

      {/* Глобальное модальное окно импорта файлов */}
      {showGlobalImportModal && (
        <MediaImportModal
          isOpen={showGlobalImportModal}
          onClose={() => setShowGlobalImportModal(false)}
          existingTracks={tracks}
          onImportVideo={handleModalImportVideo}
          onImportAudioTrack={handleModalImportAudioTrack}
        />
      )}
    </div>
  );
}
