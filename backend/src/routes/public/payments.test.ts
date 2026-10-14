import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  process.env.JWT_SECRET = 'test-jwt-secret-for-app-tests';
  process.env.CORS_ORIGIN = 'http://localhost:3002';
  process.env.RESEND_API_KEY = 'test-resend';
  process.env.EMAIL_FROM = 'test@example.com';
  process.env.FRONTEND_URL = 'http://localhost:3002';
  delete process.env.LOCK_TTL_SECONDS;
});

const harness = vi.hoisted(() => {
  type QueryResult = { data?: any; error?: { message: string } | null };

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    chains: Array<{ table: string; calls: Array<{ method: string; args: any[] }> }>;
    rpcCalls: Array<{ fn: string; args: any }>;
    uploads: Array<{ bucket: string; path: string }>;
    getUser: (token: string) => Promise<any>;
  } = {
    queues: {},
    defaults: {},
    chains: [],
    rpcCalls: [],
    uploads: [],
    getUser: () =>
      Promise.resolve({ data: { user: null }, error: { message: 'anonymous' } }),
  };

  function buildChain(table: string) {
    const record = { table, calls: [] as Array<{ method: string; args: any[] }> };
    state.chains.push(record);
    const chain: Record<string, any> = {};
    for (const method of [
      'select',
      'update',
      'insert',
      'upsert',
      'delete',
      'eq',
      'neq',
      'in',
      'order',
      'limit',
      'maybeSingle',
      'single',
    ]) {
      chain[method] = (...args: any[]) => {
        record.calls.push({ method, args });
        return chain;
      };
    }
    chain.then = (onFulfilled: any, onRejected: any) => {
      const queue = state.queues[table];
      const result =
        queue && queue.length > 0
          ? queue.shift()!
          : state.defaults[table] ?? { data: null, error: null };
      return Promise.resolve(result).then(onFulfilled, onRejected);
    };
    return chain;
  }

  function buildRpc(fn: string, args: any) {
    state.rpcCalls.push({ fn, args });
    return {
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected),
    };
  }

  return {
    push(table: string, result: QueryResult) {
      (state.queues[table] ||= []).push(result);
    },
    setDefault(table: string, result: QueryResult) {
      state.defaults[table] = result;
    },
    reset() {
      state.chains = [];
      state.queues = {};
      state.defaults = {};
      state.rpcCalls = [];
      state.uploads = [];
    },
    setUser(handler: (token: string) => Promise<any>) {
      state.getUser = handler;
    },
    chains: () => state.chains,
    rpcCalls: () => state.rpcCalls,
    uploads: () => state.uploads,
    from: (table: string) => buildChain(table),
    rpc: (fn: string, args: any) => buildRpc(fn, args),
    auth: { getUser: (token: string) => state.getUser(token) },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string) => {
            state.uploads.push({ bucket, path });
            return { data: { path }, error: null };
          },
          remove: async () => ({ data: null, error: null }),
        };
      },
    },
  };
});

vi.mock('../../config/database.js', () => ({
  supabase: harness,
  supabaseAdmin: harness,
  createAuthenticatedClient: vi.fn(),
}));

import app from '../../app.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const ALLOWED_ORIGIN = 'http://localhost:3002';

function givenAuthAs(userId: string) {
  harness.setUser(() =>
    Promise.resolve({ data: { user: { id: userId } }, error: null }),
  );
}

async function startServer(): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function postPayment(
  port: number,
  options: { token?: string | null; origin?: string | null } = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? 'token'}`;
  }
  if (options.origin) {
    headers.Origin = options.origin;
  }
  const res = await fetch(
    `http://127.0.0.1:${port}/api/public/reservations/${RESERVATION_ID}/payments`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ proof_url: 'reservations/x/proof.png' }),
    },
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

/**
 * MKT-007: el comprobante ya no se somete contra una reserva (esa reserva
 * ya no existe antes de la revisión). El endpoint quedó DESACTIVADO con
 * 410 + `CHECKOUT_ATTEMPTS_REQUIRED`; el envío real vive en
 * `POST /api/public/checkout/attempts/:attemptId/proof` y exige además
 * referencia, banco y fecha-hora de la transferencia.
 */
describe('POST /api/public/reservations/:reservationId/payments (desactivado por MKT-007)', () => {
  let server: Server | null = null;
  let port = 0;

  beforeAll(async () => {
    server = await startServer();
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (!server) return;
    const closing = server;
    server = null;
    await new Promise<void>((resolve, reject) => {
      closing.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    harness.reset();
    givenAuthAs(CUSTOMER_ID);
    harness.setDefault('users', {
      data: { id: CUSTOMER_ID, role: 'customer', agency_id: null },
      error: null,
    });
  });

  it('responde 410 CHECKOUT_ATTEMPTS_REQUIRED a un customer autenticado', async () => {
    const { status, body } = await postPayment(port);

    expect(status).toBe(410);
    expect(body.error.code).toBe('CHECKOUT_ATTEMPTS_REQUIRED');
    expect(body.error.message).toContain(
      '/api/public/checkout/attempts/:attemptId/proof',
    );
  });

  it('sigue exigiendo autenticación antes del 410', async () => {
    const { status, body } = await postPayment(port, { token: null });

    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('sigue bloqueando el origen de sesión guest no permitido', async () => {
    const { status, body } = await postPayment(port, {
      origin: 'http://evil.example',
    });

    expect(status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('un origen permitido cae en el 410', async () => {
    const { status, body } = await postPayment(port, { origin: ALLOWED_ORIGIN });

    expect(status).toBe(410);
    expect(body.error.code).toBe('CHECKOUT_ATTEMPTS_REQUIRED');
  });

  it('nunca sube el archivo ni llama al RPC antiguo', async () => {
    await postPayment(port);
    await postPayment(port);

    expect(harness.rpcCalls()).toHaveLength(0);
    expect(harness.rpcCalls().map((call) => call.fn)).not.toContain(
      'submit_marketplace_payment',
    );
    expect(harness.uploads()).toHaveLength(0);
    const nonAuthTables = harness
      .chains()
      .map((chain) => chain.table)
      .filter((table) => table !== 'users');
    expect(nonAuthTables).toHaveLength(0);
  });
});
