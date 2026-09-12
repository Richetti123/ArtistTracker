import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export const config = {
  timezone: 'Europe/Madrid',
  targetJid: '34641307273@s.whatsapp.net',
  testTargetJid: '34641307273@s.whatsapp.net',
  minMonthlyListeners: 40000,
  countries: ['Mexico','Peru','Colombia','Chile','Argentina','Venezuela','Bolivia','Ecuador','Puerto Rico','Dominican Republic','Spain','Paraguay','Uruguay'],
  madridTerms: ['madrid','madrid, españa','madrid españa','comunidad de madrid','iberia madrid','barajas','t4 madrid','lavapiés','malasaña','gran vía','sol, madrid','chueca, madrid','retiro, madrid','puerta del sol','plaza mayor','palacio real','templo de debod','gran via','atocha','recoletos','castellana','cibeles','neptuno','almudena','santiago bernabeu','metropolitano'],
  preferredGenres: ['reggaeton','pop','indie','rock','trap','bachata','dembow','musica criolla'],
  scan: {
    intervalMs: 30 * 60 * 1000,
    maxCandidatesPerCountry: 30,
    postsPerArtist: 12,
    maxMadridEventCandidates: 40,
    eventLookaheadDays: 180,
    discoveryPages: 12
  },
  alerts: {
    cooldownMs: 5 * 60 * 1000,
    queueOnlyAutomatic: true
  },
  vision: {
    enabled: true,
    model: process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash',
    maxImagesPerPost: 4,
    maxImageBytes: 8 * 1024 * 1024
  },
  retentionDays: 7,
  apis: {
    base: 'https://apis-starlights-team.koyeb.app/starlight',
    gemini: 'https://apis-starlights-team.koyeb.app/starlight/gemini',
    instagramPosts: 'https://apis-starlights-team.koyeb.app/starlight/ig-posts',
    instagramDl: 'https://apis-starlights-team.koyeb.app/starlight/instagram-dl',
    tiktokSearch: 'https://apis-starlights-team.koyeb.app/starlight/tiktoksearch',
    tiktokUserPosts: 'https://apis-starlights-team.koyeb.app/starlight/tiktok-user-posts',
    tiktokDl: 'https://apis-starlights-team.koyeb.app/starlight/tiktok',
    tiktokImages: 'https://apis-starlights-team.koyeb.app/starlight/tiktok-images',
    soundcloudSearch: 'https://apis-starlights-team.koyeb.app/starlight/soundcloud-search'
  },
  listenerProviders: {
    songstatsBase: 'https://api.songstats.com/enterprise/v1',
    zylaUrl: 'https://zylalabs.com/api/1728/artist+on+spotify+monthly+listeners+api/1341/fetch+artist+monthly+listeners'
  },
  ticketSites: [
    { name: 'Ticketmaster España', url: 'https://www.ticketmaster.es/', search: 'https://www.ticketmaster.es/search?keyword={artist}' },
    { name: 'Fever Madrid', url: 'https://feverup.com/es/madrid/conciertos-festivales', search: 'https://feverup.com/es/madrid/conciertos-festivales?query={artist}' },
    { name: 'Entradas.com Madrid', url: 'https://www.entradas.com/city/madrid-370/', search: 'https://www.entradas.com/search/?keyword={artist}' },
    { name: 'La Ganzúa', url: 'https://www.laganzua.net/conciertos/madrid/', search: 'https://www.laganzua.net/conciertos/entradas-{artist}' }
  ],
  paths: { root, data: join(root, 'data'), media: join(root, 'data', 'media'), sessions: join(root, 'sessions'), state: join(root, 'data', 'state.json') }
};
