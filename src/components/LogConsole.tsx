import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  systemLogger,
  LogEntry,
  LogLevel,
  LogSource,
  DiagnosticReport
} from '../services/SystemLogger';
import {
  Terminal,
  AlertCircle,
  AlertTriangle,
  Info,
  Bug,
  Search,
  Trash2,
  Download,
  Copy,
  Check,
  Cpu,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  Zap,
  ArrowDownCircle,
  X,
  ExternalLink
} from 'lucide-react';

interface LogConsoleProps {
  isDrawer?: boolean;
  onClose?: () => void;
}

export const LogConsole: React.FC<LogConsoleProps> = ({ isDrawer = false, onClose }) => {
  const [logs, setLogs] = useState<LogEntry[]>(() => systemLogger.getLogs());
  const [filterLevel, setFilterLevel] = useState<LogLevel | 'all'>('all');
  const [filterSource, setFilterSource] = useState<LogSource | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [diagnosticReport, setDiagnosticReport] = useState<DiagnosticReport | null>(null);
  const [isRunningDiag, setIsRunningDiag] = useState(false);

  const listEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Подписка на обновления логов
  useEffect(() => {
    const unsubscribe = systemLogger.subscribe((updatedLogs) => {
      setLogs([...updatedLogs]);
    });
    return unsubscribe;
  }, []);

  // Автоскролл к последнему сообщению
  useEffect(() => {
    if (autoScroll && listEndRef.current) {
      listEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  // Фильтрация
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (filterLevel !== 'all' && log.level !== filterLevel) {
        return false;
      }
      if (filterSource !== 'all' && log.source !== filterSource) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const msgMatch = log.message.toLowerCase().includes(q);
        const srcMatch = log.source.toLowerCase().includes(q);
        const detailsMatch = log.details ? JSON.stringify(log.details).toLowerCase().includes(q) : false;
        const stackMatch = log.stack ? log.stack.toLowerCase().includes(q) : false;
        return msgMatch || srcMatch || detailsMatch || stackMatch;
      }
      return true;
    });
  }, [logs, filterLevel, filterSource, searchQuery]);

  const stats = useMemo(() => {
    let errors = 0;
    let warns = 0;
    let infos = 0;
    let debugs = 0;
    for (const log of logs) {
      if (log.level === 'error') errors++;
      else if (log.level === 'warn') warns++;
      else if (log.level === 'info') infos++;
      else if (log.level === 'debug') debugs++;
    }
    return { errors, warns, infos, debugs, total: logs.length };
  }, [logs]);

  const toggleExpand = (id: string) => {
    setExpandedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCopyAll = () => {
    const text = systemLogger.exportLogsAsText();
    navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  const handleRunDiagnostics = async () => {
    setIsRunningDiag(true);
    try {
      const rep = await systemLogger.runDiagnostics();
      setDiagnosticReport(rep);
    } finally {
      setIsRunningDiag(false);
    }
  };

  const handleSimulateTestError = () => {
    systemLogger.warn('Timeline', 'Тестовое предупреждение: обнаружен рассинхрон таймкодов на 12 мс.');
    try {
      throw new Error('Тестовое исключение VOMIXStudio: проверка захвата стека вызовов и трассировки');
    } catch (err: any) {
      systemLogger.error(
        'C++ WASM',
        'Сбой в тестовом модуле (симуляция ошибки): ' + err.message,
        {
          errorCode: 0xDEADBEEF,
          subsystem: 'TestDSP',
          params: { bufferSize: 1024, sampleRate: 48000 }
        },
        err.stack
      );
    }
  };

  const sourceList: (LogSource | 'all')[] = [
    'all',
    'AudioWorklet',
    'C++ WASM',
    'VSTPlugins',
    'VSTHost',
    'AudioAI',
    'DubbingAI',
    'MVPPipeline',
    'MVPPreset',
    'VideoSync',
    'FFmpeg',
    'MediaNormalizer',
    'Timeline',
    'RenderManager',
    'AssetDatabase',
    'GlobalError',
    'System'
  ];

  return (
    <div
      className={`flex flex-col bg-[#0b0f19] text-slate-200 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden ${
        isDrawer ? 'h-full' : 'min-h-[600px] h-[750px]'
      }`}
    >
      {/* 1. Хедер консоли */}
      <div className="bg-[#111625] px-4 py-3 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3 select-none">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-lg">
            <Terminal size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm text-slate-100 font-mono tracking-wide">
                СИСТЕМНАЯ КОНСОЛЬ & ДИАГНОСТИКА
              </span>
              <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full border border-slate-700 font-mono">
                {stats.total} событий
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Перехват ошибок в реальном времени, трейс стека и статус аппаратных возможностей
            </p>
          </div>
        </div>

        {/* Счетчики и быстрые кнопки действий */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 bg-slate-900/80 px-2.5 py-1 rounded-lg border border-slate-800 text-xs font-mono">
            <span
              className={`flex items-center gap-1 font-semibold ${
                stats.errors > 0 ? 'text-rose-400 animate-pulse' : 'text-slate-500'
              }`}
            >
              <AlertCircle size={13} /> {stats.errors} Ошибок
            </span>
            <span className="text-slate-600">|</span>
            <span
              className={`flex items-center gap-1 font-semibold ${
                stats.warns > 0 ? 'text-amber-400' : 'text-slate-500'
              }`}
            >
              <AlertTriangle size={13} /> {stats.warns} Предупр.
            </span>
            <span className="text-slate-600">|</span>
            <span className="flex items-center gap-1 text-cyan-400">
              <Info size={13} /> {stats.infos} Инфо
            </span>
          </div>

          <button
            onClick={handleRunDiagnostics}
            disabled={isRunningDiag}
            className="px-2.5 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 rounded-lg text-xs font-medium transition flex items-center gap-1.5"
            title="Проверить WebAudio, AudioWorklet, SIMD, SharedArrayBuffer и хранилище"
          >
            <ShieldCheck size={14} className={isRunningDiag ? 'animate-spin' : ''} />
            {isRunningDiag ? 'Проверка...' : 'Диагностика браузера'}
          </button>

          <button
            onClick={handleSimulateTestError}
            className="px-2.5 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded-lg text-xs font-medium transition flex items-center gap-1.5"
            title="Сгенерировать тестовую ошибку для проверки работы консоли"
          >
            <Bug size={14} />
            Тест сбоя
          </button>

          <button
            onClick={handleCopyAll}
            className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition flex items-center gap-1.5 border border-slate-700"
            title="Скопировать все логи в буфер обмена"
          >
            {copiedAll ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            {copiedAll ? 'Скопировано!' : 'Копировать'}
          </button>

          <div className="flex items-center gap-1">
            <button
              onClick={() => systemLogger.downloadLogFile('txt')}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition border border-slate-700"
              title="Скачать логи в формате TXT"
            >
              <Download size={14} />
            </button>
            <button
              onClick={() => systemLogger.clear()}
              className="p-1.5 bg-slate-800 hover:bg-rose-900/40 hover:text-rose-300 text-slate-400 rounded-lg text-xs transition border border-slate-700"
              title="Очистить все логи"
            >
              <Trash2 size={14} />
            </button>
          </div>

          {isDrawer && onClose && (
            <button
              onClick={onClose}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded-lg transition"
              title="Закрыть консоль"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* 2. Панель фильтров и поиска */}
      <div className="bg-[#0e1320] px-4 py-2.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 flex-1 min-w-[240px]">
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Поиск по сообщениям, стек-трейсам, компонентам..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Фильтр уровней */}
          <div className="flex items-center bg-slate-900 p-0.5 rounded-lg border border-slate-800">
            {(['all', 'error', 'warn', 'info', 'debug'] as const).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setFilterLevel(lvl)}
                className={`px-2 py-0.5 rounded text-[11px] font-mono transition capitalize ${
                  filterLevel === lvl
                    ? 'bg-slate-700 text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                } ${
                  lvl === 'error' && filterLevel === lvl
                    ? 'bg-rose-600 text-white'
                    : lvl === 'warn' && filterLevel === lvl
                    ? 'bg-amber-600 text-white'
                    : ''
                }`}
              >
                {lvl === 'all' ? 'Все' : lvl}
              </button>
            ))}
          </div>

          {/* Фильтр подсистем */}
          <select
            value={filterSource}
            onChange={(e) => setFilterSource(e.target.value as any)}
            className="bg-slate-900 border border-slate-800 text-slate-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-emerald-500/50 font-mono"
          >
            {sourceList.map((src) => (
              <option key={src} value={src}>
                {src === 'all' ? 'Все компоненты' : `[${src}]`}
              </option>
            ))}
          </select>
        </div>

        {/* Переключатель автоскролла */}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-slate-400 hover:text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-emerald-500 rounded cursor-pointer"
            />
            <span className="flex items-center gap-1 text-[11px]">
              <ArrowDownCircle size={12} /> Автопрокрутка вниз
            </span>
          </label>
        </div>
      </div>

      {/* 3. Модальное окно результатов диагностики (если запущена) */}
      {diagnosticReport && (
        <div className="bg-[#121829] border-b border-emerald-500/30 p-4 animate-fadeIn">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <ShieldCheck className="text-emerald-400" size={16} />
              <span className="font-semibold text-xs text-slate-100 font-mono">
                Отчёт о проверке окружения и системных API
              </span>
              <span className="text-[10px] text-slate-500 font-mono">
                {new Date(diagnosticReport.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <button
              onClick={() => setDiagnosticReport(null)}
              className="text-slate-400 hover:text-slate-200 text-xs px-2 py-0.5 rounded bg-slate-800"
            >
              Свернуть отчёт
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 mt-3 text-xs">
            {diagnosticReport.items.map((item, i) => (
              <div
                key={i}
                className={`p-2.5 rounded-xl border flex flex-col justify-between ${
                  item.status === 'ok'
                    ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200'
                    : item.status === 'warning'
                    ? 'bg-amber-950/20 border-amber-500/30 text-amber-200'
                    : 'bg-rose-950/20 border-rose-500/30 text-rose-200'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between font-mono font-semibold text-[11px] mb-1">
                    <span>{item.feature}</span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[9px] uppercase ${
                        item.status === 'ok'
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : item.status === 'warning'
                          ? 'bg-amber-500/20 text-amber-400'
                          : 'bg-rose-500/20 text-rose-400'
                      }`}
                    >
                      {item.status}
                    </span>
                  </div>
                  <p className="text-[11px] opacity-90">{item.value}</p>
                </div>
                {item.recommendation && (
                  <p className="mt-1.5 text-[10px] text-amber-300/80 bg-amber-500/10 p-1 rounded border border-amber-500/20">
                    Совет: {item.recommendation}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. Поток логов (Terminal stream) */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-3 space-y-1.5 font-mono text-[12px] selection:bg-emerald-500/30 select-text"
      >
        {filteredLogs.length === 0 ? (
          <div className="h-full min-h-[250px] flex flex-col items-center justify-center text-slate-500 gap-2">
            <Terminal size={32} className="opacity-40" />
            <p className="text-xs">Событий с выбранными фильтрами не найдено</p>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="text-xs text-emerald-400 hover:underline"
              >
                Сбросить строку поиска
              </button>
            )}
          </div>
        ) : (
          filteredLogs.map((log) => {
            const isExpanded = expandedLogIds.has(log.id);
            const hasDetails = Boolean(log.details || log.stack);

            const levelStyles = {
              error: 'border-l-4 border-rose-500 bg-rose-950/20 text-rose-200 hover:bg-rose-950/30',
              warn: 'border-l-4 border-amber-500 bg-amber-950/20 text-amber-200 hover:bg-amber-950/30',
              info: 'border-l-2 border-slate-700 bg-slate-900/40 text-slate-300 hover:bg-slate-900/70',
              debug: 'border-l-2 border-purple-500/50 bg-purple-950/10 text-purple-300 hover:bg-purple-950/20'
            }[log.level];

            const levelBadge = {
              error: (
                <span className="px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-400 font-bold text-[10px] flex items-center gap-1">
                  <AlertCircle size={10} /> ERR
                </span>
              ),
              warn: (
                <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 font-bold text-[10px] flex items-center gap-1">
                  <AlertTriangle size={10} /> WRN
                </span>
              ),
              info: (
                <span className="px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-400 font-bold text-[10px] flex items-center gap-1">
                  <Info size={10} /> INF
                </span>
              ),
              debug: (
                <span className="px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-400 font-bold text-[10px] flex items-center gap-1">
                  <Bug size={10} /> DBG
                </span>
              )
            }[log.level];

            return (
              <div
                key={log.id}
                className={`p-2 rounded-r-lg border border-slate-800/60 transition-all ${levelStyles}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 flex-1">
                    {/* Кнопка раскрытия если есть стек/детали */}
                    {hasDetails ? (
                      <button
                        onClick={() => toggleExpand(log.id)}
                        className="p-0.5 text-slate-400 hover:text-slate-100 transition mt-0.5"
                        title={isExpanded ? 'Свернуть детали' : 'Раскрыть детали ошибки и стек'}
                      >
                        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                    ) : (
                      <span className="w-3" />
                    )}

                    {/* Время */}
                    <span className="text-[11px] text-slate-500 shrink-0 select-none">
                      {log.timeStr}
                    </span>

                    {/* Уровень */}
                    <div className="shrink-0">{levelBadge}</div>

                    {/* Источник (Подсистема) */}
                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-semibold shrink-0 border ${
                        log.source === 'VSTPlugins' || log.source === 'VSTHost'
                          ? 'bg-fuchsia-950/70 text-fuchsia-300 border-fuchsia-700/60'
                          : log.source === 'AudioAI' || log.source === 'DubbingAI'
                          ? 'bg-sky-950/70 text-sky-300 border-sky-700/60'
                          : log.source === 'C++ WASM'
                          ? 'bg-emerald-950/70 text-emerald-300 border-emerald-700/60'
                          : log.source === 'AudioWorklet'
                          ? 'bg-teal-950/70 text-teal-300 border-teal-700/60'
                          : log.source === 'MVPPipeline' || log.source === 'MVPPreset'
                          ? 'bg-amber-950/70 text-amber-300 border-amber-700/60'
                          : log.source === 'VideoSync' || log.source === 'FFmpeg' || log.source === 'RenderManager'
                          ? 'bg-indigo-950/70 text-indigo-300 border-indigo-700/60'
                          : 'bg-slate-800 text-slate-300 border-slate-700/60'
                      }`}
                    >
                      [{log.source}]
                    </span>

                    {/* Сообщение */}
                    <span className="break-words flex-1 text-slate-200">
                      {log.message}
                    </span>
                  </div>

                  {/* Быстрое копирование конкретной строки */}
                  <div className="flex items-center gap-1 shrink-0 opacity-60 hover:opacity-100">
                    <button
                      onClick={() =>
                        copyToClipboard(
                          `[${log.timeStr}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}${
                            log.stack ? '\n' + log.stack : ''
                          }`,
                          log.id
                        )
                      }
                      className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition"
                      title="Скопировать лог"
                    >
                      {copiedId === log.id ? (
                        <Check size={12} className="text-emerald-400" />
                      ) : (
                        <Copy size={12} />
                      )}
                    </button>
                  </div>
                </div>

                {/* Раскрывающийся блок деталей и стека вызовов */}
                {isExpanded && hasDetails && (
                  <div className="mt-2.5 pt-2 border-t border-slate-800/80 pl-6 space-y-2 text-[11px]">
                    {log.details && (
                      <div className="bg-[#070a12] p-2.5 rounded-lg border border-slate-800/80 overflow-x-auto text-emerald-300">
                        <div className="text-[10px] text-slate-400 mb-1 font-sans font-semibold">
                          Параметры и контекст (JSON):
                        </div>
                        <pre className="font-mono text-[11px]">
                          {typeof log.details === 'string'
                            ? log.details
                            : JSON.stringify(log.details, null, 2)}
                        </pre>
                      </div>
                    )}

                    {log.stack && (
                      <div className="bg-[#10070a] p-2.5 rounded-lg border border-rose-900/40 overflow-x-auto text-rose-300">
                        <div className="text-[10px] text-rose-400 mb-1 font-sans font-semibold flex items-center justify-between">
                          <span>Трассировка стека вызовов (Stack Trace):</span>
                          <button
                            onClick={() => copyToClipboard(log.stack || '', `stack-${log.id}`)}
                            className="text-[10px] text-rose-400 hover:text-rose-200 underline"
                          >
                            Копировать стек
                          </button>
                        </div>
                        <pre className="font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
                          {log.stack}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={listEndRef} />
      </div>

      {/* 5. Нижняя панель подсказок */}
      <div className="bg-[#0e1320] px-4 py-2 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-500 select-none">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Служба мониторинга активна. Автоматический перехват необработанных сбоев включён.</span>
        </div>
        <div className="font-mono text-[10px] text-slate-400">
          VOMIXStudio Debugger v2.0 • 48 kHz
        </div>
      </div>
    </div>
  );
};
