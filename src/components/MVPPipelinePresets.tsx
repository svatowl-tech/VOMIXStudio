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
  Layers,
  ChevronDown,
  ChevronUp,
  Sliders,
  Plus,
  X,
  Volume2,
  Info,
  Activity,
  Heart,
  Clock,
  Wand2
} from 'lucide-react';
import {
  globalMVPPresetManager,
  MVPPreset,
  MVPPresetCategory
} from '../services/MVPPresetManager';
import { TrackState, VocalBusState, MasterState } from '../audio/dawEngine';

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
  const [presets, setPresets] = useState<MVPPreset[]>(() => globalMVPPresetManager.getAllPresets());
  const [activePresetId, setActivePresetId] = useState<string>(() => globalMVPPresetManager.getActivePresetId());
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetCategory, setPresetCategory] = useState<MVPPresetCategory>('Дубляж');
  const [presetDescription, setPresetDescription] = useState('');
  const [notification, setNotification] = useState<string | null>(null);

  useEffect(() => {
    const unsub = globalMVPPresetManager.subscribe(() => {
      setPresets(globalMVPPresetManager.getAllPresets());
      setActivePresetId(globalMVPPresetManager.getActivePresetId());
    });
    return unsub;
  }, []);

  const corePresets = presets.filter((p) => p.isBuiltIn);
  const userPresets = presets.filter((p) => !p.isBuiltIn);

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
    setTimeout(() => setNotification(null), 4000);
  };

  const getPresetIcon = (iconName: string) => {
    switch (iconName) {
      case 'Mic2':
        return <Mic2 size={18} />;
      case 'Zap':
        return <Zap size={18} />;
      case 'BookOpen':
        return <BookOpen size={18} />;
      case 'Film':
      default:
        return <Film size={18} />;
    }
  };

  return (
    <div className="bg-[#0f1422] border border-[#1e293b] p-4 sm:p-5 rounded-2xl shadow-xl space-y-4">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-gradient-to-tr from-cyan-600/20 to-emerald-600/20 border border-cyan-500/30 rounded-xl text-cyan-400">
            <Sparkles size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm sm:text-base font-bold text-slate-100">
                Студийные пресеты MVP Пайплайна
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-mono font-semibold">
                Закадр • Рекаст • Редаб • Дубляж
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Сквозная конфигурация обработки: цепочки VST и C++ DSP на дорожках, вокальной шине и мастере
            </p>
          </div>
        </div>

        {/* Preset Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              showGuide
                ? 'bg-cyan-950/60 text-cyan-300 border border-cyan-700/60'
                : 'bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-300'
            }`}
          >
            <Info size={13} className="text-cyan-400" />
            <span>Спецификация стандартов</span>
            {showGuide ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>

          <label className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all">
            <Upload size={13} className="text-cyan-400" />
            <span>Импорт</span>
            <input
              type="file"
              accept=".vomixpreset,.json"
              onChange={handleImportFile}
              className="hidden"
            />
          </label>

          <button
            onClick={() => setShowSaveModal(true)}
            className="px-3.5 py-1.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-md shadow-emerald-950/40 cursor-pointer"
          >
            <Save size={13} />
            <span>Сохранить пресет</span>
          </button>
        </div>
      </div>

      {/* Specification Guide Accordion */}
      {showGuide && (
        <div className="p-4 bg-slate-950/90 border border-cyan-500/30 rounded-xl text-xs space-y-3 animate-fadeIn">
          <div className="flex items-center gap-2 text-cyan-400 font-bold uppercase tracking-wider text-[11px]">
            <Info size={14} />
            <span>Отраслевая классификация режимов озвучивания и сведения</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-slate-300">
            <div className="p-3 bg-slate-900/80 rounded-lg border border-emerald-500/20 space-y-1">
              <div className="font-bold text-emerald-400 flex items-center gap-1.5">
                <Mic2 size={13} /> 1. Закадр
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Быстрая запись, не требующая особых эмоциональных вложений. Сводится начисто без эффектов (чистый голос поверх оригинального звука с авто-дакингом).
              </p>
            </div>

            <div className="p-3 bg-slate-900/80 rounded-lg border border-purple-500/20 space-y-1">
              <div className="font-bold text-purple-400 flex items-center gap-1.5">
                <Zap size={13} /> 2. Рекаст
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Улучшенный вариант закадра: длина переведенных реплик соответствует оригиналу, фразы совпадают по началу и концу (с небольшими отклонениями внутри длинных фраз). Озвучивается физика, прилегающая к фразам (вдохи, охи и т.п.).
              </p>
            </div>

            <div className="p-3 bg-slate-900/80 rounded-lg border border-cyan-500/20 space-y-1">
              <div className="font-bold text-cyan-400 flex items-center gap-1.5">
                <BookOpen size={13} /> 3. Редаб (Под дубляж)
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Озвучивание под дубляж: липсинг по губам (с допущением небольших отклонений), выразительные эмоции, фразы строго совпадают с оригиналом по началу и концу, озвучивается лёгкая физика.
              </p>
            </div>

            <div className="p-3 bg-slate-900/80 rounded-lg border border-amber-500/20 space-y-1">
              <div className="font-bold text-amber-400 flex items-center gap-1.5">
                <Film size={13} /> 4. Дубляж
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Полное сведение эффектов под кадр (пространство, фильтры), полное повторение эмоций и характера персонажа, 100% повтор липсинга за артикуляцией губ.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {notification && (
        <div className="p-2.5 bg-emerald-950/40 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 flex items-center gap-2 animate-fadeIn">
          <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
          <span>{notification}</span>
        </div>
      )}

      {/* The 4 Core Studio Presets Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3.5">
        {corePresets.map((preset) => {
          const isActive = activePresetId === preset.id;
          return (
            <div
              key={preset.id}
              onClick={() => handleSelectPreset(preset)}
              className={`p-4 rounded-xl border transition-all cursor-pointer relative overflow-hidden group flex flex-col justify-between ${
                isActive
                  ? 'bg-gradient-to-b from-[#131d2e] to-[#0c1220] border-cyan-500 shadow-lg shadow-cyan-950/50 ring-1 ring-cyan-500/50'
                  : 'bg-[#111726]/80 hover:bg-[#151d30] border-slate-800 hover:border-slate-700 shadow-sm'
              }`}
            >
              {/* Active Indicator Pin */}
              {isActive && (
                <div className="absolute top-2.5 right-2.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 text-[10px] font-mono font-bold">
                  <CheckCircle2 size={11} className="text-cyan-400" />
                  Активен
                </div>
              )}

              <div>
                <div className="flex items-center gap-2.5 mb-2.5">
                  <div
                    className="p-2 rounded-lg border shrink-0 transition-transform group-hover:scale-105"
                    style={{
                      backgroundColor: `${preset.color}15`,
                      borderColor: `${preset.color}35`,
                      color: preset.color
                    }}
                  >
                    {getPresetIcon(preset.icon)}
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-100 group-hover:text-cyan-300 transition-colors">
                      {preset.name}
                    </h4>
                    <span className="text-[10px] text-slate-400 font-mono">
                      {preset.targetLufsDb} LUFS EBU
                    </span>
                  </div>
                </div>

                <p className="text-[11px] text-slate-300 leading-relaxed mb-3">
                  {preset.description}
                </p>

                {/* Structured Requirements Badges */}
                {preset.requirements && (
                  <div className="space-y-1.5 py-2.5 border-t border-slate-800/80 text-[10px]">
                    <div className="flex items-start gap-1.5 text-slate-400">
                      <Clock size={11} className="text-cyan-400 shrink-0 mt-0.5" />
                      <div>
                        <span className="text-slate-500 font-medium">Синхрон: </span>
                        <span className="text-slate-200">{preset.requirements.syncTiming}</span>
                      </div>
                    </div>

                    <div className="flex items-start gap-1.5 text-slate-400">
                      <Heart size={11} className="text-rose-400 shrink-0 mt-0.5" />
                      <div>
                        <span className="text-slate-500 font-medium">Эмоции: </span>
                        <span className="text-slate-200">{preset.requirements.emotions}</span>
                      </div>
                    </div>

                    <div className="flex items-start gap-1.5 text-slate-400">
                      <Activity size={11} className="text-emerald-400 shrink-0 mt-0.5" />
                      <div>
                        <span className="text-slate-500 font-medium">Физика: </span>
                        <span className="text-slate-200">{preset.requirements.physics}</span>
                      </div>
                    </div>

                    <div className="flex items-start gap-1.5 text-slate-400">
                      <Wand2 size={11} className="text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <span className="text-slate-500 font-medium">Сведение: </span>
                        <span className="text-slate-200">{preset.requirements.effectsMix}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Badges & Stats */}
              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-slate-400">
                <span className="flex items-center gap-1 text-slate-300">
                  <Layers size={11} className="text-cyan-400" />
                  {preset.trackVstChain.length} VST в дорожках
                </span>
                <span className="text-slate-500">
                  Bus: {preset.vocalBusSettings.vstChain.length} | M: {preset.masterSettings.vstChain.length}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* User Custom Presets Section (if any) */}
      {userPresets.length > 0 && (
        <div className="pt-2 space-y-2.5">
          <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Sliders size={13} className="text-purple-400" /> Пользовательские пресеты ({userPresets.length})
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {userPresets.map((preset) => {
              const isActive = activePresetId === preset.id;
              return (
                <div
                  key={preset.id}
                  onClick={() => handleSelectPreset(preset)}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    isActive
                      ? 'bg-[#151c2e] border-purple-500 shadow-md ring-1 ring-purple-500/50'
                      : 'bg-slate-900/60 hover:bg-slate-900 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-200 truncate">
                        {preset.name}
                      </span>
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono">
                        {preset.category}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 truncate mt-0.5">
                      {preset.description || 'Пользовательский пресет'}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={(e) => handleExport(preset, e)}
                      className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-cyan-300"
                      title="Экспорт в файл .vomixpreset"
                    >
                      <Download size={12} />
                    </button>
                    <button
                      onClick={(e) => handleDeleteUserPreset(preset.id, preset.name, e)}
                      className="p-1.5 rounded bg-slate-800 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400"
                      title="Удалить пресет"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
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
