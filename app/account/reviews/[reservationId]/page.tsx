'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarDays,
  CheckCircle2,
  LoaderCircle,
  LogIn,
  MessageSquareHeart,
  RefreshCw,
  ShieldAlert,
  Star,
} from 'lucide-react';
import {
  reviewsApi,
  type ReviewContextDto,
  type ReviewDto,
} from '@/lib/api';
import { ApiError, getApiErrorMessage } from '@/lib/errors/api-error';
import { formatDateTimeShort } from '@/lib/timezone';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';

const REVIEWS_PATH = '/account/reviews';
const CATALOG_HREF = '/trips';
const COMPRAS_PATH = '/account/purchases';

/**
 * Estrellas INTERACTIVAS. Un solo widget por reseña (viaje / agencia).
 * Cada estrella es un botón con aria-label; el valor es siempre entero
 * 1..5 (la validación final la hace el backend).
 */
function StarRating({
  label,
  idPrefix,
  value,
  onChange,
  disabled,
}: {
  label: string;
  idPrefix: string;
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;

  return (
    <div>
      <span
        id={`${idPrefix}-label`}
        className="block text-xs font-medium uppercase text-brand-muted"
      >
        {label}
      </span>
      <div
        role="group"
        aria-labelledby={`${idPrefix}-label`}
        className="mt-2 flex items-center gap-1"
        onMouseLeave={() => setHover(0)}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            id={n === 1 ? `${idPrefix}-1` : undefined}
            aria-label={`${n} de 5 estrellas`}
            aria-pressed={value === n}
            disabled={disabled}
            onClick={() => onChange(n)}
            onMouseEnter={() => setHover(n)}
            onFocus={() => setHover(n)}
            onBlur={() => setHover(0)}
            className="rounded p-1 transition-transform duration-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Star
              size={28}
              strokeWidth={1.75}
              aria-hidden
              className={
                n <= shown
                  ? 'fill-[#f59e0b] text-[#f59e0b]'
                  : 'text-[#e5e7eb]'
              }
            />
          </button>
        ))}
        <span className="ml-2 text-sm text-brand-muted" aria-live="polite">
          {value > 0 ? `${value}/5` : 'Sin calificar'}
        </span>
      </div>
    </div>
  );
}

/** Reseña existente en modo solo lectura (tras enviar o si ya estaba). */
function SubmittedReview({ title, review }: { title: string; review: ReviewDto }) {
  return (
    <div className="rounded-[10px] bg-[#ecfdf5] px-4 py-3 text-sm">
      <p className="text-[11px] font-medium uppercase text-[#059669]">
        {title} · enviada
      </p>
      <div className="mt-1 flex items-center gap-2">
        <span className="inline-flex items-center gap-0.5" aria-label={`${review.rating} de 5 estrellas`}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Star
              key={n}
              size={16}
              strokeWidth={1.75}
              aria-hidden
              className={
                n <= review.rating
                  ? 'fill-[#f59e0b] text-[#f59e0b]'
                  : 'text-[#e5e7eb]'
              }
            />
          ))}
        </span>
        <span className="text-xs text-brand-muted">{review.rating}/5</span>
      </div>
      {review.comment && <p className="mt-1 text-brand-navy">{review.comment}</p>}
      <p className="mt-1 text-xs text-brand-muted">
        Enviada el {formatDateTimeShort(review.created_at)}. No se puede editar
        ni eliminar.
      </p>
    </div>
  );
}

function SkeletonForm() {
  return (
    <div
      role="status"
      className="max-w-2xl rounded-2xl border border-black/[0.06] bg-brand-surface p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
    >
      <span className="sr-only">Cargando el formulario de reseña…</span>
      <div className="h-6 w-56 rounded-full bg-black/[0.06]" />
      <div className="mt-4 h-4 w-72 rounded bg-black/[0.06]" />
      <div className="mt-8 h-10 w-48 rounded bg-black/[0.06]" />
      <div className="mt-6 h-24 w-full rounded-[10px] bg-black/[0.06]" />
      <div className="mt-8 h-10 w-48 rounded bg-black/[0.06]" />
      <div className="mt-6 h-24 w-full rounded-[10px] bg-black/[0.06]" />
      <div className="mt-8 h-12 w-full rounded-[10px] bg-black/[0.06]" />
    </div>
  );
}

export default function ResenaFormPage() {
  const auth = useOptionalAuthUser();
  const user = auth?.user ?? null;
  const authLoading = auth?.loading ?? false;
  const role = user?.role ?? null;

  const params = useParams<{ reservationId: string }>();
  const reservationId = params?.reservationId ?? '';

  // La URL de login regresa al usuario EXACTAMENTE a este formulario.
  const loginPath = `/login?redirect=${encodeURIComponent(
    `${REVIEWS_PATH}/${reservationId}`,
  )}`;

  const [context, setContext] = useState<ReviewContextDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Formulario (dos reseñas en UNA sola acción).
  const [tripRating, setTripRating] = useState(0);
  const [tripComment, setTripComment] = useState('');
  const [agencyRating, setAgencyRating] = useState(0);
  const [agencyComment, setAgencyComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  /** Reseñas ya existentes (tras enviar o si la reserva ya estaba reseñada). */
  const [doneTripReview, setDoneTripReview] = useState<ReviewDto | null>(null);
  const [doneAgencyReview, setDoneAgencyReview] = useState<ReviewDto | null>(null);

  const seqRef = useRef(0);
  const prevReservationIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setSessionExpired(false);
    // Estado derivado del SERVIDOR: se limpia en cada carga para que una
    // recarga o un cambio de reserva no arrastre una confirmación previa
    // (la vista 'submitted' se rederiva del nuevo context.state). Los
    // campos del formulario NO se tocan: son borrador del usuario
    // (regla: no limpiar selección sin confirmación).
    setSubmitted(false);
    setDoneTripReview(null);
    setDoneAgencyReview(null);
    if (prevReservationIdRef.current !== reservationId) {
      // Cambio de reserva: el contexto anterior no corresponde a esta
      // URL; se limpia para que no se pinte una vista de otra reserva
      // mientras carga.
      prevReservationIdRef.current = reservationId;
      setContext(null);
    }
    try {
      const data = await reviewsApi.getContext(reservationId);
      if (seq !== seqRef.current) return;
      setContext(data);
      if (data.state === 'submitted') {
        setSubmitted(true);
        setDoneTripReview(data.trip_review);
        setDoneAgencyReview(data.agency_review);
      }
    } catch (e) {
      if (seq !== seqRef.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setSessionExpired(true);
      } else if (e instanceof ApiError && e.status === 404) {
        // 404 uniforme: inexistente, ajeno o no-marketplace. No se distingue.
        setNotFound(true);
      } else {
        setError(
          getApiErrorMessage(
            e,
            'No pudimos cargar el formulario de reseña. Intenta de nuevo.',
          ),
        );
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [reservationId]);

  useEffect(() => {
    seqRef.current += 1;
    if (authLoading) return;
    if (!user) {
      setSessionExpired(true);
      setContext(null);
      setLoading(false);
      return;
    }
    if (user.role !== 'customer') {
      setContext(null);
      setLoading(false);
      return;
    }
    void load();
  }, [authLoading, user, role, load]);

  const handleSubmit = async () => {
    if (submitting) return;
    // Ambas calificaciones son OBLIGATORIAS y se envían JUNTAS.
    if (tripRating < 1 || agencyRating < 1) {
      toast.error('Califica el viaje y la agencia con estrellas (1 a 5)');
      return;
    }
    setSubmitting(true);
    try {
      const result = await reviewsApi.submit(reservationId, {
        trip_rating: tripRating,
        trip_comment: tripComment.trim() === '' ? null : tripComment.trim(),
        agency_rating: agencyRating,
        agency_comment:
          agencyComment.trim() === '' ? null : agencyComment.trim(),
      });
      setSubmitted(true);
      setDoneTripReview(context?.trip_review ?? null);
      setDoneAgencyReview(context?.agency_review ?? null);
      // Conserva las calificaciones recién enviadas para la vista final.
      setContext((prev) =>
        prev
          ? {
              ...prev,
              state: 'submitted',
              trip_review:
                prev.trip_review ??
                ({
                  id: result.trip_review_id ?? 'trip',
                  rating: tripRating,
                  comment: tripComment.trim() || null,
                  moderation_status: 'visible',
                  created_at: new Date().toISOString(),
                } satisfies ReviewDto),
              agency_review:
                prev.agency_review ??
                ({
                  id: result.agency_review_id ?? 'agency',
                  rating: agencyRating,
                  comment: agencyComment.trim() || null,
                  moderation_status: 'visible',
                  created_at: new Date().toISOString(),
                } satisfies ReviewDto),
            }
          : prev,
      );
      toast.success(
        result.already_submitted
          ? 'Tu reseña ya estaba registrada.'
          : '¡Gracias! Tus reseñas fueron enviadas.',
      );
    } catch (e) {
      toast.error(
        getApiErrorMessage(e, 'No pudimos enviar tus reseñas. Intenta de nuevo.'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const roleBlocked = !authLoading && user !== null && role !== 'customer';
  // Ready SOLO si el contexto corresponde a la reserva de la URL: en el
  // frame entre un cambio de params y la limpieza de load() no se pinta
  // el formulario de otra reserva.
  const contextReady = context !== null && context.reservation_id === reservationId;
  const isSubmitted = submitted || context?.state === 'submitted';
  const isExpired = context?.state === 'expired' || context?.window_expired === true;
  const ineligible = contextReady && context.eligible === false && !isSubmitted && !isExpired;

  let view:
    | 'loading'
    | 'session'
    | 'role'
    | 'notfound'
    | 'error'
    | 'submitted'
    | 'expired'
    | 'ineligible'
    | 'form';
  if (
    authLoading ||
    (loading && !contextReady && !error && !sessionExpired && !notFound && !roleBlocked)
  ) {
    view = 'loading';
  } else if (sessionExpired) {
    view = 'session';
  } else if (roleBlocked) {
    view = 'role';
  } else if (notFound) {
    view = 'notfound';
  } else if (contextReady && isSubmitted) {
    view = 'submitted';
  } else if (contextReady && isExpired) {
    view = 'expired';
  } else if (ineligible) {
    view = 'ineligible';
  } else if (!contextReady && error) {
    view = 'error';
  } else {
    view = 'form';
  }

  const routeLabel =
    context && context.trip.origin && context.trip.destination
      ? `${context.trip.origin} → ${context.trip.destination}`
      : 'Ruta no disponible';

  return (
    <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 pt-24 pb-16">
      {/* Encabezado SIEMPRE en el contenedor 7xl: mismo margen izquierdo que
          el resto de páginas (el formulario se centra más abajo). */}
      <div className="border-l-4 border-brand-cyan pl-3">
        <h1 className="text-[28px] font-extrabold">Calificar mi viaje</h1>
        <p className="mt-1 text-sm text-brand-muted">
          Tu opinión sobre el viaje y la agencia importa para ofrecer un mejor servicio.
        </p>
      </div>

      <div className="mt-4">
        <Link
          href={REVIEWS_PATH}
          className="inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-4 py-2 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
          Volver a mis reseñas
        </Link>
      </div>

      <div className="mt-6" aria-live="polite">
        {view === 'loading' && <SkeletonForm />}

        {view === 'session' && (
          <div className="flex max-w-2xl flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fffbeb] text-[#92400e]">
              <ShieldAlert size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              Tu sesión ya no está activa
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              Inicia sesión de nuevo y te devolvemos a este formulario.
            </p>
            <Link
              href={loginPath}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              <LogIn size={16} strokeWidth={1.75} aria-hidden />
              Iniciar sesión
            </Link>
          </div>
        )}

        {view === 'role' && (
          <div className="max-w-2xl rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="rounded-[10px] bg-[#fffbeb] px-4 py-3">
              <p className="text-sm font-semibold text-[#92400e]">
                Solo las cuentas de cliente pueden enviar reseñas.
              </p>
            </div>
            <Link
              href={CATALOG_HREF}
              className="mt-4 inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
            >
              Explorar viajes
            </Link>
          </div>
        )}

        {view === 'notfound' && (
          <div className="flex max-w-2xl flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#f1f5f9] text-brand-muted">
              <MessageSquareHeart size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              No encontramos esta reseña
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              La reserva no existe, no te pertenece o no califica para reseñas.
            </p>
            <Link
              href={REVIEWS_PATH}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              Ver mis reseñas
            </Link>
          </div>
        )}

        {view === 'error' && (
          <div className="flex max-w-2xl flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fef2f2] text-[#ef4444]">
              <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              No pudimos cargar el formulario
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
              Reintentar
            </button>
          </div>
        )}

        {view === 'submitted' && context && (
          <div className="max-w-2xl rounded-2xl border border-black/[0.06] bg-brand-surface p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#ecfdf5] text-[#059669]">
                <CheckCircle2 size={24} strokeWidth={1.75} aria-hidden />
              </div>
              <div>
                <h2 className="text-lg font-semibold">
                  ¡Gracias por tu reseña!
                </h2>
                <p className="text-sm text-brand-muted">{routeLabel}</p>
              </div>
            </div>
            <div className="mt-6 space-y-3">
              {(doneTripReview ?? context.trip_review) && (
                <SubmittedReview
                  title="Viaje"
                  review={doneTripReview ?? context.trip_review!}
                />
              )}
              {(doneAgencyReview ?? context.agency_review) && (
                <SubmittedReview
                  title="Agencia"
                  review={doneAgencyReview ?? context.agency_review!}
                />
              )}
              {!(doneTripReview ?? context.trip_review) &&
                !(doneAgencyReview ?? context.agency_review) && (
                  <p className="text-sm text-brand-muted">
                    Tus reseñas fueron registradas.
                  </p>
                )}
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href={REVIEWS_PATH}
                className="inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
              >
                Ver mis reseñas
              </Link>
              <Link
                href={COMPRAS_PATH}
                className="inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
              >
                Ir a mis compras
              </Link>
            </div>
          </div>
        )}

        {view === 'expired' && context && (
          <div className="max-w-2xl rounded-2xl border border-black/[0.06] bg-brand-surface p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="rounded-[10px] bg-[#fffbeb] px-4 py-3">
              <p className="text-sm font-semibold text-[#92400e]">
                El plazo para calificar este viaje venció
              </p>
              <p className="mt-1 text-xs text-brand-muted">
                {context.expires_at
                  ? `La ventana de reseña terminó el ${formatDateTimeShort(context.expires_at)}.`
                  : 'La ventana de reseña de este viaje ya terminó.'}
              </p>
            </div>
            <p className="mt-4 text-sm text-brand-muted">
              {routeLabel}
              {context.agency.name ? ` · ${context.agency.name}` : ''}
            </p>
            <Link
              href={REVIEWS_PATH}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
            >
              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
              Volver a mis reseñas
            </Link>
          </div>
        )}

        {view === 'ineligible' && context && (
          <div className="max-w-2xl rounded-2xl border border-black/[0.06] bg-brand-surface p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="rounded-[10px] bg-[#fffbeb] px-4 py-3">
              <p className="text-sm font-semibold text-[#92400e]">
                Esta reserva aún no puede ser calificada
              </p>
              {context.reason && (
                <p className="mt-1 text-xs text-brand-muted">{context.reason}</p>
              )}
            </div>
            <p className="mt-4 text-sm text-brand-muted">
              {routeLabel}
              {context.agency.name ? ` · ${context.agency.name}` : ''}
            </p>
            <Link
              href={COMPRAS_PATH}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
            >
              Ir a mis compras
            </Link>
          </div>
        )}

        {view === 'form' && context && (
          <div className="max-w-2xl rounded-2xl border border-black/[0.06] bg-brand-surface p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            {/* Contexto del viaje */}
            <div className="rounded-[10px] bg-[#f1f5f9] px-4 py-3 text-sm">
              <p className="text-[11px] font-medium uppercase text-brand-muted">
                Tu viaje
              </p>
              <p className="mt-1 font-semibold text-brand-navy">{routeLabel}</p>
              <div className="mt-2 space-y-1 text-xs text-brand-muted">
                <p className="flex items-center gap-2">
                  <CalendarDays size={16} strokeWidth={1.75} aria-hidden />
                  {context.trip.departure_time
                    ? `Salida ${formatDateTimeShort(context.trip.departure_time)}`
                    : 'Fecha de salida no disponible'}
                  {context.trip.completed_at &&
                    ` · Finalizó ${formatDateTimeShort(context.trip.completed_at)}`}
                </p>
                <p className="flex items-center gap-2">
                  <Building2 size={16} strokeWidth={1.75} aria-hidden />
                  {context.agency.name ?? 'Agencia no disponible'}
                </p>
              </div>
              {context.expires_at && (
                <p className="mt-2 text-xs font-semibold text-[#92400e]">
                  Califica antes del {formatDateTimeShort(context.expires_at)}
                </p>
              )}
            </div>

            {/* Reseña del VIAJE */}
            <section className="mt-6">
              <div className="border-l-4 border-brand-cyan pl-3">
                <h2 className="text-[20px] font-semibold">El viaje</h2>
                <p className="mt-0.5 text-xs text-brand-muted">
                  ¿Cómo estuvo el viaje en sí? (obligatorio)
                </p>
              </div>
              <div className="mt-4">
                <StarRating
                  label="Calificación del viaje"
                  idPrefix="trip-rating"
                  value={tripRating}
                  onChange={setTripRating}
                  disabled={submitting}
                />
              </div>
              <div className="mt-4">
                <label
                  htmlFor="trip-comment"
                  className="block text-xs font-medium uppercase text-brand-muted"
                >
                  Comentario sobre el viaje (opcional)
                </label>
                <textarea
                  id="trip-comment"
                  rows={3}
                  maxLength={2000}
                  value={tripComment}
                  onChange={(e) => setTripComment(e.target.value)}
                  disabled={submitting}
                  placeholder="Puntualidad, confort, conducción…"
                  className="mt-2 w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm text-brand-navy placeholder:text-brand-muted focus:border-brand-cyan focus:outline-none focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)] disabled:opacity-60"
                />
                <p className="mt-1 text-right text-[11px] text-brand-muted">
                  {tripComment.length}/2000
                </p>
              </div>
            </section>

            {/* Reseña de la AGENCIA */}
            <section className="mt-8">
              <div className="border-l-4 border-brand-cyan pl-3">
                <h2 className="text-[20px] font-semibold">La agencia</h2>
                <p className="mt-0.5 text-xs text-brand-muted">
                  {context.agency.name ?? 'La agencia que te atendió'} · ¿Cómo
                  te atendieron? (obligatorio)
                </p>
              </div>
              <div className="mt-4">
                <StarRating
                  label="Calificación de la agencia"
                  idPrefix="agency-rating"
                  value={agencyRating}
                  onChange={setAgencyRating}
                  disabled={submitting}
                />
              </div>
              <div className="mt-4">
                <label
                  htmlFor="agency-comment"
                  className="block text-xs font-medium uppercase text-brand-muted"
                >
                  Comentario sobre la agencia (opcional)
                </label>
                <textarea
                  id="agency-comment"
                  rows={3}
                  maxLength={2000}
                  value={agencyComment}
                  onChange={(e) => setAgencyComment(e.target.value)}
                  disabled={submitting}
                  placeholder="Atención, comunicación, cambios…"
                  className="mt-2 w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm text-brand-navy placeholder:text-brand-muted focus:border-brand-cyan focus:outline-none focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)] disabled:opacity-60"
                />
                <p className="mt-1 text-right text-[11px] text-brand-muted">
                  {agencyComment.length}/2000
                </p>
              </div>
            </section>

            {/* UNA sola acción principal: enviar las DOS reseñas juntas. */}
            <div className="mt-8">
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitting || tripRating < 1 || agencyRating < 1}
                className="inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? (
                  <>
                    <LoaderCircle size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />
                    Enviando…
                  </>
                ) : (
                  <>
                    <MessageSquareHeart size={16} strokeWidth={1.75} aria-hidden />
                    Enviar mi reseña
                  </>
                )}
              </button>
              <p className="mt-2 text-xs text-brand-muted">
                Las dos reseñas se envían juntas y no se pueden editar ni
                eliminar después.
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
