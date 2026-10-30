import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, PUBLIC_ERROR_MESSAGES } from '@/lib/errors/api-error';

const setSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { setSession } }),
}));

import { establishSupabaseSession } from '@/lib/auth/session';

describe('establishSupabaseSession — SEC-02 (fuga ES256)', () => {
  beforeEach(() => setSession.mockReset());

  it('lanza un ApiError controlado cuando setSession falla (no el AuthError crudo)', async () => {
    const rawAuthError = Object.assign(
      new Error(
        'invalid JWT: unable to parse or verify signature, token is unverifiable: ' +
          'unrecognized JWT kid bc243679 for algorithm ES256',
      ),
      { name: 'AuthError', status: 401, code: 'bad_jwt' },
    );
    setSession.mockResolvedValue({ data: { session: null }, error: rawAuthError });

    const err = await establishSupabaseSession('a', 'r').catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('SESSION_ESTABLISH_FAILED');
    expect(err.message).toBe(PUBLIC_ERROR_MESSAGES.SESSION_INVALID);
    expect(err.message).not.toContain('ES256');
    expect(err.message).not.toContain('kid');
  });

  it('no lanza nada cuando setSession resuelve sin error', async () => {
    setSession.mockResolvedValue({
      data: { session: { access_token: 'a' } },
      error: null,
    });
    await expect(establishSupabaseSession('a', 'r')).resolves.toBeUndefined();
  });
});
