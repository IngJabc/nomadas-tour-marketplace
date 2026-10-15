'use client';

import { useCallback, useRef, useState } from 'react';
import { FileText, LoaderCircle, Upload } from 'lucide-react';
import {
  checkoutApi,
  type SubmitCheckoutProofPayload,
  type SubmitCheckoutProofResult,
} from '@/lib/api';
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

export const PROOF_ACCEPT =
  '.png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf';

/** Máximo de comprobantes por intento (1 envío + 2 reenvíos, RPC 087). */
export const MAX_PROOF_SUBMISSIONS = 3;

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
 * (`{attempt_id}/{sha256}.{ext}`), así que la huella del cliente sigue el
 * contenido y no el nombre ni el tamaño.
 *
 * Sin SubtleCrypto (contexto no seguro, p. ej. http en red local) se usa
 * FNV-1a de dos semillas sobre los bytes: basta para distinguir archivos y
 * jamás bloquea el envío.
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

// ── Datos de conciliación ────────────────────────────────────────────────────

const MAX_REFERENCE_LENGTH = 100;
const MAX_BANK_LENGTH = 120;
/** Tolerancia de reloj admisible (espejo del CHECK del RPC 087). */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Convierte `datetime-local` a ISO 8601. El backend además valida que la
 * fecha no esté en el futuro.
 */
export function toIsoDatetime(localValue: string): string | null {
  const parsed = new Date(localValue);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function validateReconciliation(input: {
  payment_reference: string;
  bank_origin: string;
  payment_datetime: string;
}): Partial<Record<keyof SubmitCheckoutProofPayload, string>> {
  const errors: Partial<Record<keyof SubmitCheckoutProofPayload, string>> = {};

  const reference = normalizeWhitespace(input.payment_reference);
  if (!reference) {
    errors.payment_reference = 'Escribe la referencia de la transferencia.';
  } else if (reference.length > MAX_REFERENCE_LENGTH) {
    errors.payment_reference = `Máximo ${MAX_REFERENCE_LENGTH} caracteres.`;
  }

  const bank = normalizeWhitespace(input.bank_origin);
  if (!bank) {
    errors.bank_origin = 'Escribe el banco desde el que hiciste la transferencia.';
  } else if (bank.length > MAX_BANK_LENGTH) {
    errors.bank_origin = `Máximo ${MAX_BANK_LENGTH} caracteres.`;
  }

  if (!input.payment_datetime) {
    errors.payment_datetime = 'Indica la fecha y hora del pago.';
  } else {
    const parsed = new Date(input.payment_datetime);
    if (Number.isNaN(parsed.getTime())) {
      errors.payment_datetime = 'Indica una fecha y hora válidas.';
    } else if (parsed.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      errors.payment_datetime = 'La fecha del pago no puede estar en el futuro.';
    }
  }

  return errors;
}

// ── Componente ───────────────────────────────────────────────────────────────

export interface ProofUploaderProps {
  attemptId: string;
  /**
   * Comprobantes que aún puede enviar el cliente (1..3). Se conserva en la
   * API porque la pantalla decide con él si renderiza este uploader, pero
   * ya NO se renderiza ningún contador (MKT-007.1).
   */
  remainingSubmissions: number;
  /** El envío fue aceptado: persiste el marcador de checkout pendiente. */
  onSubmitted: (result: SubmitCheckoutProofResult) => void;
  /** El servidor ya tenía un comprobante en revisión (409). */
  onAlreadySubmitted?: () => void;
}

interface IdempotencySlot {
  fingerprint: string;
  key: string;
}

const FIELD_CLASSES =
  'w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 ' +
  'font-[Poppins] text-[14px] font-normal text-brand-navy outline-none ' +
  'transition-[border-color,box-shadow] duration-200 ' +
  'focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)] ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

const LABEL_CLASSES =
  'mb-1.5 block font-[Poppins] text-[12px] font-medium uppercase text-brand-muted';

/**
 * Envía un comprobante contra un `checkout_attempt` con sus tres datos de
 * conciliación y `Idempotency-Key` estable por huella del CONTENIDO: un
 * reintento del mismo archivo reutiliza la clave; contenido distinto es una
 * operación nueva. Un conflicto de idempotencia jamás regenera la clave.
 *
 * El cliente solo aporta archivo + conciliación: monto, moneda, ventana,
 * contador y estado los decide el RPC 087.
 */
export function ProofUploader({
  attemptId,
  onSubmitted,
  onAlreadySubmitted,
}: ProofUploaderProps) {
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState('');
  const [bank, setBank] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof SubmitCheckoutProofPayload, string>>
  >({});
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
    void fingerprintFor(next);
  };

  const handleSubmit = async () => {
    if (!file || pending) return;
    const fileError = validateProofFile(file);
    if (fileError) {
      setError(fileError);
      return;
    }

    const reconciliation = {
      payment_reference: normalizeWhitespace(reference),
      bank_origin: normalizeWhitespace(bank),
      payment_datetime: paidAt,
    };
    const errors = validateReconciliation(reconciliation);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError(null);
      return;
    }
    const isoDatetime = toIsoDatetime(reconciliation.payment_datetime);
    if (!isoDatetime) {
      setFieldErrors({ payment_datetime: 'Indica una fecha y hora válidas.' });
      return;
    }

    setPending(true);
    setError(null);
    try {
      const key = await keyFor(file);
      const result = await checkoutApi.submitProof(
        attemptId,
        file,
        { ...reconciliation, payment_datetime: isoDatetime },
        key,
      );
      onSubmitted(result);
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === 'CHECKOUT_PROOF_PENDING' ||
          err.code === 'CHECKOUT_ATTEMPT_CLOSED')
      ) {
        // El servidor ya tenía un comprobante en revisión: pasar a la vista
        // de seguimiento sin afirmar un éxito que esta respuesta no trajo.
        onAlreadySubmitted?.();
        return;
      }
      if (err instanceof ApiError && err.code === 'CHECKOUT_IDEMPOTENCY_CONFLICT') {
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

      {/* MKT-007.1: sin contador de intentos visible. El límite de
          reenvíos lo aplica el backend; la pantalla solo renderiza este
          uploader mientras queden envíos disponibles. */}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={LABEL_CLASSES} htmlFor="proof-reference">
            Referencia de la transferencia
          </label>
          <input
            id="proof-reference"
            type="text"
            value={reference}
            maxLength={MAX_REFERENCE_LENGTH}
            disabled={pending}
            autoComplete="off"
            placeholder="Ej. 00123456789"
            onChange={(event) => setReference(event.target.value)}
            className={FIELD_CLASSES}
            aria-invalid={!!fieldErrors.payment_reference}
          />
          {fieldErrors.payment_reference ? (
            <p role="alert" className="mt-1.5 text-xs text-[#ef4444]">
              {fieldErrors.payment_reference}
            </p>
          ) : null}
        </div>

        <div>
          <label className={LABEL_CLASSES} htmlFor="proof-bank">
            Banco de origen
          </label>
          <input
            id="proof-bank"
            type="text"
            value={bank}
            maxLength={MAX_BANK_LENGTH}
            disabled={pending}
            autoComplete="organization"
            placeholder="Ej. Banco de Venezuela"
            onChange={(event) => setBank(event.target.value)}
            className={FIELD_CLASSES}
            aria-invalid={!!fieldErrors.bank_origin}
          />
          {fieldErrors.bank_origin ? (
            <p role="alert" className="mt-1.5 text-xs text-[#ef4444]">
              {fieldErrors.bank_origin}
            </p>
          ) : null}
        </div>

        <div>
          <label className={LABEL_CLASSES} htmlFor="proof-datetime">
            Fecha y hora del pago
          </label>
          <input
            id="proof-datetime"
            type="datetime-local"
            value={paidAt}
            disabled={pending}
            onChange={(event) => setPaidAt(event.target.value)}
            className={FIELD_CLASSES}
            aria-invalid={!!fieldErrors.payment_datetime}
          />
          {fieldErrors.payment_datetime ? (
            <p role="alert" className="mt-1.5 text-xs text-[#ef4444]">
              {fieldErrors.payment_datetime}
            </p>
          ) : null}
        </div>
      </div>

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
