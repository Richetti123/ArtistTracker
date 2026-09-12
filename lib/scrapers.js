import { URL } from 'node:url';

const MONTHS = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ArtistTracker/3.0';

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
    .replace(/<\/(?:p|div|li|h1|h2|h3|h4|h5|section|article|time|tr|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' '))
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean)
    .join('\n');
}

async function fetchPage(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    console.error(`[SCRAPER] ${url} -> ${error.message}`);
    return null;
  }
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

function futureEnough(date) {
  if (!date) return true;
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const horizon = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
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
        if (value['@type'] === 'Event' || value['@type']?.includes?.('Event')) out.push(value);
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
    image: item.image || '',
    source,
    confidence: source === 'Ticketmaster' || source === 'Fever' || source === 'Entradas.com' ? 0.98 : 0.88,
    reason: `Evento encontrado directamente en ${source}.`
  };
}

function dedupe(events) {
  const map = new Map();
  for (const event of events.filter(Boolean)) {
    const key = `${norm(event.artist)}|${event.date?.slice(0, 10) || ''}|${norm(event.venue)}`;
    if (!map.has(key) || event.confidence > map.get(key).confidence) map.set(key, event);
  }
  return [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function artistWindow(text, artist) {
  const source = String(text || '');
  const target = norm(artist);
  const normalized = norm(source);
  const idx = normalized.indexOf(target);
  if (idx < 0) return '';
  const ratio = source.length / Math.max(normalized.length, 1);
  const start = Math.max(0, Math.floor((idx - 500) * ratio));
  const end = Math.min(source.length, Math.ceil((idx + 900) * ratio));
  return source.slice(start, end);
}

function parseTextualEvent(text, artist, source, url) {
  const window = artistWindow(text, artist);
  if (!window || !/madrid/i.test(window)) return null;
  const dateMatch = window.match(/(\d{1,2}\s+(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de)?\s+\d{4})|(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);
  const date = parseDate(dateMatch?.[1] || dateMatch?.[2]);
  if (date && !futureEnough(date)) return null;
  const time = window.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
  const venue = window.match(/(?:en|—|-|@)\s*([A-ZÁÉÍÓÚÑ][^\n|]{2,70})/i)?.[1]?.trim() || '';
  return {
    artist,
    event: artist,
    date: date ? date.toISOString() : '',
    time: time?.[0] || '',
    venue: venue.replace(/[,.;:]$/, ''),
    city: 'Madrid',
    url,
    source,
    confidence: source === 'Ticketmaster' ? 0.92 : 0.82,
    reason: `La página de ${source} contiene una coincidencia del artista con Madrid y datos de evento.`
  };
}

async function scrapeSite({ url, source, artist }) {
  const html = await fetchPage(url);
  if (!html) return { source, url, events: [], text: '' };
  const events = extractJsonLd(html).map(x => eventFromJsonLd(x, source, artist)).filter(Boolean);
  if (artist && !events.length) {
    const textual = parseTextualEvent(stripHtml(html), artist, source, url);
    if (textual) events.push(textual);
  }
  return { source, url, events: dedupe(events), text: stripHtml(html).slice(0, 25000) };
}

export async function scrapeMadridEvents(artist) {
  const clean = String(artist || '').trim();
  if (!clean) return { events: [], sources: [] };
  const slug = slugify(clean);
  const sites = [
    { source: 'Ticketmaster', url: `https://www.ticketmaster.es/discover/madrid?keyword=${encodeURIComponent(clean)}` },
    { source: 'Fever', url: `https://feverup.com/es/madrid/conciertos-festivales?query=${encodeURIComponent(clean)}` },
    { source: 'Entradas.com', url: `https://www.entradas.com/search/?keyword=${encodeURIComponent(clean)}` },
    { source: 'La Ganzúa', url: `https://www.laganzua.net/conciertos/entradas-${slug}` },
    { source: 'Bandsintown', url: `https://www.bandsintown.com/search?query=${encodeURIComponent(clean)}` }
  ];
  const results = await Promise.all(sites.map(scrapeSite));
  const found = dedupe(results.flatMap(x => x.events));
  return { events: found, sources: results.map(x => ({ source: x.source, url: x.url, ok: Boolean(x.text) })) };
}

export async function scrapeMonthlyListeners(artist) {
  const clean = String(artist || '').trim();
  if (!clean) return null;
  const sources = [
    { name: 'Spotify web', url: `https://open.spotify.com/search/${encodeURIComponent(clean)}/artists` },
    { name: 'Music Metrics Vault', url: `https://www.musicmetricsvault.com/artists/${slugify(clean)}` },
    { name: 'Kworb', url: 'https://www.kworb.net/spotify/listeners.html' }
  ];
  for (const item of sources) {
    const html = await fetchPage(item.url);
    if (!html) continue;
    const body = stripHtml(html);
    const window = item.name === 'Kworb' ? body : artistWindow(body, clean);
    if (!window || (item.name !== 'Kworb' && !norm(window).includes(norm(clean)))) continue;
    const matches = [...window.matchAll(/(?:monthly listeners|oyentes mensuales)[^0-9]{0,80}([0-9][0-9., ]*(?:[KMB])?)/ig)];
    for (const match of matches) {
      const raw = match[1].replace(/\s+/g, ' ').trim();
      const parsed = parseCompactNumber(raw);
      if (parsed) return { monthly: parsed, source: item.name, url: item.url };
    }
    if (item.name === 'Kworb') {
      const idx = norm(body).indexOf(norm(clean));
      const row = idx >= 0 ? body.slice(idx, idx + 220) : '';
      const parsed = parseCompactNumber(row.match(/(\d{1,3}(?:[,.]\d{3})+)/)?.[1]);
      if (parsed) return { monthly: parsed, source: item.name, url: item.url };
    }
  }
  return null;
}

function parseCompactNumber(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!m) {
    const plain = Number(s.replace(/\./g, '').replace(/,/g, ''));
    return Number.isFinite(plain) && plain > 0 ? Math.round(plain) : null;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[String(m[2] || '').toUpperCase()] || 1));
}

export async function discoverMadridArtists() {
  const sources = [
    { source: 'Ticketmaster Madrid', url: 'https://www.ticketmaster.es/discover/madrid?categoryId=KZFzniwnSyZfZ7v7nJ&date=thismonth&page=1' },
    { source: 'La Ganzúa Madrid', url: `https://www.laganzua.net/conciertos/madrid/${new Date().getFullYear()}` }
  ];
  const out = [];
  for (const item of sources) {
    const html = await fetchPage(item.url);
    if (!html) continue;
    const text = stripHtml(html);
    const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const heading = lines[i].match(/^(.{2,100}?)\s+en Madrid$/i);
      if (!heading) continue;
      const artist = heading[1].replace(/^concierto de\s+/i, '').trim();
      if (!artist || /conciertos|agenda|hoy|madrid/i.test(artist)) continue;
      const around = lines.slice(i, i + 8).join(' ');
      const dateMatch = around.match(/(\d{1,2}\s+(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de)?\s+\d{4})/i);
      const date = parseDate(dateMatch?.[1]);
      if (date && !futureEnough(date)) continue;
      const venue = around.match(/(?:Ciudad|Sala)\s+([^\n]{2,90})/i)?.[1]?.trim() || '';
      out.push({ artist, event: artist, date: date ? date.toISOString() : '', venue, source: item.source, url: item.url, confidence: item.source.includes('Ticketmaster') ? 0.9 : 0.84 });
    }
    const jsonEvents = extractJsonLd(html).map(x => eventFromJsonLd(x, item.source)).filter(Boolean);
    out.push(...jsonEvents.map(x => ({ artist: x.artist, event: x.event, date: x.date, venue: x.venue, source: x.source, url: x.url || item.url, confidence: x.confidence })));
  }
  return dedupe(out);
}
