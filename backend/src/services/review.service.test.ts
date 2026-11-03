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

// ── Mock de supabaseAdmin: chains thenables + rpc encolables ──────────────────
const harness = vi.hoisted(() => {
  type QueryResult = { data?: any; error?: { message: string } | null };

  const state: {
    queues: Record<string, QueryResult[]>;
    defaults: Record<string, QueryResult>;
    rpcQueues: Record<string, QueryResult[]>;
    rpcDefaults: Record<string, QueryResult>;
    rpcCalls: Array<{ fn: string; args: any }>;
    chainCalls: Array<{ table: string; method: string; args: any[] }>;
  } = {
    queues: {},
    defaults: {},
    rpcQueues: {},
    rpcDefaults: {},
    rpcCalls: [],
    chainCalls: [],
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
      state.chainCalls = [];
    },
    rpcCalls: () => state.rpcCalls,
    chainCalls: () => state.chainCalls,
    from: (table: string) => buildChain(table),
    rpc: (fn: string, args: any) => buildRpc(fn, args),
  };
});

vi.mock('../config/database.js', () => ({
  supabase: { auth: { getUser: vi.fn() } },
  supabaseAdmin: {
    from: (table: string) => harness.from(table),
    rpc: (fn: string, args: any) => harness.rpc(fn, args),
  },
}));

import {
  REVIEW_WINDOW_HOURS,
  getReviewContext,
  listCustomerReviews,
  markNotificationRead,
  runReviewReconciliation,
  submitReviews,
  adminListReviews,
  adminModerateReview,
} from './review.service.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const TRIP_ID = '441559e6-ea35-4453-aae1-5ed0844289b3';
const ROUTE_ID = '551559e6-ea35-4453-aae1-5ed0844289b4';
const AGENCY_ID = '5bf0be5d-c03a-431f-97d5-e2a065e25752';
const RESERVATION_ID = 'ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d';

/** 2026-01-10 10:00Z: el viaje finalizó hace 2 h (ventana de 48 h viva). */
const COMPLETED_RECENTLY = '2026-01-10T10:00:00.000Z';
/** Finalizó hace 3 días: la ventana de 48 h ya venció. */
const COMPLETED_LONG_AGO = '2026-01-07T10:00:00.000Z';

/** Fijar el reloj: Date.now() controla la ventana de 48 h en el servicio. */
function freezeClock(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

function reservationRow(overrides: Record<string, any> = {}) {
  return {
    id: RESERVATION_ID,
    trip_id: TRIP_ID,
    agency_id: AGENCY_ID,
    status: 'reserved',
    created_at: '2026-01-02T10:00:00.000Z',
    ...overrides,
  };
}

function tripRow(overrides: Record<string, any> = {}) {
  return {
    id: TRIP_ID,
    route_id: ROUTE_ID,
    status: 'completed',
    departure_time: '2026-01-10T06:00:00.000Z',
    completed_at: COMPLETED_RECENTLY,
    ...overrides,
  };
}

function routeRow() {
  return { id: ROUTE_ID, origin: 'Maracaibo', destination: 'Mérida' };
}

function agencyRow() {
  return { id: AGENCY_ID, name: 'Agencia Central' };
}

/** Empuja el dataset completo que consume loadCustomerReviewData. */
function givenCustomerData(
  overrides: {
    reservations?: any[];
    trip?: any;
    tripReviews?: any[];
    agencyReviews?: any[];
  } = {},
) {
  harness.push('reservations', {
    data: overrides.reservations ?? [reservationRow()],
    error: null,
  });
  harness.push('trips', { data: [overrides.trip ?? tripRow()], error: null });
  harness.push('agencies', { data: [agencyRow()], error: null });
  harness.push('trip_reviews', { data: overrides.tripReviews ?? [], error: null });
  harness.push('agency_reviews', {
    data: overrides.agencyReviews ?? [],
    error: null,
  });
  harness.push('routes', { data: [routeRow()], error: null });
}

beforeEach(() => {
  harness.reset();
  vi.useRealTimers();
});

// ── 1) Lista de reseñas: estados derivados ────────────────────────────────────

describe('listCustomerReviews — estados derivados (REV-001)', () => {
  it('deriva pending cuando el viaje está completado dentro de la ventana', async () => {
    freezeClock('2026-01-11T00:00:00.000Z'); // 14 h tras completion
    givenCustomerData();

    const { items } = await listCustomerReviews(CUSTOMER_ID);

    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('pending');
    expect(items[0].window_expired).toBe(false);
    // expires_at = completed_at + 48 h (por defecto REVIEW_WINDOW_HOURS).
    expect(REVIEW_WINDOW_HOURS).toBe(48);
    expect(items[0].expires_at).toBe('2026-01-12T10:00:00.000Z');
  });

  it('deriva expired cuando la ventana (completed_at + 48 h) ya pasó', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    givenCustomerData({ trip: tripRow({ completed_at: COMPLETED_LONG_AGO }) });

    const { items } = await listCustomerReviews(CUSTOMER_ID);

    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('expired');
    expect(items[0].window_expired).toBe(true);
  });

  it('deriva submitted cuando ya existen reseñas (incluso con ventana vencida)', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    givenCustomerData({
      trip: tripRow({ completed_at: COMPLETED_LONG_AGO }),
      tripReviews: [
        {
          id: 'tr-1',
          reservation_id: RESERVATION_ID,
          rating: 5,
          comment: null,
          moderation_status: 'visible',
          created_at: '2026-01-10T12:00:00.000Z',
        },
      ],
      agencyReviews: [
        {
          id: 'ar-1',
          reservation_id: RESERVATION_ID,
          rating: 4,
          comment: 'Bien',
          moderation_status: 'visible',
          created_at: '2026-01-10T12:00:00.000Z',
        },
      ],
    });

    const { items } = await listCustomerReviews(CUSTOMER_ID);

    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('submitted');
    expect(items[0].trip_review?.rating).toBe(5);
    expect(items[0].agency_review?.rating).toBe(4);
  });

  it('excluye las reservas cuyo viaje aún no está completado', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    givenCustomerData({ trip: tripRow({ status: 'active', completed_at: null }) });

    const { items } = await listCustomerReviews(CUSTOMER_ID);

    // Sin viaje completado no hay invitación: la compra vive en Mis compras.
    expect(items).toHaveLength(0);
  });

  it('la consulta filtra SIEMPRE por customer_id del servidor y source=marketplace', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    givenCustomerData();

    await listCustomerReviews(CUSTOMER_ID);

    const reservationEqCalls = harness
      .chainCalls()
      .filter((c) => c.table === 'reservations' && c.method === 'eq')
      .map((c) => c.args);
    expect(reservationEqCalls).toEqual(
      expect.arrayContaining([
        ['customer_id', CUSTOMER_ID],
        ['source', 'marketplace'],
      ]),
    );
  });

  it('excluye reservas locked/cancelled sin reseñas (la RPC 099 las negaría)', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    givenCustomerData({ reservations: [reservationRow({ status: 'cancelled' })] });

    const { items } = await listCustomerReviews(CUSTOMER_ID);

    // No se promete un CTA "Calificar" que el backend rechazaría.
    expect(items).toHaveLength(0);
  });

  it('excluye viajes completed SIN completed_at (sin ventana posible)', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    givenCustomerData({ trip: tripRow({ completed_at: null }) });

    const { items } = await listCustomerReviews(CUSTOMER_ID);

    // 099 rechaza esto con NO_COMPLETION_TIMESTAMP: nunca reseñable.
    expect(items).toHaveLength(0);
  });

  it('muestra como submitted una reserva ya reseñada aunque luego quedó locked', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    givenCustomerData({
      reservations: [reservationRow({ status: 'locked' })],
      tripReviews: [
        {
          id: 'tr-1',
          reservation_id: RESERVATION_ID,
          rating: 5,
          comment: null,
          moderation_status: 'visible',
          created_at: '2026-01-10T12:00:00.000Z',
        },
      ],
    });

    const { items } = await listCustomerReviews(CUSTOMER_ID);

    // Lo enviado es irreversible: se sigue mostrando el historial.
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('submitted');
  });

  it('propaga un error de base de datos como REVIEW_ERROR 500', async () => {
    harness.push('reservations', { data: null, error: { message: 'boom' } });

    await expect(listCustomerReviews(CUSTOMER_ID)).rejects.toMatchObject({
      code: 'REVIEW_ERROR',
      statusCode: 500,
    });
  });
});

// ── 2) Contexto del formulario: elegibilidad del servidor ─────────────────────

describe('getReviewContext — elegibilidad revalidada en el servidor', () => {
  it('marca eligible=true para una reserva pendiente dentro de la ventana', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    // 1ª reserva: contexto (maybeSingle); 2ª: la lista de loadCustomerReviewData.
    harness.push('reservations', { data: reservationRow(), error: null });
    givenCustomerData();

    const context = await getReviewContext({
      reservationId: RESERVATION_ID,
      customerId: CUSTOMER_ID,
    });

    expect(context.eligible).toBe(true);
    expect(context.state).toBe('pending');
    expect(context.reason).toBeNull();
  });

  it('marca eligible=false cuando el viaje no está completado', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    harness.push('reservations', { data: reservationRow(), error: null });
    givenCustomerData({ trip: tripRow({ status: 'active', completed_at: null }) });

    const context = await getReviewContext({
      reservationId: RESERVATION_ID,
      customerId: CUSTOMER_ID,
    });

    expect(context.eligible).toBe(false);
    expect(context.reason).toBe('Este viaje aún no ha finalizado');
  });

  it('marca eligible=false cuando la reserva ya fue reseñada', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    harness.push('reservations', { data: reservationRow(), error: null });
    givenCustomerData({
      tripReviews: [
        {
          id: 'tr-1',
          reservation_id: RESERVATION_ID,
          rating: 3,
          comment: null,
          moderation_status: 'visible',
          created_at: '2026-01-10T12:00:00.000Z',
        },
      ],
    });

    const context = await getReviewContext({
      reservationId: RESERVATION_ID,
      customerId: CUSTOMER_ID,
    });

    expect(context.eligible).toBe(false);
    expect(context.state).toBe('submitted');
    expect(context.reason).toBe('Ya enviaste la reseña de esta reserva');
  });

  it('marca eligible=false cuando la ventana venció', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    harness.push('reservations', { data: reservationRow(), error: null });
    givenCustomerData({ trip: tripRow({ completed_at: COMPLETED_LONG_AGO }) });

    const context = await getReviewContext({
      reservationId: RESERVATION_ID,
      customerId: CUSTOMER_ID,
    });

    expect(context.eligible).toBe(false);
    expect(context.window_expired).toBe(true);
    expect(context.reason).toBe('El plazo para calificar este viaje venció');
  });

  it('marca eligible=false cuando la reserva quedó locked/cancelled (copy correcto)', async () => {
    freezeClock('2026-01-11T00:00:00.000Z');
    harness.push('reservations', {
      data: reservationRow({ status: 'cancelled' }),
      error: null,
    });
    givenCustomerData({ reservations: [reservationRow({ status: 'cancelled' })] });

    const context = await getReviewContext({
      reservationId: RESERVATION_ID,
      customerId: CUSTOMER_ID,
    });

    expect(context.eligible).toBe(false);
    // No es "no está confirmada": una cancelada SÍ estuvo confirmada.
    expect(context.reason).toBe('Esta reserva ya no es reseñable');
  });

  it('responde 404 uniforme cuando la reserva no existe o es de otro cliente', async () => {
    // maybeSingle sin fila: inexistente, ajena o no-marketplace se igualan.
    harness.push('reservations', { data: null, error: null });

    await expect(
      getReviewContext({ reservationId: RESERVATION_ID, customerId: CUSTOMER_ID }),
    ).rejects.toMatchObject({ code: 'REVIEW_RESERVATION_NOT_FOUND', statusCode: 404 });
  });

  it('rechaza un reservationId que no es UUID con VALIDATION_ERROR', async () => {
    await expect(
      getReviewContext({ reservationId: 'no-es-uuid', customerId: CUSTOMER_ID }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });
});

// ── 3) Envío atómico ─────────────────────────────────────────────────────────

describe('submitReviews — delega en la RPC atómica 099', () => {
  it('envía SIEMPRE el customer_id del SERVIDOR y ambos ratings juntos', async () => {
    harness.setRpcDefault('submit_reservation_reviews', {
      data: {
        reservation_id: RESERVATION_ID,
        already_submitted: false,
        trip_review_id: 'tr-1',
        agency_review_id: 'ar-1',
      },
      error: null,
    });

    const result = await submitReviews({
      reservationId: RESERVATION_ID,
      customerId: CUSTOMER_ID,
      trip_rating: 5,
      trip_comment: 'Excelente',
      agency_rating: 4,
      agency_comment: null,
    });

    const calls = harness.rpcCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('submit_reservation_reviews');
    expect(calls[0].args).toMatchObject({
      p_reservation_id: RESERVATION_ID,
      p_customer_id: CUSTOMER_ID,
      p_trip_rating: 5,
      p_trip_comment: 'Excelente',
      p_agency_rating: 4,
      p_agency_comment: null,
    });
    expect(result.already_submitted).toBe(false);
    expect(result.trip_review_id).toBe('tr-1');
    expect(result.agency_review_id).toBe('ar-1');
  });

  it('devuelve already_submitted en un reintento (idempotencia)', async () => {
    harness.setRpcDefault('submit_reservation_reviews', {
      data: {
        reservation_id: RESERVATION_ID,
        already_submitted: true,
        trip_review_id: 'tr-1',
        agency_review_id: 'ar-1',
      },
      error: null,
    });

    const result = await submitReviews({
      reservationId: RESERVATION_ID,
      customerId: CUSTOMER_ID,
      trip_rating: 5,
      agency_rating: 5,
    });

    expect(result.already_submitted).toBe(true);
  });

  it('rechaza ratings fuera de 1..5 ANTES de tocar la RPC', async () => {
    for (const rating of [0, 6, 3.5]) {
      await expect(
        submitReviews({
          reservationId: RESERVATION_ID,
          customerId: CUSTOMER_ID,
          trip_rating: rating,
          agency_rating: 5,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    }
    expect(harness.rpcCalls()).toHaveLength(0);
  });

  it('mapea ERR_REVIEW_WINDOW_EXPIRED a 410', async () => {
    harness.pushRpc('submit_reservation_reviews', {
      data: null,
      error: { message: 'ERR_REVIEW_WINDOW_EXPIRED: The review window has expired' },
    });

    await expect(
      submitReviews({
        reservationId: RESERVATION_ID,
        customerId: CUSTOMER_ID,
        trip_rating: 5,
        agency_rating: 5,
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_WINDOW_EXPIRED', statusCode: 410 });
  });

  it('mapea ERR_REVIEW_NOT_OWNER a 404 uniforme (no filtra reservas ajenas)', async () => {
    harness.pushRpc('submit_reservation_reviews', {
      data: null,
      error: { message: 'ERR_REVIEW_NOT_OWNER: Reservation does not belong to this customer' },
    });

    await expect(
      submitReviews({
        reservationId: RESERVATION_ID,
        customerId: CUSTOMER_ID,
        trip_rating: 5,
        agency_rating: 5,
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_RESERVATION_NOT_FOUND', statusCode: 404 });
  });

  it('mapea ERR_REVIEW_TRIP_NOT_COMPLETED a 409', async () => {
    harness.pushRpc('submit_reservation_reviews', {
      data: null,
      error: { message: 'ERR_REVIEW_TRIP_NOT_COMPLETED: Trip is not completed' },
    });

    await expect(
      submitReviews({
        reservationId: RESERVATION_ID,
        customerId: CUSTOMER_ID,
        trip_rating: 5,
        agency_rating: 5,
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_TRIP_NOT_COMPLETED', statusCode: 409 });
  });

  it('un error SQL sin código ERR_* nunca expone el mensaje crudo', async () => {
    harness.pushRpc('submit_reservation_reviews', {
      data: null,
      error: { message: 'column "agency_id" of relation does not exist' },
    });

    const rejection = await submitReviews({
      reservationId: RESERVATION_ID,
      customerId: CUSTOMER_ID,
      trip_rating: 5,
      agency_rating: 5,
    }).catch((e: any) => e);

    expect(rejection).toMatchObject({ statusCode: 500, code: 'REVIEW_ERROR' });
    expect(String(rejection.message)).not.toContain('relation');
  });
});

// ── 4) Reconciliación de invitaciones ────────────────────────────────────────

describe('runReviewReconciliation — worker idempotente', () => {
  it('devuelve created/expired/failed de la RPC 098', async () => {
    harness.setRpcDefault('generate_review_requests', {
      data: { created: 2, expired: 1, failed: 1 },
      error: null,
    });

    const result = await runReviewReconciliation();

    expect(result).toEqual({ created: 2, expired: 1, failed: 1 });
    expect(harness.rpcCalls()[0].fn).toBe('generate_review_requests');
  });

  it('normaliza contadores ausentes a 0 (respuesta incompleta)', async () => {
    harness.setRpcDefault('generate_review_requests', {
      data: { created: 1 },
      error: null,
    });

    await expect(runReviewReconciliation()).resolves.toEqual({
      created: 1,
      expired: 0,
      failed: 0,
    });
  });

  it('NUNCA lanza: un fallo de RPC devuelve null (el loop continúa)', async () => {
    harness.setRpcDefault('generate_review_requests', {
      data: null,
      error: { message: 'could not connect' },
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runReviewReconciliation()).resolves.toBeNull();
    consoleSpy.mockRestore();
  });

  it('NUNCA lanza ante una excepción inesperada', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = harness.rpc;
    try {
      (harness as any).rpc = () => {
        throw new Error('explosion');
      };
      await expect(runReviewReconciliation()).resolves.toBeNull();
    } finally {
      (harness as any).rpc = original;
      vi.restoreAllMocks();
    }
  });
});

// ── 5) Notificaciones del cliente ────────────────────────────────────────────

describe('markNotificationRead — solo la propia y solo unread', () => {
  it('actualiza read_at filtrando por customer_id', async () => {
    harness.push('customer_notifications', {
      data: [{ id: 'n-1' }],
      error: null,
    });

    const result = await markNotificationRead({
      notificationId: '11111111-2222-4333-8444-555555555555',
      customerId: CUSTOMER_ID,
    });

    expect(result.ok).toBe(true);
  });

  it('ok=false cuando ninguna fila coincide (notificación ajena o ya leída)', async () => {
    harness.push('customer_notifications', { data: [], error: null });

    const result = await markNotificationRead({
      notificationId: '11111111-2222-4333-8444-555555555555',
      customerId: CUSTOMER_ID,
    });

    expect(result.ok).toBe(false);
  });
});

// ── 6) Moderación (superadmin) ───────────────────────────────────────────────

describe('adminModerateReview — RPC auditada 099', () => {
  it('invoca moderate_review con el actor superadmin y la acción', async () => {
    harness.setRpcDefault('moderate_review', {
      data: {
        review_id: 'tr-1',
        review_type: 'trip_review',
        moderation_status: 'hidden',
        moderated_at: '2026-01-11T00:00:00.000Z',
      },
      error: null,
    });

    const result = await adminModerateReview({
      reviewType: 'trip_review',
      reviewId: '11111111-2222-4333-8444-666666666666',
      actorUserId: CUSTOMER_ID,
      action: 'hide',
      reason: 'Spam',
    });

    expect(harness.rpcCalls()[0].args).toMatchObject({
      p_review_type: 'trip_review',
      p_action: 'hide',
      p_actor_user_id: CUSTOMER_ID,
      p_reason: 'Spam',
    });
    expect(result.moderation_status).toBe('hidden');
  });

  it('fallback sin status en la respuesta mapea ACCIÓN→ESTADO (restore→visible)', async () => {
    // La RPC no devolvio moderation_status: jamas se expone la acción
    // cruda ("restore") como si fuera un estado.
    harness.setRpcDefault('moderate_review', { data: {}, error: null });

    const result = await adminModerateReview({
      reviewType: 'trip_review',
      reviewId: '11111111-2222-4333-8444-666666666666',
      actorUserId: CUSTOMER_ID,
      action: 'restore',
    });

    expect(result.moderation_status).toBe('visible');
    expect(result.review_id).toBe('11111111-2222-4333-8444-666666666666');
  });

  it('mapea ERR_REVIEW_ADMIN_ROLE a 403', async () => {
    harness.pushRpc('moderate_review', {
      data: null,
      error: { message: 'ERR_REVIEW_ADMIN_ROLE: Only superadmins can moderate reviews' },
    });

    await expect(
      adminModerateReview({
        reviewType: 'agency_review',
        reviewId: '11111111-2222-4333-8444-666666666666',
        actorUserId: CUSTOMER_ID,
        action: 'restore',
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_ADMIN_REQUIRED', statusCode: 403 });
  });

  it('rechaza una acción fuera de hide/reject/restore antes de la RPC', async () => {
    await expect(
      adminModerateReview({
        reviewType: 'trip_review',
        reviewId: '11111111-2222-4333-8444-666666666666',
        actorUserId: CUSTOMER_ID,
        action: 'delete' as any,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(harness.rpcCalls()).toHaveLength(0);
  });
});

// ── adminListReviews — merge global paginado (REV-001) ───────────────────────

/** Fila mínima de revisión para el listado admin. */
function adminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-2222-4333-8444-666666666666',
    reservation_id: RESERVATION_ID,
    trip_id: TRIP_ID,
    customer_id: CUSTOMER_ID,
    rating: 5,
    comment: null,
    moderation_status: 'visible',
    moderated_by: null,
    moderated_at: null,
    moderation_reason: null,
    created_at: '2026-01-10T10:00:00.000Z',
    ...overrides,
  };
}

describe('adminListReviews — paginación global sobre dos tablas', () => {
  it('mezcla ambas tablas, ordena por created_at desc y corta en el rango pedido', async () => {
    // trip: 2 filas (10:00 y 08:00); agency: 2 filas (09:00 y 07:00).
    // Global desc: 10:00 trip, 09:00 agency, 08:00 trip, 07:00 agency.
    harness.push('trip_reviews', {
      data: [
        adminRow({ id: 't-1', created_at: '2026-01-10T10:00:00.000Z' }),
        adminRow({ id: 't-2', created_at: '2026-01-10T08:00:00.000Z' }),
      ],
      error: null,
    });
    harness.push('agency_reviews', {
      data: [
        adminRow({ id: 'a-1', created_at: '2026-01-10T09:00:00.000Z' }),
        adminRow({ id: 'a-2', created_at: '2026-01-10T07:00:00.000Z' }),
      ],
      error: null,
    });

    const { items, has_more } = await adminListReviews({ limit: 2, offset: 1 });

    // offset=1, limit=2 → posiciones 1..2 del merge global.
    expect(items.map((i) => i.id)).toEqual(['a-1', 't-2']);
    expect(items[0].review_type).toBe('agency_review');
    expect(items[1].review_type).toBe('trip_review');
    // 4 totales > offset+limit (3): queda más páginas.
    expect(has_more).toBe(true);
  });

  it('pagina cada tabla con range(0, offset+limit) y corta con slice(offset)', async () => {
    harness.push('trip_reviews', { data: [adminRow()], error: null });
    harness.push('agency_reviews', { data: [adminRow()], error: null });

    const { items } = await adminListReviews({ limit: 10, offset: 20 });

    const ranges = harness
      .chainCalls()
      .filter((c) => c.method === 'range')
      .map((c) => c.args);
    // Cada tabla trae offset+limit+1 filas propias (rango inclusive).
    expect(ranges).toEqual([
      [0, 30],
      [0, 30],
    ]);
    // Con 1 fila por tabla el merge tiene 2 < offset: nada que cortar.
    expect(items).toHaveLength(0);
  });

  it('has_more=false cuando el merge global no supera offset+limit', async () => {
    harness.push('trip_reviews', { data: [adminRow()], error: null });
    harness.push('agency_reviews', { data: [adminRow()], error: null });

    const { items, has_more } = await adminListReviews({ limit: 5, offset: 0 });

    expect(items).toHaveLength(2);
    expect(has_more).toBe(false);
  });

  it('con agencyId sin reservas retorna vacío SIN llamar .in (filtro imposible)', async () => {
    harness.push('reservations', { data: [], error: null });

    const result = await adminListReviews({
      agencyId: '99999999-9999-4999-8999-999999999999',
      limit: 20,
      offset: 0,
    });

    expect(result).toEqual({ items: [], has_more: false });
    // Ni .in en trip_reviews ni consulta de la segunda tabla.
    expect(harness.chainCalls().filter((c) => c.method === 'in')).toHaveLength(0);
    expect(harness.chainCalls().filter((c) => c.table === 'agency_reviews')).toHaveLength(0);
  });

  it('un error en el subquery de reservas lanza REVIEW_ERROR (no lista vacía)', async () => {
    harness.push('reservations', { data: null, error: { message: 'boom' } });

    await expect(
      adminListReviews({
        agencyId: AGENCY_ID,
        limit: 20,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_ERROR', statusCode: 500 });
  });

  it('filtra solo por la tabla pedida (review_type)', async () => {
    harness.push('agency_reviews', { data: [adminRow()], error: null });

    const { items } = await adminListReviews({
      reviewType: 'agency_review',
      limit: 20,
      offset: 0,
    });

    expect(harness.chainCalls().filter((c) => c.table === 'trip_reviews')).toHaveLength(0);
    expect(items).toHaveLength(1);
    expect(items[0].review_type).toBe('agency_review');
  });
});
