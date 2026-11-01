// Service worker de Mon IPTV TV.
// - Fichiers de l'application : réseau d'abord (les mises à jour publiées sur GitHub Pages
//   arrivent au prochain lancement), copie en cache pour fonctionner hors connexion.
// - Moteur hls.js : cache d'abord.
// - Flux vidéo et playlists : jamais interceptés.
const VERSION = '1.0.3';
const CACHE = 'mon-iptv-tv-' + VERSION;
const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/catalog.js',
  './js/m3u.js',
  './js/store.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    try { await cache.add(new Request(HLS_URL, { mode: 'cors' })); } catch { /* sera mis en cache plus tard */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('mon-iptv-tv-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) event.respondWith(networkFirst(req));
  else if (req.url === HLS_URL) event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const network = fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  network.catch(() => {});
  // Si le réseau tarde (plus de 4 s), on sert la copie locale.
  const timeout = new Promise(resolve => setTimeout(resolve, 4000));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
    const cached = await fromCache(cache, req);
    return cached || await network;
  } catch {
    return (await fromCache(cache, req)) || Response.error();
  }
}

async function fromCache(cache, req) {
  return (await cache.match(req, { ignoreSearch: true }))
    || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
