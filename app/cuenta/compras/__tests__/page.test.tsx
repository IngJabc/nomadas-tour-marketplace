import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/errors/api-error';
import { formatSeatPrice } from '@/lib/price';
import { formatDateTimeShort } from '@/lib/timezone';
import {
  checkoutApi,
  type PurchaseHistoryView,
  type PurchaseItemDto,
} from '@/lib/api';
import MisComprasPage from '../page';

const authState = vi.hoisted(() => ({
  value: {
    user: null as { id: string; email: string; role: string } | null,
    loading: false,
    refresh: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => authState.value,
}));

vi.mock('@/lib/api', () => ({
  checkoutApi: { listPurchases: vi.fn() },
}));

const listPurchases = vi.mocked(checkoutApi.listPurchases);

const CUSTOMER = {
  user: {
    id: 'user-1',
    email: 'cliente@test.com',
    role: 'customer',
  },
  loading: false,
  refresh: vi.fn(),
  signOut: vi.fn(),
};

const DEPARTURE = '2026-11-01T11:00:00.000Z';
const CREATED_AT = '2026-10-15T10:00:00.000Z';

// Orden de SELECCIÓN invertido a propósito: la vista debe mostrar A2, A10
// (orden natural) y nunca A10, A2 (selección) ni A10 antes que A2 (lexicógrafo).
const DETALLE = [
  { asiento: 'A10', nombre: 'Luis Gómez', documento: '87654321' },
  { asiento: 'A2', nombre: 'Ana Pérez', documento: '12345678' },
];

const COMPROBANTE_BASE = {
  envios: 1,
  restantes: 2,
  referencia: 'REF-1',
  banco: 'Banco de Venezuela',
  fecha_pago: '2026-10-15T10:30:00.000Z',
  enviado_en: '2026-10-15T10:30:00.000Z',
  rechazos: 0,
  motivo_rechazo: null as string | null,
};

function makeItem(overrides: Partial<PurchaseItemDto> = {}): PurchaseItemDto {
  return {
    attempt_id: 'att-1',
    status: 'proof_pending',
    estado: 'pendiente_comprobante',
    mensaje: 'Comprobante pendiente: puedes enviar uno nuevo.',
    accion: 'enviar_comprobante',
    puede_reenviar_comprobante: true,
    trip: {
      id: 'trip-1',
      origin: 'Barquisimeto',
      destination: 'Caracas',
      departure_time: DEPARTURE,
    },
    agency: { id: 'ag-1', name: 'Bianchi travels' },
    pasajeros: { total: 2, asientos: ['A10', 'A2'], detalle: DETALLE },
    monto: { unit_price: 2020, amount_cents: 4040 },
    comprobante: null,
    pago: null,
    reserva: null,
    ventana: { expires_at: DEPARTURE, vencida: false },
    created_at: CREATED_AT,
    closed_at: null,
    verified_at: null,
    ...overrides,
  };
}

function view(
  items: PurchaseItemDto[],
  hasMore = false,
): PurchaseHistoryView {
  return { items, limit: 5, offset: 0, has_more: hasMore };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.value = { ...CUSTOMER };
  Object.defineProperty(window, 'scrollY', {
    value: 0,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'scrollTo', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
});

describe('MisComprasPage (RT-02)', () => {
  it('muestra el skeleton accesible mientras carga la sesión y sin llamar a la API', () => {
    authState.value = { ...CUSTOMER, loading: true };

    render(<MisComprasPage />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Cargando tu historial de compras',
    );
    expect(listPurchases).not.toHaveBeenCalled();
  });

  it('lista la compra con ruta, salida, agencia, pasajeros, badge, importe y fecha de operación rotulada', async () => {
    listPurchases.mockResolvedValue(view([makeItem()]));

    render(<MisComprasPage />);

    expect(await screen.findByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(screen.getByText(formatDateTimeShort(DEPARTURE))).toBeInTheDocument();
    expect(screen.getByText('Bianchi travels')).toBeInTheDocument();
    // Orden natural pese a venir de selección A10, A2 del backend.
    expect(screen.getByText('2 pasajeros · A2, A10')).toBeInTheDocument();
    expect(screen.getByText('Comprobante pendiente')).toBeInTheDocument();
    expect(
      screen.getByText('Comprobante pendiente: puedes enviar uno nuevo.'),
    ).toBeInTheDocument();
    expect(screen.getByText(formatSeatPrice(4040))).toBeInTheDocument();
    // La fecha de operación explica para qué sirve.
    expect(screen.getByText('Operación iniciada')).toBeInTheDocument();
    expect(
      screen.getByText(formatDateTimeShort(CREATED_AT)),
    ).toBeInTheDocument();
    // Acceso a los datos de pasajeros desde la tarjeta.
    expect(
      screen.getByRole('button', { name: 'Ver pasajeros (2)' }),
    ).toBeInTheDocument();
    // Punto 2: ni folio ni identificadores del intento en pantalla.
    expect(document.body.textContent).not.toContain('Folio');
    expect(document.body.textContent).not.toContain('att-1');
    expect(listPurchases).toHaveBeenCalledWith(5, 0);
  });

  it('traduce los estados del DTO a badges legibles y muestra reserva y pago', async () => {
    listPurchases.mockResolvedValue(
      view([
        makeItem({ attempt_id: 'att-pend' }),
        makeItem({ attempt_id: 'att-rev', estado: 'en_revision', status: 'under_review' }),
        makeItem({
          attempt_id: 'att-rech',
          estado: 'rechazado',
          mensaje: 'Comprobante rechazado: puedes enviar uno nuevo.',
        }),
        makeItem({
          attempt_id: 'att-ok',
          estado: 'reserva_confirmada',
          status: 'confirmed',
          mensaje: 'Reserva confirmada.',
          pago: {
            id: 'pay-1',
            estado: 'aprobado',
            amount_cents: 5000,
            currency: 'COP',
            aprobado_en: '2026-10-16T12:00:00.000Z',
          },
          reserva: {
            id: 'res-1',
            status: 'confirmed',
            payment_status: 'fully_paid',
            ticket_code: 'TCK-9',
            created_at: '2026-10-15T10:05:00.000Z',
          },
        }),
      ]),
    );

    render(<MisComprasPage />);

    expect(await screen.findByText('Comprobante pendiente')).toBeInTheDocument();
    expect(screen.getByText('En revisión')).toBeInTheDocument();
    expect(screen.getByText('Rechazado')).toBeInTheDocument();
    expect(
      screen.getByText('Comprobante rechazado: puedes enviar uno nuevo.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Reserva confirmada')).toBeInTheDocument();
    expect(screen.getByText('Boleto TCK-9')).toBeInTheDocument();
    expect(screen.getByText(/pago totalmente pagada/)).toBeInTheDocument();
    expect(screen.getByText(/Pago aprobado/)).toBeInTheDocument();
    expect(document.body.textContent).toContain(formatSeatPrice(5000));
  });

  it('muestra la acción de boleto SOLO en compras elegibles (RT-03)', async () => {
    listPurchases.mockResolvedValue(
      view([
        // Elegible: reserva_confirmada con código de boleto real.
        makeItem({
          attempt_id: 'att-ok',
          estado: 'reserva_confirmada',
          status: 'verified',
          reserva: {
            id: 'res-1',
            status: 'reserved',
            payment_status: 'fully_paid',
            ticket_code: 'ABCD1234',
            created_at: '2026-10-15T10:05:00.000Z',
          },
        }),
        // Pago aprobado SIN reserva: no hay boleto que servir.
        makeItem({ attempt_id: 'att-aprob', estado: 'aprobado', status: 'verified' }),
        // En revisión: nada de boleto.
        makeItem({ attempt_id: 'att-rev', estado: 'en_revision', status: 'under_review' }),
        // reserva_confirmada SIN ticket_code: no se ofrece la acción.
        makeItem({
          attempt_id: 'att-sin-codigo',
          estado: 'reserva_confirmada',
          status: 'verified',
          reserva: {
            id: 'res-2',
            status: 'reserved',
            payment_status: 'fully_paid',
            ticket_code: null,
            created_at: '2026-10-15T10:05:00.000Z',
          },
        }),
      ]),
    );

    render(<MisComprasPage />);

    // Dos compras con reserva_confirmada (una con código, otra sin él).
    expect(await screen.findAllByText('Reserva confirmada')).toHaveLength(2);

    const links = screen.getAllByRole('link', { name: /Ver boleto/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      '/cuenta/compras/att-ok/boleto',
    );
    // Ningún enlace de boleto apunta a la compra sin código.
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).not.toContain('/cuenta/compras/att-sin-codigo/boleto');
    expect(hrefs).not.toContain('/cuenta/compras/att-aprob/boleto');
    expect(hrefs).not.toContain('/cuenta/compras/att-rev/boleto');
  });

  it('no ofrece acciones de reenvío ni de ninguna clase en el historial', async () => {
    listPurchases.mockResolvedValue(
      view([
        // El DTO permite reenviar, pero la pantalla no tiene dónde enviarlo:
        // el reenvío solo vive en el wizard, así que jamás se ofrece aquí.
        makeItem({
          attempt_id: 'att-rev',
          estado: 'en_revision',
          puede_reenviar_comprobante: true,
        }),
        makeItem({
          attempt_id: 'att-final',
          estado: 'rechazado_final',
          mensaje: 'Se alcanzó el límite de 3 envíos.',
        }),
        makeItem({
          attempt_id: 'att-unk',
          estado: 'desconocido',
          mensaje: 'Estado del intento no reconocido.',
        }),
      ]),
    );

    render(<MisComprasPage />);

    expect(await screen.findByText('Rechazado definitivo')).toBeInTheDocument();
    expect(screen.getByText('Estado no reconocido')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /reenviar|enviar/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /reenviar|enviar/i }),
    ).not.toBeInTheDocument();
    // Única navegación posible: la paginación.
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
  });

  it('muestra el empty state con CTA al catálogo', async () => {
    listPurchases.mockResolvedValue(view([]));

    render(<MisComprasPage />);

    expect(await screen.findByText('Aún no tienes compras')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /Explorar viajes/ });
    expect(cta).toHaveAttribute('href', '/viajes');
    expect(screen.queryByRole('button', { name: 'Anterior' })).not.toBeInTheDocument();
  });

  it('muestra error con Reintentar y recupera la lista al reintentar', async () => {
    listPurchases.mockRejectedValueOnce(new Error('boom'));

    render(<MisComprasPage />);

    expect(
      await screen.findByText('No pudimos cargar tu historial de compras'),
    ).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();

    listPurchases.mockResolvedValueOnce(view([makeItem()]));
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));

    expect(await screen.findByText('Barquisimeto → Caracas')).toBeInTheDocument();
    // El reintento repite el mismo destino (offset de la página actual).
    expect(listPurchases).toHaveBeenLastCalledWith(5, 0);
  });

  it('con error 401 muestra el panel de sesión y enlaza al login con redirect', async () => {
    listPurchases.mockRejectedValueOnce(
      new ApiError('Unauthorized', 'UNAUTHORIZED', 401),
    );

    render(<MisComprasPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Iniciar sesión/ }),
    ).toHaveAttribute('href', '/login?redirect=%2Fcuenta%2Fcompras');
  });

  it('sin sesión muestra el panel de sesión sin llamar a la API', async () => {
    authState.value = { ...CUSTOMER, user: null };

    render(<MisComprasPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    expect(listPurchases).not.toHaveBeenCalled();
  });

  it('con un rol distinto de customer muestra el aviso sin llamar a la API', async () => {
    authState.value = {
      ...CUSTOMER,
      user: { id: 'user-9', email: 'agencia@test.com', role: 'agency' },
    };

    render(<MisComprasPage />);

    expect(
      await screen.findByText(
        'Solo las cuentas de cliente pueden ver su historial de compras.',
      ),
    ).toBeInTheDocument();
    expect(listPurchases).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renderiza campos nulos con mensajes neutros, nunca "null" ni "undefined"', async () => {
    listPurchases.mockResolvedValue(
      view([
        makeItem({
          attempt_id: 'att-nulos',
          trip: { id: 'trip-x', origin: null, destination: null, departure_time: null },
          agency: { id: 'ag-x', name: null },
          pasajeros: { total: 1, asientos: [], detalle: [] },
          estado: 'en_revision',
          reserva: {
            id: 'res-1',
            status: 'pending_payment',
            payment_status: null,
            ticket_code: null,
            created_at: '2026-10-15T10:05:00.000Z',
          },
        }),
      ]),
    );

    render(<MisComprasPage />);

    expect(await screen.findByText('Ruta no disponible')).toBeInTheDocument();
    expect(screen.getByText('Fecha de salida no disponible')).toBeInTheDocument();
    expect(screen.getByText('Agencia no disponible')).toBeInTheDocument();
    expect(screen.getByText('Reserva registrada')).toBeInTheDocument();
    expect(screen.getByText('1 pasajero')).toBeInTheDocument();
    // Sin detalle no hay botón que lleve a un modal vacío.
    expect(
      screen.queryByRole('button', { name: /Ver pasajeros/ }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/null|undefined/);
  });

  it('pagina con 5 resultados por página, offset correcto y has_more respetado', async () => {
    listPurchases.mockImplementation(async (_limit, offset) =>
      offset === 0
        ? view([makeItem({ attempt_id: 'att-p1', trip: { ...makeItem().trip, origin: 'Ciudad P1' } })], true)
        : view(
            [
              makeItem({
                attempt_id: 'att-p2',
                estado: 'en_revision',
                trip: { ...makeItem().trip, origin: 'Ciudad P2' },
              }),
            ],
            false,
          ),
    );

    render(<MisComprasPage />);

    expect(await screen.findByText('Ciudad P1 → Caracas')).toBeInTheDocument();
    expect(listPurchases).toHaveBeenNthCalledWith(1, 5, 0);
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));

    // Siempre vuelve al top al paginar (nunca quedarse abajo).
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(await screen.findByText('Ciudad P2 → Caracas')).toBeInTheDocument();
    expect(listPurchases).toHaveBeenNthCalledWith(2, 5, 5);
    expect(screen.getByText('Página 2')).toBeInTheDocument();
    // Sin más páginas: no se ofrece avanzar.
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));

    expect(window.scrollTo).toHaveBeenLastCalledWith({
      top: 0,
      behavior: 'smooth',
    });
    expect(await screen.findByText('Ciudad P1 → Caracas')).toBeInTheDocument();
    expect(listPurchases).toHaveBeenNthCalledWith(3, 5, 0);
    expect(screen.getByText('Página 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeEnabled();
  });

  it('ignora los clics duplicados de paginación durante la carga', async () => {
    const navigation = deferred<PurchaseHistoryView>();
    listPurchases
      .mockResolvedValueOnce(
        view(
          [
            makeItem({
              attempt_id: 'att-p1',
              trip: { ...makeItem().trip, origin: 'Ciudad P1' },
            }),
          ],
          true,
        ),
      )
      .mockReturnValueOnce(navigation.promise);

    render(<MisComprasPage />);
    expect(await screen.findByText('Ciudad P1 → Caracas')).toBeInTheDocument();

    const next = screen.getByRole('button', { name: 'Siguiente' });
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);

    expect(listPurchases).toHaveBeenCalledTimes(2);

    navigation.resolve(
      view(
        [
          makeItem({
            attempt_id: 'att-p2',
            trip: { ...makeItem().trip, origin: 'Ciudad P2' },
          }),
        ],
        false,
      ),
    );
    expect(await screen.findByText('Ciudad P2 → Caracas')).toBeInTheDocument();
  });

  it('descarta la respuesta obsoleta cuando cambia la identidad', async () => {
    const first = deferred<PurchaseHistoryView>();
    const second = deferred<PurchaseHistoryView>();
    listPurchases
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(<MisComprasPage />);
    expect(listPurchases).toHaveBeenCalledTimes(1);

    // Otro cliente inicia sesión: cualquier respuesta anterior ya no aplica.
    authState.value = {
      ...CUSTOMER,
      user: { id: 'user-2', email: 'otra@test.com', role: 'customer' },
    };
    rerender(<MisComprasPage />);
    expect(listPurchases).toHaveBeenCalledTimes(2);

    first.resolve(
      view([
        makeItem({
          attempt_id: 'att-viejo',
          trip: { ...makeItem().trip, origin: 'Ciudad Vieja' },
        }),
      ]),
    );
    await flush();
    expect(screen.queryByText('Ciudad Vieja → Caracas')).not.toBeInTheDocument();
    // La respuesta vieja no termina la carga del intento vigente: el skeleton
    // sigue en pie hasta que responda la identidad actual.
    expect(screen.getByRole('status')).toBeInTheDocument();

    second.resolve(
      view([
        makeItem({
          attempt_id: 'att-nuevo',
          trip: { ...makeItem().trip, origin: 'Maracaibo' },
        }),
      ]),
    );
    expect(await screen.findByText('Maracaibo → Caracas')).toBeInTheDocument();
  });

  it('al cerrar sesión durante la carga muestra el panel de sesión e ignora la respuesta', async () => {
    const inFlight = deferred<PurchaseHistoryView>();
    listPurchases.mockReturnValueOnce(inFlight.promise);

    const { rerender } = render(<MisComprasPage />);

    authState.value = { ...CUSTOMER, user: null };
    rerender(<MisComprasPage />);

    expect(
      await screen.findByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();

    inFlight.resolve(
      view([
        makeItem({
          attempt_id: 'att-post-logout',
          trip: { ...makeItem().trip, origin: 'Ciudad Post' },
        }),
      ]),
    );
    await flush();

    expect(screen.queryByText('Ciudad Post → Caracas')).not.toBeInTheDocument();
    expect(
      screen.getByText('Tu sesión ya no está activa'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('un error no-401 al paginar no borra la lista y permite reintentar', async () => {
    listPurchases
      .mockResolvedValueOnce(
        view(
          [
            makeItem({
              attempt_id: 'att-p1',
              trip: { ...makeItem().trip, origin: 'Ciudad P1' },
            }),
          ],
          true,
        ),
      )
      .mockRejectedValueOnce(new Error('network down'));

    render(<MisComprasPage />);
    expect(await screen.findByText('Ciudad P1 → Caracas')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    // La página actual sigue visible: no se limpia el estado del usuario.
    expect(screen.getByText('Ciudad P1 → Caracas')).toBeInTheDocument();

    listPurchases.mockResolvedValueOnce(
      view(
        [
          makeItem({
            attempt_id: 'att-p2',
            trip: { ...makeItem().trip, origin: 'Ciudad P2' },
          }),
        ],
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));

    expect(await screen.findByText('Ciudad P2 → Caracas')).toBeInTheDocument();
    expect(listPurchases).toHaveBeenLastCalledWith(5, 5);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('el contador de envíos solo aparece mientras el pago está en revisión', async () => {
    listPurchases.mockResolvedValue(
      view([
        makeItem({
          attempt_id: 'a-rev',
          estado: 'en_revision',
          mensaje: 'Comprobante en revisión.',
          comprobante: { ...COMPROBANTE_BASE, envios: 2, restantes: 1 },
        }),
        makeItem({
          attempt_id: 'a-apr',
          estado: 'aprobado',
          status: 'verified',
          mensaje: 'Pago aprobado.',
          comprobante: { ...COMPROBANTE_BASE, envios: 3, restantes: 0 },
        }),
        makeItem({
          attempt_id: 'a-rech',
          estado: 'rechazado',
          mensaje: 'Comprobante rechazado: puedes enviar uno nuevo.',
          comprobante: {
            ...COMPROBANTE_BASE,
            envios: 3,
            restantes: 0,
            rechazos: 1,
            motivo_rechazo: 'La referencia no coincide con el monto',
          },
        }),
      ]),
    );

    render(<MisComprasPage />);

    expect(await screen.findByText('2 envíos · quedan 1')).toBeInTheDocument();
    // Solo UN contador en toda la lista: los otros estados lo ocultan.
    expect(screen.getAllByText(/envíos? · quedan/)).toHaveLength(1);
    expect(screen.queryByText(/3 envíos/)).not.toBeInTheDocument();
    // El motivo del rechazo sí se muestra (es lo que el cliente necesita ver).
    expect(
      screen.getByText(/Motivo del rechazo: La referencia no coincide con el monto/),
    ).toBeInTheDocument();
  });

  it('muestra los importes en $ sin la moneda COP del backend', async () => {
    listPurchases.mockResolvedValue(
      view([
        makeItem({
          estado: 'reserva_confirmada',
          mensaje: 'Reserva confirmada.',
          pago: {
            id: 'pay-1',
            estado: 'aprobado',
            amount_cents: 5000,
            currency: 'COP',
            aprobado_en: '2026-10-16T12:00:00.000Z',
          },
          reserva: {
            id: 'res-1',
            status: 'confirmed',
            payment_status: 'fully_paid',
            ticket_code: 'TCK-9',
            created_at: '2026-10-15T10:05:00.000Z',
          },
        }),
      ]),
    );

    render(<MisComprasPage />);

    expect(await screen.findByText('Reserva confirmada')).toBeInTheDocument();
    expect(document.body.textContent).toContain(formatSeatPrice(5000));
    expect(document.body.textContent).toContain('$40,40');
    expect(document.body.textContent).not.toContain('COP');
  });

  it('abre los datos de pasajeros en un modal accesible y lo cierra con Escape', async () => {
    listPurchases.mockResolvedValue(view([makeItem()]));

    render(<MisComprasPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ver pasajeros (2)' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Ana Pérez')).toBeInTheDocument();
    expect(within(dialog).getByText('C.I. 12345678 · asiento A2')).toBeInTheDocument();
    expect(within(dialog).getByText('Luis Gómez')).toBeInTheDocument();
    expect(within(dialog).getByText('C.I. 87654321 · asiento A10')).toBeInTheDocument();
    // El modal lista en orden natural (A2 antes que A10), no en el orden
    // en que vinieron los datos (A10 primero en el fixture).
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Ana Pérez');
    expect(rows[1]).toHaveTextContent('Luis Gómez');

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // La tarjeta sigue en pantalla: cerrar el modal no toca la lista.
    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();
  });

  it('muestra el botón Subir cuando hay contenido arriba y hace scroll al inicio', async () => {
    listPurchases.mockResolvedValue(view([makeItem()]));

    render(<MisComprasPage />);
    expect(await screen.findByText('Barquisimeto → Caracas')).toBeInTheDocument();

    expect(
      screen.queryByRole('button', { name: 'Volver arriba' }),
    ).not.toBeInTheDocument();

    Object.defineProperty(window, 'scrollY', {
      value: 600,
      writable: true,
      configurable: true,
    });
    fireEvent.scroll(window);

    const toTop = screen.getByRole('button', { name: 'Volver arriba' });
    fireEvent.click(toTop);

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });
});
