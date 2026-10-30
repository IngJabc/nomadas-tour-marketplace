import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.CORS_ORIGIN = 'http://localhost:3002';
  process.env.RESEND_API_KEY = 'test';
  process.env.EMAIL_FROM = 'test@example.com';
  process.env.FRONTEND_URL = 'http://localhost:3002';
});

const getUser = vi.hoisted(() => vi.fn());
const maybeSingle = vi.hoisted(() => vi.fn());

vi.mock('../config/database.js', () => ({
  supabase: { auth: { getUser } },
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  },
}));

import { auth } from './auth.js';

function reqWithAuth(header?: string) {
  return { headers: header ? { authorization: header } : {} } as any;
}

describe('auth middleware — fallos JWT controlados (SEC-02)', () => {
  beforeEach(() => {
    getUser.mockReset();
    maybeSingle.mockReset();
  });

  it('JWT con firma/kid inválido (ES256) responde 401 sin exponer internals', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: 'AuthApiError',
        status: 401,
        message:
          'invalid JWT: unable to parse or verify signature, token is unverifiable: ' +
          'unrecognized JWT kid bc243679-4713 for algorithm ES256',
      },
    });

    const next = vi.fn();
    const error = await auth(reqWithAuth('Bearer bad'), {} as any, next).catch((e) => e);

    expect(error).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(error.message).toBe('No pudimos validar tu sesión. Inicia sesión nuevamente.');
    expect(error.message).not.toContain('ES256');
    expect(error.message).not.toContain('kid');
    expect(next).not.toHaveBeenCalled();
  });

  it('JWT expirado responde 401 controlado', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', status: 401, message: 'jwt expired' },
    });

    const error = await auth(reqWithAuth('Bearer expired'), {} as any, vi.fn()).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(error.message).toBe('No pudimos validar tu sesión. Inicia sesión nuevamente.');
  });

  it('JWT con firma ilegible responde 401 controlado', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', status: 400, message: 'token must be a compact JWS' },
    });

    const error = await auth(reqWithAuth('Bearer garbage'), {} as any, vi.fn()).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(error.message).not.toContain('JWS');
  });

  it('sin header Authorization responde 401 controlado', async () => {
    const error = await auth(reqWithAuth(), {} as any, vi.fn()).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
  });

  it('token válido construye el contexto y llama next', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    maybeSingle.mockResolvedValue({
      data: { id: 'u1', role: 'customer', agency_id: null },
      error: null,
    });

    const next = vi.fn();
    const req = reqWithAuth('Bearer valid');
    await auth(req, {} as any, next);
    expect(next).toHaveBeenCalled();
    expect(req.ctx).toMatchObject({ userId: 'u1', role: 'customer' });
  });
});
