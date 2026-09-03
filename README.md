# Elegance IG Bot

Bot de Instagram (DMs + comentarios) para el Dr. Sergio Quintero / Elegance
Medical S.L. Responde automaticamente en la voz de marca de la clinica,
usando Claude (Anthropic) como motor principal para redactar cada
respuesta, con GPT (OpenAI) como respaldo automatico si Claude falla por
cualquier motivo (cuenta, saldo, red, etc.), y escala a revision humana
cualquier mensaje sensible (urgencias, salud, autolesion, menores,
reclamaciones) en lugar de auto-responderlo.

## Como funciona

Paso 1: Meta envia un evento al webhook (POST /webhook) cuando alguien
escribe un DM o comenta una publicacion.

Paso 2: El servidor verifica la firma (X-Hub-Signature-256) para confirmar
que el evento viene realmente de Meta.

Paso 3: Se comprueba si el texto contiene alguna senal de alerta
(src/safety.js). Si la hay, se responde con un mensaje neutro de espera y
NO se genera contenido automatico, queda para que el equipo de la clinica
lo revise a mano.

Paso 4: Si no hay alerta, se detecta si quien escribe parece paciente o
medico (misma heuristica) y se genera la respuesta con Claude, usando el
system prompt de marca (src/prompts.js). Si Claude falla, se reintenta
automaticamente con GPT usando el mismo system prompt, para que el bot
siga respondiendo aunque uno de los dos proveedores tenga un problema
puntual.

Paso 5: La respuesta se envia por la Graph API de Instagram
(src/instagram.js): DM de vuelta si era un mensaje directo, o respuesta
publica si era un comentario.

Todo el procesamiento es automatico y sin paso de aprobacion manual
(automatizacion "autonoma total"), salvo los casos que la heuristica de
seguridad decide escalar.

## Estructura del proyecto

La carpeta elegance-ig-bot contiene: package.json, .env.example (plantilla
de variables de entorno, copiar a .env), README.md, y la carpeta src con
server.js (servidor Express: webhook GET/POST, verificacion de firma),
prompts.js (voz de marca / system prompt), safety.js
(heuristica de escalado + deteccion paciente/medico), claude.js (cliente
combinado: llama primero a la API de Anthropic/Claude y, si falla, a la de
OpenAI/GPT como respaldo automatico), e instagram.js (llamadas a la Graph
API de Instagram).

## Configurar variables de entorno

Copia .env.example a .env y rellena estos valores.

IG_ACCESS_TOKEN es el token de acceso de tu cuenta profesional de
Instagram (Standard Access, permisos instagram_business_manage_messages y
instagram_business_manage_comments). Se genera desde el panel de la app
"Elegance AI Bot" en developers.facebook.com, tu app, Instagram, API setup
with Instagram business login, boton "Generate token".

IG_ACCOUNT_ID es el ID numerico de tu cuenta de Instagram (no el
@usuario). Aparece en ese mismo panel de configuracion de la API.

META_VERIFY_TOKEN es una frase secreta que TU inventas. Tiene que ser
exactamente igual aqui y en el panel de Meta al configurar el webhook.

META_APP_SECRET esta en App settings, Basic, boton "Show" junto a App
Secret, en el dashboard de la app.

ANTHROPIC_API_KEY es tu clave de la API de Anthropic
(console.anthropic.com, API Keys). Es el motor principal de respuestas.

OPENAI_API_KEY es tu clave de la API de OpenAI (platform.openai.com, API
Keys). Se usa automaticamente como respaldo si Claude falla. OPENAI_MODEL
es opcional (por defecto gpt-5.6-sol).

ESCALATION_WEBHOOK_URL es opcional: si quieres que el equipo reciba un
aviso (por ejemplo en un canal de Slack via "Incoming Webhook") cada vez
que un mensaje se escala a revision humana, pon aqui esa URL. Si lo dejas
vacio, simplemente no se envia ningun aviso externo.

## Probarlo en local (opcional pero recomendado)

Ejecuta: npm install
Luego: npm start

El servidor arranca en http://localhost:3000. Puedes comprobar que esta
vivo con: curl http://localhost:3000/

## Desplegarlo (hosting)

El bot necesita un proceso Node.js corriendo de forma continua con una URL
publica HTTPS. Se despliega via Railway, conectando este repositorio de
GitHub y configurando las variables de entorno de arriba.

## Configurar el webhook en Meta

Entra al dashboard de la app ("Elegance AI Bot", app_id 1630931644894507)
en developers.facebook.com/apps/. En el menu lateral, ve al producto
Webhooks.

Callback URL: https://tu-url-publica/webhook
Verify Token: el mismo valor exacto que pusiste en META_VERIFY_TOKEN.

Al guardar, Meta hace una peticion GET a tu webhook para verificarlo.
Suscribete a los campos del producto Instagram: messages y comments.

## Notas de seguridad y marca

El bot nunca revela que es una IA/bot, responde siempre en nombre de la
consulta. Nunca da pautas medicas personalizadas, dosis, ni diagnosticos a
distancia, eso siempre deriva a "reservar una valoracion". Los mensajes
con senales de alerta (urgencias, embarazo, medicacion, alergias, salud
mental, menores, reclamaciones legales) se escalan siempre a revision
humana, nunca reciben respuesta medica automatica.

Puedes ajustar que palabras disparan el escalado editando
RED_FLAG_PATTERNS en src/safety.js, y ajustar el tono/reglas de marca
editando BRAND_CORE en src/prompts.js.
Puedes ajustar que palabras disparan el escalado editando
RED_FLAG_PATTERNS en src/safety.js, y ajustar el tono/reglas de marca
editando BRAND_CORE en src/prompts.js.
