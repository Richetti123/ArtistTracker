import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
export async function ensureStore(){await mkdir(config.paths.media,{recursive:true});}
export async function saveBuffer(buffer,folder,filename){const dir=join(config.paths.media,folder);await mkdir(dir,{recursive:true});const p=join(dir,filename);await writeFile(p,buffer);return p;}
export async function saveRemote(url,folder,filename){if(!url?.startsWith('http'))return null;try{const r=await fetch(url,{headers:{'User-Agent':'ArtistTracker/2.0'}});if(!r.ok)return null;return saveBuffer(Buffer.from(await r.arrayBuffer()),folder,filename||`asset-${Date.now()}`);}catch{return null;}}
export async function saveBase64(base64,folder,filename='image.jpg'){try{return saveBuffer(Buffer.from(base64.replace(/^data:[^;]+;base64,/,''),'base64'),folder,filename);}catch{return null;}}
export async function deleteCase(folder){const p=join(config.paths.media,folder);if(existsSync(p))await rm(p,{recursive:true,force:true});}
export async function purgeExpiredMedia(){await ensureStore();const now=Date.now();for(const d of await readdir(config.paths.media)){const p=join(config.paths.media,d);try{if(now-(await stat(p)).mtimeMs>config.retentionDays*86400000)await rm(p,{recursive:true,force:true});}catch{}}}
export async function loadState(){try{return JSON.parse(await readFile(config.paths.state,'utf8'));}catch{return {artists:{},pending:{},chats:{}};}}
export async function saveState(s){await mkdir(config.paths.data,{recursive:true});await writeFile(config.paths.state,JSON.stringify(s,null,2));}
