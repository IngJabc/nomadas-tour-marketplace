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
  type QueryResult = { data?: any; error?: { code?: string; message?: string } | null };

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    chains: Array<{ table: string; calls: Array<{ method: string; args: any[] }> }>;
    getUser: (token: string) => Promise<any>;
  } = {
    queues: {},
    defaults: {},
    chains: [],
    getUser: () =>
      Promise.resolve({ data: { user: null }, error: { message: 'anonymous' } }),
  };

  const METHODS = [
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
    'gte',
    'ilike',
    'order',
    'range',
    'limit',
    'maybeSingle',
    'single',
  ];

  function buildChain(table: string) {
    const record = { table, calls: [] as Array<{ method: string; args: any[] }> };
    state.chains.push(record);
    const chain: Record<string, any> = {};
    for (const method of METHODS) {
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
    callsFor(table: string) {
      return state.chains
        .filter((chain) => chain.table === table)
        .flatMap((chain) => chain.calls);
    },
    tablesQueried() {
      return state.chains.map((chain) => chain.table);
    },
    reset() {
      state.queues = {};
      state.defaults = {};
      state.chains = [];
    },
    setUser(handler: (token: string) => Promise<any>) {
      state.getUser = handler;
    },
    from: (table: string) => buildChain(table),
    rpc: vi.fn(),
    auth: { getUser: (token: string) => state.getUser(token) },
    storage: { from: vi.fn() },
  };
});

vi.mock('../../config/database.js', () => ({
  supabase: harness,
  supabaseAdmin: harness,
  createAuthenticatedClient: vi.fn(),
}));

import app from '../../app.js';

const ADMIN_ID = '99999999-8888-4999-a999-999999999999';
const AGENCY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function givenAuthAs(userId: string) {
  harness.setUser(() =>
    Promise.resolve({ data: { user: { id: userId } }, error: null }),
  );
}

/** El rol debe ir por DEFAULT: auth consume users vía then (maybeSingle). */
function givenUserRole(role: string, agencyId: string | null = null) {
  harness.setDefault('users', {
    data: { id: ADMIN_ID, role, agency_id: agencyId },
    error: null,
  });
}

function givenAgencyUpdated(overrides: Record<string, unknown> = {}) {
  harness.push('agencies', {
    data: {
      id: AGENCY_ID,
      name: 'Zeta Tours',
      subdomain: 'zeta',
      is_featured: true,
      featured_order: 3,
      ...overrides,
    },
    error: null,
  });
}

function updatePayload() {
  const call = harness.callsFor('agencies').find((entry) => entry.method === 'update');
  return call?.args[0] as Record<string, unknown> | undefined;
}

let server: Server | null = null;
let port = 0;

beforeAll(async () => {
  server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
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
  givenAuthAs(ADMIN_ID);
  givenUserRole('superadmin');
});

async function patchAgency(body: unknown, agencyId: string = AGENCY_ID) {
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/agencies/${agencyId}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('PATCH /api/admin/agencies/:agencyId — destacado y orden (REP-001)', () => {
  it('responde 401 sin token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/agencies/${AGENCY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_featured: true }),
    });

    expect(res.status).toBe(401);
    expect(harness.tablesQueried()).not.toContain('agencies');
  });

  it('responde 403 a una cuenta de cliente (solo superadmin)', async () => {
    givenUserRole('customer');

    const res = await patchAgency({ is_featured: true });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SUPERADMIN_REQUIRED');
    expect(harness.tablesQueried()).not.toContain('agencies');
  });

  it('responde 403 a una cuenta de agencia', async () => {
    givenUserRole('agency', '5bf0be5d-c03a-431f-97d5-e2a065e25752');

    const res = await patchAgency({ is_featured: true });

    expect(res.status).toBe(403);
    expect(harness.tablesQueried()).not.toContain('agencies');
  });

  it('responde 404 AGENCY_NOT_FOUND cuando el id no es un UUID', async () => {
    const res = await patchAgency({ is_featured: true }, 'no-es-uuid');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AGENCY_NOT_FOUND');
    expect(harness.tablesQueried()).not.toContain('agencies');
  });

  it('responde 400 cuando el body está vacío', async () => {
    const res = await patchAgency({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(harness.tablesQueried()).not.toContain('agencies');
  });

  it('responde 400 ante campos desconocidos (body estricto)', async () => {
    const res = await patchAgency({ is_featured: true, nombre: 'hack' });

    expect(res.status).toBe(400);
    expect(harness.tablesQueried()).not.toContain('agencies');
  });

  it('responde 400 con orden negativo', async () => {
    const res = await patchAgency({ featured_order: -1 });

    expect(res.status).toBe(400);
    expect(harness.tablesQueried()).not.toContain('agencies');
  });

  it('responde 400 al asignar orden a una agencia NO destacada', async () => {
    const res = await patchAgency({ is_featured: false, featured_order: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(harness.tablesQueried()).not.toContain('agencies');
  });

  it('destaca una agencia con orden manual', async () => {
    givenAgencyUpdated({ is_featured: true, featured_order: 3 });

    const res = await patchAgency({ is_featured: true, featured_order: 3 });

    expect(res.status).toBe(200);
    expect(res.body.agency).toMatchObject({
      id: AGENCY_ID,
      name: 'Zeta Tours',
      subdomain: 'zeta',
      is_featured: true,
      featured_order: 3,
    });
    expect(updatePayload()).toEqual({ is_featured: true, featured_order: 3 });
  });

  it('al quitar el destacado resetea el orden a 0', async () => {
    givenAgencyUpdated({ is_featured: false, featured_order: 0 });

    const res = await patchAgency({ is_featured: false });

    expect(res.status).toBe(200);
    expect(res.body.agency.is_featured).toBe(false);
    expect(res.body.agency.featured_order).toBe(0);
    // Nunca queda un orden huérfano en una agencia no destacada.
    expect(updatePayload()).toEqual({ is_featured: false, featured_order: 0 });
  });

  it('acepta is_featured false junto a featured_order 0 explícito', async () => {
    givenAgencyUpdated({ is_featured: false, featured_order: 0 });

    const res = await patchAgency({ is_featured: false, featured_order: 0 });

    expect(res.status).toBe(200);
    expect(updatePayload()).toEqual({ is_featured: false, featured_order: 0 });
  });

  it('permite solo el orden sin tocar el destacado', async () => {
    givenAgencyUpdated({ is_featured: true, featured_order: 7 });

    const res = await patchAgency({ featured_order: 7 });

    expect(res.status).toBe(200);
    // Solo se envía lo pedido: el destacado actual se conserva.
    expect(updatePayload()).toEqual({ featured_order: 7 });
    expect(updatePayload()).not.toHaveProperty('is_featured');
  });

  it('destacar sin orden no arrastra featured_order en el payload', async () => {
    givenAgencyUpdated({ is_featured: true, featured_order: 0 });

    const res = await patchAgency({ is_featured: true });

    expect(res.status).toBe(200);
    // Una agencia no destacada siempre tiene orden 0 (lo resetea el
    // backend), así que destacar sin orden es conservador: solo `is_featured`.
    expect(updatePayload()).toEqual({ is_featured: true });
  });

  it('responde 404 AGENCY_NOT_FOUND cuando la agencia no existe', async () => {
    harness.push('agencies', { data: null, error: null });

    const res = await patchAgency({ is_featured: true });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AGENCY_NOT_FOUND');
  });

  it('responde 500 cuando la base de datos falla', async () => {
    harness.push('agencies', {
      data: null,
      error: { message: 'permission denied for table agencies' },
    });

    const res = await patchAgency({ is_featured: true });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('AGENCY_UPDATE_ERROR');
  });
});
