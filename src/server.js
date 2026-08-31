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
} = require("./instagram");
const { getHistory, appendTurn } = require("./memory");
const { startCommentSweep } = require("./commentSweep");
const { startDmSweep } = require("./dmSweep");
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

const processedEventIds = new Set();
const PROCESSED_TTL_MS = 10 * 60 * 1000;
function markProcessed(id) {
      if (!id) return;
      processedEventIds.add(id);
      setTimeout(() => processedEventIds.delete(id), PROCESSED_TTL_MS).unref();
}
function alreadyProcessed(id) {
      return !!id && processedEventIds.has(id);
}

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
      const reply = await generateReply({ text, audience, channel: "dm", history });
      await sendDirectMessage(senderId, reply);
      appendTurn(conversationKey, text, reply);
      console.log(`[dm] Respondido (audience=${audience}, sender=${senderId}).`);
      return true;
}

async function handleMessagingEvent(event) {
      if (event.message?.is_echo) return;
      const text = event.message?.text;
      if (!text) return;
      const senderId = event.sender?.id;
      if (!senderId) return;
      const messageId = event.message?.mid || `${senderId}-${event.timestamp}`;
      await processMessage({ senderId, text, messageId });
}

async function processComment({ commentId, text, fromId, mediaId }) {
      if (!commentId || !text) return false;
      if (fromId && process.env.IG_ACCOUNT_ID && fromId === process.env.IG_ACCOUNT_ID) {
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
}

async function handleCommentEvent(value) {
      const commentId = value.id;
      const text = value.text;
      const fromId = value.from?.id;
      const mediaId = value.media?.id;
      if (!commentId || !text) return;
      await processComment({ commentId, text, fromId, mediaId });
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
