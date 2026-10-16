/**
 * Minimal IndexedDB storage for save games. Every call degrades gracefully
 * (resolves to null / false) when storage is unavailable, e.g. in private
 * browsing.
 */
const DB = 'hydro';
const STORE = 'saves';

export interface SaveInfo {
  /** Wall-clock time of saving (ms since epoch). */
  savedAt: number;
  seed: number;
  day: number;
}

interface Row extends SaveInfo {
  bytes: ArrayBuffer;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function done<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function writeSave(slot: string, bytes: ArrayBuffer, info: SaveInfo): Promise<boolean> {
  const db = await open();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const ok = await done(tx.objectStore(STORE).put({ ...info, bytes } satisfies Row, slot));
    return ok !== null;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export async function readSave(slot: string): Promise<(SaveInfo & { bytes: ArrayBuffer }) | null> {
  const db = await open();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, 'readonly');
    return ((await done(tx.objectStore(STORE).get(slot))) as Row | undefined) ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function deleteSave(slot: string): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    await done(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(slot));
  } catch {
    // ignore
  } finally {
    db.close();
  }
}
