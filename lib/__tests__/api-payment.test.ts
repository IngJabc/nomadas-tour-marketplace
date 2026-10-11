import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paymentApi, publicApi, reservationApi } from '@/lib/api';
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

const proofResult = {
  payment_id: 'pay-1',
  reservation_id: 'res-1',
  payment_status: 'pending',
  reservation_status: 'reserved',
  amount_cents: 4040,
  currency: 'USD',
  submitted_at: '2026-10-04T12:00:00.000Z',
  idempotent: false,
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paymentApi.submitProof (MKT-005 Fase 3)', () => {
  it('envía multipart con un único campo proof y sin Content-Type manual', async () => {
    fetchMock.mockResolvedValue(jsonResponse(proofResult));
    const file = new File(['contenido'], 'comprobante.png', {
      type: 'image/png',
    });

    const result = await paymentApi.submitProof('res-1', file, 'idem-key');

    expect(result).toEqual(proofResult);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/public\/reservations\/res-1\/payments$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);

    const form = init.body as FormData;
    expect(Array.from(form.keys())).toEqual(['proof']);
    expect(form.get('proof')).toBe(file);

    // El navegador debe generar el boundary: declarar el multipart a mano lo rompe.
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      undefined,
    );
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(
      'idem-key',
    );
  });

  it('no envía monto, moneda, customer_id, estado ni proof_url', async () => {
    fetchMock.mockResolvedValue(jsonResponse(proofResult));
    const file = new File(['contenido'], 'comprobante.pdf', {
      type: 'application/pdf',
    });

    await paymentApi.submitProof('res-1', file, 'idem-key');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    for (const forbidden of [
      'amount_cents',
      'currency',
      'customer_id',
      'payment_status',
      'proof_url',
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
            code: 'PAYMENT_ALREADY_SUBMITTED',
            message: 'El comprobante de esta reserva ya fue enviado',
          },
        },
        409,
      ),
    );
    const file = new File(['contenido'], 'comprobante.png', {
      type: 'image/png',
    });

    const error = await paymentApi
      .submitProof('res-1', file, 'idem-key')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'PAYMENT_ALREADY_SUBMITTED',
      status: 409,
      message: 'El comprobante de esta reserva ya fue enviado',
    });
  });

  it('las peticiones JSON siguen enviando Content-Type application/json', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ trips: [] }));

    await publicApi.trips();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(init.body).toBeUndefined();
  });

  it('el POST de reserva sigue siendo JSON con su Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reservation_id: 'res-1' }));

    await reservationApi.create({
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
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(typeof init.body).toBe('string');
  });
});
