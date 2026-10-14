import { createHash } from 'node:crypto';
import type { Request } from 'express';
import Busboy from 'busboy';
import { supabaseAdmin } from '../config/database.js';
import { AppError } from '../errors/index.js';

export const PROOF_BUCKET = 'payment-proofs';
/** 5 MiB — el mismo límite del bucket (083) y del parser multipart. */
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

type ProofType = 'png' | 'jpg' | 'webp' | 'pdf';

const MIME_BY_TYPE: Record<ProofType, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

const EXTENSION_BY_TYPE: Record<ProofType, string> = {
  png: 'png',
  jpg: 'jpg',
  webp: 'webp',
  pdf: 'pdf',
};

const ALLOWED_MIMES = new Set(Object.values(MIME_BY_TYPE));

/**
 * Estados desde los cuales todavía tiene sentido someter un comprobante.
 * 'locked' es el flujo normal. 'reserved' solo se tolera para que un
 * reintento idempotente pueda llegar al RPC (que resuelve la clave ANTES
 * de rechazar "ya enviada" y devuelve el pago existente). El estado
 * permitido lo decide al final el RPC: aquí no se confirma nada.
 */
const SUBMITTABLE_RESERVATION_STATUSES = new Set(['locked', 'reserved']);

export interface ParsedProof {
  buffer: Buffer;
  mimeType: string;
}

export interface SubmitPaymentProofInput {
  reservationId: string;
  idempotencyKey: string;
  customerId: string;
  proof: ParsedProof;
}

export interface SubmitPaymentProofResult {
  payment_id: string;
  reservation_id: string;
  payment_status: string;
  reservation_status: string;
  amount_cents: number;
  currency: string;
  submitted_at: string;
  idempotent: boolean;
}

function paymentError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, statusCode, code);
}

// ── Multipart ────────────────────────────────────────────────────────────────

/**
 * Parsea el request como multipart con límites estrictos:
 * exactamente un archivo bajo el campo `proof`, cero campos de texto,
 * máximo 5 MiB. No confía en el nombre original del archivo (la ruta de
 * almacenamiento se deriva del contenido, nunca del filename).
 *
 * Maneja parseo inválido, streams abortados y desconexiones del cliente
 * sin dejar pipes abiertos: al primer error se desacopla y drena el resto
 * del cuerpo en vez de seguir buffering.
 */
export function parseProofUpload(req: Request): Promise<ParsedProof> {
  return new Promise((resolve, reject) => {
    const multipartError = paymentError(
      'Envía el comprobante como un único archivo multipart "proof"',
      400,
      'PAYMENT_MULTIPART_INVALID',
    );

    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          files: 1,
          fields: 0,
          fileSize: MAX_PROOF_BYTES,
        },
      });
    } catch {
      // Content-Type no soportado (p. ej. application/json): nunca se
      // creó el parser, así que hay que drenar el cuerpo a mano para no
      // dejar la conexión a medias.
      reject(multipartError);
      req.resume();
      return;
    }

    let failure: AppError | null = null;
    let upload: { mimeType: string; chunks: Buffer[]; ended: boolean } | null = null;
    let settled = false;

    const fail = (error: AppError) => {
      if (!failure) failure = error;
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      req.removeListener('aborted', onAbort);
      req.removeListener('error', onAbort);

      if (failure) {
        reject(failure);
        return;
      }
      if (!upload || !upload.ended) {
        reject(
          paymentError('Adjunta el comprobante de pago', 400, 'PAYMENT_FILE_MISSING'),
        );
        return;
      }
      resolve({ buffer: Buffer.concat(upload.chunks), mimeType: upload.mimeType });
    };

    let stopped = false;

    // Detiene el procesamiento: desacopla el parser, drena el resto del
    // request sin acumularlo en memoria y resuelve la promesa con el error
    // ya registrado. La destrucción del parser queda diferida: los eventos
    // de busboy (limit, filesLimit, field…) se emiten dentro de su propio
    // _write, y destruirlo ahí mismo deja su estado interno a medias
    // (excepciones no capturadas que rompen requests posteriores).
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        req.unpipe(parser);
      } catch {
        // El stream ya estaba desconectado.
      }
      req.resume();
      setImmediate(() => {
        try {
          parser.destroy();
        } catch {
          // Ya destruido.
        }
      });
      settle();
    };

    function onAbort() {
      fail(
        paymentError(
          'La carga del comprobante fue interrumpida',
          400,
          'PAYMENT_MULTIPART_INVALID',
        ),
      );
      stop();
    }

    parser.on('file', (fieldName, stream, info) => {
      // El parser destruye el stream del archivo al abortar o al encontrar
      // un final inesperado; sin este listener esa destrucción se convierte
      // en una excepción no capturada que rompe requests posteriores.
      stream.on('error', () => {
        fail(multipartError);
      });

      if (fieldName !== 'proof' || upload) {
        fail(
          paymentError(
            'La solicitud debe contener únicamente el archivo "proof"',
            400,
            'PAYMENT_MULTIPART_INVALID',
          ),
        );
        stream.resume();
        stop();
        return;
      }

      const chunks: Buffer[] = [];
      upload = { mimeType: info.mimeType, chunks, ended: false };

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      stream.on('limit', () => {
        fail(
          paymentError(
            'El comprobante no puede superar 5 MB',
            413,
            'PAYMENT_FILE_TOO_LARGE',
          ),
        );
        stop();
      });
      stream.on('end', () => {
        if (upload) upload.ended = true;
      });
    });

    parser.on('field', () => {
      fail(multipartError);
      stop();
    });
    parser.on('fieldsLimit', () => {
      fail(multipartError);
      stop();
    });
    parser.on('filesLimit', () => {
      fail(multipartError);
      stop();
    });
    parser.on('error', () => {
      fail(
        paymentError(
          'No se pudo procesar el archivo del comprobante',
          400,
          'PAYMENT_MULTIPART_INVALID',
        ),
      );
      stop();
    });
    parser.on('close', () => settle());

    req.on('aborted', onAbort);
    req.on('error', onAbort);
    req.pipe(parser);
  });
}

// ── Validación de contenido (magic bytes, no solo MIME declarado) ────────────

function hasPngSignature(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  );
}

function hasJpegSignature(buffer: Buffer): boolean {
  return (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  );
}

function hasWebpSignature(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function hasPdfSignature(buffer: Buffer): boolean {
  return (
    buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  );
}

/** Detecta el tipo real del contenido a partir de sus magic bytes. */
export function detectProofType(buffer: Buffer): ProofType | null {
  if (hasPngSignature(buffer)) return 'png';
  if (hasJpegSignature(buffer)) return 'jpg';
  if (hasWebpSignature(buffer)) return 'webp';
  if (hasPdfSignature(buffer)) return 'pdf';
  return null;
}

/**
 * Valida el comprobante: no vacío, ≤ 5 MiB, MIME declarado permitido y —
 * sobre todo — coincidente con las magic bytes del contenido. Nada de
 * SVG/HTML ni formatos activos: el tipo detectado manda y de él se deriva
 * la extensión (.jpg para JPEG, igual que la regex de la migración 083).
 */
function validateProofFile(proof: ParsedProof): {
  extension: string;
  mimeType: string;
} {
  if (proof.buffer.length === 0) {
    throw paymentError('El comprobante está vacío', 400, 'PAYMENT_FILE_INVALID');
  }
  if (proof.buffer.length > MAX_PROOF_BYTES) {
    throw paymentError(
      'El comprobante no puede superar 5 MB',
      413,
      'PAYMENT_FILE_TOO_LARGE',
    );
  }
  if (!ALLOWED_MIMES.has(proof.mimeType)) {
    throw paymentError(
      'El comprobante debe ser PNG, JPEG, WEBP o PDF',
      400,
      'PAYMENT_FILE_INVALID',
    );
  }

  const detected = detectProofType(proof.buffer);
  if (!detected) {
    throw paymentError(
      'El contenido del archivo no corresponde a un comprobante válido',
      400,
      'PAYMENT_FILE_INVALID',
    );
  }

  const detectedMime = MIME_BY_TYPE[detected];
  if (detectedMime !== proof.mimeType) {
    throw paymentError(
      'El tipo declarado del archivo no coincide con su contenido',
      400,
      'PAYMENT_FILE_INVALID',
    );
  }

  return { extension: EXTENSION_BY_TYPE[detected], mimeType: detectedMime };
}

// ── Pre-chequeo de la reserva (antes de subir nada) ──────────────────────────

/**
 * Verifica ANTES de subir que la reserva exista, pertenezca al customer
 * autenticado, sea `source='marketplace'` y esté en un estado que permita
 * someter comprobantes. No filtra reservas ajenas ni de Tour: todas las
 * fallas responden el mismo 404. Nunca hace UPDATE: la transición de
 * estado es trabajo exclusivo del RPC 083.
 */
async function verifyReservationReady(
  reservationId: string,
  customerId: string,
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('reservations')
    .select('id, customer_id, source, status')
    .eq('id', reservationId)
    .maybeSingle();

  if (error) {
    throw paymentError(
      'No se pudo verificar la reserva. Intenta de nuevo',
      500,
      'PAYMENT_SUBMIT_ERROR',
    );
  }

  const reservation = data as {
    id: string;
    customer_id: string | null;
    source: string;
    status: string;
  } | null;

  if (
    !reservation ||
    reservation.customer_id !== customerId ||
    reservation.source !== 'marketplace'
  ) {
    throw paymentError('Reserva no encontrada', 404, 'PAYMENT_RESERVATION_NOT_FOUND');
  }

  if (!SUBMITTABLE_RESERVATION_STATUSES.has(reservation.status)) {
    throw paymentError(
      'Esta reserva ya no acepta comprobantes de pago',
      409,
      'PAYMENT_RESERVATION_CLOSED',
    );
  }
}

// ── Limpieza condicionada tras un fallo del RPC ──────────────────────────────

/**
 * Borra el objeto recién subido SOLO si ningún pago lo referencia
 * (payments.proof_url). Si el chequeo no puede ejecutarse o encuentra un
 * pago que apunta al objeto, se conserva el archivo y se registra el
 * motivo: nunca se elimina algo que un pago confirmado pudiera necesitar.
 * Cualquier fallo aquí se loguea sin enmascarar el error original.
 */
async function cleanupUploadedProof(proofPath: string): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from('payments')
      .select('id')
      .eq('proof_url', proofPath)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[payments] cleanup omitido: no se pudo verificar la referencia del pago', {
        proof_error: error.message,
      });
      return;
    }
    if (data) {
      console.error('[payments] cleanup omitido: el objeto ya está referenciado por un pago');
      return;
    }

    const { error: removeError } = await supabaseAdmin.storage
      .from(PROOF_BUCKET)
      .remove([proofPath]);

    if (removeError) {
      console.error('[payments] cleanup del comprobante falló', {
        proof_error: removeError.message,
      });
    }
  } catch (cleanupError) {
    console.error('[payments] cleanup del comprobante falló', {
      proof_error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}

// ── Traducción de errores del RPC ────────────────────────────────────────────

function rpcErrorCode(message: string): string | null {
  const match = /^(ERR_[A-Z_]+):\s*/.exec(message);
  return match ? match[1] : null;
}

/**
 * Traduce los RAISE EXCEPTION de `submit_marketplace_payment` (083) al
 * envelope estándar del backend. Los códigos ERR_* del RPC se conservan
 * con su significado; los mensajes SQL nunca llegan al cliente.
 */
function mapRpcError(error: { message: string }): AppError {
  const code = rpcErrorCode(error.message || '');

  switch (code) {
    case 'ERR_CUSTOMER_REQUIRED':
      return new AppError(
        'Solo cuentas de cliente pueden enviar comprobantes',
        401,
        'UNAUTHORIZED',
      );
    case 'ERR_PAYMENT_INPUT':
      return paymentError('Datos de envío inválidos', 400, 'PAYMENT_INPUT_INVALID');
    case 'ERR_PAYMENT_RESERVATION_NOT_FOUND':
      return paymentError('Reserva no encontrada', 404, 'PAYMENT_RESERVATION_NOT_FOUND');
    case 'ERR_PAYMENT_NOT_OWNER':
      // Mismo 404 que "no existe": no se filtra que la reserva sea de otro.
      return paymentError('Reserva no encontrada', 404, 'PAYMENT_RESERVATION_NOT_FOUND');
    case 'ERR_PAYMENT_IDEMPOTENCY_CONFLICT':
      return paymentError(
        'La clave de idempotencia ya se usó con otro comprobante',
        409,
        'PAYMENT_IDEMPOTENCY_CONFLICT',
      );
    case 'ERR_PAYMENT_ALREADY_SUBMITTED':
      return paymentError(
        'El comprobante de esta reserva ya fue enviado',
        409,
        'PAYMENT_ALREADY_SUBMITTED',
      );
    case 'ERR_PAYMENT_RESERVATION_CLOSED':
      return paymentError(
        'Esta reserva ya no acepta comprobantes de pago',
        409,
        'PAYMENT_RESERVATION_CLOSED',
      );
    case 'ERR_PAYMENT_LOCK_EXPIRED':
      return paymentError(
        'Tu selección de asientos expiró. Resérvalos de nuevo',
        409,
        'PAYMENT_LOCK_EXPIRED',
      );
    case 'ERR_PAYMENT_AMOUNT_INVALID':
      return paymentError(
        'No se pudo validar el monto de la reserva',
        422,
        'PAYMENT_AMOUNT_INVALID',
      );
    default:
      return paymentError(
        'No se pudo registrar el pago. Intenta de nuevo',
        500,
        'PAYMENT_SUBMIT_ERROR',
      );
  }
}

interface PaymentRpcRow {
  payment_id?: string;
  reservation_id?: string;
  status?: string;
  amount_cents?: number;
  currency?: string;
  submitted_at?: string;
  idempotent?: boolean;
}

// ── Orquestación ─────────────────────────────────────────────────────────────

/**
 * Flujo completo de una sumisión de comprobante:
 *
 *  1. Pre-chequeo de la reserva (dueño + source + estado) — antes de subir.
 *  2. Validación del contenido (magic bytes) y ruta determinista
 *     `{reservation_id}/{sha256(contenido)}.{ext}` — sin usar el filename.
 *  3. Upload privado al bucket `payment-proofs` con `upsert: true` mediante
 *     service_role. Jamás se construye una URL pública o firmada.
 *  4. RPC `submit_marketplace_payment` con p_customer_id de la sesión y la
 *     ruta interna como `p_proof_path`. El cliente no aporta monto, moneda
 *     ni estado: el RPC es la autoridad final (TTL, ownership de asientos,
 *     monto = SUM(unit_price) y transición locked → reserved).
 *  5. Si el RPC falla, se intenta la limpieza condicionada del objeto
 *     recién subido y se propaga el error original mapeado.
 *
 * Esta función nunca hace UPDATE sobre reservations/seats/payments ni
 * modifica lock_expires_at: todo eso vive dentro del RPC.
 */
export async function submitPaymentProof(
  input: SubmitPaymentProofInput,
): Promise<SubmitPaymentProofResult> {
  await verifyReservationReady(input.reservationId, input.customerId);

  const file = validateProofFile(input.proof);

  const digest = createHash('sha256').update(input.proof.buffer).digest('hex');
  const proofPath = `${input.reservationId}/${digest}.${file.extension}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(PROOF_BUCKET)
    .upload(proofPath, input.proof.buffer, {
      contentType: file.mimeType,
      upsert: true,
    });

  if (uploadError) {
    throw paymentError(
      'No se pudo almacenar el comprobante. Intenta de nuevo',
      500,
      'PAYMENT_STORAGE_ERROR',
    );
  }

  const { data, error } = await supabaseAdmin.rpc('submit_marketplace_payment', {
    p_reservation_id: input.reservationId,
    p_customer_id: input.customerId,
    p_idempotency_key: input.idempotencyKey,
    p_proof_path: proofPath,
  });

  if (error) {
    const mapped = mapRpcError(error);
    await cleanupUploadedProof(proofPath);
    throw mapped;
  }

  const row = data as PaymentRpcRow | null;
  if (!row?.payment_id) {
    await cleanupUploadedProof(proofPath);
    throw paymentError(
      'No se pudo registrar el pago. Intenta de nuevo',
      500,
      'PAYMENT_SUBMIT_ERROR',
    );
  }

  return {
    payment_id: row.payment_id,
    reservation_id: row.reservation_id ?? input.reservationId,
    // El RPC solo crea pagos 'pending': la verificación es fase posterior
    // (MKT-006) y todavía no existe ningún otro estado alcanzable.
    payment_status: 'pending',
    reservation_status: row.status ?? 'reserved',
    amount_cents: row.amount_cents ?? 0,
    currency: row.currency ?? 'COP',
    submitted_at: row.submitted_at ?? new Date().toISOString(),
    idempotent: row.idempotent === true,
  };
}

// ── Revisión administrativa (MKT-006 Fase 6.2B — agencia) ───────────────────

export interface VerifyPaymentInput {
  paymentId: string;
  actorUserId: string;
}

export interface RejectPaymentInput {
  paymentId: string;
  actorUserId: string;
  reason: string;
}

export interface VerifyPaymentResult {
  payment_id: string;
  reservation_id: string;
  status: string;
  already_verified: boolean;
  amount_cents: number;
  currency: string;
  allocation_count: number;
  total_expected_cents: number;
  verified_at: string;
  verified_by: string;
  payment_status: string;
  audit_id: string;
}

export interface RejectPaymentResult {
  payment_id: string;
  reservation_id: string;
  status: string;
  already_rejected: boolean;
  rejection_reason: string;
  outcome: string;
  cancelled_reservation: boolean;
  reservation_status: string;
  payment_status: string;
  freed_seat_count: number;
  cancelled_passenger_count: number;
  refund_required: boolean;
  refund_amount_cents: number;
  payment_audit_id: string;
  reservation_audit_id: string | null;
}

/**
 * Traduce los RAISE EXCEPTION de `verify_marketplace_payment` y
 * `reject_marketplace_payment` (085) al envelope estándar del backend.
 * Los códigos ERR_* se conservan; los mensajes SQL no llegan al cliente.
 * El error de ownership (AGENCY_MISMATCH) responde 404 para no filtrar
 * la existencia de pagos de otras agencias.
 */
function mapAdminRpcError(error: { message: string }): AppError {
  const code = rpcErrorCode(error.message || '');

  switch (code) {
    case 'ERR_PAYMENT_INPUT':
      return paymentError('Datos inválidos', 400, 'PAYMENT_INPUT_INVALID');
    case 'ERR_PAYMENT_NOT_FOUND':
    case 'ERR_PAYMENT_AGENCY_MISMATCH':
      // Mismo 404 para "no existe" y "es de otra agencia".
      return paymentError('Pago no encontrado', 404, 'PAYMENT_NOT_FOUND');
    case 'ERR_PAYMENT_RESERVATION_NOT_FOUND':
      return paymentError('Reserva no encontrada', 404, 'PAYMENT_RESERVATION_NOT_FOUND');
    case 'ERR_PAYMENT_NOT_MARKETPLACE':
      return paymentError('Pago no encontrado', 404, 'PAYMENT_NOT_FOUND');
    case 'ERR_PAYMENT_ADMIN_NOT_FOUND':
    case 'ERR_PAYMENT_ADMIN_ROLE':
    case 'ERR_PAYMENT_ADMIN_AGENCY':
      return paymentError('No autorizado', 403, 'FORBIDDEN');
    case 'ERR_PAYMENT_ALREADY_REJECTED':
      return paymentError(
        'Este pago ya fue rechazado',
        409,
        'PAYMENT_ALREADY_REJECTED',
      );
    case 'ERR_PAYMENT_VERIFIED_NO_REJECT':
      return paymentError(
        'Un pago verificado no puede ser rechazado',
        409,
        'PAYMENT_VERIFIED_NO_REJECT',
      );
    case 'ERR_PAYMENT_NOT_PENDING':
      return paymentError(
        'El pago ya no está pendiente de revisión',
        409,
        'PAYMENT_NOT_PENDING',
      );
    case 'ERR_PAYMENT_RESERVATION_STATE':
      return paymentError(
        'La reserva no está en un estado compatible con esta operación',
        409,
        'PAYMENT_RESERVATION_STATE',
      );
    case 'ERR_PAYMENT_REJECT_REASON':
      return paymentError(
        'El motivo de rechazo es obligatorio (1-500 caracteres)',
        400,
        'PAYMENT_REJECT_REASON',
      );
    case 'ERR_PAYMENT_VERIFY_NO_PASSENGERS':
    case 'ERR_PAYMENT_VERIFY_PRICE':
    case 'ERR_PAYMENT_VERIFY_SEATS':
    case 'ERR_PAYMENT_VERIFY_AMOUNT':
    case 'ERR_PAYMENT_VERIFY_SEAT_TRIP':
    case 'ERR_PAYMENT_VERIFY_SEAT_STATE':
    case 'ERR_PAYMENT_VERIFY_SEAT_MISSING':
    case 'ERR_PAYMENT_VERIFY_ALLOCATIONS':
    case 'ERR_PAYMENT_VERIFY_ALLOC_COUNT':
      return paymentError(
        'No se pudo verificar el pago: los datos de la reserva no son consistentes',
        422,
        'PAYMENT_VERIFY_INCONSISTENT',
      );
    case 'ERR_PAYMENT_VERIFY_RACE':
    case 'ERR_PAYMENT_RESERVATION':
    case 'ERR_PAYMENT_REJECT_RACE':
    case 'ERR_PAYMENT_REJECT_PASSENGERS':
    case 'ERR_PAYMENT_REJECT_RESERVATION':
      return paymentError(
        'El estado del pago cambió durante la operación. Intenta de nuevo',
        409,
        'PAYMENT_STATE_CHANGED',
      );
    default:
      return paymentError(
        'No se pudo procesar la operación. Intenta de nuevo',
        500,
        'PAYMENT_ADMIN_ERROR',
      );
  }
}

/**
 * Verifica un comprobante marketplace (RPC 085 `verify_marketplace_payment`).
 * El actor SIEMPRE es el usuario autenticado de la agencia; el backend
 * nunca acepta un agency_id del cliente. La autorización de ownership ya
 * la hizo el middleware `verifyAgencyOwnership`; aquí se invoca el RPC
 * como autoridad de negocio (locks, allocations, idempotencia).
 */
export async function verifyPayment(
  input: VerifyPaymentInput,
): Promise<VerifyPaymentResult> {
  const { data, error } = await supabaseAdmin.rpc('verify_marketplace_payment', {
    p_payment_id: input.paymentId,
    p_actor_user_id: input.actorUserId,
  });

  if (error) {
    throw mapAdminRpcError(error);
  }

  const row = data as VerifyPaymentResult | null;
  if (!row?.payment_id) {
    throw paymentError(
      'No se pudo verificar el pago. Intenta de nuevo',
      500,
      'PAYMENT_ADMIN_ERROR',
    );
  }

  return row;
}

/**
 * Rechaza un comprobante marketplace (RPC 085 `reject_marketplace_payment`).
 * Mismo patrón que verifyPayment: ownership ya validado por middleware,
 * el RPC es la autoridad de negocio.
 */
export async function rejectPayment(
  input: RejectPaymentInput,
): Promise<RejectPaymentResult> {
  const { data, error } = await supabaseAdmin.rpc('reject_marketplace_payment', {
    p_payment_id: input.paymentId,
    p_actor_user_id: input.actorUserId,
    p_reason: input.reason,
  });

  if (error) {
    throw mapAdminRpcError(error);
  }

  const row = data as RejectPaymentResult | null;
  if (!row?.payment_id) {
    throw paymentError(
      'No se pudo rechazar el pago. Intenta de nuevo',
      500,
      'PAYMENT_ADMIN_ERROR',
    );
  }

  return row;
}

// ── Consulta de pagos por agencia (MKT-006 Fase 6.3B) ───────────────────────

export const PROOF_SIGNED_URL_TTL_SECONDS = 300;

export type AgencyPaymentStatusFilter = 'pending' | 'verified' | 'rejected';

export interface ListAgencyPaymentsInput {
  agencyId: string;
  status?: AgencyPaymentStatusFilter;
  page: number;
  limit: number;
}

export interface AgencyPaymentListItem {
  id: string;
  status: string;
  amount_cents: number;
  currency: string;
  submitted_at: string;
  verified_at: string | null;
  rejection_reason: string | null;
  has_proof: boolean;
  reservation: {
    id: string;
    booker_name: string;
    contact_email: string | null;
    status: string;
    payment_status: string | null;
    trip: {
      id: string;
      departure_time: string;
      origin: string;
      destination: string;
    } | null;
  };
}

export interface ListAgencyPaymentsResult {
  payments: AgencyPaymentListItem[];
  page: number;
  limit: number;
  total: number;
}

export interface AgencyPaymentPassenger {
  id: string;
  seat_code: string | null;
  name: string;
  unit_price: number | null;
  status: string;
}

export interface AgencyPaymentAllocation {
  id: string;
  reservation_passenger_id: string;
  seat_code: string | null;
  amount_cents: number;
  created_at: string;
}

export interface AgencyPaymentDetail {
  payment: {
    id: string;
    status: string;
    amount_cents: number;
    currency: string;
    submitted_at: string;
    verified_at: string | null;
    verified_by: string | null;
    rejection_reason: string | null;
    has_proof: boolean;
  };
  reservation: {
    id: string;
    booker_name: string;
    booker_phone: string | null;
    contact_email: string | null;
    status: string;
    payment_status: string | null;
    created_at: string;
  };
  trip: {
    id: string;
    departure_time: string;
    vehicle_type: string;
    seat_price: number | null;
    origin: string;
    destination: string;
  } | null;
  passengers: AgencyPaymentPassenger[];
  allocations: AgencyPaymentAllocation[];
  totals: {
    active_passenger_count: number;
    expected_cents: number;
    allocated_cents: number;
    remaining_cents: number;
  };
}

export interface PaymentProofSignedUrlResult {
  url: string;
  expires_in_seconds: number;
}

// PostgREST representa los joins many-to-one como arrays; se normalizan
// a objeto único tras el cast through `unknown`.
interface PaymentListRow {
  id: string;
  status: string;
  amount_cents: number;
  currency: string;
  submitted_at: string;
  verified_at: string | null;
  rejection_reason: string | null;
  proof_url: string | null;
  reservation_id: string;
  reservations: unknown;
}

interface PaymentDetailRow {
  id: string;
  status: string;
  amount_cents: number;
  currency: string;
  submitted_at: string;
  verified_at: string | null;
  verified_by: string | null;
  rejection_reason: string | null;
  proof_url: string | null;
  reservation_id: string;
  reservations: unknown;
}

type NormalizedTrip = {
  id: string;
  departure_time: string;
  vehicle_type?: string;
  seat_price?: number | null;
  routes: unknown;
};

type NormalizedReservation = {
  id: string;
  booker_name: string;
  booker_phone?: string | null;
  contact_email: string | null;
  status: string;
  payment_status: string | null;
  created_at?: string;
  trips: unknown;
};

function normalizeTrip(trips: unknown): NormalizedTrip | null {
  return firstOrNull<NormalizedTrip>(
    trips as NormalizedTrip | NormalizedTrip[] | null,
  );
}

function normalizeReservation(reservations: unknown): NormalizedReservation | null {
  return firstOrNull<NormalizedReservation>(
    reservations as NormalizedReservation | NormalizedReservation[] | null,
  );
}

function normalizeRoute(
  routes: unknown,
): { origin: string; destination: string } | null {
  return firstOrNull<{ origin: string; destination: string }>(
    routes as
      | { origin: string; destination: string }
      | { origin: string; destination: string }[]
      | null,
  );
}

const LIST_SELECT = `
  id, status, amount_cents, currency, submitted_at, verified_at,
  rejection_reason, proof_url, reservation_id,
  reservations (
    id, booker_name, contact_email, status, payment_status,
    trips (
      id, departure_time,
      routes ( origin, destination )
    )
  )
`;

const DETAIL_SELECT = `
  id, status, amount_cents, currency, submitted_at, verified_at,
  verified_by, rejection_reason, proof_url, reservation_id,
  reservations (
    id, booker_name, booker_phone, contact_email, status, payment_status,
    created_at,
    trips (
      id, departure_time, vehicle_type, seat_price,
      routes ( origin, destination )
    )
  )
`;

function firstOrNull<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function mapListItem(row: PaymentListRow): AgencyPaymentListItem {
  const reservation = normalizeReservation(row.reservations);
  const trip = normalizeTrip(reservation?.trips);
  const route = normalizeRoute(trip?.routes);
  return {
    id: row.id,
    status: row.status,
    amount_cents: row.amount_cents,
    currency: row.currency,
    submitted_at: row.submitted_at,
    verified_at: row.verified_at,
    rejection_reason: row.rejection_reason,
    has_proof: Boolean(row.proof_url),
    reservation: {
      id: reservation?.id ?? row.reservation_id,
      booker_name: reservation?.booker_name ?? '',
      contact_email: reservation?.contact_email ?? null,
      status: reservation?.status ?? '',
      payment_status: reservation?.payment_status ?? null,
      trip: trip
        ? {
            id: trip.id,
            departure_time: trip.departure_time,
            origin: route?.origin ?? '',
            destination: route?.destination ?? '',
          }
        : null,
    },
  };
}

/**
 * Lista los pagos de una agencia con filtro de estado opcional y
 * paginación validada. El `agency_id` SIEMPRE sale de la sesión
 * autenticada; nunca se acepta del cliente.
 *
 * Orden estable: pagos pendientes primero (alfabéticamente 'pending'
 * < 'rejected' < 'verified'), luego por `submitted_at` descendente y
 * `id` como desempate. No expone `proof_url`, documentos personales
 * completos, tokens ni URLs privadas.
 */
export async function listAgencyPayments(
  input: ListAgencyPaymentsInput,
): Promise<ListAgencyPaymentsResult> {
  const from = (input.page - 1) * input.limit;
  const to = from + input.limit - 1;

  let query = supabaseAdmin
    .from('payments')
    .select(LIST_SELECT, { count: 'exact' })
    .eq('agency_id', input.agencyId)
    .order('status', { ascending: true })
    .order('submitted_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to);

  if (input.status) {
    query = query.eq('status', input.status);
  }

  const { data, error, count } = await query;

  if (error) {
    throw paymentError(
      'No se pudo listar los pagos. Intenta de nuevo',
      500,
      'PAYMENT_LIST_ERROR',
    );
  }

  return {
    payments: ((data ?? []) as unknown as PaymentListRow[]).map(mapListItem),
    page: input.page,
    limit: input.limit,
    total: count ?? 0,
  };
}

/**
 * Detalle completo de un pago para revisión de agencia. El filtro de
 * `agency_id` se aplica en la consulta del servidor; un pago ajeno o
 * inexistente produce el mismo 404. No expone documentos personales
 * completos ni la ruta del comprobante.
 */
export async function getAgencyPaymentDetail(input: {
  paymentId: string;
  agencyId: string;
}): Promise<AgencyPaymentDetail> {
  const { data, error } = await supabaseAdmin
    .from('payments')
    .select(DETAIL_SELECT)
    .eq('id', input.paymentId)
    .eq('agency_id', input.agencyId)
    .maybeSingle();

  if (error) {
    throw paymentError(
      'No se pudo cargar el pago. Intenta de nuevo',
      500,
      'PAYMENT_DETAIL_ERROR',
    );
  }

  // Mismo 404 para "no existe" y "es de otra agencia".
  if (!data) {
    throw paymentError('Pago no encontrado', 404, 'PAYMENT_NOT_FOUND');
  }

  const row = data as unknown as PaymentDetailRow;
  const reservation = normalizeReservation(row.reservations);
  const trip = normalizeTrip(reservation?.trips);
  const route = normalizeRoute(trip?.routes);
  const reservationId = reservation?.id ?? row.reservation_id;

  const [passengersResult, allocationsResult] = await Promise.all([
    supabaseAdmin
      .from('reservation_passengers')
      .select('id, seat_id, name, unit_price, status, seats ( seat_code )')
      .eq('reservation_id', reservationId)
      .order('seat_id'),
    supabaseAdmin
      .from('payment_allocations')
      .select(
        'id, reservation_passenger_id, amount_cents, created_at, reservation_passengers ( seat_id, seats ( seat_code ) )',
      )
      .eq('payment_id', row.id)
      .order('created_at'),
  ]);

  if (passengersResult.error || allocationsResult.error) {
    throw paymentError(
      'No se pudo cargar el pago. Intenta de nuevo',
      500,
      'PAYMENT_DETAIL_ERROR',
    );
  }

  type PassengerRow = {
    id: string;
    seat_id: string;
    name: string;
    unit_price: number | null;
    status: string;
    seats: unknown;
  };

  type AllocationRow = {
    id: string;
    reservation_passenger_id: string;
    amount_cents: number;
    created_at: string;
    reservation_passengers: unknown;
  };

  const passengers = ((passengersResult.data ?? []) as unknown as PassengerRow[]).map(
    (p) => ({
      id: p.id,
      seat_code: firstOrNull<{ seat_code: string }>(
        p.seats as { seat_code: string } | { seat_code: string }[] | null,
      )?.seat_code ?? null,
      name: p.name,
      unit_price: p.unit_price,
      status: p.status,
    }),
  );

  const allocations = ((allocationsResult.data ?? []) as unknown as AllocationRow[]).map(
    (a) => {
      const rp = firstOrNull<{ seats: unknown }>(
        a.reservation_passengers as { seats: unknown } | { seats: unknown }[] | null,
      );
      const seat = firstOrNull<{ seat_code: string }>(
        rp?.seats as { seat_code: string } | { seat_code: string }[] | null,
      );
      return {
        id: a.id,
        reservation_passenger_id: a.reservation_passenger_id,
        seat_code: seat?.seat_code ?? null,
        amount_cents: a.amount_cents,
        created_at: a.created_at,
      };
    },
  );

  const activePassengers = passengers.filter((p) => p.status === 'active');
  const expectedCents = activePassengers.reduce(
    (sum, p) => sum + (p.unit_price ?? 0),
    0,
  );
  const allocatedCents = allocations.reduce(
    (sum, a) => sum + a.amount_cents,
    0,
  );

  return {
    payment: {
      id: row.id,
      status: row.status,
      amount_cents: row.amount_cents,
      currency: row.currency,
      submitted_at: row.submitted_at,
      verified_at: row.verified_at,
      verified_by: row.verified_by,
      rejection_reason: row.rejection_reason,
      has_proof: Boolean(row.proof_url),
    },
    reservation: {
      id: reservation?.id ?? row.reservation_id,
      booker_name: reservation?.booker_name ?? '',
      booker_phone: reservation?.booker_phone ?? null,
      contact_email: reservation?.contact_email ?? null,
      status: reservation?.status ?? '',
      payment_status: reservation?.payment_status ?? null,
      created_at: reservation?.created_at ?? row.submitted_at,
    },
    trip: trip
      ? {
          id: trip.id,
          departure_time: trip.departure_time,
          vehicle_type: trip.vehicle_type ?? '',
          seat_price: trip.seat_price ?? null,
          origin: route?.origin ?? '',
          destination: route?.destination ?? '',
        }
      : null,
    passengers,
    allocations,
    totals: {
      active_passenger_count: activePassengers.length,
      expected_cents: expectedCents,
      allocated_cents: allocatedCents,
      remaining_cents: expectedCents - allocatedCents,
    },
  };
}

const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Comprueba que `proof_url` viva bajo un directorio UUID válido:
 *
 *  - `<reservation_id>/<sha256>.<ext>` — flujo 083 (MKT-005), donde la
 *    reserva ya existía antes del comprobante.
 *  - `<attempt_id>/<sha256>.<ext>`   — flujo MKT-007, donde la reserva
 *    recién nace al aprobar el intento y el archivo se subió contra el
 *    `checkout_attempt`.
 *
 * En ambos casos: sin subcarpetas, sin ".." y con extensión. La ruta
 * jamás llega del cliente (se lee de la fila de pago), pero igual se
 * valida aquí como defensa en profundidad frente a una fila corrupta.
 */
async function proofPathBelongsToPayment(
  proofPath: string,
  reservationId: string,
): Promise<boolean> {
  const separator = proofPath.indexOf('/');
  if (separator <= 0 || separator === proofPath.length - 1) return false;

  const dir = proofPath.slice(0, separator);
  const filename = proofPath.slice(separator + 1);

  if (filename.includes('/') || filename.includes('..')) return false;
  if (!/\.[a-z0-9]+$/i.test(filename)) return false;
  if (!UUID_DIR_RE.test(dir)) return false;
  if (dir === reservationId) return true;

  // MKT-007: el comprobante se subió contra un checkout_attempt. Solo
  // un intento VERIFICADO genera pagos, y su id es exactamente el
  // directorio, así que basta confirmar que esa fila existe y que su
  // proof_path sigue apuntando al mismo objeto.
  const { data, error } = await supabaseAdmin
    .from('checkout_attempts')
    .select('id, proof_path, status')
    .eq('id', dir)
    .maybeSingle();

  if (error || !data) return false;
  const attempt = data as { proof_path: string | null; status: string };
  return attempt.status === 'verified' && attempt.proof_path === proofPath;
}

/**
 * Genera una URL firmada de corta duración para el comprobante de un
 * pago. La ruta NUNCA llega del cliente: se lee de `payments.proof_url`
 * y se valida que pertenezca al directorio de la reserva del propio pago
 * o al del checkout_attempt que la generó (MKT-007).
 *
 * El bucket `payment-proofs` es privado (083); la URL firmada es la
 * única vía de acceso y caduca en `PROOF_SIGNED_URL_TTL_SECONDS`.
 * La URL firmada no se registra en logs.
 */
export async function getPaymentProofSignedUrl(input: {
  paymentId: string;
  agencyId: string;
}): Promise<PaymentProofSignedUrlResult> {
  const { data, error } = await supabaseAdmin
    .from('payments')
    .select('id, reservation_id, proof_url')
    .eq('id', input.paymentId)
    .eq('agency_id', input.agencyId)
    .maybeSingle();

  if (error) {
    throw paymentError(
      'No se pudo cargar el comprobante. Intenta de nuevo',
      500,
      'PAYMENT_PROOF_ERROR',
    );
  }

  if (!data) {
    throw paymentError('Pago no encontrado', 404, 'PAYMENT_NOT_FOUND');
  }

  const proofPath = (data as { proof_url: string | null }).proof_url;
  const reservationId = (data as { reservation_id: string }).reservation_id;

  if (!proofPath) {
    throw paymentError(
      'Este pago no tiene comprobante adjunto',
      404,
      'PAYMENT_PROOF_NOT_FOUND',
    );
  }

  // Defensa en profundidad: la ruta almacenada vive bajo un directorio
  // UUID (la reserva en el flujo 083, o el checkout_attempt en MKT-007)
  // y jamás contiene subcarpetas, ".." ni un nombre sin extensión.
  if (!(await proofPathBelongsToPayment(proofPath, reservationId))) {
    throw paymentError(
      'Este pago no tiene comprobante adjunto',
      404,
      'PAYMENT_PROOF_NOT_FOUND',
    );
  }

  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from(PROOF_BUCKET)
    .createSignedUrl(proofPath, PROOF_SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    throw paymentError(
      'No se pudo generar el enlace del comprobante. Intenta de nuevo',
      500,
      'PAYMENT_STORAGE_ERROR',
    );
  }

  return {
    url: signed.signedUrl,
    expires_in_seconds: PROOF_SIGNED_URL_TTL_SECONDS,
  };
}
