import React from 'react';
import { Sliders, Cpu, Terminal, Sparkles, Volume2, FolderKanban, PlaySquare } from 'lucide-react';

export type NavigationTab = 'minimal' | 'studio' | 'project' | 'video' | 'ai-dubbing' | 'export' | 'cpp' | 'emcc';

interface HeaderProps {
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, onSelectTab }) => {
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
        </nav>
      </div>
    </header>
  );
};

