const axios = require("axios");
const { insertEvent } = require("./db");

const LOOKBACK_HOURS = 12;
const SYNC_INTERVAL_MS = 2 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_PAGES = 3;
let syncRunning = false;

function configured() {
  return Boolean(process.env.GETCHAT_BASE_URL && process.env.WHATSAPP_360DIALOG_API_KEY);
}

function baseUrl() {
  return String(process.env.GETCHAT_BASE_URL || "").replace(/\/+$/, "");
}

function providerHeaders() {
  return {
    "D360-Api-Key": process.env.WHATSAPP_360DIALOG_API_KEY,
    Accept: "application/json",
  };
}

function listFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function extractReferral(message) {
  const referral = message?.referral || message?.context?.referral;
  if (!referral) return {};
  return {
    referral_ad_id: referral.source_id || referral.ad_id || null,
    referral_source_type: referral.source_type || null,
    referral_source_url: referral.source_url || null,
    referral_headline: referral.headline || null,
    referral_body: referral.body || null,
  };
}

function timestampToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  const ms = n > 10_000_000_000 ? n : n * 1000;
  return new Date(ms).toISOString();
}

function normalizeInboxMessage(row) {
  if (!row || row.from_us === true) return null;
  const msg = row.waba_payload || {};
  const waId = row.customer_wa_id || row.contact?.wa_id || row.contact?.waba_payload?.wa_id || msg.from || null;
  const textBody = msg.text?.body || null;
  if (!waId || !textBody) return null;
  const externalId = msg.id || row.id || null;
  const contactName = row.contact?.waba_payload?.profile?.name || row.contact?.profile?.name || null;
  return {
    received_at: timestampToIso(msg.timestamp || row.timestamp || row.since_time),
    channel: "whatsapp",
    direction: "inbound",
    event_type: "inbox_recovered_message",
    external_id: externalId,
    contact_wa_id: String(waId),
    contact_name: contactName,
    message_type: msg.type || "text",
    text_body: textBody,
    status: null,
    ...extractReferral(msg),
    raw: { source: "getchat_inbox_recovery", inbox_message: row },
  };
}

async function fetchRecentInboxMessages() {
  const sinceTime = Math.floor((Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000) / 1000);
  const all = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await axios.get(`${baseUrl()}/api/v1/messages/`, {
      headers: providerHeaders(),
      params: {
        since_time: sinceTime,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      },
      timeout: 20_000,
    });
    const rows = listFromResponse(response.data);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

async function syncInboxOnce() {
  if (syncRunning) return { skipped: true, reason: "already_running" };
  if (!configured()) return { skipped: true, reason: "configuration_missing" };
  syncRunning = true;
  try {
    const rows = await fetchRecentInboxMessages();
    let inboundText = 0;
    let inserted = 0;
    for (const row of rows) {
      const event = normalizeInboxMessage(row);
      if (!event) continue;
      inboundText += 1;
      const result = insertEvent(event);
      if (result.inserted) inserted += 1;
    }
    if (inserted > 0) {
      console.log(`[inbox-recovery] Recuperados ${inserted} mensaje(s) WhatsApp que faltaban en SQLite de ${inboundText} entrante(s) revisado(s).`);
    } else {
      console.log(`[inbox-recovery] OK: ${inboundText} mensaje(s) entrante(s) revisado(s), ninguno faltaba en SQLite.`);
    }
    return { reviewed: inboundText, inserted };
  } finally {
    syncRunning = false;
  }
}

function startInboxRecovery() {
  if (!configured()) {
    console.warn("[inbox-recovery] Preparado pero pausado: falta GETCHAT_BASE_URL o WHATSAPP_360DIALOG_API_KEY.");
    return null;
  }

  // Do an immediate recovery on every deployment/restart, then keep a small
  // periodic safety net in case the webhook route has a transient outage.
  syncInboxOnce().catch((err) => {
    const detail = err?.response ? `HTTP ${err.response.status} -- ${JSON.stringify(err.response.data)}` : err.message;
    console.error("[inbox-recovery] Sincronizacion inicial fallida:", detail);
  });

  const timer = setInterval(() => {
    syncInboxOnce().catch((err) => {
      const detail = err?.response ? `HTTP ${err.response.status} -- ${JSON.stringify(err.response.data)}` : err.message;
      console.error("[inbox-recovery] Sincronizacion fallida:", detail);
    });
  }, SYNC_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[inbox-recovery] Activo: consulta get.chat cada ${SYNC_INTERVAL_MS / 60000} min y recupera hasta ${LOOKBACK_HOURS} h.`);
  return timer;
}

module.exports = { startInboxRecovery, syncInboxOnce };
