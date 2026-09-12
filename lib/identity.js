import { config } from './config.js';

const UA = 'ArtistTracker/4.0 (+https://github.com/Richetti123/ArtistTracker)';
const cache = new Map();
let chartmastersCache = null;
let musicBrainzLastRequest = 0;

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function key(s) {
  return norm(s)
    .replace(/1/g, 'i').replace(/2/g, 's').replace(/3/g, 'e').replace(/4/g, 'a')
    .replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'o')
    .replace(/[il]/g, 'i').replace(/[^a-z0-9]/g, '');
}

function cleanArtistName(value) {
  let s = String(value || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/^\s*(?:🎤|artist|artista)\s*[:=-]\s*/i, '');
  s = s.replace(/\s*(?:[-–—|:]\s*)?(?:cuarta|tercera|segunda|primera)\s+fecha(?:\s+.*)?$/i, '');
  s = s.replace(/\s*(?:[-–—|:]\s*)?(?:4a|3a|2a|1a)\s+fecha(?:\s+.*)?$/i, '');
  s = s.replace(/\s+en\s+madrid(?:\s+.*)?$/i, '');
  s = s.replace(/\s*\((?:madrid|españa)\)\s*$/i, '');
  s = s.replace(/\s*[-–—|:]\s*(?:madrid|madrid,\s*españa)\s*$/i, '');
  s = s.replace(/^(?:concierto|conciertos|evento)\s*[:=-]\s*/i, '');
  return s.trim();
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
      headers: {
        'User-Agent': UA,
        Accept: options.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        ...(options.headers || {})
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeout || 18000)
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
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json,*/*;q=0.8', ...(options.headers || {}) },
      signal: AbortSignal.timeout(options.timeout || 15000)
    });
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
  const add = value => { if (value && out.size < 12) out.add(value); };
  add(clean.replace(/1/g, 'i'));
  add(clean.replace(/1/g, 'l'));
  add(clean.replace(/2/g, 's').replace(/5/g, 's'));
  add(clean.replace(/3/g, 'e'));
  add(clean.replace(/4/g, 'a'));
  add(clean.replace(/7/g, 't'));
  add(clean.replace(/8/g, 'o'));
  add(clean.replace(/1/g, 'i').replace(/7/g, 't').replace(/2/g, 's').replace(/5/g, 's'));
  add(clean.replace(/7/g, 't').replace(/3/g, 'e').replace(/4/g, 'a').replace(/8/g, 'o'));
  add(clean.replace(/1/g, 'l').replace(/7/g, 't'));
  return [...out].filter(Boolean);
}

function similarity(a, b) {
  const x = key(a), y = key(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length);
  const ax = new Set(x.split('')), by = new Set(y.split(''));
  const common = [...ax].filter(c => by.has(c)).length;
  return common / Math.max(ax.size, by.size);
}

function parseSpotifyId(value) {
  const m = String(value || '').match(/(?:spotify:artist:|\/artist\/)([A-Za-z0-9]{22})/);
  return m?.[1] || null;
}

function spotifyIds(html) {
  const ids = new Set();
  for (const re of [
    /spotify:artist:([A-Za-z0-9]{22})/g,
    /open\.spotify\.com\/artist\/([A-Za-z0-9]{22})/g,
    /(?:\\"|\\')artistId(?:\\"|\\')\s*[:=]\s*[\\"']([A-Za-z0-9]{22})[\\"']/g,
    /(?:\\"|\\')uri(?:\\"|\\')\s*[:=]\s*[\\"']spotify:artist:([A-Za-z0-9]{22})[\\"']/g
  ]) for (const m of String(html || '').matchAll(re)) ids.add(m[1]);
  return [...ids].slice(0, 12);
}

function spotifyNameFromPage(html, fallback) {
  const body = stripHtml(html);
  const title = String(html || '').match(/<title[^>]*>\s*([^<]+?)\s*(?:\||-)?\s*Spotify\s*<\/title>/i)?.[1];
  if (title && title.trim()) return title.trim();
  const h1 = body.match(/(?:^|\n)\s*([^\n]{1,120})\s*\n[^\n]{0,80}(?:monthly listeners|oyentes mensuales)/i)?.[1];
  return h1?.trim() || fallback;
}

function extractMonthly(html) {
  const source = stripHtml(html);
  const patterns = [
    /([0-9][0-9.,\s]*)\s*(k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?\s*monthly listeners/ig,
    /([0-9][0-9.,\s]*)\s*(k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?\s*oyentes mensuales/ig,
    /monthly listeners[^0-9]{0,80}([0-9][0-9.,\s]*)\s*(k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?/ig,
    /oyentes mensuales[^0-9]{0,80}([0-9][0-9.,\s]*)\s*(k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?/ig
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) {
    const raw = `${m[1]}${m[2] || ''}`;
    const n = number(raw);
    if (n) return n;
  }
  return null;
}

async function spotifyProfileById(id, fallbackName = '') {
  const url = `https://open.spotify.com/artist/${id}`;
  const html = await fetchText(url, { quiet: true });
  if (!html) return null;
  const name = spotifyNameFromPage(html, fallbackName);
  return { artist: name, spotifyId: id, spotifyUrl: url, monthly: extractMonthly(html), raw: html, source: 'Spotify web scraper' };
}

async function spotifySearch(name) {
  const url = `https://open.spotify.com/search/${encodeURIComponent(name)}/artists`;
  const html = await fetchText(url, { quiet: true });
  if (!html) return [];
  const ids = spotifyIds(html);
  const profiles = [];
  for (const id of ids.slice(0, 8)) {
    const profile = await spotifyProfileById(id, name);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

async function chartmastersRows() {
  const now = Date.now();
  if (chartmastersCache && now - chartmastersCache.time < 20 * 60 * 1000) return chartmastersCache.rows;
  const url = 'https://chartmasters.org/most-monthly-listeners-on-spotify/';
  const html = await fetchText(url, { quiet: true, timeout: 25000 });
  if (!html) return [];
  const body = stripHtml(html);
  const rows = [];
  for (const line of body.split('\n')) {
    const parts = line.split('|').map(x => x.trim()).filter(Boolean);
    if (parts.length < 5) continue;
    const artistIndex = parts.findIndex((p, i) => i > 0 && p.length > 1 && !/^\d+$/.test(p) && !/^(?:image|artist|country|genre|language|gender|daily|monthly|listeners)$/i.test(p));
    if (artistIndex < 0) continue;
    const artist = parts[artistIndex];
    const monthly = number(parts[artistIndex + 1]);
    if (!monthly) continue;
    const idIndex = parts.findIndex(p => /^[A-Za-z0-9]{22}$/.test(p));
    rows.push({ artist, monthly, spotifyId: idIndex >= 0 ? parts[idIndex] : null, country: idIndex >= 0 ? parts[idIndex + 1] || '' : '', genre: idIndex >= 0 ? parts[idIndex + 2] || '' : '', source: 'ChartMasters', url });
  }
  chartmastersCache = { time: now, rows };
  return rows;
}

async function musicBrainz(name) {
  const wait = Math.max(0, 1100 - (Date.now() - musicBrainzLastRequest));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  musicBrainzLastRequest = Date.now();
  const query = encodeURIComponent(`artist:"${cleanArtistName(name)}" OR alias:"${cleanArtistName(name)}"`);
  const url = `https://musicbrainz.org/ws/2/artist/?query=${query}&fmt=json&limit=8`;
  const data = await fetchJson(url, { quiet: true, headers: { 'User-Agent': UA } });
  const rows = data?.artists || [];
  return rows.map(row => ({
    artist: row.name || name,
    country: row.country || row.area?.name || row.begin_area?.name || '',
    genre: row.tags?.slice?.(0, 3)?.map(x => x.name).join(', ') || '',
    score: Number(row.score) || 0,
    source: 'MusicBrainz',
    url: `https://musicbrainz.org/artist/${row.id}`
  }));
}

async function appleMusic(name) {
  const url = `https://music.apple.com/us/search?term=${encodeURIComponent(name)}`;
  const html = await fetchText(url, { quiet: true });
  if (!html) return null;
  const body = stripHtml(html);
  const title = body.match(/(?:Artists?|Artistas?)\s*\n([^\n]{2,120})/i)?.[1] || '';
  const country = body.match(/(?:From|De)\s*\n([^\n]{2,100})/i)?.[1] || '';
  const genre = body.match(/(?:Genre|Género)\s*\n([^\n]{2,100})/i)?.[1] || '';
  if (!title && !country && !genre) return null;
  return { artist: title || name, country, genre, source: 'Apple Music web scraper', url };
}

async function wikipedia(name) {
  const url = `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(name)}`;
  const html = await fetchText(url, { quiet: true });
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

  // ChartMasters is the fastest high-quality first pass for artists in the 40k+ range.
  const chartRows = await chartmastersRows();
  for (const variant of variants.slice(0, 5)) {
    const row = chartRows.find(x => similarity(variant, x.artist) >= 0.94);
    if (row) all.push(row);
  }

  // Spotify is the preferred identity and listener source. Search every useful spelling variant.
  const seenIds = new Set(all.map(x => x.spotifyId).filter(Boolean));
  for (const variant of variants.slice(0, 6)) {
    const profiles = await spotifySearch(variant);
    for (const profile of profiles) {
      if (seenIds.has(profile.spotifyId)) continue;
      seenIds.add(profile.spotifyId);
      const score = similarity(input, profile.artist);
      if (score >= 0.72) all.push({ ...profile, score });
    }
    if (all.some(x => similarity(input, x.artist) >= 0.97)) break;
  }

  // No-key metadata sources are used to classify country/genre and resolve homonyms.
  const mb = await musicBrainz(input);
  all.push(...mb);
  const apple = await appleMusic(input);
  if (apple) all.push(apple);
  const wiki = await wikipedia(input);
  if (wiki) all.push(wiki);

  const hintNorm = norm(hint);
  const ranked = all.map(item => {
    const exact = similarity(input, item.artist);
    const countryBonus = hintNorm && norm(item.country).includes(hintNorm) ? 0.18 : 0;
    const listenerBonus = Number.isFinite(item.monthly) && item.monthly >= config.minMonthlyListeners ? 0.12 : 0;
    return { item, rank: exact + countryBonus + listenerBonus };
  }).sort((a, b) => b.rank - a.rank);
  const best = ranked[0]?.item || {};
  const artist = best.artist || input;
  const country = best.country || ranked.find(x => x.item.country)?.item.country || '';
  const genre = best.genre || ranked.find(x => x.item.genre)?.item.genre || '';
  const monthly = ranked.find(x => Number.isFinite(x.item.monthly))?.item.monthly || null;
  const spotify = ranked.find(x => x.item.spotifyId) || null;
  const result = {
    artist,
    country,
    genre,
    monthly,
    spotifyId: spotify?.item.spotifyId || best.spotifyId || null,
    spotifyUrl: spotify?.item.spotifyUrl || (best.spotifyId ? `https://open.spotify.com/artist/${best.spotifyId}` : ''),
    confidence: Math.min(1, Math.max(0, ranked[0]?.rank || 0)),
    aliases: [...new Set(variants.filter(v => key(v) !== key(input)))],
    sources: ranked.slice(0, 8).map(x => x.item.source).filter(Boolean),
    evidence: ranked.slice(0, 8).map(x => x.item)
  };
  cache.set(cacheKey, result);
  return result;
}

export async function verifyMonthlyListeners(artist, resolved = null) {
  const identity = resolved || await resolveArtist(artist);
  if (Number.isFinite(identity.monthly) && identity.monthly > 0) {
    return { monthly: identity.monthly, source: identity.sources?.includes('Spotify web scraper') ? 'Spotify web scraper' : identity.sources?.[0] || 'ChartMasters', url: identity.spotifyUrl || '', artist: identity.artist };
  }

  // If Spotify identity is known, try its public page and then Music Metrics Vault using the same ID.
  if (identity.spotifyId) {
    const spotify = await spotifyProfileById(identity.spotifyId, identity.artist);
    if (spotify?.monthly) return { monthly: spotify.monthly, source: 'Spotify web scraper', url: spotify.spotifyUrl, artist: spotify.artist };
    const slug = cleanArtistName(identity.artist).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const mmvUrl = `https://www.musicmetricsvault.com/artists/${slug}/${identity.spotifyId}`;
    const mmv = await fetchText(mmvUrl, { quiet: true });
    const monthly = extractMonthly(mmv || '');
    if (monthly) return { monthly, source: 'Music Metrics Vault', url: mmvUrl, artist: identity.artist };
  }
  return { monthly: null, source: null, artist: identity.artist || artist };
}

export { cleanArtistName, key as artistKey, leetVariants, similarity };
