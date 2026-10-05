'use client';

import { Timer } from 'lucide-react';
import { useLockCountdown } from '@/lib/booking/useLockCountdown';

interface LockCountdownProps {
  expiresAt: string | null | undefined;
  onExpired?: () => void;
}

export function LockCountdown({ expiresAt, onExpired }: LockCountdownProps) {
  const { remainingSeconds, formattedTime, expired } = useLockCountdown(
    expiresAt,
    onExpired,
  );

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
