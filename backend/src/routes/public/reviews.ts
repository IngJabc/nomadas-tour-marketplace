import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { auth } from '../../middlewares/auth.js';
import { AppError } from '../../errors/index.js';
import {
  getReviewContext,
  listCustomerNotifications,
  listCustomerReviews,
  markNotificationRead,
  submitReviews,
} from '../../services/review.service.js';

const router = Router();

const rateLimitDisabled = process.env.NODE_ENV === 'test';

const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  skip: () => rateLimitDisabled,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, try again later' } },
});

function requireCustomer(req: { ctx?: { role: string } }) {
  if (req.ctx?.role !== 'customer') {
    throw new AppError(
      'Solo cuentas de cliente pueden gestionar reseñas',
      403,
      'CUSTOMER_REQUIRED',
    );
  }
}

/**
 * Express tipa `req.params` como `string | string[]` en esta configuración.
 * Un path param real SIEMPRE es un string; si llegara como array (ruta mal
 * formada), se responde 404 uniforme sin filtrar existencia.
 */
function pathParam(
  value: string | string[] | undefined,
  message: string,
  code: string,
): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new AppError(message, 404, code);
}

/**
 * GET /api/public/reviews
 * Reseñas e invitaciones del cliente autenticado (pendientes, enviadas,
 * expiradas). Identidad SIEMPRE de req.ctx (servidor).
 */
router.get('/', auth, async (req, res, next) => {
  try {
    requireCustomer(req);
    const result = await listCustomerReviews(req.ctx!.userId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/reviews/notifications
 * Notificaciones internas de cliente (avisos de reseña pendiente).
 */
router.get('/notifications', auth, async (req, res, next) => {
  try {
    requireCustomer(req);
    const result = await listCustomerNotifications(req.ctx!.userId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/public/reviews/notifications/:notificationId/read
 * Marca una notificación como leída (solo la del cliente autenticado).
 */
router.patch('/notifications/:notificationId/read', auth, async (req, res, next) => {
  try {
    requireCustomer(req);
    const result = await markNotificationRead({
      notificationId: pathParam(
        req.params.notificationId,
        'Notificación no encontrada',
        'REVIEW_NOTIFICATION_NOT_FOUND',
      ),
      customerId: req.ctx!.userId,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/reviews/reservations/:reservationId
 * Contexto del formulario de reseña de UNA reserva. Revalida elegibilidad
 * en el servidor; 404 uniforme para inexistente/ajena.
 */
router.get('/reservations/:reservationId', auth, async (req, res, next) => {
  try {
    requireCustomer(req);
    const context = await getReviewContext({
      reservationId: pathParam(
        req.params.reservationId,
        'Reserva no encontrada',
        'REVIEW_RESERVATION_NOT_FOUND',
      ),
      customerId: req.ctx!.userId,
    });
    res.json(context);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/public/reviews/reservations/:reservationId
 * Envío ATÓMICO de las DOS reseñas (viaje + agencia) en UNA transacción.
 * NO requiere header Idempotency-Key: la idempotencia vive en la RPC 099
 * por reserva (un reintento devuelve already_submitted sin duplicar). Los
 * ratings llegan tal cual del JSON (sin coerción Number()): zod los valida
 * como number entero 1–5. La autoridad de elegibilidad y ventana vive en
 * la RPC 099 (servidor); la URL no autoriza.
 */
router.post(
  '/reservations/:reservationId',
  submitLimiter,
  auth,
  async (req, res, next) => {
    try {
      requireCustomer(req);

      const body = (req.body ?? {}) as Record<string, unknown>;

      const result = await submitReviews({
        reservationId: pathParam(
          req.params.reservationId,
          'Reserva no encontrada',
          'REVIEW_RESERVATION_NOT_FOUND',
        ),
        customerId: req.ctx!.userId,
        // Sin Number(): la coerción aceptaría strings/null en un campo
        // que el contrato JSON exige numérico. zod emite el error de
        // validación con su mensaje en español.
        trip_rating: body.trip_rating as number,
        trip_comment: (body.trip_comment ?? null) as string | null,
        agency_rating: body.agency_rating as number,
        agency_comment: (body.agency_comment ?? null) as string | null,
      });

      res.status(result.already_submitted ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
