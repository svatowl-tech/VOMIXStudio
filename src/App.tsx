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
import { Sparkles, Cpu, Layers, Terminal, Zap, ShieldCheck, Upload, Film, Video, Wand2, Volume2, CheckCircle2 } from 'lucide-react';

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

  // Локальное UI-состояние параметров треков и мастера
  const [tracks, setTracks] = useState<TrackState[]>(() => {
    return new LiveDAWEngine().getTracks();
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

  // Общее состояние видеофайла и субтитров
  const [sourceVideoFile, setSourceVideoFile] = useState<File | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleLine[]>([
    { index: 1, startSec: 0.5, endSec: 3.5, text: 'Добро пожаловать в автономную WebAssembly студию дубляжа.', speaker: 'Актёр 1' },
    { index: 2, startSec: 4.2, endSec: 7.8, text: 'Низкоуровневый C++ микшер суммирует дорожки без задержки.', speaker: 'Актёр 1' },
    { index: 3, startSec: 8.5, endSec: 12.0, text: 'Авто-дакинг автоматически приглушает фоновую музыку во время речи.', speaker: 'Диктор' },
    { index: 4, startSec: 12.5, endSec: 15.5, text: 'FFmpeg в браузере вшивает новый звук в видеоряд без потери качества.', speaker: 'Диктор' }
  ]);

  // Синхронизация реальных пиков телеметрии из AudioWorklet
  useEffect(() => {
    setTracks((prevTracks) =>
      prevTracks.map((t) => {
        const m = trackMeters.get(t.id);
        if (m) {
          return { ...t, peakL: m.peakL, peakR: m.peakR };
        }
        return t;
      })
    );
  }, [trackMeters]);

  useEffect(() => {
    setMaster((prev) => ({
      ...prev,
      peakL: masterMeter.peakL,
      peakR: masterMeter.peakR,
      clipped: masterMeter.clipped
    }));
  }, [masterMeter]);

  const handleUpdateTrack = (updatedTrack: TrackState) => {
    setTracks((prev) => prev.map((t) => (t.id === updatedTrack.id ? updatedTrack : t)));

    // Передаем изменения в AudioWorklet
    setTrackVolume(updatedTrack.id, updatedTrack.volumeDb);
    setTrackPan(updatedTrack.id, updatedTrack.pan);
    setTrackSolo(updatedTrack.id, updatedTrack.solo);
    setTrackMute(updatedTrack.id, updatedTrack.mute);

    setTrackEq(updatedTrack.id, {
      lowGain: updatedTrack.eq.lowShelf.gainDb,
      midGain: updatedTrack.eq.peaking.gainDb,
      highGain: updatedTrack.eq.highShelf.gainDb
    });

    setTrackCompressor(updatedTrack.id, {
      threshold: updatedTrack.compressor.thresholdDb,
      ratio: updatedTrack.compressor.ratio,
      attack: updatedTrack.compressor.attackMs,
      release: updatedTrack.compressor.releaseMs,
      knee: updatedTrack.compressor.kneeDb,
      makeup: updatedTrack.compressor.makeupGainDb
    });

    setTrackAutoDucker(updatedTrack.id, {
      enabled: updatedTrack.autoDucker.enabled,
      threshold: updatedTrack.autoDucker.thresholdDb,
      depth: updatedTrack.autoDucker.duckDepthDb,
      sourceTrackId: updatedTrack.autoDucker.sourceTrackId
    });
  };

  const handleUpdateMaster = (updatedMaster: MasterState) => {
    setMaster(updatedMaster);
    setMasterVolume(updatedMaster.volumeDb);
    setMasterLimiter(updatedMaster.limiterEnabled, updatedMaster.limiterCeilingDb);
  };

  const handleUpdateTrackVstChain = (trackId: number, vstPlugins: VSTPluginInstance[]) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, vstPlugins } : t))
    );
    setTrackVstChain(trackId, vstPlugins);
  };

  const handleUpdateVocalBusVstChain = (vstPlugins: VSTPluginInstance[]) => {
    setVocalBusState((prev) => ({ ...prev, vstPlugins }));
    setVocalBusVstChain(vstPlugins);
  };

  const handleUpdateMasterVstChain = (vstPlugins: VSTPluginInstance[]) => {
    setMaster((prev) => ({ ...prev, vstPlugins }));
    setMasterVstChain(vstPlugins);
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
        prev.map((t) => {
          if (t.id !== trackId) return t;
          const plugins = (t.vstPlugins || []).map((p) =>
            p.instanceId === instanceId
              ? { ...p, parameters: { ...p.parameters, [paramId]: value } }
              : p
          );
          return { ...t, vstPlugins: plugins };
        })
      );
    } else if (target === 'vocalBus') {
      setVocalBusState((prev) => {
        const plugins = (prev.vstPlugins || []).map((p) =>
          p.instanceId === instanceId
            ? { ...p, parameters: { ...p.parameters, [paramId]: value } }
            : p
        );
        return { ...prev, vstPlugins: plugins };
      });
    } else if (target === 'master') {
      setMaster((prev) => {
        const plugins = (prev.vstPlugins || []).map((p) =>
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
        prev.map((t) => {
          if (t.id !== trackId) return t;
          const plugins = (t.vstPlugins || []).map((p) =>
            p.instanceId === instanceId ? { ...p, enabled } : p
          );
          return { ...t, vstPlugins: plugins };
        })
      );
    } else if (target === 'vocalBus') {
      setVocalBusState((prev) => {
        const plugins = (prev.vstPlugins || []).map((p) =>
          p.instanceId === instanceId ? { ...p, enabled } : p
        );
        return { ...prev, vstPlugins: plugins };
      });
    } else if (target === 'master') {
      setMaster((prev) => {
        const plugins = (prev.vstPlugins || []).map((p) =>
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
        prev.map((t) => {
          if (t.id !== trackId) return t;
          const plugins = (t.vstPlugins || []).map((p) =>
            p.instanceId === instanceId ? { ...p, wetDry } : p
          );
          return { ...t, vstPlugins: plugins };
        })
      );
    } else if (target === 'vocalBus') {
      setVocalBusState((prev) => {
        const plugins = (prev.vstPlugins || []).map((p) =>
          p.instanceId === instanceId ? { ...p, wetDry } : p
        );
        return { ...prev, vstPlugins: plugins };
      });
    } else if (target === 'master') {
      setMaster((prev) => {
        const plugins = (prev.vstPlugins || []).map((p) =>
          p.instanceId === instanceId ? { ...p, wetDry } : p
        );
        return { ...prev, vstPlugins: plugins };
      });
    }
    setVstWetDry(target, instanceId, wetDry, trackId);
  };

  const handleApplyGlobalPreset = (preset: MVPPreset) => {
    if (preset.vocalBusSettings?.vstChain) {
      handleUpdateVocalBusVstChain(preset.vocalBusSettings.vstChain);
    }
    if (preset.masterSettings?.vstChain) {
      handleUpdateMasterVstChain(preset.masterSettings.vstChain);
    }
    if (preset.trackVstChain && tracks.length > 0) {
      tracks.forEach((tr) => {
        handleUpdateTrackVstChain(tr.id, preset.trackVstChain);
      });
    }
  };

  const handleLoadProjectState = (state: any) => {
    if (state.master) {
      setMaster((prev) => ({
        ...prev,
        volumeDb: state.master.volumeDb ?? prev.volumeDb,
        limiterEnabled: state.master.limiterEnabled ?? prev.limiterEnabled,
        limiterCeilingDb: state.master.limiterCeilingDb ?? prev.limiterCeilingDb,
      }));
    }
    if (Array.isArray(state.tracks)) {
      setTracks((prev) =>
        prev.map((t) => {
          const matched = state.tracks.find((st: any) => st.id === t.id);
          if (matched) {
            return {
              ...t,
              name: matched.name || t.name,
              volumeDb: matched.volumeDb ?? t.volumeDb,
              pan: matched.pan ?? t.pan,
              solo: matched.solo ?? t.solo,
              mute: matched.mute ?? t.mute,
            };
          }
          return t;
        })
      );
    }
    if (Array.isArray(state.subtitles) && state.subtitles.length > 0) {
      setSubtitles(state.subtitles);
    }
  };

  const handleImportMediaFiles = async (data: { videoFile?: File; audioFiles: { file: File; name: string }[] }) => {
    if (data.videoFile) {
      setSourceVideoFile(data.videoFile);
    }
    for (let i = 0; i < data.audioFiles.length && i < tracks.length; i++) {
      const { file } = data.audioFiles[i];
      const targetTrack = tracks[i];
      await handleFileUpload(file, targetTrack.id);
    }
  };

  const [loudnessStatus, setLoudnessStatus] = useState<string | null>(null);

  const handleFileUpload = async (file: File, trackId: number) => {
    const res = await uploadAudioFileToTrack(file, trackId, Date.now(), 0);
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id === trackId) {
          return {
            ...t,
            clips: [
              ...t.clips,
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
      })
    );
  };

  /**
   * Сброс дорожек при создании нового проекта
   */
  const handleResetProjectState = () => {
    setTracks([createNewTrack(1, 'Дублер 1 (Диалоги)', '#10b981')]);
    setSourceVideoFile(null);
    setSubtitles([]);
  };

  /**
   * Импорт видео через модальный хаб
   */
  const handleModalImportVideo = async (videoFile: File, audioPcm?: Float32Array) => {
    setSourceVideoFile(videoFile);
    if (audioPcm && audioPcm.length > 0) {
      let actualTargetTrackId = 1;
      const totalFrames = audioPcm.length / 2;
      const clipId = Date.now();

      setTracks((prev) => {
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
        const existingVidTrack = prev.find(
          (t) =>
            t.name.includes('Звук видео') ||
            t.name.includes('Видео-звук') ||
            t.name.includes('Оригинал') ||
            t.name.includes('🎬')
        );

        if (existingVidTrack) {
          actualTargetTrackId = existingVidTrack.id;
          return prev.map((t) =>
            t.id === existingVidTrack.id
              ? {
                  ...t,
                  name: `🎬 Оригинальный звук [${videoFile.name}]`,
                  clips: [videoClip]
                }
              : t
          );
        }

        // 2. Проверяем, свободна ли Первая дорожка
        if (prev.length > 0 && prev[0].clips.length === 0 && (prev[0].name.includes('Дорожка') || prev[0].name.includes('Track'))) {
          actualTargetTrackId = prev[0].id;
          return prev.map((t, idx) =>
            idx === 0
              ? {
                  ...t,
                  name: `🎬 Оригинальный звук [${videoFile.name}]`,
                  color: '#06b6d4',
                  clips: [videoClip]
                }
              : t
          );
        }

        // 3. Иначе создаем новую отдельную дорожку
        const newTrackId = prev.length > 0 ? Math.max(...prev.map((t) => t.id)) + 1 : 1;
        actualTargetTrackId = newTrackId;
        const newTr = createNewTrack(newTrackId, `🎬 Оригинальный звук [${videoFile.name}]`, '#06b6d4');
        newTr.clips = [videoClip];
        return [newTr, ...prev];
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
    const totalFrames = pcmBuffer.length / 2;
    const clipId = Date.now();
    let effectiveTrackId = config.trackId;

    setTracks((prev) => {
      if (!effectiveTrackId || !config.replaceExisting) {
        const nextId = effectiveTrackId || (prev.length > 0 ? Math.max(...prev.map((t) => t.id)) + 1 : 1);
        effectiveTrackId = nextId;
        const newTrack = createNewTrack(nextId, config.name, config.color);
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
            color: config.color || newTrack.color
          }
        ];
        return [...prev, newTrack];
      } else {
        return prev.map((t) =>
          t.id === effectiveTrackId
            ? {
                ...t,
                name: config.name || t.name,
                color: config.color || t.color,
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
                    color: config.color || t.color
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
   * Импорт субтитров через модальный хаб
   */
  const handleModalImportSubtitles = async (cues: SubtitleCue[]) => {
    const lines: SubtitleLine[] = cues.map((c) => ({
      index: c.index,
      startSec: c.startSec,
      endSec: c.endSec,
      text: c.text,
      speaker: c.speaker || 'Голос'
    }));
    setSubtitles(lines);
  };

  /**
   * Запуск автоматического выравнивания громкости дорожек (Loudness Matching)
   */
  const handleAutoMatchLoudness = (targetRmsDb = -18.0) => {
    const result = performLoudnessMatching(tracks, targetRmsDb, -1.0);
    setTracks(result.updatedTracks);

    const activeAdjustments = result.adjustments.filter((a) => !a.isSilent);
    if (activeAdjustments.length === 0) {
      setLoudnessStatus('Нет активных аудиодорожек с сигналом для выравнивания.');
    } else {
      const summary = activeAdjustments
        .map((a) => `${a.trackName}: ${a.gainChangeDb > 0 ? '+' : ''}${a.gainChangeDb} dB`)
        .join(', ');
      setLoudnessStatus(`Выровнена громкость (${targetRmsDb} dBFS): ${summary}`);
    }

    setTimeout(() => setLoudnessStatus(null), 6000);
  };

  /**
   * Добавление сгенерированных AI стемов (Вокал + M&E) на дорожки DAW
   */
  const handleAddStemTracks = (
    vocalsPcm: Float32Array,
    karaokePcm: Float32Array,
    vocalsName = 'Изолированный вокал оригинала',
    karaokeName = 'Фонограмма M&E'
  ) => {
    const vocLen = Math.floor(vocalsPcm.length / 2);
    const karLen = Math.floor(karaokePcm.length / 2);
    const vocClipId = Date.now();
    const karClipId = Date.now() + 1;

    setTracks((prev) => {
      const nextId1 = prev.length > 0 ? Math.max(...prev.map((t) => t.id)) + 1 : 1;
      const nextId2 = nextId1 + 1;

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

      return [...prev, trackVoc, trackKar];
    });

    uploadRawPCMToTrack(vocalsPcm, tracks.length + 1, vocClipId, 0, 1.0, 0, true);
    uploadRawPCMToTrack(karaokePcm, tracks.length + 2, karClipId, 0, 1.0, 0, true);
  };

  /**
   * Применение очищенного или спектрально подкорректированного аудио к существующей дорожке
   */
  const handleApplyProcessedAudioToTrack = (
    trackId: number,
    newPcm: Float32Array,
    clipName = 'Обработанное аудио'
  ) => {
    const totalFrames = Math.floor(newPcm.length / 2);
    const clipId = Date.now();

    setTracks((prev) =>
      prev.map((t) =>
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
      )
    );

    uploadRawPCMToTrack(newPcm, trackId, clipId, 0, 1.0, 0, true);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-slate-950">
      {/* Top Navigation */}
      <Header
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenImportModal={() => setShowGlobalImportModal(true)}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Audio Engine Error Alert */}
        {audioEngineError && (
          <div className="bg-rose-500/10 border border-rose-500/30 p-4 rounded-xl text-rose-300 text-xs font-mono">
            <strong>Ошибка аудиодвижка:</strong> {audioEngineError}
          </div>
        )}

        {/* Tab 0: Minimal Studio MVP Pipeline */}
        <div className={activeTab === 'minimal' ? 'space-y-6 animate-fadeIn' : 'hidden'}>
          <MinimalStudio />
        </div>

        {/* Tab 1: Interactive Live Studio DAW */}
        {activeTab === 'studio' && (
          <div className="space-y-6 animate-fadeIn">
            {/* DSP Loudness Matching Toolbar */}
            <div className="bg-[#121622] border border-[#232d42] p-3.5 rounded-xl flex flex-wrap items-center justify-between gap-3 shadow-lg">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-blue-400">
                  <Volume2 size={16} />
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                    DSP Loudness Matching & Peak Guard (EBU R128 / Broadcast Normalization)
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Автоматическое приведение дорожек к единому RMS уровню без клиппинга (True Peak ≤ -1.0 dBFS)
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  id="btn-match-loudness-dialog"
                  onClick={() => handleAutoMatchLoudness(-18.0)}
                  className="px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
                  title="Выровнять дорожки под уровень речи -18 dBFS"
                >
                  <Wand2 size={13} className="text-blue-400" />
                  Auto-Match Dialog (-18 dBFS)
                </button>

                <button
                  id="btn-match-loudness-music"
                  onClick={() => handleAutoMatchLoudness(-14.0)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer"
                  title="Выровнять под стандарты стриминга -14 dBFS"
                >
                  <Wand2 size={13} className="text-purple-400" />
                  Streaming (-14 dBFS)
                </button>
              </div>
            </div>

            {/* Loudness Status Toast / Banner */}
            {loudnessStatus && (
              <div className="bg-blue-950/40 border border-blue-500/30 p-3 rounded-lg text-blue-300 text-xs flex items-center gap-2 animate-fadeIn">
                <CheckCircle2 size={15} className="text-blue-400 shrink-0" />
                <span>{loudnessStatus}</span>
              </div>
            )}
            <div className="bg-slate-900/90 border border-emerald-500/30 p-4 rounded-xl flex flex-wrap items-center justify-between gap-4 shadow-lg">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400">
                  <Sparkles size={18} />
                </div>
                <div>
                  <h2 className="text-xs sm:text-sm font-bold text-slate-200 flex items-center gap-2">
                    AudioWorklet DAW Infrastructure & WASM Bridge
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                      {isAudioWorkletActive ? 'AudioWorklet Thread Running' : 'Web Audio API Ready'}
                    </span>
                  </h2>
                  <p className="text-xs text-slate-400">
                    Многодорожечный аудиомикшер с передачей команды через MessagePort, декодированием WAV/MP3 и измерением Peak/RMS в фоновом аудиопотоке.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
                {!isInitialized && (
                  <button
                    onClick={initAudioEngine}
                    className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold text-xs transition-all shadow-md shadow-emerald-900/20 flex items-center gap-1.5 cursor-pointer"
                  >
                    <Zap size={14} /> Инициализировать AudioWorklet
                  </button>
                )}
                <span className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-950 border border-slate-800 rounded">
                  <ShieldCheck size={13} className="text-emerald-400" />
                  Zero Underruns
                </span>
              </div>
            </div>

            {/* Transport & Master Fader */}
            <MasterSection
              master={master}
              isPlaying={isPlaying}
              onTogglePlay={togglePlay}
              onReset={() => seek(0)}
              onUpdateMaster={handleUpdateMaster}
            />

            {/* Audio File Upload Rack for Tracks */}
            <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-3">
              <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                <Upload size={14} className="text-emerald-400" />
                Загрузка собственных аудиофайлов (WAV / MP3) в WASM Память
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {tracks.map((t) => (
                  <AudioUploader
                    key={t.id}
                    trackId={t.id}
                    trackName={t.name}
                    onFileUpload={handleFileUpload}
                  />
                ))}
              </div>
            </div>

            {/* Multitrack Timeline */}
            <TimelineView
              tracks={tracks}
              currentTimeSec={currentTimeSec}
              isPlaying={isPlaying}
              onSeek={seek}
              onUpdateTrack={handleUpdateTrack}
              syncAllTracks={syncAllTracks}
              syncTrackClips={syncTrackClips}
            />

            {/* Multitrack Mixer Channel Strips */}
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                <Cpu size={14} className="text-emerald-400" />
                Многодорожечный микшер и C++ DSP каналы
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {tracks.map((track) => (
                  <TrackStrip
                    key={track.id}
                    track={track}
                    allTracks={tracks}
                    onUpdateTrack={handleUpdateTrack}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tab: Industrial VST & CLAP Plugin Host / Directory Manager */}
        <div className={activeTab === 'vst' ? 'space-y-6 animate-fadeIn' : 'hidden'}>
          <VSTPluginManager />
        </div>

        {/* Tab: Local Project Manager (File System Access API) */}
        <div className={activeTab === 'project' ? 'space-y-6 animate-fadeIn' : 'hidden'}>
          <ProjectWorkspace
            tracks={tracks}
            master={master}
            sourceVideoFile={sourceVideoFile}
            onLoadProjectState={handleLoadProjectState}
            onImportMediaFiles={handleImportMediaFiles}
          />
        </div>

        {/* Tab 2: Video Monitor & Frame Sync */}
        <div className={activeTab === 'video' ? 'space-y-6 animate-fadeIn' : 'hidden'}>
          {/* Top Info Banner */}
          <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl flex flex-wrap items-center justify-between gap-4 shadow-lg">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-cyan-500/10 border border-cyan-500/20 rounded-xl text-cyan-400">
                <Video size={20} />
              </div>
              <div>
                <h2 className="text-xs sm:text-sm font-bold text-slate-200 flex items-center gap-2">
                  Frame-Accurate Video Monitor
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-mono">
                    Subtitles & Timecode Drift Auto-Correction
                  </span>
                </h2>
                <p className="text-xs text-slate-400">
                  Покадровая синхронизация видеоряда с аудиоядром DAW, просмотр субтитров в реальном времени и покадровый шаг.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8">
              <VideoMonitor
                currentTimeSec={currentTimeSec}
                isPlaying={isPlaying}
                onSeek={seek}
                onTogglePlay={togglePlay}
                subtitles={subtitles}
                onVideoLoaded={(file) => setSourceVideoFile(file)}
              />
            </div>

            {/* Subtitles & Cue List */}
            <div className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3 flex flex-col max-h-[500px]">
              <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center justify-between border-b border-slate-800 pb-2">
                <span>Реплики субтитров (SRT)</span>
                <span className="text-[10px] font-mono text-cyan-400">{subtitles.length} реплик</span>
              </h3>

              <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-thin scrollbar-thumb-slate-800">
                {subtitles.map((cue) => {
                  const isActive = currentTimeSec >= cue.startSec && currentTimeSec <= cue.endSec;
                  return (
                    <div
                      key={cue.index}
                      onClick={() => seek(cue.startSec)}
                      className={`p-3 rounded-lg border text-xs cursor-pointer transition-all ${
                        isActive
                          ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200 shadow-md'
                          : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                      }`}
                    >
                      <div className="flex items-center justify-between font-mono text-[10px] mb-1">
                        <span className={isActive ? 'text-emerald-400 font-bold' : 'text-slate-500'}>
                          {cue.speaker || 'Голос'}
                        </span>
                        <span className="text-slate-500">
                          {cue.startSec.toFixed(2)}s - {cue.endSec.toFixed(2)}s
                        </span>
                      </div>
                      <p className={`font-sans leading-snug ${isActive ? 'text-white font-medium' : ''}`}>
                        {cue.text}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Quick Timeline underneath Video */}
          <TimelineView
            tracks={tracks}
            currentTimeSec={currentTimeSec}
            isPlaying={isPlaying}
            onSeek={seek}
            onUpdateTrack={handleUpdateTrack}
          />
        </div>

        {/* Tab 3: AI Dubbing, Silero VAD & Smart Alignment */}
        <div className={activeTab === 'ai-dubbing' ? 'space-y-6 animate-fadeIn' : 'hidden'}>
          <DubbingAIStudio
            tracks={tracks}
            currentTimeSec={currentTimeSec}
            onSeek={seek}
            onAddStemTracks={handleAddStemTracks}
            onApplyProcessedAudioToTrack={handleApplyProcessedAudioToTrack}
          />
        </div>

        {/* Tab 4: Export Studio & FFmpeg WASM Video Muxer */}
        <div className={activeTab === 'export' ? 'space-y-6 animate-fadeIn' : 'hidden'}>
          <ExportStudio
            tracks={tracks}
            master={master}
            sourceVideoFile={sourceVideoFile}
          />
        </div>

        {/* Tab 5 & 6: C++ Source Code & Emscripten Build Guide */}
        {(activeTab === 'cpp' || activeTab === 'emcc') && (
          <div className="space-y-6">
            <CppSourceCodeViewer
              cppCode={FULL_CPP_CODE}
              buildScript={BUILD_WASM_SCRIPT}
            />
          </div>
        )}

        {/* Tab 7: System Log Console & Runtime Diagnostics */}
        {activeTab === 'console' && (
          <div className="space-y-6 animate-fadeIn">
            <LogConsole />
          </div>
        )}
      </main>

      {/* Floating / Sticky Console & System Status Bar */}
      <ConsoleStatusBar
        isWorkletActive={isAudioWorkletActive}
        isAudioInitialized={isInitialized}
      />

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-slate-950 py-3 px-6 text-center text-xs text-slate-500 font-mono">
        FFmpeg WASM Video Muxing • C++17 DSP Audio Core • AudioWorklet Bridge • Silero VAD ONNX Web
      </footer>

      {/* Единый модальный хаб импорта медиаматериалов */}
      <MediaImportModal
        isOpen={showGlobalImportModal}
        onClose={() => setShowGlobalImportModal(false)}
        existingTracks={tracks}
        currentVideoFile={sourceVideoFile}
        onResetProjectState={handleResetProjectState}
        onImportVideo={handleModalImportVideo}
        onImportAudioTrack={handleModalImportAudioTrack}
        onImportSubtitles={handleModalImportSubtitles}
      />
    </div>
  );
}
