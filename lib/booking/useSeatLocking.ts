'use client';

import { useEffect, useRef } from 'react';
import {
  subscribeToTripSeats,
  subscribeToTrips,
  type RealtimeSeatRow,
  type SeatEventType,
} from '@/lib/realtime/subscriptions';

export interface UseSeatLockingOptions {
  /** Viaje activo; sin suscripción cuando es null (pantalla no lista aún). */
  tripId: string | null;
  /** Ids de los asientos que el usuario tiene bloqueados ahora mismo. */
  mySeatIds?: string[];
  /** Id del usuario; permite distinguir un lock robado de un lock propio. */
  userId?: string | null;
  /** Cambio de estado de un asiento del viaje (mapa + disponibilidad). */
  onSeatEvent?: (seat: RealtimeSeatRow, eventType: SeatEventType) => void;
  /** Un asiento propio dejó de estar bloqueado por mí (expiró o lo tomaron). */
  onSeatLost?: (seat: RealtimeSeatRow) => void;
  onTripCancelled?: () => void;
  onTripCompleted?: () => void;
  /** Refetch completo del viaje, con debounce, para curar eventos perdidos. */
  onRefresh?: () => void;
}

const REFRESH_DEBOUNCE_MS = 500;

/**
 * Un asiento sigue en posesión del usuario solo si está `locked` y (cuando se
 * conoce el dueño) `locked_by` es el usuario. Sin `userId` o sin `locked_by`
 * no se puede verificar → se asume propio para no deselectar de más.
 */
function stillHeldByMe(
  seat: RealtimeSeatRow,
  userId: string | null | undefined,
): boolean {
  if (seat.status !== 'locked') return false;
  if (userId && seat.locked_by) return seat.locked_by === userId;
  return true;
}

/**
 * Realtime de un viaje (estilo wizard de `nomadas-tour`): mantiene el mapa de
 * asientos al día, avisa cuando un asiento propio se pierde y detecta
 * viajes cancelados/completados mientras el usuario reserva.
 */
export function useSeatLocking(options: UseSeatLockingOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const tripId = options.tripId;

  useEffect(() => {
    if (!tripId) return;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (!optionsRef.current.onRefresh) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        optionsRef.current.onRefresh?.();
      }, REFRESH_DEBOUNCE_MS);
    };

    const handleSeatUpdate = (payload: {
      eventType: SeatEventType;
      seat: RealtimeSeatRow;
    }) => {
      const seat = payload.seat;
      if (seat.trip_id && seat.trip_id !== tripId) return;

      const current = optionsRef.current;
      current.onSeatEvent?.(seat, payload.eventType);

      const isMine = current.mySeatIds?.includes(seat.id) ?? false;
      if (
        isMine &&
        (payload.eventType === 'DELETE' || !stillHeldByMe(seat, current.userId))
      ) {
        current.onSeatLost?.(seat);
      }

      scheduleRefresh();
    };

    const handleTripUpdate = (payload: {
      eventType: SeatEventType;
      trip: { id: string; status?: string; [key: string]: unknown };
    }) => {
      if (payload.trip.id !== tripId) return;
      const current = optionsRef.current;

      if (payload.eventType === 'DELETE' || payload.trip.status === 'cancelled') {
        current.onTripCancelled?.();
        return;
      }
      if (payload.trip.status === 'completed') {
        current.onTripCompleted?.();
        return;
      }
      scheduleRefresh();
    };

    const cleanups = [
      subscribeToTripSeats([tripId], handleSeatUpdate),
      subscribeToTrips([tripId], handleTripUpdate),
    ];

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const cleanup of cleanups) cleanup();
    };
  }, [tripId]);
}
