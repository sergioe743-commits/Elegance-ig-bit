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
  const value = String(horizon || "").toLowerCase();
  if (value.includes("lo antes posible")) {
    return "Prioridad comercial alta: quiere realizarlo lo antes posible. Evita pasos innecesarios y avanza de forma natural hacia valoracion, fotos o cita.";
  }
  if (value.includes("1") && value.includes("3") && value.includes("mes")) {
    return "Prioridad comercial media-alta: horizonte 1-3 meses. Resuelve su duda y avanza hacia valoracion o reserva si esta receptiva.";
  }
  if (value.includes("3") && value.includes("6") && value.includes("mes")) {
    return "Prioridad comercial media: horizonte 3-6 meses. Informa, cualifica y deja un siguiente paso claro sin presionar.";
  }
  if (value.includes("mas adelante") || value.includes("inform")) {
    return "Prioridad comercial baja: esta informandose o lo plantea mas adelante. Responde de forma util y breve, sin presion comercial.";
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
    "No vuelvas a preguntar ningun dato que ya figure arriba. Utilizalo directamente para personalizar la conversacion.",
    urgencyRule(row.horizon),
  ].filter(Boolean).join("\n");
}

module.exports = { normalizeWaId, findFormContext, buildFormContext };
