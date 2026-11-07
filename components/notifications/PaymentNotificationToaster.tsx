'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast, useToasterStore } from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import type { CustomerNotificationDto } from '@/lib/api';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';
import { BaseToast, ToastStatusIcon } from '@/components/ui/BaseToast';
import { parsePaymentActionUrl } from '@/lib/notifications/payment-action-url';
import {
  isPaymentNotification,
  useOptionalCustomerNotifications,
} from '@/components/notifications/CustomerNotificationsProvider';

/**
 * PAY-NOTIFICATIONS Task 8E — toasts de notificación de pago.
 *
 * Sobre la infraestructura existente (`ToastProvider` → `Toaster` de
 * react-hot-toast en `bottom-right` + `BaseToast`):
 *
 *   - Duración EXACTA de 12 s por toast (`PAYMENT_TOAST_DURATION_MS`); el
 *     default global de 2500 ms de los toasts comunes no cambia.
 *   - Máximo 3 notificaciones simultáneas (`MAX_SIMULTANEOUS_PAYMENT_TOASTS`);
 *     el resto espera en cola FIFO — ningún evento se pierde en silencio y
 *     se conserva el orden de llegada.
 *   - Variante `notification` de `BaseToast` con superficie/borde de card
 *     del marketplace, icono semántico por tipo (trust/danger), título +
 *     cuerpo, todo el cuerpo clickeable y cierre manual con el X.
 *   - Dedupe por `id` de la notificación (un evento reentregado jamás
 *     muestra dos toasts).
 *   - Solo `payment_verified` / `payment_rejected`.
 *   - Click → mark-as-read (fire-and-forget: un fallo NO bloquea la
 *     navegación y queda observable) + `router.push` SOLO a la ruta interna
 *     validada de `action_url`; URLs externas o inválidas jamás navegan.
 *
 * El listado inicial del provider NUNCA genera toasts: solo los eventos
 * Realtime entregados vía `subscribeToIncoming` entran a la cola.
 */

/** Duración exacta del toast de notificación de pago (12 segundos). */
export const PAYMENT_TOAST_DURATION_MS = 12_000;

/** Tope de toasts de notificación visibles al mismo tiempo. */
export const MAX_SIMULTANEOUS_PAYMENT_TOASTS = 3;

/**
 * Icono semántico por tipo de notificación de pago — lenguaje visual del
 * marketplace. Delega en `ToastStatusIcon` (el mismo que usan los toasts
 * comunes) para que aprobado y rechazo se vean idénticos en ambos flujos:
 *
 *   - aprobado (`payment_verified`)  → check verde sobre `--color-trust-bg`;
 *   - rechazo  (`payment_rejected`)  → X rojo sobre `--color-danger-bg`.
 *
 * Los atributos `data-testid`/`data-tone` se conservan en el envoltorio:
 * son la interfaz de los tests de este componente.
 */
function PaymentStatusIcon({ type }: { type: string }) {
  const rejected = type === 'payment_rejected';
  return (
    <span
      data-testid="payment-toast-icon"
      data-tone={rejected ? 'danger' : 'trust'}
    >
      <ToastStatusIcon tone={rejected ? 'danger' : 'trust'} />
    </span>
  );
}

export function PaymentNotificationToaster() {
  const notifications = useOptionalCustomerNotifications();
  const auth = useOptionalAuthUser();
  const router = useRouter();
  const { toasts } = useToasterStore();

  const userId =
    auth?.user && auth.user.role === 'customer' ? auth.user.id : null;

  /**
   * Contador REAL de toasts de notificación aún vivos (la fuente de verdad
   * es el store de react-hot-toast: expirar por los 12 s o cerrarlos con la
   * X los descuenta). Se refleja en un ref para poder drenar la cola dentro
   * de una misma pasada sin exceder el tope.
   */
  const activeCount = toasts.filter(
    (t) => (t.type as string) === 'notification' && !t.dismissed,
  ).length;
  const activeCountRef = useRef(activeCount);
  activeCountRef.current = activeCount;

  /** Cola FIFO de notificaciones pendientes de mostrar. */
  const queueRef = useRef<CustomerNotificationDto[]>([]);
  /** Ids ya encolados en esta sesión: dedupe de dobles eventos. */
  const shownIdsRef = useRef<Set<string>>(new Set());
  /** Tick para re-drenar la cola cuando entra un evento nuevo. */
  const [drainTick, setDrainTick] = useState(0);

  /**
   * Mark-as-read SIN esperar: la navegación jamás depende del resultado.
   * El fallo queda observable (log + `error` público del provider, que
   * `markAsRead` setea él mismo).
   */
  const markRead = useCallback(
    (notificationId: string): void => {
      void Promise.resolve(notifications?.markAsRead(notificationId))
        .then((ok) => {
          if (ok !== true) {
            console.error(
              '[PaymentNotificationToaster] mark-as-read falló (la navegación continúa):',
              notificationId,
            );
          }
        })
        .catch((err) => {
          console.error(
            '[PaymentNotificationToaster] mark-as-read lanzó (la navegación continúa):',
            notificationId,
            err,
          );
        });
    },
    [notifications],
  );

  /** Click en el toast: marcar leída y navegar SOLO a una URL validada. */
  const openNotification = useCallback(
    (notification: CustomerNotificationDto): void => {
      markRead(notification.id);
      const target = parsePaymentActionUrl(
        notification.type,
        notification.action_url,
      );
      if (!target) {
        // Externa/inválida/tipo-ruta cruzado: jamás navegar; observable.
        console.error(
          '[PaymentNotificationToaster] action_url inválida — navegación bloqueada:',
          {
            id: notification.id,
            type: notification.type,
            action_url: notification.action_url,
          },
        );
        return;
      }
      toast.dismiss(notification.id);
      router.push(target.href);
    },
    [markRead, router],
  );

  const showPaymentToast = useCallback(
    (notification: CustomerNotificationDto): void => {
      // Las opciones viven en una variable porque `type` no existe en el
      // tipo `ToastOptions` de react-hot-toast, aunque en runtime el spread
      // del toast sí lo respeta (así se activa la variante `notification`).
      const options = {
        id: notification.id,
        duration: PAYMENT_TOAST_DURATION_MS,
        type: 'notification',
      };
      toast(
        (t) => (
          <BaseToast
            variant="notification"
            visible={t.visible}
            icon={<PaymentStatusIcon type={notification.type} />}
            onClick={() => openNotification(notification)}
            onDismiss={() => toast.dismiss(t.id)}
          >
            <span className="block text-sm font-semibold text-brand-navy">
              {notification.title}
            </span>
            <span className="mt-0.5 block text-xs text-brand-muted">
              {notification.body}
            </span>
          </BaseToast>
        ),
        options,
      );
    },
    [openNotification],
  );

  /** Pasa de la cola a visibles mientras haya espacio (máximo 3). */
  const drainQueue = useCallback((): void => {
    let active = activeCountRef.current;
    while (
      active < MAX_SIMULTANEOUS_PAYMENT_TOASTS &&
      queueRef.current.length > 0
    ) {
      const next = queueRef.current.shift();
      if (!next) break;
      active += 1;
      activeCountRef.current = active;
      showPaymentToast(next);
    }
  }, [showPaymentToast]);

  const enqueue = useCallback(
    (notification: CustomerNotificationDto): void => {
      if (!isPaymentNotification(notification)) return;
      if (shownIdsRef.current.has(notification.id)) return;
      shownIdsRef.current.add(notification.id);
      queueRef.current.push(notification);
      setDrainTick((tick) => tick + 1);
    },
    [],
  );

  // Escucha estable de eventos entrantes (el valor del contexto expone un
  // `subscribeToIncoming` con identidad estable por sesión).
  const subscribeToIncoming = notifications?.subscribeToIncoming ?? null;
  useEffect(() => {
    if (!subscribeToIncoming) return undefined;
    return subscribeToIncoming(enqueue);
  }, [subscribeToIncoming, enqueue]);

  // Drena cuando entra un evento o cuando cambia el nº de visibles (al
  // expirar o cerrarse un toast se promueve el siguiente de la cola).
  useEffect(() => {
    drainQueue();
  }, [drainQueue, activeCount, drainTick]);

  // Cambio de sesión: nada de la cuenta anterior queda en cola ni en dedupe.
  useEffect(() => {
    queueRef.current = [];
    shownIdsRef.current = new Set();
  }, [userId]);

  return null;
}
