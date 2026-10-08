import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(
  testDirectory,
  '..',
  '..',
  '..',
  '..',
  '..',
  'nomadas-tour',
  'supabase',
  'migrations',
);
const migrationFilename = '081_create_marketplace_reservation.sql';
const migrationPath = join(migrationsDirectory, migrationFilename);

function readMigration(filename: string): string {
  return readFileSync(join(migrationsDirectory, filename), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

describe('080 marketplace reservation RPC schema contract', () => {
  const sql = readMigration(migrationFilename);

  it('is the next additive migration after 080', () => {
    const files = readdirSync(migrationsDirectory)
      .filter((filename) => filename.endsWith('.sql'))
      .sort();

    expect(files).toContain('080_marketplace_guest_lock_sessions.sql');
    expect(files).toContain(migrationFilename);
    expect(files.indexOf(migrationFilename)).toBeGreaterThan(
      files.indexOf('080_marketplace_guest_lock_sessions.sql'),
    );
    expect(migrationPath).toContain(migrationFilename);
  });

  it('defines a single SECURITY DEFINER plpgsql function with an explicit search_path', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.create_marketplace_reservation(',
    );
    expect(sql).toContain('p_trip_id UUID');
    expect(sql).toContain('p_customer_id UUID');
    expect(sql).toContain('p_agency_id UUID');
    expect(sql).toContain('p_seat_ids UUID[]');
    expect(sql).toContain('p_passenger_names TEXT[]');
    expect(sql).toContain('p_passenger_documents TEXT[]');
    expect(sql).toContain('p_passenger_phones TEXT[]');
    expect(sql).toContain('RETURNS JSONB');
    expect(sql).toContain('LANGUAGE plpgsql');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public');
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(sql).not.toContain('CREATE POLICY');
    expect(sql).not.toContain('DROP FUNCTION');
  });

  it('hardcodes marketplace/locked with customer_id from the auth parameter', () => {
    const insert = sql.match(
      /INSERT INTO public\.reservations \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\);/,
    );
    expect(insert).not.toBeNull();
    const columns = insert![1].replace(/\s+/g, ' ');
    const values = insert![2].replace(/\s+/g, ' ');

    expect(columns).toContain('created_by');
    expect(columns).toContain('customer_id');
    expect(columns).toContain('source');
    expect(columns).toContain('status');
    expect(columns).toContain('payment_status');
    expect(values).toContain('p_customer_id, p_customer_id');
    expect(values).toContain("'marketplace', 'locked'");
    expect(values).toContain("'pending'");
    // Nunca emite los estados internos del flujo de tour.
    expect(values).not.toContain("'confirmed'");
    expect(values).not.toContain("'reserved'");
  });

  it('snapshots trips.seat_price server-side into reservation_passengers.unit_price', () => {
    expect(sql).toContain('t.seat_price');
    expect(sql).toContain('IF v_unit_price IS NULL THEN');
    expect(sql).toContain('ERR_TRIP_PRICE_MISSING');

    const passengerInsert = sql.match(
      /INSERT INTO public\.reservation_passengers \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\);/,
    );
    expect(passengerInsert).not.toBeNull();
    const columns = passengerInsert![1].replace(/\s+/g, ' ');
    const values = passengerInsert![2].replace(/\s+/g, ' ');

    expect(columns).toContain('unit_price');
    expect(columns).toContain('seat_id');
    expect(values).toContain('v_unit_price');
    expect(values).toContain('p_seat_ids[v_i]');
    expect(sql).toContain('array_length(p_passenger_names, 1)');
    expect(sql).toContain('ERR_PASSENGER_MISMATCH');
    expect(sql).toContain('ERR_PASSENGER_DUPLICATE_DOCUMENT');
    expect(sql).toContain('ERR_SEAT_DUPLICATE');
  });

  it('never mutates seats or lock_expires_at (TTL and locks stay intact)', () => {
    expect(sql).not.toMatch(/UPDATE\s+public\.seats/i);
    expect(sql).not.toMatch(/UPDATE\s+seats\b/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.seats/i);
    expect(sql).not.toMatch(/lock_expires_at\s*=(?!=)/);
    expect(sql).not.toContain('LOCK_TTL_SECONDS');
    expect(sql).toContain('FOR UPDATE');
  });

  it('validates trip, agency offer and seat ownership before writing', () => {
    expect(sql).toContain('ERR_TRIP_NOT_FOUND');
    expect(sql).toContain('ERR_TRIP_NOT_ACTIVE');
    expect(sql).toContain('ERR_TRIP_DEPARTED');
    expect(sql).toContain('FROM public.trip_agencies ta');
    expect(sql).toContain('ERR_AGENCY_NOT_ASSIGNED');
    expect(sql).toContain("v_seat.status IS DISTINCT FROM 'locked'");
    expect(sql).toContain('v_seat.locked_by IS DISTINCT FROM p_customer_id');
    expect(sql).toContain('v_seat.guest_session_id IS NOT NULL');
    expect(sql).toContain('v_seat.lock_expires_at <= NOW()');
    expect(sql).toContain('ERR_SEAT_NOT_OWNED');
    expect(sql).toContain('ERR_SEAT_LOCK_EXPIRED');
    expect(sql).toContain('ERR_SEAT_NOT_FOUND');
    expect(sql).toContain('IF p_customer_id IS NULL THEN');
    expect(sql).toContain('ERR_CUSTOMER_REQUIRED');
  });

  it('serializes concurrent checkouts and dedupes retries inside the RPC', () => {
    const forUpdateIndex = sql.indexOf('FOR UPDATE');
    const idempotentIndex = sql.indexOf("'idempotent', true");
    const insertIndex = sql.indexOf('INSERT INTO public.reservations');

    expect(forUpdateIndex).toBeGreaterThan(-1);
    expect(idempotentIndex).toBeGreaterThan(forUpdateIndex);
    expect(insertIndex).toBeGreaterThan(idempotentIndex);

    const idempotentSelect = sql.match(
      /SELECT r\.id, r\.qr_code, r\.ticket_code([\s\S]*?)LIMIT 1;/,
    );
    expect(idempotentSelect).not.toBeNull();
    expect(idempotentSelect![1]).toContain('r.customer_id = p_customer_id');
    expect(idempotentSelect![1]).toContain("r.source = 'marketplace'");
    expect(idempotentSelect![1]).toContain("r.status = 'locked'");
    expect(idempotentSelect![1]).toContain('array_agg(rp.seat_id');
    expect(sql).toContain("'idempotent', false");
  });

  it('is executable only by the service role, following the 079 grants pattern', () => {
    const signature =
      'public.create_marketplace_reservation(UUID, UUID, UUID, UUID[], TEXT[], TEXT[], TEXT[])';
    expect(sql).toContain(
      `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`,
    );
    expect(sql).toContain(
      `REVOKE ALL ON FUNCTION ${signature} FROM anon;`,
    );
    expect(sql).toContain(
      `REVOKE ALL ON FUNCTION ${signature} FROM authenticated;`,
    );
    expect(sql).toContain(
      `GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`,
    );
    expect(sql).toContain('COMMENT ON FUNCTION');
  });

  it('leaves the Tour reservation flow untouched', () => {
    const tourCore = readMigration('069_reservation_link_rpcs.sql');
    const guestLocks = readMigration('080_marketplace_guest_lock_sessions.sql');
    const codeOnly = sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');

    expect(tourCore).toContain('create_reservation_core');
    expect(tourCore).not.toContain('create_marketplace_reservation');
    expect(codeOnly).not.toContain('create_reservation_core');
    expect(codeOnly).not.toContain('create_agency_reservation');
    expect(guestLocks).not.toContain('create_marketplace_reservation');
  });
});
