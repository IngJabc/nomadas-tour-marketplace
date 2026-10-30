import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { publicApi, type PublicTrip } from '@/lib/api';
import { subscribeToTripCatalog } from '@/lib/realtime/subscriptions';
import { formatSeatPrice } from '@/lib/price';
import { formatDateTimeShort, toBusinessDateString } from '@/lib/timezone';
import ViajesPage from '../page';

vi.mock('@/lib/api', () => ({
  publicApi: {
    trips: vi.fn(),
    tripDetail: vi.fn(),
    agencies: vi.fn(),
  },
}));

const realtime = vi.hoisted(() => {
  const cleanupRealtime = vi.fn();
  return {
    cleanupRealtime,
    subscribeToTripCatalog: vi.fn(() => cleanupRealtime),
  };
});

vi.mock('@/lib/realtime/subscriptions', () => realtime);

// Salida a las 11:00 UTC = 07:00 America/Caracas → siempre "futuro" relativo
// a hoy, para que el filtro de salidas pasadas no tumbe la fixture.
function isoAt(daysOffset: number): string {
  const date = new Date(Date.now() + daysOffset * 86_400_000);
  date.setUTCHours(11, 0, 0, 0);
  return date.toISOString();
}

const DEPARTURE = isoAt(400);
const PAST_DEPARTURE = isoAt(-5);

const trip: PublicTrip = {
  id: '441559e6-ea35-4453-aae1-5ed0844289b3',
  departure_time: DEPARTURE,
  capacity: 31,
  // Disponibilidad real: 3 asientos ya no están libres (reservados/bloqueados).
  available_seats: 28,
  vehicle_type: 'bus',
  status: 'active',
  route: { origin: 'Barquisimeto', destination: 'Ruta de prueba' },
  seat_price: 2020,
  lock_ttl_seconds: 900,
  agencies: [{ id: 'ag-1', name: 'Bianchi travels' }],
};

const pastTrip: PublicTrip = {
  id: '9c8f3f0a-1111-4444-8888-6f0f7f5a2b11',
  departure_time: PAST_DEPARTURE,
  capacity: 10,
  vehicle_type: 'kia',
  status: 'active',
  route: { origin: 'Maracaibo', destination: 'Ruta pasada' },
  seat_price: 2020,
  lock_ttl_seconds: 900,
};

const mockedTrips = vi.mocked(publicApi.trips);

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
  // El popover puede seguir en el DOM durante su animación de cierre; esperar
  // a que desaparezca evita calendarios duplicados.
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

describe('ViajesPage (MKT-002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('muestra los viajes activos del catalogo con fecha, capacidad y badge', async () => {
    mockedTrips.mockResolvedValue({ trips: [trip] });

    render(<ViajesPage />);

    expect(
      await screen.findByText('Barquisimeto → Ruta de prueba'),
    ).toBeInTheDocument();
    expect(screen.getByText(formatDateTimeShort(DEPARTURE))).toBeInTheDocument();
    // La línea de disponibilidad muestra la cifra REAL (available_seats=28),
    // no la capacidad total del vehículo.
    expect(screen.getByText(/28 asientos disponibles/)).toBeInTheDocument();
    expect(screen.getByText('Disponible')).toBeInTheDocument();
    // El badge superior muestra la capacidad TOTAL del vehículo.
    expect(screen.getByText('Autobús · 31 asientos')).toBeInTheDocument();
    // Una sola agencia: se muestra su nombre en la tarjeta.
    expect(screen.getByText('Bianchi travels')).toBeInTheDocument();
    expect(screen.getByText('Precio por asiento')).toBeInTheDocument();
    expect(screen.getByText(formatSeatPrice(2020))).toBeInTheDocument();
    expect(screen.queryByText('Precio por definir')).not.toBeInTheDocument();
    expect(screen.getByText('1 viaje disponible')).toBeInTheDocument();
  });

  it('marca el precio como "Precio por definir" y bloquea el CTA cuando el viaje no tiene seat_price', async () => {
    mockedTrips.mockResolvedValue({ trips: [{ ...trip, seat_price: null }] });

    render(<ViajesPage />);

    await screen.findByText('Barquisimeto → Ruta de prueba');

    expect(screen.getByText('Precio por asiento')).toBeInTheDocument();
    expect(screen.getByText('Precio por definir')).toBeInTheDocument();
    // Ningún importe ficticio ni badge de placeholder.
    expect(screen.queryByText('$250,00')).not.toBeInTheDocument();
    expect(screen.queryByText('Placeholder')).not.toBeInTheDocument();
    // El viaje permanece visible, pero no se puede iniciar la reserva.
    const reservar = screen.getByRole('button', { name: 'Reservar' });
    expect(reservar).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Reservar' })).not.toBeInTheDocument();
  });

  it('trata el precio cero como valor explícito distinto de null', async () => {
    mockedTrips.mockResolvedValue({ trips: [{ ...trip, seat_price: 0 }] });

    render(<ViajesPage />);

    await screen.findByText('Barquisimeto → Ruta de prueba');

    expect(screen.getByText('$0,00')).toBeInTheDocument();
    expect(screen.queryByText('Precio por definir')).not.toBeInTheDocument();
    const reservar = screen.getByRole('link', { name: 'Reservar' });
    expect(reservar).toHaveAttribute(
      'href',
      `/reservations/new?trip=${trip.id}`,
    );
  });

  it('no lista viajes cuya salida ya pasó', async () => {
    mockedTrips.mockResolvedValue({ trips: [pastTrip, trip] });

    render(<ViajesPage />);

    expect(
      await screen.findByText('Barquisimeto → Ruta de prueba'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Maracaibo → Ruta pasada')).not.toBeInTheDocument();
    expect(screen.queryByText('Kia · 10 asientos')).not.toBeInTheDocument();
    expect(screen.getByText('1 viaje disponible')).toBeInTheDocument();
  });

  it('si todos los viajes ya salieron, muestra el empty state del catálogo', async () => {
    mockedTrips.mockResolvedValue({ trips: [pastTrip] });

    render(<ViajesPage />);

    expect(
      await screen.findByText('Aún no hay viajes publicados'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Actualizar catálogo/ }),
    ).toBeInTheDocument();
  });

  it('el CTA Reservar lleva al checkout con el viaje preseleccionado', async () => {
    mockedTrips.mockResolvedValue({ trips: [trip] });

    render(<ViajesPage />);
    await screen.findByText('Barquisimeto → Ruta de prueba');

    const reservar = screen.getByRole('link', { name: 'Reservar' });
    expect(reservar).toHaveAttribute(
      'href',
      `/reservations/new?trip=${trip.id}`,
    );
  });

  it('con dos agencias muestra la primera con el indicador +N y el CTA abre el checkout', async () => {
    mockedTrips.mockResolvedValue({
      trips: [
        {
          ...trip,
          agencies: [
            { id: 'ag-1', name: 'Alfa Tours' },
            { id: 'ag-2', name: 'Beta Rutas' },
          ],
        },
      ],
    });

    render(<ViajesPage />);
    await screen.findByText('Barquisimeto → Ruta de prueba');

    expect(screen.getByText('Alfa Tours')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    // El selector de agencias vive DENTRO de /reservations/new: el CTA jamás
    // fija una agencia en silencio ni deriva a /trips/[id] (flujo anterior).
    const reservar = screen.getByRole('link', { name: 'Reservar' });
    expect(reservar).toHaveAttribute('href', `/reservations/new?trip=${trip.id}`);
  });

  it('con tres agencias el indicador cuenta las que no se muestran', async () => {
    mockedTrips.mockResolvedValue({
      trips: [
        {
          ...trip,
          agencies: [
            { id: 'ag-1', name: 'Alfa Tours' },
            { id: 'ag-2', name: 'Beta Rutas' },
            { id: 'ag-3', name: 'Gamma Viajes' },
          ],
        },
      ],
    });

    render(<ViajesPage />);
    await screen.findByText('Barquisimeto → Ruta de prueba');

    expect(screen.getByText('Alfa Tours')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    // Con3 agencias el CTA también va directo al checkout: el selector de
    // agencia es parte del wizard, nunca /trips/[id].
    const reservar = screen.getByRole('link', { name: 'Reservar' });
    expect(reservar).toHaveAttribute('href', `/reservations/new?trip=${trip.id}`);
  });

  it('sin agencias activas deshabilita el CTA y explica el motivo', async () => {
    mockedTrips.mockResolvedValue({ trips: [{ ...trip, agencies: [] }] });

    render(<ViajesPage />);
    await screen.findByText('Barquisimeto → Ruta de prueba');

    expect(
      screen.getByText('Sin agencias disponibles para reservar'),
    ).toBeInTheDocument();
    // Viaje visible, pero ninguna acción de reserva que se sepa imposible.
    const reservar = screen.getByRole('button', { name: 'Reservar' });
    expect(reservar).toBeDisabled();
    expect(
      screen.queryByRole('link', { name: 'Reservar' }),
    ).not.toBeInTheDocument();
  });

  it('filtra por destino y permite limpiar los filtros', async () => {
    mockedTrips.mockResolvedValue({ trips: [trip] });

    render(<ViajesPage />);
    await screen.findByText('Barquisimeto → Ruta de prueba');

    fireEvent.change(screen.getByLabelText('Destino'), {
      target: { value: 'Maracaibo' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Buscar/ }));

    expect(
      await screen.findByText('No hay viajes que coincidan con tu búsqueda'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));

    expect(
      await screen.findByText('Barquisimeto → Ruta de prueba'),
    ).toBeInTheDocument();
  });

  it('filtra por fecha de salida en la zona horaria de negocio', async () => {
    mockedTrips.mockResolvedValue({ trips: [trip] });

    render(<ViajesPage />);
    await screen.findByText('Barquisimeto → Ruta de prueba');

    // Sin fecha elegida el campo pide "Elige una fecha" y no filtra nada.
    expect(screen.getByLabelText('Fecha')).toHaveTextContent('Elige una fecha');

    // Un día distinto al de la salida no coincide (hoy, sin navegar de mes).
    await pickDate('Fecha', new Date());
    fireEvent.click(screen.getByRole('button', { name: /Buscar/ }));

    expect(
      await screen.findByText('No hay viajes que coincidan con tu búsqueda'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));

    // Salida 11:00 UTC = 07:00 America/Caracas → mismo día de negocio.
    const salida = new Date(`${toBusinessDateString(DEPARTURE)}T12:00`);
    await pickDate('Fecha', salida);
    fireEvent.click(screen.getByRole('button', { name: /Buscar/ }));

    expect(
      await screen.findByText('Barquisimeto → Ruta de prueba'),
    ).toBeInTheDocument();
  });

  it('muestra empty state cuando el catalogo esta vacio', async () => {
    mockedTrips.mockResolvedValue({ trips: [] });

    render(<ViajesPage />);

    expect(
      await screen.findByText('Aún no hay viajes publicados'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Actualizar catálogo/ }),
    ).toBeInTheDocument();
  });

  it('muestra estado de error con reintentar si la API falla', async () => {
    mockedTrips.mockRejectedValueOnce(new Error('boom'));

    render(<ViajesPage />);

    expect(
      await screen.findByText('No pudimos cargar los viajes'),
    ).toBeInTheDocument();
    // SEC-02: un error no-API ya no se renderiza crudo; se muestra copy segura.
    expect(screen.getByText('No pudimos conectar con el catálogo. Intenta de nuevo.')).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();

    mockedTrips.mockResolvedValue({ trips: [trip] });
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));

    expect(
      await screen.findByText('Barquisimeto → Ruta de prueba'),
    ).toBeInTheDocument();
  });
});

describe('ViajesPage realtime (RT-04A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('suscribe trips + trip_agencies + agencies con los ids cargados', async () => {
    mockedTrips.mockResolvedValue({ trips: [trip] });

    render(<ViajesPage />);
    await screen.findByText('Barquisimeto → Ruta de prueba');

    // Dos pasadas del efecto: ids vacíos al montar y ids reales tras cargar.
    expect(subscribeToTripCatalog).toHaveBeenCalledTimes(2);
    const [tripIds, agencyIds] = vi.mocked(subscribeToTripCatalog).mock.calls[1];
    expect(tripIds).toEqual([trip.id]);
    expect(agencyIds).toEqual(['ag-1']);
  });

  it('desuscribe el catálogo al desmontar', async () => {
    mockedTrips.mockResolvedValue({ trips: [trip] });

    const { unmount } = render(<ViajesPage />);
    await screen.findByText('Barquisimeto → Ruta de prueba');

    unmount();
    // Limpieza de cada pasada del efecto + la del desmontaje.
    expect(realtime.cleanupRealtime).toHaveBeenCalledTimes(2);
  });
});

describe('ViajesPage realtime refrescos (RT-04A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('un evento re-consulta el catálogo en segundo plano tras el debounce', async () => {
    mockedTrips.mockResolvedValue({ trips: [trip] });

    render(<ViajesPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedTrips).toHaveBeenCalledTimes(1);

    const onChange = vi.mocked(subscribeToTripCatalog).mock.calls[0][2] as () => void;
    // Ráfaga de eventos colapsada en UNA recarga.
    act(() => {
      onChange();
      onChange();
    });
    // Refresco silencioso: el catálogo permanece visible (sin skeleton).
    expect(screen.getByText('Barquisimeto → Ruta de prueba')).toBeInTheDocument();
    expect(mockedTrips).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockedTrips).toHaveBeenCalledTimes(2);
  });

  it('cancela el refresco pendiente al desmontar', async () => {
    mockedTrips.mockResolvedValue({ trips: [trip] });

    const { unmount } = render(<ViajesPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const onChange = vi.mocked(subscribeToTripCatalog).mock.calls[0][2] as () => void;
    act(() => {
      onChange();
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockedTrips).toHaveBeenCalledTimes(1);
  });

  it('muestra banner inline cuando el refresco en segundo plano falla, sin ocultar el catálogo', async () => {
    mockedTrips.mockResolvedValue({ trips: [trip] });
    mockedTrips.mockResolvedValueOnce({ trips: [trip] }).mockRejectedValueOnce(
      new Error('fallo de red'),
    );

    render(<ViajesPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const onChange = vi.mocked(subscribeToTripCatalog).mock.calls[0][2] as () => void;
    act(() => {
      onChange();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    // SEC-02: el mensaje crudo del mock ya no se expone; copy segura.
    expect(screen.getByText('No pudimos conectar con el catálogo. Intenta de nuevo.')).toBeInTheDocument();
    expect(screen.queryByText('fallo de red')).not.toBeInTheDocument();
    expect(screen.getByText('Barquisimeto → Ruta de prueba')).toBeInTheDocument();
  });
});
