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
  type RpcCall = { fn: string; args: any };

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    chains: ChainRecord[];
    rpcQueues: Record<string, QueryResult[]>;
    rpcDefaults: Record<string, QueryResult>;
    rpcCalls: RpcCall[];
    getUser: (token: string) => Promise<any>;
  } = {
    queues: {},
    defaults: {},
    chains: [],
    rpcQueues: {},
    rpcDefaults: {},
    rpcCalls: [],
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
    const record: ChainRecord = { table: `rpc:${fn}`, calls: [{ method: 'rpc', args: [args] }] };
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
const OTHER_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';
const SUPERADMIN_ID = '55555555-5555-4555-8555-555555555555';
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const OTHER_TRIP_ID = '551559e6-ea35-4453-aae1-5ed0844289b3';
const AGENCY_ID = '5bf0be5d-c03a-431f-97d5-e2a065e25752';
const SEAT_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SEAT_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const RESERVATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const RPC = 'create_marketplace_reservation';

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

function createdRpcResult(overrides: Record<string, any> = {}) {
  return {
    data: {
      reservation_id: RESERVATION_ID,
      trip_id: TRIP_ID,
      agency_id: AGENCY_ID,
      customer_id: CUSTOMER_ID,
      status: 'locked',
      source: 'marketplace',
      unit_price: 1500000,
      passenger_count: 2,
      seat_ids: [SEAT_A1, SEAT_A2],
      qr_code: 'NT-SAN-CRISTOBAL-BBBBBBBBBBBB1',
      ticket_code: 'BBBBBBBB',
      idempotent: false,
      ...overrides,
    },
    error: null,
  };
}

function givenAuthAs(userId: string) {
  harness.setUser(() =>
    Promise.resolve({ data: { user: { id: userId } }, error: null }),
  );
}

function givenUserRole(role: string) {
  harness.push('users', { data: { id: CUSTOMER_ID, role, agency_id: null }, error: null });
}

function lastRpcCall() {
  const calls = harness.rpcCalls();
  return calls[calls.length - 1];
}

function tableCalls(table: string) {
  return harness
    .chains()
    .filter((chain) => chain.table === table)
    .flatMap((chain) => chain.calls);
}

async function startServer(): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function postReservation(
  port: number,
  body: unknown,
  options: { token?: string | null } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? 'token'}`;
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/public/reservations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

describe('POST /api/public/reservations', () => {
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
    // auth consulta users en CADA request: default estable + push para overrides.
    harness.setDefault('users', {
      data: { id: CUSTOMER_ID, role: 'customer', agency_id: null },
      error: null,
    });
  });

  it('crea la reserva del checkout con todos sus pasajeros (happy path)', async () => {
    harness.pushRpc(RPC, createdRpcResult());

    const { status, body } = await postReservation(port, validPayload());

    expect(status).toBe(201);
    expect(body.reservation_id).toBe(RESERVATION_ID);
    expect(body.status).toBe('locked');
    expect(body.source).toBe('marketplace');
    expect(body.customer_id).toBe(CUSTOMER_ID);
    expect(body.passenger_count).toBe(2);
    expect(body.idempotent).toBe(false);
    expect(harness.rpcCalls()).toHaveLength(1);
    expect(lastRpcCall().fn).toBe(RPC);
  });

  it('deriva customer_id del auth y solo envía los parámetros server-side', async () => {
    harness.pushRpc(RPC, createdRpcResult());

    const payload = validPayload({
      customer_id: OTHER_CUSTOMER_ID,
      source: 'internal',
      status: 'confirmed',
      payment_status: 'fully_paid',
    });
    const { status } = await postReservation(port, payload);

    expect(status).toBe(201);
    expect(Object.keys(lastRpcCall().args).sort()).toEqual(
      [
        'p_agency_id',
        'p_customer_id',
        'p_passenger_documents',
        'p_passenger_names',
        'p_passenger_phones',
        'p_seat_ids',
        'p_trip_id',
      ].sort(),
    );
    expect(lastRpcCall().args.p_customer_id).toBe(CUSTOMER_ID);
    expect(lastRpcCall().args.p_trip_id).toBe(TRIP_ID);
    expect(lastRpcCall().args.p_agency_id).toBe(AGENCY_ID);
  });

  it('alinea cada pasajero con su asiento aunque vengan en otro orden', async () => {
    harness.pushRpc(RPC, createdRpcResult());

    const payload = validPayload();
    payload.passengers = [payload.passengers[1], payload.passengers[0]];

    const { status } = await postReservation(port, payload);

    expect(status).toBe(201);
    const args = lastRpcCall().args;
    expect(args.p_seat_ids).toEqual([SEAT_A1, SEAT_A2]);
    expect(args.p_passenger_names).toEqual(['Ana Perez', 'Luis Gomez']);
    expect(args.p_passenger_documents).toEqual(['12345678', '87654321']);
    expect(args.p_passenger_phones).toEqual(['04241234567', '04141234567']);
  });

  it('rechaza seats que no estan bloqueados por este customer', async () => {
    harness.pushRpc(RPC, {
      data: null,
      error: { message: 'ERR_SEAT_NOT_OWNED: Seat A1 is not locked by this customer' },
    });

    const { status, body } = await postReservation(port, validPayload());

    expect(status).toBe(409);
    expect(body.error.code).toBe('SEAT_NOT_OWNED');
  });

  it('rechaza seats que no pertenecen al trip', async () => {
    harness.pushRpc(RPC, {
      data: null,
      error: { message: 'ERR_SEAT_NOT_FOUND: One or more seats not found in this trip' },
    });

    const { status, body } = await postReservation(port, validPayload());

    expect(status).toBe(404);
    expect(body.error.code).toBe('SEAT_NOT_FOUND');
    expect(OTHER_TRIP_ID).not.toBe(TRIP_ID);
  });

  it('rechaza creacion sin autenticacion y sin rol customer', async () => {
    const anonymous = await postReservation(port, validPayload(), { token: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');
    expect(harness.rpcCalls()).toHaveLength(0);

    harness.reset();
    harness.setUser(() =>
      Promise.resolve({ data: { user: { id: SUPERADMIN_ID } }, error: null }),
    );
    givenUserRole('superadmin');
    const superadmin = await postReservation(port, validPayload());
    expect(superadmin.status).toBe(403);
    expect(superadmin.body.error.code).toBe('CUSTOMER_REQUIRED');
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza un seat cuyo lock ya expiro', async () => {
    harness.pushRpc(RPC, {
      data: null,
      error: { message: 'ERR_SEAT_LOCK_EXPIRED: Seat A1 lock expired' },
    });

    const { status, body } = await postReservation(port, validPayload());

    expect(status).toBe(409);
    expect(body.error.code).toBe('SEAT_LOCK_EXPIRED');
  });

  it('rechaza asientos duplicados en el payload', async () => {
    const payload = validPayload();
    payload.seat_ids = [SEAT_A1, SEAT_A1];

    const { status, body } = await postReservation(port, payload);

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza documento repetido en la reserva', async () => {
    const payload = validPayload();
    payload.passengers[1].document = payload.passengers[0].document;

    const { status, body } = await postReservation(port, payload);

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza cuando el numero de pasajeros no coincide con los asientos', async () => {
    const payload = validPayload();
    payload.passengers = [payload.passengers[0]];

    const { status, body } = await postReservation(port, payload);

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza pasajeros con datos obligatorios incompletos o invalidos', async () => {
    const shortName = validPayload();
    shortName.passengers[0].first_name = 'A';
    const nameRejected = await postReservation(port, shortName);
    expect(nameRejected.status).toBe(400);
    expect(nameRejected.body.error.code).toBe('VALIDATION_ERROR');

    const badDocument = validPayload();
    badDocument.passengers[0].document = '12A4567';
    const documentRejected = await postReservation(port, badDocument);
    expect(documentRejected.status).toBe(400);

    const badPhone = validPayload();
    badPhone.passengers[0].phone = '12345';
    const phoneRejected = await postReservation(port, badPhone);
    expect(phoneRejected.status).toBe(400);

    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza payload invalido con el envelope estandar', async () => {
    const badTrip = await postReservation(port, validPayload({ trip_id: 'no-es-uuid' }));
    expect(badTrip.status).toBe(400);
    expect(badTrip.body.error.code).toBe('VALIDATION_ERROR');

    const empty = await postReservation(
      port,
      validPayload({ seat_ids: [], passengers: [] }),
    );
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');

    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('no deja reservation huérfana si la creación falla (todo vive en el RPC)', async () => {
    harness.pushRpc(RPC, {
      data: null,
      error: { message: 'insert failed: relation "reservation_passengers"' },
    });

    const { status, body } = await postReservation(port, validPayload());

    expect(status).toBe(500);
    expect(body.error.code).toBe('RESERVATION_CREATE_ERROR');
    // El backend nunca escribe en reservations/reservation_passengers por
    // separado: un fallo dentro del RPC revierte la reservation completa
    // (transacción única en PostgreSQL). Aquí comprobamos que no existen
    // escrituras de aplicación sobre esas tablas ni sobre seats.
    expect(tableCalls('reservations')).toHaveLength(0);
    expect(tableCalls('reservation_passengers')).toHaveLength(0);
    expect(tableCalls('seats')).toHaveLength(0);
  });

  it('no modifica seats ni lock_expires_at (el TTL queda intacto)', async () => {
    harness.pushRpc(RPC, createdRpcResult());

    const { status } = await postReservation(port, validPayload());

    expect(status).toBe(201);
    expect(tableCalls('seats')).toHaveLength(0);
    const args = lastRpcCall().args;
    expect(Object.keys(args)).not.toContain('ttl_seconds');
    expect(Object.keys(args)).not.toContain('lock_expires_at');
    expect(JSON.stringify(args)).not.toContain('lock_expires_at');
  });

  it('ignora unit_price enviado por el cliente (snapshot server-side)', async () => {
    harness.pushRpc(RPC, createdRpcResult({ unit_price: 1500000 }));

    const payload = validPayload({ unit_price: 1 });
    payload.passengers[0].unit_price = 1;
    payload.passengers[1].unit_price = 1;

    const { status, body } = await postReservation(port, payload);

    expect(status).toBe(201);
    expect(body.unit_price).toBe(1500000);
    expect(JSON.stringify(lastRpcCall().args)).not.toContain('unit_price');
  });

  it('valida la oferta de agencia y responde409 si no corresponde al trip', async () => {
    harness.pushRpc(RPC, {
      data: null,
      error: {
        message: 'ERR_AGENCY_NOT_ASSIGNED: The trip is not offered by this agency',
      },
    });

    const { status, body } = await postReservation(port, validPayload());

    expect(status).toBe(409);
    expect(body.error.code).toBe('AGENCY_NOT_ASSIGNED');
  });

  it('un retry del mismo checkout devuelve la misma reserva (idempotente)', async () => {
    harness.pushRpc(RPC, createdRpcResult({ idempotent: false }));
    harness.pushRpc(RPC, createdRpcResult({ idempotent: true }));

    const first = await postReservation(port, validPayload());
    expect(first.status).toBe(201);
    expect(first.body.idempotent).toBe(false);

    const second = await postReservation(port, validPayload());
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.reservation_id).toBe(RESERVATION_ID);

    expect(harness.rpcCalls()).toHaveLength(2);
    expect(harness.rpcCalls()[0].args).toEqual(harness.rpcCalls()[1].args);
    // La dedupe ocurre dentro del RPC; la app nunca inserta por su cuenta.
    expect(tableCalls('reservations')).toHaveLength(0);
    expect(tableCalls('reservation_passengers')).toHaveLength(0);
  });

  it('rechaza la creacion cuando el viaje no tiene precio que snapshotear', async () => {
    harness.pushRpc(RPC, {
      data: null,
      error: { message: 'ERR_TRIP_PRICE_MISSING: Trip has no seat_price to snapshot' },
    });

    const { status, body } = await postReservation(port, validPayload());

    expect(status).toBe(422);
    expect(body.error.code).toBe('TRIP_PRICE_MISSING');
  });
});
