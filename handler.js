import { answerInterest } from './lib/tracker.js';
import { config } from './lib/config.js';
import { executeCommand, parseCommand, isKnownCommand } from './lib/commands.js';
import chalk from 'chalk';

function senderCandidates(msg) {
  return [
    msg?.key?.remoteJid,
    msg?.key?.remoteJidAlt,
    msg?.key?.participant,
    msg?.key?.participantAlt
  ].filter(Boolean);
}

function senderMatchesTarget(msg) {
  const target = String(config.targetJid || '').trim();
  return senderCandidates(msg).some(jid => String(jid).trim() === target);
}

function extractBody(msg) {
  return String(
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    msg?.message?.documentMessage?.caption ||
    ''
  ).trim();
}

function prettyIncomingLog(msg, body, authorized) {
  const jid = msg?.key?.remoteJid || 'desconocido';
  const alt = msg?.key?.remoteJidAlt;
  const senderJid = msg?.key?.participant || alt || jid;
  const senderNumber = String(senderJid).split('@')[0].split(':')[0];
  const senderName = msg?.pushName || 'Desconocido';
  const messageType = Object.keys(msg?.message || {})[0] || 'desconocido';
  const command = parseCommand(body);
  const action = command
    ? `Comando: ${command.prefix}${command.command}`
    : 'Mensaje recibido';

  console.log(
    chalk.hex('#FF8C00')('╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮') + '\n' +
    chalk.white(`┃ ❖ Artista: ${chalk.cyanBright('ArtistTracker')}`) + '\n' +
    chalk.white(`┃ ❖ Horario: ${chalk.greenBright(new Date().toLocaleTimeString('es-ES', { hour12: false }))}`) + '\n' +
    chalk.white(`┃ ❖ Acción: ${chalk.yellow(action)}`) + '\n' +
    chalk.white(`┃ ❖ Usuario: ${chalk.blueBright(`+${senderNumber}`)} ~ ${chalk.blueBright(senderName)}`) + '\n' +
    chalk.white(`┃ ❖ Origen: ${chalk.gray(jid)}${alt ? chalk.gray(` · alt ${alt}`) : ''}`) + '\n' +
    chalk.white(`┃ ❖ Tipo: [${chalk.red(messageType)}] ${chalk[authorized ? 'green' : 'gray'](authorized ? 'Autorizado' : 'No autorizado')}`) + '\n' +
    chalk.hex('#FF8C00')('╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯') + '\n' +
    chalk.white(body || ' (Sin texto legible) ')
  );
}

export async function handleMessage(sock, msg) {
  if (!msg?.message || msg.key?.fromMe) return;

  const body = extractBody(msg);
  const authorized = senderMatchesTarget(msg);
  const commandData = parseCommand(body);

  prettyIncomingLog(msg, body, authorized);

  // Commands are deliberately isolated from the conversational flow.
  // Only the configured ArtistTracker target can execute bot commands.
  if (authorized && commandData) {
    if (isKnownCommand(commandData.command)) {
      sock.__artistTrackerTargetJid = config.targetJid;
      await executeCommand(sock, commandData);
      return;
    }

    console.log(chalk.red(`[COMMAND] ❌ Comando no reconocido: ${commandData.prefix}${commandData.command}`));
    await sock.sendMessage(config.targetJid, {
      text: `❌ Comando no reconocido: *${commandData.prefix}${commandData.command}*\n\nUsa !ayuda para ver los comandos disponibles.`
    });
    return;
  }

  // Non-command messages remain in the normal ArtistTracker conversation flow.
  // This is intentionally separate from command execution so future AI chat can
  // be connected here without touching the command router.
  const normalizedMessage = authorized
    ? { ...msg, key: { ...msg.key, remoteJid: config.targetJid } }
    : msg;

  await answerInterest(sock, normalizedMessage);
}
