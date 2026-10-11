export function formatSeatPrice(cents: number): string {
  const value = cents / 100;
  return `$${value.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Etiqueta para viajes cuyo `trips.seat_price` sigue en NULL: no existe un
 * importe real que mostrar y está prohibido inventar uno (el backend rechaza
 * la reserva con `TRIP_PRICE_MISSING`).
 */
export const TRIP_PRICE_PENDING_LABEL = 'Precio por definir';
