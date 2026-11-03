import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../../middlewares/auth.js';
import { AppError, ValidationError } from '../../errors/index.js';
import { adminListReviews, adminModerateReview } from '../../services/review.service.js';

const router = Router();

const uuidSchema = z.string().uuid();

function requireSuperadmin(req: { ctx?: { role: string } }) {
  if (req.ctx?.role !== 'superadmin') {
    throw new AppError(
      'Se requiere una cuenta de superadmin',
      403,
      'SUPERADMIN_REQUIRED',
    );
  }
}

const listQuerySchema = z.object({
  review_type: z.enum(['trip_review', 'agency_review']).optional(),
  moderation_status: z.enum(['visible', 'hidden', 'rejected']).optional(),
  agency_id: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/admin/reviews
 * Listado de reseñas para el panel de moderación (superadmin). Permite
 * filtrar por tipo, estado de moderación y agencia.
 *
 * NOTA (deuda documentada): el frontend de este endpoint aún no existe —
 * no hay cliente en `lib/admin/api.ts` ni pantalla de moderación en
 * `/admin`. La superficie backend queda lista para cuando se construya.
 */
router.get('/', auth, async (req, res, next) => {
  try {
    requireSuperadmin(req);

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Filtros inválidos', parsed.error.issues);
    }

    const result = await adminListReviews({
      reviewType: parsed.data.review_type,
      moderationStatus: parsed.data.moderation_status,
      agencyId: parsed.data.agency_id,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

const moderateBodySchema = z.object({
  action: z.enum(['hide', 'reject', 'restore'], {
    message: 'La acción debe ser hide, reject o restore',
  }),
  reason: z.string().trim().max(500).nullable().optional(),
});

/**
 * PATCH /api/admin/reviews/:reviewType/:reviewId
 * Moderación atómica + auditada (RPC 099). Solo superadmin. Preserva el
 * contenido original y el historial de auditoría.
 */
router.patch('/:reviewType/:reviewId', auth, async (req, res, next) => {
  try {
    requireSuperadmin(req);

    const reviewType = req.params.reviewType;
    if (reviewType !== 'trip_review' && reviewType !== 'agency_review') {
      throw new AppError('Tipo de reseña inválido', 400, 'REVIEW_TYPE_INVALID');
    }

    const reviewId = uuidSchema.safeParse(req.params.reviewId);
    if (!reviewId.success) {
      throw new AppError('Reseña no encontrada', 404, 'REVIEW_NOT_FOUND');
    }

    const parsed = moderateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Acción de moderación inválida', parsed.error.issues);
    }

    const result = await adminModerateReview({
      reviewType,
      reviewId: reviewId.data,
      actorUserId: req.ctx!.userId,
      action: parsed.data.action,
      reason: parsed.data.reason ?? null,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
