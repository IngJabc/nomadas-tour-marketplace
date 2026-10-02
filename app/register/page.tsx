import Link from "next/link";

export default function RegisterPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-8 pt-24 pb-16">
      <div className="w-full max-w-md rounded-2xl border border-black/[0.06] bg-brand-surface p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="border-l-4 border-brand-cyan pl-3">
          <h1 className="text-2xl font-bold">Crear cuenta</h1>
          <p className="mt-1 text-sm text-brand-muted">
            Regístrate para reservar y guardar tus viajes.
          </p>
        </div>

        <form className="mt-8 space-y-5">
          <div>
            <label
              htmlFor="full_name"
              className="mb-1.5 block text-xs font-medium uppercase text-brand-muted"
            >
              Nombre completo
            </label>
            <input
              id="full_name"
              type="text"
              autoComplete="name"
              className="w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm outline-none transition-shadow focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)]"
              placeholder="Tu nombre"
            />
          </div>

          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block text-xs font-medium uppercase text-brand-muted"
            >
              Correo electrónico
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm outline-none transition-shadow focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)]"
              placeholder="tu@correo.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1.5 block text-xs font-medium uppercase text-brand-muted"
            >
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              className="w-full rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white px-4 py-3 text-sm outline-none transition-shadow focus:border-brand-cyan focus:shadow-[0_0_0_3px_rgba(0,212,255,0.15)]"
              placeholder="Mínimo 6 caracteres"
            />
          </div>

          <button
            type="button"
            disabled
            className="w-full cursor-not-allowed rounded-[10px] bg-brand-cyan px-5 py-3 text-sm font-semibold text-white opacity-40 transition-colors"
          >
            Crear cuenta
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-brand-muted">
          ¿Ya tienes cuenta?{" "}
          <Link href="/login" className="font-semibold text-brand-blue hover:underline">
            Inicia sesión
          </Link>
        </p>
      </div>
    </main>
  );
}
