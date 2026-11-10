import type { AppUser } from '@/lib/auth/types';
import {
  ApiError,
  PUBLIC_ERROR_MESSAGES,
  publicMessageForStatus,
} from '@/lib/errors/api-error';
import { logoutInactiveAccount } from '@/lib/auth/session-handler';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3003/api';

interface RequestOptions extends RequestInit {
  params?: Record<string, string | undefined>;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { params, ...fetchOptions } = options;

  let url = `${API_BASE}${path}`;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, val]) => {
      if (val) searchParams.set(key, val);
    });
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  // `Content-Type: application/json` solo aplica a payloads JSON. Con
  // `FormData` lo fija el navegador (boundary incluido); declararlo a mano
  // rompería el parser multipart del backend.
  const isFormData =
    typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData;

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(fetchOptions.headers as Record<string, string>),
  };

  // Include auth token from Supabase session if available
  try {
    const { createClient } = await import('./supabase/client');
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }
  } catch {
    // Ignore if running server-side without window
  }

  const res = await fetch(url, { credentials: 'include', ...fetchOptions, headers });

  if (res.status === 204) {
    return undefined as T;
  }

  // SEC-02: la respuesta puede no ser JSON (p. ej. una página de error de un
  // proxy/CDN). Nunca se propaga un error crudo de parsing.
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const rawError =
      data && typeof data === 'object' ? (data as Record<string, unknown>).error : undefined;
    const errorObj =
      rawError && typeof rawError === 'object'
        ? (rawError as Record<string, unknown>)
        : undefined;

    const code = typeof errorObj?.code === 'string' ? errorObj.code : 'UNKNOWN';
    // El backend garantiza mensajes públicos. Si la respuesta no trae un
    // envelope válido, se usa copy controlado por categoría de estado —
    // jamás texto crudo de una fuente no controlada.
    const message =
      typeof errorObj?.message === 'string' && errorObj.message
        ? errorObj.message
        : publicMessageForStatus(res.status);

    if (code === 'ACCOUNT_INACTIVE' && !path.startsWith('/auth/login')) {
      logoutInactiveAccount();
    }

    throw new ApiError(message, code, res.status);
  }

  return data as T;
}

// Auth (customer)
export const authApi = {
  login: (email: string, password: string) =>
    request<{ token: string; refresh_token: string; user: AppUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (payload: { email: string; password: string }) =>
    request<{
      token: string | null;
      refresh_token: string | null;
      user: AppUser;
    }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  me: () => request<{ user: AppUser }>('/auth/me'),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
};

// Public catalog
export interface PublicTrip {
  id: string;
  departure_time: string;
  capacity: number;
  vehicle_type: string;
  status: string;
  route: { origin: string; destination: string };
  seat_price: number | null;
  lock_ttl_seconds?: number;
  /**
   * Asientos REALMENTE libres del viaje (status='available'). El badge de
   * la tarjeta muestra la capacidad TOTAL; esta cifra alimenta la línea
   * de "asientos disponibles". Opcional para no romper respuestas
   * antiguas: los consumidores deben tratar la ausencia como 0
   * (`trip.available_seats ?? 0`). La capacidad TOTAL jamás sustituye la
   * disponibilidad: podría presentar un viaje agotado como disponible
   * (regresión LND-001.1).
   */
  available_seats?: number | null;
  /**
   * Agencias activas que operan este viaje (orden alfabético estable).
   * Opcional para no romper consumidores con respuestas antiguas; los
   * consumidores deben usar `trip.agencies ?? []`.
   */
  agencies?: PublicTripAgencyRef[];
}

/** Agencia activa resumida para el catálogo público (sin datos internos). */
export interface PublicTripAgencyRef {
  id: string;
  name: string;
}

// ── REP-001 · Directorio y perfil público de agencias ──────────────────────
//
// Solo datos públicos: identidad, branding, contactos públicos, viajes
// publicados y estadísticas. JAMÁS email de acceso, métodos de pago ni datos
// de clientes. Espejo de los DTOs de `backend/src/services/agency.service.ts`.

/** Promedio redondeado a 1 decimal; `null` cuando no hay reseñas. */
export interface AgencyRatingStat {
  average: number | null;
  count: number;
}

/**
 * Las dos calificaciones SIEMPRE separadas: no existe un promedio
 * combinado. `average: null` es válido (sin reseñas visibles, o tablas de
 * reseñas aún sin aplicar) y se presenta como "sin calificar", nunca como 0.
 */
export interface AgencyRatings {
  agency: AgencyRatingStat;
  trip: AgencyRatingStat;
}

/** Fila pública del directorio (`GET /api/public/agencies`). */
export interface PublicAgency {
  id: string;
  name: string;
  subdomain: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  /** El backend ya devuelve las destacadas primero: el orden NO se reordena. */
  is_featured: boolean;
  featured_order: number;
  ratings: AgencyRatings;
  /** Viajes reservables hoy (active + publicado + salida futura). */
  published_trips_count: number;
}

/** Perfil público (`GET /api/public/agencies/:agencyId`). */
export interface PublicAgencyProfile extends PublicAgency {
  /** Teléfono legado público de la agencia; fallback si no hay contactos. */
  phone: string | null;
  /** Phase 7 — presentación del storefront (solo en el perfil, no en el directorio). */
  cover_url: string | null;
  slogan: string | null;
  description: string | null;
  /** Solo contactos públicos, activos y no eliminados (091). */
  contacts: AgencyPublicContact[];
  /** Página de viajes según los filtros aplicados (filtrada en servidor). */
  trips: PublicTrip[];
  /** Total de viajes que matchean los filtros (no solo esta página). */
  trips_total: number;
}

export interface PublicAgencyListParams {
  limit?: number;
  offset?: number;
}

export interface PublicAgencyProfileParams {
  origin?: string;
  destination?: string;
  date?: string;
  limit?: number;
  offset?: number;
}

/**
 * Normaliza los parámetros de query: `request` solo acepta strings y omite
 * los vacíos, así un filtro sin texto viaja como "sin filtro".
 */
function toSearchParams(
  params: Record<string, string | number | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

export const publicApi = {
  trips: () => request<{ trips: PublicTrip[] }>('/public/trips'),
  tripDetail: (tripId: string) =>
    request<{ trip: PublicTripDetail }>(`/public/trips/${tripId}`),
  /**
   * Directorio público paginado. El orden (destacadas primero, luego orden
   * de exhibición y alfabético) lo decide el backend: jamás se reordena aquí.
   */
  agencies: (params: PublicAgencyListParams = {}) =>
    request<{ agencies: PublicAgency[]; total: number }>('/public/agencies', {
      params: toSearchParams({ limit: params.limit, offset: params.offset }),
    }),
  /** Perfil público con su página de viajes filtrada en el servidor. */
  agencyDetail: (agencyId: string, params: PublicAgencyProfileParams = {}) =>
    request<{ agency: PublicAgencyProfile }>(`/public/agencies/${agencyId}`, {
      params: toSearchParams({
        origin: params.origin,
        destination: params.destination,
        date: params.date,
        limit: params.limit,
        offset: params.offset,
      }),
    }),
};

// ── MKT-008 · Contactos públicos de agencia (091 agency_contacts) ────────────

export type AgencyContactChannel = 'call' | 'whatsapp';

/**
 * Contacto público de agencia. `phone` viene en E.164 desde la base de
 * datos (CHECK de la migración 091): nunca se le antepone código país.
 */
export interface AgencyPublicContact {
  id: string;
  label: string;
  phone: string;
  channel: AgencyContactChannel;
}

export interface PublicTripOffer {
  agency_id: string;
  name: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  /** MKT-007.4: teléfono público de la agencia (aviso WhatsApp). */
  phone: string | null;
  /** MKT-007.4: la agencia tiene al menos un canal de pago activo. */
  payment_methods_available: boolean;
  /**
   * MKT-008: contactos públicos de la agencia (is_public + is_active +
   * no eliminados), ordenados por sort_order y created_at. Opcional para
   * compatibilidad con respuestas antiguas; los consumidores deben usar
   * `contacts ?? []`.
   */
  contacts?: AgencyPublicContact[];
}

export type PublicSeatStatus =
  | 'available'
  | 'reserved'
  | 'locked'
  | 'blocked'
  | 'guide';

export interface PublicTripSeat {
  id: string;
  seat_code: string;
  status: PublicSeatStatus;
}

export interface PublicTripAvailability {
  total: number;
  available: number;
  reserved: number;
  locked: number;
  blocked: number;
  guide: number;
}

export interface PublicTripDetail {
  id: string;
  departure_time: string;
  capacity: number;
  vehicle_type: 'bus' | 'kia';
  status: string;
  route: { origin: string; destination: string };
  seat_price: number | null;
  installment_allowed: boolean;
  installment_amount_cents: number | null;
  lock_ttl_seconds: number;
  offers: PublicTripOffer[];
  seats: PublicTripSeat[];
  availability: PublicTripAvailability;
}

// Seat locks (MKT-004) — el TTL lo decide el servidor; el cliente nunca envía
// `ttl_seconds`. El countdown se deriva siempre de `lock_expires_at`.
export interface LockedSeatInfo {
  id: string;
  seat_code: string;
  status?: 'locked';
  locked_by?: string | null;
  lock_expires_at?: string | null;
}

export interface LockSeatsResult {
  locked: true;
  trip_id: string;
  ttl_seconds: number;
  lock_expires_at: string;
  seats: LockedSeatInfo[];
}

export interface MySeatLocksResult {
  trip_id: string;
  lock_expires_at: string | null;
  seats: Array<{ id: string; seat_code: string; lock_expires_at: string }>;
}

// Guest session metadata devuelta por los endpoints guest. Informativa: la
// autoridad sigue siendo el backend; el navegador solo recibe la cookie
// HttpOnly (Path=/api/public/seats) que nunca es legible desde JavaScript.
export interface GuestSessionInfo {
  trip_id: string;
  status: string;
  expires_at: string;
}

export interface GuestLockSeatsResult extends LockSeatsResult {
  guest_session: GuestSessionInfo;
}

export interface GuestLocksResult extends MySeatLocksResult {
  guest_session: GuestSessionInfo;
}

export interface ClaimGuestSeat {
  id: string;
  seat_code: string;
  lock_expires_at: string;
}

export interface ClaimGuestLocksResult {
  claimed: true;
  trip_id: string;
  seats: ClaimGuestSeat[];
  lock_expires_at: string | null;
  guest_session: GuestSessionInfo;
}

export const seatApi = {
  lockSeats: (tripId: string, seatIds: string[]) =>
    request<LockSeatsResult>('/public/seats/lock', {
      method: 'POST',
      body: JSON.stringify({ trip_id: tripId, seat_ids: seatIds }),
    }),
  unlockSeats: (tripId: string, seatIds?: string[], init?: RequestInit) =>
    request<{ unlocked: number }>('/public/seats/unlock', {
      method: 'POST',
      body: JSON.stringify(
        seatIds && seatIds.length > 0
          ? { trip_id: tripId, seat_ids: seatIds }
          : { trip_id: tripId },
      ),
      ...init,
    }),
  mySeatLocks: (tripId: string) =>
    request<MySeatLocksResult>('/public/seats/locks', {
      params: { trip_id: tripId },
    }),
  // ── Guest lock ownership (Fase 4) ────────────────────────────────────
  // El navegador solo maneja la cookie HttpOnly: nunca enviamos token,
  // hash, guest_session_id, customer_id ni TTL como autoridad.
  lockGuestSeats: (tripId: string, seatIds: string[]) =>
    request<GuestLockSeatsResult>('/public/seats/lock-guest', {
      method: 'POST',
      body: JSON.stringify({ trip_id: tripId, seat_ids: seatIds }),
    }),
  getGuestLocks: (tripId: string) =>
    request<GuestLocksResult>('/public/seats/guest-locks', {
      params: { trip_id: tripId },
    }),
  unlockGuestSeats: (tripId: string, seatIds?: string[], init?: RequestInit) =>
    request<{ unlocked: number; remaining?: number }>(
      '/public/seats/unlock-guest',
      {
        method: 'POST',
        body: JSON.stringify(
          seatIds && seatIds.length > 0
            ? { trip_id: tripId, seat_ids: seatIds }
            : { trip_id: tripId },
        ),
        ...init,
      },
    ),
  claimGuestLocks: (tripId: string) =>
    request<ClaimGuestLocksResult>('/public/seats/claim-guest', {
      method: 'POST',
      body: JSON.stringify({ trip_id: tripId }),
    }),
};

// ── Reserva marketplace (MKT-004 Fase B) ───────────────────────────────────
// El cliente aporta SOLO trip, oferta de agencia seleccionada, asientos y
// ── Checkout con revisión de comprobante (MKT-007) ──────────────────────────
// Antes de MKT-007 la reserva y el pago nacían ANTES de que una agencia
// revisara el comprobante. Ahora la compra nace como `checkout_attempts`
// y la reserva definitiva, sus pasajeros y el pago verificado solo nacen
// cuando la agencia aprueba (verify_checkout_attempt, RPC 087).
//
// El cliente aporta asientos y pasajeros; `customer_id`, `agency_id`,
// `unit_price`, `amount_cents`, `status` y `expires_at` los decide el
// backend. En el envío del comprobante el cliente aporta SOLO el archivo
// y los tres datos de conciliación.
export interface CheckoutPassenger {
  seat_id: string;
  first_name: string;
  last_name: string;
  document: string;
  phone: string;
}

export interface CreateCheckoutAttemptPayload {
  trip_id: string;
  agency_id: string;
  seat_ids: string[];
  passengers: CheckoutPassenger[];
}

export type CheckoutAttemptStatus =
  | 'created'
  | 'pending_review'
  | 'rejected'
  | 'verified'
  | 'rejected_final'
  | 'expired'
  | 'cancelled';

export interface CreateCheckoutAttemptResult {
  attempt_id: string;
  trip_id: string;
  agency_id: string;
  customer_id: string;
  status: CheckoutAttemptStatus;
  seat_ids: string[];
  passenger_count: number;
  unit_price: number;
  amount_cents: number;
  proof_count: number;
  /** Ventana de revisión. El servidor la calcula; el cliente solo la lee. */
  expires_at: string;
  idempotent: boolean;
}

export interface SubmitCheckoutProofPayload {
  payment_reference: string;
  bank_origin: string;
  payment_datetime: string;
}

export interface SubmitCheckoutProofResult {
  attempt_id: string;
  status: 'pending_review';
  proof_count: number;
  remaining_submissions: number;
  proof_path: string;
  payment_reference: string;
  bank_origin: string;
  payment_datetime: string;
  amount_cents: number;
  /** Nueva ventana (now + 24 h): también prolonga los locks de los asientos. */
  expires_at: string;
  idempotent: boolean;
}

export interface CancelCheckoutAttemptResult {
  attempt_id: string;
  // MKT-010: 'expired' cuando la ventana ya había vencido y el cleanup
  // liberó los asientos — la cancelación se confirma como cierre logrado.
  status: 'cancelled' | 'expired';
  already_cancelled: boolean;
  freed_seats: number;
}

export const checkoutApi = {
  createAttempt: (payload: CreateCheckoutAttemptPayload, idempotencyKey: string) =>
    request<CreateCheckoutAttemptResult>('/public/checkout/attempts', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  submitProof: (
    attemptId: string,
    file: File,
    reconciliation: SubmitCheckoutProofPayload,
    idempotencyKey: string,
  ) => {
    const form = new FormData();
    form.append('proof', file);
    form.append('payment_reference', reconciliation.payment_reference);
    form.append('bank_origin', reconciliation.bank_origin);
    form.append('payment_datetime', reconciliation.payment_datetime);
    return request<SubmitCheckoutProofResult>(
      `/public/checkout/attempts/${encodeURIComponent(attemptId)}/proof`,
      {
        method: 'POST',
        body: form,
        headers: { 'Idempotency-Key': idempotencyKey },
      },
    );
  },

  getAttempt: (attemptId: string) =>
    request<CheckoutAttemptView>(
      `/public/checkout/attempts/${encodeURIComponent(attemptId)}`,
    ),

  cancelAttempt: (attemptId: string) =>
    request<CancelCheckoutAttemptResult>(
      `/public/checkout/attempts/${encodeURIComponent(attemptId)}/cancel`,
      { method: 'POST' },
    ),

  // — MKT-007.4 · Canales de pago del intento —
  getPaymentMethods: (attemptId: string) =>
    request<CheckoutPaymentMethodsView>(
      `/public/checkout/attempts/${encodeURIComponent(attemptId)}/payment-methods`,
    ),

  selectPaymentMethod: (attemptId: string, paymentMethodId: string) =>
    request<SelectCheckoutPaymentMethodResult>(
      `/public/checkout/attempts/${encodeURIComponent(attemptId)}/payment-method`,
      {
        method: 'PATCH',
        body: JSON.stringify({ payment_method_id: paymentMethodId }),
      },
    ),

  // — RT-01/RT-02 · Historial de compras del cliente —
  // Colección paginada de LOS intentos del cliente autenticado. El backend
  // filtra por el customer_id de la sesión: aquí solo se envían limit/offset.
  listPurchases: (limit: number, offset: number) =>
    request<PurchaseHistoryView>('/public/checkout/attempts', {
      params: { limit: String(limit), offset: String(offset) },
    }),

  // — RT-03 · Boleto QR de una compra —
  // El backend deriva el cliente de la sesión y comprueba la aprobación
  // completa (intento verificado + reserva nacida en verify). Un 404
  // uniforme (TICKET_NOT_FOUND) significa que la compra no es elegible para
  // boleto: no distingue entre inexistente, ajena o sin reserva. El
  // `qr_code` es el valor EXACTO generado por Tour; no se inventa aquí.
  getTicket: (attemptId: string) =>
    request<CheckoutTicketView>(
      `/public/checkout/attempts/${encodeURIComponent(attemptId)}/ticket`,
    ),
};

// ── MKT-007.4 · Canales de pago (pago móvil) ────────────────────────────────

/** Datos de un canal pago_movil. Solo lectura para el cliente. */
export interface CheckoutPagoMovilData {
  bank_code: string;
  bank_name: string;
  phone: string;
  document_type: string;
  document_number: string;
  holder_name: string;
  account_type?: string;
  account_number?: string;
}

export interface CheckoutPaymentMethodDto {
  id: string;
  method: string;
  label: string;
  data: CheckoutPagoMovilData;
  is_primary: boolean;
  sort_order: number;
}

export interface CheckoutPaymentMethodsView {
  attempt_id: string;
  status: string;
  amount_cents: number;
  selected_method_id: string | null;
  methods: CheckoutPaymentMethodDto[];
  /** Teléfono público de la agencia para el aviso de WhatsApp. */
  agency_phone: string | null;
  /**
   * MKT-008: contactos públicos de la agencia (E.164). Opcional para
   * compatibilidad con respuestas antiguas; usar `contacts ?? []`.
   */
  contacts?: AgencyPublicContact[];
}

export interface SelectCheckoutPaymentMethodResult {
  attempt_id: string;
  status: string;
  amount_cents: number;
  payment_method_id: string;
  payment_method_snapshot: Record<string, unknown>;
  idempotent: boolean;
}

/** Estado del intento para su dueño. Nunca incluye la ruta del archivo. */
export interface CheckoutAttemptView {
  attempt_id: string;
  status: CheckoutAttemptStatus;
  trip_id: string;
  agency_id: string;
  seat_ids: string[];
  seat_codes: string[];
  passenger_count: number;
  /**
   * Pasajeros declarados en la creación del intento (jsonb del backend).
   * Opaco aquí: el consumidor valida forma en runtime y nunca debe
   * renderizar `phone` (dato sensible sin necesidad en pantalla).
   */
  passenger_data: unknown;
  unit_price: number;
  amount_cents: number;
  proof_count: number;
  remaining_submissions: number;
  payment_reference: string | null;
  bank_origin: string | null;
  payment_datetime: string | null;
  proof_submitted_at: string | null;
  review_started_at: string | null;
  rejection_reason: string | null;
  rejection_count: number;
  expires_at: string;
  created_at: string;
  closed_at: string | null;
  verified_at: string | null;
}

// ── RT-01/RT-02 · Historial de compras (DTO de GET /public/checkout/attempts) ──
// Espejo del DTO del backend (checkout.service.ts): el campo `estado` es el
// estado derivado listo para UI; `status` conserva el valor crudo de la DB.

export type PurchaseEstado =
  | 'pendiente_comprobante'
  | 'en_revision'
  | 'rechazado'
  | 'rechazado_final'
  | 'aprobado'
  | 'reserva_confirmada'
  | 'expirado'
  | 'cancelado'
  | 'desconocido';

export type PurchaseAccion =
  | 'enviar_comprobante'
  | 'reenviar_comprobante'
  | 'ver_reserva'
  | 'ninguna';

export interface PurchaseComprobanteDto {
  envios: number;
  restantes: number;
  referencia: string | null;
  banco: string | null;
  fecha_pago: string | null;
  enviado_en: string | null;
  rechazos: number;
  motivo_rechazo: string | null;
}

export interface PurchasePagoDto {
  id: string;
  estado: 'pendiente' | 'aprobado' | 'rechazado';
  amount_cents: number;
  currency: string;
  aprobado_en: string | null;
}

export interface PurchaseReservaDto {
  id: string;
  status: string;
  payment_status: string | null;
  ticket_code: string | null;
  created_at: string;
}

export interface PurchaseItemDto {
  attempt_id: string;
  /** Status crudo de checkout_attempts, sin reinterpretar. */
  status: string;
  estado: PurchaseEstado;
  mensaje: string;
  accion: PurchaseAccion;
  puede_reenviar_comprobante: boolean;
  trip: {
    id: string;
    origin: string | null;
    destination: string | null;
    departure_time: string | null;
  };
  agency: { id: string; name: string | null };
  pasajeros: {
    total: number;
    asientos: string[];
    /** Nombre y documento del propio cliente; sin teléfono ni datos crudos. */
    detalle: Array<{ asiento: string; nombre: string; documento: string }>;
  };
  monto: { unit_price: number; amount_cents: number };
  comprobante: PurchaseComprobanteDto | null;
  pago: PurchasePagoDto | null;
  reserva: PurchaseReservaDto | null;
  ventana: { expires_at: string; vencida: boolean };
  created_at: string;
  closed_at: string | null;
  verified_at: string | null;
}

/** Respuesta real del endpoint: SIN total_returned ni total de registros. */
export interface PurchaseHistoryView {
  items: PurchaseItemDto[];
  limit: number;
  offset: number;
  has_more: boolean;
}

// ── RT-03 · Boleto QR de una compra (DTO de
// GET /public/checkout/attempts/:attemptId/ticket) ──
// El backend solo responde 200 cuando la compra es elegible (intento
// verificado + reserva nacida en verify con aprobación completa). El
// `qr_code` es el valor EXACTO generado por Tour en 087; jamás se inventa.

export interface CheckoutTicketPaxDto {
  asiento: string;
  nombre: string;
  boarded?: boolean;
}

export interface CheckoutTicketTripDto {
  origin: string | null;
  destination: string | null;
  departure_time: string | null;
  status?: string | null;
}

export interface CheckoutTicketView {
  attempt_id: string;
  estado: 'reserva_confirmada';
  /** Valor crudo del QR escaneable, generado por Tour. */
  qr_code: string;
  /** CHAR(8) derivado del UUID de la reserva por Tour. */
  ticket_code: string;
  reservation_id: string;
  reservation_status?: string;
  reservation_created_at: string;
  amount_cents: number;
  currency: string;
  paid_at: string | null;
  agency: { id: string; name: string | null };
  trip: CheckoutTicketTripDto;
  seats: string[];
  /** Nombre + asiento del propio cliente y estado de abordaje. */
  passengers: CheckoutTicketPaxDto[];
  is_trip_completed?: boolean;
  is_boarding_completed?: boolean;
}

// ── Revisión de pagos de agencia — OBSOLETO desde MKT-007 ───────────────────
// MKT-007 centraliza la revisión de comprobantes en Tour (/agency/payments).
// Marketplace ya no expone acciones administrativas de revisión (verify/reject):
// los endpoints /admin/payments responden 410 Gone. Se conservan los tipos
// solo para compatibilidad con tests legacy.
export type AgencyPaymentStatusFilter = 'pending' | 'verified' | 'rejected';

export interface AgencyPaymentListItem {
  id: string;
  status: string;
  amount_cents: number;
  currency: string;
  submitted_at: string;
  verified_at: string | null;
  rejection_reason: string | null;
  has_proof: boolean;
  reservation: {
    id: string;
    booker_name: string;
    contact_email: string | null;
    status: string;
    payment_status: string | null;
    trip: {
      id: string;
      departure_time: string;
      origin: string;
      destination: string;
    } | null;
  };
}

export interface ListAgencyPaymentsResult {
  payments: AgencyPaymentListItem[];
  page: number;
  limit: number;
  total: number;
}

export interface AgencyPaymentPassenger {
  id: string;
  seat_code: string | null;
  name: string;
  unit_price: number | null;
  status: string;
}

export interface AgencyPaymentAllocation {
  id: string;
  reservation_passenger_id: string;
  seat_code: string | null;
  amount_cents: number;
  created_at: string;
}

export interface AgencyPaymentDetail {
  payment: {
    id: string;
    status: string;
    amount_cents: number;
    currency: string;
    submitted_at: string;
    verified_at: string | null;
    verified_by: string | null;
    rejection_reason: string | null;
    has_proof: boolean;
  };
  reservation: {
    id: string;
    booker_name: string;
    booker_phone: string | null;
    contact_email: string | null;
    status: string;
    payment_status: string | null;
    created_at: string;
  };
  trip: {
    id: string;
    departure_time: string;
    vehicle_type: string;
    seat_price: number | null;
    origin: string;
    destination: string;
  } | null;
  passengers: AgencyPaymentPassenger[];
  allocations: AgencyPaymentAllocation[];
  totals: {
    active_passenger_count: number;
    expected_cents: number;
    allocated_cents: number;
    remaining_cents: number;
  };
}

export interface PaymentProofSignedUrlResult {
  url: string;
  expires_in_seconds: number;
}

export interface VerifyPaymentResult {
  payment_id: string;
  reservation_id: string;
  status: string;
  already_verified: boolean;
  amount_cents: number;
  currency: string;
  allocation_count: number;
  total_expected_cents: number;
  verified_at: string;
  verified_by: string;
  payment_status: string;
  audit_id: string;
}

export interface RejectPaymentResult {
  payment_id: string;
  reservation_id: string;
  status: string;
  already_rejected: boolean;
  rejection_reason: string;
  outcome: string;
  cancelled_reservation: boolean;
  reservation_status: string;
  payment_status: string;
  freed_seat_count: number;
  cancelled_passenger_count: number;
  refund_required: boolean;
  refund_amount_cents: number;
  payment_audit_id: string;
  reservation_audit_id: string | null;
}

export const agencyPaymentApi = {
  list: (params: {
    status?: AgencyPaymentStatusFilter;
    page?: number;
    limit?: number;
  }) =>
    request<ListAgencyPaymentsResult>('/admin/payments', {
      params: {
        status: params.status,
        page: params.page != null ? String(params.page) : undefined,
        limit: params.limit != null ? String(params.limit) : undefined,
      },
    }),
  detail: (paymentId: string) =>
    request<AgencyPaymentDetail>(
      `/admin/payments/${encodeURIComponent(paymentId)}`,
    ),
  proofUrl: (paymentId: string) =>
    request<PaymentProofSignedUrlResult>(
      `/admin/payments/${encodeURIComponent(paymentId)}/proof`,
    ),
  // MKT-007: verify/reject eliminados. La revisión vive en Tour.
};

// ── REV-001 · Reseñas de viaje y agencia (cliente) ─────────────────────────────
// DTOs espejo de backend/src/services/review.service.ts. La ventana de
// 48 h se calcula en el servidor (trips.completed_at + 48 h); el cliente
// solo la muestra. La URL /account/reviews/[id] NO autoriza: la
// elegibilidad se revalida en el backend en cada GET y en el envío.

export type ReviewItemState = 'pending' | 'submitted' | 'expired';

export interface ReviewDto {
  id: string;
  rating: number;
  comment: string | null;
  moderation_status: 'visible' | 'hidden' | 'rejected';
  created_at: string;
}

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
  /** Límite real = trips.completed_at + 48 h. Solo si el viaje terminó. */
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

export interface SubmitReviewsPayload {
  trip_rating: number;
  trip_comment?: string | null;
  agency_rating: number;
  agency_comment?: string | null;
}

export interface SubmitReviewsResult {
  reservation_id: string;
  already_submitted: boolean;
  trip_review_id: string | null;
  agency_review_id: string | null;
}

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

export const reviewsApi = {
  /** Lista de reseñas/invitaciones del cliente (pendientes, enviadas, expiradas). */
  list: () => request<{ items: ReviewItemDto[] }>('/public/reviews'),

  /** Contexto del formulario de reseña de UNA reserva (revalida elegibilidad). */
  getContext: (reservationId: string) =>
    request<ReviewContextDto>(
      `/public/reviews/reservations/${encodeURIComponent(reservationId)}`,
    ),

  /** Envío ATÓMICO de las DOS reseñas (viaje + agencia) en UNA transacción. */
  submit: (reservationId: string, payload: SubmitReviewsPayload) =>
    request<SubmitReviewsResult>(
      `/public/reviews/reservations/${encodeURIComponent(reservationId)}`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  /** Notificaciones internas del cliente (aviso de reseña pendiente). */
  notifications: () =>
    request<{ items: CustomerNotificationDto[] }>('/public/reviews/notifications'),

  /** Marca una notificación como leída (solo la del cliente autenticado). */
  markNotificationRead: (notificationId: string) =>
    request<{ ok: boolean }>(
      `/public/reviews/notifications/${encodeURIComponent(notificationId)}/read`,
      { method: 'PATCH' },
    ),
};
