import React, { Component, ErrorInfo, ReactNode } from 'react';
import { systemLogger } from '../services/SystemLogger';
import {
  AlertTriangle,
  RefreshCw,
  Trash2,
  Copy,
  Check,
  Download,
  ChevronDown,
  ChevronUp,
  Cpu,
  Layers,
  HelpCircle,
  ShieldAlert,
  Info,
  RotateCcw
} from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  copied: boolean;
  activeTab: 'summary' | 'stack' | 'system';
  isConfirmingReset: boolean;
}

interface ErrorExplanation {
  title: string;
  category: string;
  description: string;
  possibleCauses: string[];
  recommendation: string;
}

/**
 * Интеллектуальный анализатор ошибок JavaScript & React
 */
function analyzeError(error: Error | null): ErrorExplanation {
  if (!error) {
    return {
      title: 'Неизвестное исключение',
      category: 'Неопределено',
      description: 'Произошел сбой выполнения без указания объекта ошибки.',
      possibleCauses: ['Асинхронный сбой в фоновом потоке'],
      recommendation: 'Перезагрузите страницу для сброса состояния.'
    };
  }

  const message = error.message || String(error);
  const name = error.name || 'Error';

  // 1. Ошибки итерации (is not iterable)
  if (message.includes('is not iterable') || message.includes('Spread syntax requires') || message.includes('cannot be iterated')) {
    return {
      title: 'Сбой итерации неитерируемого объекта',
      category: 'TypeError: Safe Iterables',
      description: 'Компонент попытался перебрать переменную (через [ ... spread ], for...of, .map, .forEach или Array.from), которая оказалась null, undefined, числом или обычным объектом.',
      possibleCauses: [
        'Импорт медиафайла или проекта вернул нестандартную структуру данных (tracks / clips / steps)',
        'Список дорожек или клипов еще не инициализирован в момент рендеринга',
        'Внешнее событие передало не-массив в обработчик синхронизации'
      ],
      recommendation: 'Рекомендуется перезагрузить страницу или повторить импорт через стандартизированный хаб «Импорт медиа».'
    };
  }

  // 2. Ошибки обращения к свойствам undefined/null
  if (
    message.includes('Cannot read properties of undefined') ||
    message.includes('Cannot read property') ||
    message.includes('Cannot read properties of null') ||
    message.includes('is undefined') ||
    message.includes('is null')
  ) {
    return {
      title: 'Обращение к свойству несуществующего объекта',
      category: 'TypeError: Null Pointer / Undefined Property',
      description: 'Попытка прочитать свойство или вызвать метод у объекта, который не был передан или еще не загрузился.',
      possibleCauses: [
        'Обращение к PCM буферу клипа или параметру VST до его полной распаковки в памяти',
        'Несинхронизированное состояние между C++ WebAssembly ядром и React UI',
        'Отсутствие обязательного поля в загруженном файле проекта'
      ],
      recommendation: 'Попробуйте нажать «Попробовать продолжить» или перезагрузить страницу.'
    };
  }

  // 3. Ошибки вызова функции (is not a function)
  if (message.includes('is not a function')) {
    return {
      title: 'Вызов нефункции как функции',
      category: 'TypeError: Invalid Invocation',
      description: 'Попытка вызвать метод (например, .map(), .filter(), .forEach(), .subscribe()), который отсутствует у переданного значения.',
      possibleCauses: [
        'Вместо массива был передан простой словарь {} или примитив',
        'Устаревшая ссылка на метод службы после горячей перезагрузки'
      ],
      recommendation: 'Перезагрузите приложение для обновления ссылок модулей.'
    };
  }

  // 4. Ошибки аудио ядра, WASM и WebAudio
  if (
    message.includes('AudioContext') ||
    message.includes('AudioWorklet') ||
    message.includes('WASM') ||
    message.includes('WebAssembly') ||
    message.includes('memory access out of bounds') ||
    message.includes('out of memory')
  ) {
    return {
      title: 'Сбой C++ WebAssembly или Web Audio ядра',
      category: 'AudioEngine / WASM Runtime',
      description: 'Возникла критическая ошибка при взаимодействии с низкоуровневым C++ микшером или буфером AudioWorklet.',
      possibleCauses: [
        'Превышение лимита памяти браузера при рендеринге сверхдлинного аудиофайла',
        'Браузер заблокировал инициализацию AudioContext (требуется клик пользователя)',
        'Попытка доступа к освобожденному участку памяти в C++ heap'
      ],
      recommendation: 'Перезагрузите страницу и убедитесь, что в браузере не открыто слишком много тяжелых вкладок.'
    };
  }

  // 5. Ошибки парсинга JSON или проекта
  if (message.includes('JSON') || message.includes('SyntaxError')) {
    return {
      title: 'Ошибка синтаксиса или формата данных',
      category: 'SyntaxError / Format',
      description: 'Не удалось разобрать входящий файл проекта, субтитры или сохраненное состояние.',
      possibleCauses: [
        'Поврежденный файл проекта project.json или некорректный формат субтитров',
        'Повреждение данных в локальном хранилище localStorage'
      ],
      recommendation: 'Используйте кнопку «Полный сброс» для очистки поврежденного кэша проекта.'
    };
  }

  // Общее поведение
  return {
    title: name || 'Ошибка выполнения интерфейса',
    category: `${name}: Runtime Exception`,
    description: message,
    possibleCauses: [
      'Внутренний сбой состояния компонента',
      'Непредвиденное взаимодействие между модулями студии'
    ],
    recommendation: 'Перезагрузите страницу или скопируйте отчет об ошибке для анализа.'
  };
}

/**
 * Извлечение ключевого имени компонента из componentStack
 */
function extractFailedComponent(componentStack: string | null | undefined): string | null {
  if (!componentStack) return null;
  const lines = componentStack.trim().split('\n');
  for (const line of lines) {
    const match = line.match(/in\s+([A-Za-z0-9_]+)/);
    if (match && match[1] && match[1] !== 'ErrorBoundary') {
      return match[1];
    }
  }
  return null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    copied: false,
    activeTab: 'summary',
    isConfirmingReset: false
  };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
      copied: false,
      activeTab: 'summary',
      isConfirmingReset: false
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    systemLogger.error('System', `Критическая ошибка интерфейса: ${error.message}`, {
      error: error.toString(),
      name: error.name,
      stack: error.stack,
      componentStack: errorInfo.componentStack
    });
    this.setState({ error, errorInfo });
  }

  private handleTryRecover = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      copied: false,
      isConfirmingReset: false
    });
  };

  private handleCopyReport = () => {
    const { error, errorInfo } = this.state;
    const explanation = analyzeError(error);
    const failedComponent = extractFailedComponent(errorInfo?.componentStack);

    const report = [
      '# VOMIXStudio Crash Report',
      `**Дата и время:** ${new Date().toISOString()}`,
      `**URL:** ${typeof window !== 'undefined' ? window.location.href : 'unknown'}`,
      `**Браузер (User-Agent):** ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
      `**Упавший компонент:** <${failedComponent || 'Unknown'} />`,
      '',
      '## Ошибка',
      `\`\`\``,
      `${error?.name || 'Error'}: ${error?.message || String(error)}`,
      `\`\`\``,
      '',
      '## Анализ проблемы',
      `- **Тип:** ${explanation.category}`,
      `- **Суть:** ${explanation.description}`,
      `- **Рекомендация:** ${explanation.recommendation}`,
      '',
      '## Стек JavaScript (Call Stack)',
      `\`\`\``,
      `${error?.stack || 'No call stack available'}`,
      `\`\`\``,
      '',
      '## Стек компонентов React (Component Stack)',
      `\`\`\``,
      `${errorInfo?.componentStack || 'No component stack available'}`,
      `\`\`\``
    ].join('\n');

    navigator.clipboard.writeText(report).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 3000);
    }).catch(() => {});
  };

  private handleDownloadLog = () => {
    systemLogger.downloadLogFile('json');
  };

  private handleHardReset = () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
        indexedDB.databases().then((dbs) => {
          (dbs || []).forEach((db) => {
            if (db && db.name) indexedDB.deleteDatabase(db.name);
          });
        }).catch(() => {});
      }
    } catch {}
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      const { error, errorInfo, copied, activeTab, isConfirmingReset } = this.state;
      const explanation = analyzeError(error);
      const failedComponent = extractFailedComponent(errorInfo?.componentStack);

      return (
        <div className="min-h-screen bg-[#06090e] text-slate-100 flex items-center justify-center p-4 sm:p-6 font-sans">
          <div className="max-w-2xl w-full bg-[#0b101b] border border-slate-800/90 rounded-2xl shadow-2xl shadow-black/80 overflow-hidden flex flex-col">
            
            {/* Header */}
            <div className="p-6 pb-4 border-b border-slate-800/80 bg-gradient-to-r from-red-950/30 via-slate-900/50 to-slate-900/30">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center space-x-3.5">
                  <div className="w-11 h-11 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center text-red-400 shrink-0 shadow-lg shadow-red-950/40">
                    <ShieldAlert size={22} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h1 className="text-base sm:text-lg font-bold text-slate-100 tracking-tight">
                        Ошибка интерфейса
                      </h1>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-red-500/20 text-red-300 border border-red-500/30">
                        {explanation.category}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      VOMIXStudio перехватил сбой рендеринга и защитил проект от повреждения
                    </p>
                  </div>
                </div>

                {failedComponent && (
                  <div className="hidden sm:flex flex-col items-end shrink-0">
                    <span className="text-[10px] uppercase font-mono text-slate-400 tracking-wider">Компонент:</span>
                    <span className="text-xs font-mono font-bold text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/50 mt-0.5">
                      &lt;{failedComponent} /&gt;
                    </span>
                  </div>
                )}
              </div>

              {/* Error Message Pill */}
              <div className="mt-4 bg-[#05070d] border border-red-500/30 rounded-xl p-3.5 font-mono text-xs text-red-300 break-all select-text shadow-inner flex items-start gap-2.5">
                <AlertTriangle size={15} className="text-red-400 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{error?.toString() || 'Неизвестная ошибка рендеринга'}</span>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex border-b border-slate-800/80 bg-slate-950/60 px-6 pt-2 gap-2 text-xs font-medium">
              <button
                type="button"
                onClick={() => this.setState({ activeTab: 'summary' })}
                className={`pb-2.5 px-3 flex items-center gap-1.5 transition-colors border-b-2 cursor-pointer ${
                  activeTab === 'summary'
                    ? 'border-cyan-500 text-cyan-400 font-semibold'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <HelpCircle size={14} />
                Диагностика и причины
              </button>

              <button
                type="button"
                onClick={() => this.setState({ activeTab: 'stack' })}
                className={`pb-2.5 px-3 flex items-center gap-1.5 transition-colors border-b-2 cursor-pointer ${
                  activeTab === 'stack'
                    ? 'border-cyan-500 text-cyan-400 font-semibold'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Layers size={14} />
                Стек компонентов React
              </button>

              <button
                type="button"
                onClick={() => this.setState({ activeTab: 'system' })}
                className={`pb-2.5 px-3 flex items-center gap-1.5 transition-colors border-b-2 cursor-pointer ${
                  activeTab === 'system'
                    ? 'border-cyan-500 text-cyan-400 font-semibold'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Cpu size={14} />
                Снимок окружения
              </button>
            </div>

            {/* Tab Contents */}
            <div className="p-6 overflow-y-auto max-h-[320px] text-xs space-y-4 select-text scrollbar-thin">
              {activeTab === 'summary' && (
                <div className="space-y-3.5">
                  {/* Human-Readable Explanation */}
                  <div className="bg-slate-950/80 border border-slate-800/90 rounded-xl p-3.5 space-y-2">
                    <div className="text-[11px] uppercase tracking-wider font-mono font-bold text-slate-400 flex items-center gap-1.5">
                      <Info size={13} className="text-cyan-400" />
                      Что произошло:
                    </div>
                    <p className="text-slate-200 leading-relaxed text-xs">
                      {explanation.description}
                    </p>
                  </div>

                  {/* Possible Causes */}
                  <div className="bg-slate-950/80 border border-slate-800/90 rounded-xl p-3.5 space-y-2">
                    <div className="text-[11px] uppercase tracking-wider font-mono font-bold text-slate-400 flex items-center gap-1.5">
                      <AlertTriangle size={13} className="text-amber-400" />
                      Возможные причины:
                    </div>
                    <ul className="list-disc list-inside space-y-1 text-slate-300 text-xs">
                      {explanation.possibleCauses.map((cause, idx) => (
                        <li key={idx} className="leading-relaxed">
                          {cause}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Recommendation */}
                  <div className="bg-emerald-950/20 border border-emerald-900/40 rounded-xl p-3.5 space-y-1 text-emerald-300">
                    <div className="text-[11px] uppercase tracking-wider font-mono font-bold text-emerald-400">
                      Рекомендованное действие:
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      {explanation.recommendation}
                    </p>
                  </div>
                </div>
              )}

              {activeTab === 'stack' && (
                <div className="space-y-3">
                  {errorInfo?.componentStack ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                        <span>Стек компонентов React:</span>
                        {failedComponent && (
                          <span className="text-cyan-400 font-bold">Упал в &lt;{failedComponent} /&gt;</span>
                        )}
                      </div>
                      <pre className="bg-[#05070d] border border-slate-800 rounded-xl p-3 font-mono text-[11px] text-slate-300 overflow-x-auto whitespace-pre leading-relaxed">
                        {errorInfo.componentStack.trim()}
                      </pre>
                    </div>
                  ) : null}

                  {error?.stack && (
                    <div className="space-y-1.5">
                      <div className="text-[11px] font-mono text-slate-400">Стек вызовов JavaScript:</div>
                      <pre className="bg-[#05070d] border border-slate-800 rounded-xl p-3 font-mono text-[11px] text-slate-400 overflow-x-auto whitespace-pre leading-relaxed">
                        {error.stack}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'system' && (
                <div className="space-y-2.5 font-mono text-xs">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
                      <span className="text-[10px] text-slate-400 uppercase">Браузер:</span>
                      <p className="text-slate-200 text-[11px] truncate" title={navigator.userAgent}>
                        {navigator.userAgent}
                      </p>
                    </div>

                    <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
                      <span className="text-[10px] text-slate-400 uppercase">Экран / Окно:</span>
                      <p className="text-slate-200 text-[11px]">
                        {typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight} (DPR: ${window.devicePixelRatio || 1})` : 'unknown'}
                      </p>
                    </div>

                    <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
                      <span className="text-[10px] text-slate-400 uppercase">Аудио ядро:</span>
                      <p className="text-slate-200 text-[11px]">
                        {typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext) ? 'WebAudio OK • 48 kHz' : 'WebAudio не обнаружен'}
                      </p>
                    </div>

                    <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
                      <span className="text-[10px] text-slate-400 uppercase">Штатные логи:</span>
                      <p className="text-cyan-400 text-[11px]">
                        {systemLogger.getLogs().length} записей ({systemLogger.getErrorsCount()} ошибок)
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Actions Footer */}
            <div className="p-6 pt-4 border-t border-slate-800/80 bg-slate-950/80 space-y-3">
              <div className="flex flex-wrap items-center gap-2.5">
                {/* Try Recover */}
                <button
                  type="button"
                  onClick={this.handleTryRecover}
                  className="flex items-center justify-center space-x-1.5 px-3.5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs rounded-xl transition-all shadow-md shadow-emerald-950/40 cursor-pointer"
                  title="Попробовать восстановить интерфейс без перезагрузки"
                >
                  <RotateCcw size={14} />
                  <span>Попробовать продолжить</span>
                </button>

                {/* Reload */}
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="flex-1 flex items-center justify-center space-x-1.5 px-4 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs rounded-xl transition-all shadow-md shadow-cyan-950/40 cursor-pointer min-w-[130px]"
                >
                  <RefreshCw size={14} />
                  <span>Перезагрузить</span>
                </button>

                {/* Copy Report */}
                <button
                  type="button"
                  onClick={this.handleCopyReport}
                  className={`flex items-center justify-center space-x-1.5 px-3.5 py-2.5 border rounded-xl font-medium text-xs transition-all cursor-pointer ${
                    copied
                      ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
                      : 'bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-300'
                  }`}
                  title="Скопировать структурированный отчет для отладки"
                >
                  {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                  <span>{copied ? 'Скопировано!' : 'Копировать отчет'}</span>
                </button>

                {/* Download Log */}
                <button
                  type="button"
                  onClick={this.handleDownloadLog}
                  className="flex items-center justify-center space-x-1.5 px-3.5 py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 font-medium text-xs rounded-xl transition-all cursor-pointer"
                  title="Скачать системные логи в формате JSON"
                >
                  <Download size={14} />
                  <span className="hidden sm:inline">Лог (.json)</span>
                </button>
              </div>

              {/* Hard Reset Section */}
              <div className="pt-2 flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-800/60">
                <span>Если ошибка сохраняется после перезагрузки:</span>
                {!isConfirmingReset ? (
                  <button
                    type="button"
                    onClick={() => this.setState({ isConfirmingReset: true })}
                    className="flex items-center gap-1 text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                  >
                    <Trash2 size={13} />
                    <span>Сбросить кэш и базу</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-rose-400 font-semibold">Очистить проект и кэш?</span>
                    <button
                      type="button"
                      onClick={this.handleHardReset}
                      className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded text-[11px] font-bold cursor-pointer"
                    >
                      Да, сбросить
                    </button>
                    <button
                      type="button"
                      onClick={() => this.setState({ isConfirmingReset: false })}
                      className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] cursor-pointer"
                    >
                      Отмена
                    </button>
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
