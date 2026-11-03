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
    rpcQueues: Record<string, QueryResult[]>;
    rpcDefaults: Record<string, QueryResult>;
    rpcCalls: Array<{ fn: string; args: any }>;
    getUser: (token: string) => Promise<any>;
  } = {
    queues: {},
    defaults: {},
    rpcQueues: {},
    rpcDefaults: {},
    rpcCalls: [],
    getUser: () =>
      Promise.resolve({ data: { user: null }, error: { message: 'anonymous' } }),
  };

  function buildChain(table: string) {
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
      'is',
      'lt',
      'lte',
      'gt',
      'order',
      'range',
      'limit',
      'maybeSingle',
      'single',
    ]) {
      chain[method] = () => chain;
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
      then: (onFulfilled: any, onRejected: any) => {
        const queue = state.rpcQueues[fn];
        const result =
          queue && queue.length > 0
            ? queue.shift()!
            : state.rpcDefaults[fn] ?? { data: null, error: null };
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
  }

  return {
    push(table: string, result: QueryResult) {
      (state.queues[table] ||= []).push(result);
    },
    setDefault(table: string, result: QueryResult) {
      state.defaults[table] = result;
    },
    pushRpc(fn: string, result: QueryResult) {
      (state.rpcQueues[fn] ||= []).push(result);
    },
    setRpcDefault(fn: string, result: QueryResult) {
      state.rpcDefaults[fn] = result;
    },
    reset() {
      state.queues = {};
      state.defaults = {};
      state.rpcQueues = {};
      state.rpcDefaults = {};
      state.rpcCalls = [];
    },
    rpcCalls: () => state.rpcCalls,
    setUser(handler: (token: string) => Promise<any>) {
      state.getUser = handler;
    },
    from: (table: string) => buildChain(table),
    rpc: (fn: string, args: any) => buildRpc(fn, args),
    auth: { getUser: (token: string) => state.getUser(token) },
    storage: { from: () => ({}) },
  };
});

vi.mock('../../config/database.js', () => ({
  supabase: harness,
  supabaseAdmin: harness,
  createAuthenticatedClient: vi.fn(),
}));

import app from '../../app.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_ID = 'ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d';
const NOTIFICATION_ID = '11111111-2222-4333-8444-555555555555';

function givenAuthAs(userId: string) {
  harness.setUser(() =>
    Promise.resolve({ data: { user: { id: userId } }, error: null }),
  );
}

/** El rol debe ir por DEFAULT: auth.consume users vía then (maybeSingle). */
function givenUserRole(role: string, agencyId: string | null = null) {
  harness.setDefault('users', {
    data: { id: CUSTOMER_ID, role, agency_id: agencyId },
    error: null,
  });
}

async function startServer(): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function requestJson(
  port: number,
  path: string,
  init: { token?: string | null; method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (init.token !== null) {
    headers.Authorization = `Bearer ${init.token ?? 'token'}`;
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const LIST_URL = '/api/public/reviews';
const CONTEXT_URL = `/api/public/reviews/reservations/${RESERVATION_ID}`;
const SUBMIT_URL = CONTEXT_URL;

function validSubmitBody(overrides: Record<string, any> = {}) {
  return {
    trip_rating: 5,
    trip_comment: 'Excelente viaje',
    agency_rating: 4,
    agency_comment: null,
    ...overrides,
  };
}

describe('GET /api/public/reviews — lista del cliente (REV-001)', () => {
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
    givenUserRole('customer');
  });

  it('responde 401 sin token', async () => {
    const res = await requestJson(port, LIST_URL, { token: null });
    expect(res.status).toBe(401);
  });

  it('responde 403 a una cuenta de agencia (solo clientes)', async () => {
    givenUserRole('agency', '5bf0be5d-c03a-431f-97d5-e2a065e25752');
    const res = await requestJson(port, LIST_URL);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CUSTOMER_REQUIRED');
  });

  it('responde 403 a una cuenta superadmin', async () => {
    givenUserRole('superadmin');
    const res = await requestJson(port, LIST_URL);
    expect(res.status).toBe(403);
  });

  it('responde la lista de reseñas del cliente autenticado', async () => {
    // reservations + (trips, agencies, trip_reviews, agency_reviews) + routes.
    harness.push('reservations', { data: [], error: null });

    const res = await requestJson(port, LIST_URL);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('un fallo de base de datos responde REVIEW_ERROR 500 sin exponer internals', async () => {
    harness.push('reservations', { data: null, error: { message: 'boom internal' } });

    const res = await requestJson(port, LIST_URL);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('REVIEW_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('boom internal');
  });
});

describe('POST /api/public/reviews/reservations/:id — envío atómico (REV-001)', () => {
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
    givenUserRole('customer');
  });

  it('responde 201 y delega en submit_reservation_reviews con el customer del servidor', async () => {
    harness.setRpcDefault('submit_reservation_reviews', {
      data: {
        reservation_id: RESERVATION_ID,
        already_submitted: false,
        trip_review_id: 'tr-1',
        agency_review_id: 'ar-1',
      },
      error: null,
    });

    const res = await requestJson(port, SUBMIT_URL, {
      method: 'POST',
      body: validSubmitBody(),
    });

    expect(res.status).toBe(201);
    expect(res.body.already_submitted).toBe(false);
    const call = harness.rpcCalls().find((c) => c.fn === 'submit_reservation_reviews');
    expect(call?.args.p_customer_id).toBe(CUSTOMER_ID);
    expect(call?.args.p_trip_rating).toBe(5);
    expect(call?.args.p_agency_rating).toBe(4);
  });

  it('responde 200 con already_submitted en un reintento (idempotencia)', async () => {
    harness.setRpcDefault('submit_reservation_reviews', {
      data: {
        reservation_id: RESERVATION_ID,
        already_submitted: true,
        trip_review_id: 'tr-1',
        agency_review_id: 'ar-1',
      },
      error: null,
    });

    const res = await requestJson(port, SUBMIT_URL, {
      method: 'POST',
      body: validSubmitBody(),
    });

    expect(res.status).toBe(200);
    expect(res.body.already_submitted).toBe(true);
  });

  it('responde 400 cuando falta una calificación (ambas son obligatorias)', async () => {
    const res = await requestJson(port, SUBMIT_URL, {
      method: 'POST',
      body: validSubmitBody({ agency_rating: undefined }),
    });

    expect(res.status).toBe(400);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('responde 400 cuando un rating está fuera de 1..5 (sin invocar la RPC)', async () => {
    const res = await requestJson(port, SUBMIT_URL, {
      method: 'POST',
      body: validSubmitBody({ trip_rating: 7 }),
    });

    expect(res.status).toBe(400);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('responde 410 cuando la ventana de 48 h venció', async () => {
    harness.pushRpc('submit_reservation_reviews', {
      data: null,
      error: { message: 'ERR_REVIEW_WINDOW_EXPIRED: The review window has expired' },
    });

    const res = await requestJson(port, SUBMIT_URL, {
      method: 'POST',
      body: validSubmitBody(),
    });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('REVIEW_WINDOW_EXPIRED');
  });

  it('responde 404 uniforme cuando la reserva es de otro cliente', async () => {
    harness.pushRpc('submit_reservation_reviews', {
      data: null,
      error: { message: 'ERR_REVIEW_NOT_OWNER: Reservation does not belong to this customer' },
    });

    const res = await requestJson(port, SUBMIT_URL, {
      method: 'POST',
      body: validSubmitBody(),
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REVIEW_RESERVATION_NOT_FOUND');
  });

  it('responde 409 cuando el viaje no está completado', async () => {
    harness.pushRpc('submit_reservation_reviews', {
      data: null,
      error: { message: 'ERR_REVIEW_TRIP_NOT_COMPLETED: Trip is not completed' },
    });

    const res = await requestJson(port, SUBMIT_URL, {
      method: 'POST',
      body: validSubmitBody(),
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REVIEW_TRIP_NOT_COMPLETED');
  });

  it('responde 403 a una cuenta de agencia', async () => {
    givenUserRole('agency', '5bf0be5d-c03a-431f-97d5-e2a065e25752');

    const res = await requestJson(port, SUBMIT_URL, {
      method: 'POST',
      body: validSubmitBody(),
    });

    expect(res.status).toBe(403);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('responde 401 sin token', async () => {
    const res = await requestJson(port, SUBMIT_URL, {
      token: null,
      method: 'POST',
      body: validSubmitBody(),
    });

    expect(res.status).toBe(401);
    expect(harness.rpcCalls()).toHaveLength(0);
  });
});

describe('GET /api/public/reviews/reservations/:id — contexto (REV-001)', () => {
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
    givenUserRole('customer');
  });

  it('responde 404 uniforme cuando la reserva no existe (o es ajena)', async () => {
    // maybeSingle sin fila + la lista vacía para loadCustomerReviewData.
    harness.push('reservations', { data: null, error: null });
    harness.push('reservations', { data: [], error: null });

    const res = await requestJson(port, CONTEXT_URL);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REVIEW_RESERVATION_NOT_FOUND');
  });

  it('responde el contexto con eligible=false cuando el viaje no finalizó', async () => {
    const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
    const ROUTE_ID = '551559e6-ea35-4453-aae1-5ed0844289b4';
    const AGENCY_ID = '5bf0be5d-c03a-431f-97d5-e2a065e25752';
    const reservation = {
      id: RESERVATION_ID,
      trip_id: TRIP_ID,
      agency_id: AGENCY_ID,
      status: 'reserved',
      created_at: '2026-01-02T10:00:00.000Z',
    };
    // 1ª reservations: contexto; 2ª: lista de loadCustomerReviewData.
    harness.push('reservations', { data: reservation, error: null });
    harness.push('reservations', { data: [reservation], error: null });
    harness.push('trips', {
      data: [
        {
          id: TRIP_ID,
          route_id: ROUTE_ID,
          status: 'active',
          departure_time: '2026-01-10T06:00:00.000Z',
          completed_at: null,
        },
      ],
      error: null,
    });
    harness.push('agencies', {
      data: [{ id: AGENCY_ID, name: 'Agencia Central' }],
      error: null,
    });
    harness.push('trip_reviews', { data: [], error: null });
    harness.push('agency_reviews', { data: [], error: null });
    harness.push('routes', {
      data: [{ id: ROUTE_ID, origin: 'Maracaibo', destination: 'Mérida' }],
      error: null,
    });

    const res = await requestJson(port, CONTEXT_URL);

    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
    expect(res.body.reason).toBe('Este viaje aún no ha finalizado');
    expect(res.body.trip.origin).toBe('Maracaibo');
    expect(res.body.agency.name).toBe('Agencia Central');
  });

  it('responde 400 VALIDATION_ERROR cuando el reservationId no es un UUID', async () => {
    const res = await requestJson(
      port,
      '/api/public/reviews/reservations/no-es-uuid',
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/public/reviews/notifications/:id/read (REV-001)', () => {
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
    givenUserRole('customer');
  });

  it('marca la notificación como leída filtrando por customer_id', async () => {
    harness.push('customer_notifications', { data: [{ id: NOTIFICATION_ID }], error: null });

    const res = await requestJson(
      port,
      `/api/public/reviews/notifications/${NOTIFICATION_ID}/read`,
      { method: 'PATCH' },
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('responde 403 a una cuenta de agencia', async () => {
    givenUserRole('agency', '5bf0be5d-c03a-431f-97d5-e2a065e25752');

    const res = await requestJson(
      port,
      `/api/public/reviews/notifications/${NOTIFICATION_ID}/read`,
      { method: 'PATCH' },
    );

    expect(res.status).toBe(403);
  });
});
