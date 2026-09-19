import React from 'react';
import { TrackState } from '../audio/dawEngine';
import {
  Sliders,
  Activity,
  Mic,
  Radio,
  Music,
  Zap,
  RotateCcw,
  X,
  Volume2
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
  // Preset Handlers
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
        autoDucker: {
          ...updated.autoDucker,
          enabled: false
        }
      };
    } else if (type === 'broadcast') {
      updated = {
        ...updated,
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 100, gainDb: 2.0, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 2800, gainDb: 4.0, Q: 1.0, enabled: true },
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
      // Flat
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
      id="dsp-rack-modal"
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="bg-[#0b101b] border border-slate-700/80 w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-2xl p-6 space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка модального окна */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div
              className="w-4 h-4 rounded-full shadow-md"
              style={{ backgroundColor: track.color || '#3b82f6' }}
            />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100">
                  C++ DSP Vocal Rack: {track.name}
                </h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800">
                  CH {track.id}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Аппаратный алгоритм обработки голоса: 3-полосный EQ, Soft-Knee компрессор и авто-даккинг
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded-xl transition-all cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Быстрые пресеты голоса */}
        <div className="space-y-2">
          <span className="text-xs font-semibold text-slate-300">Быстрые звуковые пресеты:</span>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => applyPreset('dialogue')}
              className="px-3 py-1.5 bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/80 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <Mic size={13} />
              🎙️ Чистый дубляж / Вокал
            </button>
            <button
              onClick={() => applyPreset('broadcast')}
              className="px-3 py-1.5 bg-cyan-950/40 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-800/80 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <Radio size={13} />
              📻 Дикторский Punch (Радио)
            </button>
            <button
              onClick={() => applyPreset('music')}
              className="px-3 py-1.5 bg-purple-950/40 hover:bg-purple-900/60 text-purple-300 border border-purple-800/80 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <Music size={13} />
              🎵 Фоновая музыка (Auto-Duck)
            </button>
            <button
              onClick={() => applyPreset('sfx')}
              className="px-3 py-1.5 bg-amber-950/40 hover:bg-amber-900/60 text-amber-300 border border-amber-800/80 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <Zap size={13} />
              💥 Киноэффекты / SFX
            </button>
            <button
              onClick={() => applyPreset('flat')}
              className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <RotateCcw size={13} />
              Сброс (Flat)
            </button>
          </div>
        </div>

        {/* Сетка модулей DSP */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* МОДУЛЬ 1: 3-Band Parametric EQ */}
          <div className="bg-[#0f1422] border border-slate-800 p-4 rounded-xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Sliders size={16} className="text-cyan-400" />
                <h3 className="text-xs font-bold text-slate-200">3-Полосный Biquad EQ</h3>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
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
                <span>Вкл</span>
              </label>
            </div>

            {/* Low Shelf */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-400">Низ (Low Shelf {track.eq.lowShelf.frequency} Hz):</span>
                <span className="font-mono text-cyan-400 font-bold">
                  {track.eq.lowShelf.gainDb >= 0 ? `+${track.eq.lowShelf.gainDb.toFixed(1)}` : track.eq.lowShelf.gainDb.toFixed(1)} dB
                </span>
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
                className="w-full accent-cyan-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>

            {/* Mid Peaking */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-400">Середина (Mid {track.eq.peaking.frequency} Hz):</span>
                <span className="font-mono text-cyan-400 font-bold">
                  {track.eq.peaking.gainDb >= 0 ? `+${track.eq.peaking.gainDb.toFixed(1)}` : track.eq.peaking.gainDb.toFixed(1)} dB
                </span>
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
                className="w-full accent-cyan-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>

            {/* High Shelf */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-400">Верх (High Shelf {track.eq.highShelf.frequency} Hz):</span>
                <span className="font-mono text-cyan-400 font-bold">
                  {track.eq.highShelf.gainDb >= 0 ? `+${track.eq.highShelf.gainDb.toFixed(1)}` : track.eq.highShelf.gainDb.toFixed(1)} dB
                </span>
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
                className="w-full accent-cyan-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>
          </div>

          {/* МОДУЛЬ 2: Soft-Knee Compressor */}
          <div className="bg-[#0f1422] border border-slate-800 p-4 rounded-xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Activity size={16} className="text-emerald-400" />
                <h3 className="text-xs font-bold text-slate-200">Vocal Compressor</h3>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
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
                <span>Вкл</span>
              </label>
            </div>

            {/* Threshold */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-400">Порог (Threshold):</span>
                <span className="font-mono text-emerald-400 font-bold">
                  {track.compressor.thresholdDb} dB
                </span>
              </div>
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
                className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>

            {/* Ratio */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-400">Сжатие (Ratio):</span>
                <span className="font-mono text-emerald-400 font-bold">
                  {track.compressor.ratio.toFixed(1)}:1
                </span>
              </div>
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
                className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>

            {/* Makeup Gain */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-400">Компенсация (Makeup):</span>
                <span className="font-mono text-emerald-400 font-bold">
                  {track.compressor.makeupGainDb >= 0 ? `+${track.compressor.makeupGainDb.toFixed(1)}` : track.compressor.makeupGainDb.toFixed(1)} dB
                </span>
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
                className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>
          </div>

          {/* МОДУЛЬ 3: Auto-Ducking (Sidechain) */}
          <div className="bg-[#0f1422] border border-slate-800 p-4 rounded-xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Volume2 size={16} className="text-purple-400" />
                <h3 className="text-xs font-bold text-slate-200">Auto-Ducking (Сайдчейн)</h3>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
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
                <span>Вкл</span>
              </label>
            </div>

            {/* Источник голоса */}
            <div className="space-y-1">
              <span className="text-[11px] text-slate-400">Голос-триггер (Источник):</span>
              <select
                disabled={!track.autoDucker.enabled}
                value={track.autoDucker.sourceTrackId}
                onChange={(e) =>
                  onUpdateTrack({
                    ...track,
                    autoDucker: { ...track.autoDucker, sourceTrackId: parseInt(e.target.value, 10) }
                  })
                }
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded-lg p-1.5 focus:outline-none focus:border-purple-500"
              >
                {allTracks.map((t) => (
                  <option key={t.id} value={t.id} disabled={t.id === track.id}>
                    {t.id === track.id ? `${t.name} (текущий)` : `CH ${t.id}: ${t.name}`}
                  </option>
                ))}
              </select>
            </div>

            {/* Duck Depth */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-400">Глубина приглушения:</span>
                <span className="font-mono text-purple-400 font-bold">
                  {track.autoDucker.duckDepthDb} dB
                </span>
              </div>
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
                className="w-full accent-purple-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>

            {/* Threshold */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-400">Порог срабатывания:</span>
                <span className="font-mono text-purple-400 font-bold">
                  {track.autoDucker.thresholdDb} dB
                </span>
              </div>
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
                className="w-full accent-purple-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-3 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl text-xs transition-all shadow-lg shadow-blue-950/40 cursor-pointer"
          >
            Применить настройки DSP
          </button>
        </div>
      </div>
    </div>
  );
};
