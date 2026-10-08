import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { auth } from '../../middlewares/auth.js';
import { AppError, ValidationError } from '../../errors/index.js';
import { seatLockService } from '../../services/seat-lock.service.js';
import {
  assertAllowedGuestOrigin,
  clearGuestSessionCookie,
  getOrCreateActiveGuestSession,
  markSessionReleased,
  refreshGuestSessionCookie,
  releaseSessionIfUnused,
  requireActiveGuestSession,
  synchronizeSessionExpiry,
} from '../../services/guest-session.service.js';
import { claimGuestSession } from '../../services/guest-claim.service.js';

const router = Router();

const lockLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, try again later' } },
});

const uuidSchema = z.string().uuid();

const lockSchema = z.object({
  trip_id: uuidSchema,
  seat_ids: z
    .array(uuidSchema)
    .min(1, 'Selecciona al menos un asiento')
    .refine((ids) => new Set(ids).size === ids.length, 'Asientos duplicados'),
});

const unlockSchema = z.object({
  trip_id: uuidSchema,
  seat_ids: z.array(uuidSchema).min(1).optional(),
});

const locksQuerySchema = z.object({ trip_id: uuidSchema });

const claimSchema = z.object({ trip_id: uuidSchema });

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Invalid input', result.error.issues);
  }
  return result.data;
}

function requireCustomer(req: { ctx?: { role: string } }) {
  if (req.ctx?.role !== 'customer') {
    throw new AppError(
      'Solo cuentas de cliente pueden gestionar asientos',
      403,
      'CUSTOMER_REQUIRED',
    );
  }
}

/**
 * POST /api/public/seats/lock
 * Bloquea 1..N asientos para el customer autenticado.
 * El TTL lo decide el servidor (env.LOCK_TTL_SECONDS = 900 en marketplace).
 * El request NO controla `ttl_seconds`; si viene, se ignora.
 */
router.post('/lock', lockLimiter, auth, async (req, res, next) => {
  try {
    requireCustomer(req);
    const data = parseOrThrow(lockSchema, req.body);
    const result = await seatLockService.lockSeats(
      data.trip_id,
      data.seat_ids,
      req.ctx!.userId,
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/public/seats/unlock
 * Libera los locks PROPIOS del customer. Nunca toca locks de otros usuarios.
 * Sin `seat_ids` libera todos los locks propios del viaje.
 */
router.post('/unlock', lockLimiter, auth, async (req, res, next) => {
  try {
    requireCustomer(req);
    const data = parseOrThrow(unlockSchema, req.body);
    const result = await seatLockService.unlockSeats(
      data.trip_id,
      req.ctx!.userId,
      data.seat_ids,
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/seats/locks?trip_id=...
 * Locks vigentes (no vencidos) del customer para un viaje.
 * Es la fuente que usa el wizard tras un refresh para validar su selección.
 */
router.get('/locks', lockLimiter, auth, async (req, res, next) => {
  try {
    requireCustomer(req);
    const { trip_id: tripId } = parseOrThrow(locksQuerySchema, req.query);
    const result = await seatLockService.getMyLocks(tripId, req.ctx!.userId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

function guestSessionMetadata(session: {
  trip_id: string;
  status: string;
  expires_at: string;
}) {
  return {
    trip_id: session.trip_id,
    status: session.status,
    expires_at: session.expires_at,
  };
}

/**
 * POST /api/public/seats/lock-guest
 * Lock guest sin autenticación Supabase. La propiedad se demuestra con la
 * cookie HttpOnly de la sesión guest; el token crudo nunca se persiste.
 */
router.post('/lock-guest', lockLimiter, async (req, res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    const data = parseOrThrow(lockSchema, req.body);
    const { session, created } = await getOrCreateActiveGuestSession(
      req,
      res,
      data.trip_id,
    );

    try {
      const result = await seatLockService.lockGuestSeats(
        data.trip_id,
        data.seat_ids,
        session.id,
      );
      const nextExpiry = [session.expires_at, result.lock_expires_at].sort()[0];
      const synchronized = await synchronizeSessionExpiry(
        session.id,
        nextExpiry,
      );
      const activeSession = synchronized ?? {
        ...session,
        expires_at: nextExpiry,
      };
      refreshGuestSessionCookie(req, res, activeSession);
      res.json({
        ...result,
        guest_session: guestSessionMetadata(activeSession),
      });
    } catch (error) {
      if (created) {
        await releaseSessionIfUnused(session.id).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/seats/guest-locks?trip_id=...
 * Locks vigentes de la guest session resuelta desde la cookie.
 */
router.get('/guest-locks', lockLimiter, async (req, res, next) => {
  try {
    const { trip_id: tripId } = parseOrThrow(locksQuerySchema, req.query);
    const session = await requireActiveGuestSession(req, res, tripId);
    const result = await seatLockService.getGuestLocks(tripId, session.id);
    refreshGuestSessionCookie(req, res, session);
    res.json({
      ...result,
      guest_session: guestSessionMetadata(session),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/public/seats/unlock-guest
 * Libera únicamente los locks de la guest session resuelta desde la cookie.
 */
router.post('/unlock-guest', lockLimiter, async (req, res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    const data = parseOrThrow(unlockSchema, req.body);
    const session = await requireActiveGuestSession(req, res, data.trip_id);
    const result = await seatLockService.unlockGuestSeats(
      data.trip_id,
      session.id,
      data.seat_ids,
    );

    if ((result.remaining ?? 0) === 0) {
      await markSessionReleased(session.id);
      clearGuestSessionCookie(res, data.trip_id);
      res.json({
        ...result,
        guest_session: guestSessionMetadata({
          ...session,
          status: 'released',
        }),
      });
      return;
    }

    const locks = await seatLockService.getGuestLocks(
      data.trip_id,
      session.id,
    );
    const nextExpiry = locks.lock_expires_at ?? session.expires_at;
    const synchronized = await synchronizeSessionExpiry(
      session.id,
      nextExpiry,
    );
    const activeSession = synchronized ?? {
      ...session,
      expires_at: nextExpiry,
    };
    refreshGuestSessionCookie(req, res, activeSession);
    res.json({
      ...result,
      guest_session: guestSessionMetadata(activeSession),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/public/seats/claim-guest
 * Adopta la guest session de la cookie hacia el customer autenticado.
 * Transfiere ownership sin crear locks, reservas ni pasajeros, y preserva
 * exactamente `lock_expires_at`. Invalida la cookie guest al finalizar.
 */
router.post('/claim-guest', lockLimiter, auth, async (req, res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    requireCustomer(req);
    const data = parseOrThrow(claimSchema, req.body);
    const session = await requireActiveGuestSession(req, res, data.trip_id);
    const result = await claimGuestSession(
      session.id,
      data.trip_id,
      req.ctx!.userId,
    );
    clearGuestSessionCookie(res, data.trip_id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
