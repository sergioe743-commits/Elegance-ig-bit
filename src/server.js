// Servidor webhook de Meta para Instagram (DMs + comentarios).
// Recibe eventos, decide si se puede auto-responder o hay que escalar,
// genera la respuesta con Claude y la publica/envia via Graph API.

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const { needsHumanReview, detectAudience } = require("./safety");
const { generateReply } = require("./claude");
const {
sendDirectMessage,
replyToComment,
getMediaCaption,
getUserProfile,
} = require("./instagram");
const { unmarkProcessed, alreadyProcessed, markProcessed, getHistory, appendTurn } = require("./store");
const { startCommentSweep } = require("./commentSweep");
const { startDmSweep } = require("./dmSweep");
const { EXCLUDED_USERNAMES } = require("./excludedAccounts");
const { insertEvent, getRecentEvents } = require("./db");
const { parseWhatsAppWebhookBody } = require("./whatsappEvents");
const {
ESCALATION_HOLDING_MESSAGE_PATIENT,
ESCALATION_HOLDING_MESSAGE_COMMENT,
} = require("./prompts");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
express.json({
verify: (req, _res, buf) => {
req.rawBody = buf;
},
})
);

const EXCLUDED_USERNAMES_SET = new Set(
EXCLUDED_USERNAMES.map((u) => u.toLowerCase())
);

const captionCache = new Map();
async function getCachedMediaCaption(mediaId) {
if (!mediaId) return undefined;
if (captionCache.has(mediaId)) return captionCache.get(mediaId);
try {
const caption = await getMediaCaption(mediaId);
captionCache.set(mediaId, caption);
return caption;
} catch (err) {
console.error("[comment] No se pudo obtener el caption de la publicacion:", describeError(err));
return undefined;
}
}

// Cache de IGSID -> username, para no llamar a la API de Instagram en cada
// mensaje de la misma conversacion solo para saber si hay que excluirla.
const usernameCache = new Map();
async function getCachedUsername(senderId) {
if (!senderId) return null;
if (usernameCache.has(senderId)) return usernameCache.get(senderId);
const profile = await getUserProfile(senderId);
const username = profile?.username || null;
usernameCache.set(senderId, username);
return username;
}

async function isExcludedSender(senderId) {
const username = await getCachedUsername(senderId);
if (!username) return false;
return EXCLUDED_USERNAMES_SET.has(username.toLowerCase());
}

app.get("/webhook", (req, res) => {
const mode = req.query["hub.mode"];
const token = req.query["hub.verify_token"];
const challenge = req.query["hub.challenge"];
if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
console.log("[webhook] Verificacion OK.");
return res.status(200).send(challenge);
}
console.warn("[webhook] Verificacion fallida (token no coincide).");
return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
if (!verifySignature(req)) {
console.warn("[webhook] Firma invalida -- peticion descartada.");
return res.sendStatus(401);
}
res.sendStatus(200);
setImmediate(() => {
handleWebhookEvent(req.body).catch((err) => {
console.error("[webhook] Error procesando evento:", err);
});
});
});

// --- WhatsApp (360dialog) webhook -- canal + WABA (mismo endpoint) -----
// Recibe mensajes entrantes, estados de mensajes salientes, y eventos de
// coexistencia (smb_message_echoes: mensajes que el equipo envio desde la
// app WhatsApp Business). Verifica un secreto compartido (encabezado
// personalizado configurado en 360dialog) para que no cualquiera pueda
// mandarnos eventos falsos, y persiste cada evento en SQLite (src/db.js)
// con deduplicacion -- ya no se pierde nada al reiniciar el proceso.
function verifyWhatsAppWebhookSecret(req) {
const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
if (!expected) return true; // no configurado todavia -- no bloquear en local/dev
return req.get("X-360dialog-Secret") === expected;
}

app.post("/webhook/whatsapp", (req, res) => {
if (!verifyWhatsAppWebhookSecret(req)) {
console.warn("[whatsapp] Secreto invalido -- peticion descartada.");
return res.sendStatus(401);
}
res.sendStatus(200);
try {
const events = parseWhatsAppWebhookBody(req.body);
if (events.length === 0) {
insertEvent({
received_at: new Date().toISOString(),
channel: "whatsapp",
direction: "unknown",
event_type: "unrecognized_payload",
raw: req.body,
});
} else {
for (const evt of events) insertEvent(evt);
}
console.log(`[whatsapp] ${events.length || 1} evento(s) guardado(s).`);
} catch (err) {
console.error("[whatsapp] Error procesando/guardando evento:", describeError(err));
}
});

app.get("/webhook/whatsapp/recent", (req, res) => {
const limit = Math.min(Number(req.query.limit) || 50, 200);
res.json(getRecentEvents(limit, "whatsapp"));
});

function verifySignature(req) {
const signature = req.get("X-Hub-Signature-256");
const secret = process.env.META_APP_SECRET;
if (!signature || !secret || !req.rawBody) return false;
const expected =
"sha256=" +
crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
try {
return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
} catch {
return false;
}
}

async function handleWebhookEvent(body) {
if (body.object !== "instagram") return;
for (const entry of body.entry || []) {
for (const messagingEvent of entry.messaging || []) {
await handleMessagingEvent(messagingEvent).catch((err) =>
console.error("[dm] Error:", describeError(err))
);
}
for (const change of entry.changes || []) {
if (change.field === "comments") {
await handleCommentEvent(change.value).catch((err) =>
console.error("[comment] Error:", describeError(err))
);
}
}
}
}

async function processMessage({ senderId, text, messageId }) {
if (!senderId || !text) return false;
if (await isExcludedSender(senderId)) {
const username = usernameCache.get(senderId);
console.log(`[dm] Ignorado (cuenta excluida: @${username}, sender=${senderId}).`);
return false;
}
if (messageId && alreadyProcessed(messageId)) return false;
if (messageId) markProcessed(messageId);
const conversationKey = `dm:${senderId}`;
if (needsHumanReview(text)) {
console.log(`[dm] Escalado a revision humana (sender=${senderId}).`);
await sendDirectMessage(senderId, ESCALATION_HOLDING_MESSAGE_PATIENT);
appendTurn(conversationKey, text, ESCALATION_HOLDING_MESSAGE_PATIENT);
notifyEscalation({ channel: "dm", senderId, text });
return true;
}
const audience = detectAudience(text);
    const history = getHistory(conversationKey);
    try {
          const reply = await generateReply({ text, audience, channel: "dm", history });
          await sendDirectMessage(senderId, reply);
          appendTurn(conversationKey, text, reply);
          console.log(`[dm] Respondido (audience=${audience}, sender=${senderId}).`);
          return true;
    } catch (err) {
          if (messageId) unmarkProcessed(messageId);
          throw err;
    }
}

// Detecta si un evento de mensajeria trae fotos/video adjuntos (sin texto o
// junto con texto) y devuelve una nota sintetica en espaÃ±ol para dar
// contexto al modelo. Sin esto, un DM que solo trae adjuntos (Meta no manda
// "text" en ese caso) se ignoraba en silencio y la persona se quedaba sin
// ninguna respuesta.
function describeAttachments(event) {
const attachments = event.message?.attachments;
if (!Array.isArray(attachments) || attachments.length === 0) return null;
const types = attachments.map((a) => a?.type).filter(Boolean);
const hasImage = types.includes("image");
const hasVideo = types.includes("video");
if (hasImage && hasVideo) {
return "[La persona ha enviado fotos y/o vÃ­deo directamente por Instagram DM]";
}
if (hasVideo && !hasImage) {
return "[La persona ha enviado un vÃ­deo directamente por Instagram DM]";
}
return "[La persona ha enviado una o varias fotos directamente por Instagram DM]";
}

// Guarda el evento crudo de un DM (y su referral de anuncio, si lo trae)
// en el registro persistente, sin tocar en nada el flujo de respuesta del
// bot -- es aditivo puro. Antes esto se perdia por completo: cuando alguien
// escribe desde el boton "Enviar mensaje" de un anuncio, Meta manda un
// objeto "referral" (con el ad_id) en el evento de mensajeria, y no se
// registraba en ningun sitio.
function logInstagramDmEvent(event, { senderId }) {
try {
const referral = event.referral || event.message?.referral;
insertEvent({
received_at: new Date().toISOString(),
channel: "instagram_dm",
direction: event.message?.is_echo ? "outbound_status" : "inbound",
event_type: referral ? "message_with_referral" : "message",
external_id: event.message?.mid || null,
ig_sender_id: senderId || null,
message_type: event.message?.attachments?.[0]?.type || (event.message?.text ? "text" : null),
text_body: event.message?.text || null,
referral_ad_id: referral?.ad_id || null,
referral_source_type: referral?.source || null,
referral_source_url: null,
referral_headline: referral?.headline || null,
referral_body: referral?.body || null,
raw: event,
});
} catch (err) {
console.error("[dm] No se pudo registrar el evento en el histÃ³rico:", describeError(err));
}
}

async function handleMessagingEvent(event) {
const senderId = event.sender?.id;
logInstagramDmEvent(event, { senderId });
if (event.message?.is_echo) return;
const rawText = event.message?.text;
const attachmentNote = describeAttachments(event);
if (!rawText && !attachmentNote) return;
const text = [rawText, attachmentNote].filter(Boolean).join("\n");
if (!senderId) return;
const messageId = event.message?.mid || `${senderId}-${event.timestamp}`;
await processMessage({ senderId, text, messageId });
}

async function processComment({ commentId, text, fromId, fromUsername, mediaId }) {
if (!commentId || !text) return false;
if (fromId && process.env.IG_ACCOUNT_ID && fromId === process.env.IG_ACCOUNT_ID) {
return false;
}
// El webhook de comentarios normalmente ya trae el username en from.username
// (a diferencia de los DMs, donde solo llega el id). Si por lo que sea no
// viene, se intenta resolver por API como red de seguridad.
const username = fromUsername || (fromId ? await getCachedUsername(fromId) : null);
if (username && EXCLUDED_USERNAMES_SET.has(username.toLowerCase())) {
console.log(`[comment] Ignorado (cuenta excluida: @${username}, comment=${commentId}).`);
return false;
}
if (alreadyProcessed(commentId)) return false;
markProcessed(commentId);
const conversationKey = `comment:${mediaId || "sin-media"}:${fromId || commentId}`;
if (needsHumanReview(text)) {
console.log(`[comment] Escalado a revision humana (comment=${commentId}).`);
await replyToComment(commentId, ESCALATION_HOLDING_MESSAGE_COMMENT);
appendTurn(conversationKey, text, ESCALATION_HOLDING_MESSAGE_COMMENT);
notifyEscalation({ channel: "comment", commentId, text });
return true;
}
const audience = detectAudience(text);
  const history = getHistory(conversationKey);
  const context = await getCachedMediaCaption(mediaId);
  try {
    const reply = await generateReply({
      text,
      audience,
      channel: "comment",
      history,
      context,
    });
    await replyToComment(commentId, reply);
    appendTurn(conversationKey, text, reply);
    console.log(`[comment] Respondido (audience=${audience}, comment=${commentId}).`);
    return true;
  } catch (err) {
    unmarkProcessed(commentId);
    throw err;
  }
}

async function handleCommentEvent(value) {
const commentId = value.id;
const text = value.text;
const fromId = value.from?.id;
const fromUsername = value.from?.username;
const mediaId = value.media?.id;
if (!commentId || !text) return;
await processComment({ commentId, text, fromId, fromUsername, mediaId });
}

async function notifyEscalation(details) {
const url = process.env.ESCALATION_WEBHOOK_URL;
if (!url) return;
try {
const axios = require("axios");
await axios.post(url, {
text: `[ALERTA] Mensaje escalado a revision humana (${details.channel}): "${details.text}"`,
...details,
});
} catch (err) {
console.error("[escalation] No se pudo notificar:", err.message);
}
}

function describeError(err) {
if (err?.response) {
return `HTTP ${err.response.status} -- ${JSON.stringify(err.response.data)}`;
}
return err?.message || String(err);
}

app.get("/", (_req, res) => {
res.send("Elegance IG Bot -- activo.");
});

app.listen(PORT, () => {
console.log(`Elegance IG Bot escuchando en el puerto ${PORT}`);
});

startCommentSweep(processComment);
startDmSweep(processMessage);
