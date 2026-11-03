import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import toast from 'react-hot-toast';
import { reviewsApi, type ReviewContextDto } from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import ResenaFormPage from '../page';

const { authState, paramsState, toastMock } = vi.hoisted(() => ({
  authState: {
    user: { id: 'customer-1', role: 'customer' } as { id: string; role: string } | null,
    loading: false,
  },
  paramsState: { reservationId: 'ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d' },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ reservationId: paramsState.reservationId }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({
  reviewsApi: {
    getContext: vi.fn(),
    submit: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: (...args: any[]) => toastMock.success(...args),
    error: (...args: any[]) => toastMock.error(...args),
  }),
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => ({
    user: authState.user,
    loading: authState.loading,
    refresh: vi.fn(),
    signOut: async () => undefined,
  }),
}));

const mockedGetContext = vi.mocked(reviewsApi.getContext);
const mockedSubmit = vi.mocked(reviewsApi.submit);

function eligibleContext(overrides: Partial<ReviewContextDto> = {}): ReviewContextDto {
  return {
    reservation_id: 'ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d',
    trip: {
      id: 'trip-1',
      origin: 'Maracaibo',
      destination: 'Mérida',
      departure_time: '2026-01-10T06:00:00.000Z',
      completed_at: '2026-01-10T10:00:00.000Z',
    },
    agency: { id: 'agency-1', name: 'Agencia Central' },
    eligible: true,
    state: 'pending',
    expires_at: '2026-01-12T10:00:00.000Z',
    window_expired: false,
    trip_review: null,
    agency_review: null,
    reason: null,
    ...overrides,
  };
}

/**
 * Selecciona una estrella en cada grupo. Los dos grupos (viaje / agencia)
 * comparten aria-label, por lo que se usan índices: [0] = viaje (primero
 * en el DOM), [1] = agencia.
 */
async function pickStars(value: number) {
  const stars = screen.getAllByRole('button', { name: `${value} de 5 estrellas` });
  await act(async () => {
    fireEvent.click(stars[0]);
  });
  await act(async () => {
    fireEvent.click(stars[1]);
  });
}

describe('ResenaFormPage — formulario de reseñas (REV-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 'customer-1', role: 'customer' };
    authState.loading = false;
    paramsState.reservationId = 'ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d';
  });

  it('carga el contexto y muestra ambas secciones con una sola acción', async () => {
    mockedGetContext.mockResolvedValue(eligibleContext());

    render(<ResenaFormPage />);

    expect(await screen.findByText('El viaje')).toBeInTheDocument();
    expect(screen.getByText('La agencia')).toBeInTheDocument();
    // UNA sola acción principal.
    const submit = screen.getByRole('button', { name: /Enviar mi reseña/ });
    expect(submit).toBeDisabled();
  });

  it('el envío exige las DOS calificaciones y manda ambas juntas', async () => {
    mockedGetContext.mockResolvedValue(eligibleContext());
    mockedSubmit.mockResolvedValue({
      reservation_id: 'ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d',
      already_submitted: false,
      trip_review_id: 'tr-1',
      agency_review_id: 'ar-1',
    });

    render(<ResenaFormPage />);

    const submit = await screen.findByRole('button', { name: /Enviar mi reseña/ });
    // Sin estrellas seleccionadas sigue deshabilitado.
    expect(submit).toBeDisabled();

    // Seleccionar SOLO la del viaje: aún deshabilitado (ambas obligatorias).
    const tripFive = screen.getAllByRole('button', { name: '5 de 5 estrellas' })[0];
    await act(async () => {
      fireEvent.click(tripFive);
    });
    expect(submit).toBeDisabled();

    // Seleccionar la de la agencia (4): habilita el envío.
    const agencyFour = screen.getAllByRole('button', { name: '4 de 5 estrellas' })[1];
    await act(async () => {
      fireEvent.click(agencyFour);
    });
    await waitFor(() => expect(submit).toBeEnabled());

    await act(async () => {
      fireEvent.click(submit);
    });

    expect(mockedSubmit).toHaveBeenCalledWith(
      'ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d',
      expect.objectContaining({ trip_rating: 5, agency_rating: 4 }),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      '¡Gracias! Tus reseñas fueron enviadas.',
    );
    // Tras enviar: vista de confirmación, sin formulario.
    await waitFor(() =>
      expect(screen.getByText('¡Gracias por tu reseña!')).toBeInTheDocument(),
    );
  });

  it('un already_submitted (reintento) se trata como éxito idempotente', async () => {
    mockedGetContext.mockResolvedValue(eligibleContext());
    mockedSubmit.mockResolvedValue({
      reservation_id: 'ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d',
      already_submitted: true,
      trip_review_id: 'tr-1',
      agency_review_id: 'ar-1',
    });

    render(<ResenaFormPage />);

    const submit = await screen.findByRole('button', { name: /Enviar mi reseña/ });
    await pickStars(5);
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(toastMock.success).toHaveBeenCalledWith(
      'Tu reseña ya estaba registrada.',
    );
  });

  it('muestra el motivo cuando la reserva no está elegible (sin formulario)', async () => {
    mockedGetContext.mockResolvedValue(
      eligibleContext({
        eligible: false,
        reason: 'Este viaje aún no ha finalizado',
      }),
    );

    render(<ResenaFormPage />);

    expect(
      await screen.findByText('Esta reserva aún no puede ser calificada'),
    ).toBeInTheDocument();
    expect(screen.getByText('Este viaje aún no ha finalizado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enviar mi reseña/ })).toBeNull();
  });

  it('muestra la vista de plazo vencido cuando la ventana expiró', async () => {
    mockedGetContext.mockResolvedValue(
      eligibleContext({
        eligible: false,
        state: 'expired',
        window_expired: true,
        reason: 'El plazo para calificar este viaje venció',
      }),
    );

    render(<ResenaFormPage />);

    expect(
      await screen.findByText('El plazo para calificar este viaje venció'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enviar mi reseña/ })).toBeNull();
  });

  it('muestra la reseña ya enviada en modo lectura (estado submitted)', async () => {
    mockedGetContext.mockResolvedValue(
      eligibleContext({
        eligible: false,
        state: 'submitted',
        reason: 'Ya enviaste la reseña de esta reserva',
        trip_review: {
          id: 'tr-1',
          rating: 5,
          comment: 'Muy bueno',
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
    );

    render(<ResenaFormPage />);

    expect(await screen.findByText('¡Gracias por tu reseña!')).toBeInTheDocument();
    expect(screen.getByText('Muy bueno')).toBeInTheDocument();
    expect(
      screen.getAllByText(/No se puede editar ni eliminar/).length,
    ).toBeGreaterThan(0);
  });

  it('la sesión expirada ofrece login que regresa EXACTAMENTE al formulario', async () => {
    mockedGetContext.mockRejectedValue(
      new ApiError('Unauthorized', 'UNAUTHORIZED', 401),
    );

    render(<ResenaFormPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Iniciar sesión/ })).toHaveAttribute(
      'href',
      '/login?redirect=%2Faccount%2Freviews%2Fab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d',
    );
  });

  it('un 404 uniforme (inexistente o ajena) muestra "No encontramos esta reseña"', async () => {
    mockedGetContext.mockRejectedValue(
      new ApiError('Reserva no encontrada', 'REVIEW_RESERVATION_NOT_FOUND', 404),
    );

    render(<ResenaFormPage />);

    expect(
      await screen.findByText('No encontramos esta reseña'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enviar mi reseña/ })).toBeNull();
  });

  it('un fallo del envío muestra toast de error y conserva el formulario', async () => {
    mockedGetContext.mockResolvedValue(eligibleContext());
    mockedSubmit.mockRejectedValue(
      new ApiError('El plazo venció', 'REVIEW_WINDOW_EXPIRED', 410),
    );

    render(<ResenaFormPage />);

    const submit = await screen.findByRole('button', { name: /Enviar mi reseña/ });
    await pickStars(3);
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(toastMock.error).toHaveBeenCalledWith('El plazo venció');
    // El formulario sigue intacto (el estado del usuario no se limpia).
    expect(screen.getByRole('button', { name: /Enviar mi reseña/ })).toBeInTheDocument();
  });

  it('bloquea cuentas que no son de cliente', async () => {
    authState.user = { id: 'agency-1', role: 'agency' };

    render(<ResenaFormPage />);

    expect(
      await screen.findByText('Solo las cuentas de cliente pueden enviar reseñas.'),
    ).toBeInTheDocument();
    expect(mockedGetContext).not.toHaveBeenCalled();
  });
});
