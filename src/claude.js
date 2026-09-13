// Cliente de IA -- genera el texto de cada respuesta (DM, comentario o WhatsApp)
// usando la voz de marca definida en prompts.js.
//
// Usa GPT (OpenAI) como unico motor de respuesta.

const axios = require("axios");
const { buildSystemPrompt } = require("./prompts");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-sol";

const openaiClient = axios.create({
  baseURL: "https://api.openai.com/v1",
  headers: {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

function extractReply(response) {
  const content = response?.data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }
  return "";
}

async function requestGPT(systemPrompt, messages, maxCompletionTokens) {
  try {
    return await openaiClient.post("/chat/completions", {
      model: OPENAI_MODEL,
      max_completion_tokens: maxCompletionTokens,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
    });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`OpenAI error: ${detail}`);
  }
}

async function generateWithGPT(systemPrompt, messages) {
  // Primer intento con margen suficiente para modelos de razonamiento.
  let response = await requestGPT(systemPrompt, messages, 1000);
  let reply = extractReply(response);
  if (reply) return reply;

  // Un unico reintento controlado si OpenAI devuelve una completion vacia.
  // Evita bucles y reduce la posibilidad de dejar al paciente sin respuesta
  // por una respuesta transitoria sin contenido.
  console.warn("[openai] Completion vacia; reintentando una vez.");
  response = await requestGPT(
    systemPrompt,
    [
      ...messages,
      {
        role: "system",
        content: "Responde ahora con un mensaje breve y util para el usuario. No devuelvas una respuesta vacia.",
      },
    ],
    1200
  );
  reply = extractReply(response);

  if (!reply) {
    throw new Error("GPT no devolvio texto de respuesta tras 2 intentos.");
  }

  return reply;
}

/**
 * Genera la respuesta para un mensaje entrante usando GPT.
 * @param {Object} params
 * @param {string} params.text - Texto recibido.
 * @param {"patient"|"doctor"} params.audience - Publico detectado.
 * @param {"dm"|"comment"|"whatsapp"} params.channel - Canal de origen.
 * @param {string} [params.context] - Contexto adicional opcional.
 * @param {Array<{role: "user"|"assistant", content: string}>} [params.history] - Turnos anteriores.
 * @returns {Promise<string>} Texto listo para publicar/enviar.
 */
async function generateReply({ text, audience, channel, context, history = [] }) {
  const systemPrompt = buildSystemPrompt({ audience, channel });

  const channelLabel = channel === "comment" ? "comentario publico" : channel === "whatsapp" ? "WhatsApp" : "DM";
  const userContent = context
    ? `Contexto adicional (no lo repitas literalmente):\n"""${context}"""\n\nMensaje recibido (${channelLabel}):\n"""${text}"""`
    : `Mensaje recibido (${channelLabel}):\n"""${text}"""`;

  const messages = [...history, { role: "user", content: userContent }];
  return generateWithGPT(systemPrompt, messages);
}

module.exports = { generateReply };
