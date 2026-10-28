import { Clock, Eye, Smartphone } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

const POINTS = [
  {
    icono: Clock,
    titulo: "Reserva en minutos",
    texto: "Sin filas ni llamadas: todo el proceso ocurre en una sola pantalla.",
  },
  {
    icono: Eye,
    titulo: "Todo visible antes de pagar",
    texto: "Horarios, agencia y precio por asiento se muestran antes de reservar.",
  },
  {
    icono: Smartphone,
    titulo: "Tu boleto en el móvil",
    texto: "El código QR queda listo en cuanto la agencia confirma tu comprobante.",
  },
] as const;

/** Sección editorial "Viajar nos conecta" del landing. */
export function SeccionHistoria() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        {/* Panel visual: motivo de ruta sobre tinta */}
        <Reveal>
          <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-brand-dark">
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(600px 300px at 70% 20%, rgba(212,98,43,0.35), transparent 60%)," +
                "linear-gradient(160deg, #14181F 0%, #1F232F 70%, #2A2F3A 100%)",
            }}
          />
          <svg
            aria-hidden
            className="absolute inset-0 h-full w-full opacity-30"
            viewBox="0 0 400 300"
            fill="none"
            preserveAspectRatio="xMidYMid slice"
          >
            <path
              d="M40 260 C 120 220, 140 140, 220 130 S 340 90, 380 40"
              stroke="#D4622B"
              strokeWidth="2.5"
              strokeDasharray="6 10"
            />
            <circle cx="40" cy="260" r="7" fill="#D4622B" />
            <circle cx="220" cy="130" r="7" fill="#D4622B" />
            <circle cx="380" cy="40" r="7" fill="#D4622B" />
          </svg>
          <p className="absolute bottom-6 left-6 right-6 text-lg font-bold text-white/90">
            De terminal a terminal, con la ruta siempre a la vista.
          </p>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div>
            <h2 className="border-l-4 border-brand-cyan pl-3 text-[24px] font-bold sm:text-[28px]">
              Viajar nos conecta
            </h2>
            <p className="mt-4 pl-[19px] text-sm leading-relaxed text-brand-muted sm:text-base">
              Nómadas reúne a las agencias de transporte en un solo lugar para
              que compares rutas y horarios con la información clara antes de
              decidir.
            </p>
            <ul className="mt-8 space-y-6">
              {POINTS.map(({ icono: Icono, titulo, texto }) => (
                <li key={titulo} className="flex gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-cyan-bg)] text-brand-cyan">
                    <Icono size={20} strokeWidth={1.75} aria-hidden />
                  </span>
                  <div>
                    <h3 className="text-[15px] font-semibold">{titulo}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-brand-muted">
                      {texto}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
