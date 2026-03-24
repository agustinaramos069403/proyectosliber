export const WHATSAPP_NUMBER = '543795055437';
export const GOOGLE_REVIEWS_URL =
  'https://www.google.com/search?q=Liber+Acosta+Asma+Alergia';
export const WHATSAPP_MESSAGE_BASE =
  'Hola Dr. Liber, vi la información de su método Control 360° para Alergia y Asma. Me gustaría agendar una consulta';

export const SEDES = ['Corrientes', 'Resistencia', 'Sáenz Peña', 'Formosa'] as const;

export function getWhatsAppUrl(sede?: string): string {
  const message = sede
    ? `${WHATSAPP_MESSAGE_BASE} en ${sede}.`
    : `${WHATSAPP_MESSAGE_BASE}.`;
  const encodedMessage = encodeURIComponent(message);
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodedMessage}`;
}
