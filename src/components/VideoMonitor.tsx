import React, { useRef, useEffect, useState, useMemo } from 'react';
import { formatSMPTE } from '../utils/waveformUtils';
import { SubtitleLine } from '../services/AudioAIEngine';
import {
  Film,
  Play,
  Pause,
  Upload,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Subtitles,
  VolumeX,
  Volume2
} from 'lucide-react';

interface VideoMonitorProps {
  currentTimeSec: number;
  isPlaying: boolean;
  onSeek: (timeSec: number) => void;
  onTogglePlay: () => void;
  subtitles?: SubtitleLine[];
  onVideoLoaded?: (file: File, durationSec: number) => void;
}

export const VideoMonitor: React.FC<VideoMonitorProps> = ({
  currentTimeSec,
  isPlaying,
  onSeek,
  onTogglePlay,
  subtitles = [],
  onVideoLoaded
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoFileName, setVideoFileName] = useState<string>('Демо-видео поток (Синхронизация)');
  const [videoDuration, setVideoDuration] = useState<number>(16);
  const [fps] = useState<number>(30);
  const [showSubtitles, setShowSubtitles] = useState<boolean>(true);
  const [isMuted, setIsMuted] = useState<boolean>(true);
  const [isDrifting, setIsDrifting] = useState<boolean>(false);

  // Синхронизация воспроизведения видео с таймлайном DAW
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

    // Проверка рассинхронизации (порог 40 мс)
    const driftSec = Math.abs(video.currentTime - currentTimeSec);
    if (driftSec > 0.04) {
      setIsDrifting(true);
      video.currentTime = currentTimeSec;
    } else {
      setIsDrifting(false);
    }
  }, [currentTimeSec, isPlaying, videoSrc]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setVideoFileName(file.name);

    if (onVideoLoaded) {
      onVideoLoaded(file, videoDuration);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setVideoDuration(videoRef.current.duration || 16);
    }
  };

  const stepFrame = (framesDelta: number) => {
    const frameDuration = 1 / fps;
    const newTime = Math.max(0, Math.min(videoDuration, currentTimeSec + framesDelta * frameDuration));
    onSeek(newTime);
  };

  const currentSubtitle = useMemo(() => {
    if (!subtitles || subtitles.length === 0) return null;
    return subtitles.find(
      (sub) => currentTimeSec >= sub.startSec && currentTimeSec <= sub.endSec
    );
  }, [subtitles, currentTimeSec]);

  // Синтетический холст при отсутствии загруженного видео
  useEffect(() => {
    if (videoSrc) return;

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const stream = canvas.captureStream(30);
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }

    let animId: number;
    const drawSyntheticFrame = () => {
      ctx.fillStyle = '#050811';
      ctx.fillRect(0, 0, 640, 360);

      // Рамка кадрирования
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.strokeRect(32, 18, 640 - 64, 360 - 36);

      const time = currentTimeSec;
      const cx = 320;
      const cy = 180;
      const radius = 80;

      ctx.strokeStyle = '#059669';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      const angle = (time * Math.PI * 2 * (120 / 60)) % (Math.PI * 2);
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      ctx.stroke();

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 22px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(formatSMPTE(time, fps), cx, cy - 15);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px monospace';
      ctx.fillText(`FRAME-ACCURATE SYNC • ${fps} FPS`, cx, cy + 25);

      animId = requestAnimationFrame(drawSyntheticFrame);
    };

    animId = requestAnimationFrame(drawSyntheticFrame);

    return () => {
      cancelAnimationFrame(animId);
      if (video && video.srcObject && typeof (video.srcObject as MediaStream).getTracks === 'function') {
        const s = video.srcObject as MediaStream;
        (s.getTracks() || []).forEach((t) => t.stop());
      }
    };
  }, [videoSrc, currentTimeSec, fps]);

  const toggleFullscreen = () => {
    const videoContainer = videoRef.current?.parentElement;
    if (videoContainer) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        videoContainer.requestFullscreen();
      }
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl flex flex-col">
      {/* Верхняя панель */}
      <div className="bg-slate-950 px-4 py-2.5 border-b border-slate-800 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 font-bold text-slate-200">
          <Film size={15} className="text-cyan-400" />
          <span className="uppercase tracking-wider">Video Sync Monitor</span>
          <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-mono">
            {fps} FPS
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isDrifting && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono animate-pulse">
              Синхронизация...
            </span>
          )}

          <button
            onClick={() => setShowSubtitles(!showSubtitles)}
            className={`px-2 py-1 rounded flex items-center gap-1 font-mono text-[11px] transition-all ${
              showSubtitles
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                : 'bg-slate-900 text-slate-400 border border-slate-800'
            }`}
          >
            <Subtitles size={12} />
            Субтитры
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 hover:border-slate-700 rounded flex items-center gap-1.5 font-mono text-[11px] cursor-pointer"
          >
            <Upload size={12} />
            Загрузить видео
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="video/mp4,video/webm,video/quicktime,video/mkv"
            className="hidden"
          />
        </div>
      </div>

      {/* Окно видеокадра */}
      <div className="relative bg-black aspect-video flex items-center justify-center overflow-hidden group select-none">
        <video
          ref={videoRef}
          src={videoSrc || undefined}
          muted={isMuted}
          playsInline
          onLoadedMetadata={handleLoadedMetadata}
          className="w-full h-full object-contain pointer-events-none"
        />

        {/* Оверлей субтитров */}
        {showSubtitles && currentSubtitle && (
          <div className="absolute bottom-8 left-6 right-6 flex flex-col items-center pointer-events-none animate-fadeIn">
            <div className="bg-slate-950/85 backdrop-blur-md px-4 py-2 rounded-xl border border-slate-700/80 shadow-2xl text-center max-w-xl">
              {currentSubtitle.speaker && (
                <div className="text-[10px] text-emerald-400 font-mono font-bold uppercase tracking-wider mb-0.5">
                  {currentSubtitle.speaker}
                </div>
              )}
              <div className="text-sm font-semibold text-slate-100 leading-snug">
                {currentSubtitle.text}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Нижняя панель управления */}
      <div className="bg-slate-950 px-4 py-2 border-t border-slate-800 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <button
            onClick={onTogglePlay}
            className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors"
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            onClick={() => stepFrame(-1)}
            title="-1 Кадр"
            className="p-1.5 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 rounded transition-colors"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={() => stepFrame(1)}
            title="+1 Кадр"
            className="p-1.5 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 rounded transition-colors"
          >
            <ChevronRight size={14} />
          </button>
          <span className="text-[11px] font-mono text-slate-400 ml-2 truncate max-w-[200px]">
            {videoFileName}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsMuted(!isMuted)}
            title={isMuted ? 'Включить оригинальное аудио видео' : 'Заглушить звук видео'}
            className="p-1.5 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 rounded transition-colors"
          >
            {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <button
            onClick={toggleFullscreen}
            title="Полноэкранный режим"
            className="p-1.5 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 rounded transition-colors"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};
