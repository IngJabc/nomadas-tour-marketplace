import { createHash } from 'node:crypto';
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
  } = {
    queues: {},
    defaults: {},
    chains: [],
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
    reset() {
      state.chains = [];
      state.queues = {};
      state.defaults = {};
    },
    chains: () => state.chains,
    from: (table: string) => buildChain(table),
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: null }, error: { message: 'anonymous' } }),
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
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const OTHER_TRIP_ID = '551559e6-ea35-4453-aae1-5ed0844289b3';
const SEAT_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SEAT_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const SEAT_A3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

type ChainCalls = Array<{ method: string; args: any[] }>;

function guestCookieName(tripId: string): string {
  return `mkt_guest_lock_${tripId.toLowerCase()}`;
}

function seatRow(overrides: Record<string, any> = {}) {
  return {
    id: SEAT_A1,
    trip_id: TRIP_ID,
    seat_code: 'A1',
    status: 'available',
    locked_by: null,
    guest_session_id: null,
    lock_expires_at: null,
    ...overrides,
  };
}

function guestSession(overrides: Record<string, any> = {}) {
  return {
    id: SESSION_ID,
    trip_id: TRIP_ID,
    customer_id: null,
    status: 'active',
    expires_at: new Date(Date.now() + 900_000).toISOString(),
    ...overrides,
  };
}

function getSetCookies(res: Response): string[] {
  const headers = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

function cookieValue(cookies: string[], name: string): string | null {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  if (!cookie) return null;
  const pair = cookie.split(';', 1)[0] ?? '';
  return decodeURIComponent(pair.slice(name.length + 1));
}

function cookieHeader(tripId: string, token: string): Record<string, string> {
  return { Cookie: `${guestCookieName(tripId)}=${encodeURIComponent(token)}` };
}

function guestSessionInserts() {
  return harness
    .chains()
    .filter((chain) => chain.table === 'guest_sessions')
    .filter((chain) =>
      chain.calls.some((call) => call.method === 'insert'),
    );
}

async function startServer(): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function postGuest(
  port: number,
  path: string,
  body: unknown,
  cookies: Record<string, string> = {},
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookies },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
    cookies: getSetCookies(res),
  };
}

async function getGuest(
  port: number,
  path: string,
  cookies: Record<string, string> = {},
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: cookies });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
    cookies: getSetCookies(res),
  };
}

describe('POST /api/public/seats/lock-guest', () => {
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
  });

  it('crea una sesion guest, emite una cookie segura y bloquea sin autenticacion', async () => {
    const session = guestSession();
    harness.push('guest_sessions', { data: session, error: null });
    harness.push('trips', {
      data: { id: TRIP_ID, status: 'active', capacity: 31 },
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('seats', { data: [seatRow()], error: null });
    harness.push('seats', { data: [{ id: SEAT_A1 }], error: null });
    harness.push('guest_sessions', { data: session, error: null });

    const startedAt = Date.now();
    const { status, body, cookies } = await postGuest(
      port,
      '/api/public/seats/lock-guest',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1], ttl_seconds: 30 },
    );

    expect(status).toBe(200);
    expect(body.locked).toBe(true);
    expect(body.ttl_seconds).toBe(900);
    expect(body.seats).toHaveLength(1);
    expect(body.seats[0]).toMatchObject({
      id: SEAT_A1,
      seat_code: 'A1',
      status: 'locked',
      locked_by: null,
      guest_session_id: SESSION_ID,
    });
    expect(body.guest_session).toMatchObject({
      trip_id: TRIP_ID,
      status: 'active',
    });

    const token = cookieValue(cookies, guestCookieName(TRIP_ID));
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    const tokenHash = createHash('sha256').update(token!, 'utf8').digest('hex');
    const cookie = cookies.find((value) =>
      value.startsWith(`${guestCookieName(TRIP_ID)}=`),
    )!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/public/seats');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    expect(JSON.stringify(body)).not.toContain(token!);
    expect(JSON.stringify(body)).not.toContain(tokenHash);

    const insert = guestSessionInserts()[0];
    expect(insert).toBeDefined();
    const payload = insert.calls.find((call) => call.method === 'insert')!.args[0];
    expect(payload.trip_id).toBe(TRIP_ID);
    expect(payload.status).toBe('active');
    expect(payload.token_hash).toBe(tokenHash);
    expect(payload).not.toHaveProperty('token');
    expect(JSON.stringify(harness.chains())).not.toContain(token!);

    const acquire = harness
      .chains()
      .filter((chain) => chain.table === 'seats')
      .find((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && call.args[0]?.status === 'locked',
        ),
      )!;
    const acquirePayload = acquire.calls.find((call) => call.method === 'update')!.args[0];
    expect(acquirePayload).toMatchObject({
      status: 'locked',
      locked_by: null,
      guest_session_id: SESSION_ID,
    });

    const drift = new Date(body.lock_expires_at).getTime() - startedAt;
    expect(drift).toBeGreaterThanOrEqual(900_000 - 5_000);
    expect(drift).toBeLessThanOrEqual(900_000 + 5_000);
  });

  it('bloquea varios seats en una operacion atomica', async () => {
    const session = guestSession();
    harness.push('guest_sessions', { data: session, error: null });
    harness.push('trips', {
      data: { id: TRIP_ID, status: 'active', capacity: 31 },
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('seats', {
      data: [seatRow(), seatRow({ id: SEAT_A2, seat_code: 'A2' })],
      error: null,
    });
    harness.push('seats', { data: [{ id: SEAT_A1 }, { id: SEAT_A2 }], error: null });
    harness.push('guest_sessions', { data: session, error: null });

    const { status, body } = await postGuest(port, '/api/public/seats/lock-guest', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1, SEAT_A2],
    });

    expect(status).toBe(200);
    expect(body.seats.map((seat: any) => seat.seat_code)).toEqual(['A1', 'A2']);
    expect(body.seats.every((seat: any) => seat.guest_session_id === SESSION_ID)).toBe(true);
  });

  it('rechaza un seat que pertenece a otro viaje y libera la sesion recien creada', async () => {
    const session = guestSession({ trip_id: OTHER_TRIP_ID });
    harness.push('guest_sessions', { data: session, error: null });
    harness.push('trips', {
      data: { id: OTHER_TRIP_ID, status: 'active', capacity: 31 },
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('seats', { data: [seatRow()], error: null });
    harness.push('seats', { data: [], error: null });
    harness.push('guest_sessions', { data: { ...session, status: 'released' }, error: null });

    const { status, body } = await postGuest(port, '/api/public/seats/lock-guest', {
      trip_id: OTHER_TRIP_ID,
      seat_ids: [SEAT_A1],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(
      harness.chains().some((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && call.args[0]?.status === 'locked',
        ),
      ),
    ).toBe(false);
    const released = harness
      .chains()
      .filter((chain) => chain.table === 'guest_sessions')
      .find((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && call.args[0]?.status === 'released',
        ),
      );
    expect(released).toBeDefined();
  });

  it('produce un unico ganador cuando dos guests compiten por el mismo seat', async () => {
    const sessionA = guestSession();
    const sessionB = guestSession({ id: OTHER_SESSION_ID });
    harness.push('guest_sessions', { data: sessionA, error: null });
    harness.push('trips', {
      data: { id: TRIP_ID, status: 'active', capacity: 31 },
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('seats', { data: [seatRow()], error: null });
    harness.push('seats', { data: [{ id: SEAT_A1 }], error: null });
    harness.push('guest_sessions', { data: sessionA, error: null });
    harness.push('guest_sessions', { data: sessionB, error: null });
    harness.push('trips', {
      data: { id: TRIP_ID, status: 'active', capacity: 31 },
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('seats', {
      data: [seatRow({ id: SEAT_A2, seat_code: 'A2' })],
      error: null,
    });
    harness.push('seats', { data: [{ id: SEAT_A2 }], error: null });
    harness.push('guest_sessions', { data: sessionB, error: null });
    harness.push('guest_sessions', { data: sessionB, error: null });
    harness.push('trips', {
      data: { id: TRIP_ID, status: 'active', capacity: 31 },
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('seats', {
      data: [
        seatRow({
          status: 'locked',
          guest_session_id: SESSION_ID,
          lock_expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      ],
      error: null,
    });

    const first = await postGuest(port, '/api/public/seats/lock-guest', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A1],
    });
    expect(first.status).toBe(200);

    const otherSeat = await postGuest(port, '/api/public/seats/lock-guest', {
      trip_id: TRIP_ID,
      seat_ids: [SEAT_A2],
    });
    expect(otherSeat.status).toBe(200);
    const tokenB = cookieValue(otherSeat.cookies, guestCookieName(TRIP_ID));
    expect(tokenB).toBeTruthy();

    const second = await postGuest(
      port,
      '/api/public/seats/lock-guest',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1] },
      cookieHeader(TRIP_ID, tokenB!),
    );

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SEAT_LOCKED');
  });

  it('no deja locks parciales cuando un seat pertenece a otra sesion', async () => {
    const session = guestSession();
    harness.push('guest_sessions', { data: session, error: null });
    harness.push('trips', {
      data: { id: TRIP_ID, status: 'active', capacity: 31 },
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('seats', {
      data: [
        seatRow(),
        seatRow({
          id: SEAT_A2,
          seat_code: 'A2',
          status: 'locked',
          guest_session_id: OTHER_SESSION_ID,
          lock_expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      ],
      error: null,
    });

    const { status, body } = await postGuest(
      port,
      '/api/public/seats/lock-guest',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1, SEAT_A2] },
      cookieHeader(TRIP_ID, 'a'.repeat(43)),
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('SEAT_LOCKED');
    expect(
      harness.chains().some((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && call.args[0]?.status === 'locked',
        ),
      ),
    ).toBe(false);
  });

  it('rechaza seats bloqueados por un customer autenticado', async () => {
    const session = guestSession();
    harness.push('guest_sessions', { data: session, error: null });
    harness.push('trips', {
      data: { id: TRIP_ID, status: 'active', capacity: 31 },
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('seats', {
      data: [
        seatRow({
          status: 'locked',
          locked_by: CUSTOMER_ID,
          lock_expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      ],
      error: null,
    });

    const { status, body } = await postGuest(
      port,
      '/api/public/seats/lock-guest',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1] },
      cookieHeader(TRIP_ID, 'b'.repeat(43)),
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('SEAT_LOCKED');
  });

  it('rechaza una sesion expirada y limpia la cookie', async () => {
    const expired = guestSession({
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    harness.push('guest_sessions', { data: expired, error: null });
    harness.push('guest_sessions', { data: expired, error: null });

    const { status, body, cookies } = await postGuest(
      port,
      '/api/public/seats/lock-guest',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1] },
      cookieHeader(TRIP_ID, 'c'.repeat(43)),
    );

    expect(status).toBe(401);
    expect(body.error.code).toBe('GUEST_SESSION_EXPIRED');
    expect(
      harness.chains().filter((chain) => chain.table === 'seats'),
    ).toHaveLength(0);
    expect(
      cookies.some((cookie) => cookie.includes('1970') || cookie.includes('Max-Age=1')),
    ).toBe(true);
  });

  it('rechaza una sesion expirada al intentar desbloquear', async () => {
    const expired = guestSession({
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    harness.push('guest_sessions', { data: expired, error: null });
    harness.push('guest_sessions', { data: expired, error: null });

    const { status, body } = await postGuest(
      port,
      '/api/public/seats/unlock-guest',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1] },
      cookieHeader(TRIP_ID, 'j'.repeat(43)),
    );

    expect(status).toBe(401);
    expect(body.error.code).toBe('GUEST_SESSION_EXPIRED');
  });

  it('reutiliza la sesion existente y conserva la expiracion mas proxima', async () => {
    const earliest = new Date(Date.now() + 600_000).toISOString();
    const session = guestSession({ expires_at: earliest });
    harness.push('guest_sessions', { data: session, error: null });
    harness.push('trips', {
      data: { id: TRIP_ID, status: 'active', capacity: 31 },
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('seats', {
      data: [seatRow({ id: SEAT_A2, seat_code: 'A2' })],
      error: null,
    });
    harness.push('seats', { data: [{ id: SEAT_A2 }], error: null });
    harness.push('guest_sessions', { data: session, error: null });

    const { status, body, cookies } = await postGuest(
      port,
      '/api/public/seats/lock-guest',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A2] },
      cookieHeader(TRIP_ID, 'k'.repeat(43)),
    );

    expect(status).toBe(200);
    expect(body.guest_session.expires_at).toBe(earliest);
    expect(guestSessionInserts()).toHaveLength(0);
    const refreshed = cookieValue(cookies, guestCookieName(TRIP_ID));
    expect(refreshed).toBe('k'.repeat(43));
  });

  it('rechaza un origen no permitido antes de tocar la base de datos', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/public/seats/lock-guest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ trip_id: TRIP_ID, seat_ids: [SEAT_A1] }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(harness.chains()).toHaveLength(0);
  });

  it('valida el input con el envelope de error estandar', async () => {
    const { status, body } = await postGuest(port, '/api/public/seats/lock-guest', {
      trip_id: 'not-a-uuid',
      seat_ids: [],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(typeof body.error.message).toBe('string');
  });
});

describe('GET /api/public/seats/guest-locks', () => {
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
  });

  it('devuelve unicamente los locks vigentes de la sesion', async () => {
    const soonest = new Date(Date.now() + 600_000).toISOString();
    const later = new Date(Date.now() + 840_000).toISOString();
    harness.push('guest_sessions', { data: guestSession(), error: null });
    harness.push('seats', {
      data: [
        { id: SEAT_A2, seat_code: 'A2', lock_expires_at: later },
        { id: SEAT_A1, seat_code: 'A1', lock_expires_at: soonest },
      ],
      error: null,
    });

    const { status, body } = await getGuest(
      port,
      `/api/public/seats/guest-locks?trip_id=${TRIP_ID}`,
      cookieHeader(TRIP_ID, 'd'.repeat(43)),
    );

    expect(status).toBe(200);
    expect(body.lock_expires_at).toBe(soonest);
    expect(body.seats.map((seat: any) => seat.seat_code)).toEqual(['A1', 'A2']);
    expect(body.guest_session.trip_id).toBe(TRIP_ID);
    expect(body).not.toHaveProperty('token_hash');

    const read = harness.chains().find((chain) => chain.table === 'seats')!;
    const calls: ChainCalls = read.calls;
    expect(
      calls.some(
        (call) =>
          call.method === 'eq' &&
          call.args[0] === 'guest_session_id' &&
          call.args[1] === SESSION_ID,
      ),
    ).toBe(true);
    expect(
      calls.some((call) => call.method === 'gt' && call.args[0] === 'lock_expires_at'),
    ).toBe(true);
  });

  it('ignora un lock expirado aunque la sesion siga activa', async () => {
    harness.push('guest_sessions', { data: guestSession(), error: null });
    harness.push('seats', {
      data: [
        {
          id: SEAT_A1,
          seat_code: 'A1',
          lock_expires_at: new Date(Date.now() - 1_000).toISOString(),
        },
      ],
      error: null,
    });

    const { status, body } = await getGuest(
      port,
      `/api/public/seats/guest-locks?trip_id=${TRIP_ID}`,
      cookieHeader(TRIP_ID, 'l'.repeat(43)),
    );

    expect(status).toBe(200);
    expect(body.seats).toEqual([]);
    expect(body.lock_expires_at).toBeNull();
  });

  it('rechaza cookies invalidas y una sesion de otro viaje', async () => {
    const invalid = await getGuest(
      port,
      `/api/public/seats/guest-locks?trip_id=${TRIP_ID}`,
      cookieHeader(TRIP_ID, 'invalid cookie!!'),
    );
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe('UNAUTHORIZED');

    harness.push('guest_sessions', {
      data: guestSession({ id: OTHER_SESSION_ID, trip_id: OTHER_TRIP_ID }),
      error: null,
    });
    const crossTrip = await getGuest(
      port,
      `/api/public/seats/guest-locks?trip_id=${TRIP_ID}`,
      cookieHeader(TRIP_ID, 'e'.repeat(43)),
    );
    expect(crossTrip.status).toBe(401);
    expect(crossTrip.body.error.code).toBe('UNAUTHORIZED');
    expect(
      harness.chains().filter((chain) => chain.table === 'seats'),
    ).toHaveLength(0);
  });
});

describe('POST /api/public/seats/unlock-guest', () => {
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
  });

  it('libera un seat propio y conserva los demas locks', async () => {
    const remainingExpiry = new Date(Date.now() + 800_000).toISOString();
    harness.push('guest_sessions', { data: guestSession(), error: null });
    harness.push('seats', {
      data: [
        seatRow({
          status: 'locked',
          guest_session_id: SESSION_ID,
          lock_expires_at: new Date(Date.now() + 700_000).toISOString(),
        }),
      ],
      error: null,
    });
    harness.push('seats', { data: [{ id: SEAT_A1 }], error: null });
    harness.push('seats', {
      data: [
        {
          id: SEAT_A3,
          seat_code: 'A3',
          lock_expires_at: remainingExpiry,
        },
      ],
      error: null,
    });
    harness.push('guest_sessions', {
      data: guestSession({ expires_at: remainingExpiry }),
      error: null,
    });

    const { status, body, cookies } = await postGuest(
      port,
      '/api/public/seats/unlock-guest',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1] },
      cookieHeader(TRIP_ID, 'f'.repeat(43)),
    );

    expect(status).toBe(200);
    expect(body.unlocked).toBe(1);
    expect(body.guest_session.expires_at).toBe(remainingExpiry);
    expect(
      cookies.some((cookie) => cookie.includes('1970') || cookie.includes('Max-Age=1')),
    ).toBe(false);

    const unlock = harness
      .chains()
      .filter((chain) => chain.table === 'seats')
      .find((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && call.args[0]?.status === 'available',
        ),
      )!;
    expect(
      unlock.calls.some(
        (call) =>
          call.method === 'eq' &&
          call.args[0] === 'guest_session_id' &&
          call.args[1] === SESSION_ID,
      ),
    ).toBe(true);
    expect(unlock.calls.some((call) => call.method === 'eq' && call.args[0] === 'locked_by')).toBe(
      false,
    );
  });

  it('libera toda la sesion cuando ya no quedan locks y limpia la cookie', async () => {
    harness.push('guest_sessions', { data: guestSession(), error: null });
    harness.push('seats', { data: [{ id: SEAT_A1 }], error: null });
    harness.push('seats', { data: [], error: null });
    harness.push('guest_sessions', { data: guestSession({ status: 'released' }), error: null });

    const { status, body, cookies } = await postGuest(
      port,
      '/api/public/seats/unlock-guest',
      { trip_id: TRIP_ID },
      cookieHeader(TRIP_ID, 'g'.repeat(43)),
    );

    expect(status).toBe(200);
    expect(body.unlocked).toBe(1);
    expect(body.guest_session.status).toBe('released');
    expect(
      cookies.some((cookie) => cookie.includes('1970') || cookie.includes('Max-Age=1')),
    ).toBe(true);
  });

  it('rechaza el unlock de un seat perteneciente a otra sesion', async () => {
    harness.push('guest_sessions', { data: guestSession(), error: null });
    harness.push('seats', {
      data: [
        seatRow({
          status: 'locked',
          guest_session_id: OTHER_SESSION_ID,
          lock_expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      ],
      error: null,
    });

    const { status, body } = await postGuest(
      port,
      '/api/public/seats/unlock-guest',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1] },
      cookieHeader(TRIP_ID, 'h'.repeat(43)),
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('SEAT_LOCKED');
    expect(
      harness.chains().some((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && call.args[0]?.status === 'available',
        ),
      ),
    ).toBe(false);
  });

  it('rechaza el unlock de un seat bloqueado por un customer', async () => {
    harness.push('guest_sessions', { data: guestSession(), error: null });
    harness.push('seats', {
      data: [
        seatRow({
          status: 'locked',
          locked_by: CUSTOMER_ID,
          lock_expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      ],
      error: null,
    });

    const { status, body } = await postGuest(
      port,
      '/api/public/seats/unlock-guest',
      { trip_id: TRIP_ID, seat_ids: [SEAT_A1] },
      cookieHeader(TRIP_ID, 'i'.repeat(43)),
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('SEAT_LOCKED');
  });
});
