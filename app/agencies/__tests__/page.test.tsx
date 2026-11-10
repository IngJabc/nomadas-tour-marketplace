import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { publicApi, type PublicAgency } from '@/lib/api';
import AgenciasPage from '../page';

vi.mock('@/lib/api', () => ({
  publicApi: {
    agencies: vi.fn(),
    agencyDetail: vi.fn(),
  },
}));

const mockedAgencies = vi.mocked(publicApi.agencies);

/** Respuesta que nunca se resuelve: mantiene la pantalla en loading. */
const PENDING_LIST = new Promise<{ agencies: PublicAgency[]; total: number }>(
  () => {},
);

const FEATURED_ID = '11111111-2222-4333-8444-555555555555';
const REGULAR_ID = '22222222-3333-4444-8555-666666666666';

function makeAgency(overrides: Partial<PublicAgency> = {}): PublicAgency {
  return {
    id: REGULAR_ID,
    name: 'Bianchi travels',
    subdomain: 'bianchi',
    logo_url: null,
    primary_color: '#0F766E',
    secondary_color: null,
    accent_color: null,
    is_featured: false,
    featured_order: 0,
    // Las dos calificaciones SIEMPRE separadas: jamás un promedio combinado.
    ratings: {
      agency: { average: 4.5, count: 10 },
      trip: { average: 4.2, count: 5 },
    },
    published_trips_count: 7,
    ...overrides,
  };
}

/** N agencias sintéticas para paginar (ids únicos y orden estable). */
function makeAgencies(count: number, startIndex = 1): PublicAgency[] {
  return Array.from({ length: count }, (_, i) =>
    makeAgency({
      id: `${String(i + startIndex).padStart(8, '0')}-0000-4000-8000-000000000000`,
      name: `Agencia ${i + startIndex}`,
      ratings: { agency: { average: null, count: 0 }, trip: { average: null, count: 0 } },
      published_trips_count: 0,
    }),
  );
}

describe('AgenciasPage — directorio público (REP-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Limpia también la implementación base (p. ej. la promesa pendiente)
    // para que ninguna prueba arrastre el mock de la anterior.
    mockedAgencies.mockReset();
  });

  it('muestra identidad, branding, calificaciones separadas y viajes publicados', async () => {
    mockedAgencies.mockResolvedValue({ agencies: [makeAgency()], total: 1 });

    render(<AgenciasPage />);

    expect(await screen.findByText('Bianchi travels')).toBeInTheDocument();

    // Branding público de la agencia pintado desde la API (nunca a mano).
    const strip = screen.getByTestId('agency-branding-strip');
    expect(strip).toHaveStyle({ backgroundColor: '#0F766E' });

    // Las DOS calificaciones se presentan por separado, con su propio valor.
    expect(screen.getByText('Agencia')).toBeInTheDocument();
    expect(screen.getByText('Viajes')).toBeInTheDocument();
    expect(screen.getByText('4.5')).toBeInTheDocument();
    expect(screen.getByText('10 reseñas')).toBeInTheDocument();
    expect(screen.getByText('4.2')).toBeInTheDocument();
    expect(screen.getByText('5 reseñas')).toBeInTheDocument();
    // Nunca existe un promedio combinado en la UI.
    expect(screen.queryByText('4,4')).not.toBeInTheDocument();

    // Contador de viajes publicados.
    expect(
      screen.getByText('7 viajes publicados disponibles'),
    ).toBeInTheDocument();

    // Agencia NO destacada: sin píldora de destacada.
    expect(screen.queryByText('Destacada')).not.toBeInTheDocument();
    expect(screen.getByText('1 agencia conectada')).toBeInTheDocument();
  });

  it('sirve las destacadas en el orden del API y las distingue con su píldora', async () => {
    mockedAgencies.mockResolvedValue({
      agencies: [
        makeAgency({
          id: FEATURED_ID,
          name: 'Alpha Destacada',
          is_featured: true,
          featured_order: 1,
        }),
        makeAgency({ name: 'Zulu Normal' }),
      ],
      total: 2,
    });

    render(<AgenciasPage />);

    expect(await screen.findByText('Alpha Destacada')).toBeInTheDocument();

    // El orden del backend se respeta tal cual: la destacada va primero.
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings[0]).toHaveTextContent('Alpha Destacada');
    expect(headings[1]).toHaveTextContent('Zulu Normal');

    // Solo la primera está marcada como destacada.
    expect(screen.getAllByText('Destacada')).toHaveLength(1);

    // Cada tarjeta lleva a su perfil público.
    expect(
      screen.getByRole('link', { name: 'Ver perfil de Alpha Destacada' }),
    ).toHaveAttribute('href', `/agencies/${FEATURED_ID}`);
  });

  it('muestra el esqueleto de carga mientras resuelve el listado', () => {
    mockedAgencies.mockReturnValue(PENDING_LIST);

    render(<AgenciasPage />);

    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText(/agencias? conectadas?/)).not.toBeInTheDocument();
    expect(mockedAgencies).toHaveBeenCalledWith({ limit: 12, offset: 0 });
  });

  it('pagina por offset del API y muestra el total de páginas', async () => {
    mockedAgencies
      .mockResolvedValueOnce({ agencies: makeAgencies(12, 1), total: 30 })
      .mockResolvedValueOnce({ agencies: makeAgencies(12, 13), total: 30 });

    render(<AgenciasPage />);

    expect(await screen.findByText('Agencia 1')).toBeInTheDocument();
    expect(mockedAgencies).toHaveBeenNthCalledWith(1, { limit: 12, offset: 0 });
    expect(screen.getByText('Página 1 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));

    expect(await screen.findByText('Agencia 13')).toBeInTheDocument();
    expect(mockedAgencies).toHaveBeenLastCalledWith({ limit: 12, offset: 12 });
    expect(screen.getByText('Página 2 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeEnabled();
  });

  it('recupera la primera página si el total se reduce y caemos fuera de rango', async () => {
    mockedAgencies
      .mockResolvedValueOnce({ agencies: makeAgencies(12, 1), total: 30 })
      // El total cayó a una sola página mientras estábamos en la 2ª.
      .mockResolvedValueOnce({ agencies: [], total: 12 })
      .mockResolvedValueOnce({ agencies: makeAgencies(12, 1), total: 12 });

    render(<AgenciasPage />);
    await screen.findByText('Agencia 1');

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));

    // Nunca una rejilla en blanco: vuelve al inicio del listado.
    expect(await screen.findByText('Agencia 1')).toBeInTheDocument();
    expect(screen.queryByText('Agencia 13')).not.toBeInTheDocument();
    expect(mockedAgencies).toHaveBeenLastCalledWith({ limit: 12, offset: 0 });
    // Con una sola página la paginación deja de renderizarse.
    expect(screen.queryByRole('button', { name: 'Siguiente' })).not.toBeInTheDocument();
  });

  it('muestra empty state con CTA cuando no hay agencias publicadas', async () => {
    mockedAgencies.mockResolvedValue({ agencies: [], total: 0 });

    render(<AgenciasPage />);

    expect(
      await screen.findByText('Aún no hay agencias publicadas'),
    ).toBeInTheDocument();

    const cta = screen.getByRole('link', { name: /Explorar viajes/ });
    expect(cta).toHaveAttribute('href', '/trips');
  });

  it('muestra estado de error con reintentar sin exponer el mensaje crudo', async () => {
    mockedAgencies.mockRejectedValueOnce(new Error('boom'));

    render(<AgenciasPage />);

    expect(await screen.findByText('No pudimos cargar las agencias')).toBeInTheDocument();
    // SEC-02: el texto crudo del error jamás llega al usuario.
    expect(
      screen.getByText('No pudimos conectar con el directorio. Intenta de nuevo.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();

    mockedAgencies.mockResolvedValue({ agencies: [makeAgency()], total: 1 });
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));

    expect(await screen.findByText('Bianchi travels')).toBeInTheDocument();
    expect(mockedAgencies).toHaveBeenCalledTimes(2);
  });
});
