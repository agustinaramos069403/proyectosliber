const whatsAppNumberFromEnvironment = import.meta.env.PUBLIC_WHATSAPP_NUMBER;

export const WHATSAPP_NUMBER =
  typeof whatsAppNumberFromEnvironment === 'string' &&
  whatsAppNumberFromEnvironment.trim().length > 0
    ? whatsAppNumberFromEnvironment.trim()
    : '543795055437';
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
