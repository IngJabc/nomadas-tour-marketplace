import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { auth } from '../../middlewares/auth.js';
import { GoneError } from '../../errors/index.js';
import { assertAllowedGuestOrigin } from '../../services/guest-session.service.js';

const router = Router();

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, try again later' } },
});

/**
 * POST /api/public/reservations — DESACTIVADO por MKT-007.
 *
 * Antes de MKT-007 este endpoint creaba la reserva (status='locked') ANTES
 * de que una agencia revisara el comprobante, de modo que una compra
 * rechazada o caducada dejaba reservas, pasajeros y pagos huérfanos.
 *
 * Ahora la compra nace como `checkout_attempts` en
 * `POST /api/public/checkout/attempts` y la reserva definitiva, sus
 * pasajeros, el pago verificado y sus allocations solo nacen en la
 * aprobación atómica `verify_checkout_attempt` (migración 087).
 *
 * Se responde 410 Gone con un código accionable en lugar de 404 o 405
 * para que cualquier cliente viejo sepa que debe migrar al nuevo flujo.
 */
router.post('/', createLimiter, auth, (req, _res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    throw new GoneError(
      'Este flujo fue reemplazado por el checkout con revisión de comprobante. Inicia la compra en /api/public/checkout/attempts',
      'CHECKOUT_ATTEMPTS_REQUIRED',
    );
  } catch (error) {
    next(error);
  }
});

export default router;
