import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewsApi, type ReviewItemDto } from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import MisResenasPage from '../page';

const { authState } = vi.hoisted(() => ({
  authState: {
    user: { id: 'customer-1', role: 'customer' } as { id: string; role: string } | null,
    loading: false,
  },
}));

vi.mock('@/lib/api', () => ({
  reviewsApi: { list: vi.fn() },
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => ({
    user: authState.user,
    loading: authState.loading,
    refresh: vi.fn(),
    signOut: async () => undefined,
  }),
}));

const mockedList = vi.mocked(reviewsApi.list);

function reviewItem(overrides: Partial<ReviewItemDto> = {}): ReviewItemDto {
  return {
    reservation_id: 'ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d',
    state: 'pending',
    trip: {
      id: 'trip-1',
      origin: 'Maracaibo',
      destination: 'Mérida',
      departure_time: '2026-01-10T06:00:00.000Z',
      completed_at: '2026-01-10T10:00:00.000Z',
    },
    agency: { id: 'agency-1', name: 'Agencia Central' },
    expires_at: '2026-01-12T10:00:00.000Z',
    window_expired: false,
    trip_review: null,
    agency_review: null,
    created_at: '2026-01-02T10:00:00.000Z',
    ...overrides,
  };
}

describe('MisResenasPage — lista de reseñas (REV-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 'customer-1', role: 'customer' };
    authState.loading = false;
  });

  it('muestra la invitación pendiente con CTA hacia el formulario', async () => {
    mockedList.mockResolvedValue({ items: [reviewItem()] });

    render(<MisResenasPage />);

    expect(
      await screen.findByText('Maracaibo → Mérida'),
    ).toBeInTheDocument();
    expect(screen.getByText('Pendiente de calificar')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Calificar viaje y agencia/ }),
    ).toHaveAttribute(
      'href',
      '/account/reviews/ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d',
    );
  });

  it('muestra la reseña enviada en modo lectura y aclara que no se puede editar', async () => {
    mockedList.mockResolvedValue({
      items: [
        reviewItem({
          state: 'submitted',
          trip_review: {
            id: 'tr-1',
            rating: 5,
            comment: 'Excelente',
            moderation_status: 'visible',
            created_at: '2026-01-10T12:00:00.000Z',
          },
          agency_review: {
            id: 'ar-1',
            rating: 4,
            comment: null,
            moderation_status: 'visible',
            created_at: '2026-01-10T12:00:00.000Z',
          },
        }),
      ],
    });

    render(<MisResenasPage />);

    expect(await screen.findByText('Reseña enviada')).toBeInTheDocument();
    expect(screen.getByText('Excelente')).toBeInTheDocument();
    expect(
      screen.getByText(/Las reseñas no se pueden editar ni eliminar/),
    ).toBeInTheDocument();
    // Sin CTA de calificar en una reseña ya enviada.
    expect(
      screen.queryByRole('link', { name: /Calificar viaje y agencia/ }),
    ).toBeNull();
  });

  it('muestra el estado expirado con el límite de la ventana', async () => {
    mockedList.mockResolvedValue({
      items: [
        reviewItem({
          state: 'expired',
          window_expired: true,
          expires_at: '2026-01-12T10:00:00.000Z',
        }),
      ],
    });

    render(<MisResenasPage />);

    expect(await screen.findByText('Plazo vencido')).toBeInTheDocument();
    expect(
      screen.getByText(/El plazo para calificar este viaje venció/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Calificar viaje y agencia/ }),
    ).toBeNull();
  });

  it('muestra el empty state con CTA hacia Mis compras', async () => {
    mockedList.mockResolvedValue({ items: [] });

    render(<MisResenasPage />);

    expect(await screen.findByText('Aún no tienes reseñas')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Ver mis compras/ }),
    ).toHaveAttribute('href', '/account/purchases');
  });

  it('muestra el estado de sesión expirada con login que regresa a la lista', async () => {
    mockedList.mockRejectedValue(new ApiError('Unauthorized', 'UNAUTHORIZED', 401));

    render(<MisResenasPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Iniciar sesión/ })).toHaveAttribute(
      'href',
      '/login?redirect=%2Faccount%2Freviews',
    );
  });

  it('bloquea cuentas que no son de cliente', async () => {
    authState.user = { id: 'agency-1', role: 'agency' };

    render(<MisResenasPage />);

    expect(
      await screen.findByText(
        'Solo las cuentas de cliente pueden enviar reseñas.',
      ),
    ).toBeInTheDocument();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('muestra error reintentable sin perder el contexto', async () => {
    mockedList.mockRejectedValue(
      new ApiError('Server error', 'REVIEW_ERROR', 500),
    );

    render(<MisResenasPage />);

    expect(
      await screen.findByText('No pudimos cargar tus reseñas'),
    ).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Reintentar/ });
    mockedList.mockResolvedValue({ items: [reviewItem()] });
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() =>
      expect(screen.getByText('Pendiente de calificar')).toBeInTheDocument(),
    );
  });
});
