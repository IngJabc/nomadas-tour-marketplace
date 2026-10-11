'use client';

import { Timer } from 'lucide-react';
import { useLockCountdown } from '@/lib/booking/useLockCountdown';

interface LockCountdownProps {
  expiresAt: string | null | undefined;
  onExpired?: () => void;
  /**
   * Oculta la píldora sin detener el countdown: el hook sigue corriendo y
   * `onExpired` sigue disparándose (MKT-005: con el comprobante en revisión
   * la expiración no debe pintarse en pantalla).
   */
  hidden?: boolean;
}

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
