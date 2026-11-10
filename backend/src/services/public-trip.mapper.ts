import { env } from '../config/env.js';

// ── Mappers públicos compartidos ────────────────────────────────────────────
//
// El catálogo de viajes (`GET /api/public/trips`) y el directorio/perfil de
// agencias (`GET /api/public/agencies[...]`) publican el MISMO DTO de viaje.
// La lógica de mapeo vive AQUÍ una sola vez para no duplicarla: cualquier
// cambio de forma del viaje público se aplica en los dos endpoints a la vez.

/**
 * MKT-008: contacto público de agencia (tabla 091 agency_contacts). Solo
 * se publican contactos con is_public=true, is_active=true y
 * deleted_at IS NULL; el teléfono es E.164 por CHECK de la migración.
 */
export interface PublicAgencyContactDto {
  id: string;
  label: string;
  phone: string;
  channel: 'call' | 'whatsapp';
}

/** Fila cruda de `agency_contacts` con los cuatro campos publicables. */
export interface PublicAgencyContactRow {
  id: unknown;
  label: unknown;
  phone: unknown;
  channel: unknown;
}

/** Igual que la anterior más el `agency_id` usado para agrupar por agencia. */
export interface PublicAgencyContactWithAgencyRow extends PublicAgencyContactRow {
  agency_id: unknown;
}

/** Agencia activa resumida para el catálogo público (sin datos internos). */
export interface PublicTripAgencyRefDto {
  id: string;
  name: string;
}

/** Forma del viaje publicado en el catálogo (alineada con `PublicTrip`). */
export interface PublicTripListItemDto {
  id: string;
  departure_time: string;
  capacity: number;
  vehicle_type: string;
  status: string;
  seat_price: number | null;
  route: { origin: string; destination: string };
  lock_ttl_seconds: number;
  agencies: PublicTripAgencyRefDto[];
  available_seats: number;
}

/** `agency_contacts` → DTO público (sin agency_id ni campos internos). */
export function mapPublicAgencyContact(row: PublicAgencyContactRow): PublicAgencyContactDto {
  return {
    id: String(row.id),
    label: String(row.label),
    phone: String(row.phone),
    channel: row.channel === 'call' ? 'call' : 'whatsapp',
  };
}

/**
 * Fila de `trips` (con embeds `routes`, `trip_agencies.agencies` y `seats`)
 * → DTO público del catálogo.
 *
 * `row.trip_agencies` es el embed SIN `!inner` en el catálogo: un viaje sin
 * agencias se lista con la colección vacía, nunca cae del listado. El perfil
 * de agencia reutiliza el mismo mapper sobre la misma forma de fila.
 */
export function mapPublicTripRow(row: any): PublicTripListItemDto {
  // Embed izquierdo (sin !inner en el catálogo): un viaje sin agencias se
  // lista con la colección vacía, nunca se cae del catálogo. Un solo query,
  // sin N+1.
  const agencies = ((row.trip_agencies ?? []) as Array<any>)
    .map((link) => link.agencies)
    .filter((agency: any) => agency?.status === 'active')
    .map((agency: any) => ({ id: agency.id, name: agency.name ?? '' }))
    // Orden estable y determinista (sin depender de locale del runtime).
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Disponibilidad REAL: solo los asientos en estado 'available' (los
  // reservados, bloqueados, con lock o la guía no cuentan como libres).
  const availableSeats = ((row.seats ?? []) as Array<any>).filter(
    (seat: any) => seat?.status === 'available',
  ).length;

  return {
    id: row.id,
    departure_time: row.departure_time,
    capacity: row.capacity,
    vehicle_type: row.vehicle_type,
    status: row.status,
    seat_price: row.seat_price ?? null,
    route: row.routes ?? { origin: '', destination: '' },
    lock_ttl_seconds: env.LOCK_TTL_SECONDS,
    agencies,
    available_seats: availableSeats,
  };
}
