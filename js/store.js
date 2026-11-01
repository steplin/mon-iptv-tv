// Stockage local : IndexedDB pour les gros volumes (catalogue, mes flux),
// localStorage pour les petits réglages. Tout reste sur le téléphone.

const DB_NAME = 'mon-iptv-tv';
const STORE = 'kv';
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function get(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch { return undefined; }
}

export async function set(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function pref(key, fallback) {
  try {
    const v = localStorage.getItem('miptv.' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

export function setPref(key, value) {
  try { localStorage.setItem('miptv.' + key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
}
