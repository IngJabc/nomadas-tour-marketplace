/**
 * PAY-NOTIFICATIONS Task 8B — estado de notificaciones del cliente.
 *
 * Cubre: loading, unreadCount (read_at === null), refresh, dedupe por id,
 * mark-as-read (éxito y fallo), fallos de API, y cambio/cierre de sesión
 * sin filtrar estado entre usuarios.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewsApi, type CustomerNotificationDto } from '@/lib/api';
import { PUBLIC_ERROR_MESSAGES } from '@/lib/errors/api-error';
import {
  CustomerNotificationsProvider,
  PAYMENT_NOTIFICATION_TYPES,
  isPaymentNotification,
  useCustomerNotifications,
} from '@/components/notifications/CustomerNotificationsProvider';

const { authState } = vi.hoisted(() => ({
  authState: {
    user: { id: 'customer-1', role: 'customer' } as {
      id: string;
      role: string;
    } | null,
    loading: false,
  },
}));

const realtime = vi.hoisted(() => {
  type InsertCb = (row: Record<string, unknown>) => void;
  type StatusCb = (status: string, error?: string | null) => void;
  let onInsert: InsertCb | null = null;
  let onStatus: StatusCb | null = null;
  const cleanup = vi.fn();
  const subscribeToCustomerNotifications = vi.fn(
    (_customerId: string, insert: InsertCb, status?: StatusCb) => {
      onInsert = insert;
      onStatus = status ?? null;
      return cleanup;
    },
  );
  return {
    cleanup,
    subscribeToCustomerNotifications,
    /** Dispara el INSERT como lo haría Supabase (Task 8D). */
    emitInsert: (row: Record<string, unknown>) => onInsert?.(row),
    /** Dispara el estado del canal como lo haría Supabase. */
    emitStatus: (status: string, error?: string | null) =>
      onStatus?.(status, error),
    reset: () => {
      onInsert = null;
      onStatus = null;
    },
  };
});

vi.mock('@/lib/api', () => ({
  reviewsApi: {
    notifications: vi.fn(),
    markNotificationRead: vi.fn(),
  },
}));

vi.mock('@/lib/realtime/subscriptions', () => realtime);

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => ({
    user: authState.user,
    loading: authState.loading,
    refresh: vi.fn(),
    signOut: vi.fn(),
  }),
}));

const mockedList = vi.mocked(reviewsApi.notifications);
const mockedMarkRead = vi.mocked(reviewsApi.markNotificationRead);

function notificationItem(
  overrides: Partial<CustomerNotificationDto> = {},
): CustomerNotificationDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'payment_verified',
    title: 'Pago aprobado',
    body: 'Tu pago fue verificado',
    entity_type: 'reservation',
    entity_id: '22222222-2222-4222-8222-222222222222',
    action_url: '/account/purchases/33333333-3333-4333-8333-333333333333/ticket',
    read_at: null,
    created_at: '2026-11-05T10:00:00.000Z',
    ...overrides,
  };
}

function renderNotifications() {
  return renderHook(() => useCustomerNotifications(), {
    wrapper: ({ children }) => (
      <CustomerNotificationsProvider>{children}</CustomerNotificationsProvider>
    ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  realtime.reset();
  authState.user = { id: 'customer-1', role: 'customer' };
  authState.loading = false;
  mockedList.mockResolvedValue({ items: [] });
  mockedMarkRead.mockResolvedValue({ ok: true });
});

describe('CustomerNotificationsProvider — estado (Task 8B)', () => {
  it('loading arranca en true y baja cuando llega el listado', async () => {
    mockedList.mockResolvedValue({ items: [notificationItem()] });

    const { result } = renderNotifications();

    expect(result.current.loading).toBe(true);
    expect(result.current.notifications).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it('unreadCount cuenta solo read_at === null y paymentNotifications filtra tipos de pago', async () => {
    mockedList.mockResolvedValue({
      items: [
        notificationItem({ id: 'a', type: 'payment_verified', read_at: null }),
        notificationItem({ id: 'b', type: 'payment_rejected', read_at: null }),
        notificationItem({
          id: 'c',
          type: 'payment_verified',
          read_at: '2026-11-05T11:00:00.000Z',
        }),
        notificationItem({ id: 'd', type: 'review_pending', read_at: null }),
      ],
    });

    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 2 pagos no leídos + 1 reseña no leída = 3 no leídos en total.
    expect(result.current.unreadCount).toBe(3);
    expect(result.current.paymentNotifications.map((n) => n.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(result.current.notifications).toHaveLength(4);
  });

  it('isPaymentNotification reconoce payment_verified y payment_rejected', () => {
    expect(
      isPaymentNotification(notificationItem({ type: 'payment_verified' })),
    ).toBe(true);
    expect(
      isPaymentNotification(notificationItem({ type: 'payment_rejected' })),
    ).toBe(true);
    expect(
      isPaymentNotification(notificationItem({ type: 'review_pending' })),
    ).toBe(false);
    expect(PAYMENT_NOTIFICATION_TYPES).toEqual([
      'payment_verified',
      'payment_rejected',
    ]);
  });

  it('deduplica el listado por id', async () => {
    mockedList.mockResolvedValue({
      items: [
        notificationItem({ id: 'dup' }),
        notificationItem({ id: 'dup', title: 'duplicada' }),
        notificationItem({ id: 'other' }),
      ],
    });

    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.notifications).toHaveLength(2);
    expect(result.current.notifications[0].title).toBe('Pago aprobado');
  });

  it('refresh reconsulta, actualiza el listado y limpia el error', async () => {
    mockedList.mockRejectedValueOnce(new Error('boom'));
    mockedList.mockResolvedValueOnce({
      items: [notificationItem({ id: 'fresh' })],
    });

    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeTruthy();

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockedList).toHaveBeenCalledTimes(2);
    expect(result.current.notifications.map((n) => n.id)).toEqual(['fresh']);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('markAsRead marca en el servidor y actualiza read_at + unreadCount', async () => {
    mockedList.mockResolvedValue({
      items: [
        notificationItem({ id: 'n1', read_at: null }),
        notificationItem({ id: 'n2', read_at: null }),
      ],
    });

    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unreadCount).toBe(2);

    let ok = false;
    await act(async () => {
      ok = await result.current.markAsRead('n1');
    });

    expect(ok).toBe(true);
    expect(mockedMarkRead).toHaveBeenCalledWith('n1');
    expect(result.current.unreadCount).toBe(1);
    expect(
      result.current.notifications.find((n) => n.id === 'n1')?.read_at,
    ).not.toBeNull();
    // La otra notificación no cambia.
    expect(
      result.current.notifications.find((n) => n.id === 'n2')?.read_at,
    ).toBeNull();
  });

  it('markAsRead sin sesión de cliente no llama a la API y devuelve false', async () => {
    authState.user = null;
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.markAsRead('n1');
    });

    expect(ok).toBe(false);
    expect(mockedMarkRead).not.toHaveBeenCalled();
  });

  it('fallo de markAsRead: devuelve false y el estado local NO cambia', async () => {
    mockedList.mockResolvedValue({
      items: [notificationItem({ id: 'n1', read_at: null })],
    });
    mockedMarkRead.mockRejectedValue(new Error('offline'));

    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unreadCount).toBe(1);

    let ok = true;
    await act(async () => {
      ok = await result.current.markAsRead('n1');
    });

    expect(ok).toBe(false);
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.notifications[0].read_at).toBeNull();
    expect(result.current.error).toBeTruthy();
  });

  it('fallo del listado: loading false, error público y lista vacía', async () => {
    mockedList.mockRejectedValue(new Error('red caída'));

    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.notifications).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
    // Mensaje público controlado, nunca el error crudo.
    expect(result.current.error).toBe(PUBLIC_ERROR_MESSAGES.UNEXPECTED);
    expect(result.current.error).not.toContain('red caída');
  });

  it('refresh sin sesión de cliente es no-op (sin llamada)', async () => {
    authState.user = null;
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const calls = mockedList.mock.calls.length;

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockedList.mock.calls.length).toBe(calls);
  });

  it('cambio de usuario: vuelca el listado anterior antes de cargar el nuevo', async () => {
    mockedList.mockResolvedValueOnce({
      items: [notificationItem({ id: 'of-customer-1' })],
    });

    const { result, rerender } = renderNotifications();
    await waitFor(() =>
      expect(result.current.notifications.map((n) => n.id)).toEqual([
        'of-customer-1',
      ]),
    );

    // El usuario 2 responde con SU listado (el fetch queda pendiente).
    let resolveSecond: (value: { items: CustomerNotificationDto[] }) => void =
      () => undefined;
    mockedList.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );

    act(() => {
      authState.user = { id: 'customer-2', role: 'customer' };
    });
    rerender();

    // Mientras carga el usuario 2, NADA del usuario 1 es visible.
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    expect(result.current.notifications).toEqual([]);
    expect(result.current.unreadCount).toBe(0);

    await act(async () => {
      resolveSecond({ items: [notificationItem({ id: 'of-customer-2' })] });
    });

    await waitFor(() =>
      expect(result.current.notifications.map((n) => n.id)).toEqual([
        'of-customer-2',
      ]),
    );
  });

  it('cierre de sesión: limpia listado, contador y error sin fetch posterior', async () => {
    mockedList.mockResolvedValueOnce({
      items: [notificationItem({ id: 'n1', read_at: null })],
    });

    const { result, rerender } = renderNotifications();
    await waitFor(() => expect(result.current.unreadCount).toBe(1));

    const callsBefore = mockedList.mock.calls.length;
    act(() => {
      authState.user = null;
    });
    rerender();

    await waitFor(() => expect(result.current.unreadCount).toBe(0));
    expect(result.current.notifications).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockedList.mock.calls.length).toBe(callsBefore);
  });

  it('una respuesta tardía de la sesión anterior no pisa la del usuario actual', async () => {
    // Primer fetch (usuario 1) queda pendiente.
    let resolveFirst: (value: { items: CustomerNotificationDto[] }) => void =
      () => undefined;
    mockedList.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const { result, rerender } = renderNotifications();
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(1));

    // Cambio de usuario → segundo fetch (usuario 2) responde ya.
    mockedList.mockResolvedValueOnce({
      items: [notificationItem({ id: 'of-customer-2' })],
    });
    act(() => {
      authState.user = { id: 'customer-2', role: 'customer' };
    });
    rerender();

    await waitFor(() =>
      expect(result.current.notifications.map((n) => n.id)).toEqual([
        'of-customer-2',
      ]),
    );

    // La respuesta VIEJA del usuario 1 llega tarde: debe descartarse.
    await act(async () => {
      resolveFirst({ items: [notificationItem({ id: 'of-customer-1' })] });
    });

    expect(result.current.notifications.map((n) => n.id)).toEqual([
      'of-customer-2',
    ]);
    expect(result.current.loading).toBe(false);
  });

  it('auth aún cargando: no consulta hasta que la sesión resuelve', async () => {
    authState.loading = true;
    authState.user = null;

    const { result, rerender } = renderNotifications();

    expect(mockedList).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);

    act(() => {
      authState.loading = false;
      authState.user = { id: 'customer-1', role: 'customer' };
    });
    rerender();

    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

describe('CustomerNotificationsProvider — Realtime (Task 8D)', () => {
  it('suscribe customer_notifications del cliente y da de baja el canal al desmontar', async () => {
    const { result, unmount } = renderNotifications();
    await waitFor(() => expect(mockedList).toHaveBeenCalled());

    expect(realtime.subscribeToCustomerNotifications).toHaveBeenCalledTimes(1);
    expect(
      realtime.subscribeToCustomerNotifications.mock.calls[0][0],
    ).toBe('customer-1');
    expect(result.current.realtimeStatus).toBe('idle');

    unmount();
    expect(realtime.cleanup).toHaveBeenCalled();
  });

  it('INSERT nuevo: refresca el listado y emite el evento a los listeners', async () => {
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));

    const listener = vi.fn();
    result.current.subscribeToIncoming(listener);

    mockedList.mockResolvedValue({
      items: [
        notificationItem({ id: 'n-new', read_at: null }),
      ],
    });

    act(() => {
      realtime.emitInsert({
        id: 'n-new',
        customer_id: 'customer-1',
        type: 'payment_verified',
        title: 'Pago verificado',
        body: 'Tu pago fue aprobado.',
        entity_type: 'reservation',
        entity_id: 'res-1',
        action_url:
          '/account/purchases/33333333-3333-4333-8333-333333333333/ticket',
        read_at: null,
        created_at: '2026-11-05T12:00:00.000Z',
      });
    });

    // Emite el evento entrante (para el toast) y refresca estado+contador.
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0][0]).toMatchObject({
      id: 'n-new',
      type: 'payment_verified',
      title: 'Pago verificado',
      action_url:
        '/account/purchases/33333333-3333-4333-8333-333333333333/ticket',
    });
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.notifications.map((n) => n.id)).toEqual(['n-new']),
    );
    expect(result.current.unreadCount).toBe(1);
  });

  it('un evento reentregado (misma id) no re-emite ni re-refresca', async () => {
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));

    const listener = vi.fn();
    result.current.subscribeToIncoming(listener);

    const row = {
      id: 'n-dup',
      customer_id: 'customer-1',
      type: 'payment_rejected',
      title: 'Pago rechazado',
      body: 'Revisa tu compra.',
      action_url:
        '/account/purchases/33333333-3333-4333-8333-333333333333/payment',
      read_at: null,
      created_at: '2026-11-05T12:00:00.000Z',
    };
    act(() => {
      realtime.emitInsert(row);
      realtime.emitInsert(row);
    });

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    // Solo el refresh del primer evento: inicial (1) + INSERT (1).
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('filas ajenas o malformadas no se emiten', async () => {
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));

    const listener = vi.fn();
    result.current.subscribeToIncoming(listener);

    act(() => {
      realtime.emitInsert({
        id: 'n-ajena',
        customer_id: 'otro-cliente',
        type: 'payment_verified',
      });
      realtime.emitInsert({ customer_id: 'customer-1', type: 'payment_verified' });
      realtime.emitInsert({ id: 'sin-tipo', customer_id: 'customer-1' });
    });

    expect(listener).not.toHaveBeenCalled();
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it('expone realtimeStatus y registra los estados de canal (fallo observable)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const { result } = renderNotifications();
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.realtimeStatus).toBe('idle');

      act(() => {
        realtime.emitStatus('CHANNEL_ERROR', 'publication missing');
      });
      expect(result.current.realtimeStatus).toBe('CHANNEL_ERROR');
      expect(warn).toHaveBeenCalled();

      act(() => {
        realtime.emitStatus('SUBSCRIBED');
      });
      expect(result.current.realtimeStatus).toBe('SUBSCRIBED');
    } finally {
      warn.mockRestore();
    }
  });

  it('al cerrar sesión se da de baja del canal y resetea el estado Realtime', async () => {
    const { result, rerender } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      realtime.emitStatus('SUBSCRIBED');
    });
    expect(result.current.realtimeStatus).toBe('SUBSCRIBED');
    realtime.cleanup.mockClear();

    act(() => {
      authState.user = null;
    });
    rerender();

    await waitFor(() => expect(realtime.cleanup).toHaveBeenCalled());
    expect(result.current.realtimeStatus).toBe('idle');
    expect(result.current.notifications).toEqual([]);
  });

  it('sin cliente autenticado no suscribe el canal', async () => {
    authState.user = null;

    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(realtime.subscribeToCustomerNotifications).not.toHaveBeenCalled();
  });
});
