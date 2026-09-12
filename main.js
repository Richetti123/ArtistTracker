import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import chalk from 'chalk';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { config } from './lib/config.js';
import { handleMessage } from './handler.js';
import { runScan } from './lib/tracker.js';
import { purgeExpiredMedia } from './lib/store.js';
import { sendArtistEvidence } from './lib/evidence.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let restartInProgress = false;

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
  console.log(chalk.gray('Comandos disponibles: !buscar ARTISTA · !test · !ayuda'));
}

function clearArtistTimers() {
  if (global.artistScanTimer) {
    clearInterval(global.artistScanTimer);
    global.artistScanTimer = null;
  }
  if (global.cleanupTimer) {
    clearInterval(global.cleanupTimer);
    global.cleanupTimer = null;
  }
}

function resetSessionFolder() {
  if (!existsSync(config.paths.sessions)) return;
  console.log(chalk.yellow('[WA] La sesión guardada no está activa. Eliminando sessions/ para volver a vincular...'));
  rmSync(config.paths.sessions, { recursive: true, force: true });
  console.log(chalk.green('[WA] Carpeta sessions/ eliminada correctamente.'));
}

async function restartWithoutSession() {
  if (restartInProgress) return;
  restartInProgress = true;
  clearArtistTimers();
  resetSessionFolder();
  console.log(chalk.yellow('[WA] Reiniciando ArtistTracker sin la sesión anterior...'));
  await sleep(1000);
  restartInProgress = false;
  await start();
}

async function start() {
  printWelcome();
  mkdirSync(config.paths.sessions, { recursive: true });
  mkdirSync(config.paths.data, { recursive: true });
  mkdirSync(config.paths.media, { recursive: true });

  console.log(chalk.blue('[BOOT] Comprobando sesión guardada de WhatsApp...'));
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

  const rawSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const [jid, content] = args;
    const body = content?.text || '';
    console.log(chalk.cyan(`[WA->SEND] destino=${jid} tipo=${content?.text ? 'texto' : content?.image ? 'imagen' : content?.video ? 'video' : 'otro'}`));
    if (body) console.log(chalk.gray(`[WA->SEND] ${body.slice(0, 500)}${body.length > 500 ? '...' : ''}`));

    const result = await rawSendMessage(...args);

    if (!sock.__artistTrackerEvidenceRunning && typeof body === 'string') {
      const match = body.match(/(?:BÚSQUEDA MANUAL:|🎤 \*)([^*\n]+)\*?/i) || body.match(/ARTISTA DETECTADO EN MADRID[\s\S]*?🎤 \*([^*]+)\*/i);
      const isAlert = /BÚSQUEDA MANUAL:|ARTISTA DETECTADO EN MADRID/i.test(body);
      if (isAlert && match?.[1]) {
        const artist = match[1].trim();
        sock.__artistTrackerEvidenceRunning = true;
        try {
          await sendArtistEvidence(sock, artist, rawSendMessage);
        } catch (err) {
          console.error(chalk.red(`[EVIDENCE] Error para ${artist}: ${err.message}`));
        } finally {
          sock.__artistTrackerEvidenceRunning = false;
        }
      }
    }

    return result;
  };

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
      restartInProgress = false;
      console.log(chalk.greenBright('\n╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮'));
      console.log(chalk.greenBright('┃ 🟢 WHATSAPP CONECTADO CORRECTAMENTE         ┃'));
      console.log(chalk.greenBright('╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯'));
      console.log(chalk.gray('[BOOT] Sesión activa y guardada. El QR no será necesario mientras siga activa.'));
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

      if (code === DisconnectReason.loggedOut) {
        await restartWithoutSession();
        return;
      }

      if (!state.creds?.registered) {
        await restartWithoutSession();
        return;
      }

      console.log(chalk.yellow('[WA] La conexión se cerró temporalmente. Intentando reconectar en 5 segundos...'));
      await sleep(5000);
      if (!restartInProgress) start().catch(err => console.error(chalk.red('[BOOT] Error al reconectar:'), err));
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        // The handler owns incoming-message presentation and command routing.
        // Keeping this listener thin prevents duplicated console entries.
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
