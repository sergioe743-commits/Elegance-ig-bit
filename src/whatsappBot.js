// WhatsApp automation for paid Meta Ads leads only.
// Phase 1 deliberately excludes organic/direct/referral WhatsApp conversations.
// Modes: off = disabled, shadow = generate/store only, on = send + store.

const axios = require("axios");
const { db, insertEvent, getRecentEvents } = require("./db");
const { generateReply } = require("./claude");

const MAX_PER_CYCLE = 3;
const MAX_DAILY_REPLIES_PER_CONTACT = 12;
const MAX_MESSAGE_AGE_MS = 30 * 60 * 1000;
const HUMAN_LOCK_MS = 24 * 60 * 60 * 1000;
const processed = new Set();

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
  const mode = String(process.env.WHATSAPP_BOT_MODE || "shadow").toLowerCase();
  return ["off", "shadow", "on"].includes(mode) ? mode : "shadow";
}

function rowsForContact(waId, limit = 100) {
  return db.prepare(`
    SELECT * FROM events
    WHERE channel = 'whatsapp' AND contact_wa_id = ?
    ORDER BY received_at DESC
    LIMIT ?
  `).all(waId, limit);
}

function isMetaAdsLead(waId) {
  // Eligibility persists for the current contact once WhatsApp has delivered
  // a Click-to-WhatsApp referral/ad id. We never infer paid origin from text.
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
    ORDER BY received_at DESC
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
    ORDER BY received_at ASC
    LIMIT 1
  `).get(waId);
  if (!referral) return "Lead procedente de una campana de Meta Ads que abrio WhatsApp.";
  return [
    "Lead procedente de una campana de Meta Ads que abrio WhatsApp.",
    referral.referral_headline ? `Anuncio: ${referral.referral_headline}` : null,
    referral.referral_body ? `Texto del anuncio: ${referral.referral_body}` : null,
    referral.referral_ad_id ? `Meta ad_id: ${referral.referral_ad_id}` : null,
  ].filter(Boolean).join("\n");
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

function storeBotReply(event, reply, mode, sendResult = null, sendError = null) {
  insertEvent({
    received_at: new Date().toISOString(),
    channel: "whatsapp",
    direction: "bot_reply",
    event_type: mode === "shadow" ? "bot_shadow_reply" : "bot_sent_reply",
    external_id: `bot:${mode}:${event.external_id || event.id}:${Date.now()}`,
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
  const mode = botMode();
  if (mode === "off") return;

  const events = getRecentEvents(100, "whatsapp");
  let handled = 0;
  for (const event of events) {
    if (handled >= MAX_PER_CYCLE) break;
    if (event.direction !== "inbound" || !event.contact_wa_id || !event.text_body) continue;
    const key = event.external_id || `db:${event.id}`;
    if (processed.has(key)) continue;
    const age = Date.now() - new Date(event.received_at).getTime();
    if (!(age >= 0 && age < MAX_MESSAGE_AGE_MS)) continue;

    // Critical Phase-1 gate: no Meta referral = no bot action.
    if (!isMetaAdsLead(event.contact_wa_id)) continue;
    if (humanRecentlyIntervened(event.contact_wa_id)) continue;
    if (dailyBotReplies(event.contact_wa_id) >= MAX_DAILY_REPLIES_PER_CONTACT) continue;

    processed.add(key);
    handled += 1;
    try {
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

      if (mode === "shadow") {
        storeBotReply(event, reply, mode);
        console.log(`[wabot] SHADOW Meta Ads ${event.contact_wa_id}: ${reply}`);
        continue;
      }

      try {
        const sent = await sendWhatsApp(event.contact_wa_id, reply);
        storeBotReply(event, reply, mode, sent, null);
        console.log(`[wabot] ON Meta Ads ${event.contact_wa_id}: enviado via ${sent.endpoint}`);
      } catch (err) {
        storeBotReply(event, reply, mode, null, err.message);
        console.error(`[wabot] Error enviando a ${event.contact_wa_id}: ${err.message}`);
      }
    } catch (err) {
      processed.delete(key); // allow retry on generation/storage failure
      console.error(`[wabot] Error procesando ${event.contact_wa_id}: ${err.message}`);
    }
  }
}

function startWhatsAppBot() {
  const timer = setInterval(() => {
    processCycle().catch((err) => console.error("[wabot] Error de ciclo:", err.message));
  }, 15000);
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[wabot] Motor Meta Ads activo en modo ${botMode()}.`);
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
    maxDailyRepliesPerContact: MAX_DAILY_REPLIES_PER_CONTACT,
  };
}

function review(limit = 50) {
  return db.prepare(`
    SELECT id, received_at, contact_wa_id, contact_name, event_type, text_body, raw_json
    FROM events
    WHERE channel = 'whatsapp' AND direction = 'bot_reply'
    ORDER BY received_at DESC
    LIMIT ?
  `).all(Math.min(Number(limit) || 50, 200));
}

module.exports = { startWhatsAppBot, status, review, isMetaAdsLead };
