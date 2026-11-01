import { TNT, matchCatalog, normalize, channelKey, isOfficial } from './catalog.js';
import { parseM3U, isHlsStream, nameFromUrl, toM3U } from './m3u.js';
import * as store from './store.js';

const APP_VERSION = '1.1.0';
const CATALOG_FORMAT = 3;          // à augmenter quand les règles du catalogue changent
const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
const DEFAULT_SOURCES = [
  { url: 'https://iptv-org.github.io/iptv/countries/fr.m3u', frOnly: false },
  { url: 'https://iptv-org.github.io/iptv/languages/fra.m3u', frOnly: false },
  { url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', frOnly: true },
  // Chaînes gratuites officielles des plateformes (financées par la publicité) : toutes leurs
  // entrées sont des flux de la plateforme, la liste est donc retenue en entier (« trusted »).
  { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/fr_rakuten.m3u', trusted: true, label: 'Rakuten TV' },
  { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/fr_pluto.m3u', trusted: true, label: 'Pluto TV' },
  { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/fr_samsung.m3u', trusted: true, label: 'Samsung TV Plus' },
  { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/fr_bfm.m3u', trusted: true, label: 'BFM régions' },
];
const SOURCES_VERSION = 2;
const MAX_AGE = 12 * 3600 * 1000;  // catalogue actualisé automatiquement au-delà de 12 h
const PAGE = 240;                  // cartes affichées avant « Afficher plus »
const LOAD_TIMEOUT = 20000;        // délai avant de passer à la source suivante

const $ = (s, r = document) => r.querySelector(s);

// Sources enregistrées : on ajoute les nouvelles sources par défaut apparues avec une mise à jour.
function loadSources() {
  const saved = store.pref('sources', null);
  if (!saved) { store.setPref('sourcesVersion', SOURCES_VERSION); return DEFAULT_SOURCES.map(s => ({ ...s })); }
  if (store.pref('sourcesVersion', 1) < SOURCES_VERSION) {
    for (const d of DEFAULT_SOURCES) if (!saved.some(s => s.url === d.url)) saved.push({ ...d });
    store.setPref('sources', saved);
    store.setPref('sourcesVersion', SOURCES_VERSION);
  }
  return saved;
}
const isHttpsPage = location.protocol === 'https:';

const state = {
  tab: store.pref('tab', 'tnt'),
  query: '',
  group: '',
  limit: PAGE,
  catalog: null,
  mine: [],
  favs: new Set(store.pref('favs', [])),
  sources: loadSources(),
  refreshing: false,
  // lecture
  list: [], idx: 0, cand: 0, hls: null, token: 0, timer: 0, errors: [],
};

/* ---------- Utilitaires ---------- */

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function isSafeUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; }
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

function since(ts) {
  if (!ts) return 'jamais';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `il y a ${h} h`;
  return `le ${new Date(ts).toLocaleDateString('fr-FR')}`;
}

async function fetchText(url, ms = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`réponse ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('délai dépassé');
    if (e instanceof TypeError) throw new Error('accès refusé par le serveur (CORS) ou réseau indisponible');
    throw e;
  } finally { clearTimeout(t); }
}

/* ---------- Données affichées ---------- */

// Dans une application https, Chrome bloque les flux http. Beaucoup de serveurs répondent aussi en https :
// on essaie donc d'abord la version https des flux http, puis le flux http d'origine en dernier recours
// (il reste utilisable avec « Ouvrir avec… »).
function expandCands(cands) {
  if (!isHttpsPage) return cands;
  const secure = cands.filter(c => /^https:/i.test(c.url));
  const insecure = cands.filter(c => !/^https:/i.test(c.url));
  const known = new Set(secure.map(c => c.url));
  const upgraded = [];
  for (const c of insecure) {
    const url = c.url.replace(/^http:/i, 'https:');
    if (known.has(url)) continue;
    known.add(url);
    upgraded.push({ ...c, url, orig: c.url, src: (c.src || hostOf(c.url)) + ' (https)' });
  }
  return [...secure, ...upgraded, ...insecure];
}

function tntItems() {
  const cat = state.catalog?.tnt || {};
  return TNT.map(ch => {
    const own = state.mine.filter(m => Number(m.tnt) === ch.num)
      .map(m => ({ url: m.url, label: m.name, src: 'mon flux' }));
    const pub = (cat[ch.num] || []).filter(c => c.trusted || isOfficial(c.url));
    const cands = expandCands([...own, ...pub]);
    return {
      key: 'tnt:' + ch.num, kind: 'tnt', num: ch.num, name: ch.name, site: ch.site,
      cands, search: normalize(ch.name) + ' ' + ch.aliases.join(' '),
      sub: sourcesLabel(own.length + pub.length),
    };
  });
}

function sourcesLabel(n) {
  return n ? `${n} source${n > 1 ? 's' : ''}` : 'Aucun flux';
}

function streamItem(e, kind) {
  return {
    key: 'u:' + e.url, kind, name: e.name || nameFromUrl(e.url), logo: e.logo, group: e.group || 'Autres',
    url: e.url,
    cands: expandCands((e.urls || [e.url]).map(url => ({ url, label: e.name, src: kind === 'mine' ? 'mon flux' : hostOf(url) }))),
    search: normalize(e.name) + ' ' + normalize(e.group),
    sub: e.urls?.length > 1 ? `${e.group || hostOf(e.url)} · ${e.urls.length} sources` : (e.group || hostOf(e.url)),
  };
}

function itemsFor(tab) {
  if (tab === 'tnt') return tntItems();
  if (tab === 'plus') return (state.catalog?.others || []).map(e => streamItem(e, 'plus'));
  if (tab === 'mine') return state.mine.map(e => streamItem(e, 'mine'));
  const all = [...tntItems(), ...state.mine.map(e => streamItem(e, 'mine')),
    ...(state.catalog?.others || []).map(e => streamItem(e, 'plus'))];
  const seen = new Set();
  return all.filter(i => state.favs.has(i.key) && !seen.has(i.key) && seen.add(i.key));
}

function visibleItems() {
  let items = itemsFor(state.tab);
  if (state.group && (state.tab === 'plus' || state.tab === 'mine')) items = items.filter(i => i.group === state.group);
  const q = state.query.trim();
  if (q) {
    const nq = normalize(q);
    items = items.filter(i => (i.num && String(i.num) === q) || i.search.includes(nq) || channelKey(i.name).includes(nq));
  }
  return items;
}

/* ---------- Rendu ---------- */

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  renderGroups();
  const items = visibleItems();
  const list = $('#list');
  list.replaceChildren();

  if (!items.length) list.append(emptyState());
  for (const it of items.slice(0, state.limit)) list.append(card(it, items));
  if (items.length > state.limit) {
    list.append(el('button', { class: 'more', type: 'button', text: `Afficher plus (${items.length - state.limit} restantes)`,
      onclick: () => { state.limit += PAGE; render(); } }));
  }
  renderStatus(items);
}

function emptyState() {
  const box = el('div', { class: 'empty-state' });
  if (state.query) box.append(el('p', { text: 'Aucune chaîne ne correspond à la recherche.' }));
  else if (state.tab === 'fav') box.append(el('p', { text: 'Touchez l\'étoile d\'une chaîne pour la retrouver ici.' }));
  else if (state.tab === 'mine') {
    box.append(el('p', { text: 'Ajoutez un flux M3U8 ou importez une playlist M3U.' }),
      el('button', { class: 'primary', type: 'button', text: 'Ajouter', onclick: openAdd }));
  } else if (state.tab === 'plus') {
    box.append(el('p', { text: state.refreshing ? 'Chargement des listes publiques…' : 'Aucune chaîne supplémentaire pour le moment.' }));
    if (!state.refreshing) box.append(el('button', { type: 'button', text: 'Actualiser le catalogue', onclick: () => refreshCatalog(true) }));
  }
  return box;
}

function card(it, items) {
  const fav = state.favs.has(it.key);
  const badge = el('span', { class: 'badge' });
  if (it.num) badge.textContent = it.num;
  else if (it.logo && isSafeUrl(it.logo)) {
    const img = el('img', { src: it.logo, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => { img.remove(); badge.textContent = initials(it.name); });
    badge.append(img);
  } else badge.textContent = initials(it.name);

  const main = el('button', { class: 'card-main', type: 'button', 'aria-label': `Regarder ${it.name}`,
    onclick: () => openItem(items, items.indexOf(it)) },
  badge,
  el('span', { class: 'card-text' },
    el('strong', { text: it.name }),
    el('small', {}, el('span', { class: 'dot' }), it.sub)));

  const star = el('button', { class: 'star' + (fav ? ' on' : ''), type: 'button',
    'aria-label': fav ? `Retirer ${it.name} des favoris` : `Ajouter ${it.name} aux favoris`,
    onclick: () => { toggleFav(it.key); render(); } }, icon(fav ? 'i-star-f' : 'i-star'));

  const c = el('div', { class: 'card' + (it.cands.length ? '' : ' empty') }, main, star);
  if (it.kind === 'mine') {
    c.append(el('button', { class: 'del', type: 'button', 'aria-label': `Supprimer ${it.name}`,
      onclick: () => removeMine(it.url) }, icon('i-x')));
  }
  return c;
}

function initials(name) {
  const w = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return ((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toUpperCase();
}

function renderGroups() {
  const sel = $('#groupFilter');
  const show = state.tab === 'plus' || state.tab === 'mine';
  sel.hidden = !show;
  if (!show) return;
  const groups = [...new Set(itemsFor(state.tab).map(i => i.group))].sort((a, b) => a.localeCompare(b, 'fr'));
  if (state.group && !groups.includes(state.group)) state.group = '';
  sel.replaceChildren(el('option', { value: '', text: 'Tous les groupes' }),
    ...groups.map(g => el('option', { value: g, text: g })));
  sel.value = state.group;
  sel.hidden = groups.length < 2;
}

function renderStatus(items) {
  const st = $('#status');
  if (state.refreshing) { st.textContent = 'Actualisation du catalogue…'; return; }
  const when = since(state.catalog?.updatedAt);
  if (state.tab === 'tnt') {
    const ok = tntItems().filter(i => i.cands.length).length;
    st.textContent = state.catalog ? `${ok}/25 chaînes avec un flux · catalogue ${when}` : 'Catalogue pas encore chargé';
  } else {
    st.textContent = `${items.length} chaîne${items.length > 1 ? 's' : ''}` + (state.tab === 'plus' ? ` · catalogue ${when}` : '');
  }
}

/* ---------- Favoris et mes flux ---------- */

function toggleFav(key) {
  if (state.favs.has(key)) state.favs.delete(key); else state.favs.add(key);
  store.setPref('favs', [...state.favs]);
}

async function saveMine() {
  await store.set('mine', state.mine);
}

async function addMine(entries) {
  const known = new Set(state.mine.map(m => m.url));
  let added = 0;
  for (const e of entries) {
    if (!isSafeUrl(e.url) || known.has(e.url)) continue;
    known.add(e.url);
    state.mine.push({ name: (e.name || nameFromUrl(e.url)).slice(0, 120), url: e.url, group: (e.group || 'Mes flux').slice(0, 80),
      logo: e.logo || '', tnt: e.tnt ? Number(e.tnt) : null });
    added++;
  }
  await saveMine();
  return added;
}

async function removeMine(url) {
  const m = state.mine.find(x => x.url === url);
  if (!m || !confirm(`Supprimer « ${m.name} » de vos flux ?`)) return;
  state.mine = state.mine.filter(x => x.url !== url);
  state.favs.delete('u:' + url);
  store.setPref('favs', [...state.favs]);
  await saveMine();
  render();
}

/* ---------- Catalogue public ---------- */

async function refreshCatalog(manual) {
  if (state.refreshing) return;
  if (!navigator.onLine) { if (manual) toast('Pas de connexion internet'); return; }
  state.refreshing = true;
  $('#btnRefresh').classList.add('spin');
  render();

  const results = await Promise.allSettled(state.sources.map(s => fetchText(s.url)));
  const report = [];
  const entries = [];
  results.forEach((r, i) => {
    const s = state.sources[i];
    if (r.status === 'fulfilled') {
      const list = parseM3U(r.value);
      report.push({ url: s.url, ok: true, count: list.length });
      for (const e of list) entries.push({ ...e, group: e.group || s.label || '', src: s.label || hostOf(s.url), frOnly: s.frOnly, trusted: !!s.trusted });
    } else {
      report.push({ url: s.url, ok: false, error: r.reason?.message || 'erreur' });
    }
  });

  state.refreshing = false;
  $('#btnRefresh').classList.remove('spin');

  if (!entries.length) {
    if (state.catalog) state.catalog.report = report;
    render();
    renderSettings();
    if (manual || !state.catalog) toast('Aucune liste publique n\'a pu être chargée');
    return;
  }
  const cat = matchCatalog(entries);
  state.catalog = { ...cat, updatedAt: Date.now(), report, format: CATALOG_FORMAT };
  await store.set('catalog', state.catalog);
  render();
  renderSettings();
  if (manual) toast(`Catalogue à jour : ${Object.keys(cat.tnt).length}/25 chaînes TNT trouvées`);
}

/* ---------- Lecteur ---------- */

let hlsPromise = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsPromise) {
    hlsPromise = new Promise(resolve => {
      const s = document.createElement('script');
      s.src = HLS_URL;
      s.crossOrigin = 'anonymous';
      const t = setTimeout(() => resolve(null), 10000);
      s.onload = () => { clearTimeout(t); resolve(window.Hls || null); };
      s.onerror = () => { clearTimeout(t); hlsPromise = null; resolve(null); };
      document.head.append(s);
    });
  }
  return hlsPromise;
}

function openItem(items, idx) {
  const it = items[idx];
  if (!it) return;
  if (!it.cands.length) { showNoStream(it); return; }
  state.list = items.filter(i => i.cands.length);
  state.idx = state.list.indexOf(it);
  openPlayer();
  startItem();
}

let closeWatcher = null;
function openPlayer() {
  const p = $('#player');
  if (!p.hidden) return;
  p.hidden = false;
  document.body.style.overflow = 'hidden';
  // Bouton « retour » d'Android : ferme le lecteur au lieu de quitter l'application.
  if ('CloseWatcher' in window) {
    try { closeWatcher = new CloseWatcher(); closeWatcher.onclose = () => closePlayer(true); } catch { closeWatcher = null; }
  }
  if (!closeWatcher) history.pushState({ player: 1 }, '');
  $('#pClose').focus();
  armIdle();
}

function closePlayer(fromBack) {
  const p = $('#player');
  if (p.hidden) return;
  stopStream();
  p.hidden = true;
  document.body.style.overflow = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (closeWatcher) { const w = closeWatcher; closeWatcher = null; if (!fromBack) w.destroy(); }
  else if (!fromBack && history.state?.player) history.back();
  render();
}

window.addEventListener('popstate', () => { if (!$('#player').hidden && !closeWatcher) closePlayer(true); });

function stopStream() {
  state.token++;
  clearTimeout(state.timer);
  if (state.hls) { try { state.hls.destroy(); } catch { /* déjà détruit */ } state.hls = null; }
  const v = $('#video');
  v.onerror = v.onloadedmetadata = v.onplaying = null;
  v.removeAttribute('src');
  v.load();
}

function startItem() {
  state.cand = 0;
  state.errors = [];
  const it = state.list[state.idx];
  const fav = state.favs.has(it.key);
  $('#pName').textContent = (it.num ? it.num + ' · ' : '') + it.name;
  const pf = $('#pFav');
  pf.classList.toggle('on', fav);
  pf.replaceChildren(icon(fav ? 'i-star-f' : 'i-star'));
  pf.setAttribute('aria-label', fav ? 'Retirer des favoris' : 'Ajouter aux favoris');
  $('#pPrev').disabled = state.list.length < 2;
  $('#pNext').disabled = state.list.length < 2;
  startCandidate();
}

function currentCandidate() {
  const it = state.list[state.idx];
  return it?.cands[state.cand];
}

function showMsg(html, kind = 'info') {
  const m = $('#pMsg');
  if (!html) { m.hidden = true; return; }
  m.className = 'p-msg ' + kind;
  m.replaceChildren(...(Array.isArray(html) ? html : [html]));
  m.hidden = false;
}

async function startCandidate() {
  stopStream();
  $('.video-wrap').classList.remove('failed');
  state.failed = false;
  const token = state.token;
  const it = state.list[state.idx];
  const c = currentCandidate();
  $('#pAlt').disabled = it.cands.length < 2;
  $('#pInfo').textContent = `Source ${state.cand + 1}/${it.cands.length} · ${c.src || hostOf(c.url)}`;
  showMsg('Chargement…');

  if (isHttpsPage && /^http:/i.test(c.url)) {
    failCandidate('Flux http non sécurisé, bloqué par Chrome.');
    return;
  }

  const video = $('#video');
  const looksNative = /\.(mp4|webm|ogv|mp3|aac|m4a)(\?|#|$)/i.test(c.url);
  const ready = () => { if (token === state.token) { clearTimeout(state.timer); } };
  video.onplaying = () => { if (token === state.token) { clearTimeout(state.timer); showMsg(null); } };
  state.timer = setTimeout(() => {
    if (token === state.token) failCandidate('Le flux ne répond pas (délai dépassé).');
  }, LOAD_TIMEOUT);

  const Hls = looksNative ? null : await loadHls();
  if (token !== state.token) return;

  if (Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, backBufferLength: 30, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2 });
    state.hls = hls;
    let mediaRecovered = false;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (token !== state.token) return;
      ready();
      video.play().catch(() => showMsg('Touchez ▶ pour lancer la lecture.'));
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (token !== state.token || !data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) { mediaRecovered = true; hls.recoverMediaError(); return; }
      failCandidate(explainHlsError(data, Hls));
    });
    hls.loadSource(c.url);
    hls.attachMedia(video);
    return;
  }

  // Lecture native (fichiers vidéo, ou HLS si hls.js est indisponible)
  if (!looksNative && !video.canPlayType('application/vnd.apple.mpegurl')) {
    failCandidate('Le moteur de lecture n\'a pas pu être chargé (connexion ?) et ce navigateur ne lit pas le HLS seul.');
    return;
  }
  video.onloadedmetadata = () => { ready(); video.play().catch(() => showMsg('Touchez ▶ pour lancer la lecture.')); };
  video.onerror = () => { if (token === state.token) failCandidate('Lecture impossible : format non pris en charge, accès refusé ou blocage CORS.'); };
  video.src = c.url;
}

function explainHlsError(data, Hls) {
  const code = data.response?.code ?? data.networkDetails?.status;
  const d = String(data.details || '');
  if (/keySystem|emeKey|drm/i.test(d)) return 'Flux protégé par DRM : lecture impossible ici.';
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    if (code === 401 || code === 403) return 'Accès refusé par le diffuseur (restriction géographique, abonnement ou lien expiré).';
    if (code === 404 || code === 410) return 'Flux introuvable : l\'adresse n\'est plus valide.';
    if (!code) return 'Serveur injoignable ou accès bloqué depuis une page web (CORS).';
    return `Erreur réseau (${code}).`;
  }
  if (/manifestParsing/i.test(d)) return 'Cette adresse n\'est pas un flux vidéo HLS valide.';
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return 'Format vidéo non pris en charge par ce téléphone.';
  return 'Lecture impossible (' + d + ').';
}

function failCandidate(reason) {
  const it = state.list[state.idx];
  state.errors.push(`Source ${state.cand + 1} : ${reason}`);
  if (state.cand + 1 < it.cands.length) {
    state.cand++;
    showMsg(reason + ' Essai de la source suivante…', 'error');
    setTimeout(() => startCandidate(), 700);
    return;
  }
  stopStream();
  $('.video-wrap').classList.add('failed');
  state.failed = true;
  showMsg([
    el('strong', { text: 'Cette chaîne ne peut pas être lue dans l\'application.' }),
    el('ul', {}, state.errors.map(e => el('li', { text: e }))),
    el('p', { text: 'Le lecteur VLC n\'a pas ces restrictions de navigateur : il lit souvent ces flux sans problème.' }),
    el('div', { class: 'row' },
      el('button', { class: 'primary', type: 'button', text: '▶ Regarder dans VLC', onclick: openExternal })),
  ], 'error');
}

// Adresse envoyée à VLC : le flux d'origine (pas la variante https essayée par l'application).
// Après un échec complet, on prend la meilleure source d'origine plutôt que la dernière essayée.
function externalUrl() {
  const it = state.list[state.idx];
  if (!it) return null;
  const c = state.failed ? (it.cands.find(x => !x.orig) || it.cands[0]) : currentCandidate();
  return c ? (c.orig || c.url) : null;
}

function step(delta) {
  if (state.list.length < 2) return;
  state.idx = (state.idx + delta + state.list.length) % state.list.length;
  startItem();
}

function openExternal() {
  const url = externalUrl();
  if (!url) return;
  if (/android/i.test(navigator.userAgent)) {
    // Ouvre directement VLC ; s'il n'est pas installé, Chrome affiche sa page du Play Store.
    const u = new URL(url);
    const store = encodeURIComponent('https://play.google.com/store/apps/details?id=org.videolan.vlc');
    location.href = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.slice(0, -1)};`
      + `package=org.videolan.vlc;type=video/*;S.title=${encodeURIComponent($('#pName').textContent)};`
      + `S.browser_fallback_url=${store};end`;
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

async function copyLink() {
  const url = externalUrl();
  if (!url) return;
  try { await navigator.clipboard.writeText(url); toast('Lien du flux copié'); }
  catch { prompt('Lien du flux :', url); }
}

// En paysage, les commandes s'effacent après quelques secondes sans toucher l'écran.
let idleTimer = 0;
function armIdle() {
  const p = $('#player');
  p.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!$('#video').paused) p.classList.add('idle'); }, 4000);
}

/* ---------- Dialogues ---------- */

function showNoStream(it) {
  $('#infoTitle').textContent = `${it.num} · ${it.name}`;
  $('#infoText').textContent = state.catalog
    ? 'Ce diffuseur ne publie pas de flux en accès libre : les seules adresses qui circulent pour cette chaîne sont des rediffusions non autorisées, écartées par l\'application. Regardez-la sur le site ou l\'application officielle, ou associez-y votre propre flux.'
    : 'Le catalogue n\'est pas encore chargé. Actualisez-le (bouton ↻ en haut) puis réessayez.';
  const a = $('#infoSite');
  if (it.site) { a.href = it.site; a.hidden = false; } else a.hidden = true;
  $('#infoAdd').onclick = () => { $('#dlgInfo').close(); openAdd(it.num); };
  $('#dlgInfo').showModal();
}

function openAdd(tntNum) {
  const sel = $('#tntSelect');
  if (sel.options.length < 2) for (const ch of TNT) sel.append(el('option', { value: ch.num, text: `${ch.num} · ${ch.name}` }));
  sel.value = typeof tntNum === 'number' ? String(tntNum) : '';
  setAddMsg('');
  $('#dlgAdd').showModal();
}

function setAddMsg(text, kind = '') {
  const m = $('#addMsg');
  m.textContent = text;
  m.className = 'form-msg ' + kind;
}

async function importText(text, label) {
  if (isHlsStream(text)) return null; // c'est un flux, pas une liste
  const entries = parseM3U(text).map(e => ({ ...e, group: e.group || label }));
  if (!entries.length) throw new Error('Aucune chaîne trouvée dans ce fichier.');
  return addMine(entries);
}

function renderSettings() {
  $('#appVersion').textContent = APP_VERSION;
  const ul = $('#sourceList');
  const report = state.catalog?.report || [];
  ul.replaceChildren(...state.sources.map((s, i) => {
    const r = report.find(x => x.url === s.url);
    const info = r ? (r.ok ? el('small', { text: `${r.count} entrées` }) : el('small', { class: 'bad', text: r.error })) : el('small', { text: 'pas encore chargée' });
    return el('li', {},
      el('div', { class: 'src-text' }, el('span', { text: s.url }), info),
      el('button', { type: 'button', 'aria-label': 'Retirer cette source', onclick: () => {
        state.sources.splice(i, 1); store.setPref('sources', state.sources); renderSettings();
      } }, icon('i-x')));
  }));
  $('#catalogInfo').textContent = state.catalog
    ? `Dernière actualisation ${since(state.catalog.updatedAt)} · ${Object.keys(state.catalog.tnt).length}/25 chaînes TNT · ${state.catalog.others.length} autres chaînes`
    : 'Catalogue pas encore chargé.';
}

/* ---------- Évènements ---------- */

function bind() {
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    state.tab = b.dataset.tab; state.group = ''; state.limit = PAGE;
    store.setPref('tab', state.tab);
    render();
    window.scrollTo({ top: 0 });
  }));

  let qTimer = 0;
  $('#search').addEventListener('input', e => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.query = e.target.value; state.limit = PAGE; render(); }, 150);
  });
  $('#groupFilter').addEventListener('change', e => { state.group = e.target.value; state.limit = PAGE; render(); });

  $('#btnRefresh').addEventListener('click', () => refreshCatalog(true));
  $('#btnRefresh2').addEventListener('click', () => refreshCatalog(true));
  $('#btnAdd').addEventListener('click', () => openAdd());
  $('#btnSettings').addEventListener('click', () => { renderSettings(); $('#dlgSettings').showModal(); });

  // Ajout d'un flux unique
  $('#formStream').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const url = String(f.get('url')).trim();
    if (!isSafeUrl(url)) { setAddMsg('L\'adresse doit commencer par https:// (ou http://).', 'error'); return; }
    const n = await addMine([{ name: String(f.get('name')).trim(), url, group: String(f.get('group')).trim() || 'Mes flux', tnt: f.get('tnt') }]);
    if (!n) { setAddMsg('Ce flux est déjà dans vos flux.', 'error'); return; }
    e.target.reset();
    setAddMsg('Flux ajouté.', 'ok');
    toast('Flux ajouté');
    if (/^http:/i.test(url) && isHttpsPage) toast('Attention : un flux http ne pourra s\'ouvrir qu\'avec « Ouvrir avec… »');
    render();
  });

  // Import de playlist par adresse
  $('#formPlaylist').addEventListener('submit', async e => {
    e.preventDefault();
    const url = String(new FormData(e.target).get('url') || '').trim();
    if (!isSafeUrl(url)) { setAddMsg('Indiquez l\'adresse complète de la playlist.', 'error'); return; }
    setAddMsg('Téléchargement de la playlist…');
    try {
      const text = await fetchText(url);
      const n = await importText(text, hostOf(url));
      if (n === null) {
        await addMine([{ name: nameFromUrl(url), url, group: 'Mes flux' }]);
        setAddMsg('Cette adresse est un flux vidéo : il a été ajouté à vos flux.', 'ok');
      } else setAddMsg(`${n} flux ajouté${n > 1 ? 's' : ''} à « Mes flux ».`, 'ok');
      e.target.reset();
      state.tab = 'mine'; render();
    } catch (err) {
      setAddMsg(`Import impossible : ${err.message}. Si le serveur refuse l'accès (CORS), téléchargez le fichier puis utilisez « Choisir un fichier ».`, 'error');
    }
  });

  // Import de playlist par fichier
  $('#fileInput').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const n = await importText(text, file.name.replace(/\.[^.]+$/, ''));
      if (n === null) throw new Error('ce fichier est un flux vidéo et non une liste de chaînes');
      setAddMsg(`${n} flux ajouté${n > 1 ? 's' : ''} depuis « ${file.name} ».`, 'ok');
      state.tab = 'mine'; render();
    } catch (err) { setAddMsg(`Import impossible : ${err.message}`, 'error'); }
    e.target.value = '';
  });

  // Sources du catalogue
  $('#formSource').addEventListener('submit', e => {
    e.preventDefault();
    const url = String(new FormData(e.target).get('url')).trim();
    if (!isSafeUrl(url) || state.sources.some(s => s.url === url)) return;
    state.sources.push({ url, frOnly: false });
    store.setPref('sources', state.sources);
    e.target.reset();
    renderSettings();
    toast('Source ajoutée : actualisez le catalogue');
  });
  $('#btnResetSources').addEventListener('click', () => {
    state.sources = DEFAULT_SOURCES.map(s => ({ ...s }));
    store.setPref('sources', state.sources);
    renderSettings();
  });

  $('#btnExport').addEventListener('click', () => {
    if (!state.mine.length) { toast('Aucun flux à exporter'); return; }
    const blob = new Blob([toM3U(state.mine)], { type: 'audio/x-mpegurl' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'mes-flux.m3u' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('#btnClearMine').addEventListener('click', async () => {
    if (!state.mine.length || !confirm(`Supprimer vos ${state.mine.length} flux ?`)) return;
    for (const m of state.mine) state.favs.delete('u:' + m.url);
    store.setPref('favs', [...state.favs]);
    state.mine = [];
    await saveMine();
    render();
    toast('Vos flux ont été supprimés');
  });

  // Lecteur
  $('#pClose').addEventListener('click', () => closePlayer(false));
  $('#pPrev').addEventListener('click', () => step(-1));
  $('#pNext').addEventListener('click', () => step(1));
  $('#pAlt').addEventListener('click', () => {
    const it = state.list[state.idx];
    if (it.cands.length < 2) return;
    state.cand = (state.cand + 1) % it.cands.length;
    startCandidate();
  });
  $('#pExt').addEventListener('click', openExternal);
  $('#pCopy').addEventListener('click', copyLink);
  $('#pFav').addEventListener('click', () => {
    const it = state.list[state.idx];
    toggleFav(it.key);
    const on = state.favs.has(it.key);
    $('#pFav').classList.toggle('on', on);
    $('#pFav').replaceChildren(icon(on ? 'i-star-f' : 'i-star'));
    toast(on ? 'Ajoutée aux favoris' : 'Retirée des favoris');
  });
  const player = $('#player');
  ['pointermove', 'pointerdown', 'keydown'].forEach(ev => player.addEventListener(ev, armIdle));
  $('#video').addEventListener('play', armIdle);

  // Télécommande / clavier (Android TV) : haut-bas = chaîne, Échap = fermer
  document.addEventListener('keydown', e => {
    if ($('#player').hidden) return;
    if (['ArrowUp', 'ChannelUp', 'PageUp'].includes(e.key)) { e.preventDefault(); step(-1); }
    else if (['ArrowDown', 'ChannelDown', 'PageDown'].includes(e.key)) { e.preventDefault(); step(1); }
    else if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') { e.preventDefault(); closePlayer(false); }
  });

  window.addEventListener('online', () => {
    if (!state.catalog || Date.now() - state.catalog.updatedAt > MAX_AGE) refreshCatalog(false);
  });
}

/* ---------- Démarrage ---------- */

// Catalogue enregistré par une version précédente : on retire tout de suite les flux non officiels
// (pour que l'affichage soit juste dès l'ouverture) et on le reconstruit en arrière-plan.
function upgradeCatalog(cat) {
  if (cat.format === CATALOG_FORMAT) return cat;
  const tnt = {};
  for (const [n, list] of Object.entries(cat.tnt || {})) {
    const ok = list.filter(c => c.trusted || isOfficial(c.url));
    if (ok.length) tnt[n] = ok;
  }
  const others = (cat.others || []).filter(o => isOfficial(o.url));
  return { ...cat, tnt, others, stale: true };
}

async function init() {
  bind();
  const [catalog, mine] = await Promise.all([store.get('catalog'), store.get('mine')]);
  state.catalog = catalog ? upgradeCatalog(catalog) : null;
  state.mine = Array.isArray(mine) ? mine : [];
  render();
  if (!state.catalog || state.catalog.stale || Date.now() - state.catalog.updatedAt > MAX_AGE) refreshCatalog(false);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Application mise à jour');
      hadController = true;
    });
  }
}

init();
