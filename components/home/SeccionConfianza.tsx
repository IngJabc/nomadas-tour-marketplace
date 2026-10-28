import { BadgeCheck, Ticket, ShieldCheck, Timer } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

const BENEFITS = [
  {
    icono: BadgeCheck,
    titulo: "Agencias verificadas",
    texto: "Cada agencia opera con su flota real y sus horarios publicados.",
  },
  {
    icono: Timer,
    titulo: "Confirmación rápida",
    texto: "Reserva en minutos: eliges asientos y envías tu comprobante.",
  },
  {
    icono: Ticket,
    titulo: "Boleto con QR",
    texto: "Al confirmar tu pago recibes un boleto digital con código QR.",
  },
  {
    icono: ShieldCheck,
    titulo: "Pago trazable",
    texto: "Guardamos tu comprobante para acompañarte ante cualquier incidencia.",
  },
] as const;

/** Sección de confianza del landing: cuatro compromisos con icono. */
export function SeccionConfianza() {
  return (
    <section className="border-y border-black/[0.06] bg-brand-surface">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:py-16">
        {BENEFITS.map(({ icono: Icono, titulo, texto }, index) => (
          <Reveal key={titulo} delay={index * 0.08}>
            <div className="flex gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-cyan-bg)] text-brand-cyan">
                <Icono size={20} strokeWidth={1.75} aria-hidden />
              </span>
              <div>
                <h3 className="text-[15px] font-semibold">{titulo}</h3>
                <p className="mt-1 text-sm leading-relaxed text-brand-muted">
                  {texto}
                </p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
