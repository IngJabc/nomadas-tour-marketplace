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
