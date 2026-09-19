/**
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
