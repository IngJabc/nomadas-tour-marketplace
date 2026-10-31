"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, RefreshCw, Search } from "lucide-react";
import { publicApi, type PublicTrip } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/errors/api-error";
import { isDepartureTimeInFuture } from "@/lib/timezone";
import { Reveal } from "@/components/ui/Reveal";
import { StateIcon } from "@/components/ui/StateIcon";
import { TarjetaViajeDestacado } from "./TarjetaViajeDestacado";

/** Máximo de viajes destacados del landing (LND-001). */
const MAX_DESTACADOS = 4;

/** Copy público de error: nunca exponer detalles técnicos internos. */
const COPY_ERROR =
  "No pudimos cargar los viajes en este momento. Intenta de nuevo.";

/**
 * Selección de presentación (LND-001): el backend ya devuelve únicamente
 * viajes `active` con salida futura ordenados por `departure_time`
 * ascendente (`GET /api/public/trips`); aquí se VERIFICA cada condición de
 * presentación (defensa en profundidad, sin duplicar la consulta), se
 * descarta lo no elegible y se toman los primeros 4. Si hay menos de cuatro,
 * se muestran los que haya. Nunca se completa con datos ficticios.
 *
 * Disponibilidad (LND-001.1): la ausencia de `available_seats` (null o
 * campo inexistente) se interpreta como 0 —agotado—; la capacidad total
 * (`capacity`) NUNCA sustituye la disponibilidad real, porque podría
 * presentar un viaje agotado como disponible.
 */
function seleccionarDestacados(trips: PublicTrip[]): PublicTrip[] {
  return trips
    .filter(
      (trip) =>
        trip.status === "active" &&
        isDepartureTimeInFuture(trip.departure_time) &&
        (trip.available_seats ?? 0) > 0,
    )
    .sort(
      (a, b) =>
        new Date(a.departure_time).getTime() - new Date(b.departure_time).getTime(),
    )
    .slice(0, MAX_DESTACADOS);
}

/**
 * Sección "Próximas salidas" del landing (Fase 5, iniciativa LND):
 * muestra los cuatro viajes elegibles más próximos desde el endpoint
 * público, con estados de carga, error y vacío, y CTA al catálogo.
 */
export function SeccionProximosViajes() {
  const [trips, setTrips] = useState<PublicTrip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Última secuencia de carga: descarta respuestas viejas (patrón /trips). */
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await publicApi.trips();
      if (seq !== seqRef.current) return;
      setTrips(seleccionarDestacados(response?.trips ?? []));
    } catch (e) {
      if (seq !== seqRef.current) return;
      // getApiErrorMessage jamás expone el mensaje de errores no-API:
      // se usa el copy público controlado.
      setError(getApiErrorMessage(e, COPY_ERROR));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const ctaCatalogo = (
    <Link
      href="/trips"
      className="group inline-flex items-center gap-1.5 text-sm font-semibold text-brand-cyan transition-colors duration-200 hover:text-brand-blue"
    >
      Explorar todos los viajes
      <ArrowRight
        size={16}
        strokeWidth={1.75}
        aria-hidden
        className="transition-transform duration-200 group-hover:translate-x-0.5"
      />
    </Link>
  );

  return (
    <section
      aria-labelledby="proximas-salidas-title"
      className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20"
    >
      <Reveal>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <h2
              id="proximas-salidas-title"
              className="border-l-4 border-brand-cyan pl-3 text-[24px] font-bold sm:text-[28px]"
            >
              Próximas salidas
            </h2>
            <p className="mt-4 pl-[19px] text-sm leading-relaxed text-brand-muted sm:text-base">
              Los próximos viajes con puestos disponibles, ordenados por fecha
              de salida.
            </p>
          </div>
          {ctaCatalogo}
        </div>
      </Reveal>

      {loading && (
        <div role="status" aria-busy="true" className="mt-10">
          <span className="sr-only">Cargando viajes…</span>
          <div
            aria-hidden
            className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
          >
            {Array.from({ length: MAX_DESTACADOS }, (_, index) => (
              <div
                key={index}
                className="animate-pulse overflow-hidden rounded-2xl border border-black/[0.06] bg-brand-surface shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
              >
                <div className="h-32 bg-black/[0.06]" />
                <div className="space-y-3 p-5">
                  <div className="h-4 w-1/3 rounded-full bg-black/[0.06]" />
                  <div className="h-5 w-3/4 rounded bg-black/[0.06]" />
                  <div className="h-4 w-1/2 rounded bg-black/[0.06]" />
                  <div className="h-4 w-2/3 rounded bg-black/[0.06]" />
                  <div className="h-14 rounded-[10px] bg-black/[0.06]" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && error && (
        <div
          role="alert"
          className="mt-10 flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-14 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
        >
          <StateIcon tone="error">
            <AlertTriangle size={24} strokeWidth={1.75} aria-hidden />
          </StateIcon>
          <h3 className="mt-4 text-lg font-semibold">
            No pudimos cargar los viajes
          </h3>
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

      {!loading && !error && trips.length === 0 && (
        <div className="mt-10 flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-14 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <StateIcon>
            <Search size={24} strokeWidth={1.75} aria-hidden />
          </StateIcon>
          <h3 className="mt-4 text-lg font-semibold">
            No hay viajes disponibles por ahora
          </h3>
          <p className="mt-2 max-w-md text-sm text-brand-muted">
            Estamos publicando nuevas salidas. Explora el catálogo completo
            para ver todas las rutas.
          </p>
          <Link
            href="/trips"
            className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
          >
            Explorar todos los viajes
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
          </Link>
        </div>
      )}

      {!loading && !error && trips.length > 0 && (
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {trips.map((trip, index) => (
            <Reveal key={trip.id} delay={index * 0.08} hoverLift className="h-full">
              <TarjetaViajeDestacado trip={trip} />
            </Reveal>
          ))}
        </div>
      )}
    </section>
  );
}
