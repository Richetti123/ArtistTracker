import { manualSearch } from './tracker.js';
import { sendTestMessage } from './evidence.js';

/**
 * ArtistTracker command layer.
 *
 * Inspired by the command-routing pattern used in PayBalance:
 * - detect prefix commands in one place;
 * - extract command + arguments;
 * - execute the command without mixing it with conversational handling.
 *
 * PayBalance itself is not modified; this is an ArtistTracker-native implementation.
 */

export const COMMAND_PREFIXES = ['!', '/', '.'];

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
  return new Set([
    'buscar', 'busca', 'comprobar', 'comprueba',
    'test', 'prueba', 'ayuda', 'comandos'
  ]).has(String(command || '').toLowerCase());
}

export function commandHelp() {
  return [
    '🎯 *ArtistTracker — Comandos*',
    '',
    '🔎 !buscar ARTISTA — Buscar un artista manualmente.',
    '🧪 !test — Enviar un mensaje de prueba a WhatsApp.',
    '❓ !ayuda — Mostrar esta ayuda.',
    '',
    '💬 Los mensajes que no sean comandos siguen su flujo de chat/respuestas normal.'
  ].join('\n');
}

/**
 * Executes an ArtistTracker command.
 * Returns true when the message was consumed as a command.
 */
export async function executeCommand(sock, commandData) {
  if (!commandData) return false;

  const { command, args } = commandData;
  const rawSend = sock.sendMessage.bind(sock);

  switch (command) {
    case 'buscar':
    case 'busca':
    case 'comprobar':
    case 'comprueba': {
      const artist = args.replace(/^artista\s+/i, '').trim();
      if (!artist) {
        await rawSend(sock.__artistTrackerTargetJid, {
          text: '❌ Indica un artista. Ejemplo: !buscar Bad Bunny'
        });
        return true;
      }
      console.log(`[COMMAND] 🔎 buscar -> ${artist}`);
      await manualSearch(sock, artist);
      return true;
    }

    case 'test':
    case 'prueba':
      console.log('[COMMAND] 🧪 test -> enviando mensaje de prueba.');
      await sendTestMessage(sock, rawSend);
      return true;

    case 'ayuda':
    case 'comandos':
      console.log('[COMMAND] ❓ ayuda -> mostrando comandos.');
      await rawSend(sock.__artistTrackerTargetJid, { text: commandHelp() });
      return true;

    default:
      console.log(`[COMMAND] ❌ Comando no reconocido: ${command}`);
      return false;
  }
}
