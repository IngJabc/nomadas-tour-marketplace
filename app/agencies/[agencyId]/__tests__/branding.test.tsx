import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  publicApi,
  type PublicAgencyProfile,
  type PublicTrip,
} from '@/lib/api';
import { TarjetaViaje } from '@/components/trips/TarjetaViaje';
import PerfilAgenciaPage from '../page';

// ── Branding de agencia en el storefront público ────────────────────────────
//
// Cubre el incremento de colores (primary/secondary/accent de
// `agency_settings`): aplicación sobre los elementos existentes, respaldo
// neutro ante valores ausentes/inválidos, adaptación de contraste y
// AISLAMIENTO entre agencias. El render del perfil (portada, slogan,
// descripción, contactos, calificaciones) se verifica intacto.

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

// Salida a las 11:00 UTC = 07:00 America/Caracas → siempre futuro.
function isoAt(daysOffset: number): string {
  const date = new Date(Date.now() + daysOffset * 86_400_000);
  date.setUTCHours(11, 0, 0, 0);
  return date.toISOString();
}

const trip: PublicTrip = {
  id: '441559e6-ea35-4453-aae1-5ed0844289b3',
  departure_time: isoAt(400),
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
    cover_url: null,
    slogan: null,
    description: null,
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

/** Contenedor raíz de la página: ahí viven las variables de la agencia. */
function mainElement(): HTMLElement {
  const main = document.querySelector('main');
  if (!main) throw new Error('El storefront no renderizó <main>');
  return main;
}

function agencyVar(el: HTMLElement, name: string): string {
  return el.style.getPropertyValue(name);
}

/** Luminancia WCAG local (verificación independiente del componente). */
function luminanceOf(hex: string): number {
  const body = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(body.slice(i, i + 2), 16));
  const [r, g, b] = channels.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastWithWhite(hex: string): number {
  return 1.05 / (luminanceOf(hex) + 0.05);
}

describe('Branding de agencia en el storefront (colores de agency_settings)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedDetail.mockReset();
  });

  it('aplica los tres colores validados como variables aisladas del storefront', async () => {
    mockedDetail.mockResolvedValue({
      agency: makeProfile({
        primary_color: '#0F766E',
        secondary_color: '#B84E1F',
        accent_color: '#7C3AED',
      }),
    });

    render(<PerfilAgenciaPage />);
    await screen.findByRole('heading', { level: 1, name: 'Bianchi travels' });

    // Las tres variables viajan validadas en el contenedor de la agencia.
    const main = mainElement();
    expect(agencyVar(main, '--agency-primary')).toBe('#0F766E');
    expect(agencyVar(main, '--agency-secondary')).toBe('#B84E1F');
    expect(agencyVar(main, '--agency-accent')).toBe('#7C3AED');
    // Derivados de contraste: texto legible sobre blanco (AA) y tinta sólida.
    expect(agencyVar(main, '--agency-primary-text')).toBe('#0F766E');
    expect(agencyVar(main, '--agency-primary-ink')).toBe('#FFFFFF');

    // CTA "Reservar" (tarjeta del catálogo): fondo primario, hover
    // secundario y tinta derivada — todos con fallback a la token oficial.
    const reservar = screen.getByRole('link', { name: 'Reservar' });
    expect(reservar.className).toContain(
      'bg-[var(--agency-primary,var(--color-brand-cyan))]',
    );
    expect(reservar.className).toContain(
      'hover:bg-[var(--agency-secondary,var(--color-brand-blue))]',
    );
    expect(reservar.className).toContain(
      'text-[var(--agency-primary-ink,#fff)]',
    );

    // Acción primaria del storefront: "Buscar" sigue la misma cadena.
    const buscar = screen.getByRole('button', { name: /Buscar/ });
    expect(buscar.className).toContain(
      'bg-[var(--agency-primary,var(--color-brand-cyan))]',
    );

    // Highlights: barra de las secciones + borde del banner de identidad.
    const about = screen.getByRole('heading', {
      level: 2,
      name: 'Sobre la agencia',
    });
    expect(about.className).toContain(
      'border-[var(--agency-primary,var(--color-brand-cyan))]',
    );
    expect(screen.getByTestId('agency-storefront').className).toContain(
      'border-[var(--agency-primary,var(--color-brand-cyan))]',
    );
  });

  it('sin colores válidos no emite ninguna variable y conserva las tokens neutras', async () => {
    mockedDetail.mockResolvedValue({
      agency: makeProfile({
        // Nada de esto es un hex: jamás debe pintarse.
        primary_color: 'javascript:alert(1)',
        secondary_color: 'rgb(15, 118, 110)',
        accent_color: '#12345',
      }),
    });

    render(<PerfilAgenciaPage />);
    await screen.findByRole('heading', { level: 1, name: 'Bianchi travels' });

    // Sin variables → cada consumidor resuelve su fallback neutro.
    const main = mainElement();
    expect(agencyVar(main, '--agency-primary')).toBe('');
    expect(agencyVar(main, '--agency-secondary')).toBe('');
    expect(agencyVar(main, '--agency-accent')).toBe('');
    expect(agencyVar(main, '--agency-primary-ink')).toBe('');

    // El fallback neutro está codificado en las clases de los CTAs.
    const reservar = screen.getByRole('link', { name: 'Reservar' });
    expect(reservar.className).toContain(
      'bg-[var(--agency-primary,var(--color-brand-cyan))]',
    );

    // Y el tinte/franja de marca (validados con safeHexColor) no se pintan.
    expect(screen.queryByTestId('agency-branding-tint')).toBeNull();
    expect(screen.queryByTestId('agency-branding-strip')).toBeNull();
  });

  it('adapta tinta y texto a la luminancia para no perder contraste', async () => {
    mockedDetail.mockResolvedValue({
      agency: makeProfile({
        primary_color: '#FDE68A', // claro: texto blanco sería ilegible
        secondary_color: '#1F232F', // oscuro: conserva tinta blanca
      }),
    });

    render(<PerfilAgenciaPage />);
    await screen.findByRole('heading', { level: 1, name: 'Bianchi travels' });

    const main = mainElement();
    // Fondo sólido con texto: el ink elige la tinta de mayor contraste.
    expect(agencyVar(main, '--agency-primary')).toBe('#FDE68A');
    expect(agencyVar(main, '--agency-primary-ink')).toBe('#14181F');
    // Texto sobre blanco: se oscurece hasta AA (4.5:1) sin cambiar el color
    // de fondo que ve el usuario en la franja/tinte.
    const text = agencyVar(main, '--agency-primary-text');
    expect(text).not.toBe('#FDE68A');
    expect(contrastWithWhite(text)).toBeGreaterThanOrEqual(4.5);

    // Un color oscuro ya legible pasa intacto: sin manipulación extra.
    expect(agencyVar(main, '--agency-secondary')).toBe('#1F232F');
    expect(agencyVar(main, '--agency-secondary-ink')).toBe('#FFFFFF');
  });

  it('aisla los colores entre agencias: nada de una agencia llega a otra', async () => {
    mockedDetail.mockResolvedValueOnce({
      agency: makeProfile({
        primary_color: '#0F766E',
        secondary_color: '#B84E1F',
        accent_color: '#7C3AED',
      }),
    });

    const first = render(<PerfilAgenciaPage />);
    await screen.findByRole('heading', { level: 1, name: 'Bianchi travels' });
    expect(agencyVar(mainElement(), '--agency-primary')).toBe('#0F766E');
    first.unmount();

    mockedDetail.mockResolvedValueOnce({
      agency: makeProfile({
        name: 'Zeta travels',
        primary_color: '#7C3AED',
        secondary_color: null,
        accent_color: '#F59E0B',
      }),
    });

    render(<PerfilAgenciaPage />);
    await screen.findByRole('heading', { level: 1, name: 'Zeta travels' });

    // Solo los colores de la segunda agencia están en el documento.
    const main = mainElement();
    expect(agencyVar(main, '--agency-primary')).toBe('#7C3AED');
    expect(agencyVar(main, '--agency-secondary')).toBe('');
    expect(agencyVar(main, '--agency-accent')).toBe('#F59E0B');
    expect(document.body.innerHTML).not.toContain('#0F766E');
    expect(document.body.innerHTML).not.toContain('#B84E1F');
    // La franja pintada también es la de la segunda agencia.
    expect(screen.getByTestId('agency-branding-strip')).toHaveStyle({
      backgroundColor: '#7C3AED',
    });
  });

  it('mantiene el render existente del perfil con los colores aplicados', async () => {
    mockedDetail.mockResolvedValue({
      agency: makeProfile({
        primary_color: '#0F766E',
        secondary_color: '#B84E1F',
        accent_color: '#7C3AED',
        is_featured: true,
        cover_url: 'https://cdn.example.com/cover.png',
        slogan: 'Viaja seguro, viaja con nosotros',
        description: 'Tours privados por la costa con guías locales.',
      }),
    });

    render(<PerfilAgenciaPage />);

    // Identidad, portada, slogan y descripción intactos.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bianchi travels' }),
    ).toBeInTheDocument();
    expect(screen.getByAltText('Portada de Bianchi travels')).toHaveAttribute(
      'src',
      'https://cdn.example.com/cover.png',
    );
    expect(
      screen.getByText('Viaja seguro, viaja con nosotros'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Tours privados por la costa con guías locales.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Destacada')).toBeInTheDocument();

    // Contactos públicos y las DOS calificaciones, separadas como siempre.
    expect(
      screen.getByRole('link', { name: /WhatsApp central/ }),
    ).toHaveAttribute('href', 'https://wa.me/584121234567');
    expect(screen.getByText('Calificación de la agencia')).toBeInTheDocument();
    expect(screen.getByText('Calificación de sus viajes')).toBeInTheDocument();
    expect(screen.getByText('4.5')).toBeInTheDocument();
    expect(screen.getByText('4.2')).toBeInTheDocument();

    // Los colores siguen aplicados sobre ese mismo render.
    expect(agencyVar(mainElement(), '--agency-primary')).toBe('#0F766E');
    expect(agencyVar(mainElement(), '--agency-accent')).toBe('#7C3AED');
  });

  it('la tarjeta del catálogo fuera del storefront conserva las tokens neutras', () => {
    render(<TarjetaViaje trip={trip} />);

    // Sin contenedor de agencia no existe ninguna variable en el documento:
    // la cadena `var(--agency-primary, token)` resuelve a la token oficial.
    const reservar = screen.getByRole('link', { name: 'Reservar' });
    expect(reservar.className).toContain(
      'bg-[var(--agency-primary,var(--color-brand-cyan))]',
    );
    expect(reservar.className).toContain(
      'hover:bg-[var(--agency-secondary,var(--color-brand-blue))]',
    );
    expect(document.querySelector('[style*="--agency-primary"]')).toBeNull();
    expect(document.querySelector('[style*="--agency-accent"]')).toBeNull();
  });
});
