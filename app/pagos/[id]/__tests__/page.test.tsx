import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { agencyPaymentApi, type AgencyPaymentDetail } from '@/lib/api';
import PagoDetallePage from '../page';

vi.mock('@/lib/api', () => ({
  agencyPaymentApi: {
    list: vi.fn(),
    detail: vi.fn(),
    proofUrl: vi.fn(),
    verify: vi.fn(),
    reject: vi.fn(),
  },
}));

const mockParams = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
  useParams: () => mockParams(),
  usePathname: () => '/pagos',
}));

const mockDetail = vi.mocked(agencyPaymentApi.detail);
const mockProofUrl = vi.mocked(agencyPaymentApi.proofUrl);
const mockVerify = vi.mocked(agencyPaymentApi.verify);
const mockReject = vi.mocked(agencyPaymentApi.reject);

const PAYMENT_ID = '550e8400-e29b-41d4-a716-446655440000';

function pendingDetail(): AgencyPaymentDetail {
  return {
    payment: {
      id: PAYMENT_ID,
      status: 'pending',
      amount_cents: 4000,
      currency: 'USD',
      submitted_at: '2026-01-15T10:30:00.000Z',
      verified_at: null,
      verified_by: null,
      rejection_reason: null,
      has_proof: true,
    },
    reservation: {
      id: '660e8400-e29b-41d4-a716-446655440001',
      booker_name: 'Ana García',
      booker_phone: '+584121234567',
      contact_email: 'ana@example.com',
      status: 'reserved',
      payment_status: 'pending',
      created_at: '2026-01-15T10:00:00.000Z',
    },
    trip: {
      id: '770e8400-e29b-41d4-a716-446655440002',
      departure_time: '2026-01-20T14:00:00.000Z',
      vehicle_type: 'bus',
      seat_price: 2000,
      origin: 'Caracas',
      destination: 'Valencia',
    },
    passengers: [
      {
        id: 'p1',
        seat_code: 'A1',
        name: 'Ana García',
        unit_price: 2000,
        status: 'active',
      },
      {
        id: 'p2',
        seat_code: 'A2',
        name: 'Luis García',
        unit_price: 2000,
        status: 'active',
      },
    ],
    allocations: [
      {
        id: 'a1',
        reservation_passenger_id: 'p1',
        seat_code: 'A1',
        amount_cents: 2000,
        created_at: '2026-01-15T10:30:00.000Z',
      },
    ],
    totals: {
      active_passenger_count: 2,
      expected_cents: 4000,
      allocated_cents: 2000,
      remaining_cents: 2000,
    },
  };
}

describe('PagoDetallePage (MKT-006 Fase 6.3C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParams.mockReturnValue({ id: PAYMENT_ID });
  });

  it('muestra el detalle del pago con pasajeros y totales', async () => {
    mockDetail.mockResolvedValue(pendingDetail());

    render(<PagoDetallePage />);

    expect(await screen.findByText('Detalle del pago')).toBeInTheDocument();
    expect(screen.getByText('Pendiente')).toBeInTheDocument();
    expect(screen.getAllByText('Ana García').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Luis García')).toBeInTheDocument();
    expect(screen.getByText('Asiento A1 · active')).toBeInTheDocument();
    expect(screen.getAllByText('$40,00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Verificar pago')).toBeInTheDocument();
    expect(screen.getByText('Rechazar pago')).toBeInTheDocument();
  });

  it('muestra mensaje de error 404 si el pago no existe', async () => {
    const { ApiError } = await import('@/lib/errors/api-error');
    mockDetail.mockRejectedValue(
      new ApiError('Pago no encontrado', 'PAYMENT_NOT_FOUND', 404),
    );

    render(<PagoDetallePage />);

    expect(
      await screen.findByText(/no existe o no pertenece a tu agencia/),
    ).toBeInTheDocument();
  });

  it('abre el modal de verificación y confirma', async () => {
    mockDetail.mockResolvedValue(pendingDetail());
    mockVerify.mockResolvedValue({
      payment_id: PAYMENT_ID,
      reservation_id: 'r1',
      status: 'verified',
      already_verified: false,
      amount_cents: 4000,
      currency: 'USD',
      allocation_count: 2,
      total_expected_cents: 4000,
      verified_at: '2026-01-15T12:00:00.000Z',
      verified_by: 'u1',
      payment_status: 'verified',
      audit_id: 'audit1',
    });

    render(<PagoDetallePage />);
    await screen.findByText('Detalle del pago');

    fireEvent.click(screen.getByText('Verificar pago'));
    expect(
      await screen.findByText(/Confirmas que el comprobante es válido/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('Sí, verificar pago'));

    await waitFor(() => {
      expect(mockVerify).toHaveBeenCalledWith(PAYMENT_ID);
    });
  });

  it('rechaza con motivo y recarga el detalle', async () => {
    mockDetail.mockResolvedValue(pendingDetail());
    mockReject.mockResolvedValue({
      payment_id: PAYMENT_ID,
      reservation_id: 'r1',
      status: 'rejected',
      already_rejected: false,
      rejection_reason: 'Monto incorrecto',
      outcome: 'reservation_cancelled',
      cancelled_reservation: true,
      reservation_status: 'cancelled',
      payment_status: 'rejected',
      freed_seat_count: 2,
      cancelled_passenger_count: 2,
      refund_required: false,
      refund_amount_cents: 0,
      payment_audit_id: 'pa1',
      reservation_audit_id: 'ra1',
    });

    render(<PagoDetallePage />);
    await screen.findByText('Detalle del pago');

    const rejectButton = screen.getByRole('button', { name: /Rechazar pago/ });
    fireEvent.click(rejectButton);

    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Monto incorrecto' } });

    // Hay dos botones "Rechazar pago": el de la página y el del modal.
    // El del modal es el último del DOM y el único habilitado con el motivo.
    const confirmButtons = screen.getAllByRole('button', { name: 'Rechazar pago' });
    const confirmReject = confirmButtons[confirmButtons.length - 1];
    fireEvent.click(confirmReject);

    await waitFor(() => {
      expect(mockReject).toHaveBeenCalledWith(PAYMENT_ID, 'Monto incorrecto');
    });
  });
});
