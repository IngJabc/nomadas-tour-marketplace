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
const verifyFilename = '085_payment_admin_actions.sql';
const auditFilename = '086_audit_log_payment_actions.sql';
const verifyPath = join(migrationsDirectory, verifyFilename);
const auditPath = join(migrationsDirectory, auditFilename);

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

// NOTA DE VALIDACION (MKT-006 Fase 6.2B): este archivo es una prueba
// ESTATICA sobre el texto de las migraciones 085 y 086. No abre una base
// de datos, por lo que NO demuestra atomicidad, aislamiento, ausencia de
// deadlocks reales ni comportamiento de PostgreSQL. La verificacion
// contra una BD real (integridad financiera, locks, concurrencia) ocurre
// en una fase posterior con integration testing.
describe('085/086 payment admin actions contract (MKT-006 Phase 6.2B)', () => {
  const verifySql = readMigration(verifyFilename);
  const auditSql = readMigration(auditFilename);
  const code = stripComments(verifySql);
  const auditCode = stripComments(auditSql);

  it('lists 085 and 086 as the next migrations after 084 in the marketplace README', () => {
    const files = readdirSync(migrationsDirectory)
      .filter((filename) => filename.endsWith('.sql'))
      .sort();

    expect(files).toContain('084_trip_seat_price.sql');
    expect(files).toContain(verifyFilename);
    expect(files).toContain(auditFilename);
    expect(files.indexOf(verifyFilename)).toBeGreaterThan(
      files.indexOf('084_trip_seat_price.sql'),
    );
    expect(files.indexOf(auditFilename)).toBeGreaterThan(
      files.indexOf(verifyFilename),
    );
    expect(verifyPath).toContain(verifyFilename);
    expect(auditPath).toContain(auditFilename);

    const readme = readFileSync(readmePath, 'utf8');
    expect(readme).toContain('| 085 |');
    expect(readme).toContain('| 086 |');
    // Conserva el rango historico que el test de 083 sigue exigiendo.
    expect(readme).toContain('`074`–`083`');
    expect(readme).toContain('`074`–`086`');
  });

  describe('085 — verify_marketplace_payment', () => {
    it('defines a single SECURITY DEFINER plpgsql RPC with explicit search_path and full signature', () => {
      expect(verifySql).toContain(
        'CREATE OR REPLACE FUNCTION public.verify_marketplace_payment(',
      );
      expect(verifySql).toContain('p_payment_id UUID');
      expect(verifySql).toContain('p_actor_user_id UUID');
      expect(verifySql).toContain('RETURNS JSONB');
      expect(verifySql).toContain('LANGUAGE plpgsql');
      expect(verifySql).toContain('SECURITY DEFINER');
      expect(verifySql).toContain('SET search_path = public');
      // El importe NUNCA viaja como parametro: se calcula server-side.
      expect(verifySql).not.toMatch(/p_amount/);
      expect(verifySql).not.toMatch(/p_amount_cents/);
    });

    it('validates params, then locks payment FOR UPDATE (leaf) before reservation', () => {
      const inputIndex = code.indexOf(
        'IF p_payment_id IS NULL OR p_actor_user_id IS NULL THEN',
      );
      const paymentLockIndex = code.indexOf(
        'SELECT p.*\n    INTO v_payment\n  FROM public.payments p\n  WHERE p.id = p_payment_id\n  FOR UPDATE;',
      );
      const reservationLockIndex = code.indexOf(
        'SELECT r.*\n    INTO v_reservation\n  FROM public.reservations r\n  WHERE r.id = v_payment.reservation_id\n  FOR UPDATE;',
      );

      expect(inputIndex).toBeGreaterThan(-1);
      expect(paymentLockIndex).toBeGreaterThan(inputIndex);
      expect(reservationLockIndex).toBeGreaterThan(paymentLockIndex);

      expect(verifySql).toContain('ERR_PAYMENT_INPUT');
      expect(verifySql).toContain('ERR_PAYMENT_NOT_FOUND');
      expect(verifySql).toContain('ERR_PAYMENT_RESERVATION_NOT_FOUND');
    });

    it('validates marketplace source and agency authorization with ownership after locking', () => {
      const sourceIndex = code.indexOf(
        "v_reservation.source IS DISTINCT FROM 'marketplace'",
      );
      const actorIndex = code.indexOf(
        "v_actor.role IS DISTINCT FROM 'agency'",
      );
      const passengerLockIndex = code.indexOf('FOR v_pax IN');

      expect(sourceIndex).toBeGreaterThan(-1);
      expect(actorIndex).toBeGreaterThan(sourceIndex);
      expect(passengerLockIndex).toBeGreaterThan(actorIndex);

      expect(verifySql).toContain('ERR_PAYMENT_NOT_MARKETPLACE');
      expect(verifySql).toContain('ERR_PAYMENT_ADMIN_NOT_FOUND');
      expect(verifySql).toContain('ERR_PAYMENT_ADMIN_ROLE');
      expect(verifySql).toContain('ERR_PAYMENT_ADMIN_AGENCY');
      expect(verifySql).toContain('ERR_PAYMENT_AGENCY_MISMATCH');
    });

    it('resolves agency_id from the user record and verifies ownership, never trusting the client', () => {
      // El agency_id se obtiene del registro del usuario, no de un parametro.
      expect(code).toContain('v_actor.agency_id IS NULL');
      // Coherencia payments <-> reservations.
      expect(code).toContain(
        'v_payment.agency_id IS DISTINCT FROM v_reservation.agency_id',
      );
      // Ownership: el pago debe pertenecer a la agencia del actor.
      expect(code).toContain(
        'v_payment.agency_id IS DISTINCT FROM v_actor.agency_id',
      );
      // No existe parametro de agency_id controlado por el cliente.
      expect(verifySql).not.toMatch(/p_agency_id/);
    });

    it('distinguishes retry (already_verified) from contradiction (rejected) and requires pending', () => {
      const alreadyIndex = code.indexOf("v_payment.status = 'verified'");
      const rejectedIndex = code.indexOf(
        "v_payment.status = 'rejected'",
      );
      const pendingIndex = code.indexOf(
        "v_payment.status IS DISTINCT FROM 'pending'",
      );
      const passengerLockIndex = code.indexOf('FOR v_pax IN');

      expect(alreadyIndex).toBeGreaterThan(-1);
      expect(rejectedIndex).toBeGreaterThan(alreadyIndex);
      expect(pendingIndex).toBeGreaterThan(rejectedIndex);
      // El retorno idempotente ocurre ANTES de tocar pasajeros.
      expect(passengerLockIndex).toBeGreaterThan(pendingIndex);

      expect(code).toContain("'already_verified', true");
      expect(code).toContain("'already_verified', false");
      expect(verifySql).toContain('ERR_PAYMENT_ALREADY_REJECTED');
      expect(verifySql).toContain('ERR_PAYMENT_NOT_PENDING');

      // Reintento: sin allocations ni auditoria duplicadas.
      const alreadyBlock = code.slice(
        alreadyIndex,
        code.indexOf('IF v_payment.status'),
      );
      expect(alreadyBlock).not.toContain('INSERT INTO');
      expect(alreadyBlock).not.toContain('audit_append');
    });

    it('requires reservation reserved, locks passengers by seat_id, validates price/total/1:1 seats', () => {
      const reservationStateIndex = code.indexOf(
        "v_reservation.status IS DISTINCT FROM 'reserved'",
      );
      const passengerLockIndex = code.indexOf('ORDER BY rp.seat_id');
      const amountCheckIndex = code.indexOf(
        'v_total_expected <> v_payment.amount_cents',
      );

      expect(reservationStateIndex).toBeGreaterThan(-1);
      expect(passengerLockIndex).toBeGreaterThan(reservationStateIndex);
      expect(amountCheckIndex).toBeGreaterThan(passengerLockIndex);

      expect(verifySql).toContain('ERR_PAYMENT_RESERVATION_STATE');
      expect(code).toContain("rp.status = 'active'");
      expect(code).toContain('v_priced_count <> v_active_count');
      expect(code).toContain('v_distinct_seats <> v_active_count');
      expect(verifySql).toContain('ERR_PAYMENT_VERIFY_AMOUNT');
      expect(verifySql).toContain('ERR_PAYMENT_VERIFY_PRICE');
      expect(verifySql).toContain('ERR_PAYMENT_VERIFY_SEATS');
    });

    it('validates seat coherence via plain SELECT (verify does not lock seats)', () => {
      const seatSelectIndex = code.indexOf(
        'SELECT s.id, s.seat_code, s.trip_id, s.status\n    FROM public.seats s',
      );
      const allocInsertIndex = code.indexOf(
        'INSERT INTO public.payment_allocations',
      );

      expect(seatSelectIndex).toBeGreaterThan(-1);
      // La validacion de asientos ocurre ANTES de crear allocations.
      expect(allocInsertIndex).toBeGreaterThan(seatSelectIndex);
      // verify NO bloquea seats (sin FOR UPDATE en el bloque de seats).
      const seatBlock = code.slice(
        seatSelectIndex,
        allocInsertIndex,
      );
      expect(seatBlock).not.toContain('FOR UPDATE');

      expect(code).toContain(
        'v_seat.trip_id IS DISTINCT FROM v_reservation.trip_id',
      );
      expect(code).toContain("v_seat.status IS DISTINCT FROM 'reserved'");
      expect(verifySql).toContain('ERR_PAYMENT_VERIFY_SEAT_TRIP');
      expect(verifySql).toContain('ERR_PAYMENT_VERIFY_SEAT_STATE');
      expect(verifySql).toContain('ERR_PAYMENT_VERIFY_SEAT_MISSING');
    });

    it('rejects any prior allocations on a pending payment before inserting', () => {
      const priorAllocIndex = code.indexOf(
        'SELECT COUNT(*)\n    INTO v_existing_alloc_count',
      );
      const allocInsertIndex = code.indexOf(
        'INSERT INTO public.payment_allocations',
      );

      expect(priorAllocIndex).toBeGreaterThan(-1);
      expect(allocInsertIndex).toBeGreaterThan(priorAllocIndex);

      expect(code).toContain('v_existing_alloc_count <> 0');
      expect(verifySql).toContain('ERR_PAYMENT_VERIFY_ALLOCATIONS');
      // Sin ON CONFLICT como sustituto de la validacion financiera.
      expect(code).not.toContain('ON CONFLICT');
    });

    it('creates one allocation per active passenger with exact unit_price and verifies rowcount', () => {
      const allocInsert = code.match(
        /INSERT INTO public\.payment_allocations \(([\s\S]*?)\)\s*SELECT([\s\S]*?)ORDER BY rp\.seat_id;/,
      );
      expect(allocInsert).not.toBeNull();
      const columns = allocInsert![1].replace(/\s+/g, ' ');
      const selectClause = allocInsert![2].replace(/\s+/g, ' ');
      expect(columns).toContain('payment_id');
      expect(columns).toContain('reservation_id');
      expect(columns).toContain('reservation_passenger_id');
      expect(columns).toContain('amount_cents');
      expect(selectClause).toContain('rp.unit_price');
      expect(selectClause).toContain("rp.status = 'active'");
      expect(selectClause).toContain('rp.unit_price IS NOT NULL');
      expect(selectClause).toContain('rp.unit_price > 0');

      expect(code).toContain('v_alloc_count <> v_active_count');
      expect(verifySql).toContain('ERR_PAYMENT_VERIFY_ALLOC_COUNT');
    });

    it('transitions pending to verified with rowcount check, then recalculates payment_status', () => {
      const verifyUpdateIndex = code.indexOf(
        "UPDATE public.payments p\n  SET status = 'verified'",
      );
      const reservationUpdateIndex = code.indexOf(
        "UPDATE public.reservations r\n  SET payment_status = 'fully_paid'",
      );

      expect(verifyUpdateIndex).toBeGreaterThan(-1);
      expect(reservationUpdateIndex).toBeGreaterThan(verifyUpdateIndex);

      expect(code).toContain('verified_at = NOW()');
      expect(code).toContain('verified_by = p_actor_user_id');
      expect(code).toContain("AND p.status = 'pending'");
      expect(code).toContain('v_rowcount <> 1');
      expect(verifySql).toContain('ERR_PAYMENT_VERIFY_RACE');
      expect(verifySql).toContain('ERR_PAYMENT_VERIFY_RESERVATION');
    });

    it('audits payment.verified via audit_append with agency actor and payment entity', () => {
      const auditIndex = code.indexOf('public.audit_append(');
      expect(auditIndex).toBeGreaterThan(-1);

      expect(code).toContain("'agency'");
      expect(code).toContain("'payment.verified'");
      expect(code).toContain("'payment'");
      expect(code).toContain('v_reservation.agency_id');

      // La auditoria es el ultimo paso antes del RETURN final.
      const finalReturnIndex = code.lastIndexOf('RETURN jsonb_build_object(');
      expect(finalReturnIndex).toBeGreaterThan(auditIndex);

      expect(code).toContain("'already_verified', false");
      expect(code).toContain("'payment_status', 'fully_paid'");
    });
  });

  describe('085 — reject_marketplace_payment', () => {
    it('defines a single SECURITY DEFINER plpgsql RPC with reason parameter', () => {
      expect(verifySql).toContain(
        'CREATE OR REPLACE FUNCTION public.reject_marketplace_payment(',
      );
      expect(verifySql).toContain('p_payment_id UUID');
      expect(verifySql).toContain('p_actor_user_id UUID');
      expect(verifySql).toContain('p_reason TEXT');
      expect(verifySql).toContain('RETURNS JSONB');
      expect(verifySql).toContain('LANGUAGE plpgsql');
      expect(verifySql).toContain('SECURITY DEFINER');
      expect(verifySql).toContain('SET search_path = public');
    });

    it('validates and normalizes the reason (trim, non-empty, max 500)', () => {
      const reasonIndex = code.indexOf('v_reason := btrim(');
      expect(reasonIndex).toBeGreaterThan(-1);
      expect(code).toContain("IF v_reason = '' THEN");
      expect(code).toContain('length(v_reason) > 500');
      expect(verifySql).toContain('ERR_PAYMENT_REJECT_REASON');
    });

    it('locks payment then reservation, validates source and agency ownership', () => {
      const paymentLockIndex = code.indexOf(
        'SELECT p.*\n    INTO v_payment\n  FROM public.payments p\n  WHERE p.id = p_payment_id\n  FOR UPDATE;',
        code.indexOf('reject_marketplace_payment'),
      );
      const sourceIndex = code.indexOf(
        "v_reservation.source IS DISTINCT FROM 'marketplace'",
        code.indexOf('v_reason := btrim('),
      );
      const actorIndex = code.indexOf(
        "v_actor.role IS DISTINCT FROM 'agency'",
        code.indexOf('v_reason := btrim('),
      );

      expect(paymentLockIndex).toBeGreaterThan(-1);
      expect(sourceIndex).toBeGreaterThan(paymentLockIndex);
      expect(actorIndex).toBeGreaterThan(sourceIndex);
      expect(verifySql).toContain('ERR_PAYMENT_NOT_MARKETPLACE');
      expect(verifySql).toContain('ERR_PAYMENT_ADMIN_ROLE');
      expect(verifySql).toContain('ERR_PAYMENT_ADMIN_AGENCY');
      expect(verifySql).toContain('ERR_PAYMENT_AGENCY_MISMATCH');
    });

    it('resolves agency_id from the user record and verifies ownership in reject', () => {
      const rejectStart = code.indexOf('reject_marketplace_payment');
      expect(code.indexOf('v_actor.agency_id IS NULL', rejectStart)).toBeGreaterThan(-1);
      expect(
        code.indexOf(
          'v_payment.agency_id IS DISTINCT FROM v_reservation.agency_id',
          rejectStart,
        ),
      ).toBeGreaterThan(-1);
      expect(
        code.indexOf(
          'v_payment.agency_id IS DISTINCT FROM v_actor.agency_id',
          rejectStart,
        ),
      ).toBeGreaterThan(-1);
      // No existe parametro de agency_id controlado por el cliente.
      expect(verifySql).not.toMatch(/p_agency_id/);
    });

    it('distinguishes retry (already_rejected) from contradiction (verified) and requires pending', () => {
      const start = code.indexOf('v_reason := btrim(');
      const rejectedIndex = code.indexOf(
        "v_payment.status = 'rejected'",
        start,
      );
      const verifiedIndex = code.indexOf(
        "v_payment.status = 'verified'",
        start,
      );
      const pendingIndex = code.indexOf(
        "v_payment.status IS DISTINCT FROM 'pending'",
        start,
      );

      expect(rejectedIndex).toBeGreaterThan(-1);
      expect(verifiedIndex).toBeGreaterThan(rejectedIndex);
      expect(pendingIndex).toBeGreaterThan(verifiedIndex);

      expect(code).toContain("'already_rejected', true");
      expect(code).toContain("'already_rejected', false");
      expect(verifySql).toContain('ERR_PAYMENT_VERIFIED_NO_REJECT');
      expect(verifySql).toContain('ERR_PAYMENT_NOT_PENDING');

      // Reintento: sin cancelacion ni auditoria duplicadas.
      const alreadyBlock = code.slice(
        rejectedIndex,
        verifiedIndex,
      );
      expect(alreadyBlock).not.toContain('UPDATE');
      expect(alreadyBlock).not.toContain('audit_append');
    });

    it('detects initial payment vs future installment via other verified payments', () => {
      const otherVerifiedIndex = code.indexOf(
        'v_other_verified_count',
      );
      expect(otherVerifiedIndex).toBeGreaterThan(-1);
      expect(code).toContain("AND p.status = 'verified'");
      expect(code).toContain('AND p.id <> p_payment_id');
      expect(code).toContain('v_other_verified_count = 0');
      expect(code).toContain("'cancelled_reservation'");
      expect(code).toContain("'rejected_only'");
    });

    it('cancels the reservation atomically for an initial payment: passengers, seats, reservation', () => {
      const start = code.indexOf('v_other_verified_count = 0');
      const passengerLockIndex = code.indexOf(
        'FOR rec IN',
        start,
      );
      const passengerCancelIndex = code.indexOf(
        "UPDATE public.reservation_passengers rp\n        SET status = 'cancelled'",
        start,
      );
      const seatFreeIndex = code.indexOf(
        "UPDATE public.seats s\n        SET status = 'available'",
        start,
      );
      const reservationCancelIndex = code.indexOf(
        "UPDATE public.reservations r\n      SET status = 'cancelled'",
        start,
      );

      expect(passengerLockIndex).toBeGreaterThan(start);
      expect(passengerCancelIndex).toBeGreaterThan(passengerLockIndex);
      expect(seatFreeIndex).toBeGreaterThan(passengerCancelIndex);
      expect(reservationCancelIndex).toBeGreaterThan(seatFreeIndex);

      expect(code).toContain('v_rowcount <> v_active_count');
      expect(code).toContain("AND s.status IN ('reserved', 'locked')");
      expect(code).toContain("AND r.status = 'reserved'");
      expect(code).toContain('lock_expires_at = NULL');
      expect(code).toContain('guest_session_id = NULL');
      expect(verifySql).toContain('ERR_PAYMENT_REJECT_PASSENGERS');
      expect(verifySql).toContain('ERR_PAYMENT_REJECT_RESERVATION');
    });

    it('does not create artificial zero-amount refunds on initial rejection', () => {
      const refundIndex = code.indexOf('v_refund_cents');
      expect(refundIndex).toBeGreaterThan(-1);
      expect(code).toContain("AND p.status = 'verified'");
      // Nunca se INSERTa en reservation_refunds dentro de esta RPC.
      expect(code).not.toContain('INSERT INTO public.reservation_refunds');
      expect(code).toContain("'refund_required', v_refund_cents > 0");
    });

    it('does not cancel the reservation for a future installment, only rejects and recalculates', () => {
      const elseIndex = code.indexOf(
        "ELSE\n    \n    \n    v_cancelled_reservation := false;",
      );
      expect(elseIndex).toBeGreaterThan(-1);
      const elseBlock = code.slice(elseIndex);
      const endOfElse = elseBlock.indexOf('UPDATE public.payments p');
      const installmentBlock = elseBlock.slice(0, endOfElse);
      expect(installmentBlock).not.toContain('UPDATE public.reservations');
      expect(installmentBlock).not.toContain('UPDATE public.seats');
      expect(installmentBlock).not.toContain(
        'UPDATE public.reservation_passengers',
      );
    });

    it('transitions pending to rejected with rowcount and recalculates payment_status', () => {
      const rejectUpdateIndex = code.indexOf(
        "UPDATE public.payments p\n  SET status = 'rejected'",
      );
      expect(rejectUpdateIndex).toBeGreaterThan(-1);
      expect(code).toContain('rejection_reason = v_reason');
      expect(code).toContain("AND p.status = 'pending'");
      expect(code).toContain('ERR_PAYMENT_REJECT_RACE');

      // Recalculo de payment_status (pendiente/parcial/completo).
      expect(code).toContain("WHEN v_verified = 0 THEN 'pending'");
      expect(code).toContain("WHEN v_verified >= v_expected THEN 'fully_paid'");
      expect(code).toContain("ELSE 'partial'");
      expect(code).toContain("SET payment_status = v_new_payment_status");
    });

    it('audits payment.rejected always and reservation.cancelled only when cancelled', () => {
      const paymentAuditIndex = code.indexOf(
        "'payment.rejected'",
      );
      const reservationAuditIndex = code.indexOf(
        "'reservation.cancelled'",
      );

      expect(paymentAuditIndex).toBeGreaterThan(-1);
      expect(reservationAuditIndex).toBeGreaterThan(paymentAuditIndex);
      expect(code).toContain("IF v_cancelled_reservation THEN");
      expect(code).toContain("'trigger', 'payment_rejected'");
      expect(code).toContain("'freed_seat_count', v_freed_count");

      expect(code).toContain("'outcome', v_outcome");
      expect(code).toContain("'cancelled_reservation', v_cancelled_reservation");
      expect(code).toContain("'payment_audit_id'");
      expect(code).toContain("'reservation_audit_id'");
    });
  });

  describe('085 — grants (both RPCs)', () => {
    it('restricts EXECUTE to service_role only for both functions', () => {
      const verifySig = 'public.verify_marketplace_payment(UUID, UUID)';
      const rejectSig =
        'public.reject_marketplace_payment(UUID, UUID, TEXT)';

      for (const sig of [verifySig, rejectSig]) {
        expect(verifySql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`);
        expect(verifySql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon;`);
        expect(verifySql).toContain(
          `REVOKE ALL ON FUNCTION ${sig} FROM authenticated;`,
        );
        expect(verifySql).toContain(
          `GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`,
        );
      }

      expect(verifySql).not.toMatch(
        /GRANT\s+EXECUTE\s+[^;]*\s+TO\s+(anon|authenticated|PUBLIC)/,
      );
    });
  });

  describe('086 — additive audit_log CHECK extension', () => {
    it('guards and extends action_check with payment.verified and payment.rejected', () => {
      expect(auditSql).toContain('ERR_086_ACTION_GUARD');
      expect(auditCode).toContain("conname = 'audit_log_action_check'");
      expect(auditCode).toContain("regexp_matches(v_current,");
      expect(auditSql).toContain('payment.verified');
      expect(auditSql).toContain('payment.rejected');

      // Conserva las 16 acciones de 079 y agrega 2 al final.
      const actionCheck = auditCode.match(
        /ADD CONSTRAINT audit_log_action_check CHECK \(\s*action IN \(([\s\S]*?)\)\s*\)/,
      );
      expect(actionCheck).not.toBeNull();
      const actions = actionCheck![1];
      for (const action of [
        'trip.created',
        'trip.updated',
        'trip.cancelled',
        'reservation.created',
        'reservation.cancelled',
        'boarding.board',
        'boarding.unboard',
        'agency_settings.updated',
        'notification_preferences.updated',
        'reservation_link.created',
        'reservation_link.cancelled',
        'reservation_link.confirmed',
        'reservation_link.regenerated',
        'reservation_link.passenger_data_saved',
        'reservation_link.expired',
        'reservation.passenger_cancelled',
      ]) {
        expect(actions).toContain(`'${action}'`);
      }
      // 18 valores en total.
      expect(actions.match(/'/g)).toHaveLength(36);
    });

    it('guards and extends entity_type_check with payment, preserving all 069 values', () => {
      expect(auditSql).toContain('ERR_086_ENTITY_GUARD');
      expect(auditCode).toContain("conname = 'audit_log_entity_type_check'");

      const entityCheck = auditCode.match(
        /ADD CONSTRAINT audit_log_entity_type_check CHECK \(\s*entity_type IN \(([\s\S]*?)\)\s*\)/,
      );
      expect(entityCheck).not.toBeNull();
      const entities = entityCheck![1];
      for (const entity of [
        'trip',
        'reservation',
        'reservation_passenger',
        'agency_settings',
        'notification_preferences',
        'reservation_link',
      ]) {
        expect(entities).toContain(`'${entity}'`);
      }
      expect(entities).toContain(`'payment'`);
      // 7 valores en total.
      expect(entities.match(/'/g)).toHaveLength(14);
    });

    it('does not touch audit_log_actor_check', () => {
      // El archivo solo lo menciona en comentarios; sin DDL que lo dropee
      // ni lo redefina. auditCode ya tiene los comentarios eliminados.
      expect(auditCode).not.toContain('audit_log_actor_check');
      expect(auditCode).not.toContain('DROP CONSTRAINT IF EXISTS audit_log_actor_check');
      expect(auditCode).not.toContain('ADD CONSTRAINT audit_log_actor_check');
    });

    it('only performs additive DROP/ADD on the two CHECKs and no other DDL', () => {
      expect(auditCode).toContain(
        'DROP CONSTRAINT IF EXISTS audit_log_action_check',
      );
      expect(auditCode).toContain(
        'DROP CONSTRAINT IF EXISTS audit_log_entity_type_check',
      );
      // Sin cambios a tablas, policies, triggers o RPCs.
      expect(auditCode).not.toContain('CREATE TABLE');
      expect(auditCode).not.toContain('DROP TABLE');
      expect(auditCode).not.toContain('ALTER TABLE public.audit_log ENABLE');
      expect(auditCode).not.toContain('CREATE POLICY');
      expect(auditCode).not.toContain('CREATE TRIGGER');
      expect(auditCode).not.toContain('CREATE OR REPLACE FUNCTION');
      expect(auditCode).not.toContain('CREATE INDEX');
    });
  });

  describe('immutability of historical migrations 080–084', () => {
    it('does not modify migrations 080–084 or reference their internals for change', () => {
      const historical = [
        '080_marketplace_guest_lock_sessions.sql',
        '081_create_marketplace_reservation.sql',
        '082_outbox_reservation_created_scope.sql',
        '083_marketplace_payment_submission.sql',
        '084_trip_seat_price.sql',
      ];

      for (const filename of historical) {
        const sql = readMigration(filename);
        // Ninguna migracion historica conoce las RPCs nuevas.
        expect(sql).not.toContain('verify_marketplace_payment');
        expect(sql).not.toContain('reject_marketplace_payment');
        expect(sql).not.toContain('payment.verified');
        expect(sql).not.toContain('payment.rejected');
      }

      // 085/086 no redefinen ni reemplazan RPCs historicas.
      expect(code).not.toContain('submit_marketplace_payment');
      expect(code).not.toContain('create_marketplace_reservation');
      expect(code).not.toContain('cancel_reservation_passenger');
      expect(code).not.toContain('cancel_agency_reservation');
      expect(code).not.toContain('create_reservation_core');
      expect(code).not.toContain('DROP FUNCTION');
      expect(auditCode).not.toContain('DROP FUNCTION');
    });
  });

  it('documents its dry-run and that static tests do not prove PostgreSQL atomicity', () => {
    expect(verifySql).toContain('Dry-run:');
    expect(verifySql).toContain(
      'BEGIN;  \\i 085_payment_admin_actions.sql   ROLLBACK;',
    );
    expect(verifySql).toContain('demuestran atomicidad');
    expect(auditSql).toContain('Dry-run:');
    expect(auditSql).toContain(
      'BEGIN;  \\i 086_audit_log_payment_actions.sql   ROLLBACK;',
    );
  });
});
