import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/errors/api-error';
import { formatSeatPrice } from '@/lib/price';
import { formatDateTimeShort } from '@/lib/timezone';
import {
  checkoutApi,
  publicApi,
  type CheckoutAttemptView,
  type PublicTripDetail,
  type ReservationPaymentDto,
  type ReservationPaymentProgressView,
} from '@/lib/api';
import {
  buildBalanceWhatsAppMessage,
  whatsappMessageHref,
} from '@/lib/booking/whatsapp';
import PagarSaldoPage from '../page';

const authState = vi.hoisted(() => ({
  value: {
    user: null as { id: string; email: string; role: string } | null,
    loading: false,
    refresh: vi.fn(),
    signOut: vi.fn(),
  },
}));

const paramsState = vi.hoisted(() => ({ attemptId: 'att-1' }));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => authState.value,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ attemptId: paramsState.attemptId }),
}));

vi.mock('@/lib/api', () => ({
  checkoutApi: {
    getBalanceProgress: vi.fn(),
    getAttempt: vi.fn(),
    submitBalanceProof: vi.fn(),
  },
  publicApi: { tripDetail: vi.fn() },
}));

const getBalanceProgress = vi.mocked(checkoutApi.getBalanceProgress);
const getAttempt = vi.mocked(checkoutApi.getAttempt);
const submitBalanceProof = vi.mocked(checkoutApi.submitBalanceProof);
const tripDetail = vi.mocked(publicApi.tripDetail);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CUSTOMER = {
  user: { id: 'user-1', email: 'cliente@test.com', role: 'customer' },
  loading: false,
  refresh: vi.fn(),
  signOut: vi.fn(),
};

const DEPARTURE = '2026-11-01T11:00:00.000Z';
const DEPOSIT_VERIFIED_AT = '2026-11-01T12:00:00.000Z';
const BALANCE_DEADLINE = '2026-11-30T00:00:00.000Z';

function payment(
  overrides: Partial<ReservationPaymentDto> = {},
): ReservationPaymentDto {
  return {
    id: 'pay-dep',
    stage: 'deposit',
    status: 'verified',
    amount_cents: 2020,
    currency: 'COP',
    external_reference: '111222333',
    bank_origin: 'Banco de Venezuela',
    payment_datetime: '2026-11-01T11:30:00.000Z',
    submitted_at: '2026-11-01T11:35:00.000Z',
    verified_at: DEPOSIT_VERIFIED_AT,
    rejection_reason: null,
    ...overrides,
  };
}

function makeProgress(
  overrides: Partial<ReservationPaymentProgressView> = {},
): ReservationPaymentProgressView {
  return {
    reservation_id: 'res-1',
    reservation_status: 'reserved',
    payment_status: 'partial',
    plan: 'two_stage',
    passenger_count: 2,
    total_cents: 4040,
    deposit_cents: 2020,
    deposit_verified_at: DEPOSIT_VERIFIED_AT,
    paid_cents: 2020,
    balance_cents: 2020,
    deposit_pct: 50,
    balance_pct: 50,
    deposit_deadline: '2026-11-10T00:00:00.000Z',
    balance_deadline: BALANCE_DEADLINE,
    deposit_overdue: false,
    balance_overdue: false,
    seats_held: true,
    payments: [payment()],
    agency: { id: 'ag-1', name: 'Bianchi travels', whatsapp_phone: '04121234567' },
    ...overrides,
  };
}

/** Progreso con un comprobante de SALDO rechazado (reintento precargado). */
function makeProgressRejected(
  overrides: Partial<ReservationPaymentProgressView> = {},
): ReservationPaymentProgressView {
  return makeProgress({
    payments: [
      payment(),
      payment({
        id: 'pay-bal-rej',
        stage: 'balance',
        status: 'rejected',
        external_reference: '555666777',
        bank_origin: 'Banco de Venezuela',
        payment_datetime: '2026-11-01T11:30:00.000Z',
        submitted_at: '2026-11-01T11:35:00.000Z',
        verified_at: null,
        rejection_reason: 'La referencia no coincide con el saldo',
      }),
    ],
    ...overrides,
  });
}

/** Progreso con un comprobante de SALDO ya en revisión. */
function makeProgressPending(
  overrides: Partial<ReservationPaymentProgressView> = {},
): ReservationPaymentProgressView {
  return makeProgress({
    payments: [
      payment(),
      payment({
        id: 'pay-bal-pending',
        stage: 'balance',
        status: 'pending',
        submitted_at: '2026-11-15T10:00:00.000Z',
        verified_at: null,
      }),
    ],
    ...overrides,
  });
}

function makeAttempt(
  overrides: Partial<CheckoutAttemptView> = {},
): CheckoutAttemptView {
  return {
    attempt_id: 'att-1',
    status: 'verified',
    trip_id: 'trip-1',
    agency_id: 'ag-1',
    seat_ids: ['seat-1', 'seat-2'],
    seat_codes: ['A2', 'A10'],
    passenger_count: 2,
    passenger_data: null,
    unit_price: 2020,
    amount_cents: 2020,
    proof_count: 1,
    remaining_submissions: 1,
    payment_reference: null,
    bank_origin: null,
    payment_datetime: null,
    proof_submitted_at: null,
    review_started_at: null,
    rejection_reason: null,
    rejection_count: 0,
    expires_at: '2099-01-01T00:00:00.000Z',
    created_at: '2026-11-01T11:00:00.000Z',
    closed_at: null,
    verified_at: DEPOSIT_VERIFIED_AT,
    payment_plan: 'two_stage',
    deposit_cents: 2020,
    total_cents: 4040,
    balance_cents: 2020,
    deposit_pct: 50,
    balance_pct: 50,
    deposit_deadline: '2026-11-10T00:00:00.000Z',
    balance_deadline: BALANCE_DEADLINE,
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
      reserved: 31,
      locked: 0,
      blocked: 0,
      guide: 0,
    },
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

async function renderForm() {
  render(<PagarSaldoPage />);
  const block = await screen.findByTestId('plan-dos-partes');
  return block;
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.value = { ...CUSTOMER };
  paramsState.attemptId = 'att-1';
  getBalanceProgress.mockResolvedValue(makeProgress());
  getAttempt.mockResolvedValue(makeAttempt());
  submitBalanceProof.mockResolvedValue({
    payment_id: 'pay-bal-1',
    reservation_id: 'res-1',
    status: 'pending',
    stage: 'balance',
    amount_cents: 2020,
    currency: 'COP',
    submitted_at: '2026-11-17T10:00:00.000Z',
    total_cents: 4040,
    paid_cents: 2020,
    balance_cents: 2020,
    idempotent: false,
  });
  tripDetail.mockResolvedValue({ trip: makeTrip() });
});

describe('PagarSaldoPage — progreso server-side (MKT-010.1)', () => {
  it('muestra skeleton accesible mientras carga el progreso', async () => {
    getBalanceProgress.mockReturnValue(new Promise(() => {}));

    render(<PagarSaldoPage />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Cargando el saldo de tu compra',
    );
    expect(tripDetail).not.toHaveBeenCalled();
  });

  it('pinta resumen, plan con etapas/porcentajes y uploader del saldo', async () => {
    const block = await renderForm();

    expect(getBalanceProgress).toHaveBeenCalledWith('att-1');
    expect(getAttempt).toHaveBeenCalledWith('att-1');
    expect(tripDetail).toHaveBeenCalledWith('trip-1');

    // Resumen de la compra.
    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(screen.getByText(formatDateTimeShort(DEPARTURE))).toBeInTheDocument();
    expect(screen.getByText('Bianchi travels')).toBeInTheDocument();
    expect(screen.getByText('2 pasajeros · asientos A2, A10')).toBeInTheDocument();

    // Plan server-side: montos, etapas y porcentajes tal cual los envía la RPC.
    expect(block).toHaveTextContent('Plan de pago en dos partes');
    expect(block).toHaveTextContent(
      `Total de la compra${formatSeatPrice(4040)}`,
    );
    expect(block).toHaveTextContent('Depósito (etapa 1) · 50%');
    expect(block).toHaveTextContent(formatSeatPrice(2020));
    expect(block).toHaveTextContent('Depósito aprobado el');
    expect(block).toHaveTextContent('Pagado');
    expect(block).toHaveTextContent('Falta saldar (etapa 2) · 50%');
    expect(block).toHaveTextContent(/El saldo vence el/);
    expect(block).toHaveTextContent(
      'Asientos reservados a la espera del saldo.',
    );
    expect(block).not.toHaveTextContent('El plazo del saldo venció.');

    // Formulario del comprobante del saldo.
    expect(
      screen.getByRole('heading', { name: 'Enviar comprobante del saldo' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('proof-file-input')).toBeInTheDocument();
    expect(screen.getByLabelText('Referencia')).toBeInTheDocument();
  });

  it('enlace de WhatsApp con el mensaje pre-escrito del saldo', async () => {
    await renderForm();

    const link = screen.getByRole('link', {
      name: /Solicitar el saldo por WhatsApp/,
    });
    const expectedMessage = buildBalanceWhatsAppMessage({
      agencyName: 'Bianchi travels',
      routeLabel: 'Barquisimeto → Caracas',
      departureLabel: formatDateTimeShort(DEPARTURE),
      balanceAmount: formatSeatPrice(2020),
    });
    expect(link).toHaveAttribute(
      'href',
      whatsappMessageHref('04121234567', expectedMessage),
    );
    expect(link).toHaveAttribute('href', expect.stringContaining('wa.me/'));
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('omite el botón de WhatsApp sin teléfono publicado (nunca inventa)', async () => {
    getBalanceProgress.mockResolvedValue(
      makeProgress({
        agency: { id: 'ag-1', name: 'Bianchi travels', whatsapp_phone: null },
      }),
    );

    await renderForm();

    expect(
      screen.queryByRole('link', { name: /Solicitar el saldo por WhatsApp/ }),
    ).not.toBeInTheDocument();
    // El pago no depende del canal de contacto.
    expect(screen.getByTestId('proof-file-input')).toBeInTheDocument();
  });

  it('un vencimiento del saldo es SOLO informativo: nada se cancela', async () => {
    getBalanceProgress.mockResolvedValue(
      makeProgress({ balance_overdue: true }),
    );

    const block = await renderForm();

    expect(block).toHaveTextContent('El plazo del saldo venció.');
    expect(block).toHaveTextContent(
      'no se cancela nada automáticamente y tus asientos siguen reservados',
    );
    expect(block).toHaveTextContent(
      'Asientos reservados a la espera del saldo.',
    );
    // Sin acciones destructivas en toda la pantalla.
    expect(
      screen.queryByRole('link', { name: /Cancelar/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Cancelar/ }),
    ).not.toBeInTheDocument();
  });

  it('precarga los datos de un saldo rechazado y muestra el motivo', async () => {
    getBalanceProgress.mockResolvedValue(makeProgressRejected());

    await renderForm();

    expect(
      screen.getByText(
        /Motivo del rechazo anterior: La referencia no coincide con el saldo/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Referencia')).toHaveValue('555666777');
    expect(screen.getByLabelText('Banco')).toHaveValue('Banco de Venezuela');
    expect(screen.getByTestId('proof-file-input')).toBeInTheDocument();
  });
});

describe('PagarSaldoPage — envío del comprobante del saldo (MKT-010.1)', () => {
  it('envía el saldo al endpoint …/balance con conciliación e idempotencia', async () => {
    getBalanceProgress.mockResolvedValue(makeProgressRejected());
    render(<PagarSaldoPage />);
    await screen.findByTestId('plan-dos-partes');
    selectProofFile();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Enviar comprobante/ }),
      );
    });

    expect(await screen.findByText('Pago en revisión')).toBeInTheDocument();
    expect(submitBalanceProof).toHaveBeenCalledTimes(1);
    const [attemptId, sentFile, reconciliation, key] =
      submitBalanceProof.mock.calls[0];
    expect(attemptId).toBe('att-1');
    expect(sentFile).toBeInstanceOf(File);
    // Conciliación precargada del rechazo, con fecha ISO redondeada.
    expect(reconciliation).toEqual({
      payment_reference: '555666777',
      bank_origin: 'Banco de Venezuela',
      payment_datetime: '2026-11-01T11:30:00.000Z',
    });
    expect(key).toMatch(UUID_RE);
    // Se revalida el progreso contra el backend tras el envío.
    expect(getBalanceProgress).toHaveBeenCalledTimes(2);
    // Vista de seguimiento: sin uploader antes de la verificación.
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
  });

  it('409 BALANCE_PAYMENT_PENDING pasa a revisión sin afirmar un éxito nuevo', async () => {
    getBalanceProgress
      .mockResolvedValueOnce(makeProgressRejected())
      .mockResolvedValueOnce(makeProgressPending());
    submitBalanceProof.mockRejectedValue(
      new ApiError(
        'Ya hay un comprobante de saldo en revisión',
        'BALANCE_PAYMENT_PENDING',
        409,
      ),
    );
    render(<PagarSaldoPage />);
    await screen.findByTestId('plan-dos-partes');
    selectProofFile();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Enviar comprobante/ }),
      );
    });

    expect(await screen.findByText('Pago en revisión')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Comprobante de saldo enviado. La agencia lo está revisando.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `Enviado el ${formatDateTimeShort('2026-11-15T10:00:00.000Z')}`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
    // El servidor decide el estado: aquí no se inventa un "éxito" nuevo.
    expect(getBalanceProgress).toHaveBeenCalledTimes(2);
  });

  it('409 BALANCE_ALREADY_SETTLED al enviar revalida y muestra el estado final', async () => {
    getBalanceProgress
      .mockResolvedValueOnce(makeProgressRejected())
      .mockResolvedValueOnce(
        makeProgress({
          paid_cents: 4040,
          balance_cents: 0,
          payment_status: 'fully_paid',
          payments: [
            payment(),
            payment({
              id: 'pay-bal-ok',
              stage: 'balance',
              status: 'verified',
              amount_cents: 2020,
              verified_at: '2026-11-17T09:00:00.000Z',
            }),
          ],
        }),
      );
    submitBalanceProof.mockRejectedValue(
      new ApiError(
        'El saldo ya está saldado',
        'BALANCE_ALREADY_SETTLED',
        409,
      ),
    );
    render(<PagarSaldoPage />);
    await screen.findByTestId('plan-dos-partes');
    selectProofFile();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Enviar comprobante/ }),
      );
    });

    expect(await screen.findByText('Saldo saldado')).toBeInTheDocument();
    expect(getBalanceProgress).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
  });

  it('409 BALANCE_NOT_AVAILABLE al enviar revalida contra el backend', async () => {
    getBalanceProgress
      .mockResolvedValueOnce(makeProgressRejected())
      .mockResolvedValueOnce(
        makeProgress({ paid_cents: 4040, balance_cents: 0 }),
      );
    submitBalanceProof.mockRejectedValue(
      new ApiError(
        'Esta compra no tiene saldo disponible',
        'BALANCE_NOT_AVAILABLE',
        409,
      ),
    );
    render(<PagarSaldoPage />);
    await screen.findByTestId('plan-dos-partes');
    selectProofFile();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Enviar comprobante/ }),
      );
    });

    expect(await screen.findByText('Saldo saldado')).toBeInTheDocument();
    expect(getBalanceProgress).toHaveBeenCalledTimes(2);
  });
});

describe('PagarSaldoPage — estados del backend y permisos (MKT-010.1)', () => {
  it('409 BALANCE_NOT_AVAILABLE al cargar muestra el mensaje del servidor', async () => {
    getBalanceProgress.mockRejectedValue(
      new ApiError(
        'Esta compra es de pago único: no tiene saldo pendiente.',
        'BALANCE_NOT_AVAILABLE',
        409,
      ),
    );

    render(<PagarSaldoPage />);

    expect(
      await screen.findByText('Este pago no está disponible'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Esta compra es de pago único: no tiene saldo pendiente.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Volver a mis compras/ }),
    ).toHaveAttribute('href', '/account/purchases');
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
    expect(tripDetail).not.toHaveBeenCalled();
  });

  it('404 uniforme: misma vista sin distinguir inexistente o ajena', async () => {
    getBalanceProgress.mockRejectedValue(
      new ApiError('No encontrado', 'PAYMENT_PROGRESS_NOT_FOUND', 404),
    );

    render(<PagarSaldoPage />);

    expect(
      await screen.findByText('No pudimos encontrar esta compra'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Volver a mis compras/ }),
    ).toHaveAttribute('href', '/account/purchases');
    expect(tripDetail).not.toHaveBeenCalled();
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
  });

  it('401 muestra la sesión expirada sin cargar el resto', async () => {
    getBalanceProgress.mockRejectedValue(
      new ApiError('expired', 'UNAUTHORIZED', 401),
    );

    render(<PagarSaldoPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Iniciar sesión/ }),
    ).toHaveAttribute('href', '/login?redirect=%2Faccount%2Fpurchases');
    expect(tripDetail).not.toHaveBeenCalled();
  });

  it('un error de red muestra copy honesto con opción de reintentar', async () => {
    getBalanceProgress.mockRejectedValue(new TypeError('network down'));

    render(<PagarSaldoPage />);

    expect(await screen.findByText('No pudimos cargar el saldo')).toBeInTheDocument();
    expect(
      screen.getByText('No pudimos conectar con el servicio. Inténtalo nuevamente.'),
    ).toBeInTheDocument();
    // Nunca se expone el texto crudo del error.
    expect(document.body.textContent).not.toContain('network down');
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();

    getBalanceProgress.mockResolvedValue(makeProgress());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    });
    expect(await screen.findByTestId('plan-dos-partes')).toBeInTheDocument();
  });

  it('sin sesión no consulta el backend', async () => {
    authState.value = { ...CUSTOMER, user: null };

    render(<PagarSaldoPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    expect(getBalanceProgress).not.toHaveBeenCalled();
    expect(getAttempt).not.toHaveBeenCalled();
  });

  it('con un rol distinto de customer no consulta el backend', async () => {
    authState.value = {
      ...CUSTOMER,
      user: { id: 'user-9', email: 'agencia@test.com', role: 'agency' },
    };

    render(<PagarSaldoPage />);

    expect(
      await screen.findByText(
        'Solo las cuentas de cliente pueden pagar sus saldos.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Volver a mis compras/ }),
    ).toHaveAttribute('href', '/account/purchases');
    expect(getBalanceProgress).not.toHaveBeenCalled();
    expect(getAttempt).not.toHaveBeenCalled();
  });

  it('un saldo ya pendiente de revisión muestra la vista sin formulario', async () => {
    getBalanceProgress.mockResolvedValue(makeProgressPending());

    render(<PagarSaldoPage />);

    expect(await screen.findByText('Pago en revisión')).toBeInTheDocument();
    expect(
      screen.getByText(
        `Enviado el ${formatDateTimeShort('2026-11-15T10:00:00.000Z')}`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
    expect(submitBalanceProof).not.toHaveBeenCalled();
    expect(getBalanceProgress).toHaveBeenCalledTimes(1);
  });

  it('un saldo saldado muestra el estado final sin uploader ni plan', async () => {
    getBalanceProgress.mockResolvedValue(
      makeProgress({
        paid_cents: 4040,
        balance_cents: 0,
        payment_status: 'fully_paid',
        payments: [
          payment(),
          payment({
            id: 'pay-bal-ok',
            stage: 'balance',
            status: 'verified',
            amount_cents: 2020,
            verified_at: '2026-11-17T09:00:00.000Z',
          }),
        ],
      }),
    );

    render(<PagarSaldoPage />);

    expect(await screen.findByText('Saldo saldado')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Volver a mis compras/ }),
    ).toHaveAttribute('href', '/account/purchases');
    expect(screen.queryByTestId('proof-file-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plan-dos-partes')).not.toBeInTheDocument();
    expect(submitBalanceProof).not.toHaveBeenCalled();
  });

  it('un viaje caído usa textos neutros sin bloquear el pago del saldo', async () => {
    tripDetail.mockRejectedValue(
      new ApiError('No encontrado', 'TRIP_NOT_FOUND', 404),
    );

    const block = await renderForm();

    expect(screen.getByText('Ruta no disponible')).toBeInTheDocument();
    expect(screen.getByText('Fecha de salida no disponible')).toBeInTheDocument();
    // La agencia viene del progreso (no del viaje) y sigue visible.
    expect(screen.getByText('Bianchi travels')).toBeInTheDocument();
    expect(screen.getByTestId('proof-file-input')).toBeInTheDocument();
    expect(block).toHaveTextContent('Falta saldar (etapa 2) · 50%');
  });
});
