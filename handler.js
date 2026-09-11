import { answerInterest, manualSearch } from './lib/tracker.js';
import { sendTestMessage } from './lib/evidence.js';
import { config } from './lib/config.js';

function senderMatchesTarget(msg) {
  const candidates = [msg?.key?.remoteJid, msg?.key?.remoteJidAlt, msg?.key?.participant, msg?.key?.participantAlt].filter(Boolean);
  return candidates.includes(config.targetJid);
}

export async function handleMessage(sock, msg) {
  if (!msg?.message || msg.key?.fromMe) return;

  const authorized = senderMatchesTarget(msg);
  const jid = msg.key.remoteJid;
  const alt = msg.key.remoteJidAlt;
  const body = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '').trim();

  console.log(`[MESSAGE] jid=${jid}${alt ? ` alt=${alt}` : ''} autorizado=${authorized ? 'SI' : 'NO'} texto="${body}"`);

  if (authorized) {
    const test = body.match(/^(?:!|\/)?(?:test|prueba)(?:\s+(?:mensaje|envio|envío))?$/i);
    if (test) {
      console.log('[MESSAGE] 🧪 Comando de prueba detectado.');
      const rawSend = sock.sendMessage.bind(sock);
      await sendTestMessage(sock, rawSend);
      return;
    }

    const match = body.match(/^(?:!|\/)?(?:buscar|busca|comprobar|comprueba)\s+(?:artista\s+)?(.+)$/i);
    if (match?.[1]) {
      console.log(`[MESSAGE] 🔎 Búsqueda manual solicitada: ${match[1].trim()}`);
      await manualSearch(sock, match[1].trim());
      return;
    }
  }

  const normalizedMessage = authorized
    ? { ...msg, key: { ...msg.key, remoteJid: config.targetJid } }
    : msg;
  await answerInterest(sock, normalizedMessage);
}
