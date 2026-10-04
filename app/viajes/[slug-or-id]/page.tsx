"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  RefreshCw,
} from "lucide-react";
import {
  publicApi,
  type PublicTripDetail,
  type PublicTripOffer,
} from "@/lib/api";
import { ApiError, getApiErrorMessage } from "@/lib/errors/api-error";
import { formatDateTimeShort, formatTime12h } from "@/lib/timezone";
import { formatSeatPrice } from "@/lib/price";
import { BusLayout } from "@/components/bus/BusLayout";

interface TripDetailPageProps {
  params: Promise<{ "slug-or-id": string }>;
}

function vehicleLabel(vehicleType: string): string {
  if (vehicleType === "bus") return "Autobús";
  if (vehicleType === "kia") return "Kia";
  return vehicleType;
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase text-brand-muted">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-brand-navy">{value}</dd>
    </div>
  );
}

function OfferCard({
  offer,
  checked,
  onSelect,
}: {
  offer: PublicTripOffer;
  checked: boolean;
  onSelect: () => void;
}) {
  const accent = offer.accent_color ?? "#00D4FF";
  const primary = offer.primary_color ?? "#000024";
  const initial = offer.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className="flex items-center gap-3 rounded-2xl border-[1.5px] bg-white p-4 text-left transition-all duration-200 hover:-translate-y-0.5"
      style={{
        borderColor: checked ? accent : "#e5e7eb",
        boxShadow: checked
          ? "0 6px 24px rgba(0,0,0,0.08)"
          : "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      {offer.logo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={offer.logo_url}
          alt={`Logo de ${offer.name}`}
          className="h-10 w-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
          style={{ background: primary }}
          aria-hidden="true"
        >
          {initial}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-brand-navy">
          {offer.name}
        </span>
        <span className="block text-xs text-brand-muted">Oferta disponible</span>
      </span>
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
        style={{
          background: checked ? accent : "#f1f5f9",
        }}
        aria-hidden="true"
      >
        {checked && (
          <Check
            size={14}
            strokeWidth={2.5}
            className="text-white"
            aria-hidden="true"
          />
        )}
      </span>
    </button>
  );
}

export default function TripDetailPage({ params }: TripDetailPageProps) {
  const { "slug-or-id": slug } = use(params);

  const [trip, setTrip] = useState<PublicTripDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selectedOffer, setSelectedOffer] = useState<string | null>(null);
  const [selectedSeats, setSelectedSeats] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const response = await publicApi.tripDetail(slug);
      setTrip(response.trip);
      setSelectedOffer(response.trip.offers[0]?.agency_id ?? null);
      setSelectedSeats([]);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFound(true);
      } else {
        setError(
          getApiErrorMessage(
            e,
            "No pudimos cargar el viaje. Intenta de nuevo.",
          ),
        );
      }
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleSeat = (seatCode: string) => {
    if (!trip) return;
    const seat = trip.seats.find((s) => s.seat_code === seatCode);
    if (!seat || seat.status !== "available") return;
    setSelectedSeats((prev) =>
      prev.includes(seatCode)
        ? prev.filter((code) => code !== seatCode)
        : [...prev, seatCode],
    );
  };

  if (loading) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="animate-pulse" aria-hidden="true">
          <div className="h-4 w-44 rounded-full bg-black/[0.06]" />
          <div className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] sm:p-8">
            <div className="h-5 w-40 rounded-full bg-black/[0.06]" />
            <div className="mt-4 h-8 w-2/3 rounded bg-black/[0.06]" />
            <div className="mt-4 h-4 w-1/3 rounded bg-black/[0.06]" />
          </div>
          <div className="mt-8 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="h-5 w-52 rounded-full bg-black/[0.06]" />
            <div className="mt-6 flex justify-center">
              <div className="h-64 w-full max-w-[280px] rounded-2xl bg-black/[0.06]" />
            </div>
          </div>
        </div>
        <span className="sr-only">Cargando viaje…</span>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[#ef4444]">
            <AlertTriangle size={24} strokeWidth={1.75} aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-[24px] font-bold">Viaje no encontrado</h1>
          <p className="mt-2 max-w-md text-sm text-brand-muted">
            Este viaje no existe, ya no está activo o el enlace no es válido.
          </p>
          <Link
            href="/viajes"
            className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
          >
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            Ver viajes disponibles
          </Link>
        </div>
      </main>
    );
  }

  if (error || !trip) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
        <div className="flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[#ef4444]">
            <AlertTriangle size={24} strokeWidth={1.75} aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-[24px] font-bold">
            No pudimos cargar el viaje
          </h1>
          <p className="mt-2 max-w-md text-sm text-brand-muted">{error}</p>
          <button
            type="button"
            onClick={load}
            className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
          >
            <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
            Reintentar
          </button>
        </div>
      </main>
    );
  }

  const soldOut = trip.availability.available === 0;
  const hasPrice = trip.seat_price !== null;
  const offers = trip.offers;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-24 sm:px-8">
      <Link
        href="/viajes"
        className="inline-flex items-center gap-2 text-sm font-semibold text-brand-muted transition-colors duration-200 hover:text-brand-cyan"
      >
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        Volver a los viajes
      </Link>

      <section className="mt-6 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-[#f1f5f9] px-2.5 py-0.5 text-[11px] font-semibold text-brand-muted">
                {vehicleLabel(trip.vehicle_type)} · {trip.capacity} asientos
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                  soldOut
                    ? "bg-[#fef2f2] text-[#ef4444]"
                    : "bg-[#ecfdf5] text-[#059669]"
                }`}
              >
                {soldOut
                  ? "Sin disponibilidad"
                  : `${trip.availability.available} disponibles`}
              </span>
            </div>
            <h1 className="mt-4 text-[28px] font-extrabold leading-tight text-brand-navy">
              {trip.route.origin} → {trip.route.destination}
            </h1>
            <p className="mt-3 flex items-center gap-2 text-sm text-brand-muted">
              <CalendarDays
                size={16}
                strokeWidth={1.75}
                className="shrink-0"
                aria-hidden="true"
              />
              {formatDateTimeShort(trip.departure_time)}
            </p>
          </div>

          <div className="rounded-2xl bg-[#f1f5f9] p-4 sm:min-w-[220px]">
            <p className="text-[11px] font-medium uppercase text-brand-muted">
              Precio por asiento
            </p>
            {hasPrice ? (
              <>
                <p className="mt-1 text-[28px] font-extrabold leading-none text-brand-navy">
                  {formatSeatPrice(trip.seat_price as number)}
                </p>
                {trip.installment_allowed &&
                  trip.installment_amount_cents !== null && (
                    <p className="mt-2 text-xs text-brand-muted">
                      Abono desde{" "}
                      {formatSeatPrice(trip.installment_amount_cents)}
                    </p>
                  )}
              </>
            ) : (
              <p className="mt-2 text-sm font-semibold text-brand-muted">
                Precio no disponible
              </p>
            )}
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <InfoItem
            label="Salida"
            value={formatDateTimeShort(trip.departure_time)}
          />
          <InfoItem label="Hora" value={formatTime12h(trip.departure_time)} />
          <InfoItem
            label="Disponibles"
            value={`${trip.availability.available} de ${trip.capacity}`}
          />
          <InfoItem label="Vehículo" value={vehicleLabel(trip.vehicle_type)} />
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
          Elige tu agencia
        </h2>
        {offers.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-black/[0.06] bg-brand-surface p-4 text-sm text-brand-muted shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            Las agencias de este viaje estarán disponibles pronto. Puedes ver el
            mapa de asientos mientras tanto.
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-label="Ofertas de agencia"
            className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            {offers.map((offer) => (
              <OfferCard
                key={offer.agency_id}
                offer={offer}
                checked={selectedOffer === offer.agency_id}
                onSelect={() => setSelectedOffer(offer.agency_id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-8 rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="border-l-4 border-brand-cyan pl-3 text-[20px] font-bold text-brand-navy">
            Elige tus asientos
          </h2>
          <span className="rounded-full bg-[#f1f5f9] px-3 py-1 text-[11px] font-semibold text-brand-muted">
            {trip.availability.available} de {trip.capacity} disponibles
          </span>
        </div>

        {soldOut && (
          <div
            className="mt-4 flex items-start gap-3 rounded-[10px] bg-[#fef2f2] p-4 text-sm text-[#ef4444]"
            role="alert"
          >
            <AlertTriangle
              size={18}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              Este viaje ya no tiene asientos disponibles. Elige otra fecha o
              ruta desde el catálogo.
            </span>
          </div>
        )}

        <div className="mt-6">
          <BusLayout
            vehicleType={trip.vehicle_type}
            seats={trip.seats}
            selectedSeats={selectedSeats}
            onToggleSeat={toggleSeat}
          />
        </div>

        {selectedSeats.length > 0 && (
          <div
            className="mt-6 rounded-[10px] bg-[#fffbeb] p-4 text-sm text-[#92400e]"
            role="status"
          >
            <span className="font-semibold">
              {selectedSeats.length} asiento
              {selectedSeats.length === 1 ? "" : "s"} seleccionado
              {selectedSeats.length === 1 ? "" : "s"}
              :
            </span>{" "}
            {selectedSeats.join(", ")}
          </div>
        )}

        <p className="mt-4 text-center text-xs text-brand-muted">
          La selección se confirma en el siguiente paso, junto con tus datos de
          contacto.
        </p>
      </section>

      <div className="mt-8 flex flex-col items-center gap-2">
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="w-full cursor-not-allowed rounded-[10px] bg-brand-cyan px-8 py-3.5 text-sm font-semibold text-white opacity-40 transition-colors duration-200 sm:w-auto"
        >
          {soldOut ? "Sin asientos disponibles" : "Continuar con la reserva"}
        </button>
        <p className="text-xs text-brand-muted">
          {soldOut
            ? "Revisa el catálogo para encontrar otro viaje."
            : "Próximamente: confirmarás asientos, pasajeros y pago en un solo paso."}
        </p>
      </div>
    </main>
  );
}
