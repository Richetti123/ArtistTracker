# ArtistTracker 3.0

Bot de WhatsApp para detectar artistas con actividad en Madrid y avisar al fotógrafo configurado.

## Flujo de detección
1. Descubre artistas por dos vías: fuentes sociales y agendas/ticketing de Madrid.
2. Comprueba eventos directamente con scrapers de Ticketmaster, Fever, Entradas.com, La Ganzúa y Bandsintown.
3. Comprueba oyentes mensuales en este orden: Songstats → Zyla → Spotify web → Music Metrics Vault → Kworb.
4. Consulta Gemini para identificar país/escena, género y contexto del artista.
5. Marca con ⭐ los géneros prioritarios: reggaeton, pop, indie, rock, trap, bachata, dembow y musica criolla.
6. Analiza Instagram/TikTok/SoundCloud cuando sus adaptadores responden.
7. Descarga imágenes públicas y ejecuta OCR.
8. Si `GEMINI_API_KEY` está configurada, ejecuta visión multimodal sobre las imágenes: detecta si son portadas/artwork, busca texto, calles, recintos, monumentos y señales visuales de Madrid y explica la evidencia sin inventar una ubicación.
9. Las portadas de canciones/álbumes no se adjuntan como "evidencia" salvo que la IA determine que contienen una pista geográfica relevante.
10. Un evento de Madrid confirmado por ticketing cuenta como evidencia fuerte aunque las APIs sociales estén caídas.
11. Envía el aviso automáticamente al número configurado y pregunta SÍ/NO.
12. Los avisos automáticos tienen 5 minutos de cooldown entre artistas para evitar spam.
13. NO no crea una blacklist: el artista puede volver a aparecer si posteriormente se detecta otra oportunidad relevante.
14. La falta de respuesta provoca limpieza automática del material a los 7 días.

## Descubrimiento automático
El escaneo ya no interpreta `0 candidatos` de TikTok como "no hay artistas". Las agendas web se consultan de forma independiente y los fallos de cada fuente se registran por separado. Esto permite encontrar un concierto aunque Instagram/TikTok/Starlight estén devolviendo HTTP 500.

## Visión IA
ArtistTracker usa la API oficial de Gemini cuando existe `GEMINI_API_KEY`. El modelo por defecto es `gemini-2.5-flash`. La visión busca específicamente:
- monumentos y lugares históricos de Madrid;
- nombres de calles, plazas, estaciones y recintos;
- carteles, señalética y texto visible;
- arquitectura y otros indicios geográficos;
- diferencias entre una fotografía real, una portada, un flyer o artwork;
- pistas de actualidad, sin confundir la fecha de subida con la fecha de la fotografía.

Si no existe `GEMINI_API_KEY`, el bot conserva OCR + análisis textual y usa el endpoint Starlight como respaldo para texto, pero no puede hacer visión multimodal real.

## Oyentes mensuales
Spotify no expone el contador de oyentes mensuales en su Web API pública. ArtistTracker usa varias fuentes para evitar que una API caída provoque falsos negativos:

`Songstats → Zyla → Spotify web → Music Metrics Vault → Kworb`.

No se inventan cifras: si ninguna fuente devuelve un número verificable, el artista no pasa el filtro de 40.000 oyentes.

## Variables de entorno
Configura al menos una fuente de oyentes y, para visión/IA directa, Gemini:

```bash
SONGSTATS_API_KEY=tu_clave_de_songstats
ZYLA_API_KEY=tu_clave_de_zyla
GEMINI_API_KEY=tu_clave_de_google_gemini
GEMINI_VISION_MODEL=gemini-2.5-flash
```

No guardes estas claves dentro del repositorio.

## APIs sociales
Los endpoints Starlight proporcionados son servicios de terceros/no oficiales y pueden fallar o cambiar. ArtistTracker los trata como adaptadores tolerantes a fallos y usa scrapers/eventos web como vía independiente. Para producción, sustituye cada adaptador por APIs oficiales o fuentes con permiso y respeta sus términos.

## Arranque
```bash
npm install
npm start
```
La primera ejecución mostrará la bienvenida y el QR de WhatsApp si la sesión todavía no está vinculada.
