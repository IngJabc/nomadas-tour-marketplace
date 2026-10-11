import { beforeEach, describe, expect, it } from 'vitest';
import { isValidPaymentMarker, readLockState } from '../lock-state';

const LOCK_KEY = 'mkt004.lock.v1';

function persistedLock(payment?: unknown): string {
  const state: Record<string, unknown> = {
    trip_id: 'trip-1',
    agency_id: 'ag-1',
    seats: [
      { id: 'seat-1', seat_code: 'A1' },
      { id: 'seat-2', seat_code: 'A2' },
    ],
    lock_expires_at: '2026-10-04T12:00:00.000Z',
    passengers: [],
    reservation_id: 'res-1',
  };
  if (payment !== undefined) state.payment = payment;
  return JSON.stringify(state);
}

describe('isValidPaymentMarker', () => {
  it('acepta un marcador pending con y sin identificadores', () => {
    expect(isValidPaymentMarker({ status: 'pending' })).toBe(true);
    expect(
      isValidPaymentMarker({
        status: 'pending',
        payment_id: 'pay-1',
        submitted_at: '2026-10-04T12:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('rechaza marcadores ausentes o malformados', () => {
    expect(isValidPaymentMarker(undefined)).toBe(false);
    expect(isValidPaymentMarker(null)).toBe(false);
    expect(isValidPaymentMarker('pending')).toBe(false);
    expect(isValidPaymentMarker({ status: 'confirmed' })).toBe(false);
    expect(isValidPaymentMarker({ status: 'paid' })).toBe(false);
    expect(isValidPaymentMarker({ status: 'pending', payment_id: 42 })).toBe(
      false,
    );
    expect(
      isValidPaymentMarker({ status: 'pending', submitted_at: 42 }),
    ).toBe(false);
  });
});

describe('readLockState con marcador de pago', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('conserva un marcador pending válido', () => {
    sessionStorage.setItem(
      LOCK_KEY,
      persistedLock({ status: 'pending', payment_id: 'pay-1' }),
    );

    const stored = readLockState();

    expect(stored?.payment).toEqual({ status: 'pending', payment_id: 'pay-1' });
    expect(stored?.reservation_id).toBe('res-1');
  });

  it('sin marcador la LockState se lee con normalidad', () => {
    sessionStorage.setItem(LOCK_KEY, persistedLock());

    const stored = readLockState();

    expect(stored?.payment).toBeUndefined();
    expect(stored?.seats).toHaveLength(2);
  });

  it('con un marcador inválido descarta toda la LockState', () => {
    sessionStorage.setItem(
      LOCK_KEY,
      persistedLock({ status: 'confirmed' }),
    );

    expect(readLockState()).toBeNull();
  });

  it('con un marcador que no es objeto descarta toda la LockState', () => {
    sessionStorage.setItem(LOCK_KEY, persistedLock('pending'));

    expect(readLockState()).toBeNull();
  });
});
