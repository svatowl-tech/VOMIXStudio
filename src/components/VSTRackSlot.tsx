import React, { useState, useCallback } from 'react';
import {
  VSTPluginInstance,
  VSTPluginDefinition
} from '../audio/vstTypes';
import { globalVSTHostEngine } from '../services/VSTHostEngine';
import { TauriNativeBridge } from '../services/TauriNativeBridge';
import { VSTGraphicalUIWindow } from './VSTGraphicalUIWindow';
import { VSTQuickKnob } from './VSTQuickKnob';
import { VSTGainReductionMeter } from './VSTGainReductionMeter';
import {
  Layers,
  Plus,
  Power,
  Trash2,
  ChevronDown,
  ChevronUp,
  X,
  Search,
  Zap,
  Maximize2,
  Copy,
  ExternalLink,
  Monitor,
  Sparkles,
  Info,
  CheckCircle2,
  SlidersHorizontal,
  AppWindow
} from 'lucide-react';

interface VSTRackSlotProps {
  plugins: VSTPluginInstance[];
  trackId?: number | string;
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
  trackId = 1,
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
  const [expandedSlots, setExpandedSlots] = useState<Record<string, boolean>>({});
  const [nativeGuiInfoModal, setNativeGuiInfoModal] = useState<{ isOpen: boolean; pluginName: string; instance: VSTPluginInstance | null }>({
    isOpen: false,
    pluginName: '',
    instance: null
  });
  const [nativeWindowsActive, setNativeWindowsActive] = useState<Record<string, boolean>>({});

  // Хранилище состояний A/B сравнения пресетов
  const [abState, setAbState] = useState<Record<string, { current: 'A' | 'B'; stateA: Record<string, number>; stateB: Record<string, number> }>>({});

  const isDesktop = TauriNativeBridge.isTauriEnvironment();
  const availableCatalog = globalVSTHostEngine.getEnabledPlugins();

  const filteredCatalog = availableCatalog.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.vendor.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCat = selectedCategory === 'all' || p.category.toLowerCase() === selectedCategory.toLowerCase();
    return matchesSearch && matchesCat;
  });

  const toggleSlotExpanded = (instanceId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedSlots((prev) => ({
      ...prev,
      [instanceId]: !prev[instanceId]
    }));
  };

  const handleAddPlugin = (def: VSTPluginDefinition) => {
    const newInstance = globalVSTHostEngine.createPluginInstance(def.id);
    const updated = [...plugins, newInstance];
    onUpdateChain(updated);
    setShowAddMenu(false);
    setSearchQuery('');
    // Разворачиваем добавленный слот по умолчанию
    setExpandedSlots((prev) => ({ ...prev, [newInstance.instanceId]: true }));
    // Открываем графический редактор для быстрой настройки
    setActivePluginModal(newInstance);
  };

  // Немедленный диспатчер событий регуляторов без задержки рендера
  const handleImmediateParamChange = useCallback((instId: string, paramId: string, value: number) => {
    onUpdateParam(instId, paramId, value);
  }, [onUpdateParam]);

  // Открытие нативного графического окна плагина (Win32 HWND / VST Native GUI)
  const handleOpenNativeGUI = async (inst: VSTPluginInstance, slotIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const def = globalVSTHostEngine.getPluginById(inst.pluginId);
    const pluginName = inst.name || def?.name || inst.pluginId;

    if (isDesktop) {
      const numericTrackId = typeof trackId === 'number' ? trackId : parseInt(String(trackId).replace(/\D/g, ''), 10) || 1;
      const success = await TauriNativeBridge.openPluginGui(numericTrackId, slotIndex, inst.instanceId);
      if (success) {
        setNativeWindowsActive((prev) => ({ ...prev, [inst.instanceId]: true }));
      } else {
        // Fallback к встроенному DSP GUI окну
        setActivePluginModal(inst);
      }
    } else {
      // В Web/WASM режиме показываем информационное окно с переходом в DSP Editor
      setNativeGuiInfoModal({
        isOpen: true,
        pluginName,
        instance: inst
      });
    }
  };

  // Переключение A/B сравнения
  const handleToggleAB = (inst: VSTPluginInstance, target: 'A' | 'B', e: React.MouseEvent) => {
    e.stopPropagation();
    const currentAB = abState[inst.instanceId] || {
      current: 'A',
      stateA: { ...inst.parameters },
      stateB: { ...inst.parameters }
    };

    if (currentAB.current === target) return;

    if (currentAB.current === 'A') {
      currentAB.stateA = { ...inst.parameters };
    } else {
      currentAB.stateB = { ...inst.parameters };
    }

    currentAB.current = target;
    const targetParams = target === 'A' ? currentAB.stateA : currentAB.stateB;

    setAbState((prev) => ({
      ...prev,
      [inst.instanceId]: currentAB
    }));

    // Применяем параметры к движку
    Object.entries(targetParams).forEach(([pId, val]) => {
      onUpdateParam(inst.instanceId, pId, val);
    });

    // Обновляем параметры в цепочке
    const updated = plugins.map((p) =>
      p.instanceId === inst.instanceId ? { ...p, parameters: { ...targetParams } } : p
    );
    onUpdateChain(updated);
  };

  const handleCopyAtoB = (inst: VSTPluginInstance, e: React.MouseEvent) => {
    e.stopPropagation();
    setAbState((prev) => {
      const current = prev[inst.instanceId] || {
        current: 'A',
        stateA: { ...inst.parameters },
        stateB: { ...inst.parameters }
      };
      return {
        ...prev,
        [inst.instanceId]: {
          ...current,
          stateB: { ...inst.parameters }
        }
      };
    });
  };

  const handleRemovePlugin = (instanceId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDesktop && nativeWindowsActive[instanceId]) {
      TauriNativeBridge.closePluginGui(instanceId);
      setNativeWindowsActive((prev) => {
        const copy = { ...prev };
        delete copy[instanceId];
        return copy;
      });
    }
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
      {/* Шапка секции инсертов */}
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

        {/* Кнопка добавления VST плагина */}
        <button
          onClick={() => setShowAddMenu(!showAddMenu)}
          className="px-2 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 hover:border-slate-600 text-slate-200 rounded-md text-[11px] font-medium transition-all flex items-center gap-1 cursor-pointer shadow-sm"
          title="Добавить VST / CLAP плагин в цепочку"
        >
          <Plus size={11} className="text-emerald-400" />
          <span>+ VST</span>
        </button>
      </div>

      {/* Каталог выбора плагина */}
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

          {/* Строка поиска */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-2.5 text-slate-500" />
            <input
              type="text"
              placeholder="Поиск VST3 / CLAP / Waves плагина..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              autoFocus
            />
          </div>

          {/* Фильтр категорий */}
          <div className="flex flex-wrap gap-1">
            {['all', 'EQ', 'Dynamics', 'Reverb', 'Restoration', 'Limiter', 'Saturation', 'Utility'].map((cat) => (
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

          {/* Список плагинов */}
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

      {/* Список добавленных в рэк плагинов */}
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
            const isExpanded = !!expandedSlots[inst.instanceId];
            const isDynamics = def?.category === 'Dynamics' || def?.category === 'Limiter' || inst.pluginId.includes('compressor') || inst.pluginId.includes('limiter') || inst.pluginId.includes('cla76') || inst.pluginId.includes('l2');
            const ab = abState[inst.instanceId] || { current: 'A' };
            const isNativeActive = !!nativeWindowsActive[inst.instanceId];

            let grValue = 0;
            if (isDynamics && inst.enabled) {
              const thresh = inst.parameters['thresh'] ?? inst.parameters['threshold'] ?? inst.parameters['input'] ?? -18;
              const ratio = inst.parameters['ratio'] ?? 4;
              grValue = Math.min(0, Math.max(-24, (thresh + 14) * 0.8 * (ratio > 2 ? 1.2 : 0.8)));
            }

            const wetDryPct = Math.round((inst.wetDry ?? 1.0) * 100);

            return (
              <div
                key={inst.instanceId}
                className={`rounded-xl border transition-all ${
                  isBypassed
                    ? 'bg-slate-950/60 border-slate-800/60 opacity-60'
                    : 'bg-[#111625] hover:bg-[#141b2e] border-slate-800/90 hover:border-cyan-500/40 shadow-sm'
                }`}
              >
                {/* Заголовок слота */}
                <div
                  className="p-2 flex items-center justify-between gap-2 cursor-pointer select-none"
                  onClick={() => toggleSlotExpanded(inst.instanceId)}
                >
                  {/* Кнопка включения/байпаса и имя плагина */}
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateBypass(inst.instanceId, !inst.enabled);
                      }}
                      className={`p-1.5 rounded-lg transition-colors cursor-pointer shrink-0 ${
                        inst.enabled
                          ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                          : 'bg-slate-900 text-slate-600 hover:text-slate-400'
                      }`}
                      title={inst.enabled ? 'Плагин активен (клик для Bypass)' : 'Bypassed (клик для включения)'}
                    >
                      <Power size={11} />
                    </button>

                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-200 truncate flex items-center gap-1.5">
                        <span className="text-[10px] text-slate-500 font-mono">{index + 1}.</span>
                        <span className={isBypassed ? 'line-through text-slate-500' : 'text-slate-100'}>
                          {inst.name || def?.name || inst.pluginId}
                        </span>
                        {isNativeActive && (
                          <span className="text-[8px] font-mono px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                            NATIVE GUI
                          </span>
                        )}
                      </div>
                      <div className="text-[9px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                        <span className="text-cyan-400/90 font-mono">{def?.format || 'VST3'}</span>
                        <span>•</span>
                        <span className="text-slate-500">{def?.category || 'DSP'}</span>
                        {isDynamics && <VSTGainReductionMeter grDb={grValue} active={inst.enabled} />}
                      </div>
                    </div>
                  </div>

                  {/* Элементы управления справа */}
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {/* Переключатель A/B */}
                    <div className="flex items-center bg-slate-950 p-0.5 rounded border border-slate-800 text-[9px] font-mono font-bold mr-1">
                      <button
                        onClick={(e) => handleToggleAB(inst, 'A', e)}
                        className={`px-1.5 py-0.2 rounded transition-colors ${
                          ab.current === 'A'
                            ? 'bg-cyan-600 text-white shadow-xs'
                            : 'text-slate-500 hover:text-slate-300'
                        }`}
                        title="Сравнение A"
                      >
                        A
                      </button>
                      <button
                        onClick={(e) => handleToggleAB(inst, 'B', e)}
                        className={`px-1.5 py-0.2 rounded transition-colors ${
                          ab.current === 'B'
                            ? 'bg-cyan-600 text-white shadow-xs'
                            : 'text-slate-500 hover:text-slate-300'
                        }`}
                        title="Сравнение B"
                      >
                        B
                      </button>
                    </div>

                    {/* Кнопка открытия оригинального нативного интерфейса (Native VST GUI Editor) */}
                    <button
                      onClick={(e) => handleOpenNativeGUI(inst, index, e)}
                      className={`px-2 py-1 rounded-lg text-[10px] font-bold font-mono transition-all flex items-center gap-1 cursor-pointer border ${
                        isNativeActive
                          ? 'bg-amber-500/20 border-amber-500/60 text-amber-300 shadow-sm'
                          : 'bg-slate-900 hover:bg-slate-800 border-slate-700/80 hover:border-cyan-500/60 text-slate-300 hover:text-cyan-300'
                      }`}
                      title={
                        isDesktop
                          ? 'Открыть оригинальное нативное окно VST GUI (HWND/NSView)'
                          : 'Открыть оригинальный интерфейс плагина (Native GUI)'
                      }
                    >
                      <ExternalLink size={10} className={isNativeActive ? 'text-amber-400' : 'text-cyan-400'} />
                      <span>UI</span>
                    </button>

                    {/* Перемещение плагина вверх/вниз */}
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

                    {/* Открыть графический DSP-интерфейс */}
                    <button
                      onClick={() => setActivePluginModal(inst)}
                      className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-cyan-400 border border-slate-800"
                      title="Открыть встроенный графический DSP-интерфейс"
                    >
                      <Maximize2 size={11} />
                    </button>

                    {/* Свернуть/развернуть быстрые регуляторы */}
                    <button
                      onClick={(e) => toggleSlotExpanded(inst.instanceId, e)}
                      className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800"
                      title={isExpanded ? 'Свернуть быстрые регуляторы' : 'Развернуть быстрые регуляторы'}
                    >
                      {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </button>

                    {/* Удалить плагин */}
                    <button
                      onClick={(e) => handleRemovePlugin(inst.instanceId, e)}
                      className="p-1.5 rounded-lg bg-slate-900 hover:bg-rose-950/40 text-slate-500 hover:text-rose-400 border border-slate-800"
                      title="Удалить из цепочки"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>

                {/* Развернутая панель быстрых регуляторов и Wet/Dry */}
                {isExpanded && (
                  <div
                    className="px-3 pb-3 pt-1 border-t border-slate-800/80 bg-slate-950/40 space-y-2.5 rounded-b-xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Строка параметров Wet/Dry и A/B копирования */}
                    <div className="flex items-center justify-between gap-3 pt-1">
                      <div className="flex items-center gap-2 flex-1 max-w-[180px]">
                        <span className="text-[10px] font-semibold text-slate-400 shrink-0">
                          Wet / Dry:
                        </span>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={inst.wetDry ?? 1.0}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            onUpdateWetDry(inst.instanceId, val);
                          }}
                          className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                        />
                        <span className="text-[10px] font-mono text-cyan-400 font-bold shrink-0 w-8 text-right">
                          {wetDryPct}%
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={(e) => handleCopyAtoB(inst, e)}
                          className="px-2 py-0.5 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 rounded text-[9px] flex items-center gap-1 cursor-pointer"
                          title="Скопировать текущие параметры в слот B"
                        >
                          <Copy size={9} />
                          <span>Копия A → B</span>
                        </button>
                      </div>
                    </div>

                    {/* Быстрые регуляторы параметров плагина */}
                    {def?.parameters && def.parameters.length > 0 && (
                      <div className="pt-1.5 border-t border-slate-850/60">
                        <div className="flex flex-wrap items-center justify-around gap-2">
                          {def.parameters.slice(0, 5).map((param) => {
                            const currentVal = inst.parameters[param.id] ?? param.defaultValue ?? 0;
                            return (
                              <VSTQuickKnob
                                key={param.id}
                                id={`${inst.instanceId}-${param.id}`}
                                name={param.name}
                                value={currentVal}
                                min={param.min}
                                max={param.max}
                                step={param.step}
                                unit={param.unit}
                                color={def.color || '#06b6d4'}
                                onChange={(newVal) => {
                                  handleImmediateParamChange(inst.instanceId, param.id, newVal);
                                  inst.parameters[param.id] = newVal;
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Информационное модальное окно нативного GUI для Web-режима */}
      {nativeGuiInfoModal.isOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-[#0e1322] border border-cyan-500/40 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4 text-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2 font-bold text-sm text-cyan-300">
                <Monitor size={16} className="text-cyan-400" />
                <span>Оригинальный GUI: {nativeGuiInfoModal.pluginName}</span>
              </div>
              <button
                onClick={() => setNativeGuiInfoModal({ isOpen: false, pluginName: '', instance: null })}
                className="text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-slate-800"
              >
                <X size={15} />
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
              <div className="p-3 bg-cyan-950/40 border border-cyan-800/40 rounded-xl flex items-start gap-2.5">
                <AppWindow size={18} className="text-cyan-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-cyan-200 mb-0.5">
                    Нативный графический редактор (IPlugView / Win32 HWND)
                  </div>
                  <div className="text-slate-300 text-[11px]">
                    Оригинальный интерфейс Waves, FabFilter и других VST2/VST3 плагинов с аппаратным рендерингом доступен в десктопной сборке <strong>VOMIXStudio Desktop (Tauri v2)</strong>.
                  </div>
                </div>
              </div>

              <div className="p-3 bg-slate-900/70 border border-slate-800 rounded-xl space-y-1.5">
                <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                  <Sparkles size={12} className="text-amber-400" />
                  <span>Встроенный прецизионный DSP редактор</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  В текущем режиме все 100% параметров, пресеты, кривые эквализации и динамика управляются через встроенный графический интерфейс с нулевой задержкой.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                onClick={() => setNativeGuiInfoModal({ isOpen: false, pluginName: '', instance: null })}
                className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs transition-colors"
              >
                Понятно
              </button>
              {nativeGuiInfoModal.instance && (
                <button
                  onClick={() => {
                    const inst = nativeGuiInfoModal.instance;
                    setNativeGuiInfoModal({ isOpen: false, pluginName: '', instance: null });
                    if (inst) setActivePluginModal(inst);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow-lg shadow-cyan-900/30 transition-all cursor-pointer"
                >
                  <Maximize2 size={12} />
                  <span>Открыть DSP-интерфейс</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Встроенное плавающее графическое окно DSP-редактора плагина */}
      {activePluginModal && (
        <VSTGraphicalUIWindow
          instance={activePluginModal}
          onClose={() => setActivePluginModal(null)}
          onUpdateParam={(instId, paramId, val) => {
            onUpdateParam(instId, paramId, val);
            setActivePluginModal((prev) =>
              prev && prev.instanceId === instId
                ? {
                    ...prev,
                    parameters: {
                      ...prev.parameters,
                      [paramId]: val
                    }
                  }
                : prev
            );
          }}
          onUpdateBypass={(instId, enabled) => {
            onUpdateBypass(instId, enabled);
            setActivePluginModal((prev) =>
              prev && prev.instanceId === instId
                ? {
                    ...prev,
                    enabled
                  }
                : prev
            );
          }}
          onUpdateWetDry={(instId, wetDry) => {
            onUpdateWetDry(instId, wetDry);
            setActivePluginModal((prev) =>
              prev && prev.instanceId === instId
                ? {
                    ...prev,
                    wetDry
                  }
                : prev
            );
          }}
          onApplyPreset={(instId, presetId) => {
            const updated = globalVSTHostEngine.applyPresetToInstance(activePluginModal, presetId);
            Object.entries(updated.parameters).forEach(([paramId, val]) => {
              onUpdateParam(instId, paramId, val);
            });
            setActivePluginModal(updated);
          }}
        />
      )}
    </div>
  );
};
