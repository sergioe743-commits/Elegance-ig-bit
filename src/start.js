// Application bootstrap. Re-enabled on explicit user request.
require("./server");
const { startWhatsAppBot } = require("./whatsappBot");
const { startLeadTracker } = require("./leadTracker");
const { startTreatmentSync } = require("./treatmentSync");
const { startInboxRecovery } = require("./inboxRecovery");

startWhatsAppBot();
startLeadTracker();
startInboxRecovery();
startTreatmentSync();
