"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { publicApi, type PublicTrip } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/errors/api-error";
import { formatDateTimeShort, isDepartureTimeInFuture, toBusinessDateString } from "@/lib/timezone";

interface Filters {
  origin: string;
  destination: string;
  date: string;
}

const EMPTY_FILTERS: Filters = { origin: "", destination: "", date: "" };

const SKELETON_KEYS = ["sk-1", "sk-2", "sk-3"];

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

function vehicleLabel(vehicleType: string): string {
  if (vehicleType === "bus") return "Autobús";
  if (vehicleType === "kia") return "Kia";
  return vehicleType;
}

export default function ViajesPage() {
  const [trips, setTrips] = useState<PublicTrip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await publicApi.trips();
      // Un viaje cuya salida ya pasó no es reservable: no se lista, aunque el
      // backend lo devuelva (defensa en profundidad).
      setTrips(
        response.trips.filter((trip) => isDepartureTimeInFuture(trip.departure_time)),
      );
    } catch (e) {
      setError(
        getApiErrorMessage(
          e,
          "No pudimos conectar con el catálogo. Intenta de nuevo.",
        ),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setApplied(filters);
  };

  const handleClear = () => {
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  };

  const hasActiveFilters =
    applied.origin.trim() !== "" ||
    applied.destination.trim() !== "" ||
    applied.date !== "";

  const visibleTrips = useMemo(
    () => trips.filter((trip) => tripMatches(trip, applied)),
    [trips, applied],
  );

  const inputClass =
    "w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm font-normal text-brand-navy outline-none transition-shadow placeholder:text-brand-muted focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)]";

  const labelClass = "mb-1.5 block text-xs font-medium uppercase text-brand-muted";

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-8 pt-24 pb-16">
      <div className="border-l-4 border-brand-cyan pl-3">
        <h1 className="text-[28px] font-extrabold">Viajes disponibles</h1>
        <p className="mt-1 text-sm text-brand-muted">
          Busca por origen, destino y fecha. El catálogo se conecta a la API pública.
        </p>
      </div>

      {/* Buscador */}
      <form
        onSubmit={handleSubmit}
        className="mt-8 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
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
            <label htmlFor="filter-date" className={labelClass}>
              Fecha
            </label>
            <input
              id="filter-date"
              type="date"
              value={filters.date}
              onChange={(e) => setFilters((f) => ({ ...f, date: e.target.value }))}
              className={inputClass}
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

      {/* Resultados */}
      <div className="mt-8" aria-live="polite">
        {loading && (
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {SKELETON_KEYS.map((key) => (
              <div
                key={key}
                className="animate-pulse rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="h-5 w-24 rounded-full bg-black/[0.06]" />
                  <div className="h-5 w-32 rounded-full bg-black/[0.06]" />
                </div>
                <div className="mt-4 h-5 w-3/4 rounded bg-black/[0.06]" />
                <div className="mt-4 h-4 w-1/2 rounded bg-black/[0.06]" />
                <div className="mt-2 h-4 w-2/5 rounded bg-black/[0.06]" />
                <div className="mt-6 h-10 w-full rounded-[10px] bg-black/[0.06]" />
              </div>
            ))}
          </div>
        )}

        {!loading && error && (
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
              onClick={load}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
              Reintentar
            </button>
          </div>
        )}

        {!loading && !error && visibleTrips.length === 0 && trips.length === 0 && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-cyan-bg)] text-brand-cyan">
              <span className="text-2xl font-extrabold">?</span>
            </div>
            <h2 className="mt-4 text-lg font-semibold">Aún no hay viajes publicados</h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              Estamos conectando el catálogo de agencias. Vuelve pronto o inicia sesión
              para recibir avisos de nuevas rutas.
            </p>
            <button
              type="button"
              onClick={load}
              className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
              Actualizar catálogo
            </button>
          </div>
        )}

        {!loading && !error && visibleTrips.length === 0 && trips.length > 0 && (
          <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-cyan-bg)] text-brand-cyan">
              <Search size={24} strokeWidth={1.75} aria-hidden />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              No hay viajes que coincidan con tu búsqueda
            </h2>
            <p className="mt-2 max-w-md text-sm text-brand-muted">
              Prueba con otro origen, destino o fecha.
            </p>
            <button
              type="button"
              onClick={handleClear}
              className="mt-6 rounded-[10px] bg-[#f1f5f9] px-6 py-3 text-sm font-semibold text-brand-navy transition-colors duration-200 hover:bg-[#e2e8f0]"
            >
              Limpiar filtros
            </button>
          </div>
        )}

        {!loading && !error && visibleTrips.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-brand-muted">
                {visibleTrips.length} viaje{visibleTrips.length === 1 ? "" : "s"}{" "}
                disponible{visibleTrips.length === 1 ? "" : "s"}
                {hasActiveFilters ? " con tus filtros" : ""}
              </p>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={handleClear}
                  className="text-xs font-semibold text-brand-blue transition-colors duration-200 hover:text-brand-cyan"
                >
                  Limpiar filtros
                </button>
              )}
            </div>

            <div className="mt-4 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
              {visibleTrips.map((trip) => (
                <article
                  key={trip.id}
                  className="flex flex-col rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_24px_rgba(0,212,255,0.12)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="rounded-full bg-[#ecfdf5] px-2.5 py-0.5 text-[11px] font-semibold text-[#059669]">
                      Disponible
                    </span>
                    <span className="rounded-full bg-[#f1f5f9] px-2.5 py-0.5 text-[11px] font-semibold text-brand-muted">
                      {vehicleLabel(trip.vehicle_type)} · {trip.capacity} asientos
                    </span>
                  </div>

                  <h2 className="mt-4 text-[17px] font-semibold leading-snug [font-family:var(--font-sans)]">
                    {trip.route.origin} → {trip.route.destination}
                  </h2>

                  <div className="mt-4 space-y-2 text-sm text-brand-muted">
                    <p className="flex items-center gap-2">
                      <CalendarDays
                        size={16}
                        strokeWidth={1.75}
                        className="shrink-0"
                        aria-hidden
                      />
                      {formatDateTimeShort(trip.departure_time)}
                    </p>
                    <p className="flex items-center gap-2">
                      <Users
                        size={16}
                        strokeWidth={1.75}
                        className="shrink-0"
                        aria-hidden
                      />
                      {trip.capacity} asientos disponibles
                    </p>
                  </div>

                  <div className="mt-auto pt-6">
                    <Link
                      href={`/reservas/nueva?trip=${trip.id}`}
                      className="block w-full rounded-[10px] bg-brand-cyan px-5 py-2.5 text-center text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
                    >
                      Reservar
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
