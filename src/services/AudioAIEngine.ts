/**
 * ============================================================================
 * AUDIO AI ENGINE (Autonomous On-Device Neural Pipeline for Dubbing & Speech)
 * ============================================================================
 * Клиентский пайплайн детекции речи и сопоставления сценариев:
 * 1. Silero VAD (ONNX Runtime Web / C++ DSP Energy Analyzer) - детекция голоса и пауз.
 * 2. C++ Fast Levenshtein String Similarity - лексическое сравнение реплик.
 * 3. Smart Subtitle Alignment - сопоставление распознанной речи со сценарием (SRT/ASS).
 * ============================================================================
 */

import * as ort from 'onnxruntime-web';
import { globalNativeDAWBridge } from './NativeDAWBridge';

// ============================================================================
// 1. ИНТЕРФЕЙСЫ И ТИПЫ ДАННЫХ
// ============================================================================

export interface SpeechSegment {
  id: number;
  startSample: number;
  endSample: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  confidence: number;
}

export interface TranscriptionSegment {
  id: number;
  startSec: number;
  endSec: number;
  text: string;
  confidence: number;
}

export interface SubtitleLine {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
}

export interface AlignedSpeechPhrase {
  lineIndex: number;
  scriptText: string;
  recognizedText: string;
  expectedStartSec: number;
  expectedEndSec: number;
  actualStartSec: number;
  actualEndSec: number;
  timeDriftSec: number;
  similarityScore: number; // 0.0 .. 1.0 (вычисляется в C++ через FastLevenshtein)
  status: 'matched' | 'drifted' | 'missing' | 'unexpected';
}

export interface VADConfig {
  sampleRate: 16000;
  threshold: number; // Порог вероятности речи (0.5 по умолчанию)
  minSpeechDurationMs: number; // Мин. длительность фразы (250 мс)
  minSilenceDurationMs: number; // Мин. тишина для разделения фраз (350 мс)
  speechPadMs: number; // Буферизация границ (100 мс)
}

export interface ModelDownloadInfo {
  name: string;
  sizeMb: number;
  url: string;
  description: string;
}

// Открытые официальные ссылки на веса моделей в HuggingFace / GitHub
export const AI_MODELS_CATALOG: Record<string, ModelDownloadInfo> = {
  silero_vad: {
    name: 'Silero VAD v5 (ONNX)',
    sizeMb: 1.8,
    url: 'https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx',
    description: 'Легковесная нейросеть детекции голосовой активности.'
  },
  whisper_tiny_encoder: {
    name: 'Whisper Tiny Encoder (ONNX INT8)',
    sizeMb: 24.5,
    url: 'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/onnx/encoder_model_quantized.onnx',
    description: 'Квантованная модель акустического кодировщика Whisper для браузеров.'
  },
  whisper_tiny_decoder: {
    name: 'Whisper Tiny Decoder (ONNX INT8)',
    sizeMb: 48.0,
    url: 'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/onnx/decoder_model_merged_quantized.onnx',
    description: 'Языковой декодер для транскрибации текста и генерации таймкодов.'
  }
};

// ============================================================================
// 2. СЕРВИСНЫЙ КЛАСС AUDIO AI ENGINE
// ============================================================================

export class AudioAIEngine {
  private vadSession: ort.InferenceSession | null = null;
  private isWasmConfigured: boolean = false;

  private vadConfig: VADConfig = {
    sampleRate: 16000,
    threshold: 0.5,
    minSpeechDurationMs: 250,
    minSilenceDurationMs: 350,
    speechPadMs: 100
  };

  constructor() {
    this.configureOrtEnvironment();
  }

  /**
   * Настройка ONNX Runtime Web окружения
   */
  private configureOrtEnvironment() {
    if (this.isWasmConfigured) return;

    try {
      ort.env.wasm.numThreads = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
      ort.env.wasm.simd = true;
      ort.env.wasm.proxy = false;
      this.isWasmConfigured = true;
    } catch (e) {
      console.warn('[AudioAIEngine] Предупреждение настройки ONNX Web WASM:', e);
    }
  }

  /**
   * Загрузка и инициализация модели Silero VAD
   */
  public async loadSileroVAD(customModelPathOrUrl?: string): Promise<boolean> {
    this.configureOrtEnvironment();

    const modelUrl = customModelPathOrUrl || AI_MODELS_CATALOG.silero_vad.url;

    try {
      const sessionOptions: ort.InferenceSession.SessionOptions = {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      };

      this.vadSession = await ort.InferenceSession.create(modelUrl, sessionOptions);
      console.log('[AudioAIEngine] Silero VAD успешно загружен в память.');
      return true;
    } catch (err) {
      console.warn('[AudioAIEngine] ONNX сеть недоступна. Используется C++ SIMD128 Speech Energy VAD детектор:', err);
      return false;
    }
  }

  /**
   * Потоковая детекция активности голоса (Voice Activity Detection)
   * Все математические расчеты формант, энергии и ZCR выполняются в C++ ядре.
   */
  public async processVAD(
    audioBuffer: Float32Array,
    inputSampleRate: number = 48000,
    configPartial?: Partial<VADConfig>
  ): Promise<SpeechSegment[]> {
    const config = { ...this.vadConfig, ...configPartial };

    if (!audioBuffer || audioBuffer.length === 0) {
      return [];
    }

    // Ресэмплинг выполняется через C++ модуль
    const audio16k = inputSampleRate === 16000
      ? audioBuffer
      : this.resampleAudio(audioBuffer, inputSampleRate, 16000);

    const windowSize = 512;
    const totalSamples = audio16k.length;

    if (totalSamples < windowSize) {
      return [];
    }

    const minSpeechSamples = (config.minSpeechDurationMs * 16000) / 1000;
    const minSilenceSamples = (config.minSilenceDurationMs * 16000) / 1000;
    const speechPadSamples = (config.speechPadMs * 16000) / 1000;

    const segments: SpeechSegment[] = [];
    let isSpeaking = false;
    let speechStartSample = 0;
    let silenceStartSample = 0;
    let segmentConfidenceSum = 0;
    let segmentChunkCount = 0;

    let hState = new Float32Array(2 * 1 * 64).fill(0);
    let cState = new Float32Array(2 * 1 * 64).fill(0);
    const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(16000)]), [1]);

    const numChunks = Math.floor(totalSamples / windowSize);

    for (let i = 0; i < numChunks; i++) {
      const chunkOffset = i * windowSize;
      const chunk = audio16k.subarray(chunkOffset, chunkOffset + windowSize);

      let speechProb = 0.0;

      if (this.vadSession) {
        try {
          const inputTensor = new ort.Tensor('float32', chunk, [1, windowSize]);
          const hTensor = new ort.Tensor('float32', hState, [2, 1, 64]);
          const cTensor = new ort.Tensor('float32', cState, [2, 1, 64]);

          const feeds: Record<string, ort.Tensor> = {
            input: inputTensor,
            sr: srTensor,
            h: hTensor,
            c: cTensor
          };

          const results = await this.vadSession.run(feeds);
          const outputTensor = results['output'] || Object.values(results)[0];
          speechProb = outputTensor.data[0] as number;

          if (results['hn']) hState = new Float32Array(results['hn'].data as ArrayLike<number>);
          if (results['cn']) cState = new Float32Array(results['cn'].data as ArrayLike<number>);
        } catch (e) {
          speechProb = this.calculateEnergyVoiceProbability(chunk);
        }
      } else {
        // Расчет энергии и вероятности голоса ИСКЛЮЧИТЕЛЬНО на C++
        speechProb = this.calculateEnergyVoiceProbability(chunk);
      }

      const currentSample = chunkOffset;

      if (speechProb >= config.threshold) {
        if (!isSpeaking) {
          isSpeaking = true;
          speechStartSample = Math.max(0, currentSample - speechPadSamples);
          segmentConfidenceSum = 0;
          segmentChunkCount = 0;
        }
        silenceStartSample = 0;
        segmentConfidenceSum += speechProb;
        segmentChunkCount++;
      } else {
        if (isSpeaking) {
          if (silenceStartSample === 0) {
            silenceStartSample = currentSample;
          }

          if (currentSample - silenceStartSample >= minSilenceSamples) {
            const speechEndSample = Math.min(totalSamples, silenceStartSample + speechPadSamples);
            const durationSamples = speechEndSample - speechStartSample;

            if (durationSamples >= minSpeechSamples) {
              const avgConf = segmentChunkCount > 0 ? segmentConfidenceSum / segmentChunkCount : 0.85;
              const startSec = speechStartSample / 16000;
              const endSec = speechEndSample / 16000;

              segments.push({
                id: segments.length + 1,
                startSample: Math.floor((speechStartSample / 16000) * inputSampleRate),
                endSample: Math.floor((speechEndSample / 16000) * inputSampleRate),
                startSec,
                endSec,
                durationSec: endSec - startSec,
                confidence: Math.min(1.0, Math.max(0.0, avgConf))
              });
            }

            isSpeaking = false;
            silenceStartSample = 0;
            segmentConfidenceSum = 0;
            segmentChunkCount = 0;
          }
        }
      }
    }

    if (isSpeaking) {
      const speechEndSample = totalSamples;
      const durationSamples = speechEndSample - speechStartSample;
      if (durationSamples >= minSpeechSamples) {
        const avgConf = segmentChunkCount > 0 ? segmentConfidenceSum / segmentChunkCount : 0.85;
        const startSec = speechStartSample / 16000;
        const endSec = speechEndSample / 16000;
        segments.push({
          id: segments.length + 1,
          startSample: Math.floor((speechStartSample / 16000) * inputSampleRate),
          endSample: Math.floor((speechEndSample / 16000) * inputSampleRate),
          startSec,
          endSec,
          durationSec: endSec - startSec,
          confidence: Math.min(1.0, Math.max(0.0, avgConf))
        });
      }
    }

    return segments;
  }

  /**
   * Вызов C++ SIMD128 детектора спектральной энергии и ZCR (SpeechEnergyDetector)
   * Полностью исключает математические расчеты на JS.
   */
  private calculateEnergyVoiceProbability(chunk: Float32Array): number {
    const stats = globalNativeDAWBridge.calculateFrameEnergyStats(chunk);
    return stats.voiceProbability;
  }

  /**
   * C++ Catmull-Rom ресэмплинг PCM буфера
   */
  public resampleAudio(sourceBuffer: Float32Array, sourceSr: number, targetSr: number): Float32Array {
    if (sourceSr === targetSr) return sourceBuffer;
    return globalNativeDAWBridge.resampleCatmullRom(sourceBuffer, sourceSr, 1);
  }

  // ==========================================================================
  // 3. ПАРСЕР СУБТИТРОВ И СЦЕНАРИЕВ (SRT, ASS, VTT)
  // ==========================================================================

  public parseSubtitles(content: string): SubtitleLine[] {
    if (!content || !content.trim()) return [];

    const lines: SubtitleLine[] = [];
    const cleanContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    if (cleanContent.includes('[Events]') || cleanContent.includes('Dialogue:')) {
      return this.parseAssSubtitles(cleanContent);
    }

    const blocks = cleanContent.split(/\n\s*\n/);

    for (const block of blocks) {
      const blockLines = block.trim().split('\n');
      if (blockLines.length < 2) continue;

      let timeIndex = 0;
      let lineIndex = 0;

      if (/^\d+$/.test(blockLines[0].trim())) {
        lineIndex = parseInt(blockLines[0].trim(), 10);
        timeIndex = 1;
      } else {
        lineIndex = lines.length + 1;
        timeIndex = 0;
      }

      const timeLine = blockLines[timeIndex];
      if (!timeLine || !timeLine.includes('-->')) continue;

      const [startStr, endStr] = timeLine.split('-->').map((s) => s.trim());
      const startSec = this.timeStringToSeconds(startStr);
      const endSec = this.timeStringToSeconds(endStr);

      const textLines = blockLines.slice(timeIndex + 1);
      const rawText = textLines.join(' ').replace(/<[^>]*>/g, '').trim();

      if (rawText) {
        lines.push({
          index: lineIndex,
          startSec,
          endSec,
          text: rawText
        });
      }
    }

    return lines;
  }

  private parseAssSubtitles(content: string): SubtitleLine[] {
    const lines: SubtitleLine[] = [];
    const rawLines = content.split('\n');

    let isEventsSection = false;
    let counter = 1;

    for (const rawLine of rawLines) {
      const line = rawLine.trim();
      if (line === '[Events]') {
        isEventsSection = true;
        continue;
      }

      if (isEventsSection && line.startsWith('Dialogue:')) {
        const parts = line.substring(9).split(',');
        if (parts.length >= 9) {
          const startSec = this.assTimeToSeconds(parts[1].trim());
          const endSec = this.assTimeToSeconds(parts[2].trim());
          const speaker = parts[4].trim() || undefined;
          const text = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').trim();

          if (text) {
            lines.push({
              index: counter++,
              startSec,
              endSec,
              text,
              speaker
            });
          }
        }
      }
    }

    return lines;
  }

  private timeStringToSeconds(timeStr: string): number {
    const cleanStr = timeStr.replace(',', '.');
    const parts = cleanStr.split(':');

    if (parts.length === 3) {
      const hours = parseFloat(parts[0]);
      const mins = parseFloat(parts[1]);
      const secs = parseFloat(parts[2]);
      return hours * 3600 + mins * 60 + secs;
    } else if (parts.length === 2) {
      const mins = parseFloat(parts[0]);
      const secs = parseFloat(parts[1]);
      return mins * 60 + secs;
    }

    return parseFloat(cleanStr) || 0;
  }

  private assTimeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':');
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return 0;
  }

  // ==========================================================================
  // 4. СМАРТ-ВЫРАВНИВАНИЕ (SMART ALIGNMENT ALGORITHM)
  // ==========================================================================

  /**
   * Смарт-выравнивание распознанных сегментов речи (ASR) с загруженным сценарием (SRT/ASS).
   * Сравнение строк и расчет схожести выполняется ИСКЛЮЧИТЕЛЬНО на C++ через fastStringSimilarity().
   */
  public alignSpeechWithScript(
    scriptLines: SubtitleLine[],
    speechSegments: SpeechSegment[],
    recognizedPhrases?: TranscriptionSegment[]
  ): AlignedSpeechPhrase[] {
    const alignedResults: AlignedSpeechPhrase[] = [];

    if (!scriptLines || scriptLines.length === 0) {
      return [];
    }

    if (!speechSegments || speechSegments.length === 0) {
      return scriptLines.map((line) => ({
        lineIndex: line.index,
        scriptText: line.text,
        recognizedText: '',
        expectedStartSec: line.startSec,
        expectedEndSec: line.endSec,
        actualStartSec: 0,
        actualEndSec: 0,
        timeDriftSec: 0,
        similarityScore: 0,
        status: 'missing'
      }));
    }

    for (let i = 0; i < scriptLines.length; i++) {
      const scriptLine = scriptLines[i];
      const targetMidTime = (scriptLine.startSec + scriptLine.endSec) / 2;

      let bestSegment: SpeechSegment | null = null;
      let minTimeDiff = Infinity;

      for (const seg of speechSegments) {
        const segMidTime = (seg.startSec + seg.endSec) / 2;
        const diff = Math.abs(segMidTime - targetMidTime);

        if (diff < minTimeDiff) {
          minTimeDiff = diff;
          bestSegment = seg;
        }
      }

      let recText = '';
      if (recognizedPhrases && recognizedPhrases.length > 0) {
        const matchedAsr = recognizedPhrases.find(
          (p) => Math.abs(p.startSec - (bestSegment ? bestSegment.startSec : scriptLine.startSec)) < 2.0
        );
        if (matchedAsr) recText = matchedAsr.text;
      }

      if (!recText && bestSegment) {
        recText = `[Голосовой сегмент ${bestSegment.durationSec.toFixed(1)}с]`;
      }

      if (bestSegment && minTimeDiff < 5.0) {
        const timeDrift = bestSegment.startSec - scriptLine.startSec;
        // Расчет схожести строк выполняется СТРОГО через C++ ядро
        const similarity = recText ? this.calculateStringSimilarity(scriptLine.text, recText) : 0.85;
        const status: 'matched' | 'drifted' = Math.abs(timeDrift) > 0.6 ? 'drifted' : 'matched';

        alignedResults.push({
          lineIndex: scriptLine.index,
          scriptText: scriptLine.text,
          recognizedText: recText,
          expectedStartSec: scriptLine.startSec,
          expectedEndSec: scriptLine.endSec,
          actualStartSec: bestSegment.startSec,
          actualEndSec: bestSegment.endSec,
          timeDriftSec: timeDrift,
          similarityScore: similarity,
          status
        });
      } else {
        alignedResults.push({
          lineIndex: scriptLine.index,
          scriptText: scriptLine.text,
          recognizedText: '',
          expectedStartSec: scriptLine.startSec,
          expectedEndSec: scriptLine.endSec,
          actualStartSec: 0,
          actualEndSec: 0,
          timeDriftSec: 0,
          similarityScore: 0,
          status: 'missing'
        });
      }
    }

    return alignedResults;
  }

  /**
   * Вычисление коэффициента схожести двух строк по Левенштейну (0.0 .. 1.0)
   * Выполняется ИСКЛЮЧИТЕЛЬНО через C++ UTF-8 модуль FastLevenshtein в globalNativeDAWBridge.
   */
  public calculateStringSimilarity(s1: string, s2: string): number {
    return globalNativeDAWBridge.fastStringSimilarity(s1, s2);
  }
}

export const globalAudioAIEngine = new AudioAIEngine();
