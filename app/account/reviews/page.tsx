'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarDays,
  LogIn,
  MessageSquareHeart,
  RefreshCw,
  ShieldAlert,
  Star,
} from 'lucide-react';
import {
  reviewsApi,
  type ReviewItemDto,
  type ReviewItemState,
} from '@/lib/api';
import { ApiError, getApiErrorMessage } from '@/lib/errors/api-error';
import { formatDateTimeShort } from '@/lib/timezone';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';

const REVIEWS_PATH = '/account/reviews';
const LOGIN_PATH = '/login?redirect=%2Faccount%2Freviews';
const CATALOG_HREF = '/trips';
const COMPRAS_PATH = '/account/purchases';

/** Estado de badge de la lista (pill de AGENTS.md). */
const STATE_META: Record<
  ReviewItemState,
  { label: string; className: string }
> = {
  pending: {
    label: 'Pendiente de calificar',
    className: 'bg-[#fffbeb] text-[#92400e]',
  },
  submitted: {
    label: 'Reseña enviada',
    className: 'bg-[#ecfdf5] text-[#059669]',
  },
  expired: {
    label: 'Plazo vencido',
    className: 'bg-[#f1f5f9] text-brand-muted',
  },
};

/** Estrellas de solo lectura (Lucide Star, stroke 1.75). */
function Stars({ rating }: { rating: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      aria-label={`${rating} de 5 estrellas`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className={n <= rating ? 'fill-[#f59e0b] text-[#f59e0b]' : 'text-[#e5e7eb]'}
        />
      ))}
    </span>
  );
}

function routeLabel(item: ReviewItemDto): string {
  if (item.trip.origin && item.trip.destination) {
    return `${item.trip.origin} → ${item.trip.destination}`;
  }
  return 'Ruta no disponible';
}

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="flex items-start justify-between gap-3">
        <div className="h-5 w-40 rounded-full bg-black/[0.06]" />
        <div className="h-5 w-32 rounded-full bg-black/[0.06]" />
      </div>
      <div className="mt-4 h-5 w-2/3 rounded bg-black/[0.06]" />
      <div className="mt-4 h-4 w-1/2 rounded bg-black/[0.06]" />
      <div className="mt-6 h-10 w-40 rounded-[10px] bg-black/[0.06]" />
    </div>
  );
}

export default function MisResenasPage() {
  const auth = useOptionalAuthUser();
  const user = auth?.user ?? null;
  const authLoading = auth?.loading ?? false;
  const role = user?.role ?? null;

  const [items, setItems] = useState<ReviewItemDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const seqRef = useRef(0);
  const prevUserRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    // Se limpia al INICIAR la carga: si el usuario reintenta tras un
    // 401 (p.ej. volvió a iniciar sesión), el panel de sesión no debe
    // seguir visible mientras carga; un nuevo 401 lo vuelve a poner.
    setSessionExpired(false);
    try {
      const result = await reviewsApi.list();
      if (seq !== seqRef.current) return;
      setItems(result.items);
    } catch (e) {
      if (seq !== seqRef.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setSessionExpired(true);
      } else {
        // Un refresco fallido conserva la lista anterior visible.
        setItems((prev) => prev);
        setError(
          getApiErrorMessage(
            e,
            'No pudimos cargar tus reseñas. Intenta de nuevo.',
          ),
        );
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  const roleBlocked = !authLoading && user !== null && role !== 'customer';

  useEffect(() => {
    seqRef.current += 1;
    if (authLoading) return;
    if (!user) {
      setSessionExpired(true);
      setItems(null);
      setLoading(false);
      return;
    }
    if (user.role !== 'customer') {
      setItems(null);
      setLoading(false);
      return;
    }
    if (prevUserRef.current !== user.id) {
      // Cambio de identidad (login/logout/cambio de cuenta): se limpia
      // la lista ANTES de cargar para nunca mostrar las reseñas del
      // usuario anterior; cualquier respuesta en vuelo queda invalidada
      // por el seq-guard de load().
      prevUserRef.current = user.id;
      setItems(null);
      setError(null);
    }
    void load();
  }, [authLoading, user, role, load]);

  const retry = () => {
    void load();
  };

  let view: 'loading' | 'session' | 'role' | 'error' | 'empty' | 'list';
  if (authLoading || (loading && items === null && !error && !sessionExpired && !roleBlocked)) {
    view = 'loading';
  } else if (sessionExpired) {
    view = 'session';
  } else if (roleBlocked) {
    view = 'role';
  } else if (items === null && error) {
    view = 'error';
  } else if (items !== null && items.length === 0) {
    view = 'empty';
  } else {
    view = 'list';
  }

  return (
    <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 pt-24 pb-16">
      <div className="border-l-4 border-brand-cyan pl-3">
        <h1 className="text-[28px] font-extrabold">Mis reseñas</h1>
        <p className="mt-1 text-sm text-brand-muted">
          Tu opinión sobre el viaje y la agencia importa para ofrecer un mejor servicio.
        </p>
      </div>

      <div className="mt-8" aria-live="polite">
        {view === 'loading' && (
          <div role="status" className="grid gap-4">
            <span className="sr-only">Cargando tus reseñas…</span>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {view === 'session' && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fffbeb] text-[#92400e]">
              <ShieldAlert size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              Tu sesión ya no está activa
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              Inicia sesión de nuevo para ver y enviar tus reseñas.
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
                Solo las cuentas de cliente pueden enviar reseñas.
              </p>
              <p className="mt-1 text-xs text-brand-muted">
                Tu sesión actual no es una cuenta de cliente, así que estas
                reseñas no le corresponden.
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

        {view === 'error' && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#fef2f2] text-[#ef4444]">
              <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              No pudimos cargar tus reseñas
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
              Reintentar
            </button>
          </div>
        )}

        {view === 'empty' && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-cyan-bg)] text-brand-cyan">
              <MessageSquareHeart size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              Aún no tienes reseñas
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              Cuando finalice uno de tus viajes te pediremos que lo califiques.
              Aquí aparecerán tus invitaciones.
            </p>
            <Link
              href={COMPRAS_PATH}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              Ver mis compras
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
            </Link>
          </div>
        )}

        {view === 'list' && items !== null && (
          <>
            {error && (
              <div
                role="alert"
                className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[#fef2f2] px-4 py-3"
              >
                <p className="text-sm font-semibold text-[#ef4444]">{error}</p>
                <button
                  type="button"
                  onClick={retry}
                  disabled={loading}
                  className="inline-flex items-center gap-2 rounded-[10px] bg-white px-4 py-2 text-xs font-semibold text-[#ef4444] transition-colors duration-200 hover:bg-[#fee2e2] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
                  Reintentar
                </button>
              </div>
            )}

            <div className="grid gap-4">
              {items.map((item) => {
                const meta = STATE_META[item.state] ?? STATE_META.expired;
                return (
                  <article
                    key={item.reservation_id}
                    className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${meta.className}`}
                      >
                        {meta.label}
                      </span>
                      {item.expires_at && item.state === 'pending' && (
                        <p className="text-right text-[11px] font-medium uppercase text-brand-muted">
                          Plazo hasta
                          <time
                            dateTime={item.expires_at}
                            className="mt-0.5 block text-xs font-normal normal-case text-brand-navy"
                          >
                            {formatDateTimeShort(item.expires_at)}
                          </time>
                        </p>
                      )}
                    </div>

                    <h2 className="mt-4 text-[17px] font-semibold leading-snug">
                      {routeLabel(item)}
                    </h2>

                    <div className="mt-3 space-y-2 text-sm text-brand-muted">
                      <p className="flex items-center gap-2">
                        <CalendarDays
                          size={16}
                          strokeWidth={1.75}
                          className="shrink-0"
                          aria-hidden
                        />
                        {item.trip.departure_time
                          ? `Salida ${formatDateTimeShort(item.trip.departure_time)}`
                          : 'Fecha de salida no disponible'}
                        {item.trip.completed_at &&
                          ` · Finalizó ${formatDateTimeShort(item.trip.completed_at)}`}
                      </p>
                      <p className="flex items-center gap-2">
                        <Building2
                          size={16}
                          strokeWidth={1.75}
                          className="shrink-0"
                          aria-hidden
                        />
                        <span className="font-medium text-brand-navy">
                          {item.agency.name ?? 'Agencia no disponible'}
                        </span>
                      </p>
                    </div>

                    {item.state === 'pending' && (
                      <Link
                        href={`${REVIEWS_PATH}/${item.reservation_id}`}
                        className="mt-4 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                      >
                        <MessageSquareHeart size={16} strokeWidth={1.75} aria-hidden />
                        Calificar viaje y agencia
                      </Link>
                    )}

                    {item.state === 'submitted' && (
                      <div className="mt-4 space-y-3">
                        {item.trip_review && (
                          <div className="rounded-[10px] bg-[#f1f5f9] px-4 py-3 text-sm">
                            <p className="text-[11px] font-medium uppercase text-brand-muted">
                              Viaje
                            </p>
                            <div className="mt-1 flex items-center gap-2">
                              <Stars rating={item.trip_review.rating} />
                              <span className="text-xs text-brand-muted">
                                {item.trip_review.rating}/5
                              </span>
                            </div>
                            {item.trip_review.comment && (
                              <p className="mt-1 text-brand-navy">
                                {item.trip_review.comment}
                              </p>
                            )}
                          </div>
                        )}
                        {item.agency_review && (
                          <div className="rounded-[10px] bg-[#f1f5f9] px-4 py-3 text-sm">
                            <p className="text-[11px] font-medium uppercase text-brand-muted">
                              Agencia
                            </p>
                            <div className="mt-1 flex items-center gap-2">
                              <Stars rating={item.agency_review.rating} />
                              <span className="text-xs text-brand-muted">
                                {item.agency_review.rating}/5
                              </span>
                            </div>
                            {item.agency_review.comment && (
                              <p className="mt-1 text-brand-navy">
                                {item.agency_review.comment}
                              </p>
                            )}
                          </div>
                        )}
                        <p className="text-xs text-brand-muted">
                          Enviada el{' '}
                          {formatDateTimeShort(
                            item.trip_review?.created_at ??
                              item.agency_review?.created_at ??
                              item.created_at,
                          )}
                          . Las reseñas no se pueden editar ni eliminar.
                        </p>
                      </div>
                    )}

                    {item.state === 'expired' && (
                      <p className="mt-4 rounded-[10px] bg-[#f1f5f9] px-4 py-3 text-sm text-brand-muted">
                        El plazo para calificar este viaje venció el{' '}
                        {item.expires_at
                          ? formatDateTimeShort(item.expires_at)
                          : '—'}
                        . Gracias por tu interés en mejorar el servicio.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
