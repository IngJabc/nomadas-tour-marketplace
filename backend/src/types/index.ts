export type Role = 'customer' | 'superadmin';

export interface RequestContext {
  userId: string;
  role: Role;
  agencyId: string | null;
}

export interface User {
  id: string;
  email: string;
  role: Role;
}

/** Trip summary exposed on the public catalog (read-only). */
export interface PublicTrip {
  id: string;
  departure_time: string;
  capacity: number;
  vehicle_type: 'bus' | 'kia';
  status: string;
  route: {
    origin: string;
    destination: string;
  };
  price_cents: number | null;
  available_seats: number;
}

export interface Seat {
  id: string;
  trip_id: string;
  seat_code: string;
  status: 'available' | 'locked' | 'reserved' | 'blocked';
  locked_by: string | null;
  locked_at: string | null;
  lock_expires_at?: string | null;
  updated_at: string;
}

/** Marketplace reservation states (source='marketplace'). */
export interface MarketplaceReservation {
  id: string;
  trip_id: string;
  customer_id: string;
  source: 'internal' | 'marketplace';
  payment_status: 'pending' | 'partial' | 'fully_paid' | 'refunded' | 'cancelled';
  status: 'locked' | 'reserved' | 'cancelled' | 'completed';
  booker_name: string;
  contact_email: string;
  qr_code: string;
  created_at: string;
}

/** Payment proof (comprobante) submitted by the customer. */
export interface Payment {
  id: string;
  reservation_id: string;
  status: 'pending' | 'verified' | 'rejected';
  amount_cents: number;
  reference: string;
  proof_url: string | null;
  created_at: string;
}
