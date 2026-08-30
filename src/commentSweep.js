// Barrido periodico de comentarios recientes, como red de seguridad ademas
// del webhook de Meta. Motivo: los webhooks de "comments" no siempre se
// entregan de forma fiable (Meta puede agrupar o descartar entregas cuando
// llegan varios comentarios en poco tiempo), asi que aunque el webhook
// funciona, algunos comentarios reales se quedaban sin respuesta y sin
// ningun rastro en los logs -- este barrido los detecta y los responde.
//
// Cada cierto tiempo (por defecto cada 5 minutos):
//  1. Lista las publicaciones mas recientes de la cuenta.
//  2. Para cada una, lista sus comentarios recientes (con sus respuestas).
//  3. Cualquier comentario de otra persona, dentro de la ventana de tiempo,
//     que NO tenga todavia una respuesta de la propia cuenta, se procesa
//     con la misma logica que usa el webhook (escalado, memoria, Claude,
//     respuesta).
//
// La comprobacion de "¿ya tiene respuesta?" se hace consultando la propia
// API de Instagram (el array `replies` de cada comentario), no solo la
// memoria en RAM del proceso -- asi el barrido sigue funcionando aunque el
// servidor se haya reiniciado entre medias y haya perdido el set de
// eventos ya procesados.

const { getRecentMedia, getMediaComments } = require("./instagram");
const SWEEP_INTERVAL_MS =
  (Number(process.env.COMMENT_SWEEP_MINUTES) || 5) * 60 * 1000;
const LOOKBACK_MS =
  (Number(process.env.COMMENT_SWEEP_LOOKBACK_MINUTES) || 30) * 60 * 1000;
const MEDIA_LIMIT = Number(process.env.COMMENT_SWEEP_MEDIA_LIMIT) || 10;
const FIRST_RUN_DELAY_MS = 30 * 1000; // deja arrancar el servidor primero

function describeError(err) {
  if (err?.response) {
    return `HTTP ${err.response.status} -- ${JSON.stringify(err.response.data)}`;
  }
  return err?.message || String(err);
}
/**
 * Arranca el barrido periodico.
 * @param {(args: {commentId: string, text: string, fromId?: string, mediaId?: string}) => Promise<void>} processComment
 *   La misma funcion que usa el webhook para procesar un comentario (escalado,
 *   memoria, Claude, publicar respuesta). Se reutiliza para no duplicar logica.
 */
function startCommentSweep(processComment) {
  async function sweepOnce() {
    const igAccountId = process.env.IG_ACCOUNT_ID;
    if (!igAccountId) return;

  let media;
    try {
      media = await getRecentMedia(MEDIA_LIMIT);
    } catch (err) {
      console.error("[sweep] Error listando publicaciones:", describeError(err));
      return;
    }
    const cutoff = Date.now() - LOOKBACK_MS;
    let revisados = 0;
    let respondidos = 0;

  for (const item of media) {
    let comments;
    try {
      comments = await getMediaComments(item.id);
    } catch (err) {
      console.error(
        `[sweep] Error listando comentarios de ${item.id}:`,
        describeError(err)
        );
      continue;
    }
    for (const comment of comments) {
      const commentTime = new Date(comment.timestamp).getTime();
      if (Number.isFinite(commentTime) && commentTime < cutoff) continue;
      if (comment.from?.id === igAccountId) continue;

    const yaRespondido = (comment.replies?.data || []).some(
      (r) => r.from?.id === igAccountId
      );
      if (yaRespondido) continue;

    revisados++;
      try {
        const respondio = await processComment({
          commentId: comment.id,
          text: comment.text,
          fromId: comment.from?.id,
          mediaId: item.id,
      });
        if (respondio) respondidos++;
      } catch (err) {
        console.error(
          `[sweep] Error respondiendo comentario ${comment.id}:`,
          describeError(err)
          );
      }
    }
  }

  if (revisados > 0) {
    console.log(
      `[sweep] Revisados ${revisados} comentario(s) sin respuesta previa, ${respondidos} respondido(s) en este barrido.`
      );
  }
  }
  setTimeout(() => {
    sweepOnce().catch((err) =>
      console.error("[sweep] Error inesperado:", describeError(err))
                      );
    setInterval(() => {
      sweepOnce().catch((err) =>
        console.error("[sweep] Error inesperado:", describeError(err))
                        );
                      }, SWEEP_INTERVAL_MS).unref();
  }, FIRST_RUN_DELAY_MS).unref();
}
module.exports = { startCommentSweep };
