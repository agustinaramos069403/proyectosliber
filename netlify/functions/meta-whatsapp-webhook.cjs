/**
 * WhatsApp Cloud API (Meta) webhook — Netlify Function
 *
 * Env vars (Netlify UI → Site settings → Environment variables):
 * - WHATSAPP_VERIFY_TOKEN     (you choose it; same in Meta app webhook config)
 * - WHATSAPP_ACCESSff_TOKEN     (temporary or system user token from Meta)
 * - WHATSAPP_PHONE_NUMBER_ID  (from Meta WhatsApp > API setup)
 * - CALENDLY_CORRIENTES, CALENDLY_RESISTENCIA, CALENDLY_SAENZ_PENA, CALENDLY_FORMOSA
 *   (full URLs to book; if missing, bot sends text asking to confirm by phone)
 * - OPENAI_API_KEY (optional; if set, non-sede messages get a short Spanish reply via OpenAI)
 * - OPENAI_MODEL (optional; default gpt-4o-mini)
 */

const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';
const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_MAX_OUTPUT_TOKENS = 400;
const OPENAI_CHAT_TEMPERATURE = 0.6;

/** Safe log line to confirm Netlify picked up a new token (never log the raw token). */
function describeAccessTokenForLogs(secret) {
  if (secret == null || typeof secret !== 'string' || secret.length === 0) {
    return 'missing';
  }
  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    return 'missing-after-trim';
  }
  const fingerprint = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
  return `length=${trimmed.length} fingerprint=${fingerprint}`;
}

const SEDE_ENTRIES = [
  {
    displayName: 'Corrientes',
    match: ['corrientes', '1', 'clinica del pilar', 'clínica del pilar', 'pilar'],
    envKey: 'CALENDLY_CORRIENTES',
  },
  {
    displayName: 'Resistencia',
    match: [
      'resistencia',
      '2',
      'immi',
      'instituto modelo de medicina infantil',
      'instituto modelo medicina infantil',
      'modelo de medicina infantil',
    ],
    envKey: 'CALENDLY_RESISTENCIA',
  },
  {
    displayName: 'Sáenz Peña',
    match: ['sáenz peña', 'saenz pena', 'saenz', '3', 'santa maria', 'santa maría'],
    envKey: 'CALENDLY_SAENZ_PENA',
  },
  {
    displayName: 'Formosa',
    match: ['formosa', '4', 'gastroenterologia', 'gastroenterología'],
    envKey: 'CALENDLY_FORMOSA',
  },
];

function normalizeForMatch(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim();
}

function findSedeFromText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  const normalized = normalizeForMatch(rawText);

  if (/^[1-4]$/.test(trimmed)) {
    const index = parseInt(trimmed, 10) - 1;
    return SEDE_ENTRIES[index] || null;
  }

  for (const entry of SEDE_ENTRIES) {
    for (const keyword of entry.match) {
      if (/^[1-4]$/.test(keyword)) continue;
      const keyNorm = normalizeForMatch(keyword);
      if (normalized === keyNorm || normalized.includes(keyNorm)) {
        return entry;
      }
    }
  }
  return null;
}

function getAgendaUrl(entry) {
  const url = process.env[entry.envKey];
  return url && url.startsWith('http') ? url : null;
}

function buildAskSedeMessage() {
  return [
    'No indiqué en qué sede querés agendar.',
    '',
    'Elegí una opción (podés responder con el número o el nombre de la ciudad):',
    '',
    '1 — Corrientes (Clínica del Pilar)',
    '2 — Resistencia (Instituto Modelo de Medicina Infantil)',
    '3 — Sáenz Peña (Clínica Santa María)',
    '4 — Formosa (Inst. de Gastroenterología)',
    '',
    'Cuando elijas, te envío el link para reservar turno.',
  ].join('\n');
}

function buildLinkMessage(entry) {
  const url = getAgendaUrl(entry);
  if (url) {
    return `Perfecto, sede *${entry.displayName}*.\n\nAgendá tu turno acá:\n${url}`;
  }
  return [
    `Recibimos tu preferencia por *${entry.displayName}*.`,
    '',
    'El link de agenda online todavía no está configurado.',
    'Escribinos el horario preferido y te confirmamos por este chat.',
  ].join('\n');
}

function describeOpenAiApiKeyForLogs(secret) {
  if (secret == null || typeof secret !== 'string' || secret.length === 0) {
    return 'missing';
  }
  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    return 'missing-after-trim';
  }
  const fingerprint = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
  return `length=${trimmed.length} fingerprint=${fingerprint}`;
}

function getOpenAiModelName() {
  const fromEnvironment = process.env.OPENAI_MODEL;
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim().length > 0) {
    return fromEnvironment.trim();
  }
  return DEFAULT_OPENAI_MODEL;
}

function getOpenAiApiKey() {
  const raw = process.env.OPENAI_API_KEY;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Short conversational reply when the user did not match a sede keyword.
 * Returns null if OpenAI is not configured or the request fails.
 */
async function fetchOpenAiAssistantReply(userMessage) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    return null;
  }
  const modelName = getOpenAiModelName();
  console.info(
    'meta-whatsapp-webhook: OpenAI request',
    'model=',
    modelName,
    'keyForLogs=',
    describeOpenAiApiKeyForLogs(apiKey)
  );

  const systemPrompt = [
    'You are a short, friendly WhatsApp assistant for Dr. Liber Acosta (allergy and immunology practice in Argentina).',
    'Rules:',
    '- Always reply in Spanish (Argentina). Be concise (at most about six short sentences unless the user asks for more detail).',
    '- If the user greets or makes small talk, respond warmly and briefly, then guide them to choose an office to book.',
    '- Do not give medical diagnoses or treatment advice; suggest consulting the doctor in person.',
    '- Do not invent obra social or insurance coverage; say it changes often and must be confirmed with the office.',
    '- The practice has exactly four offices. Ask the user to pick one by number or name:',
    '  1 — Corrientes (Clínica del Pilar)',
    '  2 — Resistencia (Instituto Modelo de Medicina Infantil)',
    '  3 — Sáenz Peña (Clínica Santa María)',
    '  4 — Formosa (Inst. de Gastroenterología)',
    '- Plain text only (no markdown headings). You may use * for emphasis sparingly like WhatsApp.',
    '- Do not invent booking URLs; the system sends links after the user picks a sede.',
  ].join('\n');

  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        temperature: OPENAI_CHAT_TEMPERATURE,
        max_tokens: OPENAI_MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error', response.status, errorText.slice(0, 800));
      return null;
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim().length === 0) {
      console.error('OpenAI empty content', JSON.stringify(data).slice(0, 600));
      return null;
    }
    return text.trim();
  } catch (error) {
    console.error('OpenAI request failed', error);
    return null;
  }
}

/**
 * WhatsApp webhooks often send Argentine mobiles as 549 + area(3) + subscriber(7).
 * Meta's API / allow-list for the same line may expect 54 + area + "15" + subscriber
 * (equivalent to +54 9 … in the UI). Only rewrite when this exact 13-digit pattern matches.
 */
function normalizeRecipientDigitsForMetaGraphApi(recipientDigits) {
  if (typeof recipientDigits !== 'string' || recipientDigits.length === 0) {
    return recipientDigits;
  }
  const trimmed = recipientDigits.trim();
  const matchArgentinaWebhookFormat = trimmed.match(/^549(\d{3})(\d{7})$/);
  if (matchArgentinaWebhookFormat) {
    const areaCodeDigits = matchArgentinaWebhookFormat[1];
    const subscriberDigits = matchArgentinaWebhookFormat[2];
    return `54${areaCodeDigits}15${subscriberDigits}`;
  }
  return trimmed;
}

async function sendWhatsAppText(toPhoneId, body) {
  const token =
    typeof process.env.WHATSAPP_ACCESS_TOKEN === 'string'
      ? process.env.WHATSAPP_ACCESS_TOKEN.trim()
      : '';
  let phoneNumberId =
    typeof process.env.WHATSAPP_PHONE_NUMBER_ID === 'string'
      ? process.env.WHATSAPP_PHONE_NUMBER_ID.trim()
      : '';
  if (phoneNumberId.startsWith('+')) {
    phoneNumberId = phoneNumberId.slice(1);
  }
  if (!token || !phoneNumberId) {
    console.error('Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID');
    return;
  }
  const digitsOnlyPhoneNumberId = /^\d+$/.test(phoneNumberId);
  const metaPhoneNumberIdMinLength = 14;
  if (!digitsOnlyPhoneNumberId || phoneNumberId.length < metaPhoneNumberIdMinLength) {
    console.error(
      'WHATSAPP_PHONE_NUMBER_ID must be the long numeric "Phone number ID" from Meta (WhatsApp > API setup), not the customer WhatsApp number (e.g. not 15556489769). Current value length:',
      phoneNumberId.length,
      'digitsOnly=',
      digitsOnlyPhoneNumberId
    );
    return;
  }
  const rawRecipientDigits =
    typeof toPhoneId === 'string' ? toPhoneId.trim() : '';
  const recipientDigitsForGraph = normalizeRecipientDigitsForMetaGraphApi(rawRecipientDigits);
  if (recipientDigitsForGraph !== rawRecipientDigits) {
    console.info(
      'meta-whatsapp-webhook: normalized recipient for Graph API',
      rawRecipientDigits,
      '->',
      recipientDigitsForGraph
    );
  }
  console.info('meta-whatsapp-webhook: Graph API auth', describeAccessTokenForLogs(token));
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: recipientDigitsForGraph,
      type: 'text',
      text: { preview_url: true, body },
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    const recipientLength = rawRecipientDigits.length;
    console.error(
      'Meta API error',
      response.status,
      errText,
      'tokenForLogs=',
      describeAccessTokenForLogs(token),
      'graphRecipientFromWebhook=',
      rawRecipientDigits,
      'graphRecipientSentToMeta=',
      recipientDigitsForGraph,
      'graphRecipientLength=',
      recipientLength
    );
    if (String(errText).includes('131030')) {
      console.error(
        'meta-whatsapp-webhook: 131030 — allow-list must match graphRecipientSentToMeta. For AR 549+3+7 webhook format we rewrite to 54+area+15+subscriber (Meta console style).'
      );
    }
  }
}

/**
 * Meta sends hub.mode, hub.verify_token, hub.challenge as query params.
 * Some gateways omit dotted keys in queryStringParameters; parse from raw query when possible.
 */
function getRawQueryStringFromEvent(event) {
  const candidates = [
    typeof event.rawQuery === 'string' ? event.rawQuery : null,
    typeof event.queryString === 'string' ? event.queryString : null,
    typeof event.path === 'string' && event.path.includes('?') ? event.path.split('?')[1] : null,
    event.requestContext &&
    typeof event.requestContext.path === 'string' &&
    event.requestContext.path.includes('?')
      ? event.requestContext.path.split('?')[1]
      : null,
    typeof event.rawUrl === 'string' && event.rawUrl.includes('?') ? event.rawUrl.split('?')[1] : null,
  ];
  for (const candidate of candidates) {
    if (candidate != null && String(candidate).length > 0) {
      return String(candidate).startsWith('?') ? String(candidate).slice(1) : String(candidate);
    }
  }
  return null;
}

function getMetaWebhookQueryParams(event) {
  const merged = { ...(event.queryStringParameters || {}) };
  const multi = event.multiValueQueryStringParameters || {};
  for (const [key, values] of Object.entries(multi)) {
    if (values && values[0] != null && merged[key] == null) {
      merged[key] = values[0];
    }
  }
  const rawQueryString = getRawQueryStringFromEvent(event);
  if (rawQueryString) {
    const searchParams = new URLSearchParams(rawQueryString);
    for (const key of ['hub.mode', 'hub.verify_token', 'hub.challenge']) {
      const value = searchParams.get(key);
      if (value != null && value !== '') {
        merged[key] = value;
      }
    }
  }
  return merged;
}

exports.handler = async (event) => {
  const method = (event.httpMethod || '').toUpperCase();
  if (method === 'GET') {
    const params = getMetaWebhookQueryParams(event);
    const mode = params['hub.mode'];
    const token = params['hub.verify_token'];
    const challenge = params['hub.challenge'];
    const verify = process.env.WHATSAPP_VERIFY_TOKEN;
    const tokenNormalized = typeof token === 'string' ? token.trim() : '';
    const verifyNormalized =
      typeof verify === 'string' ? verify.trim().replace(/^\uFEFF/, '') : '';
    if (
      mode === 'subscribe' &&
      tokenNormalized.length > 0 &&
      verifyNormalized.length > 0 &&
      tokenNormalized === verifyNormalized &&
      challenge
    ) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: String(challenge),
      };
    }
    if (!verifyNormalized) {
      console.error('Webhook verify failed: WHATSAPP_VERIFY_TOKEN is missing in Netlify environment');
    } else {
      console.error('Webhook verify failed: token mismatch or missing hub params');
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (method !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    let rawBody = event.body == null ? '{}' : String(event.body);
    if (event.isBase64Encoded) {
      rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
    }
    const payload = JSON.parse(rawBody || '{}');
    console.log(
      'meta-whatsapp-webhook: POST inbound object=',
      payload.object,
      'entryCount=',
      Array.isArray(payload.entry) ? payload.entry.length : 0
    );
    let processedTextMessageCount = 0;
    const entries = payload.entry || [];
    for (const ent of entries) {
      const changes = ent.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        for (const msg of messages) {
          if (msg.type !== 'text' || !msg.text?.body) continue;
          processedTextMessageCount += 1;
          const from = msg.from;
          const bodyText = msg.text.body;
          const sede = findSedeFromText(bodyText);
          if (sede) {
            await sendWhatsAppText(from, buildLinkMessage(sede));
          } else {
            const openAiReply = await fetchOpenAiAssistantReply(bodyText);
            if (openAiReply) {
              await sendWhatsAppText(from, openAiReply);
            } else {
              await sendWhatsAppText(from, buildAskSedeMessage());
            }
          }
        }
      }
    }
    if (processedTextMessageCount === 0) {
      console.log(
        'meta-whatsapp-webhook: POST had no handled text messages (only statuses/templates/etc.?). object=',
        payload.object,
        'entryCount=',
        entries.length
      );
    } else {
      console.log(
        'meta-whatsapp-webhook: handled incoming text message(s) count=',
        processedTextMessageCount
      );
    }
  } catch (error) {
    console.error('Webhook error', error);
    return { statusCode: 500, body: 'Error' };
  }

  return { statusCode: 200, body: 'OK' };
};
