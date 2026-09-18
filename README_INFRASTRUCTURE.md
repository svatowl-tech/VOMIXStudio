# Инфраструктура AudioWorklet & C++ WebAssembly Bridge для React

Данный документ описывает структуру каталогов, механизмы связывания и порядок запуска многодорожечной аудиосистемы DAW Core.

---

## Структура каталогов проекта

```
/
├── public/
│   ├── audio-engine-processor.js   # Исполняемый поток AudioWorkletProcessor
│   └── wasm/
│       ├── daw_core.js             # Сгенерированный Emscripten JS-модуль
│       └── daw_core.wasm           # Скомпилированный бинарный модуль WebAssembly
├── src/
│   ├── audio/
│   │   └── dawEngine.ts            # Эмуляция и DSP-алгоритмы C++ микшера
│   ├── components/
│   │    font/
│   │   ├── AudioUploader.tsx       # Компонент загрузки WAV/MP3 файлов
│   │   ├── CppSourceCodeViewer.tsx # Интерактивный просмотрщик C++ кода
│   │   ├── EqCurveVisualizer.tsx   # Отрисовка АЧХ Biquad эквалайзера (Canvas)
│   │   ├── Header.tsx              # Навигация и статус
│   │   ├── MasterSection.tsx       # Мастер-шира, Soft Limiter и транспорант
│   │   ├── TimelineView.tsx        # Мультитрековый таймлайн клипов
│   │   └── TrackStrip.tsx          # Поканальная полоса микширования (EQ, Comp, Duck)
│   ├── cpp/
│   │   ├── build_wasm.sh           # Bash-скрипт компиляции через emcc
│   │   ├── daw_core.cpp            # Полный C++17 код микшера и DSP
│   │   └── README_BUILD.md         # Описание флагов emcc компилятора
│   ├── data/
│   │   └── cppCode.ts              # Константа полного C++ кода для UI
│   ├── hooks/
│   │   └── useAudioEngine.ts       # React-хук инициализации и управления AudioWorklet
│   ├── App.tsx                     # Главный компонент DAW интерфейса
│   ├── main.tsx                    # Точка входа React
│   └── index.css                   # Стили Tailwind CSS
├── package.json                    # Зависимости проекта
├── tsconfig.json                   # Настройки TypeScript
└── vite.config.ts                  # Конфигурация Vite
```

---

## Руководство по запуску и компиляции

### 1. Локальный запуск Vite приложения
```bash
# Установка зависимостей (уже выполнена в окружении)
npm install

# Запуск dev-сервера на порту 3000
npm run dev
```

### 2. Компиляция C++ WASM модуля через Emscripten

Для самостоятельной перекомпиляции файла `src/cpp/daw_core.cpp` выполните:

```bash
# Активация окружения Emscripten (EMSDK)
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh

# Запуск компиляции
chmod +x src/cpp/build_wasm.sh
./src/cpp/build_wasm.sh
```

Выходные файлы `public/wasm/daw_core.js` и `public/wasm/daw_core.wasm` создаются автоматически.

---

## Архитектура передачи данных и управления (MessagePort Protocol)

### Команды управление (React -> AudioWorklet)
1. **`INIT_WASM`**: Передача откомпилированных байт модуля `.wasm` и выбор частоты дискретизации (48000 Гц).
2. **`LOAD_TRACK_CLIP`**: Передача Float32Array PCM аудиоданных файла (декодированного из WAV/MP3 в React) с копированием в память.
3. **`SET_TRACK_VOLUME` / `SET_TRACK_PAN` / `SET_TRACK_SOLO` / `SET_TRACK_MUTE`**: Прямая регулировка громкости, панорамы и шин Solo/Mute.
4. **`SET_EQ_PARAMS` / `SET_COMP_PARAMS` / `SET_DUCK_PARAMS`**: Изменение параметров DSP цепочки каналов.
5. **`PLAY` / `PAUSE` / `SEEK`**: Управление транспортом и позицией плейхеда.

### Телеметрия (AudioWorklet -> React UI)
- **`METERS_TELEMETRY`**: Каждые 10 мс фоновый поток отправляет реальные расчетные значения пиков `PeakL` / `PeakR` и `RMS` каждого трека и мастер-шины для гладкой индикации уровнемеров в интерфейсе.
