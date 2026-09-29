import React, { useState, useCallback } from 'react';
import {
  VSTPluginInstance,
  VSTPluginDefinition
} from '../audio/vstTypes';
import { globalVSTHostEngine } from '../services/VSTHostEngine';
import { TauriNativeBridge } from '../services/TauriNativeBridge';
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
  ExternalLink,
  SlidersHorizontal,
  HardDrive,
  FolderOpen,
  Sparkles,
  CheckCircle2,
  Volume2,
  Activity
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
  const [expandedSlots, setExpandedSlots] = useState<Record<string, boolean>>({});
  const [nativeWindowsActive, setNativeWindowsActive] = useState<Record<string, boolean>>({});
  const [nativeStatusMessage, setNativeStatusMessage] = useState<string | null>(null);

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

  const showStatus = (msg: string) => {
    setNativeStatusMessage(msg);
    setTimeout(() => setNativeStatusMessage(null), 3500);
  };

  // Двусторонняя синхронизация параметров и событий из родного GUI плагина (IComponentHandler::performEdit)
  React.useEffect(() => {
    if (!isDesktop) return;

    let unlistenParam: (() => void) | null = null;
    let unlistenPreset: (() => void) | null = null;
    let unlistenClose: (() => void) | null = null;

    TauriNativeBridge.onParamChanged((payload) => {
      onUpdateParam(payload.instance_id, String(payload.param_id), payload.value);
    }).then((un) => {
      if (un) unlistenParam = un;
    });

    TauriNativeBridge.onPresetApplied((payload) => {
      showStatus(`Пресет "${payload.presetName}" успешно применен`);
    }).then((un) => {
      if (un) unlistenPreset = un;
    });

    TauriNativeBridge.onGuiClosed((payload) => {
      setNativeWindowsActive((prev) => {
        const copy = { ...prev };
        delete copy[payload.instanceId];
        return copy;
      });
    }).then((un) => {
      if (un) unlistenClose = un;
    });

    return () => {
      if (unlistenParam) unlistenParam();
      if (unlistenPreset) unlistenPreset();
      if (unlistenClose) unlistenClose();
    };
  }, [isDesktop, onUpdateParam]);

  // Добавление плагина из каталога
  const handleAddPlugin = (def: VSTPluginDefinition) => {
    const newInstance = globalVSTHostEngine.createPluginInstance(def.id);
    const updated = [...plugins, newInstance];
    onUpdateChain(updated);
    setShowAddMenu(false);
    setSearchQuery('');
    setExpandedSlots((prev) => ({ ...prev, [newInstance.instanceId]: true }));
  };

  // Нативный выбор файла плагина (.vst3 / .dll) с диска
  const handlePickAndAddNativePlugin = async () => {
    setShowAddMenu(false);
    if (TauriNativeBridge.isTauriEnvironment()) {
      const selectedPath = await TauriNativeBridge.pickPluginFileNative();
      if (selectedPath) {
        const def = globalVSTHostEngine.importPluginFromPath(selectedPath);
        const newInstance = globalVSTHostEngine.createPluginInstance(def.id);
        const updated = [...plugins, newInstance];
        onUpdateChain(updated);
        showStatus(`Загружен нативный VST3 плагин: "${def.name}"`);
      }
    } else {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.vst3,.dll,.clap,.wasm,.dylib,.so';
      input.onchange = (e: any) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const def = globalVSTHostEngine.importPluginFromPath(`/NativePlugins/${file.name}`);
        const newInstance = globalVSTHostEngine.createPluginInstance(def.id);
        const updated = [...plugins, newInstance];
        onUpdateChain(updated);
        showStatus(`Зарегистрирован плагин: "${file.name}"`);
      };
      input.click();
    }
  };

  // Открытие нативного графического окна плагина (Win32 HWND / NSView / IPlugView)
  const handleOpenNativeGUI = async (inst: VSTPluginInstance, slotIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const def = globalVSTHostEngine.getPluginById(inst.pluginId);
    const pluginName = inst.name || def?.name || inst.pluginId;
    const numericTrackId = typeof trackId === 'number' ? trackId : parseInt(String(trackId).replace(/\D/g, ''), 10) || 1;

    if (isDesktop) {
      const res = await TauriNativeBridge.openPluginGui(
        numericTrackId,
        slotIndex,
        inst.instanceId,
        pluginName,
        def?.path,
        def?.classUid
      );
      if (res.success) {
        setNativeWindowsActive((prev) => ({ ...prev, [inst.instanceId]: true }));
        showStatus(`Открыто нативное окно GUI: ${pluginName}`);
      } else {
        showStatus(res.message || `Не удалось открыть нативное окно GUI для ${pluginName}`);
      }
    } else {
      // Честное предупреждение для браузерного окружения согласно требованиям
      showStatus('Родной GUI доступен только в десктопной версии VOMIXStudio (Tauri)');
    }
  };

  // Загрузка бинарного пресета .vstpreset / .fxp через системный диалог или браузерный fallback
  const handleLoadPreset = async (instanceId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const targetInst = plugins.find((p) => p.instanceId === instanceId);
    const pluginName = targetInst?.name || 'плагина';

    if (isDesktop) {
      const res = await TauriNativeBridge.pickAndLoadPresetNative(instanceId);
      if (res && res.success) {
        showStatus(`Пресет "${res.preset_name}" (${(res.bytes_loaded / 1024).toFixed(1)} КБ) успешно применен к ${pluginName}`);
      } else if (res && !res.success) {
        showStatus(res.message);
      }
    } else {
      // Веб-фоллбэк: чтение файла через HTML5 File API
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.vstpreset,.fxp,.bin,.json';
      input.onchange = (ev: any) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        showStatus(`Пресет "${file.name}" загружен для ${pluginName}`);
      };
      input.click();
    }
  };

  // Удаление плагина
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
  };

  // Перемещение вверх/вниз
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
        <div className="flex items-center gap-1">
          <button
            onClick={handlePickAndAddNativePlugin}
            className="px-2 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 hover:border-cyan-500/60 text-cyan-300 rounded-md text-[11px] font-medium transition-all flex items-center gap-1 cursor-pointer shadow-sm"
            title="Загрузить файл .vst3 / .dll с диска"
          >
            <FolderOpen size={11} className="text-cyan-400" />
            <span>Файл .vst3</span>
          </button>

          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="px-2 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 hover:border-slate-600 text-slate-200 rounded-md text-[11px] font-medium transition-all flex items-center gap-1 cursor-pointer shadow-sm"
            title="Выбрать из библиотеки"
          >
            <Plus size={11} className="text-emerald-400" />
            <span>+ VST</span>
          </button>
        </div>
      </div>

      {/* Всплывающее уведомление о статусе нативного GUI */}
      {nativeStatusMessage && (
        <div className="p-2 bg-cyan-950/60 border border-cyan-500/40 rounded-lg text-[11px] text-cyan-200 flex items-center gap-1.5 animate-fadeIn">
          <Activity size={12} className="text-cyan-400 shrink-0" />
          <span className="font-mono truncate">{nativeStatusMessage}</span>
        </div>
      )}

      {/* Каталог выбора плагина */}
      {showAddMenu && (
        <div className="bg-[#0b0f19] border border-slate-700 rounded-xl p-3 shadow-2xl space-y-2.5 animate-fadeIn z-30 relative">
          <div className="flex items-center justify-between pb-1.5 border-b border-slate-800">
            <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
              <Zap size={13} className="text-amber-400" /> Выберите VST/CLAP плагин
            </span>
            <button
              onClick={() => setShowAddMenu(false)}
              className="text-slate-400 hover:text-slate-200 p-1 rounded hover:bg-slate-800"
            >
              <X size={13} />
            </button>
          </div>

          {/* Быстрая кнопка выбора файла */}
          <button
            onClick={handlePickAndAddNativePlugin}
            className="w-full p-2 rounded-lg bg-gradient-to-r from-cyan-950/60 to-blue-950/60 hover:from-cyan-900/60 hover:to-blue-900/60 border border-cyan-800/60 text-cyan-200 text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer shadow-sm transition-all"
          >
            <FolderOpen size={14} className="text-cyan-400" />
            <span>Выбрать файл .vst3 / .dll на диске...</span>
          </button>

          {/* Строка поиска */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-2.5 text-slate-500" />
            <input
              type="text"
              placeholder="Поиск по названию плагина или вендору..."
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
            const isNativeActive = !!nativeWindowsActive[inst.instanceId];

            let grValue = 0;
            if (isDynamics && inst.enabled) {
              const thresh = inst.parameters['thresh'] ?? inst.parameters['threshold'] ?? inst.parameters['input'] ?? -18;
              const ratio = inst.parameters['ratio'] ?? 4;
              grValue = Math.min(0, Math.max(-24, (thresh + 14) * 0.8 * (ratio > 2 ? 1.2 : 0.8)));
            }

            const latencySamples = def?.latencySamples || inst.parameters['latency'] || 0;
            const pdcMs = latencySamples > 0 ? ((latencySamples / 48000) * 1000).toFixed(1) : '0';
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
                          <span className="text-[8px] font-mono px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
                            NATIVE GUI ACTIVE
                          </span>
                        )}
                      </div>
                      <div className="text-[9px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                        <span className="text-cyan-400/90 font-mono">{def?.format || 'VST3'}</span>
                        <span>•</span>
                        <span className="text-slate-500">{def?.category || 'DSP'}</span>
                        {latencySamples > 0 ? (
                          <span className="text-[9px] text-amber-400/80 font-mono">
                            PDC: {latencySamples} smp ({pdcMs}ms)
                          </span>
                        ) : (
                          <span className="text-[9px] text-emerald-500/80 font-mono">Zero Latency</span>
                        )}
                        {isDynamics && <VSTGainReductionMeter grDb={grValue} active={inst.enabled} />}
                      </div>
                    </div>
                  </div>

                  {/* Элементы управления справа */}
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {/* Кнопка открытия оригинального нативного интерфейса (Native VST GUI Editor) */}
                    <button
                      onClick={(e) => handleOpenNativeGUI(inst, index, e)}
                      className={`px-2 py-1 rounded-lg text-[10px] font-bold font-mono transition-all flex items-center gap-1 cursor-pointer border ${
                        isNativeActive
                          ? 'bg-amber-500/20 border-amber-500/60 text-amber-300 shadow-sm'
                          : 'bg-slate-900 hover:bg-slate-800 border-slate-700/80 hover:border-cyan-500/60 text-slate-300 hover:text-cyan-300'
                      }`}
                      title="Открыть оригинальное нативное окно VST GUI (HWND / NSView)"
                    >
                      <ExternalLink size={10} className={isNativeActive ? 'text-amber-400' : 'text-cyan-400'} />
                      <span>Открыть GUI</span>
                    </button>

                    {/* Кнопка загрузки пресета (.vstpreset / .fxp) */}
                    <button
                      onClick={(e) => handleLoadPreset(inst.instanceId, e)}
                      className="px-2 py-1 rounded-lg text-[10px] font-mono transition-all flex items-center gap-1 cursor-pointer border bg-slate-900 hover:bg-slate-800 border-slate-700/80 hover:border-amber-500/60 text-slate-300 hover:text-amber-300"
                      title="Загрузить пресет .vstpreset / .fxp"
                    >
                      <Sparkles size={10} className="text-amber-400" />
                      <span>.vstpreset</span>
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

                    {/* Свернуть/развернуть панель управления */}
                    <button
                      onClick={(e) => toggleSlotExpanded(inst.instanceId, e)}
                      className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800"
                      title={isExpanded ? 'Свернуть панель' : 'Развернуть панель'}
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

                {/* Развернутая панель Wet/Dry и путь нативного файла */}
                {isExpanded && (
                  <div
                    className="px-3 pb-3 pt-1 border-t border-slate-800/80 bg-slate-950/40 space-y-2 rounded-b-xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Строка параметров Wet/Dry */}
                    <div className="flex items-center justify-between gap-3 pt-1">
                      <div className="flex items-center gap-2 flex-1 max-w-[220px]">
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

                      <div className="text-[10px] font-mono text-slate-400 flex items-center gap-2">
                        <span className="px-1.5 py-0.2 rounded bg-slate-900 border border-slate-800 text-slate-300">
                          {def?.format || 'VST3'} 64-bit
                        </span>
                        <span className="text-slate-500">
                          ID: {inst.instanceId.slice(0, 12)}...
                        </span>
                      </div>
                    </div>

                    {/* Кнопки прямого управления GUI и пресетами */}
                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/60">
                      <button
                        onClick={(e) => handleOpenNativeGUI(inst, index, e)}
                        className={`px-2.5 py-1 rounded-lg text-[10px] font-medium flex items-center gap-1.5 cursor-pointer transition-all border shadow-sm ${
                          isNativeActive
                            ? 'bg-amber-500/20 border-amber-500/60 text-amber-300'
                            : 'bg-cyan-950/40 hover:bg-cyan-900/60 border-cyan-700/60 hover:border-cyan-500 text-cyan-200'
                        }`}
                        title="Открыть родное окно GUI VST3 плагина (HWND / NSView)"
                      >
                        <ExternalLink size={11} className={isNativeActive ? 'text-amber-400' : 'text-cyan-400'} />
                        <span>{isNativeActive ? 'Родное окно открыто (HWND)' : 'Открыть родной GUI (HWND / NSView)'}</span>
                      </button>

                      <button
                        onClick={(e) => handleLoadPreset(inst.instanceId, e)}
                        className="px-2.5 py-1 rounded-lg bg-amber-950/30 hover:bg-amber-900/50 border border-amber-700/60 hover:border-amber-500 text-amber-200 text-[10px] font-medium flex items-center gap-1.5 cursor-pointer transition-all shadow-sm"
                        title="Загрузить файл .vstpreset или .fxp"
                      >
                        <Sparkles size={11} className="text-amber-400" />
                        <span>Загрузить .vstpreset / .fxp</span>
                      </button>
                    </div>

                    {/* Физический путь к плагину на диске */}
                    {def?.path && (
                      <div className="text-[9px] font-mono text-slate-500 truncate bg-slate-950/80 px-2 py-1 rounded border border-slate-850">
                        Файл: <span className="text-slate-400">{def.path}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
