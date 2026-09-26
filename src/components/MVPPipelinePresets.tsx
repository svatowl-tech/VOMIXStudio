import React, { useState, useEffect, useRef } from 'react';
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
  ChevronUp,
  Plus,
  RefreshCw,
  Layers,
  FolderOpen
} from 'lucide-react';
import {
  globalMVPPresetManager,
  MVPPreset,
  MVPPresetCategory
} from '../services/MVPPresetManager';
import { TrackState, VocalBusState, MasterState } from '../audio/dawEngine';
import { toSafeArray } from '../utils/safeIterables';
import { globalAIPipelineStore } from '../services/AIPipelineStore';

interface MVPPipelinePresetsProps {
  tracks: TrackState[];
  vocalBus: VocalBusState;
  master: MasterState;
  onApplyPreset: (preset: MVPPreset) => void;
}

const CATEGORIES: { id: MVPPresetCategory; label: string; icon: string; color: string; desc: string }[] = [
  {
    id: 'Закадр',
    label: 'Закадр',
    icon: 'Mic2',
    color: '#10b981',
    desc: 'Запись поверх оригинального звука (авто-дакинг, чистый голос, свободный тайминг)'
  },
  {
    id: 'Рекаст',
    label: 'Рекаст',
    icon: 'Zap',
    color: '#8b5cf6',
    desc: 'Точный хронометраж фраз, совпадение по краям, озвучка легкой физики'
  },
  {
    id: 'Редаб',
    label: 'Редаб',
    icon: 'BookOpen',
    color: '#06b6d4',
    desc: 'Липсинг по губам, яркие эмоции, жесткий тайминг, сведение под дубляж'
  },
  {
    id: 'Дубляж',
    label: 'Дубляж',
    icon: 'Film',
    color: '#f59e0b',
    desc: 'Полное сведение под кадр, 100% повтор эмоций, физики и артикуляции губ'
  }
];

export const MVPPipelinePresets: React.FC<MVPPipelinePresetsProps> = ({
  tracks,
  vocalBus,
  master,
  onApplyPreset
}) => {
  const [activeCategory, setActiveCategoryState] = useState<MVPPresetCategory>(() =>
    globalMVPPresetManager.getActiveCategory()
  );
  const [presets, setPresets] = useState<MVPPreset[]>(() =>
    toSafeArray<MVPPreset>(globalMVPPresetManager.getAllPresets())
  );
  const [activePresetId, setActivePresetId] = useState<string>(() =>
    globalMVPPresetManager.getActivePresetId()
  );

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetDescription, setPresetDescription] = useState('');
  const [notification, setNotification] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = globalMVPPresetManager.subscribe(() => {
      setPresets(toSafeArray<MVPPreset>(globalMVPPresetManager.getAllPresets()));
      setActivePresetId(globalMVPPresetManager.getActivePresetId());
      setActiveCategoryState(globalMVPPresetManager.getActiveCategory());
    });
    return unsub;
  }, []);

  // Закрытие выпадающего меню по клику вне области
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const safePresets = toSafeArray<MVPPreset>(presets);
  const categoryPresets = safePresets.filter((p) => {
    const pCat = p.category === 'Ридап' ? 'Редаб' : p.category;
    return pCat === activeCategory;
  });

  const activePreset =
    categoryPresets.find((p) => p.id === activePresetId) ||
    categoryPresets[0] ||
    safePresets[0];

  const handleSwitchCategory = (cat: MVPPresetCategory) => {
    setActiveCategoryState(cat);
    globalMVPPresetManager.setActiveCategory(cat);
    const targetPreset = globalMVPPresetManager.getActivePresetForCategory(cat);
    if (targetPreset) {
      setActivePresetId(targetPreset.id);
      onApplyPreset(targetPreset);
      showNotice(`Режим: "${cat}" — применен вариант: "${targetPreset.name}"`);
    }
  };

  const handleSelectPreset = (preset: MVPPreset) => {
    setActivePresetId(preset.id);
    globalMVPPresetManager.setActivePresetForCategory(activeCategory, preset.id);
    onApplyPreset(preset);
    setIsDropdownOpen(false);
    showNotice(`Применен пресет: "${preset.name}" (${preset.category})`);
  };

  const handleOpenSaveModal = () => {
    const userCategoryPresets = categoryPresets.filter((p) => !p.isBuiltIn);
    const nextIndex = userCategoryPresets.length + 1;
    setPresetName(`${activeCategory} — Вариант ${nextIndex}`);
    setPresetDescription(`Состояние плагинов и DSP для режима "${activeCategory}"`);
    setShowSaveModal(true);
    setIsDropdownOpen(false);
  };

  const handleSaveCurrentPipeline = (e: React.FormEvent) => {
    e.preventDefault();
    if (!presetName.trim()) return;

    const newPreset = globalMVPPresetManager.captureCurrentStateAsPreset(
      presetName.trim(),
      activeCategory,
      presetDescription.trim(),
      tracks,
      vocalBus,
      master
    );

    setShowSaveModal(false);
    setActivePresetId(newPreset.id);
    setPresetName('');
    setPresetDescription('');
    showNotice(`✅ Пресет "${newPreset.name}" сохранен в настройках [${activeCategory}]!`);
  };

  const handleOverwritePreset = (preset: MVPPreset, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Перезаписать пресет "${preset.name}" текущими настройками и плагинами студии?`)) {
      globalMVPPresetManager.overwritePresetState(preset.id, tracks, vocalBus, master);
      showNotice(`🔄 Пресет "${preset.name}" успешно обновлен текущим состоянием!`);
    }
  };

  const handleDeleteUserPreset = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Удалить пресет "${name}" из настроек [${activeCategory}]?`)) {
      globalMVPPresetManager.deleteUserPreset(id);
      // Если был удален активный пресет, переключаемся на базовый
      const remaining = categoryPresets.filter((p) => p.id !== id);
      if (remaining[0]) {
        handleSelectPreset(remaining[0]);
      }
      showNotice(`🗑️ Пресет "${name}" удален.`);
    }
  };

  const handleExportPreset = (preset: MVPPreset, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    globalMVPPresetManager.exportPresetToFile(preset);
    showNotice(`📥 Пресет "${preset.name}" экспортирован в файл .vomixpreset.`);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await globalMVPPresetManager.importPresetFromFile(file);
      // Если пресет принадлежит текущей категории или импортирован как пользовательский
      if (imported.category !== activeCategory) {
        imported.category = activeCategory;
      }
      setActivePresetId(imported.id);
      onApplyPreset(imported);
      showNotice(`📂 Пресет "${imported.name}" импортирован и активирован в [${activeCategory}]!`);
    } catch (err: any) {
      alert(`Ошибка импорта пресета: ${err.message || err}`);
    }
    e.target.value = '';
    setIsDropdownOpen(false);
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

  // Подсчет активных плагинов и этапов нейросетей в проекте
  const totalTrackPlugins = tracks.reduce((acc, t) => acc + (t.vstPlugins?.length || 0), 0);
  const vocalBusPluginsCount = vocalBus.vstPlugins?.length || 0;
  const masterPluginsCount = master.vstPlugins?.length || 0;
  const activeCategoryMeta = CATEGORIES.find((c) => c.id === activeCategory) || CATEGORIES[0];
  const aiConfigs = globalAIPipelineStore.getConfigs();
  const totalAISteps = Object.values(aiConfigs).reduce(
    (acc, c) => acc + (c && c.enabled ? toSafeArray(c.steps).filter((s) => s && s.enabled).length : 0),
    0
  );

  return (
    <div className="bg-[#0f1422] border border-[#1e293b] p-3 rounded-2xl shadow-xl space-y-2.5">
      {/* 1. Верхняя панель: 4 Главных режима общих настроек (Закадр, Рекаст, Редаб, Дубляж) */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        {/* Вкладки Режимов сведе́ния */}
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900/90 border border-slate-800 rounded-xl text-slate-300 font-bold text-xs shrink-0">
            <Sparkles size={14} className="text-cyan-400" />
            <span>Общие настройки:</span>
          </div>

          {CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => handleSwitchCategory(cat.id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer border ${
                  isActive
                    ? 'bg-gradient-to-r from-cyan-600 to-emerald-600 text-white border-cyan-400 shadow-md shadow-cyan-950/50 font-bold scale-[1.02]'
                    : 'bg-slate-900/80 hover:bg-slate-800 text-slate-300 border-slate-800 hover:border-slate-700'
                }`}
                title={`${cat.label}: ${cat.desc}`}
              >
                <span style={{ color: isActive ? '#fff' : cat.color }}>
                  {getPresetIcon(cat.icon, 13)}
                </span>
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>

        {/* 2. Правые управляющие действия */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer border ${
              showGuide
                ? 'bg-cyan-950/80 text-cyan-300 border-cyan-700/80'
                : 'bg-slate-900/80 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title="Справка по стандартам и требованиям режимов сведе́ния"
          >
            <Info size={13} className="text-cyan-400" />
            <span className="hidden sm:inline">Справка</span>
            {showGuide ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>

          <button
            onClick={handleOpenSaveModal}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-md shadow-emerald-950/60"
            title={`Сохранить текущее состояние плагинов и настроек в категорию [${activeCategory}]`}
          >
            <Save size={13} />
            <span>Сохранить состояние</span>
          </button>
        </div>
      </div>

      {/* 3. Внутренняя панель выбранного режима с Выпадающим Меню Пресетов */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 p-2 bg-slate-950/70 border border-slate-800/80 rounded-xl text-xs">
        {/* Левая часть: Выпадающее меню пресетов для текущей категории */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
            <Sliders size={12} className="text-emerald-400" />
            Пресеты [{activeCategory}]:
          </span>

          {/* Интерактивное выпадающее меню пресетов (Dropdown Menu) */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className="px-3 py-1.5 bg-slate-900 hover:bg-slate-850 border border-cyan-500/40 hover:border-cyan-400 text-cyan-200 rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer transition-all shadow-sm"
              title="Открыть выпадающее меню сохраненных вариантов пресета"
            >
              <span className="text-emerald-400">
                {getPresetIcon(activePreset?.icon || 'Mic2', 13)}
              </span>
              <span className="truncate max-w-[180px] sm:max-w-[240px]">
                {activePreset?.name || 'Пресет по умолчанию'}
              </span>
              <span className="text-[10px] px-1.5 py-0.2 bg-cyan-950/80 border border-cyan-800 text-cyan-300 rounded font-mono">
                {categoryPresets.length} вар.
              </span>
              <ChevronDown
                size={14}
                className={`text-slate-400 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {/* Выпадающий список пресетов категории */}
            {isDropdownOpen && (
              <div className="absolute left-0 top-full mt-1.5 w-80 sm:w-96 bg-[#0f1422] border border-cyan-500/40 rounded-2xl shadow-2xl z-50 p-2 space-y-1 animate-fadeIn">
                <div className="px-2.5 py-1.5 border-b border-slate-800 flex items-center justify-between text-[11px] font-bold text-slate-400">
                  <span>Варианты сведе́ния [{activeCategory}]</span>
                  <span className="text-[10px] text-cyan-400 font-mono">{categoryPresets.length} пресетов</span>
                </div>

                {/* Список пресетов */}
                <div className="max-h-60 overflow-y-auto space-y-1 pr-1 scrollbar-thin scrollbar-thumb-slate-800">
                  {categoryPresets.map((preset) => {
                    const isSelected = activePreset?.id === preset.id;
                    const isBuiltIn = !!preset.isBuiltIn;

                    return (
                      <div
                        key={preset.id}
                        onClick={() => handleSelectPreset(preset)}
                        className={`group p-2 rounded-xl border text-xs flex items-center justify-between gap-2 cursor-pointer transition-all ${
                          isSelected
                            ? 'bg-cyan-950/60 border-cyan-500/80 text-white font-bold shadow-inner'
                            : 'bg-slate-900/60 hover:bg-slate-900 border-slate-800/80 text-slate-300 hover:text-white'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span style={{ color: preset.color || '#10b981' }}>
                            {getPresetIcon(preset.icon || 'Mic2', 14)}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate">{preset.name}</span>
                              {isBuiltIn && (
                                <span className="text-[9px] px-1 py-0.2 bg-emerald-950/80 border border-emerald-800 text-emerald-300 rounded uppercase font-mono">
                                  Базовый
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-400 truncate max-w-[200px] font-normal">
                              {preset.description}
                            </div>
                          </div>
                        </div>

                        {/* Кнопки действий над пресетом */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={(e) => handleExportPreset(preset, e)}
                            className="p-1 hover:bg-cyan-950/80 text-slate-400 hover:text-cyan-300 rounded transition-all"
                            title="Экспортировать в файл .vomixpreset"
                          >
                            <Download size={12} />
                          </button>

                          {!isBuiltIn && (
                            <>
                              <button
                                onClick={(e) => handleOverwritePreset(preset, e)}
                                className="p-1 hover:bg-amber-950/80 text-slate-400 hover:text-amber-300 rounded transition-all"
                                title="Перезаписать текущим состоянием плагинов и DSP"
                              >
                                <RefreshCw size={12} />
                              </button>
                              <button
                                onClick={(e) => handleDeleteUserPreset(preset.id, preset.name, e)}
                                className="p-1 hover:bg-rose-950/80 text-slate-400 hover:text-rose-400 rounded transition-all"
                                title="Удалить пресет"
                              >
                                <Trash2 size={12} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Нижние действия в меню */}
                <div className="pt-2 border-t border-slate-800 flex items-center gap-1.5">
                  <button
                    onClick={handleOpenSaveModal}
                    className="flex-1 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 rounded-xl text-xs font-bold flex items-center justify-center gap-1 cursor-pointer transition-all"
                  >
                    <Plus size={13} />
                    <span>Добавить пресет</span>
                  </button>

                  <label className="py-1.5 px-3 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 rounded-xl text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer transition-all">
                    <FolderOpen size={13} className="text-cyan-400" />
                    <span>Импорт</span>
                    <input
                      type="file"
                      accept=".vomixpreset,.json"
                      onChange={handleImportFile}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Правая часть: Мета-информация о текущем состоянии */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-400 shrink-0">
          <div className="flex items-center gap-1.5">
            <Layers size={13} className="text-cyan-400" />
            <span>
              Плагины: <strong className="text-cyan-300">{totalTrackPlugins}</strong> на дорожках /{' '}
              <strong className="text-purple-300">{vocalBusPluginsCount}</strong> на шине /{' '}
              <strong className="text-emerald-300">{masterPluginsCount}</strong> на мастере
            </span>
          </div>

          <div className="flex items-center gap-1.5 bg-purple-950/40 px-2 py-0.5 rounded border border-purple-800/40 text-purple-300">
            <Sparkles size={11} className="text-purple-400" />
            <span>
              AI Матрица: <strong>{totalAISteps}</strong> {totalAISteps === 1 ? 'этап' : totalAISteps < 5 ? 'этапа' : 'этапов'}
            </span>
          </div>

          <button
            onClick={() => handleExportPreset(activePreset)}
            className="px-2 py-1 bg-slate-900 hover:bg-slate-850 text-slate-300 hover:text-white border border-slate-800 rounded-lg text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-all"
            title="Экспортировать текущий активный пресет в файл"
          >
            <Download size={11} />
            <span>Экспорт</span>
          </button>
        </div>
      </div>

      {/* Описание текущего режима / пресета */}
      {activePreset && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-slate-950/50 border border-slate-800/60 rounded-xl text-[11px] text-slate-300">
          <div className="flex items-center gap-2">
            <span className="font-bold text-cyan-400 font-mono">{activePreset.name}:</span>
            <span className="text-slate-400 truncate max-w-md sm:max-w-xl">
              {activePreset.description || activeCategoryMeta.desc}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 shrink-0">
            <span>
              Цель: <strong className="text-emerald-400">{activePreset.targetLufsDb || -18} LUFS</strong>
            </span>
          </div>
        </div>
      )}

      {/* Спецификация режимов (Collapsible Guide) */}
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
            {CATEGORIES.map((c) => (
              <div
                key={c.id}
                className={`p-2.5 rounded-lg border space-y-0.5 ${
                  activeCategory === c.id
                    ? 'bg-slate-900 border-cyan-500/50 shadow-sm'
                    : 'bg-slate-900/60 border-slate-800'
                }`}
              >
                <div className="font-bold flex items-center gap-1 text-[11px]" style={{ color: c.color }}>
                  {getPresetIcon(c.icon, 12)} {c.label}
                </div>
                <p className="text-slate-400 text-[10px] leading-tight">{c.desc}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toast-уведомление */}
      {notification && (
        <div className="p-2 bg-emerald-950/70 border border-emerald-500/40 rounded-xl text-xs text-emerald-300 flex items-center gap-2 animate-fadeIn shadow-lg">
          <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
          <span>{notification}</span>
        </div>
      )}

      {/* Модальное окно сохранения состояния в пресет */}
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
                  <h3 className="text-sm font-bold text-slate-100">Сохранить состояние в пресет</h3>
                  <p className="text-[11px] text-slate-400">
                    Категория: <strong className="text-cyan-400">{activeCategory}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSaveModal(false)}
                className="text-slate-400 hover:text-slate-100 p-1 rounded-lg"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-bold mb-1">Название пресета / варианта:</label>
                <input
                  type="text"
                  required
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder={`Например: ${activeCategory} — Мой мягкий компрессор`}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-cyan-400"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-slate-300 font-bold mb-1">Описание / заметки:</label>
                <textarea
                  value={presetDescription}
                  onChange={(e) => setPresetDescription(e.target.value)}
                  rows={2}
                  placeholder="Особенности цепочки плагинов, настройки эквалайзера и компрессии..."
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-cyan-400 resize-none"
                />
              </div>

              <div className="p-2.5 bg-slate-950/80 border border-slate-800 rounded-xl text-[11px] text-slate-400 space-y-1 font-mono">
                <div className="text-cyan-300 font-bold">Будет сохранено:</div>
                <div>• Нодовая структура роутинга рендера (все ноды, петли, последовательность сведения)</div>
                <div>• Матрица маршрутизации нейросетей (этапы, модели DeepFilter/UVR/VoiceFixer, параметры)</div>
                <div>• Настройки DSP (EQ, Comp, Gate, DeEsser, DeClicker, DePlosive, Auto-Ducker)</div>
                <div>• Все VST плагины и параметры на дорожках ({totalTrackPlugins} шт.)</div>
                <div>• Master Voiceover Bus ({vocalBusPluginsCount} VST плагинов + DSP)</div>
                <div>• Master Output ({masterPluginsCount} VST плагинов + Лимитер)</div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowSaveModal(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Отмена
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-lg shadow-emerald-950/50"
              >
                <Save size={14} />
                <span>Сохранить пресет</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
