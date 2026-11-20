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
    // MKT-010.1: la RPC de progreso SOLO se invoca en compras two_stage
    // con reserva. Sin configurar, el rpc sigue lanzando (los tests
    // legados de plan único siguen demostrando que NO se invoca).
    pushRpc(fn: string, result: QueryResult) {
      (state.rpcQueues[fn] ||= []).push(result);
    },
    setRpcDefault(fn: string, result: QueryResult) {
      state.rpcDefaults[fn] = result;
    },
    rpcCalls: () => state.rpcCalls,
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
    from: (table: string) => buildChain(table),
    rpc: (fn: string, args: any) => {
      state.rpcCalls.push({ fn, args });
      const queue = state.rpcQueues[fn];
      const result =
        queue && queue.length > 0
          ? queue.shift()!
          : state.rpcDefaults[fn];
      if (result === undefined) {
        throw new Error(`rpc no debe invocarse en GET historial: ${fn}`);
      }
      return Promise.resolve(result);
    },
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
const OTHER_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const ROUTE_ID = '551559e6-ea35-4453-aae1-5ed0844289b4';
const AGENCY_ID = '5bf0be5d-c03a-431f-97d5-e2a065e25752';
const SEAT_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SEAT_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const ATTEMPT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const PAYMENT_ID = 'pppppppp-pppp-4ppp-8ppp-ppppppppppp1';
const RESERVATION_ID = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrr1';
const HISTORY_URL = '/api/public/checkout/attempts';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
// MKT-010.1: RPC de progreso server-side (migración 106).
const RPC_PROGRESS = 'reservation_payment_progress';

function attemptRow(overrides: Record<string, any> = {}) {
  return {
    id: ATTEMPT_ID,
    status: 'created',
    trip_id: TRIP_ID,
    agency_id: AGENCY_ID,
    seat_ids: [SEAT_A1, SEAT_A2],
    passenger_data: [
      {
        seat_id: SEAT_A1,
        first_name: 'Ana',
        last_name: 'Pérez',
        document: '12345678',
        phone: '04241112233',
      },
      {
        seat_id: SEAT_A2,
        first_name: 'Luis',
        last_name: 'Gómez',
        document: '87654321',
        phone: '04144445566',
      },
    ],
    unit_price: 2020,
    amount_cents: 4040,
    // MKT-010.1: plan congelado en la creación (106). Por defecto el
    // plan legado de un solo pago, igual que en la BD.
    payment_plan: 'single',
    deposit_cents: null,
    proof_count: 0,
    payment_reference: null,
    bank_origin: null,
    payment_datetime: null,
    proof_submitted_at: null,
    rejection_reason: null,
    rejection_count: 0,
    expires_at: FUTURE,
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

function givenUserRole(role: string, agencyId: string | null = null) {
  harness.push('users', {
    data: { id: CUSTOMER_ID, role, agency_id: agencyId },
    error: null,
  });
}

function givenHistory(rows: unknown[]) {
  harness.push('checkout_attempts', { data: rows, error: null });
}

/** Contexto completo (seats, trips, routes, agencies) para un intento. */
function givenTripContext(
  tripOverrides: Record<string, any> = {},
) {
  harness.push('seats', {
    data: [
      { id: SEAT_A1, seat_code: 'A1' },
      { id: SEAT_A2, seat_code: 'A2' },
    ],
    error: null,
  });
  harness.push('trips', {
    data: [
      {
        id: TRIP_ID,
        route_id: ROUTE_ID,
        departure_time: '2026-12-01T08:00:00.000Z',
        // MKT-010.1: vencimientos EN VIVO del viaje (plan dos partes).
        deposit_deadline: null,
        balance_deadline: null,
        ...tripOverrides,
      },
    ],
    error: null,
  });
  harness.push('routes', {
    data: [{ id: ROUTE_ID, origin: 'Caracas', destination: 'Maracaibo' }],
    error: null,
  });
  harness.push('agencies', {
    data: [{ id: AGENCY_ID, name: 'Rutas del Sol' }],
    error: null,
  });
}

function paymentRow(overrides: Record<string, any> = {}) {
  return {
    id: PAYMENT_ID,
    reservation_id: RESERVATION_ID,
    idempotency_key: `mkt007:${ATTEMPT_ID}:verify`,
    status: 'verified',
    amount_cents: 4040,
    currency: 'COP',
    verified_at: '2026-01-02T10:00:00.000Z',
    stage: 'full',
    ...overrides,
  };
}

function reservationRow(overrides: Record<string, any> = {}) {
  return {
    id: RESERVATION_ID,
    status: 'reserved',
    payment_status: 'fully_paid',
    ticket_code: 'ABCD1234',
    created_at: '2026-01-02T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Payload EXACTO de `reservation_payment_progress` (RPC 106): montos,
 * porcentajes y vencimientos server-side; `overdue` solo informativo
 * (nunca cancela) y `seats_held` informa el estado real de los asientos.
 */
function progressPayload(overrides: Record<string, any> = {}) {
  return {
    reservation_id: RESERVATION_ID,
    reservation_status: 'confirmed',
    payment_status: 'partial',
    plan: 'two_stage',
    passenger_count: 2,
    total_cents: 4040,
    deposit_cents: 2020,
    deposit_verified_at: '2026-01-02T10:00:00.000Z',
    paid_cents: 2020,
    balance_cents: 2020,
    deposit_pct: 50,
    balance_pct: 50,
    deposit_deadline: '2026-12-30T00:00:00.000Z',
    balance_deadline: '2026-12-31T00:00:00.000Z',
    deposit_overdue: false,
    balance_overdue: false,
    seats_held: true,
    payments: [
      {
        id: 'pay-deposit-1',
        stage: 'deposit',
        status: 'verified',
        amount_cents: 2020,
        currency: 'COP',
        external_reference: '00123456789',
        bank_origin: 'Banco de Venezuela',
        payment_datetime: '2026-01-02T09:00:00.000Z',
        submitted_at: '2026-01-02T09:00:00.000Z',
        verified_at: '2026-01-02T10:00:00.000Z',
        rejection_reason: null,
      },
    ],
    agency: { id: AGENCY_ID, name: 'Rutas del Sol', whatsapp_phone: null },
    ...overrides,
  };
}

/** Fila de pago de verificación en dos partes (etapa deposit). */
function depositVerifyPaymentRow(overrides: Record<string, any> = {}) {
  return paymentRow({
    amount_cents: 2020,
    stage: 'deposit',
    ...overrides,
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
  init: { token?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  if (init.token !== null) {
    headers.Authorization = `Bearer ${init.token ?? 'token'}`;
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

function queryChains() {
  return harness.chains().filter((chain) => chain.table !== 'users');
}

describe('GET /api/public/checkout/attempts — historial de compras (RT-01)', () => {
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
    harness.setDefault('checkout_attempts', { data: [], error: null });
    harness.setDefault('seats', { data: [], error: null });
    harness.setDefault('trips', { data: [], error: null });
    harness.setDefault('routes', { data: [], error: null });
    harness.setDefault('agencies', { data: [], error: null });
    harness.setDefault('payments', { data: [], error: null });
    harness.setDefault('reservations', { data: [], error: null });
  });

  // ── Autenticación y rol ────────────────────────────────────────────────────

  it('responde 401 sin encabezado Authorization', async () => {
    const { status, body } = await requestJson(port, HISTORY_URL, { token: null });
    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('responde 401 con token inválido', async () => {
    harness.setUser(() =>
      Promise.resolve({ data: { user: null }, error: { message: 'bad token' } }),
    );
    const { status, body } = await requestJson(port, HISTORY_URL);
    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('responde 403 a una cuenta de agencia', async () => {
    givenUserRole('agency', AGENCY_ID);
    const { status, body } = await requestJson(port, HISTORY_URL);
    expect(status).toBe(403);
    expect(body.error.code).toBe('CUSTOMER_REQUIRED');
  });

  it('responde 403 a una cuenta superadmin', async () => {
    givenUserRole('superadmin');
    const { status, body } = await requestJson(port, HISTORY_URL);
    expect(status).toBe(403);
    expect(body.error.code).toBe('CUSTOMER_REQUIRED');
  });

  // ── Lista vacía ────────────────────────────────────────────────────────────

  it('devuelve lista vacía sin tocar otras tablas ni fabricar datos', async () => {
    const { status, body } = await requestJson(port, HISTORY_URL);
    expect(status).toBe(200);
    expect(body).toEqual({
      items: [],
      limit: 20,
      offset: 0,
      has_more: false,
    });
    expect(queryChains().map((chain) => chain.table)).toEqual(['checkout_attempts']);
  });

  // ── Estados del DTO ────────────────────────────────────────────────────────

  it('estado pendiente_comprobante cuando el intento aún no tiene comprobante', async () => {
    givenHistory([attemptRow()]);
    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.status).toBe('created');
    expect(item.estado).toBe('pendiente_comprobante');
    expect(item.accion).toBe('enviar_comprobante');
    expect(item.mensaje).toContain('falta enviar el comprobante');
    expect(item.comprobante).toBeNull();
    expect(item.pago).toBeNull();
    expect(item.reserva).toBeNull();
    expect(item.ventana.vencida).toBe(false);
  });

  it('estado expirado cuando la ventana de envío venció (status crudo conservado)', async () => {
    givenHistory([attemptRow({ expires_at: PAST })]);
    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.status).toBe('created');
    expect(item.estado).toBe('expirado');
    expect(item.accion).toBe('ninguna');
    expect(item.ventana.vencida).toBe(true);
  });

  it('estado en_revision con comprobante NO implica reserva ni pago', async () => {
    givenHistory([
      attemptRow({
        status: 'pending_review',
        proof_count: 1,
        payment_reference: '00123456789',
        bank_origin: 'Banco de Venezuela',
        payment_datetime: PAST,
        proof_submitted_at: '2026-01-01T10:05:00.000Z',
      }),
    ]);
    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.estado).toBe('en_revision');
    expect(item.comprobante.envios).toBe(1);
    expect(item.comprobante.restantes).toBe(2);
    expect(item.comprobante.referencia).toBe('00123456789');
    expect(item.pago).toBeNull();
    expect(item.reserva).toBeNull();
    expect(item.ventana.vencida).toBe(false);
  });

  it('reserva_confirmada solo cuando existe la reserva nacida en verify', async () => {
    givenHistory([
      attemptRow({
        status: 'verified',
        proof_count: 1,
        proof_submitted_at: '2026-01-01T10:05:00.000Z',
        verified_at: '2026-01-02T10:00:00.000Z',
        closed_at: '2026-01-02T10:00:00.000Z',
      }),
    ]);
    givenTripContext();
    harness.push('payments', { data: [paymentRow()], error: null });
    harness.push('reservations', { data: [reservationRow()], error: null });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.estado).toBe('reserva_confirmada');
    expect(item.accion).toBe('ver_reserva');
    expect(item.mensaje).toContain('Reserva confirmada');
    expect(item.reserva).toEqual({
      id: RESERVATION_ID,
      status: 'reserved',
      payment_status: 'fully_paid',
      ticket_code: 'ABCD1234',
      created_at: '2026-01-02T10:00:00.000Z',
    });
    expect(item.pago).toEqual({
      id: PAYMENT_ID,
      estado: 'aprobado',
      amount_cents: 4040,
      currency: 'COP',
      aprobado_en: '2026-01-02T10:00:00.000Z',
      stage: 'full',
    });
    expect(item.trip).toEqual({
      id: TRIP_ID,
      origin: 'Caracas',
      destination: 'Maracaibo',
      departure_time: '2026-12-01T08:00:00.000Z',
    });
    expect(item.agency).toEqual({ id: AGENCY_ID, name: 'Rutas del Sol' });
    expect(item.pasajeros).toEqual({
      total: 2,
      asientos: ['A1', 'A2'],
      detalle: [
        { asiento: 'A1', nombre: 'Ana Pérez', documento: '12345678' },
        { asiento: 'A2', nombre: 'Luis Gómez', documento: '87654321' },
      ],
    });
  });

  it('verified sin fila de pago queda como aprobado y no fabrica una reserva', async () => {
    givenHistory([
      attemptRow({
        status: 'verified',
        verified_at: '2026-01-02T10:00:00.000Z',
      }),
    ]);
    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.estado).toBe('aprobado');
    expect(item.reserva).toBeNull();
    expect(item.pago).toBeNull();
    expect(JSON.stringify(body)).not.toContain(RESERVATION_ID);
    expect(JSON.stringify(body)).not.toContain(PAYMENT_ID);
  });

  it('estado rechazado permite reenviar mientras la ventana siga abierta', async () => {
    givenHistory([
      attemptRow({
        status: 'rejected',
        proof_count: 1,
        rejection_count: 1,
        rejection_reason: 'La referencia no coincide con el monto',
        payment_reference: '00123456789',
        bank_origin: 'Banco de Venezuela',
        payment_datetime: PAST,
      }),
    ]);
    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.estado).toBe('rechazado');
    expect(item.puede_reenviar_comprobante).toBe(true);
    expect(item.accion).toBe('reenviar_comprobante');
    expect(item.mensaje).toContain('puedes enviar uno nuevo');
    expect(item.comprobante.motivo_rechazo).toBe('La referencia no coincide con el monto');
    expect(item.comprobante.rechazos).toBe(1);
    expect(item.reserva).toBeNull();
  });

  it('estado rechazado_final nunca ofrece reenvío', async () => {
    givenHistory([
      attemptRow({
        status: 'rejected_final',
        proof_count: 3,
        rejection_count: 3,
        rejection_reason: 'Documento inválido',
        expires_at: PAST,
        closed_at: PAST,
      }),
    ]);
    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.estado).toBe('rechazado_final');
    expect(item.puede_reenviar_comprobante).toBe(false);
    expect(item.accion).toBe('ninguna');
  });

  it('estado expirado para intentos cerrados por la ventana', async () => {
    givenHistory([attemptRow({ status: 'expired', expires_at: PAST, closed_at: PAST })]);
    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    expect(body.items[0].estado).toBe('expirado');
    expect(body.items[0].status).toBe('expired');
  });

  it('estado cancelado para intentos cancelados por el cliente', async () => {
    givenHistory([attemptRow({ status: 'cancelled', closed_at: PAST })]);
    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    expect(body.items[0].estado).toBe('cancelado');
    expect(body.items[0].status).toBe('cancelled');
  });

  it('explica la causa real cuando el rechazo no admite reenvío', async () => {
    givenHistory([
      attemptRow({
        status: 'rejected',
        proof_count: 1,
        rejection_count: 1,
        expires_at: PAST,
      }),
    ]);
    const expired = await requestJson(port, HISTORY_URL);
    expect(expired.body.items[0].estado).toBe('rechazado');
    expect(expired.body.items[0].puede_reenviar_comprobante).toBe(false);
    expect(expired.body.items[0].mensaje).toContain('el plazo de reenvío venció');

    givenHistory([
      attemptRow({
        status: 'rejected',
        proof_count: 3,
        rejection_count: 3,
        expires_at: FUTURE,
      }),
    ]);
    const limited = await requestJson(port, HISTORY_URL);
    expect(limited.body.items[0].estado).toBe('rechazado');
    expect(limited.body.items[0].puede_reenviar_comprobante).toBe(false);
    expect(limited.body.items[0].mensaje).toContain('se alcanzó el límite de 3 envíos');
  });

  // ── Mapeo de pagos ─────────────────────────────────────────────────────────

  it('pago pendiente se presenta como pendiente', async () => {
    givenHistory([attemptRow({ status: 'pending_review', proof_count: 1 })]);
    harness.push('payments', {
      data: [paymentRow({ status: 'pending', verified_at: null })],
      error: null,
    });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.estado).toBe('en_revision');
    expect(item.pago.estado).toBe('pendiente');
    expect(item.pago.aprobado_en).toBeNull();
  });

  it('pago rechazado se presenta como rechazado', async () => {
    givenHistory([attemptRow({ status: 'pending_review', proof_count: 1 })]);
    harness.push('payments', {
      data: [paymentRow({ status: 'rejected', verified_at: null })],
      error: null,
    });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    expect(body.items[0].pago.estado).toBe('rechazado');
  });

  it('un estado de pago desconocido nunca se presenta como aprobado', async () => {
    givenHistory([attemptRow({ status: 'pending_review', proof_count: 1 })]);
    harness.push('payments', {
      data: [paymentRow({ status: 'chargeback', verified_at: null })],
      error: null,
    });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    expect(body.items[0].pago.estado).toBe('pendiente');
    expect(body.items[0].pago.estado).not.toBe('aprobado');
  });

  // ── Paginación ─────────────────────────────────────────────────────────────

  it('pagina con has_more cuando hay más filas que el limit', async () => {
    const rows = Array.from({ length: 21 }, (_, index) =>
      attemptRow({
        id: `eeeeeeee-eeee-4eee-8eee-eeeeeeeeee${String(index).padStart(3, '0')}`,
        created_at: `2026-01-${String(21 - index).padStart(2, '0')}T10:00:00.000Z`,
      }),
    );
    givenHistory(rows);

    const { status, body } = await requestJson(port, HISTORY_URL);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(20);
    expect(body.has_more).toBe(true);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  it('respeta limit y offset explícitos en la respuesta', async () => {
    const { status, body } = await requestJson(port, `${HISTORY_URL}?limit=5&offset=10`);
    expect(status).toBe(200);
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(10);
    expect(body.items).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it('rechaza limit/offset fuera de rango con VALIDATION_ERROR', async () => {
    for (const query of ['?limit=0', '?limit=51', '?offset=-1', '?limit=abc']) {
      const { status, body } = await requestJson(port, `${HISTORY_URL}${query}`);
      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
    // La validación es anterior a cualquier consulta: cero queries.
    expect(queryChains()).toEqual([]);
  });

  it('pagina por offset con filas: página correcta, orden estable y has_more coherente', async () => {
    // Límite del mock: no aplica order/range (los aplica Postgres); se emula la
    // fila que Postgres devolvería para cada range y se verifica que el
    // servicio emita las cláusulas correctas y recorte de forma coherente.
    const rows = Array.from({ length: 12 }, (_, index) =>
      attemptRow({
        id: `eeeeeeee-eeee-4eee-8eee-eeeeeeeeee${String(index).padStart(3, '0')}`,
        created_at: `2026-01-${String(12 - index).padStart(2, '0')}T10:00:00.000Z`,
      }),
    );

    // range(5, 10) devuelve 6 filas (limit 5 + 1 extra): hay más allá de la página.
    givenHistory(rows.slice(5, 11));
    const mid = await requestJson(port, `${HISTORY_URL}?limit=5&offset=5`);

    expect(mid.status).toBe(200);
    expect(mid.body.limit).toBe(5);
    expect(mid.body.offset).toBe(5);
    expect(mid.body.items.map((item: any) => item.attempt_id)).toEqual(
      rows.slice(5, 10).map((row) => row.id),
    );
    expect(mid.body.has_more).toBe(true);

    // range(10, 15) devuelve 2 filas: última página.
    givenHistory(rows.slice(10, 12));
    const last = await requestJson(port, `${HISTORY_URL}?limit=5&offset=10`);

    expect(last.status).toBe(200);
    expect(last.body.items.map((item: any) => item.attempt_id)).toEqual(
      rows.slice(10, 12).map((row) => row.id),
    );
    expect(last.body.has_more).toBe(false);

    const attemptChains = harness
      .chains()
      .filter((chain) => chain.table === 'checkout_attempts');
    expect(attemptChains).toHaveLength(2);
    for (const chain of attemptChains) {
      expect(chain.calls).toContainEqual({
        method: 'eq',
        args: ['customer_id', CUSTOMER_ID],
      });
      expect(chain.calls).toContainEqual({
        method: 'order',
        args: ['created_at', { ascending: false }],
      });
      expect(chain.calls).toContainEqual({
        method: 'order',
        args: ['id', { ascending: false }],
      });
    }
    expect(attemptChains[0].calls).toContainEqual({ method: 'range', args: [5, 10] });
    expect(attemptChains[1].calls).toContainEqual({ method: 'range', args: [10, 15] });
  });

  // ── MKT-010.1 · Plan de pago en dos partes ────────────────────────────────

  it('two_stage sin reserva: snapshot del intento, vencimientos del viaje y SIN invocar la RPC', async () => {
    givenHistory([
      attemptRow({
        payment_plan: 'two_stage',
        deposit_cents: 1010,
        amount_cents: 1010,
      }),
    ]);
    givenTripContext({
      deposit_deadline: '2099-06-30T00:00:00.000Z',
      balance_deadline: '2099-07-31T00:00:00.000Z',
    });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.plan).toEqual({
      payment_plan: 'two_stage',
      deposit_cents: 1010,
      saldo_cents: 3030,
      total_cents: 4040,
      paid_cents: 0,
      pendiente_cents: 4040,
      deposit_pct: 25,
      balance_pct: 75,
      deposit_deadline: '2099-06-30T00:00:00.000Z',
      balance_deadline: '2099-07-31T00:00:00.000Z',
      deposit_overdue: false,
      balance_overdue: false,
      seats_held: null,
      deposit_verified_at: null,
    });
    // Sin reserva no hay nada verificado que consultar: la RPC jamás se
    // invoca y el estado sigue siendo el de siempre.
    expect(harness.rpcCalls()).toHaveLength(0);
    expect(item.estado).toBe('pendiente_comprobante');
    expect(item.accion).toBe('enviar_comprobante');
    expect(item.pago).toBeNull();
    expect(item.reserva).toBeNull();
  });

  it('two_stage con vencimiento vencido NO cancela: el flag es solo informativo', async () => {
    givenHistory([
      attemptRow({
        payment_plan: 'two_stage',
        deposit_cents: 2020,
        amount_cents: 2020,
      }),
    ]);
    givenTripContext({
      deposit_deadline: PAST,
      balance_deadline: PAST,
    });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.plan.deposit_overdue).toBe(true);
    expect(item.plan.balance_overdue).toBe(true);
    // Nunca auto-cancelación: el estado y la acción no cambian por el
    // retraso; la agencia es quien decide.
    expect(item.estado).toBe('pendiente_comprobante');
    expect(item.accion).toBe('enviar_comprobante');
    expect(item.status).toBe('created');
    expect(item.reserva).toBeNull();
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('two_stage con reserva usa la RPC de progreso y ofrece pagar_saldo', async () => {
    givenHistory([
      attemptRow({
        status: 'verified',
        payment_plan: 'two_stage',
        deposit_cents: 2020,
        amount_cents: 2020,
        proof_count: 1,
        proof_submitted_at: '2026-01-01T10:05:00.000Z',
        verified_at: '2026-01-02T10:00:00.000Z',
        closed_at: '2026-01-02T10:00:00.000Z',
      }),
    ]);
    givenTripContext();
    harness.push('payments', {
      data: [depositVerifyPaymentRow()],
      error: null,
    });
    harness.push('reservations', {
      data: [reservationRow({ payment_status: 'partial' })],
      error: null,
    });
    harness.pushRpc(RPC_PROGRESS, { data: progressPayload(), error: null });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    // La RPC se invoca UNA vez con la reserva derivada en el servidor y
    // el customer de la sesión (nunca ids del cliente).
    expect(harness.rpcCalls()).toHaveLength(1);
    expect(harness.rpcCalls()[0].fn).toBe(RPC_PROGRESS);
    expect(harness.rpcCalls()[0].args).toEqual({
      p_reservation_id: RESERVATION_ID,
      p_customer_id: CUSTOMER_ID,
    });
    // El plan espeja el progreso server-side: nada calculado en el cliente.
    expect(item.plan).toEqual({
      payment_plan: 'two_stage',
      deposit_cents: 2020,
      saldo_cents: 2020,
      total_cents: 4040,
      paid_cents: 2020,
      pendiente_cents: 2020,
      deposit_pct: 50,
      balance_pct: 50,
      deposit_deadline: '2026-12-30T00:00:00.000Z',
      balance_deadline: '2026-12-31T00:00:00.000Z',
      deposit_overdue: false,
      balance_overdue: false,
      seats_held: true,
      deposit_verified_at: '2026-01-02T10:00:00.000Z',
    });
    // La acción principal pasa a ser el saldo; el estado sigue confirmado.
    expect(item.estado).toBe('reserva_confirmada');
    expect(item.accion).toBe('pagar_saldo');
    expect(item.mensaje).toBe(
      'Primer pago aprobado: falta completar el pago restante.',
    );
    expect(item.pago.stage).toBe('deposit');
    expect(item.reserva.payment_status).toBe('partial');
  });

  it('two_stage con saldo en revisión cambia el mensaje, no la acción', async () => {
    givenHistory([
      attemptRow({
        status: 'verified',
        payment_plan: 'two_stage',
        deposit_cents: 2020,
        amount_cents: 2020,
        proof_count: 1,
        verified_at: '2026-01-02T10:00:00.000Z',
        closed_at: '2026-01-02T10:00:00.000Z',
      }),
    ]);
    givenTripContext();
    harness.push('payments', {
      data: [depositVerifyPaymentRow()],
      error: null,
    });
    harness.push('reservations', { data: [reservationRow()], error: null });
    harness.pushRpc(RPC_PROGRESS, {
      data: progressPayload({
        payments: [
          progressPayload().payments[0],
          {
            id: 'pay-balance-1',
            stage: 'balance',
            status: 'pending',
            amount_cents: 2020,
            currency: 'COP',
            external_reference: '00987654321',
            bank_origin: 'Banco de Venezuela',
            payment_datetime: '2026-01-05T09:00:00.000Z',
            submitted_at: '2026-01-05T09:30:00.000Z',
            verified_at: null,
            rejection_reason: null,
          },
        ],
      }),
      error: null,
    });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.accion).toBe('pagar_saldo');
    expect(item.mensaje).toBe(
      'Primer pago aprobado: tu comprobante del pago restante está en revisión.',
    );
    expect(item.plan.pendiente_cents).toBe(2020);
  });

  it('two_stage con el saldo ya cubierto recupera ver_reserva y el mensaje de pago completo', async () => {
    givenHistory([
      attemptRow({
        status: 'verified',
        payment_plan: 'two_stage',
        deposit_cents: 2020,
        amount_cents: 2020,
        proof_count: 1,
        verified_at: '2026-01-02T10:00:00.000Z',
        closed_at: '2026-01-02T10:00:00.000Z',
      }),
    ]);
    givenTripContext();
    harness.push('payments', {
      data: [depositVerifyPaymentRow()],
      error: null,
    });
    harness.push('reservations', {
      data: [reservationRow({ payment_status: 'fully_paid' })],
      error: null,
    });
    harness.pushRpc(RPC_PROGRESS, {
      data: progressPayload({
        payment_status: 'paid',
        paid_cents: 4040,
        balance_cents: 0,
        balance_pct: 0,
        balance_overdue: false,
        payments: [
          progressPayload().payments[0],
          {
            id: 'pay-balance-1',
            stage: 'balance',
            status: 'verified',
            amount_cents: 2020,
            currency: 'COP',
            external_reference: '00987654321',
            bank_origin: 'Banco de Venezuela',
            payment_datetime: '2026-01-05T09:00:00.000Z',
            submitted_at: '2026-01-05T09:30:00.000Z',
            verified_at: '2026-01-06T10:00:00.000Z',
            rejection_reason: null,
          },
        ],
      }),
      error: null,
    });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.plan.pendiente_cents).toBe(0);
    expect(item.plan.paid_cents).toBe(4040);
    expect(item.accion).toBe('ver_reserva');
    expect(item.mensaje).toBe(
      'Reserva confirmada: tu pago está completo en su totalidad.',
    );
    expect(item.estado).toBe('reserva_confirmada');
  });

  it('un fallo de la RPC de progreso responde 500 sin montos a medias', async () => {
    givenHistory([
      attemptRow({
        status: 'verified',
        payment_plan: 'two_stage',
        deposit_cents: 2020,
        amount_cents: 2020,
        proof_count: 1,
        verified_at: '2026-01-02T10:00:00.000Z',
        closed_at: '2026-01-02T10:00:00.000Z',
      }),
    ]);
    givenTripContext();
    harness.push('payments', {
      data: [depositVerifyPaymentRow()],
      error: null,
    });
    harness.push('reservations', { data: [reservationRow()], error: null });
    harness.pushRpc(RPC_PROGRESS, {
      data: null,
      error: { message: 'ERR_PAYMENT_NOT_OWNER: not yours' },
    });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(500);
    expect(body.error.code).toBe('CHECKOUT_ERROR');
    expect(body.error.message).not.toContain('ERR_');
    expect(body.error.message).not.toContain('not yours');
    // Nunca se devuelve un item con plan a medias.
    expect(body.items).toBeUndefined();
  });

  it('el plan único legado jamás invoca la RPC de progreso', async () => {
    givenHistory([
      attemptRow({
        status: 'verified',
        proof_count: 1,
        verified_at: '2026-01-02T10:00:00.000Z',
        closed_at: '2026-01-02T10:00:00.000Z',
      }),
    ]);
    givenTripContext();
    harness.push('payments', { data: [paymentRow()], error: null });
    harness.push('reservations', { data: [reservationRow()], error: null });

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const item = body.items[0];
    expect(harness.rpcCalls()).toHaveLength(0);
    expect(item.plan).toEqual({
      payment_plan: 'single',
      deposit_cents: null,
      saldo_cents: null,
      total_cents: 4040,
      paid_cents: 4040,
      pendiente_cents: 0,
      deposit_pct: null,
      balance_pct: null,
      deposit_deadline: null,
      balance_deadline: null,
      deposit_overdue: false,
      balance_overdue: false,
      seats_held: true,
      deposit_verified_at: null,
    });
    expect(item.accion).toBe('ver_reserva');
    expect(item.pago.stage).toBe('full');
  });

  it('pago.stage expone la columna etapa y una forma desconocida cae a full', async () => {
    givenHistory([attemptRow({ status: 'pending_review', proof_count: 1 })]);
    harness.push('payments', {
      data: [paymentRow({ status: 'verified', stage: 'deposit' })],
      error: null,
    });

    const deposit = await requestJson(port, HISTORY_URL);
    expect(deposit.body.items[0].pago.stage).toBe('deposit');

    givenHistory([attemptRow({ status: 'pending_review', proof_count: 1 })]);
    harness.push('payments', {
      data: [paymentRow({ status: 'verified', stage: 'valor_desconocido' })],
      error: null,
    });

    const unknown = await requestJson(port, HISTORY_URL);
    expect(unknown.body.items[0].pago.stage).toBe('full');
    // Sin reserva no se invoca la RPC en ninguno de los dos casos.
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  // ── Seguridad ──────────────────────────────────────────────────────────────

  it('filtra la lista por el customer_id de la sesión y nunca expone ids ajenos', async () => {
    givenHistory([attemptRow()]);
    givenTripContext();

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const attemptChain = harness
      .chains()
      .find((chain) => chain.table === 'checkout_attempts');
    expect(attemptChain?.calls).toContainEqual({
      method: 'eq',
      args: ['customer_id', CUSTOMER_ID],
    });
    expect(JSON.stringify(body)).not.toContain(OTHER_CUSTOMER_ID);
  });

  it('expone nombre y documento del propio cliente, nunca proof_path, history, idempotency_key ni teléfono', async () => {
    givenHistory([
      attemptRow({
        proof_path: 'SENTINEL_PROOF_PATH',
        passenger_data: [
          {
            seat_id: SEAT_A1,
            first_name: 'Ana',
            last_name: 'Pérez',
            document: '12345678',
            phone: 'SENTINEL_PHONE',
          },
        ],
        history: [{ kind: 'submission', idempotency_key: 'SENTINEL_HISTORY' }],
        idempotency_key: 'SENTINEL_IDEMPOTENCY',
        customer_id: OTHER_CUSTOMER_ID,
      }),
    ]);
    givenTripContext();

    const { status, body } = await requestJson(port, HISTORY_URL);

    expect(status).toBe(200);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('SENTINEL_PROOF_PATH');
    expect(raw).not.toContain('SENTINEL_HISTORY');
    expect(raw).not.toContain('SENTINEL_IDEMPOTENCY');
    expect(raw).not.toContain('SENTINEL_PHONE');
    expect(raw).not.toContain('proof_path');
    expect(raw).not.toContain('idempotency_key');
    // El detalle de pasajeros es nombre + documento + asiento, campo a campo.
    expect(body.items[0].pasajeros.detalle).toEqual([
      { asiento: 'A1', nombre: 'Ana Pérez', documento: '12345678' },
    ]);
    expect(body.items[0].pasajeros.detalle[0]).not.toHaveProperty('phone');
  });

  it('traduce un error de base de datos al envelope estándar sin filtrar internals', async () => {
    harness.push('checkout_attempts', {
      data: null,
      error: { message: 'pg: relation "secret_table" does not exist' },
    });

    const { status, body } = await requestJson(port, HISTORY_URL);
    expect(status).toBe(500);
    expect(body.error.code).toBe('CHECKOUT_ERROR');
    expect(body.error.message).not.toContain('secret_table');
    expect(body.error.message).not.toContain('pg:');
  });
});
