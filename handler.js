import { answerInterest, manualSearch } from './lib/tracker.js';

export async function handleMessage(sock, msg) {
  if (!msg?.message || msg.key?.fromMe) return;

  const jid = msg.key.remoteJid;
  if (jid !== undefined) {
    const body = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
    const match = body.match(/^(?:!|\/)?(?:buscar|busca|comprobar|comprueba)\s+(?:artista\s+)?(.+)$/i);
    if (match?.[1]) {
      await manualSearch(sock, match[1].trim());
      return;
    }
  }

  await answerInterest(sock, msg);
}
