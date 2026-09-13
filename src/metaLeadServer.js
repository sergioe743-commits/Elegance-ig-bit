require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { handleMetaLeadWebhookBody } = require("./metaLeadAds");

const app = express();
const PORT = Number(process.env.META_LEADS_PORT || 3001);

app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

function verifySignature(req) {
  const secret = process.env.META_APP_SECRET;
  const signature = req.get("X-Hub-Signature-256");
  if (!secret || !signature || !req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex")}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
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
  if (!verifySignature(req)) {
    console.warn("[meta-leads] Firma invalida; payload descartado.");
    return res.sendStatus(401);
  }

  // Meta expects a fast 200; retrieve the full lead asynchronously afterwards.
  res.sendStatus(200);
  setImmediate(() => {
    handleMetaLeadWebhookBody(req.body).catch((err) => {
      console.error("[meta-leads] Error procesando webhook:", err.message);
    });
  });
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Elegance Meta Lead Ads webhook",
    hasAccessToken: Boolean(process.env.META_LEADS_ACCESS_TOKEN || process.env.IG_ACCESS_TOKEN),
    graphVersion: process.env.META_GRAPH_VERSION || "v24.0",
  });
});

app.listen(PORT, () => {
  console.log(`[meta-leads] Webhook directo de Meta Lead Ads escuchando en puerto ${PORT}.`);
});
