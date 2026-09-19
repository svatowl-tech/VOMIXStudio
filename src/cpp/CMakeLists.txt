cmake_minimum_required(VERSION 3.15)
project(DAWCoreEngine VERSION 2.1.0 LANGUAGES CXX)

# ==============================================================================
# CMakeLists.txt - Модульная сборка DAW Core Engine (C++17, SIMD128, Embind)
# ==============================================================================

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 1. DSP Модули
set(DSP_SOURCES
    dsp/BiquadFilter.cpp
    dsp/Dynamics.cpp
    dsp/AudioUtils.cpp
)

set(DSP_HEADERS
    dsp/AudioMath.hpp
    dsp/BiquadFilter.hpp
    dsp/Dynamics.hpp
    dsp/AudioUtils.hpp
)

# 2. Vocal Rack DSP
set(VOCAL_SOURCES
    vocal/VocalRack.cpp
)

set(VOCAL_HEADERS
    vocal/VocalRack.hpp
)

# 3. Audio Engine & Media Core
set(ENGINE_SOURCES
    engine/Clip.cpp
    engine/Track.cpp
    engine/Mixer.cpp
    engine/MediaCore.cpp
)

set(ENGINE_HEADERS
    engine/Clip.hpp
    engine/Track.hpp
    engine/Mixer.hpp
    engine/MediaCore.hpp
)

# 4. Clip Editing, Silence Stripper & WSOLA Time Stretch
set(EDITING_SOURCES
    editing/WSOLATimeStretch.cpp
    editing/ClipEditor.cpp
    editing/SilenceStripper.cpp
)

set(EDITING_HEADERS
    editing/WSOLATimeStretch.hpp
    editing/ClipEditor.hpp
    editing/SilenceStripper.hpp
)

# 5. Speech Analysis, Levenshtein, VAD, Smart Aligner & Stem Separation
set(ANALYSIS_SOURCES
    analysis/SpeechAligner.cpp
    analysis/StemSeparator.cpp
)

set(ANALYSIS_HEADERS
    analysis/SpeechAligner.hpp
    analysis/StemSeparator.hpp
)

set(ALL_SOURCES
    ${DSP_SOURCES}
    ${VOCAL_SOURCES}
    ${ENGINE_SOURCES}
    ${EDITING_SOURCES}
    ${ANALYSIS_SOURCES}
)

set(ALL_HEADERS
    ${DSP_HEADERS}
    ${VOCAL_HEADERS}
    ${ENGINE_HEADERS}
    ${EDITING_HEADERS}
    ${ANALYSIS_HEADERS}
)

# Поддержка нативной статической библиотеки (для юнит-тестов и нативного хоста)
add_library(daw_core_static STATIC ${ALL_SOURCES} ${ALL_HEADERS})
target_include_directories(daw_core_static PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

# Компиляция под WebAssembly через Emscripten
if(EMSCRIPTEN)
    message(STATUS "Конфигурация сборки Emscripten WebAssembly (SIMD128 + LTO + O3)...")

    set(WASM_SOURCES
        ${ALL_SOURCES}
        bindings/EmscriptenBindings.cpp
    )

    add_executable(daw_core ${WASM_SOURCES})
    target_include_directories(daw_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

    # Флаги оптимизации компилятора: аппаратная векторизация SIMD128, LTO, -O3
    target_compile_options(daw_core PRIVATE
        -O3
        -msimd128
        -flto
        -Wall
        -Wextra
        -Wno-unused-parameter
    )

    # Флаги компоновщика Emscripten
    set_target_properties(daw_core PROPERTIES
        OUTPUT_NAME "daw_core"
        SUFFIX ".js"
        LINK_FLAGS "\
            -O3 \
            -msimd128 \
            -flto \
            --bind \
            -s WASM=1 \
            -s INITIAL_MEMORY=67108864 \
            -s ALLOW_MEMORY_GROWTH=1 \
            -s ENVIRONMENT=web,worker \
            -s MODULARIZE=1 \
            -s EXPORT_NAME='CreateDAWCoreModule' \
            -s EXPORTED_FUNCTIONS='[\"_malloc\", \"_free\"]' \
            -s EXPORTED_RUNTIME_METHODS='[\"cwrap\", \"setValue\", \"getValue\", \"HEAPF32\"]' \
            -s SINGLE_FILE=0 \
        "
    )

    # Директория назначения готового бинарного модуля WASM
    set_target_properties(daw_core PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../public/wasm"
    )
else()
    message(STATUS "Конфигурация нативной сборки (Host C++17)...")
    target_compile_options(daw_core_static PRIVATE -O3 -Wall -Wextra)
endif()
