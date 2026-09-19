/**
 * Реестр модульных исходных файлов C++17 DAW Core Engine
 */

export interface CppFileItem {
  path: string;
  name: string;
  category: 'dsp' | 'vocal' | 'engine' | 'editing' | 'analysis' | 'bindings' | 'build';
  description: string;
}

export const CPP_FILES_METADATA: CppFileItem[] = [
  { path: 'dsp/AudioMath.hpp', name: 'AudioMath.hpp', category: 'dsp', description: 'Константы, dB/Gain преобразования и SIMD128 макросы' },
  { path: 'dsp/BiquadFilter.hpp', name: 'BiquadFilter.hpp', category: 'dsp', description: 'Заголовок БИХ-фильтров 2-го порядка и 3-полосного EQ' },
  { path: 'dsp/BiquadFilter.cpp', name: 'BiquadFilter.cpp', category: 'dsp', description: 'Реализация Audio EQ Cookbook и SIMD-пакетной фильтрации' },
  { path: 'dsp/Dynamics.hpp', name: 'Dynamics.hpp', category: 'dsp', description: 'Интерфейсы SoftKneeCompressor, NoiseGate, AutoDucker, SoftLimiter' },
  { path: 'dsp/Dynamics.cpp', name: 'Dynamics.cpp', category: 'dsp', description: 'Реализация динамической компрессии, гейта на FSM и дакера' },
  { path: 'dsp/AudioUtils.hpp', name: 'AudioUtils.hpp', category: 'dsp', description: 'Заголовки LoudnessAnalyzer, Catmull-Rom ресэмплера и WAV пакера' },
  { path: 'dsp/AudioUtils.cpp', name: 'AudioUtils.cpp', category: 'dsp', description: 'SIMD True Peak / RMS, нормализация EBU R128 и запись WAV' },
  { path: 'vocal/VocalRack.hpp', name: 'VocalRack.hpp', category: 'vocal', description: 'Интерфейсы DeClicker, DePlosive, DeEsser и VocalRack' },
  { path: 'vocal/VocalRack.cpp', name: 'VocalRack.cpp', category: 'vocal', description: 'Сплайны Hermite, сайдчейн-фильтрация и сборка студийного тракта' },
  { path: 'engine/Clip.hpp', name: 'Clip.hpp', category: 'engine', description: 'Структура аудиоклипа, таймлайн оффсет и фейды' },
  { path: 'engine/Clip.cpp', name: 'Clip.cpp', category: 'engine', description: 'Расчет гладких Fade In / Fade Out огибающих' },
  { path: 'engine/Track.hpp', name: 'Track.hpp', category: 'engine', description: 'Дорожка микшера, RT-буфер, Constant Power Pan' },
  { path: 'engine/Track.cpp', name: 'Track.cpp', category: 'engine', description: 'Рендеринг клипов без аллокаций (Zero-Alloc) и вокальный процессор' },
  { path: 'engine/Mixer.hpp', name: 'Mixer.hpp', category: 'engine', description: 'Главный микшер, мастер-секция, офлайн-рендеринг' },
  { path: 'engine/Mixer.cpp', name: 'Mixer.cpp', category: 'engine', description: 'Сумматор с SIMD, Solo/Mute, шина сайдчейна и нормализация' },
  { path: 'editing/WSOLATimeStretch.hpp', name: 'WSOLATimeStretch.hpp', category: 'editing', description: 'Заголовок алгоритма WSOLA тайм-стретчинга с SIMD корреляцией' },
  { path: 'editing/WSOLATimeStretch.cpp', name: 'WSOLATimeStretch.cpp', category: 'editing', description: 'Реализация WSOLA (Overlap-Add) для моно и фазосинхронного стерео' },
  { path: 'editing/ClipEditor.hpp', name: 'ClipEditor.hpp', category: 'editing', description: 'Менеджер нарезки Split/Trim и применения WSOLA к клипам' },
  { path: 'editing/ClipEditor.cpp', name: 'ClipEditor.cpp', category: 'editing', description: 'Zero-copy разделение клипов с микро-фейдами и модификация в куче WASM' },
  { path: 'analysis/SpeechAligner.hpp', name: 'SpeechAligner.hpp', category: 'analysis', description: 'Интерфейсы FastLevenshtein (UTF-8), SpeechEnergyDetector (SIMD128 VAD) и SmartAligner' },
  { path: 'analysis/SpeechAligner.cpp', name: 'SpeechAligner.cpp', category: 'analysis', description: 'Реализация нормализации UTF-8, DP расстояния Левенштейна, ZCR/RMS VAD и выравнивания сценария' },
  { path: 'bindings/EmscriptenBindings.cpp', name: 'EmscriptenBindings.cpp', category: 'bindings', description: 'Embind экспорт классов и C-функций в JavaScript Heap' },
  { path: 'CMakeLists.txt', name: 'CMakeLists.txt', category: 'build', description: 'Скрипт CMake для нативной и Emscripten WASM сборки' },
  { path: 'build_wasm.sh', name: 'build_wasm.sh', category: 'build', description: 'Shell-скрипт компиляции через emcc (-O3, -msimd128, -flto)' }
];
