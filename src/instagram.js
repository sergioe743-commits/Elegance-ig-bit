// Funciones para enviar respuestas a Instagram via Graph API
// (Standard Access -- sobre la propia cuenta profesional de IG del Dr. Quintero).

const axios = require("axios");

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;

function getAccessToken() {
    const token = process.env.IG_ACCESS_TOKEN;
    if (!token) throw new Error("Falta IG_ACCESS_TOKEN en el entorno.");
    return token;
}
/**
 * Envia un DM de respuesta a un usuario de Instagram.
 * @param {string} recipientIgsid - PSID/IGSID del usuario que escribio el DM
 *   (viene en el evento de webhook "messaging" como sender.id).
 * @param {string} messageText - Texto a enviar.
 */
async function sendDirectMessage(recipientIgsid, messageText) {
    const igAccountId = process.env.IG_ACCOUNT_ID;
    if (!igAccountId) throw new Error("Falta IG_ACCOUNT_ID en el entorno.");

const url = `${GRAPH_BASE}/${igAccountId}/messages`;
    const payload = {
        recipient: { id: recipientIgsid },
        message: { text: messageText },
    };

const { data } = await axios.post(url, payload, {
    params: { access_token: getAccessToken() },
});
    return data;
}
/**
 * Publica una respuesta publica a un comentario de Instagram.
 * @param {string} commentId - ID del comentario original.
 * @param {string} messageText - Texto de la respuesta.
 */
async function replyToComment(commentId, messageText) {
    const url = `${GRAPH_BASE}/${commentId}/replies`;

const { data } = await axios.post(url, null, {
    params: {
        message: messageText,
        access_token: getAccessToken(),
    },
});
    return data;
}
/**
 * Obtiene el caption (texto) de una publicacion, para dar contexto a Claude
 * cuando responde a un comentario (p.ej. saber que la publicacion es sobre
 * "abdomen" cuando alguien comenta solo "¿cuanto cuesta?").
 * @param {string} mediaId
 * @returns {Promise<string>} El caption, o cadena vacia si no tiene.
 */
async function getMediaCaption(mediaId) {
    const url = `${GRAPH_BASE}/${mediaId}`;

const { data } = await axios.get(url, {
    params: { fields: "caption", access_token: getAccessToken() },
});
    return data.caption || "";
}
/**
 * Lista las publicaciones mas recientes de la cuenta (para el barrido
 * periodico de comentarios que el webhook pudo no haber entregado).
 * @param {number} limit
 * @returns {Promise<Array<{id: string, caption?: string, timestamp: string}>>}
 */
async function getRecentMedia(limit = 10) {
    const igAccountId = process.env.IG_ACCOUNT_ID;
    if (!igAccountId) throw new Error("Falta IG_ACCOUNT_ID en el entorno.");

const url = `${GRAPH_BASE}/${igAccountId}/media`;
    const { data } = await axios.get(url, {
        params: {
            fields: "id,caption,timestamp",
            limit,
            access_token: getAccessToken(),
        },
    });
    return data.data || [];
}
/**
 * Lista los comentarios de una publicacion, incluyendo sus respuestas (para
 * poder detectar si ya se respondio a cada uno), para el barrido periodico.
 * @param {string} mediaId
 * @param {number} limit
 * @returns {Promise<Array<{id, text, timestamp, from, replies}>>}
 */
async function getMediaComments(mediaId, limit = 50) {
    const url = `${GRAPH_BASE}/${mediaId}/comments`;
    const { data } = await axios.get(url, {
        params: {
            fields: "id,text,timestamp,from,replies{id,from,timestamp}",
            limit,
            access_token: getAccessToken(),
},
    });
    return data.data || [];
}
/**
 * Lista las conversaciones recientes del inbox de Instagram, incluyendo las
 * que estan en "Solicitudes de mensajes" (Message Requests) activas dentro
 * de los ultimos 30 dias -- segun la documentacion de Meta para este
 * endpoint. Se usa para el barrido periodico de DMs, red de seguridad para
 * los mensajes que caen en Solicitudes y por eso nunca disparan el webhook
 * de "messaging".
 * @param {number} limit
 * @returns {Promise<Array<{id: string, updated_time?: string, participants?: object}>>}
 */
async function getRecentConversations(limit = 30) {
    const igAccountId = process.env.IG_ACCOUNT_ID;
    if (!igAccountId) throw new Error("Falta IG_ACCOUNT_ID en el entorno.");

    // La doc de Meta solo documenta id + updated_time como respuesta de este
    // endpoint (GET /{ig-id}/conversations?platform=instagram); no confirma
    // "participants" como campo valido aqui, y pedir un campo invalido puede
    // devolver un error 400 para toda la llamada. Por eso no lo pedimos --
    // el remitente de cada conversacion se obtiene igualmente del campo
    // "from" del ultimo mensaje en getLastMessage().
    const url = `${GRAPH_BASE}/${igAccountId}/conversations`;
    const { data } = await axios.get(url, {
        params: {
            platform: "instagram",
            fields: "id,updated_time",
            limit,
            access_token: getAccessToken(),
        },
    });
    return data.data || [];
}
/**
 * Obtiene el ultimo mensaje de una conversacion (para saber si quedo sin
 * responder y quien lo escribio), para el barrido periodico de DMs.
 * Usa el patron documentado por Meta: pedir el campo "messages" (con
 * modificador .limit()) sobre el propio nodo de la conversacion, en vez del
 * edge /{conversation-id}/messages.
 * @param {string} conversationId
 * @returns {Promise<{id: string, text?: string, created_time?: string, from?: {id: string, username?: string}} | null>}
 */
async function getLastMessage(conversationId) {
    const url = `${GRAPH_BASE}/${conversationId}`;
    const { data } = await axios.get(url, {
        params: {
            fields: "messages.limit(1){id,message,created_time,from}",
            access_token: getAccessToken(),
        },
    });
    const last = data.messages?.data?.[0];
    if (!last) return null;
    return {
        id: last.id,
        text: last.message,
        created_time: last.created_time,
        from: last.from,
    };
}
module.exports = {
    sendDirectMessage,
    replyToComment,
    getMediaCaption,
    getRecentMedia,
    getMediaComments,
    getRecentConversations,
    getLastMessage,
};
