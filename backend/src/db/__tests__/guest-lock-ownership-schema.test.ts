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
const migrationFilename = '080_marketplace_guest_lock_sessions.sql';
const migrationPath = join(migrationsDirectory, migrationFilename);

function readMigration(filename: string): string {
  return readFileSync(join(migrationsDirectory, filename), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

describe('080 guest lock ownership schema contract', () => {
  const sql = readMigration(migrationFilename);

  it('is the next additive migration after 079', () => {
    const files = readdirSync(migrationsDirectory)
      .filter((filename) => filename.endsWith('.sql'))
      .sort();

    expect(files).toContain('079_cancel_reservation_passenger.sql');
    expect(files).toContain(migrationFilename);
    expect(files.indexOf(migrationFilename)).toBeGreaterThan(
      files.indexOf('079_cancel_reservation_passenger.sql'),
    );
  });

  it('defines the guest session ownership entity without a raw token column', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.guest_sessions');
    expect(sql).toContain(
      "token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$')",
    );
    expect(sql).toContain(
      'trip_id UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE',
    );
    expect(sql).toContain(
      'customer_id UUID REFERENCES public.users(id) ON DELETE SET NULL',
    );
    expect(sql).toContain(
      "CHECK (status IN ('active', 'claimed', 'expired', 'released'))",
    );
    expect(sql).toContain(
      'expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at)',
    );
    expect(sql).not.toContain('raw_token');
    expect(sql).not.toContain('token TEXT');
  });

  it('associates claimed sessions with a customer while leaving guests unassociated', () => {
    expect(sql).toContain('guest_sessions_claim_check');
    expect(sql).toContain(
      "((status IN ('active', 'expired', 'released')) AND customer_id IS NULL)",
    );
    expect(sql).toContain(
      "((status = 'claimed') AND customer_id IS NOT NULL)",
    );
  });

  it('adds a guest owner pointer to seats without changing locked_by', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS guest_session_id UUID');
    expect(sql).toContain(
      'REFERENCES public.guest_sessions(id) ON DELETE SET NULL',
    );
    expect(sql).toContain('idx_seats_guest_session_id');
    expect(sql).not.toContain('DROP COLUMN');
    expect(sql).not.toContain('ALTER COLUMN');
  });

  it('requires exactly one owner for every active locked seat', () => {
    expect(sql).toContain('seats_single_lock_owner_check');
    expect(sql).toContain("status IS DISTINCT FROM 'locked'");
    expect(sql).toContain(
      '(locked_by IS NOT NULL AND guest_session_id IS NULL)',
    );
    expect(sql).toContain(
      '(locked_by IS NULL AND guest_session_id IS NOT NULL)',
    );
  });

  it('isolates guest ownership to the session trip', () => {
    expect(sql).toContain('trg_seats_check_guest_session_trip');
    expect(sql).toContain('FROM public.guest_sessions');
    expect(sql).toContain('ERR_GUEST_SESSION_TRIP_MISMATCH');
  });

  it('clears guest ownership through the existing available-seat path', () => {
    expect(sql).toContain('trg_seats_clear_lock_on_available');
    expect(sql).toContain('NEW.locked_by := NULL;');
    expect(sql).toContain('NEW.locked_at := NULL;');
    expect(sql).toContain('NEW.lock_expires_at := NULL;');
    expect(sql).toContain('NEW.guest_session_id := NULL;');
  });

  it('keeps guest sessions backend-controlled and does not open seat RLS', () => {
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.guest_sessions FROM anon, authenticated, PUBLIC;',
    );
    expect(sql).toContain(
      'ALTER TABLE public.guest_sessions ENABLE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guest_sessions TO service_role;',
    );
    expect(sql).not.toContain('CREATE POLICY');
    expect(sql).not.toContain('USING (true)');
  });

  it('leaves the historical Tour ownership contract untouched', () => {
    const seatsDefinition = readMigration('011_create_all.sql');
    const lockExpiry = readMigration('068_seat_lock_expires_at.sql');

    expect(seatsDefinition).toContain(
      'locked_by UUID REFERENCES auth.users(id)',
    );
    expect(lockExpiry).toContain('NEW.locked_by := NULL;');
    expect(lockExpiry).not.toContain('guest_session_id');
    expect(sql).not.toContain('LOCK_TTL_SECONDS');
  });
});
