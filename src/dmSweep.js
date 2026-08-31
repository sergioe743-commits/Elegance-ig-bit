// Barrido periodico de conversaciones de DM recientes, como red de seguridad
// para las que caen en "Solicitudes de mensajes" (Message Requests) -- estas
// NO disparan el webhook de "messaging" de Meta mientras siguen ahi, asi que
// el bot nunca las ve aunque el usuario haya escrito. Este barrido las
// detecta y las responde usando la misma logica que el webhook
// (processMessage), igual que commentSweep.js hace con los comentarios.
//
// Cada cierto tiempo (por defecto cada 5 minutos):
//  1. Lista las conversaciones recientes del inbox (GET /{ig-id}/conversations
//     incluye, segun la documentacion de Meta, las conversaciones activas de
//     la carpeta de Solicitudes dentro de los ultimos 30 dias).
//  2. Para cada una, mira su ultimo mensaje.
//  3. Si ese ultimo mensaje es del OTRO usuario (no de la propia cuenta) y
//     esta dentro de la ventana de lookback, se procesa con processMessage.
//
// La ventana de lookback (23h por defecto, DM_SWEEP_LOOKBACK_MINUTES=1380)
// se queda deliberadamente por debajo de las 24h que da Meta para responder
// un mensaje entrante, para no intentar enviar respuestas que Meta rechazaria
// por estar fuera de esa ventana.

const { getRecentConversations, getLastMessage } = require("./instagram");

const SWEEP_INTERVAL_MS =
  (Number(process.env.DM_SWEEP_MINUTES) || 5) * 60 * 1000;
const LOOKBACK_MS =
  (Number(process.env.DM_SWEEP_LOOKBACK_MINUTES) || 1380) * 60 * 1000; // 23h
const CONVERSATION_LIMIT =
  Number(process.env.DM_SWEEP_CONVERSATION_LIMIT) || 30;
const FIRST_RUN_DELAY_MS = Number(process.env.FIRST_RUN_DELAY_MS) || 45 * 1000;

function describeError(err) {
  if (err?.response) {
    return `HTTP ${err.response.status} -- ${JSON.stringify(err.response.data)}`;
  }
  return err?.message || String(err);
}

/**
 * Arranca el barrido periodico de DMs.
 * @param {(args: {senderId: string, text: string, messageId?: string}) => Promise<boolean>} processMessage
 *   La misma funcion que usa el webhook para procesar un DM (escalado,
 *   memoria, Claude, envio). Se reutiliza para no duplicar logica.
 */
function startDmSweep(processMessage) {
  async function sweepOnce() {
    const igAccountId = process.env.IG_ACCOUNT_ID;
    if (!igAccountId) return;

    let conversations;
    try {
      conversations = await getRecentConversations(CONVERSATION_LIMIT);
    } catch (err) {
      console.error(
        "[dm-sweep] Error listando conversaciones:",
        describeError(err)
      );
      return;
    }

    const cutoff = Date.now() - LOOKBACK_MS;
    let revisadas = 0;
    let respondidas = 0;

    for (const conversation of conversations) {
      let lastMessage;
      try {
        lastMessage = await getLastMessage(conversation.id);
      } catch (err) {
        console.error(
          `[dm-sweep] Error obteniendo ultimo mensaje de ${conversation.id}:`,
          describeError(err)
        );
        continue;
      }
      if (!lastMessage || !lastMessage.text) continue;
      // Si el ultimo mensaje ya es de la propia cuenta, ya se respondio.
      if (lastMessage.from?.id === igAccountId) continue;

      const msgTime = new Date(lastMessage.created_time).getTime();
      if (Number.isFinite(msgTime) && msgTime < cutoff) continue;

      const senderId = lastMessage.from?.id;
      if (!senderId) continue;

      revisadas++;
      try {
        const respondio = await processMessage({
          senderId,
          text: lastMessage.text,
          messageId: lastMessage.id,
        });
        if (respondio) respondidas++;
      } catch (err) {
        console.error(
          `[dm-sweep] Error respondiendo mensaje de ${senderId}:`,
          describeError(err)
        );
      }
    }

    if (revisadas > 0) {
      console.log(
        `[dm-sweep] Revisadas ${revisadas} conversacion(es) sin respuesta previa, ${respondidas} respondida(s) en este barrido.`
      );
    }
  }

  setTimeout(() => {
    sweepOnce().catch((err) =>
      console.error("[dm-sweep] Error inesperado:", describeError(err))
    );
    setInterval(() => {
      sweepOnce().catch((err) =>
        console.error("[dm-sweep] Error inesperado:", describeError(err))
      );
    }, SWEEP_INTERVAL_MS).unref();
  }, FIRST_RUN_DELAY_MS).unref();
}

module.exports = { startDmSweep };
