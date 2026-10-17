import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import toast from 'react-hot-toast';
import {
  checkoutApi,
  publicApi,
  seatApi,
  type CreateCheckoutAttemptResult,
  type CheckoutAttemptView,
  type MySeatLocksResult,
  type PublicTripDetail,
  type PublicTripSeat,
  type SubmitCheckoutProofResult,
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
  checkoutApi: {
    createAttempt: vi.fn(),
    submitProof: vi.fn(),
    getAttempt: vi.fn(),
    cancelAttempt: vi.fn(),
    getPaymentMethods: vi.fn(),
    selectPaymentMethod: vi.fn(),
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
const mockedCreate = vi.mocked(checkoutApi.createAttempt);
const mockedSubmitProof = vi.mocked(checkoutApi.submitProof);
const mockedGetAttempt = vi.mocked(checkoutApi.getAttempt);
const mockedCancelAttempt = vi.mocked(checkoutApi.cancelAttempt);
const mockedGetPaymentMethods = vi.mocked(checkoutApi.getPaymentMethods);
const mockedSelectPaymentMethod = vi.mocked(checkoutApi.selectPaymentMethod);

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
        phone: null,
        payment_methods_available: true,
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

/**
 * LockState con un `checkout_attempt` ya creado (MKT-007). La pantalla
 * restaura este estado consultando `GET /public/checkout/attempts/:id`.
 */
function seedAttemptLock(
  checkoutOverrides: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  seedLock({
    attempt_id: 'att-1',
    attempt_key: 'b2f1f6d0-0000-4000-8000-000000000001',
    checkout: { status: 'created', attempt_id: 'att-1', ...checkoutOverrides },
    ...overrides,
  });
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

function createdAttempt(
  overrides: Partial<CreateCheckoutAttemptResult> = {},
): CreateCheckoutAttemptResult {
  return {
    attempt_id: 'att-1',
    trip_id: 'trip-1',
    agency_id: 'ag-1',
    customer_id: 'user-me',
    status: 'created',
    seat_ids: ['seat-1', 'seat-2'],
    passenger_count: 2,
    unit_price: 2020,
    amount_cents: 4040,
    proof_count: 0,
    expires_at: futureExpiry(),
    idempotent: false,
    ...overrides,
  };
}

/** Respuesta de `GET /public/checkout/attempts/:id` para restaurar la pantalla. */
function attemptView(
  overrides: Partial<CheckoutAttemptView> = {},
): CheckoutAttemptView {
  return {
    attempt_id: 'att-1',
    status: 'created',
    trip_id: 'trip-1',
    agency_id: 'ag-1',
    seat_ids: ['seat-1', 'seat-2'],
    seat_codes: ['A1', 'A2'],
    passenger_count: 2,
    unit_price: 2020,
    amount_cents: 4040,
    proof_count: 0,
    remaining_submissions: 3,
    payment_reference: null,
    bank_origin: null,
    payment_datetime: null,
    proof_submitted_at: null,
    review_started_at: null,
    rejection_reason: null,
    rejection_count: 0,
    expires_at: futureExpiry(),
    created_at: '2026-10-04T11:00:00.000Z',
    closed_at: null,
    verified_at: null,
    ...overrides,
  };
}

// ── MKT-007.4 · Canales de pago del intento ──────────────────────────────

function pagoMovilMethod(
  overrides: Partial<{
    id: string;
    label: string;
    is_primary: boolean;
    phone: string;
  }> = {},
) {
  const { id = 'pm-1', label = 'Pago móvil principal', is_primary = true, phone = '04121234567' } =
    overrides;
  return {
    id,
    method: 'pago_movil',
    label,
    data: {
      bank_code: '0134',
      bank_name: 'Banco Nacional',
      phone,
      document_type: 'V',
      document_number: '12345678',
      holder_name: 'Agencia Central',
      account_type: 'savings',
      account_number: '01340123456789012345',
    },
    is_primary,
    sort_order: 0,
  };
}

function paymentMethodsView(
  overrides: Partial<{
    status: string;
    selected_method_id: string | null;
    methods: ReturnType<typeof pagoMovilMethod>[];
    agency_phone: string | null;
    amount_cents: number;
  }> = {},
) {
  const {
    status = 'created',
    selected_method_id = null,
    methods = [pagoMovilMethod()],
    agency_phone = '04121234567',
    amount_cents = 4040,
  } = overrides;
  return {
    attempt_id: 'att-1',
    status,
    amount_cents,
    selected_method_id,
    methods,
    agency_phone,
  };
}

/**
 * Flujo real MKT-007.4: tras crear/restaurar el intento hay que elegir un
 * canal ANTES de que aparezca el uploader. Los tests de comprobante usan
 * este helper para completar el paso de canales sin reescribir su asunto.
 */
async function selectFirstPaymentMethodViaUi() {
  const selectButtons = await screen.findAllByRole('button', {
    name: 'Elegir',
  });
  await act(async () => {
    fireEvent.click(selectButtons[0]);
  });
}

// Aplica a todos los describes del archivo: customer autenticado por defecto
// y creación de reserva resuelta (los tests la sobreescriben cuando hace falta).
beforeEach(() => {
  authState.user = { id: 'user-me', email: 'cliente@test.com', role: 'customer' };
  authState.loading = false;
  search.value = '';
  mockedCreate.mockReset();
  mockedCreate.mockResolvedValue(createdAttempt());
  mockedGetAttempt.mockReset();
  mockedGetAttempt.mockResolvedValue(attemptView());
  mockedCancelAttempt.mockReset();
  // MKT-007.4: por defecto el canal ya está elegido para que los tests de
  // comprobante (MKT-007) prueben su asunto sin repetir el paso de canales.
  // Los tests de canales sobreescriben este mock.
  mockedGetPaymentMethods.mockReset();
  mockedGetPaymentMethods.mockResolvedValue(
    paymentMethodsView({ selected_method_id: 'pm-1' }),
  );
  mockedSelectPaymentMethod.mockReset();
  mockedSelectPaymentMethod.mockResolvedValue({
    attempt_id: 'att-1',
    status: 'created',
    amount_cents: 4040,
    payment_method_id: 'pm-1',
    payment_method_snapshot: { snapshot_version: 1 },
    idempotent: false,
  });
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
        screen.getByRole('button', { name: 'Continuar al pago' }),
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
        screen.getByRole('button', { name: 'Continuar al pago' }),
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
        screen.getByRole('button', { name: 'Continuar al pago' }),
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
    // MKT-007.4: el importe aparece en el resumen y en la sección de canales.
    expect(screen.getAllByText('$40,40').length).toBeGreaterThan(0);
    expect(screen.getByText('Compra iniciada')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Tus asientos quedaron retenidos y tus pasajeros están guardados/,
      ),
    ).toBeInTheDocument();
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    // Tras crear: sin botón de confirmación y pasajeros bloqueados.
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
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
  // Hardening MKT-004 instala timers falsos sin restaurarlos; los describes
  // posteriores (waitFor / findByRole) necesitan timers reales.
  vi.useRealTimers();
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
  mockedSubmitProof.mockReset();
}

// Checkout de una sola página: completar pasajeros y pulsar "Continuar al pago"
// valida y dispara el POST de la reserva (antes era navegar al step de pago).
async function createAttemptViaUi(view: ReturnType<typeof render>) {
  await fillValidPassengers(view);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Continuar al pago' }));
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
    expect(screen.queryByText('Compra iniciada')).not.toBeInTheDocument();
  });

  it('autenticado no muestra el gate y crea la reserva al confirmar', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();

    expect(
      screen.queryByText('Para continuar con el pago, debes iniciar sesión.'),
    ).not.toBeInTheDocument();

    await createAttemptViaUi(view);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Compra iniciada')).toBeInTheDocument();
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
    // El intento debe expirar exactamente cuando el lock: re-mockeamos aquí
    // para no depender de la coincidencia de dos llamadas a futureExpiry().
    mockedCreate.mockResolvedValue(createdAttempt({ expires_at: expires }));
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

    await createAttemptViaUi(view);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Compra iniciada')).toBeInTheDocument();
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

    await createAttemptViaUi(view);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Compra iniciada')).toBeInTheDocument();
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
    await createAttemptViaUi(view);

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
    },
      expect.any(String),
    );
    const payload = mockedCreate.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('customer_id');
    expect(payload).not.toHaveProperty('unit_price');
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('source');
    // La `Idempotency-Key` viaja en el header, nunca en el cuerpo.
    expect(String(mockedCreate.mock.calls[0][1])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(JSON.stringify(payload)).not.toContain('attempt_key');
  });

  it('guarda attempt_id y el marcador de checkout en LockState', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createAttemptViaUi(view);

    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? '{}');
    expect(stored.attempt_id).toBe('att-1');
    expect(stored.checkout).toMatchObject({
      status: 'created',
      attempt_id: 'att-1',
    });
    expect(stored.passengers).toHaveLength(2);
    expect(stored.passengers[0]).toMatchObject({
      seat_id: 'seat-1',
      document: '12345678',
    });
    expect(stored).not.toHaveProperty('customer_id');
    expect(stored).not.toHaveProperty('unit_price');
    // Ningún marcador del formato anterior.
    expect(stored).not.toHaveProperty('reservation_id');
    expect(stored).not.toHaveProperty('payment');
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Compra iniciada. Ahora envía tu comprobante de pago.',
    );
  });

  it('200 idempotent se trata como éxito y muestra el placeholder de pago', async () => {
    mockedCreate.mockResolvedValue(
      createdAttempt({ idempotent: true, attempt_id: 'att-9' }),
    );
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createAttemptViaUi(view);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Compra iniciada')).toBeInTheDocument();
    expect(
      screen.getByText(
        /La reserva definitiva se crea cuando la agencia apruebe tu comprobante/,
      ),
    ).toBeInTheDocument();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? '{}');
    expect(stored.attempt_id).toBe('att-9');
  });

  it('no duplica el POST con la petición aún en vuelo', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    let resolveCreate!: (value: CreateCheckoutAttemptResult) => void;
    mockedCreate.mockImplementation(
      () =>
        new Promise<CreateCheckoutAttemptResult>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const view = await renderWizard();
    await fillValidPassengers(view);
    fireEvent.click(
      screen.getByRole('button', { name: 'Continuar al pago' }),
    );
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    // Estado loading (§12): el botón queda deshabilitado mientras hay POST en vuelo.
    const pendingButton = screen.getByRole('button', {
      name: 'Iniciando tu compra…',
    });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate(createdAttempt());
    });
    expect(screen.getByText('Compra iniciada')).toBeInTheDocument();
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
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
    await createAttemptViaUi(view);
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    expect(
      screen.getByRole('heading', { name: 'Datos de los pasajeros' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Comprobante de pago' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      view.container.querySelector('#passenger-0-first-name'),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cambiar asientos' })).toBeDisabled();

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Compra iniciada')).toBeInTheDocument();
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
    await createAttemptViaUi(view);

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
    await createAttemptViaUi(view);

    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Elegir asientos de nuevo/ }),
    ).toBeInTheDocument();
    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? '{}');
    expect(stored.attempt_id).toBeUndefined();
  });

  it('TRIP_PRICE_MISSING muestra error específico sin reenviar precio', async () => {
    mockedCreate.mockRejectedValue(
      new ApiError('Trip has no seat_price', 'TRIP_PRICE_MISSING', 422),
    );
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await createAttemptViaUi(view);

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
    await createAttemptViaUi(view);

    expect(screen.getByRole('alert')).toHaveTextContent('boom interno');
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    });

    expect(mockedCreate).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Compra iniciada')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Persistencia del intento de compra (MKT-007)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  it('refresh con attempt_id restaura desde el servidor sin re-POST', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();

    expect(mockedGetAttempt).toHaveBeenCalledWith('att-1');
    expect(mockedCreate).not.toHaveBeenCalled();
    // El intento ya dueña de los asientos: no se revalidan locks temporales
    // ni se reclama la sesión guest.
    expect(mockedLocks).not.toHaveBeenCalled();
    expect(mockedClaimGuestLocks).not.toHaveBeenCalled();
    expect(mockedGetGuestLocks).not.toHaveBeenCalled();

    expect(screen.getByRole('heading', { name: 'Pago' })).toBeInTheDocument();
    expect(screen.getByText('Compra iniciada')).toBeInTheDocument();
    expect(
      screen.getByText(
        /La reserva definitiva se crea cuando la agencia apruebe tu comprobante/,
      ),
    ).toBeInTheDocument();
    // Una sola pantalla: el comprobante convive con el resto de secciones.
    expect(
      screen.getByRole('heading', { name: 'Comprobante de pago' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
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

  it('reintentar tras un refresh con intento creado no crea un segundo intento', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    expect(mockedCreate).not.toHaveBeenCalled();

    // El guard de attempt_id bloquea el POST aunque se reintente la verificación.
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Cambiar asientos' }),
      );
    });

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(screen.getByText('Compra iniciada')).toBeInTheDocument();
    const stored = JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? '{}');
    expect(stored.attempt_id).toBe('att-1');
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
    ).not.toBeInTheDocument();
    expect(view.container.querySelector('#passenger-1-first-name')).toBeDisabled();
  });

  it('un intento terminal en el servidor reinicia la selección con su CTA', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetAttempt.mockResolvedValue(
      attemptView({ status: 'expired', closed_at: '2026-10-04T12:00:00.000Z' }),
    );

    await renderWizard();

    expect(mockedGetAttempt).toHaveBeenCalledWith('att-1');
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
    expect(screen.getByText('0 seleccionados')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Elige tus asientos' }),
    ).toBeInTheDocument();
  });

  it('un intento inexistente o ajeno reinicia la selección sin inventar nada', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetAttempt.mockRejectedValue(
      new ApiError('Intento no encontrado', 'NOT_FOUND', 404),
    );

    await renderWizard();

    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
    expect(screen.getByText('0 seleccionados')).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('el intento aprobado solo se pinta cuando lo dice el servidor', async () => {
    seedAttemptLock(
      { status: 'pending_review', remaining_submissions: 0 },
      { lock_expires_at: '2099-01-01T00:00:00.000Z' },
    );
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetAttempt.mockResolvedValue(
      attemptView({
        status: 'verified',
        proof_count: 1,
        remaining_submissions: 0,
        proof_submitted_at: '2026-10-04T11:00:00.000Z',
        verified_at: '2026-10-04T11:10:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
      }),
    );

    await renderWizard();

    expect(screen.getAllByText('Pago aprobado').length).toBeGreaterThan(0);
    expect(screen.getByText(/Tu pago fue aprobado/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Enviar comprobante' }),
    ).not.toBeInTheDocument();
    // El cliente nunca lo declara por su cuenta: el marcador local se queda en
    // un estado no comprometido y la aprobación sale SOLO de `verified_at`.
    expect(storedLock().checkout).toMatchObject({ status: 'created' });
    expect(storedLock().checkout).not.toHaveProperty('paid_at');
    expect(storedLock()).not.toHaveProperty('paid');
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
      screen.queryByRole('button', { name: 'Continuar al pago' }),
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
      screen.getByRole('button', { name: 'Continuar al pago' }),
    ).toBeInTheDocument();
    // Precio por asiento real del viaje (2020 centavos) en el resumen.
    expect(screen.getByText('Precio por asiento')).toBeInTheDocument();
    expect(screen.getAllByText('$20,20')).toHaveLength(2);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('un viaje con seat_price en cero lo trata como precio explícito y deja el checkout operativo', async () => {
    search.value = '?trip=trip-1';
    mockedTripDetail.mockResolvedValue({ trip: buildTrip({ seat_price: 0 }) });
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

    // Cero es un valor real: se pinta y el CTA de reserva sigue disponible.
    expect(screen.getAllByText('$0,00')).toHaveLength(2);
    expect(screen.queryByText('Precio por definir')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continuar al pago' }),
    ).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('un viaje sin seat_price bloquea el avance y no pinta importes ficticios', async () => {
    search.value = '?trip=trip-1';
    mockedTripDetail.mockResolvedValue({ trip: buildTrip({ seat_price: null }) });
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

    // Sin importe ficticio: "Precio por definir" y total sin calcular.
    expect(screen.getByText('Precio por definir')).toBeInTheDocument();
    expect(screen.queryByText('$250,00')).not.toBeInTheDocument();
    expect(screen.queryByText('Placeholder')).not.toBeInTheDocument();
    // No hay CTA de reserva/pago y jamás se invoca el backend.
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Este viaje todavía no tiene un precio publicado/),
    ).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('un viaje sin seat_price conserva la selección guardada y bloquea el avance', async () => {
    search.value = '?trip=trip-1';
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip({ seat_price: null }) });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    expect(
      screen.getByRole('heading', { name: 'Elige tus asientos' }),
    ).toBeInTheDocument();
    // Sin importe ficticio para la selección persistida (2 asientos).
    expect(screen.queryByText('$500,00')).not.toBeInTheDocument();
    expect(screen.getByText('Precio por definir')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
    ).not.toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
    // La UI no destruye la selección del usuario: el TTL sigue su curso.
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
      screen.getByRole('button', { name: 'Continuar al pago' }),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(900_000);
    });

    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
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
      screen.getByRole('button', { name: 'Continuar al pago' }),
    ).toBeInTheDocument();

    // En el instante exacto en que llega a 0 la selección queda vencida.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
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
      screen.getByRole('heading', { name: 'Pago' }),
    ).toBeInTheDocument();

    // Sin CTA de creación no hay POST posible desde la UI.
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
    ).not.toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});


// ── MKT-005 Fase 3 ─────────────────────────────────────────────────────────
// Envío del comprobante al endpoint de Fase 2 y recuperación de la revisión.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Respuesta de `POST /public/checkout/attempts/:id/proof`. */
function proofResult(
  overrides: Partial<SubmitCheckoutProofResult> = {},
): SubmitCheckoutProofResult {
  return {
    attempt_id: 'att-1',
    status: 'pending_review',
    proof_count: 1,
    remaining_submissions: 2,
    proof_path: 'payment-proofs/att-1/1/comprobante.png',
    payment_reference: '00123456789',
    bank_origin: 'Banco de Venezuela',
    payment_datetime: '2020-01-01T10:00',
    amount_cents: 4040,
    // Ventana de 24 h calculada por el backend; el cliente solo la lee.
    expires_at: '2099-01-01T00:00:00.000Z',
    idempotent: false,
    ...overrides,
  };
}

function proofFile(
  name = 'comprobante.png',
  type = 'image/png',
  size?: number,
): File {
  const file = new File(['contenido-del-comprobante'], name, { type });
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { value: size, configurable: true });
  }
  return file;
}

function selectProofFile(view: ReturnType<typeof render>, file: File) {
  const input = view.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
    writable: true,
  });
  fireEvent.change(input);
}

/**
 * Conciliación: los tres campos son obligatorios y viajan junto al archivo.
 * Un valor de fecha en el pasado evita el rechazo `PAYMENT_IN_FUTURE`.
 */
function fillReconciliation(view: ReturnType<typeof render>) {
  const fill = (selector: string, value: string) => {
    const input = view.container.querySelector(selector) as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
  };
  fill('#proof-reference', '00123456789');
  fill('#proof-bank', 'Banco de Venezuela');
  fill('#proof-datetime', '2020-01-01T10:00');
}

async function submitProofViaUi(
  view: ReturnType<typeof render>,
  file: File = proofFile(),
  { fill = true }: { fill?: boolean } = {},
) {
  selectProofFile(view, file);
  if (fill) fillReconciliation(view);
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: 'Enviar comprobante' }),
    );
  });
  // La clave de idempotencia sale de la huella del contenido, que es
  // asíncrona: `vi.waitFor` deja terminar la cadena de envío (también con
  // timers falsos) y evita que una continuación se filtre al siguiente test.
  await vi.waitFor(() => {
    expect(
      screen.queryByRole('button', { name: /Enviando comprobante/ }),
    ).not.toBeInTheDocument();
  });
}


function storedLock() {
  return JSON.parse(sessionStorage.getItem(LOCK_KEY) ?? '{}') as Record<
    string,
    unknown
  >;
}

const REVIEW_TEXT = 'Comprobante enviado. Tu pago está pendiente de revisión.';

describe('Comprobante de pago (MKT-007)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tras iniciar la compra permite enviar el comprobante y pasa a revisión', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedSubmitProof.mockResolvedValue(proofResult());

    const view = await renderWizard();
    await createAttemptViaUi(view);

    expect(
      screen.getByText(
        /La reserva definitiva se crea cuando la agencia apruebe tu comprobante/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Pago pendiente')).toBeInTheDocument();
    // MKT-007.4: el uploader aparece tras elegir el canal (por defecto el
    // fixture lo trae preseleccionado).
    expect(
      await screen.findByRole('button', { name: 'Enviar comprobante' }),
    ).toBeInTheDocument();
    // MKT-007.1: tras crear el intento no hay countdown de revisión, solo
    // el mensaje por estado (aún no hay comprobante: copy de `created`).
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(
      screen.getByText('Tus asientos quedan retenidos mientras envías el comprobante.'),
    ).toBeInTheDocument();

    const lockBefore = storedLock();
    await submitProofViaUi(view);

    expect(mockedSubmitProof).toHaveBeenCalledTimes(1);
    const [attemptId, file, reconciliation, key] =
      mockedSubmitProof.mock.calls[0];
    expect(attemptId).toBe('att-1');
    expect(file.name).toBe('comprobante.png');
    // La conciliación viaja como campos sueltos, nunca dentro del binario.
    expect(reconciliation).toEqual({
      payment_reference: '00123456789',
      bank_origin: 'Banco de Venezuela',
      // El `datetime-local` se normaliza a ISO-8601 antes de salir del cliente.
      payment_datetime: '2020-01-01T10:00:00.000Z',
    });
    expect(key).toMatch(UUID_RE);

    expect(screen.getByText(REVIEW_TEXT)).toBeInTheDocument();
    expect(screen.getByText('Pendiente de revisión')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith(REVIEW_TEXT);

    // Nunca una reserva "confirmada" ni "pagada" cuando solo se envió el comprobante.
    expect(screen.queryByText('Confirmada')).not.toBeInTheDocument();
    expect(screen.queryByText('Pagada')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Enviar comprobante' }),
    ).not.toBeInTheDocument();

    const lockAfter = storedLock();
    expect(lockAfter.attempt_id).toBe('att-1');
    expect(lockAfter.checkout).toMatchObject({
      status: 'pending_review',
      attempt_id: 'att-1',
      proof_count: 1,
      remaining_submissions: 2,
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    // La ventana que gobierna la pantalla es la que calculó el backend.
    expect(lockAfter.lock_expires_at).toBe('2099-01-01T00:00:00.000Z');
    expect(lockAfter.lock_expires_at).not.toBe(lockBefore.lock_expires_at);
    // Nunca se persiste el binario del archivo.
    expect(lockAfter).not.toHaveProperty('proof');
    expect(JSON.stringify(lockAfter)).not.toContain('contenido-del-comprobante');

    // El intento ya creado no se vuelve a POSTear.
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it('al recargar con el comprobante enviado restaura la revisión sin claim ni validación de locks', async () => {
    seedAttemptLock(
      {
        status: 'pending_review',
        submitted_at: '2026-10-04T12:00:00.000Z',
        proof_count: 1,
        remaining_submissions: 2,
        expires_at: '2099-01-01T00:00:00.000Z',
      },
      { lock_expires_at: '2099-01-01T00:00:00.000Z' },
    );
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetAttempt.mockResolvedValue(
      attemptView({
        status: 'pending_review',
        proof_count: 1,
        remaining_submissions: 2,
        proof_submitted_at: '2026-10-04T12:00:00.000Z',
        payment_reference: '00123456789',
        bank_origin: 'Banco de Venezuela',
        payment_datetime: '2026-10-04T10:00:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
      }),
    );

    await renderWizard();

    expect(mockedTripDetail).toHaveBeenCalledTimes(1);
    expect(mockedClaimGuestLocks).not.toHaveBeenCalled();
    expect(mockedGetGuestLocks).not.toHaveBeenCalled();
    expect(mockedLocks).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();

    expect(screen.getByText(REVIEW_TEXT)).toBeInTheDocument();
    expect(screen.getByText('Pendiente de revisión')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Enviar comprobante' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Elige tus asientos' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Datos de los pasajeros' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pago' })).toBeInTheDocument();
    expect(screen.getByText(/Enviado el/)).toBeInTheDocument();
    // El folio de compra es el intento, no una reserva inexistente.
    expect(screen.getByText('att-1')).toBeInTheDocument();
  });

  it('ignora un marcador de checkout malformado y aplica la recuperación habitual', async () => {
    seedLock({ attempt_id: 'att-1', checkout: { status: 'nope' } });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    expect(
      screen.getByText('No tienes una selección activa'),
    ).toBeInTheDocument();
    expect(mockedTripDetail).not.toHaveBeenCalled();
    expect(mockedLocks).not.toHaveBeenCalled();
  });

  it('la ventana vencida no borra la revisión ni habla de la selección', async () => {
    // Nota: MKT-007.1 eliminó el countdown de revisión, así que con timers
    // falsos la ventana ya vencida debe seguir pintando el mensaje por
    // estado y jamás tocar la selección de asientos.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T11:45:00.000Z'));
    seedAttemptLock(
      {
        status: 'pending_review',
        submitted_at: '2026-10-04T11:00:00.000Z',
        proof_count: 1,
        remaining_submissions: 2,
        expires_at: '2026-10-04T11:44:00.000Z',
      },
      { lock_expires_at: '2026-10-04T11:44:00.000Z' },
    );
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetAttempt.mockResolvedValue(
      attemptView({
        status: 'pending_review',
        proof_count: 1,
        remaining_submissions: 2,
        proof_submitted_at: '2026-10-04T11:00:00.000Z',
        expires_at: '2026-10-04T11:44:00.000Z',
      }),
    );

    await renderWizard();

    act(() => {
      vi.advanceTimersByTime(901_000);
    });

    expect(screen.getByText(REVIEW_TEXT)).toBeInTheDocument();
    // MKT-007.1: sin countdown en revisión; el mensaje por estado manda.
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Tu comprobante está en revisión. Dentro de 24 horas recibirás respuesta.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Revisión en curso/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Tu selección expiró' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Tu selección expiró.')).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(
      (storedLock().checkout as Record<string, unknown>).status,
    ).toBe('pending_review');
  });

  it('la pérdida realtime de asientos tras el envío no borra la revisión', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedSubmitProof.mockResolvedValue(proofResult());

    const view = await renderWizard();
    await submitProofViaUi(view);

    expect(screen.getByText('2 seleccionados')).toBeInTheDocument();

    await act(async () => {
      realtime.seatHandlers.forEach((handler) =>
        handler({
          eventType: 'DELETE',
          seat: {
            id: 'seat-1',
            trip_id: 'trip-1',
            seat_code: 'A1',
            status: 'locked',
          },
        }),
      );
    });

    expect(screen.getByText(REVIEW_TEXT)).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Tu selección expiró' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('2 seleccionados')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('CHECKOUT_PROOF_PENDING muestra la revisión conservadora sin un segundo envío', async () => {
    seedAttemptLock({
      status: 'pending_review',
      submitted_at: '2026-10-04T12:00:00.000Z',
      proof_count: 1,
      remaining_submissions: 2,
    });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedSubmitProof.mockRejectedValue(
      new ApiError(
        'El comprobante de esta compra ya fue enviado',
        'CHECKOUT_PROOF_PENDING',
        409,
      ),
    );

    const view = await renderWizard();
    await submitProofViaUi(view);

    expect(screen.getByText(REVIEW_TEXT)).toBeInTheDocument();
    expect(screen.getByText('Pendiente de revisión')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Enviar comprobante' }),
    ).not.toBeInTheDocument();
    // Sin ids inventados: esta respuesta no trae datos nuevos.
    expect(storedLock().checkout).toMatchObject({ status: 'pending_review' });
    expect(storedLock().checkout).not.toHaveProperty('proof_path');
    // El toast vive fuera del DOM (mockeado): se afirma la llamada, no el nodo.
    expect(toast.success).toHaveBeenCalledWith(
      'Tu comprobante ya estaba enviado y sigue en revisión.',
    );
  });

  it('CHECKOUT_IDEMPOTENCY_CONFLICT no marca la revisión y conserva la selección', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedSubmitProof.mockRejectedValue(
      new ApiError(
        'La clave de idempotencia ya se usó con otro comprobante',
        'CHECKOUT_IDEMPOTENCY_CONFLICT',
        409,
      ),
    );

    const view = await renderWizard();
    await submitProofViaUi(view);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'otra clave de idempotencia',
    );
    expect(
      screen.getByRole('button', { name: 'Enviar comprobante' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(REVIEW_TEXT)).not.toBeInTheDocument();
    expect(storedLock().checkout).toMatchObject({ status: 'created' });
    expect(storedLock().checkout).not.toHaveProperty('submitted_at');
    expect(toast.success).not.toHaveBeenCalled();
    expect(view).toBeTruthy();
  });

  it('un archivo inválido o demasiado grande no llega al servidor', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();

    await submitProofViaUi(
      view,
      proofFile('comprobante.png', 'image/png', 6 * 1024 * 1024),
    );

    expect(
      screen.getByText('El comprobante no puede superar 5 MB.'),
    ).toBeInTheDocument();
    expect(mockedSubmitProof).not.toHaveBeenCalled();

    await submitProofViaUi(view, proofFile('datos.txt', 'text/plain'));

    expect(
      screen.getByText(
        'Adjunta el comprobante en formato PNG, JPEG, WEBP o PDF.',
      ),
    ).toBeInTheDocument();
    expect(mockedSubmitProof).not.toHaveBeenCalled();
  });

  it('los campos de conciliación son obligatorios y con label visible', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();

    expect(
      screen.getByText('Referencia de la transferencia'),
    ).toBeInTheDocument();
    expect(screen.getByText('Banco de origen')).toBeInTheDocument();
    expect(screen.getByText('Fecha y hora del pago')).toBeInTheDocument();

    await submitProofViaUi(view, proofFile(), { fill: false });

    expect(mockedSubmitProof).not.toHaveBeenCalled();
    expect(
      screen.getByText('Escribe la referencia de la transferencia.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Escribe el banco desde el que hiciste la transferencia.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Indica la fecha y hora del pago.'),
    ).toBeInTheDocument();
    expect(view).toBeTruthy();
  });

  it('un error de red permite reintentar sin perder la compra iniciada', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedSubmitProof.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const view = await renderWizard();
    await submitProofViaUi(view);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Enviar comprobante' }),
    ).toBeInTheDocument();
    expect(storedLock().checkout).toMatchObject({ status: 'created' });
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
    ).not.toBeInTheDocument();
    expect(view.container.querySelector('#passenger-0-first-name')).toBeDisabled();
  });
});

// ══════════════════════════════════════════════════════════════════════
// MKT-007 / MKT-007.1 — sin intento la píldora habla de la SELECCIÓN;
// con intento activo ya no existe la píldora: solo el mensaje por estado.
// ══════════════════════════════════════════════════════════════════════

describe('Indicador de expiración con revisión pendiente (MKT-007)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sin intento la selección expirada sigue mostrando el indicador', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T11:45:00.000Z'));
    seedLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    // Sin marcador de checkout el countdown se pinta con normalidad.
    expect(screen.getByRole('timer')).toHaveTextContent(
      'Tu selección está reservada durante 15:00',
    );

    act(() => {
      vi.advanceTimersByTime(900_000);
    });

    expect(screen.getByText('Tu selección expiró')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Elegir asientos de nuevo/ }),
    ).toBeInTheDocument();
  });

  it('con revisión pendiente no hay countdown: solo el mensaje por estado', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T11:45:00.000Z'));
    seedAttemptLock(
      {
        status: 'pending_review',
        submitted_at: '2026-10-04T11:00:00.000Z',
        proof_count: 1,
        remaining_submissions: 2,
        // Ventana ya vencida: la expiración ocurre con la revisión en curso.
        expires_at: '2026-10-04T11:44:00.000Z',
      },
      { lock_expires_at: '2026-10-04T11:44:00.000Z' },
    );
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetAttempt.mockResolvedValue(
      attemptView({
        status: 'pending_review',
        proof_count: 1,
        remaining_submissions: 2,
        proof_submitted_at: '2026-10-04T11:00:00.000Z',
        expires_at: '2026-10-04T11:44:00.000Z',
      }),
    );

    await renderWizard();

    expect(screen.getByText(REVIEW_TEXT)).toBeInTheDocument();
    expect(mockedLocks).not.toHaveBeenCalled();
    expect(screen.queryByText('Tu selección expiró.')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Tu selección expiró' }),
    ).not.toBeInTheDocument();
    // MKT-007.1: la ventana vencida ya no dibuja ningún countdown.
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Tu comprobante está en revisión. Dentro de 24 horas recibirás respuesta.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Revisión en curso/)).not.toBeInTheDocument();

    // Solo cambia ese indicador: el resto del checkout sigue en pantalla.
    expect(
      screen.getByRole('heading', { name: 'Elige tus asientos' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pago' })).toBeInTheDocument();
  });

  it('marcador inválido: se descarta y se conserva el comportamiento normal', async () => {
    seedLock({ attempt_id: 'att-1', checkout: { status: 'confirmed' } });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    // Un marcador que no pasa `isValidCheckoutMarker` invalida la LockState
    // entera: sin atajo de revisión y sin indicador oculto.
    expect(
      screen.getByText('No tienes una selección activa'),
    ).toBeInTheDocument();
    expect(screen.queryByText(REVIEW_TEXT)).not.toBeInTheDocument();
    expect(mockedTripDetail).not.toHaveBeenCalled();
    expect(mockedLocks).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
// MKT-007.1 — mensaje simple por estado, SIN countdown de revisión y sin
// copy que mienta ("ventana de revisión") ni exponga intentos/motivos.
// ══════════════════════════════════════════════════════════════════════

describe('Mensaje de revisión sin countdown (MKT-007.1)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  async function renderWithAttempt(overrides: Partial<CheckoutAttemptView>) {
    seedAttemptLock({ status: overrides.status ?? 'created' });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetAttempt.mockResolvedValue(attemptView(overrides));
    await renderWizard();
  }

  it('pending_review: mensaje de revisión y ningún countdown en pantalla', async () => {
    await renderWithAttempt({
      status: 'pending_review',
      proof_count: 1,
      remaining_submissions: 2,
      proof_submitted_at: '2026-10-04T11:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
    });

    expect(
      screen.getByText(
        'Tu comprobante está en revisión. Dentro de 24 horas recibirás respuesta.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    // Ningún reloj tipo "1435:38" / "HH:MM:SS" debe sobrevivir.
    expect(document.body.textContent).not.toMatch(/\b\d{3,}:\d{2}\b/);
    expect(screen.queryByText(/Revisión en curso/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/La ventana de revisión terminó/),
    ).not.toBeInTheDocument();
  });

  it('rejected: mensaje de rechazo sin countdown ni "Revisión en curso"', async () => {
    await renderWithAttempt({
      status: 'rejected',
      proof_count: 1,
      remaining_submissions: 2,
      proof_submitted_at: '2026-10-04T11:00:00.000Z',
      rejection_reason: 'Comprobante ilegible',
    });

    expect(
      screen.getByText(
        'Comprobante rechazado. Puedes enviar un comprobante válido.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.queryByText(/Revisión en curso/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/La ventana de revisión terminó/),
    ).not.toBeInTheDocument();
    // Copy del ticket: ni el motivo ni el contador de reenvíos.
    expect(screen.queryByText('Comprobante ilegible')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Te quedan \d+ reenvíos/),
    ).not.toBeInTheDocument();
  });

  it('rejected_final: mensaje de cierre sin contadores ni motivo', async () => {
    seedAttemptLock({ status: 'rejected' });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetAttempt.mockResolvedValue(
      attemptView({
        status: 'rejected_final',
        proof_count: 3,
        remaining_submissions: 0,
        rejection_reason: 'Monto no coincide',
      }),
    );

    await renderWizard();

    // El marcador colapsa rejected_final → rejected, pero el estado CRUDO
    // del banner decide el copy de cierre.
    expect(
      screen.getByText(
        'Comprobante rechazado. No es posible enviar más comprobantes. Tus asientos quedaron liberados.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.queryByText('Monto no coincide')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Te quedan \d+ reenvíos/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Se agotaron los reenvíos de comprobante para esta compra. Cancela la compra para elegir otros asientos.',
      ),
    ).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════
// MKT-007 §8 — cancelación del intento: acción destructiva → SIEMPRE modal
// (AGENTS.md §3 y §15: nunca `window.confirm`).
// ══════════════════════════════════════════════════════════════════════

describe('Cancelación de la compra (MKT-007)', () => {
  beforeEach(() => {
    resetCheckoutTest();
    mockedCancelAttempt.mockResolvedValue({
      attempt_id: 'att-1',
      status: 'cancelled',
      already_cancelled: false,
      freed_seats: 2,
    });
  });

  it('la cancelación siempre pasa por el modal de confirmación', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    expect(
      screen.getByRole('button', { name: 'Cancelar compra' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar compra' }));
    expect(mockedCancelAttempt).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '¿Cancelar esta compra?',
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sí, cancelar compra' }),
      );
    });

    expect(mockedCancelAttempt).toHaveBeenCalledWith('att-1');
    expect(toast.success).toHaveBeenCalledWith(
      'Compra cancelada. Liberamos 2 asientos.',
    );
    // Confirmación explícita del servidor: recién ahí se limpia la selección.
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
    expect(screen.getByText('0 seleccionados')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Elige tus asientos' }),
    ).toBeInTheDocument();
    expect(view.container.querySelector('#passenger-0-first-name')).toBeNull();
  });

  it('el modal se puede descartar sin tocar el backend', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar compra' }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Seguir con la compra' }),
      );
    });

    expect(mockedCancelAttempt).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LOCK_KEY)).not.toBeNull();
    expect(storedLock().attempt_id).toBe('att-1');
  });

  it('un intento ya cancelado por el servidor no inventa asientos liberados', async () => {
    mockedCancelAttempt.mockResolvedValue({
      attempt_id: 'att-1',
      status: 'cancelled',
      already_cancelled: true,
      freed_seats: 0,
    });
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar compra' }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sí, cancelar compra' }),
      );
    });

    expect(mockedCancelAttempt).toHaveBeenCalledWith('att-1');
    expect(toast.success).toHaveBeenCalledWith(
      'Esta compra ya estaba cancelada. Tus asientos quedaron libres.',
    );
    expect(sessionStorage.getItem(LOCK_KEY)).toBeNull();
  });

  it('un fallo al cancelar conserva la compra y el modal sigue abierto', async () => {
    mockedCancelAttempt.mockRejectedValue(
      new ApiError('No pudimos cancelar', 'CANCEL_FAILED', 409),
    );
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar compra' }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sí, cancelar compra' }),
      );
    });

    expect(toast.error).toHaveBeenCalledWith('No pudimos cancelar');
    expect(sessionStorage.getItem(LOCK_KEY)).not.toBeNull();
    expect(storedLock().attempt_id).toBe('att-1');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Comprobante de pago' }),
    ).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════
// MKT-007.4 — Canales de pago: elegir ANTES del comprobante; aviso
// WhatsApp cuando la agencia no tiene canales activos.
// ══════════════════════════════════════════════════════════════════════

describe('Canales de pago del intento (MKT-007.4)', () => {
  beforeEach(() => {
    resetCheckoutTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sin canal elegido no se muestra el uploader; elegirlo lo habilita', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    // Sin preselección: el cliente debe elegir antes de subir el comprobante.
    mockedGetPaymentMethods.mockResolvedValue(
      paymentMethodsView({ selected_method_id: null }),
    );
    mockedSelectPaymentMethod.mockResolvedValue({
      attempt_id: 'att-1',
      status: 'created',
      amount_cents: 4040,
      payment_method_id: 'pm-1',
      payment_method_snapshot: { snapshot_version: 1 },
      idempotent: false,
    });

    await renderWizard();

    expect(screen.getByText('Datos de pago')).toBeInTheDocument();
    // Sin canal: el uploader queda oculto con su instrucción.
    expect(
      screen.queryByRole('button', { name: 'Enviar comprobante' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Selecciona un método de pago para continuar con tu comprobante.',
      ),
    ).toBeInTheDocument();

    await selectFirstPaymentMethodViaUi();

    expect(mockedSelectPaymentMethod).toHaveBeenCalledWith('att-1', 'pm-1');
    expect(
      screen.getByRole('button', { name: 'Enviar comprobante' }),
    ).toBeInTheDocument();
    // El canal elegido queda marcado como seleccionado (badge dentro de la
    // card del canal, no la leyenda del mapa de asientos).
    expect(
      screen.getByTestId('payment-method-pm-1').textContent,
    ).toContain('Seleccionado');
  });

  it('un canal ya elegido (rehidratación) habilita el uploader de inmediato', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetPaymentMethods.mockResolvedValue(
      paymentMethodsView({ selected_method_id: 'pm-1' }),
    );

    await renderWizard();

    expect(
      screen.getByRole('button', { name: 'Enviar comprobante' }),
    ).toBeInTheDocument();
    expect(mockedSelectPaymentMethod).not.toHaveBeenCalled();
  });

  it('en la sección de canales, un teléfono inválido explica la ausencia de enlace y ofrece copiar', async () => {
    seedAttemptLock();
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    // La agencia no devuelve canales activos en el intento (p. ej. borrados
    // tras crearse) y su teléfono no tiene forma válida de WhatsApp.
    mockedGetPaymentMethods.mockResolvedValue(
      paymentMethodsView({
        methods: [],
        selected_method_id: null,
        agency_phone: 'no-telefono',
      }),
    );

    await renderWizard();

    expect(
      screen.getByText(
        'La agencia aún no tiene un método de pago configurado',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Contactar por WhatsApp/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/No pudimos abrir WhatsApp con este número/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /Copiar teléfono: no-telefono/,
      }),
    ).toBeInTheDocument();
    // El copy obligatorio de contacto se conserva.
    expect(screen.getByText(/no confirma tu reserva/)).toBeInTheDocument();
  });

  it('con revisión pendiente el canal es de solo lectura (sin "Elegir")', async () => {
    seedAttemptLock({
      status: 'pending_review',
      submitted_at: '2026-10-04T12:00:00.000Z',
      proof_count: 1,
      remaining_submissions: 2,
    });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetAttempt.mockResolvedValue(
      attemptView({
        status: 'pending_review',
        proof_count: 1,
        remaining_submissions: 2,
        proof_submitted_at: '2026-10-04T12:00:00.000Z',
      }),
    );
    mockedGetPaymentMethods.mockResolvedValue(
      paymentMethodsView({
        status: 'pending_review',
        selected_method_id: 'pm-1',
      }),
    );

    await renderWizard();

    expect(
      screen.getByTestId('payment-method-pm-1').textContent,
    ).toContain('Seleccionado');
    expect(
      screen.queryByRole('button', { name: 'Elegir' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Este método quedó guardado cuando enviaste tu comprobante y ya no puede cambiarse.',
      ),
    ).toBeInTheDocument();
  });

  it('cuando la agencia no tiene canales activos el intento no avanza y guía a WhatsApp', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({
      trip: buildTrip({
        offers: [
          {
            agency_id: 'ag-1',
            name: 'Bianchi travels',
            logo_url: null,
            primary_color: '#000024',
            secondary_color: null,
            accent_color: '#00D4FF',
            phone: '04121234567',
            payment_methods_available: false,
          },
        ],
      }),
    });
    mockedLocks.mockResolvedValue(serverLocks());

    const view = await renderWizard();
    await fillValidPassengers(view);

    // Sin CTA de pago: el backend respondería 409, la UI lo previene.
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
    ).not.toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Esta agencia aún no tiene un método de pago configurado',
      ),
    ).toBeInTheDocument();
    // Copy obligatorio del ticket.
    expect(
      screen.getByText(
        /Puedes contactar a la agencia para recibir ayuda/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /no confirma tu reserva/,
      ),
    ).toBeInTheDocument();
    const whatsapp = screen.getByRole('link', {
      name: /Contactar por WhatsApp/,
    });
    expect(whatsapp).toHaveAttribute('href', 'https://wa.me/584121234567');
    expect(view).toBeTruthy();
  });

  it('un teléfono inválido no inventa enlace de WhatsApp', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({
      trip: buildTrip({
        offers: [
          {
            agency_id: 'ag-1',
            name: 'Bianchi travels',
            logo_url: null,
            primary_color: '#000024',
            secondary_color: null,
            accent_color: '#00D4FF',
            phone: 'no-telefono',
            payment_methods_available: false,
          },
        ],
      }),
    });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    expect(
      screen.queryByRole('link', { name: /Contactar por WhatsApp/ }),
    ).not.toBeInTheDocument();
    // El copy de aviso se mantiene aunque no haya enlace.
    expect(
      screen.getByText(/no confirma tu reserva/),
    ).toBeInTheDocument();
    // Se explica por qué no hay enlace y se conserva la copia del teléfono.
    expect(
      screen.getByText(/No pudimos abrir WhatsApp con este número/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /Copiar teléfono: no-telefono/,
      }),
    ).toBeInTheDocument();
  });

  it('sin teléfono público se informa que no hay medio de contacto disponible', async () => {
    seedLock();
    mockedTripDetail.mockResolvedValue({
      trip: buildTrip({
        offers: [
          {
            agency_id: 'ag-1',
            name: 'Bianchi travels',
            logo_url: null,
            primary_color: '#000024',
            secondary_color: null,
            accent_color: '#00D4FF',
            phone: null,
            payment_methods_available: false,
          },
        ],
      }),
    });
    mockedLocks.mockResolvedValue(serverLocks());

    await renderWizard();

    expect(
      screen.getByText(
        'Esta agencia aún no tiene un método de pago configurado',
      ),
    ).toBeInTheDocument();
    // Sin contacto publicado no se invita a escribir a ningún chat ni a
    // soporte: se informa la ausencia de medio de contacto.
    expect(
      screen.getByText(/Tampoco ha publicado un medio de contacto disponible/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/chat de tu compra/),
    ).not.toBeInTheDocument();
    // Nunca inventar enlaces ni números.
    expect(
      screen.queryByRole('link', { name: /Contactar por WhatsApp/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Copiar teléfono/ }),
    ).not.toBeInTheDocument();
    // Sin contacto no hay copy de WhatsApp ni bloqueo de CTA de pago.
    expect(
      screen.queryByText(/no confirma tu reserva/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continuar al pago' }),
    ).not.toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('el canal congelado tras el primer comprobante rechaza el cambio (409)', async () => {
    seedAttemptLock({
      status: 'rejected',
      proof_count: 1,
      remaining_submissions: 2,
    });
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });
    mockedLocks.mockResolvedValue(serverLocks());
    mockedGetAttempt.mockResolvedValue(
      attemptView({
        status: 'rejected',
        proof_count: 1,
        remaining_submissions: 2,
      }),
    );
    // status='rejected' en la vista de canales: sin cambios permitidos.
    mockedGetPaymentMethods.mockResolvedValue(
      paymentMethodsView({ status: 'rejected', selected_method_id: 'pm-1' }),
    );

    await renderWizard();

    // Congelado: no hay botón "Elegir" ni "Elegir" para otro canal.
    expect(
      screen.queryByRole('button', { name: 'Elegir' }),
    ).not.toBeInTheDocument();
    expect(mockedSelectPaymentMethod).not.toHaveBeenCalled();
    // El uploader de reenvío sí está disponible (quedan reenvíos).
    expect(
      screen.getByRole('button', { name: 'Enviar comprobante' }),
    ).toBeInTheDocument();
  });
});
