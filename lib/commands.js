import { manualSearch } from './tracker.js';
import { sendTestMessage } from './evidence.js';
import { resolveArtist, verifyMonthlyListeners } from './identity.js';
import { config } from './config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';

const execFileAsync = promisify(execFile);

export const COMMAND_PREFIXES = ['!', '/', '.'];

const KNOWN_COMMANDS = new Set([
  'buscar', 'busca', 'comprobar', 'comprueba',
  'oyentes', 'listeners', 'test', 'prueba', 'update', 'actualizar', 'ayuda', 'comandos'
]);

export function parseCommand(body) {
  const text = String(body || '').trim();
  if (!text) return null;
  const prefix = COMMAND_PREFIXES.find(p => text.startsWith(p));
  if (!prefix) return null;
  const withoutPrefix = text.slice(prefix.length).trim();
  if (!withoutPrefix) return null;
  const parts = withoutPrefix.split(/\s+/);
  const command = parts.shift().toLowerCase();
  const args = parts.join(' ').trim();
  return { prefix, command, args, raw: text };
}

export function isKnownCommand(command) {
  return KNOWN_COMMANDS.has(String(command || '').toLowerCase());
}

export function commandHelp() {
  return [
    '🎯 *ArtistTracker — Comandos*',
    '',
    '🔎 !buscar ARTISTA — Buscar un artista manualmente en el mismo chat.',
    '🎧 .oyentes ARTISTA — Probar únicamente la comprobación de oyentes: Spotify → Songstats → artist.tools.',
    '🧪 !test — Ejecutar una prueba y enviar el resultado al privado configurado.',
    '🔄 .update — Ejecutar git pull y reiniciar automáticamente ArtistTracker si hay cambios.',
    '❓ !ayuda — Mostrar esta ayuda.',
    '',
    `📱 Privado configurado: +${config.targetJid.split('@')[0]}`,
    `📱 Privado de pruebas: +${config.testTargetJid.split('@')[0]}`,
    '💬 Los mensajes que no sean comandos siguen su flujo normal.'
  ].join('\n');
}

async function updateBot(sock, destination) {
  const chat = destination || config.targetJid;
  try {
    await sock.sendMessage(chat, { text: '🔄 *ArtistTracker:* comprobando actualizaciones en GitHub...' });
    const { stdout, stderr } = await execFileAsync('git', ['pull', '--ff-only'], { cwd: process.cwd(), timeout: 120000, maxBuffer: 1024 * 1024 });
    const output = String(stdout || stderr || '').trim();
    const alreadyUpdated = /already up[ -]to[ -]date|ya está actualizado|ya esta actualizado/i.test(output);

    if (alreadyUpdated) {
      await sock.sendMessage(chat, { text: `✅ *ArtistTracker ya está actualizado.*\n\n${output.slice(-1200)}` });
      return true;
    }

    await sock.sendMessage(chat, { text: `✅ *Actualización descargada.*\n\n${output.slice(-1200)}\n\n♻️ Reiniciando automáticamente para cargar el código nuevo...` });
    const child = spawn(process.execPath, process.execArgv.concat(process.argv.slice(1)), {
      cwd: process.cwd(),
      env: { ...process.env, ARTISTTRACKER_AUTO_UPDATED: '1' },
      detached: true,
      stdio: 'inherit'
    });
    child.unref();
    setTimeout(() => process.exit(0), 750);
    return true;
  } catch (error) {
    console.error(`[UPDATE] ${error.message}`);
    await sock.sendMessage(chat, { text: `❌ *No se pudo actualizar ArtistTracker.*\n\n${error.stdout || error.stderr || error.message}` });
    return false;
  }
}

async function testListeners(sock, destination, artist) {
  const name = String(artist || '').trim();
  if (!name) {
    await sock.sendMessage(destination, { text: '❌ Indica un artista. Ejemplo: .oyentes Aitana' });
    return true;
  }
  await sock.sendMessage(destination, { text: `🎧 Comprobando oyentes de *${name}* en el orden: Spotify → Songstats → artist.tools...` });
  try {
    const profile = await resolveArtist(name);
    const result = await verifyMonthlyListeners(name, profile);
    const number = Number.isFinite(result.monthly) ? result.monthly.toLocaleString('es-ES') : 'No verificados';
    await sock.sendMessage(destination, { text: `🎤 *Artista:* ${result.artist || profile.artist || name}\n🎧 *Oyentes mensuales:* ${number}\n🔎 *Fuente utilizada:* ${result.source || 'Ninguna'}\n🔗 *URL:* ${result.url || 'No disponible'}\n🧠 *Identidad:* ${profile.artist || name}\n🌎 *País:* ${profile.country || 'No identificado'}\n🎵 *Género:* ${profile.genre || 'No identificado'}` });
  } catch (error) {
    console.error(`[LISTENERS] ${error.message}`);
    await sock.sendMessage(destination, { text: `❌ Error comprobando los oyentes de *${name}*: ${error.message}` });
  }
  return true;
}

export async function executeCommand(sock, commandData, chatJid) {
  if (!commandData) return false;
  const { command, args } = commandData;
  const destination = chatJid || sock.__artistTrackerTargetJid;

  switch (command) {
    case 'buscar':
    case 'busca':
    case 'comprobar':
    case 'comprueba': {
      const artist = args.replace(/^artista\s+/i, '').trim();
      if (!artist) {
        await sock.sendMessage(destination, { text: '❌ Indica un artista. Ejemplo: .buscar Bad Bunny' });
        return true;
      }
      console.log(`[COMMAND] 🔎 buscar -> ${artist}`);
      sock.__artistTrackerCommandChatJid = destination;
      try {
        await manualSearch(sock, artist, destination);
      } finally {
        sock.__artistTrackerCommandChatJid = null;
      }
      return true;
    }

    case 'oyentes':
    case 'listeners':
      console.log(`[COMMAND] 🎧 oyentes -> ${args}`);
      return testListeners(sock, destination, args);

    case 'test':
    case 'prueba': {
      const testDestination = config.testTargetJid;
      console.log(`[COMMAND] 🧪 test -> comando recibido en ${destination}; resultado privado -> ${testDestination}`);
      sock.__artistTrackerTestRunning = true;
      try {
        await sendTestMessage(sock, sock.sendMessage.bind(sock), testDestination);
      } finally {
        sock.__artistTrackerTestRunning = false;
      }
      return true;
    }

    case 'update':
    case 'actualizar':
      console.log(`[COMMAND] 🔄 update -> git pull solicitado desde ${destination}`);
      return updateBot(sock, destination);

    case 'ayuda':
    case 'comandos':
      console.log('[COMMAND] ❓ ayuda -> mostrando comandos.');
      await sock.sendMessage(destination, { text: commandHelp() });
      return true;

    default:
      console.log(`[COMMAND] ❌ Comando no reconocido: ${command}`);
      return false;
  }
}
