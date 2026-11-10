// ── Filtros del catálogo de viajes (compartidos) ───────────────────────────
//
// Lógica pura de filtrado del catálogo, extraída de `app/trips/page.tsx` para
// reutilizarla en el catálogo del perfil de agencia SIN duplicarla. El
// catálogo general `/trips` conserva exactamente el mismo comportamiento:
// aquí solo se movieron las funciones, sin cambiar su semántica.

import type { PublicTrip } from '@/lib/api';
import type {
  FranjaHoraria,
  FiltrosViaje,
} from '@/components/trips/FiltrosLateral';
import { BUSINESS_TIMEZONE } from '@/lib/timezone';

/** Franja horario de salida en la zona de negocio (America/Caracas). */
export function franjaDe(iso: string): FranjaHoraria {
  const hora = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: BUSINESS_TIMEZONE,
      hour: 'numeric',
      hour12: false,
    }).format(new Date(iso)),
  ) % 24;
  if (hora >= 12 && hora < 18) return 'afternoon';
  if (hora >= 18) return 'night';
  return 'morning';
}

/**
 * Filtros laterales (horario, vehículo, agencia, precio). Listas vacías =
 * sin filtro; los viajes sin precio publicado nunca se descartan por precio.
 */
export function viajePasaFiltros(trip: PublicTrip, f: FiltrosViaje): boolean {
  if (f.horarios.length > 0 && !f.horarios.includes(franjaDe(trip.departure_time))) {
    return false;
  }
  if (f.vehiculos.length > 0 && !f.vehiculos.includes(trip.vehicle_type)) {
    return false;
  }
  if (f.precioMax !== null && trip.seat_price !== null && trip.seat_price > f.precioMax) {
    return false;
  }
  if (f.agencias.length > 0) {
    const nombres = (trip.agencies ?? []).map((agency) => agency.name);
    if (!nombres.some((nombre) => f.agencias.includes(nombre))) return false;
  }
  return true;
}

/** Precio máximo por asiento (centavos) de un lote; `null` si no hay precios. */
export function precioMaximoDe(trips: PublicTrip[]): number | null {
  const precios = trips
    .map((trip) => trip.seat_price)
    .filter((price): price is number => typeof price === 'number');
  return precios.length > 0 ? Math.max(...precios) : null;
}
