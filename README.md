# 🎙️ VOMIXStudio

> **Professional Open Source C++ WebAssembly Audio Engine & Native Windows Video Dubbing Workstation**

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![React](https://img.shields.io/badge/Frontend-React%2019-blue.svg)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-3178C6.svg)](https://www.typescriptlang.org/)
[![C++17 SIMD](https://img.shields.io/badge/Core-C%2B%2B17%20WASM%20SIMD-00599C.svg)](https://isocpp.org/)
[![Tauri v2](https://img.shields.io/badge/Desktop-Tauri%20v2-FFC107.svg)](https://tauri.app/)
[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen.svg)]()

---

## 📌 Обзор проекта (Project Overview)

**VOMIXStudio** — это высокопроизводительное открытое (Open Source) приложение для автоматизированного дубляжа, локализации и сведения многодорожечного аудио с видеофайлами.

Приложение сочетает в себе скорость нативного C++17 ядра с векторизацией WebAssembly SIMD и легковесную гибкость пользовательского интерфейса React 19 + Tauri v2.

---

## 📐 Архитектура системы (Architecture)

```
                     ┌─────────────────────────────────────────┐
                     │          VOMIXStudio React GUI          │
                     │  (React 19, TypeScript, Tailwind CSS)   │
                     └────────────────────┬────────────────────┘
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
   ┌─────────────────────────────┐                 ┌─────────────────────────────┐
   │    C++17 WASM DSP Engine    │                 │   Tauri v2 / WebView2 OS    │
   │  (Simd128, Catmull-Rom,     │                 │   (Native Windows I/O,      │
   │   AudioWorklet, EBU R128)   │                 │    Direct FS, FFmpeg Mux)   │
   └─────────────────────────────┘                 └─────────────────────────────┘
```

1. **Frontend GUI**: Выполнен на React 19 + TypeScript. Отвечает за реактивное отображение микшера, осциллограмм, синхронного видеоплеера и элементов управления.
2. **C++17 DSP Core (WASM SIMD)**: Ядро многодорожечного микширования и обработки сигналов без выделения динамической памяти в AudioWorklet цикле. Выполняет ресэмплинг (Catmull-Rom), нормализацию EBU R128 и лимитирование.
3. **Silero VAD ONNX Engine**: ИИ-детектор речевых сегментов на базе Neural Network ONNX Runtime Web.
4. **FFmpeg WebAssembly**: Выполняет прямой бессдвиговый муксинг (`-c:v copy -c:a aac`) для моментального сшивания нового аудио с видеопотоком.
5. **Tauri v2 Shell**: Оболочка для Windows с прямым доступом к файловой системе без ограничения песочницы браузера.

---

## ✨ Ключевые возможности (Features)

- ⚡ **Сведение в 1 клик**: Автоматическая синхронизация дорожек дикторов, фоновой музыки и эффектов.
- 🎚️ **C++ EBU R128 Loudness Match**: Автоматическое выравнивание громкости под вещательные стандарты (-18 dBFS) или стриминг (-14 dBFS).
- 🔄 **Качественный ресэмплинг 48 кГц**: Кубический Catmull-Rom алгоритм в C++ WASM SIMD.
- 🎬 **Покадровый видео-монитор**: Синхронизация таймлайна с точной покадровой навигацией (30/60 FPS).
- 📦 **Прямое сохранение в MP4**: Вшивание аудиопотока в видеофайл за секунды без перекодирования видео.
- 💻 **Cross-Platform**: Работает как в современном браузере, так и в виде нативного `.exe` приложения для Windows.

---

## 💻 Системные требования для Windows

| Параметр | Минимальные требования | Рекомендуемые требования |
| :--- | :--- | :--- |
| **ОС** | Windows 10 x64 / Windows 11 | Windows 11 x64 |
| **Процессор** | Двухъядерный CPU с поддержкой AVX2 | Четырехъядерный CPU и выше |
| **ОЗУ** | 4 ГБ | 8 ГБ и выше |
| **Среда выполнения** | Microsoft Edge WebView2 Runtime | Предустановлен в Windows 10/11 |

---

## 🛠️ Сборка из исходников (Build Instructions)

### 1. Клонирование и установка зависимостей
```bash
git clone https://github.com/vomixstudio/vomixstudio.git
cd vomixstudio
npm install
```

### 2. Запуск в режиме веб-разработки (Browser Mode)
```bash
npm run dev
```
Откройте адрес `http://localhost:3000` в браузере Chrome или Edge.

### 3. Сборка нативного Windows приложения (.exe / .msi)

#### Предварительные требования для Windows:
1. Установите [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (компонент *Desktop development with C++*).
2. Установите [Rust Toolchain](https://rustup.rs/):
   ```cmd
   rustup default stable-x86_64-pc-windows-msvc
   ```

#### Запуск в режиме нативной разработки Tauri:
```bash
npm run tauri dev
```

#### Компиляция готового дистрибутива:
```bash
npm run build:win
```
Готовые файлы `.msi` и `.exe` появятся в папке `src-tauri/target/release/bundle/msi/`.

---

## 📜 Лицензия (License)

Проект распространяется под открытой бесплатной лицензией **MIT License**. Подробности в файле [LICENSE](LICENSE).
