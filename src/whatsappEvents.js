// Interpreta los payloads que llegan a /webhook/whatsapp (canal + WABA,
// mismo endpoint para ambos) y los normaliza a filas listas para
// src/db.js#insertEvent. Soporta dos formas de payload observadas en las
// pruebas reales de 360dialog:
//   (a) formato plano "waba-v2" nativo de 360dialog: { contacts: [...], messages: [...] }
//   (b) formato anidado tipo Cloud API de Meta: { object, entry: [{ changes: [{ field, value }] }] }
// En (b), "field" distingue el origen del evento:
//   - "messages"           -> mensaje/estado normal (API o entrante del paciente)
//   - "smb_message_echoes" -> mensaje que el EQUIPO envio desde la app WhatsApp Business
//                             (evento de coexistencia; ver docs.360dialog.com/.../coexistence)
// No se inventa ningun dato que no venga en el payload: si un campo no
// esta, se deja null y ya. Sea cual sea la forma, el payload completo se
// guarda siempre en raw_json.

function extractReferral(message) {
  // El "referral" de clic-en-anuncio puede venir en distintos sitios segun
  // el payload; se cubren los que hemos visto documentados/probados.
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

function normalizeFlatPayload(body, receivedAt) {
  const events = [];
  const contact = body.contacts?.[0];
  for (const message of body.messages || []) {
    events.push({
      received_at: receivedAt,
      channel: "whatsapp",
      direction: "inbound",
      event_type: "message",
      external_id: message.id || null,
      contact_wa_id: message.from || contact?.wa_id || null,
      contact_name: contact?.profile?.name || null,
      message_type: message.type || null,
      text_body: message.text?.body || null,
      status: null,
      ...extractReferral(message),
      raw: body,
    });
  }
  for (const status of body.statuses || []) {
    events.push({
      received_at: receivedAt,
      channel: "whatsapp",
      direction: "outbound_status",
      event_type: "status",
      external_id: status.id ? `${status.id}:${status.status}` : null,
      contact_wa_id: status.recipient_id || null,
      contact_name: null,
      message_type: null,
      text_body: null,
      status: status.status || null,
      raw: body,
    });
  }
  return events;
}

function normalizeCloudApiChange(change, body, receivedAt) {
  const events = [];
  const value = change.value || {};
  const isAppEcho = change.field === "smb_message_echoes";
  const contact = value.contacts?.[0];

  for (const message of value.messages || []) {
    events.push({
      received_at: receivedAt,
      channel: "whatsapp",
      direction: isAppEcho ? "app_echo" : "inbound",
      event_type: isAppEcho ? "smb_message_echo" : "message",
      external_id: message.id || null,
      contact_wa_id:
        message.from || contact?.wa_id || contact?.user_id || null,
      contact_name: contact?.profile?.name || null,
      message_type: message.type || null,
      text_body: message.text?.body || null,
      status: null,
      ...extractReferral(message),
      raw: body,
    });
  }
  for (const status of value.statuses || []) {
    events.push({
      received_at: receivedAt,
      channel: "whatsapp",
      direction: "outbound_status",
      event_type: "status",
      external_id: status.id ? `${status.id}:${status.status}` : null,
      contact_wa_id: status.recipient_id || null,
      contact_name: null,
      message_type: null,
      text_body: null,
      status: status.status || null,
      raw: body,
    });
  }
  return events;
}

// Devuelve SIEMPRE una lista de filas listas para insertEvent (puede venir
// vacia si el payload no trae ni mensajes ni estados, p.ej. un ping/challenge
// vacio -- ese caso se guarda igual como evento generico mas abajo en server.js).
function parseWhatsAppWebhookBody(body) {
  const receivedAt = new Date().toISOString();
  if (Array.isArray(body?.messages) || Array.isArray(body?.statuses)) {
    return normalizeFlatPayload(body, receivedAt);
  }
  if (body?.object === "whatsapp_business_account") {
    const events = [];
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        events.push(...normalizeCloudApiChange(change, body, receivedAt));
      }
    }
    return events;
  }
  return [];
}

module.exports = { parseWhatsAppWebhookBody };
