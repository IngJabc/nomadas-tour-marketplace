'use client';

import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import type { PublicSeatStatus } from '@/lib/api';

export type CleanupFn = () => void;

export type SeatEventType = 'INSERT' | 'UPDATE' | 'DELETE';

/** Fila cruda de `seats` tal como la entrega Supabase Realtime. */
export interface RealtimeSeatRow {
  id: string;
  trip_id?: string | null;
  seat_code: string;
  status: PublicSeatStatus;
  locked_by?: string | null;
  locked_at?: string | null;
  lock_expires_at?: string | null;
}

export interface SeatUpdatePayload {
  eventType: SeatEventType;
  seat: RealtimeSeatRow;
}

export interface TripUpdatePayload {
  eventType: SeatEventType;
  trip: { id: string; status?: string; [key: string]: unknown };
}

/**
 * Suscribirse a cambios en `seats` para uno o más viajes.
 * `seats` tiene RLS `seats_public_read` (SELECT USING true) y pertenece a la
 * publicación `supabase_realtime`, así que cualquier visitante autenticado o
 * anónimo recibe los eventos.
 */
export function subscribeToTripSeats(
  tripIds: string[],
  onSeatUpdate: (payload: SeatUpdatePayload) => void,
): CleanupFn {
  if (!tripIds.length) return () => {};
  const supabase = createClient();

  const filter = `trip_id=in.(${tripIds.join(',')})`;
  const channel = supabase
    .channel(`seats:${filter}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'seats', filter },
      (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
        if (payload.eventType === 'DELETE') {
          const old = payload.old as Record<string, unknown> | null;
          if (old?.id && old.seat_code) {
            onSeatUpdate({
              eventType: 'DELETE',
              seat: old as unknown as RealtimeSeatRow,
            });
          }
          return;
        }
        const row = payload.new as Record<string, unknown> | null;
        if (row?.id && row.seat_code) {
          onSeatUpdate({
            eventType: payload.eventType as SeatEventType,
            seat: row as unknown as RealtimeSeatRow,
          });
        }
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Suscribirse a cambios en `trips` (cancelación/completado del viaje en vivo).
 * `trips` tiene RLS `trips_public_read` y está en `supabase_realtime`.
 */
export function subscribeToTrips(
  tripIds: string[],
  onTripUpdate: (payload: TripUpdatePayload) => void,
): CleanupFn {
  if (!tripIds.length) return () => {};
  const supabase = createClient();

  const filter = `id=in.(${tripIds.join(',')})`;
  const channel = supabase
    .channel(`trips:${filter}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'trips', filter },
      (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
        const row = (payload.eventType === 'DELETE'
          ? payload.old
          : payload.new) as Record<string, unknown> | null;
        if (row?.id) {
          onTripUpdate({
            eventType: payload.eventType as SeatEventType,
            trip: row as unknown as TripUpdatePayload['trip'],
          });
        }
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ── RT-04A: Realtime de compras y catálogo ───────────────────────────────────

/**
 * Callback de RT-04A: sin payload a propósito. El backend es la autoridad
 * del estado derivado (estado/mensaje/pago/reserva), así que ante CUALQUIER
 * evento el caller re-consulta la API correspondiente en lugar de interpretar
 * la fila cruda del canal.
 */
export type PurchaseChangeCallback = () => void;

type Rt04aClient = ReturnType<typeof createClient>;

/**
 * Crea un canal postgres_changes de solo-notificación: `onChange` se invoca
 * en cada evento (INSERT/UPDATE/DELETE) sin consumir el contenido.
 */
function subscribeToTableChanges(
  supabase: Rt04aClient,
  table: string,
  filter: string | null,
  onChange: PurchaseChangeCallback,
) {
  return supabase
    .channel(`rt04a:${table}:${filter ?? '*'}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        ...(filter ? { filter } : {}),
      },
      () => onChange(),
    )
    .subscribe();
}

function removeChannels(supabase: Rt04aClient, channels: ReturnType<Rt04aClient['channel']>[]) {
  for (const channel of channels) {
    supabase.removeChannel(channel);
  }
}

/**
 * Historial de compras del cliente autenticado (`/account/purchases`).
 *
 * Suscribe las tres tablas que alimentan el DTO del historial, SIEMPRE
 * filtrando por el propio cliente:
 * - `checkout_attempts` — estado de cada compra (093: policy
 *   `checkout_attempts_customer_read` + publicación).
 * - `reservations` — estado/pago/código de boleto de la reserva
 *   (policy `reservations_customer_read` 075; publicación 006/012).
 * - `payments` — estado del pago y `verified_at` (policy
 *   `payments_customer_read` 076; publicación recién en 093).
 *
 * Redundancia deliberada: verificación (087), flujo legacy (083/085),
 * rechazo (087/090), cancelación/expiración (087) y recálculos (088)
 * tocan distintas combinaciones de tablas; cualquier evento dispara la
 * re-consulta del caller. RLS limita la entrega a filas propias y
 * `customerId` vacío no crea canales.
 */
export function subscribeToPurchaseHistory(
  customerId: string,
  onChange: PurchaseChangeCallback,
): CleanupFn {
  if (!customerId) return () => {};
  const supabase = createClient();
  const filter = `customer_id=eq.${customerId}`;
  const channels = (
    ['checkout_attempts', 'reservations', 'payments'] as const
  ).map((table) => subscribeToTableChanges(supabase, table, filter, onChange));

  return () => {
    removeChannels(supabase, channels);
  };
}

/**
 * Boleto QR de UNA compra (`/account/purchases/[attemptId]/ticket`).
 *
 * - `checkout_attempts` filtrado por `id` + `customer_id`: la policy RLS
 *   de 093 garantiza además que un intento ajeno jamás entregue eventos
 *   aunque se pida su id.
 * - `reservations` y `payments` del propio cliente: la disponibilidad del
 *   boleto depende de la reserva nacida en verify (reserved + fully_paid +
 *   ticket_code), no solo del intento.
 *
 * El caller re-valida contra `GET /attempts/:id/ticket` (backend autoridad);
 * el evento solo dispara esa re-validación, nunca da por disponible un QR.
 */
export function subscribeToPurchaseTicket(
  customerId: string,
  attemptId: string,
  onChange: PurchaseChangeCallback,
): CleanupFn {
  if (!customerId || !attemptId) return () => {};
  const supabase = createClient();
  const customerFilter = `customer_id=eq.${customerId}`;
  const channels = [
    subscribeToTableChanges(
      supabase,
      'checkout_attempts',
      `id=eq.${attemptId}&${customerFilter}`,
      onChange,
    ),
    subscribeToTableChanges(supabase, 'reservations', customerFilter, onChange),
    subscribeToTableChanges(supabase, 'payments', customerFilter, onChange),
  ];

  return () => {
    removeChannels(supabase, channels);
  };
}

/**
 * Catálogo público `/trips`.
 *
 * - `trips` SIN filtro: `trips_public_read` (USING true) entrega cualquier
 *   viaje; así se reciben INSERT de viajes nuevos y UPDATE que lo sacan del
 *   catálogo (status active→cancelled con la fila nueva ya no activa NO
 *   superaría un filtro `status=eq.active`, por eso no se filtra).
 * - `trip_agencies` acotado a los viajes cargados (`ta_public_read`): alta/
 *   baja de agencias sobre los viajes visibles.
 * - `agencies` acotada a las agencias visibles. Limitación conocida:
 *   `agencies_public_read` solo permite filas activas, así que la
 *   desactivación de una agencia (fila nueva inactiva) puede no entregarse;
 *   su reactivación y sus ediciones sí. Cualquier otro evento del catálogo
 *   re-consulta la API y corrige la vista.
 *
 * La pantalla no muestra disponibilidad de asientos en vivo (solo la
 * capacidad estática del viaje), por eso NO se suscribe `seats` aquí: el
 * mapa de asientos vive en el wizard, que ya tiene su propia suscripción.
 */
export function subscribeToTripCatalog(
  tripIds: string[],
  agencyIds: string[],
  onChange: PurchaseChangeCallback,
): CleanupFn {
  const supabase = createClient();
  const channels = [subscribeToTableChanges(supabase, 'trips', null, onChange)];

  if (tripIds.length) {
    channels.push(
      subscribeToTableChanges(
        supabase,
        'trip_agencies',
        `trip_id=in.(${tripIds.join(',')})`,
        onChange,
      ),
    );
  }
  if (agencyIds.length) {
    channels.push(
      subscribeToTableChanges(
        supabase,
        'agencies',
        `id=in.(${agencyIds.join(',')})`,
        onChange,
      ),
    );
  }

  return () => {
    removeChannels(supabase, channels);
  };
}
