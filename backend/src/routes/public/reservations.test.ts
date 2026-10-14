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
    getUser: (token: string) => Promise<any>;
  } = {
    queues: {},
    defaults: {},
    chains: [],
    rpcCalls: [],
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
      'lt',
      'lte',
      'gt',
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
    const record = {
      table: `rpc:${fn}`,
      calls: [{ method: 'rpc', args: [args] }],
    };
    state.chains.push(record);
    const thenable = {
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected),
    };
    return thenable;
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
    },
    setUser(handler: (token: string) => Promise<any>) {
      state.getUser = handler;
    },
    chains: () => state.chains,
    rpcCalls: () => state.rpcCalls,
    from: (table: string) => buildChain(table),
    rpc: (fn: string, args: any) => buildRpc(fn, args),
    auth: { getUser: (token: string) => state.getUser(token) },
  };
});

vi.mock('../../config/database.js', () => ({
  supabase: harness,
  supabaseAdmin: harness,
  createAuthenticatedClient: vi.fn(),
}));

import app from '../../app.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const SUPERADMIN_ID = '55555555-5555-4555-8555-555555555555';
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const AGENCY_ID = '5bf0be5d-c03a-431f-97d5-e2a065e25752';
const SEAT_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ALLOWED_ORIGIN = 'http://localhost:3002';

function validPayload() {
  return {
    trip_id: TRIP_ID,
    agency_id: AGENCY_ID,
    seat_ids: [SEAT_A1],
    passengers: [
      {
        seat_id: SEAT_A1,
        first_name: 'Ana',
        last_name: 'Perez',
        document: '12345678',
        phone: '04241234567',
      },
    ],
  };
}

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

async function postReservation(
  port: number,
  options: { token?: string | null; origin?: string | null } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? 'token'}`;
  }
  if (options.origin) {
    headers.Origin = options.origin;
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/public/reservations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(validPayload()),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

/**
 * MKT-007: este endpoint quedó DESACTIVADO. La compra nace en
 * `POST /api/public/checkout/attempts` y la reserva definitiva solo en la
 * aprobación atómica `verify_checkout_attempt`. Cualquier cliente viejo
 * recibe 410 + `CHECKOUT_ATTEMPTS_REQUIRED`, nunca una reserva parcial.
 */
describe('POST /api/public/reservations (desactivado por MKT-007)', () => {
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
    const { status, body } = await postReservation(port);

    expect(status).toBe(410);
    expect(body.error.code).toBe('CHECKOUT_ATTEMPTS_REQUIRED');
    expect(body.error.message).toContain('/api/public/checkout/attempts');
  });

  it('sigue exigiendo autenticación antes del 410', async () => {
    const { status, body } = await postReservation(port, { token: null });

    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('sigue bloqueando el origen de sesión guest no permitido', async () => {
    const { status, body } = await postReservation(port, {
      origin: 'http://evil.example',
    });

    expect(status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('un origen permitido cae en el 410, no en un 201', async () => {
    const { status, body } = await postReservation(port, {
      origin: ALLOWED_ORIGIN,
    });

    expect(status).toBe(410);
    expect(body.error.code).toBe('CHECKOUT_ATTEMPTS_REQUIRED');
  });

  it('nunca llama a create_marketplace_reservation ni escribe tablas', async () => {
    await postReservation(port);
    // Reintento de un cliente viejo: sigue sin crear nada.
    await postReservation(port);

    expect(harness.rpcCalls()).toHaveLength(0);
    expect(harness.rpcCalls().map((call) => call.fn)).not.toContain(
      'create_marketplace_reservation',
    );
    const nonAuthTables = harness
      .chains()
      .map((chain) => chain.table)
      .filter((table) => table !== 'users');
    expect(nonAuthTables).toHaveLength(0);
  });

  it('un superadmin tampoco recibe una reserva: el flujo ya no existe', async () => {
    harness.reset();
    harness.setUser(() =>
      Promise.resolve({ data: { user: { id: SUPERADMIN_ID } }, error: null }),
    );
    harness.setDefault('users', {
      data: { id: SUPERADMIN_ID, role: 'superadmin', agency_id: null },
      error: null,
    });

    const { status, body } = await postReservation(port);

    expect(status).toBe(410);
    expect(body.error.code).toBe('CHECKOUT_ATTEMPTS_REQUIRED');
    expect(harness.rpcCalls()).toHaveLength(0);
  });
});
