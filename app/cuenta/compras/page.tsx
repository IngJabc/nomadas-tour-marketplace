'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowUp,
  Building2,
  CalendarDays,
  LogIn,
  RefreshCw,
  Search,
  ShieldAlert,
  Ticket,
  Users,
  X,
} from 'lucide-react';
import {
  checkoutApi,
  type PurchaseEstado,
  type PurchaseItemDto,
} from '@/lib/api';
import { ApiError, getApiErrorMessage } from '@/lib/errors/api-error';
import { compareSeatCodes, sortSeatCodes } from '@/lib/booking/seat-code';
import { formatSeatPrice } from '@/lib/price';
import { formatDateTimeShort } from '@/lib/timezone';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';

/** Tamaño de página (5 por petición del cliente). Backend acepta 1..50. */
const PAGE_SIZE = 5;

const LOGIN_PATH = '/login?redirect=%2Fcuenta%2Fcompras';
const CATALOG_HREF = '/viajes';
const COMPRAS_PATH = '/cuenta/compras';

/**
 * Una compra solo habilita su boleto cuando el backend la confirmó como
 * `reserva_confirmada` (intento verificado + reserva nacida en verify) y
 * además expone un código de boleto real. El resto de estados (aprobado
 * sin reserva, en revisión, rechazado, etc.) nunca muestra la acción, y la
 * página del boleto vuelve a validar todo contra el backend antes de servir
 * el QR: este flag es solo para no mostrar un enlace que fallaría.
 */
function esBoletoDisponible(item: PurchaseItemDto): boolean {
  return (
    item.estado === 'reserva_confirmada' &&
    item.reserva !== null &&
    item.reserva.ticket_code !== null
  );
}

interface EstadoMeta {
  label: string;
  className: string;
}

/**
 * Badge por estado derivado (RT-01). El texto distingue los estados sin
 * depender solo del color; un estado futuro no reconocido cae en
 * `desconocido` en lugar de inventar significado.
 */
const ESTADO_META: Record<PurchaseEstado, EstadoMeta> = {
  pendiente_comprobante: {
    label: 'Comprobante pendiente',
    className: 'bg-[#fffbeb] text-[#92400e]',
  },
  en_revision: {
    label: 'En revisión',
    className: 'bg-[#f1f5f9] text-brand-navy',
  },
  rechazado: {
    label: 'Rechazado',
    className: 'bg-[#fef2f2] text-[#ef4444]',
  },
  rechazado_final: {
    label: 'Rechazado definitivo',
    className: 'bg-[#fef2f2] text-[#ef4444]',
  },
  aprobado: {
    label: 'Pago aprobado',
    className: 'bg-[#ecfdf5] text-[#059669]',
  },
  reserva_confirmada: {
    label: 'Reserva confirmada',
    className: 'bg-[#ecfdf5] text-[#059669]',
  },
  expirado: {
    label: 'Expirado',
    className: 'bg-[#f1f5f9] text-brand-muted',
  },
  cancelado: {
    label: 'Cancelado',
    className: 'bg-[#fef2f2] text-[#ef4444]',
  },
  desconocido: {
    label: 'Estado no reconocido',
    className: 'bg-[#f1f5f9] text-brand-muted',
  },
};

function estadoMeta(estado: PurchaseEstado | string): EstadoMeta {
  return (
    (ESTADO_META as Record<string, EstadoMeta>)[estado] ??
    ESTADO_META.desconocido
  );
}

/** payment_status de reservations, traducido; valor desconocido → crudo. */
const PAGO_RESERVA_LABELS: Record<string, string> = {
  pending: 'pendiente',
  partial: 'pago parcial',
  fully_paid: 'totalmente pagada',
  refunded: 'reembolsada',
  cancelled: 'cancelada',
};

const PAGO_ESTADO_LABELS: Record<string, string> = {
  pendiente: 'Pago pendiente',
  aprobado: 'Pago aprobado',
  rechazado: 'Pago rechazado',
};

function routeLabel(trip: PurchaseItemDto['trip']): string {
  if (trip.origin && trip.destination) {
    return `${trip.origin} → ${trip.destination}`;
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
      <div className="mt-2 h-4 w-2/5 rounded bg-black/[0.06]" />
      <div className="mt-6 h-10 w-full rounded-[10px] bg-black/[0.06]" />
    </div>
  );
}

export default function MisComprasPage() {
  const auth = useOptionalAuthUser();
  const user = auth?.user ?? null;
  const authLoading = auth?.loading ?? false;
  const customerId = user?.id ?? null;
  const role = user?.role ?? null;

  const [items, setItems] = useState<PurchaseItemDto[] | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  /** Modal de pasajeros: el intento cuya lista está abierta (o null). */
  const [passengersModalFor, setPassengersModalFor] =
    useState<PurchaseItemDto | null>(null);
  const [showTop, setShowTop] = useState(false);

  /** Última secuencia iniciada: descarta respuestas viejas o de otra identidad. */
  const seqRef = useRef(0);
  /** Destino del último intento de carga: el reintento repite ese destino. */
  const targetRef = useRef(0);

  const loadPage = useCallback(async (targetPage: number) => {
    const seq = ++seqRef.current;
    targetRef.current = targetPage;
    setLoading(true);
    setError(null);
    try {
      const result = await checkoutApi.listPurchases(
        PAGE_SIZE,
        targetPage * PAGE_SIZE,
      );
      if (seq !== seqRef.current) return;
      setItems(result.items);
      setHasMore(result.has_more);
      setPage(targetPage);
      setSessionExpired(false);
    } catch (e) {
      if (seq !== seqRef.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setSessionExpired(true);
      } else {
        setError(
          getApiErrorMessage(
            e,
            'No pudimos cargar tu historial de compras. Intenta de nuevo.',
          ),
        );
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  const roleBlocked = !authLoading && user !== null && role !== 'customer';

  useEffect(() => {
    // Cambió la identidad (login, logout, otro rol): cualquier respuesta en
    // vuelo pertenece a un contexto anterior y ya no debe tocarse.
    seqRef.current += 1;
    setPassengersModalFor(null);
    if (authLoading) {
      setLoading(true);
      return;
    }
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
    setSessionExpired(false);
    void loadPage(0);
  }, [authLoading, customerId, role, loadPage]);

  // Botón "Subir": aparece cuando hay contenido por encima del viewport.
  useEffect(() => {
    const onScroll = () => {
      const next = window.scrollY > 400;
      setShowTop((prev) => (prev === next ? prev : next));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // El modal se cierra con Escape.
  useEffect(() => {
    if (!passengersModalFor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPassengersModalFor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [passengersModalFor]);

  const goNext = () => {
    if (loading || !hasMore) return;
    void loadPage(page + 1);
    // Al paginar siempre se vuelve al inicio: nunca dejar al usuario
    // abajo de la página con la lista nueva cargada.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goPrev = () => {
    if (loading || page === 0) return;
    void loadPage(page - 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const retry = () => {
    if (loading) return;
    void loadPage(targetRef.current);
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
  } else if (items === null) {
    view = 'loading';
  } else if (items.length === 0) {
    view = 'empty';
  } else {
    view = 'list';
  }

  const secondaryButton =
    'rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0] disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 sm:px-8 pt-24 pb-16">
      <div className="border-l-4 border-brand-cyan pl-3">
        <h1 className="text-[28px] font-extrabold">Mis compras</h1>
        <p className="mt-1 text-sm text-brand-muted">
          Historial de tus intentos de compra, comprobantes y reservas
          confirmadas.
        </p>
      </div>

      <div className="mt-8" aria-live="polite">
        {view === 'loading' && (
          <div role="status" className="grid gap-4">
            <span className="sr-only">Cargando tu historial de compras…</span>
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
              Inicia sesión de nuevo para ver tu historial de compras.
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
                Solo las cuentas de cliente pueden ver su historial de compras.
              </p>
              <p className="mt-1 text-xs text-brand-muted">
                Tu sesión actual no es una cuenta de cliente, así que este
                historial no le corresponde.
              </p>
            </div>
            <Link
              href={CATALOG_HREF}
              className="mt-4 inline-flex items-center gap-2 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
            >
              <Search size={16} strokeWidth={1.75} aria-hidden />
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
              No pudimos cargar tu historial de compras
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
              <Search size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              Aún no tienes compras
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              Cuando reserves un viaje, tu compra y su estado aparecerán aquí.
            </p>
            <Link
              href={CATALOG_HREF}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              <Search size={16} strokeWidth={1.75} aria-hidden />
              Explorar viajes
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
                const meta = estadoMeta(item.estado);
                // Orden natural (A1, A4, A10), sin importar el orden de selección.
                const asientos = sortSeatCodes(item.pasajeros.asientos).join(', ');
                const paymentStatus =
                  item.reserva?.payment_status != null
                    ? (PAGO_RESERVA_LABELS[item.reserva.payment_status] ??
                      item.reserva.payment_status)
                    : null;
                // El contador de envíos solo aporta contexto mientras el pago
                // está en revisión; fuera de ahí no se muestra.
                const comprobante = item.comprobante;
                const showEnvios =
                  item.estado === 'en_revision' && comprobante !== null;
                const showMotivo =
                  comprobante !== null &&
                  (item.estado === 'rechazado' ||
                    item.estado === 'rechazado_final') &&
                  comprobante.motivo_rechazo !== null;
                return (
                  <article
                    key={item.attempt_id}
                    className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${meta.className}`}
                      >
                        {meta.label}
                      </span>
                      <div className="text-right">
                        <p className="text-[11px] font-medium uppercase text-brand-muted">
                          Operación iniciada
                        </p>
                        <time
                          dateTime={item.created_at}
                          className="text-xs text-brand-muted"
                        >
                          {formatDateTimeShort(item.created_at)}
                        </time>
                      </div>
                    </div>

                    <h2 className="mt-4 text-[17px] font-semibold leading-snug">
                      {routeLabel(item.trip)}
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
                          ? formatDateTimeShort(item.trip.departure_time)
                          : 'Fecha de salida no disponible'}
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
                      <p className="flex items-center gap-2">
                        <Users
                          size={16}
                          strokeWidth={1.75}
                          className="shrink-0"
                          aria-hidden
                        />
                        {item.pasajeros.total} pasajero
                        {item.pasajeros.total === 1 ? '' : 's'}
                        {asientos ? ` · ${asientos}` : ''}
                      </p>
                      {item.pasajeros.detalle.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setPassengersModalFor(item)}
                          className="inline-flex items-center gap-1.5 rounded-[10px] bg-[#f1f5f9] px-3 py-1.5 text-xs font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
                        >
                          <Users size={16} strokeWidth={1.75} aria-hidden />
                          Ver pasajeros ({item.pasajeros.detalle.length})
                        </button>
                      )}
                    </div>

                    <p className="mt-4 text-sm text-brand-navy">
                      {item.mensaje}
                    </p>

                    {(showEnvios || showMotivo) && comprobante && (
                      <div className="mt-4 rounded-[10px] bg-[#f1f5f9] px-4 py-3 text-sm">
                        <p className="text-[11px] font-medium uppercase text-brand-muted">
                          Comprobante
                        </p>
                        {showEnvios && (
                          <>
                            <p className="mt-1 text-brand-navy">
                              {comprobante.envios} envío
                              {comprobante.envios === 1 ? '' : 's'} · quedan{' '}
                              {comprobante.restantes}
                            </p>
                            {comprobante.enviado_en && (
                              <p className="mt-1 text-xs text-brand-muted">
                                Enviado el{' '}
                                {formatDateTimeShort(comprobante.enviado_en)}
                              </p>
                            )}
                            {comprobante.referencia && (
                              <p className="text-xs text-brand-muted">
                                Referencia {comprobante.referencia}
                              </p>
                            )}
                          </>
                        )}
                        {showMotivo && (
                          <p className="mt-1 rounded-[10px] bg-[#fef2f2] px-3 py-2 text-xs font-medium text-[#ef4444]">
                            Motivo del rechazo:{' '}
                            {comprobante.motivo_rechazo}
                          </p>
                        )}
                      </div>
                    )}

                    {item.pago && (
                      <div className="mt-3 rounded-[10px] bg-[#f1f5f9] px-4 py-3 text-sm">
                        <p className="text-[11px] font-medium uppercase text-brand-muted">
                          Pago
                        </p>
                        <p className="mt-1 text-brand-navy">
                          {PAGO_ESTADO_LABELS[item.pago.estado] ??
                            `Pago ${item.pago.estado}`}{' '}
                          · {formatSeatPrice(item.pago.amount_cents)}
                        </p>
                        {item.pago.aprobado_en && (
                          <p className="text-xs text-brand-muted">
                            Aprobado el{' '}
                            {formatDateTimeShort(item.pago.aprobado_en)}
                          </p>
                        )}
                      </div>
                    )}

                    {item.reserva && (
                      <div className="mt-3 rounded-[10px] bg-[#ecfdf5] px-4 py-3 text-sm">
                        <p className="text-[11px] font-medium uppercase text-[#059669]">
                          Reserva
                        </p>
                        <p className="mt-1 flex items-center gap-2 font-semibold text-[#059669]">
                          <Ticket size={16} strokeWidth={1.75} aria-hidden />
                          {item.reserva.ticket_code
                            ? `Boleto ${item.reserva.ticket_code}`
                            : 'Reserva registrada'}
                        </p>
                        <p className="text-xs text-brand-muted">
                          Creada el{' '}
                          {formatDateTimeShort(item.reserva.created_at)}
                          {paymentStatus ? ` · pago ${paymentStatus}` : ''}
                        </p>

                        {esBoletoDisponible(item) && (
                          <Link
                            href={`${COMPRAS_PATH}/${item.attempt_id}/boleto`}
                            className="mt-3 inline-flex items-center gap-1.5 rounded-[10px] bg-brand-cyan px-4 py-2 text-xs font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                          >
                            <Ticket size={16} strokeWidth={1.75} aria-hidden />
                            Ver boleto
                          </Link>
                        )}
                      </div>
                    )}

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-[#f1f5f9] px-3 py-2">
                      <span className="text-[11px] font-medium uppercase text-brand-muted">
                        Importe total
                      </span>
                      <span className="text-[17px] font-extrabold leading-none text-brand-navy">
                        {formatSeatPrice(item.monto.amount_cents)}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>

            <nav
              aria-label="Paginación del historial"
              className="mt-6 flex items-center justify-between gap-3"
            >
              <button
                type="button"
                onClick={goPrev}
                disabled={loading || page === 0}
                className={secondaryButton}
              >
                Anterior
              </button>
              <span className="text-xs text-brand-muted" aria-current="page">
                Página {page + 1}
              </span>
              <button
                type="button"
                onClick={goNext}
                disabled={loading || !hasMore}
                className={secondaryButton}
              >
                Siguiente
              </button>
            </nav>
          </>
        )}
      </div>

      {passengersModalFor && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <button
            type="button"
            aria-label="Cerrar lista de pasajeros"
            tabIndex={-1}
            onClick={() => setPassengersModalFor(null)}
            className="absolute inset-0 h-full w-full cursor-default bg-brand-dark/40"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pasajeros-dialog-title"
            className="relative max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-brand-surface p-6 shadow-2xl sm:max-w-md sm:rounded-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2
                  id="pasajeros-dialog-title"
                  className="border-l-4 border-brand-cyan pl-3 text-lg font-bold"
                >
                  Pasajeros de la compra
                </h2>
                <p className="mt-1 text-xs text-brand-muted">
                  {routeLabel(passengersModalFor.trip)}
                  {passengersModalFor.trip.departure_time
                    ? ` · sale ${formatDateTimeShort(passengersModalFor.trip.departure_time)}`
                    : ''}
                </p>
              </div>
              <button
                autoFocus
                type="button"
                aria-label="Cerrar"
                onClick={() => setPassengersModalFor(null)}
                className="rounded-full p-2 text-brand-muted transition-colors duration-200 hover:bg-[#f1f5f9] hover:text-brand-navy"
              >
                <X size={18} strokeWidth={1.75} aria-hidden />
              </button>
            </div>

            <ul className="mt-4 space-y-2">
              {[...passengersModalFor.pasajeros.detalle]
                .sort((a, b) => compareSeatCodes(a.asiento, b.asiento))
                .map((passenger) => (
                <li
                  key={`${passenger.asiento}-${passenger.documento}`}
                  className="rounded-[10px] bg-[#f1f5f9] px-4 py-3 text-sm"
                >
                  <p className="font-semibold text-brand-navy">
                    {passenger.nombre}
                  </p>
                  <p className="mt-0.5 text-xs text-brand-muted">
                    C.I. {passenger.documento} · asiento {passenger.asiento}
                  </p>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() => setPassengersModalFor(null)}
              className="mt-6 w-full rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {showTop && (
        <button
          type="button"
          aria-label="Volver arriba"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-brand-cyan text-white shadow-lg transition-colors duration-200 hover:bg-brand-blue"
        >
          <ArrowUp size={20} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </main>
  );
}
