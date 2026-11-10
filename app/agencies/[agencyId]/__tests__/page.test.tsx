import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  publicApi,
  type PublicAgencyProfile,
  type PublicTrip,
} from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import PerfilAgenciaPage from '../page';

const paramsState = vi.hoisted(() => ({
  agencyId: 'ab3c4d5e-6f70-4a8b-9c1d-2e3f4a5b6c7d',
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ agencyId: paramsState.agencyId }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({
  publicApi: {
    agencies: vi.fn(),
    agencyDetail: vi.fn(),
  },
}));

const mockedDetail = vi.mocked(publicApi.agencyDetail);

const AGENCY_ID = paramsState.agencyId;

/**
 * El nombre de la agencia también aparece dentro de las tarjetas de viaje,
 * así que el h1 del storefront es la referencia única y estable.
 */
function findAgencyHeading() {
  return screen.findByRole('heading', { level: 1, name: 'Bianchi travels' });
}

// Salida a las 11:00 UTC = 07:00 America/Caracas → siempre futuro.
function isoAt(daysOffset: number): string {
  const date = new Date(Date.now() + daysOffset * 86_400_000);
  date.setUTCHours(11, 0, 0, 0);
  return date.toISOString();
}

const DEPARTURE = isoAt(400);

const trip: PublicTrip = {
  id: '441559e6-ea35-4453-aae1-5ed0844289b3',
  departure_time: DEPARTURE,
  capacity: 31,
  available_seats: 28,
  vehicle_type: 'bus',
  status: 'active',
  route: { origin: 'Barquisimeto', destination: 'Caracas' },
  seat_price: 2020,
  lock_ttl_seconds: 900,
  agencies: [{ id: AGENCY_ID, name: 'Bianchi travels' }],
};

function makeProfile(
  overrides: Partial<PublicAgencyProfile> = {},
): PublicAgencyProfile {
  return {
    id: AGENCY_ID,
    name: 'Bianchi travels',
    subdomain: 'bianchi',
    logo_url: null,
    primary_color: '#0F766E',
    secondary_color: null,
    accent_color: null,
    is_featured: false,
    featured_order: 0,
    ratings: {
      agency: { average: 4.5, count: 10 },
      trip: { average: 4.2, count: 5 },
    },
    published_trips_count: 7,
    phone: '+584121234567',
    // Phase 7 — presentación del storefront (sin personalizar por defecto).
    cover_url: null,
    slogan: null,
    description: null,
    // Solo contactos públicos + activos: así los entrega el backend.
    contacts: [
      {
        id: 'c1',
        label: 'WhatsApp central',
        phone: '+584121234567',
        channel: 'whatsapp',
      },
    ],
    trips: [trip],
    trips_total: 1,
    ...overrides,
  };
}

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

/** Fija una fecha con el DatePicker (patrón del test de /trips). */
async function pickDate(label: string, target: Date) {
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

describe('Perfil de agencia pública (REP-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedDetail.mockReset();
  });

  it('muestra identidad, branding, destacada y las DOS calificaciones separadas', async () => {
    mockedDetail.mockResolvedValue({ agency: makeProfile({ is_featured: true }) });

    render(<PerfilAgenciaPage />);

    expect(await findAgencyHeading()).toBeInTheDocument();

    // Branding público pintado desde la API.
    const strip = screen.getByTestId('agency-branding-strip');
    expect(strip.getAttribute('style') ?? '').toMatch(/#0F766E|rgb\(15,\s*118,\s*110\)/);

    // Identidad: destacada + enlace de vuelta al directorio.
    expect(screen.getByText('Destacada')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Todas las agencias/ })).toHaveAttribute(
      'href',
      '/agencies',
    );

    // Las dos calificaciones viajan y se muestran POR SEPARADO.
    expect(screen.getByText('Calificación de la agencia')).toBeInTheDocument();
    expect(screen.getByText('Calificación de sus viajes')).toBeInTheDocument();
    expect(screen.getByText('4.5')).toBeInTheDocument();
    expect(screen.getByText('10 reseñas')).toBeInTheDocument();
    expect(screen.getByText('4.2')).toBeInTheDocument();
    expect(screen.getByText('5 reseñas')).toBeInTheDocument();

    // Estadística de viajes publicados.
    expect(
      screen.getByText('7 viajes publicados disponibles'),
    ).toBeInTheDocument();

    // Primera carga: sin filtros y sin offset.
    expect(mockedDetail).toHaveBeenCalledWith(
      AGENCY_ID,
      expect.objectContaining({ limit: 12, offset: 0 }),
    );
  });

  it('lista los viajes publicados con la tarjeta del catálogo y su CTA', async () => {
    mockedDetail.mockResolvedValue({ agency: makeProfile() });

    render(<PerfilAgenciaPage />);

    expect(await screen.findByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(screen.getByText(/28 asientos disponibles/)).toBeInTheDocument();

    const reservar = screen.getByRole('link', { name: 'Reservar' });
    expect(reservar).toHaveAttribute(
      'href',
      `/reservations/new?trip=${trip.id}`,
    );
    // Sin filtros la cabecera ya publica el total de viajes de la agencia.
    expect(
      screen.getByText('7 viajes publicados disponibles'),
    ).toBeInTheDocument();
  });

  it('publica solo los contactos activos de la agencia, nunca pagos ni correos', async () => {
    mockedDetail.mockResolvedValue({
      agency: makeProfile({
        contacts: [
          {
            id: 'c1',
            label: 'WhatsApp central',
            phone: '+584121234567',
            channel: 'whatsapp',
          },
          {
            id: 'c2',
            label: 'Teléfono oficina',
            phone: '+584129998877',
            channel: 'call',
          },
        ],
      }),
    });

    render(<PerfilAgenciaPage />);
    await findAgencyHeading();

    expect(
      screen.getByRole('link', { name: /WhatsApp central/ }),
    ).toHaveAttribute('href', 'https://wa.me/584121234567');
    expect(
      screen.getByRole('link', { name: /Teléfono oficina/ }),
    ).toHaveAttribute('href', 'tel:+584129998877');

    // Nunca información privada: sin métodos de pago ni canales de correo.
    expect(screen.queryByText(/métodos? de pago/i)).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('usa el teléfono público legado como respaldo cuando no hay contactos', async () => {
    mockedDetail.mockResolvedValue({
      agency: makeProfile({ contacts: [], phone: '04121234567' }),
    });

    render(<PerfilAgenciaPage />);
    await findAgencyHeading();

    expect(
      screen.getByRole('link', { name: /Contactar por WhatsApp/ }),
    ).toHaveAttribute('href', 'https://wa.me/584121234567');
    expect(screen.getByText('04121234567')).toBeInTheDocument();
    expect(
      screen.queryByText('Esta agencia aún no publica canales de contacto.'),
    ).not.toBeInTheDocument();
  });

  it('sin contactos ni teléfono explica que no hay canales publicados', async () => {
    mockedDetail.mockResolvedValue({
      agency: makeProfile({ contacts: [], phone: null }),
    });

    render(<PerfilAgenciaPage />);

    expect(
      await screen.findByText('Esta agencia aún no publica canales de contacto.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Contactar por WhatsApp/ }),
    ).not.toBeInTheDocument();
  });

  it('filtra por origen, destino y fecha en el servidor', async () => {
    mockedDetail.mockResolvedValue({ agency: makeProfile() });

    render(<PerfilAgenciaPage />);
    await screen.findByText('Barquisimeto → Caracas');

    const target = new Date(Date.now() + 30 * 86_400_000);
    const expectedDate = [
      target.getFullYear(),
      String(target.getMonth() + 1).padStart(2, '0'),
      String(target.getDate()).padStart(2, '0'),
    ].join('-');

    fireEvent.change(screen.getByLabelText('Origen'), {
      target: { value: 'Barquisimeto' },
    });
    fireEvent.change(screen.getByLabelText('Destino'), {
      target: { value: 'Caracas' },
    });
    await pickDate('Fecha', target);
    // El DatePicker formatea en dd/mm/yyyy (zona de negocio).
    expect(screen.getByLabelText('Fecha')).toHaveTextContent(
      format(target, 'dd/MM/yyyy'),
    );

    fireEvent.click(screen.getByRole('button', { name: /Buscar/ }));

    await waitFor(() => {
      expect(mockedDetail).toHaveBeenLastCalledWith(
        AGENCY_ID,
        expect.objectContaining({
          origin: 'Barquisimeto',
          destination: 'Caracas',
          date: expectedDate,
          limit: 12,
          offset: 0,
        }),
      );
    });
  });

  it('limpia los filtros y vuelve a la primera página sin filtro', async () => {
    mockedDetail
      .mockResolvedValueOnce({ agency: makeProfile() })
      .mockResolvedValueOnce({ agency: makeProfile({ trips: [], trips_total: 0 }) })
      .mockResolvedValue({ agency: makeProfile() });

    render(<PerfilAgenciaPage />);
    await screen.findByText('Barquisimeto → Caracas');

    fireEvent.change(screen.getByLabelText('Origen'), {
      target: { value: 'Maracaibo' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Buscar/ }));

    expect(
      await screen.findByText('No hay viajes que coincidan con tu búsqueda'),
    ).toBeInTheDocument();

    // Aparece en el formulario y en el empty state: ambos limpian lo mismo.
    fireEvent.click(screen.getAllByRole('button', { name: 'Limpiar filtros' })[0]);

    expect(await screen.findByText('Barquisimeto → Caracas')).toBeInTheDocument();
    expect(mockedDetail).toHaveBeenLastCalledWith(
      AGENCY_ID,
      expect.objectContaining({ limit: 12, offset: 0 }),
    );
  });

  it('pagina los viajes por offset del API', async () => {
    mockedDetail
      .mockResolvedValueOnce({ agency: makeProfile({ trips_total: 30 }) })
      .mockResolvedValueOnce({ agency: makeProfile({ trips_total: 30 }) });

    render(<PerfilAgenciaPage />);
    await screen.findByText('Barquisimeto → Caracas');

    expect(screen.getByText('Página 1 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));

    await waitFor(() => {
      expect(mockedDetail).toHaveBeenLastCalledWith(
        AGENCY_ID,
        expect.objectContaining({ limit: 12, offset: 12 }),
      );
    });
    expect(await screen.findByText('Página 2 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeEnabled();
  });

  it('muestra empty state con CTA cuando la agencia aún no publica viajes', async () => {
    mockedDetail.mockResolvedValue({
      agency: makeProfile({
        trips: [],
        trips_total: 0,
        published_trips_count: 0,
      }),
    });

    render(<PerfilAgenciaPage />);

    expect(
      await screen.findByText('Esta agencia aún no tiene viajes publicados'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Explorar todos los viajes/ }),
    ).toHaveAttribute('href', '/trips');
  });

  it('muestra estado de error con reintento sin exponer el mensaje crudo', async () => {
    mockedDetail.mockRejectedValueOnce(new Error('boom'));

    render(<PerfilAgenciaPage />);

    expect(
      await screen.findByText('No pudimos cargar esta agencia'),
    ).toBeInTheDocument();
    // SEC-02: el texto crudo jamás llega al usuario.
    expect(
      screen.getByText('No pudimos conectar con la agencia. Intenta de nuevo.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Ver todas las agencias/ }),
    ).toHaveAttribute('href', '/agencies');

    mockedDetail.mockResolvedValue({ agency: makeProfile() });
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));

    expect(await findAgencyHeading()).toBeInTheDocument();
    expect(mockedDetail).toHaveBeenCalledTimes(2);
  });

  it('una agencia inexistente (404) muestra el copy público del backend', async () => {
    mockedDetail.mockRejectedValue(
      new ApiError('Agencia no encontrada', 'AGENCY_NOT_FOUND', 404),
    );

    render(<PerfilAgenciaPage />);

    expect(
      await screen.findByText('No pudimos cargar esta agencia'),
    ).toBeInTheDocument();
    expect(screen.getByText('Agencia no encontrada')).toBeInTheDocument();
    expect(
      screen.getByText('Este perfil no está disponible en este momento.'),
    ).toBeInTheDocument();
  });

  describe('storefront (identidad y branding)', () => {
    it('presenta el storefront con tinte de marca, logo público y acceso al catálogo', async () => {
      mockedDetail.mockResolvedValue({
        agency: makeProfile({ logo_url: 'https://cdn.example.com/logo.png' }),
      });

      render(<PerfilAgenciaPage />);
      await findAgencyHeading();

      // El bloque de identidad existe y lleva la franja de marca.
      expect(screen.getByTestId('agency-storefront')).toBeInTheDocument();
      const strip = screen.getByTestId('agency-branding-strip');
      expect(strip.getAttribute('style') ?? '').toMatch(
        /#0F766E|rgb\(15,\s*118,\s*110\)/,
      );

      // Base oscura de la marca (banner) y título en blanco: identidad de
      // storefront sin sacrificar contraste.
      expect(screen.getByTestId('agency-storefront').className).toContain(
        'bg-brand-dark',
      );
      expect(
        screen.getByRole('heading', { level: 1 }).className,
      ).toContain('text-white');

      // Banner oscuro de marca con el color de la API como overlay: nunca
      // pintado a mano y con contraste AA para el texto blanco.
      const tint = screen.getByTestId('agency-branding-tint');
      expect(tint.getAttribute('style') ?? '').toMatch(
        /#0F766E|rgb\(15,\s*118,\s*110\)/,
      );
      expect(tint.getAttribute('style') ?? '').toMatch(/opacity:\s*0\.22/);

      // Logo real de la agencia (alt nombra a la agencia).
      expect(screen.getByAltText('Logo de Bianchi travels')).toBeInTheDocument();

      // CTA del storefront: ancla al catálogo de la MISMA página.
      const cta = screen.getByRole('link', { name: 'Ver viajes' });
      expect(cta).toHaveAttribute('href', '#agency-trips');
      expect(document.getElementById('agency-trips')).not.toBeNull();
    });

    it('sin colores de marca el storefront conserva el respaldo legible', async () => {
      mockedDetail.mockResolvedValue({
        agency: makeProfile({ primary_color: null, secondary_color: null, accent_color: null }),
      });

      render(<PerfilAgenciaPage />);
      await findAgencyHeading();

      // Sin branding no se pinta ningún tinte ni franja inventados.
      expect(screen.queryByTestId('agency-branding-tint')).toBeNull();
      expect(screen.queryByTestId('agency-branding-strip')).toBeNull();
      // El nombre sigue siendo el h1 de la página.
      expect(
        screen.getByRole('heading', { level: 1, name: 'Bianchi travels' }),
      ).toBeInTheDocument();
    });

    it('pinta la portada del storefront cuando la agencia la publica', async () => {
      mockedDetail.mockResolvedValue({
        agency: makeProfile({
          cover_url: 'https://cdn.example.com/cover.png',
        }),
      });

      render(<PerfilAgenciaPage />);
      await findAgencyHeading();

      const cover = screen.getByAltText('Portada de Bianchi travels');
      expect(cover).toHaveAttribute('src', 'https://cdn.example.com/cover.png');
      expect(cover.className).toContain('object-cover');
      // La portada va dentro del banner de identidad, antes del contenido.
      expect(
        screen.getByTestId('agency-storefront').contains(cover),
      ).toBe(true);
    });

    it('sin portada (o con URL inválida) conserva el banner de marca', async () => {
      mockedDetail.mockResolvedValue({
        agency: makeProfile({ cover_url: 'javascript:alert(1)' }),
      });

      render(<PerfilAgenciaPage />);
      await findAgencyHeading();

      expect(screen.queryByAltText('Portada de Bianchi travels')).toBeNull();
      expect(screen.getByTestId('agency-storefront').className).toContain(
        'bg-brand-dark',
      );
    });

    it('muestra el slogan de la agencia bajo el nombre', async () => {
      mockedDetail.mockResolvedValue({
        agency: makeProfile({ slogan: 'Viaja seguro, viaja con nosotros' }),
      });

      render(<PerfilAgenciaPage />);

      const heading = await findAgencyHeading();
      expect(
        screen.getByText('Viaja seguro, viaja con nosotros'),
      ).toBeInTheDocument();
      // El slogan vive en el banner, junto al h1 (no en otra sección).
      expect(
        screen
          .getByTestId('agency-storefront')
          .contains(screen.getByText('Viaja seguro, viaja con nosotros')),
      ).toBe(true);
      expect(heading).toBeInTheDocument();
    });

    it('publica la descripción comercial en "Sobre la agencia"', async () => {
      mockedDetail.mockResolvedValue({
        agency: makeProfile({
          description: 'Tours privados por la costa con guías locales.',
        }),
      });

      render(<PerfilAgenciaPage />);
      await findAgencyHeading();

      const about = screen.getByRole('heading', {
        level: 2,
        name: 'Sobre la agencia',
      });
      const text = about.closest('section')?.textContent ?? '';
      // La descripción de la agencia manda; el texto generado con datos
      // verificables se mantiene debajo como contexto.
      expect(text).toContain('Tours privados por la costa con guías locales.');
      expect(text).toContain('7 viajes publicados disponibles');
      expect(text).not.toMatch(/pago/i);
    });
  });

  describe('storefront (jerarquía de la página)', () => {
    it('presenta la estructura: banner → sobre/contacto → catálogo → calificaciones', async () => {
      mockedDetail.mockResolvedValue({ agency: makeProfile() });

      render(<PerfilAgenciaPage />);
      const tripTitle = await screen.findByText('Barquisimeto → Caracas');

      const storefront = screen.getByTestId('agency-storefront');
      const about = screen.getByRole('heading', {
        level: 2,
        name: 'Sobre la agencia',
      });
      const contact = screen.getByRole('heading', {
        level: 2,
        name: 'Contacto público',
      });
      const catalog = screen.getByRole('heading', {
        level: 2,
        name: 'Viajes de la agencia',
      });
      const ratings = screen.getByRole('heading', {
        level: 2,
        name: 'Calificaciones',
      });

      // Orden visual del storefront (mismo flujo que el mockup de
      // referencia): identidad, presentación, catálogo y cierre con
      // calificaciones.
      const order = [storefront, about, contact, catalog, ratings];
      for (let i = 1; i < order.length; i += 1) {
        expect(
          order[i - 1].compareDocumentPosition(order[i]) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      // Los resultados del catálogo viven DESPUÉS de su encabezado.
      expect(
        catalog.compareDocumentPosition(tripTitle) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('"Sobre la agencia" solo usa datos que la API publica', async () => {
      mockedDetail.mockResolvedValue({ agency: makeProfile() });

      render(<PerfilAgenciaPage />);
      await findAgencyHeading();

      const about = screen.getByRole('heading', {
        level: 2,
        name: 'Sobre la agencia',
      });
      const text = about.closest('section')?.textContent ?? '';

      // Hechos verificables del perfil: nombre + estadística real.
      expect(text).toContain('Bianchi travels');
      expect(text).toContain('7 viajes publicados disponibles');
      // Nunca copy inventado: sin horarios, direcciones ni métodos de pago.
      expect(text).not.toMatch(/horario/i);
      expect(text).not.toMatch(/dirección/i);
      expect(text).not.toMatch(/pago/i);
    });

    it('ofrece "Ver todo el catálogo" hacia el catálogo general', async () => {
      mockedDetail.mockResolvedValue({ agency: makeProfile() });

      render(<PerfilAgenciaPage />);
      await screen.findByText('Barquisimeto → Caracas');

      expect(
        screen.getByRole('link', { name: /Ver todo el catálogo/ }),
      ).toHaveAttribute('href', '/trips');
    });

    it('muestra el KPI de viajes publicados con valor real y acciones', async () => {
      mockedDetail.mockResolvedValue({ agency: makeProfile() });

      render(<PerfilAgenciaPage />);
      await findAgencyHeading();

      const kpi = screen.getByRole('heading', {
        level: 3,
        name: /Viajes publicados/,
      });
      const section = kpi.closest('section');
      // Valor real de la API (7), nunca una cifra inventada.
      expect(section?.textContent).toContain('7');
      expect(
        screen.getByRole('link', { name: /Ir a los viajes/ }),
      ).toHaveAttribute('href', '#agency-trips');
      expect(
        screen.getByRole('link', { name: /Explorar el catálogo completo/ }),
      ).toHaveAttribute('href', '/trips');
    });

    it('cierra con la tarjeta oscura de calificaciones (siempre separadas)', async () => {
      mockedDetail.mockResolvedValue({ agency: makeProfile() });

      render(<PerfilAgenciaPage />);
      await findAgencyHeading();

      const ratings = screen.getByRole('heading', {
        level: 2,
        name: 'Calificaciones',
      });
      const section = ratings.closest('section');
      // Tarjeta oscura de cierre (identidad de marca, no una pantalla blanca).
      expect(section?.className).toContain('bg-brand-dark');
      // Las DOS calificaciones siguen separadas dentro de la tarjeta.
      expect(section?.textContent).toContain('Calificación de la agencia');
      expect(section?.textContent).toContain('Calificación de sus viajes');

      // Compacta: el KPI de viajes comparte la tarjeta oscura para que la
      // fila no quede con un bloque casi vacío, y la fila no se estira
      // (`items-start`) dejando huecos.
      expect(section?.textContent).toContain('Viajes publicados');
      expect(section?.parentElement?.className).toContain('items-start');
    });
  });

  describe('catálogo reutilizado del directorio (/trips)', () => {
    it('renderiza el sidebar de facetas con las mismas secciones que /trips', async () => {
      mockedDetail.mockResolvedValue({ agency: makeProfile() });

      render(<PerfilAgenciaPage />);
      await screen.findByText('Barquisimeto → Caracas');

      expect(
        screen.getByRole('group', { name: 'Horario de salida' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Vehículo' })).toBeInTheDocument();
      expect(
        screen.getByLabelText('Precio máximo por asiento'),
      ).toBeInTheDocument();

      // La faceta de agencia NO aplica dentro del storefront de una sola
      // agencia: todas las salidas ya pertenecen a esta agencia.
      expect(screen.queryByRole('group', { name: 'Agencia' })).toBeNull();
    });

    it('oculta el sidebar cuando la agencia no tiene viajes cargados', async () => {
      mockedDetail.mockResolvedValue({
        agency: makeProfile({ trips: [], trips_total: 0, published_trips_count: 0 }),
      });

      render(<PerfilAgenciaPage />);

      expect(
        await screen.findByText('Esta agencia aún no tiene viajes publicados'),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('complementary', { name: 'Filtros de viajes' }),
      ).toBeNull();
    });

    it('el sidebar va ANTES de los resultados (mismo orden responsivo que /trips)', async () => {
      mockedDetail.mockResolvedValue({ agency: makeProfile() });

      render(<PerfilAgenciaPage />);
      const tripTitle = await screen.findByText('Barquisimeto → Caracas');

      const aside = screen.getByRole('complementary', {
        name: 'Filtros de viajes',
      });
      // En móvil el grid apila la fuente en el mismo orden: filtros y luego
      // resultados (idéntico al catálogo general).
      expect(
        aside.compareDocumentPosition(tripTitle) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('filtra la página cargada con las facetas sin volver a llamar al API', async () => {
      mockedDetail.mockResolvedValue({ agency: makeProfile() });

      render(<PerfilAgenciaPage />);
      await screen.findByText('Barquisimeto → Caracas');
      expect(mockedDetail).toHaveBeenCalledTimes(1);

      // El viaje de la agencia es `bus`: marcar "Kia" lo descarta aquí mismo.
      fireEvent.click(screen.getByLabelText('Kia'));

      expect(
        await screen.findByText('No hay viajes que coincidan con tu búsqueda'),
      ).toBeInTheDocument();
      // Las facetas son client-side sobre la página cargada: sin refetch.
      expect(mockedDetail).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole('button', { name: 'Restablecer filtros' }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Restablecer filtros' }));

      expect(await screen.findByText('Barquisimeto → Caracas')).toBeInTheDocument();
      expect(mockedDetail).toHaveBeenCalledTimes(1);
    });

    it('"Limpiar filtros" del vacío restablece facetas y filtros de la banda', async () => {
      mockedDetail.mockResolvedValue({ agency: makeProfile() });

      render(<PerfilAgenciaPage />);
      await screen.findByText('Barquisimeto → Caracas');

      // Excluye el único viaje (`bus`) de la página cargada.
      fireEvent.click(screen.getByLabelText('Kia'));
      expect(
        await screen.findByText('No hay viajes que coincidan con tu búsqueda'),
      ).toBeInTheDocument();

      // Con facetas activas hay dos "Limpiar filtros" (banda + vacío) y
      // ambos ejecutan el mismo reset completo.
      fireEvent.click(
        screen.getAllByRole('button', { name: 'Limpiar filtros' })[0],
      );

      expect(await screen.findByText('Barquisimeto → Caracas')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Restablecer filtros' })).toBeNull();
      // El reset vuelve a una carga SIN filtros server-side.
      expect(mockedDetail).toHaveBeenLastCalledWith(
        AGENCY_ID,
        expect.objectContaining({ limit: 12, offset: 0 }),
      );
    });
  });
});
