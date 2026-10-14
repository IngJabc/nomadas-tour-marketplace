import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkoutApi, publicApi } from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
    },
  }),
}));

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const attemptResult = {
  attempt_id: 'att-1',
  trip_id: 'trip-1',
  agency_id: 'ag-1',
  customer_id: 'cus-1',
  status: 'created',
  seat_ids: ['seat-1'],
  passenger_count: 1,
  unit_price: 4040,
  amount_cents: 4040,
  proof_count: 0,
  expires_at: '2026-10-04T12:15:00.000Z',
  idempotent: false,
};

const proofResult = {
  attempt_id: 'att-1',
  status: 'pending_review',
  proof_count: 1,
  remaining_submissions: 2,
  proof_path: 'att-1/abc.png',
  payment_reference: '00123456789',
  bank_origin: 'Banco de Venezuela',
  payment_datetime: '2026-10-04T10:00:00.000Z',
  amount_cents: 4040,
  expires_at: '2026-10-05T12:00:00.000Z',
  idempotent: false,
};

const RECONCILIATION = {
  payment_reference: '00123456789',
  bank_origin: 'Banco de Venezuela',
  payment_datetime: '2026-10-04T10:00:00.000Z',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkoutApi.createAttempt (MKT-007)', () => {
  it('es JSON con Idempotency-Key y sin precio ni estado', async () => {
    fetchMock.mockResolvedValue(jsonResponse(attemptResult, 201));

    const result = await checkoutApi.createAttempt(
      {
        trip_id: 'trip-1',
        agency_id: 'ag-1',
        seat_ids: ['seat-1'],
        passengers: [
          {
            seat_id: 'seat-1',
            first_name: 'María',
            last_name: 'González',
            document: '12345678',
            phone: '04241234567',
          },
        ],
      },
      'b2f1f6d0-0000-4000-8000-000000000001',
    );

    expect(result).toEqual(attemptResult);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/public\/checkout\/attempts$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(
      'b2f1f6d0-0000-4000-8000-000000000001',
    );

    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'agency_id',
      'passengers',
      'seat_ids',
      'trip_id',
    ]);
    for (const forbidden of [
      'amount_cents',
      'unit_price',
      'status',
      'customer_id',
      'expires_at',
      'source',
    ]) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });
});

describe('checkoutApi.submitProof (MKT-007)', () => {
  it('envía multipart con archivo + conciliación y sin Content-Type manual', async () => {
    fetchMock.mockResolvedValue(jsonResponse(proofResult));
    const file = new File(['contenido'], 'comprobante.png', {
      type: 'image/png',
    });

    const result = await checkoutApi.submitProof(
      'att-1',
      file,
      RECONCILIATION,
      'idem-key',
    );

    expect(result).toEqual(proofResult);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/public\/checkout\/attempts\/att-1\/proof$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);

    const form = init.body as FormData;
    expect(Array.from(form.keys())).toEqual([
      'proof',
      'payment_reference',
      'bank_origin',
      'payment_datetime',
    ]);
    expect(form.get('proof')).toBe(file);
    expect(form.get('payment_reference')).toBe(
      RECONCILIATION.payment_reference,
    );
    expect(form.get('bank_origin')).toBe(RECONCILIATION.bank_origin);
    expect(form.get('payment_datetime')).toBe(RECONCILIATION.payment_datetime);

    // El navegador debe generar el boundary: declarar el multipart a mano lo rompe.
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      undefined,
    );
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(
      'idem-key',
    );
  });

  it('no envía monto, moneda, customer_id, estado, ventana ni proof_url', async () => {
    fetchMock.mockResolvedValue(jsonResponse(proofResult));
    const file = new File(['contenido'], 'comprobante.pdf', {
      type: 'application/pdf',
    });

    await checkoutApi.submitProof('att-1', file, RECONCILIATION, 'idem-key');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    for (const forbidden of [
      'amount_cents',
      'currency',
      'customer_id',
      'payment_status',
      'proof_url',
      'status',
      'expires_at',
    ]) {
      expect(form.has(forbidden)).toBe(false);
    }
    expect(JSON.stringify(init)).not.toContain('proof_url');
  });

  it('propaga el envelope de error del backend como ApiError con su code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'CHECKOUT_PROOF_LIMIT',
            message: 'Ya enviaste los tres comprobantes permitidos',
          },
        },
        409,
      ),
    );
    const file = new File(['contenido'], 'comprobante.png', {
      type: 'image/png',
    });

    const error = await checkoutApi
      .submitProof('att-1', file, RECONCILIATION, 'idem-key')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'CHECKOUT_PROOF_LIMIT',
      status: 409,
      message: 'Ya enviaste los tres comprobantes permitidos',
    });
  });
});

describe('checkoutApi.getAttempt / cancelAttempt (MKT-007)', () => {
  it('lee el intento propio con GET', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ attempt_id: 'att-1' }));

    await checkoutApi.getAttempt('att-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/public\/checkout\/attempts\/att-1$/);
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('cancela con POST y sin payload de cliente', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        attempt_id: 'att-1',
        status: 'cancelled',
        already_cancelled: false,
        freed_seats: 2,
      }),
    );

    await checkoutApi.cancelAttempt('att-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/public\/checkout\/attempts\/att-1\/cancel$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('sin marcador de pago ni reserva el cliente jamás afirma aprobación', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ attempt_id: 'att-1' }));

    const view = await checkoutApi.getAttempt('att-1');

    expect(view).not.toHaveProperty('payment_status');
    expect(view).not.toHaveProperty('reservation_id');
    expect(view).not.toHaveProperty('proof_path');
  });
});

describe('endpoints generales', () => {
  it('las peticiones JSON siguen enviando Content-Type application/json', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ trips: [] }));

    await publicApi.trips();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(init.body).toBeUndefined();
  });
});
