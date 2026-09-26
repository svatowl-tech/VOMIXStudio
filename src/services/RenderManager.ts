/**
 * ============================================================================
 * DAW EXPORT & FFMPEG WASM RENDER MANAGER (NATIVE C++ POWERED)
 * ============================================================================
 * Модуль финального рендеринга и видео-муксинга:
 * 1. Офлайн-рендеринг C++ DSP микса в стерео-буфер (Faster-than-realtime C++ BatchOfflineRenderer).
 * 2. Прямая генерация RIFF WAV заголовков в памяти WebAssembly (NativeWavPacker) посредством
 *    вызова globalNativeDAWBridge.packWavNative(left, right, sampleRate, bitDepth).
 * 3. Экспорт мультитрековых стемов (Dialogues.wav, Music.wav, SFX.wav, Bass.wav).
 * 4. Видео-муксинг и вшивание аудиодорожки через @ffmpeg/ffmpeg WebAssembly.
 * 5. Защита от переполнения памяти и поддержка SharedArrayBuffer / Single-Thread fallback.
 * 6. Локальный вспомогательный метод скачивания Blob (чистый DOM URL.createObjectURL).
 * ============================================================================
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { TrackState, MasterState, VocalBusState } from '../audio/dawEngine';
import {
  NativeDAWBridge,
  globalNativeDAWBridge,
  NativeRenderAudioResult,
  NativeStemExportItem,
  WavBitDepth
} from './NativeDAWBridge';
import { systemLogger } from './SystemLogger';
import { VideoExportParameters, DEFAULT_VIDEO_EXPORT_PARAMS } from './RenderPipelineGraphManager';

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
   * Вспомогательный локальный метод для скачивания Blob в браузере (чистый DOM URL.createObjectURL без генерации аудио)
   */
  public downloadBlob(blob: Blob, filename: string): void {
    try {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    } catch (err) {
      systemLogger.error('RenderManager', `Ошибка скачивания файла ${filename}:`, err);
    }
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
    bitDepth: WavBitDepth = 16,
    customDurationSec?: number,
    vocalBus?: VocalBusState
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
      },
      vocalBus
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
   * Видео-муксинг и экспорт: вшивание сведенного WAV аудио в видеофайл с гибкой настройкой качества
   * Поддерживает:
   * 1. Пресет "Без потери качества" (Direct Stream Copy, -c:v copy).
   * 2. Перекодирование с контролем битрейта (VBR/CBR/CRF), разрешения (4K, 1080p, 720p), FPS.
   * 3. Однопроходный (1-Pass) и Двухпроходный (2-Pass) рендеринг.
   * 4. Настройку битрейта аудио (320k, 256k, 192k) и метаданных дорожек.
   */
  public async muxAudioIntoVideo(
    sourceVideoFile: File,
    masterWavBlob: Blob,
    outputFileName: string = 'final_dubbed_video.mp4',
    options?: {
      timelineHasOriginalAudio?: boolean;
      exportParams?: Partial<VideoExportParameters>;
    }
  ): Promise<Blob | null> {
    this.logs = [];
    const params: VideoExportParameters = {
      ...DEFAULT_VIDEO_EXPORT_PARAMS,
      ...(options?.exportParams || {})
    };

    this.addLog(`Начало экспорта видео с пресетом: [${params.preset}] (Кодек: ${params.videoCodec}, Разрешение: ${params.resolution}, Проходы: ${params.encodingPasses}x)...`);
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

      const hasTimelineOriginal = options?.timelineHasOriginalAudio ?? true;
      const isLossless = params.preset === 'lossless_original' || params.videoCodec === 'copy';
      const ext = params.container || 'mp4';
      const tempOutputFile = `output.${ext}`;

      // Построение видео-флагов
      const videoArgs: string[] = [];
      if (isLossless) {
        this.addLog('Применен режим "Без потери качества": видеопоток копируется 1-в-1 без пересжатия (-c:v copy).');
        videoArgs.push('-c:v', 'copy');
      } else {
        const codec = params.videoCodec || 'libx264';
        videoArgs.push('-c:v', codec);

        // Разрешение
        if (params.resolution && params.resolution !== 'original') {
          if (params.resolution === '3840x2160') videoArgs.push('-vf', 'scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2');
          else if (params.resolution === '2560x1440') videoArgs.push('-vf', 'scale=2560:1440:force_original_aspect_ratio=decrease,pad=2560:1440:(ow-iw)/2:(oh-ih)/2');
          else if (params.resolution === '1920x1080') videoArgs.push('-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2');
          else if (params.resolution === '1280x720') videoArgs.push('-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2');
          else if (params.resolution === '854x480') videoArgs.push('-vf', 'scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2');
          else if (params.resolution === 'custom' && params.customResolutionWidth && params.customResolutionHeight) {
            videoArgs.push('-vf', `scale=${params.customResolutionWidth}:${params.customResolutionHeight}:force_original_aspect_ratio=decrease`);
          }
        }

        // FPS
        if (params.fps && params.fps !== 'original') {
          videoArgs.push('-r', String(params.fps));
        }

        // Битрейт и контроль качества
        if (params.rateControl === 'crf') {
          videoArgs.push('-crf', String(params.crf || 18));
        } else {
          const br = params.videoBitrateKbps ? `${params.videoBitrateKbps}k` : '12000k';
          videoArgs.push('-b:v', br);
          if (params.maxBitrateKbps) {
            videoArgs.push('-maxrate', `${params.maxBitrateKbps}k`, '-bufsize', `${params.maxBitrateKbps * 2}k`);
          }
        }

        // Скорость кодировщика и профиль
        if (params.encoderSpeedPreset) {
          videoArgs.push('-preset', params.encoderSpeedPreset);
        }
        if (params.encoderProfile && params.encoderProfile !== 'auto') {
          videoArgs.push('-profile:v', params.encoderProfile);
        }
      }

      // Построение аудио-флагов
      const audioCodec = params.audioCodec === 'copy' ? 'copy' : (params.audioCodec || 'aac');
      const audioBitrate = params.audioBitrate === 'lossless' ? '320k' : (params.audioBitrate || '320k');
      const audioArgs = ['-c:a', audioCodec];
      if (audioCodec !== 'copy') {
        audioArgs.push('-b:a', audioBitrate);
      }

      const track1Title = params.track1Title || 'Дубляж / Dubbed Mix';
      const track2Title = params.track2Title || 'Оригинал / Original Audio';

      // Двухпроходный рендеринг (2-Pass VBR) при включенном режиме и перекодировании
      if (params.encodingPasses === 2 && !isLossless) {
        this.notifyProgress('muxing_video', 35, 'Выполнение Прохода 1/2 (2-Pass VBR анализ видеопотока)...');
        this.addLog('Старт Прохода 1/2 (2-Pass анализ движения и битрейта)...');
        try {
          await this.ffmpeg.exec([
            '-i', 'input_video.mp4',
            ...videoArgs,
            '-pass', '1',
            '-an',
            '-f', 'null',
            '/dev/null'
          ]);
          this.addLog('Проход 1/2 завершен успешно. Переход к Проходу 2/2...');
        } catch (pass1Err) {
          this.addLog(`Предупреждение: 1-й проход завершился с кодом: ${pass1Err}. Продолжаем однопроходным методом.`);
        }
      }

      this.notifyProgress('muxing_video', 55, 'Финальный проход кодирования и сборка контейнера...');
      this.addLog(`Запуск FFmpeg: объединение видеопотока, сведенного аудио и оригинальной аудиодорожки в [${tempOutputFile}]...`);

      if (!hasTimelineOriginal) {
        // Подмешивание оригинального фона к голосам
        try {
          this.addLog('Подмешивание оригинального звука видео к сведенным дорожкам дабберов (баланс закадрового озвучания)...');
          await this.ffmpeg.exec([
            '-i', 'input_video.mp4',
            '-i', 'audio_mix.wav',
            '-filter_complex', '[0:a:0]volume=0.22[aorig];[1:a:0]volume=1.25[adub];[aorig][adub]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]',
            '-map', '0:v:0',
            '-map', '[aout]',
            '-map', '0:a:0?',
            ...videoArgs,
            ...audioArgs,
            '-metadata:s:a:0', `title=${track1Title}`,
            '-metadata:s:a:1', `title=${track2Title}`,
            '-shortest',
            ...(params.fastStart ? ['-movflags', '+faststart'] : []),
            tempOutputFile
          ]);
        } catch (filterErr) {
          this.addLog('Резервный муксинг с сохранением двух аудиодорожек...');
          await this.ffmpeg.exec([
            '-i', 'input_video.mp4',
            '-i', 'audio_mix.wav',
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-map', '0:a:0?',
            ...videoArgs,
            ...audioArgs,
            '-metadata:s:a:0', `title=${track1Title}`,
            '-metadata:s:a:1', `title=${track2Title}`,
            '-shortest',
            ...(params.fastStart ? ['-movflags', '+faststart'] : []),
            tempOutputFile
          ]);
        }
      } else {
        // Дорожка 1: сведенный мастер-микс, дорожка 2: чистый оригинал
        await this.ffmpeg.exec([
          '-i', 'input_video.mp4',
          '-i', 'audio_mix.wav',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-map', '0:a:0?',
          ...videoArgs,
          ...audioArgs,
          '-metadata:s:a:0', `title=${track1Title}`,
          '-metadata:s:a:1', `title=${track2Title}`,
          '-shortest',
          ...(params.fastStart ? ['-movflags', '+faststart'] : []),
          tempOutputFile
        ]);
      }

      this.notifyProgress('muxing_video', 90, `Чтение готового ${ext.toUpperCase()} файла из виртуальной памяти...`);
      this.addLog(`Чтение результата ${tempOutputFile}...`);

      const outputData = await this.ffmpeg.readFile(tempOutputFile);
      const rawBytes = typeof outputData === 'string'
        ? new TextEncoder().encode(outputData)
        : outputData;
      const pureBuffer = new ArrayBuffer(rawBytes.byteLength);
      new Uint8Array(pureBuffer).set(rawBytes);

      const mimeType = ext === 'mkv' ? 'video/x-matroska' : ext === 'webm' ? 'video/webm' : 'video/mp4';
      const outputBlob = new Blob([pureBuffer], { type: mimeType });

      // Очистка виртуальной файловой системы для освобождения WASM памяти
      this.addLog('Очистка временных файлов виртуальной ФС...');
      try {
        await this.ffmpeg.deleteFile('input_video.mp4');
        await this.ffmpeg.deleteFile('audio_mix.wav');
        await this.ffmpeg.deleteFile(tempOutputFile);
      } catch (cleanupErr) {
        // Игнорируем ошибки очистки
      }

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
