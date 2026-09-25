import React, { useState } from 'react';
import { Copy, Check, Download, Terminal, Cpu, ShieldCheck, Zap, Layers, FileCode, FolderTree, Folder } from 'lucide-react';
import { CPP_FILES_METADATA } from '../data/cppModules';
import { MODULAR_CPP_SOURCES } from '../data/cppModulesCode';

interface CppSourceCodeViewerProps {
  cppCode: string;
  buildScript: string;
}

export const CppSourceCodeViewer: React.FC<CppSourceCodeViewerProps> = ({ cppCode, buildScript }) => {
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedBuild, setCopiedBuild] = useState(false);
  const [copiedEmcc, setCopiedEmcc] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'modular' | 'emcc' | 'arch'>('modular');
  const [selectedFilePath, setSelectedFilePath] = useState<string>('engine/Mixer.hpp');

  const emccCmd = `emcc -O3 -std=c++17 -msimd128 -flto --bind \\
  -I. \\
  -s WASM=1 \\
  -s INITIAL_MEMORY=134217728 \\
  -s MAXIMUM_MEMORY=1073741824 \\
  -s ALLOW_MEMORY_GROWTH=1 \\
  -s ENVIRONMENT=web,worker \\
  -s MODULARIZE=1 \\
  -s EXPORT_NAME="CreateDAWCoreModule" \\
  -s EXPORTED_FUNCTIONS='["_malloc", "_free"]' \\
  -s EXPORTED_RUNTIME_METHODS='["cwrap", "setValue", "getValue", "HEAPF32"]' \\
  dsp/BiquadFilter.cpp \\
  dsp/Dynamics.cpp \\
  dsp/AudioUtils.cpp \\
  vocal/VocalRack.cpp \\
  engine/Clip.cpp \\
  engine/Track.cpp \\
  engine/Mixer.cpp \\
  editing/WSOLATimeStretch.cpp \\
  editing/ClipEditor.cpp \\
  analysis/SpeechAligner.cpp \\
  bindings/EmscriptenBindings.cpp \\
  -o public/wasm/daw_core.js`;

  const currentSourceCode = MODULAR_CPP_SOURCES[selectedFilePath] || cppCode;
  const currentFileMeta = CPP_FILES_METADATA.find(f => f.path === selectedFilePath);

  const copyToClipboard = (text: string, setFn: (v: boolean) => void) => {
    navigator.clipboard.writeText(text);
    setFn(true);
    setTimeout(() => setFn(false), 2000);
  };

  const downloadFile = (filename: string, content: string) => {
    const element = document.createElement('a');
    const file = new Blob([content], { type: 'text/plain;charset=utf-8' });
    element.href = URL.createObjectURL(file);
    element.download = filename;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
      {/* Top Bar */}
      <div className="bg-slate-950 px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400">
            <FileCode size={20} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              C++17 Modular Audio Engine
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                AudioWorklet / WASM SIMD128
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Модульная архитектура: Zero-Alloc RT расчетные циклы, Audio EQ Cookbook, Vocal Rack DSP
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveSubTab('modular')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeSubTab === 'modular'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/30'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <FolderTree size={14} /> Модули C++17
          </button>
          <button
            onClick={() => setActiveSubTab('emcc')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeSubTab === 'emcc'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/30'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Terminal size={14} /> CMake & Emscripten
          </button>
          <button
            onClick={() => setActiveSubTab('arch')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeSubTab === 'arch'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/30'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Cpu size={14} /> Architecture & SIMD
          </button>
        </div>
      </div>

      {/* Main Content View */}
      {activeSubTab === 'modular' && (
        <div className="p-4 sm:p-6 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* File Explorer Sidebar */}
            <div className="lg:col-span-1 bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-3">
              <div className="text-xs font-bold text-slate-300 flex items-center gap-1.5 pb-2 border-b border-slate-800">
                <Folder size={14} className="text-emerald-400" /> Файловая структура (src/cpp/)
              </div>

              <div className="space-y-1 max-h-[540px] overflow-y-auto pr-1">
                {(['dsp', 'vocal', 'engine', 'editing', 'analysis', 'bindings', 'build'] as const).map(cat => {
                  const items = CPP_FILES_METADATA.filter(f => f.category === cat);
                  const catTitle = cat === 'dsp' ? 'DSP Модули' : cat === 'vocal' ? 'Vocal Rack DSP' : cat === 'engine' ? 'Audio Engine' : cat === 'editing' ? 'Монтаж & WSOLA' : cat === 'analysis' ? 'Анализ речи & VAD' : cat === 'bindings' ? 'WASM Embind' : 'Сборка (CMake/Bash)';
                  return (
                    <div key={cat} className="space-y-1 pt-1">
                      <div className="text-[10px] uppercase font-bold text-slate-500 px-2 py-0.5 tracking-wider">
                        {catTitle}
                      </div>
                      {items.map(item => (
                        <button
                          key={item.path}
                          onClick={() => setSelectedFilePath(item.path)}
                          className={`w-full text-left px-2 py-1.5 rounded text-xs font-mono transition-colors flex items-center justify-between group ${
                            selectedFilePath === item.path
                              ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 font-semibold'
                              : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                          }`}
                        >
                          <span className="truncate">{item.name}</span>
                          <span className="text-[10px] text-slate-600 group-hover:text-slate-500 shrink-0">
                            {item.path.endsWith('.hpp') ? 'HPP' : item.path.endsWith('.cpp') ? 'CPP' : item.path.endsWith('.txt') ? 'CMAKE' : 'SH'}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Code Display Area */}
            <div className="lg:col-span-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between bg-slate-950 p-3 rounded-lg border border-slate-800 gap-2">
                <div>
                  <div className="text-xs font-mono text-slate-300 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    src/cpp/{selectedFilePath}
                    <span className="text-[11px] text-slate-500">
                      ({currentSourceCode.split('\n').length} строк)
                    </span>
                  </div>
                  {currentFileMeta && (
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {currentFileMeta.description}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => copyToClipboard(currentSourceCode, setCopiedCode)}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-md transition-colors flex items-center gap-1.5"
                  >
                    {copiedCode ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    {copiedCode ? 'Скопировано!' : 'Копировать файл'}
                  </button>
                  <button
                    onClick={() => downloadFile(currentFileMeta?.name || 'file.cpp', currentSourceCode)}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-md font-medium transition-colors flex items-center gap-1.5 shadow-md shadow-emerald-900/20"
                  >
                    <Download size={14} />
                    Скачать
                  </button>
                </div>
              </div>

              <div className="bg-slate-950 rounded-xl border border-slate-800 p-4 font-mono text-xs overflow-x-auto text-slate-200 leading-relaxed max-h-[500px] overflow-y-auto">
                <pre className="whitespace-pre">
                  {currentSourceCode.split('\n').map((line, idx) => (
                    <div key={idx} className="hover:bg-slate-900/80 px-2 py-0.5 rounded flex gap-4 group">
                      <span className="text-slate-600 select-none w-10 text-right shrink-0 font-mono text-[11px]">
                        {idx + 1}
                      </span>
                      <span className={`flex-1 ${
                        line.startsWith('//') || line.startsWith(' *') || line.startsWith('/*') || line.startsWith('/**')
                          ? 'text-slate-500 italic'
                          : line.includes('#include') || line.includes('#ifdef') || line.includes('#endif') || line.includes('cmake_minimum_required')
                          ? 'text-purple-400 font-semibold'
                          : line.includes('class ') || line.includes('struct ') || line.includes('enum ')
                          ? 'text-amber-300 font-bold'
                          : line.includes('float') || line.includes('size_t') || line.includes('bool') || line.includes('uint32_t')
                          ? 'text-cyan-400'
                          : line.includes('processBlock') || line.includes('processBuffer') || line.includes('updateCoefficients')
                          ? 'text-emerald-300'
                          : 'text-slate-200'
                      }`}>
                        {line}
                      </span>
                    </div>
                  ))}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeSubTab === 'emcc' && (
        <div className="p-6 space-y-6">
          <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <Terminal size={18} className="text-emerald-400" />
                Модульная команда компиляции Emscripten (emcc)
              </h3>
              <button
                onClick={() => copyToClipboard(emccCmd, setCopiedEmcc)}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg transition-colors flex items-center gap-1.5 font-medium"
              >
                {copiedEmcc ? <Check size={14} /> : <Copy size={14} />}
                {copiedEmcc ? 'Скопировано' : 'Скопировать emcc'}
              </button>
            </div>

            <div className="bg-slate-900 p-4 rounded-lg font-mono text-xs text-emerald-300 overflow-x-auto border border-slate-800 leading-relaxed">
              <pre>{emccCmd}</pre>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-slate-950/60 rounded-xl border border-slate-800/80 space-y-2">
              <div className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                <Zap size={14} /> -msimd128 (WebAssembly SIMD)
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Активирует 128-битные векторные инструкции WASM. Компилятор авто-векторизует циклы суммирования сэмплов клипов и панорамирования, выполняя по 4 математических операции над float32 одновременно.
              </p>
            </div>

            <div className="p-4 bg-slate-950/60 rounded-xl border border-slate-800/80 space-y-2">
              <div className="text-xs font-bold text-cyan-400 flex items-center gap-1.5">
                <ShieldCheck size={14} /> Zero Dynamic Allocations (RT-Safe)
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Внутри методов <code className="text-cyan-300 font-mono">processBlock</code> и <code className="text-cyan-300 font-mono">renderClipsToBuffer</code> используются заранее выделенные выравниваемые статические массивы (<code className="text-cyan-300 font-mono">alignas(16)</code>). Это предотвращает Garbage Collection спайки и задержки в AudioWorklet.
              </p>
            </div>

            <div className="p-4 bg-slate-950/60 rounded-xl border border-slate-800/80 space-y-2">
              <div className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                <Layers size={14} /> --bind (Emscripten embind)
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Генерирует биндинги C++ классов (Mixer, Track, BiquadFilter, SoftKneeCompressor, AutoDucker) напрямую для JavaScript, с поддержкой передач указателей на память без копирования.
              </p>
            </div>

            <div className="p-4 bg-slate-950/60 rounded-xl border border-slate-800/80 space-y-2">
              <div className="text-xs font-bold text-purple-400 flex items-center gap-1.5">
                <Cpu size={14} /> -O3 & -flto
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Link-Time Optimization (LTO) и уровень O3 обеспечивают максимальное встраивание (inlining) Biquad уравнений разности и экспоненциальных фильтров огибающей.
              </p>
            </div>
          </div>

          <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-200">CMake сборка (src/cpp/CMakeLists.txt)</h4>
              <button
                onClick={() => copyToClipboard(MODULAR_CPP_SOURCES['CMakeLists.txt'], setCopiedBuild)}
                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded transition-colors flex items-center gap-1"
              >
                {copiedBuild ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                Скопировать CMakeLists.txt
              </button>
            </div>
            <div className="bg-slate-900 p-3 rounded-lg font-mono text-[11px] text-slate-300 overflow-x-auto border border-slate-800">
              <pre>{MODULAR_CPP_SOURCES['CMakeLists.txt']}</pre>
            </div>
          </div>
        </div>
      )}

      {activeSubTab === 'arch' && (
        <div className="p-6 space-y-6">
          <div className="p-5 bg-slate-950 rounded-xl border border-slate-800 space-y-4">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Cpu className="text-emerald-400" size={18} />
              Архитектура модульного DAW Core и поток аудиосигнала
            </h3>

            {/* Signal Chain Diagram */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-7 gap-2 text-center text-xs">
              <div className="p-2.5 bg-slate-900 border border-emerald-500/30 rounded-lg text-emerald-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 1</span>
                DeClicker
                <span className="text-[10px] text-slate-400 font-normal">Hermite Spline</span>
              </div>
              <div className="p-2.5 bg-slate-900 border border-blue-500/30 rounded-lg text-blue-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 2</span>
                DePlosive
                <span className="text-[10px] text-slate-400 font-normal">Sub-Bass Sidechain</span>
              </div>
              <div className="p-2.5 bg-slate-900 border border-teal-500/30 rounded-lg text-teal-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 3</span>
                NoiseGate
                <span className="text-[10px] text-slate-400 font-normal">FSM 5-States</span>
              </div>
              <div className="p-2.5 bg-slate-900 border border-indigo-500/30 rounded-lg text-indigo-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 4</span>
                3-Band EQ
                <span className="text-[10px] text-slate-400 font-normal">Cookbook Biquads</span>
              </div>
              <div className="p-2.5 bg-slate-900 border border-purple-500/30 rounded-lg text-purple-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 5</span>
                DeEsser
                <span className="text-[10px] text-slate-400 font-normal">BPF VCA Comp</span>
              </div>
              <div className="p-2.5 bg-slate-900 border border-amber-500/30 rounded-lg text-amber-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 6</span>
                Compressor
                <span className="text-[10px] text-slate-400 font-normal">Soft-Knee Quad</span>
              </div>
              <div className="p-2.5 bg-slate-900 border border-rose-500/30 rounded-lg text-rose-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 7</span>
                Master Limiter
                <span className="text-[10px] text-slate-400 font-normal">Tanh Saturation</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-5 bg-slate-950 rounded-xl border border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider text-emerald-400">
                Гарантии памяти и Real-Time безопасности
              </h4>
              <ul className="space-y-2 text-xs text-slate-300 list-disc list-inside leading-relaxed">
                <li><strong className="text-slate-100">Zero Dynamic Allocation (RT-Safe):</strong> Никаких вызовов <code className="text-cyan-300">new</code>, <code className="text-cyan-300">malloc</code> или динамических аллокаций во время вызова коллбэка расчета аудио.</li>
                <li><strong className="text-slate-100">WASM SIMD128 Alignment:</strong> Рабочие буферы выровнены по 16 байт (<code className="text-cyan-300">alignas(16)</code>) для эффективной загрузки векторных регистров v128.</li>
                <li><strong className="text-slate-100">Continuous Interleaved Stereo:</strong> Единая последовательная память для снижения промахов кэша (Cache Misses).</li>
              </ul>
            </div>

            <div className="p-5 bg-slate-950 rounded-xl border border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider text-cyan-400">
                DSP Физика и Математика
              </h4>
              <ul className="space-y-2 text-xs text-slate-300 list-disc list-inside leading-relaxed">
                <li><strong className="text-slate-100">Biquad Filters:</strong> Формулы Роберта Бристоу-Джонсона (Audio EQ Cookbook) для LowShelf, Peaking, HighShelf, HighPass, LowPass.</li>
                <li><strong className="text-slate-100">DeClicker & DePlosive:</strong> Детекция 2-й производной, кубический сплайн Hermite и динамический суббасовый сайдчейн.</li>
                <li><strong className="text-slate-100">Soft Knee Compressor:</strong> Квадратичная интерполяция переходной области колена для отсутствия резких кликов и гармонических искажений.</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
