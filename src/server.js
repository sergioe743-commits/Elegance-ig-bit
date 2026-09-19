// Servidor webhook de Meta para Instagram (DMs + comentarios) y WhatsApp.

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const { needsHumanReview, detectAudience } = require("./safety");
const { generateReply } = require("./claude");
const {
  sendDirectMessage,
  replyToComment,
  getMediaCaption,
  getUserProfile,
} = require("./instagram");
const {
  unmarkProcessed,
  alreadyProcessed,
  markProcessed,
  getHistory,
  appendTurn,
} = require("./store");
const { startCommentSweep } = require("./commentSweep");
const { startDmSweep } = require("./dmSweep");
const { EXCLUDED_USERNAMES } = require("./excludedAccounts");
const { insertEvent, getRecentEvents } = require("./db");
const { parseWhatsAppWebhookBody } = require("./whatsappEvents");
const { saveFormContext } = require("./metaFormContext");
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

// Instagram: every new inbound DM is a potential lead. Do not require the
// patient to prove clinical intent before receiving a first reply. This is
// especially important for Message Requests, greetings, phone numbers and
// replies to stories/reels, where the clinical context may not be present in
// the text returned by Meta.
//
// We keep only a narrow explicit block for clearly non-clinical supplier/
// collaboration conversations. Once a conversation has already been handled
// by the bot, do not block it later merely because a word overlaps this list.
const IG_DM_NON_CLINIC_INTENT = /\b(fot[oó]graf[oa]|fotograf[ií]a\s+profesional|sesi[oó]n\s+de\s+(?:fotos?|retrato)|retrato\s+(?:profesional|corporativo)|portfolio|community\s*manager|diseñador|proveedor|presupuesto\s+de\s+obra|arquitect[oa]|ingenier[oa]|aparejador|reforma|colaboraci[oó]n\s+comercial)\b/i;

function shouldAutoReplyToInstagramDm({ text, history, hasReferral = false }) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (hasReferral) return true;
  if (Array.isArray(history) && history.length > 0) return true;
  if (IG_DM_NON_CLINIC_INTENT.test(value)) return false;
  // New inbound contacts are answered by default. The AI then identifies the
  // intent from the message/context instead of silently discarding leads.
  return true;
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

function verifyWhatsAppWebhookSecret(req) {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected) return true;
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

// Structured Meta Instant Form answers. Zapier/CRM can POST the form payload
// here before the person opens WhatsApp. The bot then matches it by phone and
// uses the answers as internal CRM context, avoiding repeated questions.
app.post("/webhook/meta-lead", (req, res) => {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected) {
    return res.status(503).json({ ok: false, error: "Webhook secret not configured." });
  }
  if (req.get("X-Elegance-Secret") !== expected) {
    return res.status(401).json({ ok: false, error: "Invalid secret." });
  }
  try {
    const row = saveFormContext(req.body || {});
    if (!row.wa_id) {
      return res.status(400).json({ ok: false, error: "No usable phone number found in lead payload." });
    }
    console.log(`[meta-lead] Form context stored for ${row.wa_id}.`);
    return res.json({ ok: true, lead_id: row.lead_id, matched_phone: row.wa_id });
  } catch (err) {
    console.error("[meta-lead] Error guardando contexto:", describeError(err));
    return res.status(500).json({ ok: false, error: "Could not store form context." });
  }
});

function verifySignature(req) {
  const signature = req.get("X-Hub-Signature-256");
  const secret = process.env.META_APP_SECRET;
  if (!signature || !secret || !req.rawBody) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
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

async function processMessage({ senderId, text, messageId, hasReferral = false }) {
  if (!senderId || !text) return false;
  if (await isExcludedSender(senderId)) {
    const username = usernameCache.get(senderId);
    console.log(`[dm] Ignorado (cuenta excluida: @${username}, sender=${senderId}).`);
    return false;
  }
  if (messageId && alreadyProcessed(messageId)) return false;

  const conversationKey = `dm:${senderId}`;
  const history = getHistory(conversationKey);
  if (!shouldAutoReplyToInstagramDm({ text, history, hasReferral })) {
    console.log(`[dm] Ignorado (sin intención clínica/formativa confirmada, sender=${senderId}).`);
    if (messageId) markProcessed(messageId);
    return false;
  }

  if (messageId) markProcessed(messageId);
  if (needsHumanReview(text)) {
    console.log(`[dm] Escalado a revision humana (sender=${senderId}).`);
    await sendDirectMessage(senderId, ESCALATION_HOLDING_MESSAGE_PATIENT);
    appendTurn(conversationKey, text, ESCALATION_HOLDING_MESSAGE_PATIENT);
    notifyEscalation({ channel: "dm", senderId, text });
    return true;
  }

  const audience = detectAudience(text);
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

function describeAttachments(event) {
  const attachments = event.message?.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  const types = attachments.map((a) => a?.type).filter(Boolean);
  const hasImage = types.includes("image");
  const hasVideo = types.includes("video");
  if (hasImage && hasVideo) {
    return "[La persona ha enviado fotos y/o video directamente por Instagram DM]";
  }
  if (hasVideo && !hasImage) {
    return "[La persona ha enviado un video directamente por Instagram DM]";  }
  return "[La persona ha enviado una o varias fotos directamente por Instagram DM]";
}

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
    console.error("[dm] No se pudo registrar el evento en el historico:", describeError(err));
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
  const hasReferral = Boolean(event.referral || event.message?.referral);
  await processMessage({ senderId, text, messageId, hasReferral });
}

async function processComment({ commentId, text, fromId, fromUsername, mediaId }) {
  if (!commentId || !text) return false;
  if (fromId && process.env.IG_ACCOUNT_ID && fromId === process.env.IG_ACCOUNT_ID) {
    return false;
  }

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

// Endpoint de diagnostico manual para 360dialog. No ejecuta ningun sondeo ni
// responde automaticamente a pacientes. Se conserva solo para pruebas puntuales.
const D360_ENDPOINTS = [
  {
    name: "cloud-v2",
    url: "https://waba-v2.360dialog.io/messages",
    body: (to, text) => ({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    }),
  },
  {
    name: "legacy-v1",
    url: "https://waba.360dialog.io/v1/messages",
    body: (to, text) => ({ to, type: "text", text: { body: text } }),
  },
];

app.get("/whatsapp/send-test", (_req, res) => {
  res.json({
    ok: true,
    endpointDesplegado: true,
    tieneApiKey: Boolean(process.env.WHATSAPP_360DIALOG_API_KEY),
    tieneSecreto: Boolean(process.env.WHATSAPP_WEBHOOK_SECRET),
  });
});

app.post("/whatsapp/send-test", async (req, res) => {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected) {
    return res.status(503).json({
      ok: false,
      error: "WHATSAPP_WEBHOOK_SECRET no configurado: endpoint deshabilitado.",
    });
  }
  if (req.get("X-360dialog-Secret") !== expected) {
    return res.status(401).json({ ok: false, error: "Secreto invalido." });
  }

  const apiKey = process.env.WHATSAPP_360DIALOG_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "Falta WHATSAPP_360DIALOG_API_KEY en el entorno.",
    });
  }

  const to = String(req.body?.to || "").replace(/[^0-9]/g, "");
  const text = String(req.body?.text || "").trim();
  if (!to || !text) {
    return res.status(400).json({ ok: false, error: "Faltan 'to' (solo digitos) o 'text'." });
  }

  const intentos = [];
  for (const ep of D360_ENDPOINTS) {
    try {
      const r = await axios.post(ep.url, ep.body(to, text), {
        headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json" },
        timeout: 20000,
      });
      intentos.push({ endpoint: ep.name, ok: true, status: r.status, data: r.data });
      console.log(`[whatsapp] Envio de prueba OK via ${ep.name} -> ${to}`);
      return res.json({ ok: true, enviadoPor: ep.name, intentos });
    } catch (err) {
      intentos.push({ endpoint: ep.name, ok: false, error: describeError(err) });
      console.warn(`[whatsapp] Envio de prueba fallo via ${ep.name}: ${describeError(err)}`);
    }
  }

  return res.status(502).json({
    ok: false,
    error: "Ningun endpoint de 360dialog acepto el envio.",
    intentos,
  });
});