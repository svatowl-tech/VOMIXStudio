/**
 * ============================================================================
 * MEDIA IMPORT MODAL (Universal Media Hub & Direct Pipeline Ingestion)
 * ============================================================================
 * Единый интерактивный хаб импорта медиаматериалов для проекта дубляжа:
 * 
 * 1. Поддержка двух ключевых сценариев работы:
 *    - «Открыть проект из файлов»: пакетная загрузка (видео + дубли + субтитры),
 *      создание новой структуры проекта с нуля.
 *    - «Догрузить файлы в текущий проект»: добавление недостающих дорожек дублеров,
 *      замена видеоряда или импорт новой редакции субтитров без сброса уже
 *      расставленных на таймлайне клипов и настроек DSP.
 * 
 * 2. Автоматическое распознавание и C++ WASM маршрутизация:
 *    - Видео (MP4, MKV, MOV, WebM, AVI): передача в видеомонитор + нативное извлечение
 *      оригинального звука через MediaNormalizer (C++ Catmull-Rom ресэмплинг 48 кГц).
 *    - Аудиофайлы (WAV, MP3, FLAC, OGG, AAC, M4A, AIFF): векторный ресэмплинг до 48 кГц
 *      в куче WASM и распределение по новым или свободным дорожкам микшера.
 *    - Субтитры (SRT, ASS, SSA, VTT, JSON): мгновенный парсинг таймкодов и привязка к таймлайну.
 * 
 * 3. Прямая регистрация и сохранение в project/project.json через ProjectManager.
 * ============================================================================
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Upload,
  Film,
  Music,
  FileText,
  FileQuestion,
  X,
  Plus,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Layers,
  Settings2,
  Trash2,
  RefreshCw,
  FolderOpen,
  ArrowRight,
  HardDrive,
  FolderPlus,
  Sliders,
  Check,
  FileUp
} from 'lucide-react';
import { TrackState, DEFAULT_TRACK_COLORS } from '../audio/dawEngine';
import { MediaNormalizer } from '../services/MediaNormalizer';
import { globalProjectManager, SubtitleCue, TrackMetadata, VideoMetadata } from '../services/ProjectManager';
import { systemLogger } from '../services/SystemLogger';

/**
 * Режимы импорта
 */
export type ImportMode = 'append' | 'new_project';

/**
 * Структура элемента очереди импорта
 */
export interface ImportItem {
  id: string;
  file: File;
  name: string;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  sizeBytes: number;
  status: 'pending' | 'processing' | 'success' | 'error';
  progressPercent: number;
  errorMessage?: string;
  // Настройки маршрутизации для аудио
  targetTrackId?: number; // Если undefined — создается новая дорожка
  targetTrackName?: string;
  trackColor?: string;
  replaceExistingTrack?: boolean;
  // Настройки для видео
  extractOriginalAudio?: boolean;
}

export interface MediaImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  existingTracks?: TrackState[];
  currentVideoFile?: File | null;
  defaultMode?: ImportMode;
  /**
   * Сброс текущего состояния таймлайна перед импортом нового проекта
   */
  onResetProjectState?: () => void;
  /**
   * Колбэк импорта видеофайла
   */
  onImportVideo?: (videoFile: File, audioPcm?: Float32Array, durationSec?: number) => Promise<void> | void;
  /**
   * Колбэк импорта аудиодорожки
   */
  onImportAudioTrack?: (
    file: File,
    pcmBuffer: Float32Array,
    config: {
      name: string;
      trackId?: number;
      color?: string;
      replaceExisting?: boolean;
    }
  ) => Promise<void> | void;
  /**
   * Колбэк импорта субтитров
   */
  onImportSubtitles?: (cues: SubtitleCue[], sourceFileName?: string) => Promise<void> | void;
  /**
   * Финальный колбэк после завершения импорта всех элементов
   */
  onImportComplete?: (summary: {
    mode: ImportMode;
    videoCount: number;
    audioCount: number;
    subtitleCount: number;
  }) => void;
}

export const MediaImportModal: React.FC<MediaImportModalProps> = ({
  isOpen,
  onClose,
  existingTracks = [],
  currentVideoFile = null,
  defaultMode = 'append',
  onResetProjectState,
  onImportVideo,
  onImportAudioTrack,
  onImportSubtitles,
  onImportComplete
}) => {
  const [importMode, setImportMode] = useState<ImportMode>(defaultMode);
  const [items, setItems] = useState<ImportItem[]>([]);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [saveToDiskDirectly, setSaveToDiskDirectly] = useState<boolean>(true);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Сброс состояния при открытии модального окна
  useEffect(() => {
    if (isOpen) {
      setItems([]);
      setIsProcessing(false);
      setStatusMessage(null);
      setImportMode(defaultMode);
    }
  }, [isOpen, defaultMode]);

  if (!isOpen) return null;

  /**
   * Автоматическая классификация файла по расширению
   */
  const detectFileType = (file: File): 'video' | 'audio' | 'subtitle' | 'other' => {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ogv'].includes(ext)) {
      return 'video';
    }
    if (['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a', 'aiff', 'wma'].includes(ext)) {
      return 'audio';
    }
    if (['srt', 'vtt', 'ass', 'ssa', 'json', 'sub'].includes(ext)) {
      return 'subtitle';
    }
    return 'other';
  };

  /**
   * Добавление списка файлов в очередь импорта с интеллектуальной авто-маршрутизацией
   */
  const addFilesToQueue = (files: FileList | File[]) => {
    const newItems: ImportItem[] = [];
    const fileArray = Array.from(files);

    fileArray.forEach((file, index) => {
      // Исключаем дубликаты уже добавленных файлов в этой сессии
      if (items.some((it) => it.file.name === file.name && it.file.size === file.size)) {
        return;
      }

      const fileType = detectFileType(file);
      const cleanName = file.name.replace(/\.[^/.]+$/, '');
      const colorIndex = (existingTracks.length + items.length + index) % DEFAULT_TRACK_COLORS.length;
      const defaultColor = DEFAULT_TRACK_COLORS[colorIndex];

      newItems.push({
        id: `import_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 6)}`,
        file,
        name: file.name,
        type: fileType,
        sizeBytes: file.size,
        status: 'pending',
        progressPercent: 0,
        targetTrackId: undefined, // По умолчанию создается новая дорожка
        targetTrackName: cleanName,
        trackColor: defaultColor,
        replaceExistingTrack: false,
        extractOriginalAudio: true
      });
    });

    if (newItems.length > 0) {
      setItems((prev) => [...prev, ...newItems]);
      systemLogger.info('Project', `В очередь импорта добавлено файлов: ${newItems.length} (Режим: ${importMode === 'new_project' ? 'Новый проект' : 'Догрузка'})`);
    }
  };

  // Обработчики Drag & Drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(e.dataTransfer.files);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToQueue(e.target.files);
      e.target.value = '';
    }
  };

  /**
   * Удаление файла из очереди
   */
  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  };

  /**
   * Обновление свойств элемента очереди
   */
  const updateItem = (id: string, updates: Partial<ImportItem>) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...updates } : it))
    );
  };

  /**
   * Запуск сквозного конвейера обработки и импорта
   */
  const handleStartImport = async () => {
    if (items.length === 0 || isProcessing) return;

    setIsProcessing(true);
    setStatusMessage('Запуск C++ конвейера унификации и регистрации файлов...');

    // Если выбран режим "Открыть новый проект" — сбрасываем существующие дорожки
    if (importMode === 'new_project' && onResetProjectState) {
      onResetProjectState();
    }

    let videoCount = 0;
    let audioCount = 0;
    let subtitleCount = 0;

    const baseTracks = importMode === 'new_project' ? [] : existingTracks;
    const activeProjectTracks: TrackMetadata[] = baseTracks.map((t) => ({
      id: t.id,
      name: t.name,
      fileName: t.clips[0]?.name || '',
      volumeDb: t.volumeDb,
      pan: t.pan,
      solo: t.solo,
      mute: t.mute,
      offsetSec: (t.clips[0]?.offsetSamples || 0) / 48000,
      color: t.color
    }));

    let lastVideoMeta: VideoMetadata | null = null;
    let accumulatedSubtitles: SubtitleCue[] = [];

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        updateItem(item.id, { status: 'processing', progressPercent: 20 });

        try {
          // 1. Автоматическое сохранение в открытую директорию проекта (если включено)
          if (saveToDiskDirectly) {
            try {
              await globalProjectManager.saveFileToProjectFolder(item.file, false);
            } catch (saveErr) {
              console.warn(`[MediaImport] Не удалось напрямую записать ${item.file.name} на диск:`, saveErr);
            }
          }
          globalProjectManager.addDiscoveredFile(item.file);

          // 2. Маршрутизация по типу медиа

          // --- А. ВИДЕОФАЙЛ ---
          if (item.type === 'video') {
            updateItem(item.id, { progressPercent: 40 });
            setStatusMessage(`Обработка видеопотока [${item.file.name}]...`);

            let extractedPcm: Float32Array | undefined = undefined;

            // Автоматическое извлечение оригинального звука через C++ Catmull-Rom ресэмплинг
            if (item.extractOriginalAudio) {
              try {
                setStatusMessage(`Извлечение аудио из [${item.file.name}] через C++ Catmull-Rom ресэмплинг...`);
                extractedPcm = await MediaNormalizer.extractAudioFromVideo(item.file, 48000);
                systemLogger.info('MediaNormalizer', `Звуковая дорожка видео извлечена: ${Math.round(extractedPcm.length / 2)} сэмплов 48 кГц.`);
              } catch (audioExtErr) {
                console.warn('[MediaImport] Не удалось автоматически извлечь аудио из видео:', audioExtErr);
              }
            }

            if (onImportVideo) {
              await onImportVideo(item.file, extractedPcm);
            }

            lastVideoMeta = {
              name: item.file.name,
              relativePath: item.file.name,
              durationSec: extractedPcm ? (extractedPcm.length / 2) / 48000 : 0,
              fps: 30.0,
              fileSize: item.file.size
            };

            videoCount++;
            updateItem(item.id, { status: 'success', progressPercent: 100 });
          }

          // --- Б. АУДИОДОРОЖКИ ---
          else if (item.type === 'audio') {
            updateItem(item.id, { progressPercent: 40 });
            setStatusMessage(`C++ кубический ресэмплинг [${item.file.name}] в 48 000 Гц...`);

            // Декодирование и аппаратный C++ ресэмплинг до 48 000 Гц стерео
            const pcmBuffer = await MediaNormalizer.unifyAudioBuffer(item.file, 48000);

            updateItem(item.id, { progressPercent: 80 });

            if (onImportAudioTrack) {
              await onImportAudioTrack(item.file, pcmBuffer, {
                name: item.targetTrackName || item.file.name.replace(/\.[^/.]+$/, ''),
                trackId: item.targetTrackId,
                color: item.trackColor,
                replaceExisting: item.replaceExistingTrack
              });
            }

            // Регистрируем в метаданных проекта
            activeProjectTracks.push({
              id: item.targetTrackId || (activeProjectTracks.length + 1),
              name: item.targetTrackName || item.file.name.replace(/\.[^/.]+$/, ''),
              fileName: item.file.name,
              volumeDb: 0.0,
              pan: 0.0,
              solo: false,
              mute: false,
              offsetSec: 0.0,
              color: item.trackColor
            });

            audioCount++;
            updateItem(item.id, { status: 'success', progressPercent: 100 });
          }

          // --- В. СУБТИТРЫ (SRT, ASS, VTT, JSON) ---
          else if (item.type === 'subtitle') {
            updateItem(item.id, { progressPercent: 50 });
            setStatusMessage(`Парсинг таймкодов субтитров [${item.file.name}]...`);

            const parsedCues = await globalProjectManager.parseSubtitleFile(item.file);
            accumulatedSubtitles = [...accumulatedSubtitles, ...parsedCues];

            if (onImportSubtitles) {
              await onImportSubtitles(parsedCues, item.file.name);
            }

            systemLogger.info('Project', `Субтитры [${item.file.name}] успешно импортированы: ${parsedCues.length} реплик.`);
            subtitleCount++;
            updateItem(item.id, { status: 'success', progressPercent: 100 });
          }

          // --- Г. ПРОЧИЕ ФАЙЛЫ ---
          else {
            updateItem(item.id, { status: 'success', progressPercent: 100 });
          }
        } catch (itemErr: any) {
          console.error(`Ошибка импорта файла ${item.file.name}:`, itemErr);
          updateItem(item.id, {
            status: 'error',
            progressPercent: 0,
            errorMessage: itemErr?.message || 'Ошибка обработки'
          });
        }
      }

      // 3. Синхронизация project/project.json
      try {
        await globalProjectManager.syncProjectState(
          activeProjectTracks,
          lastVideoMeta,
          accumulatedSubtitles.length > 0 ? accumulatedSubtitles : undefined
        );
        systemLogger.info('Project', 'Состояние проекта успешно синхронизировано в project/project.json');
      } catch (syncErr) {
        console.warn('[MediaImport] Не удалось синхронизировать project.json:', syncErr);
      }

      setStatusMessage(`Импорт завершен: Видео: ${videoCount}, Аудио: ${audioCount}, Субтитры: ${subtitleCount}`);

      if (onImportComplete) {
        onImportComplete({ mode: importMode, videoCount, audioCount, subtitleCount });
      }

      // Задержка перед закрытием модального окна для отображения успешного завершения
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (globalErr: any) {
      console.error('Сбой сквозного импорта:', globalErr);
      setStatusMessage(`Ошибка импорта: ${globalErr?.message || globalErr}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const videoItemsCount = items.filter((it) => it.type === 'video').length;
  const audioItemsCount = items.filter((it) => it.type === 'audio').length;
  const subtitleItemsCount = items.filter((it) => it.type === 'subtitle').length;
  const totalSizeBytes = items.reduce((acc, it) => acc + it.sizeBytes, 0);

  return (
    <div
      id="media-import-modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200"
    >
      <div
        id="media-import-modal-container"
        className="bg-zinc-900 border border-zinc-700/80 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Шапка модального окна */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-950/70">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 border border-cyan-500/40 rounded-xl text-cyan-400">
              <Upload className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
                Хаб импорта медиаматериалов
                <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-950/60 text-cyan-400 border border-cyan-800/60 font-mono font-normal">
                  C++ Catmull-Rom 48kHz
                </span>
              </h2>
              <p className="text-xs text-zinc-400">
                Загрузка видеоряда, дублей, стемов и субтитров с автоматической нормализацией
              </p>
            </div>
          </div>
          <button
            id="btn-close-import-modal"
            onClick={onClose}
            disabled={isProcessing}
            className="p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
            title="Закрыть"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Переключатель режимов: "Открыть проект из файлов" vs "Догрузить в проект" */}
        <div className="px-6 pt-4 pb-2 border-b border-zinc-800/60 bg-zinc-950/40 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center p-1 bg-zinc-950 rounded-xl border border-zinc-800">
            <button
              type="button"
              id="tab-mode-append"
              onClick={() => setImportMode('append')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-2 cursor-pointer ${
                importMode === 'append'
                  ? 'bg-cyan-600 text-white shadow-md shadow-cyan-950/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <FileUp className="w-3.5 h-3.5" />
              Догрузить файлы в текущий проект
            </button>

            <button
              type="button"
              id="tab-mode-new-project"
              onClick={() => setImportMode('new_project')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-2 cursor-pointer ${
                importMode === 'new_project'
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-950/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <FolderPlus className="w-3.5 h-3.5" />
              Открыть новый проект из файлов
            </button>
          </div>

          <div className="text-[11px] text-zinc-400 font-mono">
            {importMode === 'append' ? (
              <span className="text-cyan-400">✓ Сохраняет существующие дорожки и клипы таймлайна</span>
            ) : (
              <span className="text-emerald-400">✓ Формирует чистый таймлайн под загружаемую пачку</span>
            )}
          </div>
        </div>

        {/* Тело модального окна */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Зона Drag & Drop и выбора файлов */}
          <div
            id="dropzone-media-import"
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-7 text-center cursor-pointer transition-all duration-200 flex flex-col items-center justify-center gap-3 ${
              isDragging
                ? 'border-cyan-400 bg-cyan-950/30 scale-[0.99]'
                : 'border-zinc-700/80 hover:border-zinc-500 bg-zinc-950/40 hover:bg-zinc-950/70'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="video/*,audio/*,.srt,.vtt,.ass,.ssa,.json,.wav,.mp3,.aac,.flac,.ogg,.m4a,.mkv,.mov,.webm,.mp4"
              className="hidden"
              onChange={handleFileInputChange}
            />
            <div className="w-12 h-12 rounded-full bg-zinc-800/90 border border-zinc-700 flex items-center justify-center text-cyan-400 shadow-inner">
              <Upload className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-200">
                Перетащите сюда файлы проекта или нажмите для выбора
              </p>
              <p className="text-xs text-zinc-400 mt-1">
                Видео (MP4, MKV, MOV, WebM), Аудио (WAV, MP3, FLAC, AAC, OGG), Субтитры (SRT, ASS, VTT, JSON)
              </p>
            </div>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-400 bg-zinc-900/90 px-3 py-1.5 rounded-lg border border-zinc-800 font-mono">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
              <span>Авто-ресэмплинг C++ 48 кГц • Извлечение аудио из видео • Парсер таймкодов</span>
            </div>
          </div>

          {/* Список добавленных элементов в очереди */}
          {items.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
                  <Layers className="w-4 h-4 text-cyan-400" />
                  Очередь файлов к импорту ({items.length})
                </h3>
                <div className="flex items-center gap-3 text-xs text-zinc-400 font-mono">
                  {videoItemsCount > 0 && (
                    <span className="text-amber-400 flex items-center gap-1">
                      <Film className="w-3.5 h-3.5" /> {videoItemsCount} видео
                    </span>
                  )}
                  {audioItemsCount > 0 && (
                    <span className="text-cyan-400 flex items-center gap-1">
                      <Music className="w-3.5 h-3.5" /> {audioItemsCount} аудио
                    </span>
                  )}
                  {subtitleItemsCount > 0 && (
                    <span className="text-emerald-400 flex items-center gap-1">
                      <FileText className="w-3.5 h-3.5" /> {subtitleItemsCount} субтитры
                    </span>
                  )}
                  <span>({(totalSizeBytes / (1024 * 1024)).toFixed(2)} МБ)</span>
                </div>
              </div>

              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {items.map((item) => {
                  const isAudio = item.type === 'audio';
                  const isVideo = item.type === 'video';
                  const isSub = item.type === 'subtitle';

                  return (
                    <div
                      key={item.id}
                      className="bg-zinc-950/70 border border-zinc-800 rounded-xl p-3 flex flex-col gap-2 hover:border-zinc-700 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          {/* Иконка типа файла */}
                          <div
                            className={`p-2 rounded-lg border flex-shrink-0 ${
                              isVideo
                                ? 'bg-amber-950/40 border-amber-800/60 text-amber-400'
                                : isAudio
                                ? 'bg-cyan-950/40 border-cyan-800/60 text-cyan-400'
                                : isSub
                                ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-400'
                                : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                            }`}
                          >
                            {isVideo && <Film className="w-4 h-4" />}
                            {isAudio && <Music className="w-4 h-4" />}
                            {isSub && <FileText className="w-4 h-4" />}
                            {!isVideo && !isAudio && !isSub && <FileQuestion className="w-4 h-4" />}
                          </div>

                          {/* Имя и размер */}
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-zinc-200 truncate">{item.name}</p>
                            <div className="flex items-center gap-2 text-[11px] text-zinc-400 font-mono">
                              <span>{(item.sizeBytes / (1024 * 1024)).toFixed(2)} МБ</span>
                              <span>•</span>
                              <span className="uppercase text-zinc-400">{item.type}</span>
                              {item.status === 'processing' && (
                                <span className="text-cyan-400 flex items-center gap-1">
                                  <RefreshCw className="w-3 h-3 animate-spin" /> Обработка C++...
                                </span>
                              )}
                              {item.status === 'success' && (
                                <span className="text-emerald-400 flex items-center gap-1">
                                  <CheckCircle2 className="w-3 h-3" /> Готово
                                </span>
                              )}
                              {item.status === 'error' && (
                                <span className="text-rose-400 flex items-center gap-1">
                                  <AlertCircle className="w-3 h-3" /> {item.errorMessage}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Кнопка удаления из очереди */}
                        {!isProcessing && (
                          <button
                            type="button"
                            onClick={() => removeItem(item.id)}
                            className="p-1.5 text-zinc-400 hover:text-rose-400 hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                            title="Удалить из очереди"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>

                      {/* Дополнительные настройки для аудиодорожек */}
                      {isAudio && !isProcessing && (
                        <div className="flex flex-wrap items-center gap-3 pt-2 mt-1 border-t border-zinc-800/80 text-xs">
                          {/* Выбор: Новая дорожка или замена существующей */}
                          <div className="flex items-center gap-2">
                            <label className="text-zinc-400">Назначение:</label>
                            <select
                              value={item.targetTrackId || 'new'}
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val === 'new') {
                                  updateItem(item.id, { targetTrackId: undefined, replaceExistingTrack: false });
                                } else {
                                  const trackId = parseInt(val, 10);
                                  const targetT = existingTracks.find((t) => t.id === trackId);
                                  updateItem(item.id, {
                                    targetTrackId: trackId,
                                    targetTrackName: targetT?.name,
                                    replaceExistingTrack: true
                                  });
                                }
                              }}
                              className="bg-zinc-900 border border-zinc-700 text-zinc-200 rounded px-2 py-1 text-xs focus:border-cyan-500 outline-none cursor-pointer"
                            >
                              <option value="new">+ Создать новую дорожку</option>
                              {existingTracks.map((t) => (
                                <option key={t.id} value={t.id}>
                                  Заменить #{t.id}: {t.name}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Имя дорожки */}
                          <div className="flex items-center gap-2 flex-1 min-w-[180px]">
                            <label className="text-zinc-400">Имя:</label>
                            <input
                              type="text"
                              value={item.targetTrackName || ''}
                              onChange={(e) => updateItem(item.id, { targetTrackName: e.target.value })}
                              placeholder="Имя дорожки"
                              className="bg-zinc-900 border border-zinc-700 text-zinc-200 rounded px-2 py-1 text-xs flex-1 focus:border-cyan-500 outline-none"
                            />
                          </div>

                          {/* Цвет дорожки */}
                          <div className="flex items-center gap-1.5">
                            <label className="text-zinc-400">Цвет:</label>
                            <div className="flex items-center gap-1">
                              {DEFAULT_TRACK_COLORS.slice(0, 5).map((color) => (
                                <button
                                  key={color}
                                  type="button"
                                  onClick={() => updateItem(item.id, { trackColor: color })}
                                  className={`w-4 h-4 rounded-full border transition-transform cursor-pointer ${
                                    item.trackColor === color
                                      ? 'scale-125 border-white shadow-sm'
                                      : 'border-transparent hover:scale-110'
                                  }`}
                                  style={{ backgroundColor: color }}
                                />
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Настройки для видеофайла */}
                      {isVideo && !isProcessing && (
                        <div className="flex items-center gap-2 pt-2 mt-1 border-t border-zinc-800/80 text-xs">
                          <label className="flex items-center gap-2 text-zinc-300 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={item.extractOriginalAudio !== false}
                              onChange={(e) => updateItem(item.id, { extractOriginalAudio: e.target.checked })}
                              className="accent-cyan-500 rounded cursor-pointer"
                            />
                            <span>Автоматически извлечь оригинальный звук в дорожку референса (C++ 48kHz)</span>
                          </label>
                        </div>
                      )}

                      {/* Прогресс-бар обработки */}
                      {item.status === 'processing' && (
                        <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden mt-1">
                          <div
                            className="bg-gradient-to-r from-cyan-500 to-emerald-400 h-full transition-all duration-300"
                            style={{ width: `${item.progressPercent}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Опция прямого сохранения в проект */}
          <div className="bg-zinc-950/40 border border-zinc-800/80 rounded-xl p-3.5 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2.5">
              <HardDrive className="w-4 h-4 text-cyan-400" />
              <div>
                <p className="font-medium text-zinc-200">Прямая регистрация в файловой системе</p>
                <p className="text-zinc-400 text-[11px]">
                  Автоматическая запись в project/project.json и локальную директорию
                </p>
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={saveToDiskDirectly}
                onChange={(e) => setSaveToDiskDirectly(e.target.checked)}
                className="accent-cyan-500 rounded cursor-pointer"
              />
              <span className="text-zinc-300 font-mono">Сохранять на диск</span>
            </label>
          </div>

          {/* Статусное сообщение */}
          {statusMessage && (
            <div className="text-xs font-mono p-3 bg-cyan-950/40 border border-cyan-800/60 rounded-xl text-cyan-300 flex items-center gap-2">
              <Sparkles className="w-4 h-4 flex-shrink-0 text-cyan-400" />
              <span>{statusMessage}</span>
            </div>
          )}
        </div>

        {/* Футер с кнопками управления */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-800 bg-zinc-950/80">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            className="flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-zinc-300 hover:text-zinc-100 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Добавить еще файлы
          </button>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isProcessing}
              className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50 cursor-pointer"
            >
              Отмена
            </button>
            <button
              type="button"
              id="btn-confirm-media-import"
              onClick={handleStartImport}
              disabled={items.length === 0 || isProcessing}
              className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-black bg-gradient-to-r from-cyan-400 to-emerald-400 hover:from-cyan-300 hover:to-emerald-300 rounded-xl shadow-lg shadow-cyan-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isProcessing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Импортирование...
                </>
              ) : (
                <>
                  <ArrowRight className="w-4 h-4" />
                  {importMode === 'new_project'
                    ? `Создать проект из файлов (${items.length})`
                    : `Импортировать в проект (${items.length})`}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
