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
  Info,
  Plus,
  Trash2,
  Database,
  SlidersHorizontal,
  Upload,
  Terminal
} from 'lucide-react';
import { systemLogger } from '../services/SystemLogger';
import { useAudioEngine } from '../hooks/useAudioEngine';
import { TrackState, MasterState, LiveDAWEngine, createNewTrack } from '../audio/dawEngine';
import { MediaNormalizer } from '../services/MediaNormalizer';
import { ProjectState, globalProjectManager } from '../services/ProjectManager';
import { RenderProgressInfo, globalRenderManager } from '../services/RenderManager';
import { AssetDatabase, DatabaseStats } from '../services/AssetDatabase';
import { TrackDSPPanel } from './TrackDSPPanel';
import { TimelineView } from './TimelineView';
import { MediaImportModal } from './MediaImportModal';
import { SubtitleCue } from '../services/ProjectManager';
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
    syncTrackClips,
    syncAllTracks,
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

  // --- 2. Состояние дорожек и мастера проекта (Поддержка до 32 дорожек) ---
  const [tracks, setTracks] = useState<TrackState[]>(() => new LiveDAWEngine().getTracks());

  // Автоматическая фоновая синхронизация дорожек и клипов с AudioWorklet
  useEffect(() => {
    if (isInitialized && tracks && tracks.length > 0) {
      syncAllTracks(tracks);
    }
  }, [isInitialized, tracks, syncAllTracks]);
  const [activeDspTrackId, setActiveDspTrackId] = useState<number | null>(null);
  const activeDspTrack = tracks.find((t) => t.id === activeDspTrackId) || null;
  const [dbStats, setDbStats] = useState<DatabaseStats | null>(null);
  const [showDbModal, setShowDbModal] = useState<boolean>(false);
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
  const [showMediaImportModal, setShowMediaImportModal] = useState<boolean>(false);
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);

  // Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const autoSaveTimeoutRef = useRef<number | null>(null);

  // Инициализация коллбэка прогресса FFmpeg рендерера и статистики SQL базы
  useEffect(() => {
    globalRenderManager.setProgressCallback((info) => {
      setExportProgress(info);
    });
    AssetDatabase.getInstance().getStats().then(setDbStats).catch(() => {});
  }, []);

  // --- Горячая клавиша Space для строго синхронного запуска и остановки видео и аудиотаймлайна ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay]);

  // --- 6. Синхронизация видео-плеера с таймлайном C++ движка (Jitter-free Micro-Rate Sync) ---
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

    // Фазовая микро-подстройка скорости без сброса очередей декодера (исключает заикание видео)
    const driftSec = video.currentTime - currentTimeSec;
    const absDrift = Math.abs(driftSec);

    if (absDrift > 0.35) {
      // Жесткий переход только при ручной перемотке или большом разрыве
      video.currentTime = currentTimeSec;
      video.playbackRate = 1.0;
    } else if (absDrift > 0.04) {
      // Мягкое плавное выравнивание скорости воспроизведения на +-4%
      video.playbackRate = driftSec > 0 ? 0.96 : 1.04;
    } else {
      video.playbackRate = 1.0;
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

        // Кэшируем видеофайл в SQL/IndexedDB базу данных
        AssetDatabase.getInstance().saveAsset({
          id: `video_${Date.now()}`,
          name: discoveredVideo.name,
          type: 'video',
          mimeType: discoveredVideo.fileObj.type || 'video/mp4',
          sizeBytes: discoveredVideo.fileObj.size,
          timestamp: Date.now(),
          blob: discoveredVideo.fileObj
        }).catch(console.error);
      }

      // 2. Обнаружение аудиофайлов и динамическое расширение до 20-25+ дорожек
      const audioFiles = content.discoveredFiles.filter((f) => f.type === 'audio');
      if (audioFiles.length > 0) {
        setStatusMessage(`C++ ресемплинг ${audioFiles.length} аудиодорожек к 48 кГц...`);

        // Динамически увеличиваем количество дорожек под все найденные файлы (до 32)
        let workingTracks = [...tracks];
        while (workingTracks.length < audioFiles.length && workingTracks.length < 32) {
          const nextId = workingTracks.length + 1;
          workingTracks.push(createNewTrack(nextId, `Dubber ${nextId}`));
        }

        for (let i = 0; i < audioFiles.length && i < workingTracks.length; i++) {
          const audioFile = audioFiles[i].fileObj;
          if (audioFile) {
            try {
              const track = workingTracks[i];
              const uploadRes = await uploadAudioFileToTrack(audioFile, track.id, Date.now() + i, 0);

              // Сохраняем ассет дорожки в SQL базу данных
              AssetDatabase.getInstance().saveAsset({
                id: `asset_ch${track.id}_${Date.now()}`,
                name: audioFile.name,
                type: 'audio',
                mimeType: audioFile.type || 'audio/wav',
                sizeBytes: audioFile.size,
                durationSec: uploadRes.durationSec,
                sampleRate: 48000,
                channels: 1,
                timestamp: Date.now(),
                blob: audioFile
              }).catch(console.error);

              workingTracks[i] = {
                ...track,
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
                    color: track.color
                  }
                ]
              };
            } catch (trackErr: any) {
              console.error(`Ошибка загрузки аудиофайла ${audioFiles[i].name}:`, trackErr);
            }
          }
        }
        setTracks(workingTracks);
        AssetDatabase.getInstance().getStats().then(setDbStats).catch(console.error);
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
      if (audioFiles.length > 0) {
        let workingTracks = [...tracks];
        while (workingTracks.length < audioFiles.length && workingTracks.length < 32) {
          const nextId = workingTracks.length + 1;
          workingTracks.push(createNewTrack(nextId, `Dubber ${nextId}`));
        }

        for (let i = 0; i < audioFiles.length && i < workingTracks.length; i++) {
          const audioFile = audioFiles[i].fileObj;
          if (audioFile) {
            const track = workingTracks[i];
            const uploadRes = await uploadAudioFileToTrack(audioFile, track.id, Date.now() + i, 0);

            AssetDatabase.getInstance().saveAsset({
              id: `asset_ch${track.id}_${Date.now()}`,
              name: audioFile.name,
              type: 'audio',
              mimeType: audioFile.type || 'audio/wav',
              sizeBytes: audioFile.size,
              durationSec: uploadRes.durationSec,
              sampleRate: 48000,
              channels: 1,
              timestamp: Date.now(),
              blob: audioFile
            }).catch(console.error);

            workingTracks[i] = {
              ...track,
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
                  color: track.color
                }
              ]
            };
          }
        }
        setTracks(workingTracks);
        AssetDatabase.getInstance().getStats().then(setDbStats).catch(console.error);
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

    AssetDatabase.getInstance().saveAsset({
      id: `video_${Date.now()}`,
      name: file.name,
      type: 'video',
      mimeType: file.type || 'video/mp4',
      sizeBytes: file.size,
      timestamp: Date.now(),
      blob: file
    }).then(() => AssetDatabase.getInstance().getStats().then(setDbStats)).catch(console.error);
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

  // Добавление новой аудиодорожки (поддержка 20-25+ дорожек)
  const handleAddNewTrack = () => {
    if (tracks.length >= 32) {
      alert('Достигнут максимальный лимит дорожек (32).');
      return;
    }
    const nextId = tracks.length > 0 ? Math.max(...tracks.map((t) => t.id)) + 1 : 1;
    const newTr = createNewTrack(nextId, `Dubber ${nextId}`);
    setTracks((prev) => [...prev, newTr]);
    triggerAutoSave();
    setStatusMessage(`Добавлена новая дорожка CH ${nextId} (всего дорожек: ${tracks.length + 1})`);
  };

  // Удаление дорожки
  const handleRemoveTrack = (trackId: number) => {
    if (tracks.length <= 1) {
      alert('Нельзя удалить последнюю дорожку.');
      return;
    }
    setTracks((prev) => prev.filter((t) => t.id !== trackId));
    triggerAutoSave();
    setStatusMessage(`Дорожка CH ${trackId} удалена.`);
  };

  // Загрузка аудиофайла напрямую в дорожку
  const handleTrackFileUpload = async (trackId: number, file: File) => {
    if (!isInitialized) {
      await initAudioEngine();
    }
    setStatusMessage(`Загрузка и ресемплинг "${file.name}" в CH ${trackId}...`);
    try {
      const uploadRes = await uploadAudioFileToTrack(file, trackId, Date.now(), 0);

      // Кэшируем ассет в SQL/IndexedDB базу данных
      await AssetDatabase.getInstance().saveAsset({
        id: `track_${trackId}_${Date.now()}`,
        name: file.name,
        type: 'audio',
        mimeType: file.type || 'audio/wav',
        sizeBytes: file.size,
        durationSec: uploadRes.durationSec,
        sampleRate: 48000,
        channels: 1,
        timestamp: Date.now(),
        blob: file
      });
      const stats = await AssetDatabase.getInstance().getStats();
      setDbStats(stats);

      setTracks((prev) =>
        prev.map((t) =>
          t.id === trackId
            ? {
                ...t,
                name: file.name.replace(/\.[^/.]+$/, ''),
                clips: [
                  {
                    id: Date.now(),
                    name: file.name,
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
      triggerAutoSave();
      setStatusMessage(`Файл "${file.name}" успешно загружен в CH ${trackId}.`);
    } catch (err: any) {
      setStatusMessage(`Ошибка загрузки аудио: ${err.message}`);
    }
  };

  // --- 8.5. Универсальный импорт через MediaImportModal ---
  const handleModalImportVideo = async (file: File, audioPcm?: Float32Array, durationSec?: number) => {
    setVideoFile(file);
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    if (durationSec && durationSec > 0) {
      setVideoDuration(durationSec);
    }

    if (audioPcm && audioPcm.length > 0) {
      const totalFrames = audioPcm.length / 2;
      const calcDur = totalFrames / 48000;
      setVideoDuration((prev) => (prev > 0 ? prev : calcDur));

      setTracks((prev) => {
        const targetId = prev.length > 0 ? prev[0].id : 1;
        const videoClip = {
          id: Date.now(),
          name: `Audio_${file.name}`,
          offsetSamples: 0,
          lengthSamples: totalFrames,
          gain: 1.0,
          pan: 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          buffer: audioPcm,
          color: '#06b6d4'
        };

        const exists = prev.some((t) => t.id === targetId);
        if (exists) {
          return prev.map((t) =>
            t.id === targetId
              ? {
                  ...t,
                  name: `Видео-звук [${file.name}]`,
                  clips: [videoClip]
                }
              : t
          );
        } else {
          const newTr = createNewTrack(targetId, `Видео-звук [${file.name}]`, '#06b6d4');
          newTr.clips = [videoClip];
          return [...prev, newTr];
        }
      });

      uploadRawPCMToTrack(audioPcm, 1, Date.now(), 0, 1.0, 0.0, true);
    }

    triggerAutoSave();
    setStatusMessage(`Видео [${file.name}] загружено в проект!`);
  };

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

    triggerAutoSave();
  };

  const handleModalImportSubtitles = async (cues: SubtitleCue[], sourceFileName?: string) => {
    setSubtitles(cues);
    setStatusMessage(`Субтитры [${sourceFileName || 'файл'}] импортированы: ${cues.length} реплик.`);
    triggerAutoSave();
  };

  /**
   * Сброс рабочего пространства при открытии нового проекта
   */
  const handleResetMinimalProjectState = () => {
    setTracks([createNewTrack(1, 'Дублер 1 (Диалоги)', '#10b981')]);
    setVideoFile(null);
    setVideoSrc(null);
    setVideoDuration(0);
    setSubtitles([]);
  };

  // Обновление DSP настроек дорожки из C++ DSP рэка
  const handleUpdateDspTrack = (updated: TrackState) => {
    setTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));

    // Передаем параметры в реальном времени в AudioWorklet
    if (updated.eq.enabled) {
      setTrackEq(updated.id, {
        lowGain: updated.eq.lowShelf.gainDb,
        midGain: updated.eq.peaking.gainDb,
        highGain: updated.eq.highShelf.gainDb
      });
    }
    if (updated.compressor.enabled) {
      setTrackCompressor(updated.id, {
        threshold: updated.compressor.thresholdDb,
        ratio: updated.compressor.ratio,
        attack: updated.compressor.attackMs,
        release: updated.compressor.releaseMs,
        knee: updated.compressor.kneeDb,
        makeup: updated.compressor.makeupGainDb
      });
    }
    if (updated.autoDucker.enabled) {
      setTrackAutoDucker(updated.id, {
        enabled: updated.autoDucker.enabled,
        threshold: updated.autoDucker.thresholdDb,
        depth: updated.autoDucker.duckDepthDb,
        sourceTrackId: updated.autoDucker.sourceTrackId
      });
    }

    triggerAutoSave();
  };

  // Обновление дорожки и клипов из TimelineView (Сплит, Time Stretch, перемещение клипов)
  const handleUpdateTrack = (updatedTrack: TrackState) => {
    setTracks((prev) => prev.map((t) => (t.id === updatedTrack.id ? updatedTrack : t)));

    // Синхронизируем клипы с AudioWorklet и C++ ядром
    syncTrackClips(updatedTrack.id, updatedTrack.clips);

    triggerAutoSave();
  };

  // --- 10. Шаг 3: Автоматическое выравнивание громкости (C++ Loudness Match EBU R128) ---
  const handleAutoLoudnessMatch = (targetRmsDb = -18.0) => {
    const result = performLoudnessMatching(tracks, targetRmsDb, -1.0);
    setTracks(result.updatedTracks);
    systemLogger.info('C++ WASM', `Выполнено выравнивание громкости дорожек (цель: ${targetRmsDb} dBFS True Peak ≤ -1.0)`, {
      adjustments: result.adjustments
    });

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

  // --- 11. Сквозной рабочий процесс «Свести и сохранить готовое видео» в один клик ---
  const handleExportAndMuxVideo = async () => {
    // Краевой случай 1: Отсутствие видеофайла
    if (!videoFile) {
      const confirmAudioOnly = window.confirm(
        'Исходный видеофайл не выбран.\n\nХотите выполнить сведение аудиодорожек и сохранить мастер-файл (WAV 48kHz / 24-bit)?\nИли нажмите "Отмена", чтобы сначала догрузить видеофайл.'
      );
      if (!confirmAudioOnly) {
        setShowMediaImportModal(true);
        return;
      }
    }

    // Краевой случай 2: Отсутствие аудиоклипов на дорожках
    const hasActiveClips = tracks.some((t) => t.clips && t.clips.length > 0 && t.clips.some((c) => c.lengthSamples > 0));
    if (!hasActiveClips) {
      alert('На таймлайне нет аудиодорожек или клипов для сведения. Пожалуйста, догрузите аудиофайлы или выберите рабочую папку.');
      setShowMediaImportModal(true);
      return;
    }

    setIsExporting(true);
    setExportedVideoBlob(null);
    setExportedVideoUrl(null);
    setStatusMessage('Запуск сквозного C++ конвейера сведения и муксинга...');
    systemLogger.info('RenderManager', `Старт сквозного процесса сведения (MVP) для ${videoFile ? `[${videoFile.name}]` : 'Мастер-аудио'}...`, {
      videoSize: videoFile?.size || 0,
      videoDuration,
      tracksCount: tracks.length
    });

    try {
      // 0% -> 30%: C++ DSP & Loudness Matching
      setExportProgress({
        stage: 'rendering_audio',
        progressPercent: 10,
        message: 'Шаг 1/4 (0% → 30%): C++ DSP подготовка и нормализация громкости (-18 dBFS)...',
        logs: ['[Шаг 1] Выравнивание громкости и инициализация WASM SIMD памяти']
      });

      const normResult = performLoudnessMatching(tracks, -18.0, -1.0);
      const normalizedTracks = normResult.updatedTracks;
      setTracks(normalizedTracks);

      setExportProgress({
        stage: 'rendering_audio',
        progressPercent: 30,
        message: 'Шаг 2/4 (30%): C++ BatchOfflineRenderer (100x DSP) & RIFF WAV упаковка...',
        logs: ['[Шаг 2] Высокоскоростное суммирование клипов, фейдов и оффсетов в C++ ядре']
      });

      const renderDuration = videoDuration > 0 ? videoDuration : undefined;
      const renderResult = await globalRenderManager.renderMasterMix(
        normalizedTracks,
        master,
        48000,
        24,
        renderDuration
      );

      // Сохраняем мастер-микс WAV в папку project/ через File System Access API
      await globalProjectManager.saveRenderedAsset('master_mix.wav', renderResult.wavBlob, true);

      // Если видео нет — отдаем готовый мастер WAV
      if (!videoFile) {
        setExportProgress({
          stage: 'completed',
          progressPercent: 100,
          message: 'Готово! Мастер-микс WAV (48 кГц / 24-bit) успешно сведен и сохранен в папку проекта.',
          logs: ['Мастер-файл master_mix.wav сохранен в project/']
        });
        setStatusMessage('Мастер-микс WAV успешно сведен и сохранен в project/!');
        return;
      }

      // 30% -> 70%: FFmpeg WASM Muxing
      setExportProgress({
        stage: 'muxing_video',
        progressPercent: 70,
        message: 'Шаг 3/4 (70%): FFmpeg WASM муксинг (-c:v copy -c:a aac -b:a 320k)...',
        logs: ['[Шаг 3] Подмена оригинального аудиопотока в видеофайле без перекодирования картинки']
      });

      const outputFileName = `mixed_${videoFile.name.replace(/\.[^/.]+$/, '')}.mp4`;
      const finalVideoBlob = await globalRenderManager.muxAudioIntoVideo(
        videoFile,
        renderResult.wavBlob,
        outputFileName
      );

      if (!finalVideoBlob) {
        throw new Error('FFmpeg WebAssembly не смог сформировать выходной видеофайл.');
      }

      setExportedVideoBlob(finalVideoBlob);
      const finalUrl = URL.createObjectURL(finalVideoBlob);
      setExportedVideoUrl(finalUrl);

      // 70% -> 100%: Запись в подпапку project/ через File System Access API
      setExportProgress({
        stage: 'completed',
        progressPercent: 95,
        message: 'Шаг 4/4 (95% → 100%): Запись готового MP4 в подпапку project/ (File System Access API)...',
        logs: [`[Шаг 4] Прямая запись ${outputFileName} в хранилище проекта`]
      });

      // Сохраняем в подпапку project/
      await globalProjectManager.saveRenderedAsset(outputFileName, finalVideoBlob, true);
      // И в корень для быстрого доступа
      await globalProjectManager.saveRenderedAsset(outputFileName, finalVideoBlob, false);

      // Кэшируем ассет рендера в локальную SQL базу данных
      await AssetDatabase.getInstance().saveAsset({
        id: `render_${Date.now()}`,
        name: outputFileName,
        type: 'render',
        mimeType: 'video/mp4',
        sizeBytes: finalVideoBlob.size,
        timestamp: Date.now(),
        blob: finalVideoBlob
      });
      AssetDatabase.getInstance().getStats().then(setDbStats).catch(console.error);

      setExportProgress({
        stage: 'completed',
        progressPercent: 100,
        message: `Готово! Видео успешно сведено и сохранено: ${outputFileName}`,
        logs: [`Файл ${outputFileName} (${(finalVideoBlob.size / (1024 * 1024)).toFixed(2)} МБ) готов к просмотру.`]
      });
      setStatusMessage(`Видео [${outputFileName}] успешно сведено и сохранено в project/!`);
      systemLogger.info('RenderManager', `Сквозной процесс завершен: ${outputFileName} (${Math.round(finalVideoBlob.size / 1024)} КБ)`);
    } catch (err: any) {
      console.error('Ошибка сквозного сведения и муксинга:', err);
      systemLogger.error('RenderManager', `Сбой сквозного конвейера: ${err?.message || err}`, err, err instanceof Error ? err.stack : undefined);
      setExportProgress({
        stage: 'error',
        progressPercent: 0,
        message: `Ошибка сведения: ${err.message}`,
        logs: [`[Error] ${err.message}`]
      });
      setStatusMessage(`Сбой сведения: ${err.message}`);
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

            {/* Кнопка универсального импорта медиа */}
            <button
              id="btn-media-import-modal"
              onClick={() => setShowMediaImportModal(true)}
              className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-500 hover:to-emerald-500 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-2 shadow-lg shadow-cyan-950/40 cursor-pointer"
              title="Догрузить недостающие медиаматериалы (видео, аудио, субтитры)"
            >
              <Upload size={14} />
              Догрузить файлы
            </button>

            {/* Кнопка открытия директории */}
            <button
              id="btn-open-project-folder"
              onClick={handleOpenProjectFolder}
              disabled={isFileSystemLoading}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-900 text-slate-200 border border-slate-700 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 cursor-pointer"
            >
              {isFileSystemLoading ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <FolderOpen size={14} />
              )}
              Выбрать рабочую папку
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
                Новый сведенный микс
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
                Только оригинальный звук видео
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
                  <p className="text-[11px] text-slate-400">FFmpeg WebAssembly (-c:v copy -c:a aac -b:a 320k)</p>
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
              disabled={isExporting}
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
                  Свести и сохранить готовое видео
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 2.5. МУЛЬТИТРЕК ТАЙМЛАЙН & ВОЛНОВЫЕ ФОРМЫ (ВИДЕОДОРОЖКА, СУБТИТРЫ, C++ STRIP SILENCE, TIME STRETCH WSOLA) */}
      <div className="bg-[#0f1422] border border-[#1e293b] p-5 rounded-2xl shadow-xl space-y-4">
        <TimelineView
          tracks={tracks}
          currentTimeSec={currentTimeSec}
          totalTimeSec={videoDuration > 0 ? videoDuration : 30}
          isPlaying={isPlaying}
          onSeek={seek}
          onUpdateTrack={handleUpdateTrack}
          syncAllTracks={syncAllTracks}
          syncTrackClips={syncTrackClips}
          videoFile={videoFile}
          videoSrc={videoSrc}
          videoDuration={videoDuration}
          fps={fps}
          onTogglePlay={togglePlay}
          subtitles={subtitles}
          onUpdateSubtitles={setSubtitles}
        />
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

          <div className="flex flex-wrap items-center gap-2">
            <button
              id="btn-import-track-hub"
              onClick={() => setShowMediaImportModal(true)}
              className="px-3 py-2 bg-gradient-to-r from-cyan-900/60 to-emerald-900/60 hover:from-cyan-800/80 hover:to-emerald-800/80 text-cyan-300 border border-cyan-700/80 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
              title="Догрузить дубли актеров, звуки или субтитры без сброса проекта"
            >
              <Upload size={14} className="text-cyan-400" />
              Догрузить файлы
            </button>

            <button
              id="btn-add-track"
              onClick={handleAddNewTrack}
              disabled={tracks.length >= 32}
              className="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-emerald-400 border border-emerald-800/80 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              title="Добавить пустую аудиодорожку (до 32)"
            >
              <Plus size={14} />
              + Новая дорожка ({tracks.length}/32)
            </button>

            <button
              id="btn-sql-db-stats"
              onClick={() => {
                AssetDatabase.getInstance().getStats().then(setDbStats).catch(console.error);
                alert(`📦 SQL Хранилище IndexedDB:\n• Всего ассетов: ${dbStats?.totalAssets || 0}\n• Размер в БД: ${(dbStats?.totalSizeMb || 0).toFixed(2)} МБ\n• Аудиодорожек: ${dbStats?.audioCount || 0}\n• Видео: ${dbStats?.videoCount || 0}\n\nВсе медиафайлы хранятся вне кучи WebAssembly, предотвращая сбои Out of Memory!`);
              }}
              className="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-cyan-400 border border-cyan-800/80 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
              title="Статус локальной SQL/IndexedDB базы данных ассетов"
            >
              <Database size={14} />
              SQL База ({dbStats ? `${dbStats.totalSizeMb.toFixed(1)} МБ` : 'OK'})
            </button>

            <button
              id="btn-loudness-match-broadcast"
              onClick={() => handleAutoLoudnessMatch(-18.0)}
              className="px-3.5 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-bold rounded-xl text-xs transition-all flex items-center gap-1.5 shadow-lg shadow-blue-950/40 cursor-pointer"
              title="Выровнять громкость всех дорожек под стандарт дубляжа (-18 dBFS True Peak <= -1.0)"
            >
              <Wand2 size={14} className="text-amber-300" />
              Выровнять громкость всех дорожек (-18 dBFS)
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

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800">
                        CH {track.id}
                      </span>
                      {tracks.length > 1 && (
                        <button
                          onClick={() => handleRemoveTrack(track.id)}
                          className="p-1 text-slate-500 hover:text-rose-400 hover:bg-slate-900 rounded transition-all cursor-pointer"
                          title="Удалить дорожку"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Аудиоклип & Загрузка файла */}
                  <div className="flex items-center justify-between gap-2 mb-3 bg-slate-950/60 p-2 rounded-lg border border-slate-800/80">
                    <div className="text-[11px] truncate flex-1">
                      {hasClips ? (
                        <span className="text-emerald-400 font-medium truncate block" title={track.clips[0].name}>
                          {track.clips[0].name} ({((track.clips[0].lengthSamples || 0) / 48000).toFixed(1)}с)
                        </span>
                      ) : (
                        <span className="text-slate-500">Нет аудиофайла</span>
                      )}
                    </div>

                    <label className="shrink-0 px-2 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 rounded text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-all">
                      <Upload size={10} />
                      <span>{hasClips ? 'Заменить' : 'Загрузить'}</span>
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleTrackFileUpload(track.id, f);
                        }}
                        className="hidden"
                      />
                    </label>
                  </div>

                  {/* Кнопка открытия C++ DSP рэка */}
                  <button
                    onClick={() => setActiveDspTrackId(activeDspTrackId === track.id ? null : track.id)}
                    className="w-full mb-3 px-2.5 py-1.5 bg-[#0f1422] hover:bg-slate-800 border border-slate-700/80 rounded-lg text-xs font-semibold text-slate-200 flex items-center justify-between transition-all cursor-pointer shadow-sm"
                  >
                    <div className="flex items-center gap-1.5">
                      <SlidersHorizontal size={13} className="text-cyan-400" />
                      <span>C++ DSP Vocal Rack</span>
                    </div>

                    <div className="flex items-center gap-1">
                      <span
                        className={`text-[9px] px-1 py-0.2 rounded font-mono ${
                          track.eq.enabled ? 'bg-cyan-950 text-cyan-400 border border-cyan-800' : 'bg-slate-900 text-slate-600'
                        }`}
                      >
                        EQ
                      </span>
                      <span
                        className={`text-[9px] px-1 py-0.2 rounded font-mono ${
                          track.compressor.enabled
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                            : 'bg-slate-900 text-slate-600'
                        }`}
                      >
                        COMP
                      </span>
                      <span
                        className={`text-[9px] px-1 py-0.2 rounded font-mono ${
                          track.autoDucker.enabled
                            ? 'bg-purple-950 text-purple-400 border border-purple-800'
                            : 'bg-slate-900 text-slate-600'
                        }`}
                      >
                        DUCK
                      </span>
                    </div>
                  </button>

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

      {/* Встроенный C++ DSP Vocal Rack рэк для выбранного трека */}
      {activeDspTrack && (
        <TrackDSPPanel
          track={activeDspTrack}
          allTracks={tracks}
          onUpdateTrack={handleUpdateDspTrack}
          onClose={() => setActiveDspTrackId(null)}
        />
      )}

      {/* Единый модальный хаб импорта медиаматериалов */}
      <MediaImportModal
        isOpen={showMediaImportModal}
        onClose={() => setShowMediaImportModal(false)}
        existingTracks={tracks}
        currentVideoFile={videoFile}
        onResetProjectState={handleResetMinimalProjectState}
        onImportVideo={handleModalImportVideo}
        onImportAudioTrack={handleModalImportAudioTrack}
        onImportSubtitles={handleModalImportSubtitles}
      />
    </div>
  );
};
