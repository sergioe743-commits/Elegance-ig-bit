// Application bootstrap.
// Starts the webhook server, the Meta-Ads-only WhatsApp automation and the
// persistent lead/funnel tracker.

require("./server");
const { startWhatsAppBot } = require("./whatsappBot");
const { startLeadTracker } = require("./leadTracker");

startWhatsAppBot();
startLeadTracker();
