import { sources, text, urls } from './apis.js';
import { saveRemote } from './store.js';
import { config } from './config.js';

function mediaType(url) {
  if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) return 'image';
  if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)) return 'video';
  return null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function relevantVisuals(context) {
  const out = [];
  for (const result of context?.results || []) {
    for (const item of result.imageAnalyses || []) {
      if (!item.available || item.isCoverArt) continue;
      if (!(item.madrid || item.landmark || item.currentClue)) continue;
      out.push({ ...item, network: result.network });
    }
  }
  return unique(out.map(x => x.path)).map(path => out.find(x => x.path === path)).slice(0, 2);
}

export async function sendArtistEvidence(sock, artist, rawSendMessage, destination = config.targetJid, context = null, sendOverride = null) {
  const clean = String(artist || '').trim();
  if (!clean) return;
  const chat = destination || config.targetJid;
  const send = sendOverride || rawSendMessage;

  console.log(`\n  ├─ 📎 Buscando evidencia y redes para ${clean}...`);
  const sourcesFound = [];
  const instagram = [];
  const media = [];
  const visual = relevantVisuals(context);

  const inputs = [
    ['Instagram', () => sources.instagramPosts(clean)],
    ['TikTok', () => sources.tiktokSearch(clean)],
    ['SoundCloud', () => sources.soundcloudSearch(clean)]
  ];

  for (const [network, fn] of inputs) {
    try {
      console.log(`  │  ├─ 🔗 Buscando enlaces en ${network}...`);
      const data = await fn();
      if (!data) continue;
      const found = unique(urls(data));
      for (const url of found) {
        if (/instagram\.com/i.test(url)) instagram.push(url);
        if (/instagram|tiktok|soundcloud/i.test(url)) sourcesFound.push({ network, url });
        const type = mediaType(url);
        if (type) media.push({ network, url, type });
      }
    } catch (err) {
      console.error(`  │  └─ ⚠️ ${network}: ${err.message}`);
    }
  }

  const instagramLinks = unique(instagram).slice(0, 2);
  const sourceLinks = unique(sourcesFound.map(x => x.url)).slice(0, 3);
  const lines = [
    `📎 *EVIDENCIA Y REDES: ${clean}*`,
    '',
    `📸 *Instagram:* ${instagramLinks.length ? instagramLinks.join('\n') : 'No se encontró un enlace de Instagram en las fuentes consultadas.'}`,
    '',
    `🔎 *Fuentes sociales:* ${sourceLinks.length ? sourceLinks.join('\n') : 'No se encontró un enlace directo a la publicación/fuente.'}`,
    '',
    visual.length
      ? `🧠 *Visión IA:* ${visual.map(x => `${x.landmark || 'posible ubicación en Madrid'} (${Math.round(Math.max(x.confidence || 0, x.landmarkConfidence || 0) * 100)}%)`).join(', ')}`
      : '🧠 *Visión IA:* no se detectó una imagen que fuera evidencia geográfica fiable; las portadas de canciones/álbumes no se adjuntan como prueba.'
  ];

  await send(chat, { text: lines.join('\n') });
  console.log(`  │  ├─ 📸 Instagram: ${instagramLinks.length ? 'encontrado' : 'no encontrado'}`);
  console.log(`  │  ├─ 🔎 Fuentes: ${sourceLinks.length}`);

  let attached = 0;
  for (const item of visual) {
    if (attached >= 2) break;
    try {
      await send(chat, {
        image: { url: item.path },
        caption: `🧠 Evidencia visual analizada por IA para ${clean}.\n${item.landmark ? `Lugar/monumento: ${item.landmark}.\n` : ''}${item.reason || 'La imagen contiene indicios geográficos relevantes.'}`
      });
      attached++;
      console.log(`  │  ├─ 📎 Evidencia visual relevante adjuntada desde ${item.network || 'red social'}.`);
    } catch (err) {
      console.error(`  │  └─ ⚠️ No se pudo adjuntar evidencia visual: ${err.message}`);
    }
  }

  if (!visual.length) {
    const fallbackMedia = context ? [] : media.filter(x => x.type === 'video');
    for (const item of fallbackMedia.slice(0, 1)) {
      try {
        const folder = `evidence-${clean.toLowerCase().replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}`;
        const localPath = await saveRemote(item.url, folder, `evidence-video-${Date.now()}.mp4`);
        if (!localPath) continue;
        await send(chat, { video: { url: localPath }, caption: `📎 Vídeo encontrado en ${item.network} para ${clean}.` });
        attached++;
      } catch (err) {
        console.error(`  │  └─ ⚠️ No se pudo adjuntar vídeo: ${err.message}`);
      }
    }
  }

  console.log(`  └─ 📎 Evidencia terminada: ${attached} archivo(s) adjuntado(s).`);
}

export async function sendTestMessage(sock, rawSendMessage, destination = config.targetJid) {
  const chat = destination || config.targetJid;
  console.log('\n╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮');
  console.log('┃ 🧪 PRUEBA DE ENVÍO DE ARTISTTRACKER        ┃');
  console.log('╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯');
  console.log(`[TEST] Enviando mensaje simulado a ${chat}...`);

  const testText = `🔎 *BÚSQUEDA MANUAL: estoesunaprueba*\n\n🌎 *País:* España\n🎵 *Género:* Reggaeton⭐\n🎧 *Oyentes mensuales:* 1.000.000.000.000 (Zyla / Spotify monthly listeners)\n📊 *Umbral ArtistTracker:* ✅ supera el mínimo\n\n🤖 *Análisis de IA:*\nArtista español asociado principalmente al reggaeton y otros estilos urbanos latinoamericanos.\n\n📍 *Madrid:* 🚨 SÍ, hay evidencia suficiente\n📅 *Fecha:* ...\n🎪 *Evento:* ... — ...\n💡 *Motivo:* La publicación analizada contiene información que apunta a una actividad actual del artista en Madrid.\n\n📸 *Instagram:* https://www.instagram.com/estoesunaprueba/\n🔎 *Fuente:* https://www.instagram.com/estoesunaprueba/p/prueba/\n🖼️ *Evidencia:* Esta es una prueba simulada; no corresponde a una publicación real.`;

  await rawSendMessage(chat, { text: testText });
  console.log('[TEST] ✅ Mensaje de prueba enviado correctamente por sendMessage.');
  console.log('[TEST] ℹ️ La prueba usa datos inventados y NO activa una búsqueda real.');
  return true;
}
