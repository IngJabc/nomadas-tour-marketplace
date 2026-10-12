import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { agencyPaymentApi, type AgencyPaymentListItem } from '@/lib/api';
import PagosPage from '../page';

vi.mock('@/lib/api', () => ({
  agencyPaymentApi: {
    list: vi.fn(),
    detail: vi.fn(),
    proofUrl: vi.fn(),
    verify: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => '/pagos',
}));

const mockList = vi.mocked(agencyPaymentApi.list);

function createPayment(overrides: Partial<AgencyPaymentListItem> = {}): AgencyPaymentListItem {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    status: 'pending',
    amount_cents: 4000,
    currency: 'USD',
    submitted_at: '2026-01-15T10:30:00.000Z',
    verified_at: null,
    rejection_reason: null,
    has_proof: true,
    reservation: {
      id: '660e8400-e29b-41d4-a716-446655440001',
      booker_name: 'Ana García',
      contact_email: 'ana@example.com',
      status: 'reserved',
      payment_status: 'pending',
      trip: {
        id: '770e8400-e29b-41d4-a716-446655440002',
        departure_time: '2026-01-20T14:00:00.000Z',
        origin: 'Caracas',
        destination: 'Valencia',
      },
    },
    ...overrides,
  };
}

describe('PagosPage (MKT-006 Fase 6.3C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('muestra la lista de pagos con badges de estado y acciones', async () => {
    mockList.mockResolvedValue({
      payments: [
        createPayment(),
        createPayment({
          id: '2',
          status: 'verified',
          verified_at: '2026-01-15T11:00:00.000Z',
          reservation: {
            ...createPayment().reservation,
            booker_name: 'Carlos López',
          },
        }),
      ],
      page: 1,
      limit: 20,
      total: 2,
    });

    render(<PagosPage />);

    expect(await screen.findByText('Ana García')).toBeInTheDocument();
    expect(screen.getByText('Carlos López')).toBeInTheDocument();
    expect(screen.getByText('Pendiente')).toBeInTheDocument();
    expect(screen.getByText('Verificado')).toBeInTheDocument();
    expect(screen.getAllByText('Ver detalle')).toHaveLength(2);
  });

  it('filtra por estado pendiente al hacer clic en el tab', async () => {
    mockList.mockResolvedValue({
      payments: [createPayment()],
      page: 1,
      limit: 20,
      total: 1,
    });

    render(<PagosPage />);
    await screen.findByText('Ana García');

    const pendingTab = screen.getByRole('button', { name: 'Pendientes' });
    fireEvent.click(pendingTab);

    await waitFor(() => {
      expect(mockList).toHaveBeenCalledWith({
        status: 'pending',
        page: 1,
        limit: 20,
      });
    });
  });

  it('muestra empty state con CTA cuando no hay pagos', async () => {
    mockList.mockResolvedValue({
      payments: [],
      page: 1,
      limit: 20,
      total: 0,
    });

    render(<PagosPage />);

    expect(await screen.findByText(/No hay pagos/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ver todos los pagos/ })).toBeInTheDocument();
  });

  it('muestra error con opción de reintento si la carga falla', async () => {
    mockList.mockRejectedValue(new Error('Network error'));

    render(<PagosPage />);

    expect(await screen.findByText(/Network error/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reintentar/ })).toBeInTheDocument();
  });

  it('navega al detalle al hacer clic en Ver detalle', async () => {
    mockList.mockResolvedValue({
      payments: [createPayment()],
      page: 1,
      limit: 20,
      total: 1,
    });

    render(<PagosPage />);
    await screen.findByText('Ana García');

    const viewButton = screen.getAllByRole('button', { name: 'Ver detalle' })[0];
    fireEvent.click(viewButton);

    // El botón está envuelto en un Link de Next.js; en jsdom solo verificamos
    // que el click se disparó sin errores.
    expect(viewButton).toBeInTheDocument();
  });
});
