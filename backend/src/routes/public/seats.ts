import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { auth } from '../../middlewares/auth.js';
import { AppError, ValidationError } from '../../errors/index.js';
import { seatLockService } from '../../services/seat-lock.service.js';

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

export default router;
