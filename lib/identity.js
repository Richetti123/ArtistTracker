import { config } from './config.js';

const UA = 'ArtistTracker/5.0 (+https://github.com/Richetti123/ArtistTracker)';
const cache = new Map();
let chartmastersCache = null;
let musicBrainzLastRequest = 0;

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const key = s => norm(s).replace(/1/g, 'i').replace(/2/g, 's').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'o').replace(/[il]/g, 'i').replace(/[^a-z0-9]/g, '');

export function cleanArtistName(value) {
  let s = String(value || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/^\s*(?:🎤|artist|artista)\s*[:=-]\s*/i, '');
  s = s.replace(/\s*(?:[-–—|:]\s*)?(?:cuarta|tercera|segunda|primera|4a|3a|2a|1a)\s+fecha(?:\s+.*)?$/i, '');
  s = s.replace(/\s+en\s+madrid(?:\s+.*)?$/i, '');
  s = s.replace(/\s*\((?:madrid|españa)\)\s*$/i, '');
  s = s.replace(/\s*[-–—|:]\s*(?:madrid|madrid,\s*españa)\s*$/i, '');
  s = s.replace(/^(?:concierto|conciertos|evento)\s*[:=-]\s*/i, '');
  return s.trim();
}

export function similarity(a, b) {
  const x = key(a), y = key(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length);
  const ax = new Set(x), by = new Set(y);
  return [...ax].filter(c => by.has(c)).length / Math.max(ax.size, by.size);
}

function number(value) {
  if (value == null) return null;
  let s = String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  const suffix = lower.match(/(?:k|m|b|mil|mill(?:on|ones)|millón|millones|bn)$/)?.[0] || '';
  if (suffix) s = s.slice(0, -suffix.length);
  if (!suffix && /^\d{1,3}(?:[.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
  else s = s.replace(/,/g, '.');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mult = /^(?:k|mil)$/i.test(suffix) ? 1e3 : /^(?:m|mill(?:on|ones)|millón|millones)$/i.test(suffix) ? 1e6 : /^(?:b|bn)$/i.test(suffix) ? 1e9 : 1;
  return Math.round(n * mult);
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(?:p|div|li|h1|h2|h3|h4|h5|section|article|tr|td|th|time)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').replace(/[ \t]{2,}/g, ' ')
    .split('\n').map(x => x.trim()).filter(Boolean).join('\n');
}

async function fetchText(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: options.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8', ...(options.headers || {}) },
      redirect: 'follow', signal: AbortSignal.timeout(options.timeout || 20000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (!options.quiet) console.error(`[IDENTITY] ${url} -> ${error.message}`);
    return null;
  }
}

async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,*/*;q=0.8', ...(options.headers || {}) }, signal: AbortSignal.timeout(options.timeout || 15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (!options.quiet) console.error(`[IDENTITY-API] ${url} -> ${error.message}`);
    return null;
  }
}

function leetVariants(name) {
  const clean = cleanArtistName(name);
  const out = new Set([clean]);
  const add = value => value && out.size < 12 && out.add(value);
  add(clean.replace(/1/g, 'i')); add(clean.replace(/1/g, 'l')); add(clean.replace(/2/g, 's').replace(/5/g, 's')); add(clean.replace(/3/g, 'e')); add(clean.replace(/4/g, 'a')); add(clean.replace(/7/g, 't')); add(clean.replace(/8/g, 'o'));
  return [...out].filter(Boolean);
}

function spotifyIds(html) {
  const ids = new Set();
  for (const re of [/spotify:artist:([A-Za-z0-9]{22})/g, /open\.spotify\.com\/artist\/([A-Za-z0-9]{22})/g, /artistId["']?\s*[:=]\s*["']([A-Za-z0-9]{22})["']/g]) {
    for (const m of String(html || '').matchAll(re)) ids.add(m[1]);
  }
  return [...ids].slice(0, 12);
}

function spotifyNameFromPage(html, fallback) {
  const body = stripHtml(html);
  const title = String(html || '').match(/<title[^>]*>\s*([^<]+?)\s*(?:\||-)?\s*Spotify\s*<\/title>/i)?.[1];
  if (title?.trim()) return title.trim();
  return body.match(/(?:^|\n)\s*([^\n]{1,120})\s*\n[^\n]{0,80}(?:monthly listeners|oyentes mensuales)/i)?.[1]?.trim() || fallback;
}

function extractMonthly(html) {
  const source = stripHtml(html);
  const patterns = [
    /([0-9][0-9.,\s]*)\s*(k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?\s*monthly listeners/ig,
    /([0-9][0-9.,\s]*)\s*(k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?\s*oyentes mensuales/ig,
    /monthly listeners[^0-9]{0,100}([0-9][0-9.,\s]*)\s*(k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?/ig,
    /oyentes mensuales[^0-9]{0,100}([0-9][0-9.,\s]*)\s*(k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?/ig
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) {
    const n = number(`${m[1]}${m[2] || ''}`);
    if (n) return n;
  }
  return null;
}

function spotifyImage(html) {
  return String(html || '').match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || String(html || '').match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1]
    || '';
}

function spotifyTracks(html, artist) {
  const body = stripHtml(html);
  const out = new Set();
  const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of body.matchAll(new RegExp(`([^\\n]{2,100})\\s+${escaped}(?:,|\\n|$)`, 'ig'))) {
    const value = m[1].trim();
    if (value && !/monthly listeners|followers|albums|singles|artist/i.test(value)) out.add(value);
  }
  return [...out].slice(0, 12);
}

async function spotifyProfileById(id, fallbackName = '') {
  const url = `https://open.spotify.com/artist/${id}`;
  const html = await fetchText(url, { quiet: true });
  if (!html) return null;
  const artist = spotifyNameFromPage(html, fallbackName);
  return { artist, spotifyId: id, spotifyUrl: url, monthly: extractMonthly(html), imageUrl: spotifyImage(html), tracks: spotifyTracks(html, artist), raw: html, source: 'Spotify web scraper' };
}

async function spotifySearch(name) {
  const url = `https://open.spotify.com/search/${encodeURIComponent(name)}/artists`;
  const html = await fetchText(url, { quiet: true });
  if (!html) return [];
  const profiles = [];
  for (const id of spotifyIds(html).slice(0, 8)) {
    const profile = await spotifyProfileById(id, name);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

async function songstatsSearch(name) {
  const urls = [
    `https://songstats.com/search?query=${encodeURIComponent(name)}`,
    `https://songstats.com/search?q=${encodeURIComponent(name)}`
  ];
  for (const searchUrl of urls) {
    const html = await fetchText(searchUrl, { quiet: true, timeout: 25000 });
    if (!html) continue;
    const links = [...html.matchAll(/href=["'](https?:\/\/songstats\.com\/artist\/([a-z0-9]+)\/([^"?#]+)|\/artist\/([a-z0-9]+)\/([^"?#]+))["']/gi)];
    const candidates = [];
    for (const m of links) {
      const id = m[2] || m[4];
      const slug = m[3] || m[5];
      const artist = decodeURIComponent(slug).replace(/-/g, ' ').trim();
      if (id && artist && !candidates.some(x => x.id === id)) candidates.push({ id, artist, url: `https://songstats.com/artist/${id}/${slug}` });
    }
    if (candidates.length) return candidates.slice(0, 10);
  }
  return [];
}

async function songstatsProfile(candidate) {
  const base = candidate.url;
  const urls = [base, `${base}?source=spotify&popupStyle=graph&graphDataId=account-popularity`];
  for (const url of urls) {
    const html = await fetchText(url, { quiet: true, timeout: 25000 });
    if (!html) continue;
    const body = stripHtml(html);
    const monthly = extractMonthly(body) || extractMonthly(html);
    const imageUrl = spotifyImage(html) || String(html).match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';
    const tracks = [...body.matchAll(/(?:Recent Releases|Top Performing Tracks)[\s\S]{0,2500}?\n([^\n]{2,100})/gi)].map(m => m[1].trim()).slice(0, 10);
    return { ...candidate, monthly, imageUrl, tracks, source: 'Songstats scraper', url };
  }
  return null;
}

async function songstatsArtist(name) {
  const candidates = await songstatsSearch(name);
  const exact = candidates.filter(x => similarity(name, x.artist) >= 0.75);
  const pool = exact.length ? exact : candidates;
  const profiles = [];
  for (const candidate of pool.slice(0, 5)) {
    const profile = await songstatsProfile(candidate);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.vision.model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } })
    });
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.map(x => x.text).filter(Boolean).join('\n') || null;
  } catch (error) {
    console.error(`[IDENTITY-AI] ${error.message}`);
    return null;
  }
}

function parseJson(raw) {
  try { return JSON.parse(String(raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return {}; }
}

const countryFlags = {
  'colombia': '🇨🇴', 'mexico': '🇲🇽', 'peru': '🇵🇪', 'chile': '🇨🇱', 'argentina': '🇦🇷', 'venezuela': '🇻🇪', 'bolivia': '🇧🇴', 'ecuador': '🇪🇨', 'puerto rico': '🇵🇷', 'dominican republic': '🇩🇴', 'republica dominicana': '🇩🇴', 'spain': '🇪🇸', 'españa': '🇪🇸', 'paraguay': '🇵🇾', 'uruguay': '🇺🇾', 'brazil': '🇧🇷', 'brasil': '🇧🇷', 'united states': '🇺🇸', 'estados unidos': '🇺🇸', 'canada': '🇨🇦', 'france': '🇫🇷', 'italy': '🇮🇹', 'italia': '🇮🇹', 'germany': '🇩🇪', 'alemania': '🇩🇪', 'united kingdom': '🇬🇧', 'reino unido': '🇬🇧'
};

function countryDisplay(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  const flag = countryFlags[norm(clean).replace(/\.$/, '')];
  if (!flag || clean.includes(flag)) return clean;
  return `${clean}${flag}`;
}

async function chartmastersRows() {
  const now = Date.now();
  if (chartmastersCache && now - chartmastersCache.time < 20 * 60 * 1000) return chartmastersCache.rows;
  const url = 'https://chartmasters.org/most-monthly-listeners-on-spotify/';
  const html = await fetchText(url, { quiet: true, timeout: 25000 });
  if (!html) return [];
  const body = stripHtml(html), rows = [];
  for (const line of body.split('\n')) {
    const parts = line.split('|').map(x => x.trim()).filter(Boolean);
    const artistIndex = parts.findIndex((p, i) => i > 0 && p.length > 1 && !/^\d+$/.test(p) && !/^(image|artist|country|genre|language|gender|daily|monthly|listeners)$/i.test(p));
    if (artistIndex < 0) continue;
    const monthly = number(parts[artistIndex + 1]);
    if (monthly) rows.push({ artist: parts[artistIndex], monthly, source: 'ChartMasters' });
  }
  chartmastersCache = { time: now, rows };
  return rows;
}

async function musicBrainz(name) {
  const wait = Math.max(0, 1100 - (Date.now() - musicBrainzLastRequest));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  musicBrainzLastRequest = Date.now();
  const query = encodeURIComponent(`artist:\"${cleanArtistName(name)}\" OR alias:\"${cleanArtistName(name)}\"`);
  const data = await fetchJson(`https://musicbrainz.org/ws/2/artist/?query=${query}&fmt=json&limit=8`, { quiet: true, headers: { 'User-Agent': UA } });
  return (data?.artists || []).map(row => ({ artist: row.name || name, country: row.country || row.area?.name || row.begin_area?.name || '', genre: row.tags?.slice?.(0, 3)?.map(x => x.name).join(', ') || '', score: Number(row.score) || 0, source: 'MusicBrainz', url: `https://musicbrainz.org/artist/${row.id}` }));
}

async function appleMusic(name) {
  const html = await fetchText(`https://music.apple.com/us/search?term=${encodeURIComponent(name)}`, { quiet: true });
  if (!html) return null;
  const body = stripHtml(html);
  const title = body.match(/(?:Artists?|Artistas?)\s*\n([^\n]{2,120})/i)?.[1] || '';
  const country = body.match(/(?:From|De)\s*\n([^\n]{2,100})/i)?.[1] || '';
  const genre = body.match(/(?:Genre|Género)\s*\n([^\n]{2,100})/i)?.[1] || '';
  return title || country || genre ? { artist: title || name, country, genre, source: 'Apple Music web scraper' } : null;
}

async function wikipedia(name) {
  const html = await fetchText(`https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(name)}`, { quiet: true });
  if (!html) return null;
  const links = [...html.matchAll(/href=["']\/wiki\/([^"'#?]+)["'][^>]*>([^<]{2,120})<\/a>/gi)];
  const best = links.map(m => ({ title: m[2].trim(), slug: decodeURIComponent(m[1]).replace(/_/g, ' '), score: similarity(name, m[2]) })).sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 0.72) return null;
  const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(best.slug.replace(/ /g, '_'))}`;
  const page = await fetchText(pageUrl, { quiet: true });
  if (!page) return null;
  const body = stripHtml(page);
  const country = body.match(/(?:born|from|nationality|based in)\s+[^.]{0,100}\b(?:Puerto Rico|Argentina|Mexico|Peru|Colombia|Chile|Spain|Venezuela|Dominican Republic|United States|Canada|Brazil|France|Germany|Italy|United Kingdom)\b/i)?.[0] || '';
  return { artist: best.title, country, genre: '', source: 'Wikipedia web scraper', url: pageUrl };
}

export async function resolveArtist(rawName, hint = '') {
  const input = cleanArtistName(rawName);
  if (!input) return { artist: '', country: '', genre: '', monthly: null, confidence: 0, aliases: [], sources: [] };
  const cacheKey = key(input);
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const variants = leetVariants(input);
  const all = [];

  const chartRows = await chartmastersRows();
  for (const variant of variants.slice(0, 5)) {
    const row = chartRows.find(x => similarity(variant, x.artist) >= 0.94);
    if (row) all.push(row);
  }

  const spotifyProfiles = [];
  for (const variant of variants.slice(0, 4)) spotifyProfiles.push(...await spotifySearch(variant));
  const uniqueSpotify = [...new Map(spotifyProfiles.map(x => [x.spotifyId, x])).values()];
  for (const profile of uniqueSpotify) {
    const score = similarity(input, profile.artist);
    if (score >= 0.72) all.push({ ...profile, score });
  }

  const songstatsProfiles = await songstatsArtist(input);
  for (const profile of songstatsProfiles) all.push({ ...profile, score: similarity(input, profile.artist) });

  all.push(...await musicBrainz(input));
  const apple = await appleMusic(input); if (apple) all.push(apple);
  const wiki = await wikipedia(input); if (wiki) all.push(wiki);

  let best = null;
  const exactCandidates = [...new Map(all.filter(x => x.artist).map(x => [key(x.artist), x])).values()];
  if (exactCandidates.length > 1 && process.env.GEMINI_API_KEY) {
    const candidateText = exactCandidates.slice(0, 12).map((x, i) => `${i}: ${x.artist} | monthly=${x.monthly || 'unknown'} | country=${x.country || 'unknown'} | genre=${x.genre || 'unknown'} | songs=${(x.tracks || []).slice(0, 8).join(' / ')}`).join('\n');
    const prompt = `Eres un verificador de identidad musical. El usuario buscó exactamente: "${input}". Hay candidatos homónimos. Elige SOLO el candidato que sea realmente el artista solicitado, no una canción, álbum, colaborador, deportista, compositor o persona con el mismo nombre. Usa especialmente patrones de canciones: si varios títulos distintos se repiten asociados al mismo nombre, eso es una señal fuerte de que ese nombre es el artista. Considera también oyentes mensuales, género y país. Devuelve SOLO JSON: {"index":0,"confidence":0.0,"reason":"..."}. Candidatos:\n${candidateText}`;
    const ai = parseJson(await askGemini(prompt));
    if (Number.isInteger(ai.index) && exactCandidates[ai.index]) best = exactCandidates[ai.index];
  }

  if (!best) {
    best = [...all].sort((a, b) => {
      const sa = similarity(input, a.artist) + (Number.isFinite(a.monthly) && a.monthly >= config.minMonthlyListeners ? 0.12 : 0) + (a.source === 'Spotify web scraper' ? 0.08 : 0);
      const sb = similarity(input, b.artist) + (Number.isFinite(b.monthly) && b.monthly >= config.minMonthlyListeners ? 0.12 : 0) + (b.source === 'Spotify web scraper' ? 0.08 : 0);
      return sb - sa;
    })[0] || {};
  }

  const sameArtist = all.filter(x => similarity(input, x.artist) >= 0.72);
  const country = countryDisplay(best.country || sameArtist.map(x => x.country).find(Boolean) || '');
  const genre = best.genre || sameArtist.map(x => x.genre).find(Boolean) || '';
  const monthly = Number.isFinite(best.monthly) ? best.monthly : sameArtist.map(x => x.monthly).find(Number.isFinite) || null;
  const spotify = sameArtist.find(x => x.spotifyId) || uniqueSpotify.find(x => similarity(input, x.artist) >= 0.72);
  const songstats = songstatsProfiles.find(x => similarity(best.artist, x.artist) >= 0.8 && Number.isFinite(x.monthly));
  const result = {
    artist: best.artist || input,
    country: country || 'No identificado',
    genre: genre || 'No identificado',
    monthly: monthly || songstats?.monthly || null,
    spotifyId: spotify?.spotifyId || null,
    spotifyUrl: spotify?.spotifyUrl || '',
    imageUrl: best.imageUrl || spotify?.imageUrl || songstats?.imageUrl || '',
    confidence: Math.min(1, Math.max(0, similarity(input, best.artist || input))),
    aliases: variants.filter(v => key(v) !== key(input)),
    sources: [...new Set(all.filter(x => similarity(best.artist || input, x.artist) >= 0.72).map(x => x.source).filter(Boolean))],
    evidence: all.filter(x => similarity(best.artist || input, x.artist) >= 0.72).slice(0, 10),
    aiVerified: Boolean(process.env.GEMINI_API_KEY && exactCandidates.length > 1)
  };
  cache.set(cacheKey, result);
  return result;
}

export async function verifyMonthlyListeners(artist, resolved = null) {
  const identity = resolved || await resolveArtist(artist);
  if (Number.isFinite(identity.monthly) && identity.monthly > 0) {
    const source = identity.sources?.includes('Spotify web scraper') ? 'Spotify web scraper' : identity.sources?.includes('Songstats scraper') ? 'Songstats scraper' : identity.sources?.[0] || 'Spotify/Songstats';
    return { monthly: identity.monthly, source, url: identity.spotifyUrl || identity.evidence?.find(x => x.source === 'Songstats scraper')?.url || '', artist: identity.artist };
  }

  if (identity.spotifyId) {
    const spotify = await spotifyProfileById(identity.spotifyId, identity.artist);
    if (spotify?.monthly) return { monthly: spotify.monthly, source: 'Spotify web scraper', url: spotify.spotifyUrl, artist: spotify.artist };
  }

  const songstats = await songstatsArtist(identity.artist || artist);
  const exact = songstats.find(x => similarity(identity.artist || artist, x.artist) >= 0.8 && Number.isFinite(x.monthly));
  if (exact?.monthly) return { monthly: exact.monthly, source: 'Songstats scraper', url: exact.url, artist: exact.artist };

  return { monthly: null, source: null, artist: identity.artist || artist };
}

export { key as artistKey, leetVariants };