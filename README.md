# ArtistTracker 2.1

Bot de WhatsApp para detectar artistas con actividad en Madrid y avisar al fotógrafo configurado.

## Flujo
1. Busca candidatos por los países configurados.
2. Consulta Instagram/TikTok/SoundCloud mediante los endpoints Starlight configurados.
3. Consulta una fuente de oyentes mensuales y descarta artistas por debajo de 40.000.
4. Consulta Gemini para identificar el género del artista.
5. Marca con ⭐ los géneros prioritarios: reggaeton, pop, indie, rock, trap, bachata, dembow y musica criolla.
6. Descarga imágenes públicas cuando la fuente entrega URLs.
7. Ejecuta OCR en imágenes y busca Madrid/localizaciones.
8. Envía el texto y OCR a Gemini para distinguir presencia actual de una simple mención.
9. Incluye enlaces de búsqueda de entradas en sitios oficiales/configurados.
10. Envía el aviso automáticamente al número configurado.
11. Pregunta SÍ/NO. NO elimina el material multimedia asociado, pero **no crea una blacklist**: el artista puede volver a aparecer si posteriormente se detecta otra oportunidad relevante.
12. La falta de respuesta provoca limpieza automática del material a los 7 días.

## Consola
Al arrancar muestra una bienvenida y un panel de estado. Durante el funcionamiento informa de:
- países que está escaneando;
- candidatos encontrados;
- oyentes mensuales y fuente utilizada;
- género detectado;
- redes analizadas;
- evidencia de Madrid;
- avisos enviados;
- mensajes recibidos por WhatsApp;
- errores de API y reconexiones.

La estructura de los mensajes de consola está inspirada en el estilo de salida de PayBalance, pero **PayBalance no se modifica**.

## Oyentes mensuales: Songstats + alternativa
Spotify no expone el contador de oyentes mensuales en su Web API pública. Songstats sí ofrece una Enterprise API con estadísticas de artistas, incluyendo `monthly_listeners`, pero requiere una API key. Si se configura `SONGSTATS_API_KEY`, ArtistTracker intenta usar Songstats cuando dispone de un ID de Songstats.

Como alternativa práctica, se añadió la API de Zyla para obtener oyentes mensuales por nombre de artista. Configura `ZYLA_API_KEY` para activarla. El orden es:

`Songstats (si se puede identificar el artista) → Zyla → sin dato = no pasa el filtro`.

No se inventan cifras: si ninguna fuente devuelve un número verificable, el artista se descarta.

## Variables de entorno
Configura al menos una fuente de oyentes:

```bash
SONGSTATS_API_KEY=tu_clave_de_songstats
ZYLA_API_KEY=tu_clave_de_zyla
```

No guardes estas claves dentro del repositorio.

## Importante sobre APIs sociales
Los endpoints Starlight proporcionados por el usuario son servicios de terceros/no oficiales. No hay que asumir que Instagram, TikTok, Spotify o Facebook permiten acceso arbitrario a contenido privado. Para producción, sustituye cada adaptador por APIs oficiales o fuentes con permiso y respeta sus términos.

## Arranque
```bash
npm install
npm start
```
La primera ejecución mostrará la bienvenida, el estado del bot y después el QR de WhatsApp si la sesión todavía no está vinculada.
