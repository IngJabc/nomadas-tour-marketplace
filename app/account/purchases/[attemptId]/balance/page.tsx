'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarDays,
  CheckCircle2,
  LogIn,
  MessageCircle,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  checkoutApi,
  publicApi,
  type CheckoutAttemptView,
  type PublicTripDetail,
  type ReservationPaymentProgressView,
  type SubmitBalancePaymentResult,
} from '@/lib/api';
import { ApiError, getApiErrorMessage } from '@/lib/errors/api-error';
import { sortSeatCodes } from '@/lib/booking/seat-code';
import { formatSeatPrice } from '@/lib/price';
import { formatDateTimeShort } from '@/lib/timezone';
import {
  buildBalanceWhatsAppMessage,
  whatsappMessageHref,
} from '@/lib/booking/whatsapp';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';
import { useSupportMessage } from '@/components/support/SupportMessageProvider';
import { ProofUploader } from '@/components/booking/ProofUploader';

const COMPRAS_PATH = '/account/purchases';
const LOGIN_PATH = '/login?redirect=%2Faccount%2Fpurchases';
const CATALOG_HREF = '/trips';

/**
 * MKT-010.1 — Pago del SALDO (etapa 2) de una compra en dos partes.
 *
 * El backend es la única autoridad monetaria: esta pantalla pinta el
 * progreso que devuelve `GET …/balance` (RPC `reservation_payment_progress`)
 * y envía el comprobante por `POST …/balance` con idempotencia por huella.
 * Nunca calcula montos ni envía dinero en el payload. Los flags de retraso
 * son SOLO informativos: nada se cancela ni se liberan asientos aquí (la
 * agencia decide; `seats_held` informa el estado real).
 */
function SkeletonSaldo() {
  return (
    <div role="status" className="space-y-4">
      <span className="sr-only">Cargando el saldo de tu compra…</span>
      <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="h-5 w-52 rounded-full bg-black/[0.06]" />
        <div className="mt-4 h-5 w-2/3 rounded bg-black/[0.06]" />
        <div className="mt-3 h-4 w-1/2 rounded bg-black/[0.06]" />
        <div className="mt-2 h-4 w-2/5 rounded bg-black/[0.06]" />
      </div>
      <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="h-5 w-44 rounded-full bg-black/[0.06]" />
        <div className="mt-4 h-[112px] rounded-[10px] bg-black/[0.06]" />
        <div className="mt-4 h-11 w-56 rounded-[10px] bg-black/[0.06]" />
      </div>
    </div>
  );
}

export default function PagarSaldoPage() {
  const auth = useOptionalAuthUser();
  const user = auth?.user ?? null;
  const authLoading = auth?.loading ?? false;
  const role = user?.role ?? null;

  const params = useParams<{ attemptId: string }>();
  const attemptId = params?.attemptId ?? '';

  // SUP-003: contexto de soporte de esta pantalla (pago del saldo), con el
  // identificador de la compra cuando existe.
  useSupportMessage({
    category: 'payment',
    identifiers: { purchaseId: attemptId || null },
  });

  const [progress, setProgress] =
    useState<ReservationPaymentProgressView | null>(null);
  const [attempt, setAttempt] = useState<CheckoutAttemptView | null>(null);
  /** Solo enriquece el resumen (ruta/fecha): nunca bloquea el pago. */
  const [trip, setTrip] = useState<PublicTripDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 404 uniforme: inexistente o ajena — misma vista, sin distinguir. */
  const [notFound, setNotFound] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  /**
   * 409 del backend: intento propio SIN saldo disponible (plan único o
   * depósito aún no aprobado). El mensaje sale del servidor.
   */
  const [unsupported, setUnsupported] = useState<string | null>(null);
  /**
   * Confirmación del servidor de un comprobante de saldo aceptado (201 o
   * 409 BALANCE_PAYMENT_PENDING). Solo con esto (o con el pago pendiente
   * que trae el progreso) se muestra la vista de revisión.
   */
  const [serverReview, setServerReview] = useState<{
    submittedAt: string | null;
  } | null>(null);

  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setSessionExpired(false);
    setUnsupported(null);
    try {
      const [progressResult, attemptResult] = await Promise.all([
        checkoutApi.getBalanceProgress(attemptId),
        checkoutApi.getAttempt(attemptId),
      ]);
      if (seq !== seqRef.current) return;
      setProgress(progressResult);
      setAttempt(attemptResult);

      // Resumen (viaje) best-effort: si no viene, la tarjeta usa los
      // mismos textos neutros y el pago sigue habilitado.
      try {
        const tripResult = await publicApi.tripDetail(attemptResult.trip_id);
        if (seq === seqRef.current) setTrip(tripResult.trip);
      } catch {
        // best-effort: la ruta/fecha opcional jamás bloquea el saldo.
      }
    } catch (e) {
      if (seq !== seqRef.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setSessionExpired(true);
      } else if (e instanceof ApiError && e.status === 404) {
        // 404 uniforme: no se distingue entre inexistente y ajena.
        setNotFound(true);
      } else if (e instanceof ApiError && e.status === 409) {
        setUnsupported(
          getApiErrorMessage(
            e,
            'Esta compra aún no tiene saldo disponible para pagar.',
          ),
        );
      } else {
        setError(
          getApiErrorMessage(
            e,
            'No pudimos cargar el saldo de tu compra. Intenta de nuevo.',
          ),
        );
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [attemptId]);

  useEffect(() => {
    if (authLoading || !user || role !== 'customer' || !attemptId) {
      return undefined;
    }
    void load();
    return undefined;
  }, [authLoading, user, role, attemptId, load]);

  useEffect(() => {
    if (authLoading) {
      setLoading(true);
      return;
    }
    if (!user) {
      setSessionExpired(true);
      setProgress(null);
      setAttempt(null);
      setTrip(null);
      setServerReview(null);
      setLoading(false);
      return;
    }
    if (user.role !== 'customer') {
      setProgress(null);
      setAttempt(null);
      setTrip(null);
      setServerReview(null);
      setLoading(false);
    }
  }, [authLoading, user]);

  /**
   * Envío ACEPTADO por el servidor (201): recién ahí se pasa a la vista
   * de revisión (regla 11/12) y se refresca el progreso en segundo plano.
   */
  const handleBalanceSubmitted = useCallback(
    (result: SubmitBalancePaymentResult) => {
      setServerReview({ submittedAt: result.submitted_at });
      void load();
    },
    [load],
  );

  /**
   * El servidor ya tenía un saldo en revisión (409): se recarga el
   * progreso — el pago pendiente real decide la vista y aporta su
   * timestamp, sin inventar ninguno aquí.
   */
  const handleAlreadySubmitted = useCallback(() => {
    setServerReview(null);
    void load();
  }, [load]);

  /**
   * Error de envío con estado autoritativo (saldo ya saldado o plan sin
   * saldo): se revalida contra el backend para pasar a la vista correcta.
   */
  const handleSubmitError = useCallback(
    (submitError: unknown) => {
      if (
        submitError instanceof ApiError &&
        (submitError.code === 'BALANCE_NOT_AVAILABLE' ||
          submitError.code === 'BALANCE_ALREADY_SETTLED')
      ) {
        void load();
      }
    },
    [load],
  );

  const roleBlocked = !authLoading && user !== null && role !== 'customer';

  // Estado derivado SOLO del progreso server-side.
  const payments = progress?.payments ?? [];
  const pendingBalance =
    payments.find((p) => p.stage === 'balance' && p.status === 'pending') ??
    null;
  const rejectedBalance =
    [...payments]
      .reverse()
      .find((p) => p.stage === 'balance' && p.status === 'rejected') ?? null;
  const settled = progress !== null && progress.balance_cents <= 0;

  let view:
    | 'loading'
    | 'session'
    | 'role'
    | 'notfound'
    | 'unsupported'
    | 'error'
    | 'settled'
    | 'review'
    | 'form';
  if (
    authLoading ||
    (loading &&
      progress === null &&
      !error &&
      !sessionExpired &&
      !notFound &&
      !unsupported &&
      !roleBlocked)
  ) {
    view = 'loading';
  } else if (sessionExpired) {
    view = 'session';
  } else if (roleBlocked) {
    view = 'role';
  } else if (notFound) {
    view = 'notfound';
  } else if (unsupported !== null) {
    view = 'unsupported';
  } else if (error !== null && progress === null) {
    view = 'error';
  } else if (progress === null) {
    view = 'loading';
  } else if (settled) {
    // Estado final: no hay nada por revisar ni por pagar.
    view = 'settled';
  } else if (serverReview !== null || pendingBalance) {
    view = 'review';
  } else {
    view = 'form';
  }

  const reviewSubmittedAt =
    serverReview !== null
      ? serverReview.submittedAt
      : pendingBalance?.submitted_at;

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

  const routeLabel =
    trip?.route.origin && trip?.route.destination
      ? `${trip.route.origin} → ${trip.route.destination}`
      : 'Ruta no disponible';
  const seatCodes = sortSeatCodes(attempt?.seat_codes ?? []).join(', ');

  /**
   * Solicitud del saldo por WhatsApp (MKT-010.1): enlace al número
   * PUBLICADO por la agencia con mensaje pre-escrito. Sin teléfono válido
   * la función devuelve null y el botón simplemente no se pinta.
   */
  const whatsappLink =
    progress !== null
      ? whatsappMessageHref(
          progress.agency.whatsapp_phone,
          buildBalanceWhatsAppMessage({
            agencyName: progress.agency.name,
            routeLabel: trip ? routeLabel : null,
            departureLabel:
              trip?.departure_time != null
                ? formatDateTimeShort(trip.departure_time)
                : null,
            balanceAmount: formatSeatPrice(progress.balance_cents),
          }),
        )
      : null;

  return (
    <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 pt-24 pb-16">
      {/* Encabezado en el contenedor 7xl: mismo margen izquierdo que el
          resto de páginas (el documento se centra más abajo). */}
      <div className="border-l-4 border-brand-cyan pl-3">
        <h1 className="text-[28px] font-extrabold">Pagar saldo</h1>
        <p className="mt-1 text-sm text-brand-muted">
          Este es el segundo pago de tu reserva en dos partes: primero se
          aprobó tu depósito y ahora falta saldar el saldo. Tus asientos
          siguen reservados mientras el saldo espera revisión.
        </p>
      </div>

      <div className="mx-auto w-full max-w-3xl">
        <div className="mt-8 space-y-4" aria-live="polite">
          {view === 'loading' && <SkeletonSaldo />}

          {view === 'session' && (
            <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fffbeb] text-[#92400e]">
                <ShieldAlert size={24} strokeWidth={1.75} aria-hidden />
              </div>
              <h2 className="mt-4 text-lg font-semibold">
                Tu sesión ya no está activa
              </h2>
              <p className="mt-2 max-w-md text-sm text-brand-muted">
                Inicia sesión de nuevo para pagar el saldo de tu compra.
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
                  Solo las cuentas de cliente pueden pagar sus saldos.
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

          {view === 'unsupported' && (
            <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fffbeb] text-[#92400e]">
                <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
              </div>
              <h2 className="mt-4 text-lg font-semibold">
                Este pago no está disponible
              </h2>
              <p className="mt-2 max-w-md text-sm text-brand-muted">
                {unsupported}
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
                No pudimos cargar el saldo
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

          {view === 'settled' && (
            <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#ecfdf5] text-[#059669]">
                <CheckCircle2 size={24} strokeWidth={1.75} aria-hidden />
              </div>
              <h2 className="mt-4 text-lg font-semibold">Saldo saldado</h2>
              <p className="mt-2 max-w-md text-sm text-brand-muted">
                El saldo de esta reserva ya está cubierto en su totalidad. El
                estado completo de tu reserva aparece en Mis compras.
              </p>
              <div className="mt-6">{backLink('Volver a mis compras', true)}</div>
            </div>
          )}

          {view === 'review' && progress && (
            <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                Pago en revisión
              </h2>
              <div className="mt-4 rounded-[10px] bg-[#ecfdf5] px-4 py-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-[#059669]">
                  <CheckCircle2 size={18} strokeWidth={1.75} aria-hidden />
                  Comprobante de saldo enviado. La agencia lo está revisando.
                </p>
                <p className="mt-1 text-xs text-brand-muted">
                  Recibimos el comprobante por{' '}
                  {formatSeatPrice(progress.balance_cents)} y lo estamos
                  verificando. Te avisaremos cuando sea confirmado.
                </p>
                {reviewSubmittedAt && (
                  <p className="mt-2 text-xs text-brand-muted">
                    Enviado el {formatDateTimeShort(reviewSubmittedAt)}
                  </p>
                )}
              </div>
              <p className="mt-4 text-xs text-brand-muted">
                Mientras la agencia no decida, no se admite otro comprobante de
                saldo para esta reserva. Tus asientos permanecen reservados.
              </p>
              <div className="mt-4">{backLink('Volver a mis compras', true)}</div>
            </section>
          )}

          {view === 'form' && progress && attempt && (
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
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fffbeb] px-2.5 py-0.5 text-[11px] font-semibold text-[#92400e]">
                    Saldo pendiente
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
                      {progress.agency.name ?? 'Agencia no disponible'}
                    </span>
                  </span>
                </div>

                <p className="mt-4 rounded-[10px] bg-[#f1f5f9] px-3 py-2 text-sm font-semibold text-brand-navy">
                  {progress.passenger_count} pasajero
                  {progress.passenger_count === 1 ? '' : 's'}
                  {seatCodes ? ` · asientos ${seatCodes}` : ''}
                </p>
              </section>

              {/* ── Progreso server-side del plan en dos partes ──
                  Todos los montos, porcentajes y vencimientos vienen de
                  la RPC; aquí SOLO se pintan. */}
              <section
                className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                data-testid="plan-dos-partes"
              >
                <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                  Plan de pago en dos partes
                </h2>

                <div className="mt-4 space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-3 rounded-[10px] bg-[#f1f5f9] px-4 py-3">
                    <span className="text-brand-muted">Total de la compra</span>
                    <span className="font-semibold text-brand-navy">
                      {formatSeatPrice(progress.total_cents)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-[10px] bg-[#f1f5f9] px-4 py-3">
                    <span className="text-brand-muted">
                      Depósito (etapa 1)
                      {progress.deposit_pct != null
                        ? ` · ${progress.deposit_pct}%`
                        : ''}
                    </span>
                    <span className="font-semibold text-brand-navy">
                      {progress.deposit_cents != null
                        ? formatSeatPrice(progress.deposit_cents)
                        : '—'}
                    </span>
                  </div>
                  {progress.deposit_verified_at && (
                    <p className="px-1 text-xs text-[#059669]">
                      Depósito aprobado el{' '}
                      {formatDateTimeShort(progress.deposit_verified_at)}
                    </p>
                  )}
                  <div className="flex items-center justify-between gap-3 rounded-[10px] bg-[#f1f5f9] px-4 py-3">
                    <span className="text-brand-muted">Pagado</span>
                    <span className="font-semibold text-[#059669]">
                      {formatSeatPrice(progress.paid_cents)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-[10px] border border-brand-cyan/40 bg-white px-4 py-3">
                    <span className="font-semibold text-brand-navy">
                      Falta saldar (etapa 2)
                      {progress.balance_pct != null
                        ? ` · ${progress.balance_pct}%`
                        : ''}
                    </span>
                    <span className="text-[24px] font-extrabold leading-none text-brand-navy">
                      {formatSeatPrice(progress.balance_cents)}
                    </span>
                  </div>
                  {progress.balance_deadline && (
                    <p className="px-1 text-xs text-brand-muted">
                      El saldo vence el{' '}
                      {formatDateTimeShort(progress.balance_deadline)}
                    </p>
                  )}
                </div>

                {progress.balance_overdue && progress.balance_cents > 0 && (
                  <p className="mt-3 rounded-[10px] bg-[#fffbeb] px-4 py-3 text-xs font-medium text-[#92400e]">
                    El plazo del saldo venció. La agencia decide sobre este
                    pago: no se cancela nada automáticamente y tus asientos
                    siguen reservados.
                  </p>
                )}
                {progress.seats_held && (
                  <p className="mt-3 text-xs font-medium text-[#176B62]">
                    Asientos reservados a la espera del saldo.
                  </p>
                )}

                {rejectedBalance?.rejection_reason && (
                  <p className="mt-3 rounded-[10px] bg-[#fef2f2] px-4 py-3 text-xs font-medium text-[#ef4444]">
                    Motivo del rechazo anterior:{' '}
                    {rejectedBalance.rejection_reason}
                  </p>
                )}

                {whatsappLink && (
                  <a
                    href={whatsappLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-flex items-center gap-2 rounded-[10px] bg-[#F5F1EC] px-4 py-2.5 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
                  >
                    <MessageCircle size={16} strokeWidth={1.75} aria-hidden />
                    Solicitar el saldo por WhatsApp
                  </a>
                )}
              </section>

              <section className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
                  Enviar comprobante del saldo
                </h2>
                <p className="mt-3 text-sm text-brand-muted">
                  Adjunta el comprobante de la transferencia por el saldo
                  pendiente. El importe lo valida el servidor: no se aceptan
                  montos parciales ni de otra etapa.
                </p>

                <ProofUploader<SubmitBalancePaymentResult>
                  attemptId={attemptId}
                  remainingSubmissions={1}
                  onSubmitted={handleBalanceSubmitted}
                  onAlreadySubmitted={handleAlreadySubmitted}
                  onSubmitError={handleSubmitError}
                  initialValues={
                    rejectedBalance
                      ? {
                          payment_reference: rejectedBalance.external_reference,
                          bank_origin: rejectedBalance.bank_origin,
                          payment_datetime: rejectedBalance.payment_datetime,
                        }
                      : undefined
                  }
                  submit={(file, reconciliation, idempotencyKey) =>
                    checkoutApi.submitBalanceProof(
                      attemptId,
                      file,
                      reconciliation,
                      idempotencyKey,
                    )
                  }
                />
              </section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
