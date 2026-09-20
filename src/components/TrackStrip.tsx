import React, { useState } from 'react';
import { TrackState } from '../audio/dawEngine';
import { VSTPluginInstance } from '../audio/vstTypes';
import { EqCurveVisualizer } from './EqCurveVisualizer';
import { VSTRackSlot } from './VSTRackSlot';
import { Sliders, Activity, Mic, VolumeX, Volume2, Shield, Layers } from 'lucide-react';

interface TrackStripProps {
  track: TrackState;
  allTracks: TrackState[];
  onUpdateTrack: (updated: TrackState) => void;
  onUpdateVstChain?: (vstPlugins: VSTPluginInstance[]) => void;
  onUpdateVstParam?: (instanceId: string, paramId: string, value: number) => void;
  onUpdateVstBypass?: (instanceId: string, enabled: boolean) => void;
  onUpdateVstWetDry?: (instanceId: string, wetDry: number) => void;
}

export const TrackStrip: React.FC<TrackStripProps> = ({
  track,
  allTracks,
  onUpdateTrack,
  onUpdateVstChain,
  onUpdateVstParam,
  onUpdateVstBypass,
  onUpdateVstWetDry
}) => {
  const [activeDspTab, setActiveDspTab] = useState<'eq' | 'comp' | 'duck' | 'vst'>('eq');

  const handleVolumeChange = (v: number) => {
    onUpdateTrack({ ...track, volumeDb: v });
  };

  const handlePanChange = (p: number) => {
    onUpdateTrack({ ...track, pan: p });
  };

  const toggleSolo = () => {
    onUpdateTrack({ ...track, solo: !track.solo });
  };

  const toggleMute = () => {
    onUpdateTrack({ ...track, mute: !track.mute });
  };

  return (
    <div
      className="bg-slate-900 border rounded-xl p-4 space-y-4 flex flex-col justify-between shadow-xl transition-all"
      style={{ borderColor: `${track.color}40` }}
    >
      {/* Track Header */}
      <div className="flex items-center justify-between pb-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: track.color }}
          />
          <h3 className="text-sm font-bold text-slate-100 truncate max-w-[120px]">
            {track.name}
          </h3>
          {track.vstPlugins && track.vstPlugins.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-mono border border-emerald-500/30">
              {track.vstPlugins.length} VST
            </span>
          )}
        </div>

        {/* Mute / Solo Buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={toggleSolo}
            className={`px-2 py-0.5 rounded text-xs font-mono font-bold transition-all ${
              track.solo
                ? 'bg-amber-500 text-slate-950 font-extrabold shadow-md shadow-amber-500/20'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            S
          </button>
          <button
            onClick={toggleMute}
            className={`px-2 py-0.5 rounded text-xs font-mono font-bold transition-all ${
              track.mute
                ? 'bg-rose-600 text-white font-extrabold shadow-md shadow-rose-600/20'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            M
          </button>
        </div>
      </div>

      {/* Main Channel Controls (Fader & Meters) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
        {/* Fader & Pan */}
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-slate-400 font-mono">
              <span>Volume</span>
              <span className="text-emerald-400 font-semibold">{track.volumeDb.toFixed(1)} dB</span>
            </div>
            <input
              type="range"
              min={-48}
              max={12}
              step={0.5}
              value={track.volumeDb}
              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
              className="w-full accent-emerald-500 bg-slate-800 h-1.5 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between text-xs text-slate-400 font-mono">
              <span>Pan</span>
              <span className="text-slate-300">
                {track.pan === 0
                  ? 'C'
                  : track.pan < 0
                  ? `L${Math.abs(Math.round(track.pan * 100))}`
                  : `R${Math.round(track.pan * 100)}`}
              </span>
            </div>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={track.pan}
              onChange={(e) => handlePanChange(parseFloat(e.target.value))}
              className="w-full accent-blue-500 bg-slate-800 h-1.5 rounded-lg appearance-none cursor-pointer"
            />
          </div>
        </div>

        {/* C++ AudioWorklet Realtime Stereo Meters */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 space-y-1.5">
          <div className="flex justify-between text-[10px] text-slate-400 font-mono">
            <span>Peak L/R</span>
            <span className={track.peakL > 0.99 || track.peakR > 0.99 ? 'text-rose-400 font-bold' : 'text-slate-400'}>
              {Math.max(track.peakL, track.peakR) > 1e-4
                ? `${(20 * Math.log10(Math.max(track.peakL, track.peakR))).toFixed(1)} dB`
                : '-inf'}
            </span>
          </div>

          <div className="space-y-1">
            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-75 ${
                  track.peakL > 0.99 ? 'bg-rose-500' : track.peakL > 0.7 ? 'bg-amber-400' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, track.peakL * 100)}%` }}
              />
            </div>
            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-75 ${
                  track.peakR > 0.99 ? 'bg-rose-500' : track.peakR > 0.7 ? 'bg-amber-400' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, track.peakR * 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* DSP & VST Processing Section */}
      <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800 space-y-3">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2">
          <span className="font-bold text-slate-300 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
            <Sliders size={13} className="text-emerald-400" /> C++ DSP & VST
          </span>

          <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded-md border border-slate-800">
            <button
              onClick={() => setActiveDspTab('eq')}
              className={`px-2 py-0.5 text-[11px] font-medium rounded ${
                activeDspTab === 'eq' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              3-Band EQ
            </button>
            <button
              onClick={() => setActiveDspTab('comp')}
              className={`px-2 py-0.5 text-[11px] font-medium rounded ${
                activeDspTab === 'comp' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Comp
            </button>
            <button
              onClick={() => setActiveDspTab('duck')}
              className={`px-2 py-0.5 text-[11px] font-medium rounded ${
                activeDspTab === 'duck' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Duck
            </button>
            <button
              onClick={() => setActiveDspTab('vst')}
              className={`px-2 py-0.5 text-[11px] font-medium rounded flex items-center gap-1 ${
                activeDspTab === 'vst' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers size={11} />
              VST ({track.vstPlugins?.length || 0})
            </button>
          </div>
        </div>

        {/* Tab 1: 3-Band Parametric Biquad EQ */}
        {activeDspTab === 'eq' && (
          <div className="space-y-3">
            <EqCurveVisualizer
              lowShelf={track.eq.lowShelf}
              peaking={track.eq.peaking}
              highShelf={track.eq.highShelf}
            />

            <div className="grid grid-cols-3 gap-2 text-xs">
              {/* Low Shelf */}
              <div className="bg-slate-900 p-2 rounded border border-slate-800 space-y-1">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Low Shelf</div>
                <div className="text-[10px] text-emerald-400 font-mono">{track.eq.lowShelf.frequency}Hz | {track.eq.lowShelf.gainDb}dB</div>
                <input
                  type="range"
                  min={-18}
                  max={18}
                  step={0.5}
                  value={track.eq.lowShelf.gainDb}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onUpdateTrack({
                      ...track,
                      eq: {
                        ...track.eq,
                        lowShelf: { ...track.eq.lowShelf, gainDb: val }
                      }
                    });
                  }}
                  className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Peaking EQ */}
              <div className="bg-slate-900 p-2 rounded border border-slate-800 space-y-1">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Mid Peaking</div>
                <div className="text-[10px] text-blue-400 font-mono">{track.eq.peaking.frequency}Hz | {track.eq.peaking.gainDb}dB</div>
                <input
                  type="range"
                  min={-18}
                  max={18}
                  step={0.5}
                  value={track.eq.peaking.gainDb}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onUpdateTrack({
                      ...track,
                      eq: {
                        ...track.eq,
                        peaking: { ...track.eq.peaking, gainDb: val }
                      }
                    });
                  }}
                  className="w-full accent-blue-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* High Shelf */}
              <div className="bg-slate-900 p-2 rounded border border-slate-800 space-y-1">
                <div className="text-[10px] text-slate-400 font-bold uppercase">High Shelf</div>
                <div className="text-[10px] text-purple-400 font-mono">{track.eq.highShelf.frequency}Hz | {track.eq.highShelf.gainDb}dB</div>
                <input
                  type="range"
                  min={-18}
                  max={18}
                  step={0.5}
                  value={track.eq.highShelf.gainDb}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onUpdateTrack({
                      ...track,
                      eq: {
                        ...track.eq,
                        highShelf: { ...track.eq.highShelf, gainDb: val }
                      }
                    });
                  }}
                  className="w-full accent-purple-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Dynamic Compressor */}
        {activeDspTab === 'comp' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <label className="flex items-center gap-2 text-slate-200 cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={track.compressor.enabled}
                  onChange={(e) => {
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, enabled: e.target.checked }
                    });
                  }}
                  className="accent-emerald-500 rounded"
                />
                Включить компрессор
              </label>

              <span className="text-emerald-400 font-mono text-[10px]">
                {track.compressor.currentGainReductionDb < -0.1
                  ? `GR: ${track.compressor.currentGainReductionDb.toFixed(1)} dB`
                  : '0.0 dB'}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="space-y-1">
                <div className="flex justify-between text-slate-400 text-[10px] font-mono">
                  <span>Threshold</span>
                  <span>{track.compressor.thresholdDb} dB</span>
                </div>
                <input
                  type="range"
                  min={-40}
                  max={0}
                  step={1}
                  value={track.compressor.thresholdDb}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, thresholdDb: val }
                    });
                  }}
                  className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-slate-400 text-[10px] font-mono">
                  <span>Ratio</span>
                  <span>{track.compressor.ratio}:1</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={0.5}
                  value={track.compressor.ratio}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, ratio: val }
                    });
                  }}
                  className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-slate-400 text-[10px] font-mono">
                  <span>Makeup Gain</span>
                  <span>+{track.compressor.makeupGainDb} dB</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={12}
                  step={0.5}
                  value={track.compressor.makeupGainDb}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, makeupGainDb: val }
                    });
                  }}
                  className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Auto-Ducking (Sidechain Compression) */}
        {activeDspTab === 'duck' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <label className="flex items-center gap-2 text-slate-200 cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={track.autoDucker.enabled}
                  onChange={(e) => {
                    onUpdateTrack({
                      ...track,
                      autoDucker: { ...track.autoDucker, enabled: e.target.checked }
                    });
                  }}
                  className="accent-amber-500 rounded"
                />
                Включить Auto-Ducking
              </label>

              <span className="text-amber-400 font-mono text-[10px]">
                {track.autoDucker.currentDuckingGainDb < -0.1
                  ? `Ducking: ${track.autoDucker.currentDuckingGainDb.toFixed(1)} dB`
                  : 'Idle'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="space-y-1">
                <div className="text-[10px] text-slate-400">Sidechain Источник:</div>
                <select
                  value={track.autoDucker.sourceTrackId}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    onUpdateTrack({
                      ...track,
                      autoDucker: { ...track.autoDucker, sourceTrackId: val }
                    });
                  }}
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs"
                >
                  {allTracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-slate-400 text-[10px] font-mono">
                  <span>Глубина (Duck Depth)</span>
                  <span>{track.autoDucker.duckDepthDb} dB</span>
                </div>
                <input
                  type="range"
                  min={-24}
                  max={0}
                  step={1}
                  value={track.autoDucker.duckDepthDb}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onUpdateTrack({
                      ...track,
                      autoDucker: { ...track.autoDucker, duckDepthDb: val }
                    });
                  }}
                  className="w-full accent-amber-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: VST Rack Slot */}
        {activeDspTab === 'vst' && (
          <div className="space-y-3 animate-fadeIn">
            <VSTRackSlot
              plugins={track.vstPlugins || []}
              title={`VST рэк: ${track.name}`}
              badge={`CH ${track.id}`}
              color={track.color || '#8b5cf6'}
              onUpdateChain={(newChain) => {
                if (onUpdateVstChain) {
                  onUpdateVstChain(newChain);
                } else {
                  onUpdateTrack({ ...track, vstPlugins: newChain });
                }
              }}
              onUpdateParam={(instId, pId, val) => {
                if (onUpdateVstParam) {
                  onUpdateVstParam(instId, pId, val);
                }
              }}
              onUpdateBypass={(instId, enabled) => {
                if (onUpdateVstBypass) {
                  onUpdateVstBypass(instId, enabled);
                }
              }}
              onUpdateWetDry={(instId, wetDry) => {
                if (onUpdateVstWetDry) {
                  onUpdateVstWetDry(instId, wetDry);
                }
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
