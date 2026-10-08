import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { auth } from '../../middlewares/auth.js';
import { AppError, ValidationError } from '../../errors/index.js';
import { assertAllowedGuestOrigin } from '../../services/guest-session.service.js';
import { createMarketplaceReservation } from '../../services/reservation.service.js';

const router = Router();

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, try again later' } },
});

const uuidSchema = z.string().uuid();

// Mismas reglas que lib/booking/passengers.ts (frontend): el backend
// valida por su cuenta y nunca confía en la validación del cliente.
const DOCUMENT_PATTERN = /^\d{7,8}$/;
const PHONE_PATTERN = /^(0\d{10}|\+\d{12,15})$/;

const passengerSchema = z.object({
  seat_id: uuidSchema,
  first_name: z.string().trim().min(2, 'Escribe el nombre del pasajero'),
  last_name: z.string().trim().min(2, 'Escribe el apellido del pasajero'),
  document: z.string().trim().regex(DOCUMENT_PATTERN, 'Debe tener 7 u 8 dígitos'),
  phone: z.string().trim().regex(PHONE_PATTERN, 'Ingresa un teléfono válido (ej. 04241234567)'),
});

const createReservationSchema = z.object({
  trip_id: uuidSchema,
  agency_id: uuidSchema,
  seat_ids: z
    .array(uuidSchema)
    .min(1, 'Selecciona al menos un asiento')
    .refine((ids) => new Set(ids).size === ids.length, 'Asientos duplicados'),
  passengers: z
    .array(passengerSchema)
    .min(1, 'Faltan datos de los pasajeros')
    .refine(
      (list) => new Set(list.map((p) => p.seat_id)).size === list.length,
      'Asientos duplicados',
    )
    .refine(
      (list) => new Set(list.map((p) => p.document)).size === list.length,
      'Documento repetido en esta reserva',
    ),
});

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
      'Solo cuentas de cliente pueden crear reservas',
      403,
      'CUSTOMER_REQUIRED',
    );
  }
}

/**
 * POST /api/public/reservations
 * Crea la reserva del checkout (status='locked', source='marketplace')
 * con exactamente un pasajero por asiento, en UNA transacción PostgreSQL.
 *
 * - Auth obligatoria de customer: el guest debe hacer lock -> login ->
 *   claim -> customer lock antes de llegar aquí. No acepta creación guest.
 * - CSRF: mismo patrón que los endpoints autenticados existentes
 *   (Bearer, sin cookies ambientales) + verificación de Origin.
 * - customer_id, agency_id (vs trip_agencies), unit_price (trips.seat_price),
 *   status y source se derivan/verifican en el backend; el payload solo
 *   aporta trip, oferta seleccionada, asientos y pasajeros.
 * - NO modifica locks ni lock_expires_at (el TTL sigue corriendo).
 */
router.post('/', createLimiter, auth, async (req, res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    requireCustomer(req);
    const data = parseOrThrow(createReservationSchema, req.body);

    const result = await createMarketplaceReservation({
      trip_id: data.trip_id,
      agency_id: data.agency_id,
      seat_ids: data.seat_ids,
      passengers: data.passengers,
      customer_id: req.ctx!.userId,
    });

    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
