import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import chalk from 'chalk';
import { mkdirSync } from 'node:fs';
import { config } from './lib/config.js';
import { handleMessage } from './handler.js';
import { runScan } from './lib/tracker.js';
import { purgeExpiredMedia } from './lib/store.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function printWelcome() {
  console.clear();
  console.log(chalk.cyanBright('╔══════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyanBright('║') + chalk.whiteBright('                 🎯 ARTIST TRACKER                      ') + chalk.cyanBright('║'));
  console.log(chalk.cyanBright('║') + chalk.gray('              Madrid Artist Intelligence                ') + chalk.cyanBright('║'));
  console.log(chalk.cyanBright('╚══════════════════════════════════════════════════════════╝'));
  console.log('');
  console.log(chalk.blueBright('✨ Bienvenido a ArtistTracker, Richetti.'));
  console.log(chalk.gray('   Objetivo: detectar artistas en Madrid y avisarte por WhatsApp.'));
  console.log(chalk.gray(`   Mínimo de oyentes: ${config.minMonthlyListeners.toLocaleString('es-ES')}`));
  console.log(chalk.gray(`   Escaneo automático: cada ${Math.round(config.scan.intervalMs / 60000)} minutos`));
  console.log(chalk.gray(`   WhatsApp destino: +${config.targetJid.split('@')[0]}`));
  console.log('');
  console.log(chalk.yellow('📡 Fuentes sociales: Instagram · TikTok · SoundCloud · Gemini'));
  console.log(chalk.yellow('🎧 Oyentes: Songstats (si hay API key) → Zyla (si hay API key)'));
  console.log(chalk.yellow('🎟️ Eventos: Ticketmaster · Fever · Entradas.com'));
  console.log('');
  console.log(chalk.magentaBright('━━━━━━━━━━━━━━━━━━ CONSOLA EN VIVO ━━━━━━━━━━━━━━━━━━'));
}

async function start() {
  printWelcome();
  mkdirSync(config.paths.sessions, { recursive: true });
  mkdirSync(config.paths.data, { recursive: true });
  mkdirSync(config.paths.media, { recursive: true });

  console.log(chalk.blue('[BOOT] Cargando credenciales de WhatsApp...'));
  const { state, saveCreds } = await useMultiFileAuthState(config.paths.sessions);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(chalk.blue(`[BOOT] Baileys listo. Versión WA: ${version.join('.')}${isLatest === false ? ' (la librería reporta que no es la última)' : ''}`));

  const sock = makeWASocket({
    auth: state,
    version,
    logger: P({ level: 'silent' }),
    browser: ['ArtistTracker', 'Desktop', '3.0'],
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(chalk.yellow('\n╭────────────────────────────────────────────────────────╮'));
      console.log(chalk.yellow('│ 📲 ESCANEA ESTE CÓDIGO QR CON WHATSAPP                 │'));
      console.log(chalk.yellow('│ WhatsApp → Ajustes → Dispositivos vinculados           │'));
      console.log(chalk.yellow('╰────────────────────────────────────────────────────────╯\n'));
      console.log(chalk.whiteBright('                 CÓDIGO QR DE VINCULACIÓN\n'));
      qrcode.generate(qr, { small: true });
      console.log(chalk.yellow('\n⏳ Esperando a que escanees el QR...'));
    }

    if (connection === 'connecting') {
      console.log(chalk.blue('[WA] Conectando con WhatsApp...'));
    }

    if (connection === 'open') {
      console.log(chalk.greenBright('\n╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮'));
      console.log(chalk.greenBright('┃ 🟢 WHATSAPP CONECTADO CORRECTAMENTE         ┃'));
      console.log(chalk.greenBright('╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯'));
      console.log(chalk.gray('[BOOT] Sesión guardada. El QR ya no será necesario en próximos arranques.'));
      console.log(chalk.gray('[BOOT] Iniciando primer escaneo ahora...'));

      if (!global.artistScanTimer) {
        try {
          await runScan(sock);
        } catch (err) {
          console.error(chalk.red('[SCAN] Error durante el primer escaneo:'), err);
        }
        global.artistScanTimer = setInterval(() => {
          runScan(sock).catch(err => console.error(chalk.red('[SCAN] Error:'), err));
        }, config.scan.intervalMs);
        global.cleanupTimer = setInterval(() => {
          Promise.resolve(purgeExpiredMedia()).catch(err => console.error(chalk.red('[CLEANUP] Error:'), err));
        }, 60 * 60 * 1000);
        console.log(chalk.green(`[SCHEDULER] Escaneo automático programado cada ${Math.round(config.scan.intervalMs / 60000)} minutos.`));
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.error(chalk.red(`[WA] Conexión cerrada. Código: ${code ?? 'desconocido'}`));
      if (code !== DisconnectReason.loggedOut) {
        console.log(chalk.yellow('[WA] Intentando reconectar en 5 segundos...'));
        await sleep(5000);
        start().catch(err => console.error(chalk.red('[BOOT] Error al reconectar:'), err));
      } else {
        console.error(chalk.red('[WA] Sesión cerrada definitivamente. Para volver a vincular, elimina la carpeta sessions/ y ejecuta npm start.'));
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
        if (body) console.log(chalk.hex('#FF8C00')(`[WhatsApp] ${msg.key.remoteJid}: ${body}`));
        await handleMessage(sock, msg);
      } catch (err) {
        console.error(chalk.red('[MESSAGE] Error:'), err);
      }
    }
  });
}

process.on('uncaughtException', err => console.error(chalk.red('[FATAL] Excepción no controlada:'), err));
process.on('unhandledRejection', err => console.error(chalk.red('[FATAL] Promesa rechazada:'), err));

start().catch(err => {
  console.error(chalk.red('[BOOT] No se pudo iniciar ArtistTracker:'), err);
  process.exitCode = 1;
});
