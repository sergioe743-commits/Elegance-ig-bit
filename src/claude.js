// Cliente de OpenAI (GPT) -- genera el texto de cada respuesta
// (DM o comentario) usando la voz de marca definida en prompts.js.
//
// Nota: este archivo se sigue llamando "claude.js" y sigue exportando
// "generateReply" con la misma firma para no tener que tocar server.js.
// El motor de generacion es ahora GPT (OpenAI) en lugar de Claude
// (Anthropic), por un bloqueo de acceso a la API de Anthropic en la
// cuenta de Anthropic Console (no relacionado con el saldo).

const axios = require("axios");
const { buildSystemPrompt } = require("./prompts");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.2-chat-latest";

const client = axios.create({
        baseURL: "https://api.openai.com/v1",
        headers: {
                  Authorization: `Bearer ${OPENAI_API_KEY}`,
                  "Content-Type": "application/json",
        },
        timeout: 30000,
});

/**
 * Genera la respuesta de GPT para un mensaje entrante.
 * @param {Object} params
 * @param {string} params.text - Texto del DM o comentario recibido.
 * @param {"patient"|"doctor"} params.audience - Publico detectado.
 * @param {"dm"|"comment"} params.channel - Canal de origen.
 * @param {string} [params.context] - Contexto adicional opcional (p.ej. texto
 *   del post al que responde el comentario), para que el modelo no repita lo
 *   que ya se dice en el video/post.
 * @param {Array<{role: "user"|"assistant", content: string}>} [params.history] -
 *   Turnos anteriores de esta misma conversacion (mas antiguo primero), para
 *   que el modelo tenga memoria real de lo ya hablado y no repita preguntas.
 * @returns {Promise<string>} Texto listo para publicar/enviar.
 */
async function generateReply({ text, audience, channel, context, history = [] }) {
        const systemPrompt = buildSystemPrompt({ audience, channel });

  const userContent = context
          ? `Contexto del post/video (no lo repitas literalmente):\n"""${context}"""\n\nMensaje recibido (${channel === "comment" ? "comentario publico" : "DM"}):\n"""${text}"""`
            : `Mensaje recibido (${channel === "comment" ? "comentario publico" : "DM"}):\n"""${text}"""`;

  const messages = [
        { role: "system", content: systemPrompt },
            ...history,
        { role: "user", content: userContent },
          ];

  let response;
        try {
                  response = await client.post("/chat/completions", {
                              model: MODEL,
                              max_tokens: 400,
                              messages,
                  });
        } catch (err) {
                  const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
                  throw new Error(`OpenAI error: ${detail}`);
        }

  const reply = response.data?.choices?.[0]?.message?.content?.trim() || "";

  if (!reply) {
            throw new Error("GPT no devolvio texto de respuesta.");
  }

  return reply;
}

module.exports = { generateReply };
