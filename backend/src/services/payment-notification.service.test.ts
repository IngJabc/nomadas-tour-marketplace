/**
 * PAY-NOTIFICATIONS Task 3 — tests del adaptador de notificaciones de pago.
 *
 * Cubre:
 *   - inserción exitosa con todos los campos requeridos;
 *   - copy específico ("Pago recibido" + booker + ruta) y sus fallbacks;
 *   - ausencia de datos sensibles (rutas de prueba, URLs firmadas,
 *     montos, referencias, credenciales);
 *   - contexto de agencia inválido o ausente → ValidationError SIN insertar;
 *   - entity: reservation solo con ID real; fallback trip; sin IDs
 *     inventados;
 *   - duplicados vía source_event_id (23505) → éxito idempotente;
 *   - errores de base de datos → InternalError + log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalError, ValidationError } from '../errors/index.js';

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

// ── Mock de supabaseAdmin: chains thenables encolables ───────────────────────
const harness = vi.hoisted(() => {
  type QueryResult = { data?: any; error?: { message: string; code?: string } | null };

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    chainCalls: Array<{ table: string; method: string; args: any[] }>;
  } = {
    queues: {},
    defaults: {},
    chainCalls: [],
  };

  function buildChain(table: string) {
    const chain: Record<string, any> = {};
    for (const method of ['select', 'insert', 'eq', 'maybeSingle']) {
      chain[method] = (...args: any[]) => {
        state.chainCalls.push({ table, method, args });
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
      state.queues = {};
      state.defaults = {};
      state.chainCalls = [];
    },
    chainCalls: () => state.chainCalls,
    from: (table: string) => buildChain(table),
    rpc: () => {
      throw new Error('rpc no esperado en payment-notification');
    },
  };
});

vi.mock('../config/database.js', () => ({
  supabase: { auth: { getUser: vi.fn() } },
  supabaseAdmin: {
    from: (table: string) => harness.from(table),
    rpc: () => harness.rpc(),
  },
}));

import {
  PAYMENT_RECEIPT_SUBMITTED,
  notifyPaymentReceiptSubmitted,
} from './payment-notification.service.js';

const AGENCY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RESERVATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EVENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function insertCall() {
  const call = harness
    .chainCalls()
    .find((c) => c.table === 'notifications' && c.method === 'insert');
  if (!call) throw new Error('No se registró ningún insert en notifications');
  return call.args[0];
}

function insertCalls() {
  return harness
    .chainCalls()
    .filter((c) => c.table === 'notifications' && c.method === 'insert');
}

beforeEach(() => {
  harness.reset();
  harness.setDefault('notifications', { data: null, error: null });
});

describe('notifyPaymentReceiptSubmitted — inserción exitosa', () => {
  it('inserta con recipient_role=agency y entity reservation cuando hay reservation_id real', async () => {
    harness.push('notifications', { data: null, error: null });

    const result = await notifyPaymentReceiptSubmitted({
      agencyId: AGENCY_ID,
      attemptId: ATTEMPT_ID,
      reservationId: RESERVATION_ID,
      tripId: TRIP_ID,
      sourceEventId: EVENT_ID,
    });

    expect(result).toEqual({ status: 'inserted' });

    const row = insertCall();
    expect(row.type).toBe(PAYMENT_RECEIPT_SUBMITTED);
    expect(row.recipient_role).toBe('agency');
    expect(row.agency_id).toBe(AGENCY_ID);
    expect(row.entity_type).toBe('reservation');
    expect(row.entity_id).toBe(RESERVATION_ID);
    expect(row.action_url).toBe(`/agency/payments/attempts/${ATTEMPT_ID}`);
    expect(row.source_event_id).toBe(EVENT_ID);
    expect(row.metadata).toEqual({ attempt_id: ATTEMPT_ID });
  });

  it('campos requeridos: título y body útiles y no vacíos', async () => {
    await notifyPaymentReceiptSubmitted({
      agencyId: AGENCY_ID,
      attemptId: ATTEMPT_ID,
      tripId: TRIP_ID,
    });

    const row = insertCall();
    expect(row.title).toBe('Pago recibido');
    expect(typeof row.body).toBe('string');
    expect(row.body.trim().length).toBeGreaterThan(0);
    expect(row.body).toContain('envió su pago');
  });

  it('copy específico: "Pago recibido" + "<booker> envió su pago para el viaje <ruta>"', async () => {
    await notifyPaymentReceiptSubmitted({
      agencyId: AGENCY_ID,
      attemptId: ATTEMPT_ID,
      tripId: TRIP_ID,
      bookerName: 'Ana López',
      tripLabel: 'Maracaibo → Caracas',
    });

    const row = insertCall();
    expect(row.title).toBe('Pago recibido');
    expect(row.body).toBe(
      'Ana López envió su pago para el viaje Maracaibo → Caracas',
    );
  });

  it('fallback sin booker: el cuerpo usa un sujeto genérico sin perder el copy', async () => {
    await notifyPaymentReceiptSubmitted({
      agencyId: AGENCY_ID,
      attemptId: ATTEMPT_ID,
      tripId: TRIP_ID,
      bookerName: '   ',
      tripLabel: 'Maracaibo → Caracas',
    });

    const row = insertCall();
    expect(row.title).toBe('Pago recibido');
    expect(row.body).toBe(
      'Un cliente envió su pago para el viaje Maracaibo → Caracas',
    );
  });

  it('fallback sin ruta: el nombre se conserva y solo degrada el destino del viaje', async () => {
    await notifyPaymentReceiptSubmitted({
      agencyId: AGENCY_ID,
      attemptId: ATTEMPT_ID,
      tripId: TRIP_ID,
      bookerName: 'Ana López',
      tripLabel: null,
    });

    const row = insertCall();
    expect(row.title).toBe('Pago recibido');
    expect(row.body).toBe('Ana López envió su pago, pendiente de revisión');
  });

  it('action_url es una ruta interna segura: relativa, sin host, tokens ni query', async () => {
    await notifyPaymentReceiptSubmitted({
      agencyId: AGENCY_ID,
      attemptId: ATTEMPT_ID,
      tripId: TRIP_ID,
    });

    const row = insertCall();
    expect(row.action_url.startsWith('/agency/payments/attempts/')).toBe(true);
    expect(row.action_url).not.toMatch(/^https?:/i);
    expect(row.action_url).not.toContain('?');
    expect(row.action_url).not.toContain('#');
    expect(row.action_url).not.toMatch(/token|signature|X-Amz/i);
  });

  it('no incluye rutas de prueba, URLs firmadas ni datos sensibles de pago', async () => {
    await notifyPaymentReceiptSubmitted({
      agencyId: AGENCY_ID,
      attemptId: ATTEMPT_ID,
      tripId: TRIP_ID,
    });

    const row = insertCall();
    const forbidden = [
      'proof_path',
      'proof_url',
      'signed_url',
      'url',
      'token',
      'password',
      'secret',
      'payment_reference',
      'bank_origin',
      'amount_cents',
      'customer_id',
    ];
    for (const key of forbidden) {
      expect(row).not.toHaveProperty(key);
    }
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('http');
    expect(serialized).not.toMatch(/payment-proofs|X-Amz|Bearer/i);
  });
});

describe('notifyPaymentReceiptSubmitted — entity sin IDs inventados', () => {
  it('usa entity_type=trip cuando no hay reservation_id (fallback schema-compatible)', async () => {
    await notifyPaymentReceiptSubmitted({
      agencyId: AGENCY_ID,
      attemptId: ATTEMPT_ID,
      tripId: TRIP_ID,
    });

    const row = insertCall();
    expect(row.entity_type).toBe('trip');
    expect(row.entity_id).toBe(TRIP_ID);
    expect(row.entity_id).not.toBe(ATTEMPT_ID);
  });

  it('falla sin insertar si no hay reservation_id ni trip_id', async () => {
    await expect(
      notifyPaymentReceiptSubmitted({
        agencyId: AGENCY_ID,
        attemptId: ATTEMPT_ID,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(insertCalls()).toHaveLength(0);
  });

  it('rechaza un reservation_id que no sea UUID (no se etiqueta nada inventado)', async () => {
    await expect(
      notifyPaymentReceiptSubmitted({
        agencyId: AGENCY_ID,
        attemptId: ATTEMPT_ID,
        reservationId: 'no-es-uuid',
        tripId: TRIP_ID,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(insertCalls()).toHaveLength(0);
  });
});

describe('notifyPaymentReceiptSubmitted — contexto de agencia', () => {
  it('rechaza agency_id ausente sin tocar la base', async () => {
    await expect(
      notifyPaymentReceiptSubmitted({
        agencyId: undefined as unknown as string,
        attemptId: ATTEMPT_ID,
        tripId: TRIP_ID,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(insertCalls()).toHaveLength(0);
  });

  it('rechaza agency_id que no sea UUID sin tocar la base', async () => {
    await expect(
      notifyPaymentReceiptSubmitted({
        agencyId: 'agencia-1',
        attemptId: ATTEMPT_ID,
        tripId: TRIP_ID,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(insertCalls()).toHaveLength(0);
  });

  it('rechaza attempt_id inválido (la action_url no puede apuntar a algo inventado)', async () => {
    await expect(
      notifyPaymentReceiptSubmitted({
        agencyId: AGENCY_ID,
        attemptId: 'not-a-uuid',
        tripId: TRIP_ID,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(insertCalls()).toHaveLength(0);
  });

  it('rechaza source_event_id inválido', async () => {
    await expect(
      notifyPaymentReceiptSubmitted({
        agencyId: AGENCY_ID,
        attemptId: ATTEMPT_ID,
        tripId: TRIP_ID,
        sourceEventId: 'evento-1',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(insertCalls()).toHaveLength(0);
  });
});

describe('notifyPaymentReceiptSubmitted — duplicados y errores de BD', () => {
  it('23505 (índice único source_event_id+agency+role) → duplicate, sin lanzar', async () => {
    harness.push('notifications', {
      data: null,
      error: { message: 'duplicate key value violates unique constraint', code: '23505' },
    });

    const result = await notifyPaymentReceiptSubmitted({
      agencyId: AGENCY_ID,
      attemptId: ATTEMPT_ID,
      tripId: TRIP_ID,
      sourceEventId: EVENT_ID,
    });

    expect(result).toEqual({ status: 'duplicate' });
  });

  it('reintento idempotente: un segundo intento con el mismo evento también deduplica', async () => {
    harness.push('notifications', { data: null, error: null });
    harness.push('notifications', {
      data: null,
      error: { message: 'duplicate key', code: '23505' },
    });

    const input = {
      agencyId: AGENCY_ID,
      attemptId: ATTEMPT_ID,
      tripId: TRIP_ID,
      sourceEventId: EVENT_ID,
    };

    expect(await notifyPaymentReceiptSubmitted(input)).toEqual({ status: 'inserted' });
    expect(await notifyPaymentReceiptSubmitted(input)).toEqual({ status: 'duplicate' });
    expect(insertCalls()).toHaveLength(2);
  });

  it('error de base de datos distinto de 23505 → InternalError con diagnóstico', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.push('notifications', {
      data: null,
      error: { message: 'connection reset', code: '57P01' },
    });

    let caught: InternalError | null = null;
    try {
      await notifyPaymentReceiptSubmitted({
        agencyId: AGENCY_ID,
        attemptId: ATTEMPT_ID,
        tripId: TRIP_ID,
      });
    } catch (error) {
      caught = error as InternalError;
    }

    expect(caught).toBeInstanceOf(InternalError);
    expect(caught!.code).toBe('PAYMENT_NOTIFICATION_INSERT_ERROR');
    expect(caught!.internalMessage).toBe('connection reset');
    expect(errorSpy).toHaveBeenCalledWith(
      '[PaymentNotification] insert falló',
      expect.objectContaining({ type: PAYMENT_RECEIPT_SUBMITTED, attemptId: ATTEMPT_ID }),
    );
    errorSpy.mockRestore();
  });
});
