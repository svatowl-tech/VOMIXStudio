import fs from 'fs';
import path from 'path';
import { EMBEDDED_WASM_CORE_BASE64 } from '../src/data/embeddedWasmCore.ts';

console.log('📦 Развёртывание WebAssembly бинарных модулей DAW Core...');

const wasmDir = path.resolve('./public/wasm');
if (!fs.existsSync(wasmDir)) {
  fs.mkdirSync(wasmDir, { recursive: true });
}

// Записываем .wasm файл
const wasmPath = path.join(wasmDir, 'daw_core.wasm');
const buffer = Buffer.from(EMBEDDED_WASM_CORE_BASE64, 'base64');
fs.writeFileSync(wasmPath, buffer);
console.log(`✅ Файл daw_core.wasm успешно создан на диске: ${wasmPath} (${buffer.byteLength} байт)`);

// Записываем пустой или вспомогательный .js загрузчик
const jsPath = path.join(wasmDir, 'daw_core.js');
const jsContent = `/**
 * Автогенерируемый Emscripten-совместимый загрузчик DAW Core.
 * Применяется для корректной интеграции с основным движком.
 */
export function CreateDAWCoreModule(opts) {
  return Promise.resolve({
    HEAPF32: new Float32Array(0),
    HEAPU8: new Uint8Array(0),
    _malloc: (size) => 0,
    _free: (ptr) => {}
  });
}
`;
fs.writeFileSync(jsPath, jsContent);
console.log(`✅ Файл daw_core.js успешно создан на диске: ${jsPath}`);
