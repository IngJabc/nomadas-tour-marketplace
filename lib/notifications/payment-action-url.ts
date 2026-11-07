/**
 * PAY-NOTIFICATIONS Task 8E — validación de `action_url`.
 *
 * `action_url` viaja en una fila de `customer_notifications` escrita por el
 * backend (Tour) con service_role. El cliente NUNCA navega a una URL
 * arbitraria: solo se acepta la ruta interna EXACTA de la compra, con el
 * sufijo que corresponde al tipo de notificación:
 *
 *   - `payment_verified` → `/account/purchases/<attemptId>/ticket`
 *   - `payment_rejected` → `/account/purchases/<attemptId>/payment`
 *
 * Cualquier otra forma (externa, con esquema o host, con query/hash, otro
 * recurso, un intento que no sea UUID, o tipo/ruta cruzados) produce `null`
 * y el caller NO navega.
 *
 * Nota de entidad (Task 6): `entity_id` NO siempre es un attempt id
 * (`payment_verified` guarda el `reservation_id`; `payment_rejected` usa el
 * attempt id como workaround del CHECK de 098), por eso el intento se
 * asocia SIEMPRE por `action_url` y jamás por `entity_id`.
 */

export type PaymentActionType = 'payment_verified' | 'payment_rejected';

export interface PaymentActionTarget {
  /** Ruta interna validada (siempre relativa, sin query ni hash). */
  href: string;
  /** `checkout_attempts.id` embebido en la ruta. */
  attemptId: string;
  type: PaymentActionType;
}

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Sufijo esperado por tipo: la cruz de tipo/ruta invalida la URL. */
const EXPECTED_ROUTES: Record<PaymentActionType, 'ticket' | 'payment'> = {
  payment_verified: 'ticket',
  payment_rejected: 'payment',
};

const PURCHASE_ACTION_RE = new RegExp(
  `^/account/purchases/(${UUID_RE})/(ticket|payment)$`,
);

/**
 * Devuelve el destino interno validado o `null` si la URL no es navegable.
 * Acepta SOLO las dos rutas de compra esperadas para el tipo notificado.
 */
export function parsePaymentActionUrl(
  type: string | null | undefined,
  actionUrl: string | null | undefined,
): PaymentActionTarget | null {
  if (type !== 'payment_verified' && type !== 'payment_rejected') return null;
  if (typeof actionUrl !== 'string') return null;

  const match = PURCHASE_ACTION_RE.exec(actionUrl);
  if (!match) return null;

  const [, attemptId, route] = match;
  if (route !== EXPECTED_ROUTES[type]) return null;

  return {
    href: `/account/purchases/${attemptId}/${route}`,
    attemptId,
    type,
  };
}
