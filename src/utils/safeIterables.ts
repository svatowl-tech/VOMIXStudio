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
 * Безопасно преобразует любое значение в строго типизированный массив T[].
 * 
 * Логика обработки:
 * 1. Если передан null или undefined -> []
 * 2. Если передан валидный массив -> фильтрует ложные/пустые элементы (.filter(Boolean))
 * 3. Если передан Set или Map -> преобразует элементы/значения в массив
 * 4. Если передан объект (словарь) -> извлекает его значения через Object.values(val).filter(Boolean)
 * 5. В остальных случаях (примитивы, функции, символы) -> возвращает пустой массив []
 */
export function toSafeArray<T = any>(val: unknown): T[] {
  if (val === null || val === undefined) {
    return [];
  }

  // 1. Прямой массив
  if (Array.isArray(val)) {
    return (val as T[]).filter(Boolean);
  }

  // 2. Коллекция Set
  if (val instanceof Set) {
    return Array.from(val as Set<T>).filter(Boolean);
  }

  // 3. Коллекция Map
  if (val instanceof Map) {
    return Array.from(val.values() as Iterable<T>).filter(Boolean);
  }

  // 4. Итерируемый объект (Symbol.iterator), исключая строки и примитивы
  if (typeof val === 'object') {
    // Проверяем наличие Symbol.iterator
    if (typeof (val as any)[Symbol.iterator] === 'function' && typeof val !== 'string') {
      try {
        return Array.from(val as Iterable<T>).filter(Boolean);
      } catch {
        // Fallback на Object.values при сбое итератора
      }
    }

    // 5. Обычный объект/словарь с ключами -> Object.values
    try {
      const values = Object.values(val as Record<string, any>);
      return (values as T[]).filter(Boolean);
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Безопасно преобразует любое значение в гарантированный Map<K, V>.
 * 
 * Логика обработки:
 * 1. Если уже является Map -> возвращает сам экземпляр (или валидную копию)
 * 2. Если передан массив пар [ключ, значение] -> new Map(entries)
 * 3. Если передан обычный объект -> new Map(Object.entries(val))
 * 4. В остальных случаях -> пустой new Map<K, V>()
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
      // Проверяем, что элементы являются парами [key, value]
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
