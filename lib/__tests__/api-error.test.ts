import { describe, expect, it } from 'vitest';
import {
  ApiError,
  getApiErrorMessage,
  publicMessageForStatus,
  PUBLIC_ERROR_MESSAGES,
} from '@/lib/errors/api-error';

/** AuthError simulado de Supabase: name/status/code + message crudo interno. */
class FakeSupabaseAuthError extends Error {
  status = 401;
  code = 'bad_jwt';
  constructor() {
    super(
      'invalid JWT: unable to parse or verify signature, token is unverifiable: ' +
        'unrecognized JWT kid bc243679 for algorithm ES256',
    );
    this.name = 'AuthError';
  }
}

describe('getApiErrorMessage — política pública (SEC-02)', () => {
  it('nunca expone el mensaje crudo de un AuthError de Supabase', () => {
    const msg = getApiErrorMessage(new FakeSupabaseAuthError());
    expect(msg).toBe(PUBLIC_ERROR_MESSAGES.SESSION_INVALID);
    expect(msg).not.toContain('ES256');
    expect(msg).not.toContain('kid');
  });

  it('un fallo de red (TypeError) muestra copy de conectividad', () => {
    expect(getApiErrorMessage(new TypeError('Failed to fetch'))).toBe(
      PUBLIC_ERROR_MESSAGES.CONNECTIVITY,
    );
  });

  it('una excepción inesperada muestra copy genérica sin filtrar internals', () => {
    const msg = getApiErrorMessage(new Error('relation "public.users" does not exist'));
    expect(msg).toBe(PUBLIC_ERROR_MESSAGES.UNEXPECTED);
    expect(msg).not.toContain('users');
    expect(msg).not.toContain('relation');
  });

  it('conserva el mensaje seguro de un ApiError del backend (validación)', () => {
    const msg = getApiErrorMessage(
      new ApiError('La contraseña debe tener al menos 6 caracteres', 'VALIDATION_ERROR', 400),
    );
    expect(msg).toBe('La contraseña debe tener al menos 6 caracteres');
  });

  it('conserva el mensaje controlado de credenciales incorrectas', () => {
    const msg = getApiErrorMessage(
      new ApiError('Correo o contraseña incorrectos', 'UNAUTHORIZED', 401),
    );
    expect(msg).toBe('Correo o contraseña incorrectos');
  });

  it('traduce SESSION_ESTABLISH_FAILED a copy pública de sesión', () => {
    const msg = getApiErrorMessage(
      new ApiError('whatever', 'SESSION_ESTABLISH_FAILED', 401),
    );
    expect(msg).toBe(PUBLIC_ERROR_MESSAGES.SESSION_INVALID);
  });

  it('traduce CHECKOUT_WINDOW_EXPIRED al copy aprobado', () => {
    const msg = getApiErrorMessage(
      new ApiError('ventana de revisión vencida', 'CHECKOUT_WINDOW_EXPIRED', 409),
    );
    expect(msg).toBe('El tiempo de revisión expiró. Vuelve a intentar tu reserva.');
  });
});

describe('publicMessageForStatus (SEC-02)', () => {
  it('distingue sesión, conectividad y rate limit por categoría', () => {
    expect(publicMessageForStatus(401)).toBe(PUBLIC_ERROR_MESSAGES.SESSION_INVALID);
    expect(publicMessageForStatus(429)).toBe(PUBLIC_ERROR_MESSAGES.RATE_LIMITED);
    expect(publicMessageForStatus(503)).toBe(PUBLIC_ERROR_MESSAGES.CONNECTIVITY);
    expect(publicMessageForStatus(500)).toBe(PUBLIC_ERROR_MESSAGES.UNEXPECTED);
  });
});
