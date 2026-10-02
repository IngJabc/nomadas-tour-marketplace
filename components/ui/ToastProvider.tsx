'use client';

import {
  Toaster,
  resolveValue,
  CheckmarkIcon,
  ErrorIcon,
  LoaderIcon,
  type Toast,
} from 'react-hot-toast';
import { BaseToast, type ToastVariant } from '@/components/ui/BaseToast';

export function ToastProvider() {
  return (
    <Toaster
      position="bottom-right"
      toastOptions={{
        duration: 4000,
        removeDelay: 200,
        success: {
          iconTheme: {
            primary: 'var(--color-brand-cyan)',
            secondary: 'var(--color-brand-surface)',
          },
        },
        error: {
          iconTheme: {
            primary: '#fb923c',
            secondary: 'var(--color-brand-surface)',
          },
        },
      }}
    >
      {(t: Toast) => {
        const message = resolveValue(t.message, t);
        const icon = t.icon
          ? typeof t.icon === 'string'
            ? <span className="text-lg">{t.icon}</span>
            : t.icon
          : t.type === 'success'
            ? <CheckmarkIcon />
            : t.type === 'error'
              ? <ErrorIcon />
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
