'use client';

import { Timer } from 'lucide-react';
import { useLockCountdown } from '@/lib/booking/useLockCountdown';

interface LockCountdownProps {
  expiresAt: string | null | undefined;
  onExpired?: () => void;
  /**
   * Oculta la píldora sin detener el countdown: el hook sigue corriendo y
   * `onExpired` sigue disparándose. Hoy sin usos en pantalla desde que
   * MKT-007.1 eliminó el modo `review`; se conserva como API del componente.
   */
  hidden?: boolean;
}

// MKT-007.1: el modo `review` se eliminó — la ventana de revisión ya no
// muestra countdown, solo un mensaje por estado (ver `reviewMessage`).
export function LockCountdown({
  expiresAt,
  onExpired,
  hidden,
}: LockCountdownProps) {
  const { remainingSeconds, formattedTime, expired } = useLockCountdown(
    expiresAt,
    onExpired,
  );

  if (hidden) return null;
  if (remainingSeconds === null || formattedTime === null) return null;

  const urgent = !expired && remainingSeconds <= 60;

  return (
    <p
      role="timer"
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-semibold ${
        urgent || expired ? 'bg-[#fef2f2] text-[#ef4444]' : 'bg-[#fffbeb] text-[#92400e]'
      }`}
    >
      <Timer size={16} strokeWidth={1.75} aria-hidden="true" />
      {expired
        ? 'Tu selección expiró.'
        : urgent
          ? `Tu selección expira en ${formattedTime}`
          : `Tu selección está reservada durante ${formattedTime}`}
    </p>
  );
}
