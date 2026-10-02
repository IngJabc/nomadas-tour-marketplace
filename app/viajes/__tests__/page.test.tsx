import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { publicApi, type PublicTrip } from '@/lib/api';
import ViajesPage from '../page';

vi.mock('@/lib/api', () => ({
  publicApi: {
    trips: vi.fn(),
    tripDetail: vi.fn(),
    agencies: vi.fn(),
  },
}));

const trip: PublicTrip = {
  id: '441559e6-ea35-4453-aae1-5ed0844289b3',
  departure_time: '2026-10-04T11:00:00+00:00',
  capacity: 31,
  vehicle_type: 'bus',
  status: 'active',
  route: { origin: 'Barquisimeto', destination: 'Ruta de prueba' },
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
    expect(screen.getByText(/4 oct 2026/)).toBeInTheDocument();
    expect(screen.getByText(/31 asientos disponibles/)).toBeInTheDocument();
    expect(screen.getByText('Disponible')).toBeInTheDocument();
    expect(screen.getByText('Autobús · 31 asientos')).toBeInTheDocument();
    expect(screen.getByText('1 viaje disponible')).toBeInTheDocument();
  });

  it('la accion Reservar esta deshabilitada hasta MKT-003/004', async () => {
    mockedTrips.mockResolvedValue({ trips: [trip] });

    render(<ViajesPage />);
    await screen.findByText('Barquisimeto → Ruta de prueba');

    const reservar = screen.getByRole('button', { name: 'Reservar' });
    expect(reservar).toBeDisabled();
    expect(screen.getByText('Próximamente')).toBeInTheDocument();
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

    // Salida 11:00 UTC = 07:00 America/Caracas -> 2026-10-04
    fireEvent.change(screen.getByLabelText('Fecha'), {
      target: { value: '2026-10-05' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Buscar/ }));

    expect(
      await screen.findByText('No hay viajes que coincidan con tu búsqueda'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));

    fireEvent.change(screen.getByLabelText('Fecha'), {
      target: { value: '2026-10-04' },
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
