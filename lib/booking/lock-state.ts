import type { LockedSeatInfo } from '@/lib/api';

export interface PassengerDraft {
  seat_id: string;
  first_name: string;
  last_name: string;
  document: string;
  phone: string;
}

/**
 * Marcador local del estado del `checkout_attempt` (MKT-007).
 *
 * Solo representa lo que la interfaz registró: NO es prueba de un pago
 * aceptado por el servidor, ni permite afirmar `paid`/`confirmed`. Nunca
 * guarda el binario del archivo ni tokens de sesión.
 *
 * `pending_review` es el único estado que bloquea la pantalla: la agencia
 * todavía no decidió. `created` y `rejected` siguen permitiendo reenviar
 * comprobante (máximo 3 en total, lo decide el backend).
 */
export interface CheckoutMarker {
  status: 'created' | 'pending_review' | 'rejected';
  attempt_id: string;
  submitted_at?: string;
  proof_count?: number;
  remaining_submissions?: number;
  expires_at?: string;
  rejection_reason?: string;
}

export interface LockState {
  trip_id: string;
  agency_id: string | null;
  seats: LockedSeatInfo[];
  lock_expires_at: string;
  passengers: PassengerDraft[];
  /**
   * Seteado por `POST /api/public/checkout/attempts` cuando el intento de
   * compra ya existe. Desde ese punto el checkout no vuelve a crearlo.
   * `customer_id`, `agency_id`, `unit_price`, `amount_cents` y `status`
   * viven solo en el backend.
   */
  attempt_id?: string;
  /**
   * `Idempotency-Key` del POST que crea el intento. Se persiste ANTES de
   * enviar para que un reintento que perdió la respuesta reutilice la MISMA
   * clave en lugar de crear un segundo intento de compra.
   */
  attempt_key?: string;
  /**
   * Seteado al crear el intento y actualizado con cada comprobante.
   * Persiste con la LockState y sobrevive a la recarga; no extiende por su
   * cuenta la ventana que el servidor calcula.
   */
  checkout?: CheckoutMarker;
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

/**
 * Fuente única de verdad para "marcador de checkout válido".
 *
 * Una LockState que incumple esto se descarta entera al leerla, así que en
 * la UI solo llega un marcador que ya pasó por aquí.
 */
export function isValidCheckoutMarker(
  marker: unknown,
): marker is CheckoutMarker {
  if (!marker || typeof marker !== 'object') return false;
  const candidate = marker as Partial<CheckoutMarker>;
  if (
    candidate.status !== 'created' &&
    candidate.status !== 'pending_review' &&
    candidate.status !== 'rejected'
  ) {
    return false;
  }
  if (typeof candidate.attempt_id !== 'string') return false;
  for (const value of [
    candidate.submitted_at,
    candidate.expires_at,
    candidate.rejection_reason,
  ]) {
    if (value !== undefined && typeof value !== 'string') return false;
  }
  for (const value of [candidate.proof_count, candidate.remaining_submissions]) {
    if (value !== undefined && typeof value !== 'number') return false;
  }
  return true;
}

function isValid(state: unknown): state is LockState {
  if (!state || typeof state !== 'object') return false;
  const candidate = state as Partial<LockState> & Record<string, unknown>;
  if (
    typeof candidate.trip_id !== 'string' ||
    typeof candidate.lock_expires_at !== 'string' ||
    !Array.isArray(candidate.seats) ||
    candidate.seats.length === 0 ||
    !candidate.seats.every(
      (seat) =>
        typeof seat?.id === 'string' && typeof seat?.seat_code === 'string',
    ) ||
    !Array.isArray(candidate.passengers)
  ) {
    return false;
  }

  // Formato anterior a MKT-007 (`reservation_id` + `payment`): se descarta
  // entero. Esas reservas nacieron antes de la revisión del comprobante y
  // su flujo ya no existe; reintentar contra el endpoint nuevo daría 410.
  if (
    'reservation_id' in candidate ||
    'payment' in candidate ||
    candidate.payment !== undefined
  ) {
    return false;
  }

  if (
    candidate.attempt_id !== undefined &&
    typeof candidate.attempt_id !== 'string'
  ) {
    return false;
  }
  if (
    candidate.attempt_key !== undefined &&
    typeof candidate.attempt_key !== 'string'
  ) {
    return false;
  }

  // Un marcador malformado invalida toda la LockState: nunca se debe
  // confiar en datos persistidos rotos para restaurar la revisión.
  return (
    candidate.checkout === undefined || isValidCheckoutMarker(candidate.checkout)
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
