# Инструкция по компиляции C++ DAW Core в WebAssembly (Emscripten)

## Команда компиляции emcc

Для сборки C++ ядра в высокопроизводительный WebAssembly модуль с аппаратной поддержкой векторизации **SIMD (128-bit)** и связыванием **embind**, выполните следующую команду в терминале:

```bash
emcc -O3 \
    -std=c++17 \
    -msimd128 \
    -flto \
    --bind \
    -s WASM=1 \
    -s INITIAL_MEMORY=67108864 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT=web,worker \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="CreateDAWCoreModule" \
    -s EXPORTED_FUNCTIONS='["_malloc", "_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["cwrap", "setValue", "getValue", "HEAPF32"]' \
    daw_core.cpp \
    -o public/wasm/daw_core.js
```

---

## Расшифровка ключевых флагов компиляции:

1. **`-std=c++17`**: Включает стандарт C++17 (`std::optional`, `std::array`, `std::clamp` и продвинутые шаблоны).
2. **`-O3`**: Максимальный уровень оптимизации скорости выполнения и авто-векторизации циклов.
3. **`-msimd128`**: Активирует WebAssembly SIMD инструкции (`wasm_v128`). Позволяет обрабатывать по 4 сэмпла `float32` параллельно за один такт процессора.
4. **`-flto`**: Link-Time Optimization (оптимизация на этапе связывания) для встраивания (inlining) математических функций Biquad и Compressor.
5. **`--bind`**: Включает Emscripten Embind для удобного прямых вызовов C++ классов и методов из JavaScript.
6. **`-s WASM=1`**: Компиляция в бинарный формат WebAssembly.
7. **`-s INITIAL_MEMORY=67108864`**: Выделение начального объема памяти WASM в 64 МБ (достаточно для буферов audio/clips).
8. **`-s ALLOW_MEMORY_GROWTH=1`**: Динамическое расширение памяти при добавлении больших аудиофайлов.
9. **`-s ENVIRONMENT=web,worker`**: Гарантирует совместимость модуля для загрузки внутри потока `AudioWorkletGlobalScope` и Web Worker.
10. **`-s MODULARIZE=1 -s EXPORT_NAME="CreateDAWCoreModule"`**: Упаковывает WASM в асинхронный ES6 модуль.
11. **`-s EXPORTED_FUNCTIONS='["_malloc", "_free"]'`**: Экспортирует низкоуровневые функции выделения памяти для передачи буферов сэмплов с нулевым копированием (Zero-Copy Transfer).

---

## Использование внутри AudioWorklet (JavaScript / TypeScript)

```javascript
// AudioWorkletProcessor script
importInitWasmModule();

class DAWAudioWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Инициализация C++ Mixer ядра из WASM
    this.mixer = new Module.Mixer(sampleRate);
    this.outPtr = Module._malloc(128 * 2 * 4); // 128 stereo frames * 4 bytes
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const leftChan = output[0];
    const rightChan = output[1];

    // Вызов C++ processBlock с нулевым выделением памяти
    Module.processMixer(this.mixer, this.outPtr, 128);

    // Чтение прямо из HEAPF32 WASM памяти без копирования
    const wasmHeap = Module.HEAPF32;
    const offset = this.outPtr >> 2;

    for (let i = 0; i < 128; i++) {
      leftChan[i] = wasmHeap[offset + i * 2];
      rightChan[i] = wasmHeap[offset + i * 2 + 1];
    }

    return true;
  }
}

registerProcessor('daw-core-processor', DAWAudioWorkletProcessor);
```
