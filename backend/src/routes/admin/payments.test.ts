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
  type QueryResult = {
    data?: any;
    error?: { message: string } | null;
    count?: number | null;
  };
  type ChainRecord = {
    table: string;
    calls: Array<{ method: string; args: any[] }>;
  };
  type RpcCall = { fn: string; args: any };
  type SignedUrlRecord = { bucket: string; path: string; expiresIn: number };

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    chains: ChainRecord[];
    rpcQueues: Record<string, QueryResult[]>;
    rpcDefaults: Record<string, QueryResult>;
    rpcCalls: RpcCall[];
    signedUrls: SignedUrlRecord[];
    signError: { message: string } | null;
    signedUrlValue: string | null;
    getUser: (token: string) => Promise<any>;
  } = {
    queues: {},
    defaults: {},
    chains: [],
    rpcQueues: {},
    rpcDefaults: {},
    rpcCalls: [],
    signedUrls: [],
    signError: null,
    signedUrlValue: 'https://storage.example.com/signed/proof',
    getUser: () =>
      Promise.resolve({ data: { user: null }, error: { message: 'anonymous' } }),
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
      'range',
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
    const record: ChainRecord = {
      table: `rpc:${fn}`,
      calls: [{ method: 'rpc', args: [args] }],
    };
    state.chains.push(record);
    const thenable = {
      then: (onFulfilled: any, onRejected: any) => {
        const queue = state.rpcQueues[fn];
        const result =
          queue && queue.length > 0
            ? queue.shift()!
            : state.rpcDefaults[fn] ?? { data: null, error: null };
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
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
    pushRpc(fn: string, result: QueryResult) {
      (state.rpcQueues[fn] ||= []).push(result);
    },
    reset() {
      state.chains = [];
      state.queues = {};
      state.defaults = {};
      state.rpcQueues = {};
      state.rpcDefaults = {};
      state.rpcCalls = [];
      state.signedUrls = [];
      state.signError = null;
      state.signedUrlValue = 'https://storage.example.com/signed/proof';
    },
    setUser(handler: (token: string) => Promise<any>) {
      state.getUser = handler;
    },
    chains: () => state.chains,
    rpcCalls: () => state.rpcCalls,
    signedUrls: () => state.signedUrls,
    setSignError(error: { message: string } | null) {
      state.signError = error;
    },
    setSignedUrl(value: string | null) {
      state.signedUrlValue = value;
    },
    from: (table: string) => buildChain(table),
    rpc: (fn: string, args: any) => buildRpc(fn, args),
    auth: { getUser: (token: string) => state.getUser(token) },
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (path: string, expiresIn: number) => {
            state.signedUrls.push({ bucket, path, expiresIn });
            if (state.signError) {
              return { data: null, error: state.signError };
            }
            return {
              data: { signedUrl: state.signedUrlValue },
              error: null,
            };
          },
          upload: async () => ({ data: null, error: null }),
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

const AGENCY_USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENCY_USER_ID = '22222222-2222-4222-8222-222222222222';
const AGENCY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_AGENCY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const PAYMENT_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const OTHER_PAYMENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RESERVATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const TRIP_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const PASSENGER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ALLOCATION_ID = '99999999-9999-4999-8999-999999999999';
const PROOF_PATH = `${RESERVATION_ID}/deadbeefcafe.png`;

let server: Server;
let baseUrl: string;
let lastRequest: { method?: string; url?: string; headers: Record<string, string> };

function givenAuthAs(userId: string) {
  harness.setUser(() =>
    Promise.resolve({ data: { user: { id: userId } }, error: null }),
  );
}

function givenAgencyUser(overrides: Record<string, any> = {}) {
  harness.push('users', {
    data: {
      id: AGENCY_USER_ID,
      role: 'agency',
      agency_id: AGENCY_ID,
      ...overrides,
    },
    error: null,
  });
}

function givenOtherAgencyUser() {
  harness.push('users', {
    data: {
      id: OTHER_AGENCY_USER_ID,
      role: 'agency',
      agency_id: OTHER_AGENCY_ID,
    },
    error: null,
  });
}

function ownedPayment(overrides: Record<string, any> = {}) {
  return {
    id: PAYMENT_ID,
    agency_id: AGENCY_ID,
    reservation_id: RESERVATION_ID,
    ...overrides,
  };
}

async function api(
  method: string,
  path: string,
  options: {
    token?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  lastRequest = { method, url: path, headers };

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let body: any = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { status: response.status, body };
}

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  harness.reset();
  givenAuthAs(AGENCY_USER_ID);
  lastRequest = {};
});

// ── GET /api/admin/payments — listado ────────────────────────────────────────

describe('GET /api/admin/payments — listado', () => {
  it('rechaza sin token', async () => {
    const res = await api('GET', '/api/admin/payments', { token: null });
    expect(res.status).toBe(401);
  });

  it('rechaza rol customer', async () => {
    givenAuthAs('customer-user');
    harness.push('users', {
      data: { id: 'customer-user', role: 'customer', agency_id: null },
      error: null,
    });
    const res = await api('GET', '/api/admin/payments', { token: 't' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rechaza superadmin', async () => {
    givenAuthAs('admin-user');
    harness.push('users', {
      data: { id: 'admin-user', role: 'superadmin', agency_id: null },
      error: null,
    });
    const res = await api('GET', '/api/admin/payments', { token: 't' });
    expect(res.status).toBe(403);
  });

  it('lista pagos de la agencia autenticada con paginación', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: [
        {
          id: PAYMENT_ID,
          status: 'pending',
          amount_cents: 3000000,
          currency: 'COP',
          submitted_at: '2026-10-08T12:00:00.000Z',
          verified_at: null,
          rejection_reason: null,
          proof_url: PROOF_PATH,
          reservation_id: RESERVATION_ID,
          reservations: {
            id: RESERVATION_ID,
            booker_name: 'Ana Pérez',
            contact_email: 'ana@example.com',
            status: 'reserved',
            payment_status: 'pending',
            trips: {
              id: TRIP_ID,
              departure_time: '2026-10-15T08:00:00.000Z',
              routes: { origin: 'Bogotá', destination: 'Medellín' },
            },
          },
        },
      ],
      error: null,
      count: 1,
    });

    const res = await api('GET', '/api/admin/payments?page=1&limit=20', {
      token: 't',
    });

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
    expect(res.body.total).toBe(1);
    expect(res.body.payments).toHaveLength(1);

    const item = res.body.payments[0];
    expect(item.id).toBe(PAYMENT_ID);
    expect(item.status).toBe('pending');
    expect(item.has_proof).toBe(true);
    expect(item.reservation.booker_name).toBe('Ana Pérez');
    expect(item.reservation.trip.origin).toBe('Bogotá');
    // Nunca se expone la ruta del comprobante en el listado.
    expect(item).not.toHaveProperty('proof_url');
    expect(JSON.stringify(item)).not.toContain(PROOF_PATH);
  });

  it('filtra por status y envía agency_id de la sesión al servidor', async () => {
    givenAgencyUser();
    harness.push('payments', { data: [], error: null, count: 0 });

    const res = await api('GET', '/api/admin/payments?status=verified', {
      token: 't',
    });

    expect(res.status).toBe(200);
    const chains = harness.chains().filter((c) => c.table === 'payments');
    const selectChain = chains.find((c) =>
      c.calls.some((call) => call.method === 'select'),
    );
    expect(selectChain).toBeDefined();
    const eqCalls = selectChain!.calls.filter((c) => c.method === 'eq');
    expect(eqCalls.map((c) => c.args)).toContainEqual(['agency_id', AGENCY_ID]);
    expect(eqCalls.map((c) => c.args)).toContainEqual(['status', 'verified']);
  });

  it('rechaza status inválido', async () => {
    givenAgencyUser();
    const res = await api('GET', '/api/admin/payments?status=hacked', {
      token: 't',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rechaza limit por encima del máximo', async () => {
    givenAgencyUser();
    const res = await api('GET', '/api/admin/payments?limit=999', {
      token: 't',
    });
    expect(res.status).toBe(400);
  });

  it('rechaza page cero o negativa', async () => {
    givenAgencyUser();
    givenAgencyUser();
    const zero = await api('GET', '/api/admin/payments?page=0', { token: 't' });
    expect(zero.status).toBe(400);
    const negative = await api('GET', '/api/admin/payments?page=-1', {
      token: 't',
    });
    expect(negative.status).toBe(400);
  });

  it('aplica range coherente con page/limit', async () => {
    givenAgencyUser();
    harness.push('payments', { data: [], error: null, count: 0 });

    await api('GET', '/api/admin/payments?page=3&limit=10', { token: 't' });

    const chain = harness
      .chains()
      .find(
        (c) =>
          c.table === 'payments' &&
          c.calls.some((call) => call.method === 'range'),
      );
    expect(chain).toBeDefined();
    const rangeCall = chain!.calls.find((c) => c.method === 'range');
    expect(rangeCall!.args).toEqual([20, 29]);
  });

  it('incluye orden estable: status asc, submitted_at desc, id desc', async () => {
    givenAgencyUser();
    harness.push('payments', { data: [], error: null, count: 0 });

    await api('GET', '/api/admin/payments', { token: 't' });

    const chain = harness
      .chains()
      .find(
        (c) => c.table === 'payments' && c.calls.some((x) => x.method === 'order'),
      );
    const orderCalls = chain!.calls
      .filter((c) => c.method === 'order')
      .map((c) => c.args);
    expect(orderCalls[0]).toEqual(['status', { ascending: true }]);
    expect(orderCalls[1]).toEqual(['submitted_at', { ascending: false }]);
    expect(orderCalls[2]).toEqual(['id', { ascending: false }]);
  });
});

// ── GET /api/admin/payments/:paymentId — detalle ─────────────────────────────

describe('GET /api/admin/payments/:paymentId — detalle', () => {
  function givenDetailFixture() {
    // 1) Ownership middleware
    harness.push('payments', { data: ownedPayment(), error: null });
    // 2) Detalle del servicio
    harness.push('payments', {
      data: ownedPayment({
        status: 'pending',
        amount_cents: 3000000,
        currency: 'COP',
        submitted_at: '2026-10-08T12:00:00.000Z',
        verified_at: null,
        verified_by: null,
        rejection_reason: null,
        proof_url: PROOF_PATH,
        reservations: {
          id: RESERVATION_ID,
          booker_name: 'Ana Pérez',
          booker_phone: '3001234567',
          contact_email: 'ana@example.com',
          status: 'reserved',
          payment_status: 'pending',
          created_at: '2026-10-08T11:00:00.000Z',
          trips: {
            id: TRIP_ID,
            departure_time: '2026-10-15T08:00:00.000Z',
            vehicle_type: 'bus',
            seat_price: 1500000,
            routes: { origin: 'Bogotá', destination: 'Medellín' },
          },
        },
      }),
      error: null,
    });
    harness.push('reservation_passengers', {
      data: [
        {
          id: PASSENGER_ID,
          seat_id: 'seat-1',
          name: 'Ana Pérez',
          unit_price: 1500000,
          status: 'active',
          seats: { seat_code: 'A1' },
        },
      ],
      error: null,
    });
    harness.push('payment_allocations', {
      data: [],
      error: null,
    });
  }

  it('rechaza sin token', async () => {
    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}`, {
      token: null,
    });
    expect(res.status).toBe(401);
  });

  it('devuelve detalle con pasajeros activos y totales', async () => {
    givenAgencyUser();
    givenDetailFixture();

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}`, {
      token: 't',
    });

    expect(res.status).toBe(200);
    expect(res.body.payment.id).toBe(PAYMENT_ID);
    expect(res.body.payment.has_proof).toBe(true);
    expect(res.body.payment).not.toHaveProperty('proof_url');
    expect(res.body.reservation.booker_name).toBe('Ana Pérez');
    expect(res.body.trip.origin).toBe('Bogotá');
    expect(res.body.passengers).toHaveLength(1);
    expect(res.body.passengers[0].seat_code).toBe('A1');
    expect(res.body.totals).toEqual({
      active_passenger_count: 1,
      expected_cents: 1500000,
      allocated_cents: 0,
      remaining_cents: 1500000,
    });
  });

  it('un pago inexistente y uno de otra agencia producen el mismo 404', async () => {
    givenAgencyUser();

    // Middleware ownership: no existe.
    harness.push('payments', { data: null, error: null });
    const missing = await api('GET', `/api/admin/payments/${PAYMENT_ID}`, {
      token: 't',
    });

    harness.reset();
    givenAuthAs(AGENCY_USER_ID);
    givenAgencyUser();
    // Middleware ownership: existe pero es de otra agencia.
    harness.push('payments', {
      data: { id: PAYMENT_ID, agency_id: OTHER_AGENCY_ID },
      error: null,
    });
    const foreign = await api('GET', `/api/admin/payments/${PAYMENT_ID}`, {
      token: 't',
    });

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(missing.body.error.message).toBe(foreign.body.error.message);
    expect(missing.body.error.code).toBe(foreign.body.error.code);
  });

  it('rechaza paymentId que no es UUID con el mismo 404 que un inexistente', async () => {
    givenAgencyUser();
    const res = await api('GET', '/api/admin/payments/not-a-uuid', {
      token: 't',
    });
    // El middleware de ownership responde 404 antes de la validación Zod:
    // un id inválido es indistinguible de un pago inexistente.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('incluye allocations en el detalle', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    harness.push('payments', {
      data: ownedPayment({
        status: 'verified',
        amount_cents: 1500000,
        currency: 'COP',
        submitted_at: '2026-10-08T12:00:00.000Z',
        verified_at: '2026-10-08T13:00:00.000Z',
        verified_by: AGENCY_USER_ID,
        rejection_reason: null,
        proof_url: PROOF_PATH,
        reservations: {
          id: RESERVATION_ID,
          booker_name: 'Ana Pérez',
          booker_phone: null,
          contact_email: 'ana@example.com',
          status: 'reserved',
          payment_status: 'fully_paid',
          created_at: '2026-10-08T11:00:00.000Z',
          trips: {
            id: TRIP_ID,
            departure_time: '2026-10-15T08:00:00.000Z',
            vehicle_type: 'bus',
            seat_price: 1500000,
            routes: { origin: 'Bogotá', destination: 'Medellín' },
          },
        },
      }),
      error: null,
    });
    harness.push('reservation_passengers', {
      data: [
        {
          id: PASSENGER_ID,
          seat_id: 'seat-1',
          name: 'Ana Pérez',
          unit_price: 1500000,
          status: 'active',
          seats: { seat_code: 'A1' },
        },
      ],
      error: null,
    });
    harness.push('payment_allocations', {
      data: [
        {
          id: ALLOCATION_ID,
          reservation_passenger_id: PASSENGER_ID,
          amount_cents: 1500000,
          created_at: '2026-10-08T13:00:00.000Z',
          reservation_passengers: { seats: { seat_code: 'A1' } },
        },
      ],
      error: null,
    });

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}`, {
      token: 't',
    });

    expect(res.status).toBe(200);
    expect(res.body.allocations).toHaveLength(1);
    expect(res.body.allocations[0].seat_code).toBe('A1');
    expect(res.body.totals.allocated_cents).toBe(1500000);
    expect(res.body.totals.remaining_cents).toBe(0);
  });
});

// ── GET /api/admin/payments/:paymentId/proof — comprobante ───────────────────

describe('GET /api/admin/payments/:paymentId/proof — comprobante', () => {
  it('rechaza sin token', async () => {
    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}/proof`, {
      token: null,
    });
    expect(res.status).toBe(401);
  });

  it('genera URL firmada tras validar ownership en el servidor', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    harness.push('payments', {
      data: {
        id: PAYMENT_ID,
        reservation_id: RESERVATION_ID,
        proof_url: PROOF_PATH,
      },
      error: null,
    });

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}/proof`, {
      token: 't',
    });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://storage.example.com/signed/proof');
    expect(res.body.expires_in_seconds).toBe(300);

    const signed = harness.signedUrls();
    expect(signed).toHaveLength(1);
    expect(signed[0].bucket).toBe('payment-proofs');
    expect(signed[0].path).toBe(PROOF_PATH);
    expect(signed[0].expiresIn).toBe(300);
  });

  it('pago de otra agencia produce 404 sin tocar storage', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: { id: PAYMENT_ID, agency_id: OTHER_AGENCY_ID },
      error: null,
    });

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}/proof`, {
      token: 't',
    });

    expect(res.status).toBe(404);
    expect(harness.signedUrls()).toHaveLength(0);
  });

  it('pago sin comprobante produce 404 PAYMENT_PROOF_NOT_FOUND', async () => {
    givenAgencyUser();
    // Ownership middleware: pago propio.
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    // Servicio: proof_url nulo.
    harness.push('payments', {
      data: {
        id: PAYMENT_ID,
        reservation_id: RESERVATION_ID,
        proof_url: null,
      },
      error: null,
    });

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}/proof`, {
      token: 't',
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_PROOF_NOT_FOUND');
    expect(harness.signedUrls()).toHaveLength(0);
  });

  it('rechaza una proof_url que apunta fuera del directorio de la reserva', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    harness.push('payments', {
      data: {
        id: PAYMENT_ID,
        reservation_id: RESERVATION_ID,
        proof_url: 'otra-reserva/archivo.png',
      },
      error: null,
    });

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}/proof`, {
      token: 't',
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_PROOF_NOT_FOUND');
    expect(harness.signedUrls()).toHaveLength(0);
  });

  it('rechaza una proof_url con path traversal', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    harness.push('payments', {
      data: {
        id: PAYMENT_ID,
        reservation_id: RESERVATION_ID,
        proof_url: `${RESERVATION_ID}/../../secret.png`,
      },
      error: null,
    });

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}/proof`, {
      token: 't',
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_PROOF_NOT_FOUND');
    expect(harness.signedUrls()).toHaveLength(0);
  });

  it('rechaza una proof_url con subcarpeta anidada', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    harness.push('payments', {
      data: {
        id: PAYMENT_ID,
        reservation_id: RESERVATION_ID,
        proof_url: `${RESERVATION_ID}/sub/archivo.png`,
      },
      error: null,
    });

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}/proof`, {
      token: 't',
    });

    expect(res.status).toBe(404);
    expect(harness.signedUrls()).toHaveLength(0);
  });

  it('rechaza una proof_url sin extensión', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    harness.push('payments', {
      data: {
        id: PAYMENT_ID,
        reservation_id: RESERVATION_ID,
        proof_url: `${RESERVATION_ID}/deadbeefcafe`,
      },
      error: null,
    });

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}/proof`, {
      token: 't',
    });

    expect(res.status).toBe(404);
    expect(harness.signedUrls()).toHaveLength(0);
  });

  it('mapea un fallo de storage a PAYMENT_STORAGE_ERROR', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    harness.push('payments', {
      data: {
        id: PAYMENT_ID,
        reservation_id: RESERVATION_ID,
        proof_url: PROOF_PATH,
      },
      error: null,
    });
    harness.setSignError({ message: 'storage unavailable' });

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}/proof`, {
      token: 't',
    });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('PAYMENT_STORAGE_ERROR');
  });

  it('mapea un signedUrl nulo a PAYMENT_STORAGE_ERROR', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    harness.push('payments', {
      data: {
        id: PAYMENT_ID,
        reservation_id: RESERVATION_ID,
        proof_url: PROOF_PATH,
      },
      error: null,
    });
    harness.setSignedUrl(null);

    const res = await api('GET', `/api/admin/payments/${PAYMENT_ID}/proof`, {
      token: 't',
    });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('PAYMENT_STORAGE_ERROR');
  });
});

// ── Compatibilidad con verify / reject ───────────────────────────────────────

describe('compatibilidad con verify y reject', () => {
  it('POST verify sigue funcionando y no acepta agency_id del cliente', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    harness.pushRpc('verify_marketplace_payment', {
      data: {
        payment_id: PAYMENT_ID,
        reservation_id: RESERVATION_ID,
        status: 'verified',
        already_verified: false,
        amount_cents: 3000000,
        currency: 'COP',
        allocation_count: 2,
        total_expected_cents: 3000000,
        verified_at: '2026-10-08T13:00:00.000Z',
        verified_by: AGENCY_USER_ID,
        payment_status: 'fully_paid',
        audit_id: 'audit-1',
      },
      error: null,
    });

    const res = await api('POST', `/api/admin/payments/${PAYMENT_ID}/verify`, {
      token: 't',
      body: { agency_id: OTHER_AGENCY_ID },
    });

    expect(res.status).toBe(200);
    const rpc = harness.rpcCalls().find((c) => c.fn === 'verify_marketplace_payment');
    expect(rpc!.args).toEqual({
      p_payment_id: PAYMENT_ID,
      p_actor_user_id: AGENCY_USER_ID,
    });
    expect(rpc!.args).not.toHaveProperty('p_agency_id');
    expect(rpc!.args.p_actor_user_id).not.toBe(OTHER_AGENCY_ID);
  });

  it('POST reject sigue funcionando con actor de la sesión', async () => {
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });
    harness.pushRpc('reject_marketplace_payment', {
      data: {
        payment_id: PAYMENT_ID,
        reservation_id: RESERVATION_ID,
        status: 'rejected',
        already_rejected: false,
        rejection_reason: 'Comprobante ilegible',
        outcome: 'cancelled_reservation',
        cancelled_reservation: true,
        reservation_status: 'cancelled',
        payment_status: 'cancelled',
        freed_seat_count: 2,
        cancelled_passenger_count: 2,
        refund_required: false,
        refund_amount_cents: 0,
        payment_audit_id: 'audit-p',
        reservation_audit_id: 'audit-r',
      },
      error: null,
    });

    const res = await api('POST', `/api/admin/payments/${PAYMENT_ID}/reject`, {
      token: 't',
      body: { reason: 'Comprobante ilegible' },
    });

    expect(res.status).toBe(200);
    const rpc = harness.rpcCalls().find((c) => c.fn === 'reject_marketplace_payment');
    expect(rpc!.args.p_actor_user_id).toBe(AGENCY_USER_ID);
  });

  it('los endpoints GET no mutan el estado de verify/reject', async () => {
    givenAgencyUser();
    givenAgencyUser();
    harness.push('payments', {
      data: ownedPayment(),
      error: null,
    });

    await api('GET', `/api/admin/payments/${PAYMENT_ID}`, { token: 't' });

    expect(harness.rpcCalls()).toHaveLength(0);
    const mutating = harness
      .chains()
      .flatMap((c) => c.calls)
      .filter((c) => ['update', 'insert', 'upsert', 'delete'].includes(c.method));
    expect(mutating).toHaveLength(0);
  });
});
