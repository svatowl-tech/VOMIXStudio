/**
 * ============================================================================
 * VOMIXSTUDIO HIGH-PERFORMANCE AUDIO WORKLET PROCESSOR (UNIVERSAL VST CONTRACT)
 * ============================================================================
 * Выполняется в выделенном высокоприоритетном аудиопотоке Web Audio API.
 * Все вычисления, микширование, цепочки VST2/VST3 плагинов и телеметрия
 * производятся исключительно в нативном C++ ядре через WebAssembly:
 *
 * 1. ZERO DUAL PROCESS: Вызовы микширования и сглаживания производятся строго
 *    в C++ движке (_processMixer). Ручные JS-циклы суммирования полностью исключены.
 * 2. C++ TELEMETRY: Прямой замер точных пиковых и RMS значений через _getTrackPeak и _getTrackRMS.
 * 3. THROTTLED CONTROL: Командный буфер с дедупликацией частых обновлений параметров
 *    (Volume, Pan, VST Params) для предотвращения микрозаиканий.
 * ============================================================================
 */

class DAWAudioEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.isPlaying = false;
    this.sampleRate = 48000;
    this.currentTimelineSample = 0;

    // Реестр JS дорожек, кэш аудиоданных клипов и указатели в куче WASM
    this.jsTracks = new Map();
    this.clipBufferCache = new Map();
    this.clipWasmPtrs = new Map(); // clipId -> wasmPtr

    // Реестр VST-слотов по стандарту Universal VST Contract (до 8 слотов на трек/шину)
    this.trackVstSlots = new Map(); // trackId -> Array[8]
    this.vocalBusVstSlots = new Array(8).fill(null);
    this.masterVstSlots = new Array(8).fill(null);

    // Состояние вокал-шины и мастер-секции
    this.vocalBus = {
      volumeDb: 0.0,
      pan: 0.0,
      mute: false,
      solo: false,
      vstPlugins: []
    };

    this.masterVolumeDb = 0.0;
    this.masterLimiterEnabled = true;
    this.masterLimiterCeilingDb = -0.1;
    this.masterVstPlugins = [];

    // WebAssembly C++ состояние
    this.isWasmReady = false;
    this.wasmModule = null;
    this.mixerPtr = 0;
    this.outBufferPtr = 0;
    this.outBufferCapacity = 512; // Емкость выходного стереобуфера в float

    // Троттлинг и буфер дедупликации частых команд управления (Volume, Pan, VST Params)
    this.pendingTrackVolumes = new Map(); // trackId -> volumeDb
    this.pendingTrackPans = new Map();    // trackId -> pan
    this.pendingMasterVolume = null;      // volumeDb
    this.pendingVocalBusVolume = null;    // volumeDb
    this.pendingVstParams = new Map();    // key -> { target, trackId, slotIdx, paramId, value }

    // Защита от спама в консоль
    this.hasReportedError = false;

    // Метрики и телеметрия уровней (metering + PDC)
    this.meterFrameCounter = 0;
    this.meterReportInterval = 15; // каждые ~40 мс (25 FPS) при блоке 128 сэмплов @ 48kHz

    // RT-Safe пул объектов телеметрии треков для предотвращения аллокаций памяти и пауз GC
    this.trackTelemetryPool = [];
    this.trackTelemetryList = [];
    this.vocalBusMeterTelemetry = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 };
    this.masterMeterTelemetry = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 };
    this.telemetryMessage = {
      type: 'METERS_TELEMETRY',
      currentTimeSec: 0,
      tracks: [],
      vocalBus: { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, latencySamples: 0, pdcMs: 0 },
      master: { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, clipped: false, latencySamples: 0, pdcMs: 0 },
      pdc: { sampleRate: this.sampleRate, vocalBusLatencySamples: 0, masterLatencySamples: 0 }
    };

    // Обработчик входящих команд хоста
    this.port.onmessage = (event) => this.handleHostMessage(event.data);

    // Уведомляем хост о готовности процессора
    this.port.postMessage({
      type: 'WORKLET_READY',
      sampleRate: this.sampleRate
    });
  }

  /**
   * Получение переиспользуемого объекта телеметрии трека из пула (RT-Safe, без аллокаций)
   */
  getTrackTelemetryItem(index) {
    if (index >= this.trackTelemetryPool.length) {
      this.trackTelemetryPool.push({
        trackId: 0,
        peakL: 0,
        peakR: 0,
        rmsL: 0,
        rmsR: 0,
        clipped: false,
        latencySamples: 0,
        pdcMs: 0
      });
    }
    return this.trackTelemetryPool[index];
  }

  /**
   * Чистая реализация Base64-кодирования для AudioWorkletGlobalScope
   */
  toBase64(str) {
    if (typeof btoa === 'function') {
      try {
        return btoa(unescape(encodeURIComponent(str)));
      } catch (_) {}
    }
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    let output = '';
    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;
    for (let i = 0; i < len; i += 3) {
      const b1 = bytes[i];
      const b2 = i + 1 < len ? bytes[i + 1] : 0;
      const b3 = i + 2 < len ? bytes[i + 2] : 0;

      const enc1 = b1 >> 2;
      const enc2 = ((b1 & 3) << 4) | (b2 >> 4);
      let enc3 = ((b2 & 15) << 2) | (b3 >> 6);
      let enc4 = b3 & 63;

      if (i + 1 >= len) {
        enc3 = 64;
        enc4 = 64;
      } else if (i + 2 >= len) {
        enc4 = 64;
      }
      output += chars.charAt(enc1) + chars.charAt(enc2) + chars.charAt(enc3) + chars.charAt(enc4);
    }
    return output;
  }

  /**
   * Инициализация WebAssembly ядра в контексте AudioWorklet
   */
  async initWasm(wasmBytes) {
    try {
      const wasmMemory = new WebAssembly.Memory({ initial: 512, maximum: 16384 }); // До 1ГБ кучи WASM
      const importObject = {
        env: {
          memory: wasmMemory,
          abort: (msg) => console.error('[AudioWorklet WASM Abort]', msg),
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
      const memoryBuffer = exports.memory ? exports.memory.buffer : wasmMemory.buffer;

      this.wasmModule = {
        HEAPF32: new Float32Array(memoryBuffer),
        HEAPU8: new Uint8Array(memoryBuffer),
        HEAP32: new Int32Array(memoryBuffer),
        _malloc: exports._malloc || exports.malloc,
        _free: exports._free || exports.free,
        ...exports
      };

      // Создаем нативный микшер в C++
      if (this.wasmModule._createMixerInstance) {
        this.mixerPtr = this.wasmModule._createMixerInstance(this.sampleRate);
      } else if (this.wasmModule.createMixerInstance) {
        this.mixerPtr = this.wasmModule.createMixerInstance(this.sampleRate);
      } else {
        this.mixerPtr = 0;
      }

      // Выделяем буфер под стерео аутпут (512 float = до 256 стереокадров)
      this.outBufferCapacity = 512;
      if (this.wasmModule._malloc) {
        this.outBufferPtr = this.wasmModule._malloc(this.outBufferCapacity * 4);
      }

      this.isWasmReady = true;

      // Применяем текущие глобальные настройки
      if (this.mixerPtr) {
        if (this.wasmModule._setMasterVolume) {
          this.wasmModule._setMasterVolume(this.mixerPtr, this.masterVolumeDb);
        }
        if (this.wasmModule._setMasterLimiter) {
          this.wasmModule._setMasterLimiter(this.mixerPtr, this.masterLimiterEnabled, this.masterLimiterCeilingDb);
        }
      }

      this.port.postMessage({
        type: 'WASM_INITIALIZED',
        success: true,
        mixerPtr: this.mixerPtr
      });
    } catch (err) {
      console.error('[AudioWorklet] Ошибка компиляции и инстанцирования WASM:', err);
      this.isWasmReady = false;
      this.port.postMessage({
        type: 'WASM_INITIALIZED',
        success: false,
        error: String(err && err.message ? err.message : err)
      });
    }
  }

  /**
   * Безопасное выделение памяти в куче WASM и копирование Float32Array данных.
   * Без искусственных ограничений по размеру (поддерживает многоминутные 24+ мин сессии).
   */
  allocateWasmBuffer(pcmData) {
    if (!this.wasmModule || !this.wasmModule._malloc || !pcmData || pcmData.length === 0) {
      return 0;
    }
    try {
      const bytesCount = pcmData.length * 4;
      const ptr = this.wasmModule._malloc(bytesCount);
      if (ptr) {
        // Проверяем: если this.wasmModule.HEAPF32.buffer !== memoryBuffer, обновляем типизированные представления HEAPF32, HEAPU8
        const memoryBuffer = this.wasmModule.memory
          ? this.wasmModule.memory.buffer
          : (this.wasmModule.buffer || (this.wasmModule.HEAPF32 ? this.wasmModule.HEAPF32.buffer : null));
        if (memoryBuffer && (!this.wasmModule.HEAPF32 || this.wasmModule.HEAPF32.buffer !== memoryBuffer)) {
          this.wasmModule.HEAPF32 = new Float32Array(memoryBuffer);
          this.wasmModule.HEAPU8 = new Uint8Array(memoryBuffer);
          this.wasmModule.HEAP32 = new Int32Array(memoryBuffer);
        }
        const heapF32 = this.wasmModule.HEAPF32;
        const floatOffset = ptr >> 2;

        // Чанковая запись больших буферов для избежания переполнения стека JS V8
        const CHUNK_SIZE = 1000000;
        if (pcmData.length > CHUNK_SIZE) {
          for (let offset = 0; offset < pcmData.length; offset += CHUNK_SIZE) {
            const end = Math.min(offset + CHUNK_SIZE, pcmData.length);
            const chunk = pcmData.subarray ? pcmData.subarray(offset, end) : pcmData.slice(offset, end);
            heapF32.set(chunk, floatOffset + offset);
          }
        } else {
          heapF32.set(pcmData, floatOffset);
        }
      }
      return ptr;
    } catch (err) {
      console.error('[AudioWorklet] Ошибка при выделении памяти WASM под клип:', err);
      return 0;
    }
  }

  /**
   * Проверка существования и автоматическое создание дорожки в C++ и JS микшере
   */
  ensureTrackExists(trackId, name, isOriginalAudio = false, volumeDb = 0.0, pan = 0.0, solo = false, mute = false) {
    if (!this.jsTracks.has(trackId)) {
      this.jsTracks.set(trackId, {
        id: trackId,
        name: name || `Track ${trackId}`,
        volumeDb: typeof volumeDb === 'number' ? volumeDb : 0.0,
        pan: typeof pan === 'number' ? pan : 0.0,
        solo: !!solo,
        mute: !!mute,
        isOriginalAudio: !!isOriginalAudio,
        vstPlugins: [],
        clips: new Map()
      });
    }

    const track = this.jsTracks.get(trackId);
    if (name) {
      track.name = name;
    }
    if (isOriginalAudio !== undefined) {
      track.isOriginalAudio = !!isOriginalAudio;
    }
    if (typeof volumeDb === 'number') {
      track.volumeDb = volumeDb;
    }
    if (typeof pan === 'number') {
      track.pan = pan;
    }
    if (solo !== undefined) {
      track.solo = !!solo;
    }
    if (mute !== undefined) {
      track.mute = !!mute;
    }

    if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
      const getTrackFn = this.wasmModule._getTrack || this.wasmModule.getTrack;
      const addTrackFn = this.wasmModule._addTrack || this.wasmModule.addTrack;

      let hasCppTrack = false;
      if (getTrackFn) {
        try {
          hasCppTrack = !!getTrackFn(this.mixerPtr, trackId);
        } catch (_) {}
      }

      if (!hasCppTrack && addTrackFn) {
        try {
          addTrackFn(this.mixerPtr, trackId, 0, !!track.isOriginalAudio);
        } catch (_) {}
      }

      if (this.wasmModule._setTrackVolume) {
        this.wasmModule._setTrackVolume(this.mixerPtr, trackId, track.volumeDb);
      }
      if (this.wasmModule._setTrackPan) {
        this.wasmModule._setTrackPan(this.mixerPtr, trackId, track.pan);
      }
      if (this.wasmModule._setTrackSolo) {
        this.wasmModule._setTrackSolo(this.mixerPtr, trackId, !!track.solo);
      }
      if (this.wasmModule._setTrackMute) {
        this.wasmModule._setTrackMute(this.mixerPtr, trackId, !!track.mute);
      }
      if (this.wasmModule._setTrackIsOriginalAudio) {
        this.wasmModule._setTrackIsOriginalAudio(this.mixerPtr, trackId, !!track.isOriginalAudio);
      }
    }

    return track;
  }

  /**
   * Освобождение памяти буфера клипа в куче WASM
   */
  freeWasmClipBuffer(clipId) {
    const ptr = this.clipWasmPtrs.get(clipId);
    if (ptr && this.wasmModule && this.wasmModule._free) {
      try {
        this.wasmModule._free(ptr);
      } catch (_) {}
      this.clipWasmPtrs.delete(clipId);
    }
  }

  /**
   * Сборщик мусора WASM-указателей
   */
  garbageCollectWasm() {
    if (!this.wasmModule || !this.wasmModule._free) return;
    const activeClipIds = new Set();
    for (const [, track] of this.jsTracks.entries()) {
      if (track && track.clips instanceof Map) {
        for (const [clipId] of track.clips.entries()) {
          activeClipIds.add(clipId);
        }
      }
    }

    for (const [clipId, ptr] of this.clipWasmPtrs.entries()) {
      if (!activeClipIds.has(clipId)) {
        try {
          this.wasmModule._free(ptr);
        } catch (e) {
          console.warn(`[AudioWorklet] Ошибка освобождения осиротевшего указателя #${clipId}:`, e);
        }
        this.clipWasmPtrs.delete(clipId);
        this.clipBufferCache.delete(clipId);
      }
    }
  }

  /**
   * Возвращает уникальный идентификатор типа плагина для C++ ядра
   */
  getPluginTypeId(pluginId) {
    switch (pluginId) {
      case 'vst-pro-q3': return 1;
      case 'vst-vocal-rider': return 2;
      case 'vst-cla-76':
      case 'vst-cla76': return 3;
      case 'vst-pro-r':
      case 'vst-valhalla-verb': return 4;
      case 'vst-ott':
      case 'vst-ott-multiband': return 5;
      case 'vst-saturation':
      case 'vst-decapitator': return 6;
      case 'vst-restoration':
      case 'vst-denoise': return 7;
      case 'vst-limiter':
      case 'vst-l2': return 8;
      default: return 1;
    }
  }

  /**
   * Преобразует строковый идентификатор параметра в числовой ID по Universal VST Contract
   */
  getParamIdAsNumber(pluginId, paramName) {
    if (typeof paramName === 'number') return paramName;
    const parsed = parseInt(paramName, 10);
    if (!isNaN(parsed)) return parsed;

    switch (pluginId) {
      case 'vst-pro-q3':
        switch (paramName) {
          case 'bypass': return 0;
          case 'hp_freq': return 1;
          case 'low_freq': return 2;
          case 'low_gain': return 3;
          case 'mid_freq': return 4;
          case 'mid_gain': return 5;
          case 'mid_q': return 6;
          case 'high_freq': return 7;
          case 'high_gain': return 8;
        }
        break;
      case 'vst-vocal-rider':
        switch (paramName) {
          case 'bypass': return 0;
          case 'target':
          case 'target_db': return 1;
          case 'sensitivity':
          case 'range':
          case 'range_db': return 2;
          case 'speed':
          case 'attack_ms': return 3;
        }
        break;
      case 'vst-cla-76':
      case 'vst-cla76':
        switch (paramName) {
          case 'bypass': return 0;
          case 'input': return 1;
          case 'output': return 2;
          case 'ratio': return 3;
          case 'attack': return 4;
          case 'release': return 5;
        }
        break;
      case 'vst-pro-r':
      case 'vst-valhalla-verb':
        switch (paramName) {
          case 'bypass': return 0;
          case 'decay': return 1;
          case 'mix': return 2;
          case 'predelay': return 3;
          case 'size': return 4;
          case 'brightness': return 5;
        }
        break;
      case 'vst-ott':
      case 'vst-ott-multiband':
        switch (paramName) {
          case 'bypass': return 0;
          case 'depth': return 1;
          case 'time': return 2;
          case 'inGain': return 3;
          case 'outGain': return 4;
        }
        break;
      case 'vst-saturation':
      case 'vst-decapitator':
        switch (paramName) {
          case 'bypass': return 0;
          case 'drive': return 1;
          case 'mix': return 2;
          case 'tone': return 3;
        }
        break;
      case 'vst-restoration':
      case 'vst-denoise':
        switch (paramName) {
          case 'bypass': return 0;
          case 'threshold': return 1;
          case 'reduction': return 2;
        }
        break;
      case 'vst-limiter':
      case 'vst-l2':
        switch (paramName) {
          case 'bypass': return 0;
          case 'ceiling': return 1;
          case 'threshold': return 2;
          case 'release': return 3;
        }
        break;
      default:
        break;
    }
    return 0;
  }

  getSlotsArray(target, trackId) {
    if (target === 'vocalBus' || trackId === 999) {
      return this.vocalBusVstSlots;
    }
    if (target === 'master' || trackId === 1000) {
      return this.masterVstSlots;
    }
    const tId = Number(trackId);
    if (!this.trackVstSlots.has(tId)) {
      this.trackVstSlots.set(tId, new Array(8).fill(null));
    }
    return this.trackVstSlots.get(tId);
  }

  findPluginByInstanceId(instanceId) {
    if (!instanceId) return null;

    for (const [trackId, slots] of this.trackVstSlots.entries()) {
      for (let i = 0; i < slots.length; i++) {
        const p = slots[i];
        if (p && p.instanceId === instanceId) {
          return { target: 'track', trackId, slotIdx: i, plugin: p };
        }
      }
    }

    for (let i = 0; i < this.vocalBusVstSlots.length; i++) {
      const p = this.vocalBusVstSlots[i];
      if (p && p.instanceId === instanceId) {
        return { target: 'vocalBus', trackId: 999, slotIdx: i, plugin: p };
      }
    }

    for (let i = 0; i < this.masterVstSlots.length; i++) {
      const p = this.masterVstSlots[i];
      if (p && p.instanceId === instanceId) {
        return { target: 'master', trackId: 1000, slotIdx: i, plugin: p };
      }
    }

    return null;
  }

  getTrackLatencySamples(trackId) {
    const slots = this.getSlotsArray('track', trackId);
    let totalLatency = 0;
    if (slots) {
      for (const p of slots) {
        if (p && p.enabled && typeof p.latencySamples === 'number') {
          totalLatency += p.latencySamples;
        }
      }
    }
    return totalLatency;
  }

  getVocalBusLatencySamples() {
    let totalLatency = 0;
    for (const p of this.vocalBusVstSlots) {
      if (p && p.enabled && typeof p.latencySamples === 'number') {
        totalLatency += p.latencySamples;
      }
    }
    return totalLatency;
  }

  getMasterLatencySamples() {
    let totalLatency = 0;
    for (const p of this.masterVstSlots) {
      if (p && p.enabled && typeof p.latencySamples === 'number') {
        totalLatency += p.latencySamples;
      }
    }
    return totalLatency;
  }

  flushPendingControlUpdates() {
    if (!this.isWasmReady || !this.wasmModule || !this.mixerPtr) return;

    if (this.pendingMasterVolume !== null) {
      if (this.wasmModule._setMasterVolume) {
        this.wasmModule._setMasterVolume(this.mixerPtr, this.pendingMasterVolume);
      }
      this.pendingMasterVolume = null;
    }

    if (this.pendingVocalBusVolume !== null) {
      if (this.wasmModule._setVocalBusVolume) {
        this.wasmModule._setVocalBusVolume(this.mixerPtr, this.pendingVocalBusVolume);
      }
      this.pendingVocalBusVolume = null;
    }

    if (this.pendingTrackVolumes.size > 0) {
      if (this.wasmModule._setTrackVolume) {
        for (const [trackId, vol] of this.pendingTrackVolumes.entries()) {
          this.wasmModule._setTrackVolume(this.mixerPtr, trackId, vol);
        }
      }
      this.pendingTrackVolumes.clear();
    }

    if (this.pendingTrackPans.size > 0) {
      if (this.wasmModule._setTrackPan) {
        for (const [trackId, pan] of this.pendingTrackPans.entries()) {
          this.wasmModule._setTrackPan(this.mixerPtr, trackId, pan);
        }
      }
      this.pendingTrackPans.clear();
    }

    if (this.pendingVstParams.size > 0) {
      for (const [, item] of this.pendingVstParams.entries()) {
        if (item.target === 'master' || item.trackId === 1000) {
          if (this.wasmModule._setMasterPluginParam) {
            this.wasmModule._setMasterPluginParam(this.mixerPtr, item.slotIdx, item.paramId, item.value);
          }
        } else {
          if (this.wasmModule._setTrackPluginParam) {
            this.wasmModule._setTrackPluginParam(this.mixerPtr, item.trackId, item.slotIdx, item.paramId, item.value);
          }
        }
      }
      this.pendingVstParams.clear();
    }
  }

  handleHostMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'INIT_WASM':
        if (msg.sampleRate && msg.sampleRate > 0) {
          this.sampleRate = msg.sampleRate;
        }
        if (msg.wasmBytes && msg.wasmBytes.byteLength > 0) {
          this.initWasm(msg.wasmBytes);
        }
        break;

      case 'PLAY':
        this.isPlaying = true;
        break;

      case 'PAUSE':
        this.isPlaying = false;
        break;

      case 'SEEK':
        this.currentTimelineSample = Math.max(0, Math.floor((msg.timeSec || 0) * this.sampleRate));
        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (this.wasmModule._setTimelinePosition) {
            this.wasmModule._setTimelinePosition(this.mixerPtr, this.currentTimelineSample);
          }
        }
        this.sendTelemetryMeters([], { peakL: 0, peakR: 0 }, 0, 0, false);
        break;

      case 'LOAD_VST_PLUGIN': {
        const { target, trackId, slotIdx, descriptor, instanceId, initialParams } = msg;
        const validSlotIdx = Math.max(0, Math.min(7, Number(slotIdx) || 0));
        const finalTrackId = Number(trackId) || 0;
        const slots = this.getSlotsArray(target, finalTrackId);

        const pluginId = descriptor ? descriptor.id : (msg.pluginId || 'vst-custom');
        const pluginInstanceId = instanceId || `${pluginId}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        const latencySamples = (descriptor && typeof descriptor.latencySamples === 'number') ? descriptor.latencySamples : 0;
        const pluginTypeId = this.getPluginTypeId(pluginId);

        const pluginInstance = {
          instanceId: pluginInstanceId,
          pluginId,
          descriptor: descriptor || null,
          slotIdx: validSlotIdx,
          trackId: finalTrackId,
          name: descriptor ? descriptor.name : (msg.name || 'VST Plugin'),
          category: descriptor ? descriptor.category : 'Utility',
          vendor: descriptor ? descriptor.vendor : 'VomixStudio',
          format: descriptor ? descriptor.format : 'VST3',
          enabled: true,
          bypassGain: 1.0,
          targetBypassGain: 1.0,
          wetDry: 1.0,
          targetWetDry: 1.0,
          latencySamples,
          parameters: {}
        };

        if (descriptor && Array.isArray(descriptor.parameters)) {
          for (const p of descriptor.parameters) {
            const numId = this.getParamIdAsNumber(pluginId, p.id);
            const normVal = (p.max > p.min)
              ? Math.max(0.0, Math.min(1.0, (p.defaultValue - p.min) / (p.max - p.min)))
              : 0.5;
            pluginInstance.parameters[numId] = normVal;
          }
        }

        if (initialParams && typeof initialParams === 'object') {
          for (const [k, v] of Object.entries(initialParams)) {
            const numId = this.getParamIdAsNumber(pluginId, k);
            pluginInstance.parameters[numId] = typeof v === 'number' ? Math.max(0.0, Math.min(1.0, v)) : 0.5;
          }
        }

        slots[validSlotIdx] = pluginInstance;

        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (target === 'master' || finalTrackId === 1000) {
            if (this.wasmModule._loadMasterPlugin) {
              try {
                this.wasmModule._loadMasterPlugin(this.mixerPtr, validSlotIdx, pluginTypeId);
              } catch (_) {}
            }
            if (this.wasmModule._setMasterPluginParam) {
              for (const [numId, normVal] of Object.entries(pluginInstance.parameters)) {
                try {
                  this.wasmModule._setMasterPluginParam(this.mixerPtr, validSlotIdx, Number(numId), Number(normVal));
                } catch (_) {}
              }
            }
          } else {
            if (this.wasmModule._loadTrackPlugin) {
              try {
                this.wasmModule._loadTrackPlugin(this.mixerPtr, finalTrackId, validSlotIdx, pluginTypeId);
              } catch (_) {}
            }
            if (this.wasmModule._setTrackPluginParam) {
              for (const [numId, normVal] of Object.entries(pluginInstance.parameters)) {
                try {
                  this.wasmModule._setTrackPluginParam(this.mixerPtr, finalTrackId, validSlotIdx, Number(numId), Number(normVal));
                } catch (_) {}
              }
            }
          }
        }

        if (this.jsTracks.has(finalTrackId)) {
          const track = this.jsTracks.get(finalTrackId);
          track.vstPlugins = slots.filter(Boolean);
        }

        this.port.postMessage({
          type: 'VST_PLUGIN_LOADED',
          trackId: finalTrackId,
          slotIdx: validSlotIdx,
          instanceId: pluginInstanceId,
          latencySamples
        });
        break;
      }

      case 'UPDATE_VST_PARAM': {
        const { target, trackId, instanceId, slotIdx, paramId, numericParamId, value } = msg;

        let targetInfo = null;
        if (instanceId) {
          targetInfo = this.findPluginByInstanceId(instanceId);
        }

        const resolvedTrackId = targetInfo ? targetInfo.trackId : (Number(trackId) || 0);
        const resolvedSlotIdx = targetInfo ? targetInfo.slotIdx : (Number(slotIdx) || 0);
        let activePlugin = targetInfo ? targetInfo.plugin : null;

        if (!activePlugin) {
          const slots = this.getSlotsArray(target, resolvedTrackId);
          if (slots && slots[resolvedSlotIdx]) {
            activePlugin = slots[resolvedSlotIdx];
          }
        }

        const pluginId = activePlugin ? activePlugin.pluginId : '';
        const finalNumericParamId = (typeof numericParamId === 'number')
          ? numericParamId
          : this.getParamIdAsNumber(pluginId, paramId);

        const normalizedValue = Math.max(0.0, Math.min(1.0, typeof value === 'number' ? value : 0.0));

        if (activePlugin) {
          if (!activePlugin.parameters) activePlugin.parameters = {};
          activePlugin.parameters[finalNumericParamId] = normalizedValue;
          if (typeof paramId === 'string') {
            activePlugin.parameters[paramId] = normalizedValue;
          }
        }

        const paramKey = `${target}_${resolvedTrackId}_${resolvedSlotIdx}_${finalNumericParamId}`;
        this.pendingVstParams.set(paramKey, {
          target,
          trackId: resolvedTrackId,
          slotIdx: resolvedSlotIdx,
          paramId: finalNumericParamId,
          value: normalizedValue
        });
        break;
      }

      case 'SET_VST_BYPASS': {
        const { target, trackId, instanceId, bypass, enabled } = msg;
        const isBypassed = (bypass !== undefined) ? !!bypass : (enabled !== undefined ? !enabled : false);

        let targetInfo = null;
        if (instanceId) {
          targetInfo = this.findPluginByInstanceId(instanceId);
        }

        const resolvedTrackId = targetInfo ? targetInfo.trackId : (Number(trackId) || 0);
        const resolvedSlotIdx = targetInfo ? targetInfo.slotIdx : 0;
        const activePlugin = targetInfo ? targetInfo.plugin : null;

        if (activePlugin) {
          activePlugin.enabled = !isBypassed;
          activePlugin.targetBypassGain = isBypassed ? 0.0 : 1.0;
        }

        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (target === 'master' || resolvedTrackId === 1000) {
            if (this.wasmModule._setMasterPluginBypass) {
              try {
                this.wasmModule._setMasterPluginBypass(this.mixerPtr, resolvedSlotIdx, isBypassed ? 1 : 0);
              } catch (_) {}
            }
          } else {
            if (this.wasmModule._setTrackPluginBypass) {
              try {
                this.wasmModule._setTrackPluginBypass(this.mixerPtr, resolvedTrackId, resolvedSlotIdx, isBypassed ? 1 : 0);
              } catch (_) {}
            }
          }
        }
        break;
      }

      case 'SET_VST_WET_DRY': {
        const { target, trackId, instanceId, wetDry } = msg;
        const normWetDry = Math.max(0.0, Math.min(1.0, typeof wetDry === 'number' ? wetDry : 1.0));

        let targetInfo = null;
        if (instanceId) {
          targetInfo = this.findPluginByInstanceId(instanceId);
        }

        const resolvedTrackId = targetInfo ? targetInfo.trackId : (Number(trackId) || 0);
        const resolvedSlotIdx = targetInfo ? targetInfo.slotIdx : 0;
        const activePlugin = targetInfo ? targetInfo.plugin : null;

        if (activePlugin) {
          activePlugin.wetDry = normWetDry;
          activePlugin.targetWetDry = normWetDry;
        }

        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (target === 'master' || resolvedTrackId === 1000) {
            if (this.wasmModule._setMasterPluginWetDry) {
              try {
                this.wasmModule._setMasterPluginWetDry(this.mixerPtr, resolvedSlotIdx, normWetDry);
              } catch (_) {}
            }
          } else {
            if (this.wasmModule._setTrackPluginWetDry) {
              try {
                this.wasmModule._setTrackPluginWetDry(this.mixerPtr, resolvedTrackId, resolvedSlotIdx, normWetDry);
              } catch (_) {}
            }
          }
        }
        break;
      }

      case 'SAVE_VST_CHUNK': {
        const { instanceId, requestId } = msg;
        const targetInfo = this.findPluginByInstanceId(instanceId);

        let chunkBase64 = '';
        if (targetInfo && targetInfo.plugin) {
          const p = targetInfo.plugin;
          const chunkData = {
            format: 'UniversalVSTContract-1.0',
            instanceId: p.instanceId,
            pluginId: p.pluginId,
            name: p.name,
            enabled: p.enabled,
            wetDry: p.wetDry,
            latencySamples: p.latencySamples,
            parameters: p.parameters || {},
            timestamp: Date.now()
          };
          chunkBase64 = this.toBase64(JSON.stringify(chunkData));
        }

        this.port.postMessage({
          type: 'VST_CHUNK_SAVED',
          requestId,
          instanceId,
          chunk: chunkBase64
        });
        break;
      }

      // ======================================================================
      // LOAD_TRACK_CLIP: Загрузка клипа с гарантированным созданием дорожки C++
      // ======================================================================
      case 'LOAD_TRACK_CLIP': {
        const trackId = Number(msg.trackId) || 0;
        const clipId = typeof msg.clipId === 'number' ? msg.clipId : (msg.clipId ? Number(msg.clipId) : Date.now());
        const pcmBuffer = msg.audioData || msg.pcmBuffer || msg.pcm || new Float32Array(0);
        const isStereo = msg.isStereo !== undefined ? !!msg.isStereo : true;
        const lengthSamples = msg.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
        const offsetSamples = typeof msg.offsetSamples === 'number'
          ? msg.offsetSamples
          : (typeof msg.offsetSec === 'number' ? Math.round(msg.offsetSec * this.sampleRate) : 0);
        const gain = typeof msg.gain === 'number' ? msg.gain : 1.0;
        const pan = typeof msg.pan === 'number' ? msg.pan : 0.0;
        const fadeIn = msg.fadeInSamples || 0;
        const fadeOut = msg.fadeOutSamples || 0;

        if (pcmBuffer.length > 0) {
          this.clipBufferCache.set(clipId, pcmBuffer);
        }

        // Гарантируем создание дорожки в C++ и JS с нужным флагом isOriginalAudio
        const isOriginalAudio = msg.isOriginalAudio !== undefined ? !!msg.isOriginalAudio : false;
        const track = this.ensureTrackExists(
          trackId,
          msg.trackName || `Track ${trackId}`,
          isOriginalAudio,
          typeof msg.trackVolumeDb === 'number' ? msg.trackVolumeDb : 0.0,
          typeof msg.trackPan === 'number' ? msg.trackPan : 0.0,
          !!msg.trackSolo,
          !!msg.trackMute
        );

        const cachedPcm = pcmBuffer.length > 0 ? pcmBuffer : (this.clipBufferCache.get(clipId) || new Float32Array(0));

        track.clips.set(clipId, {
          pcm: cachedPcm,
          offsetSamples,
          lengthSamples,
          gain,
          pan,
          fadeInSamples: fadeIn,
          fadeOutSamples: fadeOut,
          isStereo
        });

        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          const getTrackFn = this.wasmModule._getTrack || this.wasmModule.getTrack;
          const addTrackFn = this.wasmModule._addTrack || this.wasmModule.addTrack;
          if (getTrackFn && addTrackFn) {
            try {
              if (!getTrackFn(this.mixerPtr, trackId)) {
                addTrackFn(this.mixerPtr, trackId, 0, isOriginalAudio);
              }
            } catch (_) {}
          }

          let bufferPtr = this.clipWasmPtrs.get(clipId);
          if (cachedPcm.length > 0) {
            if (!bufferPtr) {
              bufferPtr = this.allocateWasmBuffer(cachedPcm);
              if (bufferPtr) {
                this.clipWasmPtrs.set(clipId, bufferPtr);
              }
            }

            if (bufferPtr) {
              const addClipFn = this.wasmModule._addClipToTrack || this.wasmModule.addClipToTrack;
              if (addClipFn) {
                addClipFn(
                  this.mixerPtr,
                  trackId,
                  clipId,
                  bufferPtr,
                  cachedPcm.length,
                  offsetSamples,
                  lengthSamples,
                  gain,
                  pan,
                  fadeIn,
                  fadeOut,
                  isStereo
                );
              }
            } else {
              console.warn(`[AudioWorklet] Не удалось выделить WASM память под клип ${clipId} (${cachedPcm.length} сэмплов)`);
            }
          }
        }

        this.port.postMessage({
          type: 'CLIP_LOADED_SUCCESS',
          trackId,
          clipId,
          lengthSamples,
          wasmPtr: this.clipWasmPtrs.get(clipId) || 0
        });
        break;
      }

      // ======================================================================
      // LOAD_CLIPS_BATCH: Пакетная загрузка нарезанных клипов (Batch Clip Insertion)
      // Предотвращает лавину вызовов postMessage и DataCloneError
      // ======================================================================
      case 'LOAD_CLIPS_BATCH': {
        const trackId = Number(msg.trackId) || 0;
        const clips = Array.isArray(msg.clips) ? msg.clips : [];
        const isOriginalAudio = msg.isOriginalAudio !== undefined ? !!msg.isOriginalAudio : false;
        const track = this.ensureTrackExists(
          trackId,
          msg.trackName || `Track ${trackId}`,
          isOriginalAudio,
          typeof msg.trackVolumeDb === 'number' ? msg.trackVolumeDb : 0.0,
          typeof msg.trackPan === 'number' ? msg.trackPan : 0.0,
          !!msg.trackSolo,
          !!msg.trackMute
        );

        if (msg.replaceTrackClips || msg.clearExisting) {
          track.clips.clear();
        }

        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          const getTrackFn = this.wasmModule._getTrack || this.wasmModule.getTrack;
          const addTrackFn = this.wasmModule._addTrack || this.wasmModule.addTrack;
          if (getTrackFn && addTrackFn) {
            try {
              if (!getTrackFn(this.mixerPtr, trackId)) {
                addTrackFn(this.mixerPtr, trackId, 0, isOriginalAudio);
              }
            } catch (_) {}
          }
        }

        let loadedCount = 0;
        for (const c of clips) {
          if (!c || (typeof c.id !== 'number' && typeof c.clipId !== 'number')) continue;
          const clipId = typeof c.clipId === 'number' ? c.clipId : c.id;
          const parentId = c.parentClipId || c.originalClipId || c.sourceClipId;

          // Если клипы нарезаны из родительского клипа, исключаем родителя из воспроизведения
          if (parentId && track.clips.has(parentId)) {
            track.clips.delete(parentId);
          }

          let pcmBuffer = null;
          if (c.buffer && c.buffer.length > 0) {
            pcmBuffer = c.buffer;
          } else if (c.audioData && c.audioData.length > 0) {
            pcmBuffer = c.audioData;
          } else if (this.clipBufferCache.has(clipId)) {
            pcmBuffer = this.clipBufferCache.get(clipId);
          } else if (parentId && this.clipBufferCache.has(parentId)) {
            // Быстрое извлечение подбуфера из родительского кеша со смещением
            const parentBuf = this.clipBufferCache.get(parentId);
            const isStereo = c.isStereo !== undefined ? !!c.isStereo : (parentBuf.length >= (c.lengthSamples || 0) * 2);
            const channels = isStereo ? 2 : 1;
            const bufferOffsetSamples = c.bufferOffsetSamples || c.segOffsetInClip || c.startSample || 0;
            const lengthSamples = c.lengthSamples || Math.floor((parentBuf.length - bufferOffsetSamples * channels) / channels);
            const startIdx = Math.max(0, bufferOffsetSamples * channels);
            const totalLen = Math.max(0, lengthSamples * channels);
            if (startIdx < parentBuf.length) {
              pcmBuffer = parentBuf.subarray(startIdx, Math.min(parentBuf.length, startIdx + totalLen));
            }
          }

          if (pcmBuffer && pcmBuffer.length > 0) {
            this.clipBufferCache.set(clipId, pcmBuffer);
          } else {
            pcmBuffer = new Float32Array(0);
          }

          const isStereo = c.isStereo !== undefined ? !!c.isStereo : true;
          const lengthSamples = c.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
          const offsetSamples = typeof c.offsetSamples === 'number' ? c.offsetSamples : 0;
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

          if (this.isWasmReady && this.wasmModule && this.mixerPtr && pcmBuffer.length > 0) {
            let bufferPtr = this.clipWasmPtrs.get(clipId);
            if (!bufferPtr) {
              bufferPtr = this.allocateWasmBuffer(pcmBuffer);
              if (bufferPtr) {
                this.clipWasmPtrs.set(clipId, bufferPtr);
              }
            }

            if (bufferPtr) {
              const addClipFn = this.wasmModule._addClipToTrack || this.wasmModule.addClipToTrack;
              if (addClipFn) {
                addClipFn(
                  this.mixerPtr,
                  trackId,
                  clipId,
                  bufferPtr,
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
          loadedCount++;
        }

        // Единый групповой ACK для снижения нагрузки на MessagePort
        this.port.postMessage({
          type: 'CLIPS_BATCH_LOADED_SUCCESS',
          trackId,
          count: loadedCount
        });
        break;
      }

      case 'UPDATE_TRACK': {
        const trackMsg = msg.track;
        if (!trackMsg || typeof trackMsg.id !== 'number') break;
        const trackId = trackMsg.id;

        const track = this.ensureTrackExists(
          trackId,
          trackMsg.name || `Track ${trackId}`,
          trackMsg.isOriginalAudio,
          trackMsg.volumeDb,
          trackMsg.pan,
          trackMsg.solo,
          trackMsg.mute
        );

        if (typeof trackMsg.volumeDb === 'number') {
          track.volumeDb = trackMsg.volumeDb;
          this.pendingTrackVolumes.set(trackId, trackMsg.volumeDb);
        }
        if (typeof trackMsg.pan === 'number') {
          track.pan = trackMsg.pan;
          this.pendingTrackPans.set(trackId, trackMsg.pan);
        }
        if (typeof trackMsg.solo === 'boolean') {
          track.solo = trackMsg.solo;
          if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setTrackSolo) {
            this.wasmModule._setTrackSolo(this.mixerPtr, trackId, trackMsg.solo);
          }
        }
        if (typeof trackMsg.mute === 'boolean') {
          track.mute = trackMsg.mute;
          if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setTrackMute) {
            this.wasmModule._setTrackMute(this.mixerPtr, trackId, trackMsg.mute);
          }
        }

        if (Array.isArray(trackMsg.clips)) {
          for (const c of trackMsg.clips) {
            if (!c || typeof c.id !== 'number') continue;
            let pcmBuffer = (c.buffer && c.buffer.length > 0) ? c.buffer : (this.clipBufferCache.get(c.id) || null);
            if (pcmBuffer && pcmBuffer.length > 0) {
              this.clipBufferCache.set(c.id, pcmBuffer);
              if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
                let bufferPtr = this.clipWasmPtrs.get(c.id);
                if (!bufferPtr && pcmBuffer.length > 0) {
                  bufferPtr = this.allocateWasmBuffer(pcmBuffer);
                  if (bufferPtr) {
                    this.clipWasmPtrs.set(c.id, bufferPtr);
                  }
                }
                if (bufferPtr) {
                  const isStereo = c.isStereo !== undefined ? !!c.isStereo : (pcmBuffer.length >= (c.lengthSamples || 0) * 2);
                  const lengthSamples = c.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
                  const addClipFn = this.wasmModule._addClipToTrack || this.wasmModule.addClipToTrack;
                  if (addClipFn) {
                    addClipFn(
                      this.mixerPtr,
                      trackId,
                      c.id,
                      bufferPtr,
                      pcmBuffer.length,
                      c.offsetSamples || 0,
                      lengthSamples,
                      typeof c.gain === 'number' ? c.gain : 1.0,
                      typeof c.pan === 'number' ? c.pan : 0.0,
                      c.fadeInSamples || 0,
                      c.fadeOutSamples || 0,
                      isStereo
                    );
                  }
                }
              }
            }
          }
        }
        this.garbageCollectWasm();
        break;
      }

      case 'FREE_CLIP_BUFFER': {
        const { clipId } = msg;
        if (typeof clipId === 'number') {
          this.freeWasmClipBuffer(clipId);
          this.clipBufferCache.delete(clipId);
        }
        break;
      }

      case 'GARBAGE_COLLECT_WASM': {
        this.garbageCollectWasm();
        break;
      }

      // ======================================================================
      // SET_TRACK_CLIPS: Полная перестройка массива клипов с созданием дорожки C++
      // ======================================================================
      case 'SET_TRACK_CLIPS': {
        const trackId = Number(msg.trackId) || 0;
        const clips = Array.isArray(msg.clips) ? msg.clips : [];
        const isOriginalAudio = msg.isOriginalAudio !== undefined ? !!msg.isOriginalAudio : false;

        const track = this.ensureTrackExists(
          trackId,
          msg.trackName || `Track ${trackId}`,
          isOriginalAudio,
          typeof msg.volumeDb === 'number' ? msg.volumeDb : 0.0,
          typeof msg.pan === 'number' ? msg.pan : 0.0,
          !!msg.solo,
          !!msg.mute
        );

        track.clips.clear();

        for (const c of clips) {
          let pcmBuffer = (c.buffer && c.buffer.length > 0) ? c.buffer : null;
          if (!pcmBuffer) {
            pcmBuffer = this.clipBufferCache.get(c.id);
          }
          if (!pcmBuffer && c.originalClipId) {
            pcmBuffer = this.clipBufferCache.get(c.originalClipId);
          }
          if (!pcmBuffer && (c.parentClipId || c.sourceClipId)) {
            const parentId = c.parentClipId || c.sourceClipId;
            const parentBuf = this.clipBufferCache.get(parentId);
            if (parentBuf) {
              const isStereo = c.isStereo !== undefined ? !!c.isStereo : true;
              const channels = isStereo ? 2 : 1;
              const bufferOffsetSamples = c.bufferOffsetSamples || c.segOffsetInClip || c.startSample || 0;
              const lengthSamples = c.lengthSamples || Math.floor((parentBuf.length - bufferOffsetSamples * channels) / channels);
              const startIdx = Math.max(0, bufferOffsetSamples * channels);
              const totalLen = Math.max(0, lengthSamples * channels);
              if (startIdx < parentBuf.length) {
                pcmBuffer = parentBuf.subarray(startIdx, Math.min(parentBuf.length, startIdx + totalLen));
              }
            }
          }

          if (pcmBuffer && pcmBuffer.length > 0) {
            this.clipBufferCache.set(c.id, pcmBuffer);
          } else {
            continue;
          }

          const isStereo = c.isStereo !== undefined ? !!c.isStereo : true;
          const lengthSamples = c.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
          const offsetSamples = c.offsetSamples || 0;
          const gain = typeof c.gain === 'number' ? c.gain : 1.0;
          const pan = typeof c.pan === 'number' ? c.pan : 0.0;
          const fadeIn = c.fadeInSamples || 0;
          const fadeOut = c.fadeOutSamples || 0;

          track.clips.set(c.id, {
            pcm: pcmBuffer,
            offsetSamples,
            lengthSamples,
            gain,
            pan,
            fadeInSamples: fadeIn,
            fadeOutSamples: fadeOut,
            isStereo
          });

          if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
            const getTrackFn = this.wasmModule._getTrack || this.wasmModule.getTrack;
            const addTrackFn = this.wasmModule._addTrack || this.wasmModule.addTrack;
            if (getTrackFn && addTrackFn) {
              try {
                if (!getTrackFn(this.mixerPtr, trackId)) {
                  addTrackFn(this.mixerPtr, trackId, 0, isOriginalAudio);
                }
              } catch (_) {}
            }

            let bufferPtr = this.clipWasmPtrs.get(c.id);
            if (!bufferPtr && pcmBuffer.length > 0) {
              bufferPtr = this.allocateWasmBuffer(pcmBuffer);
              if (bufferPtr) {
                this.clipWasmPtrs.set(c.id, bufferPtr);
              }
            }

            if (bufferPtr) {
              const addClipFn = this.wasmModule._addClipToTrack || this.wasmModule.addClipToTrack;
              if (addClipFn) {
                addClipFn(
                  this.mixerPtr,
                  trackId,
                  c.id,
                  bufferPtr,
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
        this.garbageCollectWasm();
        break;
      }

      // ======================================================================
      // SET_ALL_TRACKS: Синхронизация всех дорожек с созданием C++ объектов
      // ======================================================================
      case 'SET_ALL_TRACKS': {
        const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
        this.jsTracks.clear();

        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (this.wasmModule._removeAllTracks) {
            this.wasmModule._removeAllTracks(this.mixerPtr);
          }
        }

        for (const t of tracks) {
          const trackId = Number(t.id) || 0;
          const isOriginal = !!t.isOriginalAudio;

          const track = this.ensureTrackExists(
            trackId,
            t.name || `Track ${trackId}`,
            isOriginal,
            typeof t.volumeDb === 'number' ? t.volumeDb : 0.0,
            typeof t.pan === 'number' ? t.pan : 0.0,
            !!t.solo,
            !!t.mute
          );

          if (Array.isArray(t.clips)) {
            for (const c of t.clips) {
              let pcmBuffer = (c.buffer && c.buffer.length > 0) ? c.buffer : null;
              if (!pcmBuffer) {
                pcmBuffer = this.clipBufferCache.get(c.id);
              }
              if (!pcmBuffer && c.originalClipId) {
                pcmBuffer = this.clipBufferCache.get(c.originalClipId);
              }
              if (!pcmBuffer && (c.parentClipId || c.sourceClipId)) {
                const parentId = c.parentClipId || c.sourceClipId;
                const parentBuf = this.clipBufferCache.get(parentId);
                if (parentBuf) {
                  const isStereo = c.isStereo !== undefined ? !!c.isStereo : true;
                  const channels = isStereo ? 2 : 1;
                  const bufferOffsetSamples = c.bufferOffsetSamples || c.segOffsetInClip || c.startSample || 0;
                  const lengthSamples = c.lengthSamples || Math.floor((parentBuf.length - bufferOffsetSamples * channels) / channels);
                  const startIdx = Math.max(0, bufferOffsetSamples * channels);
                  const totalLen = Math.max(0, lengthSamples * channels);
                  if (startIdx < parentBuf.length) {
                    pcmBuffer = parentBuf.subarray(startIdx, Math.min(parentBuf.length, startIdx + totalLen));
                  }
                }
              }

              if (pcmBuffer && pcmBuffer.length > 0) {
                this.clipBufferCache.set(c.id, pcmBuffer);
              } else {
                continue;
              }

              const isStereo = c.isStereo !== undefined ? !!c.isStereo : true;
              const lengthSamples = c.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
              const offsetSamples = c.offsetSamples || 0;
              const gain = typeof c.gain === 'number' ? c.gain : 1.0;
              const pan = typeof c.pan === 'number' ? c.pan : 0.0;
              const fadeIn = c.fadeInSamples || 0;
              const fadeOut = c.fadeOutSamples || 0;

              track.clips.set(c.id, {
                pcm: pcmBuffer,
                offsetSamples,
                lengthSamples,
                gain,
                pan,
                fadeInSamples: fadeIn,
                fadeOutSamples: fadeOut,
                isStereo
              });

              if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
                const getTrackFn = this.wasmModule._getTrack || this.wasmModule.getTrack;
                const addTrackFn = this.wasmModule._addTrack || this.wasmModule.addTrack;
                if (getTrackFn && addTrackFn) {
                  try {
                    if (!getTrackFn(this.mixerPtr, trackId)) {
                      addTrackFn(this.mixerPtr, trackId, 0, isOriginal);
                    }
                  } catch (_) {}
                }

                let bufferPtr = this.clipWasmPtrs.get(c.id);
                if (!bufferPtr && pcmBuffer.length > 0) {
                  bufferPtr = this.allocateWasmBuffer(pcmBuffer);
                  if (bufferPtr) {
                    this.clipWasmPtrs.set(c.id, bufferPtr);
                  }
                }

                if (bufferPtr) {
                  const addClipFn = this.wasmModule._addClipToTrack || this.wasmModule.addClipToTrack;
                  if (addClipFn) {
                    addClipFn(
                      this.mixerPtr,
                      trackId,
                      c.id,
                      bufferPtr,
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
          }

          if (Array.isArray(t.vstPlugins)) {
            const slots = this.getSlotsArray('track', trackId);
            t.vstPlugins.forEach((p, idx) => {
              if (idx < 8 && p) {
                const pluginTypeId = this.getPluginTypeId(p.pluginId);
                slots[idx] = {
                  instanceId: p.instanceId || `${p.pluginId}-${idx}`,
                  pluginId: p.pluginId,
                  slotIdx: idx,
                  trackId,
                  name: p.name || 'VST Plugin',
                  category: p.category || 'Utility',
                  vendor: p.vendor || 'VomixStudio',
                  format: p.format || 'VST3',
                  enabled: p.enabled !== false,
                  bypassGain: p.enabled !== false ? 1.0 : 0.0,
                  targetBypassGain: p.enabled !== false ? 1.0 : 0.0,
                  wetDry: typeof p.wetDry === 'number' ? p.wetDry : 1.0,
                  targetWetDry: typeof p.wetDry === 'number' ? p.wetDry : 1.0,
                  latencySamples: p.latencySamples || 0,
                  parameters: p.parameters ? { ...p.parameters } : {}
                };

                if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._loadTrackPlugin) {
                  try {
                    this.wasmModule._loadTrackPlugin(this.mixerPtr, trackId, idx, pluginTypeId);
                    if (p.enabled === false && this.wasmModule._setTrackPluginBypass) {
                      this.wasmModule._setTrackPluginBypass(this.mixerPtr, trackId, idx, 1);
                    }
                    if (typeof p.wetDry === 'number' && this.wasmModule._setTrackPluginWetDry) {
                      this.wasmModule._setTrackPluginWetDry(this.mixerPtr, trackId, idx, p.wetDry);
                    }
                    if (p.parameters && this.wasmModule._setTrackPluginParam) {
                      for (const [k, v] of Object.entries(p.parameters)) {
                        const numId = this.getParamIdAsNumber(p.pluginId, k);
                        this.wasmModule._setTrackPluginParam(this.mixerPtr, trackId, idx, numId, Number(v));
                      }
                    }
                  } catch (_) {}
                }
              }
            });
          }
        }
        this.garbageCollectWasm();
        break;
      }

      case 'SET_TRACK_VOLUME': {
        const trackId = Number(msg.trackId) || 0;
        const volumeDb = typeof msg.volumeDb === 'number' ? msg.volumeDb : 0.0;
        const trk = this.ensureTrackExists(trackId, `Track ${trackId}`, false, volumeDb);
        trk.volumeDb = volumeDb;
        this.pendingTrackVolumes.set(trackId, volumeDb);
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setTrackVolume) {
          try {
            this.wasmModule._setTrackVolume(this.mixerPtr, trackId, volumeDb);
          } catch (_) {}
        }
        break;
      }

      case 'SET_TRACK_PAN': {
        const trackId = Number(msg.trackId) || 0;
        const pan = typeof msg.pan === 'number' ? msg.pan : 0.0;
        const trk = this.ensureTrackExists(trackId, `Track ${trackId}`, false, 0.0, pan);
        trk.pan = pan;
        this.pendingTrackPans.set(trackId, pan);
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setTrackPan) {
          try {
            this.wasmModule._setTrackPan(this.mixerPtr, trackId, pan);
          } catch (_) {}
        }
        break;
      }

      case 'SET_TRACK_SOLO': {
        const trackId = Number(msg.trackId) || 0;
        const solo = !!msg.solo;
        const trk = this.ensureTrackExists(trackId, `Track ${trackId}`);
        trk.solo = solo;
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setTrackSolo) {
          try {
            this.wasmModule._setTrackSolo(this.mixerPtr, trackId, solo);
          } catch (_) {}
        }
        break;
      }

      case 'SET_TRACK_MUTE': {
        const trackId = Number(msg.trackId) || 0;
        const mute = !!msg.mute;
        const trk = this.ensureTrackExists(trackId, `Track ${trackId}`);
        trk.mute = mute;
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setTrackMute) {
          try {
            this.wasmModule._setTrackMute(this.mixerPtr, trackId, mute);
          } catch (_) {}
        }
        break;
      }

      case 'SET_MASTER_VOLUME': {
        this.masterVolumeDb = typeof msg.volumeDb === 'number' ? msg.volumeDb : 0.0;
        this.pendingMasterVolume = this.masterVolumeDb;
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setMasterVolume) {
          try {
            this.wasmModule._setMasterVolume(this.mixerPtr, this.masterVolumeDb);
          } catch (_) {}
        }
        break;
      }

      case 'SET_MASTER_LIMITER': {
        this.masterLimiterEnabled = msg.enabled !== undefined ? !!msg.enabled : true;
        this.masterLimiterCeilingDb = typeof msg.ceilingDb === 'number' ? msg.ceilingDb : -0.1;
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setMasterLimiter) {
          this.wasmModule._setMasterLimiter(this.mixerPtr, this.masterLimiterEnabled, this.masterLimiterCeilingDb);
        }
        break;
      }

      case 'SET_TRACK_VST_CHAIN': {
        const trackId = Number(msg.trackId) || 0;
        const plugins = Array.isArray(msg.vstPlugins) ? msg.vstPlugins : [];
        const trk = this.ensureTrackExists(trackId, `Track ${trackId}`);
        trk.vstPlugins = plugins;
        const slots = this.getSlotsArray('track', trackId);
        slots.fill(null);
        plugins.forEach((p, idx) => {
          if (idx < 8 && p) {
            const pluginTypeId = this.getPluginTypeId(p.pluginId);
            slots[idx] = {
              instanceId: p.instanceId || `${p.pluginId}-${idx}`,
              pluginId: p.pluginId,
              slotIdx: idx,
              trackId,
              name: p.name || 'VST Plugin',
              category: p.category || 'Utility',
              vendor: p.vendor || 'VomixStudio',
              format: p.format || 'VST3',
              enabled: p.enabled !== false,
              bypassGain: p.enabled !== false ? 1.0 : 0.0,
              targetBypassGain: p.enabled !== false ? 1.0 : 0.0,
              wetDry: typeof p.wetDry === 'number' ? p.wetDry : 1.0,
              targetWetDry: typeof p.wetDry === 'number' ? p.wetDry : 1.0,
              latencySamples: p.latencySamples || 0,
              parameters: p.parameters ? { ...p.parameters } : {}
            };

            if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._loadTrackPlugin) {
              try {
                this.wasmModule._loadTrackPlugin(this.mixerPtr, trackId, idx, pluginTypeId);
                if (p.enabled === false && this.wasmModule._setTrackPluginBypass) {
                  this.wasmModule._setTrackPluginBypass(this.mixerPtr, trackId, idx, 1);
                }
                if (typeof p.wetDry === 'number' && this.wasmModule._setTrackPluginWetDry) {
                  this.wasmModule._setTrackPluginWetDry(this.mixerPtr, trackId, idx, p.wetDry);
                }
              } catch (_) {}
            }
          }
        });
        break;
      }

      case 'SET_VOCAL_BUS': {
        if (msg.vocalBus && typeof msg.vocalBus === 'object') {
          Object.assign(this.vocalBus, msg.vocalBus);
        }
        if (typeof msg.volumeDb === 'number') {
          this.vocalBus.volumeDb = msg.volumeDb;
          this.pendingVocalBusVolume = msg.volumeDb;
        }
        if (typeof msg.pan === 'number') {
          this.vocalBus.pan = msg.pan;
        }
        if (typeof msg.mute === 'boolean') {
          this.vocalBus.mute = msg.mute;
        }
        if (typeof msg.solo === 'boolean') {
          this.vocalBus.solo = msg.solo;
        }
        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (this.wasmModule._setVocalBusAutoDucker && this.vocalBus.autoDucker) {
            const ad = this.vocalBus.autoDucker;
            this.wasmModule._setVocalBusAutoDucker(
              this.mixerPtr,
              !!ad.enabled,
              typeof ad.thresholdDb === 'number' ? ad.thresholdDb : -30.0,
              typeof ad.duckDepthDb === 'number' ? ad.duckDepthDb : -12.0,
              typeof ad.attackMs === 'number' ? ad.attackMs : 15.0,
              typeof ad.releaseMs === 'number' ? ad.releaseMs : 350.0
            );
          }
        }
        break;
      }

      case 'SET_VOCAL_BUS_VST_CHAIN': {
        const plugins = Array.isArray(msg.vstPlugins) ? msg.vstPlugins : [];
        this.vocalBus.vstPlugins = plugins;
        this.vocalBusVstSlots.fill(null);
        plugins.forEach((p, idx) => {
          if (idx < 8 && p) {
            const pluginTypeId = this.getPluginTypeId(p.pluginId);
            this.vocalBusVstSlots[idx] = {
              instanceId: p.instanceId || `${p.pluginId}-${idx}`,
              pluginId: p.pluginId,
              slotIdx: idx,
              trackId: 999,
              name: p.name || 'VST Plugin',
              category: p.category || 'Utility',
              vendor: p.vendor || 'VomixStudio',
              format: p.format || 'VST3',
              enabled: p.enabled !== false,
              bypassGain: p.enabled !== false ? 1.0 : 0.0,
              targetBypassGain: p.enabled !== false ? 1.0 : 0.0,
              wetDry: typeof p.wetDry === 'number' ? p.wetDry : 1.0,
              targetWetDry: typeof p.wetDry === 'number' ? p.wetDry : 1.0,
              latencySamples: p.latencySamples || 0,
              parameters: p.parameters ? { ...p.parameters } : {}
            };

            if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._loadTrackPlugin) {
              try {
                this.wasmModule._loadTrackPlugin(this.mixerPtr, 999, idx, pluginTypeId);
                if (p.enabled === false && this.wasmModule._setTrackPluginBypass) {
                  this.wasmModule._setTrackPluginBypass(this.mixerPtr, 999, idx, 1);
                }
                if (typeof p.wetDry === 'number' && this.wasmModule._setTrackPluginWetDry) {
                  this.wasmModule._setTrackPluginWetDry(this.mixerPtr, 999, idx, p.wetDry);
                }
              } catch (_) {}
            }
          }
        });
        break;
      }

      case 'SET_MASTER_VST_CHAIN': {
        const plugins = Array.isArray(msg.vstPlugins) ? msg.vstPlugins : [];
        this.masterVstPlugins = plugins;
        this.masterVstSlots.fill(null);
        plugins.forEach((p, idx) => {
          if (idx < 8 && p) {
            const pluginTypeId = this.getPluginTypeId(p.pluginId);
            this.masterVstSlots[idx] = {
              instanceId: p.instanceId || `${p.pluginId}-${idx}`,
              pluginId: p.pluginId,
              slotIdx: idx,
              trackId: 1000,
              name: p.name || 'VST Plugin',
              category: p.category || 'Utility',
              vendor: p.vendor || 'VomixStudio',
              format: p.format || 'VST3',
              enabled: p.enabled !== false,
              bypassGain: p.enabled !== false ? 1.0 : 0.0,
              targetBypassGain: p.enabled !== false ? 1.0 : 0.0,
              wetDry: typeof p.wetDry === 'number' ? p.wetDry : 1.0,
              targetWetDry: typeof p.wetDry === 'number' ? p.wetDry : 1.0,
              latencySamples: p.latencySamples || 0,
              parameters: p.parameters ? { ...p.parameters } : {}
            };

            if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._loadMasterPlugin) {
              try {
                this.wasmModule._loadMasterPlugin(this.mixerPtr, idx, pluginTypeId);
                if (p.enabled === false && this.wasmModule._setMasterPluginBypass) {
                  this.wasmModule._setMasterPluginBypass(this.mixerPtr, idx, 1);
                }
                if (typeof p.wetDry === 'number' && this.wasmModule._setMasterPluginWetDry) {
                  this.wasmModule._setMasterPluginWetDry(this.mixerPtr, idx, p.wetDry);
                }
              } catch (_) {}
            }
          }
        });
        break;
      }

      case 'CLEAR_TRACKS': {
        this.jsTracks.clear();
        this.clipBufferCache.clear();
        this.trackVstSlots.clear();
        this.vocalBusVstSlots.fill(null);
        this.masterVstSlots.fill(null);
        this.pendingTrackVolumes.clear();
        this.pendingTrackPans.clear();
        this.pendingVstParams.clear();
        this.pendingMasterVolume = null;
        this.pendingVocalBusVolume = null;
        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (this.wasmModule._removeAllTracks) {
            this.wasmModule._removeAllTracks(this.mixerPtr);
          }
          for (const [, ptr] of this.clipWasmPtrs.entries()) {
            try {
              if (this.wasmModule._free) this.wasmModule._free(ptr);
            } catch (_) {}
          }
          this.clipWasmPtrs.clear();
        }
        break;
      }

      default:
        break;
    }
  }

  smoothPluginGainRamps() {
    const smoothCoeff = 0.08;

    const processSlot = (p) => {
      if (!p) return;
      if (Math.abs(p.targetBypassGain - p.bypassGain) > 0.0001) {
        p.bypassGain += (p.targetBypassGain - p.bypassGain) * smoothCoeff;
      } else {
        p.bypassGain = p.targetBypassGain;
      }

      if (Math.abs(p.targetWetDry - p.wetDry) > 0.0001) {
        p.wetDry += (p.targetWetDry - p.wetDry) * smoothCoeff;
      } else {
        p.wetDry = p.targetWetDry;
      }
    };

    for (const slots of this.trackVstSlots.values()) {
      for (const p of slots) processSlot(p);
    }
    for (const p of this.vocalBusVstSlots) processSlot(p);
    for (const p of this.masterVstSlots) processSlot(p);
  }

  /**
   * Основной высокопроизводительный аудиоколбэк (RT-Safe, 128 сэмплов)
   */
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const leftOut = output[0];
    const rightOut = output[1] || leftOut;
    const numFrames = leftOut.length;

    this.smoothPluginGainRamps();

    if (!this.isPlaying) {
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);

      this.meterFrameCounter++;
      if (this.meterFrameCounter >= 30) {
        this.sendTelemetryMeters([], { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 }, { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 }, false);
        this.meterFrameCounter = 0;
      }
      return true;
    }

    if (!this.isWasmReady || !this.wasmModule || !this.mixerPtr) {
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);

      // Проигрывание дорожек через JS DSP, если нативное C++ ядро не готово
      const anySolo = Array.from(this.jsTracks.values()).some((t) => t && t.solo);

      for (const [, tr] of this.jsTracks.entries()) {
        if (!tr || tr.mute) continue;
        if (anySolo && !tr.solo) continue;

        const trGain = Math.pow(10, (tr.volumeDb || 0) / 20);
        let trPanL = 1.0, trPanR = 1.0;
        const pan = tr.pan || 0;
        const angle = (pan + 1.0) * (Math.PI / 4.0);
        trPanL = Math.cos(angle);
        trPanR = Math.sin(angle);

        for (const [, cl] of tr.clips.entries()) {
          const pcm = cl.pcm;
          if (!pcm || pcm.length === 0) continue;

          const clipStart = cl.offsetSamples || 0;
          const clipFrames = cl.lengthSamples || (cl.isStereo ? Math.floor(pcm.length / 2) : pcm.length);
          const clipEnd = clipStart + clipFrames;

          if (this.currentTimelineSample + numFrames <= clipStart || this.currentTimelineSample >= clipEnd) {
            continue;
          }

          const overlapStart = Math.max(this.currentTimelineSample, clipStart);
          const overlapEnd = Math.min(this.currentTimelineSample + numFrames, clipEnd);
          const destOffset = overlapStart - this.currentTimelineSample;
          const srcStart = overlapStart - clipStart;
          const frames = overlapEnd - overlapStart;
          const clipGain = (typeof cl.gain === 'number' ? cl.gain : 1.0) * trGain;

          for (let f = 0; f < frames; f++) {
            const sIdx = srcStart + f;
            if (cl.isStereo) {
              if (sIdx * 2 + 1 < pcm.length) {
                leftOut[destOffset + f] += pcm[sIdx * 2] * clipGain * trPanL;
                if (rightOut !== leftOut) {
                  rightOut[destOffset + f] += pcm[sIdx * 2 + 1] * clipGain * trPanR;
                }
              }
            } else {
              if (sIdx < pcm.length) {
                const s = pcm[sIdx] * clipGain;
                leftOut[destOffset + f] += s * trPanL;
                if (rightOut !== leftOut) {
                  rightOut[destOffset + f] += s * trPanR;
                }
              }
            }
          }
        }
      }

      this.currentTimelineSample += numFrames;

      this.meterFrameCounter++;
      if (this.meterFrameCounter >= this.meterReportInterval) {
        this.trackTelemetryList.length = 0;
        let tIdx = 0;
        for (const [trackId] of this.jsTracks.entries()) {
          const item = this.getTrackTelemetryItem(tIdx++);
          item.trackId = trackId;
          item.peakL = 0.5;
          item.peakR = 0.5;
          item.rmsL = 0.3;
          item.rmsR = 0.3;
          item.clipped = false;
          item.latencySamples = 0;
          item.pdcMs = 0;
          this.trackTelemetryList.push(item);
        }
        this.sendTelemetryMeters(
          this.trackTelemetryList,
          { peakL: 0.5, peakR: 0.5, rmsL: 0.3, rmsR: 0.3 },
          { peakL: 0.5, peakR: 0.5, rmsL: 0.3, rmsR: 0.3 },
          false
        );
        this.meterFrameCounter = 0;
      }
      return true;
    }

    try {
      this.flushPendingControlUpdates();

      const neededFloatSamples = numFrames * 2;
      if (neededFloatSamples > this.outBufferCapacity) {
        if (this.outBufferPtr && this.wasmModule._free) {
          this.wasmModule._free(this.outBufferPtr);
        }
        this.outBufferCapacity = neededFloatSamples * 2;
        if (this.wasmModule._malloc) {
          this.outBufferPtr = this.wasmModule._malloc(this.outBufferCapacity * 4);
        }
      }

      const processFn = this.wasmModule._processMixer || this.wasmModule.processMixer;
      if (processFn) {
        processFn(this.mixerPtr, this.outBufferPtr, numFrames);
      }

      if (this.wasmModule.memory) {
        this.wasmModule.HEAPF32 = new Float32Array(this.wasmModule.memory.buffer);
      }
      const heapF32 = this.wasmModule.HEAPF32;
      const floatOffset = this.outBufferPtr >> 2;

      if (rightOut !== leftOut) {
        for (let i = 0; i < numFrames; i++) {
          const idx = floatOffset + (i << 1);
          leftOut[i] = heapF32[idx];
          rightOut[i] = heapF32[idx + 1];
        }
      } else {
        for (let i = 0; i < numFrames; i++) {
          leftOut[i] = heapF32[floatOffset + (i << 1)];
        }
      }

      this.currentTimelineSample += numFrames;

      this.meterFrameCounter++;
      if (this.meterFrameCounter >= this.meterReportInterval) {
        const getPeakFn = this.wasmModule._getTrackPeak || this.wasmModule.getTrackPeak;
        const getRmsFn = this.wasmModule._getTrackRMS || this.wasmModule.getTrackRMS;

        this.trackTelemetryList.length = 0;
        let telemetryIndex = 0;

        if (getPeakFn && getRmsFn) {
          for (const [trackId] of this.jsTracks.entries()) {
            const peakL = getPeakFn(this.mixerPtr, trackId, 0);
            const peakR = getPeakFn(this.mixerPtr, trackId, 1);
            const rmsL = getRmsFn(this.mixerPtr, trackId, 0);
            const rmsR = getRmsFn(this.mixerPtr, trackId, 1);
            const latencySamples = this.getTrackLatencySamples(trackId);
            const pdcMs = Math.round(((latencySamples / this.sampleRate) * 1000) * 100) / 100;

            const item = this.getTrackTelemetryItem(telemetryIndex++);
            item.trackId = trackId;
            item.peakL = peakL;
            item.peakR = peakR;
            item.rmsL = rmsL;
            item.rmsR = rmsR;
            item.clipped = peakL >= 0.999 || peakR >= 0.999;
            item.latencySamples = latencySamples;
            item.pdcMs = pdcMs;
            this.trackTelemetryList.push(item);
          }

          const vbPeakL = getPeakFn(this.mixerPtr, 999, 0);
          const vbPeakR = getPeakFn(this.mixerPtr, 999, 1);
          const vbRmsL = getRmsFn(this.mixerPtr, 999, 0);
          const vbRmsR = getRmsFn(this.mixerPtr, 999, 1);
          this.vocalBusMeterTelemetry.peakL = vbPeakL;
          this.vocalBusMeterTelemetry.peakR = vbPeakR;
          this.vocalBusMeterTelemetry.rmsL = vbRmsL;
          this.vocalBusMeterTelemetry.rmsR = vbRmsR;

          const mPeakL = getPeakFn(this.mixerPtr, 1000, 0);
          const mPeakR = getPeakFn(this.mixerPtr, 1000, 1);
          const mRmsL = getRmsFn(this.mixerPtr, 1000, 0);
          const mRmsR = getRmsFn(this.mixerPtr, 1000, 1);
          this.masterMeterTelemetry.peakL = mPeakL;
          this.masterMeterTelemetry.peakR = mPeakR;
          this.masterMeterTelemetry.rmsL = mRmsL;
          this.masterMeterTelemetry.rmsR = mRmsR;

          const isClipped = mPeakL >= 0.999 || mPeakR >= 0.999;

          this.sendTelemetryMeters(
            this.trackTelemetryList,
            this.vocalBusMeterTelemetry,
            this.masterMeterTelemetry,
            isClipped
          );
        }
        this.meterFrameCounter = 0;
      }
    } catch (err) {
      if (!this.hasReportedError) {
        console.error('[AudioWorklet] Сбой в реалтайм аудиопотоке:', err);
        try {
          this.port.postMessage({
            type: 'WORKLET_PROCESS_ERROR',
            error: String(err && err.message ? err.message : err)
          });
        } catch (_) {}
        this.hasReportedError = true;
      }
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);
    }

    return true;
  }

  sendTelemetryMeters(trackMeters, vocalBusMeter, masterMeter, clipped) {
    const vocalBusLatency = this.getVocalBusLatencySamples();
    const masterLatency = this.getMasterLatencySamples();

    this.telemetryMessage.currentTimeSec = this.currentTimelineSample / this.sampleRate;
    this.telemetryMessage.tracks = trackMeters;

    const vb = this.telemetryMessage.vocalBus;
    vb.peakL = vocalBusMeter ? (vocalBusMeter.peakL || 0) : 0;
    vb.peakR = vocalBusMeter ? (vocalBusMeter.peakR || 0) : 0;
    vb.rmsL = vocalBusMeter ? (vocalBusMeter.rmsL || 0) : 0;
    vb.rmsR = vocalBusMeter ? (vocalBusMeter.rmsR || 0) : 0;
    vb.latencySamples = vocalBusLatency;
    vb.pdcMs = Math.round(((vocalBusLatency / this.sampleRate) * 1000) * 100) / 100;

    const mm = this.telemetryMessage.master;
    mm.peakL = masterMeter ? (masterMeter.peakL || 0) : 0;
    mm.peakR = masterMeter ? (masterMeter.peakR || 0) : 0;
    mm.rmsL = masterMeter ? (masterMeter.rmsL || 0) : 0;
    mm.rmsR = masterMeter ? (masterMeter.rmsR || 0) : 0;
    mm.clipped = !!clipped;
    mm.latencySamples = masterLatency;
    mm.pdcMs = Math.round(((masterLatency / this.sampleRate) * 1000) * 100) / 100;

    const pdc = this.telemetryMessage.pdc;
    pdc.sampleRate = this.sampleRate;
    pdc.vocalBusLatencySamples = vocalBusLatency;
    pdc.masterLatencySamples = masterLatency;

    this.port.postMessage(this.telemetryMessage);
  }
}

registerProcessor('audio-engine-processor', DAWAudioEngineProcessor);
