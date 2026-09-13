const { db } = require("./db");

db.exec(`
CREATE TABLE IF NOT EXISTS meta_form_context (
  lead_id TEXT PRIMARY KEY,
  wa_id TEXT,
  contact_name TEXT,
  treatment_zone TEXT,
  main_goal TEXT,
  preferred_city TEXT,
  horizon TEXT,
  prior_treatment TEXT,
  ad_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_form_context_wa ON meta_form_context(wa_id);
`);

function normalizeWaId(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 9) digits = `34${digits}`;
  return digits;
}

function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function text(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String).join(", ").trim() || null;
  const v = String(value ?? "").trim();
  return v || null;
}

function collectFields(payload) {
  const out = {};
  const sources = [payload?.field_data, payload?.fields, payload?.answers];
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const item of source) {
        const key = fold(item?.name || item?.key || item?.label || item?.question);
        if (key) out[key] = text(item?.values ?? item?.value ?? item?.answer);
      }
    } else if (source && typeof source === "object") {
      for (const [key, value] of Object.entries(source)) out[fold(key)] = text(value);
    }
  }
  for (const [key, value] of Object.entries(payload || {})) {
    if (typeof value !== "object" || value == null) out[fold(key)] = text(value);
  }
  return out;
}

function pick(fields, fragments) {
  for (const [key, value] of Object.entries(fields)) {
    if (value && fragments.some((fragment) => key.includes(fragment))) return value;
  }
  return null;
}

function mapFormPayload(payload) {
  const fields = collectFields(payload || {});
  const rawPhone = pick(fields, ["phone_number", "telefono", "whatsapp", "movil", "mobile", "phone"]);
  const waId = normalizeWaId(rawPhone);
  const leadId = text(payload?.lead_id || payload?.leadgen_id || payload?.id) || `phone:${waId}:${Date.now()}`;
  return {
    lead_id: leadId,
    wa_id: waId || null,
    contact_name: pick(fields, ["full_name", "nombre_completo", "nombre", "name"]),
    treatment_zone: pick(fields, ["que_zona", "zona_o_zonas", "zona", "treatment_zone", "area"]),
    main_goal: pick(fields, ["que_te_gustaria_mejorar", "mejorar_principalmente", "objetivo", "main_goal", "concern"]),
    preferred_city: pick(fields, ["en_que_ciudad", "ciudad", "preferred_city", "location"]),
    horizon: pick(fields, ["cuando_te_gustaria", "cuando", "horizonte", "horizon", "timing", "timeframe"]),
    prior_treatment: pick(fields, ["cirugia_o_tratamiento", "tratamiento_anterior", "cirugia_previa", "prior_surgery", "prior_treatment"]),
    ad_id: text(payload?.ad_id || fields.ad_id),
    updated_at: new Date().toISOString(),
  };
}

const upsertStmt = db.prepare(`
INSERT INTO meta_form_context (
  lead_id, wa_id, contact_name, treatment_zone, main_goal, preferred_city,
  horizon, prior_treatment, ad_id, updated_at
) VALUES (
  @lead_id, @wa_id, @contact_name, @treatment_zone, @main_goal, @preferred_city,
  @horizon, @prior_treatment, @ad_id, @updated_at
)
ON CONFLICT(lead_id) DO UPDATE SET
  wa_id = COALESCE(excluded.wa_id, meta_form_context.wa_id),
  contact_name = COALESCE(excluded.contact_name, meta_form_context.contact_name),
  treatment_zone = COALESCE(excluded.treatment_zone, meta_form_context.treatment_zone),
  main_goal = COALESCE(excluded.main_goal, meta_form_context.main_goal),
  preferred_city = COALESCE(excluded.preferred_city, meta_form_context.preferred_city),
  horizon = COALESCE(excluded.horizon, meta_form_context.horizon),
  prior_treatment = COALESCE(excluded.prior_treatment, meta_form_context.prior_treatment),
  ad_id = COALESCE(excluded.ad_id, meta_form_context.ad_id),
  updated_at = excluded.updated_at
`);

function saveFormContext(payload) {
  const row = mapFormPayload(payload);
  upsertStmt.run(row);
  return row;
}

function findFormContext(waId) {
  const normalized = normalizeWaId(waId);
  if (!normalized) return null;
  return db.prepare(`
    SELECT * FROM meta_form_context
    WHERE wa_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(normalized) || null;
}

function urgencyRule(horizon) {
  const value = fold(horizon);
  if (value.includes("lo_antes_posible") || value.includes("cuanto_antes") || value.includes("asap")) {
    return "PRIORIDAD COMERCIAL ALTA: quiere realizarlo lo antes posible. Responde de forma directa, evita pasos innecesarios y avanza de forma natural hacia valoracion, fotos o cita.";
  }
  if ((value.includes("1_3") || value.includes("1_a_3")) && value.includes("mes")) {
    return "PRIORIDAD COMERCIAL MEDIA-ALTA: horizonte 1-3 meses. Resuelve su duda y avanza hacia valoracion o reserva si esta receptiva.";
  }
  if ((value.includes("3_6") || value.includes("3_a_6")) && value.includes("mes")) {
    return "PRIORIDAD COMERCIAL MEDIA: horizonte 3-6 meses. Informa, cualifica y deja un siguiente paso claro sin presionar.";
  }
  if (value.includes("mas_adelante") || value.includes("inform")) {
    return "PRIORIDAD COMERCIAL BAJA: esta informandose o lo plantea mas adelante. Responde de forma util y breve, sin presion comercial.";
  }
  return null;
}

function buildFormContext(waId) {
  const row = findFormContext(waId);
  if (!row) return null;
  return [
    "DATOS ESTRUCTURADOS DEL FORMULARIO META, aportados antes de abrir WhatsApp:",
    row.contact_name ? `Nombre: ${row.contact_name}` : null,
    row.treatment_zone ? `Zona(s) a tratar: ${row.treatment_zone}` : null,
    row.main_goal ? `Objetivo principal: ${row.main_goal}` : null,
    row.preferred_city ? `Ciudad preferida: ${row.preferred_city}` : null,
    row.horizon ? `Horizonte: ${row.horizon}` : null,
    row.prior_treatment ? `Antecedente de cirugia/tratamiento en la zona: ${row.prior_treatment}` : null,
    "REGLA: no vuelvas a preguntar ningun dato que ya figure arriba. Utilizalo directamente para personalizar la conversacion.",
    urgencyRule(row.horizon),
  ].filter(Boolean).join("\n");
}

module.exports = { normalizeWaId, mapFormPayload, saveFormContext, findFormContext, buildFormContext };
