import type { LockedSeatInfo } from '@/lib/api';

export interface PassengerDraft {
  seat_id: string;
  first_name: string;
  last_name: string;
  document: string;
  phone: string;
}

export interface LockState {
  trip_id: string;
  agency_id: string | null;
  seats: LockedSeatInfo[];
  lock_expires_at: string;
  passengers: PassengerDraft[];
}

const LOCK_STATE_KEY = 'mkt004.lock.v1';

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isValid(state: unknown): state is LockState {
  if (!state || typeof state !== 'object') return false;
  const candidate = state as Partial<LockState>;
  return (
    typeof candidate.trip_id === 'string' &&
    typeof candidate.lock_expires_at === 'string' &&
    Array.isArray(candidate.seats) &&
    candidate.seats.length > 0 &&
    candidate.seats.every(
      (seat) =>
        typeof seat?.id === 'string' && typeof seat?.seat_code === 'string',
    ) &&
    Array.isArray(candidate.passengers)
  );
}

export function readLockState(): LockState | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(LOCK_STATE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLockState(state: LockState): void {
  const store = storage();
  if (!store) return;
  store.setItem(LOCK_STATE_KEY, JSON.stringify(state));
}

export function clearLockState(): void {
  const store = storage();
  if (!store) return;
  store.removeItem(LOCK_STATE_KEY);
}
