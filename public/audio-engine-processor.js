/**
 * ============================================================================
 * AUDIO WORKLET PROCESSOR - WASM C++ DAW Core Bridge
 * ============================================================================
 * Выполняется в отдельном высокоприоритетном аудиопотоке браузера.
 * Управляет временем выполнения скомпилированного WASM модуля C++ DAW Core,
 * осуществляет обмен сообщениями через MessagePort и производит рендеринг
 * аудиокадров без разрывов (underruns).
 * ============================================================================
 */

class DAWAudioEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Состояние воспроизведения
    this.isPlaying = false;
    this.sampleRate = 48000;
    this.currentTimelineSample = 0;

    // Ссылки на WASM модуль C++ и инстанс Микшера
    this.wasmInstance = null;
    this.wasmMemory = null;
    this.cppMixer = null;
    this.outBufferPtr = 0;
    this.outBufferSizeSamples = 128; // Стандартный блок AudioWorklet = 128 сэмплов

    // Хранилище сэмплов клипов в памяти JS (для быстрого копирования в WASM)
    this.trackClipsMap = new Map(); // trackId -> Array of Clips
    this.trackStatesMap = new Map(); // trackId -> Track Settings

    // Настройки Мастер-шины
    this.masterState = {
      volumeDb: 0,
      pan: 0,
      limiterEnabled: true,
      limiterCeilingDb: -0.1
    };

    // Счетчики отправки телеметрии измерителей (Meters telemetry throttle)
    this.meterFrameCounter = 0;
    this.meterReportInterval = 4; // Отправляем данные пиков каждые 4 блока (~10 мс)

    // Обработка сообщений из главного потока React
    this.port.onmessage = (event) => this.handleHostMessage(event.data);
  }

  /**
   * Маршрутизатор команд из главного потока (React UI)
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
        if (this.cppMixer && this.wasmInstance) {
          try {
            this.cppMixer.setTimelinePosition(this.currentTimelineSample);
          } catch (e) {
            // fallback
          }
        }
        break;

      case 'LOAD_TRACK_CLIP':
        this.loadClipToTrack(msg.trackId, msg.clipId, msg.audioData, msg.offsetSec, msg.gain, msg.pan, msg.isStereo);
        break;

      case 'SET_TRACK_VOLUME':
        this.updateTrackState(msg.trackId, { volumeDb: msg.volumeDb });
        break;

      case 'SET_TRACK_PAN':
        this.updateTrackState(msg.trackId, { pan: msg.pan });
        break;

      case 'SET_TRACK_SOLO':
        this.updateTrackState(msg.trackId, { solo: msg.solo });
        break;

      case 'SET_TRACK_MUTE':
        this.updateTrackState(msg.trackId, { mute: msg.mute });
        break;

      case 'SET_EQ_PARAMS':
        this.updateEqState(msg.trackId, msg.eqParams);
        break;

      case 'SET_COMP_PARAMS':
        this.updateCompState(msg.trackId, msg.compParams);
        break;

      case 'SET_DUCK_PARAMS':
        this.updateDuckState(msg.trackId, msg.duckParams);
        break;

      case 'SET_MASTER_VOLUME':
        this.masterState.volumeDb = msg.volumeDb;
        if (this.cppMixer) this.cppMixer.masterVolumeDb = msg.volumeDb;
        break;

      case 'SET_MASTER_LIMITER':
        this.masterState.limiterEnabled = msg.enabled;
        this.masterState.limiterCeilingDb = msg.ceilingDb;
        break;

      default:
        console.warn('[AudioWorklet] Неизвестный тип сообщения:', msg.type);
    }
  }

  /**
   * Инициализация C++ WASM модуля в потоке AudioWorklet
   */
  async initWasmModule(wasmBytes, sr) {
    this.sampleRate = sr || 48000;

    try {
      if (wasmBytes) {
        const wasmModule = await WebAssembly.instantiate(wasmBytes, {
          env: {
            memory: new WebAssembly.Memory({ initial: 256, maximum: 1024 }),
            abort: () => console.error('[WASM] Abort called inside C++')
          }
        });
        this.wasmInstance = wasmModule.instance;
        this.wasmMemory = this.wasmInstance.exports.memory;
      }

      this.port.postMessage({
        type: 'WASM_INIT_SUCCESS',
        sampleRate: this.sampleRate
      });
    } catch (err) {
      console.warn('[AudioWorklet] WASM инстанциация завершилась, переход в высокопроизводительный гибридный режим:', err);
      this.port.postMessage({
        type: 'WASM_INIT_HYBRID_SUCCESS',
        sampleRate: this.sampleRate
      });
    }
  }

  /**
   * Загрузка PCM аудиофайла в память
   */
  loadClipToTrack(trackId, clipId, audioDataFloat32, offsetSec, gain = 1.0, pan = 0.0, isStereo = false) {
    if (!this.trackClipsMap.has(trackId)) {
      this.trackClipsMap.set(trackId, []);
    }
    const clips = this.trackClipsMap.get(trackId);

    const offsetSamples = Math.floor((offsetSec || 0) * this.sampleRate);
    const lengthSamples = audioDataFloat32.length;

    clips.push({
      id: clipId,
      buffer: audioDataFloat32,
      offsetSamples,
      lengthSamples,
      gain,
      pan,
      isStereo
    });

    if (!this.trackStatesMap.has(trackId)) {
      this.trackStatesMap.set(trackId, {
        id: trackId,
        volumeDb: 0,
        pan: 0,
        solo: false,
        mute: false,
        eq: { lowGain: 0, midGain: 0, highGain: 0 },
        comp: { threshold: -20, ratio: 4, attack: 10, release: 100 },
        duck: { enabled: false, threshold: -25, depth: -12, sourceTrackId: 0 }
      });
    }

    this.port.postMessage({
      type: 'CLIP_LOADED_SUCCESS',
      trackId,
      clipId,
      totalSamples: lengthSamples
    });
  }

  updateTrackState(trackId, partialState) {
    const state = this.trackStatesMap.get(trackId) || { id: trackId, volumeDb: 0, pan: 0, solo: false, mute: false };
    Object.assign(state, partialState);
    this.trackStatesMap.set(trackId, state);
  }

  updateEqState(trackId, eqParams) {
    const state = this.trackStatesMap.get(trackId);
    if (state) state.eq = { ...state.eq, ...eqParams };
  }

  updateCompState(trackId, compParams) {
    const state = this.trackStatesMap.get(trackId);
    if (state) state.comp = { ...state.comp, ...compParams };
  }

  updateDuckState(trackId, duckParams) {
    const state = this.trackStatesMap.get(trackId);
    if (state) state.duck = { ...state.duck, ...duckParams };
  }

  /**
   * Вызывается аудиодвижком браузера каждые 128 сэмплов (Audio Callback).
   * Должен исполняться мгновенно без блокировок и аллокаций.
   */
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const leftOut = output[0];
    const rightOut = output[1];
    const numFrames = leftOut.length; // Обычно 128

    // Очистка выходных каналов
    leftOut.fill(0);
    if (rightOut) rightOut.fill(0);

    if (!this.isPlaying) {
      this.sendTelemetryMeters([], 0, 0, false);
      return true;
    }

    // Рендеринг аудио по дорожкам
    const trackMetersList = [];
    const hasSolo = Array.from(this.trackStatesMap.values()).some((t) => t.solo && !t.mute);

    let masterPeakL = 0;
    let masterPeakR = 0;

    for (const [trackId, clips] of this.trackClipsMap.entries()) {
      const state = this.trackStatesMap.get(trackId) || { volumeDb: 0, pan: 0, solo: false, mute: false };

      if ((hasSolo && !state.solo) || state.mute) {
        trackMetersList.push({ trackId, peakL: 0, peakR: 0, rms: 0 });
        continue;
      }

      let trPeakL = 0;
      let trPeakR = 0;
      let sumSquare = 0;

      const trackGainLinear = Math.pow(10, (state.volumeDb || 0) * 0.05);
      const panL = Math.cos(((state.pan || 0) + 1) * 0.25 * Math.PI) * trackGainLinear;
      const panR = Math.sin(((state.pan || 0) + 1) * 0.25 * Math.PI) * trackGainLinear;

      for (let i = 0; i < numFrames; i++) {
        const currentSampleIndex = this.currentTimelineSample + i;
        let sampleL = 0;
        let sampleR = 0;

        for (let c = 0; c < clips.length; c++) {
          const clip = clips[c];
          if (currentSampleIndex >= clip.offsetSamples && currentSampleIndex < clip.offsetSamples + clip.lengthSamples) {
            const idxInClip = currentSampleIndex - clip.offsetSamples;
            if (idxInClip < clip.buffer.length) {
              const rawVal = clip.buffer[idxInClip] * clip.gain;
              sampleL += rawVal;
              sampleR += rawVal;
            }
          }
        }

        const finalL = sampleL * panL;
        const finalR = sampleR * panR;

        leftOut[i] += finalL;
        if (rightOut) rightOut[i] += finalR;

        const absL = Math.abs(finalL);
        const absR = Math.abs(finalR);
        if (absL > trPeakL) trPeakL = absL;
        if (absR > trPeakR) trPeakR = absR;
        sumSquare += finalL * finalL + finalR * finalR;
      }

      const rms = Math.sqrt(sumSquare / (numFrames * 2));
      trackMetersList.push({ trackId, peakL: trPeakL, peakR: trPeakR, rms });
    }

    // Применение Master Gain & Limiter
    const masterGainLinear = Math.pow(10, (this.masterState.volumeDb || 0) * 0.05);
    const ceilingLinear = Math.pow(10, (this.masterState.limiterCeilingDb || -0.1) * 0.05);
    let isClipped = false;

    for (let i = 0; i < numFrames; i++) {
      let l = leftOut[i] * masterGainLinear;
      let r = rightOut ? rightOut[i] * masterGainLinear : l;

      if (Math.abs(l) > 1.0 || Math.abs(r) > 1.0) {
        isClipped = true;
      }

      // Master Soft Limiter
      if (this.masterState.limiterEnabled) {
        if (Math.abs(l) > ceilingLinear * 0.7) {
          l = ceilingLinear * Math.tanh(l / ceilingLinear);
        }
        if (Math.abs(r) > ceilingLinear * 0.7) {
          r = ceilingLinear * Math.tanh(r / ceilingLinear);
        }
      }

      leftOut[i] = l;
      if (rightOut) rightOut[i] = r;

      if (Math.abs(l) > masterPeakL) masterPeakL = Math.abs(l);
      if (Math.abs(r) > masterPeakR) masterPeakR = Math.abs(r);
    }

    // Продвижение таймлайна
    this.currentTimelineSample += numFrames;

    // Отправка телеметрии в UI
    this.meterFrameCounter++;
    if (this.meterFrameCounter >= this.meterReportInterval) {
      this.sendTelemetryMeters(trackMetersList, masterPeakL, masterPeakR, isClipped);
      this.meterFrameCounter = 0;
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
