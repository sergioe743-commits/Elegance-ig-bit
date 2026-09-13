// Application bootstrap.
// Starts the main webhook server, the Meta-Ads-only WhatsApp automation and the
// persistent lead/funnel tracker. Meta Lead Ads runs as a dedicated Railway service.

require("./server");
const { startWhatsAppBot } = require("./whatsappBot");
const { startLeadTracker } = require("./leadTracker");

startWhatsAppBot();
startLeadTracker();
