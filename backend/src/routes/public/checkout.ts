import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { auth } from '../../middlewares/auth.js';
import { AppError, ValidationError } from '../../errors/index.js';
import { assertAllowedGuestOrigin } from '../../services/guest-session.service.js';
import {
  cancelCheckoutAttempt,
  createCheckoutAttempt,
  getCheckoutAttempt,
  parseCheckoutProofUpload,
  submitCheckoutProof,
  type CreateCheckoutAttemptInput,
} from '../../services/checkout.service.js';

const router = Router();

const rateLimitDisabled = process.env.NODE_ENV === 'test';

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  skip: () => rateLimitDisabled,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, try again later' } },
});

const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  skip: () => rateLimitDisabled,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, try again later' } },
});

const cancelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  skip: () => rateLimitDisabled,
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
      'Solo cuentas de cliente pueden gestionar compras',
      403,
      'CUSTOMER_REQUIRED',
    );
  }
}

/**
 * Header Idempotency-Key obligatorio y estrictamente UUID. Cualquier
 * otra forma (ausente, repetido, no-UUID) se rechaza sin tocar la
 * base de datos ni el storage.
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
 * POST /api/public/checkout/attempts
 * Inicia una compra: crea UN checkout_attempt y reclama los locks.
 *
 * NO crea reservations ni payments. Eso ocurre únicamente cuando la
 * agencia aprueba el comprobante (verify_checkout_attempt).
 *
 * - Auth obligatoria de customer (guest -> login -> claim -> lock).
 * - CSRF: mismo patrón que los endpoints existentes (Bearer + Origin).
 * - customer_id, agency_id, precio y TTL salen de la sesión/servidor.
 */
router.post('/attempts', createLimiter, auth, async (req, res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    requireCustomer(req);

    const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);

    // El body crudo pasa tal cual al servicio: allí el schema de zod
    // valida tipos y formatos antes de tocar la base de datos.
    const payload = (req.body ?? {}) as Partial<CreateCheckoutAttemptInput>;

    const result = await createCheckoutAttempt({
      trip_id: (payload.trip_id ?? '') as string,
      agency_id: (payload.agency_id ?? '') as string,
      seat_ids: (payload.seat_ids ?? []) as string[],
      passengers: (payload.passengers ?? []) as CreateCheckoutAttemptInput['passengers'],
      customerId: req.ctx!.userId,
      idempotencyKey,
    });

    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/checkout/attempts/:attemptId
 * Estado de la compra para su dueño: estado, ventana, conciliación,
 * snapshot de pasajeros y comprobantes restantes.
 *
 * La ruta del comprobante NO se devuelve: el archivo solo se sirve con
 * URL firmada desde el área de agencia.
 */
router.get('/attempts/:attemptId', auth, async (req, res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    requireCustomer(req);

    const { attemptId } = parseOrThrow(
      z.object({ attemptId: uuidSchema }),
      req.params,
    );

    const result = await getCheckoutAttempt({
      attemptId,
      customerId: req.ctx!.userId,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/public/checkout/attempts/:attemptId/proof
 * Primer envío o reenvío de comprobante (máx. 3 por intento).
 *
 * multipart: un archivo `proof` + payment_reference + bank_origin +
 * payment_datetime. La ruta se deriva del contenido
 * (`{attempt_id}/{sha256}.{ext}`), nunca del filename.
 *
 * El RPC 087 es la autoridad: ownership, estado, ventana de 24 h,
 * contador atómico y prolongación de los locks.
 */
router.post('/attempts/:attemptId/proof', submitLimiter, auth, async (req, res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    requireCustomer(req);

    const { attemptId } = parseOrThrow(
      z.object({ attemptId: uuidSchema }),
      req.params,
    );
    const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);

    const proof = await parseCheckoutProofUpload(req);

    const result = await submitCheckoutProof({
      attemptId,
      customerId: req.ctx!.userId,
      idempotencyKey,
      proof,
    });

    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/public/checkout/attempts/:attemptId/cancel
 * Cancelación voluntaria. Libera SOLO los locks propios del intento.
 */
router.post('/attempts/:attemptId/cancel', cancelLimiter, auth, async (req, res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    requireCustomer(req);

    const { attemptId } = parseOrThrow(
      z.object({ attemptId: uuidSchema }),
      req.params,
    );

    const result = await cancelCheckoutAttempt({
      attemptId,
      customerId: req.ctx!.userId,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
