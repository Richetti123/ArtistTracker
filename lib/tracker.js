import { sources, text, songstatsStats, zylaMonthlyListeners } from './apis.js';
import { inspectContent } from './analyzer.js';
import { config } from './config.js';
import { loadState, saveState, deleteCase } from './store.js';
import { discoverMadridArtists, scrapeMadridEvents, scrapeMonthlyListeners } from './scrapers.js';

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
  const s = String(value).replace(/,/g, '').trim();
  const m = s.match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[String(m[2] || '').toUpperCase()] || 1));
}

function extractMonthly(data) {
  if (!data) return null;
  const candidates = [data.monthly_listeners, data.monthlyListeners, data.monthlyListenersCount, data.stats?.monthly_listeners, data.stats?.monthlyListeners, data.data?.monthly_listeners, data.data?.stats?.monthly_listeners];
  for (const value of candidates) {
    const n = parseNumber(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractSongstatsId(raw) {
  const s = text(raw);
  const m = s.match(/(?:songstats[_ -]?artist[_ -]?id|songstats artist id)\s*[:=]\s*([a-z0-9_-]+)/i);
  return m?.[1] || null;
}

async function verifiedListeners(artist, rawDiscovery) {
  const songstatsId = extractSongstatsId(rawDiscovery);
  if (songstatsId) {
    const data = await songstatsStats(songstatsId);
    const monthly = extractMonthly(data);
    if (Number.isFinite(monthly)) return { monthly, source: 'Songstats', artist };
  }
  const zyla = await zylaMonthlyListeners(artist);
  const monthly = extractMonthly(zyla);
  if (Number.isFinite(monthly)) return { monthly, source: 'Zyla / Spotify monthly listeners', artist };
  const scraped = await scrapeMonthlyListeners(artist);
  if (scraped?.monthly) return { monthly: scraped.monthly, source: scraped.source, artist, url: scraped.url };
  return { monthly: null, source: null, artist };
}

function cleanGenre(value) {
  const s = String(value || '').trim();
  if (!s) return 'No identificado';
  return s.replace(/\.$/, '').slice(0, 80);
}

async function artistProfile(artist, hint = '') {
  const prompt = `Analiza al artista musical "${artist}". ${hint ? `La búsqueda inicial lo relacionó con ${hint}, pero debes verificarlo y no asumir que sea correcto.` : ''} Usa conocimiento musical actual y el contexto disponible. Devuelve SOLO JSON válido con esta estructura: {"country":"","genre":"","confidence":0,"summary":""}. country debe ser el país de origen/nacionalidad musical más apropiado del artista, genre su género principal en español, confidence un número entre 0 y 1 indicando la confianza global y summary una explicación breve de por qué identificas así al artista. No inventes datos.`;
  const data = await sources.gemini(prompt);
  const raw = text(data);
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match?.[0] || raw);
    return { country: String(parsed.country || hint || 'No identificado').trim(), genre: cleanGenre(parsed.genre), confidence: Number(parsed.confidence) || 0, summary: String(parsed.summary || '').trim() };
  } catch {
    return { country: hint || 'No identificado', genre: 'No identificado', confidence: 0, summary: 'La IA no devolvió un perfil JSON válido; se continúa con fuentes web y ticketing.' };
  }
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
  return `🎯 *ARTISTA DETECTADO EN MADRID*\n\n🎤 *${a}*\n🌎 País/escena: ${c}\n🎵 Género: *${genreMark(genre)}*\n🎧 Oyentes mensuales verificados: *${l.monthly.toLocaleString('es-ES')}*\n🔎 Fuente oyentes: ${l.source}\n🤖 IA: ${h.ai?.summary || 'Análisis realizado con ArtistTracker'}\n📍 ${h.ai?.reason || 'Evidencia de Madrid'}\n${event ? `📅 *Evento confirmado:* ${formatEvent(event)}\n` : ''}${visual ? `🧠 *Evidencia visual:*\n${visual}\n` : ''}\n🎟️ *Eventos/entradas encontrados:*\n${eventSources}\n\n¿Te interesa este artista? Responde *SÍ* o *NO*.\nSi respondes NO, borraré el material guardado de este aviso, pero el artista NO quedará bloqueado y podrá volver a aparecer si detectamos otra oportunidad en Madrid. Si no respondes, el material se conservará como máximo 7 días.`;
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
  console.log(`  ├─ 🌎 País identificado por IA: ${profile.country} (${Math.round(profile.confidence * 100)}% confianza)`);
  console.log(`  ├─ 🎵 Género identificado por IA: ${profile.genre}${config.preferredGenres.some(g => norm(profile.genre).includes(norm(g))) ? ' ⭐' : ''}`);

  const listeners = await verifiedListeners(artist, '');
  if (Number.isFinite(listeners.monthly)) console.log(`  ├─ 🎧 Oyentes: ${listeners.monthly.toLocaleString('es-ES')} (${listeners.source})`);
  else console.log('  ├─ ❌ No se pudieron verificar los oyentes mensuales por API/web.');

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
    const threshold = Number.isFinite(listeners.monthly) ? (listeners.monthly >= config.minMonthlyListeners ? '✅ supera el mínimo' : '⚠️ está por debajo del mínimo') : '⚠️ sin verificación';
    const eventText = eventResult.events.length ? eventResult.events.slice(0, 5).map(formatEvent).join('\n') : 'No se encontró un evento de Madrid en los scrapers de ticketing.';
    const visualText = results.flatMap(x => x.imageAnalyses || []).filter(x => x.available && !x.isCoverArt && (x.madrid || x.landmark)).slice(0, 4).map(x => `• ${x.landmark || 'Madrid visual'} — ${x.reason}`).join('\n');
    const response = `🔎 *BÚSQUEDA MANUAL: ${artist}*\n\n🌎 *País:* ${profile.country}\n🎵 *Género:* ${genreMark(profile.genre)}\n🎧 *Oyentes mensuales:* ${listenerText}\n📊 *Umbral ArtistTracker:* ${threshold}\n\n🤖 *Análisis de IA:*\n${profile.summary}\n\n📍 *Madrid:* ${madrid ? '🚨 SÍ, hay evidencia suficiente' : '❌ No pude confirmar presencia/actividad actual con la evidencia encontrada'}\n💡 *Motivo:* ${madridReason}\n\n🎟️ *Eventos encontrados por scraper:*\n${eventText}\n\n${visualText ? `🧠 *Análisis visual:*\n${visualText}\n\n` : '🧠 *Análisis visual:* no hubo una imagen verificable de Madrid; las portadas/artworks no se consideran evidencia de ubicación.\n\n'}🎟️ *Búsqueda de entradas:*\n${ticketLinks.map(x => `• ${x.name}: ${x.url}`).join('\n')}`;
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
  await sock.sendMessage(chat, { text: `🔎 Voy a comprobar manualmente *${clean}* en ArtistTracker. Revisaré país, género, oyentes, ticketing y las fuentes sociales para intentar confirmar actividad actual en Madrid.` });
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
    if (!previous || candidateScore(item) > candidateScore(previous.event || {})) candidates.set(key, { artist: item.artist, event: item, hint: '' });
  }

  for (const country of config.countries) {
    console.log(`\n[🌎] Buscando candidatos sociales de ${country}...`);
    try {
      const discovery = await sources.tiktokSearch(`${country} artista Madrid`);
      if (!discovery) {
        console.log(`[⚠️] Sin respuesta de descubrimiento para ${country}.`);
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
      console.log(`  ├─ 🌎 IA: ${profile.country} (${Math.round(profile.confidence * 100)}% confianza)`);
      const listeners = await verifiedListeners(artist, candidate.discovery || '');
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
      if (typeof sender === 'function') {
        await sender(config.targetJid, { text: msg }, { artist, analysis: { artist, results, eventResult, profile, listeners } });
      } else {
        await sock.sendMessage(config.targetJid, { text: msg });
      }
      console.log(`  └─ 🚨 ${artist}: ¡DETECTADO EN MADRID! Aviso encolado/enviado.`);
      state.artists[fingerprint] = {
        sent: true,
        createdAt: Date.now(),
        artist,
        country: profile.country,
        genre: profile.genre,
        listeners: listeners.monthly,
        event: eventHit,
        folders: results.map(x => x.folder).filter(Boolean)
      };
      state.pending[fingerprint] = { artist, folders: results.map(x => x.folder).filter(Boolean), createdAt: Date.now() };
      await saveState(state);
    } catch (err) {
      console.error(`  └─ ⚠️ ${artist}: error durante comprobación: ${err.message}`);
    }
  }
  console.log('\n[✅] Escaneo terminado. El resultado "0 candidatos" ya no se toma como prueba de que no haya artistas: se registran por separado fallos de descubrimiento.\n');
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
