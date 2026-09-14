const axios = require("axios");
const crypto = require("crypto");
const { db } = require("./db");

const DEFAULT_SPREADSHEET_ID = "13cPdt-Uz03nzbE0X3fpbHsbNEyM-B_C_7V4Y93Uulcs";
const SYNC_INTERVAL_MS = Math.max(Number(process.env.TREATMENTS_SYNC_INTERVAL_MS) || 5 * 60 * 1000, 60 * 1000);
const SYNC_TABS = Math.min(Math.max(Number(process.env.TREATMENTS_SYNC_TABS) || 4, 1), 12);

let accessToken = null;
let accessTokenExpiresAt = 0;
let syncRunning = false;
let upsertSale = null;

function ensureLeadColumn(name, definition) {
  const columns = db.prepare("PRAGMA table_info(leads)").all();
  if (!columns.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${definition}`);
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS treatment_sales (
      row_key TEXT PRIMARY KEY,
      sheet_name TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      sale_date TEXT,
      patient_name TEXT,
      treatment TEXT,
      amount REAL NOT NULL DEFAULT 0,
      payment_method TEXT,
      wa_id TEXT,
      is_treatment INTEGER NOT NULL DEFAULT 0,
      sync_batch TEXT,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_treatment_sales_wa_id ON treatment_sales(wa_id);
    CREATE INDEX IF NOT EXISTS idx_treatment_sales_sale_date ON treatment_sales(sale_date);
  `);

  ensureLeadColumn("sales_revenue", "REAL");
  ensureLeadColumn("sales_treatment_revenue", "REAL");
  ensureLeadColumn("sales_count", "INTEGER NOT NULL DEFAULT 0");
  ensureLeadColumn("sales_last_at", "TEXT");

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_leads_preserve_sheet_sales
    AFTER UPDATE OF revenue, treatment_status, funnel_stage ON leads
    WHEN COALESCE(NEW.sales_revenue, 0) > 0
      AND (
        NEW.revenue IS NOT NEW.sales_revenue
        OR (COALESCE(NEW.sales_treatment_revenue, 0) > 0 AND NEW.treatment_status <> 'completed')
        OR (COALESCE(NEW.sales_treatment_revenue, 0) > 0 AND NEW.funnel_stage <> 'treated')
      )
    BEGIN
      UPDATE leads
      SET revenue = NEW.sales_revenue,
          treatment_status = CASE
            WHEN COALESCE(NEW.sales_treatment_revenue, 0) > 0 THEN 'completed'
            ELSE NEW.treatment_status
          END,
          funnel_stage = CASE
            WHEN COALESCE(NEW.sales_treatment_revenue, 0) > 0 THEN 'treated'
            ELSE NEW.funnel_stage
          END
      WHERE wa_id = NEW.wa_id;
    END;
  `);

  upsertSale = db.prepare(`
    INSERT INTO treatment_sales (
      row_key, sheet_name, row_number, sale_date, patient_name, treatment,
      amount, payment_method, wa_id, is_treatment, sync_batch, synced_at
    ) VALUES (
      @row_key, @sheet_name, @row_number, @sale_date, @patient_name, @treatment,
      @amount, @payment_method, @wa_id, @is_treatment, @sync_batch, @synced_at
    )
    ON CONFLICT(row_key) DO UPDATE SET
      sale_date = excluded.sale_date,
      patient_name = excluded.patient_name,
      treatment = excluded.treatment,
      amount = excluded.amount,
      payment_method = excluded.payment_method,
      wa_id = excluded.wa_id,
      is_treatment = excluded.is_treatment,
      sync_batch = excluded.sync_batch,
      synced_at = excluded.synced_at
  `);
}

function configured() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY &&
    (process.env.TREATMENTS_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID)
  );
}

function base64url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getGoogleAccessToken() {
  const now = Date.now();
  if (accessToken && now < accessTokenExpiresAt - 60_000) return accessToken;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !privateKey) throw new Error("Google service-account credentials are not configured");
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iss: email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", exp: iat + 3600, iat }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
  const assertion = `${unsigned}.${base64url(signature)}`;
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth2:grant-type:jwt-bearer", assertion });
  const response = await axios.post("https://oauth2.googleapis.com/token", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 20_000 });
  accessToken = response.data.access_token;
  accessTokenExpiresAt = now + (Number(response.data.expires_in) || 3600) * 1000;
  return accessToken;
}

async function googleGet(url) {
  const token = await getGoogleAccessToken();
  return axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30_000 });
}

function normalizeHeader(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 9 && /^[6789]/.test(digits)) digits = `34${digits}`;
  return digits.length >= 9 ? digits : null;
}

function parseAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let text = String(value || "").trim().replace(/\s/g, "").replace(/€/g, "");
  if (!text) return 0;
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  else text = text.replace(/[^0-9.-]/g, "");
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(value) {
  const text = String(value || "").trim();
  const m = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function isTreatmentRow(treatment, amount) {
  const text = normalizeHeader(treatment);
  if (!text) return false;
  if (/^(pv|primera visita)\b/.test(text) || /\breserva\b/.test(text) || /\bmasaj/.test(text) || /\bretoque\b/.test(text) || /\bsin coste\b/.test(text)) return false;
  return amount > 0;
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const normalized = (rows[i] || []).map(normalizeHeader);
    if (normalized.some((v) => v === "fecha") && normalized.some((v) => v === "nombre") && normalized.some((v) => v === "tratamiento") && normalized.some((v) => v === "abonado")) return i;
  }
  return -1;
}

function findColumn(headers, candidates, fallback) {
  const normalized = headers.map(normalizeHeader);
  for (const candidate of candidates) {
    const idx = normalized.findIndex((v) => v.includes(candidate));
    if (idx >= 0) return idx;
  }
  return fallback;
}

function ingestSheetRows(sheetName, rows) {
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) throw new Error(`No se encontro la cabecera esperada en ${sheetName}`);
  const headers = rows[headerIndex] || [];
  const dateCol = findColumn(headers, ["fecha"], 0);
  const nameCol = findColumn(headers, ["nombre"], 1);
  const treatmentCol = findColumn(headers, ["tratamiento"], 2);
  const amountCol = findColumn(headers, ["abonado"], 3);
  const paymentCol = findColumn(headers, ["metodo de pago", "metodo"], 4);
  const phoneCol = findColumn(headers, ["telefono movil", "telefono", "movil"], 5);
  const now = new Date().toISOString();
  const batch = `${now}:${sheetName}`;
  let imported = 0;
  let withPhone = 0;
  const tx = db.transaction(() => {
    for (let i = headerIndex + 1; i < rows.length; i += 1) {
      const row = rows[i] || [];
      const patientName = String(row[nameCol] || "").trim();
      const treatment = String(row[treatmentCol] || "").trim();
      const amount = parseAmount(row[amountCol]);
      const saleDate = parseDate(row[dateCol]);
      const waId = normalizePhone(row[phoneCol]);
      const paymentMethod = String(row[paymentCol] || "").trim() || null;
      if (!patientName && !treatment && !amount && !saleDate && !waId) continue;
      const rowNumber = i + 1;
      upsertSale.run({ row_key: `${sheetName}!${rowNumber}`, sheet_name: sheetName, row_number: rowNumber, sale_date: saleDate, patient_name: patientName || null, treatment: treatment || null, amount, payment_method: paymentMethod, wa_id: waId, is_treatment: isTreatmentRow(treatment, amount) ? 1 : 0, sync_batch: batch, synced_at: now });
      imported += 1;
      if (waId) withPhone += 1;
    }
    db.prepare("DELETE FROM treatment_sales WHERE sheet_name = ? AND sync_batch <> ?").run(sheetName, batch);
  });
  tx();
  return { imported, withPhone };
}

function leadStartDate(firstSeenAt) {
  if (!firstSeenAt) return null;
  const d = new Date(firstSeenAt);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function applyAttribution() {
  const leads = db.prepare("SELECT wa_id, first_seen_at FROM leads").all();
  const salesForLead = db.prepare(`SELECT amount, is_treatment, sale_date FROM treatment_sales WHERE wa_id = ? AND amount > 0 AND (? IS NULL OR sale_date IS NULL OR sale_date >= ?) ORDER BY sale_date ASC, row_number ASC`);
  const updateLead = db.prepare(`UPDATE leads SET sales_revenue=@sales_revenue, sales_treatment_revenue=@sales_treatment_revenue, sales_count=@sales_count, sales_last_at=@sales_last_at, revenue=CASE WHEN @sales_revenue > 0 THEN @sales_revenue ELSE revenue END, treatment_status=CASE WHEN @sales_treatment_revenue > 0 THEN 'completed' ELSE treatment_status END, funnel_stage=CASE WHEN @sales_treatment_revenue > 0 THEN 'treated' ELSE funnel_stage END, updated_at=@updated_at WHERE wa_id=@wa_id`);
  let matchedLeads = 0;
  let attributedRevenue = 0;
  const tx = db.transaction(() => {
    for (const lead of leads) {
      const start = leadStartDate(lead.first_seen_at);
      const sales = salesForLead.all(normalizePhone(lead.wa_id), start, start);
      const now = new Date().toISOString();
      if (!sales.length) {
        updateLead.run({ wa_id: lead.wa_id, sales_revenue: null, sales_treatment_revenue: null, sales_count: 0, sales_last_at: null, updated_at: now });
        continue;
      }
      const revenue = sales.reduce((sum, s) => sum + Number(s.amount || 0), 0);
      const treatmentRevenue = sales.filter((s) => Number(s.is_treatment) === 1).reduce((sum, s) => sum + Number(s.amount || 0), 0);
      const lastSaleAt = sales.map((s) => s.sale_date).filter(Boolean).sort().pop() || null;
      updateLead.run({ wa_id: lead.wa_id, sales_revenue: revenue, sales_treatment_revenue: treatmentRevenue || null, sales_count: sales.length, sales_last_at: lastSaleAt, updated_at: now });
      matchedLeads += 1;
      attributedRevenue += revenue;
    }
  });
  tx();
  return { matchedLeads, attributedRevenue };
}

async function fetchSheetTabs(spreadsheetId) {
  const fields = encodeURIComponent("sheets.properties(title,index)");
  const response = await googleGet(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${fields}`);
  return (response.data?.sheets || []).map((s) => s.properties).filter((p) => p?.title).sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
}

async function fetchRows(spreadsheetId, sheetTitle) {
  const range = encodeURIComponent(`'${String(sheetTitle).replace(/'/g, "''")}'!A:F`);
  const response = await googleGet(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
  return response.data?.values || [];
}

async function syncTreatmentsOnce() {
  if (syncRunning) return { skipped: true, reason: "already_running" };
  if (!configured()) return { skipped: true, reason: "google_credentials_missing" };
  syncRunning = true;
  try {
    const spreadsheetId = process.env.TREATMENTS_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
    const tabs = (await fetchSheetTabs(spreadsheetId)).slice(0, SYNC_TABS);
    let imported = 0;
    let withPhone = 0;
    for (const tab of tabs) {
      const result = ingestSheetRows(tab.title, await fetchRows(spreadsheetId, tab.title));
      imported += result.imported;
      withPhone += result.withPhone;
    }
    const attribution = applyAttribution();
    console.log(`[treatments-sync] OK: ${tabs.length} pestaña(s), ${imported} fila(s), ${withPhone} con telefono, ${attribution.matchedLeads} lead(s) atribuido(s), ${attribution.attributedRevenue.toFixed(2)} EUR.`);
    return { tabs: tabs.length, imported, withPhone, ...attribution };
  } finally {
    syncRunning = false;
  }
}

function startTreatmentSync() {
  initSchema();
  if (!configured()) {
    console.warn("[treatments-sync] Preparado pero pausado: faltan GOOGLE_SERVICE_ACCOUNT_EMAIL y/o GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.");
    return null;
  }
  syncTreatmentsOnce().catch((err) => console.error("[treatments-sync] Sincronizacion inicial fallida:", err.response?.data?.error?.message || err.message));
  const timer = setInterval(() => syncTreatmentsOnce().catch((err) => console.error("[treatments-sync] Error:", err.response?.data?.error?.message || err.message)), SYNC_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[treatments-sync] Sincronizacion Google Sheets activa cada ${Math.round(SYNC_INTERVAL_MS / 60000)} min.`);
  return timer;
}

module.exports = { startTreatmentSync, syncTreatmentsOnce, normalizePhone };
