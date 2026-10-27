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
  LogIn,
  RefreshCw,
  Search,
  ShieldAlert,
  Users,
} from 'lucide-react';
import {
  checkoutApi,
  publicApi,
  seatApi,
  type CheckoutAttemptView,
  type MySeatLocksResult,
  type PublicTripDetail,
} from '@/lib/api';
import { ApiError, getApiErrorMessage } from '@/lib/errors/api-error';
import { compareSeatCodes, sortSeatCodes } from '@/lib/booking/seat-code';
import { subscribeToPurchaseTicket } from '@/lib/realtime/subscriptions';
import { formatSeatPrice } from '@/lib/price';
import { formatDateTimeShort } from '@/lib/timezone';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';
import { PaymentMethodSection } from '@/components/booking/PaymentMethodSection';
import { ProofUploader } from '@/components/booking/ProofUploader';

const COMPRAS_PATH = '/account/purchases';
const LOGIN_PATH = '/login?redirect=%2Faccount%2Fpurchases';
const CATALOG_HREF = '/trips';

/** Espera tras un evento Realtime antes de revalidar (mismo valor de RT-04A). */
const REFRESH_DEBOUNCE_MS = 500;

/**
 * Errores del backend que vuelven imposible continuar con ESTA compra
 * (asientos perdidos o tiempo agotado). Ante ellos la pantalla revalida
 * contra el backend y pasa a la vista de bloqueo correspondiente.
 */
const BLOCKING_ERROR_CODES = new Set([
  'CHECKOUT_SEATS_LOST',
  'CHECKOUT_WINDOW_EXPIRED',
]);

type BlockedTone = 'danger' | 'success' | 'neutral';

interface BlockedView {
  title: string;
  body: string;
  tone: BlockedTone;
  cta: 'compras' | 'catalogo';
}

/**
 * Estado actual → qué ve el cliente. RT-05 solo admite el formulario de
 * reintento para un intento `rejected`, vigente y con SUS asientos todavía
 * bloqueados; todo lo demás informa y ofrece el siguiente paso. Sin
 * contadores de envíos ni jerga de "ventana/plazo" (copy MKT-007.1).
 * La autoridad sigue siendo el backend en el envío.
 */
function resolveBlocked(
  attempt: CheckoutAttemptView,
  locksOk: boolean,
): BlockedView | null {
  const windowOpen = Date.parse(attempt.expires_at) > Date.now();

  switch (attempt.status) {
    case 'verified':
      return {
        title: 'Pago aprobado',
        body: 'El pago de esta compra ya fue aprobado por la agencia. El estado de tu reserva aparece en Mis compras.',
        tone: 'success',
        cta: 'compras',
      };
    case 'rejected_final':
      return {
        title: 'Comprobante rechazado',
        body: 'No es posible enviar más comprobantes para esta compra. Contacta a la agencia si necesitas ayuda.',
        tone: 'danger',
        cta: 'compras',
      };
    case 'expired':
      return {
        title: 'Esta compra expiró',
        body: 'El tiempo para enviar el comprobante terminó y tus asientos ya no están reservados. Debes buscar otro viaje para continuar.',
        tone: 'danger',
        cta: 'catalogo',
      };
    case 'cancelled':
      return {
        title: 'Compra cancelada',
        body: 'Esta compra fue cancelada y sus asientos quedaron libres. Debes buscar otro viaje para continuar.',
        tone: 'neutral',
        cta: 'catalogo',
      };
    case 'created':
      return {
        title: 'Envío no disponible',
        body: 'Esta compra todavía no tiene comprobantes enviados desde esta pantalla. Revisa su estado en Mis compras.',
        tone: 'neutral',
        cta: 'compras',
      };
    case 'pending_review':
      // No es un bloqueo: la vista de revisión prevalece sobre esta ruta.
      return null;
    case 'rejected': {
      if (attempt.remaining_submissions <= 0) {
        return {
          title: 'Comprobante rechazado',
          body: 'No quedan comprobantes disponibles para esta compra. Contacta a la agencia si necesitas ayuda.',
          tone: 'danger',
          cta: 'compras',
        };
      }
      if (!windowOpen) {
        return {
          title: 'Tiempo agotado',
          body: 'El tiempo para enviar el comprobante de esta compra terminó y tus asientos ya no están reservados. Debes buscar otro viaje para continuar.',
          tone: 'danger',
          cta: 'catalogo',
        };
      }
      if (!locksOk) {
        return {
          title: 'Asientos no disponibles',
          body: 'Los asientos de esta compra ya no están disponibles: fueron liberados o reservados por otra compra. Debes buscar otro viaje para continuar.',
          tone: 'danger',
          cta: 'catalogo',
        };
      }
      return null;
    }
    default:
      return {
        title: 'Estado no disponible',
        body: 'No podemos gestionar el pago de esta compra en este momento. Revisa su estado en Mis compras.',
        tone: 'neutral',
        cta: 'compras',
      };
  }
}

interface SummaryPassenger {
  name: string;
  document: string | null;
  seatId: string;
}

/**
 * Pasajeros declarados en el intento (jsonb opaco): se valida la forma en
 * runtime y NUNCA se lee `phone` (dato sensible sin uso en esta pantalla).
 */
function parsePassengers(raw: unknown): SummaryPassenger[] {
  if (!Array.isArray(raw)) return [];
  const passengers: SummaryPassenger[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.seat_id !== 'string' || !record.seat_id) continue;
    const first = typeof record.first_name === 'string' ? record.first_name.trim() : '';
    const last = typeof record.last_name === 'string' ? record.last_name.trim() : '';
    const name = [first, last].filter(Boolean).join(' ') || 'Pasajero';
    const document =
      typeof record.document === 'string' && record.document.trim()
        ? record.document.trim()
        : null;
    passengers.push({ name, document, seatId: record.seat_id });
  }
  return passengers;
}

function SkeletonPago() {
  return (
    <div role="status" className="space-y-4">
      <span className="sr-only">Cargando el pago de tu compra…</span>
      <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="h-5 w-56 rounded-full bg-black/[0.06]" />
        <div className="mt-4 h-5 w-2/3 rounded bg-black/[0.06]" />
        <div className="mt-3 h-4 w-1/2 rounded bg-black/[0.06]" />
        <div className="mt-2 h-4 w-2/5 rounded bg-black/[0.06]" />
      </div>
      <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="h-5 w-44 rounded-full bg-black/[0.06]" />
        <div className="mt-4 h-[88px] rounded-[10px] bg-black/[0.06]" />
        <div className="mt-4 h-11 w-48 rounded-[10px] bg-black/[0.06]" />
      </div>
    </div>
  );
}

export default function ReintentoPagoPage() {
  const auth = useOptionalAuthUser();
  const user = auth?.user ?? null;
  const authLoading = auth?.loading ?? false;
  const role = user?.role ?? null;

  const params = useParams<{ attemptId: string }>();
  const attemptId = params?.attemptId ?? '';

  const [attempt, setAttempt] = useState<CheckoutAttemptView | null>(null);
  const [trip, setTrip] = useState<PublicTripDetail | null>(null);
  const [locks, setLocks] = useState<MySeatLocksResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 404 uniforme: inexistente o ajena — misma vista, sin distinguir. */
  const [notFound, setNotFound] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  /**
   * Confirmación del servidor de que YA hay un comprobante en revisión
   * (201 propio o 409 PROOF_PENDING). Solo con esto (o con el status
   * `pending_review` del backend) se muestra la vista de revisión.
   */
  const [serverReview, setServerReview] = useState<{
    submittedAt: string | null;
  } | null>(null);
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  const [coordinatedPayment, setCoordinatedPayment] = useState(false);

  const seqRef = useRef(0);
  const attemptRef = useRef<CheckoutAttemptView | null>(null);

  const setAttemptKeep = useCallback((next: CheckoutAttemptView | null) => {
    attemptRef.current = next;
    setAttempt(next);
  }, []);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setSessionExpired(false);
    try {
      const current = await checkoutApi.getAttempt(attemptId);
      if (seq !== seqRef.current) return;
      setAttemptKeep(current);

      // Resumen (viaje) y disponibilidad (bloqueos) en paralelo. El viaje
      // solo enriquece la tarjeta: si no viene, la ruta usa los mismos
      // textos neutros del historial y nunca bloquea el reintento.
      const [tripResult, locksResult] = await Promise.allSettled([
        publicApi.tripDetail(current.trip_id),
        seatApi.mySeatLocks(current.trip_id),
      ]);
      if (seq !== seqRef.current) return;

      setTrip(tripResult.status === 'fulfilled' ? tripResult.value.trip : null);

      if (locksResult.status === 'rejected') {
        const reason = locksResult.reason;
        if (reason instanceof ApiError && reason.status === 401) {
          setSessionExpired(true);
          return;
        }
        // Sin poder verificar los bloqueos NO se admite ningún envío
        // (fail closed): el backend exige exactamente estos locks.
        setError(
          getApiErrorMessage(
            reason,
            'No pudimos verificar los asientos de esta compra. Intenta de nuevo.',
          ),
        );
        return;
      }
      setLocks(locksResult.value);
    } catch (e) {
      if (seq !== seqRef.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setSessionExpired(true);
      } else if (e instanceof ApiError && e.status === 404) {
        // 404 uniforme: no se distingue entre inexistente y ajena.
        setNotFound(true);
      } else {
        setError(
          getApiErrorMessage(
            e,
            'No pudimos cargar esta compra. Intenta de nuevo.',
          ),
        );
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [attemptId, setAttemptKeep]);

  /** Timer del refresco realtime: un solo disparo por ráfaga (patrón RT-04A). */
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void load();
    }, REFRESH_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => {
    if (authLoading || !user || role !== 'customer' || !attemptId) {
      return undefined;
    }
    const cleanup = subscribeToPurchaseTicket(user.id, attemptId, scheduleRefresh);
    return () => {
      cleanup();
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [authLoading, user, role, attemptId, scheduleRefresh]);

  useEffect(() => {
    seqRef.current += 1;
    if (authLoading) {
      setLoading(true);
      return;
    }
    if (!user) {
      setSessionExpired(true);
      setAttemptKeep(null);
      setTrip(null);
      setLocks(null);
      setServerReview(null);
      setLoading(false);
      return;
    }
    if (user.role !== 'customer') {
      setAttemptKeep(null);
      setTrip(null);
      setLocks(null);
      setServerReview(null);
      setLoading(false);
      return;
    }
    setServerReview(null);
    void load();
  }, [authLoading, user, role, load, setAttemptKeep]);

  /**
   * El envío fue ACEPTADO por el servidor (201): recién ahí se pasa a la
   * vista de revisión y se informa el éxito (regla 11 y 12).
   */
  const handleProofSubmitted = useCallback(() => {
    setServerReview({ submittedAt: new Date().toISOString() });
    toast.success('Comprobante enviado. Tu pago está pendiente de revisión.');
  }, []);

  /**
   * El servidor ya tenía un comprobante en revisión (409): se muestra la
   * revisión SIN afirmar un éxito nuevo ni inventar un timestamp que esta
   * respuesta no trajo.
   */
  const handleAlreadySubmitted = useCallback(() => {
    setServerReview({ submittedAt: null });
    toast.success('Tu comprobante ya estaba enviado y sigue en revisión.');
  }, []);

  /**
   * Error de envío con estado autoritativo (asientos perdidos / tiempo
   * agotado): se revalida contra el backend para pasar al bloqueo; si fue
   * transitorio, el formulario sigue intacto.
   */
  const handleSubmitError = useCallback(
    (submitError: unknown) => {
      if (
        submitError instanceof ApiError &&
        BLOCKING_ERROR_CODES.has(submitError.code)
      ) {
        void load();
      }
    },
    [load],
  );

  const roleBlocked = !authLoading && user !== null && role !== 'customer';

  const lockIds = new Set((locks?.seats ?? []).map((seat) => seat.id));
  const locksOk =
    attempt !== null && attempt.seat_ids.every((seatId) => lockIds.has(seatId));
  const blocked =
    attempt !== null && attempt.status !== 'pending_review'
      ? resolveBlocked(attempt, locksOk)
      : null;

  let view:
    | 'loading'
    | 'session'
    | 'role'
    | 'error'
    | 'notfound'
    | 'review'
    | 'blocked'
    | 'form';
  if (
    authLoading ||
    (loading &&
      attempt === null &&
      !error &&
      !sessionExpired &&
      !notFound &&
      !roleBlocked)
  ) {
    view = 'loading';
  } else if (sessionExpired) {
    view = 'session';
  } else if (roleBlocked) {
    view = 'role';
  } else if (notFound) {
    view = 'notfound';
  } else if (error !== null && locks === null) {
    // Cualquier fallo sin bloqueos verificables (intento o locks): error
    // honesto con reintentar, nunca el bloqueo de "asientos no
    // disponibles" (sería mentir con una causa transitoria) ni el
    // formulario (fail closed).
    view = 'error';
  } else if (attempt === null) {
    view = 'loading';
  } else if (serverReview !== null || attempt.status === 'pending_review') {
    view = 'review';
  } else if (blocked) {
    view = 'blocked';
  } else {
    view = 'form';
  }

  /** Reintento: último envío confirmado, o el del snapshot al entrar. */
  const reviewSubmittedAt =
    serverReview !== null ? serverReview.submittedAt : attempt?.proof_submitted_at;

  const backLink = (label: string, primary = false) => (
    <Link
      href={COMPRAS_PATH}
      className={
        primary
          ? 'inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue'
          : 'inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-4 py-2 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]'
      }
    >
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
      {label}
    </Link>
  );

  const toneClasses: Record<BlockedTone, { shell: string; text: string }> = {
    danger: { shell: 'bg-[#fef2f2] text-[#ef4444]', text: 'text-[#ef4444]' },
    success: { shell: 'bg-[#ecfdf5] text-[#059669]', text: 'text-[#059669]' },
    neutral: { shell: 'bg-[#f1f5f9] text-brand-muted', text: 'text-brand-muted' },
  };

  const routeLabel =
    trip?.route.origin && trip?.route.destination
      ? `${trip.route.origin} → ${trip.route.destination}`
      : 'Ruta no disponible';
  const agencyName =
    trip?.offers.find((offer) => offer.agency_id === attempt?.agency_id)?.name ??
    'Agencia no disponible';

  const seatCodeById = new Map(
    (attempt?.seat_ids ?? []).map((seatId, index) => [
      seatId,
      attempt?.seat_codes[index] ?? seatId,
    ]),
  );
  const passengers = parsePassengers(attempt?.passenger_data)
    .map((passenger) => ({
      ...passenger,
      seatCode: seatCodeById.get(passenger.seatId) ?? passenger.seatId,
    }))
    .sort((a, b) => compareSeatCodes(a.seatCode, b.seatCode));
  const seatCodes = sortSeatCodes(attempt?.seat_codes ?? []).join(', ');

  return (
    <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 pt-24 pb-16">
      <div className="mx-auto w-full max-w-3xl">
        <div className="border-l-4 border-brand-cyan pl-3">
          <h1 className="text-[28px] font-extrabold">Corregir pago</h1>
          <p className="mt-1 text-sm text-brand-muted">
            Revisa los datos de tu compra, corrige el comprobante y vuelve a
            enviarlo. Tus asientos y pasajeros siguen guardados.
          </p>
        </div>

        <div className="mt-8 space-y-4" aria-live="polite">
          {view === 'loading' && <SkeletonPago />}

          {view === 'session' && (
            <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fffbeb] text-[#92400e]">
                <ShieldAlert size={24} strokeWidth={1.75} aria-hidden />
              </div>
              <h2 className="mt-4 text-lg font-semibold">
                Tu sesión ya no está activa
              </h2>
              <p className="mt-2 max-w-md text-sm text-brand-muted">
                Inicia sesión de nuevo para corregir el pago de tu compra.
              </p>
              <Link
                href={LOGIN_PATH}
                className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
              >
                <LogIn size={16} strokeWidth={1.75} aria-hidden />
                Iniciar sesión
              </Link>
            </div>
          )}

          {view === 'role' && (
            <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="rounded-[10px] bg-[#fffbeb] px-4 py-3">
                <p className="text-sm font-semibold text-[#92400e]">
                  Solo las cuentas de cliente pueden gestionar sus pagos.
                </p>
                <p className="mt-1 text-xs text-brand-muted">
                  Tu sesión actual no es una cuenta de cliente, así que esta
                  compra no le corresponde.
                </p>
              </div>
              <div className="mt-4">{backLink('Volver a mis compras')}</div>
            </div>
          )}

          {view === 'notfound' && (
            <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#f1f5f9] text-brand-muted">
                <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
              </div>
              <h2 className="mt-4 text-lg font-semibold">
                No pudimos encontrar esta compra
              </h2>
              <p className="mt-2 max-w-md text-sm text-brand-muted">
                Puede que ya no exista o que no pertenezca a tu cuenta. Revisa
                tu historial de compras para ver el estado de tus operaciones.
              </p>
              <div className="mt-6">{backLink('Volver a mis compras', true)}</div>
            </div>
          )}

          {view === 'error' && (
            <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fef2f2] text-[#ef4444]">
                <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
              </div>
              <h2 className="mt-4 text-lg font-semibold">
                No pudimos cargar esta compra
              </h2>
              <p className="mt-2 max-w-md text-sm text-brand-muted">{error}</p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => void load()}
                  className="rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                >
                  Reintentar
                </button>
                {backLink('Volver a mis compras')}
              </div>
            </div>
          )}

          {view === 'review' && attempt && (
            <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                Pago en revisión
              </h2>
              <div className="mt-4 rounded-[10px] bg-[#ecfdf5] px-4 py-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-[#059669]">
                  <CheckCircle2 size={18} strokeWidth={1.75} aria-hidden />
                  Comprobante enviado. Tu pago está pendiente de revisión.
                </p>
                <p className="mt-1 text-xs text-brand-muted">
                  Recibimos el comprobante y la agencia lo está revisando. Te
                  avisaremos cuando sea confirmado.
                </p>
                {reviewSubmittedAt && (
                  <p className="mt-2 text-xs text-brand-muted">
                    Enviado el {formatDateTimeShort(reviewSubmittedAt)}
                  </p>
                )}
              </div>
              <p className="mt-4 text-xs text-brand-muted">
                Mientras la agencia no decida, no se admite otro comprobante para
                esta compra. Puedes seguir su estado en Mis compras.
              </p>
              <div className="mt-4">{backLink('Volver a mis compras', true)}</div>
            </section>
          )}

          {view === 'blocked' && blocked && (
            <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div
                className={`flex h-14 w-14 items-center justify-center rounded-full ${toneClasses[blocked.tone].shell}`}
              >
                {blocked.tone === 'success' ? (
                  <CheckCircle2 size={24} strokeWidth={1.75} aria-hidden />
                ) : (
                  <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
                )}
              </div>
              <h2 className="mt-4 text-lg font-semibold">{blocked.title}</h2>
              <p className="mt-2 max-w-md text-sm text-brand-muted">
                {blocked.body}
              </p>
              {blocked.cta === 'catalogo' ? (
                <Link
                  href={CATALOG_HREF}
                  className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                >
                  <Search size={16} strokeWidth={1.75} aria-hidden />
                  Explorar viajes
                </Link>
              ) : (
                <div className="mt-6">{backLink('Volver a mis compras', true)}</div>
              )}
            </div>
          )}

          {view === 'form' && attempt && (
            <>
              {error && (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[#fef2f2] px-4 py-3"
                >
                  <p className="text-sm font-semibold text-[#ef4444]">{error}</p>
                  <button
                    type="button"
                    onClick={() => void load()}
                    disabled={loading}
                    className="inline-flex items-center gap-2 rounded-[10px] bg-white px-4 py-2 text-xs font-semibold text-[#ef4444] transition-colors duration-200 hover:bg-[#fee2e2] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
                    Reintentar
                  </button>
                </div>
              )}

              <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                    Resumen de la compra
                  </h2>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fef2f2] px-2.5 py-0.5 text-[11px] font-semibold text-[#ef4444]">
                    Comprobante rechazado
                  </span>
                </div>

                <p className="mt-4 text-[17px] font-semibold text-brand-navy">
                  {routeLabel}
                </p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-brand-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays size={16} strokeWidth={1.75} aria-hidden />
                    {trip?.departure_time
                      ? formatDateTimeShort(trip.departure_time)
                      : 'Fecha de salida no disponible'}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Building2 size={16} strokeWidth={1.75} aria-hidden />
                    <span className="font-medium text-brand-navy">
                      {agencyName}
                    </span>
                  </span>
                </div>

                <p className="mt-4 rounded-[10px] bg-[#f1f5f9] px-3 py-2 text-sm font-semibold text-brand-navy">
                  {attempt.passenger_count} pasajero
                  {attempt.passenger_count === 1 ? '' : 's'}
                  {seatCodes ? ` · asientos ${seatCodes}` : ''}
                </p>

                {passengers.length > 0 && (
                  <ul className="mt-4 space-y-2">
                    {passengers.map((passenger) => (
                      <li
                        key={`${passenger.seatId}-${passenger.name}`}
                        className="flex items-start justify-between gap-2 text-sm"
                      >
                        <span className="font-medium text-brand-navy">
                          {passenger.name}
                        </span>
                        <span className="text-brand-muted">
                          {passenger.document ? `${passenger.document} · ` : ''}
                          Asiento {passenger.seatCode}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {attempt.rejection_reason && (
                  <p className="mt-4 rounded-[10px] bg-[#fef2f2] px-3 py-2 text-xs font-medium text-[#ef4444]">
                    Motivo del rechazo: {attempt.rejection_reason}
                  </p>
                )}

                <div className="mt-4 flex items-center justify-between rounded-[10px] bg-[#f1f5f9] px-3 py-2">
                  <span className="text-[11px] font-medium uppercase text-brand-muted">
                    Importe a transferir
                  </span>
                  <span className="text-[17px] font-extrabold leading-none text-brand-navy">
                    {formatSeatPrice(attempt.amount_cents)}
                  </span>
                </div>
              </section>

              <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                  Enviar comprobante
                </h2>
                <p className="mt-3 text-sm text-brand-muted">
                  Corrige lo que marcó la agencia y vuelve a enviar tu
                  comprobante. No necesitas elegir asientos ni registrar
                  pasajeros otra vez.
                </p>

                <PaymentMethodSection
                  attemptId={attemptId}
                  onSelectionChange={setSelectedMethodId}
                  onNoMethodsChange={setCoordinatedPayment}
                />

                {selectedMethodId || coordinatedPayment ? (
                  <ProofUploader
                    attemptId={attemptId}
                    remainingSubmissions={attempt.remaining_submissions}
                    onSubmitted={handleProofSubmitted}
                    onAlreadySubmitted={handleAlreadySubmitted}
                    initialValues={{
                      payment_reference: attempt.payment_reference,
                      bank_origin: attempt.bank_origin,
                      payment_datetime: attempt.payment_datetime,
                    }}
                    onSubmitError={handleSubmitError}
                  />
                ) : (
                  <p className="mt-5 text-sm text-brand-muted">
                    Selecciona un método de pago para continuar con tu
                    comprobante.
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
