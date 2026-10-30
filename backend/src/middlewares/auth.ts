import { Request, Response, NextFunction } from 'express';
import { supabase, supabaseAdmin } from '../config/database.js';
import { UnauthorizedError } from '../errors/index.js';
import { RequestContext } from '../types/index.js';

declare global {
  namespace Express {
    interface Request {
      ctx?: RequestContext;
    }
  }
}

async function extractContext(user: { id: string }): Promise<RequestContext> {
  const { data: dbUser, error } = await supabaseAdmin
    .from('users')
    .select('id, role, agency_id')
    .eq('id', user.id)
    .maybeSingle();

  if (error || !dbUser) {
    throw new UnauthorizedError('Usuario no registrado');
  }

  if (
    dbUser.role !== 'superadmin' &&
    dbUser.role !== 'customer' &&
    dbUser.role !== 'agency'
  ) {
    throw new UnauthorizedError('Usuario no registrado');
  }

  // Un usuario de agency SIEMPRE debe tener agency_id: es la base del
  // aislamiento multi-tenant. Sin él no hay ownership verificable.
  if (dbUser.role === 'agency' && !dbUser.agency_id) {
    throw new UnauthorizedError('Usuario no registrado');
  }

  return {
    userId: dbUser.id,
    role: dbUser.role as RequestContext['role'],
    agencyId: dbUser.agency_id ?? null,
  };
}

export async function auth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Falta o es inválido el encabezado de autorización');
  }

  const token = header.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    // SEC-02: el error crudo de Supabase (firma, kid, expiración, proyecto
    // equivocado, etc.) NUNCA se expone. Se registra el detalle interno sin
    // el token para diagnóstico y se responde un mensaje público controlado.
    console.warn(
      '[auth] getUser failed:',
      error?.name,
      error?.status,
      error?.message,
    );
    throw new UnauthorizedError('No pudimos validar tu sesión. Inicia sesión nuevamente.');
  }

  req.ctx = await extractContext(user);
  next();
}
