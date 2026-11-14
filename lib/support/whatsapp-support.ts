import { whatsappHref } from '@/lib/booking/whatsapp';

/**
 * SUP-001 + SUP-003 — Número de soporte configurable y mensajes
 * predefinidos de WhatsApp.
 *
 * SUP-001: el número NUNCA va hardcodeado en componentes. Vive en la env
 * var pública `NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER` (misma convención
 * `NEXT_PUBLIC_*` que el resto del frontend: NEXT_PUBLIC_API_URL,
 * NEXT_PUBLIC_SUPABASE_URL, …). Si la variable no está definida —o su
 * valor no forma un teléfono válido— las funciones de enlace devuelven
 * `null` y la UI omite el punto de entrada: nunca se pinta un enlace
 * roto.
 *
 * SUP-003: `buildSupportMessage` redacta el mensaje según el contexto
 * (general, reservas, pagos, agencias, sugerencias) y solo agrega
 * identificadores (boleto / reserva / compra) cuando la pantalla los
 * tiene y son relevantes. `supportWhatsAppHref` arma el enlace
 * `https://wa.me/<número>?text=<mensaje>` con `encodeURIComponent`.
 *
 * Alcance: esto solo ABRRE WhatsApp con un mensaje precargado; lo envía
 * el usuario. No hay API de WhatsApp, ni bot, ni backend de envíos.
 */

/** Nombre de la env var (exportado para documentación y tests). */
export const SUPPORT_NUMBER_ENV = 'NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER';

export type SupportMessageCategory =
  | 'general'
  | 'reservation'
  | 'payment'
  | 'agency'
  | 'suggestion';

export interface SupportMessageIdentifiers {
  /** CHAR(8) del boleto (`ticket_code`) — solo si la pantalla lo tiene. */
  ticketCode?: string | null;
  /** UUID de la reserva — solo si la pantalla lo tiene. */
  reservationId?: string | null;
  /** UUID del intento de compra (checkout attempt). */
  purchaseId?: string | null;
}

const BASE_MESSAGES: Record<SupportMessageCategory, string> = {
  general: 'Hola, necesito ayuda con el Nómadas Marketplace.',
  reservation: 'Hola, necesito ayuda con una reserva en el Nómadas Marketplace.',
  payment: 'Hola, necesito ayuda con un pago en el Nómadas Marketplace.',
  agency: 'Hola, quiero consultar sobre una agencia en el Nómadas Marketplace.',
  suggestion: 'Hola, quiero enviar una sugerencia sobre el Nómadas Marketplace.',
};

/**
 * Número de soporte leído de la env var (SUP-001). Devuelve `null` si no
 * está definida o viene vacío: sin número no hay punto de entrada.
 */
export function supportWhatsAppNumber(): string | null {
  // Lectura estática: Next.js inyecta `process.env.NEXT_PUBLIC_*` en el
  // bundle del cliente con acceso por clave literal (patrón de lib/api.ts).
  const raw = process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/** `https://wa.me/<dígitos>` del número de soporte, o `null` si es inválido. */
export function supportWhatsAppBaseHref(): string | null {
  return whatsappHref(supportWhatsAppNumber());
}

/**
 * Mensaje precargado para la categoría actual (SUP-003). Los
 * identificadores se agregan como líneas finales SOLO cuando son
 * relevantes para la categoría (reserva/pago) y traen valor: nunca líneas
 * vacías, nunca "Reserva: undefined", nunca un boleto colgando de una
 * consulta general.
 */
const IDENTIFIER_CATEGORIES: ReadonlySet<SupportMessageCategory> = new Set([
  'reservation',
  'payment',
]);

export function buildSupportMessage(
  category: SupportMessageCategory,
  identifiers?: SupportMessageIdentifiers | null,
): string {
  const lines = [BASE_MESSAGES[category]];

  if (IDENTIFIER_CATEGORIES.has(category)) {
    const ticketCode = identifiers?.ticketCode?.trim();
    if (ticketCode) lines.push(`Boleto: ${ticketCode}`);

    const reservationId = identifiers?.reservationId?.trim();
    if (reservationId) lines.push(`Reserva: ${reservationId}`);

    const purchaseId = identifiers?.purchaseId?.trim();
    if (purchaseId) lines.push(`Compra: ${purchaseId}`);
  }

  return lines.join('\n');
}

/**
 * Enlace `wa.me` completo con el mensaje URL-encodeado.
 * Devuelve `null` si el número no está configurado o no valida (SUP-001).
 */
export function supportWhatsAppHref(
  category: SupportMessageCategory = 'general',
  identifiers?: SupportMessageIdentifiers | null,
): string | null {
  const base = supportWhatsAppBaseHref();
  if (!base) return null;
  const message = buildSupportMessage(category, identifiers);
  return `${base}?text=${encodeURIComponent(message)}`;
}

/**
 * Categoría por defecto según la ruta actual (SUP-003): el botón flotante
 * se vuelve contextual sin tocar cada pantalla. Una pantalla puede
 * sobreescribirla (y aportar identificadores) con `useSupportMessage`.
 */
export function supportMessageCategoryFromPath(
  pathname: string | null | undefined,
): SupportMessageCategory {
  const path = pathname ?? '';
  // Pago/reintento de una compra concreta (ruta .../payment).
  if (/\/payment$/.test(path)) return 'payment';
  // Historial, boleto y detalle de compras → contexto de reserva.
  if (path === '/account/purchases' || path.startsWith('/account/purchases/')) {
    return 'reservation';
  }
  // Wizard de reserva y detalle de reservas.
  if (path === '/reservations' || path.startsWith('/reservations/')) {
    return 'reservation';
  }
  // Directorio y detalle de agencias → consulta sobre la agencia.
  if (path === '/agencies' || path.startsWith('/agencies/')) {
    return 'agency';
  }
  // Landing, explorar, ayuda, cuenta, etc. → consulta general.
  return 'general';
}
