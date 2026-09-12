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

export async function sendArtistEvidence(sock, artist, rawSendMessage, destination = config.targetJid) {
  const clean = String(artist || '').trim();
  if (!clean) return;
  const chat = destination || config.targetJid;

  console.log(`\n  ├─ 📎 Buscando evidencia y redes para ${clean}...`);
  const sourcesFound = [];
  const instagram = [];
  const media = [];

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
  const mediaCandidates = media.slice(0, 3);

  const lines = [
    `📎 *EVIDENCIA Y REDES: ${clean}*`,
    '',
    `📸 *Instagram:* ${instagramLinks.length ? instagramLinks.join('\n') : 'No se encontró un enlace de Instagram en las fuentes consultadas.'}`,
    '',
    `🔎 *Fuente donde se encontró información:* ${sourceLinks.length ? sourceLinks.join('\n') : 'No se encontró un enlace directo a la publicación/fuente.'}`,
    '',
    `🖼️ *Evidencia multimedia:* ${mediaCandidates.length ? 'intentando adjuntar la publicación multimedia encontrada...' : 'No se encontró un archivo multimedia directo que pueda adjuntarse.'}`
  ];

  await rawSendMessage(chat, { text: lines.join('\n') });
  console.log(`  │  ├─ 📸 Instagram: ${instagramLinks.length ? 'encontrado' : 'no encontrado'}`);
  console.log(`  │  ├─ 🔎 Fuentes: ${sourceLinks.length}`);

  let attached = 0;
  for (const item of mediaCandidates) {
    if (attached >= 2) break;
    try {
      const folder = `evidence-${clean.toLowerCase().replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}`;
      const localPath = await saveRemote(item.url, folder, `evidence-${attached + 1}${item.type === 'image' ? '.jpg' : '.mp4'}`);
      if (!localPath) continue;
      const payload = item.type === 'image'
        ? { image: { url: localPath }, caption: `📎 Evidencia encontrada en ${item.network} para ${clean}.` }
        : { video: { url: localPath }, caption: `📎 Evidencia encontrada en ${item.network} para ${clean}.` };
      await rawSendMessage(chat, payload);
      attached++;
      console.log(`  │  ├─ 📎 Evidencia adjuntada (${item.type}) desde ${item.network}.`);
    } catch (err) {
      console.error(`  │  └─ ⚠️ No se pudo adjuntar evidencia: ${err.message}`);
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
