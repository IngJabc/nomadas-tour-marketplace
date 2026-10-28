import { BadgeCheck, Clock, ShieldCheck } from "lucide-react";

/**
 * Barra lateral derecha del catálogo: contexto de confianza y del
 * bloqueo temporal de asientos. Estático (contenido editorial).
 */
export function RailLateral() {
  return (
    <aside aria-label="Información para reservar" className="flex flex-col gap-6">
      <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold">
          <ShieldCheck size={18} strokeWidth={1.75} className="text-[#176B62]" aria-hidden />
          Reserva con claridad
        </h2>
        <ul className="mt-4 space-y-4 text-sm text-brand-muted">
          <li className="flex gap-3">
            <BadgeCheck size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[#176B62]" aria-hidden />
            <span>Agencias verificadas con flota y horarios reales.</span>
          </li>
          <li className="flex gap-3">
            <ShieldCheck size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[#176B62]" aria-hidden />
            <span>Pago trazable: guardamos tu comprobante para acompañarte.</span>
          </li>
          <li className="flex gap-3">
            <BadgeCheck size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[#176B62]" aria-hidden />
            <span>Boleto con QR al confirmar tu pago.</span>
          </li>
        </ul>
      </div>

      <div className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold">
          <Clock size={18} strokeWidth={1.75} className="text-brand-cyan" aria-hidden />
          Asientos en tiempo real
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-brand-muted">
          Cuando eliges tus asientos se bloquean temporalmente mientras
          completas la reserva. Si un viaje está disponible hoy, respáldalos
          hoy: el catálogo se actualiza en vivo.
        </p>
      </div>
    </aside>
  );
}
