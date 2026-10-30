import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { errorHandler } from './error-handler.js';
import {
  AppError,
  InternalError,
  UnauthorizedError,
  ValidationError,
} from '../errors/index.js';
import { resetSentryForTests } from '../observability/sentry.js';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
});

const GENERIC =
  'No pudimos completar la operación en este momento. Inténtalo nuevamente.';

function mockRes(): Response & { status: any; json: any } {
  const res = {} as Response;
  (res as any).status = vi.fn().mockReturnValue(res);
  (res as any).json = vi.fn().mockReturnValue(res);
  return res as any;
}

describe('errorHandler — política de errores públicos (SEC-02)', () => {
  beforeEach(() => resetSentryForTests());

  it('InternalError nunca expone el mensaje crudo (Supabase/PG/JWT)', () => {
    const res = mockRes();
    const raw =
      'invalid JWT: unable to parse or verify signature, token is unverifiable: ' +
      'error while executing keyfunc: unrecognized JWT kid bc243679 for algorithm ES256';
    errorHandler(
      new InternalError('TRIP_QUERY_ERROR', raw),
      {} as Request,
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.error.code).toBe('TRIP_QUERY_ERROR');
    expect(body.error.message).toBe(GENERIC);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('ES256');
    expect(serialized).not.toContain('kid');
    expect(serialized).not.toContain('unverifiable');
    expect(typeof body.error.request_id).toBe('string');
  });

  it('InternalError tampoco expone nombres de tablas de PostgreSQL', () => {
    const res = mockRes();
    errorHandler(
      new InternalError('SEATS_QUERY_ERROR', 'relation "public.secret_table" does not exist'),
      {} as Request,
      res,
      vi.fn(),
    );
    const serialized = JSON.stringify((res.json as any).mock.calls[0][0]);
    expect(serialized).not.toContain('secret_table');
    expect(serialized).not.toContain('relation');
  });

  it('AppError 4xx conserva su mensaje público (credenciales)', () => {
    const res = mockRes();
    errorHandler(
      new UnauthorizedError('Correo o contraseña incorrectos'),
      {} as Request,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(401);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toBe('Correo o contraseña incorrectos');
  });

  it('ValidationError conserva mensaje y details útiles', () => {
    const res = mockRes();
    errorHandler(
      new ValidationError('La contraseña debe tener al menos 6 caracteres', [
        { field: 'password' },
      ]),
      {} as Request,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('La contraseña debe tener al menos 6 caracteres');
    expect(body.error.details).toEqual([{ field: 'password' }]);
  });

  it('AppError 5xx con copy autorizado se conserva (checkout)', () => {
    const res = mockRes();
    errorHandler(
      new AppError('No se pudo procesar la compra. Intenta de nuevo', 500, 'CHECKOUT_ERROR'),
      {} as Request,
      res,
      vi.fn(),
    );
    const body = (res.json as any).mock.calls[0][0];
    expect(body.error.code).toBe('CHECKOUT_ERROR');
    expect(body.error.message).toBe('No se pudo procesar la compra. Intenta de nuevo');
  });

  it('error no controlado responde genérico, sin stack trace ni internals', () => {
    const res = mockRes();
    const err = new Error('column trips.secret_col does not exist');
    errorHandler(err, {} as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe(GENERIC);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret_col');
    expect(serialized).not.toContain('does not exist');
    expect(serialized).not.toContain('    at '); // sin stack frame
  });
});
