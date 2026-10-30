import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { ApiError } from '@/lib/errors/api-error';
import { formatSeatPrice } from '@/lib/price';
import { formatDateTimeShort } from '@/lib/timezone';
import {
  checkoutApi,
  type PurchaseHistoryView,
  type PurchaseItemDto,
} from '@/lib/api';
import { subscribeToPurchaseHistory } from '@/lib/realtime/subscriptions';
import MisComprasPage from '../page';

const authState = vi.hoisted(() => ({
  value: {
    user: null as { id: string; email: string; role: string } | null,
    loading: false,
    refresh: vi.fn(),
    signOut: vi.fn(),
  },
}));

const realtime = vi.hoisted(() => {
  const cleanupRealtime = vi.fn();
  return {
    cleanupRealtime,
    subscribeToPurchaseHistory: vi.fn(() => cleanupRealtime),
  };
});

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => authState.value,
}));

vi.mock('@/lib/api', () => ({
  checkoutApi: { listPurchases: vi.fn() },
}));

vi.mock('@/lib/realtime/subscriptions', () => realtime);

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

/**
 * Salida a las 11:00 UTC = 07:00 America/Caracas → siempre "futuro" y en el
 * mismo día de negocio, para que sobreviva al filtro "Salida desde = hoy"
 * con el que nace la página.
 */
function isoAt(daysOffset: number): string {
  const date = new Date(Date.now() + daysOffset * 86_400_000);
  date.setUTCHours(11, 0, 0, 0);
  return date.toISOString();
}

const DEPARTURE = isoAt(6);

/** Día local (mediodía) a N días de hoy, para elegirlo en el calendario. */
function daysFromNow(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}
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
    // El historial se trae completo (páginas de 50) para filtrar sobre él.
    expect(listPurchases).toHaveBeenCalledWith(50, 0);
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
      '/account/purchases/att-ok/ticket',
    );
    // Ningún enlace de boleto apunta a la compra sin código.
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).not.toContain('/account/purchases/att-sin-codigo/ticket');
    expect(hrefs).not.toContain('/account/purchases/att-aprob/ticket');
    expect(hrefs).not.toContain('/account/purchases/att-rev/ticket');
  });

  it('no ofrece reintento de pago en estados que no califican, incluso con el flag encendido (RT-05)', async () => {
    listPurchases.mockResolvedValue(
      view([
        makeItem({
          attempt_id: 'att-rev',
          estado: 'en_revision',
          puede_reenviar_comprobante: true,
        }),
        makeItem({
          attempt_id: 'att-pend',
          estado: 'pendiente_comprobante',
          puede_reenviar_comprobante: true,
        }),
        makeItem({
          attempt_id: 'att-rech-noflag',
          estado: 'rechazado',
          status: 'rejected',
          puede_reenviar_comprobante: false,
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
        makeItem({
          attempt_id: 'att-exp',
          estado: 'expirado',
          status: 'expired',
          puede_reenviar_comprobante: true,
        }),
        makeItem({
          attempt_id: 'att-cancel',
          estado: 'cancelado',
          status: 'cancelled',
          puede_reenviar_comprobante: true,
        }),
      ]),
    );

    render(<MisComprasPage />);

    // Los 7 estados caben en dos páginas de 5; la primera cubre el
    // rechazo sin flag (el caso más difícil) y los badges declarativos.
    expect(await screen.findByText('Estado no reconocido')).toBeInTheDocument();
    expect(screen.getByText('Rechazado definitivo')).toBeInTheDocument();
    // Ni la acción de reintento ni ninguna otra en la página visible.
    expect(
      screen.queryByRole('link', {
        name: /reenviar|enviar|reintentar|corregir/i,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /reenviar|enviar|reintentar|corregir/i,
      }),
    ).not.toBeInTheDocument();
    // Única navegación posible: la paginación (falta la página 2).
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeEnabled();
  });

  it('ofrece "Corregir pago y reintentar" SOLO en el intento rechazado y reenviable (RT-05)', async () => {
    listPurchases.mockResolvedValue(
      view([
        makeItem({
          attempt_id: 'att-retry',
          estado: 'rechazado',
          status: 'rejected',
          mensaje: 'Comprobante rechazado: puedes enviar uno nuevo.',
          puede_reenviar_comprobante: true,
        }),
        makeItem({ attempt_id: 'att-pend', estado: 'pendiente_comprobante' }),
        makeItem({
          attempt_id: 'att-rev',
          estado: 'en_revision',
          status: 'under_review',
          puede_reenviar_comprobante: true,
        }),
        makeItem({
          attempt_id: 'att-ok',
          estado: 'reserva_confirmada',
          status: 'verified',
          puede_reenviar_comprobante: true,
          reserva: {
            id: 'res-1',
            status: 'reserved',
            payment_status: 'fully_paid',
            ticket_code: 'ABCD1234',
            created_at: '2026-10-15T10:05:00.000Z',
          },
        }),
      ]),
    );

    render(<MisComprasPage />);

    const retryLink = await screen.findByRole('link', {
      name: /Corregir pago y reintentar/,
    });
    expect(retryLink).toHaveAttribute(
      'href',
      '/account/purchases/att-retry/payment',
    );
    // Solo UNA acción de pago en toda la lista: las demás tarjetas no
    // generan enlaces a /payment.
    const pagoHrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href) => href?.endsWith('/payment'));
    expect(pagoHrefs).toEqual(['/account/purchases/att-retry/payment']);
    // La compra confirmada conserva su boleto, nunca el reintento.
    expect(
      screen.getByRole('link', { name: /Ver boleto/ }),
    ).toHaveAttribute('href', '/account/purchases/att-ok/ticket');
  });

  it('muestra el empty state con CTA al catálogo', async () => {
    listPurchases.mockResolvedValue(view([]));

    render(<MisComprasPage />);

    expect(await screen.findByText('Aún no tienes compras')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /Explorar viajes/ });
    expect(cta).toHaveAttribute('href', '/trips');
    expect(screen.queryByRole('button', { name: 'Anterior' })).not.toBeInTheDocument();
  });

  it('muestra error con Reintentar y recupera la lista al reintentar', async () => {
    listPurchases.mockRejectedValueOnce(new Error('boom'));

    render(<MisComprasPage />);

    expect(
      await screen.findByText('No pudimos cargar tu historial de compras'),
    ).toBeInTheDocument();
    // SEC-02: el error crudo del mock ya no se expone; copy segura del fallback.
    expect(
      screen.getByText('No pudimos cargar tu historial de compras. Intenta de nuevo.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();

    listPurchases.mockResolvedValueOnce(view([makeItem()]));
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));

    expect(await screen.findByText('Barquisimeto → Caracas')).toBeInTheDocument();
    // El reintento vuelve a traer el historial completo desde el inicio.
    expect(listPurchases).toHaveBeenLastCalledWith(50, 0);
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
    ).toHaveAttribute('href', '/login?redirect=%2Faccount%2Fpurchases');
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

  it('pagina 5 tarjetas por pantalla sobre el historial completo, sin volver a pedir a la API', async () => {
    listPurchases.mockResolvedValue(
      view(
        Array.from({ length: 7 }, (_, i) =>
          makeItem({
            attempt_id: `att-p${i + 1}`,
            trip: { ...makeItem().trip, origin: `Ciudad ${i + 1}` },
          }),
        ),
      ),
    );

    render(<MisComprasPage />);

    expect(await screen.findByText('Ciudad 1 → Caracas')).toBeInTheDocument();
    // Todo el historial llega de una (una sola página de 50)…
    expect(listPurchases).toHaveBeenCalledTimes(1);
    expect(listPurchases).toHaveBeenCalledWith(50, 0);
    // …y la pantalla muestra sus primeras 5 tarjetas.
    expect(screen.getByText('Ciudad 5 → Caracas')).toBeInTheDocument();
    expect(screen.queryByText('Ciudad 6 → Caracas')).not.toBeInTheDocument();
    expect(screen.getByText('Página 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));

    // Siempre vuelve al top al paginar (nunca quedarse abajo).
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(screen.getByText('Ciudad 6 → Caracas')).toBeInTheDocument();
    expect(screen.queryByText('Ciudad 1 → Caracas')).not.toBeInTheDocument();
    expect(screen.getByText('Página 2')).toBeInTheDocument();
    // Con 7 compras no hay más páginas: no se ofrece avanzar.
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));

    expect(window.scrollTo).toHaveBeenLastCalledWith({
      top: 0,
      behavior: 'smooth',
    });
    expect(screen.getByText('Ciudad 1 → Caracas')).toBeInTheDocument();
    expect(screen.getByText('Página 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeEnabled();
    // Paginar es local: jamás vuelve a llamar al backend.
    expect(listPurchases).toHaveBeenCalledTimes(1);
  });

  it('recorre el historial completo por páginas de 50 hasta agotar has_more', async () => {
    listPurchases
      .mockResolvedValueOnce(
        view(
          [
            makeItem({
              attempt_id: 'att-lot1',
              trip: { ...makeItem().trip, origin: 'Lote 1' },
            }),
          ],
          true,
        ),
      )
      .mockResolvedValueOnce(
        view(
          [
            makeItem({
              attempt_id: 'att-lot2',
              trip: { ...makeItem().trip, origin: 'Lote 2' },
            }),
          ],
          false,
        ),
      );

    render(<MisComprasPage />);

    // Ambas compras conviven en el mismo historial (el filtro las ve todas).
    expect(await screen.findByText('Lote 2 → Caracas')).toBeInTheDocument();
    expect(screen.getByText('Lote 1 → Caracas')).toBeInTheDocument();
    expect(listPurchases).toHaveBeenNthCalledWith(1, 50, 0);
    expect(listPurchases).toHaveBeenNthCalledWith(2, 50, 1);
    expect(listPurchases).toHaveBeenCalledTimes(2);
  });

  it('los cambios de página son locales: nunca vuelven a llamar a la API', async () => {
    listPurchases.mockResolvedValue(
      view(
        Array.from({ length: 7 }, (_, i) =>
          makeItem({
            attempt_id: `att-c${i + 1}`,
            trip: { ...makeItem().trip, origin: `Ciudad ${i + 1}` },
          }),
        ),
      ),
    );

    render(<MisComprasPage />);
    expect(await screen.findByText('Ciudad 1 → Caracas')).toBeInTheDocument();

    const next = screen.getByRole('button', { name: 'Siguiente' });
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);

    // Con 7 compras hay 2 páginas: el tope se respeta y la API no se toca.
    expect(screen.getByText('Página 2')).toBeInTheDocument();
    expect(next).toBeDisabled();
    expect(listPurchases).toHaveBeenCalledTimes(1);
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

  it('un error no-401 en una página posterior conserva lo traído y permite reintentar', async () => {
    let calls = 0;
    listPurchases.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return view(
          [
            makeItem({
              attempt_id: 'att-p1',
              trip: { ...makeItem().trip, origin: 'Ciudad P1' },
            }),
          ],
          true,
        );
      }
      if (calls === 2) throw new Error('network down');
      return view([
        makeItem({
          attempt_id: 'att-p2',
          trip: { ...makeItem().trip, origin: 'Ciudad P2' },
        }),
      ]);
    });

    render(<MisComprasPage />);
    expect(await screen.findByText('Ciudad P1 → Caracas')).toBeInTheDocument();

    // Falla la 2ª página del barrido: se muestra lo ya traído + el error.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos cargar tu historial de compras. Intenta de nuevo.',
    );
    expect(screen.queryByText('network down')).not.toBeInTheDocument();
    // La compra cargada sigue visible: no se limpia el estado del usuario.
    expect(screen.getByText('Ciudad P1 → Caracas')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));

    expect(await screen.findByText('Ciudad P2 → Caracas')).toBeInTheDocument();
    expect(listPurchases).toHaveBeenLastCalledWith(50, 0);
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

describe('MisComprasPage realtime (RT-04A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suscribe los cambios del cliente autenticado al montar', async () => {
    listPurchases.mockResolvedValue(view([makeItem()]));

    render(<MisComprasPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(subscribeToPurchaseHistory).toHaveBeenCalledTimes(1);
    const [customerId] = vi.mocked(subscribeToPurchaseHistory).mock.calls[0];
    expect(customerId).toBe('user-1');
  });

  it('un evento Realtime re-consulta el historial completo tras el debounce', async () => {
    listPurchases.mockResolvedValue(view([makeItem()]));

    render(<MisComprasPage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(listPurchases).toHaveBeenCalledTimes(1);

    const onChange = vi.mocked(subscribeToPurchaseHistory).mock.calls[0][1] as () => void;
    // Ráfaga (verify toca intento + reserva + pago en una transacción).
    act(() => {
      onChange();
      onChange();
    });
    expect(listPurchases).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(listPurchases).toHaveBeenCalledTimes(2);
    expect(listPurchases).toHaveBeenLastCalledWith(50, 0);
  });

  it('desuscribe y cancela el refresco pendiente al desmontar', async () => {
    listPurchases.mockResolvedValue(view([makeItem()]));

    const { unmount } = render(<MisComprasPage />);
    await act(async () => {
      await Promise.resolve();
    });

    const onChange = vi.mocked(subscribeToPurchaseHistory).mock.calls[0][1] as () => void;
    act(() => {
      onChange();
    });
    unmount();

    expect(realtime.cleanupRealtime).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(listPurchases).toHaveBeenCalledTimes(1);
  });

  it('no suscribe nada sin sesión', async () => {
    authState.value = { ...CUSTOMER, user: null };

    render(<MisComprasPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(subscribeToPurchaseHistory).not.toHaveBeenCalled();
  });

  it('no suscribe nada con un rol distinto de customer', async () => {
    authState.value = {
      ...CUSTOMER,
      user: { id: 'user-2', email: 'agencia@test.com', role: 'agency' },
    };

    render(<MisComprasPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(subscribeToPurchaseHistory).not.toHaveBeenCalled();
  });
});

describe('MisComprasPage — compras independientes en paralelo (MKT-009)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('un evento de una compra re-consulta y la otra conserva su estado, ruta e importe', async () => {
    const rechazada: Partial<PurchaseItemDto> = {
      attempt_id: 'att-2',
      estado: 'rechazado',
      status: 'rejected',
      mensaje: 'Comprobante rechazado: puedes enviar uno nuevo.',
      trip: {
        id: 'trip-2',
        origin: 'Mérida',
        destination: 'San Cristóbal',
        departure_time: DEPARTURE,
      },
      monto: { unit_price: 3500, amount_cents: 7000 },
    };
    const enRevision: Partial<PurchaseItemDto> = {
      attempt_id: 'att-1',
      estado: 'en_revision',
      status: 'under_review',
      mensaje: 'Comprobante en revisión.',
    };
    const confirmada: Partial<PurchaseItemDto> = {
      attempt_id: 'att-1',
      estado: 'reserva_confirmada',
      status: 'confirmed',
      mensaje: 'Reserva confirmada.',
      pago: {
        id: 'pay-1',
        estado: 'aprobado',
        amount_cents: 4040,
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
    };

    listPurchases.mockResolvedValueOnce(
      view([makeItem(enRevision), makeItem(rechazada)]),
    );
    // El evento Realtime dispara un refetch: la compra 1 avanzó a
    // confirmada; la compra 2 NO cambia (su estado es suyo).
    listPurchases.mockResolvedValueOnce(
      view([makeItem(confirmada), makeItem(rechazada)]),
    );

    render(<MisComprasPage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(listPurchases).toHaveBeenCalledTimes(1);

    const onChange = vi.mocked(subscribeToPurchaseHistory).mock
      .calls[0][1] as () => void;
    act(() => {
      onChange();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(listPurchases).toHaveBeenCalledTimes(2);

    // La compra que cambió se pinta con su nuevo estado…
    expect(screen.getByText('Reserva confirmada')).toBeInTheDocument();
    // …y la otra conserva su tarjeta intacta: estado, ruta, mensaje e
    // importe siguen siendo los de ella, sin heredar el cambio.
    expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();
    expect(screen.getByText('Rechazado')).toBeInTheDocument();
    expect(
      screen.getByText('Comprobante rechazado: puedes enviar uno nuevo.'),
    ).toBeInTheDocument();
    expect(screen.getByText(formatSeatPrice(7000))).toBeInTheDocument();
    expect(
      screen.queryByText('Comprobante en revisión.'),
    ).not.toBeInTheDocument();
  });
});

describe('MisComprasPage — filtros de búsqueda del cliente', () => {
  /** Nombre accesible exacto de un botón de día en el calendario (RDP + es). */
  function dayButtonName(date: Date, { selected = false } = {}): string {
    let name = format(date, 'PPPP', { locale: es });
    const now = new Date();
    if (
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    ) {
      name = `Today, ${name}`;
    }
    if (selected) name = `${name}, selected`;
    return name;
  }

  /**
   * Fija una fecha con el DatePicker (calendario), como en Tours: abre el
   * popover, navega hasta el mes del día elegido y lo pulsa. El popover abre
   * siempre en el mes en curso (sin fecha, o con la fecha ya elegida en ese
   * mismo campo), así que la navegación es relativa a hoy.
   */
  async function pickDate(label: string, target: Date) {
    // El popover anterior puede seguir en el DOM durante su animación de
    // cierre; esperar a que desaparezca evita calendarios duplicados.
    await waitFor(() =>
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0),
    );

    fireEvent.click(screen.getByLabelText(label));

    const now = new Date();
    const monthsDiff =
      (target.getFullYear() - now.getFullYear()) * 12 +
      (target.getMonth() - now.getMonth());
    for (let i = 0; i < Math.abs(monthsDiff); i += 1) {
      fireEvent.click(
        screen.getByLabelText(
          monthsDiff > 0 ? 'Go to the Next Month' : 'Go to the Previous Month',
        ),
      );
    }

    const names = [dayButtonName(target), dayButtonName(target, { selected: true })];
    const dayButton = await waitFor(
      () => {
        const button = Array.from(document.querySelectorAll('button')).find(
          (b) => names.includes(b.getAttribute('aria-label') ?? ''),
        );
        if (!button) throw new Error(`Día no visible: ${names[0]}`);
        return button;
      },
      { timeout: 3000 },
    );
    fireEvent.click(dayButton);
  }

  /**
   * Tres compras con firmas distintas: ruta/agencia/estado/fecha/pasajero
   * diferentes para poder aislar cada criterio de filtrado. Las salidas son
   * relativas a hoy: una pasada, una próxima corta y una próxima lejana.
   */
  function filtrosFixture(): PurchaseItemDto[] {
    return [
      makeItem({
        attempt_id: 'att-bq',
        estado: 'pendiente_comprobante',
        trip: {
          id: 'trip-bq',
          origin: 'Barquisimeto',
          destination: 'Caracas',
          departure_time: isoAt(6),
        },
        agency: { id: 'ag-1', name: 'Bianchi travels' },
      }),
      makeItem({
        attempt_id: 'att-mx',
        estado: 'reserva_confirmada',
        status: 'confirmed',
        trip: {
          id: 'trip-mx',
          origin: 'Mérida',
          destination: 'San Cristóbal',
          departure_time: isoAt(40),
        },
        agency: { id: 'ag-2', name: 'Nomadas Tour' },
        reserva: {
          id: 'res-7',
          status: 'confirmed',
          payment_status: 'fully_paid',
          ticket_code: 'TCK-77',
          created_at: '2026-10-15T10:05:00.000Z',
        },
      }),
      makeItem({
        attempt_id: 'att-bs',
        estado: 'en_revision',
        status: 'under_review',
        trip: {
          id: 'trip-bs',
          origin: 'Caracas',
          destination: 'Maracaibo',
          departure_time: isoAt(-6),
        },
        agency: { id: 'ag-2', name: 'Nomadas Tour' },
        pasajeros: {
          total: 1,
          asientos: ['A5'],
          detalle: [
            { asiento: 'A5', nombre: 'María Rodríguez', documento: '99887766' },
          ],
        },
        comprobante: { ...COMPROBANTE_BASE, referencia: 'REF-99' },
      }),
    ];
  }

  async function renderConFixture() {
    listPurchases.mockResolvedValue(view(filtrosFixture()));
    render(<MisComprasPage />);
    expect(await screen.findByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();
    expect(screen.getByText('Caracas → Maracaibo')).toBeInTheDocument();
  }

  it('busca por texto libre: ruta, agencia, pasajero, boleto y referencia', async () => {
    await renderConFixture();
    const search = screen.getByLabelText('Buscar');

    // Ruta sin acentos: "merida" encuentra "Mérida".
    fireEvent.change(search, { target: { value: 'merida' } });
    expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();
    expect(screen.queryByText('Barquisimeto → Caracas')).not.toBeInTheDocument();

    // Agencia
    fireEvent.change(search, { target: { value: 'bianchi' } });
    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(screen.queryByText('Mérida → San Cristóbal')).not.toBeInTheDocument();

    // Pasajera (solo su compra la contiene)
    fireEvent.change(search, { target: { value: 'María Rodríguez' } });
    expect(screen.getByText('Caracas → Maracaibo')).toBeInTheDocument();
    expect(screen.queryByText('Barquisimeto → Caracas')).not.toBeInTheDocument();

    // Boleto
    fireEvent.change(search, { target: { value: 'TCK-77' } });
    expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();
    expect(screen.queryByText('Caracas → Maracaibo')).not.toBeInTheDocument();

    // Referencia del comprobante
    fireEvent.change(search, { target: { value: 'REF-99' } });
    expect(screen.getByText('Caracas → Maracaibo')).toBeInTheDocument();
    expect(screen.queryByText('Mérida → San Cristóbal')).not.toBeInTheDocument();

    // Vaciar el texto restaura el historial completo.
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();
    expect(screen.getByText('Caracas → Maracaibo')).toBeInTheDocument();
  });

  it('filtra por estado con los chips y muestra sus contadores', async () => {
    await renderConFixture();

    // Contadores sobre TODO el historial, en el chip de cada estado.
    expect(
      screen.getByRole('button', { name: 'Todas (3)' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'Reserva confirmada (1)' }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.getByRole('button', { name: 'Comprobante pendiente (1)' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reserva confirmada (1)' }));

    expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();
    expect(screen.queryByText('Barquisimeto → Caracas')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reserva confirmada (1)' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByText(/Mostrando 1 de 1 compra · 3 en total/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Todas (3)' }));
    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Todas (3)' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('filtra por el rango de fecha de salida en la zona de negocio', async () => {
    await renderConFixture();

    // Sin fecha elegida los campos piden "Elige una fecha" y no filtran.
    expect(screen.getByLabelText('Salida desde')).toHaveTextContent(
      'Elige una fecha',
    );
    expect(screen.getByLabelText('Salida hasta')).toHaveTextContent(
      'Elige una fecha',
    );

    // Desde hace 3 días: la salida de hace 6 días queda fuera.
    await pickDate('Salida desde', daysFromNow(-3));
    expect(screen.queryByText('Caracas → Maracaibo')).not.toBeInTheDocument();
    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();

    // Hasta dentro de 20 días: la salida de dentro de 40 días queda fuera.
    await pickDate('Salida hasta', daysFromNow(20));
    expect(screen.queryByText('Mérida → San Cristóbal')).not.toBeInTheDocument();
    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();

    // Limpiar las dos fechas restaura el historial completo.
    for (const button of screen.getAllByLabelText('Limpiar fecha')) {
      fireEvent.click(button);
    }
    expect(screen.getByText('Caracas → Maracaibo')).toBeInTheDocument();
    expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();
    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();
  });

  it('busca en TODO el historial, no solo en la página visible', async () => {
    listPurchases.mockResolvedValue(
      view(
        Array.from({ length: 7 }, (_, i) =>
          makeItem({
            attempt_id: `att-f${i + 1}`,
            trip: { ...makeItem().trip, origin: `Ciudad ${i + 1}` },
          }),
        ),
      ),
    );
    render(<MisComprasPage />);
    expect(await screen.findByText('Ciudad 1 → Caracas')).toBeInTheDocument();
    // La 6ª compra no cabe en la primera pantalla…
    expect(screen.queryByText('Ciudad 6 → Caracas')).not.toBeInTheDocument();

    // …pero el texto la encuentra igual: el filtro va sobre el historial.
    fireEvent.change(screen.getByLabelText('Buscar'), {
      target: { value: 'Ciudad 6' },
    });
    expect(screen.getByText('Ciudad 6 → Caracas')).toBeInTheDocument();
    expect(screen.getByText(/Mostrando 1 de 1 compra/)).toBeInTheDocument();
  });

  it('con filtros sin resultados ofrece limpiarlos y restaura el historial', async () => {
    await renderConFixture();

    fireEvent.change(screen.getByLabelText('Buscar'), {
      target: { value: 'zzzz' },
    });

    expect(
      await screen.findByText('Ninguna compra coincide con tus filtros'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/historial completo \(3 compras\)/),
    ).toBeInTheDocument();

    // CTA del empty state: único "Limpiar filtros" en pantalla.
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));

    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();
    expect(screen.getByText('Caracas → Maracaibo')).toBeInTheDocument();
    expect(
      screen.queryByText('Ninguna compra coincide con tus filtros'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Buscar')).toHaveValue('');
    // Limpiar es local: no vuelve a llamar al backend.
    expect(listPurchases).toHaveBeenCalledTimes(1);
  });

  it('limpia todos los filtros a la vez desde el contador de resultados', async () => {
    await renderConFixture();

    fireEvent.change(screen.getByLabelText('Buscar'), {
      target: { value: 'nomadas' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reserva confirmada (1)' }));

    expect(
      screen.getByText(/Mostrando 1 de 1 compra · 3 en total/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));

    expect(screen.getByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(screen.getByText('Caracas → Maracaibo')).toBeInTheDocument();
    expect(screen.getByLabelText('Buscar')).toHaveValue('');
    expect(
      screen.getByRole('button', { name: 'Todas (3)' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(listPurchases).toHaveBeenCalledTimes(1);
  });

  it('un filtro nuevo siempre vuelve a la primera página', async () => {
    listPurchases.mockResolvedValue(
      view(
        Array.from({ length: 7 }, (_, i) =>
          makeItem({
            attempt_id: `att-g${i + 1}`,
            trip: { ...makeItem().trip, origin: `Ciudad ${i + 1}` },
          }),
        ),
      ),
    );
    render(<MisComprasPage />);
    expect(await screen.findByText('Ciudad 1 → Caracas')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(screen.getByText('Página 2')).toBeInTheDocument();

    // Aplicar un filtro reinicia la página: nunca empezar fuera de rango.
    fireEvent.click(
      screen.getByRole('button', { name: 'Comprobante pendiente (7)' }),
    );
    expect(screen.getByText('Página 1')).toBeInTheDocument();
    expect(screen.getByText('Ciudad 1 → Caracas')).toBeInTheDocument();
  });

  it('un refresco de Realtime conserva los filtros activos del usuario', async () => {
    listPurchases.mockResolvedValue(view(filtrosFixture()));
    render(<MisComprasPage />);
    expect(await screen.findByText('Barquisimeto → Caracas')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Buscar'), {
      target: { value: 'merida' },
    });
    expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();
    expect(
      screen.queryByText('Barquisimeto → Caracas'),
    ).not.toBeInTheDocument();

    // Solo el debounce del refresco corre con timers falsos.
    vi.useFakeTimers();
    try {
      const onChange = vi.mocked(subscribeToPurchaseHistory).mock
        .calls[0][1] as () => void;
      act(() => {
        onChange();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      // El historial se recargó completo…
      expect(listPurchases).toHaveBeenCalledTimes(2);
      // …y la selección del usuario sigue intacta (nunca se limpia sola).
      expect(screen.getByLabelText('Buscar')).toHaveValue('merida');
      expect(screen.getByText('Mérida → San Cristóbal')).toBeInTheDocument();
      expect(
        screen.queryByText('Barquisimeto → Caracas'),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
