/** Minimal promise wrapper over IndexedDB for the local storage provider and offline queues. */
const DB_NAME = 'singersvoice';
const DB_VERSION = 2;

export const STORES = {
  tracks: 'tracks', // key: trackId → { track, audio: Blob, audioMime }
  performances: 'performances', // key: performanceId → { manifest, vocal: Blob, video: Blob|null }
  config: 'config', // key: name → any
  queue: 'queue', // key: id → pending upload job
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

export const idb = {
  get: <T>(store: string, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key)),
  put: (store: string, key: string, value: unknown) => tx<IDBValidKey>(store, 'readwrite', (s) => s.put(value, key)),
  del: (store: string, key: string) => tx<undefined>(store, 'readwrite', (s) => s.delete(key)),
  keys: (store: string) => tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()),
  all: <T>(store: string) => tx<T[]>(store, 'readonly', (s) => s.getAll()),
  clear: (store: string) => tx<undefined>(store, 'readwrite', (s) => s.clear()),
};
