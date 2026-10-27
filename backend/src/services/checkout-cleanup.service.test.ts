import { beforeEach, describe, expect, it, vi } from 'vitest';

// MKT-010: el servicio de expiración del checkout. Estas pruebas blindan
// el INVOCADOR de `cleanup_expired_checkout_attempts`: el orden cleanup →
// release, el aislamiento de locks ajenos en el release directo y la
// tolerancia a fallos (el loop periódico nunca debe caerse por un error
// de limpieza; la RPC es idempotente y el próximo ciclo reintenta).

const harness = vi.hoisted(() => {
  type Result = { data?: unknown; error?: { message: string } | null };

  const state: {
    rpcResults: Result[];
    rpcThrow: Error | null;
    events: string[];
    updateChain: Array<{ method: string; args: unknown[] }>;
    updateResult: Result;
  } = {
    rpcResults: [],
    rpcThrow: null,
    events: [],
    updateChain: [],
    updateResult: { data: [], error: null },
  };

  function buildUpdateChain() {
    const chain: Record<string, unknown> = {};
    for (const method of ['update', 'eq', 'lt', 'is', 'select']) {
      chain[method] = (...args: unknown[]) => {
        state.updateChain.push({ method, args });
        state.events.push(`update:${method}`);
        return chain;
      };
    }
    chain.then = (onFulfilled: unknown, onRejected: unknown) => {
      state.events.push('update:exec');
      return Promise.resolve(state.updateResult).then(
        onFulfilled as never,
        onRejected as never,
      );
    };
    return chain;
  }

  return {
    from(table: string) {
      if (table !== 'seats') throw new Error(`unexpected table ${table}`);
      return buildUpdateChain();
    },
    rpc(fn: string) {
      state.events.push(`rpc:${fn}`);
      if (state.rpcThrow) throw state.rpcThrow;
      const result = state.rpcResults.shift() ?? {
        data: { expired: 0, freed_seats: 0, attempt_ids: [] },
        error: null,
      };
      return {
        then: (onFulfilled: unknown, onRejected: unknown) =>
          Promise.resolve(result).then(onFulfilled as never, onRejected as never),
      };
    },
    setRpcResults(results: Result[]) {
      state.rpcResults = results;
    },
    setRpcThrow(error: Error | null) {
      state.rpcThrow = error;
    },
    setUpdateResult(result: Result) {
      state.updateResult = result;
    },
    events: () => state.events,
    updateChain: () => state.updateChain,
    reset() {
      state.rpcResults = [];
      state.rpcThrow = null;
      state.events = [];
      state.updateChain = [];
      state.updateResult = { data: [], error: null };
    },
  };
});

vi.mock('../config/database.js', () => ({
  supabaseAdmin: harness,
  supabase: harness,
  createAuthenticatedClient: vi.fn(),
}));

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  fingerprintHttpError: vi.fn(() => ['fingerprint']),
}));

vi.mock('../observability/sentry.js', () => sentry);

import {
  releaseExpiredSeatLocks,
  runCheckoutCleanup,
  runPeriodicCheckoutCleanup,
} from './checkout-cleanup.service.js';

const CLEANUP_FN = 'cleanup_expired_checkout_attempts';

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
});

describe('runCheckoutCleanup (MKT-010)', () => {
  it('invoca exactamente la RPC de expiración de 087 y normaliza el resultado', async () => {
    harness.setRpcResults([
      {
        data: {
          expired: 2,
          freed_seats: 3,
          attempt_ids: ['att-1', 'att-2'],
        },
        error: null,
      },
    ]);

    const result = await runCheckoutCleanup();

    expect(harness.events()).toEqual([`rpc:${CLEANUP_FN}`]);
    expect(result).toEqual({
      expired: 2,
      freed_seats: 3,
      attempt_ids: ['att-1', 'att-2'],
    });
  });

  it('un fallo de la RPC devuelve null sin lanzar (el loop sigue vivo)', async () => {
    harness.setRpcResults([{ data: null, error: { message: 'db down' } }]);

    const result = await runCheckoutCleanup();

    expect(result).toBeNull();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('un throw inesperado también se captura sin propagar', async () => {
    harness.setRpcThrow(new Error('transporte caído'));

    await expect(runCheckoutCleanup()).resolves.toBeNull();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('releaseExpiredSeatLocks (MKT-010)', () => {
  it('libera solo locks vencidos SIN intento de compra (aislamiento)', async () => {
    harness.setUpdateResult({ data: [{ id: 's1' }], error: null });

    const { released } = await releaseExpiredSeatLocks();

    expect(released).toBe(1);
    const methods = harness.updateChain().map((call) => call.method);
    expect(methods).toContain('eq');
    expect(methods).toContain('lt');
    expect(methods).toContain('is');
    const attemptGuard = harness
      .updateChain()
      .find((call) => call.method === 'is');
    expect(attemptGuard?.args).toEqual(['checkout_attempt_id', null]);
    const statusGuard = harness
      .updateChain()
      .find((call) => call.method === 'eq');
    expect(statusGuard?.args).toEqual(['status', 'locked']);
  });

  it('propaga el error de base de datos (el caller del loop lo captura)', async () => {
    harness.setUpdateResult({ data: null, error: { message: 'update failed' } });

    await expect(releaseExpiredSeatLocks()).rejects.toThrow('update failed');
  });
});

describe('runPeriodicCheckoutCleanup (MKT-010)', () => {
  it('ejecuta el cleanup ANTES del release directo de locks', async () => {
    harness.setRpcResults([
      { data: { expired: 1, freed_seats: 2, attempt_ids: ['att-1'] }, error: null },
    ]);
    harness.setUpdateResult({ data: [], error: null });

    const result = await runPeriodicCheckoutCleanup();

    expect(result.cleanup?.expired).toBe(1);
    expect(result.released).toBe(0);
    const events = harness.events();
    expect(events[0]).toBe(`rpc:${CLEANUP_FN}`);
    expect(events.indexOf('update:exec')).toBeGreaterThan(
      events.indexOf(`rpc:${CLEANUP_FN}`),
    );
  });

  it('si el cleanup falla, el release directo corre protegido por el guard de intentos', async () => {
    harness.setRpcResults([{ data: null, error: { message: 'rpc down' } }]);
    harness.setUpdateResult({ data: [], error: null });

    const result = await runPeriodicCheckoutCleanup();

    expect(result.cleanup).toBeNull();
    const attemptGuard = harness
      .updateChain()
      .find((call) => call.method === 'is');
    expect(attemptGuard?.args).toEqual(['checkout_attempt_id', null]);
  });
});
