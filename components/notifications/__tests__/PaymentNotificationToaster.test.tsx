/**
 * PAY-NOTIFICATIONS Task 8E/8D — toasts de notificación de pago.
 *
 * Integra `CustomerNotificationsProvider` (Realtime + estado) con
 * `PaymentNotificationToaster` y `ToastProvider` (render real de BaseToast
 * sobre un store de react-hot-toast funcional):
 *
 *   - el listado inicial NUNCA genera toasts (solo eventos en vivo);
 *   - duración exacta de 12 s, dedupe por id y tope de 3 simultáneos con
 *     cola FIFO (cierre manual promueve el siguiente);
 *   - click → mark-as-read sin bloquear la navegación (éxito y fallo);
 *   - navegación SOLO a action_url internas validadas (externas o
 *     inválidas jamás navegan);
 *   - lenguaje visual del marketplace: superficie de card con borde
 *     hairline e icono semántico trust/danger por tipo;
 *   - los cambios de sesión vacían la cola de la cuenta anterior.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'react-hot-toast';
import { reviewsApi, type CustomerNotificationDto } from '@/lib/api';
import { CustomerNotificationsProvider } from '@/components/notifications/CustomerNotificationsProvider';
import { PaymentNotificationToaster } from '@/components/notifications/PaymentNotificationToaster';
import { useCustomerNotifications } from '@/components/notifications/CustomerNotificationsProvider';
import { ToastProvider } from '@/components/ui/ToastProvider';

// ── Store funcional de react-hot-toast (mock con la misma semántica) ────────

const hot = vi.hoisted(() => {
  interface MockToast {
    id: string;
    type: string;
    message: unknown;
    duration?: number;
    visible: boolean;
    dismissed: boolean;
  }

  const toasts: MockToast[] = [];
  const listeners = new Set<() => void>();
  let counter = 0;

  const emit = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  const toastFn = vi.fn(
    (message: unknown, options: Record<string, unknown> = {}) => {
      const id =
        typeof options.id === 'string' ? options.id : `t-${++counter}`;
      const existing = toasts.find((t) => t.id === id);
      if (existing) {
        existing.message = message;
        existing.visible = true;
        existing.dismissed = false;
        emit();
        return id;
      }
      toasts.push({
        id,
        type: typeof options.type === 'string' ? options.type : 'blank',
        message,
        duration:
          typeof options.duration === 'number' ? options.duration : undefined,
        visible: true,
        dismissed: false,
      });
      emit();
      return id;
    },
  );

  const toast = Object.assign(toastFn, {
    dismiss: vi.fn((id?: string) => {
      for (const t of toasts) {
        if (id === undefined || t.id === id) {
          t.dismissed = true;
          t.visible = false;
        }
      }
      emit();
    }),
    remove: vi.fn((id?: string) => {
      for (let i = toasts.length - 1; i >= 0; i--) {
        if (id === undefined || toasts[i].id === id) toasts.splice(i, 1);
      }
      emit();
    }),
    dismissAll: vi.fn(),
    removeAll: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    custom: vi.fn(),
  });

  return {
    toast,
    toasts,
    listeners,
    emit,
    reset: () => {
      toasts.length = 0;
      counter = 0;
    },
  };
});

vi.mock('react-hot-toast', async () => {
  const React = await import('react');

  function useStoreSubscription() {
    const [, force] = React.useState(0);
    React.useEffect(() => {
      const listener = () => force((tick) => tick + 1);
      hot.listeners.add(listener);
      return () => {
        hot.listeners.delete(listener);
      };
    }, []);
  }

  const useToasterStore = () => {
    useStoreSubscription();
    return { toasts: [...hot.toasts], pausedAt: undefined };
  };

  const Toaster = ({ children }: { children?: (t: unknown) => ReactNode }) => {
    useStoreSubscription();
    return React.createElement(
      'div',
      { 'data-rht-toaster': 'mock' },
      hot.toasts
        .filter((t) => !t.dismissed)
        .map((t) =>
          React.createElement('div', { key: t.id }, children ? children(t) : null),
        ),
    );
  };

  return {
    default: hot.toast,
    toast: hot.toast,
    Toaster,
    useToasterStore,
    resolveValue: (value: unknown, arg: unknown) =>
      typeof value === 'function'
        ? (value as (a: unknown) => unknown)(arg)
        : value,
    CheckmarkIcon: () => null,
    ErrorIcon: () => null,
    LoaderIcon: () => null,
    ToastBar: () => null,
    ToastIcon: () => null,
  };
});

// ── Otros mocks (convenciones del repo) ─────────────────────────────────────

const { authState, routerMock, realtime } = vi.hoisted(() => ({
  authState: {
    user: { id: 'customer-1', role: 'customer' } as {
      id: string;
      role: string;
    } | null,
    loading: false,
  },
  routerMock: { push: vi.fn() },
  realtime: (() => {
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
      emitInsert: (row: Record<string, unknown>) => onInsert?.(row),
      emitStatus: (status: string, error?: string | null) =>
        onStatus?.(status, error),
      reset: () => {
        onInsert = null;
        onStatus = null;
      },
    };
  })(),
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useOptionalAuthUser: () => authState,
}));

vi.mock('@/lib/api', () => ({
  reviewsApi: {
    notifications: vi.fn(),
    markNotificationRead: vi.fn(),
  },
}));

vi.mock('@/lib/realtime/subscriptions', () => realtime);

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/',
}));

const mockedList = vi.mocked(reviewsApi.notifications);
const mockedMarkRead = vi.mocked(reviewsApi.markNotificationRead);

const ATTEMPT = '33333333-3333-4333-8333-333333333333';

/** Probe: el contador del provider (badge) reacciona al mark-as-read. */
function UnreadProbe() {
  const { unreadCount } = useCustomerNotifications();
  return <span data-testid="unread-count">{unreadCount}</span>;
}

function notificationItem(
  overrides: Partial<CustomerNotificationDto> = {},
): CustomerNotificationDto {
  return {
    id: 'hist-1',
    type: 'payment_verified',
    title: 'Pago verificado',
    body: 'Tu pago fue aprobado.',
    entity_type: 'reservation',
    entity_id: '22222222-2222-4222-8222-222222222222',
    action_url: `/account/purchases/${ATTEMPT}/ticket`,
    read_at: null,
    created_at: '2026-11-05T10:00:00.000Z',
    ...overrides,
  };
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    customer_id: 'customer-1',
    type: 'payment_verified',
    title: 'Pago verificado',
    body: 'Tu pago fue aprobado. Ya puedes ver el boleto.',
    entity_type: 'reservation',
    entity_id: '22222222-2222-4222-8222-222222222222',
    action_url: `/account/purchases/${ATTEMPT}/ticket`,
    read_at: null,
    created_at: '2026-11-05T12:00:00.000Z',
    ...overrides,
  };
}

function ui() {
  return (
    <CustomerNotificationsProvider>
      <PaymentNotificationToaster />
      <UnreadProbe />
      <ToastProvider />
    </CustomerNotificationsProvider>
  );
}

function renderToaster() {
  const utils = render(ui());
  // Elemento NUEVO en cada rerender: reutilizar la misma referencia hace
  // bailout de React y la sesión (auth) cambiaría sin re-renderizar.
  return { ...utils, rerender: () => utils.rerender(ui()) };
}

/** INSERT de Realtime vía el provider (camino completo). */
function emitInsert(row: Record<string, unknown>) {
  act(() => {
    realtime.emitInsert(row);
  });
}

async function waitForInitialLoad() {
  await waitFor(() => expect(mockedList).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hot.reset();
  realtime.reset();
  authState.user = { id: 'customer-1', role: 'customer' };
  authState.loading = false;
  mockedList.mockResolvedValue({ items: [] });
  mockedMarkRead.mockResolvedValue({ ok: true });
});

describe('PaymentNotificationToaster (Task 8E)', () => {
  it('no muestra toasts por las notificaciones del listado inicial', async () => {
    mockedList.mockResolvedValue({
      items: [notificationItem({ id: 'hist-1', read_at: null })],
    });

    renderToaster();
    await waitForInitialLoad();

    // El histórico (incluso no leído) jamás genera toast: solo eventos vivo.
    expect(hot.toast).not.toHaveBeenCalled();
    // ...pero sí alimenta el contador del badge.
    expect(screen.getByTestId('unread-count')).toHaveTextContent('1');
  });

  it('INSERT payment_verified: toast de 12 s con título/cuerpo; click navega al boleto y marca leída', async () => {
    mockedList.mockResolvedValue({
      items: [notificationItem({ id: 'n-1', read_at: null })],
    });
    renderToaster();
    await waitForInitialLoad();

    emitInsert(paymentRow());
    await waitFor(() => expect(hot.toast).toHaveBeenCalledTimes(1));

    // Opciones exactas: 12 s, variante notification e id de la notificación.
    const [, options] = hot.toast.mock.calls[0];
    expect(options).toMatchObject({
      id: 'n-1',
      duration: 12_000,
      type: 'notification',
    });

    // Título y cuerpo visibles en la variante notification.
    expect(
      await screen.findByText('Pago verificado'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Tu pago fue aprobado. Ya puedes ver el boleto.'),
    ).toBeInTheDocument();

    // Lenguaje visual del marketplace: superficie de card con borde
    // hairline (nunca blanco hardcodeado) e icono semántico por tipo
    // (aprobado → check sobre fondo trust).
    const container = screen
      .getByText('Pago verificado')
      .closest('button')?.parentElement;
    expect(container).not.toBeNull();
    expect(container!.className).toContain('bg-[var(--color-brand-surface)]');
    expect(container!.className).toContain('border-black/[0.06]');
    expect(screen.getByTestId('payment-toast-icon')).toHaveAttribute(
      'data-tone',
      'trust',
    );

    fireEvent.click(screen.getByText('Pago verificado'));

    expect(mockedMarkRead).toHaveBeenCalledWith('n-1');
    expect(routerMock.push).toHaveBeenCalledWith(
      `/account/purchases/${ATTEMPT}/ticket`,
    );
    // El contador del badge baja apenas el provider confirma.
    await waitFor(() =>
      expect(screen.getByTestId('unread-count')).toHaveTextContent('0'),
    );
  });

  it('INSERT payment_rejected: click navega a la corrección de pago', async () => {
    renderToaster();
    await waitForInitialLoad();

    emitInsert(
      paymentRow({
        id: 'n-rej',
        type: 'payment_rejected',
        title: 'Pago rechazado',
        body: 'Tu pago no fue aprobado.',
        action_url: `/account/purchases/${ATTEMPT}/payment`,
      }),
    );
    await waitFor(() => expect(hot.toast).toHaveBeenCalledTimes(1));

    // Icono semántico del rechazo: X sobre fondo danger.
    expect(screen.getByTestId('payment-toast-icon')).toHaveAttribute(
      'data-tone',
      'danger',
    );

    fireEvent.click(screen.getByText('Pago rechazado'));

    expect(mockedMarkRead).toHaveBeenCalledWith('n-rej');
    expect(routerMock.push).toHaveBeenCalledWith(
      `/account/purchases/${ATTEMPT}/payment`,
    );
  });

  it('si mark-as-read falla, la navegación NO se bloquea y el fallo queda observable', async () => {
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockedMarkRead.mockRejectedValue(new Error('offline'));
    // La compra sigue con su notificación SIN LEER en el servidor: el badge
    // debe permanecer en 1 tras el fallo del mark-as-read.
    mockedList.mockResolvedValue({
      items: [notificationItem({ id: 'n-rej-2', read_at: null })],
    });

    try {
      renderToaster();
      await waitForInitialLoad();

      emitInsert(
        paymentRow({
          id: 'n-rej-2',
          type: 'payment_rejected',
          title: 'Pago rechazado',
          action_url: `/account/purchases/${ATTEMPT}/payment`,
        }),
      );
      await waitFor(() => expect(hot.toast).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByText('Pago rechazado'));

      expect(routerMock.push).toHaveBeenCalledWith(
        `/account/purchases/${ATTEMPT}/payment`,
      );
      await waitFor(() => expect(errorSpy).toHaveBeenCalled());
      // El estado local no cambió: sigue no leída (badge intacto).
      expect(screen.getByTestId('unread-count')).toHaveTextContent('1');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rechaza action_url externas e inválidas: jamás navega y el fallo es observable', async () => {
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      renderToaster();
      await waitForInitialLoad();

      emitInsert(
        paymentRow({
          id: 'n-ext',
          title: 'Pago verificado',
          action_url: 'https://evil.test/account/purchases/x/ticket',
        }),
      );
      emitInsert(
        paymentRow({
          id: 'n-inv',
          title: 'Pago verificado',
          action_url: '/account/purchases/att-1/ticket',
        }),
      );
      await waitFor(() => expect(hot.toast).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getAllByText('Pago verificado')[0]);
      fireEvent.click(screen.getAllByText('Pago verificado')[1]);

      expect(routerMock.push).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('máximo 3 simultáneos con cola FIFO: cerrar uno promueve el siguiente sin perder eventos', async () => {
    renderToaster();
    await waitForInitialLoad();

    for (let i = 1; i <= 5; i++) {
      emitInsert(
        paymentRow({
          id: `n-${i}`,
          title: `Aviso ${i}`,
          body: `Cuerpo ${i}`,
        }),
      );
    }

    await waitFor(() => expect(hot.toast).toHaveBeenCalledTimes(3));
    expect(hot.toast.mock.calls.map((call) => (call[1] as { id: string }).id)).toEqual([
      'n-1',
      'n-2',
      'n-3',
    ]);
    expect(screen.getAllByText(/^Aviso \d$/)).toHaveLength(3);

    // Cierre manual con el X existente: libera un espacio.
    const closeButtons = screen.getAllByRole('button', {
      name: 'Cerrar notificación',
    });
    expect(closeButtons).toHaveLength(3);
    fireEvent.click(closeButtons[0]);

    await waitFor(() => expect(hot.toast).toHaveBeenCalledTimes(4));
    expect(
      (hot.toast.mock.calls[3][1] as { id: string }).id,
    ).toBe('n-4');
    expect(hot.toast.dismiss).toHaveBeenCalledWith('n-1');

    // El quinto sigue en cola hasta liberar otro espacio.
    const remaining = screen.getAllByRole('button', {
      name: 'Cerrar notificación',
    });
    fireEvent.click(remaining[0]);
    await waitFor(() => expect(hot.toast).toHaveBeenCalledTimes(5));
    expect(
      (hot.toast.mock.calls[4][1] as { id: string }).id,
    ).toBe('n-5');
    // Orden FIFO respetado de principio a fin.
    expect(hot.toast.mock.calls.map((call) => (call[1] as { id: string }).id)).toEqual([
      'n-1',
      'n-2',
      'n-3',
      'n-4',
      'n-5',
    ]);
  });

  it('un evento reentregado no duplica el toast ni el refresh', async () => {
    renderToaster();
    await waitForInitialLoad();

    const row = paymentRow({ id: 'n-dup' });
    emitInsert(row);
    emitInsert(row);

    await waitFor(() => expect(hot.toast).toHaveBeenCalledTimes(1));
    expect(hot.toast).toHaveBeenCalledTimes(1);
    // inicial (1) + un solo refresh del primer evento (1).
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('solo los tipos de pago generan toast (review_pending no)', async () => {
    renderToaster();
    await waitForInitialLoad();

    emitInsert(
      paymentRow({
        id: 'n-review',
        type: 'review_pending',
        title: 'Reseña pendiente',
        action_url: '/account/reviews/22222222-2222-4222-8222-222222222222',
      }),
    );

    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    expect(hot.toast).not.toHaveBeenCalled();
  });
});

describe('PaymentNotificationToaster — sesiones (Task 8E/8G)', () => {
  it('al cambiar de cuenta, la cola de la cuenta anterior nunca se muestra', async () => {
    const { rerender } = renderToaster();
    await waitForInitialLoad();

    // 5 eventos de la cuenta 1: 3 visibles, 2 en cola.
    for (let i = 1; i <= 5; i++) {
      emitInsert(paymentRow({ id: `n-a-${i}`, title: `Aviso A${i}` }));
    }
    await waitFor(() => expect(hot.toast).toHaveBeenCalledTimes(3));

    // Cambio de cuenta: la cola pendiente (n-a-4, n-a-5) se vacía.
    act(() => {
      authState.user = { id: 'customer-2', role: 'customer' };
    });
    rerender();

    // Evento de la cuenta 2: entra a la cola (los 3 slots siguen ocupados
    // por toasts de la cuenta anterior que aún no expiran).
    emitInsert(
      paymentRow({ id: 'n-b-1', customer_id: 'customer-2', title: 'Aviso B1' }),
    );
    expect(hot.toast).toHaveBeenCalledTimes(3);

    // Al liberarse los espaces, se promueve SOLO el de la cuenta 2:
    // n-a-4 y n-a-5 (cola vieja) jamás aparecen.
    await act(async () => {
      hot.toasts
        .filter((t) => !t.dismissed)
        .forEach((t) => hot.toast.dismiss(t.id));
    });

    await waitFor(() => expect(hot.toast).toHaveBeenCalledTimes(4));
    expect(
      (hot.toast.mock.calls[3][1] as { id: string }).id,
    ).toBe('n-b-1');
    const ids = hot.toast.mock.calls.map(
      (call) => (call[1] as { id: string }).id,
    );
    expect(ids).not.toContain('n-a-4');
    expect(ids).not.toContain('n-a-5');
  });

  it('al cerrar sesión, un evento Realtime tardío jamás genera toast', async () => {
    const { rerender } = renderToaster();
    await waitForInitialLoad();

    act(() => {
      authState.user = null;
    });
    rerender();

    await waitFor(() => expect(realtime.cleanup).toHaveBeenCalled());

    // Reentrega tardía del canal de la cuenta cerrada: se descarta.
    act(() => {
      realtime.emitInsert(paymentRow({ id: 'n-late' }));
    });

    expect(hot.toast).not.toHaveBeenCalled();
    expect(screen.getByTestId('unread-count')).toHaveTextContent('0');
  });
});
