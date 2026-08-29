// Funciones para enviar respuestas a Instagram via Graph API
// (Standard Access -- sobre la propia cuenta profesional de IG del Dr. Quintero).

const axios = require("axios");

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

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

module.exports = { sendDirectMessage, replyToComment };
