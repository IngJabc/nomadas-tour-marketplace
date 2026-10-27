import { supabaseAdmin } from '../config/database.js';
import {
  captureException,
  fingerprintHttpError,
} from '../observability/sentry.js';

// ── MKT-010: expiración integral del checkout ────────────────────────────────
//
// La RPC `cleanup_expired_checkout_attempts` (migración 087, sección 10)
// es la ÚNICA autoridad para cerrar intentos vencidos: cierra los
// `created/pending_review/rejected` con `expires_at <= NOW()` y libera
// SOLO los locks que le pertenecen (`seats.checkout_attempt_id`). Es
// idempotente y segura ante ejecuciones concurrentes (FOR UPDATE SKIP
// LOCKED + guards de fila). Antes de MKT-010 NINGÚN proceso la invocaba
// (cabecera de 090 lo reconocía), así que un intento abandonado podía
// quedar abierto y sus asientos retenidos hasta que el cliente volviera.
// Este módulo aporta el invocador: periódico (loop del backend) y
// perezoso (al leer/enviar/cancelar un intento vencido).

export interface CheckoutCleanupResult {
  expired: number;
  freed_seats: number;
  attempt_ids: string[];
}

/**
 * Ejecuta la RPC de expiración. Nunca lanza: un fallo se loguea/captura
 * y devuelve `null` para que el caller continúe con su camino (el próximo
 * ciclo lo reintenta; la limpieza es idempotente).
 */
export async function runCheckoutCleanup(): Promise<CheckoutCleanupResult | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc(
      'cleanup_expired_checkout_attempts',
    );
    if (error) {
      console.error('[CheckoutCleanup] RPC error:', error.message);
      captureException(new Error(error.message), {
        tags: { service: 'api', area: 'checkout_cleanup' },
        fingerprint: fingerprintHttpError(500, 'CHECKOUT_CLEANUP'),
      });
      return null;
    }
    const result = (data ?? {}) as Partial<CheckoutCleanupResult>;
    const expired = result.expired ?? 0;
    if (expired > 0) {
      console.log(
        `[CheckoutCleanup] Expired ${expired} attempt(s), freed ${result.freed_seats ?? 0} seat(s)`,
      );
    }
    return {
      expired,
      freed_seats: result.freed_seats ?? 0,
      attempt_ids: result.attempt_ids ?? [],
    };
  } catch (err) {
    console.error(
      '[CheckoutCleanup] Error:',
      err instanceof Error ? err.message : String(err),
    );
    captureException(err, {
      tags: { service: 'api', area: 'checkout_cleanup' },
      fingerprint: fingerprintHttpError(500, 'CHECKOUT_CLEANUP'),
    });
    return null;
  }
}

/**
 * Libera los locks de asientos vencidos que NO pertenecen a un intento
 * de compra (guest sessions y locks sueltos del wizard). Los asientos
 * con `checkout_attempt_id` se liberan EXCLUSIVAMENTE vía la RPC de
 * cleanup, que además cierra el intento en la misma transacción: aquí
 * se excluyen con `.is('checkout_attempt_id', null)` para que un fallo
 * del cleanup nunca deje un intento vivo sin sus locks.
 */
export async function releaseExpiredSeatLocks(): Promise<{ released: number }> {
  const { data, error } = await supabaseAdmin
    .from('seats')
    .update({
      status: 'available',
      locked_by: null,
      locked_at: null,
      lock_expires_at: null,
      guest_session_id: null,
    })
    .eq('status', 'locked')
    .lt('lock_expires_at', new Date().toISOString())
    .is('checkout_attempt_id', null)
    .select('id');

  if (error) {
    throw new Error(error.message);
  }
  const released = (data ?? []).length;
  if (released > 0) {
    console.log(`[LockCleanup] Released ${released} expired lock(s)`);
  }
  return { released };
}

/**
 * Un ciclo del loop periódico: PRIMERO cierra intentos vencidos (la RPC
 * libera sus locks propios de forma atómica) y DESPUÉS libera los locks
 * vencidos huérfanos. El orden importa: al revés, el release directo
 * podría poner 'available' un asiento de un intento aún no cerrado y el
 * trigger 087 borraría el vínculo sin cerrar la compra.
 */
export async function runPeriodicCheckoutCleanup(): Promise<{
  cleanup: CheckoutCleanupResult | null;
  released: number;
}> {
  const cleanup = await runCheckoutCleanup();
  const { released } = await releaseExpiredSeatLocks();
  return { cleanup, released };
}
