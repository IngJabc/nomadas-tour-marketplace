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

/** Copia el texto al portapapeles. Devuelve false si el navegador lo niega. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
