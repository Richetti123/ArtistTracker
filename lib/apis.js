import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { config } from './config.js';

export const http = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': 'ArtistTracker/3.0' }
});

async function get(url, params = {}, headers = {}) {
  try {
    return (await http.get(url, { params, headers })).data;
  } catch (e) {
    console.error(`[API] ${url} -> ${e.response?.status || e.message}`);
    return null;
  }
}

async function geminiGenerate(contents, label = 'texto') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.vision.model}:generateContent`;
    const response = await http.post(url, {
      contents: [{ role: 'user', parts: contents }],
      generationConfig: { temperature: 0.15 }
    }, {
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }
    });
    const parts = response.data?.candidates?.[0]?.content?.parts || [];
    const output = parts.map(part => part.text).filter(Boolean).join('\n').trim();
    if (!output) throw new Error(`Gemini no devolvió texto para ${label}`);
    return { text: output, provider: 'Google Gemini API', model: config.vision.model };
  } catch (e) {
    console.error(`[AI] Google Gemini (${label}) -> ${e.response?.status || e.message}`);
    return null;
  }
}

export const sources = {
  instagramPosts: q => get(config.apis.instagramPosts, { text: q }),
  instagramDl: u => get(config.apis.instagramDl, { url: u }),
  tiktokSearch: q => get(config.apis.tiktokSearch, { text: q }),
  tiktokUserPosts: u => get(config.apis.tiktokUserPosts, { user: u }),
  tiktokDl: u => get(config.apis.tiktokDl, { url: u }),
  tiktokImages: u => get(config.apis.tiktokImages, { url: u }),
  soundcloudSearch: q => get(config.apis.soundcloudSearch, { text: q }),
  gemini: async t => {
    const direct = await geminiGenerate([{ text: String(t || '') }], 'texto');
    if (direct) return direct;
    return get(config.apis.gemini, { text: t });
  },
  geminiVision: async (filePath, prompt) => {
    if (!process.env.GEMINI_API_KEY) return null;
    try {
      const buffer = await readFile(filePath);
      if (buffer.length > config.vision.maxImageBytes) {
        console.log(`[AI-VISION] Imagen omitida por tamaño: ${Math.round(buffer.length / 1024 / 1024)} MB`);
        return null;
      }
      const ext = extname(filePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
      return geminiGenerate([
        { inlineData: { mimeType, data: buffer.toString('base64') } },
        { text: String(prompt || '') }
      ], 'visión');
    } catch (e) {
      console.error(`[AI-VISION] Error preparando imagen -> ${e.message}`);
      return null;
    }
  }
};

export async function songstatsStats(songstatsArtistId) {
  const key = process.env.SONGSTATS_API_KEY;
  if (!key || !songstatsArtistId) return null;
  return get(`${config.listenerProviders.songstatsBase}/artists/stats`, {
    songstats_artist_id: songstatsArtistId,
    source: 'spotify'
  }, { apikey: key });
}

export async function zylaMonthlyListeners(artist) {
  const key = process.env.ZYLA_API_KEY;
  if (!key) return null;
  return get(config.listenerProviders.zylaUrl, { artist: String(artist).trim().replace(/\s+/g, '-') }, {
    Authorization: `Bearer ${key}`
  });
}

export function flatten(v) {
  if (v == null) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(flatten);
  if (typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [k, ...flatten(x)]);
  return [String(v)];
}

export function text(v) {
  return flatten(v).filter(x => x.length > 1).join('\n');
}

export function urls(v) {
  return flatten(v).filter(x => /^https?:\/\//i.test(x));
}
