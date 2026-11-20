/**
 * MKT-007.4 — Enlace de WhatsApp derivado SOLO del teléfono publicado por
 * la agencia. Nunca se inventan números: si el teléfono no tiene una forma
 * válida, la función devuelve `null` y la UI omite el enlace.
 *
 * Transformaciones permitidas (solo formato, nunca valor):
 * - "04121234567"      -> "584121234567"  (móvil nacional -> código país)
 * - "+58 412 123 4567" -> "584121234567"  (formato internacional)
 * - "00584121234567"   -> "584121234567"  (prefijo 00)
 */
export function whatsappHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `58${digits.slice(1)}`;
  if (!/^[1-9]\d{10,14}$/.test(digits)) return null;
  return `https://wa.me/${digits}`;
}

// ── MKT-008 · Contactos públicos E.164 (agency_contacts, migración 091) ──────
//
// Los contactos de `agency_contacts` se almacenan en E.164 estricto
// ("+58412...") por CHECK de la migración 091. Aquí NUNCA se aplica la
// conversión venezolana 0… → 58…: un número internacional ya trae su
// código país y duplicarlo rompería el enlace.

const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Valida y normaliza un contacto E.164 (quita separadores, exige el "+").
 * Devuelve `null` si el número no es E.164 válido: nunca se inventan datos.
 */
export function normalizeE164Phone(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s.\-()]/g, '');
  if (!E164_RE.test(cleaned)) return null;
  return cleaned;
}

/**
 * Enlace wa.me para un contacto E.164. Usa el número tal cual (sin el "+");
 * jamás antepone "58" ni convierte un "0" inicial.
 */
export function contactWhatsAppHref(
  phone: string | null | undefined,
): string | null {
  const e164 = normalizeE164Phone(phone);
  if (!e164) return null;
  return `https://wa.me/${e164.slice(1)}`;
}

/** Enlace `tel:` para un contacto E.164, con el "+" intacto. */
export function contactTelHref(
  phone: string | null | undefined,
): string | null {
  const e164 = normalizeE164Phone(phone);
  if (!e164) return null;
  return `tel:${e164}`;
}

/** Copia el texto al portapapeles. Devuelve false si el navegador lo niega. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ── MKT-010.1 · Solicitud de pago del SALDO por WhatsApp ─────────────────────

/**
 * wa.me con mensaje pre-escrito (solo formato, nunca número inventado):
 * si el teléfono no es válido devuelve `null` y la UI omite el enlace.
 */
export function whatsappMessageHref(
  phone: string | null | undefined,
  message: string,
): string | null {
  const base = whatsappHref(phone);
  if (!base || !message.trim()) return null;
  return `${base}?text=${encodeURIComponent(message)}`;
}

export interface BalanceWhatsAppInput {
  /** Nombre de la agencia cuando existe (opcional en el saludo). */
  agencyName?: string | null;
  /** Ruta ya etiquetada, p. ej. "Caracas → Maracaibo". */
  routeLabel?: string | null;
  /** Fecha/salida ya formateada en la zona de negocio. */
  departureLabel?: string | null;
  /** Código de boleto/reserva cuando existe. */
  ticketCode?: string | null;
  /** Pago restante ya formateado (el dinero lo decide el servidor). */
  balanceAmount: string;
}

/**
 * Mensaje de solicitud del pago restante (segunda parte). Solo incluye datos
 * que el backend ya expuso para ESTA reserva: nunca se inventa un monto
 * ni un destinatario. `balanceAmount` llega formateado desde la UI con el
 * importe server-side; esta función solo compone texto.
 */
export function buildBalanceWhatsAppMessage(input: BalanceWhatsAppInput): string {
  const lines = [
    input.agencyName?.trim()
      ? `Hola, quiero completar el pago restante de mi reserva con ${input.agencyName.trim()}.`
      : 'Hola, quiero completar el pago restante de mi reserva.',
  ];
  const details: string[] = [];
  if (input.routeLabel?.trim()) details.push(`Ruta: ${input.routeLabel.trim()}`);
  if (input.departureLabel?.trim()) details.push(`Salida: ${input.departureLabel.trim()}`);
  if (input.ticketCode?.trim()) details.push(`Reserva: ${input.ticketCode.trim()}`);
  if (details.length > 0) lines.push('', ...details);
  lines.push('', `Pago restante: ${input.balanceAmount}`);
  return lines.join('\n');
}
