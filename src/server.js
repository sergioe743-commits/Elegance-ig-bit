// Servidor webhook de Meta para Instagram (DMs + comentarios).
// Recibe eventos, decide si se puede auto-responder o hay que escalar,
// genera la respuesta con Claude y la publica/envia via Graph API.

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const { needsHumanReview, detectAudience } = require("./safety");
const { generateReply } = require("./claude");
const { sendDirectMessage, replyToComment } = require("./instagram");
const {
    ESCALATION_HOLDING_MESSAGE_PATIENT,
    ESCALATION_HOLDING_MESSAGE_COMMENT,
} = require("./prompts");

const app = express();
const PORT = process.env.PORT || 3000;

// Guardamos el rawBody (necesario para verificar la firma X-Hub-Signature-256).
app.use(
    express.json({
          verify: (req, _res, buf) => {
                  req.rawBody = buf;
          },
    })
  );

// Evita procesar dos veces el mismo evento si Meta reintenta la entrega.
const processedEventIds = new Set();
const PROCESSED_TTL_MS = 10 * 60 * 1000; // 10 min
function markProcessed(id) {
    if (!id) return;
    processedEventIds.add(id);
    setTimeout(() => processedEventIds.delete(id), PROCESSED_TTL_MS).unref();
}
function alreadyProcessed(id) {
    return !!id && processedEventIds.has(id);
}

// ---------------------------------------------------------------------------
// GET /webhook -- verificacion inicial (handshake) exigida por Meta.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// POST /webhook -- eventos reales (mensajes y comentarios).
// ---------------------------------------------------------------------------
app.post("/webhook", (req, res) => {
    if (!verifySignature(req)) {
          console.warn("[webhook] Firma invalida -- peticion descartada.");
          return res.sendStatus(401);
    }

           // Respondemos 200 de inmediato: Meta espera respuesta rapida y reintenta
           // si tarda. El procesamiento real ocurre despues, de forma asincrona.
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
        return false; // longitudes distintas, etc.
  }
}


      async function handleWebhookEvent(body) {
          if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
        // --- DMs (Messenger/Instagram Direct) ---
            for (const messagingEvent of entry.messaging || []) {
                    await handleMessagingEvent(messagingEvent).catch((err) =>
                              console.error("[dm] Error:", describeError(err))
                                                                           );
            }

            // --- Comentarios ---
            for (const change of entry.changes || []) {
                    if (change.field === "comments") {
                              await handleCommentEvent(change.value).catch((err) =>
                                          console.error("[comment] Error:", describeError(err))
                                                                                   );
                    }
            }
  }
      }

async function handleMessagingEvent(event) {
    // Ignoramos eco de nuestros propios mensajes y eventos sin texto (adjuntos,
  // "seen", "delivery", reacciones, etc.).
  if (event.message?.is_echo) return;
    const text = event.message?.text;
    if (!text) return;

  const eventId = event.message?.mid || `${event.sender?.id}-${event.timestamp}`;
    if (alreadyProcessed(eventId)) return;
    markProcessed(eventId);

  const senderId = event.sender?.id;
    if (!senderId) return;

  if (needsHumanReview(text)) {
        console.log(`[dm] Escalado a revision humana (sender=${senderId}).`);
        await sendDirectMessage(senderId, ESCALATION_HOLDING_MESSAGE_PATIENT);
        notifyEscalation({ channel: "dm", senderId, text });
        return;
  }

  const audience = detectAudience(text);
    const reply = await generateReply({ text, audience, channel: "dm" });
    await sendDirectMessage(senderId, reply);
    console.log(`[dm] Respondido (audience=${audience}, sender=${senderId}).`);
}

async function handleCommentEvent(value) {
    // `value.from.id` es quien comenta; ignoramos comentarios que sea la propia
  // cuenta (por ejemplo, si el propio bot o el equipo comenta manualmente).
  const commentId = value.id;
    const text = value.text;
    const fromId = value.from?.id;

  if (!commentId || !text) return;
    if (fromId && process.env.IG_ACCOUNT_ID && fromId === process.env.IG_ACCOUNT_ID) return;

  if (alreadyProcessed(commentId)) return;
    markProcessed(commentId);

  if (needsHumanReview(text)) {
        console.log(`[comment] Escalado a revision humana (comment=${commentId}).`);
        await replyToComment(commentId, ESCALATION_HOLDING_MESSAGE_COMMENT);
        notifyEscalation({ channel: "comment", commentId, text });
        return;
  }

  const audience = detectAudience(text);
    const reply = await generateReply({ text, audience, channel: "comment" });
    await replyToComment(commentId, reply);
    console.log(`[comment] Respondido (audience=${audience}, comment=${commentId}).`);
}

// Notificacion opcional (Slack/Discord/etc.) cuando algo se escala a revision
// humana, para que el equipo de la clinica no dependa de mirar Instagram.
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

// Reduce errores de axios/Anthropic (que traen objetos enormes) a una linea
// legible en los logs, en vez de volcar todo el objeto de error.
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
