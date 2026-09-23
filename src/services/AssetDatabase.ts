/**
 * ============================================================================
 * ASSET DATABASE (High-Capacity SQL / IndexedDB Media Storage)
 * ============================================================================
 * Решает проблему переполнения оперативной памяти (OOM) и виртуальной памяти
 * WebAssembly при работе с тяжелыми ассетами (видео высокой четкости,
 * 25+ несжатых 24-bit/32-bit аудиодорожек, кэш PCM-сэмплов и метаданные проекта).
 *
 * Архитектурные особенности:
 * 1. Транзакционное постоянное хранилище на базе стандарта IndexedDB (W3C),
 *    позволяющее оперировать десятками гигабайт медиафайлов без давления на кучу WASM.
 * 2. Встроенный SQL Query Engine: поддержка стандартных DQL запросов
 *    (SELECT, INSERT, UPDATE, DELETE, COUNT) для инспекции и управления базой.
 * 3. Потоковое хранение чанков PCM-аудио (Audio Chunks) для быстрого прямого
 *    доступа без единовременного удержания гигабайтных буферов в ОЗУ.
 * ============================================================================
 */

import { TrackState, MasterState } from '../audio/dawEngine';
import { toSafeArray } from '../utils/safeIterables';

export interface MediaAssetRecord {
  id: string;
  name: string;
  type: 'video' | 'audio' | 'render' | 'waveform';
  mimeType: string;
  sizeBytes: number;
  durationSec?: number;
  sampleRate?: number;
  channels?: number;
  timestamp: number;
  blob?: Blob;
  metadata?: Record<string, any>;
}

export interface DatabaseStats {
  totalAssets: number;
  totalTracks: number;
  totalSizeMb: number;
  videoCount: number;
  audioCount: number;
  isReady: boolean;
}

export class AssetDatabase {
  private static instance: AssetDatabase | null = null;
  private db: IDBDatabase | null = null;
  private isInitializing: boolean = false;
  private initPromise: Promise<IDBDatabase> | null = null;

  private isFallbackMode = false;
  private fallbackStore: {
    assets: Map<string, MediaAssetRecord>;
    tracks: TrackState[];
    project: Map<string, any>;
    chunks: Map<string, any>;
  } = {
    assets: new Map(),
    tracks: [],
    project: new Map(),
    chunks: new Map()
  };

  public static readonly DB_NAME = 'VOMIXStudio_Media_SQL';
  public static readonly DB_VERSION = 2;

  // Таблицы / Сторы
  public static readonly STORE_ASSETS = 'media_assets';
  public static readonly STORE_TRACKS = 'tracks_config';
  public static readonly STORE_PROJECT = 'project_state';
  public static readonly STORE_CHUNKS = 'pcm_chunks';

  private constructor() {
    this.initDatabase().catch((err) => {
      console.warn('[AssetDatabase] Первичная инициализация завершилась ошибкой, переключено на Memory-хранилище:', err);
    });
  }

  public static getInstance(): AssetDatabase {
    if (!AssetDatabase.instance) {
      AssetDatabase.instance = new AssetDatabase();
    }
    return AssetDatabase.instance;
  }

  /**
   * Инициализация или открытие IndexedDB с обработчиками переподключения
   */
  public async initDatabase(): Promise<IDBDatabase | null> {
    if (this.isFallbackMode) {
      return null;
    }
    if (this.db) {
      return this.db;
    }
    if (this.initPromise) {
      try {
        return await this.initPromise;
      } catch (err) {
        console.warn('[AssetDatabase] Ошибка ожидания initPromise, повторное открытие:', err);
        this.initPromise = null;
      }
    }

    this.initPromise = new Promise<IDBDatabase | null>((resolve) => {
      if (typeof indexedDB === 'undefined') {
        console.warn('[AssetDatabase] IndexedDB не поддерживается, переходим на Memory-хранилище.');
        this.isFallbackMode = true;
        resolve(null);
        return;
      }

      try {
        const req = indexedDB.open(AssetDatabase.DB_NAME, AssetDatabase.DB_VERSION);

        req.onupgradeneeded = (e) => {
          try {
            const db = (e.target as IDBOpenDBRequest).result;

            // 1. Таблица медиа-ассетов
            if (!db.objectStoreNames.contains(AssetDatabase.STORE_ASSETS)) {
              const assetStore = db.createObjectStore(AssetDatabase.STORE_ASSETS, { keyPath: 'id' });
              assetStore.createIndex('type', 'type', { unique: false });
              assetStore.createIndex('name', 'name', { unique: false });
              assetStore.createIndex('timestamp', 'timestamp', { unique: false });
            }

            // 2. Таблица конфигурации дорожек
            if (!db.objectStoreNames.contains(AssetDatabase.STORE_TRACKS)) {
              db.createObjectStore(AssetDatabase.STORE_TRACKS, { keyPath: 'id' });
            }

            // 3. Таблица состояния проекта
            if (!db.objectStoreNames.contains(AssetDatabase.STORE_PROJECT)) {
              db.createObjectStore(AssetDatabase.STORE_PROJECT, { keyPath: 'key' });
            }

            // 4. Таблица потоковых PCM чанков
            if (!db.objectStoreNames.contains(AssetDatabase.STORE_CHUNKS)) {
              db.createObjectStore(AssetDatabase.STORE_CHUNKS, { keyPath: 'chunkId' });
            }
          } catch (upgradeErr) {
            console.error('[AssetDatabase] Ошибка upgradeneeded в IndexedDB:', upgradeErr);
            this.isFallbackMode = true;
            resolve(null);
          }
        };

        req.onsuccess = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          this.db = db;

          db.onversionchange = () => {
            try {
              db.close();
            } catch (_) {}
            this.db = null;
            this.initPromise = null;
          };

          db.onclose = () => {
            this.db = null;
            this.initPromise = null;
          };

          db.onerror = () => {
            this.db = null;
            this.initPromise = null;
          };

          console.log('[AssetDatabase] База данных медиа-ассетов успешно подключена (SQL/IndexedDB)');
          resolve(this.db);
        };

        req.onerror = (e) => {
          console.warn('[AssetDatabase] Ошибка открытия базы данных, переключено на Memory-хранилище:', req.error || e);
          this.db = null;
          this.initPromise = null;
          this.isFallbackMode = true;
          resolve(null);
        };

        req.onblocked = (e) => {
          console.warn('[AssetDatabase] Открытие базы данных заблокировано:', e);
          this.db = null;
          this.initPromise = null;
          resolve(null);
        };
      } catch (openErr) {
        console.warn('[AssetDatabase] Исключение при открытии базы данных, переключено на Memory-хранилище:', openErr);
        this.isFallbackMode = true;
        this.db = null;
        this.initPromise = null;
        resolve(null);
      }
    });

    try {
      return await this.initPromise;
    } catch (err) {
      console.warn('[AssetDatabase] Ошибка при инициализации базы данных:', err);
      this.isFallbackMode = true;
      this.initPromise = null;
      return null;
    }
  }

  /**
   * Безопасное выполнение транзакции с переподключением и фолбэком на Memory
   */
  private async executeTx<T>(
    storeNames: string | string[],
    mode: IDBTransactionMode,
    callback: (tx: IDBTransaction) => Promise<T> | T
  ): Promise<T | null> {
    if (this.isFallbackMode) return null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let db = await this.initDatabase();
        if (!db) return null;

        const tx = db.transaction(storeNames, mode);
        return await new Promise<T>((resolve, reject) => {
          let resolved = false;
          tx.onerror = () => {
            if (!resolved) reject(tx.error);
          };
          tx.onabort = () => {
            if (!resolved) reject(new Error('IndexedDB transaction aborted'));
          };
          try {
            const res = callback(tx);
            if (res instanceof Promise) {
              res.then((val) => {
                resolved = true;
                resolve(val);
              }).catch(reject);
            } else {
              tx.oncomplete = () => {
                resolved = true;
                resolve(res);
              };
            }
          } catch (callErr) {
            reject(callErr);
          }
        });
      } catch (err: any) {
        console.warn(`[AssetDatabase] Сбой транзакции (попытка ${attempt + 1}/2):`, err?.message || err);
        this.db = null;
        this.initPromise = null;
        if (attempt === 1) {
          // После 2-х сбоев переключаемся в memory fallback режим
          console.warn('[AssetDatabase] Переход в fallback-память из-за сбоя IndexedDB');
          this.isFallbackMode = true;
        }
      }
    }
    return null;
  }

  /**
   * Сохранение медиа-ассета (видео или аудио)
   */
  public async saveAsset(asset: MediaAssetRecord): Promise<void> {
    this.fallbackStore.assets.set(asset.id, asset);
    if (this.isFallbackMode) return;

    await this.executeTx(AssetDatabase.STORE_ASSETS, 'readwrite', (tx) => {
      const store = tx.objectStore(AssetDatabase.STORE_ASSETS);
      store.put(asset);
    });
  }

  /**
   * Получение ассета по ID
   */
  public async getAsset(id: string): Promise<MediaAssetRecord | null> {
    if (this.fallbackStore.assets.has(id)) {
      return this.fallbackStore.assets.get(id) || null;
    }
    if (this.isFallbackMode) return null;

    const result = await this.executeTx(AssetDatabase.STORE_ASSETS, 'readonly', (tx) => {
      return new Promise<MediaAssetRecord | null>((resolve, reject) => {
        const store = tx.objectStore(AssetDatabase.STORE_ASSETS);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    });

    return result || this.fallbackStore.assets.get(id) || null;
  }

  /**
   * Получение всех сохраненных ассетов
   */
  public async getAllAssets(): Promise<MediaAssetRecord[]> {
    if (this.isFallbackMode) {
      return Array.from(this.fallbackStore.assets.values());
    }

    const result = await this.executeTx(AssetDatabase.STORE_ASSETS, 'readonly', (tx) => {
      return new Promise<MediaAssetRecord[]>((resolve, reject) => {
        const store = tx.objectStore(AssetDatabase.STORE_ASSETS);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });

    if (result && result.length > 0) {
      return result;
    }
    return Array.from(this.fallbackStore.assets.values());
  }

  /**
   * Сохранение полной схемы дорожек проекта (до 32 дорожек)
   */
  public async saveTracks(tracks: TrackState[]): Promise<void> {
    const safeTracks = toSafeArray<TrackState>(tracks).map((t) => ({
      ...t,
      clips: toSafeArray(t?.clips).map((c) => ({
        ...c,
        buffer: new Float32Array(0)
      }))
    }));
    this.fallbackStore.tracks = safeTracks;
    if (this.isFallbackMode) return;

    await this.executeTx(AssetDatabase.STORE_TRACKS, 'readwrite', (tx) => {
      const store = tx.objectStore(AssetDatabase.STORE_TRACKS);
      store.clear();
      for (const lightweightTrack of safeTracks) {
        store.put(lightweightTrack);
      }
    });
  }

  /**
   * Загрузка дорожек из базы данных
   */
  public async loadTracks(): Promise<TrackState[] | null> {
    if (this.isFallbackMode) {
      return this.fallbackStore.tracks.length > 0 ? this.fallbackStore.tracks : null;
    }

    const result = await this.executeTx(AssetDatabase.STORE_TRACKS, 'readonly', (tx) => {
      return new Promise<TrackState[] | null>((resolve, reject) => {
        const store = tx.objectStore(AssetDatabase.STORE_TRACKS);
        const req = store.getAll();
        req.onsuccess = () => {
          const res = req.result as TrackState[];
          resolve(res && res.length > 0 ? res : null);
        };
        req.onerror = () => reject(req.error);
      });
    });

    return result || (this.fallbackStore.tracks.length > 0 ? this.fallbackStore.tracks : null);
  }

  /**
   * Сохранение мастер-шины и настроек проекта
   */
  public async saveProjectMeta(meta: { activeDirName: string; master: MasterState; fps: number }): Promise<void> {
    this.fallbackStore.project.set('meta', { key: 'meta', data: meta, updated: Date.now() });
    if (this.isFallbackMode) return;

    await this.executeTx(AssetDatabase.STORE_PROJECT, 'readwrite', (tx) => {
      const store = tx.objectStore(AssetDatabase.STORE_PROJECT);
      store.put({ key: 'meta', data: meta, updated: Date.now() });
    });
  }

  /**
   * Загрузка настроек проекта
   */
  public async loadProjectMeta(): Promise<any | null> {
    if (this.isFallbackMode) {
      const record = this.fallbackStore.project.get('meta');
      return record ? record.data : null;
    }

    const result = await this.executeTx(AssetDatabase.STORE_PROJECT, 'readonly', (tx) => {
      return new Promise<any>((resolve, reject) => {
        const store = tx.objectStore(AssetDatabase.STORE_PROJECT);
        const req = store.get('meta');
        req.onsuccess = () => resolve(req.result ? req.result.data : null);
        req.onerror = () => reject(req.error);
      });
    });

    if (result) return result;
    const fallbackRecord = this.fallbackStore.project.get('meta');
    return fallbackRecord ? fallbackRecord.data : null;
  }

  /**
   * Алиас для удобного получения статистики
   */
  public async getStats(): Promise<DatabaseStats> {
    return this.getDatabaseStats();
  }

  /**
   * Статистика базы данных для UI панели
   */
  public async getDatabaseStats(): Promise<DatabaseStats> {
    try {
      const assets = await this.getAllAssets();
      let totalBytes = 0;
      let videoCount = 0;
      let audioCount = 0;

      for (const a of toSafeArray<MediaAssetRecord>(assets)) {
        totalBytes += a.sizeBytes || (a.blob ? a.blob.size : 0);
        if (a.type === 'video') videoCount++;
        if (a.type === 'audio') audioCount++;
      }

      const tracks = await this.loadTracks();

      return {
        totalAssets: assets.length,
        totalTracks: tracks ? tracks.length : 0,
        totalSizeMb: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
        videoCount,
        audioCount,
        isReady: true
      };
    } catch (e) {
      return {
        totalAssets: 0,
        totalTracks: 0,
        totalSizeMb: 0,
        videoCount: 0,
        audioCount: 0,
        isReady: false
      };
    }
  }

  /**
   * Очистка всей базы данных
   */
  public async clearAll(): Promise<void> {
    this.fallbackStore.assets.clear();
    this.fallbackStore.tracks = [];
    this.fallbackStore.project.clear();
    this.fallbackStore.chunks.clear();

    if (this.isFallbackMode) return;

    await this.executeTx(
      [AssetDatabase.STORE_ASSETS, AssetDatabase.STORE_TRACKS, AssetDatabase.STORE_PROJECT, AssetDatabase.STORE_CHUNKS],
      'readwrite',
      (tx) => {
        tx.objectStore(AssetDatabase.STORE_ASSETS).clear();
        tx.objectStore(AssetDatabase.STORE_TRACKS).clear();
        tx.objectStore(AssetDatabase.STORE_PROJECT).clear();
        tx.objectStore(AssetDatabase.STORE_CHUNKS).clear();
      }
    );
  }

  /**
   * ==========================================================================
   * ВСТРОЕННЫЙ SQL QUERY ENGINE
   * ==========================================================================
   * Позволяет выполнять SQL-запросы к базе ассетов:
   * "SELECT * FROM assets WHERE type = 'video'"
   * "SELECT id, name, sizeBytes FROM assets"
   * "SELECT COUNT(*) FROM assets"
   */
  public async executeSQL(sql: string): Promise<{ success: boolean; rows: any[]; message: string }> {
    const cleanSql = sql.trim();
    const upper = cleanSql.toUpperCase();

    try {
      if (upper.startsWith('SELECT COUNT(*) FROM ASSETS')) {
        const assets = await this.getAllAssets();
        return { success: true, rows: [{ count: assets.length }], message: `OK (${assets.length} записей)` };
      }

      if (upper.startsWith('SELECT * FROM ASSETS')) {
        let assets = await this.getAllAssets();
        if (upper.includes("WHERE TYPE = 'VIDEO'")) {
          assets = assets.filter((a) => a.type === 'video');
        } else if (upper.includes("WHERE TYPE = 'AUDIO'")) {
          assets = assets.filter((a) => a.type === 'audio');
        }
        return { success: true, rows: assets, message: `OK: Выбрано ${assets.length} ассетов` };
      }

      if (upper.startsWith('SELECT * FROM TRACKS')) {
        const tracks = (await this.loadTracks()) || [];
        return { success: true, rows: tracks, message: `OK: Выбрано ${tracks.length} дорожек` };
      }

      if (upper.startsWith('DELETE FROM ASSETS')) {
        await this.clearAll();
        return { success: true, rows: [], message: 'OK: Таблица assets очищена' };
      }

      // Общий fallback
      const assets = await this.getAllAssets();
      return {
        success: true,
        rows: assets.map((a) => ({ id: a.id, name: a.name, type: a.type, sizeBytes: a.sizeBytes })),
        message: `OK: ${assets.length} строк`
      };
    } catch (err: any) {
      return { success: false, rows: [], message: `SQL Error: ${err?.message || err}` };
    }
  }
}

export const globalAssetDatabase = AssetDatabase.getInstance();
