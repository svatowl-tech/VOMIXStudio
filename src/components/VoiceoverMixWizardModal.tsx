/**
 * ============================================================================
 * VOICEOVER MIX PIPELINE WIZARD (ЗАКАДРОВЫЙ КОНВЕЙЕР СВЕДЕНИЯ)
 * ============================================================================
 * Пошаговый интерактивный мастер сведения закадрового озвучания:
 * 1. AI и DSP обработка, нормализация громкости EBU R128.
 * 2. Детекция коллизий и наездов фраз (Остановка конвейера для ручной правки на таймлайне).
 * 3. Калибровка баланса громкости через Шину Вокала и дорожки (Остановка для прослушивания с начала).
 * 4. Мастер-шина, рендеринг C++ микса и FFmpeg WASM вшивание в видео.
 * ============================================================================
 */

import React, { useState, useEffect, useMemo } from 'react';
import { TrackState, VocalBusState, MasterState, createDefaultVocalBus } from '../audio/dawEngine';
import { detectTrackCollisions, ClipCollisionInfo } from '../utils/collisionDetector';
import { systemLogger } from '../services/SystemLogger';
import { toSafeArray } from '../utils/safeIterables';
import { globalLoudnessAutoAligner, LoudnessComparisonResult } from '../services/LoudnessAutoAligner';
import { SubtitleCue } from '../services/ProjectManager';
import { globalAutoTimingService } from '../services/AutoTimingService';
import {
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Play,
  Pause,
  RotateCcw,
  Sliders,
  Volume2,
  VolumeX,
  FileAudio,
  Film,
  Download,
  ChevronRight,
  Maximize2,
  Minimize2,
  X,
  RefreshCw,
  Zap,
  Layers,
  Music,
  Mic,
  ShieldCheck,
  Info,
  Activity,
  Gauge,
  SlidersHorizontal,
  Check
} from 'lucide-react';

export type WizardStage =
  | 'idle'
  | 'step1_ai_and_norm'
  | 'step2_collision_check'
  | 'step3_volume_balance'
  | 'step4_master_and_mux'
  | 'completed'
  | 'error';

export interface VoiceoverMixWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  tracks: TrackState[];
  setTracks: React.Dispatch<React.SetStateAction<TrackState[]>>;
  vocalBus: VocalBusState;
  setVocalBus: React.Dispatch<React.SetStateAction<VocalBusState>> | ((vocalBus: VocalBusState) => void);
  onVocalBusChange?: (updatedVocalBus: VocalBusState) => void;
  onTrackVolumeChange?: (trackId: number, volumeDb: number) => void;
  master: MasterState;
  videoFile: File | null;
  videoDuration: number;
  currentTimeSec: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeek: (sec: number) => void;
  onRunAIPipelineAndNorm: (onProgress?: (msg: string, percent: number) => void) => Promise<TrackState[]>;
  onRunFinalMasterAndMux: (
    updatedTracks: TrackState[],
    updatedVocalBus: VocalBusState
  ) => Promise<{ videoBlob: Blob | null; videoUrl: string | null; outputFileName: string }>;
  onCollisionsDetected: (collisions: ClipCollisionInfo[]) => void;
  subtitles?: SubtitleCue[];
  onRunAutoTiming?: (tracksToTime?: TrackState[]) => Promise<TrackState[]>;
}

export const VoiceoverMixWizardModal: React.FC<VoiceoverMixWizardModalProps> = ({
  isOpen,
  onClose,
  tracks,
  setTracks,
  vocalBus,
  setVocalBus,
  onVocalBusChange,
  onTrackVolumeChange,
  master,
  videoFile,
  videoDuration,
  currentTimeSec,
  isPlaying,
  onTogglePlay,
  onSeek,
  onRunAIPipelineAndNorm,
  onRunFinalMasterAndMux,
  onCollisionsDetected,
  subtitles = [],
  onRunAutoTiming
}) => {
  const [stage, setStage] = useState<WizardStage>('idle');
  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [collisions, setCollisions] = useState<ClipCollisionInfo[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAutoTimingRunning, setIsAutoTimingRunning] = useState<boolean>(false);
  const [autoTimingSummary, setAutoTimingSummary] = useState<string | null>(null);

  // Финальный результат
  const [resultVideoUrl, setResultVideoUrl] = useState<string | null>(null);
  const [resultFileName, setResultFileName] = useState<string>('');
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);

  // Настройки стандарта громкости (целевая разница 3.5 - 4.5 dB, по умолчанию 4.0 dB)
  const [targetDeltaDb, setTargetDeltaDb] = useState<number>(4.0);
  const [autoAlignBeforeRender, setAutoAlignBeforeRender] = useState<boolean>(true);

  // Локальное реактивное состояние Шины Вокала для плавной регулировки ползунка
  const [currentVocalBus, setCurrentVocalBus] = useState<VocalBusState>(() => vocalBus || createDefaultVocalBus());

  useEffect(() => {
    if (vocalBus) {
      setCurrentVocalBus(vocalBus);
    }
  }, [vocalBus]);

  // Реактивный анализ громкостей (Оригинал vs Закадровый мастер-микс)
  const loudnessComparison: LoudnessComparisonResult = useMemo(() => {
    return globalLoudnessAutoAligner.compareProjectLoudness(
      toSafeArray<TrackState>(tracks),
      currentVocalBus,
      targetDeltaDb
    );
  }, [tracks, currentVocalBus, targetDeltaDb]);

  const handleApplyAutoLoudness = (customDelta?: number) => {
    const delta = customDelta !== undefined ? customDelta : targetDeltaDb;
    const aligned = globalLoudnessAutoAligner.applyAutoAlignment(
      toSafeArray<TrackState>(tracks),
      currentVocalBus,
      master,
      delta
    );

    setCurrentVocalBus(aligned.updatedVocalBus);
    if (onVocalBusChange) {
      onVocalBusChange(aligned.updatedVocalBus);
    }
    if (typeof setVocalBus === 'function') {
      try {
        (setVocalBus as any)(aligned.updatedVocalBus);
      } catch (_) {}
    }

    addLog(
      `⚡ Авто-выравнивание: Установлен баланс +${aligned.comparison.targetDeltaDb} dB (Шина вокала: ${aligned.updatedVocalBus.volumeDb > 0 ? '+' : ''}${aligned.updatedVocalBus.volumeDb.toFixed(1)} dB)`
    );
  };

  const handleVocalBusVolumeChange = (newVolumeDb: number) => {
    const updatedBus: VocalBusState = {
      ...(currentVocalBus || vocalBus || createDefaultVocalBus()),
      volumeDb: newVolumeDb
    };
    setCurrentVocalBus(updatedBus);

    if (onVocalBusChange) {
      onVocalBusChange(updatedBus);
    }

    if (typeof setVocalBus === 'function') {
      try {
        (setVocalBus as any)(updatedBus);
      } catch (_) {}
    }
  };

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${time}] ${msg}`]);
  };

  // Автозапуск первого шага при открытии
  useEffect(() => {
    if (isOpen && stage === 'idle') {
      startPipeline();
    }
  }, [isOpen]);

  const startPipeline = async () => {
    setErrorMessage(null);
    setLogs([]);
    setStage('step1_ai_and_norm');
    setProgressPercent(10);
    setStatusMessage('Шаг 1/4: AI-обработка, очистка шумов и EBU R128 нормализация громкости (-18 dBFS)...');
    addLog('Запуск конвейера сведения заказадрового озвучания...');
    systemLogger.info('MVPPipeline', 'Запуск сквозного конвейера сведения закадрового озвучания (Шаг 1: AI и нормализация)');

    try {
      // 1. Применение AI и нормализация
      const processedTracks = await onRunAIPipelineAndNorm((msg, pct) => {
        setStatusMessage(`Шаг 1/4: ${msg}`);
        setProgressPercent(Math.round(10 + pct * 0.25)); // Scale progress to 10% - 35%
        addLog(msg);
      });
      setTracks(processedTracks);
      addLog('AI обработка и EBU R128 нормализация всех дорожек успешно завершена.');
      systemLogger.info('MVPPipeline', 'AI обработка и EBU R128 нормализация всех дорожек успешно завершена.');
      setProgressPercent(35);

      // 2. Детекция коллизий
      setStatusMessage('Шаг 2/4: Детекция коллизий и наездов фраз...');
      const detectedCollisions = detectTrackCollisions(processedTracks);
      setCollisions(detectedCollisions);
      onCollisionsDetected(detectedCollisions);

      setStage('step2_collision_check');
      setProgressPercent(50);

      if (detectedCollisions.length > 0) {
        addLog(`⚠️ ВНИМАНИЕ: Обнаружено ${detectedCollisions.length} коллизий / наездов фраз! Конвейер приостановлен.`);
        setStatusMessage(`Обнаружено коллизий: ${detectedCollisions.length} шт. Конвейер приостановлен для проверки.`);
        systemLogger.warn('MVPPipeline', `Обнаружено ${detectedCollisions.length} коллизий / наездов фраз. Конвейер переведен в режим паузы для правки на таймлайне.`);
      } else {
        addLog('✅ Коллизий и наездов фраз не обнаружено.');
        setStatusMessage('Коллизий не обнаружено. Переходим к калибровке громкости.');
        systemLogger.info('MVPPipeline', 'Коллизий и наездов фраз не обнаружено. Переход к калибровке громкости.');
      }
    } catch (err: any) {
      addLog(`❌ Ошибка на Шаге 1: ${err?.message || err}`);
      setErrorMessage(err?.message || 'Ошибка обработки аудио');
      systemLogger.error('MVPPipeline', `Ошибка на Шаге 1 (AI / Нормализация): ${err?.message || err}`);
      setStage('error');
    }
  };

  // Перепроверка коллизий
  const handleRecheckCollisions = () => {
    const rechecked = detectTrackCollisions(tracks);
    setCollisions(rechecked);
    onCollisionsDetected(rechecked);
    if (rechecked.length === 0) {
      addLog('✅ Все коллизии успешно устранены!');
      setStatusMessage('Коллизии устранены. Можно продолжать конвейер.');
      systemLogger.info('MVPPipeline', 'Коллизии успешно устранены пользователем на таймлайне.');
    } else {
      addLog(`Осталось коллизий: ${rechecked.length} шт.`);
      systemLogger.warn('MVPPipeline', `Повторная проверка: осталось ${rechecked.length} коллизий.`);
    }
  };

  // Автоматический тайминг и разведение коллизий по субтитрам
  const handleAutoTimingInWizard = async () => {
    setIsAutoTimingRunning(true);
    setStatusMessage('Запуск автоматического тайминга: сопоставление актёров и разведение коллизий...');
    addLog('⚡ Запуск C++ алгоритма сценарного тайминга и устранения наездов...');
    try {
      let updated: TrackState[];
      if (onRunAutoTiming) {
        updated = await onRunAutoTiming(tracks);
      } else {
        const res = globalAutoTimingService.runAutoTimingPipeline(tracks, subtitles);
        updated = res.updatedTracks;
        setTracks(updated);
        setAutoTimingSummary(
          `Синхронизировано ${res.totalPhrasesAligned} фраз, устранено ${res.resolvedCollisionsCount} наездов, сохранено ${res.preservedScriptOverlapsCount} сценарных перекрытий.`
        );
      }
      const rechecked = detectTrackCollisions(updated);
      setCollisions(rechecked);
      onCollisionsDetected(rechecked);
      addLog(`⚡ Авто-тайминг выполнен: устранено коллизий, осталось: ${rechecked.length}.`);
      setStatusMessage(`Авто-тайминг завершён: коллизий осталось: ${rechecked.length}.`);
    } catch (e: any) {
      addLog(`❌ Ошибка авто-тайминга: ${e?.message || e}`);
    } finally {
      setIsAutoTimingRunning(false);
    }
  };

  // Переход к Шагу 3 (Калибровка громкости и Шина Вокала)
  const handleProceedToVolumeBalance = () => {
    setStage('step3_volume_balance');
    setProgressPercent(70);
    setStatusMessage('Шаг 3/4: Калибровка общего баланса громкости с начала проекта и Шина Вокала.');
    addLog('Приостановка конвейера: Ожидание калибровки громкости пользователем.');
    systemLogger.info('MVPPipeline', 'Шаг 3/4: Калибровка баланса громкости через Шину Вокала и дорожки.');
  };

  // Завершение и запуск мастеринга + FFmpeg муксинга
  const handleProceedToFinalMasterAndMux = async () => {
    setStage('step4_master_and_mux');
    setProgressPercent(85);
    setStatusMessage('Шаг 4/4: Анализ громкостей, C++ мастеринг и вшивание аудио в видео...');
    addLog('Старт финального C++ мастеринга и FFmpeg видео-муксинга...');
    systemLogger.info('MVPPipeline', 'Шаг 4/4: Старт финального C++ мастеринга и FFmpeg видео-муксинга.');

    try {
      let targetVocalBus = currentVocalBus || vocalBus;
      let targetTracks = [...tracks];

      // Автоматическое согласование громкости перед рендером
      if (autoAlignBeforeRender) {
        const aligned = globalLoudnessAutoAligner.applyAutoAlignment(
          toSafeArray<TrackState>(targetTracks),
          targetVocalBus,
          master,
          targetDeltaDb
        );

        targetVocalBus = aligned.updatedVocalBus;
        setCurrentVocalBus(aligned.updatedVocalBus);
        if (onVocalBusChange) onVocalBusChange(aligned.updatedVocalBus);

        addLog(
          `[AutoLoudness] Финальная калибровка: Оригинал=${aligned.comparison.originalLoudness.speechRmsDb} dBFS, Дубляж=${aligned.comparison.dubbedLoudness.speechRmsDb} dBFS. Разница: +${aligned.comparison.targetDeltaDb} dB.`
        );
        systemLogger.info(
          'MVPPipeline',
          `Авто-выравнивание перед рендером: Оригинал=${aligned.comparison.originalLoudness.speechRmsDb} dBFS, Закадр=${aligned.comparison.dubbedLoudness.speechRmsDb} dBFS (Цель +${aligned.comparison.targetDeltaDb} dB)`
        );
      }

      const res = await onRunFinalMasterAndMux(targetTracks, targetVocalBus);
      setResultVideoUrl(res.videoUrl);
      setResultFileName(res.outputFileName);
      setResultBlob(res.videoBlob);

      setProgressPercent(100);
      setStage('completed');
      setStatusMessage(`Готово! Видео успешно сведено и зашито: ${res.outputFileName}`);
      addLog(`🎉 Сквозной конвейер успешно завершен! Файл ${res.outputFileName} сохранен в project/.`);
      systemLogger.info('MVPPipeline', `Конвейер успешно завершен! Создан сшитый файл: ${res.outputFileName}`);
    } catch (err: any) {
      addLog(`❌ Ошибка мастеринга/муксинга: ${err?.message || err}`);
      setErrorMessage(err?.message || 'Ошибка финального рендеринга');
      systemLogger.error('MVPPipeline', `Ошибка на Шаге 4 (Мастеринг / FFmpeg муксинг): ${err?.message || err}`);
      setStage('error');
    }
  };

  if (!isOpen) return null;

  // Минимизированный режим (плавающая панель во время правки на таймлайне)
  if (isMinimized) {
    return (
      <div className="fixed bottom-6 right-6 z-50 bg-[#0f172a] border border-amber-500/50 rounded-2xl shadow-2xl p-4 w-96 text-slate-100 space-y-3 animate-fadeIn">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-amber-500/20 border border-amber-500/30 rounded-lg text-amber-400">
              <AlertTriangle size={16} />
            </div>
            <div>
              <h4 className="text-xs font-bold">Конвейер на паузе</h4>
              <p className="text-[10px] text-slate-400">Правка коллизий на таймлайне</p>
            </div>
          </div>
          <button
            onClick={() => setIsMinimized(false)}
            className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-all cursor-pointer"
            title="Развернуть окно конвейера"
          >
            <Maximize2 size={16} />
          </button>
        </div>

        {collisions.length > 0 && (
          <div className="text-[11px] bg-rose-950/40 border border-rose-500/30 p-2 rounded-lg text-rose-300">
            Обнаружено {collisions.length} наездов фраз. Клипы подсвечены красным на таймлайне!
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={handleRecheckCollisions}
            className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1 cursor-pointer"
          >
            <RefreshCw size={12} />
            Проверить
          </button>
          <button
            onClick={() => {
              setIsMinimized(false);
              handleProceedToVolumeBalance();
            }}
            className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1 cursor-pointer shadow-lg shadow-emerald-950/50"
          >
            Продолжить <ChevronRight size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-[#0b0f19] border border-slate-800 rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Шапка модального окна */}
        <div className="p-5 border-b border-slate-800 bg-[#0f172a]/60 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-purple-500/20 to-cyan-500/20 border border-purple-500/30 rounded-2xl text-purple-400">
              <Sparkles size={20} className="text-amber-300" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                Конвейер Закадрового Сведения
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  Interactive Wizard
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Полный цикл: AI очистка $\rightarrow$ Детекция наездов $\rightarrow$ Шина вокала $\rightarrow$ Мастеринг в видео
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-xl transition-all cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Шкала шагов конвейера */}
        <div className="px-6 pt-4 pb-2 border-b border-slate-800/80 bg-[#090d16]">
          <div className="flex items-center justify-between text-xs font-medium mb-2">
            <span className={`flex items-center gap-1 ${stage === 'step1_ai_and_norm' ? 'text-purple-400 font-bold' : 'text-slate-500'}`}>
              1. AI & Norm
            </span>
            <span className={`flex items-center gap-1 ${stage === 'step2_collision_check' ? 'text-amber-400 font-bold' : 'text-slate-500'}`}>
              2. Коллизии
            </span>
            <span className={`flex items-center gap-1 ${stage === 'step3_volume_balance' ? 'text-cyan-400 font-bold' : 'text-slate-500'}`}>
              3. Громкость
            </span>
            <span className={`flex items-center gap-1 ${stage === 'step4_master_and_mux' || stage === 'completed' ? 'text-emerald-400 font-bold' : 'text-slate-500'}`}>
              4. Мастеринг
            </span>
          </div>

          <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
            <div
              className="h-full bg-gradient-to-r from-purple-500 via-cyan-500 to-emerald-500 transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Основной интерактивный контент шага */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {/* Статус-сообщение */}
          <div className="p-3.5 bg-slate-900/80 border border-slate-800 rounded-2xl flex items-center gap-3">
            {stage === 'step1_ai_and_norm' || stage === 'step4_master_and_mux' ? (
              <RefreshCw size={18} className="animate-spin text-purple-400 shrink-0" />
            ) : stage === 'step2_collision_check' && collisions.length > 0 ? (
              <AlertTriangle size={18} className="text-rose-400 shrink-0 animate-bounce" />
            ) : stage === 'completed' ? (
              <CheckCircle2 size={18} className="text-emerald-400 shrink-0" />
            ) : (
              <Info size={18} className="text-cyan-400 shrink-0" />
            )}
            <span className="text-xs font-medium text-slate-200">{statusMessage}</span>
          </div>

          {/* ШАГ 1: AI обработка в процессе */}
          {stage === 'step1_ai_and_norm' && (
            <div className="space-y-4 py-6 text-center animate-fadeIn">
              <div className="inline-flex p-4 bg-purple-500/10 border border-purple-500/20 rounded-full text-purple-400 animate-pulse">
                <Zap size={32} />
              </div>
              <div>
                <h4 className="text-sm font-bold text-slate-100">Выполняется авто-очистка и нормализация</h4>
                <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                  Последовательное применение денойза, дереверберации, реставрации спектра и выравнивания целевой громкости до -18 dBFS (EBU R128).
                </p>
              </div>
            </div>
          )}

          {/* ШАГ 2: Детекция коллизий и наездов фраз */}
          {stage === 'step2_collision_check' && (
            <div className="space-y-4 animate-fadeIn">
              {collisions.length > 0 ? (
                <div className="space-y-3">
                  <div className="p-4 bg-rose-950/40 border border-rose-500/40 rounded-2xl space-y-2">
                    <div className="flex items-center gap-2 text-rose-300 font-bold text-sm">
                      <AlertTriangle size={18} className="text-rose-400" />
                      <span>Обнаружены коллизии и наезды фраз ({collisions.length} шт.)</span>
                    </div>
                    <p className="text-xs text-rose-200/80">
                      Конвейер автоматически остановлен. Вы можете скорректировать наезжающие клипы вручную на таймлайне или продолжить сведение.
                    </p>
                  </div>

                  {/* Список коллизий */}
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {toSafeArray<ClipCollisionInfo>(collisions).map((col, idx) => (
                      <div
                        key={col.id}
                        className="p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs flex items-center justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                            <span>Конфликт #{idx + 1}: {col.trackAName} $\leftrightarrow$ {col.trackBName}</span>
                          </div>
                          <p className="text-[11px] text-slate-400">
                            Клип &quot;{col.clipAName}&quot; перекрывает &quot;{col.clipBName}&quot; на {col.overlapDurationSec.toFixed(2)} сек (с {col.overlapStartSec.toFixed(1)}s по {col.overlapEndSec.toFixed(1)}s).
                          </p>
                        </div>
                        <button
                          onClick={() => onSeek(col.overlapStartSec)}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded-lg text-[11px] font-medium transition-all shrink-0 cursor-pointer"
                        >
                          Перейти
                        </button>
                      </div>
                    ))}
                  </div>

                  {autoTimingSummary && (
                    <div className="p-3 bg-cyan-950/40 border border-cyan-500/40 rounded-xl text-xs text-cyan-200 flex items-center gap-2 animate-fadeIn">
                      <Zap size={15} className="text-cyan-400 shrink-0" />
                      <span>{autoTimingSummary}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <button
                      onClick={handleAutoTimingInWizard}
                      disabled={isAutoTimingRunning}
                      className="px-4 py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-lg shadow-cyan-950/40"
                      title="Автоматически сопоставить актёров, совместить фразы по субтитрам и устранить нежелательные наезды"
                    >
                      {isAutoTimingRunning ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />}
                      {isAutoTimingRunning ? 'Авто-разведение...' : '⚡ Авто-тайминг и разведение по сабам'}
                    </button>
                    <button
                      onClick={() => setIsMinimized(true)}
                      className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <Minimize2 size={14} />
                      Исправить на таймлайне
                    </button>
                    <button
                      onClick={handleRecheckCollisions}
                      className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <RefreshCw size={14} />
                      Перепроверить
                    </button>
                    <button
                      onClick={handleProceedToVolumeBalance}
                      className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-lg shadow-emerald-950/50"
                    >
                      Продолжить конвейер <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4 py-4 text-center">
                  <div className="inline-flex p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-emerald-400">
                    <CheckCircle2 size={28} />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-100">Наездов фраз не обнаружено!</h4>
                    <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                      Все дикторские дорожки расположена корректно без взаимных перекрытий.
                    </p>
                  </div>
                  <button
                    onClick={handleProceedToVolumeBalance}
                    className="w-full py-3 bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 text-white font-bold rounded-xl text-xs transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xl shadow-purple-950/50"
                  >
                    Перейти к калибровке громкости и Шине Вокала <ChevronRight size={16} />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ШАГ 3: Интерактивная калибровка громкости и Шина Вокала */}
          {stage === 'step3_volume_balance' && (
            <div className="space-y-5 animate-fadeIn">
              <div className="p-4 bg-cyan-950/30 border border-cyan-500/30 rounded-2xl space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Sliders size={14} />
                    Калибровка Баланса Громкости и Шина Вокала
                  </h4>
                  <button
                    onClick={onTogglePlay}
                    className="px-3 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
                  >
                    {isPlaying ? <Pause size={13} /> : <Play size={13} />}
                    {isPlaying ? 'Пауза' : 'Прослушать сведение'}
                  </button>
                </div>
                <p className="text-xs text-slate-300">
                  Проверьте общий баланс с начала записи. С помощью Шины Вокала подстройте уровень всех дикторов одновременно, а регуляторами дорожек подкорректируйте отдельный акцент.
                </p>
              </div>

              {/* БЛОК АВТОМАТИЧЕСКОГО ВЫРАВНИВАНИЯ ГРОМКОСТИ (СТАНДАРТ ЧИТАЕМОСТИ ЗАКАДРА +3.5..+4.5 dB) */}
              <div className="p-4 bg-[#0d1527] border border-cyan-500/40 rounded-2xl space-y-4 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-cyan-500/20 border border-cyan-500/30 rounded-lg text-cyan-400">
                      <Activity size={16} />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-slate-100 flex items-center gap-2">
                        Анализ и авто-выравнивание громкости
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-mono">
                          Стандарт: +{targetDeltaDb.toFixed(1)} dB
                        </span>
                      </h4>
                      <p className="text-[11px] text-slate-400">
                        Сравнение оригинальной дорожки и мастер-микса для кристальной читаемости речи
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => handleApplyAutoLoudness(targetDeltaDb)}
                    className="px-3 py-1.5 bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-500 hover:to-emerald-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all cursor-pointer shadow-lg shadow-cyan-950/50"
                  >
                    <Zap size={14} className="text-amber-300" />
                    Выровнять (+{targetDeltaDb.toFixed(1)} dB)
                  </button>
                </div>

                {/* Сетка замеров громкости: Оригинал vs Закадр vs Дельта */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono text-xs">
                  {/* Карточка 1: Оригинальная дорожка */}
                  <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1.5">
                    <div className="text-[10px] text-slate-400 uppercase font-sans font-bold flex items-center justify-between">
                      <span>Оригинал (Видео)</span>
                      <Film size={12} className="text-slate-500" />
                    </div>
                    <div className="text-sm font-bold text-slate-200">
                      {loudnessComparison.originalLoudness.speechRmsDb > -80
                        ? `${loudnessComparison.originalLoudness.speechRmsDb} dBFS`
                        : '—'}
                    </div>
                    <div className="text-[10px] text-slate-400 flex items-center justify-between">
                      <span>True Peak:</span>
                      <span className="text-slate-300">
                        {loudnessComparison.originalLoudness.peakDb > -80
                          ? `${loudnessComparison.originalLoudness.peakDb} dB`
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Карточка 2: Закадровый микс */}
                  <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1.5">
                    <div className="text-[10px] text-purple-400 uppercase font-sans font-bold flex items-center justify-between">
                      <span>Мастер-голос (Закадр)</span>
                      <Mic size={12} className="text-purple-400" />
                    </div>
                    <div className="text-sm font-bold text-purple-300">
                      {loudnessComparison.dubbedLoudness.speechRmsDb > -80
                        ? `${loudnessComparison.dubbedLoudness.speechRmsDb} dBFS`
                        : '—'}
                    </div>
                    <div className="text-[10px] text-slate-400 flex items-center justify-between">
                      <span>True Peak:</span>
                      <span
                        className={
                          loudnessComparison.isPeakSafe ? 'text-emerald-400' : 'text-amber-400'
                        }
                      >
                        {loudnessComparison.dubbedLoudness.peakDb > -80
                          ? `${loudnessComparison.dubbedLoudness.peakDb} dB`
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Карточка 3: Разница громкости */}
                  <div
                    className={`p-3 rounded-xl border space-y-1.5 ${
                      loudnessComparison.status === 'optimal'
                        ? 'bg-emerald-950/20 border-emerald-500/40 text-emerald-300'
                        : loudnessComparison.status === 'too_quiet'
                        ? 'bg-amber-950/20 border-amber-500/40 text-amber-300'
                        : 'bg-cyan-950/20 border-cyan-500/40 text-cyan-300'
                    }`}
                  >
                    <div className="text-[10px] uppercase font-sans font-bold flex items-center justify-between">
                      <span>Разница ($\Delta$)</span>
                      <Gauge size={12} />
                    </div>
                    <div className="text-sm font-bold">
                      {loudnessComparison.currentDeltaDb > 0 ? '+' : ''}
                      {loudnessComparison.currentDeltaDb} dB
                    </div>
                    <div className="text-[10px] flex items-center justify-between">
                      <span>Статус:</span>
                      <span className="font-sans font-medium text-[10px]">
                        {loudnessComparison.status === 'optimal'
                          ? 'Идеально'
                          : loudnessComparison.status === 'too_quiet'
                          ? 'Тише нормы'
                          : 'Громче нормы'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Подстройка целевого стандарта и опция авто-рендера */}
                <div className="space-y-2 pt-1 border-t border-slate-800/80">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 flex items-center gap-1.5 font-medium">
                      <SlidersHorizontal size={13} className="text-cyan-400" />
                      Целевое превышение над оригиналом:
                    </span>
                    <span className="font-mono font-bold text-cyan-400">+{targetDeltaDb.toFixed(1)} dB</span>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-mono text-slate-500">3.5 dB</span>
                    <input
                      type="range"
                      min="3.5"
                      max="4.5"
                      step="0.1"
                      value={targetDeltaDb}
                      onChange={(e) => setTargetDeltaDb(parseFloat(e.target.value))}
                      className="flex-1 accent-cyan-400 cursor-pointer"
                    />
                    <span className="text-[10px] font-mono text-slate-500">4.5 dB</span>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300 select-none">
                      <input
                        type="checkbox"
                        checked={autoAlignBeforeRender}
                        onChange={(e) => setAutoAlignBeforeRender(e.target.checked)}
                        className="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-0 cursor-pointer"
                      />
                      <span>Автоматически согласовать финальную громкость (+{targetDeltaDb.toFixed(1)} dB) перед рендером</span>
                    </label>
                    <span className="text-[10px] text-emerald-400 font-mono flex items-center gap-1">
                      <ShieldCheck size={12} /> Limiter -0.1 dB
                    </span>
                  </div>
                </div>
              </div>

              {/* Управление Шиной Вокала */}
              <div className="p-4 bg-[#111827] border border-slate-800 rounded-2xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-purple-300 flex items-center gap-1.5">
                    <Mic size={14} />
                    Шина вокала (Vocal Bus Master)
                  </span>
                  <span className="text-xs font-mono font-bold text-purple-400">
                    {(currentVocalBus?.volumeDb ?? 0) > 0
                      ? `+${(currentVocalBus?.volumeDb ?? 0).toFixed(1)}`
                      : (currentVocalBus?.volumeDb ?? 0).toFixed(1)}{' '}
                    dB
                  </span>
                </div>
                <input
                  type="range"
                  min="-24"
                  max="12"
                  step="0.5"
                  value={currentVocalBus?.volumeDb ?? 0}
                  onInput={(e) => {
                    const val = parseFloat((e.target as HTMLInputElement).value);
                    handleVocalBusVolumeChange(val);
                  }}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    handleVocalBusVolumeChange(val);
                  }}
                  className="w-full accent-purple-500 cursor-pointer"
                />
              </div>

              {/* Громкости отдельных дорожек */}
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Громкость индивидуальных дорожек:
                </span>
                {toSafeArray<TrackState>(tracks).map((track) => (
                  <div
                    key={track.id}
                    className="p-3 bg-slate-900 border border-slate-800 rounded-xl flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="font-medium text-slate-200 truncate w-36">{track.name}</span>
                    <input
                      type="range"
                      min="-30"
                      max="12"
                      step="0.5"
                      value={track.volumeDb}
                      onInput={(e) => {
                        const val = parseFloat((e.target as HTMLInputElement).value);
                        setTracks((prev) =>
                          toSafeArray<TrackState>(prev).map((t) => (t.id === track.id ? { ...t, volumeDb: val } : t))
                        );
                        if (onTrackVolumeChange) onTrackVolumeChange(track.id, val);
                      }}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        setTracks((prev) =>
                          toSafeArray<TrackState>(prev).map((t) => (t.id === track.id ? { ...t, volumeDb: val } : t))
                        );
                        if (onTrackVolumeChange) onTrackVolumeChange(track.id, val);
                      }}
                      className="flex-1 accent-cyan-500 cursor-pointer"
                    />
                    <span className="font-mono text-[11px] text-slate-400 w-14 text-right">
                      {track.volumeDb > 0 ? `+${track.volumeDb.toFixed(1)}` : track.volumeDb.toFixed(1)} dB
                    </span>
                  </div>
                ))}
              </div>

              <button
                onClick={handleProceedToFinalMasterAndMux}
                className="w-full py-3 bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-500 hover:to-emerald-500 text-white font-bold rounded-xl text-xs transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xl shadow-cyan-950/50"
              >
                <Sparkles size={16} className="text-amber-300" />
                Завершить сведение и зашить в видео
              </button>
            </div>
          )}

          {/* ШАГ 4: Финальный мастеринг и муксинг */}
          {stage === 'step4_master_and_mux' && (
            <div className="space-y-4 py-8 text-center animate-fadeIn">
              <div className="inline-flex p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-emerald-400 animate-spin">
                <RefreshCw size={32} />
              </div>
              <div>
                <h4 className="text-sm font-bold text-slate-100">Выполняется C++ рендеринг и вшивание в видео</h4>
                <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                  Применение лимитера мастер-шины (-0.1 dBFS), генерация RIFF WAV 48 кГц / 24-bit и подмена аудиопотока в видеофайле через FFmpeg WASM.
                </p>
              </div>
            </div>
          )}

          {/* ФИНАЛ: Завершено */}
          {stage === 'completed' && (
            <div className="space-y-5 animate-fadeIn text-center py-2">
              <div className="inline-flex p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-full text-emerald-400">
                <CheckCircle2 size={36} />
              </div>
              <div>
                <h4 className="text-base font-bold text-slate-100">Сведение закадрового видео успешно завершено!</h4>
                <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                  Готовый MP4 файл автоматически сохранен в подпапку <code className="text-emerald-300 font-mono">project/</code> вашего проекта.
                </p>
              </div>

              {resultVideoUrl && (
                <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl space-y-3 max-w-lg mx-auto">
                  <video src={resultVideoUrl} controls className="w-full rounded-xl bg-black max-h-48" />
                  <div className="flex items-center justify-between text-xs text-slate-300 pt-1">
                    <span className="truncate max-w-[200px] font-mono">{resultFileName}</span>
                    {resultBlob && (
                      <span className="text-slate-400">{(resultBlob.size / (1024 * 1024)).toFixed(2)} МБ</span>
                    )}
                  </div>
                  <a
                    href={resultVideoUrl}
                    download={resultFileName}
                    className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-emerald-950/50"
                  >
                    <Download size={15} />
                    Скачать готовое видео MP4
                  </a>
                </div>
              )}

              <button
                onClick={onClose}
                className="px-6 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition-all cursor-pointer"
              >
                Закрыть окно
              </button>
            </div>
          )}

          {/* ОШИБКА */}
          {stage === 'error' && (
            <div className="space-y-4 py-4 text-center">
              <div className="inline-flex p-3 bg-rose-500/10 border border-rose-500/20 rounded-full text-rose-400">
                <AlertTriangle size={28} />
              </div>
              <div>
                <h4 className="text-sm font-bold text-rose-300">Сбой выполнения конвейера</h4>
                <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">{errorMessage}</p>
              </div>
              <button
                onClick={startPipeline}
                className="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition-all inline-flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw size={14} />
                Повторить запуск
              </button>
            </div>
          )}

          {/* Логи конвейера */}
          {logs.length > 0 && (
            <div className="mt-4 pt-3 border-t border-slate-800/80 space-y-1">
              <span className="text-[10px] font-mono font-bold text-slate-500 uppercase">Лог операций:</span>
              <div className="p-2.5 bg-[#050811] border border-slate-800 rounded-xl font-mono text-[10px] text-slate-400 space-y-1 max-h-28 overflow-y-auto">
                {toSafeArray<string>(logs).map((log, i) => (
                  <div key={i}>{log}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
