import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import toast from 'react-hot-toast';
import {
  publicApi,
  reservationApi,
  seatApi,
  type CreateReservationResult,
  type MySeatLocksResult,
  type PublicTripDetail,
  type PublicTripSeat,
} from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import NewReservationPage from '../page';

const { pushMock, realtime, search } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  search: { value: '' as string },
  realtime: {
    seatHandlers: [] as Array<(payload: unknown) => void>,
    tripHandlers: [] as Array<(payload: unknown) => void>,
    cleanup: vi.fn(),
    subscribeToTripSeats: vi.fn(),
    subscribeToTrips: vi.fn(),
  },
}));

realtime.subscribeToTripSeats.mockImplementation(
  (_tripIds: string[], callback: (payload: unknown) => void) => {
    realtime.seatHandlers.push(callback);
    return realtime.cleanup;
  },
);
realtime.subscribeToTrips.mockImplementation(
  (_tripIds: string[], callback: (payload: unknown) => void) => {
    realtime.tripHandlers.push(callback);
    return realtime.cleanup;
  },
);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, back: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search.value),
}));

vi.mock('@/lib/api', () => ({
  publicApi: {
    trips: vi.fn(),
    tripDetail: vi.fn(),
    agencies: vi.fn(),
  },
  seatApi: {
    lockSeats: vi.fn(),
    unlockSeats: vi.fn(),
    mySeatLocks: vi.fn(),
    lockGuestSeats: vi.fn(),
    getGuestLocks: vi.fn(),
    unlockGuestSeats: vi.fn(),
    claimGuestLocks: vi.fn(),
  },
  reservationApi: {
    create: vi.fn(),
  },
}));

vi.mock('@/lib/realtime/subscriptions', () => ({
  subscribeToTripSeats: realtime.subscribeToTripSeats,
  subscribeToTrips: realtime.subscribeToTrips,
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Estado de sesión mutable: los tests de gate cambian `user` a null (guest)
// y el beforeEach del archivo restaura el customer autenticado.
const authState = vi.hoisted(() => ({
  user: { id: 'user-me', email: 'cliente@test.com', role: 'customer' } as {
    id: string;
    email: string;
    role: string;
  } | null,
  loading: false,
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => ({
    user: authState.user,
    loading: authState.loading,
    refresh: async () => {},
    signOut: async () => {},
  }),
}));

const mockedTripDetail = vi.mocked(publicApi.tripDetail);
const mockedLocks = vi.mocked(seatApi.mySeatLocks);
const mockedLock = vi.mocked(seatApi.lockSeats);
const mockedUnlock = vi.mocked(seatApi.unlockSeats);
const mockedGetGuestLocks = vi.mocked(seatApi.getGuestLocks);
const mockedClaimGuestLocks = vi.mocked(seatApi.claimGuestLocks);
const mockedLockGuest = vi.mocked(seatApi.lockGuestSeats);
const mockedUnlockGuest = vi.mocked(seatApi.unlockGuestSeats);
const mockedCreate = vi.mocked(reservationApi.create);

const LOCK_KEY = 'mkt004.lock.v1';

function futureExpiry() {
  return new Date(Date.now() + 900_000).toISOString();
}

function buildSeats(
  count: number,
  statuses: Record<string, PublicTripSeat['status']> = {},
): PublicTripSeat[] {
  return Array.from({ length: count }, (_, index) => {
    const seatCode = `A${index + 1}`;
    return {
      id: `seat-${index + 1}`,
      seat_code: seatCode,
      status: statuses[seatCode] ?? 'available',
    };
  });
}

function buildTrip(overrides: Partial<PublicTripDetail> = {}): PublicTripDetail {
  return {
    id: 'trip-1',
    departure_time: '2026-10-04T11:00:00+00:00',
    capacity: 31,
    vehicle_type: 'bus',
    status: 'active',
    route: { origin: 'Barquisimeto', destination: 'Caracas' },
    seat_price: 2020,
    installment_allowed: false,
    installment_amount_cents: null,
    lock_ttl_seconds: 900,
    offers: [
      {
        agency_id: 'ag-1',
        name: 'Bianchi travels',
        logo_url: null,
        primary_color: '#000024',
        secondary_color: null,
        accent_color: '#00D4FF',
      },
    ],
    seats: buildSeats(31),
    availability: {
      total: 31,
      available: 31,
      reserved: 0,
      locked: 0,
      blocked: 0,
      guide: 0,
    },
    ...overrides,
  };
}

function seedLock(overrides: Record<string, unknown> = {}) {
  const expires = futureExpiry();
  sessionStorage.setItem(
    LOCK_KEY,
    JSON.stringify({
      trip_id: 'trip-1',
      agency_id: 'ag-1',
      seats: [
        { id: 'seat-1', seat_code: 'A1' },
        { id: 'seat-2', seat_code: 'A2' },
      ],
      lock_expires_at: expires,
      passengers: [],
      ...overrides,
    }),
  );
}

function serverLocks(
  overrides: Partial<MySeatLocksResult> = {},
): MySeatLocksResult {
  const expires = futureExpiry();
  return {
    trip_id: 'trip-1',
    lock_expires_at: expires,
    seats: [
      { id: 'seat-1', seat_code: 'A1', lock_expires_at: expires },
      { id: 'seat-2', seat_code: 'A2', lock_expires_at: expires },
    ],
    ...overrides,
  };
}

async function renderWizard() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<NewReservationPage />);
  });
  return view;
}

async function fillValidPassengers(view: ReturnType<typeof render>) {
  const { container } = view;
  const set = (id: string, value: string) => {
    fireEvent.change(container.querySelector(`#${id}`) as HTMLElement, {
      target: { value },
    });
  };
  set('passenger-0-first-name', 'María');
  set('passenger-0-last-name', 'González');
  set('passenger-0-document', '12345678');
  set('passenger-0-phone', '04241234567');
  set('passenger-1-first-name', 'José');
  set('passenger-1-last-name', 'Pérez');
  set('passenger-1-document', '87654321');
  set('passenger-1-phone', '04121234567');
}

function createdReservation(
  overrides: Partial<CreateReservationResult> = {},
): CreateReservationResult {
  return {
    reservation_id: 'res-1',
    trip_id: 'trip-1',
    agency_id: 'ag-1',
    customer_id: 'user-me',
    status: 'locked',
    source: 'marketplace',
    unit_price: 2020,
    passenger_count: 2,
    seat_ids: ['seat-1', 'seat-2'],
    idempotent: false,
    ...overrides,
  };
}

// Aplica a todos los describes del archivo: customer autenticado por defecto
// y creación de reserva resuelta (los tests la sobreescriben cuando hace falta).
beforeEach(() => {
  authState.user = { id: 'user-me', email: 'cliente@test.com', role: 'customer' };
  authState.loading = false;
  search.value = '';
  mockedCreate.mockReset();
  mockedCreate.mockResolvedValue(createdReservation());
});

describe('Wizard de reserva (MKT-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    realtime.seatHandlers.length = 0;
    realtime.tripHandlers.length = 0;
    // Por defecto: sin cookie guest (401) → el probe no dispara claim.
    mockedGetGuestLocks.mockReset();
    mockedGetGuestLocks.mockRejectedValue(
      new ApiError('Sesión guest requerida', 'UNAUTHORIZED', 401),
    );
    mockedClaimGuestLocks.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('muestra empty state con CTA cuando no hay selección activa', async () => {
    await renderWizard();

    expect(
      screen.getByText('No tienes una selección activa'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Ver viajes disponibles/ }),
    ).toHaveAttribute('href', '/viajes');
    expect(mockedTripDetail).not.toHaveBeenCalled();
    expect(mockedLocks).not.toHaveBeenCalled();
  });

  it('deriva el countdown de lock_expires_at y expira la selección', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T11:45:00.000Z'));
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    expect(screen.getByRole('timer')).toHaveTextContent(
      'Tu selección está reservada durante 15:00',
    );
    expect(
      screen.getByRole('heading', { name: 'Elige tus asientos' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Asiento A1, seleccionado' }),
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByRole('timer')).toHaveTextContent(
      'Tu selección está reservada durante 13:59',
    );

    act(() => {
      vi.advanceTimersByTime(779_000);
    });
    expect(screen.getByRole('timer')).toHaveTextContent(
      'Tu selección expira en 01:00',
    );

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Elegir asientos de nuevo/ }),
    ).toBeInTheDocument();
  });

  it('marca expirada cuando el servidor ya no tiene mis locks', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(
      serverLocks({ lock_expires_at: null, seats: [] }),
    );

    await renderWizard();

    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Elegir asientos de nuevo/ }),
    );

    expect(pushMock).toHaveBeenCalledWith('/reservas/nueva?trip=trip-1');
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
  });

  it('muestra error y permite reintentar si la verificación falla', async () => {
    seedLock();
    mockedTripDetail.mockRejectedValueOnce(
      new ApiError('boom de red', 'ERR_NETWORK', 500),
    );
    mockedTripDetail.mockResolvedValueOnce({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    expect(
      screen.getByText('No pudimos cargar tu selección'),
    ).toBeInTheDocument();
    expect(screen.getByText('boom de red')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    });

    expect(
      screen.getByRole('heading', { name: 'Elige tus asientos' }),
    ).toBeInTheDocument();
  });

  it('valida los datos de los pasajeros antes de crear la reserva', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    // Checkout de una sola página: las secciones se ven sin navegar.
    expect(
      screen.getByRole('heading', { name: 'Datos de los pasajeros' }),
    ).toBeInTheDocument();
    expect(screen.getByText('2 pasajeros')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Confirmar y pagar' }),
      );
    });

    expect(screen.getAllByText('Escribe el nombre del pasajero')).toHaveLength(2);
    expect(screen.getAllByText('Escribe el apellido del pasajero')).toHaveLength(2);
    expect(screen.getAllByText('Debe tener 7 u 8 dígitos')).toHaveLength(2);
    expect(
      screen.getAllByText(/Ingresa un teléfono válido/),
    ).toHaveLength(2);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('heading', { name: 'Comprobante de pago' }),
    ).not.toBeInTheDocument();
  });

  it('detecta documentos duplicados y crea la reserva con datos válidos', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await fillValidPassengers(view);

    fireEvent.change(
      view.container.querySelector('#passenger-1-document') as HTMLElement,
      { target: { value: '12345678' } },
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Confirmar y pagar' }),
      );
    });
    expect(
      screen.getByText('Documento repetido en esta reserva'),
    ).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();

    fireEvent.change(
      view.container.querySelector('#passenger-1-document') as HTMLElement,
      { target: { value: '87654321' } },
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Confirmar y pagar' }),
      );
    });

    expect(
      screen.getByRole('heading', { name: 'Resumen de tu reserva' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Pago' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Comprobante de pago' }),
    ).toBeInTheDocument();
    expect(screen.getByText('María González')).toBeInTheDocument();
    expect(screen.getByText('José Pérez')).toBeInTheDocument();
    expect(screen.getByText('12345678 · Asiento A1')).toBeInTheDocument();
    expect(screen.getByText('$40,40')).toBeInTheDocument();
    expect(screen.getByText('Reserva creada')).toBeInTheDocument();
    expect(
      screen.getByText(/Aquí aparecerán las opciones de pago/),
    ).toBeInTheDocument();
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    // Tras crear: sin botón de confirmación y pasajeros bloqueados.
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
    expect(
      view.container.querySelector('#passenger-0-first-name'),
    ).toBeDisabled();
  });

  it('permite ajustar la selección de asientos dentro del wizard', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedUnlock.mockResolvedValue({ unlocked: 1 });

    await renderWizard();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Asiento A1, seleccionado' }),
      );
    });

    expect(mockedUnlock).toHaveBeenCalledWith('trip-1', ['seat-1']);
    expect(screen.getByText('1 seleccionado')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Asiento A1, disponible' }),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Asiento A2, seleccionado' }),
      );
    });
    expect(mockedUnlock).toHaveBeenCalledTimes(1);

    mockedLock.mockResolvedValue({
      locked: true,
      trip_id: 'trip-1',
      ttl_seconds: 900,
      lock_expires_at: futureExpiry(),
      seats: [{ id: 'seat-3', seat_code: 'A3' }],
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Asiento A3, disponible' }),
      );
    });

    expect(mockedLock).toHaveBeenCalledWith('trip-1', ['seat-3']);
    expect(screen.getByText('2 seleccionados')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Asiento A3, seleccionado' }),
    ).toBeInTheDocument();
  });

  it('libera la selección completa al pulsar Cambiar asientos y se queda en el checkout', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedUnlock.mockResolvedValue({ unlocked: 2 });

    await renderWizard();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cambiar asientos' }));
    });

    expect(mockedUnlock).toHaveBeenCalledWith('trip-1');
    // /viajes/[id] ya no forma parte del flujo: la selección se reinicia
    // en la misma pantalla (?trip= conserva el viaje).
    expect(pushMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
    expect(toast.success).toHaveBeenCalledWith(
      'Selección liberada. Elige tus asientos de nuevo.',
    );
    expect(screen.getByText('0 seleccionados')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Asiento A1, disponible' }),
    ).toBeInTheDocument();
  });

  it('reclama la sesión guest ANTES de verificar con el endpoint autenticado', async () => {
    seedLock();
    const expires = futureExpiry();
    mockedGetGuestLocks.mockResolvedValue({
      trip_id: 'trip-1',
      lock_expires_at: expires,
      seats: [
        { id: 'seat-1', seat_code: 'A1', lock_expires_at: expires },
        { id: 'seat-2', seat_code: 'A2', lock_expires_at: expires },
      ],
      guest_session: { trip_id: 'trip-1', status: 'active', expires_at: expires },
    });
    mockedClaimGuestLocks.mockResolvedValue({
      claimed: true,
      trip_id: 'trip-1',
      seats: [
        { id: 'seat-1', seat_code: 'A1', lock_expires_at: expires },
        { id: 'seat-2', seat_code: 'A2', lock_expires_at: expires },
      ],
      lock_expires_at: expires,
      guest_session: { trip_id: 'trip-1', status: 'claimed', expires_at: expires },
    });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks({ lock_expires_at: expires }));

    await renderWizard();

    expect(mockedClaimGuestLocks).toHaveBeenCalledTimes(1);
    expect(mockedClaimGuestLocks).toHaveBeenCalledWith('trip-1');
    // Orden: claim → tripDetail / mySeatLocks (sin verificar como no-propio).
    expect(
      mockedClaimGuestLocks.mock.invocationCallOrder[0],
    ).toBeLessThan(mockedTripDetail.mock.invocationCallOrder[0]);
    expect(
      mockedClaimGuestLocks.mock.invocationCallOrder[0],
    ).toBeLessThan(mockedLocks.mock.invocationCallOrder[0]);

    expect(
      screen.getByRole('heading', { name: 'Elige tus asientos' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Asiento A1, seleccionado' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Asiento A2, seleccionado' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();
  });

  it('sin sesión guest pendiente verifica sin intentar reclamar', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    expect(mockedGetGuestLocks).toHaveBeenCalledWith('trip-1');
    expect(mockedClaimGuestLocks).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Asiento A1, seleccionado' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();
  });

  it('si el claim expira, la verificación muestra la selección expirada', async () => {
    seedLock();
    const expires = futureExpiry();
    mockedGetGuestLocks.mockResolvedValue({
      trip_id: 'trip-1',
      lock_expires_at: expires,
      seats: [{ id: 'seat-1', seat_code: 'A1', lock_expires_at: expires }],
      guest_session: { trip_id: 'trip-1', status: 'active', expires_at: expires },
    });
    mockedClaimGuestLocks.mockRejectedValue(
      new ApiError('La sesión guest expiró', 'GUEST_SESSION_EXPIRED', 401),
    );
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(
      serverLocks({ lock_expires_at: null, seats: [] }),
    );

    await renderWizard();

    expect(mockedClaimGuestLocks).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Elegir asientos de nuevo/ }),
    ).toBeInTheDocument();
  });
});

describe('Wizard de reserva — realtime (MKT-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    realtime.seatHandlers.length = 0;
    realtime.tripHandlers.length = 0;
    mockedGetGuestLocks.mockReset();
    mockedGetGuestLocks.mockRejectedValue(
      new ApiError('Sesión guest requerida', 'UNAUTHORIZED', 401),
    );
    mockedClaimGuestLocks.mockReset();
  });

  it('deselecciona y avisa cuando otro usuario toma uno de tus asientos en vivo', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    expect(realtime.seatHandlers).toHaveLength(1);
    expect(realtime.tripHandlers).toHaveLength(1);

    await act(async () => {
      realtime.seatHandlers[0]({
        eventType: 'UPDATE',
        seat: {
          id: 'seat-1',
          trip_id: 'trip-1',
          seat_code: 'A1',
          status: 'locked',
          locked_by: 'otro-usuario',
        },
      });
    });

    expect(screen.getByText('1 seleccionado')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Asiento A1, bloqueado' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Asiento A2, seleccionado' }),
    ).toBeInTheDocument();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'El asiento A1 ya no está disponible',
    );
    expect(screen.getByRole('timer')).toBeInTheDocument();
    expect(sessionStorage.getItem(LOCK_KEY)).not.toBeNull();
  });

  it('expira la reserva cuando en vivo se pierden todos tus asientos', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    await act(async () => {
      realtime.seatHandlers[0]({
        eventType: 'UPDATE',
        seat: {
          id: 'seat-1',
          trip_id: 'trip-1',
          seat_code: 'A1',
          status: 'available',
        },
      });
      realtime.seatHandlers[0]({
        eventType: 'UPDATE',
        seat: {
          id: 'seat-2',
          trip_id: 'trip-1',
          seat_code: 'A2',
          status: 'available',
        },
      });
    });

    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Elegir asientos de nuevo/ }),
    ).toBeInTheDocument();
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(2);
  });

  it('sale del wizard si el viaje se cancela en tiempo real', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    await act(async () => {
      realtime.tripHandlers[0]({
        eventType: 'UPDATE',
        trip: { id: 'trip-1', status: 'cancelled' },
      });
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Este viaje fue cancelado. Tu reserva no puede continuar.',
    );
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
    expect(pushMock).toHaveBeenCalledWith('/viajes');
  });

  it('refresca el mapa con debounce tras cambios de asientos', async () => {
    vi.useFakeTimers();
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();
    expect(mockedTripDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      realtime.seatHandlers[0]({
        eventType: 'UPDATE',
        seat: {
          id: 'seat-9',
          trip_id: 'trip-1',
          seat_code: 'A9',
          status: 'locked',
          locked_by: 'otro-usuario',
        },
      });
      realtime.seatHandlers[0]({
        eventType: 'UPDATE',
        seat: {
          id: 'seat-8',
          trip_id: 'trip-1',
          seat_code: 'A8',
          status: 'reserved',
        },
      });
    });
    expect(mockedTripDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(mockedTripDetail).toHaveBeenCalledTimes(2);
  });
});

// ─── MKT-004 Fase B: checkout → auth gate → reservation ────────────────────

function resetCheckoutTest() {
  vi.clearAllMocks();
  sessionStorage.clear();
  realtime.seatHandlers.length = 0;
  realtime.tripHandlers.length = 0;
  mockedGetGuestLocks.mockReset();
  mockedGetGuestLocks.mockRejectedValue(
    new ApiError('Sesión guest requerida', 'UNAUTHORIZED', 401),
  );
  mockedClaimGuestLocks.mockReset();
  mockedCreate.mockClear();
}

// Checkout de una sola página: completar pasajeros y pulsar "Confirmar y pagar"
// valida y dispara el POST de la reserva (antes era navegar al step de pago).
async function createReservationViaUi(view: ReturnType<typeof render>) {
  await fillValidPassengers(view);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y pagar' }));
  });
}

describe('Authentication gate (MKT-004 Fase B)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  it('sin sesión, el checkout muestra login/registro y no crea la reserva', async () => {
    authState.user = null;
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    expect(
      screen.getByText('Para continuar con el pago, debes iniciar sesión.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Iniciar sesión/ }),
    ).toHaveAttribute('href', '/login?redirect=%2Freservas%2Fnueva');
    expect(
      screen.getByRole('link', { name: /Registrarse/ }),
    ).toHaveAttribute('href', '/register?redirect=%2Freservas%2Fnueva');
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(screen.queryByText('Reserva creada')).not.toBeInTheDocument();
  });

  it('autenticado no muestra el gate y crea la reserva al confirmar', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();

    expect(
      screen.queryByText('Para continuar con el pago, debes iniciar sesión.'),
    ).not.toBeInTheDocument();

    await createReservationViaUi(view);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Reserva creada')).toBeInTheDocument();
  });

  it('guest sin sesión verifica sus locks con la cookie y llega al gate sin relockear', async () => {
    authState.user = null;
    seedLock();
    const expires = futureExpiry();
    mockedLocks.mockRejectedValue(
      new ApiError('Sesión requerida', 'UNAUTHORIZED', 401),
    );
    mockedGetGuestLocks.mockResolvedValue({
      trip_id: 'trip-1',
      lock_expires_at: expires,
      seats: [
        { id: 'seat-1', seat_code: 'A1', lock_expires_at: expires },
        { id: 'seat-2', seat_code: 'A2', lock_expires_at: expires },
      ],
      guest_session: {
        trip_id: 'trip-1',
        status: 'active',
        expires_at: expires,
      },
    });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });

    await renderWizard();

    expect(
      screen.getByRole('button', { name: 'Asiento A1, seleccionado' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();

    expect(
      screen.getByText('Para continuar con el pago, debes iniciar sesión.'),
    ).toBeInTheDocument();
    expect(mockedLock).not.toHaveBeenCalled();
    expect(mockedLockGuest).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

describe('Claim guest tras login/registro (MKT-004 Fase B)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  it('al volver del login reclama los locks guest y continúa al pago sin relockear', async () => {
    seedLock();
    const expires = futureExpiry();
    mockedGetGuestLocks.mockResolvedValue({
      trip_id: 'trip-1',
      lock_expires_at: expires,
      seats: [
        { id: 'seat-1', seat_code: 'A1', lock_expires_at: expires },
        { id: 'seat-2', seat_code: 'A2', lock_expires_at: expires },
      ],
      guest_session: {
        trip_id: 'trip-1',
        status: 'active',
        expires_at: expires,
      },
    });
    mockedClaimGuestLocks.mockResolvedValue({
      claimed: true,
      trip_id: 'trip-1',
      seats: [
        { id: 'seat-1', seat_code: 'A1', lock_expires_at: expires },
        { id: 'seat-2', seat_code: 'A2', lock_expires_at: expires },
      ],
      lock_expires_at: expires,
      guest_session: {
        trip_id: 'trip-1',
        status: 'claimed',
        expires_at: expires,
      },
    });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks({ lock_expires_at: expires }));

    const view = await renderWizard();

    expect(mockedClaimGuestLocks).toHaveBeenCalledTimes(1);
    expect(mockedClaimGuestLocks).toHaveBeenCalledWith('trip-1');
    expect(mockedClaimGuestLocks.mock.invocationCallOrder[0]).toBeLessThan(
      mockedLocks.mock.invocationCallOrder[0],
    );
    // NO relockea: ni lock autenticado ni lock-guest.
    expect(mockedLock).not.toHaveBeenCalled();
    expect(mockedLockGuest).not.toHaveBeenCalled();

    await createReservationViaUi(view);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Reserva creada')).toBeInTheDocument();
    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? '{}');
    expect(stored.lock_expires_at).toBe(expires);
  });

  it('al volver del registro reclama con una sola operación y crea la reserva', async () => {
    seedLock();
    const expires = futureExpiry();
    mockedGetGuestLocks.mockResolvedValue({
      trip_id: 'trip-1',
      lock_expires_at: expires,
      seats: [
        { id: 'seat-1', seat_code: 'A1', lock_expires_at: expires },
        { id: 'seat-2', seat_code: 'A2', lock_expires_at: expires },
      ],
      guest_session: {
        trip_id: 'trip-1',
        status: 'active',
        expires_at: expires,
      },
    });
    mockedClaimGuestLocks.mockResolvedValue({
      claimed: true,
      trip_id: 'trip-1',
      seats: [
        { id: 'seat-1', seat_code: 'A1', lock_expires_at: expires },
        { id: 'seat-2', seat_code: 'A2', lock_expires_at: expires },
      ],
      lock_expires_at: expires,
      guest_session: {
        trip_id: 'trip-1',
        status: 'claimed',
        expires_at: expires,
      },
    });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks({ lock_expires_at: expires }));

    const view = await renderWizard();

    expect(mockedClaimGuestLocks).toHaveBeenCalledTimes(1);
    expect(mockedLock).not.toHaveBeenCalled();
    expect(mockedLockGuest).not.toHaveBeenCalled();

    await createReservationViaUi(view);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Reserva creada')).toBeInTheDocument();
  });
});

describe('Creación de reserva marketplace (MKT-004 Fase B)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  it('POSTea trip, oferta, asientos y pasajeros — sin autoridades del cliente', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createReservationViaUi(view);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate).toHaveBeenCalledWith({
      trip_id: 'trip-1',
      agency_id: 'ag-1',
      seat_ids: ['seat-1', 'seat-2'],
      passengers: [
        {
          seat_id: 'seat-1',
          first_name: 'María',
          last_name: 'González',
          document: '12345678',
          phone: '04241234567',
        },
        {
          seat_id: 'seat-2',
          first_name: 'José',
          last_name: 'Pérez',
          document: '87654321',
          phone: '04121234567',
        },
      ],
    });
    const payload = mockedCreate.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('customer_id');
    expect(payload).not.toHaveProperty('unit_price');
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('source');
  });

  it('guarda reservation_id en LockState con los pasajeros persistidos', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createReservationViaUi(view);

    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? '{}');
    expect(stored.reservation_id).toBe('res-1');
    expect(stored.passengers).toHaveLength(2);
    expect(stored.passengers[0]).toMatchObject({
      seat_id: 'seat-1',
      document: '12345678',
    });
    expect(stored).not.toHaveProperty('customer_id');
    expect(stored).not.toHaveProperty('unit_price');
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Reserva creada');
  });

  it('200 idempotent se trata como éxito y muestra el placeholder de pago', async () => {
    mockedCreate.mockResolvedValue(
      createdReservation({ idempotent: true, reservation_id: 'res-9' }),
    );
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createReservationViaUi(view);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Reserva creada')).toBeInTheDocument();
    expect(
      screen.getByText(/Aquí aparecerán las opciones de pago/),
    ).toBeInTheDocument();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? '{}');
    expect(stored.reservation_id).toBe('res-9');
  });

  it('no duplica el POST con la petición aún en vuelo', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    let resolveCreate!: (value: CreateReservationResult) => void;
    mockedCreate.mockImplementation(
      () =>
        new Promise<CreateReservationResult>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const view = await renderWizard();
    await fillValidPassengers(view);
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirmar y pagar' }),
    );
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    // Estado loading (§12): el botón queda deshabilitado mientras hay POST en vuelo.
    const pendingButton = screen.getByRole('button', {
      name: 'Confirmando tu reserva…',
    });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate(createdReservation());
    });
    expect(screen.getByText('Reserva creada')).toBeInTheDocument();
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
    expect(
      view.container.querySelector('#passenger-0-first-name'),
    ).toBeDisabled();
  });

  it('tras crear la reserva el checkout queda bloqueado sin re-POST', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createReservationViaUi(view);
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    expect(
      screen.getByRole('heading', { name: 'Datos de los pasajeros' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Comprobante de pago' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      view.container.querySelector('#passenger-0-first-name'),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cambiar asientos' })).toBeDisabled();

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Reserva creada')).toBeInTheDocument();
  });
});

describe('Errores de creación de reserva (MKT-004 Fase B)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  it('lock expirado en el backend muestra la selección expirada con su CTA', async () => {
    mockedCreate.mockRejectedValue(
      new ApiError('Tu selección expiró', 'SEAT_LOCK_EXPIRED', 409),
    );
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createReservationViaUi(view);

    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Elegir asientos de nuevo/ }),
    ).toBeInTheDocument();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Tu selección expiró');
    expect(sessionStorage.getItem(LOCK_KEY)).not.toBeNull();
  });

  it('ownership conflict invalida la selección local sin reserva parcial', async () => {
    mockedCreate.mockRejectedValue(
      new ApiError(
        'Algunos asientos no están bloqueados para tu cuenta',
        'SEAT_NOT_OWNED',
        409,
      ),
    );
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createReservationViaUi(view);

    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Elegir asientos de nuevo/ }),
    ).toBeInTheDocument();
    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? '{}');
    expect(stored.reservation_id).toBeUndefined();
  });

  it('TRIP_PRICE_MISSING muestra error específico sin reenviar precio', async () => {
    mockedCreate.mockRejectedValue(
      new ApiError('Trip has no seat_price', 'TRIP_PRICE_MISSING', 422),
    );
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createReservationViaUi(view);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Este viaje no tiene un precio configurado y no puede reservarse en este momento.',
    );
    const payload = mockedCreate.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('unit_price');
    expect(
      screen.getByRole('button', { name: /Reintentar/ }),
    ).toBeInTheDocument();
  });

  it('error 500 permite reintentar y al reintentar crea la reserva', async () => {
    mockedCreate.mockRejectedValueOnce(
      new ApiError('boom interno', 'INTERNAL_ERROR', 500),
    );
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createReservationViaUi(view);

    expect(screen.getByRole('alert')).toHaveTextContent('boom interno');
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    });

    expect(mockedCreate).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Reserva creada')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Persistencia de la reserva (MKT-004 Fase B)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  it('refresh con reservation_id en LockState no vuelve a crear la reserva', async () => {
    seedLock({ reservation_id: 'res-1' });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Pago' })).toBeInTheDocument();
    expect(screen.getByText('Reserva creada')).toBeInTheDocument();
    expect(
      screen.getByText(/Aquí aparecerán las opciones de pago/),
    ).toBeInTheDocument();
    // Una sola pantalla: el comprobante convive con el resto de secciones.
    expect(
      screen.getByRole('heading', { name: 'Comprobante de pago' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
    expect(
      view.container.querySelector('#passenger-0-first-name'),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cambiar asientos' })).toBeDisabled();
  });

  it('refresh con pasajeros completos restaura hasta pasajeros (sin reserva)', async () => {
    seedLock({
      passengers: [
        {
          seat_id: 'seat-1',
          first_name: 'María',
          last_name: 'González',
          document: '12345678',
          phone: '04241234567',
        },
        {
          seat_id: 'seat-2',
          first_name: 'José',
          last_name: 'Pérez',
          document: '87654321',
          phone: '04121234567',
        },
      ],
    });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();

    expect(
      screen.getByRole('heading', { name: 'Datos de los pasajeros' }),
    ).toBeInTheDocument();
    expect(screen.getByText('María González')).toBeInTheDocument();
    expect(
      (
        view.container.querySelector(
          '#passenger-0-first-name',
        ) as HTMLInputElement
      ).value,
    ).toBe('María');
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('reintentar tras un refresh con reserva creada no crea una segunda reserva', async () => {
    seedLock({ reservation_id: 'res-1' });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    expect(mockedCreate).not.toHaveBeenCalled();

    // El guard de reservation_id bloquea el POST aunque se reintente la verificación.
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Cambiar asientos' }),
      );
    });

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(screen.getByText('Reserva creada')).toBeInTheDocument();
    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? '{}');
    expect(stored.reservation_id).toBe('res-1');
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
    expect(view.container.querySelector('#passenger-1-first-name')).toBeDisabled();
  });
});

// Flujo nuevo: /viajes → "Reservar" → /reservas/nueva?trip=<id>. El checkout
// carga el viaje directamente con 0 asientos (sin LockState previa) y /viajes/[id]
// ya no forma parte del recorrido.
describe('Entrada directa al checkout (?trip desde el catálogo)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    realtime.seatHandlers.length = 0;
    realtime.tripHandlers.length = 0;
    // Por defecto: sin cookie guest (401) → el probe no dispara claim.
    mockedGetGuestLocks.mockReset();
    mockedGetGuestLocks.mockRejectedValue(
      new ApiError('Sesión guest requerida', 'UNAUTHORIZED', 401),
    );
    mockedClaimGuestLocks.mockReset();
    search.value = '?trip=trip-1';
  });

  it('carga el viaje del catálogo con 0 asientos, sin selección previa ni countdown', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });

    await renderWizard();

    expect(mockedTripDetail).toHaveBeenCalledWith('trip-1');
    expect(
      screen.queryByText('No tienes una selección activa'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Elige tus asientos' }),
    ).toBeInTheDocument();
    expect(screen.getByText('0 seleccionados')).toBeInTheDocument();
    expect(screen.getByText('Aún no has seleccionado asientos')).toBeInTheDocument();
    expect(
      screen.getByText('Selecciona al menos un asiento para continuar con el pago.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Elegir asientos' })).toBeInTheDocument();
    // Sin lock real no hay banner de retención ni countdown.
    expect(screen.queryByText(/Los asientos están retenidos/)).not.toBeInTheDocument();
    // La LockState solo se persiste con ≥1 asiento.
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
    expect(mockedLocks).not.toHaveBeenCalled();
    expect(mockedClaimGuestLocks).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
  });

  it('el primer asiento crea la LockState con el endpoint autenticado (customer)', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLock.mockResolvedValue({
      locked: true,
      trip_id: 'trip-1',
      ttl_seconds: 900,
      lock_expires_at: futureExpiry(),
      seats: [{ id: 'seat-1', seat_code: 'A1' }],
    });

    await renderWizard();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Asiento A1, disponible' }),
      );
    });

    expect(mockedLock).toHaveBeenCalledWith('trip-1', ['seat-1']);
    expect(mockedLockGuest).not.toHaveBeenCalled();
    // Elegir asientos nunca manda al login.
    expect(pushMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByText('1 seleccionado')).toBeInTheDocument();
    expect(screen.getByText('1 pasajero')).toBeInTheDocument();
    expect(sessionStorage.getItem(LOCK_KEY)).toContain('"seat-1"');
    expect(screen.getByText(/Los asientos están retenidos/)).toBeInTheDocument();
  });

  it('un invitado lockea con la cookie guest, nunca va al login y libera igual', async () => {
    authState.user = null;
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockGuest.mockResolvedValue({
      locked: true,
      trip_id: 'trip-1',
      ttl_seconds: 900,
      lock_expires_at: futureExpiry(),
      seats: [{ id: 'seat-1', seat_code: 'A1' }],
      guest_session: {
        trip_id: 'trip-1',
        status: 'active',
        expires_at: futureExpiry(),
      },
    });
    mockedUnlockGuest.mockResolvedValue({ unlocked: 1, remaining: 0 });

    await renderWizard();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Asiento A1, disponible' }),
      );
    });

    expect(mockedLockGuest).toHaveBeenCalledWith('trip-1', ['seat-1']);
    expect(mockedLock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByText('1 seleccionado')).toBeInTheDocument();

    // El gate de pago conserva el ?trip= para volver al checkout.
    expect(screen.getByRole('link', { name: /Iniciar sesión/ })).toHaveAttribute(
      'href',
      '/login?redirect=%2Freservas%2Fnueva%3Ftrip%3Dtrip-1',
    );

    // Cambiar asientos también libera por la vía guest.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cambiar asientos' }));
    });
    expect(mockedUnlockGuest).toHaveBeenCalledWith('trip-1', undefined);
    expect(mockedUnlock).not.toHaveBeenCalled();
    expect(screen.getByText('0 seleccionados')).toBeInTheDocument();
  });

  it('una cuenta superadmin usa los endpoints guest sin 403 ni redirect a login', async () => {
    authState.user = { id: 'user-super', email: 'super@test.com', role: 'superadmin' };
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockGuest.mockResolvedValue({
      locked: true,
      trip_id: 'trip-1',
      ttl_seconds: 900,
      lock_expires_at: futureExpiry(),
      seats: [{ id: 'seat-1', seat_code: 'A1' }],
      guest_session: {
        trip_id: 'trip-1',
        status: 'active',
        expires_at: futureExpiry(),
      },
    });

    await renderWizard();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Asiento A1, disponible' }),
      );
    });

    expect(mockedLockGuest).toHaveBeenCalledWith('trip-1', ['seat-1']);
    expect(mockedLock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByText('1 seleccionado')).toBeInTheDocument();
  });

  it('si había una selección de OTRO viaje, la libera y carga el ?trip nuevo', async () => {
    seedLock(); // selección previa del viaje trip-1
    search.value = '?trip=trip-2';
    mockedTripDetail.mockResolvedValue({ trip: buildTrip({ id: 'trip-2' }) });
    mockedUnlock.mockResolvedValue({ unlocked: 2 });

    await renderWizard();

    expect(mockedUnlock).toHaveBeenCalledWith('trip-1');
    expect(mockedTripDetail).toHaveBeenCalledWith('trip-2');
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
    expect(screen.getByText('0 seleccionados')).toBeInTheDocument();
    // La selección vieja ni siquiera se verifica.
    expect(mockedLocks).not.toHaveBeenCalled();
    expect(mockedClaimGuestLocks).not.toHaveBeenCalled();
  });

  it('espera a resolver la sesión antes de decidir guest o customer', async () => {
    authState.loading = true;
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });

    const view = await renderWizard();

    expect(mockedTripDetail).not.toHaveBeenCalled();

    authState.loading = false;
    await act(async () => {
      view.rerender(<NewReservationPage />);
    });

    expect(mockedTripDetail).toHaveBeenCalledWith('trip-1');
    expect(screen.getByText('0 seleccionados')).toBeInTheDocument();
  });
});

// ─── Hardening confirmado en el audit MKT-004 (READY FOR PHASE C) ──────────
// Precio temprano, expiración durante el checkout y rol de la cuenta en PAGO.

describe('Hardening MKT-004 (precio, expiración y roles)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  it('un viaje con seat_price válido deja el checkout operativo', async () => {
    search.value = '?trip=trip-1';
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLock.mockResolvedValue({
      locked: true,
      trip_id: 'trip-1',
      ttl_seconds: 900,
      lock_expires_at: futureExpiry(),
      seats: [{ id: 'seat-1', seat_code: 'A1' }],
    });

    await renderWizard();

    expect(
      screen.getByRole('heading', { name: 'Elige tus asientos' }),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Asiento A1, disponible' }),
      );
    });

    expect(screen.getByText('1 seleccionado')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Confirmar y pagar' }),
    ).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('un viaje sin seat_price bloquea el checkout en la carga inicial, sin POST', async () => {
    search.value = '?trip=trip-1';
    mockedTripDetail.mockResolvedValue({ trip: buildTrip({ seat_price: null }) });

    await renderWizard();

    expect(
      screen.getByRole('heading', { name: 'Reserva no disponible' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Este viaje no tiene un precio configurado y no puede reservarse en este momento.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Ver otros viajes/ }),
    ).toHaveAttribute('href', '/viajes');
    // El checkout ni siquiera llega a montarse.
    expect(
      screen.queryByRole('heading', { name: 'Elige tus asientos' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
    expect(mockedLocks).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('un viaje sin seat_price bloquea el checkout con selección guardada y conserva la LockState', async () => {
    search.value = '?trip=trip-1';
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip({ seat_price: null }) });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    expect(
      screen.getByRole('heading', { name: 'Reserva no disponible' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
    // Se bloquea la UI, no se destruye la selección del usuario.
    expect(sessionStorage.getItem(LOCK_KEY)).not.toBeNull();
  });

  it('al expirar el countdown con pasajeros completos no se crea ninguna reserva', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T11:00:00.000Z'));
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await fillValidPassengers(view);

    expect(
      screen.getByRole('button', { name: 'Confirmar y pagar' }),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(900_000);
    });

    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
    // La LockState sigue intacta: quien decide limpiarla es el usuario.
    expect(sessionStorage.getItem(LOCK_KEY)).not.toBeNull();
    const persisted = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? 'null');
    expect(persisted?.passengers).toHaveLength(2);
    expect(persisted?.passengers[0]?.first_name).toBe('María');
  });

  it('al llegar a 0 el checkout pasa a expirado e impide el POST', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T11:00:00.000Z'));
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await fillValidPassengers(view);

    // Un segundo antes del vencimiento el checkout sigue operativo.
    await act(async () => {
      vi.advanceTimersByTime(899_000);
    });
    expect(screen.getByRole('timer')).toHaveTextContent(
      'Tu selección expira en 00:01',
    );
    expect(
      screen.getByRole('button', { name: 'Confirmar y pagar' }),
    ).toBeInTheDocument();

    // En el instante exacto en que llega a 0 la selección queda vencida.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LOCK_KEY)).not.toBeNull();
  });

  it('cambiar de viaje con pasajeros completos libera el anterior y arranca limpio', async () => {
    search.value = '?trip=trip-1';
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await fillValidPassengers(view);

    const seeded = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? 'null');
    expect(seeded?.passengers).toHaveLength(2);
    expect(seeded?.passengers[0]?.first_name).toBe('María');

    // El usuario vuelve al catálogo y entra a OTRO viaje.
    search.value = '?trip=trip-2';
    mockedTripDetail.mockResolvedValue({ trip: buildTrip({ id: 'trip-2' }) });
    mockedUnlock.mockResolvedValue({ unlocked: 2 });
    mockedLock.mockResolvedValue({
      locked: true,
      trip_id: 'trip-2',
      ttl_seconds: 900,
      lock_expires_at: futureExpiry(),
      seats: [{ id: 'seat-1', seat_code: 'A1' }],
    });

    await act(async () => {
      view.rerender(<NewReservationPage />);
    });

    expect(mockedUnlock).toHaveBeenCalledWith('trip-1');
    expect(mockedTripDetail).toHaveBeenCalledWith('trip-2');
    expect(screen.getByText('0 seleccionados')).toBeInTheDocument();
    // La LockState del viaje A se libera y no se recrea (B arranca con 0 asientos).
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
    // Los pasajeros de A no sobreviven al cambio de viaje.
    expect(view.container.querySelectorAll('[id^="passenger-"]')).toHaveLength(
      0,
    );
    expect(screen.queryByText('María')).not.toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();

    // Un asiento de B crea pasajeros nuevos asociados por seat_id.
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Asiento A1, disponible' }),
      );
    });

    expect(mockedLock).toHaveBeenCalledWith('trip-2', ['seat-1']);
    expect(screen.getByText('1 pasajero')).toBeInTheDocument();
    const fresh = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? 'null');
    expect(fresh?.trip_id).toBe('trip-2');
    expect(fresh?.passengers).toHaveLength(1);
    expect(fresh?.passengers[0]?.seat_id).toBe('seat-1');
    expect(fresh?.passengers[0]?.first_name).toBe('');
  });

  it('una cuenta superadmin ve el aviso de cuenta de cliente y no puede confirmar', async () => {
    authState.user = {
      id: 'user-super',
      email: 'super@test.com',
      role: 'superadmin',
    };
    search.value = '?trip=trip-1';
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockGuest.mockResolvedValue({
      locked: true,
      trip_id: 'trip-1',
      ttl_seconds: 900,
      lock_expires_at: futureExpiry(),
      seats: [{ id: 'seat-1', seat_code: 'A1' }],
      guest_session: {
        trip_id: 'trip-1',
        status: 'active',
        expires_at: futureExpiry(),
      },
    });

    const view = await renderWizard();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Asiento A1, disponible' }),
      );
    });

    // Conserva el lock guest: sin 403 ni redirect a login.
    expect(mockedLockGuest).toHaveBeenCalledWith('trip-1', ['seat-1']);
    expect(mockedLock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByText('1 seleccionado')).toBeInTheDocument();
    expect(view.container.querySelector('#passenger-0-first-name')).not.toBeNull();

    // En PAGO no se enseña el gate de login/registro: la sesión YA existe.
    expect(
      screen.queryByText('Para continuar con el pago, debes iniciar sesión.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Iniciar sesión/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Registrarse/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Solo las cuentas de cliente pueden realizar reservas.'),
    ).toBeInTheDocument();

    // Sin CTA de creación no hay POST posible desde la UI.
    expect(
      screen.queryByRole('button', { name: 'Confirmar y pagar' }),
    ).not.toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
