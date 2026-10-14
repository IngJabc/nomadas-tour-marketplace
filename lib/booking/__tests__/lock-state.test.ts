import { beforeEach, describe, expect, it } from 'vitest';
import {
  isValidCheckoutMarker,
  readLockState,
} from '../lock-state';

const LOCK_KEY = 'mkt004.lock.v1';

const BASE_STATE: Record<string, unknown> = {
  trip_id: 'trip-1',
  agency_id: 'ag-1',
  seats: [
    { id: 'seat-1', seat_code: 'A1' },
    { id: 'seat-2', seat_code: 'A2' },
  ],
  lock_expires_at: '2026-10-04T12:00:00.000Z',
  passengers: [],
};

function persistedLock(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...BASE_STATE, ...overrides });
}

describe('isValidCheckoutMarker', () => {
  it('acepta los tres estados del intento con su folio', () => {
    expect(
      isValidCheckoutMarker({ status: 'created', attempt_id: 'att-1' }),
    ).toBe(true);
    expect(
      isValidCheckoutMarker({ status: 'pending_review', attempt_id: 'att-1' }),
    ).toBe(true);
    expect(
      isValidCheckoutMarker({ status: 'rejected', attempt_id: 'att-1' }),
    ).toBe(true);
  });

  it('acepta los campos opcionales con tipos correctos', () => {
    expect(
      isValidCheckoutMarker({
        status: 'pending_review',
        attempt_id: 'att-1',
        submitted_at: '2026-10-04T12:00:00.000Z',
        proof_count: 2,
        remaining_submissions: 1,
        expires_at: '2026-10-05T12:00:00.000Z',
        rejection_reason: 'Referencia no encontrada',
      }),
    ).toBe(true);
  });

  it('rechaza estados terminales: el cliente jamás afirma aprobación', () => {
    expect(isValidCheckoutMarker({ status: 'verified', attempt_id: 'a' })).toBe(
      false,
    );
    expect(isValidCheckoutMarker({ status: 'paid', attempt_id: 'a' })).toBe(
      false,
    );
    expect(
      isValidCheckoutMarker({ status: 'confirmed', attempt_id: 'a' }),
    ).toBe(false);
    expect(isValidCheckoutMarker({ status: 'expired', attempt_id: 'a' })).toBe(
      false,
    );
    expect(isValidCheckoutMarker({ status: 'cancelled', attempt_id: 'a' })).toBe(
      false,
    );
  });

  it('rechaza marcadores ausentes o malformados', () => {
    expect(isValidCheckoutMarker(undefined)).toBe(false);
    expect(isValidCheckoutMarker(null)).toBe(false);
    expect(isValidCheckoutMarker('pending_review')).toBe(false);
    expect(isValidCheckoutMarker({ status: 'pending_review' })).toBe(false);
    expect(
      isValidCheckoutMarker({ status: 'pending_review', attempt_id: 42 }),
    ).toBe(false);
    expect(
      isValidCheckoutMarker({
        status: 'pending_review',
        attempt_id: 'a',
        proof_count: 'dos',
      }),
    ).toBe(false);
    expect(
      isValidCheckoutMarker({
        status: 'pending_review',
        attempt_id: 'a',
        submitted_at: 42,
      }),
    ).toBe(false);
  });
});

describe('readLockState', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('conserva un intento con marcador válido', () => {
    sessionStorage.setItem(
      LOCK_KEY,
      persistedLock({
        attempt_id: 'att-1',
        attempt_key: 'b2f1f6d0-0000-4000-8000-000000000001',
        checkout: { status: 'pending_review', attempt_id: 'att-1' },
      }),
    );

    const stored = readLockState();

    expect(stored?.attempt_id).toBe('att-1');
    expect(stored?.checkout?.status).toBe('pending_review');
    expect(stored?.seats).toHaveLength(2);
  });

  it('lee con normalidad una selección sin intento todavía', () => {
    sessionStorage.setItem(LOCK_KEY, persistedLock());

    const stored = readLockState();

    expect(stored?.attempt_id).toBeUndefined();
    expect(stored?.checkout).toBeUndefined();
    expect(stored?.seats).toHaveLength(2);
  });

  it('descarta el formato anterior (reservation_id + payment)', () => {
    sessionStorage.setItem(
      LOCK_KEY,
      persistedLock({
        reservation_id: 'res-1',
        payment: { status: 'pending', payment_id: 'pay-1' },
      }),
    );

    expect(readLockState()).toBeNull();
  });

  it('descarta el formato anterior aunque solo tenga reservation_id', () => {
    sessionStorage.setItem(LOCK_KEY, persistedLock({ reservation_id: 'res-1' }));

    expect(readLockState()).toBeNull();
  });

  it('descarta toda la LockState si el marcador del intento es inválido', () => {
    sessionStorage.setItem(
      LOCK_KEY,
      persistedLock({
        attempt_id: 'att-1',
        checkout: { status: 'verified', attempt_id: 'att-1' },
      }),
    );

    expect(readLockState()).toBeNull();
  });

  it('descarta toda la LockState si el marcador no es un objeto', () => {
    sessionStorage.setItem(
      LOCK_KEY,
      persistedLock({ attempt_id: 'att-1', checkout: 'pending_review' }),
    );

    expect(readLockState()).toBeNull();
  });

  it('descarta la LockState si attempt_key no es texto', () => {
    sessionStorage.setItem(
      LOCK_KEY,
      persistedLock({ attempt_id: 'att-1', attempt_key: 123 }),
    );

    expect(readLockState()).toBeNull();
  });
});
