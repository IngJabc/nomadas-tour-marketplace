import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuthUser } from '@/components/auth/AuthProvider';
import { authApi } from '@/lib/api';

const supabaseState = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  listeners: [] as Array<(event: string, session: unknown) => void>,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: supabaseState.session } }),
      onAuthStateChange: (
        callback: (event: string, session: unknown) => void,
      ) => {
        supabaseState.listeners.push(callback);
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
      signOut: vi.fn(),
    },
  }),
}));

vi.mock('@/lib/api', () => ({
  authApi: { me: vi.fn() },
}));

const mockedMe = vi.mocked(authApi.me);

function Probe() {
  const auth = useAuthUser();
  return (
    <div>
      <span data-testid="loading">{String(auth.loading)}</span>
      <span data-testid="user">{auth.user?.id ?? 'none'}</span>
    </div>
  );
}

function emit(event: string, session: unknown) {
  act(() => {
    supabaseState.listeners.forEach((listener) => listener(event, session));
  });
}

beforeEach(() => {
  supabaseState.session = { user: { id: 'user-me' } };
  supabaseState.listeners.length = 0;
  mockedMe.mockReset();
  mockedMe.mockResolvedValue({
    user: { id: 'user-me', email: 'cliente@test.com', role: 'customer' },
  });
});

describe('AuthProvider (sesión)', () => {
  it('resuelve el perfil en el arranque', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('user')).toHaveTextContent('user-me'),
    );
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(mockedMe).toHaveBeenCalledTimes(1);
  });

  it('no recarga ni oscurece la UI cuando Supabase re-emite SIGNED_IN con la misma identidad', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('user')).toHaveTextContent('user-me'),
    );
    expect(screen.getByTestId('loading')).toHaveTextContent('false');

    // Es lo que dispara Supabase al volver a la pestaña (recuperación de
    // sesión): recargar aquí reiniciaba las pantallas dependientes de auth y
    // dejaba el checkout en blanco un instante.
    emit('SIGNED_IN', { user: { id: 'user-me' } });
    emit('TOKEN_REFRESHED', { user: { id: 'user-me' } });

    expect(mockedMe).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('user')).toHaveTextContent('user-me');
  });

  it('sí recarga cuando la identidad cambia (otro usuario en otra pestaña)', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('user')).toHaveTextContent('user-me'),
    );

    mockedMe.mockResolvedValue({
      user: { id: 'user-other', email: 'otro@test.com', role: 'customer' },
    });
    emit('SIGNED_IN', { user: { id: 'user-other' } });

    await waitFor(() =>
      expect(screen.getByTestId('user')).toHaveTextContent('user-other'),
    );
    expect(mockedMe).toHaveBeenCalledTimes(2);
  });

  it('SIGNED_OUT limpia el usuario', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('user')).toHaveTextContent('user-me'),
    );

    emit('SIGNED_OUT', null);

    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(mockedMe).toHaveBeenCalledTimes(1);
  });

  it('INITIAL_SESSION no duplica la carga hecha por el effect de arranque', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('user')).toHaveTextContent('user-me'),
    );

    emit('INITIAL_SESSION', { user: { id: 'user-me' } });

    expect(mockedMe).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });
});
