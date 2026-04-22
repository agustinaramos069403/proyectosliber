/**
 * WhatsApp Cloud API (Meta) webhook — Netlify Function
 *
 * Env vars (Netlify UI → Site settings → Environment variables):
 * - WHATSAPP_VERIFY_TOKEN     (you choose it; same in Meta app webhook config)
 * - WHATSAPP_ACCESS_TOKEN     (temporary or system user token from Meta)
 * - WHATSAPP_ttytyfdgdPHdsvgdfvONE_NUMBER_ID  (from Meta WhatsApp > API setup)
 * - CALENDLY_CORRIENTES, CALENDLY_RESISTENCIA, CALENDLY_SAENZ_PENA, CALENDLY_FORMOSA
 *   (full URLs to book; if missing, bot fdgdsends text asking to confirm by phone)
 * - OPENAI_API_KEY (optional; if set, non-sede messages use OpenAI with docs/agente-liber-reglas.md prompt file)
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
    match: ['formosa', 'gastroenterologia', 'gastroenterología', 'fsa'],
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
  'es urgente',
  'es una emergencia',
  'emergencia medica',
  'necesito urgencia',
];

const MEDICAL_EMERGENCY_RESPONSE_MESSAGE =
  'Llamá al 107 o andá a la guardia más cercana ahora. No esperes.';

const CHACO_AMBIGUOUS_CLARIFICATION_MESSAGE =
  '¿Estás en Resistencia o en Sáenz Peña?';

const DERIVATIVE_HANDOFF_PATIENT_MESSAGE =
  'Dejame pasarte con alguien del equipo que te puede ayudar mejor. En breve te contactan.';

const MISSING_INFORMATION_CALL_OFFICE_MESSAGE =
  'No cuento con esa información en este momento. Por favor, llamá al consultorio y te lo confirman.';

const FALLBACK_AGENTE_LIBER_SYSTEM_PROMPT =
  'Sos la asistente del consultorio del Dr. Liber Acosta (alergista). Respondé en español argentino, texto plano, sin markdown ni asteriscos, máximo 2 oraciones. No des diagnósticos ni montos. Si pueden decir ciudad o 1-4 para sede, mejor. Reglas completas no cargadas en el servidor.';

let cachedAgenteLiberSystemPrompt = undefined;

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
  return typeof raw === 'string' ? raw.trim() : '';
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
  const url = `${baseUrl.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
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
      console.error('meta-whatsapp-webhook: Upstash error', response.status, text.slice(0, 300));
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('meta-whatsapp-webhook: Upstash fetch error', error);
    return null;
  }
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
  try {
    const response = await fetch(csvUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Netlify Function) meta-whatsapp-webhook' },
    });
    if (!response.ok) {
      const text = await response.text();
      console.error('meta-whatsapp-webhook: CSV fetch failed', response.status, text.slice(0, 300));
      return null;
    }
    const csvText = await response.text();
    return parseCsvToRows(csvText);
  } catch (error) {
    console.error('meta-whatsapp-webhook: CSV fetch error', error);
    return null;
  }
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
      return null;
    }
    cachedGoogleSheetsData = {
      plusLookup: plusRows ? buildPlusLookupMap(plusRows) : new Map(),
      privatePriceLookup: privatePriceRows ? buildPrivatePriceMap(privatePriceRows) : new Map(),
    };
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
    return null;
  }
  cachedGoogleSheetsData = {
    plusLookup: plusRows ? buildPlusLookupMap(plusRows) : new Map(),
    privatePriceLookup: privatePriceRows ? buildPrivatePriceMap(privatePriceRows) : new Map(),
  };
  cachedGoogleSheetsDataExpiresAtMs = now + GOOGLE_SHEETS_CACHE_TTL_MS;
  return cachedGoogleSheetsData;
}

async function lookupPlusRule(cityDisplayName, healthInsuranceName) {
  const data = await getGoogleSheetsData();
  if (!data) return null;
  const cityKey = normalizeForMatch(normalizeCityKeyForSheets(cityDisplayName));
  const osKey = normalizeHealthInsuranceNameForKey(healthInsuranceName);
  const key = `${cityKey}::${osKey}`;
  return data.plusLookup.get(key) || null;
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
  return trimmed;
}

function getAgendaUrl(entry) {
  const url = process.env[entry.envKey];
  return url && url.startsWith('http') ? url : null;
}

function buildAskSedeMessage() {
  return (
    '¿Desde qué ciudad consultás? Podés responder con 1 Corrientes, 2 Resistencia, 3 Sáenz Peña o 4 Formosa.'
  );
}

function buildMicroCommitmentMessage(entry) {
  const optionNumber =
    entry && typeof entry.optionNumber === 'string' && entry.optionNumber.length > 0
      ? entry.optionNumber
      : '';
  if (!optionNumber) {
    return '¿Querés que te pase el link para ver horarios disponibles y reservar?';
  }
  return `¿Querés que te pase el link para ver horarios disponibles y reservar? Si es así, respondé ${optionNumber}.`;
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
  const merged = { ...(nextState || {}) };
  if (patch && typeof patch === 'object') {
    Object.assign(merged, patch);
  }
  if (priorGreeted) {
    merged.greeted = true;
  }
  return merged;
}

function messageLooksLikeHealthInsurancePlusQuestion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('obra social') ||
    normalized.includes('osde') ||
    normalized.includes('isunne') ||
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
  if (normalized.includes('sancor')) return 'Sancor';
  if (normalized.includes('osde')) return 'OSDE';
  if (normalized.includes('isunne')) return 'Isunne';
  if (normalized.includes('swiss')) return 'SWISS MEDICAL';
  if (normalized.includes('ioscor')) return 'IOSCOR';
  if (normalized.includes('galeno')) return 'GALENO ARGENTINA SA';
  if (normalized.includes('medicus')) return 'MEDICUS';
  if (normalized.includes('omint')) return 'OMINT SA';
  if (normalized.includes('prevencion')) return 'PREVENCION SALUD SA';
  if (normalized.includes('jerarquic')) return 'JERARQUICOS SALUD';
  return null;
}

async function buildHealthInsurancePlusReply(cityEntry, healthInsuranceName) {
  const plusRule = await lookupPlusRule(cityEntry.displayName, healthInsuranceName);
  const privatePriceArs = await lookupPrivatePrice(cityEntry.displayName);
  const privatePriceFormatted =
    Number.isFinite(privatePriceArs) ? formatArsAmount(privatePriceArs) : null;

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
      return `En ${cityEntry.displayName} trabajamos con ${healthInsuranceName} sin plus. ¿Querés que te pase el link para ver horarios disponibles y reservar?`;
    }
    return MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
  }

  const osDisplayName = healthInsuranceName;
  if (!plusRule.isAccepted) {
    if (privatePriceFormatted) {
      return `En ${cityEntry.displayName} no trabajamos con ${osDisplayName}. La consulta particular sale $${privatePriceFormatted}. ¿Querés que te pase el link para ver horarios disponibles y reservar?`;
    }
    return `En ${cityEntry.displayName} no trabajamos con ${osDisplayName}. ¿Querés que te pase el link para ver horarios disponibles y reservar?`;
  }

  if (plusRule.hasPlus) {
    const plusFormatted =
      Number.isFinite(plusRule.plusAmountArs) && plusRule.plusAmountArs != null
        ? formatArsAmount(plusRule.plusAmountArs)
        : null;
    if (plusFormatted) {
      return `En ${cityEntry.displayName} con ${osDisplayName} hay un plus de $${plusFormatted}. ¿Querés que te pase el link para ver horarios disponibles y reservar?`;
    }
    return MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
  }

  return `En ${cityEntry.displayName} trabajamos con ${osDisplayName} sin plus. ¿Querés que te pase el link para ver horarios disponibles y reservar?`;
}

function buildAskHealthInsuranceNameMessage() {
  return '¿Qué obra social tenés?';
}

function messageLooksLikePrivatePriceQuestion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('precio') ||
    normalized.includes('cuanto sale') ||
    normalized.includes('cuanto cuesta') ||
    normalized.includes('consulta particular') ||
    normalized.includes('particular') ||
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
  const normalized = normalizeForMatch(rawText);
  return /^(si|sí|dale|ok|oka|de una|manda|mandalo|mandame|pasalo|pasame|quiero|ya|listo)$/.test(
    normalized
  );
}

function buildAwaitingLinkConfirmationState(entry, reason) {
  return {
    state: 'awaiting_link_confirmation',
    sedeEnvKey: entry.envKey,
    sedeDisplayName: entry.displayName,
    sedeOptionNumber: entry.optionNumber,
    reason,
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
  return `En ${entry.displayName} la consulta particular sale $${formatted}. ¿Querés que te pase el link para ver horarios disponibles y reservar?`;
}

function messageLooksLikeScheduleAvailabilityQuestion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('?') ||
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

function buildScheduleQuestionLinkMessage(entry) {
  const url = getAgendaUrl(entry);
  if (url) {
    return `Te dejo la agenda para que veas días y horarios disponibles en ${entry.displayName}:\n${url}`;
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
          const profileDisplayName = resolveWhatsAppProfileDisplayName(value, from);
          const priorState = await getConversationState(from);

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

          // If the user answers "sí/ok/dale" but we lost state (serverless restart),
          // don't fall through to the LLM greeting; ask which sede they want the link for.
          if (!stateLooksLikeAwaitingLinkConfirmation(priorState) && messageConfirmsLinkSend(bodyText)) {
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

          if (stateLooksLikeAwaitingLinkConfirmation(priorState) && messageConfirmsLinkSend(bodyText)) {
            const entryFromState = resolveSedeEntryFromState(priorState);
            if (entryFromState) {
              const linkWrapped = buildAutoReplyWithGreetingIfNeeded(
                buildLinkMessage(entryFromState),
                profileDisplayName,
                priorState
              );
              // Keep greeted flag for subsequent messages.
              const afterLinkState = mergeConversationStatePreservingGreeting(priorState, {}, linkWrapped.nextStatePatch);
              await setConversationState(from, afterLinkState);
              await sendWhatsAppText(from, linkWrapped.messageText);
              continue;
            }
          }

          const sede = findSedeFromText(bodyText);
          if (sede) {
            const pendingHealthInsuranceName =
              priorState && typeof priorState === 'object' && typeof priorState.healthInsuranceName === 'string'
                ? priorState.healthInsuranceName
                : null;
            if (priorState && priorState.state === 'awaiting_health_insurance_city' && pendingHealthInsuranceName) {
              await clearConversationState(from);
              const reply = await buildHealthInsurancePlusReply(sede, pendingHealthInsuranceName);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sede, 'after_health_insurance_plus'),
                  wrapped.nextStatePatch
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            if (messageLooksLikeHealthInsurancePlusQuestion(bodyText)) {
              const extractedHealthInsuranceName = tryExtractHealthInsuranceName(bodyText);
              if (extractedHealthInsuranceName) {
                const reply = await buildHealthInsurancePlusReply(sede, extractedHealthInsuranceName);
                const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    buildAwaitingLinkConfirmationState(sede, 'after_health_insurance_plus'),
                    wrapped.nextStatePatch
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
              const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sede, 'after_private_price'),
                  wrapped.nextStatePatch
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
            } else if (messageLooksLikePrivatePriceQuestion(bodyText)) {
              const reply = await buildPrivatePriceReply(sede);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sede, 'after_private_price'),
                  wrapped.nextStatePatch
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
            } else if (/(agendar|agenda|turno|reserv)/i.test(normalizeForMatch(bodyText))) {
              const micro = buildMicroCommitmentMessage(sede);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(micro, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sede, 'after_booking_intent'),
                  wrapped.nextStatePatch
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
            } else if (messageLooksLikeScheduleAvailabilityQuestion(bodyText)) {
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                buildScheduleQuestionLinkMessage(sede),
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
            } else {
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                buildLinkMessage(sede),
                profileDisplayName,
                priorState
              );
              if (wrapped.nextStatePatch) {
                await setConversationState(from, mergeConversationStatePreservingGreeting(priorState, priorState || {}, wrapped.nextStatePatch));
              }
              await sendWhatsAppText(from, wrapped.messageText);
            }
          } else {
            if (priorState && priorState.state === 'awaiting_health_insurance_name') {
              const extracted = tryExtractHealthInsuranceName(bodyText);
              if (extracted) {
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
              const askAgain = buildAutoReplyWithGreetingIfNeeded(
                buildAskHealthInsuranceNameMessage(),
                profileDisplayName,
                priorState
              );
              await sendWhatsAppText(from, askAgain.messageText);
              continue;
            }
            if (messageLooksLikeHealthInsurancePlusQuestion(bodyText)) {
              const healthInsuranceName = tryExtractHealthInsuranceName(bodyText);
              if (healthInsuranceName) {
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
            if (messageLooksLikePrivatePriceQuestion(bodyText)) {
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
