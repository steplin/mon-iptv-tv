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
  if (memory.has(key)) return memory.get(key);
  try {
    const db = await openDb();
    const v = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (v !== undefined) return v;
  } catch { /* IndexedDB indisponible */ }
  try {
    const v = localStorage.getItem('miptv.db.' + key);
    return v == null ? undefined : JSON.parse(v);
  } catch { return undefined; }
}

// Quand IndexedDB est indisponible (fichier HTML ouvert depuis le téléphone, navigation privée…),
// on se rabat sur localStorage, puis sur la mémoire pour la session en cours.
const memory = new Map();

export async function set(key, value) {
  memory.set(key, value);
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    try { localStorage.setItem('miptv.db.' + key, JSON.stringify(value)); } catch { /* mémoire seulement */ }
  }
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
