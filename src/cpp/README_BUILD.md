# Инструкция по сборке модульного C++ DAW Core в WebAssembly (Emscripten / CMake)

## 1. Сборка через CMake (Рекомендуемый метод)

Проект настроен на стандартную модульную сборку C++17 под CMake. При компиляции через `emcmake` автоматически генерируются оптимизированные артефакты `daw_core.js` и `daw_core.wasm`.

```bash
mkdir -p build && cd build
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release
emmake make
```

---

## 2. Сборка через готовый скрипт build_wasm.sh или прямой emcc

```bash
./build_wasm.sh
```

Или прямая команда компилятора:

```bash
emcc -O3 \
    -std=c++17 \
    -msimd128 \
    -flto \
    --bind \
    -I. \
    -s WASM=1 \
    -s INITIAL_MEMORY=67108864 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT=web,worker \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="CreateDAWCoreModule" \
    -s EXPORTED_FUNCTIONS='["_malloc", "_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["cwrap", "setValue", "getValue", "HEAPF32"]' \
    -s SINGLE_FILE=0 \
    dsp/BiquadFilter.cpp \
    dsp/Dynamics.cpp \
    dsp/AudioUtils.cpp \
    vocal/VocalRack.cpp \
    engine/Clip.cpp \
    engine/Track.cpp \
    engine/Mixer.cpp \
    bindings/EmscriptenBindings.cpp \
    -o ../../public/wasm/daw_core.js
```

---

## 3. Модульная архитектура движка

| Директория | Модуль | Описание |
|---|---|---|
| `dsp/` | `AudioMath.hpp` | Константы, dB <-> Gain, SIMD128 макросы, Constant Power Pan |
| `dsp/` | `BiquadFilter` (.hpp / .cpp) | БИХ-фильтры 2-го порядка (Audio EQ Cookbook) и 3-полосный параметрический EQ с SIMD |
| `dsp/` | `Dynamics` (.hpp / .cpp) | SoftKneeCompressor, NoiseGate на FSM, AutoDucker, SoftLimiter (tanh) |
| `dsp/` | `AudioUtils` (.hpp / .cpp) | LoudnessAnalyzer (SIMD True Peak & RMS), Catmull-Rom ресэмплер, Native WAV пакер |
| `vocal/` | `VocalRack` (.hpp / .cpp) | DeClicker (сплайн Hermite), DePlosive (сайдчейн HPF), DeEsser (VCA), полный тракт обработки |
| `engine/`| `Clip` (.hpp / .cpp) | Аудиоклип, таймлайн-оффсет, Fade In / Out |
| `engine/`| `Track` (.hpp / .cpp) | Дорожка, Zero-Alloc RT-буфер, панорамирование, процессинг вокального рэка |
| `engine/`| `Mixer` (.hpp / .cpp) | Главный сумматор, мастер-лимитер, Solo/Mute шина, офлайн-рендер проекта и стемов |
| `bindings/`| `EmscriptenBindings.cpp` | Embind интерфейсы прямого доступа из JavaScript Heap |

---

## 4. Гарантии Real-Time безопасности (RT-Safe)
- **Zero Malloc / Zero New:** Расчетные аудиоциклы `processBlock`, `renderClipsToBuffer`, `processVocalRack` не выполняют динамических аллокаций памяти.
- **WASM SIMD128:** Векторная обработка стереосэмплов и суммирования дорожек через 128-битные регистры `v128_t`.
