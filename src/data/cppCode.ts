import { MODULAR_CPP_SOURCES } from './cppModulesCode';

export const FULL_CPP_CODE = Object.values(MODULAR_CPP_SOURCES).join('\n\n');

export const BUILD_WASM_SCRIPT = `#!/bin/bash
# ==============================================================================
# Скрипт модульной компиляции C++ DAW Core в WebAssembly с помощью Emscripten
# ==============================================================================

if ! command -v emcc &> /dev/null
then
    echo "Ошибка: Emscripten (emcc) не найден в PATH."
    echo "Пожалуйста, установите EMSDK и активируйте окружение:"
    echo "  git clone https://github.com/emscripten-core/emsdk.git"
    echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest"
    echo "  source ./emsdk_env.sh"
    exit 1
fi

echo "Начало модульной компиляции DAW Core в WebAssembly (SIMD128 + Embind)..."

SCRIPT_DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

mkdir -p ../../public/wasm

SOURCES=(
    "dsp/BiquadFilter.cpp"
    "dsp/Dynamics.cpp"
    "dsp/AudioUtils.cpp"
    "vocal/VocalRack.cpp"
    "engine/Clip.cpp"
    "engine/Track.cpp"
    "engine/Mixer.cpp"
    "bindings/EmscriptenBindings.cpp"
)

emcc -O3 \\
    -std=c++17 \\
    -msimd128 \\
    -flto \\
    --bind \\
    -I. \\
    -s WASM=1 \\
    -s INITIAL_MEMORY=67108864 \\
    -s ALLOW_MEMORY_GROWTH=1 \\
    -s ENVIRONMENT=web,worker \\
    -s MODULARIZE=1 \\
    -s EXPORT_NAME="CreateDAWCoreModule" \\
    -s EXPORTED_FUNCTIONS='["_malloc", "_free"]' \\
    -s EXPORTED_RUNTIME_METHODS='["cwrap", "setValue", "getValue", "HEAPF32"]' \\
    -s SINGLE_FILE=0 \\
    "\${SOURCES[@]}" \\
    -o ../../public/wasm/daw_core.js

echo "Компиляция успешно завершена! Файлы daw_core.js и daw_core.wasm созданы в public/wasm/"
`;
