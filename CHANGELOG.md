# CHANGELOG

All notable changes to **VOMIXStudio** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-09-18

### Added
- **C++17 DSP Audio Engine (WASM SIMD)**: Multitrack audio mixing engine with 64-bit float precision, zero-allocation real-time process loops, and 128-bit vectorization.
- **Catmull-Rom Cubic Resampler**: Native 48kHz audio unification pipeline for all imported tracks.
- **Loudness Normalizer (EBU R128)**: Integrated True Peak, RMS, and Loudness Matching for broadcast (-18 dBFS) and streaming (-14 dBFS).
- **AudioWorklet Zero-Latency Bridge**: SharedArrayBuffer ring-buffer synchronization between the Web Audio thread and C++ WebAssembly module.
- **Silero VAD ONNX AI Dubbing**: Neural voice activity detection for automated subtitle/speech segment extraction.
- **FFmpeg WebAssembly Video Muxing**: Fast, direct stream copy (`-c:v copy -c:a aac`) video muxing without re-encoding video frames.
- **Tauri v2 Desktop Support**: Full cross-platform desktop shell for Windows (.exe / .msi) with direct File System Access and WebView2 Runtime.
- **MinimalStudio MVP**: One-click dubbing and mixing workflow dashboard.
