import axios from 'axios';
import { config } from './config.js';
export const http=axios.create({timeout:30000,headers:{'User-Agent':'ArtistTracker/2.0'}});
async function get(url,params={}){try{return (await http.get(url,{params})).data;}catch(e){console.error(`[API] ${url}`,e.response?.status||e.message);return null;}}
export const sources={instagramPosts:q=>get(config.apis.instagramPosts,{text:q}),instagramDl:u=>get(config.apis.instagramDl,{url:u}),tiktokSearch:q=>get(config.apis.tiktokSearch,{text:q}),tiktokUserPosts:u=>get(config.apis.tiktokUserPosts,{user:u}),tiktokDl:u=>get(config.apis.tiktokDl,{url:u}),tiktokImages:u=>get(config.apis.tiktokImages,{url:u}),soundcloudSearch:q=>get(config.apis.soundcloudSearch,{text:q}),gemini:t=>get(config.apis.gemini,{text:t})};
export function flatten(v){if(v==null)return[];if(typeof v==='string')return[v];if(Array.isArray(v))return v.flatMap(flatten);if(typeof v==='object')return Object.entries(v).flatMap(([k,x])=>[k,...flatten(x)]);return[String(v)];}
export function text(v){return flatten(v).filter(x=>x.length>1).join('\n');}
export function urls(v){return flatten(v).filter(x=>/^https?:\/\//i.test(x));}
