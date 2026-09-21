/**
 * ============================================================================
 * cppModulesCode.ts - Динамический импорт исходников C++17 из src/cpp/ через Vite
 * ============================================================================
 * Читает сырые исходные файлы C++ без статичной дублирующей строки в bundle.
 * ============================================================================
 */

const rawCppModules = import.meta.glob('/src/cpp/**/*?raw', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

export const MODULAR_CPP_SOURCES: Record<string, string> = {};

for (const [filePath, content] of Object.entries(rawCppModules)) {
  const normalizedPath = filePath.replace(/^\/src\/cpp\//, '');
  MODULAR_CPP_SOURCES[normalizedPath] = content;
}
