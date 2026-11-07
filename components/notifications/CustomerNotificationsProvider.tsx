'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { reviewsApi, type CustomerNotificationDto } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors/api-error';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';
import {
  subscribeToCustomerNotifications,
  type RealtimeCustomerNotificationRow,
} from '@/lib/realtime/subscriptions';

/**
 * PAY-NOTIFICATIONS Task 8B — estado de notificaciones del cliente.
 *
 * Capa de estado SIN UI: listado, contador de no leídos, refresh,
 * mark-as-read y (Task 8D) la suscripción Realtime de INSERT con entrega de
 * eventos nuevos a los consumidores (toasts de pago). NO implementa badge de
 * navbar ni resaltado de compras: esos consumen este estado vía el hook.
 *
 * Reglas:
 *   - Reutiliza `reviewsApi.notifications()` / `markNotificationRead()`.
 *   - Soporta `payment_verified` y `payment_rejected` (ver
 *     `PAYMENT_NOTIFICATION_TYPES`).
 *   - `unreadCount` = notificaciones con `read_at === null`.
 *   - Dedupe por `id` al recibir el listado.
 *   - Sesión: solo clientes autenticados; al cambiar de usuario se VUELCA
 *     el estado anterior ANTES de fetchear (nada de un usuario puede quedar
 *     visible para otro) y las respuestas en vuelo de la sesión anterior se
 *     descartan por generación.
 *   - Realtime (Task 8D): canal `customer_notifications` filtrado por el
 *     propio `customer_id`, con cleanup en logout/cambio de cuenta/desmonte.
 *     Un INSERT nuevo refresca el listado (contador incluido) y se EMITE a
 *     los listeners suscriptos (`subscribeToIncoming`) para que la capa de
 *     UI muestre el toast. El listado inicial NUNCA se emite: los toasts
 *     vienen solo de eventos en vivo, no del histórico.
 */

/** Tipos de notificación de pago (objetivo del feature). */
export const PAYMENT_NOTIFICATION_TYPES = [
  'payment_verified',
  'payment_rejected',
] as const;

export type PaymentNotificationType = (typeof PAYMENT_NOTIFICATION_TYPES)[number];

export function isPaymentNotification(
  notification: CustomerNotificationDto,
): boolean {
  return (PAYMENT_NOTIFICATION_TYPES as readonly string[]).includes(
    notification.type,
  );
}

/** Deduplica por `id` preservando el orden del servidor. */
function dedupeById(
  items: CustomerNotificationDto[],
): CustomerNotificationDto[] {
  const seen = new Set<string>();
  const out: CustomerNotificationDto[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Convierte una fila de Realtime en el DTO del dominio, validando lo
 * mínimo: id y tipo presentes y `customer_id` igual al cliente de la
 * sesión. Todo lo demás cae a valores neutros (nunca `undefined` en el DTO).
 * Devuelve `null` si la fila no es utilizable → el caller la descarta.
 */
function rowToNotification(
  row: RealtimeCustomerNotificationRow,
  customerId: string | null,
): CustomerNotificationDto | null {
  if (!customerId) return null;
  if (typeof row.id !== 'string' || row.id === '') return null;
  if (row.customer_id !== customerId) return null;
  if (typeof row.type !== 'string' || row.type === '') return null;
  return {
    id: row.id,
    type: row.type,
    title: typeof row.title === 'string' ? row.title : '',
    body: typeof row.body === 'string' ? row.body : '',
    entity_type: typeof row.entity_type === 'string' ? row.entity_type : '',
    entity_id: typeof row.entity_id === 'string' ? row.entity_id : '',
    action_url: typeof row.action_url === 'string' ? row.action_url : null,
    read_at: typeof row.read_at === 'string' ? row.read_at : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
  };
}

export interface CustomerNotificationsContextValue {
  /** Listado completo del cliente (deduplicado por id). */
  notifications: CustomerNotificationDto[];
  /** Solo `payment_verified` / `payment_rejected`. */
  paymentNotifications: CustomerNotificationDto[];
  /** Cantidad con `read_at === null`. */
  unreadCount: number;
  /** true mientras se resuelve la sesión o el primer load/refresh. */
  loading: boolean;
  /** Mensaje público del último error (null si no hay). */
  error: string | null;
  /**
   * Estado del canal Realtime de `customer_notifications`: `'idle'` sin
   * sesión cliente o antes de conectar; después, el estado reportado por
   * Supabase (`SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`).
   * Informativo: los fallos también quedan en log observable.
   */
  realtimeStatus: string;
  /** Reconsulta la lista (mantiene el estado si falla). */
  refresh: () => Promise<void>;
  /**
   * Marca como leída en el servidor. Tras el éxito actualiza el estado
   * local (read_at) de forma consistente. `false` si falló o no hay
   * sesión de cliente; el estado local NO cambia en ese caso.
   */
  markAsRead: (notificationId: string) => Promise<boolean>;
  /**
   * Alta de escucha de notificaciones NUEVAS recibidas por Realtime (el
   * listado inicial NUNCA se emite). Devuelve la función de baja; el
   * provider limpia los listeners al desmontar o cambiar de sesión.
   */
  subscribeToIncoming: (
    listener: (notification: CustomerNotificationDto) => void,
  ) => () => void;
}

const CustomerNotificationsContext = createContext<
  CustomerNotificationsContextValue | null
>(null);

export function CustomerNotificationsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const auth = useOptionalAuthUser();
  const user = auth?.user ?? null;
  const authLoading = auth?.loading ?? false;
  const isCustomer = !!user && user.role === 'customer';
  const userId = isCustomer ? user!.id : null;

  const [notifications, setNotifications] = useState<CustomerNotificationDto[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Generación de sesión: invalida respuestas de la sesión anterior. */
  const generationRef = useRef(0);
  /** Usuario cuyo estado está cargado (detecta cambio de cuenta). */
  const loadedUserIdRef = useRef<string | null>(null);
  /** Listeners de notificaciones entrantes (INSERT de Realtime). */
  const incomingListenersRef = useRef<
    Set<(notification: CustomerNotificationDto) => void>
  >(new Set());
  /** Ids ya emitidos esta sesión: un evento reentregado no re-emite. */
  const seenRealtimeIdsRef = useRef<Set<string>>(new Set());
  /** Estado del canal Realtime (ver contexto de la interfaz). */
  const [realtimeStatus, setRealtimeStatus] = useState<string>('idle');

  const subscribeToIncoming = useCallback(
    (listener: (notification: CustomerNotificationDto) => void): (() => void) => {
      incomingListenersRef.current.add(listener);
      return () => {
        incomingListenersRef.current.delete(listener);
      };
    },
    [],
  );

  /** Emite a los listeners de forma aislada: uno roto no rompe a los demás. */
  const emitIncoming = useCallback(
    (notification: CustomerNotificationDto): void => {
      for (const listener of incomingListenersRef.current) {
        try {
          listener(notification);
        } catch (err) {
          console.error(
            '[CustomerNotifications] listener de notificación entrante falló:',
            err,
          );
        }
      }
    },
    [],
  );

  const fetchNotifications = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const { items } = await reviewsApi.notifications();
      if (generation !== generationRef.current) return; // sesión vieja
      setNotifications(dedupeById(Array.isArray(items) ? items : []));
      setError(null);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(getApiErrorMessage(err));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) {
      // Sesión resolviéndose: aún no se sabe si hay cliente.
      setLoading(true);
      return;
    }

    if (!isCustomer || !userId) {
      // Sin cliente (sin sesión o rol distinto): volcar TODO el estado.
      generationRef.current += 1; // descarta respuestas en vuelo
      loadedUserIdRef.current = null;
      seenRealtimeIdsRef.current.clear();
      setRealtimeStatus('idle');
      setNotifications([]);
      setError(null);
      setLoading(false);
      return;
    }

    if (loadedUserIdRef.current !== userId) {
      // Cambio de cuenta: vaciar ANTES de fetchear para no filtrar el
      // listado del usuario anterior al nuevo (req. 7).
      loadedUserIdRef.current = userId;
      generationRef.current += 1;
      seenRealtimeIdsRef.current.clear();
      setRealtimeStatus('idle');
      setNotifications([]);
      setError(null);
    }

    void fetchNotifications();
  }, [authLoading, isCustomer, userId, fetchNotifications]);

  /**
   * Task 8D — Realtime de `customer_notifications` (INSERT del propio
   * cliente). Un evento nuevo:
   *   1. se valida (fila propia y utilizable);
   *   2. se deduplica por id (reentregas tras reconexión no re-emiten);
   *   3. refresca el listado (esto actualiza `unreadCount`);
   *   4. se emite a los listeners de UI (toast de pago) — NUNCA se emite el
   *      listado inicial: el histórico no genera toasts.
   * El cleanup del efecto da de baja el canal al desmontar, al cambiar de
   * cuenta y al cerrar sesión (el efecto se re-ejecuta o sale por la rama
   * de arriba cuando `userId` desaparece).
   */
  useEffect(() => {
    if (authLoading || !isCustomer || !userId) return undefined;
    /**
     * Guardia de sesión activa: tras el cleanup (logout, cambio de cuenta,
     * desmonte) cualquier entrega tardía del canal se DESCARTA — ni refresca
     * ni emite. En producción `removeChannel` corta la entrega, pero esta
     * guarda hace el criterio explícito e independiente del transporte.
     */
    let active = true;

    const cleanup = subscribeToCustomerNotifications(
      userId,
      (row) => {
        if (!active) return;
        const notification = rowToNotification(row, userId);
        if (!notification) {
          console.warn(
            '[CustomerNotifications] evento Realtime descartado (fila ajena o inválida)',
          );
          return;
        }
        if (seenRealtimeIdsRef.current.has(notification.id)) return;
        seenRealtimeIdsRef.current.add(notification.id);
        void fetchNotifications();
        emitIncoming(notification);
      },
      (status, error) => {
        if (!active) return;
        setRealtimeStatus(status);
        if (status !== 'SUBSCRIBED') {
          // Observable sin romper la app: la app sigue viva por REST.
          console.warn(
            '[CustomerNotifications] Realtime customer_notifications:',
            status,
            error,
          );
        }
      },
    );

    return () => {
      active = false;
      cleanup();
    };
  }, [authLoading, isCustomer, userId, fetchNotifications, emitIncoming]);

  const refresh = useCallback(async () => {
    if (!isCustomer) return;
    await fetchNotifications();
  }, [isCustomer, fetchNotifications]);

  const markAsRead = useCallback(
    async (notificationId: string): Promise<boolean> => {
      if (!isCustomer) return false;
      try {
        await reviewsApi.markNotificationRead(notificationId);
      } catch (err) {
        // La API falló: el estado local NO cambia (req. 5).
        setError(getApiErrorMessage(err));
        return false;
      }
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notificationId && n.read_at === null
            ? { ...n, read_at: new Date().toISOString() }
            : n,
        ),
      );
      return true;
    },
    [isCustomer],
  );

  const paymentNotifications = useMemo(
    () => notifications.filter(isPaymentNotification),
    [notifications],
  );

  const unreadCount = useMemo(
    () => notifications.filter((n) => n.read_at === null).length,
    [notifications],
  );

  const value = useMemo<CustomerNotificationsContextValue>(
    () => ({
      notifications,
      paymentNotifications,
      unreadCount,
      loading,
      error,
      realtimeStatus,
      refresh,
      markAsRead,
      subscribeToIncoming,
    }),
    [
      notifications,
      paymentNotifications,
      unreadCount,
      loading,
      error,
      realtimeStatus,
      refresh,
      markAsRead,
      subscribeToIncoming,
    ],
  );

  return (
    <CustomerNotificationsContext.Provider value={value}>
      {children}
    </CustomerNotificationsContext.Provider>
  );
}

/** Lanza fuera del provider (patrón de AuthProvider). */
export function useCustomerNotifications(): CustomerNotificationsContextValue {
  const ctx = useContext(CustomerNotificationsContext);
  if (!ctx) {
    throw new Error(
      'useCustomerNotifications must be used within CustomerNotificationsProvider',
    );
  }
  return ctx;
}

/** Versión tolerante fuera del provider (tests, rutas sueltas). */
export function useOptionalCustomerNotifications(): CustomerNotificationsContextValue | null {
  return useContext(CustomerNotificationsContext);
}
