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
* (viene en el evento de webhook "messaging" como sender.id).
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
*
* Pedimos varios mensajes (no solo el ultimo) y elegimos el mas reciente
* comparando "created_time" en el propio codigo, en vez de fiarnos de que
* messages.limit(1) devuelva siempre el mensaje realmente mas reciente --
* el orden de este edge no esta garantizado por la doc de Meta, y si algun
* mensaje antiguo se coló primero, el barrido creía que la conversacion
* seguia sin responder y volvia a contestar en cada ciclo.
* @param {string} conversationId
* @returns {Promise<{id: string, text?: string, created_time?: string, from?: {id: string, username?: string}} | null>}
*/
async function getLastMessage(conversationId) {
const url = `${GRAPH_BASE}/${conversationId}`;
const { data } = await axios.get(url, {
params: {
fields: "messages.limit(5){id,message,created_time,from}",
access_token: getAccessToken(),
},
});
const messages = data.messages?.data || [];
if (messages.length === 0) return null;

let last = messages[0];
let lastTime = Date.parse(last.created_time || "") || 0;
for (const msg of messages.slice(1)) {
const t = Date.parse(msg.created_time || "") || 0;
if (t > lastTime) {
last = msg;
lastTime = t;
}
}

return {
id: last.id,
text: last.message,
created_time: last.created_time,
from: last.from,
};
}
/**
* Resuelve el username de Instagram de quien nos escribio un DM, a partir de
* su IGSID (el id que llega en el evento de webhook "messaging", que NO
* incluye username -- solo id). Se usa para la lista de exclusion de cuentas
* que Sergio sigue personalmente, para que el bot no les conteste.
* Si Meta no puede resolverlo (permiso no concedido, IGSID invalido, etc.)
* devuelve null en vez de lanzar, para que el llamador pueda seguir
* funcionando con normalidad (fail-open: si no se puede saber quien es, se
* responde igual, no se bloquea al remitente).
* @param {string} igsid
* @returns {Promise<{username?: string, name?: string} | null>}
*/
async function getUserProfile(igsid) {
if (!igsid) return null;
try {
const url = `${GRAPH_BASE}/${igsid}`;
const { data } = await axios.get(url, {
params: { fields: "username,name", access_token: getAccessToken() },
});
return { username: data.username, name: data.name };
} catch (err) {
return null;
}
}
module.exports = {
sendDirectMessage,
replyToComment,
getMediaCaption,
getRecentMedia,
getMediaComments,
getRecentConversations,
getLastMessage,
getUserProfile,
};
