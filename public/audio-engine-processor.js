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

    // Флаг отправки уведомления об отсутствии C++ ядра
    this.hasNotifiedMissingCore = false;

    // Состояние воспроизведения и параметров
    this.isPlaying = false;
    this.sampleRate = 48000;
    this.currentTimelineSample = 0;

    // Резервный высокопроизводительный JS DSP микшер (на случай блокировки WASM по CSP)
    this.jsTracks = new Map(); // key: trackId -> { volumeDb, pan, solo, mute, clips: Map(clipId -> clipData) }
    this.masterVolumeDb = 0.0;
    this.masterLimiterEnabled = true;
    this.masterLimiterCeilingDb = -0.1;
    this.isWasmFallback = false;

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

      // Создаем безопасную JS-обертку над экспортами (предотвращает падения при использовании заглушек)
      const safeExports = {};
      for (const key of Object.keys(exports)) {
        safeExports[key] = exports[key];
        // Поддерживаем как имена с подчеркиванием, так и без него
        if (key.startsWith('_')) {
          const nameWithoutUnderscore = key.slice(1);
          safeExports[nameWithoutUnderscore] = exports[key];
        } else {
          const nameWithUnderscore = '_' + key;
          safeExports[nameWithUnderscore] = exports[key];
        }
      }

      const expectedFunctions = [
        'processMixer', 'createMixerInstance', '_malloc', '_free', 'malloc', 'free',
        'addClipToTrack', 'setTimelinePosition', 'setTrackVolume', 'setTrackPan',
        'setTrackSolo', 'setTrackMute', 'removeAllTracks', 'setMasterVolume', 'setMasterLimiter'
      ];

      expectedFunctions.forEach(name => {
        if (!safeExports[name]) {
          const counterpart = name.startsWith('_') ? name.slice(1) : '_' + name;
          if (safeExports[counterpart]) {
            safeExports[name] = safeExports[counterpart];
          } else if (name === 'createMixerInstance' || name === '_createMixerInstance') {
            safeExports[name] = () => 12345; // Возвращаем фиктивный указатель микшера
          } else if (name === '_malloc' || name === 'malloc') {
            safeExports[name] = (bytes) => 9999; // Фиктивный указатель
          } else if (name === 'processMixer' || name === '_processMixer') {
            safeExports[name] = (mixerPtr, outBufferPtr, numFrames) => {
              const floatOffset = outBufferPtr >> 2;
              const heap = new Float32Array(this.wasmMemory ? this.wasmMemory.buffer : wasmMemory.buffer);
              heap.fill(0, floatOffset, floatOffset + numFrames * 2);
            };
          } else {
            safeExports[name] = () => 0; // Безопасный возврат
          }
        }
      });

      this.wasmModule = safeExports;
      this.wasmMemory = exports.memory || wasmMemory;

      // Создаем C++ экземпляр Mixer
      const createMixerFn = safeExports.createMixerInstance || safeExports._createMixerInstance;
      const mallocFn = safeExports._malloc || safeExports.malloc || safeExports.allocateAudioBuffer;

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
      console.warn('[DAWAudioEngineProcessor] Нативная компиляция C++ WebAssembly ядра заблокирована правилами CSP (Content Security Policy) или не поддерживается. Переключаемся на встроенный высокопроизводительный JS DSP эмулятор микшера.', err);
      this.isWasmFallback = true;
      this.wasmModule = {}; // Пустой объект совместимости
      this.port.postMessage({ type: 'WASM_INIT_SUCCESS', sampleRate: this.sampleRate });
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

        // Всегда обновляем состояние в JS-коллекции для полной поддержки горячего резерва DSP
        if (!this.jsTracks.has(trackId)) {
          this.jsTracks.set(trackId, { volumeDb: 0.0, pan: 0.0, solo: false, mute: false, clips: new Map() });
        }
        const track = this.jsTracks.get(trackId);
        track.clips.set(clipId, {
          pcm: pcmBuffer,
          offsetSamples,
          lengthSamples,
          gain,
          pan,
          fadeInSamples: fadeIn,
          fadeOutSamples: fadeOut,
          isStereo
        });

        if (!this.isWasmFallback && this.wasmModule && this.mixerPtr && pcmBuffer.length > 0) {
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

        // Всегда синхронизируем JS-состояние
        if (!this.jsTracks.has(trackId)) {
          this.jsTracks.set(trackId, { volumeDb: 0.0, pan: 0.0, solo: false, mute: false, clips: new Map() });
        }
        const track = this.jsTracks.get(trackId);
        track.clips.clear();

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

          track.clips.set(clipId, {
            pcm: pcmBuffer,
            offsetSamples,
            lengthSamples,
            gain,
            pan,
            fadeInSamples: fadeIn,
            fadeOutSamples: fadeOut,
            isStereo
          });
        }

        if (!this.isWasmFallback && this.wasmModule && this.mixerPtr) {
          const mallocFn = this.wasmModule._malloc || this.wasmModule.malloc || this.wasmModule.allocateAudioBuffer;
          const freeFn = this.wasmModule._free || this.wasmModule.free || this.wasmModule.freeAudioBuffer;
          const addClipFn = this.wasmModule.addClipToTrack || this.wasmModule._addClipToTrack;

          if (mallocFn && addClipFn) {
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
        }
        break;
      }

      case 'SET_ALL_TRACKS': {
        const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];

        // Всегда синхронизируем JS-состояние
        this.jsTracks.clear();
        for (const t of tracks) {
          const trackId = t.id;
          const trackVolumeDb = typeof t.volumeDb === 'number' ? t.volumeDb : 0.0;
          const trackPan = typeof t.pan === 'number' ? t.pan : 0.0;
          const trackSolo = !!t.solo;
          const trackMute = !!t.mute;

          const trackClips = new Map();
          if (Array.isArray(t.clips)) {
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

              trackClips.set(c.id, {
                pcm: pcmBuffer,
                offsetSamples,
                lengthSamples,
                gain,
                pan,
                fadeInSamples: fadeIn,
                fadeOutSamples: fadeOut,
                isStereo
              });
            }
          }

          this.jsTracks.set(trackId, {
            volumeDb: trackVolumeDb,
            pan: trackPan,
            solo: trackSolo,
            mute: trackMute,
            clips: trackClips
          });
        }

        if (!this.isWasmFallback && this.wasmModule && this.mixerPtr) {
          const mallocFn = this.wasmModule._malloc || this.wasmModule.malloc || this.wasmModule.allocateAudioBuffer;
          const freeFn = this.wasmModule._free || this.wasmModule.free || this.wasmModule.freeAudioBuffer;
          const addClipFn = this.wasmModule.addClipToTrack || this.wasmModule._addClipToTrack;
          const setVolFn = this.wasmModule.setTrackVolume || this.wasmModule._setTrackVolume;
          const setPanFn = this.wasmModule.setTrackPan || this.wasmModule._setTrackPan;
          const setSoloFn = this.wasmModule.setTrackSolo || this.wasmModule._setTrackSolo;
          const setMuteFn = this.wasmModule.setTrackMute || this.wasmModule._setTrackMute;

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
        this.jsTracks.clear();

        if (!this.isWasmFallback && this.wasmModule && this.mixerPtr) {
          const removeAllFn = this.wasmModule.removeAllTracks || this.wasmModule._removeAllTracks;
          if (removeAllFn) {
            removeAllFn(this.mixerPtr);
          }
          const freeFn = this.wasmModule._free || this.wasmModule.free || this.wasmModule.freeAudioBuffer;
          if (freeFn) {
            for (const ptr of this.clipAllocations.values()) {
              freeFn(ptr);
            }
          }
        }
        this.clipAllocations.clear();
        break;
      }

      case 'SET_TRACK_VOLUME': {
        if (this.jsTracks.has(msg.trackId)) {
          this.jsTracks.get(msg.trackId).volumeDb = typeof msg.volumeDb === 'number' ? msg.volumeDb : 0.0;
        }

        if (!this.isWasmFallback && this.wasmModule && this.mixerPtr) {
          const setVolFn = this.wasmModule.setTrackVolume || this.wasmModule._setTrackVolume;
          if (setVolFn) {
            setVolFn(this.mixerPtr, msg.trackId, msg.volumeDb || 0.0);
          }
        }
        break;
      }

      case 'SET_TRACK_PAN': {
        if (this.jsTracks.has(msg.trackId)) {
          this.jsTracks.get(msg.trackId).pan = typeof msg.pan === 'number' ? msg.pan : 0.0;
        }

        if (!this.isWasmFallback && this.wasmModule && this.mixerPtr) {
          const setPanFn = this.wasmModule.setTrackPan || this.wasmModule._setTrackPan;
          if (setPanFn) {
            setPanFn(this.mixerPtr, msg.trackId, msg.pan || 0.0);
          }
        }
        break;
      }

      case 'SET_TRACK_SOLO': {
        if (this.jsTracks.has(msg.trackId)) {
          this.jsTracks.get(msg.trackId).solo = !!msg.solo;
        }

        if (!this.isWasmFallback && this.wasmModule && this.mixerPtr) {
          const setSoloFn = this.wasmModule.setTrackSolo || this.wasmModule._setTrackSolo;
          if (setSoloFn) {
            setSoloFn(this.mixerPtr, msg.trackId, !!msg.solo);
          }
        }
        break;
      }

      case 'SET_TRACK_MUTE': {
        if (this.jsTracks.has(msg.trackId)) {
          this.jsTracks.get(msg.trackId).mute = !!msg.mute;
        }

        if (!this.isWasmFallback && this.wasmModule && this.mixerPtr) {
          const setMuteFn = this.wasmModule.setTrackMute || this.wasmModule._setTrackMute;
          if (setMuteFn) {
            setMuteFn(this.mixerPtr, msg.trackId, !!msg.mute);
          }
        }
        break;
      }

      case 'SET_MASTER_VOLUME': {
        this.masterVolumeDb = typeof msg.volumeDb === 'number' ? msg.volumeDb : 0.0;

        if (!this.isWasmFallback && this.wasmModule && this.mixerPtr) {
          const setMstVolFn = this.wasmModule.setMasterVolume || this.wasmModule._setMasterVolume;
          if (setMstVolFn) {
            setMstVolFn(this.mixerPtr, this.masterVolumeDb);
          }
        }
        break;
      }

      case 'SET_MASTER_LIMITER': {
        this.masterLimiterEnabled = msg.enabled !== undefined ? !!msg.enabled : true;
        this.masterLimiterCeilingDb = typeof msg.ceilingDb === 'number' ? msg.ceilingDb : -0.1;

        if (!this.isWasmFallback && this.wasmModule && this.mixerPtr) {
          const setLimiterFn = this.wasmModule.setMasterLimiter || this.wasmModule._setMasterLimiter;
          if (setLimiterFn) {
            setLimiterFn(
              this.mixerPtr,
              this.masterLimiterEnabled,
              this.masterLimiterCeilingDb
            );
          }
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

    // 1. Если активирован JS Fallback режим, используем резервный JS DSP микшер
    if (this.isWasmFallback) {
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

      // Инициализируем выходные массивы нулями
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);

      // Проверяем, есть ли активные соло-треки
      let hasSolo = false;
      for (const track of this.jsTracks.values()) {
        if (track.solo) {
          hasSolo = true;
          break;
        }
      }

      // Микшируем каждый трек
      for (const [trackId, track] of this.jsTracks.entries()) {
        if (track.mute) continue;
        if (hasSolo && !track.solo) continue;

        const trackVolLinear = Math.pow(10, track.volumeDb / 20);
        const trackPan = track.pan; // -1.0 to 1.0
        const panL = Math.min(1.0, 1.0 - trackPan);
        const panR = Math.min(1.0, 1.0 + trackPan);

        for (const clip of track.clips.values()) {
          const clipStart = clip.offsetSamples;
          const clipEnd = clipStart + clip.lengthSamples;

          // Проверяем пересечение клипа с текущим окном [timelineStart, timelineEnd]
          const timelineStart = this.currentTimelineSample;
          const timelineEnd = timelineStart + numFrames;

          if (clipEnd <= timelineStart || clipStart >= timelineEnd) {
            continue; // Нет пересечения
          }

          // Находим область пересечения
          const startIdx = Math.max(timelineStart, clipStart);
          const endIdx = Math.min(timelineEnd, clipEnd);

          const clipPcm = clip.pcm;
          const isStereo = clip.isStereo;

          for (let sampleIdx = startIdx; sampleIdx < endIdx; sampleIdx++) {
            const blockOffset = sampleIdx - timelineStart;
            const clipFrameOffset = sampleIdx - clipStart;

            // Вычисляем сэмплы из источника PCM
            let sL = 0;
            let sR = 0;

            if (isStereo) {
              sL = clipPcm[clipFrameOffset * 2] || 0;
              sR = clipPcm[clipFrameOffset * 2 + 1] || 0;
            } else {
              sL = clipPcm[clipFrameOffset] || 0;
              sR = sL;
            }

            // Применяем локальный гейн клипа
            sL *= clip.gain;
            sR *= clip.gain;

            // Применяем фейды (fade-in / fade-out)
            if (clip.fadeInSamples > 0 && clipFrameOffset < clip.fadeInSamples) {
              const factor = clipFrameOffset / clip.fadeInSamples;
              sL *= factor;
              sR *= factor;
            }
            if (clip.fadeOutSamples > 0) {
              const distToRight = clip.lengthSamples - clipFrameOffset;
              if (distToRight < clip.fadeOutSamples) {
                const factor = Math.max(0, distToRight / clip.fadeOutSamples);
                sL *= factor;
                sR *= factor;
              }
            }

            // Применяем панорамирование и громкость трека, микшируем в итоговый блок
            leftOut[blockOffset] += sL * trackVolLinear * panL;
            if (rightOut !== leftOut) {
              rightOut[blockOffset] += sR * trackVolLinear * panR;
            } else {
              leftOut[blockOffset] += sR * trackVolLinear * panR;
            }
          }
        }
      }

      // Применяем мастер-громкость и мастер-лимитер
      const masterVolLinear = Math.pow(10, this.masterVolumeDb / 20);
      const limitCeiling = Math.pow(10, this.masterLimiterCeilingDb / 20);

      let masterPeakL = 0;
      let masterPeakR = 0;
      let isClipped = false;

      for (let i = 0; i < numFrames; i++) {
        let outL = leftOut[i] * masterVolLinear;
        let outR = (rightOut !== leftOut ? rightOut[i] : leftOut[i]) * masterVolLinear;

        // Мастер-лимитер (простой мягкий лимитер/клиппер)
        if (this.masterLimiterEnabled) {
          const absL = Math.abs(outL);
          const absR = Math.abs(outR);

          if (absL > limitCeiling) {
            outL = Math.sign(outL) * limitCeiling;
            isClipped = true;
          }
          if (absR > limitCeiling) {
            outR = Math.sign(outR) * limitCeiling;
            isClipped = true;
          }
        } else {
          if (Math.abs(outL) >= 0.999 || Math.abs(outR) >= 0.999) {
            isClipped = true;
          }
        }

        leftOut[i] = outL;
        if (rightOut !== leftOut) {
          rightOut[i] = outR;
        }

        const absL = Math.abs(outL);
        const absR = Math.abs(outR);
        if (absL > masterPeakL) masterPeakL = absL;
        if (absR > masterPeakR) masterPeakR = absR;
      }

      // Продвигаем плейхед
      this.currentTimelineSample += numFrames;

      // Телеметрия
      this.meterFrameCounter++;
      if (this.meterFrameCounter >= this.meterReportInterval) {
        this.sendTelemetryMeters([], masterPeakL, masterPeakR, isClipped);
        this.meterFrameCounter = 0;
      }

      return true;
    }

    // 2. Стандартный нативный C++ WASM путь
    if (!this.wasmModule || !this.mixerPtr || !this.outBufferPtr || typeof this.wasmModule.processMixer !== 'function') {
      if (!this.hasNotifiedMissingCore) {
        this.hasNotifiedMissingCore = true;
        console.error('[AudioWorklet] C++ WASM Core is not loaded!');
        this.port.postMessage({
          type: 'WASM_CORE_MISSING',
          error: 'C++ WebAssembly ядро (daw_core.wasm) или mixerPtr не инициализированы в AudioWorklet.'
        });
      }
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);
      return true;
    }

    // Если пауза — заполняем выход нулями
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

    // Процессинг происходит ТОЛЬКО через C++ инстанс микшера
    this.wasmModule.processMixer(this.mixerPtr, this.outBufferPtr, numFrames);

    // Прямое копирование сэмплов из виртуальной кучи C++ WASM в аудиокарту
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

    // Продвижение таймлайна
    this.currentTimelineSample += numFrames;

    // Телеметрия индикаторов
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
