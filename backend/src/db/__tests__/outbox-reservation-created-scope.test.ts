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
const migrationFilename = '082_outbox_reservation_created_scope.sql';
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

describe('082 outbox reservation.created scope contract (MKT-004 hardening)', () => {
  const sql = readMigration(migrationFilename);
  const code = stripComments(sql);

  it('is a new additive migration after 081, never a rewrite of 049/056', () => {
    const files = readdirSync(migrationsDirectory)
      .filter((filename) => filename.endsWith('.sql'))
      .sort();

    expect(files).toContain('049_outbox_events.sql');
    expect(files).toContain('056_outbox_trigger_retrofit_dedup_key.sql');
    expect(files).toContain('081_create_marketplace_reservation.sql');
    expect(files).toContain(migrationFilename);
    expect(files.indexOf(migrationFilename)).toBeGreaterThan(
      files.indexOf('081_create_marketplace_reservation.sql'),
    );
    expect(migrationPath).toContain(migrationFilename);

    // 049/056 siguen intactas: sin guardas marketplace y con el trigger
    // original sin condiciones.
    const migration049 = readMigration('049_outbox_events.sql');
    const migration056 = readMigration('056_outbox_trigger_retrofit_dedup_key.sql');
    expect(migration049).not.toContain('marketplace');
    expect(migration056).not.toContain('marketplace');
    expect(migration049).toContain(
      'CREATE TRIGGER trg_reservations_outbox_created',
    );
    expect(migration049).not.toContain('WHEN (');

    // Esta migracion no vuelve a crear el trigger de INSERT (049 lo define
    // una sola vez) ni elimina nada existente.
    expect(code).not.toMatch(/DROP\s+TABLE/i);
    expect(code).not.toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS\s+trg_reservations_outbox_created\b/i);
    expect(code).not.toMatch(/CREATE\s+TRIGGER\s+trg_reservations_outbox_created\b/i);
    expect(code).not.toMatch(/ALTER\s+TABLE/i);
    expect(code).not.toContain('create_agency_reservation');
    expect(code).not.toContain('create_marketplace_reservation');
  });

  it('blocks only marketplace rows born without confirmation', () => {
    expect(code).toContain('CREATE OR REPLACE FUNCTION public.outbox_emit_reservation_created()');
    expect(code).toContain(
      "IF NEW.source = 'marketplace' AND NEW.status IS DISTINCT FROM 'reserved' THEN",
    );
    expect(code).toContain('RETURN NEW;');
    expect(code).toContain('LANGUAGE plpgsql');
    expect(code).toContain('SECURITY DEFINER');
    expect(code).toContain('SET search_path = public');
  });

  it('keeps the Tour emission path byte-for-byte compatible with 056', () => {
    expect(code).toContain("'reservation.created'");
    expect(code).toContain("'reservation.created:' || NEW.id::text");
    expect(code).toContain('ON CONFLICT DO NOTHING');
    expect(code).toContain('jsonb_build_object(');
    expect(code).toContain("'reservation_id', NEW.id");
    expect(code).toContain("'trip_id', NEW.trip_id");
    expect(code).toContain("'agency_id', NEW.agency_id");
    expect(code).toContain('RETURN NEW;');
    // El payload no cambia de forma: sigue siendo el contrato v1.
    expect(code).toContain('event_version');
    expect(code).toContain("'reservation'");
    expect(code).toContain("'pending'");
    expect(code).toContain('jsonb_build_object');
  });

  it('emits marketplace events only on the locked -> reserved promotion', () => {
    expect(code).toContain(
      'CREATE OR REPLACE FUNCTION public.outbox_emit_reservation_created_on_promotion()',
    );
    expect(code).toContain(
      'CREATE TRIGGER trg_reservations_outbox_created_on_promotion',
    );
    expect(code).toContain('AFTER UPDATE OF status ON public.reservations');
    expect(code).toContain("NEW.source = 'marketplace'");
    expect(code).toContain("OLD.status = 'locked'");
    expect(code).toContain("NEW.status = 'reserved'");
    // Solo esa combinacion: el WHEN del trigger y el cuerpo de la funcion
    // deben coincidir para no emitir en ninguna otra transicion.
    expect(code).toContain('OLD.status IS DISTINCT FROM NEW.status');
    const whenBlock = code.slice(code.indexOf('WHEN ('));
    expect(whenBlock).toContain("NEW.source = 'marketplace'");
    expect(whenBlock).toContain("OLD.status = 'locked'");
    expect(whenBlock).toContain("NEW.status = 'reserved'");
    expect(code.lastIndexOf('ON CONFLICT DO NOTHING')).toBeGreaterThan(
      code.indexOf('outbox_emit_reservation_created_on_promotion()'),
    );
  });

  it('is not executable by clients, mirroring the 049 grant pattern', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.outbox_emit_reservation_created() FROM PUBLIC;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.outbox_emit_reservation_created() FROM anon;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.outbox_emit_reservation_created() FROM authenticated;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.outbox_emit_reservation_created_on_promotion() FROM PUBLIC;',
    );
    expect(sql).not.toContain('GRANT EXECUTE');
    expect(sql).toContain('COMMENT ON FUNCTION');
  });

  it('leaves the Tour reservation flow and the marketplace RPC untouched', () => {
    const tourCore = readMigration('069_reservation_link_rpcs.sql');
    const tourAgency = readMigration('047_update_create_agency_reservation_ticket_code.sql');
    const marketplaceRpc = readMigration('081_create_marketplace_reservation.sql');
    const gate = readMigration('075_reservations_marketplace.sql');

    // Tour sigue insertando reservas confirmadas con source por DEFAULT.
    expect(tourCore).toContain("'confirmed'");
    expect(tourAgency).toContain("'confirmed'");
    expect(tourCore).not.toContain('marketplace');
    expect(tourAgency).not.toContain('marketplace');
    expect(code).not.toContain('create_reservation_core');

    // El lifecycle marketplace sigue siendo el de 075 y el RPC de 081 el de
    // 'locked': esta migracion no los reescribe.
    expect(gate).toContain("'locked'");
    expect(gate).toContain("'reserved'");
    expect(marketplaceRpc).toContain("'marketplace', 'locked'");
    expect(code).not.toContain('INSERT INTO public.reservations');
  });
});
