import type { PublicTripAvailability, PublicTripDetail, PublicTripSeat } from '@/lib/api';

type SeatRow = Pick<PublicTripSeat, 'id' | 'seat_code' | 'status'>;

/** Recalcula los contadores de disponibilidad a partir del arreglo de asientos. */
export function recountAvailability(seats: PublicTripSeat[]): PublicTripAvailability {
  const availability: PublicTripAvailability = {
    total: seats.length,
    available: 0,
    reserved: 0,
    locked: 0,
    blocked: 0,
    guide: 0,
  };
  for (const seat of seats) {
    switch (seat.status) {
      case 'available':
        availability.available += 1;
        break;
      case 'reserved':
        availability.reserved += 1;
        break;
      case 'locked':
        availability.locked += 1;
        break;
      case 'blocked':
        availability.blocked += 1;
        break;
      case 'guide':
        availability.guide += 1;
        break;
    }
  }
  return availability;
}

/** Aplica un cambio de estado de un asiento (evento realtime) al viaje cargado. */
export function applySeatRow(trip: PublicTripDetail, row: SeatRow): PublicTripDetail {
  if (!trip.seats.some((seat) => seat.id === row.id)) return trip;
  const seats = trip.seats.map((seat) =>
    seat.id === row.id ? { ...seat, status: row.status } : seat,
  );
  return { ...trip, seats, availability: recountAvailability(seats) };
}

/** Elimina un asiento del mapa (evento DELETE realtime) y recalcula totales. */
export function removeSeatRow(trip: PublicTripDetail, seatId: string): PublicTripDetail {
  if (!trip.seats.some((seat) => seat.id === seatId)) return trip;
  const seats = trip.seats.filter((seat) => seat.id !== seatId);
  return { ...trip, seats, availability: recountAvailability(seats) };
}
