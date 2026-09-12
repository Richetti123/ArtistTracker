import { sources, text, urls } from './apis.js';
import { saveRemote } from './store.js';
import { ocrImage } from './ocr.js';
import { config } from './config.js';

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const terms = config.madridTerms.map(x => norm(x));

export function mentionsMadrid(s) {
  const n = norm(s);
  return terms.some(t => n.includes(t)) || /\bmadrid\b/i.test(n);
}

function parseJson(raw, fallback) {
  try {
    const value = raw?.match?.(/\{[\s\S]*\}/)?.[0] || raw;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeImageAnalysis(parsed) {
  return {
    madrid: Boolean(parsed?.madrid),
    confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)),
    currentClue: Boolean(parsed?.currentClue),
    isCoverArt: Boolean(parsed?.isCoverArt),
    sceneType: String(parsed?.sceneType || '').trim(),
    landmark: String(parsed?.landmark || '').trim(),
    landmarkConfidence: Math.max(0, Math.min(1, Number(parsed?.landmarkConfidence) || 0)),
    venue: String(parsed?.venue || '').trim(),
    street: String(parsed?.street || '').trim(),
    signs: Array.isArray(parsed?.signs) ? parsed.signs.map(String).slice(0, 8) : [],
    visualClues: Array.isArray(parsed?.visualClues) ? parsed.visualClues.map(String).slice(0, 8) : [],
    reason: String(parsed?.reason || '').trim()
  };
}

async function analyzeImage(filePath, artist, network) {
  if (!process.env.GEMINI_API_KEY) {
    return { available: false, reason: 'GEMINI_API_KEY no configurada; se conserva OCR/texto, pero no se ejecuta visión multimodal.' };
  }
  const prompt = `Analiza ESTA imagen concreta de una publicación relacionada con el artista "${artist}" en ${network}. No asumas que el artista está en Madrid solo por aparecer en la foto. Determina si la imagen muestra una escena real y potencialmente geolocalizable o si parece portada de canción, portada de álbum, flyer, artwork promocional, captura de pantalla o imagen reutilizada. Busca con mucho detalle: carteles, nombres de calles, estaciones, transporte, comercios, arquitectura, monumentos, plazas, recintos, hoteles, señalética, banderas, matrículas y cualquier texto visible. Comprueba específicamente si existe un lugar histórico o reconocible de Madrid (por ejemplo Puerta del Sol, Plaza Mayor, Palacio Real, Templo de Debod, Gran Vía, Cibeles, Atocha, Almudena, Retiro, Bernabéu, Metropolitano u otro). Si reconoces un lugar, explica qué elemento visual te permite reconocerlo y da una confianza. No inventes una ubicación: si no se puede verificar visualmente, usa madrid=false. También indica si hay pistas de que la foto es reciente, pero no confundas la fecha de subida con la fecha real de la foto. Devuelve SOLO JSON válido: {"madrid":false,"confidence":0,"currentClue":false,"isCoverArt":false,"sceneType":"","landmark":"","landmarkConfidence":0,"venue":"","street":"","signs":[],"visualClues":[],"reason":""}.`;
  const response = await sources.geminiVision(filePath, prompt);
  if (!response) return { available: false, reason: 'La API de visión no devolvió respuesta.' };
  const parsed = normalizeImageAnalysis(parseJson(text(response), {}));
  return { available: true, ...parsed, provider: response.provider, model: response.model };
}

export async function inspectContent(artist, network, data) {
  const all = text(data);
  const links = urls(data);
  const folder = `${norm(artist).replace(/[^a-z0-9_-]/g, '_')}-${Date.now()}`;
  const saved = [];
  const ocrTexts = [];
  const imageAnalyses = [];

  for (const u of links.slice(0, 12)) {
    const isImg = /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u);
    if (!isImg) continue;
    const p = await saveRemote(u, folder);
    if (!p) continue;
    saved.push(p);
    ocrTexts.push(await ocrImage(p));
    if (imageAnalyses.length < config.vision.maxImagesPerPost) {
      console.log(`  │  ├─ 🧠 Visión IA: analizando imagen ${imageAnalyses.length + 1}...`);
      imageAnalyses.push({ path: p, url: u, ...(await analyzeImage(p, artist, network)) });
    }
  }

  const combined = `RED SOCIAL: ${network}\nARTISTA: ${artist}\nTEXTO: ${all.slice(0, 16000)}\nOCR DE IMÁGENES: ${ocrTexts.join('\n')}`;
  const direct = mentionsMadrid(combined);
  const ai = await analyzeWithGemini(combined);
  const visualHits = imageAnalyses.filter(x => x.available && x.madrid && x.confidence >= 0.75 && !x.isCoverArt);
  const landmarks = imageAnalyses.filter(x => x.available && x.landmark && x.landmarkConfidence >= 0.7);
  return {
    network,
    folder,
    saved,
    sourceText: combined,
    directMadrid: direct,
    ai,
    imageAnalyses,
    visualMadrid: visualHits.length > 0,
    landmarkEvidence: landmarks.map(x => ({ landmark: x.landmark, confidence: x.landmarkConfidence, reason: x.reason, path: x.path, url: x.url }))
  };
}

async function analyzeWithGemini(payload) {
  const prompt = `Analiza contenido de una publicación de un artista. Devuelve SOLO JSON válido: {"madrid":true|false,"confidence":0-1,"current":true|false,"date":"","event":"","venue":"","reason":""}. Marca madrid=true solo si hay evidencia de presencia/actividad en Madrid, España. Distingue anuncios futuros, recuerdos, fotos antiguas y menciones casuales. Si solo hay artwork/portadas no lo uses como prueba de ubicación.\n${payload}`;
  const raw = await sources.gemini(prompt);
  const s = text(raw);
  const fallback = { madrid: false, confidence: 0, current: false, reason: 'Sin respuesta JSON de IA' };
  const parsed = parseJson(s, fallback);
  return {
    madrid: Boolean(parsed.madrid),
    confidence: Number(parsed.confidence) || 0,
    current: Boolean(parsed.current),
    date: String(parsed.date || ''),
    event: String(parsed.event || ''),
    venue: String(parsed.venue || ''),
    reason: String(parsed.reason || fallback.reason)
  };
}
