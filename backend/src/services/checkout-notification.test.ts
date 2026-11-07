/**
 * PAY-NOTIFICATIONS Task 4 — conexión submitCheckoutProof → notificación
 * `payment_receipt_submitted` hacia la agencia.
 *
 * Cubre:
 *   - envío exitoso → se crea la notificación con contexto de confianza;
 *   - fallo del RPC → SIN notificación;
 *   - contexto de agencia/intento ausente o inválido → seguro (sin
 *     notificación, con log, sin romper el envío);
 *   - reintentos con el mismo Idempotency-Key → source_event_id idéntico
 *     (dedupe) y envíos separados → eventos distintos;
 *   - fallo de BD de la notificación → el checkout exitoso no falla.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.CORS_ORIGIN = 'http://localhost:3002';
  process.env.RESEND_API_KEY = 'test';
  process.env.EMAIL_FROM = 'test@example.com';
  process.env.FRONTEND_URL = 'http://localhost:3002';
});

// ── Mock de supabaseAdmin: chains thenables + rpc + storage ──────────────────
const harness = vi.hoisted(() => {
  type QueryResult = {
    data?: any;
    error?: { message: string; code?: string } | null;
  };
  type ChainRecord = {
    table: string;
    calls: Array<{ method: string; args: any[] }>;
  };

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    chains: ChainRecord[];
    rpcQueues: Record<string, QueryResult[]>;
    rpcDefaults: Record<string, QueryResult>;
    rpcCalls: Array<{ fn: string; args: any }>;
    uploads: Array<{ bucket: string; path: string; size: number }>;
    removes: string[][];
  } = {
    queues: {},
    defaults: {},
    chains: [],
    rpcQueues: {},
    rpcDefaults: {},
    rpcCalls: [],
    uploads: [],
    removes: [],
  };

  function buildChain(table: string) {
    const record: ChainRecord = { table, calls: [] };
    state.chains.push(record);
    const chain: Record<string, any> = {};
    for (const method of [
      'select',
      'insert',
      'update',
      'eq',
      'in',
      'is',
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
    reset() {
      state.queues = {};
      state.defaults = {};
      state.chains = [];
      state.rpcQueues = {};
      state.rpcDefaults = {};
      state.rpcCalls = [];
      state.uploads = [];
      state.removes = [];
    },
    chains: () => state.chains,
    rpcCalls: () => state.rpcCalls,
    uploads: () => state.uploads,
    removes: () => state.removes,
    from: (table: string) => buildChain(table),
    rpc: (fn: string, args: any) => buildRpc(fn, args),
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, body: any) => {
            state.uploads.push({
              bucket,
              path,
              size: Buffer.isBuffer(body) ? body.length : 0,
            });
            return { data: { path }, error: null };
          },
          remove: async (paths: string[]) => {
            state.removes.push(paths);
            return { data: null, error: null };
          },
        };
      },
    },
  };
});

vi.mock('../config/database.js', () => ({
  supabase: { auth: { getUser: vi.fn() } },
  supabaseAdmin: {
    from: (table: string) => harness.from(table),
    rpc: (fn: string, args: any) => harness.rpc(fn, args),
    storage: harness.storage,
  },
}));

import { submitCheckoutProof, type ParsedCheckoutProof } from './checkout.service.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const AGENCY_ID = '5bf0be5d-c03a-431f-97d5-e2a065e25752';
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const ATTEMPT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const KEY_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const KEY_B = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const RPC_PROOF = 'submit_checkout_proof';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(48, 0x41),
  ]);
}

function proof(): ParsedCheckoutProof {
  return {
    buffer: pngBytes(),
    mimeType: 'image/png',
    fields: {
      payment_reference: '00123456789',
      bank_origin: 'Banco de Venezuela',
      payment_datetime: '2020-01-01T10:00:00.000Z',
    },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT_ID,
    customerId: CUSTOMER_ID,
    idempotencyKey: KEY_A,
    proof: proof(),
    ...overrides,
  };
}

/** Fila del pre-chequeo (dueño + estado + ventana + canal elegido). */
function readyAttemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    customer_id: CUSTOMER_ID,
    agency_id: AGENCY_ID,
    status: 'created',
    proof_count: 0,
    expires_at: '2099-01-01T00:00:00.000Z',
    payment_method_id: 'pm-1',
    payment_method_snapshot: null,
    ...overrides,
  };
}

/** Fila re-leída post-RPC para el contexto de propiedad de la notificación. */
function ownershipRow(overrides: Record<string, unknown> = {}) {
  return {
    agency_id: AGENCY_ID,
    trip_id: TRIP_ID,
    // Snapshot del libro: solo el NOMBRE del primer pasajero (booker)
    // viaja al copy de la notificación; documento/teléfono jamás.
    passenger_data: [
      {
        seat_id: '99999999-9999-4999-8999-999999999999',
        first_name: 'Ana',
        last_name: 'López',
        document: 'V-12345678',
        phone: '04241234567',
      },
    ],
    ...overrides,
  };
}

function rpcProofResult(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      attempt_id: ATTEMPT_ID,
      status: 'pending_review',
      proof_count: 1,
      remaining_submissions: 2,
      proof_path: `${ATTEMPT_ID}/digest.png`,
      payment_reference: '00123456789',
      bank_origin: 'Banco de Venezuela',
      payment_datetime: '2020-01-01T10:00:00.000Z',
      amount_cents: 4040,
      expires_at: '2099-01-02T00:00:00.000Z',
      idempotent: false,
      ...overrides,
    },
    error: null,
  };
}

/** Prepara el camino feliz: pre-chequeo + RPC + relectura de contexto. */
function givenSuccessfulSubmission() {
  harness.push('checkout_attempts', { data: readyAttemptRow(), error: null });
  harness.pushRpc(RPC_PROOF, rpcProofResult());
  harness.push('checkout_attempts', { data: ownershipRow(), error: null });
  // Ruta del viaje para el copy específico de la notificación.
  harness.push('trips', {
    data: { routes: { origin: 'Maracaibo', destination: 'Caracas' } },
    error: null,
  });
}

function notificationInserts() {
  return harness
    .chains()
    .filter((chain) => chain.table === 'notifications')
    .flatMap((chain) =>
      chain.calls
        .filter((call) => call.method === 'insert')
        .map((call) => call.args[0]),
    );
}

function ownershipReads() {
  return harness
    .chains()
    .filter(
      (chain) =>
        chain.table === 'checkout_attempts' &&
        chain.calls.some(
          (call) =>
            call.method === 'select' &&
            String(call.args[0]).includes('agency_id') &&
            String(call.args[0]).includes('trip_id'),
        ),
    );
}

beforeEach(() => {
  harness.reset();
  harness.setDefault('notifications', { data: null, error: null });
});

describe('submitCheckoutProof → notificación a la agencia (Task 4)', () => {
  it('envío exitoso: crea la notificación con contexto server-side confiable', async () => {
    givenSuccessfulSubmission();

    const result = await submitCheckoutProof(input());

    // Contrato de respuesta intacto (payload del RPC tal cual).
    expect(result.attempt_id).toBe(ATTEMPT_ID);
    expect(result.status).toBe('pending_review');
    expect(result.remaining_submissions).toBe(2);
    expect(result.idempotent).toBe(false);

    // Argumentos del RPC sin cambios.
    const rpcCall = harness.rpcCalls().find((call) => call.fn === RPC_PROOF)!;
    expect(rpcCall.args.p_attempt_id).toBe(ATTEMPT_ID);
    expect(rpcCall.args.p_customer_id).toBe(CUSTOMER_ID);
    expect(rpcCall.args.p_idempotency_key).toBe(KEY_A);

    // La notificación se resuelve con una relectura del intento (no con
    // datos del request).
    const reads = ownershipReads();
    expect(reads).toHaveLength(1);
    expect(reads[0].calls.find((c) => c.method === 'eq')!.args).toEqual([
      'id',
      ATTEMPT_ID,
    ]);

    const inserts = notificationInserts();
    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row.type).toBe('payment_receipt_submitted');
    expect(row.recipient_role).toBe('agency');
    expect(row.agency_id).toBe(AGENCY_ID);
    expect(row.entity_type).toBe('trip');
    expect(row.entity_id).toBe(TRIP_ID);
    expect(row.action_url).toBe(`/agency/payments/attempts/${ATTEMPT_ID}`);
    expect(row.source_event_id).toMatch(UUID_RE);
    // Copy específico resuelto server-side: booker (1er pasajero) + ruta
    // del viaje, nunca el texto genérico anterior.
    expect(row.title).toBe('Pago recibido');
    expect(row.body).toBe(
      'Ana López envió su pago para el viaje Maracaibo → Caracas',
    );
    // Del snapshot solo viaja el NOMBRE: documento/teléfono jamás.
    expect(JSON.stringify(row)).not.toContain('V-12345678');
    expect(JSON.stringify(row)).not.toContain('04241234567');
    // Nunca datos sensibles del comprobante o del pago.
    expect(row).not.toHaveProperty('proof_path');
    expect(row).not.toHaveProperty('payment_reference');
    expect(row).not.toHaveProperty('bank_origin');
    expect(row).not.toHaveProperty('customer_id');
    expect(JSON.stringify(row)).not.toContain('digest');
  });

  it('fallo del RPC: no emite ninguna notificación', async () => {
    harness.push('checkout_attempts', { data: readyAttemptRow(), error: null });
    harness.pushRpc(RPC_PROOF, {
      data: null,
      error: { message: 'ERR_CHECKOUT_LOCK_EXPIRED: Seat A1 lock expired' },
    });

    await expect(submitCheckoutProof(input())).rejects.toMatchObject({
      statusCode: 409,
    });

    expect(notificationInserts()).toHaveLength(0);
    expect(harness.uploads()).toHaveLength(1);
    // La limpieza condicionada del objeto subido sigue intacta.
    expect(harness.removes()).toHaveLength(1);
  });

  it('contexto de agencia ausente: el envío exitoso no falla y no inserta', async () => {
    harness.push('checkout_attempts', { data: readyAttemptRow(), error: null });
    harness.pushRpc(RPC_PROOF, rpcProofResult());
    harness.push('checkout_attempts', { data: null, error: null });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await submitCheckoutProof(input());

    expect(result.attempt_id).toBe(ATTEMPT_ID);
    expect(notificationInserts()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      '[checkout] notificación de comprobante no emitida',
      expect.objectContaining({ attemptId: ATTEMPT_ID }),
    );
    errorSpy.mockRestore();
  });

  it('contexto de agencia inválido (agency_id NULL): seguro, con log y sin notificación', async () => {
    harness.push('checkout_attempts', { data: readyAttemptRow(), error: null });
    harness.pushRpc(RPC_PROOF, rpcProofResult());
    harness.push('checkout_attempts', {
      data: ownershipRow({ agency_id: null }),
      error: null,
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await submitCheckoutProof(input());

    expect(result.status).toBe('pending_review');
    expect(notificationInserts()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      '[checkout] notificación de comprobante no emitida',
      expect.objectContaining({ attemptId: ATTEMPT_ID }),
    );
    errorSpy.mockRestore();
  });

  it('reintento del MISMO envío: source_event_id idéntico y sin filas dobles (23505)', async () => {
    // Primer envío: inserta.
    givenSuccessfulSubmission();
    const first = await submitCheckoutProof(input());

    // Reintento con la misma Idempotency-Key: mismo evento → el índice
    // único devuelve 23505 y el adaptador lo trata como duplicado.
    harness.push('notifications', {
      data: null,
      error: { message: 'duplicate key value violates unique constraint', code: '23505' },
    });
    givenSuccessfulSubmission();
    const second = await submitCheckoutProof(input());

    expect(first.attempt_id).toBe(ATTEMPT_ID);
    expect(second.attempt_id).toBe(ATTEMPT_ID);

    const inserts = notificationInserts();
    expect(inserts).toHaveLength(2);
    expect(inserts[0].source_event_id).toMatch(UUID_RE);
    expect(inserts[1].source_event_id).toBe(inserts[0].source_event_id);
  });

  it('envíos SEPARADOS (Idempotency-Key distinta): eventos distintos → notificaciones separadas', async () => {
    givenSuccessfulSubmission();
    givenSuccessfulSubmission();

    await submitCheckoutProof(input({ idempotencyKey: KEY_A }));
    await submitCheckoutProof(input({ idempotencyKey: KEY_B }));

    const inserts = notificationInserts();
    expect(inserts).toHaveLength(2);
    expect(inserts[0].source_event_id).not.toBe(inserts[1].source_event_id);
  });

  it('fallo de BD de la notificación: el checkout exitoso sigue respondiendo', async () => {
    givenSuccessfulSubmission();
    harness.push('notifications', {
      data: null,
      error: { message: 'connection reset', code: '57P01' },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await submitCheckoutProof(input());

    expect(result.attempt_id).toBe(ATTEMPT_ID);
    expect(result.status).toBe('pending_review');
    expect(errorSpy).toHaveBeenCalledWith(
      '[checkout] notificación de comprobante no emitida',
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        error: expect.stringContaining('connection reset'),
      }),
    );
    errorSpy.mockRestore();
  });
});
