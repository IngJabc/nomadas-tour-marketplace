'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { subscribeToPurchaseHistory } from '@/lib/realtime/subscriptions';
import { formatSeatPrice } from '@/lib/price';
import { formatDateTimeShort, toBusinessDateString } from '@/lib/timezone';
import { useOptionalAuthUser } from '@/components/auth/AuthProvider';
import { DatePicker } from '@/components/ui/DatePicker';

/** Tarjetas visibles por pantalla del historial. */
const PAGE_SIZE = 5;

/**
 * El historial se trae COMPLETO para que los filtros busquen en todo él
 * (no solo en la pantalla visible): cada petición pide el máximo del
 * endpoint y se repite mientras el backend siga reportando `has_more`.
 * El tope (20 × 50 = 1000 compras) solo corta bucles con `has_more` roto.
 */
const FETCH_PAGE_SIZE = 50;
const MAX_FETCH_PAGES = 20;

/**
 * Espera tras un evento Realtime antes de re-consultar: colapsa ráfagas
 * (verify actualiza intento + reserva + pago en la misma transacción) en
 * UNA sola recarga del historial.
 */
const REFRESH_DEBOUNCE_MS = 500;

const LOGIN_PATH = '/login?redirect=%2Faccount%2Fpurchases';
const CATALOG_HREF = '/trips';
const COMPRAS_PATH = '/account/purchases';

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

/**
 * RT-05 · Reintento de pago: la acción SOLO existe para un comprobante
 * rechazado que el backend marcó como reenviable (ventana de envío abierta
 * + comprobantes restantes). Cualquier otro estado —incluso con el flag
 * encendido— queda fuera de la pantalla de pago, que además revalida
 * intento, ventana y bloqueos de asientos contra el backend.
 */
function esReintentoDisponible(item: PurchaseItemDto): boolean {
  return item.estado === 'rechazado' && item.puede_reenviar_comprobante;
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

/** Orden fijo de los chips de estado (mismo orden que el badge). */
const ESTADO_ORDER = Object.keys(ESTADO_META) as PurchaseEstado[];

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

// ── Filtros de búsqueda (en el cliente, sobre el historial completo) ──

interface PurchaseFilters {
  /** Texto libre: ruta, agencia, asiento, pasajero, boleto o referencia. */
  query: string;
  /** Estado derivado exacto; null = todas las compras. */
  estado: PurchaseEstado | null;
  /** Fecha de salida en la zona de negocio (YYYY-MM-DD), inclusivas. */
  desde: string;
  hasta: string;
}

const EMPTY_FILTERS: PurchaseFilters = {
  query: '',
  estado: null,
  desde: '',
  hasta: '',
};

function hayFiltrosActivos(filters: PurchaseFilters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.estado !== null ||
    filters.desde !== '' ||
    filters.hasta !== ''
  );
}

/** Minúsculas sin acentos: "merida" encuentra "Mérida". */
function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Todo lo que el texto libre debe poder encontrar dentro de una compra. */
function searchableText(item: PurchaseItemDto): string {
  return normalizeText(
    [
      item.trip.origin ?? '',
      item.trip.destination ?? '',
      item.agency.name ?? '',
      ...item.pasajeros.asientos,
      ...item.pasajeros.detalle.map((p) => p.nombre),
      ...item.pasajeros.detalle.map((p) => p.documento),
      item.reserva?.ticket_code ?? '',
      item.comprobante?.referencia ?? '',
      estadoMeta(item.estado).label,
    ].join(' '),
  );
}

/**
 * Aplica los tres filtros a la vez. El texto se contrae contra un índice
 * pre-normalizado (un Map por compra) para no re-normalizar todo el
 * historial en cada tecla.
 */
function filtrarCompras(
  items: PurchaseItemDto[],
  searchIndex: ReadonlyMap<string, string>,
  filters: PurchaseFilters,
): PurchaseItemDto[] {
  const query = normalizeText(filters.query).trim();
  return items.filter((item) => {
    if (filters.estado !== null && item.estado !== filters.estado) return false;
    if (filters.desde !== '' || filters.hasta !== '') {
      const dia =
        item.trip.departure_time !== null
          ? toBusinessDateString(item.trip.departure_time)
          : null;
      // Sin fecha de salida no puede satisfacer un filtro de fechas.
      if (dia === null) return false;
      if (filters.desde !== '' && dia < filters.desde) return false;
      if (filters.hasta !== '' && dia > filters.hasta) return false;
    }
    if (
      query !== '' &&
      !(searchIndex.get(item.attempt_id) ?? '').includes(query)
    ) {
      return false;
    }
    return true;
  });
}

/** Chip-pill de estado: cyan cuando está activo (es una acción, no adorno). */
function chipClass(active: boolean): string {
  return `rounded-full px-3 py-1.5 text-xs font-semibold transition-colors duration-200 ${
    active
      ? 'bg-brand-cyan text-white'
      : 'bg-[#f1f5f9] text-brand-navy hover:bg-[#e2e8f0]'
  }`;
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
  /** Página visible sobre el subconjunto FILTRADO (paginación local). */
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<PurchaseFilters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  /** Modal de pasajeros: el intento cuya lista está abierta (o null). */
  const [passengersModalFor, setPassengersModalFor] =
    useState<PurchaseItemDto | null>(null);
  const [showTop, setShowTop] = useState(false);

  /** Última secuencia iniciada: descarta respuestas viejas o de otra identidad. */
  const seqRef = useRef(0);
  /** Identidad anterior: distingue un cambio real de usuario de un flap de loading. */
  const prevCustomerIdRef = useRef<string | null>(null);

  /**
   * Trae el historial COMPLETO (páginas de 50 hasta agotar `has_more`) para
   * que la búsqueda y los filtros alcancen cualquier compra, no solo la
   * pantalla visible. Las respuestas se descartan por `seqRef` y, si algo
   * falla, nunca se limpia lo que el usuario ya ve: un refresco fallido
   * conserva la lista anterior y una primera carga parcial muestra al
   * menos lo que alcanzó a traerse.
   */
  const loadHistory = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    const collected: PurchaseItemDto[] = [];
    try {
      let offset = 0;
      for (let i = 0; i < MAX_FETCH_PAGES; i++) {
        const result = await checkoutApi.listPurchases(FETCH_PAGE_SIZE, offset);
        if (seq !== seqRef.current) return;
        collected.push(...result.items);
        if (!result.has_more || result.items.length === 0) break;
        offset += result.items.length;
      }
      setItems(collected);
      setSessionExpired(false);
    } catch (e) {
      if (seq !== seqRef.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setSessionExpired(true);
      } else {
        setItems((prev) => prev ?? (collected.length > 0 ? collected : null));
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

  /** Timer del refresco realtime (RT-04A): un solo disparo por ráfaga. */
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * RT-04A: cualquier evento Realtime de MIS compras (intento, reserva o
   * pago) re-consulta el historial completo tras el debounce. `loadHistory`
   * ya descarta respuestas viejas vía seqRef, mantiene la página visible
   * (se colapsa si el historial encoge) y no muestra skeleton con datos en
   * pantalla (items no nulos → vista lista). La autoridad del estado
   * derivada es el backend: nunca se interpreta la fila cruda del canal.
   */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void loadHistory();
    }, REFRESH_DEBOUNCE_MS);
  }, [loadHistory]);

  const roleBlocked = !authLoading && user !== null && role !== 'customer';

  useEffect(() => {
    // Solo el cliente autenticado ve sus compras; sin identidad propia no
    // hay nada que observar (la API ya responde 401 y la vista lo muestra).
    if (authLoading || !customerId || role !== 'customer') return undefined;
    const cleanup = subscribeToPurchaseHistory(customerId, scheduleRefresh);
    return () => {
      cleanup();
      // Nunca dejar un refresco programado vivo fuera de pantalla.
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [authLoading, customerId, role, scheduleRefresh]);

  useEffect(() => {
    // Cambió la identidad (login, logout, otro rol): cualquier respuesta en
    // vuelo pertenece a un contexto anterior y ya no debe tocarse.
    seqRef.current += 1;
    setPassengersModalFor(null);
    if (prevCustomerIdRef.current !== customerId) {
      // Otra persona usa esta pantalla: su búsqueda, filtros y página no
      // aplican a este historial.
      prevCustomerIdRef.current = customerId;
      setFilters(EMPTY_FILTERS);
      setPage(0);
    }
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
    void loadHistory();
  }, [authLoading, customerId, role, loadHistory]);

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

  /** Índice de texto por compra: filtra sin re-normalizar en cada tecla. */
  const searchIndex = useMemo(() => {
    const index = new Map<string, string>();
    for (const item of items ?? []) {
      index.set(item.attempt_id, searchableText(item));
    }
    return index;
  }, [items]);

  /** Contadores por estado para los chips (sobre todo el historial). */
  const estadoCounts = useMemo(() => {
    const counts = new Map<PurchaseEstado, number>();
    for (const item of items ?? []) {
      counts.set(item.estado, (counts.get(item.estado) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const filtered = useMemo(
    () => filtrarCompras(items ?? [], searchIndex, filters),
    [items, searchIndex, filters],
  );

  const filtrosActivos = hayFiltrosActivos(filters);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Si los filtros (o un refresco) encogen el subconjunto, la página nunca
  // queda fuera de rango: colapsa a la última válida sin tocar al usuario.
  const visiblePage = Math.min(page, pageCount - 1);
  const visibleItems = filtered.slice(
    visiblePage * PAGE_SIZE,
    (visiblePage + 1) * PAGE_SIZE,
  );

  const updateFilter = <K extends keyof PurchaseFilters>(
    key: K,
    value: PurchaseFilters[K],
  ) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    // Un filtro distinto siempre vuelve a la primera página.
    setPage(0);
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPage(0);
  };

  const goNext = () => {
    if (visiblePage >= pageCount - 1) return;
    setPage(visiblePage + 1);
    // Al paginar siempre se vuelve al inicio: nunca dejar al usuario
    // abajo de la página con la lista nueva cargada.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goPrev = () => {
    if (visiblePage === 0) return;
    setPage(visiblePage - 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const retry = () => {
    if (loading) return;
    void loadHistory();
  };

  let view:
    | 'loading'
    | 'session'
    | 'role'
    | 'error'
    | 'empty'
    | 'nofilter'
    | 'list';
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
  } else if (filtered.length === 0) {
    // Hay historial pero los filtros dejaron todo fuera: empty state de
    // FILTROS, siempre con CTA para volver al historial completo.
    view = 'nofilter';
  } else {
    view = 'list';
  }

  const secondaryButton =
    'rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0] disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 pt-24 pb-16">
      <div className="border-l-4 border-brand-cyan pl-3">
        <h1 className="text-[28px] font-extrabold">Mis compras</h1>
        <p className="mt-1 text-sm text-brand-muted">
          Historial de tus intentos de compra, comprobantes y reservas
          confirmadas.
        </p>
      </div>

      {items !== null && items.length > 0 && (
        <section
          aria-label="Filtros del historial"
          className="mt-8 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
        >
          <div className="border-l-4 border-brand-cyan pl-3">
            <h2 className="text-[17px] font-semibold">
              Buscar entre tus compras
            </h2>
            <p className="mt-0.5 text-xs text-brand-muted">
              Filtra por estado, ruta, pasajero o fecha de salida.
            </p>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <label
                htmlFor="purchase-search"
                className="block text-xs font-medium uppercase text-brand-muted"
              >
                Buscar
              </label>
              <div className="relative mt-2">
                <Search
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted"
                />
                <input
                  id="purchase-search"
                  type="search"
                  value={filters.query}
                  onChange={(event) => updateFilter('query', event.target.value)}
                  placeholder="Ruta, agencia, asiento, pasajero, boleto o referencia"
                  className="w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white py-3 pl-10 pr-4 text-sm text-brand-navy placeholder:text-brand-muted focus:border-brand-cyan focus:outline-none focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)]"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <DatePicker
                label="Salida desde"
                value={filters.desde}
                onChange={(value) => updateFilter('desde', value)}
                placeholder="Elige una fecha"
                className="w-full"
              />
              <DatePicker
                label="Salida hasta"
                value={filters.hasta}
                onChange={(value) => updateFilter('hasta', value)}
                placeholder="Elige una fecha"
                className="w-full"
              />
            </div>
          </div>

          <div className="mt-5">
            <span
              id="purchase-estado-label"
              className="block text-xs font-medium uppercase text-brand-muted"
            >
              Estado
            </span>
            <div
              role="group"
              aria-labelledby="purchase-estado-label"
              className="mt-2 flex flex-wrap gap-2"
            >
              <button
                type="button"
                aria-pressed={filters.estado === null}
                onClick={() => updateFilter('estado', null)}
                className={chipClass(filters.estado === null)}
              >
                Todas ({items.length})
              </button>
              {ESTADO_ORDER.filter(
                (estado) => (estadoCounts.get(estado) ?? 0) > 0,
              ).map((estado) => (
                <button
                  key={estado}
                  type="button"
                  aria-pressed={filters.estado === estado}
                  onClick={() => updateFilter('estado', estado)}
                  className={chipClass(filters.estado === estado)}
                >
                  {estadoMeta(estado).label} ({estadoCounts.get(estado)})
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[#f1f5f9] px-4 py-3">
            <p aria-live="polite" className="text-sm text-brand-muted">
              Mostrando {visibleItems.length} de {filtered.length} compra
              {filtered.length === 1 ? '' : 's'}
              {filtrosActivos && filtered.length !== items.length
                ? ` · ${items.length} en total`
                : ''}
            </p>
            {filtrosActivos && filtered.length > 0 && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1.5 rounded-[10px] bg-white px-4 py-2 text-xs font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
              >
                <X size={16} strokeWidth={1.75} aria-hidden />
                Limpiar filtros
              </button>
            )}
          </div>
        </section>
      )}

      <div className="mt-8" aria-live="polite">
        {view === 'loading' && (          <div role="status" className="grid gap-4">
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

        {view === 'nofilter' && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-cyan-bg)] text-brand-cyan">
              <Search size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              Ninguna compra coincide con tus filtros
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              Prueba con otro término o limpia los filtros para ver tu
              historial completo ({items?.length ?? 0} compras).
            </p>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              <X size={16} strokeWidth={1.75} aria-hidden />
              Limpiar filtros
            </button>
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
              {visibleItems.map((item) => {
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

                    {esReintentoDisponible(item) && (
                      <Link
                        href={`${COMPRAS_PATH}/${item.attempt_id}/payment`}
                        className="mt-4 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                      >
                        <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
                        Corregir pago y reintentar
                      </Link>
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
                            href={`${COMPRAS_PATH}/${item.attempt_id}/ticket`}
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
                disabled={visiblePage === 0}
                className={secondaryButton}
              >
                Anterior
              </button>
              <span className="text-xs text-brand-muted" aria-current="page">
                Página {visiblePage + 1}
              </span>
              <button
                type="button"
                onClick={goNext}
                disabled={visiblePage >= pageCount - 1}
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
