import { supabaseAdmin } from '../config/database.js';
import { AppError, UnauthorizedError } from '../errors/index.js';

export interface ClaimedSeat {
  id: string;
  seat_code: string;
  lock_expires_at: string;
}

export interface ClaimGuestResult {
  claimed: true;
  trip_id: string;
  seats: ClaimedSeat[];
  lock_expires_at: string | null;
  guest_session: {
    trip_id: string;
    status: 'claimed';
    expires_at: string;
  };
}

interface GuestSessionRow {
  id: string;
  trip_id: string;
  customer_id: string | null;
  status: string;
  expires_at: string;
}

interface EligibleSeatRow {
  id: string;
  seat_code: string;
  locked_by: string | null;
  lock_expires_at: string | null;
}

/**
 * Transfiere los locks de una guest session a un customer autenticado.
 *
 * Atomicidad sin RPC nuevo (la migración 080 no debe tocarse en esta fase):
 * 1. Se reclama la sesión con un UPDATE condicional (`status='active'` +
 *    `expires_at` vigente). Solo un request puede ganar: el perdedor obtiene
 *    0 filas y recibe un error controlado.
 * 2. Los seats se transfieren con UN único UPDATE condicionado a la sesión,
 *    al trip, al estado `locked` y a la expiración vigente. Nunca se tocan
 *    `lock_expires_at` ni `locked_at`: el TTL se preserva intacto.
 * 3. Si lo transferido no coincide exactamente con lo validado, se compensa
 *    (los seats vuelven a la sesión guest y la sesión vuelve a `active`)
 *    y se responde 409. No existe transferencia parcial visible.
 */
export async function claimGuestSession(
  sessionId: string,
  tripId: string,
  customerId: string,
): Promise<ClaimGuestResult> {
  const now = new Date().toISOString();

  const { data: seatRows, error: seatsError } = await supabaseAdmin
    .from('seats')
    .select('id, seat_code, locked_by, lock_expires_at')
    .eq('trip_id', tripId)
    .eq('status', 'locked')
    .eq('guest_session_id', sessionId);

  if (seatsError) {
    throw new AppError(seatsError.message, 500, 'SEATS_QUERY_ERROR');
  }

  const eligible = ((seatRows ?? []) as EligibleSeatRow[])
    .filter(
      (seat) =>
        seat.locked_by == null &&
        !!seat.lock_expires_at &&
        Date.parse(seat.lock_expires_at) > Date.now(),
    )
    .map((seat) => ({
      id: seat.id,
      seat_code: seat.seat_code,
      lock_expires_at: seat.lock_expires_at as string,
    }));

  if (eligible.length === 0) {
    throw new AppError(
      'La sesión guest no tiene locks vigentes para adoptar',
      409,
      'GUEST_SESSION_EMPTY',
    );
  }

  const eligibleIds = eligible.map((seat) => seat.id);

  const { data: claimed, error: claimError } = await supabaseAdmin
    .from('guest_sessions')
    .update({ status: 'claimed', customer_id: customerId })
    .eq('id', sessionId)
    .eq('status', 'active')
    .gt('expires_at', now)
    .select('id, trip_id, customer_id, status, expires_at')
    .maybeSingle();

  if (claimError) {
    throw new AppError(claimError.message, 500, 'GUEST_SESSION_UPDATE_ERROR');
  }

  if (!claimed) {
    throw await describeLostClaim(sessionId);
  }

  const { data: transferred, error: transferError } = await supabaseAdmin
    .from('seats')
    .update({ locked_by: customerId, guest_session_id: null })
    .eq('trip_id', tripId)
    .eq('status', 'locked')
    .eq('guest_session_id', sessionId)
    .gt('lock_expires_at', now)
    .in('id', eligibleIds)
    .select('id, seat_code, lock_expires_at');

  if (transferError) {
    await compensateClaim(sessionId, customerId, []);
    throw new AppError(transferError.message, 500, 'SEAT_CLAIM_ERROR');
  }

  const transferredIds = new Set(
    ((transferred ?? []) as Array<{ id: string }>).map((row) => row.id),
  );
  const complete =
    transferredIds.size === eligibleIds.length &&
    eligibleIds.every((id) => transferredIds.has(id));

  if (!complete) {
    await compensateClaim(sessionId, customerId, [...transferredIds]);
    throw new AppError(
      'Los locks cambiaron durante el claim; no se adoptó ningún asiento',
      409,
      'GUEST_CLAIM_CONFLICT',
    );
  }

  const seats = ((transferred ?? []) as ClaimedSeat[]).sort((a, b) =>
    a.seat_code.localeCompare(b.seat_code, undefined, { numeric: true }),
  );
  const expiries = seats.map((seat) => seat.lock_expires_at).sort();

  return {
    claimed: true,
    trip_id: tripId,
    seats,
    lock_expires_at: expiries.length > 0 ? expiries[0] : null,
    guest_session: {
      trip_id: tripId,
      status: 'claimed',
      expires_at: (claimed as GuestSessionRow).expires_at,
    },
  };
}

async function describeLostClaim(sessionId: string): Promise<AppError> {
  const { data, error } = await supabaseAdmin
    .from('guest_sessions')
    .select('id, trip_id, customer_id, status, expires_at')
    .eq('id', sessionId)
    .maybeSingle();

  if (error) {
    return new AppError(error.message, 500, 'GUEST_SESSION_QUERY_ERROR');
  }

  const session = data as GuestSessionRow | null;
  if (!session) {
    return new UnauthorizedError('Sesión guest inválida');
  }
  if (session.status === 'claimed') {
    return new AppError(
      'La sesión guest ya fue reclamada',
      409,
      'GUEST_SESSION_CLAIMED',
    );
  }
  if (session.status !== 'active' || Date.parse(session.expires_at) <= Date.now()) {
    return new AppError('La sesión guest expiró', 401, 'GUEST_SESSION_EXPIRED');
  }
  return new AppError(
    'Otra solicitud reclamó la sesión guest primero',
    409,
    'GUEST_CLAIM_CONFLICT',
  );
}

/**
 * Compensación best-effort: devuelve los seats transferidos a la sesión
 * guest y la sesión a `active` sin customer. Solo se usa cuando la
 * transferencia no fue completa; nunca toca `lock_expires_at`.
 */
async function compensateClaim(
  sessionId: string,
  customerId: string,
  transferredIds: string[],
): Promise<void> {
  try {
    if (transferredIds.length > 0) {
      await supabaseAdmin
        .from('seats')
        .update({ locked_by: null, guest_session_id: sessionId })
        .in('id', transferredIds)
        .eq('locked_by', customerId);
    }
    await supabaseAdmin
      .from('guest_sessions')
      .update({ status: 'active', customer_id: null })
      .eq('id', sessionId)
      .eq('status', 'claimed')
      .eq('customer_id', customerId);
  } catch {
    // La compensación es best-effort: el error original ya describe el fallo.
  }
}
