// Memoria de conversacion en proceso, por remitente (DM) o por
// comentarista+publicacion (comentarios). Sin esto, cada mensaje se le
// mandaba a Claude aislado, sin ver nada de lo hablado antes -- por eso
// repetia preguntas ya respondidas y saludaba de nuevo en cada turno.
//
// Es memoria en RAM: vive mientras el proceso esta arriba y se pierde en un
// reinicio o un nuevo deploy. Es intencionalmente simple (no hay base de
// datos todavia); si el volumen de conversaciones lo justifica, se puede
// sustituir por Redis u otro almacen persistente sin tocar quien la usa.

const TTL_MS = (Number(process.env.CONVERSATION_TTL_HOURS) || 12) * 60 * 60 * 1000;
const MAX_TURNS = 10; // 10 intercambios (20 mensajes) como maximo por conversacion

const store = new Map(); // key -> { messages: [{role, content}], updatedAt }

/**
 * Devuelve el historial (mas antiguo primero) de una conversacion, o un
 * array vacio si no hay nada guardado o si expiro por inactividad.
 * @param {string} key
 * @returns {Array<{role: "user"|"assistant", content: string}>}
 */
function getHistory(key) {
    const entry = store.get(key);
    if (!entry) return [];
    if (Date.now() - entry.updatedAt > TTL_MS) {
          store.delete(key);
          return [];
    }
    return entry.messages;
}

/**
 * Guarda un turno (mensaje del usuario + respuesta enviada) en el
 * historial de esa conversacion, recortando los turnos mas antiguos si se
 * supera MAX_TURNS.
 * @param {string} key
 * @param {string} userText
 * @param {string} assistantText
 */
function appendTurn(key, userText, assistantText) {
    const entry = store.get(key) || { messages: [], updatedAt: Date.now() };
    entry.messages.push({ role: "user", content: userText });
    entry.messages.push({ role: "assistant", content: assistantText });

  const maxMessages = MAX_TURNS * 2;
    if (entry.messages.length > maxMessages) {
          entry.messages = entry.messages.slice(entry.messages.length - maxMessages);
    }

  entry.updatedAt = Date.now();
    store.set(key, entry);
}

// Limpieza periodica para no acumular en RAM conversaciones ya expiradas.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
          if (now - entry.updatedAt > TTL_MS) store.delete(key);
    }
}, 60 * 60 * 1000).unref();

module.exports = { getHistory, appendTurn };
