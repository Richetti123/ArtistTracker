# ArtistTracker 5.0

Bot de WhatsApp para detectar artistas con actividad en Madrid y avisar al número configurado.

## Flujo de detección
1. Descubre artistas por agendas/ticketing de Madrid y fuentes sociales.
2. Comprueba eventos con Ticketmaster, Fever, Entradas.com, La Ganzúa y Bandsintown.
3. Si existe `TICKETMASTER_API_KEY`, consulta además la Discovery API oficial de Ticketmaster.
4. Identifica primero el artista real. Para nombres homónimos consulta varios candidatos de Spotify y Songstats y, cuando `GEMINI_API_KEY` existe, Gemini compara nombre, canciones, país, género y oyentes para evitar confundir el nombre de una canción con el artista.
5. Verifica oyentes mensuales priorizando **Spotify**. Si Spotify no entrega el contador, utiliza un **scraper de Songstats**, buscando el artista y consultando su perfil/área de Spotify. No se usa Apple Music para validar oyentes mensuales.
6. El mínimo sigue siendo 40.000 oyentes mensuales; una cifra no verificable no permite pasar el filtro.
7. Consulta fuentes de metadata para país/escena y género. Los países se muestran con nombre completo y bandera, por ejemplo `Colombia🇨🇴`, nunca `CO`.
8. Analiza Instagram/TikTok/SoundCloud cuando sus adaptadores responden.
9. Descarga imágenes públicas y ejecuta OCR. Gemini Vision diferencia fotografías reales, portadas, flyers y artwork.
10. Un evento de Madrid confirmado por ticketing cuenta como evidencia fuerte aunque las redes estén caídas.
11. Los avisos automáticos se envían al `targetJid` configurado.
12. Las búsquedas manuales con `.buscar ARTISTA` muestran también la foto de perfil del artista cuando Spotify/Songstats la proporcionan.
13. Los avisos nuevos adjuntan la foto de perfil y, cuando existe material visual público guardado de la detección, también evidencia multimedia.
14. No existe blacklist permanente: un artista puede volver a aparecer si se detecta una nueva oportunidad relevante.
15. El material temporal se limpia automáticamente según `retentionDays`.

## Oyentes mensuales
Spotify es la fuente prioritaria. ArtistTracker intenta:

`Spotify web scraper → Songstats scraper → otras fuentes públicas de identidad`

El scraper de Songstats utiliza perfiles como `https://songstats.com/artist/.../...` y puede consultar la vista de Spotify con `source=spotify&popupStyle=graph&graphDataId=account-popularity`.

No se acepta una cifra inventada. Si no existe un número verificable, el artista no pasa el filtro de 40.000 oyentes.

## Identidad y homónimos
ArtistTracker no debe tratar una coincidencia textual aislada como identidad. Para nombres ambiguos compara:
- nombre del artista en Spotify;
- ID de Spotify;
- títulos de varias canciones asociadas al mismo perfil;
- oyentes mensuales;
- género y país;
- coincidencias en Songstats y otras fuentes;
- análisis de Gemini cuando está disponible.

Una canción llamada, por ejemplo, `Superestrella` no debe convertirse automáticamente en un artista llamado `Superestrella` solo porque apareció en una página de resultados.

## WhatsApp
El número de destino está definido en `lib/config.js` mediante `targetJid`. El escaneo automático utiliza ese destino de forma explícita.

Comandos disponibles para el número autorizado:
- `.buscar ARTISTA` — búsqueda manual.
- `.test` — prueba de envío.
- `.update` — ejecuta `git pull --ff-only` y, si llegaron cambios, reinicia automáticamente ArtistTracker para cargarlos.
- `.ayuda` — ayuda.

`.update` no modifica `gatitabot`; solo ejecuta el pull del repositorio en el que está instalado ArtistTracker.

## Visión IA
Con `GEMINI_API_KEY`, Gemini analiza texto e imágenes para detectar evidencia actual de Madrid y descartar artwork/portadas como ubicación.

## Variables de entorno
```bash
GEMINI_API_KEY=tu_clave_de_google_gemini
GEMINI_VISION_MODEL=gemini-2.5-flash
TICKETMASTER_API_KEY=tu_clave_de_ticketmaster
```

`SONGSTATS_API_KEY` y `ZYLA_API_KEY` ya no son necesarios para el flujo principal de verificación de oyentes; se mantiene compatibilidad con el código heredado si se vuelve a necesitar.

## Arranque
```bash
npm install
npm start
```
La primera ejecución mostrará la bienvenida y el QR de WhatsApp si la sesión todavía no está vinculada.
