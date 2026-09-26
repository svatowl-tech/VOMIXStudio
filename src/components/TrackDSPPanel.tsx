import React, { useState } from 'react';
import { TrackState, createNewTrack, isOriginalTrackName } from '../audio/dawEngine';
import { EqCurveVisualizer } from './EqCurveVisualizer';
import { toSafeArray } from '../utils/safeIterables';
import { globalMVPPresetManager, MVPPreset } from '../services/MVPPresetManager';
import {
  Sliders,
  Activity,
  Mic,
  Radio,
  Music,
  Zap,
  RotateCcw,
  X,
  Volume2,
  VolumeX,
  Wrench,
  Scissors,
  Sparkles,
  Layers,
  Settings,
  ShieldAlert,
  ChevronDown
} from 'lucide-react';

interface TrackDSPPanelProps {
  track: TrackState;
  allTracks: TrackState[];
  onUpdateTrack: (updated: TrackState) => void;
  onClose: () => void;
}

export const TrackDSPPanel: React.FC<TrackDSPPanelProps> = ({
  track,
  allTracks,
  onUpdateTrack,
  onClose
}) => {
  const [activeTab, setActiveTab] = useState<'eq' | 'comp' | 'gate' | 'repair' | 'deesser' | 'ducking'>('eq');

  // Preset Handlers
  const applySubPresetDsp = (preset: MVPPreset) => {
    if (!preset.trackDspTemplate) return;
    const tpl = preset.trackDspTemplate;
    const updated: TrackState = {
      ...track,
      eq: tpl.eq ? JSON.parse(JSON.stringify(tpl.eq)) : track.eq,
      compressor: tpl.compressor ? JSON.parse(JSON.stringify(tpl.compressor)) : track.compressor,
      noiseGate: tpl.noiseGate ? JSON.parse(JSON.stringify(tpl.noiseGate)) : track.noiseGate,
      deEsser: tpl.deEsser ? JSON.parse(JSON.stringify(tpl.deEsser)) : track.deEsser,
      deClicker: tpl.deClicker ? JSON.parse(JSON.stringify(tpl.deClicker)) : track.deClicker,
      dePlosive: tpl.dePlosive ? JSON.parse(JSON.stringify(tpl.dePlosive)) : track.dePlosive,
      autoDucker: tpl.autoDucker ? JSON.parse(JSON.stringify(tpl.autoDucker)) : track.autoDucker
    };
    onUpdateTrack(updated);
  };

  const applyPreset = (type: 'dialogue' | 'broadcast' | 'music' | 'sfx' | 'flat') => {
    let updated = { ...track };

    if (type === 'dialogue') {
      updated = {
        ...updated,
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 120, gainDb: -3.0, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 3200, gainDb: 3.5, Q: 1.2, enabled: true },
          highShelf: { type: 'highshelf', frequency: 10000, gainDb: 2.0, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -16,
          ratio: 3.5,
          attackMs: 12,
          releaseMs: 120,
          makeupGainDb: 2.0,
          kneeDb: 6,
          enabled: true,
          currentGainReductionDb: 0
        },
        noiseGate: {
          thresholdDb: -48.0,
          attackMs: 2.0,
          holdMs: 40.0,
          releaseMs: 120.0,
          floorDb: -60.0,
          enabled: true
        },
        deClicker: {
          threshold: 0.06,
          repairWindow: 3,
          enabled: true
        },
        deEsser: {
          thresholdDb: -20.0,
          frequency: 6200.0,
          ratio: 4.0,
          attackMs: 1.0,
          releaseMs: 45.0,
          enabled: true
        },
        autoDucker: {
          ...updated.autoDucker,
          enabled: false
        }
      };
    } else if (type === 'broadcast') {
      updated = {
        ...updated,
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 100, gainDb: 2.5, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 2800, gainDb: 4.5, Q: 1.0, enabled: true },
          highShelf: { type: 'highshelf', frequency: 8500, gainDb: 3.0, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -20,
          ratio: 5.0,
          attackMs: 8,
          releaseMs: 90,
          makeupGainDb: 3.5,
          kneeDb: 8,
          enabled: true,
          currentGainReductionDb: 0
        },
        noiseGate: {
          thresholdDb: -42.0,
          attackMs: 1.5,
          holdMs: 30.0,
          releaseMs: 100.0,
          floorDb: -55.0,
          enabled: true
        },
        deEsser: {
          thresholdDb: -18.0,
          frequency: 5500.0,
          ratio: 5.0,
          attackMs: 1.0,
          releaseMs: 40.0,
          enabled: true
        }
      };
    } else if (type === 'music') {
      const voiceTrack = allTracks.find((t) => t.id !== track.id && t.name.toLowerCase().includes('vocal')) || allTracks[0];
      updated = {
        ...updated,
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 250, gainDb: -2.0, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 1000, gainDb: -1.5, Q: 1.0, enabled: true },
          highShelf: { type: 'highshelf', frequency: 6000, gainDb: -2.0, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -18,
          ratio: 2.5,
          attackMs: 25,
          releaseMs: 200,
          makeupGainDb: 0.5,
          kneeDb: 4,
          enabled: true,
          currentGainReductionDb: 0
        },
        autoDucker: {
          thresholdDb: -22,
          duckDepthDb: -12,
          attackMs: 20,
          releaseMs: 300,
          enabled: true,
          sourceTrackId: voiceTrack ? voiceTrack.id : 1,
          currentDuckingGainDb: 0
        }
      };
    } else if (type === 'sfx') {
      updated = {
        ...updated,
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 80, gainDb: 3.0, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 4500, gainDb: 2.5, Q: 1.5, enabled: true },
          highShelf: { type: 'highshelf', frequency: 12000, gainDb: 1.5, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -14,
          ratio: 6.0,
          attackMs: 5,
          releaseMs: 80,
          makeupGainDb: 1.0,
          kneeDb: 6,
          enabled: true,
          currentGainReductionDb: 0
        }
      };
    } else {
      // Flat / Reset
      updated = {
        ...updated,
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 120, gainDb: 0, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 2500, gainDb: 0, Q: 1.0, enabled: true },
          highShelf: { type: 'highshelf', frequency: 8000, gainDb: 0, Q: 0.7071, enabled: true },
          enabled: false
        },
        compressor: {
          thresholdDb: -18,
          ratio: 4.0,
          attackMs: 15,
          releaseMs: 120,
          makeupGainDb: 0,
          kneeDb: 6,
          enabled: false,
          currentGainReductionDb: 0
        },
        noiseGate: {
          thresholdDb: -45.0,
          attackMs: 2.0,
          holdMs: 30.0,
          releaseMs: 100.0,
          floorDb: -60.0,
          enabled: false
        },
        deClicker: {
          threshold: 0.08,
          repairWindow: 4,
          enabled: false,
          clicksDetected: 0
        },
        dePlosive: {
          thresholdDb: -24.0,
          frequency: 80.0,
          attackMs: 2.0,
          releaseMs: 50.0,
          enabled: false,
          currentReduction: 0
        },
        deEsser: {
          thresholdDb: -22.0,
          frequency: 6000.0,
          ratio: 4.0,
          attackMs: 1.0,
          releaseMs: 40.0,
          enabled: false,
          currentGainReductionDb: 0
        },
        autoDucker: {
          thresholdDb: -22,
          duckDepthDb: -10,
          attackMs: 20,
          releaseMs: 250,
          enabled: false,
          sourceTrackId: 1,
          currentDuckingGainDb: 0
        }
      };
    }

    onUpdateTrack(updated);
  };

  return (
    <div
      id={`vocal-rack-panel-${track.id}`}
      className="bg-[#0b0e17] border border-slate-800/80 rounded-xl p-5 space-y-4 shadow-2xl animate-fadeIn transition-all"
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-800/60">
        <div className="flex items-center gap-3">
          <div
            className="w-3.5 h-3.5 rounded-full shadow-inner shrink-0"
            style={{ backgroundColor: track.color || '#3b82f6' }}
          />
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-1.5">
                <Sparkles size={14} className="text-cyan-400" />
                C++ DSP Vocal Rack: <span className="text-cyan-300 font-extrabold">{track.name}</span>
              </h3>
              <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-cyan-950/60 text-cyan-400 border border-cyan-900/60">
                CH {track.id}
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Низкозадержечный студийный тракт обработки вокала, выполняемый непосредственно в C++ WebAssembly
            </p>
          </div>
        </div>

        <button
          onClick={onClose}
          className="p-1.5 hover:bg-slate-800/60 text-slate-400 hover:text-slate-200 rounded-lg transition-all cursor-pointer"
          title="Закрыть рэк"
        >
          <X size={15} />
        </button>
      </div>

      {/* Quick Presets row */}
      {(() => {
        const isOriginal = track.isOriginalAudio || isOriginalTrackName(track.name);
        const isDialogueActive = !isOriginal && !!track.eq?.enabled && !!track.compressor?.enabled;
        const isFlatActive = !track.eq?.enabled && !track.compressor?.enabled && !track.noiseGate?.enabled;

        return (
          <div className="flex flex-wrap items-center gap-2 bg-slate-950/40 p-2.5 rounded-lg border border-slate-900">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider shrink-0 mr-1">
              Быстрые пресеты:
            </span>
            <button
              onClick={() => applyPreset('dialogue')}
              className={`px-2.5 py-1 border rounded-md text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all ${
                isDialogueActive
                  ? 'bg-emerald-600 text-white border-emerald-400 shadow-sm shadow-emerald-950/60 ring-1 ring-emerald-400'
                  : 'bg-emerald-950/30 hover:bg-emerald-900/40 text-emerald-400 border border-emerald-900/50'
              }`}
              title="C++ DSP пресет для голоса (EQ, компрессор, гейт, DeClicker, DeEsser) по умолчанию"
            >
              <Mic size={11} />
              🎙️ Дубляж / Речь {isDialogueActive && '(По умолчанию)'}
            </button>
            <button
              onClick={() => applyPreset('broadcast')}
              className="px-2.5 py-1 bg-cyan-950/30 hover:bg-cyan-900/40 text-cyan-400 border border-cyan-900/50 rounded-md text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all"
            >
              <Radio size={11} />
              📻 Диктор / Радио
            </button>
            <button
              onClick={() => applyPreset('music')}
              className="px-2.5 py-1 bg-purple-950/30 hover:bg-purple-900/40 text-purple-400 border border-purple-900/50 rounded-md text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all"
            >
              <Music size={11} />
              🎵 Музыка (Ducker)
            </button>
            <button
              onClick={() => applyPreset('sfx')}
              className="px-2.5 py-1 bg-amber-950/30 hover:bg-amber-900/40 text-amber-400 border border-amber-900/50 rounded-md text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all"
            >
              <Zap size={11} />
              💥 Кино / SFX
            </button>
            <button
              onClick={() => applyPreset('flat')}
              className={`px-2.5 py-1 border rounded-md text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all ml-auto ${
                isFlatActive
                  ? 'bg-slate-700 text-white border-slate-500'
                  : 'bg-slate-900 hover:bg-slate-800 text-slate-400 border border-slate-800'
              }`}
              title={isOriginal ? 'Оригинал: обработка отключена (Flat)' : 'Сбросить в нейтральный режим'}
            >
              <RotateCcw size={11} />
              {isOriginal ? '🎬 Оригинал (Flat)' : 'Сброс (Flat)'}
            </button>

            {/* Вариации текущего режима */}
            <div className="flex flex-wrap items-center gap-1.5 w-full pt-1.5 border-t border-slate-900/80">
              <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider shrink-0 mr-1 flex items-center gap-1">
                <Sliders size={11} />
                <span>Вариации ({globalMVPPresetManager.getActiveCategory()}):</span>
              </span>
              {globalMVPPresetManager.getSubPresetsForCategory(globalMVPPresetManager.getActiveCategory()).map((subP) => (
                <button
                  key={subP.id}
                  onClick={() => applySubPresetDsp(subP)}
                  className="px-2 py-0.5 bg-slate-900 hover:bg-cyan-950/40 text-slate-300 hover:text-cyan-200 border border-slate-800 hover:border-cyan-700/50 rounded text-[10px] font-medium transition-all cursor-pointer"
                  title={`Применить DSP настройки вариации «${subP.name}» к этой дорожке`}
                >
                  {subP.subPresetName || subP.name}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-slate-900 pb-1.5 overflow-x-auto">
        <button
          onClick={() => setActiveTab('eq')}
          className={`px-3 py-1 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
            activeTab === 'eq'
              ? 'bg-cyan-600/20 text-cyan-400 border border-cyan-800/50 font-extrabold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
          }`}
        >
          <Sliders size={12} />
          3-Band EQ
          {track.eq.enabled && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />}
        </button>
        <button
          onClick={() => setActiveTab('comp')}
          className={`px-3 py-1 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
            activeTab === 'comp'
              ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-800/50 font-extrabold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
          }`}
        >
          <Activity size={12} />
          Compressor
          {track.compressor.enabled && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
        </button>
        <button
          onClick={() => setActiveTab('gate')}
          className={`px-3 py-1 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
            activeTab === 'gate'
              ? 'bg-amber-600/20 text-amber-400 border border-amber-800/50 font-extrabold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
          }`}
        >
          <VolumeX size={12} />
          Noise Gate
          {track.noiseGate?.enabled && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
        </button>
        <button
          onClick={() => setActiveTab('repair')}
          className={`px-3 py-1 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
            activeTab === 'repair'
              ? 'bg-red-600/20 text-red-400 border border-red-800/50 font-extrabold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
          }`}
        >
          <Wrench size={12} />
          Repair
          {(track.deClicker?.enabled || track.dePlosive?.enabled) && <span className="w-1.5 h-1.5 rounded-full bg-red-400" />}
        </button>
        <button
          onClick={() => setActiveTab('deesser')}
          className={`px-3 py-1 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
            activeTab === 'deesser'
              ? 'bg-rose-600/20 text-rose-400 border border-rose-800/50 font-extrabold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
          }`}
        >
          <Scissors size={12} />
          De-Esser
          {track.deEsser?.enabled && <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />}
        </button>
        <button
          onClick={() => setActiveTab('ducking')}
          className={`px-3 py-1 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
            activeTab === 'ducking'
              ? 'bg-purple-600/20 text-purple-400 border border-purple-800/50 font-extrabold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
          }`}
        >
          <Volume2 size={12} />
          Auto-Ducking
          {track.autoDucker.enabled && <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />}
        </button>
      </div>

      {/* Tab Contents - Dense & scrolling-free layouts */}
      <div className="bg-slate-950 p-4 rounded-xl border border-slate-900">
        {/* EQ Tab */}
        {activeTab === 'eq' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-900">
              <span className="text-xs font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-1">
                <Sliders size={13} /> 3-Band Biquad Parametric EQ
              </span>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 font-bold cursor-pointer">
                <input
                  type="checkbox"
                  checked={track.eq.enabled}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      eq: { ...track.eq, enabled: e.target.checked }
                    })
                  }
                  className="rounded accent-cyan-500"
                />
                <span>Модуль Включен</span>
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
              {/* Curve visualizer in 5-col */}
              <div className="md:col-span-5 bg-slate-900 p-2.5 rounded-lg border border-slate-800/60">
                <EqCurveVisualizer
                  lowShelf={track.eq.lowShelf}
                  peaking={track.eq.peaking}
                  highShelf={track.eq.highShelf}
                />
              </div>

              {/* Sliders in 7-col */}
              <div className="md:col-span-7 grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Low Shelf */}
                <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-2">
                  <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Low Shelf</div>
                  <div className="text-xs font-bold text-slate-300">{track.eq.lowShelf.frequency} Hz</div>
                  <div className="text-xs font-mono font-bold text-cyan-400">
                    {track.eq.lowShelf.gainDb >= 0 ? `+${track.eq.lowShelf.gainDb.toFixed(1)}` : track.eq.lowShelf.gainDb.toFixed(1)} dB
                  </div>
                  <input
                    type="range"
                    min="-18"
                    max="18"
                    step="0.5"
                    disabled={!track.eq.enabled}
                    value={track.eq.lowShelf.gainDb}
                    onChange={(e) =>
                      onUpdateTrack({
                        ...track,
                        eq: {
                          ...track.eq,
                          lowShelf: { ...track.eq.lowShelf, gainDb: parseFloat(e.target.value) }
                        }
                      })
                    }
                    className="w-full accent-cyan-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                  />
                </div>

                {/* Mid Peaking */}
                <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-2">
                  <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Mid Peaking</div>
                  <div className="text-xs font-bold text-slate-300">{track.eq.peaking.frequency} Hz</div>
                  <div className="text-xs font-mono font-bold text-cyan-400">
                    {track.eq.peaking.gainDb >= 0 ? `+${track.eq.peaking.gainDb.toFixed(1)}` : track.eq.peaking.gainDb.toFixed(1)} dB
                  </div>
                  <input
                    type="range"
                    min="-18"
                    max="18"
                    step="0.5"
                    disabled={!track.eq.enabled}
                    value={track.eq.peaking.gainDb}
                    onChange={(e) =>
                      onUpdateTrack({
                        ...track,
                        eq: {
                          ...track.eq,
                          peaking: { ...track.eq.peaking, gainDb: parseFloat(e.target.value) }
                        }
                      })
                    }
                    className="w-full accent-cyan-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                  />
                </div>

                {/* High Shelf */}
                <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-2">
                  <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">High Shelf</div>
                  <div className="text-xs font-bold text-slate-300">{track.eq.highShelf.frequency} Hz</div>
                  <div className="text-xs font-mono font-bold text-cyan-400">
                    {track.eq.highShelf.gainDb >= 0 ? `+${track.eq.highShelf.gainDb.toFixed(1)}` : track.eq.highShelf.gainDb.toFixed(1)} dB
                  </div>
                  <input
                    type="range"
                    min="-18"
                    max="18"
                    step="0.5"
                    disabled={!track.eq.enabled}
                    value={track.eq.highShelf.gainDb}
                    onChange={(e) =>
                      onUpdateTrack({
                        ...track,
                        eq: {
                          ...track.eq,
                          highShelf: { ...track.eq.highShelf, gainDb: parseFloat(e.target.value) }
                        }
                      })
                    }
                    className="w-full accent-cyan-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Compressor Tab */}
        {activeTab === 'comp' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-900">
              <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1">
                <Activity size={13} /> Soft-Knee Vocal Compressor
              </span>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 font-bold cursor-pointer">
                <input
                  type="checkbox"
                  checked={track.compressor.enabled}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, enabled: e.target.checked }
                    })
                  }
                  className="rounded accent-emerald-500"
                />
                <span>Модуль Включен</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
              {/* Threshold */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Threshold</div>
                <div className="text-xs font-mono font-bold text-emerald-400">{track.compressor.thresholdDb} dB</div>
                <input
                  type="range"
                  min="-40"
                  max="0"
                  step="1"
                  disabled={!track.compressor.enabled}
                  value={track.compressor.thresholdDb}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, thresholdDb: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Ratio */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Ratio</div>
                <div className="text-xs font-mono font-bold text-emerald-400">{track.compressor.ratio.toFixed(1)}:1</div>
                <input
                  type="range"
                  min="1"
                  max="16"
                  step="0.5"
                  disabled={!track.compressor.enabled}
                  value={track.compressor.ratio}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, ratio: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Knee */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Soft Knee</div>
                <div className="text-xs font-mono font-bold text-emerald-400">{track.compressor.kneeDb} dB</div>
                <input
                  type="range"
                  min="0"
                  max="12"
                  step="1"
                  disabled={!track.compressor.enabled}
                  value={track.compressor.kneeDb}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, kneeDb: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Makeup Gain */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Makeup Gain</div>
                <div className="text-xs font-mono font-bold text-emerald-400">
                  {track.compressor.makeupGainDb >= 0 ? `+${track.compressor.makeupGainDb.toFixed(1)}` : track.compressor.makeupGainDb.toFixed(1)} dB
                </div>
                <input
                  type="range"
                  min="-6"
                  max="18"
                  step="0.5"
                  disabled={!track.compressor.enabled}
                  value={track.compressor.makeupGainDb}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, makeupGainDb: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Attack */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Attack Time</div>
                <div className="text-xs font-mono font-bold text-emerald-400">{track.compressor.attackMs} ms</div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  step="1"
                  disabled={!track.compressor.enabled}
                  value={track.compressor.attackMs}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, attackMs: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Release */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Release Time</div>
                <div className="text-xs font-mono font-bold text-emerald-400">{track.compressor.releaseMs} ms</div>
                <input
                  type="range"
                  min="10"
                  max="1000"
                  step="10"
                  disabled={!track.compressor.enabled}
                  value={track.compressor.releaseMs}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      compressor: { ...track.compressor, releaseMs: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}

        {/* Noise Gate Tab */}
        {activeTab === 'gate' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-900">
              <span className="text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1">
                <VolumeX size={13} /> Downward Noise Gate
              </span>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 font-bold cursor-pointer">
                <input
                  type="checkbox"
                  checked={track.noiseGate?.enabled || false}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      noiseGate: { ...(track.noiseGate || createNewTrack(track.id).noiseGate), enabled: e.target.checked }
                    })
                  }
                  className="rounded accent-amber-500"
                />
                <span>Модуль Включен</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
              {/* Threshold */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Threshold</div>
                <div className="text-xs font-mono font-bold text-amber-400">{(track.noiseGate?.thresholdDb || -45).toFixed(0)} dB</div>
                <input
                  type="range"
                  min="-60"
                  max="-10"
                  step="1"
                  disabled={!track.noiseGate?.enabled}
                  value={track.noiseGate?.thresholdDb || -45}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      noiseGate: { ...(track.noiseGate || createNewTrack(track.id).noiseGate), thresholdDb: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-amber-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Floor */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Gate Floor</div>
                <div className="text-xs font-mono font-bold text-amber-400">{(track.noiseGate?.floorDb || -60).toFixed(0)} dB</div>
                <input
                  type="range"
                  min="-80"
                  max="-20"
                  step="1"
                  disabled={!track.noiseGate?.enabled}
                  value={track.noiseGate?.floorDb || -60}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      noiseGate: { ...(track.noiseGate || createNewTrack(track.id).noiseGate), floorDb: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-amber-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Attack */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Attack</div>
                <div className="text-xs font-mono font-bold text-amber-400">{(track.noiseGate?.attackMs || 2.0).toFixed(1)} ms</div>
                <input
                  type="range"
                  min="0.1"
                  max="20"
                  step="0.5"
                  disabled={!track.noiseGate?.enabled}
                  value={track.noiseGate?.attackMs || 2.0}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      noiseGate: { ...(track.noiseGate || createNewTrack(track.id).noiseGate), attackMs: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-amber-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Hold */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Gate Hold</div>
                <div className="text-xs font-mono font-bold text-amber-400">{(track.noiseGate?.holdMs || 30.0).toFixed(0)} ms</div>
                <input
                  type="range"
                  min="5"
                  max="500"
                  step="5"
                  disabled={!track.noiseGate?.enabled}
                  value={track.noiseGate?.holdMs || 30.0}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      noiseGate: { ...(track.noiseGate || createNewTrack(track.id).noiseGate), holdMs: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-amber-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Release */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Release</div>
                <div className="text-xs font-mono font-bold text-amber-400">{(track.noiseGate?.releaseMs || 100.0).toFixed(0)} ms</div>
                <input
                  type="range"
                  min="10"
                  max="1000"
                  step="10"
                  disabled={!track.noiseGate?.enabled}
                  value={track.noiseGate?.releaseMs || 100}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      noiseGate: { ...(track.noiseGate || createNewTrack(track.id).noiseGate), releaseMs: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-amber-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}

        {/* Repair Tab */}
        {activeTab === 'repair' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 pb-2 border-b border-slate-900 text-xs font-bold text-red-400 uppercase tracking-wider">
              <Wrench size={13} /> Vocal Damage Repair (De-Clicker & De-Plosive)
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* De-Clicker */}
              <div className="bg-slate-900 p-4 rounded-lg border border-slate-800/80 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1">
                    🟢 De-Clicker (Анти-щелчки)
                  </span>
                  <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={track.deClicker?.enabled || false}
                      onChange={(e) =>
                        onUpdateTrack({
                          ...track,
                          deClicker: { ...(track.deClicker || createNewTrack(track.id).deClicker), enabled: e.target.checked }
                        })
                      }
                      className="rounded accent-red-500"
                    />
                    <span>Вкл</span>
                  </label>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-400">Порог щелчков (Threshold):</span>
                    <span className="font-mono text-red-400 font-bold">{(track.deClicker?.threshold || 0.08).toFixed(3)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.01"
                    max="0.50"
                    step="0.01"
                    disabled={!track.deClicker?.enabled}
                    value={track.deClicker?.threshold || 0.08}
                    onChange={(e) =>
                      onUpdateTrack({
                        ...track,
                        deClicker: { ...(track.deClicker || createNewTrack(track.id).deClicker), threshold: parseFloat(e.target.value) }
                      })
                    }
                    className="w-full accent-red-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-400">Окно сглаживания (Repair Window):</span>
                    <span className="font-mono text-red-400 font-bold">{(track.deClicker?.repairWindow || 4)} сэмплов</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="16"
                    step="1"
                    disabled={!track.deClicker?.enabled}
                    value={track.deClicker?.repairWindow || 4}
                    onChange={(e) =>
                      onUpdateTrack({
                        ...track,
                        deClicker: { ...(track.deClicker || createNewTrack(track.id).deClicker), repairWindow: parseInt(e.target.value, 10) }
                      })
                    }
                    className="w-full accent-red-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                  />
                </div>
              </div>

              {/* De-Plosive */}
              <div className="bg-slate-900 p-4 rounded-lg border border-slate-800/80 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1">
                    💨 De-Plosive (Анти-плевки / 'П'/'Б' Подавление)
                  </span>
                  <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={track.dePlosive?.enabled || false}
                      onChange={(e) =>
                        onUpdateTrack({
                          ...track,
                          dePlosive: { ...(track.dePlosive || createNewTrack(track.id).dePlosive), enabled: e.target.checked }
                        })
                      }
                      className="rounded accent-red-500"
                    />
                    <span>Вкл</span>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-slate-400">Порог:</span>
                      <span className="font-mono text-red-400 font-bold">{(track.dePlosive?.thresholdDb || -24.0).toFixed(0)} dB</span>
                    </div>
                    <input
                      type="range"
                      min="-40"
                      max="-10"
                      step="1"
                      disabled={!track.dePlosive?.enabled}
                      value={track.dePlosive?.thresholdDb || -24}
                      onChange={(e) =>
                        onUpdateTrack({
                          ...track,
                          dePlosive: { ...(track.dePlosive || createNewTrack(track.id).dePlosive), thresholdDb: parseFloat(e.target.value) }
                        })
                      }
                      className="w-full accent-red-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-slate-400">ФПЧ Срез:</span>
                      <span className="font-mono text-red-400 font-bold">{(track.dePlosive?.frequency || 80).toFixed(0)} Hz</span>
                    </div>
                    <input
                      type="range"
                      min="40"
                      max="180"
                      step="5"
                      disabled={!track.dePlosive?.enabled}
                      value={track.dePlosive?.frequency || 80}
                      onChange={(e) =>
                        onUpdateTrack({
                          ...track,
                          dePlosive: { ...(track.dePlosive || createNewTrack(track.id).dePlosive), frequency: parseFloat(e.target.value) }
                        })
                      }
                      className="w-full accent-red-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* De-Esser Tab */}
        {activeTab === 'deesser' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-900">
              <span className="text-xs font-bold text-rose-400 uppercase tracking-wider flex items-center gap-1">
                <Scissors size={13} /> Vocal De-Esser (Смягчение 'С'/'Ц' шипящих)
              </span>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 font-bold cursor-pointer">
                <input
                  type="checkbox"
                  checked={track.deEsser?.enabled || false}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      deEsser: { ...(track.deEsser || createNewTrack(track.id).deEsser), enabled: e.target.checked }
                    })
                  }
                  className="rounded accent-rose-500"
                />
                <span>Модуль Включен</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
              {/* Threshold */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Threshold</div>
                <div className="text-xs font-mono font-bold text-rose-400">{(track.deEsser?.thresholdDb || -22).toFixed(0)} dB</div>
                <input
                  type="range"
                  min="-40"
                  max="0"
                  step="1"
                  disabled={!track.deEsser?.enabled}
                  value={track.deEsser?.thresholdDb || -22}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      deEsser: { ...(track.deEsser || createNewTrack(track.id).deEsser), thresholdDb: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-rose-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Frequency */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Frequency</div>
                <div className="text-xs font-mono font-bold text-rose-400">{(track.deEsser?.frequency || 6000).toFixed(0)} Hz</div>
                <input
                  type="range"
                  min="3000"
                  max="10000"
                  step="100"
                  disabled={!track.deEsser?.enabled}
                  value={track.deEsser?.frequency || 6000}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      deEsser: { ...(track.deEsser || createNewTrack(track.id).deEsser), frequency: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-rose-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Ratio */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Ratio</div>
                <div className="text-xs font-mono font-bold text-rose-400">{(track.deEsser?.ratio || 4.0).toFixed(1)}:1</div>
                <input
                  type="range"
                  min="1.5"
                  max="8"
                  step="0.5"
                  disabled={!track.deEsser?.enabled}
                  value={track.deEsser?.ratio || 4}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      deEsser: { ...(track.deEsser || createNewTrack(track.id).deEsser), ratio: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-rose-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Attack */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Attack</div>
                <div className="text-xs font-mono font-bold text-rose-400">{(track.deEsser?.attackMs || 1.0).toFixed(1)} ms</div>
                <input
                  type="range"
                  min="0.1"
                  max="10"
                  step="0.1"
                  disabled={!track.deEsser?.enabled}
                  value={track.deEsser?.attackMs || 1.0}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      deEsser: { ...(track.deEsser || createNewTrack(track.id).deEsser), attackMs: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-rose-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Release */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Release</div>
                <div className="text-xs font-mono font-bold text-rose-400">{(track.deEsser?.releaseMs || 40.0).toFixed(0)} ms</div>
                <input
                  type="range"
                  min="5"
                  max="200"
                  step="5"
                  disabled={!track.deEsser?.enabled}
                  value={track.deEsser?.releaseMs || 40}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      deEsser: { ...(track.deEsser || createNewTrack(track.id).deEsser), releaseMs: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-rose-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}

        {/* Auto-Ducking Tab */}
        {activeTab === 'ducking' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-900">
              <span className="text-xs font-bold text-purple-400 uppercase tracking-wider flex items-center gap-1">
                <Volume2 size={13} /> Auto-Ducking (Сайдчейн приглушение под голос)
              </span>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 font-bold cursor-pointer">
                <input
                  type="checkbox"
                  checked={track.autoDucker.enabled}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      autoDucker: { ...track.autoDucker, enabled: e.target.checked }
                    })
                  }
                  className="rounded accent-purple-500"
                />
                <span>Модуль Включен</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
              {/* Trigger Source */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Голос-триггер</div>
                <select
                  disabled={!track.autoDucker.enabled}
                  value={track.autoDucker.sourceTrackId}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      autoDucker: { ...track.autoDucker, sourceTrackId: parseInt(e.target.value, 10) }
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded p-1 focus:outline-none focus:border-purple-500"
                >
                  {toSafeArray<TrackState>(allTracks).map((t) => (
                    <option key={t.id} value={t.id} disabled={t.id === track.id}>
                      {t.id === track.id ? `${t.name} (текущий)` : `CH ${t.id}: ${t.name}`}
                    </option>
                  ))}
                </select>
              </div>

              {/* Duck Depth */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Depth</div>
                <div className="text-xs font-mono font-bold text-purple-400">{track.autoDucker.duckDepthDb} dB</div>
                <input
                  type="range"
                  min="-30"
                  max="-3"
                  step="1"
                  disabled={!track.autoDucker.enabled}
                  value={track.autoDucker.duckDepthDb}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      autoDucker: { ...track.autoDucker, duckDepthDb: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-purple-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Threshold */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Threshold</div>
                <div className="text-xs font-mono font-bold text-purple-400">{track.autoDucker.thresholdDb} dB</div>
                <input
                  type="range"
                  min="-40"
                  max="-10"
                  step="1"
                  disabled={!track.autoDucker.enabled}
                  value={track.autoDucker.thresholdDb}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      autoDucker: { ...track.autoDucker, thresholdDb: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-purple-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Attack */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Attack</div>
                <div className="text-xs font-mono font-bold text-purple-400">{track.autoDucker.attackMs} ms</div>
                <input
                  type="range"
                  min="5"
                  max="100"
                  step="5"
                  disabled={!track.autoDucker.enabled}
                  value={track.autoDucker.attackMs}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      autoDucker: { ...track.autoDucker, attackMs: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-purple-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Release */}
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800/80 space-y-1.5">
                <div className="text-[9px] text-slate-400 font-bold uppercase">Release</div>
                <div className="text-xs font-mono font-bold text-purple-400">{track.autoDucker.releaseMs} ms</div>
                <input
                  type="range"
                  min="50"
                  max="1000"
                  step="25"
                  disabled={!track.autoDucker.enabled}
                  value={track.autoDucker.releaseMs}
                  onChange={(e) =>
                    onUpdateTrack({
                      ...track,
                      autoDucker: { ...track.autoDucker, releaseMs: parseFloat(e.target.value) }
                    })
                  }
                  className="w-full accent-purple-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
