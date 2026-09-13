// Application bootstrap.
// Starts the webhook servers, the Meta-Ads-only WhatsApp automation and the
// persistent lead/funnel tracker.

require("./server");
require("./metaLeadServer");
const { startWhatsAppBot } = require("./whatsappBot");
const { startLeadTracker } = require("./leadTracker");

startWhatsAppBot();
startLeadTracker();
