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
import { LogConsole } from './components/LogConsole';
import { ConsoleStatusBar } from './components/ConsoleStatusBar';
import { useAudioEngine } from './hooks/useAudioEngine';
import { TrackState, MasterState, LiveDAWEngine } from './audio/dawEngine';
import { SubtitleLine } from './services/AudioAIEngine';
import { MediaNormalizer } from './services/MediaNormalizer';
import { FULL_CPP_CODE, BUILD_WASM_SCRIPT } from './data/cppCode';
import { Sparkles, Cpu, Layers, Terminal, Zap, ShieldCheck, Upload, Film, Video, Wand2, Volume2, CheckCircle2 } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavigationTab>('studio');

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
    setTrackVolume,
    setTrackPan,
    setTrackSolo,
    setTrackMute,
    setTrackEq,
    setTrackCompressor,
    setTrackAutoDucker,
    setMasterVolume,
    setMasterLimiter,
    performLoudnessMatching
  } = useAudioEngine();

  // Локальное UI-состояние параметров треков и мастера
  const [tracks, setTracks] = useState<TrackState[]>(() => {
    return new LiveDAWEngine().getTracks();
  });

  const [master, setMaster] = useState<MasterState>({
    volumeDb: 0,
    pan: 0,
    limiterCeilingDb: -0.1,
    limiterEnabled: true,
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-slate-950">
      {/* Top Navigation */}
      <Header activeTab={activeTab} onSelectTab={setActiveTab} />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Audio Engine Error Alert */}
        {audioEngineError && (
          <div className="bg-rose-500/10 border border-rose-500/30 p-4 rounded-xl text-rose-300 text-xs font-mono">
            <strong>Ошибка аудиодвижка:</strong> {audioEngineError}
          </div>
        )}

        {/* Tab 0: Minimal Studio MVP Pipeline */}
        {activeTab === 'minimal' && (
          <div className="space-y-6 animate-fadeIn">
            <MinimalStudio />
          </div>
        )}

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

        {/* Tab: Local Project Manager (File System Access API) */}
        {activeTab === 'project' && (
          <div className="space-y-6 animate-fadeIn">
            <ProjectWorkspace
              tracks={tracks}
              master={master}
              sourceVideoFile={sourceVideoFile}
              onLoadProjectState={handleLoadProjectState}
              onImportMediaFiles={handleImportMediaFiles}
            />
          </div>
        )}

        {/* Tab 2: Video Monitor & Frame Sync */}
        {activeTab === 'video' && (
          <div className="space-y-6 animate-fadeIn">
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
        )}

        {/* Tab 3: AI Dubbing, Silero VAD & Smart Alignment */}
        {activeTab === 'ai-dubbing' && (
          <div className="space-y-6 animate-fadeIn">
            <DubbingAIStudio
              tracks={tracks}
              currentTimeSec={currentTimeSec}
              onSeek={seek}
            />
          </div>
        )}

        {/* Tab 4: Export Studio & FFmpeg WASM Video Muxer */}
        {activeTab === 'export' && (
          <div className="space-y-6 animate-fadeIn">
            <ExportStudio
              tracks={tracks}
              master={master}
              sourceVideoFile={sourceVideoFile}
            />
          </div>
        )}

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
    </div>
  );
}
