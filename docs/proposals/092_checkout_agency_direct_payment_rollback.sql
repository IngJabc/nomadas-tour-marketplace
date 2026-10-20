-- ============================================================
-- 092_checkout_agency_direct_payment_rollback.sql
-- Rollback manual de 092 (MKT-008 - pago coordinado agency_direct).
--
-- ESTE ARCHIVO ES UNA PROPUESTA. NO ESTA APLICADO.
--
-- Restaura:
--   1) checkout_attempts_payment_method_check original de 089:
--      CHECK (status <> 'pending_review' OR payment_method_id IS
--      NOT NULL) NOT VALID.
--   2) submit_checkout_proof con el cuerpo exacto de 087.
--
-- Advertencia de datos:
--   Los intentos ya estampados con
--   payment_method_snapshot->>'method' = 'agency_direct' quedarian
--   INCUMPLIENDO el CHECK original restaurado en cuanto intenten
--   cualquier UPDATE que active la validacion (NOT VALID solo
--   valida filas nuevas/modificadas). Antes de revertir en un entorno
--   con datos, verificar:
--     SELECT count(*) FROM public.checkout_attempts
--      WHERE payment_method_snapshot->>'method' = 'agency_direct'
--        AND status IN ('created','pending_review','rejected');
--   Si el conteo es mayor que cero, migrar/esos intentos a un canal
--   real o cancelarlos antes del rollback.
-- ============================================================

-- 1) CHECK original (089).

ALTER TABLE public.checkout_attempts
  DROP CONSTRAINT IF EXISTS checkout_attempts_payment_method_check;

ALTER TABLE public.checkout_attempts
  ADD CONSTRAINT checkout_attempts_payment_method_check
  CHECK (status <> 'pending_review' OR payment_method_id IS NOT NULL)
  NOT VALID;

COMMENT ON CONSTRAINT checkout_attempts_payment_method_check ON public.checkout_attempts IS
  'MKT-007.4: un intento en pending_review siempre tiene canal elegido. NOT VALID: validar en paso posterior sobre staging.';

-- 2) submit_checkout_proof restaurado (cuerpo de 087, sin MKT-008).

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
      history = ca.history || jsonb_build_array(v_entry)
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
  'MKT-007: recibe un comprobante (primer envio o reenvio) de un checkout_attempt. En UNA transaccion valida dueno, estado, ventana y locks del intento, exige los tres datos de conciliacion, incrementa proof_count de forma atomica (max 3), abre una ventana de 24 h y prolonga seats.lock_expires_at hasta ese instante. NO crea payments ni reservations. La validacion de los BYTES del archivo ocurre en el backend, no aqui. SECURITY DEFINER; EXECUTE service_role only.';

REVOKE ALL ON FUNCTION public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.submit_checkout_proof(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
