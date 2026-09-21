import React, { useState, useEffect } from 'react';
import {
  Layers,
  FolderOpen,
  RefreshCw,
  Plus,
  Trash2,
  Power,
  Sliders,
  CheckCircle,
  Download,
  Upload,
  Search,
  Zap,
  SlidersHorizontal,
  Cpu,
  Sparkles,
  Info,
  CheckCircle2,
  Flame,
  Volume2,
  HardDrive,
  ShieldCheck,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
  FolderPlus
} from 'lucide-react';
import {
  VSTPluginDefinition,
  VSTScanDirectory,
  VSTScanStats,
  VSTPluginCategory,
  VSTPluginFormat
} from '../audio/vstTypes';
import { globalVSTHostEngine } from '../services/VSTHostEngine';
import { systemLogger } from '../services/SystemLogger';

export const VSTPluginManager: React.FC = () => {
  // Каталог плагинов и статистика сканирования
  const [catalog, setCatalog] = useState<VSTPluginDefinition[]>(() => globalVSTHostEngine.getAllPlugins());
  const [scanStats, setScanStats] = useState<VSTScanStats | null>(() => globalVSTHostEngine.getLastStats());
  const [scanDirs, setScanDirs] = useState<VSTScanDirectory[]>(() => globalVSTHostEngine.getScanDirectories());
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatusText, setScanStatusText] = useState('');
  const [customFolderPath, setCustomFolderPath] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedFormat, setSelectedFormat] = useState<string>('all');
  const [notification, setNotification] = useState<string | null>(null);

  // Подписка на обновления хоста плагинов
  useEffect(() => {
    const unsubHost = globalVSTHostEngine.subscribe(() => {
      setCatalog(globalVSTHostEngine.getAllPlugins());
      setScanStats(globalVSTHostEngine.getLastStats());
      setScanDirs(globalVSTHostEngine.getScanDirectories());
    });
    return unsubHost;
  }, []);

  const showNotice = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 4000);
  };

  // Запуск глубокого сканирования
  const handlePerformDeepScan = async () => {
    setIsScanning(true);
    setScanStatusText('Инициализация C++ сканера VST3/CLAP...');
    try {
      const stats = await globalVSTHostEngine.performDeepScan((msg) => {
        setScanStatusText(msg);
      });
      setScanStats(stats);
      setCatalog(globalVSTHostEngine.getAllPlugins());
      setScanDirs([...globalVSTHostEngine.getScanDirectories()]);
      showNotice(`Сканирование завершено: обнаружено ${stats.totalPlugins} плагинов!`);
    } catch (err: any) {
      showNotice(`Ошибка сканирования: ${err.message}`);
    } finally {
      setIsScanning(false);
      setScanStatusText('');
    }
  };

  // Добавление пользовательской папки для сканирования
  const handleAddCustomFolder = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customFolderPath.trim()) return;
    globalVSTHostEngine.addScanDirectory(customFolderPath.trim());
    setScanDirs([...globalVSTHostEngine.getScanDirectories()]);
    setCustomFolderPath('');
    showNotice(`Добавлена папка сканирования: "${customFolderPath.trim()}"`);
  };

  // Переключение состояния папки
  const handleToggleDirectory = (dirPath: string) => {
    globalVSTHostEngine.toggleScanDirectory(dirPath);
    setScanDirs([...globalVSTHostEngine.getScanDirectories()]);
  };

  // Удаление папки
  const handleRemoveDirectory = (dirPath: string) => {
    globalVSTHostEngine.removeScanDirectory(dirPath);
    setScanDirs([...globalVSTHostEngine.getScanDirectories()]);
    showNotice('Папка удалена из списка сканирования.');
  };

  // Переключение активности плагина в каталоге DAW (Включить / Выключить)
  const handleTogglePluginEnabled = (pluginId: string, currentEnabled: boolean) => {
    globalVSTHostEngine.setPluginEnabled(pluginId, !currentEnabled);
    setCatalog([...globalVSTHostEngine.getAllPlugins()]);
  };

  // Ручная загрузка бинарного VST3/CLAP/WASM файла плагина
  const handleManualPluginUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const format: VSTPluginFormat = ext === 'clap' ? 'CLAP' : ext === 'wasm' ? 'Native/WASM' : 'VST3';
      const newDef: VSTPluginDefinition = {
        id: `custom_${file.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}`,
        name: file.name.replace(/\.[^/.]+$/, ''),
        vendor: 'Custom Upload',
        category: 'Utility',
        format,
        version: '1.0.0',
        path: `/CustomPlugins/${file.name}`,
        is64Bit: true,
        latencySamples: 0,
        color: '#8b5cf6',
        description: `Пользовательский бинарный плагин (${format})`,
        parameters: [
          { id: 'param_gain', name: 'Gain', defaultValue: 0, min: -24, max: 12, unit: 'dB', step: 0.5 },
          { id: 'param_mix', name: 'Mix', defaultValue: 100, min: 0, max: 100, unit: '%', step: 1 }
        ],
        presets: []
      };
      globalVSTHostEngine.registerCustomPlugin(newDef);
      setCatalog([...globalVSTHostEngine.getAllPlugins()]);
      showNotice(`Плагин "${file.name}" успешно импортирован в библиотеку!`);
    } catch (err: any) {
      alert(`Ошибка загрузки плагина: ${err.message}`);
    }
    e.target.value = '';
  };

  // Фильтрация каталога
  const filteredCatalog = catalog.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.vendor.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCat = selectedCategory === 'all' || p.category.toLowerCase() === selectedCategory.toLowerCase();
    const matchesFormat = selectedFormat === 'all' || p.format.toLowerCase() === selectedFormat.toLowerCase();
    return matchesSearch && matchesCat && matchesFormat;
  });

  const enabledCount = catalog.filter((p) => globalVSTHostEngine.isPluginEnabled(p.id)).length;

  return (
    <div className="space-y-6 animate-fadeIn pb-12">
      {/* 1. HEADER & TOP BANNER */}
      <div className="bg-[#0f1422] border border-[#1e293b] p-5 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-gradient-to-tr from-cyan-600/20 to-blue-600/20 border border-cyan-500/30 rounded-xl text-cyan-400">
              <HardDrive size={24} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold text-slate-100">
                  Менеджер VST & CLAP Плагинов
                </h2>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-mono font-semibold">
                  Host & Directory Scanner
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Управление системными директориями, сканирование плагинов, включение/отключение в каталоге DAW
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Ручная загрузка плагина */}
            <label className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-200 rounded-xl text-xs font-semibold flex items-center gap-2 cursor-pointer transition-all shadow-sm">
              <Upload size={14} className="text-cyan-400" />
              <span>Загрузить .vst3 / .clap</span>
              <input
                type="file"
                accept=".vst3,.clap,.wasm,.dll,.dylib"
                onChange={handleManualPluginUpload}
                className="hidden"
              />
            </label>

            {/* Кнопка глубокого сканирования */}
            <button
              onClick={handlePerformDeepScan}
              disabled={isScanning}
              className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:from-slate-800 disabled:to-slate-800 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-2 shadow-lg shadow-cyan-950/40 cursor-pointer"
            >
              <RefreshCw size={14} className={isScanning ? 'animate-spin' : ''} />
              <span>{isScanning ? 'Сканирование...' : 'Глубокое сканирование'}</span>
            </button>
          </div>
        </div>

        {/* Индикатор статуса сканирования */}
        {isScanning && (
          <div className="p-3 bg-cyan-950/30 border border-cyan-500/30 rounded-xl text-xs text-cyan-300 flex items-center gap-2.5 animate-fadeIn">
            <RefreshCw size={15} className="animate-spin text-cyan-400 shrink-0" />
            <span className="font-mono">{scanStatusText || 'Идет сканирование системных путей VST3/CLAP...'}</span>
          </div>
        )}

        {/* Уведомление */}
        {notification && (
          <div className="p-3 bg-emerald-950/40 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 flex items-center gap-2 animate-fadeIn">
            <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
            <span>{notification}</span>
          </div>
        )}

        {/* Статистика сканирования */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
          <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-500 font-mono">Всего плагинов</div>
            <div className="text-lg font-bold text-slate-100 mt-0.5">{catalog.length}</div>
            <div className="text-[10px] text-emerald-400 mt-0.5">Включено: {enabledCount}</div>
          </div>

          <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-500 font-mono">Формат VST3</div>
            <div className="text-lg font-bold text-cyan-400 mt-0.5">
              {catalog.filter((p) => p.format === 'VST3').length}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">64-bit Architecture</div>
          </div>

          <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-500 font-mono">Формат CLAP / WASM</div>
            <div className="text-lg font-bold text-purple-400 mt-0.5">
              {catalog.filter((p) => p.format === 'CLAP' || p.format === 'Native/WASM').length}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">Zero-Latency DSP</div>
          </div>

          <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-500 font-mono">Папок в реестре</div>
            <div className="text-lg font-bold text-amber-400 mt-0.5">{scanDirs.length}</div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              {scanDirs.filter((d) => d.enabled).length} активных
            </div>
          </div>
        </div>
      </div>

      {/* 2. УПРАВЛЕНИЕ ДИРЕКТОРИЯМИ СКАНИРОВАНИЯ */}
      <div className="bg-[#0f1422] border border-[#1e293b] p-5 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-400">
              <FolderOpen size={18} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100">
                Директории сканирования плагинов
              </h3>
              <p className="text-[11px] text-slate-400">
                Стандартные системные пути Windows / macOS / Linux и пользовательские каталоги
              </p>
            </div>
          </div>
        </div>

        {/* Форма добавления пути */}
        <form onSubmit={handleAddCustomFolder} className="flex gap-2">
          <div className="relative flex-1">
            <FolderPlus size={14} className="absolute left-3 top-3 text-slate-500" />
            <input
              type="text"
              placeholder="Введите путь к папке (например: C:\VstPlugins или /Library/Audio/Plug-Ins/VST3)..."
              value={customFolderPath}
              onChange={(e) => setCustomFolderPath(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
          >
            <Plus size={13} className="text-emerald-400" />
            <span>Добавить папку</span>
          </button>
        </form>

        {/* Список директорий */}
        <div className="space-y-2">
          {scanDirs.map((dir) => (
            <div
              key={dir.path}
              className={`p-3 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                dir.enabled
                  ? 'bg-slate-950/70 border-slate-800 hover:border-slate-700'
                  : 'bg-slate-950/30 border-slate-850 opacity-60'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <button
                  onClick={() => handleToggleDirectory(dir.path)}
                  className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                    dir.enabled
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : 'bg-slate-900 text-slate-600'
                  }`}
                  title={dir.enabled ? 'Директория активна' : 'Директория отключена'}
                >
                  <Power size={13} />
                </button>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-200 truncate font-mono">
                      {dir.path}
                    </span>
                    {dir.isSystemDefault && (
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono">
                        System Default
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-500 flex items-center gap-2 mt-0.5">
                    <span>Плагинов: {dir.pluginCount ?? 0}</span>
                    {dir.lastScannedAt && <span>• Сканировано: {dir.lastScannedAt}</span>}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleRemoveDirectory(dir.path)}
                  className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-950/30 transition-colors cursor-pointer"
                  title="Удалить директорию"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 3. КАТАЛОГ СКАНИРОВАННЫХ ПЛАГИНОВ (ВКЛЮЧЕНИЕ / ВЫКЛЮЧЕНИЕ В DAW) */}
      <div className="bg-[#0f1422] border border-[#1e293b] p-5 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-cyan-500/10 border border-cyan-500/20 rounded-xl text-cyan-400">
              <Layers size={18} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100">
                Каталог плагинов в системе ({filteredCatalog.length})
              </h3>
              <p className="text-[11px] text-slate-400">
                Включайте или отключайте плагины для отображения в инсертах дорожек и шин
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                catalog.forEach((p) => globalVSTHostEngine.setPluginEnabled(p.id, true));
                setCatalog([...globalVSTHostEngine.getAllPlugins()]);
              }}
              className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded-lg text-[11px] font-medium cursor-pointer"
            >
              Включить все
            </button>
            <button
              onClick={() => {
                catalog.forEach((p) => globalVSTHostEngine.setPluginEnabled(p.id, false));
                setCatalog([...globalVSTHostEngine.getAllPlugins()]);
              }}
              className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-400 border border-slate-800 rounded-lg text-[11px] font-medium cursor-pointer"
            >
              Отключить все
            </button>
          </div>
        </div>

        {/* Фильтры и поиск */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-3 text-slate-500" />
            <input
              type="text"
              placeholder="Поиск по названию, производителю или категории..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {['all', 'EQ', 'Dynamics', 'Reverb', 'Restoration', 'Limiter', 'Saturation', 'Utility'].map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                  selectedCategory === cat
                    ? 'bg-cyan-600 text-white shadow-sm shadow-cyan-950/40'
                    : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-slate-800'
                }`}
              >
                {cat === 'all' ? 'Все категории' : cat}
              </button>
            ))}
          </div>
        </div>

        {/* Сетка карточек плагинов */}
        {filteredCatalog.length === 0 ? (
          <div className="p-8 text-center bg-slate-950/40 border border-dashed border-slate-850 rounded-xl space-y-3">
            <div className="w-12 h-12 mx-auto rounded-2xl bg-cyan-950/40 border border-cyan-800/30 flex items-center justify-center text-cyan-400">
              <Layers size={24} />
            </div>
            <div className="text-sm font-semibold text-slate-300">Плагины не найдены в каталоге</div>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Укажите рабочие папки с установленными VST3/CLAP плагинами на вашем компьютере выше и нажмите «Сканировать VST-директории».
            </p>
            <button
              onClick={handlePerformDeepScan}
              disabled={isScanning}
              className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-xl text-xs font-semibold inline-flex items-center gap-2 cursor-pointer shadow-md shadow-cyan-950/40"
            >
              <RefreshCw size={14} className={isScanning ? 'animate-spin' : ''} />
              <span>Запустить сканирование</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
            {filteredCatalog.map((plugin) => {
              const isEnabled = globalVSTHostEngine.isPluginEnabled(plugin.id);
              const isWasmCore = plugin.format === 'Native/WASM' || plugin.isBuiltIn;
              return (
                <div
                  key={plugin.id}
                  className={`p-3.5 rounded-xl border transition-all flex flex-col justify-between ${
                    isEnabled
                      ? 'bg-slate-950/80 border-slate-800 hover:border-cyan-500/40'
                      : 'bg-slate-950/30 border-slate-850 opacity-60'
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <h4 className="text-xs font-bold text-slate-100 truncate">{plugin.name}</h4>
                          {isWasmCore && (
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-purple-950/60 text-purple-300 border border-purple-800/50 font-mono">
                              WASM Native Core
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-1.5">
                          <span>{plugin.vendor}</span>
                          <span>•</span>
                          <span className="text-cyan-400 font-mono">{plugin.format}</span>
                        </div>
                      </div>

                      {/* Toggle Switch */}
                      <button
                        onClick={() => handleTogglePluginEnabled(plugin.id, isEnabled)}
                        className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 cursor-pointer shrink-0 ${
                          isEnabled
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'bg-slate-900 text-slate-500 border border-slate-800'
                        }`}
                      >
                        <Power size={11} />
                        <span>{isEnabled ? 'ВКЛ' : 'ВЫКЛ'}</span>
                      </button>
                    </div>

                    <p className="text-[11px] text-slate-400 line-clamp-2 mb-3">
                      {plugin.description || 'Студийный VST/CLAP плагин обработки звука.'}
                    </p>
                  </div>

                  <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-[10px] font-mono text-slate-500">
                    <span className="px-1.5 py-0.2 rounded bg-slate-900 border border-slate-800 text-slate-400">
                      {plugin.category}
                    </span>
                    <span>Параметров: {plugin.parameters?.length || 0}</span>
                    <span>Latency: {plugin.latencySamples || 0} smp</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
