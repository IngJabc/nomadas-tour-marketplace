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

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
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

  const res = await fetch(url, { ...fetchOptions, headers });

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
  register: (payload: { email: string; password: string; full_name: string }) =>
    request<{ token: string; refresh_token: string; user: AppUser }>('/auth/register', {
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
