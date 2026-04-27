/**
 * WhatsApp Cloud API (Meta) webhook — Netlify Function
 *
 * Env vars (Netlify UI → Site settings → Environment variables):
 * - WHATSAPP_VERIFY_TOKEN fdf dsfdfgbfg   (you choose it; same in Meta app webhook config)
 * - cfACCESSdfsdfd_TOKEN     (temporary or system user token from Meta)
 * - WHAfdgfdgTSAfdggPP_ttydftyfdgdPHdsvgdfvONE_NUMBER_ID  (from Meta WhatsApp > API setup)
 * ional; if set, nondfgd-sede messages use OpdsfdsenAI with docs/agente-liber-reglas.md prompt file)
 * - OPENAI_MODEL (optional; default gpt-4o-mini)
 *
 * Conversational rules: docs/agente-liber-reglas.md — system prompt text: agente-liber-system-prompt.txt (same folder)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

const GRAPH_VERSION = 'v21.0';
const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_MAX_OUTPUT_TOKENS = 380;
const OPENAI_CHAT_TEMPERATURE = 0.6;

const GOOGLE_SHEETS_API_BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_SHEETS_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedGoogleSheetsData = null;
let cachedGoogleSheetsDataExpiresAtMs = 0;

const DEFAULT_CONVERSATION_STATE_TTL_SECONDS = 30 * 60;
const conversationStateByPhoneNumber = new Map();

const PRIVATE_PRICE_CITY_KEY_BY_DISPLAY_NAME = {
  Corrientes: 'Corrientes',
  Resistencia: 'Resistencia',
  Formosa: 'Formosa',
  'Sáenz Peña': 'Saenz Pena',
};

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
    match: [
      'corrientes',
      'corriente',
      'clinica del pilar',
      'clínica del pilar',
      'pilar',
      'ctes',
      'capital corrientes',
    ],
    envKey: 'CALENDLY_CORRIENTES',
    optionNumber: '1',
  },
  {
    displayName: 'Resistencia',
    match: [
      'resistencia',
      'resitencia',
      'resis',
      'resi',
      'immi',
      'instituto modelo de medicina infantil',
      'instituto modelo medicina infantil',
      'modelo de medicina infantil',
      'rcia',
      'capital chaco',
      'capital del chaco',
    ],
    envKey: 'CALENDLY_RESISTENCIA',
    optionNumber: '2',
  },
  {
    displayName: 'Sáenz Peña',
    match: [
      'sáenz peña',
      'saenz pena',
      'saens pena',
      'saenz peña',
      'saenz',
      'santa maria',
      'santa maría',
      'presidencia roca',
      'pcia roca',
      'pres roca',
      'presidente roca',
      'saenzpena',
    ],
    envKey: 'CALENDLY_SAENZ_PENA',
    optionNumber: '3',
  },
  {
    displayName: 'Formosa',
    match: ['formosa', 'formoza', 'gastroenterologia', 'gastroenterología', 'fsa'],
    envKey: 'CALENDLY_FORMOSA',
    optionNumber: '4',
  },
];

/** Normalized substrings; must match after normalizeForMatch (no accents). */
const EMERGENCY_NORMALIZED_SUBSTRINGS = [
  'no puedo respirar',
  'me falta el aire',
  'me ahogo',
  'me hincho la garganta',
  'se me hincho la garganta',
  'me hincho la cara',
  'se me hincho la cara',
  'reaccion alergica fuerte',
  'me desmaye',
  'me pico una abeja',
  'me pico una avispa',
  'anafilaxia',
  'anafilaxis',
  'urticaria muy fuerte',
  'me salio todo el cuerpo',
  'no aguanto mas',
  'emergencia',
  'urgencia',
  'urgente',
  'caso critico',
  'caso crítico',
  'critico',
  'crítico',
  'es urgente',
  'es una emergencia',
  'emergencia medica',
  'necesito urgencia',
];

const MEDICAL_EMERGENCY_RESPONSE_MESSAGE =
  'El Dr. no atiende urgencias. Si es una emergencia o urgencia, por favor acudí a la guardia/urgencias más cercana o llamá al 107 ahora.';

const CHACO_AMBIGUOUS_CLARIFICATION_MESSAGE =
  '¿Estás en Resistencia o en Sáenz Peña?';

const DEFAULT_RESPONSE_DELAY_MS = 3500;
const MAX_LEVENSHTEIN_DISTANCE = 3;

const MESSAGE_COLLECTION_WINDOW_MS = 6000;
const SMALL_TALK_COOLDOWN_MS = 20000;
const BOOKING_LINK_OFFER_OPTOUT_MS = 45 * 60 * 1000;
const BOOKING_LINK_RECENTLY_SENT_MS = 5 * 60 * 1000;
const BOOKING_LINK_TROUBLE_FOLLOWUP_WINDOW_MS = 10 * 60 * 1000;
const WAITLIST_CONFIRMATION_WINDOW_MS = 30 * 60 * 1000;
const SEDE_SELECTION_WINDOW_MS = 30 * 60 * 1000;
const NON_TEXT_WRITE_IT_DOWN_COOLDOWN_MS = 2 * 60 * 1000;

const STUDIES_INFORMATION_MESSAGE =
  'Sí, según el caso el Dr. puede indicar y/o coordinar estudios como tests de alergia (Prick Test), espirometría, laboratorio y test del parche.';

const DOCUMENTATION_REQUIREMENTS_MESSAGE =
  'Si tenés obra social: traé orden de consulta y las prácticas autorizadas. Si no: podés venir igual.';

const NO_REFERRAL_REQUIRED_MESSAGE = 'No necesitás derivación ni receta.';

const AUTHORIZATION_AND_DIGITAL_CARD_MESSAGE =
  'Sí, atendemos con autorización y aceptamos credencial digital.';

const INVOICE_MESSAGE = 'Sí, damos factura.';

const PAYMENT_METHODS_MESSAGE =
  'Podés pagar en efectivo o por transferencia/QR. Tarjeta y débito no.';

const CONSULT_DURATION_MESSAGE = 'Depende del caso.';

const COMPANION_ALLOWED_MESSAGE = 'Sí, podés ir con acompañante.';

const OTHER_PROVINCES_MESSAGE = 'No atendemos en otras provincias.';

const VIRTUAL_VISITS_MESSAGE = 'Sí, hacemos consulta virtual/videollamada.';

const STUDY_FASTING_MESSAGE = 'No, no hace falta ir en ayunas.';

const STUDY_PREPARATION_MEDICATION_MESSAGE =
  'Para test de alergia: suspender antialérgicos 48 hs antes y corticoides 1 semana antes. Para espirometría: no aplicar aerosoles ese día.';

const STUDY_DURATION_MESSAGE = 'Depende del caso.';

const MEDICATION_ALLERGY_STUDY_MESSAGE =
  'Para test de alergia a medicamentos, primero se realiza la consulta con el médico; según el medicamento se define el protocolo.';

const SEDE_ADDRESS_DETAILS_BY_ENV_KEY = {
  CALENDLY_CORRIENTES:
    'Clínica del Pilar: San Martín 555. Lunes, jueves y viernes 9:45 a 11:00 hs y 17:00 a 20:00 hs. Martes 17:00 a 20:00 hs.',
  CALENDLY_RESISTENCIA:
    'Resistencia (Instituto Modelo de Medicina Infantil): F. Ameghino 678. Martes 9:30 a 12:00.',
  CALENDLY_SAENZ_PENA:
    'Sáenz Peña (Clínica Santa María): Calle 5 entre 12 y 14. Miércoles (dos veces al mes) 8:00 a 12:00 hs.',
  CALENDLY_FORMOSA:
    'Formosa (Instituto Modelo de Gastroenterología): Maipú 1580. Miércoles (dos veces al mes) 8:00 a 12:00.',
};

const SEDE_MAPS_URL_BY_ENV_KEY = {
  CALENDLY_CORRIENTES:
    'https://google.com/maps/place/Cl%C3%ADnica+del+Pilar/data=!4m2!3m1!1s0x0:0x49146846c8c3ca7a?sa=X&ved=1t:2428&ictx=111',
  CALENDLY_RESISTENCIA:
    'https://www.google.com/maps/place/Immi,+Instituto+Modelo+de+Medicina+Infantil/@-27.4595693,-58.9866954,736m/data=!3m2!1e3!4b1!4m6!3m5!1s0x94450cedd359d8f5:0xefe1f0c59533241e!8m2!3d-27.4595741!4d-58.9841205!16s%2Fg%2F1tfczxpj?entry=ttu&g_ep=EgoyMDI2MDQyMi4wIKXMDSoASAFQAw%3D%3D',
  CALENDLY_SAENZ_PENA:
    'https://www.google.com/maps/place/Cl%C3%ADnica+Santa+Mar%C3%ADa/@-26.8004379,-60.4361063,740m/data=!3m2!1e3!4b1!4m6!3m5!1s0x94412d00746e10b5:0xac9d69f86ead35d0!8m2!3d-26.8004428!4d-60.4312354!16s%2Fg%2F11xztntc_h?entry=ttu&g_ep=EgoyMDI2MDQyMi4wIKXMDSoASAFQAw%3D%3D',
  CALENDLY_FORMOSA:
    'https://www.google.com/maps/place/Instituto+IMG+Formosa+(Instituto+Modelo+de+Gastroenterolog%C3%ADa)/@-26.1837531,-58.1864783,744m/data=!3m2!1e3!4b1!4m6!3m5!1s0x945ca5f9f106b2dd:0x4cc784833c09beb3!8m2!3d-26.1837579!4d-58.1839034!16s%2Fg%2F11bzvxmbt1?entry=ttu&g_ep=EgoyMDI2MDQyMi4wIKXMDSoASAFQAw%3D%3D',
};

const CORRIENTES_HOW_TO_ARRIVE_MESSAGE =
  'Corrientes: ingresá a la Clínica del Pilar, subí al primer piso por la escalera negra y consultá con la primera secretaria.';

const DERIVATIVE_HANDOFF_PATIENT_MESSAGE =
  'Dejame pasarte con alguien del equipo que te puede ayudar mejor. En breve te contactan.';

const MISSING_INFORMATION_CALL_OFFICE_MESSAGE =
  'No cuento con esa información en este momento. Por favor, llamá al consultorio y te lo confirman.';

const FALLBACK_AGENTE_LIBER_SYSTEM_PROMPT =
  'Sos la asistente del consultorio del Dr. Liber Acosta (alergista). Respondé en español argentino, texto plano, sin markdown ni asteriscos, máximo 2 oraciones. No des diagnósticos ni montos. Si pueden decir ciudad o 1-4 para sede, mejor. Reglas completas no cargadas en el servidor.';

let cachedAgenteLiberSystemPrompt = undefined;

const GREETING_NORMALIZED_TOKENS = new Set([
  'hola',
  'holaa',
  'buenas',
  'buenosdias',
  'buendia',
  'buenastardes',
  'buena tarde',
  'buenasnoches',
]);

const YES_NO_NORMALIZED_TOKENS = new Set(['si', 'sí', 'no']);

function normalizeForMatch(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim();
}

function shouldWriteDebugBotLogs() {
  const raw = process.env.DEBUG_BOT_LOGS;
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function debugBotLog(...parts) {
  if (!shouldWriteDebugBotLogs()) return;
  try {
    console.log('meta-whatsapp-webhook: DEBUG', ...parts);
  } catch {
    // ignore
  }
}

function sleepMs(durationMs) {
  const parsed = Number(durationMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, parsed));
}

function messageIsAcknowledgement(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length === 0) return false;
  // Short acknowledgements that often come after a helpful answer.
  if (/^(bueno|ok|oka|dale|listo|perfecto|genial|gracias|joya|bien)$/.test(normalized)) return true;
  return false;
}

function messageIsGreeting(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const token = normalized.replace(/\s+/g, '');
  if (GREETING_NORMALIZED_TOKENS.has(token)) return true;
  return /^(hola|buenas|buenos dias|buen dia|buenas tardes|buenas noches)\b/.test(normalized);
}

function messageLooksLikeGreetingOnly(rawText) {
  if (!messageIsGreeting(rawText)) return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const wordCount = normalized.split(' ').filter(Boolean).length;
  if (wordCount > 3) return false;
  // If the message contains another intent, treat it as a real request (not just a greeting).
  if (messageLooksLikeHealthInsurancePlusQuestion(rawText)) return false;
  if (messageLooksLikePrivatePriceQuestion(rawText)) return false;
  if (messageLooksLikeBookingIntent(rawText) || messageExplicitlyRequestsBookingLink(rawText)) return false;
  if (messageAsksAboutStudiesOrTests(rawText)) return false;
  if (messageAsksAboutConditionTreatment(rawText) || messageAsksAboutTreatmentCost(rawText)) return false;
  if (messageAsksAboutSedeAddressOrHowToArrive(rawText)) return false;
  if (
    messageAsksAboutDocumentationOrRequirements(rawText) ||
    messageAsksAboutReferralOrPrescription(rawText) ||
    messageAsksAboutInvoice(rawText) ||
    messageAsksAboutPaymentMethods(rawText)
  ) {
    return false;
  }
  return true;
}

function messageIsSmallTalk(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return (
    normalized === 'como estas' ||
    normalized === 'cómo estás' ||
    normalized === 'como estas?' ||
    normalized.startsWith('como estas ') ||
    normalized.startsWith('cómo estás ') ||
    normalized === 'que tal' ||
    normalized === 'qué tal' ||
    normalized.startsWith('que tal ') ||
    normalized.startsWith('qué tal ')
  );
}

function messageLooksLikeFragment(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  if (normalized.includes('?')) return false;
  const words = normalized.split(' ').filter(Boolean);
  if (words.length > 2) return false;
  if (normalized.length >= 16) return false;
  // Common fragments when the user is still typing.
  if (/^(necesito|quisiera|quiero|un|una|turno|consulta|para|por favor|porfa)$/.test(normalized)) return true;
  return false;
}

function buildCollectingUserMessageState(pendingUserText) {
  return {
    state: 'collecting_user_message',
    pendingUserText: String(pendingUserText || '').trim(),
    pendingUserTextAtMs: Date.now(),
  };
}

function stateLooksLikeCollectingUserMessage(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.state === 'collecting_user_message' &&
    typeof state.pendingUserText === 'string' &&
    state.pendingUserText.trim().length > 0
  );
}

function buildAnythingElseHelpMessage(priorState) {
  return '¿Querés que te ayude con algo más?';
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

function textMatchesMedicalEmergency(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  for (const phrase of EMERGENCY_NORMALIZED_SUBSTRINGS) {
    if (normalized.includes(phrase)) return true;
  }
  return false;
}

/**
 * "Chaco" without Resistencia vs Sáenz Peña disambiguation (see docs/agente-liber-reglas.md).
 */
function needsChacoProvinceClarification(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  if (!normalized.includes('chaco')) return false;
  if (findSedeFromText(rawText)) return false;
  const hasResistenciaOrSaenzHint =
    /resistencia|\brcia\b|saenz|pena|presidencia|presidente(\s*roca)?|pcia\s*roca|\broca\b|inmi|imm|capital(\s*del)?\s*chaco/.test(
      normalized
    );
  if (hasResistenciaOrSaenzHint) return false;
  return true;
}

function resolveWhatsAppProfileDisplayName(value, fromPhoneId) {
  const contacts = value.contacts;
  if (!Array.isArray(contacts)) return '';
  const fromDigits = typeof fromPhoneId === 'string' ? fromPhoneId.trim() : '';
  for (const contact of contacts) {
    const wide = contact?.wa_id != null ? String(contact.wa_id).trim() : '';
    if (fromDigits.length > 0 && wide.length > 0 && wide !== fromDigits) continue;
    const name = contact?.profile?.name;
    if (typeof name !== 'string') continue;
    const trimmedName = name.trim();
    if (trimmedName.length === 0) continue;
    if (/^\d+$/.test(trimmedName)) continue;
    if (/^(user|usuario|test)$/i.test(trimmedName)) continue;
    return trimmedName;
  }
  return '';
}

function loadAgenteLiberSystemPrompt() {
  if (cachedAgenteLiberSystemPrompt !== undefined) {
    return cachedAgenteLiberSystemPrompt;
  }
  try {
    const promptFilePath = path.join(__dirname, 'agente-liber-system-prompt.txt');
    cachedAgenteLiberSystemPrompt = fs.readFileSync(promptFilePath, 'utf8');
  } catch (error) {
    console.error('meta-whatsapp-webhook: could not read agente-liber-system-prompt.txt', error);
    cachedAgenteLiberSystemPrompt = null;
  }
  return cachedAgenteLiberSystemPrompt;
}

function buildOpenAiUserContent(userMessage, profileDisplayName) {
  const parts = [];
  if (typeof profileDisplayName === 'string' && profileDisplayName.trim().length > 0) {
    parts.push(`Nombre de perfil de WhatsApp del paciente (opcional): ${profileDisplayName.trim()}.`);
  }
  parts.push(`Mensaje del paciente:\n${userMessage}`);
  return parts.join('\n');
}

function getGoogleServiceAccountJson() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  return typeof raw === 'string' ? raw.trim() : '';
}

function getGoogleSheetsPlusCsvUrl() {
  const raw = process.env.GOOGLE_SHEETS_PLUS_CSV_URL;
  return typeof raw === 'string' ? raw.trim() : '';
}

function getGoogleSheetsPrivatePricesCsvUrl() {
  const raw = process.env.GOOGLE_SHEETS_PRIVATE_PRICES_CSV_URL;
  return typeof raw === 'string' ? raw.trim() : '';
}

function getGoogleSheetsSpreadsheetId() {
  const raw = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  return typeof raw === 'string' ? raw.trim() : '';
}

function getGoogleSheetsPlusSpreadsheetId() {
  const raw = process.env.GOOGLE_SHEETS_PLUS_SPREADSHEET_ID;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed.length > 0 ? trimmed : getGoogleSheetsSpreadsheetId();
}

function getGoogleSheetsPrivatePricesSpreadsheetId() {
  const raw = process.env.GOOGLE_SHEETS_PRIVATE_PRICES_SPREADSHEET_ID;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed.length > 0 ? trimmed : getGoogleSheetsSpreadsheetId();
}

function getGoogleSheetsPlusRange() {
  const raw = process.env.GOOGLE_SHEETS_PLUS_RANGE;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'HealthInsurancePlus!A:F';
}

function getGoogleSheetsPrivatePricesRange() {
  const raw = process.env.GOOGLE_SHEETS_PRIVATE_PRICES_RANGE;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'PrivatePrices!A:C';
}

function tryParseJson(rawJson) {
  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

function tryParseFirstJsonObjectFromText(rawText) {
  if (typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;
  const direct = tryParseJson(trimmed);
  if (direct) return direct;
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) return null;
  const candidate = trimmed.slice(firstBrace, lastBrace + 1);
  return tryParseJson(candidate);
}

function computeLevenshteinDistance(firstValue, secondValue) {
  const first = String(firstValue || '');
  const second = String(secondValue || '');
  if (first === second) return 0;
  if (first.length === 0) return second.length;
  if (second.length === 0) return first.length;

  const firstLength = first.length;
  const secondLength = second.length;
  const costs = new Array(secondLength + 1);
  for (let index = 0; index <= secondLength; index += 1) {
    costs[index] = index;
  }
  for (let firstIndex = 1; firstIndex <= firstLength; firstIndex += 1) {
    let previousDiagonal = costs[0];
    costs[0] = firstIndex;
    for (let secondIndex = 1; secondIndex <= secondLength; secondIndex += 1) {
      const temp = costs[secondIndex];
      const substitutionCost = first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1;
      costs[secondIndex] = Math.min(
        costs[secondIndex] + 1,
        costs[secondIndex - 1] + 1,
        previousDiagonal + substitutionCost
      );
      previousDiagonal = temp;
    }
  }
  return costs[secondLength];
}

function mapHealthInsuranceGuessToKnownName(guess, knownNames) {
  const guessRaw = typeof guess === 'string' ? guess.trim() : '';
  if (!guessRaw) return null;
  const guessKey = normalizeHealthInsuranceNameForKey(guessRaw);
  if (!guessKey) return null;

  const candidates = knownNames
    .map((name) => ({
      name,
      key: normalizeHealthInsuranceNameForKey(name),
    }))
    .filter((entry) => entry.key);

  for (const candidate of candidates) {
    if (candidate.key === guessKey) return candidate.name;
  }

  for (const candidate of candidates) {
    if (candidate.key.includes(guessKey) || guessKey.includes(candidate.key)) {
      return candidate.name;
    }
  }

  let best = null;
  for (const candidate of candidates) {
    const distance = computeLevenshteinDistance(candidate.key, guessKey);
    if (!Number.isFinite(distance)) continue;
    if (distance > MAX_LEVENSHTEIN_DISTANCE) continue;
    if (!best || distance < best.distance) {
      best = { name: candidate.name, distance };
    }
  }
  return best ? best.name : null;
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let insideQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      const next = line[index + 1];
      if (insideQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      insideQuotes = !insideQuotes;
      continue;
    }
    if (char === ',' && !insideQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => String(cell).trim());
}

function parseCsvToRows(csvText) {
  if (typeof csvText !== 'string' || csvText.trim().length === 0) return [];
  const lines = csvText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return lines.map(parseCsvLine);
}

function getConversationStateTtlSeconds() {
  const raw = process.env.CONVERSATION_STATE_TTL_SECONDS;
  const parsed = raw != null ? Number(String(raw).trim()) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(parsed, 24 * 60 * 60);
  }
  return DEFAULT_CONVERSATION_STATE_TTL_SECONDS;
}

function getUpstashRedisRestUrl() {
  const raw = process.env.UPSTASH_REDIS_REST_URL;
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  // Defensive: sometimes secrets are pasted with extra UI text (e.g. a browser prompt).
  // Extract the first URL-looking substring.
  const match = trimmed.match(/https?:\/\/[^\s\]]+/i);
  return (match ? match[0] : trimmed).trim();
}

function getUpstashRedisRestToken() {
  const raw = process.env.UPSTASH_REDIS_REST_TOKEN;
  return typeof raw === 'string' ? raw.trim() : '';
}

function isUpstashConfigured() {
  return getUpstashRedisRestUrl().length > 0 && getUpstashRedisRestToken().length > 0;
}

function buildConversationStateStorageKey(fromPhoneId) {
  const raw = typeof fromPhoneId === 'string' ? fromPhoneId.trim() : '';
  return raw.length > 0 ? `wa:${raw}` : null;
}

function getConversationStateKey(fromPhoneId) {
  const raw = typeof fromPhoneId === 'string' ? fromPhoneId.trim() : '';
  return raw.length > 0 ? raw : null;
}

async function fetchUpstashJson(pathname) {
  const baseUrl = getUpstashRedisRestUrl();
  const token = getUpstashRedisRestToken();
  if (!baseUrl || !token) return null;
  const trimmedBaseUrl = baseUrl.replace(/\/+$/, '');
  const trimmedPathname = pathname.replace(/^\/+/, '');
  const candidateBaseUrls = [trimmedBaseUrl];
  // Some Upstash consoles show the REST base URL with a trailing "/redis".
  // Make the integration tolerant: if the first attempt fails, retry with "/redis".
  if (!/\/redis$/i.test(trimmedBaseUrl)) {
    candidateBaseUrls.push(`${trimmedBaseUrl}/redis`);
  }

  let lastError = null;
  for (const candidateBaseUrl of candidateBaseUrls) {
    const url = `${candidateBaseUrl}/${trimmedPathname}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0 (Netlify Function) meta-whatsapp-webhook',
        },
      });
      if (!response.ok) {
        const text = await response.text();
        lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
        continue;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (lastError) {
    console.error('meta-whatsapp-webhook: Upstash fetch failed', String(lastError).slice(0, 500));
  }
  return null;
}

async function getConversationState(fromPhoneId) {
  if (isUpstashConfigured()) {
    const storageKey = buildConversationStateStorageKey(fromPhoneId);
    if (!storageKey) return null;
    const data = await fetchUpstashJson(`get/${encodeURIComponent(storageKey)}`);
    const value = data?.result;
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    const parsed = tryParseJson(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  }
  const key = getConversationStateKey(fromPhoneId);
  if (!key) return null;
  const entry = conversationStateByPhoneNumber.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAtMs) {
    conversationStateByPhoneNumber.delete(key);
    return null;
  }
  return entry.state;
}

async function setConversationState(fromPhoneId, state) {
  if (isUpstashConfigured()) {
    const storageKey = buildConversationStateStorageKey(fromPhoneId);
    if (!storageKey) return;
    const ttlSeconds = getConversationStateTtlSeconds();
    const payload = JSON.stringify(state);
    await fetchUpstashJson(
      `set/${encodeURIComponent(storageKey)}/${encodeURIComponent(payload)}?EX=${ttlSeconds}`
    );
    return;
  }
  const key = getConversationStateKey(fromPhoneId);
  if (!key) return;
  conversationStateByPhoneNumber.set(key, {
    state,
    expiresAtMs: Date.now() + getConversationStateTtlSeconds() * 1000,
  });
}

async function clearConversationState(fromPhoneId) {
  if (isUpstashConfigured()) {
    const storageKey = buildConversationStateStorageKey(fromPhoneId);
    if (!storageKey) return;
    await fetchUpstashJson(`del/${encodeURIComponent(storageKey)}`);
    return;
  }
  const key = getConversationStateKey(fromPhoneId);
  if (!key) return;
  conversationStateByPhoneNumber.delete(key);
}

async function fetchCsvRows(csvUrl) {
  if (!csvUrl) return null;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Netlify Function) meta-whatsapp-webhook',
    Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8',
  };
  const maxAttempts = 2;
  for (let attemptIndex = 1; attemptIndex <= maxAttempts; attemptIndex += 1) {
    try {
      const response = await fetch(csvUrl, { method: 'GET', headers });
      if (!response.ok) {
        const text = await response.text();
        console.error(
          'meta-whatsapp-webhook: CSV fetch failed',
          response.status,
          `attempt=${attemptIndex}`,
          text.slice(0, 300)
        );
        if (attemptIndex < maxAttempts) {
          await sleepMs(450);
          continue;
        }
        return null;
      }
      const csvText = await response.text();
      const rows = parseCsvToRows(csvText);
      if (!Array.isArray(rows) || rows.length < 2) {
        console.error('meta-whatsapp-webhook: CSV parse returned empty rows', `attempt=${attemptIndex}`);
        if (attemptIndex < maxAttempts) {
          await sleepMs(450);
          continue;
        }
        return null;
      }
      return rows;
    } catch (error) {
      console.error('meta-whatsapp-webhook: CSV fetch error', `attempt=${attemptIndex}`, error);
      if (attemptIndex < maxAttempts) {
        await sleepMs(450);
        continue;
      }
      return null;
    }
  }
  return null;
}

async function getGoogleSheetsAccessToken() {
  const serviceAccountRaw = getGoogleServiceAccountJson();
  const serviceAccount = tryParseJson(serviceAccountRaw);
  if (!serviceAccount) {
    console.error('meta-whatsapp-webhook: GOOGLE_SERVICE_ACCOUNT_JSON missing or invalid JSON');
    return null;
  }
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token =
    typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : null;
}

async function fetchGoogleSheetsValues(spreadsheetId, rangeA1) {
  const accessToken = await getGoogleSheetsAccessToken();
  if (!accessToken) return null;
  const url = `${GOOGLE_SHEETS_API_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(
    rangeA1
  )}?majorDimension=ROWS`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    console.error('meta-whatsapp-webhook: Sheets API error', response.status, text.slice(0, 800));
    return null;
  }
  const data = await response.json();
  return Array.isArray(data?.values) ? data.values : null;
}

function normalizeCityKeyForSheets(displayName) {
  return PRIVATE_PRICE_CITY_KEY_BY_DISPLAY_NAME[displayName] || displayName;
}

function normalizeHealthInsuranceNameForKey(value) {
  const normalized = normalizeForMatch(String(value || '')).replace(/\s+/g, ' ').trim();
  // Make common user variants match sheet canonical names.
  // Examples: "Sancor Salud" -> "sancor", "OSDE Salud" -> "osde"
  return normalized
    .replace(/\bobra social\b/g, '')
    .replace(/\bprepaga\b/g, '')
    .replace(/\bsalud\b/g, '')
    // Remove punctuation/parentheses so sheet typos like missing ")" still match.
    .replace(/[()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPlusLookupMap(rows) {
  const map = new Map();
  if (!Array.isArray(rows) || rows.length < 2) return map;
  const header = rows[0].map((h) => normalizeForMatch(String(h || '')));
  const cityIndex = header.indexOf('city');
  const nameIndex = header.indexOf('healthinsurancename');
  const isAcceptedIndex = header.indexOf('isaccepted');
  const hasPlusIndex = header.indexOf('hasplus');
  const plusAmountIndex = header.indexOf('plusamountars');
  const notesIndex = header.indexOf('notes');
  for (const row of rows.slice(1)) {
    const city = row[cityIndex] != null ? String(row[cityIndex]).trim() : '';
    const name = row[nameIndex] != null ? String(row[nameIndex]).trim() : '';
    if (!city || !name) continue;
    const key = `${normalizeForMatch(city)}::${normalizeHealthInsuranceNameForKey(name)}`;
    const isAcceptedRaw = row[isAcceptedIndex] != null ? String(row[isAcceptedIndex]).trim() : '';
    const hasPlusRaw = row[hasPlusIndex] != null ? String(row[hasPlusIndex]).trim() : '';
    const plusAmountRaw = row[plusAmountIndex] != null ? String(row[plusAmountIndex]).trim() : '';
    const notes = notesIndex >= 0 && row[notesIndex] != null ? String(row[notesIndex]).trim() : '';
    const isAccepted = /^(true|1|yes|si|sí)$/i.test(isAcceptedRaw);
    const hasPlus = /^(true|1|yes|si|sí)$/i.test(hasPlusRaw);
    const plusAmountArs = Number(plusAmountRaw.replace(/[^\d.]/g, ''));
    map.set(key, {
      city,
      name,
      isAccepted,
      hasPlus,
      plusAmountArs: Number.isFinite(plusAmountArs) ? plusAmountArs : null,
      notes,
    });
  }
  return map;
}

function buildPrivatePriceMap(rows) {
  const map = new Map();
  if (!Array.isArray(rows) || rows.length < 2) return map;
  const header = rows[0].map((h) => normalizeForMatch(String(h || '')));
  const cityIndex = header.indexOf('city');
  const priceIndex = header.indexOf('privatepricears');
  for (const row of rows.slice(1)) {
    const city = row[cityIndex] != null ? String(row[cityIndex]).trim() : '';
    const priceRaw = row[priceIndex] != null ? String(row[priceIndex]).trim() : '';
    if (!city || !priceRaw) continue;
    const cityKey = normalizeForMatch(city);
    const priceArs = Number(priceRaw.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(priceArs)) continue;
    map.set(cityKey, priceArs);
  }
  return map;
}

async function getGoogleSheetsData() {
  const now = Date.now();
  if (cachedGoogleSheetsData && now < cachedGoogleSheetsDataExpiresAtMs) {
    debugBotLog('sheets cache hit', { expiresInMs: cachedGoogleSheetsDataExpiresAtMs - now });
    return cachedGoogleSheetsData;
  }

  const plusCsvUrl = getGoogleSheetsPlusCsvUrl();
  const privatePricesCsvUrl = getGoogleSheetsPrivatePricesCsvUrl();
  if (plusCsvUrl || privatePricesCsvUrl) {
    const [plusRows, privatePriceRows] = await Promise.all([
      plusCsvUrl ? fetchCsvRows(plusCsvUrl) : null,
      privatePricesCsvUrl ? fetchCsvRows(privatePricesCsvUrl) : null,
    ]);
    if (!plusRows && !privatePriceRows) {
      debugBotLog('sheets csv fetch returned null for both');
      return null;
    }
    cachedGoogleSheetsData = {
      plusLookup: plusRows ? buildPlusLookupMap(plusRows) : new Map(),
      privatePriceLookup: privatePriceRows ? buildPrivatePriceMap(privatePriceRows) : new Map(),
    };
    debugBotLog('sheets loaded', {
      plusLookupSize: cachedGoogleSheetsData.plusLookup.size,
      privatePriceLookupSize: cachedGoogleSheetsData.privatePriceLookup.size,
    });
    cachedGoogleSheetsDataExpiresAtMs = now + GOOGLE_SHEETS_CACHE_TTL_MS;
    return cachedGoogleSheetsData;
  }

  const plusSpreadsheetId = getGoogleSheetsPlusSpreadsheetId();
  const privatePricesSpreadsheetId = getGoogleSheetsPrivatePricesSpreadsheetId();
  if (!plusSpreadsheetId && !privatePricesSpreadsheetId) {
    console.error(
      'meta-whatsapp-webhook: missing GOOGLE_SHEETS_SPREADSHEET_ID (or the specific *_SPREADSHEET_ID overrides)'
    );
    return null;
  }
  const plusRange = getGoogleSheetsPlusRange();
  const privatePricesRange = getGoogleSheetsPrivatePricesRange();
  const [plusRows, privatePriceRows] = await Promise.all([
    plusSpreadsheetId ? fetchGoogleSheetsValues(plusSpreadsheetId, plusRange) : null,
    privatePricesSpreadsheetId
      ? fetchGoogleSheetsValues(privatePricesSpreadsheetId, privatePricesRange)
      : null,
  ]);
  if (!plusRows && !privatePriceRows) {
    debugBotLog('sheets api fetch returned null for both');
    return null;
  }
  cachedGoogleSheetsData = {
    plusLookup: plusRows ? buildPlusLookupMap(plusRows) : new Map(),
    privatePriceLookup: privatePriceRows ? buildPrivatePriceMap(privatePriceRows) : new Map(),
  };
  debugBotLog('sheets loaded (api)', {
    plusLookupSize: cachedGoogleSheetsData.plusLookup.size,
    privatePriceLookupSize: cachedGoogleSheetsData.privatePriceLookup.size,
  });
  cachedGoogleSheetsDataExpiresAtMs = now + GOOGLE_SHEETS_CACHE_TTL_MS;
  return cachedGoogleSheetsData;
}

async function lookupPlusRule(cityDisplayName, healthInsuranceName) {
  const data = await getGoogleSheetsData();
  if (!data) return null;
  const cityKey = normalizeForMatch(normalizeCityKeyForSheets(cityDisplayName));
  const osKey = normalizeHealthInsuranceNameForKey(healthInsuranceName);
  const key = `${cityKey}::${osKey}`;
  const exactValue = data.plusLookup.get(key) || null;
  if (exactValue) {
    debugBotLog('lookupPlusRule', {
      cityDisplayName,
      healthInsuranceName,
      cityKey,
      osKey,
      key,
      found: true,
      mode: 'exact',
    });
    return exactValue;
  }

  // Fuzzy match within the same city: when the Sheet contains plan/parentheses variants,
  // match by "contains" and a small typo tolerance.
  let best = null;
  for (const [candidateKey, rule] of data.plusLookup.entries()) {
    if (typeof candidateKey !== 'string') continue;
    if (!candidateKey.startsWith(`${cityKey}::`)) continue;
    const candidateOsKey = candidateKey.slice(`${cityKey}::`.length);
    if (!candidateOsKey) continue;
    if (candidateOsKey === osKey) {
      best = { rule, distance: 0, candidateOsKey };
      break;
    }
    const containsMatch =
      candidateOsKey.includes(osKey) || osKey.includes(candidateOsKey);
    const distance = computeLevenshteinDistance(candidateOsKey, osKey);
    const acceptable = containsMatch || distance <= MAX_LEVENSHTEIN_DISTANCE;
    if (!acceptable) continue;
    const score = containsMatch ? 0 : distance;
    if (!best || score < best.distance) {
      best = { rule, distance: score, candidateOsKey };
    }
  }

  const fuzzyValue = best ? best.rule : null;
  debugBotLog('lookupPlusRule', {
    cityDisplayName,
    healthInsuranceName,
    cityKey,
    osKey,
    key,
    found: Boolean(fuzzyValue),
    mode: fuzzyValue ? 'fuzzy' : 'miss',
    matchedCandidateOsKey: best ? best.candidateOsKey : null,
  });
  return fuzzyValue;
}

async function healthInsuranceExistsInAnyCity(healthInsuranceName) {
  const data = await getGoogleSheetsData();
  if (!data) return false;
  const osKey = normalizeHealthInsuranceNameForKey(healthInsuranceName);
  if (!osKey) return false;
  const plusLookup = data.plusLookup;
  if (!(plusLookup instanceof Map) || plusLookup.size === 0) return false;
  for (const value of plusLookup.values()) {
    const candidateName = value?.name != null ? String(value.name).trim() : '';
    if (!candidateName) continue;
    const candidateKey = normalizeHealthInsuranceNameForKey(candidateName);
    if (!candidateKey) continue;
    if (candidateKey === osKey) return true;
    if (candidateKey.includes(osKey) || osKey.includes(candidateKey)) return true;
  }
  return false;
}

async function lookupPrivatePrice(cityDisplayName) {
  const data = await getGoogleSheetsData();
  if (!data) return null;
  const cityKey = normalizeForMatch(normalizeCityKeyForSheets(cityDisplayName));
  return data.privatePriceLookup.get(cityKey) ?? null;
}

/**
 * [DERIVAR] is handled in code: patient sees handoff text; secretary channel not wired here.
 */
function processAssistantReplyForPatient(rawModelText) {
  if (rawModelText == null || typeof rawModelText !== 'string') {
    return rawModelText;
  }
  if (/\[DERIVAR\]/i.test(rawModelText)) {
    console.warn(
      'meta-whatsapp-webhook: model requested [DERIVAR]; secretary notification not implemented',
      rawModelText.slice(0, 500)
    );
    return DERIVATIVE_HANDOFF_PATIENT_MESSAGE;
  }
  const trimmed = rawModelText.trim();
  const normalized = normalizeForMatch(trimmed);
  const mentionsDocumentation =
    normalized.includes('documentacion') ||
    normalized.includes('documentación') ||
    normalized.includes('documentos') ||
    normalized.includes('traigas') ||
    normalized.includes('traigas la') ||
    normalized.includes('trae la');
  if (mentionsDocumentation) {
    return 'Entendido. ¿Desde qué ciudad consultás: Corrientes, Resistencia, Sáenz Peña o Formosa?';
  }
  const suggestsContactingThirdParty =
    normalized.includes('comunicate') ||
    normalized.includes('comunícate') ||
    normalized.includes('contactes') ||
    normalized.includes('contactate') ||
    normalized.includes('contactar') ||
    normalized.includes('llama a') ||
    normalized.includes('llamá a') ||
    normalized.includes('llame a') ||
    normalized.includes('te recomiendo que te comuniques') ||
    normalized.includes('directamente con sancor') ||
    normalized.includes('directamente con osde') ||
    normalized.includes('directamente con la obra social') ||
    normalized.includes('con tu obra social');
  if (suggestsContactingThirdParty) {
    return 'Entendido. ¿Desde qué ciudad consultás: Corrientes, Resistencia, Sáenz Peña o Formosa?';
  }
  const mentionsNonSedeCity =
    normalized.includes('buenos aires') ||
    normalized.includes('capital federal') ||
    normalized.includes('caba') ||
    normalized.includes('la plata') ||
    normalized.includes('cordoba') ||
    normalized.includes('córdoba') ||
    normalized.includes('rosario') ||
    normalized.includes('mendoza');
  if (mentionsNonSedeCity) {
    return 'Entendido. El Dr. atiende solo en Corrientes, Resistencia, Sáenz Peña y Formosa. ¿Desde qué ciudad consultás?';
  }
  const asksForSpecificDateOrTime =
    normalized.includes('fecha') ||
    normalized.includes('dia') ||
    normalized.includes('día') ||
    normalized.includes('día y hora') ||
    normalized.includes('dia y hora') ||
    normalized.includes('horario') ||
    normalized.includes('indicame la fecha') ||
    normalized.includes('indicame el dia') ||
    normalized.includes('indicame el día') ||
    normalized.includes('indicame el horario') ||
    normalized.includes('por favor, indicame la fecha') ||
    normalized.includes('por favor indicame la fecha') ||
    normalized.includes('por favor indicame el dia') ||
    normalized.includes('por favor indicame el día');
  if (asksForSpecificDateOrTime) {
    return 'Entendido. ¿En qué sede querés atenderte: 1 Corrientes, 2 Resistencia, 3 Sáenz Peña o 4 Formosa?';
  }
  return trimmed;
}

function getAgendaUrl(entry) {
  const url = process.env[entry.envKey];
  return url && url.startsWith('http') ? url : null;
}

function buildAskSedeMessage() {
  return 'Podés responder con 1 Corrientes, 2 Resistencia, 3 Sáenz Peña o 4 Formosa.';
}

function buildAskSedeBridgeMessage() {
  return 'Para darte la info correcta, ¿para qué sede es?';
}

function buildAskSedeForHealthInsuranceMismatchMessage(lastSedeDisplayName, healthInsuranceName) {
  const safeSede =
    typeof lastSedeDisplayName === 'string' && lastSedeDisplayName.trim().length > 0
      ? lastSedeDisplayName.trim()
      : null;
  const safeOs =
    typeof healthInsuranceName === 'string' && healthInsuranceName.trim().length > 0
      ? healthInsuranceName.trim()
      : 'esa obra social';
  if (safeSede) {
    return `Para ${safeOs} no tengo registro en ${safeSede}. ¿Desde qué ciudad consultás? Podés responder con 1 Corrientes, 2 Resistencia, 3 Sáenz Peña o 4 Formosa.`;
  }
  return buildAskSedeMessage();
}

function buildMicroCommitmentMessage(entry) {
  return '¿Querés que te pase el link para ver horarios disponibles y reservar?';
}

function shouldOfferBookingLink(priorState) {
  if (!priorState || typeof priorState !== 'object') return true;
  const optOutUntilMs = Number(priorState.bookingLinkOptOutUntilMs);
  if (!Number.isFinite(optOutUntilMs) || optOutUntilMs <= 0) return true;
  return Date.now() > optOutUntilMs;
}

function appendBookingLinkOfferIfAllowed(priorState, messageText) {
  if (!shouldOfferBookingLink(priorState)) return messageText;
  return `${messageText} ¿Querés que te pase el link para ver horarios disponibles y reservar?`.trim();
}

function buildMicroCommitmentMessageWithState(priorState) {
  if (!shouldOfferBookingLink(priorState)) return buildAnythingElseHelpMessage(priorState);
  return buildMicroCommitmentMessage();
}

function buildGreetingSentence(profileDisplayName) {
  const hasName = typeof profileDisplayName === 'string' && profileDisplayName.trim().length > 0;
  if (hasName) {
    return `Hola ${profileDisplayName.trim()}, soy la asistente del Dr. Liber Acosta 😊.`;
  }
  return 'Hola, soy la asistente del Dr. Liber Acosta 😊.';
}

const GREETING_SESSION_RESET_MS = 20 * 60 * 1000;

function shouldTreatAsAlreadyGreeted(priorState, nowMs) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (!priorState.greeted) return false;
  const lastSeenAtMs = Number(priorState.lastSeenAtMs);
  if (!Number.isFinite(lastSeenAtMs) || lastSeenAtMs <= 0) return true;
  return nowMs - lastSeenAtMs <= GREETING_SESSION_RESET_MS;
}

function normalizeToSingleLine(text) {
  return String(text || '')
    .replace(/\r\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAutoReplyWithGreetingIfNeeded(body, profileDisplayName, priorState) {
  const reply = normalizeToSingleLine(body);
  const greeted = shouldTreatAsAlreadyGreeted(priorState, Date.now());
  if (greeted) {
    return { messageText: reply, nextStatePatch: null };
  }
  const greeting = buildGreetingSentence(profileDisplayName);
  return {
    messageText: `${greeting} ${reply}`,
    nextStatePatch: { greeted: true, lastSeenAtMs: Date.now() },
  };
}

function mergeConversationStatePreservingGreeting(priorState, nextState, patch) {
  const priorGreeted =
    priorState && typeof priorState === 'object' ? Boolean(priorState.greeted) : false;
  const priorLastSede =
    priorState && typeof priorState === 'object'
      ? {
          lastSedeEnvKey: priorState.lastSedeEnvKey,
          lastSedeDisplayName: priorState.lastSedeDisplayName,
          lastSedeOptionNumber: priorState.lastSedeOptionNumber,
          lastSedeAtMs: priorState.lastSedeAtMs,
        }
      : null;
  const merged = { ...(nextState || {}) };
  if (patch && typeof patch === 'object') {
    Object.assign(merged, patch);
  }
  if (priorGreeted) {
    merged.greeted = true;
  }
  // Keep last known sede unless explicitly overwritten.
  if (priorLastSede && typeof merged.lastSedeEnvKey !== 'string') {
    Object.assign(merged, priorLastSede);
  }
  return merged;
}

function messageLooksLikeHealthInsurancePlusQuestion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const normalizedSingleToken = normalized.replace(/\s+/g, '');
  if (GREETING_NORMALIZED_TOKENS.has(normalizedSingleToken)) return false;
  if (YES_NO_NORMALIZED_TOKENS.has(normalizedSingleToken)) return false;
  return (
    normalized.includes('obra social') ||
    normalized.includes('obras sociales') ||
    normalized.includes('obrasocial') ||
    normalized.includes('prepaga') ||
    normalized.includes('prepagas') ||
    normalized.includes('osde') ||
    normalized.includes('isunne') ||
    normalized.includes('issune') ||
    normalized.includes('issunne') ||
    normalized.includes('isune') ||
    normalized.includes('sancor') ||
    normalized.includes('swiss') ||
    normalized.includes('ioscor') ||
    normalized.includes('galeno') ||
    normalized.includes('medicus') ||
    normalized.includes('omint') ||
    normalized.includes('prevencion') ||
    normalized.includes('jerarquicos') ||
    normalized.includes('plus') ||
    normalized.includes('coseguro')
  );
}

function tryExtractHealthInsuranceName(rawText) {
  const normalized = normalizeForMatch(rawText);
  // Common abbreviations that exist in our Sheet.
  // Note: the current CSV has this value without a closing ")".
  if (normalized.includes('aamm')) return 'AAMM (ASCARGMUTMOTO';
  // AMMECO variants (canonical strings must match the CSV as close as possible).
  if (normalized.includes('ammeco')) {
    if (normalized.includes('plan a')) return 'AMMECO (PLAN A )';
    if (normalized.includes('plan b')) return 'AMMECO (PLAN B)';
    if (normalized.includes('plan dorado')) return 'AMMECO (PLAN DORADO)';
    if (/\bred\b/.test(normalized)) return 'AMMECO (RED)';
    if (normalized.includes('ase')) return 'AMMECO ASE';
    if (normalized.includes('ospuaye')) return 'AMMECO OSPUAYE';
  }
  if (normalized.includes('sancor')) return 'Sancor';
  if (normalized.includes('osde')) return 'OSDE';
  if (normalized.includes('isunne') || normalized.includes('issune') || normalized.includes('isune')) return 'Isunne';
  if (normalized.includes('swiss')) return 'SWISS MEDICAL';
  if (normalized.includes('ioscor')) return 'IOSCOR';
  if (normalized.includes('galeno')) return 'GALENO ARGENTINA SA';
  if (normalized.includes('medicus')) return 'MEDICUS';
  if (normalized.includes('omint')) return 'OMINT SA';
  if (normalized.includes('prevencion')) return 'PREVENCION SALUD SA';
  if (normalized.includes('jerarquic')) return 'JERARQUICOS SALUD';
  if (normalized.includes('funcacorr')) return 'FUNCACORR';
  return null;
}

function messageLooksLikeGenericInstitutionHealthInsurance(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  // Avoid fuzzy-matching generic phrases like "del cardiológico" to some random OS from the sheet.
  return (
    normalized.includes('cardiologic') ||
    normalized.includes('cardiologico') ||
    normalized.includes('cardiológico') ||
    /\bobras?\s+social(?:es)?\s+del\b/.test(normalized) ||
    /\bobra\s+social\s+de\s+el\b/.test(normalized)
  );
}

async function buildHealthInsurancePlusReplyOrAskCity(cityEntry, healthInsuranceName, priorState) {
  debugBotLog('buildHealthInsurancePlusReplyOrAskCity', {
    cityDisplayName: cityEntry?.displayName,
    healthInsuranceName,
  });
  const plusRule = await lookupPlusRule(cityEntry.displayName, healthInsuranceName);
  // Prices are not provided via WhatsApp; always route to evaluation/office confirmation.

  if (!plusRule) {
    // Fallback (hard rule) for the stable no-plus set, to avoid unnecessary derivations when
    // the plus sheet is temporarily unavailable or does not match the exact naming.
    const cityNormalized = normalizeForMatch(cityEntry.displayName);
    const osNormalized = normalizeForMatch(healthInsuranceName);
    const isOsde = osNormalized.includes('osde');
    const isIsunne = osNormalized.includes('isunne');
    const isSancor = osNormalized.includes('sancor');
    const isKnownNoPlus =
      (cityNormalized.includes('corrientes') && (isOsde || isIsunne || isSancor)) ||
      (cityNormalized.includes('resistencia') && (isOsde || isIsunne || isSancor)) ||
      (cityNormalized.includes('formosa') && (isOsde || isSancor)) ||
      (cityNormalized.includes('saenz pena') && (isOsde || isIsunne || isSancor));
    if (isKnownNoPlus) {
      return appendBookingLinkOfferIfAllowed(
        priorState,
        `En ${cityEntry.displayName} trabajamos con ${healthInsuranceName} sin plus.`
      );
    }
    const existsElsewhere = await healthInsuranceExistsInAnyCity(healthInsuranceName);
    debugBotLog('plusRule missing', {
      city: cityEntry?.displayName,
      healthInsuranceName,
      existsElsewhere,
    });
    if (existsElsewhere) {
      return 'ASK_CITY_FOR_HEALTH_INSURANCE';
    }
    return MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
  }

  const osDisplayName = healthInsuranceName;
  if (!plusRule.isAccepted) {
    return appendBookingLinkOfferIfAllowed(
      priorState,
      `En ${cityEntry.displayName} no trabajamos con ${osDisplayName}. Si querés, podés atenderte de manera particular; para confirmarte valores y cómo proceder, lo ideal es una consulta de evaluación.`
    );
  }

  if (plusRule.hasPlus) {
    const plusFormatted =
      Number.isFinite(plusRule.plusAmountArs) && plusRule.plusAmountArs != null
        ? formatArsAmount(plusRule.plusAmountArs)
        : null;
    if (plusFormatted) {
      return appendBookingLinkOfferIfAllowed(
        priorState,
        `En ${cityEntry.displayName} con ${osDisplayName} hay un plus de $${plusFormatted}.`
      );
    }
    return MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
  }

  return appendBookingLinkOfferIfAllowed(
    priorState,
    `En ${cityEntry.displayName} trabajamos con ${osDisplayName} sin plus.`
  );
}

function buildAskHealthInsuranceNameMessage() {
  return '¿Qué obra social tenés?';
}

function messageLooksLikePrivatePriceQuestion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageAsksAboutStudiesOrTests(rawText)) return false;
  const normalized = normalizeForMatch(rawText);
  // "Tratamiento" is not a consultation price question; it depends on the case.
  if (normalized.includes('tratamiento') && !normalized.includes('consulta')) return false;
  if (/^y\s*particular\??$/.test(normalized) || /^particular\??$/.test(normalized)) return true;
  return (
    normalized.includes('precio') ||
    normalized.includes('cuanto sale') ||
    normalized.includes('cuanto cuesta') ||
    normalized.includes('cuanto esta') ||
    normalized.includes('cuanto está') ||
    normalized.includes('cuanto es') ||
    normalized.includes('precio del turno') ||
    normalized.includes('precio turno') ||
    normalized.includes('control') ||
    normalized.includes('seguimiento') ||
    normalized.includes('reconsulta') ||
    normalized.includes('re consulta') ||
    normalized.includes('consulta particular') ||
    (normalized.includes('consulta') && normalized.includes('particular')) ||
    normalized.includes('valor consulta')
  );
}

function formatArsAmount(amount) {
  const integerAmount = Math.round(Number(amount));
  if (!Number.isFinite(integerAmount)) return null;
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(integerAmount);
}

function messageConfirmsLinkSend(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageClearlyRejectsLinkSend(rawText)) return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Accept short confirmations even with extra words: "si quiero", "si pasame el link", "dale pasalo"
  if (/^(si|dale|ok|oka|de una|listo|ya)\b/.test(normalized)) return true;
  if (/^(por favor|porfa|x favor)\b/.test(normalized)) return true;
  if (/^(gracias|genial|perfecto)\b/.test(normalized)) return true;
  if (/\b(quiero|mandame|pasame|pasalo|mandalo|manda)\b/.test(normalized)) return true;
  if (normalized.includes('pasa el link') || normalized.includes('pasame el link')) return true;
  return false;
}

function messageClearlyRejectsLinkSend(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Sarcasm / ironic "yes" that actually means "no".
  if (/^si\s+como\s+no\b/.test(normalized)) return true;
  if (/^sí\s+como\s+no\b/.test(normalized)) return true;
  if (/^(no|nop|nah)\b/.test(normalized)) return true;
  if (normalized.includes('no quiero')) return true;
  if (normalized.includes('no por ahora')) return true;
  if (normalized.includes('mas tarde') || normalized.includes('más tarde')) return true;
  return false;
}

async function classifyAffirmativeIntentWithOpenAi(userMessage) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();

  const systemPrompt = [
    'You are a strict classifier for WhatsApp messages in Spanish.',
    'Task: Decide if the user message is an AFFIRMATIVE confirmation to receive a booking link that was just offered.',
    'Return only one token: YES or NO.',
    'Rules:',
    '- YES examples: "si", "si quiero", "dale", "ok", "pasame el link", "mandalo", "de una", "por favor", "porfa", "gracias".',
    '- NO examples: "no", "no por ahora", "después", "mas tarde", questions not confirming.',
    '- If unclear, return NO.',
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
        temperature: 0,
        max_tokens: 3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: String(userMessage || '') },
        ],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI classifier error', response.status, errorText.slice(0, 300));
      return null;
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (normalized.startsWith('YES')) return true;
    if (normalized.startsWith('NO')) return false;
    return null;
  } catch (error) {
    console.error('OpenAI classifier request failed', error);
    return null;
  }
}

async function decideNextActionForLinkConfirmationWithOpenAi(userMessage) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();

  const systemPrompt = [
    'You are a strict router for a WhatsApp booking flow in Spanish (Argentina).',
    'Context: The assistant just asked: "¿Querés que te pase el link para ver horarios disponibles y reservar?"',
    'Task: Decide the next action based on the user message.',
    'Return ONLY one of these tokens: SEND_LINK, DO_NOT_SEND, ASK_CLARIFY.',
    'Rules:',
    '- If the user confirms intent (even politely or implicitly), return SEND_LINK.',
    '- If the user rejects or postpones, return DO_NOT_SEND.',
    '- If it is unclear (question unrelated, new topic), return ASK_CLARIFY.',
    '- Examples for SEND_LINK: "sí", "si quiero", "por favor", "dale", "ok", "mandame", "pasame el link", "de una", "gracias".',
    '- Examples for DO_NOT_SEND: "no", "no por ahora", "más tarde", "después", "ahora no".',
    '- Examples for ASK_CLARIFY: "¿cuánto sale?", "¿qué es eso?", "¿para cuándo?", "no entiendo".',
  ].join('\\n');

  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0,
        max_tokens: 5,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: String(userMessage || '') },
        ],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI router error', response.status, errorText.slice(0, 300));
      return null;
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (normalized.startsWith('SEND_LINK')) return 'SEND_LINK';
    if (normalized.startsWith('DO_NOT_SEND')) return 'DO_NOT_SEND';
    if (normalized.startsWith('ASK_CLARIFY')) return 'ASK_CLARIFY';
    return null;
  } catch (error) {
    console.error('OpenAI router request failed', error);
    return null;
  }
}

const MULTI_INTENT_ROUTER_TOKENS = [
  'HEALTH_INSURANCE',
  'PRIVATE_PRICE',
  'BOOKING',
  'STUDIES',
  'CONDITION',
  'ADDRESS',
  'DOCUMENTS',
  'OTHER',
];

function messageLooksLikeMultiIntentCandidate(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const signals = [
    messageLooksLikeHealthInsurancePlusQuestion(rawText),
    messageLooksLikePrivatePriceQuestion(rawText),
    messageLooksLikeBookingIntent(rawText) || messageExplicitlyRequestsBookingLink(rawText),
    messageAsksAboutStudiesOrTests(rawText),
    messageAsksAboutConditionTreatment(rawText) || messageAsksAboutTreatmentCost(rawText),
    messageAsksAboutSedeAddressOrHowToArrive(rawText),
    messageAsksAboutDocumentationOrRequirements(rawText) ||
      messageAsksAboutReferralOrPrescription(rawText) ||
      messageAsksAboutPaymentMethods(rawText) ||
      messageAsksAboutInvoice(rawText),
  ].filter(Boolean).length;
  return signals >= 2;
}

async function decidePrimaryIntentWithOpenAi(userMessage) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();

  const systemPrompt = [
    'You are a strict intent router for a WhatsApp clinic assistant in Spanish (Argentina).',
    'Task: Choose the single MOST important intent to answer first.',
    `Return ONLY one token from: ${MULTI_INTENT_ROUTER_TOKENS.join(', ')}.`,
    'Guidelines:',
    '- If asking about accepted insurance / plus: HEALTH_INSURANCE.',
    '- If asking about consultation price / particular / control / seguimiento: PRIVATE_PRICE.',
    '- If asking to book / reserve / get the link: BOOKING.',
    '- If asking about studies/tests: STUDIES.',
    '- If asking if the doctor treats a condition: CONDITION.',
    '- If asking address / how to arrive: ADDRESS.',
    '- If asking what to bring / referral / authorization / payments / invoice: DOCUMENTS.',
    '- If unclear, return OTHER.',
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
        temperature: 0,
        max_tokens: 8,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: String(userMessage || '') },
        ],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI multi-intent router error', response.status, errorText.slice(0, 300));
      return null;
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    for (const token of MULTI_INTENT_ROUTER_TOKENS) {
      if (normalized.startsWith(token)) return token;
    }
    return null;
  } catch (error) {
    console.error('OpenAI multi-intent router request failed', error);
    return null;
  }
}

async function decideIntentsWithOpenAi(userMessage) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();

  const systemPrompt = [
    'You are a strict intent router for a WhatsApp clinic assistant in Spanish (Argentina).',
    'Task: Return up to TWO intents to answer, in order of priority.',
    `Allowed intents: ${MULTI_INTENT_ROUTER_TOKENS.join(', ')}.`,
    'Output MUST be valid JSON, with this exact schema:',
    '{ "intents": ["INTENT_1", "INTENT_2"] }',
    'Rules:',
    '- Include at least 1 intent.',
    '- Include at most 2 intents.',
    '- Use intents exactly as listed.',
    '- Prefer HEALTH_INSURANCE and PRIVATE_PRICE when both are asked.',
    '- If booking/link is asked together with something else, include BOOKING as second unless it is the only request.',
    '- If unclear, return OTHER.',
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
        temperature: 0,
        max_tokens: 60,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: String(userMessage || '') },
        ],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI multi-intent router error', response.status, errorText.slice(0, 300));
      return null;
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const parsed = tryParseFirstJsonObjectFromText(typeof text === 'string' ? text : '');
    const intents = Array.isArray(parsed?.intents) ? parsed.intents : null;
    if (!intents) return null;
    const cleaned = intents
      .map((value) => (typeof value === 'string' ? value.trim().toUpperCase() : ''))
      .filter((value) => MULTI_INTENT_ROUTER_TOKENS.includes(value));
    if (cleaned.length === 0) return null;
    return cleaned.slice(0, 2);
  } catch (error) {
    console.error('OpenAI multi-intent router request failed', error);
    return null;
  }
}

async function buildHealthInsuranceSummary(cityEntry, healthInsuranceName) {
  const plusRule = await lookupPlusRule(cityEntry.displayName, healthInsuranceName);
  if (!plusRule) {
    const cityNormalized = normalizeForMatch(cityEntry.displayName);
    const osNormalized = normalizeForMatch(healthInsuranceName);
    const isOsde = osNormalized.includes('osde');
    const isIsunne = osNormalized.includes('isunne');
    const isSancor = osNormalized.includes('sancor');
    const isKnownNoPlus =
      (cityNormalized.includes('corrientes') && (isOsde || isIsunne || isSancor)) ||
      (cityNormalized.includes('resistencia') && (isOsde || isIsunne || isSancor)) ||
      (cityNormalized.includes('formosa') && (isOsde || isSancor)) ||
      (cityNormalized.includes('saenz pena') && (isOsde || isIsunne || isSancor));
    if (isKnownNoPlus) {
      return `En ${cityEntry.displayName} trabajamos con ${healthInsuranceName} sin plus.`;
    }
    const existsElsewhere = await healthInsuranceExistsInAnyCity(healthInsuranceName);
    if (existsElsewhere) return 'ASK_CITY_FOR_HEALTH_INSURANCE';
    return MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
  }

  const osDisplayName = healthInsuranceName;
  if (!plusRule.isAccepted) {
    return `En ${cityEntry.displayName} no trabajamos con ${osDisplayName}.`;
  }
  if (plusRule.hasPlus) {
    const plusFormatted =
      Number.isFinite(plusRule.plusAmountArs) && plusRule.plusAmountArs != null
        ? formatArsAmount(plusRule.plusAmountArs)
        : null;
    if (!plusFormatted) return MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
    return `En ${cityEntry.displayName} con ${osDisplayName} hay un plus de $${plusFormatted}.`;
  }
  return `En ${cityEntry.displayName} trabajamos con ${osDisplayName} sin plus.`;
}

function getUniqueHealthInsuranceNamesFromSheetsData(data) {
  const names = new Set();
  if (!data || typeof data !== 'object') return [];
  const plusLookup = data.plusLookup;
  if (!(plusLookup instanceof Map)) return [];
  for (const value of plusLookup.values()) {
    const name = value?.name != null ? String(value.name).trim() : '';
    if (name) names.add(name);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, 'es'));
}

async function tryResolveHealthInsuranceNameWithOpenAi(userMessage) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;

  const data = await getGoogleSheetsData();
  const knownNames = getUniqueHealthInsuranceNamesFromSheetsData(data);
  if (knownNames.length === 0) return null;

  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'You are a strict entity extractor and normalizer for Argentine health insurance names in Spanish WhatsApp messages.',
    'Task: Determine if the user message mentions a health insurance (obra social / prepaga).',
    'If yes, provide the best guess for the health insurance name (it can be an abbreviation or full name).',
    'If not sure, return isHealthInsurance=false.',
    '',
    'Return ONLY a JSON object with this exact shape:',
    '{"isHealthInsurance":true|false,"bestGuess":string|null}',
    '',
    'Rules:',
    '- Accept typos and variants (e.g., "issune", "issunne", "ioscor", "sancor salud").',
    '- If the message is about something else, return isHealthInsurance=false.',
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
        temperature: 0,
        max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              `Known canonical names list:\n${knownNames.join('\n')}`,
              '',
              `User message:\n${String(userMessage || '')}`,
            ].join('\n'),
          },
        ],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI health-insurance resolver error', response.status, errorText.slice(0, 300));
      return null;
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const parsed = tryParseFirstJsonObjectFromText(typeof text === 'string' ? text : '');
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.isHealthInsurance !== true) return null;
    const bestGuess = typeof parsed.bestGuess === 'string' ? parsed.bestGuess.trim() : '';
    if (!bestGuess) return null;
    return mapHealthInsuranceGuessToKnownName(bestGuess, knownNames);
  } catch (error) {
    console.error('OpenAI health-insurance resolver request failed', error);
    return null;
  }
}

async function tryResolveHealthInsuranceNameFromSheetsFuzzy(userMessage) {
  const data = await getGoogleSheetsData();
  const knownNames = getUniqueHealthInsuranceNamesFromSheetsData(data);
  if (knownNames.length === 0) return null;
  return mapHealthInsuranceGuessToKnownName(String(userMessage || ''), knownNames);
}

function buildAwaitingLinkConfirmationState(entry, reason, details = null) {
  const detailsObject = details && typeof details === 'object' ? details : null;
  return {
    state: 'awaiting_link_confirmation',
    sedeEnvKey: entry.envKey,
    sedeDisplayName: entry.displayName,
    sedeOptionNumber: entry.optionNumber,
    reason,
    ...(detailsObject ? detailsObject : {}),
  };
}

function stateLooksLikeAwaitingLinkConfirmation(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.state === 'awaiting_link_confirmation' &&
    typeof state.sedeEnvKey === 'string' &&
    typeof state.sedeDisplayName === 'string'
  );
}

function buildLastSedeStatePatch(entry) {
  if (!entry) return null;
  return {
    lastSedeEnvKey: entry.envKey,
    lastSedeDisplayName: entry.displayName,
    lastSedeOptionNumber: entry.optionNumber,
    lastSedeAtMs: Date.now(),
  };
}

function resolveLastSedeEntryFromState(state) {
  if (!state || typeof state !== 'object') return null;
  const envKey = typeof state.lastSedeEnvKey === 'string' ? state.lastSedeEnvKey : '';
  if (!envKey) return null;
  for (const entry of SEDE_ENTRIES) {
    if (entry.envKey === envKey) return entry;
  }
  return null;
}

function resolveSedeEntryFromState(state) {
  if (!stateLooksLikeAwaitingLinkConfirmation(state)) return null;
  for (const entry of SEDE_ENTRIES) {
    if (entry.envKey === state.sedeEnvKey) return entry;
  }
  return null;
}

async function buildPrivatePriceReply(entry) {
  const priceArs = await lookupPrivatePrice(entry.displayName);
  if (!Number.isFinite(priceArs)) {
    return MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
  }
  const formatted = formatArsAmount(priceArs);
  if (!formatted) {
    return MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
  }
  return `En ${entry.displayName} la consulta sale $${formatted}.`;
}

function messageLooksLikeScheduleAvailabilityQuestion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('que dia') ||
    normalized.includes('que dias') ||
    normalized.includes('cuando atiende') ||
    normalized.includes('dias atiende') ||
    normalized.includes('horarios') ||
    normalized.includes('horario') ||
    normalized.includes('disponible') ||
    normalized.includes('disponibilidad')
  );
}

function buildSedeScheduleReply(entry) {
  if (!entry) return null;
  const details = SEDE_ADDRESS_DETAILS_BY_ENV_KEY[entry.envKey] || null;
  return details ? details : `Sede ${entry.displayName}.`;
}

function messageLooksLikeBookingIntent(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  // Common intent words
  if (/\b(turno|turnos|agendar|agenda|reservar|reserva|cita)\b/.test(normalized)) return true;
  // Tolerate common typos like "urno" (missing t)
  if (/\burno\b/.test(normalized) || /\bun\s*urno\b/.test(normalized)) return true;
  return false;
}

function messageExplicitlyRequestsBookingLink(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsLink =
    normalized.includes('link') ||
    normalized.includes('enlace') ||
    normalized.includes('agenda') ||
    normalized.includes('agendar') ||
    normalized.includes('reservar') ||
    normalized.includes('turno');
  if (!mentionsLink) return false;
  return (
    normalized.includes('pasame') ||
    normalized.includes('pasalo') ||
    normalized.includes('mandame') ||
    normalized.includes('mandalo') ||
    normalized.includes('enviame') ||
    normalized.includes('enviamelo') ||
    normalized.includes('me pasas') ||
    normalized.includes('me pasás') ||
    normalized.includes('me mandas') ||
    normalized.includes('me mandás') ||
    normalized.includes('quiero el link') ||
    normalized.includes('quiero link')
  );
}

function messageAsksIfDoctorTreatsChildren(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    /\bnin(?:o|a|os|as)\b/.test(normalized) ||
    /\bnini(?:o|a|os|as)\b/.test(normalized) ||
    /\bbebes?\b/.test(normalized) ||
    /\bnenes?\b/.test(normalized) ||
    normalized.includes('pediatr') ||
    normalized.includes('infantil')
  );
}

function messageAsksAboutStudiesOrTests(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('estudio') ||
    normalized.includes('estudios') ||
    normalized.includes('prick') ||
    normalized.includes('test de alerg') ||
    normalized.includes('test alerg') ||
    normalized.includes('espirometr') ||
    normalized.includes('laboratorio') ||
    normalized.includes('sangre') ||
    normalized.includes('imagen') ||
    normalized.includes('imagenes') ||
    normalized.includes('parche') ||
    normalized.includes('patch')
  );
}

function messageAsksAboutDocumentationOrRequirements(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('que tengo que llevar') ||
    normalized.includes('qué tengo que llevar') ||
    normalized.includes('que llevo') ||
    normalized.includes('qué llevo') ||
    normalized.includes('que hay que llevar') ||
    normalized.includes('documentacion') ||
    normalized.includes('documentación') ||
    normalized.includes('orden') ||
    normalized.includes('autoriz') ||
    normalized.includes('credencial')
  );
}

function messageAsksAboutReferralOrPrescription(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('derivacion') ||
    normalized.includes('derivación') ||
    normalized.includes('receta') ||
    normalized.includes('necesito derivacion') ||
    normalized.includes('necesito receta')
  );
}

function messageAsksAboutInvoice(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return normalized.includes('factura') || normalized.includes('facturacion') || normalized.includes('facturación');
}

function messageAsksAboutPaymentMethods(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('como pago') ||
    normalized.includes('cómo pago') ||
    normalized.includes('medios de pago') ||
    normalized.includes('pago') ||
    normalized.includes('transferencia') ||
    normalized.includes('qr') ||
    normalized.includes('tarjeta') ||
    normalized.includes('debito') ||
    normalized.includes('débito') ||
    normalized.includes('efectivo')
  );
}

function messageAsksAboutConsultDuration(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return normalized.includes('cuanto dura') || normalized.includes('cuánto dura') || normalized.includes('duracion');
}

function messageAsksAboutCompanion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return normalized.includes('acompanante') || normalized.includes('acompañante') || normalized.includes('puedo ir con');
}

function messageAsksAboutOtherProvinces(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return normalized.includes('otra provincia') || normalized.includes('otras provincias') || normalized.includes('otra ciudad');
}

function messageAsksAboutVirtualVisit(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('virtual') ||
    normalized.includes('videollamada') ||
    normalized.includes('video llamada') ||
    normalized.includes('online') ||
    normalized.includes('a distancia')
  );
}

function messageAsksAboutSedeAddressOrHowToArrive(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('direccion') ||
    normalized.includes('dirección') ||
    normalized.includes('donde queda') ||
    normalized.includes('dónde queda') ||
    normalized.includes('ubicacion') ||
    normalized.includes('ubicación') ||
    normalized.includes('como llego') ||
    normalized.includes('cómo llego') ||
    normalized.includes('como llegar') ||
    normalized.includes('cómo llegar')
  );
}

function messageAsksForMapsLocation(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('ubicacion') ||
    normalized.includes('ubicación') ||
    normalized.includes('pasame la ubi') ||
    normalized.includes('pasame ubi') ||
    normalized.includes('ubi') ||
    normalized.includes('maps') ||
    normalized.includes('google maps') ||
    normalized.includes('pin')
  );
}

function buildSedeMapsLocationReply(priorState, explicitSedeEntry) {
  const sedeFromMessage = explicitSedeEntry && typeof explicitSedeEntry === 'object' ? explicitSedeEntry : null;
  const sedeFromState = resolveLastSedeEntryFromState(priorState);
  const selectedSede = sedeFromMessage || sedeFromState;
  if (!selectedSede) {
    return `¿Para qué sede necesitás la ubicación? ${buildAskSedeBridgeMessage()} ${buildAskSedeMessage()}`.trim();
  }
  const mapsUrl = SEDE_MAPS_URL_BY_ENV_KEY[selectedSede.envKey] || null;
  if (mapsUrl) {
    const address = SEDE_ADDRESS_DETAILS_BY_ENV_KEY[selectedSede.envKey] || null;
    if (address) {
      return `${address}\n\nUbicación en Google Maps:\n${mapsUrl}`;
    }
    return `Ubicación en Google Maps (${selectedSede.displayName}):\n${mapsUrl}`;
  }
  // Fallback to address text if we don't have a maps link for that sede yet.
  return buildSedeAddressReply(priorState, selectedSede);
}

function buildSedeAddressReply(priorState, explicitSedeEntry) {
  const sedeFromMessage = explicitSedeEntry && typeof explicitSedeEntry === 'object' ? explicitSedeEntry : null;
  const sedeFromState = resolveLastSedeEntryFromState(priorState);
  const selectedSede = sedeFromMessage || sedeFromState;
  if (!selectedSede) {
    return `Decime tu ciudad y te paso la dirección. ${buildAskSedeBridgeMessage()} ${buildAskSedeMessage()}`.trim();
  }
  const details = SEDE_ADDRESS_DETAILS_BY_ENV_KEY[selectedSede.envKey] || null;
  if (selectedSede.envKey === 'CALENDLY_CORRIENTES') {
    return [details || `Sede ${selectedSede.displayName}.`, CORRIENTES_HOW_TO_ARRIVE_MESSAGE].join(' ');
  }
  return details || `Sede ${selectedSede.displayName}.`;
}

function messageAsksAboutStudyFasting(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return normalized.includes('ayunas') || normalized.includes('ayuno');
}

function messageAsksAboutStudyMedicationPreparation(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('medicacion') ||
    normalized.includes('medicación') ||
    normalized.includes('suspendo') ||
    normalized.includes('suspender') ||
    normalized.includes('antialerg') ||
    normalized.includes('cortico') ||
    normalized.includes('aerosol')
  );
}

function messageAsksAboutStudyDuration(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return normalized.includes('cuanto tarda') || normalized.includes('cuánto tarda') || normalized.includes('tarda el estudio');
}

function messageAsksAboutMedicationAllergyStudy(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return normalized.includes('medicamento') || normalized.includes('medicamentos');
}

function appendAskSedeIfMissing(priorState, messageText) {
  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (lastSede) return messageText;
  return `${messageText} ${buildAskSedeMessage()}`.trim();
}

async function sendAskSedeTwoStep(toPhoneId, profileDisplayName, priorState, prefaceText = null) {
  const preface =
    typeof prefaceText === 'string' && prefaceText.trim().length > 0 ? prefaceText.trim() : null;
  const bridge = preface ? `${preface} ${buildAskSedeBridgeMessage()}` : buildAskSedeBridgeMessage();
  const firstWrapped = buildAutoReplyWithGreetingIfNeeded(bridge, profileDisplayName, priorState);
  const preservedSessionState =
    priorState && typeof priorState === 'object'
      ? {
          greeted: Boolean(priorState.greeted),
          lastSeenAtMs: priorState.lastSeenAtMs,
          lastSedeEnvKey: priorState.lastSedeEnvKey,
          lastSedeDisplayName: priorState.lastSedeDisplayName,
          lastSedeOptionNumber: priorState.lastSedeOptionNumber,
          lastSedeAtMs: priorState.lastSedeAtMs,
          lastBotReplyAtMs: priorState.lastBotReplyAtMs,
        }
      : {};
  const afterFirstState = {
    ...preservedSessionState,
    state: 'awaiting_sede_selection',
    awaitingSedeSelectionAtMs: Date.now(),
    ...(firstWrapped.nextStatePatch || {}),
    lastSeenAtMs: Date.now(),
    lastBotReplyAtMs: Date.now(),
  };
  await setConversationState(toPhoneId, afterFirstState);
  await sendWhatsAppText(toPhoneId, firstWrapped.messageText);
  await sendWhatsAppText(toPhoneId, buildAskSedeMessage(), { skipDelay: true });
}

async function sendSedeSelectionHelpMessage(toPhoneId, profileDisplayName, priorState) {
  const helpText = 'Escribí solo el número de la sede (1, 2, 3 o 4).';
  const wrapped = buildAutoReplyWithGreetingIfNeeded(helpText, profileDisplayName, priorState);
  await setConversationState(toPhoneId, {
    ...(priorState || {}),
    ...(wrapped.nextStatePatch || {}),
    lastSeenAtMs: Date.now(),
    lastBotReplyAtMs: Date.now(),
  });
  await sendWhatsAppText(toPhoneId, wrapped.messageText);
  await sendWhatsAppText(toPhoneId, buildAskSedeMessage(), { skipDelay: true });
}

function messageAsksAboutConditionTreatment(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const asksAboutCare =
    /\b(tratan|trata|atiende|atienden|ven|ve|manejan|maneja)\b/.test(normalized) ||
    normalized.includes('quiero saber si') ||
    normalized.includes('se atiende') ||
    normalized.includes('atienden');
  if (!asksAboutCare) return false;
  return (
    normalized.includes('asma') ||
    normalized.includes('rinitis') ||
    normalized.includes('sinusitis') ||
    normalized.includes('alerg') ||
    normalized.includes('urticaria') ||
    normalized.includes('dermatitis') ||
    normalized.includes('eczema') ||
    normalized.includes('eczema') ||
    normalized.includes('broncoespasmo')
  );
}

function messageAsksAboutTreatmentCost(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const asksCost =
    normalized.includes('cuanto sale') ||
    normalized.includes('cuanto cuesta') ||
    normalized.includes('precio') ||
    normalized.includes('valor');
  if (!asksCost) return false;
  return normalized.includes('tratamiento') || normalized.includes('medicacion') || normalized.includes('medicación');
}

function messageAsksToTalkToDoctor(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('puedo hablar con') ||
    normalized.includes('puedo hablar') ||
    normalized.includes('hablar con el medico') ||
    normalized.includes('hablar con el médico') ||
    normalized.includes('hablar con el doctor') ||
    normalized.includes('hablar con el dr') ||
    normalized.includes('consultar con el medico') ||
    normalized.includes('consultar con el médico') ||
    normalized.includes('consultar con el doctor')
  );
}

function buildTalkToDoctorReply(priorState) {
  const base =
    'El Dr. no atiende consultas previas por WhatsApp, pero en el turno te dedica el tiempo completo.';
  if (!shouldOfferBookingLink(priorState)) {
    return `${base} ¿Querés que te ayude con algo más?`;
  }
  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (lastSede) {
    return `${base} ¿Querés que te ayude a reservarlo?`;
  }
  return `${base} ¿Querés que te ayude a reservarlo?`;
}

function buildTreatmentCostReply(priorState) {
  const sedeFromState = resolveSedeEntryFromState(priorState) || resolveLastSedeEntryFromState(priorState);
  if (sedeFromState) {
    return `Eso depende del caso y del tratamiento indicado. Lo ideal es una consulta de evaluación en ${sedeFromState.displayName} para que el médico te indique el plan y te informen los valores.`;
  }
  return `Eso depende del caso y del tratamiento indicado. Lo ideal es una consulta de evaluación para que el médico te indique el plan y te informen los valores. ${buildAskSedeBridgeMessage()} ${buildAskSedeMessage()}`.trim();
}

function buildConditionTreatmentReply(priorState, rawText) {
  const normalized = normalizeForMatch(rawText);
  const condition =
    normalized.includes('asma')
      ? 'asma'
      : normalized.includes('rinitis')
        ? 'rinitis'
        : normalized.includes('urticaria')
          ? 'urticaria'
          : normalized.includes('dermatitis') || normalized.includes('eczema')
            ? 'dermatitis'
            : normalized.includes('sinusitis')
              ? 'sinusitis'
              : normalized.includes('broncoespasmo')
                ? 'broncoespasmo'
                : normalized.includes('alerg')
                  ? 'alergias'
                  : null;
  const base = condition
    ? `Sí, el Dr. atiende ${condition}.`
    : 'Sí, el Dr. atiende este tipo de consultas.';
  const sedeFromState = resolveSedeEntryFromState(priorState) || resolveLastSedeEntryFromState(priorState);
  if (sedeFromState) {
    return `${base} Para orientarte bien según el caso, lo ideal es una consulta de evaluación en ${sedeFromState.displayName}.`;
  }
  return `${base} Para orientarte bien según el caso, lo ideal es una consulta de evaluación. ${buildAskSedeMessage()}`;
}

function buildStudiesInformationReply(priorState, rawText = '') {
  if (messageLooksLikePrivatePriceQuestion(rawText)) {
    const sedeFromState = resolveSedeEntryFromState(priorState) || resolveLastSedeEntryFromState(priorState);
    if (sedeFromState) {
      return `Los valores se confirman en la consulta. Si querés, podés sacar un turno de evaluación en ${sedeFromState.displayName} y ahí te informan según el estudio.`;
    }
    return `Los valores se confirman en la consulta. Si querés, podés sacar un turno de evaluación y ahí te informan según el estudio. ${buildAskSedeMessage()}`;
  }
  const sedeFromState = resolveSedeEntryFromState(priorState) || resolveLastSedeEntryFromState(priorState);
  if (sedeFromState) {
    return `${STUDIES_INFORMATION_MESSAGE} Para confirmarte cómo se realiza en tu situación y en ${sedeFromState.displayName}, lo ideal es sacar un turno para evaluación.`;
  }
  return `${STUDIES_INFORMATION_MESSAGE} Para confirmarte cómo se realiza en tu situación y en qué sede, lo ideal es sacar un turno para evaluación. ${buildAskSedeMessage()}`;
}

function buildScheduleQuestionLinkMessage(entry) {
  const url = getAgendaUrl(entry);
  if (url) {
    // Micro-compromiso first; the link is sent only after confirmation.
    return `¿Querés que te pase el link para ver días y horarios disponibles en ${entry.displayName}?`;
  }
  return buildLinkMessage(entry);
}

function buildLinkMessage(entry) {
  const url = getAgendaUrl(entry);
  if (url) {
    return `Perfecto, sede ${entry.displayName}.\n\nAgendá tu turno acá:\n${url}`;
  }
  return [
    `Recibimos tu preferencia por ${entry.displayName}.`,
    '',
    'El link de agenda online todavía no está configurado.',
    'Escribinos el horario preferido y te confirmamos por este chat.',
  ].join('\n');
}

function buildLinkSentStatePatch(entry) {
  const url = getAgendaUrl(entry);
  if (!url) return null;
  return {
    lastBookingLinkSentAtMs: Date.now(),
    lastBookingLinkSedeEnvKey: entry.envKey,
    lastBookingLinkSedeDisplayName: entry.displayName,
    lastBookingLinkUrl: url,
  };
}

function wasBookingLinkSentRecently(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  const lastAtMs = Number(priorState.lastBookingLinkSentAtMs);
  if (!Number.isFinite(lastAtMs) || lastAtMs <= 0) return false;
  return Date.now() - lastAtMs <= BOOKING_LINK_RECENTLY_SENT_MS;
}

function messageLooksLikeBookingLinkTrouble(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('no me abre') ||
    normalized.includes('no abre') ||
    normalized.includes('no funciona') ||
    normalized.includes('no anda') ||
    normalized.includes('no puedo abrir') ||
    normalized.includes('no puedo entrar') ||
    normalized.includes('no carga') ||
    normalized.includes('error en el link') ||
    normalized.includes('link caido') ||
    normalized.includes('link caído') ||
    normalized.includes('no hay turnos') ||
    normalized.includes('no hay disponibles') ||
    normalized.includes('sin turnos') ||
    normalized.includes('no hay disponibilidad') ||
    normalized.includes('no aparecen turnos') ||
    normalized.includes('no aparece disponibilidad')
  );
}

function messageAsksToBookWithoutLink(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsBooking =
    normalized.includes('agendar') ||
    normalized.includes('agenda') ||
    normalized.includes('reserv') ||
    normalized.includes('turno') ||
    normalized.includes('cita');
  if (!mentionsBooking) return false;
  return (
    normalized.includes('no quiero link') ||
    normalized.includes('no quiero el link') ||
    normalized.includes('sin link') ||
    normalized.includes('por chat') ||
    normalized.includes('agendame') ||
    normalized.includes('agendame vos') ||
    normalized.includes('agendamelo') ||
    normalized.includes('agendámelo') ||
    normalized.includes('me lo agendas') ||
    normalized.includes('me lo agendás') ||
    normalized.includes('reservame') ||
    normalized.includes('reservame vos') ||
    normalized.includes('no tengo mail') ||
    normalized.includes('no tengo email') ||
    normalized.includes('no uso mail') ||
    normalized.includes('no uso email')
  );
}

function messageLooksLikeNoAvailability(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('no hay turnos') ||
    normalized.includes('sin turnos') ||
    normalized.includes('no hay disponibles') ||
    normalized.includes('no hay disponibilidad') ||
    normalized.includes('no aparecen turnos') ||
    normalized.includes('no aparece disponibilidad') ||
    normalized.includes('no hay horarios') ||
    normalized.includes('no hay horarios disponibles') ||
    normalized.includes('no hay turno')
  );
}

function stateLooksLikeAwaitingWaitlistConfirmation(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.state === 'awaiting_waitlist_confirmation' &&
    Number.isFinite(Number(state.waitlistFirstAtMs))
  );
}

function stateLooksLikeAwaitingSedeSelection(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.state === 'awaiting_sede_selection' &&
    Number.isFinite(Number(state.awaitingSedeSelectionAtMs))
  );
}

function messageLooksLikeSedeSelectionConfusion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    normalized.includes('no entiendo') ||
    normalized.includes('que tengo que poner') ||
    normalized.includes('qué tengo que poner') ||
    normalized.includes('que es') ||
    normalized.includes('qué es') ||
    normalized.includes('no se cual') ||
    normalized.includes('no sé cual') ||
    normalized.includes('no se que sede') ||
    normalized.includes('no sé que sede')
  );
}

function messageLooksLikeVagueAnswer(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return (
    /^(si|sí|ok|oka|dale|listo|ya|bueno)$/.test(normalized) ||
    normalized === 'no se' ||
    normalized === 'no sé' ||
    normalized === 'cualquiera'
  );
}

function resolveLastBookingLinkSedeEntryFromState(state) {
  if (!state || typeof state !== 'object') return null;
  const envKey =
    typeof state.lastBookingLinkSedeEnvKey === 'string' ? state.lastBookingLinkSedeEnvKey : '';
  if (!envKey) return null;
  for (const entry of SEDE_ENTRIES) {
    if (entry.envKey === envKey) return entry;
  }
  return null;
}

function stateLooksLikeAwaitingBookingLinkTroubleFollowup(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.state === 'awaiting_booking_link_trouble_followup' &&
    Number.isFinite(Number(state.linkTroubleFirstAtMs))
  );
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
 * Conversational reply when the user did not match a sede keyword (docs/agente-liber-reglas.md).
 * Returns null if OpenAI is not configured or the request fails.
 */
async function fetchOpenAiAssistantReply(userMessage, options = {}) {
  const profileDisplayName =
    typeof options.profileDisplayName === 'string' ? options.profileDisplayName : '';
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

  const systemPromptFromFile = loadAgenteLiberSystemPrompt();
  const systemPrompt =
    typeof systemPromptFromFile === 'string' && systemPromptFromFile.trim().length > 0
      ? systemPromptFromFile.trim()
      : FALLBACK_AGENTE_LIBER_SYSTEM_PROMPT;
  const userContent = buildOpenAiUserContent(userMessage, profileDisplayName);

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
          { role: 'user', content: userContent },
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

async function sendWhatsAppText(toPhoneId, body, options = {}) {
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

  // Small, non-blocking UX delay to reduce "too fast" replies when the user is typing in multiple bursts.
  if (!options || options.skipDelay !== true) {
    await sleepMs(DEFAULT_RESPONSE_DELAY_MS);
  }

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
    const latestMessageBySender = new Map();
    const entries = payload.entry || [];
    for (const ent of entries) {
      const changes = ent.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        for (const msg of messages) {
          const from = msg.from;
          if (!from) continue;
          const profileDisplayName = resolveWhatsAppProfileDisplayName(value, from);
          const isText = msg.type === 'text' && typeof msg.text?.body === 'string' && msg.text.body.trim().length > 0;
          if (isText) processedTextMessageCount += 1;

          const existing = latestMessageBySender.get(from);
          // Prefer text if we have it; otherwise keep latest non-text.
          if (existing && existing.isText === true) {
            if (!isText) continue;
          }

          latestMessageBySender.set(from, {
            from,
            profileDisplayName,
            isText,
            messageType: msg.type,
            bodyText: isText ? msg.text.body : null,
          });
        }
      }
    }

    for (const item of latestMessageBySender.values()) {
      const { from, profileDisplayName, isText, messageType } = item;
      const priorState = await getConversationState(from);
      if (!isText) {
        const lastPromptAtMs =
          priorState && typeof priorState === 'object' ? Number(priorState.lastNonTextWriteItDownAtMs) : NaN;
        const isInCooldown =
          Number.isFinite(lastPromptAtMs) &&
          Date.now() - lastPromptAtMs <= NON_TEXT_WRITE_IT_DOWN_COOLDOWN_MS;
        if (isInCooldown) {
          await setConversationState(from, { ...(priorState || {}), lastSeenAtMs: Date.now() });
          continue;
        }
        const wrapped = buildAutoReplyWithGreetingIfNeeded(
          '¿Me lo podés escribir en un mensaje, por favor? Así puedo ayudarte mejor.',
          profileDisplayName,
          priorState
        );
        await setConversationState(from, {
          ...(priorState || {}),
          ...(wrapped.nextStatePatch || {}),
          lastSeenAtMs: Date.now(),
          lastBotReplyAtMs: Date.now(),
          lastNonTextMessageType: messageType,
          lastNonTextWriteItDownAtMs: Date.now(),
        });
        await sendWhatsAppText(from, wrapped.messageText);
        continue;
      }

      let bodyText = item.bodyText;

          if (
            stateLooksLikeAwaitingSedeSelection(priorState) &&
            (messageLooksLikeSedeSelectionConfusion(bodyText) || messageLooksLikeVagueAnswer(bodyText))
          ) {
            await sendSedeSelectionHelpMessage(from, profileDisplayName, priorState);
            continue;
          }

          if (stateLooksLikeCollectingUserMessage(priorState)) {
            const pendingAtMs = Number(priorState.pendingUserTextAtMs);
            const isWithinWindow =
              Number.isFinite(pendingAtMs) && Date.now() - pendingAtMs <= MESSAGE_COLLECTION_WINDOW_MS;
            const pendingUserText = priorState.pendingUserText.trim();
            if (isWithinWindow && pendingUserText) {
              bodyText = `${pendingUserText} ${String(bodyText || '')}`.trim();
              const preservedSessionState =
                priorState && typeof priorState === 'object'
                  ? {
                      greeted: Boolean(priorState.greeted),
                      lastSeenAtMs: priorState.lastSeenAtMs,
                      lastSedeEnvKey: priorState.lastSedeEnvKey,
                      lastSedeDisplayName: priorState.lastSedeDisplayName,
                      lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                      lastSedeAtMs: priorState.lastSedeAtMs,
                    }
                  : {};
              await setConversationState(from, preservedSessionState);
            }
          }

          if (textMatchesMedicalEmergency(bodyText)) {
            const emergencyWrapped = buildAutoReplyWithGreetingIfNeeded(
              MEDICAL_EMERGENCY_RESPONSE_MESSAGE,
              profileDisplayName,
              priorState
            );
            if (emergencyWrapped.nextStatePatch) {
              await setConversationState(from, { ...(priorState || {}), ...emergencyWrapped.nextStatePatch });
            }
            await sendWhatsAppText(from, emergencyWrapped.messageText);
            continue;
          }
          if (needsChacoProvinceClarification(bodyText)) {
            const chacoWrapped = buildAutoReplyWithGreetingIfNeeded(
              CHACO_AMBIGUOUS_CLARIFICATION_MESSAGE,
              profileDisplayName,
              priorState
            );
            if (chacoWrapped.nextStatePatch) {
              await setConversationState(from, { ...(priorState || {}), ...chacoWrapped.nextStatePatch });
            }
            await sendWhatsAppText(from, chacoWrapped.messageText);
            continue;
          }

          if (messageAsksToBookWithoutLink(bodyText)) {
            const preservedSessionState = mergeConversationStatePreservingGreeting(
              priorState,
              {},
              { bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS }
            );
            await setConversationState(from, preservedSessionState);
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              DERIVATIVE_HANDOFF_PATIENT_MESSAGE,
              profileDisplayName,
              preservedSessionState
            );
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (stateLooksLikeAwaitingWaitlistConfirmation(priorState)) {
            const nowMs = Date.now();
            const isInWindow =
              nowMs - Number(priorState.waitlistFirstAtMs) <= WAITLIST_CONFIRMATION_WINDOW_MS;
            if (isInWindow && messageConfirmsLinkSend(bodyText)) {
              const preservedSessionState = mergeConversationStatePreservingGreeting(
                priorState,
                {},
                { bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS }
              );
              await setConversationState(from, preservedSessionState);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                DERIVATIVE_HANDOFF_PATIENT_MESSAGE,
                profileDisplayName,
                preservedSessionState
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            if (isInWindow && messageClearlyRejectsLinkSend(bodyText)) {
              const url =
                priorState && typeof priorState === 'object' && typeof priorState.lastBookingLinkUrl === 'string'
                  ? priorState.lastBookingLinkUrl
                  : null;
              const sedeFromLink = resolveLastBookingLinkSedeEntryFromState(priorState);
              const isFormosaOrSaenz =
                sedeFromLink &&
                (sedeFromLink.envKey === 'CALENDLY_FORMOSA' || sedeFromLink.envKey === 'CALENDLY_SAENZ_PENA');
              const goodbye = isFormosaOrSaenz
                ? (url
                    ? `Sin problema. Cuando quieras el link te queda acá:\n${url}\nHasta pronto 😊`
                    : 'Sin problema. Hasta pronto 😊')
                : 'Sin problema.';
              const preservedSessionState = mergeConversationStatePreservingGreeting(
                priorState,
                {},
                { bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS }
              );
              await setConversationState(from, preservedSessionState);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(goodbye, profileDisplayName, preservedSessionState);
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
          }

          if (messageLooksLikeNoAvailability(bodyText)) {
            const nowMs = Date.now();
            const url =
              priorState && typeof priorState === 'object' && typeof priorState.lastBookingLinkUrl === 'string'
                ? priorState.lastBookingLinkUrl
                : null;
            const sedeFromLink = resolveLastBookingLinkSedeEntryFromState(priorState);
            const isFormosaOrSaenz =
              sedeFromLink &&
              (sedeFromLink.envKey === 'CALENDLY_FORMOSA' || sedeFromLink.envKey === 'CALENDLY_SAENZ_PENA');
            const nextState = mergeConversationStatePreservingGreeting(
              priorState,
              {
                state: 'awaiting_waitlist_confirmation',
                waitlistFirstAtMs: nowMs,
              },
              { bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS }
            );
            await setConversationState(from, nextState);

            if (isFormosaOrSaenz) {
              const message1 =
                'Para esas sedes las fechas las carga el Dr. con anticipación; por ahora no hay turnos cargados.';
              const message2 = '¿Querés que te avisemos cuando estén disponibles?';
              const wrapped1 = buildAutoReplyWithGreetingIfNeeded(message1, profileDisplayName, priorState);
              await sendWhatsAppText(from, wrapped1.messageText);
              await sendWhatsAppText(from, message2, { skipDelay: true });
              continue;
            }

            const message1 = 'La agenda se llena rápido, pero se van liberando turnos por cancelaciones.';
            const message2 = url
              ? `Te recomiendo volver a revisar el link en unos días:\n${url}`
              : 'Te recomiendo volver a revisar la agenda en unos días.';
            const message3 =
              'Si preferís que te contactemos cuando haya un hueco, decime y te paso con alguien del equipo.';

            const wrapped1 = buildAutoReplyWithGreetingIfNeeded(message1, profileDisplayName, priorState);
            await sendWhatsAppText(from, wrapped1.messageText);
            await sendWhatsAppText(from, message2, { skipDelay: true });
            await sendWhatsAppText(from, message3, { skipDelay: true });
            continue;
          }

          if (messageLooksLikeBookingLinkTrouble(bodyText)) {
            const nowMs = Date.now();
            const isFollowup =
              stateLooksLikeAwaitingBookingLinkTroubleFollowup(priorState) &&
              nowMs - Number(priorState.linkTroubleFirstAtMs) <= BOOKING_LINK_TROUBLE_FOLLOWUP_WINDOW_MS;

            if (!isFollowup) {
              const nextState = mergeConversationStatePreservingGreeting(
                priorState,
                {
                  state: 'awaiting_booking_link_trouble_followup',
                  linkTroubleFirstAtMs: nowMs,
                },
                { bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS }
              );
              await setConversationState(from, nextState);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                'Probá abrirlo desde otro navegador o desde la computadora si estás en el celu.',
                profileDisplayName,
                priorState
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }

            const preservedSessionState = mergeConversationStatePreservingGreeting(
              priorState,
              {},
              { bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS }
            );
            await setConversationState(from, preservedSessionState);
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              DERIVATIVE_HANDOFF_PATIENT_MESSAGE,
              profileDisplayName,
              preservedSessionState
            );
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (messageIsSmallTalk(bodyText) && messageLooksLikeGreetingOnly(bodyText)) {
            const lastBotReplyAtMs =
              priorState && typeof priorState === 'object' ? Number(priorState.lastBotReplyAtMs) : NaN;
            const isInCooldown =
              Number.isFinite(lastBotReplyAtMs) && Date.now() - lastBotReplyAtMs <= SMALL_TALK_COOLDOWN_MS;
            if (isInCooldown) {
              const preservedSessionState =
                priorState && typeof priorState === 'object'
                  ? {
                      greeted: Boolean(priorState.greeted),
                      lastSeenAtMs: Date.now(),
                      lastSedeEnvKey: priorState.lastSedeEnvKey,
                      lastSedeDisplayName: priorState.lastSedeDisplayName,
                      lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                      lastSedeAtMs: priorState.lastSedeAtMs,
                      lastBotReplyAtMs: priorState.lastBotReplyAtMs,
                    }
                  : { lastSeenAtMs: Date.now() };
              await setConversationState(from, preservedSessionState);
              continue;
            }
            await sendAskSedeTwoStep(from, profileDisplayName, priorState, '¿En qué puedo ayudarte?');
            continue;
          }

          if (
            !stateLooksLikeAwaitingLinkConfirmation(priorState) &&
            !messageIsGreeting(bodyText) &&
            !findSedeFromText(bodyText) &&
            !messageLooksLikeHealthInsurancePlusQuestion(bodyText) &&
            !messageLooksLikePrivatePriceQuestion(bodyText) &&
            !messageLooksLikeScheduleAvailabilityQuestion(bodyText) &&
            !messageExplicitlyRequestsBookingLink(bodyText) &&
            !textMatchesMedicalEmergency(bodyText) &&
            !needsChacoProvinceClarification(bodyText) &&
            messageLooksLikeFragment(bodyText)
          ) {
            const pendingUserText = stateLooksLikeCollectingUserMessage(priorState)
              ? `${priorState.pendingUserText.trim()} ${String(bodyText || '')}`.trim()
              : String(bodyText || '').trim();
            const collectingState = mergeConversationStatePreservingGreeting(
              priorState,
              buildCollectingUserMessageState(pendingUserText),
              null
            );
            await setConversationState(from, collectingState);
            continue;
          }

          if (messageLooksLikeGreetingOnly(bodyText)) {
            const preservedSessionState =
              priorState && typeof priorState === 'object'
                ? {
                    greeted: Boolean(priorState.greeted),
                    lastSeenAtMs: priorState.lastSeenAtMs,
                    lastSedeEnvKey: priorState.lastSedeEnvKey,
                    lastSedeDisplayName: priorState.lastSedeDisplayName,
                    lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                    lastSedeAtMs: priorState.lastSedeAtMs,
                    lastBotReplyAtMs: priorState.lastBotReplyAtMs,
                  }
                : {};
            await sendAskSedeTwoStep(from, profileDisplayName, preservedSessionState, '¿En qué puedo ayudarte?');
            continue;
          }

          if (
            priorState &&
            priorState.state === 'awaiting_health_insurance_city' &&
            messageLooksLikeScheduleAvailabilityQuestion(bodyText)
          ) {
            const lastSede = resolveLastSedeEntryFromState(priorState);
            const preservedSessionState =
              priorState && typeof priorState === 'object'
                ? {
                    greeted: Boolean(priorState.greeted),
                    lastSeenAtMs: priorState.lastSeenAtMs,
                    lastSedeEnvKey: priorState.lastSedeEnvKey,
                    lastSedeDisplayName: priorState.lastSedeDisplayName,
                    lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                    lastSedeAtMs: priorState.lastSedeAtMs,
                  }
                : {};
            await setConversationState(from, preservedSessionState);
            const reply = lastSede ? buildScheduleQuestionLinkMessage(lastSede) : buildAskSedeMessage();
            const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, preservedSessionState);
            if (wrapped.nextStatePatch) {
              await setConversationState(from, { ...preservedSessionState, ...wrapped.nextStatePatch });
            }
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (priorState && priorState.state === 'awaiting_schedule_sede') {
            const sedeFromMessage = findSedeFromText(bodyText);
            if (sedeFromMessage) {
              await clearConversationState(from);
              const reply = buildSedeScheduleReply(sedeFromMessage);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  priorState || {},
                  { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(sedeFromMessage) || {}) }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
          }

          if (messageLooksLikeMultiIntentCandidate(bodyText)) {
            const intents = (await decideIntentsWithOpenAi(bodyText)) || [];
            const hasHealthInsurance = intents.includes('HEALTH_INSURANCE');
            const hasPrivatePrice = intents.includes('PRIVATE_PRICE');

            if (hasHealthInsurance && hasPrivatePrice) {
              const sedeFromMessage = findSedeFromText(bodyText) || resolveLastSedeEntryFromState(priorState);
              const healthInsuranceName =
                tryExtractHealthInsuranceName(bodyText) ||
                (!messageLooksLikeGenericInstitutionHealthInsurance(bodyText)
                  ? await tryResolveHealthInsuranceNameFromSheetsFuzzy(bodyText)
                  : null);
              if (sedeFromMessage && healthInsuranceName) {
                const healthInsuranceSummary = await buildHealthInsuranceSummary(
                  sedeFromMessage,
                  healthInsuranceName
                );
                if (healthInsuranceSummary !== 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                  const privatePriceReply = await buildPrivatePriceReply(sedeFromMessage);
                  const combined = `${healthInsuranceSummary} ${privatePriceReply}`.trim();
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(
                    appendBookingLinkOfferIfAllowed(priorState, combined),
                    profileDisplayName,
                    priorState
                  );
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(sedeFromMessage, 'after_health_insurance_plus', {
                        healthInsuranceName,
                      }),
                      {
                        ...(wrapped.nextStatePatch || {}),
                        ...(buildLastSedeStatePatch(sedeFromMessage) || {}),
                      }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
              }
            }

            const primaryIntent = intents.length > 0 ? intents[0] : null;
            if (primaryIntent === 'HEALTH_INSURANCE') {
              const sedeFromMessage = findSedeFromText(bodyText) || resolveLastSedeEntryFromState(priorState);
              const healthInsuranceName =
                tryExtractHealthInsuranceName(bodyText) ||
                (!messageLooksLikeGenericInstitutionHealthInsurance(bodyText)
                  ? await tryResolveHealthInsuranceNameFromSheetsFuzzy(bodyText)
                  : null);
              if (sedeFromMessage && healthInsuranceName) {
                const reply = await buildHealthInsurancePlusReplyOrAskCity(
                  sedeFromMessage,
                  healthInsuranceName,
                  priorState
                );
                if (reply !== 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(sedeFromMessage, 'after_health_insurance_plus', {
                        healthInsuranceName,
                      }),
                      {
                        ...(wrapped.nextStatePatch || {}),
                        ...(buildLastSedeStatePatch(sedeFromMessage) || {}),
                      }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
              }
            } else if (primaryIntent === 'PRIVATE_PRICE') {
              const sedeFromMessage = findSedeFromText(bodyText) || resolveLastSedeEntryFromState(priorState);
              if (sedeFromMessage) {
                const reply = await buildPrivatePriceReply(sedeFromMessage);
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  appendBookingLinkOfferIfAllowed(priorState, reply),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    buildAwaitingLinkConfirmationState(sedeFromMessage, 'after_private_price'),
                    { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(sedeFromMessage) || {}) }
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
            } else if (primaryIntent === 'BOOKING') {
              const lastSede = resolveLastSedeEntryFromState(priorState);
              if (lastSede) {
                const micro = buildMicroCommitmentMessageWithState(priorState);
                const wrapped = buildAutoReplyWithGreetingIfNeeded(micro, profileDisplayName, priorState);
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    buildAwaitingLinkConfirmationState(lastSede, 'after_booking_intent'),
                    { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
            }
          }

          if (messageAsksIfDoctorTreatsChildren(bodyText)) {
            const lastSede = resolveLastSedeEntryFromState(priorState);
            if (lastSede) {
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                'Sí, el Dr. atiende niños y adultos.',
                profileDisplayName,
                priorState
              );
              if (wrapped.nextStatePatch) {
                await setConversationState(from, { ...(priorState || {}), ...wrapped.nextStatePatch });
              }
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            await sendAskSedeTwoStep(from, profileDisplayName, priorState, 'Sí, el Dr. atiende niños y adultos.');
            continue;
          }

          if (messageAsksAboutStudiesOrTests(bodyText)) {
            if (stateLooksLikeAwaitingLinkConfirmation(priorState)) {
              const preservedSessionState =
                priorState && typeof priorState === 'object'
                  ? {
                      greeted: Boolean(priorState.greeted),
                      lastSeenAtMs: priorState.lastSeenAtMs,
                      lastSedeEnvKey: priorState.lastSedeEnvKey,
                      lastSedeDisplayName: priorState.lastSedeDisplayName,
                      lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                      lastSedeAtMs: priorState.lastSedeAtMs,
                    }
                  : {};
              await setConversationState(from, preservedSessionState);
            }
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              buildStudiesInformationReply(priorState, bodyText),
              profileDisplayName,
              priorState
            );
            if (wrapped.nextStatePatch) {
              await setConversationState(from, { ...(priorState || {}), ...wrapped.nextStatePatch });
            }
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (
            messageAsksAboutDocumentationOrRequirements(bodyText) ||
            messageAsksAboutReferralOrPrescription(bodyText) ||
            messageAsksAboutInvoice(bodyText) ||
            messageAsksAboutPaymentMethods(bodyText) ||
            messageAsksAboutConsultDuration(bodyText) ||
            messageAsksAboutCompanion(bodyText) ||
            messageAsksAboutOtherProvinces(bodyText) ||
            messageAsksAboutVirtualVisit(bodyText) ||
            messageAsksForMapsLocation(bodyText) ||
            messageAsksAboutSedeAddressOrHowToArrive(bodyText) ||
            messageAsksAboutStudyFasting(bodyText) ||
            messageAsksAboutStudyMedicationPreparation(bodyText) ||
            messageAsksAboutStudyDuration(bodyText) ||
            messageAsksAboutMedicationAllergyStudy(bodyText)
          ) {
            let reply = null;
            const sedeMentionedInMessage = messageAsksAboutSedeAddressOrHowToArrive(bodyText)
              ? findSedeFromText(bodyText)
              : null;
            if (messageAsksAboutInvoice(bodyText)) reply = INVOICE_MESSAGE;
            else if (messageAsksAboutPaymentMethods(bodyText)) reply = PAYMENT_METHODS_MESSAGE;
            else if (messageAsksAboutConsultDuration(bodyText)) reply = CONSULT_DURATION_MESSAGE;
            else if (messageAsksAboutCompanion(bodyText)) reply = COMPANION_ALLOWED_MESSAGE;
            else if (messageAsksAboutOtherProvinces(bodyText)) reply = OTHER_PROVINCES_MESSAGE;
            else if (messageAsksAboutVirtualVisit(bodyText)) reply = VIRTUAL_VISITS_MESSAGE;
            else if (messageAsksForMapsLocation(bodyText)) reply = buildSedeMapsLocationReply(priorState, findSedeFromText(bodyText));
            else if (messageAsksAboutSedeAddressOrHowToArrive(bodyText))
              reply = buildSedeAddressReply(priorState, sedeMentionedInMessage);
            else if (messageAsksAboutStudyFasting(bodyText)) reply = STUDY_FASTING_MESSAGE;
            else if (messageAsksAboutStudyMedicationPreparation(bodyText))
              reply = STUDY_PREPARATION_MEDICATION_MESSAGE;
            else if (messageAsksAboutStudyDuration(bodyText)) reply = STUDY_DURATION_MESSAGE;
            else if (messageAsksAboutMedicationAllergyStudy(bodyText)) reply = MEDICATION_ALLERGY_STUDY_MESSAGE;
            else if (messageAsksAboutReferralOrPrescription(bodyText))
              reply = appendAskSedeIfMissing(priorState, NO_REFERRAL_REQUIRED_MESSAGE);
            else if (messageAsksAboutDocumentationOrRequirements(bodyText)) {
              if (
                normalizeForMatch(bodyText).includes('credencial') ||
                normalizeForMatch(bodyText).includes('autoriz')
              ) {
                reply = appendAskSedeIfMissing(priorState, AUTHORIZATION_AND_DIGITAL_CARD_MESSAGE);
              } else {
                reply = appendAskSedeIfMissing(priorState, DOCUMENTATION_REQUIREMENTS_MESSAGE);
              }
            } else {
              reply = MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
            }

            if (stateLooksLikeAwaitingLinkConfirmation(priorState)) {
              const preservedSessionState =
                priorState && typeof priorState === 'object'
                  ? {
                      greeted: Boolean(priorState.greeted),
                      lastSeenAtMs: priorState.lastSeenAtMs,
                      lastSedeEnvKey: priorState.lastSedeEnvKey,
                      lastSedeDisplayName: priorState.lastSedeDisplayName,
                      lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                      lastSedeAtMs: priorState.lastSedeAtMs,
                      lastBotReplyAtMs: priorState.lastBotReplyAtMs,
                    }
                  : {};
              await setConversationState(from, preservedSessionState);
            }

            const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
            const nextStatePatch = { ...(wrapped.nextStatePatch || {}), lastSeenAtMs: Date.now(), lastBotReplyAtMs: Date.now() };
            await setConversationState(from, {
              ...(priorState || {}),
              ...(sedeMentionedInMessage ? buildLastSedeStatePatch(sedeMentionedInMessage) : null),
              ...nextStatePatch,
            });
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (messageAsksToTalkToDoctor(bodyText)) {
            if (stateLooksLikeAwaitingLinkConfirmation(priorState)) {
              const preservedSessionState =
                priorState && typeof priorState === 'object'
                  ? {
                      greeted: Boolean(priorState.greeted),
                      lastSeenAtMs: priorState.lastSeenAtMs,
                      lastSedeEnvKey: priorState.lastSedeEnvKey,
                      lastSedeDisplayName: priorState.lastSedeDisplayName,
                      lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                      lastSedeAtMs: priorState.lastSedeAtMs,
                      lastBotReplyAtMs: priorState.lastBotReplyAtMs,
                    }
                  : {};
              await setConversationState(from, preservedSessionState);
            }
            const lastSede = resolveLastSedeEntryFromState(priorState);
            const reply = buildTalkToDoctorReply(priorState);
            const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
            if (wrapped.nextStatePatch) {
              await setConversationState(from, { ...(priorState || {}), ...wrapped.nextStatePatch });
            }
            await sendWhatsAppText(from, wrapped.messageText);
            if (shouldOfferBookingLink(priorState) && !lastSede) {
              await sendAskSedeTwoStep(from, profileDisplayName, priorState);
            }
            continue;
          }

          if (messageAsksAboutTreatmentCost(bodyText)) {
            if (stateLooksLikeAwaitingLinkConfirmation(priorState)) {
              const preservedSessionState =
                priorState && typeof priorState === 'object'
                  ? {
                      greeted: Boolean(priorState.greeted),
                      lastSeenAtMs: priorState.lastSeenAtMs,
                      lastSedeEnvKey: priorState.lastSedeEnvKey,
                      lastSedeDisplayName: priorState.lastSedeDisplayName,
                      lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                      lastSedeAtMs: priorState.lastSedeAtMs,
                      lastBotReplyAtMs: priorState.lastBotReplyAtMs,
                    }
                  : {};
              await setConversationState(from, preservedSessionState);
            }
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              buildTreatmentCostReply(priorState),
              profileDisplayName,
              priorState
            );
            if (wrapped.nextStatePatch) {
              await setConversationState(from, { ...(priorState || {}), ...wrapped.nextStatePatch });
            }
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (messageAsksAboutConditionTreatment(bodyText)) {
            if (stateLooksLikeAwaitingLinkConfirmation(priorState)) {
              const preservedSessionState =
                priorState && typeof priorState === 'object'
                  ? {
                      greeted: Boolean(priorState.greeted),
                      lastSeenAtMs: priorState.lastSeenAtMs,
                      lastSedeEnvKey: priorState.lastSedeEnvKey,
                      lastSedeDisplayName: priorState.lastSedeDisplayName,
                      lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                      lastSedeAtMs: priorState.lastSedeAtMs,
                    }
                  : {};
              await setConversationState(from, preservedSessionState);
            }
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              buildConditionTreatmentReply(priorState, bodyText),
              profileDisplayName,
              priorState
            );
            if (wrapped.nextStatePatch) {
              await setConversationState(from, { ...(priorState || {}), ...wrapped.nextStatePatch });
            }
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          // If the user answers "sí/ok/dale" but we lost state (serverless restart),
          // don't fall through to the LLM greeting; ask which sede they want the link for.
          if (stateLooksLikeAwaitingLinkConfirmation(priorState)) {
            const sedeChange = findSedeFromText(bodyText);
            if (sedeChange) {
              const pendingHealthInsuranceName =
                priorState && typeof priorState === 'object' && typeof priorState.healthInsuranceName === 'string'
                  ? priorState.healthInsuranceName
                  : null;
              if (pendingHealthInsuranceName) {
                const reply = await buildHealthInsurancePlusReplyOrAskCity(
                  sedeChange,
                  pendingHealthInsuranceName
                );
                if (reply !== 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(sedeChange, 'after_health_insurance_plus', {
                        healthInsuranceName: pendingHealthInsuranceName,
                      }),
                      { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(sedeChange) || {}) }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
              }

              // If we're awaiting link confirmation and the user changes the sede (even without OS context),
              // update the pending sede and continue with the link flow for the new city.
              const preservedDetails =
                priorState && typeof priorState === 'object'
                  ? {
                      healthInsuranceName:
                        typeof priorState.healthInsuranceName === 'string' ? priorState.healthInsuranceName : undefined,
                    }
                  : {};
              const promptForNewSede = buildScheduleQuestionLinkMessage(sedeChange);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                promptForNewSede,
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sedeChange, 'after_sede_selection', preservedDetails),
                  { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(sedeChange) || {}) }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            // If they changed topic (e.g. asking price / obra social), do not trap them in a "sí/no" loop.
            // Clear the pending link-confirmation routing state but preserve the greeting session.
            const shouldBypassPendingLinkConfirmation =
              messageLooksLikePrivatePriceQuestion(bodyText) ||
              messageLooksLikeHealthInsurancePlusQuestion(bodyText) ||
              messageAsksAboutStudiesOrTests(bodyText) ||
              messageAsksAboutConditionTreatment(bodyText) ||
              messageExplicitlyRequestsBookingLink(bodyText) ||
              messageLooksLikeBookingIntent(bodyText);
            if (shouldBypassPendingLinkConfirmation) {
              const preservedSessionState =
                priorState && typeof priorState === 'object'
                  ? {
                      greeted: Boolean(priorState.greeted),
                      lastSeenAtMs: priorState.lastSeenAtMs,
                      lastSedeEnvKey: priorState.lastSedeEnvKey,
                      lastSedeDisplayName: priorState.lastSedeDisplayName,
                      lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                      lastSedeAtMs: priorState.lastSedeAtMs,
                    }
                  : {};
              await setConversationState(from, preservedSessionState);
            } else {
            // Confirmations like "sí quiero!" should send the link.
            const isHardYes = messageConfirmsLinkSend(bodyText);
            const isHardNo = messageClearlyRejectsLinkSend(bodyText);
            let routerDecision = null;
            if (!isHardYes && !isHardNo) {
              routerDecision = await decideNextActionForLinkConfirmationWithOpenAi(bodyText);
            }

            const shouldSendLink =
              !isHardNo && (isHardYes || routerDecision === 'SEND_LINK');
            const shouldAskClarify =
              !isHardYes && !isHardNo && routerDecision === 'ASK_CLARIFY';
            const shouldNotSendLink =
              isHardNo || routerDecision === 'DO_NOT_SEND';

            if (shouldSendLink) {
              const entryFromState = resolveSedeEntryFromState(priorState);
              if (entryFromState) {
                const linkWrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildLinkMessage(entryFromState),
                  profileDisplayName,
                  priorState
                );
                // Keep greeted flag for subsequent messages.
                const afterLinkState = mergeConversationStatePreservingGreeting(
                  priorState,
                  {},
                  { ...(linkWrapped.nextStatePatch || {}), ...(buildLinkSentStatePatch(entryFromState) || {}) }
                );
                await setConversationState(from, afterLinkState);
                await sendWhatsAppText(from, linkWrapped.messageText);
                continue;
              }
            }
            if (shouldNotSendLink) {
              const preservedSessionState =
                priorState && typeof priorState === 'object'
                  ? {
                      greeted: Boolean(priorState.greeted),
                      lastSeenAtMs: priorState.lastSeenAtMs,
                      lastSedeEnvKey: priorState.lastSedeEnvKey,
                      lastSedeDisplayName: priorState.lastSedeDisplayName,
                      lastSedeOptionNumber: priorState.lastSedeOptionNumber,
                      lastSedeAtMs: priorState.lastSedeAtMs,
                      bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS,
                    }
                  : {};
              const entryFromState = resolveSedeEntryFromState(priorState);
              if (entryFromState) {
                const url = getAgendaUrl(entryFromState);
                const message1 = 'Sin problema, sin apuro.';
                const message2 = url
                  ? `Cuando quieras el link te queda acá:\n${url}\nCualquier duda escribime 😊`
                  : 'Cuando quieras, te paso el link para reservar. Cualquier duda escribime 😊';
                const nextState = mergeConversationStatePreservingGreeting(
                  priorState,
                  {},
                  { ...(buildLinkSentStatePatch(entryFromState) || {}), ...preservedSessionState }
                );
                await setConversationState(from, nextState);
                const wrapped1 = buildAutoReplyWithGreetingIfNeeded(message1, profileDisplayName, priorState);
                await sendWhatsAppText(from, wrapped1.messageText);
                await sendWhatsAppText(from, message2, { skipDelay: true });
                continue;
              }

              await setConversationState(from, preservedSessionState);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                `Perfecto, no hay problema. ${buildAnythingElseHelpMessage(preservedSessionState)}`,
                profileDisplayName,
                preservedSessionState
              );
              if (wrapped.nextStatePatch) {
                await setConversationState(from, { ...preservedSessionState, ...wrapped.nextStatePatch });
              }
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            if (shouldAskClarify) {
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                'Perfecto. Si querés, te paso el link para reservar el turno. ¿Te lo envío?',
                profileDisplayName,
                priorState
              );
              if (wrapped.nextStatePatch) {
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(priorState, priorState || {}, wrapped.nextStatePatch)
                );
              }
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            }
          }

          if (!stateLooksLikeAwaitingLinkConfirmation(priorState) && messageConfirmsLinkSend(bodyText)) {
            if (messageExplicitlyRequestsBookingLink(bodyText)) {
              const lastSede = resolveLastSedeEntryFromState(priorState);
              if (lastSede) {
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildLinkMessage(lastSede),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    priorState || {},
                    { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
            }
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              'Perfecto. ¿Para qué sede querés el link? Podés responder con 1 Corrientes, 2 Resistencia, 3 Sáenz Peña o 4 Formosa.',
              profileDisplayName,
              priorState
            );
            if (wrapped.nextStatePatch) {
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(priorState, priorState || {}, wrapped.nextStatePatch)
              );
            }
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          // Note: awaiting_link_confirmation is handled above (with hard rules + optional OpenAI YES/NO classifier).

          const trimmedBodyText = typeof bodyText === 'string' ? bodyText.trim() : '';
          const isBareSedeOption = /^[1-4]$/.test(trimmedBodyText);
          const canTreatBareSedeOptionAsSede =
            !isBareSedeOption ||
            (stateLooksLikeAwaitingSedeSelection(priorState) &&
              Date.now() - Number(priorState.awaitingSedeSelectionAtMs) <= SEDE_SELECTION_WINDOW_MS) ||
            (priorState &&
              typeof priorState === 'object' &&
              (priorState.state === 'awaiting_booking_link_sede' ||
                priorState.state === 'awaiting_health_insurance_city' ||
                priorState.state === 'awaiting_private_price_city' ||
                priorState.state === 'awaiting_schedule_sede'));

          const sede = canTreatBareSedeOptionAsSede ? findSedeFromText(bodyText) : null;
          if (sede) {
            const lastSedePatch = buildLastSedeStatePatch(sede);
            if (priorState && priorState.state === 'awaiting_booking_link_sede') {
              await clearConversationState(from);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                buildLinkMessage(sede),
                profileDisplayName,
                priorState
              );
              if (wrapped.nextStatePatch) {
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(priorState, priorState || {}, wrapped.nextStatePatch)
                );
              }
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            // If the user explicitly asks for the booking link and we already know the sede, send it directly.
            if (messageExplicitlyRequestsBookingLink(bodyText)) {
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                buildLinkMessage(sede),
                profileDisplayName,
                priorState
              );
              if (wrapped.nextStatePatch) {
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    priorState || {},
                    { ...(wrapped.nextStatePatch || {}), ...(lastSedePatch || {}) }
                  )
                );
              }
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            const pendingHealthInsuranceName =
              priorState && typeof priorState === 'object' && typeof priorState.healthInsuranceName === 'string'
                ? priorState.healthInsuranceName
                : null;
            if (priorState && priorState.state === 'awaiting_health_insurance_city' && pendingHealthInsuranceName) {
              await clearConversationState(from);
              const reply = await buildHealthInsurancePlusReplyOrAskCity(
                sede,
                pendingHealthInsuranceName,
                priorState
              );
              const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
              if (reply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                const lastSede = resolveLastSedeEntryFromState(priorState);
                const askCityText = buildAskSedeForHealthInsuranceMismatchMessage(
                  lastSede?.displayName,
                  pendingHealthInsuranceName
                );
                const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(askCityText, profileDisplayName, priorState);
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_city', healthInsuranceName: pendingHealthInsuranceName },
                    askCityWrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, askCityWrapped.messageText);
                continue;
              }
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sede, 'after_health_insurance_plus', {
                    healthInsuranceName: pendingHealthInsuranceName,
                  }),
                  { ...(wrapped.nextStatePatch || {}), ...(lastSedePatch || {}) }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            if (messageLooksLikeHealthInsurancePlusQuestion(bodyText)) {
              const extractedHealthInsuranceName = tryExtractHealthInsuranceName(bodyText);
              if (extractedHealthInsuranceName) {
                const reply = await buildHealthInsurancePlusReplyOrAskCity(
                  sede,
                  extractedHealthInsuranceName,
                  priorState
                );
                if (reply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                  const lastSede = resolveLastSedeEntryFromState(priorState);
                  const askCityText = buildAskSedeForHealthInsuranceMismatchMessage(
                    lastSede?.displayName,
                    extractedHealthInsuranceName
                  );
                  const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(askCityText, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      { state: 'awaiting_health_insurance_city', healthInsuranceName: extractedHealthInsuranceName },
                      askCityWrapped.nextStatePatch
                    )
                  );
                  await sendWhatsAppText(from, askCityWrapped.messageText);
                  continue;
                }
                const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    buildAwaitingLinkConfirmationState(sede, 'after_health_insurance_plus', {
                      healthInsuranceName: extractedHealthInsuranceName,
                    }),
                    { ...(wrapped.nextStatePatch || {}), ...(lastSedePatch || {}) }
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              const askOsWrapped = buildAutoReplyWithGreetingIfNeeded(
                buildAskHealthInsuranceNameMessage(),
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  { state: 'awaiting_health_insurance_name' },
                  askOsWrapped.nextStatePatch
                )
              );
              await sendWhatsAppText(from, askOsWrapped.messageText);
              continue;
            }
            if (priorState && priorState.state === 'awaiting_private_price_city') {
              await clearConversationState(from);
              const reply = await buildPrivatePriceReply(sede);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                appendBookingLinkOfferIfAllowed(priorState, reply),
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sede, 'after_private_price'),
                  { ...(wrapped.nextStatePatch || {}), ...(lastSedePatch || {}) }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
            } else if (messageLooksLikePrivatePriceQuestion(bodyText)) {
              const reply = await buildPrivatePriceReply(sede);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                appendBookingLinkOfferIfAllowed(priorState, reply),
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sede, 'after_private_price'),
                  { ...(wrapped.nextStatePatch || {}), ...(lastSedePatch || {}) }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
            } else if (/(agendar|agenda|turno|reserv)/i.test(normalizeForMatch(bodyText))) {
              const micro = buildMicroCommitmentMessageWithState(priorState);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(micro, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sede, 'after_booking_intent'),
                  { ...(wrapped.nextStatePatch || {}), ...(lastSedePatch || {}) }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
            } else if (messageLooksLikeScheduleAvailabilityQuestion(bodyText)) {
              const reply = buildSedeScheduleReply(sede);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  priorState || {},
                  { ...(wrapped.nextStatePatch || {}), ...(lastSedePatch || {}) }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
            } else {
              // Default: if the user only selected a sede (e.g. replied "3"), ask micro-commitment
              // before sending the link.
              const micro = buildMicroCommitmentMessageWithState(priorState);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(micro, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sede, 'after_sede_selection'),
                  { ...(wrapped.nextStatePatch || {}), ...(lastSedePatch || {}) }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
            }
          } else {
            // If the user asks for the link but didn't specify the sede, ask sede first.
            if (messageExplicitlyRequestsBookingLink(bodyText)) {
              const lastSede = resolveLastSedeEntryFromState(priorState);
              // Explicit link request: if we already know the last sede, send the link directly.
              if (lastSede) {
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildLinkMessage(lastSede),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    priorState || {},
                    { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                buildAskSedeMessage(),
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  { state: 'awaiting_booking_link_sede' },
                  wrapped.nextStatePatch
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            // If the user just acknowledges ("Bueno", "Ok") after a helpful answer, keep the thread and avoid re-greeting.
            if (messageIsAcknowledgement(bodyText)) {
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                buildAnythingElseHelpMessage(priorState),
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  priorState || {},
                  { ...(wrapped.nextStatePatch || {}), lastSeenAtMs: Date.now() }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            // Pricing questions must win over "turno/agendar" keyword matches.
            if (messageLooksLikePrivatePriceQuestion(bodyText)) {
              const lastSede = resolveLastSedeEntryFromState(priorState);
              if (lastSede) {
                const reply = await buildPrivatePriceReply(lastSede);
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  appendBookingLinkOfferIfAllowed(priorState, reply),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    buildAwaitingLinkConfirmationState(lastSede, 'after_private_price'),
                    { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                buildAskSedeMessage(),
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  { state: 'awaiting_private_price_city' },
                  wrapped.nextStatePatch
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            // Booking intent without sede: always ask sede (never ask for date/time).
            if (messageLooksLikeBookingIntent(bodyText)) {
              const lastSede = resolveLastSedeEntryFromState(priorState);
              if (lastSede) {
                const micro = buildMicroCommitmentMessageWithState(priorState);
                const wrapped = buildAutoReplyWithGreetingIfNeeded(micro, profileDisplayName, priorState);
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    buildAwaitingLinkConfirmationState(lastSede, 'after_booking_intent'),
                    { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              await sendAskSedeTwoStep(from, profileDisplayName, priorState);
              continue;
            }
            if (priorState && priorState.state === 'awaiting_health_insurance_name') {
              if (messageIsAcknowledgement(bodyText) || messageConfirmsLinkSend(bodyText)) {
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskHealthInsuranceNameMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_name' },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              const extracted = tryExtractHealthInsuranceName(bodyText);
              if (extracted) {
                const lastSede = resolveLastSedeEntryFromState(priorState);
                if (lastSede) {
                  const reply = await buildHealthInsurancePlusReplyOrAskCity(lastSede, extracted, priorState);
                  if (reply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                    const lastSede = resolveLastSedeEntryFromState(priorState);
                    const askCityText = buildAskSedeForHealthInsuranceMismatchMessage(
                      lastSede?.displayName,
                      extracted
                    );
                    const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(
                      askCityText,
                      profileDisplayName,
                      priorState
                    );
                    await setConversationState(
                      from,
                      mergeConversationStatePreservingGreeting(
                        priorState,
                        { state: 'awaiting_health_insurance_city', healthInsuranceName: extracted },
                        askCityWrapped.nextStatePatch
                      )
                    );
                    await sendWhatsAppText(from, askCityWrapped.messageText);
                    continue;
                  }
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(lastSede, 'after_health_insurance_plus', {
                        healthInsuranceName: extracted,
                      }),
                      { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskSedeMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_city', healthInsuranceName: extracted },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              // AMMECO is a family with multiple plans in the Sheet; ask for the plan instead of
              // claiming we can't identify it.
              const normalizedUserTextForAmmeCo = normalizeForMatch(bodyText);
              if (normalizedUserTextForAmmeCo.includes('ammeco')) {
                const askPlanText =
                  '¿Qué plan de AMMECO tenés? Podés responder: Plan A, Plan B, Plan Dorado, Red, ASE u OSPUAYE.';
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  askPlanText,
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_plan', healthInsuranceFamily: 'AMMECO' },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              if (messageLooksLikeGenericInstitutionHealthInsurance(bodyText)) {
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskHealthInsuranceNameMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_name' },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              // Try resolving directly from the Sheet names (fuzzy match) before calling OpenAI.
              const resolvedFromSheets = await tryResolveHealthInsuranceNameFromSheetsFuzzy(bodyText);
              if (resolvedFromSheets) {
                const lastSede = resolveLastSedeEntryFromState(priorState);
                if (lastSede) {
                  const reply = await buildHealthInsurancePlusReplyOrAskCity(
                    lastSede,
                    resolvedFromSheets,
                    priorState
                  );
                  if (reply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                    const lastSede = resolveLastSedeEntryFromState(priorState);
                    const askCityText = buildAskSedeForHealthInsuranceMismatchMessage(
                      lastSede?.displayName,
                      resolvedFromSheets
                    );
                    const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(
                      askCityText,
                      profileDisplayName,
                      priorState
                    );
                    await setConversationState(
                      from,
                      mergeConversationStatePreservingGreeting(
                        priorState,
                        { state: 'awaiting_health_insurance_city', healthInsuranceName: resolvedFromSheets },
                        askCityWrapped.nextStatePatch
                      )
                    );
                    await sendWhatsAppText(from, askCityWrapped.messageText);
                    continue;
                  }
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(lastSede, 'after_health_insurance_plus', {
                        healthInsuranceName: resolvedFromSheets,
                      }),
                      { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskSedeMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_city', healthInsuranceName: resolvedFromSheets },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              // If we can't extract it with hard rules, try OpenAI to map typos/aliases to a canonical name
              // that exists in our Sheet.
              const resolvedCanonicalName = await tryResolveHealthInsuranceNameWithOpenAi(bodyText);
              if (resolvedCanonicalName) {
                const lastSede = resolveLastSedeEntryFromState(priorState);
                if (lastSede) {
                  const reply = await buildHealthInsurancePlusReplyOrAskCity(
                    lastSede,
                    resolvedCanonicalName,
                    priorState
                  );
                  if (reply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                    const lastSede = resolveLastSedeEntryFromState(priorState);
                    const askCityText = buildAskSedeForHealthInsuranceMismatchMessage(
                      lastSede?.displayName,
                      resolvedCanonicalName
                    );
                    const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(
                      askCityText,
                      profileDisplayName,
                      priorState
                    );
                    await setConversationState(
                      from,
                      mergeConversationStatePreservingGreeting(
                        priorState,
                        { state: 'awaiting_health_insurance_city', healthInsuranceName: resolvedCanonicalName },
                        askCityWrapped.nextStatePatch
                      )
                    );
                    await sendWhatsAppText(from, askCityWrapped.messageText);
                    continue;
                  }
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(lastSede, 'after_health_insurance_plus', {
                        healthInsuranceName: resolvedCanonicalName,
                      }),
                      { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskSedeMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_city', healthInsuranceName: resolvedCanonicalName },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              const askAgainText = buildAskHealthInsuranceNameMessage();
              const askAgain = buildAutoReplyWithGreetingIfNeeded(
                askAgainText,
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  { state: 'awaiting_health_insurance_name' },
                  askAgain.nextStatePatch
                )
              );
              await sendWhatsAppText(from, askAgain.messageText);
              continue;
            }
            if (priorState && priorState.state === 'awaiting_health_insurance_plan') {
              const family =
                typeof priorState.healthInsuranceFamily === 'string' ? priorState.healthInsuranceFamily.trim() : '';
              const combined = family ? `${family} ${String(bodyText || '')}` : String(bodyText || '');
              const extracted = tryExtractHealthInsuranceName(combined);
              if (extracted) {
                const lastSede = resolveLastSedeEntryFromState(priorState);
                if (lastSede) {
                  const reply = await buildHealthInsurancePlusReplyOrAskCity(lastSede, extracted, priorState);
                  if (reply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                    const lastSede = resolveLastSedeEntryFromState(priorState);
                    const askCityText = buildAskSedeForHealthInsuranceMismatchMessage(
                      lastSede?.displayName,
                      extracted
                    );
                    const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(
                      askCityText,
                      profileDisplayName,
                      priorState
                    );
                    await setConversationState(
                      from,
                      mergeConversationStatePreservingGreeting(
                        priorState,
                        { state: 'awaiting_health_insurance_city', healthInsuranceName: extracted },
                        askCityWrapped.nextStatePatch
                      )
                    );
                    await sendWhatsAppText(from, askCityWrapped.messageText);
                    continue;
                  }
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(lastSede, 'after_health_insurance_plus', {
                        healthInsuranceName: resolvedFromSheets,
                      }),
                      { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskSedeMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_city', healthInsuranceName: extracted },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }

              const resolvedFromSheets = await tryResolveHealthInsuranceNameFromSheetsFuzzy(combined);
              if (resolvedFromSheets) {
                const lastSede = resolveLastSedeEntryFromState(priorState);
                if (lastSede) {
                  const reply = await buildHealthInsurancePlusReplyOrAskCity(
                    lastSede,
                    resolvedFromSheets,
                    priorState
                  );
                  if (reply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                    const lastSede = resolveLastSedeEntryFromState(priorState);
                    const askCityText = buildAskSedeForHealthInsuranceMismatchMessage(
                      lastSede?.displayName,
                      resolvedFromSheets
                    );
                    const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(
                      askCityText,
                      profileDisplayName,
                      priorState
                    );
                    await setConversationState(
                      from,
                      mergeConversationStatePreservingGreeting(
                        priorState,
                        { state: 'awaiting_health_insurance_city', healthInsuranceName: resolvedFromSheets },
                        askCityWrapped.nextStatePatch
                      )
                    );
                    await sendWhatsAppText(from, askCityWrapped.messageText);
                    continue;
                  }
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(lastSede, 'after_health_insurance_plus', {
                        healthInsuranceName: resolvedCanonicalName,
                      }),
                      { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskSedeMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_city', healthInsuranceName: resolvedFromSheets },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }

              const askAgainText =
                family && family.toUpperCase() === 'AMMECO'
                  ? '¿Qué plan de AMMECO tenés? Podés responder: Plan A, Plan B, Plan Dorado, Red, ASE u OSPUAYE.'
                  : 'No pude identificar esa obra social. ¿Me decís el nombre completo?';
              const askAgain = buildAutoReplyWithGreetingIfNeeded(
                askAgainText,
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  { state: 'awaiting_health_insurance_plan', healthInsuranceFamily: family || 'AMMECO' },
                  askAgain.nextStatePatch
                )
              );
              await sendWhatsAppText(from, askAgain.messageText);
              continue;
            }
            if (messageLooksLikeHealthInsurancePlusQuestion(bodyText)) {
              const healthInsuranceName = tryExtractHealthInsuranceName(bodyText);
              if (healthInsuranceName) {
                const lastSede = resolveLastSedeEntryFromState(priorState);
                if (lastSede) {
                  const reply = await buildHealthInsurancePlusReplyOrAskCity(
                    lastSede,
                    healthInsuranceName,
                    priorState
                  );
                  if (reply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                    const lastSede = resolveLastSedeEntryFromState(priorState);
                    const askCityText = buildAskSedeForHealthInsuranceMismatchMessage(
                      lastSede?.displayName,
                      healthInsuranceName
                    );
                    const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(
                      askCityText,
                      profileDisplayName,
                      priorState
                    );
                    await setConversationState(
                      from,
                      mergeConversationStatePreservingGreeting(
                        priorState,
                        { state: 'awaiting_health_insurance_city', healthInsuranceName },
                        askCityWrapped.nextStatePatch
                      )
                    );
                    await sendWhatsAppText(from, askCityWrapped.messageText);
                    continue;
                  }
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(lastSede, 'after_health_insurance_plus', {
                        healthInsuranceName,
                      }),
                      { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskSedeMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_city', healthInsuranceName },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              // Try resolving directly from the Sheet names (fuzzy match) before calling OpenAI.
              const resolvedFromSheets = await tryResolveHealthInsuranceNameFromSheetsFuzzy(bodyText);
              if (resolvedFromSheets) {
                const lastSede = resolveLastSedeEntryFromState(priorState);
                if (lastSede) {
                  const reply = await buildHealthInsurancePlusReplyOrAskCity(
                    lastSede,
                    resolvedFromSheets,
                    priorState
                  );
                  if (reply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                    const lastSede = resolveLastSedeEntryFromState(priorState);
                    const askCityText = buildAskSedeForHealthInsuranceMismatchMessage(
                      lastSede?.displayName,
                      resolvedFromSheets
                    );
                    const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(
                      askCityText,
                      profileDisplayName,
                      priorState
                    );
                    await setConversationState(
                      from,
                      mergeConversationStatePreservingGreeting(
                        priorState,
                        { state: 'awaiting_health_insurance_city', healthInsuranceName: resolvedFromSheets },
                        askCityWrapped.nextStatePatch
                      )
                    );
                    await sendWhatsAppText(from, askCityWrapped.messageText);
                    continue;
                  }
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(lastSede, 'after_health_insurance_plus', {
                        healthInsuranceName: resolvedFromSheets,
                      }),
                      { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskSedeMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_city', healthInsuranceName: resolvedFromSheets },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              // Not recognized by hard rules. Try OpenAI to map it to a canonical Sheet name.
              const resolvedCanonicalName = await tryResolveHealthInsuranceNameWithOpenAi(bodyText);
              if (resolvedCanonicalName) {
                const lastSede = resolveLastSedeEntryFromState(priorState);
                if (lastSede) {
                  const reply = await buildHealthInsurancePlusReplyOrAskCity(
                    lastSede,
                    resolvedCanonicalName,
                    priorState
                  );
                  if (reply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
                    const lastSede = resolveLastSedeEntryFromState(priorState);
                    const askCityText = buildAskSedeForHealthInsuranceMismatchMessage(
                      lastSede?.displayName,
                      resolvedCanonicalName
                    );
                    const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(
                      askCityText,
                      profileDisplayName,
                      priorState
                    );
                    await setConversationState(
                      from,
                      mergeConversationStatePreservingGreeting(
                        priorState,
                        { state: 'awaiting_health_insurance_city', healthInsuranceName: resolvedCanonicalName },
                        askCityWrapped.nextStatePatch
                      )
                    );
                    await sendWhatsAppText(from, askCityWrapped.messageText);
                    continue;
                  }
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                  await setConversationState(
                    from,
                    mergeConversationStatePreservingGreeting(
                      priorState,
                      buildAwaitingLinkConfirmationState(lastSede, 'after_health_insurance_plus', {
                        healthInsuranceName: resolvedCanonicalName,
                      }),
                      { ...(wrapped.nextStatePatch || {}), ...(buildLastSedeStatePatch(lastSede) || {}) }
                    )
                  );
                  await sendWhatsAppText(from, wrapped.messageText);
                  continue;
                }
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskSedeMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    { state: 'awaiting_health_insurance_city', healthInsuranceName: resolvedCanonicalName },
                    wrapped.nextStatePatch
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              // They asked about obra social/plus but did not specify which one.
              const askOsWrapped = buildAutoReplyWithGreetingIfNeeded(
                buildAskHealthInsuranceNameMessage(),
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  { state: 'awaiting_health_insurance_name' },
                  askOsWrapped.nextStatePatch
                )
              );
              await sendWhatsAppText(from, askOsWrapped.messageText);
              continue;
            }
            const openAiReply = await fetchOpenAiAssistantReply(bodyText, {
              profileDisplayName,
            });
            if (openAiReply) {
              const processed = processAssistantReplyForPatient(openAiReply);
              // If we sent any assistant reply, we consider the chat greeted to avoid repeating greeting wrappers.
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(priorState, priorState || {}, { greeted: true })
              );
              await sendWhatsAppText(from, processed);
            } else {
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                buildAskSedeMessage(),
                profileDisplayName,
                priorState
              );
              if (wrapped.nextStatePatch) {
                await setConversationState(from, mergeConversationStatePreservingGreeting(priorState, priorState || {}, wrapped.nextStatePatch));
              }
              await sendWhatsAppText(from, wrapped.messageText);
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
