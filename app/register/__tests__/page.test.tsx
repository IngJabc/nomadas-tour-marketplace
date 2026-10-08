import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import RegisterPage from '../page';

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

const mockedRegister = vi.mocked(authApi.register);

async function submitRegister(
  email = 'nuevo@test.com',
  password = 'secreto123',
) {
  fireEvent.change(screen.getByLabelText('Correo electrónico'), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText('Contraseña'), {
    target: { value: password },
  });
  const form = screen
    .getByRole('button', { name: 'Crear cuenta' })
    .closest('form') as HTMLFormElement;
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe('RegisterPage — conexión con auth existente (Fase 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsState.redirect = null;
    refreshMock.mockResolvedValue(undefined);
    establishMock.mockResolvedValue(undefined);
  });

  it('registra, establece la sesión Supabase y navega al redirect interno', async () => {
    searchParamsState.redirect = '/reservas/nueva';
    mockedRegister.mockResolvedValue({
      token: 'access-token',
      refresh_token: 'refresh-token',
      user: { id: 'user-me', email: 'nuevo@test.com', role: 'customer' },
    });

    render(<RegisterPage />);
    await submitRegister();

    expect(mockedRegister).toHaveBeenCalledWith({
      email: 'nuevo@test.com',
      password: 'secreto123',
    });
    expect(establishMock).toHaveBeenCalledWith('access-token', 'refresh-token');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith('/reservas/nueva'),
    );
  });

  it('sin token (confirmación de correo) muestra aviso y no navega', async () => {
    searchParamsState.redirect = '/reservas/nueva';
    mockedRegister.mockResolvedValue({
      token: null,
      refresh_token: null,
      user: { id: 'user-me', email: 'nuevo@test.com', role: 'customer' },
    });

    render(<RegisterPage />);
    await submitRegister();

    expect(
      await screen.findByRole('status'),
    ).toHaveTextContent(/Revisa tu correo para confirmarla/);
    expect(establishMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Crear cuenta' }),
    ).toBeEnabled();
  });

  it('sin redirect seguro cae a /viajes (bloquea open redirect)', async () => {
    searchParamsState.redirect = '//evil.com';
    mockedRegister.mockResolvedValue({
      token: 'access-token',
      refresh_token: 'refresh-token',
      user: { id: 'user-me', email: 'nuevo@test.com', role: 'customer' },
    });

    render(<RegisterPage />);
    await submitRegister();

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/viajes'));
  });

  it('conserva el redirect seguro en el link de login', async () => {
    searchParamsState.redirect = '/reservas/nueva';

    render(<RegisterPage />);

    expect(screen.getByRole('link', { name: 'Inicia sesión' })).toHaveAttribute(
      'href',
      '/login?redirect=%2Freservas%2Fnueva',
    );
  });

  it('muestra el error del backend sin navegar ni crear sesión', async () => {
    searchParamsState.redirect = '/reservas/nueva';
    mockedRegister.mockRejectedValue(
      new ApiError('El correo ya está registrado', 'EMAIL_TAKEN', 409),
    );

    render(<RegisterPage />);
    await submitRegister();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El correo ya está registrado',
    );
    expect(establishMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Crear cuenta' }),
    ).toBeEnabled();
  });
});
