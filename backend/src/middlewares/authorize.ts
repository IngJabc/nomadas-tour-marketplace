import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/database.js';
import { AppError, ForbiddenError, NotFoundError } from '../errors/index.js';

/**
 * Exige un usuario autenticado con rol `agency` y un `agencyId` válido.
 * La autenticación (JWT) ya la resolvió `auth`; aquí solo se valida el
 * rol y la presencia del agency_id necesario para ownership.
 */
export function requireAgency(req: Request, _res: Response, next: NextFunction) {
  if (req.ctx?.role !== 'agency') {
    throw new ForbiddenError('Se requiere una cuenta de agencia');
  }
  if (!req.ctx.agencyId) {
    throw new ForbiddenError('La cuenta de agencia no tiene una agencia asignada');
  }
  next();
}

type OwnedResource = 'payment' | 'reservation';

const TABLE_BY_RESOURCE: Record<OwnedResource, string> = {
  payment: 'payments',
  reservation: 'reservations',
};

/**
 * Middleware factory que verifica que el recurso identificado por
 * `req.params[paramKey]` pertenece a la agencia autenticada.
 *
 * Seguridad multi-tenant:
 * - El `agency_id` del recurso se consulta en el servidor, nunca se
 *   acepta del cliente.
 * - Si el recurso no existe O pertenece a otra agencia, se responde
 *   404 con el mismo mensaje: no se filtra la existencia de recursos
 *   ajenos.
 * - Una sola consulta por request (el recurso se cachea en res.locals
 *   para que el handler no lo vuelva a pedir).
 */
export function verifyAgencyOwnership(
  resource: OwnedResource,
  paramKey: string,
) {
  const table = TABLE_BY_RESOURCE[resource];

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const resourceId = req.params[paramKey];
      if (!resourceId) {
        throw new NotFoundError('Recurso no encontrado');
      }

      const agencyId = req.ctx?.agencyId;
      if (!agencyId) {
        throw new ForbiddenError('La cuenta de agencia no tiene una agencia asignada');
      }

      const { data, error } = await supabaseAdmin
        .from(table)
        .select('id, agency_id')
        .eq('id', resourceId)
        .maybeSingle();

      if (error) {
        throw new AppError(
          'No se pudo verificar el recurso. Intenta de nuevo',
          500,
          'INTERNAL_ERROR',
        );
      }

      // Mismo 404 para "no existe" y "es de otra agencia".
      if (!data || (data as { agency_id: string | null }).agency_id !== agencyId) {
        throw new NotFoundError('Recurso no encontrado');
      }

      // Cachea el recurso para que el handler no repita la consulta.
      res.locals[`${resource}Id`] = resourceId;
      next();
    } catch (error) {
      next(error);
    }
  };
}
