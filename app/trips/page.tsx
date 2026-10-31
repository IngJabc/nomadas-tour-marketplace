"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertTriangle,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { publicApi, type PublicTrip } from "@/lib/api";
import { motion } from "framer-motion";
import { DatePicker } from "@/components/ui/DatePicker";
import { getApiErrorMessage } from "@/lib/errors/api-error";
import { subscribeToTripCatalog } from "@/lib/realtime/subscriptions";
import { isDepartureTimeInFuture, toBusinessDateString, BUSINESS_TIMEZONE } from "@/lib/timezone";
import { TarjetaViaje } from "@/components/trips/TarjetaViaje";
import { StateIcon } from "@/components/ui/StateIcon";
import {
  FiltrosLateral,
  FILTROS_VIAJE_TODOS,
  type FiltrosViaje,
  type FranjaHoraria,
} from "@/components/trips/FiltrosLateral";
import { RailLateral } from "@/components/trips/RailLateral";
import { Reveal } from "@/components/ui/Reveal";

interface Filters {
  origin: string;
  destination: string;
  date: string;
}

const EMPTY_FILTERS: Filters = { origin: "", destination: "", date: "" };

const SKELETON_KEYS = ["sk-1", "sk-2", "sk-3"];

/** Espera tras un evento Realtime antes de re-consultar el catálogo (RT-04A). */
const REFRESH_DEBOUNCE_MS = 500;

function tripMatches(trip: PublicTrip, filters: Filters): boolean {
  const origin = filters.origin.trim().toLowerCase();
  const destination = filters.destination.trim().toLowerCase();
  if (origin && !trip.route.origin.toLowerCase().includes(origin)) return false;
  if (destination && !trip.route.destination.toLowerCase().includes(destination)) {
    return false;
  }
  if (filters.date && toBusinessDateString(trip.departure_time) !== filters.date) {
    return false;
  }
  return true;
}

/** Franja horario de salida en la zona de negocio (America/Caracas). */
function franjaDe(iso: string): FranjaHoraria {
  const hora = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIMEZONE,
      hour: "numeric",
      hour12: false,
    }).format(new Date(iso)),
  ) % 24;
  if (hora >= 12 && hora < 18) return "afternoon";
  if (hora >= 18) return "night";
  return "morning";
}

/**
 * Filtros laterales (horario, vehículo, agencia, precio). Listas vacías =
 * sin filtro; los viajes sin precio publicado nunca se descartan por precio.
 */
function viajePasaFiltros(trip: PublicTrip, f: FiltrosViaje): boolean {
  if (f.horarios.length > 0 && !f.horarios.includes(franjaDe(trip.departure_time))) {
    return false;
  }
  if (f.vehiculos.length > 0 && !f.vehiculos.includes(trip.vehicle_type)) {
    return false;
  }
  if (f.precioMax !== null && trip.seat_price !== null && trip.seat_price > f.precioMax) {
    return false;
  }
  if (f.agencias.length > 0) {
    const nombres = (trip.agencies ?? []).map((agency) => agency.name);
    if (!nombres.some((nombre) => f.agencias.includes(nombre))) return false;
  }
  return true;
}

/**
 * Filtros iniciales desde la query string (?origin=&destination=&date=)
 * que envía el buscador del landing. Fuera del navegador (SSR/tests) no
 * hay query string y se usan los filtros vacíos.
 */
function readFiltersFromUrl(): Filters {
  if (typeof window === "undefined") return EMPTY_FILTERS;
  const params = new URLSearchParams(window.location.search);
  return {
    origin: params.get("origin") ?? "",
    destination: params.get("destination") ?? "",
    date: params.get("date") ?? "",
  };
}

function readPaxFromUrl(): number | null {
  if (typeof window === "undefined") return null;
  const pax = Number(new URLSearchParams(window.location.search).get("pax"));
  return Number.isInteger(pax) && pax >= 1 && pax <= 5 ? pax : null;
}

export default function ViajesPage() {
  const [trips, setTrips] = useState<PublicTrip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [viajeFilters, setViajeFilters] = useState<FiltrosViaje>(FILTROS_VIAJE_TODOS);
  const [pax, setPax] = useState<number | null>(null);

  /** Última secuencia de carga: descarta respuestas viejas (RT-04A). */
  const seqRef = useRef(0);
  /** Timer del refresco realtime (RT-04A): un solo disparo por ráfaga. */
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Búsqueda pre-llenada desde el landing (?origin=&destination=&date=&pax=).
  // Se aplica en un efecto (no en el estado inicial) para no desincronizar
  // el hidratado SSR.
  useEffect(() => {
    const fromUrl = readFiltersFromUrl();
    if (fromUrl.origin || fromUrl.destination || fromUrl.date) {
      setFilters(fromUrl);
      setApplied(fromUrl);
    }
    setPax(readPaxFromUrl());
  }, []);

  /**
   * `silent` = refresco en segundo plano (RT-04A): no reemplaza la
   * rejilla por skeleton. Con datos ya cargados, un fallo de refresco se
   * muestra como banner inline (patrón del historial) en lugar de ocultar
   * los resultados ni silenciar el error.
   */
  const load = useCallback(async (options?: { silent?: boolean }) => {
    const seq = ++seqRef.current;
    const silent = options?.silent === true;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const response = await publicApi.trips();
      // Un viaje cuya salida ya pasó no es reservable: no se lista, aunque el
      // backend lo devuelva (defensa en profundidad).
      if (seq !== seqRef.current) return;
      setTrips(
        response.trips.filter((trip) => isDepartureTimeInFuture(trip.departure_time)),
      );
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(
        getApiErrorMessage(
          e,
          "No pudimos conectar con el catálogo. Intenta de nuevo.",
        ),
      );
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * RT-04A: cualquier evento Realtime del catálogo re-consulta la API en
   * segundo plano. Colapsa ráfagas en una sola petición; si el usuario ya
   * no está en la pantalla, el cleanup cancela el timer.
   */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void load({ silent: true });
    }, REFRESH_DEBOUNCE_MS);
  }, [load]);

  // Claves estables de los ids visibles: evitan re-suscribirse en cada
  // render y cambian solo cuando cambia el conjunto (nuevos viajes/agencias).
  const tripIdsKey = useMemo(
    () => trips.map((trip) => trip.id).sort().join(","),
    [trips],
  );
  const agencyIdsKey = useMemo(
    () =>
      [
        ...new Set(
          trips.flatMap((trip) => (trip.agencies ?? []).map((agency) => agency.id)),
        ),
      ]
        .sort()
        .join(","),
    [trips],
  );

  // Suscripción realtime del catálogo (RT-04A): trips sin filtro (viajes
  // nuevos y cancelaciones), trip_agencies/agencias acotadas a lo cargado.
  useEffect(() => {
    const tripIds = tripIdsKey ? tripIdsKey.split(",") : [];
    const agencyIds = agencyIdsKey ? agencyIdsKey.split(",") : [];
    const cleanup = subscribeToTripCatalog(tripIds, agencyIds, scheduleRefresh);
    return () => {
      cleanup();
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [tripIdsKey, agencyIdsKey, scheduleRefresh]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setApplied(filters);
  };

  const handleClear = () => {
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setViajeFilters(FILTROS_VIAJE_TODOS);
  };

  const hasActiveFilters =
    applied.origin.trim() !== "" ||
    applied.destination.trim() !== "" ||
    applied.date !== "" ||
    viajeFilters.horarios.length > 0 ||
    viajeFilters.vehiculos.length > 0 ||
    viajeFilters.agencias.length > 0 ||
    viajeFilters.precioMax !== null;

  const visibleTrips = useMemo(
    () =>
      trips.filter(
        (trip) => tripMatches(trip, applied) && viajePasaFiltros(trip, viajeFilters),
      ),
    [trips, applied, viajeFilters],
  );

  // Datos derivados para el sidebar de filtros: agencias únicas con su
  // conteo de viajes (se muestra en el label para desambiguar).
  const agenciasDisponibles = useMemo(() => {
    const conteo = new Map<string, number>();
    for (const trip of trips) {
      for (const agency of trip.agencies ?? []) {
        conteo.set(agency.name, (conteo.get(agency.name) ?? 0) + 1);
      }
    }
    return [...conteo.entries()]
      .map(([nombre, viajes]) => ({ nombre, viajes }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [trips]);
  const precioDisponible = useMemo(() => {
    const precios = trips
      .map((trip) => trip.seat_price)
      .filter((price): price is number => typeof price === "number");
    return precios.length > 0 ? Math.max(...precios) : null;
  }, [trips]);

  const inputClass =
    "w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm font-normal text-brand-navy outline-none transition-shadow placeholder:text-brand-muted focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(212,98,43,0.15)]";

  const labelClass = "mb-1.5 block text-xs font-medium uppercase text-brand-muted";

  const showSidebar = !loading && trips.length > 0;

  return (
    <main id="main" className="flex-1 pb-16">
      {/* Búsqueda arriba (banda NO sticky: nada tapa el contenido al scroll) */}
      <section className="border-b border-black/[0.06] bg-brand-surface">
        <div className="mx-auto max-w-7xl px-4 pt-24 pb-6 sm:px-6">
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="border-l-4 border-brand-cyan pl-3"
          >
            <h1 className="text-[28px] font-bold">Viajes disponibles</h1>
            <p className="mt-1 text-sm text-brand-muted">
              Busca por origen, destino y fecha.
            </p>
          </motion.div>

          <form
            onSubmit={handleSubmit}
            aria-label="Buscar viajes"
            className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
              <div>
                <label htmlFor="filter-origin" className={labelClass}>
                  Origen
                </label>
                <input
                  id="filter-origin"
                  type="text"
                  value={filters.origin}
                  onChange={(e) => setFilters((f) => ({ ...f, origin: e.target.value }))}
                  placeholder="Ej. Barquisimeto"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="filter-destination" className={labelClass}>
                  Destino
                </label>
                <input
                  id="filter-destination"
                  type="text"
                  value={filters.destination}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, destination: e.target.value }))
                  }
                  placeholder="Ej. Caracas"
                  className={inputClass}
                />
              </div>
              <div>
                <DatePicker
                  label="Fecha"
                  value={filters.date}
                  onChange={(date) => setFilters((f) => ({ ...f, date }))}
                  placeholder="Elige una fecha"
                  className="w-full"
                />
              </div>
              <button
                type="submit"
                className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[10px] bg-brand-cyan px-5 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue sm:w-auto"
              >
                <Search size={16} strokeWidth={1.75} aria-hidden />
                Buscar
              </button>
            </div>
          </form>
        </div>
      </section>

      <div
        className={`mx-auto grid max-w-7xl items-start gap-8 px-4 pt-8 sm:px-6 ${
          showSidebar
            ? "lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_300px]"
            : ""
        }`}
        aria-live="polite"
      >
        {/* Filtros de refinación en el sidebar (como el mockup) */}
        {showSidebar && (
          <Reveal className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-96px)] lg:overflow-y-auto lg:pb-2">
            <FiltrosLateral
              value={viajeFilters}
              onChange={setViajeFilters}
              agencias={agenciasDisponibles}
              precioDisponible={precioDisponible}
            />
          </Reveal>
        )}

        {/* Resultados */}
        <div>
          {loading && (
            <div className="grid gap-8 sm:grid-cols-2">
              {SKELETON_KEYS.map((key) => (
                <div
                  key={key}
                  className="animate-pulse rounded-2xl border border-black/[0.06] bg-brand-surface p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)] sm:p-6"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="h-5 w-20 rounded-full bg-black/[0.06] sm:w-24" />
                    <div className="h-5 w-24 rounded-full bg-black/[0.06] sm:w-32" />
                  </div>
                  <div className="mt-4 h-5 w-3/4 rounded bg-black/[0.06]" />
                  <div className="mt-4 h-4 w-1/2 rounded bg-black/[0.06]" />
                  <div className="mt-2 h-4 w-2/5 rounded bg-black/[0.06]" />
                  <div className="mt-6 h-10 w-full rounded-[10px] bg-black/[0.06]" />
                </div>
              ))}
            </div>
          )}

          {!loading && error && trips.length === 0 && (
            <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[#ef4444]">
                <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
              </div>
              <h2 className="mt-4 text-lg font-semibold">
                No pudimos cargar los viajes
              </h2>
              <p className="mt-2 max-w-md text-sm text-brand-muted">{error}</p>
              <button
                type="button"
                onClick={() => load()}
                className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
              >
                <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
                Reintentar
              </button>
            </div>
          )}

          {/* Refresco realtime fallido con datos ya cargados (RT-04A): el
              fallo queda visible sin ocultar el catálogo. */}
          {!loading && error && trips.length > 0 && (
            <div
              role="alert"
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[#fef2f2] px-4 py-3"
            >
              <p className="text-sm font-semibold text-[#ef4444]">{error}</p>
              <button
                type="button"
                onClick={() => load()}
                disabled={loading}
                className="inline-flex items-center gap-2 rounded-[10px] bg-white px-4 py-2 text-xs font-semibold text-[#ef4444] transition-colors duration-200 hover:bg-[#fee2e2] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
                Reintentar
              </button>
            </div>
          )}

          {!loading && !error && visibleTrips.length === 0 && trips.length === 0 && (
            <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <StateIcon>
                <span className="text-2xl font-extrabold">?</span>
              </StateIcon>
              <h2 className="mt-4 text-lg font-semibold">Aún no hay viajes publicados</h2>
              <p className="mt-2 max-w-md text-sm text-brand-muted">
                Estamos conectando el catálogo de agencias. Vuelve pronto o inicia sesión
                para recibir avisos de nuevas rutas.
              </p>
              <button
                type="button"
                onClick={() => load()}
                className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
              >
                <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
                Actualizar catálogo
              </button>
            </div>
          )}

          {!loading && !error && visibleTrips.length === 0 && trips.length > 0 && (
            <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <StateIcon>
                <Search size={24} strokeWidth={1.75} aria-hidden />
              </StateIcon>
              <h2 className="mt-4 text-lg font-semibold">
                No hay viajes que coincidan con tu búsqueda
              </h2>
              <p className="mt-2 max-w-md text-sm text-brand-muted">
                Prueba con otro origen, destino o fecha.
              </p>
              <button
                type="button"
                onClick={handleClear}
                className="mt-6 rounded-[10px] bg-[#F5F1EC] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#ece5db]"
              >
                Limpiar filtros
              </button>
            </div>
          )}

          {!loading && visibleTrips.length > 0 && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-brand-muted">
                  {visibleTrips.length} viaje{visibleTrips.length === 1 ? "" : "s"}{" "}
                  disponible{visibleTrips.length === 1 ? "" : "s"}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  {pax !== null && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-cyan-bg)] px-3 py-1 text-[11px] font-semibold text-brand-cyan">
                      <Users size={12} strokeWidth={2} aria-hidden />
                      {pax} pasajero{pax === 1 ? "" : "s"}
                    </span>
                  )}
                  {hasActiveFilters && (
                    <button
                      type="button"
                      onClick={handleClear}
                      className="text-xs font-semibold text-brand-cyan transition-colors duration-200 hover:text-brand-blue"
                    >
                      Limpiar filtros
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-4 grid gap-8 sm:grid-cols-2">
                {visibleTrips.map((trip, index) => (
                  <TarjetaViaje key={trip.id} trip={trip} index={index} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Rail lateral derecho: solo cuando existe la 3ª columna (xl) */}
        {showSidebar && (
          <div className="hidden xl:block xl:sticky xl:top-24">
            <RailLateral />
          </div>
        )}
      </div>
    </main>
  );
}
