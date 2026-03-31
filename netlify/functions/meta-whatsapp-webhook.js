/**
 * WhatsApp Cloud API (Meta) webhook — Netlify Function
 *
 * Env vars (Netlify UI → Site settings → Environment variables):
 * - WHATSAPP_VERIFY_TOKEN     (you choose it; same in Meta app webhook config)
 * - WHATSAPP_ACCESS_TOKEN     (temporary or system user token from Meta)
 * - WHATSAPP_PHONE_NUMBER_ID  (from Meta WhatsApp > API setup)
 * - CALENDLY_CORRIENTES, CALENDLY_RESISTENCIA, CALENDLY_SAENZ_PENA, CALENDLY_FORMOSA
 *   (full URLs to book; if missing, bot sends text asking to confirm by phone)
 */

const GRAPH_VERSION = 'v21.0';

const SEDE_ENTRIES = [
  {
    displayName: 'Corrientes',
    match: ['corrientes', '1', 'clinica del pilar', 'clínica del pilar', 'pilar'],
    envKey: 'CALENDLY_CORRIENTES',
  },
  {
    displayName: 'Resistencia',
    match: ['resistencia', '2', 'immi'],
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
    '2 — Resistencia (IMMI)',
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

async function sendWhatsAppText(toPhoneId, body) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.error('Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID');
    return;
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhoneId,
      type: 'text',
      text: { preview_url: true, body },
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error('Meta API error', response.status, errText);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const mode = params['hub.mode'];
    const token = params['hub.verify_token'];
    const challenge = params['hub.challenge'];
    const verify = process.env.WHATSAPP_VERIFY_TOKEN;
    if (mode === 'subscribe' && token === verify && challenge) {
      return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: challenge };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const entries = payload.entry || [];
    for (const ent of entries) {
      const changes = ent.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        for (const msg of messages) {
          if (msg.type !== 'text' || !msg.text?.body) continue;
          const from = msg.from;
          const bodyText = msg.text.body;
          const sede = findSedeFromText(bodyText);
          if (sede) {
            await sendWhatsAppText(from, buildLinkMessage(sede));
          } else {
            await sendWhatsAppText(from, buildAskSedeMessage());
          }
        }
      }
    }
  } catch (error) {
    console.error('Webhook error', error);
    return { statusCode: 500, body: 'Error' };
  }

  return { statusCode: 200, body: 'OK' };
};
