const whatsAppNumberFromEnvironment = import.meta.env.PUBLIC_WHATSAPP_NUMBER;

/**
 * wa.me expects a real phone in E.164 digits (no +). Max length is 15 digits.
 * Meta's WHATSAPP_PHONE_NUMBER_ID is a separate numeric ID — never paste it here.
 */
function normalizeWhatsAppNumberForWaMe(raw: string | undefined): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0) {
    return '';
  }
  const digitsOnly = /^\d+$/.test(trimmed);
  if (digitsOnly && trimmed.length > 15) {
    console.warn(
      'PUBLIC_WHATSAPP_NUMBER is invalid for wa.me (over 15 digits). You may have set Meta Phone Number ID by mistake — use the real WhatsApp number (e.g. 15556489769 for Meta test line). Using default clinic number.'
    );
    return '';
  }
  return trimmed;
}

const normalizedWhatsAppNumber = normalizeWhatsAppNumberForWaMe(whatsAppNumberFromEnvironment);

export const WHATSAPP_NUMBER =
  normalizedWhatsAppNumber.length > 0 ? normalizedWhatsAppNumber : '543795055437';
export const GOOGLE_REVIEWS_URL =
  'https://www.google.com/search?q=Liber+Acosta+Asma+Alergia';

export const SEDES = ['Corrientes', 'Resistencia', 'Sáenz Peña', 'Formosa'] as const;

export function buildWhatsAppBookingMessage(sedeDisplayName: string): string {
  return `Hola Dr. Liber, vi la información del Sistema 360 y me gustaría agendar una consulta en la sede de ${sedeDisplayName}.`;
}

export function getWhatsAppUrl(sede: string): string {
  const encodedMessage = encodeURIComponent(buildWhatsAppBookingMessage(sede));
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodedMessage}`;
}
