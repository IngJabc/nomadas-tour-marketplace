import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PublicAgency } from '@/lib/api';
import { AgencyCard } from '../AgencyCard';

// ── Branding de agencia en el directorio (REP-001) ─────────────────────────
//
// Cada tarjeta del directorio porta SUS colores como variables aisladas:
// dos agencias vecinas jamás comparten valores, y un color ausente o
// inválido cae al respaldo neutro del Marketplace.

const ALPHA_ID = '11111111-2222-4333-8444-555555555555';
const BETA_ID = '22222222-3333-4444-8555-666666666666';

function makeAgency(overrides: Partial<PublicAgency> = {}): PublicAgency {
  return {
    id: ALPHA_ID,
    name: 'Alpha viajes',
    subdomain: 'alpha',
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
    ...overrides,
  };
}

function cardVar(card: Element, name: string): string {
  return (card as HTMLElement).style.getPropertyValue(name);
}

describe('AgencyCard — colores de agencia aislados por tarjeta', () => {
  it('cada tarjeta del directorio porta solo sus propios colores', () => {
    render(
      <>
        <AgencyCard
          agency={makeAgency({
            id: ALPHA_ID,
            name: 'Alpha viajes',
            primary_color: '#0F766E',
            secondary_color: '#B84E1F',
            accent_color: '#7C3AED',
            is_featured: true,
          })}
        />
        <AgencyCard
          agency={makeAgency({
            id: BETA_ID,
            name: 'Beta tours',
            subdomain: 'beta',
            primary_color: '#1D4ED8',
            secondary_color: null,
            accent_color: '#F59E0B',
          })}
        />
      </>,
    );

    const [alpha, beta] = screen.getAllByRole('article');

    expect(cardVar(alpha, '--agency-primary')).toBe('#0F766E');
    expect(cardVar(alpha, '--agency-secondary')).toBe('#B84E1F');
    expect(cardVar(alpha, '--agency-accent')).toBe('#7C3AED');

    expect(cardVar(beta, '--agency-primary')).toBe('#1D4ED8');
    expect(cardVar(beta, '--agency-secondary')).toBe('');
    expect(cardVar(beta, '--agency-accent')).toBe('#F59E0B');

    // Ningún valor de una agencia aparece en el contenedor de la otra.
    expect(alpha.getAttribute('style')).not.toContain('#1D4ED8');
    expect(alpha.getAttribute('style')).not.toContain('#F59E0B');
    expect(beta.getAttribute('style')).not.toContain('#0F766E');
    expect(beta.getAttribute('style')).not.toContain('#B84E1F');
    expect(beta.getAttribute('style')).not.toContain('#7C3AED');
  });

  it('CTA, píldora destacada e iconos usan las variables con fallback neutro', () => {
    render(
      <AgencyCard
        agency={makeAgency({
          primary_color: '#0F766E',
          secondary_color: '#B84E1F',
          accent_color: '#7C3AED',
          is_featured: true,
        })}
      />,
    );

    // CTA "Ver perfil": fondo primario + tinta derivada + hover secundario.
    const cta = screen.getByRole('link', { name: /Ver perfil de Alpha viajes/ });
    expect(cta.className).toContain(
      'bg-[var(--agency-primary,var(--color-brand-cyan))]',
    );
    expect(cta.className).toContain(
      'text-[var(--agency-primary-ink,#fff)]',
    );
    expect(cta.className).toContain(
      'hover:bg-[var(--agency-secondary,var(--color-brand-blue))]',
    );

    // Píldora "Destacada": acento con tinta legible y fallback al token.
    const badge = screen.getByText('Destacada');
    expect(badge.className).toContain(
      'bg-[var(--agency-accent,var(--color-cyan-bg))]',
    );
    expect(badge.className).toContain(
      'text-[var(--agency-accent-ink,var(--color-brand-cyan))]',
    );

    // Icono de viajes publicados: color primario legible sobre la tarjeta.
    expect(
      screen.getByText('7 viajes publicados disponibles').parentElement
        ?.querySelector('svg'),
    ).not.toBeNull();

    // La franja de marca sigue pintándose con el color validado.
    expect(screen.getByTestId('agency-branding-strip')).toHaveStyle({
      backgroundColor: '#0F766E',
    });
  });

  it('colores ausentes o inválidos: sin variables, sin franja, respaldo neutro', () => {
    render(
      <AgencyCard
        agency={makeAgency({
          primary_color: 'not-a-color',
          secondary_color: 'rgb(15, 118, 110)',
          accent_color: '#12345',
          is_featured: true,
        })}
      />,
    );

    const card = screen.getByRole('article');
    expect(cardVar(card, '--agency-primary')).toBe('');
    expect(cardVar(card, '--agency-secondary')).toBe('');
    expect(cardVar(card, '--agency-accent')).toBe('');
    expect(cardVar(card, '--agency-primary-ink')).toBe('');

    // Sin tinte inválido no hay franja de marca.
    expect(screen.queryByTestId('agency-branding-strip')).toBeNull();

    // Las clases conservan la cadena de fallback a las tokens oficiales.
    const cta = screen.getByRole('link', { name: /Ver perfil de Alpha viajes/ });
    expect(cta.className).toContain(
      'bg-[var(--agency-primary,var(--color-brand-cyan))]',
    );
    const badge = screen.getByText('Destacada');
    expect(badge.className).toContain(
      'bg-[var(--agency-accent,var(--color-cyan-bg))]',
    );
  });
});
