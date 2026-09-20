import React, { useState } from 'react';
import { MasterState } from '../audio/dawEngine';
import { VSTPluginInstance } from '../audio/vstTypes';
import { VSTRackSlot } from './VSTRackSlot';
import { Play, Pause, RotateCcw, Volume2, ShieldCheck, Activity, Layers, Sliders } from 'lucide-react';

interface MasterSectionProps {
  master: MasterState;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onReset: () => void;
  onUpdateMaster: (updated: MasterState) => void;
  onUpdateVstChain?: (vstPlugins: VSTPluginInstance[]) => void;
  onUpdateVstParam?: (instanceId: string, paramId: string, value: number) => void;
  onUpdateVstBypass?: (instanceId: string, enabled: boolean) => void;
  onUpdateVstWetDry?: (instanceId: string, wetDry: number) => void;
}

export const MasterSection: React.FC<MasterSectionProps> = ({
  master,
  isPlaying,
  onTogglePlay,
  onReset,
  onUpdateMaster,
  onUpdateVstChain,
  onUpdateVstParam,
  onUpdateVstBypass,
  onUpdateVstWetDry
}) => {
  const peakLevel = Math.max(master.peakL || 0, master.peakR || 0);
  const peakDb = peakLevel > 1e-4 ? 20 * Math.log10(peakLevel) : -120;

  return (
    <div className="bg-[#0f1422] border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl space-y-4">
      {/* Header & Transport */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2.5 rounded-xl bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 shadow-md">
            <Volume2 size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white tracking-wide">Master Output (2ch Stereo)</h3>
              {master.vstPlugins && master.vstPlugins.length > 0 && (
                <span className="px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 rounded-full border border-emerald-500/30 flex items-center gap-1">
                  <Layers size={10} /> {master.vstPlugins.length} VST
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400">
              Суммирование шин, мастер-лимитер tanh и финальные мастеринг-плагины
            </p>
          </div>
        </div>

        {/* Playback Controls & Master Meter Display */}
        <div className="flex items-center gap-3 bg-slate-950 px-3.5 py-1.5 rounded-xl border border-slate-800">
          <div className="flex items-center gap-1.5">
            <button
              onClick={onTogglePlay}
              className="p-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors cursor-pointer"
              title={isPlaying ? 'Пауза' : 'Воспроизведение'}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              onClick={onReset}
              className="p-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg transition-colors cursor-pointer border border-slate-800"
              title="В начало"
            >
              <RotateCcw size={14} />
            </button>
          </div>

          <div className="text-right">
            <div className="text-[10px] text-slate-400 font-mono">Master Peak</div>
            <div className={`text-xs font-mono font-bold ${master.clipped ? 'text-rose-400 animate-pulse' : peakDb > -0.5 ? 'text-amber-400' : 'text-emerald-400'}`}>
              {peakDb > -90 ? `${peakDb.toFixed(1)} dB` : '-inf'}
            </div>
          </div>

          <div className="w-24 space-y-1">
            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-75 ${
                  (master.peakL || 0) > 0.999 ? 'bg-rose-500' : (master.peakL || 0) > 0.7 ? 'bg-amber-400' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, (master.peakL || 0) * 100)}%` }}
              />
            </div>
            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-75 ${
                  (master.peakR || 0) > 0.999 ? 'bg-rose-500' : (master.peakR || 0) > 0.7 ? 'bg-amber-400' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, (master.peakR || 0) * 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Main Master Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-800/60">
        {/* Master Volume */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-slate-400">Master Fader</span>
            <span className="text-emerald-400 font-bold">{master.volumeDb.toFixed(1)} dB</span>
          </div>
          <input
            type="range"
            min={-36}
            max={12}
            step={0.5}
            value={master.volumeDb}
            onChange={(e) => onUpdateMaster({ ...master, volumeDb: parseFloat(e.target.value) })}
            className="w-full accent-emerald-500 bg-slate-800 h-1.5 rounded cursor-pointer"
          />
        </div>

        {/* Master Pan */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-slate-400">Balance</span>
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
            className="w-full accent-cyan-500 bg-slate-800 h-1.5 rounded cursor-pointer"
          />
        </div>

        {/* Master Soft Limiter */}
        <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs font-bold text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={master.limiterEnabled}
              onChange={(e) => onUpdateMaster({ ...master, limiterEnabled: e.target.checked })}
              className="accent-rose-500 rounded"
            />
            <ShieldCheck size={14} className="text-rose-400" />
            <span>Soft Limiter (Master)</span>
          </label>
          <span className="text-[10px] text-slate-400 font-mono">Ceiling: {master.limiterCeilingDb} dB</span>
        </div>
      </div>

      {/* VST Plugin Insert Rack for Master */}
      <div className="pt-2 border-t border-slate-800/60">
        <VSTRackSlot
          plugins={master.vstPlugins || []}
          title="Master Bus VST Inserts"
          badge="Master FX"
          color="#10b981"
          onUpdateChain={(newChain) => {
            if (onUpdateVstChain) {
              onUpdateVstChain(newChain);
            } else {
              onUpdateMaster({ ...master, vstPlugins: newChain });
            }
          }}
          onUpdateParam={(instId, pId, val) => {
            if (onUpdateVstParam) onUpdateVstParam(instId, pId, val);
          }}
          onUpdateBypass={(instId, enabled) => {
            if (onUpdateVstBypass) onUpdateVstBypass(instId, enabled);
          }}
          onUpdateWetDry={(instId, wetDry) => {
            if (onUpdateVstWetDry) onUpdateVstWetDry(instId, wetDry);
          }}
        />
      </div>
    </div>
  );
};
