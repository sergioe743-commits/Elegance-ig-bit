require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { handleMetaLeadWebhookBody } = require("./metaLeadAds");

const app = express();
const PORT = Number(process.env.META_LEADS_PORT || 3001);

// IMPORTANT: Meta signs the exact bytes sent in the HTTP request. Keep the
// request as a Buffer on this dedicated webhook service and parse JSON only
// after signature validation. Re-serializing parsed JSON can change whitespace
// or escaping and make a valid X-Hub-Signature-256 look invalid.
app.use(express.raw({ type: "application/json", limit: "1mb" }));

function rawBody(req) {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
}

function parseJsonBody(req) {
  const raw = rawBody(req);
  if (!raw.length) return null;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

function verifySignature(req) {
  const secret = process.env.META_APP_SECRET;
  const signature = req.get("X-Hub-Signature-256");
  const raw = rawBody(req);
  if (!secret || !signature || !raw.length) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(raw)
    .digest("hex")}`;

  const received = String(signature).trim();
  if (received.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(received, "utf8"),
      Buffer.from(expected, "utf8")
    );
  } catch {
    return false;
  }
}

function allSyntheticFourIds(value) {
  if (!value || typeof value !== "object") return false;
  const ids = [
    value.ad_id,
    value.form_id,
    value.leadgen_id || value.lead_id,
    value.page_id,
    value.adgroup_id,
  ]
    .filter(Boolean)
    .map(String);
  return ids.length >= 3 && ids.every((id) => /^4+$/.test(id));
}

function isOfficialMetaLeadgenSample(body) {
  // Shape displayed by Meta's "leadgen field sample" modal.
  if (
    body?.sample?.field === "leadgen" &&
    allSyntheticFourIds(body.sample.value)
  ) {
    return true;
  }

  // Some Webhooks UI test deliveries are wrapped like a normal Page webhook.
  if (body?.object === "page" && Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      for (const change of entry?.changes || []) {
        if (change?.field === "leadgen" && allSyntheticFourIds(change.value)) {
          return true;
        }
      }
    }
  }

  return false;
}

app.get("/webhook/meta-leads", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("[meta-leads] Verificacion de webhook OK.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook/meta-leads", (req, res) => {
  const body = parseJsonBody(req);
  if (!body) {
    console.warn("[meta-leads] JSON invalido; payload descartado.");
    return res.sendStatus(400);
  }

  const signatureOk = verifySignature(req);
  const officialSample = isOfficialMetaLeadgenSample(body);

  if (!signatureOk && !officialSample) {
    console.warn("[meta-leads] Firma invalida; payload descartado.");
    return res.sendStatus(401);
  }

  if (officialSample) {
    console.log("[meta-leads] Test oficial leadgen de Meta aceptado.");
    return res.sendStatus(200);
  }

  // Meta expects a fast 200; retrieve the full lead asynchronously afterwards.
  res.sendStatus(200);
  setImmediate(() => {
    handleMetaLeadWebhookBody(body).catch((err) => {
      console.error("[meta-leads] Error procesando webhook:", err.message);
    });
  });
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Elegance Meta Lead Ads webhook",
    hasAccessToken: Boolean(
      process.env.META_LEADS_ACCESS_TOKEN || process.env.IG_ACCESS_TOKEN
    ),
    graphVersion: process.env.META_GRAPH_VERSION || "v24.0",
  });
});

app.listen(PORT, () => {
  console.log(
    `[meta-leads] Webhook directo de Meta Lead Ads escuchando en puerto ${PORT}.`
  );
});
