import React, { useState, useEffect } from 'react';
import { Sliders, Cpu, Terminal, Sparkles, Volume2, FolderKanban, PlaySquare, AlertCircle, Upload, Plus } from 'lucide-react';
import { systemLogger } from '../services/SystemLogger';

export type NavigationTab = 'minimal' | 'studio' | 'project' | 'video' | 'ai-dubbing' | 'export' | 'cpp' | 'emcc' | 'console';

interface HeaderProps {
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  onOpenImportModal?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, onSelectTab, onOpenImportModal }) => {
  const [errorCount, setErrorCount] = useState<number>(() => systemLogger.getErrorsCount());

  useEffect(() => {
    const unsub = systemLogger.subscribe(() => {
      setErrorCount(systemLogger.getErrorsCount());
    });
    return unsub;
  }, []);
  return (
    <header className="bg-slate-950 border-b border-slate-800 sticky top-0 z-50 backdrop-blur-md bg-opacity-90">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-col xl:flex-row items-center justify-between gap-4">
        {/* Title & Badge */}
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 border border-emerald-500/30 rounded-xl text-emerald-400 shadow-lg shadow-emerald-500/10">
            <Sliders size={22} />
          </div>
          <div>
            <h1 className="text-base sm:text-lg font-bold text-slate-100 flex items-center gap-2">
              VOMIXStudio
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono font-semibold">
                C++ WASM / FFmpeg / ONNX
              </span>
            </h1>
            <p className="text-xs text-slate-400">
              Низкоуровневое C++ аудиоядро + Синхронизация видео, субтитры и FFmpeg WASM муксинг
            </p>
          </div>
        </div>

        {/* Action Controls & Navigation */}
        <div className="flex flex-wrap items-center gap-2.5">
          {onOpenImportModal && (
            <button
              id="btn-header-media-import"
              onClick={onOpenImportModal}
              className="px-3 py-1.5 bg-gradient-to-r from-cyan-900/70 to-emerald-900/70 hover:from-cyan-800 hover:to-emerald-800 text-cyan-300 border border-cyan-700/80 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer shadow-md shadow-cyan-950/40"
              title="Открыть универсальный хаб импорта файлов (видео, аудио, субтитры)"
            >
              <Upload size={14} className="text-cyan-400" />
              <span>Импорт медиа</span>
            </button>
          )}

          {/* Tab Navigation */}
          <nav className="flex flex-wrap items-center gap-1.5 bg-slate-900 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => onSelectTab('minimal')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'minimal'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <PlaySquare size={14} />
            MVP Пайплайн
          </button>

          <button
            onClick={() => onSelectTab('studio')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'studio'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Volume2 size={14} />
            DAW Микшер
          </button>

          <button
            onClick={() => onSelectTab('project')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'project'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FolderKanban size={14} />
            Проект (FS API)
          </button>

          <button
            onClick={() => onSelectTab('video')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'video'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sliders size={14} />
            Видео-монитор
          </button>

          <button
            onClick={() => onSelectTab('ai-dubbing')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'ai-dubbing'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sparkles size={14} />
            AI Дубляж & VAD
          </button>

          <button
            onClick={() => onSelectTab('export')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'export'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu size={14} />
            Экспорт & FFmpeg
          </button>

          <button
            onClick={() => onSelectTab('cpp')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'cpp'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu size={14} />
            C++ Ядро
          </button>

          <button
            onClick={() => onSelectTab('emcc')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'emcc'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal size={14} />
            Скрипт Emcc
          </button>

          <button
            onClick={() => onSelectTab('console')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'console'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                : errorCount > 0
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal size={14} className={errorCount > 0 ? 'text-rose-400 animate-pulse' : ''} />
            Логи & Консоль
            {errorCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-rose-600 text-white text-[10px] font-bold">
                {errorCount}
              </span>
            )}
          </button>
        </nav>
        </div>
      </div>
    </header>
  );
};

