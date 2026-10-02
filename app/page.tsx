import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="bg-brand-dark text-white">
        <div className="mx-auto max-w-7xl px-8 py-24 sm:py-32">
          <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-brand-cyan">
            Nómadas Marketplace
          </p>
          <h1 className="max-w-3xl text-4xl font-extrabold leading-tight sm:text-5xl">
            Encuentra tu viaje. Reserva tu asiento. Viaja seguro.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-white/75">
            Explora rutas y horarios de agencias verificadas en Venezuela.
            Reserva en minutos con confirmación inmediata y boleto digital.
          </p>
          <div className="mt-10 flex flex-wrap gap-4">
            <Link
              href="/viajes"
              className="rounded-[10px] bg-brand-cyan px-6 py-3.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
            >
              Buscar viajes
            </Link>
            <Link
              href="/login"
              className="rounded-[10px] bg-white/10 px-6 py-3.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-white/20"
            >
              Iniciar sesión
            </Link>
          </div>
        </div>
      </section>

      {/* Quick steps */}
      <section className="mx-auto max-w-7xl px-8 py-16">
        <div className="grid gap-8 sm:grid-cols-3">
          {[
            {
              step: "01",
              title: "Busca",
              text: "Filtra por origen, destino y fecha entre las agencias conectadas.",
            },
            {
              step: "02",
              title: "Reserva",
              text: "Elige tus asientos en el mapa del vehículo y confirma tus datos.",
            },
            {
              step: "03",
              title: "Viaja",
              text: "Recibe tu boleto con QR y preséntate en el punto de salida.",
            },
          ].map((item) => (
            <div key={item.step} className="rounded-2xl border border-black/[0.06] bg-brand-surface p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <span className="text-sm font-bold text-brand-cyan">{item.step}</span>
              <h2 className="mt-2 text-xl font-bold">{item.title}</h2>
              <p className="mt-2 text-sm text-brand-muted">{item.text}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
