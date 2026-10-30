import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, PUBLIC_ERROR_MESSAGES } from '@/lib/errors/api-error';

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

import { request } from '@/lib/api';

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe('request() — manejo de errores técnicos (SEC-02)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(503, { error: null })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('una respuesta 503 sin envelope produce copy de conectividad (no HTML crudo)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 503,
        ok: false,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      }),
    );

    const err = (await request('/public/trips').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err.message).toBe(PUBLIC_ERROR_MESSAGES.CONNECTIVITY);
  });

  it('un envelope del backend se interpreta con su code y message controlados', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          error: { code: 'UNAUTHORIZED', message: 'Correo o contraseña incorrectos' },
        }),
      ),
    );

    const err = (await request('/auth/login', { method: 'POST' }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Correo o contraseña incorrectos');
  });

  it('una respuesta 401 sin envelope usa copy pública de sesión', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { unexpected: 'shape' })),
    );

    const err = (await request('/auth/me').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(PUBLIC_ERROR_MESSAGES.SESSION_INVALID);
  });

  it('una respuesta técnica 500 con mensaje crudo del backend no rompe el parseo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(500, {
          error: { code: 'TRIP_QUERY_ERROR', message: 'No pudimos completar la operación en este momento. Inténtalo nuevamente.' },
        }),
      ),
    );

    const err = (await request('/public/trips').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('TRIP_QUERY_ERROR');
    // El backend ya sanea: se conserva su copy pública.
    expect(err.message).not.toContain('relation');
  });
});
