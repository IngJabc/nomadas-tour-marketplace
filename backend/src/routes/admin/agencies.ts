import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../../middlewares/auth.js';
import { AppError, ValidationError } from '../../errors/index.js';
import { adminUpdateAgencyShowcase } from '../../services/agency.service.js';

const router = Router();

const uuidSchema = z.string().uuid();

// Mismo patrón que `routes/admin/reviews.ts`: guard local de superadmin.
// El frontend de este endpoint aún no existe (no hay pantalla /admin para
// destacar agencias); la superficie backend queda lista primero.
function requireSuperadmin(req: { ctx?: { role: string } }) {
  if (req.ctx?.role !== 'superadmin') {
    throw new AppError(
      'Se requiere una cuenta de superadmin',
      403,
      'SUPERADMIN_REQUIRED',
    );
  }
}

const updateBodySchema = z
  .object({
    is_featured: z.boolean().optional(),
    featured_order: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

/**
 * PATCH /api/admin/agencies/:agencyId
 * Destacado y orden manual de una agencia en el directorio público
 * (REP-001). Solo superadmin autenticado. Sin UI todavía.
 *
 * Body: `{ is_featured?: boolean, featured_order?: number }` — al menos
 * uno. Las reglas de negocio (reset de orden al quitar el destacado,
 * rechazo de orden > 0 sin destacado, 404 si no existe) viven en
 * `adminUpdateAgencyShowcase`.
 */
router.patch('/:agencyId', auth, async (req, res, next) => {
  try {
    requireSuperadmin(req);

    const agencyId = uuidSchema.safeParse(req.params.agencyId);
    if (!agencyId.success) {
      throw new AppError('Agencia no encontrada', 404, 'AGENCY_NOT_FOUND');
    }

    const parsed = updateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Datos inválidos', parsed.error.issues);
    }

    const result = await adminUpdateAgencyShowcase({
      agencyId: agencyId.data,
      isFeatured: parsed.data.is_featured,
      featuredOrder: parsed.data.featured_order,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
