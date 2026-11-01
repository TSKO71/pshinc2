import type { Tile } from './data';
let connection: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return connection ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('opuscraft-horizon-v1', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('tiles');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
/** Cache failures must never prevent gameplay or discard the world save. */
export async function loadTile(key: string): Promise<Tile | undefined> {
  try { const d = await db(); return await new Promise((resolve, reject) => {
    const r = d.transaction('tiles').objectStore('tiles').get(key);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  }); } catch { return undefined; }
}
export async function saveTile(key: string, tile: Tile): Promise<void> {
  try { const d = await db(); await new Promise<void>((resolve, reject) => {
    const t = d.transaction('tiles', 'readwrite'); t.objectStore('tiles').put(tile, key);
    t.oncomplete = () => resolve(); t.onerror = t.onabort = () => reject(t.error);
  }); } catch { /* optional derived cache; canonical chunk saves are independent */ }
}
