import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import net from 'node:net';
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
    removeError: { message: string } | null;
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
    removeError: null,
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
      state.removeError = null;
    },
    setUser(handler: (token: string) => Promise<any>) {
      state.getUser = handler;
    },
    chains: () => state.chains,
    rpcCalls: () => state.rpcCalls,
    from: (table: string) => buildChain(table),
    rpc: (fn: string, args: any) => buildRpc(fn, args),
    auth: { getUser: (token: string) => state.getUser(token) },
    storage: {
      get uploads() {
        return state.uploads;
      },
      get removes() {
        return state.removes;
      },
      setUploadError(error: { message: string } | null) {
        state.uploadError = error;
      },
      setRemoveError(error: { message: string } | null) {
        state.removeError = error;
      },
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
            return { data: null, error: state.removeError };
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
const RESERVATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const IDEMPOTENCY_KEY = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const OTHER_IDEMPOTENCY_KEY = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const PAYMENT_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const RPC = 'submit_marketplace_payment';
const ALLOWED_ORIGIN = 'http://localhost:3002';
const BOUNDARY = '----nomadasBoundary7MA4YWxkTrZu0gW';

interface Part {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}

// ── Fixtures de contenido real (magic bytes) ────────────────────────────────

function pngBytes(payload = 48): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(payload, 0x41),
  ]);
}

function jpegBytes(payload = 48): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.alloc(payload, 0x42),
  ]);
}

function webpBytes(payload = 48): Buffer {
  const buffer = Buffer.alloc(12 + payload, 0x43);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  return buffer;
}

function pdfBytes(payload = 48): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'ascii'),
    Buffer.alloc(payload, 0x44),
  ]);
}

function proofPart(overrides: Partial<Part> = {}): Part {
  return {
    name: 'proof',
    filename: 'comprobante-estudiante.png',
    contentType: 'image/png',
    data: pngBytes(),
    ...overrides,
  };
}

function buildMultipart(parts: Part[]): {
  body: Buffer;
  contentType: string;
} {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`, 'utf8'));
    if (part.filename !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
          'utf8',
        ),
      );
      chunks.push(part.data ?? Buffer.alloc(0));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`,
          'utf8',
        ),
      );
      chunks.push(Buffer.from(part.value ?? '', 'utf8'));
    }
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  };
}

function reservationRow(overrides: Record<string, any> = {}) {
  return {
    id: RESERVATION_ID,
    customer_id: CUSTOMER_ID,
    source: 'marketplace',
    status: 'locked',
    ...overrides,
  };
}

function submittedRpcResult(overrides: Record<string, any> = {}) {
  return {
    data: {
      payment_id: PAYMENT_ID,
      reservation_id: RESERVATION_ID,
      status: 'reserved',
      amount_cents: 3000000,
      currency: 'COP',
      proof_url: `${RESERVATION_ID}/deadbeefcafe.png`,
      submitted_at: '2026-10-08T12:00:00.000Z',
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

function givenUserRole(userId: string, role: string) {
  harness.push('users', { data: { id: userId, role, agency_id: null }, error: null });
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

function writeCalls(table: string) {
  return tableCalls(table).filter(
    (call) => call.method === 'update' || call.method === 'insert' || call.method === 'upsert',
  );
}

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function startServer(): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

interface SubmitOptions {
  reservationId?: string;
  token?: string | null;
  idempotencyKey?: string | null;
  origin?: string | null;
  ip?: string;
  parts?: Part[];
  query?: string;
  rawBody?: Buffer;
  rawContentType?: string;
}

async function submitPayment(port: number, options: SubmitOptions = {}) {
  const reservationId = options.reservationId ?? RESERVATION_ID;
  const parts = options.parts ?? [proofPart()];

  let body: Buffer;
  let contentType: string;
  if (options.rawBody) {
    body = options.rawBody;
    contentType =
      options.rawContentType ?? `multipart/form-data; boundary=${BOUNDARY}`;
  } else {
    const built = buildMultipart(parts);
    body = built.body;
    contentType = built.contentType;
  }

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'X-Forwarded-For': options.ip ?? nextIp(),
  };
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? 'token'}`;
  }
  if (options.idempotencyKey === null) {
    // Header omitido a propósito.
  } else {
    headers['Idempotency-Key'] = options.idempotencyKey ?? IDEMPOTENCY_KEY;
  }
  if (options.origin === null) {
    // Sin header Origin (cliente no-browser).
  } else {
    headers.Origin = options.origin ?? ALLOWED_ORIGIN;
  }

  const res = await fetch(
    `http://127.0.0.1:${port}/api/public/reservations/${reservationId}/payments${options.query ?? ''}`,
    { method: 'POST', headers, body },
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

// NOTA: Mocks de Supabase/storage/RPC. Estas pruebas son unitarias y NO
// verifican la atomicidad real de PostgreSQL (transacción, row locks,
// triggers del outbox 082): esa garantía vive en el RPC 083 y requiere
// validación de integración contra una base de datos real.
describe('POST /api/public/reservations/:reservationId/payments', () => {
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
    harness.setDefault('reservations', {
      data: reservationRow(),
      error: null,
    });
  });

  // ── Multipart y validación de archivos ────────────────────────────────────

  const proofFormats = [
    { label: 'PNG', mime: 'image/png', ext: 'png', bytes: pngBytes },
    { label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', bytes: jpegBytes },
    { label: 'WEBP', mime: 'image/webp', ext: 'webp', bytes: webpBytes },
    { label: 'PDF', mime: 'application/pdf', ext: 'pdf', bytes: pdfBytes },
  ] as const;

  for (const format of proofFormats) {
    it(`acepta un comprobante ${format.label} válido y lo deriva del contenido`, async () => {
      const data = format.bytes();
      harness.pushRpc(RPC, submittedRpcResult());

      const { status, body } = await submitPayment(port, {
        parts: [proofPart({ contentType: format.mime, data })],
      });

      expect(status).toBe(201);
      expect(body.payment_id).toBe(PAYMENT_ID);
      expect(body.reservation_status).toBe('reserved');

      const digest = createHash('sha256').update(data).digest('hex');
      const expectedPath = `${RESERVATION_ID}/${digest}.${format.ext}`;
      expect(lastRpcCall().args.p_proof_path).toBe(expectedPath);

      expect(harness.storage.uploads).toHaveLength(1);
      const upload = harness.storage.uploads[0];
      expect(upload.bucket).toBe('payment-proofs');
      expect(upload.path).toBe(expectedPath);
      expect(upload.contentType).toBe(format.mime);
      expect(upload.upsert).toBe(true);
      expect(upload.size).toBe(data.length);
      // El nombre original nunca construye la ruta.
      expect(upload.path).not.toContain('comprobante');
    });
  }

  it('rechaza MIME declarado que no coincide con las magic bytes', async () => {
    const { status, body } = await submitPayment(port, {
      parts: [proofPart({ contentType: 'image/png', data: jpegBytes() })],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('PAYMENT_FILE_INVALID');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza formatos activos o no permitidos (SVG, HTML)', async () => {
    const svg = await submitPayment(port, {
      parts: [
        proofPart({
          filename: 'logo.svg',
          contentType: 'image/svg+xml',
          data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        }),
      ],
    });
    expect(svg.status).toBe(400);
    expect(svg.body.error.code).toBe('PAYMENT_FILE_INVALID');

    const html = await submitPayment(port, {
      parts: [
        proofPart({
          filename: 'pago.html',
          contentType: 'text/html',
          data: Buffer.from('<html><body>pago</body></html>'),
        }),
      ],
    });
    expect(html.status).toBe(400);
    expect(html.body.error.code).toBe('PAYMENT_FILE_INVALID');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza contenido no reconocible (sin magic bytes)', async () => {
    const { status, body } = await submitPayment(port, {
      parts: [
        proofPart({ contentType: 'image/png', data: Buffer.alloc(64, 0x7a) }),
      ],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('PAYMENT_FILE_INVALID');
    expect(harness.storage.uploads).toHaveLength(0);
  });

  it('rechaza un archivo vacío', async () => {
    const { status, body } = await submitPayment(port, {
      parts: [proofPart({ data: Buffer.alloc(0) })],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('PAYMENT_FILE_INVALID');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza archivos mayores a 5 MiB y detiene el procesamiento', async () => {
    const oversized = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(5 * 1024 * 1024 + 1024, 0x41),
    ]);

    const { status, body } = await submitPayment(port, {
      parts: [proofPart({ data: oversized })],
    });

    expect(status).toBe(413);
    expect(body.error.code).toBe('PAYMENT_FILE_TOO_LARGE');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza la solicitud sin archivo proof', async () => {
    const { status, body } = await submitPayment(port, { parts: [] });

    expect(status).toBe(400);
    expect(body.error.code).toBe('PAYMENT_FILE_MISSING');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza dos archivos en la misma solicitud', async () => {
    const { status, body } = await submitPayment(port, {
      parts: [proofPart(), proofPart({ filename: 'segundo.png' })],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('PAYMENT_MULTIPART_INVALID');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza campos de texto multipart (ningún monto llega al backend)', async () => {
    const { status, body } = await submitPayment(port, {
      parts: [
        proofPart(),
        { name: 'amount_cents', value: '1000' },
      ],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('PAYMENT_MULTIPART_INVALID');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza un campo de archivo con nombre inesperado', async () => {
    const { status, body } = await submitPayment(port, {
      parts: [proofPart({ name: 'voucher' })],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('PAYMENT_MULTIPART_INVALID');
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza customer_id intentado vía campo multipart', async () => {
    const { status, body } = await submitPayment(port, {
      parts: [
        { name: 'customer_id', value: OTHER_CUSTOMER_ID },
        proofPart(),
      ],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('PAYMENT_MULTIPART_INVALID');
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza multipart malformado y content-type no multipart', async () => {
    const garbage = await submitPayment(port, {
      rawBody: Buffer.from('esto no es un multipart valido'),
      rawContentType: `multipart/form-data; boundary=${BOUNDARY}`,
    });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe('PAYMENT_MULTIPART_INVALID');

    const notMultipart = await submitPayment(port, {
      rawBody: Buffer.from('{"proof": "data"}'),
      rawContentType: 'application/json',
    });
    expect(notMultipart.status).toBe(400);
    expect(notMultipart.body.error.code).toBe('PAYMENT_MULTIPART_INVALID');

    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('sobrevive a un stream abortado sin dejar recursos abiertos', async () => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

    socket.write(
      `POST /api/public/reservations/${RESERVATION_ID}/payments HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Authorization: Bearer token\r\n` +
        `Origin: ${ALLOWED_ORIGIN}\r\n` +
        `Idempotency-Key: ${IDEMPOTENCY_KEY}\r\n` +
        `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\n` +
        `Content-Length: 4000\r\n\r\n` +
        `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="proof"; filename="a.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
    );
    socket.write(Buffer.alloc(256, 0x41));
    await delay(120);
    socket.destroy();
    await delay(120);

    harness.pushRpc(RPC, submittedRpcResult());
    const { status, body } = await submitPayment(port);

    expect(status).toBe(201);
    expect(body.payment_id).toBe(PAYMENT_ID);
    // Solo la solicitud completa llegó al RPC y al storage.
    expect(harness.rpcCalls()).toHaveLength(1);
    expect(harness.storage.uploads).toHaveLength(1);
  });

  // ── Autorización y flujo ──────────────────────────────────────────────────

  it('exige autenticación', async () => {
    const { status, body } = await submitPayment(port, { token: null });

    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('exige rol customer', async () => {
    givenAuthAs(SUPERADMIN_ID);
    givenUserRole(SUPERADMIN_ID, 'superadmin');

    const { status, body } = await submitPayment(port);

    expect(status).toBe(403);
    expect(body.error.code).toBe('CUSTOMER_REQUIRED');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('oculta reservas de otros clientes con el mismo 404', async () => {
    harness.push('reservations', {
      data: reservationRow({ customer_id: OTHER_CUSTOMER_ID }),
      error: null,
    });

    const { status, body } = await submitPayment(port);

    expect(status).toBe(404);
    expect(body.error.code).toBe('PAYMENT_RESERVATION_NOT_FOUND');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('oculta reservas del flujo Tour (source internal)', async () => {
    harness.push('reservations', {
      data: reservationRow({ source: 'internal', status: 'confirmed' }),
      error: null,
    });

    const { status, body } = await submitPayment(port);

    expect(status).toBe(404);
    expect(body.error.code).toBe('PAYMENT_RESERVATION_NOT_FOUND');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza reservas fuera del estado permitido antes de subir', async () => {
    harness.push('reservations', {
      data: reservationRow({ status: 'cancelled' }),
      error: null,
    });

    const { status, body } = await submitPayment(port);

    expect(status).toBe(409);
    expect(body.error.code).toBe('PAYMENT_RESERVATION_CLOSED');
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('rechaza reservas inexistentes', async () => {
    harness.push('reservations', { data: null, error: null });

    const { status, body } = await submitPayment(port);

    expect(status).toBe(404);
    expect(body.error.code).toBe('PAYMENT_RESERVATION_NOT_FOUND');
    expect(harness.storage.uploads).toHaveLength(0);
  });

  it('exige header Idempotency-Key y formato UUID', async () => {
    const missing = await submitPayment(port, { idempotencyKey: null });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');

    const malformed = await submitPayment(port, { idempotencyKey: 'no-es-uuid' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');

    // Ni siquiera se consultó la reserva ni se tocó el storage.
    expect(tableCalls('reservations')).toHaveLength(0);
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('valida el Origin según las protecciones CSRF existentes', async () => {
    const { status, body } = await submitPayment(port, {
      origin: 'http://evil.example',
    });

    expect(status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(tableCalls('reservations')).toHaveLength(0);
    expect(harness.storage.uploads).toHaveLength(0);
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('limita a 10 solicitudes por minuto por cliente', async () => {
    const ip = '203.0.113.10';

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await submitPayment(port, { ip, idempotencyKey: null });
      statuses.push(result.status);
    }
    expect(statuses.every((status) => status === 400)).toBe(true);

    const blocked = await submitPayment(port, { ip, idempotencyKey: null });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT');
  });

  it('sube y llama al RPC con solo parámetros server-side', async () => {
    harness.pushRpc(RPC, submittedRpcResult());
    const data = pngBytes();

    const { status, body } = await submitPayment(port, {
      parts: [proofPart({ data })],
      query: `?amount_cents=1&currency=USD&customer_id=${OTHER_CUSTOMER_ID}`,
    });

    expect(status).toBe(201);
    expect(harness.rpcCalls()).toHaveLength(1);

    const call = lastRpcCall();
    expect(call.fn).toBe(RPC);
    expect(Object.keys(call.args).sort()).toEqual(
      ['p_customer_id', 'p_idempotency_key', 'p_proof_path', 'p_reservation_id'].sort(),
    );
    // customer_id SIEMPRE de la sesión autenticada.
    expect(call.args.p_customer_id).toBe(CUSTOMER_ID);
    expect(call.args.p_reservation_id).toBe(RESERVATION_ID);
    expect(call.args.p_idempotency_key).toBe(IDEMPOTENCY_KEY);
    const digest = createHash('sha256').update(data).digest('hex');
    expect(call.args.p_proof_path).toBe(`${RESERVATION_ID}/${digest}.png`);
    // Ni la query string ni el multipart aportan monto/moneda/estado.
    const serialized = JSON.stringify(call.args);
    expect(serialized).not.toContain('amount');
    expect(serialized).not.toContain('USD');
    expect(serialized).not.toContain(OTHER_CUSTOMER_ID);
    // Nunca una URL pública o firmada.
    expect(serialized).not.toContain('http');
    expect(body).not.toHaveProperty('proof_url');
    expect(JSON.stringify(body)).not.toContain('deadbeef');
  });

  it('no escribe en reservations, seats ni payments fuera del RPC', async () => {
    harness.pushRpc(RPC, submittedRpcResult());

    const { status } = await submitPayment(port);

    expect(status).toBe(201);
    expect(writeCalls('reservations')).toHaveLength(0);
    expect(tableCalls('seats')).toHaveLength(0);
    expect(tableCalls('payments')).toHaveLength(0);
    expect(writeCalls('reservation_passengers')).toHaveLength(0);
  });

  it('devuelve el contrato de éxito completo sin exponer la ruta interna', async () => {
    harness.pushRpc(RPC, submittedRpcResult());

    const { status, body } = await submitPayment(port);

    expect(status).toBe(201);
    expect(Object.keys(body).sort()).toEqual(
      [
        'payment_id',
        'reservation_id',
        'payment_status',
        'reservation_status',
        'amount_cents',
        'currency',
        'submitted_at',
        'idempotent',
      ].sort(),
    );
    expect(body.payment_id).toBe(PAYMENT_ID);
    expect(body.reservation_id).toBe(RESERVATION_ID);
    expect(body.payment_status).toBe('pending');
    expect(body.reservation_status).toBe('reserved');
    expect(body.amount_cents).toBe(3000000);
    expect(body.submitted_at).toBe('2026-10-08T12:00:00.000Z');
    expect(body.idempotent).toBe(false);
  });

  // ── Storage, RPC e idempotencia ───────────────────────────────────────────

  it('mapea un fallo del storage a error de infraestructura', async () => {
    harness.storage.setUploadError({ message: 'bucket unavailable' });

    const { status, body } = await submitPayment(port);

    expect(status).toBe(500);
    expect(body.error.code).toBe('PAYMENT_STORAGE_ERROR');
    expect(harness.rpcCalls()).toHaveLength(0);
    expect(harness.storage.removes).toHaveLength(0);
  });

  it('mapea errores de negocio del RPC sin filtrar mensajes SQL', async () => {
    harness.pushRpc(RPC, {
      data: null,
      error: { message: 'ERR_PAYMENT_LOCK_EXPIRED: Seat A1 lock expired' },
    });

    const { status, body } = await submitPayment(port);

    expect(status).toBe(409);
    expect(body.error.code).toBe('PAYMENT_LOCK_EXPIRED');
    expect(body.error.message).not.toContain('Seat A1');
    expect(body.error.message).not.toContain('ERR_PAYMENT');
    expect(harness.storage.uploads).toHaveLength(1);
    // La limpieza segura corre: ningún pago referencia el objeto.
    expect(harness.storage.removes).toHaveLength(1);
    expect(harness.storage.removes[0]).toEqual([
      harness.storage.uploads[0].path,
    ]);
  });

  it('mapea un error inesperado del RPC a error interno', async () => {
    harness.pushRpc(RPC, {
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const { status, body } = await submitPayment(port);

    expect(status).toBe(500);
    expect(body.error.code).toBe('PAYMENT_SUBMIT_ERROR');
    expect(body.error.message).not.toContain('connection terminated');
    expect(harness.storage.removes).toHaveLength(1);
  });

  it('propaga todos los códigos de negocio del RPC 083', async () => {
    const cases = [
      ['ERR_PAYMENT_ALREADY_SUBMITTED', 409, 'PAYMENT_ALREADY_SUBMITTED'],
      ['ERR_PAYMENT_IDEMPOTENCY_CONFLICT', 409, 'PAYMENT_IDEMPOTENCY_CONFLICT'],
      ['ERR_PAYMENT_RESERVATION_CLOSED', 409, 'PAYMENT_RESERVATION_CLOSED'],
      ['ERR_PAYMENT_RESERVATION_NOT_FOUND', 404, 'PAYMENT_RESERVATION_NOT_FOUND'],
      ['ERR_PAYMENT_NOT_OWNER', 404, 'PAYMENT_RESERVATION_NOT_FOUND'],
      ['ERR_PAYMENT_AMOUNT_INVALID', 422, 'PAYMENT_AMOUNT_INVALID'],
      ['ERR_PAYMENT_INPUT', 400, 'PAYMENT_INPUT_INVALID'],
    ] as const;

    for (const [rpcCode, expectedStatus, expectedCode] of cases) {
      harness.reset();
      givenAuthAs(CUSTOMER_ID);
      harness.setDefault('users', {
        data: { id: CUSTOMER_ID, role: 'customer', agency_id: null },
        error: null,
      });
      harness.setDefault('reservations', {
        data: reservationRow(),
        error: null,
      });
      harness.pushRpc(RPC, {
        data: null,
        error: { message: `${rpcCode}: detalle interno` },
      });

      const { status, body } = await submitPayment(port);
      expect(status).toBe(expectedStatus);
      expect(body.error.code).toBe(expectedCode);
      expect(body.error.message).not.toContain('detalle interno');
      // El objeto subido se limpia cuando ningún pago lo referencia.
      expect(harness.storage.removes).toHaveLength(1);
    }
  });

  it('conserva el objeto cuando un pago existente lo referencia', async () => {
    harness.pushRpc(RPC, {
      data: null,
      error: { message: 'ERR_PAYMENT_ALREADY_SUBMITTED: Reservation is in status reserved' },
    });
    harness.push('payments', { data: { id: 'existing-payment' }, error: null });

    const { status, body } = await submitPayment(port);

    expect(status).toBe(409);
    expect(body.error.code).toBe('PAYMENT_ALREADY_SUBMITTED');
    // Jamás se elimina un objeto que un pago confirmado podría necesitar.
    expect(harness.storage.removes).toHaveLength(0);
  });

  it('conserva el objeto y registra el fallo si la verificación de limpieza falla', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.pushRpc(RPC, {
      data: null,
      error: { message: 'ERR_PAYMENT_LOCK_EXPIRED: Seat A1 lock expired' },
    });
    harness.push('payments', { data: null, error: { message: 'read timeout' } });

    const { status, body } = await submitPayment(port);

    expect(status).toBe(409);
    expect(body.error.code).toBe('PAYMENT_LOCK_EXPIRED');
    expect(harness.storage.removes).toHaveLength(0);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('no enmascara el error original si la limpieza del storage falla', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.pushRpc(RPC, {
      data: null,
      error: { message: 'ERR_PAYMENT_LOCK_EXPIRED: Seat A1 lock expired' },
    });
    harness.storage.setRemoveError({ message: 'remove failed' });

    const { status, body } = await submitPayment(port);

    expect(status).toBe(409);
    expect(body.error.code).toBe('PAYMENT_LOCK_EXPIRED');
    expect(harness.storage.removes).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('un reintento con la misma clave devuelve el pago existente (idempotente)', async () => {
    harness.pushRpc(RPC, submittedRpcResult({ idempotent: false }));
    harness.pushRpc(RPC, submittedRpcResult({ idempotent: true }));
    const data = pngBytes();

    const first = await submitPayment(port, { parts: [proofPart({ data })] });
    expect(first.status).toBe(201);
    expect(first.body.idempotent).toBe(false);

    const second = await submitPayment(port, {
      parts: [proofPart({ data })],
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.payment_id).toBe(PAYMENT_ID);
    expect(second.body.reservation_id).toBe(RESERVATION_ID);

    expect(harness.rpcCalls()).toHaveLength(2);
    expect(harness.rpcCalls()[0].args).toEqual(harness.rpcCalls()[1].args);
    // Mismo contenido → misma ruta determinista (upsert del mismo objeto).
    expect(harness.storage.uploads).toHaveLength(2);
    expect(harness.storage.uploads[0].path).toBe(harness.storage.uploads[1].path);
    // La dedupe vive en el RPC: la app nunca inserta pagos por su cuenta.
    expect(writeCalls('payments')).toHaveLength(0);
  });

  it('las garantías de atomicidad viven en el RPC 083, no en estas pruebas', () => {
    // Suite unitaria con mocks: no abre PostgreSQL ni ejecute transacciones.
    expect(RPC).toBe('submit_marketplace_payment');
    expect(harness.rpcCalls()).toHaveLength(0);
    expect(harness.storage.uploads).toHaveLength(0);
  });
});
