import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { TrackState, ClipConfig } from '../audio/dawEngine';
import { WaveformCanvas } from './WaveformCanvas';
import { formatSMPTE, formatCompactTime, getAdaptiveTimeStep } from '../utils/waveformUtils';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Clock,
  Magnet,
  Volume2,
  VolumeX,
  Radio,
  Disc,
  Mic,
  Music,
  Sliders,
  Scissors,
  ChevronsLeftRight,
  Move
} from 'lucide-react';

interface TimelineViewProps {
  tracks: TrackState[];
  currentTimeSec: number;
  totalTimeSec?: number;
  isPlaying?: boolean;
  onSeek: (timeSec: number) => void;
  onUpdateTrack?: (updatedTrack: TrackState) => void;
}

type DragMode = 'move' | 'trim-start' | 'trim-end' | 'fade-in' | 'fade-out' | null;

interface ActiveDragState {
  trackId: number;
  clipId: number;
  mode: DragMode;
  startX: number;
  initialOffsetSamples: number;
  initialLengthSamples: number;
  initialFadeInSamples: number;
  initialFadeOutSamples: number;
}

export const TimelineView: React.FC<TimelineViewProps> = ({
  tracks,
  currentTimeSec,
  totalTimeSec = 30,
  isPlaying = false,
  onSeek,
  onUpdateTrack
}) => {
  const sampleRate = 48000;

  // Масштаб отображения (пикселей на секунду времени)
  const [pxPerSec, setPxPerSec] = useState<number>(60);
  const [useSMPTE, setUseSMPTE] = useState<boolean>(true);
  const [snapToGrid, setSnapToGrid] = useState<boolean>(true);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [selectedClipId, setSelectedClipId] = useState<number | null>(null);

  // Ссылки на контейнеры для синхронизации прокрутки и 60 FPS плейхеда
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const rulerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const currentTimeSecRef = useRef<number>(currentTimeSec);
  currentTimeSecRef.current = currentTimeSec;

  // Состояние активного перетаскивания (Drag / Trim / Fade)
  const [activeDrag, setActiveDrag] = useState<ActiveDragState | null>(null);

  // Вычисление максимальной длины проекта с запасом
  const maxProjectSec = useMemo(() => {
    let maxSec = totalTimeSec;
    tracks.forEach((t) => {
      t.clips.forEach((c) => {
        const endSec = (c.offsetSamples + c.lengthSamples) / sampleRate;
        if (endSec > maxSec) maxSec = endSec;
      });
    });
    return Math.max(maxSec + 10, 30);
  }, [tracks, totalTimeSec, sampleRate]);

  const totalWidthPx = Math.max(800, Math.floor(maxProjectSec * pxPerSec));

  // ==========================================================================
  // 60 FPS REQUEST ANIMATION FRAME PLAYHEAD (Без лишних ре-рендеров React)
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
          if (x > scrollLeft + containerWidth - 100) {
            timelineScrollRef.current.scrollLeft = x - 100;
          } else if (x < scrollLeft) {
            timelineScrollRef.current.scrollLeft = Math.max(0, x - 50);
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

    // Фоновая заливка линейки
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, width, height);

    // Нижняя разделительная полоса
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();

    const { majorStepSec, minorStepSec } = getAdaptiveTimeStep(pxPerSec);
    const totalSteps = Math.ceil(maxProjectSec / minorStepSec);

    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';

    for (let i = 0; i <= totalSteps; i++) {
      const time = i * minorStepSec;
      const x = time * pxPerSec;
      const isMajor = Math.abs(time % majorStepSec) < 0.0001 || Math.abs(time % majorStepSec - majorStepSec) < 0.0001;

      if (isMajor) {
        // Главная риска
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, height - 12);
        ctx.lineTo(x, height);
        ctx.stroke();

        // Подпись времени
        ctx.fillStyle = '#94a3b8';
        const label = useSMPTE ? formatSMPTE(time) : formatCompactTime(time);
        ctx.fillText(label, x + 4, 4);
      } else {
        // Второстепенная риска
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x, height - 6);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    }
  }, [totalWidthPx, maxProjectSec, pxPerSec, useSMPTE]);

  useEffect(() => {
    renderRuler();
  }, [renderRuler]);

  // ==========================================================================
  // ЗУММИРОВАНИЕ КОЛЕСОМ МЫШИ С ФОКУСОМ НА КУРСОРЕ (ZOOM TO CURSOR)
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
      const newPxPerSec = Math.max(10, Math.min(600, pxPerSec * zoomFactor));

      setPxPerSec(newPxPerSec);

      // Корректировка scrollLeft для сохранения фокуса на курсоре
      requestAnimationFrame(() => {
        if (timelineScrollRef.current) {
          const newMouseX = timeAtCursor * newPxPerSec;
          timelineScrollRef.current.scrollLeft = newMouseX - (e.clientX - rect.left);
        }
      });
    }
  };

  // Клик по линейке для перемещения плейхеда (Seek)
  const handleRulerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left + (timelineScrollRef.current?.scrollLeft || 0);
    let seekTime = Math.max(0, clickX / pxPerSec);

    if (snapToGrid) {
      const { minorStepSec } = getAdaptiveTimeStep(pxPerSec);
      seekTime = Math.round(seekTime / minorStepSec) * minorStepSec;
    }

    onSeek(seekTime);
  };

  // ==========================================================================
  // ОБРАБОТКА DRAG / TRIM / FADE ДЛЯ КЛИПОВ
  // ==========================================================================
  const handleClipMouseDown = (
    e: React.MouseEvent,
    trackId: number,
    clip: ClipConfig,
    mode: DragMode
  ) => {
    e.stopPropagation();
    setSelectedClipId(clip.id);

    setActiveDrag({
      trackId,
      clipId: clip.id,
      mode,
      startX: e.clientX,
      initialOffsetSamples: clip.offsetSamples,
      initialLengthSamples: clip.lengthSamples,
      initialFadeInSamples: clip.fadeInSamples,
      initialFadeOutSamples: clip.fadeOutSamples
    });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!activeDrag || !onUpdateTrack) return;

      const deltaPx = e.clientX - activeDrag.startX;
      const deltaSec = deltaPx / pxPerSec;
      const deltaSamples = Math.round(deltaSec * sampleRate);

      const targetTrack = tracks.find((t) => t.id === activeDrag.trackId);
      if (!targetTrack) return;

      const updatedClips = targetTrack.clips.map((clip) => {
        if (clip.id !== activeDrag.clipId) return clip;

        if (activeDrag.mode === 'move') {
          let newOffset = Math.max(0, activeDrag.initialOffsetSamples + deltaSamples);
          if (snapToGrid) {
            const { minorStepSec } = getAdaptiveTimeStep(pxPerSec);
            const minorStepSamples = Math.round(minorStepSec * sampleRate);
            newOffset = Math.round(newOffset / minorStepSamples) * minorStepSamples;
          }
          return { ...clip, offsetSamples: newOffset };
        }

        if (activeDrag.mode === 'trim-start') {
          const newOffset = Math.max(0, activeDrag.initialOffsetSamples + deltaSamples);
          const newLength = Math.max(sampleRate * 0.1, activeDrag.initialLengthSamples - deltaSamples);
          return { ...clip, offsetSamples: newOffset, lengthSamples: newLength };
        }

        if (activeDrag.mode === 'trim-end') {
          const newLength = Math.max(sampleRate * 0.1, activeDrag.initialLengthSamples + deltaSamples);
          return { ...clip, lengthSamples: newLength };
        }

        if (activeDrag.mode === 'fade-in') {
          const newFadeIn = Math.max(0, Math.min(clip.lengthSamples, activeDrag.initialFadeInSamples + deltaSamples));
          return { ...clip, fadeInSamples: newFadeIn };
        }

        if (activeDrag.mode === 'fade-out') {
          const newFadeOut = Math.max(0, Math.min(clip.lengthSamples, activeDrag.initialFadeOutSamples - deltaSamples));
          return { ...clip, fadeOutSamples: newFadeOut };
        }

        return clip;
      });

      onUpdateTrack({ ...targetTrack, clips: updatedClips });
    };

    const handleMouseUp = () => {
      if (activeDrag) {
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
  }, [activeDrag, pxPerSec, sampleRate, snapToGrid, tracks, onUpdateTrack]);

  const getTrackIcon = (id: number) => {
    if (id === 1) return <Disc size={13} className="text-rose-400" />;
    if (id === 2) return <Music size={13} className="text-blue-400" />;
    if (id === 3) return <Mic size={13} className="text-emerald-400" />;
    return <Volume2 size={13} className="text-purple-400" />;
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl flex flex-col select-none">
      {/* =====================================================================
          TIMELINE CONTROL TOOLBAR
          ===================================================================== */}
      <div className="bg-slate-950 px-4 py-2.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
        {/* Left: Section Title & Timecode Counter */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 font-bold text-slate-200">
            <Sliders size={15} className="text-emerald-400" />
            <span className="uppercase tracking-wider">Multi-Track Timeline & Waveforms</span>
          </div>

          {/* SMPTE Time Display */}
          <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1 rounded-md font-mono text-emerald-400 shadow-inner">
            <Clock size={13} />
            <span className="font-bold tracking-wider">
              {useSMPTE ? formatSMPTE(currentTimeSec) : formatCompactTime(currentTimeSec)}
            </span>
          </div>
        </div>

        {/* Right: Zoom Controls & Toggles */}
        <div className="flex items-center gap-2">
          {/* Snap to Grid Toggle */}
          <button
            onClick={() => setSnapToGrid(!snapToGrid)}
            title="Привязка к сетке (Snap to Grid)"
            className={`px-2.5 py-1 rounded flex items-center gap-1.5 transition-all font-mono text-[11px] ${
              snapToGrid
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                : 'bg-slate-900 text-slate-400 border border-slate-800 hover:text-slate-200'
            }`}
          >
            <Magnet size={13} />
            Snap
          </button>

          {/* Timecode Mode Toggle */}
          <button
            onClick={() => setUseSMPTE(!useSMPTE)}
            title="Переключить формат времени (SMPTE / Секунды)"
            className="px-2.5 py-1 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded font-mono text-[11px]"
          >
            {useSMPTE ? 'SMPTE (30fps)' : 'Time (sec)'}
          </button>

          {/* Auto Scroll Toggle */}
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-2.5 py-1 rounded font-mono text-[11px] border ${
              autoScroll
                ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            Auto-Scroll
          </button>

          {/* Horizontal Zoom Buttons */}
          <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded p-0.5">
            <button
              onClick={() => setPxPerSec((prev) => Math.max(10, prev * 0.75))}
              title="Отдалить (Zoom Out, Ctrl + Колесо)"
              className="p-1 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded transition-colors"
            >
              <ZoomOut size={14} />
            </button>
            <span className="text-[10px] font-mono text-slate-400 px-1.5 min-w-[42px] text-center">
              {Math.round(pxPerSec)} px/s
            </span>
            <button
              onClick={() => setPxPerSec((prev) => Math.min(600, prev * 1.25))}
              title="Приблизить (Zoom In, Ctrl + Колесо)"
              className="p-1 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded transition-colors"
            >
              <ZoomIn size={14} />
            </button>
            <button
              onClick={() => setPxPerSec(60)}
              title="Сброс масштаба"
              className="p-1 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded transition-colors ml-0.5"
            >
              <Maximize2 size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* =====================================================================
          MAIN TIMELINE SCROLLABLE CONTAINER
          ===================================================================== */}
      <div className="flex bg-slate-950 relative overflow-hidden" onWheel={handleWheel}>
        {/* LEFT COLUMN: Fixed Track Headers Panel */}
        <div className="w-56 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col z-20 shadow-xl">
          {/* Header Spacer (соответствует высоте линейки 28px) */}
          <div className="h-7 bg-slate-950 border-b border-slate-800 px-3 flex items-center justify-between text-[10px] font-mono text-slate-400 uppercase tracking-wider">
            <span>Дорожки</span>
            <span>M / S / R</span>
          </div>

          {/* Track Headers List */}
          <div className="flex flex-col divide-y divide-slate-800/60">
            {tracks.map((track) => (
              <div
                key={track.id}
                className="h-20 px-3 py-2 flex flex-col justify-between bg-slate-900/90 hover:bg-slate-800/40 transition-colors"
              >
                {/* Top Row: Color, Icon, Track Name */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ backgroundColor: track.color }}
                    />
                    {getTrackIcon(track.id)}
                    <span className="text-xs font-semibold text-slate-200 truncate" title={track.name}>
                      {track.name}
                    </span>
                  </div>
                </div>

                {/* Bottom Row: Mute, Solo, Rec Buttons & Gain Info */}
                <div className="flex items-center justify-between gap-1 text-[10px] font-mono">
                  <div className="flex items-center gap-1">
                    {/* Mute */}
                    <button
                      onClick={() => onUpdateTrack?.({ ...track, mute: !track.mute })}
                      className={`w-5 h-5 rounded font-bold transition-all flex items-center justify-center ${
                        track.mute
                          ? 'bg-rose-600 text-white shadow-md'
                          : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      M
                    </button>

                    {/* Solo */}
                    <button
                      onClick={() => onUpdateTrack?.({ ...track, solo: !track.solo })}
                      className={`w-5 h-5 rounded font-bold transition-all flex items-center justify-center ${
                        track.solo
                          ? 'bg-amber-500 text-slate-950 shadow-md'
                          : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      S
                    </button>

                    {/* Rec Arm */}
                    <button
                      className="w-5 h-5 rounded font-bold bg-slate-800 text-slate-400 hover:text-rose-400 transition-all flex items-center justify-center"
                    >
                      <Radio size={10} />
                    </button>
                  </div>

                  <span className="text-slate-400">
                    {track.volumeDb >= 0 ? `+${track.volumeDb.toFixed(1)}` : track.volumeDb.toFixed(1)} dB
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN: Horizontal Scrollable Timeline Area (Ruler + Tracks Lanes) */}
        <div
          ref={timelineScrollRef}
          className="flex-1 overflow-x-auto overflow-y-hidden relative bg-slate-950 select-none scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-slate-950"
        >
          <div style={{ width: `${totalWidthPx}px` }} className="relative flex flex-col">
            {/* 1. Time Ruler Canvas */}
            <div
              className="h-7 sticky top-0 z-10 cursor-pointer"
              onClick={handleRulerClick}
            >
              <canvas ref={rulerCanvasRef} className="block w-full h-full" />
            </div>

            {/* 2. Track Lanes with Clips & Canvas Waveforms */}
            <div className="flex flex-col divide-y divide-slate-800/60 relative">
              {tracks.map((track) => (
                <div
                  key={track.id}
                  className="h-20 relative bg-slate-950/70 hover:bg-slate-900/30 transition-colors"
                >
                  {/* Grid background lines */}
                  <div
                    className="absolute inset-0 pointer-events-none opacity-10"
                    style={{
                      backgroundImage: `linear-gradient(to right, #64748b 1px, transparent 1px)`,
                      backgroundSize: `${pxPerSec}px 100%`
                    }}
                  />

                  {/* Render Clips on this Track */}
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
                        className={`absolute top-1 bottom-1 rounded-md border text-xs overflow-hidden group shadow-lg cursor-grab active:cursor-grabbing transition-shadow ${
                          isSelected ? 'ring-2 ring-cyan-400 shadow-cyan-950/50' : ''
                        }`}
                      >
                        {/* Clip Waveform Canvas */}
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

                        {/* Clip Header Label */}
                        <div className="absolute top-1 left-2 right-2 flex items-center justify-between text-[10px] font-mono text-slate-200 pointer-events-none drop-shadow">
                          <span className="font-bold truncate bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800/80">
                            {clip.name}
                          </span>
                          <span className="bg-slate-950/60 px-1.5 py-0.5 rounded text-[9px] text-slate-300">
                            {clipLenSec.toFixed(2)}s
                          </span>
                        </div>

                        {/* Fade In Handle (Top Left Corner) */}
                        <div
                          onMouseDown={(e) => handleClipMouseDown(e, track.id, clip, 'fade-in')}
                          title="Fade In Handle"
                          style={{ left: `${fadeInPx}px` }}
                          className="absolute top-0 w-3 h-3 -translate-x-1.5 bg-white border border-slate-900 rounded-full cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity z-30 shadow"
                        />

                        {/* Fade Out Handle (Top Right Corner) */}
                        <div
                          onMouseDown={(e) => handleClipMouseDown(e, track.id, clip, 'fade-out')}
                          title="Fade Out Handle"
                          style={{ right: `${fadeOutPx}px` }}
                          className="absolute top-0 w-3 h-3 translate-x-1.5 bg-white border border-slate-900 rounded-full cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity z-30 shadow"
                        />

                        {/* Left Trim Handle */}
                        <div
                          onMouseDown={(e) => handleClipMouseDown(e, track.id, clip, 'trim-start')}
                          title="Trim Left (Start)"
                          className="absolute top-0 bottom-0 left-0 w-2 hover:w-3 bg-emerald-500/60 hover:bg-emerald-400 cursor-w-resize transition-all opacity-0 group-hover:opacity-100 z-20 flex items-center justify-center"
                        >
                          <div className="w-0.5 h-4 bg-slate-950 rounded-full" />
                        </div>

                        {/* Right Trim Handle */}
                        <div
                          onMouseDown={(e) => handleClipMouseDown(e, track.id, clip, 'trim-end')}
                          title="Trim Right (End)"
                          className="absolute top-0 bottom-0 right-0 w-2 hover:w-3 bg-emerald-500/60 hover:bg-emerald-400 cursor-e-resize transition-all opacity-0 group-hover:opacity-100 z-20 flex items-center justify-center"
                        >
                          <div className="w-0.5 h-4 bg-slate-950 rounded-full" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* 3. 60 FPS RequestAnimationFrame Playhead Line */}
            <div
              ref={playheadRef}
              className="absolute top-0 bottom-0 w-px bg-rose-500 z-30 pointer-events-none shadow-[0_0_10px_rgba(244,63,94,1)] will-change-transform"
            >
              {/* Playhead Arrow Badge */}
              <div className="w-3.5 h-3.5 bg-rose-500 rotate-45 -translate-x-[6px] -translate-y-1 rounded-xs shadow-md border border-rose-300 pointer-events-none" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
