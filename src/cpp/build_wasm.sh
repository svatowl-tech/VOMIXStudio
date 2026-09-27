#!/bin/bash
# ==============================================================================
# Скрипт компиляции модульного C++ DAW Core в WebAssembly с помощью Emscripten
# С защитой от переполнения кучи (MAXIMUM_MEMORY=2GB, ABORTING_MALLOC=0)
# ==============================================================================

# Останавливать скрипт при любой ошибке
set -euo pipefail

# Проверка наличия emcc / em++
if ! command -v emcc &> /dev/null
then
    echo "Ошибка: Emscripten (emcc) не найден в PATH."
    echo "Пожалуйста, установите EMSDK и активируйте окружение:"
    echo "  git clone https://github.com/emscripten-core/emsdk.git"
    echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest"
    echo "  source ./emsdk_env.sh"
    exit 1
fi

echo "Начало модульной компиляции DAW Core в WebAssembly (SIMD128 + Embind + 2GB Memory)..."

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

mkdir -p ../../public/wasm

# Список исходных модулей движка
SOURCES=(
    "dsp/BiquadFilter.cpp"
    "dsp/Dynamics.cpp"
    "dsp/AudioUtils.cpp"
    "vocal/VocalRack.cpp"
    "engine/Clip.cpp"
    "engine/Track.cpp"
    "engine/Mixer.cpp"
    "engine/MediaCore.cpp"
    "editing/WSOLATimeStretch.cpp"
    "editing/ClipEditor.cpp"
    "editing/SilenceStripper.cpp"
    "analysis/SpeechAligner.cpp"
    "analysis/StemSeparator.cpp"
    "bindings/EmscriptenBindings.cpp"
)

if em++ -O3 \
    -std=c++17 \
    -msimd128 \
    -flto \
    --bind \
    -I. \
    -s WASM=1 \
    -s INITIAL_MEMORY=134217728 \
    -s MAXIMUM_MEMORY=2147483648 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ABORTING_MALLOC=0 \
    -s ENVIRONMENT=web,worker \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="CreateDAWCoreModule" \
    -s EXPORTED_FUNCTIONS='["_malloc", "_free", "_getAvailableWasmMemory", "_createMixerInstance", "_freeMixerInstance", "_processMixer", "_setTimelinePosition", "_addClipToTrack", "_addTrack", "_getTrack", "_setTrackIsOriginalAudio", "_setTrackVolume", "_setTrackPan", "_setTrackSolo", "_setTrackMute", "_removeAllTracks", "_setMasterVolume", "_setMasterLimiter", "_setVocalBusVolume", "_setVocalBusAutoDucker", "_loadTrackPlugin", "_setTrackPluginParam", "_setTrackPluginBypass", "_setTrackPluginWetDry", "_loadMasterPlugin", "_setMasterPluginParam", "_setMasterPluginBypass", "_setMasterPluginWetDry", "_getTrackPeak", "_getTrackRMS"]' \
    -s EXPORTED_RUNTIME_METHODS='["cwrap", "setValue", "getValue", "HEAPF32"]' \
    -s SINGLE_FILE=0 \
    "${SOURCES[@]}" \
    -o ../../public/wasm/daw_core.js; then
    
    echo "Компиляция успешно завершена! Файлы daw_core.js и daw_core.wasm созданы в public/wasm/"
else
    echo "Ошибка: Сборка WebAssembly-модуля (em++) завершилась со сбоем!"
    exit 1
fi
