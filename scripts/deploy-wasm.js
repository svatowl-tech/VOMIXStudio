import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const wasmDir = path.join(rootDir, 'public', 'wasm');
const wasmFilePath = path.join(wasmDir, 'daw_core.wasm');
const jsFilePath = path.join(wasmDir, 'daw_core.js');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function hasEmcc() {
  try {
    execSync('emcc --version', { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function deployFallbackWasm() {
  console.log('[deploy-wasm] Extracting embedded WASM fallback binary from src/data/embeddedWasmCore.ts...');
  const embeddedFilePath = path.join(rootDir, 'src', 'data', 'embeddedWasmCore.ts');
  let base64String = 'AGFzbQEAAAA=';

  if (fs.existsSync(embeddedFilePath)) {
    const content = fs.readFileSync(embeddedFilePath, 'utf-8');
    const match = content.match(/EMBEDDED_WASM_CORE_BASE64\s*=\s*['"]([^'"]+)['"]/);
    if (match && match[1]) {
      base64String = match[1];
    }
  }

  const wasmBuffer = Buffer.from(base64String, 'base64');
  ensureDir(wasmDir);
  fs.writeFileSync(wasmFilePath, wasmBuffer);
  console.log(`[deploy-wasm] Wrote fallback WASM binary (${wasmBuffer.byteLength} bytes) to ${wasmFilePath}`);

  if (!fs.existsSync(jsFilePath)) {
    const stubJsContent = `// DAW Core Embind Glue JS Stub
var Module = typeof Module !== 'undefined' ? Module : {};
if (typeof module !== 'undefined') { module.exports = Module; }
`;
    fs.writeFileSync(jsFilePath, stubJsContent, 'utf-8');
    console.log(`[deploy-wasm] Wrote glue JS stub to ${jsFilePath}`);
  }
}

function main() {
  try {
    ensureDir(wasmDir);
    const wasmExists = fs.existsSync(wasmFilePath) && fs.statSync(wasmFilePath).size > 0;
    const jsExists = fs.existsSync(jsFilePath) && fs.statSync(jsFilePath).size > 0;

    if (wasmExists && jsExists) {
      console.log('[deploy-wasm] WebAssembly files daw_core.wasm and daw_core.js are already present in public/wasm/.');
      return;
    }

    console.log('[deploy-wasm] WASM files missing or incomplete in public/wasm/.');

    if (hasEmcc()) {
      console.log('[deploy-wasm] emcc toolchain detected. Invoking src/cpp/build_wasm.sh...');
      try {
        const buildScriptPath = path.join(rootDir, 'src', 'cpp', 'build_wasm.sh');
        execSync(`bash "${buildScriptPath}"`, { stdio: 'inherit', cwd: rootDir });
        console.log('[deploy-wasm] C++ WebAssembly compilation completed successfully.');
      } catch (buildErr) {
        console.warn('[deploy-wasm] C++ build failed, falling back to embedded WASM core:', buildErr.message);
        deployFallbackWasm();
      }
    } else {
      console.log('[deploy-wasm] emcc toolchain not found in PATH.');
      deployFallbackWasm();
    }
  } catch (err) {
    console.warn('[deploy-wasm] Unexpected error in deploy-wasm script, ensuring fallback WASM:', err.message);
    deployFallbackWasm();
  }
}

main();
