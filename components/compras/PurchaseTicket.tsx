'use client';

import { forwardRef, type CSSProperties } from 'react';
import { QRCode } from 'react-qr-code';
import { formatDateShort, formatTime12h } from '@/lib/timezone';
import { compareSeatCodes } from '@/lib/booking/seat-code';
import type { CheckoutTicketView } from '@/lib/api';
import {
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  MapPin,
} from 'lucide-react';

/** Montserrat solo donde Tour usa font-heading (h1–h5 ya la heredan del CSS). */
const HEADING_FONT: CSSProperties = { fontFamily: 'var(--font-heading)' };

interface PurchaseTicketProps {
  ticket: CheckoutTicketView;
  className?: string;
}

/**
 * Boleto de viaje del marketplace — port fiel de ReservationTicket de
 * nomadas-tour (app/agency/reservations/new + [id]) adaptado al DTO de
 * RT-03. El QR se renderiza con react-qr-code (mismo componente que Tour)
 * y codifica EXACTAMENTE reservations.qr_code; la descarga captura este
 * mismo nodo con html-to-image.
 */
export const PurchaseTicket = forwardRef<HTMLDivElement, PurchaseTicketProps>(
  function PurchaseTicket({ ticket, className }, ref) {
    const { trip } = ticket;
    const route =
      trip.origin && trip.destination
        ? `${trip.origin} → ${trip.destination}`
        : trip.destination ?? trip.origin ?? 'Ruta no disponible';
    const passengers = [...ticket.passengers].sort((a, b) =>
      compareSeatCodes(a.asiento, b.asiento),
    );

    return (
      <div
        ref={ref}
        data-testid="purchase-ticket"
        className={`overflow-hidden rounded-2xl border border-[rgba(0,0,0,0.06)] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] ${className ?? ''}`}
      >
        {/* Header */}
        <div className="flex items-center gap-3 bg-[var(--color-brand-navy)] px-5 py-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[rgba(0,212,255,0.15)]">
            <CheckCircle2 className="size-5 text-[var(--color-brand-cyan)]" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-bold text-white">Boleto de viaje</h3>
            <p className="text-[11px] text-white/60">
              Presenta este código QR al abordar
            </p>
          </div>
        </div>

        {/* QR Code — UN solo QR por reserva, valor exacto de Tour */}
        <div className="flex flex-col items-center px-5 py-6">
          <div className="rounded-2xl border-2 border-[rgba(0,212,255,0.15)] bg-white p-3 shadow-[0_2px_12px_rgba(0,212,255,0.06)]">
            <QRCode value={ticket.qr_code} size={150} />
          </div>
          <p
            data-testid="qr-value"
            className="mt-3 break-all text-center text-[12px] font-medium text-[var(--color-brand-navy)]"
            style={HEADING_FONT}
          >
            {ticket.qr_code}
          </p>
        </div>

        {/* Trip info */}
        <div className="px-5 pb-4">
          <div className="space-y-3 rounded-xl bg-[var(--color-page-bg)] p-4">
            <div className="flex items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[rgba(0,212,255,0.1)]">
                <MapPin
                  className="size-4 text-[var(--color-brand-cyan)]"
                  strokeWidth={1.75}
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-wider text-[var(--color-brand-muted)]">
                  Ruta
                </p>
                <p
                  className="truncate text-[13px] font-bold text-[var(--color-brand-navy)]"
                  style={HEADING_FONT}
                >
                  {route}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              {trip.departure_time && (
                <div className="flex items-center gap-2">
                  <Calendar
                    className="size-3.5 shrink-0 text-[var(--color-brand-cyan)]"
                    strokeWidth={1.75}
                  />
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-wider text-[var(--color-brand-muted)]">
                      Fecha
                    </p>
                    <p className="truncate text-[12px] font-medium text-[var(--color-brand-navy)]">
                      {formatDateShort(trip.departure_time)}
                    </p>
                  </div>
                </div>
              )}

              {trip.departure_time && (
                <div className="flex items-center gap-2">
                  <Clock
                    className="size-3.5 shrink-0 text-[var(--color-brand-cyan)]"
                    strokeWidth={1.75}
                  />
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-wider text-[var(--color-brand-muted)]">
                      Salida
                    </p>
                    <p className="text-[12px] font-medium text-[var(--color-brand-navy)]">
                      {formatTime12h(trip.departure_time)}
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Building2
                  className="size-3.5 shrink-0 text-[var(--color-brand-cyan)]"
                  strokeWidth={1.75}
                />
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--color-brand-muted)]">
                    Agencia
                  </p>
                  <p className="truncate text-[12px] font-medium text-[var(--color-brand-navy)]">
                    {ticket.agency.name ?? 'No disponible'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Passengers — sin datos personales além de nombre + asiento */}
        {passengers.length > 0 && (
          <div className="px-5 pb-4">
            <div className="rounded-xl bg-[var(--color-page-bg)] p-4">
              <p className="mb-3 text-[12px] font-semibold text-[var(--color-brand-navy)]">
                Pasajeros ({passengers.length})
              </p>
              <div className="space-y-2">
                {passengers.map((p) => (
                  <div
                    key={`${p.asiento}-${p.nombre}`}
                    data-testid="passenger-row"
                    className="flex items-center justify-between border-b border-[rgba(0,0,0,0.06)] py-1.5 last:border-0"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        data-testid="passenger-seat"
                        className="min-w-[34px] rounded-md bg-[rgba(0,212,255,0.1)] px-2 py-0.5 text-center text-[12px] font-bold text-[var(--color-brand-cyan)]"
                      >
                        {p.asiento}
                      </span>
                      <span className="truncate text-[12px] font-medium text-[var(--color-brand-navy)]">
                        {p.nombre || 'Sin nombre'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Footer — mismo código que Tour: primeros 8 chars del UUID */}
        <div className="border-t border-[rgba(0,0,0,0.06)] bg-[var(--color-page-bg)] px-5 py-3">
          <p className="text-center text-[10px] uppercase tracking-wider text-[var(--color-brand-muted)]">
            Código: {ticket.ticket_code}
          </p>
        </div>
      </div>
    );
  },
);
