// Almacen persistente simple en disco, para que el bot no "pierda la
// memoria" en cada reinicio del proceso. Guarda dos cosas:
//  - el registro de IDs de mensaje/comentario ya procesados (evita
//    responder dos veces al mismo mensaje si el proceso se reinicia)
//  - el historial de conversacion por clave (mismo formato que memory.js)
//
// Es un archivo JSON en disco: sobrevive a un reinicio del proceso dentro
// del mismo contenedor (crash, OOM, redeploy sin recrear el volumen). Si
// Railway recrea el contenedor desde cero sin un volumen persistente
// montado en DATA_DIR, el archivo se pierde y se vuelve a crear vacio --
// igual que pasaba antes con la memoria en RAM, pero ya no es el caso
// normal, solo el peor caso.

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const PROCESSED_TTL_MS = 2 * 60 * 1000; // TEMPORAL: bajado de 24h a 2min para liberar el backlog atascado por el fallo de IA de hoy; volver a 24h despues.
const CONVERSATION_TTL_MS =
(Number(process.env.CONVERSATION_TTL_HOURS) || 12) * 60 * 60 * 1000;
const MAX_TURNS = 10; // 10 intercambios (20 mensajes) como maximo por conversacion

function loadState() {
try {
const raw = fs.readFileSync(STATE_FILE, "utf8");
const parsed = JSON.parse(raw);
return {
processed: parsed.processed || {},
conversations: parsed.conversations || {},
};
} catch {
return { processed: {}, conversations: {} };
}
}

let state = loadState();
let saveScheduled = false;

function scheduleSave() {
if (saveScheduled) return;
saveScheduled = true;
setImmediate(() => {
saveScheduled = false;
try {
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify(state));
} catch (err) {
console.error("[store] No se pudo guardar el estado en disco:", err.message);
}
});
}

function alreadyProcessed(id) {
if (!id) return false;
const ts = state.processed[id];
if (!ts) return false;
if (Date.now() - ts > PROCESSED_TTL_MS) {
delete state.processed[id];
return false;
}
return true;
}

function markProcessed(id) {
if (!id) return;
state.processed[id] = Date.now();
scheduleSave();
}

  function unmarkProcessed(id) {
      if (!id) return;
      delete state.processed[id];
      scheduleSave();
  }

  function clearProcessed() {
    const count = Object.keys(state.processed).length;
    state.processed = {};
    scheduleSave();
    return count;
  }

function getHistory(key) {
const entry = state.conversations[key];
if (!entry) return [];
if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
delete state.conversations[key];
return [];
}
return entry.messages;
}

function appendTurn(key, userText, assistantText) {
const entry = state.conversations[key] || { messages: [], updatedAt: Date.now() };
entry.messages.push({ role: "user", content: userText });
entry.messages.push({ role: "assistant", content: assistantText });
const maxMessages = MAX_TURNS * 2;
if (entry.messages.length > maxMessages) {
entry.messages = entry.messages.slice(entry.messages.length - maxMessages);
}
entry.updatedAt = Date.now();
state.conversations[key] = entry;
scheduleSave();
}

// Limpieza periodica de entradas caducadas, para que el archivo no crezca
// indefinidamente.
setInterval(() => {
const now = Date.now();
let changed = false;
for (const [id, ts] of Object.entries(state.processed)) {
if (now - ts > PROCESSED_TTL_MS) {
delete state.processed[id];
changed = true;
}
}
for (const [key, entry] of Object.entries(state.conversations)) {
if (now - entry.updatedAt > CONVERSATION_TTL_MS) {
delete state.conversations[key];
changed = true;
}
}
if (changed) scheduleSave();
}, 60 * 60 * 1000).unref();

module.exports = { alreadyProcessed, unmarkProcessed, markProcessed, clearProcessed, getHistory, appendTurn };
