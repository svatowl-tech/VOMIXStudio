import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { TrackState, ClipConfig } from '../audio/dawEngine';
import { SubtitleCue } from '../services/ProjectManager';
import { WaveformCanvas } from './WaveformCanvas';
import { formatSMPTE, formatCompactTime, getAdaptiveTimeStep } from '../utils/waveformUtils';
import { globalNativeDAWBridge } from '../services/NativeDAWBridge';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Clock,
  Magnet,
  Volume2,
  Sliders,
  Scissors,
  ChevronsLeftRight,
  Move,
  Film,
  Play,
  Pause,
  Trash2,
  Gauge,
  Sparkles,
  Check,
  Zap,
  FileText,
  Plus,
  Edit3,
  CheckCircle2,
  AlertCircle,
  X,
  Layers,
  Music,
  Disc,
  Mic,
  Settings2,
  VolumeX
} from 'lucide-react';

export interface TimelineViewProps {
  tracks: TrackState[];
  currentTimeSec: number;
  totalTimeSec?: number;
  isPlaying?: boolean;
  onSeek: (timeSec: number) => void;
  onUpdateTrack?: (updatedTrack: TrackState) => void;
  syncAllTracks?: (tracks: TrackState[]) => void;
  syncTrackClips?: (trackId: number, clips: ClipConfig[]) => void;
  onSyncAllTracks?: (tracks: TrackState[]) => void;
  onSyncTrackClips?: (trackId: number, clips: ClipConfig[]) => void;
  // Видеодорожка и синхронизация
  videoFile?: File | null;
  videoSrc?: string | null;
  videoDuration?: number;
  fps?: number;
  onTogglePlay?: () => void;
  // Дорожка субтитров
  subtitles?: SubtitleCue[];
  onUpdateSubtitles?: (cues: SubtitleCue[]) => void;
  onSelectCue?: (cue: SubtitleCue) => void;
}

type DragMode =
  | 'move'
  | 'trim-start'
  | 'trim-end'
  | 'fade-in'
  | 'fade-out'
  | 'time-stretch'
  | 'cue-move'
  | 'cue-start'
  | 'cue-end'
  | null;

type ActiveTool = 'pointer' | 'razor' | 'stretch' | 'subtitle';

interface ActiveDragState {
  trackId?: number;
  clipId?: number;
  cueIndex?: number;
  mode: DragMode;
  startX: number;
  initialOffsetSamples?: number;
  initialLengthSamples?: number;
  initialFadeInSamples?: number;
  initialFadeOutSamples?: number;
  currentLengthSamples?: number;
  initialCueStartSec?: number;
  initialCueEndSec?: number;
  currentCueStartSec?: number;
  currentCueEndSec?: number;
}

export const TimelineView: React.FC<TimelineViewProps> = ({
  tracks,
  currentTimeSec,
  totalTimeSec = 30,
  isPlaying = false,
  onSeek,
  onUpdateTrack,
  syncAllTracks,
  syncTrackClips,
  onSyncAllTracks,
  onSyncTrackClips,
  videoFile,
  videoSrc,
  videoDuration = 0,
  fps = 30,
  onTogglePlay,
  subtitles: externalSubtitles,
  onUpdateSubtitles: externalOnUpdateSubtitles,
  onSelectCue
}) => {
  const sampleRate = 48000;
  const tracksRef = useRef<TrackState[]>(tracks);
  tracksRef.current = tracks;

  const handleSyncAllTracks = useCallback((updatedTracks: TrackState[]) => {
    if (syncAllTracks) {
      syncAllTracks(updatedTracks);
    } else if (onSyncAllTracks) {
      onSyncAllTracks(updatedTracks);
    }
  }, [syncAllTracks, onSyncAllTracks]);

  const handleSyncTrackClips = useCallback((trackId: number, clips: ClipConfig[]) => {
    if (syncTrackClips) {
      syncTrackClips(trackId, clips);
    } else if (onSyncTrackClips) {
      onSyncTrackClips(trackId, clips);
    }
  }, [syncTrackClips, onSyncTrackClips]);

  // Локальное состояние субтитров (синхронизировано с external)
  const [internalSubtitles, setInternalSubtitles] = useState<SubtitleCue[]>(() => {
    return (
      externalSubtitles || [
        {
          index: 1,
          startSec: 1.0,
          endSec: 4.5,
          speaker: 'Диктор',
          text: 'Добро пожаловать в профессиональную студию дубляжа Vomix Studio.'
        },
        {
          index: 2,
          startSec: 5.2,
          endSec: 9.0,
          speaker: 'Персонаж 1',
          text: 'Мы синхронизируем русскую озвучку с оригинальным видеорядом.'
        }
      ]
    );
  });

  const subtitles = externalSubtitles !== undefined ? externalSubtitles : internalSubtitles;
  const setSubtitles = useCallback(
    (newCues: SubtitleCue[] | ((prev: SubtitleCue[]) => SubtitleCue[])) => {
      if (typeof newCues === 'function') {
        const updated = newCues(subtitles);
        if (externalOnUpdateSubtitles) {
          externalOnUpdateSubtitles(updated);
        } else {
          setInternalSubtitles(updated);
        }
      } else {
        if (externalOnUpdateSubtitles) {
          externalOnUpdateSubtitles(newCues);
        } else {
          setInternalSubtitles(newCues);
        }
      }
    },
    [externalOnUpdateSubtitles, subtitles]
  );

  // Выбранные сущности
  const [selectedClipId, setSelectedClipId] = useState<number | null>(null);
  const [selectedCueIndex, setSelectedCueIndex] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<ActiveTool>('pointer');

  // Масштаб отображения (пикселей на секунду времени)
  const [pxPerSec, setPxPerSec] = useState<number>(60);
  const [useSMPTE, setUseSMPTE] = useState<boolean>(true);
  const [snapToGrid, setSnapToGrid] = useState<boolean>(true);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  // Модальные окна
  const [stretchDialogOpen, setStretchDialogOpen] = useState<boolean>(false);
  const [targetStretchRatio, setTargetStretchRatio] = useState<string>('1.00');

  const [stripSilenceModalOpen, setStripSilenceModalOpen] = useState<boolean>(false);
  const [stripThresholdDb, setStripThresholdDb] = useState<number>(-40);
  const [stripMinSilenceMs, setStripMinSilenceMs] = useState<number>(300);
  const [stripPaddingMs, setStripPaddingMs] = useState<number>(60);
  const [stripTargetTrackId, setStripTargetTrackId] = useState<number>(tracks[0]?.id || 1);

  const [cueEditorOpen, setCueEditorOpen] = useState<boolean>(false);
  const [editingCue, setEditingCue] = useState<SubtitleCue | null>(null);

  // Уведомления таймлайна
  const [timelineNotice, setTimelineNotice] = useState<{ text: string; type: 'success' | 'info' | 'warn' } | null>(
    null
  );

  // Состояние нативной C++ ошибки
  const [nativeError, setNativeError] = useState<{ message: string; context: string } | null>(null);

  const handleNativeError = useCallback((err: any, context: string) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Native C++ Error in ${context}]:`, err);
    setNativeError({ message: msg, context });
  }, []);

  // Ссылки на контейнеры для синхронизации прокрутки и 60 FPS плейхеда
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const rulerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const currentTimeSecRef = useRef<number>(currentTimeSec);
  currentTimeSecRef.current = currentTimeSec;

  // Состояние активного перетаскивания (Drag / Trim / Fade / Time-Stretch / Cue)
  const [activeDrag, setActiveDrag] = useState<ActiveDragState | null>(null);

  // Показ уведомлений на 3.5 секунды
  const showNotice = useCallback((text: string, type: 'success' | 'info' | 'warn' = 'success') => {
    setTimelineNotice({ text, type });
    setTimeout(() => {
      setTimelineNotice((prev) => (prev?.text === text ? null : prev));
    }, 3500);
  }, []);

  // Вычисление максимальной длины проекта с учетом видео, всех аудиоклипов и субтитров
  const effectiveDurationSec = useMemo(() => {
    let maxSec = Math.max(totalTimeSec, videoDuration);
    tracks.forEach((t) => {
      t.clips.forEach((c) => {
        const endSec = (c.offsetSamples + c.lengthSamples) / sampleRate;
        if (endSec > maxSec) maxSec = endSec;
      });
    });
    subtitles.forEach((s) => {
      if (s.endSec > maxSec) maxSec = s.endSec;
    });
    return Math.max(maxSec + 5, 20);
  }, [tracks, subtitles, totalTimeSec, videoDuration, sampleRate]);

  const totalWidthPx = Math.max(900, Math.floor(effectiveDurationSec * pxPerSec));

  // ==========================================================================
  // 60 FPS REQUEST ANIMATION FRAME PLAYHEAD
  // ==========================================================================
  useEffect(() => {
    let animId: number;

    const renderPlayhead = () => {
      if (playheadRef.current) {
        const x = currentTimeSecRef.current * pxPerSec;
        playheadRef.current.style.transform = `translateX(${x}px)`;

        // Авто-прокрутка таймлайна при воспроизведении
        if (isPlaying && autoScroll && timelineScrollRef.current) {
          const scrollLeft = timelineScrollRef.current.scrollLeft;
          const containerWidth = timelineScrollRef.current.clientWidth;
          if (x > scrollLeft + containerWidth - 120) {
            timelineScrollRef.current.scrollLeft = x - 120;
          } else if (x < scrollLeft) {
            timelineScrollRef.current.scrollLeft = Math.max(0, x - 60);
          }
        }
      }
      animId = requestAnimationFrame(renderPlayhead);
    };

    animId = requestAnimationFrame(renderPlayhead);
    return () => cancelAnimationFrame(animId);
  }, [pxPerSec, isPlaying, autoScroll]);

  // ==========================================================================
  // ОТРИСОВКА СЕТКИ ВРЕМЕНИ И РАЗМЕТКИ (RULER CANVAS)
  // ==========================================================================
  const renderRuler = useCallback(() => {
    const canvas = rulerCanvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = totalWidthPx;
    const height = 28;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Фон линейки
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, width, height);

    // Разделительная полоса
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();

    const { majorStepSec, minorStepSec } = getAdaptiveTimeStep(pxPerSec);
    const totalSteps = Math.ceil(effectiveDurationSec / minorStepSec);

    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';

    for (let i = 0; i <= totalSteps; i++) {
      const time = i * minorStepSec;
      const x = time * pxPerSec;
      const isMajor =
        Math.abs(time % majorStepSec) < 0.0001 ||
        Math.abs((time % majorStepSec) - majorStepSec) < 0.0001;

      if (isMajor) {
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, height - 12);
        ctx.lineTo(x, height);
        ctx.stroke();

        ctx.fillStyle = '#94a3b8';
        const label = useSMPTE ? formatSMPTE(time) : formatCompactTime(time);
        ctx.fillText(label, x + 4, 4);
      } else {
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x, height - 6);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    }
  }, [totalWidthPx, effectiveDurationSec, pxPerSec, useSMPTE]);

  useEffect(() => {
    renderRuler();
  }, [renderRuler]);

  // ==========================================================================
  // ЗУММИРОВАНИЕ КОЛЕСОМ МЫШИ
  // ==========================================================================
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) {
      e.preventDefault();
      const container = timelineScrollRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left + container.scrollLeft;
      const timeAtCursor = mouseX / pxPerSec;

      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      const newPxPerSec = Math.max(12, Math.min(500, pxPerSec * zoomFactor));

      setPxPerSec(newPxPerSec);

      requestAnimationFrame(() => {
        if (timelineScrollRef.current) {
          const newMouseX = timeAtCursor * newPxPerSec;
          timelineScrollRef.current.scrollLeft = newMouseX - (e.clientX - rect.left);
        }
      });
    }
  };

  // Клик по линейке или дорожкам для перемещения плейхеда
  const handleSeekByCoord = (clientX: number) => {
    const container = timelineScrollRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const clickX = clientX - rect.left + container.scrollLeft;
    let seekTime = Math.max(0, clickX / pxPerSec);

    if (snapToGrid) {
      const { minorStepSec } = getAdaptiveTimeStep(pxPerSec);
      seekTime = Math.round(seekTime / minorStepSec) * minorStepSec;
    }

    onSeek(seekTime);
  };

  // ==========================================================================
  // ФУНКЦИОНАЛ СПЛИТА (РАЗРЕЗАНИЕ ДОРОЖЕК / КЛИПОВ)
  // ==========================================================================
  const handleSplitClip = (trackId: number, clipId: number, splitTimeSec: number) => {
    if (!globalNativeDAWBridge.isReady) {
      handleNativeError(
        new Error('C++ WebAssembly ядро не инициализировано. Операции разрезания клипа заблокированы.'),
        'разрезания клипа (splitClipNative)'
      );
      return;
    }

    const track = tracks.find((t) => t.id === trackId);
    if (!track || !onUpdateTrack) return;

    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) return;

    const splitSample = Math.round(splitTimeSec * sampleRate);
    const clipStartSample = clip.offsetSamples;
    const clipEndSample = clip.offsetSamples + clip.lengthSamples;

    // Минимальная длина отрезка 50 мс
    const minSamples = Math.round(sampleRate * 0.05);

    if (splitSample <= clipStartSample + minSamples || splitSample >= clipEndSample - minSamples) {
      return;
    }

    const leftLength = splitSample - clipStartSample;
    const isStereo = clip.buffer.length >= clip.lengthSamples * 2;
    const channels = isStereo ? 2 : 1;

    try {
      // Исключительное C++ исполнение разрезания клипа в WASM-куче с наложением микро-фейдов
      const { left: leftBuffer, right: rightBuffer } = globalNativeDAWBridge.splitClipNative(
        clip.buffer,
        leftLength,
        channels
      );

      const leftClip: ClipConfig = {
        ...clip,
        lengthSamples: leftLength,
        buffer: leftBuffer,
        originalBuffer: leftBuffer,
        originalLengthSamples: leftLength,
        fadeOutSamples: Math.min(clip.fadeOutSamples, Math.floor(leftLength / 2))
      };

      const rightClip: ClipConfig = {
        ...clip,
        id: Date.now() + Math.floor(Math.random() * 1000),
        name: `${clip.name} (Part 2)`,
        offsetSamples: splitSample,
        lengthSamples: clip.lengthSamples - leftLength,
        buffer: rightBuffer,
        originalBuffer: rightBuffer,
        originalLengthSamples: clip.lengthSamples - leftLength,
        fadeInSamples: Math.min(clip.fadeInSamples, Math.floor((clip.lengthSamples - leftLength) / 2))
      };

      const newClips = track.clips.flatMap((c) => (c.id === clipId ? [leftClip, rightClip] : [c]));
      const updatedTrack = { ...track, clips: newClips };
      const newTracks = tracksRef.current.map((t) => (t.id === trackId ? updatedTrack : t));

      onUpdateTrack(updatedTrack);
      handleSyncTrackClips(trackId, newClips);
      handleSyncAllTracks(newTracks);

      setSelectedClipId(rightClip.id);
      showNotice(`✓ C++ Split: клип разрезан по таймкоду ${formatCompactTime(splitTimeSec)}`, 'info');
    } catch (err) {
      handleNativeError(err, 'разрезания клипа (splitClipNative)');
    }
  };

  // Разрезать клип под плейхедом (кнопка "Сплит" или 'S')
  const handleSplitAtPlayhead = () => {
    const currentSample = Math.round(currentTimeSec * sampleRate);
    let targetTrack: TrackState | null = null;
    let targetClip: ClipConfig | null = null;

    if (selectedClipId !== null) {
      for (const t of tracks) {
        const c = t.clips.find((item) => item.id === selectedClipId);
        if (c && currentSample > c.offsetSamples && currentSample < c.offsetSamples + c.lengthSamples) {
          targetTrack = t;
          targetClip = c;
          break;
        }
      }
    }

    if (!targetClip) {
      for (const t of tracks) {
        const c = t.clips.find(
          (item) =>
            currentSample > item.offsetSamples && currentSample < item.offsetSamples + item.lengthSamples
        );
        if (c) {
          targetTrack = t;
          targetClip = c;
          break;
        }
      }
    }

    if (targetTrack && targetClip) {
      handleSplitClip(targetTrack.id, targetClip.id, currentTimeSec);
    } else {
      showNotice('Под плейхедом нет аудиоклипа для разрезания', 'warn');
    }
  };

  // ==========================================================================
  // C++ STRIP SILENCE (УДАЛЕНИЕ ТИШИНЫ И АВТОМАТИЧЕСКАЯ НАРЕЗКА НА ФРАЗЫ)
  // ==========================================================================
  const handleExecuteStripSilence = (applyToAllTracks = false) => {
    if (!globalNativeDAWBridge.isReady) {
      handleNativeError(
        new Error('C++ WebAssembly ядро не инициализировано. Удаление тишины (Strip Silence) заблокировано.'),
        'удаления тишины (stripSilenceNative)'
      );
      return;
    }

    if (!onUpdateTrack) return;

    try {
      if (applyToAllTracks) {
        const currentTracks = tracksRef.current;
        let totalCreatedPhrases = 0;
        let totalSavedSec = 0;
        let processedTracksCount = 0;
        const updatedTracks: TrackState[] = [];

        for (const track of currentTracks) {
          if (!track.clips || track.clips.length === 0) {
            updatedTracks.push(track);
            continue;
          }

          let trackModified = false;
          const newTrackClips: ClipConfig[] = [];

          for (const clip of track.clips) {
            if (!clip.buffer || clip.buffer.length === 0 || clip.lengthSamples <= 0) {
              newTrackClips.push(clip);
              continue;
            }

            const isStereo = clip.buffer.length >= clip.lengthSamples * 2;
            const channels = isStereo ? 2 : 1;

            const segments = globalNativeDAWBridge.stripSilenceNative(
              clip.buffer,
              stripThresholdDb,
              stripMinSilenceMs,
              stripPaddingMs,
              isStereo,
              sampleRate
            );

            if (segments.length === 0) {
              newTrackClips.push(clip);
              continue;
            }

            trackModified = true;
            totalCreatedPhrases += segments.length;

            const originalSec = clip.lengthSamples / sampleRate;
            const speechSec = segments.reduce((acc, s) => acc + s.lengthSamples / sampleRate, 0);
            totalSavedSec += Math.max(0, originalSec - speechSec);

            const generatedClips: ClipConfig[] = segments.map((seg, idx) => {
              const segOffsetInClip = seg.offsetSamples;
              const segLength = seg.lengthSamples;

              // Исключительное C++ копирование подбуфера без JS slice
              const segBuffer = globalNativeDAWBridge.extractSubBufferNative(
                clip.buffer,
                segOffsetInClip,
                segLength,
                channels
              );
              const phraseOffsetGlobal = clip.offsetSamples + segOffsetInClip;
              const fadeLen = Math.min(Math.round(sampleRate * 0.01), Math.floor(segLength / 4));

              return {
                id: Date.now() + Math.floor(Math.random() * 100000) + idx * 10,
                name: `${clip.name} [Фраза ${idx + 1}]`,
                offsetSamples: phraseOffsetGlobal,
                lengthSamples: segLength,
                gain: clip.gain,
                pan: clip.pan,
                fadeInSamples: fadeLen,
                fadeOutSamples: fadeLen,
                buffer: segBuffer,
                originalBuffer: segBuffer,
                originalLengthSamples: segLength,
                color: clip.color || track.color || '#10b981'
              };
            });

            newTrackClips.push(...generatedClips);
          }

          if (trackModified) {
            processedTracksCount++;
            const updated = { ...track, clips: newTrackClips };
            updatedTracks.push(updated);
            onUpdateTrack(updated);
            handleSyncTrackClips(track.id, newTrackClips);
          } else {
            updatedTracks.push(track);
          }
        }

        if (processedTracksCount === 0 || totalCreatedPhrases === 0) {
          showNotice('На дорожках не обнаружено аудиофрагментов для удаления тишины.', 'warn');
          setStripSilenceModalOpen(false);
          return;
        }

        handleSyncAllTracks(updatedTracks);
        setStripSilenceModalOpen(false);

        showNotice(
          `✓ C++ Strip Silence: обработано ${processedTracksCount} дорожек, создано ${totalCreatedPhrases} фраз! Вырезано ${totalSavedSec.toFixed(1)}с пауз.`,
          'success'
        );
        return;
      }

      // Обработка выбранной целевой дорожки
      const targetTrack = tracks.find((t) => t.id === stripTargetTrackId) || tracks[0];
      if (!targetTrack) {
        showNotice('Целевая дорожка не найдена', 'warn');
        return;
      }

      // Если есть выделенный клип на этой дорожке, обрабатываем его, иначе первый клип с буфером
      let sourceClip = targetTrack.clips.find((c) => c.id === selectedClipId);
      if (!sourceClip && targetTrack.clips.length > 0) {
        sourceClip = targetTrack.clips[0];
      }

      if (!sourceClip || !sourceClip.buffer || sourceClip.buffer.length === 0) {
        showNotice(`На дорожке [${targetTrack.name}] нет аудиоклипов для анализа`, 'warn');
        return;
      }

      const isStereo = sourceClip.buffer.length >= sourceClip.lengthSamples * 2;
      const channels = isStereo ? 2 : 1;

      // Вызываем нативный C++ VAD стриппер
      const segments = globalNativeDAWBridge.stripSilenceNative(
        sourceClip.buffer,
        stripThresholdDb,
        stripMinSilenceMs,
        stripPaddingMs,
        isStereo,
        sampleRate
      );

      if (segments.length === 0) {
        showNotice('Звуковых сегментов выше порога не обнаружено.', 'warn');
        setStripSilenceModalOpen(false);
        return;
      }

      // Создаем массив нарезанных фраз без пауз тишины
      const newClips: ClipConfig[] = segments.map((seg, idx) => {
        const segOffsetInClip = seg.offsetSamples;
        const segLength = seg.lengthSamples;

        // Исключительное C++ копирование подбуфера без JS slice
        const segBuffer = globalNativeDAWBridge.extractSubBufferNative(
          sourceClip!.buffer,
          segOffsetInClip,
          segLength,
          channels
        );

        const phraseOffsetGlobal = sourceClip!.offsetSamples + segOffsetInClip;
        const fadeLen = Math.min(Math.round(sampleRate * 0.01), Math.floor(segLength / 4)); // 10ms кроссфейд

        return {
          id: Date.now() + idx * 10 + Math.floor(Math.random() * 10),
          name: `${sourceClip!.name} [Фраза ${idx + 1}]`,
          offsetSamples: phraseOffsetGlobal,
          lengthSamples: segLength,
          gain: sourceClip!.gain,
          pan: sourceClip!.pan,
          fadeInSamples: fadeLen,
          fadeOutSamples: fadeLen,
          buffer: segBuffer,
          originalBuffer: segBuffer,
          originalLengthSamples: segLength,
          color: sourceClip!.color || targetTrack.color || '#10b981'
        };
      });

      // Заменяем исходный длинный клип диктора на нарезанные фразы
      const updatedClips = targetTrack.clips.flatMap((c) =>
        c.id === sourceClip!.id ? newClips : [c]
      );

      const updatedTrack = { ...targetTrack, clips: updatedClips };
      const newTracks = tracksRef.current.map((t) => (t.id === targetTrack.id ? updatedTrack : t));

      onUpdateTrack(updatedTrack);
      handleSyncTrackClips(targetTrack.id, updatedClips);
      handleSyncAllTracks(newTracks);

      setSelectedClipId(newClips[0]?.id || null);
      setStripSilenceModalOpen(false);

      const totalSpeechSec = segments.reduce((acc, s) => acc + s.lengthSamples / sampleRate, 0);
      const originalSec = sourceClip.lengthSamples / sampleRate;
      const savedSec = Math.max(0, originalSec - totalSpeechSec);

      showNotice(
        `✓ C++ Strip Silence: создано ${segments.length} фраз! Вырезано ${savedSec.toFixed(1)}с пауз.`,
        'success'
      );
    } catch (err) {
      handleNativeError(err, 'удаления тишины (stripSilenceNative)');
    }
  };

  // ==========================================================================
  // WSOLA TIME STRETCH (СЖАТИЕ / РАСТЯЖЕНИЕ ФРАЗ БЕЗ ИЗМЕНЕНИЯ ВЫСОТЫ ТОНА)
  // ==========================================================================
  const handleTimeStretch = (trackId: number, clipId: number, targetLengthSamples: number) => {
    if (!globalNativeDAWBridge.isReady) {
      handleNativeError(
        new Error('C++ WebAssembly ядро не инициализировано. Изменение темпа WSOLA заблокировано.'),
        'растяжения времени WSOLA (processWSOLA)'
      );
      return;
    }

    const track = tracks.find((t) => t.id === trackId);
    if (!track || !onUpdateTrack) return;

    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) return;

    const baseBuffer = clip.originalBuffer || clip.buffer;
    const baseLength = clip.originalLengthSamples || clip.lengthSamples;

    const isStereo = clip.buffer.length >= clip.lengthSamples * 2;
    const newRatio = targetLengthSamples / baseLength;

    try {
      // Выполняем нативный WSOLA алгоритм прямо через C++ модуль NativeDAWBridge
      const stretchedBuffer = globalNativeDAWBridge.processWSOLA(baseBuffer, newRatio, isStereo);

      const updatedClip: ClipConfig = {
        ...clip,
        lengthSamples: targetLengthSamples,
        buffer: stretchedBuffer,
        originalBuffer: baseBuffer,
        originalLengthSamples: baseLength,
        timeStretchRatio: Math.round(newRatio * 100) / 100
      };

      const newClips = track.clips.map((c) => (c.id === clipId ? updatedClip : c));
      const updatedTrack = { ...track, clips: newClips };
      const newTracks = tracksRef.current.map((t) => (t.id === trackId ? updatedTrack : t));

      onUpdateTrack(updatedTrack);
      handleSyncTrackClips(trackId, newClips);
      handleSyncAllTracks(newTracks);

      showNotice(`✓ C++ WSOLA: x${(Math.round(newRatio * 100) / 100).toFixed(2)}`, 'info');
    } catch (err) {
      handleNativeError(err, 'растяжения времени WSOLA (processWSOLA)');
    }
  };

  // Подгонка длины выбранного клипа под текущую позицию плейхеда
  const handleFitSelectedToPlayhead = () => {
    if (selectedClipId === null) {
      showNotice('Сначала выберите аудиоклип на таймлайне', 'warn');
      return;
    }
    for (const track of tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip) {
        const targetEndSample = Math.round(currentTimeSec * sampleRate);
        const targetLength = targetEndSample - clip.offsetSamples;
        if (targetLength >= sampleRate * 0.1) {
          handleTimeStretch(track.id, clip.id, targetLength);
        } else {
          showNotice('Плейхед расположен слишком близко к началу клипа', 'warn');
        }
        break;
      }
    }
  };

  // Подгонка выбранного клипа точно под выбранный субтитр
  const handleFitSelectedToSelectedSubtitle = () => {
    if (!globalNativeDAWBridge.isReady) {
      handleNativeError(
        new Error('C++ WebAssembly ядро не инициализировано. Подгонка клипа под субтитр заблокирована.'),
        'подгонки клипа под субтитр (processWSOLA)'
      );
      return;
    }

    if (selectedClipId === null) {
      showNotice('Выберите аудиоклип для подгонки под субтитр', 'warn');
      return;
    }
    const targetCue =
      selectedCueIndex !== null
        ? subtitles.find((c) => c.index === selectedCueIndex)
        : subtitles.find((c) => currentTimeSec >= c.startSec && currentTimeSec <= c.endSec) ||
          subtitles[0];

    if (!targetCue) {
      showNotice('Субтитр не найден для подгонки', 'warn');
      return;
    }

    for (const track of tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip && onUpdateTrack) {
        const cueDurationSec = Math.max(0.2, targetCue.endSec - targetCue.startSec);
        const targetLengthSamples = Math.round(cueDurationSec * sampleRate);
        const targetOffsetSamples = Math.round(targetCue.startSec * sampleRate);

        const baseBuffer = clip.originalBuffer || clip.buffer;
        const baseLength = clip.originalLengthSamples || clip.lengthSamples;
        const isStereo = clip.buffer.length >= clip.lengthSamples * 2;
        const newRatio = targetLengthSamples / baseLength;

        const stretchedBuffer = globalNativeDAWBridge.processWSOLA(baseBuffer, newRatio, isStereo);

        const updatedClip: ClipConfig = {
          ...clip,
          offsetSamples: targetOffsetSamples,
          lengthSamples: targetLengthSamples,
          buffer: stretchedBuffer,
          originalBuffer: baseBuffer,
          originalLengthSamples: baseLength,
          timeStretchRatio: Math.round(newRatio * 100) / 100
        };

        const newClips = track.clips.map((c) => (c.id === clip.id ? updatedClip : c));
        const updatedTrack = { ...track, clips: newClips };
        const newTracks = tracksRef.current.map((t) => (t.id === track.id ? updatedTrack : t));

        onUpdateTrack(updatedTrack);
        handleSyncTrackClips(track.id, newClips);
        handleSyncAllTracks(newTracks);

        showNotice(
          `Фраза «${clip.name}» синхронизирована с субтитром #${targetCue.index} [${targetCue.startSec.toFixed(1)}s - ${targetCue.endSec.toFixed(1)}s]`,
          'success'
        );
        break;
      }
    }
  };

  // Применение численного коэффициента Time Stretch
  const handleApplyStretchRatio = (ratio: number) => {
    if (selectedClipId === null) return;
    for (const track of tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip) {
        const baseLength = clip.originalLengthSamples || clip.lengthSamples;
        const targetLength = Math.round(baseLength * ratio);
        handleTimeStretch(track.id, clip.id, targetLength);
        break;
      }
    }
    setStretchDialogOpen(false);
  };

  // ==========================================================================
  // СУБТИТРЫ: ДОБАВЛЕНИЕ, РЕДАКТИРОВАНИЕ, УДАЛЕНИЕ
  // ==========================================================================
  const handleAddSubtitleCueAtPlayhead = () => {
    const startSec = Math.max(0, Math.round(currentTimeSec * 10) / 10);
    const endSec = Math.round((startSec + 2.5) * 10) / 10;
    const nextIndex =
      subtitles.length > 0 ? Math.max(...subtitles.map((s) => s.index)) + 1 : 1;

    const newCue: SubtitleCue = {
      index: nextIndex,
      startSec,
      endSec,
      speaker: 'Диктор',
      text: 'Новая реплика дубляжа...'
    };

    const updated = [...subtitles, newCue].sort((a, b) => a.startSec - b.startSec);
    setSubtitles(updated);
    setSelectedCueIndex(nextIndex);
    setEditingCue(newCue);
    setCueEditorOpen(true);
    showNotice(`Добавлен субтитр #${nextIndex} на ${formatCompactTime(startSec)}`, 'success');
  };

  const handleSaveEditedCue = (cue: SubtitleCue) => {
    const updated = subtitles
      .map((c) => (c.index === cue.index ? cue : c))
      .sort((a, b) => a.startSec - b.startSec);
    setSubtitles(updated);
    setCueEditorOpen(false);
    setEditingCue(null);
    showNotice(`Субтитр #${cue.index} обновлен`, 'success');
  };

  const handleDeleteSelectedCue = () => {
    if (selectedCueIndex === null) return;
    const updated = subtitles.filter((c) => c.index !== selectedCueIndex);
    setSubtitles(updated);
    setSelectedCueIndex(null);
    showNotice('Субтитр удален', 'info');
  };

  // Удаление выбранного клипа
  const handleDeleteSelectedClip = () => {
    if (selectedClipId === null || !onUpdateTrack) return;
    for (const track of tracks) {
      if (track.clips.some((c) => c.id === selectedClipId)) {
        const remainingClips = track.clips.filter((c) => c.id !== selectedClipId);
        const updatedTrack = {
          ...track,
          clips: remainingClips
        };
        const newTracks = tracksRef.current.map((t) => (t.id === track.id ? updatedTrack : t));

        onUpdateTrack(updatedTrack);
        handleSyncTrackClips(track.id, remainingClips);
        handleSyncAllTracks(newTracks);

        setSelectedClipId(null);
        showNotice('Клип удален с таймлайна', 'info');
        break;
      }
    }
  };

  // Горячие клавиши ('S' - Split, 'Delete' - Удалить, 'Space' - Play/Pause)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Игнорируем если фокус в инпуте
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;

      if (e.key === 's' || e.key === 'S' || e.key === 'ы' || e.key === 'Ы') {
        e.preventDefault();
        handleSplitAtPlayhead();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClipId !== null) {
          e.preventDefault();
          handleDeleteSelectedClip();
        } else if (selectedCueIndex !== null) {
          e.preventDefault();
          handleDeleteSelectedCue();
        }
      } else if (e.code === 'Space') {
        e.preventDefault();
        onTogglePlay?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedClipId, selectedCueIndex, currentTimeSec, tracks, subtitles, onTogglePlay]);

  // ==========================================================================
  // ОБРАБОТКА МЫШИ ДЛЯ КЛИПОВ И СУБТИТРОВ
  // ==========================================================================
  const handleClipMouseDown = (
    e: React.MouseEvent,
    trackId: number,
    clip: ClipConfig,
    mode: DragMode
  ) => {
    e.stopPropagation();
    setSelectedClipId(clip.id);
    setSelectedCueIndex(null);

    // Если активен инструмент Razor (ножницы) - выполняем мгновенный сплит по клику
    if (activeTool === 'razor') {
      const container = timelineScrollRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const clickX = e.clientX - rect.left + container.scrollLeft;
        const splitTime = clickX / pxPerSec;
        handleSplitClip(trackId, clip.id, splitTime);
      }
      return;
    }

    // Если активен режим Time Stretch Tool, привязываем правый край к stretch
    const effectiveMode =
      activeTool === 'stretch' && (mode === 'move' || mode === 'trim-end') ? 'time-stretch' : mode;

    setActiveDrag({
      trackId,
      clipId: clip.id,
      mode: effectiveMode,
      startX: e.clientX,
      initialOffsetSamples: clip.offsetSamples,
      initialLengthSamples: clip.lengthSamples,
      initialFadeInSamples: clip.fadeInSamples,
      initialFadeOutSamples: clip.fadeOutSamples,
      currentLengthSamples: clip.lengthSamples
    });
  };

  const handleCueMouseDown = (e: React.MouseEvent, cue: SubtitleCue, mode: DragMode) => {
    e.stopPropagation();
    setSelectedCueIndex(cue.index);
    setSelectedClipId(null);
    if (onSelectCue) onSelectCue(cue);

    setActiveDrag({
      cueIndex: cue.index,
      mode,
      startX: e.clientX,
      initialCueStartSec: cue.startSec,
      initialCueEndSec: cue.endSec,
      currentCueStartSec: cue.startSec,
      currentCueEndSec: cue.endSec
    });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!activeDrag) return;

      const deltaPx = e.clientX - activeDrag.startX;
      const deltaSec = deltaPx / pxPerSec;

      // 1. Перемещение и тримминг субтитров
      if (activeDrag.cueIndex !== undefined) {
        const cueIndex = activeDrag.cueIndex;
        const initStart = activeDrag.initialCueStartSec || 0;
        const initEnd = activeDrag.initialCueEndSec || 1;
        const cueDuration = initEnd - initStart;

        if (activeDrag.mode === 'cue-move') {
          let newStart = Math.max(0, initStart + deltaSec);
          if (snapToGrid) {
            const { minorStepSec } = getAdaptiveTimeStep(pxPerSec);
            newStart = Math.round(newStart / minorStepSec) * minorStepSec;
          }
          const newEnd = newStart + cueDuration;

          setSubtitles((prev) =>
            prev.map((c) => (c.index === cueIndex ? { ...c, startSec: newStart, endSec: newEnd } : c))
          );
        } else if (activeDrag.mode === 'cue-start') {
          let newStart = Math.max(0, Math.min(initEnd - 0.2, initStart + deltaSec));
          if (snapToGrid) {
            const { minorStepSec } = getAdaptiveTimeStep(pxPerSec);
            newStart = Math.round(newStart / minorStepSec) * minorStepSec;
          }
          setSubtitles((prev) =>
            prev.map((c) => (c.index === cueIndex ? { ...c, startSec: newStart } : c))
          );
        } else if (activeDrag.mode === 'cue-end') {
          let newEnd = Math.max(initStart + 0.2, initEnd + deltaSec);
          if (snapToGrid) {
            const { minorStepSec } = getAdaptiveTimeStep(pxPerSec);
            newEnd = Math.round(newEnd / minorStepSec) * minorStepSec;
          }
          setSubtitles((prev) =>
            prev.map((c) => (c.index === cueIndex ? { ...c, endSec: newEnd } : c))
          );
        }
        return;
      }

      // 2. Аудиоклипы (Move, Trim, Fade, Time-Stretch)
      if (!onUpdateTrack || activeDrag.trackId === undefined) return;

      const deltaSamples = Math.round(deltaSec * sampleRate);
      const targetTrack = tracks.find((t) => t.id === activeDrag.trackId);
      if (!targetTrack) return;

      if (activeDrag.mode === 'time-stretch') {
        const newLength = Math.max(
          sampleRate * 0.1,
          (activeDrag.initialLengthSamples || 0) + deltaSamples
        );
        setActiveDrag((prev) => (prev ? { ...prev, currentLengthSamples: newLength } : null));

        const updatedClips = targetTrack.clips.map((clip) => {
          if (clip.id !== activeDrag.clipId) return clip;
          return { ...clip, lengthSamples: newLength };
        });
        onUpdateTrack({ ...targetTrack, clips: updatedClips });
        return;
      }

      const updatedClips = targetTrack.clips.map((clip) => {
        if (clip.id !== activeDrag.clipId) return clip;

        if (activeDrag.mode === 'move') {
          let newOffset = Math.max(0, (activeDrag.initialOffsetSamples || 0) + deltaSamples);
          if (snapToGrid) {
            const { minorStepSec } = getAdaptiveTimeStep(pxPerSec);
            const minorStepSamples = Math.round(minorStepSec * sampleRate);
            newOffset = Math.round(newOffset / minorStepSamples) * minorStepSamples;
          }
          return { ...clip, offsetSamples: newOffset };
        }

        if (activeDrag.mode === 'trim-start') {
          const newOffset = Math.max(0, (activeDrag.initialOffsetSamples || 0) + deltaSamples);
          const newLength = Math.max(
            sampleRate * 0.1,
            (activeDrag.initialLengthSamples || 0) - deltaSamples
          );
          return { ...clip, offsetSamples: newOffset, lengthSamples: newLength };
        }

        if (activeDrag.mode === 'trim-end') {
          const newLength = Math.max(
            sampleRate * 0.1,
            (activeDrag.initialLengthSamples || 0) + deltaSamples
          );
          return { ...clip, lengthSamples: newLength };
        }

        if (activeDrag.mode === 'fade-in') {
          const newFadeIn = Math.max(
            0,
            Math.min(clip.lengthSamples, (activeDrag.initialFadeInSamples || 0) + deltaSamples)
          );
          return { ...clip, fadeInSamples: newFadeIn };
        }

        if (activeDrag.mode === 'fade-out') {
          const newFadeOut = Math.max(
            0,
            Math.min(clip.lengthSamples, (activeDrag.initialFadeOutSamples || 0) - deltaSamples)
          );
          return { ...clip, fadeOutSamples: newFadeOut };
        }

        return clip;
      });

      onUpdateTrack({ ...targetTrack, clips: updatedClips });
    };

    const handleMouseUp = () => {
      if (activeDrag) {
        if (
          activeDrag.mode === 'time-stretch' &&
          activeDrag.currentLengthSamples &&
          activeDrag.trackId !== undefined &&
          activeDrag.clipId !== undefined
        ) {
          handleTimeStretch(
            activeDrag.trackId,
            activeDrag.clipId,
            activeDrag.currentLengthSamples
          );
        } else if (activeDrag.trackId !== undefined) {
          // После перемещения, обрезки (Trim) или фейдинга мгновенно синхронизируем данные с AudioWorklet
          const currentTracks = tracksRef.current;
          handleSyncAllTracks(currentTracks);
          const targetTrack = currentTracks.find((t) => t.id === activeDrag.trackId);
          if (targetTrack) {
            handleSyncTrackClips(targetTrack.id, targetTrack.clips);
          }
        }
        setActiveDrag(null);
      }
    };

    if (activeDrag) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [activeDrag, pxPerSec, sampleRate, snapToGrid, tracks, onUpdateTrack, setSubtitles]);

  const getTrackIcon = (id: number) => {
    if (id === 1) return <Disc size={13} className="text-cyan-400" />;
    if (id === 2) return <Music size={13} className="text-blue-400" />;
    if (id === 3) return <Mic size={13} className="text-emerald-400" />;
    return <Volume2 size={13} className="text-purple-400" />;
  };

  const selectedClip = useMemo(() => {
    if (selectedClipId === null) return null;
    for (const t of tracks) {
      const c = t.clips.find((item) => item.id === selectedClipId);
      if (c) return { clip: c, track: t };
    }
    return null;
  }, [selectedClipId, tracks]);

  const selectedCue = useMemo(() => {
    if (selectedCueIndex === null) return null;
    return subtitles.find((c) => c.index === selectedCueIndex) || null;
  }, [selectedCueIndex, subtitles]);

  return (
    <div className="bg-[#0b0f19] border border-[#1e293b] rounded-2xl overflow-hidden shadow-2xl flex flex-col select-none">
      {/* =====================================================================
          TIMELINE CONTROL TOOLBAR
          ===================================================================== */}
      <div className="bg-[#0f1422] px-4 py-3 border-b border-[#1e293b] flex flex-wrap items-center justify-between gap-3 text-xs">
        {/* Left: Title, Timecode Counter & Transport */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 font-bold text-slate-200">
            <Sliders size={16} className="text-cyan-400" />
            <span className="tracking-wide">Мультитрек монтаж & Субтитры</span>
          </div>

          {/* SMPTE Time Display */}
          <div
            onClick={() => setUseSMPTE(!useSMPTE)}
            title="Кликните для переключения формата времени (SMPTE / Секунды)"
            className="flex items-center gap-2 bg-slate-950 border border-slate-800 px-3 py-1 rounded-xl font-mono text-cyan-400 shadow-inner cursor-pointer hover:border-cyan-500/50 transition-colors"
          >
            <Clock size={13} />
            <span className="font-bold tracking-wider">
              {useSMPTE ? formatSMPTE(currentTimeSec, fps) : formatCompactTime(currentTimeSec)}
            </span>
          </div>

          {/* Play/Pause Button */}
          {onTogglePlay && (
            <button
              onClick={onTogglePlay}
              className={`p-1.5 rounded-xl border transition-all cursor-pointer ${
                isPlaying
                  ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-md shadow-amber-950/40'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500 shadow-md shadow-emerald-950/40'
              }`}
              title={isPlaying ? 'Пауза (Space)' : 'Воспроизведение (Space)'}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
            </button>
          )}
        </div>

        {/* Center: Tools (Pointer / Razor Split / Time Stretch) */}
        <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => setActiveTool('pointer')}
            title="Инструмент выделения и перемещения (V)"
            className={`px-2.5 py-1 rounded-lg flex items-center gap-1.5 transition-all text-xs font-semibold cursor-pointer ${
              activeTool === 'pointer'
                ? 'bg-slate-800 text-cyan-400 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Move size={13} />
            <span>Перемещение</span>
          </button>

          <button
            onClick={() => setActiveTool('razor')}
            title="Инструмент нарезки клипов (Ножницы / Split) — кликните по клипу"
            className={`px-2.5 py-1 rounded-lg flex items-center gap-1.5 transition-all text-xs font-semibold cursor-pointer ${
              activeTool === 'razor'
                ? 'bg-rose-950 text-rose-400 border border-rose-800/80 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Scissors size={13} />
            <span>Ножницы [S]</span>
          </button>

          <button
            onClick={() => setActiveTool('stretch')}
            title="Подгонка по времени без изменения высоты тона (WSOLA Time Stretch)"
            className={`px-2.5 py-1 rounded-lg flex items-center gap-1.5 transition-all text-xs font-semibold cursor-pointer ${
              activeTool === 'stretch'
                ? 'bg-amber-950 text-amber-400 border border-amber-800/80 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Gauge size={13} />
            <span>Time Stretch</span>
          </button>
        </div>

        {/* Right: Key Pro Dubbing Actions (Strip Silence, Split, Subtitle Sync) */}
        <div className="flex flex-wrap items-center gap-2">
          {/* C++ STRIP SILENCE КНОПКА */}
          <button
            id="btn-strip-silence"
            onClick={() => {
              if (selectedClip) {
                setStripTargetTrackId(selectedClip.track.id);
              }
              setStripSilenceModalOpen(true);
            }}
            title="Нативное удаление тишины и авто-нарезка дорожки на фразы через C++ SilenceStripper"
            className="px-3 py-1 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white font-bold rounded-xl text-xs transition-all flex items-center gap-1.5 cursor-pointer shadow-md shadow-emerald-950/40"
          >
            <Zap size={13} className="text-amber-300" />
            <span>Удалить тишину (C++)</span>
          </button>

          {/* Кнопка добавления субтитра на плейхед */}
          <button
            onClick={handleAddSubtitleCueAtPlayhead}
            title="Добавить блок субтитра в текущую позицию плейхеда"
            className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-purple-300 border border-purple-800/60 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
          >
            <FileText size={13} className="text-purple-400" />
            <span>+ Субтитр</span>
          </button>

          {/* Сплит по курсору */}
          <button
            onClick={handleSplitAtPlayhead}
            title="Разрезать аудиоклип точно по плейхеду (Клавиша S)"
            className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-rose-300 border border-rose-900/60 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
          >
            <Scissors size={13} className="text-rose-400" />
            <span>Сплит [S]</span>
          </button>

          {/* Подгонка фразы под субтитр */}
          {selectedClip && (
            <button
              onClick={handleFitSelectedToSelectedSubtitle}
              title="Растянуть/сжать аудиоклип (WSOLA) точно под выделенный субтитр"
              className="px-2.5 py-1 bg-gradient-to-r from-amber-950 to-purple-950 hover:from-amber-900 hover:to-purple-900 text-amber-200 border border-amber-700/60 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
            >
              <ChevronsLeftRight size={13} className="text-amber-400" />
              <span>Фразу под субтитр</span>
            </button>
          )}

          {/* Подгонка под плейхед */}
          {selectedClip && (
            <button
              onClick={handleFitSelectedToPlayhead}
              title="Растянуть или сжать клип (WSOLA) до текущей позиции плейхеда"
              className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-amber-300 border border-amber-900/60 rounded-xl text-xs font-medium transition-all flex items-center gap-1 cursor-pointer"
            >
              <span>К плейхеду</span>
            </button>
          )}

          {/* Time Stretch Коэффициент */}
          {selectedClip && (
            <button
              onClick={() => setStretchDialogOpen(true)}
              className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded-xl text-xs font-mono cursor-pointer"
              title="Настроить коэффициент Time Stretch вручную"
            >
              x{selectedClip.clip.timeStretchRatio || 1.0}
            </button>
          )}

          {/* Удаление клипа или субтитра */}
          {(selectedClip || selectedCue) && (
            <button
              onClick={() => {
                if (selectedClip) handleDeleteSelectedClip();
                else if (selectedCue) handleDeleteSelectedCue();
              }}
              title="Удалить выбранный элемент (Delete / Backspace)"
              className="p-1 bg-slate-900 hover:bg-rose-950 text-slate-400 hover:text-rose-400 border border-slate-800 hover:border-rose-900 rounded-xl transition-all cursor-pointer"
            >
              <Trash2 size={13} />
            </button>
          )}

          {/* Snap to Grid Toggle */}
          <button
            onClick={() => setSnapToGrid(!snapToGrid)}
            title="Привязка к сетке (Snap to Grid)"
            className={`px-2 py-1 rounded-xl flex items-center gap-1 transition-all font-mono text-[11px] cursor-pointer ${
              snapToGrid
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                : 'bg-slate-900 text-slate-400 border border-slate-800'
            }`}
          >
            <Magnet size={12} />
            Snap
          </button>

          {/* Zoom Buttons */}
          <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-xl p-0.5">
            <button
              onClick={() => setPxPerSec((prev) => Math.max(12, prev * 0.75))}
              title="Отдалить (Ctrl + Колесо)"
              className="p-1 text-slate-400 hover:text-slate-100 rounded transition-colors cursor-pointer"
            >
              <ZoomOut size={13} />
            </button>
            <span className="text-[10px] font-mono text-slate-400 px-1 min-w-[36px] text-center">
              {Math.round(pxPerSec)}px/s
            </span>
            <button
              onClick={() => setPxPerSec((prev) => Math.min(500, prev * 1.25))}
              title="Приблизить (Ctrl + Колесо)"
              className="p-1 text-slate-400 hover:text-slate-100 rounded transition-colors cursor-pointer"
            >
              <ZoomIn size={13} />
            </button>
            <button
              onClick={() => setPxPerSec(60)}
              title="Сброс масштаба"
              className="p-1 text-slate-400 hover:text-slate-100 rounded transition-colors cursor-pointer"
            >
              <Maximize2 size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Floating Notice Toast */}
      {timelineNotice && (
        <div className="bg-gradient-to-r from-slate-900 to-slate-950 border-b border-cyan-500/40 px-4 py-1.5 flex items-center justify-between text-xs text-cyan-300 animate-fadeIn">
          <div className="flex items-center gap-2">
            {timelineNotice.type === 'success' && <CheckCircle2 size={14} className="text-emerald-400" />}
            {timelineNotice.type === 'warn' && <AlertCircle size={14} className="text-amber-400" />}
            {timelineNotice.type === 'info' && <Sparkles size={14} className="text-cyan-400" />}
            <span>{timelineNotice.text}</span>
          </div>
          <button
            onClick={() => setTimelineNotice(null)}
            className="text-slate-500 hover:text-slate-300 cursor-pointer"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* =====================================================================
          MAIN TIMELINE SCROLLABLE CONTAINER
          ===================================================================== */}
      <div className="flex bg-[#070a12] relative overflow-hidden" onWheel={handleWheel}>
        {/* LEFT COLUMN: Fixed Track Headers Panel */}
        <div className="w-56 shrink-0 bg-[#0f1422] border-r border-[#1e293b] flex flex-col z-20 shadow-xl">
          {/* Header Spacer (соответствует высоте линейки 28px) */}
          <div className="h-7 bg-[#090d16] border-b border-[#1e293b] px-3 flex items-center justify-between text-[10px] font-mono text-slate-400 uppercase tracking-wider">
            <span>Дорожки проекта</span>
            <span>Параметры</span>
          </div>

          {/* 1. Дорожка ВИДЕО (Фиксированная верхняя дорожка) */}
          <div className="h-14 px-3 py-1.5 flex flex-col justify-between bg-purple-950/20 border-b border-purple-900/40 border-l-2 border-l-purple-500">
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <Film size={14} className="text-purple-400 shrink-0" />
                <div className="min-w-0">
                  <span
                    className="text-xs font-bold text-purple-200 truncate block"
                    title={videoFile?.name || 'Видеоряд'}
                  >
                    {videoFile ? videoFile.name : 'Видеоряд'}
                  </span>
                  <span className="text-[10px] text-purple-400 font-mono">
                    {videoDuration > 0 ? `${videoDuration.toFixed(1)}с • ${fps} FPS` : 'Нет видео'}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
              <span className="px-1.5 py-0.2 rounded bg-purple-950 border border-purple-800/80 text-purple-300">
                VIDEO 0
              </span>
              <span className="text-slate-500">Синхрон</span>
            </div>
          </div>

          {/* 2. Дорожка СУБТИТРОВ (Subtitle Track Header) */}
          <div className="h-12 px-3 py-1.5 flex items-center justify-between bg-cyan-950/20 border-b border-cyan-900/40 border-l-2 border-l-cyan-400">
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={14} className="text-cyan-400 shrink-0" />
              <div className="min-w-0">
                <span className="text-xs font-bold text-cyan-200 truncate block">Субтитры / Текст</span>
                <span className="text-[10px] text-cyan-400 font-mono">
                  {subtitles.length} реплик
                </span>
              </div>
            </div>

            <button
              onClick={handleAddSubtitleCueAtPlayhead}
              title="Добавить новую реплику на плейхед"
              className="p-1 bg-cyan-950 hover:bg-cyan-900 text-cyan-300 border border-cyan-700/60 rounded-md transition-colors cursor-pointer"
            >
              <Plus size={12} />
            </button>
          </div>

          {/* 3. Аудиодорожки проекта */}
          <div className="flex flex-col divide-y divide-slate-800/60 overflow-y-auto max-h-[500px]">
            {tracks.map((track) => (
              <div
                key={track.id}
                className="h-20 px-3 py-2 flex flex-col justify-between bg-slate-900/60 hover:bg-slate-800/40 transition-colors"
                style={{ borderLeft: `2px solid ${track.color || '#10b981'}` }}
              >
                {/* Top Row: Icon, Track Name, CH Badge */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    {getTrackIcon(track.id)}
                    <span className="text-xs font-semibold text-slate-200 truncate" title={track.name}>
                      {track.name}
                    </span>
                  </div>
                  <span className="text-[9px] font-mono text-slate-400 bg-slate-950 px-1 py-0.2 rounded border border-slate-800">
                    CH {track.id}
                  </span>
                </div>

                {/* Bottom Row: Mute, Solo Buttons & Volume */}
                <div className="flex items-center justify-between gap-1 text-[10px] font-mono">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onUpdateTrack?.({ ...track, mute: !track.mute })}
                      className={`w-5 h-5 rounded font-bold transition-all flex items-center justify-center cursor-pointer ${
                        track.mute
                          ? 'bg-rose-600 text-white shadow-md'
                          : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      M
                    </button>

                    <button
                      onClick={() => onUpdateTrack?.({ ...track, solo: !track.solo })}
                      className={`w-5 h-5 rounded font-bold transition-all flex items-center justify-center cursor-pointer ${
                        track.solo
                          ? 'bg-amber-500 text-slate-950 shadow-md'
                          : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      S
                    </button>
                  </div>

                  <span className="text-slate-400 font-bold">
                    {track.volumeDb >= 0 ? `+${track.volumeDb.toFixed(1)}` : track.volumeDb.toFixed(1)} dB
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN: Horizontal Scrollable Timeline Area (Ruler + Video + Subtitles + Audio Lanes) */}
        <div
          ref={timelineScrollRef}
          className="flex-1 overflow-x-auto overflow-y-hidden relative bg-[#070a12] select-none scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-slate-950"
        >
          <div style={{ width: `${totalWidthPx}px` }} className="relative flex flex-col">
            {/* 1. Линейка времени (Time Ruler) */}
            <div
              className="h-7 sticky top-0 z-10 cursor-pointer"
              onClick={(e) => handleSeekByCoord(e.clientX)}
            >
              <canvas ref={rulerCanvasRef} className="block w-full h-full" />
            </div>

            {/* 2. Дорожка ВИДЕОПОТОКА (Filmstrip Lane) */}
            <div
              className="h-14 relative bg-purple-950/10 border-b border-purple-900/30 cursor-pointer overflow-hidden group"
              onClick={(e) => handleSeekByCoord(e.clientX)}
            >
              {videoDuration > 0 ? (
                <div
                  style={{ width: `${Math.max(20, videoDuration * pxPerSec)}px` }}
                  className="h-full bg-gradient-to-r from-purple-900/40 via-purple-950/60 to-purple-900/40 border border-purple-500/30 rounded-md relative flex items-center px-3 overflow-hidden shadow-inner"
                >
                  {/* Перфорация кинопленки (Filmstrip sprocket holes) */}
                  <div
                    className="absolute top-0 left-0 right-0 h-1.5 opacity-30 pointer-events-none"
                    style={{
                      backgroundImage: `radial-gradient(circle, #c084fc 1px, transparent 1.5px)`,
                      backgroundSize: `16px 6px`
                    }}
                  />
                  <div
                    className="absolute bottom-0 left-0 right-0 h-1.5 opacity-30 pointer-events-none"
                    style={{
                      backgroundImage: `radial-gradient(circle, #c084fc 1px, transparent 1.5px)`,
                      backgroundSize: `16px 6px`
                    }}
                  />

                  {/* Название видеофайла и кадры */}
                  <div className="flex items-center gap-2 z-10 text-xs font-mono text-purple-200 pointer-events-none">
                    <Film size={13} className="text-purple-400" />
                    <span className="font-bold">{videoFile?.name || 'Видеоряд'}</span>
                    <span className="text-[10px] text-purple-300 opacity-70">
                      [0.00с — {videoDuration.toFixed(2)}с]
                    </span>
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center px-4 text-xs font-mono text-purple-400/50">
                  <Film size={13} className="mr-2" />
                  Видео не загружено. Откройте «Импорт медиа (Hub)» для загрузки видео.
                </div>
              )}
            </div>

            {/* 3. ДОРОЖКА СУБТИТРОВ (SUBTITLE LANE) */}
            <div
              className="h-12 relative bg-cyan-950/10 border-b border-cyan-900/30 overflow-hidden"
              onClick={(e) => handleSeekByCoord(e.clientX)}
            >
              {/* Фоновая сетка делений */}
              <div
                className="absolute inset-0 pointer-events-none opacity-5"
                style={{
                  backgroundImage: `linear-gradient(to right, #06b6d4 1px, transparent 1px)`,
                  backgroundSize: `${pxPerSec}px 100%`
                }}
              />

              {/* Блоки субтитров */}
              {subtitles.map((cue) => {
                const cueLeftPx = cue.startSec * pxPerSec;
                const cueWidthPx = Math.max(28, (cue.endSec - cue.startSec) * pxPerSec);
                const isSelected = selectedCueIndex === cue.index;

                return (
                  <div
                    key={cue.index}
                    onMouseDown={(e) => handleCueMouseDown(e, cue, 'cue-move')}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingCue(cue);
                      setCueEditorOpen(true);
                    }}
                    style={{
                      left: `${cueLeftPx}px`,
                      width: `${cueWidthPx}px`
                    }}
                    className={`absolute top-1 bottom-1 rounded-lg border text-xs overflow-hidden group shadow-md cursor-grab active:cursor-grabbing transition-all flex flex-col justify-between p-1.5 ${
                      isSelected
                        ? 'bg-gradient-to-r from-cyan-900/80 to-blue-900/80 border-cyan-400 ring-2 ring-cyan-400 shadow-cyan-950/80 z-20'
                        : 'bg-gradient-to-r from-cyan-950/60 to-slate-900/80 border-cyan-700/60 hover:border-cyan-500 hover:bg-cyan-900/40 z-10'
                    }`}
                  >
                    {/* Cue Header (Speaker badge & timing) */}
                    <div className="flex items-center justify-between text-[9px] font-mono text-cyan-200 pointer-events-none truncate">
                      <span className="font-bold px-1 py-0.2 rounded bg-cyan-950/80 border border-cyan-700/60 text-cyan-300 truncate max-w-[90px]">
                        {cue.speaker || `Реплика #${cue.index}`}
                      </span>
                      <span className="opacity-80 text-[8px] text-cyan-400 shrink-0 ml-1">
                        {(cue.endSec - cue.startSec).toFixed(1)}с
                      </span>
                    </div>

                    {/* Cue Text */}
                    <div
                      className="text-[10px] text-slate-100 font-medium truncate pointer-events-none drop-shadow-sm"
                      title={cue.text}
                    >
                      {cue.text}
                    </div>

                    {/* Левый Trim Handle для оттаймовки начала реплики */}
                    <div
                      onMouseDown={(e) => handleCueMouseDown(e, cue, 'cue-start')}
                      title="Подтянуть начало реплики (Trim Start)"
                      className="absolute top-0 bottom-0 left-0 w-2.5 hover:w-3.5 bg-cyan-400/60 hover:bg-cyan-300 cursor-w-resize transition-all opacity-0 group-hover:opacity-100 z-30 flex items-center justify-center"
                    >
                      <div className="w-0.5 h-3 bg-slate-950 rounded-full" />
                    </div>

                    {/* Правый Trim Handle для оттаймовки конца реплики */}
                    <div
                      onMouseDown={(e) => handleCueMouseDown(e, cue, 'cue-end')}
                      title="Подтянуть конец реплики (Trim End)"
                      className="absolute top-0 bottom-0 right-0 w-2.5 hover:w-3.5 bg-cyan-400/60 hover:bg-cyan-300 cursor-e-resize transition-all opacity-0 group-hover:opacity-100 z-30 flex items-center justify-center"
                    >
                      <div className="w-0.5 h-3 bg-slate-950 rounded-full" />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 4. ДОРОЖКИ АУДИОСИГНАЛОВ с волновыми формами (Waveforms) */}
            <div className="flex flex-col divide-y divide-slate-800/60 relative">
              {tracks.map((track) => (
                <div
                  key={track.id}
                  className="h-20 relative bg-[#070a12] hover:bg-slate-900/20 transition-colors"
                  onClick={(e) => {
                    if (activeTool === 'razor') {
                      handleSeekByCoord(e.clientX);
                    }
                  }}
                >
                  {/* Фоновая сетка делений */}
                  <div
                    className="absolute inset-0 pointer-events-none opacity-10"
                    style={{
                      backgroundImage: `linear-gradient(to right, #64748b 1px, transparent 1px)`,
                      backgroundSize: `${pxPerSec}px 100%`
                    }}
                  />

                  {/* Клипы дорожки */}
                  {track.clips.map((clip) => {
                    const clipStartSec = clip.offsetSamples / sampleRate;
                    const clipLenSec = clip.lengthSamples / sampleRate;
                    const clipLeftPx = clipStartSec * pxPerSec;
                    const clipWidthPx = Math.max(20, clipLenSec * pxPerSec);
                    const isSelected = selectedClipId === clip.id;

                    const fadeInPx = (clip.fadeInSamples / clip.lengthSamples) * clipWidthPx;
                    const fadeOutPx = (clip.fadeOutSamples / clip.lengthSamples) * clipWidthPx;

                    return (
                      <div
                        key={clip.id}
                        onMouseDown={(e) => handleClipMouseDown(e, track.id, clip, 'move')}
                        style={{
                          left: `${clipLeftPx}px`,
                          width: `${clipWidthPx}px`,
                          backgroundColor: `${clip.color}18`,
                          borderColor: isSelected ? '#38bdf8' : `${clip.color}80`
                        }}
                        className={`absolute top-1 bottom-1 rounded-lg border text-xs overflow-hidden group shadow-lg cursor-grab active:cursor-grabbing transition-all ${
                          isSelected ? 'ring-2 ring-cyan-400 shadow-cyan-950/60 z-20' : 'z-10'
                        } ${activeTool === 'razor' ? 'cursor-crosshair' : ''}`}
                      >
                        {/* Волновой спектр клипа */}
                        <div className="absolute inset-0 pointer-events-none">
                          <WaveformCanvas
                            buffer={clip.buffer}
                            width={clipWidthPx}
                            height={70}
                            color={clip.color}
                            gain={clip.gain}
                            fadeInSamples={clip.fadeInSamples}
                            fadeOutSamples={clip.fadeOutSamples}
                            lengthSamples={clip.lengthSamples}
                          />
                        </div>

                        {/* Информационный бейдж клипа */}
                        <div className="absolute top-1 left-2 right-2 flex items-center justify-between text-[10px] font-mono text-slate-200 pointer-events-none drop-shadow z-10">
                          <span className="font-bold truncate bg-slate-950/70 px-1.5 py-0.5 rounded border border-slate-800/80">
                            {clip.name}
                          </span>

                          <div className="flex items-center gap-1">
                            {/* Индикатор Time Stretch (если дорожка подогнана по времени) */}
                            {clip.timeStretchRatio && Math.abs(clip.timeStretchRatio - 1.0) > 0.01 && (
                              <span className="bg-amber-950/80 border border-amber-600/60 text-amber-300 px-1 py-0.2 rounded text-[9px] font-bold">
                                ↔ x{clip.timeStretchRatio}
                              </span>
                            )}
                            <span className="bg-slate-950/70 px-1.5 py-0.5 rounded text-[9px] text-slate-300">
                              {clipLenSec.toFixed(2)}с
                            </span>
                          </div>
                        </div>

                        {/* Ручка Fade In (Левый верхний угол) */}
                        <div
                          onMouseDown={(e) => handleClipMouseDown(e, track.id, clip, 'fade-in')}
                          title="Fade In Handle"
                          style={{ left: `${fadeInPx}px` }}
                          className="absolute top-0 w-3 h-3 -translate-x-1.5 bg-white border border-slate-900 rounded-full cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity z-30 shadow"
                        />

                        {/* Ручка Fade Out (Правый верхний угол) */}
                        <div
                          onMouseDown={(e) => handleClipMouseDown(e, track.id, clip, 'fade-out')}
                          title="Fade Out Handle"
                          style={{ right: `${fadeOutPx}px` }}
                          className="absolute top-0 w-3 h-3 translate-x-1.5 bg-white border border-slate-900 rounded-full cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity z-30 shadow"
                        />

                        {/* Левый Trim Handle */}
                        <div
                          onMouseDown={(e) => handleClipMouseDown(e, track.id, clip, 'trim-start')}
                          title="Обрезать слева (Trim Left)"
                          className="absolute top-0 bottom-0 left-0 w-2.5 hover:w-3.5 bg-emerald-500/60 hover:bg-emerald-400 cursor-w-resize transition-all opacity-0 group-hover:opacity-100 z-20 flex items-center justify-center"
                        >
                          <div className="w-0.5 h-4 bg-slate-950 rounded-full" />
                        </div>

                        {/* Правый Trim Handle ИЛИ Time-Stretch Handle */}
                        <div
                          onMouseDown={(e) =>
                            handleClipMouseDown(
                              e,
                              track.id,
                              clip,
                              activeTool === 'stretch' || e.altKey ? 'time-stretch' : 'trim-end'
                            )
                          }
                          title={
                            activeTool === 'stretch'
                              ? 'Сжать / растянуть по времени (WSOLA)'
                              : 'Обрезать справа (Trim Right) или тяните с Alt для Time Stretch'
                          }
                          className={`absolute top-0 bottom-0 right-0 w-2.5 hover:w-3.5 cursor-e-resize transition-all opacity-0 group-hover:opacity-100 z-20 flex items-center justify-center ${
                            activeTool === 'stretch'
                              ? 'bg-amber-500/80 hover:bg-amber-400'
                              : 'bg-emerald-500/60 hover:bg-emerald-400'
                          }`}
                        >
                          <div className="w-0.5 h-4 bg-slate-950 rounded-full" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* 5. 60 FPS RequestAnimationFrame Плейхед (Playhead Cursor) */}
            <div
              ref={playheadRef}
              className="absolute top-0 bottom-0 w-px bg-rose-500 z-30 pointer-events-none shadow-[0_0_10px_rgba(244,63,94,1)] will-change-transform"
            >
              <div className="w-3.5 h-3.5 bg-rose-500 rotate-45 -translate-x-[6px] -translate-y-1 rounded-xs shadow-md border border-rose-300 pointer-events-none" />
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          MODAL: C++ STRIP SILENCE (УДАЛЕНИЕ ТИШИНЫ)
          ===================================================================== */}
      {stripSilenceModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-[#0f1422] border border-slate-800 p-6 rounded-2xl max-w-lg w-full shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                <Zap size={18} className="text-amber-300" />
                <span>C++ Нативное удаление тишины (Silence Stripper)</span>
              </div>
              <button
                onClick={() => setStripSilenceModalOpen(false)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Автоматически находит звуковые фразы диктора через VAD-алгоритм в C++ WebAssembly ядре.
              Длинная запись будет мгновенно нарезана на отдельные клипы без пауз тишины с сохранением
              точных таймкодов!
            </p>

            <div className="space-y-4 bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
              {/* Выбор целевой дорожки */}
              <div>
                <label className="text-xs text-slate-300 block font-semibold mb-1.5">
                  Целевая дорожка:
                </label>
                <select
                  value={stripTargetTrackId}
                  onChange={(e) => setStripTargetTrackId(Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-xl p-2.5 focus:border-cyan-500 outline-none"
                >
                  {tracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      CH {t.id} — {t.name} ({t.clips.length} клипов)
                    </option>
                  ))}
                </select>
              </div>

              {/* Порог чувствительности (dB) */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-slate-300">Порог тишины (Threshold):</span>
                  <span className="font-mono text-cyan-400">{stripThresholdDb} dB</span>
                </div>
                <input
                  type="range"
                  min="-60"
                  max="-20"
                  step="1"
                  value={stripThresholdDb}
                  onChange={(e) => setStripThresholdDb(Number(e.target.value))}
                  className="w-full accent-cyan-500 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                  <span>-60 dB (Высокая чувствительность)</span>
                  <span>-20 dB (Только громкий голос)</span>
                </div>
              </div>

              {/* Мин. длительность паузы (мс) */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-slate-300">Минимальная пауза (Min Silence):</span>
                  <span className="font-mono text-emerald-400">{stripMinSilenceMs} мс</span>
                </div>
                <input
                  type="range"
                  min="100"
                  max="1000"
                  step="50"
                  value={stripMinSilenceMs}
                  onChange={(e) => setStripMinSilenceMs(Number(e.target.value))}
                  className="w-full accent-emerald-500 cursor-pointer"
                />
              </div>

              {/* Удержание краев речи (Padding) */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-slate-300">Запас краев фразы (Padding):</span>
                  <span className="font-mono text-amber-400">{stripPaddingMs} мс</span>
                </div>
                <input
                  type="range"
                  min="10"
                  max="200"
                  step="10"
                  value={stripPaddingMs}
                  onChange={(e) => setStripPaddingMs(Number(e.target.value))}
                  className="w-full accent-amber-500 cursor-pointer"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
              <button
                id="btn-strip-silence-cancel"
                onClick={() => setStripSilenceModalOpen(false)}
                className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs cursor-pointer transition-all"
              >
                Отмена
              </button>

              <button
                id="btn-strip-silence-all-tracks"
                onClick={() => handleExecuteStripSilence(true)}
                className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-cyan-950/50 transition-all"
                title="Автоматически удалить тишину и нарезать фразы на всех дорожках проекта"
              >
                <Layers size={14} className="text-cyan-200" />
                Применить ко всем дорожкам
              </button>

              <button
                id="btn-strip-silence-single-track"
                onClick={() => handleExecuteStripSilence(false)}
                className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-emerald-950/50 transition-all"
                title="Нарезать фразы только на выбранной дорожке"
              >
                <Zap size={14} className="text-amber-300" />
                Нарезать выбранную дорожку
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL: РЕДАКТОР СУБТИТРА
          ===================================================================== */}
      {cueEditorOpen && editingCue && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-[#0f1422] border border-slate-800 p-6 rounded-2xl max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-cyan-400 font-bold text-sm">
                <Edit3 size={16} />
                <span>Редактирование реплики #{editingCue.index}</span>
              </div>
              <button
                onClick={() => setCueEditorOpen(false)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Говорящий (Спикер):</label>
                <input
                  type="text"
                  value={editingCue.speaker || ''}
                  onChange={(e) => setEditingCue({ ...editingCue, speaker: e.target.value })}
                  placeholder="Диктор / Имя персонажа"
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl p-2.5 text-xs text-slate-100 focus:border-cyan-500 outline-none"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Текст реплики:</label>
                <textarea
                  rows={3}
                  value={editingCue.text}
                  onChange={(e) => setEditingCue({ ...editingCue, text: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl p-2.5 text-xs text-slate-100 focus:border-cyan-500 outline-none resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 font-mono">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Начало (сек):</label>
                  <input
                    type="number"
                    step="0.05"
                    value={editingCue.startSec}
                    onChange={(e) =>
                      setEditingCue({ ...editingCue, startSec: Math.max(0, parseFloat(e.target.value) || 0) })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl p-2 text-xs text-cyan-400 focus:border-cyan-500 outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Конец (сек):</label>
                  <input
                    type="number"
                    step="0.05"
                    value={editingCue.endSec}
                    onChange={(e) =>
                      setEditingCue({
                        ...editingCue,
                        endSec: Math.max(editingCue.startSec + 0.1, parseFloat(e.target.value) || 0)
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl p-2 text-xs text-cyan-400 focus:border-cyan-500 outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => {
                  handleDeleteSelectedCue();
                  setCueEditorOpen(false);
                }}
                className="px-3 py-2 bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-800/80 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 size={13} />
                Удалить
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCueEditorOpen(false)}
                  className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs cursor-pointer"
                >
                  Отмена
                </button>
                <button
                  onClick={() => handleSaveEditedCue(editingCue)}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-md shadow-cyan-950/50"
                >
                  <Check size={14} />
                  Сохранить
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL: TIME STRETCH ТОЧНАЯ ПОДГОНКА
          ===================================================================== */}
      {stretchDialogOpen && selectedClip && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-[#0f1422] border border-slate-800 p-5 rounded-2xl max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-amber-400 font-bold text-sm">
                <Gauge size={18} />
                <span>Подгонка по времени (WSOLA Time Stretch)</span>
              </div>
              <button
                onClick={() => setStretchDialogOpen(false)}
                className="text-slate-400 hover:text-slate-100 text-sm cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-300">
              Сжатие или растяжение фразы <strong>«{selectedClip.clip.name}»</strong> без изменения высоты голоса (Pitch-Preserved):
            </p>

            <div className="space-y-2">
              <label className="text-xs text-slate-400 block font-medium">
                Коэффициент скорости / длины:
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.05"
                  value={targetStretchRatio}
                  onChange={(e) => setTargetStretchRatio(e.target.value)}
                  className="flex-1 accent-amber-500 cursor-pointer"
                />
                <span className="font-mono text-amber-400 font-bold text-sm min-w-[50px]">
                  {parseFloat(targetStretchRatio).toFixed(2)}x
                </span>
              </div>
              <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                <span>0.5x (Быстрее вдвое)</span>
                <span>1.0x (Оригинал)</span>
                <span>2.0x (Медленнее вдвое)</span>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-end gap-2">
              <button
                onClick={() => setStretchDialogOpen(false)}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs cursor-pointer"
              >
                Отмена
              </button>
              <button
                onClick={() => handleApplyStretchRatio(parseFloat(targetStretchRatio))}
                className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-md shadow-amber-950/40"
              >
                <Check size={14} />
                Применить WSOLA
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL: КРИТИЧЕСКАЯ ОШИБКА C++ WebAssembly ЯДРА
          ===================================================================== */}
      {nativeError && (
        <div className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#1c0d12] border border-red-900/50 p-6 rounded-2xl max-w-lg w-full shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-red-500 border-b border-red-950 pb-3">
              <div className="p-2 bg-red-950/50 rounded-xl text-red-400">
                <span className="text-xl font-bold">⚠</span>
              </div>
              <div>
                <h3 className="font-bold text-sm text-red-400">Критический сбой C++ ядра (WASM Exception)</h3>
                <p className="text-[10px] text-red-500/70 font-mono">Контекст: {nativeError.context}</p>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-red-200/90 leading-relaxed">
                Во время выполнения DSP/редактирования в WebAssembly модуле произошло исключение. 
                Программные JavaScript-заглушки отключены согласно архитектурным стандартам VOMIXStudio.
              </p>
              <pre className="p-3 bg-black/60 rounded-xl text-[11px] text-red-400 font-mono overflow-x-auto border border-red-950/40 max-h-[180px] whitespace-pre-wrap leading-normal">
                {nativeError.message}
              </pre>
            </div>

            <div className="pt-2 flex items-center justify-end">
              <button
                onClick={() => setNativeError(null)}
                className="px-4 py-2 bg-red-950/60 hover:bg-red-900/40 text-red-200 border border-red-900/40 hover:border-red-800/60 font-bold rounded-xl text-xs cursor-pointer shadow-md transition-colors"
              >
                Закрыть и продолжить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
