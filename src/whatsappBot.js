// WhatsApp automation for paid Meta Ads leads only.
// Phase 1 deliberately excludes organic/direct/referral WhatsApp conversations.
// Modes: off = disabled, shadow = generate/store only, on = send + store.

const axios = require("axios");
const crypto = require("crypto");
const { db, insertEvent, getRecentEvents } = require("./db");
const { generateReply } = require("./claude");
const { findFormContext, buildFormContext } = require("./metaFormContext");

const MAX_PER_CYCLE = 3;
const MAX_DAILY_REPLIES_PER_CONTACT = 12;
const MAX_MESSAGE_AGE_MS = 12 * 60 * 60 * 1000;
const HUMAN_LOCK_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_TEXT_WINDOW_MS = 2 * 60 * 1000;
const processed = new Set();
const processingContacts = new Set();
let cycleRunning = false;

db.exec(`
CREATE TABLE IF NOT EXISTS bot_reply_claims (
  inbound_key TEXT PRIMARY KEY,
  wa_id TEXT NOT NULL,
  inbound_event_id INTEGER,
  text_hash TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
);
CREATE INDEX IF NOT EXISTS idx_bot_reply_claims_contact_hash
  ON bot_reply_claims(wa_id, text_hash, claimed_at);
`);

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

function botMode() {
  const mode = String(process.env.WHATSAPP_BOT_MODE || "on").toLowerCase();
  return ["off", "shadow", "on"].includes(mode) ? mode : "on";
}

function rowsForContact(waId, limit = 100) {
  return db.prepare(`
    SELECT * FROM events
    WHERE channel = 'whatsapp' AND contact_wa_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(waId, limit);
}

function isMetaAdsLead(waId) {
  if (findFormContext(waId)) return true;
  return Boolean(db.prepare(`
    SELECT 1 FROM events
    WHERE channel = 'whatsapp'
      AND contact_wa_id = ?
      AND direction = 'inbound'
      AND referral_ad_id IS NOT NULL
      AND TRIM(referral_ad_id) <> ''
    LIMIT 1
  `).get(waId));
}

function humanRecentlyIntervened(waId) {
  const row = db.prepare(`
    SELECT received_at FROM events
    WHERE channel = 'whatsapp'
      AND contact_wa_id = ?
      AND direction = 'app_echo'
    ORDER BY id DESC
    LIMIT 1
  `).get(waId);
  if (!row?.received_at) return false;
  const age = Date.now() - new Date(row.received_at).getTime();
  return age >= 0 && age < HUMAN_LOCK_MS;
}

function dailyBotReplies(waId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM events
    WHERE channel = 'whatsapp'
      AND contact_wa_id = ?
      AND direction = 'bot_reply'
      AND event_type <> 'bot_send_failed'
      AND received_at >= ?
  `).get(waId, since);
  return Number(row?.n || 0);
}

function conversationHistory(waId, limit = 12) {
  return rowsForContact(waId, 60)
    .filter((e) => e.text_body && ["inbound", "app_echo", "bot_reply"].includes(e.direction))
    .slice(0, limit)
    .reverse()
    .map((e) => ({
      role: e.direction === "inbound" ? "user" : "assistant",
      content: e.text_body,
    }));
}

function metaContext(waId) {
  const referral = db.prepare(`
    SELECT referral_ad_id, referral_headline, referral_body, referral_source_type
    FROM events
    WHERE channel = 'whatsapp' AND contact_wa_id = ?
      AND referral_ad_id IS NOT NULL
    ORDER BY id ASC
    LIMIT 1
  `).get(waId);
  const formContext = buildFormContext(waId);
  const adContext = referral
    ? [
        "Lead procedente de una campana de Meta Ads que abrio WhatsApp.",
        referral.referral_headline ? `Anuncio: ${referral.referral_headline}` : null,
        referral.referral_body ? `Texto del anuncio: ${referral.referral_body}` : null,
        referral.referral_ad_id ? `Meta ad_id: ${referral.referral_ad_id}` : null,
      ].filter(Boolean).join("\n")
    : "Lead procedente de un formulario de Meta Ads conectado con WhatsApp.";

  return [adContext, formContext].filter(Boolean).join("\n\n");
}

async function sendWhatsApp(to, text) {
  const apiKey = process.env.WHATSAPP_360DIALOG_API_KEY;
  if (!apiKey) throw new Error("Falta WHATSAPP_360DIALOG_API_KEY");
  let lastError = null;
  for (const ep of D360_ENDPOINTS) {
    try {
      const response = await axios.post(ep.url, ep.body(to, text), {
        headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json" },
        timeout: 20000,
      });
      return { endpoint: ep.name, status: response.status, data: response.data };
    } catch (err) {
      lastError = err?.response
        ? `HTTP ${err.response.status} -- ${JSON.stringify(err.response.data)}`
        : err?.message || String(err);
    }
  }
  throw new Error(lastError || "Envio fallido");
}

function persistentReplyId(event, mode) {
  return `bot:${mode}:${event.external_id || `db-${event.id}`}`;
}

function alreadyPersistentlyHandled(event, mode) {
  return Boolean(db.prepare(`
    SELECT 1 FROM events
    WHERE channel = 'whatsapp' AND external_id = ?
    LIMIT 1
  `).get(persistentReplyId(event, mode)));
}

function inboundKey(event) {
  return String(event.external_id || `db-${event.id}`);
}

function normalizedMessageText(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function messageHash(text) {
  return crypto.createHash("sha256").update(normalizedMessageText(text)).digest("hex");
}

function isLatestInboundForContact(event) {
  const row = db.prepare(`
    SELECT id FROM events
    WHERE channel = 'whatsapp'
      AND contact_wa_id = ?
      AND direction = 'inbound'
      AND text_body IS NOT NULL
      AND TRIM(text_body) <> ''
    ORDER BY id DESC
    LIMIT 1
  `).get(event.contact_wa_id);
  return Number(row?.id) === Number(event.id);
}

function hasReplyAfterInbound(event) {
  return Boolean(db.prepare(`
    SELECT 1 FROM events
    WHERE channel = 'whatsapp'
      AND contact_wa_id = ?
      AND id > ?
      AND (
        direction = 'app_echo'
        OR (direction = 'bot_reply' AND event_type <> 'bot_send_failed')
      )
    LIMIT 1
  `).get(event.contact_wa_id, event.id));
}

function claimInbound(event) {
  const key = inboundKey(event);
  const hash = messageHash(event.text_body);
  const recentSince = new Date(Date.now() - DUPLICATE_TEXT_WINDOW_MS).toISOString();

  const duplicateSent = db.prepare(`
    SELECT 1 FROM bot_reply_claims
    WHERE wa_id = ?
      AND text_hash = ?
      AND status IN ('sent','shadow')
      AND claimed_at >= ?
    LIMIT 1
  `).get(event.contact_wa_id, hash, recentSince);
  if (duplicateSent) return false;

  const existing = db.prepare(`
    SELECT status FROM bot_reply_claims WHERE inbound_key = ?
  `).get(key);
  if (existing && existing.status !== "failed") return false;

  const now = new Date().toISOString();
  if (existing?.status === "failed") {
    db.prepare(`
      UPDATE bot_reply_claims
      SET wa_id = ?, inbound_event_id = ?, text_hash = ?, claimed_at = ?, status = 'processing'
      WHERE inbound_key = ?
    `).run(event.contact_wa_id, event.id, hash, now, key);
    return true;
  }

  try {
    db.prepare(`
      INSERT INTO bot_reply_claims
        (inbound_key, wa_id, inbound_event_id, text_hash, claimed_at, status)
      VALUES (?, ?, ?, ?, ?, 'processing')
    `).run(key, event.contact_wa_id, event.id, hash, now);
    return true;
  } catch {
    return false;
  }
}

function markClaim(event, status) {
  db.prepare(`
    UPDATE bot_reply_claims SET status = ? WHERE inbound_key = ?
  `).run(status, inboundKey(event));
}

function storeBotReply(event, reply, mode, sendResult = null, sendError = null) {
  insertEvent({
    received_at: new Date().toISOString(),
    channel: "whatsapp",
    direction: "bot_reply",
    event_type: mode === "shadow" ? "bot_shadow_reply" : (sendError ? "bot_send_failed" : "bot_sent_reply"),
    external_id: persistentReplyId(event, mode),
    contact_wa_id: event.contact_wa_id,
    contact_name: event.contact_name,
    message_type: "text",
    text_body: reply,
    raw: {
      mode,
      source: "meta_ads",
      reply_to: event.external_id,
      sent: Boolean(sendResult),
      send_result: sendResult,
      send_error: sendError,
    },
  });
}

async function processCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    const mode = botMode();
    if (mode === "off") return;

    const events = getRecentEvents(100, "whatsapp");
    let handled = 0;
    for (const event of events) {
      if (handled >= MAX_PER_CYCLE) break;
      if (event.direction !== "inbound" || !event.contact_wa_id || !event.text_body) continue;
      if (!isLatestInboundForContact(event)) continue;
      if (hasReplyAfterInbound(event)) continue;
      if (processingContacts.has(event.contact_wa_id)) continue;

      const key = event.external_id || `db:${event.id}`;
      if (processed.has(key)) continue;
      if (alreadyPersistentlyHandled(event, mode)) {
        processed.add(key);
        continue;
      }
      const age = Date.now() - new Date(event.received_at).getTime();
      if (!(age >= 0 && age < MAX_MESSAGE_AGE_MS)) continue;
      if (!isMetaAdsLead(event.contact_wa_id)) continue;
      if (humanRecentlyIntervened(event.contact_wa_id)) continue;
      if (dailyBotReplies(event.contact_wa_id) >= MAX_DAILY_REPLIES_PER_CONTACT) continue;
      if (!claimInbound(event)) {
        processed.add(key);
        continue;
      }

      processed.add(key);
      processingContacts.add(event.contact_wa_id);
      handled += 1;
      try {
        if (hasReplyAfterInbound(event) || !isLatestInboundForContact(event)) {
          markClaim(event, "superseded");
          continue;
        }

        const history = conversationHistory(event.contact_wa_id).filter(
          (turn) => turn.content !== event.text_body
        );
        const reply = await generateReply({
          text: event.text_body,
          audience: "patient",
          channel: "whatsapp",
          context: metaContext(event.contact_wa_id),
          history,
        });

        if (hasReplyAfterInbound(event) || !isLatestInboundForContact(event)) {
          markClaim(event, "superseded");
          console.log(`[wabot] Respuesta descartada por turno mas reciente para ${event.contact_wa_id}.`);
          continue;
        }

        if (mode === "shadow") {
          storeBotReply(event, reply, mode);
          markClaim(event, "shadow");
          console.log(`[wabot] SHADOW Meta Ads ${event.contact_wa_id}: ${reply}`);
          continue;
        }

        try {
          const sent = await sendWhatsApp(event.contact_wa_id, reply);
          storeBotReply(event, reply, mode, sent, null);
          markClaim(event, "sent");
          console.log(`[wabot] ON Meta Ads ${event.contact_wa_id}: enviado via ${sent.endpoint}`);
        } catch (err) {
          storeBotReply(event, reply, mode, null, err.message);
          markClaim(event, "failed");
          processed.delete(key);
          console.error(`[wabot] Error enviando a ${event.contact_wa_id}: ${err.message}`);
        }
      } catch (err) {
        markClaim(event, "failed");
        processed.delete(key);
        console.error(`[wabot] Error procesando ${event.contact_wa_id}: ${err.message}`);
      } finally {
        processingContacts.delete(event.contact_wa_id);
      }
    }
  } finally {
    cycleRunning = false;
  }
}

function startWhatsAppBot() {
  const timer = setInterval(() => {
    processCycle().catch((err) => console.error("[wabot] Error de ciclo:", err.message));
  }, 15000);
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[wabot] Motor Meta Ads activo en modo ${botMode()} con deduplicacion fuerte por turno y recuperacion de pendientes de hasta 12 horas.`);
  return timer;
}

function status() {
  return {
    ok: true,
    mode: botMode(),
    source: "meta_ads_only",
    modes: ["off", "shadow", "on"],
    hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
    hasWhatsAppApiKey: Boolean(process.env.WHATSAPP_360DIALOG_API_KEY),
    humanLockHours: HUMAN_LOCK_MS / 3600000,
    maxMessageAgeHours: MAX_MESSAGE_AGE_MS / 3600000,
    maxDailyRepliesPerContact: MAX_DAILY_REPLIES_PER_CONTACT,
    duplicateTextWindowSeconds: DUPLICATE_TEXT_WINDOW_MS / 1000,
    strongTurnDeduplication: true,
  };
}

function review(limit = 50) {
  return db.prepare(`
    SELECT id, received_at, contact_wa_id, contact_name, event_type, text_body, raw_json
    FROM events
    WHERE channel = 'whatsapp' AND direction = 'bot_reply'
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.min(Number(limit) || 50, 200));
}

module.exports = { startWhatsAppBot, status, review, isMetaAdsLead };
