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
