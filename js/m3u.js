// Lecture des playlists M3U / M3U8 (format étendu #EXTINF).

/** Vrai si le texte est un flux HLS (playlist média ou maître) plutôt qu'une liste de chaînes. */
export function isHlsStream(text) {
  return /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|VERSION)/i.test(text);
}

function splitExtinf(line) {
  // La virgule qui sépare les attributs du titre est la première hors guillemets.
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ',' && !inQuote) return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, ''];
}

/**
 * @param {string} text contenu de la playlist
 * @returns {Array<{name:string,url:string,tvgId:string,group:string,logo:string,attrs:Object,needsHeaders:boolean}>}
 */
export function parseM3U(text) {
  const out = [];
  let cur = null;
  let pendingHeaders = false;
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^#EXTINF/i.test(line)) {
      const [head, title] = splitExtinf(line);
      const attrs = {};
      head.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; return ''; });
      cur = { attrs, name: title.trim() || attrs['tvg-name'] || '', group: attrs['group-title'] || '', needsHeaders: pendingHeaders };
      pendingHeaders = false;
      continue;
    }
    if (/^#EXTGRP:/i.test(line)) { if (cur && !cur.group) cur.group = line.slice(8).trim(); continue; }
    if (/^#EXTVLCOPT:http-(referrer|user-agent|origin)/i.test(line) || /^#KODIPROP/i.test(line)) {
      if (cur) cur.needsHeaders = true; else pendingHeaders = true;
      continue;
    }
    if (line.startsWith('#')) continue;

    // Ligne d'adresse : on retire d'éventuels paramètres Kodi « |User-Agent=... »
    let url = line;
    let needsHeaders = false;
    const pipe = url.indexOf('|');
    if (pipe > 0) { url = url.slice(0, pipe); needsHeaders = true; }
    if (!/^(https?|rtsp|rtmp|rtp|udp):\/\//i.test(url)) { cur = null; continue; }

    const e = cur || { attrs: {}, name: '', group: '', needsHeaders: false };
    out.push({
      name: (e.name || nameFromUrl(url)).trim(),
      url,
      tvgId: e.attrs['tvg-id'] || '',
      group: e.group,
      logo: e.attrs['tvg-logo'] || '',
      attrs: e.attrs,
      needsHeaders: e.needsHeaders || needsHeaders,
    });
    cur = null;
  }
  return out;
}

export function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const file = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    const base = file.replace(/\.(m3u8?|mp4|ts)$/i, '');
    return base && !/^(index|playlist|master|live|chunklist)$/i.test(base) ? base : u.hostname;
  } catch { return url; }
}

/** Construit un fichier M3U à partir d'une liste de flux. */
export function toM3U(items) {
  const esc = s => String(s || '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
  const lines = ['#EXTM3U'];
  for (const it of items) {
    lines.push(`#EXTINF:-1 tvg-logo="${esc(it.logo)}" group-title="${esc(it.group)}",${esc(it.name)}`);
    lines.push(it.url);
  }
  return lines.join('\n') + '\n';
}
