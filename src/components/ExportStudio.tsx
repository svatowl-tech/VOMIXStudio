import React, { useState, useEffect, useMemo } from 'react';
import { TrackState, MasterState, createDefaultVocalBus, VocalBusState } from '../audio/dawEngine';
import { globalRenderManager, RenderProgressInfo } from '../services/RenderManager';
import { WavBitDepth } from '../services/NativeDAWBridge';
import { toSafeArray } from '../utils/safeIterables';
import { globalLoudnessAutoAligner, LoudnessComparisonResult } from '../services/LoudnessAutoAligner';
import {
  Download,
  Film,
  Music,
  Layers,
  Cpu,
  CheckCircle2,
  AlertTriangle,
  Terminal,
  Play,
  Activity,
  Zap,
  ShieldCheck,
  SlidersHorizontal,
  Gauge
} from 'lucide-react';

// Функция триггера скачивания файла без использования JS wavEncoder
function triggerFileDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface ExportStudioProps {
  tracks: TrackState[];
  master: MasterState;
  sourceVideoFile: File | null;
  vocalBus?: VocalBusState;
}

export const ExportStudio: React.FC<ExportStudioProps> = ({
  tracks,
  master,
  sourceVideoFile,
  vocalBus
}) => {
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(24);
  const [isRendering, setIsRendering] = useState<boolean>(false);
  const [targetDeltaDb, setTargetDeltaDb] = useState<number>(4.0);
  const [autoAlignLoudness, setAutoAlignLoudness] = useState<boolean>(true);

  const effectiveVocalBus = vocalBus || createDefaultVocalBus();

  const loudnessComparison: LoudnessComparisonResult = useMemo(() => {
    return globalLoudnessAutoAligner.compareProjectLoudness(
      toSafeArray<TrackState>(tracks),
      effectiveVocalBus,
      targetDeltaDb
    );
  }, [tracks, effectiveVocalBus, targetDeltaDb]);

  const [progressInfo, setProgressInfo] = useState<RenderProgressInfo>({
    stage: 'idle',
    progressPercent: 0,
    message: 'Ожидание запуска задачи',
    logs: []
  });

  useEffect(() => {
    globalRenderManager.setProgressCallback((info) => {
      setProgressInfo(info);
      if (info.stage === 'completed' || info.stage === 'error') {
        setIsRendering(false);
      }
    });
  }, []);

  // Экспорт мастер-микса WAV
  const handleExportMasterWav = async () => {
    setIsRendering(true);
    try {
      let targetVocalBus = effectiveVocalBus;
      let targetMaster = master;

      if (autoAlignLoudness) {
        const aligned = globalLoudnessAutoAligner.applyAutoAlignment(
          tracks,
          effectiveVocalBus,
          master,
          targetDeltaDb
        );
        targetVocalBus = aligned.updatedVocalBus;
        targetMaster = aligned.updatedMaster;
      }

      const res = await globalRenderManager.renderMasterMix(
        tracks,
        targetMaster,
        sampleRate,
        bitDepth,
        undefined,
        targetVocalBus
      );
      triggerFileDownload(res.wavBlob, `Master_Mix_${sampleRate}Hz_${bitDepth}bit.wav`);
    } catch (e) {
      console.error(e);
      setIsRendering(false);
    }
  };

  // Экспорт мультитрековых стемов (Stems)
  const handleExportStems = async () => {
    setIsRendering(true);
    try {
      const stems = await globalRenderManager.exportStems(tracks, master, sampleRate, bitDepth);
      (stems || []).forEach((item) => {
        triggerFileDownload(item.blob, item.fileName);
      });
    } catch (e) {
      console.error(e);
      setIsRendering(false);
    }
  };

  // Вшивание в видео через FFmpeg WASM
  const handleMuxVideo = async () => {
    if (!sourceVideoFile) {
      alert('Пожалуйста, загрузите исходный видеофайл во вкладке "Видео-монитор" перед муксингом.');
      return;
    }

    setIsRendering(true);
    try {
      let targetVocalBus = effectiveVocalBus;
      let targetMaster = master;

      if (autoAlignLoudness) {
        const aligned = globalLoudnessAutoAligner.applyAutoAlignment(
          tracks,
          effectiveVocalBus,
          master,
          targetDeltaDb
        );
        targetVocalBus = aligned.updatedVocalBus;
        targetMaster = aligned.updatedMaster;
      }

      const audioResult = await globalRenderManager.renderMasterMix(
        tracks,
        targetMaster,
        48000,
        16,
        undefined,
        targetVocalBus
      );
      const muxedVideoBlob = await globalRenderManager.muxAudioIntoVideo(
        sourceVideoFile,
        audioResult.wavBlob,
        'dubbed_output.mp4'
      );

      if (muxedVideoBlob) {
        triggerFileDownload(muxedVideoBlob, `Dubbed_${sourceVideoFile.name}`);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsRendering(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Шапка экспорта */}
      <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-wrap items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400">
            <Download size={22} />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              Экспорт и FFmpeg Муксинг
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                Клиентский рендеринг
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Сведение мастер-трека, поканальная выгрузка стемов и вшивание в видео без сторонних серверов.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Карточки действий */}
        <div className="lg:col-span-6 space-y-4">
          {/* Настройки формата */}
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl space-y-3">
            <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
              Параметры PCM / RIFF WAV
            </h3>
            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
              <div>
                <label className="text-slate-400 block mb-1">Частота дискретизации:</label>
                <select
                  value={sampleRate}
                  onChange={(e) => setSampleRate(Number(e.target.value))}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
                >
                  <option value={44100}>44 100 Hz (CD)</option>
                  <option value={48000}>48 000 Hz (Video standard)</option>
                  <option value={96000}>96 000 Hz (Hi-Res)</option>
                </select>
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Разрядность (Bit depth):</label>
                <select
                  value={bitDepth}
                  onChange={(e) => setBitDepth(Number(e.target.value) as WavBitDepth)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
                >
                  <option value={16}>16-bit PCM</option>
                  <option value={24}>24-bit PCM (Broadcast)</option>
                  <option value={32}>32-bit Float</option>
                </select>
              </div>
            </div>
          </div>

          {/* Анализ и согласование громкости */}
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                <Activity size={14} className="text-cyan-400" />
                Авто-выравнивание громкости
              </h3>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                Цель: +{targetDeltaDb.toFixed(1)} dB
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 font-mono text-xs">
              <div className="p-2 bg-slate-950 rounded-lg border border-slate-800/80">
                <div className="text-[9px] text-slate-400 font-sans">Оригинал:</div>
                <div className="font-bold text-slate-200 text-[11px]">
                  {loudnessComparison.originalLoudness.speechRmsDb > -80
                    ? `${loudnessComparison.originalLoudness.speechRmsDb} dB`
                    : '—'}
                </div>
              </div>
              <div className="p-2 bg-slate-950 rounded-lg border border-slate-800/80">
                <div className="text-[9px] text-purple-400 font-sans">Закадр:</div>
                <div className="font-bold text-purple-300 text-[11px]">
                  {loudnessComparison.dubbedLoudness.speechRmsDb > -80
                    ? `${loudnessComparison.dubbedLoudness.speechRmsDb} dB`
                    : '—'}
                </div>
              </div>
              <div className="p-2 bg-slate-950 rounded-lg border border-slate-800/80">
                <div className="text-[9px] text-cyan-400 font-sans">Разница ($\Delta$):</div>
                <div className="font-bold text-cyan-300 text-[11px]">
                  {loudnessComparison.currentDeltaDb > 0 ? '+' : ''}
                  {loudnessComparison.currentDeltaDb} dB
                </div>
              </div>
            </div>

            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400">Превышение над оригиналом:</span>
                <span className="font-mono text-cyan-400 font-bold">+{targetDeltaDb.toFixed(1)} dB</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-slate-500">3.5 dB</span>
                <input
                  type="range"
                  min="3.5"
                  max="4.5"
                  step="0.1"
                  value={targetDeltaDb}
                  onChange={(e) => setTargetDeltaDb(parseFloat(e.target.value))}
                  className="flex-1 accent-cyan-400 cursor-pointer"
                />
                <span className="text-[9px] font-mono text-slate-500">4.5 dB</span>
              </div>
            </div>

            <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer pt-1 select-none">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={autoAlignLoudness}
                  onChange={(e) => setAutoAlignLoudness(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-0 cursor-pointer"
                />
                Авто-калибровка перед рендером
              </span>
              <span className="text-[10px] text-emerald-400 font-mono flex items-center gap-1">
                <ShieldCheck size={11} /> Limiter -0.1 dB
              </span>
            </label>
          </div>

          {/* Кнопки экспорта */}
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl space-y-3">
            <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
              Варианты сборки
            </h3>

            <div className="space-y-2">
              <button
                onClick={handleExportMasterWav}
                disabled={isRendering}
                className="w-full p-3 bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-emerald-500/50 rounded-lg flex items-center justify-between transition-all cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Music size={18} className="text-emerald-400" />
                  <div className="text-left">
                    <div className="text-xs font-bold text-slate-200">Мастер-микс (WAV)</div>
                    <div className="text-[11px] text-slate-400">Суммарный стерео файл с эффектами</div>
                  </div>
                </div>
                <Download size={16} className="text-slate-400" />
              </button>

              <button
                onClick={handleExportStems}
                disabled={isRendering}
                className="w-full p-3 bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-cyan-500/50 rounded-lg flex items-center justify-between transition-all cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Layers size={18} className="text-cyan-400" />
                  <div className="text-left">
                    <div className="text-xs font-bold text-slate-200">Экспорт стемов (Stems)</div>
                    <div className="text-[11px] text-slate-400">Каждая дорожка выгружается в отдельный WAV</div>
                  </div>
                </div>
                <Download size={16} className="text-slate-400" />
              </button>

              <button
                onClick={handleMuxVideo}
                disabled={isRendering}
                className="w-full p-3 bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-rose-500/50 rounded-lg flex items-center justify-between transition-all cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <Film size={18} className="text-rose-400" />
                  <div className="text-left">
                    <div className="text-xs font-bold text-slate-200">Сборка готового MP4 (FFmpeg)</div>
                    <div className="text-[11px] text-slate-400">Вшивание звука в видеоряд без потери качества</div>
                  </div>
                </div>
                <Download size={16} className="text-slate-400" />
              </button>
            </div>
          </div>
        </div>

        {/* Логи и прогресс */}
        <div className="lg:col-span-6 space-y-4">
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl space-y-3">
            <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center justify-between">
              <span>Статус и терминал FFmpeg</span>
              <span className="text-[10px] font-mono text-emerald-400">{progressInfo.progressPercent}%</span>
            </h3>

            {/* Прогресс-бар */}
            <div className="h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
              <div
                className="h-full bg-emerald-500 transition-all duration-150"
                style={{ width: `${progressInfo.progressPercent}%` }}
              />
            </div>

            <div className="text-xs font-mono text-slate-300">
              {progressInfo.message}
            </div>

            {/* Окно консоли */}
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono text-[11px] text-slate-400 h-56 overflow-y-auto space-y-1">
              {toSafeArray<string>(progressInfo.logs).length === 0 ? (
                <div className="text-slate-600">Терминал ожидает команды...</div>
              ) : (
                toSafeArray<string>(progressInfo.logs).map((log, idx) => (
                  <div key={idx} className="leading-tight">
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
