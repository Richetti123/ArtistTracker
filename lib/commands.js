import { manualSearch } from './tracker.js';
import { sendTestMessage } from './evidence.js';

export const COMMAND_PREFIXES = ['!', '/', '.'];

const KNOWN_COMMANDS = new Set([
  'buscar', 'busca', 'comprobar', 'comprueba',
  'test', 'prueba', 'ayuda', 'comandos'
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
    '🔎 !buscar ARTISTA — Buscar un artista manualmente.',
    '🧪 !test — Enviar un mensaje de prueba a este chat.',
    '❓ !ayuda — Mostrar esta ayuda.',
    '',
    '💬 Los mensajes que no sean comandos siguen su flujo de chat/respuestas normal.'
  ].join('\n');
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
        await sock.sendMessage(destination, { text: '❌ Indica un artista. Ejemplo: !buscar Bad Bunny' });
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

    case 'test':
    case 'prueba':
      console.log('[COMMAND] 🧪 test -> enviando mensaje de prueba.');
      sock.__artistTrackerTestRunning = true;
      try {
        await sendTestMessage(sock, sock.sendMessage.bind(sock), destination);
      } finally {
        sock.__artistTrackerTestRunning = false;
      }
      return true;

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
