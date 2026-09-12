import { jidDecode } from '@whiskeysockets/baileys';
import { answerInterest } from './lib/tracker.js';
import { config } from './lib/config.js';
import { executeCommand, parseCommand, isKnownCommand } from './lib/commands.js';
import chalk from 'chalk';

function unique(values) {
  return [...new Set(values.filter(Boolean).map(value => String(value).trim()))];
}

function phoneJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.endsWith('@s.whatsapp.net')) return raw;
  if (/^\d+(?::\d+)?$/.test(raw)) return `${raw.split(':')[0]}@s.whatsapp.net`;
  return '';
}

function senderCandidates(msg) {
  return unique([
    msg?.key?.remoteJid,
    msg?.key?.remoteJidAlt,
    msg?.key?.participant,
    msg?.key?.participantAlt,
    msg?.participant,
    msg?.sender,
    msg?.senderAlt
  ]);
}

async function resolveLid(sock, jid) {
  const value = String(jid || '').trim();
  if (!value.endsWith('@lid')) return [];
  const resolved = [];
  try {
    if (typeof sock?.getPNForLID === 'function') {
      const pn = await sock.getPNForLID(value);
      if (pn) resolved.push(pn);
    }
  } catch (err) {
    console.log(chalk.gray(`[AUTH] No se pudo resolver LID ${value}: ${err.message}`));
  }
  return resolved;
}

async function senderMatchesTarget(sock, msg) {
  const target = phoneJid(config.targetJid) || config.targetJid;
  const candidates = senderCandidates(msg);
  if (candidates.includes(target)) return true;

  for (const candidate of candidates) {
    const normalized = phoneJid(candidate);
    if (normalized && normalized === target) return true;

    const decoded = candidate.includes('@') ? jidDecode(candidate) : null;
    if (decoded?.user && decoded?.server && phoneJid(`${decoded.user}@${decoded.server}`) === target) return true;

    const aliases = await resolveLid(sock, candidate);
    if (aliases.some(alias => phoneJid(alias) === target || String(alias).trim() === target)) return true;
  }
  return false;
}

function extractBody(msg) {
  let message = msg?.message;
  if (!message) return '';
  if (message.ephemeralMessage?.message) message = message.ephemeralMessage.message;
  if (message.viewOnceMessage?.message) message = message.viewOnceMessage.message;
  if (message.viewOnceMessageV2?.message) message = message.viewOnceMessageV2.message;

  return String(
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    message?.buttonsResponseMessage?.selectedButtonId ||
    message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    message?.templateButtonReplyMessage?.selectedId ||
    ''
  ).trim();
}

function prettyIncomingLog(msg, body, authorized) {
  const jid = msg?.key?.remoteJid || 'desconocido';
  const alt = msg?.key?.remoteJidAlt;
  const participant = msg?.key?.participant || msg?.participant || '—';
  const participantAlt = msg?.key?.participantAlt || msg?.senderAlt;
  const senderJid = participant !== '—' ? participant : (alt || jid);
  const senderNumber = String(senderJid).split('@')[0].split(':')[0];
  const senderName = msg?.pushName || 'Desconocido';
  const messageType = Object.keys(msg?.message || {})[0] || 'desconocido';
  const command = parseCommand(body);
  const action = command ? `Comando: ${command.prefix}${command.command}` : 'Mensaje recibido';

  console.log(
    chalk.hex('#FF8C00')('╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮') + '\n' +
    chalk.white(`┃ ❖ Artista: ${chalk.cyanBright('ArtistTracker')}`) + '\n' +
    chalk.white(`┃ ❖ Horario: ${chalk.greenBright(new Date().toLocaleTimeString('es-ES', { hour12: false }))}`) + '\n' +
    chalk.white(`┃ ❖ Acción: ${chalk.yellow(action)}`) + '\n' +
    chalk.white(`┃ ❖ Usuario: ${chalk.blueBright(`+${senderNumber}`)} ~ ${chalk.blueBright(senderName)}`) + '\n' +
    chalk.white(`┃ ❖ Origen: ${chalk.gray(jid)}${alt ? chalk.gray(` · alt ${alt}`) : ''}`) + '\n' +
    chalk.white(`┃ ❖ Participante: ${chalk.gray(participant)}${participantAlt ? chalk.gray(` · alt ${participantAlt}`) : ''}`) + '\n' +
    chalk.white(`┃ ❖ Tipo: [${chalk.red(messageType)}] ${chalk[authorized ? 'green' : 'gray'](authorized ? 'Autorizado' : 'No autorizado')}`) + '\n' +
    chalk.hex('#FF8C00')('╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯') + '\n' +
    chalk.white(body || ' (Sin texto legible) ')
  );
}

export async function handleMessage(sock, msg) {
  if (!msg?.message || msg.key?.fromMe) return;

  const body = extractBody(msg);
  const authorized = await senderMatchesTarget(sock, msg);
  const commandData = parseCommand(body);
  prettyIncomingLog(msg, body, authorized);

  if (commandData) {
    if (!authorized) {
      console.log(chalk.gray(`[COMMAND] 🔒 Ignorado por autorización: ${commandData.prefix}${commandData.command}`));
      return;
    }

    if (isKnownCommand(commandData.command)) {
      const chatJid = msg?.key?.remoteJid || config.targetJid;
      console.log(chalk.green(`[COMMAND] ✅ Autorizado. Ejecutando ${commandData.prefix}${commandData.command} en ${chatJid}`));
      await executeCommand(sock, commandData, chatJid);
      return;
    }

    console.log(chalk.red(`[COMMAND] ❌ Comando no reconocido: ${commandData.prefix}${commandData.command}`));
    await sock.sendMessage(msg?.key?.remoteJid || config.targetJid, {
      text: `❌ Comando no reconocido: *${commandData.prefix}${commandData.command}*\n\nUsa !ayuda para ver los comandos disponibles.`
    });
    return;
  }

  const normalizedMessage = authorized
    ? { ...msg, key: { ...msg.key, remoteJid: config.targetJid } }
    : msg;

  await answerInterest(sock, normalizedMessage);
}
