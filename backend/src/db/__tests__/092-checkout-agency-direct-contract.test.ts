import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
// DEPENDENCIA CROSS-REPO EXPLICITA (MKT-008): las migraciones viven en el
// repo hermano nomadas-tour (D:\nomadas-tour), que es la autoridad del
// esquema. Marketplace NO copia SQL de Tour a su propio supabase/migrations.
// La migracion 092 y su rollback ya fueron incorporados a las rutas
// oficiales de Tour; este contrato lee EXCLUSIVAMENTE los archivos
// oficiales (nunca la copia historica de docs/proposals de Marketplace).
const tourRoot = join(
  testDirectory,
  '..',
  '..',
  '..',
  '..',
  '..',
  'nomadas-tour',
);
const tourMigrationsDirectory = join(tourRoot, 'supabase', 'migrations');
const tourRollbacksDirectory = join(tourRoot, 'supabase', 'rollbacks');
const proposalFilename = '092_checkout_agency_direct_payment.sql';
const rollbackFilename = '092_checkout_agency_direct_payment_rollback.sql';
const proposalPath = join(tourMigrationsDirectory, proposalFilename);
const rollbackPath = join(tourRollbacksDirectory, rollbackFilename);
const baseFilename = '087_checkout_attempts.sql';
const checkFilename = '089_agency_payment_methods.sql';

function readSql(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** Normaliza para comparar cuerpos: sin comentarios, espacios colapsados. */
function normalizeSql(sql: string): string {
  return stripComments(sql).replace(/\s+/g, ' ').trim();
}

/** Extrae el cuerpo de submit_checkout_proof de un archivo SQL. */
function extractSubmitBody(sql: string): string {
  const fnIndex = sql.indexOf(
    'CREATE OR REPLACE FUNCTION public.submit_checkout_proof(',
  );
  expect(fnIndex).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $$', fnIndex);
  expect(bodyStart).toBeGreaterThan(-1);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  expect(bodyEnd).toBeGreaterThan(-1);
  return sql.slice(bodyStart + 'AS $$'.length, bodyEnd);
}

// NOTA DE VALIDACION (MKT-008): esta prueba es ESTATICA sobre el texto de
// 087/089/092 oficiales de Tour. No abre una base de datos: NO demuestra
// comportamiento de PostgreSQL, locks ni validacion real de constraints.
// La verificacion contra BD real ocurre en staging.
describe('092 checkout agency_direct payment contract (MKT-008)', () => {
  const proposalSql = readSql(proposalPath);
  const rollbackSql = readSql(rollbackPath);
  const baseSql = readSql(join(tourMigrationsDirectory, baseFilename));
  const checkSql = readSql(join(tourMigrationsDirectory, checkFilename));
  const proposalCode = stripComments(proposalSql);
  const rollbackCode = stripComments(rollbackSql);

  describe('archivos y ubicacion cross-repo', () => {
    it('resuelve los repos hermanos y encuentra los archivos oficiales 092', () => {
      // Resolucion explicita: si los repos no son directorios hermanos,
      // fallar mostrando el path resuelto. Nunca caer a un fallback que
      // lea la propuesta historica de Marketplace en silencio.
      expect(
        existsSync(tourMigrationsDirectory),
        `No se encontro ${tourMigrationsDirectory}. Marketplace y nomadas-tour deben vivir como directorios hermanos.`,
      ).toBe(true);
      expect(
        existsSync(tourRollbacksDirectory),
        `No se encontro ${tourRollbacksDirectory}.`,
      ).toBe(true);
      expect(existsSync(proposalPath), `Falta la migracion oficial ${proposalPath}`).toBe(true);
      expect(existsSync(rollbackPath), `Falta el rollback oficial ${rollbackPath}`).toBe(true);
    });

    it('Tour contiene 087, 089 y los archivos oficiales 092 con sus nombres exactos', () => {
      const tourMigrations = readdirSync(tourMigrationsDirectory)
        .filter((filename) => filename.endsWith('.sql'))
        .sort();
      const tourRollbacks = readdirSync(tourRollbacksDirectory)
        .filter((filename) => filename.endsWith('.sql'))
        .sort();
      expect(tourMigrations).toContain(baseFilename);
      expect(tourMigrations).toContain(checkFilename);
      expect(tourMigrations).toContain(proposalFilename);
      expect(tourRollbacks).toContain(rollbackFilename);
      expect(proposalSql.length).toBeGreaterThan(0);
      expect(rollbackSql.length).toBeGreaterThan(0);
    });

    it('exactamente UNA migracion de Tour implementa v_agency_direct (agnostico al prefijo)', () => {
      // Deteccion por IMPLEMENTACION efectiva, no por aparicion textual:
      // se ignoran comentarios y se busca la declaracion tipada de la
      // variable en plpgsql (v_agency_direct BOOLEAN), que solo existe en
      // el cuerpo de la funcion. Un prefijo distinto al esperado (p. ej.
      // 093_) o una migracion duplicada rompen esta asercion y aparecen
      // con su nombre en el mensaje.
      const implementors = readdirSync(tourMigrationsDirectory)
        .filter((filename) => filename.endsWith('.sql'))
        .filter((filename) =>
          stripComments(readSql(join(tourMigrationsDirectory, filename))).includes(
            'v_agency_direct BOOLEAN',
          ),
        );
      expect(
        implementors,
        `Se esperaba exactamente una implementacion de v_agency_direct; encontradas: ${
          implementors.join(', ') || '(ninguna)'
        }`,
      ).toEqual([proposalFilename]);
    });
  });

  describe('CHECK: pending_review acepta canal elegido O snapshot agency_direct', () => {
    it('define UN solo reemplazo del constraint con la rama agency_direct y NOT VALID', () => {
      expect(proposalCode).toContain(
        'DROP CONSTRAINT IF EXISTS checkout_attempts_payment_method_check',
      );
      expect(
        proposalCode.match(
          /ADD CONSTRAINT checkout_attempts_payment_method_check/g,
        ),
      ).toHaveLength(1);
      expect(proposalCode).toContain(
        "payment_method_snapshot->>'method' = 'agency_direct'",
      );
      // La rama agency_direct aparece exactamente una vez: en el CHECK.
      // El estampado del UPDATE usa jsonb_build_object, no ->>.
      expect(
        proposalCode.match(
          /payment_method_snapshot->>'method' = 'agency_direct'/g,
        ),
      ).toHaveLength(1);
      expect(proposalCode).toContain('NOT VALID');
    });

    it('conserva la proteccion MKT-007.4: pending_review exige id NO NULL o snapshot agency_direct', () => {
      const checkIndex = proposalCode.indexOf(
        'ADD CONSTRAINT checkout_attempts_payment_method_check',
      );
      const strictIndex = proposalCode.indexOf(
        "status <> 'pending_review'",
        checkIndex,
      );
      const idIndex = proposalCode.indexOf(
        'payment_method_id IS NOT NULL',
        checkIndex,
      );
      const snapshotIndex = proposalCode.indexOf(
        'payment_method_snapshot IS NOT NULL',
        checkIndex,
      );
      expect(strictIndex).toBeGreaterThan(checkIndex);
      expect(idIndex).toBeGreaterThan(strictIndex);
      expect(snapshotIndex).toBeGreaterThan(idIndex);
    });

    it('el CHECK original de 089 sigue intacto en Tour (092 no lo edita)', () => {
      expect(checkSql).toContain(
        "CHECK (status <> 'pending_review' OR payment_method_id IS NOT NULL)",
      );
    });
  });

  describe('submit_checkout_proof: firma, bloque 5b y estampado', () => {
    it('es la misma firma de 087 con SECURITY DEFINER y search_path explicito', () => {
      expect(proposalSql).toContain(
        'CREATE OR REPLACE FUNCTION public.submit_checkout_proof(',
      );
      expect(proposalSql).toContain('p_attempt_id UUID');
      expect(proposalSql).toContain('p_customer_id UUID');
      expect(proposalSql).toContain('p_idempotency_key UUID');
      expect(proposalSql).toContain('p_proof_path TEXT');
      expect(proposalSql).toContain('p_payment_reference TEXT');
      expect(proposalSql).toContain('p_bank_origin TEXT');
      expect(proposalSql).toContain('p_payment_datetime TIMESTAMPTZ');
      expect(proposalSql).toContain('RETURNS JSONB');
      expect(proposalSql).toContain('LANGUAGE plpgsql');
      expect(proposalSql).toContain('SECURITY DEFINER');
      expect(proposalSql).toContain('SET search_path = public');
    });

    it('el bloque 5b solo corre en el PRIMER envio (proof_count = 0) y sin canal elegido', () => {
      expect(proposalCode).toContain(
        'IF v_attempt.payment_method_id IS NULL AND v_attempt.proof_count = 0 THEN',
      );
      // En reenvios el modo congelado lo acredita el snapshot: el bloque
      // (y su consulta de canales) no se ejecuta.
    });

    it('la consulta de canales exige los filtros de publicacion con agency_id del intento', () => {
      expect(proposalCode).toContain('FROM public.agency_payment_methods apm');
      expect(proposalCode).toContain('apm.agency_id = v_attempt.agency_id');
      expect(proposalCode).toContain("apm.method = 'pago_movil'");
      expect(proposalCode).toContain('apm.is_active');
      expect(proposalCode).toContain('apm.deleted_at IS NULL');
    });

    it('si la agencia tiene canales activos rechaza con ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED', () => {
      // Dos RAISE exactos: (1) snapshot huerfano de metodo real, (2)
      // agencia con canales activos. (El texto del codigo tambien aparece
      // en el COMMENT ON FUNCTION; por eso se cuentan solo los RAISE.)
      expect(
        proposalCode.match(
          /RAISE EXCEPTION 'ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED/g,
        ),
      ).toHaveLength(2);
      expect(proposalCode).toContain(
        "RAISE EXCEPTION 'ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED: Select a payment method before submitting the proof'",
      );
    });

    it('B1: el guard de snapshot huerfano va ANTES de estampar y del UPDATE', () => {
      const blockIndex = proposalCode.indexOf(
        'IF v_attempt.payment_method_id IS NULL AND v_attempt.proof_count = 0 THEN',
      );
      const orphanGuardIndex = proposalCode.indexOf(
        'IF v_attempt.payment_method_snapshot IS NOT NULL',
        blockIndex,
      );
      const orphanConditionIndex = proposalCode.indexOf(
        "v_attempt.payment_method_snapshot->>'method' IS DISTINCT FROM 'agency_direct'",
        blockIndex,
      );
      const channelsIndex = proposalCode.indexOf(
        'FROM public.agency_payment_methods apm',
        blockIndex,
      );
      const stampIndex = proposalCode.indexOf(
        'v_agency_direct := true',
        blockIndex,
      );
      const caseIndex = proposalCode.indexOf(
        'WHEN v_agency_direct AND ca.payment_method_snapshot IS NULL',
      );

      expect(orphanGuardIndex).toBeGreaterThan(blockIndex);
      expect(orphanConditionIndex).toBeGreaterThan(orphanGuardIndex);
      expect(channelsIndex).toBeGreaterThan(orphanConditionIndex);
      expect(stampIndex).toBeGreaterThan(channelsIndex);
      expect(caseIndex).toBeGreaterThan(stampIndex);
    });

    it('el estampado agency_direct y su entrada de history solo ocurren si el snapshot aun no existe', () => {
      expect(proposalCode).toContain(
        'WHEN v_agency_direct AND ca.payment_method_snapshot IS NULL',
      );
      expect(proposalCode).toContain("'kind', 'payment_method'");
      expect(proposalCode).toContain("'method', 'agency_direct'");
      expect(proposalCode).toContain("'snapshot_version', 1");
      // Solo hay UN jsonb_build_object que estampa method agency_direct en
      // el UPDATE (el del CASE); el del history usa 'method', 'agency_direct'.
      expect(
        proposalCode.match(/'method', 'agency_direct'/g),
      ).toHaveLength(2);
    });

    it('conserva el resto de 087: idempotencia, locks, conciliacion y prolongacion', () => {
      expect(proposalCode).toContain("e->>'kind' = 'submission'");
      expect(proposalCode).toContain('mkt007:');
      expect(proposalCode).toContain('FOR UPDATE');
      expect(proposalCode).toContain('ORDER BY s.id');
      expect(proposalCode).toContain("interval '24 hours'");
      expect(proposalCode).toContain('NULLIF(btrim(COALESCE(p_payment_reference');
      expect(proposalCode).toContain('ERR_CHECKOUT_IDEMPOTENCY_CONFLICT');
      expect(proposalCode).toContain('ERR_CHECKOUT_LOCK_EXPIRED');
      expect(proposalCode).toContain('ERR_CHECKOUT_RECONCILIATION');
    });

    it('la RPC solo es executable por service_role', () => {
      const signature =
        'public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ)';
      expect(proposalSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`,
      );
      expect(proposalSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM anon`,
      );
      expect(proposalSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM authenticated`,
      );
      expect(proposalSql).toContain(
        `GRANT EXECUTE ON FUNCTION ${signature} TO service_role`,
      );
      expect(proposalSql).not.toMatch(
        /GRANT EXECUTE ON FUNCTION public\.submit_checkout_proof[\s\S]*TO (anon|authenticated)/,
      );
    });
  });

  describe('rollback: restauracion exacta de 089 + 087', () => {
    it('restaura el CHECK estricto de 089 sin la rama agency_direct', () => {
      expect(rollbackCode).toContain(
        'DROP CONSTRAINT IF EXISTS checkout_attempts_payment_method_check',
      );
      expect(rollbackCode).toContain(
        "CHECK (status <> 'pending_review' OR payment_method_id IS NOT NULL)",
      );
      expect(rollbackCode).toContain('NOT VALID');
      expect(rollbackCode).not.toContain('agency_direct');
    });

    it('el cuerpo restaurado de submit_checkout_proof es IDENTICO al de 087', () => {
      const rollbackBody = normalizeSql(extractSubmitBody(rollbackSql));
      const baseBody = normalizeSql(extractSubmitBody(baseSql));
      expect(rollbackBody).toBe(baseBody);
    });

    it('la propuesta 092 si difiere del cuerpo base de 087 (adiciones presentes)', () => {
      const proposalBody = normalizeSql(extractSubmitBody(proposalSql));
      const baseBody = normalizeSql(extractSubmitBody(baseSql));
      expect(proposalBody).not.toBe(baseBody);
      expect(proposalBody).toContain('v_agency_direct');
    });

    it('el rollback no ejecuta DML a nivel de migracion (sin DELETE/INSERT/UPDATE/TRUNCATE)', () => {
      // Elimina los cuerpos de funciones (el cuerpo restaurado SI contiene
      // UPDATE: es parte del codigo de 087, no escrituras de la migracion).
      const migrationLevel = rollbackSql
        .replace(/AS \$\$[\s\S]*?\$\$;/g, '')
        .replace(/--.*$/gm, '');
      expect(migrationLevel).not.toMatch(/\bDELETE\b/i);
      expect(migrationLevel).not.toMatch(/\bINSERT\b/i);
      expect(migrationLevel).not.toMatch(/\bUPDATE\b/i);
      expect(migrationLevel).not.toMatch(/\bTRUNCATE\b/i);
      expect(migrationLevel).not.toMatch(/DROP\s+TABLE/i);
      expect(migrationLevel).not.toMatch(/audit_log/i);
    });

    it('el rollback conserva los grants service_role de 087', () => {
      const signature =
        'public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ)';
      expect(rollbackSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`,
      );
      expect(rollbackSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM anon`,
      );
      expect(rollbackSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM authenticated`,
      );
      expect(rollbackSql).toContain(
        `GRANT EXECUTE ON FUNCTION ${signature} TO service_role`,
      );
    });
  });
});
