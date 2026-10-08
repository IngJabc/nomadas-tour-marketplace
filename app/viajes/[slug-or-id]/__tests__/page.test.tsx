import { Suspense, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import toast from 'react-hot-toast';
import {
  publicApi,
  seatApi,
  type LockSeatsResult,
  type PublicTripDetail,
  type PublicTripSeat,
} from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import TripDetailPage from '../page';

const { pushMock, realtime, authState } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  realtime: {
    seatHandlers: [] as Array<(payload: unknown) => void>,
    tripHandlers: [] as Array<(payload: unknown) => void>,
    cleanup: vi.fn(),
    subscribeToTripSeats: vi.fn(),
    subscribeToTrips: vi.fn(),
  },
  authState: {
    user: {
      id: 'user-me',
      email: 'cliente@test.com',
      role: 'customer',
    } as { id: string; email: string; role: string } | null,
    loading: false,
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
  useRouter: () => ({
    push: pushMock,
    back: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
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
}));

vi.mock('@/lib/realtime/subscriptions', () => ({
  subscribeToTripSeats: realtime.subscribeToTripSeats,
  subscribeToTrips: realtime.subscribeToTrips,
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children?: ReactNode }) => children,
  useOptionalAuthUser: () => ({
    user: authState.user,
    loading: authState.loading,
    refresh: async () => undefined,
    signOut: async () => undefined,
  }),
  useAuthUser: () => ({
    user: authState.user,
    loading: authState.loading,
    refresh: async () => undefined,
    signOut: async () => undefined,
  }),
}));

const mockedTripDetail = vi.mocked(publicApi.tripDetail);
const mockedLockSeats = vi.mocked(seatApi.lockSeats);
const mockedUnlockSeats = vi.mocked(seatApi.unlockSeats);
const mockedMySeatLocks = vi.mocked(seatApi.mySeatLocks);
const mockedLockGuestSeats = vi.mocked(seatApi.lockGuestSeats);
const mockedGetGuestLocks = vi.mocked(seatApi.getGuestLocks);
const mockedUnlockGuestSeats = vi.mocked(seatApi.unlockGuestSeats);
const mockedClaimGuestLocks = vi.mocked(seatApi.claimGuestLocks);

const LOCK_KEY = 'mkt004.lock.v1';

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
    installment_allowed: true,
    installment_amount_cents: 1010,
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
      {
        agency_id: 'ag-2',
        name: 'Tripalovsky',
        logo_url: null,
        primary_color: '#0a0a2e',
        secondary_color: null,
        accent_color: '#0080FF',
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

/** Expiración futura arbitraria (el TTL real lo fija el servidor). */
function futureExpiry(offsetMs = 900_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** `seat-5` → `A5` (así los construye `buildSeats`). */
function codeForId(seatId: string): string {
  return seatId.replace(/^seat-/, 'A');
}

function buildLockResult(
  seatIds: string[],
  lockExpiresAt: string,
  tripId = 'trip-1',
): LockSeatsResult {
  return {
    locked: true,
    trip_id: tripId,
    ttl_seconds: 900,
    lock_expires_at: lockExpiresAt,
    seats: seatIds.map((id) => ({ id, seat_code: codeForId(id) })),
  };
}

/** Respuesta exitosa de lock para cualquier asiento (viaja con el TTL dado). */
function autoLock(lockExpiresAt = futureExpiry()) {
  return vi.fn(
    async (tripId: string, seatIds: string[]) =>
      buildLockResult(seatIds, lockExpiresAt, tripId),
  );
}

/** Respuesta del endpoint guest: mismo contrato + metadata de sesión. */
function buildGuestLockResult(
  seatIds: string[],
  lockExpiresAt: string,
  tripId = 'trip-1',
) {
  return {
    ...buildLockResult(seatIds, lockExpiresAt, tripId),
    guest_session: {
      trip_id: tripId,
      status: 'active',
      expires_at: lockExpiresAt,
    },
  };
}

function buildGuestLocksResult(
  seats: Array<{ id: string; seat_code: string; lock_expires_at: string }>,
  tripId = 'trip-1',
) {
  const expiries = seats.map((seat) => seat.lock_expires_at).sort();
  return {
    trip_id: tripId,
    lock_expires_at: expiries[0] ?? null,
    seats,
    guest_session: {
      trip_id: tripId,
      status: 'active',
      expires_at: expiries[0] ?? futureExpiry(),
    },
  };
}

function buildClaimResult(
  seats: Array<{ id: string; seat_code: string; lock_expires_at: string }>,
  tripId = 'trip-1',
) {
  const expiries = seats.map((seat) => seat.lock_expires_at).sort();
  return {
    claimed: true as const,
    trip_id: tripId,
    seats,
    lock_expires_at: expiries[0] ?? null,
    guest_session: {
      trip_id: tripId,
      status: 'claimed',
      expires_at: expiries[0] ?? futureExpiry(),
    },
  };
}

function makeParams(id: string) {
  return Promise.resolve({ 'slug-or-id': id });
}

async function renderPage(id = 'trip-1', params = makeParams(id)) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <Suspense fallback={null}>
        <TripDetailPage params={params} />
      </Suspense>,
    );
  });
  return view;
}

/** Re-render con el MISMO `params` (la identidad debe ser estable). */
async function rerenderPage(
  view: ReturnType<typeof render>,
  params: Promise<{ 'slug-or-id': string }>,
) {
  await act(async () => {
    view.rerender(
      <Suspense fallback={null}>
        <TripDetailPage params={params} />
      </Suspense>,
    );
  });
}

function btn(name: string | RegExp) {
  return screen.getByRole('button', { name });
}

async function clickSeat(name: string) {
  await act(async () => {
    fireEvent.click(btn(name));
  });
}

function resetTestState() {
  vi.clearAllMocks();
  sessionStorage.clear();
  realtime.seatHandlers.length = 0;
  realtime.tripHandlers.length = 0;
  authState.user = { id: 'user-me', email: 'cliente@test.com', role: 'customer' };
  authState.loading = false;
  mockedTripDetail.mockReset();
  mockedLockSeats.mockReset();
  mockedUnlockSeats.mockReset();
  mockedUnlockSeats.mockResolvedValue({ unlocked: 1 });
  mockedMySeatLocks.mockReset();
  mockedMySeatLocks.mockResolvedValue({
    trip_id: 'trip-1',
    lock_expires_at: null,
    seats: [],
  });
  mockedLockGuestSeats.mockReset();
  mockedUnlockGuestSeats.mockReset();
  mockedUnlockGuestSeats.mockResolvedValue({ unlocked: 1, remaining: 0 });
  mockedGetGuestLocks.mockReset();
  // Por defecto: sin cookie guest (401), como en un visitante nuevo.
  mockedGetGuestLocks.mockRejectedValue(
    new ApiError('Sesión guest requerida', 'UNAUTHORIZED', 401),
  );
  mockedClaimGuestLocks.mockReset();
}

/** Marca al visitante como guest (sin sesión autenticada). */
function becomeGuest() {
  authState.user = null;
}

describe('TripDetailPage (MKT-003)', () => {
  beforeEach(resetTestState);

  it('muestra skeleton mientras consulta el viaje', async () => {
    mockedTripDetail.mockReturnValue(new Promise(() => {}));

    await renderPage();

    expect(await screen.findByText('Cargando viaje…')).toBeInTheDocument();
  });

  it('renderiza ruta, precio, disponibilidad, ofertas y mapa de asientos', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });

    await renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' }),
    ).toBeInTheDocument();
    expect(screen.getByText('$20,20')).toBeInTheDocument();
    expect(screen.getByText('Abono desde $10,10')).toBeInTheDocument();
    expect(screen.getByText('31 de 31 disponibles')).toBeInTheDocument();
    expect(screen.getByText('Bianchi travels')).toBeInTheDocument();
    expect(screen.getByText('Tripalovsky')).toBeInTheDocument();
    expect(screen.getAllByText(/4 oct 2026/)).toHaveLength(2);
    expect(screen.getByText('7:00 AM')).toBeInTheDocument();

    expect(
      screen.getAllByRole('button').filter((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Asiento '),
      ),
    ).toHaveLength(31);
    expect(btn('Asiento A1, disponible')).toBeInTheDocument();
    expect(btn('Asiento A31, disponible')).toBeInTheDocument();

    expect(
      screen.getByRole('list', { name: 'Leyenda de asientos' }),
    ).toBeInTheDocument();
    expect(btn('Continuar con la reserva')).toBeDisabled();
    expect(mockedTripDetail).toHaveBeenCalledWith('trip-1');
  });

  it('permite seleccionar entre varias agencias en el radiogroup', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(radios[1]);

    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
  });

  it('muestra aviso y CTA bloqueado cuando el viaje no tiene disponibilidad', async () => {
    const reservedSeats = buildSeats(31);
    reservedSeats.forEach((seat) => {
      seat.status = 'reserved';
    });
    mockedTripDetail.mockResolvedValue({
      trip: buildTrip({
        seats: reservedSeats,
        availability: {
          total: 31,
          available: 0,
          reserved: 31,
          locked: 0,
          blocked: 0,
          guide: 0,
        },
      }),
    });

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    expect(screen.getByText('Sin disponibilidad')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Este viaje ya no tiene asientos disponibles',
    );
    expect(btn('Sin asientos disponibles')).toBeDisabled();
    expect(btn('Asiento A1, reservado')).toBeDisabled();
  });

  it('reintenta tras un error de la API', async () => {
    mockedTripDetail.mockRejectedValueOnce(
      new ApiError('boom de red', 'ERR_NETWORK', 500),
    );
    mockedTripDetail.mockResolvedValueOnce({ trip: buildTrip() });

    await renderPage();

    expect(
      await screen.findByRole('heading', {
        name: 'No pudimos cargar el viaje',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('boom de red')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));

    expect(
      await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' }),
    ).toBeInTheDocument();
    expect(mockedTripDetail).toHaveBeenCalledTimes(2);
  });

  it('muestra estado 404 con CTA al catalogo cuando el viaje no existe', async () => {
    mockedTripDetail.mockRejectedValueOnce(
      new ApiError('Viaje no encontrado', 'TRIP_NOT_FOUND', 404),
    );

    await renderPage('no-existe');

    expect(
      await screen.findByRole('heading', { name: 'Viaje no encontrado' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Ver viajes disponibles/ }),
    ).toHaveAttribute('href', '/viajes');
    expect(mockedTripDetail).toHaveBeenCalledWith('no-existe');
  });

  it('tolera datos incompletos: precio nulo y sin ofertas de agencias', async () => {
    mockedTripDetail.mockResolvedValue({
      trip: buildTrip({
        seat_price: null,
        installment_allowed: false,
        installment_amount_cents: null,
        offers: [],
      }),
    });

    await renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Precio no disponible')).toBeInTheDocument();
    expect(
      screen.getByText(/Las agencias de este viaje estarán disponibles pronto/),
    ).toBeInTheDocument();
    expect(btn('Continuar con la reserva')).toBeDisabled();
  });
});

describe('TripDetailPage — bloqueo inmediato de asientos (MKT-004)', () => {
  beforeEach(resetTestState);

  it('bloquea el asiento en el click y permite seguir en el mapa', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    const expires = futureExpiry();
    let resolveLock!: (result: LockSeatsResult) => void;
    mockedLockSeats.mockReturnValue(
      new Promise<LockSeatsResult>((resolve) => {
        resolveLock = resolve;
      }),
    );

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A5, disponible');

    expect(mockedLockSeats).toHaveBeenCalledTimes(1);
    expect(mockedLockSeats).toHaveBeenCalledWith('trip-1', ['seat-5']);
    expect(btn(/Bloqueando asientos/)).toBeDisabled();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => {
      resolveLock(buildLockResult(['seat-5'], expires));
    });

    expect(btn('Asiento A5, seleccionado')).toHaveAttribute(
      'data-state',
      'selected',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 asiento seleccionado: A5',
    );
    expect(screen.getByRole('timer')).toHaveTextContent(
      /Tu selección está reservada durante \d{2}:\d{2}/,
    );
    expect(btn('Continuar con la reserva')).toBeEnabled();
    expect(screen.getByText('30 de 31 disponibles')).toBeInTheDocument();
    expect(screen.getByText('30 disponibles')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('acumula varios asientos sin navegar al wizard', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockSeats.mockImplementation(autoLock());

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A5, disponible');
    await clickSeat('Asiento A3, disponible');

    expect(mockedLockSeats).toHaveBeenCalledTimes(2);
    expect(mockedLockSeats).toHaveBeenNthCalledWith(1, 'trip-1', ['seat-5']);
    expect(mockedLockSeats).toHaveBeenNthCalledWith(2, 'trip-1', ['seat-3']);
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 asientos seleccionados: A5, A3',
    );
    expect(screen.getByRole('timer')).toBeInTheDocument();
    expect(btn('Continuar con la reserva')).toBeEnabled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('al re-elegir un asiento propio lo libera al instante', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockSeats.mockImplementation(autoLock());

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A5, disponible');
    expect(screen.getByRole('status')).toBeInTheDocument();

    await clickSeat('Asiento A5, seleccionado');

    expect(mockedUnlockSeats).toHaveBeenCalledTimes(1);
    expect(mockedUnlockSeats).toHaveBeenCalledWith('trip-1', ['seat-5']);
    expect(mockedLockSeats).toHaveBeenCalledTimes(1);
    expect(btn('Asiento A5, disponible')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Asiento A5 liberado',
    );
    expect(btn('Continuar con la reserva')).toBeDisabled();
  });

  it('ante un conflicto 409 refresca el mapa sin liberar tus otros locks', async () => {
    const seats = buildSeats(31);
    seats[4] = { ...seats[4], status: 'reserved' };
    mockedTripDetail
      .mockResolvedValueOnce({ trip: buildTrip() })
      .mockResolvedValue({
        trip: buildTrip({
          seats,
          availability: {
            total: 31,
            available: 30,
            reserved: 1,
            locked: 0,
            blocked: 0,
            guide: 0,
          },
        }),
      });
    mockedLockSeats.mockRejectedValueOnce(
      new ApiError(
        'Asientos no disponibles: A5',
        'SEAT_NOT_AVAILABLE',
        409,
      ),
    );

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A5, disponible');

    await waitFor(() => expect(mockedTripDetail).toHaveBeenCalledTimes(2));
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Asientos no disponibles: A5',
    );
    expect(btn('Asiento A5, reservado')).toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(mockedUnlockSeats).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
  });

  it('redirige al login cuando el backend responde 401', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockSeats.mockRejectedValue(
      new ApiError('No autorizado', 'UNAUTHORIZED', 401),
    );

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A7, disponible');

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        '/login?redirect=%2Fviajes%2Ftrip-1',
      ),
    );
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Inicia sesión para continuar con tu reserva',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
  });

  it('Continuar no vuelve a bloquear: solo persiste el estado y navega', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    const expires = futureExpiry();
    mockedLockSeats.mockImplementation(autoLock(expires));

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A5, disponible');
    expect(mockedLockSeats).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(btn('Continuar con la reserva'));
    });

    expect(mockedLockSeats).toHaveBeenCalledTimes(1);
    expect(mockedUnlockSeats).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith('/reservas/nueva');

    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? 'null');
    expect(stored).toMatchObject({
      trip_id: 'trip-1',
      agency_id: 'ag-1',
      seats: [{ id: 'seat-5', seat_code: 'A5' }],
      passengers: [],
    });
    expect(stored.lock_expires_at).toBe(expires);
  });

  it('no permite continuar sin selección de asientos', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await act(async () => {
      fireEvent.click(btn('Continuar con la reserva'));
    });

    expect(mockedLockSeats).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(btn('Continuar con la reserva')).toBeDisabled();
  });

  it('restaura los locks vigentes guardados al volver al viaje', async () => {
    const seats = buildSeats(31);
    seats[4] = { ...seats[4], status: 'locked' };
    mockedTripDetail.mockResolvedValue({
      trip: buildTrip({
        seats,
        availability: {
          total: 31,
          available: 30,
          reserved: 0,
          locked: 1,
          blocked: 0,
          guide: 0,
        },
      }),
    });
    sessionStorage.setItem(
      LOCK_KEY,
      JSON.stringify({
        trip_id: 'trip-1',
        agency_id: 'ag-1',
        seats: [{ id: 'seat-5', seat_code: 'A5' }],
        lock_expires_at: futureExpiry(),
        passengers: [],
      }),
    );

    await renderPage();

    expect(btn('Asiento A5, seleccionado')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 asiento seleccionado: A5',
    );
    expect(screen.getByRole('timer')).toBeInTheDocument();
    expect(btn('Continuar con la reserva')).toBeEnabled();
    expect(mockedLockSeats).not.toHaveBeenCalled();
  });

  it('no restaura un lock que el servidor ya no marca como bloqueado', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    sessionStorage.setItem(
      LOCK_KEY,
      JSON.stringify({
        trip_id: 'trip-1',
        agency_id: 'ag-1',
        seats: [{ id: 'seat-5', seat_code: 'A5' }],
        lock_expires_at: futureExpiry(),
        passengers: [],
      }),
    );

    await renderPage();

    expect(btn('Asiento A5, disponible')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(btn('Continuar con la reserva')).toBeDisabled();
  });

  it('el countdown usa la expiración más próxima entre tus locks', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockSeats
      .mockResolvedValueOnce(buildLockResult(['seat-5'], futureExpiry(900_000)))
      .mockResolvedValueOnce(buildLockResult(['seat-3'], futureExpiry(100_000)));

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A5, disponible');
    await clickSeat('Asiento A3, disponible');

    expect(screen.getByRole('timer')).toHaveTextContent(
      /^Tu selección está reservada durante 01:\d{2}$/,
    );
  });

  it('libera los locks al abandonar la pantalla sin ir al wizard', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockSeats.mockImplementation(autoLock());

    const view = await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A5, disponible');
    expect(screen.getByRole('status')).toBeInTheDocument();

    await act(async () => {
      view.unmount();
    });

    expect(mockedUnlockSeats).toHaveBeenCalledWith(
      'trip-1',
      undefined,
      { keepalive: true },
    );
  });

  it('conserva los locks al navegar con Continuar', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockSeats.mockImplementation(autoLock());

    const view = await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A5, disponible');
    await act(async () => {
      fireEvent.click(btn('Continuar con la reserva'));
    });
    expect(pushMock).toHaveBeenCalledWith('/reservas/nueva');

    await act(async () => {
      view.unmount();
    });

    expect(mockedUnlockSeats).not.toHaveBeenCalled();
  });
});

describe('TripDetailPage — realtime de asientos (MKT-004)', () => {
  beforeEach(resetTestState);

  it('actualiza el mapa en vivo y suelta tu selección cuando otro toma tu asiento', async () => {
    const lockedSeats = buildSeats(31);
    lockedSeats[4] = { ...lockedSeats[4], status: 'locked' };
    mockedTripDetail
      .mockResolvedValueOnce({ trip: buildTrip() })
      .mockResolvedValue({
        trip: buildTrip({
          seats: lockedSeats,
          availability: {
            total: 31,
            available: 30,
            reserved: 0,
            locked: 1,
            blocked: 0,
            guide: 0,
          },
        }),
      });
    mockedLockSeats.mockImplementation(autoLock());

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });
    expect(realtime.seatHandlers).toHaveLength(1);
    expect(realtime.tripHandlers).toHaveLength(1);

    await clickSeat('Asiento A5, disponible');
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 asiento seleccionado: A5',
    );

    await act(async () => {
      realtime.seatHandlers[0]({
        eventType: 'UPDATE',
        seat: {
          id: 'seat-5',
          trip_id: 'trip-1',
          seat_code: 'A5',
          status: 'locked',
          locked_by: 'otro-usuario',
        },
      });
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(btn('Asiento A5, bloqueado')).toBeDisabled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'El asiento A5 ya no está disponible',
    );
    expect(screen.getByText('30 de 31 disponibles')).toBeInTheDocument();
    expect(screen.getByText('30 disponibles')).toBeInTheDocument();
    expect(btn('Continuar con la reserva')).toBeDisabled();
  });

  it('no suelta tu selección cuando el evento realtime es tu propio bloqueo', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    const expires = futureExpiry();
    let resolveLock!: (result: LockSeatsResult) => void;
    mockedLockSeats.mockReturnValue(
      new Promise<LockSeatsResult>((resolve) => {
        resolveLock = resolve;
      }),
    );

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A5, disponible');
    expect(btn(/Bloqueando asientos/)).toBeDisabled();

    // Evento de MI lock mientras la petición sigue en curso
    await act(async () => {
      realtime.seatHandlers[0]({
        eventType: 'UPDATE',
        seat: {
          id: 'seat-5',
          trip_id: 'trip-1',
          seat_code: 'A5',
          status: 'locked',
          locked_by: 'user-me',
        },
      });
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => {
      resolveLock(buildLockResult(['seat-5'], expires));
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 asiento seleccionado: A5',
    );
    expect(pushMock).not.toHaveBeenCalled();

    // El evento tardío del mismo lock tampoco deselecta
    await act(async () => {
      realtime.seatHandlers[0]({
        eventType: 'UPDATE',
        seat: {
          id: 'seat-5',
          trip_id: 'trip-1',
          seat_code: 'A5',
          status: 'locked',
          locked_by: 'user-me',
        },
      });
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 asiento seleccionado: A5',
    );
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('suelta tu selección cuando el backend libera tu lock', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockSeats.mockImplementation(autoLock());

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    await clickSeat('Asiento A5, disponible');
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 asiento seleccionado: A5',
    );

    // El cleanup del backend (cada 60s) emite el lock vencido como `available`
    await act(async () => {
      realtime.seatHandlers[0]({
        eventType: 'UPDATE',
        seat: {
          id: 'seat-5',
          trip_id: 'trip-1',
          seat_code: 'A5',
          status: 'available',
        },
      });
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(btn('Asiento A5, disponible')).toBeInTheDocument();
    expect(btn('Continuar con la reserva')).toBeDisabled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'El asiento A5 ya no está disponible',
    );
    expect(screen.getByText('31 de 31 disponibles')).toBeInTheDocument();
  });

  it('muestra el estado 404 con CTA si el viaje se cancela en tiempo real', async () => {
    mockedTripDetail
      .mockResolvedValueOnce({ trip: buildTrip() })
      .mockRejectedValueOnce(
        new ApiError('Viaje no encontrado', 'TRIP_NOT_FOUND', 404),
      );

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });
    expect(realtime.tripHandlers).toHaveLength(1);

    await act(async () => {
      realtime.tripHandlers[0]({
        eventType: 'UPDATE',
        trip: { id: 'trip-1', status: 'cancelled' },
      });
    });

    expect(
      await screen.findByRole('heading', { name: 'Viaje no encontrado' }),
    ).toBeInTheDocument();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Este viaje fue cancelado. Elige otro viaje disponible.',
    );
    expect(
      screen.getByRole('link', { name: /Ver viajes disponibles/ }),
    ).toHaveAttribute('href', '/viajes');
  });
});

describe('TripDetailPage — guest lock ownership + claim (Fase 4)', () => {
  beforeEach(resetTestState);

  /** Visitante NO autenticado que ya bloqueó A5 vía endpoint guest. */
  async function renderGuestWithSeat(params = makeParams('trip-1')) {
    becomeGuest();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockGuestSeats.mockResolvedValue(
      buildGuestLockResult(['seat-5'], futureExpiry(600_000)),
    );

    const view = await renderPage('trip-1', params);
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });
    await clickSeat('Asiento A5, disponible');

    expect(screen.getByRole('status')).toHaveTextContent(
      '1 asiento seleccionado: A5',
    );
    return view;
  }

  function authenticate() {
    authState.user = {
      id: 'user-me',
      email: 'cliente@test.com',
      role: 'customer',
    };
  }

  it('guest bloquea con el endpoint guest y nunca usa el autenticado', async () => {
    becomeGuest();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockGuestSeats.mockResolvedValue(
      buildGuestLockResult(['seat-5'], futureExpiry()),
    );

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });
    await clickSeat('Asiento A5, disponible');

    expect(mockedLockGuestSeats).toHaveBeenCalledTimes(1);
    expect(mockedLockGuestSeats).toHaveBeenCalledWith('trip-1', ['seat-5']);
    expect(mockedLockSeats).not.toHaveBeenCalled();
    expect(btn('Asiento A5, seleccionado')).toHaveAttribute(
      'data-state',
      'selected',
    );
    expect(screen.getByRole('timer')).toBeInTheDocument();
  });

  it('el countdown del guest deriva de lock_expires_at del servidor', async () => {
    becomeGuest();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    // 30s: si el cliente calculara Date.now()+900000 veríamos 15:00.
    mockedLockGuestSeats.mockResolvedValue(
      buildGuestLockResult(['seat-5'], futureExpiry(30_000)),
    );

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });
    await clickSeat('Asiento A5, disponible');

    expect(screen.getByRole('timer')).toHaveTextContent(
      /^Tu selección expira en 00:\d{2}$/,
    );
  });

  it('recupera los locks guest tras un refresh usando solo la cookie', async () => {
    becomeGuest();
    const expires = futureExpiry();
    const seats = buildSeats(31);
    seats[4] = { ...seats[4], status: 'locked' };
    mockedTripDetail.mockResolvedValue({
      trip: buildTrip({
        seats,
        availability: {
          total: 31,
          available: 30,
          reserved: 0,
          locked: 1,
          blocked: 0,
          guide: 0,
        },
      }),
    });
    mockedGetGuestLocks.mockResolvedValue(
      buildGuestLocksResult([
        { id: 'seat-5', seat_code: 'A5', lock_expires_at: expires },
      ]),
    );

    await renderPage();

    expect(mockedGetGuestLocks).toHaveBeenCalledWith('trip-1');
    expect(btn('Asiento A5, seleccionado')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 asiento seleccionado: A5',
    );
    expect(screen.getByRole('timer')).toBeInTheDocument();
    // Sin estado local: la propiedad sale de la cookie, no del storage.
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
    expect(mockedLockGuestSeats).not.toHaveBeenCalled();
  });

  it('sin cookie guest no restaura selección y el mapa sigue usable', async () => {
    becomeGuest();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    expect(mockedGetGuestLocks).toHaveBeenCalledWith('trip-1');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(btn('Continuar con la reserva')).toBeDisabled();
    expect(btn('Asiento A1, disponible')).toBeInTheDocument();
  });

  it('al autenticarse reclama UNA vez, conserva los seats y no re-lockea', async () => {
    const expires = futureExpiry(600_000);
    const params = makeParams('trip-1');
    const view = await renderGuestWithSeat(params);
    expect(mockedLockGuestSeats).toHaveBeenCalledTimes(1);

    mockedGetGuestLocks.mockResolvedValue(
      buildGuestLocksResult([
        { id: 'seat-5', seat_code: 'A5', lock_expires_at: expires },
      ]),
    );
    mockedClaimGuestLocks.mockResolvedValue(
      buildClaimResult([
        { id: 'seat-5', seat_code: 'A5', lock_expires_at: expires },
      ]),
    );

    authenticate();
    await rerenderPage(view, params);

    await waitFor(() => expect(mockedClaimGuestLocks).toHaveBeenCalledTimes(1));
    expect(mockedClaimGuestLocks).toHaveBeenCalledWith('trip-1');
    expect(btn('Asiento A5, seleccionado')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Tus asientos siguen bloqueados con tu cuenta',
    );
    // No se re-lockea: el TTL lo preserva el backend en el claim.
    expect(mockedLockGuestSeats).toHaveBeenCalledTimes(1);
    expect(mockedLockSeats).not.toHaveBeenCalled();

    // Un nuevo render NO dispara un segundo claim.
    await rerenderPage(view, params);
    expect(mockedClaimGuestLocks).toHaveBeenCalledTimes(1);
  });

  it('claim 401 GUEST_SESSION_EXPIRED limpia la selección guest y avisa', async () => {
    const params = makeParams('trip-1');
    const view = await renderGuestWithSeat(params);

    mockedGetGuestLocks.mockResolvedValue(
      buildGuestLocksResult([
        { id: 'seat-5', seat_code: 'A5', lock_expires_at: futureExpiry() },
      ]),
    );
    mockedClaimGuestLocks.mockRejectedValue(
      new ApiError('La sesión guest expiró', 'GUEST_SESSION_EXPIRED', 401),
    );

    authenticate();
    await rerenderPage(view, params);

    await waitFor(() => expect(mockedClaimGuestLocks).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(btn('Asiento A5, disponible')).toBeInTheDocument();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Tu selección expiró. Elige tus asientos de nuevo.',
    );
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it('claim 409 GUEST_SESSION_CLAIMED recupera el estado desde el backend', async () => {
    const expires = futureExpiry(600_000);
    const params = makeParams('trip-1');
    const view = await renderGuestWithSeat(params);

    mockedGetGuestLocks.mockResolvedValue(
      buildGuestLocksResult([
        { id: 'seat-5', seat_code: 'A5', lock_expires_at: expires },
      ]),
    );
    mockedClaimGuestLocks.mockRejectedValue(
      new ApiError('La sesión guest ya fue reclamada', 'GUEST_SESSION_CLAIMED', 409),
    );
    mockedMySeatLocks.mockResolvedValue({
      trip_id: 'trip-1',
      lock_expires_at: expires,
      seats: [{ id: 'seat-5', seat_code: 'A5', lock_expires_at: expires }],
    });

    authenticate();
    await rerenderPage(view, params);

    await waitFor(() => expect(mockedClaimGuestLocks).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mockedMySeatLocks).toHaveBeenCalledWith('trip-1'),
    );
    expect(btn('Asiento A5, seleccionado')).toBeInTheDocument();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Tus asientos siguen bloqueados con tu cuenta',
    );
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('claim 409 GUEST_CLAIM_CONFLICT no asume propiedad y refresca', async () => {
    const params = makeParams('trip-1');
    const view = await renderGuestWithSeat(params);

    mockedGetGuestLocks.mockResolvedValue(
      buildGuestLocksResult([
        { id: 'seat-5', seat_code: 'A5', lock_expires_at: futureExpiry() },
      ]),
    );
    mockedClaimGuestLocks.mockRejectedValue(
      new ApiError(
        'Los locks cambiaron durante el claim; no se adoptó ningún asiento',
        'GUEST_CLAIM_CONFLICT',
        409,
      ),
    );
    const serverExpiry = futureExpiry(300_000);
    mockedMySeatLocks.mockResolvedValue({
      trip_id: 'trip-1',
      lock_expires_at: serverExpiry,
      seats: [
        { id: 'seat-3', seat_code: 'A3', lock_expires_at: serverExpiry },
      ],
    });

    authenticate();
    await rerenderPage(view, params);

    await waitFor(() => expect(mockedClaimGuestLocks).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(btn('Asiento A3, seleccionado')).toBeInTheDocument(),
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('A5');
    expect(btn('Asiento A5, disponible')).toBeInTheDocument();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Los locks cambiaron durante el claim; no se adoptó ningún asiento',
    );
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it('usuario autenticado usa /lock y nunca crea sesión guest', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockSeats.mockImplementation(autoLock());

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });
    await clickSeat('Asiento A5, disponible');

    expect(mockedLockSeats).toHaveBeenCalledWith('trip-1', ['seat-5']);
    expect(mockedLockGuestSeats).not.toHaveBeenCalled();
    expect(btn('Asiento A5, seleccionado')).toBeInTheDocument();
  });

  it('guest libera con unlock-guest al re-elegir su asiento', async () => {
    await renderGuestWithSeat();
    await clickSeat('Asiento A5, seleccionado');

    expect(mockedUnlockGuestSeats).toHaveBeenCalledTimes(1);
    expect(mockedUnlockGuestSeats).toHaveBeenCalledWith('trip-1', ['seat-5']);
    expect(mockedUnlockSeats).not.toHaveBeenCalled();
    expect(btn('Asiento A5, disponible')).toBeInTheDocument();
  });

  it('guest que abandona la pantalla libera con unlock-guest, no con /unlock', async () => {
    const view = await renderGuestWithSeat();

    await act(async () => {
      view.unmount();
    });

    expect(mockedUnlockGuestSeats).toHaveBeenCalledWith(
      'trip-1',
      undefined,
      { keepalive: true },
    );
    expect(mockedUnlockSeats).not.toHaveBeenCalled();
  });

  it('customer que abandona la pantalla libera con /unlock, no con unlock-guest', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockSeats.mockImplementation(autoLock());

    const view = await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });
    await clickSeat('Asiento A5, disponible');

    await act(async () => {
      view.unmount();
    });

    expect(mockedUnlockSeats).toHaveBeenCalledWith(
      'trip-1',
      undefined,
      { keepalive: true },
    );
    expect(mockedUnlockGuestSeats).not.toHaveBeenCalled();
  });

  it('guest Continuar conserva los locks, persiste la selección y navega', async () => {
    const expires = futureExpiry(600_000);
    becomeGuest();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLockGuestSeats.mockResolvedValue(
      buildGuestLockResult(['seat-5'], expires),
    );

    const view = await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });
    await clickSeat('Asiento A5, disponible');

    await act(async () => {
      fireEvent.click(btn('Continuar con la reserva'));
    });

    expect(pushMock).toHaveBeenCalledWith('/reservas/nueva');
    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? 'null');
    expect(stored).toMatchObject({
      trip_id: 'trip-1',
      seats: [{ id: 'seat-5', seat_code: 'A5' }],
      lock_expires_at: expires,
    });

    // Al navegar con Continuar se conservan los locks: NO se liberan al salir.
    await act(async () => {
      view.unmount();
    });
    expect(mockedUnlockGuestSeats).not.toHaveBeenCalled();
    expect(mockedUnlockSeats).not.toHaveBeenCalled();
  });

  it('no identifica al propietario de un asiento ajeno', async () => {
    const seats = buildSeats(31);
    seats[4] = { ...seats[4], status: 'locked' };
    mockedTripDetail.mockResolvedValue({
      trip: buildTrip({
        seats,
        availability: {
          total: 31,
          available: 30,
          reserved: 0,
          locked: 1,
          blocked: 0,
          guide: 0,
        },
      }),
    });

    await renderPage();

    expect(btn('Asiento A5, bloqueado')).toBeInTheDocument();
    expect(screen.queryByText(/user-me/)).not.toBeInTheDocument();
    expect(screen.queryByText(/guest/i)).not.toBeInTheDocument();
  });
});
