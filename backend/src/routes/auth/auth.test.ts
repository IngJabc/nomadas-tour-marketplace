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

  const TOKEN_PREFIX = 'sb-mkt.';

  function defaultGetUser(token: string) {
    return token.startsWith(TOKEN_PREFIX)
      ? Promise.resolve({
          data: { user: { id: token.slice(TOKEN_PREFIX.length) } },
          error: null,
        })
      : Promise.resolve({
          data: { user: null },
          error: { message: 'invalid token' },
        });
  }

  function defaultSignIn() {
    return Promise.resolve({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });
  }

  function defaultSignUp() {
    return Promise.resolve({
      data: { user: null, session: null },
      error: { message: 'signup failed' },
    });
  }

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    chains: ChainRecord[];
    getUser: (token: string) => Promise<any>;
    signIn: (input: { email: string; password: string }) => Promise<any>;
    signUp: (input: { email: string; password: string }) => Promise<any>;
  } = {
    queues: {},
    defaults: {},
    chains: [],
    getUser: defaultGetUser,
    signIn: defaultSignIn,
    signUp: defaultSignUp,
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
    setSignIn(handler: (input: { email: string; password: string }) => Promise<any>) {
      state.signIn = handler;
    },
    setSignUp(handler: (input: { email: string; password: string }) => Promise<any>) {
      state.signUp = handler;
    },
    reset() {
      state.chains = [];
      state.queues = {};
      state.defaults = {};
      state.getUser = defaultGetUser;
      state.signIn = defaultSignIn;
      state.signUp = defaultSignUp;
    },
    chains: () => state.chains,
    from: (table: string) => buildChain(table),
    auth: {
      getUser: (token: string) => state.getUser(token),
      signInWithPassword: (input: { email: string; password: string }) =>
        state.signIn(input),
      signUp: (input: { email: string; password: string }) => state.signUp(input),
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
const NEW_USER_ID = '55555555-5555-4555-8555-555555555555';
const AGENCY_ID = '33333333-3333-4333-8333-333333333333';
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const EMAIL = 'cliente.schema@example.com';
const PASSWORD = 'Passw0rd!Staging';

function tokenFor(userId: string) {
  return `sb-mkt.${userId}`;
}

function givenUserRow(id: string, role: string, email = EMAIL) {
  harness.setDefault('users', {
    data: { id, email, role, agency_id: null },
    error: null,
  });
}

function givenPasswordGrantSucceeds(userId: string) {
  harness.setSignIn(() =>
    Promise.resolve({
      data: {
        user: { id: userId },
        session: {
          access_token: tokenFor(userId),
          refresh_token: `refresh-${userId}`,
        },
      },
      error: null,
    }),
  );
}

function selectCalls() {
  return harness
    .chains()
    .flatMap((chain) => chain.calls)
    .filter((call) => call.method === 'select');
}

function expectNoFullNameInSelects() {
  const selects = selectCalls();
  expect(selects.length).toBeGreaterThan(0);
  for (const call of selects) {
    expect(String(call.args[0])).not.toContain('full_name');
  }
}

function expectNoFullNameInPayloads() {
  const calls = harness.chains().flatMap((chain) => chain.calls);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(JSON.stringify(call.args)).not.toContain('full_name');
  }
}

let ipSeq = 10;
function nextIp() {
  ipSeq += 1;
  return `203.0.113.${ipSeq}`;
}

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
  opts: { token?: string; xff: string } = { xff: nextIp() },
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': opts.xff,
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function getJson(port: number, path: string, token?: string, xff = nextIp()) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      'X-Forwarded-For': xff,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('Auth API — schema real de public.users (id, email, password_hash, role, agency_id)', () => {
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
  });

  it('register crea un customer con la fila real de public.users y sin full_name', async () => {
    harness.setSignUp(() =>
      Promise.resolve({
        data: { user: { id: NEW_USER_ID }, session: null },
        error: null,
      }),
    );
    givenPasswordGrantSucceeds(NEW_USER_ID);

    const { status, body } = await postJson(port, '/api/auth/register', {
      email: EMAIL,
      password: PASSWORD,
    });

    expect(status).toBe(201);
    expect(body.user).toEqual({
      id: NEW_USER_ID,
      email: EMAIL,
      role: 'customer',
    });
    expect('full_name' in body.user).toBe(false);
    expect(body.token).toBe(tokenFor(NEW_USER_ID));

    const upsert = harness
      .chains()
      .find(
        (chain) =>
          chain.table === 'users' &&
          chain.calls.some((call) => call.method === 'upsert'),
      );
    expect(upsert).toBeDefined();
    const upsertCall = upsert!.calls.find((call) => call.method === 'upsert')!;
    expect(Object.keys(upsertCall.args[0]).sort()).toEqual([
      'email',
      'id',
      'password_hash',
      'role',
    ]);
    expect(upsertCall.args[0]).toEqual({
      id: NEW_USER_ID,
      email: EMAIL,
      password_hash: '',
      role: 'customer',
    });
    expect(upsertCall.args[1]).toEqual({ onConflict: 'id' });
    expectNoFullNameInPayloads();
  });

  it('register ignora un full_name extra en el body y nunca lo persiste', async () => {
    harness.setSignUp(() =>
      Promise.resolve({
        data: { user: { id: NEW_USER_ID }, session: null },
        error: null,
      }),
    );
    givenPasswordGrantSucceeds(NEW_USER_ID);

    const { status, body } = await postJson(port, '/api/auth/register', {
      email: EMAIL,
      password: PASSWORD,
      full_name: 'Nombre Inventado',
    });

    expect(status).toBe(201);
    expect(body.user).toEqual({
      id: NEW_USER_ID,
      email: EMAIL,
      role: 'customer',
    });
    expectNoFullNameInPayloads();
  });

  it('register devuelve 201 sin token cuando el login inmediato no esta disponible (autoconfirm off)', async () => {    harness.setSignUp(() =>
      Promise.resolve({
        data: { user: { id: NEW_USER_ID }, session: null },
        error: null,
      }),
    );

    const { status, body } = await postJson(port, '/api/auth/register', {
      email: EMAIL,
      password: PASSWORD,
    });

    expect(status).toBe(201);
    expect(body.user).toEqual({
      id: NEW_USER_ID,
      email: EMAIL,
      role: 'customer',
    });
    expect(body.token).toBeNull();
  });

  it('login devuelve token y usuario con id, email y role sin full_name', async () => {
    givenPasswordGrantSucceeds(CUSTOMER_ID);
    givenUserRow(CUSTOMER_ID, 'customer');

    const { status, body } = await postJson(port, '/api/auth/login', {
      email: EMAIL,
      password: PASSWORD,
    });

    expect(status).toBe(200);
    expect(body.token).toBe(tokenFor(CUSTOMER_ID));
    expect(body.refresh_token).toBe(`refresh-${CUSTOMER_ID}`);
    expect(body.user).toEqual({
      id: CUSTOMER_ID,
      email: EMAIL,
      role: 'customer',
    });
    expect('full_name' in body.user).toBe(false);
    expectNoFullNameInSelects();
  });

  it('GET /me devuelve el perfil del customer sin full_name', async () => {
    givenUserRow(CUSTOMER_ID, 'customer');

    const { status, body } = await getJson(
      port,
      '/api/auth/me',
      tokenFor(CUSTOMER_ID),
    );

    expect(status).toBe(200);
    expect(body.user).toEqual({
      id: CUSTOMER_ID,
      email: EMAIL,
      role: 'customer',
    });
    expect('full_name' in body.user).toBe(false);
    expectNoFullNameInSelects();
  });

  it('el token devuelto en login resuelve id y role en /me', async () => {
    givenPasswordGrantSucceeds(CUSTOMER_ID);
    givenUserRow(CUSTOMER_ID, 'customer');

    const login = await postJson(port, '/api/auth/login', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(login.status).toBe(200);

    const me = await getJson(port, '/api/auth/me', login.body.token);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(CUSTOMER_ID);
    expect(me.body.user.role).toBe('customer');

    const contextSelect = selectCalls().find(
      (call) => call.args[0] === 'id, role, agency_id',
    );
    expect(contextSelect).toBeDefined();
  });

  it('un customer autenticado accede al flujo protegido de asientos', async () => {
    givenUserRow(CUSTOMER_ID, 'customer');

    const { status, body } = await getJson(
      port,
      `/api/public/seats/locks?trip_id=${TRIP_ID}`,
      tokenFor(CUSTOMER_ID),
    );

    expect(status).toBe(200);
    expect(body.trip_id).toBe(TRIP_ID);
    expect(body.seats).toEqual([]);
    expect(body.lock_expires_at).toBeNull();
  });

  it('roles distintos de customer no obtienen autorizacion customer', async () => {
    givenPasswordGrantSucceeds(AGENCY_ID);
    givenUserRow(AGENCY_ID, 'agency', 'agencia@example.com');

    const deniedLogin = await postJson(port, '/api/auth/login', {
      email: 'agencia@example.com',
      password: PASSWORD,
    });
    expect(deniedLogin.status).toBe(401);
    expect(deniedLogin.body.error.code).toBe('UNAUTHORIZED');
    expect(deniedLogin.body.error.message).toBe(
      'Esta cuenta no pertenece al marketplace',
    );

    givenUserRow(CUSTOMER_ID, 'superadmin');

    const forbidden = await getJson(
      port,
      `/api/public/seats/locks?trip_id=${TRIP_ID}`,
      tokenFor(CUSTOMER_ID),
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('CUSTOMER_REQUIRED');
  });

  it('las credenciales invalidas siguen respondiendo 401', async () => {
    const badPassword = await postJson(port, '/api/auth/login', {
      email: EMAIL,
      password: 'wrong-password',
    });
    expect(badPassword.status).toBe(401);
    expect(badPassword.body.error.code).toBe('UNAUTHORIZED');
    expect(badPassword.body.error.message).toBe(
      'Correo o contraseña incorrectos',
    );

    givenPasswordGrantSucceeds(CUSTOMER_ID);
    harness.setDefault('users', {
      data: null,
      error: { message: 'JSON object requested, multiple (or no) rows returned' },
    });

    const noRow = await postJson(port, '/api/auth/login', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(noRow.status).toBe(401);
    expect(noRow.body.error.message).toBe('Usuario no encontrado');
  });

  it('el rate limiting de /login y /register sigue activo (429 RATE_LIMIT)', async () => {
    const xff = '198.51.100.77';
    const allowed: number[] = [];

    for (let i = 0; i < 15; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': xff,
        },
        body: JSON.stringify({ email: EMAIL, password: 'x' }),
      });
      allowed.push(res.status);
      await res.json();
    }
    expect(allowed.every((status) => status === 401)).toBe(true);

    const blocked = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': xff,
      },
      body: JSON.stringify({ email: EMAIL, password: 'x' }),
    });
    const blockedBody = (await blocked.json()) as Record<string, any>;
    expect(blocked.status).toBe(429);
    expect(blockedBody.error.code).toBe('RATE_LIMIT');

    const otherIp = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ email: EMAIL, password: 'x' }),
    });
    expect(otherIp.status).toBe(401);
    await otherIp.json();
  });
});
