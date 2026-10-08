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
    setUser(handler: (token: string) => Promise<any>) {
      state.getUser = handler;
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
const OTHER_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const OTHER_TRIP_ID = '551559e6-ea35-4453-aae1-5ed0844289b3';
const SEAT_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SEAT_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const SEAT_A3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

function guestCookieName(tripId: string): string {
  return `mkt_guest_lock_${tripId.toLowerCase()}`;
}

function givenAuthAs(userId: string) {
  harness.setUser(() =>
    Promise.resolve({ data: { user: { id: userId } }, error: null }),
  );
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

function eligibleSeat(id: string, code: string, expiresAt: string) {
  return { id, seat_code: code, locked_by: null, lock_expires_at: expiresAt };
}

function cookieHeader(tripId: string, token: string): Record<string, string> {
  return { Cookie: `${guestCookieName(tripId)}=${encodeURIComponent(token)}` };
}

function getSetCookies(res: Response): string[] {
  const headers = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

async function startServer(): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function postClaim(
  port: number,
  body: unknown,
  options: { token?: string | null; cookieToken?: string } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? 'token'}`;
  }
  if (options.cookieToken) {
    headers.Cookie = `${guestCookieName(TRIP_ID)}=${encodeURIComponent(options.cookieToken)}`;
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/public/seats/claim-guest`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
    cookies: getSetCookies(res),
  };
}

describe('POST /api/public/seats/claim-guest', () => {
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
    // La primera consulta de cada request autenticado resuelve public.users.
    harness.push('users', {
      data: { id: CUSTOMER_ID, role: 'customer', agency_id: null },
      error: null,
    });
  });

  it('adopta varios seats preservando lock_expires_at e invalida la cookie', async () => {
    const sessionExpires = new Date(Date.now() + 800_000).toISOString();
    const expiryA = new Date(Date.now() + 700_000).toISOString();
    const expiryB = new Date(Date.now() + 750_000).toISOString();
    const expiryC = new Date(Date.now() + 800_000).toISOString();
    const session = guestSession({ expires_at: sessionExpires });
    const claimed = { ...session, status: 'claimed', customer_id: CUSTOMER_ID };

    harness.push('guest_sessions', { data: session, error: null });
    harness.push('seats', {
      data: [
        eligibleSeat(SEAT_A3, 'A3', expiryC),
        eligibleSeat(SEAT_A1, 'A1', expiryA),
        eligibleSeat(SEAT_A2, 'A2', expiryB),
      ],
      error: null,
    });
    harness.push('guest_sessions', { data: claimed, error: null });
    harness.push('seats', {
      data: [
        { id: SEAT_A1, seat_code: 'A1', lock_expires_at: expiryA },
        { id: SEAT_A2, seat_code: 'A2', lock_expires_at: expiryB },
        { id: SEAT_A3, seat_code: 'A3', lock_expires_at: expiryC },
      ],
      error: null,
    });

    const { status, body, cookies } = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { cookieToken: 'z'.repeat(43) },
    );

    expect(status).toBe(200);
    expect(body.claimed).toBe(true);
    expect(body.claimed).toBe(true);
    expect(body.trip_id).toBe(TRIP_ID);
    expect(body.seats.map((seat: any) => seat.seat_code)).toEqual(['A1', 'A2', 'A3']);
    expect(body.seats.map((seat: any) => seat.lock_expires_at)).toEqual([
      expiryA,
      expiryB,
      expiryC,
    ]);
    expect(body.lock_expires_at).toBe(expiryA);
    expect(body.guest_session).toMatchObject({
      trip_id: TRIP_ID,
      status: 'claimed',
      expires_at: sessionExpires,
    });
    expect(JSON.stringify(body)).not.toContain('z'.repeat(43));
    expect(cookies.some((cookie) => cookie.includes('1970') || cookie.includes('Max-Age=1'))).toBe(
      true,
    );

    const claimUpdate = harness
      .chains()
      .filter((chain) => chain.table === 'guest_sessions')
      .find((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && call.args[0]?.status === 'claimed',
        ),
      )!;
    expect(
      claimUpdate.calls.find((call) => call.method === 'update')!.args[0],
    ).toEqual({ status: 'claimed', customer_id: CUSTOMER_ID });

    const transfer = harness
      .chains()
      .filter((chain) => chain.table === 'seats')
      .find((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && 'locked_by' in (call.args[0] ?? {}),
        ),
      )!;
    const transferPayload = transfer.calls.find((call) => call.method === 'update')!.args[0];
    expect(transferPayload).toEqual({ locked_by: CUSTOMER_ID, guest_session_id: null });
    expect(transferPayload).not.toHaveProperty('lock_expires_at');
    expect(transferPayload).not.toHaveProperty('locked_at');
  });

  it('ignora customer_id, guest_session_id y ttl_seconds del body', async () => {
    const session = guestSession();
    const claimed = { ...session, status: 'claimed', customer_id: CUSTOMER_ID };
    const expiry = new Date(Date.now() + 700_000).toISOString();

    harness.push('guest_sessions', { data: session, error: null });
    harness.push('seats', { data: [eligibleSeat(SEAT_A1, 'A1', expiry)], error: null });
    harness.push('guest_sessions', { data: claimed, error: null });
    harness.push('seats', {
      data: [{ id: SEAT_A1, seat_code: 'A1', lock_expires_at: expiry }],
      error: null,
    });

    const { status, body } = await postClaim(
      port,
      {
        trip_id: TRIP_ID,
        customer_id: OTHER_CUSTOMER_ID,
        guest_session_id: 'oferta-falsa',
        ttl_seconds: 5,
      },
      { cookieToken: 'y'.repeat(43) },
    );

    expect(status).toBe(200);
    expect(body.seats).toHaveLength(1);
    expect(body.seats[0].lock_expires_at).toBe(expiry);
    const transfer = harness
      .chains()
      .filter((chain) => chain.table === 'seats')
      .find((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && 'locked_by' in (call.args[0] ?? {}),
        ),
      )!;
    expect(
      transfer.calls.find((call) => call.method === 'update')!.args[0],
    ).toEqual({ locked_by: CUSTOMER_ID, guest_session_id: null });
  });

  it('solo un customer gana cuando dos reclaman la misma sesion', async () => {
    const session = guestSession();
    const claimed = { ...session, status: 'claimed', customer_id: CUSTOMER_ID };
    const expiry = new Date(Date.now() + 700_000).toISOString();

    harness.setUser((token: string) =>
      Promise.resolve({
        data: { user: { id: token === 'token-a' ? CUSTOMER_ID : OTHER_CUSTOMER_ID } },
        error: null,
      }),
    );
    harness.push('users', {
      data: { id: CUSTOMER_ID, role: 'customer', agency_id: null },
      error: null,
    });
    harness.push('guest_sessions', { data: session, error: null });
    harness.push('seats', { data: [eligibleSeat(SEAT_A1, 'A1', expiry)], error: null });
    harness.push('guest_sessions', { data: claimed, error: null });
    harness.push('seats', {
      data: [{ id: SEAT_A1, seat_code: 'A1', lock_expires_at: expiry }],
      error: null,
    });
    harness.push('users', {
      data: { id: OTHER_CUSTOMER_ID, role: 'customer', agency_id: null },
      error: null,
    });
    harness.push('guest_sessions', { data: claimed, error: null });

    const first = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { token: 'token-a', cookieToken: 'w'.repeat(43) },
    );
    expect(first.status).toBe(200);

    const second = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { token: 'token-b', cookieToken: 'w'.repeat(43) },
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('GUEST_SESSION_CLAIMED');
  });

  it('revierte sin transferencia parcial si un seat cambia durante el claim', async () => {
    const session = guestSession();
    const claimed = { ...session, status: 'claimed', customer_id: CUSTOMER_ID };
    const expiryA = new Date(Date.now() + 700_000).toISOString();
    const expiryB = new Date(Date.now() + 750_000).toISOString();

    harness.push('guest_sessions', { data: session, error: null });
    harness.push('seats', {
      data: [eligibleSeat(SEAT_A1, 'A1', expiryA), eligibleSeat(SEAT_A2, 'A2', expiryB)],
      error: null,
    });
    harness.push('guest_sessions', { data: claimed, error: null });
    harness.push('seats', {
      data: [{ id: SEAT_A1, seat_code: 'A1', lock_expires_at: expiryA }],
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('guest_sessions', { data: session, error: null });

    const { status, body } = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { cookieToken: 'v'.repeat(43) },
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('GUEST_CLAIM_CONFLICT');

    const revert = harness
      .chains()
      .filter((chain) => chain.table === 'seats')
      .find((chain) =>
        chain.calls.some(
          (call) =>
            call.method === 'update' &&
            call.args[0]?.locked_by === null &&
            'guest_session_id' in (call.args[0] ?? {}),
        ),
      );
    expect(revert).toBeDefined();

    const sessionReset = harness
      .chains()
      .filter((chain) => chain.table === 'guest_sessions')
      .find((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && call.args[0]?.status === 'active',
        ),
      );
    expect(sessionReset).toBeDefined();
  });

  it('adopta solo los locks vigentes cuando otros ya expiraron', async () => {
    const session = guestSession();
    const claimed = { ...session, status: 'claimed', customer_id: CUSTOMER_ID };
    const valid = new Date(Date.now() + 700_000).toISOString();
    const expired = new Date(Date.now() - 1_000).toISOString();

    harness.push('guest_sessions', { data: session, error: null });
    harness.push('seats', {
      data: [
        eligibleSeat(SEAT_A1, 'A1', valid),
        { ...eligibleSeat(SEAT_A2, 'A2', expired) },
      ],
      error: null,
    });
    harness.push('guest_sessions', { data: claimed, error: null });
    harness.push('seats', {
      data: [{ id: SEAT_A1, seat_code: 'A1', lock_expires_at: valid }],
      error: null,
    });

    const { status, body } = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { cookieToken: 'u'.repeat(43) },
    );

    expect(status).toBe(200);
    expect(body.seats.map((seat: any) => seat.seat_code)).toEqual(['A1']);
    expect(body.lock_expires_at).toBe(valid);
  });

  it('rechaza el claim cuando la sesion ya no tiene locks vigentes', async () => {
    harness.push('guest_sessions', { data: guestSession(), error: null });
    harness.push('seats', { data: [], error: null });

    const { status, body } = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { cookieToken: 't'.repeat(43) },
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('GUEST_SESSION_EMPTY');
    expect(
      harness.chains().some((chain) =>
        chain.calls.some(
          (call) => call.method === 'update' && call.args[0]?.status === 'claimed',
        ),
      ),
    ).toBe(false);
  });

  it('rechaza sin autenticacion', async () => {
    const { status, body } = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { token: null, cookieToken: 's'.repeat(43) },
    );

    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('rechaza sin cookie guest', async () => {
    const { status, body } = await postClaim(port, { trip_id: TRIP_ID }, { token: 'token' });

    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(harness.chains().filter((chain) => chain.table === 'seats')).toHaveLength(0);
  });

  it('rechaza cookie invalida y sesion de otro viaje', async () => {
    const invalid = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { token: 'token', cookieToken: 'mala!!' },
    );
    expect(invalid.status).toBe(401);

    harness.push('users', {
      data: { id: CUSTOMER_ID, role: 'customer', agency_id: null },
      error: null,
    });
    harness.push('guest_sessions', {
      data: guestSession({ trip_id: OTHER_TRIP_ID }),
      error: null,
    });
    const crossTrip = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { token: 'token', cookieToken: 'r'.repeat(43) },
    );
    expect(crossTrip.status).toBe(401);
    expect(
      harness.chains().filter((chain) => chain.table === 'seats'),
    ).toHaveLength(0);
  });

  it('rechaza sesion expirada, liberada o ya reclamada', async () => {
    harness.push('guest_sessions', {
      data: guestSession({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
      error: null,
    });
    harness.push('guest_sessions', {
      data: guestSession({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
      error: null,
    });
    const expired = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { token: 'token', cookieToken: 'q'.repeat(43) },
    );
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('GUEST_SESSION_EXPIRED');

    harness.push('users', {
      data: { id: CUSTOMER_ID, role: 'customer', agency_id: null },
      error: null,
    });
    harness.push('guest_sessions', { data: guestSession({ status: 'released' }), error: null });
    const released = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { token: 'token', cookieToken: 'p'.repeat(43) },
    );
    expect(released.status).toBe(401);

    harness.push('users', {
      data: { id: CUSTOMER_ID, role: 'customer', agency_id: null },
      error: null,
    });
    harness.push('guest_sessions', {
      data: guestSession({ status: 'claimed', customer_id: OTHER_CUSTOMER_ID }),
      error: null,
    });
    const claimed = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { token: 'token', cookieToken: 'o'.repeat(43) },
    );
    expect(claimed.status).toBe(409);
    expect(claimed.body.error.code).toBe('GUEST_SESSION_CLAIMED');
    expect(
      harness.chains().filter((chain) => chain.table === 'seats'),
    ).toHaveLength(0);
  });

  it('rechaza input invalido con el envelope estandar', async () => {
    const { status, body } = await postClaim(
      port,
      { trip_id: 'no-es-uuid' },
      { token: 'token', cookieToken: 'n'.repeat(43) },
    );

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('el customer ve los locks adoptados en el endpoint autenticado', async () => {
    const expiry = new Date(Date.now() + 700_000).toISOString();
    harness.push('seats', {
      data: [{ id: SEAT_A1, seat_code: 'A1', lock_expires_at: expiry }],
      error: null,
    });

    const res = await fetch(
      `http://127.0.0.1:${port}/api/public/seats/locks?trip_id=${TRIP_ID}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.seats.map((seat: any) => seat.seat_code)).toEqual(['A1']);
    expect(body.lock_expires_at).toBe(expiry);
  });

  it('la cookie anterior ya no sirve en endpoints guest tras el claim', async () => {
    const claimed = guestSession({ status: 'claimed', customer_id: CUSTOMER_ID });

    harness.push('guest_sessions', { data: claimed, error: null });
    const locksRes = await fetch(
      `http://127.0.0.1:${port}/api/public/seats/guest-locks?trip_id=${TRIP_ID}`,
      { headers: cookieHeader(TRIP_ID, 'm'.repeat(43)) },
    );
    expect(locksRes.status).toBe(409);
    expect(((await locksRes.json()) as Record<string, any>).error.code).toBe(
      'GUEST_SESSION_CLAIMED',
    );

    harness.push('guest_sessions', { data: claimed, error: null });
    const unlockRes = await fetch(`http://127.0.0.1:${port}/api/public/seats/unlock-guest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieHeader(TRIP_ID, 'm'.repeat(43)),
      },
      body: JSON.stringify({ trip_id: TRIP_ID, seat_ids: [SEAT_A1] }),
    });
    expect(unlockRes.status).toBe(409);
  });

  it('un superadmin que lockea como guest no puede ni reclamar ni crear la reserva', async () => {
    const SUPERADMIN_ID = '55555555-5555-4555-8555-555555555555';
    const AGENCY_ID = '5bf0be5d-c03a-431f-97d5-e2a065e25752';
    const session = guestSession();
    const seatRow = {
      id: SEAT_A1,
      trip_id: TRIP_ID,
      seat_code: 'A1',
      status: 'available',
      locked_by: null,
      guest_session_id: null,
      lock_expires_at: null,
    };

    harness.reset();

    // 1) La cuenta superadmin lockea como guest, sin autenticación (así
    //    funciona su selección de asientos en el checkout).
    harness.push('guest_sessions', { data: session, error: null });
    harness.push('trips', {
      data: { id: TRIP_ID, status: 'active', capacity: 31 },
      error: null,
    });
    harness.push('seats', { data: [], error: null });
    harness.push('seats', { data: [seatRow], error: null });
    harness.push('seats', { data: [{ id: SEAT_A1 }], error: null });
    harness.push('guest_sessions', { data: session, error: null });

    const locked = await fetch(
      `http://127.0.0.1:${port}/api/public/seats/lock-guest`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trip_id: TRIP_ID, seat_ids: [SEAT_A1] }),
      },
    );
    expect(locked.status).toBe(200);
    const cookies = getSetCookies(locked);
    const token = cookies
      .map((value) => value.split(';', 1)[0] ?? '')
      .find((value) => value.startsWith(`${guestCookieName(TRIP_ID)}=`))
      ?.slice(guestCookieName(TRIP_ID).length + 1);
    expect(token).toBeTruthy();

    const sessionsAfterLock = harness
      .chains()
      .filter((chain) => chain.table === 'guest_sessions').length;
    const seatsAfterLock = harness
      .chains()
      .filter((chain) => chain.table === 'seats').length;

    // 2) Vuelve al checkout autenticado como superadmin e intenta reclamar:
    //    el claim exige rol customer.
    harness.push('users', {
      data: { id: SUPERADMIN_ID, role: 'superadmin', agency_id: null },
      error: null,
    });
    const claim = await postClaim(
      port,
      { trip_id: TRIP_ID },
      { cookieToken: decodeURIComponent(token!) },
    );
    expect(claim.status).toBe(403);
    expect(claim.body.error.code).toBe('CUSTOMER_REQUIRED');
    expect(
      harness.chains().filter((chain) => chain.table === 'guest_sessions'),
    ).toHaveLength(sessionsAfterLock);
    expect(
      harness.chains().filter((chain) => chain.table === 'seats'),
    ).toHaveLength(seatsAfterLock);

    // 3) El POST de reserva también queda prohibido, antes del payload y
    //    antes del RPC.
    harness.push('users', {
      data: { id: SUPERADMIN_ID, role: 'superadmin', agency_id: null },
      error: null,
    });
    const created = await fetch(
      `http://127.0.0.1:${port}/api/public/reservations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
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
        }),
      },
    );

    expect(created.status).toBe(403);
    expect(
      ((await created.json()) as Record<string, any>).error.code,
    ).toBe('CUSTOMER_REQUIRED');
    expect(
      harness.chains().filter((chain) => chain.table === 'reservations'),
    ).toHaveLength(0);
    expect(
      harness
        .chains()
        .filter((chain) => chain.table === 'reservation_passengers'),
    ).toHaveLength(0);
    expect(
      harness.chains().filter((chain) => chain.table === 'seats'),
    ).toHaveLength(seatsAfterLock);
  });
});
