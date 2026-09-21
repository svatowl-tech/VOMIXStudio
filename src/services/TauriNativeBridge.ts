/**
 * ============================================================================
 * TAURI NATIVE BRIDGE (Windows Native Integration)
 * ============================================================================
 * Двусторонний мост между React/WASM фронтендом и нативным C++/Rust ядром Tauri v2.
 * Автоматически определяет среду запуска (Windows Desktop vs Browser Web)
 * и направляет операции ввода-вывода (I/O) напрямую в файловую систему Windows.
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

export class TauriNativeBridge {
  /**
   * Проверка: запущено ли приложение в нативном окне Tauri v2 (Windows WebView2)
   */
  public static isTauriEnvironment(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  /**
   * Получение стандартных системных путей VST3 плагинов через Tauri Path API
   */
  public static async getStandardVstDirectories(): Promise<string[]> {
    const dirs: string[] = [
      'C:\\Program Files\\Common Files\\VST3',
      'C:\\Program Files\\VstPlugins',
      '/Library/Audio/Plug-Ins/VST3',
      '~/.vst3'
    ];

    if (!this.isTauriEnvironment()) {
      return dirs;
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
   * Прямое сохранение бинарных данных (WAV, MP4, JSON) в файловую систему Windows
   */
  public static async saveFileDirect(filePath: string, data: ArrayBuffer | Uint8Array): Promise<string> {
    if (!this.isTauriEnvironment()) {
      throw new Error('Tauri API недоступно в веб-браузере.');
    }

    const bytes = data instanceof Uint8Array ? Array.from(data) : Array.from(new Uint8Array(data));
    return await invoke<string>('save_file_direct', { filePath, bytes });
  }

  /**
   * Чтение файла напрямую с диска Windows в бинарный буфер
   */
  public static async readFileBinary(filePath: string): Promise<Uint8Array> {
    if (!this.isTauriEnvironment()) {
      throw new Error('Tauri API недоступно в веб-браузере.');
    }

    const bytes = await invoke<number[]>('read_file_binary', { filePath });
    return new Uint8Array(bytes);
  }

  /**
   * Сканирование содержимого папки на диске через Tauri FS API или invoke команду
   */
  public static async listProjectFiles(dirPath: string): Promise<NativeFileEntry[]> {
    if (!this.isTauriEnvironment()) {
      throw new Error('Tauri API недоступно в веб-браузере.');
    }

    // 1. Пробуем через Tauri Plugin FS (readDir)
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
      // Fallback к нативной команде Tauri Core invoke
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
}
