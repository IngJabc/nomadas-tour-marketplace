import { Suspense } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publicApi, type PublicTripDetail, type PublicTripSeat } from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import TripDetailPage from '../page';

vi.mock('@/lib/api', () => ({
  publicApi: {
    trips: vi.fn(),
    tripDetail: vi.fn(),
    agencies: vi.fn(),
  },
}));

const mockedTripDetail = vi.mocked(publicApi.tripDetail);

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

async function renderPage(id = 'trip-1') {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <Suspense fallback={null}>
        <TripDetailPage params={Promise.resolve({ 'slug-or-id': id })} />
      </Suspense>,
    );
  });
  return view;
}

function seatButtons() {
  return screen
    .getAllByRole('button')
    .filter((button) =>
      (button.getAttribute('aria-label') ?? '').startsWith('Asiento '),
    );
}

describe('TripDetailPage (MKT-003)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

    expect(seatButtons()).toHaveLength(31);
    expect(
      screen.getByRole('button', { name: 'Asiento A1, disponible' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Asiento A31, disponible' }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('list', { name: 'Leyenda de asientos' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continuar con la reserva' }),
    ).toBeDisabled();
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

  it('selecciona asientos en el mapa sin llamar a la API de bloqueo', async () => {
    mockedTripDetail.mockResolvedValue({ trip: buildTrip() });

    await renderPage();
    await screen.findByRole('heading', { name: 'Barquisimeto → Caracas' });

    fireEvent.click(screen.getByRole('button', { name: 'Asiento A5, disponible' }));

    expect(
      screen.getByRole('button', { name: 'Asiento A5, seleccionado' }),
    ).toHaveAttribute('data-state', 'selected');
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 asiento seleccionado: A5',
    );
    expect(mockedTripDetail).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole('button', { name: 'Asiento A5, seleccionado' }),
    );

    expect(
      screen.getByRole('button', { name: 'Asiento A5, disponible' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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
    expect(
      screen.getByRole('button', { name: 'Sin asientos disponibles' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Asiento A1, reservado' }),
    ).toBeDisabled();
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
    expect(
      screen.getByRole('button', { name: 'Continuar con la reserva' }),
    ).toBeDisabled();
  });
});
