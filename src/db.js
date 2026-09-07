// Capa de persistencia real (SQLite) sobre el volumen ya montado en Railway
// (DATA_DIR). Sustituye el array en memoria que usaba la ruta sandbox de
// WhatsApp por un registro fiable de eventos de mensajeria, con
// deduplicacion y captura de atribucion (referral/ad_id) cuando esta
// disponible. Es la capa base (Fase 2) sobre la que se construira despues
// el modelo de contacto/oportunidad -- de momento guarda el evento crudo
// mas los campos ya identificables, sin inventar ni completar nada que no
// venga en el payload.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "events.db");

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  channel TEXT NOT NULL,              -- 'whatsapp' | 'instagram_dm' | 'instagram_comment'
  direction TEXT NOT NULL,            -- 'inbound' | 'outbound_status' | 'app_echo' | 'unknown'
  event_type TEXT,                    -- 'message' | 'status' | 'smb_message_echo' | 'referral' | ...
  external_id TEXT,                   -- wamid / mid / comment id -- clave de deduplicacion cuando existe
  contact_wa_id TEXT,                 -- numero de whatsapp del contacto, si aplica
  contact_name TEXT,
  ig_sender_id TEXT,
  message_type TEXT,                  -- text/image/video/sticker/location/order/button/unknown...
  text_body TEXT,
  status TEXT,                        -- sent/delivered/read/failed (para eventos de estado)
  referral_ad_id TEXT,                -- fuente de atribucion Meta Ads, cuando el evento la trae
  referral_source_type TEXT,
  referral_source_url TEXT,
  referral_headline TEXT,
  referral_body TEXT,
  raw_json TEXT NOT NULL,
  UNIQUE(channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_contact ON events(contact_wa_id);
CREATE INDEX IF NOT EXISTS idx_events_referral_ad ON events(referral_ad_id);
`);

// external_id no siempre existe (algunos payloads de prueba no lo traen).
// Cuando falta, se genera uno sintetico no determinista para no bloquear la
// insercion por la restriccion UNIQUE -- es decir, en ese caso concreto no
// hay deduplicacion real posible porque Meta/360dialog no nos dio con que
// deduplicar; se dice explicitamente en el campo dedup_key_synthetic.
const insertStmt = db.prepare(`
INSERT OR IGNORE INTO events (
  received_at, channel, direction, event_type, external_id,
  contact_wa_id, contact_name, ig_sender_id, message_type, text_body, status,
  referral_ad_id, referral_source_type, referral_source_url, referral_headline, referral_body,
  raw_json
) VALUES (
  @received_at, @channel, @direction, @event_type, @external_id,
  @contact_wa_id, @contact_name, @ig_sender_id, @message_type, @text_body, @status,
  @referral_ad_id, @referral_source_type, @referral_source_url, @referral_headline, @referral_body,
  @raw_json
)
`);

let syntheticCounter = 0;
function insertEvent(evt) {
  const external_id =
    evt.external_id || `synthetic:${Date.now()}:${syntheticCounter++}`;
  const row = {
    received_at: evt.received_at || new Date().toISOString(),
    channel: evt.channel,
    direction: evt.direction || "unknown",
    event_type: evt.event_type || null,
    external_id,
    contact_wa_id: evt.contact_wa_id || null,
    contact_name: evt.contact_name || null,
    ig_sender_id: evt.ig_sender_id || null,
    message_type: evt.message_type || null,
    text_body: evt.text_body || null,
    status: evt.status || null,
    referral_ad_id: evt.referral_ad_id || null,
    referral_source_type: evt.referral_source_type || null,
    referral_source_url: evt.referral_source_url || null,
    referral_headline: evt.referral_headline || null,
    referral_body: evt.referral_body || null,
    raw_json: JSON.stringify(evt.raw ?? {}),
  };
  const info = insertStmt.run(row);
  return { inserted: info.changes > 0, external_id };
}

function getRecentEvents(limit = 50, channel) {
  if (channel) {
    return db
      .prepare(
        "SELECT * FROM events WHERE channel = ? ORDER BY id DESC LIMIT ?"
      )
      .all(channel, limit);
  }
  return db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
}

function countEvents() {
  return db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
}

module.exports = { insertEvent, getRecentEvents, countEvents, db };
