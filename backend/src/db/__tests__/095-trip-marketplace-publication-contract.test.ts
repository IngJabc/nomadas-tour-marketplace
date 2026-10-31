import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
// DEPENDENCIA CROSS-REPO EXPLICITA (mismo patron que 092): las migraciones
// viven en el repo hermano nomadas-tour (autoridad del esquema). Este
// contrato lee EXCLUSIVAMENTE el archivo oficial 095.
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
const migrationFilename = '095_trip_marketplace_publication.sql';
const migrationPath = join(tourMigrationsDirectory, migrationFilename);

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

// NOTA DE VALIDACION (TRIP-PUB-001): esta prueba es ESTATICA sobre el texto
// de 095 oficial de Tour. No abre una base de datos: NO demuestra
// comportamiento de PostgreSQL. La verificacion contra BD real (que las
// filas existentes nazcan publicadas) ocurre en staging.
describe('095 trip marketplace publication contract (TRIP-PUB-001)', () => {
  it('resuelve el repo hermano y encuentra la migracion oficial 095', () => {
    // Resolucion explicita: si los repos no son directorios hermanos,
    // fallar mostrando el path resuelto (nunca un fallback en silencio).
    expect(
      existsSync(tourMigrationsDirectory),
      `No se encontro ${tourMigrationsDirectory}. Marketplace y nomadas-tour deben vivir como directorios hermanos.`,
    ).toBe(true);
    expect(
      existsSync(migrationPath),
      `Falta la migracion oficial ${migrationPath}`,
    ).toBe(true);
    const tourMigrations = readdirSync(tourMigrationsDirectory)
      .filter((filename) => filename.endsWith('.sql'))
      .sort();
    expect(tourMigrations).toContain(migrationFilename);
  });

  it('agrega is_published BOOLEAN NOT NULL DEFAULT true a public.trips', () => {
    const code = normalizeSql(readSql(migrationPath));
    expect(code).toContain(
      'ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT true;',
    );
  });

  it('el default true preserva los viajes existentes: sin backfill ni UPDATE', () => {
    const sql = readSql(migrationPath);
    const code = normalizeSql(sql);
    // DEFAULT true + NOT NULL: toda fila existente queda publicada al aplicar.
    expect(code).toContain('NOT NULL DEFAULT true');
    // La migracion solo ALTERa la tabla y comenta la columna: jamas escribe
    // filas ni toca datos operativos.
    expect(code).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
    expect(code).not.toMatch(/\bCREATE\s+TABLE\b/i);
  });

  it('no modifica trips.status ni crea triggers, funciones o publicaciones', () => {
    const code = normalizeSql(readSql(migrationPath));
    // La separacion publicacion/estado operativo es la invariant central:
    // 095 jamas escribe trips.status (lo gestiona nomadas-tour).
    expect(code).not.toMatch(/UPDATE\s+public\.trips/i);
    expect(code).not.toMatch(/\bstatus\s*=/i);
    expect(code).not.toMatch(/\bCREATE\s+TRIGGER\b/i);
    expect(code).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i);
    expect(code).not.toMatch(/\bCREATE\s+PUBLICATION\b/i);
  });

  it('exactly una migracion de Tour declara la columna is_published (agnostico al prefijo)', () => {
    // Deteccion por IMPLEMENTACION efectiva: una migracion duplicada o una
    // segunda columna de publicacion rompen esta asercion.
    const tourMigrations = readdirSync(tourMigrationsDirectory).filter(
      (filename) => filename.endsWith('.sql'),
    );
    const declaring = tourMigrations.filter((filename) =>
      normalizeSql(readSql(join(tourMigrationsDirectory, filename))).includes(
        'ADD COLUMN IF NOT EXISTS is_published',
      ),
    );
    expect(declaring).toEqual([migrationFilename]);
  });
});
