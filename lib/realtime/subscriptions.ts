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
