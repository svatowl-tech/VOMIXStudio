/**
 * ============================================================================
 * PROJECT MANAGER (File System Access API & Native C++ WASM Audio Integration)
 * ============================================================================
 * Автономный сервис управления локальными проектами DAW и связующий мост между
 * локальной файловой системой пользователя (File System Access API) и нативным
 * C++ WebAssembly аудиоядром (daw_core.cpp via NativeDAWBridge).
 *
 * Архитектурный принцип:
 * 1. Браузер выступает только как UI-оболочка и держатель дескрипторов
 *    FileSystemDirectoryHandle / FileSystemFileHandle.
 * 2. Тяжелая аудиообработка, кодирование RIFF WAV и расчеты выполняются в C++.
 * 3. Прямая запись результатов рендеринга (аудиомиксы, стемы, MP4 видео)
 *    в подпапку "project/" или корень проекта без диалоговых окон "Сохранить как...".
 * 4. Полная защита от ошибок: автоматический Fallback для браузеров без FSA API
 *    (iOS Safari, Firefox, iFrame без COOP/COEP) и парсер с восстановлением
 *    структуры при повреждении project.json.
 * ============================================================================
 */

import {
  globalNativeDAWBridge,
  NativeDAWBridge
} from './NativeDAWBridge';
import { WavBitDepth } from '../utils/wavEncoder';

/**
 * Метаданные дорожки в файле конфигурации project.json
 */
export interface TrackMetadata {
  id: number;
  name: string;
  fileName: string;
  volumeDb: number;
  pan: number;
  solo: boolean;
  mute: boolean;
  offsetSec: number;
  color?: string;
  isMutedOriginalVideo?: boolean;
}

/**
 * Метаданные исходного видеофайла
 */
export interface VideoMetadata {
  name: string;
  relativePath: string;
  durationSec: number;
  fps: number;
  fileSize?: number;
  width?: number;
  height?: number;
  timecodeStartSec?: number;
}

/**
 * Метаданные мастер-секции
 */
export interface MasterMetadata {
  volumeDb: number;
  pan?: number;
  limiterEnabled: boolean;
  limiterCeilingDb?: number;
}

/**
 * Субтитры / Таймкоды реплик
 */
export interface SubtitleCue {
  index: number;
  startSec: number;
  endSec: number;
  speaker?: string;
  text: string;
}

/**
 * Полный формат состояния проекта project.json
 */
export interface ProjectState {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sampleRate: number;
  videoFile: VideoMetadata | null;
  tracks: TrackMetadata[];
  master: MasterMetadata;
  subtitles?: SubtitleCue[];
}

/**
 * Информация о найденном файле в директории
 */
export interface DiscoveredFile {
  name: string;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  sizeBytes: number;
  lastModified: number;
  fileHandle?: FileSystemFileHandle;
  fileObj?: File;
  relativePath: string;
}

/**
 * Содержимое открытой рабочей директории
 */
export interface ProjectDirectoryContent {
  directoryName: string;
  hasWritePermission: boolean;
  discoveredFiles: DiscoveredFile[];
  savedState: ProjectState | null;
}

export class ProjectManager {
  private dirHandle: FileSystemDirectoryHandle | null = null;
  private projectSubDirHandle: FileSystemDirectoryHandle | null = null;
  private memoryFiles: Map<string, File> = new Map();
  private fileHandlesMap: Map<string, FileSystemFileHandle> = new Map();
  private activeDirectoryName: string = '';
  private isFallbackMode: boolean = false;

  /**
   * Проверка поддержки File System Access API в браузере (Chromium / Edge / Opera)
   */
  public isFileSystemAccessSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof (window as any).showDirectoryPicker === 'function'
    );
  }

  /**
   * Получение активного дескриптора корневой папки
   */
  public getDirectoryHandle(): FileSystemDirectoryHandle | null {
    return this.dirHandle;
  }

  /**
   * Получение дескриптора подпапки "project/"
   */
  public getProjectSubDirHandle(): FileSystemDirectoryHandle | null {
    return this.projectSubDirHandle;
  }

  /**
   * Проверка и запрос прав доступа 'readwrite' к локальной папке
   */
  public async verifyPermission(
    fileHandle: FileSystemHandle | null,
    readWrite: boolean = true
  ): Promise<boolean> {
    if (!fileHandle) return false;

    const options: any = {};
    if (readWrite) {
      options.mode = 'readwrite';
    }

    try {
      if (typeof (fileHandle as any).queryPermission === 'function') {
        const queryRes = await (fileHandle as any).queryPermission(options);
        if (queryRes === 'granted') {
          return true;
        }
      }

      if (typeof (fileHandle as any).requestPermission === 'function') {
        const requestRes = await (fileHandle as any).requestPermission(options);
        if (requestRes === 'granted') {
          return true;
        }
      }
    } catch (err) {
      console.warn('[ProjectManager] Запрос прав доступа отклонен или ограничен iFrame:', err);
    }
    return false;
  }

  /**
   * Автоматическое определение типа файла по его расширению
   */
  public getFileType(fileName: string): 'video' | 'audio' | 'subtitle' | 'other' {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    if (['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ogv'].includes(ext)) {
      return 'video';
    }
    if (['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a', 'aiff', 'wma'].includes(ext)) {
      return 'audio';
    }
    if (['srt', 'vtt', 'json', 'ass', 'sub'].includes(ext)) {
      return 'subtitle';
    }
    return 'other';
  }

  /**
   * Выбор рабочей директории через window.showDirectoryPicker()
   * - Запрашивает права 'readwrite'
   * - Автоматически создает/открывает подпапку "project/"
   * - Сканирует видео и аудиофайлы
   * - Загружает "project/project.json" при наличии
   */
  public async openProjectFolder(): Promise<ProjectDirectoryContent> {
    this.memoryFiles.clear();
    this.fileHandlesMap.clear();

    if (!this.isFileSystemAccessSupported()) {
      throw new Error(
        'File System Access API не поддерживается в данном браузере (iOS Safari / Firefox). Запущен fallback-режим.'
      );
    }

    try {
      // 1. Диалог выбора локальной папки пользователя
      this.dirHandle = await (window as any).showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents'
      });

      if (!this.dirHandle) {
        throw new Error('Рабочая директория не была выбрана.');
      }

      this.activeDirectoryName = this.dirHandle.name;
      this.isFallbackMode = false;

      // 2. Проверка прав на запись
      const hasWrite = await this.verifyPermission(this.dirHandle, true);

      // 3. Автоматическое создание/подключение служебной подпапки "project/"
      try {
        this.projectSubDirHandle = await this.dirHandle.getDirectoryHandle('project', {
          create: true
        });
      } catch (subErr) {
        console.warn('[ProjectManager] Не удалось сразу создать подпапку "project/":', subErr);
      }

      // 4. Сканирование содержимого директории
      const discoveredFiles: DiscoveredFile[] = [];

      for await (const entry of (this.dirHandle as any).values()) {
        if (entry.kind === 'file') {
          const fileHandle = entry as FileSystemFileHandle;
          try {
            const file = await fileHandle.getFile();
            const fileType = this.getFileType(file.name);

            discoveredFiles.push({
              name: file.name,
              type: fileType,
              sizeBytes: file.size,
              lastModified: file.lastModified,
              fileHandle,
              fileObj: file,
              relativePath: file.name
            });

            this.memoryFiles.set(file.name, file);
            this.fileHandlesMap.set(file.name, fileHandle);
          } catch (fileReadErr) {
            console.warn(`[ProjectManager] Не удалось прочесть файл [${entry.name}]:`, fileReadErr);
          }
        }
      }

      // 5. Попытка десериализации проектного файла project/project.json
      const savedState = await this.loadProjectState();

      return {
        directoryName: this.activeDirectoryName,
        hasWritePermission: hasWrite,
        discoveredFiles,
        savedState
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Выбор рабочей папки был отменен пользователем.');
      }
      throw err;
    }
  }

  /**
   * Fallback выбор папки через стандартный input[webkitdirectory]
   * Используется для браузеров без поддержки FSA API (Firefox, Safari, iFrame constraints).
   */
  public async loadFromFileInput(fileList: FileList): Promise<ProjectDirectoryContent> {
    this.memoryFiles.clear();
    this.fileHandlesMap.clear();
    this.isFallbackMode = true;
    this.dirHandle = null;
    this.projectSubDirHandle = null;

    const discoveredFiles: DiscoveredFile[] = [];
    let rootDirName = 'Локальный проект';

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const relativePath = file.webkitRelativePath || file.name;
      const parts = relativePath.split('/');
      if (parts.length > 1) {
        rootDirName = parts[0];
      }

      const fileType = this.getFileType(file.name);
      discoveredFiles.push({
        name: file.name,
        type: fileType,
        sizeBytes: file.size,
        lastModified: file.lastModified,
        fileObj: file,
        relativePath
      });

      this.memoryFiles.set(file.name, file);
    }

    this.activeDirectoryName = rootDirName;

    // Чтение project.json из списка загруженных файлов
    let savedState: ProjectState | null = null;
    const projectJsonFile = Array.from(this.memoryFiles.values()).find(
      (f) => f.name === 'project.json' || f.name.endsWith('/project.json')
    );

    if (projectJsonFile) {
      try {
        const text = await projectJsonFile.text();
        savedState = this.validateAndParseProjectJson(text);
      } catch (jsonErr) {
        console.error('[ProjectManager] Ошибка чтения project.json из input:', jsonErr);
      }
    }

    return {
      directoryName: this.activeDirectoryName,
      hasWritePermission: false,
      discoveredFiles,
      savedState
    };
  }

  /**
   * Валидация, санитаризация и десериализация содержимого project.json
   */
  public validateAndParseProjectJson(jsonString: string): ProjectState {
    try {
      const data = JSON.parse(jsonString);

      if (!data || typeof data !== 'object') {
        throw new Error('Корневой JSON не является объектом.');
      }

      const tracks: TrackMetadata[] = Array.isArray(data.tracks)
        ? data.tracks.map((t: any, index: number) => ({
            id: typeof t.id === 'number' ? t.id : index + 1,
            name: String(t.name || `Дорожка ${index + 1}`),
            fileName: String(t.fileName || ''),
            volumeDb: typeof t.volumeDb === 'number' ? t.volumeDb : 0.0,
            pan: typeof t.pan === 'number' ? t.pan : 0.0,
            solo: Boolean(t.solo),
            mute: Boolean(t.mute),
            offsetSec: typeof t.offsetSec === 'number' ? t.offsetSec : 0.0,
            color: t.color ? String(t.color) : undefined,
            isMutedOriginalVideo: Boolean(t.isMutedOriginalVideo)
          }))
        : [];

      const master: MasterMetadata = {
        volumeDb: typeof data.master?.volumeDb === 'number' ? data.master.volumeDb : 0.0,
        pan: typeof data.master?.pan === 'number' ? data.master.pan : 0.0,
        limiterEnabled: data.master?.limiterEnabled !== undefined ? Boolean(data.master.limiterEnabled) : true,
        limiterCeilingDb: typeof data.master?.limiterCeilingDb === 'number' ? data.master.limiterCeilingDb : -0.1
      };

      const videoFile: VideoMetadata | null = data.videoFile
        ? {
            name: String(data.videoFile.name || ''),
            relativePath: String(data.videoFile.relativePath || data.videoFile.name || ''),
            durationSec: typeof data.videoFile.durationSec === 'number' ? data.videoFile.durationSec : 0,
            fps: typeof data.videoFile.fps === 'number' ? data.videoFile.fps : 30.0,
            fileSize: typeof data.videoFile.fileSize === 'number' ? data.videoFile.fileSize : undefined,
            width: typeof data.videoFile.width === 'number' ? data.videoFile.width : undefined,
            height: typeof data.videoFile.height === 'number' ? data.videoFile.height : undefined,
            timecodeStartSec: typeof data.videoFile.timecodeStartSec === 'number' ? data.videoFile.timecodeStartSec : 0.0
          }
        : null;

      const subtitles: SubtitleCue[] = Array.isArray(data.subtitles)
        ? data.subtitles.map((s: any, idx: number) => ({
            index: typeof s.index === 'number' ? s.index : idx + 1,
            startSec: typeof s.startSec === 'number' ? s.startSec : 0,
            endSec: typeof s.endSec === 'number' ? s.endSec : 0,
            speaker: s.speaker ? String(s.speaker) : undefined,
            text: String(s.text || '')
          }))
        : [];

      return {
        id: String(data.id || `proj_${Date.now()}`),
        name: String(data.name || this.activeDirectoryName || 'Проект дубляжа'),
        createdAt: String(data.createdAt || new Date().toISOString()),
        updatedAt: String(data.updatedAt || new Date().toISOString()),
        sampleRate: typeof data.sampleRate === 'number' ? data.sampleRate : 48000,
        videoFile,
        tracks,
        master,
        subtitles
      };
    } catch (err) {
      console.error('[ProjectManager] Ошибка парсинга project.json, создан дефолтный каркас:', err);
      return {
        id: `proj_recovered_${Date.now()}`,
        name: this.activeDirectoryName || 'Восстановленный проект',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sampleRate: 48000,
        videoFile: null,
        tracks: [],
        master: { volumeDb: 0.0, pan: 0.0, limiterEnabled: true, limiterCeilingDb: -0.1 },
        subtitles: []
      };
    }
  }

  /**
   * Загрузка файла "project/project.json" из локальной папки
   */
  public async loadProjectState(): Promise<ProjectState | null> {
    if (!this.dirHandle) return null;

    try {
      let subDir: FileSystemDirectoryHandle;
      try {
        subDir = await this.dirHandle.getDirectoryHandle('project', { create: false });
        this.projectSubDirHandle = subDir;
      } catch {
        return null; // Папка project/ еще не была создана
      }

      const fileHandle = await subDir.getFileHandle('project.json', { create: false });
      const file = await fileHandle.getFile();
      const text = await file.text();

      return this.validateAndParseProjectJson(text);
    } catch (err) {
      console.warn('[ProjectManager] project/project.json не найден или к нему нет доступа:', err);
      return null;
    }
  }

  /**
   * Сериализация и запись состояния проекта в "project/project.json"
   */
  public async saveProjectState(state: ProjectState): Promise<boolean> {
    state.updatedAt = new Date().toISOString();
    const jsonString = JSON.stringify(state, null, 2);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(jsonString);

    return await this.saveRenderedAsset('project.json', bytes, true);
  }

  /**
   * ПРЯМОЕ СОХРАНЕНИЕ СГЕНЕРИРОВАННЫХ ФАЙЛОВ (WAV, MP4, JSON)
   * Записывает бинарные данные напрямую в "project/" или корень рабочей папки
   * без вызова диалогового окна "Сохранить как...".
   *
   * @param fileName Имя сохраняемого файла (например, 'master_mix.wav', 'project.json', 'final_video.mp4')
   * @param data Данные в формате Uint8Array, ArrayBuffer или Blob
   * @param saveInProjectSubdir Флаг записи в подпапку "project/" (по умолчанию true)
   */
  public async saveRenderedAsset(
    fileName: string,
    data: Uint8Array | ArrayBuffer | Blob,
    saveInProjectSubdir: boolean = true
  ): Promise<boolean> {
    // 1. Нормализация входного буфера в Blob
    let blob: Blob;
    if (data instanceof Blob) {
      blob = data;
    } else if (data instanceof ArrayBuffer) {
      blob = new Blob([data]);
    } else {
      // Uint8Array / TypedArray
      const copyBuf = new ArrayBuffer(data.byteLength);
      new Uint8Array(copyBuf).set(data);
      blob = new Blob([copyBuf]);
    }

    // 2. Прямая запись в локальную файловую систему через File System Access API
    if (this.dirHandle) {
      try {
        let targetDirHandle: FileSystemDirectoryHandle = this.dirHandle;

        if (saveInProjectSubdir) {
          if (!this.projectSubDirHandle) {
            this.projectSubDirHandle = await this.dirHandle.getDirectoryHandle('project', {
              create: true
            });
          }
          targetDirHandle = this.projectSubDirHandle;
        }

        // Запрос/создание дескриптора файла
        const fileHandle = await targetDirHandle.getFileHandle(fileName, { create: true });
        const writableStream = await (fileHandle as any).createWritable();

        // Запись и закрытие потока
        await writableStream.write(blob);
        await writableStream.close();

        console.log(`[ProjectManager] Файл [${fileName}] успешно записан в ${saveInProjectSubdir ? 'project/' : 'корень'} (${blob.size} байт)`);
        return true;
      } catch (fsErr) {
        console.warn(`[ProjectManager] Ошибка прямой записи в ФС для [${fileName}]. Запуск fallback скачивания:`, fsErr);
      }
    }

    // 3. Fallback: Браузерное скачивание файла через динамический Blob URL
    return this.downloadBlobFallback(blob, fileName);
  }

  /**
   * Сохранение сгенерированного C++ WebAssembly WAV файла напрямую в рабочую папку
   * Вызывает нативный C++ NativeWavPacker для упаковки сырых PCM сэмплов в 16/24/32-bit RIFF WAV.
   */
  public async saveNativeWavAsset(
    fileName: string,
    pcmInterleavedFloats: Float32Array,
    sampleRate: number = 48000,
    bitDepth: WavBitDepth = 24,
    saveInProjectSubdir: boolean = true
  ): Promise<boolean> {
    if (!pcmInterleavedFloats || pcmInterleavedFloats.length === 0) {
      throw new Error('PCM данные для сохранения WAV пусты.');
    }

    const bridge = globalNativeDAWBridge;
    const numFrames = Math.floor(pcmInterleavedFloats.length / 2);
    const bytesPerSample = Math.floor(bitDepth / 8);
    const expectedWavBytes = 44 + numFrames * 2 * bytesPerSample;

    // Выделяем память в куче WebAssembly через _malloc
    const inFloatPtr = bridge.writeFloat32Direct(pcmInterleavedFloats);
    const outBytePtr = bridge.allocateBytes(expectedWavBytes);

    try {
      const mod = bridge.getModule();
      const actualSize = mod.packWav
        ? mod.packWav(inFloatPtr, numFrames, bitDepth, outBytePtr, expectedWavBytes, sampleRate)
        : expectedWavBytes;

      const rawWavBytes = bridge.readUint8Direct(outBytePtr, actualSize || expectedWavBytes);

      return await this.saveRenderedAsset(fileName, rawWavBytes, saveInProjectSubdir);
    } finally {
      bridge.freeFloats(inFloatPtr);
      bridge.freeBytes(outBytePtr);
    }
  }

  /**
   * Браузерное скачивание Blob (Fallback)
   */
  private downloadBlobFallback(blob: Blob, fileName: string): boolean {
    try {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      return true;
    } catch (err) {
      console.error(`[ProjectManager] Сбой fallback скачивания файла [${fileName}]:`, err);
      return false;
    }
  }

  /**
   * Алиас метода сохранения Blob для обратной совместимости
   */
  public async saveBlobToProjectDirectory(blob: Blob, fileName: string): Promise<boolean> {
    return await this.saveRenderedAsset(fileName, blob, false);
  }

  /**
   * Получение File объекта по имени файла
   */
  public async getFileByName(fileName: string): Promise<File | null> {
    if (this.memoryFiles.has(fileName)) {
      return this.memoryFiles.get(fileName)!;
    }

    if (this.dirHandle) {
      try {
        const fileHandle = await this.dirHandle.getFileHandle(fileName, { create: false });
        const file = await fileHandle.getFile();
        this.memoryFiles.set(fileName, file);
        return file;
      } catch {
        // Попытка поиска в подпапке project/
        if (this.projectSubDirHandle) {
          try {
            const subFileHandle = await this.projectSubDirHandle.getFileHandle(fileName, { create: false });
            const file = await subFileHandle.getFile();
            this.memoryFiles.set(fileName, file);
            return file;
          } catch {
            return null;
          }
        }
      }
    }

    return null;
  }

  /**
   * Чтение аудиофайла как ArrayBuffer
   */
  public async readFileAsArrayBuffer(fileName: string): Promise<ArrayBuffer | null> {
    const file = await this.getFileByName(fileName);
    if (!file) return null;
    return await file.arrayBuffer();
  }

  /**
   * Возврат текущего имени рабочей директории
   */
  public getActiveDirectoryName(): string {
    return this.activeDirectoryName || 'Рабочая папка';
  }

  /**
   * Флаг fallback-режима
   */
  public isRunningInFallbackMode(): boolean {
    return this.isFallbackMode;
  }
}

export const globalProjectManager = new ProjectManager();
