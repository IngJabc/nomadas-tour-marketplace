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

const ADMIN_ID = '99999999-8888-4999-a999-999999999999';
const REVIEW_ID = '11111111-2222-4333-8444-666666666666';

function givenAuthAs(userId: string) {
  harness.setUser(() =>
    Promise.resolve({ data: { user: { id: userId } }, error: null }),
  );
}

/** El rol debe ir por DEFAULT: auth.consume users vía then (maybeSingle). */
function givenUserRole(role: string, agencyId: string | null = null) {
  harness.setDefault('users', {
    data: { id: ADMIN_ID, role, agency_id: agencyId },
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

describe('GET /api/admin/reviews — listado de moderación (REV-001)', () => {
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
    givenAuthAs(ADMIN_ID);
    givenUserRole('superadmin');
  });

  it('responde 403 a una cuenta de cliente (solo superadmin)', async () => {
    givenUserRole('customer');

    const res = await requestJson(port, '/api/admin/reviews');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SUPERADMIN_REQUIRED');
  });

  it('responde 403 a una cuenta de agencia', async () => {
    givenUserRole('agency', '5bf0be5d-c03a-431f-97d5-e2a065e25752');

    const res = await requestJson(port, '/api/admin/reviews');

    expect(res.status).toBe(403);
  });

  it('responde 401 sin token', async () => {
    const res = await requestJson(port, '/api/admin/reviews', { token: null });
    expect(res.status).toBe(401);
  });

  it('lista las reseñas de ambas tablas para el superadmin', async () => {
    // adminListReviews consulta trip_reviews y agency_reviews.
    harness.push('trip_reviews', { data: [], error: null });
    harness.push('agency_reviews', { data: [], error: null });

    const res = await requestJson(port, '/api/admin/reviews');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], has_more: false });
  });
});

describe('PATCH /api/admin/reviews/:reviewType/:reviewId — moderación (REV-001)', () => {
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
    givenAuthAs(ADMIN_ID);
    givenUserRole('superadmin');
  });

  const tripModerateUrl = `/api/admin/reviews/trip_review/${REVIEW_ID}`;
  const agencyModerateUrl = `/api/admin/reviews/agency_review/${REVIEW_ID}`;

  it('oculta una reseña invocando moderate_review con el actor superadmin', async () => {
    harness.setRpcDefault('moderate_review', {
      data: {
        review_id: REVIEW_ID,
        review_type: 'trip_review',
        moderation_status: 'hidden',
        moderated_at: '2026-01-11T00:00:00.000Z',
      },
      error: null,
    });

    const res = await requestJson(port, tripModerateUrl, {
      method: 'PATCH',
      body: { action: 'hide', reason: 'Contenido inapropiado' },
    });

    expect(res.status).toBe(200);
    expect(res.body.moderation_status).toBe('hidden');
    const call = harness.rpcCalls().find((c) => c.fn === 'moderate_review');
    expect(call?.args).toMatchObject({
      p_review_type: 'trip_review',
      p_review_id: REVIEW_ID,
      p_action: 'hide',
      p_actor_user_id: ADMIN_ID,
      p_reason: 'Contenido inapropiado',
    });
  });

  it('permite restore sobre una agency_review', async () => {
    harness.setRpcDefault('moderate_review', {
      data: {
        review_id: REVIEW_ID,
        review_type: 'agency_review',
        moderation_status: 'visible',
        moderated_at: '2026-01-11T00:00:00.000Z',
      },
      error: null,
    });

    const res = await requestJson(port, agencyModerateUrl, {
      method: 'PATCH',
      body: { action: 'restore' },
    });

    expect(res.status).toBe(200);
    expect(res.body.moderation_status).toBe('visible');
    const call = harness.rpcCalls().find((c) => c.fn === 'moderate_review');
    expect(call?.args.p_review_type).toBe('agency_review');
    expect(call?.args.p_action).toBe('restore');
  });

  it('responde 400 cuando la acción no es hide/reject/restore (sin RPC)', async () => {
    const res = await requestJson(port, tripModerateUrl, {
      method: 'PATCH',
      body: { action: 'delete' },
    });

    expect(res.status).toBe(400);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('responde 400 cuando el tipo de reseña no es válido (sin RPC)', async () => {
    const res = await requestJson(
      port,
      `/api/admin/reviews/review_bomba/${REVIEW_ID}`,
      { method: 'PATCH', body: { action: 'hide' } },
    );

    expect(res.status).toBe(400);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('responde 404 cuando el reviewId no es un UUID', async () => {
    const res = await requestJson(
      port,
      '/api/admin/reviews/trip_review/no-es-uuid',
      { method: 'PATCH', body: { action: 'hide' } },
    );

    expect(res.status).toBe(404);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('mapea el rechazo de la RPC (ERR_REVIEW_ADMIN_ROLE) a 403', async () => {
    harness.pushRpc('moderate_review', {
      data: null,
      error: { message: 'ERR_REVIEW_ADMIN_ROLE: Only superadmins can moderate reviews' },
    });

    const res = await requestJson(port, tripModerateUrl, {
      method: 'PATCH',
      body: { action: 'hide' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REVIEW_ADMIN_REQUIRED');
  });

  it('responde 404 cuando la reseña no existe', async () => {
    harness.pushRpc('moderate_review', {
      data: null,
      error: { message: 'ERR_REVIEW_NOT_FOUND: Review not found' },
    });

    const res = await requestJson(port, tripModerateUrl, {
      method: 'PATCH',
      body: { action: 'hide' },
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REVIEW_NOT_FOUND');
  });

  it('responde 403 a una cuenta de cliente (solo superadmin)', async () => {
    givenUserRole('customer');

    const res = await requestJson(port, tripModerateUrl, {
      method: 'PATCH',
      body: { action: 'hide' },
    });

    expect(res.status).toBe(403);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('responde 401 sin token', async () => {
    const res = await requestJson(port, tripModerateUrl, {
      token: null,
      method: 'PATCH',
      body: { action: 'hide' },
    });

    expect(res.status).toBe(401);
  });
});
