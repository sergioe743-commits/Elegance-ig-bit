// Application bootstrap.
// Start the existing Instagram/WhatsApp webhook server, then the isolated
// Meta-Ads-only WhatsApp automation. WHATSAPP_BOT_MODE defaults to shadow.

require("./server");
const { startWhatsAppBot } = require("./whatsappBot");
startWhatsAppBot();
