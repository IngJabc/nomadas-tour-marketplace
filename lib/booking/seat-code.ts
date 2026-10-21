/**
 * Orden natural de códigos de asiento.
 *
 * `A1, A4, A10` — nunca `A1, A10, A4` (el orden lexicográfico) y nunca en
 * el orden en que el cliente fue seleccionándolos. `numeric` compara los
 * dígitos como número; `sensitivity: 'base'` evita que mayúsculas
 * alteren el orden.
 */
export function compareSeatCodes(a: string, b: string): number {
  return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
}

/** Copia ordenada de códigos; jamás muta el arreglo recibido. */
export function sortSeatCodes(codes: string[]): string[] {
  return [...codes].sort(compareSeatCodes);
}
