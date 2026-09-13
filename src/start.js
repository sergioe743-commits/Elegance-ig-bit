// Application bootstrap.
// Starts the main webhook server, the Meta-Ads-only WhatsApp automation,
// persistent lead/funnel tracking and Google Sheets treatment attribution.

require("./server");
const { startWhatsAppBot } = require("./whatsappBot");
const { startLeadTracker } = require("./leadTracker");
const { startTreatmentSync } = require("./treatmentSync");

startWhatsAppBot();
startLeadTracker();
startTreatmentSync();
