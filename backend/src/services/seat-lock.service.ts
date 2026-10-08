import { supabaseAdmin } from '../config/database.js';
import { env } from '../config/env.js';
import { AppError, ValidationError } from '../errors/index.js';

export interface LockedSeat {
  id: string;
  seat_code: string;
  status: 'locked';
  locked_by: string | null;
  guest_session_id?: string | null;
  lock_expires_at: string;
}

export type SeatLockOwner =
  | { kind: 'customer'; userId: string }
  | { kind: 'guest'; sessionId: string };

export interface LockSeatsResult {
  locked: true;
  trip_id: string;
  ttl_seconds: number;
  lock_expires_at: string;
  seats: LockedSeat[];
}

export interface UnlockSeatsResult {
  unlocked: number;
  remaining?: number;
}

export interface MySeatLocksResult {
  trip_id: string;
  lock_expires_at: string | null;
  seats: Array<{ id: string; seat_code: string; lock_expires_at: string }>;
}

interface SeatRow {
  id: string;
  trip_id: string;
  seat_code: string;
  status: string;
  locked_by: string | null;
  guest_session_id: string | null;
  lock_expires_at: string | null;
}

function seatCodes(rows: SeatRow[]): string {
  return rows.map((row) => row.seat_code).join(', ');
}

function isOwnedBy(seat: SeatRow, owner: SeatLockOwner): boolean {
  if (seat.status !== 'locked') return false;
  if (owner.kind === 'customer') {
    return seat.locked_by === owner.userId && seat.guest_session_id == null;
  }
  return seat.guest_session_id === owner.sessionId && seat.locked_by == null;
}

/**
 * Lock de asientos del marketplace — reutiliza el mismo motor de locks que
 * `nomadas-tour` (`seats.status='locked'`, `locked_by`, `locked_at`,
 * `lock_expires_at` + limpieza periódica de vencidos). El TTL lo decide el
 * servidor: `env.LOCK_TTL_SECONDS` (900 en marketplace, 600 en tour).
 * El cliente nunca envía ni controla el TTL.
 */
export class SeatLockService {
  async lockSeats(
    tripId: string,
    seatIds: string[],
    userId: string,
  ): Promise<LockSeatsResult> {
    return this.lockSeatsForOwner(tripId, seatIds, {
      kind: 'customer',
      userId,
    });
  }

  async lockGuestSeats(
    tripId: string,
    seatIds: string[],
    sessionId: string,
  ): Promise<LockSeatsResult> {
    return this.lockSeatsForOwner(tripId, seatIds, {
      kind: 'guest',
      sessionId,
    });
  }

  private applyOwnerMatch(query: any, owner: SeatLockOwner): any {
    if (owner.kind === 'customer') {
      return query.eq('locked_by', owner.userId);
    }
    return query.eq('guest_session_id', owner.sessionId);
  }

  private async lockSeatsForOwner(
    tripId: string,
    seatIds: string[],
    owner: SeatLockOwner,
  ): Promise<LockSeatsResult> {
    const { data: trip, error: tripError } = await supabaseAdmin
      .from('trips')
      .select('id, status, capacity')
      .eq('id', tripId)
      .maybeSingle();

    if (tripError) {
      throw new AppError(tripError.message, 500, 'TRIP_QUERY_ERROR');
    }
    if (!trip) {
      throw new AppError('Viaje no encontrado', 404, 'TRIP_NOT_FOUND');
    }
    if (trip.status !== 'active') {
      throw new AppError('Este viaje ya no está disponible', 409, 'TRIP_NOT_ACTIVE');
    }
    if (seatIds.length > (trip.capacity ?? 0)) {
      throw new ValidationError('No puedes bloquear más asientos que la capacidad del viaje');
    }

    const ttlSeconds = env.LOCK_TTL_SECONDS;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const { error: cleanupError } = await supabaseAdmin
      .from('seats')
      .update({
        status: 'available',
        locked_by: null,
        locked_at: null,
        lock_expires_at: null,
        guest_session_id: null,
      })
      .in('id', seatIds)
      .eq('status', 'locked')
      .lt('lock_expires_at', now)
      .select('id');

    if (cleanupError) {
      throw new AppError(cleanupError.message, 500, 'SEAT_LOCK_ERROR');
    }

    const { data: seatRows, error: seatsError } = await supabaseAdmin
      .from('seats')
      .select(
        'id, trip_id, seat_code, status, locked_by, guest_session_id, lock_expires_at',
      )
      .in('id', seatIds);

    if (seatsError) {
      throw new AppError(seatsError.message, 500, 'SEATS_QUERY_ERROR');
    }

    const seats = (seatRows ?? []) as SeatRow[];
    if (seats.length !== seatIds.length) {
      throw new AppError('Algunos asientos no existen', 404, 'SEAT_NOT_FOUND');
    }

    const wrongTrip = seats.filter((seat) => seat.trip_id !== tripId);
    if (wrongTrip.length > 0) {
      throw new ValidationError('Algunos asientos no pertenecen a este viaje');
    }

    const notBookable = seats.filter(
      (seat) => seat.status !== 'available' && seat.status !== 'locked',
    );
    if (notBookable.length > 0) {
      throw new AppError(
        `Asientos no disponibles: ${seatCodes(notBookable)}`,
        409,
        'SEAT_NOT_AVAILABLE',
      );
    }

    const heldByOther = seats.filter(
      (seat) => seat.status === 'locked' && !isOwnedBy(seat, owner),
    );
    if (heldByOther.length > 0) {
      throw new AppError(
        `Asientos bloqueados por otro usuario: ${seatCodes(heldByOther)}`,
        409,
        'SEAT_LOCKED',
      );
    }

    const alreadyMine = seats.filter((seat) => isOwnedBy(seat, owner));
    const freeIds = seats
      .filter((seat) => seat.status === 'available')
      .map((seat) => seat.id);

    if (freeIds.length > 0) {
      const ownerUpdate =
        owner.kind === 'customer'
          ? {
              status: 'locked',
              locked_by: owner.userId,
              locked_at: now,
              lock_expires_at: expiresAt,
              guest_session_id: null,
            }
          : {
              status: 'locked',
              locked_by: null,
              locked_at: now,
              lock_expires_at: expiresAt,
              guest_session_id: owner.sessionId,
            };
      const { data: updated, error: updateError } = await supabaseAdmin
        .from('seats')
        .update(ownerUpdate)
        .in('id', freeIds)
        .eq('status', 'available')
        .select('id');

      if (updateError) {
        throw new AppError(updateError.message, 500, 'SEAT_LOCK_ERROR');
      }

      const acquired = new Set((updated ?? []).map((row: { id: string }) => row.id));
      const missed = freeIds.filter((id) => !acquired.has(id));

      if (missed.length > 0) {
        if (acquired.size > 0) {
          const rollbackQuery = supabaseAdmin
            .from('seats')
            .update({
              status: 'available',
              locked_by: null,
              locked_at: null,
              lock_expires_at: null,
              guest_session_id: null,
            })
            .in('id', Array.from(acquired))
            .eq('status', 'locked')
            .eq('lock_expires_at', expiresAt);
          await this.applyOwnerMatch(rollbackQuery, owner).select('id');
        }
        throw new AppError(
          'Algunos asientos ya no están disponibles. Actualizamos el mapa, vuelve a intentarlo.',
          409,
          'SEAT_NOT_AVAILABLE',
        );
      }
    }

    if (alreadyMine.length > 0) {
      const extendQuery = supabaseAdmin
        .from('seats')
        .update({ locked_at: now, lock_expires_at: expiresAt })
        .in(
          'id',
          alreadyMine.map((seat) => seat.id),
        )
        .eq('status', 'locked');
      const { error: extendError } = await this.applyOwnerMatch(
        extendQuery,
        owner,
      ).select('id');

      if (extendError) {
        throw new AppError(extendError.message, 500, 'SEAT_LOCK_ERROR');
      }
    }

    const byId = new Map(seats.map((seat) => [seat.id, seat]));

    return {
      locked: true,
      trip_id: tripId,
      ttl_seconds: ttlSeconds,
      lock_expires_at: expiresAt,
      seats: seatIds.map((id) => ({
        id,
        seat_code: byId.get(id)!.seat_code,
        status: 'locked',
        locked_by: owner.kind === 'customer' ? owner.userId : null,
        ...(owner.kind === 'guest'
          ? { guest_session_id: owner.sessionId }
          : {}),
        lock_expires_at: expiresAt,
      })),
    };
  }

  async unlockSeats(
    tripId: string,
    userId: string,
    seatIds?: string[],
  ): Promise<UnlockSeatsResult> {
    return this.unlockSeatsForOwner(
      tripId,
      { kind: 'customer', userId },
      seatIds,
    );
  }

  async unlockGuestSeats(
    tripId: string,
    sessionId: string,
    seatIds?: string[],
  ): Promise<UnlockSeatsResult> {
    return this.unlockSeatsForOwner(
      tripId,
      { kind: 'guest', sessionId },
      seatIds,
    );
  }

  private async assertGuestUnlockTargets(
    tripId: string,
    seatIds: string[],
    sessionId: string,
  ): Promise<void> {
    const { data: seatRows, error } = await supabaseAdmin
      .from('seats')
      .select('id, trip_id, seat_code, status, locked_by, guest_session_id')
      .in('id', seatIds);

    if (error) {
      throw new AppError(error.message, 500, 'SEATS_QUERY_ERROR');
    }

    const seats = (seatRows ?? []) as SeatRow[];
    if (seats.length !== seatIds.length) {
      throw new AppError('Algunos asientos no existen', 404, 'SEAT_NOT_FOUND');
    }
    if (seats.some((seat) => seat.trip_id !== tripId)) {
      throw new ValidationError('Algunos asientos no pertenecen a este viaje');
    }

    const foreign = seats.filter(
      (seat) =>
        seat.status === 'locked' &&
        (seat.guest_session_id !== sessionId || seat.locked_by != null),
    );
    if (foreign.length > 0) {
      throw new AppError(
        `Asientos bloqueados por otro usuario: ${seatCodes(foreign)}`,
        409,
        'SEAT_LOCKED',
      );
    }
  }

  private async unlockSeatsForOwner(
    tripId: string,
    owner: SeatLockOwner,
    seatIds?: string[],
  ): Promise<UnlockSeatsResult> {
    if (owner.kind === 'guest' && seatIds && seatIds.length > 0) {
      await this.assertGuestUnlockTargets(tripId, seatIds, owner.sessionId);
    }

    let query = supabaseAdmin
      .from('seats')
      .update({
        status: 'available',
        locked_by: null,
        locked_at: null,
        lock_expires_at: null,
        guest_session_id: null,
      })
      .eq('trip_id', tripId)
      .eq('status', 'locked');
    query = this.applyOwnerMatch(query, owner);

    if (seatIds && seatIds.length > 0) {
      query = query.in('id', seatIds);
    }

    const { data, error } = await query.select('id');
    if (error) {
      throw new AppError(error.message, 500, 'SEAT_UNLOCK_ERROR');
    }

    if (owner.kind === 'customer') {
      return { unlocked: (data ?? []).length };
    }

    const remaining = await this.getLocksForOwner(tripId, owner);
    return { unlocked: (data ?? []).length, remaining: remaining.seats.length };
  }

  async getMyLocks(tripId: string, userId: string): Promise<MySeatLocksResult> {
    return this.getLocksForOwner(tripId, { kind: 'customer', userId });
  }

  async getGuestLocks(
    tripId: string,
    sessionId: string,
  ): Promise<MySeatLocksResult> {
    return this.getLocksForOwner(tripId, { kind: 'guest', sessionId });
  }

  private async getLocksForOwner(
    tripId: string,
    owner: SeatLockOwner,
  ): Promise<MySeatLocksResult> {
    let query = supabaseAdmin
      .from('seats')
      .select('id, seat_code, lock_expires_at')
      .eq('trip_id', tripId)
      .eq('status', 'locked');
    query = this.applyOwnerMatch(query, owner);

    const { data, error } = await query.gt(
      'lock_expires_at',
      new Date().toISOString(),
    );

    if (error) {
      throw new AppError(error.message, 500, 'SEATS_QUERY_ERROR');
    }

    const seats = ((data ?? []) as Array<{
      id: string;
      seat_code: string;
      lock_expires_at: string | null;
    }>)
      .filter(
        (seat) =>
          !!seat.lock_expires_at &&
          Date.parse(seat.lock_expires_at) > Date.now(),
      )
      .map((seat) => ({
        id: seat.id,
        seat_code: seat.seat_code,
        lock_expires_at: seat.lock_expires_at as string,
      }))
      .sort((a, b) => a.seat_code.localeCompare(b.seat_code, undefined, { numeric: true }));

    const expiries = seats.map((seat) => seat.lock_expires_at).sort();

    return {
      trip_id: tripId,
      lock_expires_at: expiries.length > 0 ? expiries[0] : null,
      seats,
    };
  }
}

export const seatLockService = new SeatLockService();
