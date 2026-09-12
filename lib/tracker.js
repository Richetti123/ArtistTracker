import { sources, text } from './apis.js';
import { inspectContent } from './analyzer.js';
import { config } from './config.js';
import { loadState, saveState, deleteCase } from './store.js';
import { discoverMadridArtists, scrapeMadridEvents } from './scrapers.js';
import { resolveArtist, verifyMonthlyListeners, cleanArtistName, artistKey } from './identity.js';

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function names(raw) {
  const out = new Set();
  for (const re of [/\b(?:artist|artista|name|nombre)\s*[:=-]\s*([^\n,|]+)/ig, /@([a-z0-9._-]{2,})/ig]) {
    for (const m of text(raw).matchAll(re)) {
      const n = cleanArtistName(m[1] || '');
      if (n.length > 1 && !/madrid|españa|mexico|peru|colombia|chile|argentina|venezuela|bolivia|ecuador|puerto|dominicana|paraguay|uruguay/i.test(n)) out.add(n);
    }
  }
  return [...out];
}

function genreMark(genre) {
  const s = String(genre || 'No identificado').trim() || 'No identificado';
  return config.preferredGenres.some(g => norm(s).includes(norm(g))) ? `${s}⭐` : s;
}

function profileSummary(profile) {
  const parts = [];
  if (profile.country && profile.country !== 'No identificado') parts.push(`País de origen/escena identificado: ${profile.country}.`);
  if (profile.genre && profile.genre !== 'No identificado') parts.push(`Género detectado: ${profile.genre}.`);
  if (profile.aliases?.length) parts.push(`Variantes comprobadas: ${profile.aliases.slice(0, 5).join(', ')}.`);
  if (profile.sources?.length) parts.push(`Fuentes: ${[...new Set(profile.sources)].slice(0, 6).join(', ')}.`);
  return parts.join(' ') || 'No se obtuvo suficiente metadata pública para describir el perfil.';
}

async function artistProfile(rawArtist, hint = '') {
  const resolved = await resolveArtist(rawArtist, hint);
  const country = resolved.country || 'No identificado';
  const genre = resolved.genre || 'No identificado';
  return { ...resolved, rawArtist, country, genre, confidence: Math.min(1, Math.max(0, Number(resolved.confidence) || 0)), summary: profileSummary({ ...resolved, country, genre }), source: [...new Set(resolved.sources || [])].join(' + ') || 'Web identity scraper' };
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
  for (const [network, fn] of [['Instagram', () => sources.instagramPosts(artist)], ['TikTok', () => sources.tiktokSearch(artist)], ['SoundCloud', () => sources.soundcloudSearch(artist)]]) {
    try {
      const data = await fn();
      if (!data) { console.log(`  ├─ ⚠️ ${network}: sin respuesta`); continue; }
      console.log(`  ├─ 📡 Analizando ${network}...`);
      results.push(await inspectContent(artist, network, data));
    } catch (err) { console.error(`  ├─ ⚠️ ${network}: ${err.message}`); }
  }
  return results;
}

function manualText(artist, raw, profile, listeners, madrid, reason, eventResult, results) {
  const listenerText = Number.isFinite(listeners.monthly) ? `${listeners.monthly.toLocaleString('es-ES')} (${listeners.source})` : 'No verificados';
  const threshold = Number.isFinite(listeners.monthly) ? (listeners.monthly >= config.minMonthlyListeners ? `✅ supera el mínimo (${config.minMonthlyListeners.toLocaleString('es-ES')})` : `⚠️ está por debajo del mínimo (${config.minMonthlyListeners.toLocaleString('es-ES')})`) : `⚠️ sin verificación (mínimo ${config.minMonthlyListeners.toLocaleString('es-ES')})`;
  const eventText = eventResult.events.length ? eventResult.events.slice(0, 5).map(formatEvent).join('\n') : 'No se encontró un evento de Madrid en los scrapers de ticketing.';
  const visualText = results.flatMap(x => x.imageAnalyses || []).filter(x => x.available && !x.isCoverArt && (x.madrid || x.landmark)).slice(0, 4).map(x => `• ${x.landmark || 'Madrid visual'} — ${x.reason}`).join('\n');
  return `🔎 *BÚSQUEDA MANUAL: ${artist}*\n\n📝 *Nombre buscado:* ${raw}\n🌎 *País:* ${profile.country}\n🎵 *Género:* ${genreMark(profile.genre)}\n🎧 *Oyentes mensuales:* ${listenerText}\n📊 *Umbral ArtistTracker:* ${threshold}\n🔎 *Fuentes de identidad:* ${profile.source}\n${profile.aliases?.length ? `🔁 *Variantes comprobadas:* ${profile.aliases.join(', ')}\n` : ''}\n🤖 *Perfil:*\n${profile.summary}\n\n📍 *Madrid:* ${madrid ? '🚨 SÍ, hay evidencia suficiente' : '❌ No pude confirmar presencia/actividad actual con la evidencia encontrada'}\n💡 *Motivo:* ${reason}\n\n🎟️ *Eventos encontrados por scraper:*\n${eventText}\n\n${visualText ? `🧠 *Análisis visual:*\n${visualText}\n\n` : '🧠 *Análisis visual:* no hubo una imagen verificable de Madrid; las portadas/artworks no se consideran evidencia de ubicación.\n\n'}🎟️ *Búsqueda de entradas:*\n${eventResult.links.map(x => `• ${x.name}: ${x.url}`).join('\n')}`;
}

async function sendCombined(sock, destination, message, imageUrl = '') {
  if (imageUrl) {
    try {
      await sock.sendMessage(destination, { image: { url: imageUrl }, caption: message });
      console.log('  ├─ 🖼️ Foto de perfil + texto enviados en UN solo mensaje.');
      return;
    } catch (err) { console.error(`  ├─ ⚠️ Falló imagen+texto, se envía texto: ${err.message}`); }
  }
  await sock.sendMessage(destination, { text: message });
}

async function analyzeArtist(rawArtist, countryHint = '', { send = false, sock = null, destination = config.targetJid } = {}) {
  const raw = String(rawArtist || '').trim();
  console.log(`\n  ┌─ 🎤 ${raw}: identificación primero`);
  const profile = await artistProfile(raw, countryHint);
  const artist = profile.artist || cleanArtistName(raw);
  console.log(`  ├─ 🔤 Nombre canónico: ${artist}`);
  console.log(`  ├─ 🌎 País: ${profile.country} (${Math.round(profile.confidence * 100)}% · ${profile.source})`);
  console.log(`  ├─ 🎵 Género: ${profile.genre}${config.preferredGenres.some(g => norm(profile.genre).includes(norm(g))) ? ' ⭐' : ''}`);
  const listeners = await verifyMonthlyListeners(artist, profile);
  if (Number.isFinite(listeners.monthly)) console.log(`  ├─ 🎧 Oyentes: ${listeners.monthly.toLocaleString('es-ES')} (${listeners.source})`);
  else console.log('  ├─ ❌ Spotify → Songstats → artist.tools: sin verificación.');

  const eventResult = await events(artist);
  console.log(`  ├─ 🎟️ Scraper de eventos: ${eventResult.events.length} coincidencia(s) en Madrid.`);
  const results = await socialResults(artist);
  const socialHit = hasCurrentSocialHit(results);
  const eventHit = eventResult.events[0] || null;
  const madrid = Boolean(eventHit || socialHit);
  const best = socialHit || results.find(x => x.ai?.madrid) || results[0];
  const reason = eventHit ? `Evento de Madrid confirmado por ${eventHit.source}${eventHit.url ? `: ${eventHit.url}` : ''}.` : best?.ai?.reason || best?.imageAnalyses?.find(x => x.madrid)?.reason || 'No hubo evidencia actual suficiente para confirmar Madrid.';
  console.log(`  ├─ ${madrid ? '🚨' : '⚪'} Madrid: ${madrid ? 'evidencia suficiente' : 'sin evidencia suficiente'}`);

  if (send && sock) {
    const response = manualText(artist, raw, profile, listeners, madrid, reason, eventResult, results);
    sock.__artistTrackerLastAnalysis = { artist, rawArtist: raw, results, eventResult, profile, listeners };
    await sendCombined(sock, destination, response, listeners.imageUrl || profile.imageUrl || '');
    sock.__artistTrackerLastAnalysis = null;
  }
  return { artist, rawArtist: raw, profile, listeners, madrid, hit: best, eventResult, results, ticketLinks: eventResult.links };
}

export async function manualSearch(sock, artist, destination = config.targetJid) {
  const clean = cleanArtistName(artist);
  if (!clean) return false;
  const chat = destination || config.targetJid;
  await sock.sendMessage(chat, { text: `🔎 Voy a comprobar *${clean}*. Identidad → Spotify → Songstats → artist.tools → país/género → eventos → Madrid.` });
  try { await analyzeArtist(clean, '', { send: true, sock, destination: chat }); }
  catch (err) { console.error('[MANUAL] Error:', err); await sock.sendMessage(chat, { text: `❌ No pude completar la búsqueda manual de *${clean}*. Revisa la consola.` }); }
  return true;
}

async function automaticCandidates() {
  const candidates = new Map();
  const eventCandidates = await discoverMadridArtists();
  console.log(`[EVENTS] Descubrimiento web: ${eventCandidates.length} candidatos.`);
  for (const item of eventCandidates) {
    const artist = cleanArtistName(item.artist);
    if (!artist || artist === '-->' || artist.length < 2) continue;
    const k = artistKey(artist);
    if (!candidates.has(k)) candidates.set(k, { artist, event: item, hint: '', discovery: item });
  }
  for (const country of config.countries) {
    console.log(`\n[🌎] Buscando candidatos sociales de ${country}...`);
    try {
      const discovery = await sources.tiktokSearch(`${country} artista Madrid`);
      if (!discovery) { console.log(`[⚠️] Sin respuesta para ${country}; se conserva la búsqueda web.`); continue; }
      for (const artist of names(discovery).slice(0, config.scan.maxCandidatesPerCountry)) {
        const k = artistKey(artist);
        if (!candidates.has(k)) candidates.set(k, { artist, event: null, hint: country, discovery });
      }
    } catch (err) { console.error(`[DISCOVERY] ${country}: ${err.message}`); }
  }
  return [...candidates.values()].slice(0, config.scan.maxMadridEventCandidates);
}

export async function runScan(sock) {
  const state = await loadState();
  console.log('\n╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n┃ 🔎 INICIANDO ESCANEO DE ARTISTAS      ┃\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯');
  const candidates = await automaticCandidates();
  console.log(`[SCAN] Candidatos totales a verificar: ${candidates.length}.`);
  for (const candidate of candidates) {
    try {
      const profile = await artistProfile(candidate.artist, candidate.hint || '');
      const artist = profile.artist || cleanArtistName(candidate.artist);
      console.log(`\n  ┌─ 🎤 ${candidate.artist} → ${artist}`);
      console.log(`  ├─ 🌎 ${profile.country} · ${profile.source}`);
      console.log(`  ├─ 🎵 ${profile.genre}`);
      const listeners = await verifyMonthlyListeners(artist, profile);
      if (!Number.isFinite(listeners.monthly)) { console.log(`  ├─ ⏭️ ${artist}: sin oyentes verificados; no alerta.`); continue; }
      console.log(`  ├─ 🎧 ${listeners.monthly.toLocaleString('es-ES')} (${listeners.source})`);
      if (listeners.monthly < config.minMonthlyListeners) { console.log(`  ├─ ⏭️ ${artist}: por debajo de ${config.minMonthlyListeners.toLocaleString('es-ES')}.`); continue; }
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
      const msg = `🎯 *ARTISTA DETECTADO EN MADRID*\n\n🎤 *${artist}*\n🌎 País/escena: ${profile.country}\n🎵 Género: *${genreMark(profile.genre)}*\n🎧 Oyentes mensuales verificados: *${listeners.monthly.toLocaleString('es-ES')}*\n🔎 Fuente oyentes: ${listeners.source}\n🤖 Perfil: ${profile.summary}\n📍 ${analysis.reason}\n\n🎟️ *Eventos/entradas encontrados:*\n${eventResult.events.slice(0,4).map(formatEvent).join('\n') || 'No se encontró un evento de Madrid en los scrapers de ticketing.'}`;
      const payload = listeners.imageUrl || profile.imageUrl ? { image: { url: listeners.imageUrl || profile.imageUrl }, caption: msg } : { text: msg };
      const sender = sock.__artistTrackerSendAutoMessage;
      if (typeof sender === 'function') await sender(config.targetJid, payload, { artist, analysis: { artist, results, eventResult, profile, listeners } });
      else await sock.sendMessage(config.targetJid, payload);
      state.artists[fingerprint] = { sent:true, createdAt:Date.now(), artist, rawArtist:candidate.artist, country:profile.country, genre:profile.genre, listeners:listeners.monthly, event:eventHit, folders:results.map(x=>x.folder).filter(Boolean) };
      state.pending[fingerprint] = { artist, folders:results.map(x=>x.folder).filter(Boolean), createdAt:Date.now() };
      await saveState(state);
      console.log(`  └─ 🚨 ${artist}: alerta enviado con foto+texto cuando hubo imagen.`);
    } catch (err) { console.error(`  └─ ⚠️ ${candidate.artist}: ${err.message}`); }
  }
  console.log('[SCAN] ✅ Escaneo terminado.');
}

export async function answerInterest(sock, msg) {
  const jid = msg.key.remoteJid;
  if (jid !== config.targetJid) return false;
  const body = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim().toLowerCase();
  if (!/^(si|sí|no|s|n)$/.test(body)) return false;
  const state = await loadState();
  const pending = Object.entries(state.pending).sort((a,b)=>b[1].createdAt-a[1].createdAt)[0];
  if (!pending) return false;
  const [caseKey, item] = pending;
  if (/^(no|n)$/.test(body)) {
    for (const folder of item.folders || []) await deleteCase(folder);
    state.artists[caseKey] = { ...(state.artists[caseKey] || {}), lastResponse:'no', rejectedAt:Date.now() };
    delete state.pending[caseKey]; await saveState(state);
    await sock.sendMessage(jid, { text:`🗑️ Entendido. He eliminado el material multimedia de ${item.artist}. No hay blacklist permanente.` });
  } else {
    state.artists[caseKey] = { ...(state.artists[caseKey] || {}), interested:true, lastResponse:'yes', lastResponseAt:Date.now(), interestedAt:Date.now() };
    delete state.pending[caseKey]; await saveState(state);
    await sock.sendMessage(jid, { text:`⭐ Perfecto. Guardaré el seguimiento de ${item.artist} y seguiré buscando nuevas oportunidades en Madrid.` });
  }
  return true;
}
