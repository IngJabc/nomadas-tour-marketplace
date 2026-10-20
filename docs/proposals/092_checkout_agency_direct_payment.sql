-- ============================================================
-- 092_checkout_agency_direct_payment.sql
-- MKT-008 (propuesta) - Checkout sin metodos de pago configurados.
--
-- ESTE ARCHIVO ES UNA PROPUESTA. NO ESTA APLICADO. Preparado en
-- Marketplace para revision; la aplicacion real se hace en el repo
-- de Tour (supabase/migrations) siguiendo su flujo de releases.
-- Nunca se aplico SQL remoto desde este trabajo.
--
-- Problema:
--   Cuando una agencia NO tiene agency_payment_methods activos, el
--   cliente no podia completar la compra en Marketplace:
--     1) El backend de Marketplace bloqueaba la creacion del intento
--        con 409 AGENCY_NO_ACTIVE_PAYMENT_METHODS (guard de
--        aplicacion, eliminado en esta fase).
--     2) El backend exigia payment_method_id antes de subir el
--        comprobante (guard ahora condicional en verifyAttemptReady).
--     3) EL CHECK checkout_attempts_payment_method_check (089:304-309)
--       RECHAZA en base de datos cualquier transicion a
--        'pending_review' sin payment_method_id. Este es el bloqueo
--        duro: sin este cambio, submit_checkout_proof falla aunque
--        el backend lo permita.
--
-- Decision (auditoria previa):
--   No se crea un metodo de pago ficticio. No se reutiliza un canal
--   de otra agencia. El pago coordinado directamente con la agencia
--   se representa con un SNAPSHOT explicito en el propio intento:
--     payment_method_id      = NULL
--     payment_method_snapshot = {
--       "method": "agency_direct",
--       "label": "Pago coordinado con la agencia",
--       "snapshot_version": 1,
--       "selected_at": ...
--     }
--   El CHECK admite 'pending_review' cuando existe ese snapshot, y
--   la RPC submit_checkout_proof lo estampa de forma atomica solo
--   cuando el intento no tiene canal elegido, no existe ya un
--   snapshot de metodo real (huerfano por borrado fisico del canal;
--   se rechaza limpio con ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED) y
--   la agencia no tiene ningun canal pago_movil activo. Si la agencia
--   SI tiene canales, el RPC rechaza con
--   ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED: la regla MKT-007.4
--   (elegir canal antes del comprobante) se conserva intacta en el
--   caso A.
--
-- Contexto (migraciones ya existentes, NO se modifican):
--   087 checkout_attempts + submit_checkout_proof (cuerpo base que
--       esta migracion reemplaza con CREATE OR REPLACE).
--   089 agency_payment_methods + CHECK pending_review exige canal +
--       select_checkout_payment_method + trigger de inmutabilidad.
--   090 reject_checkout_attempt (Opcion A; no se toca).
--   091 agency_contacts (contactos publicos; no se toca).
--
-- Inmutabilidad del canal:
--   trg_checkout_attempts_protect_payment_method (089) solo congela
--   cuando OLD.proof_count >= 1. El estampado agency_direct ocurre
--   en el PRIMER envio (proof_count = 0), por lo que el trigger lo
--   admite. En reenvios el snapshot ya existe y no se reescribe.
--
-- Orden de locks (sin cambios):
--   checkout_attempts (FOR UPDATE) -> agency_payment_methods (SELECT
--   bajo el lock del intento) -> seats (FOR UPDATE ORDER BY id).
--
-- Compatibilidad:
--   - Intentos con canal elegido: sin cambios (el CASE conserva el
--     snapshot existente; no se consulta agency_payment_methods).
--   - verify_checkout_attempt no lee payment_method_id/snapshot: la
--     aprobacion de la agencia funciona igual para agency_direct.
--   - select_checkout_payment_method no cambia: sigue exigiendo un
--     canal real de la agencia.
--   - Contrasenos/agregados: el JSONB de respuesta de submit no
--     cambia de forma.
--
-- Prohibido en esta migracion:
--   Editar 001-091; tocar verify/reject/cancel; tocar TTLs (Tour
--   600 s / Marketplace 900 s); tocar RLS; tocar agency_contacts;
--   BEGIN/COMMIT; SQL de rollback dentro de este archivo.
--
-- Rollback manual:
--   supabase/rollbacks/092_checkout_agency_direct_payment_rollback.sql
--   Restaura el CHECK original de 089 y el cuerpo de 087 de
--   submit_checkout_proof. Los intentos ya estampados con
--   agency_direct quedarian con snapshot huérfano: revertir solo
--   cuando no existan intentos pending_review/verified con
--   payment_method_snapshot->>'method' = 'agency_direct'.
--
-- Dry-run:   BEGIN;  \i 092_checkout_agency_direct_payment.sql   ROLLBACK;
--
-- Escenarios de integracion que requieren validacion en PostgreSQL
-- (NO cubiertos por pruebas con mocks):
--   1) Agencia sin canales: create attempt -> submit sin seleccion
--      => status='pending_review', payment_method_id NULL,
--      snapshot->>'method'='agency_direct', history con la entrada
--      {kind:payment_method}, locks prolongados 24 h.
--   2) Agencia CON canales activos: submit sin seleccion =>
--      ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED y sin escrituras.
--   3) Reenvio tras rechazo de un intento agency_direct => el
--      snapshot no se reescribe y el CHECK sigue cumpliendose.
--   4) verify_checkout_attempt sobre un intento agency_direct =>
--      reserva + pago verified + allocations sin leer metodos.
--   5) Carrera: la agencia configura un canal entre el GET de
--      payment-methods y el submit => el RPC (autoridad) rechaza.
--   6) El CHECK original (restaurado por rollback) vuelve a
--      exigir payment_method_id en pending_review.
--   7) Snapshot huerfano de un canal real (payment_method_id NULL por
--      borrado fisico del canal con ON DELETE SET NULL) en el primer
--      envio => rechazo limpio ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED
--      sin escrituras (evita el 23514 del CHECK al estampar
--      agency_direct sobre un snapshot de metodo real).
-- ============================================================

-- ============================================================
-- 1) CHECK: pending_review exige canal elegido O snapshot
--    agency_direct explícito. Se conserva la proteccion de MKT-007.4
--    para el caso A (snapshot de canal real sin id seria rechazado).
-- ============================================================

ALTER TABLE public.checkout_attempts
  DROP CONSTRAINT IF EXISTS checkout_attempts_payment_method_check;

ALTER TABLE public.checkout_attempts
  ADD CONSTRAINT checkout_attempts_payment_method_check
  CHECK (
    status <> 'pending_review'
    OR payment_method_id IS NOT NULL
    OR (
      payment_method_snapshot IS NOT NULL
      AND payment_method_snapshot->>'method' = 'agency_direct'
    )
  )
  NOT VALID;

COMMENT ON CONSTRAINT checkout_attempts_payment_method_check ON public.checkout_attempts IS
  'MKT-007.4 + 092 (MKT-008): pending_review exige canal elegido (payment_method_id) o snapshot agency_direct (pago coordinado cuando la agencia no tiene canales). NOT VALID: validar en staging.';

-- ============================================================
-- 2) submit_checkout_proof: cuerpo de 087 con dos adiciones
--    (v_agency_direct + estampado en el UPDATE). Todo lo demas es
--    identico: ownership, estado, ventana, idempotencia, locks,
--    conciliacion, prolongacion de locks a 24 h.
-- ============================================================

CREATE OR REPLACE FUNCTION public.submit_checkout_proof(
  p_attempt_id UUID,
  p_customer_id UUID,
  p_idempotency_key UUID,
  p_proof_path TEXT,
  p_payment_reference TEXT,
  p_bank_origin TEXT,
  p_payment_datetime TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt public.checkout_attempts%ROWTYPE;
  v_key_ns TEXT;
  v_path_prefix TEXT;
  v_path_rest TEXT;
  v_ref TEXT;
  v_bank TEXT;
  v_seat RECORD;
  v_found_seats INTEGER := 0;
  v_rowcount BIGINT;
  v_seq INTEGER;
  v_entry JSONB;
  v_dup JSONB;
  v_new_expires TIMESTAMPTZ;
  v_agency_direct BOOLEAN := false;
  v_method_entry JSONB;
BEGIN
  -- 1) Entrada. La ruta la compone el backend como
  --    <attempt_id>/<sha256>.<ext>.
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'ERR_CUSTOMER_REQUIRED: An authenticated customer is required';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_INPUT: p_idempotency_key is required';
  END IF;
  IF p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_ATTEMPT_NOT_FOUND: Checkout attempt not found';
  END IF;

  v_path_prefix := p_attempt_id::text || '/';
  IF p_proof_path IS NULL
     OR length(p_proof_path) > 512
     OR left(p_proof_path, length(v_path_prefix)) <> v_path_prefix THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_INPUT: p_proof_path must live inside the attempt directory';
  END IF;

  v_path_rest := substr(p_proof_path, length(v_path_prefix) + 1);
  IF v_path_rest = ''
     OR v_path_rest LIKE '%..%'
     OR v_path_rest LIKE '%/%'
     OR v_path_rest !~ '\.(png|jpg|jpeg|webp|pdf)$' THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_INPUT: p_proof_path has an invalid proof filename';
  END IF;

  -- 2) Datos de conciliacion: los tres campos son obligatorios.
  --    NULLIF + btrim convierte la cadena vacia en NULL para que el
  --    CHECK de la tabla tampoco la acepte.
  v_ref := NULLIF(btrim(COALESCE(p_payment_reference, '')), '');
  v_bank := NULLIF(btrim(COALESCE(p_bank_origin, '')), '');

  IF v_ref IS NULL OR length(v_ref) > 100 THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_RECONCILIATION: payment_reference is required (max 100 chars)';
  END IF;
  IF v_bank IS NULL OR length(v_bank) > 120 THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_RECONCILIATION: bank_origin is required (max 120 chars)';
  END IF;
  IF p_payment_datetime IS NULL THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_RECONCILIATION: payment_datetime is required';
  END IF;
  IF p_payment_datetime > NOW() + interval '5 minutes' THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_RECONCILIATION: payment_datetime cannot be in the future';
  END IF;

  -- 3) Intento con lock de fila: serializa envios concurrentes,
  --    verificacion, rechazo y cleanup.
  SELECT ca.*
    INTO v_attempt
  FROM public.checkout_attempts ca
  WHERE ca.id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_ATTEMPT_NOT_FOUND: Checkout attempt not found';
  END IF;

  IF v_attempt.customer_id IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_NOT_OWNER: The checkout attempt does not belong to this customer';
  END IF;

  -- 4) Idempotencia: se busca la clave dentro del historial. La misma
  --    clave con la MISMA ruta devuelve el resultado existente sin
  --    escritura; con otra ruta es un conflicto estable.
  v_key_ns := 'mkt007:' || p_attempt_id::text || ':' || p_idempotency_key::text;

  SELECT e INTO v_dup
  FROM jsonb_array_elements(v_attempt.history) AS e
  WHERE e->>'kind' = 'submission'
    AND e->>'idempotency_key' = v_key_ns
  LIMIT 1;

  IF FOUND THEN
    IF v_dup->>'proof_path' IS DISTINCT FROM p_proof_path
       OR v_dup->>'payment_reference' IS DISTINCT FROM v_ref
       OR v_dup->>'bank_origin' IS DISTINCT FROM v_bank THEN
      RAISE EXCEPTION 'ERR_CHECKOUT_IDEMPOTENCY_CONFLICT: Idempotency key reused with a different submission';
    END IF;

    RETURN jsonb_build_object(
      'attempt_id', v_attempt.id,
      'status', v_attempt.status,
      'proof_count', v_attempt.proof_count,
      'proof_path', v_attempt.proof_path,
      'amount_cents', v_attempt.amount_cents,
      'expires_at', v_attempt.expires_at,
      'idempotent', true
    );
  END IF;

  -- 5) Estado. Terminal => cerrado; pending_review => ya hay un
  --    comprobante esperando; created|rejected => reenvio permitido.
  IF v_attempt.status IN ('verified', 'rejected_final', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_ATTEMPT_CLOSED: Checkout attempt is in status %', v_attempt.status;
  END IF;

  IF v_attempt.status = 'pending_review' THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_PROOF_PENDING: A proof is already waiting for review';
  END IF;

  IF v_attempt.expires_at <= NOW() THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_WINDOW_EXPIRED: The checkout window has expired';
  END IF;

  IF v_attempt.proof_count >= 3 THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_PROOF_LIMIT: Only three proofs are allowed per checkout attempt';
  END IF;

  -- 5b) MKT-008: pago coordinado con la agencia. Solo en el PRIMER
  --     envio (proof_count = 0) y sin canal elegido se comprueba que
  --     la agencia no tenga ningun canal pago_movil activo. Si tiene
  --     canales, el cliente DEBE elegir uno (MKT-007.4 intacta). En
  --     reenvios el modo ya esta congelado por el snapshot.
  IF v_attempt.payment_method_id IS NULL AND v_attempt.proof_count = 0 THEN
    -- B1: snapshot huerfano de un canal REAL (payment_method_id quedo
    -- NULL por borrado fisico del canal, que dispara ON DELETE SET NULL
    -- en agency_payment_methods). El CHECK solo acepta pending_review
    -- con id NO NULL o snapshot agency_direct: estampar aqui produciria
    -- un 23514. Rechazo limpio, sin escrituras, mismo codigo que el
    -- guard de canales.
    IF v_attempt.payment_method_snapshot IS NOT NULL
       AND v_attempt.payment_method_snapshot->>'method' IS DISTINCT FROM 'agency_direct' THEN
      RAISE EXCEPTION 'ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED: Select a payment method before submitting the proof';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.agency_payment_methods apm
      WHERE apm.agency_id = v_attempt.agency_id
        AND apm.method = 'pago_movil'
        AND apm.is_active
        AND apm.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED: Select a payment method before submitting the proof';
    END IF;

    v_agency_direct := true;
    v_method_entry := jsonb_build_object(
      'kind', 'payment_method',
      'method', 'agency_direct',
      'label', 'Pago coordinado con la agencia',
      'selected_at', NOW()
    );
  END IF;

  -- 6) Los locks siguen siendo del intento y siguen vigentes.
  FOR v_seat IN
    SELECT s.id, s.seat_code, s.trip_id, s.status, s.locked_by, s.guest_session_id,
           s.lock_expires_at, s.checkout_attempt_id
    FROM public.seats s
    WHERE s.id = ANY(v_attempt.seat_ids)
    ORDER BY s.id
    FOR UPDATE
  LOOP
    v_found_seats := v_found_seats + 1;

    IF v_seat.trip_id IS DISTINCT FROM v_attempt.trip_id
       OR v_seat.status IS DISTINCT FROM 'locked'
       OR v_seat.checkout_attempt_id IS DISTINCT FROM v_attempt.id
       OR v_seat.locked_by IS DISTINCT FROM v_attempt.customer_id
       OR v_seat.guest_session_id IS NOT NULL THEN
      RAISE EXCEPTION 'ERR_CHECKOUT_LOCK_EXPIRED: Seat % is no longer locked by this checkout attempt', v_seat.seat_code;
    END IF;

    IF v_seat.lock_expires_at IS NULL OR v_seat.lock_expires_at <= NOW() THEN
      RAISE EXCEPTION 'ERR_CHECKOUT_LOCK_EXPIRED: Seat % lock expired', v_seat.seat_code;
    END IF;
  END LOOP;

  IF v_found_seats <> cardinality(v_attempt.seat_ids) THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_LOCK_EXPIRED: One or more attempt seats could not be locked';
  END IF;

  -- 7) Nueva ventana: 24 h contadas DESDE este envio. Los locks se
  --    prolongan a la par; nadie mas puede reclamarlos.
  v_new_expires := NOW() + interval '24 hours';
  v_seq := v_attempt.proof_count + 1;

  v_entry := jsonb_build_object(
    'kind', 'submission',
    'seq', v_seq,
    'proof_path', p_proof_path,
    'payment_reference', v_ref,
    'bank_origin', v_bank,
    'payment_datetime', p_payment_datetime,
    'submitted_at', NOW(),
    'idempotency_key', v_key_ns
  );

  UPDATE public.checkout_attempts ca
  SET status = 'pending_review',
      proof_count = v_seq,
      proof_path = p_proof_path,
      payment_reference = v_ref,
      bank_origin = v_bank,
      payment_datetime = p_payment_datetime,
      proof_submitted_at = NOW(),
      review_started_at = NOW(),
      rejection_reason = NULL,
      expires_at = v_new_expires,
      -- MKT-008: estampa el snapshot agency_direct solo si aun no existe.
      payment_method_snapshot = CASE
        WHEN v_agency_direct AND ca.payment_method_snapshot IS NULL
        THEN jsonb_build_object(
          'method', 'agency_direct',
          'label', 'Pago coordinado con la agencia',
          'snapshot_version', 1,
          'selected_at', NOW()
        )
        ELSE ca.payment_method_snapshot
      END,
      history = ca.history
        || jsonb_build_array(v_entry)
        || CASE
          WHEN v_agency_direct AND ca.payment_method_snapshot IS NULL
          THEN jsonb_build_array(v_method_entry)
          ELSE '[]'::jsonb
        END
  WHERE ca.id = p_attempt_id;

  GET DIAGNOSTICS v_rowcount = ROW_COUNT;
  IF v_rowcount <> 1 THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_ATTEMPT_NOT_FOUND: Checkout attempt not found';
  END IF;

  UPDATE public.seats s
  SET lock_expires_at = v_new_expires
  WHERE s.id = ANY(v_attempt.seat_ids)
    AND s.status = 'locked'
    AND s.checkout_attempt_id = p_attempt_id;

  GET DIAGNOSTICS v_rowcount = ROW_COUNT;
  IF v_rowcount <> cardinality(v_attempt.seat_ids) THEN
    RAISE EXCEPTION 'ERR_CHECKOUT_LOCK_EXPIRED: Seat state changed during proof submission';
  END IF;

  RETURN jsonb_build_object(
    'attempt_id', p_attempt_id,
    'status', 'pending_review',
    'proof_count', v_seq,
    'remaining_submissions', 3 - v_seq,
    'proof_path', p_proof_path,
    'payment_reference', v_ref,
    'bank_origin', v_bank,
    'payment_datetime', p_payment_datetime,
    'amount_cents', v_attempt.amount_cents,
    'expires_at', v_new_expires,
    'idempotent', false
  );
END;
$$;

COMMENT ON FUNCTION public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) IS
  'MKT-007 + 092 (MKT-008): recibe un comprobante (primer envio o reenvio) de un checkout_attempt. En UNA transaccion valida dueno, estado, ventana y locks del intento, exige los tres datos de conciliacion, incrementa proof_count de forma atomica (max 3), abre una ventana de 24 h y prolonga seats.lock_expires_at hasta ese instante. MKT-008: en el primer envio sin canal elegido, si la agencia no tiene canales pago_movil activos estampa payment_method_snapshot agency_direct (pago coordinado) y lo registra en history; si la agencia SI tiene canales o existe un snapshot huerfano de un metodo real, rechaza con ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED. NO crea payments ni reservations. La validacion de los BYTES del archivo ocurre en el backend, no aqui. SECURITY DEFINER; EXECUTE service_role only.';

REVOKE ALL ON FUNCTION public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
