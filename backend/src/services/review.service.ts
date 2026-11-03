import { z } from 'zod';
import { supabaseAdmin } from '../config/database.js';
import { AppError, ValidationError } from '../errors/index.js';

// ── REV-001 · Reseñas de viaje y agencia ──────────────────────────────────────
//
// El backend es el ÚNICO que valida elegibilidad (dueno, reserva, viaje,
// ventana) antes de delegar en las RPC atómicas de la migración 099
// (submit_reservation_reviews / moderate_review) y en la de reconciliación
// de invitaciones de 098 (generate_review_requests). Ningún id, estado ni
// marca temporal llega del cliente: todo se deriva en el servidor.
//
// La ventana de reseñas (48 h) es una decisión de producto fija y vive
// AQUÍ y en el SQL (097/098/099) con el mismo valor; no es configurable
// para no requerir variables de entorno nuevas.

/** Ventana de reseñas: 48 h desde trips.completed_at (idéntica al SQL). */
export const REVIEW_WINDOW_HOURS = 48;

const uuidSchema = z.string().uuid();

export const submitReviewsSchema = z.object({
  trip_rating: z
    .number()
    .int('La calificación del viaje debe ser un número entero')
    .min(1, 'La calificación del viaje debe estar entre 1 y 5')
    .max(5, 'La calificación del viaje debe estar entre 1 y 5'),
  trip_comment: z
    .string()
    .trim()
    .max(2000, 'El comentario del viaje es demasiado largo')
    .nullable()
    .optional(),
  agency_rating: z
    .number()
    .int('La calificación de la agencia debe ser un número entero')
    .min(1, 'La calificación de la agencia debe estar entre 1 y 5')
    .max(5, 'La calificación de la agencia debe estar entre 1 y 5'),
  agency_comment: z
    .string()
    .trim()
    .max(2000, 'El comentario de la agencia es demasiado largo')
    .nullable()
    .optional(),
});

export type SubmitReviewsInput = z.infer<typeof submitReviewsSchema> & {
  reservationId: string;
  customerId: string;
};

export const adminModerateSchema = z.object({
  action: z.enum(['hide', 'reject', 'restore'], {
    message: 'La acción debe ser hide, reject o restore',
  }),
  reason: z.string().trim().max(500).nullable().optional(),
});

export type AdminModerateInput = z.infer<typeof adminModerateSchema> & {
  reviewType: 'trip_review' | 'agency_review';
  reviewId: string;
  actorUserId: string;
};

function reviewError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, statusCode, code);
}

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Datos de reseña inválidos', result.error.issues);
  }
  return result.data;
}

function rpcErrorCode(message: string): string | null {
  const match = /^(ERR_[A-Z_]+):\s*/.exec(message || '');
  return match ? match[1] : null;
}

interface RpcJson {
  data: Record<string, unknown> | null;
  error: { message: string } | null;
}

function callRpc(fn: string, args: Record<string, unknown>): PromiseLike<unknown> {
  return supabaseAdmin.rpc(fn, args) as unknown as PromiseLike<unknown>;
}

/**
 * Traduce los RAISE EXCEPTION de las RPC de reseñas (098/099) al envelope
 * estándar. Ownership responde 404 uniforme para no filtrar reservas ajenas.
 */
function mapReviewRpcError(error: { message: string }): AppError {
  const code = rpcErrorCode(error.message || '');

  switch (code) {
    case 'ERR_REVIEW_INPUT':
    case 'ERR_REVIEW_RATING':
    case 'ERR_REVIEW_COMMENT':
      return reviewError('Revisa la calificación y el comentario', 400, 'REVIEW_INPUT_INVALID');
    case 'ERR_REVIEW_RESERVATION_NOT_FOUND':
    case 'ERR_REVIEW_NOT_OWNER':
      // Mismo 404 para "no existe" y "es de otro cliente".
      return reviewError('Reserva no encontrada', 404, 'REVIEW_RESERVATION_NOT_FOUND');
    case 'ERR_REVIEW_NOT_ELIGIBLE':
      return reviewError(
        'Esta reserva no puede ser reseñada',
        409,
        'REVIEW_NOT_ELIGIBLE',
      );
    case 'ERR_REVIEW_TRIP_NOT_FOUND':
      return reviewError('Viaje no encontrado', 404, 'REVIEW_TRIP_NOT_FOUND');
    case 'ERR_REVIEW_TRIP_NOT_COMPLETED':
      return reviewError(
        'Este viaje aún no ha finalizado',
        409,
        'REVIEW_TRIP_NOT_COMPLETED',
      );
    case 'ERR_REVIEW_NO_COMPLETION_TIMESTAMP':
      return reviewError(
        'Este viaje no tiene una fecha de finalización registrada',
        409,
        'REVIEW_NO_COMPLETION_TIMESTAMP',
      );
    case 'ERR_REVIEW_WINDOW_EXPIRED':
    case 'ERR_REVIEW_INVITATION_EXPIRED':
      return reviewError(
        'El plazo para calificar este viaje venció',
        410,
        'REVIEW_WINDOW_EXPIRED',
      );
    case 'ERR_REVIEW_TYPE':
    case 'ERR_REVIEW_ACTION':
      return reviewError('Acción de moderación inválida', 400, 'REVIEW_MODERATION_INVALID');
    case 'ERR_REVIEW_ADMIN_NOT_FOUND':
    case 'ERR_REVIEW_ADMIN_ROLE':
      return reviewError(
        'Se requiere una cuenta de superadmin para moderar',
        403,
        'REVIEW_ADMIN_REQUIRED',
      );
    case 'ERR_REVIEW_NOT_FOUND':
      return reviewError('Reseña no encontrada', 404, 'REVIEW_NOT_FOUND');
    default:
      return reviewError(
        'No se pudo procesar la reseña. Intenta de nuevo',
        500,
        'REVIEW_ERROR',
      );
  }
}

// ── DTOs ──────────────────────────────────────────────────────────────────────

export interface ReviewDto {
  id: string;
  rating: number;
  comment: string | null;
  moderation_status: 'visible' | 'hidden' | 'rejected';
  created_at: string;
}

export type ReviewItemState = 'pending' | 'submitted' | 'expired';

export interface ReviewItemDto {
  reservation_id: string;
  state: ReviewItemState;
  trip: {
    id: string;
    origin: string | null;
    destination: string | null;
    departure_time: string | null;
    completed_at: string | null;
  };
  agency: { id: string; name: string | null };
  /** Marca límite real = trips.completed_at + 48 h. Solo si el viaje terminó. */
  expires_at: string | null;
  window_expired: boolean;
  trip_review: ReviewDto | null;
  agency_review: ReviewDto | null;
  created_at: string;
}

export interface ReviewContextDto {
  reservation_id: string;
  trip: {
    id: string;
    origin: string | null;
    destination: string | null;
    departure_time: string | null;
    completed_at: string | null;
  };
  agency: { id: string; name: string | null };
  eligible: boolean;
  state: ReviewItemState;
  expires_at: string | null;
  window_expired: boolean;
  trip_review: ReviewDto | null;
  agency_review: ReviewDto | null;
  /** Motivo por el que no está elegible (cuando eligible=false). */
  reason: string | null;
}

interface ReservationRow {
  id: string;
  trip_id: string;
  agency_id: string;
  status: string;
  created_at: string;
}

interface TripRow {
  id: string;
  route_id: string;
  status: string;
  departure_time: string;
  completed_at: string | null;
}

interface RouteRow {
  id: string;
  origin: string;
  destination: string;
}

interface AgencyRow {
  id: string;
  name: string;
}

function windowExpired(completedAt: string | null): boolean {
  if (!completedAt) return false;
  const deadline = new Date(completedAt).getTime() + REVIEW_WINDOW_HOURS * 3600 * 1000;
  return deadline <= Date.now();
}

/**
 * Estados de reserva elegibles para reseñar (espejo exacto de la lista
 * inclusiva de la RPC 099 / 098): todo salvo locked y cancelled.
 * Mismo criterio en la lectura (lista/contexto) y en la escritura (RPC).
 */
function isReservationStatusEligible(status: string): boolean {
  return status !== 'locked' && status !== 'cancelled';
}

function reviewDto(row: {
  id: string;
  rating: number;
  comment: string | null;
  moderation_status: string;
  created_at: string;
}): ReviewDto {
  return {
    id: row.id,
    rating: row.rating,
    comment: row.comment,
    moderation_status: row.moderation_status as ReviewDto['moderation_status'],
    created_at: row.created_at,
  };
}

// ── Carga compartida (reserva + viaje + ruta + agencia + reseñas) ─────────────

interface LoadedReviews {
  reservations: ReservationRow[];
  tripById: Map<string, TripRow>;
  routeById: Map<string, RouteRow>;
  agencyById: Map<string, AgencyRow>;
  tripReviewByReservation: Map<string, {
    id: string;
    rating: number;
    comment: string | null;
    moderation_status: string;
    created_at: string;
  }>;
  agencyReviewByReservation: Map<string, {
    id: string;
    rating: number;
    comment: string | null;
    moderation_status: string;
    created_at: string;
  }>;
}

async function loadCustomerReviewData(customerId: string): Promise<LoadedReviews> {
  const { data: reservations, error: resErr } = await supabaseAdmin
    .from('reservations')
    .select('id, trip_id, agency_id, status, created_at')
    .eq('customer_id', customerId)
    .eq('source', 'marketplace');

  if (resErr) throw reviewError('No pudimos cargar tus reseñas. Intenta de nuevo', 500, 'REVIEW_ERROR');

  const reservationRows = (reservations ?? []) as unknown as ReservationRow[];
  const reservationIds = reservationRows.map((r) => r.id);
  const tripIds = [...new Set(reservationRows.map((r) => r.trip_id))];
  const agencyIds = [...new Set(reservationRows.map((r) => r.agency_id))];

  const [tripsRes, agenciesRes, tripReviewsRes, agencyReviewsRes] = await Promise.all([
    tripIds.length > 0
      ? supabaseAdmin
          .from('trips')
          .select('id, route_id, status, departure_time, completed_at')
          .in('id', tripIds)
      : Promise.resolve({ data: [], error: null }),
    agencyIds.length > 0
      ? supabaseAdmin.from('agencies').select('id, name').in('id', agencyIds)
      : Promise.resolve({ data: [], error: null }),
    reservationIds.length > 0
      ? supabaseAdmin
          .from('trip_reviews')
          .select('id, reservation_id, rating, comment, moderation_status, created_at')
          .eq('customer_id', customerId)
          .in('reservation_id', reservationIds)
      : Promise.resolve({ data: [], error: null }),
    reservationIds.length > 0
      ? supabaseAdmin
          .from('agency_reviews')
          .select('id, reservation_id, rating, comment, moderation_status, created_at')
          .eq('customer_id', customerId)
          .in('reservation_id', reservationIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (tripsRes.error || agenciesRes.error || tripReviewsRes.error || agencyReviewsRes.error) {
    throw reviewError('No pudimos cargar tus reseñas. Intenta de nuevo', 500, 'REVIEW_ERROR');
  }

  const tripRows = (tripsRes.data ?? []) as unknown as TripRow[];
  const agencyRows = (agenciesRes.data ?? []) as unknown as AgencyRow[];

  const routeIds = [...new Set(tripRows.map((t) => t.route_id))];
  const routesRes =
    routeIds.length > 0
      ? await supabaseAdmin.from('routes').select('id, origin, destination').in('id', routeIds)
      : { data: [], error: null };
  if (routesRes.error) {
    throw reviewError('No pudimos cargar tus reseñas. Intenta de nuevo', 500, 'REVIEW_ERROR');
  }

  const tripReviewByReservation = new Map<
    string,
    { id: string; rating: number; comment: string | null; moderation_status: string; created_at: string }
  >();
  for (const row of (tripReviewsRes.data ?? []) as unknown as Array<{
    id: string;
    reservation_id: string;
    rating: number;
    comment: string | null;
    moderation_status: string;
    created_at: string;
  }>) {
    tripReviewByReservation.set(row.reservation_id, row);
  }

  const agencyReviewByReservation = new Map<
    string,
    { id: string; rating: number; comment: string | null; moderation_status: string; created_at: string }
  >();
  for (const row of (agencyReviewsRes.data ?? []) as unknown as Array<{
    id: string;
    reservation_id: string;
    rating: number;
    comment: string | null;
    moderation_status: string;
    created_at: string;
  }>) {
    agencyReviewByReservation.set(row.reservation_id, row);
  }

  return {
    reservations: reservationRows,
    tripById: new Map(tripRows.map((t) => [t.id, t])),
    routeById: new Map(
      ((routesRes.data ?? []) as unknown as RouteRow[]).map((r) => [r.id, r] as [string, RouteRow]),
    ),
    agencyById: new Map(agencyRows.map((a) => [a.id, a])),
    tripReviewByReservation,
    agencyReviewByReservation,
  };
}

function composeReviewItem(
  reservation: ReservationRow,
  loaded: LoadedReviews,
): ReviewItemDto | null {
  const trip = loaded.tripById.get(reservation.trip_id);
  if (!trip) return null;

  const route = loaded.routeById.get(trip.route_id) ?? null;
  const agency = loaded.agencyById.get(reservation.agency_id) ?? null;

  const tripReview = loaded.tripReviewByReservation.get(reservation.id) ?? null;
  const agencyReview = loaded.agencyReviewByReservation.get(reservation.id) ?? null;

  const hasReviews = tripReview !== null || agencyReview !== null;
  const tripCompleted = trip.status === 'completed';
  const expired = windowExpired(trip.completed_at);

  let state: ReviewItemState;
  if (hasReviews) {
    state = 'submitted';
  } else if (!isReservationStatusEligible(reservation.status)) {
    // locked/cancelled: excluidas por decision de producto (099 las
    // rechaza); no se promete un CTA que el backend negara.
    return null;
  } else if (!tripCompleted) {
    // El viaje aún no terminó: no hay nada que reseñar todavía; no se
    // muestra en la lista de reseñas (la compra sigue en Mis compras).
    return null;
  } else if (trip.completed_at === null) {
    // Viaje completado SIN marca de tiempo: la ventana 48 h no puede
    // existir (099 la rechaza con NO_COMPLETION_TIMESTAMP). Nunca
    // reseñable -> no se muestra como pendiente.
    return null;
  } else if (expired) {
    state = 'expired';
  } else {
    state = 'pending';
  }

  const expiresAt =
    trip.completed_at !== null
      ? new Date(new Date(trip.completed_at).getTime() + REVIEW_WINDOW_HOURS * 3600 * 1000).toISOString()
      : null;

  return {
    reservation_id: reservation.id,
    state,
    trip: {
      id: trip.id,
      origin: route?.origin ?? null,
      destination: route?.destination ?? null,
      departure_time: trip.departure_time,
      completed_at: trip.completed_at,
    },
    agency: { id: reservation.agency_id, name: agency?.name ?? null },
    expires_at: expiresAt,
    window_expired: expired,
    trip_review: tripReview ? reviewDto(tripReview) : null,
    agency_review: agencyReview ? reviewDto(agencyReview) : null,
    created_at: reservation.created_at,
  };
}

// ── 1) Lista de reseñas del cliente ──────────────────────────────────────────

/**
 * Reseñas e invitaciones del cliente autenticado. Identidad SIEMPRE del
 * servidor (customerId de req.ctx). Muestra las reservas marketplace cuyo
 * viaje ya terminó: pendientes (dentro de la ventana), enviadas y expiradas.
 */
export async function listCustomerReviews(customerId: string): Promise<{
  items: ReviewItemDto[];
}> {
  const loaded = await loadCustomerReviewData(customerId);

  const items: ReviewItemDto[] = [];
  for (const reservation of loaded.reservations) {
    const item = composeReviewItem(reservation, loaded);
    if (item) items.push(item);
  }

  // Orden: pendientes primero, luego enviadas, luego expiradas; dentro de
  // cada grupo, por fecha de salida descendente.
  const stateOrder: Record<ReviewItemState, number> = { pending: 0, submitted: 1, expired: 2 };
  items.sort((a, b) => {
    if (stateOrder[a.state] !== stateOrder[b.state]) {
      return stateOrder[a.state] - stateOrder[b.state];
    }
    const aDep = a.trip.departure_time ? new Date(a.trip.departure_time).getTime() : 0;
    const bDep = b.trip.departure_time ? new Date(b.trip.departure_time).getTime() : 0;
    return bDep - aDep;
  });

  return { items };
}

// ── 2) Contexto de una reseña (formulario) ───────────────────────────────────

/**
 * Contexto para el formulario de reseña de UNA reserva. Revalida
 * elegibilidad en el servidor (nunca se confía el estado del cliente).
 * Un 404 uniforme evita enumerar reservas ajenas.
 */
export async function getReviewContext(input: {
  reservationId: string;
  customerId: string;
}): Promise<ReviewContextDto> {
  const reservationId = parseOrThrow(uuidSchema, input.reservationId);

  const { data, error } = await supabaseAdmin
    .from('reservations')
    .select('id, trip_id, agency_id, status, created_at')
    .eq('id', reservationId)
    .eq('customer_id', input.customerId)
    .eq('source', 'marketplace')
    .maybeSingle();

  if (error) {
    throw reviewError('No pudimos cargar la reseña. Intenta de nuevo', 500, 'REVIEW_ERROR');
  }

  // Mismo 404 para inexistente, ajena o no-marketplace.
  if (!data) {
    throw reviewError('Reserva no encontrada', 404, 'REVIEW_RESERVATION_NOT_FOUND');
  }

  const reservation = data as unknown as ReservationRow;
  const loaded = await loadCustomerReviewData(input.customerId);

  // El contexto se construye SIEMPRE (incluso con el viaje sin completar):
  // el cliente dueño merece ver "aún no finaliza" en lugar de un 404. El
  // 404 uniforme se reserva para inexistente/ajena/no-marketplace (arriba).
  const trip = loaded.tripById.get(reservation.trip_id);
  if (!trip) {
    // FK garantiza la existencia; defensivo por si la lista acotó el lote.
    throw reviewError('Reserva no encontrada', 404, 'REVIEW_RESERVATION_NOT_FOUND');
  }

  const route = loaded.routeById.get(trip.route_id) ?? null;
  const agency = loaded.agencyById.get(reservation.agency_id) ?? null;
  const tripReview = loaded.tripReviewByReservation.get(reservation.id) ?? null;
  const agencyReview = loaded.agencyReviewByReservation.get(reservation.id) ?? null;

  const hasReviews = tripReview !== null || agencyReview !== null;
  const tripCompleted = trip.status === 'completed';
  const expired = windowExpired(trip.completed_at);
  const alreadySubmitted = hasReviews;
  const statusEligible = isReservationStatusEligible(reservation.status);
  const hasCompletion = trip.completed_at != null;
  const withinWindow = !expired;

  const state: ReviewItemState = alreadySubmitted
    ? 'submitted'
    : expired
      ? 'expired'
      : 'pending';

  const expiresAt =
    trip.completed_at !== null
      ? new Date(new Date(trip.completed_at).getTime() + REVIEW_WINDOW_HOURS * 3600 * 1000).toISOString()
      : null;

  const eligible =
    statusEligible && tripCompleted && hasCompletion && withinWindow && !alreadySubmitted;

  let reason: string | null = null;
  if (alreadySubmitted) reason = 'Ya enviaste la reseña de esta reserva';
  else if (!statusEligible) reason = 'Esta reserva ya no es reseñable';
  else if (!tripCompleted) reason = 'Este viaje aún no ha finalizado';
  else if (!hasCompletion) reason = 'Este viaje no tiene fecha de finalización registrada';
  else if (!withinWindow) reason = 'El plazo para calificar este viaje venció';

  return {
    reservation_id: reservation.id,
    trip: {
      id: trip.id,
      origin: route?.origin ?? null,
      destination: route?.destination ?? null,
      departure_time: trip.departure_time,
      completed_at: trip.completed_at,
    },
    agency: { id: reservation.agency_id, name: agency?.name ?? null },
    eligible,
    state,
    expires_at: expiresAt,
    window_expired: expired,
    trip_review: tripReview ? reviewDto(tripReview) : null,
    agency_review: agencyReview ? reviewDto(agencyReview) : null,
    reason,
  };
}

// ── 3) Envío atómico de las DOS reseñas ──────────────────────────────────────

export interface SubmitReviewsResult {
  reservation_id: string;
  already_submitted: boolean;
  trip_review_id: string | null;
  agency_review_id: string | null;
}

/**
 * Envía la reseña de viaje Y la de agencia JUNTAS en UNA transacción (RPC
 * 099). Identidad SIEMPRE del servidor. Idempotente por reserva: un reintento
 * devuelve `already_submitted` sin duplicar.
 */
export async function submitReviews(input: SubmitReviewsInput): Promise<SubmitReviewsResult> {
  const reservationId = parseOrThrow(uuidSchema, input.reservationId);
  const payload = parseOrThrow(submitReviewsSchema, input);

  const { data, error } = (await callRpc('submit_reservation_reviews', {
    p_reservation_id: reservationId,
    p_customer_id: input.customerId,
    p_trip_rating: payload.trip_rating,
    p_trip_comment: payload.trip_comment ?? null,
    p_agency_rating: payload.agency_rating,
    p_agency_comment: payload.agency_comment ?? null,
  })) as RpcJson;

  if (error) throw mapReviewRpcError(error);

  return {
    reservation_id: (data?.reservation_id as string) ?? reservationId,
    already_submitted: Boolean(data?.already_submitted),
    trip_review_id: (data?.trip_review_id as string) ?? null,
    agency_review_id: (data?.agency_review_id as string) ?? null,
  };
}

// ── 4) Reconciliación de invitaciones (worker periódico) ─────────────────────

/** Resultado de un ciclo de reconciliación de invitaciones (098). */
export interface ReviewReconciliationResult {
  created: number;
  expired: number;
  failed: number;
}

/**
 * Ejecuta la RPC de reconciliación idempotente (098). Cubre ambos paths de
 * completion (RPC y UPDATE directo del worker), eventos perdidos, caída del
 * Marketplace y reintentos. Nunca lanza: un fallo se loguea y devuelve null
 * para que el caller continúe (el próximo ciclo reintenta).
 *
 * `failed` cuenta reservas que la RPC omitió con error (detalle en el log
 * del servidor vía RAISE LOG); un valor alto indica fallo sistemático.
 */
export async function runReviewReconciliation(): Promise<ReviewReconciliationResult | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc('generate_review_requests');
    if (error) {
      console.error('[ReviewReconciliation] RPC error:', error.message);
      return null;
    }
    const result = (data ?? {}) as Partial<ReviewReconciliationResult>;
    const created = result.created ?? 0;
    const expired = result.expired ?? 0;
    const failed = result.failed ?? 0;
    if (created > 0 || expired > 0 || failed > 0) {
      console.log(
        `[ReviewReconciliation] Created ${created} invitation(s), expired ${expired}, failed ${failed}`,
      );
      if (failed > 0) {
        console.error(
          `[ReviewReconciliation] ${failed} reservation(s) failed during invitation generation; see server logs for SQLERRM detail`,
        );
      }
    }
    return { created, expired, failed };
  } catch (err) {
    console.error(
      '[ReviewReconciliation] Error:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ── 5) Notificaciones internas del cliente ───────────────────────────────────

export interface CustomerNotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  entity_type: string;
  entity_id: string;
  action_url: string | null;
  read_at: string | null;
  created_at: string;
}

export async function listCustomerNotifications(customerId: string): Promise<{
  items: CustomerNotificationDto[];
}> {
  const { data, error } = await supabaseAdmin
    .from('customer_notifications')
    .select(
      'id, type, title, body, entity_type, entity_id, action_url, read_at, created_at',
    )
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    throw reviewError('No pudimos cargar tus notificaciones. Intenta de nuevo', 500, 'REVIEW_ERROR');
  }

  return { items: (data ?? []) as unknown as CustomerNotificationDto[] };
}

export async function markNotificationRead(input: {
  notificationId: string;
  customerId: string;
}): Promise<{ ok: boolean }> {
  const notificationId = parseOrThrow(uuidSchema, input.notificationId);

  const { data, error } = await supabaseAdmin
    .from('customer_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('customer_id', input.customerId)
    .is('read_at', null)
    .select('id');

  if (error) {
    throw reviewError('No pudimos marcar la notificación. Intenta de nuevo', 500, 'REVIEW_ERROR');
  }

  return { ok: (data ?? []).length > 0 };
}

// ── 6) Moderación (superadmin) ───────────────────────────────────────────────

export interface AdminReviewItemDto {
  id: string;
  review_type: 'trip_review' | 'agency_review';
  reservation_id: string;
  trip_id: string;
  agency_id: string;
  customer_id: string;
  rating: number;
  comment: string | null;
  moderation_status: 'visible' | 'hidden' | 'rejected';
  moderated_by: string | null;
  moderated_at: string | null;
  moderation_reason: string | null;
  created_at: string;
}

/**
 * Listado de reseñas para el panel de moderación (superadmin). Une ambas
 * tablas y opcionalmente filtra por tipo, estado y agencia.
 *
 * Paginación global: cada tabla se pagina con `.range(0, offset+limit)`
 * (rango inclusive: trae offset+limit+1 filas de su propia tabla, que es
 * lo necesario para que el merge global cubra las primeras offset+limit
 * filas reales), se mezcla y se corta en el rango pedido. `has_more` se
 * calcula sobre el total global fusionado, no por tabla.
 */
export async function adminListReviews(filters: {
  reviewType?: 'trip_review' | 'agency_review';
  moderationStatus?: 'visible' | 'hidden' | 'rejected';
  agencyId?: string;
  limit: number;
  offset: number;
}): Promise<{ items: AdminReviewItemDto[]; has_more: boolean }> {
  const limit = Math.min(Math.max(filters.limit, 1), 50);
  const offset = Math.max(filters.offset, 0);

  const wantTrip = filters.reviewType !== 'agency_review';
  const wantAgency = filters.reviewType !== 'trip_review';

  const collect: AdminReviewItemDto[] = [];

  if (wantTrip) {
    let query = supabaseAdmin
      .from('trip_reviews')
      .select(
        'id, reservation_id, trip_id, customer_id, rating, comment, moderation_status, moderated_by, moderated_at, moderation_reason, created_at',
      );
    if (filters.moderationStatus) query = query.eq('moderation_status', filters.moderationStatus);
    if (filters.agencyId) {
      // trip_reviews no guarda agency_id; se filtra vía la reserva.
      const { data: rows, error: resErr } = await supabaseAdmin
        .from('reservations')
        .select('id')
        .eq('agency_id', filters.agencyId);
      if (resErr) {
        throw reviewError('No pudimos cargar las reseñas. Intenta de nuevo', 500, 'REVIEW_ERROR');
      }
      const ids = ((rows ?? []) as unknown as Array<{ id: string }>).map((r) => r.id);
      if (ids.length === 0) {
        // Sin reservas para la agencia: `.in(col, [])` no es un filtro
        // válido; el resultado es vacío por definición.
        return { items: [], has_more: false };
      }
      query = query.in('reservation_id', ids);
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .range(0, offset + limit);
    if (error) throw reviewError('No pudimos cargar las reseñas. Intenta de nuevo', 500, 'REVIEW_ERROR');
    for (const row of (data ?? []) as unknown as Array<Omit<AdminReviewItemDto, 'review_type' | 'agency_id'>>) {
      collect.push({ ...row, review_type: 'trip_review', agency_id: '' });
    }
  }

  if (wantAgency) {
    let query = supabaseAdmin
      .from('agency_reviews')
      .select(
        'id, reservation_id, agency_id, trip_id, customer_id, rating, comment, moderation_status, moderated_by, moderated_at, moderation_reason, created_at',
      );
    if (filters.moderationStatus) query = query.eq('moderation_status', filters.moderationStatus);
    if (filters.agencyId) query = query.eq('agency_id', filters.agencyId);
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .range(0, offset + limit);
    if (error) throw reviewError('No pudimos cargar las reseñas. Intenta de nuevo', 500, 'REVIEW_ERROR');
    for (const row of (data ?? []) as unknown as Array<Omit<AdminReviewItemDto, 'review_type'>>) {
      collect.push({ ...row, review_type: 'agency_review' });
    }
  }

  collect.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const hasMore = collect.length > offset + limit;
  const items = collect.slice(offset, offset + limit);

  return { items, has_more: hasMore };
}

/**
 * Moderación atómica + auditada (RPC 099). Solo superadmin (validado en la
 * RPC contra public.users). Preserva el contenido original.
 */
export async function adminModerateReview(input: AdminModerateInput): Promise<{
  review_id: string;
  review_type: string;
  moderation_status: string;
  moderated_at: string | null;
}> {
  const reviewId = parseOrThrow(uuidSchema, input.reviewId);
  const payload = parseOrThrow(adminModerateSchema, input);

  const { data, error } = (await callRpc('moderate_review', {
    p_review_type: input.reviewType,
    p_review_id: reviewId,
    p_action: payload.action,
    p_actor_user_id: input.actorUserId,
    p_reason: payload.reason ?? null,
  })) as RpcJson;

  if (error) throw mapReviewRpcError(error);

  // Fallback solo si la RPC no devuelve el status: mapea ACCIÓN →
  // ESTADO (hide→hidden, reject→rejected, restore→visible); nunca se
  // devuelve la acción cruda como si fuera un estado.
  const moderationStatusByAction: Record<string, string> = {
    hide: 'hidden',
    reject: 'rejected',
    restore: 'visible',
  };

  return {
    review_id: (data?.review_id as string) ?? reviewId,
    review_type: (data?.review_type as string) ?? input.reviewType,
    moderation_status:
      (data?.moderation_status as string) ?? moderationStatusByAction[payload.action],
    moderated_at: (data?.moderated_at as string) ?? null,
  };
}
