import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import toast from 'react-hot-toast';
import {
  publicApi,
  seatApi,
  type MySeatLocksResult,
  type PublicTripDetail,
  type PublicTripSeat,
} from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import NewReservationPage from '../page';

const { pushMock, realtime } = vi.hoisted(() => ({
  pushMock: vi.fn(),
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
  },
}));

vi.mock('@/lib/realtime/subscriptions', () => ({
  subscribeToTripSeats: realtime.subscribeToTripSeats,
  subscribeToTrips: realtime.subscribeToTrips,
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => ({
    user: {
      id: 'user-me',
      email: 'cliente@test.com',
      role: 'customer',
    },
    loading: false,
    refresh: async () => {},
    signOut: async () => {},
  }),
}));

const mockedTripDetail = vi.mocked(publicApi.tripDetail);
const mockedLocks = vi.mocked(seatApi.mySeatLocks);
const mockedLock = vi.mocked(seatApi.lockSeats);
const mockedUnlock = vi.mocked(seatApi.unlockSeats);

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

describe('Wizard de reserva (MKT-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    realtime.seatHandlers.length = 0;
    realtime.tripHandlers.length = 0;
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

    expect(pushMock).toHaveBeenCalledWith('/viajes/trip-1');
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

  it('valida los datos de los pasajeros antes de avanzar', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continuar con los pasajeros' }),
    );

    expect(
      screen.getByRole('heading', { name: 'Datos de los pasajeros' }),
    ).toBeInTheDocument();
    expect(screen.getByText('2 pasajeros')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Continuar con el resumen' }),
    );

    expect(screen.getAllByText('Escribe el nombre del pasajero')).toHaveLength(2);
    expect(screen.getAllByText('Escribe el apellido del pasajero')).toHaveLength(2);
    expect(screen.getAllByText('Debe tener 7 u 8 dígitos')).toHaveLength(2);
    expect(
      screen.getAllByText(/Ingresa un teléfono válido/),
    ).toHaveLength(2);
    expect(
      screen.queryByRole('heading', { name: 'Resumen de tu reserva' }),
    ).not.toBeInTheDocument();
  });

  it('detecta documentos duplicados y avanza a resumen con datos válidos', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continuar con los pasajeros' }),
    );
    await fillValidPassengers(view);

    fireEvent.change(
      view.container.querySelector('#passenger-1-document') as HTMLElement,
      { target: { value: '12345678' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Continuar con el resumen' }),
    );
    expect(
      screen.getByText('Documento repetido en esta reserva'),
    ).toBeInTheDocument();

    fireEvent.change(
      view.container.querySelector('#passenger-1-document') as HTMLElement,
      { target: { value: '87654321' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Continuar con el resumen' }),
    );

    expect(
      screen.getByRole('heading', { name: 'Resumen de tu reserva' }),
    ).toBeInTheDocument();
    expect(screen.getByText('María González')).toBeInTheDocument();
    expect(screen.getByText('José Pérez')).toBeInTheDocument();
    expect(screen.getByText('12345678 · Asiento A1')).toBeInTheDocument();
    expect(screen.getByText('$40,40')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continuar al pago' }));
    expect(screen.getByRole('heading', { name: 'Pago' })).toBeInTheDocument();
    expect(
      screen.getByText(/El pago estará disponible en la próxima etapa/),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Volver al resumen' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Resumen de tu reserva' }),
    ).toBeInTheDocument();
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

  it('libera la selección completa al pulsar Cambiar asientos', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedUnlock.mockResolvedValue({ unlocked: 2 });

    await renderWizard();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cambiar asientos' }));
    });

    expect(mockedUnlock).toHaveBeenCalledWith('trip-1');
    expect(pushMock).toHaveBeenCalledWith('/viajes/trip-1');
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
  });
});

describe('Wizard de reserva — realtime (MKT-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    realtime.seatHandlers.length = 0;
    realtime.tripHandlers.length = 0;
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
