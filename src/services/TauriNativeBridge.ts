/**
 * ============================================================================
 * TAURI NATIVE BRIDGE (Windows & macOS Native Integration)
 * ============================================================================
 * Двусторонний мост между React/WASM фронтендом и нативным C++/Rust ядром Tauri v2.
 * Автоматически определяет среду запуска (Desktop vs Browser Web)
 * и направляет операции сканирования и отображения GUI VST плагинов.
 * ============================================================================
 */

import { invoke } from '@tauri-apps/api/core';
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
   * Прямое сохранение бинарных данных (WAV, MP4, JSON) в файловую систему
   */
  public static async saveFileDirect(filePath: string, data: ArrayBuffer | Uint8Array): Promise<string> {
    if (!this.isTauriEnvironment()) {
      throw new Error('Tauri API недоступно в веб-браузере.');
    }

    const bytes = data instanceof Uint8Array ? Array.from(data) : Array.from(new Uint8Array(data));
    return await invoke<string>('save_file_direct', { filePath, bytes });
  }

  /**
   * Чтение файла напрямую с диска в бинарный буфер
   */
  public static async readFileBinary(filePath: string): Promise<Uint8Array> {
    if (!this.isTauriEnvironment()) {
      throw new Error('Tauri API недоступно в веб-браузере.');
    }

    const bytes = await invoke<number[]>('read_file_binary', { filePath });
    return new Uint8Array(bytes);
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
  public static async openVstEditor(instanceId: string, trackId: number, slotIdx: number): Promise<boolean> {
    if (!this.isTauriEnvironment()) {
      return false;
    }

    try {
      return await invoke<boolean>('open_vst_editor', {
        instanceId,
        trackId: Number(trackId),
        slotIdx: Number(slotIdx)
      });
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка открытия нативного окна open_vst_editor:', e);
      return false;
    }
  }

  /**
   * Открытие нативного плавающего окна с оригинальным интерфейсом VST/Waves плагина (IPlugView / effEditOpen)
   */
  public static async openPluginGui(trackId: number, slotIdx: number, instanceId: string): Promise<boolean> {
    if (!this.isTauriEnvironment()) {
      return false;
    }

    try {
      await invoke('open_plugin_gui', {
        trackId: Number(trackId),
        slotIdx: Number(slotIdx),
        instanceId
      });
      return true;
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка открытия нативного окна VST GUI:', e);
      return false;
    }
  }

  /**
   * Закрытие нативного окна плагина
   */
  public static async closeVstEditor(instanceId: string): Promise<boolean> {
    if (!this.isTauriEnvironment()) {
      return false;
    }

    try {
      return await invoke<boolean>('close_vst_editor', { instanceId });
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка закрытия нативного окна close_vst_editor:', e);
      return false;
    }
  }

  /**
   * Закрытие нативного окна плагина
   */
  public static async closePluginGui(instanceId: string): Promise<boolean> {
    if (!this.isTauriEnvironment()) {
      return false;
    }

    try {
      await invoke('close_plugin_gui', { instanceId });
      return true;
    } catch (e) {
      console.warn('[TauriNativeBridge] Ошибка закрытия нативного окна VST GUI:', e);
      return false;
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
}
