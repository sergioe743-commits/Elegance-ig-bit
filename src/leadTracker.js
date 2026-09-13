const axios = require("axios");
const { db } = require("./db");

const ANALYSIS_INTERVAL_MS = 60 * 1000;
const MAX_ANALYSES_PER_CYCLE = 5;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-sol";

// Persistent lead/opportunity table. The event log remains the source of truth;
// this table is a materialized operational view for reception/marketing.
db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  wa_id TEXT PRIMARY KEY,
  contact_name TEXT,
  source TEXT NOT NULL DEFAULT 'meta_ads_whatsapp',
  lead_id TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  ad_id TEXT,
  ad_name TEXT,
  ad_headline TEXT,
  ad_body TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT,
  first_response_at TEXT,
  first_response_seconds INTEGER,
  inbound_messages INTEGER NOT NULL DEFAULT 0,
  bot_messages INTEGER NOT NULL DEFAULT 0,
  human_messages INTEGER NOT NULL DEFAULT 0,
  treatment_interest TEXT,
  preferred_city TEXT,
  prior_surgery TEXT,
  horizon TEXT,
  quote_sent INTEGER NOT NULL DEFAULT 0,
  quote_amount REAL,
  appointment_status TEXT NOT NULL DEFAULT 'none',
  treatment_status TEXT NOT NULL DEFAULT 'none',
  revenue REAL,
  lost_reason TEXT,
  funnel_stage TEXT NOT NULL DEFAULT 'new',
  ai_summary TEXT,
  ai_confidence REAL,
  next_action TEXT,
  last_analyzed_event_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_ad_id ON leads(ad_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(funnel_stage);
CREATE INDEX IF NOT EXISTS idx_leads_last_seen ON leads(last_seen_at);
`);

function metaLeadContacts() {
  return db.prepare(`
    SELECT contact_wa_id AS wa_id, MAX(id) AS max_event_id
    FROM events
    WHERE channel = 'whatsapp'
      AND contact_wa_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM events r
        WHERE r.channel = 'whatsapp'
          AND r.contact_wa_id = events.contact_wa_id
          AND r.direction = 'inbound'
          AND r.referral_ad_id IS NOT NULL
          AND TRIM(r.referral_ad_id) <> ''
      )
    GROUP BY contact_wa_id
    ORDER BY max_event_id DESC
  `).all();
}

function eventsForContact(waId) {
  return db.prepare(`
    SELECT id, received_at, direction, event_type, contact_name, message_type,
           text_body, status, referral_ad_id, referral_source_type,
           referral_headline, referral_body, raw_json
    FROM events
    WHERE channel = 'whatsapp' AND contact_wa_id = ?
    ORDER BY id ASC
  `).all(waId);
}

function firstAfter(events, timestamp, directions) {
  const t = new Date(timestamp).getTime();
  return events.find((e) =>
    directions.includes(e.direction) &&
    e.received_at &&
    new Date(e.received_at).getTime() >= t
  );
}

function deriveDeterministic(waId, events) {
  const inbound = events.filter((e) => e.direction === "inbound");
  if (!inbound.length) return null;
  const referral = inbound.find((e) => e.referral_ad_id) || inbound[0];
  const firstInbound = inbound[0];
  const last = events[events.length - 1];
  const firstResponse = firstAfter(events, firstInbound.received_at, ["bot_reply", "app_echo"]);
  const firstMs = new Date(firstInbound.received_at).getTime();
  const responseMs = firstResponse ? new Date(firstResponse.received_at).getTime() - firstMs : null;
  const latestName = [...events].reverse().find((e) => e.contact_name)?.contact_name || null;

  return {
    wa_id: waId,
    contact_name: latestName,
    ad_id: referral.referral_ad_id || null,
    ad_headline: referral.referral_headline || null,
    ad_body: referral.referral_body || null,
    first_seen_at: firstInbound.received_at,
    last_seen_at: last?.received_at || firstInbound.received_at,
    first_response_at: firstResponse?.received_at || null,
    first_response_seconds: responseMs == null ? null : Math.max(0, Math.round(responseMs / 1000)),
    inbound_messages: inbound.length,
    bot_messages: events.filter((e) => e.direction === "bot_reply").length,
    human_messages: events.filter((e) => e.direction === "app_echo").length,
    max_event_id: Math.max(...events.map((e) => Number(e.id) || 0)),
  };
}

const upsertBaseStmt = db.prepare(`
INSERT INTO leads (
  wa_id, contact_name, source, ad_id, ad_headline, ad_body,
  first_seen_at, last_seen_at, first_response_at, first_response_seconds,
  inbound_messages, bot_messages, human_messages, updated_at
) VALUES (
  @wa_id, @contact_name, 'meta_ads_whatsapp', @ad_id, @ad_headline, @ad_body,
  @first_seen_at, @last_seen_at, @first_response_at, @first_response_seconds,
  @inbound_messages, @bot_messages, @human_messages, @updated_at
)
ON CONFLICT(wa_id) DO UPDATE SET
  contact_name = COALESCE(excluded.contact_name, leads.contact_name),
  ad_id = COALESCE(excluded.ad_id, leads.ad_id),
  ad_headline = COALESCE(excluded.ad_headline, leads.ad_headline),
  ad_body = COALESCE(excluded.ad_body, leads.ad_body),
  first_seen_at = COALESCE(leads.first_seen_at, excluded.first_seen_at),
  last_seen_at = excluded.last_seen_at,
  first_response_at = COALESCE(leads.first_response_at, excluded.first_response_at),
  first_response_seconds = COALESCE(leads.first_response_seconds, excluded.first_response_seconds),
  inbound_messages = excluded.inbound_messages,
  bot_messages = excluded.bot_messages,
  human_messages = excluded.human_messages,
  updated_at = excluded.updated_at
`);

function upsertDeterministic(base) {
  upsertBaseStmt.run({ ...base, updated_at: new Date().toISOString() });
}

function cleanJson(text) {
  const raw = String(text || "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI analysis did not return JSON");
  return JSON.parse(unfenced.slice(start, end + 1));
}

function conversationText(events) {
  return events
    .filter((e) => e.text_body && ["inbound", "bot_reply", "app_echo"].includes(e.direction))
    .slice(-40)
    .map((e) => {
      const who = e.direction === "inbound" ? "PACIENTE" : e.direction === "app_echo" ? "RECEPCION" : "BOT";
      return `[${e.received_at}] ${who}: ${e.text_body}`;
    })
    .join("\n");
}

async function classifyConversation(events) {
  if (!process.env.OPENAI_API_KEY) return null;
  const transcript = conversationText(events);
  if (!transcript) return null;

  const system = `You classify WhatsApp sales conversations for an aesthetic medicine clinic. Return ONLY one valid JSON object, no markdown. Never invent facts. If evidence is absent, use null/false/unknown. A quote is only true if a concrete price was sent. An appointment is booked only if date/time or an explicit booking confirmation exists. Treatment completed and revenue must NEVER be inferred from interest or a quote; they require explicit evidence in the conversation or later confirmed data.\n\nJSON schema:\n{\n  "treatment_interest": string|null,\n  "preferred_city": "Barcelona"|"Madrid"|"either"|"unknown",\n  "prior_surgery": "yes"|"no"|"unknown",\n  "horizon": string|null,\n  "quote_sent": boolean,\n  "quote_amount": number|null,\n  "appointment_status": "none"|"requested"|"booked"|"completed"|"cancelled",\n  "treatment_status": "none"|"considering"|"booked"|"completed",\n  "revenue": number|null,\n  "lost_reason": string|null,\n  "funnel_stage": "new"|"contacted"|"qualified"|"quote_sent"|"appointment"|"booked"|"treated"|"lost",\n  "summary": string,\n  "next_action": string|null,\n  "confidence": number\n}\nconfidence must be 0..1.`;

  const response = await axios.post("https://api.openai.com/v1/chat/completions", {
    model: OPENAI_MODEL,
    max_completion_tokens: 600,
    messages: [
      { role: "system", content: system },
      { role: "user", content: transcript },
    ],
  }, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });

  return cleanJson(response.data?.choices?.[0]?.message?.content);
}

const updateAnalysisStmt = db.prepare(`
UPDATE leads SET
  treatment_interest = @treatment_interest,
  preferred_city = @preferred_city,
  prior_surgery = @prior_surgery,
  horizon = @horizon,
  quote_sent = @quote_sent,
  quote_amount = @quote_amount,
  appointment_status = @appointment_status,
  treatment_status = @treatment_status,
  revenue = COALESCE(@revenue, revenue),
  lost_reason = @lost_reason,
  funnel_stage = @funnel_stage,
  ai_summary = @ai_summary,
  ai_confidence = @ai_confidence,
  next_action = @next_action,
  last_analyzed_event_id = @last_analyzed_event_id,
  updated_at = @updated_at
WHERE wa_id = @wa_id
`);

function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function saveAnalysis(waId, analysis, maxEventId) {
  const row = {
    wa_id: waId,
    treatment_interest: analysis.treatment_interest || null,
    preferred_city: normalizeEnum(analysis.preferred_city, ["Barcelona", "Madrid", "either", "unknown"], "unknown"),
    prior_surgery: normalizeEnum(analysis.prior_surgery, ["yes", "no", "unknown"], "unknown"),
    horizon: analysis.horizon || null,
    quote_sent: analysis.quote_sent ? 1 : 0,
    quote_amount: Number.isFinite(Number(analysis.quote_amount)) ? Number(analysis.quote_amount) : null,
    appointment_status: normalizeEnum(analysis.appointment_status, ["none", "requested", "booked", "completed", "cancelled"], "none"),
    treatment_status: normalizeEnum(analysis.treatment_status, ["none", "considering", "booked", "completed"], "none"),
    revenue: Number.isFinite(Number(analysis.revenue)) ? Number(analysis.revenue) : null,
    lost_reason: analysis.lost_reason || null,
    funnel_stage: normalizeEnum(analysis.funnel_stage, ["new", "contacted", "qualified", "quote_sent", "appointment", "booked", "treated", "lost"], "contacted"),
    ai_summary: analysis.summary || null,
    ai_confidence: Math.max(0, Math.min(1, Number(analysis.confidence) || 0)),
    next_action: analysis.next_action || null,
    last_analyzed_event_id: maxEventId,
    updated_at: new Date().toISOString(),
  };
  updateAnalysisStmt.run(row);
}

async function refreshLead(waId, forceAnalysis = false) {
  const events = eventsForContact(waId);
  const base = deriveDeterministic(waId, events);
  if (!base) return null;
  upsertDeterministic(base);
  const lead = db.prepare("SELECT * FROM leads WHERE wa_id = ?").get(waId);
  if (forceAnalysis || Number(lead.last_analyzed_event_id || 0) < base.max_event_id) {
    try {
      const analysis = await classifyConversation(events);
      if (analysis) saveAnalysis(waId, analysis, base.max_event_id);
    } catch (err) {
      console.error(`[lead-tracker] AI analysis failed for ${waId}: ${err.message}`);
    }
  }
  return db.prepare("SELECT * FROM leads WHERE wa_id = ?").get(waId);
}

async function processCycle() {
  const contacts = metaLeadContacts();
  let analyzed = 0;
  for (const c of contacts) {
    const existing = db.prepare("SELECT last_analyzed_event_id FROM leads WHERE wa_id = ?").get(c.wa_id);
    const needsAnalysis = !existing || Number(existing.last_analyzed_event_id || 0) < Number(c.max_event_id || 0);
    if (needsAnalysis && analyzed >= MAX_ANALYSES_PER_CYCLE) continue;
    await refreshLead(c.wa_id, false);
    if (needsAnalysis) analyzed += 1;
  }
}

function startLeadTracker() {
  processCycle().catch((err) => console.error("[lead-tracker] Initial cycle failed:", err.message));
  const timer = setInterval(() => {
    processCycle().catch((err) => console.error("[lead-tracker] Cycle failed:", err.message));
  }, ANALYSIS_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log("[lead-tracker] Persistent Meta Ads lead tracking active.");
  return timer;
}

function listLeads(limit = 100) {
  return db.prepare(`
    SELECT * FROM leads
    ORDER BY COALESCE(last_seen_at, updated_at) DESC
    LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
}

function getLead(waId) {
  const lead = db.prepare("SELECT * FROM leads WHERE wa_id = ?").get(waId);
  if (!lead) return null;
  return { lead, events: eventsForContact(waId) };
}

function funnelSummary() {
  const total = db.prepare("SELECT COUNT(*) AS n FROM leads").get().n;
  const contacted = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE first_response_at IS NOT NULL").get().n;
  const quotes = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE quote_sent = 1").get().n;
  const appointments = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE appointment_status IN ('booked','completed')").get().n;
  const booked = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE treatment_status IN ('booked','completed')").get().n;
  const treated = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE treatment_status = 'completed'").get().n;
  const revenue = db.prepare("SELECT COALESCE(SUM(revenue),0) AS n FROM leads").get().n;
  const avgResponse = db.prepare("SELECT AVG(first_response_seconds) AS n FROM leads WHERE first_response_seconds IS NOT NULL").get().n;
  const byAd = db.prepare(`
    SELECT ad_id, MAX(ad_headline) AS ad_headline, COUNT(*) AS leads,
           SUM(CASE WHEN quote_sent = 1 THEN 1 ELSE 0 END) AS quotes,
           SUM(CASE WHEN appointment_status IN ('booked','completed') THEN 1 ELSE 0 END) AS appointments,
           SUM(CASE WHEN treatment_status = 'completed' THEN 1 ELSE 0 END) AS treated,
           COALESCE(SUM(revenue),0) AS revenue
    FROM leads
    GROUP BY ad_id
    ORDER BY leads DESC
  `).all();
  return {
    total_leads: total,
    contacted,
    quotes,
    appointments,
    booked,
    treated,
    revenue,
    average_first_response_seconds: avgResponse == null ? null : Math.round(avgResponse),
    by_ad: byAd,
  };
}

module.exports = {
  startLeadTracker,
  refreshLead,
  listLeads,
  getLead,
  funnelSummary,
};
