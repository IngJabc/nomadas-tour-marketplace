import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { publicApi, type PublicTrip } from '@/lib/api';
import { formatDateTimeShort, toBusinessDateString } from '@/lib/timezone';
import ViajesPage from '../page';

vi.mock('@/lib/api', () => ({
  publicApi: {
    trips: vi.fn(),
    tripDetail: vi.fn(),
    agencies: vi.fn(),
  },
}));

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
  vehicle_type: 'bus',
  status: 'active',
  route: { origin: 'Barquisimeto', destination: 'Ruta de prueba' },
  lock_ttl_seconds: 900,
};

const pastTrip: PublicTrip = {
  id: '9c8f3f0a-1111-4444-8888-6f0f7f5a2b11',
  departure_time: PAST_DEPARTURE,
  capacity: 10,
  vehicle_type: 'kia',
  status: 'active',
  route: { origin: 'Maracaibo', destination: 'Ruta pasada' },
  lock_ttl_seconds: 900,
};

const mockedTrips = vi.mocked(publicApi.trips);

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
    expect(screen.getByText(/31 asientos disponibles/)).toBeInTheDocument();
    expect(screen.getByText('Disponible')).toBeInTheDocument();
    expect(screen.getByText('Autobús · 31 asientos')).toBeInTheDocument();
    expect(screen.getByText('1 viaje disponible')).toBeInTheDocument();
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
      `/reservas/nueva?trip=${trip.id}`,
    );
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

    // Un día distinto al de la salida no coincide.
    fireEvent.change(screen.getByLabelText('Fecha'), {
      target: { value: '2000-01-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Buscar/ }));

    expect(
      await screen.findByText('No hay viajes que coincidan con tu búsqueda'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));

    // Salida 11:00 UTC = 07:00 America/Caracas → mismo día de negocio.
    fireEvent.change(screen.getByLabelText('Fecha'), {
      target: { value: toBusinessDateString(DEPARTURE) },
    });
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
    expect(screen.getByText('boom')).toBeInTheDocument();

    mockedTrips.mockResolvedValue({ trips: [trip] });
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));

    expect(
      await screen.findByText('Barquisimeto → Ruta de prueba'),
    ).toBeInTheDocument();
  });
});
