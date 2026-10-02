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

  if (dbUser.role !== 'superadmin' && dbUser.role !== 'customer') {
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
    throw new UnauthorizedError('Token inválido o expirado');
  }

  req.ctx = await extractContext(user);
  next();
}
