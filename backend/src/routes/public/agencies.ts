import { Router } from 'express';
import { z } from 'zod';
import { AppError, ValidationError } from '../../errors/index.js';
import { getPublicAgency, listPublicAgencies } from '../../services/agency.service.js';

const router = Router();

const uuidSchema = z.string().uuid();

// `origin`/`destination` vacíos (o solo espacios) se tratan como "sin
// filtro": el servicio los evalúa en booleano. Un valor demasiado largo
// sí es 400.
const optionalText = z.string().trim().max(120).optional();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const profileQuerySchema = z.object({
  origin: optionalText,
  destination: optionalText,
  // Se valida como día real YYYY-MM-DD dentro del servicio (400 con copy
  // controlado), nunca se confía en el formato del cliente.
  date: z.string().trim().max(10).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/public/agencies
 * Directorio público de agencias (REP-001). Solo agencias activas, con
 * branding, calificaciones separadas (agencia / viaje) y número de viajes
 * publicados. Orden manual persistente del superadmin:
 * `is_featured DESC, featured_order ASC, name ASC`.
 *
 * Sin PII: jamás expone email, métodos de pago ni datos de clientes.
 */
router.get('/', async (req, res, next) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Parámetros inválidos', parsed.error.issues);
    }

    const result = await listPublicAgencies(parsed.data);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/public/agencies/:agencyId
 * Perfil público de una agencia (REP-001): identidad, branding, contactos
 * PÚBLICOS (091) + teléfono legado, calificaciones separadas, estadística
 * de viajes publicados y su página de viajes.
 *
 * Filtros de viajes (server-side): origin, destination (ILIKE sobre
 * `routes`) y date (día de negocio America/Caracas). La elegibilidad
 * (active + is_published + salida futura) también se aplica en el servidor.
 *
 * 404 AGENCY_NOT_FOUND si no existe o no está activa.
 */
router.get('/:agencyId', async (req, res, next) => {
  try {
    const agencyId = uuidSchema.safeParse(req.params.agencyId);
    if (!agencyId.success) {
      throw new AppError('Agencia no encontrada', 404, 'AGENCY_NOT_FOUND');
    }

    const parsed = profileQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Parámetros inválidos', parsed.error.issues);
    }

    const { agency } = await getPublicAgency({
      agencyId: agencyId.data,
      origin: parsed.data.origin,
      destination: parsed.data.destination,
      date: parsed.data.date,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    res.json({ agency });
  } catch (error) {
    next(error);
  }
});

export default router;
