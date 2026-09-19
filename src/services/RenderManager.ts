/**
 * ============================================================================
 * DAW EXPORT & FFMPEG WASM RENDER MANAGER (NATIVE C++ POWERED)
 * ============================================================================
 * Модуль финального рендеринга и видео-муксинга:
 * 1. Офлайн-рендеринг C++ DSP микса в стерео-буфер (Faster-than-realtime C++ BatchOfflineRenderer).
 * 2. Прямая генерация RIFF WAV заголовков в памяти WebAssembly (NativeWavPacker).
 * 3. Экспорт мультитрековых стемов (Dialogues.wav, Music.wav, SFX.wav, Bass.wav).
 * 4. Видео-муксинг и вшивание аудиодорожки через @ffmpeg/ffmpeg WebAssembly.
 * 5. Защита от переполнения памяти и поддержка SharedArrayBuffer / Single-Thread fallback.
 * ============================================================================
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { TrackState, MasterState } from '../audio/dawEngine';
import { WavBitDepth } from '../utils/wavEncoder';
import {
  NativeDAWBridge,
  globalNativeDAWBridge,
  NativeRenderAudioResult,
  NativeStemExportItem
} from './NativeDAWBridge';
import { systemLogger } from './SystemLogger';

export interface RenderProgressInfo {
  stage: 'idle' | 'rendering_audio' | 'stems' | 'loading_ffmpeg' | 'muxing_video' | 'completed' | 'error';
  progressPercent: number; // 0 .. 100
  message: string;
  logs: string[];
}

export type RenderAudioResult = NativeRenderAudioResult;
export type StemExportItem = NativeStemExportItem;

export class RenderManager {
  private ffmpeg: FFmpeg | null = null;
  private isFFmpegLoaded: boolean = false;
  private logs: string[] = [];
  private onProgressCallback?: (info: RenderProgressInfo) => void;

  constructor() {
    this.ffmpeg = new FFmpeg();
  }

  public setProgressCallback(cb: (info: RenderProgressInfo) => void) {
    this.onProgressCallback = cb;
  }

  private notifyProgress(stage: RenderProgressInfo['stage'], percent: number, message: string) {
    if (this.onProgressCallback) {
      this.onProgressCallback({
        stage,
        progressPercent: Math.min(100, Math.max(0, percent)),
        message,
        logs: [...this.logs]
      });
    }
  }

  private addLog(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${msg}`;
    this.logs.push(formatted);
    systemLogger.info('RenderManager', msg);
  }

  /**
   * Проверка поддержки SharedArrayBuffer (требуются HTTP-заголовки COOP/COEP)
   */
  public checkSharedArrayBufferSupport(): { supported: boolean; details: string } {
    const isCrossOriginIsolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    const hasSAB = typeof SharedArrayBuffer !== 'undefined';

    if (isCrossOriginIsolated && hasSAB) {
      return {
        supported: true,
        details: 'SharedArrayBuffer активен (Cross-Origin-Opener-Policy & Embedder-Policy настроены).'
      };
    } else {
      return {
        supported: false,
        details: 'SharedArrayBuffer недоступен (iFrame без COOP/COEP). Используется стабильный Single-Thread WASM режим.'
      };
    }
  }

  /**
   * Инициализация FFmpeg WASM ядра с fallback на Single-Thread при отсутствии COOP/COEP
   */
  public async loadFFmpeg(): Promise<boolean> {
    if (this.isFFmpegLoaded && this.ffmpeg) {
      return true;
    }

    this.notifyProgress('loading_ffmpeg', 10, 'Инициализация WebAssembly FFmpeg ядра...');
    this.addLog('Проверка окружения браузера для WebAssembly FFmpeg...');

    const sabCheck = this.checkSharedArrayBufferSupport();
    this.addLog(sabCheck.details);

    if (!this.ffmpeg) {
      this.ffmpeg = new FFmpeg();
    }

    // Слушатели логов и прогресса FFmpeg
    this.ffmpeg.on('log', ({ message }) => {
      this.addLog(`[FFmpeg Core] ${message}`);
    });

    this.ffmpeg.on('progress', ({ progress }) => {
      const p = Math.round(progress * 100);
      this.notifyProgress('muxing_video', 30 + Math.floor(p * 0.65), `Кодирование видео: ${p}%`);
    });

    try {
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
      this.addLog(`Загрузка WASM бинарников FFmpeg из CDN: ${baseURL}`);

      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
      });

      this.isFFmpegLoaded = true;
      this.addLog('WebAssembly FFmpeg ядро успешно загружено в память!');
      this.notifyProgress('loading_ffmpeg', 100, 'FFmpeg готов к работе.');
      return true;
    } catch (error) {
      const errStr = error instanceof Error ? error.message : String(error);
      this.addLog(`Ошибка инициализации FFmpeg: ${errStr}`);
      this.notifyProgress('error', 0, `Сбой загрузки FFmpeg: ${errStr}`);
      return false;
    }
  }

  /**
   * Высокоскоростной офлайн-рендеринг мастер-микса из графа дорожек DAW
   * Делегирует выполнение в C++ BatchOfflineRenderer через NativeDAWBridge.
   */
  public async renderMasterMix(
    tracks: TrackState[],
    master: MasterState,
    sampleRate: number = NativeDAWBridge.TARGET_SAMPLE_RATE,
    bitDepth: WavBitDepth = 24,
    customDurationSec?: number
  ): Promise<RenderAudioResult> {
    this.logs = [];
    this.addLog('Запуск нативного C++ офлайн-рендеринга мастер-микса...');
    this.notifyProgress('rendering_audio', 5, 'Анализ графа треков и распределение WebAssembly памяти...');

    const bridge = globalNativeDAWBridge;

    const result = await bridge.renderMasterMix(
      tracks,
      master,
      sampleRate,
      bitDepth,
      customDurationSec,
      (percent, message) => {
        this.notifyProgress('rendering_audio', percent, message);
        this.addLog(message);
      }
    );

    this.addLog(`Мастер-микс успешно собран в C++ ядре: ${Math.round(result.wavBlob.size / 1024)} КБ (${result.durationSec.toFixed(2)} сек)`);
    this.notifyProgress('completed', 100, 'Мастер-микс готов!');

    return result;
  }

  /**
   * Экспорт мультитрековых стемов (Stems: Dialogues.wav, Music.wav, SFX.wav и т.д.)
   * Выполняется с использованием C++ изолированного рендеринга стемов.
   */
  public async exportStems(
    tracks: TrackState[],
    master: MasterState,
    sampleRate: number = NativeDAWBridge.TARGET_SAMPLE_RATE,
    bitDepth: WavBitDepth = 24
  ): Promise<StemExportItem[]> {
    this.logs = [];
    this.addLog('Старт экспорта мультитрековых стемов через C++ ядро...');
    this.notifyProgress('stems', 5, 'Подготовка стемов к C++ рендеру...');

    const bridge = globalNativeDAWBridge;
    const stems = await bridge.exportStems(
      tracks,
      master,
      sampleRate,
      bitDepth,
      (percent, message) => {
        this.notifyProgress('stems', percent, message);
        this.addLog(message);
      }
    );

    this.addLog(`Экспорт всех стемов (${stems.length} шт.) успешно завершен.`);
    this.notifyProgress('completed', 100, `Готово! Создано ${stems.length} стем-файлов.`);
    return stems;
  }

  /**
   * Видео-муксинг: вшивание сведенного WAV аудио в исходное видео с помощью FFmpeg WASM
   * Заменяет оригинальную аудиодорожку в MP4/MKV/WebM без перекодирования видеопотока (-c:v copy).
   */
  public async muxAudioIntoVideo(
    sourceVideoFile: File,
    masterWavBlob: Blob,
    outputFileName: string = 'final_dubbed_video.mp4'
  ): Promise<Blob | null> {
    this.logs = [];
    this.addLog('Начало процесса вшивания аудиодорожки в видеофайл...');
    this.notifyProgress('muxing_video', 5, 'Проверка WebAssembly памяти и инициализация FFmpeg...');

    // Защита от переполнения памяти WebAssembly (2GB heap limit)
    const totalSizeMb = (sourceVideoFile.size + masterWavBlob.size) / (1024 * 1024);
    this.addLog(`Общий объем исходных медиафайлов: ${totalSizeMb.toFixed(1)} МБ`);

    if (totalSizeMb > 1500) {
      const warnMsg = `Внимание: размер исходных файлов (${totalSizeMb.toFixed(1)} МБ) близок к 32-битному лимиту памяти WASM. Рекомендуется использовать видеофайл меньшего размера.`;
      this.addLog(warnMsg);
    }

    const loaded = await this.loadFFmpeg();
    if (!loaded || !this.ffmpeg) {
      throw new Error('Не удалось инициализировать WebAssembly FFmpeg.');
    }

    try {
      this.notifyProgress('muxing_video', 20, 'Запись видео и аудио в виртуальную файловую систему MEMFS...');

      // Запись исходного видео
      this.addLog(`Запись входного видео [${sourceVideoFile.name}] в виртуальную ФС...`);
      await this.ffmpeg.writeFile('input_video.mp4', await fetchFile(sourceVideoFile));

      // Запись сведенного WAV
      this.addLog('Запись сведенного мастер-аудио [audio.wav] в виртуальную ФС...');
      await this.ffmpeg.writeFile('audio_mix.wav', await fetchFile(masterWavBlob));

      this.notifyProgress('muxing_video', 35, 'Выполнение FFmpeg команды муксинга (-c:v copy -c:a aac)...');
      this.addLog('Запуск FFmpeg: ffmpeg -i input_video.mp4 -i audio_mix.wav -c:v copy -c:a aac -b:a 320k -shortest output.mp4');

      // Быстрый стрим-копирование видео + кодирование аудио в высококачественный AAC 320k
      await this.ffmpeg.exec([
        '-i', 'input_video.mp4',
        '-i', 'audio_mix.wav',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '320k',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest',
        'output.mp4'
      ]);

      this.notifyProgress('muxing_video', 90, 'Чтение готового MP4 файла из виртуальной памяти...');
      this.addLog('Чтение результата output.mp4...');

      const outputData = await this.ffmpeg.readFile('output.mp4');
      const rawBytes = typeof outputData === 'string'
        ? new TextEncoder().encode(outputData)
        : outputData;
      const pureBuffer = new ArrayBuffer(rawBytes.byteLength);
      new Uint8Array(pureBuffer).set(rawBytes);
      const outputBlob = new Blob([pureBuffer], { type: 'video/mp4' });

      // Очистка виртуальной файловой системы для освобождения WASM памяти
      this.addLog('Очистка временных файлов виртуальной ФС...');
      await this.ffmpeg.deleteFile('input_video.mp4');
      await this.ffmpeg.deleteFile('audio_mix.wav');
      await this.ffmpeg.deleteFile('output.mp4');

      this.addLog(`Финальное видео успешно собрано: ${Math.round(outputBlob.size / 1024)} КБ!`);
      this.notifyProgress('completed', 100, 'Видео успешно создано!');

      return outputBlob;
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      this.addLog(`Критическая ошибка муксинга: ${errMessage}`);
      systemLogger.error('FFmpeg', `Критическая ошибка FFmpeg видеомуксинга: ${errMessage}`, err, err instanceof Error ? err.stack : undefined);
      this.notifyProgress('error', 0, `Ошибка FFmpeg: ${errMessage}`);
      return null;
    }
  }
}

export const globalRenderManager = new RenderManager();
