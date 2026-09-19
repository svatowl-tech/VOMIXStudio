import fs from 'fs';
import path from 'path';
import { EMBEDDED_WASM_CORE_BASE64 } from '../src/data/embeddedWasmCore.ts';

console.log('📦 Развёртывание WebAssembly бинарных модулей DAW Core...');

const wasmDir = path.resolve('./public/wasm');
if (!fs.existsSync(wasmDir)) {
  fs.mkdirSync(wasmDir, { recursive: true });
}

// Записываем .wasm файл только если он не существует или имеет размер <= 100 байт (dummy)
const wasmPath = path.join(wasmDir, 'daw_core.wasm');
let shouldWriteWasm = true;
if (fs.existsSync(wasmPath)) {
  const stats = fs.statSync(wasmPath);
  if (stats.size > 100) {
    shouldWriteWasm = false;
    console.log(`ℹ️ Обнаружен существующий скомпилированный daw_core.wasm (${stats.size} байт). Пропуск перезаписи.`);
  }
}

if (shouldWriteWasm) {
  const buffer = Buffer.from(EMBEDDED_WASM_CORE_BASE64, 'base64');
  fs.writeFileSync(wasmPath, buffer);
  console.log(`✅ Файл daw_core.wasm успешно создан на диске: ${wasmPath} (${buffer.byteLength} байт)`);
}

// Записываем пустой или вспомогательный .js загрузчик, только если существующий пуст или является dummy
const jsPath = path.join(wasmDir, 'daw_core.js');
let shouldWriteJs = true;
if (fs.existsSync(jsPath)) {
  const stats = fs.statSync(jsPath);
  if (stats.size > 500) {
    shouldWriteJs = false;
    console.log(`ℹ️ Обнаружен существующий оригинальный загрузчик daw_core.js (${stats.size} байт). Пропуск перезаписи.`);
  }
}

if (shouldWriteJs) {
  const jsContent = `/**
 * Автогенерируемый Emscripten-совместимый загрузчик DAW Core.
 * Применяется для корректной интеграции с основным движком.
 */
function CreateDAWCoreModule(opts) {
  return Promise.resolve({
    HEAPF32: new Float32Array(0),
    HEAPU8: new Uint8Array(0),
    _malloc: (size) => 0,
    _free: (ptr) => {}
  });
}

if (typeof window !== 'undefined') {
  window.CreateDAWCoreModule = CreateDAWCoreModule;
}
if (typeof globalThis !== 'undefined') {
  globalThis.CreateDAWCoreModule = CreateDAWCoreModule;
}
if (typeof self !== 'undefined') {
  self.CreateDAWCoreModule = CreateDAWCoreModule;
}
if (typeof exports === 'object' && typeof module !== 'undefined') {
  module.exports = CreateDAWCoreModule;
}
`;
  fs.writeFileSync(jsPath, jsContent);
  console.log(`✅ Файл daw_core.js успешно создан на диске: ${jsPath}`);
}
