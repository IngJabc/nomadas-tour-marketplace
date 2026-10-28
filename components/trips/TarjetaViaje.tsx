"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  Users,
} from "lucide-react";
import type { PublicTrip } from "@/lib/api";
import { formatSeatPrice, TRIP_PRICE_PENDING_LABEL } from "@/lib/price";
import { formatDateTimeShort } from "@/lib/timezone";
import { PillBadge } from "@/components/ui/PillBadge";

function vehicleLabel(vehicleType: string): string {
  if (vehicleType === "bus") return "Autobús";
  if (vehicleType === "kia") return "Kia";
  return vehicleType;
}

interface TarjetaViajeProps {
  trip: PublicTrip;
  /** Posición en la lista: usada para escalonar la entrada de las tarjetas. */
  index?: number;
}

/**
 * Tarjeta de viaje del catálogo. Mantiene los textos y el contrato de
 * accesibilidad (CTA exacto "Reservar") que cubren los tests MKT-002.
 */
export function TarjetaViaje({ trip, index = 0 }: TarjetaViajeProps) {
  const agencies = trip.agencies ?? [];

  return (
    <motion.article
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.35,
        delay: Math.min(index * 0.06, 0.3),
        ease: "easeOut",
      }}
      whileHover={{ y: -4 }}
      className="flex flex-col rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow duration-200 hover:shadow-[0_6px_24px_rgba(212,98,43,0.12)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PillBadge className="rounded-full bg-[#ecfdf5] px-2.5 py-0.5 text-[11px] font-semibold text-[#059669]">
          Disponible
        </PillBadge>
        <PillBadge className="rounded-full bg-[#F5F1EC] px-2.5 py-0.5 text-[11px] font-semibold text-brand-muted">
          {vehicleLabel(trip.vehicle_type)} · {trip.capacity} asientos
        </PillBadge>
      </div>

      <h2 className="mt-4 text-[19px] font-bold leading-snug [font-family:var(--font-heading)]">
        {trip.route.origin} → {trip.route.destination}
      </h2>

      {/* Salida destacada */}
      <p className="mt-3 flex items-center gap-2 text-[15px] font-semibold text-brand-navy">
        <CalendarDays
          size={18}
          strokeWidth={1.75}
          className="shrink-0 text-brand-cyan"
          aria-hidden
        />
        {formatDateTimeShort(trip.departure_time)}
      </p>

      <div className="mt-4 space-y-2 text-sm text-brand-muted">
        {agencies.length > 0 ? (
          <p className="flex items-center gap-2">
            <Building2 size={16} strokeWidth={1.75} className="shrink-0" aria-hidden />
            <span className="font-medium text-brand-navy">{agencies[0].name}</span>
            {agencies.length > 1 && (
              <>
                <span className="rounded-full bg-[#F5F1EC] px-2.5 py-0.5 text-[11px] font-semibold text-brand-muted">
                  +{agencies.length - 1}
                </span>
                <span className="sr-only">
                  Agencias disponibles: {agencies.map((agency) => agency.name).join(", ")}
                </span>
              </>
            )}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-[#92400e]">
            <AlertTriangle size={16} strokeWidth={1.75} className="shrink-0" aria-hidden />
            <span>Sin agencias disponibles para reservar</span>
          </p>
        )}
        <p className="flex items-center gap-2">
          <Users size={16} strokeWidth={1.75} className="shrink-0" aria-hidden />
          {/* Disponibilidad REAL (status='available'), con fallback a la
              capacidad para respuestas antiguas sin el campo. */}
          {trip.available_seats ?? trip.capacity} asientos disponibles
        </p>
      </div>

      {/* Precio + acción */}
      <div className="mt-auto pt-6">
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
              <span className="mt-0.5 block text-[22px] font-extrabold leading-none text-brand-navy">
                {formatSeatPrice(trip.seat_price)}
              </span>
            )}
          </div>
        </div>

        <div className="mt-4">
          {trip.seat_price === null || agencies.length === 0 ? (
            // Sin precio publicado o sin agencias activas no hay reserva
            // posible: el CTA queda deshabilitado en lugar de enviar al
            // checkout.
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="block w-full cursor-not-allowed rounded-[10px] bg-brand-cyan px-5 py-3 text-center text-sm font-semibold text-white opacity-40"
            >
              Reservar
            </button>
          ) : (
            <motion.span
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="block"
            >
              <Link
                // El selector de agencias vive DENTRO del checkout
                // (/reservations/new?trip=): el catálogo nunca deriva a
                // /trips/[id] para elegir agencia.
                href={`/reservations/new?trip=${trip.id}`}
                className="block w-full rounded-[10px] bg-brand-cyan px-5 py-3 text-center text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
              >
                Reservar
              </Link>
            </motion.span>
          )}
        </div>
      </div>
    </motion.article>
  );
}
