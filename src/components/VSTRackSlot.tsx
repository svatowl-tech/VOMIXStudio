import React, { useState } from 'react';
import {
  VSTPluginInstance,
  VSTPluginDefinition,
  VSTPluginCategory
} from '../audio/vstTypes';
import { globalVSTHostEngine } from '../services/VSTHostEngine';
import {
  Layers,
  Plus,
  Power,
  Trash2,
  Sliders,
  ChevronDown,
  ChevronUp,
  X,
  Search,
  Zap,
  SlidersHorizontal,
  Volume2,
  Sparkles,
  ShieldCheck,
  CheckCircle2,
  ArrowUp,
  ArrowDown
} from 'lucide-react';

interface VSTRackSlotProps {
  plugins: VSTPluginInstance[];
  title?: string;
  badge?: string;
  color?: string;
  compact?: boolean;
  onUpdateChain: (plugins: VSTPluginInstance[]) => void;
  onUpdateParam: (instanceId: string, paramId: string, value: number) => void;
  onUpdateBypass: (instanceId: string, enabled: boolean) => void;
  onUpdateWetDry: (instanceId: string, wetDry: number) => void;
}

export const VSTRackSlot: React.FC<VSTRackSlotProps> = ({
  plugins,
  title = 'VST Inserts',
  badge,
  color = '#10b981',
  compact = false,
  onUpdateChain,
  onUpdateParam,
  onUpdateBypass,
  onUpdateWetDry
}) => {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [activePluginModal, setActivePluginModal] = useState<VSTPluginInstance | null>(null);

  const availableCatalog = globalVSTHostEngine.getEnabledPlugins();

  const filteredCatalog = availableCatalog.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.vendor.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCat = selectedCategory === 'all' || p.category.toLowerCase() === selectedCategory.toLowerCase();
    return matchesSearch && matchesCat;
  });

  const handleAddPlugin = (def: VSTPluginDefinition) => {
    const newInstance = globalVSTHostEngine.createPluginInstance(def.id);
    const updated = [...plugins, newInstance];
    onUpdateChain(updated);
    setShowAddMenu(false);
    setSearchQuery('');
    // Open editor right away for quick tweaking
    setActivePluginModal(newInstance);
  };

  const handleRemovePlugin = (instanceId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = plugins.filter((p) => p.instanceId !== instanceId);
    onUpdateChain(updated);
    if (activePluginModal?.instanceId === instanceId) {
      setActivePluginModal(null);
    }
  };

  const handleMovePlugin = (index: number, direction: 'up' | 'down', e: React.MouseEvent) => {
    e.stopPropagation();
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= plugins.length) return;
    const newChain = [...plugins];
    const temp = newChain[index];
    newChain[index] = newChain[targetIdx];
    newChain[targetIdx] = temp;
    onUpdateChain(newChain);
  };

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 font-semibold text-slate-300">
          <Layers size={13} style={{ color }} />
          <span>{title}</span>
          {badge && (
            <span className="text-[9px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono border border-slate-700">
              {badge}
            </span>
          )}
          <span className="text-[10px] text-slate-500 font-mono">({plugins.length})</span>
        </div>

        {/* Add Plugin Button */}
        <button
          onClick={() => setShowAddMenu(!showAddMenu)}
          className="px-2 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 hover:border-slate-600 text-slate-200 rounded-md text-[11px] font-medium transition-all flex items-center gap-1 cursor-pointer shadow-sm"
          title="Добавить VST / CLAP плагин в цепочку"
        >
          <Plus size={11} className="text-emerald-400" />
          <span>+ VST</span>
        </button>
      </div>

      {/* Catalog Selector Dropdown / Popover */}
      {showAddMenu && (
        <div className="bg-[#0b0f19] border border-slate-700 rounded-xl p-3 shadow-2xl space-y-2.5 animate-fadeIn z-30 relative">
          <div className="flex items-center justify-between pb-1.5 border-b border-slate-800">
            <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
              <Zap size={13} className="text-amber-400" /> Каталог плагинов
            </span>
            <button
              onClick={() => setShowAddMenu(false)}
              className="text-slate-400 hover:text-slate-200 p-1 rounded hover:bg-slate-800"
            >
              <X size={13} />
            </button>
          </div>

          {/* Search Bar */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-2.5 text-slate-500" />
            <input
              type="text"
              placeholder="Поиск VST3 / CLAP плагина..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              autoFocus
            />
          </div>

          {/* Categories */}
          <div className="flex flex-wrap gap-1">
            {['all', 'EQ', 'Dynamics', 'Reverb', 'Tape/Saturation', 'Tools'].map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer ${
                  selectedCategory === cat
                    ? 'bg-cyan-600 text-white'
                    : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
              >
                {cat === 'all' ? 'Все' : cat}
              </button>
            ))}
          </div>

          {/* Plugin list */}
          <div className="max-h-48 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
            {filteredCatalog.length === 0 ? (
              <div className="text-center py-4 text-xs text-slate-500">
                Плагины не найдены
              </div>
            ) : (
              filteredCatalog.map((plugin) => (
                <button
                  key={plugin.id}
                  onClick={() => handleAddPlugin(plugin)}
                  className="w-full text-left p-2 rounded-lg bg-slate-900/80 hover:bg-slate-800/90 border border-slate-800/80 hover:border-cyan-500/40 transition-all flex items-center justify-between group cursor-pointer"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-xs font-semibold text-slate-200 group-hover:text-cyan-300 truncate">
                      {plugin.name}
                    </div>
                    <div className="text-[10px] text-slate-500 truncate flex items-center gap-1.5 mt-0.5">
                      <span>{plugin.vendor}</span>
                      <span>•</span>
                      <span>{plugin.category}</span>
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center gap-1">
                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-slate-950 text-cyan-400 font-mono border border-slate-800">
                      {plugin.format}
                    </span>
                    <Plus size={13} className="text-slate-400 group-hover:text-cyan-400 ml-1" />
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Inserted Plugins List */}
      {plugins.length === 0 ? (
        <div
          onClick={() => setShowAddMenu(true)}
          className="border border-dashed border-slate-800 hover:border-slate-700 bg-slate-950/40 rounded-lg py-2.5 px-3 text-center cursor-pointer transition-colors"
        >
          <span className="text-[11px] text-slate-500 flex items-center justify-center gap-1.5">
            <Plus size={12} className="text-slate-600" />
            Нажмите, чтобы вставить VST
          </span>
        </div>
      ) : (
        <div className="space-y-1.5">
          {plugins.map((inst, index) => {
            const def = globalVSTHostEngine.getPluginById(inst.pluginId);
            const isBypassed = !inst.enabled;

            return (
              <div
                key={inst.instanceId}
                onClick={() => setActivePluginModal(inst)}
                className={`p-2 rounded-lg border transition-all cursor-pointer group ${
                  isBypassed
                    ? 'bg-slate-950/60 border-slate-800/60 opacity-60'
                    : 'bg-[#121826] hover:bg-[#172033] border-slate-800 hover:border-cyan-500/40 shadow-sm'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  {/* Left: Index & Name & Format */}
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateBypass(inst.instanceId, !inst.enabled);
                      }}
                      className={`p-1 rounded transition-colors ${
                        inst.enabled
                          ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                          : 'bg-slate-900 text-slate-600 hover:text-slate-400'
                      }`}
                      title={inst.enabled ? 'Включен (Bypass)' : 'Выключен (Bypassed)'}
                    >
                      <Power size={11} />
                    </button>

                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-200 truncate flex items-center gap-1.5">
                        <span className="text-[10px] text-slate-500 font-mono">{index + 1}.</span>
                        <span className={isBypassed ? 'line-through text-slate-500' : ''}>
                          {inst.name || def?.name || inst.pluginId}
                        </span>
                      </div>
                      <div className="text-[9px] text-slate-500 flex items-center gap-1">
                        <span className="text-cyan-400/80 font-mono">{def?.format || 'VST3'}</span>
                        <span>•</span>
                        <span>Wet: {Math.round((inst.wetDry ?? 1.0) * 100)}%</span>
                      </div>
                    </div>
                  </div>

                  {/* Right: Controls (Reorder, GUI/Params, Delete) */}
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {/* Move buttons */}
                    {plugins.length > 1 && (
                      <div className="flex flex-col">
                        {index > 0 && (
                          <button
                            onClick={(e) => handleMovePlugin(index, 'up', e)}
                            className="p-0.5 text-slate-500 hover:text-slate-300"
                            title="Переместить вверх"
                          >
                            <ChevronUp size={11} />
                          </button>
                        )}
                        {index < plugins.length - 1 && (
                          <button
                            onClick={(e) => handleMovePlugin(index, 'down', e)}
                            className="p-0.5 text-slate-500 hover:text-slate-300"
                            title="Переместить вниз"
                          >
                            <ChevronDown size={11} />
                          </button>
                        )}
                      </div>
                    )}

                    {/* Edit params button */}
                    <button
                      onClick={() => setActivePluginModal(inst)}
                      className="p-1.5 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-cyan-400 border border-slate-800"
                      title="Настройки параметров плагина"
                    >
                      <Sliders size={11} />
                    </button>

                    {/* Remove button */}
                    <button
                      onClick={(e) => handleRemovePlugin(inst.instanceId, e)}
                      className="p-1.5 rounded bg-slate-900 hover:bg-rose-950/40 text-slate-500 hover:text-rose-400 border border-slate-800"
                      title="Удалить из цепочки"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Floating VST Plugin Parameters GUI Modal */}
      {activePluginModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-[#0f1422] border border-cyan-500/30 rounded-2xl max-w-xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Modal Header */}
            {(() => {
              const def = globalVSTHostEngine.getPluginById(activePluginModal.pluginId);
              return (
                <div className="p-4 border-b border-slate-800 bg-slate-900/80 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-cyan-500/10 border border-cyan-500/20 rounded-xl text-cyan-400">
                      <SlidersHorizontal size={18} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold text-slate-100">{def?.name || activePluginModal.pluginId}</h3>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 font-mono border border-cyan-500/30">
                          {def?.format || 'VST3'}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono">
                          {def?.vendor}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5">{def?.description}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        onUpdateBypass(activePluginModal.instanceId, !activePluginModal.enabled);
                        setActivePluginModal({
                          ...activePluginModal,
                          enabled: !activePluginModal.enabled
                        });
                      }}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                        activePluginModal.enabled
                          ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}
                    >
                      <Power size={12} />
                      {activePluginModal.enabled ? 'Active' : 'Bypassed'}
                    </button>

                    <button
                      onClick={() => setActivePluginModal(null)}
                      className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800"
                    >
                      <X size={18} />
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* Modal Body: Wet/Dry & Parameter Sliders */}
            <div className="p-5 overflow-y-auto space-y-5 custom-scrollbar flex-1">
              {/* Global Wet/Dry */}
              <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800/80 space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                    <Volume2 size={13} className="text-cyan-400" /> Wet / Dry Mix
                  </span>
                  <span className="font-mono text-cyan-400 font-bold">
                    {Math.round((activePluginModal.wetDry ?? 1.0) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={activePluginModal.wetDry ?? 1.0}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onUpdateWetDry(activePluginModal.instanceId, val);
                    setActivePluginModal({
                      ...activePluginModal,
                      wetDry: val
                    });
                  }}
                  className="w-full accent-cyan-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                />
              </div>

              {/* Dynamic Plugin Parameter Knobs/Sliders */}
              {(() => {
                const def = globalVSTHostEngine.getPluginById(activePluginModal.pluginId);
                if (!def || !def.parameters || def.parameters.length === 0) {
                  return (
                    <div className="text-center py-6 text-xs text-slate-500">
                      У данного плагина нет настраиваемых параметров.
                    </div>
                  );
                }

                return (
                  <div className="space-y-3">
                    <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                      <Sliders size={13} className="text-emerald-400" /> Параметры обработки DSP
                    </h4>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {def.parameters.map((param) => {
                        const currentVal = activePluginModal.parameters?.[param.id] ?? param.defaultValue;

                        return (
                          <div
                            key={param.id}
                            className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2"
                          >
                            <div className="flex justify-between text-xs">
                              <span className="text-slate-300 font-medium truncate max-w-[140px]" title={param.name}>
                                {param.name}
                              </span>
                              <span className="font-mono text-emerald-400 font-semibold text-[11px]">
                                {typeof currentVal === 'number' ? currentVal.toFixed(param.step && param.step < 1 ? 1 : 0) : currentVal} {param.unit}
                              </span>
                            </div>

                            <input
                              type="range"
                              min={param.min}
                              max={param.max}
                              step={param.step || (param.max - param.min) / 100}
                              value={currentVal}
                              onChange={(e) => {
                                const val = parseFloat(e.target.value);
                                onUpdateParam(activePluginModal.instanceId, param.id, val);
                                setActivePluginModal({
                                  ...activePluginModal,
                                  parameters: {
                                    ...activePluginModal.parameters,
                                    [param.id]: val
                                  }
                                });
                              }}
                              className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                            />

                            <div className="flex justify-between text-[9px] text-slate-600 font-mono">
                              <span>{param.min} {param.unit}</span>
                              <span>{param.max} {param.unit}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-900/60 flex justify-between items-center text-xs">
              <span className="text-slate-400 text-[11px] font-mono">
                Latency: {globalVSTHostEngine.getPluginById(activePluginModal.pluginId)?.latencySamples || 0} smp
              </span>

              <button
                onClick={() => setActivePluginModal(null)}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-xl transition-all cursor-pointer"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
