'use client';

import { AuthProvider } from '@/components/auth/AuthProvider';
import { CustomerNotificationsProvider } from '@/components/notifications/CustomerNotificationsProvider';
import { PaymentNotificationToaster } from '@/components/notifications/PaymentNotificationToaster';
import type { ReactNode } from 'react';

/**
 * Raíz de proveedores globales. `CustomerNotificationsProvider` (Task 8C)
 * vive DENTRO de `AuthProvider` para compartir su ciclo de vida: al cerrar
 * sesión o cambiar de cuenta se vuelca el estado de notificaciones y se
 * da de baja el canal Realtime (el propio provider lo resuelve).
 * `PaymentNotificationToaster` consume ese estado sin duplicarlo.
 */
export function RootProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <CustomerNotificationsProvider>
        <PaymentNotificationToaster />
        {children}
      </CustomerNotificationsProvider>
    </AuthProvider>
  );
}
