import React, { useState, useEffect } from 'react';
import { systemLogger, LogEntry } from '../services/SystemLogger';
import { LogConsole } from './LogConsole';
import { Terminal, AlertCircle, ChevronUp, ChevronDown, Activity } from 'lucide-react';

interface ConsoleStatusBarProps {
  isWorkletActive?: boolean;
  isAudioInitialized?: boolean;
}

/**
 * Компактная и элегантная статусная строка в стиле Studio One / Logic Pro
 * Объединяет жизненно важные индикаторы звукового ядра, задержки, WASM и логов.
 */
export const ConsoleStatusBar: React.FC<ConsoleStatusBarProps> = ({
  isWorkletActive = true,
  isAudioInitialized = true
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>(() => systemLogger.getLogs());
  const [lastError, setLastError] = useState<LogEntry | null>(null);

  useEffect(() => {
    const unsubscribe = systemLogger.subscribe((allLogs, newEntry) => {
      setLogs([...allLogs]);
      if (newEntry && newEntry.level === 'error') {
        setLastError(newEntry);
      }
    });
    return unsubscribe;
  }, []);

  // Горячая клавиша для открытия/закрытия консоли (тильда `~` / `ё` или Escape)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '`' || e.key === 'ё' || e.key === '~') {
        const target = e.target as HTMLElement;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
          return;
        }
        e.preventDefault();
        setIsOpen((prev) => !prev);
      } else if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const errorCount = systemLogger.getErrorsCount();
  const warnCount = systemLogger.getWarningsCount();

  const isEngineReady = Boolean(isWorkletActive || isAudioInitialized);

  return (
    <>
      {/* Slide-up консольный Drawer при клике на ошибки/консоль */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm animate-fadeIn">
          <div
            className="flex-1"
            onClick={() => setIsOpen(false)}
            title="Нажмите, чтобы свернуть консоль"
          />
          <div className="w-full max-w-7xl mx-auto px-4 pb-2 h-[65vh] min-h-[400px]">
            <LogConsole isDrawer={true} onClose={() => setIsOpen(false)} />
          </div>
        </div>
      )}

      {/* Однострочная компактная панель состояния */}
      <div className="sticky bottom-0 z-40 bg-[#070a12] border-t border-slate-800/80 px-3 py-1 flex items-center justify-between text-[11px] font-mono text-slate-400 select-none shrink-0 h-7">
        {/* Левая часть: Системная консоль и индикатор ошибок */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsOpen((prev) => !prev)}
            className={`px-2 py-0.5 rounded border text-[11px] font-medium flex items-center gap-1.5 transition-colors ${
              errorCount > 0
                ? 'bg-rose-500/20 border-rose-500/40 text-rose-300 hover:bg-rose-500/30 animate-pulse'
                : warnCount > 0
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20'
                : 'bg-slate-900/80 border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
            title="Открыть системную консоль (горячая клавиша ~)"
          >
            <Terminal size={12} className={errorCount > 0 ? 'text-rose-400' : 'text-emerald-400'} />
            <span className="hidden sm:inline">Консоль</span>

            {/* Мини-бейдж ошибок или предупреждений */}
            {errorCount > 0 ? (
              <span className="px-1 py-0.2 rounded bg-rose-600 text-white text-[10px] font-bold">
                [{errorCount} {errorCount === 1 ? 'ошибка' : errorCount < 5 ? 'ошибки' : 'ошибок'}]
              </span>
            ) : warnCount > 0 ? (
              <span className="px-1 py-0.2 rounded bg-amber-600/80 text-amber-200 text-[10px] font-semibold">
                [{warnCount} пред.]
              </span>
            ) : null}

            {isOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>

          {/* Превью последней ошибки при наличии */}
          {errorCount > 0 && lastError && !isOpen && (
            <div
              onClick={() => setIsOpen(true)}
              className="hidden md:flex items-center gap-1.5 text-rose-400 text-[10px] max-w-xs truncate cursor-pointer hover:underline bg-rose-950/30 px-2 py-0.5 rounded border border-rose-900/40"
            >
              <AlertCircle size={11} className="shrink-0" />
              <span className="truncate">{lastError.message}</span>
            </div>
          )}
        </div>

        {/* Центральная часть: Компактные статус-бейджи аудио-движка */}
        <div className="flex items-center gap-3">
          {/* Индикатор статуса Audio Engine */}
          <div className="flex items-center gap-1.5" title="Статус аудио-движка AudioWorklet">
            <span
              className={`w-2 h-2 rounded-full ${
                isEngineReady
                  ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
                  : 'bg-slate-500'
              }`}
            />
            <span className="text-slate-300 font-medium">
              Audio Engine: {isEngineReady ? 'Ready' : 'Offline'}
            </span>
          </div>

          <span className="text-slate-700">•</span>

          {/* Теги аппаратных технологий WASM / WebGPU */}
          <div className="flex items-center gap-1">
            <span className="px-1.5 py-0.2 rounded bg-cyan-950/60 border border-cyan-800/40 text-cyan-300 text-[10px] font-semibold">
              WASM SIMD
            </span>
            <span className="hidden sm:inline-block px-1.5 py-0.2 rounded bg-indigo-950/60 border border-indigo-800/40 text-indigo-300 text-[10px] font-semibold">
              WebGPU
            </span>
          </div>

          <span className="text-slate-700 hidden sm:inline">•</span>

          {/* Размер буфера и задержка */}
          <div className="hidden sm:flex items-center gap-1 text-slate-400">
            <Activity size={11} className="text-emerald-400" />
            <span>128 spl • 2.67ms</span>
          </div>
        </div>

        {/* Правая часть: Горячая клавиша */}
        <div className="hidden lg:flex items-center gap-1 text-slate-500 text-[10px]">
          <span>Консоль:</span>
          <kbd className="px-1 py-0.2 bg-slate-900 border border-slate-800 rounded text-slate-400 font-semibold">
            ~
          </kbd>
        </div>
      </div>
    </>
  );
};
