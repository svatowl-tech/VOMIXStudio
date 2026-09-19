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
  NativeDAWBridge,
  WavBitDepth
} from './NativeDAWBridge';

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
        console.warn('[ProjectManager] Не удалось создать подпапку "project/". Включаем режим сохранения в корень:', subErr);
        this.projectSubDirHandle = null;
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
      let subDir: FileSystemDirectoryHandle | null = null;
      try {
        subDir = await this.dirHandle.getDirectoryHandle('project', { create: false });
        this.projectSubDirHandle = subDir;
      } catch {
        // Папка project/ еще не была создана или недоступна
      }

      let fileHandle: FileSystemFileHandle;
      if (subDir) {
        try {
          fileHandle = await subDir.getFileHandle('project.json', { create: false });
        } catch {
          // Если в подпапке нет, попробуем загрузить из корня проекта
          fileHandle = await this.dirHandle.getFileHandle('project.json', { create: false });
        }
      } else {
        fileHandle = await this.dirHandle.getFileHandle('project.json', { create: false });
      }

      const file = await fileHandle.getFile();
      const text = await file.text();

      return this.validateAndParseProjectJson(text);
    } catch (err) {
      console.info('[ProjectManager] Файл project.json еще не создан или недоступен:', err);
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
            try {
              this.projectSubDirHandle = await this.dirHandle.getDirectoryHandle('project', {
                create: true
              });
              targetDirHandle = this.projectSubDirHandle;
            } catch (subErr) {
              console.warn('[ProjectManager] Не удалось создать подпапку "project/". Файл будет записан напрямую в корень проекта:', subErr);
              targetDirHandle = this.dirHandle;
            }
          } else {
            targetDirHandle = this.projectSubDirHandle;
          }
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
   * Прямое сохранение загруженного File объекта в рабочую папку
   */
  public async saveFileToProjectFolder(
    file: File,
    saveInProjectSubdir: boolean = false
  ): Promise<boolean> {
    this.memoryFiles.set(file.name, file);
    return await this.saveRenderedAsset(file.name, file, saveInProjectSubdir);
  }

  /**
   * Регистрация обнаруженного файла в оперативной памяти проекта
   */
  public addDiscoveredFile(file: File): DiscoveredFile {
    const fileType = this.getFileType(file.name);
    this.memoryFiles.set(file.name, file);

    const discovered: DiscoveredFile = {
      name: file.name,
      type: fileType,
      sizeBytes: file.size,
      lastModified: file.lastModified,
      fileObj: file,
      relativePath: file.webkitRelativePath || file.name
    };

    return discovered;
  }

  /**
   * Регистрация пачки файлов в оперативной памяти проекта
   */
  public addDiscoveredFiles(files: File[]): DiscoveredFile[] {
    return files.map((file) => this.addDiscoveredFile(file));
  }

  /**
   * Парсинг текста субтитров (SRT, VTT, ASS, JSON) в структурированный массив SubtitleCue
   */
  public parseSubtitleText(content: string, format: string = 'srt'): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const fmt = format.toLowerCase().replace(/^\./, '');

    // 1. JSON формат
    if (fmt === 'json' || content.trim().startsWith('[') || (content.trim().startsWith('{') && content.includes('"subtitles"'))) {
      try {
        const parsed = JSON.parse(content);
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.subtitles) ? parsed.subtitles : (Array.isArray(parsed.cues) ? parsed.cues : []));
        return list.map((item: any, idx: number) => ({
          index: typeof item.index === 'number' ? item.index : idx + 1,
          startSec: typeof item.startSec === 'number' ? item.startSec : (typeof item.start === 'number' ? item.start : 0),
          endSec: typeof item.endSec === 'number' ? item.endSec : (typeof item.end === 'number' ? item.end : 0),
          speaker: item.speaker ? String(item.speaker) : undefined,
          text: String(item.text || item.content || '')
        }));
      } catch (err) {
        console.warn('[ProjectManager] Ошибка парсинга JSON субтитров:', err);
      }
    }

    // 2. ASS / SSA формат
    if (fmt === 'ass' || fmt === 'ssa' || content.includes('[Events]') || content.includes('Dialogue:')) {
      const lines = content.split(/\r?\n/);
      let cueIndex = 1;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Dialogue:')) {
          const parts = trimmed.substring(9).split(',');
          if (parts.length >= 10) {
            const startStr = parts[1].trim();
            const endStr = parts[2].trim();
            const speaker = parts[4]?.trim() || undefined;
            const text = parts.slice(9).join(',').replace(/\\N/g, ' ').replace(/\{[^}]*\}/g, '').trim();

            const parseAssTime = (t: string): number => {
              const p = t.split(':');
              if (p.length === 3) {
                const h = parseFloat(p[0]) || 0;
                const m = parseFloat(p[1]) || 0;
                const s = parseFloat(p[2]) || 0;
                return h * 3600 + m * 60 + s;
              }
              return 0;
            };

            const startSec = parseAssTime(startStr);
            const endSec = parseAssTime(endStr);

            if (text && endSec > startSec) {
              cues.push({
                index: cueIndex++,
                startSec,
                endSec,
                speaker: speaker && speaker !== 'Default' ? speaker : undefined,
                text
              });
            }
          }
        }
      }

      if (cues.length > 0) return cues;
    }

    // 3. SRT & WebVTT форматы
    // Универсальный разбор блоков с таймкодами вида 00:00:00,000 --> 00:00:00,000 или 00:00.000 --> 00:00.000
    const parseTimecode = (t: string): number => {
      const clean = t.trim().replace(',', '.');
      const parts = clean.split(':');
      if (parts.length === 3) {
        const h = parseFloat(parts[0]) || 0;
        const m = parseFloat(parts[1]) || 0;
        const s = parseFloat(parts[2]) || 0;
        return h * 3600 + m * 60 + s;
      } else if (parts.length === 2) {
        const m = parseFloat(parts[0]) || 0;
        const s = parseFloat(parts[1]) || 0;
        return m * 60 + s;
      }
      return 0;
    };

    const blocks = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\s*\n/);
    let index = 1;

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length === 0 || (lines.length === 1 && lines[0].startsWith('WEBVTT'))) continue;

      let timeLineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) {
          timeLineIdx = i;
          break;
        }
      }

      if (timeLineIdx >= 0) {
        const timeParts = lines[timeLineIdx].split('-->');
        if (timeParts.length === 2) {
          const startSec = parseTimecode(timeParts[0].trim().split(' ')[0]);
          const endSec = parseTimecode(timeParts[1].trim().split(' ')[0]);

          const rawTextLines = lines.slice(timeLineIdx + 1);
          let rawText = rawTextLines.join(' ').replace(/<[^>]*>/g, '').trim();

          // Определение диктора/спикера: "Актёр 1: Текст" или "[Диктор]: Текст" или "<v Speaker>Текст"
          let speaker: string | undefined = undefined;
          const speakerMatch = rawText.match(/^\[([^\]]+)\]:\s*(.*)$/) || rawText.match(/^([А-Яа-яA-Za-z0-9\s_-]+):\s+(.*)$/);
          if (speakerMatch) {
            speaker = speakerMatch[1].trim();
            rawText = speakerMatch[2].trim();
          }

          if (rawText && endSec > startSec) {
            cues.push({
              index: index++,
              startSec,
              endSec,
              speaker,
              text: rawText
            });
          }
        }
      }
    }

    return cues;
  }

  /**
   * Асинхронный парсинг файла субтитров
   */
  public async parseSubtitleFile(file: File): Promise<SubtitleCue[]> {
    const text = await file.text();
    const ext = file.name.split('.').pop() || 'srt';
    return this.parseSubtitleText(text, ext);
  }

  /**
   * Синхронизация состояния project.json при добавлении дорожек, видео или субтитров
   */
  public async syncProjectState(
    currentTracks: TrackMetadata[],
    videoMeta: VideoMetadata | null,
    subtitles?: SubtitleCue[],
    masterMeta?: MasterMetadata,
    projectName?: string
  ): Promise<ProjectState> {
    const existingState = await this.loadProjectState();

    const updatedState: ProjectState = {
      id: existingState?.id || `proj_${Date.now()}`,
      name: projectName || existingState?.name || this.activeDirectoryName || 'Проект дубляжа',
      createdAt: existingState?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sampleRate: 48000,
      videoFile: videoMeta || existingState?.videoFile || null,
      tracks: currentTracks,
      master: masterMeta || existingState?.master || {
        volumeDb: 0,
        pan: 0,
        limiterEnabled: true,
        limiterCeilingDb: -0.1
      },
      subtitles: subtitles || existingState?.subtitles || []
    };

    await this.saveProjectState(updatedState);
    return updatedState;
  }

  /**
   * Получение текущего состояния содержимого рабочей директории
   */
  public getCurrentDirectoryContent(): ProjectDirectoryContent | null {
    if (!this.activeDirectoryName && this.memoryFiles.size === 0) {
      return null;
    }
    const discoveredFiles: DiscoveredFile[] = Array.from(this.memoryFiles.values()).map((file) => ({
      name: file.name,
      type: this.getFileType(file.name),
      sizeBytes: file.size,
      lastModified: file.lastModified,
      fileObj: file,
      relativePath: file.name,
      fileHandle: this.fileHandlesMap.get(file.name)
    }));

    return {
      directoryName: this.activeDirectoryName || 'Текущая папка проекта',
      hasWritePermission: !this.isFallbackMode && !!this.dirHandle,
      discoveredFiles,
      savedState: null
    };
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
