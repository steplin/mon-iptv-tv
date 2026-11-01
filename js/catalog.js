// Catalogue des 25 chaînes nationales gratuites de la TNT (numérotation en vigueur depuis le 6 juin 2025,
// RMC Life ayant remplacé Chérie 25 le 1er octobre 2025).
// Aucune adresse de flux n'est écrite en dur : les flux sont retrouvés dans les listes publiques
// configurées dans les réglages, puis associés aux chaînes par leur nom ou leur identifiant tvg-id.

export const TNT = [
  { num: 1,  name: 'TF1',              aliases: ['tf1'],                                   site: 'https://www.tf1.fr/' },
  { num: 2,  name: 'France 2',         aliases: ['france2'],                               site: 'https://www.france.tv/' },
  { num: 3,  name: 'France 3',         aliases: ['france3'], regional: 'france3',          site: 'https://www.france.tv/' },
  { num: 4,  name: 'France 4',         aliases: ['france4'],                               site: 'https://www.france.tv/' },
  { num: 5,  name: 'France 5',         aliases: ['france5'],                               site: 'https://www.france.tv/' },
  { num: 6,  name: 'M6',               aliases: ['m6'],                                    site: 'https://www.m6.fr/' },
  { num: 7,  name: 'Arte',             aliases: ['arte', 'artefrance', 'artefr', 'artefrancais'], site: 'https://www.arte.tv/fr/direct/' },
  { num: 8,  name: 'LCP / Public Sénat', aliases: ['lcp', 'lcpan', 'lcpassembleenationale', 'publicsenat', 'lcppublicsenat', 'publicsenatlcp'], site: 'https://lcp.fr/' },
  { num: 9,  name: 'W9',               aliases: ['w9'],                                    site: 'https://www.m6.fr/' },
  { num: 10, name: 'TMC',              aliases: ['tmc'],                                   site: 'https://www.tf1.fr/' },
  { num: 11, name: 'TFX',              aliases: ['tfx'],                                   site: 'https://www.tf1.fr/' },
  { num: 12, name: 'Gulli',            aliases: ['gulli'],                                 site: 'https://www.gulli.fr/' },
  { num: 13, name: 'BFM TV',           aliases: ['bfmtv'],                                 site: 'https://www.bfmtv.com/' },
  { num: 14, name: 'CNews',            aliases: ['cnews'],                                 site: 'https://www.cnews.fr/' },
  { num: 15, name: 'LCI',              aliases: ['lci', 'lcilachaineinfo'],                site: 'https://www.tf1.fr/' },
  { num: 16, name: 'franceinfo',       aliases: ['franceinfo', 'franceinfotv', 'franceinfochaine'], site: 'https://www.francetvinfo.fr/' },
  { num: 17, name: 'CStar',            aliases: ['cstar'],                                 site: 'https://www.canalplus.com/' },
  { num: 18, name: 'T18',              aliases: ['t18'] },
  { num: 19, name: 'NOVO19',           aliases: ['novo19'] },
  { num: 20, name: 'TF1 Séries Films', aliases: ['tf1seriesfilms', 'tf1seriefilms'],      site: 'https://www.tf1.fr/' },
  { num: 21, name: "L'Équipe",         aliases: ['lequipe', 'lequipetv'],                  site: 'https://www.lequipe.fr/' },
  { num: 22, name: '6ter',             aliases: ['6ter'],                                  site: 'https://www.m6.fr/' },
  { num: 23, name: 'RMC Story',        aliases: ['rmcstory'],                              site: 'https://www.rmcbfmplay.com/' },
  { num: 24, name: 'RMC Découverte',   aliases: ['rmcdecouverte'],                         site: 'https://www.rmcbfmplay.com/' },
  { num: 25, name: 'RMC Life',         aliases: ['rmclife', 'cherie25'],                   site: 'https://www.rmcbfmplay.com/' },
];

/** Minuscules, sans accents ni ponctuation : « L'Équipe » → « lequipe ». */
export function normalize(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Nom de chaîne comparable : retire préfixes pays, mentions entre () ou [], suffixes de qualité. */
export function channelKey(name) {
  let s = String(name || '')
    .replace(/^\s*(fr|fra|france)\s*[:|\-]\s*/i, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  s = normalize(s);
  for (let i = 0; i < 3; i++) s = s.replace(/(fhd|uhd|hd|sd|4k|hevc)$/, '');
  return s;
}

/** Identifiant tvg-id comparable : « TF1SeriesFilms.fr@SD » → « tf1seriesfilms ». */
export function tvgKey(id) {
  if (!id) return '';
  return normalize(String(id).split('@')[0].split('.')[0]);
}

function isFrench(e) {
  const a = e.attrs || {};
  return /\.fr(@|$)/i.test(e.tvgId || '')
    || /fran[cç]|french/i.test(e.group || '')
    || /\bfr\b/i.test(a['tvg-country'] || '')
    || /fra|french|fran[cç]ais/i.test(a['tvg-language'] || '');
}

function scoreEntry(e, base) {
  let s = base;
  if (/^https:/i.test(e.url)) s += 20; else s -= 40;
  if (/not 24\/7/i.test(e.name)) s -= 10;
  if (/geo-?blocked/i.test(e.name)) s -= 5;
  if (e.needsHeaders) s -= 15;
  return s;
}

/**
 * Associe les entrées des listes publiques aux 25 chaînes TNT.
 * @param {Array} entries entrées M3U ({name, url, tvgId, group, logo, src, frOnly, needsHeaders})
 * @returns {{tnt: Object<number, Array>, others: Array}}
 */
export function matchCatalog(entries) {
  const byAlias = new Map();
  for (const ch of TNT) for (const a of ch.aliases) byAlias.set(a, ch.num);

  const tnt = {};
  const usedUrls = new Set();
  const others = [];
  const seen = new Set();

  for (const e of entries) {
    if (!/^https?:\/\//i.test(e.url)) continue;
    const k = channelKey(e.name);
    const t = tvgKey(e.tvgId);
    let num = byAlias.get(k) ?? byAlias.get(t);
    let base = 100;
    if (num == null) {
      const reg = TNT.find(ch => ch.regional && (k.startsWith(ch.regional) || t.startsWith(ch.regional)));
      // « France 3 Bretagne » etc. : variante régionale acceptée en seconde position.
      if (reg && /^france3[a-z]/.test(k || t)) { num = reg.num; base = 40; }
    }
    if (num != null) {
      (tnt[num] ||= []);
      if (!tnt[num].some(c => c.url === e.url)) {
        tnt[num].push({ url: e.url, label: e.name, src: e.src, score: scoreEntry(e, base) });
      }
      usedUrls.add(e.url);
      continue;
    }
    if (e.frOnly && !isFrench(e)) continue;
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    others.push({ name: e.name, url: e.url, group: e.group || 'Autres', logo: e.logo || '', src: e.src });
  }

  for (const n of Object.keys(tnt)) tnt[n].sort((a, b) => b.score - a.score);
  others.sort((a, b) => (/^https:/i.test(b.url) - /^https:/i.test(a.url)) || a.name.localeCompare(b.name, 'fr'));
  return { tnt, others: others.filter(o => !usedUrls.has(o.url)) };
}
