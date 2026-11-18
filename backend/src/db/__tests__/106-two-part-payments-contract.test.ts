import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
// DEPENDENCIA CROSS-REPO EXPLICITA (MKT-010.1, mismo patron que 092/096):
// las migraciones viven en el repo hermano nomadas-tour (autoridad del
// esquema). Marketplace NO copia SQL de Tour. Este contrato lee
// EXCLUSIVAMENTE el archivo oficial 106.
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
const migrationFilename = '106_two_part_payments.sql';
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

/** Cuerpo AS $$ ... $$; de una funcion concreta de 106. */
function extractFunctionBody(sql: string, name: string): string {
  const fnIndex = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(fnIndex, `no se encontro public.${name} en 106`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $$', fnIndex);
  expect(bodyStart).toBeGreaterThan(-1);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  expect(bodyEnd).toBeGreaterThan(-1);
  return sql.slice(bodyStart + 'AS $$'.length, bodyEnd);
}

/** Cabecera CREATE ... hasta AS $$ (firma + clausulas de seguridad). */
function extractFunctionHeader(sql: string, name: string): string {
  const fnIndex = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(fnIndex, `no se encontro public.${name} en 106`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $$', fnIndex);
  expect(bodyStart).toBeGreaterThan(-1);
  return sql.slice(fnIndex, bodyStart);
}

/** Extrae una lista de literales SQL ('a', 'b', ...) de un bloque. */
function extractQuotedList(text: string): string[] {
  return text.match(/'[^']+'/g) ?? [];
}

const FUNCTIONS: Array<{ name: string; signature: string }> = [
  {
    name: 'set_trip_payment_plan',
    signature:
      'public.set_trip_payment_plan(UUID, UUID, BOOLEAN, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ)',
  },
  {
    name: 'create_checkout_attempt',
    signature: 'public.create_checkout_attempt(UUID, UUID, UUID, UUID[], JSONB, UUID)',
  },
  { name: 'verify_checkout_attempt', signature: 'public.verify_checkout_attempt(UUID, UUID)' },
  {
    name: 'verify_marketplace_payment',
    signature: 'public.verify_marketplace_payment(UUID, UUID)',
  },
  {
    name: 'reject_marketplace_payment',
    signature: 'public.reject_marketplace_payment(UUID, UUID, TEXT)',
  },
  {
    name: 'submit_reservation_balance_payment',
    signature:
      'public.submit_reservation_balance_payment(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ)',
  },
  { name: 'reservation_payment_progress', signature: 'public.reservation_payment_progress(UUID, UUID)' },
];

// NOTA DE VALIDACION (MKT-010.1): esta prueba es ESTATICA sobre el texto
// de 106 oficial de Tour. No abre una base de datos: NO demuestra
// comportamiento de locks reales de PostgreSQL (la concurrencia se
// verifica en staging). Lo que SI demuestra es que el plan en dos partes
// vive DENTRO del SQL (montos, etapas, ownership, guardas de
// cancelacion), no solo en TypeScript: si alguien elimina o debilita una
// de estas garantias, este contrato falla.
describe('106 two-part payments contract (MKT-010.1)', () => {
  const migrationSql = readSql(migrationPath);
  const migrationCode = stripComments(migrationSql);

  describe('archivo y ubicacion cross-repo', () => {
    it('resuelve el repo hermano y encuentra la migracion 106', () => {
      expect(
        existsSync(tourMigrationsDirectory),
        `No se encontro ${tourMigrationsDirectory}. Marketplace y nomadas-tour deben vivir como directorios hermanos.`,
      ).toBe(true);
      expect(existsSync(migrationPath), `Falta la migracion ${migrationPath}`).toBe(true);
      expect(migrationSql.length).toBeGreaterThan(0);
    });

    it('es UTF-8 sin BOM y sin marcadores @@EXTRACT', () => {
      const raw = readFileSync(migrationPath);
      const hasBom =
        raw.length >= 3 &&
        raw[0] === 0xef &&
        raw[1] === 0xbb &&
        raw[2] === 0xbf;
      expect(hasBom, '106 no debe llevar BOM UTF-8').toBe(false);
      expect(migrationSql).not.toContain('@@EXTRACT');
      // Los bytes se re-leen como utf8 valido (sin caracteres de reemplazo).
      expect(raw.toString('utf8').includes('\ufffd')).toBe(false);
    });

    it('define exactamente las 7 funciones del plan en dos partes', () => {
      const creates = migrationSql.match(/^CREATE OR REPLACE FUNCTION /gm) ?? [];
      expect(creates).toHaveLength(FUNCTIONS.length);
      for (const fn of FUNCTIONS) {
        expect(
          migrationSql,
          `falta CREATE de ${fn.name}`,
        ).toContain(`CREATE OR REPLACE FUNCTION public.${fn.name}(`);
      }
    });
  });

  describe('esquema: columnas y constraints', () => {
    it('agrega los dos vencimientos a trips con guarda ambos-o-ninguno y orden', () => {
      expect(migrationCode).toContain(
        'ADD COLUMN IF NOT EXISTS deposit_deadline TIMESTAMPTZ',
      );
      expect(migrationCode).toContain(
        'ADD COLUMN IF NOT EXISTS balance_deadline TIMESTAMPTZ',
      );
      expect(migrationCode).toContain('trips_payment_deadlines_check');
      // Ambos o ninguno...
      expect(migrationCode).toContain(
        '(deposit_deadline IS NULL AND balance_deadline IS NULL)',
      );
      // ...y deposito nunca posterior al saldo.
      expect(migrationCode).toContain('deposit_deadline <= balance_deadline');
    });

    it('congela el plan en checkout_attempts con default legado single', () => {
      expect(migrationCode).toContain(
        "ADD COLUMN IF NOT EXISTS payment_plan TEXT NOT NULL DEFAULT 'single'",
      );
      expect(migrationCode).toContain('checkout_attempts_payment_plan_check');
      expect(migrationCode).toContain("payment_plan IN ('single', 'two_stage')");
      expect(migrationCode).toContain(
        'ADD COLUMN IF NOT EXISTS deposit_cents INTEGER',
      );
      // Coherencia: single lleva deposito NULL (las filas legadas de 078
      // cumplen sin data migration) y two_stage exige importe positivo.
      expect(migrationCode).toContain(
        "(payment_plan = 'single' AND deposit_cents IS NULL)",
      );
      expect(migrationCode).toContain(
        "(payment_plan = 'two_stage' AND deposit_cents > 0)",
      );
    });

    it('etiqueta cada pago con exactamente tres etapas (sin cuotas)', () => {
      expect(migrationCode).toContain(
        "ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'full'",
      );
      expect(migrationCode).toContain('payments_stage_check');
      expect(migrationCode).toContain("stage IN ('full', 'deposit', 'balance')");
      // Exactamente TRES etapas: sin cuotas ni etapas nuevas.
      const stageListStart = migrationCode.indexOf('stage IN (');
      expect(stageListStart).toBeGreaterThan(-1);
      const stageListEnd = migrationCode.indexOf(')', stageListStart);
      const stageValues = extractQuotedList(
        migrationCode.slice(stageListStart, stageListEnd),
      );
      expect(stageValues).toEqual(["'full'", "'deposit'", "'balance'"]);
    });

    it('no ejecuta DML a nivel de migracion ni destruye datos legados', () => {
      // Elimina cuerpos de funciones, el bloque DO (guarda, sin DML),
      // los literales de string (COMMENT ON ...) y los comentarios.
      const migrationLevel = migrationSql
        .replace(/AS \$\$[\s\S]*?\$\$;/g, '')
        .replace(/DO \$\$[\s\S]*?\$\$;/g, '')
        .replace(/'(?:[^']|'')*'/g, '')
        .replace(/--.*$/gm, '');
      expect(migrationLevel).not.toMatch(/\bINSERT\b/i);
      expect(migrationLevel).not.toMatch(/\bUPDATE\b/i);
      expect(migrationLevel).not.toMatch(/\bDELETE\b/i);
      expect(migrationLevel).not.toMatch(/\bTRUNCATE\b/i);
      expect(migrationLevel).not.toMatch(/DROP\s+TABLE/i);
      expect(migrationLevel).not.toMatch(/DROP\s+COLUMN/i);
      expect(migrationLevel).not.toMatch(/\bCREATE\s+TRIGGER\b/i);
      // Legacy intacto: no se reescriben los intentos existentes.
      expect(migrationCode).not.toMatch(
        /UPDATE\s+public\.checkout_attempts\s+SET\s+payment_plan/i,
      );
    });
  });

  describe('audit_log: guarda 106 + payment.submitted', () => {
    it('la guarda corre ANTES de sustituir el CHECK y aborta ante acciones desconocidas', () => {
      const guardIndex = migrationCode.indexOf('DO $$');
      const dropIndex = migrationCode.indexOf(
        'DROP CONSTRAINT IF EXISTS audit_log_action_check',
      );
      expect(guardIndex).toBeGreaterThan(-1);
      expect(dropIndex).toBeGreaterThan(guardIndex);
      expect(migrationCode).toContain('ERR_106_ACTION_GUARD');
      expect(migrationCode).toContain(
        'mergear manualmente antes de aplicar 106',
      );
    });

    it('el CHECK nuevo contiene EXACTAMENTE las 32 acciones (31 de 099 + payment.submitted)', () => {
      const guardStart = migrationCode.indexOf('v_known TEXT[] := ARRAY[');
      expect(guardStart).toBeGreaterThan(-1);
      const guardEnd = migrationCode.indexOf('];', guardStart);
      const guardList = extractQuotedList(
        migrationCode.slice(guardStart, guardEnd),
      );

      const constraintStart = migrationCode.indexOf(
        'ADD CONSTRAINT audit_log_action_check CHECK (',
      );
      expect(constraintStart).toBeGreaterThan(-1);
      const constraintEnd = migrationCode.indexOf(
        'COMMENT ON CONSTRAINT audit_log_action_check',
        constraintStart,
      );
      const constraintList = extractQuotedList(
        migrationCode.slice(constraintStart, constraintEnd),
      );

      expect(guardList).toHaveLength(32);
      expect(constraintList).toHaveLength(32);
      expect([...constraintList].sort()).toEqual([...guardList].sort());
      expect(constraintList).toContain("'payment.submitted'");
      // La accion del envio de saldo es la UNICA novedad de 106.
      expect(
        constraintList.filter((action) => action === "'payment.submitted'"),
      ).toHaveLength(1);
    });
  });

  describe('set_trip_payment_plan: validacion de la agencia', () => {
    const header = extractFunctionHeader(migrationSql, 'set_trip_payment_plan');
    const body = normalizeSql(
      extractFunctionBody(migrationSql, 'set_trip_payment_plan'),
    );

    it('es SECURITY DEFINER con search_path y grants solo service_role', () => {
      expect(header).toContain('RETURNS JSONB');
      expect(header).toContain('LANGUAGE plpgsql');
      expect(header).toContain('SECURITY DEFINER');
      expect(header).toContain('SET search_path = public');
      const signature = FUNCTIONS[0].signature;
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`,
      );
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM anon`,
      );
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM authenticated`,
      );
      expect(migrationSql).toContain(
        `GRANT EXECUTE ON FUNCTION ${signature} TO service_role`,
      );
    });

    it('valida importe, precio y vencimientos con RAISEs propios', () => {
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PLAN_INPUT: p_enabled es obligatorio (true/false)'",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PLAN_DEPOSIT: El deposito debe ser un importe mayor a cero (centavos)'",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PLAN_PRICE: El viaje necesita precio por asiento",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PLAN_DEPOSIT: El deposito por pasajero debe ser menor que el precio por asiento'",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PLAN_DEADLINES: Ambos vencimientos son obligatorios (deposito y saldo)'",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PLAN_DEADLINES: El vencimiento del deposito no puede ser posterior al vencimiento del saldo'",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PLAN_DEADLINES: El vencimiento del deposito debe estar en el futuro'",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PLAN_DEADLINES: El vencimiento del saldo no puede ser posterior al dia de la salida'",
      );
    });

    it('resuelve rol y agencia EN LA BD y bloquea el viaje con FOR UPDATE', () => {
      expect(body).toContain(
        'SELECT * INTO v_actor FROM public.users WHERE id = p_actor_user_id',
      );
      expect(body).toContain("IF v_actor.role <> 'agency' THEN");
      expect(body).toContain('SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE');
      expect(body).toContain("IF v_trip.status <> 'active' THEN");
    });

    it('audita la configuracion con trip.updated explicita', () => {
      // El trigger de 065 no cubre las columnas del plan: 106 audita aqui.
      expect(body).toContain("'trip.updated'");
      expect(body).toContain("'trigger', 'set_trip_payment_plan'");
      expect(body).toContain("'field', 'payment_plan'");
    });
  });

  describe('create_checkout_attempt: calculo server-side del plan', () => {
    const body = normalizeSql(
      extractFunctionBody(migrationSql, 'create_checkout_attempt'),
    );

    it('lee AMBOS vencimientos con la misma columna que bloquea el viaje (FOR UPDATE)', () => {
      expect(body).toContain(
        't.installment_allowed, t.installment_amount_cents, t.deposit_deadline, t.balance_deadline',
      );
      expect(body).toContain(
        'v_installment_allowed, v_installment_amount, v_deposit_deadline, v_balance_deadline',
      );
      // El lock del viaje (paso 3) va ANTES del INSERT del intento.
      const lockIndex = body.indexOf('FROM public.trips t WHERE t.id = p_trip_id FOR UPDATE');
      const insertIndex = body.indexOf('INSERT INTO public.checkout_attempts');
      expect(lockIndex).toBeGreaterThan(-1);
      expect(insertIndex).toBeGreaterThan(lockIndex);
    });

    it('exige AMBOS vencimientos para two_stage y cae a single si falta cualquiera', () => {
      expect(body).toContain(
        'IF v_installment_allowed IS TRUE AND v_installment_amount IS NOT NULL AND v_installment_amount > 0 AND v_installment_amount < v_unit_price AND v_deposit_deadline IS NOT NULL AND v_balance_deadline IS NOT NULL THEN v_payment_plan := \'two_stage\';',
      );
      // Fallback que protege el legado 078 (filas sin estas columnas).
      expect(body).toContain(
        "ELSE v_payment_plan := 'single'; v_deposit_cents := NULL; END IF;",
      );
      // En two_stage el importe del intento es el DEPOSITO; en single el total.
      expect(body).toContain(
        "v_amount := CASE WHEN v_payment_plan = 'two_stage' THEN v_deposit_cents ELSE v_total_amount END;",
      );
      expect(body).toContain('v_payment_plan, v_deposit_cents');
    });

    it('devuelve el plan congelado al cliente (passthrough, no recalculado)', () => {
      expect(body).toContain("'payment_plan', v_payment_plan");
      expect(body).toContain("'deposit_cents', v_deposit_cents");
      expect(body).toContain(
        "'deposit_deadline', CASE WHEN v_payment_plan = 'two_stage' THEN v_deposit_deadline ELSE NULL END",
      );
      expect(body).toContain(
        "'balance_deadline', CASE WHEN v_payment_plan = 'two_stage' THEN v_balance_deadline ELSE NULL END",
      );
      expect(body).toContain("'idempotent', true");
    });
  });

  describe('verify_checkout_attempt: aprueba el DEPOSITO en dos partes', () => {
    const body = normalizeSql(
      extractFunctionBody(migrationSql, 'verify_checkout_attempt'),
    );

    it('valida el deposito congelado antes de crear la reserva', () => {
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_CHECKOUT_AMOUNT_INVALID: Two-stage attempt has no deposit amount'",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_CHECKOUT_AMOUNT_INVALID: Deposit must be smaller than the full total'",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_CHECKOUT_AMOUNT_INVALID: Deposit does not divide evenly across passengers'",
      );
      expect(body).toContain(
        'v_expected_amount := v_deposit_cents; v_payment_status := \'partial\';',
      );
    });

    it('two_stage deja la reserva partial; single conserva fully_paid legado', () => {
      expect(body).toContain(
        "v_payment_status := 'partial'",
      );
      expect(body).toContain(
        "v_payment_status := 'fully_paid'",
      );
      // Etapa del pago insertado: deposito en dos partes, full en legado.
      expect(body).toContain(
        "CASE WHEN v_payment_plan = 'two_stage' THEN 'deposit' ELSE 'full' END",
      );
      // La reserva nace con el estado calculado (nunca fully_paid a ciegas).
      expect(body).toContain('v_payment_status');
    });

    it('los asientos pasan a reserved en AMBOS planes y jamas se liberan aqui', () => {
      expect(body).toContain("SET status = 'reserved'");
      expect(body).not.toContain("SET status = 'available'");
      expect(body).not.toContain("payment_status = 'cancelled'");
    });
  });

  describe('verify_marketplace_payment: cobra el SALDO exacto', () => {
    const body = normalizeSql(
      extractFunctionBody(migrationSql, 'verify_marketplace_payment'),
    );

    it('stage=balance exige exactamente el saldo restante (ni mas ni menos)', () => {
      expect(body).toContain(
        'v_balance_expected := v_total_expected - v_already_allocated;',
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_BALANCE_ALREADY_SETTLED: The reservation balance is already settled'",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_VERIFY_AMOUNT: Payment amount % does not match the outstanding balance %'",
      );
      // Legado full: importe = total.
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_VERIFY_AMOUNT: Payment amount % does not match expected total %'",
      );
    });

    it('las allocations del saldo cubren el resto por pasajero', () => {
      expect(body).toContain(
        "CASE WHEN v_stage = 'balance' THEN rp.unit_price - COALESCE(alloc.allocated, 0) ELSE rp.unit_price END",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_VERIFY_ALLOC_TOTAL: Created % cents of allocations, expected %'",
      );
    });

    it('fully_paid solo al cubrir el total (ambas etapas verificadas)', () => {
      expect(body).toContain("SET payment_status = 'fully_paid'");
      expect(body).toContain("AND r.source = 'marketplace'");
    });
  });

  describe('reject_marketplace_payment: NUNCA auto-cancela por saldo', () => {
    const body = normalizeSql(
      extractFunctionBody(migrationSql, 'reject_marketplace_payment'),
    );

    it('la cancelacion exige pago total (stage full) sin otros pagos verificados', () => {
      expect(body).toContain(
        "IF v_other_verified_count = 0 AND v_stage = 'full' THEN",
      );
      // El camino ELSE (otros abonos O etapa saldo) solo rechaza el pago.
      expect(body).toContain(
        "v_cancelled_reservation := false; v_outcome := 'rejected_only';",
      );
    });

    it('liberar asientos y cancelar la reserva vive SOLO tras el guard de stage full', () => {
      const guardIndex = body.indexOf(
        "IF v_other_verified_count = 0 AND v_stage = 'full' THEN",
      );
      expect(guardIndex).toBeGreaterThan(-1);
      const seatsIndex = body.indexOf("UPDATE public.seats s SET status = 'available'");
      const reservationIndex = body.indexOf(
        "UPDATE public.reservations r SET status = 'cancelled'",
      );
      expect(seatsIndex).toBeGreaterThan(guardIndex);
      expect(reservationIndex).toBeGreaterThan(guardIndex);
      // Exactamente UNA liberacion de asientos en toda la funcion.
      expect(body.split("SET status = 'available'")).toHaveLength(2);
    });

    it('el rechazo recalcula payment_status sin tocar el estado de la reserva', () => {
      expect(body).toContain('IF NOT v_cancelled_reservation THEN');
      expect(body).toContain("SET payment_status = v_new_payment_status");
      expect(body).toContain("RAISE EXCEPTION 'ERR_PAYMENT_REJECT_RACE");
      expect(body).toContain("'stage', v_stage");
    });
  });

  describe('submit_reservation_balance_payment: envio del saldo (etapa 2)', () => {
    const header = extractFunctionHeader(
      migrationSql,
      'submit_reservation_balance_payment',
    );
    const body = normalizeSql(
      extractFunctionBody(migrationSql, 'submit_reservation_balance_payment'),
    );
    const signature =
      'public.submit_reservation_balance_payment(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ)';

    it('recibe los datos de conciliacion NUNCA un importe (lo calcula la BD)', () => {
      expect(header).toContain('p_reservation_id UUID');
      expect(header).toContain('p_customer_id UUID');
      expect(header).toContain('p_idempotency_key UUID');
      expect(header).toContain('p_proof_path TEXT');
      expect(header).toContain('p_payment_reference TEXT');
      expect(header).toContain('p_bank_origin TEXT');
      expect(header).toContain('p_payment_datetime TIMESTAMPTZ');
      expect(header).not.toContain('p_amount');
      expect(header).not.toContain('amount_cents');
      // El saldo restante se deriva server-side.
      expect(body).toContain('v_balance := v_total - v_paid;');
    });

    it('es SECURITY DEFINER y solo ejecutable por service_role', () => {
      expect(header).toContain('RETURNS JSONB');
      expect(header).toContain('LANGUAGE plpgsql');
      expect(header).toContain('SECURITY DEFINER');
      expect(header).toContain('SET search_path = public');
      expect(migrationSql).toContain(
        `COMMENT ON FUNCTION ${signature} IS`,
      );
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`,
      );
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM anon`,
      );
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM authenticated`,
      );
      expect(migrationSql).toContain(
        `GRANT EXECUTE ON FUNCTION ${signature} TO service_role`,
      );
    });

    it('usa namespace mkt010_1 con el idempotency key del cliente', () => {
      expect(body).toContain(
        "v_namespace := 'mkt010_1:' || p_reservation_id::text || ':' || p_idempotency_key::text;",
      );
      expect(body).toContain("'idempotent', true");
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_IDEMPOTENCY_CONFLICT: Idempotency key reused with a different submission'",
      );
    });

    it('exige que el comprobante viva dentro del directorio de la RESERVA', () => {
      expect(body).toContain("v_path_prefix := p_reservation_id::text || '/';");
      expect(body).toContain(
        'left(p_proof_path, length(v_path_prefix)) <> v_path_prefix',
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_INPUT: p_proof_path must live inside the reservation directory'",
      );
    });

    it('mapea los RAISEs de negocio y de ownership', () => {
      const raisses = [
        'ERR_BALANCE_NOT_AVAILABLE: No verified deposit exists for this reservation',
        'ERR_BALANCE_ALREADY_SETTLED: The reservation balance is already settled',
        'ERR_BALANCE_PAYMENT_PENDING: A balance payment is already under review',
        'ERR_PAYMENT_RECONCILIATION: payment datetime is required',
        'ERR_PAYMENT_RECONCILIATION: payment reference is required (max 100 characters)',
        'ERR_PAYMENT_RECONCILIATION: bank origin is required (max 120 characters)',
        'ERR_PAYMENT_RESERVATION_NOT_FOUND: Reservation not found',
        'ERR_PAYMENT_NOT_OWNER: The reservation does not belong to this customer',
      ];
      for (const code of raisses) {
        expect(body, `falta el RAISE ${code}`).toContain(
          `RAISE EXCEPTION '${code}'`,
        );
      }
      // El bloqueo de la reserva y de los pasajeros es de LECTURA.
      expect(body).toContain('FOR UPDATE');
    });

    it('audita payment.submitted con actor system y el cliente en metadata', () => {
      expect(body).toContain('PERFORM public.audit_append(');
      expect(body).toContain("'payment.submitted'");
      expect(body).toContain("'trigger', 'mkt010_1_balance'");
      expect(body).toContain("'stage', 'balance'");
      // actor system con actor_user_id NULL (guard de 065).
      expect(body).toContain("'system'");
      expect(body).toContain("'customer_id', p_customer_id");
    });

    it('SOLO inserta en payments: jamas escribe reservations ni seats', () => {
      const bodyCode = stripComments(
        extractFunctionBody(migrationSql, 'submit_reservation_balance_payment'),
      );
      // Unico DML de la funcion: el INSERT del pago.
      expect(bodyCode).toContain('INSERT INTO public.payments');
      const insertCount = (bodyCode.match(/INSERT INTO public\./g) ?? []).length;
      expect(insertCount).toBe(1);
      expect(bodyCode).not.toMatch(/UPDATE\s+public\.reservations/i);
      expect(bodyCode).not.toMatch(/INSERT\s+INTO\s+public\.reservations/i);
      expect(bodyCode).not.toMatch(/UPDATE\s+public\.seats/i);
      expect(bodyCode).not.toMatch(/INSERT\s+INTO\s+public\.seats/i);
      expect(bodyCode).not.toMatch(/UPDATE\s+public\.reservation_passengers/i);
      expect(bodyCode).not.toMatch(/DELETE\s+FROM/i);
      expect(bodyCode).not.toContain("status = 'cancelled'");
      expect(bodyCode).not.toContain("SET status = 'available'");
    });
  });

  describe('reservation_payment_progress: progreso server-side del cliente', () => {
    const header = extractFunctionHeader(
      migrationSql,
      'reservation_payment_progress',
    );
    const body = normalizeSql(
      extractFunctionBody(migrationSql, 'reservation_payment_progress'),
    );
    const signature = 'public.reservation_payment_progress(UUID, UUID)';

    it('acepta customer_id opcional (cliente) o sin el (backend/agencia)', () => {
      expect(header).toContain('p_reservation_id UUID');
      expect(header).toContain('p_customer_id UUID DEFAULT NULL');
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`,
      );
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM anon`,
      );
      expect(migrationSql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM authenticated`,
      );
      expect(migrationSql).toContain(
        `GRANT EXECUTE ON FUNCTION ${signature} TO service_role`,
      );
    });

    it('exige ownership cuando llega customer_id (RAISE uniforme)', () => {
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PROGRESS_INPUT: p_reservation_id is required'",
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PROGRESS_NOT_FOUND: Reservation not found'",
      );
      expect(body).toContain(
        'IF p_customer_id IS NOT NULL AND v_reservation.customer_id IS DISTINCT FROM p_customer_id THEN',
      );
      expect(body).toContain(
        "RAISE EXCEPTION 'ERR_PAYMENT_PROGRESS_AMOUNT: Reservation has no consistent active passenger amounts'",
      );
    });

    it('montos, porcentajes y saldo se calculan en la BD', () => {
      expect(body).toContain(
        "v_deposit_pct := ROUND((v_deposit_cents * 100.0) / v_total)::INTEGER;",
      );
      expect(body).toContain('v_balance_pct := 100 - v_deposit_pct;');
      expect(body).toContain('v_balance := GREATEST(v_total - v_paid, 0);');
      // Snapshot de pasajeros, nunca trips.seat_price en vivo.
      expect(body).toContain('SUM(rp.unit_price)');
    });

    it('seats_held informa y los overdue son SOLO informativos (nunca cancelan)', () => {
      expect(body).toContain("'seats_held', v_reservation.status = 'reserved'");
      expect(body).toContain(
        'v_deposit_overdue := v_deposit_verified_at IS NULL AND v_deposit_deadline IS NOT NULL AND v_deposit_deadline < NOW();',
      );
      expect(body).toContain(
        'v_balance_overdue := v_balance > 0 AND v_balance_deadline IS NOT NULL AND v_balance_deadline < NOW();',
      );
      // Funcion 100% de lectura: cero DML, cero auto-cancelacion.
      const bodyCode = stripComments(
        extractFunctionBody(migrationSql, 'reservation_payment_progress'),
      );
      expect(bodyCode).not.toMatch(/\bINSERT\b/i);
      expect(bodyCode).not.toMatch(/\bUPDATE\b/i);
      expect(bodyCode).not.toMatch(/\bDELETE\b/i);
      expect(bodyCode).not.toContain('audit_append');
    });

    it('expone los vencimientos vivos del viaje y el canal de WhatsApp', () => {
      expect(body).toContain(
        'SELECT t.deposit_deadline, t.balance_deadline INTO v_deposit_deadline, v_balance_deadline FROM public.trips t WHERE t.id = v_reservation.trip_id',
      );
      expect(body).toContain("'whatsapp_phone', v_whatsapp");
      expect(body).toContain("'deposit_deadline', CASE WHEN v_plan = 'two_stage'");
      expect(body).toContain("'balance_deadline', CASE WHEN v_plan = 'two_stage'");
    });
  });

  describe('grants globales', () => {
    it('todas las funciones: 3 REVOKE + GRANT service_role, ninguna a anon/authenticated', () => {
      const statements =
        migrationSql.match(
          /^(?:REVOKE ALL ON FUNCTION|GRANT EXECUTE ON FUNCTION).*$/gm,
        ) ?? [];
      // 7 funciones x (3 REVOKE + 1 GRANT) = 28 sentencias.
      expect(statements).toHaveLength(FUNCTIONS.length * 4);
      for (const fn of FUNCTIONS) {
        for (const role of ['PUBLIC', 'anon', 'authenticated']) {
          expect(
            migrationSql,
            `${fn.name}: falta REVOKE de ${role}`,
          ).toContain(`REVOKE ALL ON FUNCTION ${fn.signature} FROM ${role}`);
        }
        expect(
          migrationSql,
          `${fn.name}: falta GRANT a service_role`,
        ).toContain(`GRANT EXECUTE ON FUNCTION ${fn.signature} TO service_role`);
        // Cabecera de seguridad identica en las 7.
        const header = extractFunctionHeader(migrationSql, fn.name);
        expect(header).toContain('SECURITY DEFINER');
        expect(header).toContain('SET search_path = public');
      }
      expect(migrationSql).not.toMatch(
        /GRANT EXECUTE ON FUNCTION public\.[a-z_]+[\s\S]*?TO (anon|authenticated)/,
      );
    });
  });
});
