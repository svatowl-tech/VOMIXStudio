/**
 * ============================================================================
 * PROJECT WORKSPACE COMPONENT (Local File System & DAW Integration)
 * ============================================================================
 * Интерфейс выбора локальной рабочей папки через File System Access API,
 * инспектора медиа-файлов, сохранения/загрузки конфигурации `project/project.json`
 * и синхронизации с дорожками микшера.
 * ============================================================================
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  globalProjectManager,
  ProjectDirectoryContent,
  DiscoveredFile,
  ProjectState,
  TrackMetadata
} from '../services/ProjectManager';
import { TrackState, MasterState } from '../audio/dawEngine';
import {
  FolderOpen,
  Save,
  HardDrive,
  CheckCircle2,
  AlertTriangle,
  FileVideo,
  FileAudio,
  FileText,
  RefreshCw,
  FolderPlus,
  Clock,
  Layers,
  Sliders,
  Check,
  Download,
  Info
} from 'lucide-react';

interface ProjectWorkspaceProps {
  tracks: TrackState[];
  master: MasterState;
  sourceVideoFile: File | null;
  onLoadProjectState?: (state: ProjectState) => void;
  onImportMediaFiles?: (files: { videoFile?: File; audioFiles: { file: File; name: string }[] }) => void;
}

export const ProjectWorkspace: React.FC<ProjectWorkspaceProps> = ({
  tracks,
  master,
  sourceVideoFile,
  onLoadProjectState,
  onImportMediaFiles,
}) => {
  const [directoryContent, setDirectoryContent] = useState<ProjectDirectoryContent | null>(null);
  const [projectName, setProjectName] = useState<string>('Новый проект дубляжа');
  const [projectId, setProjectId] = useState<string>(`proj_${Date.now()}`);
  const [createdAt, setCreatedAt] = useState<string>(new Date().toISOString());
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'info' | 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [autoSave, setAutoSave] = useState<boolean>(false);

  const fallbackInputRef = useRef<HTMLInputElement | null>(null);
  const isFSSupported = globalProjectManager.isFileSystemAccessSupported();

  // Автоматическое сохранение при изменении дорожек при включенном чекбоксе
  useEffect(() => {
    if (autoSave && directoryContent) {
      const timer = setTimeout(() => {
        handleSaveProject();
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [tracks, master, autoSave]);

  const showStatus = (type: 'info' | 'success' | 'warning' | 'error', text: string) => {
    setStatusMessage({ type, text });
    if (type === 'success' || type === 'info') {
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  /**
   * Открытие локальной папки через File System Access API
   */
  const handleOpenDirectory = async () => {
    setIsLoading(true);
    setStatusMessage(null);

    try {
      if (isFSSupported) {
        const content = await globalProjectManager.openProjectFolder();
        applyLoadedContent(content);
      } else {
        // Fallback на стандартный input webkitdirectory
        fallbackInputRef.current?.click();
      }
    } catch (err: any) {
      console.warn('Ошибка открытия папки:', err);
      if (err.message && !err.message.includes('отменен')) {
        showStatus('error', err.message || 'Ошибка открытия директории');
      }
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Обработка выбора файлов через fallback input[webkitdirectory]
   */
  const handleFallbackFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsLoading(true);
    try {
      const content = await globalProjectManager.loadFromFileInput(files);
      applyLoadedContent(content);
    } catch (err: any) {
      showStatus('error', err.message || 'Ошибка чтения файлов');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Применение прочитанной структуры директории к состоянию UI
   */
  const applyLoadedContent = (content: ProjectDirectoryContent) => {
    setDirectoryContent(content);

    if (content.savedState) {
      const s = content.savedState;
      setProjectId(s.id);
      setProjectName(s.name);
      setCreatedAt(s.createdAt);
      setLastSavedAt(s.updatedAt);
      showStatus(
        'success',
        `Проект "${s.name}" успешно загружен (${content.discoveredFiles.length} файлов обнаружено).`
      );
      onLoadProjectState?.(s);
    } else {
      setProjectName(content.directoryName || 'Новый проект дубляжа');
      showStatus(
        'info',
        `Папка "${content.directoryName}" открыта. Файлов: ${content.discoveredFiles.length}. Файл project.json будет создан при сохранении.`
      );
    }
  };

  /**
   * Сохранение текущего состояния DAW в project/project.json
   */
  const handleSaveProject = async () => {
    setIsSaving(true);

    const trackMetas: TrackMetadata[] = tracks.map((t) => ({
      id: t.id,
      name: t.name,
      fileName: t.clips[0]?.name || `${t.name.toLowerCase().replace(/\s+/g, '_')}.wav`,
      volumeDb: t.volumeDb,
      pan: t.pan,
      solo: t.solo,
      mute: t.mute,
      offsetSec: t.clips[0]?.offsetSamples ? t.clips[0].offsetSamples / 48000 : 0,
      color: t.color,
    }));

    const projectState: ProjectState = {
      id: projectId,
      name: projectName,
      createdAt,
      updatedAt: new Date().toISOString(),
      sampleRate: 48000,
      videoFile: sourceVideoFile
        ? {
            name: sourceVideoFile.name,
            relativePath: sourceVideoFile.name,
            durationSec: 0,
            fps: 30,
            fileSize: sourceVideoFile.size,
          }
        : null,
      tracks: trackMetas,
      master: {
        volumeDb: master.volumeDb,
        pan: master.pan,
        limiterEnabled: master.limiterEnabled,
        limiterCeilingDb: master.limiterCeilingDb,
      },
    };

    try {
      const success = await globalProjectManager.saveProjectState(projectState);
      if (success) {
        setLastSavedAt(projectState.updatedAt);
        showStatus('success', 'Состояние проекта успешно сохранено в project/project.json');
      }
    } catch (err: any) {
      showStatus('error', `Ошибка сохранения: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Пакетный импорт обнаруженных файлов в дорожки таймлайна
   */
  const handleImportDiscoveredFiles = () => {
    if (!directoryContent || !onImportMediaFiles) return;

    const audioFiles: { file: File; name: string }[] = [];
    let videoFile: File | undefined;

    for (const df of directoryContent.discoveredFiles) {
      if (df.fileObj) {
        if (df.type === 'video' && !videoFile) {
          videoFile = df.fileObj;
        } else if (df.type === 'audio') {
          audioFiles.push({ file: df.fileObj, name: df.name });
        }
      }
    }

    onImportMediaFiles({ videoFile, audioFiles });
    showStatus('success', `Импортировано файлов в DAW: ${audioFiles.length} аудио, ${videoFile ? '1 видео' : '0 видео'}`);
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <div id="project-workspace-container" className="bg-[#12141a] border border-[#232733] rounded-xl p-5 text-gray-200 shadow-xl space-y-6">
      {/* Скрытый fallback input для директорий */}
      <input
        type="file"
        ref={fallbackInputRef}
        onChange={handleFallbackFolderSelect}
        // @ts-ignore
        webkitdirectory="true"
        directory="true"
        multiple
        className="hidden"
      />

      {/* Заголовок панели управления проектом */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#232733] pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
            <HardDrive className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white tracking-wide">Менеджер локальных проектов (FS API)</h2>
            <p className="text-xs text-gray-400">
              Прямая работа с локальной файловой системой без облака и сторонних серверов
            </p>
          </div>
        </div>

        {/* Кнопки открытия и сохранения */}
        <div className="flex items-center gap-2">
          <button
            id="btn-open-project-folder"
            onClick={handleOpenDirectory}
            disabled={isLoading}
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#1a1e29] hover:bg-[#232938] border border-[#2d3446] text-sm font-medium text-gray-200 transition-all cursor-pointer shadow-sm disabled:opacity-50"
          >
            <FolderOpen className="w-4 h-4 text-blue-400" />
            <span>{isLoading ? 'Чтение...' : 'Открыть папку проекта'}</span>
          </button>

          <button
            id="btn-save-project-state"
            onClick={handleSaveProject}
            disabled={isSaving}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-all cursor-pointer shadow-md shadow-blue-600/20 disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>{isSaving ? 'Запись...' : 'Сохранить project.json'}</span>
          </button>
        </div>
      </div>

      {/* Статусные сообщения */}
      {statusMessage && (
        <div
          className={`p-3 rounded-lg border text-xs flex items-center justify-between animate-fadeIn ${
            statusMessage.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
              : statusMessage.type === 'error'
              ? 'bg-red-950/40 border-red-500/30 text-red-300'
              : statusMessage.type === 'warning'
              ? 'bg-amber-950/40 border-amber-500/30 text-amber-300'
              : 'bg-blue-950/40 border-blue-500/30 text-blue-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {statusMessage.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
            {statusMessage.type === 'error' && <AlertTriangle className="w-4 h-4 text-red-400" />}
            {statusMessage.type === 'info' && <Info className="w-4 h-4 text-blue-400" />}
            <span>{statusMessage.text}</span>
          </div>
          <button onClick={() => setStatusMessage(null)} className="text-gray-400 hover:text-white cursor-pointer ml-4">
            ×
          </button>
        </div>
      )}

      {/* Основная сетка: Параметры проекта & Файловый браузер */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Левая колонка: Метаданные проекта и статус */}
        <div className="space-y-4 bg-[#171a23] border border-[#232733] rounded-lg p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 flex items-center gap-2">
            <Sliders className="w-4 h-4 text-blue-400" />
            Свойства проекта
          </h3>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Название проекта</label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              className="w-full bg-[#101218] border border-[#2a3040] rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="space-y-2 pt-2 border-t border-[#232733] text-xs">
            <div className="flex justify-between text-gray-400">
              <span>Рабочая папка:</span>
              <span className="font-mono text-gray-200 truncate max-w-[180px]" title={directoryContent?.directoryName}>
                {directoryContent ? directoryContent.directoryName : 'Не выбрана'}
              </span>
            </div>

            <div className="flex justify-between text-gray-400">
              <span>Режим доступа:</span>
              <span className={`font-medium ${directoryContent?.hasWritePermission ? 'text-emerald-400' : 'text-amber-400'}`}>
                {directoryContent
                  ? directoryContent.hasWritePermission
                    ? 'Read/Write (Нативный FS API)'
                    : 'Read-Only (Fallback режим)'
                  : 'Ожидание выбора'}
              </span>
            </div>

            <div className="flex justify-between text-gray-400">
              <span>ID проекта:</span>
              <span className="font-mono text-gray-300">{projectId.slice(0, 16)}...</span>
            </div>

            <div className="flex justify-between text-gray-400">
              <span>Последнее сохранение:</span>
              <span className="text-gray-300">
                {lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : 'Не сохранялось'}
              </span>
            </div>
          </div>

          <div className="pt-3 border-t border-[#232733] flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoSave}
                onChange={(e) => setAutoSave(e.target.checked)}
                className="rounded border-[#2a3040] bg-[#101218] text-blue-500 focus:ring-0 cursor-pointer"
              />
              <span>Автосохранение project.json</span>
            </label>
          </div>
        </div>

        {/* Правая колонка (2 span): Список обнаруженных файлов */}
        <div className="lg:col-span-2 space-y-3 bg-[#171a23] border border-[#232733] rounded-lg p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 flex items-center gap-2">
              <FolderPlus className="w-4 h-4 text-emerald-400" />
              Обнаруженные медиафайлы в папке (
              {directoryContent ? directoryContent.discoveredFiles.length : 0})
            </h3>

            {directoryContent && directoryContent.discoveredFiles.length > 0 && onImportMediaFiles && (
              <button
                onClick={handleImportDiscoveredFiles}
                className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 cursor-pointer bg-blue-500/10 px-2.5 py-1 rounded border border-blue-500/20"
              >
                <Layers className="w-3.5 h-3.5" />
                Импортировать все в DAW
              </button>
            )}
          </div>

          {directoryContent && directoryContent.discoveredFiles.length > 0 ? (
            <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
              {directoryContent.discoveredFiles.map((file, idx) => (
                <div
                  key={`${file.name}_${idx}`}
                  className="flex items-center justify-between p-2 rounded bg-[#101218] border border-[#222735] hover:border-[#2f364a] text-xs transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {file.type === 'video' && <FileVideo className="w-4 h-4 text-purple-400 shrink-0" />}
                    {file.type === 'audio' && <FileAudio className="w-4 h-4 text-emerald-400 shrink-0" />}
                    {file.type === 'subtitle' && <FileText className="w-4 h-4 text-amber-400 shrink-0" />}
                    {file.type === 'other' && <FileText className="w-4 h-4 text-gray-500 shrink-0" />}

                    <span className="text-gray-200 font-mono truncate">{file.name}</span>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                        file.type === 'video'
                          ? 'bg-purple-950 text-purple-300 border border-purple-800'
                          : file.type === 'audio'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                          : 'bg-gray-800 text-gray-300'
                      }`}
                    >
                      {file.type}
                    </span>
                    <span className="text-gray-400 font-mono text-[11px]">{formatBytes(file.sizeBytes)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center border border-dashed border-[#282e3f] rounded-lg">
              <FolderOpen className="w-8 h-8 text-gray-600 mx-auto mb-2" />
              <p className="text-xs text-gray-400">
                {directoryContent ? 'В выбранной папке нет поддерживаемых медиафайлов.' : 'Нажмите "Открыть папку проекта" для сканирования видео и аудиодорожек.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
