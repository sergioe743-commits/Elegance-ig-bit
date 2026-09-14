// Application bootstrap.
// Starts the main webhook server, the Meta-Ads-only WhatsApp automation,
// persistent lead/funnel tracking, get.chat inbox recovery and Google Sheets attribution.

require("./server");
const { startWhatsAppBot } = require("./whatsappBot");
const { startLeadTracker } = require("./leadTracker");
const { startTreatmentSync } = require("./treatmentSync");
const { startInboxRecovery } = require("./inboxRecovery");

startWhatsAppBot();
startLeadTracker();
startInboxRecovery();
startTreatmentSync();
