# ArtistTracker 2.0

Bot de WhatsApp para detectar artistas con actividad en Madrid y avisar al fotógrafo configurado.

## Flujo
1. Busca candidatos por los países configurados.
2. Consulta Instagram/TikTok/SoundCloud mediante los endpoints configurados.
3. Descarga imágenes públicas cuando la fuente entrega URLs.
4. Ejecuta OCR en imágenes (español + inglés) y busca Madrid/localizaciones.
5. Envía el texto y OCR a Gemini para distinguir presencia actual de una simple mención.
6. Aplica el filtro mínimo de 40.000 oyentes mensuales **solo cuando exista una fuente verificada**. El proyecto falla cerrado si la cifra no está disponible; no inventa oyentes.
7. Incluye enlaces de búsqueda de entradas en sitios oficiales/configurados.
8. Envía el aviso automáticamente al número configurado.
9. Pregunta SÍ/NO. NO elimina el material multimedia asociado; la falta de respuesta provoca limpieza automática a los 7 días.

## Importante sobre APIs
Los endpoints Starlight proporcionados por el usuario son servicios de terceros/no oficiales. No hay que asumir que Instagram, TikTok, Spotify o Facebook permiten acceso arbitrario a contenido privado. Para producción, sustituye cada adaptador por APIs oficiales o fuentes con permiso y respeta sus términos.

Spotify no ofrece en su Web API pública el contador de "oyentes mensuales" que aparece en el perfil. Por eso el filtro de 40.000 no se puede falsificar con una API que no lo exponga. Añade una fuente verificada en `verifiedListeners()` antes de activar el rastreo en producción.

## Variables/configuración
Todo está en `lib/config.js`: número destino, países, 40k, Madrid, intervalo, APIs y sitios de entradas.

## Arranque
```bash
npm install
npm start
```
La primera ejecución mostrará el QR de WhatsApp en la terminal.
