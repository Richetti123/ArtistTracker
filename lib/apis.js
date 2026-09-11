import axios from 'axios';
import { config } from './config.js';

export const http = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': 'ArtistTracker/2.1' }
});

async function get(url, params = {}, headers = {}) {
  try {
    return (await http.get(url, { params, headers })).data;
  } catch (e) {
    console.error(`[API] ${url} -> ${e.response?.status || e.message}`);
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
  gemini: t => get(config.apis.gemini, { text: t })
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
