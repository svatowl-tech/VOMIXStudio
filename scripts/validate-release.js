import fs from 'fs';
import path from 'path';

console.log('🔍 Проверка синхронизации версий релизов VOMIXStudio...');

const pkgPath = path.resolve('./package.json');
const tauriConfigPath = path.resolve('./src-tauri/tauri.conf.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));

console.log(`📦 package.json version: ${pkg.version}`);
console.log(`🦀 tauri.conf.json version: ${tauriConfig.version}`);

if (pkg.version !== tauriConfig.version) {
  console.error('❌ Ошибка: Версии в package.json и tauri.conf.json не совпадают!');
  process.exit(1);
}

console.log('✅ Валидация релиза успешна! Все версии синхронизированы.');
