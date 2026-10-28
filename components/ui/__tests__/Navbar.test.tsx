import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Navbar } from '@/components/ui/Navbar';

const authState = vi.hoisted(() => ({
  value: {
    user: null as { id: string; email: string; role: string } | null,
    loading: false,
    refresh: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => authState.value,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/image', () => ({
  default: (props: { alt?: string; src: string }) => (
    <img src={props.src} alt={props.alt ?? ''} />
  ),
}));

beforeEach(() => {
  authState.value.user = null;
  authState.value.loading = false;
  authState.value.signOut.mockReset();
});

describe('Navbar', () => {
  it('muestra "Iniciar sesión" cuando no hay sesión', () => {
    render(<Navbar />);
    const desktop = within(screen.getByRole('navigation', { name: 'Principal' }));

    expect(desktop.getByRole('link', { name: 'Iniciar sesión' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(
      screen.queryByRole('button', { name: 'Cerrar sesión' }),
    ).not.toBeInTheDocument();
  });

  it('muestra "Cerrar sesión" cuando hay sesión iniciada', () => {
    authState.value.user = {
      id: 'user-me',
      email: 'cliente@test.com',
      role: 'customer',
    };

    render(<Navbar />);

    expect(
      screen.getAllByRole('button', { name: 'Cerrar sesión' }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole('link', { name: 'Iniciar sesión' }),
    ).not.toBeInTheDocument();
  });

  it('al pulsar "Cerrar sesión" invoca signOut de la sesión', () => {
    authState.value.user = {
      id: 'user-me',
      email: 'cliente@test.com',
      role: 'customer',
    };

    render(<Navbar />);
    const desktop = within(screen.getByRole('navigation', { name: 'Principal' }));
    fireEvent.click(desktop.getByRole('button', { name: 'Cerrar sesión' }));

    expect(authState.value.signOut).toHaveBeenCalledTimes(1);
  });

  it('ofrece "Mis reservas" solo a clientes autenticados', () => {
    authState.value.user = {
      id: 'user-me',
      email: 'cliente@test.com',
      role: 'customer',
    };

    render(<Navbar />);
    const desktop = within(screen.getByRole('navigation', { name: 'Principal' }));

    expect(desktop.getByRole('link', { name: 'Mis reservas' })).toHaveAttribute(
      'href',
      '/account/purchases',
    );
  });

  it('no ofrece "Mis reservas" sin sesión', () => {
    render(<Navbar />);

    expect(
      screen.queryByRole('link', { name: 'Mis reservas' }),
    ).not.toBeInTheDocument();
  });

  it('no ofrece "Mis reservas" a roles que no son de cliente', () => {
    authState.value.user = {
      id: 'user-agency',
      email: 'agencia@test.com',
      role: 'agency',
    };

    render(<Navbar />);

    expect(
      screen.queryByRole('link', { name: 'Mis reservas' }),
    ).not.toBeInTheDocument();
  });

  it('ofrece "Ayuda" y "Crear cuenta" sin sesión', () => {
    render(<Navbar />);
    const desktop = within(screen.getByRole('navigation', { name: 'Principal' }));

    expect(desktop.getByRole('link', { name: 'Ayuda' })).toHaveAttribute(
      'href',
      '/help',
    );
    expect(desktop.getByRole('link', { name: 'Crear cuenta' })).toHaveAttribute(
      'href',
      '/register',
    );
    expect(desktop.getByRole('link', { name: 'Explorar' })).toHaveAttribute(
      'href',
      '/trips',
    );
  });

  it('ofrece "Explorar" y "Ayuda" también con sesión iniciada', () => {
    authState.value.user = {
      id: 'user-me',
      email: 'cliente@test.com',
      role: 'customer',
    };

    render(<Navbar />);
    const desktop = within(screen.getByRole('navigation', { name: 'Principal' }));

    expect(desktop.getByRole('link', { name: 'Explorar' })).toHaveAttribute(
      'href',
      '/trips',
    );
    expect(desktop.getByRole('link', { name: 'Ayuda' })).toHaveAttribute(
      'href',
      '/help',
    );
    expect(
      screen.queryByRole('link', { name: 'Crear cuenta' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Iniciar sesión' }),
    ).not.toBeInTheDocument();
  });

  describe('menú móvil', () => {
    it('expone el botón hamburguesa con aria-expanded y aria-controls', () => {
      render(<Navbar />);

      const toggle = screen.getByRole('button', {
        name: 'Abrir menú de navegación',
      });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveAttribute('aria-controls', 'navbar-mobile-menu');
    });

    it('al pulsar la hamburguesa abre el panel y cambia el label', () => {
      render(<Navbar />);

      const toggle = screen.getByRole('button', {
        name: 'Abrir menú de navegación',
      });
      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(
        screen.getByRole('button', { name: 'Cerrar menú de navegación' }),
      ).toBeInTheDocument();
      expect(
        document.getElementById('navbar-mobile-menu'),
      ).toHaveAttribute('aria-hidden', 'false');
    });

    it('el panel móvil incluye los mismos destinos que el escritorio', () => {
      render(<Navbar />);

      fireEvent.click(
        screen.getByRole('button', { name: 'Abrir menú de navegación' }),
      );
      const mobile = within(
        screen.getByRole('navigation', { name: 'Navegación móvil' }),
      );

      expect(mobile.getByRole('link', { name: 'Explorar' })).toHaveAttribute(
        'href',
        '/trips',
      );
      expect(mobile.getByRole('link', { name: 'Ayuda' })).toHaveAttribute(
        'href',
        '/help',
      );
      expect(mobile.getByRole('link', { name: 'Iniciar sesión' })).toHaveAttribute(
        'href',
        '/login',
      );
      expect(mobile.getByRole('link', { name: 'Crear cuenta' })).toHaveAttribute(
        'href',
        '/register',
      );
    });

    it('Escape cierra el menú abierto', () => {
      render(<Navbar />);

      const toggle = screen.getByRole('button', {
        name: 'Abrir menú de navegación',
      });
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('al pulsar la hamburguesa de nuevo cierra el menú', () => {
      render(<Navbar />);

      const toggle = screen.getByRole('button', {
        name: 'Abrir menú de navegación',
      });
      fireEvent.click(toggle);
      fireEvent.click(
        screen.getByRole('button', { name: 'Cerrar menú de navegación' }),
      );

      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(document.getElementById('navbar-mobile-menu')).toHaveAttribute(
        'aria-hidden',
        'true',
      );
    });
  });
});
