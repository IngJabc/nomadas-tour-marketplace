import { seatApi, type ClaimGuestLocksResult } from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';

/**
 * Resultado de la transición guest → authenticated para un viaje.
 *
 * - `claimed`: el backend transfirió los locks al customer conservando
 *   exactamente `lock_expires_at`.
 * - `no-pending`: no había sesión guest pendiente (sin cookie, vacía o ya
 *   resuelta). No es un error: es el caso normal de un customer que nunca
 *   usó locks guest.
 * - resto: estados descritos en Fase 4 (§9); el caller decide la UI.
 */
export type GuestClaimOutcome =
  | 'claimed'
  | 'no-pending'
  | 'already-claimed'
  | 'expired'
  | 'empty'
  | 'conflict'
  | 'error';

export interface GuestClaimResult {
  outcome: GuestClaimOutcome;
  claim?: ClaimGuestLocksResult;
  error?: ApiError;
}

/**
 * Requests en vuelo por viaje: garantiza UNA sola operación de claim por
 * transición aunque dos pantallas la detecten a la vez (p. ej. el viaje y el
 * wizard durante una navegación). Al asentarse se elimina la entrada, así que
 * no hay estado persistente entre montajes ni entre tests.
 */
const inFlight = new Map<string, Promise<GuestClaimResult>>();

function classifyClaimError(error: unknown): GuestClaimOutcome {
  if (error instanceof ApiError) {
    if (error.code === 'GUEST_SESSION_CLAIMED') return 'already-claimed';
    if (error.code === 'GUEST_SESSION_EXPIRED') return 'expired';
    if (error.code === 'GUEST_SESSION_EMPTY') return 'empty';
    if (error.code === 'GUEST_CLAIM_CONFLICT') return 'conflict';
    if (error.status === 401) return 'expired';
    if (error.status === 409) return 'conflict';
  }
  return 'error';
}

async function runClaim(tripId: string): Promise<GuestClaimResult> {
  // 1. Sondeo: solo reclamamos si la cookie describe locks guest vigentes.
  let pending;
  try {
    pending = await seatApi.getGuestLocks(tripId);
  } catch {
    pending = null;
  }
  if (!pending || !Array.isArray(pending.seats) || pending.seats.length === 0) {
    return { outcome: 'no-pending' };
  }

  // 2. Claim: el backend transfiere ownership y preserva la expiración.
  try {
    const claim = await seatApi.claimGuestLocks(tripId);
    return { outcome: 'claimed', claim };
  } catch (error) {
    return { outcome: classifyClaimError(error), error: error as ApiError };
  }
}

/**
 * Detecta y ejecuta el claim automático guest → customer para un viaje.
 * Idempotente por viaje mientras la operación siga en vuelo.
 */
export function claimPendingGuestLocks(tripId: string): Promise<GuestClaimResult> {
  const existing = inFlight.get(tripId);
  if (existing) return existing;

  const request = runClaim(tripId).finally(() => {
    inFlight.delete(tripId);
  });
  inFlight.set(tripId, request);
  return request;
}
