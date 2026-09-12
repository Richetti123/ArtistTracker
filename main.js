import * as baileys from '@whiskeysockets/baileys';
import { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, fetchLatestWaWebVersion, jidNormalizedUser, makeInMemoryStore } from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import chalk from 'chalk';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { config } from './lib/config.js';
import { handleMessage } from './handler.js';
import { runScan } from './lib/tracker.js';
import { purgeExpiredMedia } from './lib/store.js';
import { sendArtistEvidence } from './lib/evidence.js';

const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let restartInProgress = false;
let reconnectTimer = null;
const messageStore = new Map();
const MESSAGE_STORE_MAX = 2000;

function rememberMessage(msg) {
  const jid=msg?.key?.remoteJid,id=msg?.key?.id;if(!jid||!id)return;
  messageStore.set(`${jid}:${id}`,msg);while(messageStore.size>MESSAGE_STORE_MAX)messageStore.delete(messageStore.keys().next().value);
}
function printWelcome(){console.clear();console.log(chalk.cyanBright('╔══════════════════════════════════════════════════════════╗'));console.log(chalk.cyanBright('║')+chalk.whiteBright('                 🎯 ARTIST TRACKER                      ')+chalk.cyanBright('║'));console.log(chalk.cyanBright('║')+chalk.gray('              Madrid Artist Intelligence                ')+chalk.cyanBright('║'));console.log(chalk.cyanBright('╚══════════════════════════════════════════════════════════╝'));console.log('');console.log(chalk.blueBright('✨ Bienvenido a ArtistTracker, Richetti.'));console.log(chalk.gray('   Objetivo: detectar artistas en Madrid y avisarte por WhatsApp.'));console.log(chalk.gray(`   Mínimo de oyentes: ${config.minMonthlyListeners.toLocaleString('es-ES')}`));console.log(chalk.gray(`   Escaneo automático: cada ${Math.round(config.scan.intervalMs/60000)} minutos`));console.log(chalk.gray(`   WhatsApp destino: +${config.targetJid.split('@')[0]}`));console.log('');console.log(chalk.yellow('📡 Fuentes: Ticketmaster · Fever · Entradas.com · La Ganzúa · Bandsintown · Instagram · TikTok · SoundCloud'));console.log(chalk.yellow('🎧 Oyentes: Spotify → Songstats → artist.tools → otros'));console.log(chalk.yellow(`🧠 Visión IA: Gemini ${config.vision.model} (si GEMINI_API_KEY está configurada)`));console.log(chalk.yellow(`⏱️ Cooldown entre alertas automáticas: ${Math.round(config.alerts.cooldownMs/60000)} minutos`));console.log('');console.log(chalk.magentaBright('━━━━━━━━━━━━━━━━━━ CONSOLA EN VIVO ━━━━━━━━━━━━━━━━━━'));console.log(chalk.gray('Comandos disponibles: !buscar ARTISTA · .oyentes ARTISTA · !test · !ayuda'));}
function clearArtistTimers(){if(global.artistScanTimer){clearInterval(global.artistScanTimer);global.artistScanTimer=null;}if(global.cleanupTimer){clearInterval(global.cleanupTimer);global.cleanupTimer=null;}}
function resetSessionFolder(){if(!existsSync(config.paths.sessions))return;console.log(chalk.yellow('[WA] La sesión guardada no está activa. Eliminando sessions/ para volver a vincular...'));rmSync(config.paths.sessions,{recursive:true,force:true});console.log(chalk.green('[WA] Carpeta sessions/ eliminada correctamente.'));}
async function restartWithoutSession(){if(restartInProgress)return;restartInProgress=true;clearArtistTimers();resetSessionFolder();console.log(chalk.yellow('[WA] Reiniciando ArtistTracker sin la sesión anterior...'));await sleep(1000);restartInProgress=false;await start();}
function scheduleReconnect(){if(restartInProgress||reconnectTimer)return;console.log(chalk.yellow('[WA] Reintentando conexión en 5 segundos...'));reconnectTimer=setTimeout(()=>{reconnectTimer=null;start().catch(err=>console.error(chalk.red('[BOOT] Error al reconectar:'),err));},5000);}

async function start(){
  printWelcome();mkdirSync(config.paths.sessions,{recursive:true});mkdirSync(config.paths.data,{recursive:true});mkdirSync(config.paths.media,{recursive:true});
  console.log(chalk.blue('[BOOT] Comprobando sesión guardada de WhatsApp...'));const {state,saveCreds}=await useMultiFileAuthState(config.paths.sessions);
  let version,versionSource='Baileys';
  try{const liveVersion=await fetchLatestWaWebVersion();if(Array.isArray(liveVersion?.version)&&liveVersion.version.length===3){version=liveVersion.version;versionSource='WhatsApp Web';}}catch(err){console.log(chalk.yellow(`[BOOT] No se pudo consultar la versión de WhatsApp Web: ${err.message}`));}
  if(!version){const baileysVersion=await fetchLatestBaileysVersion();version=baileysVersion.version;}
  console.log(chalk.blue(`[BOOT] Baileys listo. Versión WA: ${version.join('.')} (${versionSource})`));
  if(typeof makeWASocket!=='function')throw new TypeError('La versión instalada de Baileys no expone makeWASocket como función.');
  const store=makeInMemoryStore({logger:P({level:'silent'}).child({level:'store'})});
  const sock=makeWASocket({auth:state,version,logger:P({level:'silent'}),browser:['ArtistTracker','Desktop','3.0'],markOnlineOnConnect:false,shouldIgnoreJid:()=>false,syncFullHistory:false,getMessage:async key=>{try{const jid=jidNormalizedUser(key?.remoteJid)||key?.remoteJid;const stored=await store.loadMessage(jid,key?.id)||await store.loadMessage(key?.remoteJid,key?.id);if(stored?.message)return stored.message;return messageStore.get(`${jid}:${key?.id}`)?.message||messageStore.get(`${key?.remoteJid}:${key?.id}`)?.message||undefined;}catch{return undefined;}}});
  store.bind(sock.ev);
  const rawSendMessage=sock.sendMessage.bind(sock);let autoAlertQueue=Promise.resolve();let lastAutoAlertAt=0;
  const runScanSafely=async()=>{if(global.artistTrackerScanRunning){console.log(chalk.yellow('[SCAN] Ya hay un escaneo en curso; se evita iniciar otro en paralelo.'));return;}global.artistTrackerScanRunning=true;try{await runScan(sock);}finally{global.artistTrackerScanRunning=false;}};

  sock.__artistTrackerSendAutoMessage=(jid,content,context=null)=>{
    autoAlertQueue=autoAlertQueue.then(async()=>{
      const wait=Math.max(0,config.alerts.cooldownMs-(Date.now()-lastAutoAlertAt));if(wait>0){console.log(chalk.yellow(`[ALERT-QUEUE] Esperando ${Math.ceil(wait/1000)}s antes del siguiente artista para evitar spam.`));await sleep(wait);}
      const result=await rawSendMessage(jid,content);
      const artist=context?.artist;
      // Si el mensaje ya contiene la foto de perfil como imagen+caption, NO se manda otra foto.
      if(artist&&!content?.image&&!sock.__artistTrackerEvidenceRunning){sock.__artistTrackerEvidenceRunning=true;try{await sendArtistEvidence(sock,artist,rawSendMessage,jid,context?.analysis||null);}catch(err){console.error(chalk.red(`[EVIDENCE] Error para ${artist}: ${err.message}`));}finally{sock.__artistTrackerEvidenceRunning=false;}}
      lastAutoAlertAt=Date.now();return result;
    });return autoAlertQueue;
  };

  sock.sendMessage=async(...args)=>{
    const [jid,content]=args;const body=content?.text||'';
    console.log(chalk.cyan(`[WA->SEND] destino=${jid} tipo=${content?.text?'texto':content?.image?'imagen':content?.video?'video':'otro'}`));if(body)console.log(chalk.gray(`[WA->SEND] ${body.slice(0,500)}${body.length>500?'...':''}`));
    const result=await rawSendMessage(...args);
    if(!sock.__artistTrackerEvidenceRunning&&!sock.__artistTrackerTestRunning&&typeof body==='string'){
      const match=body.match(/(?:BÚSQUEDA MANUAL:|🎤 \*)([^*\n]+)\*?/i)||body.match(/ARTISTA DETECTADO EN MADRID[\s\S]*?🎤 \*([^*]+)\*/i);const isAlert=/BÚSQUEDA MANUAL:|ARTISTA DETECTADO EN MADRID/i.test(body);
      if(isAlert&&match?.[1]){const artist=match[1].trim(),evidenceDestination=sock.__artistTrackerCommandChatJid||config.targetJid;sock.__artistTrackerEvidenceRunning=true;try{await sendArtistEvidence(sock,artist,rawSendMessage,evidenceDestination,sock.__artistTrackerLastAnalysis||null);}catch(err){console.error(chalk.red(`[EVIDENCE] Error para ${artist}: ${err.message}`));}finally{sock.__artistTrackerEvidenceRunning=false;}}
    }
    return result;
  };
  sock.ev.on('creds.update',saveCreds);
  sock.ev.on('connection.update',async({connection,lastDisconnect,qr})=>{
    if(qr){console.log(chalk.yellow('\n╭────────────────────────────────────────────────────────╮'));console.log(chalk.yellow('│ 📲 ESCANEA ESTE CÓDIGO QR CON WHATSAPP                 │'));console.log(chalk.yellow('│ WhatsApp → Ajustes → Dispositivos vinculados           │'));console.log(chalk.yellow('╰────────────────────────────────────────────────────────╯\n'));qrcode.generate(qr,{small:true});console.log(chalk.yellow('\n⏳ Esperando a que escanees el QR...'));}
    if(connection==='connecting')console.log(chalk.blue('[WA] Conectando con WhatsApp...'));
    if(connection==='open'){restartInProgress=false;if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}console.log(chalk.greenBright('\n╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮'));console.log(chalk.greenBright('┃ 🟢 WHATSAPP CONECTADO CORRECTAMENTE         ┃'));console.log(chalk.greenBright('╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯'));console.log(chalk.gray('[BOOT] Sesión activa y guardada. El QR no será necesario mientras siga activa.'));console.log(chalk.gray('[BOOT] Iniciando primer escaneo ahora...'));if(!global.artistScanTimer){try{await runScanSafely();}catch(err){console.error(chalk.red('[SCAN] Error durante el primer escaneo:'),err);}global.artistScanTimer=setInterval(()=>runScanSafely().catch(err=>console.error(chalk.red('[SCAN] Error:'),err)),config.scan.intervalMs);global.cleanupTimer=setInterval(()=>Promise.resolve(purgeExpiredMedia()).catch(err=>console.error(chalk.red('[CLEANUP] Error:'),err)),60*60*1000);console.log(chalk.green(`[SCHEDULER] Escaneo automático programado cada ${Math.round(config.scan.intervalMs/60000)} minutos.`));}}
    if(connection==='close'){const code=lastDisconnect?.error?.output?.statusCode;const reason=lastDisconnect?.error?.data?.reason||lastDisconnect?.error?.output?.payload?.message||lastDisconnect?.error?.message||'desconocido';console.error(chalk.red(`[WA] Conexión cerrada. Código: ${code??'desconocido'} · ${reason}`));if(code===DisconnectReason.loggedOut){await restartWithoutSession();return;}scheduleReconnect();}
  });
  sock.ev.on('messages.upsert',async({messages})=>{for(const msg of messages){try{rememberMessage(msg);await handleMessage(sock,msg);}catch(err){console.error(chalk.red('[MESSAGE] Error:'),err);}}});
}
process.on('uncaughtException',err=>console.error(chalk.red('[FATAL] Excepción no controlada:'),err));process.on('unhandledRejection',err=>console.error(chalk.red('[FATAL] Promesa rechazada:'),err));
start().catch(err=>{console.error(chalk.red('[BOOT] No se pudo iniciar ArtistTracker:'),err);process.exitCode=1;});
