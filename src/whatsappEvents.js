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

function extractMessageText(message) {
  if (message?.text?.body) return message.text.body;

  // Preserve the fact that the patient sent photos in the textual conversation
  // history. The bot does not diagnose the image; it only remembers that photos
  // have already been received so it does not ask for them again later.
  if (message?.type === "image") {
    const caption = String(message?.image?.caption || "").trim();
    return caption
      ? `[El paciente ha enviado una foto por WhatsApp. Pie de foto: ${caption}]`
      : "[El paciente ha enviado una foto por WhatsApp para su valoración.]";
  }

  return null;
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
      text_body: extractMessageText(message),
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
    // In a coexistence app echo, `from` is commonly the clinic/business
    // number and `to` is the patient. For normal inbound messages the patient
    // is in `from`. Correct attribution is essential for human takeover and
    // response-time analytics.
    const waId = isAppEcho
      ? (message.to || contact?.wa_id || contact?.user_id || message.from || null)
      : (message.from || contact?.wa_id || contact?.user_id || null);

    events.push({
      received_at: receivedAt,
      channel: "whatsapp",
      direction: isAppEcho ? "app_echo" : "inbound",
      event_type: isAppEcho ? "smb_message_echo" : "message",
      external_id: message.id || null,
      contact_wa_id: waId,
      contact_name: contact?.profile?.name || null,
      message_type: message.type || null,
      text_body: extractMessageText(message),
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
