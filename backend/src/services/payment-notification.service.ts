import { supabaseAdmin } from '../config/database.js';
import { InternalError, ValidationError } from '../errors/index.js';

/**
 * PAY-NOTIFICATIONS Task 3 — adaptador de notificaciones de pago del
 * Marketplace hacia la tabla COMPARTIDA `notifications` (mismo proyecto
 * Supabase; la lee y renderiza Nómadas Tour en su campana de agencia).
 *
 * Contrato:
 *   - Tipo soportado por ahora: `payment_receipt_submitted` (ampliado por
 *     la migración de Tour `100_payment_notification_types.sql`).
 *   - `recipient_role` SIEMPRE 'agency' (la revisión vive en Tour,
 *     `/agency/payments`).
 *   - `agency_id` y `attempt_id` son contexto SERVER-SIDE confiable
 *     (leído del intento en `checkout_attempts`); este módulo jamás
 *     acepta datos provenientes del input del cliente.
 *   - Entidad: `reservation` SOLO si existe un `reservation_id` válido;
 *     si no, `trip` con el `trip_id` real del intento. Sin IDs
 *     inventados: si no hay ninguno, falla antes de insertar.
 *   - Sin datos sensibles: ni rutas de comprobantes, ni URLs firmadas,
 *     ni credenciales, ni montos/referencias de pago.
 *   - Copy específico (server-side): título `Pago recibido` y cuerpo
 *     `<booker> envió su pago para el viaje <Origen → Destino>`, con
 *     fallbacks cuando falta nombre o ruta. Solo el nombre del booker y
 *     la ruta del viaje viajan en el texto; jamás documento/teléfono.
 *   - Idempotencia: `source_event_id` + índice único
 *     (source_event_id, agency, role) → conflicto 23505 = duplicado.
 *
 * Conectado en Task 4: `submitCheckoutProof` (checkout.service) lo invoca
 * best-effort después de que la RPC registra el comprobante.
 */

export const PAYMENT_RECEIPT_SUBMITTED = 'payment_receipt_submitted';

export type PaymentNotificationStatus = 'inserted' | 'duplicate';

export interface PaymentReceiptSubmittedInput {
  /**
   * Contexto confiable server-side: `checkout_attempts.agency_id` tal como
   * se leyó en backend. NUNCA proviene del request del cliente.
   */
  agencyId: string;
  /** `checkout_attempts.id` — identifica la compra a revisar. */
  attemptId: string;
  /** Solo si el intento ya tiene reserva asociada (UUID real, opcional). */
  reservationId?: string | null;
  /** `checkout_attempts.trip_id` — referencia de respaldo de la entidad. */
  tripId?: string | null;
  /** Id del evento/outbox que originó la notificación (idempotencia). */
  sourceEventId?: string | null;
  /**
   * Nombre del booker (primer pasajero del snapshot server-side) para el
   * copy específico de la notificación. Opcional: sin él, el cuerpo usa
   * un fallback genérico. Solo el NOMBRE viaja aquí — nunca documento,
   * teléfono ni otros datos del pasajero.
   */
  bookerName?: string | null;
  /**
   * Ruta del viaje (`Origen → Destino`) resuelta server-side para el
   * copy específico. Opcional: sin ella, el cuerpo degrada sin ruta.
   */
  tripLabel?: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new ValidationError(`${field} es obligatorio y debe ser un UUID válido`);
  }
  return value;
}

function resolveEntity(input: PaymentReceiptSubmittedInput): {
  entity_type: 'reservation' | 'trip';
  entity_id: string;
} {
  // reservation SOLO con un ID real disponible.
  if (input.reservationId !== undefined && input.reservationId !== null) {
    if (!isUuid(input.reservationId)) {
      throw new ValidationError('reservation_id debe ser un UUID válido');
    }
    return { entity_type: 'reservation', entity_id: input.reservationId };
  }

  // Sin reserva: referencia schema-compatible con el viaje del intento.
  if (isUuid(input.tripId)) {
    return { entity_type: 'trip', entity_id: input.tripId };
  }

  // Nunca inventar un entity_id para satisfacer la columna NOT NULL.
  throw new ValidationError(
    'Se requiere un reservation_id o trip_id válidos para la entidad de la notificación',
  );
}

/**
 * Copy específico para la campana de Tours (mejora solicitada sobre el
 * texto genérico anterior):
 *
 *   - título: `Pago recibido`
 *   - cuerpo: `<booker> envió su pago para el viaje <Origen → Destino>`
 *
 * Fallbacks para que el copy NUNCA quede vacío ni genérico:
 *   - sin nombre de booker → `Un cliente`
 *   - sin ruta resoluble    → `…, pendiente de revisión`
 */
function buildReceiptCopy(input: PaymentReceiptSubmittedInput): {
  title: string;
  body: string;
} {
  const who = input.bookerName?.trim() || 'Un cliente';
  const trip = input.tripLabel?.trim();
  return {
    title: 'Pago recibido',
    body: trip
      ? `${who} envió su pago para el viaje ${trip}`
      : `${who} envió su pago, pendiente de revisión`,
  };
}

export async function notifyPaymentReceiptSubmitted(
  input: PaymentReceiptSubmittedInput,
): Promise<{ status: PaymentNotificationStatus }> {
  const agencyId = requireUuid(input.agencyId, 'agency_id');
  const attemptId = requireUuid(input.attemptId, 'attempt_id');
  const { entity_type, entity_id } = resolveEntity(input);

  if (
    input.sourceEventId !== undefined &&
    input.sourceEventId !== null &&
    !isUuid(input.sourceEventId)
  ) {
    throw new ValidationError('source_event_id debe ser un UUID válido');
  }

  const { title, body } = buildReceiptCopy(input);
  const row = {
    type: PAYMENT_RECEIPT_SUBMITTED,
    title,
    body,
    entity_type,
    entity_id,
    agency_id: agencyId,
    recipient_role: 'agency',
    // Ruta interna relativa (Tour la consume con router.push): sin host,
    // sin tokens y sin URLs firmadas.
    action_url: `/agency/payments/attempts/${attemptId}`,
    metadata: { attempt_id: attemptId },
    source_event_id: input.sourceEventId ?? null,
  };

  const { error } = await supabaseAdmin.from('notifications').insert(row);

  if (!error) {
    return { status: 'inserted' };
  }

  // Índice único (source_event_id, agency_id, recipient_role): la misma
  // evento ya produjo esta notificación → éxito idempotente, no es error.
  if ((error as { code?: string }).code === '23505') {
    return { status: 'duplicate' };
  }

  console.error('[PaymentNotification] insert falló', {
    type: PAYMENT_RECEIPT_SUBMITTED,
    agencyId,
    attemptId,
    entityType: entity_type,
    entityId: entity_id,
    error: error.message,
  });
  throw new InternalError('PAYMENT_NOTIFICATION_INSERT_ERROR', error.message);
}
