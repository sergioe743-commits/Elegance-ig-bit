const axios = require("axios");
const { saveFormContext } = require("./metaFormContext");

function graphBase() {
  const version = String(process.env.META_GRAPH_VERSION || "v24.0").trim();
  return `https://graph.facebook.com/${version}`;
}

function leadsAccessToken() {
  return process.env.META_LEADS_ACCESS_TOKEN || process.env.IG_ACCESS_TOKEN || null;
}

async function fetchLead(leadgenId) {
  const token = leadsAccessToken();
  if (!token) throw new Error("Falta token de Meta compatible con leads_retrieval.");
  const response = await axios.get(`${graphBase()}/${encodeURIComponent(leadgenId)}`, {
    params: { access_token: token, fields: "id,created_time,ad_id,form_id,field_data" },
    timeout: 20000,
  });
  return response.data;
}

function leadgenChanges(body) {
  const out = [];
  if (!body || body.object !== "page") return out;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "leadgen") continue;
      const value = change.value || {};
      const leadgenId = value.leadgen_id || value.lead_id;
      if (!leadgenId) continue;
      out.push({
        leadgen_id: String(leadgenId),
        page_id: value.page_id || entry.id || null,
        form_id: value.form_id || null,
        ad_id: value.ad_id || null,
        adgroup_id: value.adgroup_id || null,
        created_time: value.created_time || entry.time || null,
      });
    }
  }
  return out;
}

async function persistPayload(payload) {
  const forwardUrl = process.env.META_LEAD_FORWARD_URL;
  const forwardSecret = process.env.META_LEAD_FORWARD_SECRET;
  if (forwardUrl && forwardSecret) {
    const response = await axios.post(forwardUrl, payload, {
      headers: { "X-Elegance-Secret": forwardSecret, "Content-Type": "application/json" },
      timeout: 20000,
    });
    return { forwarded: true, ...response.data };
  }
  return saveFormContext(payload);
}

async function ingestLeadgenChange(change) {
  const lead = await fetchLead(change.leadgen_id);
  const payload = {
    ...lead,
    lead_id: lead.id || change.leadgen_id,
    leadgen_id: change.leadgen_id,
    ad_id: lead.ad_id || change.ad_id || null,
    form_id: lead.form_id || change.form_id || null,
    page_id: change.page_id || null,
    adgroup_id: change.adgroup_id || null,
    created_time: lead.created_time || change.created_time || null,
  };
  const saved = await persistPayload(payload);
  console.log(`[meta-leads] Lead ${change.leadgen_id} recuperado y enviado al CRM principal.`);
  return saved;
}

async function handleMetaLeadWebhookBody(body) {
  const changes = leadgenChanges(body);
  if (!changes.length) return { handled: 0, saved: 0 };
  let saved = 0;
  for (const change of changes) {
    try {
      await ingestLeadgenChange(change);
      saved += 1;
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[meta-leads] No se pudo recuperar lead ${change.leadgen_id}: ${detail}`);
    }
  }
  return { handled: changes.length, saved };
}

module.exports = { fetchLead, leadgenChanges, ingestLeadgenChange, handleMetaLeadWebhookBody };
