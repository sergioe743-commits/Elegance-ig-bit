// Cliente de Anthropic (Claude) -- genera el texto de cada respuesta
// (DM o comentario) usando la voz de marca definida en prompts.js.

const Anthropic = require("@anthropic-ai/sdk");
const { buildSystemPrompt } = require("./prompts");

const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

/**
 * Genera la respuesta de Claude para un mensaje entrante.
 * @param {Object} params
 * @param {string} params.text - Texto del DM o comentario recibido.
 * @param {"patient"|"doctor"} params.audience - Publico detectado.
 * @param {"dm"|"comment"} params.channel - Canal de origen.
 * @param {string} [params.context] - Contexto adicional opcional (p.ej. texto
 *   del post al que responde el comentario), para que Claude no repita lo
 *   que ya se dice en el video/post.
 * @returns {Promise<string>} Texto listo para publicar/enviar.
 */
async function generateReply({ text, audience, channel, context }) {
    const systemPrompt = buildSystemPrompt({ audience, channel });

  const userContent = context
      ? `Contexto del post/video (no lo repitas literalmente):\n"""${context}"""\n\nMensaje recibido (${channel === "comment" ? "comentario publico" : "DM"}):\n"""${text}"""`
        : `Mensaje recibido (${channel === "comment" ? "comentario publico" : "DM"}):\n"""${text}"""`;

  const response = await client.messages.create({
        model: MODEL,
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
  });

  const block = response.content.find((b) => b.type === "text");
    const reply = block ? block.text.trim() : "";

  if (!reply) {
        throw new Error("Claude no devolvio texto de respuesta.");
  }

  return reply;
}

module.exports = { generateReply };
