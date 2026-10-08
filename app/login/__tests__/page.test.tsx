import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import LoginPage from '../page';

const { pushMock, searchParamsState, refreshMock, establishMock } = vi.hoisted(
  () => ({
    pushMock: vi.fn(),
    refreshMock: vi.fn(),
    establishMock: vi.fn(),
    searchParamsState: { redirect: null as string | null },
  }),
);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, back: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({
    get: (key: string) =>
      key === 'redirect' ? searchParamsState.redirect : null,
  }),
}));

vi.mock('@/lib/api', () => ({
  authApi: { login: vi.fn(), register: vi.fn() },
}));

vi.mock('@/lib/auth/session', () => ({
  establishSupabaseSession: establishMock,
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => ({
    user: null,
    loading: false,
    refresh: refreshMock,
    signOut: async () => undefined,
  }),
}));

const mockedLogin = vi.mocked(authApi.login);

async function submitLogin(email = 'cliente@test.com', password = 'secreto123') {
  fireEvent.change(screen.getByLabelText('Correo electrónico'), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText('Contraseña'), {
    target: { value: password },
  });
  const form = screen
    .getByRole('button', { name: 'Iniciar sesión' })
    .closest('form') as HTMLFormElement;
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe('LoginPage — conexión con auth existente (Fase 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsState.redirect = null;
    refreshMock.mockResolvedValue(undefined);
    establishMock.mockResolvedValue(undefined);
  });

  it('loguea, establece la sesión Supabase y navega al redirect interno', async () => {
    searchParamsState.redirect = '/reservas/nueva';
    type LoginResult = Awaited<ReturnType<typeof authApi.login>>;
    let resolveLogin!: (value: LoginResult) => void;
    mockedLogin.mockReturnValue(
      new Promise<LoginResult>((resolve) => {
        resolveLogin = resolve;
      }),
    );

    render(<LoginPage />);
    const submitPromise = submitLogin();

    // Estado loading: spinner + botón deshabilitado + label de progreso.
    expect(
      await screen.findByRole('button', { name: /Iniciando sesión…/ }),
    ).toBeDisabled();

    await act(async () => {
      resolveLogin({
        token: 'access-token',
        refresh_token: 'refresh-token',
        user: { id: 'user-me', email: 'cliente@test.com', role: 'customer' },
      });
    });
    await submitPromise;

    expect(mockedLogin).toHaveBeenCalledWith('cliente@test.com', 'secreto123');
    expect(establishMock).toHaveBeenCalledWith('access-token', 'refresh-token');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith('/reservas/nueva'),
    );
  });

  it('sin redirect seguro cae a /viajes (bloquea open redirect)', async () => {
    searchParamsState.redirect = 'https://evil.com/robar';
    mockedLogin.mockResolvedValue({
      token: 'access-token',
      refresh_token: 'refresh-token',
      user: { id: 'user-me', email: 'cliente@test.com', role: 'customer' },
    });

    render(<LoginPage />);
    await submitLogin();

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/viajes'));
    expect(pushMock).not.toHaveBeenCalledWith('https://evil.com/robar');
  });

  it('conserva el redirect seguro en el link de registro', async () => {
    searchParamsState.redirect = '/reservas/nueva';

    render(<LoginPage />);

    expect(screen.getByRole('link', { name: 'Regístrate' })).toHaveAttribute(
      'href',
      '/register?redirect=%2Freservas%2Fnueva',
    );
  });

  it('muestra el error del backend sin navegar ni crear sesión', async () => {
    searchParamsState.redirect = '/reservas/nueva';
    mockedLogin.mockRejectedValue(
      new ApiError('Credenciales inválidas', 'INVALID_CREDENTIALS', 401),
    );

    render(<LoginPage />);
    await submitLogin();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Credenciales inválidas',
    );
    expect(establishMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Iniciar sesión' }),
    ).toBeEnabled();
  });
});
