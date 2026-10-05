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
  type ChainRecord = {
    table: string;
    calls: Array<{ method: string; args: any[] }>;
  };

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    chains: ChainRecord[];
    getUser: (token: string) => Promise<any>;
  } = {
    queues: {},
    defaults: {},
    chains: [],
    getUser: () =>
      Promise.resolve({ data: { user: null }, error: { message: 'missing session' } }),
  };

  function buildChain(table: string) {
    const record: ChainRecord = { table, calls: [] };
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

  return {
    push(table: string, result: QueryResult) {
      (state.queues[table] ||= []).push(result);
    },
    setDefault(table: string, result: QueryResult) {
      state.defaults[table] = result;
    },
    setUser(handler: (token: string) => Promise<any>) {
      state.getUser = handler;
    },
    reset() {
      state.chains = [];
      state.queues = {};
      state.defaults = {};
    },
    chains: () => state.chains,
    from: (table: string) => buildChain(table),
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
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const SEAT_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SEAT_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

const activeTrip = { data: { id: TRIP_ID, status: 'active', capacity: 31 }, error: null };

function seatRow(overrides: Record<string, any> = {}) {
  return {
    id: SEAT_A1,
    trip_id: TRIP_ID,
    seat_code: 'A1',
    status: 'available',
    locked_by: null,
    lock_expires_at: null,
    ...overrides,
  };
}

function givenAuthAs(userId: string, role = 'customer') {
  harness.setUser(() =>
    Promise.resolve({ data: { user: { id: userId } }, error: null }),
  );
  harness.setDefault('users', {
    data: { id: userId, role, agency_id: null },
    error: null,
  });
}

function seatChains(table = 'seats') {
  return harness.chains().filter((chain) => chain.table === table);
}

function findChain(table: string, predicate: (calls: ChainRecordCalls) => boolean) {
  return harness
    .chains()
    .filter((chain) => chain.table === table)
    .find((chain) => predicate(chain.calls));
}

type ChainRecordCalls = Array<{ method: string; args: any[] }>;

async function startServer(): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
  token: string | null = 'token',
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function getJson(port: number, path: string, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('POST /api/public/seats/lock (MKT-004)', () => {
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
      closing.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    harness.reset();
    givenAuthAs(CUSTOMER_ID);
  });

  it('bloquea asientos disponibles con TTL de servidor 900 e ignora ttl_seconds del cliente', async () => {
    harness.push('trips', activeTrip);
    harness.push('seats', { data: [], error: null });
    harness.push('seats', {
      data: [seatRow(), seatRow({ id: SEAT_A2, seat_code: 'A2' })],
      error: null,
    });
    harness.push('seats', { data: [{ id: SEAT_A1 }, { id: SEAT_A2 }], error: null });

    const startedAt = Date.now();
    const { status, body } = await postJson(port, '/api/public/seats/lock', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1, SEAT_A2],
      ttl_seconds: 30,
    });

    expect(status).toBe(200);
    expect(body.locked).toBe(true);
    expect(body.ttl_seconds).toBe(900);
    expect(body.seats).toHaveLength(2);
    expect(body.seats[0]).toEqual({
      id: SEAT_A1,
      seat_code: 'A1',
      status: 'locked',
      locked_by: CUSTOMER_ID,
      lock_expires_at: body.lock_expires_at,
    });
    expect(body.seats[1].seat_code).toBe('A2');

    const expiresAt = new Date(body.lock_expires_at).getTime();
    const drift = expiresAt - startedAt;
    expect(drift).toBeGreaterThanOrEqual(900_000 - 5_000);
    expect(drift).toBeLessThanOrEqual(900_000 + 5_000);

    const acquire = findChain('seats', (calls) =>
      calls.some((c) => c.method === 'update' && c.args[0]?.status === 'locked'),
    );
    expect(acquire).toBeDefined();
    expect(acquire!.calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'available')).toBe(true);
    expect(acquire!.calls.some((c) => c.method === 'in' && c.args[0] === 'id')).toBe(true);

    const requestPayload = harness
      .chains()
      .map((chain) => chain.calls)
      .flat()
      .filter((c) => c.method === 'update');
    expect(requestPayload.every((c) => c.args[0]?.lock_expires_at !== undefined)).toBe(true);
  });

  it('rechaza con 409 cuando el asiento ya esta reservado', async () => {
    harness.push('trips', activeTrip);
    harness.push('seats', { data: [], error: null });
    harness.push('seats', { data: [seatRow({ status: 'reserved' })], error: null });

    const { status, body } = await postJson(port, '/api/public/seats/lock', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1],
    });

    expect(status).toBe(409);
    expect(body.error.code).toBe('SEAT_NOT_AVAILABLE');
    expect(
      findChain('seats', (calls) =>
        calls.some((c) => c.method === 'update' && c.args[0]?.status === 'locked'),
      ),
    ).toBeUndefined();
  });

  it('rechaza con 409 cuando el asiento esta bloqueado por otro usuario', async () => {
    harness.push('trips', activeTrip);
    harness.push('seats', { data: [], error: null });
    harness.push('seats', {
      data: [seatRow({ status: 'locked', locked_by: OTHER_ID, lock_expires_at: new Date(Date.now() + 600_000).toISOString() })],
      error: null,
    });

    const { status, body } = await postJson(port, '/api/public/seats/lock', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1],
    });

    expect(status).toBe(409);
    expect(body.error.code).toBe('SEAT_LOCKED');
  });

  it('es idempotente: un segundo request sobre locks propios responde 200 y extiende el TTL', async () => {
    const mine = seatRow({
      status: 'locked',
      locked_by: CUSTOMER_ID,
      lock_expires_at: new Date(Date.now() + 300_000).toISOString(),
    });
    harness.push('trips', activeTrip);
    harness.push('seats', { data: [], error: null });
    harness.push('seats', { data: [mine], error: null });

    const { status, body } = await postJson(port, '/api/public/seats/lock', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1],
    });

    expect(status).toBe(200);
    expect(body.locked).toBe(true);
    expect(body.ttl_seconds).toBe(900);
    expect(body.seats[0].lock_expires_at).toBe(body.lock_expires_at);

    const extend = findChain('seats', (calls) =>
      calls.some(
        (c) =>
          c.method === 'update' &&
          c.args[0]?.lock_expires_at !== undefined &&
          c.args[0]?.status === undefined,
      ),
    );
    expect(extend).toBeDefined();
    expect(extend!.calls.some((c) => c.method === 'eq' && c.args[0] === 'locked_by' && c.args[1] === CUSTOMER_ID)).toBe(true);
  });

  it('hace rollback y responde 409 si otro request toma un asiento entre lectura y escritura', async () => {
    harness.push('trips', activeTrip);
    harness.push('seats', { data: [], error: null });
    harness.push('seats', {
      data: [seatRow(), seatRow({ id: SEAT_A2, seat_code: 'A2' })],
      error: null,
    });
    harness.push('seats', { data: [{ id: SEAT_A1 }], error: null });
    harness.push('seats', { data: [{ id: SEAT_A1 }], error: null });

    const { status, body } = await postJson(port, '/api/public/seats/lock', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1, SEAT_A2],
    });

    expect(status).toBe(409);
    expect(body.error.code).toBe('SEAT_NOT_AVAILABLE');

    const rollback = findChain(
      'seats',
      (calls) =>
        calls.some((c) => c.method === 'update' && c.args[0]?.status === 'available') &&
        calls.some(
          (c) => c.method === 'eq' && c.args[0] === 'locked_by' && c.args[1] === CUSTOMER_ID,
        ),
    );
    expect(rollback).toBeDefined();
    expect(rollback!.calls.some((c) => c.method === 'eq' && c.args[0] === 'locked_by' && c.args[1] === CUSTOMER_ID)).toBe(true);
  });

  it('responde 409 TRIP_NOT_ACTIVE cuando el viaje no esta activo', async () => {
    harness.push('trips', { data: { id: TRIP_ID, status: 'cancelled', capacity: 31 }, error: null });

    const { status, body } = await postJson(port, '/api/public/seats/lock', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1],
    });

    expect(status).toBe(409);
    expect(body.error.code).toBe('TRIP_NOT_ACTIVE');
  });

  it('responde 404 TRIP_NOT_FOUND cuando el viaje no existe', async () => {
    harness.push('trips', { data: null, error: null });

    const { status, body } = await postJson(port, '/api/public/seats/lock', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1],
    });

    expect(status).toBe(404);
    expect(body.error.code).toBe('TRIP_NOT_FOUND');
  });

  it('responde 400 cuando un asiento no pertenece al viaje', async () => {
    harness.push('trips', activeTrip);
    harness.push('seats', { data: [], error: null });
    harness.push('seats', {
      data: [seatRow({ trip_id: '99999999-9999-4999-8999-999999999999' })],
      error: null,
    });

    const { status, body } = await postJson(port, '/api/public/seats/lock', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('responde 400 cuando los seat_ids estan duplicados o vacios', async () => {
    const duplicated = await postJson(port, '/api/public/seats/lock', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1, SEAT_A1],
    });
    expect(duplicated.status).toBe(400);

    const empty = await postJson(port, '/api/public/seats/lock', {
      trip_id: TRIP_ID,
      seat_ids: [],
    });
    expect(empty.status).toBe(400);
    expect(seatChains()).toHaveLength(0);
  });

  it('responde 401 sin token y 403 si el rol no es customer', async () => {
    const anonymous = await postJson(
      port,
      '/api/public/seats/lock',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1] },
      null,
    );
    expect(anonymous.status).toBe(401);

    givenAuthAs(CUSTOMER_ID, 'superadmin');
    const superadmin = await postJson(
      port,
      '/api/public/seats/lock',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1] },
      'token',
    );
    expect(superadmin.status).toBe(403);
    expect(superadmin.body.error.code).toBe('CUSTOMER_REQUIRED');
    expect(seatChains()).toHaveLength(0);
  });
});

describe('POST /api/public/seats/unlock y GET /api/public/seats/locks (MKT-004)', () => {
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
      closing.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    harness.reset();
    givenAuthAs(CUSTOMER_ID);
  });

  it('unlock solo libera locks propios del customer', async () => {
    harness.push('seats', { data: [{ id: SEAT_A1 }, { id: SEAT_A2 }], error: null });

    const { status, body } = await postJson(
      port,
      '/api/public/seats/unlock',
      { trip_id: TRIP_ID },
      'token',
    );

    expect(status).toBe(200);
    expect(body.unlocked).toBe(2);

    const unlock = findChain('seats', (calls) =>
      calls.some((c) => c.method === 'update' && c.args[0]?.status === 'available'),
    );
    expect(unlock).toBeDefined();
    expect(unlock!.calls.some((c) => c.method === 'eq' && c.args[0] === 'locked_by' && c.args[1] === CUSTOMER_ID)).toBe(true);
    expect(unlock!.calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'locked')).toBe(true);
    expect(unlock!.calls.some((c) => c.method === 'eq' && c.args[0] === 'trip_id' && c.args[1] === TRIP_ID)).toBe(true);
  });

  it('unlock con seat_ids libera solo los indicados', async () => {
    harness.push('seats', { data: [{ id: SEAT_A2 }], error: null });

    const { status, body } = await postJson(
      port,
      '/api/public/seats/unlock',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A2] },
      'token',
    );

    expect(status).toBe(200);
    expect(body.unlocked).toBe(1);
    const unlock = findChain('seats', (calls) =>
      calls.some((c) => c.method === 'update'),
    );
    expect(unlock!.calls.some((c) => c.method === 'in' && c.args[0] === 'id' && c.args[1][0] === SEAT_A2)).toBe(true);
  });

  it('locks devuelve solo los locks vigentes propios con el minimo lock_expires_at', async () => {
    const soonest = new Date(Date.now() + 600_000).toISOString();
    const later = new Date(Date.now() + 840_000).toISOString();
    harness.push('seats', {
      data: [
        { id: SEAT_A2, seat_code: 'A2', lock_expires_at: later },
        { id: SEAT_A1, seat_code: 'A1', lock_expires_at: soonest },
      ],
      error: null,
    });

    const { status, body } = await getJson(
      port,
      `/api/public/seats/locks?trip_id=${TRIP_ID}`,
      'token',
    );

    expect(status).toBe(200);
    expect(body.trip_id).toBe(TRIP_ID);
    expect(body.lock_expires_at).toBe(soonest);
    expect(body.seats.map((s: any) => s.seat_code)).toEqual(['A1', 'A2']);

    const read = harness.chains().find((chain) => chain.table === 'seats');
    expect(read!.calls.some((c) => c.method === 'eq' && c.args[0] === 'locked_by' && c.args[1] === CUSTOMER_ID)).toBe(true);
    expect(read!.calls.some((c) => c.method === 'gt' && c.args[0] === 'lock_expires_at')).toBe(true);
  });

  it('locks devuelve lista vacia cuando no hay locks vigentes', async () => {
    harness.push('seats', { data: [], error: null });

    const { status, body } = await getJson(
      port,
      `/api/public/seats/locks?trip_id=${TRIP_ID}`,
      'token',
    );

    expect(status).toBe(200);
    expect(body.lock_expires_at).toBeNull();
    expect(body.seats).toEqual([]);
  });

  it('rechaza accesos sin token', async () => {
    const anonymous = await getJson(port, `/api/public/seats/locks?trip_id=${TRIP_ID}`);
    expect(anonymous.status).toBe(401);
  });
});
