// Cliente combinado Claude (Anthropic) + GPT (OpenAI) -- genera el texto
// de cada respuesta (DM o comentario) usando la voz de marca definida en
// prompts.js.
//
// Estrategia: intenta primero con Claude. Si Claude falla por cualquier
// motivo (cuenta con acceso desactivado, sin saldo, error de red, etc.),
// usa GPT automaticamente como respaldo, para que el bot siga respondiendo
// aunque uno de los dos proveedores tenga un problema puntual de cuenta.

const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");
const { buildSystemPrompt } = require("./prompts");

const anthropicClient = new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY,
});
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

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

async function generateWithClaude(systemPrompt, messages) {
          const response = await anthropicClient.messages.create({
                      model: ANTHROPIC_MODEL,
                      max_tokens: 400,
                      system: systemPrompt,
                      messages,
          });

  const block = response.content.find((b) => b.type === "text");
          const reply = block ? block.text.trim() : "";

  if (!reply) {
              throw new Error("Claude no devolvio texto de respuesta.");
  }

  return reply;
}

async function generateWithGPT(systemPrompt, messages) {
          let response;
          try {
                      response = await openaiClient.post("/chat/completions", {
                                    model: OPENAI_MODEL,
                                    max_tokens: 400,
                                    messages: [{ role: "system", content: systemPrompt }, ...messages],
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

/**
 * Genera la respuesta para un mensaje entrante. Intenta primero con Claude
 * y, si falla, usa GPT como respaldo automatico.
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

  const messages = [...history, { role: "user", content: userContent }];

  try {
              return await generateWithClaude(systemPrompt, messages);
  } catch (claudeErr) {
              console.error(`[claude.js] Claude fallo, usando GPT como respaldo: ${claudeErr.message}`);
              try {
                            return await generateWithGPT(systemPrompt, messages);
              } catch (gptErr) {
                            console.error(`[claude.js] GPT tambien fallo: ${gptErr.message}`);
                            throw new Error(`Ambos proveedores de IA fallaron. Claude: ${claudeErr.message} | GPT: ${gptErr.message}`);
              }
  }
}

module.exports = { generateReply };
