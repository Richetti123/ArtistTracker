import { sources, text, urls } from './apis.js';
import { saveRemote } from './store.js';
import { ocrImage } from './ocr.js';
import { config } from './config.js';
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const terms=config.madridTerms.map(x=>norm(x));
export function mentionsMadrid(s){const n=norm(s);return terms.some(t=>n.includes(t))||/\bmadrid\b/i.test(n);}
export async function inspectContent(artist,network,data){const all=text(data);const links=urls(data);const folder=`${norm(artist).replace(/[^a-z0-9_-]/g,'_')}-${Date.now()}`;const saved=[];const ocrTexts=[];for(const u of links.slice(0,12)){const isImg=/\.(jpe?g|png|webp|gif)(\?|$)/i.test(u);if(!isImg)continue;const p=await saveRemote(u,folder);if(p){saved.push(p);ocrTexts.push(await ocrImage(p));}}
const combined=`RED SOCIAL: ${network}\nARTISTA: ${artist}\nTEXTO: ${all.slice(0,16000)}\nOCR DE IMÁGENES: ${ocrTexts.join('\n')}`;
const direct=mentionsMadrid(combined);const ai=await analyzeWithGemini(combined);return{network,folder,saved,sourceText:combined,directMadrid:direct,ai};}
async function analyzeWithGemini(payload){const prompt=`Analiza una publicación de un artista. Devuelve SOLO JSON válido: {"madrid":true|false,"confidence":0-1,"current":true|false,"date":"","event":"","venue":"","reason":""}. Marca madrid=true solo si hay evidencia de presencia/actividad actual en Madrid, España. Distingue anuncios futuros, recuerdos, fotos antiguas y menciones casuales.\n${payload}`;const raw=await sources.gemini(prompt);const s=text(raw);const m=s.match(/\{[\s\S]*\}/);if(!m)return{madrid:false,confidence:0,current:false,reason:'Sin respuesta JSON de IA'};try{return JSON.parse(m[0]);}catch{return{madrid:false,confidence:0,current:false,reason:'JSON inválido'};}}
