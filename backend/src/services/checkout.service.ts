import { createHash } from 'node:crypto';
import type { Request } from 'express';
import Busboy from 'busboy';
import { z } from 'zod';
import { supabaseAdmin } from '../config/database.js';
import { AppError, ValidationError } from '../errors/index.js';
import { runCheckoutCleanup } from './checkout-cleanup.service.js';

// ── Constantes ───────────────────────────────────────────────────────────────

/** Mismo bucket privado que usa 083 para los comprobantes de pago. */
export const PROOF_BUCKET = 'payment-proofs';
/** 5 MiB — el límite del bucket y del parser multipart. */
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
/** 300 s — URL firmada del comprobante (idéntico al límite de MKT-006). */
export const PROOF_SIGNED_URL_TTL_SECONDS = 300;

/** Máximo de comprobantes por intento: 1 envío + 2 reenvíos (087). */
export const MAX_PROOF_SUBMISSIONS = 3;

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

const DOCUMENT_PATTERN = /^\d{7,8}$/;
const PHONE_PATTERN = /^(0\d{10}|\+\d{12,15})$/;

/** Rechaza cualquier fecha futura más allá de la tolerancia de reloj. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function checkoutError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, statusCode, code);
}

// ── Multipart: archivo + campos de conciliación ──────────────────────────────

export interface ParsedCheckoutProof {
  buffer: Buffer;
  mimeType: string;
  fields: {
    payment_reference: string;
    bank_origin: string;
    payment_datetime: string;
  };
}

const REQUIRED_FIELDS = ['payment_reference', 'bank_origin', 'payment_datetime'] as const;

type RequiredField = (typeof REQUIRED_FIELDS)[number];

function isRequiredField(name: string): name is RequiredField {
  return (REQUIRED_FIELDS as readonly string[]).includes(name);
}

/**
 * Parsea el request como multipart: exactamente UN archivo bajo el campo
 * `proof` y exactamente los tres campos de conciliación. Cero campos
 * extra, cero archivos extra, máximo 5 MiB.
 *
 * No confía en el nombre original del archivo: la ruta de almacenamiento
 * se deriva del contenido, nunca del filename. Los tres campos se
 * normalizan aquí (trim, espacios colapsados) y el RPC 087 vuelve a
 * normalizarlos antes del CHECK.
 *
 * Maneja parseo inválido, streams abortados y desconexiones sin dejar
 * pipes abiertos: al primer error se desacopla y drena el resto.
 */
export function parseCheckoutProofUpload(req: Request): Promise<ParsedCheckoutProof> {
  return new Promise((resolve, reject) => {
    const multipartError = checkoutError(
      'Envía el comprobante como un único archivo "proof" junto a payment_reference, bank_origin y payment_datetime',
      400,
      'CHECKOUT_MULTIPART_INVALID',
    );

    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          files: 1,
          fields: REQUIRED_FIELDS.length,
          fieldSize: 512,
          fileSize: MAX_PROOF_BYTES,
        },
      });
    } catch {
      reject(multipartError);
      req.resume();
      return;
    }

    let failure: AppError | null = null;
    let upload: { mimeType: string; chunks: Buffer[]; ended: boolean } | null = null;
    const fields: Partial<Record<RequiredField, string>> = {};
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
        reject(checkoutError('Adjunta el comprobante de pago', 400, 'PAYMENT_FILE_MISSING'));
        return;
      }
      const missing = REQUIRED_FIELDS.filter((name) => fields[name] === undefined);
      if (missing.length > 0) {
        reject(
          checkoutError(
            `Faltan datos de conciliación: ${missing.join(', ')}`,
            400,
            'CHECKOUT_RECONCILIATION_INVALID',
          ),
        );
        return;
      }
      resolve({
        buffer: Buffer.concat(upload.chunks),
        mimeType: upload.mimeType,
        fields: {
          payment_reference: fields.payment_reference!,
          bank_origin: fields.bank_origin!,
          payment_datetime: fields.payment_datetime!,
        },
      });
    };

    let stopped = false;

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
        checkoutError(
          'La carga del comprobante fue interrumpida',
          400,
          'CHECKOUT_MULTIPART_INVALID',
        ),
      );
      stop();
    }

    parser.on('file', (fieldName, stream, info) => {
      stream.on('error', () => {
        fail(multipartError);
      });

      if (fieldName !== 'proof' || upload) {
        fail(
          checkoutError(
            'La solicitud debe contener únicamente el archivo "proof"',
            400,
            'CHECKOUT_MULTIPART_INVALID',
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
          checkoutError('El comprobante no puede superar 5 MB', 413, 'PAYMENT_FILE_TOO_LARGE'),
        );
        stop();
      });
      stream.on('end', () => {
        if (upload) upload.ended = true;
      });
    });

    parser.on('field', (name, value) => {
      if (!isRequiredField(name) || fields[name as RequiredField] !== undefined) {
        fail(multipartError);
        stop();
        return;
      }
      fields[name as RequiredField] = value;
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
        checkoutError(
          'No se pudo procesar el archivo del comprobante',
          400,
          'CHECKOUT_MULTIPART_INVALID',
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

// ── Validación de contenido (magic bytes) ────────────────────────────────────

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
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}

function detectProofType(buffer: Buffer): ProofType | null {
  if (hasPngSignature(buffer)) return 'png';
  if (hasJpegSignature(buffer)) return 'jpg';
  if (hasWebpSignature(buffer)) return 'webp';
  if (hasPdfSignature(buffer)) return 'pdf';
  return null;
}

/**
 * Valida el comprobante: no vacío, ≤ 5 MiB, MIME declarado permitido y
 * coincidente con las magic bytes del contenido. Nada de SVG/HTML ni
 * formatos activos: el tipo detectado manda y de él se deriva la
 * extensión (.jpg para JPEG, igual que la regex del RPC 087).
 */
function validateProofFile(proof: { buffer: Buffer; mimeType: string }): {
  extension: string;
  mimeType: string;
} {
  if (proof.buffer.length === 0) {
    throw checkoutError('El comprobante está vacío', 400, 'PAYMENT_FILE_INVALID');
  }
  if (proof.buffer.length > MAX_PROOF_BYTES) {
    throw checkoutError(
      'El comprobante no puede superar 5 MB',
      413,
      'PAYMENT_FILE_TOO_LARGE',
    );
  }
  if (!ALLOWED_MIMES.has(proof.mimeType)) {
    throw checkoutError(
      'El comprobante debe ser PNG, JPEG, WEBP o PDF',
      400,
      'PAYMENT_FILE_INVALID',
    );
  }

  const detected = detectProofType(proof.buffer);
  if (!detected) {
    throw checkoutError(
      'El contenido del archivo no corresponde a un comprobante válido',
      400,
      'PAYMENT_FILE_INVALID',
    );
  }

  const detectedMime = MIME_BY_TYPE[detected];
  if (detectedMime !== proof.mimeType) {
    throw checkoutError(
      'El tipo declarado del archivo no coincide con su contenido',
      400,
      'PAYMENT_FILE_INVALID',
    );
  }

  return { extension: EXTENSION_BY_TYPE[detected], mimeType: detectedMime };
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const uuidSchema = z.string().uuid();

const passengerSchema = z.object({
  seat_id: uuidSchema,
  first_name: z.string().trim().min(2, 'Escribe el nombre del pasajero'),
  last_name: z.string().trim().min(2, 'Escribe el apellido del pasajero'),
  document: z.string().trim().regex(DOCUMENT_PATTERN, 'Debe tener 7 u 8 dígitos'),
  phone: z.string().trim().regex(PHONE_PATTERN, 'Ingresa un teléfono válido (ej. 04241234567)'),
});

export const createCheckoutAttemptSchema = z.object({
  trip_id: uuidSchema,
  agency_id: uuidSchema,
  seat_ids: z
    .array(uuidSchema)
    .min(1, 'Selecciona al menos un asiento')
    .refine((ids) => new Set(ids).size === ids.length, 'Asientos duplicados'),
  passengers: z
    .array(passengerSchema)
    .min(1, 'Faltan datos de los pasajeros')
    .refine(
      (list) => new Set(list.map((p) => p.seat_id)).size === list.length,
      'Asientos duplicados',
    )
    .refine(
      (list) => new Set(list.map((p) => p.document)).size === list.length,
      'Documento repetido en esta reserva',
    ),
});

export type CreateCheckoutAttemptInput = z.infer<typeof createCheckoutAttemptSchema> & {
  customerId: string;
  idempotencyKey: string;
};

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Invalid input', result.error.issues);
  }
  return result.data;
}

// ── Traducción de errores del RPC ────────────────────────────────────────────

function rpcErrorCode(message: string): string | null {
  const match = /^(ERR_[A-Z_]+):\s*/.exec(message || '');
  return match ? match[1] : null;
}

/**
 * Traduce los RAISE EXCEPTION de las RPC 087 al envelope estándar del
 * backend. Los códigos ERR_* se conservan; los mensajes SQL nunca
 * llegan al cliente. Los fallos de ownership responden 404 para no
 * filtrar que el intento pertenece a otra persona.
 */
function mapRpcError(error: { message: string }): AppError {
  const code = rpcErrorCode(error.message || '');

  switch (code) {
    case 'ERR_CUSTOMER_REQUIRED':
      return checkoutError(
        'Solo cuentas de cliente pueden iniciar un checkout',
        401,
        'UNAUTHORIZED',
      );
    case 'ERR_CHECKOUT_INPUT':
    case 'ERR_NO_SEATS':
    case 'ERR_SEAT_DUPLICATE':
      return checkoutError('Datos de checkout inválidos', 400, 'CHECKOUT_INPUT_INVALID');
    case 'ERR_PASSENGER_MISMATCH':
      return checkoutError(
        'Los datos de los pasajeros no coinciden con los asientos',
        400,
        'CHECKOUT_PASSENGER_MISMATCH',
      );
    case 'ERR_PASSENGER_DATA':
      return checkoutError(
        'Revisa los datos de cada pasajero',
        400,
        'CHECKOUT_PASSENGER_DATA',
      );
    case 'ERR_PASSENGER_DUPLICATE_DOCUMENT':
      return checkoutError(
        'No se permite un documento repetido en la misma compra',
        400,
        'CHECKOUT_PASSENGER_DUPLICATE_DOCUMENT',
      );
    case 'ERR_TRIP_NOT_FOUND':
      return checkoutError('Viaje no encontrado', 404, 'CHECKOUT_TRIP_NOT_FOUND');
    case 'ERR_TRIP_NOT_ACTIVE':
      return checkoutError('Este viaje ya no está disponible', 409, 'CHECKOUT_TRIP_NOT_ACTIVE');
    case 'ERR_TRIP_DEPARTED':
      return checkoutError(
        'El viaje ya partió. No se puede iniciar un checkout',
        409,
        'CHECKOUT_TRIP_DEPARTED',
      );
    case 'ERR_TRIP_PRICE_MISSING':
      return checkoutError(
        'No se pudo calcular el total del viaje',
        422,
        'CHECKOUT_TRIP_PRICE_MISSING',
      );
    case 'ERR_AGENCY_NOT_ASSIGNED':
      return checkoutError(
        'Esta agencia no ofrece el viaje seleccionado',
        404,
        'CHECKOUT_AGENCY_NOT_ASSIGNED',
      );
    case 'ERR_SEAT_NOT_OWNED':
    case 'ERR_SEAT_NOT_FOUND':
      // Mismo 404 que "no existe": no se filtra que el asiento es de otro.
      return checkoutError('Selecciona los asientos de nuevo', 404, 'CHECKOUT_SEAT_NOT_OWNED');
    case 'ERR_SEAT_LOCK_EXPIRED':
      return checkoutError(
        'Tu selección de asientos expiró. Elígela de nuevo',
        409,
        'CHECKOUT_LOCK_EXPIRED',
      );
    case 'ERR_CHECKOUT_SEAT_CLAIMED':
      return checkoutError(
        'Uno de tus asientos ya forma parte de otra compra en curso',
        409,
        'CHECKOUT_SEATS_CLAIMED',
      );
    case 'ERR_CHECKOUT_IDEMPOTENCY_CONFLICT':
      return checkoutError(
        'La clave de idempotencia ya se usó con otra compra',
        409,
        'CHECKOUT_IDEMPOTENCY_CONFLICT',
      );
    case 'ERR_CHECKOUT_ATTEMPT_NOT_FOUND':
    case 'ERR_CHECKOUT_NOT_OWNER':
      return checkoutError('Compra no encontrada', 404, 'CHECKOUT_ATTEMPT_NOT_FOUND');
    case 'ERR_CHECKOUT_RECONCILIATION':
      return checkoutError(
        'Revisa los datos del pago (referencia, banco y fecha)',
        400,
        'CHECKOUT_RECONCILIATION_INVALID',
      );
    case 'ERR_CHECKOUT_ATTEMPT_CLOSED':
      return checkoutError(
        'Esta compra ya fue cerrada',
        409,
        'CHECKOUT_ATTEMPT_CLOSED',
      );
    case 'ERR_CHECKOUT_PROOF_PENDING':
      return checkoutError(
        'Ya tienes un comprobante esperando revisión',
        409,
        'CHECKOUT_PROOF_PENDING',
      );
    case 'ERR_CHECKOUT_WINDOW_EXPIRED':
      return checkoutError(
        'El plazo de revisión de tu compra venció',
        409,
        'CHECKOUT_WINDOW_EXPIRED',
      );
    case 'ERR_CHECKOUT_PROOF_LIMIT':
      return checkoutError(
        'Ya enviaste los tres comprobantes permitidos',
        409,
        'CHECKOUT_PROOF_LIMIT',
      );
    case 'ERR_CHECKOUT_PAYMENT_METHOD_FROZEN':
      return checkoutError(
        'El método de pago de esta compra ya no se puede cambiar',
        409,
        'CHECKOUT_PAYMENT_METHOD_FROZEN',
      );
    case 'ERR_CHECKOUT_PAYMENT_METHOD_INVALID':
      return checkoutError(
        'El método de pago seleccionado ya no está disponible',
        400,
        'CHECKOUT_PAYMENT_METHOD_INVALID',
      );
    case 'ERR_CHECKOUT_PAYMENT_METHOD_REQUIRED':
      // Mismo mensaje y código que el guard de verifyAttemptReady: si la
      // agencia tiene canales activos, elegir uno antes del comprobante.
      return checkoutError(
        'Selecciona un método de pago antes de enviar el comprobante',
        409,
        'PAYMENT_METHOD_REQUIRED',
      );
    case 'ERR_CHECKOUT_LOCK_EXPIRED':
      // El RPC 092 (step 6) exige que los asientos del intento sigan
      // bloqueados POR ESTE intento y con TTL vigente. Aquí se traduce a un
      // 409 accionable en lugar del 500 genérico: los asientos ya no son de
      // esta compra, el reintento no puede continuar y el cliente debe
      // empezar de nuevo (carrera entre el pre-chequeo de pantalla y el
      // envío, o bloqueo liberado mientras el comprobante se subía).
      return checkoutError(
        'Los asientos de esta compra ya no están disponibles. Debes buscar otro viaje para continuar.',
        409,
        'CHECKOUT_SEATS_LOST',
      );
    default:
      return checkoutError(
        'No se pudo procesar la compra. Intenta de nuevo',
        500,
        'CHECKOUT_ERROR',
      );
  }
}

function callRpc(fn: string, args: Record<string, unknown>): PromiseLike<unknown> {
  return supabaseAdmin.rpc(fn, args) as unknown as PromiseLike<unknown>;
}

interface RpcJson {
  data: Record<string, unknown> | null;
  error: { message: string } | null;
}

// ── 1) Crear el intento ──────────────────────────────────────────────────────

export interface CreateCheckoutAttemptResult {
  attempt_id: string;
  trip_id: string;
  agency_id: string;
  customer_id: string;
  status: string;
  seat_ids: string[];
  passenger_count: number;
  unit_price: number;
  amount_cents: number;
  proof_count: number;
  expires_at: string;
  idempotent: boolean;
}

/**
 * Crea el checkout_attempt (status='created') y reclama los locks en
 * UNA transacción. NO crea reservations ni payments: eso ocurre
 * exclusivamente en verify_checkout_attempt.
 *
 * El payload se normaliza aquí (orden de pasajeros = orden de seat_ids)
 * y el RPC vuelve a validarlo contra el snapshot.
 *
 * MKT-008: la ausencia de canales de pago activos NO bloquea la creación
 * del intento. El pago coordinado directamente con la agencia se resuelve
 * en la carga del comprobante (ver verifyAttemptReady); aquí no se
 * consulta agency_payment_methods.
 */
export async function createCheckoutAttempt(
  input: CreateCheckoutAttemptInput,
): Promise<CreateCheckoutAttemptResult> {
  const data = parseOrThrow(createCheckoutAttemptSchema, {
    trip_id: input.trip_id,
    agency_id: input.agency_id,
    seat_ids: input.seat_ids,
    passengers: input.passengers,
  });

  const { data: result, error } = (await callRpc('create_checkout_attempt', {
    p_trip_id: data.trip_id,
    p_customer_id: input.customerId,
    p_agency_id: data.agency_id,
    p_seat_ids: data.seat_ids,
    p_passenger_data: data.passengers,
    p_idempotency_key: input.idempotencyKey,
  })) as RpcJson;

  if (error) throw mapRpcError(error);
  if (!result?.attempt_id) {
    throw checkoutError(
      'No se pudo iniciar la compra. Intenta de nuevo',
      500,
      'CHECKOUT_ERROR',
    );
  }

  return result as unknown as CreateCheckoutAttemptResult;
}

// ── Pre-chequeo del intento (antes de subir nada) ────────────────────────────

/**
 * Verifica ANTES de subir que el intento exista, pertenezca al customer
 * autenticado y esté en un estado que permita envíos. No filtra intentos
 * ajenos: todas las fallas responden el mismo 404. Nunca hace UPDATE.
 *
 * MKT-007.4 + MKT-008: si el intento no tiene canal elegido
 * (payment_method_id), la subida solo procede en dos escenarios:
 *   1) Primer envío (proof_count = 0) y la agencia no tiene ningún
 *      canal activo → pago coordinado (la RPC 092 estampa
 *      agency_direct). Si la agencia sí tiene canales → 409
 *      PAYMENT_METHOD_REQUIRED (elegir canal antes del comprobante).
 *   2) Reenvío (proof_count >= 1) congelado en agency_direct: el modo
 *      se confirma por el SNAPSHOT del intento, nunca por el mero
 *      hecho de que payment_method_id sea NULL. Un snapshot de canal
 *      real con id NULL (borrado físico del canal) NO se convierte en
 *      coordinado → 409.
 * La consulta de canales ocurre solo en el escenario 1: el flujo con
 * canal elegido y el reenvío congelado no la necesitan.
 */
async function verifyAttemptReady(attemptId: string, customerId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('checkout_attempts')
    .select(
      'id, customer_id, agency_id, status, proof_count, expires_at, payment_method_id, payment_method_snapshot',
    )
    .eq('id', attemptId)
    .maybeSingle();

  if (error) {
    throw checkoutError(
      'No se pudo verificar la compra. Intenta de nuevo',
      500,
      'CHECKOUT_ERROR',
    );
  }

  const attempt = data as {
    id: string;
    customer_id: string;
    agency_id: string;
    status: string;
    proof_count: number;
    expires_at: string;
    payment_method_id: string | null;
    payment_method_snapshot: { method?: string } | null;
  } | null;

  if (!attempt || attempt.customer_id !== customerId) {
    throw checkoutError('Compra no encontrada', 404, 'CHECKOUT_ATTEMPT_NOT_FOUND');
  }

  if (['verified', 'rejected_final', 'expired', 'cancelled'].includes(attempt.status)) {
    throw checkoutError('Esta compra ya fue cerrada', 409, 'CHECKOUT_ATTEMPT_CLOSED');
  }
  // MKT-010: la ventana vencida manda sobre cualquier otro estado abierto.
  // Un `pending_review` cuya revisión de 24 h venció está expirado, no
  // "en revisión". La expiración se ESCRIBE en la BD con la misma RPC de
  // cleanup del loop periódico (idempotente) antes de responder 409: el
  // servidor es la autoridad del tiempo, nunca el cliente.
  if (Date.parse(attempt.expires_at) <= Date.now()) {
    await runCheckoutCleanup();
    throw checkoutError('El plazo de revisión de tu compra venció', 409, 'CHECKOUT_WINDOW_EXPIRED');
  }
  if (attempt.status === 'pending_review') {
    throw checkoutError(
      'Ya tienes un comprobante esperando revisión',
      409,
      'CHECKOUT_PROOF_PENDING',
    );
  }
  if (attempt.proof_count >= MAX_PROOF_SUBMISSIONS) {
    throw checkoutError(
      'Ya enviaste los tres comprobantes permitidos',
      409,
      'CHECKOUT_PROOF_LIMIT',
    );
  }
  if (!attempt.payment_method_id) {
    // El modo congelado se confirma por el snapshot, nunca se infiere
    // del NULL del id: la misma regla vive en el CHECK/RPC 092.
    const snapshotMethod = attempt.payment_method_snapshot?.method ?? null;

    if (attempt.proof_count > 0) {
      // Reenvío: tras el primer comprobante la selección ya no puede
      // cambiar (select_checkout_payment_method está FROZEN). Solo el
      // modo agency_direct congelado permite reenviar sin canal aunque
      // la agencia hoy tenga canales activos.
      if (snapshotMethod !== 'agency_direct') {
        throw checkoutError(
          'Selecciona un método de pago antes de enviar el comprobante',
          409,
          'PAYMENT_METHOD_REQUIRED',
        );
      }
      return;
    }

    // Primer envío: un snapshot huérfano de un canal real (id NULL por
    // borrado físico con ON DELETE SET NULL) no se convierte en
    // agency_direct (espejo del guard B1 de la RPC 092: sin esto la
    // base de datos rechazaría la fila con 23514).
    if (snapshotMethod !== null && snapshotMethod !== 'agency_direct') {
      throw checkoutError(
        'Selecciona un método de pago antes de enviar el comprobante',
        409,
        'PAYMENT_METHOD_REQUIRED',
      );
    }

    // MKT-008: sin canal elegido, la subida solo procede si la agencia
    // no tiene ningún canal activo (pago coordinado). Si tiene canales,
    // el cliente debe elegir uno (MKT-007.4). La misma regla vive en el
    // CHECK/RPC 092 a nivel de base de datos.
    const { count, error: channelsError } = await supabaseAdmin
      .from('agency_payment_methods')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', attempt.agency_id)
      .eq('method', 'pago_movil')
      .eq('is_active', true)
      .is('deleted_at', null);

    if (channelsError) {
      throw checkoutError(
        'No se pudo verificar la compra. Intenta de nuevo',
        500,
        'CHECKOUT_ERROR',
      );
    }
    if (count && count > 0) {
      throw checkoutError(
        'Selecciona un método de pago antes de enviar el comprobante',
        409,
        'PAYMENT_METHOD_REQUIRED',
      );
    }
  }
}

// ── Limpieza condicionada tras un fallo del RPC ──────────────────────────────

/**
 * Borra el objeto recién subido SOLO si ningún pago ni intento lo
 * referencia. Nunca elimina algo que una aprobación confirmada pudiera
 * necesitar. Cualquier fallo se loguea sin enmascarar el error original.
 */
async function cleanupUploadedProof(proofPath: string): Promise<void> {
  try {
    const { data: paymentRef, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('id')
      .eq('proof_url', proofPath)
      .limit(1)
      .maybeSingle();

    if (paymentError) {
      console.error('[checkout] cleanup omitido: no se pudo verificar payments', {
        proof_error: paymentError.message,
      });
      return;
    }
    if (paymentRef) {
      console.error('[checkout] cleanup omitido: el objeto ya está referenciado por un pago');
      return;
    }

    const { data: attemptRef, error: attemptError } = await supabaseAdmin
      .from('checkout_attempts')
      .select('id')
      .eq('proof_path', proofPath)
      .limit(1)
      .maybeSingle();

    if (attemptError) {
      console.error('[checkout] cleanup omitido: no se pudo verificar checkout_attempts', {
        proof_error: attemptError.message,
      });
      return;
    }
    if (attemptRef) {
      console.error('[checkout] cleanup omitido: el objeto ya está referenciado por un intento');
      return;
    }

    const { error: removeError } = await supabaseAdmin.storage
      .from(PROOF_BUCKET)
      .remove([proofPath]);

    if (removeError) {
      console.error('[checkout] cleanup del comprobante falló', {
        proof_error: removeError.message,
      });
    }
  } catch (cleanupError) {
    console.error('[checkout] cleanup del comprobante falló', {
      proof_error:
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}

// ── 2) Someter el comprobante ────────────────────────────────────────────────

export interface SubmitCheckoutProofInput {
  attemptId: string;
  customerId: string;
  idempotencyKey: string;
  proof: ParsedCheckoutProof;
}

export interface SubmitCheckoutProofResult {
  attempt_id: string;
  status: string;
  proof_count: number;
  remaining_submissions: number;
  proof_path: string;
  payment_reference: string;
  bank_origin: string;
  payment_datetime: string;
  amount_cents: number;
  expires_at: string;
  idempotent: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Valida y normaliza los tres datos de conciliación ANTES de subir.
 * El RPC vuelve a validarlos (es la autoridad del CHECK), pero así el
 * cliente recibe un 400 claro y no sube un archivo que va a rechazarse.
 */
function parseReconciliation(fields: ParsedCheckoutProof['fields']): {
  payment_reference: string;
  bank_origin: string;
  payment_datetime: string;
} {
  const payment_reference = normalizeWhitespace(fields.payment_reference);
  const bank_origin = normalizeWhitespace(fields.bank_origin);

  if (!payment_reference || payment_reference.length > 100) {
    throw checkoutError(
      'La referencia del pago es obligatoria (máx. 100 caracteres)',
      400,
      'CHECKOUT_RECONCILIATION_INVALID',
    );
  }
  if (!bank_origin || bank_origin.length > 120) {
    throw checkoutError(
      'El banco de origen es obligatorio (máx. 120 caracteres)',
      400,
      'CHECKOUT_RECONCILIATION_INVALID',
    );
  }

  const parsed = new Date(fields.payment_datetime);
  if (Number.isNaN(parsed.getTime())) {
    throw checkoutError(
      'Indica la fecha y hora del pago',
      400,
      'CHECKOUT_RECONCILIATION_INVALID',
    );
  }
  if (parsed.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
    throw checkoutError(
      'La fecha del pago no puede estar en el futuro',
      400,
      'CHECKOUT_RECONCILIATION_INVALID',
    );
  }

  return {
    payment_reference,
    bank_origin,
    payment_datetime: parsed.toISOString(),
  };
}

/**
 * Flujo completo del envío de un comprobante:
 *
 *  1. Pre-chequeo del intento (dueño + estado + ventana) — antes de subir.
 *  2. Validación de conciliación y magic bytes, ruta determinista
 *     `{attempt_id}/{sha256(contenido)}.{ext}` — sin usar el filename.
 *  3. Upload privado al bucket `payment-proofs` con `upsert: true`.
 *  4. RPC `submit_checkout_proof` con p_customer_id de la sesión.
 *  5. Si el RPC falla, limpieza condicionada del objeto recién subido.
 *
 * Esta función nunca hace UPDATE sobre checkout_attempts/seats/payments:
 * todo eso vive dentro del RPC.
 */
export async function submitCheckoutProof(
  input: SubmitCheckoutProofInput,
): Promise<SubmitCheckoutProofResult> {
  await verifyAttemptReady(input.attemptId, input.customerId);

  const reconciliation = parseReconciliation(input.proof.fields);
  const file = validateProofFile(input.proof);

  const digest = createHash('sha256').update(input.proof.buffer).digest('hex');
  const proofPath = `${input.attemptId}/${digest}.${file.extension}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(PROOF_BUCKET)
    .upload(proofPath, input.proof.buffer, {
      contentType: file.mimeType,
      upsert: true,
    });

  if (uploadError) {
    throw checkoutError(
      'No se pudo almacenar el comprobante. Intenta de nuevo',
      500,
      'PAYMENT_STORAGE_ERROR',
    );
  }

  const { data, error } = (await callRpc('submit_checkout_proof', {
    p_attempt_id: input.attemptId,
    p_customer_id: input.customerId,
    p_idempotency_key: input.idempotencyKey,
    p_proof_path: proofPath,
    p_payment_reference: reconciliation.payment_reference,
    p_bank_origin: reconciliation.bank_origin,
    p_payment_datetime: reconciliation.payment_datetime,
  })) as RpcJson;

  if (error) {
    const mapped = mapRpcError(error);
    await cleanupUploadedProof(proofPath);
    throw mapped;
  }

  const row = data as (SubmitCheckoutProofResult & { remaining_submissions?: number }) | null;
  if (!row?.attempt_id) {
    await cleanupUploadedProof(proofPath);
    throw checkoutError(
      'No se pudo registrar el comprobante. Intenta de nuevo',
      500,
      'CHECKOUT_ERROR',
    );
  }

  return {
    ...row,
    remaining_submissions: row.remaining_submissions ?? MAX_PROOF_SUBMISSIONS - row.proof_count,
  };
}

// ── 3) Consultar el intento (dueño) ──────────────────────────────────────────

export interface CheckoutAttemptView {
  attempt_id: string;
  status: string;
  trip_id: string;
  agency_id: string;
  seat_ids: string[];
  seat_codes: string[];
  passenger_count: number;
  passenger_data: unknown;
  unit_price: number;
  amount_cents: number;
  proof_count: number;
  remaining_submissions: number;
  payment_reference: string | null;
  bank_origin: string | null;
  payment_datetime: string | null;
  proof_submitted_at: string | null;
  review_started_at: string | null;
  rejection_reason: string | null;
  rejection_count: number;
  history: unknown;
  expires_at: string;
  created_at: string;
  closed_at: string | null;
  verified_at: string | null;
}

/**
 * Estado del intento para su dueño. Devuelve los datos de conciliación
 * y el snapshot de pasajeros (que la propia persona escribió) pero
 * NUNCA la ruta del comprobante: el archivo solo se sirve con URL
 * firmada desde el área de agencia.
 *
 * MKT-010: la consulta también valida la ventana. Si el intento está
 * abierto y `expires_at` ya venció, se ejecuta la RPC de cleanup
 * (idempotente, la misma del loop periódico) y se relee el estado:
 * el cliente ve `expired` y los locks quedan liberados sin depender
 * de que el proceso de limpieza haya corrido en ese instante.
 */
export async function getCheckoutAttempt(input: {
  attemptId: string;
  customerId: string;
}): Promise<CheckoutAttemptView> {
  const fetchRow = async () => {
    const { data, error } = await supabaseAdmin
      .from('checkout_attempts')
      .select(
        'id, status, trip_id, agency_id, seat_ids, passenger_data, unit_price, amount_cents, ' +
          'proof_count, payment_reference, bank_origin, payment_datetime, proof_submitted_at, ' +
          'review_started_at, rejection_reason, rejection_count, history, expires_at, ' +
          'created_at, closed_at, verified_at',
      )
      .eq('id', input.attemptId)
      .eq('customer_id', input.customerId)
      .maybeSingle();

    if (error) {
      throw checkoutError(
        'No se pudo cargar la compra. Intenta de nuevo',
        500,
        'CHECKOUT_ERROR',
      );
    }
    if (!data) {
      throw checkoutError('Compra no encontrada', 404, 'CHECKOUT_ATTEMPT_NOT_FOUND');
    }
    return data as unknown as Record<string, unknown> & {
      seat_ids: string[];
      passenger_data: unknown[];
      proof_count: number;
    };
  };

  let row = await fetchRow();

  const openStatuses = ['created', 'pending_review', 'rejected'];
  if (
    openStatuses.includes(row.status as string) &&
    Date.parse(row.expires_at as string) <= Date.now()
  ) {
    await runCheckoutCleanup();
    row = await fetchRow();
  }

  const { data: seats, error: seatsError } = await supabaseAdmin
    .from('seats')
    .select('id, seat_code')
    .in('id', row.seat_ids);

  if (seatsError) {
    throw checkoutError(
      'No se pudo cargar la compra. Intenta de nuevo',
      500,
      'CHECKOUT_ERROR',
    );
  }

  const codeById = new Map<string, string>(
    ((seats ?? []) as { id: string; seat_code: string }[]).map((s) => [s.id, s.seat_code]),
  );

  const proofCount = row.proof_count;

  return {
    attempt_id: row.id as string,
    status: row.status as string,
    trip_id: row.trip_id as string,
    agency_id: row.agency_id as string,
    seat_ids: row.seat_ids,
    seat_codes: row.seat_ids.map((id) => codeById.get(id) ?? id),
    passenger_count: row.seat_ids.length,
    passenger_data: row.passenger_data,
    unit_price: row.unit_price as number,
    amount_cents: row.amount_cents as number,
    proof_count: proofCount,
    remaining_submissions: Math.max(0, MAX_PROOF_SUBMISSIONS - proofCount),
    payment_reference: (row.payment_reference as string | null) ?? null,
    bank_origin: (row.bank_origin as string | null) ?? null,
    payment_datetime: (row.payment_datetime as string | null) ?? null,
    proof_submitted_at: (row.proof_submitted_at as string | null) ?? null,
    review_started_at: (row.review_started_at as string | null) ?? null,
    rejection_reason: (row.rejection_reason as string | null) ?? null,
    rejection_count: (row.rejection_count as number) ?? 0,
    history: row.history,
    expires_at: row.expires_at as string,
    created_at: row.created_at as string,
    closed_at: (row.closed_at as string | null) ?? null,
    verified_at: (row.verified_at as string | null) ?? null,
  };
}

// ── 4) Cancelar el intento ───────────────────────────────────────────────────

export interface CancelCheckoutAttemptResult {
  attempt_id: string;
  status: string;
  already_cancelled: boolean;
  freed_seats: number;
}

/** Lee el estado mínimo del intento (dueño acotado) para decidir carreras. */
async function readAttemptStatus(input: {
  attemptId: string;
  customerId: string;
}): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('checkout_attempts')
    .select('id, status')
    .eq('id', input.attemptId)
    .eq('customer_id', input.customerId)
    .maybeSingle();
  return (data as { status?: string } | null)?.status ?? null;
}

/**
 * Cancelación voluntaria del cliente. Libera SOLO los locks propios de
 * este intento; nunca toca asientos de otros compradores.
 *
 * MKT-010: si el intento ya fue cerrado como `expired` por el cleanup
 * (ventana vencida), la cancelación se confirma como cierre logrado —
 * los asientos ya están libres — en lugar de responder un 409 que
 * confundiría al cliente. `verified`/`rejected_final` siguen fallando:
 * no se puede cancelar una compra aprobada ni agotada.
 */
export async function cancelCheckoutAttempt(input: {
  attemptId: string;
  customerId: string;
}): Promise<CancelCheckoutAttemptResult> {
  const { data, error } = (await callRpc('cancel_checkout_attempt', {
    p_attempt_id: input.attemptId,
    p_customer_id: input.customerId,
  })) as RpcJson;

  if (error) {
    const mapped = mapRpcError(error);
    if (mapped.code === 'CHECKOUT_ATTEMPT_CLOSED') {
      const status = await readAttemptStatus(input);
      if (status === 'expired') {
        return {
          attempt_id: input.attemptId,
          status: 'expired',
          already_cancelled: false,
          freed_seats: 0,
        };
      }
    }
    throw mapped;
  }
  if (!data?.attempt_id) {
    throw checkoutError(
      'No se pudo cancelar la compra. Intenta de nuevo',
      500,
      'CHECKOUT_ERROR',
    );
  }

  return data as unknown as CancelCheckoutAttemptResult;
}

// ── 5) Canales de pago del intento (MKT-007.4) ──────────────────────────────

export interface CheckoutPaymentMethodDto {
  id: string;
  method: string;
  label: string;
  data: Record<string, unknown>;
  is_primary: boolean;
  sort_order: number;
}

// MKT-008: contacto público de agencia (tabla 091 agency_contacts).
export interface AgencyPublicContactDto {
  id: string;
  label: string;
  phone: string;
  channel: 'call' | 'whatsapp';
}

export interface CheckoutPaymentMethodsView {
  attempt_id: string;
  status: string;
  amount_cents: number;
  selected_method_id: string | null;
  methods: CheckoutPaymentMethodDto[];
  agency_phone: string | null;
  /** MKT-008: contactos públicos de la agencia (E.164). Vacío si no hay. */
  contacts: AgencyPublicContactDto[];
}

export interface SelectCheckoutPaymentMethodResult {
  attempt_id: string;
  status: string;
  amount_cents: number;
  payment_method_id: string;
  payment_method_snapshot: Record<string, unknown>;
  idempotent: boolean;
}

/**
 * Canales de pago ACTIVOS de la agencia del intento, más el teléfono
 * público de la agencia (para el aviso de WhatsApp). El intento se
 * busca SIEMPRE por id + customer_id: el cliente nunca envía un
 * agency_id arbitrario.
 */
export async function getCheckoutPaymentMethods(input: {
  attemptId: string;
  customerId: string;
}): Promise<CheckoutPaymentMethodsView> {
  const { data: attempt, error: attemptError } = await supabaseAdmin
    .from('checkout_attempts')
    .select('id, customer_id, agency_id, status, amount_cents, payment_method_id')
    .eq('id', input.attemptId)
    .maybeSingle();

  if (attemptError) {
    throw checkoutError(
      'No se pudo cargar la compra. Intenta de nuevo',
      500,
      'CHECKOUT_ERROR',
    );
  }

  const row = attempt as {
    id: string;
    customer_id: string;
    agency_id: string;
    status: string;
    amount_cents: number;
    payment_method_id: string | null;
  } | null;

  if (!row || row.customer_id !== input.customerId) {
    throw checkoutError('Compra no encontrada', 404, 'CHECKOUT_ATTEMPT_NOT_FOUND');
  }

  const [
    { data: methods, error: methodsError },
    { data: agency, error: agencyError },
    { data: contacts, error: contactsError },
  ] = await Promise.all([
    supabaseAdmin
      .from('agency_payment_methods')
      .select('id, method, label, data, is_primary, sort_order')
      .eq('agency_id', row.agency_id)
      // Solo metodos que el frontend sabe mostrar (hoy: pago_movil).
      .eq('method', 'pago_movil')
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('agencies')
      .select('phone')
      .eq('id', row.agency_id)
      .maybeSingle(),
    // MKT-008: contactos públicos de la agencia del intento. Los tres
    // filtros definen lo publicable; el orden lo decide la agencia. El
    // agency_id sale SIEMPRE del intento (id + customer_id), nunca del
    // cliente.
    supabaseAdmin
      .from('agency_contacts')
      .select('id, agency_id, label, phone, channel')
      .eq('agency_id', row.agency_id)
      .eq('is_public', true)
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true }),
  ]);

  if (methodsError) {
    throw checkoutError(
      'No se pudieron cargar los métodos de pago. Intenta de nuevo',
      500,
      'CHECKOUT_ERROR',
    );
  }

  // Un fallo real de base de datos NO se silencia como "sin contactos".
  if (contactsError) {
    throw checkoutError(
      'No se pudo cargar la información de la agencia. Intenta de nuevo',
      500,
      'CHECKOUT_ERROR',
    );
  }

  return {
    attempt_id: row.id,
    status: row.status,
    amount_cents: row.amount_cents,
    selected_method_id: row.payment_method_id ?? null,
    methods: ((methods ?? []) as Record<string, unknown>[]).map((m) => ({
      id: String(m.id),
      method: String(m.method),
      label: String(m.label),
      data: (m.data as Record<string, unknown>) ?? {},
      is_primary: Boolean(m.is_primary),
      sort_order: Number(m.sort_order ?? 0),
    })),
    agency_phone: agencyError
      ? null
      : (((agency as { phone?: string | null } | null)?.phone as string | null) ?? null),
    contacts: ((contacts ?? []) as Array<{
      id: unknown;
      label: unknown;
      phone: unknown;
      channel: unknown;
    }>).map((c) => ({
      id: String(c.id),
      label: String(c.label),
      phone: String(c.phone),
      channel: c.channel === 'call' ? 'call' : 'whatsapp',
    })),
  };
}

/**
 * El cliente elige el canal de pago. La validación de ownership,
 * estado (solo 'created' con proof_count=0) y disponibilidad del canal
 * vive en select_checkout_payment_method (RPC 089); aquí solo se
 * traducen los errores.
 */
export async function selectCheckoutPaymentMethod(input: {
  attemptId: string;
  customerId: string;
  paymentMethodId: string;
}): Promise<SelectCheckoutPaymentMethodResult> {
  const { data, error } = (await callRpc('select_checkout_payment_method', {
    p_attempt_id: input.attemptId,
    p_customer_id: input.customerId,
    p_payment_method_id: input.paymentMethodId,
  })) as RpcJson;

  if (error) throw mapRpcError(error);
  if (!data?.attempt_id) {
    throw checkoutError(
      'No se pudo guardar el método de pago. Intenta de nuevo',
      500,
      'CHECKOUT_ERROR',
    );
  }

  return data as unknown as SelectCheckoutPaymentMethodResult;
}

// ── 6) Historial de compras (RT-01) ──────────────────────────────────────────

/** Límites de la lista: el cliente solo puede paginar dentro de estos. */
export const PURCHASE_HISTORY_DEFAULT_LIMIT = 20;
export const PURCHASE_HISTORY_MAX_LIMIT = 50;
export const PURCHASE_HISTORY_MAX_OFFSET = 10_000;

/**
 * Estado de compra listo para UI. Se deriva del status real del
 * checkout_attempt; nunca se infiere del hecho de haber enviado un
 * comprobante. `desconocido` existe para no inventar significado si
 * una migración futura agrega un status fuera del CHECK actual.
 */
export type PurchaseEstado =
  | 'pendiente_comprobante'
  | 'en_revision'
  | 'rechazado'
  | 'rechazado_final'
  | 'aprobado'
  | 'reserva_confirmada'
  | 'expirado'
  | 'cancelado'
  | 'desconocido';

export type PurchaseAccion =
  | 'enviar_comprobante'
  | 'reenviar_comprobante'
  | 'ver_reserva'
  | 'ninguna';

export type PurchasePagoEstado = 'pendiente' | 'aprobado' | 'rechazado';

export interface PurchaseComprobanteDto {
  envios: number;
  restantes: number;
  referencia: string | null;
  banco: string | null;
  fecha_pago: string | null;
  enviado_en: string | null;
  rechazos: number;
  motivo_rechazo: string | null;
}

export interface PurchasePagoDto {
  id: string;
  estado: PurchasePagoEstado;
  amount_cents: number;
  currency: string;
  aprobado_en: string | null;
}

export interface PurchaseReservaDto {
  id: string;
  status: string;
  payment_status: string | null;
  ticket_code: string | null;
  created_at: string;
}

export interface PurchaseItemDto {
  attempt_id: string;
  /** Status crudo de checkout_attempts, sin reinterpretar. */
  status: string;
  estado: PurchaseEstado;
  mensaje: string;
  accion: PurchaseAccion;
  puede_reenviar_comprobante: boolean;
  trip: {
    id: string;
    origin: string | null;
    destination: string | null;
    departure_time: string | null;
  };
  agency: { id: string; name: string | null };
  /**
   * `detalle` expone nombre y documento del propio cliente (snapshot que
   * escribió al crear el intento); jamás incluye teléfono ni el JSON crudo.
   */
  pasajeros: {
    total: number;
    asientos: string[];
    detalle: Array<{ asiento: string; nombre: string; documento: string }>;
  };
  monto: { unit_price: number; amount_cents: number };
  comprobante: PurchaseComprobanteDto | null;
  pago: PurchasePagoDto | null;
  reserva: PurchaseReservaDto | null;
  ventana: { expires_at: string; vencida: boolean };
  created_at: string;
  closed_at: string | null;
  verified_at: string | null;
}

export interface PurchaseHistoryView {
  items: PurchaseItemDto[];
  limit: number;
  offset: number;
  has_more: boolean;
}

interface PurchaseAttemptRow {
  id: string;
  status: string;
  trip_id: string;
  agency_id: string;
  seat_ids: string[];
  passenger_data: Array<{
    seat_id: string;
    first_name: string;
    last_name: string;
    document: string;
    phone: string;
  }> | null;
  unit_price: number;
  amount_cents: number;
  proof_count: number;
  payment_reference: string | null;
  bank_origin: string | null;
  payment_datetime: string | null;
  proof_submitted_at: string | null;
  rejection_reason: string | null;
  rejection_count: number;
  expires_at: string;
  created_at: string;
  closed_at: string | null;
  verified_at: string | null;
}

interface PurchasePaymentRow {
  id: string;
  reservation_id: string;
  idempotency_key: string;
  status: string;
  amount_cents: number;
  currency: string;
  verified_at: string | null;
}

interface PurchaseReservationRow {
  id: string;
  status: string;
  payment_status: string | null;
  ticket_code: string | null;
  created_at: string;
}

interface PurchaseTripRow {
  id: string;
  route_id: string;
  departure_time: string;
}

interface PurchaseRouteRow {
  id: string;
  origin: string;
  destination: string;
}

interface PurchaseAgencyRow {
  id: string;
  name: string;
}

function purchaseHistoryError(): AppError {
  return checkoutError(
    'No se pudo cargar tu historial de compras. Intenta de nuevo',
    500,
    'CHECKOUT_ERROR',
  );
}

const PAGO_ESTADO_BY_STATUS: Record<string, PurchasePagoEstado> = {
  pending: 'pendiente',
  verified: 'aprobado',
  rejected: 'rechazado',
};

/**
 * Traduce el status del intento a los estados de UI. La aprobación y la
 * reserva confirmada son estados distintos: `reserva_confirmada` SOLO se
 * emite cuando existe la fila de reserva nacida en verify; enviar un
 * comprobante nunca basta para afirmarla.
 */
function buildPurchaseEstado(input: {
  status: string;
  vencida: boolean;
  proofCount: number;
  tieneReserva: boolean;
}): {
  estado: PurchaseEstado;
  mensaje: string;
  accion: PurchaseAccion;
  puede_reenviar_comprobante: boolean;
} {
  const { status, vencida, proofCount, tieneReserva } = input;
  const puedeReenviar =
    status === 'rejected' && !vencida && proofCount < MAX_PROOF_SUBMISSIONS;

  switch (status) {
    case 'created':
      if (vencida) {
        return {
          estado: 'expirado',
          mensaje: 'El plazo para enviar el comprobante de pago venció.',
          accion: 'ninguna',
          puede_reenviar_comprobante: false,
        };
      }
      return {
        estado: 'pendiente_comprobante',
        mensaje: 'Compra iniciada: falta enviar el comprobante de pago.',
        accion: 'enviar_comprobante',
        puede_reenviar_comprobante: false,
      };
    case 'pending_review':
      return {
        estado: 'en_revision',
        mensaje: vencida
          ? 'Comprobante enviado. El plazo de revisión venció y la agencia aún puede decidir.'
          : 'Comprobante enviado: la agencia está revisando tu pago.',
        accion: 'ninguna',
        puede_reenviar_comprobante: false,
      };
    case 'rejected': {
      if (puedeReenviar) {
        return {
          estado: 'rechazado',
          mensaje: 'Comprobante rechazado: puedes enviar uno nuevo.',
          accion: 'reenviar_comprobante',
          puede_reenviar_comprobante: true,
        };
      }
      const motivo = vencida
        ? 'el plazo de reenvío venció'
        : proofCount >= MAX_PROOF_SUBMISSIONS
          ? `se alcanzó el límite de ${MAX_PROOF_SUBMISSIONS} envíos`
          : 'no está habilitado el reenvío';
      return {
        estado: 'rechazado',
        mensaje: `Comprobante rechazado: ${motivo}.`,
        accion: 'ninguna',
        puede_reenviar_comprobante: false,
      };
    }
    case 'rejected_final':
      return {
        estado: 'rechazado_final',
        mensaje: 'Comprobante rechazado tras los tres intentos permitidos.',
        accion: 'ninguna',
        puede_reenviar_comprobante: false,
      };
    case 'verified':
      return tieneReserva
        ? {
            estado: 'reserva_confirmada',
            mensaje: 'Reserva confirmada: tu pago fue aprobado por la agencia.',
            accion: 'ver_reserva',
            puede_reenviar_comprobante: false,
          }
        : {
            estado: 'aprobado',
            mensaje: 'Pago aprobado por la agencia.',
            accion: 'ninguna',
            puede_reenviar_comprobante: false,
          };
    case 'expired':
      return {
        estado: 'expirado',
        mensaje: 'Esta compra venció sin completarse.',
        accion: 'ninguna',
        puede_reenviar_comprobante: false,
      };
    case 'cancelled':
      return {
        estado: 'cancelado',
        mensaje: 'Compra cancelada.',
        accion: 'ninguna',
        puede_reenviar_comprobante: false,
      };
    default:
      return {
        estado: 'desconocido',
        mensaje: 'Esta compra tiene un estado que la app aún no reconoce.',
        accion: 'ninguna',
        puede_reenviar_comprobante: false,
      };
  }
}

/**
 * Historial de compras del cliente autenticado (RT-01).
 *
 * Cada item es UN checkout_attempt del propio cliente, enriquecido con
 * su comprobante, su pago y su reserva definitiva. Solo lectura: nunca
 * crea reservas ni modifica estados.
 *
 * Seguridad:
 * - El identificador SIEMPRE es input.customer_id (req.ctx.userId del
 *   servidor); ningún id llega en la query y no hay forma de pedir la
 *   lista de otra persona.
 * - Los ids de payments/reservations se derivan EXCLUSIVAMENTE de
 *   filas ya filtradas por dueño (idempotency_key = mkt007:{attempt}:verify).
 * - Nunca se selecciona proof_path, history ni idempotency_key: el DTO se
 *   construye campo a campo. `passenger_data` se selecciona SOLO para
 *   derivar `pasajeros.detalle` (nombre + documento del propio cliente);
 *   el teléfono y el JSON crudo jamás salen en la respuesta.
 * - Paginación acotada (limit 1..50, offset 0..10000).
 */
export async function listPurchaseHistory(input: {
  customerId: string;
  limit: number;
  offset: number;
}): Promise<PurchaseHistoryView> {
  const { data, error } = await supabaseAdmin
    .from('checkout_attempts')
    .select(
      'id, status, trip_id, agency_id, seat_ids, passenger_data, unit_price, amount_cents, proof_count, ' +
        'payment_reference, bank_origin, payment_datetime, proof_submitted_at, ' +
        'rejection_reason, rejection_count, expires_at, created_at, closed_at, verified_at',
    )
    .eq('customer_id', input.customerId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    // range es inclusivo: se pide una fila extra para conocer has_more.
    .range(input.offset, input.offset + input.limit);

  if (error) throw purchaseHistoryError();

  const rows = (data ?? []) as unknown as PurchaseAttemptRow[];
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);

  if (page.length === 0) {
    return { items: [], limit: input.limit, offset: input.offset, has_more: false };
  }

  const seatIds = [...new Set(page.flatMap((row) => row.seat_ids))];
  const tripIds = [...new Set(page.map((row) => row.trip_id))];
  const agencyIds = [...new Set(page.map((row) => row.agency_id))];
  const attemptIdByKey = new Map(page.map((row) => [`mkt007:${row.id}:verify`, row.id]));

  const [seatsResult, tripsResult, agenciesResult, paymentsResult] = await Promise.all([
    supabaseAdmin.from('seats').select('id, seat_code').in('id', seatIds),
    supabaseAdmin.from('trips').select('id, route_id, departure_time').in('id', tripIds),
    supabaseAdmin.from('agencies').select('id, name').in('id', agencyIds),
    supabaseAdmin
      .from('payments')
      .select('id, reservation_id, idempotency_key, status, amount_cents, currency, verified_at')
      .in('idempotency_key', [...attemptIdByKey.keys()]),
  ]);

  if (seatsResult.error || tripsResult.error || agenciesResult.error || paymentsResult.error) {
    throw purchaseHistoryError();
  }

  const seatRows = (seatsResult.data ?? []) as unknown as Array<{
    id: string;
    seat_code: string;
  }>;
  const tripRows = (tripsResult.data ?? []) as unknown as PurchaseTripRow[];
  const agencyRows = (agenciesResult.data ?? []) as unknown as PurchaseAgencyRow[];
  const paymentRows = (paymentsResult.data ?? []) as unknown as PurchasePaymentRow[];

  const seatCodeById = new Map(seatRows.map((row) => [row.id, row.seat_code]));
  const tripById = new Map(tripRows.map((row) => [row.id, row]));
  const agencyById = new Map(agencyRows.map((row) => [row.id, row]));

  const paymentByAttemptId = new Map<string, PurchasePaymentRow>();
  for (const payment of paymentRows) {
    const attemptId = attemptIdByKey.get(payment.idempotency_key);
    if (attemptId) paymentByAttemptId.set(attemptId, payment);
  }

  const routeIds = [
    ...new Set(
      tripRows
        .map((row) => row.route_id)
        .filter((routeId): routeId is string => Boolean(routeId)),
    ),
  ];
  const reservationIds = [
    ...new Set(
      paymentRows
        .map((row) => row.reservation_id)
        .filter((reservationId): reservationId is string => Boolean(reservationId)),
    ),
  ];

  const [routesResult, reservationsResult] = await Promise.all([
    routeIds.length > 0
      ? supabaseAdmin.from('routes').select('id, origin, destination').in('id', routeIds)
      : Promise.resolve({ data: [], error: null }),
    reservationIds.length > 0
      ? supabaseAdmin
          .from('reservations')
          .select('id, status, payment_status, ticket_code, created_at')
          .in('id', reservationIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (routesResult.error || reservationsResult.error) {
    throw purchaseHistoryError();
  }

  const routeById = new Map(
    ((routesResult.data ?? []) as unknown as PurchaseRouteRow[]).map((row) => [row.id, row]),
  );
  const reservationById = new Map(
    ((reservationsResult.data ?? []) as unknown as PurchaseReservationRow[]).map((row) => [
      row.id,
      row,
    ]),
  );

  const now = Date.now();
  const items: PurchaseItemDto[] = page.map((row) => {
    const vencida = Date.parse(row.expires_at) <= now;
    const payment = paymentByAttemptId.get(row.id) ?? null;
    const reservation = payment
      ? (reservationById.get(payment.reservation_id) ?? null)
      : null;
    const trip = tripById.get(row.trip_id);
    const route = trip ? routeById.get(trip.route_id) : undefined;
    const agency = agencyById.get(row.agency_id);

    const estado = buildPurchaseEstado({
      status: row.status,
      vencida,
      proofCount: row.proof_count,
      tieneReserva: reservation !== null,
    });

    return {
      attempt_id: row.id,
      status: row.status,
      estado: estado.estado,
      mensaje: estado.mensaje,
      accion: estado.accion,
      puede_reenviar_comprobante: estado.puede_reenviar_comprobante,
      trip: {
        id: row.trip_id,
        origin: route?.origin ?? null,
        destination: route?.destination ?? null,
        departure_time: trip?.departure_time ?? null,
      },
      agency: { id: row.agency_id, name: agency?.name ?? null },
      pasajeros: {
        total: row.seat_ids.length,
        asientos: row.seat_ids.map((seatId) => seatCodeById.get(seatId) ?? seatId),
        // Snapshot del cliente: nombre + documento por asiento, sin teléfono.
        detalle: (Array.isArray(row.passenger_data) ? row.passenger_data : []).map(
          (passenger) => ({
            asiento: seatCodeById.get(passenger.seat_id) ?? passenger.seat_id,
            nombre: `${passenger.first_name} ${passenger.last_name}`.trim(),
            documento: passenger.document,
          }),
        ),
      },
      monto: { unit_price: row.unit_price, amount_cents: row.amount_cents },
      comprobante:
        row.proof_count > 0
          ? {
              envios: row.proof_count,
              restantes: Math.max(0, MAX_PROOF_SUBMISSIONS - row.proof_count),
              referencia: row.payment_reference,
              banco: row.bank_origin,
              fecha_pago: row.payment_datetime,
              enviado_en: row.proof_submitted_at,
              rechazos: row.rejection_count,
              motivo_rechazo: row.rejection_reason,
            }
          : null,
      pago: payment
        ? {
            id: payment.id,
            estado: PAGO_ESTADO_BY_STATUS[payment.status] ?? 'pendiente',
            amount_cents: payment.amount_cents,
            currency: payment.currency,
            aprobado_en: payment.verified_at,
          }
        : null,
      reserva: reservation
        ? {
            id: reservation.id,
            status: reservation.status,
            payment_status: reservation.payment_status,
            ticket_code: reservation.ticket_code,
            created_at: reservation.created_at,
          }
        : null,
      ventana: { expires_at: row.expires_at, vencida },
      created_at: row.created_at,
      closed_at: row.closed_at,
      verified_at: row.verified_at,
    };
  });

  return {
    items,
    limit: input.limit,
    offset: input.offset,
    has_more: hasMore,
  };
}

// ── 7) Boleto QR de una compra (RT-03) ───────────────────────────────────────

/**
 * Error uniforme para boleto no disponible. Se emite el MISMO 404 ante
 * cualquier motivo (no existe, ajeno, sin reserva, sin códigos) para no
 * permitir enumerar compras ajenas ni filtrar el estado interno.
 */
function ticketNotFoundError(): AppError {
  return checkoutError(
    'Boleto no disponible para esta compra',
    404,
    'TICKET_NOT_FOUND',
  );
}

/** Fallo real de base de datos: 500 genérico, sin internals filtrados. */
function ticketQueryError(): AppError {
  return checkoutError(
    'No se pudo cargar el boleto. Intenta de nuevo',
    500,
    'CHECKOUT_ERROR',
  );
}

/**
 * Aprobación completa de una reserva nacida en verify_checkout_attempt (087).
 *
 * Devuelve true SOLO cuando la reserva cumple el contrato atómico de 087:
 * `status='reserved'` y `payment_status='fully_paid'`. NO se equipara
 * `reserved` con `confirmed` (075:104-111): `reserved` es el estado
 * definitivo del ciclo marketplace; `confirmed` es el flujo tour y no se
 * acepta aquí. Un pago `verified` sin reserva válida (o con una reserva
 * distinta a la del intento) NUNCA habilita el boleto.
 */
function isFullyApprovedReservation(reservation: {
  status: string;
  payment_status: string | null;
}): boolean {
  return (
    reservation.status === 'reserved' &&
    reservation.payment_status === 'fully_paid'
  );
}

export interface CheckoutTicketPaxDto {
  asiento: string;
  nombre: string;
}

export interface CheckoutTicketTripDto {
  origin: string | null;
  destination: string | null;
  departure_time: string | null;
}

/**
 * Boleto QR de UNA compra para su dueño (RT-03).
 *
 * Devuelve el `qr_code` y el `ticket_code` EXACTOS generados por Tour en
 * `verify_checkout_attempt` (087:1118-1143). No se crean códigos nuevos ni
 * un sistema de QR paralelo: se reutiliza la fila de reserva ya persistida.
 *
 * Cadena de autorización (nunca se acepta customer_id del cliente):
 *   checkout_attempts (id + customer_id de sesión)
 *     → payments (idempotency_key = 'mkt007:{attempt}:verify')
 *     → payments.reservation_id
 *     → reservations (status='reserved', payment_status='fully_paid',
 *       qr_code y ticket_code presentes).
 *
 * Seguridad:
 * - Identidad SIEMPRE de input.customerId (req.ctx.userId del servidor).
 * - 404 uniforme (`TICKET_NOT_FOUND`) para intento inexistente, ajeno,
 *   no verificado, sin reserva de verificación, pago inexistente/no
 *   verificado, reserva asociada a otro intento o sin códigos: nada de eso
 *   se distingue al cliente para evitar enumeración.
 * - Un intento `verified` sin reserva vinculada (`aprobado` en el
 *   historial) NO habilita boleto: no existe QR que servir.
 * - El QR no se expone en la lista del historial (sin select de
 *   `qr_code` allí); solo se sirve bajo este endpoint autorizado, sin URL
 *   pública permanente.
 * - Multi-pasajero: un SOLO QR por reserva (modelo de Tour); se listan los
 *   asientos/nombres del snapshot del intento para el detalle.
 * - El DTO se construye campo a campo: jamás salen proof_path, history,
 *   idempotency_key ni el teléfono del pasajero.
 */
export async function getCheckoutTicket(input: {
  attemptId: string;
  customerId: string;
}): Promise<{
  attempt_id: string;
  estado: PurchaseEstado;
  qr_code: string;
  ticket_code: string;
  reservation_id: string;
  reservation_created_at: string;
  amount_cents: number;
  currency: string;
  paid_at: string | null;
  agency: { id: string; name: string | null };
  trip: CheckoutTicketTripDto;
  seats: string[];
  passengers: CheckoutTicketPaxDto[];
}> {
  // 1) Intento del propio cliente. El filtro de dueño es parte de la query.
  const { data: attempt, error: attemptError } = await supabaseAdmin
    .from('checkout_attempts')
    .select(
      'id, customer_id, status, agency_id, trip_id, seat_ids, passenger_data, amount_cents',
    )
    .eq('id', input.attemptId)
    .eq('customer_id', input.customerId)
    .maybeSingle();

  if (attemptError) throw ticketQueryError();

  const row = attempt as {
    id: string;
    customer_id: string;
    status: string;
    agency_id: string;
    trip_id: string;
    seat_ids: string[];
    passenger_data: Array<{
      seat_id: string;
      first_name: string;
      last_name: string;
    }> | null;
    amount_cents: number;
  } | null;

  // 404 uniforme: no existe o es de otro cliente. Nunca se revela cuál.
  if (!row) throw ticketNotFoundError();

  // 2) Solo un intento verificado puede tener boleto. Los demás estados
  //    (pending_review, rejected, rejected_final, expired, cancelled,
  //    created) caen al mismo 404 para no filtrar el ciclo de vida.
  if (row.status !== 'verified') throw ticketNotFoundError();

  // 3) Pago de verificación nacido en 087, vinculado por idempotency_key.
  const { data: payment, error: paymentError } = await supabaseAdmin
    .from('payments')
    .select('id, reservation_id, status, amount_cents, currency, verified_at')
    .eq('idempotency_key', `mkt007:${row.id}:verify`)
    .maybeSingle();

  if (paymentError) throw ticketQueryError();

  const pay = payment as {
    id: string;
    reservation_id: string;
    status: string;
    amount_cents: number;
    currency: string;
    verified_at: string | null;
  } | null;

  // Sin fila de pago, sin reserva o pago no verificado: mismo 404.
  if (!pay || pay.status !== 'verified' || !pay.reservation_id) {
    throw ticketNotFoundError();
  }

  // 4) Reserva de verificación con sus códigos de boleto.
  const { data: reservation, error: reservationError } = await supabaseAdmin
    .from('reservations')
    .select(
      'id, status, payment_status, ticket_code, qr_code, created_at, trip_id',
    )
    .eq('id', pay.reservation_id)
    .maybeSingle();

  if (reservationError) throw ticketQueryError();

  const res = reservation as {
    id: string;
    status: string;
    payment_status: string | null;
    ticket_code: string | null;
    qr_code: string | null;
    created_at: string;
    trip_id: string;
  } | null;

  // 5) Aprobación completa + códigos presentes. La reserva debe pertenecer
  //    al mismo intento vía pago y al mismo viaje; QR y ticket_code deben
  //    existir. Cualquier fallo → 404 uniforme.
  if (
    !res ||
    !isFullyApprovedReservation(res) ||
    !res.qr_code ||
    !res.ticket_code
  ) {
    throw ticketNotFoundError();
  }

  // Contexto de agencia y viaje para el boleto (sin teléfono ni extras).
  const [agencyResult, tripResult, seatResult] = await Promise.all([
    supabaseAdmin
      .from('agencies')
      .select('id, name')
      .eq('id', row.agency_id)
      .maybeSingle(),
    supabaseAdmin
      .from('trips')
      .select('id, route_id, departure_time')
      .eq('id', row.trip_id)
      .maybeSingle(),
    supabaseAdmin
      .from('seats')
      .select('id, seat_code')
      .in('id', [...new Set(row.seat_ids)]),
  ]);

  if (agencyResult.error || tripResult.error || seatResult.error) {
    throw ticketQueryError();
  }

  const tripRow = tripResult.data as {
    id: string;
    route_id: string | null;
    departure_time: string | null;
  } | null;

  let routeRow: { origin: string; destination: string } | null = null;
  if (tripRow?.route_id) {
    const { data: r, error: routeError } = await supabaseAdmin
      .from('routes')
      .select('origin, destination')
      .eq('id', tripRow.route_id)
      .maybeSingle();
    if (routeError) throw ticketQueryError();
    routeRow = (r as { origin: string; destination: string } | null) ?? null;
  }

  const seatRows = (seatResult.data ?? []) as unknown as Array<{
    id: string;
    seat_code: string;
  }>;
  const seatCodeById = new Map(seatRows.map((s) => [s.id, s.seat_code]));

  const agencyRow = agencyResult.data as { id: string; name: string } | null;
  const seats = row.seat_ids.map((id) => seatCodeById.get(id) ?? id);
  const passengers = (Array.isArray(row.passenger_data)
    ? row.passenger_data
    : []
  ).map((p) => ({
    asiento: seatCodeById.get(p.seat_id) ?? p.seat_id,
    nombre: `${p.first_name} ${p.last_name}`.trim(),
  }));

  return {
    attempt_id: row.id,
    estado: 'reserva_confirmada',
    qr_code: res.qr_code,
    ticket_code: res.ticket_code,
    reservation_id: res.id,
    reservation_created_at: res.created_at,
    amount_cents: pay.amount_cents,
    currency: pay.currency,
    paid_at: pay.verified_at,
    agency: { id: row.agency_id, name: agencyRow?.name ?? null },
    trip: {
      origin: routeRow?.origin ?? null,
      destination: routeRow?.destination ?? null,
      departure_time: tripRow?.departure_time ?? null,
    },
    seats,
    passengers,
  };
}
