import { sources, text, songstatsStats, zylaMonthlyListeners } from './apis.js';
import { inspectContent } from './analyzer.js';
import { config } from './config.js';
import { loadState, saveState, deleteCase } from './store.js';
import { discoverMadridArtists, scrapeMadridEvents } from './scrapers.js';
import { resolveArtist, verifyMonthlyListeners, cleanArtistName, artistKey } from './identity.js';

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function names(raw) {
  const s = text(raw);
  const out = new Set();
  for (const re of [/\b(?:artist|artista|name|nombre)\s*[:=-]\s*([^\n,|]+)/ig, /@([a-z0-9._-]{2,})/ig]) {
    for (const m of s.matchAll(re)) {
      const n = cleanArtistName(m[1] || '');
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
  return Number.isFinite(n) ? Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1)) : null;
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
  const match = raw.match(/(?:monthly listeners|oyentes mensuales)[^0-9]{0,100}([0-9][0-9., ]*(?:[KMB])?)/i) || raw.match(/([0-9][0-9., ]*(?:[KMB])?)\s*(?:monthly listeners|oyentes mensuales)/i);
  return match ? parseNumber(match[1]) : null;
}

function extractSongstatsId(raw) {
  const m = text(raw).match(/(?:songstats[_ -]?artist[_ -]?id|songstats artist id)\s*[:=]\s*([a-z0-9_-]+)/i);
  return m?.[1] || null;
}

async function verifiedListeners(artist, rawDiscovery, profile) {
  // Prefer the new identity layer: Spotify -> ChartMasters -> Music Metrics Vault.
  const primary = await verifyMonthlyListeners(artist, profile);
  if (Number.isFinite(primary.monthly)) return primary;

  // Optional key-based providers remain fallbacks; no API key is invented or required.
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

function profileSummary(profile) {
  const parts = [];
  if (profile.country) parts.push(`País de origen/escena identificado: ${profile.country}.`);
  if (profile.genre) parts.push(`Género detectado: ${profile.genre}.`);
  if (profile.aliases?.length) parts.push(`Variantes comprobadas: ${profile.aliases.slice(0, 5).join(', ')}.`);
  if (profile.sources?.length) parts.push(`Fuentes: ${[...new Set(profile.sources)].slice(0, 6).join(', ')}.`);
  return parts.join(' ') || 'No se obtuvo suficiente metadata pública para describir el perfil.';
}

async function artistProfile(rawArtist, hint = '') {
  const resolved = await resolveArtist(rawArtist, hint);
  const country = validCountry(resolved.country) || 'No identificado';
  const genre = cleanGenre(resolved.genre);
  const confidence = Math.min(1, Math.max(0, Number(resolved.confidence) || 0));
  return {
    ...resolved,
    rawArtist: rawArtist,
    country,
    genre,
    confidence,
    summary: profileSummary({ ...resolved, country, genre }),
    source: [...new Set(resolved.sources || [])].join(' + ') || 'Web identity scraper',
    ai: false
  };
}

function genreMark(genre) {
  const n = norm(genre);
  return config.preferredGenres.some(g => n.includes(norm(g))) ? `${genre}⭐` : genre;
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

function alertText(artist, profile, listeners, analysis, eventResult) {
  const event = eventResult?.events?.[0];
  const eventSources = eventResult?.events?.slice(0, 4).map(x => `• ${x.source}: ${formatEvent(x)}${x.url ? `\n  ${x.url}` : ''}`).join('\n') || '• No se obtuvo un evento de ticketing; la evidencia procede de redes.';
  const visual = analysis.imageAnalyses?.filter(x => x.available && !x.isCoverArt && (x.madrid || x.landmark)).slice(0, 2).map(x => `• ${x.landmark || 'Ubicación visual en Madrid'} (${Math.round(Math.max(x.confidence || 0, x.landmarkConfidence || 0) * 100)}%): ${x.reason}`).join('\n');
  return `🎯 *ARTISTA DETECTADO EN MADRID*\n\n🎤 *${artist}*\n🌎 País/escena: ${profile.country}\n🎵 Género: *${genreMark(profile.genre)}*\n🎧 Oyentes mensuales verificados: *${listeners.monthly.toLocaleString('es-ES')}*\n🔎 Fuente oyentes: ${listeners.source}\n🤖 Perfil: ${profile.summary}\n📍 ${analysis.reason || 'Evidencia actual de Madrid'}\n${event ? `📅 *Evento confirmado:* ${formatEvent(event)}\n` : ''}${visual ? `🧠 *Evidencia visual:*\n${visual}\n` : ''}\n🎟️ *Eventos/entradas encontrados:*\n${eventSources}\n\n¿Te interesa este artista? Responde *SÍ* o *NO*.\nSi respondes NO, borraré el material guardado de este aviso, pero el artista NO quedará bloqueado y podrá volver a aparecer si detectamos otra oportunidad en Madrid. Si no respondes, el material se conservará como máximo 7 días.`;
}

async function analyzeArtist(rawArtist, countryHint = '', { send = false, sock = null, destination = config.targetJid } = {}) {
  const raw = String(rawArtist || '').trim();
  console.log(`\n  ┌─ 🎤 ${raw}: identificación primero`);
  const profile = await artistProfile(raw, countryHint);
  const artist = profile.artist || cleanArtistName(raw);
  console.log(`  ├─ 🔤 Nombre canónico: ${artist}`);
  console.log(`  ├─ 🌎 País: ${profile.country} (${Math.round(profile.confidence * 100)}% · ${profile.source})`);
  console.log(`  ├─ 🎵 Género: ${profile.genre}${config.preferredGenres.some(g => norm(profile.genre).includes(norm(g))) ? ' ⭐' : ''}`);
  if (profile.aliases?.length) console.log(`  ├─ 🔁 Variantes: ${profile.aliases.join(' | ')}`);

  const listeners = await verifiedListeners(artist, '', profile);
  if (Number.isFinite(listeners.monthly)) console.log(`  ├─ 🎧 Oyentes: ${listeners.monthly.toLocaleString('es-ES')} (${listeners.source})`);
  else console.log('  ├─ ❌ No se pudieron verificar los oyentes mensuales por fuentes públicas.');

  const eventResult = await events(artist);
  console.log(`  ├─ 🎟️ Scraper de eventos: ${eventResult.events.length} coincidencia(s) en Madrid.`);
  for (const event of eventResult.events.slice(0, 5)) console.log(`  │  ├─ ${event.source}: ${formatEvent(event)}`);

  const results = await socialResults(artist);
  const socialHit = hasCurrentSocialHit(results);
  const eventHit = eventResult.events[0] || null;
  const madrid = Boolean(eventHit || socialHit);
  console.log(`  ├─ ${madrid ? '🚨' : '⚪'} Madrid: ${madrid ? 'evidencia suficiente' : 'sin evidencia suficiente'}`);

  const best = socialHit || results.find(x => x.ai?.madrid) || results[0];
  const reason = eventHit
    ? `Evento de Madrid confirmado por ${eventHit.source}${eventHit.url ? `: ${eventHit.url}` : ''}.`
    : best?.ai?.reason || best?.imageAnalyses?.find(x => x.madrid)?.reason || 'No hubo evidencia actual suficiente para confirmar Madrid.';

  if (send && sock) {
    const listenerText = Number.isFinite(listeners.monthly) ? `${listeners.monthly.toLocaleString('es-ES')} (${listeners.source})` : 'No verificados';
    const threshold = Number.isFinite(listeners.monthly) ? (listeners.monthly >= config.minMonthlyListeners ? `✅ supera el mínimo (${config.minMonthlyListeners.toLocaleString('es-ES')})` : `⚠️ está por debajo del mínimo (${config.minMonthlyListeners.toLocaleString('es-ES')})`) : `⚠️ sin verificación (mínimo ${config.minMonthlyListeners.toLocaleString('es-ES')})`;
    const eventText = eventResult.events.length ? eventResult.events.slice(0, 5).map(formatEvent).join('\n') : 'No se encontró un evento de Madrid en los scrapers de ticketing.';
    const visualText = results.flatMap(x => x.imageAnalyses || []).filter(x => x.available && !x.isCoverArt && (x.madrid || x.landmark)).slice(0, 4).map(x => `• ${x.landmark || 'Madrid visual'} — ${x.reason}`).join('\n');
    const response = `🔎 *BÚSQUEDA MANUAL: ${artist}*\n\n📝 *Nombre buscado:* ${raw}\n🌎 *País:* ${profile.country}\n🎵 *Género:* ${genreMark(profile.genre)}\n🎧 *Oyentes mensuales:* ${listenerText}\n📊 *Umbral ArtistTracker:* ${threshold}\n🔎 *Fuentes de identidad:* ${profile.source}\n${profile.aliases?.length ? `🔁 *Variantes comprobadas:* ${profile.aliases.join(', ')}\n` : ''}\n🤖 *Perfil:*\n${profile.summary}\n\n📍 *Madrid:* ${madrid ? '🚨 SÍ, hay evidencia suficiente' : '❌ No pude confirmar presencia/actividad actual con la evidencia encontrada'}\n💡 *Motivo:* ${reason}\n\n🎟️ *Eventos encontrados por scraper:*\n${eventText}\n\n${visualText ? `🧠 *Análisis visual:*\n${visualText}\n\n` : '🧠 *Análisis visual:* no hubo una imagen verificable de Madrid; las portadas/artworks no se consideran evidencia de ubicación.\n\n'}🎟️ *Búsqueda de entradas:*\n${eventResult.links.map(x => `• ${x.name}: ${x.url}`).join('\n')}`;
    sock.__artistTrackerLastAnalysis = { artist, rawArtist: raw, results, eventResult, profile, listeners };
    await sock.sendMessage(destination, { text: response });
    sock.__artistTrackerLastAnalysis = null;
  }
  console.log(`  └─ ${madrid ? '🚨' : '✅'} Comprobación manual terminada.`);
  return { artist, rawArtist: raw, profile, listeners, madrid, hit: best, eventResult, results, ticketLinks: eventResult.links };
}

export async function manualSearch(sock, artist, destination = config.targetJid) {
  const clean = cleanArtistName(artist);
  if (!clean) return false;
  const chat = destination || config.targetJid;
  await sock.sendMessage(chat, { text: `🔎 Voy a comprobar *${clean}*. Primero identificaré el artista por nombre y variantes, lo clasificaré por país y después verificaré Spotify/ChartMasters/Music Metrics Vault, eventos y redes.` });
  try { await analyzeArtist(clean, '', { send: true, sock, destination: chat }); }
  catch (err) { console.error('[MANUAL] Error:', err); await sock.sendMessage(chat, { text: `❌ No pude completar la búsqueda manual de *${clean}*. Revisa la consola.` }); }
  return true;
}

function candidateScore(candidate) { return Number(candidate?.confidence || 0) + (candidate?.source?.includes('Ticketmaster') ? 0.2 : 0); }

async function automaticCandidates() {
  const candidates = new Map();
  const eventCandidates = await discoverMadridArtists();
  console.log(`[EVENTS] Descubrimiento web: ${eventCandidates.length} candidatos.`);
  for (const item of eventCandidates) {
    const artist = cleanArtistName(item.artist);
    if (!artist || artist === '-->' || artist.length < 2) continue;
    const k = artistKey(artist);
    const previous = candidates.get(k);
    if (!previous || candidateScore(item) > candidateScore(previous.event)) candidates.set(k, { artist, event: item, hint: '', discovery: item });
  }

  for (const country of config.countries) {
    console.log(`\n[🌎] Buscando candidatos sociales de ${country}...`);
    try {
      const discovery = await sources.tiktokSearch(`${country} artista Madrid`);
      if (!discovery) { console.log(`[⚠️] Sin respuesta de descubrimiento para ${country}; se conserva la búsqueda web.`); continue; }
      const found = names(discovery).slice(0, config.scan.maxCandidatesPerCountry);
      console.log(`[📋] ${found.length} candidatos sociales encontrados en ${country}.`);
      for (const artist of found) {
        const k = artistKey(artist);
        if (!candidates.has(k)) candidates.set(k, { artist, event: null, hint: country, discovery });
      }
    } catch (err) { console.error(`[DISCOVERY] ${country}: ${err.message}`); }
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
  for (const candidate of candidates) {
    try {
      const rawArtist = candidate.artist;
      console.log(`\n  ┌─ 🎤 ${rawArtist}: identificación + comprobación completa`);
      const profile = await artistProfile(rawArtist, candidate.hint || '');
      const artist = profile.artist || cleanArtistName(rawArtist);
      console.log(`  ├─ 🔤 Nombre canónico: ${artist}`);
      console.log(`  ├─ 🌎 País: ${profile.country} (${Math.round(profile.confidence * 100)}% · ${profile.source})`);
      console.log(`  ├─ 🎵 Género: ${profile.genre}`);
      if (profile.aliases?.length) console.log(`  ├─ 🔁 Homónimos/variantes comprobados: ${profile.aliases.join(' | ')}`);

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
      if (!hit) { console.log(`  └─ ⚪ ${artist}: sin evidencia actual de Madrid.`); continue; }

      const fingerprint = `${artistKey(artist)}:${eventHit?.date || socialHit?.ai?.date || 'now'}:${eventHit?.venue || socialHit?.ai?.event || ''}:${eventHit?.source || socialHit?.network || ''}`;
      if (state.artists[fingerprint]?.sent) { console.log(`  └─ ♻️ ${artist}: aviso ya enviado.`); continue; }

      const messageHit = socialHit || { ai: { reason: eventHit.reason, event: eventHit.event, venue: eventHit.venue, date: eventHit.date } };
      const analysis = { ...messageHit, imageAnalyses: results.flatMap(x => x.imageAnalyses || []), reason: eventHit ? `Evento confirmado por ${eventHit.source}.` : messageHit.ai?.reason || '', ai: { ...(messageHit.ai || {}), summary: profile.summary } };
      const msg = alertText(artist, profile, listeners, analysis, eventResult);
      const sender = sock.__artistTrackerSendAutoMessage;
      if (typeof sender === 'function') await sender(config.targetJid, { text: msg }, { artist, analysis: { artist, results, eventResult, profile, listeners } });
      else await sock.sendMessage(config.targetJid, { text: msg });

      console.log(`  └─ 🚨 ${artist}: ¡DETECTADO EN MADRID! Aviso encolado/enviado.`);
      state.artists[fingerprint] = { sent: true, createdAt: Date.now(), artist, rawArtist, country: profile.country, genre: profile.genre, listeners: listeners.monthly, event: eventHit, folders: results.map(x => x.folder).filter(Boolean) };
      state.pending[fingerprint] = { artist, folders: results.map(x => x.folder).filter(Boolean), createdAt: Date.now() };
      await saveState(state);
    } catch (err) { console.error(`  └─ ⚠️ ${candidate.artist}: error durante comprobación: ${err.message}`); }
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
    delete state.pending[key]; await saveState(state);
    await sock.sendMessage(jid, { text: `🗑️ Entendido. He eliminado el material multimedia de ${item.artist} de este aviso. No lo he añadido a ninguna blacklist: si volvemos a detectar una oportunidad relevante en Madrid, podrá aparecer de nuevo.` });
  } else {
    state.artists[key] = { ...(state.artists[key] || {}), interested: true, lastResponse: 'yes', lastResponseAt: Date.now(), interestedAt: Date.now() };
    delete state.pending[key]; await saveState(state);
    await sock.sendMessage(jid, { text: `⭐ Perfecto. Guardaré el seguimiento de ${item.artist} y seguiré buscando nuevas oportunidades en Madrid.` });
  }
  return true;
}
