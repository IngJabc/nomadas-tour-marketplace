import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { auth } from '../../middlewares/auth.js';
import { GoneError } from '../../errors/index.js';
import { assertAllowedGuestOrigin } from '../../services/guest-session.service.js';

const router = Router();

const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, try again later' } },
});

/**
 * POST /api/public/reservations/:reservationId/payments — DESACTIVADO
 * por MKT-007.
 *
 * Antes de MKT-007 el comprobante se sometía contra una reserva que ya
 * existía (status='locked'). Ahora el comprobante se somete contra un
 * `checkout_attempts` en `POST
 * /api/public/checkout/attempts/:attemptId/proof`, que además exige los
 * tres datos de conciliación (referencia, banco, fecha-hora), abre la
 * ventana de 24 h y prolonga los locks del intento.
 *
 * Se responde 410 Gone con un código accionable para que cualquier
 * cliente viejo sepa que debe migrar al nuevo flujo.
 */
router.post('/:reservationId/payments', submitLimiter, auth, (req, _res, next) => {
  try {
    assertAllowedGuestOrigin(req);
    throw new GoneError(
      'Este flujo fue reemplazado por el checkout con revisión de comprobante. Envía el comprobante en /api/public/checkout/attempts/:attemptId/proof',
      'CHECKOUT_ATTEMPTS_REQUIRED',
    );
  } catch (error) {
    next(error);
  }
});

export default router;
