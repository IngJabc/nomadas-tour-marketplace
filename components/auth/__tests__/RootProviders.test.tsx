/**
 * PAY-NOTIFICATIONS Task 8C — montaje global de proveedores.
 *
 * `RootProviders` envuelve la app con AuthProvider →
 * CustomerNotificationsProvider → PaymentNotificationToaster, de modo que
 * el estado de notificaciones siga el ciclo de vida de la sesión:
 *
 *   - los hooks de auth y de notificaciones resuelven dentro del árbol;
 *   - NO se consulta notificaciones mientras `auth.loading`;
 *   - con cliente autenticado: fetch del listado + suscripción Realtime del
 *     propio `customer_id`;
 *   - sin sesión: ni fetch ni suscripción;
 *   - logout o desmonte: volcado de estado + baja del canal.
 */
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi, reviewsApi, type CustomerNotificationDto } from '@/lib/api';
import { useAuthUser } from '@/components/auth/AuthProvider';
import { RootProviders } from '@/components/auth/RootProviders';
import { useCustomerNotifications } from '@/components/notifications/CustomerNotificationsProvider';

const { supabaseMock, realtime, sessionState } = vi.hoisted(() => {
  type InsertCb = (row: Record<string, unknown>) => void;
  type StatusCb = (status: string, error?: string | null) => void;
  let onInsert: InsertCb | null = null;
  let onStatus: StatusCb | null = null;
  const cleanup = vi.fn();

  const authListener: {
    current: ((event: string, session: unknown) => void) | null;
  } = { current: null };

  const supabaseMock = {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(
        (cb: (event: string, session: unknown) => void) => {
          authListener.current = cb;
          return {
            data: { subscription: { unsubscribe: vi.fn() } },
            error: null,
          };
        },
      ),
      signOut: vi.fn(),
    },
  };

  const realtime = {
    cleanup,
    subscribeToCustomerNotifications: vi.fn(
      (_customerId: string, insert: InsertCb, status?: StatusCb) => {
        onInsert = insert;
        onStatus = status ?? null;
        return cleanup;
      },
    ),
    emitInsert: (row: Record<string, unknown>) => onInsert?.(row),
    emitStatus: (status: string, error?: string | null) =>
      onStatus?.(status, error),
    reset: () => {
      onInsert = null;
      onStatus = null;
    },
  };

  return {
    supabaseMock,
    realtime,
    sessionState: {
      authListener,
      /** Dispara el evento que Supabase entrega al listener de auth. */
      emitAuth: (event: string, session: unknown) =>
        authListener.current?.(event, session),
    },
  };
});

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => supabaseMock,
}));

vi.mock('@/lib/api', () => ({
  authApi: { me: vi.fn() },
  reviewsApi: {
    notifications: vi.fn(),
    markNotificationRead: vi.fn(),
  },
}));

vi.mock('@/lib/realtime/subscriptions', () => realtime);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}));

const mockedList = vi.mocked(reviewsApi.notifications);
const mockedMe = vi.mocked(authApi.me);

const CUSTOMER_SESSION = { user: { id: 'session-customer-1' } };

function unreadNotification(
  overrides: Partial<CustomerNotificationDto> = {},
): CustomerNotificationDto {
  return {
    id: 'n-1',
    type: 'payment_verified',
    title: 'Pago verificado',
    body: 'Tu pago fue aprobado.',
    entity_type: 'reservation',
    entity_id: '22222222-2222-4222-8222-222222222222',
    action_url:
      '/account/purchases/33333333-3333-4333-8333-333333333333/ticket',
    read_at: null,
    created_at: '2026-11-05T10:00:00.000Z',
    ...overrides,
  };
}

/** Sonda combinada: auth + notificaciones dentro del mismo árbol. */
function Probes() {
  const auth = useAuthUser();
  const notifications = useCustomerNotifications();
  return (
    <>
      <span data-testid="auth-loading">{String(auth.loading)}</span>
      <span data-testid="auth-user">{auth.user?.id ?? 'none'}</span>
      <span data-testid="notif-loading">{String(notifications.loading)}</span>
      <span data-testid="unread">{String(notifications.unreadCount)}</span>
    </>
  );
}

function renderRoot() {
  return render(
    <RootProviders>
      <Probes />
    </RootProviders>,
  );
}

/** Suelta los microtareas del ciclo de auth (getSession → me → setState). */
async function flushAuth() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  realtime.reset();
  sessionState.authListener.current = null;
  supabaseMock.auth.getSession.mockResolvedValue({ data: { session: null } });
  mockedList.mockResolvedValue({ items: [unreadNotification()] });
  mockedMe.mockResolvedValue({
    user: { id: 'customer-1', email: 'cliente@test.com', role: 'customer' },
  });
});

describe('RootProviders (Task 8C)', () => {
  it('monta auth + notificaciones en el mismo árbol (los hooks resuelven)', async () => {
    supabaseMock.auth.getSession.mockResolvedValue({
      data: { session: CUSTOMER_SESSION },
    });

    const { getByTestId } = renderRoot();

    // AuthProvider envuelve a los hijos: useAuthUser (que lanza fuera del
    // provider) resuelve y el usuario termina cargado.
    expect(getByTestId('auth-user')).toBeInTheDocument();
    await waitFor(() => expect(getByTestId('auth-user')).toHaveTextContent('customer-1'));
    // CustomerNotificationsProvider está activo dentro del mismo árbol.
    await waitFor(() => expect(getByTestId('unread')).toHaveTextContent('1'));
    expect(getByTestId('notif-loading')).toHaveTextContent('false');
  });

  it('no consulta notificaciones mientras auth.loading; después fetch + Realtime del propio id', async () => {
    supabaseMock.auth.getSession.mockResolvedValue({
      data: { session: CUSTOMER_SESSION },
    });

    renderRoot();

    // La sesión aún no resuelve: NI fetch NI suscripción.
    expect(isAuthLoading()).toBe(true);
    expect(mockedList).not.toHaveBeenCalled();
    expect(realtime.subscribeToCustomerNotifications).not.toHaveBeenCalled();

    await flushAuth();

    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(1));
    expect(mockedMe).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(realtime.subscribeToCustomerNotifications).toHaveBeenCalledTimes(1),
    );
    expect(
      realtime.subscribeToCustomerNotifications.mock.calls[0][0],
    ).toBe('customer-1');
    // Estado consumible para badge/toasts.
    await waitFor(() => expect(unreadFromDom()).toBe('1'));
  });

  it('sin sesión: ni fetch de notificaciones ni suscripción Realtime', async () => {
    renderRoot();
    await flushAuth();

    await waitFor(() => expect(isAuthLoading()).toBe(false));
    expect(mockedMe).not.toHaveBeenCalled();
    expect(mockedList).not.toHaveBeenCalled();
    expect(realtime.subscribeToCustomerNotifications).not.toHaveBeenCalled();
    expect(unreadFromDom()).toBe('0');
  });

  it('logout (SIGNED_OUT): vuelca el estado y da de baja el canal sin re-fetch', async () => {
    supabaseMock.auth.getSession.mockResolvedValue({
      data: { session: CUSTOMER_SESSION },
    });

    const { getByTestId } = renderRoot();
    await waitFor(() => expect(unreadFromDom()).toBe('1'));
    expect(getByTestId('auth-user')).toHaveTextContent('customer-1');
    realtime.cleanup.mockClear();

    act(() => {
      sessionState.emitAuth('SIGNED_OUT', null);
    });

    // Baja del canal de la cuenta cerrada y estado volcado (badge a 0).
    await waitFor(() => expect(realtime.cleanup).toHaveBeenCalled());
    await waitFor(() => expect(unreadFromDom()).toBe('0'));
    expect(getByTestId('auth-user')).toHaveTextContent('none');
    expect(getByTestId('notif-loading')).toHaveTextContent('false');

    // Sin sesión no vuelve a consultar: solo el fetch inicial (1).
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(realtime.subscribeToCustomerNotifications).toHaveBeenCalledTimes(1);
  });

  it('al desmontar se da de baja del canal Realtime', async () => {
    supabaseMock.auth.getSession.mockResolvedValue({
      data: { session: CUSTOMER_SESSION },
    });

    const { unmount } = renderRoot();
    await waitFor(() =>
      expect(realtime.subscribeToCustomerNotifications).toHaveBeenCalledTimes(1),
    );
    realtime.cleanup.mockClear();

    unmount();

    expect(realtime.cleanup).toHaveBeenCalled();
  });
});

/** `auth-loading` de la sonda: true mientras AuthProvider resuelve sesión. */
function isAuthLoading(): boolean {
  return document.querySelector('[data-testid="auth-loading"]')?.textContent === 'true';
}

function unreadFromDom(): string | null {
  return document.querySelector('[data-testid="unread"]')?.textContent ?? null;
}
