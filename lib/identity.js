import { config } from './config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36 ArtistTracker/6.0';
const cache = new Map();
const spotifyCache = new Map();
const sourceCache = new Map();
let musicBrainzLastRequest = 0;

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const key = s => norm(s).replace(/1/g, 'i').replace(/2/g, 's').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'o').replace(/[^a-z0-9]/g, '');
export const artistKey = key;

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

function parseNumber(value) {
  if (value == null) return null;
  let s = String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  const suffix = lower.match(/(?:k|m|b|mil|mill(?:on|ones)|millón|millones|bn)$/)?.[0] || '';
  if (suffix) s = s.slice(0, -suffix.length);
  if (!suffix && /^\d{1,3}(?:[.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
  else if (suffix && s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
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
    .replace(/\r/g, '').replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n').replace(/[ \t]+\n/g, '\n')
    .split('\n').map(x => x.trim()).filter(Boolean).join('\n');
}

async function fetchDirect(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: options.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8', ...(options.headers || {}) },
      redirect: 'follow', signal: AbortSignal.timeout(options.timeout || 20000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (!options.quiet) console.error(`[IDENTITY] ${url} -> ${error.message}`);
    return null;
  }
}

async function fetchText(url, options = {}) {
  const cacheKey = `${options.reader ? 'reader:' : 'direct:'}${url}`;
  if (sourceCache.has(cacheKey)) return sourceCache.get(cacheKey);
  let html = await fetchDirect(url, options);
  if (!html && options.reader !== false) {
    const readerUrl = `https://r.jina.ai/${url}`;
    html = await fetchDirect(readerUrl, { ...options, quiet: true, timeout: 30000 });
    if (html) console.log(`[IDENTITY] ↪ lector web de respaldo: ${url}`);
  }
  sourceCache.set(cacheKey, html);
  return html;
}

function extractSpotifyIds(html) {
  const ids = new Set();
  const source = String(html || '');
  for (const re of [
    /spotify:artist:([A-Za-z0-9]{22})/g,
    /open\.spotify\.com\/(?:intl-[^/]+\/)?artist\/([A-Za-z0-9]{22})/g,
    /(?:artistId|entityId|spotifyArtistId)["']?\s*[:=]\s*["']([A-Za-z0-9]{22})["']/g
  ]) for (const m of source.matchAll(re)) ids.add(m[1]);
  return [...ids];
}

function extractMonthly(raw) {
  const source = String(raw || '');
  const plain = stripHtml(source);
  const all = `${source}\n${plain}`;
  const patterns = [
    /([0-9][0-9.,\s]*?(?:k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?)\s*(?:monthly listeners|monthly\s+listeners|oyentes mensuales|oyentes\s+mensuales)/ig,
    /(?:monthly listeners|monthly\s+listeners|oyentes mensuales|oyentes\s+mensuales)[^0-9]{0,160}([0-9][0-9.,\s]*?(?:k|m|b|mil|mill(?:on|ones)|millón|millones|bn)?)/ig,
    /(?:monthlyListeners|monthly_listeners|monthlyListenersCount)[^0-9]{0,30}([0-9][0-9.,\s]*(?:k|m|b)?)/ig,
    /\bListeners\s*[:\-]?\s*([0-9][0-9.,\s]*(?:k|m|b)?)\s*\/\s*mo\b/ig,
    /\b([0-9][0-9.,\s]*(?:k|m|b)?)\s*\/\s*mo\s*listeners\b/ig
  ];
  for (const re of patterns) {
    for (const m of all.matchAll(re)) {
      const n = parseNumber(m[1]);
      if (n) return n;
    }
  }
  return null;
}

function extractImage(raw) {
  const source = String(raw || '');
  return source.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i)?.[1]
    || source.match(/https?:\/\/i\.scdn\.co\/image\/[^\s"'<>\\)]+/i)?.[0]
    || source.match(/https?:\/\/mosaic\.scdn\.co\/[^\s"'<>\\)]+/i)?.[0]
    || '';
}

function spotifyName(raw, fallback) {
  const title = String(raw || '').match(/<title[^>]*>\s*([^<]+?)\s*(?:\||-)\s*Spotify\s*<\/title>/i)?.[1]?.trim();
  if (title && !/spotify|search/i.test(title)) return title;
  const plain = stripHtml(raw);
  const heading = plain.match(/(?:^|\n)\s*#?\s*([^\n]{2,100})\s*\n[^\n]{0,160}(?:monthly listeners|oyentes mensuales)/i)?.[1]?.trim();
  return heading && similarity(fallback, heading) >= 0.85 ? heading : fallback;
}

function extractGenre(raw) {
  const plain = stripHtml(raw);
  return plain.match(/Genres?\s*\n([^\n]{2,180})/i)?.[1]?.trim()
    || plain.match(/Géneros?\s*\n([^\n]{2,180})/i)?.[1]?.trim()
    || '';
}

async function spotifyProfileById(id, fallbackName = '') {
  if (!id) return null;
  if (spotifyCache.has(id)) return spotifyCache.get(id);
  const url = `https://open.spotify.com/artist/${id}`;
  let html = await fetchText(url, { quiet: true, timeout: 25000 });
  if (!html) html = await fetchText(`https://open.spotify.com/intl-es/artist/${id}`, { quiet: true, timeout: 25000 });
  if (!html) return null;
  const artist = spotifyName(html, fallbackName);
  const profile = {
    artist: artist || fallbackName,
    spotifyId: id,
    spotifyUrl: url,
    monthly: extractMonthly(html),
    imageUrl: extractImage(html),
    genre: extractGenre(html),
    tracks: [],
    raw: html,
    source: 'Spotify web scraper'
  };
  console.log(`[SPOTIFY] ${profile.artist}: ${profile.monthly ? profile.monthly.toLocaleString('es-ES') : 'oyentes no extraídos'} | imagen=${profile.imageUrl ? 'sí' : 'no'}`);
  spotifyCache.set(id, profile);
  return profile;
}

async function spotifySearch(name) {
  const urls = [
    `https://open.spotify.com/search/${encodeURIComponent(name)}/artists`,
    `https://open.spotify.com/search/${encodeURIComponent(name)}`,
    `https://open.spotify.com/intl-es/search/${encodeURIComponent(name)}/artists`
  ];
  const ids = new Set();
  for (const url of urls) {
    const html = await fetchText(url, { quiet: true, timeout: 25000 });
    for (const id of extractSpotifyIds(html)) ids.add(id);
    if (ids.size >= 12) break;
  }
  const profiles = [];
  for (const id of [...ids].slice(0, 15)) {
    const p = await spotifyProfileById(id, name);
    if (p && similarity(name, p.artist) >= 0.9) profiles.push({ ...p, score: similarity(name, p.artist) });
  }
  console.log(`[SPOTIFY] búsqueda "${name}": ${profiles.length} candidato(s).`);
  return profiles;
}

function songstatsCandidatesFromHtml(html) {
  const out = [];
  const add = (id, slug) => {
    const artist = decodeURIComponent(slug || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (id && artist && !out.some(x => x.id === id)) out.push({ id, artist, url: `https://songstats.com/artist/${id}/${slug}` });
  };
  for (const m of String(html || '').matchAll(/(?:https?:\/\/songstats\.com)?\/artist\/([a-z0-9]+)\/([^"'?#\\s]+)/gi)) add(m[1], m[2]);
  return out;
}

function embeddedSpotifyId(html) { return extractSpotifyIds(html)[0] || null; }

async function songstatsArtist(name) {
  const candidates = [];
  for (const url of [`https://songstats.com/search?query=${encodeURIComponent(name)}`, `https://songstats.com/search?q=${encodeURIComponent(name)}`]) {
    const html = await fetchText(url, { quiet: true, timeout: 25000 });
    for (const c of songstatsCandidatesFromHtml(html)) if (similarity(name, c.artist) >= 0.9 && !candidates.some(x => x.id === c.id)) candidates.push(c);
    if (candidates.length) break;
  }
  const out = [];
  for (const c of candidates.slice(0, 8)) {
    for (const url of [c.url, `${c.url}?source=spotify&popupStyle=graph&graphDataId=account-popularity`]) {
      const html = await fetchText(url, { quiet: true, timeout: 25000 });
      if (!html) continue;
      const artist = spotifyName(html, c.artist);
      if (similarity(name, artist) < 0.9) continue;
      const p = { ...c, artist, spotifyId: embeddedSpotifyId(html), monthly: extractMonthly(html), imageUrl: extractImage(html), genre: extractGenre(html), tracks: [], source: 'Songstats scraper', url, raw: html };
      out.push(p);
      console.log(`[SONGSTATS] ${artist}: ${p.monthly ? p.monthly.toLocaleString('es-ES') : 'oyentes no extraídos'}`);
      break;
    }
  }
  return out;
}

async function artistToolsProfile(candidate) {
  const spotifyId = candidate?.spotifyId || embeddedSpotifyId(candidate?.raw || '');
  if (!spotifyId) return null;
  const url = `https://app.artist.tools/artist/${spotifyId}`;
  const html = await fetchText(url, { quiet: true, timeout: 30000 });
  if (!html) return null;
  const plain = stripHtml(html);
  const title = plain.match(/(?:^|\n)#\s*([^\n]+)/)?.[1]?.trim() || candidate.artist || '';
  const monthly = extractMonthly(html) || parseNumber(plain.match(/Listeners\s*[:\-]?\s*([0-9][0-9.,\s]+)\/mo/i)?.[1]);
  const genre = extractGenre(html);
  if (candidate.artist && similarity(candidate.artist, title) < 0.85) return null;
  const p = { artist: title || candidate.artist, spotifyId, spotifyUrl: `https://open.spotify.com/artist/${spotifyId}`, monthly, genre, imageUrl: extractImage(html) || candidate.imageUrl || '', tracks: [], source: 'artist.tools scraper', url, raw: html };
  console.log(`[ARTIST.TOOLS] ${p.artist}: ${p.monthly ? p.monthly.toLocaleString('es-ES') : 'oyentes no extraídos'}`);
  return p;
}

async function musicBrainz(name) {
  const wait = Math.max(0, 1100 - (Date.now() - musicBrainzLastRequest));
  if (wait) await new Promise(r => setTimeout(r, wait));
  musicBrainzLastRequest = Date.now();
  const q = encodeURIComponent(`artist:"${cleanArtistName(name)}" OR alias:"${cleanArtistName(name)}"`);
  const data = await fetchText(`https://musicbrainz.org/ws/2/artist/?query=${q}&fmt=json&limit=8`, { quiet: true, accept: 'application/json' });
  if (!data) return [];
  try {
    const json = JSON.parse(data);
    return (json.artists || []).map(row => ({
      artist: row.name || name,
      country: row.country || '',
      genre: row.tags?.slice?.(0, 6)?.map(x => x.name).join(', ') || '',
      score: Number(row.score) || 0,
      source: 'MusicBrainz',
      url: `https://musicbrainz.org/artist/${row.id}`,
      tracks: []
    }));
  } catch { return []; }
}

async function wikipedia(name) {
  const html = await fetchText(`https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(name)}`, { quiet: true });
  if (!html) return null;
  const links = [...html.matchAll(/href=["']\/wiki\/([^"'#?]+)["'][^>]*>([^<]{2,120})<\/a>/gi)];
  const best = links.map(m => ({ title: m[2].trim(), slug: decodeURIComponent(m[1]).replace(/_/g, ' '), score: similarity(name, m[2]) })).sort((a,b)=>b.score-a.score)[0];
  if (!best || best.score < 0.9) return null;
  const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(best.slug.replace(/ /g, '_'))}`;
  const page = await fetchText(pageUrl, { quiet: true });
  if (!page) return null;
  const plain = stripHtml(page);
  const country = plain.match(/Country\s*\n([^\n]+)/i)?.[1]?.trim() || plain.match(/Born\s*\n[^\n]*\n([^\n]+)/i)?.[1]?.trim() || '';
  return { artist: best.title, country, genre: '', source: 'Wikipedia web scraper', url: pageUrl, tracks: [] };
}

const countryNames = { ES:'España', CO:'Colombia', MX:'México', PE:'Perú', CL:'Chile', AR:'Argentina', VE:'Venezuela', BO:'Bolivia', EC:'Ecuador', PR:'Puerto Rico', DO:'República Dominicana', PY:'Paraguay', UY:'Uruguay', BR:'Brasil', US:'Estados Unidos', CA:'Canadá', FR:'Francia', IT:'Italia', DE:'Alemania', GB:'Reino Unido', PT:'Portugal', NL:'Países Bajos', BE:'Bélgica', AU:'Australia', RU:'Rusia', UA:'Ucrania', JP:'Japón', KR:'Corea del Sur' };
const flags = { España:'🇪🇸', Colombia:'🇨🇴', México:'🇲🇽', Perú:'🇵🇪', Chile:'🇨🇱', Argentina:'🇦🇷', Venezuela:'🇻🇪', Bolivia:'🇧🇴', Ecuador:'🇪🇨', 'Puerto Rico':'🇵🇷', 'República Dominicana':'🇩🇴', Paraguay:'🇵🇾', Uruguay:'🇺🇾', Brasil:'🇧🇷', 'Estados Unidos':'🇺🇸', Canadá:'🇨🇦', Francia:'🇫🇷', Italia:'🇮🇹', Alemania:'🇩🇪', 'Reino Unido':'🇬🇧', Portugal:'🇵🇹', 'Países Bajos':'🇳🇱', Bélgica:'🇧🇪', Australia:'🇦🇺', Rusia:'🇷🇺', Ucrania:'🇺🇦', Japón:'🇯🇵', 'Corea del Sur':'🇰🇷' };
function countryDisplay(value) { const raw = String(value || '').trim(); if (!raw) return ''; const name = countryNames[raw.toUpperCase()] || raw; return `${name}${flags[name] || ''}`; }

function isValidArtistCandidate(input, candidate) {
  if (!candidate?.artist) return false;
  const score = similarity(input, candidate.artist);
  if (score < 0.9) return false;
  if (/^(song|track|album|single|playlist|mix|remix|version|superestrella)$/i.test(candidate.artist)) return false;
  return true;
}

async function askGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.vision.model}:generateContent`, { method:'POST', headers:{'Content-Type':'application/json','x-goog-api-key':apiKey}, body:JSON.stringify({ contents:[{role:'user',parts:[{text:prompt}]}], generationConfig:{temperature:0.05} }), signal:AbortSignal.timeout(20000) });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.map(x=>x.text).filter(Boolean).join('\n') || null;
  } catch { return null; }
}

function parseJson(raw) { try { return JSON.parse(String(raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return {}; } }

async function chooseCandidate(input, candidates) {
  const valid = candidates.filter(x => isValidArtistCandidate(input, x));
  if (!valid.length) return null;
  const exact = valid.filter(x => key(x.artist) === key(input));
  const pool = exact.length ? exact : valid;
  if (pool.length === 1 || !process.env.GEMINI_API_KEY) return pool.sort((a,b)=>(b.monthly||0)-(a.monthly||0))[0];
  const list = pool.slice(0,12).map((x,i)=>`${i}: ARTISTA=${x.artist}|FUENTE=${x.source}|SPOTIFY_ID=${x.spotifyId||'none'}|OYENTES=${x.monthly||'unknown'}|PAIS=${x.country||'unknown'}|GENERO=${x.genre||'unknown'}`).join('\n');
  const ai = parseJson(await askGemini(`El usuario buscó exactamente "${input}". Elige SOLO el artista musical real. Nunca conviertas una canción, álbum, playlist o lanzamiento en artista. Ejemplo: "Superestrella" es una canción de Aitana, no un artista. Prioriza nombre exacto, Spotify ID y coherencia de catálogo. Devuelve SOLO JSON {"index":0,"confidence":0.0,"reason":"..."}.\n${list}`));
  return Number.isInteger(ai.index) && pool[ai.index] ? { ...pool[ai.index], aiReason: ai.reason || '' } : pool[0];
}

export async function resolveArtist(rawName, hint = '') {
  const input = cleanArtistName(rawName);
  if (!input) return { artist:'', country:'', genre:'', monthly:null, confidence:0, aliases:[], sources:[] };
  const cacheKey = key(input);
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const variants = leetVariants(input);
  const spotifyProfiles = [];
  for (const variant of variants.slice(0,4)) spotifyProfiles.push(...await spotifySearch(variant));
  const uniqueSpotify = [...new Map(spotifyProfiles.filter(x=>x.spotifyId).map(x=>[x.spotifyId,x])).values()];
  const songstatsProfiles = await songstatsArtist(input);
  for (const s of songstatsProfiles) if (s.spotifyId && !uniqueSpotify.some(x=>x.spotifyId===s.spotifyId)) {
    const p = await spotifyProfileById(s.spotifyId, s.artist);
    if (p) uniqueSpotify.push(p);
  }
  const artistToolsProfiles = [];
  for (const p of uniqueSpotify.slice(0,8)) { const at = await artistToolsProfile(p); if (at) artistToolsProfiles.push(at); }
  const others = await musicBrainz(input);
  const wiki = await wikipedia(input); if (wiki) others.push(wiki);
  const candidates = [...uniqueSpotify, ...songstatsProfiles, ...artistToolsProfiles, ...others];
  const best = await chooseCandidate(input, candidates) || uniqueSpotify[0] || songstatsProfiles[0] || artistToolsProfiles[0] || others[0] || { artist:input };
  const same = candidates.filter(x=>isValidArtistCandidate(input,x));
  const spotify = same.find(x=>x.spotifyId) || uniqueSpotify.find(x=>x.spotifyId);
  const metadata = same.find(x=>x.country) || others.find(x=>x.country);
  const genreSource = same.find(x=>x.genre);
  const result = {
    artist: best.artist || input,
    country: countryDisplay(best.country || metadata?.country || '') || 'No identificado',
    genre: best.genre || genreSource?.genre || 'No identificado',
    monthly: Number.isFinite(best.monthly) ? best.monthly : (same.find(x=>Number.isFinite(x.monthly))?.monthly || null),
    spotifyId: best.spotifyId || spotify?.spotifyId || null,
    spotifyUrl: best.spotifyUrl || spotify?.spotifyUrl || '',
    imageUrl: best.imageUrl || spotify?.imageUrl || songstatsProfiles.find(x=>x.imageUrl)?.imageUrl || '',
    confidence: Math.min(1, Math.max(0, similarity(input,best.artist||input))),
    aliases: variants.filter(v=>key(v)!==key(input)),
    sources: [...new Set(same.map(x=>x.source).filter(Boolean))],
    evidence: same.slice(0,15),
    aiVerified: Boolean(best.aiReason),
    aiReason: best.aiReason || ''
  };
  cache.set(cacheKey,result);
  return result;
}

export async function verifyMonthlyListeners(artist, resolved = null) {
  const input = cleanArtistName(artist);
  const profile = resolved || await resolveArtist(input);
  console.log(`[LISTENERS] ${input}: 1/3 Spotify`);
  let spotify = null;
  if (profile.spotifyId) spotify = await spotifyProfileById(profile.spotifyId, profile.artist);
  if (!spotify) {
    const candidates = await spotifySearch(input);
    spotify = candidates.find(x=>key(x.artist)===key(input)) || candidates[0] || null;
  }
  if (spotify?.monthly) return { monthly:spotify.monthly, source:'Spotify web scraper', url:spotify.spotifyUrl, artist:spotify.artist, imageUrl:spotify.imageUrl };
  console.log(`[LISTENERS] ${input}: Spotify sin dato, 2/3 Songstats`);
  const songstats = await songstatsArtist(profile.artist || input);
  const ss = songstats.find(x=>similarity(profile.artist||input,x.artist)>=0.9 && Number.isFinite(x.monthly));
  if (ss?.monthly) return { monthly:ss.monthly, source:'Songstats scraper', url:ss.url, artist:ss.artist, imageUrl:ss.imageUrl };
  console.log(`[LISTENERS] ${input}: Songstats sin dato, 3/3 artist.tools`);
  const atBase = profile.spotifyId ? { spotifyId:profile.spotifyId, artist:profile.artist, imageUrl:profile.imageUrl } : spotify;
  const at = await artistToolsProfile(atBase);
  if (at?.monthly) return { monthly:at.monthly, source:'artist.tools scraper', url:at.url, artist:at.artist, imageUrl:at.imageUrl };
  console.log(`[LISTENERS] ${input}: ninguna de las 3 fuentes verificó oyentes.`);
  return { monthly:null, source:null, artist:profile.artist||input, imageUrl:profile.imageUrl||'' };
}

export function leetVariants(name) {
  const clean = cleanArtistName(name), out = new Set([clean]);
  const add = v => v && out.size < 10 && out.add(v);
  add(clean.replace(/1/g,'i')); add(clean.replace(/1/g,'l')); add(clean.replace(/2/g,'s').replace(/5/g,'s')); add(clean.replace(/3/g,'e')); add(clean.replace(/4/g,'a')); add(clean.replace(/7/g,'t')); add(clean.replace(/8/g,'o'));
  return [...out].filter(Boolean);
}
