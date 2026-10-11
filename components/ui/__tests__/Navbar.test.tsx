import { fireEvent, render, screen } from '@testing-library/react';
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

    expect(
      screen.getByRole('link', { name: 'Iniciar sesión' }),
    ).toHaveAttribute('href', '/login');
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
      screen.getByRole('button', { name: 'Cerrar sesión' }),
    ).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));

    expect(authState.value.signOut).toHaveBeenCalledTimes(1);
  });
});
