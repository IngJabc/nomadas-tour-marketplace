/**
 * Regression: Express behind Render proxy + express-rate-limit.
 * Ensures trust proxy=1 and X-Forwarded-For does not throw
 * ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  process.env.JWT_SECRET = 'test-jwt-secret-for-app-tests';
  process.env.CORS_ORIGIN = 'http://localhost:3000';
  process.env.RESEND_API_KEY = 'test-resend';
  process.env.EMAIL_FROM = 'test@example.com';
  process.env.FRONTEND_URL = 'http://localhost:3000';
});

import app from './app.js';

describe('Express app — trust proxy / rate-limit', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    const closing = server;
    server = null;
    await new Promise<void>((resolve, reject) => {
      closing.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('configures trust proxy to 1 (Render LB hop)', () => {
    expect(app.get('trust proxy')).toBe(1);
  });

  it('rejects invalid login body with VALIDATION_ERROR through rate limiter', async () => {
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });

    const { port } = server.address() as AddressInfo;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/auth/login`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.9',
        },
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });
});

// ── Health endpoint /healthz ───────────────────────────────────────────────
describe('Health endpoint /healthz', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    const closing = server;
    server = null;
    await new Promise<void>((resolve, reject) => {
      closing.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function startServer(): Promise<number> {
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    return (server.address() as AddressInfo).port;
  }

  it('GET /healthz returns 200 with expected JSON shape', async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('nomadas-marketplace-api');
    expect(typeof body.version).toBe('string');
    expect(body.version).not.toBe('');
    expect(Number.isInteger(body.uptime_seconds)).toBe(true);
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.pid)).toBe(true);
    expect(body.pid).toBeGreaterThan(0);
  });

  it('GET /healthz returns correct Content-Type and Content-Length', async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);

    expect(res.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    const contentLength = res.headers.get('content-length');
    expect(contentLength).not.toBeNull();
    const bodyText = await res.text();
    expect(Number(contentLength)).toBe(Buffer.byteLength(bodyText));
  });

  it('GET /healthz returns Cache-Control no-store', async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);

    expect(res.headers.get('cache-control')).toBe(
      'no-store, no-cache, must-revalidate',
    );
  });

  it('HEAD /healthz returns 200 with empty body', async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      method: 'HEAD',
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('multiple rapid GET requests to /healthz do not 429', async () => {
    const port = await startServer();
    const requests = Array.from({ length: 50 }, () =>
      fetch(`http://127.0.0.1:${port}/healthz`),
    );
    const responses = await Promise.all(requests);
    for (const r of responses) {
      expect(r.status).toBe(200);
    }
  });

  it('GET /healthz does not require authentication', async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Authorization: 'Bearer invalid-token' },
    });

    expect(res.status).toBe(200);
  });
});
