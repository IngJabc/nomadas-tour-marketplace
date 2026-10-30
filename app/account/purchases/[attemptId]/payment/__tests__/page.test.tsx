import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/errors/api-error';
import { formatSeatPrice } from '@/lib/price';
import { formatDateTimeShort } from '@/lib/timezone';
import {
  checkoutApi,
  publicApi,
  seatApi,
  type CheckoutAttemptView,
  type CheckoutPaymentMethodsView,
  type MySeatLocksResult,
  type PublicTripDetail,
  type SubmitCheckoutProofResult,
} from '@/lib/api';
import { subscribeToPurchaseTicket } from '@/lib/realtime/subscriptions';
import ReintentoPagoPage from '../page';

const authState = vi.hoisted(() => ({
  value: {
    user: null as { id: string; email: string; role: string } | null,
    loading: false,
    refresh: vi.fn(),
    signOut: vi.fn(),
  },
}));

const paramsState = vi.hoisted(() => ({ attemptId: 'att-1' }));

const realtime = vi.hoisted(() => {
  const cleanupRealtime = vi.fn();
  return {
    cleanupRealtime,
    subscribeToPurchaseTicket: vi.fn(() => cleanupRealtime),
  };
});

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => authState.value,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ attemptId: paramsState.attemptId }),
}));

vi.mock('@/lib/api', () => ({
  checkoutApi: {
    getAttempt: vi.fn(),
    getPaymentMethods: vi.fn(),
    submitProof: vi.fn(),
  },
  publicApi: { tripDetail: vi.fn() },
  seatApi: { mySeatLocks: vi.fn() },
}));

vi.mock('@/lib/realtime/subscriptions', () => realtime);

vi.mock('react-hot-toast', () => ({ default: toastMock }));

const getAttempt = vi.mocked(checkoutApi.getAttempt);
const getPaymentMethods = vi.mocked(checkoutApi.getPaymentMethods);
const submitProof = vi.mocked(checkoutApi.submitProof);
const tripDetail = vi.mocked(publicApi.tripDetail);
const mySeatLocks = vi.mocked(seatApi.mySeatLocks);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CUSTOMER = {
  user: { id: 'user-1', email: 'cliente@test.com', role: 'customer' },
  loading: false,
  refresh: vi.fn(),
  signOut: vi.fn(),
};

const DEPARTURE = '2026-11-01T11:00:00.000Z';
/** Ventana abierta: nunca debe vencer durante la suite. */
const WINDOW_OPEN = '2099-01-01T00:00:00.000Z';

function makeAttempt(
  overrides: Partial<CheckoutAttemptView> = {},
): CheckoutAttemptView {
  return {
    attempt_id: 'att-1',
    status: 'rejected',
    trip_id: 'trip-1',
    agency_id: 'ag-1',
    seat_ids: ['seat-1', 'seat-2'],
    seat_codes: ['A2', 'A10'],
    passenger_count: 2,
    passenger_data: [
      {
        seat_id: 'seat-1',
        first_name: 'Ana',
        last_name: 'Pérez',
        document: '12345678',
        // Teléfonos de pasajero: NUNCA deben llegar a esta pantalla.
        phone: '04129999999',
      },
      {
        seat_id: 'seat-2',
        first_name: 'Luis',
        last_name: 'Gómez',
        document: '87654321',
        phone: '04249999999',
      },
    ],
    unit_price: 2020,
    amount_cents: 4040,
    proof_count: 2,
    remaining_submissions: 1,
    payment_reference: '777888999',
    bank_origin: 'Banco de Venezuela',
    payment_datetime: '2020-01-01T10:00:00.000Z',
    proof_submitted_at: '2020-01-01T10:05:00.000Z',
    review_started_at: null,
    rejection_reason: 'La referencia no coincide con el monto',
    rejection_count: 1,
    expires_at: WINDOW_OPEN,
    created_at: '2020-01-01T09:00:00.000Z',
    closed_at: null,
    verified_at: null,
    ...overrides,
  };
}

function makeTrip(): PublicTripDetail {
  return {
    id: 'trip-1',
    departure_time: DEPARTURE,
    capacity: 31,
    vehicle_type: 'bus',
    status: 'active',
    route: { origin: 'Barquisimeto', destination: 'Caracas' },
    seat_price: 2020,
    installment_allowed: false,
    installment_amount_cents: null,
    lock_ttl_seconds: 600,
    offers: [
      {
        agency_id: 'ag-1',
        name: 'Bianchi travels',
        logo_url: null,
        primary_color: null,
        secondary_color: null,
        accent_color: null,
        phone: null,
        payment_methods_available: true,
      },
    ],
    seats: [],
    availability: {
      total: 31,
      available: 0,
      reserved: 0,
      locked: 2,
      blocked: 0,
      guide: 0,
    },
  };
}

function makeLocks(seatIds: string[] = ['seat-1', 'seat-2']): MySeatLocksResult {
  return {
    trip_id: 'trip-1',
    lock_expires_at: WINDOW_OPEN,
    seats: seatIds.map((id, index) => ({
      id,
      seat_code: index === 0 ? 'A2' : 'A10',
      lock_expires_at: WINDOW_OPEN,
    })),
  };
}

function makeMethodsView(
  overrides: Partial<CheckoutPaymentMethodsView> = {},
): CheckoutPaymentMethodsView {
  return {
    attempt_id: 'att-1',
    status: 'rejected',
    amount_cents: 4040,
    selected_method_id: 'pm-1',
    methods: [
      {
        id: 'pm-1',
        method: 'pago_movil',
        label: 'Pago móvil principal',
        data: {
          bank_code: '0134',
          bank_name: 'Banco de Venezuela',
          phone: '04121234567',
          document_type: 'V',
          document_number: '12345678',
          holder_name: 'Agencia Central',
        },
        is_primary: true,
        sort_order: 0,
      },
    ],
    agency_phone: null,
    ...overrides,
  };
}

function proofResult(
  overrides: Partial<SubmitCheckoutProofResult> = {},
): SubmitCheckoutProofResult {
  return {
    attempt_id: 'att-1',
    status: 'pending_review',
    proof_count: 3,
    remaining_submissions: 0,
    proof_path: 'att-1/nuevo.png',
    payment_reference: '777888999',
    bank_origin: 'Banco de Venezuela',
    payment_datetime: '2020-01-01T10:00:00.000Z',
    amount_cents: 4040,
    expires_at: WINDOW_OPEN,
    idempotent: false,
    ...overrides,
  };
}

function buildFile(name = 'comprobante.png', type = 'image/png'): File {
  return new File(['contenido'], name, { type });
}

function selectProofFile(file = buildFile()) {
  const input = screen.getByTestId('proof-file-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
    writable: true,
  });
  fireEvent.change(input);
}

async function renderReady() {
  const view = render(<ReintentoPagoPage />);
  const reference = await screen.findByLabelText('Referencia');
  return { view, reference };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.value = { ...CUSTOMER };
  paramsState.attemptId = 'att-1';
  getAttempt.mockResolvedValue(makeAttempt());
  tripDetail.mockResolvedValue({ trip: makeTrip() });
  mySeatLocks.mockResolvedValue(makeLocks());
  getPaymentMethods.mockResolvedValue(makeMethodsView());
  submitProof.mockResolvedValue(proofResult());
});

describe('ReintentoPagoPage (RT-05)', () => {
  it('carga intento, viaje y bloqueos y muestra el resumen con los datos del pago anterior', async () => {
    await renderReady();

    expect(getAttempt).toHaveBeenCalledWith('att-1');
    expect(tripDetail).toHaveBeenCalledWith('trip-1');
    expect(mySeatLocks).toHaveBeenCalledWith('trip-1');
    expect(getPaymentMethods).toHaveBeenCalledWith('att-1');

    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(screen.getByText(formatDateTimeShort(DEPARTURE))).toBeInTheDocument();
    expect(screen.getByText('Bianchi travels')).toBeInTheDocument();
    expect(screen.getByText('2 pasajeros · asientos A2, A10')).toBeInTheDocument();
    expect(screen.getByText('Comprobante rechazado')).toBeInTheDocument();
    expect(
      screen.getByText(/Motivo del rechazo: La referencia no coincide con el monto/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(formatSeatPrice(4040)).length).toBeGreaterThan(0);

    // Pasajeros del intento en orden natural (A2 antes que A10)…
    expect(screen.getByText('Ana Pérez')).toBeInTheDocument();
    expect(screen.getByText('Luis Gómez')).toBeInTheDocument();
    expect(screen.getByText(/12345678 · Asiento A2/)).toBeInTheDocument();
    expect(screen.getByText(/87654321 · Asiento A10/)).toBeInTheDocument();
    const body = document.body.textContent ?? '';
    expect(body.indexOf('Ana Pérez')).toBeLessThan(body.indexOf('Luis Gómez'));
    // …sin teléfono de pasajero (dato sensible sin uso en pantalla).
    expect(body).not.toContain('04129999999');
    expect(body).not.toContain('04249999999');

    // Los campos del pago anterior vienen precargados y editables.
    expect(screen.getByLabelText('Referencia')).toHaveValue('777888999');
    expect(screen.getByLabelText('Banco')).toHaveValue('Banco de Venezuela');
    expect(screen.getByLabelText('Hora')).toHaveValue('10:00');

    // Nunca vuelve a pedir asientos ni pasajeros: no hay casillas de
    // selección de asientos ni campos para registrar pasajeros.
    expect(screen.queryByLabelText(/nombre/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('proof-file-input')).toBeInTheDocument();
  });

  it('envía el comprobante reutilizando la compra y pasa a la vista de revisión con confirmación', async () => {
    const { view } = await renderReady();
    selectProofFile();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Enviar comprobante/ }));
    });

    expect(await screen.findByText('Pago en revisión')).toBeInTheDocument();
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith(
      'Comprobante enviado. Tu pago está pendiente de revisión.',
    );

    // Reutiliza el MISMO intento con los datos corregidos, sin repetir nada.
    expect(submitProof).toHaveBeenCalledTimes(1);
    const [attemptId, sentFile, reconciliation, key] = submitProof.mock.calls[0];
    expect(attemptId).toBe('att-1');
    expect(sentFile).toBeInstanceOf(File);
    expect(reconciliation).toEqual({
      payment_reference: '777888999',
      bank_origin: 'Banco de Venezuela',
      payment_datetime: '2020-01-01T10:00:00.000Z',
    });
    expect(key).toMatch(UUID_RE);

    // Vista de seguimiento: sin uploader, sin QR ni boleto antes de la
    // verificación de la agencia.
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
    expect(screen.queryByText(/Enviado el/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ver boleto/ })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('QR');
    expect(view).toBeTruthy();
  });

  it('409 CHECKOUT_PROOF_PENDING pasa a revisión sin afirmar un éxito nuevo', async () => {
    submitProof.mockRejectedValueOnce(
      new ApiError(
        'Este comprobante ya está en revisión',
        'CHECKOUT_PROOF_PENDING',
        409,
      ),
    );
    await renderReady();
    selectProofFile();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Enviar comprobante/ }));
    });

    expect(await screen.findByText('Pago en revisión')).toBeInTheDocument();
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith(
      'Tu comprobante ya estaba enviado y sigue en revisión.',
    );
    // Este código no es un bloqueo: no se revalida contra el backend.
    expect(getAttempt).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
  });

  it('bloquea el reintento cuando los asientos ya no están bloqueados', async () => {
    mySeatLocks.mockResolvedValue(makeLocks(['seat-1']));

    render(<ReintentoPagoPage />);

    expect(await screen.findByText('Asientos no disponibles')).toBeInTheDocument();
    expect(
      screen.getByText(/Debes buscar otro viaje para continuar/),
    ).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /Explorar viajes/ });
    expect(cta).toHaveAttribute('href', '/trips');
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
    expect(screen.queryByText('Enviar comprobante')).not.toBeInTheDocument();
    expect(getPaymentMethods).not.toHaveBeenCalled();
  });

  it('bloquea el reintento cuando la ventana de envío ya venció', async () => {
    getAttempt.mockResolvedValue(
      makeAttempt({ expires_at: '2020-01-01T00:00:00.000Z' }),
    );

    render(<ReintentoPagoPage />);

    expect(await screen.findByText('Tiempo agotado')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Explorar viajes/ }),
    ).toHaveAttribute('href', '/trips');
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
  });

  it('bloquea el reintento cuando no quedan comprobantes disponibles', async () => {
    getAttempt.mockResolvedValue(makeAttempt({ remaining_submissions: 0 }));

    render(<ReintentoPagoPage />);

    expect(await screen.findByText('Comprobante rechazado')).toBeInTheDocument();
    expect(
      screen.getByText(/No quedan comprobantes disponibles para esta compra\./),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Volver a mis compras/ }),
    ).toHaveAttribute('href', '/account/purchases');
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
  });

  it('muestra la vista de revisión sin uploader cuando el intento ya está en revisión', async () => {
    getAttempt.mockResolvedValue(
      makeAttempt({
        status: 'pending_review',
        proof_submitted_at: '2020-01-01T10:05:00.000Z',
      }),
    );

    render(<ReintentoPagoPage />);

    expect(await screen.findByText('Pago en revisión')).toBeInTheDocument();
    expect(
      screen.getByText('Comprobante enviado. Tu pago está pendiente de revisión.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `Enviado el ${formatDateTimeShort('2020-01-01T10:05:00.000Z')}`,
      ),
    ).toBeInTheDocument();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
    expect(getPaymentMethods).not.toHaveBeenCalled();
    expect(submitProof).not.toHaveBeenCalled();
  });

  it('un pago aprobado muestra el estado y nunca el formulario', async () => {
    getAttempt.mockResolvedValue(makeAttempt({ status: 'verified' }));

    render(<ReintentoPagoPage />);

    expect(await screen.findByText('Pago aprobado')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Volver a mis compras/ }),
    ).toHaveAttribute('href', '/account/purchases');
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
    expect(getPaymentMethods).not.toHaveBeenCalled();
  });

  it('un intento agency_direct congelado habilita el uploader sin exigir selección', async () => {
    getPaymentMethods.mockResolvedValue(
      makeMethodsView({ selected_method_id: null }),
    );

    await renderReady();

    expect(screen.queryByText(/Selecciona un método de pago/)).not.toBeInTheDocument();
    expect(screen.getByTestId('proof-file-input')).toBeInTheDocument();
  });

  it('mantiene el uploader deshabilitado hasta que carguen los métodos de pago', async () => {
    getPaymentMethods.mockReturnValue(new Promise(() => {}));

    render(<ReintentoPagoPage />);

    expect(
      await screen.findByText(
        'Selecciona un método de pago para continuar con tu comprobante.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
  });

  it('un error 409 CHECKOUT_SEATS_LOST al enviar revalida y muestra el bloqueo', async () => {
    mySeatLocks.mockReset();
    mySeatLocks.mockResolvedValueOnce(makeLocks());
    mySeatLocks.mockResolvedValueOnce(makeLocks(['seat-1']));
    submitProof.mockRejectedValue(
      new ApiError(
        'Los asientos de esta compra ya no están disponibles.',
        'CHECKOUT_SEATS_LOST',
        409,
      ),
    );

    await renderReady();
    selectProofFile();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Enviar comprobante/ }));
    });

    expect(await screen.findByText('Asientos no disponibles')).toBeInTheDocument();
    // La revalidación volvió a consultar intento y bloqueos contra el backend.
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(mySeatLocks).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
  });

  it('sin poder verificar los bloqueos muestra un error honesto y nunca el formulario', async () => {
    mySeatLocks.mockRejectedValue(new TypeError('network down'));

    render(<ReintentoPagoPage />);

    // SEC-02: un TypeError de red muestra copy de conectividad, no el texto crudo.
    expect(
      await screen.findByText('No pudimos conectar con el servicio. Inténtalo nuevamente.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('network down')).not.toBeInTheDocument();
    // Nunca se afirma que los asientos se perdieron por una falla transitoria.
    expect(screen.queryByText('Asientos no disponibles')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();

    mySeatLocks.mockResolvedValue(makeLocks());
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(
      await screen.findByLabelText('Referencia'),
    ).toBeInTheDocument();
  });

  it('un viaje caído usa textos neutros sin bloquear el reintento', async () => {
    tripDetail.mockRejectedValue(new ApiError('No encontrado', 'TRIP_NOT_FOUND', 404));

    await renderReady();

    expect(screen.getByText('Ruta no disponible')).toBeInTheDocument();
    expect(screen.getByText('Fecha de salida no disponible')).toBeInTheDocument();
    expect(screen.getByText('Agencia no disponible')).toBeInTheDocument();
    expect(screen.getByTestId('proof-file-input')).toBeInTheDocument();
  });

  it('404 uniforme: misma vista sin distinguir intento inexistente o ajeno', async () => {
    getAttempt.mockRejectedValue(
      new ApiError('No encontrado', 'CHECKOUT_ATTEMPT_NOT_FOUND', 404),
    );

    render(<ReintentoPagoPage />);

    expect(
      await screen.findByText('No pudimos encontrar esta compra'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Volver a mis compras/ }),
    ).toHaveAttribute('href', '/account/purchases');
    expect(tripDetail).not.toHaveBeenCalled();
    expect(mySeatLocks).not.toHaveBeenCalled();
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
  });

  it('401 muestra la sesión expirada sin intentar el resto de la carga', async () => {
    getAttempt.mockRejectedValue(new ApiError('expired', 'UNAUTHORIZED', 401));

    render(<ReintentoPagoPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Iniciar sesión/ }),
    ).toHaveAttribute('href', '/login?redirect=%2Faccount%2Fpurchases');
    expect(tripDetail).not.toHaveBeenCalled();
    expect(mySeatLocks).not.toHaveBeenCalled();
  });

  it('sin sesión no consulta el backend', async () => {
    authState.value = { ...CUSTOMER, user: null };

    render(<ReintentoPagoPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    expect(getAttempt).not.toHaveBeenCalled();
    expect(subscribeToPurchaseTicket).not.toHaveBeenCalled();
  });

  it('con un rol distinto de customer no consulta el backend', async () => {
    authState.value = {
      ...CUSTOMER,
      user: { id: 'user-9', email: 'agencia@test.com', role: 'agency' },
    };

    render(<ReintentoPagoPage />);

    expect(
      await screen.findByText('Solo las cuentas de cliente pueden gestionar sus pagos.'),
    ).toBeInTheDocument();
    expect(getAttempt).not.toHaveBeenCalled();
    expect(subscribeToPurchaseTicket).not.toHaveBeenCalled();
  });

  it('muestra skeleton accesible mientras carga el intento', async () => {
    getAttempt.mockReturnValue(new Promise(() => {}));

    render(<ReintentoPagoPage />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Cargando el pago de tu compra',
    );
    expect(getPaymentMethods).not.toHaveBeenCalled();
  });
});

describe('ReintentoPagoPage realtime (RT-04A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suscribe el intento del cliente al montar', async () => {
    render(<ReintentoPagoPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(subscribeToPurchaseTicket).toHaveBeenCalledTimes(1);
    const [customerId, attemptId] = vi.mocked(subscribeToPurchaseTicket).mock
      .calls[0];
    expect(customerId).toBe('user-1');
    expect(attemptId).toBe('att-1');
  });

  it('revalida contra el backend tras un evento Realtime con debounce', async () => {
    render(<ReintentoPagoPage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(getAttempt).toHaveBeenCalledTimes(1);

    const onChange = vi.mocked(subscribeToPurchaseTicket).mock.calls[0][2] as () => void;
    act(() => {
      onChange();
    });
    expect(getAttempt).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt).toHaveBeenLastCalledWith('att-1');
  });

  it('desuscribe y cancela el refresco pendiente al desmontar', async () => {
    const { unmount } = render(<ReintentoPagoPage />);
    await act(async () => {
      await Promise.resolve();
    });

    const onChange = vi.mocked(subscribeToPurchaseTicket).mock.calls[0][2] as () => void;
    act(() => {
      onChange();
    });
    unmount();

    expect(realtime.cleanupRealtime).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(getAttempt).toHaveBeenCalledTimes(1);
  });
});
