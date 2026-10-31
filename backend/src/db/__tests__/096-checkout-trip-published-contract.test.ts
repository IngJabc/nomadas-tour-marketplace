import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
// DEPENDENCIA CROSS-REPO EXPLICITA (TRIP-PUB-001.2, mismo patron que 092):
// las migraciones viven en el repo hermano nomadas-tour (autoridad del
// esquema). Marketplace NO copia SQL de Tour. Este contrato lee
// EXCLUSIVAMENTE los archivos oficiales 096, su rollback y la base 087.
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
const migrationFilename = '096_checkout_trip_published_check.sql';
const rollbackFilename = '096_checkout_trip_published_check_rollback.sql';
const baseFilename = '087_checkout_attempts.sql';
const migrationPath = join(tourMigrationsDirectory, migrationFilename);
const rollbackPath = join(tourRollbacksDirectory, rollbackFilename);
const basePath = join(tourMigrationsDirectory, baseFilename);

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

/** Extrae el cuerpo AS $$ ... $$; de create_checkout_attempt en un SQL. */
function extractCreateAttemptBody(sql: string): string {
  const fnIndex = sql.indexOf(
    'CREATE OR REPLACE FUNCTION public.create_checkout_attempt(',
  );
  expect(fnIndex).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $$', fnIndex);
  expect(bodyStart).toBeGreaterThan(-1);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  expect(bodyEnd).toBeGreaterThan(-1);
  return sql.slice(bodyStart + 'AS $$'.length, bodyEnd);
}

const SIGNATURE =
  'public.create_checkout_attempt(UUID, UUID, UUID, UUID[], JSONB, UUID)';

// NOTA DE VALIDACION (TRIP-PUB-001.2): esta prueba es ESTATICA sobre el
// texto de 087/096 oficial de Tour. No abre una base de datos: NO demuestra
// comportamiento de locks reales de PostgreSQL (la concurrencia se
// verifica en staging). Lo que SI demuestra es que la validacion de
// is_published vive DENTRO del cuerpo de la funcion SQL, no solo en
// TypeScript: si alguien la elimina o la mueve al backend, este contrato
// falla.
describe('096 checkout trip published contract (TRIP-PUB-001.2)', () => {
  const migrationSql = readSql(migrationPath);
  const rollbackSql = readSql(rollbackPath);
  const baseSql = readSql(basePath);
  const migrationCode = stripComments(migrationSql);
  const rollbackCode = stripComments(rollbackSql);
  const baseCode = stripComments(baseSql);

  describe('archivos y ubicacion cross-repo', () => {
    it('resuelve los repos hermanos y encuentra 096, rollback y 087', () => {
      expect(
        existsSync(tourMigrationsDirectory),
        `No se encontro ${tourMigrationsDirectory}. Marketplace y nomadas-tour deben vivir como directorios hermanos.`,
      ).toBe(true);
      expect(
        existsSync(tourRollbacksDirectory),
        `No se encontro ${tourRollbacksDirectory}.`,
      ).toBe(true);
      expect(existsSync(migrationPath), `Falta la migracion ${migrationPath}`).toBe(true);
      expect(existsSync(rollbackPath), `Falta el rollback ${rollbackPath}`).toBe(true);
      expect(existsSync(basePath), `Falta la base ${basePath}`).toBe(true);
      expect(migrationSql.length).toBeGreaterThan(0);
      expect(rollbackSql.length).toBeGreaterThan(0);
    });

    it('exactamente UNA migracion de Tour implementa la validacion (agnostico al prefijo)', () => {
      // Deteccion por IMPLEMENTACION efectiva (cuerpo de la funcion, sin
      // comentarios): v_trip_is_published solo existe dentro de
      // create_checkout_attempt si 096 esta aplicado. Una migracion
      // duplicada rompe la asercion.
      const implementors = readdirSync(tourMigrationsDirectory)
        .filter((filename) => filename.endsWith('.sql'))
        .filter((filename) =>
          stripComments(readSql(join(tourMigrationsDirectory, filename))).includes(
            'v_trip_is_published BOOLEAN',
          ),
        );
      expect(
        implementors,
        `Se esperaba exactamente una implementacion de v_trip_is_published; encontradas: ${
          implementors.join(', ') || '(ninguna)'
        }`,
      ).toEqual([migrationFilename]);
    });
  });

  describe('create_checkout_attempt: validacion transaccional', () => {
    it('conserva la firma exacta, SECURITY DEFINER y search_path de 087', () => {
      expect(migrationSql).toContain(
        'CREATE OR REPLACE FUNCTION public.create_checkout_attempt(',
      );
      expect(migrationSql).toContain('p_trip_id UUID');
      expect(migrationSql).toContain('p_customer_id UUID');
      expect(migrationSql).toContain('p_agency_id UUID');
      expect(migrationSql).toContain('p_seat_ids UUID[]');
      expect(migrationSql).toContain('p_passenger_data JSONB');
      expect(migrationSql).toContain('p_idempotency_key UUID');
      expect(migrationSql).toContain('RETURNS JSONB');
      expect(migrationSql).toContain('LANGUAGE plpgsql');
      expect(migrationSql).toContain('SECURITY DEFINER');
      expect(migrationSql).toContain('SET search_path = public');
      // La firma declarada en COMMENT/REVOKE/GRANT es la misma de 087.
      expect(migrationSql).toContain(`COMMENT ON FUNCTION ${SIGNATURE} IS`);
      expect(baseSql).toContain(`COMMENT ON FUNCTION ${SIGNATURE} IS`);
    });

    it('lee t.is_published y bloquea la fila del viaje con FOR UPDATE', () => {
      // El nucleo de la garantia: la columna se lee DENTRO de la funcion y
      // la fila queda bloqueada hasta el fin de la transaccion.
      expect(migrationCode).toContain(
        'SELECT t.status, t.departure_time, t.seat_price, t.is_published',
      );
      expect(migrationCode).toContain(
        'INTO v_trip_status, v_departure, v_unit_price, v_trip_is_published',
      );
      const tripSelectIndex = migrationCode.indexOf('FROM public.trips t');
      expect(tripSelectIndex).toBeGreaterThan(-1);
      const tripLockIndex = migrationCode.indexOf('FOR UPDATE', tripSelectIndex);
      expect(tripLockIndex).toBeGreaterThan(tripSelectIndex);
      // ...y el lock del viaje (paso 3) va ANTES que el de seats (paso 5):
      // orden trips -> seats, sin ciclos de deadlock.
      const seatsIndex = migrationCode.indexOf('FROM public.seats s');
      expect(seatsIndex).toBeGreaterThan(tripLockIndex);
      expect(migrationCode).toContain('ORDER BY s.id');
    });

    it('rechaza con ERR_TRIP_NOT_PUBLISHED dentro del cuerpo SQL, tras status y antes de departure', () => {
      // La validacion ocurre en la funcion SQL (no en TypeScript): el RAISE
      // existe exactamente una vez y en el orden que preserva los errores
      // actuales de los viajes no activos.
      expect(
        migrationCode.match(
          /RAISE EXCEPTION 'ERR_TRIP_NOT_PUBLISHED/g,
        ),
      ).toHaveLength(1);
      const statusIndex = migrationCode.indexOf(
        "RAISE EXCEPTION 'ERR_TRIP_NOT_ACTIVE",
      );
      const publishedIndex = migrationCode.indexOf(
        "RAISE EXCEPTION 'ERR_TRIP_NOT_PUBLISHED",
      );
      const departedIndex = migrationCode.indexOf(
        "RAISE EXCEPTION 'ERR_TRIP_DEPARTED",
      );
      expect(statusIndex).toBeGreaterThan(-1);
      expect(publishedIndex).toBeGreaterThan(statusIndex);
      expect(departedIndex).toBeGreaterThan(publishedIndex);
      expect(migrationCode).toContain(
        'IF v_trip_is_published IS DISTINCT FROM true THEN',
      );
      // La validacion esta ANTES de cualquier escritura: si falla, no se
      // crea checkout_attempt ni se estampa ningun asiento.
      const insertIndex = migrationCode.indexOf('INSERT INTO public.checkout_attempts');
      const seatsUpdateIndex = migrationCode.indexOf('UPDATE public.seats s');
      expect(publishedIndex).toBeLessThan(insertIndex);
      expect(publishedIndex).toBeLessThan(seatsUpdateIndex);
    });

    it('nunca escribe trips (ni status) ni crea triggers', () => {
      // 096 solo REEMPLAZA la funcion: jamas hace DML sobre public.trips
      // ni toca trips.status (lo gestiona nomadas-tour).
      expect(migrationCode).not.toMatch(/UPDATE\s+public\.trips/i);
      expect(migrationCode).not.toMatch(/INSERT\s+INTO\s+public\.trips/i);
      expect(migrationCode).not.toMatch(/DELETE\s+FROM\s+public\.trips/i);
      expect(migrationCode).not.toMatch(/\bCREATE\s+TRIGGER\b/i);
      expect(migrationCode).not.toMatch(/\bDROP\s+COLUMN\b/i);
      // 095 (columna) no se toca: 096 no altera el esquema, solo la funcion.
      expect(migrationCode).not.toMatch(/\bALTER\s+TABLE\b/i);
      expect(migrationCode).not.toMatch(/\bCREATE\s+TABLE\b/i);
    });

    it('conserva idempotencia 5b (set de asientos) y 5c (Idempotency-Key)', () => {
      expect(migrationCode).toContain("v_key_ns := 'mkt007:'");
      expect(migrationCode).toContain('ERR_CHECKOUT_IDEMPOTENCY_CONFLICT');
      expect(migrationCode).toContain('ERR_CHECKOUT_SEAT_CLAIMED');
      expect(migrationCode).toContain("'idempotent', true");
      expect(migrationCode).toContain("'idempotent', false");
      // El 5b devuelve el intento existente sin crear otro.
      expect(migrationCode).toContain('v_existing.status NOT IN');
      // Ninguna validacion nueva se colo por delante de la idempotencia:
      // el camino idempotente sigue estando tras el lock de asientos.
      const keyIndex = migrationCode.indexOf("v_key_ns := 'mkt007:'");
      const insertIndex = migrationCode.indexOf('INSERT INTO public.checkout_attempts');
      expect(keyIndex).toBeGreaterThan(-1);
      expect(insertIndex).toBeGreaterThan(keyIndex);
    });

    it('conserva las validaciones y RAISE originales de 087', () => {
      const raiss = [
        'ERR_CUSTOMER_REQUIRED',
        'ERR_CHECKOUT_INPUT',
        'ERR_NO_SEATS',
        'ERR_SEAT_DUPLICATE',
        'ERR_PASSENGER_MISMATCH',
        'ERR_PASSENGER_DATA',
        'ERR_PASSENGER_DUPLICATE_DOCUMENT',
        'ERR_TRIP_NOT_FOUND',
        'ERR_TRIP_NOT_ACTIVE',
        'ERR_TRIP_DEPARTED',
        'ERR_TRIP_PRICE_MISSING',
        'ERR_AGENCY_NOT_ASSIGNED',
        'ERR_SEAT_NOT_OWNED',
        'ERR_SEAT_LOCK_EXPIRED',
        'ERR_SEAT_NOT_FOUND',
      ];
      for (const code of raiss) {
        expect(
          migrationCode,
          `falta el RAISE original ${code} en 096`,
        ).toContain(`RAISE EXCEPTION '${code}`);
        expect(
          baseCode,
          `el RAISE ${code} no existe en 087 (contradiccion)`,
        ).toContain(`RAISE EXCEPTION '${code}`);
      }
      // Lock de asientos identico: FOR UPDATE con orden estable.
      expect(migrationCode).toContain('ORDER BY s.id\n    FOR UPDATE');
      // Snapshot comercial e INSERT/UPDATE de ownership intactos.
      expect(migrationCode).toContain('INSERT INTO public.checkout_attempts (');
      expect(migrationCode).toContain('SET checkout_attempt_id = v_attempt_id');
      expect(migrationCode).toContain('GET DIAGNOSTICS v_rowcount = ROW_COUNT');
    });

    it('la RPC solo es executable por service_role (igual que 087)', () => {
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC`,
      );
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${SIGNATURE} FROM anon`,
      );
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${SIGNATURE} FROM authenticated`,
      );
      expect(migrationSql).toContain(
        `GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role`,
      );
      expect(migrationSql).not.toMatch(
        /GRANT EXECUTE ON FUNCTION public\.create_checkout_attempt[\s\S]*TO (anon|authenticated)/,
      );
      // Los grants de 087 y 096 son textualmente los mismos.
      expect(normalizeSql(migrationSql.slice(migrationSql.indexOf('REVOKE ALL')))).toContain(
        `GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role`,
      );
      expect(baseSql).toContain(
        `GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role`,
      );
    });

    it('096 si difiere del cuerpo base de 087 (adiciones presentes)', () => {
      const migrationBody = normalizeSql(extractCreateAttemptBody(migrationSql));
      const baseBody = normalizeSql(extractCreateAttemptBody(baseSql));
      expect(migrationBody).not.toBe(baseBody);
      expect(migrationBody).toContain('v_trip_is_published');
      expect(migrationBody).toContain('ERR_TRIP_NOT_PUBLISHED');
      expect(baseBody).not.toContain('is_published');
      expect(baseBody).not.toContain('ERR_TRIP_NOT_PUBLISHED');
    });
  });

  describe('rollback: restauracion exacta de 087', () => {
    it('el cuerpo restaurado de create_checkout_attempt es IDENTICO al de 087', () => {
      const rollbackBody = normalizeSql(extractCreateAttemptBody(rollbackSql));
      const baseBody = normalizeSql(extractCreateAttemptBody(baseSql));
      expect(rollbackBody).toBe(baseBody);
    });

    it('el rollback no conserva la validacion ni el lock del viaje', () => {
      const rollbackBody = normalizeSql(extractCreateAttemptBody(rollbackSql));
      expect(rollbackBody).not.toContain('is_published');
      expect(rollbackBody).not.toContain('ERR_TRIP_NOT_PUBLISHED');
      // La lectura del viaje vuelve a ser sin FOR UPDATE (carrera 087).
      const tripSelect = rollbackBody.slice(
        rollbackBody.indexOf('FROM public.trips t'),
      );
      expect(
        tripSelect.slice(0, tripSelect.indexOf('IF NOT FOUND')),
      ).not.toContain('FOR UPDATE');
      // ...pero el lock de asientos se conserva (era previo a 096).
      expect(rollbackBody).toContain('ORDER BY s.id FOR UPDATE');
    });

    it('el rollback no ejecuta DML a nivel de migracion', () => {
      // Elimina los cuerpos de funciones (el cuerpo restaurado SI contiene
      // UPDATE: es parte del codigo de 087, no escrituras de la migracion),
      // luego los literales de string (el COMMENT ON FUNCTION del 087
      // menciona "FOR UPDATE" dentro de su texto descriptivo) y por ultimo
      // los comentarios de linea.
      const migrationLevel = rollbackSql
        .replace(/AS \$\$[\s\S]*?\$\$;/g, '')
        .replace(/'(?:[^']|'')*'/g, '')
        .replace(/--.*$/gm, '');
      expect(migrationLevel).not.toMatch(/\bDELETE\b/i);
      expect(migrationLevel).not.toMatch(/\bINSERT\b/i);
      expect(migrationLevel).not.toMatch(/\bUPDATE\b/i);
      expect(migrationLevel).not.toMatch(/\bTRUNCATE\b/i);
      expect(migrationLevel).not.toMatch(/DROP\s+COLUMN/i);
      expect(migrationLevel).not.toMatch(/ALTER\s+TABLE/i);
      expect(migrationLevel).not.toMatch(/audit_log/i);
    });

    it('el rollback conserva COMMENT y grants service_role de 087', () => {
      expect(rollbackSql).toContain(`COMMENT ON FUNCTION ${SIGNATURE} IS`);
      expect(rollbackSql).toContain(
        `REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC`,
      );
      expect(rollbackSql).toContain(
        `REVOKE ALL ON FUNCTION ${SIGNATURE} FROM anon`,
      );
      expect(rollbackSql).toContain(
        `REVOKE ALL ON FUNCTION ${SIGNATURE} FROM authenticated`,
      );
      expect(rollbackSql).toContain(
        `GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role`,
      );
      // El COMMENT restaurado es el original MKT-007 (sin TRIP-PUB-001.2).
      expect(rollbackSql).toContain("'MKT-007: crea UN checkout_attempt");
      expect(rollbackSql).not.toContain('TRIP-PUB-001.2: crea UN checkout');
    });
  });
});
