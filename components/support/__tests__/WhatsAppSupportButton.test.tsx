import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPORT_NUMBER_ENV } from '@/lib/support/whatsapp-support';
import { SupportMessageProvider, useSupportMessage } from '../SupportMessageProvider';
import { WhatsAppSupportButton } from '../WhatsAppSupportButton';

/**
 * SUP-002 (botón flotante global, accesible y no obstructivo) +
 * SUP-003 (mensaje contextual) + SUP-001 (ausencia de número → oculto).
 */

const pathnameState = vi.hoisted(() => ({ value: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  pathnameState.value = '/';
});

function renderButton() {
  return render(<WhatsAppSupportButton />);
}

/** Pantalla que declara su propio contexto (como payment/ticket). */
function PaymentScreen() {
  useSupportMessage({
    category: 'payment',
    identifiers: { purchaseId: 'att-1' },
  });
  return <WhatsAppSupportButton />;
}

describe('WhatsAppSupportButton (SUP-002)', () => {
  it('con número configurado renderiza el enlace global accesible', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');
    pathnameState.value = '/';

    renderButton();

    const link = screen.getByRole('link', {
      name: /contactar al soporte por whatsapp/i,
    });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link.getAttribute('href')).toMatch(
      /^https:\/\/wa\.me\/584121234567\?text=/,
    );
  });

  it('se posiciona abajo a la derecha, por debajo de navbar y modales', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');

    renderButton();

    const link = screen.getByRole('link', {
      name: /contactar al soporte por whatsapp/i,
    });
    const classes = link.className;
    expect(classes).toContain('fixed');
    // Esquina inferior derecha: el "volver arriba" se apila ARRIBA
    // (bottom-24) para no solaparse con este FAB.
    expect(classes).toContain('right-');
    expect(classes).toContain('bottom-6');
    expect(classes).not.toContain('left-');
    expect(classes).not.toContain('top-');
    // z-40 < z-50 (navbar, modales, popovers): nunca tapa la navegación.
    expect(classes).toContain('z-40');
  });

  it('muestra solo el logo de WhatsApp, sin texto visible', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');

    renderButton();

    const link = screen.getByRole('link', {
      name: /contactar al soporte por whatsapp/i,
    });
    // Sin label visible: únicamente el glifo oficial (svg con su path).
    expect(link.textContent?.trim()).toBe('');
    const path = link.querySelector('svg path');
    expect(path).not.toBeNull();
    // Glifo real de WhatsApp (burbuja + auricular), no un icono genérico.
    expect(path?.getAttribute('d') ?? '').toContain('M17.472');
  });

  it('sin número configurado no renderiza nada (nunca un enlace roto)', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '');

    const { container } = renderButton();

    expect(
      screen.queryByRole('link', { name: /whatsapp/i }),
    ).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it('con número inválido también se oculta', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, 'no-numero');

    renderButton();

    expect(
      screen.queryByRole('link', { name: /whatsapp/i }),
    ).not.toBeInTheDocument();
  });

  it('arma el mensaje general por defecto según la ruta', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');
    pathnameState.value = '/trips';

    renderButton();

    expect(screen.getByRole('link').getAttribute('href')).toContain(
      'Hola%2C%20necesito%20ayuda%20con%20el%20N%C3%B3madas%20Marketplace.',
    );
  });

  it('la ruta de una reserva cambia el mensaje a reservas', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');
    pathnameState.value = '/reservations/new';

    renderButton();

    expect(screen.getByRole('link').getAttribute('href')).toContain(
      'ayuda%20con%20una%20reserva',
    );
  });

  it('la ruta de agencias cambia el mensaje a consultas de agencia', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');
    pathnameState.value = '/agencies/central';

    renderButton();

    expect(screen.getByRole('link').getAttribute('href')).toContain(
      'consultar%20sobre%20una%20agencia',
    );
  });
});

describe('WhatsAppSupportButton + contexto de pantalla (SUP-003)', () => {
  it('usa la categoría declarada por la pantalla y su identificador', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');

    render(
      <SupportMessageProvider>
        <PaymentScreen />
      </SupportMessageProvider>,
    );

    const href = screen.getByRole('link').getAttribute('href') ?? '';
    expect(href).toContain('ayuda%20con%20un%20pago');
    expect(href).toContain('Compra%3A%20att-1');
  });

  it('el contexto prevalece sobre la ruta', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');
    // La ruta diría "reserva", pero la pantalla declara "pago".
    pathnameState.value = '/account/purchases/att-1/payment';

    render(
      <SupportMessageProvider>
        <PaymentScreen />
      </SupportMessageProvider>,
    );

    const href = screen.getByRole('link').getAttribute('href') ?? '';
    expect(href).toContain('ayuda%20con%20un%20pago');
    expect(href).not.toContain('una%20reserva');
  });

  it('funciona sin provider (pantallas montadas sueltas en tests)', () => {
    vi.stubEnv(SUPPORT_NUMBER_ENV, '04121234567');
    pathnameState.value = '/help';

    renderButton();

    expect(screen.getByRole('link').getAttribute('href')).toContain(
      'necesito%20ayuda',
    );
  });
});
