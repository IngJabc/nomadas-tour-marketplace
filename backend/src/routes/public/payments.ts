import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { auth } from '../../middlewares/auth.js';
import { AppError, ValidationError } from '../../errors/index.js';
import { assertAllowedGuestOrigin } from '../../services/guest-session.service.js';
import {
  parseProofUpload,
  submitPaymentProof,
} from '../../services/payment.service.js';

const router = Router();

const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, try again later' } },
});

const uuidSchema = z.string().uuid();

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
      'Solo cuentas de cliente pueden enviar comprobantes',
      403,
      'CUSTOMER_REQUIRED',
    );
  }
}

/**
 * Header Idempotency-Key obligatorio y estrictamente UUID. Cualquier otra
 * forma (ausente, repetido, no-UUID) se rechaza sin tocar la reserva ni
 * el storage. La clave viaja solo al RPC, que la resuelve con el namespace
 * server-side `mkt005:<reservation>:<key>`.
 */
function readIdempotencyKey(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string') {
    throw new AppError(
      'Requiere un header Idempotency-Key válido (UUID)',
      400,
      'IDEMPOTENCY_KEY_INVALID',
    );
  }
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      'Requiere un header Idempotency-Key válido (UUID)',
      400,
      'IDEMPOTENCY_KEY_INVALID',
    );
  }
  return parsed.data;
}

/**
 * POST /api/public/reservations/:reservationId/payments
 * Envía el comprobante de pago de una reserva marketplace.
 *
 * - Auth obligatoria de rol `customer`; el customer_id sale SIEMPRE de la
 *   sesión, nunca del body, la query ni los params.
 * - CSRF: mismo patrón que los endpoints autenticados existentes (Bearer
 *   sin cookies + verificación de Origin).
 * - Idempotencia: header `Idempotency-Key` (UUID) obligatorio.
 * - El cliente solo aporta el archivo (campo `proof`): ningún monto,
 *   moneda, estado ni identidad del pagador proviene del request.
 * - La autoridad de negocio (TTL de lock, ownership de asientos, monto y
 *   locked → reserved) es el RPC 083; aquí no se confirma nada por fuera.
 */
router.post('/:reservationId/payments', submitLimiter, auth, async (req, res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    requireCustomer(req);

    const { reservationId } = parseOrThrow(
      z.object({ reservationId: uuidSchema }),
      req.params,
    );
    const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);

    const proof = await parseProofUpload(req);

    const result = await submitPaymentProof({
      reservationId,
      idempotencyKey,
      customerId: req.ctx!.userId,
      proof,
    });

    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
