/**
 * ============================================================================
 * TAURI NATIVE BRIDGE (Windows & macOS Native Integration)
 * ============================================================================
 * Двусторонний мост между React/WASM фронтендом и нативным C++/Rust ядром Tauri v2.
 * Автоматически определяет среду запуска (Desktop vs Browser Web)
 * и направляет операции сканирования и отображения GUI VST плагинов.
 * ============================================================================
 */

import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import * as tauriPath from '@tauri-apps/api/path';
import * as tauriFs from '@tauri-apps/plugin-fs';

export interface NativeFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface WaveShellSubPlugin {
  name: string;
  class_uid: string;
  category: string;
  is_stereo: boolean;
}

export interface VstScannedEntry {
  name: string;
  path: string;
  binary_path: string;
  class_uid?: string;
  is_bundle: boolean;
  is_izotope: boolean;
  is_waveshell?: boolean;
  format: string;
  category: string;
  vendor: string;
  sub_plugins?: WaveShellSubPlugin[];
}

export interface VstGuiOpenResult {
  success: boolean;
  window_label?: string;
  width?: number;
  height?: number;
  plugin_name?: string;
  message: string;
}

export interface VstPresetResult {
  success: boolean;
  preset_path: string;
  preset_name: string;
  bytes_loaded: number;
  message: string;
}

export interface VstParamChangedPayload {
  instance_id: string;
  track_id: number;
  slot_idx: number;
  param_id: number;
  value: number;
}

export class TauriNativeBridge {
  /**
   * Проверка: запущено ли приложение в нативном окне Tauri v2 (Windows WebView2 / macOS WKWebView)
   */
  public static isTauriEnvironment(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  /**
   * Сканирование всех VST2 / VST3 / CLAP / Waves плагинов в системе
   */
  public static async scanVstPlugins(paths?: string[]): Promise<VstScannedEntry[]> {
    if (!this.isTauriEnvironment()) {
      return [];
    }

    try {
      return await invoke<VstScannedEntry[]>('scan_vst_plugins', { paths });
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка scan_vst_plugins:', e);
      return [];
    }
  }

  /**
   * Получение стандартных системных путей VST3 плагинов через Tauri Path API (включая iZotope и Waves)
   */
  public static async getStandardVstDirectories(): Promise<string[]> {
    const dirs: string[] = [
      'C:\\Program Files\\Common Files\\VST3\\iZotope',
      'C:\\Program Files\\Steinberg\\VstPlugins\\iZotope',
      'C:\\Program Files\\VstPlugins\\iZotope',
      'C:\\Program Files\\Common Files\\iZotope',
      'C:\\Program Files\\Common Files\\VST3',
      'C:\\Program Files\\VstPlugins',
      'C:\\Program Files\\Steinberg\\VstPlugins',
      'C:\\Program Files\\Common Files\\VST2',
      '/Library/Audio/Plug-Ins/VST3',
      '/Library/Audio/Plug-Ins/VST',
      '~/.vst3'
    ];

    if (!this.isTauriEnvironment()) {
      return dirs;
    }

    try {
      const nativeDirs = await invoke<string[]>('get_standard_vst_directories_native');
      if (Array.isArray(nativeDirs) && nativeDirs.length > 0) {
        return Array.from(new Set([...dirs, ...nativeDirs]));
      }
    } catch {
      // Fallback
    }

    try {
      if (tauriPath && typeof tauriPath.audioDir === 'function') {
        const audioDir = await tauriPath.audioDir();
        if (audioDir) {
          dirs.push(`${audioDir}/Plug-Ins/VST3`);
        }
      }
    } catch {
      // Игнорируем в веб-режиме
    }

    return Array.from(new Set(dirs));
  }

  /**
   * Нативное глубокое сканирование конкретной папки на наличие VST3 бандлов (iZotope, FabFilter, Waves)
   */
  public static async scanVstDirectoryNative(dirPath: string): Promise<VstScannedEntry[]> {
    if (!this.isTauriEnvironment()) {
      return [];
    }

    try {
      return await invoke<VstScannedEntry[]>('scan_vst_directory_native', { dirPath });
    } catch (e) {
      console.warn(`[TauriNativeBridge] Ошибка scan_vst_directory_native для ${dirPath}:`, e);
      return [];
    }
  }

  /**
   * Прямое сохранение бинарных данных (WAV, MP4, JSON) в файловую систему без лимитов памяти через потоковые чанки
   */
  public static async saveFileDirect(
    filePath: string,
    data: Blob | ArrayBuffer | Uint8Array,
    onProgress?: (percent: number) => void
  ): Promise<string> {
    if (!this.isTauriEnvironment()) {
      throw new Error('Tauri API недоступно в веб-браузере.');
    }

    const totalBytes = data instanceof Blob ? data.size : data.byteLength;
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4 МБ на чанк

    // Потоковая запись чанками через Rust IPC (гарантирует отсутствие Out Of Memory и строковых переполнений V8)
    if (data instanceof Blob) {
      const numChunks = Math.ceil(totalBytes / CHUNK_SIZE);
      for (let i = 0; i < numChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, totalBytes);
        const chunkBlob = data.slice(start, end);
        const chunkBuf = await chunkBlob.arrayBuffer();
        const chunkU8 = new Uint8Array(chunkBuf);

        await invoke<number>('write_file_chunk', {
          filePath,
          bytes: chunkU8,
          isFirstChunk: i === 0
        });

        if (onProgress) {
          onProgress(Math.round(((i + 1) / numChunks) * 100));
        }
      }
      return filePath;
    }

    const fullU8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const numChunks = Math.ceil(fullU8.length / CHUNK_SIZE);

    for (let i = 0; i < numChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fullU8.length);
      const chunkU8 = fullU8.subarray(start, end);

      await invoke<number>('write_file_chunk', {
        filePath,
        bytes: chunkU8,
        isFirstChunk: i === 0
      });

      if (onProgress) {
        onProgress(Math.round(((i + 1) / numChunks) * 100));
      }
    }

    return filePath;
  }

  /**
   * Чтение файла напрямую с диска в бинарный буфер
   */
  public static async readFileBinary(filePath: string): Promise<Uint8Array> {
    if (!this.isTauriEnvironment()) {
      throw new Error('Tauri API недоступно в веб-браузере.');
    }

    // 1. Попытка через @tauri-apps/plugin-fs readFile
    try {
      if (tauriFs && typeof (tauriFs as any).readFile === 'function') {
        const data = await (tauriFs as any).readFile(filePath);
        return data instanceof Uint8Array ? data : new Uint8Array(data);
      }
    } catch (fsErr) {
      console.warn('[TauriNativeBridge] tauriFs.readFile fallback to invoke:', fsErr);
    }

    // 2. Fallback через invoke
    const bytes = await invoke<number[] | Uint8Array>('read_file_binary', { filePath });
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  /**
   * Удаление временного файла на диске
   */
  public static async removeFile(filePath: string): Promise<boolean> {
    if (!this.isTauriEnvironment()) return false;
    try {
      if (tauriFs && typeof (tauriFs as any).remove === 'function') {
        await (tauriFs as any).remove(filePath);
        return true;
      }
    } catch {
      // Игнорируем ошибку
    }
    return false;
  }

  /**
   * Полное нативное индексирование проекта на диске через C++ модуль ProjectIndexer
   */
  public static async indexProjectDirectoryNative(rootPath: string, recursive: boolean = true): Promise<any> {
    if (!this.isTauriEnvironment()) {
      return null;
    }

    try {
      return await invoke<any>('index_project_directory_native', { rootPath, recursive });
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка index_project_directory_native:', e);
      return null;
    }
  }

  /**
   * Сканирование содержимого папки на диске через Tauri FS API или invoke команду
   */
  public static async listProjectFiles(dirPath: string): Promise<NativeFileEntry[]> {
    if (!this.isTauriEnvironment()) {
      throw new Error('Tauri API недоступно в веб-браузере.');
    }

    try {
      if (tauriFs && typeof tauriFs.readDir === 'function') {
        const entries = await tauriFs.readDir(dirPath);
        return entries.map((e) => ({
          name: e.name || '',
          path: `${dirPath}/${e.name}`,
          is_dir: e.isDirectory,
          size: 0
        }));
      }
    } catch {
      // Fallback
    }

    return await invoke<NativeFileEntry[]>('list_project_files_native', { dirPath });
  }

  /**
   * Получение текущей рабочей директории процесса
   */
  public static async getCurrentWorkingDir(): Promise<string> {
    if (!this.isTauriEnvironment()) {
      return '';
    }

    return await invoke<string>('get_current_working_dir');
  }

  /**
   * Открытие плавающего нативного окна с оригинальным GUI VST плагина (IPlugView / HWND / NSWindow)
   */
  public static async openVstEditor(
    instanceId: string,
    trackId: number,
    slotIdx: number,
    pluginName?: string,
    pluginPath?: string,
    classUid?: string
  ): Promise<boolean> {
    const res = await this.openPluginGui(trackId, slotIdx, instanceId, pluginName, pluginPath, classUid);
    return res.success;
  }

  /**
   * Открытие нативного плавающего окна с оригинальным интерфейсом VST/Waves плагина (IPlugView / effEditOpen)
   */
  public static async openPluginGui(
    trackId: number,
    slotIdx: number,
    instanceId: string,
    pluginName?: string,
    pluginPath?: string,
    classUid?: string
  ): Promise<VstGuiOpenResult> {
    if (!this.isTauriEnvironment()) {
      return {
        success: false,
        message: 'Родной GUI доступен только в десктопной версии VOMIXStudio (Tauri)'
      };
    }

    try {
      const result = await invoke<VstGuiOpenResult>('open_vst_gui', {
        instanceId,
        trackId: Number(trackId),
        slotIdx: Number(slotIdx),
        pluginName: pluginName || undefined,
        pluginPath: pluginPath || undefined,
        classUid: classUid || undefined
      });
      return result;
    } catch (e: any) {
      console.warn('[TauriNativeBridge] Ошибка открытия нативного окна VST GUI:', e);
      return {
        success: false,
        message: typeof e === 'string' ? e : e?.message || 'Ошибка открытия нативного окна VST'
      };
    }
  }

  /**
   * Закрытие нативного окна плагина (вызывает IPlugView::removed)
   */
  public static async closeVstEditor(instanceId: string): Promise<boolean> {
    return await this.closePluginGui(instanceId);
  }

  /**
   * Закрытие нативного окна плагина
   */
  public static async closePluginGui(instanceId: string): Promise<boolean> {
    if (!this.isTauriEnvironment()) {
      return false;
    }

    try {
      await invoke('close_vst_gui', { instanceId });
      return true;
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка закрытия нативного окна VST GUI:', e);
      return false;
    }
  }

  /**
   * Загрузка бинарного пресета (.vstpreset / .fxp) в плагин через Tauri VST Host
   */
  public static async loadVstPreset(instanceId: string, presetPath: string): Promise<VstPresetResult> {
    if (!this.isTauriEnvironment()) {
      return {
        success: false,
        preset_path: presetPath,
        preset_name: '',
        bytes_loaded: 0,
        message: 'Загрузка системных пресетов VST3 доступна в десктопной версии Tauri'
      };
    }

    try {
      return await invoke<VstPresetResult>('load_vst_preset', {
        instanceId,
        presetPath
      });
    } catch (e: any) {
      console.warn('[TauriNativeBridge] Ошибка loadVstPreset:', e);
      return {
        success: false,
        preset_path: presetPath,
        preset_name: '',
        bytes_loaded: 0,
        message: typeof e === 'string' ? e : e?.message || 'Ошибка загрузки пресета'
      };
    }
  }

  /**
   * Вызов системного диалога @tauri-apps/plugin-dialog для выбора пресета (.vstpreset / .fxp) и применение к плагину
   */
  public static async pickAndLoadPresetNative(instanceId: string): Promise<VstPresetResult | null> {
    if (this.isTauriEnvironment()) {
      try {
        const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
        const selected = await openDialog({
          multiple: false,
          directory: false,
          title: 'Выберите файл пресета (.vstpreset / .fxp)',
          filters: [
            {
              name: 'VST Presets (*.vstpreset, *.fxp)',
              extensions: ['vstpreset', 'fxp', 'vst3', 'bin', 'json']
            }
          ]
        });

        if (typeof selected === 'string') {
          return await this.loadVstPreset(instanceId, selected);
        }
      } catch (e) {
        console.warn('[TauriNativeBridge] Ошибка диалога pickAndLoadPresetNative:', e);
      }
    }
    return null;
  }

  /**
   * Подписка на изменение параметров из нативного GUI плагина (через IComponentHandler::performEdit)
   */
  public static async onParamChanged(
    callback: (payload: VstParamChangedPayload) => void
  ): Promise<UnlistenFn | null> {
    if (!this.isTauriEnvironment()) return null;
    try {
      return await listen<VstParamChangedPayload>('vst-param-changed', (event) => {
        callback(event.payload);
      });
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка listen(vst-param-changed):', e);
      return null;
    }
  }

  /**
   * Подписка на событие применения пресета к плагину
   */
  public static async onPresetApplied(
    callback: (payload: { instanceId: string; presetName: string; presetPath: string }) => void
  ): Promise<UnlistenFn | null> {
    if (!this.isTauriEnvironment()) return null;
    try {
      return await listen<{ instanceId: string; presetName: string; presetPath: string }>(
        'vst-preset-applied',
        (event) => {
          callback(event.payload);
        }
      );
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка listen(vst-preset-applied):', e);
      return null;
    }
  }

  /**
   * Подписка на событие закрытия окна нативного GUI плагина
   */
  public static async onGuiClosed(
    callback: (payload: { instanceId: string }) => void
  ): Promise<UnlistenFn | null> {
    if (!this.isTauriEnvironment()) return null;
    try {
      return await listen<{ instanceId: string }>('vst-gui-closed', (event) => {
        callback(event.payload);
      });
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка listen(vst-gui-closed):', e);
      return null;
    }
  }

  /**
   * Проверка поддержки нативного GUI для заданного плагина
   */
  public static async isPluginGuiSupported(instanceId: string): Promise<boolean> {
    if (!this.isTauriEnvironment()) {
      return false;
    }

    try {
      return await invoke<boolean>('is_plugin_gui_supported', { instanceId });
    } catch {
      return false;
    }
  }

  /**
   * Нативная загрузка VST/VST3/CLAP бинарного модуля (C++ VST3 SDK / Desktop DLL Loader)
   */
  public static async loadPluginNative(
    trackId: number,
    slotIdx: number,
    pluginPath: string,
    sampleRate: number = 48000,
    blockSize: number = 512,
    classUid?: string
  ): Promise<{ success: boolean; instanceId: string; latencySamples: number; numParams: number }> {
    if (!this.isTauriEnvironment()) {
      return { success: false, instanceId: '', latencySamples: 0, numParams: 0 };
    }

    try {
      return await invoke<{ success: boolean; instanceId: string; latencySamples: number; numParams: number }>(
        'load_vst_plugin_native',
        {
          trackId: Number(trackId),
          slotIdx: Number(slotIdx),
          pluginPath,
          sampleRate: Number(sampleRate),
          blockSize: Number(blockSize),
          classUid: classUid || ''
        }
      );
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка loadPluginNative:', e);
      return { success: false, instanceId: '', latencySamples: 0, numParams: 0 };
    }
  }

  /**
   * Отправка нормализованного значения параметра (0.0 .. 1.0) по paramId в активный нативный C++ инстанс
   */
  public static async setPluginParameterNative(
    instanceId: string,
    paramId: number,
    value: number
  ): Promise<boolean> {
    if (!this.isTauriEnvironment()) {
      return false;
    }

    try {
      await invoke('set_vst_parameter_native', {
        instanceId,
        paramId: Number(paramId),
        value: Number(value)
      });
      return true;
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка setPluginParameterNative:', e);
      return false;
    }
  }

  /**
   * Выгрузка бинарного состояния плагина в Base64 (IComponent::getState() -> Base64)
   */
  public static async savePluginChunkNative(instanceId: string): Promise<string> {
    if (!this.isTauriEnvironment()) {
      return '';
    }

    try {
      return await invoke<string>('save_vst_chunk_native', { instanceId });
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка savePluginChunkNative:', e);
      return '';
    }
  }

  /**
   * Восстановление бинарного состояния плагина из Base64 (Base64 -> IComponent::setState())
   */
  public static async restorePluginChunkNative(instanceId: string, chunkBase64: string): Promise<boolean> {
    if (!this.isTauriEnvironment()) {
      return false;
    }

    try {
      await invoke('restore_vst_chunk_native', {
        instanceId,
        chunk: chunkBase64
      });
      return true;
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка restorePluginChunkNative:', e);
      return false;
    }
  }

  /**
   * Преобразование локального пути файла в безопасный потоковый URL для <video> и <audio> тегов в Tauri
   */
  public static convertFileSrc(filePath: string): string {
    if (!this.isTauriEnvironment() || !filePath) return filePath;
    try {
      return convertFileSrc(filePath);
    } catch {
      return filePath;
    }
  }

  /**
   * Нативный системный диалог выбора медиафайлов (видео, аудио, субтитры) с сохранением реального пути на диске
   */
  public static async pickMediaFilesNative(options?: {
    multiple?: boolean;
    title?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<{ file: File; path: string; name: string }[]> {
    if (!this.isTauriEnvironment()) return [];
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const selected = await openDialog({
        multiple: options?.multiple ?? true,
        directory: false,
        title: options?.title || 'Выберите медиафайлы проекта (видео / аудио / субтитры)',
        filters: options?.filters || [
          {
            name: 'Медиафайлы (*.mp4, *.mkv, *.wav, *.mp3, *.srt, *.ass)',
            extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a', 'srt', 'ass', 'vtt']
          },
          {
            name: 'Видеофайлы (*.mp4, *.mkv, *.mov, *.webm, *.avi)',
            extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts']
          },
          {
            name: 'Аудиофайлы (*.wav, *.mp3, *.flac, *.ogg, *.aac)',
            extensions: ['wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a', 'aiff']
          }
        ]
      });

      if (!selected) return [];
      const paths = Array.isArray(selected) ? selected : [selected];
      const results: { file: File; path: string; name: string }[] = [];

      for (const p of paths) {
        if (typeof p !== 'string') continue;
        const dirSeparator = p.includes('\\') ? '\\' : '/';
        const name = p.split(dirSeparator).pop() || 'file';
        const ext = name.split('.').pop()?.toLowerCase() || '';
        const mime = ext === 'mp4' ? 'video/mp4' : ext === 'mkv' ? 'video/x-matroska' : ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'application/octet-stream';
        
        // Для небольших текстовых файлов (субтитры SRT/ASS) можно безопасно прочесть содержимое
        const isSmallText = ext === 'srt' || ext === 'ass' || ext === 'vtt' || ext === 'json' || ext === 'txt';
        if (isSmallText) {
          try {
            const bytes = await this.readFileBinary(p);
            const file = new File([bytes as unknown as BlobPart], name, { type: mime });
            (file as any).path = p;
            results.push({ file, path: p, name });
            continue;
          } catch {
            // fallback к легковесному объекту
          }
        }

        // Для видео и тяжелых файлов создаем легковесный File дескриптор с реальным системным путем
        const file = new File([], name, { type: mime });
        (file as any).path = p;
        results.push({ file, path: p, name });
      }

      return results;
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка диалога pickMediaFilesNative:', e);
      return [];
    }
  }

  /**
   * Нативный системный диалог выбора файла плагина (.vst3 / .dll / .clap) через Tauri dialog plugin
   */
  public static async pickPluginFileNative(): Promise<string | null> {
    if (this.isTauriEnvironment()) {
      try {
        const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
        const selected = await openDialog({
          multiple: false,
          directory: false,
          title: 'Выберите VST3 / VST2 / CLAP плагин на диске',
          filters: [
            {
              name: 'Audio Plugins (*.vst3, *.dll, *.clap)',
              extensions: ['vst3', 'dll', 'clap', 'dylib', 'so', 'wasm']
            }
          ]
        });
        if (typeof selected === 'string') {
          return selected;
        }
      } catch (e) {
        console.warn('[TauriNativeBridge] Ошибка диалога pickPluginFileNative:', e);
      }
    }
    return null;
  }

  /**
   * Нативный системный диалог выбора папки для сканирования плагинов
   */
  public static async pickDirectoryNative(): Promise<string | null> {
    if (this.isTauriEnvironment()) {
      try {
        const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
        const selected = await openDialog({
          multiple: false,
          directory: true,
          title: 'Выберите директорию с VST/CLAP плагинами для сканирования'
        });
        if (typeof selected === 'string') {
          return selected;
        }
      } catch (e) {
        console.warn('[TauriNativeBridge] Ошибка диалога pickDirectoryNative:', e);
      }
    }
    return null;
  }

  /**
   * Проверка: доступен ли нативный 64-битный FFmpeg в системе (PATH)
   */
  public static async isFFmpegAvailable(): Promise<boolean> {
    if (!this.isTauriEnvironment()) return false;
    try {
      return await invoke<boolean>('is_ffmpeg_available');
    } catch {
      return false;
    }
  }

  /**
   * Нативный видео-муксинг через системный FFmpeg без ограничений памяти WebAssembly
   */
  public static async runNativeFFmpegMux(
    videoPath: string,
    audioWavPath: string,
    outputPath: string,
    isLossless: boolean = true
  ): Promise<string> {
    if (!this.isTauriEnvironment()) {
      throw new Error('Нативный FFmpeg доступен только в настольном приложении Tauri.');
    }
    return await invoke<string>('run_native_ffmpeg_mux', {
      videoPath,
      audioWavPath,
      outputPath,
      isLossless
    });
  }

  /**
   * Быстрый аппаратный ремуксинг контейнера (-c:v copy) в MP4 с faststart для мгновенного старта и плавного скраббинга
   */
  public static async runNativeFFmpegRemux(
    inputPath: string,
    outputPath: string
  ): Promise<string> {
    if (!this.isTauriEnvironment()) {
      throw new Error('Нативный FFmpeg доступен только в настольном приложении Tauri.');
    }
    return await invoke<string>('run_native_ffmpeg_remux', {
      inputPath,
      outputPath
    });
  }
}
