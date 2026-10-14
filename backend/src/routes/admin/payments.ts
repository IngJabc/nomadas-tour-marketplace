import { Router } from 'express';
import { GoneError } from '../../errors/index.js';

const router = Router();

/**
 * Todas las rutas /api/admin/payments — DESACTIVADAS por MKT-007.
 *
 * Antes de MKT-007 la revisión de comprobantes de agencia vivía en
 * Marketplace (`/pagos` + `/api/admin/payments`). MKT-007 centraliza
 * la revisión en Tour (`/agency/payments` + checkout_attempts RPCs).
 * Marketplace ya no expone ninguna accion administrativa de revision.
 *
 * Se responde 410 Gone con un codigo accionable para que cualquier
 * cliente viejo sepa que debe usar Tour.
 */
router.use((_req, _res, next) => {
  next(
    new GoneError(
      'La revision de pagos ahora vive en Nómadas Tour (/agency/payments). Este endpoint fue reemplazado por MKT-007.',
      'CHECKOUT_ATTEMPTS_REQUIRED',
    ),
  );
});

export default router;
