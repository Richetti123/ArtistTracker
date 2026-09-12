import { sources, text, songstatsStats, zylaMonthlyListeners } from './apis.js';
import { inspectContent } from './analyzer.js';
import { config } from './config.js';
import { loadState, saveState, deleteCase } from './store.js';

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
  const candidates = [data.monthly_listeners, data.monthlyListeners, data.monthly_listeners_change, data.stats?.monthly_listeners, data.stats?.monthlyListeners, data.data?.monthly_listeners, data.data?.stats?.monthly_listeners];
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
    return { country: hint || 'No identificado', genre: 'No identificado', confidence: 0, summary: 'La IA no devolvió un perfil JSON válido.' };
  }
}

async function artistGenre(artist, country) {
  const profile = await artistProfile(artist, country);
  return { genre: profile.genre, confidence: profile.confidence };
}

async function events(artist) {
  return config.ticketSites.map(x => ({ name: x.name, url: x.search.replace('{artist}', encodeURIComponent(artist)) }));
}

function genreMark(genre) {
  const n = norm(genre);
  const preferred = config.preferredGenres.some(g => n.includes(norm(g)));
  return preferred ? `${genre}⭐` : genre;
}

function alertText(a, c, l, genre, h, e) {
  return `🎯 *ARTISTA DETECTADO EN MADRID*\n\n🎤 *${a}*\n🌎 País/escena: ${c}\n🎵 Género: *${genreMark(genre)}*\n🎧 Oyentes mensuales verificados: *${l.monthly.toLocaleString('es-ES')}*\n🔎 Fuente oyentes: ${l.source}\n🤖 IA: ${h.ai?.summary || 'Análisis realizado con la IA de ArtistTracker'}\n📍 ${h.ai?.reason || 'Evidencia de Madrid'}\n📅 ${h.ai?.date || 'No indicada'}\n🎪 ${h.ai?.event || 'No indicado'}${h.ai?.venue ? ` — ${h.ai.venue}` : ''}\n\n🎟️ *Fuentes oficiales de entradas*\n${e.map(x => `• ${x.name}: ${x.url}`).join('\n')}\n\n¿Te interesa este artista? Responde *SÍ* o *NO*.\nSi respondes NO, borraré el material guardado de este aviso, pero el artista NO quedará bloqueado y podrá volver a aparecer si detectamos otra oportunidad en Madrid. Si no respondes, el material se conservará como máximo 7 días.`;
}

async function analyzeArtist(artist, countryHint = '', { save = false, send = false, sock = null, destination = config.targetJid } = {}) {
  console.log(`\n  ┌─ 🔎 COMPROBACIÓN DE ${artist}`);
  const profile = await artistProfile(artist, countryHint);
  console.log(`  ├─ 🌎 País identificado por IA: ${profile.country} (${Math.round(profile.confidence * 100)}% confianza)`);
  console.log(`  ├─ 🎵 Género identificado por IA: ${profile.genre}${config.preferredGenres.some(g => norm(profile.genre).includes(norm(g))) ? ' ⭐' : ''}`);

  const listeners = await verifiedListeners(artist, '');
  if (Number.isFinite(listeners.monthly)) console.log(`  ├─ 🎧 Oyentes: ${listeners.monthly.toLocaleString('es-ES')} (${listeners.source})`);
  else console.log('  ├─ ❌ No se pudieron verificar los oyentes mensuales.');

  const results = [];
  const inputs = [['Instagram', await sources.instagramPosts(artist)], ['TikTok', await sources.tiktokSearch(artist)], ['SoundCloud', await sources.soundcloudSearch(artist)]];
  for (const [network, data] of inputs) {
    if (!data) continue;
    console.log(`  ├─ 📡 Analizando ${network}...`);
    results.push(await inspectContent(artist, network, data));
  }

  const hit = results.find(x => x.directMadrid || (x.ai?.madrid && x.ai?.current && x.ai?.confidence >= 0.75));
  const madrid = Boolean(hit);
  console.log(`  ├─ ${madrid ? '🚨' : '⚪'} Madrid: ${madrid ? 'evidencia suficiente' : 'sin evidencia suficiente'}`);

  const best = hit || results.find(x => x.ai?.madrid) || results[0];
  const madridReason = best?.ai?.reason || (best?.sourceText ? 'Se analizaron las publicaciones encontradas, pero la IA no confirmó una oportunidad actual en Madrid.' : 'No hubo contenido suficiente para verificar Madrid.');
  const event = best?.ai?.event || '';
  const venue = best?.ai?.venue || '';
  const date = best?.ai?.date || '';
  const summary = profile.summary || 'Perfil analizado por la IA de ArtistTracker.';
  const ticketLinks = await events(artist);

  if (send && sock) {
    const listenerText = Number.isFinite(listeners.monthly) ? `${listeners.monthly.toLocaleString('es-ES')} (${listeners.source})` : 'No verificados';
    const threshold = Number.isFinite(listeners.monthly) ? (listeners.monthly >= config.minMonthlyListeners ? '✅ supera el mínimo' : '⚠️ está por debajo del mínimo') : '⚠️ sin verificación';
    const response = `🔎 *BÚSQUEDA MANUAL: ${artist}*\n\n🌎 *País:* ${profile.country}\n🎵 *Género:* ${genreMark(profile.genre)}\n🎧 *Oyentes mensuales:* ${listenerText}\n📊 *Umbral ArtistTracker:* ${threshold}\n\n🤖 *Análisis de IA:*\n${summary}\n\n📍 *Madrid:* ${madrid ? '🚨 SÍ, hay evidencia suficiente' : '❌ No pude confirmar presencia/actividad actual con la evidencia encontrada'}\n${date ? `📅 *Fecha:* ${date}\n` : ''}${event ? `🎪 *Evento:* ${event}${venue ? ` — ${venue}` : ''}\n` : ''}💡 *Motivo:* ${madridReason}\n\n🎟️ *Búsqueda de entradas:*\n${ticketLinks.map(x => `• ${x.name}: ${x.url}`).join('\n')}`;
    await sock.sendMessage(destination, { text: response });
  }

  if (save && state) await saveState(state);
  console.log(`  └─ ${madrid ? '🚨' : '✅'} Comprobación manual terminada.`);
  return { artist, profile, listeners, madrid, hit: best, ticketLinks };
}

export async function manualSearch(sock, artist, destination = config.targetJid) {
  const clean = String(artist || '').trim();
  if (!clean) return false;
  const chat = destination || config.targetJid;
  await sock.sendMessage(chat, { text: `🔎 Voy a comprobar manualmente *${clean}* en ArtistTracker. Revisaré país, género, oyentes y las fuentes sociales para intentar confirmar si existe actividad actual en Madrid.` });
  try {
    await analyzeArtist(clean, '', { send: true, sock, destination: chat });
  } catch (err) {
    console.error('[MANUAL] Error:', err);
    await sock.sendMessage(chat, { text: `❌ No pude completar la búsqueda manual de *${clean}*. Revisa la consola para ver el error.` });
  }
  return true;
}

export async function runScan(sock) {
  const state = await loadState();
  console.log('\n╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮');
  console.log('┃ 🔎 INICIANDO ESCANEO DE ARTISTAS      ┃');
  console.log('╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯');
  for (const country of config.countries) {
    console.log(`\n[🌎] Buscando artistas de ${country}...`);
    const discovery = await sources.tiktokSearch(`${country} artista Madrid`);
    if (!discovery) { console.log(`[⚠️] Sin respuesta de descubrimiento para ${country}.`); continue; }
    const candidates = names(discovery).slice(0, config.scan.maxCandidatesPerCountry);
    console.log(`[📋] ${candidates.length} candidatos encontrados en ${country}.`);
    for (const artist of candidates) {
      const key = norm(artist);
      console.log(`  ├─ 🎤 ${artist}: comprobando identidad y país...`);
      const profile = await artistProfile(artist, country);
      console.log(`  ├─ 🌎 IA: ${profile.country} (${Math.round(profile.confidence * 100)}% confianza)`);
      console.log(`  ├─ 🎧 ${artist}: comprobando oyentes...`);
      const listeners = await verifiedListeners(artist, discovery);
      if (!Number.isFinite(listeners.monthly)) { console.log(`  ├─ ❌ ${artist}: no se pudo verificar oyentes mensuales.`); continue; }
      console.log(`  ├─ 🎧 ${listeners.monthly.toLocaleString('es-ES')} oyentes (${listeners.source})`);
      if (listeners.monthly < config.minMonthlyListeners) { console.log(`  ├─ ⏭️ ${artist}: por debajo de ${config.minMonthlyListeners.toLocaleString('es-ES')}.`); continue; }
      const genreInfo = { genre: profile.genre, confidence: profile.confidence };
      console.log(`  ├─ 🎵 Género: ${genreInfo.genre}${config.preferredGenres.some(g => norm(genreInfo.genre).includes(norm(g))) ? ' ⭐' : ''}`);
      const results = [];
      const inputs = [['Instagram', await sources.instagramPosts(artist)], ['TikTok', await sources.tiktokSearch(artist)], ['SoundCloud', await sources.soundcloudSearch(artist)]];
      for (const [network, data] of inputs) { if (!data) continue; console.log(`  ├─ 📡 Analizando ${network}...`); results.push(await inspectContent(artist, network, data)); }
      const hit = results.find(x => x.directMadrid || (x.ai?.madrid && x.ai?.current && x.ai?.confidence >= 0.75));
      if (!hit) { console.log(`  └─ ⚪ ${artist}: sin evidencia suficiente de Madrid.`); continue; }
      const fingerprint = `${key}:${hit.ai?.date || 'now'}:${hit.ai?.event || ''}:${hit.ai?.venue || ''}`;
      if (state.artists[fingerprint]?.sent) { console.log(`  └─ ♻️ ${artist}: aviso ya enviado.`); continue; }
      const msg = alertText(artist, profile.country, listeners, genreInfo.genre, hit, await events(artist));
      await sock.sendMessage(config.targetJid, { text: msg });
      console.log(`  └─ 🚨 ${artist}: ¡DETECTADO EN MADRID! Aviso enviado a WhatsApp.`);
      state.artists[fingerprint] = { sent: true, createdAt: Date.now(), artist, country: profile.country, genre: genreInfo.genre, listeners: listeners.monthly, folders: results.map(x => x.folder).filter(Boolean) };
      state.pending[fingerprint] = { artist, folders: results.map(x => x.folder).filter(Boolean), createdAt: Date.now() };
      await saveState(state);
    }
  }
  console.log('\n[✅] Escaneo terminado. Próximo escaneo automático según el intervalo configurado.\n');
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
