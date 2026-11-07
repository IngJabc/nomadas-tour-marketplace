'use client';

import {
  Toaster,
  resolveValue,
  LoaderIcon,
  type Toast,
} from 'react-hot-toast';
import {
  BaseToast,
  ToastStatusIcon,
  type ToastVariant,
} from '@/components/ui/BaseToast';

export function ToastProvider() {
  return (
    <Toaster
      position="bottom-right"
      toastOptions={{
        duration: 2500,
        removeDelay: 200,
      }}
    >
      {(t: Toast) => {
        const message = resolveValue(t.message, t);
        // PAY-NOTIFICATIONS: el toast de notificación llega como función que
        // ya renderiza BaseToast completo (variante `notification` con onClick
        // y onDismiss propios); se pinta tal cual para no envolverlo dos veces.
        if ((t.type as string) === 'notification') return <>{message}</>;
        // Icono de estado con el MISMO lenguaje visual de los toasts de pago
        // (círculo suave trust/danger, Lucide stroke 1.75). El spinner de
        // carga se conserva tal cual.
        const icon = t.icon
          ? typeof t.icon === 'string'
            ? <span className="text-lg">{t.icon}</span>
            : t.icon
          : t.type === 'success'
            ? <ToastStatusIcon tone="trust" />
            : t.type === 'error'
              ? <ToastStatusIcon tone="danger" />
              : t.type === 'loading'
                ? <LoaderIcon />
                : null;

        return (
          <BaseToast variant={t.type as ToastVariant} visible={t.visible} icon={icon}>
            {message}
          </BaseToast>
        );
      }}
    </Toaster>
  );
}
