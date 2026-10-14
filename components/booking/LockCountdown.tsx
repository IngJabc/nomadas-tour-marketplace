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
  /**
   * `lock` (por defecto): habla de la selección de asientos.
   * `review`: habla de la ventana de revisión del comprobante (MKT-007); el
   * texto de expiración jamás dice "selección expiró" cuando lo que terminó
   * fue la revisión.
   */
  mode?: 'lock' | 'review';
}

export function LockCountdown({
  expiresAt,
  onExpired,
  hidden,
  mode = 'lock',
}: LockCountdownProps) {
  const { remainingSeconds, formattedTime, expired } = useLockCountdown(
    expiresAt,
    onExpired,
  );

  if (hidden) return null;
  if (remainingSeconds === null || formattedTime === null) return null;

  const urgent = !expired && remainingSeconds <= 60;
  const review = mode === 'review';

  return (
    <p
      role="timer"
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-semibold ${
        urgent || expired ? 'bg-[#fef2f2] text-[#ef4444]' : 'bg-[#fffbeb] text-[#92400e]'
      }`}
    >
      <Timer size={16} strokeWidth={1.75} aria-hidden="true" />
      {expired
        ? review
          ? 'La ventana de revisión terminó.'
          : 'Tu selección expiró.'
        : review
          ? urgent
            ? `La revisión vence en ${formattedTime}`
            : `Revisión en curso: ${formattedTime}`
          : urgent
            ? `Tu selección expira en ${formattedTime}`
            : `Tu selección está reservada durante ${formattedTime}`}
    </p>
  );
}
