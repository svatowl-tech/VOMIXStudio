/**
 * ============================================================================
 * safeIterables.ts - Глобальный утилитарный хелпер безопасности типов
 * ============================================================================
 * Предотвращает критические ошибки времени выполнения (Runtime Errors):
 * - "TypeError: [Variable] is not iterable"
 * - "TypeError: Cannot read properties of undefined/null (reading 'map')"
 * - "TypeError: [Variable].filter is not a function"
 *
 * Обеспечивает безопасное преобразование любых входящих данных в гарантированно
 * валидные, итерируемые структуры данных (Array, Map, Set).
 * ============================================================================
 */

/**
 * Безопасно преобразует любой входной параметр (Array, FileList, Map, Set, null, undefined) в чистый массив T[].
 */
export function toSafeArray<T>(val: unknown): T[] {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) {
    return val.filter((x) => x !== null && x !== undefined) as T[];
  }
  if (
    (typeof FileList !== 'undefined' && val instanceof FileList) ||
    (typeof NodeList !== 'undefined' && val instanceof NodeList)
  ) {
    return Array.from(val as any).filter((x) => x !== null && x !== undefined) as unknown as T[];
  }
  if (val instanceof Set) {
    return Array.from(val).filter((x) => x !== null && x !== undefined) as T[];
  }
  if (val instanceof Map) {
    return Array.from(val.values()).filter((x) => x !== null && x !== undefined) as T[];
  }
  if (val instanceof Float32Array || val instanceof Uint8Array || val instanceof Int16Array) {
    // Не деструктируем бинарные буферы в массив, если это не требуется, но возвращаем как элементы если нужно
    return Array.from(val) as unknown as T[];
  }
  if (typeof val === 'object') {
    return Object.values(val as Record<string, any>).filter((x) => x !== null && x !== undefined) as T[];
  }
  return [];
}

/**
 * Безопасно преобразует любое значение в гарантированный Map<K, V>.
 */
export function toSafeMap<K = any, V = any>(val: unknown): Map<K, V> {
  if (!val) {
    return new Map<K, V>();
  }

  if (val instanceof Map) {
    return val as Map<K, V>;
  }

  if (Array.isArray(val)) {
    try {
      const validEntries = val.filter((entry) => Array.isArray(entry) && entry.length >= 2);
      return new Map<K, V>(validEntries as [K, V][]);
    } catch {
      return new Map<K, V>();
    }
  }

  if (typeof val === 'object') {
    try {
      return new Map<K, V>(Object.entries(val) as unknown as [K, V][]);
    } catch {
      return new Map<K, V>();
    }
  }

  return new Map<K, V>();
}

/**
 * Безопасно преобразует любое значение в гарантированный Set<T>.
 */
export function toSafeSet<T = any>(val: unknown): Set<T> {
  if (!val) {
    return new Set<T>();
  }

  if (val instanceof Set) {
    return val as Set<T>;
  }

  return new Set<T>(toSafeArray<T>(val));
}
