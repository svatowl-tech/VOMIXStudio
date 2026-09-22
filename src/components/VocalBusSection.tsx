import React, { useState } from 'react';
import { VocalBusState, VocalBusDSP } from '../audio/dawEngine';
import { VocalBusMeterData } from '../hooks/useAudioEngine';
import { VSTPluginInstance } from '../audio/vstTypes';
import { VSTRackSlot } from './VSTRackSlot';
import { Volume2, Sliders, Mic, ShieldAlert, Sparkles, Activity, Music, ChevronDown, ChevronUp, Layers } from 'lucide-react';
import { toSafeArray } from '../utils/safeIterables';

interface VocalBusSectionProps {
  vocalBus: VocalBusState;
  vocalBusMeter: VocalBusMeterData;
  onUpdateVocalBus: (updated: VocalBusState) => void;
  onUpdateVstChain?: (vstPlugins: VSTPluginInstance[]) => void;
  onUpdateVstParam?: (instanceId: string, paramId: string, value: number) => void;
  onUpdateVstBypass?: (instanceId: string, enabled: boolean) => void;
  onUpdateVstWetDry?: (instanceId: string, wetDry: number) => void;
}

export const VocalBusSection: React.FC<VocalBusSectionProps> = ({
  vocalBus,
  vocalBusMeter,
  onUpdateVocalBus,
  onUpdateVstChain,
  onUpdateVstParam,
  onUpdateVstBypass,
  onUpdateVstWetDry
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const peakLevel = Math.max(vocalBusMeter.peakL, vocalBusMeter.peakR);
  const peakDb = peakLevel > 1e-4 ? 20 * Math.log10(peakLevel) : -120;

  const handleDspChange = (field: keyof VocalBusDSP, value: any) => {
    onUpdateVocalBus({
      ...vocalBus,
      dsp: {
        ...vocalBus.dsp,
        [field]: value
      }
    });
  };

  return (
    <div className="bg-[#0f1422] border border-violet-800/40 rounded-2xl p-4 sm:p-5 shadow-xl space-y-4">
      {/* Header with quick overview & meter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2.5 rounded-xl bg-violet-600/20 text-violet-400 border border-violet-500/30 shadow-md">
            <Mic size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white tracking-wide">Master Voiceover Bus</h3>
              <span className="px-2 py-0.5 text-[10px] font-semibold bg-violet-500/20 text-violet-300 rounded-full border border-violet-500/30">
                Сумма всех дублеров
              </span>
              {vocalBus.vstPlugins && vocalBus.vstPlugins.length > 0 && (
                <span className="px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 rounded-full border border-emerald-500/30 flex items-center gap-1">
                  <Layers size={10} /> {vocalBus.vstPlugins.length} VST
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400">
              Общая шина обработки всех голосов дубляжа, VST-инсерты и авто-даккинг оригинального звука
            </p>
          </div>
        </div>

        {/* Meters and quick controls */}
        <div className="flex items-center gap-3 bg-slate-950 px-3.5 py-1.5 rounded-xl border border-slate-800">
          <div className="text-right">
            <div className="text-[10px] text-slate-400 font-mono">Bus Peak</div>
            <div className={`text-xs font-mono font-bold ${peakDb > -0.5 ? 'text-rose-400' : 'text-violet-400'}`}>
              {peakDb > -90 ? `${peakDb.toFixed(1)} dB` : '-inf'}
            </div>
          </div>

          <div className="w-24 space-y-1">
            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-75 ${
                  vocalBusMeter.peakL > 1.0 ? 'bg-rose-500' : 'bg-violet-500'
                }`}
                style={{ width: `${Math.min(100, vocalBusMeter.peakL * 100)}%` }}
              />
            </div>
            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-75 ${
                  vocalBusMeter.peakR > 1.0 ? 'bg-rose-500' : 'bg-violet-500'
                }`}
                style={{ width: `${Math.min(100, vocalBusMeter.peakR * 100)}%` }}
              />
            </div>
          </div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-1 text-xs cursor-pointer border border-slate-800"
            title="Развернуть эффекты и VST шины"
          >
            <Sliders size={14} />
            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Main Bus Controls: Volume, Pan, Mute, Solo */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 items-center pt-2 border-t border-slate-800/60">
        <div className="space-y-1">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-slate-400">Bus Volume</span>
            <span className="text-violet-300 font-bold">{vocalBus.volumeDb.toFixed(1)} dB</span>
          </div>
          <input
            type="range"
            min={-36}
            max={12}
            step={0.5}
            value={vocalBus.volumeDb}
            onChange={(e) => onUpdateVocalBus({ ...vocalBus, volumeDb: parseFloat(e.target.value) })}
            className="w-full accent-violet-500 bg-slate-800 h-1.5 rounded cursor-pointer"
          />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-slate-400">Bus Pan</span>
            <span className="text-cyan-400 font-bold">
              {vocalBus.pan === 0 ? 'Center' : vocalBus.pan < 0 ? `L${Math.round(Math.abs(vocalBus.pan * 100))}` : `R${Math.round(vocalBus.pan * 100)}`}
            </span>
          </div>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={vocalBus.pan}
            onChange={(e) => onUpdateVocalBus({ ...vocalBus, pan: parseFloat(e.target.value) })}
            className="w-full accent-cyan-500 bg-slate-800 h-1.5 rounded cursor-pointer"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onUpdateVocalBus({ ...vocalBus, solo: !vocalBus.solo })}
            className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
              vocalBus.solo
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-950/30'
                : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
            }`}
          >
            SOLO BUS
          </button>
          <button
            onClick={() => onUpdateVocalBus({ ...vocalBus, mute: !vocalBus.mute })}
            className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
              vocalBus.mute
                ? 'bg-rose-600 text-white shadow-md shadow-rose-950/30'
                : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
            }`}
          >
            MUTE BUS
          </button>
        </div>

        <div className="text-right">
          <span className="text-[11px] text-slate-400 font-mono">
            Auto-Duck: <span className={vocalBus.dsp.autoDucker.enabled ? 'text-cyan-400 font-bold' : 'text-slate-600'}>
              {vocalBus.dsp.autoDucker.enabled ? 'Active (-14dB)' : 'Bypass'}
            </span>
          </span>
        </div>
      </div>

      {/* VST Plugin Insert Rack for Vocal Bus */}
      <div className="pt-2 border-t border-slate-800/60">
        <VSTRackSlot
          plugins={toSafeArray<VSTPluginInstance>(vocalBus?.vstPlugins)}
          title="Vocal Bus VST Inserts"
          badge="Vocal Bus FX"
          color="#8b5cf6"
          onUpdateChain={(newChain) => {
            const safeChain = toSafeArray<VSTPluginInstance>(newChain);
            if (onUpdateVstChain) {
              onUpdateVstChain(safeChain);
            } else {
              onUpdateVocalBus({ ...vocalBus, vstPlugins: safeChain });
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

      {/* Expanded C++ DSP Rack */}
      {isExpanded && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-slate-800 animate-fadeIn">
          {/* 1. Bus EQ */}
          <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
              <span className="text-xs font-bold text-violet-300 flex items-center gap-1.5">
                <Sliders size={14} /> Bus EQ
              </span>
              <input
                type="checkbox"
                checked={vocalBus.dsp.eq.enabled}
                onChange={(e) =>
                  handleDspChange('eq', {
                    ...vocalBus.dsp.eq,
                    enabled: e.target.checked
                  })
                }
                className="accent-violet-500 rounded"
              />
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Low Shelf (120 Hz)</span>
                <span className="font-mono text-slate-200">{vocalBus.dsp.eq.lowShelf.gainDb} dB</span>
              </div>
              <input
                type="range"
                min={-12}
                max={12}
                step={0.5}
                value={vocalBus.dsp.eq.lowShelf.gainDb}
                onChange={(e) =>
                  handleDspChange('eq', {
                    ...vocalBus.dsp.eq,
                    lowShelf: { ...vocalBus.dsp.eq.lowShelf, gainDb: parseFloat(e.target.value) }
                  })
                }
                className="w-full accent-violet-500 bg-slate-800 h-1.5 rounded"
              />

              <div className="flex justify-between">
                <span className="text-slate-400">Presence (3.0 kHz)</span>
                <span className="font-mono text-slate-200">{vocalBus.dsp.eq.peaking.gainDb} dB</span>
              </div>
              <input
                type="range"
                min={-12}
                max={12}
                step={0.5}
                value={vocalBus.dsp.eq.peaking.gainDb}
                onChange={(e) =>
                  handleDspChange('eq', {
                    ...vocalBus.dsp.eq,
                    peaking: { ...vocalBus.dsp.eq.peaking, gainDb: parseFloat(e.target.value) }
                  })
                }
                className="w-full accent-violet-500 bg-slate-800 h-1.5 rounded"
              />

              <div className="flex justify-between">
                <span className="text-slate-400">Air High Shelf (10 kHz)</span>
                <span className="font-mono text-slate-200">{vocalBus.dsp.eq.highShelf.gainDb} dB</span>
              </div>
              <input
                type="range"
                min={-12}
                max={12}
                step={0.5}
                value={vocalBus.dsp.eq.highShelf.gainDb}
                onChange={(e) =>
                  handleDspChange('eq', {
                    ...vocalBus.dsp.eq,
                    highShelf: { ...vocalBus.dsp.eq.highShelf, gainDb: parseFloat(e.target.value) }
                  })
                }
                className="w-full accent-violet-500 bg-slate-800 h-1.5 rounded"
              />
            </div>
          </div>

          {/* 2. Bus Glue Compressor */}
          <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
              <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                <Sparkles size={14} /> Bus Glue Compressor
              </span>
              <input
                type="checkbox"
                checked={vocalBus.dsp.compressor.enabled}
                onChange={(e) =>
                  handleDspChange('compressor', {
                    ...vocalBus.dsp.compressor,
                    enabled: e.target.checked
                  })
                }
                className="accent-amber-500 rounded"
              />
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Threshold</span>
                <span className="font-mono text-slate-200">{vocalBus.dsp.compressor.thresholdDb} dB</span>
              </div>
              <input
                type="range"
                min={-40}
                max={0}
                step={1}
                value={vocalBus.dsp.compressor.thresholdDb}
                onChange={(e) =>
                  handleDspChange('compressor', {
                    ...vocalBus.dsp.compressor,
                    thresholdDb: parseFloat(e.target.value)
                  })
                }
                className="w-full accent-amber-500 bg-slate-800 h-1.5 rounded"
              />

              <div className="flex justify-between">
                <span className="text-slate-400">Ratio</span>
                <span className="font-mono text-slate-200">{vocalBus.dsp.compressor.ratio}:1</span>
              </div>
              <input
                type="range"
                min={1}
                max={10}
                step={0.5}
                value={vocalBus.dsp.compressor.ratio}
                onChange={(e) =>
                  handleDspChange('compressor', {
                    ...vocalBus.dsp.compressor,
                    ratio: parseFloat(e.target.value)
                  })
                }
                className="w-full accent-amber-500 bg-slate-800 h-1.5 rounded"
              />

              <div className="flex justify-between">
                <span className="text-slate-400">Makeup Gain</span>
                <span className="font-mono text-slate-200">+{vocalBus.dsp.compressor.makeupGainDb} dB</span>
              </div>
              <input
                type="range"
                min={0}
                max={12}
                step={0.5}
                value={vocalBus.dsp.compressor.makeupGainDb}
                onChange={(e) =>
                  handleDspChange('compressor', {
                    ...vocalBus.dsp.compressor,
                    makeupGainDb: parseFloat(e.target.value)
                  })
                }
                className="w-full accent-amber-500 bg-slate-800 h-1.5 rounded"
              />
            </div>
          </div>

          {/* 3. Global Auto-Ducking Settings */}
          <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
              <span className="text-xs font-bold text-cyan-300 flex items-center gap-1.5">
                <Volume2 size={14} /> Настройки Ducker
              </span>
              <input
                type="checkbox"
                checked={vocalBus.dsp.autoDucker.enabled}
                onChange={(e) =>
                  handleDspChange('autoDucker', {
                    ...vocalBus.dsp.autoDucker,
                    enabled: e.target.checked
                  })
                }
                className="accent-cyan-500 rounded"
              />
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Threshold</span>
                <span className="font-mono text-slate-200">{vocalBus.dsp.autoDucker.thresholdDb} dB</span>
              </div>
              <input
                type="range"
                min={-40}
                max={-10}
                step={1}
                value={vocalBus.dsp.autoDucker.thresholdDb}
                onChange={(e) =>
                  handleDspChange('autoDucker', {
                    ...vocalBus.dsp.autoDucker,
                    thresholdDb: parseFloat(e.target.value)
                  })
                }
                className="w-full accent-cyan-500 bg-slate-800 h-1.5 rounded"
              />

              <div className="flex justify-between">
                <span className="text-slate-400">Duck Depth</span>
                <span className="font-mono text-slate-200">{vocalBus.dsp.autoDucker.duckDepthDb} dB</span>
              </div>
              <input
                type="range"
                min={-24}
                max={-6}
                step={1}
                value={vocalBus.dsp.autoDucker.duckDepthDb}
                onChange={(e) =>
                  handleDspChange('autoDucker', {
                    ...vocalBus.dsp.autoDucker,
                    duckDepthDb: parseFloat(e.target.value)
                  })
                }
                className="w-full accent-cyan-500 bg-slate-800 h-1.5 rounded"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
