import React, { useState } from 'react';
import {
  globalAudioAIEngine,
  SpeechSegment,
  SubtitleLine,
  AlignedSpeechPhrase,
  AI_MODELS_CATALOG
} from '../services/AudioAIEngine';
import { TrackState } from '../audio/dawEngine';
import { formatSMPTE } from '../utils/waveformUtils';
import {
  BrainCircuit,
  Activity,
  FileText,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Download,
  Sparkles,
  Play,
  RotateCcw,
  Zap,
  Sliders,
  Layers,
  Cpu
} from 'lucide-react';

interface DubbingAIStudioProps {
  tracks: TrackState[];
  currentTimeSec: number;
  onSeek: (timeSec: number) => void;
}

const SAMPLE_SRT_SCRIPT = `1
00:00:01,200 --> 00:00:03,800
Привет всем! Это тестовая озвучка для проверки дубляжа.

2
00:00:04,500 --> 00:00:07,100
Все нейросети работают прямо в браузере без облачных серверов.

3
00:00:07,800 --> 00:00:10,500
Silero VAD детектирует паузы, а Whisper транскрибирует текст.

4
00:00:11,000 --> 00:00:13,600
Смарт-выравнивание синхронизирует реплики с оригиналом.`;

export const DubbingAIStudio: React.FC<DubbingAIStudioProps> = ({ tracks, currentTimeSec, onSeek }) => {
  const [selectedTrackId, setSelectedTrackId] = useState<number>(3); // Default: Vocal Track (id: 3)
  const [isProcessingVad, setIsProcessingVad] = useState<boolean>(false);
  const [vadThreshold, setVadThreshold] = useState<number>(0.5);
  const [speechSegments, setSpeechSegments] = useState<SpeechSegment[]>([]);

  const [scriptContent, setScriptContent] = useState<string>(SAMPLE_SRT_SCRIPT);
  const [parsedSubtitles, setParsedSubtitles] = useState<SubtitleLine[]>([]);
  const [alignedPhrases, setAlignedPhrases] = useState<AlignedSpeechPhrase[]>([]);

  // Запуск Silero VAD детекции речи
  const handleRunVAD = async () => {
    const targetTrack = tracks.find((t) => t.id === selectedTrackId);
    if (!targetTrack || targetTrack.clips.length === 0) {
      alert('На выбранной дорожке нет аудиоклипов для анализа.');
      return;
    }

    setIsProcessingVad(true);

    try {
      // Берем буфер первого клипа на дорожке
      const clip = targetTrack.clips[0];
      const audioBuffer = clip.buffer;

      const segments = await globalAudioAIEngine.processVAD(audioBuffer, 48000, {
        threshold: vadThreshold,
        minSpeechDurationMs: 200,
        minSilenceDurationMs: 300
      });

      setSpeechSegments(segments);
    } catch (err) {
      console.error('[DubbingAIStudio] Ошибка VAD:', err);
    } finally {
      setIsProcessingVad(false);
    }
  };

  // Запуск парсинга и смарт-выравнивания
  const handleRunAlignment = () => {
    const subs = globalAudioAIEngine.parseSubtitles(scriptContent);
    setParsedSubtitles(subs);

    const aligned = globalAudioAIEngine.alignSpeechWithScript(subs, speechSegments);
    setAlignedPhrases(aligned);
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900/90 border border-emerald-500/30 p-5 rounded-2xl flex flex-wrap items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400">
            <BrainCircuit size={22} />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              Клиентский AI Пайплайн Дубляжа (ONNX Runtime Web)
              <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                WASM / WebGPU Local
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Автономная сегментация речи через Silero VAD, транскрибация Whisper и смарт-выравнивание со сценарием (SRT/ASS).
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
          <span className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg flex items-center gap-1.5 text-emerald-400">
            <Zap size={14} /> 100% On-Device
          </span>
          <span className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg flex items-center gap-1.5 text-cyan-400">
            <Cpu size={14} /> No API Keys / 0$
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN: VAD & Track Settings */}
        <div className="lg:col-span-5 space-y-6">
          {/* 1. Voice Activity Detection (Silero VAD) Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                <Activity size={15} className="text-emerald-400" />
                1. Silero VAD: Сегментация речи
              </h3>
              <span className="text-[10px] font-mono text-slate-400">16 kHz Float32</span>
            </div>

            {/* Track Selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Анализируемая дорожка:</label>
              <select
                value={selectedTrackId}
                onChange={(e) => setSelectedTrackId(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
              >
                {tracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.clips.length} клипов)
                  </option>
                ))}
              </select>
            </div>

            {/* Threshold Slider */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-slate-400">Порог речи (Threshold):</span>
                <span className="text-emerald-400 font-bold">{vadThreshold.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0.1"
                max="0.9"
                step="0.05"
                value={vadThreshold}
                onChange={(e) => setVadThreshold(parseFloat(e.target.value))}
                className="w-full accent-emerald-500 h-1.5 bg-slate-950 rounded-lg cursor-pointer"
              />
            </div>

            {/* Run Button */}
            <button
              onClick={handleRunVAD}
              disabled={isProcessingVad}
              className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all shadow-md shadow-emerald-950/40 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <Sparkles size={15} />
              {isProcessingVad ? 'Инференс Silero VAD (WASM)...' : 'Выполнить VAD сегментацию'}
            </button>

            {/* Detected Segments List */}
            {speechSegments.length > 0 && (
              <div className="space-y-2 pt-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                  <span>Обнаружено фраз: {speechSegments.length}</span>
                  <span>Таймкоды (Start - End)</span>
                </div>

                <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin scrollbar-thumb-slate-800">
                  {speechSegments.map((seg) => (
                    <div
                      key={seg.id}
                      onClick={() => onSeek(seg.startSec)}
                      className="p-2 bg-slate-950/80 hover:bg-slate-800/60 border border-slate-800/80 hover:border-emerald-500/50 rounded-lg flex items-center justify-between text-xs font-mono cursor-pointer transition-all"
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-[10px] font-bold">
                          {seg.id}
                        </span>
                        <span className="text-slate-200">
                          {formatSMPTE(seg.startSec)} → {formatSMPTE(seg.endSec)}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] text-emerald-400 font-bold block">
                          {seg.durationSec.toFixed(2)}s
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ONNX Model Catalog Info Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <Download size={14} className="text-emerald-400" />
              Открытые ONNX Модели (Веса)
            </h3>

            <div className="space-y-2 text-xs">
              {Object.entries(AI_MODELS_CATALOG).map(([key, model]) => (
                <div key={key} className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-200">{model.name}</span>
                    <span className="text-[10px] font-mono text-emerald-400 px-1.5 py-0.5 bg-emerald-500/10 rounded">
                      {model.sizeMb} MB
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">{model.description}</p>
                  <a
                    href={model.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] font-mono text-cyan-400 hover:underline flex items-center gap-1 pt-1"
                  >
                    HuggingFace / GitHub Репозиторий →
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Script Editor & Smart Alignment Results */}
        <div className="lg:col-span-7 space-y-6">
          {/* 2. Subtitle / Script Input */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                <FileText size={15} className="text-cyan-400" />
                2. Сценарий / Субтитры для дубляжа (SRT / ASS)
              </h3>
              <button
                onClick={handleRunAlignment}
                className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold rounded-lg transition-all shadow-md shadow-cyan-950/40 flex items-center gap-1.5 cursor-pointer"
              >
                <Sliders size={13} />
                Выполнить смарт-выравнивание
              </button>
            </div>

            <textarea
              value={scriptContent}
              onChange={(e) => setScriptContent(e.target.value)}
              rows={7}
              placeholder="Вставьте текст субтитров в формате SRT или ASS..."
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs text-slate-200 font-mono focus:outline-none focus:border-cyan-500 resize-none leading-relaxed"
            />
          </div>

          {/* 3. Smart Alignment Results Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center justify-between">
              <span className="flex items-center gap-2">
                <CheckCircle2 size={15} className="text-emerald-400" />
                3. Результаты смарт-выравнивания фраз
              </span>
              {alignedPhrases.length > 0 && (
                <span className="text-[10px] font-mono text-slate-400">
                  Сопоставлено: {alignedPhrases.length} реплик
                </span>
              )}
            </h3>

            {alignedPhrases.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500 font-mono">
                Запустите VAD сегментацию и нажмите кнопку «Выполнить смарт-выравнивание» для расчета тайм-дрейфа и схожести текста.
              </div>
            ) : (
              <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-800">
                {alignedPhrases.map((phrase) => {
                  const isMatched = phrase.status === 'matched';
                  const isDrifted = phrase.status === 'drifted';

                  return (
                    <div
                      key={phrase.lineIndex}
                      onClick={() => onSeek(phrase.actualStartSec || phrase.expectedStartSec)}
                      className={`p-3 rounded-lg border text-xs font-mono transition-all cursor-pointer ${
                        isMatched
                          ? 'bg-slate-950/90 border-slate-800 hover:border-emerald-500/60'
                          : isDrifted
                          ? 'bg-amber-950/20 border-amber-500/40 hover:border-amber-500'
                          : 'bg-rose-950/20 border-rose-500/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-bold text-[10px]">
                            #{phrase.lineIndex}
                          </span>
                          <span className="text-slate-400 text-[11px]">
                            Ожидание: {formatSMPTE(phrase.expectedStartSec)}
                          </span>
                          {phrase.actualStartSec > 0 && (
                            <span className="text-emerald-400 text-[11px]">
                              Факт: {formatSMPTE(phrase.actualStartSec)}
                            </span>
                          )}
                        </div>

                        {/* Status Badge */}
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-1 ${
                              isMatched
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                                : isDrifted
                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                                : 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                            }`}
                          >
                            {isMatched && <CheckCircle2 size={11} />}
                            {isDrifted && <AlertTriangle size={11} />}
                            {phrase.status === 'missing' && <XCircle size={11} />}
                            {isMatched ? 'Синхронно' : isDrifted ? `Дрейф ${phrase.timeDriftSec.toFixed(2)}s` : 'Не найдено'}
                          </span>
                        </div>
                      </div>

                      {/* Script text & Recognized text comparison */}
                      <div className="text-slate-200 text-xs font-sans font-medium">
                        «{phrase.scriptText}»
                      </div>
                      {phrase.recognizedText && (
                        <div className="text-[11px] text-slate-400 font-sans mt-0.5">
                          Распознано: <span className="text-emerald-300">{phrase.recognizedText}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
