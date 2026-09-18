import React, { useState } from 'react';
import { Copy, Check, Download, Terminal, Cpu, ShieldCheck, Zap, Layers, FileCode } from 'lucide-react';

interface CppSourceCodeViewerProps {
  cppCode: string;
  buildScript: string;
}

export const CppSourceCodeViewer: React.FC<CppSourceCodeViewerProps> = ({ cppCode, buildScript }) => {
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedBuild, setCopiedBuild] = useState(false);
  const [copiedEmcc, setCopiedEmcc] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'source' | 'emcc' | 'arch'>('source');

  const emccCmd = `emcc -O3 -std=c++17 -msimd128 -flto --bind \\
  -s WASM=1 \\
  -s INITIAL_MEMORY=67108864 \\
  -s ALLOW_MEMORY_GROWTH=1 \\
  -s ENVIRONMENT=web,worker \\
  -s MODULARIZE=1 \\
  -s EXPORT_NAME="CreateDAWCoreModule" \\
  -s EXPORTED_FUNCTIONS='["_malloc", "_free"]' \\
  -s EXPORTED_RUNTIME_METHODS='["cwrap", "setValue", "getValue", "HEAPF32"]' \\
  daw_core.cpp -o public/wasm/daw_core.js`;

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
              C++17 DAW Core Engine
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                AudioWorklet / WASM SIMD
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Полный исходный C++ код с комментариями на русском языке (zero malloc in callback)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveSubTab('source')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeSubTab === 'source'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/30'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <FileCode size={14} /> C++ Source (daw_core.cpp)
          </button>
          <button
            onClick={() => setActiveSubTab('emcc')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeSubTab === 'emcc'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/30'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Terminal size={14} /> Emscripten Build Guide
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
      {activeSubTab === 'source' && (
        <div className="p-4 sm:p-6 space-y-4">
          <div className="flex items-center justify-between bg-slate-950 p-3 rounded-lg border border-slate-800">
            <div className="text-xs font-mono text-slate-400 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              src/cpp/daw_core.cpp ({cppCode.split('\n').length} lines, Standard C++17)
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => copyToClipboard(cppCode, setCopiedCode)}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-md transition-colors flex items-center gap-1.5"
              >
                {copiedCode ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                {copiedCode ? 'Скопировано!' : 'Копировать C++'}
              </button>
              <button
                onClick={() => downloadFile('daw_core.cpp', cppCode)}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-md font-medium transition-colors flex items-center gap-1.5 shadow-md shadow-emerald-900/20"
              >
                <Download size={14} />
                Скачать .cpp
              </button>
            </div>
          </div>

          <div className="bg-slate-950 rounded-xl border border-slate-800 p-4 font-mono text-xs overflow-x-auto text-slate-200 leading-relaxed max-h-[600px] overflow-y-auto">
            <pre className="whitespace-pre">
              {cppCode.split('\n').map((line, idx) => (
                <div key={idx} className="hover:bg-slate-900/80 px-2 py-0.5 rounded flex gap-4 group">
                  <span className="text-slate-600 select-none w-10 text-right shrink-0 font-mono text-[11px]">
                    {idx + 1}
                  </span>
                  <span className={`flex-1 ${
                    line.startsWith('//') || line.startsWith(' *') || line.startsWith('/*') || line.startsWith('/**')
                      ? 'text-slate-500 italic'
                      : line.includes('#include') || line.includes('#ifdef') || line.includes('#endif')
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
      )}

      {activeSubTab === 'emcc' && (
        <div className="p-6 space-y-6">
          <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <Terminal size={18} className="text-emerald-400" />
                Команда компиляции Emscripten (emcc)
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

          {/* Detailed explanation of flags */}
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
                <ShieldCheck size={14} /> Zero Dynamic Allocations
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Внутри метода <code className="text-cyan-300 font-mono">processBlock</code> используются заранее выделенные выравниваемые статические массивы (<code className="text-cyan-300 font-mono">alignas(16) std::array</code>). Это предотвращает Garbage Collection спайки и задержки в AudioWorklet.
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
              <h4 className="text-xs font-bold text-slate-200">Bash-скрипт авто-сборки (build_wasm.sh)</h4>
              <button
                onClick={() => copyToClipboard(buildScript, setCopiedBuild)}
                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded transition-colors flex items-center gap-1"
              >
                {copiedBuild ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                Скопировать .sh
              </button>
            </div>
            <div className="bg-slate-900 p-3 rounded-lg font-mono text-[11px] text-slate-300 overflow-x-auto border border-slate-800">
              <pre>{buildScript}</pre>
            </div>
          </div>
        </div>
      )}

      {activeSubTab === 'arch' && (
        <div className="p-6 space-y-6">
          <div className="p-5 bg-slate-950 rounded-xl border border-slate-800 space-y-4">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Cpu className="text-emerald-400" size={18} />
              Архитектура DAW Core и поток аудиосигнала
            </h3>

            {/* Signal Chain Diagram */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-2 text-center text-xs">
              <div className="p-3 bg-slate-900 border border-emerald-500/30 rounded-lg text-emerald-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 1</span>
                Clips Sum
                <span className="text-[10px] text-slate-400 font-normal">Constant Power Pan</span>
              </div>
              <div className="p-3 bg-slate-900 border border-blue-500/30 rounded-lg text-blue-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 2</span>
                3-Band EQ
                <span className="text-[10px] text-slate-400 font-normal">Biquad Filters</span>
              </div>
              <div className="p-3 bg-slate-900 border border-purple-500/30 rounded-lg text-purple-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 3</span>
                Compressor
                <span className="text-[10px] text-slate-400 font-normal">Soft-Knee Curve</span>
              </div>
              <div className="p-3 bg-slate-900 border border-amber-500/30 rounded-lg text-amber-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 4</span>
                Auto-Ducker
                <span className="text-[10px] text-slate-400 font-normal">Sidechain Detector</span>
              </div>
              <div className="p-3 bg-slate-900 border border-teal-500/30 rounded-lg text-teal-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 5</span>
                Master Summer
                <span className="text-[10px] text-slate-400 font-normal">Solo/Mute Bus</span>
              </div>
              <div className="p-3 bg-slate-900 border border-rose-500/30 rounded-lg text-rose-300 font-semibold flex flex-col justify-center items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase">Шаг 6</span>
                Soft Limiter
                <span className="text-[10px] text-slate-400 font-normal">Tanh Saturation</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-5 bg-slate-950 rounded-xl border border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider text-emerald-400">
                Гарантии памяти и времени
              </h4>
              <ul className="space-y-2 text-xs text-slate-300 list-disc list-inside leading-relaxed">
                <li><strong className="text-slate-100">Zero Dynamic Allocation:</strong> Никаких вызовов <code className="text-cyan-300">new</code>, <code className="text-cyan-300">malloc</code> или <code className="text-cyan-300">std::vector::resize</code> во время вызова коллбэка.</li>
                <li><strong className="text-slate-100">SIMD Vectorization Alignment:</strong> Рабочие скретч-буферы выровнены по 16 байт (<code className="text-cyan-300">alignas(16)</code>) для эффективной загрузки векторных регистров v128.</li>
                <li><strong className="text-slate-100">Continuous Interleaved Stereo:</strong> Единая последовательная память для снижения промахов кэша (Cache Misses).</li>
              </ul>
            </div>

            <div className="p-5 bg-slate-950 rounded-xl border border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider text-cyan-400">
                DSP Физика и Математика
              </h4>
              <ul className="space-y-2 text-xs text-slate-300 list-disc list-inside leading-relaxed">
                <li><strong className="text-slate-100">Biquad Filters:</strong> Формулы Роберта Бристоу-Джонсона (Audio EQ Cookbook) для LowShelf, Peaking, HighShelf.</li>
                <li><strong className="text-slate-100">Soft Knee Compressor:</strong> Квадратичная интерполяция переходной области колена для отсутствия резких кликов и гармонических искажений.</li>
                <li><strong className="text-slate-100">Soft Limiter:</strong> Гиперболический тангенс (tanh) и кубическая сглаженная сатурация пиков свыше -0.1 dBFS.</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
