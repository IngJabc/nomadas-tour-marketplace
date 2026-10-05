'use client';

import { useEffect, useRef, useState } from 'react';

export interface UseLockCountdownReturn {
  remainingSeconds: number | null;
  formattedTime: string | null;
  expired: boolean;
}

function parseExpiry(expiresAt: string | null | undefined): number | null {
  if (!expiresAt) return null;
  const timestamp = Date.parse(expiresAt);
  return Number.isNaN(timestamp) ? null : timestamp;
}

/**
 * Countdown derivado SIEMPRE de `lock_expires_at` (fecha absoluta del servidor).
 * Nunca parte del TTL del render: así un refresh o cambio de pestaña no reanima
 * un lock ya vencido.
 */
export function useLockCountdown(
  expiresAt: string | null | undefined,
  onExpired?: () => void,
): UseLockCountdownReturn {
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const onExpiredRef = useRef(onExpired);
  const firedRef = useRef(false);

  onExpiredRef.current = onExpired;

  useEffect(() => {
    firedRef.current = false;
    setExpired(false);

    const expires = parseExpiry(expiresAt);
    if (expires === null) {
      setRemainingSeconds(null);
      return;
    }

    let interval: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      const diff = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
      setRemainingSeconds(diff);
      if (diff <= 0) {
        setExpired(true);
        if (!firedRef.current) {
          firedRef.current = true;
          if (interval) {
            clearInterval(interval);
            interval = null;
          }
          onExpiredRef.current?.();
        }
      }
    };

    tick();
    if (expires - Date.now() > 0) {
      interval = setInterval(tick, 1000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [expiresAt]);

  const formattedTime =
    remainingSeconds !== null
      ? `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(
          remainingSeconds % 60,
        ).padStart(2, '0')}`
      : null;

  return { remainingSeconds, formattedTime, expired };
}
