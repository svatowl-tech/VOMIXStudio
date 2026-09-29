import React, { useState, useEffect, useRef, useId } from 'react';
import {
  X,
  Sliders,
  Layers,
  Sparkles,
  Upload,
  Play,
  Pause,
  Download,
  Trash2,
  Plus,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Save,
  FileArchive,
  Settings2,
  Volume2,
  Cpu,
  Wand2,
  RefreshCw,
  FolderOpen,
  Info
} from 'lucide-react';
import {
  BatchAudioProcessor,
  BatchFileItem,
  BatchEffectItem,
  BatchPreset,
  BatchExportSettings,
  BatchAudioFormat
} from '../services/BatchAudioProcessor';
import { NATIVE_DSP_CATALOG, getEffectDefinition } from '../audio/nativeEffectsCatalog';
import { BUILT_IN_VST_LIBRARY } from '../services/VSTHostEngine';
import { BlobUrlRegistry } from '../utils/BlobUrlRegistry';

interface BatchProcessorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const BatchProcessorModal: React.FC<BatchProcessorModalProps> = ({ isOpen, onClose }) => {
  const processor = BatchAudioProcessor.getInstance();

  // State
  const [files, setFiles] = useState<BatchFileItem[]>([]);
  const [presets, setPresets] = useState<BatchPreset[]>(() => processor.loadPresets());
  const [selectedPresetId, setSelectedPresetId] = useState<string>(presets[0]?.id || 'preset_dubbing_mastering');
  const [chain, setChain] = useState<BatchEffectItem[]>(() => presets[0]?.chain ? JSON.parse(JSON.stringify(presets[0].chain)) : []);
  const [exportSettings, setExportSettings] = useState<BatchExportSettings>(() => presets[0]?.exportSettings ? JSON.parse(JSON.stringify(presets[0].exportSettings)) : {
    format: 'wav_24',
    sampleRate: 48000,
    filenameSuffix: '_mastered',
    normalizeLoudness: true,
    targetLufs: -16
  });

  // Processing state
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [globalProgress, setGlobalProgress] = useState<{ completed: number; total: number; currentName: string }>({
    completed: 0,
    total: 0,
    currentName: ''
  });
  const [isZipping, setIsZipping] = useState<boolean>(false);

  // Active modal for configuring an effect ("Окошечко с настройками")
  const [editingEffectIndex, setEditingEffectIndex] = useState<number | null>(null);
  const [tempParams, setTempParams] = useState<Record<string, any>>({});

  // Catalog picker modal
  const [showAddEffectModal, setShowAddEffectModal] = useState<boolean>(false);
  const [addEffectTab, setAddEffectTab] = useState<'cpp_dsp' | 'vst' | 'neural'>('cpp_dsp');

  // Save preset modal
  const [showSavePresetModal, setShowSavePresetModal] = useState<boolean>(false);
  const [newPresetName, setNewPresetName] = useState<string>('');
  const [newPresetDesc, setNewPresetDesc] = useState<string>('');

  // Audio player preview
  const [playingFileId, setPlayingFileId] = useState<string | null>(null);
  const [playingTrackType, setPlayingTrackType] = useState<'original' | 'processed'>('original');
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileDropZoneId = useId();

  // Handle Preset change
  const handleSelectPreset = (presetId: string) => {
    const found = presets.find(p => p.id === presetId);
    if (found) {
      setSelectedPresetId(presetId);
      setChain(JSON.parse(JSON.stringify(found.chain)));
      setExportSettings(JSON.parse(JSON.stringify(found.exportSettings)));
    }
  };

  // Add files
  const handleAddFiles = (fileList: FileList | File[]) => {
    const newItems: BatchFileItem[] = [];
    const validExtensions = /\.(wav|mp3|flac|ogg|aac|m4a|aiff|mp4|mkv|webm|mov)$/i;

    Array.from(fileList).forEach((file) => {
      if (validExtensions.test(file.name)) {
        const blobUrl = BlobUrlRegistry.create(file);
        newItems.push({
          id: `batch_file_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          file,
          name: file.name,
          sizeBytes: file.size,
          status: 'idle',
          progress: 0,
          originalBlobUrl: blobUrl
        });
      }
    });

    if (newItems.length > 0) {
      setFiles(prev => [...prev, ...newItems]);
    }
  };

  // Generate test samples if user has no files at hand
  const handleAddTestSamples = () => {
    const sampleNames = ['Voiceover_Dub_Scene01.wav', 'Character_Dialogue_Line42.wav', 'Studio_Narration_Take3.wav'];
    const newItems: BatchFileItem[] = [];

    sampleNames.forEach((name, idx) => {
      // Create a short 2-second synthesized speech-like sine/harmonic buffer
      const sampleRate = 48000;
      const duration = 2.5;
      const numFrames = Math.floor(sampleRate * duration);
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const buffer = audioCtx.createBuffer(2, numFrames, sampleRate);
      const channelL = buffer.getChannelData(0);
      const channelR = buffer.getChannelData(1);

      const baseFreq = 160 + idx * 40;
      for (let i = 0; i < numFrames; i++) {
        const t = i / sampleRate;
        // Speech modulation
        const envelope = Math.sin(Math.PI * t / duration);
        const speechVowel = Math.sin(2 * Math.PI * baseFreq * t) * 0.4 +
                            Math.sin(2 * Math.PI * baseFreq * 2.5 * t) * 0.2 +
                            Math.sin(2 * Math.PI * baseFreq * 4.2 * t) * 0.1;
        // Occasional mouth click artifact to demonstrate restoration
        const click = (i === 12000 || i === 35000 || i === 65000) ? 0.8 : 0;
        const s = (speechVowel * envelope + click) * 0.5;
        channelL[i] = s;
        channelR[i] = s;
      }

      // Convert to WAV
      import('../utils/wavEncoder').then(({ encodeWavToBlob }) => {
        const blob = encodeWavToBlob(channelL, channelR, sampleRate, 24);
        const testFile = new File([blob], name, { type: 'audio/wav' });
        const blobUrl = BlobUrlRegistry.create(testFile);

        setFiles(prev => [
          ...prev,
          {
            id: `test_file_${Date.now()}_${idx}`,
            file: testFile,
            name,
            sizeBytes: testFile.size,
            status: 'idle',
            progress: 0,
            durationSec: duration,
            sampleRate,
            originalBlobUrl: blobUrl
          }
        ]);
      });
    });
  };

  // Remove file
  const handleRemoveFile = (id: string) => {
    setFiles(prev => {
      const target = prev.find(f => f.id === id);
      if (target?.originalBlobUrl) BlobUrlRegistry.revoke(target.originalBlobUrl);
      if (target?.processedBlobUrl) BlobUrlRegistry.revoke(target.processedBlobUrl);
      return prev.filter(f => f.id !== id);
    });
  };

  // Clear all
  const handleClearAllFiles = () => {
    files.forEach(f => {
      if (f.originalBlobUrl) BlobUrlRegistry.revoke(f.originalBlobUrl);
      if (f.processedBlobUrl) BlobUrlRegistry.revoke(f.processedBlobUrl);
    });
    setFiles([]);
    setPlayingFileId(null);
  };

  // Chain management
  const handleToggleBypass = (index: number) => {
    setChain(prev => {
      const next = [...prev];
      next[index] = { ...next[index], enabled: !next[index].enabled };
      return next;
    });
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    setChain(prev => {
      const next = [...prev];
      const temp = next[index - 1];
      next[index - 1] = next[index];
      next[index] = temp;
      return next;
    });
  };

  const handleMoveDown = (index: number) => {
    if (index === chain.length - 1) return;
    setChain(prev => {
      const next = [...prev];
      const temp = next[index + 1];
      next[index + 1] = next[index];
      next[index] = temp;
      return next;
    });
  };

  const handleRemoveEffect = (index: number) => {
    setChain(prev => prev.filter((_, i) => i !== index));
  };

  // Open "Окошечко с настройками" for an effect
  const handleOpenSettings = (index: number) => {
    setEditingEffectIndex(index);
    setTempParams(JSON.parse(JSON.stringify(chain[index].params || {})));
  };

  const handleSaveSettings = () => {
    if (editingEffectIndex === null) return;
    setChain(prev => {
      const next = [...prev];
      next[editingEffectIndex] = {
        ...next[editingEffectIndex],
        params: { ...tempParams }
      };
      return next;
    });
    setEditingEffectIndex(null);
  };

  // Add effect from Catalog
  const handleAddEffectFromCatalog = (item: BatchEffectItem) => {
    setChain(prev => [...prev, item]);
    setShowAddEffectModal(false);
  };

  // Save new preset
  const handleSavePreset = () => {
    if (!newPresetName.trim()) return;
    const saved = processor.saveCustomPreset(newPresetName.trim(), newPresetDesc.trim(), chain, exportSettings);
    const updated = processor.loadPresets();
    setPresets(updated);
    setSelectedPresetId(saved.id);
    setShowSavePresetModal(false);
    setNewPresetName('');
    setNewPresetDesc('');
  };

  // Delete custom preset
  const handleDeletePreset = (id: string) => {
    processor.deleteCustomPreset(id);
    const updated = processor.loadPresets();
    setPresets(updated);
    if (selectedPresetId === id) {
      handleSelectPreset(updated[0]?.id || 'preset_dubbing_mastering');
    }
  };

  // Execute Batch Processing
  const handleStartProcessing = async () => {
    if (files.length === 0 || isProcessing) return;

    setIsProcessing(true);
    setGlobalProgress({ completed: 0, total: files.length, currentName: '' });

    await processor.processQueue(
      files,
      chain,
      exportSettings,
      (updatedFile) => {
        setFiles(prev => prev.map(f => f.id === updatedFile.id ? updatedFile : f));
      },
      (completed, total, currentName) => {
        setGlobalProgress({ completed, total, currentName });
      }
    );

    setIsProcessing(false);
  };

  // Download all as ZIP
  const handleDownloadAllZip = async () => {
    setIsZipping(true);
    try {
      const zipBlob = await processor.createZipArchive(files);
      const url = BlobUrlRegistry.create(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `VOMIX_Batch_Audio_${new Date().toISOString().substring(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => BlobUrlRegistry.revoke(url), 10000);
    } catch (e: any) {
      alert(`Ошибка создания архива: ${e.message}`);
    } finally {
      setIsZipping(false);
    }
  };

  // Audio preview playback
  const handleTogglePlay = (fileId: string, type: 'original' | 'processed') => {
    const file = files.find(f => f.id === fileId);
    if (!file) return;

    const url = type === 'processed' ? file.processedBlobUrl : file.originalBlobUrl;
    if (!url) return;

    if (playingFileId === fileId && playingTrackType === type) {
      audioPlayerRef.current?.pause();
      setPlayingFileId(null);
    } else {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.src = url;
        audioPlayerRef.current.play().catch(console.warn);
      }
      setPlayingFileId(fileId);
      setPlayingTrackType(type);
    }
  };

  if (!isOpen) return null;

  const completedCount = files.filter(f => f.status === 'completed').length;
  const editingEffect = editingEffectIndex !== null ? chain[editingEffectIndex] : null;
  const editingDef = editingEffect?.type === 'cpp_dsp' ? getEffectDefinition(Number(editingEffect.effectId)) : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-md p-3 md:p-6 overflow-hidden animate-fadeIn">
      {/* Hidden audio element for previews */}
      <audio
        ref={audioPlayerRef}
        onEnded={() => setPlayingFileId(null)}
        className="hidden"
      />

      <div className="bg-[#0b0f19] border border-slate-700/80 rounded-2xl w-full max-w-7xl h-[92vh] flex flex-col shadow-2xl shadow-cyan-950/50 overflow-hidden">
        {/* ================================================================= */}
        {/* MODAL HEADER WITH PRESET SELECTOR & CONTROLS                     */}
        {/* ================================================================= */}
        <div className="bg-slate-900/90 border-b border-slate-800 px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 border border-emerald-500/40 rounded-xl text-emerald-400 shadow-md shadow-emerald-500/10">
              <Layers size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100">
                  Пакетный батч-обработчик аудиодорожек
                </h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950/80 text-cyan-300 border border-cyan-700/50">
                  C++17 WASM • VST3 • Neural AI
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Массовая обработка файлов цепочкой нативных DSP эффектов и нейросетей
              </p>
            </div>
          </div>

          {/* Preset Controls */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 bg-slate-950/90 border border-slate-800 rounded-xl px-2.5 py-1">
              <span className="text-xs text-slate-400 font-medium">Пресет:</span>
              <select
                value={selectedPresetId}
                onChange={(e) => handleSelectPreset(e.target.value)}
                className="bg-transparent text-xs font-semibold text-emerald-300 focus:outline-none cursor-pointer pr-2 max-w-[200px] truncate"
              >
                {presets.map(p => (
                  <option key={p.id} value={p.id} className="bg-slate-900 text-slate-200">
                    {p.isBuiltIn ? '★ ' : '⚙ '}{p.name}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => setShowSavePresetModal(true)}
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 rounded-xl text-xs font-medium transition-all flex items-center gap-1"
              title="Сохранить текущую цепочку как отдельный пресет"
            >
              <Save size={13} className="text-emerald-400" />
              <span className="hidden sm:inline">Сохранить</span>
            </button>

            {presets.find(p => p.id === selectedPresetId && !p.isBuiltIn) && (
              <button
                onClick={() => handleDeletePreset(selectedPresetId)}
                className="p-1.5 bg-slate-800 hover:bg-red-950 text-slate-400 hover:text-red-400 border border-slate-700 rounded-xl transition-all"
                title="Удалить выбранный пользовательский пресет"
              >
                <Trash2 size={13} />
              </button>
            )}

            <div className="h-6 w-px bg-slate-800 mx-1" />

            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-xl transition-colors"
              title="Закрыть окно батч-обработчика"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* ================================================================= */}
        {/* MAIN BODY: 2 COLUMNS (FILES LEFT, CHAIN & EXPORT RIGHT)           */}
        {/* ================================================================= */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* --------------------------------------------------------------- */}
          {/* LEFT COLUMN: FILES LIST (lg:col-span-5)                         */}
          {/* --------------------------------------------------------------- */}
          <div className="lg:col-span-5 border-r border-slate-800/80 bg-slate-950/60 flex flex-col overflow-hidden">
            {/* Left Header */}
            <div className="p-3.5 border-b border-slate-800/80 bg-slate-900/40 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FolderOpen size={16} className="text-cyan-400" />
                <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                  Список файлов ({files.length})
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleAddTestSamples}
                  className="px-2 py-1 bg-cyan-950/60 hover:bg-cyan-900/80 text-cyan-300 border border-cyan-800/60 rounded-lg text-[11px] font-semibold transition-all flex items-center gap-1 cursor-pointer"
                  title="Добавить тестовые образцы речи для быстрой демонстрации"
                >
                  <Wand2 size={12} />
                  <span>Тест-файлы</span>
                </button>
                {files.length > 0 && (
                  <button
                    onClick={handleClearAllFiles}
                    className="px-2 py-1 bg-slate-900 hover:bg-red-950/50 text-slate-400 hover:text-red-400 border border-slate-800 rounded-lg text-[11px] font-medium transition-all"
                  >
                    Очистить
                  </button>
                )}
              </div>
            </div>

            {/* Drop Zone */}
            <div className="p-3 border-b border-slate-800/60">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="audio/*,video/*,.wav,.mp3,.flac,.ogg,.aac,.m4a,.aiff,.mp4,.mkv,.webm,.mov"
                onChange={(e) => {
                  if (e.target.files) handleAddFiles(e.target.files);
                  e.target.value = '';
                }}
                className="hidden"
                id={fileDropZoneId}
              />
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files) handleAddFiles(e.dataTransfer.files);
                }}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-700/80 hover:border-cyan-500/80 bg-slate-900/40 hover:bg-cyan-950/20 rounded-xl p-3.5 flex flex-col items-center justify-center text-center cursor-pointer transition-all group"
              >
                <Upload size={22} className="text-slate-400 group-hover:text-cyan-400 mb-1.5 transition-colors" />
                <p className="text-xs font-semibold text-slate-200">
                  Перетащите файлы сюда или нажмите для выбора
                </p>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  WAV, MP3, FLAC, OGG, AAC, M4A, а также видео MP4 / MKV
                </p>
              </div>
            </div>

            {/* Files Scrollable List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
              {files.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
                  <div className="p-3 bg-slate-900 rounded-2xl mb-2 text-slate-600">
                    <FolderOpen size={32} />
                  </div>
                  <p className="text-xs font-medium text-slate-400">Файлы ещё не добавлены</p>
                  <p className="text-[11px] text-slate-600 max-w-xs mt-1">
                    Загрузите дорожки или нажмите кнопку «Тест-файлы», чтобы проверить цепочку.
                  </p>
                </div>
              ) : (
                files.map((file) => {
                  const isDone = file.status === 'completed';
                  const isError = file.status === 'error';
                  const inProgress = file.status === 'processing' || file.status === 'decoding' || file.status === 'encoding';

                  return (
                    <div
                      key={file.id}
                      className={`p-2.5 rounded-xl border transition-all ${
                        isDone
                          ? 'bg-emerald-950/20 border-emerald-500/30'
                          : isError
                          ? 'bg-red-950/20 border-red-500/30'
                          : inProgress
                          ? 'bg-cyan-950/20 border-cyan-500/40 shadow-sm shadow-cyan-500/10'
                          : 'bg-slate-900/60 border-slate-800'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-slate-200 truncate" title={file.name}>
                            {file.name}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400 mt-0.5 font-mono">
                            <span>{(file.sizeBytes / 1024 / 1024).toFixed(1)} МБ</span>
                            {file.durationSec && (
                              <>
                                <span>•</span>
                                <span>{file.durationSec.toFixed(1)} с</span>
                              </>
                            )}
                            {file.sampleRate && (
                              <>
                                <span>•</span>
                                <span>{(file.sampleRate / 1000).toFixed(0)} kHz</span>
                              </>
                            )}
                            {file.processingTimeMs && (
                              <span className="text-emerald-400 font-semibold">
                                ({file.processingTimeMs} ms)
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Status Icon */}
                        <div className="shrink-0 flex items-center gap-1.5">
                          {inProgress && <Loader2 size={14} className="text-cyan-400 animate-spin" />}
                          {isDone && <CheckCircle2 size={14} className="text-emerald-400" />}
                          {isError && <AlertCircle size={14} className="text-red-400" />}

                          <button
                            onClick={() => handleRemoveFile(file.id)}
                            disabled={isProcessing}
                            className="p-1 text-slate-500 hover:text-red-400 transition-colors disabled:opacity-30"
                            title="Удалить файл"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {/* Progress bar if processing */}
                      {inProgress && (
                        <div className="mt-2">
                          <div className="flex items-center justify-between text-[10px] text-cyan-300 font-mono mb-1">
                            <span>{file.statusMessage || 'Обработка...'}</span>
                            <span>{file.progress}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all duration-200"
                              style={{ width: `${file.progress}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Error text */}
                      {isError && (
                        <p className="mt-1.5 text-[10px] text-red-400 font-mono">
                          {file.errorMessage}
                        </p>
                      )}

                      {/* Audio Comparison & Actions (Original vs Processed) */}
                      <div className="mt-2 pt-2 border-t border-slate-800/60 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          {file.originalBlobUrl && (
                            <button
                              onClick={() => handleTogglePlay(file.id, 'original')}
                              className={`px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 transition-all ${
                                playingFileId === file.id && playingTrackType === 'original'
                                  ? 'bg-amber-600 text-white'
                                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                              }`}
                              title="Прослушать оригинальный звук"
                            >
                              {playingFileId === file.id && playingTrackType === 'original' ? <Pause size={10} /> : <Play size={10} />}
                              <span>Оригинал</span>
                            </button>
                          )}

                          {file.processedBlobUrl && (
                            <button
                              onClick={() => handleTogglePlay(file.id, 'processed')}
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 transition-all ${
                                playingFileId === file.id && playingTrackType === 'processed'
                                  ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-500/30'
                                  : 'bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900 border border-emerald-700/50'
                              }`}
                              title="Прослушать результат после обработки"
                            >
                              {playingFileId === file.id && playingTrackType === 'processed' ? <Pause size={10} /> : <Play size={10} />}
                              <span>Мастер</span>
                            </button>
                          )}
                        </div>

                        {/* Download Single File */}
                        {file.processedBlob && file.processedFileName && (
                          <a
                            href={file.processedBlobUrl}
                            download={file.processedFileName}
                            className="px-2 py-0.5 bg-emerald-900/60 hover:bg-emerald-800 text-emerald-200 border border-emerald-600/40 rounded text-[10px] font-semibold flex items-center gap-1 transition-colors"
                            title="Скачать обработанный файл"
                          >
                            <Download size={10} />
                            <span>Скачать</span>
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Left Footer Summary */}
            <div className="p-3 border-t border-slate-800/80 bg-slate-900/60 flex items-center justify-between text-xs text-slate-400 font-mono">
              <span>Готово: {completedCount} из {files.length}</span>
              {completedCount > 0 && (
                <button
                  onClick={handleDownloadAllZip}
                  disabled={isZipping}
                  className="px-2.5 py-1 bg-gradient-to-r from-emerald-800 to-teal-800 hover:from-emerald-700 hover:to-teal-700 text-white rounded-lg font-semibold flex items-center gap-1.5 transition-all shadow-md shadow-emerald-950/40 text-xs cursor-pointer"
                >
                  {isZipping ? <Loader2 size={12} className="animate-spin" /> : <FileArchive size={12} />}
                  <span>Скачать все (ZIP)</span>
                </button>
              )}
            </div>
          </div>

          {/* --------------------------------------------------------------- */}
          {/* RIGHT COLUMN: PROCESSING CHAIN & EXPORT SETTINGS (lg:col-span-7) */}
          {/* --------------------------------------------------------------- */}
          <div className="lg:col-span-7 flex flex-col overflow-hidden bg-[#0c101d]">
            {/* Section 1 Header: Processing Chain */}
            <div className="p-3.5 border-b border-slate-800/80 bg-slate-900/40 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sliders size={16} className="text-emerald-400" />
                <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                  Цепочка обработки ({chain.filter(c => c.enabled).length}/{chain.length} активны)
                </span>
              </div>
              <button
                onClick={() => setShowAddEffectModal(true)}
                className="px-2.5 py-1 bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border border-emerald-600/50 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer shadow-sm shadow-emerald-950/50"
              >
                <Plus size={13} />
                <span>Добавить модуль</span>
              </button>
            </div>

            {/* Chain Items List ("строчечкой вот такая цепочка и кнопка настроить маленькая") */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-2">
              {chain.length === 0 ? (
                <div className="h-44 flex flex-col items-center justify-center text-center p-6 text-slate-500 border border-dashed border-slate-800 rounded-xl">
                  <Sliders size={28} className="text-slate-600 mb-2" />
                  <p className="text-xs font-medium text-slate-400">Цепочка обработки пуста</p>
                  <p className="text-[11px] text-slate-600 max-w-xs mt-1">
                    Добавьте эффекты через кнопку выше или выберите готовый пресет из выпадающего списка.
                  </p>
                </div>
              ) : (
                chain.map((item, index) => {
                  const typeLabel =
                    item.type === 'cpp_dsp' ? 'C++ DSP' : item.type === 'vst' ? 'VST3' : 'AI Нейросеть';
                  const badgeColor =
                    item.type === 'cpp_dsp'
                      ? 'bg-blue-950/80 text-blue-300 border-blue-700/50'
                      : item.type === 'vst'
                      ? 'bg-purple-950/80 text-purple-300 border-purple-700/50'
                      : 'bg-emerald-950/80 text-emerald-300 border-emerald-700/50';

                  return (
                    <div
                      key={item.id}
                      className={`px-3 py-2 rounded-xl border flex items-center justify-between gap-3 transition-all ${
                        item.enabled
                          ? 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
                          : 'bg-slate-950/40 border-slate-900 opacity-60'
                      }`}
                    >
                      {/* Left: Index & Type & Name */}
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-xs font-mono font-bold text-slate-500 w-5 text-center">
                          #{index + 1}
                        </span>

                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase font-bold ${badgeColor}`}>
                          {typeLabel}
                        </span>

                        <div className="min-w-0">
                          <p className={`text-xs font-bold truncate ${item.enabled ? 'text-slate-200' : 'text-slate-400 line-through'}`}>
                            {item.name}
                          </p>
                          <p className="text-[10px] text-slate-400 truncate">
                            {item.badge || item.category}
                          </p>
                        </div>
                      </div>

                      {/* Right: Actions (Bypass, Reorder, Настроить, Delete) */}
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Bypass Button */}
                        <button
                          onClick={() => handleToggleBypass(index)}
                          className={`px-2 py-1 rounded-lg text-[10px] font-mono font-bold transition-all ${
                            item.enabled
                              ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/50'
                              : 'bg-slate-800 text-slate-400 border border-slate-700'
                          }`}
                          title={item.enabled ? 'Отключить (Bypass)' : 'Включить эффект'}
                        >
                          {item.enabled ? 'ВКЛ' : 'ВЫКЛ'}
                        </button>

                        {/* Move Up / Down */}
                        <button
                          onClick={() => handleMoveUp(index)}
                          disabled={index === 0}
                          className="p-1 text-slate-500 hover:text-slate-200 disabled:opacity-20 transition-colors"
                          title="Переместить выше"
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          onClick={() => handleMoveDown(index)}
                          disabled={index === chain.length - 1}
                          className="p-1 text-slate-500 hover:text-slate-200 disabled:opacity-20 transition-colors"
                          title="Переместить ниже"
                        >
                          <ArrowDown size={13} />
                        </button>

                        {/* "Кнопка настроить маленькая" as requested */}
                        <button
                          onClick={() => handleOpenSettings(index)}
                          className="px-2.5 py-1 bg-cyan-950/80 hover:bg-cyan-900 text-cyan-300 hover:text-white border border-cyan-700/60 rounded-lg text-xs font-semibold transition-all flex items-center gap-1 cursor-pointer"
                          title="Открыть параметры эффекта"
                        >
                          <Settings2 size={12} />
                          <span>Настроить</span>
                        </button>

                        {/* Delete button */}
                        <button
                          onClick={() => handleRemoveEffect(index)}
                          className="p-1.5 text-slate-500 hover:text-red-400 transition-colors"
                          title="Удалить из цепочки"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Section 2: Format & Export Settings ("И куда сохранить и в каком формате") */}
            <div className="p-3.5 border-t border-slate-800/80 bg-slate-900/50 space-y-3">
              <div className="flex items-center gap-2">
                <Download size={14} className="text-cyan-400" />
                <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                  Формат и параметры сохранения
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {/* Format */}
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5">
                  <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                    Формат аудио
                  </label>
                  <select
                    value={exportSettings.format}
                    onChange={(e) => setExportSettings(prev => ({ ...prev, format: e.target.value as BatchAudioFormat }))}
                    className="w-full bg-slate-900 text-xs font-semibold text-emerald-300 border border-slate-700/70 rounded-lg px-2 py-1 focus:outline-none cursor-pointer"
                  >
                    <option value="wav_24">WAV (24-bit PCM Broadcast)</option>
                    <option value="wav_16">WAV (16-bit PCM CD)</option>
                    <option value="wav_32">WAV (32-bit Float Hi-Res)</option>
                    <option value="mp3_320">MP3 (320 kbps)</option>
                    <option value="flac">FLAC (Lossless)</option>
                    <option value="ogg_192">OGG Vorbis (192 kbps)</option>
                    <option value="aac_256">AAC / M4A (256 kbps)</option>
                  </select>
                </div>

                {/* Sample Rate */}
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5">
                  <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                    Частота дискретизации
                  </label>
                  <select
                    value={exportSettings.sampleRate}
                    onChange={(e) => setExportSettings(prev => ({
                      ...prev,
                      sampleRate: e.target.value === 'original' ? 'original' : Number(e.target.value) as any
                    }))}
                    className="w-full bg-slate-900 text-xs font-semibold text-cyan-300 border border-slate-700/70 rounded-lg px-2 py-1 focus:outline-none cursor-pointer"
                  >
                    <option value="48000">48 000 Гц (Кино/Дубляж)</option>
                    <option value="44100">44 100 Гц (CD Audio)</option>
                    <option value="96000">96 000 Гц (Hi-Res)</option>
                    <option value="original">Исходная из файла</option>
                  </select>
                </div>

                {/* Filename Suffix */}
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5">
                  <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                    Суффикс имени файла
                  </label>
                  <input
                    type="text"
                    value={exportSettings.filenameSuffix}
                    onChange={(e) => setExportSettings(prev => ({ ...prev, filenameSuffix: e.target.value }))}
                    placeholder="_processed"
                    className="w-full bg-slate-900 text-xs font-mono text-slate-200 border border-slate-700/70 rounded-lg px-2 py-1 focus:outline-none focus:border-cyan-500"
                  />
                </div>
              </div>

              {/* Loudness Normalization Switch */}
              <div className="flex flex-wrap items-center justify-between gap-2 p-2 bg-slate-950/60 border border-slate-800/80 rounded-xl text-xs">
                <label className="flex items-center gap-2 cursor-pointer select-none text-slate-300">
                  <input
                    type="checkbox"
                    checked={exportSettings.normalizeLoudness}
                    onChange={(e) => setExportSettings(prev => ({ ...prev, normalizeLoudness: e.target.checked }))}
                    className="accent-emerald-500 rounded"
                  />
                  <span>Финальная нормализация громкости (EBU R128 / ITU-R BS.1770)</span>
                </label>

                {exportSettings.normalizeLoudness && (
                  <div className="flex items-center gap-1.5 font-mono text-xs">
                    <span className="text-slate-400">Цель:</span>
                    <select
                      value={exportSettings.targetLufs}
                      onChange={(e) => setExportSettings(prev => ({ ...prev, targetLufs: Number(e.target.value) }))}
                      className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-emerald-400 font-bold focus:outline-none"
                    >
                      <option value={-14}>-14 LUFS (YouTube/Streaming)</option>
                      <option value={-16}>-16 LUFS (Podcast/Apple)</option>
                      <option value={-23}>-23 LUFS (EBU Broadcast TV)</option>
                      <option value={-24}>-24 LUFS (ATSC A/85 TV)</option>
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* Section 3: Main Action Button ("И кнопка обработать") */}
            <div className="p-4 border-t border-slate-800 bg-slate-900/90 flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="text-xs text-slate-400 font-mono">
                {isProcessing ? (
                  <span className="text-cyan-400 flex items-center gap-1.5">
                    <Loader2 size={13} className="animate-spin" />
                    Обработка {globalProgress.completed + 1} из {globalProgress.total}: {globalProgress.currentName}
                  </span>
                ) : (
                  <span>К обработке: {files.length} файлов • Эффектов: {chain.filter(c => c.enabled).length}</span>
                )}
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                {isProcessing && (
                  <button
                    onClick={() => processor.cancel()}
                    className="px-3 py-2 bg-red-950/80 hover:bg-red-900 text-red-300 border border-red-700/60 rounded-xl text-xs font-bold transition-all"
                  >
                    Остановить
                  </button>
                )}

                <button
                  onClick={handleStartProcessing}
                  disabled={files.length === 0 || isProcessing || chain.filter(c => c.enabled).length === 0}
                  className="flex-1 sm:flex-initial px-5 py-2.5 bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      <span>Идет пакетная обработка...</span>
                    </>
                  ) : (
                    <>
                      <Play size={15} />
                      <span>Обработать ({files.length} файлов)</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* =================================================================== */}
      {/* EFFECT SETTINGS MODAL ("Окошечко с настройками")                    */}
      {/* =================================================================== */}
      {editingEffect && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fadeIn">
          <div className="bg-[#0e1424] border border-cyan-700/60 rounded-2xl w-full max-w-xl shadow-2xl shadow-cyan-950/70 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="bg-slate-900 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings2 size={18} className="text-cyan-400" />
                <h3 className="text-sm font-bold text-slate-100">
                  Настройки: {editingEffect.name}
                </h3>
              </div>
              <button
                onClick={() => setEditingEffectIndex(null)}
                className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg"
              >
                <X size={16} />
              </button>
            </div>

            {/* Sliders and Knobs */}
            <div className="p-4 overflow-y-auto max-h-[60vh] space-y-4">
              {editingDef ? (
                // Render controls defined in NativeEffectDefinition
                editingDef.params.map(param => {
                  const val = tempParams[param.key] !== undefined ? tempParams[param.key] : param.default;

                  return (
                    <div key={param.id} className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-3">
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="font-semibold text-slate-300">{param.name}</span>
                        <span className="font-mono font-bold text-emerald-400">
                          {typeof val === 'number' ? val.toFixed(param.step < 1 ? 1 : 0) : String(val)} {param.unit}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={param.min}
                        max={param.max}
                        step={param.step}
                        value={Number(val)}
                        onChange={(e) => {
                          const num = Number(e.target.value);
                          setTempParams(prev => ({ ...prev, [param.key]: num }));
                        }}
                        className="w-full accent-emerald-500 cursor-pointer"
                      />
                      <div className="flex justify-between text-[10px] text-slate-500 font-mono mt-1">
                        <span>{param.min} {param.unit}</span>
                        <span>По умолч: {param.default}</span>
                        <span>{param.max} {param.unit}</span>
                      </div>
                    </div>
                  );
                })
              ) : (
                // Fallback for VST / Neural parameters
                Object.keys(tempParams).map(key => {
                  const val = tempParams[key];
                  const isNum = typeof val === 'number';

                  return (
                    <div key={key} className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-3">
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="font-semibold text-slate-300 uppercase tracking-wider">{key}</span>
                        <span className="font-mono font-bold text-emerald-400">
                          {isNum ? Number(val).toFixed(1) : String(val)}
                        </span>
                      </div>
                      {isNum ? (
                        <input
                          type="range"
                          min={key.includes('thresh') ? -60 : key.includes('ratio') ? 1 : key.includes('freq') ? 20 : 0}
                          max={key.includes('thresh') ? 0 : key.includes('ratio') ? 20 : key.includes('freq') ? 20000 : 100}
                          step={key.includes('freq') ? 10 : 0.5}
                          value={Number(val)}
                          onChange={(e) => setTempParams(prev => ({ ...prev, [key]: Number(e.target.value) }))}
                          className="w-full accent-emerald-500 cursor-pointer"
                        />
                      ) : (
                        <input
                          type="text"
                          value={String(val)}
                          onChange={(e) => setTempParams(prev => ({ ...prev, [key]: e.target.value }))}
                          className="w-full bg-slate-950 border border-slate-800 text-xs px-2 py-1 rounded text-slate-200"
                        />
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="bg-slate-900 px-4 py-3 border-t border-slate-800 flex items-center justify-end gap-2">
              <button
                onClick={() => setEditingEffectIndex(null)}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-medium"
              >
                Отмена
              </button>
              <button
                onClick={handleSaveSettings}
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-emerald-950/40"
              >
                Сохранить настройки
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* ADD EFFECT CATALOG MODAL                                            */}
      {/* =================================================================== */}
      {showAddEffectModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fadeIn">
          <div className="bg-[#0e1424] border border-emerald-700/60 rounded-2xl w-full max-w-2xl shadow-2xl shadow-emerald-950/70 flex flex-col overflow-hidden max-h-[80vh]">
            {/* Header */}
            <div className="bg-slate-900 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Plus size={18} className="text-emerald-400" />
                <h3 className="text-sm font-bold text-slate-100">
                  Добавить обработчик в цепочку
                </h3>
              </div>
              <button
                onClick={() => setShowAddEffectModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg"
              >
                <X size={16} />
              </button>
            </div>

            {/* Tabs (C++ DSP, VST3, Neural AI) */}
            <div className="flex border-b border-slate-800 bg-slate-950/80 px-4 py-2 gap-2">
              <button
                onClick={() => setAddEffectTab('cpp_dsp')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  addEffectTab === 'cpp_dsp'
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-900/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Нативные C++ DSP ({NATIVE_DSP_CATALOG.length})
              </button>
              <button
                onClick={() => setAddEffectTab('vst')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  addEffectTab === 'vst'
                    ? 'bg-purple-600 text-white shadow-md shadow-purple-900/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Студийные VST3 ({BUILT_IN_VST_LIBRARY.length})
              </button>
              <button
                onClick={() => setAddEffectTab('neural')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  addEffectTab === 'neural'
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Нейросетевые AI (5)
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {addEffectTab === 'cpp_dsp' && (
                NATIVE_DSP_CATALOG.map(def => {
                  const initialParams: Record<string, any> = {};
                  def.params.forEach(p => { initialParams[p.key] = p.default; });

                  return (
                    <div
                      key={def.typeId}
                      className="p-3 bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-blue-500/50 rounded-xl flex items-center justify-between gap-3 transition-all group"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="text-xs font-bold text-slate-100 group-hover:text-blue-300 transition-colors">
                            {def.name}
                          </h4>
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-blue-950/80 text-blue-300 border border-blue-800/40">
                            {def.badge || def.categoryLabel}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                          {def.description}
                        </p>
                      </div>
                      <button
                        onClick={() => handleAddEffectFromCatalog({
                          id: `fx-${def.typeId}-${Date.now()}`,
                          type: 'cpp_dsp',
                          effectId: def.typeId,
                          name: def.name,
                          category: def.categoryLabel,
                          badge: def.badge,
                          color: def.color,
                          enabled: true,
                          params: initialParams
                        })}
                        className="px-3 py-1.5 bg-blue-600/80 hover:bg-blue-600 text-white rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-1"
                      >
                        <Plus size={13} />
                        <span>Добавить</span>
                      </button>
                    </div>
                  );
                })
              )}

              {addEffectTab === 'vst' && (
                BUILT_IN_VST_LIBRARY.map(vst => (
                  <div
                    key={vst.id}
                    className="p-3 bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-purple-500/50 rounded-xl flex items-center justify-between gap-3 transition-all group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="text-xs font-bold text-slate-100 group-hover:text-purple-300 transition-colors">
                          {vst.name}
                        </h4>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-purple-950/80 text-purple-300 border border-purple-800/40">
                          {vst.vendor} • {vst.category}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                        {vst.description}
                      </p>
                    </div>
                    <button
                      onClick={() => handleAddEffectFromCatalog({
                        id: `vst-${vst.id}-${Date.now()}`,
                        type: 'vst',
                        effectId: vst.id,
                        name: vst.name,
                        category: vst.category,
                        badge: vst.vendor,
                        color: vst.color,
                        enabled: true,
                        params: (vst.parameters || []).reduce((acc: any, p) => ({ ...acc, [p.id]: p.defaultValue }), {})
                      })}
                      className="px-3 py-1.5 bg-purple-600/80 hover:bg-purple-600 text-white rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-1"
                    >
                      <Plus size={13} />
                      <span>Добавить</span>
                    </button>
                  </div>
                ))
              )}

              {addEffectTab === 'neural' && (
                [
                  { id: 'deepfilternet3', name: 'DeepFilterNet 3 (AI Denoise)', desc: 'Глубокое подавление фонового шума, вентиляторов и климата через ONNX.', badge: 'Noise AI', params: { intensityPercent: 85, lowCutHz: 80 } },
                  { id: 'spectral_dereverb', name: 'AI Spectral De-Reverb', desc: 'Устранение комнатного эха, реверберации и гулкости помещения.', badge: 'De-Echo', params: { reductionDb: -9, clarityPercent: 75 } },
                  { id: 'voicefixer', name: 'VoiceFixer (Air Band Restoration)', desc: 'Восстановление утерянных высоких гармоник речи и сатурация.', badge: 'Voice Fix', params: { airBandBoostDb: 2.0, declipSensitivity: 0.5, warmthSaturation: 0.3 } },
                  { id: 'uvr_mdx_voc_ft', name: 'UVR-MDX-NET Vocal Isolation', desc: 'Спектральное отделение речи от фоновой музыки и шумов.', badge: 'Stem Isolation', params: { stemMode: 'vocals' } },
                  { id: 'rnnoise', name: 'RNNoise Spectral Cleanup', desc: 'Легковесное рекуррентное подавление стационарного шума.', badge: 'RNNoise', params: { intensityPercent: 75 } }
                ].map(ai => (
                  <div
                    key={ai.id}
                    className="p-3 bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-emerald-500/50 rounded-xl flex items-center justify-between gap-3 transition-all group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="text-xs font-bold text-slate-100 group-hover:text-emerald-300 transition-colors">
                          {ai.name}
                        </h4>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-800/40">
                          {ai.badge}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                        {ai.desc}
                      </p>
                    </div>
                    <button
                      onClick={() => handleAddEffectFromCatalog({
                        id: `neural-${ai.id}-${Date.now()}`,
                        type: 'neural',
                        effectId: ai.id,
                        name: ai.name,
                        category: 'Нейросеть',
                        badge: ai.badge,
                        color: '#10b981',
                        enabled: true,
                        params: ai.params
                      })}
                      className="px-3 py-1.5 bg-emerald-600/80 hover:bg-emerald-600 text-white rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-1"
                    >
                      <Plus size={13} />
                      <span>Добавить</span>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* SAVE PRESET MODAL                                                   */}
      {/* =================================================================== */}
      {showSavePresetModal && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fadeIn">
          <div className="bg-[#0e1424] border border-slate-700 rounded-2xl w-full max-w-md p-5 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Save size={16} className="text-emerald-400" />
                Сохранить пресет цепочки
              </h3>
              <button onClick={() => setShowSavePresetModal(false)} className="text-slate-400 hover:text-slate-200">
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Название пресета
                </label>
                <input
                  type="text"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="Например: Мой мастеринг для озвучки"
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Описание (необязательно)
                </label>
                <textarea
                  value={newPresetDesc}
                  onChange={(e) => setNewPresetDesc(e.target.value)}
                  placeholder="Параметры компрессии и эквализации..."
                  rows={2}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowSavePresetModal(false)}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-medium"
              >
                Отмена
              </button>
              <button
                onClick={handleSavePreset}
                disabled={!newPresetName.trim()}
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold disabled:opacity-40"
              >
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
