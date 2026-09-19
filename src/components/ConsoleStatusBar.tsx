import React, { useState, useEffect } from 'react';
import { systemLogger, LogEntry } from '../services/SystemLogger';
import { LogConsole } from './LogConsole';
import {
  Terminal,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronUp,
  ChevronDown,
  Activity,
  Cpu
} from 'lucide-react';

interface ConsoleStatusBarProps {
  isWorkletActive?: boolean;
  isAudioInitialized?: boolean;
}

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

  // Горячая клавиша для открытия/закрытия консоли (тильда `~` / `ё` или F12 / Escape)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Тильда (Backquote) при фокусе не в текстовом поле
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

  return (
    <>
      {/* 1. Всплывающий Drawer консоли (Slide-up modal/drawer) */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm animate-fadeIn">
          <div
            className="flex-1"
            onClick={() => setIsOpen(false)}
            title="Нажмите чтобы свернуть консоль"
          />
          <div className="w-full max-w-7xl mx-auto px-4 pb-2 h-[70vh] min-h-[450px]">
            <LogConsole isDrawer={true} onClose={() => setIsOpen(false)} />
          </div>
        </div>
      )}

      {/* 2. Постоянная полоса статуса внизу экрана (Docked Status Bar) */}
      <div className="sticky bottom-0 z-40 bg-[#090d16]/95 border-t border-slate-800 backdrop-blur-md px-4 py-1.5 flex items-center justify-between text-xs font-mono select-none">
        <div className="flex items-center gap-3">
          {/* Кнопка открытия консоли */}
          <button
            onClick={() => setIsOpen((prev) => !prev)}
            className={`px-2.5 py-1 rounded-lg border text-xs font-semibold flex items-center gap-2 transition shadow-sm ${
              errorCount > 0
                ? 'bg-rose-500/20 border-rose-500/40 text-rose-300 hover:bg-rose-500/30 animate-pulse'
                : warnCount > 0
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 hover:bg-amber-500/30'
                : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
            title="Открыть системную консоль и журнал ошибок (горячая клавиша ~)"
          >
            <Terminal size={14} className={errorCount > 0 ? 'text-rose-400' : 'text-emerald-400'} />
            <span>Консоль & Логи</span>

            {/* Счетчики */}
            {errorCount > 0 ? (
              <span className="px-1.5 py-0.2 rounded bg-rose-600 text-white text-[10px] font-bold">
                {errorCount} {errorCount === 1 ? 'ошибка' : 'ошибок'}
              </span>
            ) : warnCount > 0 ? (
              <span className="px-1.5 py-0.2 rounded bg-amber-600 text-white text-[10px] font-bold">
                {warnCount} пред.
              </span>
            ) : (
              <span className="text-[10px] text-slate-500">[{logs.length}]</span>
            )}

            {isOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>

          {/* Быстрый вывод последней ошибки */}
          {errorCount > 0 && lastError && !isOpen && (
            <div
              onClick={() => setIsOpen(true)}
              className="hidden sm:flex items-center gap-2 text-rose-400 text-[11px] max-w-md truncate cursor-pointer hover:underline bg-rose-950/40 px-2 py-0.5 rounded border border-rose-900/50"
            >
              <AlertCircle size={13} className="shrink-0" />
              <span className="font-semibold shrink-0">[{lastError.source}]:</span>
              <span className="truncate">{lastError.message}</span>
            </div>
          )}
        </div>

        {/* Статус подсистем справа */}
        <div className="flex items-center gap-4 text-[11px] text-slate-400">
          <div className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${
                isWorkletActive ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50' : 'bg-rose-500'
              }`}
            />
            <span className="hidden md:inline">AudioWorklet:</span>
            <span className={isWorkletActive ? 'text-slate-200' : 'text-rose-400 font-bold'}>
              {isWorkletActive ? 'Active' : 'Fallback'}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <Cpu size={12} className="text-cyan-400" />
            <span className="hidden md:inline">C++ WASM:</span>
            <span className="text-cyan-300">48kHz SIMD</span>
          </div>

          <div className="hidden lg:flex items-center gap-1 text-slate-500 text-[10px]">
            <span>Горячая клавиша:</span>
            <kbd className="px-1.5 py-0.5 bg-slate-800 border border-slate-700 rounded text-slate-300">
              ~
            </kbd>
          </div>
        </div>
      </div>
    </>
  );
};
