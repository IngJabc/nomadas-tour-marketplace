import type { AppUser } from '@/lib/auth/types';
import { ApiError } from '@/lib/errors/api-error';
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

  const data = await res.json();

  if (!res.ok) {
    const errorObj = data?.error;
    const code = errorObj?.code;
    const message = errorObj?.message || data?.error || 'API request failed';

    if (code === 'ACCOUNT_INACTIVE' && !path.startsWith('/auth/login')) {
      logoutInactiveAccount();
    }

    throw new ApiError(message, code || 'UNKNOWN', res.status);
  }

  return data;
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
}

export const publicApi = {
  trips: () => request<{ trips: PublicTrip[] }>('/public/trips'),
  tripDetail: (tripId: string) =>
    request<{ trip: PublicTripDetail }>(`/public/trips/${tripId}`),
  agencies: () => request<{ agencies: unknown[] }>('/public/agencies'),
};

export interface PublicTripOffer {
  agency_id: string;
  name: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
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
// pasajeros. `customer_id`, `status`, `source` y `unit_price` los decide el
// backend; `unit_price` es snapshot de `trips.seat_price` en el RPC.
export interface CreateReservationPassenger {
  seat_id: string;
  first_name: string;
  last_name: string;
  document: string;
  phone: string;
}

export interface CreateReservationPayload {
  trip_id: string;
  agency_id: string;
  seat_ids: string[];
  passengers: CreateReservationPassenger[];
}

export interface CreateReservationResult {
  reservation_id: string;
  trip_id: string;
  agency_id: string;
  customer_id: string;
  status: string;
  source: string;
  unit_price: number;
  passenger_count: number;
  seat_ids: string[];
  idempotent: boolean;
}

export const reservationApi = {
  create: (payload: CreateReservationPayload) =>
    request<CreateReservationResult>('/public/reservations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

// ── Comprobante de pago (MKT-005) ─────────────────────────────────────────
// El cliente aporta SOLO el archivo (`proof`) y la clave de idempotencia en
// el header. El monto, la moneda, el estado y la identidad del pagador los
// decide el backend; la respuesta nunca incluye `proof_url`.
export interface SubmitPaymentProofResult {
  payment_id: string;
  reservation_id: string;
  /** El backend solo crea pagos `pending`: la verificación es fase posterior. */
  payment_status: 'pending';
  reservation_status: string;
  amount_cents: number;
  currency: string;
  submitted_at: string;
  idempotent: boolean;
}

export const paymentApi = {
  submitProof: (reservationId: string, file: File, idempotencyKey: string) => {
    const form = new FormData();
    form.append('proof', file);
    return request<SubmitPaymentProofResult>(
      `/public/reservations/${encodeURIComponent(reservationId)}/payments`,
      {
        method: 'POST',
        body: form,
        headers: { 'Idempotency-Key': idempotencyKey },
      },
    );
  },
};

// ── Revisión de pagos de agencia (MKT-006 Fase 6.3C) ─────────────────────────
// El cliente consume los endpoints /admin/payments ya implementados en 6.3B.
// No recibe `proof_url` en el listado ni en el detalle; el comprobante se
// obtiene vía URL firmada de corta duración (máx. 300 s) que no se persiste.
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
  verify: (paymentId: string) =>
    request<VerifyPaymentResult>(
      `/admin/payments/${encodeURIComponent(paymentId)}/verify`,
      { method: 'POST' },
    ),
  reject: (paymentId: string, reason: string) =>
    request<RejectPaymentResult>(
      `/admin/payments/${encodeURIComponent(paymentId)}/reject`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
};
