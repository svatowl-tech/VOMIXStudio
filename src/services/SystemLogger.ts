/**
 * ============================================================================
 * SYSTEM LOGGER & RUNTIME DIAGNOSTICS SERVICE
 * ============================================================================
 * Централизованная служба логирования и диагностики для VOMIXStudio:
 * - Перехват глобальных ошибок window.onerror и unhandledrejection
 * - Структурированные логи с уровнями: DEBUG, INFO, WARN, ERROR
 * - Точная локализация подсистемы (AudioWorklet, C++ WASM, FFmpeg, Video, Timeline и т.д.)
 * - Запись стека ошибок и сериализация параметров
 * - Запуск глубокой браузерной диагностики аппаратных и WebAPI возможностей
 * - Экспорт логов в JSON / TXT для быстрой отладки
 * ============================================================================
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSource =
  | 'AudioWorklet'
  | 'C++ WASM'
  | 'FFmpeg'
  | 'MediaNormalizer'
  | 'VideoSync'
  | 'Timeline'
  | 'AssetDatabase'
  | 'Project'
  | 'RenderManager'
  | 'DubbingAI'
  | 'VSTHost'
  | 'MVPPreset'
  | 'System'
  | 'GlobalError';

export interface LogEntry {
  id: string;
  timestamp: number;
  timeStr: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  details?: any;
  stack?: string;
}

export interface DiagnosticItem {
  feature: string;
  status: 'ok' | 'warning' | 'error';
  value: string;
  recommendation?: string;
}

export interface DiagnosticReport {
  timestamp: string;
  userAgent: string;
  isCrossOriginIsolated: boolean;
  hasSharedArrayBuffer: boolean;
  hasAudioWorklet: boolean;
  hasWebAudio: boolean;
  hasWasmSIMD: boolean;
  hardwareConcurrency: number;
  memoryEstimate?: { quotaMb: number; usageMb: number };
  items: DiagnosticItem[];
}

type LogListener = (logs: LogEntry[], newEntry: LogEntry | null) => void;

class SystemLoggerService {
  private static instance: SystemLoggerService;
  private logs: LogEntry[] = [];
  private readonly MAX_LOGS = 1500;
  private listeners: Set<LogListener> = new Set();
  private isHooked = false;

  private originalConsoleError: typeof console.error = console.error;
  private originalConsoleWarn: typeof console.warn = console.warn;

  private constructor() {
    this.initGlobalHooks();
    this.info('System', 'Служба системного логирования VOMIXStudio инициализирована.');
  }

  public static getInstance(): SystemLoggerService {
    if (!SystemLoggerService.instance) {
      SystemLoggerService.instance = new SystemLoggerService();
    }
    return SystemLoggerService.instance;
  }

  /**
   * Подключение глобальных перехватчиков window.onerror, unhandledrejection
   * и безопасное оборачивание console.error / console.warn
   */
  private initGlobalHooks() {
    if (this.isHooked || typeof window === 'undefined') return;
    this.isHooked = true;

    // 1. Перехват необработанных исключений JavaScript
    window.addEventListener('error', (event) => {
      const errorObj = event.error;
      const fileInfo = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : 'unknown';
      this.error(
        'GlobalError',
        `Необработанная ошибка JS: ${event.message || 'Unknown error'} (${fileInfo})`,
        {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: errorObj ? String(errorObj) : undefined
        },
        errorObj instanceof Error ? errorObj.stack : undefined
      );
    });

    // 2. Перехват необработанных отклонений промисов
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      let msg = 'Unhandled Promise Rejection';
      let stack: string | undefined;

      if (reason instanceof Error) {
        msg = reason.message;
        stack = reason.stack;
      } else if (typeof reason === 'string') {
        msg = reason;
      } else if (reason && typeof reason === 'object') {
        try {
          msg = JSON.stringify(reason);
        } catch {
          msg = String(reason);
        }
      }

      this.error(
        'GlobalError',
        `Сбой асинхронного промиса (Unhandled Rejection): ${msg}`,
        { reason },
        stack
      );
    });

    // 3. Безопасный перехват console.error
    console.error = (...args: any[]) => {
      try {
        const msg = args.map((a) => (typeof a === 'object' ? this.safeSerialize(a) : String(a))).join(' ');
        
        // Определяем источник по содержимому
        let source: LogSource = 'System';
        if (msg.includes('AudioWorklet') || msg.includes('audio-engine')) source = 'AudioWorklet';
        else if (msg.includes('FFmpeg') || msg.includes('ffmpeg')) source = 'FFmpeg';
        else if (msg.includes('WASM') || msg.includes('C++') || msg.includes('NativeDAW')) source = 'C++ WASM';
        else if (msg.includes('RenderManager')) source = 'RenderManager';
        else if (msg.includes('MediaNormalizer')) source = 'MediaNormalizer';

        // Проверяем, не наш ли это внутренний лог
        if (!msg.startsWith('[SystemLogger]')) {
          this.logInternal('error', source, msg, args.length > 1 ? args : undefined);
        }
      } catch {
        // Защита от рекурсии
      }
      this.originalConsoleError.apply(console, args);
    };

    // 4. Безопасный перехват console.warn
    console.warn = (...args: any[]) => {
      try {
        const msg = args.map((a) => (typeof a === 'object' ? this.safeSerialize(a) : String(a))).join(' ');
        let source: LogSource = 'System';
        if (msg.includes('AudioWorklet') || msg.includes('audio-engine')) source = 'AudioWorklet';
        else if (msg.includes('FFmpeg') || msg.includes('ffmpeg')) source = 'FFmpeg';
        else if (msg.includes('MediaNormalizer')) source = 'MediaNormalizer';

        if (!msg.startsWith('[SystemLogger]')) {
          this.logInternal('warn', source, msg, args.length > 1 ? args : undefined);
        }
      } catch {
        // Защита от рекурсии
      }
      this.originalConsoleWarn.apply(console, args);
    };
  }

  private safeSerialize(obj: any): string {
    if (obj instanceof Error) {
      return `${obj.name}: ${obj.message}\n${obj.stack || ''}`;
    }
    try {
      return JSON.stringify(obj, (_key, val) => {
        if (val instanceof Float32Array || val instanceof Uint8Array || val instanceof ArrayBuffer) {
          return `[Binary ${val.constructor.name} length=${val.byteLength}]`;
        }
        if (typeof val === 'function') {
          return '[Function]';
        }
        return val;
      });
    } catch {
      return String(obj);
    }
  }

  private formatTime(date: Date): string {
    const pad = (n: number, z = 2) => String(n).padStart(z, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  }

  private logInternal(
    level: LogLevel,
    source: LogSource,
    message: string,
    details?: any,
    stack?: string
  ): LogEntry {
    const now = new Date();
    const entry: LogEntry = {
      id: `${now.getTime()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: now.getTime(),
      timeStr: this.formatTime(now),
      level,
      source,
      message,
      details,
      stack: stack || (details instanceof Error ? details.stack : undefined)
    };

    this.logs.push(entry);
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.shift();
    }

    this.notifyListeners(entry);
    return entry;
  }

  public debug(source: LogSource, message: string, details?: any) {
    return this.logInternal('debug', source, message, details);
  }

  public info(source: LogSource, message: string, details?: any) {
    return this.logInternal('info', source, message, details);
  }

  public warn(source: LogSource, message: string, details?: any) {
    return this.logInternal('warn', source, message, details);
  }

  public error(source: LogSource, message: string, details?: any, stack?: string) {
    return this.logInternal('error', source, message, details, stack);
  }

  public clear() {
    this.logs = [];
    this.notifyListeners(null);
  }

  public getLogs(): LogEntry[] {
    return [...this.logs];
  }

  public getErrorsCount(): number {
    return this.logs.filter((l) => l.level === 'error').length;
  }

  public getWarningsCount(): number {
    return this.logs.filter((l) => l.level === 'warn').length;
  }

  public subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    listener(this.getLogs(), null);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(newEntry: LogEntry | null) {
    const current = this.getLogs();
    this.listeners.forEach((listener) => {
      try {
        listener(current, newEntry);
      } catch (err) {
        this.originalConsoleError('[SystemLogger] Listener error:', err);
      }
    });
  }

  /**
   * Запуск глубокой диагностики возможностей браузера
   */
  public async runDiagnostics(): Promise<DiagnosticReport> {
    this.info('System', 'Запуск системной диагностики окружения браузера и аудио-ядра...');

    const items: DiagnosticItem[] = [];

    // 1. Web Audio API
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const hasWebAudio = Boolean(AudioCtx);
    if (hasWebAudio) {
      let sampleRate = 48000;
      let state = 'unknown';
      try {
        const testCtx = new AudioCtx();
        sampleRate = testCtx.sampleRate;
        state = testCtx.state;
        await testCtx.close().catch(() => {});
      } catch {}
      items.push({
        feature: 'Web Audio API',
        status: 'ok',
        value: `Поддерживается (SampleRate: ${sampleRate} Hz, статус: ${state})`
      });
    } else {
      items.push({
        feature: 'Web Audio API',
        status: 'error',
        value: 'Не поддерживается данным браузером',
        recommendation: 'Используйте современный браузер на базе Chromium, Firefox или Safari.'
      });
    }

    // 2. AudioWorklet
    const hasAudioWorklet = Boolean(window.AudioWorkletNode);
    items.push({
      feature: 'AudioWorklet API',
      status: hasAudioWorklet ? 'ok' : 'error',
      value: hasAudioWorklet ? 'Доступен (real-time low-latency аудиопоток)' : 'Отсутствует в браузере',
      recommendation: hasAudioWorklet ? undefined : 'Без AudioWorklet воспроизведение с C++ DSP микшером невозможно.'
    });

    // 3. SharedArrayBuffer & Cross-Origin Isolation
    const isIso = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    const hasSAB = typeof SharedArrayBuffer !== 'undefined';
    if (isIso && hasSAB) {
      items.push({
        feature: 'SharedArrayBuffer (COOP/COEP)',
        status: 'ok',
        value: 'Активен (поддерживается многопоточный FFmpeg WASM и zero-copy transfer)'
      });
    } else {
      items.push({
        feature: 'SharedArrayBuffer (COOP/COEP)',
        status: 'warning',
        value: 'Отключен (контейнер iFrame без COOP/COEP)',
        recommendation: 'FFmpeg WASM автоматически использует стабильный Single-Thread режим без блокировки.'
      });
    }

    // 4. WebAssembly & SIMD
    let hasWasmSIMD = false;
    try {
      // Проверка поддержки SIMD в WebAssembly
      hasWasmSIMD = WebAssembly.validate(
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 26, 11])
      );
      items.push({
        feature: 'WebAssembly SIMD (128-bit)',
        status: hasWasmSIMD ? 'ok' : 'warning',
        value: hasWasmSIMD ? 'Аппаратный SIMD активен (максимальная скорость C++ DSP)' : 'SIMD не активен (fallback на стандартный WASM)'
      });
    } catch {
      items.push({
        feature: 'WebAssembly SIMD',
        status: 'warning',
        value: 'Проверка завершилась с ошибкой (используется скалярный C++ fallback)'
      });
    }

    // 5. Hardware Concurrency (Количество CPU ядер)
    const cores = navigator.hardwareConcurrency || 4;
    items.push({
      feature: 'Процессорные потоки (CPU Concurrency)',
      status: cores >= 4 ? 'ok' : 'warning',
      value: `${cores} логических ядер`,
      recommendation: cores < 4 ? 'При малом числе ядер рендеринг видео может занимать больше времени.' : undefined
    });

    // 6. Хранилище (Storage Estimate / OPFS / IndexedDB)
    let quotaMb = 0;
    let usageMb = 0;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        quotaMb = Math.round((estimate.quota || 0) / (1024 * 1024));
        usageMb = Math.round((estimate.usage || 0) / (1024 * 1024));
        items.push({
          feature: 'Дисковая квота браузера (IndexedDB / Cache)',
          status: 'ok',
          value: `Использовано ${usageMb} МБ из ${quotaMb} МБ доступных`
        });
      }
    } catch (e) {
      items.push({
        feature: 'Storage Quota',
        status: 'warning',
        value: 'Не удалось получить квоту хранилища'
      });
    }

    // 7. Поддержка видеодекодеров (MP4 / WebM)
    const videoElem = document.createElement('video');
    const mp4Support = videoElem.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
    const webmSupport = videoElem.canPlayType('video/webm; codecs="vp8, vorbis"');
    items.push({
      feature: 'Видеодекодер браузера',
      status: mp4Support ? 'ok' : 'warning',
      value: `MP4 (H.264): "${mp4Support || 'no'}", WebM (VP8/VP9): "${webmSupport || 'no'}"`
    });

    const report: DiagnosticReport = {
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      isCrossOriginIsolated: isIso,
      hasSharedArrayBuffer: hasSAB,
      hasAudioWorklet,
      hasWebAudio,
      hasWasmSIMD,
      hardwareConcurrency: cores,
      memoryEstimate: quotaMb > 0 ? { quotaMb, usageMb } : undefined,
      items
    };

    this.info('System', 'Диагностика успешно выполнена. Сводка параметров:', report);
    return report;
  }

  /**
   * Экспорт всех логов в виде JSON
   */
  public exportLogsAsJson(): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        totalLogs: this.logs.length,
        errorsCount: this.getErrorsCount(),
        warningsCount: this.getWarningsCount(),
        logs: this.logs
      },
      null,
      2
    );
  }

  /**
   * Экспорт всех логов в виде форматированного текста
   */
  public exportLogsAsText(): string {
    const lines = [
      `================================================================================`,
      `VOMIXStudio Runtime Logs Dump`,
      `Exported: ${new Date().toLocaleString()}`,
      `UserAgent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
      `Total: ${this.logs.length} | Errors: ${this.getErrorsCount()} | Warnings: ${this.getWarningsCount()}`,
      `================================================================================`,
      ''
    ];

    for (const log of this.logs) {
      lines.push(`[${log.timeStr}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`);
      if (log.details) {
        lines.push(`  Details: ${this.safeSerialize(log.details)}`);
      }
      if (log.stack) {
        lines.push(`  Stack: ${log.stack}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Скачивание файла логов в браузере
   */
  public downloadLogFile(format: 'json' | 'txt' = 'txt') {
    const content = format === 'json' ? this.exportLogsAsJson() : this.exportLogsAsText();
    const mimeType = format === 'json' ? 'application/json' : 'text/plain';
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vomix-debug-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.info('System', `Лог-файл сохранен в формате ${format.toUpperCase()}`);
  }
}

export const systemLogger = SystemLoggerService.getInstance();
