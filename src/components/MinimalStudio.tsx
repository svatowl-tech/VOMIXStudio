/**
 * ============================================================================
 * MINIMAL STUDIO (MVP Audio/Video Pipeline Screen)
 * ============================================================================
 * Единый экран полного сквозного процесса дубляжа и сведения в один клик:
 * 
 * 1. Шаг 1: Выбор рабочей папки проекта через File System Access API (права 'readwrite').
 * 2. Шаг 2: Сканирование медиафайлов, C++ унификация (приведение всех дорожек к 48 кГц
 *    через кубический Catmull-Rom ресэмплер в WASM SIMD), извлечение звука из видео
 *    и автосохранение структуры в `project/project.json`.
 * 3. Шаг 3: Компактная консоль микшера с фейдерами, Mute/Solo и кнопкой нативной C++
 *    нормализации громкости (Auto-Match Loudness EBU R128).
 * 4. Шаг 4: Видеоплеер покадровой синхронизации с переключателем источников звука
 *    («Оригинальный звук видео / Сведенный микс»).
 * 5. Шаг 5: Экспорт в один клик: C++ BatchOfflineRenderer генерирует master WAV ->
 *    FFmpeg WASM заменяет аудиопоток (-c:v copy -c:a aac) -> автосохранение MP4 в папку.
 * ============================================================================
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  FolderOpen,
  Film,
  Sliders,
  Volume2,
  Play,
  Pause,
  RotateCcw,
  Wand2,
  Download,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  RefreshCw,
  Music,
  FileVideo,
  HardDrive,
  Save,
  ChevronLeft,
  ChevronRight,
  Headphones,
  Zap,
  Info
} from 'lucide-react';
import { useAudioEngine } from '../hooks/useAudioEngine';
import { TrackState, MasterState, LiveDAWEngine } from '../audio/dawEngine';
import { MediaNormalizer } from '../services/MediaNormalizer';
import { ProjectState, globalProjectManager } from '../services/ProjectManager';
import { RenderProgressInfo, globalRenderManager } from '../services/RenderManager';
import { formatSMPTE } from '../utils/waveformUtils';

export const MinimalStudio: React.FC = () => {
  // --- 1. Аудиодвижок DAW и AudioWorklet ---
  const {
    isInitialized,
    isPlaying,
    currentTimeSec,
    trackMeters,
    initAudioEngine,
    togglePlay,
    seek,
    uploadAudioFileToTrack,
    uploadRawPCMToTrack,
    setTrackVolume,
    setTrackPan,
    setTrackSolo,
    setTrackMute,
    setMasterVolume,
    setMasterLimiter,
    performLoudnessMatching
  } = useAudioEngine();

  // --- 2. Состояние дорожек и мастера проекта ---
  const [tracks, setTracks] = useState<TrackState[]>(() => new LiveDAWEngine().getTracks());
  const [master, setMaster] = useState<MasterState>({
    volumeDb: 0,
    pan: 0,
    limiterCeilingDb: -0.1,
    limiterEnabled: true,
    peakL: 0,
    peakR: 0,
    clipped: false
  });

  // --- 3. Состояние проекта и файловой системы ---
  const [activeDirName, setActiveDirName] = useState<string>('');
  const [hasWritePermission, setHasWritePermission] = useState<boolean>(false);
  const [isFileSystemLoading, setIsFileSystemLoading] = useState<boolean>(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');

  // --- 4. Состояние видео и синхронизации ---
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [fps] = useState<number>(30);
  const [audioMonitoringMode, setAudioMonitoringMode] = useState<'mixed' | 'original'>('mixed');
  const [isExtractingAudio, setIsExtractingAudio] = useState<boolean>(false);

  // --- 5. Состояние экспорта и FFmpeg WASM ---
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<RenderProgressInfo | null>(null);
  const [exportedVideoBlob, setExportedVideoBlob] = useState<Blob | null>(null);
  const [exportedVideoUrl, setExportedVideoUrl] = useState<string | null>(null);
  const [loudnessMatchReport, setLoudnessMatchReport] = useState<string | null>(null);

  // Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const autoSaveTimeoutRef = useRef<number | null>(null);

  // Инициализация коллбэка прогресса FFmpeg рендерера
  useEffect(() => {
    globalRenderManager.setProgressCallback((info) => {
      setExportProgress(info);
    });
  }, []);

  // --- 6. Синхронизация видео-плеера с таймлайном C++ движка ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSrc) return;

    if (isPlaying) {
      if (video.paused) {
        video.play().catch(() => {});
      }
    } else {
      if (!video.paused) {
        video.pause();
      }
    }

    // Синхронизация с порогом дрифта 40 мс
    const driftSec = Math.abs(video.currentTime - currentTimeSec);
    if (driftSec > 0.04) {
      video.currentTime = currentTimeSec;
    }
  }, [currentTimeSec, isPlaying, videoSrc]);

  // Управление переключением мониторинга: «Оригинальный звук видео / Сведенный микс»
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (audioMonitoringMode === 'original') {
      video.muted = false;
      video.volume = 1.0;
      setMasterVolume(-60); // Приглушаем мастер DAW
    } else {
      video.muted = true;
      video.volume = 0;
      setMasterVolume(master.volumeDb); // Включаем мастер DAW
    }
  }, [audioMonitoringMode, master.volumeDb, setMasterVolume]);

  // --- 7. Автосохранение project/project.json при изменении микшера ---
  const triggerAutoSave = useCallback(() => {
    if (autoSaveTimeoutRef.current) {
      window.clearTimeout(autoSaveTimeoutRef.current);
    }

    setAutoSaveStatus('saving');

    autoSaveTimeoutRef.current = window.setTimeout(async () => {
      try {
        const projectState: ProjectState = {
          id: `proj_${Date.now()}`,
          name: activeDirName || 'Автосохраненный проект',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sampleRate: 48000,
          videoFile: videoFile
            ? {
                name: videoFile.name,
                relativePath: videoFile.name,
                durationSec: videoDuration,
                fps: fps,
                fileSize: videoFile.size
              }
            : null,
          tracks: tracks.map((t) => ({
            id: t.id,
            name: t.name,
            fileName: t.clips[0]?.name || '',
            volumeDb: t.volumeDb,
            pan: t.pan,
            solo: t.solo,
            mute: t.mute,
            offsetSec: t.clips[0]?.offsetSamples ? t.clips[0].offsetSamples / 48000 : 0,
            color: t.color
          })),
          master: {
            volumeDb: master.volumeDb,
            pan: master.pan,
            limiterEnabled: master.limiterEnabled,
            limiterCeilingDb: master.limiterCeilingDb
          }
        };

        await globalProjectManager.saveProjectState(projectState);
        setAutoSaveStatus('saved');
      } catch (err) {
        console.error('Ошибка автосохранения project.json:', err);
        setAutoSaveStatus('error');
      }
    }, 1200); // 1.2s Debounce
  }, [activeDirName, videoFile, videoDuration, fps, tracks, master]);

  // --- 8. Шаг 1 & 2: Выбор рабочей папки и C++ унификация дорожек ---
  const handleOpenProjectFolder = async () => {
    setIsFileSystemLoading(true);
    setStatusMessage('Сканирование выбранной папки...');

    try {
      let content;
      if (globalProjectManager.isFileSystemAccessSupported()) {
        content = await globalProjectManager.openProjectFolder();
      } else {
        folderInputRef.current?.click();
        setIsFileSystemLoading(false);
        return;
      }

      setActiveDirName(content.directoryName);
      setHasWritePermission(content.hasWritePermission);

      // Инициализируем C++ аудиоядро при первом взаимодействии
      if (!isInitialized) {
        await initAudioEngine();
      }

      // 1. Автоматическое обнаружение видеофайла
      const discoveredVideo = content.discoveredFiles.find((f) => f.type === 'video');
      if (discoveredVideo && discoveredVideo.fileObj) {
        setVideoFile(discoveredVideo.fileObj);
        setVideoSrc(URL.createObjectURL(discoveredVideo.fileObj));
        setStatusMessage(`Обнаружено видео: ${discoveredVideo.name}`);
      }

      // 2. Обнаружение аудиофайлов и пропуск через C++ унификатор 48 кГц
      const audioFiles = content.discoveredFiles.filter((f) => f.type === 'audio');
      if (audioFiles.length > 0) {
        setStatusMessage(`C++ ресемплинг ${audioFiles.length} аудиодорожек к 48 кГц...`);
        for (let i = 0; i < audioFiles.length && i < tracks.length; i++) {
          const audioFile = audioFiles[i].fileObj;
          if (audioFile) {
            const track = tracks[i];
            const uploadRes = await uploadAudioFileToTrack(audioFile, track.id, Date.now() + i, 0);

            setTracks((prev) =>
              prev.map((t) => {
                if (t.id === track.id) {
                  return {
                    ...t,
                    name: audioFile.name.replace(/\.[^/.]+$/, ''),
                    clips: [
                      {
                        id: Date.now() + i,
                        name: audioFile.name,
                        offsetSamples: 0,
                        lengthSamples: uploadRes.samplesCount,
                        gain: 1.0,
                        pan: 0,
                        fadeInSamples: 0,
                        fadeOutSamples: 0,
                        buffer: uploadRes.pcmData,
                        color: t.color
                      }
                    ]
                  };
                }
                return t;
              })
            );
          }
        }
      }

      // 3. Восстановление сохраненного состояния project/project.json
      if (content.savedState) {
        const savedTracks = content.savedState.tracks;
        if (savedTracks && savedTracks.length > 0) {
          setTracks((prev) =>
            prev.map((t) => {
              const matched = savedTracks.find((st) => st.id === t.id || st.name === t.name);
              if (matched) {
                setTrackVolume(t.id, matched.volumeDb);
                setTrackPan(t.id, matched.pan);
                setTrackMute(t.id, matched.mute);
                setTrackSolo(t.id, matched.solo);
                return {
                  ...t,
                  volumeDb: matched.volumeDb,
                  pan: matched.pan,
                  mute: matched.mute,
                  solo: matched.solo
                };
              }
              return t;
            })
          );
        }
        if (content.savedState.master) {
          setMaster((prev) => ({
            ...prev,
            volumeDb: content.savedState!.master.volumeDb,
            limiterEnabled: content.savedState!.master.limiterEnabled
          }));
          setMasterVolume(content.savedState.master.volumeDb);
          setMasterLimiter(content.savedState.master.limiterEnabled, content.savedState.master.limiterCeilingDb || -0.1);
        }
      }

      setStatusMessage(`Проект "${content.directoryName}" успешно открыт!`);
    } catch (err: any) {
      if (err.message && !err.message.includes('отменен')) {
        setStatusMessage(`Ошибка открытия папки: ${err.message}`);
      }
    } finally {
      setIsFileSystemLoading(false);
    }
  };

  // Fallback выбор папки через standard input
  const handleFallbackFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsFileSystemLoading(true);
    try {
      const content = await globalProjectManager.loadFromFileInput(files);
      setActiveDirName(content.directoryName);
      setHasWritePermission(false);

      if (!isInitialized) {
        await initAudioEngine();
      }

      const discoveredVideo = content.discoveredFiles.find((f) => f.type === 'video');
      if (discoveredVideo && discoveredVideo.fileObj) {
        setVideoFile(discoveredVideo.fileObj);
        setVideoSrc(URL.createObjectURL(discoveredVideo.fileObj));
      }

      const audioFiles = content.discoveredFiles.filter((f) => f.type === 'audio');
      for (let i = 0; i < audioFiles.length && i < tracks.length; i++) {
        const audioFile = audioFiles[i].fileObj;
        if (audioFile) {
          const track = tracks[i];
          const uploadRes = await uploadAudioFileToTrack(audioFile, track.id, Date.now() + i, 0);
          setTracks((prev) =>
            prev.map((t) =>
              t.id === track.id
                ? {
                    ...t,
                    name: audioFile.name.replace(/\.[^/.]+$/, ''),
                    clips: [
                      {
                        id: Date.now() + i,
                        name: audioFile.name,
                        offsetSamples: 0,
                        lengthSamples: uploadRes.samplesCount,
                        gain: 1.0,
                        pan: 0,
                        fadeInSamples: 0,
                        fadeOutSamples: 0,
                        buffer: uploadRes.pcmData,
                        color: t.color
                      }
                    ]
                  }
                : t
            )
          );
        }
      }
      setStatusMessage(`Папка "${content.directoryName}" загружена (режим совместимости).`);
    } catch (err: any) {
      setStatusMessage(`Ошибка: ${err.message}`);
    } finally {
      setIsFileSystemLoading(false);
    }
  };

  // Ручной выбор видео
  const handleManualVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setVideoFile(file);
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setStatusMessage(`Видео "${file.name}" загружено.`);
  };

  // Извлечение звука оригинала на Дорожку №1 (C++ resample)
  const handleExtractVideoAudio = async () => {
    if (!videoFile) return;

    setIsExtractingAudio(true);
    setStatusMessage('Извлечение и C++ ресемплинг звука видеофайла (48 кГц)...');

    try {
      if (!isInitialized) {
        await initAudioEngine();
      }

      const pcmFloat32 = await MediaNormalizer.extractAudioFromVideo(videoFile, 48000);
      const totalFrames = pcmFloat32.length / 2;

      const targetTrackId = tracks[0]?.id || 1;
      uploadRawPCMToTrack(pcmFloat32, targetTrackId, Date.now(), 0, 1.0, 0.0, true);

      setTracks((prev) =>
        prev.map((t) =>
          t.id === targetTrackId
            ? {
                ...t,
                name: `Звук видео [${videoFile.name}]`,
                clips: [
                  {
                    id: Date.now(),
                    name: `VideoAudio_${videoFile.name}`,
                    offsetSamples: 0,
                    lengthSamples: totalFrames,
                    gain: 1.0,
                    pan: 0,
                    fadeInSamples: 0,
                    fadeOutSamples: 0,
                    buffer: pcmFloat32,
                    color: '#06b6d4'
                  }
                ]
              }
            : t
        )
      );

      setStatusMessage('Оригинальный звук видео загружен на Дорожку 1!');
      triggerAutoSave();
    } catch (err: any) {
      setStatusMessage(`Ошибка извлечения звука: ${err.message}`);
    } finally {
      setIsExtractingAudio(false);
    }
  };

  // --- 9. Изменение параметров микшера ---
  const handleVolumeChange = (trackId: number, volumeDb: number) => {
    setTrackVolume(trackId, volumeDb);
    setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, volumeDb } : t)));
    triggerAutoSave();
  };

  const handlePanChange = (trackId: number, pan: number) => {
    setTrackPan(trackId, pan);
    setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, pan } : t)));
    triggerAutoSave();
  };

  const handleMuteToggle = (trackId: number) => {
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return;
    const newMute = !track.mute;
    setTrackMute(trackId, newMute);
    setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, mute: newMute } : t)));
    triggerAutoSave();
  };

  const handleSoloToggle = (trackId: number) => {
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return;
    const newSolo = !track.solo;
    setTrackSolo(trackId, newSolo);
    setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, solo: newSolo } : t)));
    triggerAutoSave();
  };

  // --- 10. Шаг 3: Автоматическое выравнивание громкости (C++ Loudness Match EBU R128) ---
  const handleAutoLoudnessMatch = (targetRmsDb = -18.0) => {
    const result = performLoudnessMatching(tracks, targetRmsDb, -1.0);
    setTracks(result.updatedTracks);

    const activeAdjustments = result.adjustments.filter((a) => !a.isSilent);
    if (activeAdjustments.length === 0) {
      setLoudnessMatchReport('Нет активных аудиодорожек с сигналом для выравнивания.');
    } else {
      const summary = activeAdjustments
        .map((a) => `${a.trackName}: ${a.gainChangeDb >= 0 ? '+' : ''}${a.gainChangeDb} dB`)
        .join(' | ');
      setLoudnessMatchReport(`C++ выравнивание громкости (${targetRmsDb} dBFS EBU R128): ${summary}`);
    }

    triggerAutoSave();
    setTimeout(() => setLoudnessMatchReport(null), 8000);
  };

  // --- 11. Шаг 5: Сведение и экспорт видео в один клик ---
  const handleExportAndMuxVideo = async () => {
    if (!videoFile) {
      alert('Пожалуйста, загрузите исходный видеофайл перед запуском финального сведения и муксинга.');
      return;
    }

    setIsExporting(true);
    setExportedVideoBlob(null);
    setExportedVideoUrl(null);

    try {
      // 1. Офлайн-рендеринг C++ DSP микса в 24-битный стерео WAV
      const renderDuration = videoDuration > 0 ? videoDuration : undefined;
      const renderResult = await globalRenderManager.renderMasterMix(
        tracks,
        master,
        48000,
        24,
        renderDuration
      );

      // 2. Муксинг через FFmpeg WASM (-c:v copy -c:a aac)
      const outputFileName = `mixed_${videoFile.name.replace(/\.[^/.]+$/, '')}.mp4`;
      const finalVideoBlob = await globalRenderManager.muxAudioIntoVideo(
        videoFile,
        renderResult.wavBlob,
        outputFileName
      );

      if (!finalVideoBlob) {
        throw new Error('FFmpeg не смог сформировать выходной видеофайл.');
      }

      setExportedVideoBlob(finalVideoBlob);
      const finalUrl = URL.createObjectURL(finalVideoBlob);
      setExportedVideoUrl(finalUrl);

      // 3. Автосохранение готового MP4 в папку проекта через File System Access API
      await globalProjectManager.saveBlobToProjectDirectory(finalVideoBlob, outputFileName);
      setStatusMessage(`Видео успешно сведено и сохранено: ${outputFileName}`);
    } catch (err: any) {
      console.error('Ошибка экспорта и муксинга:', err);
      setStatusMessage(`Сбой экспорта: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  // Покадровый шаг видео
  const handleStepFrame = (deltaFrames: number) => {
    const frameTime = 1 / fps;
    const newTime = Math.max(0, Math.min(videoDuration, currentTimeSec + deltaFrames * frameTime));
    seek(newTime);
  };

  return (
    <div className="space-y-6 animate-fadeIn pb-12">
      {/* 1. ПАНЕЛЬ ПРОЕКТА */}
      <div className="bg-[#0f1422] border border-[#1e293b] p-4 sm:p-5 rounded-2xl shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400">
              <FolderOpen size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100">
                  {activeDirName ? `Рабочая папка: ${activeDirName}` : 'Проект не выбран'}
                </h2>
                {hasWritePermission ? (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono flex items-center gap-1">
                    <HardDrive size={10} /> Прямая запись (FS API)
                  </span>
                ) : (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 font-mono">
                    Память браузера
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Автосохранение параметров сведе́ния в <code className="text-emerald-400 font-mono">project/project.json</code>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Индикатор статуса автосохранения */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900/90 border border-slate-800 rounded-xl text-xs font-mono text-slate-300">
              {autoSaveStatus === 'saving' && (
                <>
                  <RefreshCw size={12} className="animate-spin text-amber-400" />
                  <span className="text-amber-400">Автосохранение...</span>
                </>
              )}
              {autoSaveStatus === 'saved' && (
                <>
                  <CheckCircle2 size={12} className="text-emerald-400" />
                  <span className="text-emerald-400">project.json сохранен</span>
                </>
              )}
              {autoSaveStatus === 'idle' && (
                <>
                  <Save size={12} className="text-slate-500" />
                  <span className="text-slate-400">Синхронизировано</span>
                </>
              )}
              {autoSaveStatus === 'error' && (
                <>
                  <AlertCircle size={12} className="text-rose-400" />
                  <span className="text-rose-400">Ошибка записи</span>
                </>
              )}
            </div>

            {/* Кнопка открытия директории */}
            <button
              id="btn-open-project-folder"
              onClick={handleOpenProjectFolder}
              disabled={isFileSystemLoading}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 text-white rounded-xl text-xs font-semibold transition-all flex items-center gap-2 shadow-lg shadow-emerald-950/40 cursor-pointer"
            >
              {isFileSystemLoading ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <FolderOpen size={14} />
              )}
              Выбрать папку с файлами
            </button>

            <input
              type="file"
              ref={folderInputRef}
              onChange={handleFallbackFolderSelect}
              // @ts-ignore
              webkitdirectory="true"
              directory="true"
              multiple
              className="hidden"
            />
          </div>
        </div>

        {statusMessage && (
          <div className="mt-3 text-xs font-mono text-slate-400 bg-slate-950/60 px-3 py-2 rounded-lg border border-slate-800 flex items-center gap-2">
            <Info size={14} className="text-cyan-400 shrink-0" />
            <span>{statusMessage}</span>
          </div>
        )}
      </div>

      {/* 2. ВИДЕО-ПЛЕЕР СИНХРОНИЗАЦИИ И ЭКСПОРТ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Экран видео */}
        <div className="lg:col-span-7 bg-[#0b0f19] border border-[#1e293b] rounded-2xl overflow-hidden shadow-2xl flex flex-col justify-between">
          <div className="bg-[#0f1422] px-4 py-2.5 border-b border-[#1e293b] flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 font-bold text-slate-200">
              <Film size={15} className="text-cyan-400" />
              <span>Видео-монитор синхронизации</span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-mono">
                {fps} FPS
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                id="btn-upload-video-manual"
                onClick={() => videoInputRef.current?.click()}
                className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-lg flex items-center gap-1.5 font-mono text-[11px] cursor-pointer"
              >
                <FileVideo size={12} className="text-purple-400" />
                {videoFile ? 'Заменить видео' : 'Загрузить видео'}
              </button>
              <input
                type="file"
                ref={videoInputRef}
                onChange={handleManualVideoUpload}
                accept="video/mp4,video/webm,video/quicktime,video/mkv"
                className="hidden"
              />

              {videoFile && (
                <button
                  id="btn-extract-video-audio"
                  onClick={handleExtractVideoAudio}
                  disabled={isExtractingAudio}
                  className="px-2.5 py-1 bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 border border-cyan-500/30 rounded-lg flex items-center gap-1.5 font-mono text-[11px] cursor-pointer"
                  title="Извлечь звук видео на отдельную дорожку микшера"
                >
                  {isExtractingAudio ? (
                    <RefreshCw size={12} className="animate-spin text-cyan-400" />
                  ) : (
                    <Music size={12} className="text-cyan-400" />
                  )}
                  Извлечь аудио
                </button>
              )}
            </div>
          </div>

          {/* Видео-контейнер */}
          <div className="relative bg-black aspect-video flex items-center justify-center overflow-hidden select-none">
            {videoSrc ? (
              <video
                ref={videoRef}
                src={videoSrc}
                playsInline
                onLoadedMetadata={() => {
                  if (videoRef.current) {
                    setVideoDuration(videoRef.current.duration || 0);
                  }
                }}
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center justify-center p-8 text-center text-slate-500">
                <Film size={48} className="text-slate-700 mb-3" />
                <p className="text-sm font-medium text-slate-400">Видео не загружено</p>
                <p className="text-xs text-slate-600 mt-1 max-w-sm">
                  Выберите рабочую папку или добавьте MP4 видео вручную для синхронизированного воспроизведения и муксинга.
                </p>
              </div>
            )}
          </div>

          {/* Транспортная панель */}
          <div className="bg-[#0f1422] p-3 border-t border-[#1e293b] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                id="btn-transport-play"
                onClick={togglePlay}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-emerald-950/40 cursor-pointer"
              >
                {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                {isPlaying ? 'Пауза' : 'Воспроизведение'}
              </button>

              <button
                id="btn-transport-rewind"
                onClick={() => seek(0)}
                title="Перейти в начало"
                className="p-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg cursor-pointer"
              >
                <RotateCcw size={14} />
              </button>

              <button
                onClick={() => handleStepFrame(-1)}
                title="-1 Кадр"
                className="p-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg cursor-pointer"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                onClick={() => handleStepFrame(1)}
                title="+1 Кадр"
                className="p-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg cursor-pointer"
              >
                <ChevronRight size={14} />
              </button>
            </div>

            {/* Таймкод */}
            <div className="bg-black/60 px-3 py-1.5 rounded-lg border border-slate-800/80 font-mono text-xs text-emerald-400 font-bold">
              {formatSMPTE(currentTimeSec, fps)}
            </div>

            {/* Переключатель источника звука */}
            <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button
                id="btn-mode-mixed"
                onClick={() => setAudioMonitoringMode('mixed')}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                  audioMonitoringMode === 'mixed'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Headphones size={12} />
                Сведенный микс DAW
              </button>

              <button
                id="btn-mode-original"
                onClick={() => setAudioMonitoringMode('original')}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                  audioMonitoringMode === 'original'
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Volume2 size={12} />
                Оригинал видео
              </button>
            </div>
          </div>
        </div>

        {/* Блок экспорта */}
        <div className="lg:col-span-5 bg-[#0f1422] border border-[#1e293b] p-5 rounded-2xl shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-purple-500/10 border border-purple-500/20 rounded-xl text-purple-400">
                  <Zap size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100">Экспорт и вшивание в видео</h3>
                  <p className="text-[11px] text-slate-400">FFmpeg WebAssembly (-c:v copy -c:a aac)</p>
                </div>
              </div>

              <span className="text-[10px] px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 font-mono">
                WASM Core
              </span>
            </div>

            <div className="mt-4 space-y-3">
              <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800/80 text-xs space-y-2 font-mono">
                <div className="flex justify-between text-slate-400">
                  <span>Мастер-частота:</span>
                  <span className="text-slate-200">48 000 Hz / 24-bit</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Аудиокодек экспорта:</span>
                  <span className="text-slate-200">AAC 320 kbps (High Fidelity)</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Видеопоток:</span>
                  <span className="text-emerald-400">Direct Stream Copy (Без потерь)</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Исходное видео:</span>
                  <span className="text-slate-200 truncate max-w-[180px]">
                    {videoFile ? videoFile.name : 'Не выбрано'}
                  </span>
                </div>
              </div>

              {/* Индикатор прогресса */}
              {exportProgress && isExporting && (
                <div className="space-y-2 bg-purple-950/20 border border-purple-500/30 p-3.5 rounded-xl animate-fadeIn">
                  <div className="flex justify-between text-xs font-semibold text-purple-300">
                    <span>{exportProgress.message}</span>
                    <span>{exportProgress.progressPercent}%</span>
                  </div>
                  <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-purple-500/30">
                    <div
                      className="h-full bg-gradient-to-r from-purple-500 to-cyan-500 transition-all duration-200"
                      style={{ width: `${exportProgress.progressPercent}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Результат сборки */}
              {exportedVideoBlob && exportedVideoUrl && (
                <div className="bg-emerald-950/30 border border-emerald-500/30 p-3.5 rounded-xl text-xs space-y-2 animate-fadeIn">
                  <div className="flex items-center gap-2 text-emerald-400 font-semibold">
                    <CheckCircle2 size={16} />
                    <span>Финальное видео успешно собрано!</span>
                  </div>
                  <p className="text-slate-300 text-[11px]">
                    Размер файла: {(exportedVideoBlob.size / (1024 * 1024)).toFixed(2)} МБ. Сохранено в папку проекта.
                  </p>
                  <a
                    href={exportedVideoUrl}
                    download={`mixed_${videoFile?.name || 'video.mp4'}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-all"
                  >
                    <Download size={13} />
                    Скачать MP4 вручную
                  </a>
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-800">
            <button
              id="btn-export-and-mux"
              onClick={handleExportAndMuxVideo}
              disabled={isExporting || !videoFile}
              className="w-full py-3 bg-gradient-to-r from-purple-600 to-emerald-600 hover:from-purple-500 hover:to-emerald-500 disabled:from-slate-800 disabled:to-slate-800 text-white font-bold rounded-xl text-sm transition-all shadow-xl shadow-purple-950/50 flex items-center justify-center gap-2 cursor-pointer"
            >
              {isExporting ? (
                <>
                  <RefreshCw size={16} className="animate-spin text-white" />
                  Рендеринг и муксинг...
                </>
              ) : (
                <>
                  <Sparkles size={16} className="text-amber-300" />
                  Свести и вшить в видео
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 3. КОНСОЛЬ СВЕДЕНИЯ МИКШЕРА */}
      <div className="bg-[#0f1422] border border-[#1e293b] p-5 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-500/10 border border-blue-500/20 rounded-xl text-blue-400">
              <Sliders size={18} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100">Консоль сведения аудиодорожек</h3>
              <p className="text-[11px] text-slate-400">
                Калибровка уровней, балансировка диалогов, музыки и звуковых эффектов
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="btn-loudness-match-broadcast"
              onClick={() => handleAutoLoudnessMatch(-18.0)}
              className="px-4 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-bold rounded-xl text-xs transition-all flex items-center gap-2 shadow-lg shadow-blue-950/40 cursor-pointer"
            >
              <Wand2 size={14} className="text-amber-300" />
              Автоматически выровнять громкость всех дорожек (EBU R128)
            </button>

            <button
              id="btn-loudness-match-streaming"
              onClick={() => handleAutoLoudnessMatch(-14.0)}
              className="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer"
              title="Выровнять под стриминг (-14 dBFS)"
            >
              Streaming (-14 dBFS)
            </button>
          </div>
        </div>

        {/* Отчет Loudness Match */}
        {loudnessMatchReport && (
          <div className="bg-blue-950/40 border border-blue-500/30 p-3 rounded-xl text-blue-300 text-xs flex items-center gap-2 animate-fadeIn">
            <CheckCircle2 size={15} className="text-blue-400 shrink-0" />
            <span>{loudnessMatchReport}</span>
          </div>
        )}

        {/* Сетка полос микшера */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 pt-2">
          {tracks.map((track) => {
            const meterData = trackMeters.get(track.id);
            const peakDbL = meterData ? MediaNormalizer.linearToDb(meterData.peakL) : -60;
            const peakDbR = meterData ? MediaNormalizer.linearToDb(meterData.peakR) : -60;
            const isClipping = (meterData?.peakL || 0) >= 0.9999 || (meterData?.peakR || 0) >= 0.9999;
            const hasClips = track.clips.length > 0;

            return (
              <div
                key={track.id}
                className={`bg-[#0a0e17] border rounded-xl p-4 flex flex-col justify-between transition-all ${
                  track.solo
                    ? 'border-amber-500/50 shadow-lg shadow-amber-950/20'
                    : track.mute
                    ? 'border-slate-800 opacity-60'
                    : 'border-slate-800 hover:border-slate-700'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 truncate">
                      <div
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: track.color || '#10b981' }}
                      />
                      <span className="text-xs font-bold text-slate-200 truncate" title={track.name}>
                        {track.name}
                      </span>
                    </div>

                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800">
                      CH {track.id}
                    </span>
                  </div>

                  <div className="text-[11px] text-slate-400 mb-3 truncate">
                    {hasClips ? (
                      <span className="text-emerald-400">
                        {track.clips[0].name} ({((track.clips[0].lengthSamples || 0) / 48000).toFixed(1)}с)
                      </span>
                    ) : (
                      <span className="text-slate-600">Нет аудиофайла</span>
                    )}
                  </div>

                  {/* Peak/RMS Индикаторы */}
                  <div className="space-y-1 bg-slate-950 p-2.5 rounded-lg border border-slate-800 mb-4">
                    <div className="flex justify-between text-[10px] font-mono">
                      <span className="text-slate-500">L / R</span>
                      <span className={isClipping ? 'text-rose-400 font-bold' : 'text-slate-400'}>
                        {peakDbL > -60 ? `${peakDbL.toFixed(1)} dB` : '-inf'}
                      </span>
                    </div>

                    <div className="space-y-1">
                      <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden flex">
                        <div
                          className={`h-full transition-all duration-75 ${
                            peakDbL > -0.1
                              ? 'bg-rose-500'
                              : peakDbL > -6
                              ? 'bg-amber-400'
                              : 'bg-emerald-500'
                          }`}
                          style={{
                            width: `${Math.max(0, Math.min(100, ((peakDbL + 60) / 60) * 100))}%`
                          }}
                        />
                      </div>
                      <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden flex">
                        <div
                          className={`h-full transition-all duration-75 ${
                            peakDbR > -0.1
                              ? 'bg-rose-500'
                              : peakDbR > -6
                              ? 'bg-amber-400'
                              : 'bg-emerald-500'
                          }`}
                          style={{
                            width: `${Math.max(0, Math.min(100, ((peakDbR + 60) / 60) * 100))}%`
                          }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Фейдер громкости */}
                  <div className="space-y-1.5 mb-3">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-400 font-medium">Громкость:</span>
                      <span className="font-mono text-emerald-400 font-bold">
                        {track.volumeDb > 0 ? `+${track.volumeDb.toFixed(1)}` : track.volumeDb.toFixed(1)} dB
                      </span>
                    </div>
                    <input
                      type="range"
                      min="-48"
                      max="12"
                      step="0.5"
                      value={track.volumeDb}
                      onChange={(e) => handleVolumeChange(track.id, parseFloat(e.target.value))}
                      className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                    />
                  </div>

                  {/* Панорама */}
                  <div className="space-y-1.5 mb-4">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-400 font-medium">Панорама:</span>
                      <span className="font-mono text-slate-300 text-[11px]">
                        {track.pan === 0
                          ? 'Center'
                          : track.pan < 0
                          ? `L ${Math.round(Math.abs(track.pan) * 100)}%`
                          : `R ${Math.round(track.pan * 100)}%`}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="-1"
                      max="1"
                      step="0.05"
                      value={track.pan}
                      onChange={(e) => handlePanChange(track.id, parseFloat(e.target.value))}
                      className="w-full accent-cyan-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                    />
                  </div>
                </div>

                {/* Кнопки Mute / Solo */}
                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800/80">
                  <button
                    onClick={() => handleMuteToggle(track.id)}
                    className={`py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      track.mute
                        ? 'bg-rose-600 text-white shadow-md shadow-rose-950/30'
                        : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    MUTE
                  </button>

                  <button
                    onClick={() => handleSoloToggle(track.id)}
                    className={`py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      track.solo
                        ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-950/30'
                        : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    SOLO
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
