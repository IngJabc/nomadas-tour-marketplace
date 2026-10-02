import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { RequestContext } from '../types/index.js';

export function signToken(ctx: Omit<RequestContext, 'tenantId'> & { tenantId?: string | null }): string {
  return jwt.sign(ctx, env.JWT_SECRET, { expiresIn: '7d' });
}
