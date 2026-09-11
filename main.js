import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import P from 'pino';
import { existsSync, mkdirSync } from 'node:fs';
import { config } from './lib/config.js';
import { handleMessage } from './handler.js';
import { runScan } from './lib/tracker.js';
import { purgeExpiredMedia } from './lib/store.js';

async function start() {
  mkdirSync(config.paths.sessions, { recursive: true });
  mkdirSync(config.paths.data, { recursive: true });
  mkdirSync(config.paths.media, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.paths.sessions);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ auth: state, version, logger: P({ level: 'silent' }), browser: ['ArtistTracker', 'Chrome', '1.0'], markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log('\nEscanea el QR desde WhatsApp > Dispositivos vinculados.\n');
    if (connection === 'open') {
      console.log('ArtistTracker conectado.');
      if (!global.artistScanTimer) {
        await runScan(sock);
        global.artistScanTimer = setInterval(() => runScan(sock).catch(console.error), config.scan.intervalMs);
        global.cleanupTimer = setInterval(() => purgeExpiredMedia(), 60 * 60 * 1000);
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 5000);
      else console.error('Sesión cerrada: elimina sessions/ y vuelve a vincular.');
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try { await handleMessage(sock, msg); } catch (err) { console.error('message:', err); }
    }
  });
}
start().catch(console.error);
