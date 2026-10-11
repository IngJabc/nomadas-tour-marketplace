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
const repositoryRoot = join(testDirectory, '..', '..', '..', '..');
const readmePath = join(repositoryRoot, 'supabase', 'migrations', 'README.md');
const migrationFilename = '083_marketplace_payment_submission.sql';
const migrationPath = join(migrationsDirectory, migrationFilename);

function readMigration(filename: string): string {
  return readFileSync(join(migrationsDirectory, filename), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

// NOTA DE VALIDACION (MKT-005 Fase 1): este archivo es una prueba
// ESTATICA sobre el texto de la migracion. No abre una base de datos,
// por lo que NO demuestran atomicidad, aislamiento, ejecucion de
// triggers ni comportamiento real de PostgreSQL. La verificacion
// contra una BD real ocurre en Fase 2/3.
describe('083 marketplace payment submission contract (MKT-005 Phase 1)', () => {
  const sql = readMigration(migrationFilename);
  const code = stripComments(sql);

  it('is the next additive migration after 082, and the marketplace README lists it', () => {
    const files = readdirSync(migrationsDirectory)
      .filter((filename) => filename.endsWith('.sql'))
      .sort();

    expect(files).toContain('081_create_marketplace_reservation.sql');
    expect(files).toContain('082_outbox_reservation_created_scope.sql');
    expect(files).toContain(migrationFilename);
    expect(files.indexOf(migrationFilename)).toBeGreaterThan(
      files.indexOf('082_outbox_reservation_created_scope.sql'),
    );
    expect(migrationPath).toContain(migrationFilename);

    const readme = readFileSync(readmePath, 'utf8');
    expect(readme).toContain('| 083 |');
    expect(readme).toContain('`074`–`083`');
  });

  it('creates exactly one private payment-proofs bucket and no storage policies', () => {
    expect(sql.match(/INSERT INTO storage\.buckets/g)).toHaveLength(1);
    expect(sql).toMatch(
      /VALUES \(\s*'payment-proofs',\s*'payment-proofs',\s*false,\s*5242880,/,
    );
    expect(sql).toContain(
      "ARRAY['image/png', 'image/jpeg', 'image/webp', 'application/pdf']",
    );
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(sql).toContain('public = EXCLUDED.public');

    // Escrituras exclusivas del backend: ni policies ni grants de
    // almacenamiento para clientes anonimos o autenticados.
    expect(sql).not.toContain('storage.objects');
    expect(sql).not.toContain('CREATE POLICY');
    expect(sql).not.toMatch(/GRANT\s+[^;]*\s+ON\s+storage/);
    expect(sql).not.toMatch(/TO\s+anon\b/);
    expect(sql).not.toMatch(/TO\s+authenticated\b/);
  });

  it('defines a single SECURITY DEFINER plpgsql RPC with an explicit search_path', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.submit_marketplace_payment(',
    );
    expect(sql).toContain('p_reservation_id UUID');
    expect(sql).toContain('p_customer_id UUID');
    expect(sql).toContain('p_idempotency_key UUID');
    expect(sql).toContain('p_proof_path TEXT');
    expect(sql).toContain('RETURNS JSONB');
    expect(sql).toContain('LANGUAGE plpgsql');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public');
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    // El importe NUNCA viaja como parametro del cliente.
    expect(sql).not.toMatch(/p_amount/);
    expect(sql).not.toMatch(/p_proof_url/);
  });

  it('validates customer, idempotency key and reservation-scoped proof path first', () => {
    const customerIndex = sql.indexOf('IF p_customer_id IS NULL THEN');
    const keyIndex = sql.indexOf('IF p_idempotency_key IS NULL THEN');
    const pathIndex = sql.indexOf('v_path_prefix := p_reservation_id::text');

    expect(customerIndex).toBeGreaterThan(-1);
    expect(keyIndex).toBeGreaterThan(customerIndex);
    expect(pathIndex).toBeGreaterThan(keyIndex);

    expect(sql).toContain('ERR_CUSTOMER_REQUIRED');
    expect(sql).toContain('ERR_PAYMENT_INPUT');
    expect(sql).toContain("length(p_proof_path) > 512");
    expect(code).toContain("v_path_rest LIKE '%..%'");
    expect(code).toContain("v_path_rest LIKE '%/%'");
    expect(code).toContain(String.raw`\.(png|jpg|jpeg|webp|pdf)$`);
    // La ruta siempre queda bajo el prefijo <reservation_id>/.
    expect(code).toContain('left(p_proof_path, length(v_path_prefix)) <> v_path_prefix');
  });

  it('locks the reservation first (046 order), then checks owner and marketplace source', () => {
    const reservationLock = code.match(
      /SELECT r\.\*\s+INTO v_reservation\s+FROM public\.reservations r\s+WHERE[\s\S]*?FOR UPDATE;/,
    );
    expect(reservationLock).not.toBeNull();

    expect(code).toContain(
      'v_reservation.customer_id IS DISTINCT FROM p_customer_id',
    );
    expect(code).toContain(
      "v_reservation.source IS DISTINCT FROM 'marketplace'",
    );
    expect(sql).toContain('ERR_PAYMENT_RESERVATION_NOT_FOUND');
    expect(sql).toContain('ERR_PAYMENT_NOT_OWNER');
    // Las reservas internal responden como "no encontrada".
    expect(code.indexOf('ERR_PAYMENT_RESERVATION_NOT_FOUND')).toBeLessThan(
      code.indexOf('mkt005:'),
    );
  });

  it('resolves idempotency by server namespace BEFORE rejecting already-submitted', () => {
    expect(code).toContain(
      "v_namespace := 'mkt005:' || p_reservation_id::text || ':' || p_idempotency_key::text",
    );
    expect(code).toContain('WHERE p.idempotency_key = v_namespace');

    const namespaceIndex = code.indexOf('mkt005:');
    const conflictIndex = code.indexOf('ERR_PAYMENT_IDEMPOTENCY_CONFLICT');
    const alreadyIndex = code.indexOf('ERR_PAYMENT_ALREADY_SUBMITTED');
    const closedIndex = code.indexOf('ERR_PAYMENT_RESERVATION_CLOSED');
    const passengerLoopIndex = code.indexOf('v_locked_pax := v_locked_pax + 1');

    expect(namespaceIndex).toBeGreaterThan(-1);
    expect(conflictIndex).toBeGreaterThan(namespaceIndex);
    // El gate de status (cerrada o ya enviada) vive DESPUES de la
    // resolucion de idempotencia y ANTES de tocar pasajeros.
    expect(alreadyIndex).toBeGreaterThan(conflictIndex);
    expect(closedIndex).toBeGreaterThan(conflictIndex);
    expect(passengerLoopIndex).toBeGreaterThan(alreadyIndex);
    expect(passengerLoopIndex).toBeGreaterThan(closedIndex);

    // Misma clave + distinta prueba -> conflicto sin escritura.
    expect(code).toContain(
      'v_existing.proof_url IS DISTINCT FROM p_proof_path',
    );
    // Exito idempotente en los dos caminos (resolucion temprana y
    // backstop del indice unique), siempre validado.
    expect(sql.match(/'idempotent', true/g)).toHaveLength(2);
    expect(sql.match(/'idempotent', false/g)).toHaveLength(1);
  });

  it('requires status locked for new submissions and maps terminal/closed states', () => {
    expect(code).toContain("v_reservation.status <> 'locked'");
    expect(code).toContain("v_reservation.status IN ('cancelled', 'completed', 'boarded')");
    expect(code).toContain('ERR_PAYMENT_RESERVATION_CLOSED');
    expect(code).toContain('ERR_PAYMENT_ALREADY_SUBMITTED');
    // Estado valido: la transicion de 075.
    expect(code).toContain("AND r.status = 'locked'");
    expect(code).toContain("AND r.source = 'marketplace'");
  });

  it('locks passengers then seats and validates ownership, trip, TTL and guest residual', () => {
    const passengerLockIndex = code.indexOf('ORDER BY rp.seat_id');
    const seatLockIndex = code.indexOf('ORDER BY s.id');

    expect(passengerLockIndex).toBeGreaterThan(-1);
    expect(seatLockIndex).toBeGreaterThan(passengerLockIndex);
    expect(
      code.indexOf('FROM public.reservations r'),
    ).toBeLessThan(passengerLockIndex);
    expect(code.match(/FOR UPDATE/g)!.length).toBeGreaterThanOrEqual(3);

    expect(code).toContain("v_seat.status IS DISTINCT FROM 'locked'");
    expect(code).toContain('v_seat.locked_by IS DISTINCT FROM p_customer_id');
    expect(code).toContain('v_seat.guest_session_id IS NOT NULL');
    expect(code).toContain('v_seat.trip_id IS DISTINCT FROM v_reservation.trip_id');
    expect(code).toContain('v_seat.lock_expires_at <= NOW()');
    expect(sql).toContain('ERR_PAYMENT_LOCK_EXPIRED');
    expect(code).toContain("rp.status = 'active'");
  });

  it('computes the amount only as SQL SUM of unit_price and rejects invalid totals', () => {
    expect(code).toContain('COALESCE(SUM(rp.unit_price), 0)');
    expect(code).toContain('COUNT(DISTINCT rp.seat_id)');
    expect(code).toContain('COUNT(rp.unit_price)');
    expect(sql).toContain('ERR_PAYMENT_AMOUNT_INVALID');
    expect(code).toContain('v_passenger_count = 0');
    expect(code).toContain('v_distinct_seats <> v_passenger_count');
    expect(code).toContain('v_priced_count <> v_passenger_count OR v_amount <= 0');
    expect(code).toContain('v_locked_pax <> v_passenger_count');
    // El rechazo de monto ocurre antes del primer INSERT.
    expect(code.indexOf('ERR_PAYMENT_AMOUNT_INVALID')).toBeLessThan(
      code.indexOf('INSERT INTO public.payments'),
    );
  });

  it('writes payment, reservation promotion and seats in the mandated order with rowcount checks', () => {
    const paymentIndex = code.indexOf('INSERT INTO public.payments');
    const reservationIndex = code.indexOf('UPDATE public.reservations');
    const seatsIndex = code.indexOf('UPDATE public.seats');

    expect(paymentIndex).toBeGreaterThan(-1);
    expect(reservationIndex).toBeGreaterThan(paymentIndex);
    expect(seatsIndex).toBeGreaterThan(reservationIndex);

    expect(sql.match(/GET DIAGNOSTICS/g)).toHaveLength(2);
    expect(code).toContain('v_rowcount <> 1');
    expect(code).toContain('v_rowcount <> v_distinct_seats');

    const paymentInsert = code.match(
      /INSERT INTO public\.payments \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)/,
    );
    expect(paymentInsert).not.toBeNull();
    const columns = paymentInsert![1].replace(/\s+/g, ' ');
    const values = paymentInsert![2].replace(/\s+/g, ' ');
    expect(columns).toContain('reservation_id');
    expect(columns).toContain('agency_id');
    expect(columns).toContain('customer_id');
    expect(columns).toContain('amount_cents');
    expect(columns).toContain('currency');
    expect(columns).toContain('status');
    expect(columns).toContain('proof_url');
    expect(columns).toContain('idempotency_key');
    expect(values).toContain('v_reservation.agency_id');
    expect(values).toContain('p_customer_id');
    expect(values).toContain("'manual'");
    expect(values).toContain('v_amount');
    expect(values).toContain("'COP'");
    expect(values).toContain("'pending'");
    expect(values).toContain('p_proof_path');
    expect(values).toContain('v_namespace');
    // La clave cruda del cliente jamas llega a la columna unique.
    expect(values).not.toContain('p_idempotency_key');
  });

  it('keeps the 082 outbox promotion path untouched: no triggers, no outbox functions, no DDL', () => {
    expect(code).not.toContain('CREATE TRIGGER');
    expect(code).not.toContain('DROP TRIGGER');
    expect(code).not.toContain('outbox_emit');
    expect(code).not.toContain('reservation.created:');
    expect(code).not.toContain('CREATE TABLE');
    expect(code).not.toContain('DROP TABLE');
    expect(code).not.toContain('ALTER TABLE');
    expect(code).not.toContain('CREATE POLICY');
    expect(code).not.toMatch(/DROP\s+/);
    expect(code).not.toMatch(/INSERT INTO public\.reservations/);
    expect(code).not.toMatch(/DELETE\s+FROM/);
    expect(code).not.toContain('create_reservation_core');
    expect(code).not.toContain('create_agency_reservation');
    expect(code).not.toContain('create_marketplace_reservation');
    expect(code).not.toContain('payment_allocations');

    // La promocion es exactamente locked -> reserved con guarda en
    // el mismo UPDATE que ya validamos, y sin tocar updated_at
    // (reservations no tiene esa columna).
    expect(code.match(/SET status = 'reserved'/g)).toHaveLength(2);
    const reservationUpdate = code.match(/UPDATE public\.reservations[\s\S]*?;/);
    expect(reservationUpdate).not.toBeNull();
    expect(reservationUpdate![0]).not.toContain('updated_at');
    expect(reservationUpdate![0]).toContain("SET status = 'reserved'");
  });

  it('promotes seats to reserved clearing every lock field like 069 plus 080', () => {
    const seatUpdate = code.match(/UPDATE public\.seats[\s\S]*?;/);
    expect(seatUpdate).not.toBeNull();
    const statement = seatUpdate![0];

    expect(statement).toContain("SET status = 'reserved'");
    expect(statement).toContain('locked_by = NULL');
    expect(statement).toContain('locked_at = NULL');
    expect(statement).toContain('lock_expires_at = NULL');
    expect(statement).toContain('guest_session_id = NULL');
    expect(statement).toContain('updated_at = NOW()');
    expect(statement).toContain('AND s.status = \'locked\'');
    expect(statement).toContain('s.id = ANY(v_seat_ids)');

    // El TTL no se extiende: nunca se reasigna lock_expires_at a
    // un instante futuro, solo se limpia al promocionar.
    expect(code).not.toMatch(/lock_expires_at\s*=\s*NOW\(\)/);
    expect(code).not.toContain('INTERVAL');
    expect(code).not.toContain('lock_expires_at +');
  });

  it('treats the unique index as a validated backstop, never a blanket success', () => {
    expect(code).toContain('WHEN unique_violation THEN');
    expect(code).toContain('GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME');
    expect(code).toContain("v_constraint IS DISTINCT FROM 'payments_idempotency_key'");
    expect(code).toContain('RAISE;');
    expect(code).toContain('AND v_existing.customer_id = p_customer_id');
    expect(code).toContain('AND v_existing.proof_url = p_proof_path');
    expect(sql).toContain('ERR_PAYMENT_IDEMPOTENCY_CONFLICT');
  });

  it('is executable only by the service role, following the 081/082 grants pattern', () => {
    const signature =
      'public.submit_marketplace_payment(UUID, UUID, UUID, TEXT)';
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM anon;`);
    expect(sql).toContain(
      `REVOKE ALL ON FUNCTION ${signature} FROM authenticated;`,
    );
    expect(sql).toContain(
      `GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`,
    );
    expect(sql).toContain('COMMENT ON FUNCTION');
    expect(sql).toContain('COMMENT ON COLUMN public.payments.proof_url');
    expect(sql).not.toMatch(/GRANT\s+EXECUTE\s+[^;]*\s+TO\s+(anon|authenticated|PUBLIC)/);
  });

  it('is scoped to the marketplace flow only and documents its dry-run (static tests do not prove PostgreSQL atomicity)', () => {
    const tourCore = readMigration('069_reservation_link_rpcs.sql');
    const gate = readMigration('075_reservations_marketplace.sql');
    const outboxScope = readMigration('082_outbox_reservation_created_scope.sql');

    expect(tourCore).toContain('create_reservation_core');
    expect(tourCore).not.toContain('submit_marketplace_payment');
    expect(gate).toContain("'locked'");
    expect(gate).toContain("'reserved'");
    expect(outboxScope).toContain('trg_reservations_outbox_created_on_promotion');
    expect(outboxScope).not.toContain('submit_marketplace_payment');
    expect(code).not.toContain('create_reservation_core');

    expect(sql).toContain('Dry-run:');
    expect(sql).toContain(
      'BEGIN;  \\i 083_marketplace_payment_submission.sql   ROLLBACK;',
    );
    expect(sql).toContain('demuestran atomicidad');
  });
});
