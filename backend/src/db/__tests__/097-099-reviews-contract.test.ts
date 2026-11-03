import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
// DEPENDENCIA CROSS-REPO EXPLICITA (REV-001, mismo patron que 092/096):
// las migraciones viven en el repo hermano nomadas-tour (autoridad del
// esquema). Marketplace NO copia SQL de Tour. Este contrato lee
// EXCLUSIVAMENTE los archivos oficiales 097, 098, 099 y sus rollbacks.
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

const filenames = {
  m097: '097_trip_completed_at.sql',
  r097: '097_trip_completed_at_rollback.sql',
  m098: '098_review_invitations.sql',
  r098: '098_review_invitations_rollback.sql',
  m099: '099_trip_agency_reviews.sql',
  r099: '099_trip_agency_reviews_rollback.sql',
};

function readSql(filename: string): string {
  return readFileSync(join(tourMigrationsDirectory, filename), 'utf8');
}

function readRollbackSql(filename: string): string {
  return readFileSync(join(tourRollbacksDirectory, filename), 'utf8');
}

/** Quita comentarios SQL (-- ... y bloques) para inspeccionar solo codigo. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
}

const sql097 = readSql(filenames.m097);
const sql098 = readSql(filenames.m098);
const sql099 = readSql(filenames.m099);
const rb097 = readRollbackSql(filenames.r097);
const rb098 = readRollbackSql(filenames.r098);
const rb099 = readRollbackSql(filenames.r099);

const code097 = stripComments(sql097);
const code098 = stripComments(sql098);
const code099 = stripComments(sql099);

describe('REV-001 — archivos y ubicacion cross-repo', () => {
  it('resuelve nomadas-tour como repo hermano y encuentra 097/098/099 + rollbacks', () => {
    expect(
      existsSync(tourMigrationsDirectory),
      `No se encontro ${tourMigrationsDirectory}. Marketplace y nomadas-tour deben vivir como directorios hermanos.`,
    ).toBe(true);
    for (const [key, name] of Object.entries(filenames)) {
      // Las claves de rollback son exactamente las que empiezan con 'r'
      // (r097/r098/r099); el resto (m097/m098/m099) son migraciones.
      const path = key.startsWith('r')
        ? join(tourRollbacksDirectory, name)
        : join(tourMigrationsDirectory, name);
      expect(existsSync(path), `Falta el archivo ${name} (${path})`).toBe(true);
    }
  });
});

// ── 097: completed_at con trigger cobertor de TODOS los paths ────────────────

describe('097 — trips.completed_at (base de la ventana de 48 h)', () => {
  it('agrega la columna completed_at sin backfill', () => {
    expect(sql097).toContain('ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL');
    // Prohibido fabricar timestamps historicos: no hay UPDATE de backfill.
    expect(code097).not.toMatch(/UPDATE\s+public\.trips\s+SET\s+completed_at/i);
  });

  it('estampa completed_at solo en la transicion a completed, preserva en archived y limpia al reabrir', () => {
    expect(sql097).toContain('CREATE OR REPLACE FUNCTION public.trips_set_completed_at()');
    // Transicion hacia completed: NEW.completed_at := NOW().
    expect(code097).toContain(
      "NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed'",
    );
    expect(code097).toContain('NEW.completed_at := NOW()');
    // Completed o ARCHIVED (terminal: 057 archive_trip permite
    // completed -> archived): preserva el instante original; archivar
    // jamas borra la marca de la ventana de reseña.
    expect(code097).toContain("ELSIF NEW.status IN ('completed', 'archived')");
    expect(code097).toContain('NEW.completed_at := OLD.completed_at');
    // Viaje que REABRE (vuelve a active/cancelled): limpia la marca.
    expect(code097).toContain('NEW.completed_at := NULL');
  });

  it('el trigger vive en la TABLA (cubre set_trip_status, complete_trip y el UPDATE directo del worker)', () => {
    expect(sql097).toContain('DROP TRIGGER IF EXISTS trg_trips_set_completed_at ON public.trips');
    expect(sql097).toContain('CREATE TRIGGER trg_trips_set_completed_at');
    expect(sql097).toContain('BEFORE UPDATE ON public.trips');
    expect(sql097).toContain('EXECUTE FUNCTION public.trips_set_completed_at()');
    // No toca outbox ni notificaciones: solo estampa la columna.
    expect(code097).not.toMatch(/INSERT\s+INTO\s+public\.(outbox|notifications)/i);
  });

  it('el rollback elimina trigger, funcion y columna (idempotente)', () => {
    expect(rb097).toContain('DROP TRIGGER IF EXISTS trg_trips_set_completed_at');
    expect(rb097).toContain('DROP FUNCTION IF EXISTS public.trips_set_completed_at()');
    expect(rb097).toContain('DROP COLUMN IF EXISTS completed_at');
  });
});

// ── 098: invitaciones idempotentes + notificaciones de cliente ───────────────

describe('098 — review_requests + customer_notifications', () => {
  it('review_requests es UNICA por reservation_id (una invitacion por reserva)', () => {
    expect(sql098).toContain('CREATE TABLE public.review_requests');
    // La unicidad vive en la propia columna (no como constraint separado).
    expect(code098).toMatch(/reservation_id UUID\s*(NOT NULL\s*)?UNIQUE/);
  });

  it('la expiracion se deriva de trips.completed_at + 48 h, NUNCA de invited_at', () => {
    // generate_review_requests calcula expires_at desde t.completed_at.
    expect(code098).toContain('v_res.completed_at + v_window');
    // Prohibido: invited_at + 48 h como base de la ventana.
    expect(code098).not.toMatch(/invited_at\s*\+\s*(interval\s*)?'48 hours'/i);
    expect(code098).not.toMatch(/invited_at\s*\+\s*v_window/i);
  });

  it('la generacion es idempotente (ON CONFLICT sobre reservation_id) y acotada', () => {
    expect(code098).toContain('ON CONFLICT (reservation_id) DO NOTHING');
    expect(code098).toContain('LIMIT 500');
    // Lista inclusiva de estados confirmados: incluye 'partial' (estado
    // de boarding compartido con Tour) y excluye locked y cancelled.
    expect(code098).toContain("r.source = 'marketplace'");
    expect(code098).toContain(
      "r.status IN ('reserved', 'confirmed', 'completed', 'boarded', 'partial')",
    );
    // No invitar a reservas ya reseñadas. El filtro vive en una
    // sentencia plpgsql SEPARADA bajo IF to_regclass (lazy-prepare):
    // un sublink inline se analiza siempre y abortaria el lote con
    // "relation trip_reviews does not exist" si 099 aun no esta
    // aplicada, por lo que 098 debe funcionar pre-099.
    expect(code098).toContain("IF to_regclass('public.trip_reviews') IS NOT NULL THEN");
    expect(code098).toMatch(
      /IF to_regclass\('public\.trip_reviews'\) IS NOT NULL THEN\s*SELECT EXISTS \(\s*SELECT 1 FROM public\.trip_reviews/,
    );
    expect(code098).toContain('CONTINUE');
  });

  it('los fallos por reserva se contabilizan y loguean (nunca en silencio)', () => {
    expect(code098).toContain('v_failed INTEGER := 0');
    expect(code098).toContain('v_failed := v_failed + 1');
    expect(code098).toContain("RAISE LOG 'generate_review_requests: reservation % fallo: %'");
    // El contador sale en el JSONB para que el caller lo detecte.
    expect(code098).toContain("'failed', v_failed");
    // El WHEN OTHERS no aborta el lote (solo cuenta + loguea).
    expect(code098).toMatch(/WHEN others THEN\s*v_failed := v_failed \+ 1/);
  });

  it('expira las pendientes vencidas en la misma RPC', () => {
    expect(code098).toContain("SET status = 'expired'");
    expect(code098).toContain("WHERE status = 'pending'");
    expect(code098).toContain('expires_at <= NOW()');
  });

  it('la RPC es SECURITY DEFINER ejecutable SOLO por service_role', () => {
    expect(sql098).toContain('CREATE OR REPLACE FUNCTION public.generate_review_requests()');
    expect(sql098).toContain('SECURITY DEFINER');
    expect(sql098).toContain('SET search_path = public');
    expect(sql098).toContain(
      'REVOKE ALL ON FUNCTION public.generate_review_requests() FROM authenticated',
    );
    expect(sql098).toContain(
      'GRANT EXECUTE ON FUNCTION public.generate_review_requests() TO service_role',
    );
  });

  it('habilita RLS y prohibe escritura directa de authenticated en ambas tablas', () => {
    expect(sql098).toContain('ALTER TABLE public.review_requests ENABLE ROW LEVEL SECURITY');
    expect(sql098).toContain(
      'ALTER TABLE public.customer_notifications ENABLE ROW LEVEL SECURITY',
    );
    expect(sql098).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE public.review_requests FROM authenticated',
    );
    expect(sql098).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE public.customer_notifications FROM authenticated',
    );
    // Excepcion DELIMITADA a nivel de COLUMNA: el cliente solo marca
    // read_at de lo suyo (RLS por si sola no restringe columnas).
    expect(sql098).toContain(
      'GRANT UPDATE (read_at) ON TABLE public.customer_notifications TO authenticated',
    );
    // El cliente solo LEE lo suyo.
    expect(sql098).toContain('customer_id = auth.uid()');
  });

  it('notifica al cliente con action_url interna (no un token)', () => {
    expect(code098).toContain("'review_pending'");
    expect(code098).toContain("'/account/reviews/' || v_res.reservation_id::text");
  });

  it('el rollback elimina funciones, tablas y los UNIQUE habilitadores', () => {
    expect(rb098).toContain('DROP FUNCTION IF EXISTS public.generate_review_requests()');
    expect(rb098).toContain('DROP TABLE IF EXISTS public.review_requests');
    expect(rb098).toContain('DROP TABLE IF EXISTS public.customer_notifications');
    expect(rb098).toContain('DROP CONSTRAINT IF EXISTS reservations_id_trip_id_unique');
    expect(rb098).toContain('DROP CONSTRAINT IF EXISTS reservations_id_customer_id_unique');
    expect(rb098).toContain('DROP CONSTRAINT IF EXISTS reservations_id_agency_id_unique');
  });
});

// ── 099: reseñas, envio atomico y moderacion auditada ────────────────────────

describe('099 — trip_reviews + agency_reviews + RPCs', () => {
  it('cada tabla es UNICA por reservation_id y valida rating 1..5', () => {
    expect(sql099).toContain('CREATE TABLE public.trip_reviews');
    expect(sql099).toContain('CREATE TABLE public.agency_reviews');
    expect(code099).toMatch(/reservation_id UUID\s*(NOT NULL\s*)?UNIQUE/);
    expect(code099).toContain('CHECK (rating >= 1 AND rating <= 5)');
    // Comentario opcional con largo acotado.
    expect(code099).toContain('char_length(comment) <= 2000');
  });

  it('submit_reservation_reviews valida TODO antes de escribir y usa valores del servidor', () => {
    expect(sql099).toContain(
      'CREATE OR REPLACE FUNCTION public.submit_reservation_reviews(',
    );
    expect(sql099).toContain('SECURITY DEFINER');
    expect(sql099).toContain('SET search_path = public');
    // Ownership: la reserva debe pertenecer al cliente invocador.
    expect(code099).toContain('ERR_REVIEW_NOT_OWNER');
    // Fuente marketplace; excluye locked/cancelled.
    expect(code099).toContain("v_reservation.source IS DISTINCT FROM 'marketplace'");
    expect(code099).toContain("v_reservation.status IN ('locked', 'cancelled')");
    // Viaje completado + completed_at presente + dentro de la ventana.
    expect(code099).toContain('ERR_REVIEW_TRIP_NOT_COMPLETED');
    expect(code099).toContain('ERR_REVIEW_NO_COMPLETION_TIMESTAMP');
    expect(code099).toContain('v_trip.completed_at + v_window <= NOW()');
    // El lock de la reserva serializa envios concurrentes.
    expect(code099).toContain('FOR UPDATE');
  });

  it('el envio es ATOMICO: dos inserts + invitation + dos auditorias en UNA funcion', () => {
    const fnBody = code099.slice(
      code099.indexOf('CREATE OR REPLACE FUNCTION public.submit_reservation_reviews('),
    );
    const tripInsert = fnBody.indexOf('INSERT INTO public.trip_reviews');
    const agencyInsert = fnBody.indexOf('INSERT INTO public.agency_reviews');
    const inviteUpdate = fnBody.indexOf('UPDATE public.review_requests');
    const auditOne = fnBody.indexOf('INSERT INTO public.audit_log');
    const auditTwo = fnBody.indexOf('INSERT INTO public.audit_log', auditOne + 1);
    expect(tripInsert).toBeGreaterThan(-1);
    expect(agencyInsert).toBeGreaterThan(tripInsert);
    expect(inviteUpdate).toBeGreaterThan(agencyInsert);
    expect(auditOne).toBeGreaterThan(inviteUpdate);
    expect(auditTwo).toBeGreaterThan(auditOne);
    // Ningun BEGIN/COMMIT interno: la atomicidad la garantiza la transaccion
    // de la llamada (una exception revierte TODO incluida la auditoria).
    expect(fnBody).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/);
    // Idempotencia: si ya existen las dos reseñas, las devuelve sin reescribir.
    expect(code099).toContain("'already_submitted', true");
    // M4: el chequeo de idempotencia ocurre ANTES de los chequeos de
    // viaje/ventana: un reintento tardio (tras cerrar la ventana)
    // devuelve already_submitted, no un falso WINDOW_EXPIRED.
    const idemPos = fnBody.indexOf("'already_submitted', true");
    expect(idemPos).toBeGreaterThan(-1);
    expect(idemPos).toBeLessThan(fnBody.indexOf('ERR_REVIEW_TRIP_NOT_COMPLETED'));
    expect(idemPos).toBeLessThan(fnBody.indexOf('ERR_REVIEW_WINDOW_EXPIRED'));
    // ...y despues del lock de la reserva y del ownership (nunca se
    // filtra existencia de reseñas ajenas).
    expect(idemPos).toBeGreaterThan(fnBody.indexOf('FOR UPDATE'));
    expect(idemPos).toBeGreaterThan(fnBody.indexOf('ERR_REVIEW_NOT_OWNER'));
  });

  it('trip_id/agency_id/customer_id se derivan de la RESERVA, nunca del cliente', () => {
    // Los valores insertados salen de v_reservation (SELECT ... FOR UPDATE).
    expect(code099).toContain('p_reservation_id, v_reservation.trip_id, v_reservation.customer_id');
    expect(code099).toContain(
      'p_reservation_id, v_reservation.agency_id, v_reservation.trip_id',
    );
  });

  it('la auditoria usa review.created y las entidades trip_review/agency_review', () => {
    expect(code099).toContain("'review.created'");
    expect(code099).toContain("'trip_review'");
    expect(code099).toContain("'agency_review'");
    // actor customer: INSERT directo (audit_append lo rechaza desde 065).
    expect(code099).toContain("'customer'");
  });

  it('ampliacion ADDITIVA de audit_log con guard de migraciones desconocidas', () => {
    expect(sql099).toContain('ERR_099_ACTION_GUARD');
    expect(sql099).toContain('ERR_099_ENTITY_GUARD');
    // Estado VIVO previo a 099 (definido por 091): 087 + 089
    // agency_payment_method + 091 agency_contact. Los GUARDS deben
    // conocer TODO lo vivo (29 acciones / 10 entidades) o la migracion
    // abortaria al aplicarse sobre una BD real.
    const firstKnown = code099.indexOf('v_known TEXT[]');
    const secondKnown = code099.indexOf('v_known TEXT[]', firstKnown + 1);
    expect(firstKnown).toBeGreaterThan(-1);
    expect(secondKnown).toBeGreaterThan(-1);
    const actionGuard = code099.slice(firstKnown, code099.indexOf('BEGIN', firstKnown));
    const entityGuard = code099.slice(secondKnown, code099.indexOf('BEGIN', secondKnown));
    expect(actionGuard).toContain("'agency_payment_method.primary_set'");
    expect(actionGuard).toContain("'agency_contact.deleted'");
    expect(actionGuard).toContain("'review.moderated'");
    expect(entityGuard).toContain("'agency_payment_method'");
    expect(entityGuard).toContain("'agency_contact'");
    expect(entityGuard).toContain("'agency_review'");
    // Conteos REALES de los arrays de guard (no comentarios): 31 / 12.
    expect([...actionGuard.matchAll(/'[^']+'/g)].map((m) => m[0])).toHaveLength(31);
    expect([...entityGuard.matchAll(/'[^']+'/g)].map((m) => m[0])).toHaveLength(12);
    // ADD CONSTRAINT: mismas 31 acciones / 12 entidades que los guards.
    const addActions = code099.match(/action IN \(([^)]*)\)/);
    const addEntities = code099.match(/entity_type IN \(([^)]*)\)/);
    expect(addActions).not.toBeNull();
    expect(addEntities).not.toBeNull();
    expect([...addActions![1].matchAll(/'[^']+'/g)]).toHaveLength(31);
    expect([...addEntities![1].matchAll(/'[^']+'/g)]).toHaveLength(12);
    // Procedencia documentada en los COMMENT.
    expect(sql099).toContain('+ 089 agency_payment_method (4) + 091 agency_contact (3)');
    expect(sql099).toContain('+ 089 agency_payment_method (1) + 091 agency_contact (1)');
  });

  it('moderate_review valida el actor superadmin y audita en la MISMA transaccion', () => {
    expect(sql099).toContain('CREATE OR REPLACE FUNCTION public.moderate_review(');
    expect(code099).toContain('ERR_REVIEW_ADMIN_ROLE');
    // Lee el rol de public.users (no confia en el caller).
    expect(code099).toContain('FROM public.users u');
    expect(code099).toContain("v_actor.role IS DISTINCT FROM 'superadmin'");
    // Acciones permitidas: hide/reject/restore; preserva el contenido.
    expect(code099).toContain("p_action NOT IN ('hide', 'reject', 'restore')");
    expect(code099).toContain("'review.moderated'");
    // Solo UPDATE de estado de moderacion; rating/comment intactos.
    const moderateBody = code099.slice(
      code099.indexOf('CREATE OR REPLACE FUNCTION public.moderate_review('),
    );
    expect(moderateBody).not.toMatch(/SET[\s\S]*?rating\s*=/);
    expect(moderateBody).not.toMatch(/SET[\s\S]*?comment\s*=/);
  });

  it('RLS habilitada: cliente LEE lo suyo, publico solo visibles, sin escritura directa', () => {
    expect(sql099).toContain('ALTER TABLE public.trip_reviews ENABLE ROW LEVEL SECURITY');
    expect(sql099).toContain('ALTER TABLE public.agency_reviews ENABLE ROW LEVEL SECURITY');
    expect(sql099).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.trip_reviews FROM authenticated');
    expect(sql099).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.agency_reviews FROM authenticated');
    // Lectura publica SOLO de visibles.
    expect(code099).toContain("moderation_status = 'visible'");
  });

  it('ambas RPCs son service_role only', () => {
    expect(sql099).toContain(
      'REVOKE ALL ON FUNCTION public.submit_reservation_reviews(UUID, UUID, INTEGER, TEXT, INTEGER, TEXT) FROM authenticated',
    );
    expect(sql099).toContain(
      'GRANT EXECUTE ON FUNCTION public.submit_reservation_reviews(UUID, UUID, INTEGER, TEXT, INTEGER, TEXT) TO service_role',
    );
    expect(sql099).toContain(
      'REVOKE ALL ON FUNCTION public.moderate_review(TEXT, UUID, TEXT, UUID, TEXT) FROM authenticated',
    );
    expect(sql099).toContain(
      'GRANT EXECUTE ON FUNCTION public.moderate_review(TEXT, UUID, TEXT, UUID, TEXT) TO service_role',
    );
  });

  it('el rollback elimina tablas/RPCs y restaura los CHECK de 091 (quita solo lo de 099)', () => {
    expect(rb099).toContain('DROP FUNCTION IF EXISTS public.submit_reservation_reviews');
    expect(rb099).toContain('DROP FUNCTION IF EXISTS public.moderate_review');
    expect(rb099).toContain('DROP TABLE IF EXISTS public.trip_reviews');
    expect(rb099).toContain('DROP TABLE IF EXISTS public.agency_reviews');
    // CHECK restaurados al estado VIVO de 091 (29 acciones / 10
    // entidades: 087 + agency_payment_method + agency_contact) SIN los
    // valores de review. Conteos REALES de los literales.
    const rbActions = rb099.match(/action IN \(([^)]*)\)/);
    const rbEntities = rb099.match(/entity_type IN \(([^)]*)\)/);
    expect(rbActions).not.toBeNull();
    expect(rbEntities).not.toBeNull();
    expect([...rbActions![1].matchAll(/'[^']+'/g)]).toHaveLength(29);
    expect([...rbEntities![1].matchAll(/'[^']+'/g)]).toHaveLength(10);
    expect(rb099).toContain("'checkout.cancelled'");
    expect(rb099).toContain("'agency_payment_method.deleted'");
    expect(rb099).toContain("'agency_contact.deleted'");
    expect(rb099).toContain("'checkout_attempt'");
    expect(rb099).toContain("'agency_payment_method'");
    expect(rb099).toContain("'agency_contact'");
    expect(stripComments(rb099)).not.toContain("'review.created'");
    expect(stripComments(rb099)).not.toContain("'trip_review'");
  });
});

// ── Cohesion entre 097/098/099 ───────────────────────────────────────────────

describe('REV-001 — cohesión de la ventana de 48 h', () => {
  it('097, 098 y 099 usan la misma ventana (48 hours) y la base es completed_at', () => {
    for (const [name, code] of [
      ['098', code098],
      ['099', code099],
    ] as const) {
      expect(code, `${name} debe fijar la ventana en 48 hours`).toContain(
        "interval '48 hours'",
      );
    }
    // 098 mide contra t.completed_at; 099 contra v_trip.completed_at.
    expect(code098).toContain('t.completed_at + v_window > NOW()');
    expect(code099).toContain('v_trip.completed_at + v_window <= NOW()');
  });

  it('exactamente UNA migracion crea generate_review_requests (agnostico al prefijo)', () => {
    const implementors = readdirSync(tourMigrationsDirectory)
      .filter((filename) => filename.endsWith('.sql'))
      .filter((filename) =>
        stripComments(readFileSync(join(tourMigrationsDirectory, filename), 'utf8')).includes(
          'FUNCTION public.generate_review_requests()',
        ),
      );
    expect(implementors).toEqual([filenames.m098]);
  });

  it('las tres migraciones prohiben BEGIN/COMMIT (single-statement por archivo)', () => {
    // Plpgsql guarda BEGIN/END dentro de cuerpos $$...$$; se eliminan esos
    // cuerpos antes de buscar control de transacciones de nivel superior.
    const stripDollarBodies = (code: string) =>
      code.replace(/\$\$[\s\S]*?\$\$/g, '$$BODY$$');
    for (const [name, code] of [
      ['097', code097],
      ['098', code098],
      ['099', code099],
    ] as const) {
      expect(
        stripDollarBodies(code),
        `${name} no debe contener BEGIN/COMMIT puro`,
      ).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/m);
    }
  });
});
