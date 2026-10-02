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
 * 6. Локальный вспомогательный метод скачивания Blob через централизованный BlobUrlRegistry.
 * ============================================================================
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
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
import { BlobUrlRegistry } from '../utils/BlobUrlRegistry';
import { toSafeArray } from '../utils/safeIterables';
import { TauriNativeBridge } from './TauriNativeBridge';

export { BlobUrlRegistry };

/**
 * Безопасное чтение бинарных данных медиафайла без ограничений FileReader и риска OOM
 */
async function readBinaryMediaFile(file: File | Blob): Promise<Uint8Array> {
  // Для файлов больше 200 МБ в WebAssembly памяти выдаем понятную ошибку
  if (file.size > 200 * 1024 * 1024) {
    throw new Error(`Размер файла (${Math.round(file.size / (1024 * 1024))} МБ) превышает лимит браузерного буфера`);
  }

  // 1. Стандартный метод File.prototype.arrayBuffer()
  if (typeof file.arrayBuffer === 'function') {
    try {
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      console.warn('[readBinaryMediaFile] file.arrayBuffer() failed, fallback to Response stream:', e);
    }
  }

  // 2. Нативный Response stream
  try {
    const res = new Response(file);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } catch (e) {
    console.warn('[readBinaryMediaFile] Response(file).arrayBuffer() failed:', e);
  }

  throw new Error('Не удалось прочесть медиафайл в память');
}

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
   * Вспомогательный метод скачивания Blob в браузере с интеграцией BlobUrlRegistry
   */
  public downloadBlob(blob: Blob, filename: string): void {
    try {
      const url = BlobUrlRegistry.create(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => BlobUrlRegistry.revoke(url), 8000);
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
   * Гарантирует строгое 1-в-1 совпадение уровней громкости, панорамы и эффектов с предпрослушиванием.
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

    // Фиксация параметров каждого трека 1-в-1 с плеером предпрослушивания
    const safeTracks = toSafeArray<TrackState>(tracks);
    safeTracks.forEach((t) => {
      const isOrig = !!t.isOriginalAudio || /видео|video|оригинал|original/i.test(t.name || '');
      this.addLog(
        `[Player Balance] Трек #${t.id} [${t.name}] | Оригинал: ${isOrig ? 'Да' : 'Нет'} | Громкость: ${(t.volumeDb || 0).toFixed(1)} dB | Pan: ${(t.pan || 0).toFixed(2)} | Mute: ${!!t.mute} | Solo: ${!!t.solo}`
      );
    });

    if (vocalBus) {
      this.addLog(
        `[Vocal Bus] Громкость: ${(vocalBus.volumeDb || 0).toFixed(1)} dB | Mute: ${!!vocalBus.mute} | AutoDucker: ${vocalBus.dsp?.autoDucker?.enabled ? 'ВКЛ (Duck Depth: ' + (vocalBus.dsp.autoDucker.duckDepthDb ?? -8) + ' dB)' : 'ВЫКЛ'}`
      );
    }
    this.addLog(
      `[Master Mix] Громкость: ${(master.volumeDb || 0).toFixed(1)} dB | Limiter: ${master.limiterEnabled ? 'ВКЛ (Потолок: ' + (master.limiterCeilingDb ?? -0.1) + ' dB)' : 'ВЫКЛ'}`
    );

    const bridge = globalNativeDAWBridge;

    const result = await bridge.renderMasterMix(
      safeTracks,
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
   * Безопасное чтение срендеренных данных из кучи C++ с обновлением ссылок памяти и защитой границ
   */
  public readWasmBytesSafely(byteOffset: number, byteLength: number): Uint8Array {
    const bridge = globalNativeDAWBridge;
    const mod = bridge.getModule();
    if (mod && mod.memory) {
      mod.HEAPF32 = new Float32Array(mod.memory.buffer);
      mod.HEAPU8 = new Uint8Array(mod.memory.buffer);
    }
    const memBuffer = mod.memory?.buffer || mod.buffer || mod.wasmMemory?.buffer;
    if (!memBuffer) {
      throw new Error('[RenderManager] WebAssembly memory buffer недоступен');
    }
    const totalBufferBytes = memBuffer.byteLength;
    if (byteOffset + byteLength > totalBufferBytes) {
      throw new Error(`WASM Buffer Overflow: попытка прочесть [${byteOffset} .. ${byteOffset + byteLength}] при размере памяти ${totalBufferBytes}`);
    }
    // Использовать slice() для создания независимой копии в JS-памяти перед передачей в FFmpeg:
    return new Uint8Array(memBuffer.slice(byteOffset, byteOffset + byteLength));
  }

  /**
   * Видео-муксинг и экспорт: вшивание сведенного WAV аудио в видеофайл с гибкой настройкой качества
   */
  public async muxAudioIntoVideo(
    sourceVideoFile: File,
    masterWavBlob: Blob | Uint8Array,
    outputFileName: string = 'final_dubbed_video.mp4',
    options?: {
      timelineHasOriginalAudio?: boolean;
      exportParams?: Partial<VideoExportParameters>;
      wavPtr?: number;
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
    const audioByteLength = masterWavBlob instanceof Blob ? masterWavBlob.size : masterWavBlob.byteLength;
    const totalSizeMb = (sourceVideoFile.size + audioByteLength) / (1024 * 1024);
    this.addLog(`Общий объем исходных медиафайлов: ${totalSizeMb.toFixed(1)} МБ`);

    const isLossless = params.preset === 'lossless_original' || params.videoCodec === 'copy';
    const videoFilePath = (sourceVideoFile as any).path || (sourceVideoFile as any).webkitRelativePath;
    const inputExt = (sourceVideoFile.name.split('.').pop() || 'mp4').toLowerCase();
    const defaultExt = inputExt === 'mkv' ? 'mkv' : inputExt === 'webm' ? 'webm' : 'mp4';
    const ext = (params.container || defaultExt).toLowerCase();

    // 1. Попытка нативного муксинга через системный 64-битный FFmpeg (Tauri Desktop)
    if (TauriNativeBridge.isTauriEnvironment()) {
      try {
        const hasNativeFFmpeg = await TauriNativeBridge.isFFmpegAvailable();
        if (hasNativeFFmpeg) {
          this.addLog(`⚡ Обнаружен нативный 64-битный FFmpeg в системе. Выполняем прямой аппаратный муксинг без лимитов памяти WASM...`);
          this.notifyProgress('muxing_video', 30, 'Нативный FFmpeg муксинг без ограничений памяти...');

          let actualVideoPath = videoFilePath;

          // Если путь файла недоступен напрямую из объекта File, интерактивно запрашиваем его у пользователя через нативный диалог
          if (!actualVideoPath || typeof actualVideoPath !== 'string') {
            this.addLog(`Запрос расположения исходного видеофайла [${sourceVideoFile.name}] для нативного FFmpeg...`);
            const picked = await TauriNativeBridge.pickMediaFilesNative({
              multiple: false,
              title: `Укажите исходный видеофайл для нативного сведения (${sourceVideoFile.name})`,
              filters: [
                {
                  name: `Видео (${sourceVideoFile.name})`,
                  extensions: [inputExt, 'mkv', 'mp4', 'mov', 'webm', 'avi', 'm4v']
                }
              ]
            });
            if (picked && picked.length > 0) {
              actualVideoPath = picked[0].path;
              (sourceVideoFile as any).path = actualVideoPath;
              this.addLog(`Выбран исходный видеофайл: ${actualVideoPath}`);
            }
          }

          if (actualVideoPath && typeof actualVideoPath === 'string') {
            const dirSeparator = actualVideoPath.includes('\\') ? '\\' : '/';
            const lastIdx = actualVideoPath.lastIndexOf(dirSeparator);
            const dirPath = lastIdx > 0 ? actualVideoPath.substring(0, lastIdx) : '.';
            const tempWavPath = `${dirPath}${dirSeparator}temp_master_${Date.now()}.wav`;
            const finalOutputPath = `${dirPath}${dirSeparator}${outputFileName}`;

            this.notifyProgress('muxing_video', 40, 'Запись мастер-аудио на диск...');
            await TauriNativeBridge.saveFileDirect(tempWavPath, masterWavBlob, (pct) => {
              this.notifyProgress('muxing_video', 40 + Math.round(pct * 0.2), `Запись мастер-аудио на диск: ${pct}%`);
            });
            this.addLog(`Мастер-аудио записан на диск: ${tempWavPath}`);

            this.notifyProgress('muxing_video', 65, 'Нативный FFmpeg муксинг аудио в видео...');
            await TauriNativeBridge.runNativeFFmpegMux(actualVideoPath, tempWavPath, finalOutputPath, isLossless);
            this.addLog(`🎉 Нативный FFmpeg успешно собрал видеофайл: ${finalOutputPath}`);

            // Создаем легковесный результат с потоковым URL Tauri asset:// без выделения гигабайтов в JS RAM
            const assetUrl = TauriNativeBridge.convertFileSrc(finalOutputPath);
            const resultBlob = new Blob([], { type: ext === 'mkv' ? 'video/x-matroska' : 'video/mp4' });
            (resultBlob as any).nativePath = finalOutputPath;
            (resultBlob as any).path = finalOutputPath;
            (resultBlob as any).name = outputFileName;
            (resultBlob as any).assetUrl = assetUrl;
            (resultBlob as any).sizeBytes = (sourceVideoFile.size || 0) + audioByteLength;

            this.notifyProgress('completed', 100, 'Видео успешно сведено и экспортировано!');
            return resultBlob;
          }
        }
      } catch (nativeErr: any) {
        this.addLog(`Нативный FFmpeg вернул предупреждение (${nativeErr?.message || nativeErr}), переключаемся на WebAssembly...`);
      }
    }

    if (totalSizeMb > 1500) {
      const warnMsg = `Внимание: размер исходных файлов (${totalSizeMb.toFixed(1)} МБ) близок к 32-битному лимиту памяти WASM. Рекомендуется использовать видеофайл меньшего размера.`;
      this.addLog(warnMsg);
    }

    const loaded = await this.loadFFmpeg();
    if (!loaded || !this.ffmpeg) {
      throw new Error('Не удалось инициализировать WebAssembly FFmpeg.');
    }

    const inputFileName = `input_video.${inputExt}`;

    try {
      this.notifyProgress('muxing_video', 20, 'Запись видео и аудио в виртуальную файловую систему MEMFS...');

      // Запись исходного видео с правильным расширением контейнера
      this.addLog(`Запись входного видео [${sourceVideoFile.name}] в виртуальную ФС как ${inputFileName}...`);
      try {
        const videoBuffer = await readBinaryMediaFile(sourceVideoFile);
        await this.ffmpeg.writeFile(inputFileName, videoBuffer);
      } catch (allocErr: any) {
        const isMem = allocErr?.name === 'RangeError' || String(allocErr).includes('allocation failed') || String(allocErr).includes('out of memory') || String(allocErr).includes('could not be read');
        if (isMem) {
          const videoMb = (sourceVideoFile.size / (1024 * 1024)).toFixed(0);
          this.addLog(`⚠️ Память WebAssembly исчерпана: браузерный движок не может выделить ${videoMb} МБ памяти под видео.`);
          this.addLog(`✅ Сведенный мастер-аудио WAV (${(audioByteLength / (1024 * 1024)).toFixed(0)} МБ) сохранен!`);

          const audioBlob = masterWavBlob instanceof Blob ? masterWavBlob : new Blob([masterWavBlob as unknown as BlobPart], { type: 'audio/wav' });
          this.downloadBlob(audioBlob, `master_mix_${sourceVideoFile.name.replace(/\.[^/.]+$/, '')}.wav`);

          throw new Error(
            `Размер видео (${videoMb} МБ) превысил лимит памяти браузерного WebAssembly. ` +
            `Сведенный мастер-микс WAV сохранен и скачан!\n\n` +
            `Для мгновенного объединения без пересжатия используйте команду:\n` +
            `ffmpeg -i "${sourceVideoFile.name}" -i "master_mix.wav" -c:v copy -map 0:v:0 -map 1:a:0 "${outputFileName}"`
          );
        }
        throw allocErr;
      }

      // Запись сведенного WAV
      this.addLog('Запись сведенного мастер-аудио [audio_mix.wav] в виртуальную ФС...');
      const audioBlob = masterWavBlob instanceof Blob ? masterWavBlob : new Blob([masterWavBlob as unknown as BlobPart], { type: 'audio/wav' });
      try {
        const audioBuffer = await readBinaryMediaFile(audioBlob);
        await this.ffmpeg.writeFile('audio_mix.wav', audioBuffer);
      } catch (audioAllocErr: any) {
        this.downloadBlob(audioBlob, `master_mix_${sourceVideoFile.name.replace(/\.[^/.]+$/, '')}.wav`);
        throw new Error(
          `Недостаточно памяти для записи аудио в виртуальную ФС FFmpeg. Мастер-WAV сохранен на диск.`
        );
      }

      // Сразу после записи audio_mix.wav во внутреннюю ФС FFmpeg освобождаем промежуточный указатель в C++ куче через _free(wavPtr)
      const wavPtr = options?.wavPtr ?? (masterWavBlob as any)?.wavPtr;
      if (wavPtr && typeof wavPtr === 'number' && wavPtr > 0) {
        try {
          const mod = globalNativeDAWBridge.getModule();
          if (mod && typeof mod._free === 'function') {
            mod._free(wavPtr);
          } else {
            globalNativeDAWBridge.freeBytes(wavPtr);
          }
          this.addLog(`Освобожден временный указатель C++ кучи для WAV: 0x${wavPtr.toString(16)}`);
        } catch (freeErr) {
          console.warn('[RenderManager] Ошибка освобождения wavPtr в C++ куче:', freeErr);
        }
      }

      const hasTimelineOriginal = options?.timelineHasOriginalAudio ?? true;
      const isLossless = params.preset === 'lossless_original' || params.videoCodec === 'copy';
      const defaultExt = inputExt === 'mkv' ? 'mkv' : inputExt === 'webm' ? 'webm' : 'mp4';
      const ext = (params.container || defaultExt).toLowerCase();
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

      // Двухпроходный рендеринг (2-Pass VBR) при включенном режиме и перекодировании
      if (params.encodingPasses === 2 && !isLossless) {
        this.notifyProgress('muxing_video', 35, 'Выполнение Прохода 1/2 (2-Pass VBR анализ видеопотока)...');
        this.addLog('Старт Прохода 1/2 (2-Pass анализ движения и битрейта)...');
        try {
          await this.ffmpeg.exec([
            '-i', inputFileName,
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

      this.notifyProgress('muxing_video', 55, 'Финальный проход муксинга: объединение видео с C++ мастер-миксом...');
      this.addLog(`Запуск FFmpeg: замена аудиопотока на сведенный мастер-микс C++ DSP (1-в-1 с превью) в [${tempOutputFile}]...`);

      // СТРОГОЕ СООТВЕТСТВИЕ 1-В-1:
      // Если дорожка оригинала была на таймлайне, она уже сведена с нужным фейдером в audio_mix.wav.
      // Если же оригинал не был извлечен на таймлайн, адаптивно подмешиваем исходный аудиопоток видео 0:a:0.
      let ffmpegArgs: string[];
      if (hasTimelineOriginal) {
        ffmpegArgs = [
          '-i', inputFileName,
          '-i', 'audio_mix.wav',
          '-map', '0:v:0',
          '-map', '1:a:0',
          ...videoArgs,
          ...audioArgs,
          '-metadata:s:a:0', `title=${track1Title}`,
          '-shortest'
        ];
      } else {
        this.addLog('Звук оригинала видео подмешивается напрямую через FFmpeg amix к дорожкам дубляжа...');
        ffmpegArgs = [
          '-i', inputFileName,
          '-i', 'audio_mix.wav',
          '-filter_complex', '[0:a:0]volume=1.0[a0];[1:a:0]volume=1.0[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]',
          '-map', '0:v:0',
          '-map', '[aout]',
          ...videoArgs,
          ...audioArgs,
          '-metadata:s:a:0', `title=${track1Title}`,
          '-shortest'
        ];
      }

      if (params.fastStart && (ext === 'mp4' || ext === 'mov' || ext === 'm4v')) {
        ffmpegArgs.push('-movflags', '+faststart');
      }
      ffmpegArgs.push(tempOutputFile);

      this.addLog(`Выполнение команды FFmpeg: ffmpeg ${ffmpegArgs.join(' ')}`);
      await this.ffmpeg.exec(ffmpegArgs);

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
        await this.ffmpeg.deleteFile(inputFileName);
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
      throw err;
    }
  }
}

export const globalRenderManager = new RenderManager();
