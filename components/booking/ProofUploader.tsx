'use client';

import { useCallback, useRef, useState } from 'react';
import { FileText, LoaderCircle, Upload } from 'lucide-react';
import { paymentApi, type SubmitPaymentProofResult } from '@/lib/api';
import { ApiError, getApiErrorMessage } from '@/lib/errors/api-error';

/** 5 MiB: el mismo límite del bucket y del parser multipart del backend. */
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
]);

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.pdf']);

export const PROOF_ACCEPT = '.png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf';

/**
 * UUID v4 para `Idempotency-Key`. Usa `crypto.randomUUID()` cuando existe y
 * cae a WebCrypto/Math.random solo en entornos sin él (el backend valida la
 * forma con `zod.string().uuid()`).
 */
export function newIdempotencyKey(): string {
  const webcrypto = typeof crypto !== 'undefined' ? crypto : undefined;
  if (webcrypto && typeof webcrypto.randomUUID === 'function') {
    return webcrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * Validación de cliente: solo mejora la experiencia. La valididad definitiva
 * (magic bytes, límite exacto, MIME) siempre la decide el backend.
 */
export function validateProofFile(file: File): string | null {
  if (!file) return 'Selecciona un comprobante para enviar.';
  const dotIndex = file.name.lastIndexOf('.');
  const extension = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : '';
  const extensionOk = ALLOWED_EXTENSIONS.has(extension);
  const mimeOk = !file.type || ALLOWED_MIME_TYPES.has(file.type);
  if (!extensionOk || !mimeOk) {
    return 'Adjunta el comprobante en formato PNG, JPEG, WEBP o PDF.';
  }
  if (file.size === 0) return 'El comprobante está vacío.';
  if (file.size > MAX_PROOF_BYTES) {
    return 'El comprobante no puede superar 5 MB.';
  }
  return null;
}

export function formatProofSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * Huella del CONTENIDO del archivo (SHA-256).
 *
 * El backend identifica el comprobante por el hash del contenido
 * (`{reservation_id}/{sha256}.{ext}`), así que la huella del cliente sigue
 * el contenido y no el nombre ni el tamaño: dos archivos con nombre y
 * tamaño iguales pero contenido distinto son operaciones distintas y no
 * pueden compartir `Idempotency-Key`.
 *
 * Sin SubtleCrypto (contexto no seguro, p. ej. http en red local) se usa
 * FNV-1a de dos semillas sobre los bytes: basta para distinguir archivos y
 * jamás bloquea el envío. Solo se conserva la huella en memoria; el
 * ArrayBuffer se descarta al terminar.
 */
export async function proofFingerprint(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (subtle && typeof subtle.digest === 'function') {
    return bytesToHex(await subtle.digest('SHA-256', bytes));
  }

  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x01000193) >>> 0;
    second = ((second << 13) | (second >>> 19)) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second
    .toString(16)
    .padStart(8, '0')}`;
}

export interface ProofUploaderProps {
  reservationId: string;
  /** El envío fue aceptado: persiste el marcador de pago pendiente. */
  onSubmitted: (result: SubmitPaymentProofResult) => void;
  /** El servidor ya tenía un comprobante para esta reserva (409). */
  onAlreadySubmitted?: () => void;
}

interface IdempotencySlot {
  fingerprint: string;
  key: string;
}

/**
 * Sube un único comprobante por reserva con `Idempotency-Key` estable:
 * la clave se deduce de la huella del CONTENIDO, de modo que cualquier
 * reintento del mismo archivo (tras timeout o error de red, aunque el
 * usuario lo vuelva a elegir) reutiliza la clave y recupera la operación
 * original; un archivo con contenido distinto es una operación nueva y
 * recibe una clave nueva aunque repita nombre y tamaño. Un conflicto de
 * idempotencia nunca regenera la clave automáticamente. Una vez aceptado,
 * el padre retira este componente y no vuelve a habilitar un segundo envío.
 */
export function ProofUploader({
  reservationId,
  onSubmitted,
  onAlreadySubmitted,
}: ProofUploaderProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fingerprintRef = useRef<{ file: File; value: Promise<string> } | null>(
    null,
  );
  const keyRef = useRef<IdempotencySlot | null>(null);

  const fingerprintFor = useCallback((selected: File): Promise<string> => {
    const cached = fingerprintRef.current;
    if (cached && cached.file === selected) return cached.value;
    const value = proofFingerprint(selected);
    // La precarga es best-effort: un archivo ilegible se avisa al enviar,
    // no como un rechazo sin manejar en segundo plano.
    value.catch(() => undefined);
    fingerprintRef.current = { file: selected, value };
    return value;
  }, []);

  const keyFor = useCallback(
    async (selected: File): Promise<string> => {
      const fingerprint = await fingerprintFor(selected);
      const slot = keyRef.current;
      if (slot && slot.fingerprint === fingerprint) return slot.key;
      const key = newIdempotencyKey();
      keyRef.current = { fingerprint, key };
      return key;
    },
    [fingerprintFor],
  );

  const handleSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (pending) return;
    const next = event.target.files?.[0] ?? null;
    if (!next) return;
    setFile(next);
    setError(validateProofFile(next));
    // Precalcula la huella en segundo plano: el envío solo tendría que
    // esperarla si el usuario hace clic antes de que termine.
    void fingerprintFor(next);
  };

  const handleSubmit = async () => {
    if (!file || pending) return;
    const validationError = validateProofFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setPending(true);
    setError(null);
    try {
      const key = await keyFor(file);
      const result = await paymentApi.submitProof(reservationId, file, key);
      onSubmitted(result);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PAYMENT_ALREADY_SUBMITTED') {
        // El servidor ya tenía el comprobante: pasar a la vista de revisión
        // sin afirmar un éxito que no confirmó esta respuesta.
        onAlreadySubmitted?.();
        return;
      }
      if (err instanceof ApiError && err.code === 'PAYMENT_IDEMPOTENCY_CONFLICT') {
        // Conflicto real del servidor con esta MISMA clave: jamás se genera
        // otra clave automáticamente para repetir la operación.
        setError(
          'Este comprobante ya fue registrado con otra clave de idempotencia. ' +
            'Conserva el archivo y contacta a soporte antes de reintentar.',
        );
        return;
      }
      setError(
        getApiErrorMessage(
          err,
          'No pudimos enviar el comprobante. Revisa tu conexión e intenta de nuevo.',
        ),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-5">
      <p className="text-sm text-brand-muted">
        Adjunta el comprobante de pago de la transferencia. Aceptamos PNG,
        JPEG, WEBP o PDF de hasta 5 MB.
      </p>

      <label className="mt-4 flex cursor-pointer flex-col items-center rounded-2xl border border-dashed border-black/[0.12] bg-[#f8fafc] px-6 py-8 text-center transition-colors hover:border-brand-cyan hover:bg-[#f0fdff]">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#f1f5f9]">
          <Upload size={20} strokeWidth={1.75} className="text-brand-navy" aria-hidden="true" />
        </span>
        <span className="mt-3 text-sm font-semibold text-brand-navy">
          {file ? 'Cambiar comprobante' : 'Seleccionar comprobante'}
        </span>
        <span className="mt-1 text-xs text-brand-muted">PNG, JPEG, WEBP o PDF · máx. 5 MB</span>
        <input
          type="file"
          className="sr-only"
          accept={PROOF_ACCEPT}
          disabled={pending}
          onChange={handleSelect}
          data-testid="proof-file-input"
        />
      </label>

      {file ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-[10px] bg-[#f1f5f9] px-4 py-3">
          <span className="flex min-w-0 items-center gap-2">
            <FileText size={16} strokeWidth={1.75} className="shrink-0 text-brand-navy" aria-hidden="true" />
            <span className="truncate text-sm font-medium text-brand-navy">{file.name}</span>
          </span>
          <span className="shrink-0 text-xs text-brand-muted">
            {formatProofSize(file.size)}
          </span>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-[10px] bg-[#fef2f2] px-4 py-3 text-sm text-[#ef4444]"
        >
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={!file || pending}
        className="mt-4 inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? (
          <LoaderCircle size={16} strokeWidth={1.75} className="animate-spin" aria-hidden="true" />
        ) : (
          <Upload size={16} strokeWidth={1.75} aria-hidden="true" />
        )}
        {pending ? 'Enviando comprobante…' : 'Enviar comprobante'}
      </button>
    </div>
  );
}
