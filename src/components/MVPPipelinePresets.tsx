import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Save,
  Download,
  Upload,
  Mic2,
  Zap,
  BookOpen,
  Film,
  CheckCircle2,
  Trash2,
  Sliders,
  X,
  Info,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import {
  globalMVPPresetManager,
  MVPPreset,
  MVPPresetCategory
} from '../services/MVPPresetManager';
import { TrackState, VocalBusState, MasterState } from '../audio/dawEngine';
import { toSafeArray } from '../utils/safeIterables';

interface MVPPipelinePresetsProps {
  tracks: TrackState[];
  vocalBus: VocalBusState;
  master: MasterState;
  onApplyPreset: (preset: MVPPreset) => void;
}

export const MVPPipelinePresets: React.FC<MVPPipelinePresetsProps> = ({
  tracks,
  vocalBus,
  master,
  onApplyPreset
}) => {
  const [presets, setPresets] = useState<MVPPreset[]>(() => toSafeArray<MVPPreset>(globalMVPPresetManager.getAllPresets()));
  const [activePresetId, setActivePresetId] = useState<string>(() => globalMVPPresetManager.getActivePresetId());
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetCategory, setPresetCategory] = useState<MVPPresetCategory>('Дубляж');
  const [presetDescription, setPresetDescription] = useState('');
  const [notification, setNotification] = useState<string | null>(null);

  useEffect(() => {
    const unsub = globalMVPPresetManager.subscribe(() => {
      setPresets(toSafeArray<MVPPreset>(globalMVPPresetManager.getAllPresets()));
      setActivePresetId(globalMVPPresetManager.getActivePresetId());
    });
    return unsub;
  }, []);

  const safePresets = toSafeArray<MVPPreset>(presets);
  const corePresets = safePresets.filter((p) => p && p.isBuiltIn);
  const userPresets = safePresets.filter((p) => p && !p.isBuiltIn);
  const activePreset = safePresets.find((p) => p && p.id === activePresetId) || corePresets[0] || safePresets[0];

  const handleSelectPreset = (preset: MVPPreset) => {
    setActivePresetId(preset.id);
    globalMVPPresetManager.setActivePresetId(preset.id);
    onApplyPreset(preset);
    showNotice(`Применен пресет: "${preset.name}" (${preset.category})`);
  };

  const handleSaveCurrentPipeline = (e: React.FormEvent) => {
    e.preventDefault();
    if (!presetName.trim()) return;

    const newPreset = globalMVPPresetManager.captureCurrentStateAsPreset(
      presetName,
      presetCategory,
      presetDescription,
      tracks,
      vocalBus,
      master
    );

    setShowSaveModal(false);
    setPresetName('');
    setPresetDescription('');
    showNotice(`Пресет "${newPreset.name}" сохранен в памяти!`);
  };

  const handleDeleteUserPreset = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Удалить пресет "${name}"?`)) {
      globalMVPPresetManager.deleteUserPreset(id);
      showNotice(`Пресет "${name}" удален.`);
    }
  };

  const handleExport = (preset: MVPPreset, e: React.MouseEvent) => {
    e.stopPropagation();
    globalMVPPresetManager.exportPresetToFile(preset);
    showNotice(`Пресет "${preset.name}" экспортирован.`);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await globalMVPPresetManager.importPresetFromFile(file);
      onApplyPreset(imported);
      showNotice(`Импортирован и применен пресет: "${imported.name}"`);
    } catch (err: any) {
      alert(`Ошибка импорта: ${err.message}`);
    }
    e.target.value = '';
  };

  const showNotice = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3500);
  };

  const getPresetIcon = (iconName: string, size = 14) => {
    switch (iconName) {
      case 'Mic2':
        return <Mic2 size={size} />;
      case 'Zap':
        return <Zap size={size} />;
      case 'BookOpen':
        return <BookOpen size={size} />;
      case 'Film':
      default:
        return <Film size={size} />;
    }
  };

  return (
    <div className="bg-[#0f1422] border border-[#1e293b] p-3 rounded-2xl shadow-xl space-y-2.5">
      {/* Compact Main Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        {/* Title & Preset Pills */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 px-2.5 py-1 bg-gradient-to-r from-cyan-600/10 to-emerald-600/10 border border-cyan-500/20 rounded-xl">
            <Sparkles size={15} className="text-cyan-400 shrink-0" />
            <span className="text-xs font-bold text-slate-200 whitespace-nowrap">Пресет сведе́ния:</span>
          </div>

          {/* Built-in Presets Pill Selector */}
          <div className="flex flex-wrap items-center gap-1.5">
            {corePresets.map((preset) => {
              const isActive = activePresetId === preset.id;
              return (
                <button
                  key={preset.id}
                  onClick={() => handleSelectPreset(preset)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer border ${
                    isActive
                      ? 'bg-gradient-to-r from-cyan-600 to-emerald-600 text-white border-cyan-400 shadow-md shadow-cyan-950/50 font-bold'
                      : 'bg-slate-900/80 hover:bg-slate-800 text-slate-300 border-slate-800 hover:border-slate-700'
                  }`}
                  title={`${preset.name}: ${preset.description} (${preset.targetLufsDb} LUFS)`}
                >
                  <span style={{ color: isActive ? '#fff' : preset.color }}>
                    {getPresetIcon(preset.icon, 13)}
                  </span>
                  <span>{preset.name}</span>
                  <span
                    className={`text-[9px] px-1 py-0.2 rounded font-mono ${
                      isActive ? 'bg-black/20 text-cyan-100' : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {preset.targetLufsDb} dB
                  </span>
                </button>
              );
            })}
          </div>

          {/* User Presets Dropdown if any exist */}
          {userPresets.length > 0 && (
            <div className="relative">
              <select
                value={userPresets.some((p) => p.id === activePresetId) ? activePresetId : ''}
                onChange={(e) => {
                  const selected = userPresets.find((p) => p.id === e.target.value);
                  if (selected) handleSelectPreset(selected);
                }}
                className="px-2.5 py-1.5 bg-slate-900 border border-purple-500/30 rounded-xl text-xs font-semibold text-purple-300 focus:outline-none cursor-pointer"
              >
                <option value="" disabled>
                  Свои пресеты ({userPresets.length})
                </option>
                {userPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.category})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Action Controls (Guide, Import, Save) */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer border ${
              showGuide
                ? 'bg-cyan-950/80 text-cyan-300 border-cyan-700/80'
                : 'bg-slate-900/80 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title="Спецификация стандартов сведе́ния"
          >
            <Info size={13} className="text-cyan-400" />
            <span className="hidden sm:inline">Стандарты</span>
            {showGuide ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>

          <label className="px-2.5 py-1.5 bg-slate-900/80 hover:bg-slate-800 border border-slate-800 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1 cursor-pointer transition-all">
            <Upload size={13} className="text-cyan-400" />
            <span className="hidden sm:inline">Импорт</span>
            <input
              type="file"
              accept=".vomixpreset,.json"
              onChange={handleImportFile}
              className="hidden"
            />
          </label>

          <button
            onClick={() => setShowSaveModal(true)}
            className="px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 hover:border-emerald-500/50 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
            title="Сохранить текущие параметры в пользовательский пресет"
          >
            <Save size={13} />
            <span className="hidden sm:inline">Сохранить</span>
          </button>
        </div>
      </div>

      {/* Active Preset Quick Description Banner */}
      {activePreset && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-slate-950/60 border border-slate-800/80 rounded-xl text-[11px] text-slate-300">
          <div className="flex items-center gap-2">
            <span className="font-bold text-cyan-400 font-mono">{activePreset.name}:</span>
            <span className="text-slate-400 truncate max-w-md sm:max-w-xl">{activePreset.description}</span>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono text-slate-400 shrink-0">
            <span>Цель: <strong className="text-emerald-400">{activePreset.targetLufsDb} LUFS</strong></span>
            <span>Цепочка VST: <strong className="text-cyan-400">{activePreset.trackVstChain.length}</strong> плагинов</span>
          </div>
        </div>
      )}

      {/* Specification Guide Collapsible Panel */}
      {showGuide && (
        <div className="p-3 bg-slate-950/90 border border-cyan-500/30 rounded-xl text-xs space-y-2 animate-fadeIn">
          <div className="flex items-center justify-between text-cyan-400 font-bold uppercase tracking-wider text-[10px]">
            <span className="flex items-center gap-1.5">
              <Info size={13} />
              Отраслевая классификация режимов озвучивания и сведения
            </span>
            <button onClick={() => setShowGuide(false)} className="text-slate-400 hover:text-white">
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-slate-300">
            <div className="p-2.5 bg-slate-900/80 rounded-lg border border-emerald-500/20 space-y-0.5">
              <div className="font-bold text-emerald-400 flex items-center gap-1 text-[11px]">
                <Mic2 size={12} /> 1. Закадр (-16 dB)
              </div>
              <p className="text-slate-400 text-[10px] leading-tight">
                Быстрая запись. Чистый голос поверх оригинального звука с авто-дакингом.
              </p>
            </div>

            <div className="p-2.5 bg-slate-900/80 rounded-lg border border-purple-500/20 space-y-0.5">
              <div className="font-bold text-purple-400 flex items-center gap-1 text-[11px]">
                <Zap size={12} /> 2. Рекаст (-14 dB)
              </div>
              <p className="text-slate-400 text-[10px] leading-tight">
                Точный хронометраж фраз, совпадение по краям, озвучка легкой физики.
              </p>
            </div>

            <div className="p-2.5 bg-slate-900/80 rounded-lg border border-cyan-500/20 space-y-0.5">
              <div className="font-bold text-cyan-400 flex items-center gap-1 text-[11px]">
                <BookOpen size={12} /> 3. Редаб (-14 dB)
              </div>
              <p className="text-slate-400 text-[10px] leading-tight">
                Липсинг по губам, яркие эмоции, жесткий тайминг.
              </p>
            </div>

            <div className="p-2.5 bg-slate-900/80 rounded-lg border border-amber-500/20 space-y-0.5">
              <div className="font-bold text-amber-400 flex items-center gap-1 text-[11px]">
                <Film size={12} /> 4. Дубляж (-14 dB)
              </div>
              <p className="text-slate-400 text-[10px] leading-tight">
                Полное сведение под кадр (пространство, фильтры), 100% повтор артикуляции.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* User Custom Presets Management list if userPresets exist */}
      {userPresets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800/80">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
            <Sliders size={11} className="text-purple-400" /> Свои:
          </span>
          {userPresets.map((preset) => {
            const isActive = activePresetId === preset.id;
            return (
              <div
                key={preset.id}
                onClick={() => handleSelectPreset(preset)}
                className={`px-2.5 py-1 rounded-lg border text-xs flex items-center gap-1.5 cursor-pointer transition-all ${
                  isActive
                    ? 'bg-purple-950/80 border-purple-500 text-purple-200 font-bold'
                    : 'bg-slate-900/60 hover:bg-slate-900 border-slate-800 text-slate-300'
                }`}
              >
                <span>{preset.name}</span>
                <button
                  onClick={(e) => handleExport(preset, e)}
                  className="p-0.5 text-slate-400 hover:text-cyan-300"
                  title="Экспорт"
                >
                  <Download size={11} />
                </button>
                <button
                  onClick={(e) => handleDeleteUserPreset(preset.id, preset.name, e)}
                  className="p-0.5 text-slate-400 hover:text-rose-400"
                  title="Удалить"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Toast notification */}
      {notification && (
        <div className="p-2 bg-emerald-950/50 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 flex items-center gap-2 animate-fadeIn">
          <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
          <span>{notification}</span>
        </div>
      )}

      {/* Save Pipeline Preset Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fadeIn">
          <form
            onSubmit={handleSaveCurrentPipeline}
            className="bg-[#0f1422] border border-cyan-500/40 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400">
                  <Save size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100">Сохранить пресет пайплайна</h3>
                  <p className="text-[11px] text-slate-400">
                    Запоминает все VST цепочки, параметры и C++ DSP настройки
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSaveModal(false)}
                className="text-slate-400 hover:text-slate-200 p-1"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Название пресета:
                </label>
                <input
                  type="text"
                  required
                  placeholder="Например: Мой Дубляж для Экшна"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-slate-100 focus:outline-none focus:border-cyan-500"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Тип / Категория:
                </label>
                <select
                  value={presetCategory}
                  onChange={(e) => setPresetCategory(e.target.value as MVPPresetCategory)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                >
                  <option value="Закадр">Закадр (Voiceover)</option>
                  <option value="Рекаст">Рекаст (Recast)</option>
                  <option value="Редаб">Редаб (Redub / Под дубляж)</option>
                  <option value="Дубляж">Дубляж (Dubbing)</option>
                  <option value="Custom">Пользовательский (Custom)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Описание:
                </label>
                <textarea
                  rows={3}
                  placeholder="Краткое описание специфики обработки и тембра..."
                  value={presetDescription}
                  onChange={(e) => setPresetDescription(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-[11px] text-slate-400 space-y-1 font-mono">
                <div className="text-emerald-400 font-semibold mb-1">Будет сохранено в пресет:</div>
                <div>• Дорожек дубляжа: {tracks.length} (C++ DSP + VST плагины)</div>
                <div>• Vocal Bus VST плагинов: {vocalBus.vstPlugins?.length || 0}</div>
                <div>• Master VST плагинов: {master.vstPlugins?.length || 0}</div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowSaveModal(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Отмена
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-emerald-950/40 cursor-pointer"
              >
                Сохранить снимок
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
