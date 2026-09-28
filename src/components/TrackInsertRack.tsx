import React, { useState } from 'react';
import {
  TrackInsertEffect,
  NATIVE_DSP_CATALOG,
  getEffectDefinition,
  createDefaultInsertEffect,
  createDefaultVocalInsertChain,
  NativeEffectDefinition
} from '../audio/nativeEffectsCatalog';
import {
  Sliders,
  Plus,
  Power,
  Trash2,
  ChevronDown,
  ChevronUp,
  X,
  Sparkles,
  RotateCcw,
  Layers,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  Volume2
} from 'lucide-react';

interface TrackInsertRackProps {
  trackId: number;
  trackName: string;
  trackColor?: string;
  effects: TrackInsertEffect[];
  compact?: boolean;
  onUpdateEffects: (updated: TrackInsertEffect[]) => void;
  onSetEffectParam: (slotIdx: number, paramId: number, value: number) => void;
  onSetEffectBypass: (slotIdx: number, bypass: boolean) => void;
}

export const TrackInsertRack: React.FC<TrackInsertRackProps> = ({
  trackId,
  trackName,
  trackColor = '#10b981',
  effects,
  compact = false,
  onUpdateEffects,
  onSetEffectParam,
  onSetEffectBypass
}) => {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSlots, setExpandedSlots] = useState<Record<string, boolean>>({});

  const categories = [
    { id: 'all', label: 'Все (16)' },
    { id: 'restoration', label: 'Реставрация' },
    { id: 'dynamics', label: 'Динамика' },
    { id: 'eq', label: 'EQ' },
    { id: 'color', label: 'Окрас' },
    { id: 'spatial', label: 'Пространство' },
    { id: 'filter', label: 'Фильтры' }
  ];

  const filteredCatalog = NATIVE_DSP_CATALOG.filter((item) => {
    const matchCat = selectedCategory === 'all' || item.category === selectedCategory;
    const matchSearch =
      item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (item.badge && item.badge.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchCat && matchSearch;
  });

  const toggleExpand = (id: string) => {
    setExpandedSlots((prev) => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const handleAddEffect = (def: NativeEffectDefinition) => {
    const newEff = createDefaultInsertEffect(def.typeId);
    const updated = [...effects, newEff];
    onUpdateEffects(updated);
    setExpandedSlots((prev) => ({ ...prev, [newEff.id]: true }));
    setShowAddMenu(false);
    setSearchQuery('');
  };

  const handleRemove = (slotIdx: number) => {
    const updated = effects.filter((_, idx) => idx !== slotIdx);
    onUpdateEffects(updated);
  };

  const handleMove = (slotIdx: number, direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? slotIdx - 1 : slotIdx + 1;
    if (targetIdx < 0 || targetIdx >= effects.length) return;
    const updated = [...effects];
    const [moved] = updated.splice(slotIdx, 1);
    updated.splice(targetIdx, 0, moved);
    onUpdateEffects(updated);
  };

  const handleLoadVocalPreset = () => {
    const defaultChain = createDefaultVocalInsertChain();
    onUpdateEffects(defaultChain);
    const newExpanded: Record<string, boolean> = {};
    defaultChain.forEach((eff) => {
      newExpanded[eff.id] = false;
    });
    if (defaultChain[0]) newExpanded[defaultChain[0].id] = true;
    setExpandedSlots(newExpanded);
  };

  const handleParamChange = (slotIdx: number, paramId: number, value: number) => {
    onSetEffectParam(slotIdx, paramId, value);
    const updated = [...effects];
    if (updated[slotIdx]) {
      updated[slotIdx] = {
        ...updated[slotIdx],
        params: {
          ...updated[slotIdx].params,
          [paramId]: value
        }
      };
      onUpdateEffects(updated);
    }
  };

  const handleBypassToggle = (slotIdx: number) => {
    const eff = effects[slotIdx];
    if (!eff) return;
    const newBypass = !eff.bypassed;
    onSetEffectBypass(slotIdx, newBypass);
    const updated = [...effects];
    updated[slotIdx] = {
      ...updated[slotIdx],
      bypassed: newBypass
    };
    onUpdateEffects(updated);
  };

  return (
    <div className="space-y-3">
      {/* Rack Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: trackColor }} />
          <span className="text-xs font-bold text-slate-200">
            Нативный рэк эффектов C++
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            {effects.length} FX
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={handleLoadVocalPreset}
            title="Загрузить профессиональную цепочку: De-Clicker → Breath → EQ Pro → Comp → De-Esser"
            className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-amber-400 border border-amber-500/30 text-[10px] font-medium transition-all"
          >
            <Sparkles size={11} />
            <span>Пресет вокала</span>
          </button>

          <button
            onClick={() => setShowAddMenu(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold transition-all shadow-sm shadow-emerald-600/30"
          >
            <Plus size={12} />
            <span>Добавить</span>
          </button>
        </div>
      </div>

      {/* Slots List */}
      {effects.length === 0 ? (
        <div className="p-6 text-center border border-dashed border-slate-800 rounded-xl bg-slate-900/50">
          <Layers className="w-8 h-8 mx-auto text-slate-600 mb-2" />
          <p className="text-xs text-slate-400 font-medium">
            В цепочке дорожки «{trackName}» нет эффектов
          </p>
          <p className="text-[11px] text-slate-500 mt-1 mb-3">
            Подключите любой из 16 нативных C++ DSP-модулей студийной обработки
          </p>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={handleLoadVocalPreset}
              className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-xs font-semibold flex items-center gap-1.5 transition-all"
            >
              <Sparkles size={13} />
              Загрузить пресет дубляжа
            </button>
            <button
              onClick={() => setShowAddMenu(true)}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-all"
            >
              <Plus size={13} />
              Выбрать эффект
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {effects.map((eff, slotIdx) => {
            const def = getEffectDefinition(eff.typeId);
            const isExpanded = !!expandedSlots[eff.id];
            const effColor = def?.color || '#10b981';

            return (
              <div
                key={eff.id}
                className={`rounded-xl border transition-all ${
                  eff.bypassed
                    ? 'bg-slate-900/60 border-slate-800/80 opacity-60'
                    : 'bg-slate-900/90 border-slate-800 shadow-md shadow-slate-950/40'
                }`}
              >
                {/* Slot Header */}
                <div
                  onClick={() => toggleExpand(eff.id)}
                  className="p-2.5 flex items-center justify-between cursor-pointer select-none group"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-slate-500 w-4 text-center">
                      {slotIdx + 1}
                    </span>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleBypassToggle(slotIdx);
                      }}
                      title={eff.bypassed ? 'Включить эффект' : 'Байпас (отключить)'}
                      className={`w-6 h-6 rounded flex items-center justify-center transition-all ${
                        eff.bypassed
                          ? 'bg-slate-800 text-slate-500 hover:text-slate-300'
                          : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 shadow-sm shadow-emerald-500/20'
                      }`}
                    >
                      <Power size={11} />
                    </button>

                    <div className="flex flex-col">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-slate-100 group-hover:text-emerald-300 transition-colors">
                          {eff.name}
                        </span>
                        {def?.badge && (
                          <span
                            className="text-[9px] px-1 py-0.2 rounded font-mono font-medium"
                            style={{
                              backgroundColor: `${effColor}20`,
                              color: effColor,
                              border: `1px solid ${effColor}40`
                            }}
                          >
                            {def.badge}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-slate-400">
                        {def?.categoryLabel || def?.category}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {/* Reorder Buttons */}
                    <button
                      disabled={slotIdx === 0}
                      onClick={() => handleMove(slotIdx, 'up')}
                      title="Переместить выше"
                      className="p-1 rounded text-slate-500 hover:text-slate-200 disabled:opacity-30 disabled:hover:text-slate-500 transition-colors"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      disabled={slotIdx === effects.length - 1}
                      onClick={() => handleMove(slotIdx, 'down')}
                      title="Переместить ниже"
                      className="p-1 rounded text-slate-500 hover:text-slate-200 disabled:opacity-30 disabled:hover:text-slate-500 transition-colors"
                    >
                      <ArrowDown size={12} />
                    </button>

                    {/* Remove Button */}
                    <button
                      onClick={() => handleRemove(slotIdx)}
                      title="Удалить слот"
                      className="p-1 rounded text-slate-500 hover:text-rose-400 transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>

                    <button
                      onClick={() => toggleExpand(eff.id)}
                      className="p-1 rounded text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                  </div>
                </div>

                {/* Slot Parameter Controls (Expanded) */}
                {isExpanded && def && (
                  <div className="px-3 pb-3 pt-1 border-t border-slate-800/80 bg-slate-950/40">
                    <p className="text-[10px] text-slate-400 mb-2 italic">
                      {def.description}
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                      {def.params.map((p) => {
                        const val = eff.params[p.id] !== undefined ? eff.params[p.id] : p.default;

                        if (p.isToggle) {
                          const isActive = val > 0.5;
                          return (
                            <div
                              key={p.id}
                              className="bg-slate-900/80 p-2 rounded-lg border border-slate-800 flex items-center justify-between"
                            >
                              <span className="text-[10px] font-medium text-slate-300">
                                {p.name}
                              </span>
                              <button
                                onClick={() => handleParamChange(slotIdx, p.id, isActive ? 0 : 1)}
                                className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all ${
                                  isActive
                                    ? 'bg-emerald-600 text-white'
                                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                                }`}
                              >
                                {isActive ? 'ON' : 'OFF'}
                              </button>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={p.id}
                            className="bg-slate-900/80 p-2 rounded-lg border border-slate-800 space-y-1"
                          >
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="font-medium text-slate-400">{p.name}</span>
                              <span className="font-mono text-emerald-400 font-bold">
                                {val.toFixed(p.step < 0.1 ? 2 : p.step < 1 ? 1 : 0)} {p.unit}
                              </span>
                            </div>

                            <input
                              type="range"
                              min={p.min}
                              max={p.max}
                              step={p.step}
                              value={val}
                              onChange={(e) =>
                                handleParamChange(slotIdx, p.id, parseFloat(e.target.value))
                              }
                              className="w-full accent-emerald-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                            />

                            <div className="flex justify-between text-[9px] font-mono text-slate-500">
                              <span>{p.min}</span>
                              <span>{p.max}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Effect Catalog Modal */}
      {showAddMenu && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                  <Sliders className="text-emerald-400" size={16} />
                  Добавить нативный DSP эффект
                </h3>
                <p className="text-[11px] text-slate-400">
                  Дорожка: <span className="text-emerald-400 font-semibold">{trackName}</span> · Выберите процессор из 16 C++17 модулей
                </p>
              </div>

              <button
                onClick={() => setShowAddMenu(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Search and Category Filter */}
            <div className="p-3 border-b border-slate-800 space-y-2 bg-slate-950/30">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Поиск по названию или описанию (EQ, Tape, Breath, Reverb...)"
                className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              />

              <div className="flex flex-wrap gap-1">
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
                      selectedCategory === cat.id
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Effect Grid */}
            <div className="p-4 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {filteredCatalog.map((item) => (
                <div
                  key={item.typeId}
                  onClick={() => handleAddEffect(item)}
                  className="p-3 rounded-xl border border-slate-800 hover:border-emerald-500/60 bg-slate-950/40 hover:bg-slate-800/50 cursor-pointer transition-all group flex flex-col justify-between space-y-2"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-100 group-hover:text-emerald-300 transition-colors">
                        {item.name}
                      </span>
                      {item.badge && (
                        <span
                          className="text-[9px] px-1.5 py-0.5 rounded font-mono font-medium"
                          style={{
                            backgroundColor: `${item.color}20`,
                            color: item.color,
                            border: `1px solid ${item.color}40`
                          }}
                        >
                          {item.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 leading-tight">
                      {item.description}
                    </p>
                  </div>

                  <div className="flex items-center justify-between pt-1 border-t border-slate-800/60 text-[10px] text-slate-500">
                    <span>{item.categoryLabel}</span>
                    <span className="text-emerald-400 font-medium group-hover:underline">
                      + Добавить в рэк
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Modal Footer */}
            <div className="p-3 border-t border-slate-800 bg-slate-950/50 flex items-center justify-between text-xs text-slate-400">
              <span>Доступно: {filteredCatalog.length} модулей</span>
              <button
                onClick={() => setShowAddMenu(false)}
                className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
