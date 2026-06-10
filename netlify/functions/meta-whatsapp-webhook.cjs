/**
 * WhatsApp Cloud API (Meta) webhook — Netlify Function
 *
e Op with /agente-liber-reglas.md prompt file)
 * - OPENAI_MODEL (optional; default gpt-4o-mini)
 * - OPENAI_HUMANIZE_REPLIES (optional; default on when OPENAI_API_KEY is set)
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
const OPENAI_HUMANIZE_TEMPERATURE = 0.72;
const OPENAI_HUMANIZE_MAX_TOKENS = 160;

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
    assistancePhoneNumber: '3795063578',
  },
  {
    displayName: 'Resistencia',
    match: [
      'resistencia',
      'resitencia',
      'resis',
      'ress',
      'resi',
      'immi',
      'instituto modelo de medicina infantil',
      'instituto modelo medicina infantil',
      'modelo de medicina infantil',
      'rcia',
      'capital chaco',
      'capital del chaco',
      'chaco',
    ],
    envKey: 'CALENDLY_RESISTENCIA',
    optionNumber: '2',
    assistancePhoneNumber: '3624571222',
  },
  {
    displayName: 'Formosa',
    match: [
      'formosa',
      'formoza',
      'fsa',
      'gastroenterologia',
      'gastroenterología',
      'instituto de gastroenterologia',
      'instituto de gastroenterología',
    ],
    envKey: 'REFERRAL_FORMOSA',
    optionNumber: '3',
    bookingViaReferralOnly: true,
    referralPhoneNumber: '3704445096',
  },
  {
    displayName: 'Sáenz Peña',
    match: [
      'saenz pena',
      'saenz peña',
      'saens pena',
      'saenzpena',
      'santa maria',
      'santa maría',
      'clinica santa maria',
      'clínica santa maría',
      'presidencia roca',
      'presidente roca',
      'pcia roca',
      'saenz',
    ],
    envKey: 'REFERRAL_SAENZ_PENA',
    optionNumber: '4',
    bookingViaReferralOnly: true,
    referralPhoneNumber: '36415314019',
  },
];

const FORMOSA_REFERRAL_PHONE_NUMBER = '3704445096';
const SAENZ_PENA_REFERRAL_PHONE_NUMBER = '36415314019';
const ALL_SEDE_CITIES_LIST_MESSAGE = 'Corrientes, Resistencia, Formosa o Sáenz Peña';
const ACTIVE_SEDE_OPTIONS_MESSAGE = `¿Desde qué ciudad te consultás? ${ALL_SEDE_CITIES_LIST_MESSAGE}. Para turno online por acá: 1 Corrientes o 2 Resistencia 😊`;
const ACTIVE_SEDE_CITIES_LIST_MESSAGE = ALL_SEDE_CITIES_LIST_MESSAGE;
const LEGACY_SEDE_OPTION_RESPONSE_MESSAGE =
  'Podés escribir 1 para Corrientes, 2 para Resistencia, o el nombre de tu ciudad (Formosa o Sáenz Peña). ¿Cuál elegís?';

const OUT_OF_COVERAGE_CITY_NORMALIZED_SUBSTRINGS = [
  'buenos aires',
  'bs as',
  'bsas',
  'capital federal',
  'caba',
  'la plata',
  'cordoba',
  'rosario',
  'mendoza',
  'tucuman',
  'salta',
  'neuquen',
  'mar del plata',
  'bahia blanca',
];

/** Normalized substrings; must match after normalizeForMatch (no accents). */
const CRITICAL_EMERGENCY_NORMALIZED_SUBSTRINGS = [
  'no puedo respirar',
  'me falta el aire',
  'me ahogo',
  'me estoy quedando sin aire',
  'me hincho la garganta',
  'se me hincho la garganta',
  'se me cerro la garganta',
  'se le cerro la garganta',
  'se cerro la garganta',
  'me hincho la cara',
  'se me hincho la cara',
  'reaccion alergica fuerte',
  'me desmaye',
  'se desmayo',
  'se desmayo',
  'se descompenso',
  'se descompenso',
  'me pico una abeja',
  'me pico una avispa',
  'anafilaxia',
  'anafilaxis',
  'shock',
  'shock anafilactico',
  'shock anafilactico',
  'adrenalina',
  'epipen',
  'epi pen',
  'emergencia medica',
  'urgencia medica',
];

const AMBIGUOUS_URGENCY_NORMALIZED_SUBSTRINGS = [
  'emergencia',
  'urgencia',
  'urgente',
  'necesito rapido',
  'necesito rápido',
  'lo antes posible',
  'caso critico',
  'caso crítico',
  'critico',
  'crítico',
  'es urgente',
  'es una emergencia',
];

const MEDICAL_EMERGENCY_RESPONSE_MESSAGE =
  'El Dr. no atiende urgencias. Si es una emergencia o urgencia, por favor acudí a la guardia/urgencias más cercana o llamá al 107 ahora.';
const AMBIGUOUS_URGENCY_CLARIFICATION_MESSAGE =
  '¿Es una urgencia médica o necesitás turno lo antes posible?';

const DEFAULT_RESPONSE_DELAY_MS = 3500;
const MAX_LEVENSHTEIN_DISTANCE = 3;

const MESSAGE_COLLECTION_WINDOW_MS = 6000;
const SMALL_TALK_COOLDOWN_MS = 20000;
const BOOKING_LINK_OFFER_OPTOUT_MS = 45 * 60 * 1000;
const PRICE_OBJECTION_CONTEXT_WINDOW_MS = 30 * 60 * 1000;
const BOOKING_LINK_OFFER_REPEAT_COOLDOWN_MS = 8 * 60 * 1000;
const BOOKING_LINK_RECENTLY_SENT_MS = 60 * 60 * 1000;
const BOOKING_LINK_TROUBLE_FOLLOWUP_WINDOW_MS = 10 * 60 * 1000;
const WAITLIST_CONFIRMATION_WINDOW_MS = 30 * 60 * 1000;
const URGENCY_CLARIFICATION_WINDOW_MS = 10 * 60 * 1000;
const SEDE_SELECTION_WINDOW_MS = 30 * 60 * 1000;
const SYMPTOM_DURATION_WINDOW_MS = 30 * 60 * 1000;
const STUDY_TYPE_FOR_PRICE_WINDOW_MS = 30 * 60 * 1000;
const STUDY_PRICE_HEALTH_INSURANCE_WINDOW_MS = 30 * 60 * 1000;
const STUDY_PRICE_FOLLOW_UP_WINDOW_MS = 30 * 60 * 1000;
const PENDING_BOOKING_INTENT_WINDOW_MS = 30 * 60 * 1000;
const PENDING_PRIVATE_PRICE_INTENT_WINDOW_MS = 30 * 60 * 1000;
const PENDING_CONSULTATION_PRICE_INTENT_WINDOW_MS = 30 * 60 * 1000;
const CONSULTATION_PRICE_HEALTH_INSURANCE_WINDOW_MS = 30 * 60 * 1000;
const CONSULTATION_PRICE_ANSWERED_WINDOW_MS = 30 * 60 * 1000;
const HEALTH_INSURANCE_DISCUSSION_WINDOW_MS = 30 * 60 * 1000;
const PATIENT_REPLY_MAX_RECOMMENDED_LENGTH = 180;
const KNOWN_NOT_ACCEPTED_HEALTH_INSURANCE_CANONICAL_NAMES = ['PAMI'];
const LAST_BOT_REPLY_TEXT_MAX_LENGTH = 500;
const SCHEDULE_DISCUSSION_WINDOW_MS = 30 * 60 * 1000;
const PREFERRED_DAY_BOOKING_WINDOW_MS = 30 * 60 * 1000;

const WEEKDAY_NORMALIZED_NAMES = [
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
  'domingo',
];
const VIRTUAL_VISIT_CONFIRMATION_WINDOW_MS = 30 * 60 * 1000;
const CONVERSATION_CLOSED_GRACE_WINDOW_MS = 10 * 60 * 1000;
const NON_TEXT_WRITE_IT_DOWN_COOLDOWN_MS = 2 * 60 * 1000;
const SENSITIVE_DATA_WARNING_COOLDOWN_MS = 10 * 60 * 1000;
const INBOUND_MESSAGE_DEDUPLICATION_TTL_MS = 2 * 60 * 60 * 1000;
const INBOUND_MESSAGE_STALE_AFTER_MS = 45 * 60 * 1000;
const USER_REPLY_COOLDOWN_MS = 6000;

const STUDIES_INFORMATION_MESSAGE =
  'Sí, según el caso el Dr. puede indicar y/o coordinar estudios como tests de alergia (Prick Test), espirometría, laboratorio y test del parche.';
const STUDIES_TO_BRING_MESSAGE =
  'Si ya te realizaste estudios (por ejemplo espirometría, análisis o informes de alergia), sí: traé los resultados o informes que tengas, aunque sean de otro centro. También conviene llevar DNI y, si tenés obra social, credencial y orden de consulta o prácticas autorizadas si te las dieron.';
const STUDIES_CHILD_TO_BRING_MESSAGE =
  'Si tu hijo/a ya se realizó estudios (espirometría, análisis o informes de alergia), sí: traé los resultados que tengan, aunque sean de otro centro. También conviene llevar DNI del menor y, si tienen obra social, credencial y orden o prácticas autorizadas.';
const STUDIES_MEDICAL_HISTORY_TO_BRING_MESSAGE =
  'Sí: si tenés informes de otro médico, historia clínica o resultados de estudios anteriores, traélos. También DNI y, si tenés obra social, credencial y orden si te la dieron.';
const STUDIES_NO_PRIOR_STUDIES_MESSAGE =
  'No hay problema: podés venir igual. El Dr. evalúa tu caso en consulta y ahí ve qué hace falta. Traé DNI y, si tenés obra social, credencial y orden si te la dieron.';
const STUDIES_CHILD_NO_PRIOR_STUDIES_MESSAGE =
  'No hay problema: podés venir igual con tu hijo/a. El Dr. evalúa en consulta y ahí ve qué hace falta. Traé DNI del menor y, si tienen obra social, credencial y orden si la dieron.';
const STUDIES_WILL_BE_REQUESTED_MESSAGE =
  'Depende de tu caso: eso lo define el Dr. en la consulta de evaluación. No siempre se piden estudios antes; a veces se coordinan después de ver al paciente.';
const STUDIES_DIGITAL_RESULTS_MESSAGE =
  'Sí, podés traer fotos o PDF en el celular para mostrar en consulta. Por este chat no conviene enviar informes ni datos personales.';
const STUDIES_SENT_FOR_STUDIES_BEFORE_VISIT_MESSAGE =
  'Si otro médico te indicó estudios, traé la orden o informe que te hayan dado y los resultados si ya los tenés. En la consulta el Dr. los revisa y ve si hace falta algo más.';
const STUDY_PRICE_WITH_CONSULTATION_ARS = 30000;
const STANDALONE_SPIROMETRY_PRICE_ARS = 40000;
const INSURANCE_NAMES_WITH_INCLUDED_STUDY_IN_CONSULTATION = ['OSDE', 'Sancor', 'Isunne'];

const DOCUMENTATION_REQUIREMENTS_MESSAGE =
  'Si tenés obra social: traé orden de consulta y las prácticas autorizadas. Si no: podés venir igual. ¿Te sirve?';

const NO_REFERRAL_REQUIRED_MESSAGE = 'No necesitás derivación ni receta. ¿Te sirve?';

const AUTHORIZATION_AND_DIGITAL_CARD_MESSAGE =
  'Sí, atendemos con autorización y aceptamos credencial digital. ¿Te sirve?';

const INVOICE_MESSAGE = 'Sí, damos factura. ¿Te sirve?';

const PAYMENT_METHODS_MESSAGE =
  'Podés pagar en efectivo o por transferencia/QR. Tarjeta y débito no. ¿Te sirve?';

const CONSULT_DURATION_MESSAGE = 'Depende del caso. ¿Te sirve?';

const COMPANION_ALLOWED_MESSAGE = 'Sí, podés ir con acompañante. ¿Te sirve?';

const OTHER_PROVINCES_MESSAGE = 'No atendemos en otras provincias. ¿Te sirve?';

const VIRTUAL_VISITS_MESSAGE = 'Sí, trabajamos con modalidad virtual. ¿Te sirve?';

const STUDY_FASTING_MESSAGE = 'No, no hace falta ir en ayunas.';

const STUDY_PREPARATION_MEDICATION_MESSAGE =
  'Para test de alergia: suspender antialérgicos 48 hs antes y corticoides 1 semana antes. Para espirometría: no aplicar aerosoles ese día.';

const SPIROMETRY_PREPARATION_MESSAGE =
  'Para la espirometría: no hace falta ir en ayunas y ese día no apliques aerosoles (inhaladores de rescate). Traé DNI y, si tenés obra social, credencial y orden si te la dieron.';

const STUDY_DURATION_MESSAGE = 'Depende del caso.';

const MEDICATION_ALLERGY_STUDY_MESSAGE =
  'Para test de alergia a medicamentos, primero se realiza la consulta con el médico; según el medicamento se define el protocolo.';

const SEDE_LOCATION_ONLY_BY_ENV_KEY = {
  CALENDLY_CORRIENTES: 'Clínica del Pilar: San Martín 555.',
  CALENDLY_RESISTENCIA: 'Resistencia (Instituto Modelo de Medicina Infantil): F. Ameghino 678.',
  REFERRAL_FORMOSA: 'Instituto Modelo de Gastroenterología: Maipú 1580, Formosa Capital.',
  REFERRAL_SAENZ_PENA: 'Instituto Privado Santa María (Clínica Santa María): Chacabuco 634, Presidencia Roque Sáenz Peña.',
};

const SEDE_CLINIC_HOURS_BY_ENV_KEY = {
  CALENDLY_CORRIENTES:
    'Lunes, jueves y viernes 9:45 a 11:00 hs y 17:00 a 20:00 hs. Martes 17:00 a 20:00 hs.',
  CALENDLY_RESISTENCIA: 'Martes 9:30 a 12:00.',
};

const SEDE_MAPS_URL_BY_ENV_KEY = {
  CALENDLY_CORRIENTES:
    'https://google.com/maps/place/Cl%C3%ADnica+del+Pilar/data=!4m2!3m1!1s0x0:0x49146846c8c3ca7a?sa=X&ved=1t:2428&ictx=111',
  CALENDLY_RESISTENCIA:
    'https://www.google.com/maps/place/Immi,+Instituto+Modelo+de+Medicina+Infantil/@-27.4595693,-58.9866954,736m/data=!3m2!1e3!4b1!4m6!3m5!1s0x94450cedd359d8f5:0xefe1f0c59533241e!8m2!3d-27.4595741!4d-58.9841205!16s%2Fg%2F1tfczxpj?entry=ttu&g_ep=EgoyMDI2MDQyMi4wIKXMDSoASAFQAw%3D%3D',
};

const CORRIENTES_HOW_TO_ARRIVE_MESSAGE =
  'Corrientes: ingresá a la Clínica del Pilar, subí al primer piso por la escalera negra y consultá con la primera secretaria.';

const KNOWN_CLINIC_ADDRESS_NORMALIZED_FRAGMENTS = [
  'san martin 555',
  'clinica del pilar',
  'ameghino 678',
  'instituto modelo de medicina infantil',
  'f ameghino 678',
  'maipu 1580',
  'instituto modelo de gastroenterologia',
  'chacabuco 634',
  'clinica santa maria',
  'instituto privado santa maria',
];

const CORRIENTES_ASSISTANCE_PHONE_NUMBER = '3795063578';
const RESISTENCIA_ASSISTANCE_PHONE_NUMBER = '3624571222';
const ALL_CLINIC_ASSISTANCE_PHONE_NUMBERS = [
  CORRIENTES_ASSISTANCE_PHONE_NUMBER,
  RESISTENCIA_ASSISTANCE_PHONE_NUMBER,
];

function isReferralOnlySedeEntry(sedeEntry) {
  return Boolean(sedeEntry && sedeEntry.bookingViaReferralOnly);
}

function resolveReferralPhoneNumberForSedeEntry(sedeEntry) {
  if (!sedeEntry) return null;
  if (typeof sedeEntry.referralPhoneNumber === 'string' && sedeEntry.referralPhoneNumber.trim().length > 0) {
    return sedeEntry.referralPhoneNumber.trim();
  }
  if (sedeEntry.displayName === 'Formosa') return FORMOSA_REFERRAL_PHONE_NUMBER;
  if (sedeEntry.displayName === 'Sáenz Peña') return SAENZ_PENA_REFERRAL_PHONE_NUMBER;
  return null;
}

function buildReferralOnlySedeBookingReply(sedeEntry) {
  const cityLabel = sedeEntry && sedeEntry.displayName ? sedeEntry.displayName : 'esa sede';
  const phoneNumber = resolveReferralPhoneNumberForSedeEntry(sedeEntry);
  if (!phoneNumber) {
    return `Para turnos en ${cityLabel}, comunicate con el equipo de esa sede. Por esta línea solo se reserva online en Corrientes y Resistencia con el link de agenda.`;
  }
  return `Para turnos en ${cityLabel}, comunicate con el equipo de esa sede al ${phoneNumber}. Por esta línea solo se reserva online en Corrientes y Resistencia con el link de agenda.`;
}

function stateHasRecentReferralSedeBookingContext(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (!isReferralOnlySedeEntry(lastSede)) return false;
  const lastSedeAt = Number(priorState.lastSedeAtMs);
  if (!Number.isFinite(lastSedeAt) || Date.now() - lastSedeAt > SEDE_SELECTION_WINDOW_MS) return false;
  const referralPhone = resolveReferralPhoneNumberForSedeEntry(lastSede);
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  if (referralPhone && lastBotReplyText.includes(referralPhone)) return true;
  return (
    stateHasPendingBookingIntent(priorState) ||
    stateHasRecentBookingConversationContext(priorState)
  );
}

function resolveReferralSedeForConversationFollowUp(priorState, bodyText) {
  const sedeFromMessage = findSedeFromText(bodyText);
  if (sedeFromMessage && isReferralOnlySedeEntry(sedeFromMessage)) return sedeFromMessage;
  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (!isReferralOnlySedeEntry(lastSede)) return null;
  if (!stateHasRecentReferralSedeBookingContext(priorState)) return null;
  if (
    !messageLooksLikeSpecificSlotBookingRequest(bodyText) &&
    !messageLooksLikeBookingIntent(bodyText) &&
    !messageLooksLikeRealtimeAvailabilityQuestion(bodyText) &&
    !messageLooksLikeTreatmentAppointmentRequest(bodyText)
  ) {
    return null;
  }
  return lastSede;
}

function buildReferralOnlySedeSlotFollowUpReply(sedeEntry, rawText = '') {
  const phoneReply = buildReferralOnlySedeBookingReply(sedeEntry);
  if (!rawText || !messageLooksLikeSpecificSlotBookingRequest(rawText)) return phoneReply;
  const relativeDayLabel = extractRelativeDayLabelFromText(rawText);
  const weekdayName = extractWeekdayNameFromText(rawText);
  const includesTime = messageIncludesSpecificAppointmentTime(rawText);
  const cityLabel = sedeEntry.displayName;
  let prefix = `Entiendo que te gustaría turno en ${cityLabel}`;
  if (relativeDayLabel) {
    prefix = `Entiendo que te gustaría para ${relativeDayLabel} en ${cityLabel}`;
  } else if (weekdayName) {
    prefix = `Entiendo que te gustaría el ${weekdayName} en ${cityLabel}`;
  }
  if (includesTime) {
    prefix += ' a esa hora';
  }
  prefix += '. Por acá no confirmamos horarios puntuales ni agendamos.';
  return `${prefix} ${phoneReply}`;
}

function resolveClinicAssistancePhoneNumberForSedeEntry(sedeEntry) {
  if (!sedeEntry) return CORRIENTES_ASSISTANCE_PHONE_NUMBER;
  if (isReferralOnlySedeEntry(sedeEntry)) {
    return resolveReferralPhoneNumberForSedeEntry(sedeEntry) || CORRIENTES_ASSISTANCE_PHONE_NUMBER;
  }
  if (typeof sedeEntry.assistancePhoneNumber === 'string' && sedeEntry.assistancePhoneNumber.trim().length > 0) {
    return sedeEntry.assistancePhoneNumber.trim();
  }
  if (sedeEntry.displayName === 'Resistencia') return RESISTENCIA_ASSISTANCE_PHONE_NUMBER;
  if (sedeEntry.displayName === 'Corrientes') return CORRIENTES_ASSISTANCE_PHONE_NUMBER;
  return CORRIENTES_ASSISTANCE_PHONE_NUMBER;
}

function resolveClinicAssistancePhoneNumberFromContext(priorState = null, sedeEntry = null) {
  const lastSede =
    sedeEntry || resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  return resolveClinicAssistancePhoneNumberForSedeEntry(lastSede);
}

function buildBookingPersonalAssistanceMessage(priorState = null, sedeEntry = null) {
  const phoneNumber = resolveClinicAssistancePhoneNumberFromContext(priorState, sedeEntry);
  return `Si necesitás ayuda, podés comunicarte al ${phoneNumber}.`;
}

function replyTextIncludesClinicAssistancePhoneNumber(replyText) {
  if (!replyText || typeof replyText !== 'string') return false;
  const normalized = normalizeForMatch(replyText);
  return ALL_CLINIC_ASSISTANCE_PHONE_NUMBERS.some((phoneNumber) => normalized.includes(phoneNumber));
}

const DERIVATIVE_HANDOFF_PATIENT_MESSAGE =
  'Si preferís, te paso con alguien del equipo para que te ayude. En breve te contactan.';

const MISSING_INFORMATION_CALL_OFFICE_MESSAGE =
  'No cuento con esa información en este momento. Por favor, llamá al consultorio y te lo confirman.';

const FALLBACK_AGENTE_LIBER_SYSTEM_PROMPT =
  'Sos la asistente del consultorio del Dr. Liber Acosta (alergista). Respondé en español argentino, texto plano, sin markdown ni asteriscos, máximo 2 oraciones. No des diagnósticos ni montos. Sedes: Corrientes, Resistencia, Formosa y Sáenz Peña; turno online solo en Corrientes y Resistencia. Reglas completas no cargadas en el servidor.';

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

function tokenizeNormalizedText(normalizedText) {
  return String(normalizedText || '')
    .replace(/[!?.,;:()"'`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function normalizedTextContainsApproxWord(normalizedText, targetWord, maxDistance = 1) {
  const normalizedTargetWord = normalizeForMatch(targetWord);
  if (!normalizedTargetWord) return false;
  const normalizedSourceText = String(normalizedText || '');
  if (normalizedSourceText.includes(normalizedTargetWord)) return true;
  const sourceTokens = tokenizeNormalizedText(normalizedSourceText);
  for (const sourceToken of sourceTokens) {
    const lengthDifference = Math.abs(sourceToken.length - normalizedTargetWord.length);
    if (lengthDifference > maxDistance) continue;
    const distance = computeLevenshteinDistance(sourceToken, normalizedTargetWord);
    if (Number.isFinite(distance) && distance <= maxDistance) return true;
  }
  return false;
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
  // If the message contains another intent, treat it as a real request (not just a greeting).
  if (messageLooksLikeHealthInsurancePlusQuestion(rawText)) return false;
  if (messageLooksLikePrivatePriceQuestion(rawText)) return false;
  if (messageLooksLikeBookingIntent(rawText) || messageExplicitlyRequestsBookingLink(rawText)) return false;
  if (messageMatchesStudiesTopic(rawText)) return false;
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
  const wordCount = normalized.split(' ').filter(Boolean).length;
  if (wordCount <= 3) return true;
  // Accept composite greeting + small talk as "greeting-only" (e.g., "buenos dias como estas").
  if (
    /^(hola|buenas|buenos dias|buen dia|buenas tardes|buenas noches)\b/.test(normalized) &&
    /\b(como estas|que tal|todo bien|como va)\b/.test(normalized) &&
    wordCount <= 8
  ) {
    return true;
  }
  return false;
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
    normalized.startsWith('qué tal ') ||
    /\btodo bien\b/.test(normalized) ||
    /\bcomo va\b/.test(normalized)
  );
}

function messageLooksLikeFragment(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageLooksLikeBookingIntent(rawText) || messageExplicitlyRequestsBookingLink(rawText)) return false;
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
  return 'Cualquier duda que te surja, escribime.';
}

function messageLooksLikeSedeOnlyAnswer(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (!findSedeFromText(rawText)) return false;
  if (
    messageLooksLikeAnyPriceQuestion(rawText) ||
    messageMatchesStudiesTopic(rawText) ||
    messageLooksLikeHealthInsurancePlusQuestion(rawText) ||
    messageLooksLikeBookingIntent(rawText) ||
    messageExplicitlyRequestsBookingLink(rawText)
  ) {
    return false;
  }
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const wordCount = normalized.split(' ').filter(Boolean).length;
  return wordCount <= 4;
}

function stateConflictsWithSedeOnlyAnswer(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  return (
    priorState.state === 'awaiting_study_price_health_insurance' ||
    priorState.state === 'awaiting_health_insurance_name' ||
    priorState.state === 'awaiting_study_type_for_price' ||
    priorState.state === 'awaiting_health_insurance_plan'
  );
}

function buildClearedStudyPricingContextPatch() {
  return {
    lastStudyType: null,
    lastStudyPriceContextAtMs: null,
    awaitingStudyTypeForPriceAtMs: null,
    awaitingStudyPriceHealthInsuranceAtMs: null,
  };
}

function nextStateExplicitlyClearsStudyPricingContext(nextState) {
  if (!nextState || typeof nextState !== 'object') return false;
  return (
    (Object.prototype.hasOwnProperty.call(nextState, 'lastStudyType') && nextState.lastStudyType == null) ||
    (Object.prototype.hasOwnProperty.call(nextState, 'lastStudyPriceContextAtMs') &&
      nextState.lastStudyPriceContextAtMs == null)
  );
}

function findSedeFromText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  const normalized = normalizeForMatch(rawText);

  if (/^[12]$/.test(trimmed)) {
    const index = parseInt(trimmed, 10) - 1;
    return SEDE_ENTRIES[index] || null;
  }

  for (const entry of SEDE_ENTRIES) {
    for (const keyword of entry.match) {
      if (/^[12]$/.test(keyword)) continue;
      const keyNorm = normalizeForMatch(keyword);
      if (normalized === keyNorm || normalized.includes(keyNorm)) {
        return entry;
      }
    }
  }

  const withoutLeadingInitial = normalized.replace(/^[a-z]\s+/, '');
  if (withoutLeadingInitial !== normalized) {
    for (const entry of SEDE_ENTRIES) {
      for (const keyword of entry.match) {
        if (/^[12]$/.test(keyword)) continue;
        const keyNorm = normalizeForMatch(keyword);
        if (withoutLeadingInitial === keyNorm || withoutLeadingInitial.includes(keyNorm)) {
          return entry;
        }
      }
    }
  }

  const compactTokens = normalized
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (compactTokens.length > 0 && compactTokens.length <= 2) {
    const compactText = compactTokens.join(' ');
    if (compactText.length >= 3 && compactText.length <= 8) {
      if (
        normalizedTextContainsApproxWord(compactText, 'resistencia', 2) ||
        normalizedTextContainsApproxWord(compactText, 'resis', 1)
      ) {
        return SEDE_ENTRIES.find((entry) => entry.displayName === 'Resistencia') || null;
      }
      if (
        normalizedTextContainsApproxWord(compactText, 'corrientes', 2) ||
        normalizedTextContainsApproxWord(compactText, 'ctes', 1)
      ) {
        return SEDE_ENTRIES.find((entry) => entry.displayName === 'Corrientes') || null;
      }
    }
  }

  return null;
}

function messageLooksLikePossibleSedeTypoAnswer(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (
    messageLooksLikeAnyPriceQuestion(rawText) ||
    messageMatchesStudiesTopic(rawText) ||
    messageLooksLikeHealthInsurancePlusQuestion(rawText) ||
    messageLooksLikeBookingIntent(rawText) ||
    messageExplicitlyRequestsBookingLink(rawText) ||
    messageAsksGenericConsultationPrice(rawText)
  ) {
    return false;
  }
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const wordCount = normalized.split(' ').filter(Boolean).length;
  const sedeFromText = findSedeFromText(rawText);
  if (sedeFromText && wordCount <= 5) return true;
  if (wordCount > 3) return false;
  return (
    normalizedTextContainsApproxWord(normalized, 'resistencia', 2) ||
    normalizedTextContainsApproxWord(normalized, 'resis', 1) ||
    normalizedTextContainsApproxWord(normalized, 'corrientes', 2) ||
    normalizedTextContainsApproxWord(normalized, 'ctes', 1)
  );
}

function messageConflictsWithSedeSelectionReprompt(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  return (
    messageLooksLikeAnyPriceQuestion(rawText) ||
    messageMatchesStudiesTopic(rawText) ||
    messageLooksLikeHealthInsurancePlusQuestion(rawText) ||
    (messageLooksLikeBookingIntent(rawText) && !messageLooksLikePossibleSedeTypoAnswer(rawText)) ||
    messageExplicitlyRequestsBookingLink(rawText) ||
    textMatchesMedicalEmergency(rawText)
  );
}

function messageAlreadyStatesSymptomDuration(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    /\bhace\s+\d+\s+(anos|años|mes|meses|semanas|dias|días)\b/.test(normalized) ||
    normalized.includes('desde hace') ||
    normalized.includes('hace mucho') ||
    normalized.includes('hace anos') ||
    normalized.includes('hace años')
  );
}

function messageHasClinicalAdministrativeQuestions(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    (String(rawText).match(/\?/g) || []).length > 0 ||
    messageMatchesStudiesTopic(rawText) ||
    messageLooksLikeAnyPriceQuestion(rawText) ||
    messageLooksLikeHealthInsurancePlusQuestion(rawText) ||
    Boolean(findSedeFromText(rawText)) ||
    Boolean(tryExtractHealthInsuranceName(rawText)) ||
    normalized.includes('ayunas') ||
    normalized.includes('la hacen') ||
    normalized.includes('hacen la') ||
    messageAsksWhetherDoctorPerformsStudy(rawText)
  );
}

function messageLooksLikeComplexClinicalInquiry(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const administrativeSignals = [
    Boolean(findSedeFromText(rawText)),
    Boolean(tryExtractHealthInsuranceName(rawText)),
    messageLooksLikeAnyPriceQuestion(rawText),
    messageLooksLikeHealthInsurancePlusQuestion(rawText),
  ].filter(Boolean).length;
  const clinicalStudySignals = [
    messageMatchesStudiesTopic(rawText),
    messageMentionsSpirometryStudy(rawText),
    normalized.includes('ayunas'),
    normalized.includes('la hacen'),
    normalized.includes('hacen espirometr'),
    messageAsksWhetherDoctorPerformsStudy(rawText),
  ].filter(Boolean).length;
  const questionCount = (String(rawText).match(/\?/g) || []).length;
  return (administrativeSignals >= 1 && clinicalStudySignals >= 1) || questionCount >= 3;
}

function messageDescribesChronicOrQualifiedBreathingSymptom(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  if (
    normalized.includes('no puedo respirar bien') ||
    normalized.includes('no respiro bien') ||
    normalized.includes('me cuesta respirar') ||
    normalized.includes('dificultad para respirar') ||
    normalized.includes('problemas para respirar') ||
    normalized.includes('problema para respirar') ||
    normalized.includes('me despierto de noche porque no puedo respirar')
  ) {
    return true;
  }
  return (
    normalized.includes('vivo congestionado') ||
    normalized.includes('vivo congestionada') ||
    messageAlreadyStatesSymptomDuration(rawText)
  );
}

function shouldSkipMedicalEmergencyDetectionForMessage(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageLooksLikeComplexClinicalInquiry(rawText)) return true;
  if (messageDescribesChronicOrQualifiedBreathingSymptom(rawText)) return true;
  if (messageAlreadyStatesSymptomDuration(rawText) && messageHasClinicalAdministrativeQuestions(rawText)) {
    return true;
  }
  return false;
}

function textMatchesMedicalEmergency(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (shouldSkipMedicalEmergencyDetectionForMessage(rawText)) return false;
  const normalized = normalizeForMatch(rawText);
  for (const phrase of CRITICAL_EMERGENCY_NORMALIZED_SUBSTRINGS) {
    if (phrase === 'no puedo respirar') {
      if (
        normalized.includes('no puedo respirar bien') ||
        normalized.includes('no puedo respirar de noche') ||
        normalized.includes('me despierto de noche porque no puedo respirar')
      ) {
        continue;
      }
    }
    if (normalized.includes(phrase)) return true;
  }
  return false;
}

function messageLooksLikeAmbiguousUrgency(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  if (textMatchesMedicalEmergency(rawText)) return false;
  if (messageConfirmsMedicalEmergencyFromClarification(rawText)) return false;
  for (const phrase of AMBIGUOUS_URGENCY_NORMALIZED_SUBSTRINGS) {
    if (normalized.includes(phrase)) return true;
  }
  return false;
}

function buildAwaitingUrgencyClarificationStatePatch() {
  return {
    state: 'awaiting_urgency_clarification',
    awaitingUrgencyClarificationAtMs: Date.now(),
  };
}

function stateLooksLikeAwaitingUrgencyClarification(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.state !== 'awaiting_urgency_clarification') return false;
  const askedAtMs = Number(state.awaitingUrgencyClarificationAtMs);
  return Number.isFinite(askedAtMs) && Date.now() - askedAtMs <= URGENCY_CLARIFICATION_WINDOW_MS;
}

function messageConfirmsMedicalEmergencyFromClarification(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  if (textMatchesMedicalEmergency(rawText)) return true;
  if (normalized.includes('urgencia medica') || normalized.includes('emergencia medica')) return true;
  if (normalized === 'urgencia' || normalized === 'emergencia') return true;
  if (normalized.includes('si es urgencia') || normalized.includes('si es emergencia')) return true;
  if (normalized.includes('es urgencia medica') || normalized.includes('es emergencia medica')) return true;
  if (normalized.includes('si urgencia') || normalized.includes('si emergencia')) return true;
  return false;
}

function messageConfirmsUrgentBookingPriority(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageConfirmsMedicalEmergencyFromClarification(rawText)) return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    normalized.includes('turno') ||
    normalized.includes('lo antes posible') ||
    normalized.includes('no es urgencia') ||
    normalized.includes('no es emergencia') ||
    normalized.includes('solo turno') ||
    normalized.includes('solo necesito turno') ||
    normalized.includes('necesito turno') ||
    normalized.includes('agendar') ||
    normalized.includes('agenda')
  );
}

async function tryResolveUrgencyClarificationAnswerWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense.',
    'Contexto: el asistente preguntó si es URGENCIA MÉDICA (ir a guardia/107) o si solo necesita TURNO lo antes posible.',
    'Respondé solo una palabra: EMERGENCY, BOOKING o UNCLEAR.',
    'EMERGENCY: confirma emergencia/urgencia médica real (ej. "urgencia médica", "sí es emergencia", "es urgencia").',
    'BOOKING: quiere turno rápido sin emergencia (ej. "solo turno", "lo antes posible", "no es urgencia", "necesito agendar").',
    'UNCLEAR: no responde la pregunta o no se entiende.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage: AMBIGUOUS_URGENCY_CLARIFICATION_MESSAGE,
    profileDisplayName: options.profileDisplayName,
  });
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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (normalized.startsWith('EMERGENCY')) return 'EMERGENCY';
    if (normalized.startsWith('BOOKING')) return 'BOOKING';
    if (normalized.startsWith('UNCLEAR')) return 'UNCLEAR';
    return null;
  } catch (error) {
    console.error('OpenAI urgency clarification classifier failed', error);
    return null;
  }
}

async function sendMedicalEmergencyResponse(from, priorState, profileDisplayName) {
  const emergencyWrapped = buildAutoReplyWithGreetingIfNeeded(
    MEDICAL_EMERGENCY_RESPONSE_MESSAGE,
    profileDisplayName,
    priorState
  );
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
      ...(emergencyWrapped.nextStatePatch || {}),
      state: undefined,
      awaitingUrgencyClarificationAtMs: undefined,
      ...buildLastBotReplyStatePatch(emergencyWrapped.messageText),
      lastBotReplyAtMs: Date.now(),
    })
  );
  await sendWhatsAppText(from, emergencyWrapped.messageText);
}

async function sendUrgentBookingPriorityReply(from, bodyText, priorState, profileDisplayName) {
  const clearedUrgencyState = mergeConversationStatePreservingGreeting(
    priorState,
    {
      state: undefined,
      awaitingUrgencyClarificationAtMs: undefined,
    },
    {
      ...buildFreshBookingWithoutSedeStatePatch(bodyText || 'necesito turno lo antes posible'),
      urgentBookingRequested: true,
    }
  );
  await setConversationState(from, clearedUrgencyState);
  if (
    await tryHandleBookingWithPatientContext(
      from,
      bodyText || 'necesito turno lo antes posible',
      clearedUrgencyState,
      profileDisplayName
    )
  ) {
    return;
  }
  await sendAskSedeTwoStep(
    from,
    profileDisplayName,
    clearedUrgencyState,
    'Entendido. Te ayudo a ver el turno más próximo según la agenda.'
  );
}

async function tryHandleAwaitingUrgencyClarification(from, bodyText, priorState, profileDisplayName) {
  if (!stateLooksLikeAwaitingUrgencyClarification(priorState)) return false;

  let decision = null;
  if (messageConfirmsMedicalEmergencyFromClarification(bodyText)) {
    decision = 'EMERGENCY';
  } else if (messageConfirmsUrgentBookingPriority(bodyText)) {
    decision = 'BOOKING';
  } else if (getOpenAiApiKey()) {
    decision = await tryResolveUrgencyClarificationAnswerWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
    });
  }

  if (decision === 'EMERGENCY') {
    await sendMedicalEmergencyResponse(from, priorState, profileDisplayName);
    return true;
  }
  if (decision === 'BOOKING') {
    await sendUrgentBookingPriorityReply(from, bodyText, priorState, profileDisplayName);
    return true;
  }

  const repeatWrapped = buildAutoReplyWithGreetingIfNeeded(
    'Perdón, no te entendí. ¿Es una urgencia médica (guardia/107) o necesitás turno lo antes posible?',
    profileDisplayName,
    priorState
  );
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(
      priorState,
      buildAwaitingUrgencyClarificationStatePatch(),
      {
        ...(repeatWrapped.nextStatePatch || {}),
        ...buildLastBotReplyStatePatch(repeatWrapped.messageText),
        lastBotReplyAtMs: Date.now(),
      }
    )
  );
  await sendWhatsAppText(from, repeatWrapped.messageText);
  return true;
}

function messageLooksLikeFarewell(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  // Never treat active intents as a farewell, even if they contain polite words.
  if (messageLooksLikeBookingIntent(rawText)) return false;
  if (messageExplicitlyRequestsBookingLink(rawText)) return false;
  if (messageLooksLikeHealthInsurancePlusQuestion(rawText)) return false;
  if (messageLooksLikePrivatePriceQuestion(rawText)) return false;
  if (messageLooksLikeScheduleAvailabilityQuestion(rawText)) return false;
  if (messageLooksLikeRealtimeAvailabilityQuestion(rawText)) return false;
  if (messageMatchesStudiesTopic(rawText)) return false;
  if (messageAsksAboutSedeAddressOrHowToArrive(rawText)) return false;
  if (messageIsGreeting(rawText)) return false;

  const wordCount = normalized.split(' ').filter(Boolean).length;
  if (wordCount > 6) return false;

  return (
    normalized === 'gracias' ||
    normalized === 'muchas gracias' ||
    normalized === 'ok gracias' ||
    normalized === 'gracias bye' ||
    normalized.includes('hasta luego') ||
    normalized === 'chau' ||
    normalized === 'ok chau' ||
    normalized === 'bye' ||
    normalized.includes('nos vemos') ||
    normalized.includes('que tengas buen dia') ||
    normalized.includes('que tengas buenas noches')
  );
}

function messageLooksLikeClosingAcknowledgement(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const tokens = tokenizeNormalizedText(normalized);
  const hasThanksToken =
    tokens.some((token) => token.includes('grac')) ||
    tokens.some((token) => computeLevenshteinDistance(token, 'gracias') <= 2);
  return (
    hasThanksToken ||
    normalized === 'ok' ||
    normalized === 'oka' ||
    normalized === 'listo' ||
    normalized === 'ya esta' ||
    normalized === 'ya está'
  );
}

function messageConfirmsAlreadyBooked(rawText, priorState = null) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const confirmsBooked = (
    normalized.includes('ya agende') ||
    normalized.includes('ya agendé') ||
    normalized.includes('ya saque turno') ||
    normalized.includes('ya saqué turno') ||
    normalized.includes('ya reserve') ||
    normalized.includes('ya reservé') ||
    normalized.includes('ya me anote') ||
    normalized.includes('ya me anoté') ||
    normalized === 'ya esta' ||
    normalized === 'ya está' ||
    normalized === 'ya esta listo' ||
    normalized === 'ya está listo' ||
    normalized === 'listo' ||
    normalized === 'listo ya esta' ||
    normalized === 'listo ya está' ||
    normalized.includes('listo ya agende') ||
    normalized.includes('listo ya agendé')
  );
  if (!confirmsBooked) return false;
  const hasAdditionalActiveIntent =
    messageLooksLikePrivatePriceQuestion(rawText) ||
    messageAsksAboutStudyPrice(rawText) ||
    messageLooksLikeHealthInsurancePlusQuestion(rawText) ||
    messageMatchesStudiesTopic(rawText) ||
    messageLooksLikeScheduleAvailabilityQuestion(rawText) ||
    messageExplicitlyRequestsBookingLink(rawText);
  if (hasAdditionalActiveIntent) return false;
  const hasBookingContext =
    wasBookingLinkSentRecently(priorState) ||
    stateLooksLikeAwaitingLinkConfirmation(priorState) ||
    (priorState &&
      typeof priorState === 'object' &&
      (priorState.state === 'awaiting_booking_link_sede' ||
        priorState.state === 'awaiting_sede_selection'));
  // Allow explicit "turno" confirmations even if context was lost.
  if (!hasBookingContext && !normalized.includes('turno')) return false;
  return true;
}

function buildAlreadyBookedReply(profileDisplayName) {
  const safeName =
    typeof profileDisplayName === 'string' && profileDisplayName.trim().length > 0
      ? profileDisplayName.trim()
      : null;
  if (safeName) {
    return `Qué bueno ${safeName}, te esperamos en el consultorio!`;
  }
  return 'Qué bueno, te esperamos en el consultorio!';
}

function messageLooksLikeChronicSymptomFrustration(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageLooksLikeComplexClinicalInquiry(rawText)) return false;
  if (messageAlreadyStatesSymptomDuration(rawText) && messageHasClinicalAdministrativeQuestions(rawText)) {
    return false;
  }
  if (textMatchesMedicalEmergency(rawText)) return false;
  const normalized = normalizeForMatch(rawText);
  const hasBookingContext =
    normalized.includes('agendar') ||
    normalized.includes('turno') ||
    normalized.includes('reserv') ||
    normalized.includes('link') ||
    normalized.includes('agenda');
  if (hasBookingContext) return false;
  const hasThroatPainSignal = normalizedTextContainsApproxWord(normalized, 'garganta', 2);
  const hasPainSignal =
    normalized.includes('dolor') ||
    normalized.includes('molesta') ||
    normalizedTextContainsApproxWord(normalized, 'duele', 1);
  const hasClinicalLimitationContext =
    normalized.includes('respirar') ||
    normalized.includes('dormir') ||
    normalized.includes('deporte') ||
    normalized.includes('cansancio') ||
    normalized.includes('congestion') ||
    normalized.includes('congestión') ||
    normalized.includes('pecho');
  return (
    normalized.includes('me duele todo') ||
    normalized.includes('me duele el cuerpo') ||
    normalized.includes('me duele la nariz') ||
    normalized.includes('me duele la garganta') ||
    normalized.includes('me duele mucho la garganta') ||
    normalized.includes('dolor de garganta') ||
    (hasThroatPainSignal && hasPainSignal) ||
    normalized.includes('me chorrea la nariz') ||
    normalized.includes('congestion') ||
    normalized.includes('congestión') ||
    normalized.includes('dolor en el pecho') ||
    normalized.includes('pecho cerrado') ||
    normalized.includes('dificultad para respirar') ||
    normalized.includes('hace anos') ||
    normalized.includes('hace años') ||
    normalized.includes('desde hace anos') ||
    normalized.includes('desde hace años') ||
    normalized.includes('probe de todo') ||
    normalized.includes('probé de todo') ||
    normalized.includes('los sintomas vuelven') ||
    normalized.includes('los síntomas vuelven') ||
    normalized.includes('noches sin dormir') ||
    normalized.includes('ojos pegados') ||
    (normalized.includes('no puedo') && hasClinicalLimitationContext) ||
    normalized.includes('dejo de') ||
    normalized.includes('cansancio') ||
    normalized.includes('mucho tiempo asi') ||
    normalized.includes('mucho tiempo así') ||
    normalized.includes('nada me funciona')
  );
}

function messageAsksWhyChooseDoctorOrTrustQuestion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (textMatchesMedicalEmergency(rawText)) return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;

  const asksWhyChooseDoctor =
    (normalized.includes('por que') || normalized.includes('porque')) &&
    (normalized.includes('atender') ||
      normalized.includes('elegir') ||
      normalized.includes('ir con') ||
      normalized.includes('consultar con') ||
      normalized.includes('ven con') ||
      normalized.includes('el dr') ||
      normalized.includes('el doctor') ||
      normalized.includes('liber'));

  const mentionsFailedPriorCare =
    normalized.includes('ya fui') ||
    normalized.includes('ya consult') ||
    normalized.includes('ninguno me solucion') ||
    normalized.includes('nadie me solucion') ||
    normalized.includes('no me solucion') ||
    normalized.includes('no me ayud') ||
    normalized.includes('probe varios') ||
    normalized.includes('probé varios') ||
    normalized.includes('varios alerg') ||
    normalized.includes('tres alerg') ||
    normalized.includes('otros medic') ||
    normalized.includes('otros alerg');

  const asksReputationOrExperience =
    normalized.includes('por que elegir') ||
    normalized.includes('que experiencia') ||
    normalized.includes('qué experiencia') ||
    normalized.includes('es bueno') ||
    normalized.includes('me recomendas') ||
    normalized.includes('me recomendás') ||
    normalized.includes('vale la pena') ||
    normalized.includes('confiar');

  if (asksWhyChooseDoctor) return true;
  if (
    mentionsFailedPriorCare &&
    (normalized.includes('alerg') || normalized.includes('dr') || normalized.includes('doctor'))
  ) {
    return true;
  }
  if (
    asksReputationOrExperience &&
    (normalized.includes('dr') || normalized.includes('doctor') || normalized.includes('liber'))
  ) {
    return true;
  }
  return false;
}

function buildDoctorTrustAndExperienceReply(rawText) {
  const normalized = normalizeForMatch(rawText);
  const mentionsPriorFailures =
    normalized.includes('ya fui') ||
    normalized.includes('ninguno me solucion') ||
    normalized.includes('no me solucion') ||
    normalized.includes('no me ayud') ||
    normalized.includes('tres alerg') ||
    normalized.includes('varios alerg') ||
    normalized.includes('probe varios') ||
    normalized.includes('probé varios');

  if (mentionsPriorFailures) {
    return 'Entiendo lo frustrante que es haber ido a varios alergistas sin mejora. El Dr. Liber Acosta es alergista e inmunólogo con más de 20 años en el NEA y en el turno evalúa tu caso a fondo para armar un plan personalizado.';
  }
  return 'El Dr. Liber Acosta es alergista e inmunólogo con más de 20 años de experiencia en el NEA; en la consulta evalúa cada caso en profundidad según estudios y síntomas.';
}

async function tryHandleDoctorTrustOrExperienceInquiry(from, bodyText, priorState, profileDisplayName) {
  if (!messageAsksWhyChooseDoctorOrTrustQuestion(bodyText)) return false;
  return sendFinalizedPatientTextReply(
    from,
    buildDoctorTrustAndExperienceReply(bodyText),
    priorState,
    profileDisplayName,
    {
      lastDoctorTrustInquiryAtMs: Date.now(),
      bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS,
    },
    {
      userMessage: bodyText,
      replyContext: 'doctor_trust',
      suppressBookingLinkOffer: true,
    }
  );
}

function messageLooksLikePriceObjection(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return (
    normalized.includes('muy caro') ||
    normalized.includes('re caro') ||
    normalized.includes('carisimo') ||
    normalized.includes('carísimo') ||
    normalized.includes('muchisimo') ||
    normalized.includes('muchísima') ||
    normalized.includes('demasiado caro') ||
    normalized.includes('es caro') ||
    normalized.includes('esta caro') ||
    normalized.includes('está caro') ||
    normalized.includes('un robo') ||
    normalized.includes('no puedo pagar') ||
    normalized.includes('no puedo gastar') ||
    normalized.includes('no me alcanza') ||
    normalized.includes('sale mucho') ||
    normalized.includes('es mucho') ||
    normalized.includes('mucho dinero') ||
    normalized.includes('monto elevado') ||
    (normalized.includes('como que') &&
      (normalized.includes('mil') ||
        normalized.includes('mas la consulta') ||
        normalized.includes('más la consulta') ||
        normalized.includes('consulta')))
  );
}

function messageLooksLikePatientDissatisfactionByRules(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (textMatchesMedicalEmergency(rawText)) return false;
  if (messageLooksLikeChronicSymptomFrustration(rawText) && !messageLooksLikePriceObjection(rawText)) {
    return false;
  }
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const priceObjection = messageLooksLikePriceObjection(rawText);
  const emotionalFrustration =
    normalized.includes('estoy enojad') ||
    normalized.includes('estoy molest') ||
    normalized.includes('me enoja') ||
    normalized.includes('me molesta mucho') ||
    normalized.includes('que bronca') ||
    normalized.includes('qué bronca') ||
    normalized.includes('indignad') ||
    normalized.includes('furios') ||
    normalized.includes('estoy hart') ||
    normalized.includes('pesimo') ||
    normalized.includes('pésimo') ||
    normalized.includes('malisimo') ||
    normalized.includes('malísimo') ||
    normalized.includes('un desastre') ||
    normalized.includes('que barbaridad') ||
    normalized.includes('qué barbaridad') ||
    normalized.includes('no puede ser') ||
    normalized.includes('increible') ||
    normalized.includes('increíble');
  return priceObjection || emotionalFrustration;
}

function priorStateLooksLikeRecentPriceOrPlusReply(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (stateHasRecentStudyPriceContext(priorState)) return true;
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText : '';
  if (!lastBotReplyText) return false;
  return (
    lastBotReplyText.includes('$') ||
    lastBotReplyText.includes('plus') ||
    lastBotReplyText.includes('consulta') ||
    lastBotReplyText.includes('espirometr')
  );
}

function buildPriceObjectionEmpathyReply() {
  return 'Entiendo que es un monto elevado y puede ser frustrante.';
}

function buildPriceObjectionPersonalAssistanceFollowUpReply(priorState) {
  const sedeEntry = resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  const phoneNumber = resolveClinicAssistancePhoneNumberFromContext(priorState, sedeEntry);
  if (sedeEntry && typeof sedeEntry.displayName === 'string' && sedeEntry.displayName.trim().length > 0) {
    return `Si querés una atención más personalizada, podés comunicarte con la clínica de ${sedeEntry.displayName.trim()} al ${phoneNumber}.`;
  }
  return `Si querés una atención más personalizada, podés comunicarte con la clínica al ${phoneNumber}.`;
}

function priorStateLooksLikeRecentPriceObjectionContext(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  const lastHandledAtMs = Number(priorState.lastPriceObjectionHandledAtMs);
  const lastDissatisfactionAtMs = Number(priorState.lastPatientDissatisfactionAtMs);
  const referenceAtMs = Number.isFinite(lastHandledAtMs)
    ? lastHandledAtMs
    : Number.isFinite(lastDissatisfactionAtMs)
      ? lastDissatisfactionAtMs
      : null;
  if (!Number.isFinite(referenceAtMs)) return false;
  if (Date.now() - referenceAtMs > PRICE_OBJECTION_CONTEXT_WINDOW_MS) return false;
  return (
    Number.isFinite(lastHandledAtMs) ||
    (priorStateLooksLikeRecentPriceOrPlusReply(priorState) && Number.isFinite(lastDissatisfactionAtMs))
  );
}

function messageAsksWhatOptionsOrHelpIsAvailable(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return (
    normalized.includes('que tenes para ofrecer') ||
    normalized.includes('que tienes para ofrecer') ||
    normalized.includes('que me ofreces') ||
    normalized.includes('que opciones') ||
    normalized.includes('que alternativas') ||
    normalized.includes('que mas podes') ||
    normalized.includes('que mas puedes') ||
    normalized.includes('que mas tenes') ||
    normalized.includes('que mas tienes') ||
    (normalized.includes('que tenes') && normalized.includes('ofrecer')) ||
    (normalized.includes('que tienes') && normalized.includes('ofrecer'))
  );
}

async function tryHandlePriceObjectionFollowUpInquiry(from, bodyText, priorState, profileDisplayName) {
  if (!priorStateLooksLikeRecentPriceObjectionContext(priorState)) return false;
  if (!messageAsksWhatOptionsOrHelpIsAvailable(bodyText)) return false;
  return deliverSequentialPatientTextMessages(
    from,
    [buildPriceObjectionPersonalAssistanceFollowUpReply(priorState)],
    priorState,
    profileDisplayName,
    {
      lastPriceObjectionFollowUpAtMs: Date.now(),
      bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS,
    }
  );
}

function stateLooksLikeAwaitingSymptomDuration(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.state === 'awaiting_symptom_duration' &&
    Number.isFinite(Number(state.symptomFirstAtMs))
  );
}

function stateLooksLikeAwaitingStudyTypeForPrice(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.state === 'awaiting_study_type_for_price' &&
    Number.isFinite(Number(state.awaitingStudyTypeForPriceAtMs))
  );
}

function stateLooksLikeAwaitingStudyPriceHealthInsurance(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.state === 'awaiting_study_price_health_insurance' &&
    Number.isFinite(Number(state.awaitingStudyPriceHealthInsuranceAtMs))
  );
}

function stateHasRecentStudyPriceContext(state) {
  return (
    state &&
    typeof state === 'object' &&
    typeof state.lastStudyType === 'string' &&
    state.lastStudyType.trim().length > 0 &&
    Number.isFinite(Number(state.lastStudyPriceContextAtMs)) &&
    Date.now() - Number(state.lastStudyPriceContextAtMs) <= STUDY_PRICE_HEALTH_INSURANCE_WINDOW_MS
  );
}

function shouldUsePriorStudyPricingContext(priorState, rawText) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (stateLooksLikeAwaitingStudyPriceHealthInsurance(priorState)) return true;
  if (stateLooksLikeAwaitingStudyTypeForPrice(priorState)) return true;
  if (stateHasRecentStudyPriceContext(priorState)) return true;
  if (messageAsksAboutStudyPrice(rawText) && getStudyTypeFromText(rawText)) return false;
  return true;
}

function priorStateIndicatesSpirometryStudy(priorState) {
  if (!priorState || typeof priorState !== 'object' || typeof priorState.lastStudyType !== 'string') {
    return false;
  }
  return normalizeForMatch(priorState.lastStudyType).includes('espirometr');
}

function priorStateIndicatesAllergyStudy(priorState) {
  if (!priorState || typeof priorState !== 'object' || typeof priorState.lastStudyType !== 'string') {
    return false;
  }
  const normalizedStudyType = normalizeForMatch(priorState.lastStudyType);
  return (
    normalizedStudyType.includes('prick') ||
    normalizedStudyType.includes('alerg') ||
    normalizedStudyType.includes('parche') ||
    normalizedStudyType.includes('patch')
  );
}

function stateLooksLikeAwaitingVirtualVisitConfirmation(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.state === 'awaiting_virtual_visit_confirmation' &&
    Number.isFinite(Number(state.awaitingVirtualVisitConfirmationAtMs))
  );
}

function messageLooksLikeTreatmentAppointmentRequest(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsBeingSeen =
    /\b(atenderme|atenderse|ser atendid[oa])\b/.test(normalized) ||
    normalized.includes('quiero atender') ||
    normalized.includes('necesito atender');
  if (!mentionsBeingSeen) return false;
  return (
    /\b(quiero|necesito|quisiera|me gustaria|me gustaría|puedo|podria|podría)\b/.test(normalized) ||
    normalized.includes('semana que viene') ||
    normalized.includes('proxima semana') ||
    normalized.includes('próxima semana') ||
    normalized.includes('esta semana') ||
    normalized.includes('cuando pueda') ||
    normalized.includes('cuándo pueda')
  );
}

function messageConfirmsReferralSedeBookingFollowUp(rawText, priorState) {
  if (!priorState || !messageConfirmsLinkSend(rawText)) return false;
  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (!isReferralOnlySedeEntry(lastSede)) return false;
  return (
    stateHasRecentBookingConversationContext(priorState) ||
    stateHasPendingBookingIntent(priorState) ||
    stateLooksLikeAwaitingLinkConfirmation(priorState)
  );
}

function messageLooksLikeReferralOnlySedeBookingIntent(rawText, priorState = null) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageAsksGenericConsultationPrice(rawText)) return false;
  if (messageLooksLikeAnyPriceQuestion(rawText)) return false;
  if (messageLooksLikeHealthInsurancePlusQuestion(rawText)) return false;
  return (
    messageLooksLikeBookingIntent(rawText) ||
    messageLooksLikeTreatmentAppointmentRequest(rawText) ||
    messageExplicitlyRequestsBookingLink(rawText) ||
    messageLooksLikeAssistedBookingRequest(rawText) ||
    messageAsksWhereOrHowToBook(rawText) ||
    messageAsksExplicitlyHowToBookTurn(rawText) ||
    messageConfirmsReferralSedeBookingFollowUp(rawText, priorState)
  );
}

function buildClearedStaleBookingLinkMemoryStatePatch() {
  return {
    lastBookingLinkSentAtMs: null,
    lastBookingLinkSedeEnvKey: null,
    lastBookingLinkSedeDisplayName: null,
    lastBookingLinkUrl: null,
    ...buildClearedAwaitingLinkConfirmationStatePatch(),
  };
}

async function sendReferralOnlySedeBookingReply(from, sedeEntry, priorState, profileDisplayName, bodyText = '') {
  if (!sedeEntry) return false;
  const reply = bodyText
    ? buildReferralOnlySedeSlotFollowUpReply(sedeEntry, bodyText)
    : buildReferralOnlySedeBookingReply(sedeEntry);
  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(priorState, {}, {
      ...(wrapped.nextStatePatch || {}),
      ...(buildLastSedeStatePatch(sedeEntry) || {}),
      ...buildClearedStaleBookingLinkMemoryStatePatch(),
      ...buildLastBotReplyStatePatch(wrapped.messageText),
      bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS,
    })
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

async function tryHandleReferralOnlySedeBookingInquiry(from, bodyText, priorState, profileDisplayName) {
  const referralFollowUpSede = resolveReferralSedeForConversationFollowUp(priorState, bodyText);
  if (referralFollowUpSede) {
    return sendReferralOnlySedeBookingReply(
      from,
      referralFollowUpSede,
      priorState,
      profileDisplayName,
      bodyText
    );
  }
  const sedeFromMessage = findSedeFromText(bodyText);
  const lastSede = resolveLastSedeEntryFromState(priorState);
  const sedeEntry =
    sedeFromMessage && isReferralOnlySedeEntry(sedeFromMessage)
      ? sedeFromMessage
      : messageConfirmsReferralSedeBookingFollowUp(bodyText, priorState) &&
          isReferralOnlySedeEntry(lastSede)
        ? lastSede
        : null;
  if (!sedeEntry) return false;
  if (!messageLooksLikeReferralOnlySedeBookingIntent(bodyText, priorState)) return false;
  return sendReferralOnlySedeBookingReply(from, sedeEntry, priorState, profileDisplayName, bodyText);
}

function messageMentionsOutOfCoverageCity(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const mentionsActiveSede = Boolean(findSedeFromText(rawText));
  let mentionsOutOfCoverageCity = false;
  for (const phrase of OUT_OF_COVERAGE_CITY_NORMALIZED_SUBSTRINGS) {
    if (normalized.includes(phrase)) {
      mentionsOutOfCoverageCity = true;
      break;
    }
  }
  if (!mentionsOutOfCoverageCity && /\bbs\s*as\b/.test(normalized)) {
    mentionsOutOfCoverageCity = true;
  }
  if (!mentionsOutOfCoverageCity) return false;
  if (!mentionsActiveSede) return true;
  return mentionsOutOfCoverageCity;
}

function resolveOutOfCoverageCityLabel(rawText) {
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    normalized.includes('buenos aires') ||
    /\bbs\s*as\b/.test(normalized) ||
    normalized.includes('bsas')
  ) {
    return 'Buenos Aires';
  }
  if (normalized.includes('capital federal') || normalized.includes('caba')) return 'CABA';
  if (normalized.includes('la plata')) return 'La Plata';
  if (normalized.includes('cordoba')) return 'Córdoba';
  if (normalized.includes('rosario')) return 'Rosario';
  if (normalized.includes('mendoza')) return 'Mendoza';
  return 'esa ciudad';
}

function buildOutOfCoverageCityReply(rawText) {
  const cityLabel = resolveOutOfCoverageCityLabel(rawText);
  return `No, el Dr. no atiende en ${cityLabel}. Atiende solo en ${ACTIVE_SEDE_CITIES_LIST_MESSAGE}. ¿Desde cuál de esas te consultás?`;
}

async function sendOutOfCoverageCityReply(from, bodyText, priorState, profileDisplayName) {
  const reply = buildOutOfCoverageCityReply(bodyText);
  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(
      priorState,
      buildAwaitingSedeSelectionStatePatch(),
      wrapped.nextStatePatch
    )
  );
  await sendWhatsAppText(from, wrapped.messageText);
}

function messageUsesLegacySedeOption(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  return /^[34]$/.test(rawText.trim());
}

function messageUsesLegacySedeOptionInContext(rawText, priorState) {
  if (!messageUsesLegacySedeOption(rawText)) return false;
  if (stateLooksLikeAwaitingSedeSelection(priorState)) return true;
  return Boolean(
    priorState &&
      typeof priorState === 'object' &&
      (priorState.state === 'awaiting_booking_link_sede' ||
        priorState.state === 'awaiting_health_insurance_city' ||
        priorState.state === 'awaiting_private_price_city' ||
        priorState.state === 'awaiting_schedule_sede')
  );
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

function buildOpenAiClassifierUserContent(userMessage, options = {}) {
  const parts = [];
  if (typeof options.lastAssistantMessage === 'string' && options.lastAssistantMessage.trim().length > 0) {
    parts.push(`Último mensaje del asistente:\n${options.lastAssistantMessage.trim()}`);
  }
  if (typeof options.conversationContext === 'string' && options.conversationContext.trim().length > 0) {
    parts.push(`Contexto de la conversación:\n${options.conversationContext.trim()}`);
  }
  if (typeof options.profileDisplayName === 'string' && options.profileDisplayName.trim().length > 0) {
    parts.push(`Nombre de perfil de WhatsApp (opcional): ${options.profileDisplayName.trim()}`);
  }
  parts.push(`Mensaje del paciente:\n${String(userMessage || '')}`);
  return parts.join('\n\n');
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

function getNormalizedSedeKeywordSet() {
  const keywords = new Set();
  for (const entry of SEDE_ENTRIES) {
    for (const keyword of entry.match) {
      if (/^[12]$/.test(keyword)) continue;
      const normalizedKeyword = normalizeForMatch(keyword);
      if (normalizedKeyword) keywords.add(normalizedKeyword);
    }
  }
  return keywords;
}

function guessKeyLooksLikeSedeKeywordOnly(guessKey) {
  if (!guessKey || typeof guessKey !== 'string') return false;
  const normalizedGuess = guessKey.replace(/\s+/g, ' ').trim();
  if (!normalizedGuess) return false;
  const sedeKeywords = getNormalizedSedeKeywordSet();
  if (sedeKeywords.has(normalizedGuess)) return true;
  const withoutFillerWords = normalizedGuess
    .replace(/\b(y|en|la|el|para|de|a|o|ahí|ahi)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Boolean(withoutFillerWords && sedeKeywords.has(withoutFillerWords));
}

function guessKeyLooksLikePrivatePayIntent(guessKey) {
  if (!guessKey || typeof guessKey !== 'string') return false;
  const normalized = guessKey.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (normalized === 'particular' || normalized === 'particualr' || normalized === 'privado') return true;
  if (normalized === 'no' || normalized === 'no tengo' || normalized === 'ninguna' || normalized === 'ninguno') {
    return true;
  }
  if (normalized === 'sin obra social' || normalized === 'sin prepaga' || normalized === 'sin os') {
    return true;
  }
  if (
    normalized === 'no tengo obra social' ||
    normalized === 'no tengo prepaga' ||
    normalized === 'no tengo os' ||
    normalized === 'no tengo cobertura' ||
    normalized === 'sin cobertura' ||
    normalized === 'no tengo nada'
  ) {
    return true;
  }
  if (
    normalized.includes('no tengo obra social') ||
    normalized.includes('no tengo prepaga') ||
    normalized.includes('no tengo os') ||
    normalized.includes('no tengo cobertura') ||
    normalized.includes('sin cobertura')
  ) {
    return true;
  }
  if (
    normalized === 'soy particular' ||
    normalized === 'pago particular' ||
    normalized === 'de forma particular' ||
    normalized === 'atencion particular'
  ) {
    return true;
  }
  return false;
}

function messageLooksLikeDeniedHealthInsuranceCoverage(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageStatesPrivatePayWithoutHealthInsurance(rawText)) return true;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  if (
    normalized === 'no' ||
    normalized === 'no tengo' ||
    normalized === 'ninguna' ||
    normalized === 'ninguno' ||
    normalized === 'nada' ||
    normalized === 'no tengo nada'
  ) {
    return true;
  }
  if (
    normalized.includes('sin obra social') ||
    normalized.includes('sin prepaga') ||
    normalized.includes('sin cobertura') ||
    normalized.includes('no tengo obra social') ||
    normalized.includes('no tengo prepaga') ||
    normalized.includes('no tengo cobertura')
  ) {
    return true;
  }
  if (normalized.startsWith('no tengo ') && !tryExtractHealthInsuranceName(rawText)) {
    return true;
  }
  return false;
}

function messageStatesPrivatePayWithoutHealthInsurance(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageExplicitlyAsksPrivateConsultationPrice(rawText)) return true;
  const normalized = normalizePriceTyposInText(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return guessKeyLooksLikePrivatePayIntent(normalized);
}

function messageLooksLikePrivatePayOrHealthInsuranceAmbiguity(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  if (messageStatesPrivatePayWithoutHealthInsurance(rawText)) return true;
  return (
    normalized.includes('particular') ||
    normalized.includes('particulares') ||
    normalized.includes('privado') ||
    normalized.includes('sin obra social') ||
    normalized.includes('sin prepaga') ||
    normalized.includes('no tengo obra social') ||
    normalized.includes('no tengo prepaga') ||
    normalized === 'no tengo' ||
    normalized === 'no' ||
    normalized === 'ninguna' ||
    normalized === 'ninguno'
  );
}

function stateLooksLikeAwaitingHealthInsuranceAnswer(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  return (
    stateLooksLikeAwaitingConsultationPriceHealthInsurance(priorState) ||
    stateLooksLikeAwaitingStudyPriceHealthInsurance(priorState) ||
    priorState.state === 'awaiting_health_insurance_name' ||
    priorState.state === 'awaiting_health_insurance_plan' ||
    shouldAskHealthInsuranceBeforeConsultationPrice(priorState)
  );
}

async function tryResolvePrivatePayWithoutHealthInsuranceWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense (Argentina).',
    'Tarea: decidir si el paciente indica que NO tiene obra social/prepaga y quiere atención PRIVADA (pago particular), o si está nombrando una obra social/prepaga.',
    'Respondé solo una etiqueta: PRIVATE_PAY, HEALTH_INSURANCE o UNSURE.',
    '',
    'PRIVATE_PAY: "particular" solo o casi solo; "soy particular"; "sin obra social"; "no tengo obra social"; "no tengo prepaga"; "no tengo" (solo, como respuesta a la pregunta de cobertura); "pago particular"; "privado"; "no tengo cobertura".',
    'CRÍTICO: si el asistente acaba de preguntar "¿qué obra social/prepaga tenés?" y el paciente responde solo "Particular", es PRIVATE_PAY (quiere precio/atención privada), NO una obra social.',
    'CRÍTICO: "particular" NO es lo mismo que obras sociales cuyo nombre contiene "PARTICULARES" (ej. OSDOP DOCENTES PARTICULARES). Solo "particular" = PRIVATE_PAY.',
    '',
    'HEALTH_INSURANCE: nombra claramente una cobertura (OSDE, Sancor, OSDOP, "tengo OSDOP docentes particulares", "mi obra social es ...").',
    'Si el mensaje incluye el nombre explícito de una obra social aunque contenga la palabra "particulares", es HEALTH_INSURANCE.',
    '',
    'UNSURE: no alcanza el contexto para decidir con seguridad.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.lastAssistantMessage ||
      (options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : ''),
    profileDisplayName: options.profileDisplayName,
  });

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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (normalized.startsWith('PRIVATE_PAY')) return true;
    if (normalized.startsWith('HEALTH_INSURANCE')) return false;
    return null;
  } catch (error) {
    console.error('OpenAI private-pay classifier failed', error);
    return null;
  }
}

async function resolvePrivatePayWithoutHealthInsuranceFromMessage(userMessage, options = {}) {
  if (!userMessage || typeof userMessage !== 'string') return false;
  if (messageExplicitlyAsksPrivateConsultationPrice(userMessage)) return true;
  const normalized = normalizePriceTyposInText(userMessage)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (guessKeyLooksLikePrivatePayIntent(normalized)) return true;

  const shouldUseOpenAi =
    getOpenAiApiKey() &&
    (messageLooksLikePrivatePayOrHealthInsuranceAmbiguity(userMessage) ||
      stateLooksLikeAwaitingHealthInsuranceAnswer(options.priorState));

  if (shouldUseOpenAi) {
    const openAiDecision = await tryResolvePrivatePayWithoutHealthInsuranceWithOpenAi(userMessage, options);
    if (openAiDecision === true) return true;
    if (openAiDecision === false) {
      if (
        stateLooksLikeAwaitingHealthInsuranceAnswer(options.priorState) &&
        messageLooksLikeDeniedHealthInsuranceCoverage(userMessage)
      ) {
        return true;
      }
      return false;
    }
  }

  if (
    stateLooksLikeAwaitingHealthInsuranceAnswer(options.priorState) &&
    messageLooksLikeDeniedHealthInsuranceCoverage(userMessage)
  ) {
    return true;
  }
  return messageStatesPrivatePayWithoutHealthInsurance(userMessage);
}

function healthInsuranceGuessMatchesCandidateKey(guessKey, candidateKey) {
  if (!guessKey || !candidateKey) return false;
  if (guessKey === candidateKey) return true;
  if (guessKeyLooksLikePrivatePayIntent(guessKey)) return false;
  const guessTokens = guessKey.split(/\s+/).filter(Boolean);
  const candidateTokens = candidateKey.split(/\s+/).filter(Boolean);
  if (guessTokens.length === 1) {
    return candidateTokens.includes(guessTokens[0]);
  }
  if (candidateTokens.length === 1) {
    return guessTokens.includes(candidateTokens[0]);
  }
  return candidateKey.includes(guessKey) || guessKey.includes(candidateKey);
}

function mapHealthInsuranceGuessToKnownName(guess, knownNames) {
  const guessRaw = typeof guess === 'string' ? guess.trim() : '';
  if (!guessRaw) return null;
  if (messageStatesPrivatePayWithoutHealthInsurance(guessRaw)) return null;
  const guessKey = normalizeHealthInsuranceNameForKey(guessRaw);
  if (!guessKey) return null;
  if (guessKeyLooksLikeSedeKeywordOnly(guessKey)) return null;
  if (guessKeyLooksLikePrivatePayIntent(guessKey)) return null;

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
    if (healthInsuranceGuessMatchesCandidateKey(guessKey, candidate.key)) {
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
function processAssistantReplyForPatient(rawModelText, options = {}) {
  if (rawModelText == null || typeof rawModelText !== 'string') {
    return rawModelText;
  }
  const priorState = options && typeof options.priorState === 'object' ? options.priorState : null;
  const bodyText = options && typeof options.bodyText === 'string' ? options.bodyText : '';
  if (/\[DERIVAR\]/i.test(rawModelText)) {
    console.warn(
      'meta-whatsapp-webhook: model requested [DERIVAR]; secretary notification not implemented',
      rawModelText.slice(0, 500)
    );
    if (priorState && conversationLooksLikeOngoingBookingLinkGuidance(priorState)) {
      return buildBookingPersonalAssistanceMessage(priorState);
    }
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
    return `Entendido. ¿Desde qué ciudad consultás: ${ACTIVE_SEDE_CITIES_LIST_MESSAGE}?`;
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
    return `Entendido. ¿Desde qué ciudad consultás: ${ACTIVE_SEDE_CITIES_LIST_MESSAGE}?`;
  }
  if (messageMentionsOutOfCoverageCity(trimmed)) {
    return buildOutOfCoverageCityReply(trimmed);
  }
  if (
    assistantReplyAsksPatientForSpecificDateOrTime(trimmed) &&
    userMessageRequestsSpecificAppointmentSlot(bodyText, priorState)
  ) {
    const confirmedSede = resolveConfirmedSedeEntryForBookingFlow(bodyText, priorState);
    if (confirmedSede) {
      return sanitizePatientReplyWhenSedeUnknown(
        `Entendido. Por acá no confirmamos horarios puntuales; revisá la agenda online para ver disponibilidad en ${confirmedSede.displayName}.`,
        priorState,
        bodyText
      );
    }
    return sanitizePatientReplyWhenSedeUnknown(
      `Entendido. ¿En qué sede querés atenderte: 1 Corrientes o 2 Resistencia?`,
      priorState,
      bodyText
    );
  }
  return sanitizeInventedClinicAddressInPatientReply(
    sanitizeBookingAssistanceReplyText(
      sanitizePatientReplyWhenSedeUnknown(trimmed, priorState, bodyText),
      priorState
    ),
    { priorState, bodyText }
  );
}

function sanitizeBookingAssistanceReplyText(replyText, priorState = null, sedeEntry = null) {
  if (!replyText || typeof replyText !== 'string') return replyText;
  const normalized = normalizeForMatch(replyText);
  const mentionsDerivar =
    normalized.includes('te derivo') ||
    normalized.includes('te derivamos') ||
    normalized.includes('alguien del equipo') ||
    normalized.includes('en breve te contactan') ||
    normalized.includes('te paso con alguien') ||
    normalized.includes('te acompane alguien') ||
    normalized.includes('te acompañe alguien');
  if (!mentionsDerivar) return replyText;
  const assistanceMessage = buildBookingPersonalAssistanceMessage(priorState, sedeEntry);
  if (replyTextIncludesClinicAssistancePhoneNumber(replyText)) {
    return replyText
      .replace(/si prefer[ií]s,? te derivo[^.!?]*[.!?]?/gi, '')
      .replace(/te derivo con alguien del equipo[^.!?]*[.!?]?/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return replyText
    .replace(/si prefer[ií]s,? te derivo[^.!?]*[.!?]?/gi, assistanceMessage)
    .replace(/te derivo con alguien del equipo[^.!?]*[.!?]?/gi, assistanceMessage)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function assistantReplyAsksPatientForSpecificDateOrTime(replyText) {
  if (!replyText || typeof replyText !== 'string') return false;
  const normalized = normalizeForMatch(replyText);
  return (
    normalized.includes('indicame la fecha') ||
    normalized.includes('indicame el dia') ||
    normalized.includes('indicame el día') ||
    normalized.includes('indicame el horario') ||
    normalized.includes('por favor indicame la fecha') ||
    normalized.includes('por favor indicame el dia') ||
    normalized.includes('por favor indicame el día') ||
    normalized.includes('decime la fecha') ||
    normalized.includes('decime el dia') ||
    normalized.includes('decime el día') ||
    normalized.includes('decime el horario') ||
    normalized.includes('que dia preferis') ||
    normalized.includes('qué día preferís') ||
    normalized.includes('que horario preferis') ||
    normalized.includes('qué horario preferís') ||
    normalized.includes('a que hora') ||
    normalized.includes('a qué hora')
  );
}

function userMessageRequestsSpecificAppointmentSlot(bodyText, priorState) {
  const requestText = resolvePendingBookingRequestText(priorState, bodyText || '');
  return (
    messageIncludesSpecificAppointmentTime(requestText) ||
    messageIncludesSpecificAppointmentTime(bodyText) ||
    Boolean(extractWeekdayNameFromText(requestText)) ||
    Boolean(extractWeekdayNameFromText(bodyText)) ||
    Boolean(priorState && priorState.pendingBookingIncludesTime)
  );
}

function getAgendaUrl(entry) {
  const url = process.env[entry.envKey];
  return url && url.startsWith('http') ? url : null;
}

function buildAskSedeMessage() {
  return ACTIVE_SEDE_OPTIONS_MESSAGE;
}

function buildFriendlyAcknowledgeSentence() {
  return 'Perfecto.';
}

function buildAskSedeBridgeMessage() {
  return '¿Para qué sede necesitás la info?';
}

function buildAskSedeBridgeMessageForBooking() {
  return 'Por acá no agendamos turnos por chat: en Corrientes y Resistencia reservás con el link de agenda. ¿Para qué sede es?';
}

function buildSedeNumberedOptionsSuffix() {
  return 'Podés escribir 1 para Corrientes, 2 para Resistencia, o el nombre de tu ciudad (Formosa o Sáenz Peña) 😊';
}

function resolveAskSedeBridgeMessage(options = {}) {
  if (options.intent === 'booking') return buildAskSedeBridgeMessageForBooking();
  return buildAskSedeBridgeMessage();
}

function buildConsolidatedAskSedePrompt(prefaceText = null, options = {}) {
  const preface =
    typeof prefaceText === 'string' && prefaceText.trim().length > 0 ? prefaceText.trim() : null;
  const bridgeMessage = resolveAskSedeBridgeMessage(options);
  if (preface && assistantReplyAsksForSedeCity(preface)) {
    return `${preface} ${buildSedeNumberedOptionsSuffix()}`.trim();
  }
  if (preface) {
    return `${preface} ${bridgeMessage} ${buildSedeNumberedOptionsSuffix()}`.trim();
  }
  return `${bridgeMessage} ${buildSedeNumberedOptionsSuffix()}`.trim();
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
    return `En ${safeSede} no trabajamos con ${safeOs}.`;
  }
  return buildAskSedeMessage();
}

async function findPrimaryAcceptedCityEntryForHealthInsurance(healthInsuranceName, excludeDisplayName = null) {
  for (const entry of SEDE_ENTRIES) {
    if (excludeDisplayName && entry.displayName === excludeDisplayName) continue;
    const plusRule = await lookupPlusRule(entry.displayName, healthInsuranceName);
    if (plusRule && plusRule.isAccepted) return entry;
  }
  return null;
}

async function buildHealthInsuranceCoverageLineForSede(sedeEntry, healthInsuranceName) {
  const canonicalHealthInsuranceName = normalizeHealthInsuranceCanonicalName(healthInsuranceName) || healthInsuranceName;
  const plusRule = await lookupPlusRule(sedeEntry.displayName, canonicalHealthInsuranceName);
  if (plusRule && plusRule.isAccepted) {
    if (plusRule.hasPlus) {
      const plusFormatted = formatArsAmount(plusRule.plusAmountArs);
      if (plusFormatted) {
        return `En ${sedeEntry.displayName} con ${canonicalHealthInsuranceName} hay un plus de $${plusFormatted}.`;
      }
    }
    return `En ${sedeEntry.displayName} trabajamos con ${canonicalHealthInsuranceName} sin plus.`;
  }
  const alternateCityEntry = await findPrimaryAcceptedCityEntryForHealthInsurance(
    canonicalHealthInsuranceName,
    sedeEntry.displayName
  );
  if (alternateCityEntry) {
    const alternateRule = await lookupPlusRule(alternateCityEntry.displayName, canonicalHealthInsuranceName);
    if (alternateRule && alternateRule.isAccepted && alternateRule.hasPlus) {
      const plusFormatted = formatArsAmount(alternateRule.plusAmountArs);
      if (plusFormatted) {
        return `En ${sedeEntry.displayName} no trabajamos con ${canonicalHealthInsuranceName}. En ${alternateCityEntry.displayName} sí, con plus de $${plusFormatted}.`;
      }
    }
    return `En ${sedeEntry.displayName} no trabajamos con ${canonicalHealthInsuranceName}. En ${alternateCityEntry.displayName} sí trabajamos.`;
  }
  return `En ${sedeEntry.displayName} no trabajamos con ${canonicalHealthInsuranceName}.`;
}

async function buildHealthInsuranceMismatchReplyForKnownSede(sedeEntry, healthInsuranceName) {
  return buildHealthInsuranceCoverageLineForSede(sedeEntry, healthInsuranceName);
}

function buildMicroCommitmentMessage() {
  return 'Si querés, te paso el link para ver horarios y sacar turno. ¿Te lo mando?';
}

function shouldOfferBookingLink(priorState) {
  if (!priorState || typeof priorState !== 'object') return true;
  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (isReferralOnlySedeEntry(lastSede)) return false;
  const optOutUntilMs = Number(priorState.bookingLinkOptOutUntilMs);
  if (Number.isFinite(optOutUntilMs) && optOutUntilMs > 0 && Date.now() <= optOutUntilMs) return false;
  if (wasBookingLinkSentRecently(priorState)) return false;
  const bookingLinkOfferAtMs = Number(priorState.bookingLinkOfferAtMs);
  if (Number.isFinite(bookingLinkOfferAtMs) && bookingLinkOfferAtMs > 0) {
    if (Date.now() - bookingLinkOfferAtMs <= BOOKING_LINK_OFFER_REPEAT_COOLDOWN_MS) return false;
  }
  return true;
}

function appendBookingLinkOfferIfAllowed(priorState, messageText, options = {}) {
  if (
    options.suppressBookingLinkOffer ||
    options.replyContext === 'consultation_price' ||
    options.replyContext === 'health_insurance_info'
  ) {
    return messageText;
  }
  if (!shouldOfferBookingLink(priorState)) return messageText;
  return `${messageText} ${buildMicroCommitmentMessage()}`.trim();
}

const PATIENT_REPLY_OVERWHELMING_PATTERNS = [
  /si quer[eé]s, te paso el link/i,
  /horarios y sacar turno/i,
  /si prefer[ií]s atenci[oó]n particular/i,
  /pod[eé]s atenderte de manera particular/i,
  /consulta de evaluaci[oó]n/i,
];

function replyLooksOverwhelmingByRules(replyText) {
  if (!replyText || typeof replyText !== 'string') return false;
  let score = 0;
  if (replyText.length > PATIENT_REPLY_MAX_RECOMMENDED_LENGTH) score += 1;
  for (const pattern of PATIENT_REPLY_OVERWHELMING_PATTERNS) {
    if (pattern.test(replyText)) score += 1;
  }
  const questionCount = (replyText.match(/\?/g) || []).length;
  if (questionCount > 1) score += 1;
  if (replyText.split(/\n\n+/).filter((part) => part.trim().length > 0).length > 2) score += 1;
  return score >= 2;
}

function tryRulesFirstFocusPatientReply(originalReply, options = {}) {
  if (!originalReply || typeof originalReply !== 'string') return originalReply;
  let focused = originalReply.trim();
  const shouldFocusForCost =
    options.replyContext === 'consultation_price' || Boolean(options.suppressBookingLinkOffer);
  if (!shouldFocusForCost && !replyLooksOverwhelmingByRules(focused)) {
    return focused;
  }
  focused = focused.replace(/\s*Si quer[eé]s, te paso el link[^.?!]*[.?!]?\s*/gi, ' ');
  focused = focused.replace(/\s*¿Te lo mando\?\s*/gi, ' ');
  focused = focused.replace(/\n\nSi prefer[ií]s atenci[oó]n particular:[^\n]+/gi, '');
  focused = focused.replace(
    /\s*Si quer[eé]s, pod[eé]s atenderte de manera particular[^.?!]*[.?!]?\s*/gi,
    ' '
  );
  focused = focused.replace(/\s+/g, ' ').trim();
  return focused;
}

function isOpenAiReplyHumanizationEnabled() {
  if (!getOpenAiApiKey()) return false;
  const raw = process.env.OPENAI_HUMANIZE_REPLIES;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return true;
}

function extractReplyAmountTokens(replyText) {
  const matches = String(replyText || '').match(/\$\s?[\d.]+/g) || [];
  return matches.map((amount) => amount.replace(/\s/g, ''));
}

function replyTextContainsPriceAmount(replyText) {
  return extractReplyAmountTokens(replyText).length > 0;
}

function replyTextContainsKnownClinicAddress(replyText) {
  if (!replyText || typeof replyText !== 'string') return false;
  const normalized = normalizeForMatch(replyText);
  return KNOWN_CLINIC_ADDRESS_NORMALIZED_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function replyTextLooksLikeInventedClinicAddress(replyText) {
  if (!replyText || typeof replyText !== 'string') return false;
  if (replyTextContainsKnownClinicAddress(replyText)) return false;
  const normalized = normalizeForMatch(replyText);
  const mentionsStreetContext =
    normalized.includes('calle') ||
    normalized.includes('avenida') ||
    normalized.includes('av ') ||
    normalized.includes('ubicad') ||
    normalized.includes('direccion') ||
    normalized.includes('dirección') ||
    normalized.includes('queda en') ||
    normalized.includes('queda la') ||
    /\b\d{2,5}\b/.test(normalized);
  if (!mentionsStreetContext) return false;
  if (normalized.includes('peron') || normalized.includes('perón')) return true;
  if (normalized.includes('juan domingo')) return true;
  if (normalized.includes('lunes a viernes de 9 a 18')) return true;
  return /\bcalle\b/.test(normalized) || (mentionsStreetContext && normalized.includes('clinica'));
}

function sanitizeInventedClinicAddressInPatientReply(replyText, options = {}) {
  if (!replyTextLooksLikeInventedClinicAddress(replyText)) return replyText;
  const priorState = options && typeof options.priorState === 'object' ? options.priorState : null;
  const bodyText = options && typeof options.bodyText === 'string' ? options.bodyText : '';
  const lastSede =
    findSedeFromText(bodyText) || resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  if (lastSede) {
    return buildSedeAddressReply(priorState, lastSede);
  }
  return `Para pasarte la dirección exacta, ¿desde qué ciudad consultás? ${ACTIVE_SEDE_OPTIONS_MESSAGE}`;
}

function humanizedReplyPreservesCriticalFacts(originalReply, humanizedReply) {
  const original = String(originalReply || '');
  const revised = String(humanizedReply || '');
  if (!original || !revised) return false;
  if (replyTextContainsKnownClinicAddress(original) && !replyTextContainsKnownClinicAddress(revised)) {
    return false;
  }
  const urlPattern = /https?:\/\/\S+/gi;
  const originalUrls = original.match(urlPattern) || [];
  for (const url of originalUrls) {
    if (!revised.includes(url)) return false;
  }
  const originalAmounts = extractReplyAmountTokens(original);
  const revisedAmounts = extractReplyAmountTokens(revised);
  if (originalAmounts.length === 0 && revisedAmounts.length > 0) return false;
  for (const amount of originalAmounts) {
    if (!revised.replace(/\s/g, '').includes(amount)) return false;
  }
  for (const amount of revisedAmounts) {
    if (!originalAmounts.includes(amount)) return false;
  }
  const sedeNames = ['Corrientes', 'Resistencia'];
  for (const sedeName of sedeNames) {
    if (original.includes(sedeName) && !revised.includes(sedeName)) return false;
  }
  return true;
}

function extractOpenAiRevisedReplyText(modelText, fallbackReply) {
  const normalized = typeof modelText === 'string' ? modelText.trim() : '';
  if (!normalized || normalized.toUpperCase() === 'OK') {
    return { reply: fallbackReply, changed: false };
  }
  const revisedMatch = normalized.match(/^REVISED:\s*(.+)$/is);
  if (revisedMatch && revisedMatch[1].trim().length > 0) {
    return { reply: revisedMatch[1].trim(), changed: true };
  }
  if (normalized.length > 0 && normalized.length <= PATIENT_REPLY_MAX_RECOMMENDED_LENGTH + 120) {
    return { reply: normalized, changed: true };
  }
  return { reply: fallbackReply, changed: false };
}

function shouldSkipReplyHumanization(replyText, options = {}) {
  if (options.skipHumanization) return true;
  if (options.replyContext === 'address_info') return true;
  if (!replyText || typeof replyText !== 'string') return true;
  if (replyTextContainsPriceAmount(replyText)) return true;
  if (replyTextContainsKnownClinicAddress(replyText)) return true;
  const normalized = normalizeForMatch(replyText);
  if (
    normalized.includes('escribi solo el numero') ||
    normalized.includes('1 corrientes') ||
    normalized.includes('2 resistencia')
  ) {
    return true;
  }
  return false;
}

async function tryHumanizePatientReplyWithOpenAi(originalReply, options = {}) {
  const sourceReply =
    typeof originalReply === 'string' && originalReply.trim().length > 0 ? originalReply.trim() : '';
  if (
    !sourceReply ||
    !isOpenAiReplyHumanizationEnabled() ||
    shouldSkipReplyHumanization(sourceReply, options)
  ) {
    return { reply: sourceReply, source: 'rules' };
  }

  const apiKey = getOpenAiApiKey();
  const modelName = getOpenAiModelName();
  const replyContextInstructions = [];
  if (options.replyContext === 'booking_link_reminder') {
    replyContextInstructions.push(
      'Contexto: recordatorio de agenda/link ya enviado.',
      'NO uses "Sí, exacto" ni confirmaciones redundantes. Variá el tono según el mensaje del paciente.',
      'Si preguntó cómo o dónde sacar turno, respondé directo con el recordatorio del link, sin preámbulo innecesario.'
    );
  }
  if (options.replyContext === 'bare_ack') {
    replyContextInstructions.push(
      'Contexto: el paciente solo dijo "dale", "ok" o "gracias" sin pedir turno.',
      'Respuesta breve y cálida. NO repitas el link de agenda ni vuelvas a explicar cómo reservar.'
    );
  }
  if (options.replyContext === 'doctor_trust') {
    replyContextInstructions.push(
      'Contexto: el paciente pregunta por qué atenderse con el Dr. o expresa frustración con otros alergistas.',
      'Validá la emoción primero si corresponde. Mencioná la experiencia del Dr. (20+ años, alergia e inmunología). NO pidas sede ni ofrezcas link de turno en esta respuesta.'
    );
  }
  if (options.replyContext === 'address_info') {
    replyContextInstructions.push(
      'Contexto: dirección/ubicación/horarios de la clínica.',
      'NUNCA inventes calles, números ni horarios. Mantené exactas las direcciones y horarios del borrador.'
    );
  }
  if (options.replyContext === 'booking_policy') {
    replyContextInstructions.push(
      'Contexto: el paciente quiere turno con día u horario preferido.',
      'Mantené el tono cálido. NUNCA uses placeholders como [link de agenda]; si el borrador trae una URL https, conservala exacta en el texto.'
    );
  }
  const systemPrompt = [
    'Sos la voz humana de WhatsApp de la asistente del Dr. Liber Acosta (alergia e inmunología), en español rioplatense.',
    'Recibís un borrador factual generado por reglas. Reescribilo para que suene natural, cálido y fluido, como una recepcionista real (estilo bot de n8n), NO como call center ni robot.',
    'Mantené EXACTOS: montos ($), links URL, nombres de obra social/prepaga, ciudades (Corrientes/Resistencia), números de sede (1/2) y datos clínicos.',
    'No inventes ni omitas información. No agregues temas nuevos.',
    'Máximo 2 oraciones cortas por mensaje. Texto plano, sin markdown.',
    'Evitá frases plantilla: "Entendido", "Perfecto", "¿En qué te puedo ayudar?", "Soy un asistente virtual", "Sí, exacto".',
    'Si el paciente preguntó algo concreto, respondé eso primero con naturalidad.',
    'Podés usar como mucho 1 emoji cálido si suma (😊 🙂), no en todos los mensajes.',
    ...replyContextInstructions,
    'Si el borrador ya suena humano y claro, devolvé exactamente: OK',
    'Si lo mejorás, devolvé: REVISED: <texto>',
  ].join('\n');
  const userContent = `${buildOpenAiClassifierUserContent(options.userMessage || '', {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.lastAssistantMessage ||
      (options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : ''),
    profileDisplayName: options.profileDisplayName,
  })}\n\nBorrador del bot:\n${sourceReply}`;

  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        temperature: OPENAI_HUMANIZE_TEMPERATURE,
        max_tokens: OPENAI_HUMANIZE_MAX_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return { reply: sourceReply, source: 'humanize-error' };
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const parsed = extractOpenAiRevisedReplyText(text, sourceReply);
    if (!parsed.changed) {
      return { reply: sourceReply, source: 'humanize-ok' };
    }
    if (!humanizedReplyPreservesCriticalFacts(sourceReply, parsed.reply)) {
      return { reply: sourceReply, source: 'humanize-facts-guard' };
    }
    return { reply: parsed.reply, source: 'humanize-revised' };
  } catch (error) {
    console.error('OpenAI patient reply humanizer failed', error);
    return { reply: sourceReply, source: 'humanize-exception' };
  }
}

async function tryResolveFocusedPatientReplyWithOpenAi(originalReply, options = {}) {
  if (options.skipHumanization) {
    const sourceReply =
      typeof originalReply === 'string' && originalReply.trim().length > 0 ? originalReply.trim() : '';
    return { reply: sourceReply, source: 'skip-humanization' };
  }
  const rulesFocused = tryRulesFirstFocusPatientReply(originalReply, options);
  if (replyLooksOverwhelmingByRules(rulesFocused)) {
    const apiKey = getOpenAiApiKey();
    if (apiKey) {
      const modelName = getOpenAiModelName();
      const systemPrompt = [
        'Sos un editor de respuestas de WhatsApp para un consultorio médico en español rioplatense.',
        'Tarea: si la respuesta propuesta es abruminante (mezcla precio + link de turno + particular + varias preguntas), devolvé una versión CORTA que responda SOLO lo que el paciente preguntó.',
        'Si la respuesta ya es concisa y responde una sola cosa, devolvé exactamente: OK',
        'Si hay que acortar, devolvé: REVISED: <texto>',
        'Reglas: no inventes datos; no agregues link de agenda ni turno si preguntaron solo costo/plus/obra social; máximo 2 oraciones cortas; no hagas preguntas extra salvo que la respuesta original sea solo una pregunta necesaria.',
      ].join('\n');
      const userContent = `${buildOpenAiClassifierUserContent(options.userMessage || '', {
        conversationContext:
          options.conversationContext ||
          (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
        lastAssistantMessage:
          options.lastAssistantMessage ||
          (options.priorState && typeof options.priorState.lastBotReplyText === 'string'
            ? options.priorState.lastBotReplyText
            : ''),
        profileDisplayName: options.profileDisplayName,
      })}\n\nRespuesta propuesta del bot:\n${originalReply}`;

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
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
          }),
        });
        if (response.ok) {
          const data = await response.json();
          const text = data?.choices?.[0]?.message?.content;
          const parsed = extractOpenAiRevisedReplyText(text, rulesFocused);
          if (parsed.changed && humanizedReplyPreservesCriticalFacts(rulesFocused, parsed.reply)) {
            const humanized = await tryHumanizePatientReplyWithOpenAi(parsed.reply, options);
            return humanized;
          }
        }
      } catch (error) {
        console.error('OpenAI focused patient reply editor failed', error);
      }
    }
  }

  return tryHumanizePatientReplyWithOpenAi(rulesFocused, options);
}

async function finalizePatientReplyText(originalReply, options = {}) {
  const focused = await tryResolveFocusedPatientReplyWithOpenAi(originalReply, options);
  return focused.reply;
}

async function sendFinalizedPatientTextReply(
  from,
  rawReply,
  priorState,
  profileDisplayName,
  conversationStatePatch = {},
  finalizeOptions = {}
) {
  const finalizedReply = await finalizePatientReplyText(rawReply, {
    priorState,
    profileDisplayName,
    userMessage: finalizeOptions.userMessage || '',
    replyContext: finalizeOptions.replyContext,
    suppressBookingLinkOffer: finalizeOptions.suppressBookingLinkOffer,
    skipHumanization: finalizeOptions.skipHumanization,
    conversationContext: finalizeOptions.conversationContext,
  });
  const wrapped = buildAutoReplyWithGreetingIfNeeded(finalizedReply, profileDisplayName, priorState);
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
      ...conversationStatePatch,
      ...(wrapped.nextStatePatch || {}),
      ...buildLastBotReplyStatePatch(wrapped.messageText),
    })
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

function buildConsultationPriceAnsweredStatePatch() {
  return {
    consultationPriceAnsweredAtMs: Date.now(),
    state: undefined,
    awaitingConsultationPriceHealthInsuranceAtMs: null,
  };
}

function stateHasRecentConsultationPriceAnsweredContext(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  const answeredAtMs = Number(priorState.consultationPriceAnsweredAtMs);
  return (
    Number.isFinite(answeredAtMs) &&
    Date.now() - answeredAtMs <= CONSULTATION_PRICE_ANSWERED_WINDOW_MS
  );
}

function buildMicroCommitmentMessageWithState(priorState, forceOffer = false) {
  if (!forceOffer && !shouldOfferBookingLink(priorState)) {
    return '¿En qué más te puedo ayudar?';
  }
  return buildMicroCommitmentMessage();
}

function assistantReplyAsksForSedeCity(replyText) {
  if (!replyText || typeof replyText !== 'string') return false;
  const normalized = normalizeForMatch(replyText);
  return (
    normalized.includes('desde que ciudad') ||
    normalized.includes('desde qué ciudad') ||
    normalized.includes('que ciudad consultas') ||
    normalized.includes('qué ciudad consultás') ||
    normalized.includes('para que sede') ||
    normalized.includes('para qué sede') ||
    normalized.includes('corrientes o resistencia') ||
    normalized.includes('1 corrientes') ||
    normalized.includes('que sede')
  );
}

function buildAwaitingSedeSelectionStatePatch() {
  return {
    state: 'awaiting_sede_selection',
    awaitingSedeSelectionAtMs: Date.now(),
    lastBotAskedSedeCityAtMs: Date.now(),
    ...buildClearedStudyPricingContextPatch(),
  };
}

function buildSedeConfirmedHelpMessage(sede) {
  if (isReferralOnlySedeEntry(sede)) {
    return `Sí, el Dr. atiende en ${sede.displayName}. ${buildReferralOnlySedeBookingReply(sede)}`;
  }
  return `Sí, el Dr. atiende en ${sede.displayName}. ¿En qué te puedo ayudar?`;
}

function stateHasPendingBookingIntent(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  const pendingAtMs = Number(priorState.pendingBookingIntentAtMs);
  return Number.isFinite(pendingAtMs) && Date.now() - pendingAtMs <= PENDING_BOOKING_INTENT_WINDOW_MS;
}

function stateHasPendingBookingDetails(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (stateHasPendingBookingIntent(priorState)) return true;
  const pendingRequestText =
    typeof priorState.lastPendingBookingRequestText === 'string'
      ? priorState.lastPendingBookingRequestText.trim()
      : '';
  if (pendingRequestText.length > 0) return true;
  const pendingWeekday =
    typeof priorState.pendingBookingWeekday === 'string' ? priorState.pendingBookingWeekday.trim() : '';
  return pendingWeekday.length > 0;
}

function buildPendingBookingIntentStatePatch() {
  return { pendingBookingIntentAtMs: Date.now() };
}

function buildPendingBookingDetailsStatePatch(rawText) {
  if (!rawText || typeof rawText !== 'string') return {};
  const trimmed = rawText.trim();
  if (!trimmed.length) return {};
  const weekdayName = extractWeekdayNameFromText(rawText);
  return {
    lastPendingBookingRequestText: trimmed.slice(0, 280),
    ...(weekdayName ? { pendingBookingWeekday: weekdayName } : {}),
    ...(messageIncludesSpecificAppointmentTime(rawText) ? { pendingBookingIncludesTime: true } : {}),
  };
}

function buildClearedPendingBookingDetailsPatch() {
  return {
    lastPendingBookingRequestText: null,
    pendingBookingWeekday: null,
    pendingBookingIncludesTime: null,
  };
}

function resolvePendingBookingRequestText(priorState, currentMessage = '') {
  const fromState =
    priorState &&
    typeof priorState === 'object' &&
    typeof priorState.lastPendingBookingRequestText === 'string'
      ? priorState.lastPendingBookingRequestText.trim()
      : '';
  if (messageLooksLikeSedeOnlyAnswer(currentMessage)) return fromState;
  const fromCurrent = typeof currentMessage === 'string' ? currentMessage.trim() : '';
  return fromCurrent || fromState;
}

function buildClearedPendingBookingIntentPatch() {
  return { pendingBookingIntentAtMs: null };
}

function buildLastScheduleDiscussedStatePatch() {
  return { lastScheduleDiscussedAtMs: Date.now() };
}

function stateHasRecentScheduleDiscussionContext(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  const lastScheduleDiscussedAtMs = Number(priorState.lastScheduleDiscussedAtMs);
  return (
    Number.isFinite(lastScheduleDiscussedAtMs) &&
    Date.now() - lastScheduleDiscussedAtMs <= SCHEDULE_DISCUSSION_WINDOW_MS
  );
}

function stateHasRecentBookingConversationContext(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (stateHasPendingBookingIntent(priorState)) return true;
  if (stateHasRecentScheduleDiscussionContext(priorState)) return true;
  if (stateLooksLikeAwaitingLinkConfirmation(priorState)) return true;
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  if (!lastBotReplyText) return false;
  const normalized = normalizeForMatch(lastBotReplyText);
  return (
    normalized.includes('para que sede') ||
    normalized.includes('para qué sede') ||
    normalized.includes('desde que ciudad') ||
    normalized.includes('podés escribir 1') ||
    normalized.includes('podes escribir 1') ||
    normalized.includes('dale, te ayudo') ||
    normalized.includes('no agendamos turnos por chat') ||
    normalized.includes('solo se reserva con el link') ||
    normalized.includes('reservas con el link de agenda') ||
    normalized.includes('link para reservar') ||
    normalized.includes('link para ver horarios') ||
    normalized.includes('sacar turno') ||
    normalized.includes('el dr. atiende') ||
    normalized.includes('horarios de')
  );
}

function buildLastHealthInsuranceDiscussionStatePatch() {
  return { lastHealthInsuranceDiscussionAtMs: Date.now() };
}

function resolveActiveHealthInsuranceNameFromState(priorState) {
  if (!priorState || typeof priorState !== 'object') return null;
  if (
    typeof priorState.lastHealthInsuranceName === 'string' &&
    priorState.lastHealthInsuranceName.trim().length > 0
  ) {
    return priorState.lastHealthInsuranceName.trim();
  }
  if (typeof priorState.healthInsuranceName === 'string' && priorState.healthInsuranceName.trim().length > 0) {
    return priorState.healthInsuranceName.trim();
  }
  return null;
}

function stateHasRecentHealthInsuranceDiscussionContext(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  const lastDiscussionAtMs = Number(priorState.lastHealthInsuranceDiscussionAtMs);
  if (
    Number.isFinite(lastDiscussionAtMs) &&
    Date.now() - lastDiscussionAtMs <= HEALTH_INSURANCE_DISCUSSION_WINDOW_MS
  ) {
    return true;
  }
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  if (!lastBotReplyText) return false;
  const normalized = normalizeForMatch(lastBotReplyText);
  return (
    normalized.includes('trabajamos con') ||
    normalized.includes('sin plus') ||
    normalized.includes('con plus') ||
    normalized.includes('no trabajamos con') ||
    normalized.includes('obra social') ||
    normalized.includes('prepaga')
  );
}

function messageLooksLikeAlternateSedeFollowUp(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (!findSedeFromText(rawText)) return false;
  if (
    messageLooksLikeAnyPriceQuestion(rawText) ||
    messageLooksLikeBookingIntent(rawText) ||
    messageExplicitlyRequestsBookingLink(rawText)
  ) {
    return false;
  }
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const alternateSedeSignals = [
    'y en ',
    'y para ',
    'y en la ',
    'en ctes',
    'en resistencia',
    'en corrientes',
    'la otra sede',
    'la otra ciudad',
    'otra sede',
    'otra ciudad',
  ];
  if (alternateSedeSignals.some((signal) => normalized.includes(signal))) return true;
  return messageLooksLikeSedeOnlyAnswer(rawText);
}

function shouldSkipHealthInsuranceFuzzyResolutionForMessage(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  return (
    messageLooksLikeSedeOnlyAnswer(rawText) ||
    messageLooksLikeAlternateSedeFollowUp(rawText) ||
    messageLooksLikeBareSedeOptionAnswer(rawText)
  );
}

function extractWeekdayNameFromText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const normalized = normalizeForMatch(rawText);
  for (const weekdayName of WEEKDAY_NORMALIZED_NAMES) {
    if (normalized.includes(weekdayName)) return weekdayName;
  }
  return null;
}

function extractRelativeDayLabelFromText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const normalized = normalizeForMatch(rawText);
  if (normalized.includes('pasado manana') || normalized.includes('pasado mañana')) return 'pasado mañana';
  if (normalized.includes('manana') || normalized.includes('mañana')) return 'mañana';
  if (normalized.includes('hoy')) return 'hoy';
  return null;
}

function messageLooksLikeSpecificSlotBookingRequest(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  return Boolean(
    messageIncludesSpecificAppointmentTime(rawText) ||
    extractRelativeDayLabelFromText(rawText) ||
    extractWeekdayNameFromText(rawText)
  );
}

function buildPreferredSlotBookingAcknowledgementPrefix(sede, rawText) {
  if (!sede || !rawText) return null;
  const weekdayName = extractWeekdayNameFromText(rawText);
  const relativeDayLabel = extractRelativeDayLabelFromText(rawText);
  const includesTime = messageIncludesSpecificAppointmentTime(rawText);
  const dayPart = weekdayName ? `el ${weekdayName}` : relativeDayLabel ? `para ${relativeDayLabel}` : '';
  if (dayPart && includesTime) {
    return `Entiendo que te gustaría turno ${dayPart} a esa hora en ${sede.displayName}. Por acá no confirmamos horarios puntuales ni disponibilidad.`;
  }
  if (dayPart) {
    return `Perfecto, ${dayPart} en ${sede.displayName}. Por acá no agendamos por este chat.`;
  }
  if (includesTime) {
    return `Entiendo que querés un horario puntual en ${sede.displayName}. Por acá no confirmamos disponibilidad.`;
  }
  return null;
}

function ensureReplyIncludesAgendaLink(replyText, linkUrl) {
  if (!replyText || typeof replyText !== 'string') return replyText;
  if (!linkUrl || typeof linkUrl !== 'string' || linkUrl.trim().length === 0) return replyText.trim();
  const trimmedReply = replyText.trim();
  if (trimmedReply.includes(linkUrl)) return trimmedReply;
  if (/https?:\/\/\S+/i.test(trimmedReply)) return trimmedReply;
  return `${trimmedReply}\n${linkUrl}`;
}

function replyTextContainsPlaceholderAgendaLink(replyText) {
  if (!replyText || typeof replyText !== 'string') return false;
  const normalized = normalizeForMatch(replyText);
  return (
    normalized.includes('[link de agenda]') ||
    normalized.includes('link de agenda]') ||
    normalized.includes('siguiente link') ||
    normalized.includes('este link para ver')
  );
}

function messageLooksLikePreferredDayForBooking(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const weekdayName = extractWeekdayNameFromText(rawText);
  if (!weekdayName) return false;
  if (messageLooksLikeBookingIntent(rawText)) return true;
  if (messageIncludesSpecificAppointmentTime(rawText)) return true;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const preferenceSignals = [
    'por favor',
    'prefiero',
    'me queda',
    'me viene',
    'quiero',
    'puede ser',
    'dale',
    'ok',
    'si',
    'sí',
  ];
  const hasPreferenceSignal = preferenceSignals.some((signal) => normalized.includes(signal));
  const wordCount = normalized.split(' ').filter(Boolean).length;
  return hasPreferenceSignal || wordCount <= 4;
}

function getSedeClinicHours(entry) {
  if (!entry || typeof entry !== 'object' || !entry.envKey) return null;
  return SEDE_CLINIC_HOURS_BY_ENV_KEY[entry.envKey] || null;
}

function messageIncludesSpecificAppointmentTime(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    /\b\d{1,2}\s*(js|hs|hrs|horas)\b/.test(normalized) ||
    /\b\d{1,2}(js|hs)\b/.test(normalized) ||
    /\b\d{1,2}:\d{2}\b/.test(normalized) ||
    /\ba las \d{1,2}\b/.test(normalized)
  );
}

function buildPreferredDayBookingReply(sede, weekdayName, priorState = null, rawText = '') {
  if (isReferralOnlySedeEntry(sede)) {
    return buildReferralOnlySedeBookingReply(sede);
  }
  const includesSpecificTime = messageIncludesSpecificAppointmentTime(rawText);
  if (weekdayName) {
    if (hasBookingLinkInStateForSede(priorState, sede)) {
      const linkUrl = resolveBookingLinkUrlFromState(priorState, sede);
      const timeNote = includesSpecificTime
        ? ' Por acá no confirmamos horarios puntuales; en el link ves qué hay disponible.'
        : '';
      return `Perfecto. Para ver si hay turno el ${weekdayName} en ${sede.displayName}, revisá la agenda en el link que ya te pasé:\n${linkUrl}${timeNote}\nPor acá no agendamos.`;
    }
    const timeNote = includesSpecificTime
      ? ' Por acá no confirmamos horarios puntuales; en el link ves qué hay disponible.'
      : '';
    return `Perfecto. Para ver si hay turno el ${weekdayName} en ${sede.displayName}, elegí día y horario en el link.${timeNote} Por acá no agendamos.\n${getAgendaUrl(sede) || ''}`.trim();
  }
  return buildScheduleQuestionLinkMessage(sede, priorState);
}

async function fetchOpenAiBookingPolicyReply(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;

  const modelName = getOpenAiModelName();
  const basePrompt = loadAgenteLiberSystemPrompt();
  const sede = options.sede;
  const linkUrl = options.linkUrl || (sede ? getAgendaUrl(sede) : null);
  const systemPrompt = [
    typeof basePrompt === 'string' && basePrompt.trim().length > 0
      ? basePrompt.trim()
      : FALLBACK_AGENTE_LIBER_SYSTEM_PROMPT,
    '',
    'Situación: el paciente quiere sacar turno (a veces con día u hora concreta) por WhatsApp.',
    'Reglas obligatorias en tu respuesta:',
    '- Explicá brevemente que por este chat NO se agendan turnos ni se confirman horarios puntuales.',
    '- Indicá que debe usar el link de agenda online para ver disponibilidad y reservar.',
    linkUrl ? `- Incluí este link de agenda en una línea aparte: ${linkUrl}` : '',
    sede && sede.displayName ? `- Sede: ${sede.displayName}.` : '',
    options.weekdayName ? `- El paciente mencionó preferencia: ${options.weekdayName}.` : '',
    options.includesTime ? '- Mencionó un horario concreto; no confirmes que hay turno a esa hora.' : '',
    'Máximo 3 oraciones cortas. Empático, sin repetir preguntas innecesarias. No uses markdown.',
  ]
    .filter(Boolean)
    .join('\n');

  const priorState = options.priorState;
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    profileDisplayName: options.profileDisplayName,
    conversationContext: priorState ? buildIntentRoutingOpenAiContext(priorState) : '',
    lastAssistantMessage:
      priorState && typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText : '',
  });

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
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    return text.trim();
  } catch (error) {
    console.error('OpenAI booking policy reply failed', error);
    return null;
  }
}

function buildGenericBookingPolicyReplyForSede(sede, priorState = null) {
  if (isReferralOnlySedeEntry(sede)) {
    return buildReferralOnlySedeBookingReply(sede);
  }
  if (
    priorState &&
    (hasBookingLinkInStateForSede(priorState, sede) ||
      conversationLooksLikeOngoingBookingLinkGuidance(priorState))
  ) {
    return buildBookingLinkStepByStepGuidanceReply(priorState, sede);
  }
  const linkUrl = getAgendaUrl(sede);
  if (linkUrl) {
    return `En ${sede.displayName} los turnos se reservan solo con el link de agenda (por acá no agendamos por chat). Elegí día y horario acá:\n${linkUrl}`;
  }
  const assistancePhone = resolveClinicAssistancePhoneNumberForSedeEntry(sede);
  return `En ${sede.displayName} los turnos se reservan solo con el link de agenda online. Si necesitás ayuda con el link, escribinos al ${assistancePhone}.`;
}

function conversationAlreadySharedBookingLink(priorState) {
  return conversationLooksLikeOngoingBookingLinkGuidance(priorState);
}

function buildBookingLinkStepByStepGuidanceReply(priorState, sedeEntry = null) {
  const lastSede = sedeEntry || resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  if (isReferralOnlySedeEntry(lastSede)) {
    return buildReferralOnlySedeBookingReply(lastSede);
  }
  const cityName = lastSede ? lastSede.displayName : 'la sede';
  const lastBotReplyText =
    typeof priorState?.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  const offeredStepByStep =
    lastBotReplyText.includes('paso a paso') || lastBotReplyText.includes('te guio') || lastBotReplyText.includes('te guío');
  const assistanceMessage = buildBookingPersonalAssistanceMessage(priorState, lastSede);
  if (offeredStepByStep) {
    return `Dale. En el link que ya te pasé elegís día y horario en ${cityName}, completás tus datos y confirmás la reserva. ${assistanceMessage}`;
  }
  return `Ya te pasé el link de ${cityName}. Abrilo, elegí el día y horario que te quede bien, completá tus datos y confirmá. ${assistanceMessage}`;
}

async function buildBookingPolicyReplyForSede(sede, priorState, currentMessage = '', options = {}) {
  if (isReferralOnlySedeEntry(sede)) {
    return buildReferralOnlySedeBookingReply(sede);
  }
  const requestText = resolvePendingBookingRequestText(priorState, currentMessage);
  const weekdayName =
    extractWeekdayNameFromText(requestText) ||
    (priorState &&
    typeof priorState.pendingBookingWeekday === 'string' &&
    priorState.pendingBookingWeekday.trim().length > 0
      ? priorState.pendingBookingWeekday.trim()
      : null);
  const relativeDayLabel = extractRelativeDayLabelFromText(requestText);
  const includesTime =
    messageIncludesSpecificAppointmentTime(requestText) ||
    Boolean(priorState && priorState.pendingBookingIncludesTime);
  const linkUrl = getAgendaUrl(sede);

  if (!weekdayName && !includesTime && !relativeDayLabel) {
    return buildGenericBookingPolicyReplyForSede(sede, priorState);
  }

  const rulesPrefix = buildPreferredSlotBookingAcknowledgementPrefix(sede, requestText || currentMessage);
  const replyParts = [];
  if (rulesPrefix) {
    replyParts.push(rulesPrefix);
  } else if (weekdayName && includesTime) {
    replyParts.push(
      `Entiendo que querés turno el ${weekdayName} a esa hora en ${sede.displayName}. Por acá no agendamos ni confirmamos horarios puntuales.`
    );
  } else if (weekdayName) {
    replyParts.push(
      `Perfecto, para el ${weekdayName} en ${sede.displayName}. Por acá no agendamos por este chat.`
    );
  } else if (relativeDayLabel) {
    replyParts.push(
      `Perfecto, para ${relativeDayLabel} en ${sede.displayName}. Por acá no agendamos por este chat.`
    );
  } else if (includesTime) {
    replyParts.push(
      `Entiendo que querés un horario puntual en ${sede.displayName}. Por acá no confirmamos disponibilidad.`
    );
  }
  if (linkUrl) {
    replyParts.push(`Revisá día y horario disponibles y reservá acá:\n${linkUrl}`);
  } else {
    replyParts.push(buildBookingPersonalAssistanceMessage(priorState, sede));
  }
  let rulesReply = replyParts.join('\n');
  if (getOpenAiApiKey() && isOpenAiReplyHumanizationEnabled()) {
    const humanized = await tryHumanizePatientReplyWithOpenAi(rulesReply, {
      priorState,
      profileDisplayName: options.profileDisplayName,
      userMessage: requestText || currentMessage,
      replyContext: 'booking_policy',
      conversationContext: priorState ? buildIntentRoutingOpenAiContext(priorState) : '',
    });
    if (humanized.reply && humanizedReplyPreservesCriticalFacts(rulesReply, humanized.reply)) {
      rulesReply = humanized.reply;
    }
  }
  return ensureReplyIncludesAgendaLink(rulesReply, linkUrl);
}

function buildPreservedIntentSessionPatch(priorState) {
  if (!priorState || typeof priorState !== 'object') return {};
  const patch = {
    greeted: Boolean(priorState.greeted),
    lastSeenAtMs: priorState.lastSeenAtMs,
    lastSedeEnvKey: priorState.lastSedeEnvKey,
    lastSedeDisplayName: priorState.lastSedeDisplayName,
    lastSedeOptionNumber: priorState.lastSedeOptionNumber,
    lastSedeAtMs: priorState.lastSedeAtMs,
    lastBotReplyAtMs: priorState.lastBotReplyAtMs,
    lastBotReplyText: priorState.lastBotReplyText,
    lastScheduleDiscussedAtMs: priorState.lastScheduleDiscussedAtMs,
    healthInsuranceName: priorState.healthInsuranceName,
    lastHealthInsuranceName: priorState.lastHealthInsuranceName,
    pendingBookingIntentAtMs: priorState.pendingBookingIntentAtMs,
    pendingPrivatePriceIntentAtMs: priorState.pendingPrivatePriceIntentAtMs,
    pendingConsultationPriceIntentAtMs: priorState.pendingConsultationPriceIntentAtMs,
    lastStudyType: priorState.lastStudyType,
    lastStudyPriceContextAtMs: priorState.lastStudyPriceContextAtMs,
  };
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined && value !== null)
  );
}

function stateHasPendingPrivatePriceIntent(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (priorState.state === 'awaiting_private_price_city') return true;
  const pendingAtMs = Number(priorState.pendingPrivatePriceIntentAtMs);
  return (
    Number.isFinite(pendingAtMs) && Date.now() - pendingAtMs <= PENDING_PRIVATE_PRICE_INTENT_WINDOW_MS
  );
}

function buildPendingPrivatePriceIntentStatePatch() {
  return {
    pendingPrivatePriceIntentAtMs: Date.now(),
    state: 'awaiting_private_price_city',
    explicitPrivateConsultationPriceRequested: true,
  };
}

function buildClearedPendingPrivatePriceIntentPatch() {
  return {
    pendingPrivatePriceIntentAtMs: null,
    explicitPrivateConsultationPriceRequested: null,
  };
}

function stateExplicitlyRequestedPrivateConsultationPrice(priorState) {
  return (
    priorState &&
    typeof priorState === 'object' &&
    Boolean(priorState.explicitPrivateConsultationPriceRequested)
  );
}

function shouldAskHealthInsuranceBeforeConsultationPrice(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (stateHasPendingConsultationPriceIntent(priorState)) return true;
  if (stateLooksLikeAwaitingConsultationPriceHealthInsurance(priorState)) return true;
  if (
    stateHasPendingPrivatePriceIntent(priorState) &&
    !stateExplicitlyRequestedPrivateConsultationPrice(priorState)
  ) {
    return true;
  }
  return false;
}

function buildAskSedeForPrivatePriceMessage() {
  return `Entendido. ¿Desde qué ciudad consultás: ${ACTIVE_SEDE_CITIES_LIST_MESSAGE}?`;
}

function normalizePriceTyposInText(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  return normalizeForMatch(rawText).replace(/\bpreio\b/g, 'precio');
}

function messageAsksGenericConsultationPrice(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageAsksAboutStudiesOrTests(rawText)) return false;
  if (messageAsksAboutStudyPrice(rawText)) return false;
  const normalized = normalizePriceTyposInText(rawText);
  if (
    normalized.includes('particular') ||
    /^y\s*particular\??$/.test(normalized) ||
    /^particular\??$/.test(normalized)
  ) {
    return false;
  }
  const mentionsConsultation =
    normalized.includes('consulta') || normalized.includes('turno') || normalized.includes('visita');
  const mentionsPrice =
    normalized.includes('precio') ||
    normalized.includes('costo') ||
    normalized.includes('valor') ||
    normalized.includes('cuanto sale') ||
    normalized.includes('cuanto cuesta') ||
    normalized.includes('cuanto esta') ||
    normalized.includes('cuanto es');
  return mentionsConsultation && mentionsPrice && !normalized.includes('particular');
}

function stateLooksLikeAwaitingConsultationPriceHealthInsurance(state) {
  return (
    state &&
    typeof state === 'object' &&
    state.state === 'awaiting_consultation_price_health_insurance' &&
    Number.isFinite(Number(state.awaitingConsultationPriceHealthInsuranceAtMs))
  );
}

function stateHasPendingConsultationPriceIntent(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (stateLooksLikeAwaitingConsultationPriceHealthInsurance(priorState)) return true;
  const pendingAtMs = Number(priorState.pendingConsultationPriceIntentAtMs);
  return (
    Number.isFinite(pendingAtMs) &&
    Date.now() - pendingAtMs <= PENDING_CONSULTATION_PRICE_INTENT_WINDOW_MS
  );
}

function buildPendingConsultationPriceIntentStatePatch() {
  return {
    pendingConsultationPriceIntentAtMs: Date.now(),
    state: 'awaiting_consultation_price_health_insurance',
    awaitingConsultationPriceHealthInsuranceAtMs: Date.now(),
    explicitPrivateConsultationPriceRequested: false,
  };
}

function buildClearedPendingConsultationPriceIntentPatch() {
  return {
    pendingConsultationPriceIntentAtMs: null,
    awaitingConsultationPriceHealthInsuranceAtMs: null,
  };
}

function buildAskSedeForConsultationPriceMessage() {
  return `Entendido. ¿Desde qué ciudad consultás: ${ACTIVE_SEDE_CITIES_LIST_MESSAGE}?`;
}

function buildAskHealthInsuranceForConsultationPriceMessage() {
  return 'Antes de pasarte el valor, ¿qué obra social/prepaga tenés?';
}

async function buildConsultationPriceReplyForSedeAndHealthInsurance(sede, healthInsuranceName, priorState) {
  const replyOptions = { suppressBookingLinkOffer: true, replyContext: 'consultation_price' };
  const plusReply = await buildHealthInsurancePlusReplyOrAskCity(
    sede,
    healthInsuranceName,
    priorState,
    replyOptions
  );
  if (plusReply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
    return await buildHealthInsuranceMismatchReplyForKnownSede(sede, healthInsuranceName);
  }
  return plusReply;
}

async function buildReplyAfterSedeSelection(sede, priorState, bodyText = '') {
  if (messageLooksLikeSedeAddressInquiry(bodyText)) {
    return buildSedeAddressReply(priorState, sede);
  }
  if (messageAsksGenericConsultationPrice(bodyText)) {
    const healthInsuranceName =
      resolveActiveHealthInsuranceNameFromState(priorState) ||
      tryExtractHealthInsuranceName(bodyText) ||
      (await resolveHealthInsuranceNameFromMessage(bodyText, priorState));
    if (healthInsuranceName) {
      return buildConsultationPriceReplyForSedeAndHealthInsurance(sede, healthInsuranceName, priorState);
    }
    return buildAskHealthInsuranceForConsultationPriceMessage();
  }
  if (shouldAskHealthInsuranceBeforeConsultationPrice(priorState)) {
    return buildAskHealthInsuranceForConsultationPriceMessage();
  }
  const activeHealthInsuranceName = resolveActiveHealthInsuranceNameFromState(priorState);
  if (
    activeHealthInsuranceName &&
    sede &&
    (stateHasRecentHealthInsuranceDiscussionContext(priorState) ||
      messageLooksLikeAlternateSedeFollowUp(bodyText))
  ) {
    const healthInsuranceReply = await buildHealthInsurancePlusReplyOrAskCity(
      sede,
      activeHealthInsuranceName,
      priorState,
      { suppressBookingLinkOffer: true, replyContext: 'health_insurance_info' }
    );
    if (healthInsuranceReply !== 'ASK_CITY_FOR_HEALTH_INSURANCE') {
      return healthInsuranceReply;
    }
  }
  if (
    stateHasPendingPrivatePriceIntent(priorState) &&
    stateExplicitlyRequestedPrivateConsultationPrice(priorState)
  ) {
    return await buildPrivatePriceReply(sede);
  }
  const bookingRequestText = resolvePendingBookingRequestText(priorState, bodyText);
  const isBareSedePick =
    messageLooksLikeBareSedeOptionAnswer(bodyText) || messageLooksLikeSedeOnlyAnswer(bodyText);
  const continuesBookingAfterSedePick =
    isBareSedePick &&
    (stateHasPendingBookingDetails(priorState) ||
      stateHasRecentBookingConversationContext(priorState) ||
      stateLooksLikeAwaitingSedeSelection(priorState) ||
      messageLooksLikeBookingIntent(bookingRequestText));
  if (continuesBookingAfterSedePick && !userMessageRequestsSpecificAppointmentSlot(bookingRequestText, priorState)) {
    return buildGenericBookingPolicyReplyForSede(sede, priorState);
  }
  if (
    stateHasPendingBookingDetails(priorState) ||
    messageLooksLikeBookingIntent(bookingRequestText)
  ) {
    return buildBookingPolicyReplyForSede(sede, priorState, bookingRequestText);
  }
  if (isBareSedePick) {
    if (
      stateHasRecentBookingConversationContext(priorState) ||
      stateLooksLikeAwaitingSedeSelection(priorState) ||
      stateHasPendingBookingDetails(priorState)
    ) {
      return buildBookingPolicyReplyForSede(sede, priorState, bookingRequestText);
    }
    if (priorState && priorState.state === 'awaiting_private_price_city') {
      return await buildPrivatePriceReply(sede);
    }
    return buildSedeConfirmedHelpMessage(sede);
  }
  if (priorState && priorState.state === 'awaiting_private_price_city') {
    return await buildPrivatePriceReply(sede);
  }
  const shouldContinuePendingStudyFlow =
    stateHasRecentStudyPriceContext(priorState) &&
    (messageLooksLikeAnyPriceQuestion(bodyText) ||
      Boolean(getStudyTypeFromText(bodyText)) ||
      messageMatchesStudiesTopic(bodyText));
  if (shouldContinuePendingStudyFlow) {
    const studiesReply = await buildStudiesInformationReply(
      mergeConversationStatePreservingGreeting(priorState, {}, buildLastSedeStatePatch(sede) || {}),
      bodyText,
      { forcePriceFlow: messageLooksLikeAnyPriceQuestion(bodyText) }
    );
    const flattenedStudiesReply = flattenStudiesReplyPayload(studiesReply);
    if (flattenedStudiesReply) {
      return flattenedStudiesReply;
    }
  }
  return buildSedeConfirmedHelpMessage(sede);
}

async function tryHandleSedeSelectionAnswer(from, bodyText, priorState, profileDisplayName) {
  if (
    messageAsksGenericConsultationPrice(bodyText) ||
    messageLooksLikeCombinedConsultationAndStudyPriceInquiry(bodyText) ||
    (messageLooksLikeAnyPriceQuestion(bodyText) &&
      findSedeFromText(bodyText) &&
      messageLooksLikeHealthInsurancePlusQuestion(bodyText))
  ) {
    return false;
  }
  if (
    messageLooksLikeAlternateSedeFollowUp(bodyText) &&
    stateHasRecentHealthInsuranceDiscussionContext(priorState) &&
    resolveActiveHealthInsuranceNameFromState(priorState)
  ) {
    return false;
  }
  const recentlyAskedSedeSelection = conversationRecentlyAskedSedeSelection(priorState);
  const isSedeSelectionAttempt =
    ((messageLooksLikeSedeOnlyAnswer(bodyText) || messageLooksLikeBareSedeOptionAnswer(bodyText)) &&
      !stateConflictsWithSedeOnlyAnswer(priorState)) ||
    messageLooksLikeVagueAnswer(bodyText) ||
    messageLooksLikeSedeSelectionConfusion(bodyText) ||
    messageLooksLikePossibleSedeTypoAnswer(bodyText);

  if (
    userMessageRequiresFreshSedeForBooking(bodyText, priorState) &&
    !messageLooksLikeBareSedeOptionAnswer(bodyText) &&
    !messageLooksLikePossibleSedeTypoAnswer(bodyText)
  ) {
    return false;
  }

  if (!recentlyAskedSedeSelection && !isSedeSelectionAttempt) return false;
  if (
    recentlyAskedSedeSelection &&
    !isSedeSelectionAttempt &&
    messageConflictsWithSedeSelectionReprompt(bodyText)
  ) {
    return false;
  }

  const sede = await resolveSedeFromTextWithOpenAi(bodyText);
  if (!sede) {
    if (!recentlyAskedSedeSelection && !messageLooksLikePossibleSedeTypoAnswer(bodyText)) return false;
    const repromptText = messageLooksLikeSedeSelectionConfusion(bodyText)
      ? `Escribí solo el número de la sede. ${buildSedeNumberedOptionsSuffix()}`
      : messageLooksLikePossibleSedeTypoAnswer(bodyText)
        ? `No llegué a entender la sede. ${buildSedeNumberedOptionsSuffix()}`
        : buildConsolidatedAskSedePrompt();
    const wrapped = buildAutoReplyWithGreetingIfNeeded(repromptText, profileDisplayName, priorState);
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(
        priorState,
        buildAwaitingSedeSelectionStatePatch(),
        wrapped.nextStatePatch
      )
    );
    await sendWhatsAppText(from, wrapped.messageText);
    return true;
  }

  const bookingRequestText = resolvePendingBookingRequestText(priorState, bodyText);
  const reply = await buildReplyAfterSedeSelection(sede, priorState, bodyText);
  const answeredConsultationPriceInMessage = messageAsksGenericConsultationPrice(bodyText);
  const healthInsuranceNameForPrice =
    answeredConsultationPriceInMessage
      ? resolveActiveHealthInsuranceNameFromState(priorState) ||
        tryExtractHealthInsuranceName(bodyText) ||
        (await resolveHealthInsuranceNameFromMessage(bodyText, priorState, { profileDisplayName }))
      : null;
  const finalizedReply = await finalizePatientReplyText(reply, {
    priorState,
    profileDisplayName,
    userMessage: bodyText,
    replyContext: answeredConsultationPriceInMessage ? 'consultation_price' : 'sede_selection',
    suppressBookingLinkOffer: answeredConsultationPriceInMessage,
    conversationContext: buildIntentRoutingOpenAiContext(priorState),
  });
  const wrapped = buildAutoReplyWithGreetingIfNeeded(finalizedReply, profileDisplayName, priorState);
  const continuesConsultationPriceFlow =
    shouldAskHealthInsuranceBeforeConsultationPrice(priorState) ||
    (answeredConsultationPriceInMessage && !healthInsuranceNameForPrice);
  const continuesPrivatePriceFlow =
    stateHasPendingPrivatePriceIntent(priorState) &&
    stateExplicitlyRequestedPrivateConsultationPrice(priorState);
  const continuesBookingFlow =
    stateHasPendingBookingDetails(priorState) ||
    messageLooksLikeBookingIntent(bookingRequestText) ||
    stateHasRecentBookingConversationContext(priorState) ||
    (recentlyAskedSedeSelection &&
      (messageLooksLikeBareSedeOptionAnswer(bodyText) || messageLooksLikeSedeOnlyAnswer(bodyText)));
  const nextConversationState = continuesConsultationPriceFlow
    ? {
        state: 'awaiting_consultation_price_health_insurance',
        awaitingConsultationPriceHealthInsuranceAtMs: Date.now(),
      }
    : continuesPrivatePriceFlow
    ? buildAwaitingLinkConfirmationState(sede, 'after_private_price')
    : continuesBookingFlow
      ? buildClearedAwaitingLinkConfirmationStatePatch()
      : priorState || {};
  const bookingFlowStatePatch = continuesBookingFlow
    ? {
        ...(buildLinkSentStatePatch(sede) || {}),
        ...buildClearedPendingBookingDetailsPatch(),
      }
    : {};
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(
      priorState,
      nextConversationState,
      {
        ...(wrapped.nextStatePatch || {}),
        ...(buildLastSedeStatePatch(sede) || {}),
        ...(healthInsuranceNameForPrice
          ? {
              healthInsuranceName: healthInsuranceNameForPrice,
              lastHealthInsuranceName: healthInsuranceNameForPrice,
              ...buildLastHealthInsuranceDiscussionStatePatch(),
            }
          : {}),
        ...(answeredConsultationPriceInMessage && healthInsuranceNameForPrice
          ? {
              ...buildClearedPendingConsultationPriceIntentPatch(),
              ...buildConsultationPriceAnsweredStatePatch(),
            }
          : {}),
        ...(continuesPrivatePriceFlow ? buildClearedPendingPrivatePriceIntentPatch() : {}),
        ...(continuesBookingFlow ? buildClearedPendingBookingIntentPatch() : buildClearedStudyPricingContextPatch()),
        ...bookingFlowStatePatch,
        ...buildLastBotReplyStatePatch(wrapped.messageText),
      }
    )
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

function buildGreetingSentence(profileDisplayName) {
  const hasName = typeof profileDisplayName === 'string' && profileDisplayName.trim().length > 0;
  if (hasName) {
    return `Hola ${profileDisplayName.trim()}, soy la asistente del Dr. Liber Acosta 😊.`;
  }
  return 'Hola, soy la asistente del Dr. Liber Acosta 😊.';
}

function buildGreetingOnlyOpeningMessages(profileDisplayName, priorState) {
  const alreadyGreetedInSession = shouldTreatAsAlreadyGreeted(priorState, Date.now());
  if (alreadyGreetedInSession) {
    return {
      firstMessage: '¡Hola! 😊 Qué bueno que volvés a elegir al Dr.',
      secondMessage: 'Contame en qué te puedo ayudar.',
    };
  }
  return { firstMessage: `${buildGreetingSentence(profileDisplayName)} Contame en qué te puedo ayudar.`, secondMessage: null };
}

function shouldSkipGreetingOnlyReply(priorState, bodyText) {
  if (messageLooksLikeBookingIntent(bodyText) || messageExplicitlyRequestsBookingLink(bodyText)) return true;
  if (!priorState || typeof priorState !== 'object') return false;
  if (conversationRecentlyAskedSedeSelection(priorState)) return true;
  if (stateHasPendingBookingIntent(priorState)) return true;
  if (stateHasPendingConsultationPriceIntent(priorState)) return true;
  if (stateHasPendingPrivatePriceIntent(priorState)) return true;
  if (priorState.state === 'awaiting_sede_selection') return true;
  const lastBotReplyAtMs = Number(priorState.lastBotReplyAtMs);
  if (!priorState.greeted || !Number.isFinite(lastBotReplyAtMs)) return false;
  if (Date.now() - lastBotReplyAtMs > SMALL_TALK_COOLDOWN_MS) return false;
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? normalizeForMatch(priorState.lastBotReplyText) : '';
  if (
    lastBotReplyText.includes('en que te puedo ayudar') ||
    lastBotReplyText.includes('para que sede') ||
    lastBotReplyText.includes('desde que ciudad')
  ) {
    return true;
  }
  return false;
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
  const priorActiveSede =
    priorState && typeof priorState === 'object'
      ? {
          sedeEnvKey: priorState.sedeEnvKey,
          sedeDisplayName: priorState.sedeDisplayName,
          sedeOptionNumber: priorState.sedeOptionNumber,
        }
      : null;
  const priorHealthInsuranceName =
    priorState && typeof priorState === 'object'
      ? typeof priorState.lastHealthInsuranceName === 'string' && priorState.lastHealthInsuranceName.trim().length > 0
        ? priorState.lastHealthInsuranceName.trim()
        : typeof priorState.healthInsuranceName === 'string' && priorState.healthInsuranceName.trim().length > 0
          ? priorState.healthInsuranceName.trim()
          : null
      : null;
  const priorBookingLinkOfferAtMs =
    priorState && typeof priorState === 'object' ? Number(priorState.bookingLinkOfferAtMs) : NaN;
  const priorStudyContext =
    priorState && typeof priorState === 'object'
      ? {
          lastStudyType:
            typeof priorState.lastStudyType === 'string' && priorState.lastStudyType.trim().length > 0
              ? priorState.lastStudyType.trim()
              : null,
          lastStudyPriceContextAtMs: Number.isFinite(Number(priorState.lastStudyPriceContextAtMs))
            ? Number(priorState.lastStudyPriceContextAtMs)
            : null,
        }
      : null;
  const merged = { ...(nextState || {}) };
  if (patch && typeof patch === 'object') {
    Object.assign(merged, patch);
  }
  if (priorGreeted) {
    merged.greeted = true;
  }
  const explicitlyClearsLastSede =
    (nextState &&
      typeof nextState === 'object' &&
      Object.prototype.hasOwnProperty.call(nextState, 'lastSedeEnvKey') &&
      nextState.lastSedeEnvKey == null) ||
    (patch &&
      typeof patch === 'object' &&
      Object.prototype.hasOwnProperty.call(patch, 'lastSedeEnvKey') &&
      patch.lastSedeEnvKey == null);
  const explicitlyClearsActiveSede =
    (nextState &&
      typeof nextState === 'object' &&
      Object.prototype.hasOwnProperty.call(nextState, 'sedeEnvKey') &&
      nextState.sedeEnvKey == null) ||
    (patch &&
      typeof patch === 'object' &&
      Object.prototype.hasOwnProperty.call(patch, 'sedeEnvKey') &&
      patch.sedeEnvKey == null);
  // Keep last known sede unless explicitly overwritten or cleared.
  if (priorLastSede && typeof merged.lastSedeEnvKey !== 'string' && !explicitlyClearsLastSede) {
    Object.assign(merged, priorLastSede);
  }
  // Keep active/pending sede context unless explicitly overwritten or cleared.
  if (priorActiveSede && typeof merged.sedeEnvKey !== 'string' && !explicitlyClearsActiveSede) {
    Object.assign(merged, priorActiveSede);
  }
  if (priorHealthInsuranceName && typeof merged.lastHealthInsuranceName !== 'string') {
    merged.lastHealthInsuranceName = priorHealthInsuranceName;
  }
  if (
    typeof merged.healthInsuranceName === 'string' &&
    merged.healthInsuranceName.trim().length > 0 &&
    typeof merged.lastHealthInsuranceName !== 'string'
  ) {
    merged.lastHealthInsuranceName = merged.healthInsuranceName.trim();
  }
  const explicitlyClearsStudyPricingContext = nextStateExplicitlyClearsStudyPricingContext(nextState);
  if (
    !explicitlyClearsStudyPricingContext &&
    priorStudyContext &&
    priorStudyContext.lastStudyType &&
    !Object.prototype.hasOwnProperty.call(merged, 'lastStudyType')
  ) {
    merged.lastStudyType = priorStudyContext.lastStudyType;
  }
  if (
    !explicitlyClearsStudyPricingContext &&
    priorStudyContext &&
    Number.isFinite(priorStudyContext.lastStudyPriceContextAtMs) &&
    !Object.prototype.hasOwnProperty.call(merged, 'lastStudyPriceContextAtMs')
  ) {
    merged.lastStudyPriceContextAtMs = priorStudyContext.lastStudyPriceContextAtMs;
  }
  if (explicitlyClearsStudyPricingContext) {
    delete merged.lastStudyType;
    delete merged.lastStudyPriceContextAtMs;
    delete merged.awaitingStudyTypeForPriceAtMs;
    delete merged.awaitingStudyPriceHealthInsuranceAtMs;
  }
  if (
    Number.isFinite(priorBookingLinkOfferAtMs) &&
    priorBookingLinkOfferAtMs > 0 &&
    !Object.prototype.hasOwnProperty.call(merged, 'bookingLinkOfferAtMs')
  ) {
    merged.bookingLinkOfferAtMs = priorBookingLinkOfferAtMs;
  }
  const priorBookingLinkContext =
    priorState && typeof priorState === 'object'
      ? {
          lastBookingLinkUrl:
            typeof priorState.lastBookingLinkUrl === 'string' && priorState.lastBookingLinkUrl.trim().length > 0
              ? priorState.lastBookingLinkUrl.trim()
              : null,
          lastBookingLinkSentAtMs: Number.isFinite(Number(priorState.lastBookingLinkSentAtMs))
            ? Number(priorState.lastBookingLinkSentAtMs)
            : null,
          lastBookingLinkSedeEnvKey:
            typeof priorState.lastBookingLinkSedeEnvKey === 'string' ? priorState.lastBookingLinkSedeEnvKey : null,
          lastBookingLinkSedeDisplayName:
            typeof priorState.lastBookingLinkSedeDisplayName === 'string'
              ? priorState.lastBookingLinkSedeDisplayName
              : null,
        }
      : null;
  if (
    priorBookingLinkContext &&
    priorBookingLinkContext.lastBookingLinkUrl &&
    !Object.prototype.hasOwnProperty.call(merged, 'lastBookingLinkUrl')
  ) {
    merged.lastBookingLinkUrl = priorBookingLinkContext.lastBookingLinkUrl;
    if (
      priorBookingLinkContext.lastBookingLinkSentAtMs &&
      !Object.prototype.hasOwnProperty.call(merged, 'lastBookingLinkSentAtMs')
    ) {
      merged.lastBookingLinkSentAtMs = priorBookingLinkContext.lastBookingLinkSentAtMs;
    }
    if (
      priorBookingLinkContext.lastBookingLinkSedeEnvKey &&
      !Object.prototype.hasOwnProperty.call(merged, 'lastBookingLinkSedeEnvKey')
    ) {
      merged.lastBookingLinkSedeEnvKey = priorBookingLinkContext.lastBookingLinkSedeEnvKey;
    }
    if (
      priorBookingLinkContext.lastBookingLinkSedeDisplayName &&
      !Object.prototype.hasOwnProperty.call(merged, 'lastBookingLinkSedeDisplayName')
    ) {
      merged.lastBookingLinkSedeDisplayName = priorBookingLinkContext.lastBookingLinkSedeDisplayName;
    }
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
    normalized.includes('coseguro') ||
    normalized.includes('pami') ||
    normalized.includes('pani')
  );
}

function messageStatesHealthInsuranceMembership(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('tengo obra social') ||
    normalized.includes('tengo prepaga') ||
    normalized.includes('mi obra social') ||
    normalized.includes('mi prepaga') ||
    normalized.includes('soy de osde') ||
    normalized.includes('soy de pami') ||
    normalized.includes('soy de pani') ||
    normalized.includes('soy osde') ||
    normalized.includes('soy pami')
  );
}

function normalizeHealthInsuranceCanonicalName(healthInsuranceName) {
  if (!healthInsuranceName || typeof healthInsuranceName !== 'string') return '';
  const normalized = normalizeForMatch(healthInsuranceName).trim();
  if (!normalized) return '';
  if (normalized.includes('pami') || normalized === 'pani' || normalized === 'pam') return 'PAMI';
  return healthInsuranceName.trim();
}

function isKnownNotAcceptedHealthInsurance(healthInsuranceName) {
  const canonicalName = normalizeHealthInsuranceCanonicalName(healthInsuranceName);
  return KNOWN_NOT_ACCEPTED_HEALTH_INSURANCE_CANONICAL_NAMES.includes(canonicalName);
}

function tryExtractHealthInsuranceNameFromPhrase(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const normalized = normalizeForMatch(rawText);
  if (normalized.includes('pami') || normalized.includes('pani') || /\bpam\b/.test(normalized)) {
    return 'PAMI';
  }
  const phrasePatterns = [
    /(?:tengo|tiene|tenes|tenés)\s+(?:la\s+)?(?:obra social|prepaga)\s+([a-z0-9][a-z0-9\s.-]{1,40})/,
    /(?:obra social|prepaga)\s+(?:es\s+)?([a-z0-9][a-z0-9\s.-]{1,40})/,
    /(?:soy de|tengo)\s+([a-z0-9][a-z0-9\s.-]{1,30})/,
  ];
  for (const phrasePattern of phrasePatterns) {
    const match = normalized.match(phrasePattern);
    if (!match || !match[1]) continue;
    const candidate = match[1].trim();
    const fromRules = tryExtractHealthInsuranceName(candidate);
    if (fromRules) return fromRules;
    if (candidate.includes('pami') || candidate.includes('pani')) return 'PAMI';
  }
  return null;
}

async function resolveHealthInsuranceNameFromMessage(bodyText, priorState, options = {}) {
  if (
    await resolvePrivatePayWithoutHealthInsuranceFromMessage(bodyText, {
      priorState,
      profileDisplayName: options.profileDisplayName,
    })
  ) {
    return null;
  }
  const fromRules = tryExtractHealthInsuranceName(bodyText) || tryExtractHealthInsuranceNameFromPhrase(bodyText);
  if (fromRules) return normalizeHealthInsuranceCanonicalName(fromRules);
  if (!messageLooksLikeGenericInstitutionHealthInsurance(bodyText)) {
    const fromSheets = await tryResolveHealthInsuranceNameFromSheetsFuzzy(bodyText);
    if (fromSheets) return fromSheets;
  }
  if (messageLooksLikeHealthInsurancePlusQuestion(bodyText) || messageStatesHealthInsuranceMembership(bodyText)) {
    const fromOpenAi = await tryResolveHealthInsuranceNameWithOpenAi(bodyText);
    if (fromOpenAi) return fromOpenAi;
  }
  return null;
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
  if (normalized.includes('sancor mutual') || normalized.includes('mutual sancor')) return 'Sancor Mutual';
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
  if (normalized.includes('pami') || normalized.includes('pani') || /\bpam\b/.test(normalized)) return 'PAMI';
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

function messageAsksAboutCardiologicoHealthInsuranceInCorrientes(rawText, priorState) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsCardiologico =
    normalized.includes('cardiologic') || normalized.includes('cardiologico') || normalized.includes('cardiológico');
  if (!mentionsCardiologico) return false;
  const sedeFromMessage = findSedeFromText(rawText);
  const lastSede = resolveLastSedeEntryFromState(priorState);
  const sede = sedeFromMessage || lastSede;
  return Boolean(sede && sede.envKey === 'CALENDLY_CORRIENTES');
}

async function buildHealthInsurancePlusReplyOrAskCity(cityEntry, healthInsuranceName, priorState, options = {}) {
  debugBotLog('buildHealthInsurancePlusReplyOrAskCity', {
    cityDisplayName: cityEntry?.displayName,
    healthInsuranceName,
  });
  const canonicalHealthInsuranceName = normalizeHealthInsuranceCanonicalName(healthInsuranceName);
  const displayHealthInsuranceName = canonicalHealthInsuranceName || healthInsuranceName;
  const conciseReply = options.replyContext === 'health_insurance_info' || options.suppressBookingLinkOffer;

  if (isKnownNotAcceptedHealthInsurance(displayHealthInsuranceName)) {
    return appendBookingLinkOfferIfAllowed(
      priorState,
      `En ${cityEntry.displayName} no trabajamos con ${displayHealthInsuranceName}.`,
      options
    );
  }

  const plusRule = await lookupPlusRule(cityEntry.displayName, healthInsuranceName);
  // Prices are not provided via WhatsApp; always route to evaluation/office confirmation.

  if (!plusRule) {
    // Fallback (hard rule) for the stable no-plus set, to avoid unnecessary derivations when
    // the plus sheet is temporarily unavailable or does not match the exact naming.
    const cityNormalized = normalizeForMatch(cityEntry.displayName);
    const osNormalized = normalizeForMatch(healthInsuranceName);
    const isOsde = osNormalized.includes('osde');
    const isIsunne = osNormalized.includes('isunne');
    const isSancor = osNormalized.includes('sancor') && !osNormalized.includes('mutual');
    const isKnownNoPlus =
      (cityNormalized.includes('corrientes') && (isOsde || isIsunne || isSancor)) ||
      (cityNormalized.includes('resistencia') && (isOsde || isIsunne || isSancor));
    if (isKnownNoPlus) {
      return appendBookingLinkOfferIfAllowed(
        priorState,
        `En ${cityEntry.displayName} trabajamos con ${healthInsuranceName} sin plus.`,
        options
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
    if (conciseReply) {
      return appendBookingLinkOfferIfAllowed(
        priorState,
        `En ${cityEntry.displayName} no trabajamos con ${displayHealthInsuranceName}.`,
        options
      );
    }
    return MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
  }

  const osDisplayName = displayHealthInsuranceName;
  if (!plusRule.isAccepted) {
    const notAcceptedMessage = conciseReply
      ? `En ${cityEntry.displayName} no trabajamos con ${osDisplayName}.`
      : `En ${cityEntry.displayName} no trabajamos con ${osDisplayName}. Si querés, podés atenderte de manera particular; para confirmarte valores y cómo proceder, lo ideal es una consulta de evaluación.`;
    return appendBookingLinkOfferIfAllowed(priorState, notAcceptedMessage, options);
  }

  if (plusRule.hasPlus) {
    const plusFormatted =
      Number.isFinite(plusRule.plusAmountArs) && plusRule.plusAmountArs != null
        ? formatArsAmount(plusRule.plusAmountArs)
        : null;
    if (plusFormatted) {
      return appendBookingLinkOfferIfAllowed(
        priorState,
        `En ${cityEntry.displayName} con ${osDisplayName} hay un plus de $${plusFormatted}.`,
        options
      );
    }
    return MISSING_INFORMATION_CALL_OFFICE_MESSAGE;
  }

  return appendBookingLinkOfferIfAllowed(
    priorState,
    `En ${cityEntry.displayName} trabajamos con ${osDisplayName} sin plus.`,
    options
  );
}

function buildAskHealthInsuranceNameMessage(rawText = '') {
  if (messageAsksIfParticularIsAvailable(rawText)) {
    return 'Sí, también atendemos de forma particular. ¿Qué obra social/prepaga tenés? Te digo si la aceptamos.';
  }
  return '¿Qué obra social/prepaga tenés? Te digo si la aceptamos.';
}

function messageExplicitlyAsksPrivateConsultationPrice(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageAsksAboutStudiesOrTests(rawText)) return false;
  if (messageAsksAboutStudyPrice(rawText)) return false;
  const normalized = normalizePriceTyposInText(rawText);
  if (/^y\s*particular\??$/.test(normalized) || /^particular\??$/.test(normalized)) return true;
  return (
    normalized.includes('consulta particular') ||
    (normalized.includes('consulta') && normalized.includes('particular')) ||
    normalized.includes('atencion particular') ||
    normalized.includes('atienden particular') ||
    normalized.includes('precio del turno') ||
    normalized.includes('precio turno') ||
    (normalized.includes('control') && mentionsPriceInNormalizedText(normalized)) ||
    (normalized.includes('seguimiento') && mentionsPriceInNormalizedText(normalized)) ||
    (normalized.includes('reconsulta') && mentionsPriceInNormalizedText(normalized)) ||
    (normalized.includes('re consulta') && mentionsPriceInNormalizedText(normalized))
  );
}

function mentionsPriceInNormalizedText(normalized) {
  return (
    normalized.includes('precio') ||
    normalized.includes('costo') ||
    normalized.includes('valor') ||
    normalized.includes('cuanto sale') ||
    normalized.includes('cuanto cuesta') ||
    normalized.includes('cuanto esta') ||
    normalized.includes('cuanto es')
  );
}

function replyOffersStudyValueChoice(replyText) {
  if (typeof replyText !== 'string') return false;
  const normalized = normalizeForMatch(replyText);
  return (
    normalized.includes('te cuente el valor') ||
    normalized.includes('preferis agendar') ||
    normalized.includes('queres saber el valor') ||
    normalized.includes('valor de espirometria') ||
    normalized.includes('valor de espirometría')
  );
}

function replyAsksStudyTypeForPriceChoice(replyText) {
  if (typeof replyText !== 'string') return false;
  const normalized = normalizeForMatch(replyText);
  return (
    normalized.includes('espirometria o de test') ||
    normalized.includes('espirometria o test') ||
    normalized.includes('espirometria o alergia')
  );
}

function conversationExpectsStudyPriceOrTypeAnswer(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (stateLooksLikeAwaitingStudyTypeForPrice(priorState)) {
    const followUpAtMs = Number(priorState.awaitingStudyTypeForPriceAtMs);
    if (Number.isFinite(followUpAtMs) && Date.now() - followUpAtMs <= STUDY_TYPE_FOR_PRICE_WINDOW_MS) {
      return true;
    }
  }
  if (stateAwaitingStudyPriceFollowUp(priorState)) return true;
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  if (!lastBotReplyText) return false;
  if (!replyOffersStudyValueChoice(lastBotReplyText) && !replyAsksStudyTypeForPriceChoice(lastBotReplyText)) {
    return false;
  }
  const lastBotReplyAtMs = Number(priorState.lastBotReplyAtMs);
  return (
    Number.isFinite(lastBotReplyAtMs) &&
    Date.now() - lastBotReplyAtMs <= STUDY_PRICE_FOLLOW_UP_WINDOW_MS
  );
}

function messageLooksLikeColloquialStudyPriceAffirmation(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  if (/^si\s+eso/.test(normalized) || normalized.includes('si eso si eso') || normalized.includes('eso eso')) {
    return true;
  }
  if (normalized.includes('diria el chavo') || normalized.includes('diría el chavo') || normalized.includes('chavo')) {
    return true;
  }
  if (/^(eso|claro|exacto|obvio|tal cual)\b/.test(normalized)) return true;
  if (/^(si|dale)\b/.test(normalized) && normalized.split(' ').length <= 6) return true;
  return false;
}

function stateAwaitingStudyPriceFollowUp(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (priorState.state === 'awaiting_study_price_follow_up') {
    const followUpAtMs = Number(priorState.awaitingStudyPriceFollowUpAtMs);
    if (Number.isFinite(followUpAtMs) && Date.now() - followUpAtMs <= STUDY_PRICE_FOLLOW_UP_WINDOW_MS) {
      return true;
    }
  }
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  if (replyOffersStudyValueChoice(lastBotReplyText) || replyAsksStudyTypeForPriceChoice(lastBotReplyText)) {
    const lastBotReplyAtMs = Number(priorState.lastBotReplyAtMs);
    if (Number.isFinite(lastBotReplyAtMs) && Date.now() - lastBotReplyAtMs <= STUDY_PRICE_FOLLOW_UP_WINDOW_MS) {
      return true;
    }
  }
  return false;
}

function messageLooksLikeStudyPriceFollowUp(rawText, priorState) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageExplicitlyAsksPrivateConsultationPrice(rawText)) return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const affirmativePatterns = [
    /^si$/,
    /^si por favor$/,
    /^si dale$/,
    /^dale$/,
    /^ok$/,
    /^bueno$/,
    /^genial$/,
    /^perfecto$/,
    /^de una$/,
  ];
  const hasAffirmative = affirmativePatterns.some((pattern) => pattern.test(normalized));
  const hasColloquialAffirmation = messageLooksLikeColloquialStudyPriceAffirmation(rawText);
  const hasPriceAsk = messageLooksLikeAnyPriceQuestion(rawText);
  const expectsStudyAnswer = conversationExpectsStudyPriceOrTypeAnswer(priorState);
  if (expectsStudyAnswer && (hasAffirmative || hasColloquialAffirmation || hasPriceAsk || getStudyTypeFromText(rawText))) {
    return true;
  }
  if (!stateHasRecentStudyPriceContext(priorState)) return false;
  const awaitingFollowUp = stateAwaitingStudyPriceFollowUp(priorState);
  if (awaitingFollowUp && (hasAffirmative || hasColloquialAffirmation || hasPriceAsk)) return true;
  if (hasPriceAsk) {
    const knownHealthInsuranceName = resolveKnownHealthInsuranceNameForStudyPricing(priorState, rawText);
    const lastSede = resolveSedeEntryFromState(priorState) || resolveLastSedeEntryFromState(priorState);
    if (knownHealthInsuranceName && lastSede) return true;
  }
  return false;
}

function buildStudyPriceHintFromConversation(bodyText, priorState) {
  if (getStudyTypeFromText(bodyText)) return bodyText;
  if (priorState && typeof priorState.lastStudyType === 'string' && priorState.lastStudyType.trim().length > 0) {
    return `precio ${priorState.lastStudyType.trim()}`;
  }
  if (priorStateIndicatesSpirometryStudy(priorState)) return 'precio espirometría';
  const lastBotReplyText =
    priorState && typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText : '';
  if (normalizeForMatch(lastBotReplyText).includes('espirometr')) return 'precio espirometría';
  return bodyText;
}

function shouldRouteToStudyPrice(rawText, priorState) {
  if (messageLooksLikeFamilyConsultationCostEstimateInquiry(rawText)) return false;
  return (
    messageLooksLikeStudyPriceFollowUp(rawText, priorState) ||
    (stateHasRecentStudyPriceContext(priorState) &&
      messageLooksLikeAnyPriceQuestion(rawText) &&
      !messageExplicitlyAsksPrivateConsultationPrice(rawText))
  );
}

function messageLooksLikePrivatePriceQuestion(rawText, priorState = null) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageLooksLikeSpirometryOnlyInquiry(rawText)) return false;
  if (messageAsksAboutStudiesOrTests(rawText)) return false;
  if (messageAsksAboutStudyPrice(rawText)) return false;
  if (messageAsksGenericConsultationPrice(rawText)) return false;
  if (priorState && shouldRouteToStudyPrice(rawText, priorState)) return false;
  if (messageExplicitlyAsksPrivateConsultationPrice(rawText)) return true;
  const normalized = normalizePriceTyposInText(rawText);
  // "Tratamiento" is not a consultation price question; it depends on the case.
  if (normalized.includes('tratamiento') && !normalized.includes('consulta')) return false;
  if (priorState && stateHasRecentStudyPriceContext(priorState)) return false;
  return (
    normalized.includes('precio') ||
    normalized.includes('costo') ||
    normalized.includes('cuanto sale') ||
    normalized.includes('cuanto cuesta') ||
    normalized.includes('cuanto esta') ||
    normalized.includes('cuanto está') ||
    normalized.includes('cuanto es')
  );
}

function buildLastBotReplyStatePatch(messageText) {
  if (typeof messageText !== 'string' || messageText.trim().length === 0) return {};
  const patch = {
    lastBotReplyText: messageText.trim().slice(0, LAST_BOT_REPLY_TEXT_MAX_LENGTH),
    lastBotReplyAtMs: Date.now(),
  };
  if (replyAsksStudyTypeForPriceChoice(messageText)) {
    patch.state = 'awaiting_study_type_for_price';
    patch.awaitingStudyTypeForPriceAtMs = Date.now();
  } else if (replyOffersStudyValueChoice(messageText)) {
    patch.state = 'awaiting_study_price_follow_up';
    patch.awaitingStudyPriceFollowUpAtMs = Date.now();
  }
  return patch;
}

function messageLooksLikeAnyPriceQuestion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizePriceTyposInText(rawText);
  return (
    normalized.includes('precio') ||
    normalized.includes('costo') ||
    normalized.includes('valor') ||
    normalized.includes('total') ||
    normalized.includes('cuanto sale') ||
    normalized.includes('cuanto cuesta') ||
    normalized.includes('cuanto esta') ||
    normalized.includes('cuánto está') ||
    normalized.includes('cuanto es') ||
    normalized.includes('cuanto seria') ||
    normalized.includes('cuánto sería')
  );
}

function messageAsksIfParticularIsAvailable(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Avoid matching price questions; those are handled elsewhere.
  if (messageLooksLikePrivatePriceQuestion(rawText)) return false;
  return (
    normalized.includes('atienden particular') ||
    normalized.includes('atiende particular') ||
    normalized.includes('atenden particular') ||
    normalized.includes('atiende por particular') ||
    normalized.includes('atienden por particular') ||
    normalized.includes('solo particular') ||
    normalized.includes('o es solo particular') ||
    normalized.includes('es solo particular') ||
    normalized.includes('o particular') ||
    normalized === 'particular' ||
    normalized === 'particular?' ||
    normalized === 'particular.'
  );
}

function formatArsAmount(amount) {
  const integerAmount = Math.round(Number(amount));
  if (!Number.isFinite(integerAmount)) return null;
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(integerAmount);
}

function messageConfirmsLinkSend(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageRequestsPersonalBookingAssistance(rawText)) return false;
  if (messageClearlyRejectsLinkSend(rawText)) return false;
  if (messageLooksLikeAnyPriceQuestion(rawText)) return false;
  if (messageAsksWhereOrHowToBook(rawText)) return false;
  if (messageAsksExplicitlyHowToBookTurn(rawText)) return false;
  if (messageAsksHowBookingWorks(rawText)) return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    (normalized.includes('como') || normalized.includes('cómo')) &&
    (normalized.includes('turno') || normalized.includes('agend') || normalized.includes('reserv'))
  ) {
    return false;
  }

  // Accept short confirmations even with extra words: "si quiero", "si pasame el link", "dale pasalo"
  if (/^(si|dale|ok|oka|de una|listo|ya)\b/.test(normalized)) return true;
  if (/^(por favor|porfa|x favor)\b/.test(normalized)) return true;
  if (/^(gracias|genial|perfecto)\b/.test(normalized)) return true;
  if (/\bquiero agendar\b/.test(normalized)) return true;
  if (/\bquiero reservar\b/.test(normalized)) return true;
  if (/\bquiero (un )?turno\b/.test(normalized)) return true;
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

const BOOKING_LINK_OFFER_ASSISTANT_CONTEXT =
  'El asistente acaba de ofrecer pasar el link de agenda (por ejemplo: "¿Te lo mando?" o "Si querés, te paso el link para ver horarios y sacar turno").';

async function classifyAffirmativeIntentWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();

  const systemPrompt = [
    'Sos un clasificador para mensajes de WhatsApp en español rioplatense (Argentina).',
    'Tarea: decidir si el paciente CONFIRMA que quiere recibir el link de agenda que se le ofreció.',
    'Respondé solo un token: YES o NO.',
    'Reglas:',
    '- YES: confirma aunque sea informal, con errores o mezclado con otra frase.',
    '- YES ejemplos: "sí", "si quiero", "dale", "ok", "pasame el link", "por favor quiero agendar", "quiero agendar", "me gustaría", "bueno dale", "de una", "listo", "avancemos", "por favor", "porfa", "gracias", "joya", "perfecto".',
    '- NO: rechaza, pospone o pregunta otra cosa sin confirmar el link.',
    '- NO ejemplos: "no", "no por ahora", "después", "más tarde", "¿cuánto sale?", "¿qué es eso?".',
    '- Si el asistente acaba de ofrecer el link y el paciente dice solo "sí"/"dale"/"ok", devolvé YES.',
    '- Si no está claro, devolvé NO.',
  ].join('\n');

  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    lastAssistantMessage: options.lastAssistantMessage || buildMicroCommitmentMessage(),
    conversationContext: options.conversationContext || BOOKING_LINK_OFFER_ASSISTANT_CONTEXT,
    profileDisplayName: options.profileDisplayName,
  });

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
          { role: 'user', content: userContent },
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

async function decideNextActionForLinkConfirmationWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();

  const systemPrompt = [
    'Sos un router conversacional para un consultorio médico por WhatsApp en español rioplatense (Argentina).',
    'Contexto: el asistente ofreció enviar el link de Calendly para reservar turno.',
    'Tarea: según el mensaje del paciente, elegí la próxima acción.',
    'Respondé SOLO uno de estos tokens: SEND_LINK, DO_NOT_SEND, ASK_CLARIFY.',
    'Reglas:',
    '- SEND_LINK: confirma recibir el link, aunque sea indirecto, educado o con typos.',
    '- SEND_LINK ejemplos: "sí", "si quiero", "por favor quiero agendar", "quiero agendar", "dale", "ok", "mandame", "pasame el link", "bueno", "listo", "de una", "me interesa", "avancemos".',
    '- DO_NOT_SEND: rechaza o pospone sin pedir el link ahora.',
    '- DO_NOT_SEND ejemplos: "no", "no por ahora", "más tarde", "después", "ahora no", "sí cómo no" (sarcasmo).',
    '- NO uses DO_NOT_SEND si pide que vos le agendes ("agendame vos", "podés agendarme"): eso es ASK_CLARIFY.',
    '- ASK_CLARIFY: pregunta otra cosa, cambia de tema o no queda claro si quiere el link.',
    '- ASK_CLARIFY ejemplos: "¿cuánto sale?", "¿qué es eso?", "¿para cuándo?", "no entiendo", "¿aceptan OSDE?".',
    '- Priorizá entender la intención real del paciente, no palabras exactas.',
    '- Si el último mensaje del asistente ofreció pasar el link ("¿Te lo mando?", "¿Te paso el link?") y el paciente responde "sí", "dale", "ok" o similar → SEND_LINK.',
  ].join('\n');

  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    lastAssistantMessage: options.lastAssistantMessage || buildMicroCommitmentMessage(),
    conversationContext: options.conversationContext || BOOKING_LINK_OFFER_ASSISTANT_CONTEXT,
    profileDisplayName: options.profileDisplayName,
  });

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
          { role: 'user', content: userContent },
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

function resolveLastAssistantMessageForLinkOffer(priorState) {
  if (priorState && typeof priorState.lastBotReplyText === 'string') {
    const lastBotReplyText = priorState.lastBotReplyText.trim();
    if (lastBotReplyText.length > 0) return lastBotReplyText;
  }
  return buildMicroCommitmentMessage();
}

const BOOKING_LINK_FOLLOW_UP_MESSAGE = 'Cualquier duda que te surja, avisame.';

function linkMessageIncludesFollowUp(entry) {
  return Boolean(entry && getAgendaUrl(entry));
}

async function deliverBookingLinkReply(from, entry, priorState, profileDisplayName, options = {}) {
  if (!entry) return false;
  if (isReferralOnlySedeEntry(entry)) {
    return sendReferralOnlySedeBookingReply(from, entry, priorState, profileDisplayName);
  }
  const userMessage = typeof options.userMessage === 'string' ? options.userMessage : '';
  if (!options.forceResend && hasBookingLinkInStateForSede(priorState, entry)) {
    const primaryPrefix =
      typeof options.primaryPrefix === 'string' && options.primaryPrefix.trim().length > 0
        ? options.primaryPrefix.trim()
        : '';
    const acknowledgmentPrefix =
      primaryPrefix || buildPreferredSlotBookingAcknowledgementPrefix(entry, userMessage) || undefined;
    return deliverBookingLinkReminderReply(from, userMessage, priorState, profileDisplayName, entry, {
      replyContext: options.replyContext || 'booking_link_reminder',
      acknowledgmentPrefix,
    });
  }
  const conversationStatePatch = options.conversationStatePatch || {};
  const primaryPrefix =
    typeof options.primaryPrefix === 'string' && options.primaryPrefix.trim().length > 0
      ? options.primaryPrefix.trim()
      : '';
  const primaryBody = buildLinkMessage(entry);
  const primaryText = primaryPrefix ? `${primaryPrefix} ${primaryBody}` : primaryBody;
  const shouldSendFollowUp = options.sendFollowUp !== false && linkMessageIncludesFollowUp(entry);
  const followUpText = shouldSendFollowUp ? BOOKING_LINK_FOLLOW_UP_MESSAGE : null;

  const wrappedPrimary = buildAutoReplyWithGreetingIfNeeded(primaryText, profileDisplayName, priorState);
  const combinedLastReply = followUpText
    ? `${wrappedPrimary.messageText} ${followUpText}`
    : wrappedPrimary.messageText;
  let nextState = mergeConversationStatePreservingGreeting(priorState, {}, {
    ...conversationStatePatch,
    ...(wrappedPrimary.nextStatePatch || {}),
    ...(buildLinkSentStatePatch(entry) || {}),
    ...buildLastBotReplyStatePatch(combinedLastReply),
  });
  await setConversationState(from, nextState);
  await sendWhatsAppText(from, wrappedPrimary.messageText);
  if (followUpText) {
    const wrappedFollowUp = buildAutoReplyWithGreetingIfNeeded(followUpText, profileDisplayName, nextState);
    nextState = mergeConversationStatePreservingGreeting(nextState, {}, {
      ...(wrappedFollowUp.nextStatePatch || {}),
      ...buildLastBotReplyStatePatch(followUpText),
    });
    await setConversationState(from, nextState);
    await sendWhatsAppText(from, wrappedFollowUp.messageText, { skipDelay: true });
  }
  return true;
}

async function sendBookingLinkForSedeEntry(from, priorState, profileDisplayName, entry, bodyText = '') {
  if (!entry) return false;
  if (isReferralOnlySedeEntry(entry)) {
    return sendReferralOnlySedeBookingReply(from, entry, priorState, profileDisplayName);
  }
  if (shouldWithholdBookingLinkUntilSedeConfirmed(priorState, bodyText, entry)) {
    await sendAskSedeTwoStep(from, profileDisplayName, priorState);
    return true;
  }
  return deliverBookingLinkReply(from, entry, priorState, profileDisplayName, {
    conversationStatePatch: {
      ...buildClearedAwaitingLinkConfirmationStatePatch(),
      ...buildClearedPendingBookingIntentPatch(),
    },
  });
}

async function resolveBookingLinkOfferResponseWithOpenAi(userMessage, options = {}) {
  if (messageLooksLikeAssistedBookingRequest(userMessage)) {
    return { action: 'ASSISTED_BOOKING', source: 'rules-assisted' };
  }
  if (messageClearlyRejectsLinkSend(userMessage)) {
    return { action: 'DO_NOT_SEND', source: 'rules-reject' };
  }
  if (messageLooksLikePrivatePriceQuestion(userMessage, options.priorState)) {
    return { action: 'ASK_CLARIFY', source: 'rules-private-price' };
  }
  if (messageConfirmsLinkSend(userMessage)) {
    return { action: 'SEND_LINK', source: 'rules-affirmative' };
  }

  const linkOfferOptions = {
    ...options,
    lastAssistantMessage:
      options.lastAssistantMessage ||
      (options.priorState ? resolveLastAssistantMessageForLinkOffer(options.priorState) : buildMicroCommitmentMessage()),
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : BOOKING_LINK_OFFER_ASSISTANT_CONTEXT),
  };

  const routerDecision = await decideNextActionForLinkConfirmationWithOpenAi(userMessage, linkOfferOptions);
  if (routerDecision) {
    return { action: routerDecision, source: 'openai-router' };
  }

  const affirmativeDecision = await classifyAffirmativeIntentWithOpenAi(userMessage, linkOfferOptions);
  if (affirmativeDecision === true) {
    return { action: 'SEND_LINK', source: 'openai-affirmative' };
  }
  if (affirmativeDecision === false) {
    return { action: 'DO_NOT_SEND', source: 'openai-affirmative' };
  }

  if (messageLooksLikeBookingIntent(userMessage)) {
    return { action: 'SEND_LINK', source: 'rules-fallback' };
  }

  return { action: 'ASK_CLARIFY', source: 'default' };
}

async function tryHandleAwaitingLinkConfirmation(from, bodyText, priorState, profileDisplayName) {
  if (!stateLooksLikeAwaitingLinkConfirmation(priorState)) return false;
  const pendingSedeEntry = resolveSedeEntryFromState(priorState);
  if (isReferralOnlySedeEntry(pendingSedeEntry)) {
    return sendReferralOnlySedeBookingReply(from, pendingSedeEntry, priorState, profileDisplayName);
  }
  if (stateLooksLikeAwaitingSedeSelection(priorState) || conversationRecentlyAskedSedeSelection(priorState)) {
    return false;
  }
  if (
    messageAsksAboutSedeAddressOrHowToArrive(bodyText) ||
    (messageAsksForMapsLocation(bodyText) && !messageLooksLikeBookingIntent(bodyText))
  ) {
    return false;
  }
  if (messageLooksLikeHealthInsurancePlusQuestion(bodyText) || messageStatesHealthInsuranceMembership(bodyText)) {
    return false;
  }
  if (messageMentionsOutOfCoverageCity(bodyText)) {
    await sendOutOfCoverageCityReply(from, bodyText, priorState, profileDisplayName);
    return true;
  }
  if (messageLooksLikePrivatePriceQuestion(bodyText, priorState)) {
    return false;
  }
  const sedeChange = await resolveSedeFromTextWithOpenAi(bodyText);
  if (sedeChange && !messageConfirmsLinkSend(bodyText) && !messageClearlyRejectsLinkSend(bodyText)) {
    return false;
  }

  const linkOfferDecision = await resolveBookingLinkOfferResponseWithOpenAi(bodyText, {
    profileDisplayName,
    priorState,
    conversationContext: buildIntentRoutingOpenAiContext(priorState),
    lastAssistantMessage: resolveLastAssistantMessageForLinkOffer(priorState),
  });

  if (linkOfferDecision.action === 'ASSISTED_BOOKING') {
    return sendAssistedBookingRequiredReply(from, bodyText, priorState, profileDisplayName);
  }

  if (linkOfferDecision.action === 'SEND_LINK') {
    const entryFromState = resolveSedeEntryFromState(priorState);
    if (entryFromState) {
      await sendBookingLinkForSedeEntry(from, priorState, profileDisplayName, entryFromState);
      return true;
    }
  }

  if (linkOfferDecision.action === 'DO_NOT_SEND') {
    const entryFromState = resolveSedeEntryFromState(priorState);
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
    if (entryFromState) {
      const url = getAgendaUrl(entryFromState);
      const message1 = 'Sin problema, sin apuro.';
      const message2 = url
        ? `Cuando quieras el link te queda acá:\n${url}\nCualquier duda escribime 😊`
        : 'Cuando quieras, te paso el link para reservar. Cualquier duda escribime 😊';
      await setConversationState(
        from,
        mergeConversationStatePreservingGreeting(priorState, {}, {
          ...(buildLinkSentStatePatch(entryFromState) || {}),
          ...preservedSessionState,
        })
      );
      const wrapped1 = buildAutoReplyWithGreetingIfNeeded(message1, profileDisplayName, priorState);
      await sendWhatsAppText(from, wrapped1.messageText);
      await sendWhatsAppText(from, message2, { skipDelay: true });
      return true;
    }
  }

  const shouldBypassPendingLinkConfirmation =
    linkOfferDecision.action === 'ASK_CLARIFY' &&
    (messageLooksLikePrivatePriceQuestion(bodyText, priorState) ||
      messageLooksLikeAnyPriceQuestion(bodyText) ||
      messageLooksLikeHealthInsurancePlusQuestion(bodyText) ||
      messageMatchesStudiesTopic(bodyText) ||
      messageAsksAboutConditionTreatment(bodyText) ||
      messageLooksLikeChronicSymptomFrustration(bodyText) ||
      messageLooksLikeScheduleAvailabilityQuestion(bodyText) ||
      messageAsksAboutSedeAddressOrHowToArrive(bodyText) ||
      (messageAsksForMapsLocation(bodyText) && !messageLooksLikeBookingIntent(bodyText)));
  if (shouldBypassPendingLinkConfirmation) {
    return false;
  }

  if (linkOfferDecision.action === 'ASK_CLARIFY' && messageConfirmsLinkSend(bodyText)) {
    const entryFromState = resolveSedeEntryFromState(priorState);
    if (entryFromState) {
      await sendBookingLinkForSedeEntry(from, priorState, profileDisplayName, entryFromState);
      return true;
    }
  }

  return false;
}

async function tryResolveConsultationPriceIntentWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador de intención para WhatsApp de un consultorio médico en español rioplatense.',
    'Tarea: decidir si el paciente pregunta el PRECIO/COSTO/VALOR de la CONSULTA médica (particular, control, seguimiento).',
    'Respondé solo: YES o NO.',
    'YES ejemplos: "qué costo tiene la consulta", "preio de la consulta", "cuánto sale la consulta", "precio de la consulta" (aunque no diga particular).',
    'NO ejemplos: "consulta particular" explícita (eso es particular), precio de estudios, agendar turno sin precio, obra social/plus sin pregunta de valor.',
    'Si el contexto indica que el paciente ya preguntó el costo de la consulta y ahora solo informa la ciudad, respondé YES.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : '',
    profileDisplayName: options.profileDisplayName,
  });
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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (normalized.startsWith('YES')) return true;
    if (normalized.startsWith('NO')) return false;
    return null;
  } catch (error) {
    console.error('OpenAI consultation price intent classifier failed', error);
    return null;
  }
}

async function tryResolveRequiresHealthInsuranceBeforeConsultationPriceWithOpenAi(userMessage, options = {}) {
  if (messageAsksGenericConsultationPrice(userMessage)) {
    return { requiresHealthInsurance: true, source: 'rules-generic-consultation' };
  }
  if (await resolvePrivatePayWithoutHealthInsuranceFromMessage(userMessage, options)) {
    return { requiresHealthInsurance: false, source: 'rules-or-openai-particular' };
  }
  if (options.priorState && shouldAskHealthInsuranceBeforeConsultationPrice(options.priorState)) {
    return { requiresHealthInsurance: true, source: 'rules-pending-consultation-flow' };
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    return {
      requiresHealthInsurance: messageAsksGenericConsultationPrice(userMessage),
      source: 'rules-fallback',
    };
  }

  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense.',
    'Tarea: decidir si ANTES de dar el precio particular de la consulta hay que preguntar qué obra social/prepaga tiene el paciente.',
    'Respondé solo: YES o NO.',
    'YES ejemplos: preguntó costo/precio/valor de la consulta sin decir "particular"; acaba de informar ciudad después de esa pregunta; el asistente pidió obra social y aún no la dijo.',
    'NO ejemplos: preguntó explícitamente consulta/atención PARTICULAR, control o seguimiento particular; ya informó obra social y solo falta cerrar el valor.',
    'Si el contexto indica flujo de precio de consulta genérico (no particular), respondé YES.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.lastAssistantMessage ||
      (options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : ''),
    profileDisplayName: options.profileDisplayName,
  });

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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (normalized.startsWith('YES')) {
      return { requiresHealthInsurance: true, source: 'openai' };
    }
    if (normalized.startsWith('NO')) {
      return { requiresHealthInsurance: false, source: 'openai' };
    }
    return null;
  } catch (error) {
    console.error('OpenAI health insurance before price classifier failed', error);
    return null;
  }
}

async function shouldHandleAsConsultationPriceQuestion(bodyText, priorState, profileDisplayName, options = {}) {
  if (shouldAskHealthInsuranceBeforeConsultationPrice(priorState)) return true;
  if (stateHasPendingConsultationPriceIntent(priorState)) return true;
  if (
    messageAsksGenericConsultationPrice(bodyText) &&
    !messageExplicitlyAsksPrivateConsultationPrice(bodyText)
  ) {
    return true;
  }
  if (!options.rulesOnly && getOpenAiApiKey()) {
    const openAiDecision = await tryResolveConsultationPriceIntentWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
    });
    if (openAiDecision === true && !messageExplicitlyAsksPrivateConsultationPrice(bodyText)) return true;
    if (openAiDecision === false) return false;
  }
  return false;
}

async function shouldHandleAsPrivatePriceQuestion(bodyText, priorState, profileDisplayName) {
  if (messageAsksGenericConsultationPrice(bodyText)) return false;
  if (stateHasPendingConsultationPriceIntent(priorState)) return false;
  if (shouldAskHealthInsuranceBeforeConsultationPrice(priorState)) return false;
  if (
    stateHasPendingPrivatePriceIntent(priorState) &&
    stateExplicitlyRequestedPrivateConsultationPrice(priorState)
  ) {
    return true;
  }
  if (messageExplicitlyAsksPrivateConsultationPrice(bodyText)) return true;
  if (messageLooksLikePrivatePriceQuestion(bodyText, priorState)) {
    const healthInsuranceDecision = await tryResolveRequiresHealthInsuranceBeforeConsultationPriceWithOpenAi(
      bodyText,
      { priorState, profileDisplayName }
    );
    if (healthInsuranceDecision && healthInsuranceDecision.requiresHealthInsurance) return false;
    return messageExplicitlyAsksPrivateConsultationPrice(bodyText);
  }
  return false;
}

async function sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName) {
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const lastSede = patientContext.sedeEntry || resolveLastSedeEntryFromState(mergedState);
  const healthInsuranceName = patientContext.healthInsuranceName;

  if (lastSede && healthInsuranceName) {
    const rawReply = await buildConsultationPriceReplyForSedeAndHealthInsurance(
      lastSede,
      healthInsuranceName,
      mergedState
    );
    const focusedReply = await tryResolveFocusedPatientReplyWithOpenAi(rawReply, {
      replyContext: 'consultation_price',
      suppressBookingLinkOffer: true,
      priorState: mergedState,
      userMessage: bodyText,
      profileDisplayName,
      conversationContext: buildIntentRoutingOpenAiContext(mergedState),
    });
    const reply = focusedReply.reply;
    const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, mergedState);
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(
        mergedState,
        {},
        {
          ...(wrapped.nextStatePatch || {}),
          ...(buildLastSedeStatePatch(lastSede) || {}),
          healthInsuranceName,
          lastHealthInsuranceName: healthInsuranceName,
          ...buildLastHealthInsuranceDiscussionStatePatch(),
          ...buildClearedPendingConsultationPriceIntentPatch(),
          ...buildConsultationPriceAnsweredStatePatch(),
          ...buildLastBotReplyStatePatch(wrapped.messageText),
        }
      )
    );
    await sendWhatsAppText(from, wrapped.messageText);
    return true;
  }

  if (lastSede) {
    const wrapped = buildAutoReplyWithGreetingIfNeeded(
      buildAskHealthInsuranceForConsultationPriceMessage(),
      profileDisplayName,
      mergedState
    );
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(
        mergedState,
        buildPendingConsultationPriceIntentStatePatch(),
        {
          ...(wrapped.nextStatePatch || {}),
          ...(buildLastSedeStatePatch(lastSede) || {}),
          ...buildLastBotReplyStatePatch(wrapped.messageText),
        }
      )
    );
    await sendWhatsAppText(from, wrapped.messageText);
    return true;
  }

  const wrapped = buildAutoReplyWithGreetingIfNeeded(
    buildAskSedeForConsultationPriceMessage(),
    profileDisplayName,
    priorState
  );
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(
      priorState,
      {
        ...buildAwaitingSedeSelectionStatePatch(),
        ...buildPendingConsultationPriceIntentStatePatch(),
      },
      {
        ...(wrapped.nextStatePatch || {}),
        ...buildLastBotReplyStatePatch(wrapped.messageText),
      }
    )
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

async function tryHandleConsultationPriceWithPatientContext(from, bodyText, priorState, profileDisplayName, options = {}) {
  if (!(await shouldHandleAsConsultationPriceQuestion(bodyText, priorState, profileDisplayName, options))) {
    return false;
  }
  return sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName);
}

async function tryHandlePrivatePriceWithPatientContext(from, bodyText, priorState, profileDisplayName) {
  if (!(await shouldHandleAsPrivatePriceQuestion(bodyText, priorState, profileDisplayName))) {
    return false;
  }
  return sendPrivatePriceQuestionReply(from, bodyText, priorState, profileDisplayName);
}

async function tryResolveBookingIntentWithOpenAi(userMessage, options = {}) {
  if (messageAsksWhyChooseDoctorOrTrustQuestion(userMessage)) return false;
  const apiKey = getOpenAiApiKey();
  if (apiKey) {
    const modelName = getOpenAiModelName();
    const systemPrompt = [
      'Sos un clasificador de intención para WhatsApp de un consultorio médico en español rioplatense.',
      'Tarea: decidir si el paciente quiere AGENDAR / RESERVAR / SACAR TURNO o recibir el link de agenda.',
      'Respondé solo: YES o NO.',
      'YES ejemplos: "quiero agendar", "necesito turno", "cómo reservo", "para mañana hay turno", "hay turno", "me gustaría sacar turno", typos como "urno".',
      'NO si pide que VOS/la asistente agende por él ("agendame vos", "podés agendarme", "me lo reservás vos"): eso NO es pedido de link propio.',
      'NO ejemplos: pregunta de PRECIO/COSTO de consulta ("qué costo tiene la consulta", "precio consulta particular", "cuánto sale la consulta"), obra social, dirección, preparación de estudios o qué traer, sin pedir turno.',
      'NO si pregunta POR QUÉ atenderse/elegir al Dr., experiencia del médico o frustración con otros alergistas sin pedir turno explícito.',
      'IMPORTANTE: "consulta" en una pregunta de precio NO es pedido de turno.',
      'Si el contexto ya tiene sede (Corrientes/Resistencia) y el paciente pregunta por turno o disponibilidad, respondé YES.',
    ].join('\n');

    const userContent = buildOpenAiClassifierUserContent(userMessage, {
      conversationContext:
        options.conversationContext ||
        (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
      profileDisplayName: options.profileDisplayName,
    });

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
            { role: 'user', content: userContent },
          ],
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
        if (normalized.startsWith('YES')) return true;
        if (normalized.startsWith('NO')) {
          if (
            messageLooksLikeBookingIntent(userMessage) &&
            !messageLooksLikeAssistedBookingRequest(userMessage) &&
            !messageLooksLikePrivatePriceQuestion(userMessage) &&
            !messageAsksWhyChooseDoctorOrTrustQuestion(userMessage)
          ) {
            return true;
          }
          return false;
        }
      }
    } catch (error) {
      console.error('OpenAI booking intent classifier failed', error);
    }
  }

  if (messageLooksLikePrivatePriceQuestion(userMessage)) return false;
  if (messageLooksLikeAssistedBookingRequest(userMessage)) return false;
  return messageLooksLikeBookingIntent(userMessage) || messageExplicitlyRequestsBookingLink(userMessage);
}

async function tryResolveAssistedBookingRequestWithOpenAi(userMessage, options = {}) {
  const priorState = options.priorState;
  if (
    priorState &&
    (conversationRecentlyAskedSedeSelection(priorState) || stateLooksLikeAwaitingSedeSelection(priorState)) &&
    !messageLooksLikeAssistedBookingRequest(userMessage)
  ) {
    return false;
  }
  const rulesMatch = messageLooksLikeAssistedBookingRequest(userMessage);
  if (options.rulesOnly) return rulesMatch;
  if (messageAsksIfAssistantCanBookForUser(userMessage)) return true;
  const hasAssistedBookingContext =
    priorState &&
    typeof priorState === 'object' &&
    (wasBookingLinkSentRecently(priorState) ||
      stateLooksLikeAwaitingLinkConfirmation(priorState) ||
      Number.isFinite(Number(priorState.lastBookingLinkOfferAtMs)));

  if (!rulesMatch && !hasAssistedBookingContext) return false;
  if (rulesMatch && !getOpenAiApiKey()) return true;

  const apiKey = getOpenAiApiKey();
  if (!apiKey) return rulesMatch;

  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense.',
    'Tarea: decidir si el paciente pide que la asistente/equipo le AGENDE el turno (no quiere hacerlo solo con el link).',
    'Respondé solo: YES o NO.',
    'YES ejemplos: "agendame vos", "podés agendarme?", "me lo reservás?", "no quiero usar el link", "no tengo mail para agendar", "no sé usar la agenda agendame".',
    'NO ejemplos: "quiero agendar", "pasame el link", "si" después de "¿Te paso el link?", preguntas de precio/dirección/obra social.',
    'Si ya se envió el link y pregunta si vos podés agendarle: YES.',
  ].join('\n');

  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.lastAssistantMessage ||
      (options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : ''),
    profileDisplayName: options.profileDisplayName,
  });

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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
      if (normalized.startsWith('YES')) return true;
      if (normalized.startsWith('NO')) return rulesMatch;
    }
  } catch (error) {
    console.error('OpenAI assisted booking classifier failed', error);
  }

  return rulesMatch;
}

async function tryHandleAssistedBookingRequest(from, bodyText, priorState, profileDisplayName, options = {}) {
  if (
    (conversationRecentlyAskedSedeSelection(priorState) || stateLooksLikeAwaitingSedeSelection(priorState)) &&
    !messageLooksLikeAssistedBookingRequest(bodyText)
  ) {
    return false;
  }
  const isAssistedBooking = await tryResolveAssistedBookingRequestWithOpenAi(bodyText, {
    priorState,
    profileDisplayName,
    rulesOnly: options.rulesOnly,
  });
  if (!isAssistedBooking) return false;
  return sendAssistedBookingRequiredReply(from, bodyText, priorState, profileDisplayName);
}

function conversationLooksLikePatientDissatisfactionContext(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  return (
    priorStateLooksLikeRecentPriceOrPlusReply(priorState) ||
    conversationLooksLikeOngoingBookingLinkGuidance(priorState) ||
    stateHasRecentBookingConversationContext(priorState) ||
    stateHasRecentScheduleDiscussionContext(priorState) ||
    stateLooksLikeAwaitingBookingLinkTroubleFollowup(priorState)
  );
}

async function tryResolvePatientDissatisfactionWithOpenAi(userMessage, options = {}) {
  if (messageAsksWhyChooseDoctorOrTrustQuestion(userMessage)) return false;
  if (
    options.priorState &&
    priorStateLooksLikeRecentPriceOrPlusReply(options.priorState) &&
    messageLooksLikePriceObjection(userMessage)
  ) {
    return true;
  }
  const rulesMatch = messageLooksLikePatientDissatisfactionByRules(userMessage);
  if (options.rulesOnly) return rulesMatch;

  const priorState = options.priorState;
  const hasDissatisfactionContext = conversationLooksLikePatientDissatisfactionContext(priorState);

  if (rulesMatch && hasDissatisfactionContext) return true;
  if (rulesMatch && !getOpenAiApiKey()) return true;

  const apiKey = getOpenAiApiKey();
  if (!apiKey) return rulesMatch;

  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense.',
    'Tarea: decidir si el paciente expresa DISCONFORMIDAD, ENOJO o FRUSTRACIÓN con la atención recibida, no una pregunta nueva.',
    'Respondé solo: YES o NO.',
    'YES ejemplos: "muy caro", "es un robo", "estoy enojado", "qué bronca", "no puedo pagar", "malísimo", "no me ayudan", "es un desastre", sarcasmo tras un precio o tras explicar el link de agenda.',
    'YES también si está frustrado/enojado con el proceso de agendar o con respuestas repetidas del bot sobre el link.',
    'NO ejemplos: pregunta de precio nueva ("cuánto sale"), pedir turno, obra social, síntomas clínicos, saludo, "no sé cómo agendar" sin enojo (eso es otro flujo).',
    'Si el asistente acaba de informar un monto o el link y el paciente reacciona mal, es YES.',
  ].join('\n');

  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.lastAssistantMessage ||
      (options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : ''),
    profileDisplayName: options.profileDisplayName,
  });

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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
      if (normalized.startsWith('YES')) return true;
      if (normalized.startsWith('NO')) return false;
    }
  } catch (error) {
    console.error('OpenAI patient dissatisfaction classifier failed', error);
  }

  return rulesMatch;
}

async function fetchOpenAiDissatisfactionReply(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;

  const modelName = getOpenAiModelName();
  const priorState = options.priorState;
  const assistancePhoneNumber = resolveClinicAssistancePhoneNumberFromContext(priorState);
  const bookingFrustrationContext = conversationLooksLikeOngoingBookingLinkGuidance(priorState);
  const basePrompt = loadAgenteLiberSystemPrompt();
  const systemPrompt = [
    typeof basePrompt === 'string' && basePrompt.trim().length > 0
      ? basePrompt.trim()
      : FALLBACK_AGENTE_LIBER_SYSTEM_PROMPT,
    '',
    bookingFrustrationContext
      ? 'Situación: el paciente está enojado o frustrado con el proceso de agendar turno o con las respuestas sobre el link de agenda.'
      : 'Situación: el paciente expresó enojo, frustración o que algo es muy caro.',
    'Respondé con empatía breve y humana (máximo 2 oraciones). NO repitas montos ni la respuesta anterior palabra por palabra.',
    bookingFrustrationContext
      ? `Validá su molestia, ofrecé acompañarlo paso a paso. Si necesita ayuda humana, indicá el teléfono ${assistancePhoneNumber}. NO repitas el link ni digas "te dejo el link". NO digas "te derivo" ni que alguien lo va a contactar.`
      : 'NO des diagnósticos. NO inventes precios. NO listes estudios ni tratamientos alternativos. NO preguntes qué quiere revisar. Solo validá empatía breve sobre el monto.',
    'NO ofrezcas link de turno salvo que lo pida explícitamente.',
  ].join('\n');

  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    profileDisplayName: options.profileDisplayName,
    conversationContext: priorState ? buildIntentRoutingOpenAiContext(priorState) : '',
    lastAssistantMessage:
      priorState && typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText : '',
  });

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
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    return text.trim();
  } catch (error) {
    console.error('OpenAI dissatisfaction reply failed', error);
    return null;
  }
}

async function tryHandlePatientDissatisfactionWithOpenAi(
  from,
  bodyText,
  priorState,
  profileDisplayName,
  options = {}
) {
  if (
    messageLooksLikeBookingLinkUsageDifficulty(bodyText) &&
    !messageLooksLikePatientDissatisfactionByRules(bodyText)
  ) {
    return false;
  }
  if (
    priorStateLooksLikeRecentBookingLinkContext(priorState) &&
    messageLooksLikeBookingLinkTechnicalTrouble(bodyText)
  ) {
    return false;
  }
  const isPriceObjectionAfterQuote =
    priorStateLooksLikeRecentPriceOrPlusReply(priorState) && messageLooksLikePriceObjection(bodyText);

  const isDissatisfaction =
    isPriceObjectionAfterQuote ||
    (await tryResolvePatientDissatisfactionWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
      rulesOnly: options.rulesOnly,
    }));
  if (!isDissatisfaction) return false;

  if (isPriceObjectionAfterQuote) {
    return deliverSequentialPatientTextMessages(
      from,
      [buildPriceObjectionEmpathyReply(), buildPriceObjectionPersonalAssistanceFollowUpReply(priorState)],
      priorState,
      profileDisplayName,
      {
        lastPatientDissatisfactionAtMs: Date.now(),
        lastPriceObjectionHandledAtMs: Date.now(),
        bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS,
      }
    );
  }

  const openAiReply = await fetchOpenAiDissatisfactionReply(bodyText, { priorState, profileDisplayName });
  if (!openAiReply && getOpenAiApiKey()) {
    console.error('OpenAI dissatisfaction reply unavailable; skipping rules fallback because AI is required');
    return false;
  }
  const fallbackReply = conversationLooksLikeOngoingBookingLinkGuidance(priorState)
    ? `Entiendo tu frustración. Si querés, te guío paso a paso. ${buildBookingPersonalAssistanceMessage(priorState)}`
    : 'Entiendo, y sé que a veces los montos pesan. Contame qué te gustaría revisar y te ayudo sin repetirte lo mismo.';
  const processedReply = processAssistantReplyForPatient(openAiReply || fallbackReply);
  return sendFinalizedPatientTextReply(from, processedReply, priorState, profileDisplayName, {
    lastPatientDissatisfactionAtMs: Date.now(),
    bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS,
  }, {
    userMessage: bodyText,
    replyContext: 'patient_dissatisfaction',
    suppressBookingLinkOffer: true,
  });
}

async function tryResolveExplicitBookingLinkRequestWithOpenAi(userMessage, options = {}) {
  if (messageExplicitlyRequestsBookingLink(userMessage)) {
    if (options.rulesOnly) return true;
    return true;
  }
  if (messageLooksLikeAssistedBookingRequest(userMessage)) return false;
  if (options.rulesOnly) return false;

  const priorState = options.priorState;
  const hasBookingConversationContext =
    priorState &&
    typeof priorState === 'object' &&
    (stateHasRecentStudyPriceContext(priorState) ||
      stateHasPendingBookingIntent(priorState) ||
      stateHasRecentBookingConversationContext(priorState) ||
      stateHasRecentScheduleDiscussionContext(priorState) ||
      Number.isFinite(Number(priorState.lastPatientDissatisfactionAtMs)) ||
      Boolean(resolveLastSedeEntryFromState(priorState)));

  if (!hasBookingConversationContext) return false;

  const apiKey = getOpenAiApiKey();
  if (!apiKey) return false;

  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense.',
    'Tarea: decidir si el paciente pide EXPLÍCITAMENTE que le envíen el link de agenda/turno AHORA.',
    'Respondé solo: YES o NO.',
    'YES ejemplos: "pasame link para agendar", "mandame el link", "quiero el link", "link para reservar", "dale el link", "si pasame el link".',
    'NO ejemplos: "agendame vos", "quiero agendar" sin pedir link, preguntas de precio, "qué días atiende", solo "si" sin contexto de link.',
    'Si pide el link de forma directa aunque haya enojado antes por el precio, es YES.',
  ].join('\n');

  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.lastAssistantMessage ||
      (options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : ''),
    profileDisplayName: options.profileDisplayName,
  });

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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
      if (normalized.startsWith('YES')) return true;
      if (normalized.startsWith('NO')) return false;
    }
  } catch (error) {
    console.error('OpenAI explicit booking link classifier failed', error);
  }

  return false;
}

async function shouldSendBookingLinkDirectly(bodyText, priorState, profileDisplayName, options = {}) {
  if (messageExplicitlyRequestsBookingLink(bodyText)) return true;
  if (options.rulesOnly) return false;
  return tryResolveExplicitBookingLinkRequestWithOpenAi(bodyText, {
    priorState,
    profileDisplayName,
  });
}

async function tryHandleExplicitBookingLinkRequest(from, bodyText, priorState, profileDisplayName, options = {}) {
  if (messageLooksLikeAssistedBookingRequest(bodyText)) return false;
  const shouldSendLink = await shouldSendBookingLinkDirectly(bodyText, priorState, profileDisplayName, options);
  if (!shouldSendLink) return false;

  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const lastSede =
    patientContext.sedeEntry || resolveConfirmedSedeEntryForBookingFlow(bodyText, priorState);
  if (!lastSede) return false;

  return sendBookingLinkForSedeEntry(from, priorState, profileDisplayName, lastSede);
}

function isLastBotReplyWithinBookingLinkRememberWindow(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  const lastBotReplyAtMs = Number(priorState.lastBotReplyAtMs);
  return (
    Number.isFinite(lastBotReplyAtMs) &&
    Date.now() - lastBotReplyAtMs <= BOOKING_LINK_RECENTLY_SENT_MS
  );
}

function priorStateLooksLikeRecentBookingLinkContext(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (
    wasBookingLinkSentRecently(priorState) &&
    typeof priorState.lastBookingLinkUrl === 'string' &&
    priorState.lastBookingLinkUrl.trim().length > 0
  ) {
    return true;
  }
  if (!isLastBotReplyWithinBookingLinkRememberWindow(priorState)) return false;
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  if (!lastBotReplyText) return false;
  return (
    lastBotReplyText.includes('calendar.app.google') ||
    lastBotReplyText.includes('calendly.com') ||
    lastBotReplyText.includes('link para elegir') ||
    lastBotReplyText.includes('link para ver horarios') ||
    lastBotReplyText.includes('link que ya te pasé') ||
    lastBotReplyText.includes('link que ya te pase') ||
    lastBotReplyText.includes('te acompaño paso a paso') ||
    lastBotReplyText.includes('te acompano paso a paso')
  );
}

function conversationLooksLikeOngoingBookingLinkGuidance(priorState) {
  if (isReferralOnlySedeEntry(resolveLastSedeEntryFromState(priorState))) return false;
  if (priorStateLooksLikeRecentBookingLinkContext(priorState)) return true;
  if (!priorState || typeof priorState !== 'object') return false;
  if (!isLastBotReplyWithinBookingLinkRememberWindow(priorState)) return false;
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  if (
    lastBotReplyText.includes('paso a paso') ||
    lastBotReplyText.includes('te guio') ||
    lastBotReplyText.includes('te guío') ||
    lastBotReplyText.includes('te acompaño') ||
    lastBotReplyText.includes('te acompano')
  ) {
    return true;
  }
  return Boolean(
    resolveLastSedeEntryFromState(priorState) &&
      (stateHasRecentBookingConversationContext(priorState) ||
        stateHasRecentScheduleDiscussionContext(priorState) ||
        stateHasPendingBookingIntent(priorState))
  );
}

function resolveBookingLinkUrlFromPriorState(priorState) {
  const lastSede = resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  if (isReferralOnlySedeEntry(lastSede)) return null;
  if (priorState && typeof priorState.lastBookingLinkUrl === 'string') {
    const urlFromState = priorState.lastBookingLinkUrl.trim();
    if (urlFromState.length > 0) return urlFromState;
  }
  return lastSede ? getAgendaUrl(lastSede) : null;
}

async function tryResolveBookingLinkTroubleWithOpenAi(userMessage, options = {}) {
  const priorState = options.priorState;
  const usageDifficulty =
    messageLooksLikeBookingLinkUsageDifficulty(userMessage) &&
    !messageLooksLikeBookingLinkTechnicalTrouble(userMessage);
  const hasLinkContext = usageDifficulty
    ? conversationLooksLikeOngoingBookingLinkGuidance(priorState)
    : priorStateLooksLikeRecentBookingLinkContext(priorState);
  const rulesMatch = messageLooksLikeBookingLinkTrouble(userMessage);
  if (!hasLinkContext) return false;
  if (options.rulesOnly) return rulesMatch;
  if (rulesMatch) return true;

  const apiKey = getOpenAiApiKey();
  if (!apiKey) return false;

  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense.',
    'Contexto: el asistente ya envió el link de agenda para sacar turno.',
    'Tarea: decidir si el paciente reporta PROBLEMA TÉCNICO o dificultad para usar el link (no abre, no funciona, no carga, error, no puede reservar en la web).',
    'Respondé solo: YES o NO.',
    'YES ejemplos: "no me abre", "no funciona", "no anda", "no carga", "error en el link", "no pude agendar en el link", "no me deja entrar", "la página queda en blanco", "no sé cómo hacer", "no se como usar el link", "no entiendo cómo reservar".',
    'NO ejemplos: pedir otro link sin queja ("pasame el link"), preguntar precio, "no hay turnos" sin problema técnico, enojo por precio ("muy caro").',
    'Si dice que no hay disponibilidad pero NO hay fallo técnico del link, respondé NO (eso es otro flujo).',
  ].join('\n');

  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (priorState ? buildIntentRoutingOpenAiContext(priorState) : ''),
    lastAssistantMessage:
      options.lastAssistantMessage ||
      (priorState && typeof priorState.lastBotReplyText === 'string'
        ? priorState.lastBotReplyText
        : ''),
    profileDisplayName: options.profileDisplayName,
  });

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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
      if (normalized.startsWith('YES')) return true;
      if (normalized.startsWith('NO')) return false;
    }
  } catch (error) {
    console.error('OpenAI booking link trouble classifier failed', error);
  }

  return false;
}

async function fetchOpenAiBookingLinkTroubleReply(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;

  const modelName = getOpenAiModelName();
  const linkUrl = options.linkUrl || resolveBookingLinkUrlFromPriorState(options.priorState);
  const isFollowUp = Boolean(options.isFollowUp);
  const isUsageDifficulty = Boolean(options.isUsageDifficulty);
  const patientSeemsFrustrated = Boolean(options.patientSeemsFrustrated);
  const priorState = options.priorState;
  const assistancePhoneNumber = resolveClinicAssistancePhoneNumberFromContext(priorState);
  const basePrompt = loadAgenteLiberSystemPrompt();
  const systemPrompt = [
    typeof basePrompt === 'string' && basePrompt.trim().length > 0
      ? basePrompt.trim()
      : FALLBACK_AGENTE_LIBER_SYSTEM_PROMPT,
    '',
    isFollowUp
      ? 'Situación: el paciente sigue con problemas para usar el link de agenda después de un primer consejo.'
      : isUsageDifficulty
        ? patientSeemsFrustrated
          ? 'Situación: el paciente ya recibió el link de agenda, no sabe cómo reservar y además está frustrado o enojado.'
          : 'Situación: el paciente ya recibió el link de agenda y dice que no sabe cómo reservar o usarlo.'
        : 'Situación: el paciente dice que el link de agenda no funciona, no abre o no puede reservar.',
    'Reglas:',
    patientSeemsFrustrated
      ? '- Empezá validando su molestia con empatía breve y natural.'
      : '- Empatía breve (máximo 2 oraciones).',
    isFollowUp
      ? `- Indicá que puede comunicarse al ${assistancePhoneNumber} si necesita ayuda. NO digas "te derivo" ni que alguien lo va a contactar.`
      : isUsageDifficulty
        ? '- Explicá en 2-4 pasos simples y concretos cómo reservar (abrir link, elegir día/horario, completar datos, confirmar).'
        : '- Sugerí probar otro navegador o abrir desde computadora si está en el celular.',
    '- NO repitas el micro-compromiso "¿Te lo mando?".',
    '- NO inventes horarios ni confirmes turnos por chat.',
    isUsageDifficulty
      ? `- NO repitas el link ni digas "te dejo el link"; el paciente ya lo tiene. Si ofrecés ayuda humana, usá el teléfono ${assistancePhoneNumber}. NO digas "te derivo".`
      : linkUrl && !isFollowUp
        ? `- Podés repetir el link al final si ayuda: ${linkUrl}`
        : '',
  ]
    .filter(Boolean)
    .join('\n');

  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    profileDisplayName: options.profileDisplayName,
    conversationContext: priorState ? buildIntentRoutingOpenAiContext(priorState) : '',
    lastAssistantMessage:
      priorState && typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText : '',
  });

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
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    return text.trim();
  } catch (error) {
    console.error('OpenAI booking link trouble reply failed', error);
    return null;
  }
}

async function resolveBookingLinkUsageDifficultyReplyWithOpenAi(bodyText, priorState, profileDisplayName) {
  const lastSede = resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  const patientSeemsFrustrated = messageLooksLikePatientDissatisfactionByRules(bodyText);
  if (!getOpenAiApiKey()) {
    return buildBookingLinkStepByStepGuidanceReply(priorState, lastSede);
  }
  const openAiReply = await fetchOpenAiBookingLinkTroubleReply(bodyText, {
    priorState,
    profileDisplayName,
    isUsageDifficulty: true,
    patientSeemsFrustrated,
  });
  if (!openAiReply) {
    console.error('OpenAI booking usage difficulty reply unavailable; using rules fallback');
    return buildBookingLinkStepByStepGuidanceReply(priorState, lastSede);
  }
  const processedReply = processAssistantReplyForPatient(openAiReply);
  const finalizedReply = await finalizePatientReplyText(processedReply, {
    priorState,
    profileDisplayName,
    userMessage: bodyText,
    replyContext: 'booking_link_usage_difficulty',
    suppressBookingLinkOffer: true,
  });
  return sanitizeBookingAssistanceReplyText(finalizedReply, priorState, lastSede);
}

async function tryHandleBookingLinkUsageDifficulty(from, bodyText, priorState, profileDisplayName) {
  if (!messageLooksLikeBookingLinkUsageDifficulty(bodyText)) return false;
  if (messageLooksLikeBookingLinkTechnicalTrouble(bodyText)) return false;
  if (!conversationLooksLikeOngoingBookingLinkGuidance(priorState)) return false;

  const lastSede = resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  const replyText = await resolveBookingLinkUsageDifficultyReplyWithOpenAi(bodyText, priorState, profileDisplayName);
  if (!replyText) return false;

  const nowMs = Date.now();
  return sendFinalizedPatientTextReply(
    from,
    replyText,
    priorState,
    profileDisplayName,
    {
      state: 'awaiting_booking_link_trouble_followup',
      linkTroubleFirstAtMs: nowMs,
      ...(lastSede ? buildLastSedeStatePatch(lastSede) || {} : {}),
      ...(lastSede ? buildLinkSentStatePatch(lastSede) || {} : {}),
      bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS,
    },
    {
      userMessage: bodyText,
      replyContext: 'booking_link_usage_difficulty',
      suppressBookingLinkOffer: true,
      skipHumanization: true,
    }
  );
}

async function tryHandleBookingLinkTroubleWithOpenAi(
  from,
  bodyText,
  priorState,
  profileDisplayName,
  options = {}
) {
  const isLinkTrouble = await tryResolveBookingLinkTroubleWithOpenAi(bodyText, {
    priorState,
    profileDisplayName,
    rulesOnly: options.rulesOnly,
  });
  if (!isLinkTrouble) return false;

  const nowMs = Date.now();
  const isFollowUp =
    stateLooksLikeAwaitingBookingLinkTroubleFollowup(priorState) &&
    nowMs - Number(priorState.linkTroubleFirstAtMs) <= BOOKING_LINK_TROUBLE_FOLLOWUP_WINDOW_MS;
  const linkUrl = resolveBookingLinkUrlFromPriorState(priorState);
  const isUsageDifficulty =
    messageLooksLikeBookingLinkUsageDifficulty(bodyText) &&
    !messageLooksLikeBookingLinkTechnicalTrouble(bodyText);

  if (!isFollowUp) {
    if (isUsageDifficulty && conversationLooksLikeOngoingBookingLinkGuidance(priorState)) {
      return tryHandleBookingLinkUsageDifficulty(from, bodyText, priorState, profileDisplayName);
    }
    if (!getOpenAiApiKey()) {
      const fallbackReply = isUsageDifficulty
        ? buildBookingLinkStepByStepGuidanceReply(priorState)
        : 'Qué garrón. Probá abrirlo desde otro navegador o desde la computadora si estás en el celu.';
      let replyText = processAssistantReplyForPatient(fallbackReply);
      if (!isUsageDifficulty && linkUrl && !replyText.includes(linkUrl)) {
        replyText = `${replyText}\n${linkUrl}`;
      }
      const nextState = mergeConversationStatePreservingGreeting(
        priorState,
        {
          state: 'awaiting_booking_link_trouble_followup',
          linkTroubleFirstAtMs: nowMs,
        },
        { bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS }
      );
      await setConversationState(from, nextState);
      const wrapped = buildAutoReplyWithGreetingIfNeeded(replyText, profileDisplayName, priorState);
      await sendWhatsAppText(from, wrapped.messageText);
      return true;
    }
    const openAiReply = await fetchOpenAiBookingLinkTroubleReply(bodyText, {
      priorState,
      profileDisplayName,
      linkUrl,
      isFollowUp: false,
      isUsageDifficulty,
      patientSeemsFrustrated: messageLooksLikePatientDissatisfactionByRules(bodyText),
    });
    if (!openAiReply) {
      console.error('OpenAI booking link trouble reply unavailable; skipping rules fallback because AI is required');
      return false;
    }
    let replyText = processAssistantReplyForPatient(openAiReply);
    replyText = await finalizePatientReplyText(replyText, {
      priorState,
      profileDisplayName,
      userMessage: bodyText,
      replyContext: isUsageDifficulty ? 'booking_link_usage_difficulty' : 'booking_link_trouble',
      suppressBookingLinkOffer: isUsageDifficulty,
    });
    if (!isUsageDifficulty && linkUrl && !replyText.includes(linkUrl)) {
      replyText = `${replyText}\n${linkUrl}`;
    }
    const lastSede = resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
    const nextState = mergeConversationStatePreservingGreeting(
      priorState,
      {
        state: 'awaiting_booking_link_trouble_followup',
        linkTroubleFirstAtMs: nowMs,
      },
      {
        bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS,
        ...(lastSede ? buildLinkSentStatePatch(lastSede) || {} : {}),
        ...buildLastBotReplyStatePatch(replyText),
      }
    );
    await setConversationState(from, nextState);
    const wrapped = buildAutoReplyWithGreetingIfNeeded(replyText, profileDisplayName, priorState);
    await sendWhatsAppText(from, wrapped.messageText);
    return true;
  }

  if (!getOpenAiApiKey()) {
    const followUpText = processAssistantReplyForPatient(buildBookingPersonalAssistanceMessage(priorState));
    const preservedSessionState = mergeConversationStatePreservingGreeting(
      priorState,
      buildClearedAwaitingLinkConfirmationStatePatch(),
      { bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS }
    );
    await setConversationState(from, preservedSessionState);
    const wrapped = buildAutoReplyWithGreetingIfNeeded(followUpText, profileDisplayName, preservedSessionState);
    await sendWhatsAppText(from, wrapped.messageText);
    return true;
  }
  const openAiFollowUpReply = await fetchOpenAiBookingLinkTroubleReply(bodyText, {
    priorState,
    profileDisplayName,
    linkUrl,
    isFollowUp: true,
  });
  if (!openAiFollowUpReply) {
    console.error('OpenAI booking link trouble follow-up reply unavailable');
    return false;
  }
  const followUpText = processAssistantReplyForPatient(openAiFollowUpReply);
  const finalizedFollowUpText = await finalizePatientReplyText(followUpText, {
    priorState,
    profileDisplayName,
    userMessage: bodyText,
    replyContext: 'booking_link_trouble_followup',
    suppressBookingLinkOffer: true,
  });
  const preservedSessionState = mergeConversationStatePreservingGreeting(
    priorState,
    buildClearedAwaitingLinkConfirmationStatePatch(),
    { bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS }
  );
  await setConversationState(from, preservedSessionState);
  const wrapped = buildAutoReplyWithGreetingIfNeeded(finalizedFollowUpText, profileDisplayName, preservedSessionState);
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

function mapOpenAiSedeTokenToEntry(token) {
  if (typeof token !== 'string') return null;
  const normalized = token.trim().toUpperCase();
  if (normalized === 'CORRIENTES' || normalized === '1') {
    return SEDE_ENTRIES.find((entry) => entry.displayName === 'Corrientes') || null;
  }
  if (normalized === 'RESISTENCIA' || normalized === '2') {
    return SEDE_ENTRIES.find((entry) => entry.displayName === 'Resistencia') || null;
  }
  if (normalized === 'FORMOSA' || normalized === '3') {
    return SEDE_ENTRIES.find((entry) => entry.displayName === 'Formosa') || null;
  }
  if (
    normalized === 'SAENZ PENA' ||
    normalized === 'SAENZ PEÑA' ||
    normalized.includes('SAENZ') ||
    normalized === '4'
  ) {
    return SEDE_ENTRIES.find((entry) => entry.displayName === 'Sáenz Peña') || null;
  }
  return null;
}

async function tryResolveSedeFromTextWithOpenAi(rawText) {
  const fromRules = findSedeFromText(rawText);
  if (fromRules) return fromRules;

  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;

  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un extractor de sede para un consultorio del Dr. Liber Acosta en Corrientes, Resistencia, Formosa y Sáenz Peña (Argentina).',
    'Tarea: identificar a qué ciudad se refiere el paciente en un mensaje de WhatsApp en español.',
    'Respondé SOLO uno de: CORRIENTES, RESISTENCIA, FORMOSA, SAENZ PENA, UNKNOWN.',
    'Aceptá typos, abreviaturas (ctes, resis, ress, rcia, fsa), números de menú (1=Corrientes, 2=Resistencia) y menciones indirectas.',
    'Ejemplos: "soy de corrientes", "de ctes", "ress", "vivo en formosa", "saenz pena", "osde y soy de corrientes".',
    'Si no se puede saber, devolvé UNKNOWN.',
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
        max_tokens: 6,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: String(rawText || '') },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    return mapOpenAiSedeTokenToEntry(typeof text === 'string' ? text : '');
  } catch (error) {
    console.error('OpenAI sede resolver failed', error);
    return null;
  }
}

async function resolveSedeFromTextWithOpenAi(rawText) {
  return findSedeFromText(rawText) || (await tryResolveSedeFromTextWithOpenAi(rawText));
}

async function tryExtractPatientContextWithOpenAi(rawText, priorState) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un extractor de contexto para un consultorio del Dr. Liber Acosta en Corrientes, Resistencia, Formosa y Sáenz Peña (Argentina).',
    'Del mensaje del paciente en español rioplatense extraé ciudad y obra social/prepaga si aparecen.',
    'Respondé SOLO JSON válido con este esquema exacto:',
    '{"city":"CORRIENTES","healthInsurance":"OSDE"}',
    'city debe ser CORRIENTES, RESISTENCIA, FORMOSA, SAENZ PENA o UNKNOWN.',
    'healthInsurance: nombre canónico si se menciona (OSDE, IOSCOR, Sancor, etc.) o null.',
    'Si el paciente dice solo "particular" o quiere atención privada sin cobertura, healthInsurance debe ser null (NO es obra social).',
    'No confundas "particular" con obras sociales cuyo nombre contiene "PARTICULARES".',
    'Aceptá typos y frases combinadas: "osde y soy de corrientes", "ctes con ioscor", "de resis sancor", "vivo en formosa con sancor".',
    'ctes=Corrientes, resis/rcia=Resistencia, fsa=Formosa, saenz pena=Sáenz Peña.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(rawText, {
    conversationContext: priorState ? buildIntentRoutingOpenAiContext(priorState) : '',
    lastAssistantMessage:
      priorState && typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText : '',
  });
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
        max_tokens: 80,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const parsed = tryParseFirstJsonObjectFromText(typeof text === 'string' ? text : '');
    if (!parsed || typeof parsed !== 'object') return null;
    const sedeEntry = mapOpenAiSedeTokenToEntry(parsed.city);
    const healthInsuranceName =
      typeof parsed.healthInsurance === 'string' && parsed.healthInsurance.trim().length > 0
        ? normalizeHealthInsuranceNameForStudyPricing(parsed.healthInsurance.trim())
        : null;
    return { sedeEntry, healthInsuranceName };
  } catch (error) {
    console.error('OpenAI patient context extractor failed', error);
    return null;
  }
}

async function resolvePatientContextFromMessage(rawText, priorState, options = {}) {
  const requiresFreshSede = userMessageRequiresFreshSedeForBooking(rawText, priorState);
  const isPrivatePay = await resolvePrivatePayWithoutHealthInsuranceFromMessage(rawText, {
    priorState,
    profileDisplayName: options.profileDisplayName,
  });
  let sedeEntry = findSedeFromText(rawText) || null;
  if (!sedeEntry && !requiresFreshSede) {
    sedeEntry = resolveSedeEntryFromState(priorState) || resolveLastSedeEntryFromState(priorState) || null;
  }
  let healthInsuranceName = isPrivatePay
    ? null
    : resolveKnownHealthInsuranceNameForStudyPricing(priorState, rawText);

  if (!sedeEntry && !requiresFreshSede) {
    sedeEntry = await resolveSedeFromTextWithOpenAi(rawText);
  }
  if (
    !healthInsuranceName &&
    !isPrivatePay &&
    !shouldSkipHealthInsuranceFuzzyResolutionForMessage(rawText)
  ) {
    const fuzzyHealthInsuranceName = await tryResolveHealthInsuranceNameFromSheetsFuzzy(rawText, {
      priorState,
      profileDisplayName: options.profileDisplayName,
    });
    if (fuzzyHealthInsuranceName) {
      healthInsuranceName = normalizeHealthInsuranceNameForStudyPricing(fuzzyHealthInsuranceName);
    }
  }
  if (getOpenAiApiKey() && (!sedeEntry || (!healthInsuranceName && !isPrivatePay))) {
    const openAiPatientContext = await tryExtractPatientContextWithOpenAi(rawText, priorState);
    if (openAiPatientContext) {
      if (!sedeEntry && openAiPatientContext.sedeEntry && !requiresFreshSede) {
        sedeEntry = openAiPatientContext.sedeEntry;
      }
      if (!healthInsuranceName && !isPrivatePay && openAiPatientContext.healthInsuranceName) {
        healthInsuranceName = openAiPatientContext.healthInsuranceName;
      }
    }
  }

  const statePatch = {
    ...(sedeEntry ? buildLastSedeStatePatch(sedeEntry) || {} : {}),
    ...(healthInsuranceName
      ? { healthInsuranceName, lastHealthInsuranceName: healthInsuranceName }
      : {}),
  };
  return { sedeEntry, healthInsuranceName, statePatch };
}

async function sendAssistedBookingRequiredReply(from, bodyText, priorState, profileDisplayName) {
  if (
    (conversationRecentlyAskedSedeSelection(priorState) || stateLooksLikeAwaitingSedeSelection(priorState)) &&
    !messageLooksLikeAssistedBookingRequest(bodyText)
  ) {
    return tryHandleSedeSelectionAnswer(from, bodyText, priorState, profileDisplayName);
  }
  const needsHandoff = messageAsksToBookWithoutSelfServiceLink(bodyText);
  const replyText = needsHandoff
    ? buildBookingPersonalAssistanceMessage(priorState)
    : buildSelfBookingRequiredReply(priorState);
  const lastSede = resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  const linkUrl = resolveBookingLinkUrlFromPriorState(priorState);
  const shouldPersistLinkSent =
    !needsHandoff && lastSede && linkUrl && typeof replyText === 'string' && replyText.includes(linkUrl);
  const preservedSessionState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    {
      ...(needsHandoff ? { bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS } : {}),
      ...(shouldPersistLinkSent ? buildLinkSentStatePatch(lastSede) || {} : {}),
      ...buildLastBotReplyStatePatch(replyText),
    }
  );
  await setConversationState(from, preservedSessionState);
  const wrapped = buildAutoReplyWithGreetingIfNeeded(replyText, profileDisplayName, preservedSessionState);
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

async function tryHandleWhereToBookQuestion(from, bodyText, priorState, profileDisplayName) {
  if (!messageAsksWhereOrHowToBook(bodyText) && !messageAsksExplicitlyHowToBookTurn(bodyText)) return false;
  const lastSede = resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  if (!lastSede) return false;
  if (
    wasBookingLinkSentRecently(priorState) ||
    hasBookingLinkInStateForSede(priorState, lastSede) ||
    conversationLooksLikeOngoingBookingLinkGuidance(priorState)
  ) {
    return deliverBookingLinkReminderReply(from, bodyText, priorState, profileDisplayName, lastSede);
  }
  return sendBookingLinkForSedeEntry(from, priorState, profileDisplayName, lastSede, bodyText);
}

async function sendBookingFlowReplyForSede(from, bodyText, priorState, profileDisplayName, lastSede) {
  if (isReferralOnlySedeEntry(lastSede)) {
    return sendReferralOnlySedeBookingReply(from, lastSede, priorState, profileDisplayName);
  }
  if (messageLooksLikeAssistedBookingRequest(bodyText)) {
    return sendAssistedBookingRequiredReply(from, bodyText, priorState, profileDisplayName);
  }
  if (messageAsksWhereOrHowToBook(bodyText) || messageAsksExplicitlyHowToBookTurn(bodyText)) {
    if (wasBookingLinkSentRecently(priorState) || hasBookingLinkInStateForSede(priorState, lastSede)) {
      return deliverBookingLinkReminderReply(from, bodyText, priorState, profileDisplayName, lastSede);
    }
    return sendBookingLinkForSedeEntry(from, priorState, profileDisplayName, lastSede, bodyText);
  }
  if (shouldWithholdBookingLinkUntilSedeConfirmed(priorState, bodyText, lastSede)) {
    await sendAskSedeTwoStep(from, profileDisplayName, priorState);
    return true;
  }
  if (await shouldSendBookingLinkDirectly(bodyText, priorState, profileDisplayName)) {
    return sendBookingLinkForSedeEntry(from, priorState, profileDisplayName, lastSede, bodyText);
  }
  if (
    hasBookingLinkInStateForSede(priorState, lastSede) ||
    conversationLooksLikeOngoingBookingLinkGuidance(priorState)
  ) {
    if (messageLooksLikeAssistedBookingRequest(bodyText)) {
      return sendAssistedBookingRequiredReply(from, bodyText, priorState, profileDisplayName);
    }
    if (messageLooksLikeBookingLinkUsageDifficulty(bodyText)) {
      return tryHandleBookingLinkUsageDifficulty(from, bodyText, priorState, profileDisplayName);
    }
    if (messageRequestsPersonalBookingAssistance(bodyText)) {
      return tryHandleBookingPersonalAssistanceRequest(from, bodyText, priorState, profileDisplayName);
    }
    if (
      messageLooksLikeAlreadySentLinkBookingFollowUp(bodyText, priorState) ||
      messageConfirmsLinkSend(bodyText) ||
      messageLooksLikeBookingIntent(bodyText)
    ) {
      return deliverBookingLinkReminderReply(from, bodyText, priorState, profileDisplayName, lastSede);
    }
    return sendAssistedBookingRequiredReply(from, bodyText, priorState, profileDisplayName);
  }
  if (stateHasRecentStudyPriceContext(priorState)) {
    return deliverBookingLinkReply(from, lastSede, priorState, profileDisplayName, {
      conversationStatePatch: {
        ...(buildLastSedeStatePatch(lastSede) || {}),
        ...buildClearedPendingBookingIntentPatch(),
        ...buildClearedPendingBookingDetailsPatch(),
      },
    });
  }
  if (
    getAgendaUrl(lastSede) &&
    (messageLooksLikeBookingIntent(bodyText) || messageLooksLikeSpecificSlotBookingRequest(bodyText)) &&
    messageLooksLikeSpecificSlotBookingRequest(bodyText)
  ) {
    const slotPrefix = buildPreferredSlotBookingAcknowledgementPrefix(lastSede, bodyText);
    return deliverBookingLinkReply(from, lastSede, priorState, profileDisplayName, {
      userMessage: bodyText,
      primaryPrefix: slotPrefix || undefined,
      conversationStatePatch: {
        ...(buildLastSedeStatePatch(lastSede) || {}),
        ...buildClearedAwaitingLinkConfirmationStatePatch(),
        ...buildClearedPendingBookingIntentPatch(),
        ...buildClearedPendingBookingDetailsPatch(),
        ...buildLastScheduleDiscussedStatePatch(),
      },
    });
  }
  const policyReply = await buildBookingPolicyReplyForSede(lastSede, priorState, bodyText, {
    profileDisplayName,
  });
  const wrapped = buildAutoReplyWithGreetingIfNeeded(policyReply, profileDisplayName, priorState);
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(
      priorState,
      buildClearedAwaitingLinkConfirmationStatePatch(),
      {
        ...(wrapped.nextStatePatch || {}),
        ...(buildLastSedeStatePatch(lastSede) || {}),
        ...(buildLinkSentStatePatch(lastSede) || {}),
        ...buildClearedPendingBookingIntentPatch(),
        ...buildClearedPendingBookingDetailsPatch(),
        ...buildLastBotReplyStatePatch(wrapped.messageText),
      }
    )
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

async function tryResolveAddressQuestionWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (apiKey) {
    const modelName = getOpenAiModelName();
    const systemPrompt = [
      'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense.',
      'Tarea: decidir si el paciente pregunta la DIRECCIÓN/UBICACIÓN de la clínica/consultorio/sede o cómo llegar.',
      'Respondé solo: YES o NO.',
      'YES ejemplos: "dónde está la clínica", "dirección del consultorio", "cómo llego", "me pasás la ubi", "dónde queda", "dónde atienden".',
      'NO ejemplos: pedir turno/link/agenda, precio, obra social, qué días atiende el Dr., horarios de consulta del médico.',
      'NO: "consulta" como turno médico; "clínica" preguntando ubicación SÍ es YES.',
    ].join('\n');
    const userContent = buildOpenAiClassifierUserContent(userMessage, {
      conversationContext:
        options.conversationContext ||
        (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
      lastAssistantMessage:
        options.lastAssistantMessage ||
        (options.priorState && typeof options.priorState.lastBotReplyText === 'string'
          ? options.priorState.lastBotReplyText
          : ''),
      profileDisplayName: options.profileDisplayName,
    });

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
            { role: 'user', content: userContent },
          ],
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
        if (normalized.startsWith('YES')) return true;
        if (normalized.startsWith('NO')) return false;
      }
    } catch (error) {
      console.error('OpenAI address question classifier failed', error);
    }
  }

  if (messageAsksAboutSedeAddressOrHowToArrive(userMessage)) return true;
  if (messageAsksForMapsLocation(userMessage) && !messageLooksLikeBookingIntent(userMessage)) return true;
  return false;
}

async function shouldHandleAsAddressQuestion(bodyText, priorState, profileDisplayName, options = {}) {
  if (messageLooksLikeClinicInformationBundleInquiry(bodyText)) return false;
  if (!options.rulesOnly && getOpenAiApiKey()) {
    const openAiDecision = await tryResolveAddressQuestionWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
    });
    if (openAiDecision === true) return true;
    if (openAiDecision === false) return false;
  }
  if (messageAsksAboutSedeAddressOrHowToArrive(bodyText)) return true;
  if (messageAsksForMapsLocation(bodyText) && !messageLooksLikeBookingIntent(bodyText)) return true;
  return false;
}

function messageLooksLikeSedeAddressInquiry(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageLooksLikeClinicLocationAndHoursInquiry(rawText)) return false;
  if (messageAsksAboutSedeAddressOrHowToArrive(rawText)) return true;
  return messageAsksForMapsLocation(rawText) && !messageLooksLikeBookingIntent(rawText);
}

async function tryHandleSedeAddressInquiry(from, bodyText, priorState, profileDisplayName) {
  if (!messageLooksLikeSedeAddressInquiry(bodyText)) return false;
  return sendAddressQuestionReply(from, bodyText, priorState, profileDisplayName);
}

async function sendAddressQuestionReply(from, bodyText, priorState, profileDisplayName) {
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const sedeFromMessage = findSedeFromText(bodyText) || patientContext.sedeEntry;
  const lastSede = sedeFromMessage || resolveLastSedeEntryFromState(mergedState);
  const reply = messageAsksForMapsLocation(bodyText)
    ? buildSedeMapsLocationReply(mergedState, lastSede)
    : buildSedeAddressReply(mergedState, lastSede);
  const finalizedReply = await finalizePatientReplyText(reply, {
    priorState: mergedState,
    profileDisplayName,
    userMessage: bodyText,
    replyContext: 'address_info',
    skipHumanization: true,
  });
  const wrapped = buildAutoReplyWithGreetingIfNeeded(finalizedReply, profileDisplayName, mergedState);
  const preservedSessionState =
    stateLooksLikeAwaitingLinkConfirmation(priorState) && priorState && typeof priorState === 'object'
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
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(
      mergedState,
      {},
      {
        ...(wrapped.nextStatePatch || {}),
        ...(lastSede ? buildLastSedeStatePatch(lastSede) : {}),
        ...preservedSessionState,
        ...buildLastBotReplyStatePatch(wrapped.messageText),
      }
    )
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

async function tryHandleAddressQuestionWithOpenAi(from, bodyText, priorState, profileDisplayName, options = {}) {
  if (!(await shouldHandleAsAddressQuestion(bodyText, priorState, profileDisplayName, options))) {
    return false;
  }
  return sendAddressQuestionReply(from, bodyText, priorState, profileDisplayName);
}

async function tryResolveHealthInsurancePlusIntentWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (apiKey) {
    const modelName = getOpenAiModelName();
    const systemPrompt = [
      'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense (Argentina).',
      'Tarea: decidir si el paciente informa o pregunta por su obra social/prepaga (aceptación, plus, cobertura).',
      'Respondé solo: YES o NO.',
      'YES ejemplos: "tengo obra social PAMI/Pani", "soy de OSDE", "¿aceptan Swis?", "tengo prepaga", "mi obra social es ...".',
      'NO ejemplos: pedir turno/link, precio de consulta, dirección, horarios del Dr., saludo sin mencionar cobertura.',
      'Si dice "tengo obra social X" aunque X sea typo (Pani=PAMI), respondé YES.',
    ].join('\n');
    const userContent = buildOpenAiClassifierUserContent(userMessage, {
      conversationContext:
        options.conversationContext ||
        (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
      lastAssistantMessage:
        options.lastAssistantMessage ||
        (options.priorState && typeof options.priorState.lastBotReplyText === 'string'
          ? options.priorState.lastBotReplyText
          : ''),
      profileDisplayName: options.profileDisplayName,
    });

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
            { role: 'user', content: userContent },
          ],
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
        if (normalized.startsWith('YES')) return true;
        if (normalized.startsWith('NO')) return false;
      }
    } catch (error) {
      console.error('OpenAI health insurance plus intent classifier failed', error);
    }
  }

  if (messageLooksLikeHealthInsurancePlusQuestion(userMessage)) return true;
  if (messageStatesHealthInsuranceMembership(userMessage)) return true;
  return false;
}

async function shouldHandleAsHealthInsurancePlusQuestion(bodyText, priorState, profileDisplayName, options = {}) {
  if (messageLooksLikeClinicInformationBundleInquiry(bodyText)) return false;
  if (messageLooksLikeFamilyConsultationCostEstimateInquiry(bodyText)) return false;
  if (messageLooksLikeRichPatientIntakeInquiry(bodyText)) return false;
  if (messageLooksLikeCombinedConsultationAndStudyPriceInquiry(bodyText)) return false;
  if (!options.rulesOnly && getOpenAiApiKey()) {
    const openAiDecision = await tryResolveHealthInsurancePlusIntentWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
    });
    if (openAiDecision === true) return true;
    if (openAiDecision === false) return false;
  }
  if (messageLooksLikeHealthInsurancePlusQuestion(bodyText)) return true;
  if (messageStatesHealthInsuranceMembership(bodyText)) return true;
  return false;
}

async function sendHealthInsurancePlusQuestionReply(from, bodyText, priorState, profileDisplayName) {
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const healthInsuranceName = await resolveHealthInsuranceNameFromMessage(bodyText, mergedState, {
    profileDisplayName,
  });
  const lastSede = patientContext.sedeEntry || resolveLastSedeEntryFromState(mergedState);

  if (healthInsuranceName && lastSede) {
    return sendHealthInsurancePlusReplyForSedeEntry(
      from,
      lastSede,
      healthInsuranceName,
      mergedState,
      profileDisplayName,
      bodyText
    );
  }

  if (healthInsuranceName && !lastSede) {
    const wrapped = buildAutoReplyWithGreetingIfNeeded(buildAskSedeMessage(), profileDisplayName, mergedState);
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(
        mergedState,
        { state: 'awaiting_health_insurance_city', healthInsuranceName },
        {
          ...(wrapped.nextStatePatch || {}),
          lastHealthInsuranceName: healthInsuranceName,
          ...buildLastBotReplyStatePatch(wrapped.messageText),
        }
      )
    );
    await sendWhatsAppText(from, wrapped.messageText);
    return true;
  }

  const wrapped = buildAutoReplyWithGreetingIfNeeded(
    buildAskHealthInsuranceNameMessage(bodyText),
    profileDisplayName,
    mergedState
  );
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(
      mergedState,
      { state: 'awaiting_health_insurance_name' },
      {
        ...(wrapped.nextStatePatch || {}),
        ...buildLastBotReplyStatePatch(wrapped.messageText),
      }
    )
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

async function tryResolveHealthInsuranceSedeFollowUpWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense.',
    'Tarea: decidir si el paciente pide la MISMA info de obra social/plus/cobertura pero para OTRA sede/ciudad.',
    'Respondé solo: YES o NO.',
    'YES ejemplos: tras hablar de OSDE/Sancor/etc. en una ciudad, dice "y en ctes?", "y en Corrientes?", "y en la otra sede?", "y ahí?" refiriéndose a otra ciudad.',
    'Usá el último mensaje del asistente y la obra social en contexto.',
    'NO ejemplos: primer mensaje con solo ciudad, pedir turno, precio sin contexto previo de obra social, saludo.',
    'NO: si no hubo conversación reciente sobre cobertura/plus de obra social.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.lastAssistantMessage ||
      (options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : ''),
    profileDisplayName: options.profileDisplayName,
  });
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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (normalized.startsWith('YES')) return true;
    if (normalized.startsWith('NO')) return false;
    return null;
  } catch (error) {
    console.error('OpenAI health insurance sede follow-up classifier failed', error);
    return null;
  }
}

async function shouldHandleAsHealthInsuranceSedeFollowUp(bodyText, priorState, profileDisplayName) {
  const healthInsuranceName = resolveActiveHealthInsuranceNameFromState(priorState);
  if (!healthInsuranceName) return false;
  if (!stateHasRecentHealthInsuranceDiscussionContext(priorState)) return false;
  const sedeFromMessage = findSedeFromText(bodyText);
  if (!sedeFromMessage) return false;
  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (lastSede && lastSede.envKey === sedeFromMessage.envKey) return false;
  if (messageLooksLikeAlternateSedeFollowUp(bodyText)) return true;
  if (getOpenAiApiKey()) {
    const openAiDecision = await tryResolveHealthInsuranceSedeFollowUpWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
    });
    if (openAiDecision === true) return true;
    if (openAiDecision === false) return false;
  }
  return false;
}

async function sendHealthInsurancePlusReplyForSedeEntry(
  from,
  sedeEntry,
  healthInsuranceName,
  priorState,
  profileDisplayName,
  bodyText = ''
) {
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    buildLastSedeStatePatch(sedeEntry) || {}
  );
  const replyOptions = { suppressBookingLinkOffer: true, replyContext: 'health_insurance_info' };
  const rawReply = await buildHealthInsurancePlusReplyOrAskCity(
    sedeEntry,
    healthInsuranceName,
    mergedState,
    replyOptions
  );
  if (rawReply === 'ASK_CITY_FOR_HEALTH_INSURANCE') {
    const askCityText = await buildHealthInsuranceMismatchReplyForKnownSede(sedeEntry, healthInsuranceName);
    const askCityWrapped = buildAutoReplyWithGreetingIfNeeded(askCityText, profileDisplayName, mergedState);
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(
        mergedState,
        { state: 'awaiting_health_insurance_city', healthInsuranceName },
        {
          ...(askCityWrapped.nextStatePatch || {}),
          ...(buildLastSedeStatePatch(sedeEntry) || {}),
          healthInsuranceName,
          lastHealthInsuranceName: healthInsuranceName,
          ...buildLastHealthInsuranceDiscussionStatePatch(),
          ...buildLastBotReplyStatePatch(askCityWrapped.messageText),
        }
      )
    );
    await sendWhatsAppText(from, askCityWrapped.messageText);
    return true;
  }
  const focusedReply = await tryResolveFocusedPatientReplyWithOpenAi(rawReply, {
    replyContext: 'health_insurance_info',
    suppressBookingLinkOffer: true,
    skipHumanization: true,
    priorState: mergedState,
    userMessage: bodyText,
    profileDisplayName,
  });
  const wrapped = buildAutoReplyWithGreetingIfNeeded(focusedReply.reply, profileDisplayName, mergedState);
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(
      mergedState,
      {},
      {
        ...(wrapped.nextStatePatch || {}),
        ...(buildLastSedeStatePatch(sedeEntry) || {}),
        healthInsuranceName,
        lastHealthInsuranceName: healthInsuranceName,
        ...buildLastHealthInsuranceDiscussionStatePatch(),
        ...buildLastBotReplyStatePatch(wrapped.messageText),
      }
    )
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

async function tryHandleHealthInsuranceSedeFollowUpWithOpenAi(
  from,
  bodyText,
  priorState,
  profileDisplayName
) {
  if (!(await shouldHandleAsHealthInsuranceSedeFollowUp(bodyText, priorState, profileDisplayName))) {
    return false;
  }
  const healthInsuranceName = resolveActiveHealthInsuranceNameFromState(priorState);
  const sedeFromMessage =
    findSedeFromText(bodyText) || (await resolveSedeFromTextWithOpenAi(bodyText));
  if (!healthInsuranceName || !sedeFromMessage) return false;
  return sendHealthInsurancePlusReplyForSedeEntry(
    from,
    sedeFromMessage,
    healthInsuranceName,
    priorState,
    profileDisplayName,
    bodyText
  );
}

async function tryHandleHealthInsurancePlusWithOpenAi(from, bodyText, priorState, profileDisplayName, options = {}) {
  if (!(await shouldHandleAsHealthInsurancePlusQuestion(bodyText, priorState, profileDisplayName, options))) {
    return false;
  }
  return sendHealthInsurancePlusQuestionReply(from, bodyText, priorState, profileDisplayName);
}

async function tryResolveScheduleQuestionWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense.',
    'Tarea: decidir si el paciente pregunta en qué DÍAS u HORARIOS atiende el DR. (agenda del médico).',
    'Respondé solo: YES o NO.',
    'YES ejemplos: "qué días atiende", "horarios del doctor", "cuándo consulta", "hay turno mañana" (disponibilidad general).',
    'NO ejemplos: solo dirección/ubicación sin preguntar días del Dr., precio, obra social, elegir un día concreto ("martes por favor" = preferencia de turno, no esta pregunta).',
    'NO: horarios de recepción de la clínica si solo preguntan dónde queda.',
    'Si el contexto muestra que ya hablaron de turno y ahora preguntan días del Dr., respondé YES.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : '',
    profileDisplayName: options.profileDisplayName,
  });
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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (normalized.startsWith('YES')) return true;
    if (normalized.startsWith('NO')) return false;
    return null;
  } catch (error) {
    console.error('OpenAI schedule question classifier failed', error);
    return null;
  }
}

async function sendScheduleQuestionReply(from, bodyText, priorState, profileDisplayName) {
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const lastSede = patientContext.sedeEntry || resolveConfirmedSedeEntryForBookingFlow(bodyText, mergedState);
  if (!lastSede) {
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(
        mergedState,
        {
          state: 'awaiting_schedule_sede',
          awaitingScheduleSedeAtMs: Date.now(),
        },
        buildFreshBookingWithoutSedeStatePatch(bodyText)
      )
    );
    await sendAskSedeTwoStep(
      from,
      profileDisplayName,
      { ...mergedState, ...buildFreshBookingWithoutSedeStatePatch(bodyText) },
      '¿Para qué sede querés ver los horarios del Dr.?'
    );
    return true;
  }
  const asksLocationToo =
    messageAsksForMapsLocation(bodyText) || messageAsksAboutSedeAddressOrHowToArrive(bodyText);
  const replyParts = [];
  if (asksLocationToo) {
    replyParts.push(buildSedeMapsLocationReply(mergedState, lastSede));
    const clinicHours = buildSedeClinicHoursReply(lastSede);
    if (clinicHours) replyParts.push(clinicHours);
  }
  replyParts.push(buildScheduleQuestionLinkMessage(lastSede, mergedState));
  const reply = replyParts.join('\n\n');
  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, mergedState);
  const linkAlreadyShared = hasBookingLinkInStateForSede(mergedState, lastSede);
  const scheduleStateBase = linkAlreadyShared
    ? buildClearedAwaitingLinkConfirmationStatePatch()
    : buildAwaitingLinkConfirmationState(lastSede, 'after_schedule_question');
  const replyIncludesBookingUrl =
    typeof reply === 'string' &&
    (reply.includes('calendar.app.google') || reply.includes('calendly.com'));
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(mergedState, scheduleStateBase, {
      ...(wrapped.nextStatePatch || {}),
      ...(buildLastSedeStatePatch(lastSede) || {}),
      ...(replyIncludesBookingUrl ? buildLinkSentStatePatch(lastSede) || {} : {}),
      ...buildLastScheduleDiscussedStatePatch(),
      ...buildPendingBookingIntentStatePatch(),
      ...buildLastBotReplyStatePatch(wrapped.messageText),
    })
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

async function tryHandleScheduleQuestionWithOpenAi(from, bodyText, priorState, profileDisplayName) {
  if (messageLooksLikeHealthInsurancePlusQuestion(bodyText)) return false;
  if (messageStatesHealthInsuranceMembership(bodyText)) return false;
  if (await shouldHandleAsHealthInsurancePlusQuestion(bodyText, priorState, profileDisplayName)) {
    return false;
  }
  const ruleMatch = messageLooksLikeScheduleAvailabilityQuestion(bodyText);
  if (getOpenAiApiKey()) {
    const openAiDecision = await tryResolveScheduleQuestionWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
    });
    if (openAiDecision === false) return false;
    if (openAiDecision === true) {
      return sendScheduleQuestionReply(from, bodyText, priorState, profileDisplayName);
    }
  }
  if (!ruleMatch) return false;
  return sendScheduleQuestionReply(from, bodyText, priorState, profileDisplayName);
}

async function tryResolvePreferredDayBookingWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense.',
    'Tarea: decidir si el paciente elige o prefiere un DÍA DE LA SEMANA para sacar turno con el Dr.',
    'Respondé solo: YES o NO.',
    'YES ejemplos: "martes", "martes por favor", "el jueves", "prefiero lunes", "para el viernes", "ese día" tras hablar de agenda.',
    'Usá el contexto: si el asistente ofreció link/horarios del Dr. y el paciente responde con un día, es YES.',
    'NO ejemplos: pregunta general de horarios ("qué días atiende"), precio, obra social, solo sede ("corrientes"), saludo.',
    'NO: si no hay contexto de turno/agenda y el mensaje no indica preferencia de día para reservar.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : '',
    profileDisplayName: options.profileDisplayName,
  });
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
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (normalized.startsWith('YES')) return true;
    if (normalized.startsWith('NO')) return false;
    return null;
  } catch (error) {
    console.error('OpenAI preferred-day booking classifier failed', error);
    return null;
  }
}

async function shouldHandleAsPreferredDayBooking(bodyText, priorState, profileDisplayName) {
  const weekdayName = extractWeekdayNameFromText(bodyText);
  const relativeDayLabel = extractRelativeDayLabelFromText(bodyText);
  if (!weekdayName && !relativeDayLabel) return false;
  if (
    messageLooksLikeBookingIntent(bodyText) &&
    !messageLooksLikePreferredDayForBooking(bodyText) &&
    !resolveConfirmedSedeEntryForBookingFlow(bodyText, priorState)
  ) {
    return false;
  }
  const hasConversationContext =
    stateHasRecentScheduleDiscussionContext(priorState) ||
    stateHasRecentBookingConversationContext(priorState) ||
    stateHasRecentConsultationPriceAnsweredContext(priorState) ||
    priorStateHasRecentKnownSede(priorState) ||
    stateHasPendingBookingIntent(priorState) ||
    stateLooksLikeAwaitingLinkConfirmation(priorState) ||
    Boolean(resolveConfirmedSedeEntryForBookingFlow('', priorState)) ||
    messageLooksLikePreferredDayForBooking(bodyText);
  if (!hasConversationContext) return false;
  if (getOpenAiApiKey()) {
    const openAiDecision = await tryResolvePreferredDayBookingWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
    });
    if (openAiDecision === true) return true;
    if (openAiDecision === false) return false;
  }
  return messageLooksLikePreferredDayForBooking(bodyText);
}

async function tryHandlePreferredDayBooking(from, bodyText, priorState, profileDisplayName, options = {}) {
  if (
    messageLooksLikeBookingLinkUsageDifficulty(bodyText) &&
    conversationLooksLikeOngoingBookingLinkGuidance(priorState)
  ) {
    return false;
  }
  const forceFromRouter = Boolean(options && options.forceFromRouter);
  if (!forceFromRouter && !(await shouldHandleAsPreferredDayBooking(bodyText, priorState, profileDisplayName))) {
    return false;
  }
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const lastSede = resolveConfirmedSedeEntryForBookingFlow(bodyText, mergedState);
  if (!lastSede) {
    const referralSede = resolveReferralSedeForConversationFollowUp(mergedState, bodyText);
    if (referralSede) {
      return sendReferralOnlySedeBookingReply(
        from,
        referralSede,
        mergedState,
        profileDisplayName,
        bodyText
      );
    }
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(mergedState, mergedState || {}, buildFreshBookingWithoutSedeStatePatch(bodyText))
    );
    await sendAskSedeTwoStep(from, profileDisplayName, {
      ...mergedState,
      ...buildFreshBookingWithoutSedeStatePatch(bodyText),
    });
    return true;
  }
  if (shouldWithholdBookingLinkUntilSedeConfirmed(mergedState, bodyText, lastSede)) {
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(mergedState, mergedState || {}, buildFreshBookingWithoutSedeStatePatch(bodyText))
    );
    await sendAskSedeTwoStep(from, profileDisplayName, {
      ...mergedState,
      ...buildFreshBookingWithoutSedeStatePatch(bodyText),
    });
    return true;
  }
  if (getAgendaUrl(lastSede)) {
    const slotPrefix =
      buildPreferredSlotBookingAcknowledgementPrefix(lastSede, bodyText) ||
      (extractWeekdayNameFromText(bodyText)
        ? `Perfecto, para el ${extractWeekdayNameFromText(bodyText)} en ${lastSede.displayName}. Por acá no agendamos por este chat.`
        : null);
    return deliverBookingLinkReply(from, lastSede, mergedState, profileDisplayName, {
      userMessage: bodyText,
      primaryPrefix: slotPrefix || undefined,
      conversationStatePatch: {
        ...(buildLastSedeStatePatch(lastSede) || {}),
        ...buildClearedAwaitingLinkConfirmationStatePatch(),
        ...buildClearedPendingBookingIntentPatch(),
        ...buildClearedPendingBookingDetailsPatch(),
        ...buildLastScheduleDiscussedStatePatch(),
      },
    });
  }
  const reply = await buildBookingPolicyReplyForSede(lastSede, mergedState, bodyText, {
    profileDisplayName,
  });
  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, mergedState);
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(mergedState, buildClearedAwaitingLinkConfirmationStatePatch(), {
      ...(wrapped.nextStatePatch || {}),
      ...(buildLastSedeStatePatch(lastSede) || {}),
      ...(buildLinkSentStatePatch(lastSede) || {}),
      ...buildClearedPendingBookingIntentPatch(),
      ...buildClearedPendingBookingDetailsPatch(),
      ...buildLastScheduleDiscussedStatePatch(),
      ...buildLastBotReplyStatePatch(wrapped.messageText),
    })
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

async function tryHandleBookingWithPatientContext(from, bodyText, priorState, profileDisplayName) {
  if (messageAsksWhyChooseDoctorOrTrustQuestion(bodyText)) return false;
  if (messageLooksLikeSpirometryOnlyInquiry(bodyText)) return false;
  if (
    conversationLooksLikeOngoingBookingLinkGuidance(priorState) &&
    (messageLooksLikeBookingLinkUsageDifficulty(bodyText) ||
      (await tryResolveBookingLinkTroubleWithOpenAi(bodyText, {
        priorState,
        profileDisplayName,
        rulesOnly: true,
      })))
  ) {
    return false;
  }
  if (
    conversationRecentlyAskedSedeSelection(priorState) &&
    (messageLooksLikeBareSedeOptionAnswer(bodyText) || messageLooksLikeSedeOnlyAnswer(bodyText))
  ) {
    return false;
  }
  if (await shouldHandleAsAddressQuestion(bodyText, priorState, profileDisplayName)) {
    return false;
  }
  if (await shouldHandleAsHealthInsurancePlusQuestion(bodyText, priorState, profileDisplayName)) {
    return false;
  }
  if (await shouldHandleAsConsultationPriceQuestion(bodyText, priorState, profileDisplayName)) {
    return false;
  }
  if (await shouldHandleAsPrivatePriceQuestion(bodyText, priorState, profileDisplayName)) {
    return false;
  }
  if (messageLooksLikeAssistedBookingRequest(bodyText)) return false;

  const isBookingCandidate =
    messageLooksLikeBookingIntent(bodyText) ||
    messageLooksLikeTreatmentAppointmentRequest(bodyText) ||
    messageLooksLikeRealtimeAvailabilityQuestion(bodyText) ||
    messageExplicitlyRequestsBookingLink(bodyText) ||
    stateHasPendingBookingIntent(priorState);
  if (!isBookingCandidate) return false;

  let wantsToBook =
    stateHasPendingBookingIntent(priorState) ||
    messageExplicitlyRequestsBookingLink(bodyText) ||
    messageLooksLikeBookingIntent(bodyText) ||
    messageLooksLikeTreatmentAppointmentRequest(bodyText);
  if (!wantsToBook) {
    wantsToBook = await tryResolveBookingIntentWithOpenAi(bodyText, { priorState, profileDisplayName });
  }
  if (!wantsToBook) return false;

  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const lastSede = resolveConfirmedSedeEntryForBookingFlow(bodyText, mergedState);
  if (lastSede) {
    return sendBookingFlowReplyForSede(from, bodyText, mergedState, profileDisplayName, lastSede);
  }

  const referralSede = resolveReferralSedeForConversationFollowUp(mergedState, bodyText);
  if (referralSede) {
    return sendReferralOnlySedeBookingReply(
      from,
      referralSede,
      mergedState,
      profileDisplayName,
      bodyText
    );
  }

  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(mergedState, mergedState || {}, buildFreshBookingWithoutSedeStatePatch(bodyText))
  );
  await sendAskSedeTwoStep(from, profileDisplayName, {
    ...mergedState,
    ...buildFreshBookingWithoutSedeStatePatch(bodyText),
  });
  return true;
}

const MULTI_INTENT_ROUTER_TOKENS = [
  'HEALTH_INSURANCE',
  'CONSULTATION_PRICE',
  'PRIVATE_PRICE',
  'STUDY_PRICE',
  'BOOKING',
  'SCHEDULE',
  'PREFERRED_DAY',
  'STUDIES',
  'CONDITION',
  'ADDRESS',
  'DOCUMENTS',
  'OTHER',
];

function isOpenAiCentralRoutingEnabled() {
  if (!getOpenAiApiKey()) return false;
  const raw = process.env.OPENAI_AI_FIRST_ROUTING;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return true;
}

function messageShouldSkipOpenAiCentralRouting(rawText, priorState) {
  if (!rawText || typeof rawText !== 'string') return true;
  if (textMatchesMedicalEmergency(rawText)) return true;
  if (messageLooksLikeFarewell(rawText)) return true;
  if (messageLooksLikeGreetingOnly(rawText)) return true;
  if (
    conversationRecentlyAskedSedeSelection(priorState) &&
    (messageLooksLikeSedeOnlyAnswer(rawText) || messageLooksLikeBareSedeOptionAnswer(rawText))
  ) {
    return true;
  }
  if (
    userMessageRequiresFreshSedeForBooking(rawText, priorState) &&
    (messageLooksLikeBookingIntent(rawText) ||
      messageExplicitlyRequestsBookingLink(rawText) ||
      (Boolean(extractWeekdayNameFromText(rawText)) && messageIncludesSpecificAppointmentTime(rawText)))
  ) {
    return true;
  }
  if (messageLooksLikeAlreadySentLinkBookingFollowUp(rawText, priorState)) {
    return true;
  }
  if (messageLooksLikeShortConversationalFollowUp(rawText, priorState)) return false;
  if (messageLooksLikeSedeAddressInquiry(rawText)) return true;
  return false;
}

function messageLooksLikeMultiIntentCandidate(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const signals = [
    messageLooksLikeHealthInsurancePlusQuestion(rawText),
    messageLooksLikePrivatePriceQuestion(rawText),
    messageLooksLikeBookingIntent(rawText) || messageExplicitlyRequestsBookingLink(rawText),
    messageMatchesStudiesTopic(rawText),
    messageAsksAboutConditionTreatment(rawText) || messageAsksAboutTreatmentCost(rawText),
    messageAsksAboutSedeAddressOrHowToArrive(rawText),
    messageAsksAboutDocumentationOrRequirements(rawText) ||
      messageAsksAboutReferralOrPrescription(rawText) ||
      messageAsksAboutPaymentMethods(rawText) ||
      messageAsksAboutInvoice(rawText),
  ].filter(Boolean).length;
  return signals >= 2;
}

async function decidePrimaryIntentWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();

  const systemPrompt = [
    'You are a strict intent router for a WhatsApp clinic assistant in Spanish (Argentina).',
    'Task: Choose the single MOST important intent to answer first.',
    `Return ONLY one token from: ${MULTI_INTENT_ROUTER_TOKENS.join(', ')}.`,
    'Guidelines:',
    '- If asking about accepted insurance / plus / "tengo obra social X": HEALTH_INSURANCE. NOT schedule or booking.',
    '- If asking about CONSULTATION price/costo/valor WITHOUT saying particular (e.g. "qué costo tiene la consulta", "cuánto sale la consulta", "precio de la consulta"): CONSULTATION_PRICE. Must ask obra social before giving particular price. This is NOT booking.',
    '- If asking explicit PARTICULAR consultation price / control / seguimiento particular (e.g. "consulta particular", "precio consulta particular"): PRIVATE_PRICE.',
    '- If context shows pending generic consultation price and user answers with city only: CONSULTATION_PRICE (ask obra social next), NOT PRIVATE_PRICE.',
    '- If asking study/test price (espirometría, prick), obra social plus for a study, or a short follow-up after the assistant offered study value ("si", "dame el precio", "decime el valor"): STUDY_PRICE.',
    '- If asking address / how to arrive / where the clinic is ("dónde está la clínica", "dirección", "cómo llego"): ADDRESS. NOT booking.',
    '- If asking to book / reserve / get the link / sacar turno: BOOKING.',
    '- If explicitly asking for the link now ("pasame link", "link para agendar", "mandame el link"): BOOKING and send link directly, never micro-commitment.',
    '- If asking YOU/the assistant to book FOR them ("agendame vos", "podés agendarme", won\'t use link): OTHER, NOT BOOKING.',
    '- If price objection, anger or frustration ("muy caro", "estoy enojado", "qué bronca") after a price/plus reply: OTHER, NOT STUDY_PRICE or HEALTH_INSURANCE.',
    '- If link was sent and patient reports it does not work/open/load ("no funciona", "no anda", "no abre"): OTHER (link trouble), NOT BOOKING.',
    '- If asking what days/hours the DOCTOR attends (not clinic reception hours): SCHEDULE. Offer agenda link, never list clinic hours as doctor hours.',
    '- If context shows schedule/booking talk and user picks a weekday ("martes", "el jueves") or day+time ("lunes 16hs"): PREFERRED_DAY. Explain no chat booking; send link when sede known.',
    '- If asking about study preparation, what studies to bring, or general study info without price: STUDIES.',
    '- If the assistant last asked "te cuente el valor o preferís agendar" about a study and the user affirms or asks price: STUDY_PRICE, not PRIVATE_PRICE.',
    '- If the user explicitly asks consultation/particular price even with study context: PRIVATE_PRICE.',
    '- If asking if the doctor treats a condition: CONDITION.',
    '- If asking what to bring / referral / authorization / payments / invoice: DOCUMENTS.',
    '- If unclear, return OTHER.',
    '',
    'CRITICAL disambiguation (always use last assistant message + context):',
    '- "tengo obra social X" / "soy de OSDE/PAMI" → HEALTH_INSURANCE, never SCHEDULE or BOOKING.',
    '- "dónde está la clínica" / dirección → ADDRESS, never BOOKING.',
    '- "qué costo tiene la consulta" (sin particular) → CONSULTATION_PRICE, never PRIVATE_PRICE until obra social is collected.',
    '- After "¿Te paso el link?" a short yes ("si", "dale") → BOOKING.',
    '- City name alone after consultation price flow → CONSULTATION_PRICE continuation (ask obra social next).',
    '- Obra social name alone after "¿qué obra social?" → CONSULTATION_PRICE or HEALTH_INSURANCE, never SCHEDULE.',
    '- After obra social/plus reply for one city, user asks another city ("y en ctes", "y en corrientes", "y ahí"): HEALTH_INSURANCE (same coverage for new sede).',
    '- After asking obra social for study/consultation price, user answers with prepaga name only ("Sancor", "OSDE"): CONSULTATION_PRICE or STUDY_PRICE from context, never generic greeting.',
    '- "qué precio" / "cuánto sale" right after cobertura or plus discussion: continue price flow (STUDY_PRICE if study context, else CONSULTATION_PRICE), never "¿en qué te puedo ayudar?".',
    '- Short fragment after assistant question: interpret as answer to THAT question using last assistant message, not a new topic.',
    '- Pick ONE intent for the patient\'s immediate question; do not combine topics.',
  ].join('\n');

  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : '',
    profileDisplayName: options.profileDisplayName,
  });

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
        max_tokens: 12,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
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

async function dispatchOpenAiPrimaryIntent(from, bodyText, priorState, profileDisplayName, primaryIntent) {
  if (!primaryIntent || primaryIntent === 'OTHER') return false;
  if (await tryHandleClinicLocationAndHoursInquiry(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }
  if (messageLooksLikeClinicInformationBundleInquiry(bodyText)) {
    return tryHandleClinicInformationBundleInquiry(from, bodyText, priorState, profileDisplayName);
  }
  if (messageLooksLikeFamilyConsultationCostEstimateInquiry(bodyText)) {
    return tryHandleFamilyConsultationCostEstimateInquiry(from, bodyText, priorState, profileDisplayName);
  }
  if (messageLooksLikeRichPatientIntakeInquiry(bodyText)) {
    return tryHandleRichPatientIntakeInquiry(from, bodyText, priorState, profileDisplayName);
  }
  if (messageLooksLikeCombinedConsultationAndStudyPriceInquiry(bodyText)) {
    return tryHandleCombinedConsultationAndStudyPriceInquiry(from, bodyText, priorState, profileDisplayName);
  }

  if (primaryIntent === 'CONSULTATION_PRICE') {
    return sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName);
  }

  if (primaryIntent === 'HEALTH_INSURANCE') {
    if (messageAsksGenericConsultationPrice(bodyText) || messageLooksLikeAnyPriceQuestion(bodyText)) {
      return sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName);
    }
    return sendHealthInsurancePlusQuestionReply(from, bodyText, priorState, profileDisplayName);
  }

  if (
    primaryIntent === 'STUDY_PRICE' ||
    (primaryIntent === 'STUDIES' && shouldRouteToStudyPrice(bodyText, priorState))
  ) {
    if (!messageLooksLikeSedeOnlyAnswer(bodyText)) {
      if (messageLooksLikeSpirometryOnlyInquiry(bodyText)) {
        return sendSpirometryOnlyInquiryReply(from, bodyText, priorState, profileDisplayName);
      }
      return sendStudyPriceInformationReply(from, bodyText, priorState, profileDisplayName);
    }
  }

  if (primaryIntent === 'PRIVATE_PRICE') {
    if (messageLooksLikeSpirometryOnlyInquiry(bodyText)) {
      return sendSpirometryOnlyInquiryReply(from, bodyText, priorState, profileDisplayName);
    }
    if (
      messageAsksGenericConsultationPrice(bodyText) ||
      shouldAskHealthInsuranceBeforeConsultationPrice(priorState)
    ) {
      return sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName);
    }
    if (shouldRouteToStudyPrice(bodyText, priorState)) {
      return sendStudyPriceInformationReply(from, bodyText, priorState, profileDisplayName);
    }
    return sendPrivatePriceQuestionReply(from, bodyText, priorState, profileDisplayName);
  }

  if (primaryIntent === 'STUDIES' && !messageLooksLikeSedeOnlyAnswer(bodyText)) {
    if (messageLooksLikeSpirometryOnlyInquiry(bodyText)) {
      return sendSpirometryOnlyInquiryReply(from, bodyText, priorState, profileDisplayName);
    }
    const studiesReply = await buildStudiesInformationReply(priorState, bodyText, {
      forcePriceFlow: messageLooksLikeAnyPriceQuestion(bodyText),
      profileDisplayName,
    });
    const detectedStudyType = getStudyTypeFromText(bodyText);
    return deliverStudiesInformationReply(
      from,
      studiesReply,
      priorState,
      profileDisplayName,
      {
        ...(detectedStudyType ? { lastStudyType: detectedStudyType } : {}),
        ...(messageLooksLikeAnyPriceQuestion(bodyText) || detectedStudyType
          ? { lastStudyPriceContextAtMs: Date.now() }
          : {}),
      },
      { userMessage: bodyText, replyContext: 'studies_info' }
    );
  }

  if (primaryIntent === 'SCHEDULE') {
    if (
      !isOpenAiCentralRoutingEnabled() &&
      (await shouldHandleAsHealthInsurancePlusQuestion(bodyText, priorState, profileDisplayName, { rulesOnly: true }))
    ) {
      return sendHealthInsurancePlusQuestionReply(from, bodyText, priorState, profileDisplayName);
    }
    return sendScheduleQuestionReply(from, bodyText, priorState, profileDisplayName);
  }

  if (primaryIntent === 'PREFERRED_DAY') {
    if (await tryHandleBookingLinkUsageDifficulty(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandlePatientDissatisfactionWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandleBookingPersonalAssistanceRequest(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    return tryHandlePreferredDayBooking(from, bodyText, priorState, profileDisplayName, {
      forceFromRouter: true,
    });
  }

  if (primaryIntent === 'ADDRESS') {
    return sendAddressQuestionReply(from, bodyText, priorState, profileDisplayName);
  }

  if (primaryIntent === 'BOOKING') {
    if (await tryHandleSedeAddressInquiry(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandleReferralOnlySedeBookingInquiry(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandleBookingLinkUsageDifficulty(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandlePatientDissatisfactionWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandleBookingPersonalAssistanceRequest(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandleBookingLinkTroubleWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandleAssistedBookingRequest(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandleExplicitBookingLinkRequest(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (
      !isOpenAiCentralRoutingEnabled() &&
      (await shouldHandleAsAddressQuestion(bodyText, priorState, profileDisplayName, { rulesOnly: true }))
    ) {
      return sendAddressQuestionReply(from, bodyText, priorState, profileDisplayName);
    }
    if (stateLooksLikeAwaitingLinkConfirmation(priorState) && messageConfirmsLinkSend(bodyText)) {
      const entryFromState = resolveSedeEntryFromState(priorState);
      if (entryFromState) {
        await sendBookingLinkForSedeEntry(from, priorState, profileDisplayName, entryFromState);
        return true;
      }
    }
    if (await shouldHandleAsPreferredDayBooking(bodyText, priorState, profileDisplayName)) {
      return tryHandlePreferredDayBooking(from, bodyText, priorState, profileDisplayName);
    }
    const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
    const mergedState = mergeConversationStatePreservingGreeting(
      priorState,
      priorState || {},
      patientContext.statePatch
    );
    const lastSede = resolveConfirmedSedeEntryForBookingFlow(bodyText, mergedState);
    if (lastSede) {
      return sendBookingFlowReplyForSede(from, bodyText, mergedState, profileDisplayName, lastSede);
    }
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(mergedState, mergedState || {}, buildFreshBookingWithoutSedeStatePatch(bodyText))
    );
    await sendAskSedeTwoStep(from, profileDisplayName, {
      ...mergedState,
      ...buildFreshBookingWithoutSedeStatePatch(bodyText),
    });
    return true;
  }

  return false;
}

async function sendStudyPriceInformationReply(from, bodyText, priorState, profileDisplayName, options = {}) {
  if (await tryHandlePriceObjectionFollowUpInquiry(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }
  if (messageLooksLikePatientDissatisfactionByRules(bodyText)) {
    return tryHandlePatientDissatisfactionWithOpenAi(from, bodyText, priorState, profileDisplayName);
  }
  const studiesReply = await buildStudiesInformationReply(priorState, bodyText, {
    forcePriceFlow: !messageAsksWhetherDoctorPerformsStudy(bodyText),
    profileDisplayName,
    ...options,
  });
  const detectedStudyType = getStudyTypeFromText(bodyText);
  return deliverStudiesInformationReply(
    from,
    studiesReply,
    priorState,
    profileDisplayName,
    {
      ...(detectedStudyType ? { lastStudyType: detectedStudyType } : {}),
      lastStudyPriceContextAtMs: Date.now(),
    },
    { userMessage: bodyText, replyContext: 'studies_info' }
  );
}

async function tryRouteOpenAiPrimaryIntent(from, bodyText, priorState, profileDisplayName) {
  if (!getOpenAiApiKey()) return false;
  if (stateLooksLikeAwaitingLinkConfirmation(priorState)) return false;

  if (isOpenAiCentralRoutingEnabled()) {
    if (messageShouldSkipOpenAiCentralRouting(bodyText, priorState)) return false;
    const primaryIntent = await decidePrimaryIntentWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
    });
    if (primaryIntent && primaryIntent !== 'OTHER') {
      return dispatchOpenAiPrimaryIntent(from, bodyText, priorState, profileDisplayName, primaryIntent);
    }
    if (await tryHandleSedeAddressInquiry(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    return tryHandleConversationalContinuationWithOpenAi(from, bodyText, priorState, profileDisplayName);
  }

  if (await shouldHandleAsAddressQuestion(bodyText, priorState, profileDisplayName)) {
    return sendAddressQuestionReply(from, bodyText, priorState, profileDisplayName);
  }
  if (await shouldHandleAsHealthInsurancePlusQuestion(bodyText, priorState, profileDisplayName)) {
    return sendHealthInsurancePlusQuestionReply(from, bodyText, priorState, profileDisplayName);
  }
  if (await shouldHandleAsConsultationPriceQuestion(bodyText, priorState, profileDisplayName)) {
    return sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName);
  }
  if (!messageLooksLikeOpenAiIntentRoutingCandidate(bodyText, priorState)) return false;

  const primaryIntent = await decidePrimaryIntentWithOpenAi(bodyText, {
    priorState,
    profileDisplayName,
  });
  if (primaryIntent && primaryIntent !== 'OTHER') {
    return dispatchOpenAiPrimaryIntent(from, bodyText, priorState, profileDisplayName, primaryIntent);
  }
  if (await tryHandleSedeAddressInquiry(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }
  return tryHandleConversationalContinuationWithOpenAi(from, bodyText, priorState, profileDisplayName);
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
    const isSancor = osNormalized.includes('sancor') && !osNormalized.includes('mutual');
    const isKnownNoPlus =
      (cityNormalized.includes('corrientes') && (isOsde || isIsunne || isSancor)) ||
      (cityNormalized.includes('resistencia') && (isOsde || isIsunne || isSancor));
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
    '- Accept typos and variants (e.g., "issune", "issunne", "ioscor", "sancor salud", "pani" for PAMI).',
    '- PAMI may not be in the canonical list; still return bestGuess "PAMI" when the user means PAMI.',
    '- If the user says only "particular" or means private pay without coverage, return isHealthInsurance=false (NOT an OS name).',
    '- Do NOT map "particular" to obra social names containing "PARTICULARES" (e.g. OSDOP DOCENTES PARTICULARES).',
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
    const mappedName = mapHealthInsuranceGuessToKnownName(bestGuess, knownNames);
    if (mappedName) return mappedName;
    const canonicalGuess = normalizeHealthInsuranceCanonicalName(bestGuess);
    if (canonicalGuess) return canonicalGuess;
    return null;
  } catch (error) {
    console.error('OpenAI health-insurance resolver request failed', error);
    return null;
  }
}

async function tryResolveHealthInsuranceNameFromSheetsFuzzy(userMessage, options = {}) {
  if (
    await resolvePrivatePayWithoutHealthInsuranceFromMessage(userMessage, {
      priorState: options.priorState,
      profileDisplayName: options.profileDisplayName,
    })
  ) {
    return null;
  }
  if (shouldSkipHealthInsuranceFuzzyResolutionForMessage(userMessage)) return null;
  const data = await getGoogleSheetsData();
  const knownNames = getUniqueHealthInsuranceNamesFromSheetsData(data);
  if (knownNames.length === 0) return null;
  return mapHealthInsuranceGuessToKnownName(String(userMessage || ''), knownNames);
}

function buildClearedAwaitingLinkConfirmationStatePatch() {
  return {
    state: null,
    sedeEnvKey: null,
    sedeDisplayName: null,
    sedeOptionNumber: null,
    bookingLinkOfferAtMs: null,
    reason: null,
  };
}

function resolveBookingLinkUrlFromState(priorState, entry) {
  if (isReferralOnlySedeEntry(entry)) return null;
  if (priorState && typeof priorState === 'object') {
    const urlFromState =
      typeof priorState.lastBookingLinkUrl === 'string' ? priorState.lastBookingLinkUrl.trim() : '';
    if (urlFromState.length > 0) return urlFromState;
  }
  return entry ? getAgendaUrl(entry) : null;
}

function hasBookingLinkInStateForSede(priorState, entry) {
  if (!priorState || typeof priorState !== 'object' || !entry) return false;
  if (!wasBookingLinkSentRecently(priorState)) return false;
  const linkUrl =
    typeof priorState.lastBookingLinkUrl === 'string' ? priorState.lastBookingLinkUrl.trim() : '';
  if (!linkUrl) return false;
  if (typeof priorState.lastBookingLinkSedeEnvKey === 'string') {
    return priorState.lastBookingLinkSedeEnvKey === entry.envKey;
  }
  return Boolean(resolveLastSedeEntryFromState(priorState)?.envKey === entry.envKey);
}

function buildAwaitingLinkConfirmationState(entry, reason, details = null) {
  if (isReferralOnlySedeEntry(entry)) {
    return {
      ...(buildLastSedeStatePatch(entry) || {}),
      bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS,
    };
  }
  const detailsObject = details && typeof details === 'object' ? details : null;
  const healthInsuranceName =
    detailsObject && typeof detailsObject.healthInsuranceName === 'string'
      ? detailsObject.healthInsuranceName.trim()
      : '';
  return {
    state: 'awaiting_link_confirmation',
    sedeEnvKey: entry.envKey,
    sedeDisplayName: entry.displayName,
    sedeOptionNumber: entry.optionNumber,
    lastSedeEnvKey: entry.envKey,
    lastSedeDisplayName: entry.displayName,
    lastSedeOptionNumber: entry.optionNumber,
    lastSedeAtMs: Date.now(),
    ...(healthInsuranceName ? { lastHealthInsuranceName: healthInsuranceName } : {}),
    bookingLinkOfferAtMs: Date.now(),
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
  const candidateEnvKeys = [];
  if (typeof state.lastSedeEnvKey === 'string' && state.lastSedeEnvKey.trim().length > 0) {
    candidateEnvKeys.push(state.lastSedeEnvKey.trim());
  }
  if (typeof state.sedeEnvKey === 'string' && state.sedeEnvKey.trim().length > 0) {
    candidateEnvKeys.push(state.sedeEnvKey.trim());
  }
  if (typeof state.lastBookingLinkSedeEnvKey === 'string' && state.lastBookingLinkSedeEnvKey.trim().length > 0) {
    candidateEnvKeys.push(state.lastBookingLinkSedeEnvKey.trim());
  }
  for (const entry of SEDE_ENTRIES) {
    if (entry.envKey && candidateEnvKeys.includes(entry.envKey)) return entry;
  }
  const displayNameCandidates = [
    typeof state.lastSedeDisplayName === 'string' ? state.lastSedeDisplayName.trim() : '',
    typeof state.sedeDisplayName === 'string' ? state.sedeDisplayName.trim() : '',
    typeof state.lastBookingLinkSedeDisplayName === 'string' ? state.lastBookingLinkSedeDisplayName.trim() : '',
  ].filter(Boolean);
  for (const displayName of displayNameCandidates) {
    const byDisplayName = SEDE_ENTRIES.find((entry) => entry.displayName === displayName);
    if (byDisplayName) return byDisplayName;
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

function priorStateHasRecentKnownSede(priorState, windowMs = SEDE_SELECTION_WINDOW_MS) {
  if (!priorState || typeof priorState !== 'object') return false;
  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (!lastSede) return false;
  const lastSedeAtMs = Number(priorState.lastSedeAtMs);
  return Number.isFinite(lastSedeAtMs) && Date.now() - lastSedeAtMs <= windowMs;
}

function userMessageRequiresFreshSedeForBooking(bodyText, priorState = null) {
  if (!bodyText || typeof bodyText !== 'string') return false;
  if (findSedeFromText(bodyText)) return false;
  if (priorState && messageLooksLikeAlreadySentLinkBookingFollowUp(bodyText, priorState)) return false;
  if (messageAsksWhereOrHowToBook(bodyText) && priorStateHasKnownBookingSede(priorState)) return false;
  if (
    messageAsksWhereOrHowToBook(bodyText) &&
    priorState &&
    wasBookingLinkSentRecently(priorState)
  ) {
    return false;
  }
  if (priorStateHasRecentKnownSede(priorState)) return false;
  return (
    messageLooksLikeBookingIntent(bodyText) ||
    messageLooksLikeTreatmentAppointmentRequest(bodyText) ||
    messageExplicitlyRequestsBookingLink(bodyText) ||
    (Boolean(extractWeekdayNameFromText(bodyText)) && messageLooksLikePreferredDayForBooking(bodyText))
  );
}

function resolveConfirmedSedeEntryForBookingFlow(bodyText, priorState) {
  if (
    priorState &&
    conversationRecentlyAskedSedeSelection(priorState) &&
    messageLooksLikeBareSedeOptionAnswer(bodyText)
  ) {
    return null;
  }

  const fromMessage = findSedeFromText(bodyText);
  if (fromMessage && !messageLooksLikeBareSedeOptionAnswer(bodyText)) return fromMessage;
  if (fromMessage && !conversationRecentlyAskedSedeSelection(priorState)) return fromMessage;

  if (!priorState || typeof priorState !== 'object') return null;

  if (stateLooksLikeAwaitingSedeSelection(priorState)) return null;

  const activeAwaitingLinkSede = resolveSedeEntryFromState(priorState);
  if (activeAwaitingLinkSede) return activeAwaitingLinkSede;

  if (userMessageRequiresFreshSedeForBooking(bodyText, priorState) && !priorStateHasRecentKnownSede(priorState)) {
    return null;
  }

  if (stateHasPendingBookingIntent(priorState)) {
    const pendingAtMs = Number(priorState.pendingBookingIntentAtMs);
    const lastSede = resolveLastSedeEntryFromState(priorState);
    const lastSedeAt = Number(priorState.lastSedeAtMs);
    if (
      lastSede &&
      Number.isFinite(pendingAtMs) &&
      Number.isFinite(lastSedeAt) &&
      lastSedeAt >= pendingAtMs
    ) {
      return lastSede;
    }
    return null;
  }

  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (!lastSede) return null;

  if (isReferralOnlySedeEntry(lastSede) && !findSedeFromText(bodyText)) {
    return null;
  }

  if (messageAsksWhereOrHowToBook(bodyText)) {
    return lastSede;
  }

  const lastSedeAt = Number(priorState.lastSedeAtMs);
  if (Number.isFinite(lastSedeAt) && Date.now() - lastSedeAt <= SEDE_SELECTION_WINDOW_MS) {
    return lastSede;
  }
  return null;
}

function resolveKnownSedeForConversationContext(priorState) {
  if (!priorState || typeof priorState !== 'object') return null;
  if (stateLooksLikeAwaitingSedeSelection(priorState)) return null;

  const activeSede = resolveSedeEntryFromState(priorState);
  if (activeSede) return activeSede;

  if (stateHasPendingBookingIntent(priorState)) {
    const pendingAtMs = Number(priorState.pendingBookingIntentAtMs);
    const lastSede = resolveLastSedeEntryFromState(priorState);
    const lastSedeAt = Number(priorState.lastSedeAtMs);
    if (
      lastSede &&
      Number.isFinite(pendingAtMs) &&
      Number.isFinite(lastSedeAt) &&
      lastSedeAt >= pendingAtMs
    ) {
      return lastSede;
    }
    return null;
  }

  return resolveLastSedeEntryFromState(priorState);
}

function buildClearedStaleSedeForFreshBookingPatch() {
  return {
    lastSedeEnvKey: null,
    lastSedeDisplayName: null,
    lastSedeOptionNumber: null,
    lastSedeAtMs: null,
    lastBookingLinkUrl: null,
    lastBookingLinkSentAtMs: null,
    lastBookingLinkSedeEnvKey: null,
    bookingLinkOfferAtMs: null,
    sedeEnvKey: null,
    sedeDisplayName: null,
    sedeOptionNumber: null,
    ...buildClearedAwaitingLinkConfirmationStatePatch(),
  };
}

function buildFreshBookingWithoutSedeStatePatch(bodyText) {
  return {
    ...buildPendingBookingIntentStatePatch(),
    ...buildPendingBookingDetailsStatePatch(bodyText),
    ...buildClearedStaleSedeForFreshBookingPatch(),
  };
}

function shouldWithholdBookingLinkUntilSedeConfirmed(priorState, bodyText, sedeEntry) {
  if (messageAsksWhereOrHowToBook(bodyText) && sedeEntry) return false;
  if (stateLooksLikeAwaitingSedeSelection(priorState)) return true;
  const confirmedSede = resolveConfirmedSedeEntryForBookingFlow(bodyText || '', priorState);
  if (!confirmedSede) {
    if (
      stateHasPendingBookingIntent(priorState) ||
      userMessageRequiresFreshSedeForBooking(bodyText || '')
    ) {
      return true;
    }
    return false;
  }
  if (sedeEntry && confirmedSede.envKey !== sedeEntry.envKey) return true;
  return false;
}

function buildStaleBookingSessionResetPatch() {
  return {
    ...buildClearedStaleSedeForFreshBookingPatch(),
    ...buildClearedPendingBookingIntentPatch(),
    ...buildClearedPendingBookingDetailsPatch(),
  };
}

function replyTextContainsAgendaLink(replyText) {
  if (!replyText || typeof replyText !== 'string') return false;
  return /calendar\.app\.google/i.test(replyText);
}

function stripAgendaLinksFromReplyText(replyText) {
  if (!replyText || typeof replyText !== 'string') return replyText;
  return replyText.replace(/\s*https?:\/\/[^\s]*calendar\.app\.google[^\s]*/gi, '').trim();
}

function sanitizePatientReplyWhenSedeUnknown(replyText, priorState, bodyText) {
  if (!replyText || typeof replyText !== 'string') return replyText;
  const asksSede = assistantReplyAsksForSedeCity(replyText);
  const hasAgendaLink = replyTextContainsAgendaLink(replyText);
  const awaitingSedeSelection = conversationRecentlyAskedSedeSelection(priorState);
  const userAnsweredSedeSelection =
    messageLooksLikeSedeOnlyAnswer(bodyText) || messageLooksLikeBareSedeOptionAnswer(bodyText);
  if (userAnsweredSedeSelection && (asksSede || hasAgendaLink)) {
    return stripAgendaLinksFromReplyText(replyText);
  }
  if (hasAgendaLink && asksSede) {
    return stripAgendaLinksFromReplyText(replyText);
  }
  const confirmedSede = resolveConfirmedSedeEntryForBookingFlow(bodyText || '', priorState);
  if (confirmedSede && !asksSede && !awaitingSedeSelection) return replyText;
  if (!hasAgendaLink && !asksSede && !awaitingSedeSelection) return replyText;
  if (asksSede || awaitingSedeSelection || !confirmedSede) {
    return stripAgendaLinksFromReplyText(replyText);
  }
  return replyText;
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

function buildIntentRoutingOpenAiContext(priorState) {
  const contextLines = [];
  const sedeFromState = resolveKnownSedeForConversationContext(priorState);
  if (sedeFromState) {
    contextLines.push(`Sede/ciudad ya informada en la conversación: ${sedeFromState.displayName}. No volver a pedirla salvo cambio explícito.`);
  } else if (
    priorState &&
    typeof priorState === 'object' &&
    typeof priorState.lastSedeDisplayName === 'string' &&
    priorState.lastSedeDisplayName.trim().length > 0
  ) {
    contextLines.push(
      `Ciudad/sede ya informada en la conversación: ${priorState.lastSedeDisplayName.trim()}. No volver a pedirla salvo cambio explícito.`
    );
  }
  if (priorState && typeof priorState === 'object' && typeof priorState.lastStudyType === 'string') {
    const studyType = priorState.lastStudyType.trim();
    if (studyType.length > 0) {
      contextLines.push(`Último estudio mencionado en la conversación: ${studyType}.`);
    }
  }
  if (stateHasRecentStudyPriceContext(priorState)) {
    contextLines.push('Hace poco hablaron del precio de un estudio (espirometría, prick, etc.).');
  }
  if (stateAwaitingStudyPriceFollowUp(priorState) || conversationExpectsStudyPriceOrTypeAnswer(priorState)) {
    contextLines.push(
      'El asistente ofreció contar el valor del estudio o preguntó espirometría vs test de alergia; el usuario probablemente quiere el precio del estudio, no un link de turno.'
    );
  }
  if (stateHasPendingPrivatePriceIntent(priorState)) {
    contextLines.push(
      'El paciente preguntó consulta PARTICULAR y el asistente pidió la ciudad; si responde sede, quiere el valor particular desde Sheets, NO agendar.'
    );
  }
  if (stateHasPendingConsultationPriceIntent(priorState)) {
    contextLines.push(
      'El paciente preguntó el precio/costo de la consulta (sin decir particular) y falta obra social; si responde sede u obra social, continuar con plus/aceptación, NO agendar directo ni apilar particular + link en el mismo mensaje.'
    );
  }
  if (
    priorState &&
    typeof priorState === 'object' &&
    Number.isFinite(Number(priorState.consultationPriceAnsweredAtMs)) &&
    Date.now() - Number(priorState.consultationPriceAnsweredAtMs) <= CONSULTATION_PRICE_ANSWERED_WINDOW_MS
  ) {
    contextLines.push(
      'Ya se respondió el costo/plus de la consulta con obra social; esperar la próxima pregunta del paciente (turno, particular, etc.) sin ofrecer link proactivamente.'
    );
  }
  if (stateHasRecentScheduleDiscussionContext(priorState)) {
    contextLines.push(
      'Hace poco se hablaron de horarios del Dr.; si el paciente dice un día (ej. martes), quiere turno ese día: ofrecer link de agenda, NO listar horarios ni agendar por chat, NO volver a pedir ciudad.'
    );
  }
  if (stateHasPendingBookingIntent(priorState)) {
    const confirmedSede = resolveConfirmedSedeEntryForBookingFlow('', priorState);
    if (confirmedSede) {
      contextLines.push(
        'El paciente quiere turno/agenda y ya confirmó sede; continuar con link o política de agenda, NO preguntar "¿en qué te puedo ayudar?".'
      );
    } else {
      contextLines.push(
        'El paciente quiere turno/agenda pero AÚN NO confirmó sede (Corrientes/Resistencia). Preguntar sede solamente; NO enviar link de agenda todavía.'
      );
    }
  }
  if (priorState && typeof priorState === 'object' && typeof priorState.lastBotReplyText === 'string') {
    const lastBotReplyText = priorState.lastBotReplyText.trim();
    if (lastBotReplyText.length > 0) {
      contextLines.push(`Último mensaje del asistente:\n${lastBotReplyText.slice(0, LAST_BOT_REPLY_TEXT_MAX_LENGTH)}`);
    }
  }
  const healthInsuranceFromState =
    priorState && typeof priorState === 'object' && typeof priorState.healthInsuranceName === 'string'
      ? priorState.healthInsuranceName.trim()
      : priorState &&
          typeof priorState === 'object' &&
          typeof priorState.lastHealthInsuranceName === 'string'
        ? priorState.lastHealthInsuranceName.trim()
        : '';
  if (healthInsuranceFromState) {
    contextLines.push(`Obra social o prepaga en contexto: ${healthInsuranceFromState}.`);
  }
  if (stateHasRecentHealthInsuranceDiscussionContext(priorState)) {
    contextLines.push(
      'Recién hablaron de cobertura/plus de obra social. Si el paciente menciona otra ciudad o sede (ej. "y en ctes?"), quiere la misma info para esa sede, no un saludo genérico.'
    );
  }
  if (priorState && typeof priorState === 'object' && typeof priorState.state === 'string') {
    contextLines.push(`Estado conversacional: ${priorState.state}.`);
  }
  return contextLines.join('\n');
}

function messageLooksLikeOpenAiIntentRoutingCandidate(rawText, priorState) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (textMatchesMedicalEmergency(rawText)) return false;
  if (messageLooksLikeGreetingOnly(rawText)) return false;
  if (stateLooksLikeAwaitingLinkConfirmation(priorState)) {
    if (messageConfirmsLinkSend(rawText) || messageClearlyRejectsLinkSend(rawText)) return false;
    const wordCount = normalizeForMatch(rawText).split(' ').filter(Boolean).length;
    if (wordCount <= 4) return false;
  }
  if (
    conversationRecentlyAskedSedeSelection(priorState) &&
    (messageLooksLikeSedeOnlyAnswer(rawText) || messageLooksLikeBareSedeOptionAnswer(rawText))
  ) {
    return false;
  }
  const hasStudyContext = stateHasRecentStudyPriceContext(priorState);
  const hasPriceSignal =
    messageLooksLikeAnyPriceQuestion(rawText) ||
    messageExplicitlyAsksPrivateConsultationPrice(rawText);
  const hasBookingSignal =
    messageLooksLikeBookingIntent(rawText) || messageExplicitlyRequestsBookingLink(rawText);
  const hasStudySignal = messageMatchesStudiesTopic(rawText);
  if (messageLooksLikeStudyPriceFollowUp(rawText, priorState)) return true;
  if (messageLooksLikeHealthInsurancePlusQuestion(rawText)) return true;
  if (messageStatesHealthInsuranceMembership(rawText)) return true;
  if (messageAsksAboutSedeAddressOrHowToArrive(rawText)) return true;
  if (messageAsksForMapsLocation(rawText) && !messageLooksLikeBookingIntent(rawText)) return true;
  if (shouldAskHealthInsuranceBeforeConsultationPrice(priorState)) return true;
  if (stateHasPendingPrivatePriceIntent(priorState)) return true;
  if (stateHasPendingConsultationPriceIntent(priorState)) return true;
  if (messageAsksGenericConsultationPrice(rawText)) return true;
  if (hasStudyContext && hasPriceSignal) return true;
  if (hasPriceSignal && hasBookingSignal) return true;
  if (hasPriceSignal) return true;
  if (hasStudyContext && (hasBookingSignal || hasStudySignal)) return true;
  if (messageLooksLikeMultiIntentCandidate(rawText)) return true;
  if (hasStudySignal && messageAsksAboutStudyPreparation(rawText, priorState)) return true;
  if (messageLooksLikeScheduleAvailabilityQuestion(rawText)) return true;
  if (
    stateHasRecentScheduleDiscussionContext(priorState) ||
    stateHasRecentBookingConversationContext(priorState) ||
    stateHasPendingBookingIntent(priorState)
  ) {
    return true;
  }
  if (extractWeekdayNameFromText(rawText) && resolveConfirmedSedeEntryForBookingFlow('', priorState)) {
    return true;
  }
  if (messageLooksLikeShortConversationalFollowUp(rawText, priorState)) return true;
  if (stateHasRecentHealthInsuranceDiscussionContext(priorState)) return true;
  if (stateLooksLikeAwaitingUrgencyClarification(priorState)) return true;
  return false;
}

function stateHasActiveConversationalThread(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  if (!lastBotReplyText) return false;
  const lastBotReplyAtMs = Number(priorState.lastBotReplyAtMs);
  if (Number.isFinite(lastBotReplyAtMs) && Date.now() - lastBotReplyAtMs <= HEALTH_INSURANCE_DISCUSSION_WINDOW_MS) {
    return true;
  }
  return typeof priorState.state === 'string' && priorState.state.trim().length > 0;
}

function messageLooksLikeShortConversationalFollowUp(rawText, priorState) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (
    conversationRecentlyAskedSedeSelection(priorState) &&
    (messageLooksLikeSedeOnlyAnswer(rawText) || messageLooksLikeBareSedeOptionAnswer(rawText))
  ) {
    return false;
  }
  if (!stateHasActiveConversationalThread(priorState)) return false;
  if (messageLooksLikeGreetingOnly(rawText)) return false;
  if (textMatchesMedicalEmergency(rawText)) return false;
  const wordCount = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean).length;
  return wordCount <= 8;
}

async function tryResolveConversationContinuationWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador de CONTINUIDAD conversacional para WhatsApp de un consultorio médico en español rioplatense.',
    'Tarea: decidir qué tema sigue el paciente según el último mensaje del asistente y el contexto.',
    'Respondé solo UNA palabra de esta lista:',
    'HEALTH_INSURANCE_CITY, HEALTH_INSURANCE, STUDY_PRICE, CONSULTATION_PRICE, BOOKING, SCHEDULE, NONE.',
    'HEALTH_INSURANCE_CITY: misma info de obra social/plus pero para otra sede ("y en ctes", "y en corrientes").',
    'HEALTH_INSURANCE: informa o pregunta obra social/plus sin cambio de sede.',
    'STUDY_PRICE: quiere valor de estudio (espirometría, prick) o sigue flujo de precio de estudio.',
    'STUDY_PRICE también si el asistente preguntó si quiere el valor del estudio y el paciente confirma con humor o coloquialismo ("si eso eso", "como diría el chavo", "dale contame", "eso").',
    'CONSULTATION_PRICE: quiere precio de consulta u obra social para cotizar consulta.',
    'BOOKING: turno, link, agendar, día preferido. NO uses BOOKING si solo confirma que quiere el precio del estudio.',
    'SCHEDULE: qué días/horarios atiende el Dr.',
    'NONE: no es continuación clara o es saludo/despedida.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : '',
    profileDisplayName: options.profileDisplayName,
  });
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
        max_tokens: 12,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    const allowed = [
      'HEALTH_INSURANCE_CITY',
      'HEALTH_INSURANCE',
      'STUDY_PRICE',
      'CONSULTATION_PRICE',
      'BOOKING',
      'SCHEDULE',
      'NONE',
    ];
    for (const token of allowed) {
      if (normalized.startsWith(token)) return token;
    }
    return null;
  } catch (error) {
    console.error('OpenAI conversation continuation classifier failed', error);
    return null;
  }
}

async function tryClassifyStudyPriceAffirmationWithOpenAi(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();
  const systemPrompt = [
    'Sos un clasificador para WhatsApp de un consultorio médico en español rioplatense (Argentina).',
    'El asistente acaba de ofrecer contar el valor de un estudio (espirometría o test de alergia) o preguntó cuál estudio cotizar.',
    'Tarea: decidir si el paciente CONFIRMA que quiere el precio/valor del estudio.',
    'Respondé solo una etiqueta: CONFIRM_STUDY_PRICE, OTHER o UNSURE.',
    '',
    'CONFIRM_STUDY_PRICE: afirmaciones, humor, coloquialismos que significan "sí, contame el precio" (ej. "si eso eso", "como diría el chavo", "dale", "eso", "contame", "si por favor").',
    'OTHER: pide turno/link, cambia de tema, pregunta otra cosa, o dice no.',
    'UNSURE: no alcanza el contexto.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    conversationContext:
      options.conversationContext ||
      (options.priorState ? buildIntentRoutingOpenAiContext(options.priorState) : ''),
    lastAssistantMessage:
      options.priorState && typeof options.priorState.lastBotReplyText === 'string'
        ? options.priorState.lastBotReplyText
        : '',
    profileDisplayName: options.profileDisplayName,
  });
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
        max_tokens: 12,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (normalized.startsWith('CONFIRM_STUDY_PRICE')) return true;
    if (normalized.startsWith('OTHER')) return false;
    return null;
  } catch (error) {
    console.error('OpenAI study-price affirmation classifier failed', error);
    return null;
  }
}

async function tryHandleStudyPriceAffirmativeFollowUp(from, bodyText, priorState, profileDisplayName) {
  if (!conversationExpectsStudyPriceOrTypeAnswer(priorState)) return false;
  if (messageLooksLikeBookingIntent(bodyText) || messageExplicitlyRequestsBookingLink(bodyText)) return false;

  let wantsStudyPrice = messageLooksLikeStudyPriceFollowUp(bodyText, priorState);
  if (!wantsStudyPrice && getOpenAiApiKey()) {
    const openAiAffirms = await tryClassifyStudyPriceAffirmationWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
    });
    if (openAiAffirms === true) wantsStudyPrice = true;
    if (openAiAffirms === false) return false;
  }
  if (!wantsStudyPrice) return false;

  const priceHintText = buildStudyPriceHintFromConversation(bodyText, priorState);
  await sendStudyPriceInformationReply(from, priceHintText, priorState, profileDisplayName);
  return true;
}

async function tryHandleConversationalContinuationWithOpenAi(
  from,
  bodyText,
  priorState,
  profileDisplayName
) {
  if (!getOpenAiApiKey()) return false;
  if (!stateHasActiveConversationalThread(priorState)) return false;

  if (await tryHandlePriceObjectionFollowUpInquiry(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }

  if (await tryHandleStudyPriceAffirmativeFollowUp(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }

  if (await tryHandleHealthInsuranceSedeFollowUpWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }

  if (
    stateHasRecentHealthInsuranceDiscussionContext(priorState) &&
    messageLooksLikeAnyPriceQuestion(bodyText)
  ) {
    if (stateHasRecentStudyPriceContext(priorState) || getStudyTypeFromText(bodyText)) {
      return sendStudyPriceInformationReply(from, bodyText, priorState, profileDisplayName);
    }
    return sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName);
  }

  if (messageLooksLikeAlternateSedeFollowUp(bodyText)) {
    if (await tryHandleHealthInsuranceSedeFollowUpWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
  }

  let continuation = null;
  if (
    messageLooksLikeShortConversationalFollowUp(bodyText, priorState) ||
    stateHasRecentHealthInsuranceDiscussionContext(priorState) ||
    stateHasPendingBookingIntent(priorState) ||
    stateHasRecentStudyPriceContext(priorState)
  ) {
    continuation = await tryResolveConversationContinuationWithOpenAi(bodyText, {
      priorState,
      profileDisplayName,
    });
  }

  if (!continuation || continuation === 'NONE') return false;

  if (continuation === 'HEALTH_INSURANCE_CITY' || continuation === 'HEALTH_INSURANCE') {
    return sendHealthInsurancePlusQuestionReply(from, bodyText, priorState, profileDisplayName);
  }
  if (continuation === 'STUDY_PRICE') {
    return sendStudyPriceInformationReply(from, bodyText, priorState, profileDisplayName);
  }
  if (continuation === 'CONSULTATION_PRICE') {
    return sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName);
  }
  if (continuation === 'BOOKING') {
    return tryHandleBookingWithPatientContext(from, bodyText, priorState, profileDisplayName);
  }
  if (continuation === 'SCHEDULE') {
    return sendScheduleQuestionReply(from, bodyText, priorState, profileDisplayName);
  }
  return false;
}

async function tryHandleSmartOpenAiFallback(from, bodyText, priorState, profileDisplayName) {
  if (!getOpenAiApiKey()) return false;
  if (messageLooksLikeSedeOnlyAnswer(bodyText) || messageLooksLikeBareSedeOptionAnswer(bodyText)) {
    if (await tryHandleSedeSelectionAnswer(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
  }
  if (await tryHandleBookingLinkUsageDifficulty(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }
  if (await tryHandlePatientDissatisfactionWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }
  if (await tryHandleBookingPersonalAssistanceRequest(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }
  if (await tryHandleAlreadySentBookingLinkFollowUp(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }
  if (
    messageLooksLikeBookingIntent(bodyText) ||
    messageExplicitlyRequestsBookingLink(bodyText) ||
    userMessageRequiresFreshSedeForBooking(bodyText, priorState)
  ) {
    if (await tryHandlePreferredDayBooking(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandleBookingWithPatientContext(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
  }
  if (await tryHandleSedeAddressInquiry(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }
  if (await tryHandleConversationalContinuationWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }
  if (await tryHandlePriceObjectionFollowUpInquiry(from, bodyText, priorState, profileDisplayName)) {
    return true;
  }
  const primaryIntent = await decidePrimaryIntentWithOpenAi(bodyText, {
    priorState,
    profileDisplayName,
  });
  if (primaryIntent && primaryIntent !== 'OTHER') {
    return dispatchOpenAiPrimaryIntent(from, bodyText, priorState, profileDisplayName, primaryIntent);
  }
  if (priorStateLooksLikeRecentPriceObjectionContext(priorState)) {
    return false;
  }
  if (
    messageLooksLikeClinicLocationAndHoursInquiry(bodyText) ||
    messageAsksAboutSedeAddressOrHowToArrive(bodyText) ||
    messageAsksForMapsLocation(bodyText) ||
    messageAsksAboutClinicHours(bodyText)
  ) {
    if (await tryHandleClinicLocationAndHoursInquiry(from, bodyText, priorState, profileDisplayName)) {
      return true;
    }
    if (await tryHandleAddressQuestionWithOpenAi(from, bodyText, priorState, profileDisplayName, { rulesOnly: true })) {
      return true;
    }
    if (await tryHandleScheduleQuestionWithOpenAi(from, bodyText, priorState, profileDisplayName, { rulesOnly: true })) {
      return true;
    }
    return false;
  }
  const referralSedeFromMessage = findSedeFromText(bodyText);
  if (
    referralSedeFromMessage &&
    isReferralOnlySedeEntry(referralSedeFromMessage) &&
    (messageLooksLikeBookingIntent(bodyText) || messageLooksLikeTreatmentAppointmentRequest(bodyText))
  ) {
    return sendReferralOnlySedeBookingReply(from, referralSedeFromMessage, priorState, profileDisplayName);
  }
  const openAiReply = await fetchOpenAiAssistantReply(bodyText, {
    profileDisplayName,
    priorState,
  });
  if (!openAiReply) return false;
  const processed = processAssistantReplyForPatient(openAiReply, { priorState, bodyText });
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState, { profileDisplayName });
  const statePatch = {
    greeted: true,
    lastBotReplyAtMs: Date.now(),
    ...(patientContext.statePatch || {}),
    ...buildLastBotReplyStatePatch(processed),
  };
  if (assistantReplyAsksForSedeCity(processed)) {
    Object.assign(statePatch, buildAwaitingSedeSelectionStatePatch());
    Object.assign(statePatch, buildClearedStaleSedeForFreshBookingPatch());
    if (messageAsksGenericConsultationPrice(bodyText)) {
      Object.assign(statePatch, buildPendingConsultationPriceIntentStatePatch());
    } else if (await shouldHandleAsPrivatePriceQuestion(bodyText, priorState, profileDisplayName)) {
      Object.assign(statePatch, buildPendingPrivatePriceIntentStatePatch());
    }
  }
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(priorState, priorState || {}, statePatch)
  );
  await sendWhatsAppText(from, processed);
  return true;
}

async function sendPrivatePriceQuestionReply(from, bodyText, priorState, profileDisplayName) {
  if (messageLooksLikeSpirometryOnlyInquiry(bodyText)) {
    return sendSpirometryOnlyInquiryReply(from, bodyText, priorState, profileDisplayName);
  }
  const lastSede =
    findSedeFromText(bodyText) ||
    resolveSedeEntryFromState(priorState) ||
    resolveLastSedeEntryFromState(priorState);
  if (lastSede) {
    const healthInsuranceDecision = await tryResolveRequiresHealthInsuranceBeforeConsultationPriceWithOpenAi(
      bodyText,
      {
        priorState,
        profileDisplayName,
        conversationContext: buildIntentRoutingOpenAiContext(priorState),
        lastAssistantMessage:
          priorState && typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText : '',
      }
    );
    if (!healthInsuranceDecision || healthInsuranceDecision.requiresHealthInsurance) {
      return sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName);
    }
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
        {
          ...(wrapped.nextStatePatch || {}),
          ...(buildLastSedeStatePatch(lastSede) || {}),
          ...buildClearedPendingPrivatePriceIntentPatch(),
          ...buildLastBotReplyStatePatch(wrapped.messageText),
        }
      )
    );
    await sendWhatsAppText(from, wrapped.messageText);
    return true;
  }
  const wrapped = buildAutoReplyWithGreetingIfNeeded(
    buildAskSedeForPrivatePriceMessage(),
    profileDisplayName,
    priorState
  );
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(
      priorState,
      {
        ...buildAwaitingSedeSelectionStatePatch(),
        ...buildPendingPrivatePriceIntentStatePatch(),
      },
      {
        ...(wrapped.nextStatePatch || {}),
        ...buildLastBotReplyStatePatch(wrapped.messageText),
      }
    )
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
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

function messageLooksLikeRealtimeAvailabilityQuestion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsTomorrow =
    normalized.includes('manana') ||
    normalized.includes('mañana') ||
    Boolean(extractRelativeDayLabelFromText(rawText));
  const asksAvailability =
    normalized.includes('tenes algo') ||
    normalized.includes('tenés algo') ||
    normalized.includes('tienes algo') ||
    normalized.includes('tenes turnos') ||
    normalized.includes('tenés turnos') ||
    normalized.includes('tienes turnos') ||
    normalized.includes('hay turnos') ||
    normalized.includes('hay turno') ||
    normalized.includes('hay turno para hoy') ||
    normalized.includes('hay turnos para hoy') ||
    normalized.includes('hay turno hoy') ||
    normalized.includes('para manana hay turno') ||
    normalized.includes('para mañana hay turno') ||
    normalized.includes('hay disponibilidad') ||
    normalized.includes('tienen disponibilidad') ||
    normalized.includes('tienen para esta semana') ||
    normalized.includes('hay para esta semana');
  if (asksAvailability) return true;
  if (
    mentionsTomorrow &&
    (normalized.includes('tenes') ||
      normalized.includes('tenés') ||
      normalized.includes('tienes') ||
      normalized.includes('hay') ||
      messageIncludesSpecificAppointmentTime(rawText))
  ) {
    return true;
  }
  return false;
}

function messageContainsExplicitHowBookingQuestion(normalized) {
  if (!normalized || typeof normalized !== 'string') return false;
  if (/\bcomo estas\b/.test(normalized) || /\bcomo esta\b/.test(normalized)) return false;
  return (
    /\bcomo hago\b/.test(normalized) ||
    /\bcomo funciona\b/.test(normalized) ||
    /\bcomo seria\b/.test(normalized) ||
    /\bcomo es el proceso\b/.test(normalized) ||
    /\bcomo es para\b/.test(normalized) ||
    (/\bcomo es\b/.test(normalized) &&
      !/\bcomo estas\b/.test(normalized) &&
      !/\bcomo esta\b/.test(normalized)) ||
    /\bcomo puedo sacar\b/.test(normalized) ||
    /\bpuedo sacar un turno\b/.test(normalized) ||
    /\bpuedo sacar turno\b/.test(normalized)
  );
}

function messageAsksHowBookingWorks(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    messageLooksLikeBookingIntent(rawText) &&
    !messageAsksExplicitlyHowToBookTurn(rawText) &&
    !messageAsksWhereOrHowToBook(rawText) &&
    !messageContainsExplicitHowBookingQuestion(normalized)
  ) {
    return false;
  }
  const hasBookingKeyword =
    /\b(agendar|agenda|turno|turnos|reservar|reserva|cita)\b/.test(normalized) ||
    normalized.includes('para agendar') ||
    normalized.includes('sacar turno');
  const hasHowQuestion = messageContainsExplicitHowBookingQuestion(normalized);
  if (hasBookingKeyword && hasHowQuestion) return true;
  return (
    normalized === 'como es' ||
    normalized === 'como seria' ||
    normalized === 'como funciona' ||
    normalized === 'como hago' ||
    hasHowQuestion
  );
}

function messageAsksExplicitlyHowToBookTurn(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return (
    normalized.includes('como puedo sacar') ||
    normalized.includes('cómo puedo sacar') ||
    normalized.includes('como saco turno') ||
    normalized.includes('cómo saco turno') ||
    normalized.includes('como pido turno') ||
    normalized.includes('cómo pido turno') ||
    normalized.includes('como reservo') ||
    normalized.includes('cómo reservo') ||
    normalized.includes('como agendo') ||
    normalized.includes('cómo agendo') ||
    normalized.includes('puedo sacar un turno') ||
    normalized.includes('puedo sacar turno')
  );
}

function buildBareConversationAcknowledgementDraft() {
  return 'Genial. Cualquier otra consulta, escribime.';
}

function buildSedeScheduleReply(entry) {
  if (!entry) return null;
  return buildScheduleQuestionLinkMessage(entry);
}

function buildSedeClinicHoursReply(entry) {
  if (!entry) return null;
  const clinicHours = getSedeClinicHours(entry);
  return clinicHours ? `Horarios de la clínica: ${clinicHours}` : null;
}

function messageAsksWhereOrHowToBook(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const whereHowPatterns = [
    /\bdonde\s+agend/,
    /\bdonde\s+reserv/,
    /\bdonde\s+saco\s+turno/,
    /\bdonde\s+turno/,
    /\bcomo\s+agend/,
    /\bcomo\s+reserv/,
    /\bcomo\s+saco\s+turno/,
    /\bpor\s+donde\s+agend/,
    /\bpor\s+donde\s+reserv/,
    /\bdonde\s+me\s+anoto/,
    /\bdonde\s+anoto/,
    /\ben\s+donde\s+agend/,
    /\ben\s+donde\s+reserv/,
  ];
  if (whereHowPatterns.some((pattern) => pattern.test(normalized))) return true;
  return (
    (normalized.includes('donde') || normalized.includes('como')) &&
    (normalized.includes('agend') || normalized.includes('turno') || normalized.includes('reserv'))
  );
}

function priorStateHasKnownBookingSede(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  return Boolean(resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState));
}

function messageLooksLikeBookingIntent(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageAsksWhyChooseDoctorOrTrustQuestion(rawText)) return false;
  if (messageLooksLikePrivatePriceQuestion(rawText)) return false;
  const normalized = normalizeForMatch(rawText);
  if (messageAsksGenericConsultationPrice(rawText)) return false;
  if (
    messageLooksLikeAnyPriceQuestion(rawText) &&
    /\b(consulta|turno|visita)\b/.test(normalized)
  ) {
    return false;
  }
  // Common intent words
  if (/\b(turno|turnos|agendar|agenda|reservar|reserva|cita)\b/.test(normalized)) return true;
  // Tolerate misspellings in key intent words.
  if (normalizedTextContainsApproxWord(normalized, 'turno', 2)) return true;
  if (normalizedTextContainsApproxWord(normalized, 'agendar', 2)) return true;
  if (normalizedTextContainsApproxWord(normalized, 'reservar', 2)) return true;
  if (normalizedTextContainsApproxWord(normalized, 'consulta', 2)) {
    if (messageLooksLikeAnyPriceQuestion(rawText)) return false;
    return true;
  }
  // Tolerate common typos like "urno" (missing t)
  if (/\burno\b/.test(normalized) || /\bun\s*urno\b/.test(normalized)) return true;
  if (messageLooksLikeTreatmentAppointmentRequest(rawText)) return true;
  return false;
}

function messageExplicitlyRequestsBookingLink(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  if (
    normalized.includes('pasame link') ||
    normalized.includes('mandame link') ||
    normalized.includes('enviame link') ||
    normalized.includes('link para agendar') ||
    normalized.includes('link para reserv') ||
    normalized.includes('link de agenda') ||
    normalized.includes('link de turno') ||
    normalized.includes('link del turno')
  ) {
    return true;
  }
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
    normalized.includes('quiero link') ||
    normalized.includes('pasa el link') ||
    normalized.includes('pasa link') ||
    normalized.includes('dale el link') ||
    normalized.includes('necesito el link')
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
    normalized.includes('adolesc') ||
    normalized.includes('adolecent') ||
    normalized.includes('pediatr') ||
    normalized.includes('infantil')
  );
}

function messageMentionsSpirometryStudy(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  if (normalized.includes('espirometr') || normalized.includes('estirometr')) return true;
  const spirometryTypoPatterns = [
    'eperitometria',
    'epirometria',
    'espirimetria',
    'espirometia',
    'espitometria',
    'espirometrea',
    'espirometri',
  ];
  if (spirometryTypoPatterns.some((pattern) => normalized.includes(pattern))) return true;
  return normalizedTextContainsApproxWord(normalized, 'espirometria', 3);
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
    messageMentionsSpirometryStudy(rawText) ||
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
  if (messageAsksAboutStudiesOrTests(rawText) || messageMatchesStudiesPatientOnlyFaq(rawText)) return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('que tengo que llevar') ||
    normalized.includes('qué tengo que llevar') ||
    normalized.includes('que llevo') ||
    normalized.includes('qué llevo') ||
    normalized.includes('que hay que llevar') ||
    normalized.includes('debo llevar') ||
    normalized.includes('debo traer') ||
    normalized.includes('que debo llevar') ||
    normalized.includes('que debo traer') ||
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
  const mentionsWhere =
    normalized.includes('donde queda') ||
    normalized.includes('donde esta') ||
    normalized.includes('donde atienden') ||
    normalized.includes('donde atiende') ||
    normalized.includes('donde consulta') ||
    normalized.includes('donde es') ||
    normalized.includes('donde queda la') ||
    normalized.includes('donde esta la');
  const mentionsAddress =
    normalized.includes('direccion') ||
    normalized.includes('dirección') ||
    normalized.includes('ubicacion') ||
    normalized.includes('ubicación') ||
    normalized.includes('como llego') ||
    normalized.includes('cómo llego') ||
    normalized.includes('como llegar') ||
    normalized.includes('cómo llegar');
  const mentionsClinicPlace =
    normalized.includes('clinica') ||
    normalized.includes('clínica') ||
    normalized.includes('clinca') ||
    normalizedTextContainsApproxWord(normalized, 'clinica', 1) ||
    normalized.includes('consultorio') ||
    normalized.includes('sede') ||
    normalized.includes('centro medico') ||
    normalized.includes('centro médico');
  if (mentionsAddress) return true;
  if (mentionsWhere) return true;
  if (mentionsWhere && mentionsClinicPlace) return true;
  if (normalized.includes('donde') && mentionsClinicPlace) return true;
  return false;
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
    const address = SEDE_LOCATION_ONLY_BY_ENV_KEY[selectedSede.envKey] || null;
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
  const details = SEDE_LOCATION_ONLY_BY_ENV_KEY[selectedSede.envKey] || null;
  const clinicHours = buildSedeClinicHoursReply(selectedSede);
  const addressParts = [details || `Sede ${selectedSede.displayName}.`];
  if (clinicHours) addressParts.push(clinicHours);
  if (selectedSede.envKey === 'CALENDLY_CORRIENTES') {
    addressParts.push(CORRIENTES_HOW_TO_ARRIVE_MESSAGE);
  }
  return addressParts.join(' ');
}

function messageAsksAboutStudyFasting(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return normalized.includes('ayunas') || normalized.includes('ayuno');
}

function messageAsksAboutStudyPreparation(rawText, priorState) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageLooksLikeStudyPreparationQuestion(rawText)) return true;
  if (priorState && stateHasRecentStudyPriceContext(priorState)) {
    const normalized = normalizeForMatch(rawText);
    const vagueStudyFollowUp =
      normalized.includes('algo especial') ||
      normalized.includes('preparacion') ||
      normalized.includes('preparación') ||
      messageAsksAboutStudyFasting(rawText) ||
      messageAsksAboutStudyMedicationPreparation(rawText) ||
      ((normalized.includes('debo llevar') || normalized.includes('debo traer')) &&
        !normalized.includes('estudios') &&
        !normalized.includes('informe') &&
        !normalized.includes('historia clinica') &&
        !normalized.includes('orden'));
    if (vagueStudyFollowUp) return true;
  }
  return false;
}

function messageLooksLikeStudyPreparationQuestion(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsStudyContext =
    messageMentionsSpirometryStudy(rawText) ||
    normalized.includes('estudio') ||
    normalized.includes('prick') ||
    normalized.includes('test de alerg') ||
    normalized.includes('parche') ||
    normalized.includes('patch');
  const asksPreparation =
    normalized.includes('preparacion') ||
    normalized.includes('preparación') ||
    normalized.includes('algo especial') ||
    normalized.includes('que tengo que hacer antes') ||
    normalized.includes('qué tengo que hacer antes') ||
    normalized.includes('que debo hacer antes') ||
    normalized.includes('qué debo hacer antes') ||
    normalized.includes('antes del estudio') ||
    normalized.includes('antes de hacerme') ||
    normalized.includes('antes de hacer') ||
    normalized.includes('antes de la espirometr') ||
    normalized.includes('tengo que ir en ayunas') ||
    messageAsksAboutStudyFasting(rawText) ||
    messageAsksAboutStudyMedicationPreparation(rawText) ||
    (normalized.includes('llevar') && normalized.includes('algo especial')) ||
    (normalized.includes('traer') && normalized.includes('algo especial')) ||
    (normalized.includes('llevar') &&
      (normalized.includes('hacerme el estudio') ||
        normalized.includes('hacer el estudio') ||
        normalized.includes('hacerme la espirometr') ||
        normalized.includes('realizarme el estudio') ||
        normalized.includes('realizarme la espirometr'))) ||
    (normalized.includes('necesito') &&
      normalized.includes('llevar') &&
      (normalized.includes('hacerme') || normalized.includes('realizarme')));
  if (!asksPreparation) return false;
  if (normalized.includes('algo especial')) return true;
  if (normalized.includes('preparacion') || normalized.includes('preparación')) return true;
  if (mentionsStudyContext || messageMentionsSpirometryStudy(rawText)) return true;
  if (
    messageAsksAboutStudyFasting(rawText) ||
    messageAsksAboutStudyMedicationPreparation(rawText) ||
    messageAsksAboutStudyDuration(rawText)
  ) {
    return true;
  }
  return false;
}

function buildStudyPreparationOpenAiContext(priorState, rawText) {
  const contextLines = [];
  const sedeFromState = resolveKnownSedeForConversationContext(priorState);
  if (sedeFromState) {
    contextLines.push(`Sede confirmada en conversación: ${sedeFromState.displayName}.`);
  }
  const studyTypeFromMessage = getStudyTypeFromText(rawText);
  const studyTypeFromState =
    priorState && typeof priorState === 'object' && typeof priorState.lastStudyType === 'string'
      ? priorState.lastStudyType.trim()
      : '';
  const studyType = studyTypeFromMessage || studyTypeFromState;
  if (studyType) {
    contextLines.push(`Estudio mencionado o en contexto: ${studyType}.`);
  }
  const healthInsuranceFromState =
    priorState && typeof priorState === 'object' && typeof priorState.healthInsuranceName === 'string'
      ? priorState.healthInsuranceName.trim()
      : priorState &&
          typeof priorState === 'object' &&
          typeof priorState.lastHealthInsuranceName === 'string'
        ? priorState.lastHealthInsuranceName.trim()
        : '';
  if (healthInsuranceFromState) {
    contextLines.push(`Obra social o prepaga en contexto: ${healthInsuranceFromState}.`);
  }
  return contextLines.join('\n');
}

function buildStudyPreparationReply(priorState, rawText) {
  if (messageMentionsSpirometryStudy(rawText) || priorStateIndicatesSpirometryStudy(priorState)) {
    const sedeFromState = resolveKnownSedeForConversationContext(priorState);
    if (sedeFromState) {
      return `${SPIROMETRY_PREPARATION_MESSAGE} Te esperamos en ${sedeFromState.displayName}.`;
    }
    return SPIROMETRY_PREPARATION_MESSAGE;
  }
  const normalized = normalizeForMatch(rawText);
  if (
    normalized.includes('prick') ||
    normalized.includes('test de alerg') ||
    priorStateIndicatesAllergyStudy(priorState)
  ) {
    return appendSedeContextIfKnown(
      'Para test de alergia: suspender antialérgicos 48 hs antes y corticoides 1 semana antes. No hace falta ir en ayunas.',
      priorState
    );
  }
  if (messageAsksAboutStudyFasting(rawText)) {
    return STUDY_FASTING_MESSAGE;
  }
  if (messageAsksAboutStudyMedicationPreparation(rawText)) {
    return STUDY_PREPARATION_MEDICATION_MESSAGE;
  }
  return STUDY_PREPARATION_MEDICATION_MESSAGE;
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
  const lastSede = resolveConfirmedSedeEntryForBookingFlow('', priorState);
  if (lastSede) return messageText;
  return `${messageText} ${buildAskSedeMessage()}`.trim();
}

function resolveAskSedePromptIntent(priorState, options = {}) {
  if (options.intent === 'booking' || options.intent === 'general') return options.intent;
  if (
    stateHasPendingBookingIntent(priorState) ||
    stateHasPendingBookingDetails(priorState) ||
    (priorState &&
      typeof priorState.lastPendingBookingRequestText === 'string' &&
      priorState.lastPendingBookingRequestText.trim().length > 0)
  ) {
    return 'booking';
  }
  return 'general';
}

async function sendAskSedeTwoStep(toPhoneId, profileDisplayName, priorState, prefaceText = null, options = {}) {
  const askSedePrompt = buildConsolidatedAskSedePrompt(prefaceText, {
    intent: resolveAskSedePromptIntent(priorState, options),
  });
  const firstWrapped = buildAutoReplyWithGreetingIfNeeded(askSedePrompt, profileDisplayName, priorState);
  const afterFirstState = mergeConversationStatePreservingGreeting(
    priorState,
    {
      state: 'awaiting_sede_selection',
      awaitingSedeSelectionAtMs: Date.now(),
      lastBotAskedSedeCityAtMs: Date.now(),
    },
    {
      ...buildPreservedIntentSessionPatch(priorState),
      ...(firstWrapped.nextStatePatch || {}),
      ...buildLastBotReplyStatePatch(firstWrapped.messageText),
      ...buildClearedStaleSedeForFreshBookingPatch(),
      lastSeenAtMs: Date.now(),
      lastBotReplyAtMs: Date.now(),
      ...(stateHasPendingBookingIntent(priorState) ? buildPendingBookingIntentStatePatch() : {}),
      ...(priorState && typeof priorState.lastPendingBookingRequestText === 'string'
        ? {
            lastPendingBookingRequestText: priorState.lastPendingBookingRequestText,
            ...(priorState.pendingBookingWeekday ? { pendingBookingWeekday: priorState.pendingBookingWeekday } : {}),
            ...(priorState.pendingBookingIncludesTime ? { pendingBookingIncludesTime: true } : {}),
          }
        : {}),
      ...(stateHasPendingConsultationPriceIntent(priorState)
        ? buildPendingConsultationPriceIntentStatePatch()
        : {}),
      ...(stateHasPendingPrivatePriceIntent(priorState) ? buildPendingPrivatePriceIntentStatePatch() : {}),
    }
  );
  await setConversationState(toPhoneId, afterFirstState);
  await sendWhatsAppText(toPhoneId, firstWrapped.messageText);
}

async function sendSedeSelectionHelpMessage(toPhoneId, profileDisplayName, priorState) {
  const helpText = `Escribí solo el número de la sede (1, 2, 3 o 4). ${buildSedeNumberedOptionsSuffix()}`;
  const wrapped = buildAutoReplyWithGreetingIfNeeded(helpText, profileDisplayName, priorState);
  await setConversationState(toPhoneId, {
    ...(priorState || {}),
    ...(wrapped.nextStatePatch || {}),
    lastSeenAtMs: Date.now(),
    lastBotReplyAtMs: Date.now(),
  });
  await sendWhatsAppText(toPhoneId, wrapped.messageText);
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

function messageAsksForPhoneCall(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('me pueden llamar') ||
    normalized.includes('me podrian llamar') ||
    normalized.includes('me podrían llamar') ||
    normalized.includes('pueden llamarme') ||
    normalized.includes('podrian llamarme') ||
    normalized.includes('podrían llamarme') ||
    normalized.includes('llamenme') ||
    normalized.includes('llámenme') ||
    normalized.includes('llamame') ||
    normalized.includes('llamame por telefono') ||
    normalized.includes('llamame por teléfono') ||
    normalized.includes('llamar por telefono') ||
    normalized.includes('llamar por teléfono')
  );
}

function buildPhoneCallRequestReply() {
  return 'Te recomiendo que me envíes tu consulta por acá. Así puedo ayudarte mejor, ya que no recibimos llamadas.';
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
  const sedeFromState = resolveKnownSedeForConversationContext(priorState);
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
  const sedeFromState = resolveKnownSedeForConversationContext(priorState);
  if (sedeFromState) {
    return `${base} Para orientarte bien según el caso, lo ideal es una consulta de evaluación en ${sedeFromState.displayName}.`;
  }
  return `${base} Para orientarte bien según el caso, lo ideal es una consulta de evaluación. ${buildAskSedeMessage()}`;
}

function getStudyTypeFromText(rawText) {
  if (messageMentionsSpirometryStudy(rawText)) return 'espirometría';
  const normalized = normalizeForMatch(rawText);
  if (normalized.includes('test de alerg') || normalized.includes('prick')) return 'test de alergia';
  if (normalized.includes('test del parche') || normalized.includes('patch') || normalized.includes('parche')) {
    return 'test del parche';
  }
  return null;
}

function buildStudyTypeWithArticle(studyType) {
  if (!studyType || typeof studyType !== 'string') return 'el estudio';
  const normalized = normalizeForMatch(studyType);
  if (normalized.includes('espirometr')) return 'la espirometría';
  if (normalized.includes('alerg') || normalized.includes('prick')) return 'el test de alergia';
  if (normalized.includes('parche')) return 'el test del parche';
  return `el ${studyType}`;
}

function messageAsksWhetherDoctorPerformsStudy(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageLooksLikeAnyPriceQuestion(rawText) || messageAsksAboutStudyPrice(rawText)) return false;
  if (messageAsksAboutStudyPreparation(rawText)) return false;
  if (messageAsksWhatStudiesToBring(rawText) || messageAsksAboutMedicalHistoryToBring(rawText)) {
    return false;
  }
  const normalized = normalizeForMatch(rawText);
  const mentionsStudy =
    messageMentionsSpirometryStudy(rawText) ||
    normalized.includes('test de alerg') ||
    normalized.includes('prick') ||
    normalized.includes('test del parche') ||
    normalized.includes('parche');
  if (!mentionsStudy) return false;
  if (messageAsksWhatStudiesDoctorDoes(rawText)) return true;
  return (
    /\b(hacen|hace|realizan|realiza|pueden hacer|se hace)\b/.test(normalized) ||
    normalized.includes('hacen la') ||
    normalized.includes('hace la') ||
    normalized.includes('realizan la') ||
    normalized.includes('realiza la')
  );
}

function buildStudyAvailabilityPrimaryReply(studyType, priorState, options = {}) {
  const sedeFromState = options.sedeEntry || resolveKnownSedeForConversationContext(priorState);
  const studyWithArticle = buildStudyTypeWithArticle(studyType);
  if (sedeFromState) {
    return `Sí, el Dr. realiza ${studyWithArticle} en ${sedeFromState.displayName}.`;
  }
  return `Sí, el Dr. realiza ${studyWithArticle}.`;
}

function buildStudyCoverageIncludedAdjective(studyType) {
  return normalizeForMatch(studyType).includes('espirometr') ? 'incluida' : 'incluido';
}

function buildIncludedStudyCoverageFollowUpReply(studyType, healthInsuranceName, sedeEntry) {
  if (!healthInsuranceName || !sedeEntry) return null;
  if (!INSURANCE_NAMES_WITH_INCLUDED_STUDY_IN_CONSULTATION.includes(healthInsuranceName)) return null;
  const studyWithArticle = buildStudyTypeWithArticle(studyType);
  const includedAdjective = buildStudyCoverageIncludedAdjective(studyType);
  return `Con ${healthInsuranceName} en ${sedeEntry.displayName}, sin plus: ${studyWithArticle} queda ${includedAdjective} en el valor de la consulta.`;
}

function normalizeStudiesReplyPayload(studiesReply) {
  if (studiesReply && typeof studiesReply === 'object' && typeof studiesReply.primaryReply === 'string') {
    const primaryReply = studiesReply.primaryReply.trim();
    if (!primaryReply) return null;
    const followUpReply =
      typeof studiesReply.followUpReply === 'string' && studiesReply.followUpReply.trim().length > 0
        ? studiesReply.followUpReply.trim()
        : null;
    const thirdReply =
      typeof studiesReply.thirdReply === 'string' && studiesReply.thirdReply.trim().length > 0
        ? studiesReply.thirdReply.trim()
        : null;
    return { primaryReply, followUpReply, thirdReply };
  }
  if (typeof studiesReply === 'string' && studiesReply.trim().length > 0) {
    return { primaryReply: studiesReply.trim(), followUpReply: null };
  }
  return null;
}

function flattenStudiesReplyPayload(studiesReply) {
  const payload = normalizeStudiesReplyPayload(studiesReply);
  if (!payload) return null;
  const parts = [payload.primaryReply];
  if (payload.followUpReply) parts.push(payload.followUpReply);
  if (payload.thirdReply) parts.push(payload.thirdReply);
  return parts.join(' ');
}

async function buildStudyAvailabilitySplitReply(studyType, priorState, rawText, context = {}) {
  const knownHealthInsuranceName = resolveKnownHealthInsuranceNameForStudyPricing(priorState, rawText);
  const sedeForReply = context.lastSede || resolveKnownSedeForConversationContext(priorState);
  const primaryReply = buildStudyAvailabilityPrimaryReply(studyType, priorState, { sedeEntry: sedeForReply });
  if (!knownHealthInsuranceName && !sedeForReply) {
    return {
      primaryReply,
      followUpReply: `Contame qué obra social/prepaga tenés y desde qué ciudad te consultás. ${buildAskSedeMessage()}`,
    };
  }
  if (!knownHealthInsuranceName) {
    return { primaryReply, followUpReply: '¿Qué obra social/prepaga tenés?' };
  }
  if (!sedeForReply) {
    return {
      primaryReply,
      followUpReply: `¿Desde qué ciudad te consultás? ${buildAskSedeMessage()}`,
    };
  }
  const includedFollowUp = buildIncludedStudyCoverageFollowUpReply(
    studyType,
    knownHealthInsuranceName,
    sedeForReply
  );
  if (includedFollowUp) {
    return { primaryReply, followUpReply: includedFollowUp };
  }
  return {
    primaryReply,
    followUpReply: '¿Querés que te cuente el valor con tu cobertura o preferís agendar?',
  };
}

async function deliverStudiesInformationReply(
  from,
  studiesReply,
  priorState,
  profileDisplayName,
  extraStatePatch = {},
  deliveryOptions = {}
) {
  const payload = normalizeStudiesReplyPayload(studiesReply);
  if (!payload) return false;
  const finalizeOptions = {
    priorState,
    profileDisplayName,
    userMessage: deliveryOptions.userMessage || '',
    replyContext: deliveryOptions.replyContext || 'studies_info',
    suppressBookingLinkOffer: true,
    skipHumanization: true,
    conversationContext: buildIntentRoutingOpenAiContext(priorState),
  };
  const finalizedPrimary = await finalizePatientReplyText(payload.primaryReply, finalizeOptions);
  const wrappedPrimary = buildAutoReplyWithGreetingIfNeeded(finalizedPrimary, profileDisplayName, priorState);
  let finalizedFollowUp = null;
  if (payload.followUpReply) {
    finalizedFollowUp = await finalizePatientReplyText(payload.followUpReply, {
      ...finalizeOptions,
      priorState: mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
        lastBotReplyText: wrappedPrimary.messageText,
      }),
    });
  }
  let combinedLastReply = wrappedPrimary.messageText;
  if (finalizedFollowUp) {
    combinedLastReply = `${combinedLastReply} ${finalizedFollowUp}`;
  }
  let nextState = mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
    ...extraStatePatch,
    ...(wrappedPrimary.nextStatePatch || {}),
    ...buildLastBotReplyStatePatch(combinedLastReply),
  });
  await setConversationState(from, nextState);
  await sendWhatsAppText(from, wrappedPrimary.messageText);
  if (finalizedFollowUp) {
    const wrappedFollowUp = buildAutoReplyWithGreetingIfNeeded(finalizedFollowUp, profileDisplayName, nextState);
    combinedLastReply = `${combinedLastReply} ${wrappedFollowUp.messageText}`;
    nextState = mergeConversationStatePreservingGreeting(nextState, {}, {
      ...(wrappedFollowUp.nextStatePatch || {}),
      ...buildLastBotReplyStatePatch(combinedLastReply),
    });
    await setConversationState(from, nextState);
    await sendWhatsAppText(from, wrappedFollowUp.messageText, { skipDelay: true });
  }
  if (payload.thirdReply) {
    const finalizedThird = await finalizePatientReplyText(payload.thirdReply, {
      ...finalizeOptions,
      priorState: nextState,
    });
    const wrappedThird = buildAutoReplyWithGreetingIfNeeded(finalizedThird, profileDisplayName, nextState);
    combinedLastReply = `${combinedLastReply} ${wrappedThird.messageText}`;
    const awaitingLinkSede = deliveryOptions.awaitingLinkConfirmationSede || null;
    const thirdStatePatch = {
      ...(wrappedThird.nextStatePatch || {}),
      ...buildLastBotReplyStatePatch(combinedLastReply),
    };
    if (awaitingLinkSede) {
      Object.assign(
        thirdStatePatch,
        buildAwaitingLinkConfirmationState(awaitingLinkSede, 'after_spirometry_only_inquiry')
      );
    }
    nextState = mergeConversationStatePreservingGreeting(nextState, {}, thirdStatePatch);
    await setConversationState(from, nextState);
    await sendWhatsAppText(from, wrappedThird.messageText, { skipDelay: true });
  }
  return true;
}

function messageAsksAboutStandaloneSpirometryWithoutConsultation(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (!messageMentionsSpirometryStudy(rawText)) return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('sin consulta') ||
    normalized.includes('no necesito consulta') ||
    normalized.includes('no quiero consulta') ||
    normalized.includes('no requiero consulta') ||
    normalized.includes('solo espirometr') ||
    normalized.includes('solo la espirometr') ||
    normalized.includes('espirometria sola') ||
    normalized.includes('espirometría sola') ||
    normalized.includes('unicamente una espirometr') ||
    normalized.includes('unicamente espirometr') ||
    normalized.includes('solamente espirometr') ||
    normalized.includes('solamente la espirometr') ||
    (normalized.includes('unicamente') && normalized.includes('espirometr')) ||
    (normalized.includes('ya tengo diagnostico') && normalized.includes('espirometr'))
  );
}

function messageLooksLikeSpirometryOnlyInquiry(rawText) {
  if (!messageAsksAboutStandaloneSpirometryWithoutConsultation(rawText)) return false;
  const normalized = normalizeForMatch(rawText);
  return (
    messageLooksLikeAnyPriceQuestion(rawText) ||
    messageLooksLikeRealtimeAvailabilityQuestion(rawText) ||
    messageLooksLikeScheduleAvailabilityQuestion(rawText) ||
    normalized.includes('particular')
  );
}

function buildSpirometryOnlyInquiryPriceAndLinkReply() {
  const formattedAmount = formatArsAmount(STANDALONE_SPIROMETRY_PRICE_ARS);
  return `Si querés solo espirometría sin consulta, sale $${formattedAmount}. ${buildMicroCommitmentMessage()}`;
}

async function buildSpirometryOnlyInquirySplitReply(priorState, rawText) {
  const patientContext = await resolvePatientContextFromMessage(rawText, priorState);
  const lastSede = patientContext.sedeEntry || resolveKnownSedeForConversationContext(priorState);
  const primaryReply = buildStudyAvailabilityPrimaryReply('espirometría', priorState, { sedeEntry: lastSede });
  return { primaryReply, followUpReply: buildSpirometryOnlyInquiryPriceAndLinkReply() };
}

async function sendSpirometryOnlyInquiryReply(from, bodyText, priorState, profileDisplayName) {
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const lastSede = patientContext.sedeEntry || resolveLastSedeEntryFromState(priorState);
  const primaryReply = buildStudyAvailabilityPrimaryReply('espirometría', priorState, { sedeEntry: lastSede });
  const followUpReply = buildSpirometryOnlyInquiryPriceAndLinkReply();
  const wrappedPrimary = buildAutoReplyWithGreetingIfNeeded(primaryReply, profileDisplayName, priorState);
  let nextState = mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
    lastStudyType: 'espirometría',
    lastStudyPriceContextAtMs: Date.now(),
    ...(patientContext.statePatch || {}),
    ...(lastSede ? buildLastSedeStatePatch(lastSede) || {} : {}),
    ...(wrappedPrimary.nextStatePatch || {}),
    ...buildLastBotReplyStatePatch(wrappedPrimary.messageText),
  });
  await setConversationState(from, nextState);
  await sendWhatsAppText(from, wrappedPrimary.messageText);
  const wrappedFollowUp = buildAutoReplyWithGreetingIfNeeded(followUpReply, profileDisplayName, nextState);
  const followUpStatePatch = {
    ...(wrappedFollowUp.nextStatePatch || {}),
    ...buildLastBotReplyStatePatch(`${wrappedPrimary.messageText} ${wrappedFollowUp.messageText}`),
  };
  if (lastSede) {
    Object.assign(
      followUpStatePatch,
      buildAwaitingLinkConfirmationState(lastSede, 'after_spirometry_only_inquiry')
    );
  }
  nextState = mergeConversationStatePreservingGreeting(nextState, {}, followUpStatePatch);
  await setConversationState(from, nextState);
  await sendWhatsAppText(from, wrappedFollowUp.messageText, { skipDelay: true });
  return true;
}

async function tryHandleSpirometryOnlyInquiry(from, bodyText, priorState, profileDisplayName) {
  if (!messageLooksLikeSpirometryOnlyInquiry(bodyText)) return false;
  return sendSpirometryOnlyInquiryReply(from, bodyText, priorState, profileDisplayName);
}

function messageAsksAboutAfternoonAvailability(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('por la tarde') ||
    normalized.includes('turnos por la tarde') ||
    normalized.includes('turno por la tarde') ||
    normalized.includes('horarios a la tarde') ||
    normalized.includes('tienen turnos por la tarde') ||
    normalized.includes('hay turnos por la tarde')
  );
}

function messageAsksConsultationCostInText(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('cuesta la consulta') ||
    normalized.includes('cuanto sale la consulta') ||
    normalized.includes('cuanto cuesta la consulta') ||
    normalized.includes('precio de la consulta') ||
    normalized.includes('valor de la consulta') ||
    (normalized.includes('consulta') && messageLooksLikeAnyPriceQuestion(rawText))
  );
}

function messageLooksLikeRichPatientIntakeInquiry(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const questionCount = (String(rawText).match(/\?/g) || []).length;
  if (questionCount < 3) return false;
  const normalized = normalizeForMatch(rawText);
  const topicCount = [
    messageAsksAboutConditionTreatment(rawText) ||
      normalized.includes('rinitis') ||
      normalized.includes('asma') ||
      messageDescribesChronicOrQualifiedBreathingSymptom(rawText),
    messageLooksLikeAnyPriceQuestion(rawText),
    messageAsksAboutPaymentMethods(rawText),
    messageAsksAboutAfternoonAvailability(rawText) || messageLooksLikeRealtimeAvailabilityQuestion(rawText),
    messageMatchesStudiesTopic(rawText) || Boolean(getStudyTypeFromText(rawText)),
  ].filter(Boolean).length;
  return topicCount >= 3;
}

async function deliverSequentialPatientTextMessages(
  from,
  messageTexts,
  priorState,
  profileDisplayName,
  extraStatePatch = {}
) {
  const validMessages = messageTexts.filter((text) => typeof text === 'string' && text.trim().length > 0);
  if (validMessages.length === 0) return false;
  let nextState = mergeConversationStatePreservingGreeting(priorState, priorState || {}, extraStatePatch);
  let combinedLastReply = '';
  for (let index = 0; index < validMessages.length; index += 1) {
    const wrapped = buildAutoReplyWithGreetingIfNeeded(validMessages[index], profileDisplayName, nextState);
    combinedLastReply = combinedLastReply
      ? `${combinedLastReply} ${wrapped.messageText}`
      : wrapped.messageText;
    nextState = mergeConversationStatePreservingGreeting(nextState, {}, {
      ...(wrapped.nextStatePatch || {}),
      ...buildLastBotReplyStatePatch(combinedLastReply),
    });
    await setConversationState(from, nextState);
    await sendWhatsAppText(from, wrapped.messageText, { skipDelay: index > 0 });
  }
  return true;
}

async function buildRichPatientIntakeReplies(priorState, rawText, lastSede, healthInsuranceName) {
  const enrichedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    buildLastSedeStatePatch(lastSede) || {}
  );
  const replies = [];
  const normalized = normalizeForMatch(rawText);
  if (
    messageAsksAboutConditionTreatment(rawText) ||
    normalized.includes('rinitis') ||
    normalized.includes('asma') ||
    normalized.includes('alerg')
  ) {
    replies.push(buildConditionTreatmentReply(enrichedState, rawText));
  }
  if (healthInsuranceName) {
    replies.push(await buildHealthInsuranceCoverageLineForSede(lastSede, healthInsuranceName));
  }
  if (messageAsksConsultationCostInText(rawText)) {
    replies.push(await buildPrivatePriceReply(lastSede));
  }
  const studyType = getStudyTypeFromText(rawText);
  if (studyType) {
    const plusRuleInSede = healthInsuranceName
      ? await lookupPlusRule(lastSede.displayName, healthInsuranceName)
      : null;
    const studySede =
      plusRuleInSede && plusRuleInSede.isAccepted
        ? lastSede
        : (await findPrimaryAcceptedCityEntryForHealthInsurance(
            healthInsuranceName,
            lastSede.displayName
          )) || lastSede;
    if (healthInsuranceName) {
      replies.push(await buildStudyPriceLineForKnownCoverage(studyType, studySede, healthInsuranceName));
    } else {
      const formattedAmount = formatArsAmount(STUDY_PRICE_WITH_CONSULTATION_ARS);
      replies.push(`El ${studyType} en consulta particular sería $${formattedAmount} del estudio.`);
    }
  }
  if (messageAsksAboutPaymentMethods(rawText)) {
    replies.push(PAYMENT_METHODS_MESSAGE);
  }
  if (messageAsksAboutAfternoonAvailability(rawText) || messageLooksLikeRealtimeAvailabilityQuestion(rawText)) {
    replies.push(
      `Los turnos por la tarde los ves en la agenda al elegir día y horario. ${buildMicroCommitmentMessage()}`
    );
  }
  return replies;
}

function messageAsksAboutClinicHours(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('horarios') ||
    normalized.includes('horario de atencion') ||
    normalized.includes('horario de la clinica') ||
    normalized.includes('horario de la clínica') ||
    normalized.includes('en que horario') ||
    normalized.includes('a que hora') ||
    normalized.includes('que horario')
  );
}

function messageLooksLikeClinicLocationAndHoursInquiry(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const asksLocation =
    messageAsksAboutSedeAddressOrHowToArrive(rawText) || messageAsksForMapsLocation(rawText);
  const asksHours =
    messageAsksAboutClinicHours(rawText) || messageLooksLikeScheduleAvailabilityQuestion(rawText);
  return asksLocation && asksHours;
}

async function tryHandleClinicLocationAndHoursInquiry(from, bodyText, priorState, profileDisplayName) {
  if (!messageLooksLikeClinicLocationAndHoursInquiry(bodyText)) return false;
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState, { profileDisplayName });
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const lastSede =
    patientContext.sedeEntry || findSedeFromText(bodyText) || resolveLastSedeEntryFromState(mergedState);
  if (!lastSede) {
    const askSedeText = `Para pasarte dirección y horarios, ¿desde qué ciudad consultás? ${ACTIVE_SEDE_OPTIONS_MESSAGE}`;
    const wrapped = buildAutoReplyWithGreetingIfNeeded(askSedeText, profileDisplayName, mergedState);
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(mergedState, buildAwaitingSedeSelectionStatePatch(), {
        ...(wrapped.nextStatePatch || {}),
        ...buildLastBotReplyStatePatch(wrapped.messageText),
      })
    );
    await sendWhatsAppText(from, wrapped.messageText);
    return true;
  }
  const reply = messageAsksForMapsLocation(bodyText)
    ? buildSedeMapsLocationReply(mergedState, lastSede)
    : buildSedeAddressReply(mergedState, lastSede);
  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, mergedState);
  await setConversationState(
    from,
    mergeConversationStatePreservingGreeting(mergedState, {}, {
      ...(wrapped.nextStatePatch || {}),
      ...(buildLastSedeStatePatch(lastSede) || {}),
      ...buildLastBotReplyStatePatch(wrapped.messageText),
    })
  );
  await sendWhatsAppText(from, wrapped.messageText);
  return true;
}

function messageAsksAboutHealthInsuranceCoverage(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('cobertura') ||
    messageLooksLikeHealthInsurancePlusQuestion(rawText) ||
    messageStatesHealthInsuranceMembership(rawText) ||
    Boolean(tryExtractHealthInsuranceName(rawText))
  );
}

function messageLooksLikeClinicInformationBundleInquiry(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const signalCount = [
    messageAsksAboutSedeAddressOrHowToArrive(rawText) || messageAsksForMapsLocation(rawText),
    messageAsksAboutClinicHours(rawText),
    messageLooksLikePrivatePriceQuestion(rawText) || normalized.includes('precio particular'),
    messageAsksAboutPaymentMethods(rawText),
    messageAsksAboutHealthInsuranceCoverage(rawText),
  ].filter(Boolean).length;
  return signalCount >= 3;
}

async function buildClinicInformationBundleReplies(priorState, rawText, lastSede, healthInsuranceName) {
  const enrichedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    lastSede ? buildLastSedeStatePatch(lastSede) || {} : {}
  );
  const normalized = normalizeForMatch(rawText);
  const replies = [];
  if (messageAsksAboutHealthInsuranceCoverage(rawText)) {
    if (healthInsuranceName && lastSede) {
      replies.push(await buildHealthInsuranceCoverageLineForSede(lastSede, healthInsuranceName));
    } else if (healthInsuranceName) {
      replies.push(
        `¿Desde qué ciudad consultás? ${buildAskSedeMessage()} Así te confirmo la cobertura de ${healthInsuranceName}.`
      );
    } else {
      replies.push('¿Qué obra social/prepaga tenés? Te digo si la aceptamos.');
    }
  }
  if (messageLooksLikePrivatePriceQuestion(rawText) || normalized.includes('precio particular')) {
    if (lastSede) {
      replies.push(await buildPrivatePriceReply(lastSede));
    }
  }
  if (messageAsksAboutPaymentMethods(rawText)) {
    replies.push(PAYMENT_METHODS_MESSAGE);
  }
  if (lastSede && messageAsksAboutSedeAddressOrHowToArrive(rawText)) {
    replies.push(buildSedeAddressReply(enrichedState, lastSede));
  } else if (lastSede && messageAsksAboutClinicHours(rawText)) {
    const clinicHours = buildSedeClinicHoursReply(lastSede);
    if (clinicHours) replies.push(clinicHours);
  }
  if (lastSede && messageAsksForMapsLocation(rawText)) {
    const mapsUrl = SEDE_MAPS_URL_BY_ENV_KEY[lastSede.envKey] || null;
    if (mapsUrl) {
      replies.push(`Ubicación en Google Maps:\n${mapsUrl}`);
    }
  }
  return replies;
}

async function tryHandleClinicInformationBundleInquiry(from, bodyText, priorState, profileDisplayName) {
  if (!messageLooksLikeClinicInformationBundleInquiry(bodyText)) return false;
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const lastSede = patientContext.sedeEntry || resolveLastSedeEntryFromState(mergedState);
  const healthInsuranceName = await resolveHealthInsuranceNameFromMessage(bodyText, mergedState, {
    profileDisplayName,
  });
  const needsSedeForReply =
    (messageAsksAboutHealthInsuranceCoverage(bodyText) && healthInsuranceName) ||
    messageLooksLikePrivatePriceQuestion(bodyText) ||
    normalizeForMatch(bodyText).includes('precio particular') ||
    messageAsksAboutSedeAddressOrHowToArrive(bodyText) ||
    messageAsksForMapsLocation(bodyText) ||
    messageAsksAboutClinicHours(bodyText);
  if (!lastSede && needsSedeForReply) {
    const askSedeText = healthInsuranceName
      ? `Para pasarte dirección, precios y cobertura de ${healthInsuranceName}, ¿desde qué ciudad consultás? ${ACTIVE_SEDE_OPTIONS_MESSAGE}`
      : `Para pasarte la info, ¿desde qué ciudad consultás? ${ACTIVE_SEDE_OPTIONS_MESSAGE}`;
    const wrapped = buildAutoReplyWithGreetingIfNeeded(askSedeText, profileDisplayName, mergedState);
    await setConversationState(
      from,
      mergeConversationStatePreservingGreeting(mergedState, { state: 'awaiting_sede_selection' }, {
        ...(wrapped.nextStatePatch || {}),
        ...(healthInsuranceName
          ? { healthInsuranceName, lastHealthInsuranceName: healthInsuranceName }
          : {}),
        ...buildLastBotReplyStatePatch(wrapped.messageText),
      })
    );
    await sendWhatsAppText(from, wrapped.messageText);
    return true;
  }
  const replies = await buildClinicInformationBundleReplies(
    mergedState,
    bodyText,
    lastSede,
    healthInsuranceName
  );
  if (replies.length === 0) return false;
  const statePatch = {
    ...(patientContext.statePatch || {}),
    ...(lastSede ? buildLastSedeStatePatch(lastSede) || {} : {}),
    ...(healthInsuranceName
      ? {
          healthInsuranceName,
          lastHealthInsuranceName: healthInsuranceName,
          ...buildLastHealthInsuranceDiscussionStatePatch(),
        }
      : {}),
    ...(lastSede
      ? buildAwaitingLinkConfirmationState(lastSede, 'after_clinic_information_bundle', {
          healthInsuranceName: healthInsuranceName || undefined,
        })
      : {}),
  };
  return deliverSequentialPatientTextMessages(from, replies, priorState, profileDisplayName, statePatch);
}

function messageAsksApproximateConsultationCost(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('cuanto gast') ||
    normalized.includes('cuanto nos sal') ||
    normalized.includes('cuanto saldria') ||
    normalized.includes('aproximad') ||
    normalized.includes('mas o menos cuanto') ||
    normalized.includes('idea de cuanto') ||
    normalized.includes('valor aprox')
  );
}

function messageAsksCompleteOrTotalCost(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  if (
    normalized.includes('total') ||
    normalized.includes('valor final') ||
    normalized.includes('precio final') ||
    normalized.includes('total final') ||
    normalized.includes('cuanto me sale todo') ||
    normalized.includes('cuanto sale todo') ||
    normalized.includes('cuanto me saldria todo') ||
    normalized.includes('cuanto saldria todo') ||
    normalized.includes('cuanto es todo') ||
    normalized.includes('precio de todo') ||
    normalized.includes('costo de todo') ||
    normalized.includes('valor de todo') ||
    normalized.includes('cuanto sale en total') ||
    normalized.includes('cuanto me sale en total') ||
    normalized.includes('cuanto seria mi total') ||
    normalized.includes('cuanto sería mi total') ||
    normalized.includes('cuanto seria el total') ||
    normalized.includes('cuanto sería el total') ||
    normalized.includes('cuanto me sale en total')
  ) {
    return true;
  }
  return (
    normalized.includes('todo') &&
    (normalized.includes('cuanto') ||
      normalized.includes('precio') ||
      normalized.includes('costo') ||
      normalized.includes('valor'))
  );
}

function messageLooksLikeCompleteCostTotalInquiry(rawText, priorState = null) {
  if (!messageAsksCompleteOrTotalCost(rawText)) return false;
  const hasStudyContext =
    Boolean(getStudyTypeFromText(rawText)) ||
    messageMatchesStudiesTopic(rawText) ||
    messageAsksAboutStudyPrice(rawText) ||
    (priorState &&
      typeof priorState === 'object' &&
      typeof priorState.lastStudyType === 'string' &&
      priorState.lastStudyType.trim().length > 0);
  const hasPriceAsk =
    messageLooksLikeAnyPriceQuestion(rawText) || messageAsksApproximateConsultationCost(rawText);
  return hasStudyContext && hasPriceAsk;
}

function extractChildAgeYearsFromMessage(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const normalized = normalizeForMatch(rawText);
  const childAgeMatch = normalized.match(
    /(?:hijo|hija|nene|nena|menor)[^0-9]{0,24}(\d{1,2})\s*anos/
  );
  if (!childAgeMatch || !childAgeMatch[1]) return null;
  const childAgeYears = Number(childAgeMatch[1]);
  return Number.isFinite(childAgeYears) ? childAgeYears : null;
}

function extractFamilyConditionLabels(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const normalized = normalizeForMatch(rawText);
  const conditionLabels = [];
  if (normalized.includes('asma')) conditionLabels.push('asma');
  if (normalized.includes('dermatitis') || normalized.includes('eczema')) conditionLabels.push('dermatitis');
  if (normalized.includes('rinitis')) conditionLabels.push('rinitis');
  if (normalized.includes('alerg')) conditionLabels.push('alergias');
  return conditionLabels;
}

function messageLooksLikeFamilyConsultationCostEstimateInquiry(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const familyContext =
    normalized.includes('ambos') ||
    normalized.includes('los dos') ||
    messageMentionsChildPatientContext(rawText);
  if (!familyContext) return false;
  return (
    messageAsksApproximateConsultationCost(rawText) ||
    (messageLooksLikeAnyPriceQuestion(rawText) &&
      (normalized.includes('consultar') || normalized.includes('consulta')))
  );
}

async function buildFamilyConsultationCostEstimateReplies(
  priorState,
  rawText,
  lastSede,
  healthInsuranceName
) {
  const normalized = normalizeForMatch(rawText);
  const childAgeYears = extractChildAgeYearsFromMessage(rawText);
  const conditionLabels = extractFamilyConditionLabels(rawText);
  const mentionsBoth =
    normalized.includes('ambos') ||
    normalized.includes('los dos') ||
    messageMentionsChildPatientContext(rawText);
  const mentionsStudies = normalized.includes('estudios') || normalized.includes('estudio');
  const privatePriceArs = await lookupPrivatePrice(lastSede.displayName);
  const privatePriceFormatted = formatArsAmount(privatePriceArs);
  const studyAmountFormatted = formatArsAmount(STUDY_PRICE_WITH_CONSULTATION_ARS);
  const replies = [];
  replies.push('Qué bueno que consulten antes, así van con una idea más clara de los valores 😊');
  let clinicalLine = 'Sí, el Dr. atiende';
  if (conditionLabels.length > 0) {
    clinicalLine += ` ${conditionLabels.join(' y ')}`;
  } else {
    clinicalLine += ' este tipo de consultas';
  }
  clinicalLine += ' en adultos y en niños.';
  if (mentionsBoth) {
    const childDescription = childAgeYears
      ? `tu hijo de ${childAgeYears} años`
      : 'tu hijo/a';
    clinicalLine += ` Para consultar los dos en ${lastSede.displayName} (${childDescription} y vos), conviene una evaluación por persona.`;
  } else {
    clinicalLine += ` Para consultar en ${lastSede.displayName}, lo ideal es una evaluación en consulta.`;
  }
  replies.push(clinicalLine);
  if (healthInsuranceName) {
    replies.push(await buildHealthInsuranceCoverageLineForSede(lastSede, healthInsuranceName));
  }
  if (Number.isFinite(privatePriceArs) && privatePriceFormatted) {
    let costLine = `Como referencia en ${lastSede.displayName}: la consulta particular sale $${privatePriceFormatted} por persona`;
    if (mentionsBoth) {
      const twoConsultationsTotal = privatePriceArs * 2;
      const twoConsultationsFormatted = formatArsAmount(twoConsultationsTotal);
      costLine += ` — para ustedes dos serían unas $${twoConsultationsFormatted} en total por las consultas`;
    }
    costLine += '.';
    if (mentionsStudies) {
      costLine += ` Si el Dr. indica estudios (espirometría, test de alergia, etc.), suelen sumar $${studyAmountFormatted} del estudio cada uno; no siempre hace falta en la primera visita y depende de cada caso.`;
    }
    if (healthInsuranceName) {
      const plusRule = await lookupPlusRule(lastSede.displayName, healthInsuranceName);
      if (plusRule && plusRule.isAccepted && plusRule.hasPlus && plusRule.plusAmountArs) {
        const plusFormatted = formatArsAmount(plusRule.plusAmountArs);
        const twoPlusTotalFormatted = formatArsAmount(plusRule.plusAmountArs * (mentionsBoth ? 2 : 1));
        costLine += ` Con ${healthInsuranceName}, el plus es $${plusFormatted} por consulta`;
        if (mentionsBoth) {
          costLine += ` (unas $${twoPlusTotalFormatted} si consultan los dos)`;
        }
        costLine += '.';
      } else {
        const alternateCityEntry = await findPrimaryAcceptedCityEntryForHealthInsurance(
          healthInsuranceName,
          lastSede.displayName
        );
        if (alternateCityEntry) {
          const alternatePlusRule = await lookupPlusRule(
            alternateCityEntry.displayName,
            healthInsuranceName
          );
          if (
            alternatePlusRule &&
            alternatePlusRule.isAccepted &&
            alternatePlusRule.hasPlus &&
            alternatePlusRule.plusAmountArs
          ) {
            const plusFormatted = formatArsAmount(alternatePlusRule.plusAmountArs);
            const twoPlusTotalFormatted = formatArsAmount(
              alternatePlusRule.plusAmountArs * (mentionsBoth ? 2 : 1)
            );
            costLine += ` Con ${healthInsuranceName} en ${alternateCityEntry.displayName}, el plus es $${plusFormatted} por consulta`;
            if (mentionsBoth) {
              costLine += ` (unas $${twoPlusTotalFormatted} si consultan los dos)`;
            }
            costLine += '.';
          }
        }
      }
    }
    costLine += ' El total exacto lo define el Dr. según qué estudios pida en cada consulta.';
    replies.push(costLine);
  }
  replies.push(buildMicroCommitmentMessage());
  return replies;
}

async function tryHandleFamilyConsultationCostEstimateInquiry(
  from,
  bodyText,
  priorState,
  profileDisplayName
) {
  if (!messageLooksLikeFamilyConsultationCostEstimateInquiry(bodyText)) return false;
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const lastSede = patientContext.sedeEntry || resolveLastSedeEntryFromState(mergedState);
  if (!lastSede) return false;
  const healthInsuranceName = await resolveHealthInsuranceNameFromMessage(bodyText, mergedState, {
    profileDisplayName,
  });
  const replies = await buildFamilyConsultationCostEstimateReplies(
    mergedState,
    bodyText,
    lastSede,
    healthInsuranceName
  );
  const statePatch = {
    ...(patientContext.statePatch || {}),
    ...(buildLastSedeStatePatch(lastSede) || {}),
    ...(healthInsuranceName
      ? {
          healthInsuranceName,
          lastHealthInsuranceName: healthInsuranceName,
          ...buildLastHealthInsuranceDiscussionStatePatch(),
        }
      : {}),
    ...buildAwaitingLinkConfirmationState(lastSede, 'after_family_cost_estimate', {
      healthInsuranceName: healthInsuranceName || undefined,
    }),
  };
  return deliverSequentialPatientTextMessages(from, replies, priorState, profileDisplayName, statePatch);
}

async function tryHandleRichPatientIntakeInquiry(from, bodyText, priorState, profileDisplayName) {
  if (!messageLooksLikeRichPatientIntakeInquiry(bodyText)) return false;
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const lastSede = patientContext.sedeEntry || resolveLastSedeEntryFromState(mergedState);
  if (!lastSede) return false;
  const healthInsuranceName = await resolveHealthInsuranceNameFromMessage(bodyText, mergedState, {
    profileDisplayName,
  });
  const replies = await buildRichPatientIntakeReplies(mergedState, bodyText, lastSede, healthInsuranceName);
  if (replies.length === 0) return false;
  const studyType = getStudyTypeFromText(bodyText);
  const statePatch = {
    ...(patientContext.statePatch || {}),
    ...(buildLastSedeStatePatch(lastSede) || {}),
    ...(healthInsuranceName
      ? {
          healthInsuranceName,
          lastHealthInsuranceName: healthInsuranceName,
          ...buildLastHealthInsuranceDiscussionStatePatch(),
        }
      : {}),
    ...(studyType ? { lastStudyType: studyType, lastStudyPriceContextAtMs: Date.now() } : {}),
    ...(isReferralOnlySedeEntry(lastSede)
      ? buildClearedStaleBookingLinkMemoryStatePatch()
      : buildAwaitingLinkConfirmationState(lastSede, 'after_rich_patient_intake', {
          healthInsuranceName: healthInsuranceName || undefined,
        })),
  };
  return deliverSequentialPatientTextMessages(from, replies, priorState, profileDisplayName, statePatch);
}

function messageAsksExplicitParticularConsultationPrice(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  if (!normalized.includes('particular')) return false;
  return (
    normalized.includes('cuanto sale particular') ||
    normalized.includes('precio particular') ||
    normalized.includes('costo particular') ||
    normalized.includes('valor particular') ||
    (messageLooksLikeAnyPriceQuestion(rawText) && normalized.includes('particular'))
  );
}

function messageAsksObraSocialOrCoveragePrice(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('obra social') ||
    normalized.includes('con cobertura') ||
    normalized.includes('con prepaga') ||
    normalized.includes('cuanto sale con') ||
    normalized.includes('precio con') ||
    messageStatesHealthInsuranceMembership(rawText)
  );
}

function messageAsksStudyProcedurePrice(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsStudy =
    messageMentionsSpirometryStudy(rawText) || messageMatchesStudiesTopic(rawText);
  if (!mentionsStudy) return false;
  return (
    messageLooksLikeAnyPriceQuestion(rawText) ||
    messageAsksAboutStudyPrice(rawText) ||
    normalized.includes('cuanto sale hacer') ||
    normalized.includes('cuanto cuesta hacer') ||
    normalized.includes('cuanto sale la espirometr') ||
    normalized.includes('cuanto cuesta la espirometr')
  );
}

function messageLooksLikeCombinedConsultationAndStudyPriceInquiry(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  return (
    messageAsksExplicitParticularConsultationPrice(rawText) &&
    messageAsksObraSocialOrCoveragePrice(rawText) &&
    messageAsksStudyProcedurePrice(rawText)
  );
}

async function estimatePatientOutOfPocketTotalForConsultationAndStudy(
  sedeEntry,
  healthInsuranceName,
  studyType
) {
  const canonicalHealthInsuranceName =
    normalizeHealthInsuranceCanonicalName(healthInsuranceName) || healthInsuranceName;
  const studyIncludedInConsultation = INSURANCE_NAMES_WITH_INCLUDED_STUDY_IN_CONSULTATION.includes(
    canonicalHealthInsuranceName
  );
  const studyAmountArs = studyIncludedInConsultation ? 0 : STUDY_PRICE_WITH_CONSULTATION_ARS;
  const plusRule = await lookupPlusRule(sedeEntry.displayName, healthInsuranceName);
  if (!plusRule || !plusRule.isAccepted) {
    return null;
  }
  const plusAmountArs =
    plusRule.hasPlus && Number.isFinite(Number(plusRule.plusAmountArs))
      ? Number(plusRule.plusAmountArs)
      : 0;
  return {
    plusAmountArs,
    studyAmountArs,
    totalAmountArs: plusAmountArs + studyAmountArs,
    studyIncludedInConsultation,
    hasPlus: Boolean(plusRule.hasPlus && plusAmountArs > 0),
    isAccepted: true,
    healthInsuranceDisplayName: canonicalHealthInsuranceName,
    studyType,
  };
}

async function estimatePrivateConsultationAndStudyTotal(sedeEntry, studyType) {
  const consultationAmountArs = await lookupPrivatePrice(sedeEntry.displayName);
  if (!Number.isFinite(consultationAmountArs)) return null;
  const studyAmountArs = STUDY_PRICE_WITH_CONSULTATION_ARS;
  return {
    consultationAmountArs,
    studyAmountArs,
    totalAmountArs: consultationAmountArs + studyAmountArs,
    isPrivatePay: true,
    studyType,
  };
}

async function buildCompleteCostTotalReply(sedeEntry, healthInsuranceName, studyType, rawText = '') {
  const studyWithArticle = buildStudyTypeWithArticle(studyType);
  const cityName = sedeEntry.displayName;
  const warmPrefix = messageMentionsChildPatientContext(rawText)
    ? 'Qué bueno que consulten antes, así van con una idea más clara. '
    : '';

  if (healthInsuranceName) {
    const estimate = await estimatePatientOutOfPocketTotalForConsultationAndStudy(
      sedeEntry,
      healthInsuranceName,
      studyType
    );
    if (!estimate) {
      return `${warmPrefix}Con ${healthInsuranceName} en ${cityName} no trabajamos. Si querés hacerlo particular, escribime y te paso el total.`;
    }
    const insuranceLabel = estimate.healthInsuranceDisplayName;
    if (estimate.studyIncludedInConsultation) {
      if (estimate.hasPlus) {
        const plusFormatted = formatArsAmount(estimate.plusAmountArs);
        return `${warmPrefix}En ${cityName}, con ${insuranceLabel}, ${studyWithArticle} queda incluido en la consulta. Total aproximado: $${plusFormatted} (plus de la consulta).`;
      }
      return `${warmPrefix}En ${cityName}, con ${insuranceLabel}, ${studyWithArticle} queda incluido en el valor de la consulta, sin plus.`;
    }
    const plusFormatted = formatArsAmount(estimate.plusAmountArs);
    const studyFormatted = formatArsAmount(estimate.studyAmountArs);
    const totalFormatted = formatArsAmount(estimate.totalAmountArs);
    if (estimate.hasPlus) {
      return `${warmPrefix}En ${cityName}, con ${insuranceLabel}: plus de consulta $${plusFormatted} + ${studyWithArticle} $${studyFormatted}. Total aproximado: $${totalFormatted}.`;
    }
    return `${warmPrefix}En ${cityName}, con ${insuranceLabel}, sin plus: ${studyWithArticle} $${studyFormatted} sobre la consulta. Total aproximado del estudio: $${studyFormatted}.`;
  }

  const privateEstimate = await estimatePrivateConsultationAndStudyTotal(sedeEntry, studyType);
  if (!privateEstimate) {
    return `${warmPrefix}En ${cityName}, consulta particular + ${studyType} es el valor de la consulta de la sede + $${formatArsAmount(STUDY_PRICE_WITH_CONSULTATION_ARS)} del estudio.`;
  }
  const consultationFormatted = formatArsAmount(privateEstimate.consultationAmountArs);
  const studyFormatted = formatArsAmount(privateEstimate.studyAmountArs);
  const totalFormatted = formatArsAmount(privateEstimate.totalAmountArs);
  return `${warmPrefix}En ${cityName}, consulta particular $${consultationFormatted} + ${studyWithArticle} $${studyFormatted}. Total aproximado: $${totalFormatted}.`;
}

async function tryHandleCompleteCostTotalInquiry(from, bodyText, priorState, profileDisplayName) {
  if (!messageLooksLikeCompleteCostTotalInquiry(bodyText, priorState)) return false;
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState, { profileDisplayName });
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const lastSede = patientContext.sedeEntry || resolveLastSedeEntryFromState(mergedState);
  const isPrivatePay = await resolvePrivatePayWithoutHealthInsuranceFromMessage(bodyText, {
    priorState,
    profileDisplayName,
  });
  const healthInsuranceName = isPrivatePay
    ? null
    : await resolveHealthInsuranceNameFromMessage(bodyText, mergedState, { profileDisplayName });
  const studyType =
    getStudyTypeFromText(bodyText) ||
    (mergedState &&
    typeof mergedState === 'object' &&
    typeof mergedState.lastStudyType === 'string' &&
    mergedState.lastStudyType.trim().length > 0
      ? mergedState.lastStudyType.trim()
      : 'estudio');
  if (!lastSede) return false;
  if (!healthInsuranceName && !isPrivatePay) return false;

  const reply = await buildCompleteCostTotalReply(
    lastSede,
    healthInsuranceName,
    studyType,
    bodyText
  );
  return sendFinalizedPatientTextReply(
    from,
    reply,
    mergedState,
    profileDisplayName,
    {
      lastStudyType: studyType,
      lastStudyPriceContextAtMs: Date.now(),
      ...(healthInsuranceName
        ? { healthInsuranceName, lastHealthInsuranceName: healthInsuranceName }
        : {}),
      ...(buildLastSedeStatePatch(lastSede) || {}),
      ...buildLastHealthInsuranceDiscussionStatePatch(),
    },
    {
      userMessage: bodyText,
      replyContext: 'complete_cost_total',
      skipHumanization: true,
    }
  );
}

async function buildStudyPriceLineForKnownCoverage(studyType, sedeEntry, healthInsuranceName) {
  const canonicalHealthInsuranceName = normalizeHealthInsuranceCanonicalName(healthInsuranceName) || healthInsuranceName;
  const studyWithArticle = buildStudyTypeWithArticle(studyType);
  if (INSURANCE_NAMES_WITH_INCLUDED_STUDY_IN_CONSULTATION.includes(canonicalHealthInsuranceName)) {
    const includedAdjective = buildStudyCoverageIncludedAdjective(studyType);
    return `Con ${canonicalHealthInsuranceName} en ${sedeEntry.displayName}, ${studyWithArticle} queda ${includedAdjective} en el valor de la consulta.`;
  }
  const formattedAmount = formatArsAmount(STUDY_PRICE_WITH_CONSULTATION_ARS);
  return `Con ${canonicalHealthInsuranceName} en ${sedeEntry.displayName}, ${studyWithArticle} en consulta sería $${formattedAmount} del estudio.`;
}

async function sendCombinedConsultationAndStudyPriceReply(
  from,
  bodyText,
  priorState,
  profileDisplayName,
  lastSede,
  healthInsuranceName,
  patientContext
) {
  const studyType = getStudyTypeFromText(bodyText) || 'espirometría';
  const primaryReply = await buildPrivatePriceReply(lastSede);
  const followUpReply = await buildHealthInsuranceSummary(lastSede, healthInsuranceName);
  const thirdReply = await buildStudyPriceLineForKnownCoverage(studyType, lastSede, healthInsuranceName);
  const wrappedPrimary = buildAutoReplyWithGreetingIfNeeded(primaryReply, profileDisplayName, priorState);
  let nextState = mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
    lastStudyType: studyType,
    lastStudyPriceContextAtMs: Date.now(),
    lastHealthInsuranceName: healthInsuranceName,
    healthInsuranceName,
    ...(patientContext.statePatch || {}),
    ...(buildLastSedeStatePatch(lastSede) || {}),
    ...(wrappedPrimary.nextStatePatch || {}),
    ...buildLastBotReplyStatePatch(wrappedPrimary.messageText),
    ...buildLastHealthInsuranceDiscussionStatePatch(),
  });
  await setConversationState(from, nextState);
  await sendWhatsAppText(from, wrappedPrimary.messageText);
  const wrappedFollowUp = buildAutoReplyWithGreetingIfNeeded(followUpReply, profileDisplayName, nextState);
  let combinedLastReply = `${wrappedPrimary.messageText} ${wrappedFollowUp.messageText}`;
  nextState = mergeConversationStatePreservingGreeting(nextState, {}, {
    ...(wrappedFollowUp.nextStatePatch || {}),
    ...buildLastBotReplyStatePatch(combinedLastReply),
  });
  await setConversationState(from, nextState);
  await sendWhatsAppText(from, wrappedFollowUp.messageText, { skipDelay: true });
  const wrappedThird = buildAutoReplyWithGreetingIfNeeded(thirdReply, profileDisplayName, nextState);
  combinedLastReply = `${combinedLastReply} ${wrappedThird.messageText}`;
  nextState = mergeConversationStatePreservingGreeting(nextState, {}, {
    ...(wrappedThird.nextStatePatch || {}),
    ...buildLastBotReplyStatePatch(combinedLastReply),
    ...buildAwaitingLinkConfirmationState(lastSede, 'after_combined_price_inquiry', {
      healthInsuranceName,
    }),
  });
  await setConversationState(from, nextState);
  await sendWhatsAppText(from, wrappedThird.messageText, { skipDelay: true });
  return true;
}

async function tryHandleCombinedConsultationAndStudyPriceInquiry(
  from,
  bodyText,
  priorState,
  profileDisplayName
) {
  if (!messageLooksLikeCombinedConsultationAndStudyPriceInquiry(bodyText)) return false;
  const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
  const mergedState = mergeConversationStatePreservingGreeting(
    priorState,
    priorState || {},
    patientContext.statePatch
  );
  const lastSede = patientContext.sedeEntry || resolveLastSedeEntryFromState(mergedState);
  const healthInsuranceName = await resolveHealthInsuranceNameFromMessage(bodyText, mergedState, {
    profileDisplayName,
  });
  if (!lastSede || !healthInsuranceName) return false;
  const healthInsuranceSummary = await buildHealthInsuranceSummary(lastSede, healthInsuranceName);
  if (healthInsuranceSummary === 'ASK_CITY_FOR_HEALTH_INSURANCE') return false;
  return sendCombinedConsultationAndStudyPriceReply(
    from,
    bodyText,
    priorState,
    profileDisplayName,
    lastSede,
    healthInsuranceName,
    patientContext
  );
}

function messageAsksAboutConsultationPlusStudy(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsConsultation = normalized.includes('consulta');
  const mentionsPlus = normalized.includes('+') || normalized.includes('mas') || normalized.includes('más');
  const mentionsStudy =
    messageMentionsSpirometryStudy(rawText) ||
    normalized.includes('test de alerg') ||
    normalized.includes('prick');
  return mentionsConsultation && mentionsStudy && mentionsPlus;
}

function messageAsksAboutStudyPrice(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const asksPrice =
    normalized.includes('cuanto sale') ||
    normalized.includes('cuanto cuesta') ||
    normalized.includes('cuanto esta') ||
    normalized.includes('cuánto está') ||
    normalized.includes('precio') ||
    normalized.includes('valor');
  if (!asksPrice) return false;
  return (
    normalized.includes('estudio') ||
    messageMentionsSpirometryStudy(rawText) ||
    normalized.includes('test de alerg') ||
    normalized.includes('prick')
  );
}

function messageAsksWhatStudiesDoctorDoes(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  if (
    normalized.includes('debo llevar') ||
    normalized.includes('debo traer') ||
    normalized.includes('tengo que llevar') ||
    normalized.includes('tengo que traer') ||
    normalized.includes('estudios previos') ||
    normalized.includes('estudios anteriores') ||
    normalized.includes('no tengo estudios') ||
    normalized.includes('no me hice estudios')
  ) {
    return false;
  }
  return (
    normalized.includes('que estudios hace') ||
    normalized.includes('qué estudios hace') ||
    normalized.includes('que estudios hacen') ||
    normalized.includes('qué estudios hacen') ||
    normalized.includes('que estudios realiza') ||
    normalized.includes('qué estudios realiza') ||
    normalized.includes('que estudios realizan') ||
    normalized.includes('qué estudios realizan') ||
    normalized.includes('cuales estudios hace') ||
    normalized.includes('cuáles estudios hace') ||
    normalized.includes('cuales estudios hacen') ||
    normalized.includes('cuáles estudios hacen') ||
    normalized.includes('cuales estudios realiza') ||
    normalized.includes('cuáles estudios realiza') ||
    normalized.includes('que practicas hace') ||
    normalized.includes('qué prácticas hace') ||
    normalized.includes('que practicas hacen') ||
    normalized.includes('qué prácticas hacen') ||
    normalized.includes('que practicas realiza') ||
    normalized.includes('qué prácticas realiza') ||
    (normalized.includes('estudio') && normalized.includes('en consulta')) ||
    (normalized.includes('estudio') && normalized.includes('en la consulta'))
  );
}

function messageAsksWhatStudiesToBring(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageLooksLikeStudyPreparationQuestion(rawText)) return false;
  const normalized = normalizeForMatch(rawText);
  if (normalized.includes('algo especial')) return false;
  if (normalized.includes('preparacion') || normalized.includes('preparación')) return false;
  if (
    normalized.includes('que estudios hace') ||
    normalized.includes('que estudios hacen') ||
    normalized.includes('que estudios realiza') ||
    normalized.includes('que estudios realizan') ||
    normalized.includes('cuales estudios hace') ||
    normalized.includes('cuales estudios hacen') ||
    (normalized.includes('estudio') && normalized.includes('en consulta') && !normalized.includes('llevar')) ||
    (normalized.includes('estudio') && normalized.includes('en la consulta') && !normalized.includes('llevar'))
  ) {
    return false;
  }
  const asksToBring =
    normalized.includes('debo llevar') ||
    normalized.includes('debo traer') ||
    normalized.includes('tengo que llevar') ||
    normalized.includes('tengo que traer') ||
    normalized.includes('hay que llevar') ||
    normalized.includes('hay que traer') ||
    normalized.includes('que debo llevar') ||
    normalized.includes('que debo traer') ||
    normalized.includes('que tengo que traer') ||
    normalized.includes('estudios previos') ||
    normalized.includes('estudios anteriores') ||
    normalized.includes('estudios que ya') ||
    normalized.includes('resultados de estudios') ||
    normalized.includes('informes de estudios') ||
    normalized.includes('traer estudios') ||
    normalized.includes('llevar estudios') ||
    (normalized.includes('llevar') && normalized.includes('estudio')) ||
    (normalized.includes('traer') && normalized.includes('estudio')) ||
    ((normalized.includes('que llevar') || normalized.includes('que llevo')) &&
      (normalized.includes('estudio') || normalized.includes('informe') || normalized.includes('historia clinica')));
  return asksToBring;
}

function messageSaysHasNoPriorStudies(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('no tengo estudios') ||
    normalized.includes('no me hice estudios') ||
    normalized.includes('nunca me hice estudios') ||
    normalized.includes('no tengo informes') ||
    normalized.includes('no tengo ningun estudio') ||
    normalized.includes('no tengo ningun informe') ||
    normalized.includes('sin estudios previos') ||
    normalized.includes('sin estudios anteriores') ||
    normalized.includes('no traigo estudios') ||
    normalized.includes('no hice estudios') ||
    normalized.includes('no tiene estudios') ||
    normalized.includes('no se hizo estudios') ||
    normalized.includes('no hizo estudios')
  );
}

function messageAsksWhatStudiesWillBeRequested(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageAsksWhatStudiesToBring(rawText)) return false;
  if (messageSaysHasNoPriorStudies(rawText)) return false;
  if (messageWasSentForStudiesBeforeVisit(rawText)) return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsStudies =
    normalized.includes('estudio') ||
    normalized.includes('practica') ||
    normalized.includes('prick') ||
    normalized.includes('espirometr') ||
    normalized.includes('laboratorio');
  if (!mentionsStudies) return false;
  return (
    normalized.includes('que estudios me van a pedir') ||
    normalized.includes('que estudios me piden') ||
    normalized.includes('que estudios me van a hacer') ||
    normalized.includes('que estudios necesito') ||
    normalized.includes('que estudios debo hacerme') ||
    normalized.includes('que me van a pedir') ||
    normalized.includes('que practicas me van a pedir') ||
    normalized.includes('que tengo que hacerme antes') ||
    normalized.includes('que debo hacerme antes') ||
    normalized.includes('necesito hacerme algun estudio') ||
    normalized.includes('necesito algun estudio antes')
  );
}

function messageAsksAboutDigitalStudyResults(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsDigitalFormat =
    normalized.includes('foto') ||
    normalized.includes('fotografia') ||
    normalized.includes('pdf') ||
    normalized.includes('celular') ||
    normalized.includes('telefono') ||
    normalized.includes('digital') ||
    normalized.includes('escaneado') ||
    normalized.includes('captura');
  if (!mentionsDigitalFormat) return false;
  const mentionsMedicalRecord =
    normalized.includes('informe') ||
    normalized.includes('estudio') ||
    normalized.includes('resultado') ||
    normalized.includes('analisis');
  const asksAboutBringingOrSending =
    normalized.includes('llevar') ||
    normalized.includes('traer') ||
    normalized.includes('mostrar') ||
    normalized.includes('sirve') ||
    normalized.includes('puedo') ||
    normalized.includes('enviar') ||
    normalized.includes('mandar') ||
    normalized.includes('pasar');
  return mentionsMedicalRecord || asksAboutBringingOrSending;
}

function messageWasSentForStudiesBeforeVisit(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageAsksWhatStudiesToBring(rawText)) return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('me mandaron a hacerme') ||
    normalized.includes('me mandaron a hacer') ||
    normalized.includes('me derivaron para') ||
    normalized.includes('me derivaron a hacerme') ||
    normalized.includes('otro medico me mando') ||
    normalized.includes('otro medico me dijo') ||
    normalized.includes('me pidieron que me haga') ||
    normalized.includes('me pidieron hacerme') ||
    (normalized.includes('antes de ir') &&
      (normalized.includes('estudio') || normalized.includes('espirometr') || normalized.includes('prick')))
  );
}

function messageAsksAboutMedicalHistoryToBring(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  const mentionsHistory =
    normalized.includes('historia clinica') ||
    normalized.includes('informe de otro medico') ||
    normalized.includes('informe medico') ||
    normalized.includes('informes de otro') ||
    normalized.includes('receta de otro') ||
    normalized.includes('derivacion de otro');
  const asksToBring =
    normalized.includes('llevar') ||
    normalized.includes('traer') ||
    normalized.includes('debo') ||
    normalized.includes('tengo que') ||
    normalized.includes('hay que') ||
    normalized.includes('necesito');
  return mentionsHistory && asksToBring;
}

function messageMentionsChildPatientContext(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    messageAsksIfDoctorTreatsChildren(rawText) ||
    normalized.includes('mi hijo') ||
    normalized.includes('mi hija') ||
    normalized.includes('de mi hijo') ||
    normalized.includes('de mi hija') ||
    normalized.includes('para mi hijo') ||
    normalized.includes('para mi hija') ||
    normalized.includes('del nene') ||
    normalized.includes('del nena') ||
    normalized.includes('mi menor')
  );
}

function messageMatchesStudiesPatientOnlyFaq(rawText, priorState) {
  return (
    messageAsksAboutStudyPreparation(rawText, priorState) ||
    messageAsksWhatStudiesToBring(rawText) ||
    messageSaysHasNoPriorStudies(rawText) ||
    messageAsksWhatStudiesWillBeRequested(rawText) ||
    messageAsksAboutDigitalStudyResults(rawText) ||
    messageWasSentForStudiesBeforeVisit(rawText) ||
    messageAsksAboutMedicalHistoryToBring(rawText)
  );
}

function messageMatchesStudiesTopic(rawText) {
  return messageAsksAboutStudiesOrTests(rawText) || messageMatchesStudiesPatientOnlyFaq(rawText);
}

function appendSedeContextIfKnown(baseMessage, priorState) {
  const sedeFromState = resolveKnownSedeForConversationContext(priorState);
  if (sedeFromState) {
    return `${baseMessage} Te esperamos en ${sedeFromState.displayName}.`;
  }
  return baseMessage;
}

function buildStudiesToBringReply(priorState, rawText = '') {
  const isChildContext = messageMentionsChildPatientContext(rawText);
  const isMedicalHistoryOnly =
    messageAsksAboutMedicalHistoryToBring(rawText) && !messageAsksWhatStudiesToBring(rawText);
  let baseMessage = STUDIES_TO_BRING_MESSAGE;
  if (isChildContext) {
    baseMessage = STUDIES_CHILD_TO_BRING_MESSAGE;
  } else if (isMedicalHistoryOnly) {
    baseMessage = STUDIES_MEDICAL_HISTORY_TO_BRING_MESSAGE;
  }
  const sedeFromState = resolveKnownSedeForConversationContext(priorState);
  const childReviewSuffix = isChildContext ? ' con tu hijo/a' : '';
  if (sedeFromState) {
    return `${baseMessage} Así el Dr. puede revisarlos en la consulta${childReviewSuffix} en ${sedeFromState.displayName}.`;
  }
  return `${baseMessage} Así el Dr. puede revisarlos en la consulta${childReviewSuffix}.`;
}

function normalizeHealthInsuranceNameForStudyPricing(healthInsuranceName) {
  if (!healthInsuranceName || typeof healthInsuranceName !== 'string') return null;
  if (/osde/i.test(healthInsuranceName)) return 'OSDE';
  if (/sancor/i.test(healthInsuranceName) && !/mutual/i.test(healthInsuranceName)) return 'Sancor';
  if (/isunne|issune|isune/i.test(healthInsuranceName)) return 'Isunne';
  return healthInsuranceName;
}

function resolveKnownHealthInsuranceNameForStudyPricing(priorState, rawText) {
  const fromMessage = normalizeHealthInsuranceNameForStudyPricing(tryExtractHealthInsuranceName(rawText));
  if (fromMessage && typeof fromMessage === 'string' && fromMessage.trim().length > 0) {
    return fromMessage.trim();
  }
  if (!priorState || typeof priorState !== 'object') return null;
  if (typeof priorState.healthInsuranceName === 'string' && priorState.healthInsuranceName.trim().length > 0) {
    return normalizeHealthInsuranceNameForStudyPricing(priorState.healthInsuranceName.trim());
  }
  if (
    typeof priorState.lastHealthInsuranceName === 'string' &&
    priorState.lastHealthInsuranceName.trim().length > 0
  ) {
    return normalizeHealthInsuranceNameForStudyPricing(priorState.lastHealthInsuranceName.trim());
  }
  return null;
}

async function buildStudiesInformationReply(priorState, rawText = '', options = {}) {
  const normalized = normalizeForMatch(rawText);
  if (messageAsksAboutStudyPreparation(rawText, priorState)) {
    const openAiPreparationReply = await fetchOpenAiStudyPreparationReply(rawText, {
      profileDisplayName:
        options && typeof options.profileDisplayName === 'string' ? options.profileDisplayName : '',
      priorState,
    });
    if (openAiPreparationReply) {
      return processAssistantReplyForPatient(openAiPreparationReply);
    }
    return buildStudyPreparationReply(priorState, rawText);
  }
  if (messageAsksAboutDigitalStudyResults(rawText)) {
    return STUDIES_DIGITAL_RESULTS_MESSAGE;
  }
  if (messageSaysHasNoPriorStudies(rawText)) {
    const baseMessage = messageMentionsChildPatientContext(rawText)
      ? STUDIES_CHILD_NO_PRIOR_STUDIES_MESSAGE
      : STUDIES_NO_PRIOR_STUDIES_MESSAGE;
    return appendSedeContextIfKnown(baseMessage, priorState);
  }
  if (messageAsksWhatStudiesToBring(rawText) || messageAsksAboutMedicalHistoryToBring(rawText)) {
    return buildStudiesToBringReply(priorState, rawText);
  }
  if (messageWasSentForStudiesBeforeVisit(rawText)) {
    return appendSedeContextIfKnown(STUDIES_SENT_FOR_STUDIES_BEFORE_VISIT_MESSAGE, priorState);
  }
  if (messageAsksWhatStudiesWillBeRequested(rawText)) {
    return appendSedeContextIfKnown(STUDIES_WILL_BE_REQUESTED_MESSAGE, priorState);
  }
  if (messageAsksWhatStudiesDoctorDoes(rawText)) {
    const sedeFromState = resolveKnownSedeForConversationContext(priorState);
    if (sedeFromState) {
      return `${STUDIES_INFORMATION_MESSAGE} En ${sedeFromState.displayName} se evalúan según el caso en consulta.`;
    }
    return `${STUDIES_INFORMATION_MESSAGE} Se evalúan según el caso en consulta.`;
  }
  const studyTypeFromMessage = getStudyTypeFromText(rawText);
  const studyTypeFromState =
    priorState && typeof priorState === 'object' && typeof priorState.lastStudyType === 'string'
      ? priorState.lastStudyType
      : null;
  const studyType = studyTypeFromMessage || studyTypeFromState || 'estudio';
  const forcePriceFlow = Boolean(options.forcePriceFlow);
  const usePriorStudyPricingContext = shouldUsePriorStudyPricingContext(priorState, rawText);
  const patientContext = await resolvePatientContextFromMessage(rawText, priorState, {
    profileDisplayName:
      options && typeof options.profileDisplayName === 'string' ? options.profileDisplayName : '',
  });
  const isPrivatePayForStudyPrice = await resolvePrivatePayWithoutHealthInsuranceFromMessage(rawText, {
    priorState,
    profileDisplayName:
      options && typeof options.profileDisplayName === 'string' ? options.profileDisplayName : '',
  });
  const inferredHealthInsuranceName = isPrivatePayForStudyPrice
    ? null
    : usePriorStudyPricingContext
      ? patientContext.healthInsuranceName || resolveKnownHealthInsuranceNameForStudyPricing(priorState, rawText)
      : patientContext.healthInsuranceName ||
        normalizeHealthInsuranceNameForStudyPricing(tryExtractHealthInsuranceName(rawText));
  const lastSede = patientContext.sedeEntry;
  const asksPrice =
    forcePriceFlow ||
    messageAsksAboutStudyPrice(rawText) ||
    messageLooksLikeStudyPriceFollowUp(rawText, priorState) ||
    messageLooksLikeAnyPriceQuestion(rawText) ||
    messageExplicitlyAsksPrivateConsultationPrice(rawText);
  const asksTotalAmount =
    messageAsksCompleteOrTotalCost(rawText) ||
    messageAsksApproximateConsultationCost(rawText) ||
    messageLooksLikeFamilyConsultationCostEstimateInquiry(rawText);

  if (messageLooksLikeSpirometryOnlyInquiry(rawText)) {
    return buildSpirometryOnlyInquirySplitReply(priorState, rawText);
  }

  if (messageAsksAboutStandaloneSpirometryWithoutConsultation(rawText)) {
    const formattedAmount = formatArsAmount(STANDALONE_SPIROMETRY_PRICE_ARS);
    return `Si querés solo espirometría sin consulta, sale $${formattedAmount}.`;
  }

  if (studyTypeFromMessage && messageAsksWhetherDoctorPerformsStudy(rawText)) {
    return buildStudyAvailabilitySplitReply(studyTypeFromMessage, priorState, rawText, { lastSede });
  }

  if (
    (asksPrice || forcePriceFlow) &&
    inferredHealthInsuranceName &&
    INSURANCE_NAMES_WITH_INCLUDED_STUDY_IN_CONSULTATION.includes(inferredHealthInsuranceName)
  ) {
    const studyWithArticle = buildStudyTypeWithArticle(studyType);
    const includedAdjective = buildStudyCoverageIncludedAdjective(studyType);
    if (lastSede) {
      return `Con ${inferredHealthInsuranceName} en ${lastSede.displayName}, sin plus: ${studyWithArticle} queda ${includedAdjective} en el valor de la consulta.`;
    }
    return `Con ${inferredHealthInsuranceName}, sin plus: ${studyWithArticle} queda ${includedAdjective} en el valor de la consulta.`;
  }

  if (
    messageAsksAboutConsultationPlusStudy(rawText) ||
    (asksPrice && (normalized.includes('particular') || isPrivatePayForStudyPrice))
  ) {
    const formattedAmount = formatArsAmount(STUDY_PRICE_WITH_CONSULTATION_ARS);
    const sedeFromState = resolveKnownSedeForConversationContext(priorState) || lastSede;
    if (sedeFromState) {
      return `En ${sedeFromState.displayName}, consulta particular + ${studyType} es el valor de la consulta de la sede + $${formattedAmount}.`;
    }
    return `Consulta particular + ${studyType} es el valor de la consulta de la sede + $${formattedAmount}. ${buildAskSedeMessage()}`;
  }

  if (asksPrice) {
    if (!studyTypeFromMessage && !studyTypeFromState) {
      return '¿Querés saber el valor de espirometría o de test de alergia?';
    }
    if (!inferredHealthInsuranceName && !lastSede) {
      return `Antes de pasarte el valor, contame qué obra social/prepaga tenés y desde qué ciudad te consultás. ${buildAskSedeMessage()}`;
    }
    if (!inferredHealthInsuranceName) {
      return 'Antes de pasarte el valor, ¿qué obra social/prepaga tenés?';
    }
    if (!lastSede) {
      return `Antes de pasarte el valor final, ¿desde qué ciudad te consultás? ${buildAskSedeMessage()}`;
    }
    if (asksTotalAmount && (studyTypeFromMessage || studyTypeFromState)) {
      return buildCompleteCostTotalReply(
        lastSede,
        isPrivatePayForStudyPrice ? null : inferredHealthInsuranceName,
        studyType,
        rawText
      );
    }
    if (INSURANCE_NAMES_WITH_INCLUDED_STUDY_IN_CONSULTATION.includes(inferredHealthInsuranceName)) {
      const studyWithArticle = buildStudyTypeWithArticle(studyType);
      const includedAdjective = buildStudyCoverageIncludedAdjective(studyType);
      return `Con ${inferredHealthInsuranceName} en ${lastSede.displayName}, sin plus: ${studyWithArticle} queda ${includedAdjective} en el valor de la consulta.`;
    }
    const formattedAmount = formatArsAmount(STUDY_PRICE_WITH_CONSULTATION_ARS);
    const plusRule = await lookupPlusRule(lastSede.displayName, inferredHealthInsuranceName);
    if (plusRule && plusRule.isAccepted && plusRule.hasPlus) {
      const plusFormatted =
        Number.isFinite(plusRule.plusAmountArs) && plusRule.plusAmountArs != null
          ? formatArsAmount(plusRule.plusAmountArs)
          : null;
      if (plusFormatted) {
        if (asksTotalAmount) {
          return buildCompleteCostTotalReply(
            lastSede,
            inferredHealthInsuranceName,
            studyType,
            rawText
          );
        }
        return `Con ${inferredHealthInsuranceName}, plus de $${plusFormatted} + ${studyType} sería $${formattedAmount} del estudio.`;
      }
    }
    if (plusRule && plusRule.isAccepted && !plusRule.hasPlus) {
      if (asksTotalAmount) {
        return buildCompleteCostTotalReply(lastSede, inferredHealthInsuranceName, studyType, rawText);
      }
      return `Con ${inferredHealthInsuranceName}, sin plus. ${studyType} sería $${formattedAmount} del estudio.`;
    }
    if (plusRule && !plusRule.isAccepted) {
      return `Con ${inferredHealthInsuranceName} no trabajamos en ${lastSede.displayName}. Si querés hacerlo particular, ${studyType} sería $${formattedAmount} del estudio más la consulta.`;
    }
    if (asksTotalAmount) {
      return buildCompleteCostTotalReply(lastSede, inferredHealthInsuranceName, studyType, rawText);
    }
    return `Con ${inferredHealthInsuranceName}, ${studyType} sería $${formattedAmount} del estudio.`;
  }

  if (studyTypeFromMessage) {
    const knownHealthInsuranceName = resolveKnownHealthInsuranceNameForStudyPricing(priorState, rawText);
    const studyWithArticle = buildStudyTypeWithArticle(studyTypeFromMessage);
    if (!knownHealthInsuranceName && !lastSede) {
      return `Sí, el Dr. realiza ${studyWithArticle}. Contame qué obra social/prepaga tenés y desde qué ciudad te consultás. ${buildAskSedeMessage()}`;
    }
    if (!knownHealthInsuranceName) {
      return `Sí, el Dr. realiza ${studyWithArticle}. Contame qué obra social/prepaga tenés.`;
    }
    if (!lastSede) {
      return `Sí, el Dr. realiza ${studyWithArticle}. ¿Desde qué ciudad te consultás? ${buildAskSedeMessage()}`;
    }
    if (knownHealthInsuranceName) {
      return `Sí, el Dr. realiza ${studyWithArticle} en ${lastSede.displayName} con ${knownHealthInsuranceName}. ¿Querés que te cuente el valor o preferís agendar?`;
    }
    return `Sí, el Dr. realiza ${studyWithArticle} en ${lastSede.displayName}. ¿Querés que te cuente el valor o preferís agendar?`;
  }

  if (messageLooksLikeSedeOnlyAnswer(rawText)) {
    return null;
  }
  const sedeFromState = resolveKnownSedeForConversationContext(priorState);
  if (sedeFromState) {
    return `${STUDIES_INFORMATION_MESSAGE} Para confirmarte cómo se realiza en tu situación y en ${sedeFromState.displayName}, lo ideal es sacar un turno para evaluación.`;
  }
  return `${STUDIES_INFORMATION_MESSAGE} Para confirmarte cómo se realiza en tu situación y en qué sede, lo ideal es sacar un turno para evaluación. ${buildAskSedeMessage()}`;
}

function buildScheduleQuestionLinkMessage(entry, priorState = null) {
  if (isReferralOnlySedeEntry(entry)) {
    return buildReferralOnlySedeBookingReply(entry);
  }
  const linkUrl = resolveBookingLinkUrlFromState(priorState, entry);
  if (linkUrl && hasBookingLinkInStateForSede(priorState, entry)) {
    return 'Los horarios disponibles se ven en la agenda online; por acá no confirmamos disponibilidad ni agendamos. Podés revisarlos en el link que ya te pasé.';
  }
  if (linkUrl) {
    return `En ${entry.displayName} los días y horarios en que atiende el Dr. se ven en la agenda online; por acá no agendamos. ¿Te paso el link?`;
  }
  return buildLinkMessage(entry);
}

function buildLinkMessage(entry) {
  if (isReferralOnlySedeEntry(entry)) {
    return buildReferralOnlySedeBookingReply(entry);
  }
  const url = getAgendaUrl(entry);
  if (url) {
    return `Acá tenés el link para elegir el día y horario que mejor te quede en ${entry.displayName}:\n${url}`;
  }
  return [
    `Recibimos tu preferencia por ${entry.displayName}.`,
    '',
    'El link de agenda online todavía no está configurado.',
    'Escribinos el horario preferido y te confirmamos por este chat.',
  ].join('\n');
}

function combineSlotAcknowledgmentWithLinkReminder(acknowledgmentPrefix, reminderLine) {
  if (!acknowledgmentPrefix || !reminderLine) return reminderLine;
  const cleanedPrefix = acknowledgmentPrefix
    .replace(/\.?\s*Por acá no agendamos por este chat\.?/gi, '')
    .replace(/\.?\s*Por acá no confirmamos horarios puntuales ni disponibilidad\.?/gi, '')
    .replace(/\.?\s*Por acá no confirmamos disponibilidad\.?/gi, '')
    .trim();
  if (!cleanedPrefix) return reminderLine;
  const prefixEndsWithPunctuation = /[.!?]$/.test(cleanedPrefix);
  return prefixEndsWithPunctuation ? `${cleanedPrefix} ${reminderLine}` : `${cleanedPrefix}. ${reminderLine}`;
}

function buildAlreadySentBookingLinkAffirmationReply(priorState, entry, options = {}) {
  if (isReferralOnlySedeEntry(entry)) {
    return buildReferralOnlySedeBookingReply(entry);
  }
  const userMessage = typeof options.userMessage === 'string' ? options.userMessage : '';
  const acknowledgmentPrefix =
    typeof options.acknowledgmentPrefix === 'string' ? options.acknowledgmentPrefix.trim() : '';
  const cityName = entry.displayName;
  const linkUrl = resolveBookingLinkUrlFromState(priorState, entry);
  const linkAlreadyShared =
    conversationLooksLikeOngoingBookingLinkGuidance(priorState) ||
    hasBookingLinkInStateForSede(priorState, entry);
  const directReminderLine = linkAlreadyShared
    ? `Con el link que ya te pasé podés ver horarios y reservar tu turno en ${cityName}.`
    : linkUrl
      ? `Podés ver horarios y reservar tu turno en ${cityName} en este link:\n${linkUrl}`
      : null;

  if (!directReminderLine) {
    return buildLinkMessage(entry);
  }

  const reminderWithOptionalPrefix = acknowledgmentPrefix
    ? combineSlotAcknowledgmentWithLinkReminder(acknowledgmentPrefix, directReminderLine)
    : directReminderLine;

  if (
    messageAsksWhereOrHowToBook(userMessage) ||
    messageAsksExplicitlyHowToBookTurn(userMessage) ||
    messageAsksHowBookingWorks(userMessage)
  ) {
    return reminderWithOptionalPrefix;
  }

  if (messageIsAcknowledgement(userMessage) && !messageExplicitlyRequestsBookingLink(userMessage)) {
    return acknowledgmentPrefix ? reminderWithOptionalPrefix : null;
  }

  if (messageExplicitlyRequestsBookingLink(userMessage)) {
    return reminderWithOptionalPrefix;
  }

  return reminderWithOptionalPrefix;
}

async function deliverBookingLinkReminderReply(
  from,
  bodyText,
  priorState,
  profileDisplayName,
  lastSede,
  options = {}
) {
  if (isReferralOnlySedeEntry(lastSede)) {
    return sendReferralOnlySedeBookingReply(from, lastSede, priorState, profileDisplayName);
  }
  const rulesReply = buildAlreadySentBookingLinkAffirmationReply(priorState, lastSede, {
    userMessage: bodyText,
    acknowledgmentPrefix: options.acknowledgmentPrefix,
  });
  if (!rulesReply) {
    return sendFinalizedPatientTextReply(
      from,
      buildBareConversationAcknowledgementDraft(),
      priorState,
      profileDisplayName,
      {
        ...(buildLastSedeStatePatch(lastSede) || {}),
      },
      {
        userMessage: bodyText,
        replyContext: 'bare_ack',
        conversationContext: buildIntentRoutingOpenAiContext(priorState),
      }
    );
  }
  return sendFinalizedPatientTextReply(
    from,
    rulesReply,
    priorState,
    profileDisplayName,
    {
      ...(buildLastSedeStatePatch(lastSede) || {}),
      ...(buildLinkSentStatePatch(lastSede) || {}),
    },
    {
      userMessage: bodyText,
      replyContext: options.replyContext || 'booking_link_reminder',
      conversationContext: buildIntentRoutingOpenAiContext(priorState),
    }
  );
}

function messageRequestsPersonalBookingAssistance(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const mentionsDerivation =
    normalized.includes('derivame') ||
    normalized.includes('deriváme') ||
    normalized.includes('derivenme') ||
    normalized.includes('derivacion') ||
    normalized.includes('derivación') ||
    normalized.includes('me deriven') ||
    normalized.includes('que me deriven') ||
    normalized.includes('quiero derivacion') ||
    normalized.includes('quiero derivación') ||
    normalized.includes('necesito derivacion') ||
    normalized.includes('necesito derivación');
  const confirmsAssistanceAfterOffer =
    (/^(si|sí|dale|ok|oka|por favor|porfa)\b/.test(normalized) || normalized === 'si' || normalized === 'sí') &&
    (normalized.includes('deriv') ||
      normalized.includes('acompañ') ||
      normalized.includes('acompan') ||
      normalized.includes('ayuda') ||
      normalized.includes('persona') ||
      normalized.includes('humano') ||
      normalized.includes('alguien'));
  return (
    mentionsDerivation ||
    confirmsAssistanceAfterOffer ||
    normalized.includes('pasame con alguien') ||
    normalized.includes('pasame con una persona') ||
    normalized.includes('hablar con alguien') ||
    normalized.includes('necesito ayuda para agendar') ||
    messageAsksToTalkToSecretary(rawText)
  );
}

function conversationLooksLikeBookingPersonalAssistanceContext(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (conversationLooksLikeOngoingBookingLinkGuidance(priorState)) return true;
  if (stateLooksLikeAwaitingBookingLinkTroubleFollowup(priorState)) return true;
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  if (!lastBotReplyText) return false;
  return (
    lastBotReplyText.includes('paso a paso') ||
    replyTextIncludesClinicAssistancePhoneNumber(lastBotReplyText) ||
    lastBotReplyText.includes('te acompaño') ||
    lastBotReplyText.includes('te acompano') ||
    lastBotReplyText.includes('comunicarte al')
  );
}

function buildBookingPersonalAssistanceConfirmationReply(priorState = null, sedeEntry = null) {
  return `Dale. ${buildBookingPersonalAssistanceMessage(priorState, sedeEntry)}`;
}

async function tryHandleBookingPersonalAssistanceRequest(from, bodyText, priorState, profileDisplayName) {
  if (!messageRequestsPersonalBookingAssistance(bodyText)) return false;
  if (!conversationLooksLikeBookingPersonalAssistanceContext(priorState)) return false;
  const replyText = buildBookingPersonalAssistanceConfirmationReply(priorState);
  return sendFinalizedPatientTextReply(
    from,
    replyText,
    priorState,
    profileDisplayName,
    {
      bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS,
    },
    {
      userMessage: bodyText,
      replyContext: 'booking_personal_assistance',
      suppressBookingLinkOffer: true,
    }
  );
}

function messageLooksLikeAlreadySentLinkBookingFollowUp(rawText, priorState) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageRequestsPersonalBookingAssistance(rawText)) return false;
  if (conversationExpectsStudyPriceOrTypeAnswer(priorState)) return false;
  if (!priorState || typeof priorState !== 'object') return false;
  const lastSede = resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  if (!lastSede) return false;
  if (isReferralOnlySedeEntry(lastSede)) return false;
  const linkWasShared =
    wasBookingLinkSentRecently(priorState) || hasBookingLinkInStateForSede(priorState, lastSede);
  if (!linkWasShared) return false;

  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const mentionsLinkOrBooking =
    normalized.includes('link') ||
    normalized.includes('agenda') ||
    normalized.includes('agendar') ||
    normalized.includes('reservar') ||
    normalized.includes('reservo');
  if (!mentionsLinkOrBooking && !messageConfirmsLinkSend(rawText)) return false;

  return (
    normalized.includes('entonces') ||
    normalized.includes('con el link') ||
    normalized.includes('al link') ||
    normalized.includes('por el link') ||
    normalized.includes('del link') ||
    normalized.includes('uso el link') ||
    normalized.includes('es por el link') ||
    normalized.includes('es con el link') ||
    normalized.includes('para reservar') ||
    messageConfirmsLinkSend(rawText)
  );
}

async function tryHandleAlreadySentBookingLinkFollowUp(from, bodyText, priorState, profileDisplayName) {
  if (!messageLooksLikeAlreadySentLinkBookingFollowUp(bodyText, priorState)) return false;
  const lastSede = resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  if (!lastSede) return false;
  return deliverBookingLinkReminderReply(from, bodyText, priorState, profileDisplayName, lastSede);
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

function messageLooksLikeBookingLinkUsageDifficulty(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return (
    normalized.includes('no se como hacer') ||
    normalized.includes('no sé cómo hacer') ||
    normalized.includes('no se como usar') ||
    normalized.includes('no sé cómo usar') ||
    normalized.includes('no se como reservar') ||
    normalized.includes('no sé cómo reservar') ||
    normalized.includes('no se como agendar') ||
    normalized.includes('no sé cómo agendar') ||
    normalized.includes('no entiendo como') ||
    normalized.includes('no entiendo cómo') ||
    normalized.includes('no se usar el link') ||
    normalized.includes('no sé usar el link') ||
    normalized.includes('no se usar la pagina') ||
    normalized.includes('no sé usar la página') ||
    normalized.includes('como hago para reservar') ||
    normalized.includes('cómo hago para reservar') ||
    normalized.includes('como hago para agendar') ||
    normalized.includes('cómo hago para agendar') ||
    normalized.includes('que tengo que hacer') ||
    normalized.includes('qué tengo que hacer') ||
    normalized.includes('no entiendo nada') ||
    normalized.includes('no entiendo como agendar') ||
    normalized.includes('no entiendo cómo agendar') ||
    normalized.includes('no entiendo como reservar') ||
    normalized.includes('no entiendo cómo reservar') ||
    normalized.includes('es muy complicado') ||
    normalized.includes('muy complicado agendar') ||
    normalized.includes('imposible agendar') ||
    normalized.includes('no me sale agendar') ||
    normalized === 'como hago' ||
    normalized === 'cómo hago' ||
    normalized === 'como es' ||
    normalized === 'cómo es'
  );
}

function messageLooksLikeBookingLinkTechnicalTrouble(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('no me abre') ||
    normalized.includes('no abre') ||
    normalized.includes('no funciona') ||
    normalized.includes('no me funciona') ||
    normalized.includes('no anda') ||
    normalized.includes('no puedo abrir') ||
    normalized.includes('no puedo entrar') ||
    normalized.includes('no me deja') ||
    normalized.includes('no carga') ||
    normalized.includes('no carga la pagina') ||
    normalized.includes('no carga la página') ||
    normalized.includes('pagina en blanco') ||
    normalized.includes('página en blanco') ||
    normalized.includes('error en el link') ||
    normalized.includes('link caido') ||
    normalized.includes('link caído') ||
    normalized.includes('link roto') ||
    normalized.includes('link muerto') ||
    normalized.includes('link no sirve') ||
    normalized.includes('problema con el link') ||
    normalized.includes('problema con la pagina') ||
    normalized.includes('problema con la página')
  );
}

function messageLooksLikeBookingLinkTrouble(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  if (messageLooksLikeBookingLinkUsageDifficulty(rawText)) return true;
  if (messageLooksLikeBookingLinkTechnicalTrouble(rawText)) return true;
  const normalized = normalizeForMatch(rawText);
  const hasAvailabilityComplaint =
    normalized.includes('no hay turnos') ||
    normalized.includes('no hay disponibles') ||
    normalized.includes('sin turnos') ||
    normalized.includes('no hay disponibilidad') ||
    normalized.includes('no aparecen turnos') ||
    normalized.includes('no aparece disponibilidad');
  if (hasAvailabilityComplaint && !hasLinkTroubleSignal) return false;
  if (hasAvailabilityComplaint) return true;
  const hasBookingFailure =
    normalized.includes('no pude agendar') ||
    normalized.includes('no pude reservar') ||
    normalized.includes('no pude sacar turno') ||
    normalized.includes('no me dejo reservar') ||
    normalized.includes('no me dejó reservar');
  if (!hasBookingFailure) return false;
  if (hasLinkTroubleSignal) return true;
  if (
    normalized.includes('link') ||
    normalized.includes('pagina') ||
    normalized.includes('página') ||
    normalized.includes('agenda online') ||
    normalized.includes('en la web')
  ) {
    return true;
  }
  return (
    normalized.includes('que hago') ||
    normalized.includes('qué hago') ||
    normalized.includes('no se que hacer') ||
    normalized.includes('no sé qué hacer')
  );
}

function messageAsksToBookWithoutSelfServiceLink(rawText) {
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
    normalized.includes('no tengo mail') ||
    normalized.includes('no tengo email') ||
    normalized.includes('no uso mail') ||
    normalized.includes('no uso email') ||
    normalized.includes('no se usar') ||
    normalized.includes('no sé usar') ||
    normalized.includes('no se entrar') ||
    normalized.includes('no sé entrar') ||
    normalized.includes('no se reservar') ||
    normalized.includes('no sé reservar') ||
    normalized.includes('no se agendar') ||
    normalized.includes('no sé agendar') ||
    normalized.includes('me ayudas a sacar') ||
    normalized.includes('me ayudás a sacar')
  );
}

function messageAsksIfAssistantCanBookForUser(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('vos no lo podes hacer por mi') ||
    normalized.includes('vos no lo podés hacer por mí') ||
    normalized.includes('no lo podes hacer por mi') ||
    normalized.includes('no lo podés hacer por mí') ||
    normalized.includes('lo podes hacer por mi') ||
    normalized.includes('lo podés hacer por mí') ||
    normalized.includes('podes hacerlo vos') ||
    normalized.includes('podés hacerlo vos') ||
    normalized.includes('lo haces vos') ||
    normalized.includes('lo hacés vos') ||
    normalized.includes('agendame vos') ||
    normalized.includes('agendame por mi') ||
    normalized.includes('agendame por mí') ||
    normalized.includes('agendamelo vos') ||
    normalized.includes('agendámelo vos') ||
    normalized.includes('agendamelo') ||
    normalized.includes('agendámelo') ||
    normalized.includes('me lo agendas') ||
    normalized.includes('me lo agendás') ||
    normalized.includes('reservame vos') ||
    normalized.includes('reserváme vos') ||
    normalized.includes('podes agendarme') ||
    normalized.includes('podés agendarme') ||
    normalized.includes('podes reservarme') ||
    normalized.includes('podés reservarme') ||
    normalized.includes('me lo reservas') ||
    normalized.includes('me lo reservás')
  );
}

function messageAsksToBookWithoutLink(rawText) {
  return messageAsksIfAssistantCanBookForUser(rawText) || messageAsksToBookWithoutSelfServiceLink(rawText);
}

function messageLooksLikeAssistedBookingRequest(rawText) {
  return messageAsksIfAssistantCanBookForUser(rawText) || messageAsksToBookWithoutSelfServiceLink(rawText);
}

function buildSelfBookingRequiredReply(priorState) {
  const lastSede = resolveLastSedeEntryFromState(priorState) || resolveSedeEntryFromState(priorState);
  if (isReferralOnlySedeEntry(lastSede)) {
    return buildReferralOnlySedeBookingReply(lastSede);
  }
  if (conversationAlreadySharedBookingLink(priorState)) {
    return 'Entiendo, me encantaría ayudarte con eso. No puedo agendar por vos desde acá, pero podés hacerlo con el link que ya te pasé. Si querés, te acompaño paso a paso.';
  }
  const urlFromState =
    priorState &&
    typeof priorState === 'object' &&
    wasBookingLinkSentRecently(priorState) &&
    typeof priorState.lastBookingLinkUrl === 'string'
      ? priorState.lastBookingLinkUrl
      : null;
  if (urlFromState) {
    return `Entiendo, me encantaría ayudarte con eso. No puedo agendar por vos desde acá, pero podés hacerlo en este link:\n${urlFromState}\nSi querés, te acompaño paso a paso.`;
  }
  if (lastSede) {
    const url = getAgendaUrl(lastSede);
    if (url) {
      return `Entiendo, me encantaría ayudarte con eso. No puedo agendar por vos desde acá, pero podés hacerlo en este link:\n${url}\nSi querés, te acompaño paso a paso.`;
    }
  }
  return 'Entiendo, me encantaría ayudarte con eso. No puedo agendar por vos desde acá, pero te paso el link y lo hacemos juntos.';
}

function messageAsksToRescheduleOrCancelBooking(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('cambiar el turno') ||
    normalized.includes('cambiar turno') ||
    normalized.includes('reprogram') ||
    normalized.includes('re-program') ||
    normalized.includes('posponer') ||
    normalized.includes('cancelar') ||
    normalized.includes('anular') ||
    normalized.includes('me equivoque') ||
    normalized.includes('me equivoqué') ||
    normalized.includes('equivocado') ||
    normalized.includes('equivocada')
  );
}

function messageSaysDoesNotKnowHealthInsurance(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return (
    normalized.includes('no se mi obra social') ||
    normalized.includes('no sé mi obra social') ||
    normalized.includes('no se cual es') ||
    normalized.includes('no sé cuál es') ||
    normalized.includes('no me acuerdo') ||
    normalized.includes('no recuerdo') ||
    normalized.includes('la obra social de mi mama') ||
    normalized.includes('la obra social de mi mamá') ||
    normalized.includes('es la de mi mama') ||
    normalized.includes('es la de mi mamá')
  );
}

function buildDoesNotKnowHealthInsuranceReply(priorState) {
  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (lastSede) {
    return `No pasa nada. Si te acordás, decime el nombre de la obra social/prepaga (sin números) y te digo si trabajamos en ${lastSede.displayName}. Si no, lo vemos en la consulta.`;
  }
  return 'No pasa nada. Si te acordás, decime el nombre de la obra social/prepaga (sin números). Si no, lo vemos en la consulta.';
}

function messageLooksLikeShortUnknownHealthInsurance(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    normalized === 'no se' ||
    normalized === 'no sé' ||
    normalized === 'ni idea' ||
    normalized === 'no tengo' ||
    normalized === 'no lo se' ||
    normalized === 'no lo sé'
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

function messageLooksLikeBareSedeOptionAnswer(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  return /^[12]$/.test(rawText.trim());
}

function conversationRecentlyAskedSedeSelection(priorState) {
  if (!priorState || typeof priorState !== 'object') return false;
  if (
    stateLooksLikeAwaitingSedeSelection(priorState) &&
    Date.now() - Number(priorState.awaitingSedeSelectionAtMs) <= SEDE_SELECTION_WINDOW_MS
  ) {
    return true;
  }
  if (
    Number.isFinite(Number(priorState.lastBotAskedSedeCityAtMs)) &&
    Date.now() - Number(priorState.lastBotAskedSedeCityAtMs) <= SEDE_SELECTION_WINDOW_MS
  ) {
    return true;
  }
  const lastBotReplyAtMs = Number(priorState.lastBotReplyAtMs);
  const lastBotReplyText =
    typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText.trim() : '';
  if (
    lastBotReplyText.length > 0 &&
    Number.isFinite(lastBotReplyAtMs) &&
    Date.now() - lastBotReplyAtMs <= SEDE_SELECTION_WINDOW_MS &&
    assistantReplyAsksForSedeCity(lastBotReplyText)
  ) {
    return true;
  }
  return false;
}

function preserveSessionStateWithoutTransientRouting(priorState) {
  if (!priorState || typeof priorState !== 'object') return {};
  return {
    greeted: Boolean(priorState.greeted),
    lastSeenAtMs: priorState.lastSeenAtMs,
    lastSedeEnvKey: priorState.lastSedeEnvKey,
    lastSedeDisplayName: priorState.lastSedeDisplayName,
    lastSedeOptionNumber: priorState.lastSedeOptionNumber,
    lastSedeAtMs: priorState.lastSedeAtMs,
    lastBotReplyAtMs: priorState.lastBotReplyAtMs,
    bookingLinkOptOutUntilMs: priorState.bookingLinkOptOutUntilMs,
    bookingLinkOfferAtMs: priorState.bookingLinkOfferAtMs,
    lastBookingLinkSentAtMs: priorState.lastBookingLinkSentAtMs,
    lastBookingLinkSedeEnvKey: priorState.lastBookingLinkSedeEnvKey,
    lastBookingLinkSedeDisplayName: priorState.lastBookingLinkSedeDisplayName,
    lastBookingLinkUrl: priorState.lastBookingLinkUrl,
    lastSensitiveDataWarningAtMs: priorState.lastSensitiveDataWarningAtMs,
    lastNonTextWriteItDownAtMs: priorState.lastNonTextWriteItDownAtMs,
  };
}

function shouldIgnoreStaleInboundMessage(priorState, messageTimestampSeconds) {
  const tsSeconds = Number(messageTimestampSeconds);
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return false;
  const inboundAtMs = tsSeconds * 1000;
  // Ignore very old messages (e.g., retries or delayed deliveries).
  if (Date.now() - inboundAtMs > INBOUND_MESSAGE_STALE_AFTER_MS) return true;
  if (!priorState || typeof priorState !== 'object') return false;
  const lastInboundAtMs = Number(priorState.lastInboundMessageAtMs);
  if (!Number.isFinite(lastInboundAtMs) || lastInboundAtMs <= 0) return false;
  // If this inbound message is older than the last one we processed, skip it.
  return inboundAtMs + 5000 < lastInboundAtMs;
}

function pruneRecentMessageIds(recentMessageIds) {
  if (!Array.isArray(recentMessageIds)) return [];
  const nowMs = Date.now();
  return recentMessageIds
    .filter((item) => item && typeof item === 'object')
    .filter((item) => typeof item.id === 'string' && item.id.length > 0)
    .filter((item) => Number.isFinite(Number(item.atMs)) && nowMs - Number(item.atMs) <= INBOUND_MESSAGE_DEDUPLICATION_TTL_MS)
    .slice(-50);
}

function shouldThrottleUserReply(priorState, rawText) {
  if (!priorState || typeof priorState !== 'object') return false;
  const lastBotReplyAtMs = Number(priorState.lastBotReplyAtMs);
  if (!Number.isFinite(lastBotReplyAtMs) || lastBotReplyAtMs <= 0) return false;
  if (Date.now() - lastBotReplyAtMs > USER_REPLY_COOLDOWN_MS) return false;
  // Never throttle emergencies.
  if (textMatchesMedicalEmergency(rawText)) return false;
  // Never throttle explicit link confirmation/rejection.
  if (messageConfirmsLinkSend(rawText) || messageClearlyRejectsLinkSend(rawText)) return false;
  // Never throttle explicit booking/link requests.
  if (messageExplicitlyRequestsBookingLink(rawText) || messageLooksLikeBookingIntent(rawText)) return false;
  // Throttle low-signal messages.
  if (messageLooksLikeFragment(rawText) || messageLooksLikeVagueAnswer(rawText) || messageIsGreeting(rawText)) return true;
  return false;
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

function messageLooksLikeSensitiveData(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  if (
    normalized.includes('dni') ||
    normalized.includes('cuil') ||
    normalized.includes('cuit') ||
    normalized.includes('nro afiliado') ||
    normalized.includes('numero de afiliado') ||
    normalized.includes('número de afiliado') ||
    normalized.includes('credencial') ||
    normalized.includes('foto de la credencial')
  ) {
    return true;
  }
  // Long digit sequences often indicate DNI / member id / phone etc.
  const digitSequences = normalized.match(/\d{7,}/g);
  return Array.isArray(digitSequences) && digitSequences.length > 0;
}

function messageAsksToTalkToSecretary(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const normalized = normalizeForMatch(rawText);
  return (
    normalized.includes('secretaria') ||
    normalized.includes('secretaría') ||
    normalized.includes('recepcion') ||
    normalized.includes('recepción') ||
    normalized.includes('administracion') ||
    normalized.includes('administración') ||
    normalized.includes('hablar con secretaria') ||
    normalized.includes('hablar con la secretaria') ||
    normalized.includes('pasame con secretaria') ||
    normalized.includes('pasame con la secretaria') ||
    normalized.includes('me comunicas con secretaria') ||
    normalized.includes('me comunicás con secretaria') ||
    normalized.includes('me comunicas con la recepcion') ||
    normalized.includes('me comunicás con la recepción')
  );
}

function buildSensitiveDataWarningReply(priorState) {
  const base =
    'Por favor no envíes datos sensibles por este chat (DNI, CUIL, número de afiliado o fotos de credenciales).';
  const lastSede = resolveLastSedeEntryFromState(priorState);
  if (lastSede) {
    return `${base} Si querés, decime solo tu obra social/prepaga (sin números) y te digo si trabajamos en ${lastSede.displayName}.`;
  }
  return `${base} Si querés, decime solo tu ciudad y tu obra social/prepaga (sin números).`;
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
 * Study preparation FAQ via OpenAI when the study type is ambiguous (typos, vague wording).
 * Returns null if OpenAI is not configured or the request fails.
 */
async function fetchOpenAiStudyPreparationReply(userMessage, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const modelName = getOpenAiModelName();
  const priorState = options && typeof options.priorState === 'object' ? options.priorState : null;
  const preparationContext = buildStudyPreparationOpenAiContext(priorState, userMessage);
  const systemPrompt = [
    'Sos la asistente del consultorio del Dr. Liber Acosta (alergista).',
    'El paciente pregunta qué preparación necesita ANTES de un estudio (no qué documentos ni estudios previos traer).',
    'Respondé en español argentino, texto plano, máximo 2 oraciones, sin markdown ni asteriscos.',
    'Solo usá estos datos confirmados:',
    '- Espirometría: no ayunas; no aerosoles/inhaladores de rescate ese día; DNI y credencial/orden si tiene obra social.',
    '- Test de alergia (prick): no ayunas; suspender antialérgicos 48 hs y corticoides 1 semana antes.',
    '- Test del parche: depende del protocolo; no inventes detalles.',
    'Si hay sede en contexto, podés mencionarla al cerrar.',
    'Si no queda claro el estudio, preguntá brevemente si es espirometría o test de alergia.',
    'No des diagnósticos ni inventes otra preparación.',
  ].join('\n');
  const userContent = buildOpenAiClassifierUserContent(userMessage, {
    profileDisplayName: options.profileDisplayName,
    conversationContext: preparationContext,
  });
  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.3,
        max_tokens: 160,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI study preparation error', response.status, errorText.slice(0, 300));
      return null;
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
  } catch (error) {
    console.error('OpenAI study preparation request failed', error);
    return null;
  }
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
  const priorState = options && typeof options.priorState === 'object' ? options.priorState : null;
  const userContent = priorState
    ? buildOpenAiClassifierUserContent(userMessage, {
        profileDisplayName,
        conversationContext: buildIntentRoutingOpenAiContext(priorState),
        lastAssistantMessage:
          typeof priorState.lastBotReplyText === 'string' ? priorState.lastBotReplyText : '',
      })
    : buildOpenAiUserContent(userMessage, profileDisplayName);

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
          const messageId = typeof msg.id === 'string' ? msg.id : null;
          const messageTimestampSeconds = typeof msg.timestamp === 'string' ? msg.timestamp : null;

          const existing = latestMessageBySender.get(from);
          // Build up to the last 4 text messages per sender in this webhook.
          const nextTextParts = Array.isArray(existing?.textParts) ? existing.textParts.slice(0) : [];
          const nextTextIds = Array.isArray(existing?.textIds) ? existing.textIds.slice(0) : [];
          const nextTextTimestamps = Array.isArray(existing?.textTimestamps) ? existing.textTimestamps.slice(0) : [];
          if (isText) {
            nextTextParts.push(msg.text.body.trim());
            if (messageId) nextTextIds.push(messageId);
            if (messageTimestampSeconds) nextTextTimestamps.push(messageTimestampSeconds);
            while (nextTextParts.length > 4) nextTextParts.shift();
            while (nextTextIds.length > 4) nextTextIds.shift();
            while (nextTextTimestamps.length > 4) nextTextTimestamps.shift();
          }

          // Prefer text if we have it; otherwise keep latest non-text.
          const nextIsText = nextTextParts.length > 0;
          if (existing && existing.isText === true && !nextIsText) continue;

          latestMessageBySender.set(from, {
            from,
            profileDisplayName,
            isText: nextIsText,
            messageType: nextIsText ? 'text' : msg.type,
            textParts: nextTextParts,
            textIds: nextTextIds,
            textTimestamps: nextTextTimestamps,
            bodyText: nextIsText ? nextTextParts.join(' ') : null,
          });
        }
      }
    }

    for (const item of latestMessageBySender.values()) {
      const { from, profileDisplayName, isText, messageType } = item;
      const priorState = await getConversationState(from);
      if (!isText) {
        const lastSensitiveWarnAtMs =
          priorState && typeof priorState === 'object' ? Number(priorState.lastSensitiveDataWarningAtMs) : NaN;
        const isSensitiveCooldown =
          Number.isFinite(lastSensitiveWarnAtMs) &&
          Date.now() - lastSensitiveWarnAtMs <= SENSITIVE_DATA_WARNING_COOLDOWN_MS;
        if (!isSensitiveCooldown && (messageType === 'image' || messageType === 'document')) {
          const warning = buildSensitiveDataWarningReply(priorState);
          const wrapped = buildAutoReplyWithGreetingIfNeeded(warning, profileDisplayName, priorState);
          await setConversationState(from, {
            ...(priorState || {}),
            ...(wrapped.nextStatePatch || {}),
            lastSeenAtMs: Date.now(),
            lastBotReplyAtMs: Date.now(),
            lastSensitiveDataWarningAtMs: Date.now(),
            lastNonTextMessageType: messageType,
          });
          await sendWhatsAppText(from, wrapped.messageText);
          continue;
        }
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
      const inboundTimestampSeconds =
        Array.isArray(item.textTimestamps) && item.textTimestamps.length > 0
          ? item.textTimestamps[item.textTimestamps.length - 1]
          : null;
      if (shouldIgnoreStaleInboundMessage(priorState, inboundTimestampSeconds)) {
        await setConversationState(from, { ...(priorState || {}), lastSeenAtMs: Date.now() });
        continue;
      }

      const priorRecentIds = pruneRecentMessageIds(priorState?.recentInboundMessageIds);
      const inboundIds = Array.isArray(item.textIds) ? item.textIds.filter(Boolean) : [];
      const hasDuplicateId =
        inboundIds.length > 0 && inboundIds.some((id) => priorRecentIds.some((entry) => entry.id === id));
      if (hasDuplicateId) {
        await setConversationState(from, { ...(priorState || {}), lastSeenAtMs: Date.now(), recentInboundMessageIds: priorRecentIds });
        continue;
      }

      const inboundAtMs = inboundTimestampSeconds ? Number(inboundTimestampSeconds) * 1000 : Date.now();
      const updatedRecentIds = pruneRecentMessageIds([
        ...priorRecentIds,
        ...inboundIds.map((id) => ({ id, atMs: inboundAtMs })),
      ]);

      if (shouldThrottleUserReply(priorState, bodyText)) {
        await setConversationState(from, {
          ...(priorState || {}),
          lastSeenAtMs: Date.now(),
          lastInboundMessageAtMs: inboundAtMs,
          recentInboundMessageIds: updatedRecentIds,
        });
        continue;
      }

          if (messageAsksToTalkToSecretary(bodyText)) {
            const preservedSessionState = mergeConversationStatePreservingGreeting(
              priorState,
              {},
              { bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS }
            );
            await setConversationState(from, {
              ...preservedSessionState,
              lastInboundMessageAtMs: inboundAtMs,
              recentInboundMessageIds: updatedRecentIds,
            });
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              DERIVATIVE_HANDOFF_PATIENT_MESSAGE,
              profileDisplayName,
              preservedSessionState
            );
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (messageAsksToRescheduleOrCancelBooking(bodyText)) {
            const preservedSessionState = mergeConversationStatePreservingGreeting(
              priorState,
              {},
              { bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS }
            );
            await setConversationState(from, {
              ...preservedSessionState,
              lastInboundMessageAtMs: inboundAtMs,
              recentInboundMessageIds: updatedRecentIds,
            });
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              DERIVATIVE_HANDOFF_PATIENT_MESSAGE,
              profileDisplayName,
              preservedSessionState
            );
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (messageSaysDoesNotKnowHealthInsurance(bodyText)) {
            const reply = buildDoesNotKnowHealthInsuranceReply(priorState);
            const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
            await setConversationState(from, {
              ...(priorState || {}),
              ...(wrapped.nextStatePatch || {}),
              lastInboundMessageAtMs: inboundAtMs,
              recentInboundMessageIds: updatedRecentIds,
              lastSeenAtMs: Date.now(),
              lastBotReplyAtMs: Date.now(),
            });
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (messageAsksAboutCardiologicoHealthInsuranceInCorrientes(bodyText, priorState)) {
            const preservedSessionState = mergeConversationStatePreservingGreeting(
              priorState,
              {},
              { bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS }
            );
            await setConversationState(from, preservedSessionState);
            const reply =
              'No cuento con esa información en este momento. Te derivo con alguien del equipo para confirmarlo.';
            const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, preservedSessionState);
            await sendWhatsAppText(from, wrapped.messageText);
            await sendWhatsAppText(from, DERIVATIVE_HANDOFF_PATIENT_MESSAGE, { skipDelay: true });
            continue;
          }

          if (messageLooksLikeSensitiveData(bodyText)) {
            const lastSensitiveWarnAtMs =
              priorState && typeof priorState === 'object' ? Number(priorState.lastSensitiveDataWarningAtMs) : NaN;
            const isInSensitiveCooldown =
              Number.isFinite(lastSensitiveWarnAtMs) &&
              Date.now() - lastSensitiveWarnAtMs <= SENSITIVE_DATA_WARNING_COOLDOWN_MS;
            if (!isInSensitiveCooldown) {
              const reply = buildSensitiveDataWarningReply(priorState);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
              await setConversationState(from, {
                ...(priorState || {}),
                ...(wrapped.nextStatePatch || {}),
                lastSeenAtMs: Date.now(),
                lastBotReplyAtMs: Date.now(),
                lastSensitiveDataWarningAtMs: Date.now(),
              });
              await sendWhatsAppText(from, wrapped.messageText);
            } else {
              await setConversationState(from, { ...(priorState || {}), lastSeenAtMs: Date.now() });
            }
            continue;
          }

          if (
            (stateLooksLikeAwaitingSedeSelection(priorState) || conversationRecentlyAskedSedeSelection(priorState)) &&
            (messageLooksLikeSedeSelectionConfusion(bodyText) ||
              messageLooksLikeVagueAnswer(bodyText) ||
              messageLooksLikePossibleSedeTypoAnswer(bodyText))
          ) {
            if (await tryHandleSedeSelectionAnswer(from, bodyText, priorState, profileDisplayName)) {
              continue;
            }
            await sendSedeSelectionHelpMessage(from, profileDisplayName, priorState);
            continue;
          }

          if (messageAsksHowBookingWorks(bodyText)) {
            const confirmedSede = resolveConfirmedSedeEntryForBookingFlow(bodyText, priorState);
            if (confirmedSede) {
              if (isReferralOnlySedeEntry(confirmedSede)) {
                await sendReferralOnlySedeBookingReply(from, confirmedSede, priorState, profileDisplayName);
                continue;
              }
              const reply = buildGenericBookingPolicyReplyForSede(confirmedSede, priorState);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(confirmedSede, 'after_booking_explanation'),
                  {
                    ...(wrapped.nextStatePatch || {}),
                    ...(buildLastSedeStatePatch(confirmedSede) || {}),
                    ...buildLastBotReplyStatePatch(wrapped.messageText),
                  }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            const mergedState = mergeConversationStatePreservingGreeting(
              priorState,
              priorState || {},
              buildFreshBookingWithoutSedeStatePatch(bodyText)
            );
            await setConversationState(from, mergedState);
            await sendAskSedeTwoStep(from, profileDisplayName, mergedState);
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

          if (await tryHandleAwaitingUrgencyClarification(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (textMatchesMedicalEmergency(bodyText)) {
            await sendMedicalEmergencyResponse(from, priorState, profileDisplayName);
            continue;
          }
          if (messageLooksLikeAmbiguousUrgency(bodyText)) {
            const urgencyWrapped = buildAutoReplyWithGreetingIfNeeded(
              AMBIGUOUS_URGENCY_CLARIFICATION_MESSAGE,
              profileDisplayName,
              priorState
            );
            await setConversationState(
              from,
              mergeConversationStatePreservingGreeting(
                priorState,
                priorState || {},
                {
                  ...(urgencyWrapped.nextStatePatch || {}),
                  ...buildAwaitingUrgencyClarificationStatePatch(),
                  ...buildLastBotReplyStatePatch(urgencyWrapped.messageText),
                  lastBotReplyAtMs: Date.now(),
                }
              )
            );
            await sendWhatsAppText(from, urgencyWrapped.messageText);
            continue;
          }
          if (await tryHandleSedeAddressInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (
            priorState &&
            typeof priorState === 'object' &&
            priorState.state === 'conversation_closed' &&
            Number.isFinite(Number(priorState.conversationClosedAtMs)) &&
            Date.now() - Number(priorState.conversationClosedAtMs) <= CONVERSATION_CLOSED_GRACE_WINDOW_MS &&
            (messageLooksLikeFarewell(bodyText) ||
              messageLooksLikeClosingAcknowledgement(bodyText) ||
              messageIsAcknowledgement(bodyText))
          ) {
            await setConversationState(
              from,
              mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
                lastSeenAtMs: Date.now(),
              })
            );
            continue;
          }
          if (messageLooksLikeFarewell(bodyText)) {
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              'Gracias a vos 😊 Cualquier consulta que te surja, escribime. Hasta pronto.',
              profileDisplayName,
              priorState
            );
            await setConversationState(
              from,
              mergeConversationStatePreservingGreeting(
                priorState,
                { state: 'conversation_closed' },
                { ...(wrapped.nextStatePatch || {}), conversationClosedAtMs: Date.now() }
              )
            );
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }
          if (messageConfirmsAlreadyBooked(bodyText, priorState)) {
            const bookedReply = buildAlreadyBookedReply(profileDisplayName);
            await setConversationState(
              from,
              mergeConversationStatePreservingGreeting(
                priorState,
                { state: 'conversation_closed' },
                {
                  greeted: true,
                  lastSeenAtMs: Date.now(),
                  lastBotReplyAtMs: Date.now(),
                  conversationClosedAtMs: Date.now(),
                  bookingLinkOptOutUntilMs: Date.now() + BOOKING_LINK_OFFER_OPTOUT_MS,
                }
              )
            );
            await sendWhatsAppText(from, bookedReply);
            continue;
          }
          if (stateLooksLikeAwaitingVirtualVisitConfirmation(priorState)) {
            const nowMs = Date.now();
            const isInWindow =
              nowMs - Number(priorState.awaitingVirtualVisitConfirmationAtMs) <= VIRTUAL_VISIT_CONFIRMATION_WINDOW_MS;
            if (isInWindow && messageConfirmsLinkSend(bodyText)) {
              const lastSede = resolveLastSedeEntryFromState(priorState);
              if (lastSede) {
                await deliverBookingLinkReply(from, lastSede, priorState, profileDisplayName, {
                  primaryPrefix: '¡Qué bueno!',
                  conversationStatePatch: {
                    ...(buildLastSedeStatePatch(lastSede) || {}),
                  },
                });
                continue;
              }
              const askSedeWrapped = buildAutoReplyWithGreetingIfNeeded(
                `¡Qué bueno! ¿Para qué sede querés agendar? ${ACTIVE_SEDE_OPTIONS_MESSAGE}`,
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  { state: 'awaiting_booking_link_sede' },
                  askSedeWrapped.nextStatePatch
                )
              );
              await sendWhatsAppText(from, askSedeWrapped.messageText);
              continue;
            }
            if (isInWindow && messageClearlyRejectsLinkSend(bodyText)) {
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                'No hay problema! ¿Puedo ayudarte en algo más?',
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(priorState, {}, wrapped.nextStatePatch)
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
          }
          if (stateLooksLikeAwaitingConsultationPriceHealthInsurance(priorState)) {
            const nowMs = Date.now();
            const isInWindow =
              nowMs - Number(priorState.awaitingConsultationPriceHealthInsuranceAtMs) <=
              CONSULTATION_PRICE_HEALTH_INSURANCE_WINDOW_MS;
            if (isInWindow) {
              const isPrivatePay = await resolvePrivatePayWithoutHealthInsuranceFromMessage(bodyText, {
                priorState,
                profileDisplayName,
              });
              const patientContext = await resolvePatientContextFromMessage(bodyText, priorState, {
                profileDisplayName,
              });
              const lastSede =
                patientContext.sedeEntry || resolveLastSedeEntryFromState(priorState);
              const healthInsuranceName = isPrivatePay ? null : patientContext.healthInsuranceName;
              if (isPrivatePay && lastSede) {
                await sendPrivatePriceQuestionReply(from, bodyText, priorState, profileDisplayName);
                continue;
              }
              if (lastSede && healthInsuranceName) {
                await sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName);
                continue;
              }
              if (lastSede && !healthInsuranceName) {
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskHealthInsuranceForConsultationPriceMessage(),
                  profileDisplayName,
                  priorState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    buildPendingConsultationPriceIntentStatePatch(),
                    {
                      ...(wrapped.nextStatePatch || {}),
                      ...(buildLastSedeStatePatch(lastSede) || {}),
                      ...buildLastBotReplyStatePatch(wrapped.messageText),
                    }
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
            }
          }
          if (stateLooksLikeAwaitingStudyPriceHealthInsurance(priorState)) {
            const nowMs = Date.now();
            const isInWindow =
              nowMs - Number(priorState.awaitingStudyPriceHealthInsuranceAtMs) <= STUDY_PRICE_HEALTH_INSURANCE_WINDOW_MS;
            if (isInWindow) {
              const isPrivatePay = await resolvePrivatePayWithoutHealthInsuranceFromMessage(bodyText, {
                priorState,
                profileDisplayName,
              });
              const patientContext = await resolvePatientContextFromMessage(bodyText, priorState, {
                profileDisplayName,
              });
              const sedeFromMessage = patientContext.sedeEntry;
              const extractedHealthInsuranceName = isPrivatePay ? null : patientContext.healthInsuranceName;
              const workingState = mergeConversationStatePreservingGreeting(
                priorState,
                priorState || {},
                patientContext.statePatch
              );
              if (isPrivatePay) {
                const lastSede = sedeFromMessage || resolveLastSedeEntryFromState(workingState);
                await sendStudyPriceInformationReply(
                  from,
                  'consulta particular',
                  mergeConversationStatePreservingGreeting(
                    workingState,
                    {
                      state: undefined,
                      awaitingStudyPriceHealthInsuranceAtMs: undefined,
                      healthInsuranceName: undefined,
                      lastHealthInsuranceName: undefined,
                    },
                    lastSede ? buildLastSedeStatePatch(lastSede) || {} : {}
                  ),
                  profileDisplayName
                );
                continue;
              }
              if (extractedHealthInsuranceName) {
                const enrichedState = mergeConversationStatePreservingGreeting(
                  workingState,
                  {},
                  {
                    healthInsuranceName: extractedHealthInsuranceName,
                    lastHealthInsuranceName: extractedHealthInsuranceName,
                    ...(patientContext.statePatch || {}),
                  }
                );
                const studiesReply = await buildStudiesInformationReply(enrichedState, bodyText, {
                  forcePriceFlow: !messageAsksWhetherDoctorPerformsStudy(bodyText),
                });
                await deliverStudiesInformationReply(
                  from,
                  studiesReply,
                  enrichedState,
                  profileDisplayName,
                  {
                    state: undefined,
                    awaitingStudyPriceHealthInsuranceAtMs: undefined,
                    healthInsuranceName: extractedHealthInsuranceName,
                    lastHealthInsuranceName: extractedHealthInsuranceName,
                    ...buildLastHealthInsuranceDiscussionStatePatch(),
                    lastStudyPriceContextAtMs: nowMs,
                    ...(patientContext.statePatch || {}),
                  },
                  { userMessage: bodyText, replyContext: 'studies_info' }
                );
                continue;
              }
              if (sedeFromMessage) {
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  'Antes de pasarte el valor, ¿qué obra social/prepaga tenés?',
                  profileDisplayName,
                  workingState
                );
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    workingState,
                    {
                      state: 'awaiting_study_price_health_insurance',
                      awaitingStudyPriceHealthInsuranceAtMs: nowMs,
                      lastStudyPriceContextAtMs: nowMs,
                    },
                    {
                      ...(wrapped.nextStatePatch || {}),
                      ...(buildLastSedeStatePatch(sedeFromMessage) || {}),
                    }
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
                continue;
              }
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                'Antes de pasarte el valor, ¿qué obra social/prepaga tenés?',
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  { state: 'awaiting_study_price_health_insurance', awaitingStudyPriceHealthInsuranceAtMs: nowMs },
                  wrapped.nextStatePatch
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
          }
          if (messageMentionsOutOfCoverageCity(bodyText)) {
            await sendOutOfCoverageCityReply(from, bodyText, priorState, profileDisplayName);
            continue;
          }
          if (
            messageAsksGenericConsultationPrice(bodyText) &&
            !messageExplicitlyAsksPrivateConsultationPrice(bodyText)
          ) {
            if (
              await tryHandleConsultationPriceWithPatientContext(from, bodyText, priorState, profileDisplayName, {
                rulesOnly: true,
              })
            ) {
              continue;
            }
          }
          if (await tryHandleReferralOnlySedeBookingInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleHealthInsuranceSedeFollowUpWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleClinicLocationAndHoursInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleSedeAddressInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleClinicInformationBundleInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleFamilyConsultationCostEstimateInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleCompleteCostTotalInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleRichPatientIntakeInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleSpirometryOnlyInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleCombinedConsultationAndStudyPriceInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleBookingLinkUsageDifficulty(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleDoctorTrustOrExperienceInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandlePriceObjectionFollowUpInquiry(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandlePatientDissatisfactionWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleBookingPersonalAssistanceRequest(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleStudyPriceAffirmativeFollowUp(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleAlreadySentBookingLinkFollowUp(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (
            await tryHandleConsultationPriceWithPatientContext(from, bodyText, priorState, profileDisplayName, {
              rulesOnly: isOpenAiCentralRoutingEnabled(),
            })
          ) {
            continue;
          }
          if (await tryHandlePrivatePriceWithPatientContext(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (
            await tryHandleHealthInsurancePlusWithOpenAi(from, bodyText, priorState, profileDisplayName, {
              rulesOnly: isOpenAiCentralRoutingEnabled(),
            })
          ) {
            continue;
          }
          if (await tryHandleSedeSelectionAnswer(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandlePreferredDayBooking(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleBookingLinkTroubleWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleWhereToBookQuestion(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleBookingWithPatientContext(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleAssistedBookingRequest(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleExplicitBookingLinkRequest(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryHandleAwaitingLinkConfirmation(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (await tryRouteOpenAiPrimaryIntent(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          const rulesOnlyFallback = isOpenAiCentralRoutingEnabled();
          if (
            await tryHandleAddressQuestionWithOpenAi(from, bodyText, priorState, profileDisplayName, {
              rulesOnly: rulesOnlyFallback,
            })
          ) {
            continue;
          }
          if (
            await tryHandleHealthInsurancePlusWithOpenAi(from, bodyText, priorState, profileDisplayName, {
              rulesOnly: rulesOnlyFallback,
            })
          ) {
            continue;
          }
          if (await tryHandleScheduleQuestionWithOpenAi(from, bodyText, priorState, profileDisplayName)) {
            continue;
          }
          if (shouldRouteToStudyPrice(bodyText, priorState)) {
            await sendStudyPriceInformationReply(from, bodyText, priorState, profileDisplayName);
            continue;
          }
          const hasRecentStudyPriceContext =
            priorState &&
            typeof priorState === 'object' &&
            typeof priorState.lastStudyType === 'string' &&
            priorState.lastStudyType.trim().length > 0 &&
            Number.isFinite(Number(priorState.lastStudyPriceContextAtMs)) &&
            Date.now() - Number(priorState.lastStudyPriceContextAtMs) <= STUDY_PRICE_HEALTH_INSURANCE_WINDOW_MS;
          const hasFreshStudyMentionInCurrentMessage = Boolean(getStudyTypeFromText(bodyText));
          if (
            hasRecentStudyPriceContext &&
            !messageLooksLikePrivatePriceQuestion(bodyText, priorState) &&
            (await tryResolveBookingIntentWithOpenAi(bodyText, { profileDisplayName, priorState }))
          ) {
            const lastSede =
              (await resolveSedeFromTextWithOpenAi(bodyText)) || resolveLastSedeEntryFromState(priorState);
            if (lastSede) {
              await deliverBookingLinkReply(from, lastSede, priorState, profileDisplayName, {
                conversationStatePatch: {
                  ...(buildLastSedeStatePatch(lastSede) || {}),
                },
              });
              continue;
            }
          }
          if (
            hasRecentStudyPriceContext &&
            messageLooksLikeHealthInsurancePlusQuestion(bodyText) &&
            !hasFreshStudyMentionInCurrentMessage
          ) {
            const extractedHealthInsuranceName =
              tryExtractHealthInsuranceName(bodyText) || (await tryResolveHealthInsuranceNameFromSheetsFuzzy(bodyText));
            if (extractedHealthInsuranceName) {
              const enrichedState = mergeConversationStatePreservingGreeting(
                priorState,
                priorState || {},
                {
                  healthInsuranceName: extractedHealthInsuranceName,
                  lastHealthInsuranceName: extractedHealthInsuranceName,
                }
              );
              const studiesReply = await buildStudiesInformationReply(enrichedState, bodyText, {
                forcePriceFlow: !messageAsksWhetherDoctorPerformsStudy(bodyText),
              });
              await deliverStudiesInformationReply(
                from,
                studiesReply,
                enrichedState,
                profileDisplayName,
                {
                  healthInsuranceName: extractedHealthInsuranceName,
                  lastHealthInsuranceName: extractedHealthInsuranceName,
                  lastStudyPriceContextAtMs: Date.now(),
                },
                { userMessage: bodyText, replyContext: 'studies_info' }
              );
              continue;
            }
          }
          if (hasRecentStudyPriceContext && shouldRouteToStudyPrice(bodyText, priorState)) {
            await sendStudyPriceInformationReply(from, bodyText, priorState, profileDisplayName);
            continue;
          }
          if (stateLooksLikeAwaitingSymptomDuration(priorState)) {
            const nowMs = Date.now();
            const isInWindow = nowMs - Number(priorState.symptomFirstAtMs) <= SYMPTOM_DURATION_WINDOW_MS;
            const shouldBypassSymptomDurationCapture =
              messageLooksLikeBookingIntent(bodyText) ||
              messageExplicitlyRequestsBookingLink(bodyText) ||
              messageLooksLikeBookingLinkTrouble(bodyText) ||
              messageLooksLikePrivatePriceQuestion(bodyText, priorState) ||
              messageLooksLikeAnyPriceQuestion(bodyText) ||
              messageLooksLikeHealthInsurancePlusQuestion(bodyText) ||
              messageMatchesStudiesTopic(bodyText) ||
              messageLooksLikeRealtimeAvailabilityQuestion(bodyText);
            if (isInWindow && !shouldBypassSymptomDurationCapture) {
              const detectedSede = findSedeFromText(bodyText) || resolveLastSedeEntryFromState(priorState);
              const empathyMessage =
                'Entiendo, llevar tiempo así es frustrante. Justamente para eso está el Dr. para evaluarte, diagnosticar bien y armar un plan que funcione.';
              const empathyWrapped = buildAutoReplyWithGreetingIfNeeded(empathyMessage, profileDisplayName, priorState);
              const nextState = mergeConversationStatePreservingGreeting(
                priorState,
                {},
                {
                  ...(empathyWrapped.nextStatePatch || {}),
                  ...(detectedSede ? buildLastSedeStatePatch(detectedSede) : {}),
                }
              );
              await setConversationState(from, nextState);
              await sendWhatsAppText(from, empathyWrapped.messageText);
              if (!detectedSede) {
                await sendWhatsAppText(
                  from,
                  `¿Desde qué ciudad te consultás? Atiende en ${ACTIVE_SEDE_CITIES_LIST_MESSAGE}.`,
                  { skipDelay: true }
                );
              }
              continue;
            }
          }
          if (messageLooksLikeChronicSymptomFrustration(bodyText)) {
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              'Lamento mucho que estés pasando por eso. ¿Desde hace cuánto tiempo tenés estos síntomas?',
              profileDisplayName,
              priorState
            );
            await setConversationState(
              from,
              mergeConversationStatePreservingGreeting(
                priorState,
                { state: 'awaiting_symptom_duration', symptomFirstAtMs: Date.now() },
                wrapped.nextStatePatch
              )
            );
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }
          if (messageUsesLegacySedeOptionInContext(bodyText, priorState)) {
            const legacyOptionWrapped = buildAutoReplyWithGreetingIfNeeded(
              LEGACY_SEDE_OPTION_RESPONSE_MESSAGE,
              profileDisplayName,
              priorState
            );
            if (legacyOptionWrapped.nextStatePatch) {
              await setConversationState(from, { ...(priorState || {}), ...legacyOptionWrapped.nextStatePatch });
            }
            await sendWhatsAppText(from, legacyOptionWrapped.messageText);
            continue;
          }

          if (await tryHandleAssistedBookingRequest(from, bodyText, priorState, profileDisplayName, { rulesOnly: true })) {
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
                'Anotado, te avisamos cuando haya disponibilidad.',
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
              const goodbye = url
                ? `Sin problema. Cuando quieras el link te queda acá:\n${url}\nHasta pronto 😊`
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
            const nextState = mergeConversationStatePreservingGreeting(
              priorState,
              {
                state: 'awaiting_waitlist_confirmation',
                waitlistFirstAtMs: nowMs,
              },
              { bookingLinkOptOutUntilMs: nowMs + BOOKING_LINK_OFFER_OPTOUT_MS }
            );
            await setConversationState(from, nextState);

            const message1 = 'La agenda se llena rápido, pero se van liberando turnos por cancelaciones.';
            const message2 = url
              ? `Te recomiendo volver a revisar el link en unos días:\n${url}`
              : 'Te recomiendo volver a revisar la agenda en unos días.';
            const message3 =
              '¿Querés que te avisemos cuando se libere algo?';

            const wrapped1 = buildAutoReplyWithGreetingIfNeeded(message1, profileDisplayName, priorState);
            await sendWhatsAppText(from, wrapped1.messageText);
            await sendWhatsAppText(from, message2, { skipDelay: true });
            await sendWhatsAppText(from, message3, { skipDelay: true });
            continue;
          }

          if (await tryHandleBookingLinkTroubleWithOpenAi(from, bodyText, priorState, profileDisplayName, { rulesOnly: true })) {
            continue;
          }

          if (messageLooksLikeRealtimeAvailabilityQuestion(bodyText)) {
            const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
            let lastSede = patientContext.sedeEntry || resolveConfirmedSedeEntryForBookingFlow(bodyText, priorState);
            if (lastSede && isReferralOnlySedeEntry(lastSede) && !findSedeFromText(bodyText)) {
              lastSede = null;
            }
            if (!lastSede) {
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                `Sí, hay turnos disponibles 😊 ¿En qué ciudad te gustaría atenderte? Atiende en ${ACTIVE_SEDE_CITIES_LIST_MESSAGE}.`,
                profileDisplayName,
                priorState
              );
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  { state: 'awaiting_sede_selection', awaitingSedeSelectionAtMs: Date.now() },
                  { ...(wrapped.nextStatePatch || {}), ...buildPendingBookingIntentStatePatch() }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            const mergedState = mergeConversationStatePreservingGreeting(
              priorState,
              priorState || {},
              patientContext.statePatch
            );
            if (stateHasRecentStudyPriceContext(mergedState)) {
              await sendBookingFlowReplyForSede(from, bodyText, mergedState, profileDisplayName, lastSede);
              continue;
            }
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              'Sí, hay turnos disponibles 😊 Si querés, te paso el link para que elijas día y horario.',
              profileDisplayName,
              mergedState
            );
            await setConversationState(
              from,
              mergeConversationStatePreservingGreeting(
                mergedState,
                buildAwaitingLinkConfirmationState(lastSede, 'after_realtime_availability_question'),
                {
                  ...(wrapped.nextStatePatch || {}),
                  ...(buildLastSedeStatePatch(lastSede) || {}),
                  ...buildLastBotReplyStatePatch(wrapped.messageText),
                }
              )
            );
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (messageIsSmallTalk(bodyText) && messageLooksLikeGreetingOnly(bodyText)) {
            if (shouldSkipGreetingOnlyReply(priorState, bodyText)) {
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
                  lastSeenAtMs: Date.now(),
                })
              );
              continue;
            }
            const lastBotReplyAtMs =
              priorState && typeof priorState === 'object' ? Number(priorState.lastBotReplyAtMs) : NaN;
            const isInCooldown =
              Number.isFinite(lastBotReplyAtMs) && Date.now() - lastBotReplyAtMs <= SMALL_TALK_COOLDOWN_MS;
            if (isInCooldown) {
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
                  lastSeenAtMs: Date.now(),
                })
              );
              continue;
            }
            const greetingOnlyReply = buildGreetingOnlyOpeningMessages(profileDisplayName, priorState);
            await setConversationState(
              from,
              mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
                greeted: true,
                lastSeenAtMs: Date.now(),
                lastBotReplyAtMs: Date.now(),
                // Fresh greeting should not keep pending study-pricing context from earlier turns.
                state: undefined,
                awaitingStudyTypeForPriceAtMs: undefined,
                awaitingStudyPriceHealthInsuranceAtMs: undefined,
                lastStudyType: undefined,
                lastStudyPriceContextAtMs: undefined,
                ...buildStaleBookingSessionResetPatch(),
              })
            );
            await sendWhatsAppText(from, greetingOnlyReply.firstMessage);
            if (greetingOnlyReply.secondMessage) {
              await sendWhatsAppText(from, greetingOnlyReply.secondMessage, { skipDelay: true });
            }
            continue;
          }

          if (
            !stateLooksLikeAwaitingLinkConfirmation(priorState) &&
            !messageIsGreeting(bodyText) &&
            !findSedeFromText(bodyText) &&
            !messageLooksLikeHealthInsurancePlusQuestion(bodyText) &&
            !messageLooksLikePrivatePriceQuestion(bodyText, priorState) &&
            !messageLooksLikeScheduleAvailabilityQuestion(bodyText) &&
            !messageExplicitlyRequestsBookingLink(bodyText) &&
            !textMatchesMedicalEmergency(bodyText) &&
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
            if (shouldSkipGreetingOnlyReply(priorState, bodyText)) {
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
                  lastSeenAtMs: Date.now(),
                })
              );
              continue;
            }
            const greetingOnlyReply = buildGreetingOnlyOpeningMessages(profileDisplayName, priorState);
            await setConversationState(
              from,
              mergeConversationStatePreservingGreeting(
                priorState,
                priorState || {},
                {
                  greeted: true,
                  lastSeenAtMs: Date.now(),
                  lastBotReplyAtMs: Date.now(),
                  // Fresh greeting should not keep pending study-pricing context from earlier turns.
                  state: undefined,
                  awaitingStudyTypeForPriceAtMs: undefined,
                  awaitingStudyPriceHealthInsuranceAtMs: undefined,
                  lastStudyType: undefined,
                  lastStudyPriceContextAtMs: undefined,
                  ...buildStaleBookingSessionResetPatch(),
                }
              )
            );
            await sendWhatsAppText(from, greetingOnlyReply.firstMessage);
            if (greetingOnlyReply.secondMessage) {
              await sendWhatsAppText(from, greetingOnlyReply.secondMessage, { skipDelay: true });
            }
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
              const reply = buildScheduleQuestionLinkMessage(sedeFromMessage);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  buildAwaitingLinkConfirmationState(sedeFromMessage, 'after_schedule_question'),
                  {
                    ...(wrapped.nextStatePatch || {}),
                    ...(buildLastSedeStatePatch(sedeFromMessage) || {}),
                    ...buildLastScheduleDiscussedStatePatch(),
                    ...buildPendingBookingIntentStatePatch(),
                    ...buildLastBotReplyStatePatch(wrapped.messageText),
                  }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
          }


          if (messageLooksLikeMultiIntentCandidate(bodyText)) {
            if (await tryHandleClinicInformationBundleInquiry(from, bodyText, priorState, profileDisplayName)) {
              continue;
            }
            const intents = (await decideIntentsWithOpenAi(bodyText)) || [];
            const hasHealthInsurance = intents.includes('HEALTH_INSURANCE');
            const hasPrivatePrice = intents.includes('PRIVATE_PRICE');

            const hasStudyPrice =
              intents.includes('STUDY_PRICE') || messageAsksStudyProcedurePrice(bodyText);
            if (hasHealthInsurance && hasPrivatePrice && hasStudyPrice) {
              if (await tryHandleCombinedConsultationAndStudyPriceInquiry(from, bodyText, priorState, profileDisplayName)) {
                continue;
              }
            }

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
              if (await shouldHandleAsAddressQuestion(bodyText, priorState, profileDisplayName)) {
                await sendAddressQuestionReply(from, bodyText, priorState, profileDisplayName);
                continue;
              }
              const lastSede = resolveLastSedeEntryFromState(priorState);
              if (lastSede) {
                if (stateHasRecentStudyPriceContext(priorState)) {
                  await deliverBookingLinkReply(from, lastSede, priorState, profileDisplayName, {
                    conversationStatePatch: {
                      ...(buildLastSedeStatePatch(lastSede) || {}),
                    },
                  });
                  continue;
                }
                const micro = buildMicroCommitmentMessageWithState(priorState, true);
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
                'Sí, el Dr. atiende niños, adolescentes y adultos.',
                profileDisplayName,
                priorState
              );
              if (wrapped.nextStatePatch) {
                await setConversationState(from, { ...(priorState || {}), ...wrapped.nextStatePatch });
              }
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            await sendAskSedeTwoStep(
              from,
              profileDisplayName,
              priorState,
              'Sí, el Dr. atiende niños, adolescentes y adultos.'
            );
            continue;
          }

          // Primary studies gate: doctor-performed studies (messageAsksAboutStudiesOrTests) plus patient FAQ.
          if (
            !messageLooksLikeSedeOnlyAnswer(bodyText) &&
            (messageAsksAboutStudyPrice(bodyText) ||
              messageAsksAboutStudiesOrTests(bodyText) ||
              messageMatchesStudiesPatientOnlyFaq(bodyText, priorState))
          ) {
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
            const detectedStudyType = getStudyTypeFromText(bodyText);
            const isAwaitingStudyTypeForPrice =
              stateLooksLikeAwaitingStudyTypeForPrice(priorState) &&
              Date.now() - Number(priorState.awaitingStudyTypeForPriceAtMs) <= STUDY_TYPE_FOR_PRICE_WINDOW_MS;
            const patientContext = await resolvePatientContextFromMessage(bodyText, priorState);
            const studiesReply = await buildStudiesInformationReply(priorState, bodyText, {
              forcePriceFlow:
                (isAwaitingStudyTypeForPrice && Boolean(detectedStudyType)) ||
                messageLooksLikeAnyPriceQuestion(bodyText),
              profileDisplayName,
            });
            const hasStudyTypeContext =
              Boolean(detectedStudyType) ||
              (priorState && typeof priorState === 'object' && typeof priorState.lastStudyType === 'string');
            const shouldAwaitStudyTypeForPrice =
              messageAsksAboutStudyPrice(bodyText) && !hasStudyTypeContext;
            const usePriorStudyPricingContext = shouldUsePriorStudyPricingContext(priorState, bodyText);
            const knownHealthInsuranceForStudyPrice = usePriorStudyPricingContext
              ? patientContext.healthInsuranceName ||
                resolveKnownHealthInsuranceNameForStudyPricing(priorState, bodyText)
              : patientContext.healthInsuranceName ||
                normalizeHealthInsuranceNameForStudyPricing(tryExtractHealthInsuranceName(bodyText));
            const shouldAwaitStudyPriceHealthInsurance =
              (messageAsksAboutStudyPrice(bodyText) || Boolean(detectedStudyType)) &&
              hasStudyTypeContext &&
              !knownHealthInsuranceForStudyPrice;
            const studiesStatePatch = {
              ...(patientContext.statePatch || {}),
              ...(detectedStudyType ? { lastStudyType: detectedStudyType } : {}),
              ...(messageAsksAboutStudyPrice(bodyText) || isAwaitingStudyTypeForPrice || Boolean(detectedStudyType)
                ? { lastStudyPriceContextAtMs: Date.now() }
                : {}),
              ...(shouldAwaitStudyTypeForPrice
                ? {
                    state: 'awaiting_study_type_for_price',
                    awaitingStudyTypeForPriceAtMs: Date.now(),
                  }
                : {}),
              ...(shouldAwaitStudyPriceHealthInsurance
                ? {
                    state: 'awaiting_study_price_health_insurance',
                    awaitingStudyPriceHealthInsuranceAtMs: Date.now(),
                  }
                : {}),
              ...(!shouldAwaitStudyTypeForPrice && isAwaitingStudyTypeForPrice
                ? {
                    state: undefined,
                    awaitingStudyTypeForPriceAtMs: undefined,
                  }
                : {}),
            };
            await deliverStudiesInformationReply(
              from,
              studiesReply,
              priorState,
              profileDisplayName,
              studiesStatePatch,
              { userMessage: bodyText, replyContext: 'studies_info' }
            );
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
            (messageAsksAboutStudyFasting(bodyText) &&
              !messageAsksAboutStudyPreparation(bodyText, priorState)) ||
            (messageAsksAboutStudyMedicationPreparation(bodyText) &&
              !messageAsksAboutStudyPreparation(bodyText, priorState)) ||
            (messageAsksAboutStudyDuration(bodyText) &&
              !messageAsksAboutStudyPreparation(bodyText, priorState)) ||
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
            else if (messageAsksAboutSedeAddressOrHowToArrive(bodyText)) {
              reply = buildSedeAddressReply(priorState, sedeMentionedInMessage);
            }
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
            const shouldAwaitVirtualVisitConfirmation = messageAsksAboutVirtualVisit(bodyText);
            const addressSedeForState =
              sedeMentionedInMessage ||
              (messageAsksAboutSedeAddressOrHowToArrive(bodyText)
                ? resolveLastSedeEntryFromState(priorState)
                : null);
            await setConversationState(
              from,
              mergeConversationStatePreservingGreeting(
                priorState,
                shouldAwaitVirtualVisitConfirmation
                  ? {
                      state: 'awaiting_virtual_visit_confirmation',
                      awaitingVirtualVisitConfirmationAtMs: Date.now(),
                    }
                  : priorState || {},
                {
                  ...(addressSedeForState ? buildLastSedeStatePatch(addressSedeForState) : null),
                  ...(messageAsksAboutSedeAddressOrHowToArrive(bodyText)
                    ? buildLastScheduleDiscussedStatePatch()
                    : null),
                  ...nextStatePatch,
                }
              )
            );
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

          if (messageAsksForPhoneCall(bodyText)) {
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
            const reply = buildPhoneCallRequestReply();
            const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
            if (wrapped.nextStatePatch) {
              await setConversationState(from, { ...(priorState || {}), ...wrapped.nextStatePatch });
            }
            await sendWhatsAppText(from, wrapped.messageText);
            continue;
          }

          if (messageAsksIfParticularIsAvailable(bodyText)) {
            if (messageLooksLikeHealthInsurancePlusQuestion(bodyText)) {
              const askOsWrapped = buildAutoReplyWithGreetingIfNeeded(
                buildAskHealthInsuranceNameMessage(bodyText),
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
            const lastSede = resolveLastSedeEntryFromState(priorState);
            if (lastSede) {
              const wrapped = buildAutoReplyWithGreetingIfNeeded(
                'Sí, atendemos particular.',
                profileDisplayName,
                priorState
              );
              if (wrapped.nextStatePatch) {
                await setConversationState(from, { ...(priorState || {}), ...wrapped.nextStatePatch });
              }
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
            await sendAskSedeTwoStep(from, profileDisplayName, priorState, 'Sí, atendemos particular.');
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
            const pendingReferralSede = resolveSedeEntryFromState(priorState);
            if (isReferralOnlySedeEntry(pendingReferralSede)) {
              await sendReferralOnlySedeBookingReply(from, pendingReferralSede, priorState, profileDisplayName);
              continue;
            }
            if (messageMentionsOutOfCoverageCity(bodyText)) {
              await sendOutOfCoverageCityReply(from, bodyText, priorState, profileDisplayName);
              continue;
            }
            if (messageLooksLikePrivatePriceQuestion(bodyText, priorState)) {
              const lastSede =
                findSedeFromText(bodyText) ||
                resolveSedeEntryFromState(priorState) ||
                resolveLastSedeEntryFromState(priorState);
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
            const sedeChange = await resolveSedeFromTextWithOpenAi(bodyText);
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
            // OpenAI first: interpret confirmations like "por favor quiero agendar" in natural language.
            const linkOfferDecision = await resolveBookingLinkOfferResponseWithOpenAi(bodyText, {
              profileDisplayName,
              priorState,
              conversationContext: buildIntentRoutingOpenAiContext(priorState),
              lastAssistantMessage: resolveLastAssistantMessageForLinkOffer(priorState),
            });
            // If they changed topic (e.g. asking price / obra social), do not trap them in a "sí/no" loop.
            const shouldBypassPendingLinkConfirmation =
              linkOfferDecision.action === 'ASK_CLARIFY' &&
              (messageLooksLikePrivatePriceQuestion(bodyText, priorState) ||
                messageLooksLikeAnyPriceQuestion(bodyText) ||
                messageLooksLikeHealthInsurancePlusQuestion(bodyText) ||
                messageMatchesStudiesTopic(bodyText) ||
                messageAsksAboutConditionTreatment(bodyText) ||
                messageLooksLikeChronicSymptomFrustration(bodyText));
            if (shouldBypassPendingLinkConfirmation) {
              if (
                stateHasRecentStudyPriceContext(priorState) &&
                messageLooksLikeAnyPriceQuestion(bodyText) &&
                !messageLooksLikePrivatePriceQuestion(bodyText, priorState)
              ) {
                const studiesReply = await buildStudiesInformationReply(priorState, bodyText, {
                  forcePriceFlow: !messageAsksWhetherDoctorPerformsStudy(bodyText),
                });
                await deliverStudiesInformationReply(
                  from,
                  studiesReply,
                  priorState,
                  profileDisplayName,
                  { lastStudyPriceContextAtMs: Date.now() },
                  { userMessage: bodyText, replyContext: 'studies_info' }
                );
                continue;
              }
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
            } else if (linkOfferDecision.action === 'SEND_LINK') {
              const entryFromState = resolveSedeEntryFromState(priorState);
              if (entryFromState) {
                await sendBookingLinkForSedeEntry(from, priorState, profileDisplayName, entryFromState);
                continue;
              }
            } else if (linkOfferDecision.action === 'DO_NOT_SEND') {
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
            } else if (messageConfirmsLinkSend(bodyText)) {
              const entryFromState = resolveSedeEntryFromState(priorState);
              if (entryFromState) {
                await sendBookingLinkForSedeEntry(from, priorState, profileDisplayName, entryFromState);
                continue;
              }
            } else {
              const repeatOffer = resolveLastAssistantMessageForLinkOffer(priorState);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(repeatOffer, profileDisplayName, priorState);
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(priorState, priorState || {}, {
                  ...(wrapped.nextStatePatch || {}),
                  ...buildLastBotReplyStatePatch(wrapped.messageText),
                })
              );
              await sendWhatsAppText(from, wrapped.messageText);
              continue;
            }
          }

          if (
            !stateLooksLikeAwaitingLinkConfirmation(priorState) &&
            wasBookingLinkSentRecently(priorState) &&
            messageIsAcknowledgement(bodyText) &&
            !messageExplicitlyRequestsBookingLink(bodyText) &&
            !messageAsksWhereOrHowToBook(bodyText) &&
            !messageAsksExplicitlyHowToBookTurn(bodyText)
          ) {
            const acknowledgementSede = resolveLastSedeEntryFromState(priorState);
            if (acknowledgementSede) {
              await deliverBookingLinkReminderReply(
                from,
                bodyText,
                priorState,
                profileDisplayName,
                acknowledgementSede
              );
              continue;
            }
          }

          if (
            !stateLooksLikeAwaitingLinkConfirmation(priorState) &&
            wasBookingLinkSentRecently(priorState) &&
            (messageConfirmsLinkSend(bodyText) ||
              messageLooksLikeAlreadySentLinkBookingFollowUp(bodyText, priorState))
          ) {
            const lastSede = resolveLastSedeEntryFromState(priorState);
            if (
              lastSede &&
              (messageLooksLikeAlreadySentLinkBookingFollowUp(bodyText, priorState) ||
                hasBookingLinkInStateForSede(priorState, lastSede))
            ) {
              await deliverBookingLinkReminderReply(from, bodyText, priorState, profileDisplayName, lastSede);
              continue;
            }
            if (messageExplicitlyRequestsBookingLink(bodyText) && lastSede) {
              await deliverBookingLinkReply(from, lastSede, priorState, profileDisplayName, {
                conversationStatePatch: {
                  ...(buildLastSedeStatePatch(lastSede) || {}),
                },
              });
              continue;
            }
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              `Perfecto. ¿Para qué sede querés el link? ${ACTIVE_SEDE_OPTIONS_MESSAGE}`,
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

          // Note: awaiting_link_confirmation is handled above (OpenAI-first + rules fallback).

          const isBareSedeOption = messageLooksLikeBareSedeOptionAnswer(bodyText);
          const canTreatBareSedeOptionAsSede =
            !isBareSedeOption ||
            conversationRecentlyAskedSedeSelection(priorState) ||
            (priorState &&
              typeof priorState === 'object' &&
              (priorState.state === 'awaiting_booking_link_sede' ||
                priorState.state === 'awaiting_health_insurance_city' ||
                priorState.state === 'awaiting_private_price_city' ||
                priorState.state === 'awaiting_schedule_sede'));

          if (messageLooksLikeSedeAddressInquiry(bodyText)) {
            if (await tryHandleSedeAddressInquiry(from, bodyText, priorState, profileDisplayName)) {
              continue;
            }
          }

          const sede =
            canTreatBareSedeOptionAsSede && !messageLooksLikeSedeAddressInquiry(bodyText)
              ? await resolveSedeFromTextWithOpenAi(bodyText)
              : null;
          if (sede) {
            const lastSedePatch = buildLastSedeStatePatch(sede);
            if (priorState && priorState.state === 'awaiting_booking_link_sede') {
              await clearConversationState(from);
              await deliverBookingLinkReply(from, sede, priorState, profileDisplayName);
              continue;
            }
            // If the user explicitly asks for the booking link and we already know the sede, send it directly.
            if (messageExplicitlyRequestsBookingLink(bodyText)) {
              await deliverBookingLinkReply(from, sede, priorState, profileDisplayName, {
                conversationStatePatch: {
                  ...(lastSedePatch || {}),
                },
              });
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
                buildAskHealthInsuranceNameMessage(bodyText),
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
            } else if (messageLooksLikePrivatePriceQuestion(bodyText, priorState)) {
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
              if (stateHasRecentStudyPriceContext(priorState)) {
                await deliverBookingLinkReply(from, sede, priorState, profileDisplayName, {
                  conversationStatePatch: {
                    ...(lastSedePatch || {}),
                  },
                });
                continue;
              }
              const micro = buildMicroCommitmentMessageWithState(priorState, true);
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
                  {
                    ...(wrapped.nextStatePatch || {}),
                    ...(lastSedePatch || {}),
                    ...buildLastScheduleDiscussedStatePatch(),
                    ...buildPendingBookingIntentStatePatch(),
                    ...buildLastBotReplyStatePatch(wrapped.messageText),
                  }
                )
              );
              await sendWhatsAppText(from, wrapped.messageText);
            } else if (messageAsksGenericConsultationPrice(bodyText)) {
              const healthInsuranceName =
                tryExtractHealthInsuranceName(bodyText) ||
                resolveActiveHealthInsuranceNameFromState(priorState) ||
                (await resolveHealthInsuranceNameFromMessage(bodyText, priorState, { profileDisplayName }));
              if (healthInsuranceName) {
                const rawReply = await buildConsultationPriceReplyForSedeAndHealthInsurance(
                  sede,
                  healthInsuranceName,
                  priorState
                );
                const focusedReply = await tryResolveFocusedPatientReplyWithOpenAi(rawReply, {
                  replyContext: 'consultation_price',
                  suppressBookingLinkOffer: true,
                  priorState,
                  userMessage: bodyText,
                  profileDisplayName,
                  conversationContext: buildIntentRoutingOpenAiContext(priorState),
                });
                const wrapped = buildAutoReplyWithGreetingIfNeeded(focusedReply.reply, profileDisplayName, priorState);
                await setConversationState(
                  from,
                  mergeConversationStatePreservingGreeting(
                    priorState,
                    {},
                    {
                      ...(wrapped.nextStatePatch || {}),
                      ...(lastSedePatch || {}),
                      healthInsuranceName,
                      lastHealthInsuranceName: healthInsuranceName,
                      ...buildLastHealthInsuranceDiscussionStatePatch(),
                      ...buildClearedPendingConsultationPriceIntentPatch(),
                      ...buildConsultationPriceAnsweredStatePatch(),
                      ...buildLastBotReplyStatePatch(wrapped.messageText),
                    }
                  )
                );
                await sendWhatsAppText(from, wrapped.messageText);
              } else {
                await sendConsultationPriceQuestionReply(from, bodyText, priorState, profileDisplayName);
              }
            } else {
              const reply = await buildReplyAfterSedeSelection(sede, priorState, bodyText);
              const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
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
            continue;
          } else {
            // If the user asks for the link but didn't specify the sede, ask sede first.
            if (messageExplicitlyRequestsBookingLink(bodyText)) {
              const lastSede = resolveLastSedeEntryFromState(priorState);
              // Explicit link request: if we already know the last sede, send the link directly.
              if (lastSede) {
                await deliverBookingLinkReply(from, lastSede, priorState, profileDisplayName, {
                  conversationStatePatch: {
                    ...(buildLastSedeStatePatch(lastSede) || {}),
                  },
                });
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
            if (shouldRouteToStudyPrice(bodyText, priorState)) {
              await sendStudyPriceInformationReply(from, bodyText, priorState, profileDisplayName);
              continue;
            }
            // Pricing questions must win over "turno/agendar" keyword matches.
            if (messageLooksLikePrivatePriceQuestion(bodyText, priorState)) {
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
            const wantsToBook = await tryResolveBookingIntentWithOpenAi(bodyText, {
              profileDisplayName,
              priorState,
            });
            if (wantsToBook) {
              const lastSede =
                (await resolveSedeFromTextWithOpenAi(bodyText)) || resolveLastSedeEntryFromState(priorState);
              if (lastSede) {
                if (stateHasRecentStudyPriceContext(priorState)) {
                  await deliverBookingLinkReply(from, lastSede, priorState, profileDisplayName, {
                    conversationStatePatch: {
                      ...(buildLastSedeStatePatch(lastSede) || {}),
                    },
                  });
                  continue;
                }
                const micro = buildMicroCommitmentMessageWithState(priorState, true);
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
              await setConversationState(
                from,
                mergeConversationStatePreservingGreeting(
                  priorState,
                  priorState || {},
                  buildPendingBookingIntentStatePatch()
                )
              );
              await sendAskSedeTwoStep(from, profileDisplayName, {
                ...(priorState || {}),
                ...buildPendingBookingIntentStatePatch(),
              });
              continue;
            }
            if (priorState && priorState.state === 'awaiting_health_insurance_name') {
              if (messageIsAcknowledgement(bodyText) || messageConfirmsLinkSend(bodyText)) {
                const wrapped = buildAutoReplyWithGreetingIfNeeded(
                  buildAskHealthInsuranceNameMessage(bodyText),
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
              if (
                messageLooksLikeShortUnknownHealthInsurance(bodyText) ||
                messageLooksLikeDoesNotKnowHealthInsurance(bodyText)
              ) {
                const lastSede = resolveLastSedeEntryFromState(priorState);
                if (lastSede) {
                  const privatePriceReply = await buildPrivatePriceReply(lastSede);
                  const reply = `No pasa nada. Si no la recordás, también podés atenderte particular. ${privatePriceReply} Si después te acordás la obra social, te digo si tiene plus.`;
                  const wrapped = buildAutoReplyWithGreetingIfNeeded(reply, profileDisplayName, priorState);
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
                  `No pasa nada. Si no la recordás, también podés atenderte particular. ¿Desde qué ciudad te consultás? Atiende en ${ACTIVE_SEDE_CITIES_LIST_MESSAGE}.`,
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
                  buildAskHealthInsuranceNameMessage(bodyText),
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
              const askAgainText = buildAskHealthInsuranceNameMessage(bodyText);
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
                buildAskHealthInsuranceNameMessage(bodyText),
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
            if (await tryHandleBookingLinkUsageDifficulty(from, bodyText, priorState, profileDisplayName)) {
              continue;
            }
            if (await tryHandleBookingPersonalAssistanceRequest(from, bodyText, priorState, profileDisplayName)) {
              continue;
            }
            if (await tryHandleSedeSelectionAnswer(from, bodyText, priorState, profileDisplayName)) {
              continue;
            }
            if (await tryHandlePreferredDayBooking(from, bodyText, priorState, profileDisplayName)) {
              continue;
            }
            if (await tryHandleSedeAddressInquiry(from, bodyText, priorState, profileDisplayName)) {
              continue;
            }
            if (
              messageLooksLikeBookingIntent(bodyText) ||
              (extractWeekdayNameFromText(bodyText) && messageIncludesSpecificAppointmentTime(bodyText))
            ) {
              if (await tryHandleBookingWithPatientContext(from, bodyText, priorState, profileDisplayName)) {
                continue;
              }
            }
            if (await tryHandleSmartOpenAiFallback(from, bodyText, priorState, profileDisplayName)) {
              continue;
            }
            const wrapped = buildAutoReplyWithGreetingIfNeeded(
              'Contame en qué te puedo ayudar.',
              profileDisplayName,
              priorState
            );
            if (wrapped.nextStatePatch) {
              await setConversationState(from, mergeConversationStatePreservingGreeting(priorState, priorState || {}, wrapped.nextStatePatch));
            }
            await sendWhatsAppText(from, wrapped.messageText);
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
