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
    reset() {
      state.chains = [];
      state.queues = {};
      state.defaults = {};
    },
    setUser(handler: (token: string) => Promise<any>) {
      state.getUser = handler;
    },
    chains: () => state.chains,
    from: (table: string) => buildChain(table),
    rpc: () => {
      throw new Error('rpc no debe invocarse en el boleto');
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
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const ROUTE_ID = '551559e6-ea35-4453-aae1-5ed0844289b4';
const AGENCY_ID = '5bf0be5d-c03a-431f-97d5-e2a065e25752';
const SEAT_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SEAT_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const ATTEMPT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const PAYMENT_ID = 'pppppppp-pppp-4ppp-8ppp-ppppppppppp1';
const RESERVATION_ID = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrr1';
const OTHER_ATTEMPT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
const FUTURE = '2099-01-01T00:00:00.000Z';

const QR_CODE = 'NT-MARACAIBO-ABCDEF0123456789ABCDEF0123456789';
const TICKET_CODE = 'ABCDEF01';

/** Cadena feliz completa: intento verificado → pago → reserva. El contexto
 *  (agencies/trips/routes/seats) se sirve por DEFAULT en beforeEach porque
 *  el servicio consulta esas tablas en paralelo (pop independiente). */
function givenEligibleTicket() {
  harness.push('checkout_attempts', { data: verifiedAttemptRow(), error: null });
  harness.push('payments', { data: verifiedPaymentRow(), error: null });
  harness.push('reservations', { data: approvedReservationRow(), error: null });
}

const TICKET_URL = `/api/public/checkout/attempts/${ATTEMPT_ID}/ticket`;

/** Intento verificado: la única condición que puede llevar a boleto. */
function verifiedAttemptRow(overrides: Record<string, any> = {}) {
  return {
    id: ATTEMPT_ID,
    customer_id: CUSTOMER_ID,
    status: 'verified',
    agency_id: AGENCY_ID,
    trip_id: TRIP_ID,
    seat_ids: [SEAT_A1, SEAT_A2],
    passenger_data: [
      { seat_id: SEAT_A1, first_name: 'Ana', last_name: 'Pérez' },
      { seat_id: SEAT_A2, first_name: 'Luis', last_name: 'Gómez' },
    ],
    amount_cents: 4040,
    ...overrides,
  };
}

function verifiedPaymentRow(overrides: Record<string, any> = {}) {
  return {
    id: PAYMENT_ID,
    reservation_id: RESERVATION_ID,
    idempotency_key: `mkt007:${ATTEMPT_ID}:verify`,
    status: 'verified',
    amount_cents: 4040,
    currency: 'COP',
    verified_at: '2026-01-02T10:00:00.000Z',
    ...overrides,
  };
}

/** Reserva nacida en verify_checkout_attempt (087): reserved + fully_paid. */
function approvedReservationRow(overrides: Record<string, any> = {}) {
  return {
    id: RESERVATION_ID,
    status: 'reserved',
    payment_status: 'fully_paid',
    ticket_code: TICKET_CODE,
    qr_code: QR_CODE,
    created_at: '2026-01-02T10:00:00.000Z',
    trip_id: TRIP_ID,
    ...overrides,
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

async function requestJson(port: number, path: string, init: { token?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (init.token !== null) {
    headers.Authorization = `Bearer ${init.token ?? 'token'}`;
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** El rol debe ir por DEFAULT: auth.consume users vía then (maybeSingle). */
function givenUserRole(role: string, agencyId: string | null = null) {
  harness.setDefault('users', {
    data: { id: CUSTOMER_ID, role, agency_id: agencyId },
    error: null,
  });
}

describe('GET /api/public/checkout/attempts/:attemptId/ticket — boleto QR (RT-03)', () => {
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
    harness.setDefault('users', { data: { id: CUSTOMER_ID, role: 'customer', agency_id: null }, error: null });
    harness.setDefault('checkout_attempts', { data: null, error: null });
    harness.setDefault('payments', { data: null, error: null });
    harness.setDefault('reservations', { data: null, error: null });
    // El contexto (agencies/trips/routes/seats) se consulta en PARALELO con
    // pop independiente, así que se sirve por DEFAULT y no por cola.
    // getCheckoutTicket consulta agencies/trips/routes con .maybeSingle()
    // (objeto), y seats con .in() (array): los defaults imitan esa forma.
    harness.setDefault('agencies', {
      data: { id: AGENCY_ID, name: 'Rutas del Sol' },
      error: null,
    });
    harness.setDefault('trips', {
      data: { id: TRIP_ID, route_id: ROUTE_ID, departure_time: '2026-12-01T08:00:00.000Z' },
      error: null,
    });
    harness.setDefault('routes', {
      data: { id: ROUTE_ID, origin: 'Caracas', destination: 'Maracaibo' },
      error: null,
    });
    harness.setDefault('seats', {
      data: [
        { id: SEAT_A1, seat_code: 'A1' },
        { id: SEAT_A2, seat_code: 'A2' },
      ],
      error: null,
    });
  });

  // ── Autenticación y rol ────────────────────────────────────────────────────

  it('responde 401 sin encabezado Authorization', async () => {
    const { status, body } = await requestJson(port, TICKET_URL, { token: null });
    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('responde 401 con token inválido', async () => {
    harness.setUser(() => Promise.resolve({ data: { user: null }, error: { message: 'bad token' } }));
    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('responde 403 a una cuenta de agencia', async () => {
    // auth exige agency_id para role 'agency' (aislamiento multi-tenant).
    givenUserRole('agency', AGENCY_ID);
    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(403);
    expect(body.error.code).toBe('CUSTOMER_REQUIRED');
  });

  it('responde 403 a una cuenta superadmin', async () => {
    givenUserRole('superadmin');
    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(403);
    expect(body.error.code).toBe('CUSTOMER_REQUIRED');
  });

  // ── Cadena feliz ──────────────────────────────────────────────────────────

  it('devuelve el boleto exacto de Tour cuando la compra está totalmente aprobada', async () => {
    givenEligibleTicket();

    const { status, body } = await requestJson(port, TICKET_URL);

    expect(status).toBe(200);
    expect(body.attempt_id).toBe(ATTEMPT_ID);
    expect(body.estado).toBe('reserva_confirmada');
    // Reutiliza EXACTAMENTE el qr_code y ticket_code generados por Tour (087).
    expect(body.qr_code).toBe(QR_CODE);
    expect(body.ticket_code).toBe(TICKET_CODE);
    expect(body.reservation_id).toBe(RESERVATION_ID);
    expect(body.agency).toEqual({ id: AGENCY_ID, name: 'Rutas del Sol' });
    expect(body.trip).toEqual({
      origin: 'Caracas',
      destination: 'Maracaibo',
      departure_time: '2026-12-01T08:00:00.000Z',
    });
    expect(body.seats).toEqual(['A1', 'A2']);
    // Un SOLO QR por reserva (modelo de Tour); los pasajeros se listan aparte.
    expect(body.passengers).toHaveLength(2);
    expect(body.passengers).toContainEqual({ asiento: 'A1', nombre: 'Ana Pérez' });
    expect(body.passengers).toContainEqual({ asiento: 'A2', nombre: 'Luis Gómez' });
  });

  it('filtra el intento por el customer_id de la sesión (nunca acepta ids del cliente)', async () => {
    givenEligibleTicket();

    await requestJson(port, TICKET_URL);

    const attemptChain = harness.chains().find((c) => c.table === 'checkout_attempts');
    expect(attemptChain?.calls).toContainEqual({ method: 'eq', args: ['id', ATTEMPT_ID] });
    expect(attemptChain?.calls).toContainEqual({ method: 'eq', args: ['customer_id', CUSTOMER_ID] });
  });

  // ── 404 uniforme: no hay enumeración ──────────────────────────────────────

  it('devuelve 404 uniforme cuando el intento no existe', async () => {
    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(404);
    expect(body.error.code).toBe('TICKET_NOT_FOUND');
    expect(body.error.message).toBe('Boleto no disponible para esta compra');
  });

  it('devuelve el MISMO 404 cuando el intento pertenece a otro cliente', async () => {
    // El intento existe pero es de otro cliente: el filtro de dueño lo filtra.
    harness.push('checkout_attempts', { data: null, error: null });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(404);
    expect(body.error.code).toBe('TICKET_NOT_FOUND');
  });

  it('devuelve 404 para un intento pendiente de revisión', async () => {
    harness.push('checkout_attempts', {
      data: verifiedAttemptRow({ status: 'pending_review' }),
      error: null,
    });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(404);
    expect(body.error.code).toBe('TICKET_NOT_FOUND');
  });

  it('devuelve 404 para un intento rechazado', async () => {
    harness.push('checkout_attempts', {
      data: verifiedAttemptRow({ status: 'rejected' }),
      error: null,
    });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(404);
    expect(body.error.code).toBe('TICKET_NOT_FOUND');
  });

  it('devuelve 404 para un intento expirado', async () => {
    harness.push('checkout_attempts', {
      data: verifiedAttemptRow({ status: 'expired' }),
      error: null,
    });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(404);
    expect(body.error.code).toBe('TICKET_NOT_FOUND');
  });

  // ── verified sin reserva / pagos inválidos ────────────────────────────────

  it('devuelve 404 cuando el intento está verified sin reserva de verificación vinculada', async () => {
    harness.push('checkout_attempts', { data: verifiedAttemptRow(), error: null });
    // No hay fila de pago con la idempotency_key de verify.
    harness.push('payments', { data: null, error: null });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(404);
    expect(body.error.code).toBe('TICKET_NOT_FOUND');
  });

  it('devuelve 404 cuando el pago existe pero no está verified', async () => {
    harness.push('checkout_attempts', { data: verifiedAttemptRow(), error: null });
    harness.push('payments', { data: verifiedPaymentRow({ status: 'pending' }), error: null });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(404);
    expect(body.error.code).toBe('TICKET_NOT_FOUND');
  });

  it('devuelve 404 cuando la reserva no tiene los códigos de boleto', async () => {
    harness.push('checkout_attempts', { data: verifiedAttemptRow(), error: null });
    harness.push('payments', { data: verifiedPaymentRow(), error: null });
    harness.push('reservations', {
      data: approvedReservationRow({ qr_code: null, ticket_code: null }),
      error: null,
    });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(404);
    expect(body.error.code).toBe('TICKET_NOT_FOUND');
  });

  // ── reserved ≠ confirmed: no se equiparan ─────────────────────────────────

  it('devuelve 404 si la reserva está confirmed (flujo Tour) y no reserved', async () => {
    harness.push('checkout_attempts', { data: verifiedAttemptRow(), error: null });
    harness.push('payments', { data: verifiedPaymentRow(), error: null });
    harness.push('reservations', { data: approvedReservationRow({ status: 'confirmed' }), error: null });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(404);
    expect(body.error.code).toBe('TICKET_NOT_FOUND');
  });

  it('devuelve 404 si el payment_status no es fully_paid', async () => {
    harness.push('checkout_attempts', { data: verifiedAttemptRow(), error: null });
    harness.push('payments', { data: verifiedPaymentRow(), error: null });
    harness.push('reservations', { data: approvedReservationRow({ payment_status: 'partial' }), error: null });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(404);
    expect(body.error.code).toBe('TICKET_NOT_FOUND');
  });

  // ── Sin datos sensibles ni internals ──────────────────────────────────────

  it('no expone teléfono, documento, proof_path ni idempotency_key', async () => {
    harness.push('checkout_attempts', {
      data: verifiedAttemptRow({
        passenger_data: [
          { seat_id: SEAT_A1, first_name: 'Ana', last_name: 'Pérez', phone: '04241112233', document: '99887766' },
        ],
        proof_path: 'SENTINEL_PROOF',
        idempotency_key: 'SENTINEL_IDEMP',
      }),
      error: null,
    });
    harness.push('payments', { data: verifiedPaymentRow({ idempotency_key: 'SENTINEL_PAY_IDEMP' }), error: null });
    harness.push('reservations', { data: approvedReservationRow(), error: null });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(200);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('04241112233');
    expect(raw).not.toContain('99887766');
    expect(raw).not.toContain('SENTINEL_PROOF');
    expect(raw).not.toContain('SENTINEL_IDEMP');
    expect(raw).not.toContain('SENTINEL_PAY_IDEMP');
    expect(raw).not.toContain('proof_path');
    expect(raw).not.toContain('idempotency_key');
    // El DTO del pasajero solo expone asiento + nombre.
    expect(Object.keys(body.passengers[0]).sort()).toEqual(['asiento', 'nombre']);
  });

  // ── Errores de base de datos ──────────────────────────────────────────────

  it('traduce un error de base de datos al envelope estándar sin filtrar internals', async () => {
    harness.push('checkout_attempts', { data: null, error: { message: 'pg: relation "secret" does not exist' } });

    const { status, body } = await requestJson(port, TICKET_URL);
    expect(status).toBe(500);
    expect(body.error.code).toBe('CHECKOUT_ERROR');
    expect(body.error.message).not.toContain('secret');
    expect(body.error.message).not.toContain('pg:');
  });

  it('rechaza un attemptId que no es UUID con VALIDATION_ERROR', async () => {
    const { status, body } = await requestJson(
      port,
      `/api/public/checkout/attempts/no-es-uuid/ticket`,
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
