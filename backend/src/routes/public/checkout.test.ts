import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
  type RpcCall = { fn: string; args: any };
  type UploadRecord = {
    bucket: string;
    path: string;
    contentType?: string;
    upsert?: boolean;
    size: number;
  };

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    chains: ChainRecord[];
    rpcQueues: Record<string, QueryResult[]>;
    rpcDefaults: Record<string, QueryResult>;
    rpcCalls: RpcCall[];
    uploads: UploadRecord[];
    removes: string[][];
    uploadError: { message: string } | null;
    getUser: (token: string) => Promise<any>;
  } = {
    queues: {},
    defaults: {},
    chains: [],
    rpcQueues: {},
    rpcDefaults: {},
    rpcCalls: [],
    uploads: [],
    removes: [],
    uploadError: null,
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
    setRpcDefault(fn: string, result: QueryResult) {
      state.rpcDefaults[fn] = result;
    },
    reset() {
      state.chains = [];
      state.queues = {};
      state.defaults = {};
      state.rpcQueues = {};
      state.rpcDefaults = {};
      state.rpcCalls = [];
      state.uploads = [];
      state.removes = [];
      state.uploadError = null;
    },
    setUser(handler: (token: string) => Promise<any>) {
      state.getUser = handler;
    },
    chains: () => state.chains,
    rpcCalls: () => state.rpcCalls,
    uploads: () => state.uploads,
    removes: () => state.removes,
    setUploadError(error: { message: string } | null) {
      state.uploadError = error;
    },
    from: (table: string) => buildChain(table),
    rpc: (fn: string, args: any) => buildRpc(fn, args),
    auth: { getUser: (token: string) => state.getUser(token) },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, body: any, options: any) => {
            state.uploads.push({
              bucket,
              path,
              contentType: options?.contentType,
              upsert: options?.upsert,
              size: Buffer.isBuffer(body) ? body.length : 0,
            });
            return {
              data: state.uploadError ? null : { path },
              error: state.uploadError,
            };
          },
          remove: async (paths: string[]) => {
            state.removes.push(paths);
            return { data: null, error: null };
          },
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
const OTHER_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';
const SUPERADMIN_ID = '55555555-5555-4555-8555-555555555555';
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const AGENCY_ID = '5bf0be5d-c03a-431f-97d5-e2a065e25752';
const SEAT_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SEAT_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const ATTEMPT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const IDEMPOTENCY_KEY = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const OTHER_IDEMPOTENCY_KEY = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const RPC_CREATE = 'create_checkout_attempt';
const RPC_PROOF = 'submit_checkout_proof';
const RPC_CANCEL = 'cancel_checkout_attempt';
const ALLOWED_ORIGIN = 'http://localhost:3002';

function pngBytes(payload = 48): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(payload, 0x41),
  ]);
}

function validPayload(overrides: Record<string, any> = {}) {
  return {
    trip_id: TRIP_ID,
    agency_id: AGENCY_ID,
    seat_ids: [SEAT_A1, SEAT_A2],
    passengers: [
      {
        seat_id: SEAT_A1,
        first_name: 'Ana',
        last_name: 'Perez',
        document: '12345678',
        phone: '04241234567',
      },
      {
        seat_id: SEAT_A2,
        first_name: 'Luis',
        last_name: 'Gomez',
        document: '87654321',
        phone: '04141234567',
      },
    ],
    ...overrides,
  };
}

function createdAttempt(overrides: Record<string, any> = {}) {
  return {
    data: {
      attempt_id: ATTEMPT_ID,
      trip_id: TRIP_ID,
      agency_id: AGENCY_ID,
      customer_id: CUSTOMER_ID,
      status: 'created',
      seat_ids: [SEAT_A1, SEAT_A2],
      passenger_count: 2,
      unit_price: 2020,
      amount_cents: 4040,
      proof_count: 0,
      expires_at: '2026-12-31T12:00:00.000Z',
      idempotent: false,
      ...overrides,
    },
    error: null,
  };
}

function submittedProof(overrides: Record<string, any> = {}) {
  return {
    data: {
      attempt_id: ATTEMPT_ID,
      status: 'pending_review',
      proof_count: 1,
      remaining_submissions: 2,
      proof_path: `${ATTEMPT_ID}/digest.png`,
      payment_reference: '00123456789',
      bank_origin: 'Banco de Venezuela',
      payment_datetime: '2020-01-01T10:00:00.000Z',
      amount_cents: 4040,
      expires_at: '2026-12-31T12:00:00.000Z',
      idempotent: false,
      ...overrides,
    },
    error: null,
  };
}

function readyAttemptRow(overrides: Record<string, any> = {}) {
  return {
    id: ATTEMPT_ID,
    customer_id: CUSTOMER_ID,
    status: 'created',
    proof_count: 0,
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function attemptViewRow(overrides: Record<string, any> = {}) {
  return {
    id: ATTEMPT_ID,
    status: 'pending_review',
    trip_id: TRIP_ID,
    agency_id: AGENCY_ID,
    seat_ids: [SEAT_A1, SEAT_A2],
    passenger_data: [],
    unit_price: 2020,
    amount_cents: 4040,
    proof_count: 1,
    payment_reference: '00123456789',
    bank_origin: 'Banco de Venezuela',
    payment_datetime: '2020-01-01T10:00:00.000Z',
    proof_submitted_at: '2026-01-01T10:05:00.000Z',
    review_started_at: '2026-01-01T10:05:00.000Z',
    rejection_reason: null,
    rejection_count: 0,
    history: [],
    expires_at: '2099-01-01T00:00:00.000Z',
    created_at: '2026-01-01T10:00:00.000Z',
    closed_at: null,
    verified_at: null,
    ...overrides,
  };
}

function givenAuthAs(userId: string) {
  harness.setUser(() =>
    Promise.resolve({ data: { user: { id: userId } }, error: null }),
  );
}

function givenUserRole(role: string) {
  harness.push('users', {
    data: { id: CUSTOMER_ID, role, agency_id: null },
    error: null,
  });
}

function lastRpcCall() {
  const calls = harness.rpcCalls();
  return calls[calls.length - 1];
}

function rpcCallsFor(fn: string) {
  return harness.rpcCalls().filter((call) => call.fn === fn);
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
  init: {
    method?: string;
    body?: unknown;
    token?: string | null;
    idempotencyKey?: string | null;
  } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token !== null) {
    headers.Authorization = `Bearer ${init.token ?? 'token'}`;
  }
  if (init.idempotencyKey) {
    headers['Idempotency-Key'] = init.idempotencyKey;
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

async function postProof(
  port: number,
  options: {
    token?: string | null;
    idempotencyKey?: string | null;
    file?: { name: string; type: string; data: Buffer } | null;
    fields?: Record<string, string | null>;
  } = {},
) {
  const form = new FormData();
  const file = options.file === undefined
    ? { name: 'comprobante.png', type: 'image/png', data: pngBytes() }
    : options.file;
  if (file) {
    form.append('proof', new Blob([file.data], { type: file.type }), file.name);
  }
  const fields = {
    payment_reference: '00123456789',
    bank_origin: 'Banco de Venezuela',
    payment_datetime: '2020-01-01T10:00:00.000Z',
    ...options.fields,
  } as Record<string, string | null>;
  for (const [name, value] of Object.entries(fields)) {
    if (value === null) continue;
    form.append(name, value);
  }

  const headers: Record<string, string> = {};
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? 'token'}`;
  }
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const res = await fetch(
    `http://127.0.0.1:${port}/api/public/checkout/attempts/${ATTEMPT_ID}/proof`,
    { method: 'POST', headers, body: form },
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

describe('API pública de checkout (MKT-007)', () => {
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
    harness.setRpcDefault(RPC_CREATE, createdAttempt());
  });

  // ── POST /attempts ────────────────────────────────────────────────────────

  describe('POST /api/public/checkout/attempts', () => {
    it('crea el intento con solo parámetros server-side (happy path 201)', async () => {
      const { status, body } = await requestJson(
        port,
        '/api/public/checkout/attempts',
        {
          method: 'POST',
          body: validPayload(),
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      );

      expect(status).toBe(201);
      expect(body.attempt_id).toBe(ATTEMPT_ID);
      expect(body.status).toBe('created');
      expect(body.idempotent).toBe(false);
      expect(lastRpcCall().fn).toBe(RPC_CREATE);
      expect(Object.keys(lastRpcCall().args).sort()).toEqual(
        [
          'p_agency_id',
          'p_customer_id',
          'p_idempotency_key',
          'p_passenger_data',
          'p_seat_ids',
          'p_trip_id',
        ].sort(),
      );
      expect(lastRpcCall().args.p_customer_id).toBe(CUSTOMER_ID);
      expect(lastRpcCall().args.p_idempotency_key).toBe(IDEMPOTENCY_KEY);
    });

    it('deriva customer_id de la sesión e ignora autoridades del cliente', async () => {
      const { status } = await requestJson(
        port,
        '/api/public/checkout/attempts',
        {
          method: 'POST',
          body: validPayload({
            customer_id: OTHER_CUSTOMER_ID,
            unit_price: 1,
            amount_cents: 1,
            status: 'verified',
            expires_at: '2099-01-01T00:00:00.000Z',
          }),
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      );

      expect(status).toBe(201);
      const serialized = JSON.stringify(lastRpcCall().args);
      expect(serialized).not.toContain('customer_id":' + OTHER_CUSTOMER_ID);
      expect(lastRpcCall().args.p_customer_id).toBe(CUSTOMER_ID);
      expect(serialized).not.toContain('unit_price');
      expect(serialized).not.toContain('expires_at');
      expect(serialized).not.toContain('verified');
    });

    it('un retry con la misma Idempotency-Key devuelve 200 idempotent', async () => {
      harness.setRpcDefault(
        RPC_CREATE,
        createdAttempt({ idempotent: true }),
      );

      const { status, body } = await requestJson(
        port,
        '/api/public/checkout/attempts',
        {
          method: 'POST',
          body: validPayload(),
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      );

      expect(status).toBe(200);
      expect(body.idempotent).toBe(true);
      expect(body.attempt_id).toBe(ATTEMPT_ID);
      expect(lastRpcCall().args.p_idempotency_key).toBe(IDEMPOTENCY_KEY);
    });

    it('exige autenticación y rol customer', async () => {
      const anonymous = await requestJson(
        port,
        '/api/public/checkout/attempts',
        {
          method: 'POST',
          body: validPayload(),
          token: null,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      );
      expect(anonymous.status).toBe(401);
      expect(rpcCallsFor(RPC_CREATE)).toHaveLength(0);

      harness.reset();
      harness.setUser(() =>
        Promise.resolve({ data: { user: { id: SUPERADMIN_ID } }, error: null }),
      );
      givenUserRole('superadmin');
      const superadmin = await requestJson(
        port,
        '/api/public/checkout/attempts',
        {
          method: 'POST',
          body: validPayload(),
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      );
      expect(superadmin.status).toBe(403);
      expect(superadmin.body.error.code).toBe('CUSTOMER_REQUIRED');
      expect(rpcCallsFor(RPC_CREATE)).toHaveLength(0);
    });

    it('exige una Idempotency-Key UUID', async () => {
      const missing = await requestJson(
        port,
        '/api/public/checkout/attempts',
        { method: 'POST', body: validPayload() },
      );
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');

      const malformed = await requestJson(
        port,
        '/api/public/checkout/attempts',
        {
          method: 'POST',
          body: validPayload(),
          idempotencyKey: 'no-es-uuid',
        },
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(rpcCallsFor(RPC_CREATE)).toHaveLength(0);
    });

    it('valida el payload antes de tocar la base de datos', async () => {
      const duplicateSeats = await requestJson(
        port,
        '/api/public/checkout/attempts',
        {
          method: 'POST',
          body: validPayload({ seat_ids: [SEAT_A1, SEAT_A1] }),
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      );
      expect(duplicateSeats.status).toBe(400);
      expect(duplicateSeats.body.error.code).toBe('VALIDATION_ERROR');

      const duplicateDocument = validPayload();
      duplicateDocument.passengers[1].document =
        duplicateDocument.passengers[0].document;
      const duplicated = await requestJson(
        port,
        '/api/public/checkout/attempts',
        {
          method: 'POST',
          body: duplicateDocument,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      );
      expect(duplicated.status).toBe(400);

      const shortName = validPayload();
      shortName.passengers[0].first_name = 'A';
      const invalid = await requestJson(
        port,
        '/api/public/checkout/attempts',
        {
          method: 'POST',
          body: shortName,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      );
      expect(invalid.status).toBe(400);

      expect(rpcCallsFor(RPC_CREATE)).toHaveLength(0);
      const tablesQueried = harness.chains().map((c) => c.table);
      const nonAuthTables = tablesQueried.filter((t) => t !== 'users');
      expect(nonAuthTables).toHaveLength(0);
    });

    it('mapea los RAISE del RPC a los códigos accionables', async () => {
      const cases: Array<[string, number, string]> = [
        ['ERR_SEAT_LOCK_EXPIRED: expired', 409, 'CHECKOUT_LOCK_EXPIRED'],
        ['ERR_SEAT_NOT_OWNED: not owned', 404, 'CHECKOUT_SEAT_NOT_OWNED'],
        ['ERR_SEAT_NOT_FOUND: missing', 404, 'CHECKOUT_SEAT_NOT_OWNED'],
        ['ERR_CHECKOUT_SEAT_CLAIMED: claimed', 409, 'CHECKOUT_SEATS_CLAIMED'],
        [
          'ERR_CHECKOUT_IDEMPOTENCY_CONFLICT: conflict',
          409,
          'CHECKOUT_IDEMPOTENCY_CONFLICT',
        ],
        ['ERR_TRIP_PRICE_MISSING: no price', 422, 'CHECKOUT_TRIP_PRICE_MISSING'],
        ['ERR_AGENCY_NOT_ASSIGNED: no offer', 404, 'CHECKOUT_AGENCY_NOT_ASSIGNED'],
        ['ERR_TRIP_DEPARTED: departed', 409, 'CHECKOUT_TRIP_DEPARTED'],
        ['ERR_TRIP_NOT_ACTIVE: inactive', 409, 'CHECKOUT_TRIP_NOT_ACTIVE'],
        ['ERR_PASSENGER_MISMATCH: mismatch', 400, 'CHECKOUT_PASSENGER_MISMATCH'],
      ];

      for (const [message, expectedStatus, expectedCode] of cases) {
        harness.pushRpc(RPC_CREATE, { data: null, error: { message } });
        const { status, body } = await requestJson(
          port,
          '/api/public/checkout/attempts',
          {
            method: 'POST',
            body: validPayload(),
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        );
        expect(status).toBe(expectedStatus);
        expect(body.error.code).toBe(expectedCode);
        // El mensaje SQL jamás llega al cliente.
        expect(body.error.message).not.toContain('ERR_');
      }
    });

    it('nunca escribe reservations, reservation_passengers ni payments', async () => {
      const { status } = await requestJson(
        port,
        '/api/public/checkout/attempts',
        {
          method: 'POST',
          body: validPayload(),
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      );

      expect(status).toBe(201);
      const tables = harness.chains().map((chain) => chain.table);
      expect(tables).not.toContain('reservations');
      expect(tables).not.toContain('reservation_passengers');
      expect(tables).not.toContain('payments');
      expect(tables).not.toContain('seats');
    });
  });

  // ── GET /attempts/:attemptId ──────────────────────────────────────────────

  describe('GET /api/public/checkout/attempts/:attemptId', () => {
    it('devuelve la vista del dueño sin exponer la ruta del comprobante', async () => {
      harness.push('checkout_attempts', {
        data: attemptViewRow(),
        error: null,
      });
      harness.push('seats', {
        data: [
          { id: SEAT_A1, seat_code: 'A1' },
          { id: SEAT_A2, seat_code: 'A2' },
        ],
        error: null,
      });

      const { status, body } = await requestJson(
        port,
        `/api/public/checkout/attempts/${ATTEMPT_ID}`,
      );

      expect(status).toBe(200);
      expect(body.attempt_id).toBe(ATTEMPT_ID);
      expect(body.seat_codes).toEqual(['A1', 'A2']);
      expect(body.remaining_submissions).toBe(2);
      expect(body.proof_path).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('proof_path');
    });

    it('filtra por customer_id en el query, no en la aplicación', async () => {
      harness.push('checkout_attempts', {
        data: attemptViewRow(),
        error: null,
      });
      harness.push('seats', { data: [], error: null });

      await requestJson(port, `/api/public/checkout/attempts/${ATTEMPT_ID}`);

      const select = harness
        .chains()
        .filter((chain) => chain.table === 'checkout_attempts')
        .flatMap((chain) => chain.calls)
        .find((call) => call.method === 'select');
      const eqCalls = harness
        .chains()
        .filter((chain) => chain.table === 'checkout_attempts')
        .flatMap((chain) => chain.calls)
        .filter((call) => call.method === 'eq')
        .map((call) => call.args);
      expect(select).toBeTruthy();
      expect(eqCalls).toContainEqual(['customer_id', CUSTOMER_ID]);
      expect(eqCalls).toContainEqual(['id', ATTEMPT_ID]);
    });

    it('responde 404 cuando el intento no existe o es de otra persona', async () => {
      harness.push('checkout_attempts', { data: null, error: null });

      const { status, body } = await requestJson(
        port,
        `/api/public/checkout/attempts/${ATTEMPT_ID}`,
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe('CHECKOUT_ATTEMPT_NOT_FOUND');
    });

    it('exige autenticación y rol customer', async () => {
      const anonymous = await requestJson(
        port,
        `/api/public/checkout/attempts/${ATTEMPT_ID}`,
        { token: null },
      );
      expect(anonymous.status).toBe(401);

      harness.reset();
      harness.setUser(() =>
        Promise.resolve({ data: { user: { id: SUPERADMIN_ID } }, error: null }),
      );
      givenUserRole('superadmin');
      const superadmin = await requestJson(
        port,
        `/api/public/checkout/attempts/${ATTEMPT_ID}`,
      );
      expect(superadmin.status).toBe(403);
    });

    it('rechaza un attemptId que no es UUID', async () => {
      const { status, body } = await requestJson(
        port,
        '/api/public/checkout/attempts/no-es-uuid',
      );

      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── POST /attempts/:attemptId/proof ───────────────────────────────────────

  describe('POST /api/public/checkout/attempts/:attemptId/proof', () => {
    it('pre-chequea el intento ANTES de subir nada', async () => {
      harness.push('checkout_attempts', {
        data: null,
        error: null,
      });

      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(status).toBe(404);
      expect(body.error.code).toBe('CHECKOUT_ATTEMPT_NOT_FOUND');
      expect(harness.uploads()).toHaveLength(0);
      expect(rpcCallsFor(RPC_PROOF)).toHaveLength(0);
    });

    it('oculta los intentos ajenos con el mismo 404', async () => {
      harness.push('checkout_attempts', {
        data: readyAttemptRow({ customer_id: OTHER_CUSTOMER_ID }),
        error: null,
      });

      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(status).toBe(404);
      expect(body.error.code).toBe('CHECKOUT_ATTEMPT_NOT_FOUND');
      expect(harness.uploads()).toHaveLength(0);
    });

    it('bloquea un segundo envío mientras hay un comprobante en revisión', async () => {
      harness.push('checkout_attempts', {
        data: readyAttemptRow({ status: 'pending_review' }),
        error: null,
      });

      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(status).toBe(409);
      expect(body.error.code).toBe('CHECKOUT_PROOF_PENDING');
      expect(harness.uploads()).toHaveLength(0);
    });

    it('bloquea envíos cuando la compra ya fue cerrada', async () => {
      for (const status of ['verified', 'rejected_final', 'expired', 'cancelled']) {
        harness.push('checkout_attempts', {
          data: readyAttemptRow({ status }),
          error: null,
        });

        const { status: httpStatus, body } = await postProof(port, {
          idempotencyKey: IDEMPOTENCY_KEY,
        });

        expect(httpStatus).toBe(409);
        expect(body.error.code).toBe('CHECKOUT_ATTEMPT_CLOSED');
      }
      expect(harness.uploads()).toHaveLength(0);
    });

    it('bloquea cuando la ventana de revisión ya venció', async () => {
      harness.push('checkout_attempts', {
        data: readyAttemptRow({ expires_at: '2020-01-01T00:00:00.000Z' }),
        error: null,
      });

      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(status).toBe(409);
      expect(body.error.code).toBe('CHECKOUT_WINDOW_EXPIRED');
      expect(harness.uploads()).toHaveLength(0);
    });

    it('bloquea el cuarto comprobante (máximo 3 por intento)', async () => {
      harness.push('checkout_attempts', {
        data: readyAttemptRow({ proof_count: 3 }),
        error: null,
      });

      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(status).toBe(409);
      expect(body.error.code).toBe('CHECKOUT_PROOF_LIMIT');
      expect(harness.uploads()).toHaveLength(0);
    });

    it('sube y llama al RPC con la ruta derivada del CONTENIDO (201)', async () => {
      harness.push('checkout_attempts', {
        data: readyAttemptRow(),
        error: null,
      });
      harness.pushRpc(RPC_PROOF, submittedProof());

      const bytes = pngBytes(64);
      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        file: { name: 'nombre-atacante.png', type: 'image/png', data: bytes },
      });

      expect(status).toBe(201);
      expect(body.attempt_id).toBe(ATTEMPT_ID);
      expect(body.status).toBe('pending_review');
      expect(body.remaining_submissions).toBe(2);

      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(harness.uploads()).toHaveLength(1);
      expect(harness.uploads()[0].bucket).toBe('payment-proofs');
      expect(harness.uploads()[0].path).toBe(`${ATTEMPT_ID}/${digest}.png`);
      expect(harness.uploads()[0].upsert).toBe(true);

      const args = lastRpcCall().args;
      expect(lastRpcCall().fn).toBe(RPC_PROOF);
      expect(args.p_attempt_id).toBe(ATTEMPT_ID);
      expect(args.p_customer_id).toBe(CUSTOMER_ID);
      expect(args.p_idempotency_key).toBe(IDEMPOTENCY_KEY);
      expect(args.p_proof_path).toBe(`${ATTEMPT_ID}/${digest}.png`);
      expect(args.p_payment_reference).toBe('00123456789');
      expect(args.p_bank_origin).toBe('Banco de Venezuela');
      // La fecha se normaliza a ISO-8601 antes de llegar al RPC.
      expect(args.p_payment_datetime).toBe('2020-01-01T10:00:00.000Z');
    });

    it('devuelve 200 cuando el envío es idempotente', async () => {
      harness.push('checkout_attempts', {
        data: readyAttemptRow(),
        error: null,
      });
      harness.pushRpc(
        RPC_PROOF,
        submittedProof({ idempotent: true, proof_count: 1 }),
      );

      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(status).toBe(200);
      expect(body.idempotent).toBe(true);
    });

    it('exige Idempotency-Key UUID sin tocar storage ni RPC', async () => {
      const { status, body } = await postProof(port, { idempotencyKey: null });

      expect(status).toBe(400);
      expect(body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(harness.uploads()).toHaveLength(0);
      expect(rpcCallsFor(RPC_PROOF)).toHaveLength(0);
    });

    it('exige los tres datos de conciliación junto al archivo', async () => {
      harness.setDefault('checkout_attempts', {
        data: readyAttemptRow(),
        error: null,
      });

      const missingReference = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        fields: { payment_reference: null },
      });
      expect(missingReference.status).toBe(400);
      expect(missingReference.body.error.code).toBe(
        'CHECKOUT_RECONCILIATION_INVALID',
      );

      const missingBank = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        fields: { bank_origin: null },
      });
      expect(missingBank.status).toBe(400);

      const missingDatetime = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        fields: { payment_datetime: null },
      });
      expect(missingDatetime.status).toBe(400);

      expect(harness.uploads()).toHaveLength(0);
      expect(rpcCallsFor(RPC_PROOF)).toHaveLength(0);
    });

    it('rechaza conciliación vacía, malformada o con fecha futura', async () => {
      harness.setDefault('checkout_attempts', {
        data: readyAttemptRow(),
        error: null,
      });

      const emptyReference = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        fields: { payment_reference: '   ' },
      });
      expect(emptyReference.status).toBe(400);
      expect(emptyReference.body.error.code).toBe(
        'CHECKOUT_RECONCILIATION_INVALID',
      );

      const badDate = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        fields: { payment_datetime: 'ayer' },
      });
      expect(badDate.status).toBe(400);

      const futureDate = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        fields: { payment_datetime: '2999-01-01T00:00' },
      });
      expect(futureDate.status).toBe(400);

      expect(harness.uploads()).toHaveLength(0);
    });

    it('rechaza contenido sin magic bytes, MIME engañoso y formatos activos', async () => {
      harness.setDefault('checkout_attempts', {
        data: readyAttemptRow(),
        error: null,
      });

      const unrecognized = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        file: {
          name: 'comprobante.png',
          type: 'image/png',
          data: Buffer.from('hola mundo'),
        },
      });
      expect(unrecognized.status).toBe(400);
      expect(unrecognized.body.error.code).toBe('PAYMENT_FILE_INVALID');

      const mismatch = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        file: {
          name: 'comprobante.png',
          type: 'image/jpeg',
          data: pngBytes(),
        },
      });
      expect(mismatch.status).toBe(400);

      const svg = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        file: {
          name: 'comprobante.svg',
          type: 'image/svg+xml',
          data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        },
      });
      expect(svg.status).toBe(400);

      const empty = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        file: { name: 'comprobante.png', type: 'image/png', data: Buffer.alloc(0) },
      });
      expect(empty.status).toBe(400);

      const missingFile = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        file: null,
      });
      expect(missingFile.status).toBe(400);
      expect(missingFile.body.error.code).toBe('PAYMENT_FILE_MISSING');

      expect(harness.uploads()).toHaveLength(0);
      expect(rpcCallsFor(RPC_PROOF)).toHaveLength(0);
    });

    it('rechaza archivos mayores a 5 MiB sin subirlos', async () => {
      harness.push('checkout_attempts', {
        data: readyAttemptRow(),
        error: null,
      });

      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
        file: {
          name: 'comprobante.png',
          type: 'image/png',
          data: pngBytes(5 * 1024 * 1024 + 16),
        },
      });

      expect(status).toBe(413);
      expect(body.error.code).toBe('PAYMENT_FILE_TOO_LARGE');
      expect(harness.uploads()).toHaveLength(0);
    });

    it('limpia el objeto recién subido cuando el RPC falla', async () => {
      harness.push('checkout_attempts', {
        data: readyAttemptRow(),
        error: null,
      });
      harness.pushRpc(RPC_PROOF, {
        data: null,
        error: { message: 'ERR_CHECKOUT_RECONCILIATION: bad' },
      });
      // Chequeos de cleanup: ningún pago ni intento referencia el objeto.
      harness.push('payments', { data: null, error: null });
      harness.push('checkout_attempts', { data: null, error: null });

      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(status).toBe(400);
      expect(body.error.code).toBe('CHECKOUT_RECONCILIATION_INVALID');
      expect(harness.uploads()).toHaveLength(1);
      expect(harness.removes()).toHaveLength(1);
      expect(harness.removes()[0][0]).toBe(harness.uploads()[0].path);
    });

    it('nunca borra un objeto que un pago ya referencia', async () => {
      harness.push('checkout_attempts', {
        data: readyAttemptRow(),
        error: null,
      });
      harness.pushRpc(RPC_PROOF, {
        data: null,
        error: { message: 'ERR_CHECKOUT_WINDOW_EXPIRED: late' },
      });
      harness.push('payments', { data: { id: 'pay-1' }, error: null });

      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(status).toBe(409);
      expect(body.error.code).toBe('CHECKOUT_WINDOW_EXPIRED');
      expect(harness.removes()).toHaveLength(0);
    });

    it('mapea el fallo del storage a error de infraestructura', async () => {
      harness.push('checkout_attempts', {
        data: readyAttemptRow(),
        error: null,
      });
      harness.setUploadError({ message: 'bucket offline' });

      const { status, body } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(status).toBe(500);
      expect(body.error.code).toBe('PAYMENT_STORAGE_ERROR');
      expect(rpcCallsFor(RPC_PROOF)).toHaveLength(0);
    });

    it('exige rol customer también en el envío', async () => {
      harness.reset();
      harness.setUser(() =>
        Promise.resolve({ data: { user: { id: SUPERADMIN_ID } }, error: null }),
      );
      givenUserRole('superadmin');

      const { status } = await postProof(port, {
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(status).toBe(403);
      expect(harness.uploads()).toHaveLength(0);
    });
  });

  // ── POST /attempts/:attemptId/cancel ──────────────────────────────────────

  describe('POST /api/public/checkout/attempts/:attemptId/cancel', () => {
    it('cancela y libera los asientos del intento (200)', async () => {
      harness.pushRpc(RPC_CANCEL, {
        data: {
          attempt_id: ATTEMPT_ID,
          status: 'cancelled',
          already_cancelled: false,
          freed_seats: 2,
        },
        error: null,
      });

      const { status, body } = await requestJson(
        port,
        `/api/public/checkout/attempts/${ATTEMPT_ID}/cancel`,
        { method: 'POST' },
      );

      expect(status).toBe(200);
      expect(body.status).toBe('cancelled');
      expect(body.freed_seats).toBe(2);
      expect(lastRpcCall().fn).toBe(RPC_CANCEL);
      expect(lastRpcCall().args).toEqual({
        p_attempt_id: ATTEMPT_ID,
        p_customer_id: CUSTOMER_ID,
      });
    });

    it('reporta already_cancelled sin inventar asientos liberados', async () => {
      harness.pushRpc(RPC_CANCEL, {
        data: {
          attempt_id: ATTEMPT_ID,
          status: 'cancelled',
          already_cancelled: true,
          freed_seats: 0,
        },
        error: null,
      });

      const { status, body } = await requestJson(
        port,
        `/api/public/checkout/attempts/${ATTEMPT_ID}/cancel`,
        { method: 'POST' },
      );

      expect(status).toBe(200);
      expect(body.already_cancelled).toBe(true);
      expect(body.freed_seats).toBe(0);
    });

    it('responde 404 cuando el intento no existe o es de otra persona', async () => {
      harness.pushRpc(RPC_CANCEL, {
        data: null,
        error: { message: 'ERR_CHECKOUT_NOT_OWNER: not yours' },
      });

      const { status, body } = await requestJson(
        port,
        `/api/public/checkout/attempts/${ATTEMPT_ID}/cancel`,
        { method: 'POST' },
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe('CHECKOUT_ATTEMPT_NOT_FOUND');
    });

    it('exige autenticación y rol customer', async () => {
      const anonymous = await requestJson(
        port,
        `/api/public/checkout/attempts/${ATTEMPT_ID}/cancel`,
        { method: 'POST', token: null },
      );
      expect(anonymous.status).toBe(401);

      harness.reset();
      harness.setUser(() =>
        Promise.resolve({ data: { user: { id: SUPERADMIN_ID } }, error: null }),
      );
      givenUserRole('superadmin');
      const superadmin = await requestJson(
        port,
        `/api/public/checkout/attempts/${ATTEMPT_ID}/cancel`,
        { method: 'POST' },
      );
      expect(superadmin.status).toBe(403);
      expect(rpcCallsFor(RPC_CANCEL)).toHaveLength(0);
    });
  });
});
