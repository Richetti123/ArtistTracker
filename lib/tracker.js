import { sources, text, songstatsStats, zylaMonthlyListeners } from './apis.js';
import { inspectContent } from './analyzer.js';
import { config } from './config.js';
import { loadState, saveState, deleteCase } from './store.js';
import { discoverMadridArtists, scrapeArtistProfile, scrapeMadridEvents, scrapeMonthlyListeners } from './scrapers.js';

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function names(raw) {
  const s = text(raw);
  const out = new Set();
  for (const re of [/\b(?:artist|artista|name|nombre)\s*[:=-]\s*([^\n,|]+)/ig, /@([a-z0-9._-]{2,})/ig]) {
    for (const m of s.matchAll(re)) {
      const n = (m[1] || '').trim();
      if (n.length > 1 && !/madrid|españa|mexico|peru|colombia|chile|argentina|venezuela|bolivia|ecuador|puerto|dominicana|paraguay|uruguay/i.test(n)) out.add(n);
    }
  }
  return [...out];
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value) return null;
  const s = String(value).replace(/\s/g, '').trim();
  const suffix = s.match(/[KMB]$/i)?.[0]?.toUpperCase() || '';
  let body = suffix ? s.slice(0, -1) : s;
  if (!suffix && /^\d{1,3}(?:[.,]\d{3})+$/.test(body)) body = body.replace(/[.,]/g, '');
  else body = body.replace(/,/g, '.');
  const n = Number(body);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1));
}

function extractMonthly(data) {
  if (!data) return null;
  const candidates = [
    data.monthly_listeners, data.monthlyListeners, data.monthlyListenersCount,
    data.stats?.monthly_listeners, data.stats?.monthlyListeners,
    data.data?.monthly_listeners, data.data?.stats?.monthly_listeners,
    data.results?.monthly_listeners, data.results?.monthlyListeners
  ];
  for (const value of candidates) {
    const n = parseNumber(value);
    if (Number.isFinite(n)) return n;
  }
  const raw = text(data);
  const match = raw.match(/(?:monthly listeners|oyentes mensuales)[^0-9]{0,80}([0-9][0-9., ]*(?:[KMB])?)/i) || raw.match(/([0-9][0-9., ]*(?:[KMB])?)\s*(?:monthly listeners|oyentes mensuales)/i);
  return match ? parseNumber(match[1]) : null;
}

function extractSongstatsId(raw) {
  const s = text(raw);
  const m = s.match(/(?:songstats[_ -]?artist[_ -]?id|songstats artist id)\s*[:=]\s*([a-z0-9_-]+)/i);
  return m?.[1] || null;
}

async function verifiedListeners(artist, rawDiscovery, profile = null) {
  // 1) Native web scraper inside this bot. No key, no external scraper host.
  if (Number.isFinite(profile?.monthly)) return { monthly: profile.monthly, source: profile.source?.includes('Spotify') ? 'Spotify web scraper' : 'Web scraper', artist, url: profile.url };
  const scraped = await scrapeMonthlyListeners(artist);
  if (scraped?.monthly) return { monthly: scraped.monthly, source: scraped.source, artist, url: scraped.url };

  // 2) Optional key-based providers only if the user later configures them.
  const songstatsId = extractSongstatsId(rawDiscovery);
  if (songstatsId) {
    const data = await songstatsStats(songstatsId);
    const monthly = extractMonthly(data);
    if (Number.isFinite(monthly)) return { monthly, source: 'Songstats API', artist };
  }
  const zyla = await zylaMonthlyListeners(artist);
  const monthly = extractMonthly(zyla);
  if (Number.isFinite(monthly)) return { monthly, source: 'Zyla / Spotify monthly listeners API', artist };
  return { monthly: null, source: null, artist };
}

function cleanGenre(value) {
  const s = String(value || '').trim();
  if (!s) return 'No identificado';
  return s.replace(/\.$/, '').replace(/\s+/g, ' ').slice(0, 80);
}

function validCountry(value) {
  const s = String(value || '').trim();
  if (!s || /^no identificado$/i.test(s)) return '';
  return s.slice(0, 80);
}

function extractJsonObject(raw) {
  const source = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const direct = (() => { try { return JSON.parse(source); } catch { return null; } })();
  if (direct && typeof direct === 'object') return direct;
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') { quote = true; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = source.slice(start, i + 1).replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

async function artistProfile(artist, hint = '') {
  // Profile is scraper-first. The AI is no longer the primary identity database.
  try {
    const scraped = await scrapeArtistProfile(artist);
    if (scraped && (scraped.country || scraped.genre || Number.isFinite(scraped.monthly))) {
      const country = validCountry(scraped.country) || validCountry(hint) || 'No identificado';
      const genre = cleanGenre(scraped.genre);
      const summaryParts = [
        country !== 'No identificado' ? `Origen/escena: ${country}.` : '',
        genre !== 'No identificado' ? `Género principal detectado: ${genre}.` : '',
        scraped.source ? `Fuentes: ${scraped.source}.` : ''
      ].filter(Boolean);
      return {
        country,
        genre,
        confidence: Number(scraped.confidence) || 0,
        summary: summaryParts.join(' ') || 'El perfil fue consultado mediante los scrapers locales, pero no hubo datos suficientes.',
        source: scraped.source || 'Web scraper',
        url: scraped.url || '',
        monthly: scraped.monthly || null,
        ai: false
      };
    }
  } catch (err) {
    console.error(`[PROFILE-SCRAPER] ${artist}: ${err.message}`);
  }

  // Last resort: the public Gemini/Starlight endpoint. It is not required for the bot
  // to identify the artist and a 500 here must never erase a valid web profile.
  const prompt = `Analiza al artista musical "${artist}". Devuelve SOLO JSON válido, sin Markdown ni texto adicional: {"country":"","genre":"","confidence":0,"summary":""}. No inventes datos. country es el país de origen, genre el género principal en español y confidence un número entre 0 y 1.`;
  try {
    const data = await sources.gemini(prompt);
    const raw = text(data);
    const parsed = extractJsonObject(raw);
    if (parsed) {
      return {
        country: validCountry(parsed.country) || validCountry(hint) || 'No identificado',
        genre: cleanGenre(parsed.genre),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
        summary: String(parsed.summary || 'Perfil generado por IA.').trim(),
        source: data?.provider || 'Gemini público',
        url: '',
        monthly: null,
        ai: true
      };
    }
  } catch (err) {
    console.error(`[PROFILE-AI] ${artist}: ${err.message}`);
  }
  return {
    country: validCountry(hint) || 'No identificado',
    genre: 'No identificado',
    confidence: 0,
    summary: 'No se pudo obtener un perfil fiable. El escaneo no inventa país ni género.',
    source: 'Sin perfil verificable',
    url: '',
    monthly: null,
    ai: false
  };
}

function genreMark(genre) {
  const n = norm(genre);
  const preferred = config.preferredGenres.some(g => n.includes(norm(g)));
  return preferred ? `${genre}⭐` : genre;
}

async function events(artist) {
  const result = await scrapeMadridEvents(artist);
  const links = config.ticketSites.map(x => ({ name: x.name, url: x.search.replace('{artist}', encodeURIComponent(artist)) }));
  return { ...result, links };
}

function formatEvent(event) {
  if (!event) return '';
  const date = event.date ? new Date(event.date) : null;
  const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString('es-ES', { timeZone: config.timezone, dateStyle: 'full', timeStyle: 'short' }) : '';
  return [event.event || event.artist, event.venue, dateText].filter(Boolean).join(' — ');
}

function alertText(a, c, l, genre, h, eventResult) {
  const event = eventResult?.events?.[0];
  const eventSources = eventResult?.events?.slice(0, 4).map(x => `• ${x.source}: ${formatEvent(x)}${x.url ? `\n  ${x.url}` : ''}`).join('\n') || '• No se obtuvo un evento de ticketing; la evidencia procede de redes.';
  const visual = h.imageAnalyses?.filter(x => x.available && !x.isCoverArt && (x.madrid || x.landmark)).slice(0, 2).map(x => `• ${x.landmark || 'Ubicación visual en Madrid'} (${Math.round(Math.max(x.confidence, x.landmarkConfidence || 0) * 100)}%): ${x.reason}`).join('\n');
  return `🎯 *ARTISTA DETECTADO EN MADRID*\n\n🎤 *${a}*\n🌎 País/escena: ${c}\n🎵 Género: *${genreMark(genre)}*\n🎧 Oyentes mensuales verificados: *${l.monthly.toLocaleString('es-ES')}*\n🔎 Fuente oyentes: ${l.source}\n🤖 IA: ${h.ai?.summary || 'Perfil verificado por fuentes web; la IA se usa para el análisis contextual.'}\n📍 ${h.ai?.reason || 'Evidencia de Madrid'}\n${event ? `📅 *Evento confirmado:* ${formatEvent(event)}\n` : ''}${visual ? `🧠 *Evidencia visual:*\n${visual}\n` : ''}\n🎟️ *Eventos/entradas encontrados:*\n${eventSources}\n\n¿Te interesa este artista? Responde *SÍ* o *NO*.\nSi respondes NO, borraré el material guardado de este aviso, pero el artista NO quedará bloqueado y podrá volver a aparecer si detectamos otra oportunidad en Madrid. Si no respondes, el material se conservará como máximo 7 días.`;
}

function hasCurrentSocialHit(results) {
  return results.find(x => x.directMadrid || x.visualMadrid || (x.ai?.madrid && x.ai?.current && x.ai?.confidence >= 0.75));
}

async function socialResults(artist) {
  const results = [];
  const inputs = [
    ['Instagram', () => sources.instagramPosts(artist)],
    ['TikTok', () => sources.tiktokSearch(artist)],
    ['SoundCloud', () => sources.soundcloudSearch(artist)]
  ];
  for (const [network, fn] of inputs) {
    try {
      const data = await fn();
      if (!data) continue;
      console.log(`  ├─ 📡 Analizando ${network}...`);
      results.push(await inspectContent(artist, network, data));
    } catch (err) {
      console.error(`  ├─ ⚠️ ${network}: ${err.message}`);
    }
  }
  return results;
}

async function analyzeArtist(artist, countryHint = '', { send = false, sock = null, destination = config.targetJid } = {}) {
  console.log(`\n  ┌─ 🔎 COMPROBACIÓN DE ${artist}`);
  const profile = await artistProfile(artist, countryHint);
  console.log(`  ├─ 🌎 País: ${profile.country} (${Math.round(profile.confidence * 100)}% confianza · ${profile.source})`);
  console.log(`  ├─ 🎵 Género: ${profile.genre}${config.preferredGenres.some(g => norm(profile.genre).includes(norm(g))) ? ' ⭐' : ''}`);

  const listeners = await verifiedListeners(artist, '', profile);
  if (Number.isFinite(listeners.monthly)) console.log(`  ├─ 🎧 Oyentes: ${listeners.monthly.toLocaleString('es-ES')} (${listeners.source})`);
  else console.log('  ├─ ❌ No se pudieron verificar los oyentes mensuales por web/API pública.');

  const eventResult = await events(artist);
  console.log(`  ├─ 🎟️ Scraper de eventos: ${eventResult.events.length} coincidencia(s) en Madrid.`);
  for (const event of eventResult.events.slice(0, 5)) console.log(`  │  ├─ ${event.source}: ${formatEvent(event)}`);

  const results = await socialResults(artist);
  const socialHit = hasCurrentSocialHit(results);
  const eventHit = eventResult.events[0] || null;
  const madrid = Boolean(eventHit || socialHit);
  console.log(`  ├─ ${madrid ? '🚨' : '⚪'} Madrid: ${madrid ? 'evidencia suficiente' : 'sin evidencia suficiente'}`);

  const best = socialHit || results.find(x => x.ai?.madrid) || results[0];
  const madridReason = eventHit
    ? `Evento de Madrid confirmado por ${eventHit.source}${eventHit.url ? `: ${eventHit.url}` : ''}.`
    : best?.ai?.reason || best?.imageAnalyses?.find(x => x.madrid)?.reason || (best?.sourceText ? 'Se analizaron las publicaciones encontradas, pero no se confirmó una oportunidad actual.' : 'No hubo contenido suficiente para verificar Madrid.');
  const ticketLinks = eventResult.links;

  if (send && sock) {
    const listenerText = Number.isFinite(listeners.monthly) ? `${listeners.monthly.toLocaleString('es-ES')} (${listeners.source})` : 'No verificados';
    const threshold = Number.isFinite(listeners.monthly) ? (listeners.monthly >= config.minMonthlyListeners ? `✅ supera el mínimo (${config.minMonthlyListeners.toLocaleString('es-ES')})` : `⚠️ está por debajo del mínimo (${config.minMonthlyListeners.toLocaleString('es-ES')})`) : `⚠️ sin verificación (mínimo ${config.minMonthlyListeners.toLocaleString('es-ES')})`;
    const eventText = eventResult.events.length ? eventResult.events.slice(0, 5).map(formatEvent).join('\n') : 'No se encontró un evento de Madrid en los scrapers de ticketing.';
    const visualText = results.flatMap(x => x.imageAnalyses || []).filter(x => x.available && !x.isCoverArt && (x.madrid || x.landmark)).slice(0, 4).map(x => `• ${x.landmark || 'Madrid visual'} — ${x.reason}`).join('\n');
    const response = `🔎 *BÚSQUEDA MANUAL: ${artist}*\n\n🌎 *País:* ${profile.country}\n🎵 *Género:* ${genreMark(profile.genre)}\n🎧 *Oyentes mensuales:* ${listenerText}\n📊 *Umbral ArtistTracker:* ${threshold}\n🔎 *Fuente del perfil:* ${profile.source}\n\n🤖 *Análisis de IA:*\n${profile.summary}\n\n📍 *Madrid:* ${madrid ? '🚨 SÍ, hay evidencia suficiente' : '❌ No pude confirmar presencia/actividad actual con la evidencia encontrada'}\n💡 *Motivo:* ${madridReason}\n\n🎟️ *Eventos encontrados por scraper:*\n${eventText}\n\n${visualText ? `🧠 *Análisis visual:*\n${visualText}\n\n` : '🧠 *Análisis visual:* no hubo una imagen verificable de Madrid; las portadas/artworks no se consideran evidencia de ubicación.\n\n'}🎟️ *Búsqueda de entradas:*\n${ticketLinks.map(x => `• ${x.name}: ${x.url}`).join('\n')}`;
    sock.__artistTrackerLastAnalysis = { artist, results, eventResult, profile, listeners };
    await sock.sendMessage(destination, { text: response });
    sock.__artistTrackerLastAnalysis = null;
  }

  console.log(`  └─ ${madrid ? '🚨' : '✅'} Comprobación manual terminada.`);
  return { artist, profile, listeners, madrid, hit: best, eventResult, results, ticketLinks };
}

export async function manualSearch(sock, artist, destination = config.targetJid) {
  const clean = String(artist || '').trim();
  if (!clean) return false;
  const chat = destination || config.targetJid;
  await sock.sendMessage(chat, { text: `🔎 Voy a comprobar manualmente *${clean}* en ArtistTracker. Revisaré primero los scrapers web locales y después las APIs públicas disponibles para país, género, oyentes, ticketing y fuentes sociales.` });
  try {
    await analyzeArtist(clean, '', { send: true, sock, destination: chat });
  } catch (err) {
    console.error('[MANUAL] Error:', err);
    await sock.sendMessage(chat, { text: `❌ No pude completar la búsqueda manual de *${clean}*. Revisa la consola para ver el error.` });
  }
  return true;
}

function candidateScore(candidate) {
  return Number(candidate.confidence || 0) + (candidate.source?.includes('Ticketmaster') ? 0.2 : 0);
}

async function automaticCandidates() {
  const candidates = new Map();
  const eventCandidates = await discoverMadridArtists();
  console.log(`[EVENTS] Descubrimiento web: ${eventCandidates.length} candidatos.`);
  for (const item of eventCandidates) {
    const key = norm(item.artist);
    if (!key || key.length < 2) continue;
    const previous = candidates.get(key);
    if (!previous || candidateScore(item) > candidateScore(previous.event || {})) candidates.set(key, { artist: item.artist, event: item, hint: '', discovery: item });
  }

  // Social discovery remains optional. A Starlight outage must not turn the complete scan into 0 artists.
  for (const country of config.countries) {
    console.log(`\n[🌎] Buscando candidatos sociales de ${country}...`);
    try {
      const discovery = await sources.tiktokSearch(`${country} artista Madrid`);
      if (!discovery) {
        console.log(`[⚠️] Sin respuesta de descubrimiento para ${country}; se conserva la búsqueda web.`);
        continue;
      }
      const found = names(discovery).slice(0, config.scan.maxCandidatesPerCountry);
      console.log(`[📋] ${found.length} candidatos sociales encontrados en ${country}.`);
      for (const artist of found) {
        const key = norm(artist);
        if (!candidates.has(key)) candidates.set(key, { artist, event: null, hint: country, discovery });
      }
    } catch (err) {
      console.error(`[DISCOVERY] ${country}: ${err.message}`);
    }
  }
  return [...candidates.values()].slice(0, config.scan.maxMadridEventCandidates);
}

export async function runScan(sock) {
  const state = await loadState();
  console.log('\n╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮');
  console.log('┃ 🔎 INICIANDO ESCANEO DE ARTISTAS      ┃');
  console.log('╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯');
  const candidates = await automaticCandidates();
  console.log(`[SCAN] Candidatos totales a verificar: ${candidates.length}.`);
  if (!candidates.length) console.log('[SCAN] ⚠️ Ningún descubridor respondió con candidatos; no se interpreta como "no hay artistas".');

  for (const candidate of candidates) {
    const artist = candidate.artist;
    const key = norm(artist);
    try {
      console.log(`\n  ┌─ 🎤 ${artist}: comprobación completa`);
      const profile = await artistProfile(artist, candidate.hint || '');
      console.log(`  ├─ 🌎 Perfil: ${profile.country} (${Math.round(profile.confidence * 100)}% · ${profile.source})`);
      const listeners = await verifiedListeners(artist, candidate.discovery || '', profile);
      if (!Number.isFinite(listeners.monthly)) {
        console.log(`  ├─ ⚠️ ${artist}: no se pudo verificar oyentes; no se enviará alerta para respetar el umbral.`);
        continue;
      }
      console.log(`  ├─ 🎧 ${listeners.monthly.toLocaleString('es-ES')} oyentes (${listeners.source})`);
      if (listeners.monthly < config.minMonthlyListeners) {
        console.log(`  ├─ ⏭️ ${artist}: por debajo de ${config.minMonthlyListeners.toLocaleString('es-ES')}.`);
        continue;
      }

      const eventResult = await events(artist);
      const results = await socialResults(artist);
      const socialHit = hasCurrentSocialHit(results);
      const eventHit = eventResult.events[0] || null;
      const hit = eventHit || socialHit;
      if (!hit) {
        console.log(`  └─ ⚪ ${artist}: sin evidencia actual de Madrid.`);
        continue;
      }

      const fingerprint = `${key}:${eventHit?.date || socialHit?.ai?.date || 'now'}:${eventHit?.venue || socialHit?.ai?.event || ''}:${eventHit?.source || socialHit?.network || ''}`;
      if (state.artists[fingerprint]?.sent) {
        console.log(`  └─ ♻️ ${artist}: aviso ya enviado.`);
        continue;
      }

      const messageHit = socialHit || { ai: { reason: eventHit.reason, event: eventHit.event, venue: eventHit.venue, date: eventHit.date } };
      const msg = alertText(artist, profile.country, listeners, profile.genre, { ...messageHit, imageAnalyses: results.flatMap(x => x.imageAnalyses || []), ai: { ...(messageHit.ai || {}), summary: profile.summary } }, eventResult);
      const sender = sock.__artistTrackerSendAutoMessage;
      if (typeof sender === 'function') await sender(config.targetJid, { text: msg }, { artist, analysis: { artist, results, eventResult, profile, listeners } });
      else await sock.sendMessage(config.targetJid, { text: msg });

      console.log(`  └─ 🚨 ${artist}: ¡DETECTADO EN MADRID! Aviso encolado/enviado.`);
      state.artists[fingerprint] = { sent: true, createdAt: Date.now(), artist, country: profile.country, genre: profile.genre, listeners: listeners.monthly, event: eventHit, folders: results.map(x => x.folder).filter(Boolean) };
      state.pending[fingerprint] = { artist, folders: results.map(x => x.folder).filter(Boolean), createdAt: Date.now() };
      await saveState(state);
    } catch (err) {
      console.error(`  └─ ⚠️ ${artist}: error durante comprobación: ${err.message}`);
    }
  }
  console.log('\n[✅] Escaneo terminado. Los fallos de APIs de descubrimiento no se interpretan como ausencia de artistas.\n');
}

export async function answerInterest(sock, msg) {
  const jid = msg.key.remoteJid;
  if (jid !== config.targetJid) return false;
  const body = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim().toLowerCase();
  if (!/^(si|sí|no|s|n)$/.test(body)) return false;
  const state = await loadState();
  const pending = Object.entries(state.pending).sort((a, b) => b[1].createdAt - a[1].createdAt)[0];
  if (!pending) return false;
  const [key, item] = pending;
  if (/^(no|n)$/.test(body)) {
    for (const f of item.folders || []) await deleteCase(f);
    state.artists[key] = { ...(state.artists[key] || {}), lastResponse: 'no', rejectedAt: Date.now() };
    delete state.pending[key];
    await saveState(state);
    await sock.sendMessage(jid, { text: `🗑️ Entendido. He eliminado el material multimedia de ${item.artist} de este aviso. No lo he añadido a ninguna blacklist: si volvemos a detectar una oportunidad relevante en Madrid, podrá aparecer de nuevo.` });
  } else {
    state.artists[key] = { ...(state.artists[key] || {}), interested: true, lastResponse: 'yes', lastResponseAt: Date.now(), interestedAt: Date.now() };
    delete state.pending[key];
    await saveState(state);
    await sock.sendMessage(jid, { text: `⭐ Perfecto. Guardaré el seguimiento de ${item.artist} y seguiré buscando nuevas oportunidades en Madrid.` });
  }
  return true;
}
