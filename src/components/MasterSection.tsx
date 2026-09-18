import React from 'react';
import { MasterState } from '../audio/dawEngine';
import { Play, Pause, RotateCcw, ShieldCheck, AlertTriangle, Volume2, ShieldAlert } from 'lucide-react';

interface MasterSectionProps {
  master: MasterState;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onReset: () => void;
  onUpdateMaster: (updated: MasterState) => void;
}

export const MasterSection: React.FC<MasterSectionProps> = ({
  master,
  isPlaying,
  onTogglePlay,
  onReset,
  onUpdateMaster
}) => {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5 shadow-2xl">
      {/* Top Header & Transport */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <button
            onClick={onTogglePlay}
            className={`px-5 py-2.5 rounded-lg font-bold text-sm flex items-center gap-2 transition-all shadow-lg ${
              isPlaying
                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-500/20'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30'
            }`}
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            {isPlaying ? 'Пауза' : 'Воспроизведение'}
          </button>

          <button
            onClick={onReset}
            className="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
            title="Сброс позиции"
          >
            <RotateCcw size={18} />
          </button>
        </div>

        {/* Master Output Meter & Clip Warning */}
        <div className="flex items-center gap-4 bg-slate-950 px-4 py-2 rounded-lg border border-slate-800">
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] font-mono text-slate-400">
              <span>Master Peak</span>
              <span className={`font-bold ${master.clipped ? 'text-rose-500' : 'text-emerald-400'}`}>
                {Math.max(master.peakL, master.peakR) > 0.001
                  ? `${(20 * Math.log10(Math.max(master.peakL, master.peakR))).toFixed(1)} dB`
                  : '-inf'}
              </span>
            </div>

            <div className="w-36 space-y-1">
              <div className="h-2 bg-slate-900 rounded-full overflow-hidden flex">
                <div
                  className={`h-full transition-all duration-75 ${
                    master.peakL > 1.0 ? 'bg-rose-500' : 'bg-emerald-500'
                  }`}
                  style={{ width: `${Math.min(100, master.peakL * 100)}%` }}
                />
              </div>
              <div className="h-2 bg-slate-900 rounded-full overflow-hidden flex">
                <div
                  className={`h-full transition-all duration-75 ${
                    master.peakR > 1.0 ? 'bg-rose-500' : 'bg-emerald-500'
                  }`}
                  style={{ width: `${Math.min(100, master.peakR * 100)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Clip Alert Badge */}
          {master.clipped && !master.limiterEnabled ? (
            <div className="px-2.5 py-1 bg-rose-500/10 border border-rose-500/30 text-rose-400 rounded text-[11px] font-bold flex items-center gap-1 animate-pulse">
              <AlertTriangle size={14} /> CLIP!
            </div>
          ) : (
            <div className="px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded text-[11px] font-medium flex items-center gap-1">
              <ShieldCheck size={14} /> OK
            </div>
          )}
        </div>
      </div>

      {/* Master Controls */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
        {/* Master Fader */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-slate-300 font-bold">Master Volume</span>
            <span className="text-emerald-400 font-bold">{master.volumeDb.toFixed(1)} dB</span>
          </div>
          <input
            type="range"
            min={-36}
            max={12}
            step={0.5}
            value={master.volumeDb}
            onChange={(e) => onUpdateMaster({ ...master, volumeDb: parseFloat(e.target.value) })}
            className="w-full accent-emerald-500 bg-slate-800 h-2 rounded-lg appearance-none cursor-pointer"
          />
        </div>

        {/* Master Pan */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-slate-300 font-bold">Master Pan</span>
            <span className="text-cyan-400 font-bold">
              {master.pan === 0 ? 'Center' : master.pan < 0 ? `L${Math.round(Math.abs(master.pan * 100))}` : `R${Math.round(master.pan * 100)}`}
            </span>
          </div>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={master.pan}
            onChange={(e) => onUpdateMaster({ ...master, pan: parseFloat(e.target.value) })}
            className="w-full accent-cyan-500 bg-slate-800 h-2 rounded-lg appearance-none cursor-pointer"
          />
        </div>

        {/* Master Soft Limiter */}
        <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={master.limiterEnabled}
                onChange={(e) => onUpdateMaster({ ...master, limiterEnabled: e.target.checked })}
                className="accent-rose-500 rounded"
              />
              <ShieldCheck size={14} className="text-rose-400" />
              Soft Limiter (Master)
            </label>
            <span className="text-[10px] text-slate-400 font-mono">Ceiling: {master.limiterCeilingDb} dBFS</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            C++ функция tanh мягко скругляет пики сигналов свыше -0.1 dBFS, исключая цифровой клиппинг при выходе.
          </p>
        </div>
      </div>
    </div>
  );
};
