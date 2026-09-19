/**
 * ============================================================================
 * AUDIO WORKLET PROCESSOR - C++ WEBASSEMBLY NATIVE DAW CORE MIXER
 * ============================================================================
 * Выполняется в выделенном высокоприоритетном аудиопотоке Web Audio API.
 * Все вычисления и микширование производятся ИСКЛЮЧИТЕЛЬНО в скомпилированном
 * C++ WebAssembly ядре (daw_core.wasm / Mixer::processBlock).
 *
 * Любая программная эмуляция и расчет звука на JavaScript полностью удалены.
 * ============================================================================
 */

class DAWAudioEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Состояние воспроизведения и параметров
    this.isPlaying = false;
    this.sampleRate = 48000;
    this.currentTimelineSample = 0;

    // C++ WebAssembly указатели и модуль
    this.wasmModule = null;
    this.wasmMemory = null;
    this.mixerPtr = null;
    this.outBufferPtr = 0;
    this.clipAllocations = new Map(); // key: "trackId:clipId" -> pcmPtr

    // Телеметрия
    this.meterFrameCounter = 0;
    this.meterReportInterval = 4; // каждые 4 блока (4 * 128 = 512 сэмплов = ~10.6 мс)

    // Обработчик управляющих команд из главного потока UI
    this.port.onmessage = (event) => this.handleHostMessage(event.data);

    // Уведомление о готовности ворклера
    this.port.postMessage({
      type: 'WORKLET_READY',
      sampleRate: this.sampleRate
    });
  }

  /**
   * Инициализация C++ WebAssembly инстанса в AudioWorklet
   */
  async initWasm(wasmBytes, sampleRate) {
    if (sampleRate && sampleRate > 0) {
      this.sampleRate = sampleRate;
    }

    try {
      if (!wasmBytes || wasmBytes.byteLength === 0) {
        throw new Error('Пустой буфер байт WebAssembly модуля daw_core.wasm');
      }

      const wasmMemory = new WebAssembly.Memory({ initial: 512, maximum: 4096 });
      const importObject = {
        env: {
          memory: wasmMemory,
          abort: (msg) => console.error('[WASM Worklet Abort]', msg),
          emscripten_notify_memory_growth: () => {},
          _emscripten_notify_memory_growth: () => {}
        },
        wasi_snapshot_preview1: {
          proc_exit: () => {},
          fd_write: () => 0,
          fd_close: () => 0,
          fd_seek: () => 0
        }
      };

      const instantiated = await WebAssembly.instantiate(wasmBytes, importObject);
      const exports = instantiated.instance.exports;

      if (!exports.processMixer && exports._processMixer) {
        exports.processMixer = exports._processMixer;
      }

      this.wasmModule = exports;
      this.wasmMemory = exports.memory || wasmMemory;

      // Создаем C++ экземпляр Mixer
      const createMixerFn = exports.createMixerInstance || exports._createMixerInstance;
      const mallocFn = exports._malloc || exports.malloc || exports.allocateAudioBuffer;

      if (createMixerFn) {
        this.mixerPtr = createMixerFn(this.sampleRate);
      } else if (mallocFn) {
        this.mixerPtr = mallocFn(1024);
      }

      // Выделяем выходной буфер под блок: 128 фреймов * 2 канала * 4 байта = 1024 байта
      if (mallocFn) {
        this.outBufferPtr = mallocFn(128 * 2 * 4);
      }

      if (!this.mixerPtr || !this.outBufferPtr) {
        throw new Error('Не удалось выделить память под Mixer или выходной аудиопоток в куче WASM');
      }

      console.log('[DAWAudioEngineProcessor] C++ WASM аудиомикшер успешно инициализирован в AudioWorklet.');
      this.port.postMessage({ type: 'WASM_INIT_SUCCESS', sampleRate: this.sampleRate });
    } catch (err) {
      console.error('[DAWAudioEngineProcessor] Фатальный сбой инстанцирования C++ WASM ядра в AudioWorklet:', err);
      this.wasmModule = null;
      this.mixerPtr = null;
      this.port.postMessage({
        type: 'WASM_CORE_MISSING',
        error: String(err && err.message ? err.message : err)
      });
    }
  }

  /**
   * Обработка управляющих сообщений от UI
   */
  handleHostMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'INIT_WASM':
        if (msg.wasmBytes) {
          this.initWasm(msg.wasmBytes, msg.sampleRate);
        } else {
          this.port.postMessage({
            type: 'WASM_CORE_MISSING',
            error: 'WASM байты отсутствуют в сообщении INIT_WASM'
          });
        }
        break;

      case 'PLAY':
        this.isPlaying = true;
        break;

      case 'PAUSE':
        this.isPlaying = false;
        break;

      case 'SEEK': {
        this.currentTimelineSample = Math.max(0, Math.floor((msg.timeSec || 0) * this.sampleRate));
        const setPosFn = this.wasmModule ? (this.wasmModule.setTimelinePosition || this.wasmModule._setTimelinePosition) : null;
        if (setPosFn && this.mixerPtr) {
          setPosFn(this.mixerPtr, this.currentTimelineSample);
        }
        this.sendTelemetryMeters([], 0, 0, false);
        break;
      }

      case 'LOAD_TRACK_CLIP': {
        const trackId = msg.trackId;
        const clipId = msg.clipId || Date.now();
        const pcmBuffer = msg.audioData || new Float32Array(0);
        const offsetSamples = typeof msg.offsetSamples === 'number'
          ? msg.offsetSamples
          : Math.floor((msg.offsetSec || 0) * this.sampleRate);
        const isStereo = msg.isStereo !== undefined ? msg.isStereo : true;
        const lengthSamples = msg.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
        const gain = typeof msg.gain === 'number' ? msg.gain : 1.0;
        const pan = typeof msg.pan === 'number' ? msg.pan : 0.0;
        const fadeIn = msg.fadeInSamples || 0;
        const fadeOut = msg.fadeOutSamples || 0;

        if (this.wasmModule && this.mixerPtr && pcmBuffer.length > 0) {
          const mallocFn = this.wasmModule._malloc || this.wasmModule.malloc || this.wasmModule.allocateAudioBuffer;
          const freeFn = this.wasmModule._free || this.wasmModule.free || this.wasmModule.freeAudioBuffer;
          const addClipFn = this.wasmModule.addClipToTrack || this.wasmModule._addClipToTrack;
          const key = `${trackId}:${clipId}`;

          if (this.clipAllocations.has(key) && freeFn) {
            freeFn(this.clipAllocations.get(key));
          }

          if (mallocFn) {
            const pcmPtr = mallocFn(pcmBuffer.length * 4);
            this.clipAllocations.set(key, pcmPtr);

            const heapF32 = new Float32Array(this.wasmMemory.buffer);
            heapF32.set(pcmBuffer, pcmPtr >> 2);

            if (addClipFn) {
              addClipFn(
                this.mixerPtr,
                trackId,
                clipId,
                pcmPtr,
                pcmBuffer.length,
                offsetSamples,
                lengthSamples,
                gain,
                pan,
                fadeIn,
                fadeOut,
                isStereo
              );
            }
          }
        }

        this.port.postMessage({
          type: 'CLIP_LOADED_SUCCESS',
          trackId,
          clipId
        });
        break;
      }

      case 'SET_TRACK_CLIPS': {
        const trackId = msg.trackId;
        const clips = Array.isArray(msg.clips) ? msg.clips : [];
        const mallocFn = this.wasmModule ? (this.wasmModule._malloc || this.wasmModule.malloc || this.wasmModule.allocateAudioBuffer) : null;
        const freeFn = this.wasmModule ? (this.wasmModule._free || this.wasmModule.free || this.wasmModule.freeAudioBuffer) : null;
        const addClipFn = this.wasmModule ? (this.wasmModule.addClipToTrack || this.wasmModule._addClipToTrack) : null;

        if (this.wasmModule && this.mixerPtr && mallocFn && addClipFn) {
          for (const c of clips) {
            const clipId = c.id;
            const pcmBuffer = c.buffer || new Float32Array(0);
            if (pcmBuffer.length === 0) continue;

            const isStereo = c.isStereo !== undefined ? c.isStereo : true;
            const lengthSamples = c.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
            const offsetSamples = c.offsetSamples || 0;
            const gain = typeof c.gain === 'number' ? c.gain : 1.0;
            const pan = typeof c.pan === 'number' ? c.pan : 0.0;
            const fadeIn = c.fadeInSamples || 0;
            const fadeOut = c.fadeOutSamples || 0;

            const key = `${trackId}:${clipId}`;
            if (this.clipAllocations.has(key) && freeFn) {
              freeFn(this.clipAllocations.get(key));
            }

            const pcmPtr = mallocFn(pcmBuffer.length * 4);
            this.clipAllocations.set(key, pcmPtr);

            const heapF32 = new Float32Array(this.wasmMemory.buffer);
            heapF32.set(pcmBuffer, pcmPtr >> 2);

            addClipFn(
              this.mixerPtr,
              trackId,
              clipId,
              pcmPtr,
              pcmBuffer.length,
              offsetSamples,
              lengthSamples,
              gain,
              pan,
              fadeIn,
              fadeOut,
              isStereo
            );
          }
        }
        break;
      }

      case 'SET_ALL_TRACKS': {
        const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
        const mallocFn = this.wasmModule ? (this.wasmModule._malloc || this.wasmModule.malloc || this.wasmModule.allocateAudioBuffer) : null;
        const freeFn = this.wasmModule ? (this.wasmModule._free || this.wasmModule.free || this.wasmModule.freeAudioBuffer) : null;
        const addClipFn = this.wasmModule ? (this.wasmModule.addClipToTrack || this.wasmModule._addClipToTrack) : null;
        const setVolFn = this.wasmModule ? (this.wasmModule.setTrackVolume || this.wasmModule._setTrackVolume) : null;
        const setPanFn = this.wasmModule ? (this.wasmModule.setTrackPan || this.wasmModule._setTrackPan) : null;
        const setSoloFn = this.wasmModule ? (this.wasmModule.setTrackSolo || this.wasmModule._setTrackSolo) : null;
        const setMuteFn = this.wasmModule ? (this.wasmModule.setTrackMute || this.wasmModule._setTrackMute) : null;

        if (this.wasmModule && this.mixerPtr) {
          for (const t of tracks) {
            if (setVolFn) setVolFn(this.mixerPtr, t.id, t.volumeDb || 0.0);
            if (setPanFn) setPanFn(this.mixerPtr, t.id, t.pan || 0.0);
            if (setSoloFn) setSoloFn(this.mixerPtr, t.id, !!t.solo);
            if (setMuteFn) setMuteFn(this.mixerPtr, t.id, !!t.mute);

            if (Array.isArray(t.clips) && mallocFn && addClipFn) {
              for (const c of t.clips) {
                const pcmBuffer = c.buffer || new Float32Array(0);
                if (pcmBuffer.length === 0) continue;

                const isStereo = c.isStereo !== undefined ? c.isStereo : true;
                const lengthSamples = c.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
                const offsetSamples = c.offsetSamples || 0;
                const gain = typeof c.gain === 'number' ? c.gain : 1.0;
                const pan = typeof c.pan === 'number' ? c.pan : 0.0;
                const fadeIn = c.fadeInSamples || 0;
                const fadeOut = c.fadeOutSamples || 0;

                const key = `${t.id}:${c.id}`;
                if (this.clipAllocations.has(key) && freeFn) {
                  freeFn(this.clipAllocations.get(key));
                }

                const pcmPtr = mallocFn(pcmBuffer.length * 4);
                this.clipAllocations.set(key, pcmPtr);

                const heapF32 = new Float32Array(this.wasmMemory.buffer);
                heapF32.set(pcmBuffer, pcmPtr >> 2);

                addClipFn(
                  this.mixerPtr,
                  t.id,
                  c.id,
                  pcmPtr,
                  pcmBuffer.length,
                  offsetSamples,
                  lengthSamples,
                  gain,
                  pan,
                  fadeIn,
                  fadeOut,
                  isStereo
                );
              }
            }
          }
        }
        break;
      }

      case 'CLEAR_TRACKS': {
        const removeAllFn = this.wasmModule ? (this.wasmModule.removeAllTracks || this.wasmModule._removeAllTracks) : null;
        if (removeAllFn && this.mixerPtr) {
          removeAllFn(this.mixerPtr);
        }
        const freeFn = this.wasmModule ? (this.wasmModule._free || this.wasmModule.free || this.wasmModule.freeAudioBuffer) : null;
        if (freeFn) {
          for (const ptr of this.clipAllocations.values()) {
            freeFn(ptr);
          }
        }
        this.clipAllocations.clear();
        break;
      }

      case 'SET_TRACK_VOLUME': {
        const setVolFn = this.wasmModule ? (this.wasmModule.setTrackVolume || this.wasmModule._setTrackVolume) : null;
        if (setVolFn && this.mixerPtr) {
          setVolFn(this.mixerPtr, msg.trackId, msg.volumeDb || 0.0);
        }
        break;
      }

      case 'SET_TRACK_PAN': {
        const setPanFn = this.wasmModule ? (this.wasmModule.setTrackPan || this.wasmModule._setTrackPan) : null;
        if (setPanFn && this.mixerPtr) {
          setPanFn(this.mixerPtr, msg.trackId, msg.pan || 0.0);
        }
        break;
      }

      case 'SET_TRACK_SOLO': {
        const setSoloFn = this.wasmModule ? (this.wasmModule.setTrackSolo || this.wasmModule._setTrackSolo) : null;
        if (setSoloFn && this.mixerPtr) {
          setSoloFn(this.mixerPtr, msg.trackId, !!msg.solo);
        }
        break;
      }

      case 'SET_TRACK_MUTE': {
        const setMuteFn = this.wasmModule ? (this.wasmModule.setTrackMute || this.wasmModule._setTrackMute) : null;
        if (setMuteFn && this.mixerPtr) {
          setMuteFn(this.mixerPtr, msg.trackId, !!msg.mute);
        }
        break;
      }

      case 'SET_MASTER_VOLUME': {
        const setMstVolFn = this.wasmModule ? (this.wasmModule.setMasterVolume || this.wasmModule._setMasterVolume) : null;
        if (setMstVolFn && this.mixerPtr) {
          setMstVolFn(this.mixerPtr, typeof msg.volumeDb === 'number' ? msg.volumeDb : 0.0);
        }
        break;
      }

      case 'SET_MASTER_LIMITER': {
        const setLimiterFn = this.wasmModule ? (this.wasmModule.setMasterLimiter || this.wasmModule._setMasterLimiter) : null;
        if (setLimiterFn && this.mixerPtr) {
          setLimiterFn(
            this.mixerPtr,
            msg.enabled !== undefined ? !!msg.enabled : true,
            typeof msg.ceilingDb === 'number' ? msg.ceilingDb : -0.1
          );
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * AUDIO WORKLET DSP CALLBACK
   * Вызывается аудиокартой/браузером каждые 128 сэмплов (2.67 мс при 48 кГц).
   * Процессинг выполняется ИСКЛЮЧИТЕЛЬНО через C++ WebAssembly ядро.
   */
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const leftOut = output[0];
    const rightOut = output[1] || leftOut;
    const numFrames = leftOut.length; // 128

    // 1. Проверка наличия C++ WASM модуля и инстанса микшера. Без JS-эмуляции.
    if (!this.wasmModule || !this.mixerPtr || !this.outBufferPtr || typeof this.wasmModule.processMixer !== 'function') {
      console.error('[AudioWorklet] C++ WASM Core is not loaded!');
      this.port.postMessage({
        type: 'WASM_CORE_MISSING',
        error: 'C++ WebAssembly ядро (daw_core.wasm) или mixerPtr не инициализированы в AudioWorklet.'
      });
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);
      return true;
    }

    // 2. Если пауза — заполняем выход нулями
    if (!this.isPlaying) {
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);

      this.meterFrameCounter++;
      if (this.meterFrameCounter >= 30) {
        this.sendTelemetryMeters([], 0, 0, false);
        this.meterFrameCounter = 0;
      }
      return true;
    }

    // 3. Процессинг происходит ТОЛЬКО через C++ инстанс микшера
    this.wasmModule.processMixer(this.mixerPtr, this.outBufferPtr, numFrames);

    // 4. Прямое копирование сэмплов из виртуальной кучи C++ WASM в аудиокарту
    const floatOffset = this.outBufferPtr >> 2;
    const heapF32 = new Float32Array(this.wasmMemory.buffer);

    let masterPeakL = 0;
    let masterPeakR = 0;
    let isClipped = false;

    for (let i = 0; i < numFrames; i++) {
      const sL = heapF32[floatOffset + i * 2];
      const sR = heapF32[floatOffset + i * 2 + 1];

      leftOut[i] = sL;
      if (rightOut !== leftOut) {
        rightOut[i] = sR;
      }

      const absL = Math.abs(sL);
      const absR = Math.abs(sR);
      if (absL > masterPeakL) masterPeakL = absL;
      if (absR > masterPeakR) masterPeakR = absR;
      if (absL >= 0.999 || absR >= 0.999) isClipped = true;
    }

    // 5. Продвижение таймлайна
    this.currentTimelineSample += numFrames;

    // 6. Телеметрия индикаторов
    this.meterFrameCounter++;
    if (this.meterFrameCounter >= this.meterReportInterval) {
      this.sendTelemetryMeters([], masterPeakL, masterPeakR, isClipped);
      this.meterFrameCounter = 0;
    }

    return true;
  }

  /**
   * Отправка позиции плейхеда и показаний индикаторов в React UI
   */
  sendTelemetryMeters(trackMeters, masterPeakL, masterPeakR, clipped) {
    this.port.postMessage({
      type: 'METERS_TELEMETRY',
      currentTimeSec: this.currentTimelineSample / this.sampleRate,
      tracks: trackMeters,
      master: {
        peakL: masterPeakL,
        peakR: masterPeakR,
        clipped
      }
    });
  }
}

registerProcessor('audio-engine-processor', DAWAudioEngineProcessor);
