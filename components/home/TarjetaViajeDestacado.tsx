import Link from "next/link";
import {
  AlertTriangle,
  Bus,
  Building2,
  CalendarDays,
  Users,
} from "lucide-react";
import type { PublicTrip } from "@/lib/api";
import { formatSeatPrice, TRIP_PRICE_PENDING_LABEL } from "@/lib/price";
import { formatDateTimeShort } from "@/lib/timezone";
import { PillBadge } from "@/components/ui/PillBadge";

interface TarjetaViajeDestacadoProps {
  trip: PublicTrip;
}

/**
 * Tarjeta de viaje destacado del landing (LND-003).
 *
 * Usa EXCLUSIVAMENTE campos del contrato `GET /api/public/trips` (ruta,
 * salida, precio por puesto, disponibilidad real y agencias activas). El
 * área superior con gradiente es el placeholder de la futura imagen del
 * viaje/ruta y el comentario marca el slot reservado para la descripción
 * comercial: no se inventan datos que el endpoint no devuelve (LND).
 *
 * El CTA "Reservar" sigue el contrato del catálogo (AGENTS): siempre
 * enlaza a `/reservations/new?trip=<id>`; sin precio publicado o sin
 * agencias activas queda deshabilitado, igual que `TarjetaViaje`.
 */
export function TarjetaViajeDestacado({ trip }: TarjetaViajeDestacadoProps) {
  const agencies = trip.agencies ?? [];
  // Disponibilidad REAL (status='available') con fallback documentado a la
  // capacidad para respuestas antiguas sin el campo (ver lib/api.ts).
  const available = trip.available_seats ?? trip.capacity;
  const reservable = trip.seat_price !== null && agencies.length > 0;

  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-black/[0.06] bg-brand-surface shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow duration-200 hover:shadow-[0_6px_24px_rgba(212,98,43,0.12)]">
      {/* SLOT IMAGEN (futuro): placeholder visual coherente con la marca —
          gradiente + motivo de ruta. Sin fotos externas ni inventadas. */}
      <div
        aria-hidden
        className="relative flex h-32 items-center justify-center bg-gradient-to-br from-[#2A2F3A] via-[#1F232F] to-[#B84E1F]"
      >
        <svg
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-8 w-full opacity-40"
          viewBox="0 0 300 40"
          fill="none"
          preserveAspectRatio="none"
        >
          <path
            d="M0 32 C 80 20, 160 36, 300 12"
            stroke="rgba(255,255,255,0.7)"
            strokeWidth="2"
            strokeDasharray="4 8"
          />
        </svg>
        <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-white/10">
          <Bus size={24} strokeWidth={1.75} className="text-white/90" />
        </span>
      </div>

      <div className="flex flex-1 flex-col p-5">
        <div className="flex flex-wrap items-center gap-2">
          <PillBadge className="rounded-full bg-[#ecfdf5] px-2.5 py-0.5 text-[11px] font-semibold text-[#059669]">
            Disponible
          </PillBadge>
          <PillBadge className="rounded-full bg-[#F5F1EC] px-2.5 py-0.5 text-[11px] font-semibold text-brand-muted">
            {available} asientos
          </PillBadge>
        </div>

        <h3 className="mt-3 text-[17px] font-bold leading-snug [font-family:var(--font-heading)]">
          {trip.route.origin} → {trip.route.destination}
        </h3>

        {/* SLOT DESCRIPCIÓN (futuro): descripción comercial del viaje cuando
            el endpoint la exponga. Mientras no exista el campo, no se
            muestra texto inventado. */}

        <p className="mt-2.5 flex items-center gap-2 text-sm font-semibold text-brand-navy">
          <CalendarDays
            size={16}
            strokeWidth={1.75}
            className="shrink-0 text-brand-cyan"
            aria-hidden
          />
          {formatDateTimeShort(trip.departure_time)}
        </p>

        <div className="mt-3 space-y-2 text-sm text-brand-muted">
          {agencies.length > 0 ? (
            <p className="flex items-center gap-2">
              <Building2
                size={16}
                strokeWidth={1.75}
                className="shrink-0"
                aria-hidden
              />
              <span className="font-medium text-brand-navy">
                {agencies[0].name}
              </span>
              {agencies.length > 1 && (
                <>
                  <PillBadge className="rounded-full bg-[#F5F1EC] px-2.5 py-0.5 text-[11px] font-semibold text-brand-muted">
                    +{agencies.length - 1}
                  </PillBadge>
                  <span className="sr-only">
                    Agencias disponibles:{" "}
                    {agencies.map((agency) => agency.name).join(", ")}
                  </span>
                </>
              )}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-[#92400e]">
              <AlertTriangle
                size={16}
                strokeWidth={1.75}
                className="shrink-0"
                aria-hidden
              />
              <span>Sin agencias disponibles para reservar</span>
            </p>
          )}
          <p className="flex items-center gap-2">
            <Users size={16} strokeWidth={1.75} className="shrink-0" aria-hidden />
            {available} asientos disponibles
          </p>
        </div>

        {/* Precio + acción */}
        <div className="mt-auto pt-5">
          <div className="flex items-end justify-between gap-3 rounded-[10px] bg-[#F5F1EC] px-4 py-3">
            <div>
              <span className="block text-[11px] font-medium uppercase text-brand-muted">
                Precio por asiento
              </span>
              {trip.seat_price === null ? (
                <span className="text-sm font-semibold text-brand-muted">
                  {TRIP_PRICE_PENDING_LABEL}
                </span>
              ) : (
                <span className="mt-0.5 block text-[20px] font-extrabold leading-none text-brand-navy">
                  {formatSeatPrice(trip.seat_price)}
                </span>
              )}
            </div>
          </div>

          <div className="mt-4">
            {!reservable ? (
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="block w-full cursor-not-allowed rounded-[10px] bg-brand-cyan px-5 py-2.5 text-center text-sm font-semibold text-white opacity-40"
              >
                Reservar
              </button>
            ) : (
              <Link
                href={`/reservations/new?trip=${trip.id}`}
                className="block w-full rounded-[10px] bg-brand-cyan px-5 py-2.5 text-center text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
              >
                Reservar
              </Link>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
