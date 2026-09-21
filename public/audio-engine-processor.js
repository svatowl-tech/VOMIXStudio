/**
 * ============================================================================
 * VOMIXSTUDIO HIGH-PERFORMANCE AUDIO WORKLET PROCESSOR (UNIVERSAL VST CONTRACT)
 * ============================================================================
 * Выполняется в выделенном высокоприоритетном аудиопотоке Web Audio API.
 * Все вычисления, микширование, цепочки VST2/VST3 плагинов и телеметрия
 * производятся в нативном C++ ядре через WebAssembly:
 *
 * 1. LOAD_VST_PLUGIN: Создание инстанса плагина в слоте трека/мастера через C-API.
 * 2. UPDATE_VST_PARAM: Атомарная передача числового ID параметра и нормализованного
 *    float-значения (0.0 .. 1.0) напрямую в C++ структуру плагина.
 * 3. SET_VST_BYPASS: Безопасный байпас с плавным сглаживанием гейна.
 * 4. SET_VST_WET_DRY: Сглаженное управление балансом сухого/обработанного сигнала.
 * 5. SET_TRACK_CLIPS: Полная синхронизация буферов клипов (включая Trim/Split) в куче WASM.
 * 6. METERS_TELEMETRY: Прямое чтение точных пиковых значений из C++ движка через _getTrackPeak.
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
    this.outBufferPtr = 0; // Стерео буфер вывода C++ (L, R, L, R...)

    // Защита от спама в консоль
    this.hasReportedError = false;

    // Метрики и телеметрия уровней (metering + PDC)
    this.meterFrameCounter = 0;
    this.meterReportInterval = 4; // каждые ~10.6 мс при блоке 128 сэмплов

    // Обработчик входящих команд хоста
    this.port.onmessage = (event) => this.handleHostMessage(event.data);

    // Уведомляем хост о готовности процессора
    this.port.postMessage({
      type: 'WORKLET_READY',
      sampleRate: this.sampleRate
    });
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
      const wasmMemory = new WebAssembly.Memory({ initial: 512, maximum: 4096 });
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

      // Выделяем буфер под стерео аутпут (128 Stereo фреймов = 256 float)
      const outSamples = 256;
      if (this.wasmModule._malloc) {
        this.outBufferPtr = this.wasmModule._malloc(outSamples * 4);
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
   * Выделение памяти в куче WASM и копирование Float32Array данных
   */
  allocateWasmBuffer(pcmData) {
    if (!this.wasmModule || !this.wasmModule._malloc || !pcmData || pcmData.length === 0) {
      return 0;
    }
    const bytesCount = pcmData.length * 4;
    const ptr = this.wasmModule._malloc(bytesCount);
    if (ptr) {
      const heapF32 = this.wasmModule.HEAPF32;
      const floatOffset = ptr >> 2;
      heapF32.set(pcmData, floatOffset);
    }
    return ptr;
  }

  /**
   * Освобождение памяти буфера клипа в куче WASM
   */
  freeWasmClipBuffer(clipId) {
    const ptr = this.clipWasmPtrs.get(clipId);
    if (ptr && this.wasmModule && this.wasmModule._free) {
      this.wasmModule._free(ptr);
      this.clipWasmPtrs.delete(clipId);
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

  /**
   * Получение массива слотов плагинов для трека / вокал-шины / мастера
   */
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

  /**
   * Поиск плагина по instanceId во всей цепочке проекта
   */
  findPluginByInstanceId(instanceId) {
    if (!instanceId) return null;

    // 1. Поиск по дорожкам
    for (const [trackId, slots] of this.trackVstSlots.entries()) {
      for (let i = 0; i < slots.length; i++) {
        const p = slots[i];
        if (p && p.instanceId === instanceId) {
          return { target: 'track', trackId, slotIdx: i, plugin: p };
        }
      }
    }

    // 2. Вокал-шина
    for (let i = 0; i < this.vocalBusVstSlots.length; i++) {
      const p = this.vocalBusVstSlots[i];
      if (p && p.instanceId === instanceId) {
        return { target: 'vocalBus', trackId: 999, slotIdx: i, plugin: p };
      }
    }

    // 3. Мастер
    for (let i = 0; i < this.masterVstSlots.length; i++) {
      const p = this.masterVstSlots[i];
      if (p && p.instanceId === instanceId) {
        return { target: 'master', trackId: 1000, slotIdx: i, plugin: p };
      }
    }

    return null;
  }

  /**
   * Вычисление суммарной задержки плагинов на треке (PDC - Plugin Delay Compensation)
   */
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

  /**
   * Обработка команд MessagePort от хоста (useAudioEngine)
   */
  handleHostMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'INIT_WASM':
        if (msg.sampleRate && msg.sampleRate > 0) {
          this.sampleRate = msg.sampleRate;
        }
        if (msg.wasmBytes && msg.wasmBytes.byteLength > 0) {
          this.initWasm(msg.wasmBytes);
        } else {
          console.error('[AudioWorklet] INIT_WASM запущен без валидных байтов модуля.');
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

      // ======================================================================
      // 1. LOAD_VST_PLUGIN: Прямой вызов _loadTrackPlugin / _loadMasterPlugin
      // ======================================================================
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

        // Заполняем дефолтные параметры из дескриптора
        if (descriptor && Array.isArray(descriptor.parameters)) {
          for (const p of descriptor.parameters) {
            const numId = this.getParamIdAsNumber(pluginId, p.id);
            const normVal = (p.max > p.min)
              ? Math.max(0.0, Math.min(1.0, (p.defaultValue - p.min) / (p.max - p.min)))
              : 0.5;
            pluginInstance.parameters[numId] = normVal;
          }
        }

        // Перекрываем переданными initialParams
        if (initialParams && typeof initialParams === 'object') {
          for (const [k, v] of Object.entries(initialParams)) {
            const numId = this.getParamIdAsNumber(pluginId, k);
            pluginInstance.parameters[numId] = typeof v === 'number' ? Math.max(0.0, Math.min(1.0, v)) : 0.5;
          }
        }

        slots[validSlotIdx] = pluginInstance;

        // Прямой вызов C-API функции в C++ движке
        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (target === 'master' || finalTrackId === 1000) {
            if (this.wasmModule._loadMasterPlugin) {
              try {
                this.wasmModule._loadMasterPlugin(this.mixerPtr, validSlotIdx, pluginTypeId);
              } catch (err) {
                console.warn(`[AudioWorklet] Сбой _loadMasterPlugin для слота ${validSlotIdx}:`, err);
              }
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
              } catch (err) {
                console.warn(`[AudioWorklet] Сбой _loadTrackPlugin для слота ${validSlotIdx}:`, err);
              }
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

        // Синхронизируем массив плагинов в jsTracks
        if (this.jsTracks.has(finalTrackId)) {
          const track = this.jsTracks.get(finalTrackId);
          track.vstPlugins = slots.filter(Boolean);
        }

        // Подтверждаем создание инстанса хосту
        this.port.postMessage({
          type: 'VST_PLUGIN_LOADED',
          trackId: finalTrackId,
          slotIdx: validSlotIdx,
          instanceId: pluginInstanceId,
          latencySamples
        });
        break;
      }

      // ======================================================================
      // 2. UPDATE_VST_PARAM: Прямой вызов _setTrackPluginParam / _setMasterPluginParam
      // ======================================================================
      case 'UPDATE_VST_PARAM': {
        const { target, trackId, instanceId, slotIdx, paramId, numericParamId, value } = msg;

        let targetInfo = null;
        if (instanceId) {
          targetInfo = this.findPluginByInstanceId(instanceId);
        }

        let resolvedTrackId = targetInfo ? targetInfo.trackId : (Number(trackId) || 0);
        let resolvedSlotIdx = targetInfo ? targetInfo.slotIdx : (Number(slotIdx) || 0);
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

        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (target === 'master' || resolvedTrackId === 1000) {
            if (this.wasmModule._setMasterPluginParam) {
              try {
                this.wasmModule._setMasterPluginParam(this.mixerPtr, resolvedSlotIdx, finalNumericParamId, normalizedValue);
              } catch (err) {
                console.warn('[AudioWorklet] Сбой _setMasterPluginParam:', err);
              }
            }
          } else {
            if (this.wasmModule._setTrackPluginParam) {
              try {
                this.wasmModule._setTrackPluginParam(
                  this.mixerPtr,
                  resolvedTrackId,
                  resolvedSlotIdx,
                  finalNumericParamId,
                  normalizedValue
                );
              } catch (err) {
                console.warn('[AudioWorklet] Сбой _setTrackPluginParam:', err);
              }
            }
          }
        }
        break;
      }

      // ======================================================================
      // 3. SET_VST_BYPASS: Прямой вызов _setTrackPluginBypass / _setMasterPluginBypass
      // ======================================================================
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

      // ======================================================================
      // 4. SET_VST_WET_DRY: Прямой вызов _setTrackPluginWetDry / _setMasterPluginWetDry
      // ======================================================================
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

      // ======================================================================
      // 5. SAVE_VST_CHUNK: Сериализация состояния параметров в Base64
      // ======================================================================
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
      // 6. LOAD_TRACK_CLIP: Загрузка отдельного клипа в дорожку
      // ======================================================================
      case 'LOAD_TRACK_CLIP': {
        const trackId = msg.trackId;
        const clipId = msg.clipId || Date.now();
        const pcmBuffer = msg.audioData || msg.pcmBuffer || msg.pcm || new Float32Array(0);
        const offsetSamples = typeof msg.offsetSamples === 'number' ? msg.offsetSamples : 0;
        const isStereo = msg.isStereo !== undefined ? msg.isStereo : true;
        const lengthSamples = msg.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
        const gain = typeof msg.gain === 'number' ? msg.gain : 1.0;
        const pan = typeof msg.pan === 'number' ? msg.pan : 0.0;
        const fadeIn = msg.fadeInSamples || 0;
        const fadeOut = msg.fadeOutSamples || 0;

        if (pcmBuffer.length > 0) {
          this.clipBufferCache.set(clipId, pcmBuffer);
        }

        if (!this.jsTracks.has(trackId)) {
          this.jsTracks.set(trackId, {
            id: trackId,
            name: msg.trackName || `Track ${trackId}`,
            volumeDb: 0.0,
            pan: 0.0,
            solo: false,
            mute: false,
            vstPlugins: [],
            clips: new Map()
          });
        }

        const track = this.jsTracks.get(trackId);
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

        // Загружаем в C++ микшер
        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          this.freeWasmClipBuffer(clipId);
          if (cachedPcm.length > 0) {
            const bufferPtr = this.allocateWasmBuffer(cachedPcm);
            if (bufferPtr) {
              this.clipWasmPtrs.set(clipId, bufferPtr);
              this.wasmModule._addClipToTrack(
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
          }
        }

        this.port.postMessage({
          type: 'CLIP_LOADED_SUCCESS',
          trackId,
          clipId,
          lengthSamples
        });
        break;
      }

      // ======================================================================
      // 7. SET_TRACK_CLIPS: Гарантированная синхронизация срезов после Trim/Split
      // ======================================================================
      case 'SET_TRACK_CLIPS': {
        const trackId = msg.trackId;
        const clips = Array.isArray(msg.clips) ? msg.clips : [];

        if (!this.jsTracks.has(trackId)) {
          this.jsTracks.set(trackId, {
            id: trackId,
            volumeDb: 0.0,
            pan: 0.0,
            solo: false,
            mute: false,
            vstPlugins: [],
            clips: new Map()
          });
        }

        const track = this.jsTracks.get(trackId);

        // Освобождаем старые указатели клипов этой дорожки
        for (const [oldClipId] of track.clips.entries()) {
          this.freeWasmClipBuffer(oldClipId);
        }
        track.clips.clear();

        for (const c of clips) {
          let pcmBuffer = (c.buffer && c.buffer.length > 0) ? c.buffer : null;
          if (!pcmBuffer) {
            pcmBuffer = this.clipBufferCache.get(c.id);
          }
          if (!pcmBuffer && c.originalClipId) {
            pcmBuffer = this.clipBufferCache.get(c.originalClipId);
          }

          if (pcmBuffer && pcmBuffer.length > 0) {
            this.clipBufferCache.set(c.id, pcmBuffer);
          } else {
            // Если буфер еще не передан, пропускаем либо ждем LOAD_TRACK_CLIP
            continue;
          }

          const isStereo = c.isStereo !== undefined ? c.isStereo : true;
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
            this.freeWasmClipBuffer(c.id);
            const bufferPtr = this.allocateWasmBuffer(pcmBuffer);
            if (bufferPtr) {
              this.clipWasmPtrs.set(c.id, bufferPtr);
              this.wasmModule._addClipToTrack(
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
        break;
      }

      // ======================================================================
      // 8. SET_ALL_TRACKS: Полная пакетная синхронизация микшера
      // ======================================================================
      case 'SET_ALL_TRACKS': {
        const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
        this.jsTracks.clear();

        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (this.wasmModule._removeAllTracks) {
            this.wasmModule._removeAllTracks(this.mixerPtr);
          }
          for (const [, ptr] of this.clipWasmPtrs.entries()) {
            this.wasmModule._free(ptr);
          }
          this.clipWasmPtrs.clear();
        }

        for (const t of tracks) {
          const trackId = t.id;
          const trackClips = new Map();

          if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
            if (this.wasmModule._setTrackVolume) {
              this.wasmModule._setTrackVolume(this.mixerPtr, trackId, t.volumeDb || 0);
              this.wasmModule._setTrackPan(this.mixerPtr, trackId, t.pan || 0);
              this.wasmModule._setTrackSolo(this.mixerPtr, trackId, !!t.solo);
              this.wasmModule._setTrackMute(this.mixerPtr, trackId, !!t.mute);
            }
          }

          if (Array.isArray(t.clips)) {
            for (const c of t.clips) {
              let pcmBuffer = (c.buffer && c.buffer.length > 0) ? c.buffer : null;
              if (!pcmBuffer) {
                pcmBuffer = this.clipBufferCache.get(c.id);
              }
              if (!pcmBuffer && c.originalClipId) {
                pcmBuffer = this.clipBufferCache.get(c.originalClipId);
              }

              if (pcmBuffer && pcmBuffer.length > 0) {
                this.clipBufferCache.set(c.id, pcmBuffer);
              } else {
                continue;
              }

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

              if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
                const bufferPtr = this.allocateWasmBuffer(pcmBuffer);
                if (bufferPtr) {
                  this.clipWasmPtrs.set(c.id, bufferPtr);
                  this.wasmModule._addClipToTrack(
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

          this.jsTracks.set(trackId, {
            id: trackId,
            name: t.name || `Track ${trackId}`,
            volumeDb: t.volumeDb || 0,
            pan: t.pan || 0,
            solo: !!t.solo,
            mute: !!t.mute,
            vstPlugins: t.vstPlugins || [],
            clips: trackClips
          });

          // Регистрируем VST-цепочку
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
        break;
      }

      case 'SET_TRACK_VOLUME': {
        const trackId = msg.trackId;
        const volumeDb = typeof msg.volumeDb === 'number' ? msg.volumeDb : 0.0;
        if (this.jsTracks.has(trackId)) {
          this.jsTracks.get(trackId).volumeDb = volumeDb;
        }
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setTrackVolume) {
          this.wasmModule._setTrackVolume(this.mixerPtr, trackId, volumeDb);
        }
        break;
      }

      case 'SET_TRACK_PAN': {
        const trackId = msg.trackId;
        const pan = typeof msg.pan === 'number' ? msg.pan : 0.0;
        if (this.jsTracks.has(trackId)) {
          this.jsTracks.get(trackId).pan = pan;
        }
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setTrackPan) {
          this.wasmModule._setTrackPan(this.mixerPtr, trackId, pan);
        }
        break;
      }

      case 'SET_TRACK_SOLO': {
        const trackId = msg.trackId;
        const solo = !!msg.solo;
        if (this.jsTracks.has(trackId)) {
          this.jsTracks.get(trackId).solo = solo;
        }
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setTrackSolo) {
          this.wasmModule._setTrackSolo(this.mixerPtr, trackId, solo);
        }
        break;
      }

      case 'SET_TRACK_MUTE': {
        const trackId = msg.trackId;
        const mute = !!msg.mute;
        if (this.jsTracks.has(trackId)) {
          this.jsTracks.get(trackId).mute = mute;
        }
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setTrackMute) {
          this.wasmModule._setTrackMute(this.mixerPtr, trackId, mute);
        }
        break;
      }

      case 'SET_MASTER_VOLUME': {
        this.masterVolumeDb = typeof msg.volumeDb === 'number' ? msg.volumeDb : 0.0;
        if (this.isWasmReady && this.wasmModule && this.mixerPtr && this.wasmModule._setMasterVolume) {
          this.wasmModule._setMasterVolume(this.mixerPtr, this.masterVolumeDb);
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
        const trackId = msg.trackId;
        const plugins = Array.isArray(msg.vstPlugins) ? msg.vstPlugins : [];
        if (this.jsTracks.has(trackId)) {
          this.jsTracks.get(trackId).vstPlugins = plugins;
        }
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

      case 'SET_VOCAL_BUS_VST_CHAIN': {
        const plugins = Array.isArray(msg.vstPlugins) ? msg.vstPlugins : [];
        this.vocalBus.vstPlugins = plugins;
        this.vocalBusVstSlots.fill(null);
        plugins.forEach((p, idx) => {
          if (idx < 8 && p) {
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
        if (this.isWasmReady && this.wasmModule && this.mixerPtr) {
          if (this.wasmModule._removeAllTracks) {
            this.wasmModule._removeAllTracks(this.mixerPtr);
          }
          for (const [, ptr] of this.clipWasmPtrs.entries()) {
            this.wasmModule._free(ptr);
          }
          this.clipWasmPtrs.clear();
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * Сглаживание параметров байпаса и баланса Wet/Dry для устранения щелчков
   */
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
   * Основной расчетный цикл рендеринга звука (RT-Safe, 128 сэмплов)
   */
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const leftOut = output[0];
    const rightOut = output[1] || leftOut;
    const numFrames = leftOut.length; // 128 сэмплов

    // Плавное сглаживание параметров
    this.smoothPluginGainRamps();

    if (!this.isPlaying) {
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);

      this.meterFrameCounter++;
      if (this.meterFrameCounter >= 30) {
        this.sendTelemetryMeters([], { peakL: 0, peakR: 0 }, 0, 0, false);
        this.meterFrameCounter = 0;
      }
      return true;
    }

    // Заполнение тишиной при неготовности C++ WASM ядра
    if (!this.isWasmReady || !this.wasmModule || !this.mixerPtr) {
      if (!this.hasReportedError) {
        console.error('[AudioWorklet] WASM C++ Mixer не инициализирован. Выход заполняется тишиной.');
        this.hasReportedError = true;
      }
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);
      return true;
    }

    try {
      // 1. Запуск рендеринга блока в нативном C++ микшере
      this.wasmModule._processMixer(this.mixerPtr, this.outBufferPtr, numFrames);

      // 2. Копирование интерливированного буфера C++ в Web Audio выходы
      const heapF32 = this.wasmModule.HEAPF32;
      const floatOffset = this.outBufferPtr >> 2;

      for (let i = 0; i < numFrames; i++) {
        const outL = heapF32[floatOffset + i * 2] || 0;
        const outR = heapF32[floatOffset + i * 2 + 1] || 0;
        leftOut[i] = outL;
        if (rightOut !== leftOut) {
          rightOut[i] = outR;
        }
      }

      this.currentTimelineSample += numFrames;

      // 3. Прямое считывание пиковых уровней из C++ движка через _getTrackPeak
      this.meterFrameCounter++;
      if (this.meterFrameCounter >= this.meterReportInterval) {
        const trackTelemetry = [];

        for (const [trackId, track] of this.jsTracks.entries()) {
          let tPeakL = 0;
          let tPeakR = 0;

          if (this.wasmModule._getTrackPeak) {
            tPeakL = this.wasmModule._getTrackPeak(this.mixerPtr, trackId, 0);
            tPeakR = this.wasmModule._getTrackPeak(this.mixerPtr, trackId, 1);
          }

          if (track.mute) {
            tPeakL = 0;
            tPeakR = 0;
          }

          const latencySamples = this.getTrackLatencySamples(trackId);
          const pdcMs = (latencySamples / this.sampleRate) * 1000;

          trackTelemetry.push({
            trackId,
            peakL: tPeakL,
            peakR: tPeakR,
            rmsL: tPeakL * 0.707,
            rmsR: tPeakR * 0.707,
            clipped: tPeakL >= 0.999 || tPeakR >= 0.999,
            latencySamples,
            pdcMs: Number(pdcMs.toFixed(2))
          });
        }

        let masterPeakL = 0;
        let masterPeakR = 0;
        let vocalPeakL = 0;
        let vocalPeakR = 0;

        if (this.wasmModule._getTrackPeak) {
          masterPeakL = this.wasmModule._getTrackPeak(this.mixerPtr, 1000, 0);
          masterPeakR = this.wasmModule._getTrackPeak(this.mixerPtr, 1000, 1);
          vocalPeakL = this.wasmModule._getTrackPeak(this.mixerPtr, 999, 0);
          vocalPeakR = this.wasmModule._getTrackPeak(this.mixerPtr, 999, 1);
        }

        const isClipped = masterPeakL >= 0.999 || masterPeakR >= 0.999;

        this.sendTelemetryMeters(
          trackTelemetry,
          { peakL: vocalPeakL, peakR: vocalPeakR },
          masterPeakL,
          masterPeakR,
          isClipped
        );
        this.meterFrameCounter = 0;
      }
    } catch (err) {
      if (!this.hasReportedError) {
        console.error('[AudioWorklet] Сбой в реалтайм C++ Mixer processBlock:', err);
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

  /**
   * Отправка пакета телеметрии в хост (useAudioEngine)
   */
  sendTelemetryMeters(trackMeters, vocalBusMeter, masterPeakL, masterPeakR, clipped) {
    const vocalBusLatency = this.getVocalBusLatencySamples();
    const masterLatency = this.getMasterLatencySamples();

    this.port.postMessage({
      type: 'METERS_TELEMETRY',
      currentTimeSec: this.currentTimelineSample / this.sampleRate,
      tracks: trackMeters,
      vocalBus: {
        ...vocalBusMeter,
        latencySamples: vocalBusLatency,
        pdcMs: Number(((vocalBusLatency / this.sampleRate) * 1000).toFixed(2))
      },
      master: {
        peakL: masterPeakL,
        peakR: masterPeakR,
        clipped,
        latencySamples: masterLatency,
        pdcMs: Number(((masterLatency / this.sampleRate) * 1000).toFixed(2))
      },
      pdc: {
        sampleRate: this.sampleRate,
        vocalBusLatencySamples: vocalBusLatency,
        masterLatencySamples: masterLatency
      }
    });
  }
}

registerProcessor('audio-engine-processor', DAWAudioEngineProcessor);
