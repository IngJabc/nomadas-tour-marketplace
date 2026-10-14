'use client';

import { useEffect, useId } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, LoaderCircle } from 'lucide-react';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Confirma la acción. Si retorna una promesa, el botón se queda en loading. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  loading?: boolean;
  /** Marca la confirmación como destructiva (botón rojo, estilo del sistema). */
  destructive?: boolean;
}

/**
 * Modal de confirmación del sistema.
 *
 * Reemplaza a `window.confirm` (prohibido por AGENTS.md §15): toda acción
 * destructiva pasa por aquí antes de tocar el backend. Se cierra con Escape,
 * con clic en el fondo o con el botón secundario; nunca con la acción
 * destructiva mientras esté en curso (`loading` bloquea todo el modal).
 */
export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  onConfirm,
  onCancel,
  loading = false,
  destructive = true,
}: ConfirmModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, loading, onCancel]);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.button
            type="button"
            aria-label="Cerrar"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            disabled={loading}
            onClick={() => {
              if (!loading) onCancel();
            }}
            className="absolute inset-0 cursor-default bg-black/60 disabled:cursor-default"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="relative w-full max-w-md rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_12px_48px_rgba(0,0,0,0.24)]"
          >
            <div className="flex items-start gap-3">
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                  destructive ? 'bg-[#fef2f2]' : 'bg-[#fffbeb]'
                }`}
              >
                <AlertTriangle
                  size={20}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className={destructive ? 'text-[#ef4444]' : 'text-[#92400e]'}
                />
              </span>
              <div className="min-w-0">
                <h2
                  id={titleId}
                  className="text-[20px] font-bold leading-tight text-brand-navy"
                >
                  {title}
                </h2>
                <p className="mt-2 text-sm text-brand-muted">{description}</p>
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => {
                  if (!loading) onCancel();
                }}
                disabled={loading}
                className="inline-flex items-center justify-center rounded-[10px] bg-[#f1f5f9] px-5 py-2.5 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={() => void onConfirm()}
                disabled={loading}
                className={
                  destructive
                    ? 'inline-flex items-center justify-center gap-2 rounded-[10px] bg-[#fef2f2] px-5 py-2.5 text-sm font-semibold text-[#ef4444] transition-colors duration-200 hover:bg-[#fee2e2] disabled:cursor-not-allowed disabled:opacity-40'
                    : 'inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40'
                }
              >
                {loading ? (
                  <LoaderCircle
                    size={16}
                    strokeWidth={1.75}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {loading ? 'Procesando…' : confirmLabel}
              </button>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
