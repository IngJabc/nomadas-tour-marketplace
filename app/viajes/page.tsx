import Link from "next/link";

export default function ViajesPage() {
  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-8 pt-24 pb-16">
      <div className="border-l-4 border-brand-cyan pl-3">
        <h1 className="text-[28px] font-extrabold">Viajes disponibles</h1>
        <p className="mt-1 text-sm text-brand-muted">
          Busca por origen, destino y fecha. El catálogo se conecta a la API pública.
        </p>
      </div>

      {/* Empty state con CTA — nunca pantalla vacía sin acción */}
      <div className="mt-8 flex flex-col items-center rounded-2xl border border-black/[0.06] bg-brand-surface px-6 py-16 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-cyan-bg)] text-brand-cyan">
          <span className="text-2xl font-extrabold">?</span>
        </div>
        <h2 className="mt-4 text-lg font-semibold">Aún no hay viajes publicados</h2>
        <p className="mt-2 max-w-md text-sm text-brand-muted">
          Estamos conectando el catálogo de agencias. Vuelve pronto o inicia sesión
          para recibir avisos de nuevas rutas.
        </p>
        <Link
          href="/"
          className="mt-6 rounded-[10px] bg-brand-cyan px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-brand-blue"
        >
          Volver al inicio
        </Link>
      </div>
    </main>
  );
}
