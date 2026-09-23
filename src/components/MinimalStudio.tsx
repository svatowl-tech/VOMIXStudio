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
  Layers,
  X,
  Terminal,
  BrainCircuit
} from 'lucide-react';
import { systemLogger } from '../services/SystemLogger';
import { useAudioEngine } from '../hooks/useAudioEngine';
import { TrackState, MasterState, LiveDAWEngine, createNewTrack, VocalBusState, createDefaultVocalBus, ClipConfig } from '../audio/dawEngine';
import { VSTPluginInstance } from '../audio/vstTypes';
import { MediaNormalizer } from '../services/MediaNormalizer';
import { ProjectState, globalProjectManager } from '../services/ProjectManager';
import { RenderProgressInfo, globalRenderManager } from '../services/RenderManager';
import { AssetDatabase, DatabaseStats } from '../services/AssetDatabase';
import { MVPPreset } from '../services/MVPPresetManager';
import { MVPPipelinePresets } from './MVPPipelinePresets';
import { VSTRackSlot } from './VSTRackSlot';
import { TrackDSPPanel } from './TrackDSPPanel';
import { TimelineView } from './TimelineView';
import { MediaImportModal } from './MediaImportModal';
import { VocalBusSection } from './VocalBusSection';
import { MasterSection } from './MasterSection';
import { DubbingAIStudio } from './DubbingAIStudio';
import { SubtitleCue } from '../services/ProjectManager';
import { formatSMPTE } from '../utils/waveformUtils';
import { VoiceoverMixWizardModal } from './VoiceoverMixWizardModal';
import { ClipCollisionInfo } from '../utils/collisionDetector';
import { globalAIPipelineStore } from '../services/AIPipelineStore';
import { globalStemSeparationService } from '../services/StemSeparationService';
import { globalAudioAICleanupEngine } from '../services/AudioAICleanupEngine';
import { toSafeArray, toSafeMap, toSafeSet } from '../utils/safeIterables';

export const MinimalStudio: React.FC = () => {
  // --- 1. Аудиодвижок DAW и AudioWorklet ---
  const {
    isInitialized,
    isPlaying,
    currentTimeSec,
    trackMeters,
    vocalBusMeter,
    masterMeter,
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
    setTrackDsp,
    setTrackEq,
    setTrackCompressor,
    setTrackNoiseGate,
    setTrackDeEsser,
    setTrackAutoDucker,
    setVocalBus,
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

  // --- 2. Состояние дорожек и мастера проекта (Поддержка до 32 дорожек) ---
  const [tracks, setTracks] = useState<TrackState[]>(() => toSafeArray<TrackState>(new LiveDAWEngine().getTracks()));
  const [vocalBus, setVocalBusState] = useState<VocalBusState>(() => createDefaultVocalBus());

  // Автоматическая фоновая синхронизация дорожек и клипов с AudioWorklet
  useEffect(() => {
    const safeTracks = toSafeArray<TrackState>(tracks);
    if (isInitialized && safeTracks.length > 0) {
      syncAllTracks(safeTracks);
    }
  }, [isInitialized, tracks, syncAllTracks]);

  // Синхронизация Vocal Bus с AudioWorklet
  useEffect(() => {
    if (isInitialized && vocalBus) {
      setVocalBus(vocalBus);
    }
  }, [isInitialized, vocalBus, setVocalBus]);

  const [activeDspTrackId, setActiveDspTrackId] = useState<number | null>(null);
  const activeDspTrack = toSafeArray<TrackState>(tracks).find((t) => t && t.id === activeDspTrackId) || null;
  const [activeVstTrackId, setActiveVstTrackId] = useState<number | null>(null);
  const activeVstTrack = toSafeArray<TrackState>(tracks).find((t) => t && t.id === activeVstTrackId) || null;
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
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>(() => toSafeArray<SubtitleCue>([]));
  const [isWizardOpen, setIsWizardOpen] = useState<boolean>(false);
  const [detectedCollisions, setDetectedCollisions] = useState<ClipCollisionInfo[]>(() => toSafeArray<ClipCollisionInfo>([]));

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
        const safeTracksList = toSafeArray<TrackState>(tracks);
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
          tracks: safeTracksList.map((t) => {
            const safeClips = toSafeArray<ClipConfig>(t.clips);
            return {
              id: t.id,
              name: t.name,
              fileName: safeClips[0]?.name || '',
              volumeDb: t.volumeDb,
              pan: t.pan,
              solo: t.solo,
              mute: t.mute,
              offsetSec: safeClips[0]?.offsetSamples ? (safeClips[0].offsetSamples / 48000) : 0,
              color: t.color
            };
          }),
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

      const discoveredFiles = toSafeArray(content.discoveredFiles);

      // 1. Автоматическое обнаружение видеофайла
      const discoveredVideo = discoveredFiles.find((f) => f && f.type === 'video');
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
      const audioFiles = discoveredFiles.filter((f) => f && f.type === 'audio');
      if (audioFiles.length > 0) {
        setStatusMessage(`C++ ресемплинг ${audioFiles.length} аудиодорожек к 48 кГц...`);

        // Динамически увеличиваем количество дорожек под все найденные файлы (до 32)
        let workingTracks = [...toSafeArray<TrackState>(tracks)];
        while (workingTracks.length < audioFiles.length && workingTracks.length < 32) {
          const nextId = workingTracks.length + 1;
          workingTracks.push(createNewTrack(nextId, `Dubber ${nextId}`));
        }

        for (let i = 0; i < audioFiles.length && i < workingTracks.length; i++) {
          const audioFile = audioFiles[i].fileObj;
          if (audioFile) {
            try {
              const track = workingTracks[i];
              const clipId = Date.now() + i;
              const uploadRes = await uploadAudioFileToTrack(audioFile, track.id, clipId, 0);

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
                    id: clipId,
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
        const savedTracks = toSafeArray(content.savedState.tracks);
        if (savedTracks.length > 0) {
          setTracks((prev) =>
            toSafeArray<TrackState>(prev).map((t) => {
              const matched = savedTracks.find((st) => st && (st.id === t.id || st.name === t.name));
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

      const discoveredFiles = toSafeArray(content.discoveredFiles);
      const discoveredVideo = discoveredFiles.find((f) => f && f.type === 'video');
      if (discoveredVideo && discoveredVideo.fileObj) {
        setVideoFile(discoveredVideo.fileObj);
        setVideoSrc(URL.createObjectURL(discoveredVideo.fileObj));
      }

      const audioFiles = discoveredFiles.filter((f) => f && f.type === 'audio');
      if (audioFiles.length > 0) {
        let workingTracks = [...toSafeArray<TrackState>(tracks)];
        while (workingTracks.length < audioFiles.length && workingTracks.length < 32) {
          const nextId = workingTracks.length + 1;
          workingTracks.push(createNewTrack(nextId, `Dubber ${nextId}`));
        }

        for (let i = 0; i < audioFiles.length && i < workingTracks.length; i++) {
          const audioFile = audioFiles[i].fileObj;
          if (audioFile) {
            const track = workingTracks[i];
            const clipId = Date.now() + i;
            const uploadRes = await uploadAudioFileToTrack(audioFile, track.id, clipId, 0);

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
                  id: clipId,
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

  // Извлечение звука оригинала на Дорожку №1 (C++ resample)
  const extractAndLoadVideoAudio = async (file: File) => {
    setIsExtractingAudio(true);
    setStatusMessage(`Извлечение звуковой дорожки из видео [${file.name}] (48 кГц)...`);

    try {
      if (!isInitialized) {
        await initAudioEngine();
      }

      const pcmFloat32 = await MediaNormalizer.extractAudioFromVideo(file, 48000);
      if (!pcmFloat32 || pcmFloat32.length === 0) {
        setStatusMessage(`Видео [${file.name}] загружено (звуковая дорожка не найдена).`);
        return;
      }

      const totalFrames = pcmFloat32.length / 2;
      const calcDur = totalFrames / 48000;
      setVideoDuration((prev) => (prev > 0 ? prev : calcDur));

      const safeTracks = toSafeArray<TrackState>(tracks);
      const targetTrackId = safeTracks.length > 0 ? safeTracks[0].id : 1;
      const clipId = Date.now();

      setTracks((prev) => {
        const safePrev = toSafeArray<TrackState>(prev);
        const tid = safePrev.length > 0 ? safePrev[0].id : 1;
        const videoClip = {
          id: clipId,
          name: `Оригинал: ${file.name}`,
          offsetSamples: 0,
          lengthSamples: totalFrames,
          gain: 1.0,
          pan: 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          buffer: pcmFloat32,
          color: '#06b6d4'
        };

        const exists = safePrev.some((t) => t.id === tid);
        if (exists) {
          return safePrev.map((t) =>
            t.id === tid
              ? {
                  ...t,
                  name: `Оригинал [${file.name}]`,
                  isOriginalAudio: true,
                  clips: [videoClip]
                }
              : t
          );
        } else {
          const newTr = createNewTrack(tid, `Оригинал [${file.name}]`, '#06b6d4');
          newTr.isOriginalAudio = true;
          newTr.clips = [videoClip];
          return [...safePrev, newTr];
        }
      });

      uploadRawPCMToTrack(pcmFloat32, targetTrackId, clipId, 0, 1.0, 0.0, true);
      setStatusMessage(`Оригинальный звук видео [${file.name}] загружен на Дорожку 1!`);
      triggerAutoSave();
    } catch (err: any) {
      console.warn('Ошибка извлечения звука видео:', err);
      setStatusMessage(`Ошибка извлечения звука: ${err?.message || err}`);
    } finally {
      setIsExtractingAudio(false);
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

    // Автоматически извлекаем оригинальный звук на Дорожку 1
    extractAndLoadVideoAudio(file);
  };

  // Извлечение звука оригинала по кнопке на панели
  const handleExtractVideoAudio = async () => {
    if (!videoFile) return;
    await extractAndLoadVideoAudio(videoFile);
  };

  // --- 9. Изменение параметров микшера ---
  const handleVolumeChange = (trackId: number, volumeDb: number) => {
    setTrackVolume(trackId, volumeDb);
    setTracks((prev) => toSafeArray<TrackState>(prev).map((t) => (t.id === trackId ? { ...t, volumeDb } : t)));
    triggerAutoSave();
  };

  const handlePanChange = (trackId: number, pan: number) => {
    setTrackPan(trackId, pan);
    setTracks((prev) => toSafeArray<TrackState>(prev).map((t) => (t.id === trackId ? { ...t, pan } : t)));
    triggerAutoSave();
  };

  const handleMuteToggle = (trackId: number) => {
    const safeTracks = toSafeArray<TrackState>(tracks);
    const track = safeTracks.find((t) => t && t.id === trackId);
    if (!track) return;
    const newMute = !track.mute;
    setTrackMute(trackId, newMute);
    setTracks((prev) => toSafeArray<TrackState>(prev).map((t) => (t.id === trackId ? { ...t, mute: newMute } : t)));
    triggerAutoSave();
  };

  const handleSoloToggle = (trackId: number) => {
    const safeTracks = toSafeArray<TrackState>(tracks);
    const track = safeTracks.find((t) => t && t.id === trackId);
    if (!track) return;
    const newSolo = !track.solo;
    setTrackSolo(trackId, newSolo);
    setTracks((prev) => toSafeArray<TrackState>(prev).map((t) => (t.id === trackId ? { ...t, solo: newSolo } : t)));
    triggerAutoSave();
  };

  // Добавление новой аудиодорожки (поддержка 20-25+ дорожек)
  const handleAddNewTrack = () => {
    const safeTracks = toSafeArray<TrackState>(tracks);
    if (safeTracks.length >= 32) {
      alert('Достигнут максимальный лимит дорожек (32).');
      return;
    }
    const trackIds = safeTracks.map((t) => t.id).filter((id) => typeof id === 'number');
    const nextId = trackIds.length > 0 ? Math.max(...trackIds) + 1 : 1;
    const newTr = createNewTrack(nextId, `Dubber ${nextId}`);
    setTracks((prev) => [...toSafeArray<TrackState>(prev), newTr]);
    triggerAutoSave();
    setStatusMessage(`Добавлена новая дорожка CH ${nextId} (всего дорожек: ${safeTracks.length + 1})`);
  };

  // Удаление дорожки
  const handleRemoveTrack = (trackId: number) => {
    const safeTracks = toSafeArray<TrackState>(tracks);
    if (safeTracks.length <= 1) {
      alert('Нельзя удалить последнюю дорожку.');
      return;
    }
    setTracks((prev) => toSafeArray<TrackState>(prev).filter((t) => t.id !== trackId));
    triggerAutoSave();
    setStatusMessage(`Дорожка CH ${trackId} удалена.`);
  };

  // Добавление стем-дорожек после AI разделения (Вокал + Фонограмма M&E)
  const handleAddStemTracks = (
    vocalsPcm: Float32Array,
    karaokePcm: Float32Array,
    vocalsName = 'Изолированный вокал',
    karaokeName = 'Фонограмма M&E'
  ) => {
    const safeTracks = toSafeArray<TrackState>(tracks);
    const trackIds = safeTracks.map((t) => t.id).filter((id) => typeof id === 'number');
    const nextId = trackIds.length > 0 ? Math.max(...trackIds) + 1 : 1;
    const vocalsClip: ClipConfig = {
      id: Date.now() + 1,
      name: vocalsName,
      offsetSamples: 0,
      lengthSamples: Math.floor(vocalsPcm.length / 2),
      gain: 1.0,
      pan: 0,
      fadeInSamples: 2400,
      fadeOutSamples: 2400,
      buffer: vocalsPcm,
      color: '#10b981'
    };
    const karaokeClip: ClipConfig = {
      id: Date.now() + 2,
      name: karaokeName,
      offsetSamples: 0,
      lengthSamples: Math.floor(karaokePcm.length / 2),
      gain: 0.85,
      pan: 0,
      fadeInSamples: 2400,
      fadeOutSamples: 2400,
      buffer: karaokePcm,
      color: '#06b6d4'
    };

    const newVocalsTrack: TrackState = {
      ...createNewTrack(nextId, vocalsName, '#10b981'),
      clips: [vocalsClip]
    };

    const newKaraokeTrack: TrackState = {
      ...createNewTrack(nextId + 1, karaokeName, '#06b6d4'),
      volumeDb: -1.5,
      clips: [karaokeClip]
    };

    const updatedTracks = [...safeTracks, newVocalsTrack, newKaraokeTrack];
    setTracks(updatedTracks);
    syncAllTracks(updatedTracks);
    triggerAutoSave();
    setStatusMessage(`Стемы успешно добавлены в проект: "${vocalsName}" и "${karaokeName}"!`);
  };

  // Применение обработанного нейросетью аудио к целевой дорожке
  const handleApplyProcessedAudioToTrack = (
    trackId: number,
    newPcm: Float32Array,
    clipName = 'Обработанное аудио'
  ) => {
    const lengthSamples = Math.floor(newPcm.length / 2);
    const clipId = Date.now();
    const newClip: ClipConfig = {
      id: clipId,
      name: clipName,
      offsetSamples: 0,
      lengthSamples: lengthSamples,
      gain: 1.0,
      pan: 0,
      fadeInSamples: 2400,
      fadeOutSamples: 2400,
      buffer: newPcm,
      color: '#10b981'
    };

    const updatedTracks = toSafeArray<TrackState>(tracks).map((t) => {
      if (t.id === trackId) {
        return {
          ...t,
          clips: [newClip]
        };
      }
      return t;
    });

    setTracks(updatedTracks);
    syncAllTracks(updatedTracks);
    uploadRawPCMToTrack(newPcm, trackId, clipId, 0, 1.0, 0.0, true);
    triggerAutoSave();
    setStatusMessage(`AI-обработанное аудио успешно применено к Дорожке CH #${trackId}!`);
  };

  // Загрузка аудиофайла напрямую в дорожку
  const handleTrackFileUpload = async (trackId: number, file: File) => {
    if (!isInitialized) {
      await initAudioEngine();
    }
    setStatusMessage(`Загрузка и ресемплинг "${file.name}" в CH ${trackId}...`);
    try {
      const clipId = Date.now();
      const uploadRes = await uploadAudioFileToTrack(file, trackId, clipId, 0);

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
        toSafeArray<TrackState>(prev).map((t) =>
          t.id === trackId
            ? {
                ...t,
                name: file.name.replace(/\.[^/.]+$/, ''),
                clips: [
                  {
                    id: clipId,
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
      const clipId = Date.now();
      const safeTracks = toSafeArray<TrackState>(tracks);
      const targetId = safeTracks.length > 0 ? safeTracks[0].id : 1;

      setTracks((prev) => {
        const safePrev = toSafeArray<TrackState>(prev);
        const tid = safePrev.length > 0 ? safePrev[0].id : 1;
        const videoClip = {
          id: clipId,
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

        const exists = safePrev.some((t) => t.id === tid);
        if (exists) {
          return safePrev.map((t) =>
            t.id === tid
              ? {
                  ...t,
                  name: `Оригинал [${file.name}]`,
                  isOriginalAudio: true,
                  clips: [videoClip]
                }
              : t
          );
        } else {
          const newTr = createNewTrack(tid, `Оригинал [${file.name}]`, '#06b6d4');
          newTr.isOriginalAudio = true;
          newTr.clips = [videoClip];
          return [...safePrev, newTr];
        }
      });

      uploadRawPCMToTrack(audioPcm, targetId, clipId, 0, 1.0, 0.0, true);
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

    const safeTracks = toSafeArray<TrackState>(tracks);
    const trackIds = safeTracks.map((t) => t.id).filter((id) => typeof id === 'number');
    const targetTrackId = config.trackId || (trackIds.length > 0 ? Math.max(...trackIds) + 1 : 1);
    const isOriginal = /оригинал|original|видео|video|отригал|orig/i.test(config.name || file.name);

    setTracks((prev) => {
      const safePrev = toSafeArray<TrackState>(prev);
      const existing = safePrev.find((t) => t.id === targetTrackId);
      if (!existing || !config.replaceExisting) {
        const newTrack = createNewTrack(targetTrackId, config.name, config.color);
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
            color: config.color || newTrack.color
          }
        ];
        return [...safePrev, newTrack];
      } else {
        return safePrev.map((t) =>
          t.id === targetTrackId
            ? {
                ...t,
                name: config.name || t.name,
                color: config.color || t.color,
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
                    color: config.color || t.color
                  }
                ]
              }
            : t
        );
      }
    });

    uploadRawPCMToTrack(pcmBuffer, targetTrackId, clipId, 0, 1.0, 0.0, true);
    triggerAutoSave();
  };

  const handleModalImportSubtitles = async (cues: SubtitleCue[], sourceFileName?: string) => {
    setSubtitles(toSafeArray<SubtitleCue>(cues));
    setStatusMessage(`Субтитры [${sourceFileName || 'файл'}] импортированы: ${toSafeArray<SubtitleCue>(cues).length} реплик.`);
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
    setTracks((prev) => toSafeArray<TrackState>(prev).map((t) => (t.id === updated.id ? updated : t)));

    // Передаем параметры в реальном времени в AudioWorklet (онлайн-обработка)
    setTrackDsp(updated.id, {
      eq: updated.eq,
      compressor: updated.compressor,
      noiseGate: updated.noiseGate,
      deEsser: updated.deEsser,
      deClicker: updated.deClicker,
      autoDucker: updated.autoDucker
    });
    setTrackEq(updated.id, updated.eq);
    setTrackCompressor(updated.id, updated.compressor);
    setTrackNoiseGate(updated.id, updated.noiseGate);
    setTrackDeEsser(updated.id, updated.deEsser);
    setTrackAutoDucker(updated.id, updated.autoDucker);

    triggerAutoSave();
  };

  const handleUpdateVocalBus = (updated: VocalBusState) => {
    setVocalBusState(updated);
    setVocalBus(updated);
    triggerAutoSave();
  };

  // --- VST Инсерты и Обработка цепочек эффектов ---
  const handleUpdateTrackVstChain = (trackId: number, vstPlugins: VSTPluginInstance[]) => {
    const safePlugins = toSafeArray<VSTPluginInstance>(vstPlugins);
    setTracks((prev) =>
      toSafeArray<TrackState>(prev).map((t) => (t.id === trackId ? { ...t, vstPlugins: safePlugins } : t))
    );
    setTrackVstChain(trackId, safePlugins);
    triggerAutoSave();
  };

  const handleUpdateVocalBusVstChain = (vstPlugins: VSTPluginInstance[]) => {
    const safePlugins = toSafeArray<VSTPluginInstance>(vstPlugins);
    setVocalBusState((prev) => ({ ...prev, vstPlugins: safePlugins }));
    setVocalBusVstChain(safePlugins);
    triggerAutoSave();
  };

  const handleUpdateMasterVstChain = (vstPlugins: VSTPluginInstance[]) => {
    const safePlugins = toSafeArray<VSTPluginInstance>(vstPlugins);
    setMaster((prev) => ({ ...prev, vstPlugins: safePlugins }));
    setMasterVstChain(safePlugins);
    triggerAutoSave();
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

  // --- Применение пресета на весь MVP пайплайн («Закадр», «Рекаст», «Ридап», «Дубляж») ---
  const handleApplyGlobalPreset = (preset: MVPPreset) => {
    systemLogger.info('MVPPreset', `Применение пресета пайплайна: "${preset.name}" (${preset.category})`);

    // 1. Применяем DSP и VST цепочки к дорожкам
    setTracks((prevTracks) => {
      const updated = toSafeArray<TrackState>(prevTracks).map((t, idx) => {
        const custom = toSafeArray(preset.customTrackChains).find((c) => c.trackIndex === idx);
        const newEq = custom?.dsp?.eq
          ? JSON.parse(JSON.stringify(custom.dsp.eq))
          : preset.trackDspTemplate?.eq
          ? JSON.parse(JSON.stringify(preset.trackDspTemplate.eq))
          : t.eq;
        const newComp = custom?.dsp?.compressor
          ? JSON.parse(JSON.stringify(custom.dsp.compressor))
          : preset.trackDspTemplate?.compressor
          ? JSON.parse(JSON.stringify(preset.trackDspTemplate.compressor))
          : t.compressor;
        const newDuck = custom?.dsp?.autoDucker
          ? JSON.parse(JSON.stringify(custom.dsp.autoDucker))
          : preset.trackDspTemplate?.autoDucker
          ? JSON.parse(JSON.stringify(preset.trackDspTemplate.autoDucker))
          : t.autoDucker;
        const newGate = custom?.dsp?.noiseGate
          ? JSON.parse(JSON.stringify(custom.dsp.noiseGate))
          : preset.trackDspTemplate?.noiseGate
          ? JSON.parse(JSON.stringify(preset.trackDspTemplate.noiseGate))
          : t.noiseGate;
        const newDeEsser = custom?.dsp?.deEsser
          ? JSON.parse(JSON.stringify(custom.dsp.deEsser))
          : preset.trackDspTemplate?.deEsser
          ? JSON.parse(JSON.stringify(preset.trackDspTemplate.deEsser))
          : t.deEsser;
        const newPlugins = custom?.vstPlugins
          ? JSON.parse(JSON.stringify(custom.vstPlugins))
          : preset.trackVstChain
          ? JSON.parse(JSON.stringify(preset.trackVstChain))
          : toSafeArray(t.vstPlugins);

        return {
          ...t,
          eq: newEq,
          compressor: newComp,
          autoDucker: newDuck,
          noiseGate: newGate,
          deEsser: newDeEsser,
          vstPlugins: newPlugins
        };
      });

      // Синхронизируем с AudioWorklet
      toSafeArray(updated).forEach((t) => {
        setTrackDsp(t.id, {
          eq: t.eq,
          compressor: t.compressor,
          autoDucker: t.autoDucker,
          noiseGate: t.noiseGate,
          deEsser: t.deEsser
        });
        setTrackVstChain(t.id, toSafeArray(t.vstPlugins));
      });

      return updated;
    });

    // 2. Применяем Vocal Bus
    if (preset.vocalBusSettings) {
      const newVocalBusDsp = JSON.parse(JSON.stringify(preset.vocalBusSettings.dsp));
      const newVocalBusPlugins = preset.vocalBusSettings.vstChain
        ? JSON.parse(JSON.stringify(preset.vocalBusSettings.vstChain))
        : toSafeArray(vocalBus.vstPlugins);

      const newVocalBus: VocalBusState = {
        ...vocalBus,
        volumeDb: preset.vocalBusSettings.volumeDb ?? vocalBus.volumeDb,
        pan: preset.vocalBusSettings.pan ?? vocalBus.pan,
        dsp: newVocalBusDsp,
        vstPlugins: newVocalBusPlugins
      };
      setVocalBusState(newVocalBus);
      setVocalBus(newVocalBus);
      setVocalBusVstChain(newVocalBusPlugins);
    }

    // 3. Применяем Master Limiter & Master Plugins
    if (preset.masterSettings) {
      const newMasterPlugins = preset.masterSettings.vstChain
        ? JSON.parse(JSON.stringify(preset.masterSettings.vstChain))
        : toSafeArray(master.vstPlugins);

      const newMaster: MasterState = {
        ...master,
        volumeDb: preset.masterSettings.volumeDb ?? master.volumeDb,
        pan: preset.masterSettings.pan ?? master.pan,
        limiterEnabled: preset.masterSettings.limiterEnabled,
        limiterCeilingDb: preset.masterSettings.limiterCeilingDb,
        vstPlugins: newMasterPlugins
      };
      setMaster(newMaster);
      setMasterLimiter(newMaster.limiterEnabled, newMaster.limiterCeilingDb);
      setMasterVstChain(newMasterPlugins);
    }

    setStatusMessage(`Применен пресет пайплайна: "${preset.name}" (${preset.category})`);
    triggerAutoSave();
  };

  // Обновление дорожки и клипов из TimelineView (Сплит, Time Stretch, перемещение клипов)
  const handleUpdateTrack = (updatedTrack: TrackState) => {
    setTracks((prev) => toSafeArray<TrackState>(prev).map((t) => (t.id === updatedTrack.id ? updatedTrack : t)));

    // Синхронизируем клипы с AudioWorklet и C++ ядром
    syncTrackClips(updatedTrack.id, toSafeArray(updatedTrack.clips));

    triggerAutoSave();
  };

  // --- 10. Шаг 3: Автоматическое выравнивание громкости (C++ Loudness Match EBU R128) ---
  const handleAutoLoudnessMatch = (targetRmsDb = -18.0) => {
    const safeTracks = toSafeArray<TrackState>(tracks);
    const result = performLoudnessMatching(safeTracks, targetRmsDb, -1.0);
    setTracks(result.updatedTracks);
    systemLogger.info('C++ WASM', `Выполнено выравнивание громкости дорожек (цель: ${targetRmsDb} dBFS True Peak ≤ -1.0)`, {
      adjustments: result.adjustments
    });

    const activeAdjustments = toSafeArray(result.adjustments).filter((a) => !a.isSilent);
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

  // --- 11. Сквозной конвейер «Закадровый Мастер Сведения» (Interactive Wizard) ---
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
    const safeTracks = toSafeArray<TrackState>(tracks);
    const hasActiveClips = safeTracks.some((t) => toSafeArray(t.clips).length > 0 && toSafeArray(t.clips).some((c) => c.lengthSamples > 0));
    if (!hasActiveClips) {
      alert('На таймлайне нет аудиодорожек или клипов для сведения. Пожалуйста, догрузите аудиофайлы или выберите рабочую папку.');
      setShowMediaImportModal(true);
      return;
    }

    // Открываем пошаговый интерактивный конвейер
    setIsWizardOpen(true);
  };

  // Коллбэк Шага 1 Wizard: AI Очистка и EBU R128 Нормализация
  const handleRunAIPipelineAndNorm = async (
    onProgress?: (msg: string, percent: number) => void
  ): Promise<TrackState[]> => {
    let currentTracks = [...toSafeArray<TrackState>(tracks)];
    const configs = globalAIPipelineStore.getConfigs();
    
    // Сбор дорожек при разделении
    const newTracksToAdd: TrackState[] = [];
    
    const activeConfigs = Object.values(configs).filter(
      (c) => c.enabled && toSafeArray(c.steps).filter((s) => s.enabled).length > 0
    );
    
    const totalStepsToRun = activeConfigs.reduce(
      (acc, c) => acc + toSafeArray(c.steps).filter((s) => s.enabled).length,
      0
    );
    
    let processedStepsCount = 0;
    
    if (onProgress) {
      onProgress('Запуск EBU R128 нормализации громкости на всех дорожках перед ИИ-обработкой...', 2);
    }
    
    // Шаг 1. Нормализуем громкость на всех дорожках на уровне файлов/буферов
    try {
      const normResult = MediaNormalizer.autoMatchTrackVolumes(currentTracks, -18.0, -1.0);
      const normalizedTracks: TrackState[] = [];
      for (const track of toSafeArray<TrackState>(currentTracks)) {
        const adj = toSafeArray(normResult.adjustments).find((a) => a.trackId === track.id);
        if (!adj || adj.isSilent || Math.abs(adj.gainChangeDb) < 0.01) {
          normalizedTracks.push({ ...track, volumeDb: 0.0 });
          continue;
        }

        const updatedClips: ClipConfig[] = [];
        for (const clip of toSafeArray<ClipConfig>(track.clips)) {
          let newBuf = clip.buffer;
          let newUntrimmed = clip.untrimmedBuffer;

          if (clip.buffer && clip.buffer.length > 0) {
            newBuf = MediaNormalizer.applyGain(clip.buffer, adj.gainChangeDb, true);
            // Загружаем нормализованный буфер в C++ аудио ядро
            await uploadRawPCMToTrack(
              newBuf,
              track.id,
              clip.id,
              clip.offsetSamples || 0,
              1.0, // Сбрасываем коэффициент усиления клипа в 1.0, так как гейн уже применен в буфер
              clip.trimStartSamples || 0,
              true
            );
          }
          if (clip.untrimmedBuffer && clip.untrimmedBuffer.length > 0) {
            newUntrimmed = MediaNormalizer.applyGain(clip.untrimmedBuffer, adj.gainChangeDb, true);
          }

          updatedClips.push({
            ...clip,
            gain: 1.0, // Гейн клипа также сбрасываем в 1.0
            buffer: newBuf,
            untrimmedBuffer: newUntrimmed
          });
        }

        normalizedTracks.push({
          ...track,
          clips: updatedClips,
          volumeDb: 0.0 // fader сбрасывается в 0, так как гейн уже в файлах
        });
      }
      
      currentTracks = normalizedTracks;
      setTracks(currentTracks);
      syncAllTracks(currentTracks);
      
      const summary = toSafeArray(normResult.adjustments)
        .map((a) => `${a.trackName}: ${a.gainChangeDb >= 0 ? '+' : ''}${a.gainChangeDb.toFixed(1)} dB`)
        .join(' | ');
      setLoudnessMatchReport(`C++ выравнивание громкости (-18 dBFS): ${summary}`);
    } catch (normErr: any) {
      console.error('[Normalizer Error]', normErr);
    }
    
    if (onProgress) {
      onProgress(`Начало AI-обработки для ${activeConfigs.length} дорожек на основе нормализованных файлов...`, 5);
    }
    
    for (const track of toSafeArray<TrackState>(currentTracks)) {
      const config = configs[track.id];
      if (!config || !config.enabled) continue;
      
      const activeSteps = toSafeArray(config.steps).filter((s) => s.enabled);
      if (activeSteps.length === 0) continue;
      
      // Получаем буфер клипа
      const safeClips = toSafeArray<ClipConfig>(track.clips);
      if (safeClips.length === 0) continue;
      const clip = safeClips[0];
      const pcm = clip.buffer;
      if (!pcm || pcm.length === 0) continue;
      
      // Последовательное выполнение AI шагов
      let currentPcm: any = new Float32Array(pcm);
      let vocalsPcm: any = null;
      let karaokePcm: any = null;
      const trackName = track.name || `Дорожка ${track.id}`;
      
      for (let idx = 0; idx < activeSteps.length; idx++) {
        const step = activeSteps[idx];
        const stepName = step.purpose === 'stem_separation' ? 'Разделение дорожек'
                        : step.purpose === 'denoise' ? 'Шумоподавление'
                        : step.purpose === 'dereverb' ? 'Устранение эха'
                        : step.purpose === 'spectral_match' ? 'Спектральное выравнивание'
                        : step.purpose === 'voicefixer' ? 'Восстановление Air-Band'
                        : step.purpose === 'vocal_chain' ? 'Голосовая AI-цепочка'
                        : step.purpose;
        
        processedStepsCount++;
        const percent = Math.min(95, Math.round(5 + (processedStepsCount / (totalStepsToRun || 1)) * 90));
        
        if (onProgress) {
          onProgress(`[${trackName}] Выполняется ${stepName}...`, percent);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        
        if (step.purpose === 'stem_separation') {
          const totalFrames = Math.floor((currentPcm as Float32Array).length / 2);
          const left = new Float32Array(totalFrames);
          const right = new Float32Array(totalFrames);
          for (let i = 0; i < totalFrames; i++) {
            left[i] = currentPcm[i * 2];
            right[i] = currentPcm[i * 2 + 1];
          }
          
          const sepRes = await globalStemSeparationService.separateStereoBuffer(left, right, {
            sampleRate: 48000
          });
          
          vocalsPcm = new Float32Array(totalFrames * 2);
          karaokePcm = new Float32Array(totalFrames * 2);
          for (let i = 0; i < totalFrames; i++) {
            vocalsPcm[i * 2] = sepRes.vocalsStereo[0][i];
            vocalsPcm[i * 2 + 1] = sepRes.vocalsStereo[1][i];
            karaokePcm[i * 2] = sepRes.vocalsStereo[0][i]; // Backup
            karaokePcm[i * 2 + 1] = sepRes.karaokeStereo[1][i];
          }
          currentPcm = vocalsPcm;
        } else if (step.purpose === 'denoise') {
          currentPcm = await globalAudioAICleanupEngine.processDenoise(currentPcm, {
            modelId: step.modelId,
            intensityPercent: step.intensity,
            lowCutHz: step.enableLowCut ? 80 : 0,
            sampleRate: 48000
          });
        } else if (step.purpose === 'dereverb') {
          currentPcm = await globalAudioAICleanupEngine.processDereverb(currentPcm, {
            modelId: step.modelId,
            reductionAmountPercent: step.dereverbAmount,
            sampleRate: 48000
          });
        } else if (step.purpose === 'spectral_match') {
          const refTrack = currentTracks[0] || track;
          const refClip = toSafeArray<ClipConfig>(refTrack.clips)[0];
          const refPcm = refClip?.buffer || pcm;
          const specRes = await globalAudioAICleanupEngine.matchVocalCurves(
            refPcm,
            currentPcm,
            {
              matchIntensity: step.intensity,
              smoothingBands: 3,
              formantWeight: 0.75
            }
          );
          currentPcm = specRes.processedBuffer;
        } else if (step.purpose === 'voicefixer') {
          currentPcm = await globalAudioAICleanupEngine.processVoiceFixer(currentPcm, {
            airBandBoostDb: step.airBandBoost,
            declipSensitivity: 0.8,
            warmthSaturation: step.warmthSat / 100,
            subBassTuning: step.enableLowCut,
            sampleRate: 48000
          });
        } else if (step.purpose === 'vocal_chain') {
          const denoised = await globalAudioAICleanupEngine.processDenoise(currentPcm, {
            modelId: step.modelId,
            intensityPercent: step.intensity,
            lowCutHz: step.enableLowCut ? 80 : 0,
            sampleRate: 48000
          });
          const dereverbed = await globalAudioAICleanupEngine.processDereverb(denoised, {
            modelId: 'reverb_foxjoy',
            reductionAmountPercent: step.dereverbAmount,
            sampleRate: 48000
          });
          currentPcm = await globalAudioAICleanupEngine.processVoiceFixer(dereverbed, {
            airBandBoostDb: step.airBandBoost,
            declipSensitivity: 0.85,
            warmthSaturation: step.warmthSat / 100,
            sampleRate: 48000
          });
        }
      }
      
      if (config.outputMode === 'replace') {
        currentTracks = toSafeArray<TrackState>(currentTracks).map((t) => {
          if (t.id === track.id) {
            const currentClip = toSafeArray<ClipConfig>(t.clips)[0] || clip;
            const updatedClip = {
              ...currentClip,
              name: `${clip.name} [AI Processed]`,
              buffer: currentPcm,
              lengthSamples: Math.floor(currentPcm.length / 2)
            };
            return {
              ...t,
              clips: [updatedClip]
            };
          }
          return t;
        });
        
        await uploadRawPCMToTrack(currentPcm, track.id, clip.id, 0, 1.0, 0, true);
      } else if (config.outputMode === 'stems' && vocalsPcm && karaokePcm) {
        const lengthSamples = Math.floor(vocalsPcm.length / 2);
        const vocalsTrackId = Date.now() + Math.floor(Math.random() * 1000);
        const karaokeTrackId = vocalsTrackId + 1;
        
        const newVocalsTrack: TrackState = {
          ...createNewTrack(vocalsTrackId, `[Вокал] ${trackName}`, '#10b981'),
          clips: [
            {
              id: Date.now() + 2,
              name: `[Вокал] ${clip.name}`,
              offsetSamples: 0,
              lengthSamples: lengthSamples,
              gain: 1.0,
              pan: 0,
              fadeInSamples: 2400,
              fadeOutSamples: 2400,
              buffer: vocalsPcm,
              color: '#10b981'
            }
          ]
        };
        
        const newKaraokeTrack: TrackState = {
          ...createNewTrack(karaokeTrackId, `[Фонограмма M&E] ${trackName}`, '#3b82f6'),
          clips: [
            {
              id: Date.now() + 3,
              name: `[Фонограмма M&E] ${clip.name}`,
              offsetSamples: 0,
              lengthSamples: lengthSamples,
              gain: 1.0,
              pan: 0,
              fadeInSamples: 2400,
              fadeOutSamples: 2400,
              buffer: karaokePcm,
              color: '#3b82f6'
            }
          ]
        };
        
        newTracksToAdd.push(newVocalsTrack, newKaraokeTrack);
        
        await uploadRawPCMToTrack(vocalsPcm, vocalsTrackId, newVocalsTrack.clips[0].id, 0, 1.0, 0, true);
        await uploadRawPCMToTrack(karaokePcm, karaokeTrackId, newKaraokeTrack.clips[0].id, 0, 1.0, 0, true);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    
    const finalTracksList = [...toSafeArray<TrackState>(currentTracks), ...newTracksToAdd];
    setTracks(finalTracksList);
    syncAllTracks(finalTracksList);
    
    if (onProgress) {
      onProgress('AI обработка и нормализация успешно завершены!', 100);
    }
    
    return finalTracksList;
  };

  // Коллбэк Шага 4 Wizard: Финальный Мастеринг и FFmpeg Muxing
  const handleRunFinalMasterAndMux = async (
    updatedTracks: TrackState[],
    updatedVocalBus: VocalBusState
  ): Promise<{ videoBlob: Blob | null; videoUrl: string | null; outputFileName: string }> => {
    setIsExporting(true);
    setExportedVideoBlob(null);
    setExportedVideoUrl(null);

    const safeTracks = toSafeArray<TrackState>(updatedTracks);
    const renderDuration = videoDuration > 0 ? videoDuration : undefined;
    const renderResult = await globalRenderManager.renderMasterMix(
      safeTracks,
      master,
      48000,
      24,
      renderDuration,
      updatedVocalBus
    );

    // Сохраняем мастер-микс WAV в папку project/ через File System Access API
    await globalProjectManager.saveRenderedAsset('master_mix.wav', renderResult.wavBlob, true);

    if (!videoFile) {
      const audioUrl = URL.createObjectURL(renderResult.wavBlob);
      setIsExporting(false);
      return {
        videoBlob: renderResult.wavBlob,
        videoUrl: audioUrl,
        outputFileName: 'master_mix.wav'
      };
    }

    const timelineHasOriginalAudio = safeTracks.some(
      (t) =>
        (t.name.toLowerCase().includes('видео') ||
          t.name.toLowerCase().includes('video') ||
          t.name.toLowerCase().includes('оригинал')) &&
        toSafeArray(t.clips).length > 0 &&
        !t.mute
    );

    const outputFileName = `mixed_${videoFile.name.replace(/\.[^/.]+$/, '')}.mp4`;
    const finalVideoBlob = await globalRenderManager.muxAudioIntoVideo(
      videoFile,
      renderResult.wavBlob,
      outputFileName,
      { timelineHasOriginalAudio }
    );

    if (!finalVideoBlob) {
      throw new Error('FFmpeg WebAssembly не смог сформировать выходной видеофайл.');
    }

    setExportedVideoBlob(finalVideoBlob);
    const finalUrl = URL.createObjectURL(finalVideoBlob);
    setExportedVideoUrl(finalUrl);

    // Сохраняем готовый MP4 в подпапку project/ и корень
    await globalProjectManager.saveRenderedAsset(outputFileName, finalVideoBlob, true);
    await globalProjectManager.saveRenderedAsset(outputFileName, finalVideoBlob, false);

    // Кэшируем ассет в SQL БД
    await AssetDatabase.getInstance().saveAsset({
      id: `render_${Date.now()}`,
      name: outputFileName,
      type: 'render',
      mimeType: 'video/mp4',
      sizeBytes: finalVideoBlob.size,
      timestamp: Date.now(),
      blob: finalVideoBlob
    });

    setIsExporting(false);
    return {
      videoBlob: finalVideoBlob,
      videoUrl: finalUrl,
      outputFileName
    };
  };

  // Покадровый шаг видео
  const handleStepFrame = (deltaFrames: number) => {
    const frameTime = 1 / fps;
    const newTime = Math.max(0, Math.min(videoDuration, currentTimeSec + deltaFrames * frameTime));
    seek(newTime);
  };

  const safeTracksList = toSafeArray<TrackState>(tracks);

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

      {/* СИСТЕМА ПРЕСЕТОВ ВСЕГО ПАЙПЛАЙНА (Закадр, Рекаст, Ридап, Дубляж) */}
      <MVPPipelinePresets
        tracks={tracks}
        vocalBus={vocalBus}
        master={master}
        onApplyPreset={handleApplyGlobalPreset}
      />

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
          tracks={safeTracksList}
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
          collisions={detectedCollisions}
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
              disabled={safeTracksList.length >= 32}
              className="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-emerald-400 border border-emerald-800/80 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              title="Добавить пустую аудиодорожку (до 32)"
            >
              <Plus size={14} />
              + Новая дорожка ({safeTracksList.length}/32)
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
          {safeTracksList.map((track) => {
            const meterData = trackMeters?.get?.(track.id);
            const peakDbL = meterData ? MediaNormalizer.linearToDb(meterData.peakL) : -60;
            const peakDbR = meterData ? MediaNormalizer.linearToDb(meterData.peakR) : -60;
            const isClipping = (meterData?.peakL || 0) >= 0.9999 || (meterData?.peakR || 0) >= 0.9999;
            const safeClips = toSafeArray<ClipConfig>(track.clips);
            const hasClips = safeClips.length > 0;
            const safeVstPlugins = toSafeArray<VSTPluginInstance>(track.vstPlugins);

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
                      {safeTracksList.length > 1 && (
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
                        <span className="text-emerald-400 font-medium truncate block" title={safeClips[0].name}>
                          {safeClips[0].name} ({((safeClips[0].lengthSamples || 0) / 48000).toFixed(1)}с)
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

                  {/* Кнопка открытия VST Рэка инсертов */}
                  <button
                    onClick={() => setActiveVstTrackId(activeVstTrackId === track.id ? null : track.id)}
                    className="w-full mb-3 px-2.5 py-1.5 bg-[#141026] hover:bg-slate-800 border border-violet-800/60 rounded-lg text-xs font-semibold text-slate-200 flex items-center justify-between transition-all cursor-pointer shadow-sm"
                  >
                    <div className="flex items-center gap-1.5">
                      <Layers size={13} className="text-violet-400" />
                      <span>VST Инсерты</span>
                    </div>

                    <span className="text-[10px] px-1.5 py-0.2 rounded font-mono bg-violet-950 text-violet-300 border border-violet-800">
                      {safeVstPlugins.length > 0 ? `${safeVstPlugins.length} плаг.` : 'Пусто'}
                    </span>
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

        {/* 3.1. Мастер-секция вокальной шины (Master Voiceover Bus) и Мастер-микс */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-4 border-t border-slate-800">
          <VocalBusSection
            vocalBus={vocalBus}
            vocalBusMeter={vocalBusMeter}
            onUpdateVocalBus={handleUpdateVocalBus}
            onUpdateVstChain={handleUpdateVocalBusVstChain}
            onUpdateVstParam={(instId, pId, val) => handleUpdateVstParam('vocalBus', instId, pId, val)}
            onUpdateVstBypass={(instId, enabled) => handleUpdateVstBypass('vocalBus', instId, enabled)}
            onUpdateVstWetDry={(instId, wetDry) => handleUpdateVstWetDry('vocalBus', instId, wetDry)}
          />
          <MasterSection
            master={{
              ...master,
              peakL: masterMeter.peakL,
              peakR: masterMeter.peakR,
              clipped: masterMeter.clipped
            }}
            isPlaying={isPlaying}
            onTogglePlay={togglePlay}
            onReset={() => seek(0)}
            onUpdateMaster={(updated) => {
              setMaster(updated);
              setMasterVolume(updated.volumeDb);
              setMasterLimiter(updated.limiterEnabled, updated.limiterCeilingDb);
              triggerAutoSave();
            }}
            onUpdateVstChain={handleUpdateMasterVstChain}
            onUpdateVstParam={(instId, pId, val) => handleUpdateVstParam('master', instId, pId, val)}
            onUpdateVstBypass={(instId, enabled) => handleUpdateVstBypass('master', instId, enabled)}
            onUpdateVstWetDry={(instId, wetDry) => handleUpdateVstWetDry('master', instId, wetDry)}
          />
        </div>
      </div>

      {/* 4. МАТРИЦА МАРШРУТИЗАЦИИ НЕЙРОСЕТЕВОЙ ОБРАБОТКИ (Track AI Matrix Pipeline) */}
      <div className="pt-2">
        <DubbingAIStudio
          mode="matrix-only"
          tracks={safeTracksList}
          currentTimeSec={currentTimeSec}
          onSeek={seek}
          onAddStemTracks={handleAddStemTracks}
          onApplyProcessedAudioToTrack={handleApplyProcessedAudioToTrack}
        />
      </div>

      {/* Модальное окно VST Рэка выбранного трека */}
      {activeVstTrack && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-[#0b0f19] border border-slate-800 rounded-2xl p-6 max-w-xl w-full shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-3.5 h-3.5 rounded-full" style={{ backgroundColor: activeVstTrack.color }} />
                <h3 className="text-sm font-bold text-slate-100">
                  VST инсерты: {activeVstTrack.name}
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-mono">
                  CH {activeVstTrack.id}
                </span>
              </div>
              <button
                onClick={() => setActiveVstTrackId(null)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <VSTRackSlot
              plugins={toSafeArray(activeVstTrack.vstPlugins)}
              title={`Инсерты: ${activeVstTrack.name}`}
              badge={`CH ${activeVstTrack.id}`}
              color={activeVstTrack.color || '#8b5cf6'}
              onUpdateChain={(newChain) => handleUpdateTrackVstChain(activeVstTrack.id, newChain)}
              onUpdateParam={(instId, pId, val) => handleUpdateVstParam('track', instId, pId, val, activeVstTrack.id)}
              onUpdateBypass={(instId, enabled) => handleUpdateVstBypass('track', instId, enabled, activeVstTrack.id)}
              onUpdateWetDry={(instId, wetDry) => handleUpdateVstWetDry('track', instId, wetDry, activeVstTrack.id)}
            />
          </div>
        </div>
      )}

      {/* Встроенный C++ DSP Vocal Rack рэк для выбранного трека */}
      {activeDspTrack && (
        <TrackDSPPanel
          track={activeDspTrack}
          allTracks={safeTracksList}
          onUpdateTrack={handleUpdateDspTrack}
          onClose={() => setActiveDspTrackId(null)}
        />
      )}

      {/* Единый модальный хаб импорта медиаматериалов */}
      <MediaImportModal
        isOpen={showMediaImportModal}
        onClose={() => setShowMediaImportModal(false)}
        existingTracks={safeTracksList}
        currentVideoFile={videoFile}
        onResetProjectState={handleResetMinimalProjectState}
        onImportVideo={handleModalImportVideo}
        onImportAudioTrack={handleModalImportAudioTrack}
        onImportSubtitles={handleModalImportSubtitles}
      />

      {/* Пошаговый интерактивный конвейер сведения закадрового дубляжа */}
      <VoiceoverMixWizardModal
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        tracks={safeTracksList}
        setTracks={setTracks}
        vocalBus={vocalBus}
        setVocalBus={setVocalBus}
        master={master}
        videoFile={videoFile}
        videoDuration={videoDuration}
        currentTimeSec={currentTimeSec}
        isPlaying={isPlaying}
        onTogglePlay={togglePlay}
        onSeek={seek}
        onRunAIPipelineAndNorm={handleRunAIPipelineAndNorm}
        onRunFinalMasterAndMux={handleRunFinalMasterAndMux}
        onCollisionsDetected={setDetectedCollisions}
      />
    </div>
  );
};
