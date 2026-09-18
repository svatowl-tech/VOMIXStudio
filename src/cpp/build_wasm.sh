#!/bin/bash
# ==============================================================================
# Скрипт компиляции C++ DAW Core в WebAssembly с помощью Emscripten (emcc)
# ==============================================================================

# Проверка наличия emcc
if ! command -v emcc &> /dev/null
then
    echo "Ошибка: Emscripten (emcc) не найден в PATH."
    echo "Пожалуйста, установите EMSDK и активируйте окружение:"
    echo "  git clone https://github.com/emscripten-core/emsdk.git"
    echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest"
    echo "  source ./emsdk_env.sh"
    exit 1
fi

echo "Начало компиляции DAW Core в WebAssembly (SIMD128 + Embind)..."

mkdir -p ../../public/wasm

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
    -s SINGLE_FILE=0 \
    daw_core.cpp \
    -o ../../public/wasm/daw_core.js

echo "Компиляция успешно завершена! Файлы daw_core.js и daw_core.wasm созданы в public/wasm/"
