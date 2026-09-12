import { areJidsSameUser, jidDecode, jidNormalizedUser } from '@whiskeysockets/baileys';
import { answerInterest } from './lib/tracker.js';
import { config } from './lib/config.js';
import { executeCommand, parseCommand, isKnownCommand } from './lib/commands.js';
import chalk from 'chalk';

function unique(values) {
  return [...new Set(values.filter(Boolean).map(value => String(value).trim()))];
}

function normalizeJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return jidNormalizedUser(raw) || raw;
  } catch {
    return raw;
  }
}

function phoneJid(value) {
  const normalized = normalizeJid(value);
  if (normalized.endsWith('@s.whatsapp.net')) return normalized;
  if (/^\d+(?::\d+)?$/.test(normalized)) return `${normalized.split(':')[0]}@s.whatsapp.net`;
  return '';
}

function isLid(value) {
  return normalizeJid(value).endsWith('@lid');
}

function senderCandidates(msg) {
  return unique([
    msg?.key?.participant,
    msg?.key?.participantAlt,
    msg?.key?.remoteJidAlt,
    msg?.participant,
    msg?.sender,
    msg?.senderAlt,
    msg?.key?.senderPn,
    msg?.key?.participantPn,
    msg?.senderPn,
    msg?.key?.remoteJid
  ]);
}

async function resolveLid(sock, jid) {
  const value = normalizeJid(jid);
  if (!isLid(value)) return [];

  const resolved = [];
  const push = value => {
    if (value) resolved.push(String(value).trim());
  };

  try {
    const mapping = sock?.signalRepository?.lidMapping;
    if (typeof mapping?.getPNForLID === 'function') {
      push(await mapping.getPNForLID(value));
    }
  } catch (err) {
    console.log(chalk.gray(`[AUTH] LID store no pudo resolver ${value}: ${err.message}`));
  }

  try {
    if (typeof sock?.getPNForLID === 'function') {
      push(await sock.getPNForLID(value));
    }
  } catch (err) {
    console.log(chalk.gray(`[AUTH] API LID no pudo resolver ${value}: ${err.message}`));
  }

  return unique(resolved);
}

async function expandIdentity(sock, jid) {
  const value = normalizeJid(jid);
  if (!value) return [];

  const identities = [value];
  const pn = phoneJid(value);
  if (pn) identities.push(pn);

  if (isLid(value)) identities.push(...await resolveLid(sock, value));

  try {
    const decoded = jidDecode(value);
    if (decoded?.user && decoded?.server) {
      identities.push(normalizeJid(`${decoded.user}@${decoded.server}`));
    }
  } catch {}

  return unique(identities);
}

async function senderMatchesTarget(sock, msg) {
  const targetIdentities = await expandIdentity(sock, config.targetJid);
  const candidates = senderCandidates(msg);

  for (const candidate of candidates) {
    const identities = await expandIdentity(sock, candidate);
    for (const identity of identities) {
      for (const target of targetIdentities) {
        if (identity === target) return true;
        try {
          if (areJidsSameUser(identity, target)) return true;
        } catch {}
      }
    }
  }

  return false;
}

function extractBody(msg) {
  let message = msg?.message;
  if (!message) return '';

  for (let i = 0; i < 4; i++) {
    if (message?.ephemeralMessage?.message) message = message.ephemeralMessage.message;
    else if (message?.viewOnceMessage?.message) message = message.viewOnceMessage.message;
    else if (message?.viewOnceMessageV2?.message) message = message.viewOnceMessageV2.message;
    else if (message?.viewOnceMessageV2Extension?.message) message = message.viewOnceMessageV2Extension.message;
    else break;
  }

  return String(
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    message?.buttonsResponseMessage?.selectedButtonId ||
    message?.buttonResponseMessage?.selectedButtonId ||
    message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    message?.templateButtonReplyMessage?.selectedId ||
    message?.editedMessage?.message?.conversation ||
    message?.editedMessage?.message?.extendedTextMessage?.text ||
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
