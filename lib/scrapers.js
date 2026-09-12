const MONTHS = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ArtistTracker/3.1';

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(?:p|div|li|h1|h2|h3|h4|h5|section|article|time|tr|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' '))
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean)
    .join('\n');
}

async function fetchPage(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: options.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeout || 20000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    console.error(`[SCRAPER] ${url} -> ${error.message}`);
    return null;
  }
}

async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json,*/*;q=0.8',
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(options.timeout || 20000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`[SCRAPER-API] ${url} -> ${error.message}`);
    return null;
  }
}

function parseCompactNumber(value) {
  if (value == null) return null;
  let s = String(value).replace(/\s+/g, '').trim();
  if (!s) return null;
  const suffix = s.match(/[KMB]$/i)?.[0]?.toUpperCase() || '';
  if (suffix) s = s.slice(0, -1);
  if (!s) return null;
  if (!suffix) {
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
    else s = s.replace(/,/g, '.');
  } else {
    s = s.replace(/,/g, '.');
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1));
}

function parseDate(value) {
  const s = String(value || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let m = s.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (m) {
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóúñ]+)(?:\s+de)?\s+(\d{4})/i);
  if (m) {
    const month = MONTHS[norm(m[2])];
    if (month == null) return null;
    const d = new Date(Number(m[3]), month, Number(m[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function futureEnough(date, lookaheadDays = 180) {
  if (!date) return true;
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const horizon = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
  return date >= cutoff && date <= horizon;
}

function slugify(s) {
  return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function extractJsonLd(html) {
  const out = [];
  for (const match of String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeEntities(match[1].trim()));
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const walk = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) return value.forEach(walk);
        const type = value['@type'];
        if (type === 'Event' || type?.includes?.('Event')) out.push(value);
        if (value.itemListElement) walk(value.itemListElement);
        if (value['@graph']) walk(value['@graph']);
      };
      values.forEach(walk);
    } catch {}
  }
  return out;
}

function eventFromJsonLd(item, source, fallbackArtist = '') {
  const location = Array.isArray(item.location) ? item.location[0] : item.location;
  const address = location?.address;
  const addressText = typeof address === 'string' ? address : [address?.streetAddress, address?.addressLocality, address?.addressRegion, address?.addressCountry].filter(Boolean).join(', ');
  const combined = [item.name, location?.name, addressText].filter(Boolean).join(' | ');
  if (!/madrid/i.test(combined)) return null;
  const date = parseDate(item.startDate);
  if (!futureEnough(date)) return null;
  return {
    artist: fallbackArtist || item.performer?.name || item.name || '',
    event: item.name || fallbackArtist,
    date: date ? date.toISOString() : item.startDate || '',
    venue: location?.name || '',
    city: 'Madrid',
    url: item.url || '',
    image: Array.isArray(item.image) ? item.image[0] : item.image || '',
    source,
    confidence: ['Ticketmaster', 'Fever', 'Entradas.com'].includes(source) ? 0.98 : 0.88,
    reason: `Evento encontrado directamente en ${source}.`
  };
}

function eventFromTicketmaster(item) {
  const city = item?._embedded?.venues?.[0]?.city?.name || '';
  if (norm(city) !== 'madrid') return null;
  const attraction = item?._embedded?.attractions?.find(x => x?.name)?.name || '';
  const date = item?.dates?.start?.dateTime || item?.dates?.start?.localDate || '';
  const parsed = parseDate(date);
  if (parsed && !futureEnough(parsed)) return null;
  return {
    artist: attraction || item.name || '', event: item.name || attraction,
    date: parsed ? parsed.toISOString() : date,
    venue: item?._embedded?.venues?.[0]?.name || '', city: 'Madrid',
    url: item?.url || '', image: item?.images?.[0]?.url || '',
    source: 'Ticketmaster API', confidence: 1,
    reason: 'Evento confirmado por la Discovery API oficial de Ticketmaster.'
  };
}

async function scrapeTicketmasterApi(artist) {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) return [];
  const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${encodeURIComponent(key)}&keyword=${encodeURIComponent(artist)}&countryCode=ES&dmaId=503&classificationName=music&size=20&sort=date,asc`;
  const data = await fetchJson(url);
  return (data?._embedded?.events || []).map(eventFromTicketmaster).filter(Boolean);
}

function dedupe(events) {
  const map = new Map();
  for (const event of events.filter(Boolean)) {
    const key = `${norm(event.artist)}|${event.date?.slice(0, 10) || ''}|${norm(event.venue)}`;
    if (!map.has(key) || Number(event.confidence || 0) > Number(map.get(key).confidence || 0)) map.set(key, event);
  }
  return [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function artistWindow(source, artist, before = 800, after = 1600) {
  const text = String(source || '');
  const target = norm(artist);
  const normalized = norm(text);
  const idx = normalized.indexOf(target);
  if (idx < 0) return '';
  const ratio = text.length / Math.max(normalized.length, 1);
  const start = Math.max(0, Math.floor((idx - before) * ratio));
  const end = Math.min(text.length, Math.ceil((idx + after) * ratio));
  return text.slice(start, end);
}

function parseTextualEvent(text, artist, source, url) {
  const window = artistWindow(text, artist);
  if (!window || !/madrid/i.test(window)) return null;
  const dateMatch = window.match(/(\d{1,2}\s+(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de)?\s+\d{4})|(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);
  const date = parseDate(dateMatch?.[1] || dateMatch?.[2]);
  if (date && !futureEnough(date)) return null;
  const time = window.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/);
  const venue = window.match(/(?:en|—|-|@)\s*([A-ZÁÉÍÓÚÑ][^\n|]{2,70})/i)?.[1]?.trim() || '';
  return { artist, event: artist, date: date ? date.toISOString() : '', time: time?.[0] || '', venue: venue.replace(/[,.;:]$/, ''), city: 'Madrid', url, source, confidence: source === 'Ticketmaster' ? 0.92 : 0.82, reason: `La página de ${source} contiene una coincidencia del artista con Madrid y datos de evento.` };
}

async function scrapeSite({ url, source, artist }) {
  const html = await fetchPage(url);
  if (!html) return { source, url, events: [], text: '' };
  const events = extractJsonLd(html).map(x => eventFromJsonLd(x, source, artist)).filter(Boolean);
  if (artist && !events.length) {
    const textual = parseTextualEvent(stripHtml(html), artist, source, url);
    if (textual) events.push(textual);
  }
  return { source, url, events: dedupe(events), text: stripHtml(html).slice(0, 30000) };
}

export async function scrapeMadridEvents(artist) {
  const clean = String(artist || '').trim();
  if (!clean) return { events: [], sources: [] };
  const slug = slugify(clean);
  const apiEvents = await scrapeTicketmasterApi(clean);
  const sites = [
    { source: 'Ticketmaster', url: `https://www.ticketmaster.es/discover/madrid?keyword=${encodeURIComponent(clean)}` },
    { source: 'Fever', url: `https://feverup.com/es/madrid/conciertos-festivales?query=${encodeURIComponent(clean)}` },
    { source: 'Entradas.com', url: `https://www.entradas.com/search/?keyword=${encodeURIComponent(clean)}` },
    { source: 'La Ganzúa', url: `https://www.laganzua.net/conciertos/entradas-${slug}` },
    { source: 'Bandsintown', url: `https://www.bandsintown.com/search?query=${encodeURIComponent(clean)}` }
  ];
  const results = await Promise.all(sites.map(scrapeSite));
  const found = dedupe([...apiEvents, ...results.flatMap(x => x.events)]);
  return { events: found, sources: [{ source: 'Ticketmaster API', ok: Boolean(process.env.TICKETMASTER_API_KEY) }, ...results.map(x => ({ source: x.source, url: x.url, ok: Boolean(x.text) }))] };
}

function spotifyArtistLinks(html) {
  const links = [];
  for (const match of String(html || '').matchAll(/href=["'](https?:\/\/open\.spotify\.com\/artist\/([a-zA-Z0-9]+)|\/artist\/([a-zA-Z0-9]+))["']/gi)) {
    const id = match[2] || match[3];
    if (!id || links.some(x => x.id === id)) continue;
    links.push({ id, url: `https://open.spotify.com/artist/${id}` });
  }
  return links.slice(0, 10);
}

function extractSpotifyMonthly(body) {
  const patterns = [
    /([0-9][0-9., ]*(?:[KMB])?)\s*(?:monthly listeners|oyentes mensuales)/ig,
    /(?:monthly listeners|oyentes mensuales)[^0-9]{0,60}([0-9][0-9., ]*(?:[KMB])?)/ig
  ];
  for (const re of patterns) {
    for (const match of body.matchAll(re)) {
      const value = parseCompactNumber(match[1]);
      if (value) return value;
    }
  }
  return null;
}

function preferredGenreFromText(body) {
  const n = norm(body);
  const preferred = [['reggaeton', 'Reggaeton'], ['pop', 'Pop'], ['indie', 'Indie'], ['rock', 'Rock'], ['trap', 'Trap'], ['bachata', 'Bachata'], ['dembow', 'Dembow'], ['musica criolla', 'Música criolla']];
  return preferred.find(([term]) => n.includes(term))?.[1] || '';
}

function extractCountry(body) {
  const n = norm(body);
  const countries = [
    ['puerto rico', 'Puerto Rico'], ['republica dominicana', 'República Dominicana'], ['mexico', 'México'], ['peru', 'Perú'], ['colombia', 'Colombia'], ['chile', 'Chile'], ['argentina', 'Argentina'], ['venezuela', 'Venezuela'], ['bolivia', 'Bolivia'], ['ecuador', 'Ecuador'], ['paraguay', 'Paraguay'], ['uruguay', 'Uruguay'], ['espana', 'España'], ['cuba', 'Cuba'], ['brasil', 'Brasil'], ['estados unidos', 'Estados Unidos'], ['united states', 'Estados Unidos'], ['canada', 'Canadá'], ['france', 'Francia'], ['francia', 'Francia'], ['italy', 'Italia'], ['italia', 'Italia'], ['germany', 'Alemania'], ['alemania', 'Alemania'], ['united kingdom', 'Reino Unido'], ['reino unido', 'Reino Unido']
  ];
  return countries.find(([term]) => n.includes(term))?.[1] || '';
}

function extractGenre(body) {
  const preferred = preferredGenreFromText(body);
  if (preferred) return preferred;
  const match = body.match(/(?:genre|género|genero|styles|estilos)\s*[:\-]?\s*([^\n]{2,100})/i);
  return match?.[1] ? match[1].replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

async function scrapeSpotifyArtistPage(url, artist) {
  const html = await fetchPage(url);
  if (!html) return null;
  const body = stripHtml(html);
  const monthly = extractSpotifyMonthly(body) || extractSpotifyMonthly(html);
  const country = extractCountry(body);
  const genre = extractGenre(body);
  const artistMatch = body.match(/(?:^|\n)\s*([^\n]{2,120})\s*\n\s*(?:[0-9][0-9., ]+)\s+(?:monthly listeners|oyentes mensuales)/i);
  return { artist: artistMatch?.[1]?.trim() || artist, monthly, country, genre, url };
}

export async function scrapeSpotifyArtist(artist) {
  const clean = String(artist || '').trim();
  if (!clean) return null;
  const searchUrl = `https://open.spotify.com/search/${encodeURIComponent(clean)}/artists`;
  const searchHtml = await fetchPage(searchUrl);
  if (!searchHtml) return null;
  const exact = norm(clean);
  const links = spotifyArtistLinks(searchHtml);
  for (const link of links) {
    const result = await scrapeSpotifyArtistPage(link.url, clean);
    if (!result) continue;
    const same = norm(result.artist).includes(exact) || exact.includes(norm(result.artist));
    if (same || links.length === 1) return { ...result, source: 'Spotify web scraper', searchUrl };
  }
  const monthly = extractSpotifyMonthly(stripHtml(searchHtml));
  if (monthly) return { artist: clean, monthly, country: '', genre: '', url: searchUrl, source: 'Spotify web scraper', searchUrl };
  return null;
}

async function scrapeShazamProfile(artist) {
  const endpoint = `https://www.shazam.com/services/search/v4/es-ES/ES/search?term=${encodeURIComponent(artist)}&limit=5&offset=0&types=artists`;
  const data = await fetchJson(endpoint, { headers: { 'X-Shazam-Platform': 'IPHONE', 'X-Shazam-AppVersion': '14.1.0' } });
  const rows = data?.artists?.data || data?.results?.artists?.data || data?.results?.artists?.hits || [];
  const row = Array.isArray(rows) ? rows.find(x => norm(x?.attributes?.name || x?.name) === norm(artist)) || rows[0] : null;
  const id = row?.id || row?.attributes?.id;
  if (!id) return null;
  const url = `https://www.shazam.com/artist/_/${id}`;
  const html = await fetchPage(url);
  if (!html) return null;
  const body = stripHtml(html);
  return { artist: row?.attributes?.name || row?.name || artist, country: extractCountry(body), genre: extractGenre(body), url, source: 'Shazam web scraper' };
}

async function scrapeWikipediaProfile(artist) {
  const searchUrl = `https://es.wikipedia.org/w/index.php?search=${encodeURIComponent(artist)}`;
  const searchHtml = await fetchPage(searchUrl);
  if (!searchHtml) return null;
  const matches = [...searchHtml.matchAll(/href=["']\/wiki\/([^"'#?]+)["'][^>]*>([^<]{2,120})<\/a>/gi)];
  const match = matches.find(m => norm(decodeURIComponent(m[1]).replace(/_/g, ' ')).includes(norm(artist)) || norm(artist).includes(norm(decodeURIComponent(m[1]).replace(/_/g, ' '))));
  if (!match) return null;
  const title = decodeURIComponent(match[1]).replace(/_/g, ' ');
  const url = `https://es.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const html = await fetchPage(url);
  if (!html) return null;
  const body = stripHtml(html);
  return { artist: title, country: extractCountry(body), genre: extractGenre(body), url, source: 'Wikipedia web scraper' };
}

export async function scrapeArtistProfile(artist) {
  const clean = String(artist || '').trim();
  if (!clean) return null;
  const found = [];
  const spotify = await scrapeSpotifyArtist(clean);
  if (spotify) found.push(spotify);

  const shazam = await scrapeShazamProfile(clean);
  if (shazam) found.push(shazam);

  const wiki = await scrapeWikipediaProfile(clean);
  if (wiki) found.push(wiki);

  if (!found.length) return null;
  const country = found.map(x => x.country).find(Boolean) || '';
  const genre = found.map(x => x.genre).find(Boolean) || '';
  const monthly = found.map(x => x.monthly).find(Number.isFinite) || null;
  const source = found.map(x => x.source).filter(Boolean).join(' + ');
  const confidence = country && genre ? 0.95 : country || genre ? 0.82 : monthly ? 0.75 : 0.55;
  return { artist: clean, country, genre, monthly, url: found.find(x => x.url)?.url || '', source, confidence, sources: found };
}

export async function scrapeMonthlyListeners(artist) {
  const clean = String(artist || '').trim();
  if (!clean) return null;
  const spotify = await scrapeSpotifyArtist(clean);
  if (spotify?.monthly) return { monthly: spotify.monthly, source: spotify.source, url: spotify.url };

  const sources = [
    { name: 'Music Metrics Vault', url: `https://www.musicmetricsvault.com/artists/${slugify(clean)}` },
    { name: 'Kworb', url: 'https://www.kworb.net/spotify/listeners.html' },
    { name: 'Chartmetric', url: `https://chartmetric.com/artist/${slugify(clean)}` }
  ];
  for (const item of sources) {
    const html = await fetchPage(item.url);
    if (!html) continue;
    const body = stripHtml(html);
    const window = item.name === 'Kworb' ? body : artistWindow(body, clean, 1200, 2200);
    if (!window || (item.name !== 'Kworb' && !norm(window).includes(norm(clean)))) continue;
    const matches = [
      ...window.matchAll(/(?:monthly listeners|oyentes mensuales)[^0-9]{0,100}([0-9][0-9., ]*(?:[KMB])?)/ig),
      ...window.matchAll(/([0-9][0-9., ]*(?:[KMB])?)\s*(?:monthly listeners|oyentes mensuales)/ig)
    ];
    for (const match of matches) {
      const parsed = parseCompactNumber(match[1]);
      if (parsed) return { monthly: parsed, source: item.name, url: item.url };
    }
  }
  return null;
}

async function scrapeLaGanzuaPage(url) {
  const html = await fetchPage(url);
  if (!html) return { source: 'La Ganzúa', url, events: [], text: '' };
  const body = stripHtml(html);
  const events = [];
  for (const match of body.matchAll(/([^\n]{2,100})\s+en\s+Madrid(?:\s+[^\n]{0,40})?/gi)) {
    const line = match[0].trim().replace(/\s+/g, ' ');
    let artist = match[1].replace(/\s+(?:-\s+)?(?:paquetes? vip|segunda fecha|tercera fecha).*$/i, '').trim();
    artist = artist.replace(/^##\s*/, '').trim();
    if (!artist || /conciertos|agenda|festival/i.test(artist)) continue;
    const window = body.slice(Math.max(0, match.index - 250), match.index + 650);
    const dateMatch = window.match(/(?:lunes|martes|miércoles|jueves|viernes|sábado|domingo)?\s*(\d{1,2}\s+de\s+[a-záéíóúñ]+\s+de\s+\d{4})/i);
    const date = parseDate(dateMatch?.[1]);
    if (date && !futureEnough(date)) continue;
    const venue = window.match(/Madrid\s*\n\s*([^\n]{2,100})/i)?.[1]?.trim() || '';
    events.push({ artist, event: line, date: date ? date.toISOString() : '', venue, city: 'Madrid', url, source: 'La Ganzúa', confidence: 0.9, reason: 'Artista encontrado en la agenda de conciertos de Madrid de La Ganzúa.' });
  }
  return { source: 'La Ganzúa', url, events: dedupe(events), text: body.slice(0, 50000) };
}

export async function discoverMadridArtists() {
  const candidates = new Map();
  const add = item => {
    if (!item?.artist) return;
    const key = norm(item.artist);
    if (!key || key.length < 2) return;
    const previous = candidates.get(key);
    if (!previous || Number(item.confidence || 0) > Number(previous.confidence || 0)) candidates.set(key, item);
  };

  const ticketmaster = await scrapeSite({ source: 'Ticketmaster', url: 'https://www.ticketmaster.es/discover/madrid?classificationName=music' });
  for (const event of ticketmaster.events) add(event);

  for (let page = 1; page <= 12; page++) {
    const url = page === 1 ? 'https://www.laganzua.net/conciertos/madrid/2026' : `https://www.laganzua.net/conciertos/madrid/2026?page=${page}`;
    const result = await scrapeLaGanzuaPage(url);
    for (const event of result.events) add(event);
  }

  return [...candidates.values()].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).slice(0, 100);
}
