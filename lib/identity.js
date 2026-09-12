import { config } from './config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36 ArtistTracker/5.1';
const cache = new Map();
const spotifyCache = new Map();
let musicBrainzLastRequest = 0;

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const key = s => norm(s).replace(/1/g, 'i').replace(/2/g, 's').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'o').replace(/[^a-z0-9]/g, '');

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
      headers: { 'User-Agent': UA, Accept: options.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9,es-ES;q=0.8', ...(options.headers || {}) },
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
  const clean = cleanArtistName(name), out = new Set([clean]);
  const add = v => v && out.size < 10 && out.add(v);
  add(clean.replace(/1/g, 'i')); add(clean.replace(/1/g, 'l')); add(clean.replace(/2/g, 's').replace(/5/g, 's')); add(clean.replace(/3/g, 'e')); add(clean.replace(/4/g, 'a')); add(clean.replace(/7/g, 't')); add(clean.replace(/8/g, 'o'));
  return [...out].filter(Boolean);
}

function extractSpotifyIds(html) {
  const ids = new Set();
  for (const re of [/spotify:artist:([A-Za-z0-9]{22})/g, /open\.spotify\.com\/(?:intl-[^/]+\/)?artist\/([A-Za-z0-9]{22})/g, /(?:artistId|entityId)["']?\s*[:=]\s*["']([A-Za-z0-9]{22})["']/g]) {
    for (const m of String(html || '').matchAll(re)) ids.add(m[1]);
  }
  return [...ids];
}

function extractMonthly(html) {
  const source = `${String(html || '')}\n${stripHtml(html)}`;
  const patterns = [
    /([0-9][0-9.,\s]*)\s*(k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?\s*(?:monthly listeners|oyentes mensuales)/ig,
    /(?:monthly listeners|oyentes mensuales)[^0-9]{0,120}([0-9][0-9.,\s]*)\s*(k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?/ig,
    /["'](?:monthlyListeners|monthly_listeners|monthlyListenersCount)["']\s*[:=]\s*["']?([0-9][0-9.,]*)/ig
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) {
    const n = number(`${m[1]}${m[2] || ''}`);
    if (n) return n;
  }
  return null;
}

function imageFromHtml(html) {
  return String(html || '').match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || String(html || '').match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i)?.[1] || '';
}

function spotifyName(html, fallback) {
  const title = String(html || '').match(/<title[^>]*>\s*([^<]+?)\s*(?:\||-)?\s*Spotify\s*<\/title>/i)?.[1]?.trim();
  if (title && !/spotify/i.test(title)) return title;
  const body = stripHtml(html);
  return body.match(/(?:^|\n)\s*([^\n]{1,100})\s*\n[^\n]{0,100}(?:monthly listeners|oyentes mensuales)/i)?.[1]?.trim() || fallback;
}

function spotifyTracks(html, artist) {
  const body = stripHtml(html), out = new Set();
  const n = String(artist || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!n) return [];
  for (const m of body.matchAll(new RegExp(`([^\\n]{2,100})\\s+${n}(?:,|\\n|$)`, 'ig'))) {
    const v = m[1].trim();
    if (v && !/monthly listeners|followers|albums|singles|artist pick|discography/i.test(v)) out.add(v);
  }
  return [...out].slice(0, 15);
}

async function spotifyProfileById(id, fallbackName = '') {
  if (!id) return null;
  if (spotifyCache.has(id)) return spotifyCache.get(id);
  const url = `https://open.spotify.com/artist/${id}`;
  const html = await fetchText(url, { quiet: true, timeout: 25000 });
  if (!html) return null;
  const artist = spotifyName(html, fallbackName);
  const profile = { artist, spotifyId: id, spotifyUrl: url, monthly: extractMonthly(html), imageUrl: imageFromHtml(html), tracks: spotifyTracks(html, artist), raw: html, source: 'Spotify web scraper' };
  spotifyCache.set(id, profile);
  return profile;
}

async function spotifySearch(name) {
  const html = await fetchText(`https://open.spotify.com/search/${encodeURIComponent(name)}/artists`, { quiet: true, timeout: 25000 });
  if (!html) return [];
  const profiles = [];
  for (const id of extractSpotifyIds(html).slice(0, 12)) {
    const p = await spotifyProfileById(id, name);
    if (p && similarity(name, p.artist) >= 0.9) profiles.push({ ...p, score: similarity(name, p.artist) });
  }
  return profiles;
}

function songstatsCandidatesFromHtml(html) {
  const out = [];
  const add = (id, slug) => {
    const artist = decodeURIComponent(slug || '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    if (id && artist && !out.some(x => x.id === id)) out.push({ id, artist, url: `https://songstats.com/artist/${id}/${slug}` });
  };
  for (const m of String(html || '').matchAll(/(?:https?:\/\/songstats\.com)?\/artist\/([a-z0-9]+)\/([^"'?#\\]+)/gi)) add(m[1], m[2]);
  return out;
}

function embeddedSpotifyId(html) {
  return extractSpotifyIds(html)[0] || String(html || '').match(/spotify[^\n]{0,200}?artist[^A-Za-z0-9]{0,20}([A-Za-z0-9]{22})/i)?.[1] || null;
}

async function songstatsSearch(name) {
  for (const url of [`https://songstats.com/search?query=${encodeURIComponent(name)}`, `https://songstats.com/search?q=${encodeURIComponent(name)}`]) {
    const html = await fetchText(url, { quiet: true, timeout: 25000 });
    if (!html) continue;
    const candidates = songstatsCandidatesFromHtml(html).filter(x => similarity(name, x.artist) >= 0.9);
    if (candidates.length) return candidates.slice(0, 8);
  }
  return [];
}

async function songstatsProfile(candidate) {
  const urls = [candidate.url, `${candidate.url}?source=spotify&popupStyle=graph&graphDataId=account-popularity`];
  for (const url of urls) {
    const html = await fetchText(url, { quiet: true, timeout: 25000 });
    if (!html) continue;
    const artist = spotifyName(html, candidate.artist);
    if (similarity(candidate.artist, artist) < 0.9) continue;
    return { ...candidate, artist, spotifyId: embeddedSpotifyId(html), monthly: extractMonthly(html), imageUrl: imageFromHtml(html), tracks: [], source: 'Songstats scraper', url };
  }
  return null;
}

async function songstatsArtist(name) {
  const candidates = await songstatsSearch(name), out = [];
  for (const c of candidates) { const p = await songstatsProfile(c); if (p) out.push(p); }
  return out;
}

async function artistToolsProfile(candidate) {
  const spotifyId = candidate?.spotifyId || embeddedSpotifyId(candidate?.raw || '');
  if (!spotifyId) return null;
  const url = `https://app.artist.tools/artist/${spotifyId}`;
  const html = await fetchText(url, { quiet: true, timeout: 30000 });
  if (!html) return null;
  const body = stripHtml(html);
  const title = body.match(/\n#\s*([^\n]+)\n/)?.[1]?.trim() || candidate.artist || '';
  const monthly = extractMonthly(html) || number(body.match(/Listeners\s+([0-9][0-9.,]+)\/mo/i)?.[1]);
  const genre = body.match(/Genres\s*\n([^\n]{2,200})/i)?.[1]?.trim() || '';
  if (similarity(candidate.artist, title) < 0.9) return null;
  return { artist: title, spotifyId, spotifyUrl: `https://open.spotify.com/artist/${spotifyId}`, monthly, genre, imageUrl: imageFromHtml(html), tracks: [], source: 'artist.tools scraper', url, raw: html };
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.vision.model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.05 } }) });
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.map(x => x.text).filter(Boolean).join('\n') || null;
  } catch (e) { console.error(`[IDENTITY-AI] ${e.message}`); return null; }
}
function parseJson(raw) { try { return JSON.parse(String(raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return {}; } }

const countryNames = { ES: 'España', CO: 'Colombia', MX: 'México', PE: 'Perú', CL: 'Chile', AR: 'Argentina', VE: 'Venezuela', BO: 'Bolivia', EC: 'Ecuador', PR: 'Puerto Rico', DO: 'República Dominicana', PY: 'Paraguay', UY: 'Uruguay', BR: 'Brasil', US: 'Estados Unidos', CA: 'Canadá', FR: 'Francia', IT: 'Italia', DE: 'Alemania', GB: 'Reino Unido', PT: 'Portugal', NL: 'Países Bajos', BE: 'Bélgica', AU: 'Australia', RU: 'Rusia', UA: 'Ucrania', JP: 'Japón', KR: 'Corea del Sur' };
const flags = { España:'🇪🇸', Colombia:'🇨🇴', México:'🇲🇽', Perú:'🇵🇪', Chile:'🇨🇱', Argentina:'🇦🇷', Venezuela:'🇻🇪', Bolivia:'🇧🇴', Ecuador:'🇪🇨', 'Puerto Rico':'🇵🇷', 'República Dominicana':'🇩🇴', Paraguay:'🇵🇾', Uruguay:'🇺🇾', Brasil:'🇧🇷', 'Estados Unidos':'🇺🇸', Canadá:'🇨🇦', Francia:'🇫🇷', Italia:'🇮🇹', Alemania:'🇩🇪', 'Reino Unido':'🇬🇧', Portugal:'🇵🇹', 'Países Bajos':'🇳🇱', Bélgica:'🇧🇪', Australia:'🇦🇺', Rusia:'🇷🇺', Ucrania:'🇺🇦', Japón:'🇯🇵', 'Corea del Sur':'🇰🇷' };
function countryDisplay(value) { const raw = String(value || '').trim(); if (!raw) return ''; const name = countryNames[raw.toUpperCase()] || raw; const flag = flags[name] || ''; return flag && !name.includes(flag) ? `${name}${flag}` : name; }

async function musicBrainz(name) {
  const wait = Math.max(0, 1100 - (Date.now() - musicBrainzLastRequest)); if (wait) await new Promise(r => setTimeout(r, wait)); musicBrainzLastRequest = Date.now();
  const q = encodeURIComponent(`artist:"${cleanArtistName(name)}" OR alias:"${cleanArtistName(name)}"`);
  const data = await fetchJson(`https://musicbrainz.org/ws/2/artist/?query=${q}&fmt=json&limit=8`, { quiet: true, headers: { 'User-Agent': UA } });
  return (data?.artists || []).map(row => ({ artist: row.name || name, country: row.country || '', genre: row.tags?.slice?.(0, 5)?.map(x => x.name).join(', ') || '', score: Number(row.score) || 0, source: 'MusicBrainz', url: `https://musicbrainz.org/artist/${row.id}`, tracks: [] }));
}

async function wikipedia(name) {
  const html = await fetchText(`https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(name)}`, { quiet: true }); if (!html) return null;
  const links = [...html.matchAll(/href=["']\/wiki\/([^"'#?]+)["'][^>]*>([^<]{2,120})<\/a>/gi)];
  const best = links.map(m => ({ title: m[2].trim(), slug: decodeURIComponent(m[1]).replace(/_/g, ' '), score: similarity(name, m[2]) })).sort((a,b)=>b.score-a.score)[0];
  if (!best || best.score < 0.9) return null;
  const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(best.slug.replace(/ /g, '_'))}`, page = await fetchText(pageUrl, { quiet: true }); if (!page) return null;
  return { artist: best.title, country: '', genre: '', source: 'Wikipedia web scraper', url: pageUrl, tracks: [] };
}

function isValidArtistCandidate(input, candidate) {
  if (!candidate?.artist) return false;
  const score = similarity(input, candidate.artist);
  if (score < 0.9) return false;
  if (/^(song|track|album|single|playlist|mix|remix|version)$/i.test(candidate.artist)) return false;
  return true;
}

async function chooseCandidate(input, candidates) {
  const valid = candidates.filter(x => isValidArtistCandidate(input, x));
  if (!valid.length) return null;
  const exact = valid.filter(x => key(x.artist) === key(input));
  const pool = exact.length ? exact : valid;
  if (pool.length === 1 || !process.env.GEMINI_API_KEY) return pool.sort((a,b)=>(b.monthly||0)-(a.monthly||0))[0];
  const text = pool.slice(0, 12).map((x,i)=>`${i}: ARTISTA=${x.artist} | FUENTE=${x.source} | SPOTIFY_ID=${x.spotifyId||'none'} | OYENTES=${x.monthly||'unknown'} | PAIS=${x.country||'unknown'} | GENERO=${x.genre||'unknown'} | CANCIONES=${(x.tracks||[]).slice(0,12).join(' / ')}`).join('\n');
  const prompt = `El usuario buscó el nombre exacto "${input}". Selecciona el ARTISTA musical real entre estos candidatos. Nunca conviertas una canción, álbum, playlist o lanzamiento en artista. Si el nombre de la canción es "Superestrella" pero el artista real es "Aitana", la respuesta correcta para una búsqueda de Aitana es Aitana. Usa coincidencia exacta del nombre, Spotify ID, catálogo y patrón de múltiples canciones asociadas al mismo artista. Devuelve SOLO JSON {"index":0,"confidence":0.0,"reason":"..."}. Candidatos:\n${text}`;
  const ai = parseJson(await askGemini(prompt));
  return Number.isInteger(ai.index) && pool[ai.index] ? { ...pool[ai.index], aiReason: ai.reason || '' } : pool[0];
}

export async function resolveArtist(rawName, hint = '') {
  const input = cleanArtistName(rawName); if (!input) return { artist:'', country:'', genre:'', monthly:null, confidence:0, aliases:[], sources:[] };
  const cacheKey = key(input); if (cache.has(cacheKey)) return cache.get(cacheKey);
  const variants = leetVariants(input);
  const spotifyProfiles = [];
  for (const variant of variants.slice(0,4)) spotifyProfiles.push(...await spotifySearch(variant));
  const uniqueSpotify = [...new Map(spotifyProfiles.map(x=>[x.spotifyId,x])).values()];
  const songstatsProfiles = await songstatsArtist(input);
  for (const s of songstatsProfiles) if (s.spotifyId && !uniqueSpotify.some(x=>x.spotifyId===s.spotifyId)) { const p = await spotifyProfileById(s.spotifyId, s.artist); if (p) uniqueSpotify.push(p); }
  const artistToolsProfiles = [];
  for (const p of uniqueSpotify.slice(0,8)) { const at = await artistToolsProfile(p); if (at) artistToolsProfiles.push(at); }
  const others = [...await musicBrainz(input)]; const wiki = await wikipedia(input); if (wiki) others.push(wiki);
  const candidates = [...uniqueSpotify, ...songstatsProfiles, ...artistToolsProfiles, ...others];
  const best = await chooseCandidate(input, candidates) || uniqueSpotify[0] || songstatsProfiles[0] || artistToolsProfiles[0] || others[0] || { artist: input };
  const same = candidates.filter(x=>isValidArtistCandidate(input,x));
  const monthly = Number.isFinite(best.monthly) ? best.monthly : same.map(x=>x.monthly).find(Number.isFinite) || null;
  const spotify = same.find(x=>x.spotifyId) || uniqueSpotify.find(x=>x.spotifyId);
  const songstats = songstatsProfiles.find(x=>similarity(input,x.artist)>=0.9 && Number.isFinite(x.monthly));
  const at = artistToolsProfiles.find(x=>similarity(input,x.artist)>=0.9 && Number.isFinite(x.monthly));
  const result = {
    artist: best.artist || input,
    country: countryDisplay(best.country || same.map(x=>x.country).find(Boolean) || '') || 'No identificado',
    genre: best.genre || same.map(x=>x.genre).find(Boolean) || 'No identificado',
    monthly: monthly || songstats?.monthly || at?.monthly || null,
    spotifyId: best.spotifyId || spotify?.spotifyId || at?.spotifyId || songstats?.spotifyId || null,
    spotifyUrl: best.spotifyUrl || spotify?.spotifyUrl || at?.spotifyUrl || '',
    imageUrl: best.imageUrl || spotify?.imageUrl || songstats?.imageUrl || at?.imageUrl || '',
    confidence: Math.min(1, Math.max(0, similarity(input,best.artist||input))),
    aliases: variants.filter(v=>key(v)!==key(input)),
    sources: [...new Set(candidates.filter(x=>similarity(best.artist||input,x.artist)>=0.9).map(x=>x.source).filter(Boolean))],
    evidence: candidates.filter(x=>similarity(best.artist||input,x.artist)>=0.9).slice(0,15),
    aiVerified: Boolean(best.aiReason),
    aiReason: best.aiReason || ''
  };
  cache.set(cacheKey,result); return result;
}

export async function verifyMonthlyListeners(artist, resolved = null) {
  const input = cleanArtistName(artist);
  const profile = resolved || await resolveArtist(input);
  const spotify = profile.spotifyId ? await spotifyProfileById(profile.spotifyId, profile.artist) : (await spotifySearch(input))[0];
  if (spotify?.monthly) return { monthly: spotify.monthly, source:'Spotify web scraper', url:spotify.spotifyUrl, artist:spotify.artist };
  const songstats = await songstatsArtist(profile.artist || input);
  const ss = songstats.find(x=>similarity(profile.artist||input,x.artist)>=0.9 && Number.isFinite(x.monthly));
  if (ss?.monthly) return { monthly:ss.monthly, source:'Songstats scraper', url:ss.url, artist:ss.artist };
  const atBase = profile.spotifyId ? { spotifyId: profile.spotifyId, artist: profile.artist, imageUrl: profile.imageUrl } : null;
  const at = await artistToolsProfile(atBase);
  if (at?.monthly) return { monthly:at.monthly, source:'artist.tools scraper', url:at.url, artist:at.artist };
  return { monthly:null, source:null, artist:profile.artist||input };
}

export { key as artistKey, leetVariants };
