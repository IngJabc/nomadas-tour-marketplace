import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/errors/api-error';
import { checkoutApi, type CheckoutTicketView } from '@/lib/api';
import BoletoPage from '../page';

const authState = vi.hoisted(() => ({
  value: {
    user: null as { id: string; email: string; role: string } | null,
    loading: false,
    refresh: vi.fn(),
    signOut: vi.fn(),
  },
}));

const paramsState = vi.hoisted(() => ({ attemptId: 'att-1' }));

// Captura del boleto con html-to-image (mismo mecanismo que useCapture de Tour).
const captureMock = vi.hoisted(() => ({
  toPng: vi.fn(async (..._args: unknown[]) => 'data:image/png;base64,CAPTURE'),
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => authState.value,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ attemptId: paramsState.attemptId }),
}));

vi.mock('@/lib/api', () => ({
  checkoutApi: { getTicket: vi.fn() },
}));

// QR con react-qr-code (mismo componente que ReservationTicket de Tour);
// se mockea para poder asertar el valor codificado exacto en jsdom.
vi.mock('react-qr-code', async () => {
  const { createElement } = await vi.importActual<typeof import('react')>('react');
  return {
    QRCode: ({ value, size }: { value: string; size: number }) =>
      createElement('div', {
        'data-testid': 'qr-code',
        'data-value': value,
        'data-size': String(size),
      }),
  };
});

vi.mock('html-to-image', () => ({
  toPng: (...args: unknown[]) => captureMock.toPng(...args),
}));

const getTicket = vi.mocked(checkoutApi.getTicket);

const CUSTOMER = {
  user: { id: 'user-1', email: 'cliente@test.com', role: 'customer' },
  loading: false,
  refresh: vi.fn(),
  signOut: vi.fn(),
};

const QR_CODE = 'NT-MARACAIBO-ABCDEF0123456789ABCDEF0123456789';

function makeTicket(overrides: Partial<CheckoutTicketView> = {}): CheckoutTicketView {
  return {
    attempt_id: 'att-1',
    estado: 'reserva_confirmada',
    qr_code: QR_CODE,
    ticket_code: 'ABCDEF01',
    reservation_id: 'res-1',
    reservation_created_at: '2026-10-15T10:05:00.000Z',
    amount_cents: 4040,
    currency: 'COP',
    paid_at: '2026-10-16T12:00:00.000Z',
    agency: { id: 'ag-1', name: 'Rutas del Sol' },
    trip: {
      origin: 'Caracas',
      destination: 'Maracaibo',
      departure_time: '2026-12-01T08:00:00.000Z',
    },
    seats: ['A2', 'A1'],
    passengers: [
      { asiento: 'A2', nombre: 'Ana Pérez' },
      { asiento: 'A1', nombre: 'Luis Gómez' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.value = { ...CUSTOMER };
  paramsState.attemptId = 'att-1';
  captureMock.toPng.mockImplementation(
    async (..._args: unknown[]) => 'data:image/png;base64,CAPTURE',
  );
});

describe('BoletoPage (RT-03)', () => {
  it('carga el boleto desde el endpoint autenticado con el attemptId de la ruta', async () => {
    getTicket.mockResolvedValue(makeTicket());

    render(<BoletoPage />);

    await waitFor(() => expect(getTicket).toHaveBeenCalledWith('att-1'));
    expect(await screen.findByText('Boleto de viaje')).toBeInTheDocument();
    expect(await screen.findByText('Código: ABCDEF01')).toBeInTheDocument();
    expect(screen.getByText('Caracas → Maracaibo')).toBeInTheDocument();
    expect(screen.getByText('Rutas del Sol')).toBeInTheDocument();
  });

  it('codifica en el QR EXACTAMENTE el qr_code del backend y lo muestra como en Tour', async () => {
    getTicket.mockResolvedValue(makeTicket());

    render(<BoletoPage />);
    await screen.findByText('Código: ABCDEF01');

    // El valor codificado es EXACTAMENTE el qr_code de Tour, sin inventar.
    const qr = screen.getByTestId('qr-code');
    expect(qr.getAttribute('data-value')).toBe(QR_CODE);
    expect(qr.getAttribute('data-size')).toBe('150');
    // Como en ReservationTicket de Tour: el código crudo se lee bajo el QR.
    expect(screen.getByTestId('qr-value')).toHaveTextContent(QR_CODE);
    // Un solo QR por reserva.
    expect(screen.getAllByTestId('qr-code')).toHaveLength(1);
  });

  it('la descarga captura el boleto renderizado con html-to-image y nombra el archivo por ticket_code', async () => {
    getTicket.mockResolvedValue(makeTicket());
    const clicked: HTMLAnchorElement[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this);
      });

    render(<BoletoPage />);
    await screen.findByText('Código: ABCDEF01');

    const button = await screen.findByRole('button', { name: /Descargar/ });
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(clicked).toHaveLength(1));
    // Captura PNG del MISMO nodo que ve el usuario (estilo useCapture de Tour)…
    expect(captureMock.toPng).toHaveBeenCalledTimes(1);
    const [node, options] = captureMock.toPng.mock.calls[0];
    expect(node).toBe(screen.getByTestId('purchase-ticket'));
    expect(options).toEqual({
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: '#ffffff',
    });
    // …y el nombre de archivo usa solo el ticket_code, nunca el qr_code crudo.
    expect(clicked[0].href).toBe('data:image/png;base64,CAPTURE');
    expect(clicked[0].download).toBe('boleto-ABCDEF01.png');
    expect(clicked[0].download).not.toContain('NT-');
    clickSpy.mockRestore();
  });

  it('muestra skeleton accesible mientras carga', async () => {
    getTicket.mockReturnValue(new Promise(() => {}));

    render(<BoletoPage />);

    expect(screen.getByRole('status')).toHaveTextContent('Cargando tu boleto');
  });

  it('muestra el estado de sesión expirada con enlace a login ante 401', async () => {
    getTicket.mockRejectedValue(new ApiError('expired', 'UNAUTHORIZED', 401));

    render(<BoletoPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    const login = screen.getByRole('link', { name: /Iniciar sesión/ });
    expect(login).toHaveAttribute('href', expect.stringContaining('/login'));
  });

  it('muestra "boleto no disponible" y regreso al historial ante 404 uniforme', async () => {
    getTicket.mockRejectedValue(
      new ApiError('Boleto no disponible para esta compra', 'TICKET_NOT_FOUND', 404),
    );

    render(<BoletoPage />);

    expect(await screen.findByText('Boleto no disponible')).toBeInTheDocument();
    const back = screen.getByRole('link', { name: /Volver a mis compras/ });
    expect(back).toHaveAttribute('href', '/cuenta/compras');
    // Un 404 (pendiente, rechazado, ajeno) NUNCA muestra un boleto ni QR.
    expect(screen.queryByTestId('purchase-ticket')).not.toBeInTheDocument();
    expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
    expect(captureMock.toPng).not.toHaveBeenCalled();
  });

  it('muestra error genérico con reintentar ante un fallo del servidor', async () => {
    getTicket.mockRejectedValue(
      new ApiError('No se pudo cargar tu boleto. Intenta de nuevo', 'CHECKOUT_ERROR', 500),
    );

    render(<BoletoPage />);

    expect(
      await screen.findByText('No pudimos cargar tu boleto'),
    ).toBeInTheDocument();
    expect(captureMock.toPng).not.toHaveBeenCalled();

    getTicket.mockResolvedValue(makeTicket());
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Código: ABCDEF01')).toBeInTheDocument();
  });

  it('muestra "solo cuentas de cliente" y no llama al endpoint con otra cuenta', async () => {
    authState.value = { ...CUSTOMER, user: { id: 'u2', email: 'a@b.c', role: 'agency' } };

    render(<BoletoPage />);

    expect(
      await screen.findByText('Solo las cuentas de cliente pueden ver sus boletos.'),
    ).toBeInTheDocument();
    expect(getTicket).not.toHaveBeenCalled();
    const back = screen.getByRole('link', { name: /Volver a mis compras/ });
    expect(back).toHaveAttribute('href', '/cuenta/compras');
  });

  it('muestra la sesión expirada sin llamar al endpoint cuando no hay usuario', async () => {
    authState.value = { ...CUSTOMER, user: null };

    render(<BoletoPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    expect(getTicket).not.toHaveBeenCalled();
  });

  it('lista pasajeros ordenados por asiento con UN solo QR por reserva', async () => {
    getTicket.mockResolvedValue(makeTicket());

    render(<BoletoPage />);
    await screen.findByText('Código: ABCDEF01');

    expect(screen.getByText('Pasajeros (2)')).toBeInTheDocument();
    const asientos = screen.getAllByTestId('passenger-seat');
    expect(asientos.map((n) => n.textContent)).toEqual(['A1', 'A2']);
    expect(screen.getAllByTestId('qr-code')).toHaveLength(1);
  });

  it('muestra el importe pagado y la fecha de reserva fuera del boleto', async () => {
    getTicket.mockResolvedValue(makeTicket());

    render(<BoletoPage />);
    await screen.findByText('Código: ABCDEF01');

    expect(screen.getByText('Importe pagado')).toBeInTheDocument();
    expect(screen.getByText(/Reserva del/)).toBeInTheDocument();
  });
});
