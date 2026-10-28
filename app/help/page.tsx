import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, ChevronDown, MessageCircle, Ticket } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

export const metadata: Metadata = {
  title: "Ayuda | Nómadas Marketplace",
  description:
    "Preguntas frecuentes sobre reservas, pagos, boletos y contacto en Nómadas Marketplace",
  icons: {
    icon: "/brand/logo-icon.svg",
  },
};

const FAQ = [
  {
    pregunta: "¿Cómo reservo un viaje?",
    respuesta:
      "Busca tu ruta y fecha en Explorar, elige un viaje disponible y pulsa Reservar. En el checkout seleccionas tus asientos en el mapa del vehículo, completas los datos de los pasajeros y continúas al pago.",
  },
  {
    pregunta: "¿Cómo pago?",
    respuesta:
      "Cada agencia define sus canales de pago. Al continuar al pago ves los métodos disponibles de la agencia y envías tu comprobante desde la misma pantalla; la agencia lo verifica y tu reserva queda confirmada.",
  },
  {
    pregunta: "¿Cuándo recibo mi boleto?",
    respuesta:
      "En cuanto la agencia verifica tu comprobante. El boleto con código QR queda disponible en Mis reservas, junto al estado y el detalle de tu compra.",
  },
  {
    pregunta: "¿Por qué mis asientos se bloquean temporalmente?",
    respuesta:
      "Para que nadie más los tome mientras completas tu reserva. Verás una cuenta regresiva con el tiempo restante; si se vence, los asientos se liberan y puedes empezar de nuevo.",
  },
  {
    pregunta: "¿Puedo cancelar una compra en curso?",
    respuesta:
      "Sí. Mientras la compra está activa en el checkout encuentras el botón Cancelar compra, que libera tus asientos. Una vez enviada la compra, el seguimiento y las opciones disponibles viven en Mis reservas.",
  },
  {
    pregunta: "¿Necesito crear una cuenta?",
    respuesta:
      "Sí. La cuenta permite pagar, guardar tus boletos y consultar tu historial. Crear cuenta o iniciar sesión toma un minuto desde la barra superior.",
  },
] as const;

export default function HelpPage() {
  return (
    <main id="main" className="flex-1">
      {/* Encabezado */}
      <section className="border-b border-black/[0.06] bg-brand-surface">
        <div className="mx-auto max-w-7xl px-4 pt-24 pb-12 sm:px-6">
          <div className="border-l-4 border-brand-cyan pl-3">
            <h1 className="text-[28px] font-bold">¿En qué podemos ayudarte?</h1>
            <p className="mt-2 text-sm leading-relaxed text-brand-muted sm:text-base">
              Respuestas rápidas a lo que más se pregunta sobre reservas,
              pagos y boletos.
            </p>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 pb-16 pt-12 sm:px-6 sm:pt-16">
        {/* Preguntas frecuentes */}
        <section aria-labelledby="faq-title">
          <h2 id="faq-title" className="border-l-4 border-brand-cyan pl-3 text-[22px] font-bold">
            Preguntas frecuentes
          </h2>

          <div className="mt-6 space-y-4">
            {FAQ.map((item, index) => (
              <Reveal key={item.pregunta} delay={Math.min(index * 0.05, 0.25)}>
                <details className="group rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow duration-200 hover:shadow-[0_6px_24px_rgba(212,98,43,0.10)]">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-semibold marker:hidden">
                    {item.pregunta}
                    <ChevronDown
                      size={18}
                      strokeWidth={1.75}
                      className="shrink-0 text-brand-cyan transition-transform duration-200 group-open:rotate-180"
                      aria-hidden
                    />
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-brand-muted">
                    {item.respuesta}
                  </p>
                </details>
              </Reveal>
            ))}
          </div>
        </section>

        {/* Contacto */}
        <section aria-labelledby="contacto-title" className="mt-12">
          <h2 id="contacto-title" className="border-l-4 border-brand-cyan pl-3 text-[22px] font-bold">
            Contacto
          </h2>

          <div className="mt-6 grid gap-6 sm:grid-cols-2">
            <Reveal hoverLift className="h-full">
              <article className="flex h-full flex-col rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow duration-200 hover:shadow-[0_6px_24px_rgba(212,98,43,0.12)]">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-cyan-bg)] text-brand-cyan">
                  <MessageCircle size={20} strokeWidth={1.75} aria-hidden />
                </span>
                <h3 className="mt-4 text-[17px] font-semibold">
                  Sobre un viaje o reserva
                </h3>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-brand-muted">
                  La agencia de cada viaje publica su canal directo (WhatsApp o
                  teléfono) durante la reserva y en el detalle de tu compra.
                  Ellos son quienes resuelven horarios, cambios y pagos de esa
                  ruta.
                </p>
                <Link
                  href="/trips"
                  className="mt-5 inline-flex items-center gap-1.5 self-start text-sm font-semibold text-brand-cyan transition-colors duration-200 hover:text-brand-blue"
                >
                  Explorar viajes
                  <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
                </Link>
              </article>
            </Reveal>

            <Reveal delay={0.08} hoverLift className="h-full">
              <article className="flex h-full flex-col rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow duration-200 hover:shadow-[0_6px_24px_rgba(212,98,43,0.12)]">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-cyan-bg)] text-brand-cyan">
                  <Ticket size={20} strokeWidth={1.75} aria-hidden />
                </span>
                <h3 className="mt-4 text-[17px] font-semibold">
                  Sobre tus compras y boletos
                </h3>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-brand-muted">
                  El estado de cada compra, tus comprobantes enviados y tus
                  boletos con QR viven en tu cuenta, siempre actualizados por la
                  agencia.
                </p>
                <Link
                  href="/account/purchases"
                  className="mt-5 inline-flex items-center gap-1.5 self-start text-sm font-semibold text-brand-cyan transition-colors duration-200 hover:text-brand-blue"
                >
                  Ver mis reservas
                  <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
                </Link>
              </article>
            </Reveal>
          </div>
        </section>
      </div>
    </main>
  );
}
