import { supabaseAdmin } from '../config/database.js';
import {
  AppError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableError,
  ValidationError,
} from '../errors/index.js';

export interface ReservationPassengerDraft {
  seat_id: string;
  first_name: string;
  last_name: string;
  document: string;
  phone: string;
}

export interface CreateMarketplaceReservationInput {
  trip_id: string;
  agency_id: string;
  seat_ids: string[];
  passengers: ReservationPassengerDraft[];
  customer_id: string;
}

export interface CreateMarketplaceReservationResult {
  reservation_id: string;
  trip_id: string;
  agency_id: string;
  customer_id: string;
  status: 'locked';
  source: 'marketplace';
  unit_price: number;
  passenger_count: number;
  seat_ids: string[];
  idempotent: boolean;
}

interface ReservationRpcRow {
  reservation_id: string;
  trip_id: string;
  agency_id: string;
  customer_id: string;
  status: string;
  source: string;
  unit_price: number;
  passenger_count: number;
  seat_ids: string[];
  idempotent?: boolean;
}

function rpcErrorCode(message: string): string | null {
  const match = /^(ERR_[A-Z_]+):\s*/.exec(message);
  return match ? match[1] : null;
}

function rpcErrorMessage(message: string): string {
  return message.replace(/^ERR_[A-Z_]+:\s*/, '');
}

/**
 * Traduce los RAISE EXCEPTION de `create_marketplace_reservation` al envelope
 * de errores estándar del backend (código + status HTTP).
 */
function mapRpcError(error: { message: string }): AppError {
  const raw = error.message || 'No se pudo crear la reserva';
  const code = rpcErrorCode(raw);
  const message = rpcErrorMessage(raw);

  switch (code) {
    case 'ERR_CUSTOMER_REQUIRED':
      return new UnauthorizedError('Solo cuentas de cliente pueden crear reservas');
    case 'ERR_TRIP_NOT_FOUND':
      return new NotFoundError('Viaje no encontrado');
    case 'ERR_TRIP_NOT_ACTIVE':
      return new AppError('Este viaje ya no está disponible', 409, 'TRIP_NOT_ACTIVE');
    case 'ERR_TRIP_DEPARTED':
      return new AppError(
        'Este viaje ya no acepta nuevas reservas',
        409,
        'TRIP_DEPARTED',
      );
    case 'ERR_TRIP_PRICE_MISSING':
      return new UnprocessableError(
        'El viaje no tiene precio configurado',
        'TRIP_PRICE_MISSING',
      );
    case 'ERR_AGENCY_NOT_ASSIGNED':
      return new AppError(
        'La agencia seleccionada no ofrece este viaje',
        409,
        'AGENCY_NOT_ASSIGNED',
      );
    case 'ERR_SEAT_NOT_FOUND':
      return new AppError(
        'Algunos asientos ya no existen en este viaje',
        404,
        'SEAT_NOT_FOUND',
      );
    case 'ERR_SEAT_NOT_OWNED':
      return new AppError(
        'Algunos asientos no están bloqueados para tu cuenta',
        409,
        'SEAT_NOT_OWNED',
      );
    case 'ERR_SEAT_LOCK_EXPIRED':
      return new AppError(
        'Tu selección expiró. Elige los asientos de nuevo',
        409,
        'SEAT_LOCK_EXPIRED',
      );
    case 'ERR_NO_SEATS':
    case 'ERR_PASSENGER_MISMATCH':
    case 'ERR_SEAT_DUPLICATE':
    case 'ERR_PASSENGER_DUPLICATE_DOCUMENT':
    case 'ERR_PASSENGER_DATA':
      return new ValidationError(message);
    default:
      return new AppError(
        'No se pudo crear la reserva. Intenta de nuevo',
        500,
        'RESERVATION_CREATE_ERROR',
      );
  }
}

function fullName(passenger: ReservationPassengerDraft): string {
  return `${passenger.first_name} ${passenger.last_name}`
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Crea la reserva marketplace del checkout actual.
 *
 * Atomicidad: TODO el persistir (reservation + reservation_passengers) ocurre
 * dentro del RPC PostgreSQL `create_marketplace_reservation` (una única
 * transacción; un fallo en pasajeros revierte la reservation — cero huérfanos).
 * El backend jamás inserta en esas tablas por separado.
 *
 * El cliente NO es autoridad para: customer_id (viene del auth), agency_id
 * (se verifica contra trip_agencies dentro del RPC), unit_price (snapshot de
 * trips.seat_price dentro del RPC), status, source ni lock_expires_at.
 * Esta función no consulta ni modifica `seats`.
 */
export async function createMarketplaceReservation(
  input: CreateMarketplaceReservationInput,
): Promise<CreateMarketplaceReservationResult> {
  const seatSet = new Set(input.seat_ids);

  if (seatSet.size !== input.seat_ids.length) {
    throw new ValidationError('Hay asientos duplicados en la selección');
  }
  if (input.passengers.length !== input.seat_ids.length) {
    throw new ValidationError(
      'Cada asiento debe tener exactamente un pasajero',
    );
  }

  const passengersBySeat = new Map<string, ReservationPassengerDraft>();
  for (const passenger of input.passengers) {
    if (!seatSet.has(passenger.seat_id)) {
      throw new ValidationError('Un pasajero no coincide con los asientos');
    }
    if (passengersBySeat.has(passenger.seat_id)) {
      throw new ValidationError('Hay asientos duplicados en la selección');
    }
    passengersBySeat.set(passenger.seat_id, passenger);
  }

  const orderedSeatIds = [...input.seat_ids];
  const passengerNames: string[] = [];
  const passengerDocuments: string[] = [];
  const passengerPhones: string[] = [];

  for (const seatId of orderedSeatIds) {
    const passenger = passengersBySeat.get(seatId)!;
    passengerNames.push(fullName(passenger));
    passengerDocuments.push(passenger.document.trim());
    passengerPhones.push(passenger.phone.trim());
  }

  const { data, error } = await supabaseAdmin.rpc(
    'create_marketplace_reservation',
    {
      p_trip_id: input.trip_id,
      p_customer_id: input.customer_id,
      p_agency_id: input.agency_id,
      p_seat_ids: orderedSeatIds,
      p_passenger_names: passengerNames,
      p_passenger_documents: passengerDocuments,
      p_passenger_phones: passengerPhones,
    },
  );

  if (error) {
    throw mapRpcError(error);
  }

  const row = data as ReservationRpcRow | null;
  if (!row?.reservation_id) {
    throw new AppError(
      'No se pudo crear la reserva. Intenta de nuevo',
      500,
      'RESERVATION_CREATE_ERROR',
    );
  }

  return {
    reservation_id: row.reservation_id,
    trip_id: row.trip_id ?? input.trip_id,
    agency_id: row.agency_id ?? input.agency_id,
    customer_id: row.customer_id ?? input.customer_id,
    status: (row.status ?? 'locked') as 'locked',
    source: (row.source ?? 'marketplace') as 'marketplace',
    unit_price: row.unit_price,
    passenger_count: row.passenger_count ?? orderedSeatIds.length,
    seat_ids: row.seat_ids ?? orderedSeatIds,
    idempotent: row.idempotent === true,
  };
}
