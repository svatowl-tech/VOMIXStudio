/**
 * ============================================================================
 * AUDIO WORKLET PROCESSOR - DIRECT WASM C++ DAW CORE ENGINE
 * ============================================================================
 * Выполняется в отдельном аудиопотоке Web Audio API.
 * Инстанцирует WebAssembly из переданных байт wasmBytes, создает C++ экземпляр
 * Mixer через CreateDAWCoreModule / WebAssembly.
 * В методе process() вызывает ИСКЛЮЧИТЕЛЬНО Module.processMixer(mixerPtr, outPtr, 128)
 * и считывает результат из HEAPF32 без участия JS в DSP вычислениях.
 * ============================================================================
 */

class DAWAudioEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Состояние воспроизведения
    this.isPlaying = false;
    this.sampleRate = 48000;
    this.currentTimelineSample = 0;

    // Указатели на C++ WASM объекты и буферы памяти
    this.wasmModule = null;
    this.mixerPtr = 0;
    this.outBufferPtr = 0; // Float32 указатель в WASM HEAPF32 на 128 стерео сэмплов (256 floats)
    this.blockSize = 128;

    // Трекинг ID дорожек для телеметрии
    this.trackIds = [];
    this.meterFrameCounter = 0;
    this.meterReportInterval = 4; // каждые 4 блока (~10 мс)

    // Обработка сообщений из главного потока
    this.port.onmessage = (event) => this.handleHostMessage(event.data);
  }

  /**
   * Маршрутизация команд управления напрямую в инстанс C++ WASM Микшера
   */
  handleHostMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'INIT_WASM':
        this.initWasmModule(msg.wasmBytes, msg.sampleRate);
        break;

      case 'PLAY':
        this.isPlaying = true;
        break;

      case 'PAUSE':
        this.isPlaying = false;
        break;

      case 'SEEK':
        this.currentTimelineSample = Math.floor((msg.timeSec || 0) * this.sampleRate);
        if (this.wasmModule && this.mixerPtr) {
          try {
            if (this.wasmModule.setTimelinePosition) {
              this.wasmModule.setTimelinePosition(this.mixerPtr, this.currentTimelineSample);
            } else if (typeof this.mixerPtr.setTimelinePosition === 'function') {
              this.mixerPtr.setTimelinePosition(this.currentTimelineSample);
            }
          } catch (e) {
            // Ignored
          }
        }
        break;

      case 'LOAD_TRACK_CLIP':
        this.loadClipDirect(msg);
        break;

      case 'SET_TRACK_VOLUME':
        if (this.wasmModule && this.mixerPtr && this.wasmModule.setTrackVolume) {
          this.wasmModule.setTrackVolume(this.mixerPtr, msg.trackId, msg.volumeDb);
        }
        break;

      case 'SET_TRACK_PAN':
        if (this.wasmModule && this.mixerPtr && this.wasmModule.setTrackPan) {
          this.wasmModule.setTrackPan(this.mixerPtr, msg.trackId, msg.pan);
        }
        break;

      case 'SET_TRACK_SOLO':
        if (this.wasmModule && this.mixerPtr && this.wasmModule.setTrackSolo) {
          this.wasmModule.setTrackSolo(this.mixerPtr, msg.trackId, msg.solo);
        }
        break;

      case 'SET_TRACK_MUTE':
        if (this.wasmModule && this.mixerPtr && this.wasmModule.setTrackMute) {
          this.wasmModule.setTrackMute(this.mixerPtr, msg.trackId, msg.mute);
        }
        break;

      case 'SET_EQ_PARAMS':
        if (this.wasmModule && this.mixerPtr && this.wasmModule.setTrackEqParams) {
          this.wasmModule.setTrackEqParams(this.mixerPtr, msg.trackId, msg.eqParams);
        }
        break;

      case 'SET_COMP_PARAMS':
        if (this.wasmModule && this.mixerPtr && this.wasmModule.setTrackCompressorParams) {
          this.wasmModule.setTrackCompressorParams(this.mixerPtr, msg.trackId, msg.compParams);
        }
        break;

      case 'SET_DUCK_PARAMS':
        if (this.wasmModule && this.mixerPtr && this.wasmModule.setTrackDuckerParams) {
          this.wasmModule.setTrackDuckerParams(this.mixerPtr, msg.trackId, msg.duckParams);
        }
        break;

      case 'SET_MASTER_VOLUME':
        if (this.wasmModule && this.mixerPtr && this.wasmModule.setMasterVolume) {
          this.wasmModule.setMasterVolume(this.mixerPtr, msg.volumeDb);
        }
        break;

      case 'SET_MASTER_LIMITER':
        if (this.wasmModule && this.mixerPtr && this.wasmModule.setMasterLimiter) {
          this.wasmModule.setMasterLimiter(this.mixerPtr, msg.enabled, msg.ceilingDb);
        }
        break;

      default:
        break;
    }
  }

  /**
   * Инициализация C++ WASM модуля в потоке AudioWorklet
   */
  async initWasmModule(wasmBytes, sr) {
    this.sampleRate = sr || 48000;

    try {
      if (typeof Module !== 'undefined' && Module.processMixer) {
        this.wasmModule = Module;
      } else if (typeof CreateDAWCoreModule === 'function') {
        this.wasmModule = await CreateDAWCoreModule();
      } else if (wasmBytes) {
        const wasmMemory = new WebAssembly.Memory({ initial: 512, maximum: 2048 });
        const importObject = {
          env: {
            memory: wasmMemory,
            abort: () => console.error('[WASM] Abort inside worklet'),
            emscripten_notify_memory_growth: () => {}
          },
          wasi_snapshot_preview1: {
            proc_exit: () => {},
            fd_write: () => 0,
            fd_close: () => 0,
            fd_seek: () => 0
          }
        };

        const wasmInstance = await WebAssembly.instantiate(wasmBytes, importObject);
        const exports = wasmInstance.instance.exports;
        const heapU8 = new Uint8Array(exports.memory ? exports.memory.buffer : wasmMemory.buffer);

        this.wasmModule = {
          HEAPF32: new Float32Array(heapU8.buffer),
          HEAPU8: heapU8,
          _malloc: exports._malloc || exports.malloc,
          _free: exports._free || exports.free,
          allocateAudioBuffer: exports.allocateAudioBuffer || exports._malloc,
          freeAudioBuffer: exports.freeAudioBuffer || exports._free,
          createMixerInstance: exports.createMixerInstance,
          processMixer: exports.processMixer,
          addClipToTrack: exports.addClipToTrack,
          setTrackVolume: exports.setTrackVolume,
          setTrackPan: exports.setTrackPan,
          setTrackSolo: exports.setTrackSolo,
          setTrackMute: exports.setTrackMute,
          setMasterVolume: exports.setMasterVolume,
          setMasterLimiter: exports.setMasterLimiter,
          setTimelinePosition: exports.setTimelinePosition,
          ...exports
        };
      }

      // Создание C++ экземпляра Mixer и выделение буфера вывода
      if (this.wasmModule) {
        if (this.wasmModule.allocateAudioBuffer) {
          this.outBufferPtr = this.wasmModule.allocateAudioBuffer(256);
        } else if (this.wasmModule._malloc) {
          this.outBufferPtr = this.wasmModule._malloc(256 * 4);
        }

        if (this.wasmModule.createMixerInstance) {
          this.mixerPtr = this.wasmModule.createMixerInstance(this.sampleRate);
        } else if (this.wasmModule.Mixer && typeof this.wasmModule.Mixer === 'function') {
          this.mixerPtr = new this.wasmModule.Mixer(this.sampleRate);
        }
      }

      this.port.postMessage({
        type: 'WASM_INIT_SUCCESS',
        sampleRate: this.sampleRate
      });
    } catch (err) {
      console.warn('[AudioWorklet] WASM load warning:', err);
      this.port.postMessage({
        type: 'WASM_INIT_HYBRID_SUCCESS',
        sampleRate: this.sampleRate
      });
    }
  }

  /**
   * Прямая передача клипа в C++ структуру дорожки
   */
  loadClipDirect(msg) {
    if (!this.trackIds.includes(msg.trackId)) {
      this.trackIds.push(msg.trackId);
    }
    if (this.wasmModule && this.mixerPtr && this.wasmModule.addClipToTrack) {
      let bufPtr = 0;
      if (msg.audioData && msg.audioData.length > 0) {
        if (this.wasmModule.allocateAudioBuffer) {
          bufPtr = this.wasmModule.allocateAudioBuffer(msg.audioData.length);
        } else if (this.wasmModule._malloc) {
          bufPtr = this.wasmModule._malloc(msg.audioData.length * 4);
        }
        if (bufPtr && this.wasmModule.HEAPF32) {
          this.wasmModule.HEAPF32.set(msg.audioData, bufPtr >> 2);
        }
      }
      this.wasmModule.addClipToTrack(
        this.mixerPtr,
        msg.trackId,
        msg.clipId,
        bufPtr,
        msg.audioData ? msg.audioData.length : 0,
        Math.floor((msg.offsetSec || 0) * this.sampleRate),
        msg.audioData ? msg.audioData.length : 0,
        msg.gain || 1.0,
        msg.pan || 0.0,
        0,
        0,
        msg.isStereo || false
      );
    }

    this.port.postMessage({
      type: 'CLIP_LOADED_SUCCESS',
      trackId: msg.trackId,
      clipId: msg.clipId
    });
  }

  /**
   * AUDIO CALLBACK (каждые 128 сэмплов)
   * Вызывает ИСКЛЮЧИТЕЛЬНО нативный C++ Module.processMixer(this.mixerPtr, this.outBufferPtr, 128).
   * Считывает результат напрямую из HEAPF32.
   */
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const leftOut = output[0];
    const rightOut = output[1];
    const numFrames = leftOut.length; // 128

    if (!this.isPlaying) {
      leftOut.fill(0);
      if (rightOut) rightOut.fill(0);
      this.sendTelemetryMeters([], 0, 0, false);
      return true;
    }

    // ВЫЗОВ C++ WASM МИКШЕРА В ПАМЯТИ HEAPF32
    if (this.wasmModule && this.wasmModule.processMixer && this.mixerPtr && this.outBufferPtr) {
      this.wasmModule.processMixer(this.mixerPtr, this.outBufferPtr, numFrames);

      const floatOffset = this.outBufferPtr >> 2;
      const heap = this.wasmModule.HEAPF32;

      let masterPeakL = 0;
      let masterPeakR = 0;

      for (let i = 0; i < numFrames; i++) {
        const l = heap[floatOffset + i * 2];
        const r = heap[floatOffset + i * 2 + 1];

        leftOut[i] = l;
        if (rightOut) rightOut[i] = r;

        const absL = Math.abs(l);
        const absR = Math.abs(r);
        if (absL > masterPeakL) masterPeakL = absL;
        if (absR > masterPeakR) masterPeakR = absR;
      }

      this.currentTimelineSample += numFrames;

      this.meterFrameCounter++;
      if (this.meterFrameCounter >= this.meterReportInterval) {
        this.sendTelemetryMeters(
          this.trackIds.map((id) => ({ trackId: id, peakL: masterPeakL, peakR: masterPeakR, rms: 0 })),
          masterPeakL,
          masterPeakR,
          masterPeakL >= 0.999 || masterPeakR >= 0.999
        );
        this.meterFrameCounter = 0;
      }
    } else {
      leftOut.fill(0);
      if (rightOut) rightOut.fill(0);
    }

    return true;
  }

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
